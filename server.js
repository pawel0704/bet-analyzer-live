import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE = "https://sports.bzzoiro.com/api/v2";

const VERSION = "5.1.1";
const SOURCE = "BSD";

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;
const MAX_PAGES = 30;

const QUICK_CONCURRENCY = 4;
const DEEP_CONCURRENCY = 2;

const MAX_TOP_PICKS = 10;
const MAX_PICKS_PER_EVENT = 2;

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function todayWarsaw() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/*
  BSD can return:
  0.3588  -> 35.88%
  35.88   -> 35.88%
*/
function normalizeProbability(value) {
  const n = finiteNumber(value);

  if (n === null) return null;

  if (n >= 0 && n <= 1) {
    return round(n * 100, 2);
  }

  if (n >= 0 && n <= 100) {
    return round(n, 2);
  }

  return null;
}

function probabilityToFairOdds(probability) {
  const p = normalizeProbability(probability);

  if (p === null || p <= 0) {
    return null;
  }

  return round(100 / p, 3);
}

function calculateValue(probability, odds) {
  const p = normalizeProbability(probability);
  const o = finiteNumber(odds);

  if (p === null || o === null || o <= 1) {
    return null;
  }

  return round((p / 100) * o - 1, 4);
}

function valuePercent(probability, odds) {
  const value = calculateValue(probability, odds);

  if (value === null) {
    return null;
  }

  return round(value * 100, 2);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function safeEncode(value) {
  return encodeURIComponent(String(value));
}

function eventName(event) {
  return (
    event?.name ||
    event?.event_name ||
    event?.match_name ||
    `${event?.home_team?.name || event?.home || "Home"} – ${
      event?.away_team?.name || event?.away || "Away"
    }`
  );
}

function getEventId(event) {
  return (
    event?.id ??
    event?.event_id ??
    event?.fixture_id ??
    event?.match_id ??
    null
  );
}

function getEventStatus(event) {
  return String(
    event?.status ||
      event?.event_status ||
      event?.fixture_status ||
      ""
  ).toLowerCase();
}

function isFinished(event) {
  const status = getEventStatus(event);

  return [
    "finished",
    "complete",
    "completed",
    "ended",
    "ft",
    "after",
  ].includes(status);
}

function isLive(event) {
  const status = getEventStatus(event);

  return [
    "live",
    "inplay",
    "in_play",
    "playing",
    "1h",
    "2h",
    "ht",
    "extra_time",
  ].includes(status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   BSD REQUEST LAYER
========================================================= */

function buildBsdUrl(pathOrUrl) {
  const url = new URL(pathOrUrl, BSD_BASE);

  const base = new URL(BSD_BASE);

  if (url.hostname !== base.hostname) {
    throw new Error("Blocked BSD request to external host.");
  }

  if (!url.pathname.startsWith("/api/v2")) {
    throw new Error("Blocked BSD request outside /api/v2.");
  }

  return url.toString();
}

async function fetchJson(url, options = {}, attempt = 0) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (
      !response.ok &&
      attempt < MAX_RETRIES &&
      [429, 500, 502, 503, 504].includes(response.status)
    ) {
      await sleep(500 * (attempt + 1));
      return fetchJson(url, options, attempt + 1);
    }

    if (!response.ok) {
      const message =
        typeof data === "string"
          ? data
          : data?.message ||
            data?.error ||
            `BSD HTTP ${response.status}`;

      throw new Error(message);
    }

    return data;
  } catch (error) {
    if (
      attempt < MAX_RETRIES &&
      (error?.name === "AbortError" ||
        /fetch failed|network|socket/i.test(error?.message || ""))
    ) {
      await sleep(500 * (attempt + 1));
      return fetchJson(url, options, attempt + 1);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function bsdRequest(pathOrUrl) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured.");
  }

  const url = buildBsdUrl(pathOrUrl);

  return fetchJson(url, {
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
    },
  });
}

/* =========================================================
   GENERIC DATA EXTRACTION
========================================================= */

function extractItems(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (Array.isArray(payload.matches)) {
    return payload.matches;
  }

  return [];
}

function getNextUrl(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return (
    payload.next ||
    payload.next_url ||
    payload.next_page ||
    payload.links?.next ||
    payload.pagination?.next ||
    null
  );
}

async function getAllEventsForDate(date) {
  const all = [];
  const seen = new Set();

  let url =
    `${BSD_BASE}/events?date=${safeEncode(date)}&limit=100`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const payload = await bsdRequest(url);

    const items = extractItems(payload);

    for (const event of items) {
      const id = getEventId(event);

      if (id === null) {
        continue;
      }

      const key = String(id);

      if (!seen.has(key)) {
        seen.add(key);
        all.push(event);
      }
    }

    const next = getNextUrl(payload);

    if (!next) {
      break;
    }

    url = buildBsdUrl(next);
  }

  return all;
}

/* =========================================================
   PREDICTION NORMALIZATION
========================================================= */

