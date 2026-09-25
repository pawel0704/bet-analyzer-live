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

const VERSION = "6.6.1";
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

  return Math.abs(n) <= 1 ? n * 100 : n;
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
   RESULTS
========================================================= */

function extractResults(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.results)) return payload.results;

  if (Array.isArray(payload.data)) return payload.data;

  if (payload.data && Array.isArray(payload.data.results)) {
    return payload.data.results;
  }

  if (payload.data && Array.isArray(payload.data.data)) {
    return payload.data.data;
  }

  if (Array.isArray(payload.items)) return payload.items;

  if (Array.isArray(payload.events)) return payload.events;

  if (Array.isArray(payload.predictions)) {
    return payload.predictions;
  }

  return [];
}

/* =========================================================
   DEBUG SHAPE
========================================================= */

function sanitizeDebug(value, depth = 0) {
  if (depth > 4) {
    return "[MAX_DEPTH]";
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map((item) =>
        sanitizeDebug(item, depth + 1)
      );
  }

  if (typeof value === "object") {
    const output = {};

    for (const [key, child] of Object.entries(value)) {
      /*
        Never expose authentication material.
      */
      const lower = key.toLowerCase();

      if (
        lower.includes("token") ||
        lower.includes("api_key") ||
        lower.includes("apikey") ||
        lower.includes("authorization") ||
        lower.includes("secret")
      ) {
        output[key] = "[REDACTED]";
        continue;
      }

      output[key] = sanitizeDebug(
        child,
        depth + 1
      );
    }

    return output;
  }

  return String(value);
}

function debugPayload(payload) {
  const rows = extractResults(payload);

  return {
    payloadType: Array.isArray(payload)
      ? "array"
      : typeof payload,

    topLevelKeys:
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload)
        ? Object.keys(payload)
        : [],

    resultCount: rows.length,

    firstRows: rows
      .slice(0, 3)
      .map((row) =>
        sanitizeDebug(row)
      ),

    payloadSample:
      sanitizeDebug(payload),
  };
}

/* =========================================================
   EVENTS
========================================================= */

function getTeamName(team) {
  if (!team) return null;

  if (typeof team === "string") return team;

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
    event.homeTeam
  );
}

