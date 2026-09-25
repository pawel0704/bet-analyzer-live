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

const VERSION = "6.6.0";
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
   HELPERS
========================================================= */

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const n = Number(String(value).replace(",", "."));

  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = num(value);

  if (n === null) return null;

  if (Math.abs(n) <= 1) {
    return n * 100;
  }

  return n;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
   GENERIC RESULT EXTRACTION
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

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  if (Array.isArray(payload.predictions)) {
    return payload.predictions;
  }

  return [];
}

/* =========================================================
   EVENT DATA
========================================================= */

function getTeamName(team) {
  if (!team) return null;

  if (typeof team === "string") {
    return team;
  }

  return firstDefined(
    team.name,
    team.team_name,
    team.teamName,
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
    event.home_team_name,
    event.homeTeam,
    event.team_home
  );
}

function getEventAway(event) {
  return firstDefined(
    getTeamName(event.away_team),
    getTeamName(event.away),
    event.away_name,
    event.awayTeamName,
    event.away_team_name,
    event.awayTeam,
    event.team_away
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

/* =========================================================
   UPCOMING FILTER
========================================================= */

function normalizeStatus(status) {
  return normalizeText(status).replace(/\s+/g, "_");
}

function getEventIsUpcoming(event) {
  const status = normalizeStatus(getEventStatus(event));

  const terminal = new Set([
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

  if (terminal.has(status)) {
    return false;
  }

  const explicitUpcoming = new Set([
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

  if (explicitUpcoming.has(status)) {
    return true;
  }

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
  ];

  let events = [];

  for (const path of paths) {
    const result = await bsdFetch(path);

    const rows = extractResults(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: rows.length,
    });

    if (result.ok && rows.length) {
      events = rows;
      break;
    }
  }

  const seen = new Set();

  events = events.filter((event) => {
    const id = getEventId(event);

    if (id === null) return true;

    const key = String(id);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  return {
    events,
    diagnostics,
  };
}

/* =========================================================
   PREDICTION PARSING
========================================================= */

function getPredictionValue(source, keys) {
  for (const key of keys) {
    const value = num(source?.[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function getNestedObject(row) {
  const candidates = [
    row.markets,
    row.prediction_markets,
    row.predictions,
    row.data,
    row.prediction,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate;
    }
  }

  return {};
}

function parsePredictionRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const nested = getNestedObject(row);

  const source = {
    ...row,
    ...nested,
  };

  const home = pct(
    getPredictionValue(source, [
      "home",
      "home_probability",
      "homeProbability",
      "prob_home",
      "home_win",
      "homeWin",
      "probability_home",
      "p_home",
      "1",
    ])
  );

  const draw = pct(
    getPredictionValue(source, [
      "draw",
      "draw_probability",
      "drawProbability",
      "prob_draw",
      "probability_draw",
      "p_draw",
      "x",
    ])
  );

  const away = pct(
    getPredictionValue(source, [
      "away",
      "away_probability",
      "awayProbability",
      "prob_away",
      "away_win",
      "awayWin",
      "probability_away",
      "p_away",
      "2",
    ])
  );

  const over15 = pct(
    getPredictionValue(source, [
      "over15",
      "over_15",
      "over_1_5",
      "over15_probability",
      "over_1_5_probability",
      "over_15_probability",
    ])
  );

  const over25 = pct(
    getPredictionValue(source, [
      "over25",
      "over_25",
      "over_2_5",
      "over25_probability",
      "over_2_5_probability",
      "over_25_probability",
    ])
  );

  const over35 = pct(
    getPredictionValue(source, [
      "over35",
      "over_35",
      "over_3_5",
      "over35_probability",
      "over_3_5_probability",
      "over_35_probability",
    ])
  );

  const btts = pct(
    getPredictionValue(source, [
      "btts",
      "btts_yes",
      "bttsYes",
      "both_teams_to_score",
      "btts_probability",
      "btts_yes_probability",
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

  const confidenceRaw = firstDefined(
    source.confidence,
    source.prediction_confidence,
    source.model_confidence
  );

  const confidence = pct(confidenceRaw);

  const predicted = firstDefined(
    source.predicted_result,
    source.predictedResult,
    source.prediction,
    source.result,
    source.winner
  );

  const score = firstDefined(
    source.predicted_score,
    source.predictedScore,
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

  if (!available) {
    return null;
  }

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

/* =========================================================
   PREDICTION IDENTIFICATION
========================================================= */

function getPredictionEventId(row) {
  return firstDefined(
    row.event_id,
    row.eventId,
    row.match_id,
    row.matchId,
    row.event?.id,
    row.event?.event_id,
    row.match?.id,
    row.match?.event_id
  );
}

function getPredictionHome(row) {
  return firstDefined(
    getTeamName(row.home_team),
    getTeamName(row.home),
    row.home_name,
    row.home_team_name,
    row.homeTeamName,
    getTeamName(row.event?.home_team),
    getTeamName(row.event?.home),
    row.event?.home_name,
    row.event?.home_team_name,
    getTeamName(row.match?.home_team),
    row.match?.home_name
  );
}

function getPredictionAway(row) {
  return firstDefined(
    getTeamName(row.away_team),
    getTeamName(row.away),
    row.away_name,
    row.away_team_name,
    row.awayTeamName,
    getTeamName(row.event?.away_team),
    getTeamName(row.event?.away),
    row.event?.away_name,
    row.event?.away_team_name,
    getTeamName(row.match?.away_team),
    row.match?.away_name
  );
}

function teamSimilarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);

  if (!x || !y) return 0;

  if (x === y) return 1;

  if (x.includes(y) || y.includes(x)) {
    return 0.9;
  }

  const xParts = new Set(x.split(" "));
  const yParts = new Set(y.split(" "));

  const intersection = [...xParts].filter((part) =>
    yParts.has(part)
  );

  if (!intersection.length) {
    return 0;
  }

  return (
    intersection.length /
    Math.max(xParts.size, yParts.size)
  );
}

function predictionMatchesEvent(row, event) {
  const eventId = getEventId(event);
  const predictionId = getPredictionEventId(row);

  if (
    eventId !== null &&
    predictionId !== null &&
    String(eventId) === String(predictionId)
  ) {
    return true;
  }

  const eventHome = getEventHome(event);
  const eventAway = getEventAway(event);

  const predictionHome = getPredictionHome(row);
  const predictionAway = getPredictionAway(row);

  if (
    !eventHome ||
    !eventAway ||
    !predictionHome ||
    !predictionAway
  ) {
    return false;
  }

  const homeScore = teamSimilarity(
    eventHome,
    predictionHome
  );

  const awayScore = teamSimilarity(
    eventAway,
    predictionAway
  );

  return homeScore >= 0.75 && awayScore >= 0.75;
}

/* =========================================================
   GET PREDICTIONS
========================================================= */

async function getPredictions() {
  const diagnostics = [];

  let allRows = [];

  /*
    BSD uses pagination with limit/offset.
    Pull several pages so that a relevant match is not missed
    simply because it is not in the first 200 rows.
  */
  const offsets = [0, 200, 400, 600, 800];

  for (const offset of offsets) {
    const path =
      `/predictions/?upcoming=true&limit=200&offset=${offset}`;

    const result = await bsdFetch(path);

    const rows = extractResults(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: rows.length,
    });

    if (!result.ok) {
      continue;
    }

    if (!rows.length) {
      break;
    }

    allRows.push(...rows);

    if (rows.length < 200) {
      break;
    }
  }

  /*
    Fallback without upcoming=true.
  */
  if (!allRows.length) {
    const path = `/predictions/?limit=200`;

    const result = await bsdFetch(path);

    const rows = extractResults(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: rows.length,
    });

    allRows = rows;
  }

  const unique = [];
  const seen = new Set();

  for (const row of allRows) {
    const id = getPredictionEventId(row);

    const key =
      id !== null
        ? String(id)
        : JSON.stringify([
            getPredictionHome(row),
            getPredictionAway(row),
          ]);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(row);
  }

  return {
    rows: unique,
    diagnostics,
    count: unique.length,
  };
}

/* =========================================================
   FIND PREDICTION FOR EVENT
========================================================= */

function findPrediction(event, predictionRows) {
  /*
    First try exact event ID.
  */
  const eventId = getEventId(event);

  if (eventId !== null) {
    const exact = predictionRows.find((row) => {
      const predictionId = getPredictionEventId(row);

      return (
        predictionId !== null &&
        String(predictionId) === String(eventId)
      );
    });

    if (exact) {
      return parsePredictionRow(exact);
    }
  }

  /*
    Then match by team names.
  */
  for (const row of predictionRows) {
    if (predictionMatchesEvent(row, event)) {
      const parsed = parsePredictionRow(row);

      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

/* =========================================================
   ODDS
========================================================= */

function validOdds(value) {
  const n = num(value);

  if (n === null) return null;

  if (n < 1.001 || n > 1000) {
    return null;
  }

  return n;
}

/*
  Direct BSD-style consensus object:
  
  odds: {
    match_winner: {
      home,
      draw,
      away
    },
    over_under: {
      over_15,
      under_15,
      over_25,
      under_25,
      over_35,
      under_35
    },
    btts: {
      yes,
      no
    }
  }
*/
function parseStructuredOddsObject(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const result = {
    home: null,
    draw: null,
    away: null,
    over15: null,
    over25: null,
    over35: null,
    btts: null,
  };

  let found = false;

  const matchWinner =
    source.match_winner ||
    source.matchWinner ||
    source["1x2"] ||
    source["1X2"];

  if (
    matchWinner &&
    typeof matchWinner === "object"
  ) {
    const home = validOdds(
      matchWinner.home
    );

    const draw = validOdds(
      matchWinner.draw
    );

    const away = validOdds(
      matchWinner.away
    );

    if (home !== null) {
      result.home = home;
      found = true;
    }

    if (draw !== null) {
      result.draw = draw;
      found = true;
    }

    if (away !== null) {
      result.away = away;
      found = true;
    }
  }

  const overUnder =
    source.over_under ||
    source.overUnder ||
    source.ou ||
    source.OU;

  if (
    overUnder &&
    typeof overUnder === "object"
  ) {
    const over15 = validOdds(
      overUnder.over_15 ??
      overUnder.over15
    );

    const over25 = validOdds(
      overUnder.over_25 ??
      overUnder.over25
    );

    const over35 = validOdds(
      overUnder.over_35 ??
      overUnder.over35
    );

    if (over15 !== null) {
      result.over15 = over15;
      found = true;
    }

    if (over25 !== null) {
      result.over25 = over25;
      found = true;
    }

    if (over35 !== null) {
      result.over35 = over35;
      found = true;
    }
  }

  const btts =
    source.btts ||
    source.BTTS;

  if (
    btts &&
    typeof btts === "object"
  ) {
    const yes = validOdds(btts.yes);

    if (yes !== null) {
      result.btts = yes;
      found = true;
    }
  }

  return found ? result : null;
}

/*
  Some BSD responses expose bookmaker rows such as:

  odds_home
  odds_draw
  odds_away
*/
function parseBookmakerRow(row, target) {
  if (!row || typeof row !== "object") {
    return;
  }

  const home = validOdds(
    row.odds_home ??
    row.home_odds ??
    row.price_home ??
    row.home_price
  );

  const draw = validOdds(
    row.odds_draw ??
    row.draw_odds ??
    row.price_draw ??
    row.draw_price
  );

  const away = validOdds(
    row.odds_away ??
    row.away_odds ??
    row.price_away ??
    row.away_price
  );

  if (home !== null) {
    target.home = target.home === null
      ? home
      : Math.min(target.home, home);
  }

  if (draw !== null) {
    target.draw = target.draw === null
      ? draw
      : Math.min(target.draw, draw);
  }

  if (away !== null) {
    target.away = target.away === null
      ? away
      : Math.min(target.away, away);
  }

  /*
    Flat over/under fields.
  */
  const over15 = validOdds(
    row.over_15 ??
    row.over15 ??
    row.odds_over_15 ??
    row.odds_over15
  );

  const over25 = validOdds(
    row.over_25 ??
    row.over25 ??
    row.odds_over_25 ??
    row.odds_over25
  );

  const over35 = validOdds(
    row.over_35 ??
    row.over35 ??
    row.odds_over_35 ??
    row.odds_over35
  );

  if (over15 !== null) {
    target.over15 = target.over15 === null
      ? over15
      : Math.min(target.over15, over15);
  }

  if (over25 !== null) {
    target.over25 = target.over25 === null
      ? over25
      : Math.min(target.over25, over25);
  }

  if (over35 !== null) {
    target.over35 = target.over35 === null
      ? over35
      : Math.min(target.over35, over35);
  }

  const btts = validOdds(
    row.btts_yes ??
    row.odds_btts_yes ??
    row.yes
  );

  if (btts !== null) {
    target.btts = target.btts === null
      ? btts
      : Math.min(target.btts, btts);
  }
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

  const bookmakers = [];

  /*
    1. Direct consensus object.
  */
  const directSources = [
    payload?.odds,
    payload?.data?.odds,
    payload?.result?.odds,
  ];

  for (const source of directSources) {
    const parsed = parseStructuredOddsObject(source);

    if (parsed) {
      for (const key of Object.keys(odds)) {
        if (parsed[key] !== null) {
          odds[key] = parsed[key];
        }
      }
    }
  }

  /*
    2. Top-level structured fields.
  */
  const topParsed = parseStructuredOddsObject(payload);

  if (topParsed) {
    for (const key of Object.keys(odds)) {
      if (
        odds[key] === null &&
        topParsed[key] !== null
      ) {
        odds[key] = topParsed[key];
      }
    }
  }

  /*
    3. Bookmaker rows.
  */
  const bookmakerRows = [];

  if (Array.isArray(payload?.bookmakers)) {
    bookmakerRows.push(...payload.bookmakers);
  }

  if (Array.isArray(payload?.data?.bookmakers)) {
    bookmakerRows.push(...payload.data.bookmakers);
  }

  for (const row of bookmakerRows) {
    parseBookmakerRow(row, odds);

    const bookmaker = firstDefined(
      row.bookmaker,
      row.bookmaker_name,
      row.bookmakerName,
      row.provider
    );

    if (bookmaker) {
      bookmakers.push(String(bookmaker));
    }
  }

  /*
    4. markets[] structure.
  */
  const markets = [];

  if (Array.isArray(payload?.markets)) {
    markets.push(...payload.markets);
  }

  if (Array.isArray(payload?.data?.markets)) {
    markets.push(...payload.data.markets);
  }

  for (const market of markets) {
    const kind = normalizeText(
      firstDefined(
        market.market_kind,
        market.marketKind,
        market.market_family,
        market.marketFamily,
        market.kind,
        market.type
      )
    );

    const line = String(
      firstDefined(
        market.market_line,
        market.marketLine,
        market.line
      ) ?? ""
    );

    const selections =
      Array.isArray(market.selections)
        ? market.selections
        : [];

    /*
      A market can contain bookmaker rows.
    */
    const rows =
      Array.isArray(market.bookmakers)
        ? market.bookmakers
        : [];

    for (const row of rows) {
      const selection =
        normalizeText(
          firstDefined(
            row.selection,
            row.outcome,
            row.name,
            row.label
          )
        );

      const price = validOdds(
        firstDefined(
          row.odds,
          row.odd,
          row.price,
          row.decimal,
          row.value
        )
      );

      if (price === null) continue;

      if (
        kind.includes("1x2") &&
        selection.includes("home")
      ) {
        odds.home = odds.home === null
          ? price
          : Math.min(odds.home, price);
      }

      if (
        kind.includes("1x2") &&
        selection.includes("draw")
      ) {
        odds.draw = odds.draw === null
          ? price
          : Math.min(odds.draw, price);
      }

      if (
        kind.includes("1x2") &&
        selection.includes("away")
      ) {
        odds.away = odds.away === null
          ? price
          : Math.min(odds.away, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("1.5") &&
        selection.includes("over")
      ) {
        odds.over15 = odds.over15 === null
          ? price
          : Math.min(odds.over15, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("2.5") &&
        selection.includes("over")
      ) {
        odds.over25 = odds.over25 === null
          ? price
          : Math.min(odds.over25, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("3.5") &&
        selection.includes("over")
      ) {
        odds.over35 = odds.over35 === null
          ? price
          : Math.min(odds.over35, price);
      }

      if (
        kind.includes("btts") &&
        selection.includes("yes")
      ) {
        odds.btts = odds.btts === null
          ? price
          : Math.min(odds.btts, price);
      }
    }

    /*
      Alternative market format where selections are
      objects instead of strings.
    */
    for (const selection of selections) {
      if (
        !selection ||
        typeof selection !== "object"
      ) {
        continue;
      }

      const name = normalizeText(
        firstDefined(
          selection.selection,
          selection.outcome,
          selection.name,
          selection.label,
          selection.code
        )
      );

      const price = validOdds(
        firstDefined(
          selection.odds,
          selection.odd,
          selection.price,
          selection.value
        )
      );

      if (price === null) continue;

      if (
        kind.includes("1x2") &&
        name.includes("home")
      ) {
        odds.home = odds.home === null
          ? price
          : Math.min(odds.home, price);
      }

      if (
        kind.includes("1x2") &&
        name.includes("draw")
      ) {
        odds.draw = odds.draw === null
          ? price
          : Math.min(odds.draw, price);
      }

      if (
        kind.includes("1x2") &&
        name.includes("away")
      ) {
        odds.away = odds.away === null
          ? price
          : Math.min(odds.away, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("1.5") &&
        name.includes("over")
      ) {
        odds.over15 = odds.over15 === null
          ? price
          : Math.min(odds.over15, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("2.5") &&
        name.includes("over")
      ) {
        odds.over25 = odds.over25 === null
          ? price
          : Math.min(odds.over25, price);
      }

      if (
        kind.includes("ou") &&
        line.includes("3.5") &&
        name.includes("over")
      ) {
        odds.over35 = odds.over35 === null
          ? price
          : Math.min(odds.over35, price);
      }

      if (
        kind.includes("btts") &&
        name.includes("yes")
      ) {
        odds.btts = odds.btts === null
          ? price
          : Math.min(odds.btts, price);
      }
    }
  }

  const parsedMarkets = Object.entries(odds)
    .filter(([, value]) => value !== null)
    .map(([key]) => key);

  return {
    odds,
    available: parsedMarkets.length > 0,
    parsedMarkets,
    bookmakers: [...new Set(bookmakers)].slice(0, 30),
  };
}

/* =========================================================
   GET ODDS
========================================================= */

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
    bookmakers: [],
    diagnostics,
  };
}

/* =========================================================
   VALUE
========================================================= */

function impliedProbability(odds) {
  if (!odds || odds <= 1) {
    return null;
  }

  return 100 / odds;
}

function valuePercent(probability, odds) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  const implied = impliedProbability(odds);

  if (implied === null) {
    return null;
  }

  return probability - implied;
}

function calculateMarketScore(probability, odds) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  const value = valuePercent(
    probability,
    odds
  );

  if (value === null) {
    return null;
  }

  const score =
    probability * 0.65 +
    clamp(value + 10, 0, 30) * 1.15;

  return Math.round(
    clamp(score, 0, 100) * 10
  ) / 10;
}

/* =========================================================
   CANDIDATES
========================================================= */

function buildCandidates(prediction, odds) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  function add(
    name,
    market,
    probability
  ) {
    const price = odds[market];

    if (
      probability === null ||
      price === null
    ) {
      return;
    }

    const value = valuePercent(
      probability,
      price
    );

    const score = calculateMarketScore(
      probability,
      price
    );

    if (
      value === null ||
      score === null
    ) {
      return;
    }

    candidates.push({
      name,
      market,
      probability,
      odds: price,
      valuePercent:
        Math.round(value * 100) / 100,
      score,
    });
  }

  add(
    "Home",
    "home",
    prediction.home
  );

  add(
    "Draw",
    "draw",
    prediction.draw
  );

  add(
    "Away",
    "away",
    prediction.away
  );

  add(
    "Over 1.5",
    "over15",
    prediction.over15
  );

  add(
    "Over 2.5",
    "over25",
    prediction.over25
  );

  add(
    "Over 3.5",
    "over35",
    prediction.over35
  );

  add(
    "BTTS Yes",
    "btts",
    prediction.btts
  );

  return candidates;
}

/* =========================================================
   QUALIFICATION
========================================================= */

function qualifyCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const p = candidate.probability;
  const score = candidate.score;
  const value = candidate.valuePercent;
  const odds = candidate.odds;

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

async function analyzeEvent(
  event,
  prediction
) {
  const eventId = getEventId(event);

  const oddsData =
    await getOdds(eventId);

  const candidates =
    buildCandidates(
      prediction,
      oddsData.odds
    );

  const qualified =
    candidates
      .map(qualifyCandidate)
      .filter(Boolean)
      .sort((a, b) => {
        if (
          b.probability !==
          a.probability
        ) {
          return (
            b.probability -
            a.probability
          );
        }

        return b.score - a.score;
      });

  return {
    eventId,

    event:
      `${getEventHome(event) || "Home"} – ` +
      `${getEventAway(event) || "Away"}`,

    date:
      getEventDate(event),

    status:
      getEventStatus(event),

    predictionAvailable:
      !!prediction,

    prediction:
      prediction || null,

    oddsAvailable:
      oddsData.available,

    odds:
      oddsData.available
        ? oddsData.odds
        : null,

    oddsDebug: {
      parsed:
        oddsData.available,

      parsedMarkets:
        oddsData.parsedMarkets,

      parsedBookmakers:
        oddsData.bookmakers,

      diagnostics:
        oddsData.diagnostics,
    },

    candidates,

    qualified,
  };
}

/* =========================================================
   TOP PICKS
========================================================= */

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const eventData =
        await getEvents(date);

      const events =
        eventData.events;

      const upcoming =
        events.filter(
          getEventIsUpcoming
        );

      /*
        Keep analysis manageable.
        Maximum 10 events are inspected,
        then maximum 5 picks are returned.
      */
      const eventsToAnalyze =
        upcoming.slice(0, 10);

      const predictionData =
        await getPredictions();

      const analyzed = [];

      for (
        const event of eventsToAnalyze
      ) {
        const prediction =
          findPrediction(
            event,
            predictionData.rows
          );

        const result =
          await analyzeEvent(
            event,
            prediction
          );

        analyzed.push(result);
      }

      const allQualified =
        analyzed.flatMap(
          (event) =>
            event.qualified.map(
              (pick) => ({
                ...pick,
                eventId:
                  event.eventId,
                event:
                  event.event,
                date:
                  event.date,
                prediction:
                  event.prediction,
                odds:
                  event.odds,
              })
            )
        );

      /*
        No artificial filling.
      */
      const picks =
        allQualified
          .sort((a, b) => {
            if (
              b.probability !==
              a.probability
            ) {
              return (
                b.probability -
                a.probability
              );
            }

            if (
              b.score !== a.score
            ) {
              return (
                b.score -
                a.score
              );
            }

            return (
              b.valuePercent -
              a.valuePercent
            );
          })
          .slice(
            0,
            MAX_TOP_PICKS
          );

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        date,

        eventsReturned:
          events.length,

        upcomingEvents:
          upcoming.length,

        eventsAnalyzed:
          analyzed.length,

        eventsExcluded:
          events.length -
          upcoming.length,

        qualificationCount:
          allQualified.length,

        maxTopPicks:
          MAX_TOP_PICKS,

        filters:
          FILTERS,

        exchange: {
          connected: false,
          status:
            "NOT_CONNECTED",
          note:
            "No exchange signal is fabricated.",
        },

        picks,

        analyzed,

        diagnostics: {
          eventStatus:
            eventData.diagnostics,

          predictionDebug:
            predictionData.diagnostics,

          predictionCount:
            predictionData.count,
        },
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          "Internal server error",

        message:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service:
      "Bet Analyzer Live",
    version:
      VERSION,
    source:
      SOURCE,
  });
});

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",
      version:
        VERSION,
      source:
        SOURCE,
      exchange:
        "NOT_CONNECTED",
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
