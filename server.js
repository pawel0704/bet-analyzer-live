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

const VERSION = "6.9.7";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

const MIN_CONFIDENCE = 0.55;
const HIGH_CONFIDENCE = 0.80;
const MIN_PROBABILITY = 0.60;

const MIN_ODDS = 1.10;
const MAX_ODDS = 8.00;

const REQUEST_TIMEOUT_MS = 9000;

const exchange = {
  connected: false,
  status: "NOT_CONNECTED",
  message:
    "Betting exchange data is not connected. No exchange movement is fabricated."
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min = 0, max = 1) {
  const n = safeNumber(value);
  if (n === null) return null;

  return Math.max(min, Math.min(max, n));
}

function normalizeProbability(value) {
  const n = safeNumber(value);
  if (n === null) return null;

  return clamp(n > 1 ? n / 100 : n);
}

function normalizeDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return String(value).slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function buildHeaders() {
  const headers = {
    Accept: "application/json"
  };

  if (BSD_API_KEY) {
    headers.Authorization = `Token ${BSD_API_KEY}`;
  }

  return headers;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...buildHeaders(),
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
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
      data: {
        error: error?.message || "request_failed"
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getResults(payload) {
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

  if (payload.data && Array.isArray(payload.data.results)) {
    return payload.data.results;
  }

  return [];
}

function getCount(payload) {
  if (!payload) return null;

  if (safeNumber(payload.count) !== null) {
    return safeNumber(payload.count);
  }

  if (
    payload.data &&
    safeNumber(payload.data.count) !== null
  ) {
    return safeNumber(payload.data.count);
  }

  return null;
}

function eventIdOf(item) {
  return (
    item?.event_id ??
    item?.eventId ??
    item?.match_id ??
    item?.matchId ??
    item?.event?.id ??
    item?.match?.id ??
    null
  );
}

function homeName(item) {
  return (
    item?.home_team ??
    item?.homeTeam ??
    item?.home ??
    item?.event?.home_team ??
    item?.event?.homeTeam ??
    item?.event?.home?.name ??
    item?.match?.home_team ??
    item?.match?.home?.name ??
    "Home"
  );
}

function awayName(item) {
  return (
    item?.away_team ??
    item?.awayTeam ??
    item?.away ??
    item?.event?.away_team ??
    item?.event?.awayTeam ??
    item?.event?.away?.name ??
    item?.match?.away_team ??
    item?.match?.away?.name ??
    "Away"
  );
}

function eventDateOf(item) {
  return (
    item?.event_date ??
    item?.eventDate ??
    item?.date ??
    item?.kickoff ??
    item?.start_time ??
    item?.event?.event_date ??
    item?.event?.date ??
    item?.match?.event_date ??
    item?.match?.date ??
    null
  );
}

function leagueNameOf(item) {
  return (
    item?.league_name ??
    item?.league ??
    item?.competition ??
    item?.event?.league_name ??
    item?.event?.league ??
    item?.match?.league_name ??
    null
  );
}

function getConfidence(item) {
  return normalizeProbability(
    item?.confidence ??
    item?.prediction?.confidence ??
    item?.model_confidence ??
    item?.prediction?.model_confidence
  );
}

function getProbabilities(item) {
  const source =
    item?.probabilities ||
    item?.prediction?.probabilities ||
    item;

  return {
    home: normalizeProbability(
      source?.home ??
      source?.prob_home ??
      source?.probability_home ??
      source?.home_probability ??
      source?.p_home
    ),

    draw: normalizeProbability(
      source?.draw ??
      source?.prob_draw ??
      source?.probability_draw ??
      source?.draw_probability ??
      source?.p_draw
    ),

    away: normalizeProbability(
      source?.away ??
      source?.prob_away ??
      source?.probability_away ??
      source?.away_probability ??
      source?.p_away
    ),

    over15: normalizeProbability(
      source?.over_15 ??
      source?.over15 ??
      source?.prob_over_15 ??
      source?.probability_over_15
    ),

    over25: normalizeProbability(
      source?.over_25 ??
      source?.over25 ??
      source?.prob_over_25 ??
      source?.probability_over_25
    ),

    over35: normalizeProbability(
      source?.over_35 ??
      source?.over35 ??
      source?.prob_over_35 ??
      source?.probability_over_35
    ),

    under15: normalizeProbability(
      source?.under_15 ??
      source?.under15 ??
      source?.prob_under_15 ??
      source?.probability_under_15
    ),

    under25: normalizeProbability(
      source?.under_25 ??
      source?.under25 ??
      source?.prob_under_25 ??
      source?.probability_under_25
    ),

    under35: normalizeProbability(
      source?.under_35 ??
      source?.under35 ??
      source?.prob_under_35 ??
      source?.probability_under_35
    ),

    bttsYes: normalizeProbability(
      source?.btts_yes ??
      source?.bttsYes ??
      source?.prob_btts_yes ??
      source?.probability_btts_yes ??
      source?.btts
    ),

    bttsNo: normalizeProbability(
      source?.btts_no ??
      source?.bttsNo ??
      source?.prob_btts_no ??
      source?.probability_btts_no
    )
  };
}

function getOdds(item) {
  const source =
    item?.odds ||
    item?.prediction?.odds ||
    item;

  return {
    home: safeNumber(
      source?.odds_home ??
      source?.home_odds ??
      source?.home
    ),

    draw: safeNumber(
      source?.odds_draw ??
      source?.draw_odds ??
      source?.draw
    ),

    away: safeNumber(
      source?.odds_away ??
      source?.away_odds ??
      source?.away
    ),

    over15: safeNumber(
      source?.odds_over_15 ??
      source?.over_15_odds ??
      source?.over15_odds
    ),

    over25: safeNumber(
      source?.odds_over_25 ??
      source?.over_25_odds ??
      source?.over25_odds
    ),

    over35: safeNumber(
      source?.odds_over_35 ??
      source?.over_35_odds ??
      source?.over35_odds
    ),

    under15: safeNumber(
      source?.odds_under_15 ??
      source?.under_15_odds ??
      source?.under15_odds
    ),

    under25: safeNumber(
      source?.odds_under_25 ??
      source?.under_25_odds ??
      source?.under25_odds
    ),

    under35: safeNumber(
      source?.odds_under_35 ??
      source?.under_35_odds ??
      source?.under35_odds
    ),

    bttsYes: safeNumber(
      source?.odds_btts_yes ??
      source?.btts_yes_odds ??
      source?.btts_yes
    ),

    bttsNo: safeNumber(
      source?.odds_btts_no ??
      source?.btts_no_odds ??
      source?.btts_no
    )
  };
}

function recursiveStrings(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string") {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      recursiveStrings(item, output);
    }

    return output;
  }

  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      if (
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean"
      ) {
        output.push(`${key}: ${val}`);
      } else {
        recursiveStrings(val, output);
      }
    }
  }

  return output;
}

