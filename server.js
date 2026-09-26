import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;

const BSD_BASE = "https://sports.bzzoiro.com/api/v2";
const BSD_PUBLIC = "https://sports.bzzoiro.com/api";

const VERSION = "7.0.3";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

const MIN_PROBABILITY = 0.60;
const MIN_CONFIDENCE = 0.55;

const MIN_ODDS = 1.05;
const MAX_ODDS = 12.00;

const REQUEST_TIMEOUT_MS = 10000;

const exchange = {
  connected: false,
  status: "NOT_CONNECTED",
  message:
    "Betting exchange data is not connected. No exchange movement is fabricated."
};

// ======================================================
// HELPERS
// ======================================================

function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function normalizeProbability(value) {
  const n = safeNumber(value);

  if (n === null) return null;

  if (n > 1) {
    return Math.min(
      Math.max(n / 100, 0),
      1
    );
  }

  return Math.min(
    Math.max(n, 0),
    1
  );
}

function validOdds(value) {
  const n = safeNumber(value);

  return (
    n !== null &&
    n >= MIN_ODDS &&
    n <= MAX_ODDS
  );
}

function fairOdds(probability) {
  if (
    probability === null ||
    probability <= 0
  ) {
    return null;
  }

  return Number(
    (1 / probability).toFixed(3)
  );
}

function todayUTC() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}

// ======================================================
// HTTP
// ======================================================

function buildHeaders() {
  const headers = {
    Accept: "application/json"
  };

  if (BSD_API_KEY) {
    headers.Authorization =
      `Token ${BSD_API_KEY}`;
  }

  return headers;
}

async function fetchJson(url) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",
        headers: buildHeaders(),
        signal:
          controller.signal
      });

    const text =
      await response.text();

    let data = null;

    try {
      data = text
        ? JSON.parse(text)
        : null;
    } catch {
      data = {
        raw: text
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// GENERIC DATA
// ======================================================

function getResults(data) {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.predictions)) {
    return data.predictions;
  }

  if (Array.isArray(data.events)) {
    return data.events;
  }

  return [];
}

function getCount(data) {
  return safeNumber(data?.count);
}

// ======================================================
// EVENT DATA
// ======================================================

function eventIdOf(item) {
  return firstValue(
    item?.event_id,
    item?.eventId,
    item?.match_id,
    item?.matchId,
    item?.event?.id,
    item?.match?.id,
    item?.id
  );
}

function homeName(item) {
  return firstValue(
    item?.home_team,
    item?.home_team_name,
    item?.homeTeam,
    item?.teams?.home?.name,
    item?.home?.name,
    item?.event?.home_team,
    item?.event?.home_team_name,
    item?.event?.teams?.home?.name,
    item?.match?.home_team,
    "Home"
  );
}

function awayName(item) {
  return firstValue(
    item?.away_team,
    item?.away_team_name,
    item?.awayTeam,
    item?.teams?.away?.name,
    item?.away?.name,
    item?.event?.away_team,
    item?.event?.away_team_name,
    item?.event?.teams?.away?.name,
    item?.match?.away_team,
    "Away"
  );
}

function eventDateOf(item) {
  return firstValue(
    item?.event_date,
    item?.eventDate,
    item?.match_date,
    item?.matchDate,
    item?.start_time,
    item?.startTime,
    item?.kickoff,
    item?.event?.event_date,
    item?.event?.eventDate,
    item?.event?.date,
    item?.event?.start_time,
    item?.event?.startTime,
    item?.match?.event_date,
    item?.match?.eventDate,
    item?.match?.date,
    item?.date
  );
}

function leagueNameOf(item) {
  return firstValue(
    item?.league_name,
    item?.leagueName,
    item?.league?.name,
    item?.competition?.name,
    item?.tournament?.name,
    item?.event?.league?.name,
    item?.match?.league?.name
  );
}

function dateMatches(item, targetDate) {
  const raw = eventDateOf(item);

  if (!raw) return false;

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date
      .toISOString()
      .slice(0, 10) ===
    targetDate
  );
}

function filterPredictionsByDate(
  predictions,
  date
) {
  return predictions.filter(
    item =>
      dateMatches(
        item,
        date
      )
  );
}

// ======================================================
// PROBABILITIES
// ======================================================