function getEventAway(event) {
  return firstDefined(
    getTeamName(event.away_team),
    getTeamName(event.away),
    event.away_name,
    event.awayTeamName,
    event.away_team_name,
    event.awayTeam
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

function getEventIsUpcoming(event) {
  const status = normalizeText(
    getEventStatus(event)
  ).replace(/\s+/g, "_");

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

  if (terminal.has(status)) return false;

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

  if (upcoming.has(status)) return true;

  const date = getEventDate(event);

  if (date) {
    const timestamp = Date.parse(date);

    if (Number.isFinite(timestamp)) {
      return timestamp > Date.now();
    }
  }

  return false;
}

async function getEvents(date) {
  const diagnostics = [];

  const path =
    `/events/?date=${encodeURIComponent(date)}&limit=50`;

  const result = await bsdFetch(path);

  const events = extractResults(result.payload);

  diagnostics.push({
    path,
    status: result.status,
    ok: result.ok,
    count: events.length,
  });

  const seen = new Set();

  const unique = events.filter((event) => {
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

function predictionId(row) {
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

function predictionHome(row) {
  return firstDefined(
    getTeamName(row.home_team),
    getTeamName(row.home),
    row.home_name,
    row.home_team_name,
    row.homeTeamName,
    getTeamName(row.event?.home_team),
    getTeamName(row.event?.home),
    row.event?.home_name,
    row.event?.home_team_name
  );
}

function predictionAway(row) {
  return firstDefined(
    getTeamName(row.away_team),
    getTeamName(row.away),
    row.away_name,
    row.away_team_name,
    row.awayTeamName,
    getTeamName(row.event?.away_team),
    getTeamName(row.event?.away),
    row.event?.away_name,
    row.event?.away_team_name
  );
}

function predictionObject(row) {
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

function getValue(source, keys) {
  for (const key of keys) {
    const value = num(source?.[key]);

    if (value !== null) return value;
  }

  return null;
}

function parsePrediction(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const nested = predictionObject(row);

  const source = {
    ...row,
    ...nested,
  };

  const result = {
    home: pct(
      getValue(source, [
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
    ),

    draw: pct(
      getValue(source, [
        "draw",
        "draw_probability",
        "drawProbability",
        "prob_draw",
        "probability_draw",
        "p_draw",
        "x",
      ])
    ),

    away: pct(
      getValue(source, [
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
    ),

    over15: pct(
      getValue(source, [
        "over15",
        "over_15",
        "over_1_5",
        "over15_probability",
        "over_1_5_probability",
      ])
    ),

    over25: pct(
      getValue(source, [
        "over25",
        "over_25",
        "over_2_5",
        "over25_probability",
        "over_2_5_probability",
      ])
    ),

    over35: pct(
      getValue(source, [
        "over35",
        "over_35",
        "over_3_5",
        "over35_probability",
        "over_3_5_probability",
      ])
    ),

    btts: pct(
      getValue(source, [
        "btts",
        "btts_yes",
        "bttsYes",
        "btts_probability",
        "btts_yes_probability",
      ])
    ),

    xGHome: num(
      firstDefined(
        source.xg_home,
        source.xG_home,
        source.home_xg,
        source.homeXG
      )
    ),

    xGAway: num(
      firstDefined(
        source.xg_away,
        source.xG_away,
        source.away_xg,
        source.awayXG
      )
    ),

    confidence: pct(
      firstDefined(
        source.confidence,
        source.prediction_confidence,
        source.model_confidence
      )
    ),

    predicted: firstDefined(
      source.predicted_result,
      source.predictedResult,
      source.prediction,
      source.result,
      source.winner
    ),

    score: firstDefined(
      source.predicted_score,
      source.predictedScore,
      source.score,
      source.correct_score
    ),
  };

  const available =
    result.home !== null ||
    result.draw !== null ||
    result.away !== null ||
    result.over15 !== null ||
    result.over25 !== null ||
    result.over35 !== null ||
    result.btts !== null;

  return available ? result : null;
}

async function getPredictions() {
  const diagnostics = [];

  /*
    The previous request with upcoming=true returned 400.
    Therefore use the endpoint shape that BSD actually accepts.
  */
  const paths = [
    "/predictions/?limit=200",
    "/predictions/?limit=200&offset=200",
    "/predictions/?limit=200&offset=400",
  ];

  const rows = [];

  for (const path of paths) {
    const result = await bsdFetch(path);

    const extracted =
      extractResults(result.payload);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: extracted.length,
    });

    if (result.ok) {
      rows.push(...extracted);
    }
  }

  return {
    rows,
    diagnostics,
    count: rows.length,
  };
}

function similarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);

  if (!x || !y) return 0;

  if (x === y) return 1;

  if (x.includes(y) || y.includes(x)) {
    return 0.9;
  }

  const xs = new Set(x.split(" "));
  const ys = new Set(y.split(" "));

  const common =
    [...xs].filter((part) =>
      ys.has(part)
    );

  if (!common.length) return 0;

  return common.length /
    Math.max(xs.size, ys.size);
}

function findPrediction(event, rows) {
  const id = getEventId(event);

  const exact = rows.find((row) => {
    const pid = predictionId(row);

    return (
      pid !== null &&
      id !== null &&
      String(pid) === String(id)
    );
  });

  if (exact) {
    return parsePrediction(exact);
  }

  const home = getEventHome(event);
  const away = getEventAway(event);

  for (const row of rows) {
    const ph = predictionHome(row);
    const pa = predictionAway(row);

    if (
      similarity(home, ph) >= 0.75 &&
      similarity(away, pa) >= 0.75
    ) {
      const parsed = parsePrediction(row);

      if (parsed) return parsed;
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

function parseOdds(payload) {
  const result = {
    home: null,
    draw: null,
    away: null,
    over15: null,
    over25: null,
    over35: null,
    btts: null,
  };

  /*
    We deliberately do NOT guess from generic words such as
    "draw", "home", etc.

    6.6.1 only accepts explicit field names.
  */

  function take(source, keys, target) {
    if (!source || typeof source !== "object") {
      return;
    }

    for (const key of keys) {
      const value = validOdds(source[key]);

      if (value !== null) {
        result[target] = value;
        return;
      }
    }
  }

  const sources = [
    payload,
    payload?.data,
    payload?.odds,
    payload?.data?.odds,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }

    /*
      Explicit flat fields.
    */
    take(
      source,
      [
        "odds_home",
        "home_odds",
        "home_price",
        "price_home",
        "home",
      ],
      "home"
    );

    take(
      source,
      [
        "odds_draw",
        "draw_odds",
        "draw_price",
        "price_draw",
      ],
      "draw"
    );

    take(
      source,
      [
        "odds_away",
        "away_odds",
        "away_price",
        "price_away",
      ],
      "away"
    );

    take(
      source,
      [
        "over_15",
        "over15",
        "over_1_5",
        "odds_over_15",
        "odds_over15",
      ],
      "over15"
    );

    take(
      source,
      [
        "over_25",
        "over25",
        "over_2_5",
        "odds_over_25",
        "odds_over25",
      ],
      "over25"
    );

    take(
      source,
      [
        "over_35",
        "over35",
        "over_3_5",
        "odds_over_35",
        "odds_over35",
      ],
      "over35"
    );

    take(
      source,
      [
        "btts_yes",
        "bttsYes",
        "odds_btts_yes",
      ],
      "btts"
    );

    /*
      Explicit structured match-winner object.
    */
    const mw =
      source.match_winner ||
      source.matchWinner ||
      source["1x2"] ||
      source["1X2"];

    if (mw && typeof mw === "object") {
      take(mw, ["home"], "home");
      take(mw, ["draw"], "draw");
      take(mw, ["away"], "away");
    }

    /*
      Explicit O/U object.
    */
    const ou =
      source.over_under ||
      source.overUnder ||
      source.ou;

    if (ou && typeof ou === "object") {
      take(
        ou,
        ["over_15", "over15"],
        "over15"
      );

      take(
        ou,
        ["over_25", "over25"],
        "over25"
      );

      take(
        ou,
        ["over_35", "over35"],
        "over35"
      );
    }

    /*
      Explicit BTTS object.
    */
    const btts =
      source.btts ||
      source.BTTS;

    if (
      btts &&
      typeof btts === "object"
    ) {
      take(
        btts,
        ["yes"],
        "btts"
      );
    }
  }

  const parsedMarkets =
    Object.entries(result)
      .filter(([, value]) =>
        value !== null
      )
      .map(([key]) => key);

  return {
    odds: result,
    available:
      parsedMarkets.length > 0,
    parsedMarkets,
  };
}

/* =========================================================
   GET ODDS
========================================================= */

async function getOdds(eventId) {
  const diagnostics = [];

  const path =
    `/odds/?event_id=${encodeURIComponent(eventId)}`;

  const result =
    await bsdFetch(path);

  const rows =
    extractResults(result.payload);

  const parsed =
    parseOdds(result.payload);

  diagnostics.push({
    path,
    status: result.status,
    ok: result.ok,
    count: rows.length,
    parsed: parsed.available,
    parsedMarkets:
      parsed.parsedMarkets,
  });

  return {
    ...parsed,
    diagnostics,
  };
}

/* =========================================================
   VALUE / SCORE
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

  const implied =
    impliedProbability(odds);

  if (implied === null) {
    return null;
  }

  return probability - implied;
}

function calculateScore(
  probability,
  odds
) {
  const value =
    valuePercent(
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

function buildCandidates(
  prediction,
  odds
) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  function add(
    name,
    market,
    probability
  ) {
    const price =
      odds[market];

    if (
      probability === null ||
      price === null
    ) {
      return;
    }

    const value =
      valuePercent(
        probability,
        price
      );

    const score =
      calculateScore(
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
        Math.round(
          value * 100
        ) / 100,
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

function qualify(candidate) {
  const {
    probability: p,
    score,
    valuePercent: value,
    odds,
  } = candidate;

  if (
    p >= FILTERS.highProbabilityMin &&
    score >= FILTERS.highProbabilityScoreMin &&
    value >= FILTERS.highProbabilityValueMin &&
    odds >= FILTERS.minimumOddsForHighProbability
  ) {
    return {
      ...candidate,
      category:
        "HIGH_PROBABILITY",
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
  const eventId =
    getEventId(event);

  const odds =
    await getOdds(eventId);

  const candidates =
    buildCandidates(
      prediction,
      odds.odds
    );

  const qualified =
    candidates
      .map(qualify)
      .filter(Boolean)
      .sort(
        (a, b) =>
          b.probability -
          a.probability ||
          b.score - a.score
      );

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
      odds.available,

    odds:
      odds.available
        ? odds.odds
        : null,

    oddsDebug: {
      parsed:
        odds.available,

      parsedMarkets:
        odds.parsedMarkets,

      diagnostics:
        odds.diagnostics,
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

      const upcoming =
        eventData.events.filter(
          getEventIsUpcoming
        );

      const events =
        upcoming.slice(0, 10);

      const predictionData =
        await getPredictions();

      const analyzed = [];

      for (const event of events) {
        const prediction =
          findPrediction(
            event,
            predictionData.rows
          );

        analyzed.push(
          await analyzeEvent(
            event,
            prediction
          )
        );
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

      const picks =
        allQualified
          .sort(
            (a, b) =>
              b.probability -
                a.probability ||
              b.score -
                a.score ||
              b.valuePercent -
                a.valuePercent
          )
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
          eventData.events.length,

        upcomingEvents:
          upcoming.length,

        eventsAnalyzed:
          analyzed.length,

        eventsExcluded:
          eventData.events.length -
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
   DEBUG ODDS
========================================================= */

app.get(
  "/api/debug-odds",
  async (req, res) => {
    try {
      const eventId =
        req.query.eventId;

      if (!eventId) {
        return res.status(400).json({
          error:
            "Missing eventId"
        });
      }

      const path =
        `/odds/?event_id=${encodeURIComponent(eventId)}`;

      const result =
        await bsdFetch(path);

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        eventId,

        status:
          result.status,

        ok:
          result.ok,

        debug:
          debugPayload(
            result.payload
          ),
      });
    } catch (error) {
      res.status(500).json({
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =========================================================
   DEBUG PREDICTIONS
========================================================= */

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const data =
        await getPredictions();

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        count:
          data.count,

        diagnostics:
          data.diagnostics,

        firstRows:
          data.rows
            .slice(0, 5)
            .map((row) =>
              sanitizeDebug(row)
            ),
      });
    } catch (error) {
      res.status(500).json({
        error:
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
    status:
      "ok",

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
      status:
        "ok",

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