function getRecommendationText(item) {
  const candidates = [
    item?.recommendations,
    item?.recommendation,
    item?.prediction?.recommendations,
    item?.prediction?.recommendation,
    item?.recommended,
    item?.tip,
    item?.best_pick
  ];

  const strings = [];

  for (const candidate of candidates) {
    recursiveStrings(candidate, strings);
  }

  return strings.join(" | ");
}

function getRecommendationFlags(item) {
  const text =
    getRecommendationText(item).toLowerCase();

  return {
    homeDraw:
      text.includes("win or draw") ||
      text.includes("avoid defeat") ||
      text.includes("home or draw") ||
      text.includes("1x"),

    awayDraw:
      text.includes("away or draw") ||
      text.includes("draw or away") ||
      text.includes("x2"),

    home:
      text.includes("home win") ||
      text.includes("home to win") ||
      text.includes("win (home)"),

    away:
      text.includes("away win") ||
      text.includes("away to win") ||
      text.includes("win (away)"),

    over15:
      text.includes("over 1.5"),

    over25:
      text.includes("over 2.5"),

    over35:
      text.includes("over 3.5"),

    under15:
      text.includes("under 1.5"),

    under25:
      text.includes("under 2.5"),

    under35:
      text.includes("under 3.5"),

    bttsYes:
      text.includes("both teams to score") ||
      text.includes("btts yes") ||
      text.includes("btts: yes"),

    bttsNo:
      text.includes("btts no") ||
      text.includes("btts: no")
  };
}

