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

const VERSION = "6.5.9";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

const FILTERS = {
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -8,
  minimumOddsForHighProbability: 1.2,

  strongProbabilityMin: 70,
  strongProbabilityScoreMin: 60,
  strongProbabilityValueMin: -3,

  valueScoreMin: 35,
  valueProbabilityMin: 55,
  valuePercentMin: 5,
};

if (!BSD_API_KEY) {
  console.error("Missing BSD_API_KEY");
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function num(v) {
  if (v === null || v === undefined || v === "") return null;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  if (n === null) return null;

  if (Math.abs(n) <= 1) return n * 100;
  return n;
}

function normalizeText(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }

  return null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   BSD REQUEST
========================================================= */

async function bsdFetch(path) {
  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json",
    },
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    url,
    payload,
  };
}

/* =========================================================
   GENERIC PAGINATION
========================================================= */

function extractResults(payload) {
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

  if (payload.data && Array.isArray(payload.data.data)) {
    return payload.data.data;
  }

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  return [];
}

/* =========================================================
   EVENT NAME
========================================================= */

function getTeamName(team) {
  if (!team) return null;

  if (typeof team === "string") return team;

  return firstDefined(
    team.name,
    team.team_name,
    team.display_name,
    team.short_name,
    team.title,
    team.label
  );
}

function getEventHome(event) {
  return firstDefined(
    getTeamName(event.home_team),
    getTeamName(event.home),
    event.home_name,
    event.homeTeamName,
    event.homeTeam,
    event.team_home,
    event.homeTeamName
  );
}

function getEventAway(event) {
  return firstDefined(
    getTeamName(event.away_team),
    getTeamName(event.away),
    event.away_name,
    event.awayTeamName,
    event.awayTeam,
    event.team_away,
    event.awayTeamName
  );
}

function getEventId(event) {
  return firstDefined(
    event.id,
    event.event_id,
    event.eventId,
    event.match_id,
    event.matchId
  );
}

/* =========================================================
   STATUS — FIX 6.5.9
========================================================= */

function normalizeStatus(status) {
  return normalizeText(status)
    .replace(/\s+/g, "_");
}

function isUpcomingStatus(status) {
  if (status === null || status === undefined) return false;

  const s = normalizeStatus(status);

  const upcoming = new Set([
    "upcoming",
    "not_started",
    "notstarted",
    "scheduled",
    "pre_match",
    "prematch",
    "fixture",
    "pending",
    "ns",
    "created",
    "waiting",
  ]);

  const excluded = new Set([
    "finished",
    "completed",
    "ended",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "suspended",
    "live",
    "in_play",
    "inplay",
    "playing",
    "halftime",
    "half_time",
  ]);

  if (excluded.has(s)) return false;
  if (upcoming.has(s)) return true;

  /*
    BSD sometimes exposes a numeric/status-like value.
    We deliberately do NOT treat unknown values as upcoming.
    If there is a future date, getEventIsUpcoming() below
    can still accept the event.
  */

  return false;
}

function getEventStatus(event) {
  return firstDefined(
    event.status,
    event.event_status,
    event.eventStatus,
    event.match_status,
    event.matchStatus,
    event.state
  );
}

function getEventDate(event) {
  return firstDefined(
    event.date,
    event.datetime,
    event.date_time,
    event.dateTime,
    event.start_time,
    event.startTime,
    event.kickoff,
    event.kickoff_time,
    event.kickoffTime,
    event.start
  );
}

function getEventIsUpcoming(event) {
  const status = getEventStatus(event);

  /*
    First respect explicit terminal/live statuses.
  */
  const normalized = normalizeStatus(status);

  const definitelyExcluded = new Set([
    "finished",
    "completed",
    "ended",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "suspended",
    "live",
    "in_play",
    "inplay",
    "playing",
    "halftime",
    "half_time",
  ]);

  if (definitelyExcluded.has(normalized)) {
    return false;
  }

  /*
    If BSD gives a recognized upcoming status, accept it.
  */
  if (isUpcomingStatus(status)) {
    return true;
  }

  /*
    Main 6.5.9 fallback:
    BSD responses may use "notstarted" or another non-terminal
    status while still providing a future kickoff.
  */
  const date = getEventDate(event);

  if (date) {
    const timestamp = Date.parse(date);

    if (Number.isFinite(timestamp)) {
      return timestamp > Date.now();
    }
  }

  return false;
}

/* =========================================================
   EVENTS
========================================================= */

