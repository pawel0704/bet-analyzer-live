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

const VERSION = "6.3.1";
const SOURCE = "BSD";

const CONFIG = {
  maxEvents: 20,

  thresholds: {
    highProbabilityMin: 60,
    highProbabilityScoreMin: 58,
    highProbabilityValueMin: -3,

    valueProbabilityMin: 35,
    valueScoreMin: 55,
    valueMin: 5
  },

  timeoutMs: 12000,
  retries: 1
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function num(value) {
  return isNumber(value) ? value : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

function round(value, digits = 2) {
  if (!isNumber(value)) return null;

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function getDateOnly(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
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

  if (payload.data && Array.isArray(payload.data.results)) {
    return payload.data.results;
  }

  if (payload.data && Array.isArray(payload.data.events)) {
    return payload.data.events;
  }

  return [];
}

/* =========================================================
   BSD HTTP
========================================================= */

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    return {
      __error: true,
      status: 500,
      message: "BSD_API_KEY is not configured."
    };
  }

  const cleanPath = String(path).startsWith("/")
    ? String(path)
    : `/${path}`;

  const url = `${BSD_BASE}${cleanPath}`;

  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, CONFIG.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await response.text();

      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        return {
          __error: true,
          status: response.status,
          message: `BSD HTTP ${response.status} ${response.statusText || ""}`.trim(),
          data
        };
      }

      return data;
    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (attempt < CONFIG.retries) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
  }

  return {
    __error: true,
    status: 0,
    message: lastError?.name === "AbortError"
      ? "BSD request timeout"
      : lastError?.message || "BSD request failed"
  };
}

/* =========================================================
   EVENT PARSING
========================================================= */

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const event = raw.event && typeof raw.event === "object"
    ? raw.event
    : raw;

  const id = firstDefined(
    event.id,
    event.event_id,
    raw.id,
    raw.event_id
  );

  if (id === null) {
    return null;
  }

  const home = firstDefined(
    event.home_team,
    event.home,
    event.home_name,
    event.homeTeam?.name,
    event.teams?.home?.name
  );

  const away = firstDefined(
    event.away_team,
    event.away,
    event.away_name,
    event.awayTeam?.name,
    event.teams?.away?.name
  );

  const date = firstDefined(
    event.event_date,
    event.date,
    event.start_time,
    event.start_at
  );

  return {
    id: Number(id),
    home: home || `Home ${id}`,
    away: away || `Away ${id}`,
    date: normalizeDate(date),
    status: firstDefined(event.status, "unknown"),
    league: firstDefined(
      event.league_name,
      event.league,
      event.competition_name,
      ""
    ),
    leagueId: firstDefined(
      event.league_id,
      event.leagueId
    ),
    seasonId: firstDefined(
      event.season_id,
      event.seasonId
    ),
    raw: event
  };
}

async function getEvents(date) {
  const requestedDate = date || getDateOnly(new Date());

  const candidates = [
    `/events/?date=${encodeURIComponent(requestedDate)}`,
    `/events?date=${encodeURIComponent(requestedDate)}`,
    `/event/?date=${encodeURIComponent(requestedDate)}`,
    `/event?date=${encodeURIComponent(requestedDate)}`
  ];

  let source = null;

  for (const path of candidates) {
    const result = await bsdFetch(path);

    if (
      result &&
      !result.__error &&
      extractResults(result).length > 0
    ) {
      source = result;
      break;
    }
  }

  if (!source) {
    return [];
  }

  const events = extractResults(source)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(event => {
      const eventDate = getDateOnly(event.date);
      return !requestedDate || eventDate === requestedDate;
    });

  return events.slice(0, CONFIG.maxEvents);
}

async function getEventDetail(id) {
  const paths = [
    `/events/${id}/`,
    `/event/${id}/`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result && !result.__error) {
      return result;
    }
  }

  return {
    __error: true,
    resource: "event",
    message: `Unable to load event ${id}`
  };
}

async function getResource(id, resource) {
  const paths = [
    `/events/${id}/${resource}/`,
    `/event/${id}/${resource}/`,
    `/${resource}/${id}/`
  ];

  let lastError = null;

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result && !result.__error) {
      return result;
    }

    lastError = result;
  }

  return {
    __error: true,
    resource,
    message: lastError?.message || `Unable to load ${resource}`
  };
}

/* =========================================================
   PREDICTION
========================================================= */