function validOdds(odds) {
  return (
    odds !== null &&
    Number.isFinite(odds) &&
    odds >= MIN_ODDS &&
    odds <= MAX_ODDS
  );
}

function makeCandidate({
  item,
  market,
  label,
  probability,
  odds,
  confidence,
  priority
}) {
  const p = normalizeProbability(probability);

  if (
    p === null ||
    p < MIN_PROBABILITY
  ) {
    return null;
  }

  const value =
    validOdds(odds)
      ? Number((p * odds - 1).toFixed(4))
      : null;

  const probabilityScore = p * 100;

  const confidenceScore =
    (confidence ?? 0) * 100;

  const highConfidenceBonus =
    confidence !== null &&
    confidence >= HIGH_CONFIDENCE
      ? 12
      : 0;

  const recommendationBonus =
    priority * 4;

  const oddsPenalty =
    validOdds(odds)
      ? Math.max(0, odds - 2.5) * 2
      : 4;

  const valueBonus =
    value !== null
      ? Math.max(
          -5,
          Math.min(10, value * 20)
        )
      : 0;

  const score =
    probabilityScore * 1.1 +
    confidenceScore * 0.35 +
    highConfidenceBonus +
    recommendationBonus +
    valueBonus -
    oddsPenalty;

  return {
    eventId: eventIdOf(item),

    event:
      `${homeName(item)} – ${awayName(item)}`,

    date:
      eventDateOf(item),

    league:
      leagueNameOf(item),

    market,

    pick: label,

    probability:
      Number((p * 100).toFixed(1)),

    confidence:
      confidence !== null
        ? Number(
            (confidence * 100).toFixed(1)
          )
        : null,

    odds:
      validOdds(odds)
        ? Number(odds.toFixed(3))
        : null,

    fairOdds:
      p > 0
        ? Number((1 / p).toFixed(3))
        : null,

    value:
      value !== null
        ? Number((value * 100).toFixed(2))
        : null,

    score:
      Number(score.toFixed(2)),

    recommendationSource:
      getRecommendationText(item) || null,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED"
    }
  };
}

function generateCandidates(item) {
  const probabilities =
    getProbabilities(item);

  const odds =
    getOdds(item);

  const confidence =
    getConfidence(item);

  const flags =
    getRecommendationFlags(item);

  const candidates = [];

  /*
   * 1X / X2
   *
   * BSD very frequently publishes "win or draw"
   * / "avoid defeat" as its primary call.
   */
  if (
    probabilities.home !== null &&
    probabilities.draw !== null
  ) {
    candidates.push(
      makeCandidate({
        item,
        market: "DOUBLE_CHANCE",
        label: "1X – gospodarz lub remis",
        probability:
          probabilities.home +
          probabilities.draw,
        odds: null,
        confidence,
        priority:
          flags.homeDraw
            ? 8
            : 1
      })
    );
  }

  if (
    probabilities.away !== null &&
    probabilities.draw !== null
  ) {
    candidates.push(
      makeCandidate({
        item,
        market: "DOUBLE_CHANCE",
        label: "X2 – remis lub goście",
        probability:
          probabilities.away +
          probabilities.draw,
        odds: null,
        confidence,
        priority:
          flags.awayDraw
            ? 8
            : 1
      })
    );
  }

  candidates.push(
    makeCandidate({
      item,
      market: "1X2",
      label: "1 – wygrana gospodarzy",
      probability:
        probabilities.home,
      odds:
        odds.home,
      confidence,
      priority:
        flags.home ? 4 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "1X2",
      label: "2 – wygrana gości",
      probability:
        probabilities.away,
      odds:
        odds.away,
      confidence,
      priority:
        flags.away ? 4 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "OVER 1.5",
      probability:
        probabilities.over15,
      odds:
        odds.over15,
      confidence,
      priority:
        flags.over15 ? 5 : 1
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "OVER 2.5",
      probability:
        probabilities.over25,
      odds:
        odds.over25,
      confidence,
      priority:
        flags.over25 ? 4 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "OVER 3.5",
      probability:
        probabilities.over35,
      odds:
        odds.over35,
      confidence,
      priority:
        flags.over35 ? 3 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "UNDER 1.5",
      probability:
        probabilities.under15,
      odds:
        odds.under15,
      confidence,
      priority:
        flags.under15 ? 3 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "UNDER 2.5",
      probability:
        probabilities.under25,
      odds:
        odds.under25,
      confidence,
      priority:
        flags.under25 ? 4 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "TOTAL",
      label: "UNDER 3.5",
      probability:
        probabilities.under35,
      odds:
        odds.under35,
      confidence,
      priority:
        flags.under35 ? 5 : 1
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "BTTS",
      label: "BTTS – TAK",
      probability:
        probabilities.bttsYes,
      odds:
        odds.bttsYes,
      confidence,
      priority:
        flags.bttsYes ? 4 : 0
    })
  );

  candidates.push(
    makeCandidate({
      item,
      market: "BTTS",
      label: "BTTS – NIE",
      probability:
        probabilities.bttsNo,
      odds:
        odds.bttsNo,
      confidence,
      priority:
        flags.bttsNo ? 4 : 0
    })
  );

  return candidates.filter(Boolean);
}

