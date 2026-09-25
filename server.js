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

const VERSION = "6.5.8";
const SOURCE = "BSD";

const MAX_EVENTS = 50;
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
  valuePercentMin: 5
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNum(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

function normalizePercent(value) {
  const n = num(value);

  if (n === null) return null;

  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function normalizeConfidence(value) {
  const n = num(value);

  if (n === null) return null;

  if (n > 1) return n / 100;

  return n;
}

function cleanName(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "object") {
    return (
      value.name ||
      value.team_name ||
      value.teamName ||
      value.display_name ||
      value.label ||
      null
    );
  }

  return String(value);
}

function normalizeStatus(value) {
  return String(value || "").toLowerCase().trim();
}

function isUpcoming(event) {
  const status = normalizeStatus(event?.status);

  return [
    "notstarted",
    "upcoming",
    "scheduled",
    "ns",
    "fixture"
  ].includes(status);
}

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

  if (Array.isArray(payload.bookmakers)) {
    return payload.bookmakers;
  }

  if (Array.isArray(payload.markets)) {
    return payload.markets;
  }

  if (Array.isArray(payload.odds)) {
    return payload.odds;
  }

  return [];
}

function countPayload(payload) {
  if (!payload) return 0;

  if (typeof payload.count === "number") {
    return payload.count;
  }

  const results = extractResults(payload);

  if (results.length) {
    return results.length;
  }

  return 0;
}

async function bsdFetch(path) {
  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    }
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    path,
    status: response.status,
    ok: response.ok,
    payload,
    count: countPayload(payload)
  };
}

function getEventId(item) {
  return firstNum(
    item?.event_id,
    item?.eventId,
    item?.fixture_id,
    item?.fixtureId,
    item?.id
  );
}

function getTeamName(item, side) {
  if (!item) return null;

  if (side === "home") {
    return cleanName(
      item.home ||
      item.home_team ||
      item.homeTeam ||
      item.team_home ||
      item.teams?.home ||
      item.teams?.home?.name ||
      item.fixture?.teams?.home?.name
    );
  }

  return cleanName(
    item.away ||
    item.away_team ||
    item.awayTeam ||
    item.team_away ||
    item.teams?.away ||
    item.teams?.away?.name ||
    item.fixture?.teams?.away?.name
  );
}

/* =========================================================
   EVENTS
========================================================= */

function normalizeEvent(raw) {
  const fixture = raw?.fixture || {};
  const teams = raw?.teams || {};

  const id = firstNum(
    raw?.id,
    raw?.event_id,
    raw?.eventId,
    fixture?.id
  );

  const home =
    cleanName(raw?.home) ||
    cleanName(raw?.home_team) ||
    cleanName(raw?.homeTeam) ||
    cleanName(teams?.home) ||
    cleanName(fixture?.teams?.home);

  const away =
    cleanName(raw?.away) ||
    cleanName(raw?.away_team) ||
    cleanName(raw?.awayTeam) ||
    cleanName(teams?.away) ||
    cleanName(fixture?.teams?.away);

  const date =
    raw?.date ||
    raw?.event_date ||
    raw?.start_time ||
    raw?.startTime ||
    fixture?.date ||
    fixture?.starting_at ||
    null;

  const status =
    raw?.status ||
    raw?.state ||
    fixture?.status ||
    "unknown";

  return {
    id,
    home,
    away,
    date,
    status: normalizeStatus(status),
    leagueId: firstNum(
      raw?.leagueId,
      raw?.league_id,
      raw?.league?.id,
      fixture?.league?.id
    ),
    league:
      cleanName(raw?.league) ||
      cleanName(raw?.league_name) ||
      cleanName(raw?.competition) ||
      cleanName(raw?.tournament) ||
      null
  };
}

async function getEvents(date) {
  const diagnostics = [];

  const paths = [
    `/events/?date=${encodeURIComponent(date)}&limit=${MAX_EVENTS}`,
    `/events/?date=${encodeURIComponent(date)}`,
    `/fixtures/?date=${encodeURIComponent(date)}&limit=${MAX_EVENTS}`,
    `/fixtures/?date=${encodeURIComponent(date)}`
  ];

  for (const path of paths) {
    try {
      const result = await bsdFetch(path);

      diagnostics.push({
        path,
        status: result.status,
        count: result.count
      });

      if (!result.ok) continue;

      const rows = extractResults(result.payload);

      if (!rows.length) continue;

      const events = rows
        .map(normalizeEvent)
        .filter(event => event.id && event.home && event.away);

      if (events.length) {
        return {
          events,
          diagnostics
        };
      }
    } catch (error) {
      diagnostics.push({
        path,
        error: error.message
      });
    }
  }

  return {
    events: [],
    diagnostics
  };
}

/* =========================================================
   PREDICTIONS
========================================================= */

function predictionEventId(item) {
  return firstNum(
    item?.event_id,
    item?.eventId,
    item?.fixture_id,
    item?.fixtureId,
    item?.event?.id,
    item?.fixture?.id,
    item?.id
  );
}

