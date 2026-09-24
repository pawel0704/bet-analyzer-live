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

const VERSION = "6.1.0";
const SOURCE = "BSD";

const CONFIG = {
  requestTimeout: 10000,
  retries: 1,

  // Zmniejszamy z 50 do 20
  maxEvents: 20,

  maxPicks: 10,
  maxPicksPerEvent: 2,

  highProbabilityMin: 60,
  highProbabilityScoreMin: 58,
  highProbabilityValueMin: -3,

  valueProbabilityMin: 35,
  valueScoreMin: 55,
  valueMin: 5
};

if (!BSD_API_KEY) {
  console.error("ERROR: BSD_API_KEY is missing.");
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function safeText(value, fallback = null) {
  if (value === undefined || value === null) return fallback;

  if (typeof value === "string") {
    const text = value.trim();
    return text || fallback;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
   BSD HTTP
========================================================= */

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = `${BSD_BASE}${path}`;

  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, CONFIG.requestTimeout);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",

        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },

        signal: controller.signal
      });

      clearTimeout(timeout);

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
          `BSD HTTP ${response.status} ${response.statusText}`
        );

        error.status = response.status;
        error.data = data;

        throw error;
      }

      return data;

    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (attempt < CONFIG.retries) {
        await sleep(400);
      }
    }
  }

  throw lastError || new Error("BSD request failed");
}

/* =========================================================
   GENERIC RESULT EXTRACTION
========================================================= */

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

  if (Array.isArray(data.events)) {
    return data.events;
  }

  if (Array.isArray(data.items)) {
    return data.items;
  }

  if (data.data && typeof data.data === "object") {
    if (Array.isArray(data.data.results)) {
      return data.data.results;
    }

    if (Array.isArray(data.data.events)) {
      return data.data.events;
    }

    if (Array.isArray(data.data.items)) {
      return data.data.items;
    }
  }

  return [];
}

/* =========================================================
   EVENT NORMALIZATION
========================================================= */

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  /*
   * BSD ACTUAL FORMAT:
   *
   * home_team: "Real Valladolid"
   * away_team: "UD Las Palmas"
   * event_date: "2027-06-06T19:00:00+00:00"
   */

  const home =
    event.home_team_name ||
    (typeof event.home_team === "string" ? event.home_team : null) ||
    event.home_team?.name ||
    (typeof event.home === "string" ? event.home : null) ||
    event.home?.name ||
    event.teams?.home?.name ||
    null;

  const away =
    event.away_team_name ||
    (typeof event.away_team === "string" ? event.away_team : null) ||
    event.away_team?.name ||
    (typeof event.away === "string" ? event.away : null) ||
    event.away?.name ||
    event.teams?.away?.name ||
    null;

  const id =
    event.id ??
    event.event_id ??
    event.eventId ??
    null;

  const date =
    event.event_date ||
    event.date ||
    event.start_time ||
    event.startTime ||
    event.kickoff ||
    null;

  const league =
    event.league_name ||
    event.league?.name ||
    (typeof event.league === "string" ? event.league : null) ||
    null;

  const leagueId =
    event.league_id ??
    event.leagueId ??
    event.league?.id ??
    null;

  const seasonId =
    event.season_id ??
    event.seasonId ??
    event.season?.id ??
    null;

  const status =
    event.status ||
    event.event_status ||
    "unknown";

  return {
    id,
    home: safeText(home, "Home"),
    away: safeText(away, "Away"),
    date,
    status,
    league: safeText(league, ""),
    leagueId,
    seasonId,
    raw: event
  };
}

/* =========================================================
   EVENTS
========================================================= */

async function getEvents(options = {}) {
  const requestedDate = options.date || getTodayUTC();

  const limit = Math.min(
    Number(options.limit) || CONFIG.maxEvents,
    CONFIG.maxEvents
  );

  const params = new URLSearchParams();

  params.set("limit", String(limit));
  params.set("offset", "0");

  /*
   * VERY IMPORTANT:
   * Without date filtering BSD can return future fixtures
   * such as 2027.
   */

  params.set("date_from", requestedDate);
  params.set("date_to", requestedDate);

  if (options.status) {
    params.set("status", options.status);
  }

  const path = `/events/?${params.toString()}`;

  const raw = await bsdFetch(path);

  const results = extractResults(raw);

  const events = results
    .map(normalizeEvent)
    .filter(Boolean)
    .slice(0, limit);

  return {
    requestedDate,
    limit,
    raw,
    results,
    events
  };
}

