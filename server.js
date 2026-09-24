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

const VERSION = "6.5.6";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

// --------------------------------------------------
// FILTERS
// --------------------------------------------------

const FILTERS = {
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -8,
  minimumOddsForHighProbability: 1.20,

  strongProbabilityMin: 70,
  strongProbabilityScoreMin: 60,
  strongProbabilityValueMin: -3,

  valueScoreMin: 35,
  valueProbabilityMin: 55,
  valuePercentMin: 5
};

// --------------------------------------------------
// BASIC HELPERS
// --------------------------------------------------

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function normalizeProbability(value) {
  const n = num(value);

  if (n === null) return null;

  // BSD prediction endpoints can return either:
  // 0.725 or 72.5
  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function normalizeConfidence(value) {
  const n = num(value);

  if (n === null) return null;

  if (n > 1 && n <= 100) {
    return n / 100;
  }

  return n;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();

  return text || null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
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

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  if (Array.isArray(payload.predictions)) {
    return payload.predictions;
  }

  if (Array.isArray(payload.odds)) {
    return payload.odds;
  }

  return [];
}

function toDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d;
}

function isUpcomingEvent(event) {
  if (!event) return false;

  const status = String(
    firstDefined(event.status, event.event_status, "")
  ).toLowerCase();

  const date = toDate(
    firstDefined(
      event.event_date,
      event.date,
      event.start_time,
      event.startTime,
      event.kickoff
    )
  );

  if (!date) return false;

  const now = Date.now();

  const excludedStatuses = [
    "finished",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "live",
    "inplay",
    "in_play"
  ];

  if (excludedStatuses.includes(status)) {
    return false;
  }

  return date.getTime() > now;
}

// --------------------------------------------------
// BSD REQUEST
// --------------------------------------------------