function findMarket(raw, names) {
  if (!raw) return null;

  const wanted = names.map(x =>
    String(x).toLowerCase().replace(/[^a-z0-9]/g, "")
  );

  function walk(value) {
    if (!value || typeof value !== "object") return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }

      return null;
    }

    const text = JSON.stringify(value).toLowerCase();

    for (const name of wanted) {
      if (text.includes(name)) {
        return value;
      }
    }

    for (const key of Object.keys(value)) {
      const found = walk(value[key]);
      if (found) return found;
    }

    return null;
  }

  return walk(raw);
}

function parsePrediction(raw) {
  if (!raw) return null;

  const markets = raw.markets || {};

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    raw.match_result ||
    raw.matchResult ||
    findMarket(raw, [
      "match_result",
      "match result",
      "1x2"
    ]) ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    raw.over_under ||
    raw.overUnder ||
    findMarket(raw, [
      "over_under",
      "over under"
    ]) ||
    {};

  const btts =
    markets.btts ||
    raw.btts ||
    findMarket(raw, [
      "btts",
      "both teams to score"
    ]) ||
    {};

  const expectedGoals =
    markets.expected_goals ||
    markets.expectedGoals ||
    raw.expected_goals ||
    raw.expectedGoals ||
    {};

  const score =
    markets.score ||
    raw.score ||
    {};

  const model =
    raw.model ||
    markets.model ||
    {};

  const prediction = {
    home: normalizePercent(
      firstNum(
        matchResult.home,
        matchResult.home_probability,
        matchResult.homeProbability,
        raw.home_probability,
        raw.homeProbability
      )
    ),

    draw: normalizePercent(
      firstNum(
        matchResult.draw,
        matchResult.draw_probability,
        matchResult.drawProbability,
        raw.draw_probability,
        raw.drawProbability
      )
    ),

    away: normalizePercent(
      firstNum(
        matchResult.away,
        matchResult.away_probability,
        matchResult.awayProbability,
        raw.away_probability,
        raw.awayProbability
      )
    ),

    over15: normalizePercent(
      firstNum(
        overUnder.over_15,
        overUnder.over15,
        overUnder["1.5_over"],
        overUnder["1_5_over"],
        raw.over15
      )
    ),

    over25: normalizePercent(
      firstNum(
        overUnder.over_25,
        overUnder.over25,
        overUnder["2.5_over"],
        overUnder["2_5_over"],
        raw.over25
      )
    ),

    over35: normalizePercent(
      firstNum(
        overUnder.over_35,
        overUnder.over35,
        overUnder["3.5_over"],
        overUnder["3_5_over"],
        raw.over35
      )
    ),

    bttsYes: normalizePercent(
      firstNum(
        btts.yes,
        btts.yes_probability,
        btts.yesProbability,
        btts.btts_yes,
        raw.bttsYes
      )
    ),

    xgHome: firstNum(
      expectedGoals.home,
      expectedGoals.home_xg,
      expectedGoals.xg_home,
      raw.xgHome,
      raw.home_xg
    ),

    xgAway: firstNum(
      expectedGoals.away,
      expectedGoals.away_xg,
      expectedGoals.xg_away,
      raw.xgAway,
      raw.away_xg
    ),

    confidence: normalizeConfidence(
      firstNum(
        model.confidence,
        raw.confidence
      )
    ),

    predicted:
      raw.predicted ||
      raw.prediction ||
      matchResult.predicted ||
      null,

    mostLikelyScore:
      raw.most_likely_score ||
      raw.mostLikelyScore ||
      score.most_likely ||
      score.mostLikely ||
      score.prediction ||
      null
  };

  const has1X2 =
    prediction.home !== null ||
    prediction.draw !== null ||
    prediction.away !== null;

  const hasGoals =
    prediction.over15 !== null ||
    prediction.over25 !== null ||
    prediction.over35 !== null;

  const hasBTTS = prediction.bttsYes !== null;

  if (!has1X2 && !hasGoals && !hasBTTS) {
    return null;
  }

  if (!prediction.predicted) {
    const values = [
      ["H", prediction.home],
      ["D", prediction.draw],
      ["A", prediction.away]
    ].filter(x => x[1] !== null);

    if (values.length) {
      values.sort((a, b) => b[1] - a[1]);
      prediction.predicted = values[0][0];
    }
  }

  return prediction;
}

async function getPredictions(events) {
  const diagnostics = [];

  const paths = [
    `/predictions/?upcoming=true&limit=200`,
    `/predictions/?limit=200`
  ];

  let payload = null;
  let source = null;

  for (const path of paths) {
    try {
      const result = await bsdFetch(path);

      diagnostics.push({
        path,
        status: result.status,
        count: result.count
      });

      if (result.ok) {
        payload = result.payload;
        source = path;

        if (extractResults(payload).length) {
          break;
        }
      }
    } catch (error) {
      diagnostics.push({
        path,
        error: error.message
      });
    }
  }

  const rows = extractResults(payload);
  const byId = new Map();

  for (const row of rows) {
    const id = predictionEventId(row);

    if (!id) continue;

    const parsed = parsePrediction(row);

    if (parsed) {
      byId.set(String(id), parsed);
    }
  }

  return {
    byId,
    source,
    count: rows.length,
    diagnostics
  };
}