/* =========================================================
   SINGLE EVENT
========================================================= */

async function getEventDetail(id) {
  const endpoints = [
    `/events/${id}/`,
    `/event/${id}/`
  ];

  let lastError = null;

  for (const path of endpoints) {
    try {
      return await bsdFetch(path);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Event ${id} not found`);
}

/* =========================================================
   RESOURCE FETCH
========================================================= */

async function getResource(id, resource) {
  const endpoints = [
    `/events/${id}/${resource}/`,
    `/event/${id}/${resource}/`,
    `/${resource}/${id}/`
  ];

  let lastError = null;

  for (const path of endpoints) {
    try {
      return await bsdFetch(path);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    __error: true,
    resource,
    message: lastError?.message || "Resource unavailable"
  };
}

/* =========================================================
   BUNDLE
========================================================= */

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

  const entries = await Promise.all(
    resources.map(async resource => {
      const data = await getResource(id, resource);
      return [resource, data];
    })
  );

  return Object.fromEntries(entries);
}

/* =========================================================
   PREDICTION
========================================================= */

function parsePrediction(data) {
  if (!data || data.__error) {
    return {
      available: false,
      home: null,
      draw: null,
      away: null,
      over15: null,
      over25: null,
      over35: null,
      bttsYes: null,
      xgHome: null,
      xgAway: null,
      confidence: null,
      predicted: null,
      mostLikelyScore: null,
      raw: data || null
    };
  }

  const source =
    data.prediction ||
    data.data?.prediction ||
    data.data ||
    data;

  const home = firstNumber(
    source.home,
    source.home_probability,
    source.homeProbability,
    source.home_win,
    source.homeWin
  );

  const draw = firstNumber(
    source.draw,
    source.draw_probability,
    source.drawProbability
  );

  const away = firstNumber(
    source.away,
    source.away_probability,
    source.awayProbability,
    source.away_win,
    source.awayWin
  );

  const over15 = firstNumber(
    source.over15,
    source.over_15,
    source.over15_probability
  );

  const over25 = firstNumber(
    source.over25,
    source.over_25,
    source.over25_probability
  );

  const over35 = firstNumber(
    source.over35,
    source.over_35,
    source.over35_probability
  );

  const bttsYes = firstNumber(
    source.bttsYes,
    source.btts_yes,
    source.btts_yes_probability
  );

  const xgHome = firstNumber(
    source.xgHome,
    source.xg_home,
    source.home_xg
  );

  const xgAway = firstNumber(
    source.xgAway,
    source.xg_away,
    source.away_xg
  );

  const confidence = firstNumber(
    source.confidence,
    source.confidence_score
  );

  const predicted =
    source.predicted ||
    source.prediction ||
    null;

  const mostLikelyScore =
    source.mostLikelyScore ||
    source.most_likely_score ||
    source.predicted_score ||
    null;

  const available =
    home !== null ||
    draw !== null ||
    away !== null ||
    over15 !== null ||
    over25 !== null ||
    bttsYes !== null;

  return {
    available,
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
    mostLikelyScore,
    raw: data
  };
}

/* =========================================================
   ODDS
========================================================= */

function parseOdds(data) {
  if (!data || data.__error) {
    return {
      available: false,
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
      previous: null,
      updatedAt: null,
      raw: data || null
    };
  }

  const source =
    data.odds ||
    data.data?.odds ||
    data.data ||
    data;

  const result = {
    available: false,

    home: firstNumber(source.home),
    draw: firstNumber(source.draw),
    away: firstNumber(source.away),

    over15: firstNumber(
      source.over15,
      source.over_15
    ),

    under15: firstNumber(
      source.under15,
      source.under_15
    ),

    over25: firstNumber(
      source.over25,
      source.over_25
    ),

    under25: firstNumber(
      source.under25,
      source.under_25
    ),

    over35: firstNumber(
      source.over35,
      source.over_35
    ),

    under35: firstNumber(
      source.under35,
      source.under_35
    ),

    bttsYes: firstNumber(
      source.bttsYes,
      source.btts_yes
    ),

    bttsNo: firstNumber(
      source.bttsNo,
      source.btts_no
    ),

    previous:
      source.previous ||
      source.previous_odds ||
      null,

    updatedAt:
      source.updatedAt ||
      source.updated_at ||
      null,

    raw: data
  };

  result.available =
    result.home !== null ||
    result.draw !== null ||
    result.away !== null ||
    result.over15 !== null ||
    result.over25 !== null ||
    result.over35 !== null ||
    result.bttsYes !== null;

  return result;
}

/* =========================================================
   H2H
========================================================= */

function parseH2H(data) {
  if (!data || data.__error) {
    return {
      sampleSize: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      homeGoals: 0,
      awayGoals: 0,
      averageGoals: null,
      matches: [],
      raw: data || null
    };
  }

  const source =
    data.h2h ||
    data.data?.h2h ||
    data.data ||
    data;

  const matches =
    source.matches ||
    source.results ||
    source.events ||
    [];

  const list = Array.isArray(matches) ? matches : [];

  const sampleSize = list.length;

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let homeGoals = 0;
  let awayGoals = 0;

  for (const match of list) {
    const hs = numberOrNull(
      match.home_score ??
      match.homeScore
    );

    const as = numberOrNull(
      match.away_score ??
      match.awayScore
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

    matches: list.slice(0, 10).map(match => ({
      home:
        match.home_team ||
        match.home ||
        match.homeTeam ||
        null,

      away:
        match.away_team ||
        match.away ||
        match.awayTeam ||
        null,

      date:
        match.event_date ||
        match.date ||
        null,

      score:
        match.score ||
        null,

      event_id:
        match.event_id ||
        match.id ||
        null,

      home_score:
        match.home_score ??
        match.homeScore ??
        null,

      away_score:
        match.away_score ??
        match.awayScore ??
        null
    })),

    raw: data
  };
}

/* =========================================================
   FORM
========================================================= */

function parseForm(data) {
  if (!data || data.__error) {
    return {
      available: false,
      home: [],
      away: [],
      score: 0,
      details: null,
      raw: data || null
    };
  }

  const source =
    data.form ||
    data.data?.form ||
    data.data ||
    data;

  const home =
    source.home ||
    source.home_form ||
    [];

  const away =
    source.away ||
    source.away_form ||
    [];

  const homeList = Array.isArray(home) ? home : [];
  const awayList = Array.isArray(away) ? away : [];

  return {
    available:
      homeList.length > 0 ||
      awayList.length > 0,

    home: homeList,
    away: awayList,

    score: 0,

    details: {
      homeMatches: homeList.length,
      awayMatches: awayList.length
    },

    raw: data
  };
}

/* =========================================================
   STATS
========================================================= */

function parseStats(data) {
  if (!data || data.__error) {
    return {
      available: false,
      score: 0,
      details: [],
      raw: data || null
    };
  }

  const source =
    data.stats ||
    data.data?.stats ||
    data.data ||
    data;

  const home =
    source.home ||
    {};

  const away =
    source.away ||
    {};

  const details = [
    {
      metric: "shotsOnTarget",
      home: numberOrNull(
        home.shots_on_target
      ),
      away: numberOrNull(
        away.shots_on_target
      )
    },

    {
      metric: "shots",
      home: numberOrNull(
        home.total_shots
      ),
      away: numberOrNull(
        away.total_shots
      )
    },

    {
      metric: "possession",
      home: numberOrNull(
        home.ball_possession
      ),
      away: numberOrNull(
        away.ball_possession
      )
    },

    {
      metric: "corners",
      home: numberOrNull(
        home.corner_kicks
      ),
      away: numberOrNull(
        away.corner_kicks
      )
    }
  ];

  const available = details.some(
    item =>
      item.home !== null ||
      item.away !== null
  );

  return {
    available,
    score: available ? 1 : 0,
    details,
    raw: data
  };
}

/* =========================================================
   LINEUPS
========================================================= */

function parseLineups(data) {
  if (!data || data.__error) {
    return {
      available: false,
      score: 0,
      details: null,
      raw: data || null
    };
  }

  const source =
    data.lineups ||
    data.data?.lineups ||
    data.data ||
    data;

  const home =
    source.home ||
    {};

  const away =
    source.away ||
    {};

  const homePlayers =
    Array.isArray(home.players)
      ? home.players.length
      : 0;

  const awayPlayers =
    Array.isArray(away.players)
      ? away.players.length
      : 0;

  const available =
    homePlayers > 0 ||
    awayPlayers > 0;

  return {
    available,

    score:
      available ? 2 : 0,

    details: {
      homePlayers,
      awayPlayers,

      completeHome:
        homePlayers >= 11,

      completeAway:
        awayPlayers >= 11,

      homeFormation:
        home.formation ||
        null,

      awayFormation:
        away.formation ||
        null
    },

    raw: data
  };
}

/* =========================================================
   REFEREE
========================================================= */

function parseReferee(data) {
  if (!data || data.__error) {
    return {
      available: false,
      id: null,
      name: null,
      statsAvailable: false,
      score: 0,
      note: "Referee data unavailable."
    };
  }

  const source =
    data.referee ||
    data.data?.referee ||
    data.data ||
    data;

  const id =
    source.id ||
    source.referee_id ||
    null;

  const name =
    source.name ||
    source.referee_name ||
    null;

  const statsAvailable =
    Boolean(
      source.stats ||
      source.referee_stats
    );

  return {
    available: Boolean(id || name),
    id,
    name,
    statsAvailable,
    score: id || name ? 1 : 0,
    note:
      id || name
        ? null
        : "Referee data unavailable."
  };
}

/* =========================================================
   EVENT INFO
========================================================= */

function eventInfo(event, bundle) {
  const normalized = event || {};

  const detailPrediction =
    parsePrediction(bundle?.prediction);

  return {
    home:
      normalized.home ||
      "Home",

    away:
      normalized.away ||
      "Away",

    date:
      normalized.date ||
      null,

    status:
      normalized.status ||
      "unknown",

    league:
      normalized.league ||
      "",

    leagueId:
      normalized.leagueId ??
      null,

    seasonId:
      normalized.seasonId ??
      null,

    predictionAvailable:
      detailPrediction.available
  };
}

/* =========================================================
   CANDIDATES
========================================================= */

function createCandidate({
  market,
  label,
  probability,
  odds,
  reasons
}) {
  if (
    probability === null ||
    probability === undefined ||
    odds === null ||
    odds === undefined ||
    odds <= 1
  ) {
    return null;
  }

  const impliedProbability =
    100 / odds;

  const valuePercent =
    probability - impliedProbability;

  let score =
    probability * 0.65 +
    Math.max(valuePercent, -20) * 1.5;

  score = Math.max(
    0,
    Math.min(100, score)
  );

  const highProbability =
    probability >= CONFIG.highProbabilityMin &&
    score >= CONFIG.highProbabilityScoreMin &&
    valuePercent >= CONFIG.highProbabilityValueMin;

  const valuePick =
    probability >= CONFIG.valueProbabilityMin &&
    score >= CONFIG.valueScoreMin &&
    valuePercent >= CONFIG.valueMin;

  const accepted =
    highProbability ||
    valuePick;

  const rejectionReasons = [];

  if (
    probability < CONFIG.highProbabilityMin &&
    !valuePick
  ) {
    rejectionReasons.push(
      "PROBABILITY_LT_MIN"
    );
  }

  if (
    valuePercent < CONFIG.highProbabilityValueMin &&
    !valuePick
  ) {
    rejectionReasons.push(
      "VALUE_LT_MIN"
    );
  }

  if (
    score < CONFIG.highProbabilityScoreMin &&
    !valuePick
  ) {
    rejectionReasons.push(
      "SCORE_LT_MIN"
    );
  }

  return {
    market,
    label,

    probability:
      Math.round(probability * 100) / 100,

    odds:
      Math.round(odds * 100) / 100,

    impliedProbability:
      Math.round(impliedProbability * 100) / 100,

    valuePercent:
      Math.round(valuePercent * 100) / 100,

    score:
      Math.round(score * 100) / 100,

    accepted,

    rejectionReasons,

    movement: {
      available: false,
      direction: "UNKNOWN",
      percent: null
    },

    reasons: reasons || []
  };
}

/* =========================================================
   ANALYSIS
========================================================= */

function analyzeBundle(bundle, event) {
  const prediction =
    parsePrediction(
      bundle.prediction
    );

  const odds =
    parseOdds(
      bundle.odds
    );

  const h2h =
    parseH2H(
      bundle.h2h
    );

  const form =
    parseForm(
      bundle.form
    );

  const stats =
    parseStats(
      bundle.stats
    );

  const lineups =
    parseLineups(
      bundle.lineups
    );

  const referee =
    parseReferee(
      bundle.referee
    );

  const candidates = [];

  function addCandidate(config) {
    const candidate =
      createCandidate(config);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  addCandidate({
    market: "over15",
    label: "Over 1.5 goals",
    probability: prediction.over15,
    odds: odds.over15,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null
        ? "Combined xG supports Over 1.5"
        : null,

      h2h.averageGoals !== null &&
      h2h.averageGoals >= 2
        ? "H2H goal average supports Over 1.5"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "over25",
    label: "Over 2.5 goals",
    probability: prediction.over25,
    odds: odds.over25,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 2.5
        ? "Combined xG supports Over 2.5"
        : null,

      h2h.averageGoals !== null &&
      h2h.averageGoals >= 2.5
        ? "H2H goal average supports Over 2.5"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "over35",
    label: "Over 3.5 goals",
    probability: prediction.over35,
    odds: odds.over35,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 3.5
        ? "Very high combined xG"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "bttsYes",
    label: "Both teams to score — Yes",
    probability: prediction.bttsYes,
    odds: odds.bttsYes,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome >= 0.8 &&
      prediction.xgAway >= 0.8
        ? "xG supports both teams scoring"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "home",
    label: "Home win",
    probability: prediction.home,
    odds: odds.home,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome > prediction.xgAway
        ? "xG favors home"
        : null,

      h2h.homeWins > h2h.awayWins
        ? "H2H favors home"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "draw",
    label: "Draw",
    probability: prediction.draw,
    odds: odds.draw,

    reasons: [
      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  addCandidate({
    market: "away",
    label: "Away win",
    probability: prediction.away,
    odds: odds.away,

    reasons: [
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgAway > prediction.xgHome
        ? "xG favors away"
        : null,

      h2h.awayWins > h2h.homeWins
        ? "H2H favors away"
        : null,

      lineups.available
        ? "Lineup data available"
        : null
    ].filter(Boolean)
  });

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  const qualified =
    candidates
      .filter(c => c.accepted)
      .slice(
        0,
        CONFIG.maxPicksPerEvent
      );

  const rejected =
    candidates.filter(
      c => !c.accepted
    );

  const bookmakerMovement =
    odds.previous
      ? true
      : false;

  const exchange = {
    connected: false,
    status: "EXCHANGE_UNAVAILABLE",
    reason:
      "No verified betting-exchange feed is connected. No exchange signal is fabricated."
  };

  return {
    prediction,
    odds,
    h2h,
    form,
    stats,
    lineups,
    referee,

    exchange,

    bookmakerMovement,

    candidates,
    qualified,
    rejected,

    coverage: {
      prediction:
        prediction.available,

      odds:
        odds.available,

      h2h:
        h2h.sampleSize > 0,

      stats:
        stats.available,

      form:
        form.available,

      lineups:
        lineups.available,

      incidents:
        Boolean(
          bundle.incidents &&
          !bundle.incidents.__error
        ),

      referee:
        referee.available,

      refereeStats:
        referee.statsAvailable,

      bookmakerMovement:
        bookmakerMovement,

      exchangeMovement:
        false
    }
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
    timestamp: new Date().toISOString()
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

/* ---------------------------------------------------------
   EVENTS
--------------------------------------------------------- */

app.get("/api/events", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const limit = Math.min(
      Number(req.query.limit) || 20,
      20
    );

    const result =
      await getEvents({
        date,
        limit,
        status:
          req.query.status
      });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      requestedDate:
        result.requestedDate,

      count:
        result.events.length,

      events:
        result.events
    });

  } catch (error) {
    console.error(
      "GET /api/events ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "EVENTS_FAILED",
      message: error.message
    });
  }
});

/* ---------------------------------------------------------
   ANALYZE
--------------------------------------------------------- */

app.get("/api/analyze/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "EVENT_ID_REQUIRED"
      });
    }

    const [
      detail,
      bundle
    ] = await Promise.all([
      getEventDetail(id).catch(
        () => ({ id })
      ),

      getBundle(id)
    ]);

    const event =
      normalizeEvent(detail) || {
        id,
        home: "Home",
        away: "Away",
        date: null,
        status: "unknown",
        league: ""
      };

    const analysis =
      analyzeBundle(
        bundle,
        event
      );

    const info =
      eventInfo(
        event,
        bundle
      );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      event: info,
      eventId: id,

      prediction:
        analysis.prediction,

      odds:
        analysis.odds,

      h2h:
        analysis.h2h,

      form:
        analysis.form,

      stats:
        analysis.stats,

      lineups:
        analysis.lineups,

      referee:
        analysis.referee,

      exchange:
        analysis.exchange,

      candidates:
        analysis.candidates,

      qualified:
        analysis.qualified,

      rejected:
        analysis.rejected,

      coverage:
        analysis.coverage
    });

  } catch (error) {
    console.error(
      "GET /api/analyze ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "ANALYZE_FAILED",
      message: error.message,
      eventId: req.params.id
    });
  }
});

/* ---------------------------------------------------------
   TOP PICKS
--------------------------------------------------------- */

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const eventsResult =
      await getEvents({
        date,
        limit: 20
      });

    const events =
      eventsResult.events;

    const allPicks = [];

    /*
     * Analizujemy maksymalnie 20 meczów.
     * Jeden problematyczny mecz nie zatrzymuje całości.
     */

    for (const event of events) {
      try {
        const bundle =
          await getBundle(event.id);

        const analysis =
          analyzeBundle(
            bundle,
            event
          );

        for (
          const pick of analysis.qualified
        ) {
          allPicks.push({
            eventId:
              event.id,

            home:
              event.home,

            away:
              event.away,

            date:
              event.date,

            league:
              event.league,

            ...pick
          });
        }

      } catch (error) {
        console.error(
          `Top pick event ${event.id} failed:`,
          error.message
        );
      }
    }

    allPicks.sort(
      (a, b) =>
        b.score - a.score
    );

    const picks =
      allPicks.slice(
        0,
        CONFIG.maxPicks
      );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      date,

      eventsScanned:
        events.length,

      picksFound:
        picks.length,

      picks
    });

  } catch (error) {
    console.error(
      "GET /api/top-picks ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "TOP_PICKS_FAILED",
      message: error.message
    });
  }
});

/* ---------------------------------------------------------
   EXCHANGE
--------------------------------------------------------- */

app.get("/api/exchange/status", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",

      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated."
    }
  });
});

/* ---------------------------------------------------------
   COVERAGE
--------------------------------------------------------- */

app.get("/api/coverage", async (req, res) => {
  try {
    const data =
      await bsdFetch(
        "/coverage/"
      );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      coverage: data
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: "COVERAGE_FAILED",
      message: error.message
    });
  }
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "NOT_FOUND",
    path: req.originalUrl
  });
});

/* =========================================================
   GLOBAL ERROR
========================================================= */

app.use((error, req, res, next) => {
  console.error(
    "GLOBAL ERROR:",
    error
  );

  res.status(500).json({
    ok: false,
    version: VERSION,
    error: "INTERNAL_SERVER_ERROR",
    message: error.message
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
