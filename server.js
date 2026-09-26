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

const VERSION = "6.9.0";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 100;
const MAX_ENRICH_EVENTS = 20;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.5;
const MIN_PROBABILITY = 50;
const MIN_CONFIDENCE = 0.55;
const MIN_VALUE_EDGE = 0.0;

const REQUEST_TIMEOUT = 15000;

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = numberOrNull(value);

  if (n === null) return null;

  const factor = 10 ** digits;

  return Math.round(n * factor) / factor;
}

function isoDateOnly(value) {
  if (!value) return null;

  const text = String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function getTeamName(team, fallback = "Unknown") {
  if (!team) return fallback;

  if (typeof team === "string") {
    return team;
  }

  return (
    team.name ||
    team.short_name ||
    team.shortName ||
    team.team_name ||
    fallback
  );
}

function getTeamId(team) {
  if (!team || typeof team !== "object") return null;

  return (
    numberOrNull(team.id) ??
    numberOrNull(team.team_id)
  );
}

function isUpcomingEvent(event) {
  if (!event) return false;

  const status = normalizeText(event.status).toLowerCase();

  if (
    status === "finished" ||
    status === "cancelled" ||
    status === "postponed" ||
    status === "unresolved" ||
    status === "live"
  ) {
    return false;
  }

  const eventDate =
    event.event_date ||
    event.date ||
    event.kickoff ||
    event.start_time;

  if (!eventDate) return true;

  const timestamp = new Date(eventDate).getTime();

  if (Number.isNaN(timestamp)) return true;

  return timestamp > Date.now();
}

function emptyOdds() {
  return {
    home: null,
    draw: null,
    away: null,

    doubleChance1X: null,
    doubleChanceX2: null,
    doubleChance12: null,

    over15: null,
    over25: null,
    over35: null,

    under15: null,
    under25: null,
    under35: null,

    bttsYes: null,
    bttsNo: null,

    rowsCount: 0,
    rawCount: 0,
    bookmakerCount: 0,

    movements: {
      home: null,
      draw: null,
      away: null,
      over15: null,
      over25: null,
      under25: null,
      bttsYes: null,
      bttsNo: null
    }
  };
}

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeout || REQUEST_TIMEOUT);

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
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      const error = new Error(
        `BSD HTTP ${response.status}`
      );

      error.status = response.status;
      error.data = data;

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function extractResults(data) {
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

  if (Array.isArray(data.items)) {
    return data.items;
  }

  return [];
}

async function fetchAllPages(path, maxItems = 1000) {
  const all = [];

  let offset = 0;
  const limit = 200;

  while (all.length < maxItems) {
    const separator = path.includes("?") ? "&" : "?";

    const data = await bsdFetch(
      `${path}${separator}limit=${limit}&offset=${offset}`
    );

    const rows = extractResults(data);

    if (!rows.length) {
      break;
    }

    all.push(...rows);

    if (
      !data ||
      !data.next ||
      rows.length < limit ||
      all.length >= (data.count || maxItems)
    ) {
      break;
    }

    offset += rows.length;
  }

  return all.slice(0, maxItems);
}