/* =========================================================
   ODDS — ROBUST BSD PARSER 6.5.8
========================================================= */

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[,]/g, ".")
    .replace(/[^a-z0-9.]/g, "");
}

function flattenObject(value, prefix = "", output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenObject(item, `${prefix}[${index}]`, output);
    });

    return output;
  }

  if (typeof value !== "object") {
    output.push({
      path: prefix,
      value
    });

    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const next =
      prefix.length > 0
        ? `${prefix}.${key}`
        : key;

    flattenObject(child, next, output);
  }

  return output;
}

function objectText(obj) {
  try {
    return JSON.stringify(obj)
      .toLowerCase()
      .replace(/[,]/g, ".");
  } catch {
    return "";
  }
}

function detectLine(text) {
  const match = String(text || "").match(
    /(?:^|[^0-9])([123][.][05])(?:[^0-9]|$)/
  );

  if (!match) return null;

  const line = Number(match[1]);

  if ([1.5, 2.5, 3.5].includes(line)) {
    return line;
  }

  return null;
}

function getPriceFromObject(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const direct = [
    obj.odds,
    obj.odd,
    obj.price,
    obj.value,
    obj.decimal,
    obj.decimal_odds,
    obj.decimalOdds,
    obj.current_odds,
    obj.currentOdds,
    obj.current_price,
    obj.currentPrice,
    obj.selection_odds,
    obj.selectionOdds
  ];

  for (const value of direct) {
    const n = num(value);

    if (n !== null && n >= 1) {
      return n;
    }
  }

  const prices = obj.prices;

  if (prices && typeof prices === "object") {
    const nested = [
      prices.price,
      prices.odds,
      prices.value,
      prices.decimal,
      prices.current,
      prices.current_price,
      prices.current_odds
    ];

    for (const value of nested) {
      const n = num(value);

      if (n !== null && n >= 1) {
        return n;
      }
    }
  }

  return null;
}

function getMovement(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const text = objectText(obj);

  let direction = null;

  if (
    text.includes("shortening") ||
    text.includes("shorten") ||
    text.includes("steam")
  ) {
    direction = "SHORTENING";
  } else if (
    text.includes("drifting") ||
    text.includes("drift")
  ) {
    direction = "DRIFTING";
  }

  const previous = firstNum(
    obj.previous,
    obj.previous_odds,
    obj.previousOdds,
    obj.prev,
    obj.prev_odds,
    obj.prevOdds
  );

  const opening = firstNum(
    obj.opening,
    obj.opening_odds,
    obj.openingOdds,
    obj.open
  );

  const current = firstNum(
    obj.current,
    obj.current_odds,
    obj.currentOdds,
    obj.price,
    obj.odds,
    obj.value
  );

  let percent = firstNum(
    obj.change_percent,
    obj.changePercent,
    obj.percentage_change,
    obj.percentageChange,
    obj.percent_change,
    obj.percentChange
  );

  if (
    percent === null &&
    previous !== null &&
    current !== null &&
    previous > 0
  ) {
    percent = ((current - previous) / previous) * 100;
  }

  return {
    direction,
    previous,
    opening,
    current,
    percent
  };
}

function getBookmakerName(obj) {
  if (!obj || typeof obj !== "object") return null;

  return (
    obj.bookmaker?.name ||
    obj.bookmaker_name ||
    obj.bookmakerName ||
    obj.provider?.name ||
    obj.provider_name ||
    obj.providerName ||
    obj.source?.name ||
    obj.source_name ||
    obj.sourceName ||
    obj.bookmaker ||
    obj.provider ||
    null
  );
}

function marketContext(obj) {
  if (!obj || typeof obj !== "object") return "";

  const parts = [];

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
    "key"
  ];

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      parts.push(String(obj[key]));
    }
  }

  return parts.join(" ").toLowerCase().replace(/[,]/g, ".");
}