async function getEvents(date) {
  const diagnostics = [];

  const paths = [
    `/events/?date=${encodeURIComponent(date)}&limit=50`,
    `/events/?date=${encodeURIComponent(date)}`,
    `/events/?limit=100`,
  ];

  let allEvents = [];

  for (const path of paths) {
    const result = await bsdFetch(path);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: extractResults(result.payload).length,
    });

    if (result.ok) {
      const rows = extractResults(result.payload);

      if (rows.length) {
        allEvents = rows;
        break;
      }
    }
  }

  /*
    Remove duplicates.
  */
  const seen = new Set();

  const unique = allEvents.filter((event) => {
    const id = getEventId(event);

    if (id === null) return true;

    const key = String(id);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  return {
    events: unique,
    diagnostics,
  };
}

/* =========================================================
   PREDICTIONS
========================================================= */

function getPredictionNumber(obj, keys) {
  for (const key of keys) {
    const value = num(obj?.[key]);

    if (value !== null) return value;
  }

  return null;
}

function parsePredictionRow(row) {
  if (!row || typeof row !== "object") return null;

  const markets =
    row.markets ||
    row.prediction_markets ||
    row.predictions ||
    row.data ||
    {};

  const source = {
    ...row,
    ...markets,
  };

  const home = pct(
    getPredictionNumber(source, [
      "home",
      "home_probability",
      "homeProbability",
      "prob_home",
      "home_win",
      "homeWin",
      "1",
    ])
  );

  const draw = pct(
    getPredictionNumber(source, [
      "draw",
      "draw_probability",
      "drawProbability",
      "prob_draw",
      "x",
    ])
  );

  const away = pct(
    getPredictionNumber(source, [
      "away",
      "away_probability",
      "awayProbability",
      "prob_away",
      "away_win",
      "awayWin",
      "2",
    ])
  );

  const over15 = pct(
    getPredictionNumber(source, [
      "over15",
      "over_15",
      "over_1_5",
      "over15_probability",
      "over_1_5_probability",
    ])
  );

  const over25 = pct(
    getPredictionNumber(source, [
      "over25",
      "over_25",
      "over_2_5",
      "over25_probability",
      "over_2_5_probability",
    ])
  );

  const over35 = pct(
    getPredictionNumber(source, [
      "over35",
      "over_35",
      "over_3_5",
      "over35_probability",
      "over_3_5_probability",
    ])
  );

  const btts = pct(
    getPredictionNumber(source, [
      "btts",
      "btts_yes",
      "bttsYes",
      "both_teams_to_score",
      "btts_probability",
    ])
  );

  const xgHome = num(
    firstDefined(
      source.xg_home,
      source.xG_home,
      source.home_xg,
      source.homeXG,
      source.expected_goals_home
    )
  );

  const xgAway = num(
    firstDefined(
      source.xg_away,
      source.xG_away,
      source.away_xg,
      source.awayXG,
      source.expected_goals_away
    )
  );

  const confidence = pct(
    firstDefined(
      source.confidence,
      source.prediction_confidence,
      source.model_confidence
    )
  );

  const predicted = firstDefined(
    source.predicted_result,
    source.prediction,
    source.result,
    source.winner
  );

  const score = firstDefined(
    source.predicted_score,
    source.score,
    source.correct_score
  );

  const available =
    home !== null ||
    draw !== null ||
    away !== null ||
    over15 !== null ||
    over25 !== null ||
    over35 !== null ||
    btts !== null;

  if (!available) return null;

  return {
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    btts,
    xGHome: xgHome,
    xGAway: xgAway,
    confidence,
    predicted,
    score,
  };
}

function findPredictionRows(payload) {
  const rows = extractResults(payload);

  if (rows.length) return rows;

  if (payload && typeof payload === "object") {
    const candidates = [
      payload.predictions,
      payload.data,
      payload.results,
      payload.items,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
  }

  return [];
}

async function getPredictions() {
  const diagnostics = [];

  const paths = [
    `/predictions/?upcoming=true&limit=200`,
    `/predictions/?limit=200`,
  ];

  let rows = [];

  for (const path of paths) {
    const result = await bsdFetch(path);

    const extracted = findPredictionRows(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: extracted.length,
    });

    if (result.ok && extracted.length) {
      rows = extracted;
      break;
    }
  }

  const byEvent = new Map();

  for (const row of rows) {
    const eventId = firstDefined(
      row.event_id,
      row.eventId,
      row.match_id,
      row.matchId,
      row.event?.id,
      row.match?.id
    );

    if (eventId === null) continue;

    const parsed = parsePredictionRow(row);

    if (!parsed) continue;

    byEvent.set(String(eventId), parsed);
  }

  return {
    byEvent,
    diagnostics,
    count: rows.length,
  };
}

/* =========================================================
   ODDS
========================================================= */

function walkObject(value, callback, path = "") {
  if (value === null || value === undefined) return;

  callback(value, path);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkObject(item, callback, `${path}[${index}]`);
    });

    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkObject(
        child,
        callback,
        path ? `${path}.${key}` : key
      );
    }
  }
}

function getPriceFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  const direct = [
    "odds",
    "odd",
    "price",
    "value",
    "decimal",
    "decimal_odds",
    "decimalOdds",
    "current_odds",
    "currentOdds",
    "current_price",
    "currentPrice",
    "selection_odds",
    "selectionOdds",
  ];

  for (const key of direct) {
    const n = num(obj[key]);

    if (n !== null && n >= 1.001 && n <= 1000) {
      return n;
    }
  }

  if (obj.prices && typeof obj.prices === "object") {
    for (const value of Object.values(obj.prices)) {
      const n = num(value);

      if (n !== null && n >= 1.001 && n <= 1000) {
        return n;
      }

      if (value && typeof value === "object") {
        const nested = getPriceFromObject(value);

        if (nested !== null) return nested;
      }
    }
  }

  return null;
}

function marketContext(obj) {
  if (!obj || typeof obj !== "object") return "";

  const keys = [
    "market",
    "market_name",
    "marketName",
    "market_code",
    "marketCode",
    "market_type",
    "marketType",
    "market_kind",
    "marketKind",
    "market_family",
    "marketFamily",
    "market_line",
    "marketLine",
    "market_period",
    "marketPeriod",
    "selection",
    "selection_name",
    "selectionName",
    "selection_code",
    "selectionCode",
    "outcome",
    "outcome_name",
    "outcomeName",
    "label",
    "name",
    "code",
    "type",
    "key",
  ];

  return keys
    .map((key) => obj[key])
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v))
    .join(" | ")
    .toLowerCase();
}

function classifyOddObject(obj) {
  const context = marketContext(obj);
  const price = getPriceFromObject(obj);

  if (price === null) return null;

  const normalized = context
    .replace(/_/g, " ")
    .replace(/-/g, " ");

  /*
    1X2
  */
  if (
    normalized.includes("1x2 home") ||
    normalized.includes("home win") ||
    normalized.includes("1x2_home_ft") ||
    normalized === "home"
  ) {
    return { market: "home", price };
  }

  if (
    normalized.includes("1x2 draw") ||
    normalized.includes("draw") ||
    normalized.includes("1x2_draw_ft")
  ) {
    return { market: "draw", price };
  }

  if (
    normalized.includes("1x2 away") ||
    normalized.includes("away win") ||
    normalized.includes("1x2_away_ft") ||
    normalized === "away"
  ) {
    return { market: "away", price };
  }

  /*
    OVER
  */
  if (
    normalized.includes("over 1.5") ||
    normalized.includes("over1.5") ||
    normalized.includes("over 15") ||
    normalized.includes("ou 1.5 over")
  ) {
    return { market: "over15", price };
  }

  if (
    normalized.includes("over 2.5") ||
    normalized.includes("over2.5") ||
    normalized.includes("over 25") ||
    normalized.includes("ou 2.5 over")
  ) {
    return { market: "over25", price };
  }

  if (
    normalized.includes("over 3.5") ||
    normalized.includes("over3.5") ||
    normalized.includes("over 35") ||
    normalized.includes("ou 3.5 over")
  ) {
    return { market: "over35", price };
  }

  /*
    BTTS
  */
  if (
    normalized.includes("btts yes") ||
    normalized.includes("both teams to score yes") ||
    normalized.includes("btts_yes_ft")
  ) {
    return { market: "btts", price };
  }

  return null;
}