function normalizePrediction(payload) {
  const root = payload?.data || payload || {};

  const markets =
    root.markets ||
    root.predictions ||
    root.market_predictions ||
    root;

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    markets.result ||
    {};

  const expectedGoals =
    markets.expected_goals ||
    markets.expectedGoals ||
    markets.xg ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    markets.goals ||
    {};

  const btts =
    markets.btts ||
    markets.BTTS ||
    {};

  const score =
    markets.score ||
    markets.correct_score ||
    {};

  const dnb =
    markets.draw_no_bet ||
    markets.dnb ||
    {};

  const model =
    root.model ||
    root.meta ||
    {};

  return {
    markets: {
      match_result: {
        home: normalizeProbability(
          matchResult.prob_home ??
            matchResult.home ??
            matchResult.home_win
        ),

        draw: normalizeProbability(
          matchResult.prob_draw ??
            matchResult.draw
        ),

        away: normalizeProbability(
          matchResult.prob_away ??
            matchResult.away ??
            matchResult.away_win
        ),

        predicted:
          matchResult.predicted ||
          matchResult.selection ||
          null,
      },

      expected_goals: {
        home:
          finiteNumber(
            expectedGoals.home ??
              expectedGoals.home_xg ??
              expectedGoals.xg_home
          ),

        away:
          finiteNumber(
            expectedGoals.away ??
              expectedGoals.away_xg ??
              expectedGoals.xg_away
          ),
      },

      over_under: {
        prob_over_15: normalizeProbability(
          overUnder.prob_over_15 ??
            overUnder.over_15 ??
            overUnder.over15
        ),

        prob_under_15: normalizeProbability(
          overUnder.prob_under_15 ??
            overUnder.under_15 ??
            overUnder.under15
        ),

        prob_over_25: normalizeProbability(
          overUnder.prob_over_25 ??
            overUnder.over_25 ??
            overUnder.over25
        ),

        prob_under_25: normalizeProbability(
          overUnder.prob_under_25 ??
            overUnder.under_25 ??
            overUnder.under25
        ),

        prob_over_35: normalizeProbability(
          overUnder.prob_over_35 ??
            overUnder.over_35 ??
            overUnder.over35
        ),

        prob_under_35: normalizeProbability(
          overUnder.prob_under_35 ??
            overUnder.under_35 ??
            overUnder.under35
        ),
      },

      btts: {
        prob_yes: normalizeProbability(
          btts.prob_yes ??
            btts.yes ??
            btts.btts_yes
        ),

        prob_no: normalizeProbability(
          btts.prob_no ??
            btts.no ??
            btts.btts_no
        ),
      },

      score: {
        most_likely:
          score.most_likely ||
          score.mostLikely ||
          score.predicted ||
          null,
      },

      draw_no_bet: {
        home: normalizeProbability(
          dnb.prob_home ??
            dnb.home
        ),

        away: normalizeProbability(
          dnb.prob_away ??
            dnb.away
        ),
      },
    },

    model: {
      confidence: normalizeProbability(
        model.confidence
      ),

      version:
        model.version ||
        model.model_version ||
        null,
    },
  };
}

/* =========================================================
   ODDS NORMALIZATION
========================================================= */

function normalizeOdds(payload) {
  const root = payload?.data || payload || {};

  const odds =
    root.odds ||
    root.markets ||
    root;

  return {
    home_win: finiteNumber(
      odds.home_win ??
        odds.home ??
        odds["1"]
    ),

    draw: finiteNumber(
      odds.draw ??
        odds.x ??
        odds["X"]
    ),

    away_win: finiteNumber(
      odds.away_win ??
        odds.away ??
        odds["2"]
    ),

    over_15_goals: finiteNumber(
      odds.over_15_goals ??
        odds.over15 ??
        odds.over_15
    ),

    under_15_goals: finiteNumber(
      odds.under_15_goals ??
        odds.under15 ??
        odds.under_15
    ),

    over_25_goals: finiteNumber(
      odds.over_25_goals ??
        odds.over25 ??
        odds.over_25
    ),

    under_25_goals: finiteNumber(
      odds.under_25_goals ??
        odds.under25 ??
        odds.under_25
    ),

    over_35_goals: finiteNumber(
      odds.over_35_goals ??
        odds.over35 ??
        odds.over_35
    ),

    under_35_goals: finiteNumber(
      odds.under_35_goals ??
        odds.under35 ??
        odds.under_35
    ),

    btts_yes: finiteNumber(
      odds.btts_yes ??
        odds.bttsYes
    ),

    btts_no: finiteNumber(
      odds.btts_no ??
        odds.bttsNo
    ),

    last_update_at:
      odds.last_update_at ||
      odds.updated_at ||
      null,

    next_update_at:
      odds.next_update_at ||
      null,

    update_reason:
      odds.update_reason ||
      null,

    update_interval_seconds:
      finiteNumber(
        odds.update_interval_seconds
      ),

    previous: {
      home_win: finiteNumber(
        odds.previous_home_win ??
          odds.previous?.home_win
      ),

      draw: finiteNumber(
        odds.previous_draw ??
          odds.previous?.draw
      ),

      away_win: finiteNumber(
        odds.previous_away_win ??
          odds.previous?.away_win
      ),

      over_15_goals: finiteNumber(
        odds.previous_over_15_goals ??
          odds.previous?.over_15_goals
      ),

      under_15_goals: finiteNumber(
        odds.previous_under_15_goals ??
          odds.previous?.under_15_goals
      ),

      over_25_goals: finiteNumber(
        odds.previous_over_25_goals ??
          odds.previous?.over_25_goals
      ),

      under_25_goals: finiteNumber(
        odds.previous_under_25_goals ??
          odds.previous?.under_25_goals
      ),

      over_35_goals: finiteNumber(
        odds.previous_over_35_goals ??
          odds.previous?.over_35_goals
      ),

      under_35_goals: finiteNumber(
        odds.previous_under_35_goals ??
          odds.previous?.under_35_goals
      ),

      btts_yes: finiteNumber(
        odds.previous_btts_yes ??
          odds.previous?.btts_yes
      ),

      btts_no: finiteNumber(
        odds.previous_btts_no ??
          odds.previous?.btts_no
      ),
    },
  };
}