async function fetchAllPredictions() {
  const all = [];

  const pageSize = 200;

  let offset = 0;
  let total = null;

  while (true) {
    const url =
      `${BSD_PUBLIC}/predictions/?limit=${pageSize}&offset=${offset}`;

    const response =
      await fetchJson(url);

    if (!response.ok) {
      throw new Error(
        `BSD predictions HTTP ${response.status}`
      );
    }

    const results =
      getResults(response.data);

    if (!results.length) {
      break;
    }

    all.push(...results);

    const count =
      getCount(response.data);

    if (count !== null) {
      total = count;
    }

    if (results.length < pageSize) {
      break;
    }

    if (
      total !== null &&
      all.length >= total
    ) {
      break;
    }

    offset += pageSize;

    if (offset > 5000) {
      break;
    }

    await sleep(100);
  }

  return {
    total:
      total ?? all.length,

    results:
      all
  };
}

function filterPredictionsByDate(
  predictions,
  date
) {
  return predictions.filter(item => {
    return (
      normalizeDate(
        eventDateOf(item)
      ) === date
    );
  });
}

async function fetchEventDetails(eventId) {
  if (!eventId) {
    return null;
  }

  const url =
    `${BSD_BASE}/events/${eventId}/`;

  const response =
    await fetchJson(url);

  if (!response.ok) {
    return null;
  }

  return response.data;
}

function extractBookmakerCount(data) {
  if (!data) return null;

  const direct =
    data.bookmakers_count ??
    data.bookmaker_count ??
    data.num_bookmakers ??
    data.number_of_bookmakers;

  if (
    safeNumber(direct) !== null
  ) {
    return safeNumber(direct);
  }

  const arrays = [
    data.bookmakers,
    data.odds,
    data.prices,
    data.markets
  ];

  for (const array of arrays) {
    if (!Array.isArray(array)) {
      continue;
    }

    const unique =
      new Set();

    for (const item of array) {
      const name =
        item?.bookmaker ??
        item?.bookmaker_name ??
        item?.name ??
        item?.source;

      if (name) {
        unique.add(String(name));
      }
    }

    if (unique.size > 0) {
      return unique.size;
    }
  }

  return null;
}

function findNestedOdds(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return [];
  }

  const output = [];

  function walk(value, path = []) {
    if (
      !value ||
      typeof value !== "object"
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, path);
      }

      return;
    }

    const keys =
      Object.keys(value);

    const hasOdd =
      keys.some(key =>
        /odd|price|decimal/i.test(key)
      );

    if (hasOdd) {
      output.push({
        ...value,
        __path:
          path.join(".")
      });
    }

    for (
      const [key, child]
      of Object.entries(value)
    ) {
      if (
        child &&
        typeof child === "object"
      ) {
        walk(
          child,
          [...path, key]
        );
      }
    }
  }

  walk(data);

  return output;
}