function classifyOddObject(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const context = marketContext(obj);
  const fullText = objectText(obj);

  const line = detectLine(
    `${context} ${fullText}`
  );

  const normalized = normalizeKey(context);

  let market = null;

  /* 1X2 */

  if (
    normalized.includes("1x2") ||
    normalized.includes("matchresult") ||
    normalized.includes("matchwinner") ||
    normalized.includes("threeway") ||
    normalized.includes("winner3way") ||
    normalized.includes("fulltimewinner")
  ) {
    const selection = normalized;

    if (
      selection.includes("home") ||
      selection.includes("1") ||
      /\bhome\b/i.test(context)
    ) {
      market = "home";
    } else if (
      selection.includes("draw") ||
      selection.includes("tie") ||
      selection.includes("x")
    ) {
      market = "draw";
    } else if (
      selection.includes("away") ||
      selection.includes("2") ||
      /\baway\b/i.test(context)
    ) {
      market = "away";
    }
  }

  /* Direct aliases */

  if (!market) {
    if (
      normalized.includes("1x2homeft") ||
      normalized.includes("homewin") ||
      normalized.includes("hometeam")
    ) {
      market = "home";
    }

    if (
      normalized.includes("1x2drawft") ||
      normalized.includes("draw")
    ) {
      market = "draw";
    }

    if (
      normalized.includes("1x2awayft") ||
      normalized.includes("awaywin") ||
      normalized.includes("awayteam")
    ) {
      market = "away";
    }
  }

  /* Over / Under */

  if (!market && line !== null) {
    const over =
      normalized.includes("over") ||
      normalized.includes("ou") && fullText.includes("over");

    const under =
      normalized.includes("under") ||
      normalized.includes("ou") && fullText.includes("under");

    if (over || under) {
      const prefix = over ? "over" : "under";
      market = `${prefix}${String(line).replace(".", "")}`;
    }
  }

  /* BTTS */

  if (
    !market &&
    (
      normalized.includes("btts") ||
      fullText.includes("both teams to score") ||
      fullText.includes("bothteamstoscore")
    )
  ) {
    if (
      normalized.includes("yes") ||
      fullText.includes('"yes"')
    ) {
      market = "bttsYes";
    } else if (
      normalized.includes("no") ||
      fullText.includes('"no"')
    ) {
      market = "bttsNo";
    }
  }

  return market
    ? {
        market,
        price: getPriceFromObject(obj),
        movement: getMovement(obj),
        bookmaker: getBookmakerName(obj),
        line,
        context
      }
    : null;
}

function recursivelyFindOddObjects(value, output = []) {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      recursivelyFindOddObjects(item, output);
    }

    return output;
  }

  const classified = classifyOddObject(value);

  if (classified) {
    output.push(classified);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      recursivelyFindOddObjects(child, output);
    }
  }

  return output;
}

function parseFlattenedOdds(payload, parsed) {
  const flat = flattenObject(payload);

  for (const item of flat) {
    const path = item.path.toLowerCase().replace(/[,]/g, ".");
    const value = num(item.value);

    if (value === null || value < 1) continue;

    if (
      path.includes("home_odds") ||
      path.includes("odds_home") ||
      path.endsWith(".home") ||
      path.endsWith("[home].price")
    ) {
      parsed.home = Math.max(parsed.home || 0, value);
    }

    if (
      path.includes("draw_odds") ||
      path.includes("odds_draw") ||
      path.endsWith(".draw")
    ) {
      parsed.draw = Math.max(parsed.draw || 0, value);
    }

    if (
      path.includes("away_odds") ||
      path.includes("odds_away") ||
      path.endsWith(".away")
    ) {
      parsed.away = Math.max(parsed.away || 0, value);
    }

    const line = detectLine(path);

    if (line === 1.5) {
      if (path.includes("over")) {
        parsed.over15 = Math.max(parsed.over15 || 0, value);
      }

      if (path.includes("under")) {
        parsed.under15 = Math.max(parsed.under15 || 0, value);
      }
    }

    if (line === 2.5) {
      if (path.includes("over")) {
        parsed.over25 = Math.max(parsed.over25 || 0, value);
      }

      if (path.includes("under")) {
        parsed.under25 = Math.max(parsed.under25 || 0, value);
      }
    }

    if (line === 3.5) {
      if (path.includes("over")) {
        parsed.over35 = Math.max(parsed.over35 || 0, value);
      }

      if (path.includes("under")) {
        parsed.under35 = Math.max(parsed.under35 || 0, value);
      }
    }

    if (
      path.includes("btts") &&
      path.includes("yes")
    ) {
      parsed.bttsYes = Math.max(parsed.bttsYes || 0, value);
    }

    if (
      path.includes("btts") &&
      path.includes("no")
    ) {
      parsed.bttsNo = Math.max(parsed.bttsNo || 0, value);
    }
  }
}