/* =========================================================
   MARKET DEFINITIONS
========================================================= */

const MARKETS = [
  {
    key: "home_win",
    label: "1",
    type: "1X2",
    probability: (p) => p.markets.match_result.home,
    odds: (o) => o.home_win,
  },

  {
    key: "draw",
    label: "X",
    type: "1X2",
    probability: (p) => p.markets.match_result.draw,
    odds: (o) => o.draw,
  },

  {
    key: "away_win",
    label: "2",
    type: "1X2",
    probability: (p) => p.markets.match_result.away,
    odds: (o) => o.away_win,
  },

  {
    key: "over_15",
    label: "Over 1.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_over_15,
    odds: (o) => o.over_15_goals,
  },

  {
    key: "under_15",
    label: "Under 1.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_under_15,
    odds: (o) => o.under_15_goals,
  },

  {
    key: "over_25",
    label: "Over 2.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_over_25,
    odds: (o) => o.over_25_goals,
  },

  {
    key: "under_25",
    label: "Under 2.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_under_25,
    odds: (o) => o.under_25_goals,
  },

  {
    key: "over_35",
    label: "Over 3.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_over_35,
    odds: (o) => o.over_35_goals,
  },

  {
    key: "under_35",
    label: "Under 3.5",
    type: "GOALS",
    probability: (p) => p.markets.over_under.prob_under_35,
    odds: (o) => o.under_35_goals,
  },

  {
    key: "btts_yes",
    label: "BTTS Yes",
    type: "BTTS",
    probability: (p) => p.markets.btts.prob_yes,
    odds: (o) => o.btts_yes,
  },

  {
    key: "btts_no",
    label: "BTTS No",
    type: "BTTS",
    probability: (p) => p.markets.btts.prob_no,
    odds: (o) => o.btts_no,
  },
];

/* =========================================================
   VALIDATION
========================================================= */

function validateMarket(market, prediction, odds) {
  const probability = market.probability(prediction);
  const odd = market.odds(odds);

  const reasons = [];

  if (probability === null) {
    reasons.push("NO_PROBABILITY");
  }

  if (odd === null || odd <= 1) {
    reasons.push("NO_ODDS");
  }

  if (probability !== null && probability < 55) {
    reasons.push("PROBABILITY_LT_55");
  }

  const value =
    probability !== null && odd !== null
      ? valuePercent(probability, odd)
      : null;

  if (value !== null && value < 2) {
    reasons.push("VALUE_LT_2");
  }

  if (
    market.type === "1X2" &&
    probability !== null
  ) {
    const probs = [
      prediction.markets.match_result.home,
      prediction.markets.match_result.draw,
      prediction.markets.match_result.away,
    ].filter((v) => v !== null);

    if (probs.length === 3) {
      const sorted = [...probs].sort((a, b) => b - a);

      if (
        probability === sorted[0] &&
        sorted[0] - sorted[1] < 5
      ) {
        reasons.push("WEAK_1X2_SEPARATION");
      }
    }
  }

  return {
    probability,
    odds: odd,
    value,
    valid: reasons.length === 0,
    reasons,
  };
}

/* =========================================================
   H2H
========================================================= */