function mergeEventOdds(
  candidate,
  eventDetails
) {
  if (!eventDetails) {
    return candidate;
  }

  const nested =
    findNestedOdds(
      eventDetails
    );

  const bookmakerCount =
    extractBookmakerCount(
      eventDetails
    );

  let bestOdds =
    candidate.odds;

  for (const row of nested) {
    const odd =
      safeNumber(row.decimal) ??
      safeNumber(row.odds) ??
      safeNumber(row.price) ??
      safeNumber(row.value);

    if (!validOdds(odd)) {
      continue;
    }

    if (
      bestOdds === null ||
      bestOdds === undefined ||
      odd > bestOdds
    ) {
      bestOdds = odd;
    }
  }

  if (
    bestOdds !== null &&
    bestOdds !== undefined
  ) {
    candidate.odds =
      Number(
        bestOdds.toFixed(3)
      );

    if (
      candidate.probability > 0
    ) {
      const p =
        candidate.probability / 100;

      candidate.fairOdds =
        Number(
          (1 / p).toFixed(3)
        );

      candidate.value =
        Number(
          (
            (p * candidate.odds - 1) *
            100
          ).toFixed(2)
        );
    }
  }

  candidate.bookmakers =
    bookmakerCount !== null
      ? bookmakerCount
      : null;

  return candidate;
}

function enrichCandidateFromEvent(
  candidate,
  eventDetails
) {
  if (!eventDetails) {
    return candidate;
  }

  candidate.referee =
    eventDetails?.referee ??
    eventDetails?.official ??
    null;

  candidate.status =
    eventDetails?.status ??
    eventDetails?.event_status ??
    null;

  candidate.venue =
    eventDetails?.venue ??
    null;

  candidate.predictedScore =
    eventDetails?.predicted_score ??
    eventDetails?.prediction
      ?.predicted_score ??
    eventDetails?.ai_preview
      ?.predicted_score ??
    null;

  candidate.unavailablePlayers =
    eventDetails?.unavailable_players ??
    eventDetails?.prediction
      ?.unavailable_players ??
    [];

  candidate.form =
    eventDetails?.recent_form ??
    eventDetails?.form ??
    null;

  candidate.lineups =
    eventDetails?.lineups ??
    null;

  return candidate;
}

/*
 * FINAL TOP-PICK PRIORITY
 *
 * Small and deliberate change in 6.9.7:
 *
 * When a strong double-chance candidate exists
 * (1X/X2 >= 80%), it gets a clear preference over
 * automatically selecting another high-probability
 * market such as OVER 1.5.
 *
 * We do NOT lower or change any filters.
 */
function finalCandidateScore(
  candidate,
  selected
) {
  let score =
    candidate.score ?? 0;

  if (
    candidate.market ===
      "DOUBLE_CHANCE" &&
    candidate.probability >= 80
  ) {
    score += 18;
  }

  /*
   * Very strong double chance.
   * This covers the BSD-style 90%+ calls.
   */
  if (
    candidate.market ===
      "DOUBLE_CHANCE" &&
    candidate.probability >= 90
  ) {
    score += 8;
  }

  /*
   * Small diversification bonus.
   * It never overrides a strong probability difference.
   */
  if (selected.length > 0) {
    const sameMarket =
      selected.filter(
        item =>
          item.market ===
          candidate.market
      ).length;

    if (sameMarket === 0) {
      score += 5;
    } else if (sameMarket === 1) {
      score += 2;
    }
  }

  return score;
}

function chooseTopPicks(candidates) {
  const pool =
    [...candidates];

  const selected = [];
  const usedEvents =
    new Set();

  while (
    selected.length <
      MAX_TOP_PICKS &&
    pool.length
  ) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (
      let i = 0;
      i < pool.length;
      i++
    ) {
      const candidate =
        pool[i];

      const eventKey =
        candidate.eventId ??
        candidate.event;

      if (
        usedEvents.has(eventKey)
      ) {
        continue;
      }

      const confidenceOK =
        candidate.confidence === null ||
        candidate.confidence >=
          MIN_CONFIDENCE * 100;

      if (!confidenceOK) {
        continue;
      }

      const score =
        finalCandidateScore(
          candidate,
          selected
        );

      if (
        score > bestScore
      ) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const chosen =
      pool.splice(
        bestIndex,
        1
      )[0];

    const eventKey =
      chosen.eventId ??
      chosen.event;

    usedEvents.add(
      eventKey
    );

    selected.push(
      chosen
    );
  }

  return selected;
}