async function bsdRequest(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

// --------------------------------------------------
// EVENTS
// --------------------------------------------------

function parseEvent(raw) {
  if (!raw) return null;

  const event = raw.event && typeof raw.event === "object"
    ? raw.event
    : raw;

  const id = num(
    firstDefined(
      event.id,
      event.event_id,
      raw.event_id
    )
  );

  if (!id) return null;

  const home =
    cleanText(
      firstDefined(
        event.home_team,
        event.home_team_name,
        event.home,
        raw.home_team,
        raw.home_team_name
      )
    ) || "Home";

  const away =
    cleanText(
      firstDefined(
        event.away_team,
        event.away_team_name,
        event.away,
        raw.away_team,
        raw.away_team_name
      )
    ) || "Away";

  const date = firstDefined(
    event.event_date,
    event.date,
    event.start_time,
    event.startTime,
    raw.event_date,
    raw.date
  );

  const status = cleanText(
    firstDefined(
      event.status,
      event.event_status,
      raw.status
    )
  );

  const leagueId = num(
    firstDefined(
      event.league_id,
      event.leagueId,
      raw.league_id
    )
  );

  const league = cleanText(
    firstDefined(
      event.league_name,
      event.league,
      raw.league_name,
      raw.league
    )
  );

  return {
    id,
    home,
    away,
    date,
    status,
    leagueId,
    league
  };
}

// --------------------------------------------------
// PREDICTION PARSER
// --------------------------------------------------

function parsePrediction(raw) {
  if (!raw) return null;

  const markets =
    raw.markets && typeof raw.markets === "object"
      ? raw.markets
      : {};

  const matchResult =
    markets.match_result &&
    typeof markets.match_result === "object"
      ? markets.match_result
      : {};

  const overUnder =
    markets.over_under &&
    typeof markets.over_under === "object"
      ? markets.over_under
      : {};

  const btts =
    markets.btts &&
    typeof markets.btts === "object"
      ? markets.btts
      : {};

  const expectedGoals =
    markets.expected_goals &&
    typeof markets.expected_goals === "object"
      ? markets.expected_goals
      : {};

  const score =
    markets.score &&
    typeof markets.score === "object"
      ? markets.score
      : {};

  const model =
    raw.model &&
    typeof raw.model === "object"
      ? raw.model
      : {};

  const home = normalizeProbability(
    firstDefined(
      matchResult.prob_home,
      raw.prob_home,
      raw.home_probability,
      raw.home
    )
  );

  const draw = normalizeProbability(
    firstDefined(
      matchResult.prob_draw,
      raw.prob_draw,
      raw.draw_probability,
      raw.draw
    )
  );

  const away = normalizeProbability(
    firstDefined(
      matchResult.prob_away,
      raw.prob_away,
      raw.away_probability,
      raw.away
    )
  );

  const over15 = normalizeProbability(
    firstDefined(
      overUnder.prob_over_15,
      raw.prob_over_15,
      raw.over15
    )
  );

  const over25 = normalizeProbability(
    firstDefined(
      overUnder.prob_over_25,
      raw.prob_over_25,
      raw.over25
    )
  );

  const over35 = normalizeProbability(
    firstDefined(
      overUnder.prob_over_35,
      raw.prob_over_35,
      raw.over35
    )
  );

  const bttsYes = normalizeProbability(
    firstDefined(
      btts.prob_yes,
      raw.prob_btts_yes,
      raw.bttsYes
    )
  );

  const xgHome = num(
    firstDefined(
      expectedGoals.home,
      raw.xg_home,
      raw.expected_goals_home
    )
  );

  const xgAway = num(
    firstDefined(
      expectedGoals.away,
      raw.xg_away,
      raw.expected_goals_away
    )
  );

  const confidence = normalizeConfidence(
    firstDefined(
      model.confidence,
      raw.confidence
    )
  );

  const predicted = cleanText(
    firstDefined(
      matchResult.predicted,
      raw.predicted,
      raw.prediction
    )
  );

  const mostLikelyScore = cleanText(
    firstDefined(
      score.most_likely,
      raw.most_likely_score,
      raw.mostLikelyScore
    )
  );

  const hasProbability =
    home !== null ||
    draw !== null ||
    away !== null ||
    over15 !== null ||
    over25 !== null ||
    over35 !== null ||
    bttsYes !== null;

  if (!hasProbability) {
    return null;
  }

  return {
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    xgHome,
    xgAway,
    confidence,
    predicted,
    mostLikelyScore
  };
}

// --------------------------------------------------
// GLOBAL PREDICTIONS
// --------------------------------------------------

async function getAllPredictions() {
  const diagnostics = [];

  const paths = [
    "/predictions/?upcoming=true&limit=200",
    "/predictions/?limit=200"
  ];

  for (const path of paths) {
    try {
      const response = await bsdRequest(path);

      const rows = extractResults(response.data);

      diagnostics.push({
        path,
        status: response.status,
        count: rows.length
      });

      if (!response.ok || !rows.length) {
        continue;
      }

      return {
        rows,
        diagnostics,
        status: response.status
      };
    } catch (error) {
      diagnostics.push({
        path,
        error: error.message
      });
    }
  }

  return {
    rows: [],
    diagnostics
  };
}

function findPredictionForEvent(eventId, predictionRows) {
  const wanted = Number(eventId);

  for (const raw of predictionRows) {
    const predictionEvent =
      raw &&
      raw.event &&
      typeof raw.event === "object"
        ? raw.event
        : null;

    const candidateId = num(
      firstDefined(
        predictionEvent?.id,
        predictionEvent?.event_id,
        raw?.event_id
      )
    );

    if (candidateId === wanted) {
      return raw;
    }
  }

  return null;
}

// --------------------------------------------------
// ODDS HELPERS
// --------------------------------------------------

function normalizeSelectionName(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function parseMarketKey(row) {
  const text = [
    row?.market,
    row?.market_name,
    row?.market_kind,
    row?.market_family,
    row?.market_code,
    row?.code,
    row?.market_type
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  if (
    text.includes("1X2") ||
    text.includes("MATCH_RESULT") ||
    text.includes("MATCH RESULT") ||
    text === "HOME" ||
    text === "DRAW" ||
    text === "AWAY"
  ) {
    return "1x2";
  }

  if (
    text.includes("BTTS") ||
    text.includes("BOTH_TEAMS") ||
    text.includes("BOTH TEAMS")
  ) {
    return "btts";
  }

  if (
    text.includes("OVER_UNDER") ||
    text.includes("OVER/UNDER") ||
    text.includes("OU_") ||
    text.includes("TOTAL")
  ) {
    return "ou";
  }

  return null;
}

function detectOuLine(row) {
  const values = [
    row?.market_line,
    row?.line,
    row?.total,
    row?.points,
    row?.handicap
  ];

  for (const value of values) {
    const n = num(value);

    if (n !== null && [1.5, 2.5, 3.5].includes(n)) {
      return n;
    }

    if (typeof value === "string") {
      const match = value.match(/([123]\.5)/);

      if (match) {
        return Number(match[1]);
      }
    }
  }

  const text = JSON.stringify(row || "");

  for (const line of [1.5, 2.5, 3.5]) {
    if (text.includes(String(line))) {
      return line;
    }
  }

  return null;
}

function detectSelection(row) {
  return normalizeSelectionName(
    firstDefined(
      row?.selection,
      row?.selection_name,
      row?.outcome,
      row?.outcome_name,
      row?.side,
      row?.name,
      row?.code
    )
  );
}

function getPriceFromObject(obj) {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "number") {
    return num(obj);
  }

  if (typeof obj === "string") {
    return num(obj);
  }

  if (typeof obj === "object") {
    return num(
      firstDefined(
        obj.price,
        obj.odds,
        obj.odd,
        obj.value,
        obj.decimal,
        obj.current
      )
    );
  }

  return null;
}

function movementObjectFromRow(row, selection) {
  const explicit =
    firstDefined(
      row?.movement,
      row?.movement_direction,
      row?.movement_type,
      row?.direction
    );

  let direction = cleanText(explicit);

  const previous = num(
    firstDefined(
      row?.previous,
      row?.previous_odds,
      row?.prev_odds,
      row?.odds_previous
    )
  );

  const opening = num(
    firstDefined(
      row?.opening,
      row?.opening_odds,
      row?.open_odds
    )
  );

  const current = num(
    firstDefined(
      row?.current,
      row?.current_odds,
      row?.odds,
      row?.price,
      row?.decimal
    )
  );

  if (!direction && previous !== null && current !== null) {
    if (current < previous) {
      direction = "SHORTENING";
    } else if (current > previous) {
      direction = "DRIFTING";
    } else {
      direction = "STABLE";
    }
  }

  if (!direction && opening !== null && current !== null) {
    if (current < opening) {
      direction = "SHORTENING";
    } else if (current > opening) {
      direction = "DRIFTING";
    } else {
      direction = "STABLE";
    }
  }

  if (direction) {
    direction = direction.toUpperCase();
  }

  return {
    selection,
    direction: direction || "UNKNOWN",
    current,
    previous,
    opening,
    lastChangeAt: firstDefined(
      row?.last_change_at,
      row?.lastChangeAt,
      row?.changed_at,
      row?.updated_at
    ),
    updatedAt: firstDefined(
      row?.updated_at,
      row?.updatedAt
    )
  };
}

function combineMovement(list) {
  if (!list.length) {
    return {
      direction: "UNKNOWN",
      current: null,
      previous: null,
      opening: null,
      lastChangeAt: null,
      updatedAt: null,
      bookmakerCount: 0
    };
  }

  const directions = list.map(x => x.direction);

  let direction = "STABLE";

  if (directions.includes("SHORTENING")) {
    direction = "SHORTENING";
  } else if (directions.includes("DRIFTING")) {
    direction = "DRIFTING";
  } else if (directions.includes("UNKNOWN")) {
    direction = "UNKNOWN";
  }

  const currents = list
    .map(x => x.current)
    .filter(x => x !== null);

  const previous = list
    .map(x => x.previous)
    .find(x => x !== null) ?? null;

  const opening = list
    .map(x => x.opening)
    .find(x => x !== null) ?? null;

  const lastChangeAt = list
    .map(x => x.lastChangeAt)
    .filter(Boolean)
    .sort()
    .pop() || null;

  const updatedAt = list
    .map(x => x.updatedAt)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    direction,
    current: currents.length ? Math.min(...currents) : null,
    previous,
    opening,
    lastChangeAt,
    updatedAt,
    bookmakerCount: list.length
  };
}

// --------------------------------------------------
// ODDS PARSER
// --------------------------------------------------

function parseOdds(raw) {
  if (!raw) return null;

  const odds = {
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
    rawCount: 0,

    movementByMarket: {}
  };

  const movementLists = {
    home: [],
    draw: [],
    away: [],
    over15: [],
    under15: [],
    over25: [],
    under25: [],
    over35: [],
    under35: [],
    bttsYes: [],
    bttsNo: []
  };

  const rows = [];

  if (Array.isArray(raw)) {
    rows.push(...raw);
  }

  if (raw.results && Array.isArray(raw.results)) {
    rows.push(...raw.results);
  }

  if (raw.data && Array.isArray(raw.data)) {
    rows.push(...raw.data);
  }

  if (raw.odds && Array.isArray(raw.odds)) {
    rows.push(...raw.odds);
  }

  // Current BSD can return grouped bookmakers/markets.
  if (Array.isArray(raw.bookmakers)) {
    for (const bookmaker of raw.bookmakers) {
      rows.push({
        ...bookmaker,
        __groupedBookmaker: true
      });
    }
  }

  if (Array.isArray(raw.markets)) {
    for (const market of raw.markets) {
      rows.push({
        ...market,
        __groupedMarket: true
      });
    }
  }

  odds.rawCount = rows.length;

  function setBetter(key, value) {
    const price = num(value);

    if (price === null || price <= 1) {
      return;
    }

    if (
      odds[key] === null ||
      price > odds[key]
    ) {
      odds[key] = price;
    }
  }

  function registerMovement(key, movement) {
    if (!movement) return;

    movementLists[key].push(movement);
  }

  function registerSelection(
    marketType,
    selection,
    price,
    row,
    line = null
  ) {
    const s = normalizeSelectionName(selection);

    if (marketType === "1x2") {
      if (
        ["HOME", "1", "HOME_TEAM", "1X2_HOME_FT"].includes(s)
      ) {
        setBetter("home", price);

        registerMovement(
          "home",
          movementObjectFromRow(row, s)
        );
      }

      if (
        ["DRAW", "X", "1X2_DRAW_FT"].includes(s)
      ) {
        setBetter("draw", price);

        registerMovement(
          "draw",
          movementObjectFromRow(row, s)
        );
      }

      if (
        ["AWAY", "2", "AWAY_TEAM", "1X2_AWAY_FT"].includes(s)
      ) {
        setBetter("away", price);

        registerMovement(
          "away",
          movementObjectFromRow(row, s)
        );
      }

      return;
    }

    if (marketType === "btts") {
      if (
        ["YES", "BTTS_YES", "BTTS_YES_FT", "TRUE"].includes(s)
      ) {
        setBetter("bttsYes", price);

        registerMovement(
          "bttsYes",
          movementObjectFromRow(row, s)
        );
      }

      if (
        ["NO", "BTTS_NO", "BTTS_NO_FT", "FALSE"].includes(s)
      ) {
        setBetter("bttsNo", price);

        registerMovement(
          "bttsNo",
          movementObjectFromRow(row, s)
        );
      }

      return;
    }

    if (marketType === "ou") {
      const normalizedLine = num(line);

      if (!normalizedLine) return;

      const isOver =
        s.includes("OVER") ||
        s === "O" ||
        s.includes("ABOVE");

      const isUnder =
        s.includes("UNDER") ||
        s === "U" ||
        s.includes("BELOW");

      if (normalizedLine === 1.5 && isOver) {
        setBetter("over15", price);

        registerMovement(
          "over15",
          movementObjectFromRow(row, s)
        );
      }

      if (normalizedLine === 1.5 && isUnder) {
        setBetter("under15", price);

        registerMovement(
          "under15",
          movementObjectFromRow(row, s)
        );
      }

      if (normalizedLine === 2.5 && isOver) {
        setBetter("over25", price);

        registerMovement(
          "over25",
          movementObjectFromRow(row, s)
        );
      }

      if (normalizedLine === 2.5 && isUnder) {
        setBetter("under25", price);

        registerMovement(
          "under25",
          movementObjectFromRow(row, s)
        );
      }

      if (normalizedLine === 3.5 && isOver) {
        setBetter("over35", price);

        registerMovement(
          "over35",
          movementObjectFromRow(row, s)
        );
      }

      if (normalizedLine === 3.5 && isUnder) {
        setBetter("under35", price);

        registerMovement(
          "under35",
          movementObjectFromRow(row, s)
        );
      }
    }
  }

  // ------------------------------------------------
  // Generic / flattened rows
  // ------------------------------------------------

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const bookmakerName = cleanText(
      firstDefined(
        row.bookmaker,
        row.bookmaker_name,
        row.bookmaker_slug,
        row.source
      )
    );

    if (
      bookmakerName &&
      !odds.bookmakers.includes(bookmakerName)
    ) {
      odds.bookmakers.push(bookmakerName);
    }

    odds.updatedAt =
      firstDefined(
        odds.updatedAt,
        row.updated_at,
        row.updatedAt
      );

    odds.lastChangeAt =
      firstDefined(
        odds.lastChangeAt,
        row.last_change_at,
        row.lastChangeAt
      );

    odds.nextUpdateAt =
      firstDefined(
        odds.nextUpdateAt,
        row.next_update_at,
        row.nextUpdateAt
      );

    odds.interval =
      firstDefined(
        odds.interval,
        row.interval
      );

    // Flattened 1X2
    if (
      row.odds_home !== undefined ||
      row.odds_draw !== undefined ||
      row.odds_away !== undefined
    ) {
      if (row.odds_home !== undefined) {
        setBetter("home", row.odds_home);

        registerMovement(
          "home",
          movementObjectFromRow(
            {
              ...row,
              current: row.odds_home,
              previous: firstDefined(
                row.previous_home,
                row.prev_home
              ),
              opening: firstDefined(
                row.opening_home,
                row.open_home
              ),
              movement: firstDefined(
                row.movement_home,
                row.movement
              )
            },
            "HOME"
          )
        );
      }

      if (row.odds_draw !== undefined) {
        setBetter("draw", row.odds_draw);

        registerMovement(
          "draw",
          movementObjectFromRow(
            {
              ...row,
              current: row.odds_draw,
              previous: firstDefined(
                row.previous_draw,
                row.prev_draw
              ),
              opening: firstDefined(
                row.opening_draw,
                row.open_draw
              ),
              movement: firstDefined(
                row.movement_draw,
                row.movement
              )
            },
            "DRAW"
          )
        );
      }

      if (row.odds_away !== undefined) {
        setBetter("away", row.odds_away);

        registerMovement(
          "away",
          movementObjectFromRow(
            {
              ...row,
              current: row.odds_away,
              previous: firstDefined(
                row.previous_away,
                row.prev_away
              ),
              opening: firstDefined(
                row.opening_away,
                row.open_away
              ),
              movement: firstDefined(
                row.movement_away,
                row.movement
              )
            },
            "AWAY"
          )
        );
      }
    }

    // Flattened market row
    const marketType = parseMarketKey(row);

    if (marketType) {
      const selection = detectSelection(row);
      const price = getPriceFromObject(
        firstDefined(
          row.price,
          row.odds,
          row.odd,
          row.current,
          row.decimal
        )
      );

      registerSelection(
        marketType,
        selection,
        price,
        row,
        detectOuLine(row)
      );
    }

    // Direct fields
    const directMappings = [
      ["over15", row.over15],
      ["under15", row.under15],
      ["over25", row.over25],
      ["under25", row.under25],
      ["over35", row.over35],
      ["under35", row.under35],
      ["bttsYes", row.btts_yes],
      ["bttsNo", row.btts_no]
    ];

    for (const [key, value] of directMappings) {
      if (value !== undefined && value !== null) {
        setBetter(key, value);

        registerMovement(
          key,
          movementObjectFromRow(
            {
              ...row,
              current: value
            },
            key
          )
        );
      }
    }

    // ----------------------------------------------
    // Nested prices
    // ----------------------------------------------

    if (
      row.prices &&
      typeof row.prices === "object"
    ) {
      const marketTypeNested = parseMarketKey(row);
      const lineNested = detectOuLine(row);

      for (const [selection, priceObj] of Object.entries(
        row.prices
      )) {
        const price = getPriceFromObject(priceObj);

        registerSelection(
          marketTypeNested,
          selection,
          price,
          {
            ...row,
            ...(
              priceObj &&
              typeof priceObj === "object"
                ? priceObj
                : {}
            )
          },
          lineNested
        );
      }
    }

    // ----------------------------------------------
    // Nested selections
    // ----------------------------------------------

    if (Array.isArray(row.selections)) {
      const marketTypeNested = parseMarketKey(row);
      const lineNested = detectOuLine(row);

      for (const selection of row.selections) {
        if (!selection) continue;

        const name = firstDefined(
          selection.name,
          selection.selection,
          selection.outcome,
          selection.code
        );

        const price = getPriceFromObject(
          firstDefined(
            selection.price,
            selection.odds,
            selection
          )
        );

        registerSelection(
          marketTypeNested,
          name,
          price,
          {
            ...row,
            ...selection
          },
          lineNested
        );
      }
    }
  }

  // ------------------------------------------------
  // Grouped nested markets/bookmakers
  // ------------------------------------------------

  const groupedMarkets = [];

  if (Array.isArray(raw.markets)) {
    groupedMarkets.push(...raw.markets);
  }

  for (const market of groupedMarkets) {
    if (!market || typeof market !== "object") {
      continue;
    }

    const marketType = parseMarketKey(market);
    const line = detectOuLine(market);

    const marketBookmakers = Array.isArray(
      market.bookmakers
    )
      ? market.bookmakers
      : [];

    for (const bookmaker of marketBookmakers) {
      if (!bookmaker || typeof bookmaker !== "object") {
        continue;
      }

      const bookmakerName = cleanText(
        firstDefined(
          bookmaker.bookmaker,
          bookmaker.bookmaker_name,
          bookmaker.bookmaker_slug,
          bookmaker.name
        )
      );

      if (
        bookmakerName &&
        !odds.bookmakers.includes(bookmakerName)
      ) {
        odds.bookmakers.push(bookmakerName);
      }

      const prices =
        bookmaker.prices &&
        typeof bookmaker.prices === "object"
          ? bookmaker.prices
          : {};

      for (const [
        selection,
        priceObj
      ] of Object.entries(prices)) {
        const price = getPriceFromObject(priceObj);

        registerSelection(
          marketType,
          selection,
          price,
          {
            ...market,
            ...bookmaker,
            ...(priceObj &&
            typeof priceObj === "object"
              ? priceObj
              : {})
          },
          line
        );
      }
    }
  }

  // ------------------------------------------------
  // Movement aggregation
  // ------------------------------------------------

  for (const key of Object.keys(movementLists)) {
    odds.movementByMarket[key] =
      combineMovement(movementLists[key]);
  }

  const hasOdds =
    odds.home !== null ||
    odds.draw !== null ||
    odds.away !== null ||
    odds.over15 !== null ||
    odds.over25 !== null ||
    odds.over35 !== null ||
    odds.bttsYes !== null ||
    odds.bttsNo !== null;

  if (!hasOdds) {
    return null;
  }

  return odds;
}