function extractH2HSummary(payload) {
  if (!payload) {
    return {
      available: false,
      sampleSize: 0,
      homeWins: null,
      draws: null,
      awayWins: null,
      avgTotalGoals: null,
    };
  }

  const root = payload?.data || payload;

  const matches =
    Array.isArray(root)
      ? root
      : Array.isArray(root?.matches)
      ? root.matches
      : Array.isArray(root?.results)
      ? root.results
      : Array.isArray(root?.data)
      ? root.data
      : null;

  if (matches && matches.length > 0) {
    let totalGoals = 0;
    let goalSamples = 0;

    let homeWins = 0;
    let draws = 0;
    let awayWins = 0;

    for (const match of matches) {
      const homeScore = finiteNumber(
        match?.home_score ??
          match?.score?.home ??
          match?.home?.score
      );

      const awayScore = finiteNumber(
        match?.away_score ??
          match?.score?.away ??
          match?.away?.score
      );

      if (
        homeScore !== null &&
        awayScore !== null
      ) {
        totalGoals += homeScore + awayScore;
        goalSamples++;

        if (homeScore > awayScore) {
          homeWins++;
        } else if (homeScore < awayScore) {
          awayWins++;
        } else {
          draws++;
        }
      }
    }

    return {
      available: true,
      sampleSize: matches.length,
      homeWins,
      draws,
      awayWins,
      avgTotalGoals:
        goalSamples > 0
          ? round(totalGoals / goalSamples, 3)
          : null,
    };
  }

  const sampleSize = finiteNumber(
    root?.sample_size ??
      root?.matches_count ??
      root?.count
  );

  const homeWins = finiteNumber(
    root?.home_wins
  );

  const draws = finiteNumber(
    root?.draws
  );

  const awayWins = finiteNumber(
    root?.away_wins
  );

  const avgTotalGoals = finiteNumber(
    root?.avg_total_goals ??
      root?.average_total_goals
  );

  const known =
    sampleSize !== null ||
    homeWins !== null ||
    draws !== null ||
    awayWins !== null ||
    avgTotalGoals !== null;

  return {
    available: known,
    sampleSize: sampleSize || 0,
    homeWins,
    draws,
    awayWins,
    avgTotalGoals,
  };
}

/* =========================================================
   MARKET-SPECIFIC CONTEXT SUPPORT
========================================================= */

function marketContextSupport(
  market,
  prediction,
  h2h,
  event
) {
  let score = 0;
  const signals = [];

  const xgHome =
    prediction.markets.expected_goals.home;

  const xgAway =
    prediction.markets.expected_goals.away;

  const totalXg =
    xgHome !== null &&
    xgAway !== null
      ? xgHome + xgAway
      : null;

  /*
    xG support is deliberately conservative.
    It must support the selected market.
  */

  if (totalXg !== null) {
    if (market.key === "over_15" && totalXg >= 2.0) {
      score += 1.5;
      signals.push(`xG supports Over 1.5 (${round(totalXg, 2)})`);
    }

    if (market.key === "under_15" && totalXg <= 1.25) {
      score += 2;
      signals.push(`xG supports Under 1.5 (${round(totalXg, 2)})`);
    }

    if (market.key === "over_25" && totalXg >= 2.8) {
      score += 3;
      signals.push(`xG supports Over 2.5 (${round(totalXg, 2)})`);
    }

    if (market.key === "under_25" && totalXg <= 2.2) {
      score += 3;
      signals.push(`xG supports Under 2.5 (${round(totalXg, 2)})`);
    }

    if (market.key === "over_35" && totalXg >= 3.4) {
      score += 2.5;
      signals.push(`xG supports Over 3.5 (${round(totalXg, 2)})`);
    }

    if (market.key === "under_35" && totalXg <= 2.8) {
      score += 2.5;
      signals.push(`xG supports Under 3.5 (${round(totalXg, 2)})`);
    }

    if (
      market.key === "btts_yes" &&
      xgHome >= 0.9 &&
      xgAway >= 0.9
    ) {
      score += 3;
      signals.push(
        `xG supports BTTS Yes (${round(xgHome, 2)} / ${round(
          xgAway,
          2
        )})`
      );
    }

    if (
      market.key === "btts_no" &&
      (xgHome <= 0.55 || xgAway <= 0.55)
    ) {
      score += 3;
      signals.push(
        `xG supports BTTS No (${round(xgHome, 2)} / ${round(
          xgAway,
          2
        )})`
      );
    }

    if (
      market.key === "home_win" &&
      xgHome - xgAway >= 0.5
    ) {
      score += 3;
      signals.push(
        `xG supports home win (${round(xgHome, 2)} vs ${round(
          xgAway,
          2
        )})`
      );
    }

    if (
      market.key === "away_win" &&
      xgAway - xgHome >= 0.5
    ) {
      score += 3;
      signals.push(
        `xG supports away win (${round(xgAway, 2)} vs ${round(
          xgHome,
          2
        )})`
      );
    }
  }

  /*
    H2H is only used if there is a real sample.
    We deliberately keep its weight low because historical
    matches are often not representative of current teams.
  */

  if (
    h2h?.available &&
    h2h.sampleSize >= 3
  ) {
    if (
      market.key === "over_25" &&
      h2h.avgTotalGoals !== null &&
      h2h.avgTotalGoals >= 3
    ) {
      score += 1;
      signals.push(
        `H2H goal average supports Over 2.5 (${h2h.avgTotalGoals})`
      );
    }

    if (
      market.key === "under_25" &&
      h2h.avgTotalGoals !== null &&
      h2h.avgTotalGoals <= 2
    ) {
      score += 1;
      signals.push(
        `H2H goal average supports Under 2.5 (${h2h.avgTotalGoals})`
      );
    }
  }

  /*
    Do not award points merely because lineups/stats/referee
    endpoints exist. Availability is reported separately.
  */

  return {
    score: clamp(score, 0, 5),
    signals,
  };
}

