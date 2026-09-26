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

const VERSION = "6.6.5";
const SOURCE = "BSD";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 100;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.50;

const MIN_PROBABILITY = 50;

/*
 * We no longer require positive value at candidate creation.
 * A slightly negative edge can survive into the ranking if the
 * probability / market support is strong.
 */
const MIN_CANDIDATE_VALUE_EDGE = -8.0;

const REQUEST_TIMEOUT = 15000;
const DETAIL_CONCURRENCY = 5;

/*
|--------------------------------------------------------------------------
| BASIC HELPERS
|--------------------------------------------------------------------------
*/

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isoDateOnly(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return String(value).slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

function isUpcomingEvent(event) {
  if (!event) return false;

  const status = normalizeText(
    event.status ||
    event.state ||
    event.match_status ||
    event.event_status
  );

  if (
    status.includes("finished") ||
    status.includes("cancelled") ||
    status.includes("canceled") ||
    status.includes("postponed") ||
    status === "live" ||
    status === "inplay" ||
    status === "in play"
  ) {
    return false;
  }

  const date =
    event.date ||
    event.event_date ||
    event.start_time ||
    event.start_at ||
    event.kickoff_at ||
    event.start;

  if (!date) return false;

  const timestamp = new Date(date).getTime();

  if (!Number.isFinite(timestamp)) return false;

  return timestamp > Date.now();
}

function getEventId(event) {
  return safeNumber(
    event?.id ??
    event?.event_id ??
    event?.match_id
  );
}

function getHomeName(event) {
  return (
    event?.home?.name ||
    event?.home_team?.name ||
    event?.home?.team?.name ||
    event?.home_name ||
    event?.homeTeam?.name ||
    "Home"
  );
}

function getAwayName(event) {
  return (
    event?.away?.name ||
    event?.away_team?.name ||
    event?.away?.team?.name ||
    event?.away_name ||
    event?.awayTeam?.name ||
    "Away"
  );
}

function getEventDate(event) {
  return (
    event?.date ||
    event?.event_date ||
    event?.start_time ||
    event?.start_at ||
    event?.kickoff_at ||
    event?.start ||
    null
  );
}

/*
|--------------------------------------------------------------------------
| BSD FETCH
|--------------------------------------------------------------------------
*/

async function bsdFetch(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${BSD_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Token ${BSD_API_KEY}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message =
        data?.detail ||
        data?.message ||
        text?.slice(0, 300) ||
        `BSD ${response.status}`;

      const error = new Error(`BSD ${response.status} ${message}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return {
      status: response.status,
      data
    };
  } finally {
    clearTimeout(timeout);
  }
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
*/

async function fetchAllPages(
  path,
  {
    limit = 200,
    maxPages = 20,
    diagnostics = null
  } = {}
) {
  const all = [];

  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const separator = path.includes("?") ? "&" : "?";

    const requestPath =
      `${path}${separator}limit=${limit}&offset=${offset}`;

    try {
      const response = await bsdFetch(requestPath);

      const data = response.data || {};

      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data.results)
          ? data.results
          : Array.isArray(data.data)
            ? data.data
            : [];

      const count = safeNumber(data.count) ?? rows.length;

      all.push(...rows);

      if (diagnostics) {
        diagnostics.push({
          path: requestPath,
          status: response.status,
          count,
          rows: rows.length,
          hasNext: Boolean(data.next)
        });
      }

      if (
        rows.length === 0 ||
        !data.next ||
        all.length >= count
      ) {
        break;
      }

      offset += limit;
    } catch (error) {
      if (diagnostics) {
        diagnostics.push({
          path: requestPath,
          status: error.status || 500,
          error: String(error.message || error)
            .replace(/\s+/g, " ")
            .slice(0, 250)
        });
      }

      break;
    }
  }

  return all;
}

/*
|--------------------------------------------------------------------------
| EVENTS
|--------------------------------------------------------------------------
*/

async function getEventsForDate(date, diagnostics) {
  const attempts = [
    `/events/?date=${encodeURIComponent(date)}`,
    `/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}`
  ];

  let best = [];

  for (const path of attempts) {
    const localDiagnostics = [];

    const rows = await fetchAllPages(path, {
      limit: 200,
      maxPages: 5,
      diagnostics: localDiagnostics
    });

    if (diagnostics) {
      diagnostics.push(...localDiagnostics);
    }

    if (rows.length > best.length) {
      best = rows;
    }
  }

  return best;
}

/*
|--------------------------------------------------------------------------
| PREDICTIONS
|--------------------------------------------------------------------------
*/

function parsePredictionRow(row) {
  if (!row) return null;

  const eventId = safeNumber(
    row.event_id ??
    row.eventId ??
    row.match_id ??
    row.matchId ??
    row.event?.id ??
    row.match?.id
  );

  if (!eventId) return null;

  const markets =
    row.markets ||
    row.prediction?.markets ||
    row.data?.markets ||
    {};

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    row.match_result ||
    row.matchResult ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    row.over_under ||
    row.overUnder ||
    {};

  const btts =
    markets.btts ||
    row.btts ||
    {};

  const score =
    markets.score ||
    row.score ||
    {};

  const drawNoBet =
    markets.draw_no_bet ||
    markets.drawNoBet ||
    row.draw_no_bet ||
    row.drawNoBet ||
    {};

  const home = safeNumber(
    matchResult.prob_home ??
    matchResult.home ??
    row.prob_home ??
    row.home_probability ??
    row.home_prob
  );

  const draw = safeNumber(
    matchResult.prob_draw ??
    matchResult.draw ??
    row.prob_draw ??
    row.draw_probability ??
    row.draw_prob
  );

  const away = safeNumber(
    matchResult.prob_away ??
    matchResult.away ??
    row.prob_away ??
    row.away_probability ??
    row.away_prob
  );

  const over15 = safeNumber(
    overUnder.prob_over_15 ??
    overUnder.over_15 ??
    row.prob_over_15
  );

  const over25 = safeNumber(
    overUnder.prob_over_25 ??
    overUnder.over_25 ??
    row.prob_over_25
  );

  const over35 = safeNumber(
    overUnder.prob_over_35 ??
    overUnder.over_35 ??
    row.prob_over_35
  );

  const bttsYes = safeNumber(
    btts.prob_yes ??
    btts.yes ??
    row.prob_btts_yes
  );

  const dnbHome = safeNumber(
    drawNoBet.prob_home ??
    drawNoBet.home ??
    row.prob_dnb_home
  );

  const confidence = safeNumber(
    row.model?.confidence ??
    row.prediction?.confidence ??
    row.confidence
  );

  const mostLikelyScore =
    score.most_likely ??
    score.mostLikely ??
    row.most_likely_score ??
    row.score_prediction ??
    null;

  return {
    eventId,
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    dnbHome,
    score: mostLikelyScore,
    confidence
  };
}

async function getAllPredictions(diagnostics) {
  const rows = await fetchAllPages("/predictions/", {
    limit: 200,
    maxPages: 20,
    diagnostics
  });

  const map = new Map();

  for (const row of rows) {
    const parsed = parsePredictionRow(row);

    if (!parsed) continue;

    map.set(parsed.eventId, parsed);
  }

  return {
    map,
    total: rows.length,
    parsed: map.size
  };
}

/*
|--------------------------------------------------------------------------
| ODDS PARSING
|--------------------------------------------------------------------------
*/

function normalizeMarket(row) {
  return normalizeText(
    row?.market ??
    row?.market_name ??
    row?.market_slug ??
    row?.market_code ??
    row?.market_kind ??
    row?.market_family ??
    ""
  );
}

function normalizeOutcome(row) {
  return normalizeText(
    row?.outcome ??
    row?.outcome_name ??
    row?.selection ??
    row?.name ??
    row?.outcome_code ??
    ""
  );
}

function getLine(row) {
  return safeNumber(
    row?.line ??
    row?.total ??
    row?.handicap ??
    row?.points ??
    row?.goal_line ??
    row?.threshold
  );
}

function getOddsValue(row) {
  return safeNumber(
    row?.decimal_odds ??
    row?.odds ??
    row?.price ??
    row?.value
  );
}

function getPreviousOdds(row) {
  return safeNumber(
    row?.previous_decimal_odds ??
    row?.previous_odds ??
    row?.previous_price
  );
}

function getOpeningOdds(row) {
  return safeNumber(
    row?.opening_decimal_odds ??
    row?.opening_odds ??
    row?.opening_price
  );
}

function getBookmakerCount(row) {
  return safeNumber(
    row?.bookmaker_count ??
    row?.bookmakers_count ??
    row?.books_count ??
    row?.market_bookmaker_count
  );
}

function getUpdatedAt(row) {
  return (
    row?.updated_at ||
    row?.timestamp ||
    row?.last_updated ||
    row?.created_at ||
    null
  );
}

function classifyOddsRow(row) {
  const market = normalizeMarket(row);
  const outcome = normalizeOutcome(row);
  const line = getLine(row);

  const odds = getOddsValue(row);

  if (!odds || odds <= 1) return null;

  const is1x2 =
    market.includes("1x2") ||
    market.includes("match result") ||
    market.includes("match winner") ||
    market === "winner" ||
    market === "moneyline";

  const isDoubleChance =
    market.includes("double chance") ||
    market.includes("double_chance") ||
    market.includes("doublechance");

  const isOverUnder =
    market.includes("over under") ||
    market.includes("over/under") ||
    market.includes("total goals") ||
    market.includes("totals") ||
    market.includes("goals");

  const isBTTS =
    market.includes("btts") ||
    market.includes("both teams");

  if (is1x2) {
    if (
      outcome === "home" ||
      outcome === "1" ||
      outcome.includes("home")
    ) {
      return {
        type: "HOME",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }

    if (
      outcome === "draw" ||
      outcome === "x" ||
      outcome.includes("draw")
    ) {
      return {
        type: "DRAW",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }

    if (
      outcome === "away" ||
      outcome === "2" ||
      outcome.includes("away")
    ) {
      return {
        type: "AWAY",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }
  }

  if (isDoubleChance) {
    if (
      outcome === "1x" ||
      outcome === "1 x" ||
      outcome.includes("home or draw") ||
      outcome.includes("home/draw")
    ) {
      return {
        type: "1X",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }

    if (
      outcome === "x2" ||
      outcome === "x 2" ||
      outcome.includes("draw or away") ||
      outcome.includes("draw/away")
    ) {
      return {
        type: "X2",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }

    if (
      outcome === "12" ||
      outcome === "1 2" ||
      outcome.includes("home or away") ||
      outcome.includes("home/away")
    ) {
      return {
        type: "12",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }
  }

  if (isOverUnder) {
    const isOver =
      outcome.includes("over") ||
      outcome === "o";

    if (isOver && line !== null) {
      const normalizedLine = Number(line.toFixed(2));

      let type = null;

      if (normalizedLine === 1.5) type = "OVER15";
      if (normalizedLine === 2.5) type = "OVER25";
      if (normalizedLine === 3.5) type = "OVER35";

      if (type) {
        return {
          type,
          odds,
          line: normalizedLine,
          bookmakerCount: getBookmakerCount(row),
          previousOdds: getPreviousOdds(row),
          openingOdds: getOpeningOdds(row),
          updatedAt: getUpdatedAt(row),
          movement: row?.movement || null
        };
      }
    }
  }

  if (isBTTS) {
    if (
      outcome === "yes" ||
      outcome === "y" ||
      outcome.includes("yes")
    ) {
      return {
        type: "BTTS_YES",
        odds,
        line,
        bookmakerCount: getBookmakerCount(row),
        previousOdds: getPreviousOdds(row),
        openingOdds: getOpeningOdds(row),
        updatedAt: getUpdatedAt(row),
        movement: row?.movement || null
      };
    }
  }

  return null;
}

function chooseLatest(existing, incoming) {
  if (!existing) return incoming;

  const existingTime = existing.updatedAt
    ? new Date(existing.updatedAt).getTime()
    : 0;

  const incomingTime = incoming.updatedAt
    ? new Date(incoming.updatedAt).getTime()
    : 0;

  if (incomingTime >= existingTime) {
    return incoming;
  }

  return existing;
}

async function getOdds(eventId) {
  const rows = await fetchAllPages(
    `/odds/?event_id=${encodeURIComponent(eventId)}`,
    {
      limit: 200,
      maxPages: 10
    }
  );

  const parsed = {
    home: null,
    draw: null,
    away: null,

    dc1x: null,
    dcx2: null,
    dc12: null,

    over15: null,
    over25: null,
    over35: null,

    bttsYes: null,

    rowsCount: rows.length,
    rawCount: rows.length
  };

  for (const row of rows) {
    const item = classifyOddsRow(row);

    if (!item) continue;

    if (item.type === "HOME") {
      parsed.home = chooseLatest(parsed.home, item);
    }

    if (item.type === "DRAW") {
      parsed.draw = chooseLatest(parsed.draw, item);
    }

    if (item.type === "AWAY") {
      parsed.away = chooseLatest(parsed.away, item);
    }

    if (item.type === "1X") {
      parsed.dc1x = chooseLatest(parsed.dc1x, item);
    }

    if (item.type === "X2") {
      parsed.dcx2 = chooseLatest(parsed.dcx2, item);
    }

    if (item.type === "12") {
      parsed.dc12 = chooseLatest(parsed.dc12, item);
    }

    if (item.type === "OVER15") {
      parsed.over15 = chooseLatest(parsed.over15, item);
    }

    if (item.type === "OVER25") {
      parsed.over25 = chooseLatest(parsed.over25, item);
    }

    if (item.type === "OVER35") {
      parsed.over35 = chooseLatest(parsed.over35, item);
    }

    if (item.type === "BTTS_YES") {
      parsed.bttsYes = chooseLatest(parsed.bttsYes, item);
    }
  }

  return parsed;
}

/*
|--------------------------------------------------------------------------
| MOVEMENT
|--------------------------------------------------------------------------
*/

function calculateMovement(oddsObject) {
  if (!oddsObject) {
    return {
      movement: null,
      movementScore: 0
    };
  }

  const current = safeNumber(oddsObject.odds);
  const previous = safeNumber(oddsObject.previousOdds);
  const opening = safeNumber(oddsObject.openingOdds);

  let score = 0;
  let movement = oddsObject.movement || null;

  if (
    current &&
    previous &&
    previous > 0
  ) {
    const changePct =
      ((current - previous) / previous) * 100;

    if (changePct <= -0.75) {
      score += 5;
      movement = "SHORTENING";
    } else if (changePct <= -0.25) {
      score += 2;
      movement = "SHORTENING";
    } else if (changePct >= 0.75) {
      score -= 5;
      movement = "DRIFTING";
    } else if (changePct >= 0.25) {
      score -= 2;
      movement = "DRIFTING";
    }
  }

  if (
    current &&
    opening &&
    opening > 0
  ) {
    const openingChange =
      ((current - opening) / opening) * 100;

    if (openingChange <= -2) {
      score += 2;
    } else if (openingChange >= 2) {
      score -= 2;
    }
  }

  if (movement === "SHORTENING") {
    score += 2;
  }

  if (movement === "DRIFTING") {
    score -= 2;
  }

  return {
    movement,
    movementScore: clamp(score, -7, 7)
  };
}

/*
|--------------------------------------------------------------------------
| CANDIDATE MARKETS
|--------------------------------------------------------------------------
*/

function makeMarketCandidate({
  event,
  prediction,
  odds,
  type,
  probability,
  oddsObject,
  label
}) {
  const p = safeNumber(probability);
  const o = safeNumber(oddsObject?.odds);

  if (p === null || o === null) return null;

  if (p < MIN_PROBABILITY) return null;

  if (o < MIN_ODDS || o > MAX_ODDS) return null;

  const impliedProbability = (1 / o) * 100;

  const valueEdge = p - impliedProbability;

  if (valueEdge < MIN_CANDIDATE_VALUE_EDGE) {
    return null;
  }

  const movementData = calculateMovement(oddsObject);

  const bookmakerCount =
    safeNumber(oddsObject?.bookmakerCount) || 0;

  /*
   * Probability component.
   * Strong probabilities get more weight, but are not enough alone.
   */
  const probabilityScore =
    clamp((p - 50) * 0.75, 0, 35);

  /*
   * Value component.
   * Positive value helps strongly.
   * Small negative value is allowed but penalized.
   */
  const valueScore =
    clamp(valueEdge * 1.5, -10, 15);

  /*
   * Bookmaker breadth.
   */
  const bookmakerBonus =
    clamp(bookmakerCount / 10, 0, 4);

  /*
   * Market-specific weighting.
   */
  let marketBonus = 0;

  if (type === "1X" || type === "X2") {
    marketBonus = 3;
  }

  if (type === "HOME" || type === "AWAY") {
    marketBonus = 2;
  }

  if (
    type === "OVER15" ||
    type === "OVER25" ||
    type === "BTTS_YES"
  ) {
    marketBonus = 1;
  }

  /*
   * Very low odds are not automatically bad,
   * but they receive no special bonus.
   */
  const qualityScore =
    probabilityScore +
    valueScore +
    movementData.movementScore +
    bookmakerBonus +
    marketBonus;

  return {
    eventId: getEventId(event),

    home: getHomeName(event),
    away: getAwayName(event),

    eventDate: getEventDate(event),

    market: type,
    selection: type,

    label,

    probability: round(p, 1),
    odds: round(o, 3),
    impliedProbability: round(impliedProbability, 1),
    valueEdge: round(valueEdge, 2),

    movement: movementData.movement,
    movementScore: movementData.movementScore,

    bookmakerCount,

    previousOdds: oddsObject?.previousOdds ?? null,
    openingOdds: oddsObject?.openingOdds ?? null,

    probabilityScore: round(probabilityScore, 2),
    valueScore: round(valueScore, 2),
    bookmakerBonus: round(bookmakerBonus, 2),
    marketBonus,

    qualityScore: round(qualityScore, 2),

    predictionConfidence:
      prediction?.confidence ?? null,

    scorePrediction:
      prediction?.score ?? null,

    warnings: []
  };
}

/*
|--------------------------------------------------------------------------
| BUILD ALL CANDIDATES
|--------------------------------------------------------------------------
*/

function buildCandidates(event, prediction, odds) {
  if (!prediction || !odds) return [];

  const candidates = [];

  /*
   * 1X2
   */
  if (odds.home) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "HOME",
      probability: prediction.home,
      oddsObject: odds.home,
      label: "Wygrana gospodarzy"
    });

    if (c) candidates.push(c);
  }

  if (odds.draw) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "DRAW",
      probability: prediction.draw,
      oddsObject: odds.draw,
      label: "Remis"
    });

    if (c) candidates.push(c);
  }

  if (odds.away) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "AWAY",
      probability: prediction.away,
      oddsObject: odds.away,
      label: "Wygrana gości"
    });

    if (c) candidates.push(c);
  }

  /*
   * Double Chance.
   *
   * We prefer actual BSD double-chance odds when available.
   * If not available, we do NOT invent an odds value.
   */
  if (odds.dc1x) {
    const probability =
      safeNumber(prediction.home) !== null &&
      safeNumber(prediction.draw) !== null
        ? prediction.home + prediction.draw
        : null;

    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "1X",
      probability,
      oddsObject: odds.dc1x,
      label: "Gospodarze lub remis"
    });

    if (c) candidates.push(c);
  }

  if (odds.dcx2) {
    const probability =
      safeNumber(prediction.draw) !== null &&
      safeNumber(prediction.away) !== null
        ? prediction.draw + prediction.away
        : null;

    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "X2",
      probability,
      oddsObject: odds.dcx2,
      label: "Remis lub goście"
    });

    if (c) candidates.push(c);
  }

  if (odds.dc12) {
    const probability =
      safeNumber(prediction.home) !== null &&
      safeNumber(prediction.away) !== null
        ? prediction.home + prediction.away
        : null;

    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "12",
      probability,
      oddsObject: odds.dc12,
      label: "Gospodarze lub goście"
    });

    if (c) candidates.push(c);
  }

  /*
   * Goals
   */
  if (odds.over15) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "OVER15",
      probability: prediction.over15,
      oddsObject: odds.over15,
      label: "Powyżej 1.5 gola"
    });

    if (c) candidates.push(c);
  }

  if (odds.over25) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "OVER25",
      probability: prediction.over25,
      oddsObject: odds.over25,
      label: "Powyżej 2.5 gola"
    });

    if (c) candidates.push(c);
  }

  if (odds.over35) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "OVER35",
      probability: prediction.over35,
      oddsObject: odds.over35,
      label: "Powyżej 3.5 gola"
    });

    if (c) candidates.push(c);
  }

  /*
   * BTTS
   */
  if (odds.bttsYes) {
    const c = makeMarketCandidate({
      event,
      prediction,
      odds,
      type: "BTTS",
      probability: prediction.bttsYes,
      oddsObject: odds.bttsYes,
      label: "Obie drużyny strzelą"
    });

    if (c) candidates.push(c);
  }

  return candidates;
}

/*
|--------------------------------------------------------------------------
| EVENT DETAIL ENRICHMENT
|--------------------------------------------------------------------------
|
| BSD public docs expose:
| - /events/{id}/
| - /events/{id}/lineups/
| - H2H through match detail / MCP
|
| We try the REST forms without making them mandatory.
| If an endpoint is unavailable, the analysis still works.
|--------------------------------------------------------------------------
*/

async function fetchOptional(path) {
  try {
    const result = await bsdFetch(path);
    return result.data;
  } catch {
    return null;
  }
}

function extractFormFromObject(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const homeForm =
    data.home_form ||
    data.homeForm ||
    data.form?.home ||
    data.teams?.home?.form ||
    null;

  const awayForm =
    data.away_form ||
    data.awayForm ||
    data.form?.away ||
    data.teams?.away?.form ||
    null;

  return {
    home: homeForm,
    away: awayForm
  };
}

function extractH2H(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  return (
    data.head_to_head ||
    data.h2h ||
    data.headToHead ||
    data.match?.head_to_head ||
    null
  );
}

function extractLineups(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  return (
    data.lineups ||
    data.teams ||
    data.data ||
    null
  );
}

function analyzeSupportingData({
  candidate,
  detail,
  lineups,
  h2h
}) {
  const signals = [];
  const warnings = [];

  if (candidate.movement === "SHORTENING") {
    signals.push("kurs skraca się");
  }

  if (candidate.movement === "DRIFTING") {
    warnings.push("kurs dryfuje");
  }

  if (candidate.bookmakerCount >= 10) {
    signals.push("szerokie potwierdzenie bukmacherów");
  } else if (
    candidate.bookmakerCount > 0 &&
    candidate.bookmakerCount < 5
  ) {
    warnings.push("mało bukmacherów");
  }

  if (candidate.valueEdge >= 3) {
    signals.push("dodatnie value");
  } else if (candidate.valueEdge < 0) {
    warnings.push("value poniżej rynku");
  }

  const form = extractFormFromObject(detail);

  if (form?.home || form?.away) {
    signals.push("dostępna forma zespołów");
  }

  if (h2h) {
    signals.push("dostępne H2H");
  }

  if (lineups) {
    signals.push("dostępne dane o składach");
  }

  /*
   * Do not invent referee information.
   */
  const referee =
    detail?.referee ||
    detail?.officials?.referee ||
    null;

  if (referee) {
    signals.push("dostępny sędzia");
  }

  return {
    signals,
    warnings,
    referee: referee
      ? {
          id: referee.id ?? null,
          name: referee.name ?? null
        }
      : null
  };
}

async function enrichCandidates(candidates) {
  const selected = [...candidates]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 15);

  const results = [];

  for (let i = 0; i < selected.length; i += DETAIL_CONCURRENCY) {
    const batch = selected.slice(
      i,
      i + DETAIL_CONCURRENCY
    );

    const enriched = await Promise.all(
      batch.map(async (candidate) => {
        const eventId = candidate.eventId;

        const detail = await fetchOptional(
          `/events/${eventId}/`
        );

        const lineups = await fetchOptional(
          `/events/${eventId}/lineups/`
        );

        /*
         * H2H endpoint is attempted in the REST form.
         * If unavailable, no data is fabricated.
         */
        const h2h = await fetchOptional(
          `/events/${eventId}/h2h/`
        );

        const supporting = analyzeSupportingData({
          candidate,
          detail,
          lineups,
          h2h
        });

        const extraScore =
          supporting.signals.includes("kurs skraca się")
            ? 1.5
            : 0;

        const penalty =
          supporting.warnings.includes("kurs dryfuje")
            ? 2
            : 0;

        return {
          ...candidate,

          supportingSignals: supporting.signals,

          warnings: [
            ...(candidate.warnings || []),
            ...supporting.warnings
          ],

          referee: supporting.referee,

          hasDetail: Boolean(detail),
          hasLineups: Boolean(lineups),
          hasH2H: Boolean(h2h),

          qualityScore: round(
            candidate.qualityScore +
            extraScore -
            penalty,
            2
          )
        };
      })
    );

    results.push(...enriched);
  }

  return results;
}

/*
|--------------------------------------------------------------------------
| FINAL RANKING
|--------------------------------------------------------------------------
*/

function rankCandidates(candidates) {
  /*
   * One final candidate per event.
   * This prevents the same match from taking multiple positions.
   */
  const bestPerEvent = new Map();

  for (const candidate of candidates) {
    const existing = bestPerEvent.get(candidate.eventId);

    if (
      !existing ||
      candidate.qualityScore > existing.qualityScore
    ) {
      bestPerEvent.set(
        candidate.eventId,
        candidate
      );
    }
  }

  return [...bestPerEvent.values()]
    .sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) {
        return b.qualityScore - a.qualityScore;
      }

      if (b.probability !== a.probability) {
        return b.probability - a.probability;
      }

      return b.valueEdge - a.valueEdge;
    })
    .slice(0, MAX_TOP_PICKS)
    .map((item, index) => ({
      rank: index + 1,
      ...item
    }));
}

/*
|--------------------------------------------------------------------------
| ANALYZE
|--------------------------------------------------------------------------
*/

async function analyzeDate(date) {
  const started = Date.now();

  const eventDiagnostics = [];
  const predictionDiagnostics = [];

  const events = await getEventsForDate(
    date,
    eventDiagnostics
  );

  const {
    map: predictionMap,
    total: predictionsTotal,
    parsed: predictionsParsed
  } = await getAllPredictions(
    predictionDiagnostics
  );

  const upcomingEvents = events.filter(
    isUpcomingEvent
  );

  const eventsToAnalyze =
    upcomingEvents.slice(
      0,
      MAX_EVENTS_TO_ANALYZE
    );

  const analysis = [];

  const allCandidates = [];

  for (const event of eventsToAnalyze) {
    const eventId = getEventId(event);

    if (!eventId) continue;

    const prediction =
      predictionMap.get(eventId) || null;

    const odds = await getOdds(eventId);

    const candidates = buildCandidates(
      event,
      prediction,
      odds
    );

    analysis.push({
      eventId,

      home: getHomeName(event),
      away: getAwayName(event),

      eventDate: getEventDate(event),

      status:
        event.status ||
        event.state ||
        event.match_status ||
        "unknown",

      predictionAvailable: Boolean(prediction),
      prediction,

      oddsAvailable:
        Boolean(
          odds.home ||
          odds.draw ||
          odds.away ||
          odds.dc1x ||
          odds.dcx2 ||
          odds.dc12 ||
          odds.over15 ||
          odds.over25 ||
          odds.over35 ||
          odds.bttsYes
        ),

      odds: {
        home: odds.home?.odds ?? null,
        draw: odds.draw?.odds ?? null,
        away: odds.away?.odds ?? null,

        doubleChance1X:
          odds.dc1x?.odds ?? null,

        doubleChanceX2:
          odds.dcx2?.odds ?? null,

        doubleChance12:
          odds.dc12?.odds ?? null,

        over15: odds.over15?.odds ?? null,
        over25: odds.over25?.odds ?? null,
        over35: odds.over35?.odds ?? null,

        bttsYes: odds.bttsYes?.odds ?? null,

        rowsCount: odds.rowsCount,
        rawCount: odds.rawCount
      },

      candidates
    });

    allCandidates.push(...candidates);
  }

  /*
   * Enrich only the best preliminary candidates.
   */
  const enrichedCandidates =
    await enrichCandidates(
      allCandidates
    );

  const topPicks =
    rankCandidates(
      enrichedCandidates
    );

  const processingMs =
    Date.now() - started;

  return {
    version: VERSION,
    source: SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      message:
        "Betting exchange data is not connected. No exchange movement is fabricated."
    },

    eventsReturned: events.length,

    upcomingEvents:
      upcomingEvents.length,

    eventsAnalyzed:
      eventsToAnalyze.length,

    eventsExcluded:
      Math.max(
        0,
        events.length -
        upcomingEvents.length
      ),

    predictionsTotal,
    predictionsParsed,

    qualificationCount:
      allCandidates.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    thresholds: {
      minProbability:
        MIN_PROBABILITY,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      minCandidateValueEdge:
        `${MIN_CANDIDATE_VALUE_EDGE}%`,

      maxEventsAnalyzed:
        MAX_EVENTS_TO_ANALYZE
    },

    predictionDiagnostics,

    eventDiagnostics,

    topPicks,

    analysis
  };
}

/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    message: "Backend is running."
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    const date =
      req.query.date ||
      isoDateOnly(new Date());

    const result =
      await analyzeDate(date);

    res.json(result);
  } catch (error) {
    console.error("ANALYZE ERROR:", error);

    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      status: "error",
      message:
        error?.message ||
        "Analysis failed."
    });
  }
});

/*
|--------------------------------------------------------------------------
| DEBUG ODDS
|--------------------------------------------------------------------------
*/

app.get("/api/debug-odds", async (req, res) => {
  try {
    const eventId =
      safeNumber(req.query.eventId);

    if (!eventId) {
      return res.status(400).json({
        error: "eventId is required"
      });
    }

    const diagnostics = [];

    const rows = await fetchAllPages(
      `/odds/?event_id=${eventId}`,
      {
        limit: 200,
        maxPages: 10,
        diagnostics
      }
    );

    res.json({
      version: VERSION,
      eventId,
      status: 200,
      count: rows.length,
      diagnostics,
      firstRows: rows.slice(0, 30)
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      error:
        error?.message ||
        "debug odds failed"
    });
  }
});

/*
|--------------------------------------------------------------------------
| DEBUG PREDICTIONS
|--------------------------------------------------------------------------
*/

app.get("/api/debug-predictions", async (req, res) => {
  try {
    const diagnostics = [];

    const result =
      await getAllPredictions(
        diagnostics
      );

    res.json({
      version: VERSION,

      count: result.total,

      parsed:
        result.parsed,

      diagnostics,

      sample:
        [...result.map.values()]
          .slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      error:
        error?.message ||
        "debug predictions failed"
    });
  }
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
