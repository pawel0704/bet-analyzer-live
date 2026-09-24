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

const VERSION = "6.3.0";
const SOURCE = "BSD";

const CONFIG = {
  maxEvents: 20,
  timeoutMs: 12000,
  retries: 1,

  thresholds: {
    highProbabilityMin: 60,
    highProbabilityScoreMin: 58,
    highProbabilityValueMin: -3,

    valueProbabilityMin: 35,
    valueScoreMin: 55,
    valueMin: 5
  }
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

/* =========================================================
   HELPERS
========================================================= */

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);

    if (n !== null) {
      return n;
    }
  }

  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (
      value !== null &&
      value !== undefined &&
      String(value).trim() !== ""
    ) {
      return String(value);
    }
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  if (!value) return null;

  try {
    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return String(value);
    }

    return d.toISOString();
  } catch {
    return String(value);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
   BSD FETCH
========================================================= */

async function bsdFetch(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const cleanPath =
    path.startsWith("/")
      ? path
      : `/${path}`;

  const url =
    `${BSD_BASE}${cleanPath}`;

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= CONFIG.retries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        CONFIG.timeoutMs
      );

    try {
      const response =
        await fetch(url, {
          method: "GET",

          headers: {
            Authorization:
              `Token ${BSD_API_KEY}`,

            Accept:
              "application/json",

            "Content-Type":
              "application/json"
          },

          signal:
            controller.signal
        });

      clearTimeout(timer);

      const text =
        await response.text();

      let data = null;

      try {
        data =
          text
            ? JSON.parse(text)
            : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        const error =
          new Error(
            `BSD HTTP ${response.status} ${response.statusText}`
          );

        error.status =
          response.status;

        error.data = data;

        throw error;
      }

      return data;
    } catch (error) {
      clearTimeout(timer);

      lastError = error;

      if (
        attempt <
        CONFIG.retries
      ) {
        await sleep(350);
      }
    }
  }

  throw (
    lastError ||
    new Error("BSD request failed")
  );
}

/* =========================================================
   EXTRACT RESULTS
========================================================= */

function extractResults(data) {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data;
  }

  const possible = [
    data.results,
    data.events,
    data.data,
    data.items,
    data.matches
  ];

  for (const value of possible) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

/* =========================================================
   EVENT NORMALIZATION
========================================================= */

function normalizeEvent(event) {
  if (
    !event ||
    typeof event !== "object"
  ) {
    return null;
  }

  const home =
    firstString(
      event.home_team_name,

      typeof event.home_team === "string"
        ? event.home_team
        : null,

      event.home_team?.name,

      typeof event.home === "string"
        ? event.home
        : null,

      event.home?.name,

      event.teams?.home?.name
    );

  const away =
    firstString(
      event.away_team_name,

      typeof event.away_team === "string"
        ? event.away_team
        : null,

      event.away_team?.name,

      typeof event.away === "string"
        ? event.away
        : null,

      event.away?.name,

      event.teams?.away?.name
    );

  const date =
    event.event_date ||
    event.date ||
    event.start_time ||
    event.startTime ||
    event.kickoff ||
    null;

  const id =
    event.id ??
    event.event_id ??
    event.eventId ??
    null;

  return {
    id,

    home:
      home || "Unknown",

    away:
      away || "Unknown",

    date:
      normalizeDate(date),

    status:
      event.status ||
      event.event_status ||
      "unknown",

    league:
      event.league_name ||
      event.league ||
      "",

    leagueId:
      event.league_id ??
      event.leagueId ??
      null,

    seasonId:
      event.season_id ??
      event.seasonId ??
      null,

    predictionAvailable:
      Boolean(
        event.prediction ||
        event.prediction_available
      ),

    raw: event
  };
}

/* =========================================================
   EVENTS
========================================================= */