/* =========================================================
   MOVEMENT
========================================================= */

function calculateMovement(current, previous) {
  if (
    current === null ||
    previous === null ||
    current <= 1 ||
    previous <= 1
  ) {
    return {
      available: false,
      status: "UNAVAILABLE_WITHOUT_HISTORY",
      changePercent: null,
      direction: null,
    };
  }

  const changePercent =
    ((current - previous) / previous) * 100;

  let direction = "STABLE";

  if (changePercent <= -0.5) {
    direction = "SHORTENED";
  } else if (changePercent >= 0.5) {
    direction = "DRIFTED";
  }

  return {
    available: true,
    status: "AVAILABLE",
    changePercent: round(changePercent, 2),
    direction,
  };
}

/* =========================================================
   SCORE
========================================================= */

function scoreCandidate({
  probability,
  value,
  market,
  prediction,
  contextScore,
  movement,
}) {
  if (
    probability === null ||
    value === null
  ) {
    return 0;
  }

  /*
    Probability is the main component.
    Value and market separation are secondary.
    Context is deliberately capped.
  */

  const probabilityScore =
    clamp(
      ((probability - 50) / 40) * 50,
      0,
      50
    );

  const valueScore =
    clamp(
      Math.max(value, 0) * 1.5,
      0,
      25
    );

  let marketGapScore = 0;

  if (market.type === "1X2") {
    const probs = [
      prediction.markets.match_result.home,
      prediction.markets.match_result.draw,
      prediction.markets.match_result.away,
    ].filter((v) => v !== null);

    if (probs.length === 3) {
      const selected = probability;
      const other = probs
        .filter((p) => p !== selected)
        .sort((a, b) => b - a)[0];

      if (other !== undefined) {
        marketGapScore = clamp(
          (selected - other) * 0.4,
          0,
          10
        );
      }
    }
  } else if (market.type === "GOALS") {
    marketGapScore = clamp(
      (probability - 50) * 0.25,
      0,
      10
    );
  } else if (market.type === "BTTS") {
    marketGapScore = clamp(
      (probability - 50) * 0.25,
      0,
      10
    );
  }

  let movementScore = 0;

  if (movement?.available) {
    /*
      Real shortening supports the selection.
      Drift does not automatically mean "bad", but does not
      receive a positive score.
    */
    if (movement.direction === "SHORTENED") {
      movementScore = 5;
    }
  }

  return round(
    clamp(
      probabilityScore +
        valueScore +
        marketGapScore +
        contextScore +
        movementScore,
      0,
      100
    ),
    2
  );
}

/* =========================================================
   CONCURRENCY
========================================================= */

async function mapWithConcurrency(
  items,
  limit,
  worker
) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (true) {
      const current = index++;

      if (current >= items.length) {
        return;
      }

      try {
        results[current] = await worker(
          items[current],
          current
        );
      } catch (error) {
        results[current] = {
          error: error?.message || String(error),
        };
      }
    }
  }

  const runners = Array.from(
    {
      length: Math.min(
        Math.max(limit, 1),
        items.length
      ),
    },
    () => runner()
  );

  await Promise.all(runners);

  return results;
}

/* =========================================================
   EVENT RESOURCES
========================================================= */

async function getPrediction(eventId) {
  const payload = await bsdRequest(
    `/events/${safeEncode(eventId)}/prediction`
  );

  return normalizePrediction(payload);
}

async function getOdds(eventId) {
  const payload = await bsdRequest(
    `/events/${safeEncode(eventId)}/odds`
  );

  return normalizeOdds(payload);
}

async function getH2H(eventId) {
  try {
    const payload = await bsdRequest(
      `/events/${safeEncode(eventId)}/h2h`
    );

    return extractH2HSummary(payload);
  } catch {
    return {
      available: false,
      sampleSize: 0,
      homeWins: null,
      draws: null,
      awayWins: null,
      avgTotalGoals: null,
    };
  }
}

async function getStats(eventId) {
  try {
    return await bsdRequest(
      `/events/${safeEncode(eventId)}/stats`
    );
  } catch {
    return null;
  }
}

async function getLineups(eventId) {
  try {
    return await bsdRequest(
      `/events/${safeEncode(eventId)}/lineups`
    );
  } catch {
    return null;
  }
}

async function getIncidents(eventId) {
  try {
    return await bsdRequest(
      `/events/${safeEncode(eventId)}/incidents`
    );
  } catch {
    return null;
  }
}

async function getRefereeData(event) {
  try {
    const refereeId =
      event?.referee?.id ??
      event?.referee_id ??
      null;

    if (!refereeId) {
      return {
        available: false,
        statsAvailable: false,
      };
    }

    return {
      available: true,
      statsAvailable: false,
      refereeId,
    };
  } catch {
    return {
      available: false,
      statsAvailable: false,
    };
  }
}