function getProbabilitySources(item) {
  return [
    item?.probabilities,
    item?.probability,
    item?.prediction?.probabilities,
    item?.prediction?.probability,
    item?.prediction,
    item?.forecast,
    item
  ].filter(Boolean);
}

function readProbability(
  sources,
  keys
) {
  for (const source of sources) {
    for (const key of keys) {
      const value =
        normalizeProbability(
          source?.[key]
        );

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

function getProbabilities(item) {
  const sources =
    getProbabilitySources(item);

  return {
    home: readProbability(
      sources,
      [
        "home",
        "home_win",
        "homeWin",
        "home_probability",
        "prob_home",
        "probability_home",
        "1"
      ]
    ),

    draw: readProbability(
      sources,
      [
        "draw",
        "draw_probability",
        "prob_draw",
        "probability_draw",
        "x",
        "X"
      ]
    ),

    away: readProbability(
      sources,
      [
        "away",
        "away_win",
        "awayWin",
        "away_probability",
        "prob_away",
        "probability_away",
        "2"
      ]
    ),

    over15: readProbability(
      sources,
      [
        "over_15",
        "over15",
        "over1_5",
        "over_1_5",
        "prob_over_15",
        "probability_over_15"
      ]
    ),

    under15: readProbability(
      sources,
      [
        "under_15",
        "under15",
        "under1_5",
        "under_1_5",
        "prob_under_15",
        "probability_under_15"
      ]
    ),

    over25: readProbability(
      sources,
      [
        "over_25",
        "over25",
        "over2_5",
        "over_2_5",
        "prob_over_25",
        "probability_over_25"
      ]
    ),

    under25: readProbability(
      sources,
      [
        "under_25",
        "under25",
        "under2_5",
        "under_2_5",
        "prob_under_25",
        "probability_under_25"
      ]
    ),

    over35: readProbability(
      sources,
      [
        "over_35",
        "over35",
        "over3_5",
        "over_3_5",
        "prob_over_35",
        "probability_over_35"
      ]
    ),

    under35: readProbability(
      sources,
      [
        "under_35",
        "under35",
        "under3_5",
        "under_3_5",
        "prob_under_35",
        "probability_under_35"
      ]
    ),

    bttsYes: readProbability(
      sources,
      [
        "btts_yes",
        "bttsYes",
        "BTTS_yes",
        "btts_yes_probability",
        "prob_btts_yes"
      ]
    ),

    bttsNo: readProbability(
      sources,
      [
        "btts_no",
        "bttsNo",
        "BTTS_no",
        "btts_no_probability",
        "prob_btts_no"
      ]
    )
  };
}

function getConfidence(item) {
  return normalizeProbability(
    firstValue(
      item?.confidence,
      item?.model_confidence,
      item?.prediction?.confidence,
      item?.prediction?.model_confidence,
      item?.forecast?.confidence
    )
  );
}

// ======================================================
// EXISTING ODDS FROM PREDICTIONS
// ======================================================

function getOdds(item) {
  const odds =
    firstValue(
      item?.odds,
      item?.prediction?.odds,
      item?.forecast?.odds
    ) || {};

  return {
    home: safeNumber(
      firstValue(
        item?.odds_home,
        item?.oddsHome,
        odds?.home,
        odds?.odds_home,
        odds?.match_winner?.home
      )
    ),

    draw: safeNumber(
      firstValue(
        item?.odds_draw,
        item?.oddsDraw,
        odds?.draw,
        odds?.odds_draw,
        odds?.match_winner?.draw
      )
    ),

    away: safeNumber(
      firstValue(
        item?.odds_away,
        item?.oddsAway,
        odds?.away,
        odds?.odds_away,
        odds?.match_winner?.away
      )
    ),

    over15: safeNumber(
      firstValue(
        item?.odds_over_15,
        item?.oddsOver15,
        odds?.over_15,
        odds?.over15,
        odds?.over_under?.over_15
      )
    ),

    under15: safeNumber(
      firstValue(
        item?.odds_under_15,
        item?.oddsUnder15,
        odds?.under_15,
        odds?.under15,
        odds?.over_under?.under_15
      )
    ),

    over25: safeNumber(
      firstValue(
        item?.odds_over_25,
        item?.oddsOver25,
        odds?.over_25,
        odds?.over25,
        odds?.over_under?.over_25
      )
    ),

    under25: safeNumber(
      firstValue(
        item?.odds_under_25,
        item?.oddsUnder25,
        odds?.under_25,
        odds?.under25,
        odds?.over_under?.under_25
      )
    ),

    over35: safeNumber(
      firstValue(
        item?.odds_over_35,
        item?.oddsOver35,
        odds?.over_35,
        odds?.over35,
        odds?.over_under?.over_35
      )
    ),

    under35: safeNumber(
      firstValue(
        item?.odds_under_35,
        item?.oddsUnder35,
        odds?.under_35,
        odds?.under35,
        odds?.over_under?.under_35
      )
    ),

    bttsYes: safeNumber(
      firstValue(
        item?.odds_btts_yes,
        item?.oddsBttsYes,
        odds?.btts_yes,
        odds?.btts?.yes
      )
    ),

    bttsNo: safeNumber(
      firstValue(
        item?.odds_btts_no,
        item?.oddsBttsNo,
        odds?.btts_no,
        odds?.btts?.no
      )
    )
  };
}

// ======================================================
// RECOMMENDATIONS
// ======================================================

function recursiveStrings(
  value,
  output = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (
    typeof value === "string"
  ) {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      recursiveStrings(
        item,
        output
      );
    }

    return output;
  }

  if (
    typeof value === "object"
  ) {
    for (
      const child of
      Object.values(value)
    ) {
      recursiveStrings(
        child,
        output
      );
    }
  }

  return output;
}

function getRecommendationText(item) {
  return recursiveStrings([
    item?.recommendation,
    item?.recommendations,
    item?.prediction?.recommendation,
    item?.prediction?.recommendations,
    item?.tip,
    item?.call,
    item?.pick
  ])
    .join(" | ")
    .trim();
}

function getRecommendationFlags(item) {
  const text =
    getRecommendationText(
      item
    ).toLowerCase();

  return {
    home:
      text.includes("1x") ||
      text.includes("home") ||
      text.includes("win or draw") ||
      text.includes("avoid defeat"),

    away:
      text.includes("x2") ||
      text.includes("away"),

    over15:
      text.includes("over 1.5") ||
      text.includes("over1.5") ||
      text.includes("over_15"),

    over25:
      text.includes("over 2.5") ||
      text.includes("over2.5") ||
      text.includes("over_25"),

    under25:
      text.includes("under 2.5") ||
      text.includes("under2.5") ||
      text.includes("under_25"),

    under35:
      text.includes("under 3.5") ||
      text.includes("under3.5") ||
      text.includes("under_35"),

    btts:
      text.includes("btts") ||
      text.includes(
        "both teams to score"
      )
  };
}

// ======================================================
// MARKET DEFINITIONS
// ======================================================

const MARKETS = [
  {
    key: "1X",
    market: "DOUBLE_CHANCE",
    pick: "1X",
    probability: p =>
      p.home !== null &&
      p.draw !== null
        ? p.home + p.draw
        : null,
    predictionOdds: () => null
  },

  {
    key: "X2",
    market: "DOUBLE_CHANCE",
    pick: "X2",
    probability: p =>
      p.away !== null &&
      p.draw !== null
        ? p.away + p.draw
        : null,
    predictionOdds: () => null
  },

  {
    key: "HOME",
    market: "1X2",
    pick: "1",
    probability: p => p.home,
    predictionOdds: o => o.home
  },

  {
    key: "DRAW",
    market: "1X2",
    pick: "X",
    probability: p => p.draw,
    predictionOdds: o => o.draw
  },

  {
    key: "AWAY",
    market: "1X2",
    pick: "2",
    probability: p => p.away,
    predictionOdds: o => o.away
  },

  {
    key: "OVER15",
    market: "TOTAL",
    pick: "OVER 1.5",
    probability: p => p.over15,
    predictionOdds: o => o.over15
  },

  {
    key: "UNDER15",
    market: "TOTAL",
    pick: "UNDER 1.5",
    probability: p => p.under15,
    predictionOdds: o => o.under15
  },

  {
    key: "OVER25",
    market: "TOTAL",
    pick: "OVER 2.5",
    probability: p => p.over25,
    predictionOdds: o => o.over25
  },

  {
    key: "UNDER25",
    market: "TOTAL",
    pick: "UNDER 2.5",
    probability: p => p.under25,
    predictionOdds: o => o.under25
  },

  {
    key: "OVER35",
    market: "TOTAL",
    pick: "OVER 3.5",
    probability: p => p.over35,
    predictionOdds: o => o.over35
  },

  {
    key: "UNDER35",
    market: "TOTAL",
    pick: "UNDER 3.5",
    probability: p => p.under35,
    predictionOdds: o => o.under35
  },

  {
    key: "BTTS_YES",
    market: "BTTS",
    pick: "BTTS YES",
    probability: p => p.bttsYes,
    predictionOdds: o => o.bttsYes
  },

  {
    key: "BTTS_NO",
    market: "BTTS",
    pick: "BTTS NO",
    probability: p => p.bttsNo,
    predictionOdds: o => o.bttsNo
  }
];

// ======================================================
// CANDIDATES
// ======================================================

function makeCandidate(
  item,
  definition
) {
  const probabilities =
    getProbabilities(item);

  const odds =
    getOdds(item);

  const probability =
    definition.probability(
      probabilities
    );

  if (
    probability === null ||
    probability <
      MIN_PROBABILITY
  ) {
    return null;
  }

  const predictionOdds =
    definition.predictionOdds(
      odds
    );

  const actualOdds =
    validOdds(predictionOdds)
      ? predictionOdds
      : null;

  const confidence =
    getConfidence(item);

  const flags =
    getRecommendationFlags(
      item
    );

  let recommendationStrength = 0;

  if (
    (
      definition.key === "HOME" ||
      definition.key === "1X"
    ) &&
    flags.home
  ) {
    recommendationStrength = 1;
  }

  if (
    (
      definition.key === "AWAY" ||
      definition.key === "X2"
    ) &&
    flags.away
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key === "OVER15" &&
    flags.over15
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key === "OVER25" &&
    flags.over25
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key === "UNDER25" &&
    flags.under25
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key === "UNDER35" &&
    flags.under35
  ) {
    recommendationStrength = 1;
  }

  if (
    (
      definition.key ===
        "BTTS_YES" ||
      definition.key ===
        "BTTS_NO"
    ) &&
    flags.btts
  ) {
    recommendationStrength = 1;
  }

  const value =
    actualOdds !== null
      ? Number(
          (
            probability *
              actualOdds -
            1
          ).toFixed(4)
        )
      : null;

  return {
    eventId:
      eventIdOf(item),

    event:
      `${homeName(item)} – ${awayName(item)}`,

    home:
      homeName(item),

    away:
      awayName(item),

    date:
      eventDateOf(item),

    league:
      leagueNameOf(item),

    market:
      definition.market,

    pick:
      definition.pick,

    marketKey:
      definition.key,

    probability:
      Number(
        (
          probability * 100
        ).toFixed(1)
      ),

    confidence:
      confidence !== null
        ? Number(
            (
              confidence * 100
            ).toFixed(1)
          )
        : null,

    odds:
      actualOdds,

    fairOdds:
      fairOdds(
        probability
      ),

    value,

    recommendationStrength,

    bsdRecommendation:
      getRecommendationText(
        item
      ) || null,

    score: 0,

    oddsSource:
      actualOdds !== null
        ? "BSD_PREDICTION"
        : "UNAVAILABLE",

    bookmaker:
      null,

    marketMovement:
      null,

    exchangeMovement:
      null,

    status:
      "notstarted"
  };
}

function generateCandidates(item) {
  const candidates = [];

  for (
    const definition of
    MARKETS
  ) {
    const candidate =
      makeCandidate(
        item,
        definition
      );

    if (candidate) {
      candidates.push(
        candidate
      );
    }
  }

  return candidates;
}

// ======================================================
// PREDICTIONS
// ======================================================

async function fetchAllPredictions() {
  const all = [];

  const limit = 200;

  let offset = 0;
  let total = null;

  while (true) {
    const url =
      `${BSD_PUBLIC}/predictions/` +
      `?limit=${limit}` +
      `&offset=${offset}`;

    const response =
      await fetchJson(url);

    if (!response.ok) {
      throw new Error(
        `BSD predictions HTTP ${response.status}`
      );
    }

    const results =
      getResults(
        response.data
      );

    if (total === null) {
      total =
        getCount(
          response.data
        );
    }

    all.push(
      ...results
    );

    if (
      results.length <
      limit
    ) {
      break;
    }

    offset += limit;

    if (
      total !== null &&
      all.length >= total
    ) {
      break;
    }

    if (offset > 5000) {
      break;
    }
  }

  return {
    total:
      total ??
      all.length,

    results:
      all
  };
}

// ======================================================
// REAL BSD ODDS FEED
// ======================================================

async function fetchEventOdds(eventId) {
  if (!eventId) {
    return {
      ok: false,
      status: 0,
      data: null
    };
  }

  const url =
    `${BSD_BASE}/odds/` +
    `?event_id=${encodeURIComponent(
      eventId
    )}` +
    `&limit=500`;

  return await fetchJson(url);
}

// ======================================================
// NORMALIZE BSD ODDS ROWS
// ======================================================

function normalizeMarket(
  value
) {
  if (!value) return "";

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function normalizeOutcome(
  value
) {
  if (!value) return "";

  return String(value)
    .trim()
    .toUpperCase();
}

function mapOddsRow(row) {
  const market =
    normalizeMarket(
      firstValue(
        row?.market,
        row?.market_key,
        row?.market_type,
        row?.market_name
      )
    );

  const outcome =
    normalizeOutcome(
      firstValue(
        row?.outcome,
        row?.selection,
        row?.result
      )
    );

  const odds =
    safeNumber(
      firstValue(
        row?.odds,
        row?.decimal_odds,
        row?.price,
        row?.quote
      )
    );

  if (
    !validOdds(odds)
  ) {
    return null;
  }

  let key = null;

  if (
    market === "1x2" ||
    market === "match_winner" ||
    market === "winner"
  ) {
    if (outcome === "HOME") key = "HOME";
    if (outcome === "DRAW") key = "DRAW";
    if (outcome === "AWAY") key = "AWAY";
  }

  if (
    market === "over_under_15" ||
    market === "over_under_1_5" ||
    market === "totals_15"
  ) {
    if (
      outcome === "OVER"
    ) {
      key = "OVER15";
    }

    if (
      outcome === "UNDER"
    ) {
      key = "UNDER15";
    }
  }

  if (
    market === "over_under_25" ||
    market === "over_under_2_5" ||
    market === "totals_25"
  ) {
    if (
      outcome === "OVER"
    ) {
      key = "OVER25";
    }

    if (
      outcome === "UNDER"
    ) {
      key = "UNDER25";
    }
  }

  if (
    market === "over_under_35" ||
    market === "over_under_3_5" ||
    market === "totals_35"
  ) {
    if (
      outcome === "OVER"
    ) {
      key = "OVER35";
    }

    if (
      outcome === "UNDER"
    ) {
      key = "UNDER35";
    }
  }

  if (
    market === "btts" ||
    market === "both_teams_to_score"
  ) {
    if (outcome === "YES") {
      key = "BTTS_YES";
    }

    if (outcome === "NO") {
      key = "BTTS_NO";
    }
  }

  if (
    market === "double_chance" ||
    market === "doublechance"
  ) {
    if (outcome === "1X") {
      key = "1X";
    }

    if (outcome === "X2") {
      key = "X2";
    }
  }

  if (!key) {
    return null;
  }

  return {
    key,

    odds,

    bookmaker:
      firstValue(
        row?.bookmaker_name,
        row?.bookmaker,
        row?.bookmaker_slug
      ),

    movement:
      firstValue(
        row?.movement,
        row?.price_movement,
        row?.direction
      ),

    isMaxQuote:
      Boolean(
        firstValue(
          row?.is_max_quote,
          row?.isMaxQuote,
          false
        )
      ),

    updatedAt:
      firstValue(
        row?.updated_at,
        row?.updatedAt
      )
  };
}

function normalizeOddsFeed(data) {
  const rows =
    getResults(data);

  const best = {};

  for (
    const row of rows
  ) {
    const mapped =
      mapOddsRow(row);

    if (!mapped) {
      continue;
    }

    const current =
      best[mapped.key];

    /*
     * Prefer BSD's explicitly marked
     * max quote. Otherwise select
     * the highest available price.
     */

    if (
      !current ||
      (
        mapped.isMaxQuote &&
        !current.isMaxQuote
      ) ||
      (
        mapped.isMaxQuote ===
          current.isMaxQuote &&
        mapped.odds >
          current.odds
      )
    ) {
      best[mapped.key] =
        mapped;
    }
  }

  return best;
}

// ======================================================
// PRELIMINARY SCORING
// ======================================================

function scoreCandidate(
  candidate
) {
  const probability =
    candidate.probability /
    100;

  const confidence =
    candidate.confidence !==
      null
      ? candidate.confidence /
        100
      : 0;

  let score =
    probability * 100 +
    confidence * 18;

  if (confidence >= 0.90) {
    score += 3;
  } else if (
    confidence >= 0.80
  ) {
    score += 2;
  } else if (
    confidence >= 0.70
  ) {
    score += 1;
  }

  /*
   * Real odds/value.
   */

  if (
    validOdds(
      candidate.odds
    )
  ) {
    const value =
      candidate.value ??
      0;

    score += Math.min(
      Math.max(
        value * 25,
        -5
      ),
      12
    );

    if (
      candidate.fairOdds !==
        null &&
      candidate.odds >=
        candidate.fairOdds
    ) {
      score += 2;
    }
  }

  /*
   * BSD recommendation is a
   * secondary signal only.
   */

  if (
    candidate.recommendationStrength >
    0
  ) {
    score += 2;
  }

  /*
   * Double Chance gets a small
   * structural bonus because it
   * can represent a lower-risk
   * market when probability supports it.
   */

  if (
    candidate.marketKey ===
      "1X" ||
    candidate.marketKey ===
      "X2"
  ) {
    score += 1.5;
  }

  /*
   * Actual market movement.
   *
   * Shortening = price falling.
   * Drifting = price rising.
   *
   * Movement is NOT allowed to
   * override probability.
   */

  if (
    candidate.marketMovement ===
    "SHORTENING"
  ) {
    score += 1.5;
  }

  if (
    candidate.marketMovement ===
    "DRIFTING"
  ) {
    score -= 0.75;
  }

  candidate.score =
    Number(
      score.toFixed(2)
    );

  return candidate;
}

// ======================================================
// ENRICH CANDIDATES WITH REAL ODDS
// ======================================================

function enrichCandidate(
  candidate,
  oddsData
) {
  if (!oddsData) {
    return candidate;
  }

  const best =
    oddsData[
      candidate.marketKey
    ];

  if (
    !best ||
    !validOdds(
      best.odds
    )
  ) {
    return candidate;
  }

  candidate.odds =
    best.odds;

  candidate.bookmaker =
    best.bookmaker ??
    null;

  candidate.marketMovement =
    best.movement ??
    null;

  candidate.oddsSource =
    best.isMaxQuote
      ? "BSD_MAX_QUOTE"
      : "BSD_BEST_AVAILABLE";

  const probability =
    candidate.probability /
    100;

  candidate.fairOdds =
    fairOdds(
      probability
    );

  candidate.value =
    Number(
      (
        probability *
          candidate.odds -
        1
      ).toFixed(4)
    );

  return candidate;
}

// ======================================================
// TOP PICKS
// ======================================================

function chooseTopPicks(
  candidates
) {
  const scored =
    candidates
      .map(
        scoreCandidate
      )
      .sort(
        (a, b) => {
          if (
            b.score !==
            a.score
          ) {
            return (
              b.score -
              a.score
            );
          }

          if (
            b.probability !==
            a.probability
          ) {
            return (
              b.probability -
              a.probability
            );
          }

          return (
            (
              b.confidence ??
              0
            ) -
            (
              a.confidence ??
              0
            )
          );
        }
      );

  const selected = [];

  const usedEvents =
    new Set();

  const marketCounts =
    {};

  /*
   * First pass.
   *
   * No more than three TOTAL
   * selections if other strong
   * markets are available.
   */

  for (
    const candidate
    of scored
  ) {
    if (
      selected.length >=
      MAX_TOP_PICKS
    ) {
      break;
    }

    const eventId =
      String(
        candidate.eventId
      );

    if (
      usedEvents.has(
        eventId
      )
    ) {
      continue;
    }

    const count =
      marketCounts[
        candidate.market
      ] ?? 0;

    if (
      candidate.market ===
        "TOTAL" &&
      count >= 3
    ) {
      continue;
    }

    usedEvents.add(
      eventId
    );

    marketCounts[
      candidate.market
    ] =
      count + 1;

    selected.push(
      candidate
    );
  }

  /*
   * If fewer than five strong
   * selections exist, don't invent
   * additional ones.
   */

  return selected;
}

// ======================================================
// ANALYSIS
// ======================================================

async function analyze(date) {
  const started =
    Date.now();

  const allPredictions =
    await fetchAllPredictions();

  let predictions =
    filterPredictionsByDate(
      allPredictions.results,
      date
    );

  if (
    predictions.length === 0
  ) {
    predictions =
      allPredictions.results.filter(
        item => {
          const raw =
            eventDateOf(item);

          return (
            raw &&
            String(raw)
              .startsWith(date)
          );
        }
      );
  }

  const allCandidates = [];

  for (
    const prediction
    of predictions
  ) {
    allCandidates.push(
      ...generateCandidates(
        prediction
      )
    );
  }

  /*
   * Preliminary ranking.
   *
   * We don't hit the odds endpoint
   * for every candidate because several
   * candidates belong to the same event.
   */

  const preliminary =
    [...allCandidates]
      .map(
        scoreCandidate
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  /*
   * Take the strongest 30 unique events
   * for real bookmaker odds enrichment.
   */

  const eventIds =
    [];

  const seenEvents =
    new Set();

  for (
    const candidate
    of preliminary
  ) {
    const id =
      String(
        candidate.eventId
      );

    if (
      !id ||
      seenEvents.has(id)
    ) {
      continue;
    }

    seenEvents.add(id);
    eventIds.push(
      candidate.eventId
    );

    if (
      eventIds.length >= 30
    ) {
      break;
    }
  }

  const oddsCache =
    new Map();

  let oddsRequests = 0;
  let oddsSuccessful = 0;
  let oddsFailed = 0;

  /*
   * Fetch odds sequentially.
   * This avoids hammering the API.
   */

  for (
    const eventId
    of eventIds
  ) {
    oddsRequests++;

    const response =
      await fetchEventOdds(
        eventId
      );

    if (
      response.ok
    ) {
      const normalized =
        normalizeOddsFeed(
          response.data
        );

      oddsCache.set(
        String(eventId),
        normalized
      );

      if (
        Object.keys(
          normalized
        ).length > 0
      ) {
        oddsSuccessful++;
      } else {
        oddsFailed++;
      }
    } else {
      oddsCache.set(
        String(eventId),
        {}
      );

      oddsFailed++;
    }
  }

  /*
   * Apply real odds.
   */

  for (
    const candidate
    of allCandidates
  ) {
    const odds =
      oddsCache.get(
        String(
          candidate.eventId
        )
      );

    enrichCandidate(
      candidate,
      odds
    );
  }

  /*
   * Final scoring AFTER odds.
   */

  for (
    const candidate
    of allCandidates
  ) {
    scoreCandidate(
      candidate
    );
  }

  const topPicks =
    chooseTopPicks(
      allCandidates
    );

  return {
    version:
      VERSION,

    source:
      SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() -
      started,

    exchange,

    predictionsTotal:
      allPredictions.total,

    predictionsDownloaded:
      allPredictions.results.length,

    predictionsFound:
      predictions.length,

    candidatesFound:
      allCandidates.length,

    qualificationCount:
      allCandidates.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    oddsStatus: {
      endpoint:
        "/api/v2/odds/",

      requests:
        oddsRequests,

      successful:
        oddsSuccessful,

      failed:
        oddsFailed,

      message:
        oddsSuccessful > 0
          ? "Real BSD bookmaker odds were retrieved and included in ranking."
          : "No usable BSD bookmaker odds were retrieved. No odds or value are fabricated."
    },

    methodology: {
      primary:
        "model probability",

      secondary: [
        "model confidence",
        "real bookmaker odds",
        "fair odds",
        "value",
        "BSD recommendation",
        "market movement"
      ],

      markets: [
        "1X",
        "X2",
        "1",
        "X",
        "2",
        "OVER 1.5",
        "UNDER 1.5",
        "OVER 2.5",
        "UNDER 2.5",
        "OVER 3.5",
        "UNDER 3.5",
        "BTTS YES",
        "BTTS NO"
      ],

      valueFormula:
        "probability × odds - 1",

      onePickPerEvent:
        true,

      exchangeRule:
        "Exchange movement is shown only when real exchange data is connected."
    },

    topPicks
  };
}

// ======================================================
// ROUTES
// ======================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "ok",
      service:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE,
      exchange
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      version: VERSION,
      source: SOURCE,
      exchange
    });
  }
);

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const data =
        await fetchAllPredictions();

      res.json({
        version: VERSION,

        count:
          data.total,

        downloaded:
          data.results.length,

        sample:
          data.results
            .slice(0, 10)
            .map(
              item => ({
                eventId:
                  eventIdOf(item),

                event:
                  `${homeName(item)} – ${awayName(item)}`,

                date:
                  eventDateOf(item),

                probabilities:
                  getProbabilities(
                    item
                  ),

                confidence:
                  getConfidence(
                    item
                  ),

                odds:
                  getOdds(item),

                recommendation:
                  getRecommendationText(
                    item
                  )
              })
            )
      });
    } catch (error) {
      res.status(500)
        .json({
          version: VERSION,
          error:
            error.message
        });
    }
  }
);