async function getEvents(requestedDate) {
  const date =
    requestedDate ||
    todayUTC();

  const params =
    new URLSearchParams();

  params.set(
    "date_from",
    date
  );

  params.set(
    "date_to",
    date
  );

  params.set(
    "limit",
    String(CONFIG.maxEvents)
  );

  let data;

  try {
    data =
      await bsdFetch(
        `/events/?${params.toString()}`
      );
  } catch (error) {
    return {
      ok: false,

      version: VERSION,
      source: SOURCE,

      requestedDate: date,

      events: [],

      error:
        error.message
    };
  }

  const rawEvents =
    extractResults(data);

  const events =
    rawEvents
      .map(normalizeEvent)
      .filter(Boolean)
      .filter(event => {
        if (!event.date) {
          return true;
        }

        return (
          event.date.slice(0, 10) ===
          date
        );
      })
      .slice(
        0,
        CONFIG.maxEvents
      );

  return {
    ok: true,

    version: VERSION,
    source: SOURCE,

    requestedDate: date,

    count:
      events.length,

    events
  };
}

/* =========================================================
   EVENT DETAIL
========================================================= */

async function getEventDetail(id) {
  const paths = [
    `/events/${id}/`,
    `/event/${id}/`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const data =
        await bsdFetch(path);

      if (data) {
        return data;
      }
    } catch (error) {
      lastError = error;
    }
  }

  return {
    __error: true,

    resource: "event",

    message:
      lastError?.message ||
      "Event detail unavailable"
  };
}

/* =========================================================
   RESOURCE
========================================================= */

async function getResource(
  id,
  resource
) {
  const paths = [
    `/events/${id}/${resource}/`,
    `/event/${id}/${resource}/`,
    `/${resource}/${id}/`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const data =
        await bsdFetch(path);

      if (data) {
        return data;
      }
    } catch (error) {
      lastError = error;
    }
  }

  return {
    __error: true,

    resource,

    message:
      lastError?.message ||
      `${resource} unavailable`
  };
}

/* =========================================================
   PREDICTION
========================================================= */

function parsePrediction(data) {
  if (
    !data ||
    data.__error
  ) {
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

      raw:
        data || null
    };
  }

  const source =
    data.prediction ||
    data.data?.prediction ||
    data.data ||
    data;

  const markets =
    source.markets ||
    data.markets ||
    {};

  const matchResult =
    markets.match_result ||
    {};

  const expectedGoals =
    markets.expected_goals ||
    {};

  const overUnder =
    markets.over_under ||
    {};

  const btts =
    markets.btts ||
    {};

  const model =
    source.model ||
    data.model ||
    {};

  const score =
    markets.score ||
    {};

  const home =
    firstNumber(
      matchResult.prob_home,
      source.home,
      source.home_probability
    );

  const draw =
    firstNumber(
      matchResult.prob_draw,
      source.draw,
      source.draw_probability
    );

  const away =
    firstNumber(
      matchResult.prob_away,
      source.away,
      source.away_probability
    );

  const over15 =
    firstNumber(
      overUnder.prob_over_15,
      source.over15
    );

  const over25 =
    firstNumber(
      overUnder.prob_over_25,
      source.over25
    );

  const over35 =
    firstNumber(
      overUnder.prob_over_35,
      source.over35
    );

  const bttsYes =
    firstNumber(
      btts.prob_yes,
      source.bttsYes
    );

  const xgHome =
    firstNumber(
      expectedGoals.home,
      source.xgHome,
      source.xg_home
    );

  const xgAway =
    firstNumber(
      expectedGoals.away,
      source.xgAway,
      source.xg_away
    );

  const confidence =
    firstNumber(
      model.confidence,
      source.confidence
    );

  const predicted =
    matchResult.predicted ||
    source.predicted ||
    null;

  const mostLikelyScore =
    score.most_likely ||
    source.mostLikelyScore ||
    source.most_likely_score ||
    null;

  const available =
    home !== null ||
    draw !== null ||
    away !== null ||
    over15 !== null ||
    over25 !== null ||
    over35 !== null ||
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
  if (
    !data ||
    data.__error
  ) {
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
      lastChangeAt: null,

      raw:
        data || null
    };
  }

  const source =
    data.odds ||
    data.data?.odds ||
    data.data ||
    data;

  const odds =
    source.odds ||
    source;

  const result = {
    available: false,

    home:
      firstNumber(
        odds.home_win,
        odds.home
      ),

    draw:
      firstNumber(
        odds.draw
      ),

    away:
      firstNumber(
        odds.away_win,
        odds.away
      ),

    over15:
      firstNumber(
        odds.over_15_goals,
        odds.over15
      ),

    under15:
      firstNumber(
        odds.under_15_goals,
        odds.under15
      ),

    over25:
      firstNumber(
        odds.over_25_goals,
        odds.over25
      ),

    under25:
      firstNumber(
        odds.under_25_goals,
        odds.under25
      ),

    over35:
      firstNumber(
        odds.over_35_goals,
        odds.over35
      ),

    under35:
      firstNumber(
        odds.under_35_goals,
        odds.under35
      ),

    bttsYes:
      firstNumber(
        odds.btts_yes,
        odds.bttsYes
      ),

    bttsNo:
      firstNumber(
        odds.btts_no,
        odds.bttsNo
      ),

    previous:
      source.previous ||
      source.previous_odds ||
      null,

    updatedAt:
      source.last_update_at ||
      source.updatedAt ||
      source.updated_at ||
      null,

    lastChangeAt:
      source.last_change_at ||
      source.lastChangeAt ||
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
    result.bttsYes !== null ||
    result.bttsNo !== null;

  return result;
}