/* =========================================================
   CANDIDATE CREATION
========================================================= */

function makeCandidate({
  event,
  prediction,
  odds,
  market,
  h2h,
  stats,
  lineups,
  incidents,
  referee,
}) {
  const validation = validateMarket(
    market,
    prediction,
    odds
  );

  if (!validation.valid) {
    return {
      valid: false,
      reasons: validation.reasons,
      market: market.key,
    };
  }

  const previous =
    odds.previous?.[market.key] ?? null;

  const movement =
    calculateMovement(
      validation.odds,
      previous
    );

  const context =
    marketContextSupport(
      market,
      prediction,
      h2h,
      event
    );

  const score = scoreCandidate({
    probability: validation.probability,
    value: validation.value,
    market,
    prediction,
    contextScore: context.score,
    movement,
  });

  const reasons = [];

  if (context.signals.length) {
    reasons.push(...context.signals);
  }

  if (movement.available) {
    reasons.push(
      `bookmaker movement: ${movement.direction} ${movement.changePercent}%`
    );
  } else {
    reasons.push(
      "bookmaker movement unavailable without previous odds"
    );
  }

  if (referee?.statsAvailable) {
    reasons.push("verified referee statistics available");
  }

  if (lineups) {
    reasons.push("lineup data available");
  }

  if (stats) {
    reasons.push("match statistics available");
  }

  if (incidents) {
    reasons.push("incident data available");
  }

  return {
    valid: true,

    eventId: getEventId(event),

    event: eventName(event),

    market: market.key,

    label: market.label,

    probability: round(
      validation.probability,
      2
    ),

    odds: round(
      validation.odds,
      3
    ),

    fairOdds: probabilityToFairOdds(
      validation.probability
    ),

    valuePercent: round(
      validation.value,
      2
    ),

    score,

    modelConfidence:
      prediction.model.confidence,

    modelVersion:
      prediction.model.version,

    contextScore: context.score,

    contextSignals: context.signals,

    movement,

    exchange: {
      status: "EXCHANGE_UNAVAILABLE",
      connected: false,
      score: 0,
      reason:
        "No verified betting-exchange feed is connected.",
    },

    dataSources: {
      prediction: true,
      odds: true,
      xg:
        prediction.markets.expected_goals.home !==
          null &&
        prediction.markets.expected_goals.away !==
          null,

      h2h: Boolean(h2h?.available),

      stats: Boolean(stats),

      lineups: Boolean(lineups),

      incidents: Boolean(incidents),

      referee: Boolean(referee?.available),

      refereeStats: Boolean(
        referee?.statsAvailable
      ),

      bookmakerHistory:
        movement.available,

      exchange: false,
    },

    h2h: h2h || null,

    reasons,
  };
}

/* =========================================================
   QUICK ANALYSIS
========================================================= */

async function quickAnalyze(event) {
  const eventId = getEventId(event);

  if (eventId === null) {
    throw new Error("Event has no ID.");
  }

  const [prediction, odds] =
    await Promise.all([
      getPrediction(eventId),
      getOdds(eventId),
    ]);

  const candidates = MARKETS.map(
    (market) =>
      makeCandidate({
        event,
        prediction,
        odds,
        market,
        h2h: null,
        stats: null,
        lineups: null,
        incidents: null,
        referee: null,
      })
  );

  const validCandidates =
    candidates.filter(
      (candidate) => candidate.valid
    );

  return {
    event,
    eventId,
    eventName: eventName(event),

    prediction,
    odds,

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected.",
    },

    candidates: validCandidates,

    rejected: candidates
      .filter((candidate) => !candidate.valid)
      .map((candidate) => ({
        market: candidate.market,
        reasons: candidate.reasons,
      })),
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  event,
  quick
) {
  const eventId = quick.eventId;

  const [
    h2h,
    stats,
    lineups,
    incidents,
    referee,
  ] = await Promise.all([
    getH2H(eventId),
    getStats(eventId),
    getLineups(eventId),
    getIncidents(eventId),
    getRefereeData(event),
  ]);

  const candidates = MARKETS.map(
    (market) =>
      makeCandidate({
        event,
        prediction: quick.prediction,
        odds: quick.odds,
        market,
        h2h,
        stats,
        lineups,
        incidents,
        referee,
      })
  );

  const validCandidates =
    candidates.filter(
      (candidate) =>
        candidate.valid &&
        candidate.score >= 50
    );

  const rejectedByScore =
    candidates
      .filter(
        (candidate) =>
          candidate.valid &&
          candidate.score < 50
      )
      .map((candidate) => ({
        market: candidate.market,
        label: candidate.label,
        probability: candidate.probability,
        valuePercent: candidate.valuePercent,
        score: candidate.score,
        reason: "SCORE_LT_50",
      }));

  return {
    event,
    eventId,
    eventName: eventName(event),

    prediction: quick.prediction,

    odds: quick.odds,

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected.",
    },

    context: {
      h2h,

      statsAvailable: Boolean(stats),

      lineupsAvailable: Boolean(lineups),

      incidentsAvailable: Boolean(
        incidents
      ),

      referee,

      xgAvailable:
        quick.prediction.markets.expected_goals
          .home !== null &&
        quick.prediction.markets.expected_goals
          .away !== null,
    },

    candidates: validCandidates,

    rejected: [
      ...quick.rejected,
      ...rejectedByScore,
    ],
  };
}