app.get(
  "/api/debug-odds",
  async (req, res) => {
    try {
      const eventId =
        req.query.eventId;

      if (!eventId) {
        return res.status(400)
          .json({
            version: VERSION,
            error:
              "Missing eventId"
          });
      }

      const response =
        await fetchEventOdds(
          eventId
        );

      res.json({
        version: VERSION,

        eventId,

        httpStatus:
          response.status,

        ok:
          response.ok,

        normalized:
          response.ok
            ? normalizeOddsFeed(
                response.data
              )
            : {},

        raw:
          response.data
      });
    } catch (error) {
      res.status(500)
        .json({
          version: VERSION,
          error:
            error.message
        });
    }
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const data =
        await fetchAllPredictions();

      const predictions =
        filterPredictionsByDate(
          data.results,
          date
        );

      res.json({
        version: VERSION,

        date,

        count:
          predictions.length,

        events:
          predictions.map(
            item => ({
              eventId:
                eventIdOf(item),

              event:
                `${homeName(item)} – ${awayName(item)}`,

              date:
                eventDateOf(item),

              league:
                leagueNameOf(item),

              confidence:
                getConfidence(
                  item
                ),

              probabilities:
                getProbabilities(
                  item
                ),

              odds:
                getOdds(item),

              recommendation:
                getRecommendationText(
                  item
                )
            })
          )
      });
    } catch (error) {
      res.status(500)
        .json({
          version: VERSION,
          error:
            error.message
        });
    }
  }
);

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const result =
        await analyze(date);

      res.json(result);
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500)
        .json({
          version: VERSION,
          source: SOURCE,
          error:
            error.message,
          exchange
        });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const result =
        await analyze(date);

      res.json({
        version:
          result.version,

        source:
          result.source,

        date:
          result.date,

        generatedAt:
          result.generatedAt,

        processingMs:
          result.processingMs,

        exchange:
          result.exchange,

        predictionsTotal:
          result.predictionsTotal,

        predictionsDownloaded:
          result.predictionsDownloaded,

        predictionsFound:
          result.predictionsFound,

        candidatesFound:
          result.candidatesFound,

        qualificationCount:
          result.qualificationCount,

        maxTopPicks:
          result.maxTopPicks,

        oddsStatus:
          result.oddsStatus,

        topPicks:
          result.topPicks
      });
    } catch (error) {
      console.error(
        "TOP PICKS ERROR:",
        error
      );

      res.status(500)
        .json({
          version: VERSION,
          source: SOURCE,
          error:
            error.message,
          exchange
        });
    }
  }
);

// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );

    console.log(
      `BSD API configured: ${
        BSD_API_KEY
          ? "YES"
          : "NO"
      }`
    );
  }
);
