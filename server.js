import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const BSD_API_KEY = process.env.BSD_API_KEY;

const BSD_BASE = "https://sports.bzzoiro.com/api/v2";

const VERSION = "6.0.2";
const SOURCE = "BSD";

const CONFIG = {
  requestTimeout: 10000,
  retries: 1,
  maxEvents: 50,
  maxPicks: 10,
  maxPicksPerEvent: 2,

  // Filtry typów
  highProbabilityMin: 60,
  highProbabilityScoreMin: 58,
  highProbabilityValueMin: -3,

  valueProbabilityMin: 35,
  valueScoreMin: 55,
  valueMin: 5
};

// ------------------------------------------------------------
// BASIC
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = number(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

function safeText(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value);
}

function firstNumber(...values) {
  for (const value of values) {
    const n = number(value);

    if (n !== null) {
      return n;
    }
  }

  return null;
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

// ------------------------------------------------------------
// BSD HTTP
// ------------------------------------------------------------

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    const error = new Error("BSD_API_KEY is missing");
    error.code = "BSD_KEY_MISSING";
    throw error;
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeout || CONFIG.requestTimeout);

  try {
    const url = path.startsWith("http")
      ? path
      : `${BSD_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

    let lastError = null;

    for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
      try {
        const response = await fetch(url, {
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
            rawText: text
          };
        }

        if (!response.ok) {
          const error = new Error(
            data?.detail ||
            data?.error ||
            `BSD HTTP ${response.status}`
          );

          error.httpStatus = response.status;
          error.url = url;
          error.body = data;

          // 404 nie ma sensu ponawiać.
          if (response.status === 404) {
            throw error;
          }

          lastError = error;

          if (attempt < CONFIG.retries) {
            await sleep(400 * (attempt + 1));
            continue;
          }

          throw error;
        }

        return data;
      } catch (error) {
        lastError = error;

        if (error?.name === "AbortError") {
          const timeoutError = new Error(
            `BSD request timeout after ${options.timeout || CONFIG.requestTimeout} ms`
          );

          timeoutError.code = "BSD_TIMEOUT";
          timeoutError.url = path;

          throw timeoutError;
        }

        if (attempt < CONFIG.retries && !error?.httpStatus) {
          await sleep(400 * (attempt + 1));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error("BSD request failed");
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// NORMALIZACJA LISTY EVENTS
// ------------------------------------------------------------

function extractResults(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (Array.isArray(raw?.results)) {
    return raw.results;
  }

  if (Array.isArray(raw?.events)) {
    return raw.events;
  }

  if (Array.isArray(raw?.data)) {
    return raw.data;
  }

  if (Array.isArray(raw?.items)) {
    return raw.items;
  }

  return [];
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const home =
    event.home_team_name ||
    event.home_team?.name ||
    event.home?.name ||
    event.home ||
    event.teams?.home?.name ||
    null;

  const away =
    event.away_team_name ||
    event.away_team?.name ||
    event.away?.name ||
    event.away ||
    event.teams?.away?.name ||
    null;

  return {
    id: event.id ?? event.event_id ?? event.eventId,
    home: safeText(home, "Home"),
    away: safeText(away, "Away"),
    date:
      event.date ||
      event.start_time ||
      event.startTime ||
      event.kickoff ||
      null,
    status: event.status || event.state || "unknown",
    league:
      event.league_name ||
      event.league?.name ||
      event.competition?.name ||
      null,
    leagueId:
      event.league_id ||
      event.league?.id ||
      null,
    seasonId:
      event.season_id ||
      event.season?.id ||
      null,
    raw: event
  };
}

// ------------------------------------------------------------
// EVENTS
// ------------------------------------------------------------

async function getEvents(options = {}) {
  const limit = Math.min(
    Number(options.limit) || CONFIG.maxEvents,
    200
  );

  const params = new URLSearchParams();

  params.set("limit", String(limit));
  params.set("offset", "0");

  if (options.date) {
    params.set("date_from", options.date);
    params.set("date_to", options.date);
  }

  if (options.status) {
    params.set("status", options.status);
  }

  const raw = await bsdFetch(`/events/?${params.toString()}`);

  const results = extractResults(raw);

  return {
    raw,
    results,
    events: results
      .map(normalizeEvent)
      .filter(Boolean)
  };
}

// ------------------------------------------------------------
// EVENT DETAIL
// ------------------------------------------------------------

async function getEventDetail(id) {
  const raw = await bsdFetch(`/events/${id}/`);

  return raw;
}

// ------------------------------------------------------------
// RESOURCE FETCH
// ------------------------------------------------------------

async function getResource(id, resource) {
  const candidates = [
    `/events/${id}/${resource}/`,
    `/event/${id}/${resource}/`,
    `/${resource}/${id}/`
  ];

  let lastError = null;

  for (const path of candidates) {
    try {
      return await bsdFetch(path);
    } catch (error) {
      lastError = error;

      if (error?.httpStatus !== 404) {
        break;
      }
    }
  }

  const error = new Error(
    `BSD resource unavailable: ${resource}`
  );

  error.resource = resource;
  error.eventId = id;
  error.original = lastError?.message || null;

  throw error;
}

// ------------------------------------------------------------
// BUNDLE
// ------------------------------------------------------------

async function safeResource(id, resource) {
  try {
    return {
      available: true,
      data: await getResource(id, resource),
      error: null
    };
  } catch (error) {
    return {
      available: false,
      data: null,
      error: {
        message: error.message,
        status: error.httpStatus || null
      }
    };
  }
}

async function getBundle(id) {
  const resources = [
    "prediction",
    "odds",
    "h2h",
    "stats",
    "form",
    "lineups",
    "incidents"
  ];

  const results = await Promise.all(
    resources.map(resource => safeResource(id, resource))
  );

  const bundle = {};

  resources.forEach((resource, index) => {
    bundle[resource] = results[index];
  });

  return bundle;
}

// ------------------------------------------------------------
// EVENT INFO
// ------------------------------------------------------------

function eventInfo(event, bundle = {}) {
  const rawPrediction = bundle?.prediction?.data;

  const nestedEvent =
    rawPrediction?.event ||
    rawPrediction?.raw?.event ||
    rawPrediction?.prediction?.event ||
    null;

  const source = firstObject(
    event,
    nestedEvent
  ) || {};

  const home =
    source.home_team_name ||
    source.home_team?.name ||
    source.home?.name ||
    source.home ||
    nestedEvent?.home_team_name ||
    nestedEvent?.home ||
    "Home";

  const away =
    source.away_team_name ||
    source.away_team?.name ||
    source.away?.name ||
    source.away ||
    nestedEvent?.away_team_name ||
    nestedEvent?.away ||
    "Away";

  return {
    home: safeText(home, "Home"),
    away: safeText(away, "Away"),
    date:
      source.date ||
      source.start_time ||
      source.startTime ||
      nestedEvent?.date ||
      null,
    league:
      source.league_name ||
      source.league?.name ||
      nestedEvent?.league ||
      ""
  };
}

// ------------------------------------------------------------
// PREDICTION
// ------------------------------------------------------------

function parsePrediction(raw) {
  const root =
    raw?.prediction ||
    raw?.data ||
    raw ||
    {};

  const markets =
    root?.markets ||
    root?.raw?.markets ||
    raw?.markets ||
    {};

  const matchResult =
    markets?.match_result ||
    {};

  const expectedGoals =
    markets?.expected_goals ||
    {};

  const overUnder =
    markets?.over_under ||
    {};

  const btts =
    markets?.btts ||
    {};

  const model =
    root?.model ||
    root?.raw?.model ||
    raw?.model ||
    {};

  const home = firstNumber(
    matchResult?.home,
    matchResult?.home_win,
    root?.home,
    root?.home_win
  );

  const draw = firstNumber(
    matchResult?.draw,
    root?.draw
  );

  const away = firstNumber(
    matchResult?.away,
    matchResult?.away_win,
    root?.away,
    root?.away_win
  );

  const over15 = firstNumber(
    overUnder?.over_15,
    overUnder?.over15,
    overUnder?.["1.5"]?.over,
    root?.over15,
    root?.over_15
  );

  const over25 = firstNumber(
    overUnder?.over_25,
    overUnder?.over25,
    overUnder?.["2.5"]?.over,
    root?.over25,
    root?.over_25
  );

  const over35 = firstNumber(
    overUnder?.over_35,
    overUnder?.over35,
    overUnder?.["3.5"]?.over,
    root?.over35,
    root?.over_35
  );

  const bttsYes = firstNumber(
    btts?.yes,
    btts?.btts_yes,
    root?.bttsYes,
    root?.btts_yes
  );

  const xgHome = firstNumber(
    expectedGoals?.home,
    expectedGoals?.home_xg,
    root?.xgHome,
    root?.xg_home
  );

  const xgAway = firstNumber(
    expectedGoals?.away,
    expectedGoals?.away_xg,
    root?.xgAway,
    root?.xg_away
  );

  const confidence = firstNumber(
    model?.confidence,
    root?.confidence
  );

  const predicted =
    model?.predicted ||
    root?.predicted ||
    (away !== null && home !== null && away > home
      ? "A"
      : home !== null && home > away
        ? "H"
        : "D");

  const mostLikelyScore =
    model?.most_likely_score ||
    model?.mostLikelyScore ||
    root?.mostLikelyScore ||
    root?.most_likely_score ||
    null;

  return {
    home: pct(home),
    draw: pct(draw),
    away: pct(away),

    over15: pct(over15),
    over25: pct(over25),
    over35: pct(over35),

    bttsYes: pct(bttsYes),

    xgHome,
    xgAway,

    confidence: pct(confidence),

    predicted,
    mostLikelyScore,

    raw
  };
}

// ------------------------------------------------------------
// ODDS
// ------------------------------------------------------------

function parseOdds(raw) {
  const root =
    raw?.odds ||
    raw?.data?.odds ||
    raw?.data ||
    raw ||
    {};

  return {
    home: firstNumber(
      root.home_win,
      root.home,
      root.odds_home
    ),

    draw: firstNumber(
      root.draw,
      root.odds_draw
    ),

    away: firstNumber(
      root.away_win,
      root.away,
      root.odds_away
    ),

    over15: firstNumber(
      root.over_15_goals,
      root.over15
    ),

    under15: firstNumber(
      root.under_15_goals,
      root.under15
    ),

    over25: firstNumber(
      root.over_25_goals,
      root.over25
    ),

    under25: firstNumber(
      root.under_25_goals,
      root.under25
    ),

    over35: firstNumber(
      root.over_35_goals,
      root.over35
    ),

    under35: firstNumber(
      root.under_35_goals,
      root.under35
    ),

    bttsYes: firstNumber(
      root.btts_yes,
      root.bttsYes
    ),

    bttsNo: firstNumber(
      root.btts_no,
      root.bttsNo
    ),

    previous:
      raw?.previous ||
      root?.previous ||
      null,

    updatedAt:
      raw?.last_update_at ||
      raw?.updated_at ||
      root?.last_update_at ||
      root?.updated_at ||
      null,

    raw
  };
}

// ------------------------------------------------------------
// H2H
// ------------------------------------------------------------

function parseH2H(raw) {
  const root =
    raw?.h2h ||
    raw?.data ||
    raw ||
    {};

  const matches =
    root.recent_matches ||
    root.matches ||
    root.history ||
    [];

  const list = Array.isArray(matches)
    ? matches
    : [];

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let homeGoals = 0;
  let awayGoals = 0;

  for (const match of list) {
    const hs = firstNumber(
      match.home_score,
      match.home_goals
    );

    const as = firstNumber(
      match.away_score,
      match.away_goals
    );

    if (hs === null || as === null) {
      continue;
    }

    homeGoals += hs;
    awayGoals += as;

    if (hs > as) homeWins++;
    else if (hs < as) awayWins++;
    else draws++;
  }

  const sampleSize = list.length;

  const averageGoals =
    sampleSize > 0
      ? (homeGoals + awayGoals) / sampleSize
      : null;

  return {
    sampleSize,
    homeWins,
    draws,
    awayWins,
    homeGoals,
    awayGoals,
    averageGoals,
    matches: list,
    raw
  };
}

// ------------------------------------------------------------
// FORM
// ------------------------------------------------------------

function parseForm(raw) {
  const root =
    raw?.form ||
    raw?.data ||
    raw ||
    {};

  const home =
    root.home ||
    root.home_form ||
    root.home_team ||
    [];

  const away =
    root.away ||
    root.away_form ||
    root.away_team ||
    [];

  const homeList = Array.isArray(home) ? home : [];
  const awayList = Array.isArray(away) ? away : [];

  return {
    available: homeList.length > 0 || awayList.length > 0,
    home: homeList,
    away: awayList,
    score: 0,
    details: null,
    raw
  };
}

// ------------------------------------------------------------
// STATS
// ------------------------------------------------------------

function parseStats(raw) {
  const root =
    raw?.stats ||
    raw?.data?.stats ||
    raw ||
    {};

  const home =
    root.home ||
    {};

  const away =
    root.away ||
    {};

  const metrics = [
    ["shotsOnTarget", "shots_on_target"],
    ["shots", "total_shots"],
    ["possession", "ball_possession"],
    ["corners", "corner_kicks"]
  ];

  const details = [];

  for (const [name, key] of metrics) {
    const h = firstNumber(
      home[key],
      home[name]
    );

    const a = firstNumber(
      away[key],
      away[name]
    );

    // WAŻNE:
    // nie traktujemy null jako 0.
    if (h === null && a === null) {
      continue;
    }

    let advantage = "EVEN";

    if (h !== null && a !== null) {
      if (h > a) advantage = "HOME";
      if (a > h) advantage = "AWAY";
    }

    details.push({
      metric: name,
      home: h,
      away: a,
      advantage
    });
  }

  return {
    available: details.length > 0,
    score: details.length > 0 ? 1 : 0,
    details,
    raw
  };
}

// ------------------------------------------------------------
// LINEUPS
// ------------------------------------------------------------

function parseLineups(raw) {
  const root =
    raw?.lineups ||
    raw?.data?.lineups ||
    raw ||
    {};

  const home =
    root.home ||
    root.lineups?.home ||
    {};

  const away =
    root.away ||
    root.lineups?.away ||
    {};

  const homePlayers = Array.isArray(home.players)
    ? home.players.length
    : 0;

  const awayPlayers = Array.isArray(away.players)
    ? away.players.length
    : 0;

  return {
    available: homePlayers > 0 || awayPlayers > 0,

    score:
      homePlayers >= 11 && awayPlayers >= 11
        ? 2
        : homePlayers > 0 || awayPlayers > 0
          ? 1
          : 0,

    details: {
      homePlayers,
      awayPlayers,

      completeHome: homePlayers >= 11,
      completeAway: awayPlayers >= 11,

      formationHome:
        home.formation ||
        null,

      formationAway:
        away.formation ||
        null
    },

    raw
  };
}

// ------------------------------------------------------------
// REFEREE
// ------------------------------------------------------------

function parseReferee(eventRaw, incidentRaw) {
  const referee =
    eventRaw?.referee ||
    eventRaw?.officials?.find?.(
      x =>
        String(x.role || "")
          .toLowerCase()
          .includes("ref")
    ) ||
    null;

  const name =
    referee?.name ||
    referee?.full_name ||
    null;

  return {
    available: Boolean(name),
    id: referee?.id || null,
    name,
    statsAvailable: false,
    score: name ? 1 : 0,
    note: name
      ? "Referee identified. Historical referee statistics are not connected."
      : "Referee data unavailable."
  };
}

// ------------------------------------------------------------
// MOVEMENT
// ------------------------------------------------------------

function calculateMovement(current, previous) {
  const c = number(current);
  const p = number(previous);

  if (c === null || p === null || p <= 0) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null
    };
  }

  const change = ((c - p) / p) * 100;

  let direction = "STABLE";

  if (change <= -0.5) {
    direction = "SHORTENING";
  } else if (change >= 0.5) {
    direction = "DRIFTING";
  }

  return {
    available: true,
    direction,
    percent: pct(change)
  };
}

function marketMovement(current, previous, key) {
  if (!previous) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null
    };
  }

  return calculateMovement(
    current?.[key],
    previous?.[key]
  );
}

// ------------------------------------------------------------
// VALUE
// ------------------------------------------------------------

function impliedProbability(odds) {
  const o = number(odds);

  if (o === null || o <= 1) {
    return null;
  }

  return 100 / o;
}

function valuePercent(probability, odds) {
  const p = number(probability);
  const o = number(odds);

  if (p === null || o === null) {
    return null;
  }

  return p * o - 100;
}

// ------------------------------------------------------------
// CANDIDATES
// ------------------------------------------------------------

function buildCandidate({
  market,
  label,
  probability,
  odds,
  reasons,
  movement
}) {
  if (
    number(probability) === null ||
    number(odds) === null ||
    odds <= 1
  ) {
    return null;
  }

  const p = number(probability);
  const o = number(odds);

  const implied = impliedProbability(o);
  const value = valuePercent(p, o);

  const score = Math.max(
    0,
    Math.min(
      100,
      p * 0.65 +
      Math.max(0, value) * 1.5 +
      reasons.length * 3
    )
  );

  const rejectionReasons = [];

  const highProbability =
    p >= CONFIG.highProbabilityMin &&
    score >= CONFIG.highProbabilityScoreMin &&
    value >= CONFIG.highProbabilityValueMin;

  const valuePick =
    value >= CONFIG.valueMin &&
    p >= CONFIG.valueProbabilityMin &&
    score >= CONFIG.valueScoreMin;

  if (!highProbability && !valuePick) {
    if (p < CONFIG.valueProbabilityMin) {
      rejectionReasons.push("PROBABILITY_LT_MIN");
    }

    if (value < CONFIG.highProbabilityValueMin) {
      rejectionReasons.push("VALUE_TOO_LOW");
    }

    if (score < CONFIG.valueScoreMin) {
      rejectionReasons.push("SCORE_LT_MIN");
    }
  }

  return {
    market,
    label,

    probability: pct(p),
    odds: o,

    impliedProbability: pct(implied),
    valuePercent: pct(value),

    score: pct(score),

    accepted:
      rejectionReasons.length === 0,

    rejectionReasons,

    movement:

      movement || {
        available: false,
        direction: "UNKNOWN",
        percent: null
      },

    reasons
  };
}

// ------------------------------------------------------------
// ANALYSIS
// ------------------------------------------------------------

function analyzeBundle(bundle, event) {
  const prediction = parsePrediction(
    bundle.prediction?.data
  );

  const odds = parseOdds(
    bundle.odds?.data
  );

  const h2h = parseH2H(
    bundle.h2h?.data
  );

  const form = parseForm(
    bundle.form?.data
  );

  const stats = parseStats(
    bundle.stats?.data
  );

  const lineups = parseLineups(
    bundle.lineups?.data
  );

  const referee = parseReferee(
    event?.raw,
    bundle.incidents?.data
  );

  const previousOdds =
    odds.previous;

  const candidates = [];

  const add = (
    market,
    label,
    probability,
    odd,
    reasons
  ) => {
    const candidate = buildCandidate({
      market,
      label,
      probability,
      odds: odd,
      reasons,
      movement: marketMovement(
        odds,
        previousOdds,
        marketToOddsKey(market)
      )
    });

    if (candidate) {
      candidates.push(candidate);
    }
  };

  if (prediction.home !== null && odds.home !== null) {
    const reasons = [];

    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome > prediction.xgAway
    ) {
      reasons.push("xG favors home");
    }

    if (
      h2h.sampleSize >= 3 &&
      h2h.homeWins > h2h.awayWins
    ) {
      reasons.push("H2H favors home");
    }

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "home",
      "Home win",
      prediction.home,
      odds.home,
      reasons
    );
  }

  if (prediction.draw !== null && odds.draw !== null) {
    const reasons = [];

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "draw",
      "Draw",
      prediction.draw,
      odds.draw,
      reasons
    );
  }

  if (prediction.away !== null && odds.away !== null) {
    const reasons = [];

    if (
      prediction.xgAway !== null &&
      prediction.xgHome !== null &&
      prediction.xgAway > prediction.xgHome
    ) {
      reasons.push("xG favors away");
    }

    if (
      h2h.sampleSize >= 3 &&
      h2h.awayWins > h2h.homeWins
    ) {
      reasons.push("H2H favors away");
    }

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "away",
      "Away win",
      prediction.away,
      odds.away,
      reasons
    );
  }

  if (
    prediction.over15 !== null &&
    odds.over15 !== null
  ) {
    const reasons = [];

    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 1.8
    ) {
      reasons.push("Combined xG supports Over 1.5");
    }

    if (
      h2h.averageGoals !== null &&
      h2h.averageGoals >= 2.5
    ) {
      reasons.push("H2H goal average supports Over 1.5");
    }

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "over15",
      "Over 1.5 goals",
      prediction.over15,
      odds.over15,
      reasons
    );
  }

  if (
    prediction.over25 !== null &&
    odds.over25 !== null
  ) {
    const reasons = [];

    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 2.4
    ) {
      reasons.push("Combined xG supports Over 2.5");
    }

    if (
      h2h.averageGoals !== null &&
      h2h.averageGoals >= 2.8
    ) {
      reasons.push("H2H goal average supports Over 2.5");
    }

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "over25",
      "Over 2.5 goals",
      prediction.over25,
      odds.over25,
      reasons
    );
  }

  if (
    prediction.over35 !== null &&
    odds.over35 !== null
  ) {
    const reasons = [];

    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 3.2
    ) {
      reasons.push("Very high combined xG");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "over35",
      "Over 3.5 goals",
      prediction.over35,
      odds.over35,
      reasons
    );
  }

  if (
    prediction.bttsYes !== null &&
    odds.bttsYes !== null
  ) {
    const reasons = [];

    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome >= 0.9 &&
      prediction.xgAway >= 0.9
    ) {
      reasons.push("xG supports both teams scoring");
    }

    if (form.available) {
      reasons.push("Form data available");
    }

    if (lineups.available) {
      reasons.push("Lineup data available");
    }

    add(
      "bttsYes",
      "Both teams to score — Yes",
      prediction.bttsYes,
      odds.bttsYes,
      reasons
    );
  }

  candidates.sort(
    (a, b) =>
      (b.score || 0) -
      (a.score || 0)
  );

  const qualified =
    candidates
      .filter(c => c.accepted)
      .slice(
        0,
        CONFIG.maxPicksPerEvent
      );

  const rejected =
    candidates.filter(c => !c.accepted);

  return {
    prediction,
    odds,
    h2h,
    form,
    stats,
    lineups,
    referee,

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated."
    },

    candidates,
    qualified,
    rejected,

    coverage: {
      prediction:
        bundle.prediction?.available === true,

      odds:
        bundle.odds?.available === true,

      h2h:
        bundle.h2h?.available === true,

      stats:
        stats.available,

      form:
        form.available,

      lineups:
        lineups.available,

      incidents:
        bundle.incidents?.available === true,

      referee:
        referee.available,

      refereeStats:
        referee.statsAvailable,

      bookmakerMovement:
        Boolean(odds.previous),

      exchangeMovement: false
    }
  };
}

function marketToOddsKey(market) {
  const map = {
    home: "home",
    draw: "draw",
    away: "away",
    over15: "over15",
    over25: "over25",
    over35: "over35",
    bttsYes: "bttsYes"
  };

  return map[market] || market;
}

// ------------------------------------------------------------
// TOP PICKS
// ------------------------------------------------------------

async function getTopPicks(date) {
  const eventData = await getEvents({
    date,
    limit: CONFIG.maxEvents
  });

  const output = [];
  const errors = [];

  for (const event of eventData.events) {
    if (!event.id) {
      continue;
    }

    try {
      const detail = await getEventDetail(
        event.id
      );

      const bundle = await getBundle(
        event.id
      );

      const analysis = analyzeBundle(
        bundle,
        {
          ...event,
          raw: detail
        }
      );

      for (const pick of analysis.qualified) {
        output.push({
          eventId: event.id,
          event: {
            home: event.home,
            away: event.away,
            date: event.date,
            league: event.league
          },
          pick
        });
      }
    } catch (error) {
      errors.push({
        eventId: event.id,
        home: event.home,
        away: event.away,
        error: error.message
      });
    }
  }

  output.sort(
    (a, b) =>
      (b.pick.score || 0) -
      (a.pick.score || 0)
  );

  return {
    date,
    count: output.length,
    picks: output.slice(
      0,
      CONFIG.maxPicks
    ),
    errors
  };
}

// ------------------------------------------------------------
// DIAGNOSTICS
// ------------------------------------------------------------

function publicError(error) {
  return {
    message: error?.message || "Unknown error",
    code: error?.code || null,
    httpStatus: error?.httpStatus || null,
    resource: error?.resource || null,
    eventId: error?.eventId || null,
    url: error?.url || null,
    body: error?.body || null
  };
}

// ------------------------------------------------------------
// ROOT
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// EVENTS
// ------------------------------------------------------------

app.get("/api/events", async (req, res) => {
  try {
    const data = await getEvents({
      date: req.query.date || null,
      status: req.query.status || null,
      limit: req.query.limit || 50
    });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      count: data.events.length,
      events: data.events
    });
  } catch (error) {
    console.error("GET /api/events:", error);

    res.status(
      error?.httpStatus === 401 ||
      error?.httpStatus === 402 ||
      error?.httpStatus === 429
        ? error.httpStatus
        : 502
    ).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      endpoint: "/api/events",
      error: publicError(error)
    });
  }
});

app.get("/api/events/live", async (req, res) => {
  try {
    const raw = await bsdFetch(
      "/events/live/"
    );

    const events = extractResults(raw)
      .map(normalizeEvent)
      .filter(Boolean);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      count: events.length,
      events,
      raw
    });
  } catch (error) {
    console.error(
      "GET /api/events/live:",
      error
    );

    res.status(502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      endpoint: "/api/events/live",
      error: publicError(error)
    });
  }
});

// ------------------------------------------------------------
// EVENT ENDPOINTS
// ------------------------------------------------------------

app.get("/api/events/:id", async (req, res) => {
  try {
    const raw = await getEventDetail(
      req.params.id
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      event: normalizeEvent(raw),
      raw
    });
  } catch (error) {
    console.error(
      `GET /api/events/${req.params.id}:`,
      error
    );

    res.status(
      error?.httpStatus || 502
    ).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: publicError(error)
    });
  }
});

// ------------------------------------------------------------
// RESOURCE ENDPOINTS
// ------------------------------------------------------------

const resourceRoutes = [
  "prediction",
  "odds",
  "h2h",
  "stats",
  "form",
  "lineups",
  "incidents"
];

for (const resource of resourceRoutes) {
  app.get(
    `/api/events/:id/${resource}`,
    async (req, res) => {
      try {
        const raw = await getResource(
          req.params.id,
          resource
        );

        res.json({
          ok: true,
          version: VERSION,
          source: SOURCE,
          eventId: req.params.id,
          resource,
          raw
        });
      } catch (error) {
        console.error(
          `GET /api/events/${req.params.id}/${resource}:`,
          error
        );

        res.status(
          error?.httpStatus === 404
            ? 404
            : 502
        ).json({
          ok: false,
          version: VERSION,
          source: SOURCE,
          eventId: req.params.id,
          resource,
          error: publicError(error)
        });
      }
    }
  );
}

// ------------------------------------------------------------
// ANALYZE
// ------------------------------------------------------------

app.get("/api/analyze/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const [detail, bundle] =
      await Promise.all([
        getEventDetail(id).catch(() => ({
          id
        })),
        getBundle(id)
      ]);

    const event = normalizeEvent(detail);

    const analysis = analyzeBundle(
      bundle,
      event
    );

    const info = eventInfo(
      event,
      bundle
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      event: info,

      eventId: id,

      ...analysis
    });
  } catch (error) {
    console.error(
      `GET /api/analyze/${id}:`,
      error
    );

    res.status(
      error?.httpStatus === 401 ||
      error?.httpStatus === 402 ||
      error?.httpStatus === 429
        ? error.httpStatus
        : 502
    ).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      endpoint: `/api/analyze/${id}`,
      eventId: id,
      error: publicError(error)
    });
  }
});

// ------------------------------------------------------------
// TOP PICKS
// ------------------------------------------------------------

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date()
        .toISOString()
        .slice(0, 10);

    const result =
      await getTopPicks(date);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      ...result
    });
  } catch (error) {
    console.error(
      "GET /api/top-picks:",
      error
    );

    res.status(502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      endpoint: "/api/top-picks",
      error: publicError(error)
    });
  }
});

// ------------------------------------------------------------
// COVERAGE
// ------------------------------------------------------------

app.get("/api/coverage", async (req, res) => {
  try {
    const raw = await bsdFetch(
      "/coverage/"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      raw
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      endpoint: "/api/coverage",
      error: publicError(error)
    });
  }
});

// ------------------------------------------------------------
// EXCHANGE STATUS
// ------------------------------------------------------------

app.get(
  "/api/events/:id/polymarket",
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,

      exchange: {
        connected: false,
        status: "EXCHANGE_UNAVAILABLE",

        reason:
          "No verified betting-exchange feed is connected. No exchange signal is fabricated."
      }
    });
  }
);

// ------------------------------------------------------------
// 404
// ------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    source: SOURCE,
    error: "Endpoint not found",
    path: req.originalUrl,

    availableEndpoints: [
      "/",
      "/health",
      "/api/events",
      "/api/events/live",
      "/api/events/:id",
      "/api/events/:id/prediction",
      "/api/events/:id/odds",
      "/api/events/:id/h2h",
      "/api/events/:id/stats",
      "/api/events/:id/form",
      "/api/events/:id/lineups",
      "/api/events/:id/incidents",
      "/api/analyze/:id",
      "/api/top-picks",
      "/api/coverage"
    ]
  });
});

// ------------------------------------------------------------
// GLOBAL ERROR
// ------------------------------------------------------------

app.use((error, req, res, next) => {
  console.error(
    "GLOBAL ERROR:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    version: VERSION,
    source: SOURCE,
    error: publicError(error)
  });
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
  );
});