async function getEventsForDate(date) {
  const paths = [
    `/events/?date=${encodeURIComponent(date)}`,
    `/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const rows = await fetchAllPages(
        path,
        MAX_EVENTS_TO_ANALYZE
      );

      if (rows.length) {
        return rows;
      }

      return [];
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to load events");
}

function parsePredictionRow(row) {
  if (!row) return null;

  const eventId =
    numberOrNull(row.event_id) ??
    numberOrNull(row.match_id) ??
    numberOrNull(row.eventId);

  if (eventId === null) return null;

  const home =
    numberOrNull(row.home_win_prob) ??
    numberOrNull(row.home_probability) ??
    numberOrNull(row.home);

  const draw =
    numberOrNull(row.draw_prob) ??
    numberOrNull(row.draw_probability) ??
    numberOrNull(row.draw);

  const away =
    numberOrNull(row.away_win_prob) ??
    numberOrNull(row.away_probability) ??
    numberOrNull(row.away);

  const bttsYes =
    numberOrNull(row.btts_yes_prob) ??
    numberOrNull(row.btts_yes) ??
    numberOrNull(row.bttsYes);

  const bttsNo =
    numberOrNull(row.btts_no_prob) ??
    numberOrNull(row.btts_no) ??
    numberOrNull(row.bttsNo);

  const over15 =
    numberOrNull(row.over_1_5_prob) ??
    numberOrNull(row.over15) ??
    numberOrNull(row.over_15);

  const over25 =
    numberOrNull(row.over_2_5_prob) ??
    numberOrNull(row.over25) ??
    numberOrNull(row.over_25);

  const over35 =
    numberOrNull(row.over_3_5_prob) ??
    numberOrNull(row.over35) ??
    numberOrNull(row.over_35);

  const under15 =
    numberOrNull(row.under_1_5_prob) ??
    numberOrNull(row.under15) ??
    numberOrNull(row.under_15);

  const under25 =
    numberOrNull(row.under_2_5_prob) ??
    numberOrNull(row.under25) ??
    numberOrNull(row.under_25);

  const under35 =
    numberOrNull(row.under_3_5_prob) ??
    numberOrNull(row.under35) ??
    numberOrNull(row.under_35);

  const confidence =
    numberOrNull(row.confidence) ??
    numberOrNull(row.prediction_confidence);

  const predictedHome =
    numberOrNull(row.predicted_home_score) ??
    numberOrNull(row.home_score_prediction);

  const predictedAway =
    numberOrNull(row.predicted_away_score) ??
    numberOrNull(row.away_score_prediction);

  return {
    id: numberOrNull(row.id),
    eventId,

    home,
    draw,
    away,

    bttsYes,
    bttsNo,

    over15,
    over25,
    over35,

    under15,
    under25,
    under35,

    confidence,

    predictedHome,
    predictedAway,

    raw: row
  };
}

async function getAllPredictions(date) {
  const paths = [
    `/predictions/?date=${encodeURIComponent(date)}`,
    `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}`,
    `/predictions/?upcoming=true`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const rows = await fetchAllPages(path, 1000);

      if (rows.length) {
        return rows
          .map(parsePredictionRow)
          .filter(Boolean)
          .filter((row) => {
            const rawDate =
              row.raw?.event_date ||
              row.raw?.date ||
              row.raw?.kickoff;

            if (!rawDate) return true;

            return isoDateOnly(rawDate) === date;
          });
      }

      return [];
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to load predictions");
}

function extractOddsValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return numberOrNull(value);
  }

  if (typeof value === "string") {
    return numberOrNull(value);
  }

  if (typeof value === "object") {
    return (
      numberOrNull(value.price) ??
      numberOrNull(value.odds) ??
      numberOrNull(value.value)
    );
  }

  return null;
}

function setOdd(odds, key, value) {
  const price = extractOddsValue(value);

  if (price === null || price <= 1) return;

  odds[key] = price;
}

function normalizeMarketName(value) {
  return normalizeText(value)
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function parseOddsRows(rows) {
  const odds = emptyOdds();

  if (!Array.isArray(rows)) {
    return odds;
  }

  odds.rawCount = rows.length;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const market = normalizeMarketName(
      row.market ||
      row.market_kind ||
      row.market_type ||
      row.market_family ||
      row.name ||
      row.kind
    );

    const selection = normalizeMarketName(
      row.selection ||
      row.outcome ||
      row.side ||
      row.label
    );

    const price =
      extractOddsValue(row.price) ??
      extractOddsValue(row.odds) ??
      extractOddsValue(row.value);

    if (price === null || price <= 1) continue;

    if (
      market.includes("1X2") ||
      market.includes("MATCH_WINNER") ||
      market === "WINNER"
    ) {
      if (
        selection.includes("HOME") ||
        selection === "1"
      ) {
        setOdd(odds, "home", price);
      } else if (
        selection.includes("DRAW") ||
        selection === "X"
      ) {
        setOdd(odds, "draw", price);
      } else if (
        selection.includes("AWAY") ||
        selection === "2"
      ) {
        setOdd(odds, "away", price);
      }
    }

    if (
      market.includes("BTTS") ||
      market.includes("BOTH_TEAMS")
    ) {
      if (
        selection.includes("YES") ||
        selection === "Y"
      ) {
        setOdd(odds, "bttsYes", price);
      }

      if (
        selection.includes("NO") ||
        selection === "N"
      ) {
        setOdd(odds, "bttsNo", price);
      }
    }

    if (
      market.includes("OU") ||
      market.includes("TOTAL")
    ) {
      const isOver = selection.includes("OVER");
      const isUnder = selection.includes("UNDER");

      if (isOver) {
        if (market.includes("1.5") || selection.includes("1.5")) {
          setOdd(odds, "over15", price);
        }

        if (market.includes("2.5") || selection.includes("2.5")) {
          setOdd(odds, "over25", price);
        }

        if (market.includes("3.5") || selection.includes("3.5")) {
          setOdd(odds, "over35", price);
        }
      }

      if (isUnder) {
        if (market.includes("1.5") || selection.includes("1.5")) {
          setOdd(odds, "under15", price);
        }

        if (market.includes("2.5") || selection.includes("2.5")) {
          setOdd(odds, "under25", price);
        }

        if (market.includes("3.5") || selection.includes("3.5")) {
          setOdd(odds, "under35", price);
        }
      }
    }
  }

  odds.rowsCount = rows.length;

  return odds;
}

function parseStructuredOdds(data) {
  if (!data) {
    return {
      rawRows: [],
      parsed: emptyOdds()
    };
  }

  const rawRows = [];

  if (Array.isArray(data.results)) {
    rawRows.push(...data.results);
  }

  if (Array.isArray(data.rows)) {
    rawRows.push(...data.rows);
  }

  if (Array.isArray(data.odds)) {
    rawRows.push(...data.odds);
  }

  if (Array.isArray(data.bookmakers)) {
    for (const bookmaker of data.bookmakers) {
      if (!bookmaker || typeof bookmaker !== "object") continue;

      if (
        bookmaker.odds_home !== undefined ||
        bookmaker.odds_draw !== undefined ||
        bookmaker.odds_away !== undefined
      ) {
        rawRows.push({
          market: "1X2",
          bookmaker: bookmaker.bookmaker,
          selection: "HOME",
          price: bookmaker.odds_home,
          movement: bookmaker.movement_home
        });

        rawRows.push({
          market: "1X2",
          bookmaker: bookmaker.bookmaker,
          selection: "DRAW",
          price: bookmaker.odds_draw,
          movement: bookmaker.movement_draw
        });

        rawRows.push({
          market: "1X2",
          bookmaker: bookmaker.bookmaker,
          selection: "AWAY",
          price: bookmaker.odds_away,
          movement: bookmaker.movement_away
        });
      }
    }
  }

  if (Array.isArray(data.markets)) {
    for (const market of data.markets) {
      if (!market || typeof market !== "object") continue;

      const marketKind =
        market.market_kind ||
        market.market_family ||
        market.kind ||
        market.name ||
        "";

      if (Array.isArray(market.bookmakers)) {
        for (const bookmaker of market.bookmakers) {
          const prices = bookmaker?.prices;

          if (!prices || typeof prices !== "object") continue;

          for (const [selection, value] of Object.entries(prices)) {
            rawRows.push({
              market: marketKind,
              market_line: market.market_line,
              selection,
              bookmaker: bookmaker.bookmaker,
              price: extractOddsValue(value),
              movement:
                typeof value === "object"
                  ? value.movement
                  : null
            });
          }
        }
      }
    }
  }

  const parsed = parseOddsRows(rawRows);

  const bookmakerSet = new Set();

  for (const row of rawRows) {
    if (row?.bookmaker) {
      bookmakerSet.add(String(row.bookmaker));
    }
  }

  parsed.bookmakerCount =
    numberOrNull(data.bookmakers_count) ??
    bookmakerSet.size;

  for (const row of rawRows) {
    const market = normalizeMarketName(
      row.market ||
      row.market_kind ||
      row.market_family
    );

    const selection = normalizeMarketName(
      row.selection ||
      row.outcome
    );

    const movement =
      row.movement ||
      row.movement_home ||
      row.movement_away ||
      null;

    if (!movement) continue;

    if (market.includes("1X2")) {
      if (selection.includes("HOME")) {
        parsed.movements.home = movement;
      }

      if (selection.includes("DRAW")) {
        parsed.movements.draw = movement;
      }

      if (selection.includes("AWAY")) {
        parsed.movements.away = movement;
      }
    }

    if (market.includes("BTTS")) {
      if (selection.includes("YES")) {
        parsed.movements.bttsYes = movement;
      }

      if (selection.includes("NO")) {
        parsed.movements.bttsNo = movement;
      }
    }

    if (market.includes("OU") || market.includes("TOTAL")) {
      if (selection.includes("OVER") && selection.includes("1.5")) {
        parsed.movements.over15 = movement;
      }

      if (selection.includes("OVER") && selection.includes("2.5")) {
        parsed.movements.over25 = movement;
      }

      if (selection.includes("UNDER") && selection.includes("2.5")) {
        parsed.movements.under25 = movement;
      }
    }
  }

  return {
    rawRows,
    parsed
  };
}

async function getOdds(eventId) {
  try {
    const data = await bsdFetch(
      `/events/${eventId}/odds/`
    );

    return parseStructuredOdds(data);
  } catch {
    return {
      rawRows: [],
      parsed: emptyOdds()
    };
  }
}

function movementScore(movement) {
  const text = normalizeText(movement).toUpperCase();

  if (
    text === "SHORTENING" ||
    text === "DOWN" ||
    text === "FALLING"
  ) {
    return 2;
  }

  if (
    text === "DRIFTING" ||
    text === "UP" ||
    text === "RISING"
  ) {
    return -2;
  }

  if (text === "STABLE") {
    return 0;
  }

  return 0;
}

function impliedProbability(odds) {
  const n = numberOrNull(odds);

  if (n === null || n <= 1) {
    return null;
  }

  return 100 / n;
}

function valueEdge(probability, odds) {
  if (
    probability === null ||
    odds === null ||
    odds <= 1
  ) {
    return null;
  }

  return probability * odds / 100 * 100 - 100;
}

function normalizeProbability(value) {
  const n = numberOrNull(value);

  if (n === null) return null;

  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function candidateConfidence(prediction) {
  const confidence = normalizeProbability(
    prediction?.confidence
  );

  if (confidence === null) return null;

  return confidence;
}

function createCandidate({
  event,
  prediction,
  market,
  selection,
  label,
  probability,
  odds
}) {
  const probabilityPercent =
    normalizeProbability(probability);

  const confidence =
    candidateConfidence(prediction);

  const implied =
    impliedProbability(odds);

  const edge =
    valueEdge(probabilityPercent, odds);

  if (
    probabilityPercent === null ||
    odds === null
  ) {
    return null;
  }

  if (
    odds < MIN_ODDS ||
    odds > MAX_ODDS
  ) {
    return null;
  }

  if (
    probabilityPercent < MIN_PROBABILITY
  ) {
    return null;
  }

  return {
    eventId:
      numberOrNull(event.id) ??
      numberOrNull(event.event_id),

    home:
      getTeamName(
        event.home_team ||
        event.home ||
        event.homeTeam
      ),

    away:
      getTeamName(
        event.away_team ||
        event.away ||
        event.awayTeam
      ),

    eventDate:
      event.event_date ||
      event.date ||
      event.kickoff ||
      event.start_time ||
      null,

    market,
    selection,
    label,

    probability: round(probabilityPercent, 1),
    odds: round(odds, 3),
    impliedProbability: round(implied, 1),
    valueEdge: round(edge, 2),

    movement: null,
    movementScore: 0,

    bookmakerCount: 0,
    previousOdds: null,
    openingOdds: odds,

    predictionConfidence:
      confidence === null
        ? null
        : round(confidence / 100, 4),

    scorePrediction: null,

    rankingScore: 0
  };
}

function buildCandidates(event, prediction, odds) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  const add = (
    market,
    selection,
    label,
    probability,
    odd
  ) => {
    const candidate = createCandidate({
      event,
      prediction,
      market,
      selection,
      label,
      probability,
      odds: odd
    });

    if (candidate) {
      candidates.push(candidate);
    }
  };

  add(
    "1X2",
    "HOME",
    "Gospodarze wygrają",
    prediction.home,
    odds.home
  );

  add(
    "1X2",
    "DRAW",
    "Remis",
    prediction.draw,
    odds.draw
  );

  add(
    "1X2",
    "AWAY",
    "Goście wygrają",
    prediction.away,
    odds.away
  );

  add(
    "BTTS",
    "YES",
    "Obie drużyny strzelą",
    prediction.bttsYes,
    odds.bttsYes
  );

  add(
    "BTTS",
    "NO",
    "Obie drużyny nie strzelą",
    prediction.bttsNo,
    odds.bttsNo
  );

  add(
    "TOTALS",
    "OVER_1.5",
    "Powyżej 1.5 gola",
    prediction.over15,
    odds.over15
  );

  add(
    "TOTALS",
    "OVER_2.5",
    "Powyżej 2.5 gola",
    prediction.over25,
    odds.over25
  );

  add(
    "TOTALS",
    "OVER_3.5",
    "Powyżej 3.5 gola",
    prediction.over35,
    odds.over35
  );

  add(
    "TOTALS",
    "UNDER_1.5",
    "Poniżej 1.5 gola",
    prediction.under15,
    odds.under15
  );

  add(
    "TOTALS",
    "UNDER_2.5",
    "Poniżej 2.5 gola",
    prediction.under25,
    odds.under25
  );

  add(
    "TOTALS",
    "UNDER_3.5",
    "Poniżej 3.5 gola",
    prediction.under35,
    odds.under35
  );

  return candidates;
}

function extractRecentForm(detail) {
  const result = {
    home: null,
    away: null
  };

  if (!detail) return result;

  const candidates = [
    detail.recent_form,
    detail.form,
    detail.teams_form,
    detail.team_form
  ];

  for (const source of candidates) {
    if (!source || typeof source !== "object") continue;

    result.home =
      source.home ||
      source.home_form ||
      source.homeTeam ||
      result.home;

    result.away =
      source.away ||
      source.away_form ||
      source.awayTeam ||
      result.away;
  }

  return result;
}

function extractH2H(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }

  return (
    detail.head_to_head ||
    detail.h2h ||
    detail.h2h_data ||
    null
  );
}

function extractOfficials(detail) {
  if (!detail || typeof detail !== "object") {
    return [];
  }

  const officials =
    detail.officials ||
    detail.referees ||
    detail.referee ||
    [];

  if (Array.isArray(officials)) {
    return officials;
  }

  return officials ? [officials] : [];
}

function extractLineupInfo(lineups) {
  if (!lineups || typeof lineups !== "object") {
    return {
      available: false,
      predicted: false,
      homePlayers: 0,
      awayPlayers: 0,
      formations: null
    };
  }

  const home =
    lineups.home ||
    lineups.home_team ||
    lineups.home_lineup ||
    [];

  const away =
    lineups.away ||
    lineups.away_team ||
    lineups.away_lineup ||
    [];

  const homePlayers =
    Array.isArray(home)
      ? home.length
      : Array.isArray(home?.players)
        ? home.players.length
        : 0;

  const awayPlayers =
    Array.isArray(away)
      ? away.length
      : Array.isArray(away?.players)
        ? away.players.length
        : 0;

  const formations = {
    home:
      lineups.home_formation ||
      lineups.home?.formation ||
      null,

    away:
      lineups.away_formation ||
      lineups.away?.formation ||
      null
  };

  const predicted =
    Boolean(
      lineups.predicted ||
      lineups.is_predicted ||
      lineups.ai_predicted
    );

  return {
    available:
      homePlayers > 0 ||
      awayPlayers > 0,

    predicted,

    homePlayers,
    awayPlayers,

    formations
  };
}

function extractStatsInfo(stats) {
  if (!stats || typeof stats !== "object") {
    return {
      available: false,
      home: null,
      away: null
    };
  }

  const home =
    stats.home ||
    stats.home_stats ||
    stats.home_team ||
    null;

  const away =
    stats.away ||
    stats.away_stats ||
    stats.away_team ||
    null;

  return {
    available:
      Boolean(home || away),

    home,
    away
  };
}

function extractScorePrediction(prediction) {
  if (!prediction) return null;

  const home =
    numberOrNull(prediction.predictedHome);

  const away =
    numberOrNull(prediction.predictedAway);

  if (home !== null && away !== null) {
    return `${home}-${away}`;
  }

  const raw = prediction.raw || {};

  const predictedScore =
    raw.predicted_score ||
    raw.score_prediction ||
    raw.predicted_result ||
    null;

  if (predictedScore) {
    return String(predictedScore);
  }

  return null;
}

async function getEventDetail(eventId) {
  try {
    return await bsdFetch(
      `/events/${eventId}/`
    );
  } catch {
    return null;
  }
}

async function getEventStats(eventId) {
  try {
    return await bsdFetch(
      `/events/${eventId}/stats/`
    );
  } catch {
    return null;
  }
}

async function getEventLineups(eventId) {
  try {
    return await bsdFetch(
      `/events/${eventId}/lineups/`
    );
  } catch {
    return null;
  }
}

async function getEventH2H(eventId) {
  try {
    return await bsdFetch(
      `/events/${eventId}/h2h/`
    );
  } catch {
    return null;
  }
}

async function enrichCandidate(candidate, event, prediction) {
  const eventId = candidate.eventId;

  if (eventId === null) {
    return candidate;
  }

  const [
    detail,
    stats,
    lineups,
    h2h,
    oddsResult
  ] = await Promise.all([
    getEventDetail(eventId),
    getEventStats(eventId),
    getEventLineups(eventId),
    getEventH2H(eventId),
    getOdds(eventId)
  ]);

  const movement =
    oddsResult?.parsed?.movements || {};

  const marketMovement =
    candidate.selection === "HOME"
      ? movement.home
      : candidate.selection === "DRAW"
        ? movement.draw
        : candidate.selection === "AWAY"
          ? movement.away
          : candidate.selection === "YES"
            ? movement.bttsYes
            : candidate.selection === "NO"
              ? movement.bttsNo
              : candidate.selection === "OVER_1.5"
                ? movement.over15
                : candidate.selection === "OVER_2.5"
                  ? movement.over25
                  : candidate.selection === "UNDER_2.5"
                    ? movement.under25
                    : null;

  const scoreMovement =
    movementScore(marketMovement);

  candidate.movement =
    marketMovement || null;

  candidate.movementScore =
    scoreMovement;

  candidate.bookmakerCount =
    oddsResult?.parsed?.bookmakerCount || 0;

  candidate.previousOdds =
    null;

  candidate.openingOdds =
    candidate.odds;

  candidate.scorePrediction =
    extractScorePrediction(prediction);

  const form =
    extractRecentForm(detail);

  const lineupInfo =
    extractLineupInfo(lineups);

  const statsInfo =
    extractStatsInfo(stats);

  const officials =
    extractOfficials(detail);

  const referee =
    officials.length
      ? officials[0]
      : null;

  const h2hInfo =
    h2h ||
    extractH2H(detail);

  candidate.analysis = {
    form: {
      home: form.home,
      away: form.away,
      available:
        Boolean(form.home || form.away)
    },

    h2h: {
      available: Boolean(h2hInfo),
      data: h2hInfo
    },

    lineups: lineupInfo,

    stats: statsInfo,

    referee: {
      available: Boolean(referee),
      data: referee
    },

    eventDetailAvailable:
      Boolean(detail),

    odds: {
      available:
        Boolean(oddsResult?.parsed),
      bookmakerCount:
        oddsResult?.parsed?.bookmakerCount || 0
    }
  };

  return candidate;
}

function qualityScore(candidate) {
  let score = 0;

  const probability =
    numberOrNull(candidate.probability) || 0;

  const edge =
    numberOrNull(candidate.valueEdge) || 0;

  const confidence =
    candidate.predictionConfidence === null ||
    candidate.predictionConfidence === undefined
      ? 0
      : candidate.predictionConfidence * 100;

  const bookmakerCount =
    numberOrNull(candidate.bookmakerCount) || 0;

  score += Math.max(
    0,
    probability - 50
  ) * 0.9;

  score += Math.max(
    0,
    confidence - 50
  ) * 0.55;

  score += Math.max(
    -5,
    Math.min(10, edge)
  ) * 1.5;

  if (bookmakerCount >= 10) {
    score += 5;
  } else if (bookmakerCount >= 5) {
    score += 3;
  } else if (bookmakerCount >= 3) {
    score += 1;
  }

  score += candidate.movementScore || 0;

  const analysis =
    candidate.analysis;

  if (analysis?.lineups?.available) {
    score += 1.5;
  }

  if (
    analysis?.stats?.available
  ) {
    score += 1.5;
  }

  if (analysis?.form?.available) {
    score += 2;
  }

  if (analysis?.h2h?.available) {
    score += 0.5;
  }

  if (
    analysis?.referee?.available
  ) {
    score += 0.5;
  }

  return round(score, 2);
}

function passesQualityFilter(candidate) {
  if (!candidate) return false;

  if (
    candidate.probability === null ||
    candidate.odds === null
  ) {
    return false;
  }

  if (
    candidate.probability < MIN_PROBABILITY
  ) {
    return false;
  }

  if (
    candidate.odds < MIN_ODDS ||
    candidate.odds > MAX_ODDS
  ) {
    return false;
  }

  if (
    candidate.valueEdge === null ||
    candidate.valueEdge < MIN_VALUE_EDGE
  ) {
    return false;
  }

  if (
    candidate.predictionConfidence !== null &&
    candidate.predictionConfidence <
      MIN_CONFIDENCE
  ) {
    return false;
  }

  return true;
}

async function analyzeEvent(event, predictionMap) {
  const eventId =
    numberOrNull(event.id) ??
    numberOrNull(event.event_id);

  if (eventId === null) {
    return {
      eventId: null,
      candidates: []
    };
  }

  const prediction =
    predictionMap.get(eventId);

  if (!prediction) {
    return {
      eventId,
      candidates: []
    };
  }

  const oddsResult =
    await getOdds(eventId);

  const candidates =
    buildCandidates(
      event,
      prediction,
      oddsResult?.parsed || emptyOdds()
    );

  return {
    eventId,
    event,
    prediction,
    candidates
  };
}

async function enrichTopCandidates(items) {
  const enriched = [];

  for (
    let i = 0;
    i < items.length;
    i += 5
  ) {
    const batch =
      items.slice(i, i + 5);

    const result =
      await Promise.all(
        batch.map((item) =>
          enrichCandidate(
            item.candidate,
            item.event,
            item.prediction
          )
        )
      );

    enriched.push(...result);
  }

  return enriched;
}

function uniqueCandidates(candidates) {
  const map = new Map();

  for (const candidate of candidates) {
    const key = [
      candidate.eventId,
      candidate.market,
      candidate.selection
    ].join(":");

    const existing =
      map.get(key);

    if (
      !existing ||
      candidate.rankingScore >
        existing.rankingScore
    ) {
      map.set(key, candidate);
    }
  }

  return [...map.values()];
}

async function runAnalysis(date) {
  const started =
    Date.now();

  const [
    events,
    predictions
  ] = await Promise.all([
    getEventsForDate(date),
    getAllPredictions(date)
  ]);

  const predictionMap =
    new Map();

  for (const prediction of predictions) {
    if (
      prediction?.eventId !== null &&
      prediction?.eventId !== undefined
    ) {
      predictionMap.set(
        prediction.eventId,
        prediction
      );
    }
  }

  const upcomingEvents =
    events
      .filter(isUpcomingEvent)
      .slice(0, MAX_EVENTS_TO_ANALYZE);

  const preliminary = [];

  for (
    let i = 0;
    i < upcomingEvents.length;
    i += 5
  ) {
    const batch =
      upcomingEvents.slice(i, i + 5);

    const analyzed =
      await Promise.all(
        batch.map((event) =>
          analyzeEvent(
            event,
            predictionMap
          )
        )
      );

    for (const item of analyzed) {
      for (const candidate of item.candidates) {
        preliminary.push({
          candidate,
          event: item.event,
          prediction: item.prediction
        });
      }
    }
  }

  preliminary.sort(
    (a, b) => {
      const ap =
        Number(a.candidate.probability) || 0;

      const bp =
        Number(b.candidate.probability) || 0;

      const ae =
        Number(a.candidate.valueEdge) || 0;

      const be =
        Number(b.candidate.valueEdge) || 0;

      return (
        (bp + be * 0.5) -
        (ap + ae * 0.5)
      );
    }
  );

  const enrichmentPool =
    preliminary
      .slice(0, MAX_ENRICH_EVENTS);

  const enriched =
    await enrichTopCandidates(
      enrichmentPool
    );

  for (let i = 0; i < enriched.length; i++) {
    const candidate =
      enriched[i];

    candidate.rankingScore =
      qualityScore(candidate);
  }

  const qualified =
    enriched
      .filter(passesQualityFilter)
      .sort(
        (a, b) =>
          b.rankingScore -
          a.rankingScore
      );

  const unique =
    uniqueCandidates(qualified);

  const topPicks =
    unique
      .slice(0, MAX_TOP_PICKS)
      .map((candidate, index) => ({
        rank: index + 1,

        eventId:
          candidate.eventId,

        home:
          candidate.home,

        away:
          candidate.away,

        eventDate:
          candidate.eventDate,

        market:
          candidate.market,

        selection:
          candidate.selection,

        label:
          candidate.label,

        probability:
          candidate.probability,

        odds:
          candidate.odds,

        impliedProbability:
          candidate.impliedProbability,

        valueEdge:
          candidate.valueEdge,

        movement:
          candidate.movement,

        movementScore:
          candidate.movementScore,

        bookmakerCount:
          candidate.bookmakerCount,

        previousOdds:
          candidate.previousOdds,

        openingOdds:
          candidate.openingOdds,

        rankingScore:
          candidate.rankingScore,

        predictionConfidence:
          candidate.predictionConfidence,

        scorePrediction:
          candidate.scorePrediction,

        supportingData:
          candidate.analysis || {
            form: {
              available: false
            },
            h2h: {
              available: false
            },
            lineups: {
              available: false
            },
            stats: {
              available: false
            },
            referee: {
              available: false
            }
          }
      }));

  return {
    version: VERSION,
    source: SOURCE,
    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - started,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      message:
        "Betting exchange data is not connected. No exchange movement is fabricated."
    },

    qualificationCount:
      unique.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    eventsFound:
      events.length,

    eventsAnalyzed:
      upcomingEvents.length,

    predictionsFound:
      predictions.length,

    enrichment: {
      enabled: true,

      candidatesEnriched:
        enrichmentPool.length,

      dataSources: [
        "event detail",
        "odds",
        "stats",
        "lineups",
        "h2h"
      ],

      referee:
        "included when BSD provides it"
    },

    thresholds: {
      minProbability:
        MIN_PROBABILITY,

      minConfidence:
        MIN_CONFIDENCE,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      minValueEdge:
        `${MIN_VALUE_EDGE}%`,

      maxEventsAnalyzed:
        MAX_EVENTS_TO_ANALYZE,

      maxEnrichedCandidates:
        MAX_ENRICH_EVENTS
    },

    topPicks
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      isoDateOnly(
        req.query.date
      ) ||
      isoDateOnly(
        new Date()
      );

    const events =
      await getEventsForDate(date);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,
      count: events.length,
      events
    });
  } catch (error) {
    res.status(
      error.status || 500
    ).json({
      status: "error",
      version: VERSION,
      source: SOURCE,
      message:
        error.message
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const date =
      isoDateOnly(
        req.query.date
      );

    if (!date) {
      return res.status(400).json({
        status: "error",
        message:
          "Missing or invalid date. Use YYYY-MM-DD."
      });
    }

    const result =
      await runAnalysis(date);

    res.json(result);
  } catch (error) {
    console.error(
      "ANALYZE ERROR:",
      error
    );

    res.status(
      error.status || 500
    ).json({
      status: "error",
      version: VERSION,
      source: SOURCE,
      message:
        error.message
    });
  }
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      isoDateOnly(
        req.query.date
      );

    if (!date) {
      return res.status(400).json({
        status: "error",
        message:
          "Missing or invalid date. Use YYYY-MM-DD."
      });
    }

    const result =
      await runAnalysis(date);

    res.json(result);
  } catch (error) {
    console.error(
      "TOP PICKS ERROR:",
      error
    );

    res.status(
      error.status || 500
    ).json({
      status: "error",
      version: VERSION,
      source: SOURCE,
      message:
        error.message
    });
  }
});

app.get("/api/debug-odds", async (req, res) => {
  try {
    const eventId =
      numberOrNull(
        req.query.eventId
      );

    if (eventId === null) {
      return res.status(400).json({
        status: "error",
        message:
          "Missing eventId."
      });
    }

    const result =
      await getOdds(eventId);

    res.json({
      version: VERSION,
      source: SOURCE,
      eventId,
      ...result
    });
  } catch (error) {
    res.status(
      error.status || 500
    ).json({
      status: "error",
      version: VERSION,
      source: SOURCE,
      message:
        error.message
    });
  }
});

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const date =
        isoDateOnly(
          req.query.date
        );

      if (!date) {
        return res.status(400).json({
          status: "error",
          message:
            "Missing or invalid date. Use YYYY-MM-DD."
        });
      }

      const predictions =
        await getAllPredictions(date);

      res.json({
        version: VERSION,
        source: SOURCE,
        date,
        count: predictions.length,
        predictions
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        status: "error",
        version: VERSION,
        source: SOURCE,
        message:
          error.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