function parsePrediction(source) {
  if (!source || source.__error) {
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
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const markets = root.markets || {};

  const matchResult = markets.match_result || {};
  const expectedGoals = markets.expected_goals || {};
  const overUnder = markets.over_under || {};
  const btts = markets.btts || {};
  const score = markets.score || {};
  const model = root.model || {};

  const home = num(matchResult.prob_home);
  const draw = num(matchResult.prob_draw);
  const away = num(matchResult.prob_away);

  const available =
    home !== null ||
    draw !== null ||
    away !== null ||
    isNumber(expectedGoals.home) ||
    isNumber(expectedGoals.away);

  return {
    available,

    home,
    draw,
    away,

    over15: num(overUnder.prob_over_15),
    over25: num(overUnder.prob_over_25),
    over35: num(overUnder.prob_over_35),

    bttsYes: num(btts.prob_yes),

    xgHome: num(expectedGoals.home),
    xgAway: num(expectedGoals.away),

    confidence: num(model.confidence),

    predicted: firstDefined(
      matchResult.predicted,
      root.recommendations?.favorite
    ),

    mostLikelyScore: firstDefined(
      score.most_likely,
      root.most_likely_score
    ),

    raw: source
  };
}

/* =========================================================
   ODDS
========================================================= */

function parseOdds(source) {
  if (!source || source.__error) {
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
      nextUpdateAt: null,
      updateIntervalSeconds: null,
      updateReason: null,
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  /*
    BSD returns:

    {
      event_id: ...,
      odds: {
        home_win: 2.72,
        ...
      },
      last_update_at: "...",
      last_change_at: "...",
      next_update_at: "...",
      update_interval_seconds: 1800,
      update_reason: "..."
    }

    Important:
    metadata is on ROOT, not inside root.odds.
  */

  const odds =
    root.odds && typeof root.odds === "object"
      ? root.odds
      : root;

  const home = num(
    firstDefined(
      odds.home_win,
      odds.home,
      odds.home_odds
    )
  );

  const draw = num(
    firstDefined(
      odds.draw,
      odds.draw_odds
    )
  );

  const away = num(
    firstDefined(
      odds.away_win,
      odds.away,
      odds.away_odds
    )
  );

  const over15 = num(
    firstDefined(
      odds.over_15_goals,
      odds.over15
    )
  );

  const under15 = num(
    firstDefined(
      odds.under_15_goals,
      odds.under15
    )
  );

  const over25 = num(
    firstDefined(
      odds.over_25_goals,
      odds.over25
    )
  );

  const under25 = num(
    firstDefined(
      odds.under_25_goals,
      odds.under25
    )
  );

  const over35 = num(
    firstDefined(
      odds.over_35_goals,
      odds.over35
    )
  );

  const under35 = num(
    firstDefined(
      odds.under_35_goals,
      odds.under35
    )
  );

  const bttsYes = num(
    firstDefined(
      odds.btts_yes,
      odds.bttsYes
    )
  );

  const bttsNo = num(
    firstDefined(
      odds.btts_no,
      odds.bttsNo
    )
  );

  const available = [
    home,
    draw,
    away,
    over15,
    under15,
    over25,
    under25,
    over35,
    under35,
    bttsYes,
    bttsNo
  ].some(isNumber);

  return {
    available,

    home,
    draw,
    away,

    over15,
    under15,

    over25,
    under25,

    over35,
    under35,

    bttsYes,
    bttsNo,

    previous: null,

    // FIX 6.3.1:
    // read timestamps from the BSD wrapper.
    updatedAt: firstDefined(
      root.last_update_at,
      root.updated_at,
      odds.last_update_at,
      odds.updated_at
    ),

    lastChangeAt: firstDefined(
      root.last_change_at,
      odds.last_change_at
    ),

    nextUpdateAt: firstDefined(
      root.next_update_at,
      odds.next_update_at
    ),

    updateIntervalSeconds: num(
      firstDefined(
        root.update_interval_seconds,
        odds.update_interval_seconds
      )
    ),

    updateReason: firstDefined(
      root.update_reason,
      odds.update_reason
    ),

    raw: source
  };
}

/* =========================================================
   H2H
========================================================= */

function parseH2H(source) {
  if (!source || source.__error) {
    return {
      sampleSize: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      homeGoals: 0,
      awayGoals: 0,
      averageGoals: null,
      matches: [],
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const h2h =
    root.head_to_head &&
    typeof root.head_to_head === "object"
      ? root.head_to_head
      : root;

  const recentMatches = safeArray(
    firstDefined(
      h2h.recent_matches,
      h2h.matches
    )
  );

  const matches = recentMatches.map(match => ({
    home: firstDefined(match.home, ""),
    away: firstDefined(match.away, ""),
    date: firstDefined(match.date, null),
    score: firstDefined(match.score, null),
    event_id: firstDefined(
      match.event_id,
      match.id,
      null
    ),
    home_score: num(match.home_score),
    away_score: num(match.away_score)
  }));

  const sampleSize = num(
    firstDefined(
      h2h.total_matches,
      matches.length
    )
  ) ?? matches.length;

  const homeWins = num(h2h.home_wins) ?? 0;
  const draws = num(h2h.draws) ?? 0;
  const awayWins = num(h2h.away_wins) ?? 0;

  const homeGoals = num(h2h.home_goals) ?? 0;
  const awayGoals = num(h2h.away_goals) ?? 0;

  const averageGoals = num(
    firstDefined(
      h2h.avg_total_goals,
      sampleSize > 0
        ? (homeGoals + awayGoals) / sampleSize
        : null
    )
  );

  return {
    sampleSize,
    homeWins,
    draws,
    awayWins,
    homeGoals,
    awayGoals,
    averageGoals,
    matches,
    raw: source
  };
}

/* =========================================================
   FORM
========================================================= */

function parseForm(source) {
  if (!source || source.__error) {
    return {
      available: false,
      home: [],
      away: [],
      score: 0,
      details: null,
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const home = safeArray(
    firstDefined(
      root.home,
      root.home_form,
      root.form?.home
    )
  );

  const away = safeArray(
    firstDefined(
      root.away,
      root.away_form,
      root.form?.away
    )
  );

  const available =
    home.length > 0 ||
    away.length > 0;

  return {
    available,
    home,
    away,
    score: available ? 2 : 0,
    details: available
      ? {
          homeMatches: home.length,
          awayMatches: away.length
        }
      : null,
    raw: source
  };
}

/* =========================================================
   STATS
========================================================= */

function parseStats(source) {
  if (!source || source.__error) {
    return {
      available: false,
      score: 0,
      details: [],
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const stats = root.stats || {};

  const home = stats.home || {};
  const away = stats.away || {};

  const numericValues = [
    home.xg?.actual,
    home.xg?.estimated,
    home.ball_possession,
    home.total_shots,
    home.shots_on_target,
    home.corner_kicks,
    home.fouls,
    home.yellow_cards,
    home.red_cards,
    home.offsides,

    away.xg?.actual,
    away.xg?.estimated,
    away.ball_possession,
    away.total_shots,
    away.shots_on_target,
    away.corner_kicks,
    away.fouls,
    away.yellow_cards,
    away.red_cards,
    away.offsides
  ];

  const available = numericValues.some(isNumber);

  return {
    available,
    score: available ? 2 : 0,
    details: available
      ? {
          home,
          away
        }
      : [],
    raw: source
  };
}

/* =========================================================
   LINEUPS
========================================================= */

function parseLineups(source) {
  if (!source || source.__error) {
    return {
      available: false,
      score: 0,
      details: null,
      raw: source
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const lineups = root.lineups || {};

  const home = lineups.home || {};
  const away = lineups.away || {};

  const homePlayers = safeArray(home.players);
  const awayPlayers = safeArray(away.players);

  const completeHome = homePlayers.length >= 11;
  const completeAway = awayPlayers.length >= 11;

  const available =
    completeHome &&
    completeAway;

  return {
    available,
    score: available ? 2 : 1,

    details: {
      homePlayers: homePlayers.length,
      awayPlayers: awayPlayers.length,

      completeHome,
      completeAway,

      homeFormation: home.formation || null,
      awayFormation: away.formation || null
    },

    raw: source
  };
}

/* =========================================================
   REFEREE
========================================================= */

function parseReferee(eventRaw, refereeSource) {
  const refereeId = firstDefined(
    eventRaw?.referee_id,
    eventRaw?.referee?.id
  );

  if (
    refereeSource &&
    !refereeSource.__error
  ) {
    const root =
      refereeSource.data &&
      typeof refereeSource.data === "object"
        ? refereeSource.data
        : refereeSource;

    const referee =
      root.referee &&
      typeof root.referee === "object"
        ? root.referee
        : root;

    const name = firstDefined(
      referee.name,
      referee.full_name
    );

    if (name || referee.id) {
      return {
        available: true,
        id: firstDefined(referee.id, refereeId),
        name: name || null,
        statsAvailable: false,
        score: 1,
        note: "Referee identity available; referee statistics are not verified.",
        raw: refereeSource
      };
    }
  }

  return {
    available: false,
    id: refereeId,
    name: null,
    statsAvailable: false,
    score: 0,
    note: "Referee data unavailable.",
    raw: refereeSource
  };
}

/* =========================================================
   BOOKMAKER MOVEMENT
========================================================= */

function parseBookmakerMovement(odds) {
  /*
    IMPORTANT:
    A last_change_at timestamp alone does NOT tell us
    whether the price went up or down.

    We therefore expose the timestamp but do not fabricate
    direction or percentage without a verified previous price.
  */

  if (
    !odds ||
    !odds.available
  ) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null,
      lastChangeAt: null,
      note: "Current bookmaker odds are unavailable."
    };
  }

  if (
    odds.previous &&
    typeof odds.previous === "object"
  ) {
    return {
      available: true,
      direction: "UNKNOWN",
      percent: null,
      lastChangeAt: odds.lastChangeAt || null,
      note: "Previous odds object exists but no verified movement calculation is implemented."
    };
  }

  return {
    available: false,
    direction: "UNKNOWN",
    percent: null,
    lastChangeAt: odds.lastChangeAt || null,
    note: odds.lastChangeAt
      ? "A bookmaker odds change timestamp is available, but previous numerical odds are not verified."
      : "Current odds are available, but previous numerical odds are not verified."
  };
}

/* =========================================================
   EXCHANGE
========================================================= */

function exchangeStatus() {
  return {
    connected: false,
    status: "EXCHANGE_UNAVAILABLE",
    reason:
      "No verified betting-exchange feed is connected. No exchange signal is fabricated."
  };
}

/* =========================================================
   CANDIDATES
========================================================= */

function calculateValue(probability, odds) {
  if (
    !isNumber(probability) ||
    !isNumber(odds) ||
    odds <= 0
  ) {
    return null;
  }

  const impliedProbability = 100 / odds;

  return {
    impliedProbability,
    valuePercent: probability - impliedProbability
  };
}

function createCandidate({
  market,
  label,
  probability,
  odds,
  prediction,
  h2h,
  stats,
  lineups,
  form,
  bookmakerMovement
}) {
  if (
    !isNumber(probability) ||
    !isNumber(odds) ||
    odds <= 1
  ) {
    return null;
  }

  const value = calculateValue(
    probability,
    odds
  );

  const valuePercent = value?.valuePercent ?? null;
  const impliedProbability =
    value?.impliedProbability ?? null;

  let score = probability * 0.7;

  if (valuePercent !== null) {
    score += clamp(valuePercent, -10, 10) * 2;
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

  if (lineups?.available) {
    score += 2;
  }

  if (form?.available) {
    score += 2;
  }

  score = clamp(score, 0, 100);

  const reasons = [];

  if (
    probability >=
    CONFIG.thresholds.highProbabilityMin
  ) {
    reasons.push("High model probability");
  }

  if (
    prediction?.xgHome !== null &&
    prediction?.xgAway !== null
  ) {
    reasons.push("Expected-goals data available");
  }

  if (
    h2h?.sampleSize >= 3
  ) {
    reasons.push("H2H data available");
  }

  if (stats?.available) {
    reasons.push("Match statistics available");
  }

  if (lineups?.available) {
    reasons.push("Confirmed lineup data available");
  }

  if (form?.available) {
    reasons.push("Recent form data available");
  }

  const rejectionReasons = [];

  if (
    probability <
    CONFIG.thresholds.valueProbabilityMin
  ) {
    rejectionReasons.push(
      "PROBABILITY_LT_MIN"
    );
  }

  if (
    valuePercent === null ||
    valuePercent <
    CONFIG.thresholds.valueMin
  ) {
    rejectionReasons.push(
      "VALUE_LT_MIN"
    );
  }

  if (
    score <
    CONFIG.thresholds.valueScoreMin
  ) {
    rejectionReasons.push(
      "SCORE_LT_MIN"
    );
  }

  const accepted =
    (
      probability >=
      CONFIG.thresholds.highProbabilityMin &&
      score >=
      CONFIG.thresholds.highProbabilityScoreMin &&
      (
        valuePercent === null ||
        valuePercent >=
        CONFIG.thresholds.highProbabilityValueMin
      )
    ) ||
    (
      probability >=
      CONFIG.thresholds.valueProbabilityMin &&
      score >=
      CONFIG.thresholds.valueScoreMin &&
      valuePercent !== null &&
      valuePercent >=
      CONFIG.thresholds.valueMin
    );

  return {
    market,
    label,
    probability: round(probability),
    odds: round(odds),
    impliedProbability:
      round(impliedProbability, 6),
    valuePercent:
      round(valuePercent, 6),
    score: round(score),

    accepted,

    rejectionReasons:
      accepted
        ? []
        : rejectionReasons,

    movement: bookmakerMovement,

    reasons
  };
}

function buildCandidates({
  prediction,
  odds,
  h2h,
  stats,
  lineups,
  form
}) {
  if (
    !prediction?.available ||
    !odds?.available
  ) {
    return [];
  }

  const bookmakerMovement =
    parseBookmakerMovement(odds);

  const definitions = [
    {
      market: "over15",
      label: "Over 1.5 goals",
      probability: prediction.over15,
      odds: odds.over15
    },
    {
      market: "bttsYes",
      label: "Both teams to score — Yes",
      probability: prediction.bttsYes,
      odds: odds.bttsYes
    },
    {
      market: "over25",
      label: "Over 2.5 goals",
      probability: prediction.over25,
      odds: odds.over25
    },
    {
      market: "over35",
      label: "Over 3.5 goals",
      probability: prediction.over35,
      odds: odds.over35
    },
    {
      market: "away",
      label: "Away win",
      probability: prediction.away,
      odds: odds.away
    },
    {
      market: "home",
      label: "Home win",
      probability: prediction.home,
      odds: odds.home
    },
    {
      market: "draw",
      label: "Draw",
      probability: prediction.draw,
      odds: odds.draw
    }
  ];

  return definitions
    .map(definition =>
      createCandidate({
        ...definition,
        prediction,
        h2h,
        stats,
        lineups,
        form,
        bookmakerMovement
      })
    )
    .filter(Boolean)
    .sort((a, b) =>
      b.score - a.score
    );
}

/* =========================================================
   BUNDLE
========================================================= */

async function getBundle(id) {
  const eventRaw =
    await getEventDetail(id);

  if (
    !eventRaw ||
    eventRaw.__error
  ) {
    return {
      eventRaw,
      predictionRaw: null,
      oddsRaw: null,
      h2hRaw: null,
      formRaw: null,
      statsRaw: null,
      lineupsRaw: null,
      refereeRaw: null
    };
  }

  const [
    predictionRaw,
    oddsRaw,
    h2hEndpointRaw,
    formRaw,
    statsRaw,
    lineupsRaw,
    refereeRaw
  ] = await Promise.all([
    getResource(id, "prediction"),
    getResource(id, "odds"),
    getResource(id, "head_to_head"),
    getResource(id, "form"),
    getResource(id, "stats"),
    getResource(id, "lineups"),
    getResource(id, "referee")
  ]);

  /*
    BSD currently embeds H2H directly inside the event.
    The dedicated /head_to_head endpoint returns 404.

    Use embedded data when endpoint is unavailable.
  */

  let h2hRaw = h2hEndpointRaw;

  if (
    (!h2hRaw || h2hRaw.__error) &&
    eventRaw.head_to_head
  ) {
    h2hRaw = {
      head_to_head: eventRaw.head_to_head
    };
  }

  if (
    (!h2hRaw || h2hRaw.__error) &&
    eventRaw.data?.head_to_head
  ) {
    h2hRaw = {
      head_to_head: eventRaw.data.head_to_head
    };
  }

  return {
    eventRaw,
    predictionRaw,
    oddsRaw,
    h2hRaw,
    formRaw,
    statsRaw,
    lineupsRaw,
    refereeRaw
  };
}

/* =========================================================
   EVENT NORMALIZATION FROM DETAIL
========================================================= */

function eventFromDetail(eventRaw) {
  const event =
    normalizeEvent(eventRaw);

  if (!event) {
    return null;
  }

  return {
    ...event,
    predictionAvailable: false
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyzeEvent(id) {
  const bundle =
    await getBundle(id);

  const eventRaw =
    bundle.eventRaw;

  if (
    !eventRaw ||
    eventRaw.__error
  ) {
    return {
      ok: false,
      version: VERSION,
      source: SOURCE,
      error:
        eventRaw?.message ||
        "Event not found."
    };
  }

  const event =
    eventFromDetail(eventRaw);

  const prediction =
    parsePrediction(
      bundle.predictionRaw
    );

  const odds =
    parseOdds(
      bundle.oddsRaw
    );

  const h2h =
    parseH2H(
      bundle.h2hRaw
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
      eventRaw,
      bundle.refereeRaw
    );

  const exchange =
    exchangeStatus();

  const bookmakerMovement =
    parseBookmakerMovement(
      odds
    );

  const candidates =
    buildCandidates({
      prediction,
      odds,
      h2h,
      stats,
      lineups,
      form
    });

  const qualified =
    candidates.filter(
      candidate => candidate.accepted
    );

  const rejected =
    candidates.filter(
      candidate => !candidate.accepted
    );

  if (event) {
    event.predictionAvailable =
      prediction.available;
  }

  return {
    ok: true,
    version: VERSION,
    source: SOURCE,

    event,

    eventId: String(id),

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
      prediction: prediction.available,
      odds: odds.available,
      h2h: h2h.sampleSize > 0,
      stats: stats.available,
      form: form.available,
      lineups: lineups.available,
      incidents: Boolean(
        eventRaw.incidents ||
        eventRaw.highlights ||
        eventRaw.live_websocket
      ),
      referee: referee.available,
      refereeStats: referee.statsAvailable,
      bookmakerMovement:
        bookmakerMovement.available,
      exchangeMovement:
        exchange.connected
    }
  };
}

/* =========================================================
   TOP PICKS
========================================================= */

async function getTopPicks(date) {
  const events =
    await getEvents(date);

  const analyses = [];

  for (const event of events) {
    try {
      const analysis =
        await analyzeEvent(
          event.id
        );

      if (
        analysis &&
        analysis.ok
      ) {
        analyses.push(analysis);
      }
    } catch (error) {
      console.error(
        `Analysis failed for ${event.id}:`,
        error.message
      );
    }
  }

  const picks = analyses
    .flatMap(analysis =>
      analysis.qualified.map(pick => ({
        eventId: analysis.event.id,
        home: analysis.event.home,
        away: analysis.event.away,
        date: analysis.event.date,
        league: analysis.event.league,
        pick
      }))
    )
    .sort(
      (a, b) =>
        b.pick.score -
        a.pick.score
    );

  return {
    ok: true,
    version: VERSION,
    source: SOURCE,
    requestedDate:
      date || getDateOnly(new Date()),
    eventsAnalyzed:
      analyses.length,
    qualifiedCount:
      picks.length,
    picks: picks.slice(0, 10)
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
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    status: "healthy",
    timestamp:
      new Date().toISOString()
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getDateOnly(new Date());

    const events =
      await getEvents(date);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      requestedDate: date,
      count: events.length,
      events
    });
  } catch (error) {
    console.error(
      "/api/events error:",
      error
    );

    res.status(500).json({
      ok: false,
      version: VERSION,
      error:
        error.message ||
        "Events request failed."
    });
  }
});

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isInteger(id)) {
        return res.status(400).json({
          ok: false,
          version: VERSION,
          error: "Invalid event ID."
        });
      }

      const result =
        await analyzeEvent(id);

      if (!result.ok) {
        return res.status(404).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error(
        "/api/analyze error:",
        error
      );

      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message ||
          "Analysis failed."
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        getDateOnly(new Date());

      const result =
        await getTopPicks(date);

      res.json(result);
    } catch (error) {
      console.error(
        "/api/top-picks error:",
        error
      );

      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message ||
          "Top picks request failed."
      });
    }
  }
);

app.get(
  "/api/exchange/status",
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      exchange:
        exchangeStatus()
    });
  }
);

app.get(
  "/api/coverage",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        getDateOnly(new Date());

      const events =
        await getEvents(date);

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        requestedDate: date,

        count: events.length,

        coverage: {
          events: true,
          prediction: true,
          odds: true,
          h2h: true,
          stats: true,
          form: true,
          lineups: true,
          referee: true,
          bookmakerMovement: false,
          exchangeMovement: false
        },

        notes: {
          stats:
            "BSD may return null statistics before kickoff.",
          form:
            "BSD form endpoint may return 404 for some events.",
          referee:
            "Referee data depends on referee_id being present.",
          bookmakerMovement:
            "Current odds and timestamps are available, but verified previous numerical odds are required for movement direction.",
          exchangeMovement:
            "No verified betting-exchange feed is connected."
        }
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message ||
          "Coverage request failed."
      });
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "Route not found.",
    path: req.path
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
    error:
      error?.message ||
      "Internal server error."
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
