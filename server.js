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

const VERSION = "6.6.7";
const SOURCE = "BSD";

/*
|--------------------------------------------------------------------------
| ANALYZER SETTINGS
|--------------------------------------------------------------------------
*/

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 100;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.5;

const MIN_PROBABILITY = 50;

/*
 * Final TOP PICKS require non-negative value.
 *
 * We do NOT use a negative value threshold for final picks.
 * This prevents picks such as -0.92% from entering TOP PICKS.
 */
const MIN_VALUE_EDGE = 0;

const REQUEST_TIMEOUT = 15000;

/*
|--------------------------------------------------------------------------
| BASIC HELPERS
|--------------------------------------------------------------------------
*/

function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(",", ".")
    .replace("%", "")
    .trim();

  const n = Number(normalized);

  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[.:/]+/g, "");
}

function isGenericTeamName(value) {
  const text = normalizeText(value).toLowerCase();

  return (
    !text ||
    text === "home" ||
    text === "away" ||
    text === "home team" ||
    text === "away team" ||
    text === "hometeam" ||
    text === "awayteam" ||
    text === "local" ||
    text === "visitor"
  );
}

function firstFinite(...values) {
  for (const value of values) {
    const n = toNumber(value);

    if (n !== null) {
      return n;
    }
  }

  return null;
}