function parseOdds(payload) {
  const parsed = {
    home: null,
    draw: null,
    away: null,

    over15: null,
    under15: null,

    over25: null,
    under25: null,

    over35: null,
    under35: null,

    bttsYes: null,
    bttsNo: null,

    updatedAt: null,
    lastChangeAt: null,
    nextUpdateAt: null,
    interval: null,

    bookmakers: [],

    rawCount: countPayload(payload),

    movementByMarket: {}
  };

  if (!payload) {
    return parsed;
  }

  const bookmakerNames = new Set();

  /* Recursive parser */

  const candidates = recursivelyFindOddObjects(payload);

  for (const candidate of candidates) {
    if (candidate.bookmaker) {
      bookmakerNames.add(String(candidate.bookmaker));
    }

    if (candidate.price === null) {
      continue;
    }

    const market = candidate.market;

    if (!market) continue;

    /* Keep the best available decimal price */

    if (market === "home") {
      parsed.home = Math.max(
        parsed.home || 0,
        candidate.price
      );
    }

    if (market === "draw") {
      parsed.draw = Math.max(
        parsed.draw || 0,
        candidate.price
      );
    }

    if (market === "away") {
      parsed.away = Math.max(
        parsed.away || 0,
        candidate.price
      );
    }

    if (market === "over15") {
      parsed.over15 = Math.max(
        parsed.over15 || 0,
        candidate.price
      );
    }

    if (market === "under15") {
      parsed.under15 = Math.max(
        parsed.under15 || 0,
        candidate.price
      );
    }

    if (market === "over25") {
      parsed.over25 = Math.max(
        parsed.over25 || 0,
        candidate.price
      );
    }

    if (market === "under25") {
      parsed.under25 = Math.max(
        parsed.under25 || 0,
        candidate.price
      );
    }

    if (market === "over35") {
      parsed.over35 = Math.max(
        parsed.over35 || 0,
        candidate.price
      );
    }

    if (market === "under35") {
      parsed.under35 = Math.max(
        parsed.under35 || 0,
        candidate.price
      );
    }

    if (market === "bttsYes") {
      parsed.bttsYes = Math.max(
        parsed.bttsYes || 0,
        candidate.price
      );
    }

    if (market === "bttsNo") {
      parsed.bttsNo = Math.max(
        parsed.bttsNo || 0,
        candidate.price
      );
    }

    if (candidate.movement) {
      const old = parsed.movementByMarket[market];

      const movement = candidate.movement;

      let direction = movement.direction;

      if (!direction && old?.direction) {
        direction = old.direction;
      }

      parsed.movementByMarket[market] = {
        direction: direction || "STABLE",

        previous:
          movement.previous ??
          old?.previous ??
          null,

        opening:
          movement.opening ??
          old?.opening ??
          null,

        current:
          movement.current ??
          candidate.price ??
          old?.current ??
          null,

        percent:
          movement.percent ??
          old?.percent ??
          null
      };
    }
  }

  /* Flattened odds fallback */

  parseFlattenedOdds(payload, parsed);

  /* Generic timestamps */

  const flat = flattenObject(payload);

  for (const item of flat) {
    const path = item.path.toLowerCase();

    if (
      parsed.updatedAt === null &&
      (
        path.endsWith("updated_at") ||
        path.endsWith("updatedat") ||
        path.endsWith("last_updated")
      )
    ) {
      parsed.updatedAt = item.value;
    }

    if (
      parsed.lastChangeAt === null &&
      (
        path.includes("last_change_at") ||
        path.includes("lastchangeat")
      )
    ) {
      parsed.lastChangeAt = item.value;
    }

    if (
      parsed.nextUpdateAt === null &&
      (
        path.includes("next_update_at") ||
        path.includes("nextupdateat")
      )
    ) {
      parsed.nextUpdateAt = item.value;
    }

    if (
      parsed.interval === null &&
      path.endsWith("interval")
    ) {
      parsed.interval = num(item.value);
    }
  }

  parsed.bookmakers = [...bookmakerNames];

  return parsed;
}

function oddsHasAnyMarket(odds) {
  if (!odds) return false;

  return [
    odds.home,
    odds.draw,
    odds.away,
    odds.over15,
    odds.under15,
    odds.over25,
    odds.under25,
    odds.over35,
    odds.under35,
    odds.bttsYes,
    odds.bttsNo
  ].some(
    value =>
      num(value) !== null &&
      num(value) >= 1
  );
}

async function getOdds(eventId) {
  const diagnostics = [];

  const paths = [
    `/odds/?event_id=${eventId}`,
    `/odds/?event=${eventId}`,
    `/odds/${eventId}/`
  ];

  for (const path of paths) {
    try {
      const result = await bsdFetch(path);

      const parsed = parseOdds(result.payload);

      const hasParsed = oddsHasAnyMarket(parsed);

      diagnostics.push({
        path,
        status: result.status,
        count: result.count,
        parsed: hasParsed,
        parsedMarkets: hasParsed
          ? Object.entries(parsed)
              .filter(([key, value]) =>
                [
                  "home",
                  "draw",
                  "away",
                  "over15",
                  "under15",
                  "over25",
                  "under25",
                  "over35",
                  "under35",
                  "bttsYes",
                  "bttsNo"
                ].includes(key) &&
                num(value) !== null
              )
              .map(([key]) => key)
          : null,
        parsedBookmakers: parsed.bookmakers?.length || 0
      });

      /*
       * Important:
       * The BSD endpoint can return a valid odds payload even
       * when extractResults() cannot identify a normal results array.
       * Therefore we rely on parseOdds(payload), not only results.
       */

      if (result.ok && hasParsed) {
        return {
          odds: parsed,
          diagnostics,
          raw: result.payload
        };
      }

      /*
       * If the endpoint is 200 and contains odds-like structures,
       * keep trying only if the parser found nothing.
       */

    } catch (error) {
      diagnostics.push({
        path,
        error: error.message
      });
    }
  }

  return {
    odds: null,
    diagnostics,
    raw: null
  };
}