// --------------------------------------------------
// ODDS REQUEST
// --------------------------------------------------

async function getOdds(eventId) {
  const diagnostics = [];

  const paths = [
    `/odds/?event_id=${eventId}`,
    `/odds/?event=${eventId}`,
    `/odds/${eventId}/`
  ];

  for (const path of paths) {
    try {
      const response = await bsdRequest(path);

      const rows = extractResults(response.data);

      let rawCount = rows.length;

      if (
        response.data &&
        typeof response.data === "object"
      ) {
        if (Array.isArray(response.data.bookmakers)) {
          rawCount = Math.max(
            rawCount,
            response.data.bookmakers.length
          );
        }

        if (Array.isArray(response.data.markets)) {
          rawCount = Math.max(
            rawCount,
            response.data.markets.length
          );
        }

        if (typeof response.data.count === "number") {
          rawCount = Math.max(
            rawCount,
            response.data.count
          );
        }
      }

      diagnostics.push({
        path,
        status: response.status,
        count: rawCount
      });

      if (!response.ok) {
        continue;
      }

      const parsed = parseOdds(response.data);

      if (parsed) {
        return {
          available: true,
          data: parsed,
          raw: response.data,
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
    available: false,
    data: null,
    raw: null,
    diagnostics
  };
}

// --------------------------------------------------
// H2H
// --------------------------------------------------

function parseH2H(raw) {
  if (!raw) {
    return {
      sampleSize: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      avgGoals: null
    };
  }

  const rows =
    extractResults(raw);

  let sampleSize = 0;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let totalGoals = 0;

  for (const row of rows) {
    const homeScore = num(
      firstDefined(
        row.home_score,
        row.homeScore,
        row.score_home,
        row.home_goals
      )
    );

    const awayScore = num(
      firstDefined(
        row.away_score,
        row.awayScore,
        row.score_away,
        row.away_goals
      )
    );

    if (
      homeScore === null ||
      awayScore === null
    ) {
      continue;
    }

    sampleSize++;

    totalGoals += homeScore + awayScore;

    if (homeScore > awayScore) {
      homeWins++;
    } else if (homeScore < awayScore) {
      awayWins++;
    } else {
      draws++;
    }
  }

  return {
    sampleSize,
    homeWins,
    draws,
    awayWins,
    avgGoals:
      sampleSize > 0
        ? Number(
            (totalGoals / sampleSize).toFixed(3)
          )
        : null
  };
}

async function getH2H(event) {
  try {
    const paths = [
      `/events/${event.id}/`,
      `/head-to-head/?event_id=${event.id}`,
      `/h2h/?event_id=${event.id}`
    ];

    for (const path of paths) {
      try {
        const response = await bsdRequest(path);

        if (!response.ok) continue;

        const payload = response.data;

        if (
          payload &&
          payload.event &&
          payload.event.head_to_head
        ) {
          const parsed = parseH2H(
            payload.event.head_to_head
          );

          if (parsed.sampleSize > 0) {
            return parsed;
          }
        }

        const parsed = parseH2H(payload);

        if (parsed.sampleSize > 0) {
          return parsed;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }

  return parseH2H(null);
}

// --------------------------------------------------
// LINEUPS
// --------------------------------------------------

function parseLineups(raw) {
  if (!raw) {
    return {
      available: false,
      confirmed: false,
      homePlayers: 0,
      awayPlayers: 0,
      homeFormation: null,
      awayFormation: null
    };
  }

  const lineups =
    raw.lineups ||
    raw;

  const home =
    lineups.home &&
    typeof lineups.home === "object"
      ? lineups.home
      : {};

  const away =
    lineups.away &&
    typeof lineups.away === "object"
      ? lineups.away
      : {};

  const homePlayers = Array.isArray(
    home.players
  )
    ? home.players.length
    : num(home.player_count) || 0;

  const awayPlayers = Array.isArray(
    away.players
  )
    ? away.players.length
    : num(away.player_count) || 0;

  return {
    available:
      homePlayers > 0 ||
      awayPlayers > 0,

    confirmed: Boolean(
      firstDefined(
        raw.confirmed,
        raw.lineups_confirmed,
        home.confirmed,
        away.confirmed
      )
    ),

    homePlayers,
    awayPlayers,

    homeFormation: cleanText(
      firstDefined(
        home.formation,
        home.system
      )
    ),

    awayFormation: cleanText(
      firstDefined(
        away.formation,
        away.system
      )
    )
  };
}

async function getLineups(eventId) {
  try {
    const response =
      await bsdRequest(
        `/events/${eventId}/`
      );

    if (!response.ok) {
      return parseLineups(null);
    }

    return parseLineups(
      response.data?.event?.lineups ||
      response.data?.lineups
    );
  } catch {
    return parseLineups(null);
  }
}

// --------------------------------------------------
// REFEREE / STATS / FORM
// --------------------------------------------------

async function getEventDetail(eventId) {
  try {
    const response =
      await bsdRequest(
        `/events/${eventId}/`
      );

    if (!response.ok) {
      return null;
    }

    return response.data;
  } catch {
    return null;
  }
}

function extractReferee(detail) {
  const referee =
    detail?.event?.referee ||
    detail?.referee ||
    null;

  if (!referee) {
    return null;
  }

  return {
    id: num(referee.id),
    name: cleanText(
      firstDefined(
        referee.name,
        referee.full_name
      )
    )
  };
}

// --------------------------------------------------
// MOVEMENT
// --------------------------------------------------

function getMovementForMarket(
  market,
  odds
) {
  if (
    odds &&
    odds.movementByMarket &&
    odds.movementByMarket[market]
  ) {
    return odds.movementByMarket[market];
  }

  return {
    direction: "UNKNOWN",
    current: null,
    previous: null,
    opening: null,
    lastChangeAt: null,
    updatedAt: null,
    bookmakerCount: 0
  };
}

// --------------------------------------------------
// CANDIDATES
// --------------------------------------------------

function calculateValuePercent(
  probability,
  odds
) {
  if (
    probability === null ||
    odds === null ||
    odds <= 1
  ) {
    return null;
  }

  const implied =
    100 / odds;

  return Number(
    (
      probability -
      implied
    ).toFixed(4)
  );
}

function probabilityScore(
  probability,
  odds
) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  return Number(
    (
      probability *
      Math.min(
        1,
        Math.max(
          0.5,
          odds / 2
        )
      )
    ).toFixed(2)
  );
}

function valueScore(
  probability,
  odds,
  valuePercent
) {
  if (
    probability === null ||
    odds === null ||
    valuePercent === null
  ) {
    return null;
  }

  const p =
    Math.max(
      0,
      probability - 50
    );

  const v =
    Math.max(
      0,
      valuePercent + 10
    );

  return Number(
    (
      p * 0.7 +
      v * 3
    ).toFixed(2)
  );
}

function createCandidate(
  market,
  label,
  probability,
  oddsValue,
  prediction,
  odds
) {
  if (
    probability === null ||
    oddsValue === null ||
    oddsValue <= 1
  ) {
    return null;
  }

  const implied =
    Number(
      (100 / oddsValue).toFixed(4)
    );

  const valuePercent =
    calculateValuePercent(
      probability,
      oddsValue
    );

  const pScore =
    probabilityScore(
      probability,
      oddsValue
    );

  const vScore =
    valueScore(
      probability,
      oddsValue,
      valuePercent
    );

  if (
    pScore === null ||
    vScore === null
  ) {
    return null;
  }

  let accepted = false;
  let qualificationType = null;
  let priceAssessment = "NORMAL_PRICE";

  if (
    probability >=
      FILTERS.strongProbabilityMin &&
    pScore >=
      FILTERS.strongProbabilityScoreMin &&
    valuePercent >=
      FILTERS.strongProbabilityValueMin &&
    oddsValue >=
      FILTERS.minimumOddsForHighProbability
  ) {
    accepted = true;
    qualificationType =
      "STRONG_PROBABILITY";
  } else if (
    probability >=
      FILTERS.highProbabilityMin &&
    pScore >=
      FILTERS.highProbabilityScoreMin &&
    valuePercent >=
      FILTERS.highProbabilityValueMin &&
    oddsValue >=
      FILTERS.minimumOddsForHighProbability
  ) {
    accepted = true;
    qualificationType =
      "HIGH_PROBABILITY";
  } else if (
    probability >=
      FILTERS.valueProbabilityMin &&
    vScore >=
      FILTERS.valueScoreMin &&
    valuePercent >=
      FILTERS.valuePercentMin
  ) {
    accepted = true;
    qualificationType = "VALUE";
  }

  if (valuePercent >= 5) {
    priceAssessment = "VALUE_PRICE";
  } else if (valuePercent <= -8) {
    priceAssessment =
      "EXPENSIVE_PRICE";
  }

  return {
    market,
    label,

    probability: Number(
      probability.toFixed(2)
    ),

    odds: Number(
      oddsValue.toFixed(3)
    ),

    impliedProbability: implied,

    valuePercent,

    probabilityScore: pScore,
    valueScore: vScore,

    score: pScore,

    accepted,
    qualificationType,
    priceAssessment,

    movement:
      getMovementForMarket(
        market,
        odds
      ),

    prediction
  };
}

function buildCandidates(
  prediction,
  odds
) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  const definitions = [
    [
      "home",
      "Home win",
      prediction.home,
      odds.home
    ],
    [
      "draw",
      "Draw",
      prediction.draw,
      odds.draw
    ],
    [
      "away",
      "Away win",
      prediction.away,
      odds.away
    ],
    [
      "over15",
      "Over 1.5 goals",
      prediction.over15,
      odds.over15
    ],
    [
      "over25",
      "Over 2.5 goals",
      prediction.over25,
      odds.over25
    ],
    [
      "over35",
      "Over 3.5 goals",
      prediction.over35,
      odds.over35
    ],
    [
      "bttsYes",
      "BTTS Yes",
      prediction.bttsYes,
      odds.bttsYes
    ]
  ];

  for (const [
    market,
    label,
    probability,
    price
  ] of definitions) {
    const candidate =
      createCandidate(
        market,
        label,
        probability,
        price,
        prediction,
        odds
      );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates.sort(
    (a, b) =>
      b.score - a.score
  );
}

// --------------------------------------------------
// ANALYSIS BUNDLE
// --------------------------------------------------

async function getBundle(
  event,
  predictionRows,
  predictionDiagnostics
) {
  const predictionRaw =
    findPredictionForEvent(
      event.id,
      predictionRows
    );

  const prediction =
    parsePrediction(
      predictionRaw
    );

  const oddsResult =
    await getOdds(event.id);

  const h2h =
    await getH2H(event);

  const detail =
    await getEventDetail(
      event.id
    );

  const lineups =
    parseLineups(
      detail?.event?.lineups ||
      detail?.lineups
    );

  const referee =
    extractReferee(detail);

  const candidates =
    buildCandidates(
      prediction,
      oddsResult.data
    );

  return {
    event,

    predictionAvailable:
      Boolean(prediction),

    oddsAvailable:
      Boolean(oddsResult.available),

    prediction,

    odds:
      oddsResult.data,

    oddsRaw:
      oddsResult.raw,

    h2h,

    lineups,

    referee,

    candidates,

    predictionDebug: {
      source:
        "/predictions/?upcoming=true&limit=200",

      count:
        predictionRows.length,

      matchedEventId:
        predictionRaw
          ? event.id
          : null,

      diagnostics:
        predictionDiagnostics
    },

    oddsDebug:
      oddsResult.diagnostics,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      signal: null,
      note:
        "Exchange data is not available. No exchange signal is fabricated."
    }
  };
}

// --------------------------------------------------
// EVENTS LIST
// --------------------------------------------------

async function getEventsForDate(
  date
) {
  const nextDate =
    new Date(`${date}T00:00:00Z`);

  nextDate.setUTCDate(
    nextDate.getUTCDate() + 1
  );

  const dateTo =
    nextDate
      .toISOString()
      .slice(0, 10);

  const path =
    `/events/?date_from=${date}&date_to=${dateTo}`;

  const response =
    await bsdRequest(path);

  const rows =
    extractResults(
      response.data
    );

  return {
    response,
    rows,
    path
  };
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE
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
      await getEventsForDate(
        date
      );

    const events =
      result.rows
        .map(parseEvent)
        .filter(Boolean);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,
      count: events.length,
      events
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      error: error.message
    });
  }
});