function firstString(...values) {
  for (const value of values) {
    const text = normalizeText(value);

    if (text && !isGenericTeamName(text)) {
      return text;
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| TEAM NAME PARSER
|--------------------------------------------------------------------------
*/

function extractTeamName(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const text = normalizeText(value);

    return isGenericTeamName(text) ? null : text;
  }

  if (typeof value === "number") {
    return null;
  }

  if (isObject(value)) {
    const candidates = [
      value.name,
      value.team_name,
      value.teamName,
      value.short_name,
      value.shortName,
      value.display_name,
      value.displayName,
      value.title,
      value.label
    ];

    for (const candidate of candidates) {
      const result = extractTeamName(candidate);

      if (result) {
        return result;
      }
    }
  }

  return null;
}

function extractTeamsFromEvent(event) {
  if (!isObject(event)) {
    return {
      home: null,
      away: null
    };
  }

  const home = firstString(
    extractTeamName(event.home_team),
    extractTeamName(event.homeTeam),
    extractTeamName(event.home),
    extractTeamName(event.home_side),
    extractTeamName(event.homeSide),
    event.home_team_name,
    event.homeTeamName,
    event.home_name,
    event.homeName,
    event.home_display_name,
    event.homeDisplayName,
    extractTeamName(event.teams?.home),
    extractTeamName(event.teams?.home_team),
    extractTeamName(event.teams?.homeTeam),
    extractTeamName(event.teams?.local)
  );

  const away = firstString(
    extractTeamName(event.away_team),
    extractTeamName(event.awayTeam),
    extractTeamName(event.away),
    extractTeamName(event.away_side),
    extractTeamName(event.awaySide),
    event.away_team_name,
    event.awayTeamName,
    event.away_name,
    event.awayName,
    event.away_display_name,
    event.awayDisplayName,
    extractTeamName(event.teams?.away),
    extractTeamName(event.teams?.away_team),
    extractTeamName(event.teams?.awayTeam),
    extractTeamName(event.teams?.visitor)
  );

  return {
    home,
    away
  };
}

/*
|--------------------------------------------------------------------------
| EVENT ID / DATE / STATUS
|--------------------------------------------------------------------------
*/

function getEventId(event) {
  return (
    event?.id ??
    event?.event_id ??
    event?.eventId ??
    event?.match_id ??
    event?.matchId ??
    null
  );
}

function getEventDate(event) {
  return (
    event?.date ??
    event?.event_date ??
    event?.eventDate ??
    event?.match_date ??
    event?.matchDate ??
    event?.start_time ??
    event?.startTime ??
    null
  );
}

function normalizeStatus(event) {
  const raw = normalizeText(
    event?.status ??
    event?.event_status ??
    event?.match_status ??
    event?.state ??
    ""
  ).toLowerCase();

  if (
    raw === "upcoming" ||
    raw === "notstarted" ||
    raw === "not_started" ||
    raw === "scheduled" ||
    raw === "pending"
  ) {
    return "notstarted";
  }

  if (
    raw === "live" ||
    raw === "inplay" ||
    raw === "in_play" ||
    raw === "playing"
  ) {
    return "live";
  }

  if (
    raw === "finished" ||
    raw === "ended" ||
    raw === "completed" ||
    raw === "ft"
  ) {
    return "finished";
  }

  if (
    raw === "cancelled" ||
    raw === "canceled"
  ) {
    return "cancelled";
  }

  if (raw === "postponed") {
    return "postponed";
  }

  return raw || "unknown";
}

function isUpcomingEvent(event) {
  const status = normalizeStatus(event);

  return status === "notstarted";
}

/*
|--------------------------------------------------------------------------
| HTTP / BSD
|--------------------------------------------------------------------------
*/

async function bsdFetch(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
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
      data = {
        raw: text
      };
    }

    return {
      status: response.status,
      ok: response.ok,
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

function getResults(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  if (Array.isArray(data?.matches)) {
    return data.matches;
  }

  return [];
}

function hasNextPage(data, rows, limit, offset) {
  if (data?.next) {
    return true;
  }

  if (typeof data?.count === "number") {
    return offset + rows.length < data.count;
  }

  return rows.length >= limit;
}

async function fetchAllPages(
  basePath,
  {
    limit = 200,
    maxPages = 20,
    diagnostics = null
  } = {}
) {
  const all = [];

  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const separator = basePath.includes("?") ? "&" : "?";

    const path =
      `${basePath}${separator}` +
      `limit=${limit}&offset=${offset}`;

    const response = await bsdFetch(path);

    const rows = getResults(response.data);

    if (diagnostics) {
      diagnostics.push({
        path,
        status: response.status,
        count: response.data?.count ?? null,
        rows: rows.length,
        hasNext: hasNextPage(
          response.data,
          rows,
          limit,
          offset
        )
      });
    }

    if (!response.ok) {
      break;
    }

    all.push(...rows);

    const next = hasNextPage(
      response.data,
      rows,
      limit,
      offset
    );

    if (!next || rows.length === 0) {
      break;
    }

    offset += rows.length;

    if (rows.length < limit && typeof response.data?.count !== "number") {
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
  const variants = [
    `/events/?date=${encodeURIComponent(date)}`,
    `/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}`
  ];

  let best = [];

  for (const path of variants) {
    try {
      const rows = await fetchAllPages(path, {
        limit: 200,
        maxPages: 10,
        diagnostics
      });

      if (rows.length > best.length) {
        best = rows;
      }
    } catch {
      // Try next BSD date variant.
    }
  }

  return best;
}

/*
|--------------------------------------------------------------------------
| PREDICTION PARSER
|--------------------------------------------------------------------------
*/

function getPredictionEventId(row) {
  return (
    row?.event_id ??
    row?.eventId ??
    row?.match_id ??
    row?.matchId ??
    row?.event?.id ??
    row?.match?.id ??
    row?.markets?.event_id ??
    null
  );
}

function parsePredictionRow(row) {
  if (!isObject(row)) {
    return null;
  }

  const markets = row.markets || row.prediction || {};

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    {};

  const btts =
    markets.btts ||
    markets.BTTS ||
    {};

  const score =
    markets.score ||
    {};

  const dnb =
    markets.draw_no_bet ||
    markets.drawNoBet ||
    {};

  const home = firstFinite(
    matchResult.prob_home,
    matchResult.home,
    matchResult.home_probability,
    matchResult.homeProbability,
    row.prob_home,
    row.home_probability
  );

  const draw = firstFinite(
    matchResult.prob_draw,
    matchResult.draw,
    matchResult.draw_probability,
    matchResult.drawProbability,
    row.prob_draw,
    row.draw_probability
  );

  const away = firstFinite(
    matchResult.prob_away,
    matchResult.away,
    matchResult.away_probability,
    matchResult.awayProbability,
    row.prob_away,
    row.away_probability
  );

  const over15 = firstFinite(
    overUnder.prob_over_15,
    overUnder.over15,
    overUnder.over_15,
    row.prob_over_15
  );

  const over25 = firstFinite(
    overUnder.prob_over_25,
    overUnder.over25,
    overUnder.over_25,
    row.prob_over_25
  );

  const over35 = firstFinite(
    overUnder.prob_over_35,
    overUnder.over35,
    overUnder.over_35,
    row.prob_over_35
  );

  const bttsYes = firstFinite(
    btts.prob_yes,
    btts.yes,
    btts.prob_btts_yes,
    row.prob_btts_yes
  );

  const dnbHome = firstFinite(
    dnb.prob_home,
    dnb.home,
    dnb.home_probability,
    row.dnb_home
  );

  const scorePrediction =
    score.most_likely ||
    score.mostLikely ||
    score.prediction ||
    row.score_prediction ||
    null;

  const confidence = firstFinite(
    row.confidence,
    row.model_confidence,
    row.modelConfidence,
    markets.confidence
  );

  const eventId = getPredictionEventId(row);

  if (eventId === null) {
    return null;
  }

  return {
    eventId: Number(eventId),
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    dnbHome,
    score: scorePrediction,
    confidence
  };
}

async function getAllPredictions(diagnostics) {
  const rows = await fetchAllPages("/predictions/", {
    limit: 200,
    maxPages: 20,
    diagnostics
  });

  const parsed = [];

  for (const row of rows) {
    const prediction = parsePredictionRow(row);

    if (prediction) {
      parsed.push(prediction);
    }
  }

  return {
    raw: rows,
    parsed
  };
}

/*
|--------------------------------------------------------------------------
| ODDS PARSER
|--------------------------------------------------------------------------
*/

function findNumberDeep(obj, keys) {
  if (!isObject(obj) && !Array.isArray(obj)) {
    return null;
  }

  const wanted = new Set(keys.map(normalizeKey));

  const stack = [obj];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!isObject(current) && !Array.isArray(current)) {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const normalized = normalizeKey(key);

      if (wanted.has(normalized)) {
        const n = toNumber(value);

        if (n !== null) {
          return n;
        }
      }

      if (isObject(value) || Array.isArray(value)) {
        stack.push(value);
      }
    }
  }

  return null;
}

function getOddsValue(row) {
  return firstFinite(
    row?.decimal_odds,
    row?.decimalOdds,
    row?.odds,
    row?.price,
    row?.value,
    row?.current_odds,
    row?.currentOdds,
    findNumberDeep(row, [
      "decimal_odds",
      "decimalOdds",
      "odds",
      "price"
    ])
  );
}

function getPreviousOdds(row) {
  return firstFinite(
    row?.previous_decimal_odds,
    row?.previousDecimalOdds,
    row?.previous_odds,
    row?.previousOdds,
    row?.prev_odds,
    row?.prevOdds,
    findNumberDeep(row, [
      "previous_decimal_odds",
      "previousDecimalOdds",
      "previous_odds",
      "previousOdds"
    ])
  );
}

function getOpeningOdds(row) {
  return firstFinite(
    row?.opening_decimal_odds,
    row?.openingDecimalOdds,
    row?.opening_odds,
    row?.openingOdds,
    findNumberDeep(row, [
      "opening_decimal_odds",
      "openingDecimalOdds",
      "opening_odds",
      "openingOdds"
    ])
  );
}

function getBookmakerCount(row) {
  return firstFinite(
    row?.bookmaker_count,
    row?.bookmakerCount,
    row?.bookmakers_count,
    row?.bookmakersCount,
    row?.books_count,
    row?.booksCount
  );
}

function normalizeMarket(value) {
  const raw = normalizeKey(value);

  if (
    raw === "1x2" ||
    raw === "matchwinner" ||
    raw === "matchresult" ||
    raw === "winner"
  ) {
    return "1X2";
  }

  if (
    raw === "doublechance" ||
    raw === "dc" ||
    raw === "double"
  ) {
    return "DOUBLE_CHANCE";
  }

  if (
    raw === "overunder" ||
    raw === "totals" ||
    raw === "totalgoals" ||
    raw === "ou"
  ) {
    return "OVER_UNDER";
  }

  if (
    raw === "btts" ||
    raw === "bothteamstoscore" ||
    raw === "bothteams"
  ) {
    return "BTTS";
  }

  /*
   * BSD rows can sometimes encode the actual market
   * directly in market/outcome text.
   */
  if (raw.includes("doublechance")) {
    return "DOUBLE_CHANCE";
  }

  if (raw.includes("over") || raw.includes("under")) {
    return "OVER_UNDER";
  }

  if (raw.includes("btts")) {
    return "BTTS";
  }

  if (raw.includes("1x2")) {
    return "1X2";
  }

  return raw;
}

function normalizeOutcome(row) {
  const candidates = [
    row?.outcome,
    row?.outcome_name,
    row?.outcomeName,
    row?.selection,
    row?.selection_name,
    row?.selectionName,
    row?.name,
    row?.label,
    row?.side
  ];

  for (const value of candidates) {
    const text = normalizeText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeLine(row) {
  return firstFinite(
    row?.line,
    row?.total,
    row?.handicap,
    row?.points,
    row?.goal_line,
    row?.goalLine,
    row?.market_line,
    row?.marketLine
  );
}

function normalizeOutcomeCode(outcome) {
  const raw = normalizeKey(outcome);

  if (
    raw === "home" ||
    raw === "1" ||
    raw === "h" ||
    raw === "local"
  ) {
    return "HOME";
  }

  if (
    raw === "draw" ||
    raw === "x" ||
    raw === "tie"
  ) {
    return "DRAW";
  }

  if (
    raw === "away" ||
    raw === "2" ||
    raw === "a" ||
    raw === "visitor"
  ) {
    return "AWAY";
  }

  if (
    raw === "1x" ||
    raw === "homedraw" ||
    raw === "homeordraw"
  ) {
    return "1X";
  }

  if (
    raw === "x2" ||
    raw === "drawaway" ||
    raw === "draworaway"
  ) {
    return "X2";
  }

  if (
    raw === "12" ||
    raw === "homeaway" ||
    raw === "homeoraway"
  ) {
    return "12";
  }

  if (
    raw === "yes" ||
    raw === "y" ||
    raw === "btts_yes" ||
    raw === "bttsyes"
  ) {
    return "YES";
  }

  if (
    raw === "no" ||
    raw === "n" ||
    raw === "btts_no" ||
    raw === "bttsno"
  ) {
    return "NO";
  }

  if (
    raw === "over15" ||
    raw === "over1.5" ||
    raw === "o15"
  ) {
    return "OVER15";
  }

  if (
    raw === "over25" ||
    raw === "over2.5" ||
    raw === "o25"
  ) {
    return "OVER25";
  }

  if (
    raw === "over35" ||
    raw === "over3.5" ||
    raw === "o35"
  ) {
    return "OVER35";
  }

  if (
    raw.includes("over15") ||
    raw.includes("over1.5")
  ) {
    return "OVER15";
  }

  if (
    raw.includes("over25") ||
    raw.includes("over2.5")
  ) {
    return "OVER25";
  }

  if (
    raw.includes("over35") ||
    raw.includes("over3.5")
  ) {
    return "OVER35";
  }

  return raw;
}

function parseOddsRow(row) {
  if (!isObject(row)) {
    return null;
  }

  const marketRaw =
    row.market ??
    row.market_name ??
    row.marketName ??
    row.market_slug ??
    row.marketSlug ??
    row.market_code ??
    row.marketCode ??
    row.market_kind ??
    row.marketKind ??
    row.market_family ??
    row.marketFamily ??
    "";

  const outcome = normalizeOutcome(row);

  const market = normalizeMarket(
    `${marketRaw} ${outcome}`
  );

  const code = normalizeOutcomeCode(outcome);

  const odds = getOddsValue(row);

  if (odds === null || odds <= 1) {
    return null;
  }

  const previousOdds = getPreviousOdds(row);
  const openingOdds = getOpeningOdds(row);

  const bookmakerCount = getBookmakerCount(row);

  let selection = null;

  if (market === "1X2") {
    if (code === "HOME") selection = "HOME";
    if (code === "DRAW") selection = "DRAW";
    if (code === "AWAY") selection = "AWAY";
  }

  if (market === "DOUBLE_CHANCE") {
    if (code === "1X") selection = "1X";
    if (code === "X2") selection = "X2";
    if (code === "12") selection = "12";
  }

  if (market === "OVER_UNDER") {
    if (code === "OVER15") selection = "OVER15";
    if (code === "OVER25") selection = "OVER25";
    if (code === "OVER35") selection = "OVER35";
  }

  if (market === "BTTS") {
    if (code === "YES") selection = "BTTS_YES";
    if (code === "NO") selection = "BTTS_NO";
  }

  if (!selection) {
    return null;
  }

  return {
    market,
    selection,
    odds,
    previousOdds,
    openingOdds,
    bookmakerCount,
    movement:
      row?.movement ??
      row?.movement_type ??
      row?.movementType ??
      null,
    updatedAt:
      row?.updated_at ??
      row?.updatedAt ??
      null,
    line: normalizeLine(row),
    raw: row
  };
}

/*
|--------------------------------------------------------------------------
| ODDS EXTRACTION FROM ANY BSD SHAPE
|--------------------------------------------------------------------------
*/

function flattenOddsContainer(data) {
  const rows = [];

  if (Array.isArray(data)) {
    rows.push(...data);
    return rows;
  }

  if (!isObject(data)) {
    return rows;
  }

  if (Array.isArray(data.results)) {
    rows.push(...data.results);
  }

  if (Array.isArray(data.odds)) {
    rows.push(...data.odds);
  }

  if (Array.isArray(data.rows)) {
    rows.push(...data.rows);
  }

  if (Array.isArray(data.bookmakers)) {
    /*
     * BSD may return bookmaker objects containing odds fields.
     * Preserve them for the parser.
     */
    rows.push(...data.bookmakers);
  }

  if (Array.isArray(data.markets)) {
    for (const market of data.markets) {
      if (!isObject(market)) continue;

      if (Array.isArray(market.rows)) {
        rows.push(...market.rows);
      }

      if (Array.isArray(market.odds)) {
        rows.push(...market.odds);
      }

      if (Array.isArray(market.selections)) {
        for (const selection of market.selections) {
          if (isObject(selection)) {
            rows.push({
              ...market,
              ...selection
            });
          }
        }
      }

      if (Array.isArray(market.bookmakers)) {
        for (const bookmaker of market.bookmakers) {
          if (!isObject(bookmaker)) continue;

          rows.push({
            ...market,
            ...bookmaker
          });
        }
      }
    }
  }

  return rows;
}

function chooseLatestOdds(rows) {
  const map = new Map();

  for (const row of rows) {
    const parsed = parseOddsRow(row);

    if (!parsed) {
      continue;
    }

    const key =
      `${parsed.market}|${parsed.selection}|` +
      `${parsed.line ?? "none"}`;

    const existing = map.get(key);

    if (!existing) {
      map.set(key, parsed);
      continue;
    }

    const existingTime = existing.updatedAt
      ? Date.parse(existing.updatedAt)
      : 0;

    const newTime = parsed.updatedAt
      ? Date.parse(parsed.updatedAt)
      : 0;

    if (newTime >= existingTime) {
      map.set(key, parsed);
    }
  }

  return [...map.values()];
}

async function getOdds(eventId) {
  const diagnostics = [];

  let rows = [];

  try {
    rows = await fetchAllPages(
      `/odds/?event_id=${encodeURIComponent(eventId)}`,
      {
        limit: 200,
        maxPages: 20,
        diagnostics
      }
    );
  } catch {
    rows = [];
  }

  const parsedRows = chooseLatestOdds(rows);

  const result = {
    home: null,
    draw: null,
    away: null,

    doubleChance1X: null,
    doubleChanceX2: null,
    doubleChance12: null,

    over15: null,
    over25: null,
    over35: null,

    bttsYes: null,

    rowsCount: parsedRows.length,
    rawCount: rows.length,

    movement: {},

    diagnostics
  };

  for (const row of parsedRows) {
    const item = {
      odds: row.odds,
      previousOdds: row.previousOdds,
      openingOdds: row.openingOdds,
      movement: row.movement,
      bookmakerCount: row.bookmakerCount,
      updatedAt: row.updatedAt
    };

    if (row.selection === "HOME") {
      result.home = item;
    }

    if (row.selection === "DRAW") {
      result.draw = item;
    }

    if (row.selection === "AWAY") {
      result.away = item;
    }

    if (row.selection === "1X") {
      result.doubleChance1X = item;
    }

    if (row.selection === "X2") {
      result.doubleChanceX2 = item;
    }

    if (row.selection === "12") {
      result.doubleChance12 = item;
    }

    if (row.selection === "OVER15") {
      result.over15 = item;
    }

    if (row.selection === "OVER25") {
      result.over25 = item;
    }

    if (row.selection === "OVER35") {
      result.over35 = item;
    }

    if (row.selection === "BTTS_YES") {
      result.bttsYes = item;
    }
  }

  return result;
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
      movementScore: 0,
      movementPercent: null
    };
  }

  const movementRaw = normalizeText(
    oddsObject.movement
  ).toUpperCase();

  const current = toNumber(oddsObject.odds);
  const previous = toNumber(oddsObject.previousOdds);
  const opening = toNumber(oddsObject.openingOdds);

  let movement = null;
  let movementPercent = null;

  if (
    previous !== null &&
    previous > 0 &&
    current !== null &&
    current > 0
  ) {
    movementPercent =
      ((current - previous) / previous) * 100;

    if (movementPercent <= -0.15) {
      movement = "SHORTENING";
    } else if (movementPercent >= 0.15) {
      movement = "DRIFTING";
    } else {
      movement = "STABLE";
    }
  } else if (
    movementRaw === "SHORTENING" ||
    movementRaw === "DRIFTING" ||
    movementRaw === "STABLE"
  ) {
    movement = movementRaw;
  }

  let score = 0;

  if (movement === "SHORTENING") {
    score = 5;

    if (
      movementPercent !== null &&
      movementPercent <= -2
    ) {
      score = 7;
    }

    if (
      movementPercent !== null &&
      movementPercent <= -4
    ) {
      score = 9;
    }
  }

  if (movement === "DRIFTING") {
    score = -4;

    if (
      movementPercent !== null &&
      movementPercent >= 2
    ) {
      score = -6;
    }

    if (
      movementPercent !== null &&
      movementPercent >= 4
    ) {
      score = -8;
    }
  }

  return {
    movement,
    movementScore: score,
    movementPercent:
      movementPercent === null
        ? null
        : round(movementPercent, 2)
  };
}

/*
|--------------------------------------------------------------------------
| MARKET DEFINITIONS
|--------------------------------------------------------------------------
*/

function getMarketDefinitions(prediction, odds) {
  return [
    {
      market: "HOME",
      selection: "HOME",
      label: "Gospodarze wygrają",
      probability: prediction.home,
      odds: odds.home,
      marketBonus: 1
    },

    {
      market: "DRAW",
      selection: "DRAW",
      label: "Remis",
      probability: prediction.draw,
      odds: odds.draw,
      marketBonus: 0
    },

    {
      market: "AWAY",
      selection: "AWAY",
      label: "Goście wygrają",
      probability: prediction.away,
      odds: odds.away,
      marketBonus: 1
    },

    {
      market: "1X",
      selection: "1X",
      label: "Gospodarze lub remis",
      probability:
        prediction.home !== null &&
        prediction.draw !== null
          ? prediction.home + prediction.draw
          : null,
      odds: odds.doubleChance1X,
      marketBonus: 2
    },

    {
      market: "X2",
      selection: "X2",
      label: "Remis lub goście",
      probability:
        prediction.draw !== null &&
        prediction.away !== null
          ? prediction.draw + prediction.away
          : null,
      odds: odds.doubleChanceX2,
      marketBonus: 2
    },

    {
      market: "12",
      selection: "12",
      label: "Któraś drużyna wygra",
      probability:
        prediction.home !== null &&
        prediction.away !== null
          ? prediction.home + prediction.away
          : null,
      odds: odds.doubleChance12,
      marketBonus: 2
    },

    {
      market: "OVER15",
      selection: "OVER15",
      label: "Powyżej 1.5 gola",
      probability: prediction.over15,
      odds: odds.over15,
      marketBonus: 1
    },

    {
      market: "OVER25",
      selection: "OVER25",
      label: "Powyżej 2.5 gola",
      probability: prediction.over25,
      odds: odds.over25,
      marketBonus: 1
    },

    {
      market: "OVER35",
      selection: "OVER35",
      label: "Powyżej 3.5 gola",
      probability: prediction.over35,
      odds: odds.over35,
      marketBonus: 1
    },

    {
      market: "BTTS",
      selection: "BTTS",
      label: "Obie drużyny strzelą",
      probability: prediction.bttsYes,
      odds: odds.bttsYes,
      marketBonus: 1
    }
  ];
}

/*
|--------------------------------------------------------------------------
| CANDIDATE EVALUATION
|--------------------------------------------------------------------------
*/

function evaluateCandidate(definition) {
  const probability = toNumber(definition.probability);
  const oddsObject = definition.odds;

  if (
    probability === null ||
    probability < MIN_PROBABILITY
  ) {
    return {
      accepted: false,
      reason: "probability_below_threshold"
    };
  }

  if (!oddsObject || toNumber(oddsObject.odds) === null) {
    return {
      accepted: false,
      reason: "odds_missing"
    };
  }

  const odds = toNumber(oddsObject.odds);

  if (odds < MIN_ODDS) {
    return {
      accepted: false,
      reason: "odds_too_low"
    };
  }

  if (odds > MAX_ODDS) {
    return {
      accepted: false,
      reason: "odds_too_high"
    };
  }

  const impliedProbability =
    (1 / odds) * 100;

  const valueEdge =
    probability - impliedProbability;

  /*
   * FINAL QUALITY GATE
   *
   * Negative value is rejected.
   */
  if (valueEdge < MIN_VALUE_EDGE) {
    return {
      accepted: false,
      reason: "negative_value",
      probability,
      odds,
      impliedProbability: round(impliedProbability, 2),
      valueEdge: round(valueEdge, 2)
    };
  }

  const movement = calculateMovement(oddsObject);

  const probabilityScore =
    clamp(probability - 50, 0, 50);

  /*
   * Value is deliberately strong in the ranking.
   * Positive edge must matter substantially.
   */
  const valueScore =
    clamp(valueEdge * 4, 0, 30);

  let bookmakerBonus = 0;

  const bookmakerCount =
    toNumber(oddsObject.bookmakerCount);

  if (bookmakerCount !== null) {
    if (bookmakerCount >= 15) {
      bookmakerBonus = 3;
    } else if (bookmakerCount >= 10) {
      bookmakerBonus = 2;
    } else if (bookmakerCount >= 6) {
      bookmakerBonus = 1.25;
    } else if (bookmakerCount >= 3) {
      bookmakerBonus = 0.5;
    }
  }

  /*
   * Positive movement confirmation.
   */
  const movementBonus =
    movement.movementScore;

  /*
   * Small bonus for stable/shortening markets.
   * We do not reward drifting markets.
   */
  const qualityScore =
    probabilityScore +
    valueScore +
    bookmakerBonus +
    definition.marketBonus +
    movementBonus;

  const warnings = [];

  if (valueEdge < 1) {
    warnings.push("mała przewaga wartości");
  }

  if (
    movement.movement === "DRIFTING"
  ) {
    warnings.push("kurs oddala się od typu");
  }

  if (
    bookmakerCount !== null &&
    bookmakerCount < 5
  ) {
    warnings.push("mało bukmacherów");
  }

  const supportingSignals = [];

  if (valueEdge > 0) {
    supportingSignals.push(
      "dodatnia przewaga względem kursu"
    );
  }

  if (
    movement.movement === "SHORTENING"
  ) {
    supportingSignals.push(
      "kurs skraca się"
    );
  }

  if (
    movement.movement === "STABLE"
  ) {
    supportingSignals.push(
      "kurs stabilny"
    );
  }

  if (
    bookmakerCount !== null &&
    bookmakerCount >= 6
  ) {
    supportingSignals.push(
      "potwierdzenie wielu bukmacherów"
    );
  }

  return {
    accepted: true,

    probability: round(probability, 1),
    odds: round(odds, 3),

    impliedProbability:
      round(impliedProbability, 2),

    valueEdge:
      round(valueEdge, 2),

    movement:
      movement.movement,

    movementScore:
      movement.movementScore,

    movementPercent:
      movement.movementPercent,

    previousOdds:
      oddsObject.previousOdds !== null
        ? round(oddsObject.previousOdds, 3)
        : null,

    openingOdds:
      oddsObject.openingOdds !== null
        ? round(oddsObject.openingOdds, 3)
        : null,

    bookmakerCount:
      bookmakerCount !== null
        ? bookmakerCount
        : null,

    probabilityScore:
      round(probabilityScore, 2),

    valueScore:
      round(valueScore, 2),

    bookmakerBonus:
      round(bookmakerBonus, 2),

    marketBonus:
      definition.marketBonus,

    qualityScore:
      round(qualityScore, 2),

    warnings,

    supportingSignals
  };
}

/*
|--------------------------------------------------------------------------
| BUILD EVENT ANALYSIS
|--------------------------------------------------------------------------
*/

function buildEventAnalysis(
  event,
  prediction,
  odds
) {
  const teams = extractTeamsFromEvent(event);

  const definitions =
    getMarketDefinitions(
      prediction,
      odds
    );

  const candidates = [];

  for (const definition of definitions) {
    const evaluated =
      evaluateCandidate(definition);

    if (evaluated.accepted) {
      candidates.push({
        eventId: getEventId(event),

        home: teams.home,
        away: teams.away,

        eventDate:
          getEventDate(event),

        market:
          definition.market,

        selection:
          definition.selection,

        label:
          definition.label,

        ...evaluated,

        predictionConfidence:
          prediction.confidence,

        scorePrediction:
          prediction.score
      });
    }
  }

  /*
   * One strongest market per event.
   *
   * We do not allow one match to occupy multiple TOP slots.
   */
  candidates.sort(
    (a, b) =>
      b.qualityScore -
      a.qualityScore
  );

  return {
    eventId: getEventId(event),

    home: teams.home,
    away: teams.away,

    eventDate:
      getEventDate(event),

    status:
      normalizeStatus(event),

    predictionAvailable:
      !!prediction,

    prediction,

    oddsAvailable:
      !!odds,

    odds: {
      home:
        odds.home?.odds ?? null,

      draw:
        odds.draw?.odds ?? null,

      away:
        odds.away?.odds ?? null,

      doubleChance1X:
        odds.doubleChance1X?.odds ?? null,

      doubleChanceX2:
        odds.doubleChanceX2?.odds ?? null,

      doubleChance12:
        odds.doubleChance12?.odds ?? null,

      over15:
        odds.over15?.odds ?? null,

      over25:
        odds.over25?.odds ?? null,

      over35:
        odds.over35?.odds ?? null,

      bttsYes:
        odds.bttsYes?.odds ?? null,

      rowsCount:
        odds.rowsCount,

      rawCount:
        odds.rawCount
    },

    candidates
  };
}

/*
|--------------------------------------------------------------------------
| SELECT TOP PICKS
|--------------------------------------------------------------------------
*/

function selectTopPicks(analyses) {
  const allCandidates = [];

  for (const analysis of analyses) {
    if (!analysis.candidates?.length) {
      continue;
    }

    /*
     * Only strongest market from each match.
     */
    allCandidates.push(
      analysis.candidates[0]
    );
  }

  /*
   * ABSOLUTE RULE:
   * no negative value in TOP PICKS.
   */
  const positiveValueCandidates =
    allCandidates.filter(
      candidate =>
        candidate.valueEdge >=
        MIN_VALUE_EDGE
    );

  positiveValueCandidates.sort(
    (a, b) => {
      /*
       * Primary:
       * quality score.
       *
       * Secondary:
       * real value.
       *
       * Tertiary:
       * probability.
       */
      if (
        b.qualityScore !==
        a.qualityScore
      ) {
        return (
          b.qualityScore -
          a.qualityScore
        );
      }

      if (
        b.valueEdge !==
        a.valueEdge
      ) {
        return (
          b.valueEdge -
          a.valueEdge
        );
      }

      return (
        b.probability -
        a.probability
      );
    }
  );

  const selected = [];

  for (
    const candidate
    of positiveValueCandidates
  ) {
    if (
      selected.length >=
      MAX_TOP_PICKS
    ) {
      break;
    }

    selected.push({
      ...candidate,
      rank:
        selected.length + 1
    });
  }

  return {
    allCandidates,
    positiveValueCandidates,
    selected
  };
}

/*
|--------------------------------------------------------------------------
| API: ROOT
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    message: "Backend działa."
  });
});

/*
|--------------------------------------------------------------------------
| API: HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    exchange: {
      connected: false,
      status: "NOT_CONNECTED"
    }
  });
});

/*
|--------------------------------------------------------------------------
| API: ANALYZE
|--------------------------------------------------------------------------
*/

app.get("/api/analyze", async (req, res) => {
  const startedAt = Date.now();

  const date =
    normalizeText(
      req.query.date
    ) ||
    new Date()
      .toISOString()
      .slice(0, 10);

  const predictionDiagnostics = [];
  const eventDiagnostics = [];

  try {
    /*
     * Load events and predictions.
     *
     * Both endpoints are paginated.
     */
    const [
      events,
      predictionData
    ] = await Promise.all([
      getEventsForDate(
        date,
        eventDiagnostics
      ),
      getAllPredictions(
        predictionDiagnostics
      )
    ]);

    const predictions =
      predictionData.parsed;

    const predictionMap =
      new Map();

    for (const prediction of predictions) {
      predictionMap.set(
        Number(prediction.eventId),
        prediction
      );
    }

    /*
     * Only upcoming matches.
     */
    const upcomingEvents =
      events.filter(
        event =>
          isUpcomingEvent(event)
      );

    /*
     * Sort chronologically.
     */
    upcomingEvents.sort(
      (a, b) => {
        const da =
          Date.parse(
            getEventDate(a) || ""
          );

        const db =
          Date.parse(
            getEventDate(b) || ""
          );

        return da - db;
      }
    );

    /*
     * Hard limit to avoid excessive
     * API traffic / processing.
     */
    const eventsToAnalyze =
      upcomingEvents.slice(
        0,
        MAX_EVENTS_TO_ANALYZE
      );

    const analyses = [];

    /*
     * Sequential processing is deliberate.
     *
     * This prevents a burst of 100+
     * simultaneous odds requests.
     */
    for (
      const event
      of eventsToAnalyze
    ) {
      const eventId =
        getEventId(event);

      if (eventId === null) {
        continue;
      }

      const prediction =
        predictionMap.get(
          Number(eventId)
        ) || null;

      let odds = {
        home: null,
        draw: null,
        away: null,
        doubleChance1X: null,
        doubleChanceX2: null,
        doubleChance12: null,
        over15: null,
        over25: null,
        over35: null,
        bttsYes: null,
        rowsCount: 0,
        rawCount: 0,
        diagnostics: []
      };

      /*
       * We only need odds when a prediction exists.
       */
      if (prediction) {
        odds =
          await getOdds(
            eventId
          );
      }

      const analysis =
        buildEventAnalysis(
          event,
          prediction,
          odds
        );

      analyses.push(
        analysis
      );
    }

    const selection =
      selectTopPicks(
        analyses
      );

    /*
     * Final TOP PICKS are ONLY positive-value.
     *
     * There is intentionally no fallback
     * to negative-value selections.
     */
    const topPicks =
      selection.selected;

    const eventsWithCandidates =
      analyses.filter(
        analysis =>
          analysis.candidates?.length
      ).length;

    const processingMs =
      Date.now() -
      startedAt;

    res.json({
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

      eventsReturned:
        events.length,

      upcomingEvents:
        upcomingEvents.length,

      eventsAnalyzed:
        eventsToAnalyze.length,

      eventsExcluded:
        events.length -
        upcomingEvents.length,

      predictionsTotal:
        predictionData.raw.length,

      predictionsParsed:
        predictions.length,

      qualificationCount:
        selection.positiveValueCandidates.length,

      eventsWithCandidates,

      maxTopPicks:
        MAX_TOP_PICKS,

      thresholds: {
        minProbability:
          MIN_PROBABILITY,

        minOdds:
          MIN_ODDS,

        maxOdds:
          MAX_ODDS,

        minValueEdge:
          `${MIN_VALUE_EDGE}%`,

        maxEventsAnalyzed:
          MAX_EVENTS_TO_ANALYZE
      },

      predictionDiagnostics,

      eventDiagnostics,

      topPicks,

      /*
       * This is deliberately useful for debugging,
       * but it does not become part of TOP PICKS.
       */
      analysis: analyses
    });

  } catch (error) {
    console.error(
      "ANALYZE ERROR:",
      error
    );

    res.status(500).json({
      version: VERSION,
      source: SOURCE,

      error: "ANALYZE_FAILED",

      message:
        error?.message ||
        "Unknown error",

      processingMs:
        Date.now() -
        startedAt,

      exchange: {
        connected: false,
        status: "NOT_CONNECTED"
      }
    });
  }
});

/*
|--------------------------------------------------------------------------
| DEBUG: ODDS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/debug-odds",
  async (req, res) => {
    const eventId =
      req.query.eventId;

    if (!eventId) {
      return res.status(400).json({
        error:
          "eventId is required"
      });
    }

    try {
      const diagnostics = [];

      const rows =
        await fetchAllPages(
          `/odds/?event_id=${encodeURIComponent(
            eventId
          )}`,
          {
            limit: 200,
            maxPages: 20,
            diagnostics
          }
        );

      const parsed =
        rows
          .map(parseOddsRow)
          .filter(Boolean);

      res.json({
        version: VERSION,
        eventId: Number(eventId),

        rawCount:
          rows.length,

        parsedCount:
          parsed.length,

        diagnostics,

        firstRows:
          rows.slice(0, 20),

        parsedRows:
          parsed.slice(0, 50)
      });

    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error:
          error?.message ||
          "DEBUG_ODDS_FAILED"
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| DEBUG: PREDICTIONS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const diagnostics = [];

      const data =
        await getAllPredictions(
          diagnostics
        );

      res.json({
        version: VERSION,

        rawCount:
          data.raw.length,

        parsedCount:
          data.parsed.length,

        diagnostics,

        firstRawRows:
          data.raw.slice(0, 10),

        firstParsedRows:
          data.parsed.slice(0, 20)
      });

    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error:
          error?.message ||
          "DEBUG_PREDICTIONS_FAILED"
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