/* =========================================================
   H2H
========================================================= */

function parseH2H(payload) {
  const rows = extractResults(payload);

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let totalGoals = 0;
  let goalsSamples = 0;

  for (const row of rows) {
    const homeScore = firstNum(
      row?.home_score,
      row?.homeScore,
      row?.scores?.home,
      row?.score?.home
    );

    const awayScore = firstNum(
      row?.away_score,
      row?.awayScore,
      row?.scores?.away,
      row?.score?.away
    );

    if (homeScore === null || awayScore === null) {
      continue;
    }

    if (homeScore > awayScore) homeWins++;
    else if (homeScore < awayScore) awayWins++;
    else draws++;

    totalGoals += homeScore + awayScore;
    goalsSamples++;
  }

  return {
    sampleSize: homeWins + draws + awayWins,
    homeWins,
    draws,
    awayWins,
    avgGoals:
      goalsSamples > 0
        ? totalGoals / goalsSamples
        : null
  };
}

async function getH2H(event) {
  /*
   * Embedded H2H is preferred when BSD provides it.
   */
  if (event?.head_to_head) {
    return parseH2H(event.head_to_head);
  }

  if (event?.h2h) {
    return parseH2H(event.h2h);
  }

  /*
   * Do not fabricate H2H.
   */
  return {
    sampleSize: 0,
    homeWins: 0,
    draws: 0,
    awayWins: 0,
    avgGoals: null
  };
}

/* =========================================================
   LINEUPS / REFEREE
========================================================= */

function parseLineups(event) {
  const lineups =
    event?.lineups ||
    event?.lineup ||
    null;

  if (!lineups) {
    return {
      available: false,
      confirmed: false,
      homePlayers: 0,
      awayPlayers: 0,
      homeFormation: null,
      awayFormation: null
    };
  }

  const home =
    lineups.home ||
    lineups.home_team ||
    {};

  const away =
    lineups.away ||
    lineups.away_team ||
    {};

  const homePlayers =
    Array.isArray(home.players)
      ? home.players.length
      : Array.isArray(home)
        ? home.length
        : 0;

  const awayPlayers =
    Array.isArray(away.players)
      ? away.players.length
      : Array.isArray(away)
        ? away.length
        : 0;

  return {
    available:
      homePlayers > 0 ||
      awayPlayers > 0,

    confirmed:
      Boolean(
        lineups.confirmed ||
        lineups.is_confirmed
      ),

    homePlayers,
    awayPlayers,

    homeFormation:
      home.formation ||
      home.tactics?.formation ||
      null,

    awayFormation:
      away.formation ||
      away.tactics?.formation ||
      null
  };
}

function parseReferee(event) {
  const referee =
    event?.referee ||
    event?.fixture?.referee ||
    null;

  if (!referee) return null;

  return {
    id:
      firstNum(referee.id) ??
      null,

    name:
      referee.name ||
      referee.full_name ||
      null
  };
}

/* =========================================================
   MOVEMENT
========================================================= */

function getMovementForMarket(market, odds) {
  if (!odds) {
    return {
      direction: "STABLE",
      previous: null,
      opening: null,
      current: null,
      percent: null
    };
  }

  if (
    odds.movementByMarket &&
    odds.movementByMarket[market]
  ) {
    return odds.movementByMarket[market];
  }

  return {
    direction: "STABLE",
    previous: null,
    opening: null,
    current: null,
    percent: null
  };
}

/* =========================================================
   CANDIDATES
========================================================= */

function fairOdds(probability) {
  if (probability === null || probability <= 0) {
    return null;
  }

  return 100 / probability;
}

function valuePercent(probability, odds) {
  if (
    probability === null ||
    odds === null ||
    odds <= 0
  ) {
    return null;
  }

  return ((probability / 100) * odds - 1) * 100;
}

function probabilityScore(probability) {
  if (probability === null) return 0;

  return Math.max(
    0,
    Math.min(
      100,
      probability
    )
  );
}

function movementBonus(movement) {
  if (!movement) return 0;

  if (movement.direction === "SHORTENING") {
    return 10;
  }

  if (movement.direction === "DRIFTING") {
    return -5;
  }

  return 0;
}

function buildCandidate(
  market,
  label,
  probability,
  odds,
  prediction,
  movement
) {
  if (
    probability === null ||
    odds === null ||
    odds < 1
  ) {
    return null;
  }

  const fair = fairOdds(probability);
  const value = valuePercent(
    probability,
    odds
  );

  const score = Math.max(
    0,
    Math.min(
      100,
      probabilityScore(probability) +
        movementBonus(movement)
    )
  );

  return {
    market,
    label,
    probability,
    odds,
    fairOdds: fair,
    valuePercent: value,
    score,

    movement: {
      direction:
        movement?.direction ||
        "STABLE",

      previous:
        movement?.previous ??
        null,

      opening:
        movement?.opening ??
        null,

      percent:
        movement?.percent ??
        null
    },

    prediction
  };
}