// --------------------------------------------------
// SINGLE EVENT ANALYSIS
// --------------------------------------------------

app.get(
  "/api/analyze/:eventId",
  async (req, res) => {
    try {
      const eventId =
        Number(req.params.eventId);

      if (!eventId) {
        return res.status(400).json({
          error: "Invalid eventId"
        });
      }

      const detail =
        await getEventDetail(
          eventId
        );

      const event =
        parseEvent(
          detail?.event ||
          detail
        );

      if (!event) {
        return res.status(404).json({
          version: VERSION,
          error:
            "Event not found"
        });
      }

      const predictions =
        await getAllPredictions();

      const bundle =
        await getBundle(
          event,
          predictions.rows,
          predictions.diagnostics
        );

      res.json({
        version: VERSION,
        source: SOURCE,
        ...bundle
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error: error.message
      });
    }
  }
);

// --------------------------------------------------
// TOP PICKS
// --------------------------------------------------

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const eventsResult =
        await getEventsForDate(
          date
        );

      const parsedEvents =
        eventsResult.rows
          .map(parseEvent)
          .filter(Boolean);

      const eventsReturned =
        parsedEvents.length;

      const upcoming =
        parsedEvents
          .filter(
            isUpcomingEvent
          )
          .sort(
            (a, b) =>
              new Date(a.date) -
              new Date(b.date)
          )
          .slice(0, 10);

      const eventsExcluded =
        eventsReturned -
        upcoming.length;

      const predictions =
        await getAllPredictions();

      const analyzed = [];

      for (const event of upcoming) {
        try {
          const bundle =
            await getBundle(
              event,
              predictions.rows,
              predictions.diagnostics
            );

          analyzed.push(bundle);
        } catch (error) {
          analyzed.push({
            event,
            predictionAvailable:
              false,
            oddsAvailable:
              false,
            candidates: [],
            error:
              error.message
          });
        }
      }

      const qualified = [];

      for (const bundle of analyzed) {
        for (const candidate of bundle.candidates || []) {
          if (!candidate.accepted) {
            continue;
          }

          qualified.push({
            ...candidate,

            event: {
              id:
                bundle.event.id,

              home:
                bundle.event.home,

              away:
                bundle.event.away,

              date:
                bundle.event.date,

              status:
                bundle.event.status,

              league:
                bundle.event.league,

              leagueId:
                bundle.event.leagueId
            },

            h2h:
              bundle.h2h,

            lineups:
              bundle.lineups,

            referee:
              bundle.referee,

            exchange:
              bundle.exchange
          });
        }
      }

      qualified.sort(
        (a, b) => {
          // First probability score.
          // Then probability.
          // Then value.
          if (
            b.probabilityScore !==
            a.probabilityScore
          ) {
            return (
              b.probabilityScore -
              a.probabilityScore
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
            b.valuePercent -
            a.valuePercent
          );
        }
      );

      const topPicks =
        qualified.slice(
          0,
          MAX_TOP_PICKS
        );

      res.json({
        version: VERSION,
        source: SOURCE,

        date,

        eventsReturned,

        upcomingEvents:
          upcoming.length,

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
          status:
            "NOT_CONNECTED",
          note:
            "No exchange signal is fabricated."
        },

        picks:
          topPicks,

        analyzed:
          analyzed.map(bundle => ({
            event:
              bundle.event,

            predictionAvailable:
              bundle.predictionAvailable,

            oddsAvailable:
              bundle.oddsAvailable,

            prediction:
              bundle.prediction,

            odds:
              bundle.odds,

            h2h:
              bundle.h2h,

            lineups:
              bundle.lineups,

            referee:
              bundle.referee,

            candidates:
              bundle.candidates,

            predictionDebug:
              bundle.predictionDebug,

            oddsDebug:
              bundle.oddsDebug,

            exchange:
              bundle.exchange,

            error:
              bundle.error ||
              null
          }))
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error: error.message
      });
    }
  }
);

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