async function analyze(
  date = todayUTC()
) {
  const started =
    Date.now();

  const predictionData =
    await fetchAllPredictions();

  const datePredictions =
    filterPredictionsByDate(
      predictionData.results,
      date
    );

  const candidates = [];

  for (
    const prediction
    of datePredictions
  ) {
    candidates.push(
      ...generateCandidates(
        prediction
      )
    );
  }

  const preliminary =
    [...candidates]
      .sort(
        (a, b) =>
          (b.score ?? 0) -
          (a.score ?? 0)
      )
      .slice(0, 25);

  const enriched = [];

  for (
    const candidate
    of preliminary
  ) {
    try {
      const details =
        await fetchEventDetails(
          candidate.eventId
        );

      let result =
        enrichCandidateFromEvent(
          candidate,
          details
        );

      result =
        mergeEventOdds(
          result,
          details
        );

      enriched.push(
        result
      );
    } catch {
      enriched.push(
        candidate
      );
    }

    await sleep(60);
  }

  const combined = [
    ...enriched,

    ...candidates.filter(
      candidate =>
        !enriched.some(
          e =>
            e.eventId ===
              candidate.eventId &&
            e.market ===
              candidate.market &&
            e.pick ===
              candidate.pick
        )
    )
  ];

  const deduped = [];
  const seen =
    new Set();

  for (
    const candidate
    of combined
  ) {
    const key = [
      candidate.eventId,
      candidate.market,
      candidate.pick
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(
      candidate
    );
  }

  const topPicks =
    chooseTopPicks(
      deduped
    );

  return {
    version: VERSION,
    source: SOURCE,
    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - started,

    exchange,

    predictionsTotal:
      predictionData.total,

    predictionsDownloaded:
      predictionData.results.length,

    predictionsFound:
      datePredictions.length,

    candidatesFound:
      candidates.length,

    enrichedCandidates:
      enriched.length,

    qualificationCount:
      deduped.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    filters: {
      minConfidence:
        MIN_CONFIDENCE,

      highConfidence:
        HIGH_CONFIDENCE,

      minProbability:
        MIN_PROBABILITY,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      valueIsRankingFactor:
        true,

      valueIsHardFilter:
        false,

      doubleChanceEnabled:
        true,

      eventOddsEnrichment:
        true,

      strongDoubleChancePriority:
        true
    },

    topPicks
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE,
    service:
      "Bet Analyzer Live"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE,
    exchange
  });
});

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      res.json(
        await analyze(date)
      );
    } catch (error) {
      res.status(500).json({
        status: "error",
        version: VERSION,
        source: SOURCE,
        error:
          error?.message ||
          "analysis_failed"
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

      res.json(
        await analyze(date)
      );
    } catch (error) {
      res.status(500).json({
        status: "error",
        version: VERSION,
        source: SOURCE,
        error:
          error?.message ||
          "analysis_failed"
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

        maxTopPicks:
          result.maxTopPicks,

        candidatesFound:
          result.candidatesFound,

        qualificationCount:
          result.qualificationCount,

        topPicks:
          result.topPicks
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        version: VERSION,
        source: SOURCE,
        error:
          error?.message ||
          "top_picks_failed"
      });
    }
  }
);

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const predictionData =
        await fetchAllPredictions();

      const filtered =
        filterPredictionsByDate(
          predictionData.results,
          date
        );

      const sample =
        filtered
          .slice(0, 20)
          .map(item => ({
            eventId:
              eventIdOf(item),

            event:
              `${homeName(item)} – ${awayName(item)}`,

            date:
              eventDateOf(item),

            league:
              leagueNameOf(item),

            confidence:
              getConfidence(item),

            probabilities:
              getProbabilities(item),

            odds:
              getOdds(item),

            recommendations:
              getRecommendationText(item),

            flags:
              getRecommendationFlags(item),

            generatedCandidates:
              generateCandidates(item)
          }));

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        date,

        predictionsTotal:
          predictionData.total,

        predictionsDownloaded:
          predictionData.results.length,

        predictionsFound:
          filtered.length,

        sample
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        version: VERSION,
        source: SOURCE,
        error:
          error?.message ||
          "debug_failed"
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
  );
});