/* =========================================================
   H2H
========================================================= */

function parseH2H(data) {
  if (
    !data ||
    data.__error
  ) {
    return {
      sampleSize: 0,

      homeWins: 0,
      draws: 0,
      awayWins: 0,

      homeGoals: 0,
      awayGoals: 0,

      averageGoals: null,

      matches: [],

      raw:
        data || null
    };
  }

  const source =
    data.h2h ||
    data.head_to_head ||
    data.data?.h2h ||
    data.data ||
    data;

  const sampleSize =
    numberOrNull(
      source.total_matches
    ) || 0;

  const homeWins =
    numberOrNull(
      source.home_wins
    ) || 0;

  const draws =
    numberOrNull(
      source.draws
    ) || 0;

  const awayWins =
    numberOrNull(
      source.away_wins
    ) || 0;

  const homeGoals =
    numberOrNull(
      source.home_goals
    ) || 0;

  const awayGoals =
    numberOrNull(
      source.away_goals
    ) || 0;

  const averageGoals =
    numberOrNull(
      source.avg_total_goals
    );

  const matches =
    Array.isArray(
      source.recent_matches
    )
      ? source.recent_matches
      : Array.isArray(
          source.matches
        )
        ? source.matches
        : [];

  return {
    sampleSize,

    homeWins,
    draws,
    awayWins,

    homeGoals,
    awayGoals,

    averageGoals,

    matches:
      matches
        .slice(0, 10)
        .map(match => ({
          home:
            match.home_team ||
            match.home ||
            null,

          away:
            match.away_team ||
            match.away ||
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
   H2H FALLBACK FROM EVENT
========================================================= */

function parseH2HWithFallback(
  h2hData,
  eventRaw
) {
  const direct =
    parseH2H(h2hData);

  if (
    direct.sampleSize > 0
  ) {
    return direct;
  }

  const event =
    eventRaw?.event ||
    eventRaw?.data?.event ||
    eventRaw?.data ||
    eventRaw;

  const eventH2H =
    event?.head_to_head ||
    event?.h2h ||
    null;

  if (
    eventH2H &&
    typeof eventH2H === "object"
  ) {
    return parseH2H({
      head_to_head:
        eventH2H
    });
  }

  return direct;
}

/* =========================================================
   FORM
========================================================= */

function parseForm(data) {
  if (
    !data ||
    data.__error
  ) {
    return {
      available: false,

      home: [],
      away: [],

      score: 0,

      details: null,

      raw:
        data || null
    };
  }

  const source =
    data.form ||
    data.data?.form ||
    data.data ||
    data;

  const home =
    safeArray(
      source.home
    );

  const away =
    safeArray(
      source.away
    );

  const available =
    home.length > 0 ||
    away.length > 0;

  return {
    available,

    home,
    away,

    score:
      available ? 2 : 0,

    details: {
      homeMatches:
        home.length,

      awayMatches:
        away.length
    },

    raw: data
  };
}

/* =========================================================
   STATS
========================================================= */

function parseStats(data) {
  if (
    !data ||
    data.__error
  ) {
    return {
      available: false,

      score: 0,

      details: [],

      raw:
        data || null
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

  const possessionHome =
    numberOrNull(
      home.ball_possession
    );

  const possessionAway =
    numberOrNull(
      away.ball_possession
    );

  const shotsHome =
    numberOrNull(
      home.total_shots
    );

  const shotsAway =
    numberOrNull(
      away.total_shots
    );

  const shotsOnTargetHome =
    numberOrNull(
      home.shots_on_target
    );

  const shotsOnTargetAway =
    numberOrNull(
      away.shots_on_target
    );

  const cornersHome =
    numberOrNull(
      home.corner_kicks
    );

  const cornersAway =
    numberOrNull(
      away.corner_kicks
    );

  const actualDataExists =
    [
      possessionHome,
      possessionAway,
      shotsHome,
      shotsAway,
      shotsOnTargetHome,
      shotsOnTargetAway,
      cornersHome,
      cornersAway
    ].some(
      value =>
        value !== null
    );

  if (!actualDataExists) {
    return {
      available: false,

      score: 0,

      details: [],

      raw: data
    };
  }

  return {
    available: true,

    score: 1,

    details: [
      {
        metric:
          "shotsOnTarget",

        home:
          shotsOnTargetHome,

        away:
          shotsOnTargetAway
      },

      {
        metric: "shots",

        home:
          shotsHome,

        away:
          shotsAway
      },

      {
        metric:
          "possession",

        home:
          possessionHome,

        away:
          possessionAway
      },

      {
        metric: "corners",

        home:
          cornersHome,

        away:
          cornersAway
      }
    ],

    raw: data
  };
}

/* =========================================================
   LINEUPS
========================================================= */

function parseLineups(data) {
  if (
    !data ||
    data.__error
  ) {
    return {
      available: false,

      score: 0,

      details: null,

      raw:
        data || null
    };
  }

  const source =
    data.lineups ||
    data.data?.lineups ||
    data.data ||
    data;

  const home =
    source.home ||
    source.lineups?.home ||
    {};

  const away =
    source.away ||
    source.lineups?.away ||
    {};

  const homePlayers =
    safeArray(
      home.players
    );

  const awayPlayers =
    safeArray(
      away.players
    );

  const completeHome =
    homePlayers.length >= 11;

  const completeAway =
    awayPlayers.length >= 11;

  const available =
    completeHome ||
    completeAway;

  return {
    available,

    score:
      completeHome &&
      completeAway
        ? 2
        : available
          ? 1
          : 0,

    details: {
      homePlayers:
        homePlayers.length,

      awayPlayers:
        awayPlayers.length,

      completeHome,
      completeAway,

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
  if (
    !data ||
    data.__error
  ) {
    return {
      available: false,

      id: null,
      name: null,

      statsAvailable: false,

      score: 0,

      note:
        "Referee data unavailable."
    };
  }

  const source =
    data.referee ||
    data.data?.referee ||
    data.data ||
    data;

  const id =
    source.id ??
    source.referee_id ??
    null;

  const name =
    source.name ||
    source.referee_name ||
    null;

  const stats =
    source.stats ||
    source.referee_stats ||
    null;

  return {
    available:
      Boolean(
        id || name
      ),

    id,
    name,

    statsAvailable:
      Boolean(stats),

    score:
      id || name ? 1 : 0,

    note:
      id || name
        ? "Referee data available."
        : "Referee data unavailable."
  };
}

/* =========================================================
   BOOKMAKER MOVEMENT
========================================================= */

function parseBookmakerMovement(
  odds
) {
  if (!odds) {
    return {
      available: false,

      direction:
        "UNKNOWN",

      percent: null
    };
  }

  /*
    BSD currently gives us:
    last_update_at
    last_change_at

    but NOT the previous numerical odds.

    Therefore we do NOT calculate a fake
    percentage movement.
  */

  if (
    !odds.previous
  ) {
    return {
      available: false,

      direction:
        "UNKNOWN",

      percent: null,

      lastChangeAt:
        odds.lastChangeAt ||
        null,

      note:
        "Current odds timestamp is available, but previous numerical odds are not verified."
    };
  }

  return {
    available: false,

    direction:
      "UNKNOWN",

    percent: null,

    note:
      "Historical bookmaker movement is not verified by the connected BSD response."
  };
}

/* =========================================================
   EXCHANGE
========================================================= */

function exchangeStatus() {
  return {
    connected: false,

    status:
      "EXCHANGE_UNAVAILABLE",

    reason:
      "No verified betting-exchange feed is connected. No exchange signal is fabricated."
  };
}

/* =========================================================
   PROBABILITY
========================================================= */

function impliedProbability(
  odds
) {
  if (
    odds === null ||
    odds === undefined ||
    odds <= 0
  ) {
    return null;
  }

  return 100 / odds;
}

function valuePercent(
  probability,
  odds
) {
  if (
    probability === null ||
    odds === null ||
    odds <= 0
  ) {
    return null;
  }

  const implied =
    impliedProbability(
      odds
    );

  if (
    implied === null
  ) {
    return null;
  }

  return (
    probability -
    implied
  );
}

/* =========================================================
   CANDIDATE
========================================================= */

function createCandidate({
  market,
  label,
  probability,
  odds,
  prediction,
  h2h,
  lineups,
  form,
  movement
}) {
  if (
    probability === null ||
    probability === undefined
  ) {
    return null;
  }

  const implied =
    impliedProbability(
      odds
    );

  const value =
    valuePercent(
      probability,
      odds
    );

  let score =
    probability * 0.7;

  /*
    Supporting data should increase the score,
    but only when it actually exists.
  */

  if (
    value !== null
  ) {
    score +=
      Math.max(
        -10,
        Math.min(
          10,
          value
        )
      ) * 2;
  }

  if (
    prediction?.xgHome !== null &&
    prediction?.xgAway !== null
  ) {
    score += 2;
  }

  if (
    h2h?.sampleSize >= 3
  ) {
    score += 1;
  }

  if (
    lineups?.available
  ) {
    score += 2;
  }

  if (
    form?.available
  ) {
    score += 2;
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  const rejectionReasons = [];

  const highProbability =
    probability >=
      CONFIG.thresholds
        .highProbabilityMin &&

    score >=
      CONFIG.thresholds
        .highProbabilityScoreMin &&

    (
      value === null ||
      value >=
        CONFIG.thresholds
          .highProbabilityValueMin
    );

  const valuePick =
    probability >=
      CONFIG.thresholds
        .valueProbabilityMin &&

    score >=
      CONFIG.thresholds
        .valueScoreMin &&

    value !== null &&

    value >=
      CONFIG.thresholds
        .valueMin;

  if (
    probability <
    CONFIG.thresholds
      .highProbabilityMin
  ) {
    rejectionReasons.push(
      "PROBABILITY_LT_MIN"
    );
  }

  if (
    value !== null &&
    value <
      CONFIG.thresholds
        .valueMin
  ) {
    rejectionReasons.push(
      "VALUE_LT_MIN"
    );
  }

  if (
    score <
    CONFIG.thresholds
      .valueScoreMin
  ) {
    rejectionReasons.push(
      "SCORE_LT_MIN"
    );
  }

  const reasons = [];

  if (
    probability >= 60
  ) {
    reasons.push(
      "High model probability"
    );
  }

  if (
    value !== null &&
    value >= 5
  ) {
    reasons.push(
      "Positive model value"
    );
  }

  if (
    prediction?.xgHome !== null &&
    prediction?.xgAway !== null
  ) {
    reasons.push(
      "Expected-goals data available"
    );
  }

  if (
    h2h?.sampleSize >= 3
  ) {
    reasons.push(
      "H2H data available"
    );
  }

  if (
    lineups?.available
  ) {
    reasons.push(
      "Confirmed lineup data available"
    );
  }

  if (
    form?.available
  ) {
    reasons.push(
      "Recent form data available"
    );
  }

  if (
    movement?.available
  ) {
    reasons.push(
      "Bookmaker movement available"
    );
  }

  if (
    reasons.length === 0
  ) {
    reasons.push(
      "Limited supporting data"
    );
  }

  return {
    market,

    label,

    probability,

    odds:
      odds !== null
        ? odds
        : null,

    impliedProbability:
      implied,

    valuePercent:
      value,

    score:
      Number(
        score.toFixed(2)
      ),

    accepted:
      Boolean(
        highProbability ||
        valuePick
      ),

    rejectionReasons:
      highProbability ||
      valuePick
        ? []
        : rejectionReasons,

    movement:
      movement || {
        available: false,

        direction:
          "UNKNOWN",

        percent: null
      },

    reasons
  };
}

/* =========================================================
   BUILD CANDIDATES
========================================================= */

function buildCandidates(
  prediction,
  odds,
  h2h,
  form,
  lineups
) {
  if (
    !prediction.available
  ) {
    return [];
  }

  const candidates = [];

  const movement =
    parseBookmakerMovement(
      odds
    );

  const definitions = [
    {
      market: "home",

      label:
        "Home win",

      probability:
        prediction.home,

      odds:
        odds.home
    },

    {
      market: "draw",

      label:
        "Draw",

      probability:
        prediction.draw,

      odds:
        odds.draw
    },

    {
      market: "away",

      label:
        "Away win",

      probability:
        prediction.away,

      odds:
        odds.away
    },

    {
      market: "over15",

      label:
        "Over 1.5 goals",

      probability:
        prediction.over15,

      odds:
        odds.over15
    },

    {
      market: "over25",

      label:
        "Over 2.5 goals",

      probability:
        prediction.over25,

      odds:
        odds.over25
    },

    {
      market: "over35",

      label:
        "Over 3.5 goals",

      probability:
        prediction.over35,

      odds:
        odds.over35
    },

    {
      market: "bttsYes",

      label:
        "Both teams to score — Yes",

      probability:
        prediction.bttsYes,

      odds:
        odds.bttsYes
    }
  ];

  for (
    const definition of
    definitions
  ) {
    const candidate =
      createCandidate({
        ...definition,

        prediction,
        h2h,
        lineups,
        form,

        movement
      });

    if (candidate) {
      candidates.push(
        candidate
      );
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  return candidates;
}

/* =========================================================
   BUNDLE
========================================================= */

async function getBundle(id) {
  const [
    eventRaw,
    predictionRaw,
    oddsRaw,
    h2hRaw,
    statsRaw,
    formRaw,
    lineupsRaw,
    incidentsRaw,
    refereeRaw
  ] =
    await Promise.all([
      getEventDetail(id),

      getResource(
        id,
        "prediction"
      ),

      getResource(
        id,
        "odds"
      ),

      getResource(
        id,
        "head_to_head"
      ),

      getResource(
        id,
        "stats"
      ),

      getResource(
        id,
        "form"
      ),

      getResource(
        id,
        "lineups"
      ),

      getResource(
        id,
        "incidents"
      ),

      getResource(
        id,
        "referee"
      )
    ]);

  return {
    eventRaw,
    predictionRaw,
    oddsRaw,
    h2hRaw,
    statsRaw,
    formRaw,
    lineupsRaw,
    incidentsRaw,
    refereeRaw
  };
}

/* =========================================================
   EVENT FROM DETAIL
========================================================= */

function eventFromDetail(
  data,
  fallbackId
) {
  if (
    !data ||
    data.__error
  ) {
    return {
      id: fallbackId,

      home: "Unknown",
      away: "Unknown",

      date: null,

      status:
        "unknown",

      league: "",

      leagueId: null,
      seasonId: null,

      predictionAvailable:
        false
    };
  }

  const possible =
    data.event ||
    data.data?.event ||
    data.data ||
    data;

  const normalized =
    normalizeEvent(
      possible
    );

  if (normalized) {
    return normalized;
  }

  return {
    id: fallbackId,

    home: "Unknown",
    away: "Unknown",

    date: null,

    status:
      "unknown",

    league: "",

    leagueId: null,
    seasonId: null,

    predictionAvailable:
      false
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyzeEvent(id) {
  const bundle =
    await getBundle(id);

  const event =
    eventFromDetail(
      bundle.eventRaw,
      id
    );

  const prediction =
    parsePrediction(
      bundle.predictionRaw
    );

  const odds =
    parseOdds(
      bundle.oddsRaw
    );

  /*
    IMPORTANT:
    BSD currently returns H2H directly inside
    event.head_to_head for this event.
    We use that as fallback when the dedicated
    endpoint returns 404.
  */

  const h2h =
    parseH2HWithFallback(
      bundle.h2hRaw,
      bundle.eventRaw
    );

  const form =
    parseForm(
      bundle.formRaw
    );

  const stats =
    parseStats(
      bundle.statsRaw
    );

  const lineups =
    parseLineups(
      bundle.lineupsRaw
    );

  const referee =
    parseReferee(
      bundle.refereeRaw
    );

  const candidates =
    buildCandidates(
      prediction,
      odds,
      h2h,
      form,
      lineups
    );

  const qualified =
    candidates.filter(
      candidate =>
        candidate.accepted
    );

  const rejected =
    candidates.filter(
      candidate =>
        !candidate.accepted
    );

  const exchange =
    exchangeStatus();

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    event,

    eventId:
      String(id),

    prediction,

    odds,

    h2h,

    form,

    stats,

    lineups,

    referee,

    exchange,

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
        !bundle
          .incidentsRaw
          ?.__error,

      referee:
        referee.available,

      refereeStats:
        referee.statsAvailable,

      bookmakerMovement:
        false,

      exchangeMovement:
        false
    }
  };
}

/* =========================================================
   TOP PICKS
========================================================= */

async function getTopPicks(
  date
) {
  const eventsResponse =
    await getEvents(date);

  if (
    !eventsResponse.ok
  ) {
    return {
      ok: false,

      version:
        VERSION,

      source:
        SOURCE,

      requestedDate:
        date || todayUTC(),

      count: 0,

      picks: [],

      error:
        eventsResponse.error
    };
  }

  const analyses = [];

  for (
    const event of
    eventsResponse.events
  ) {
    try {
      const analysis =
        await analyzeEvent(
          event.id
        );

      analyses.push(
        analysis
      );
    } catch (error) {
      analyses.push({
        ok: false,

        event,

        eventId:
          String(event.id),

        error:
          error.message
      });
    }
  }

  const picks = [];

  for (
    const analysis of
    analyses
  ) {
    if (!analysis.ok) {
      continue;
    }

    for (
      const candidate of
      analysis.qualified
    ) {
      picks.push({
        eventId:
          analysis.eventId,

        home:
          analysis.event.home,

        away:
          analysis.event.away,

        date:
          analysis.event.date,

        market:
          candidate.market,

        label:
          candidate.label,

        probability:
          candidate.probability,

        odds:
          candidate.odds,

        valuePercent:
          candidate.valuePercent,

        score:
          candidate.score,

        reasons:
          candidate.reasons,

        movement:
          candidate.movement,

        exchange:
          analysis.exchange,

        coverage:
          analysis.coverage
      });
    }
  }

  picks.sort(
    (a, b) =>
      b.score - a.score
  );

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    requestedDate:
      date || todayUTC(),

    eventsChecked:
      eventsResponse.count,

    count:
      picks.length,

    picks:
      picks.slice(0, 10)
  };
}

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      status:
        "online",

      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      status:
        "online",

      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   EVENTS
========================================================= */

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const result =
        await getEvents(
          date
        );

      res.json(result);
    } catch (error) {
      res.status(500).json({
        ok: false,

        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ANALYZE
========================================================= */

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        req.params.id;

      if (!id) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Event ID is required."
          });
      }

      const result =
        await analyzeEvent(
          id
        );

      res.json(result);
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,

        version:
          VERSION,

        source:
          SOURCE,

        eventId:
          req.params.id,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TOP PICKS
========================================================= */

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const result =
        await getTopPicks(
          date
        );

      res.json(result);
    } catch (error) {
      console.error(
        "TOP PICKS ERROR:",
        error
      );

      res.status(500).json({
        ok: false,

        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   EXCHANGE STATUS
========================================================= */

app.get(
  "/api/exchange/status",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      source:
        SOURCE,

      exchange:
        exchangeStatus()
    });
  }
);

/* =========================================================
   COVERAGE
========================================================= */

app.get(
  "/api/coverage",
  async (req, res) => {
    try {
      const id =
        req.query.eventId ||
        req.query.id;

      if (!id) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "eventId is required."
          });
      }

      const result =
        await analyzeEvent(
          id
        );

      res.json({
        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        eventId:
          String(id),

        event:
          result.event,

        coverage:
          result.coverage
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      version:
        VERSION,

      source:
        SOURCE,

      error:
        "Endpoint not found.",

      path:
        req.originalUrl
    });
  }
);

/* =========================================================
   GLOBAL ERROR
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    res.status(500).json({
      ok: false,

      version:
        VERSION,

      source:
        SOURCE,

      error:
        error.message ||
        "Internal server error"
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