function parseOdds(payload) {
  const odds = {
    home: null,
    draw: null,
    away: null,
    over15: null,
    over25: null,
    over35: null,
    btts: null,
  };

  const timestamps = [];
  const bookmakers = [];
  const movementByMarket = {};

  walkObject(payload, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }

    const classified = classifyOddObject(value);

    if (classified) {
      if (
        odds[classified.market] === null ||
        classified.price < odds[classified.market]
      ) {
        odds[classified.market] = classified.price;
      }
    }

    const timestamp = firstDefined(
      value.timestamp,
      value.created_at,
      value.createdAt,
      value.updated_at,
      value.updatedAt,
      value.time
    );

    if (timestamp) {
      timestamps.push(timestamp);
    }

    const bookmaker = firstDefined(
      value.bookmaker,
      value.bookmaker_name,
      value.bookmakerName,
      value.provider,
      value.source
    );

    if (bookmaker) {
      bookmakers.push(String(bookmaker));
    }
  });

  /*
    Flattened fallback.
  */
  const textValues = [];

  walkObject(payload, (value, path) => {
    if (typeof value === "string" || typeof value === "number") {
      textValues.push({
        path: String(path).toLowerCase(),
        value,
      });
    }
  });

  for (const item of textValues) {
    const path = item.path;
    const value = num(item.value);

    if (value === null || value < 1.001 || value > 1000) {
      continue;
    }

    if (
      odds.home === null &&
      (path.includes("home") ||
        path.includes("1x2_home_ft"))
    ) {
      odds.home = value;
    }

    if (
      odds.draw === null &&
      (path.includes("draw") ||
        path.includes("1x2_draw_ft"))
    ) {
      odds.draw = value;
    }

    if (
      odds.away === null &&
      (path.includes("away") ||
        path.includes("1x2_away_ft"))
    ) {
      odds.away = value;
    }

    if (
      odds.over15 === null &&
      (path.includes("over_1_5") ||
        path.includes("over1.5") ||
        path.includes("over15"))
    ) {
      odds.over15 = value;
    }

    if (
      odds.over25 === null &&
      (path.includes("over_2_5") ||
        path.includes("over2.5") ||
        path.includes("over25"))
    ) {
      odds.over25 = value;
    }

    if (
      odds.over35 === null &&
      (path.includes("over_3_5") ||
        path.includes("over3.5") ||
        path.includes("over35"))
    ) {
      odds.over35 = value;
    }

    if (
      odds.btts === null &&
      (path.includes("btts_yes") ||
        path.includes("bttsyes"))
    ) {
      odds.btts = value;
    }
  }

  const parsedMarkets = Object.entries(odds)
    .filter(([, value]) => value !== null)
    .map(([market]) => market);

  return {
    odds,
    available: parsedMarkets.length > 0,
    parsedMarkets,
    timestamps: [...new Set(timestamps)].slice(0, 10),
    bookmakers: [...new Set(bookmakers)].slice(0, 20),
    movementByMarket,
  };
}

async function getOdds(eventId) {
  const diagnostics = [];

  const paths = [
    `/odds/?event_id=${encodeURIComponent(eventId)}`,
    `/odds/?event=${encodeURIComponent(eventId)}`,
    `/odds/${encodeURIComponent(eventId)}/`,
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    const rows = extractResults(result.payload);

    const parsed = parseOdds(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: rows.length,
      parsed: parsed.available,
      parsedMarkets: parsed.parsedMarkets,
      parsedBookmakers: parsed.bookmakers,
    });

    if (result.ok && parsed.available) {
      return {
        ...parsed,
        diagnostics,
      };
    }
  }

  return {
    odds: {
      home: null,
      draw: null,
      away: null,
      over15: null,
      over25: null,
      over35: null,
      btts: null,
    },
    available: false,
    parsedMarkets: [],
    parsedBookmakers: [],
    movementByMarket: {},
    diagnostics,
  };
}

/* =========================================================
   VALUE / SCORE
========================================================= */

function impliedProbability(odds) {
  if (!odds || odds <= 1) return null;
  return 100 / odds;
}

function valuePercent(probability, odds) {
  if (probability === null || odds === null) return null;

  const implied = impliedProbability(odds);

  if (implied === null) return null;

  return probability - implied;
}

function probabilityScore(probability) {
  if (probability === null) return 0;

  return clamp(probability, 0, 100);
}

function calculateMarketScore(probability, odds) {
  if (probability === null || odds === null) return null;

  const value = valuePercent(probability, odds);

  if (value === null) return null;

  /*
    Probability is deliberately the dominant component.
  */
  const score =
    probability * 0.65 +
    clamp(value + 10, 0, 30) * 1.15;

  return Math.round(clamp(score, 0, 100) * 10) / 10;
}

/* =========================================================
   PREDICTION MARKET CANDIDATES
========================================================= */

function buildCandidates(prediction, odds) {
  if (!prediction || !odds) return [];

  const candidates = [];

  const add = (name, market, probability) => {
    const price = odds[market];

    if (probability === null || price === null) return;

    const value = valuePercent(probability, price);
    const score = calculateMarketScore(probability, price);

    if (value === null || score === null) return;

    candidates.push({
      name,
      market,
      probability,
      odds: price,
      valuePercent: Math.round(value * 100) / 100,
      score,
    });
  };

  add("Home", "home", prediction.home);
  add("Draw", "draw", prediction.draw);
  add("Away", "away", prediction.away);

  add("Over 1.5", "over15", prediction.over15);
  add("Over 2.5", "over25", prediction.over25);
  add("Over 3.5", "over35", prediction.over35);

  add("BTTS Yes", "btts", prediction.btts);

  return candidates;
}