/* =========================================================
   FILTER EVENTS
========================================================= */

function filterEvents(events) {
  return events.filter((event) => {
    if (isFinished(event)) {
      return false;
    }

    if (isLive(event)) {
      return false;
    }

    return true;
  });
}

/* =========================================================
   REJECTION DIAGNOSTICS
========================================================= */

function createRejectionCounts() {
  return {
    NO_PROBABILITY: 0,
    NO_ODDS: 0,
    PROBABILITY_LT_55: 0,
    VALUE_LT_2: 0,
    WEAK_1X2_SEPARATION: 0,
    SCORE_LT_50: 0,
    ANALYSIS_ERROR: 0,
  };
}

function addRejectionCounts(
  counts,
  reasons
) {
  for (const reason of reasons || []) {
    if (
      Object.prototype.hasOwnProperty.call(
        counts,
        reason
      )
    ) {
      counts[reason]++;
    }
  }
}

/* =========================================================
   TOP PICKS
========================================================= */

app.get("/api/top-picks", async (req, res) => {
  const date =
    isValidDate(req.query.date)
      ? req.query.date
      : todayWarsaw();

  try {
    const events =
      filterEvents(
        await getAllEventsForDate(date)
      );

    const quickResults =
      await mapWithConcurrency(
        events,
        QUICK_CONCURRENCY,
        async (event) => {
          try {
            return await quickAnalyze(event);
          } catch (error) {
            return {
              error:
                error?.message ||
                String(error),
              event,
              eventId: getEventId(event),
              eventName: eventName(event),
            };
          }
        }
      );

    const rejectionCounts =
      createRejectionCounts();

    const quickCandidates = [];

    for (const result of quickResults) {
      if (result?.error) {
        rejectionCounts.ANALYSIS_ERROR++;
        continue;
      }

      for (const rejected of
        result.rejected || []) {
        addRejectionCounts(
          rejectionCounts,
          rejected.reasons
        );
      }

      for (const candidate of
        result.candidates || []) {
        /*
          Early filter:
          don't spend deep-analysis requests on weak candidates.
        */

        if (
          candidate.probability >= 55 &&
          candidate.valuePercent >= 2
        ) {
          quickCandidates.push({
            ...candidate,
            quickResult: result,
          });
        }
      }
    }

    /*
      One event can have multiple candidate markets.
      Deep analysis is performed once per event.
    */

    const eventMap = new Map();

    for (const candidate of quickCandidates) {
      if (!eventMap.has(candidate.eventId)) {
        eventMap.set(
          candidate.eventId,
          candidate.quickResult
        );
      }
    }

    const deepResults =
      await mapWithConcurrency(
        [...eventMap.values()],
        DEEP_CONCURRENCY,
        async (quick) => {
          try {
            return await deepAnalyze(
              quick.event,
              quick
            );
          } catch (error) {
            return {
              error:
                error?.message ||
                String(error),
              eventId: quick.eventId,
              eventName:
                quick.eventName,
            };
          }
        }
      );

    const finalCandidates = [];

    for (const result of deepResults) {
      if (result?.error) {
        rejectionCounts.ANALYSIS_ERROR++;
        continue;
      }

      for (const rejected of
        result.rejected || []) {
        if (
          rejected.reason ===
          "SCORE_LT_50"
        ) {
          rejectionCounts.SCORE_LT_50++;
        }
      }

      for (const candidate of
        result.candidates || []) {
        finalCandidates.push(candidate);
      }
    }

    finalCandidates.sort(
      (a, b) => b.score - a.score
    );

    /*
      Maximum two selections from one match.
    */

    const eventPickCount = new Map();
    const topPicks = [];

    for (const candidate of finalCandidates) {
      const count =
        eventPickCount.get(
          candidate.eventId
        ) || 0;

      if (
        count >= MAX_PICKS_PER_EVENT
      ) {
        continue;
      }

      topPicks.push(candidate);

      eventPickCount.set(
        candidate.eventId,
        count + 1
      );

      if (
        topPicks.length >=
        MAX_TOP_PICKS
      ) {
        break;
      }
    }

    res.json({
      ok: true,

      version: VERSION,

      source: SOURCE,

      date,

      exchange: {
        connected: false,
        status: "EXCHANGE_UNAVAILABLE",
        reason:
          "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
      },

      filters: {
        minimumProbability: 55,
        minimumValuePercent: 2,
        minimumScore: 50,
        maxPicks: MAX_TOP_PICKS,
        maxPicksPerEvent:
          MAX_PICKS_PER_EVENT,
      },

      eventsScanned: events.length,

      quickCandidates:
        quickCandidates.length,

      qualifiedPicks:
        topPicks.length,

      picks: topPicks,

      diagnostics: {
        rejectionCounts,

        note:
          topPicks.length < MAX_TOP_PICKS
            ? "Fewer than 10 picks passed all quality filters. No artificial picks were added."
            : "10 picks passed all quality filters.",
      },
    });
  } catch (error) {
    console.error(
      "TOP PICKS ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "TOP_PICKS_ERROR",
      details:
        error?.message ||
        String(error),
    });
  }
});