function buildCandidates(prediction, odds) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  const definitions = [
    {
      market: "home",
      label: "Home",
      probability: prediction.home,
      odds: odds.home
    },
    {
      market: "draw",
      label: "Draw",
      probability: prediction.draw,
      odds: odds.draw
    },
    {
      market: "away",
      label: "Away",
      probability: prediction.away,
      odds: odds.away
    },

    {
      market: "over15",
      label: "Over 1.5",
      probability: prediction.over15,
      odds: odds.over15
    },
    {
      market: "over25",
      label: "Over 2.5",
      probability: prediction.over25,
      odds: odds.over25
    },
    {
      market: "over35",
      label: "Over 3.5",
      probability: prediction.over35,
      odds: odds.over35
    },

    {
      market: "bttsYes",
      label: "BTTS Yes",
      probability: prediction.bttsYes,
      odds: odds.bttsYes
    }
  ];

  for (const definition of definitions) {
    const movement = getMovementForMarket(
      definition.market,
      odds
    );

    const candidate = buildCandidate(
      definition.market,
      definition.label,
      definition.probability,
      definition.odds,
      prediction,
      movement
    );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

/* =========================================================
   QUALIFICATION
========================================================= */

function qualifies(candidate) {
  const p = candidate.probability;
  const score = candidate.score;
  const value = candidate.valuePercent;
  const odds = candidate.odds;

  if (
    p === null ||
    score === null ||
    value === null ||
    odds === null
  ) {
    return false;
  }

  const highProbability =
    p >= FILTERS.highProbabilityMin &&
    score >= FILTERS.highProbabilityScoreMin &&
    value >= FILTERS.highProbabilityValueMin &&
    odds >= FILTERS.minimumOddsForHighProbability;

  const strongProbability =
    p >= FILTERS.strongProbabilityMin &&
    score >= FILTERS.strongProbabilityScoreMin &&
    value >= FILTERS.strongProbabilityValueMin;

  const valuePick =
    score >= FILTERS.valueScoreMin &&
    p >= FILTERS.valueProbabilityMin &&
    value >= FILTERS.valuePercentMin;

  return (
    highProbability ||
    strongProbability ||
    valuePick
  );
}

function qualificationType(candidate) {
  const p = candidate.probability;
  const score = candidate.score;
  const value = candidate.valuePercent;
  const odds = candidate.odds;

  if (
    p >= FILTERS.strongProbabilityMin &&
    score >= FILTERS.strongProbabilityScoreMin &&
    value >= FILTERS.strongProbabilityValueMin
  ) {
    return "STRONG_PROBABILITY";
  }

  if (
    p >= FILTERS.highProbabilityMin &&
    score >= FILTERS.highProbabilityScoreMin &&
    value >= FILTERS.highProbabilityValueMin &&
    odds >= FILTERS.minimumOddsForHighProbability
  ) {
    return "HIGH_PROBABILITY";
  }

  if (
    score >= FILTERS.valueScoreMin &&
    p >= FILTERS.valueProbabilityMin &&
    value >= FILTERS.valuePercentMin
  ) {
    return "VALUE";
  }

  return null;
}

/* =========================================================
   EVENT ANALYSIS
========================================================= */

async function analyzeEvent(
  event,
  predictionMap,
  predictionMeta
) {
  const prediction =
    predictionMap.get(
      String(event.id)
    ) || null;

  const oddsResult =
    await getOdds(event.id);

  const odds =
    oddsResult.odds || null;

  const h2h =
    await getH2H(event);

  const lineups =
    parseLineups(event);

  const referee =
    parseReferee(event);

  const candidates =
    buildCandidates(
      prediction,
      odds
    );

  return {
    event,

    predictionAvailable:
      Boolean(prediction),

    oddsAvailable:
      Boolean(odds && oddsHasAnyMarket(odds)),

    prediction,

    odds,

    h2h,

    lineups,

    referee,

    candidates,

    predictionDebug: {
      source: predictionMeta.source,
      count: predictionMeta.count,
      matchedEventId:
        prediction
          ? event.id
          : null,
      diagnostics:
        predictionMeta.diagnostics
    },

    oddsDebug:
      oddsResult.diagnostics,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      signal: null,
      note:
        "Exchange data is not available. No exchange signal is fabricated."
    },

    error: null
  };
}

/* =========================================================
   TOP PICKS
========================================================= */