/* =========================================================
   QUALIFICATION
========================================================= */

function qualifyCandidate(candidate) {
  if (!candidate) return null;

  const p = candidate.probability;
  const score = candidate.score;
  const value = candidate.valuePercent;
  const odds = candidate.odds;

  /*
    HIGH PROBABILITY
  */
  if (
    p >= FILTERS.highProbabilityMin &&
    score >= FILTERS.highProbabilityScoreMin &&
    value >= FILTERS.highProbabilityValueMin &&
    odds >= FILTERS.minimumOddsForHighProbability
  ) {
    return {
      ...candidate,
      category: "HIGH_PROBABILITY",
    };
  }

  /*
    STRONG
  */
  if (
    p >= FILTERS.strongProbabilityMin &&
    score >= FILTERS.strongProbabilityScoreMin &&
    value >= FILTERS.strongProbabilityValueMin
  ) {
    return {
      ...candidate,
      category: "STRONG",
    };
  }

  /*
    VALUE
  */
  if (
    score >= FILTERS.valueScoreMin &&
    p >= FILTERS.valueProbabilityMin &&
    value >= FILTERS.valuePercentMin
  ) {
    return {
      ...candidate,
      category: "VALUE",
    };
  }

  return null;
}

/* =========================================================
   ANALYZE EVENT
========================================================= */

async function analyzeEvent(event, prediction) {
  const eventId = getEventId(event);

  const oddsData = await getOdds(eventId);

  const candidates = buildCandidates(
    prediction,
    oddsData.odds
  );

  const qualified = candidates
    .map(qualifyCandidate)
    .filter(Boolean)
    .sort((a, b) => {
      if (b.probability !== a.probability) {
        return b.probability - a.probability;
      }

      return b.score - a.score;
    });

  return {
    eventId,
    event: `${getEventHome(event) || "Home"} – ${
      getEventAway(event) || "Away"
    }`,
    date: getEventDate(event),
    status: getEventStatus(event),

    predictionAvailable: !!prediction,
    prediction: prediction || null,

    oddsAvailable: oddsData.available,
    odds: oddsData.available ? oddsData.odds : null,

    oddsDebug: {
      parsed: oddsData.available,
      parsedMarkets: oddsData.parsedMarkets,
      parsedBookmakers: oddsData.parsedBookmakers,
      diagnostics: oddsData.diagnostics,
    },

    candidates,
    qualified,
  };
}

/* =========================================================
   TOP PICKS
========================================================= */

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const eventData = await getEvents(date);

    const events = eventData.events;

    /*
      6.5.9:
      Status is no longer assumed to be literally "upcoming".
      Future kickoff + non-terminal status is accepted.
    */
    const upcoming = events.filter(getEventIsUpcoming);

    /*
      Analyze maximum 10 upcoming events.
    */
    const eventsToAnalyze = upcoming.slice(0, 10);

    const predictionData = await getPredictions();

    const analyzed = [];

    for (const event of eventsToAnalyze) {
      const eventId = getEventId(event);

      const prediction =
        predictionData.byEvent.get(String(eventId)) || null;

      const result = await analyzeEvent(
        event,
        prediction
      );

      analyzed.push(result);
    }

    const allQualified = analyzed
      .flatMap((event) =>
        event.qualified.map((pick) => ({
          ...pick,
          eventId: event.eventId,
          event: event.event,
          date: event.date,
          prediction: event.prediction,
          odds: event.odds,
        }))
      );

    /*
      No artificial filling.
      If only 2 picks qualify, return 2.
      If none qualify, return [].
    */
    const picks = allQualified
      .sort((a, b) => {
        if (b.probability !== a.probability) {
          return b.probability - a.probability;
        }

        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return b.valuePercent - a.valuePercent;
      })
      .slice(0, MAX_TOP_PICKS);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,

      eventsReturned: events.length,
      upcomingEvents: upcoming.length,
      eventsAnalyzed: analyzed.length,
      eventsExcluded: events.length - upcoming.length,

      qualificationCount: allQualified.length,
      maxTopPicks: MAX_TOP_PICKS,

      filters: FILTERS,

      exchange: {
        connected: false,
        status: "NOT_CONNECTED",
        note: "No exchange signal is fabricated.",
      },

      picks,

      analyzed,

      diagnostics: {
        eventStatus: eventData.diagnostics,
        predictionDebug: predictionData.diagnostics,
        predictionCount: predictionData.count,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      error: "Internal server error",
      message: error?.message || String(error),
    });
  }
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE,
    exchange: "NOT_CONNECTED",
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