/* =========================================================
   SINGLE EVENT ANALYSIS
========================================================= */

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    const eventId = req.params.id;

    try {
      const eventPayload =
        await bsdRequest(
          `/events/${safeEncode(eventId)}`
        );

      const event =
        eventPayload?.data ||
        eventPayload?.event ||
        eventPayload;

      const quick =
        await quickAnalyze(event);

      const result =
        await deepAnalyze(
          event,
          quick
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        ...result,
      });
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        version: VERSION,
        source: SOURCE,
        error: "ANALYZE_ERROR",
        details:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =========================================================
   EVENTS
========================================================= */

app.get("/api/events", async (req, res) => {
  const date =
    isValidDate(req.query.date)
      ? req.query.date
      : todayWarsaw();

  try {
    const events =
      await getAllEventsForDate(date);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      total_available:
        events.length,
      events,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "EVENTS_ERROR",
      details:
        error?.message ||
        String(error),
    });
  }
});

app.get(
  "/api/events/live",
  async (req, res) => {
    const date =
      isValidDate(req.query.date)
        ? req.query.date
        : todayWarsaw();

    try {
      const events =
        await getAllEventsForDate(date);

      const live =
        events.filter(isLive);

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        date,
        total: live.length,
        events: live,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        source: SOURCE,
        error: "LIVE_EVENTS_ERROR",
        details:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =========================================================
   EVENT DETAIL / RESOURCES
========================================================= */

app.get(
  "/api/events/:id",
  async (req, res) => {
    try {
      const data =
        await bsdRequest(
          `/events/${safeEncode(
            req.params.id
          )}`
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        data,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        source: SOURCE,
        error: "EVENT_ERROR",
        details:
          error?.message ||
          String(error),
      });
    }
  }
);

const resourceEndpoints = [
  ["prediction", "prediction"],
  ["odds", "odds"],
  ["h2h", "h2h"],
  ["stats", "stats"],
  ["lineups", "lineups"],
  ["incidents", "incidents"],
  ["polymarket", "polymarket"],
];

for (const [route, endpoint] of resourceEndpoints) {
  app.get(
    `/api/events/:id/${route}`,
    async (req, res) => {
      try {
        const data =
          await bsdRequest(
            `/events/${safeEncode(
              req.params.id
            )}/${endpoint}`
          );

        res.json({
          ok: true,
          version: VERSION,
          source: SOURCE,
          data,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          version: VERSION,
          source: SOURCE,
          error:
            `EVENT_${route.toUpperCase()}_ERROR`,
          details:
            error?.message ||
            String(error),
        });
      }
    }
  );
}

/* =========================================================
   SEARCH
========================================================= */

app.get("/api/search", async (req, res) => {
  const query =
    String(
      req.query.q ||
        req.query.query ||
        ""
    ).trim();

  if (!query) {
    return res.status(400).json({
      ok: false,
      error: "QUERY_REQUIRED",
    });
  }

  try {
    const events =
      await getAllEventsForDate(
        isValidDate(req.query.date)
          ? req.query.date
          : todayWarsaw()
      );

    const q = query.toLowerCase();

    const results =
      events.filter((event) =>
        eventName(event)
          .toLowerCase()
          .includes(q)
      );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      query,
      total: results.length,
      events: results,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "SEARCH_ERROR",
      details:
        error?.message ||
        String(error),
    });
  }
});

/* =========================================================
   COVERAGE
========================================================= */

app.get("/api/coverage", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,

    prediction: true,
    odds: true,

    context: {
      xg: true,
      h2h: true,
      stats: true,
      lineups: true,
      incidents: true,
      referee: true,
    },

    bookmakerMovement: {
      supported: true,
      requiresPreviousOdds: true,
    },

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected.",
    },

    markets: MARKETS.map(
      (market) => market.key
    ),
  });
});

/* =========================================================
   ROOT / HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    status: "online",
  });
});

/* =========================================================
   404 / ERROR
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "NOT_FOUND",
    path: req.originalUrl,
  });
});

app.use((error, req, res, next) => {
  console.error(
    "UNHANDLED ERROR:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    version: VERSION,
    source: SOURCE,
    error: "INTERNAL_SERVER_ERROR",
    details:
      error?.message ||
      String(error),
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
  );

  console.log(
    `BSD source: ${SOURCE}`
  );

  console.log(
    `Exchange: NOT_CONNECTED`
  );
});