async function getTopPicks(date) {
  const eventResult =
    await getEvents(date);

  const allEvents =
    eventResult.events || [];

  const upcomingEvents =
    allEvents
      .filter(isUpcoming)
      .slice(0, 10);

  const predictionData =
    await getPredictions(
      upcomingEvents
    );

  const analyzed = [];

  for (const event of upcomingEvents) {
    try {
      const result =
        await analyzeEvent(
          event,
          predictionData.byId,
          predictionData
        );

      analyzed.push(result);
    } catch (error) {
      analyzed.push({
        event,

        predictionAvailable: false,
        oddsAvailable: false,

        prediction: null,
        odds: null,

        h2h: {
          sampleSize: 0,
          homeWins: 0,
          draws: 0,
          awayWins: 0,
          avgGoals: null
        },

        lineups: {
          available: false,
          confirmed: false,
          homePlayers: 0,
          awayPlayers: 0,
          homeFormation: null,
          awayFormation: null
        },

        referee: null,
        candidates: [],

        predictionDebug: {
          source: predictionData.source,
          count: predictionData.count,
          matchedEventId: null,
          diagnostics:
            predictionData.diagnostics
        },

        oddsDebug: [],

        exchange: {
          connected: false,
          status: "NOT_CONNECTED",
          signal: null,
          note:
            "Exchange data is not available. No exchange signal is fabricated."
        },

        error: error.message
      });
    }
  }

  const qualified = [];

  for (const item of analyzed) {
    for (const candidate of item.candidates) {
      if (!qualifies(candidate)) {
        continue;
      }

      const type =
        qualificationType(candidate);

      if (!type) continue;

      qualified.push({
        event: item.event,
        type,
        candidate,
        prediction: item.prediction,
        odds: item.odds,
        h2h: item.h2h,
        lineups: item.lineups,
        referee: item.referee,
        exchange: item.exchange
      });
    }
  }

  /*
   * No artificial filling.
   * We only return candidates that actually meet
   * the configured filters.
   */

  qualified.sort(
    (a, b) => {
      const scoreDiff =
        b.candidate.score -
        a.candidate.score;

      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const probabilityDiff =
        b.candidate.probability -
        a.candidate.probability;

      if (probabilityDiff !== 0) {
        return probabilityDiff;
      }

      return (
        (b.candidate.valuePercent || 0) -
        (a.candidate.valuePercent || 0)
      );
    }
  );

  const picks =
    qualified
      .slice(0, MAX_TOP_PICKS)
      .map(item => ({
        event: item.event,

        market:
          item.candidate.market,

        label:
          item.candidate.label,

        probability:
          item.candidate.probability,

        odds:
          item.candidate.odds,

        fairOdds:
          item.candidate.fairOdds,

        valuePercent:
          item.candidate.valuePercent,

        score:
          item.candidate.score,

        qualification:
          item.type,

        movement:
          item.candidate.movement,

        prediction:
          item.prediction,

        h2h:
          item.h2h,

        lineups:
          item.lineups,

        referee:
          item.referee,

        exchange:
          item.exchange
      }));

  const eventsExcluded =
    Math.max(
      0,
      allEvents.length -
        upcomingEvents.length
    );

  return {
    version: VERSION,
    source: SOURCE,
    date,

    eventsReturned:
      allEvents.length,

    upcomingEvents:
      upcomingEvents.length,

    eventsAnalyzed:
      analyzed.length,

    eventsExcluded,

    qualificationCount:
      qualified.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    filters: FILTERS,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      note:
        "No exchange signal is fabricated."
    },

    picks,

    analyzed
  };
}

/* =========================================================
   API
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    exchange: {
      connected: false,
      status: "NOT_CONNECTED"
    }
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date()
        .toISOString()
        .slice(0, 10);

    const result =
      await getEvents(date);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,

      count:
        result.events.length,

      events:
        result.events.slice(
          0,
          MAX_EVENTS
        ),

      diagnostics:
        result.diagnostics
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      error: error.message
    });
  }
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date()
        .toISOString()
        .slice(0, 10);

    const result =
      await getTopPicks(date);

    res.json(result);
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      date: req.query.date || null,
      error: error.message
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const eventId =
      firstNum(
        req.query.eventId,
        req.query.event_id,
        req.query.id
      );

    if (!eventId) {
      return res.status(400).json({
        version: VERSION,
        source: SOURCE,
        error:
          "Missing eventId"
      });
    }

    const eventResult =
      await bsdFetch(
        `/events/${eventId}/`
      );

    let event =
      eventResult.ok
        ? normalizeEvent(
            eventResult.payload
          )
        : null;

    if (!event || !event.id) {
      const oddsResult =
        await getOdds(eventId);

      return res.json({
        version: VERSION,
        source: SOURCE,
        event: {
          id: eventId
        },
        eventFetch: {
          status:
            eventResult.status,
          count:
            eventResult.count
        },
        odds:
          oddsResult.odds,
        oddsDebug:
          oddsResult.diagnostics
      });
    }

    const predictionData =
      await getPredictions([event]);

    const result =
      await analyzeEvent(
        event,
        predictionData.byId,
        predictionData
      );

    res.json({
      version: VERSION,
      source: SOURCE,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
