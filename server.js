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

const VERSION = "6.4.1";
const SOURCE = "BSD";

const CONFIG = {
  maxEvents: 50,
  topPicksLimit: 10,

  // HIGH PROBABILITY
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -5,

  // VALUE
  valueProbabilityMin: 35,
  valueScoreMin: 55,
  valueMin: 5,

  requestTimeoutMs: 12000,
  retries: 1,
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isUpcomingEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "notstarted",
    "not_started",
    "scheduled",
    "upcoming",
    "pending",
  ].includes(status);
}

function isLiveEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "live",
    "inplay",
    "in_play",
    "1st_half",
    "2nd_half",
    "halftime",
    "extra_time",
    "penalties",
  ].includes(status);
}

function isFinishedEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "finished",
    "ft",
    "ended",
    "completed",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "suspended",
  ].includes(status);
}

function normalizeDateInput(value) {
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);

  if (match) {
    return match[1];
  }

  return new Date(value).toISOString().slice(0, 10);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
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
    }, CONFIG.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json",
          ...(options.headers || {}),
        },
        signal: controller.signal,
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
        const error = new Error(
          `BSD HTTP ${response.status}`
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
        await sleep(250 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error("BSD request failed");
}

function extractResults(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (data.data && Array.isArray(data.data.results)) {
    return data.data.results;
  }

  if (Array.isArray(data.events)) {
    return data.events;
  }

  if (data.data && Array.isArray(data.data.events)) {
    return data.data.events;
  }

  return [];
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const home = firstDefined(
    raw.home_team,
    raw.homeTeam,
    raw.home,
    raw.home_name
  );

  const away = firstDefined(
    raw.away_team,
    raw.awayTeam,
    raw.away,
    raw.away_name
  );

  const date = firstDefined(
    raw.event_date,
    raw.date,
    raw.start_time,
    raw.startTime
  );

  const league =
    firstDefined(
      raw.league_name,
      raw.league,
      raw.competition_name,
      raw.tournament_name
    ) || "";

  return {
    id: num(raw.id ?? raw.event_id),
    home,
    away,
    date,
    status: firstDefined(raw.status, "unknown"),
    league,
    leagueId: num(firstDefined(raw.league_id, raw.leagueId)),
    seasonId: num(firstDefined(raw.season_id, raw.seasonId)),
    refereeId: num(firstDefined(raw.referee_id, raw.refereeId)),
    homeTeamId: num(
      firstDefined(raw.home_team_id, raw.homeTeamId)
    ),
    awayTeamId: num(
      firstDefined(raw.away_team_id, raw.awayTeamId)
    ),
    raw,
  };
}

async function getEvents(date) {
  const targetDate = normalizeDateInput(date);

  const paths = [
    `/events/?date=${encodeURIComponent(targetDate)}`,
    `/events?date=${encodeURIComponent(targetDate)}`,
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const data = await bsdFetch(path);

      const results = extractResults(data);

      const events = results
        .map(normalizeEvent)
        .filter((event) => event && event.id !== null);

      if (events.length > 0) {
        return events;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function getEventDetail(id) {
  const paths = [
    `/events/${id}/`,
    `/event/${id}/`,
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      return await bsdFetch(path);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Event detail unavailable");
}

async function getResource(id, resource) {
  const paths = [
    `/events/${id}/${resource}/`,
    `/event/${id}/${resource}/`,
    `/${resource}/${id}/`,
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      return await bsdFetch(path);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    __error: true,
    resource,
    message: lastError?.message || "Resource unavailable",
  };
}

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
      raw: source,
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const markets =
    root.markets && typeof root.markets === "object"
      ? root.markets
      : {};

  const matchResult = markets.match_result || {};
  const expectedGoals = markets.expected_goals || {};
  const overUnder = markets.over_under || {};
  const btts = markets.btts || {};
  const score = markets.score || {};
  const model = root.model || {};

  const result = {
    available: true,

    home: num(
      firstDefined(
        matchResult.prob_home,
        root.prob_home
      )
    ),

    draw: num(
      firstDefined(
        matchResult.prob_draw,
        root.prob_draw
      )
    ),

    away: num(
      firstDefined(
        matchResult.prob_away,
        root.prob_away
      )
    ),

    over15: num(
      firstDefined(
        overUnder.prob_over_15,
        root.prob_over_15
      )
    ),

    over25: num(
      firstDefined(
        overUnder.prob_over_25,
        root.prob_over_25
      )
    ),

    over35: num(
      firstDefined(
        overUnder.prob_over_35,
        root.prob_over_35
      )
    ),

    bttsYes: num(
      firstDefined(
        btts.prob_yes,
        root.prob_btts_yes
      )
    ),

    xgHome: num(
      firstDefined(
        expectedGoals.home,
        root.xg_home
      )
    ),

    xgAway: num(
      firstDefined(
        expectedGoals.away,
        root.xg_away
      )
    ),

    confidence: num(
      firstDefined(
        model.confidence,
        root.confidence
      )
    ),

    predicted: firstDefined(
      matchResult.predicted,
      root.predicted
    ),

    mostLikelyScore: firstDefined(
      score.most_likely,
      root.most_likely_score
    ),

    raw: source,
  };

  result.available =
    [
      result.home,
      result.draw,
      result.away,
      result.over15,
      result.over25,
      result.over35,
      result.bttsYes,
      result.xgHome,
      result.xgAway,
    ].some((value) => value !== null);

  return result;
}

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
      raw: source,
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const odds =
    root.odds && typeof root.odds === "object"
      ? root.odds
      : root;

  return {
    available: true,

    home: num(
      firstDefined(
        odds.home_win,
        odds.home
      )
    ),

    draw: num(
      firstDefined(
        odds.draw
      )
    ),

    away: num(
      firstDefined(
        odds.away_win,
        odds.away
      )
    ),

    over15: num(
      firstDefined(
        odds.over_15_goals,
        odds.over15
      )
    ),

    under15: num(
      firstDefined(
        odds.under_15_goals,
        odds.under15
      )
    ),

    over25: num(
      firstDefined(
        odds.over_25_goals,
        odds.over25
      )
    ),

    under25: num(
      firstDefined(
        odds.under_25_goals,
        odds.under25
      )
    ),

    over35: num(
      firstDefined(
        odds.over_35_goals,
        odds.over35
      )
    ),

    under35: num(
      firstDefined(
        odds.under_35_goals,
        odds.under35
      )
    ),

    bttsYes: num(
      firstDefined(
        odds.btts_yes,
        odds.bttsYes
      )
    ),

    bttsNo: num(
      firstDefined(
        odds.btts_no,
        odds.bttsNo
      )
    ),

    previous:
      root.previous &&
      typeof root.previous === "object"
        ? root.previous
        : null,

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

    raw: source,
  };
}

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
      raw: source,
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

  const matches = safeArray(
    firstDefined(
      h2h.recent_matches,
      h2h.matches
    )
  );

  return {
    sampleSize:
      num(
        firstDefined(
          h2h.total_matches,
          matches.length
        )
      ) || 0,

    homeWins:
      num(h2h.home_wins) || 0,

    draws:
      num(h2h.draws) || 0,

    awayWins:
      num(h2h.away_wins) || 0,

    homeGoals:
      num(h2h.home_goals) || 0,

    awayGoals:
      num(h2h.away_goals) || 0,

    averageGoals: num(
      firstDefined(
        h2h.avg_total_goals,
        h2h.average_goals
      )
    ),

    matches: matches.map((match) => ({
      home: firstDefined(
        match.home,
        match.home_team
      ),
      away: firstDefined(
        match.away,
        match.away_team
      ),
      date: match.date,
      score: match.score,
      event_id: num(
        firstDefined(
          match.event_id,
          match.id
        )
      ),
      home_score: num(match.home_score),
      away_score: num(match.away_score),
    })),

    raw: source,
  };
}

function parseH2HWithFallback(h2hData, eventRaw) {
  const parsed = parseH2H(h2hData);

  if (parsed.sampleSize > 0) {
    return parsed;
  }

  if (
    eventRaw?.head_to_head &&
    typeof eventRaw.head_to_head === "object"
  ) {
    return parseH2H({
      head_to_head: eventRaw.head_to_head,
    });
  }

  if (
    eventRaw?.data?.head_to_head &&
    typeof eventRaw.data.head_to_head === "object"
  ) {
    return parseH2H({
      head_to_head: eventRaw.data.head_to_head,
    });
  }

  return parsed;
}

function parseForm(source) {
  if (!source || source.__error) {
    return {
      available: false,
      home: [],
      away: [],
      score: 0,
      details: null,
      raw: source,
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
      root.home_team
    )
  );

  const away = safeArray(
    firstDefined(
      root.away,
      root.away_form,
      root.away_team
    )
  );

  return {
    available:
      home.length > 0 ||
      away.length > 0,

    home,
    away,

    score:
      home.length + away.length > 0
        ? 1
        : 0,

    details: {
      homeMatches: home.length,
      awayMatches: away.length,
    },

    raw: source,
  };
}

function parseStats(source) {
  if (!source || source.__error) {
    return {
      available: false,
      score: 0,
      details: [],
      raw: source,
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const stats =
    root.stats &&
    typeof root.stats === "object"
      ? root.stats
      : {};

  const home =
    stats.home &&
    typeof stats.home === "object"
      ? stats.home
      : {};

  const away =
    stats.away &&
    typeof stats.away === "object"
      ? stats.away
      : {};

  const values = [
    home.ball_possession,
    home.total_shots,
    home.shots_on_target,
    home.corner_kicks,
    home.fouls,

    away.ball_possession,
    away.total_shots,
    away.shots_on_target,
    away.corner_kicks,
    away.fouls,

    home.xg?.actual,
    home.xg?.estimated,
    away.xg?.actual,
    away.xg?.estimated,
  ];

  const available = values.some(
    (value) => num(value) !== null
  );

  return {
    available,
    score: available ? 1 : 0,

    details: available
      ? {
          home,
          away,
        }
      : [],

    raw: source,
  };
}

function parseLineups(source) {
  if (!source || source.__error) {
    return {
      available: false,
      score: 0,
      details: null,
      raw: source,
    };
  }

  const root =
    source.data && typeof source.data === "object"
      ? source.data
      : source;

  const lineups =
    root.lineups &&
    typeof root.lineups === "object"
      ? root.lineups
      : {};

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

  const homePlayers =
    safeArray(home.players);

  const awayPlayers =
    safeArray(away.players);

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
        firstDefined(
          home.formation
        ),

      awayFormation:
        firstDefined(
          away.formation
        ),
    },

    raw: source,
  };
}

function parseReferee(source) {
  if (!source || source.__error) {
    return {
      available: false,
      id: null,
      name: null,
      statsAvailable: false,
      score: 0,
      note: "Referee data unavailable.",
      raw: source,
    };
  }

  const root =
    source.data &&
    typeof source.data === "object"
      ? source.data
      : source;

  const referee =
    root.referee &&
    typeof root.referee === "object"
      ? root.referee
      : root;

  const id = num(
    firstDefined(
      referee.id,
      referee.referee_id
    )
  );

  const name = firstDefined(
    referee.name,
    referee.referee_name
  );

  const statsAvailable =
    referee.stats &&
    typeof referee.stats === "object"
      ? Object.keys(
          referee.stats
        ).length > 0
      : false;

  return {
    available:
      id !== null ||
      !!name,

    id,
    name,
    statsAvailable,

    score:
      id !== null ||
      !!name
        ? 1
        : 0,

    note:
      id !== null ||
      !!name
        ? "Referee data available."
        : "Referee data unavailable.",

    raw: source,
  };
}

function parseBookmakerMovement(odds) {
  if (!odds?.available) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null,
      lastChangeAt: null,
      note:
        "Current bookmaker odds are unavailable.",
    };
  }

  const previous =
    odds.previous &&
    typeof odds.previous === "object"
      ? odds.previous
      : null;

  let currentValue = null;
  let previousValue = null;

  if (
    num(odds.away) !== null &&
    num(previous?.away) !== null
  ) {
    currentValue = odds.away;
    previousValue = previous.away;
  } else if (
    num(odds.home) !== null &&
    num(previous?.home) !== null
  ) {
    currentValue = odds.home;
    previousValue = previous.home;
  }

  if (
    currentValue !== null &&
    previousValue !== null &&
    previousValue > 0
  ) {
    const percent =
      ((currentValue - previousValue) /
        previousValue) *
      100;

    return {
      available: true,

      direction:
        percent < -0.1
          ? "SHORTENING"
          : percent > 0.1
          ? "DRIFTING"
          : "STABLE",

      percent,

      lastChangeAt:
        odds.lastChangeAt,

      note:
        "Movement calculated from verified previous and current numerical odds.",
    };
  }

  return {
    available: false,
    direction: "UNKNOWN",
    percent: null,

    lastChangeAt:
      odds.lastChangeAt || null,

    note:
      odds.lastChangeAt
        ? "A bookmaker odds change timestamp is available, but previous numerical odds are not verified."
        : "Previous bookmaker odds are not available.",
  };
}

function exchangeStatus() {
  return {
    connected: false,
    status: "EXCHANGE_UNAVAILABLE",

    reason:
      "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
  };
}

function impliedProbability(odds) {
  if (
    odds === null ||
    odds <= 0
  ) {
    return null;
  }

  return 100 / odds;
}

function calculateValue(
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

  return (
    probability -
    impliedProbability(odds)
  );
}

function createCandidate({
  market,
  label,
  probability,
  odds,
  prediction,
  h2h,
  lineups,
  form,
  bookmakerMovement,
}) {
  if (
    probability === null ||
    odds === null ||
    odds <= 0
  ) {
    return null;
  }

  const implied =
    impliedProbability(odds);

  const value =
    calculateValue(
      probability,
      odds
    );

  let score =
    probability * 0.7;

  if (value !== null) {
    score +=
      Math.max(
        -10,
        Math.min(10, value)
      ) * 2;
  }

  if (
    prediction?.xgHome !== null &&
    prediction?.xgAway !== null
  ) {
    score += 2;
  }

  if (h2h?.sampleSize >= 3) {
    score += 1;
  }

  if (lineups?.available) {
    score += 2;
  }

  if (form?.available) {
    score += 2;
  }

  score = Math.max(
    0,
    Math.min(100, score)
  );

  const isHighProbability =
    probability >=
      CONFIG.highProbabilityMin &&
    score >=
      CONFIG.highProbabilityScoreMin &&
    (
      value === null ||
      value >=
        CONFIG.highProbabilityValueMin
    );

  const isValue =
    probability >=
      CONFIG.valueProbabilityMin &&
    score >=
      CONFIG.valueScoreMin &&
    value !== null &&
    value >=
      CONFIG.valueMin;

  const accepted =
    isHighProbability ||
    isValue;

  const rejectionReasons = [];

  if (!accepted) {
    if (
      probability <
      CONFIG.valueProbabilityMin
    ) {
      rejectionReasons.push(
        "PROBABILITY_LT_MIN"
      );
    }

    if (
      !isHighProbability &&
      value !== null &&
      value <
        CONFIG.valueMin
    ) {
      rejectionReasons.push(
        "VALUE_LT_MIN"
      );
    }

    if (
      score <
        CONFIG.valueScoreMin &&
      !isHighProbability
    ) {
      rejectionReasons.push(
        "SCORE_LT_MIN"
      );
    }

    if (
      probability >=
        CONFIG.highProbabilityMin &&
      score <
        CONFIG.highProbabilityScoreMin
    ) {
      rejectionReasons.push(
        "HIGH_PROBABILITY_SCORE_LT_MIN"
      );
    }

    if (
      probability >=
        CONFIG.highProbabilityMin &&
      value !== null &&
      value <
        CONFIG.highProbabilityValueMin
    ) {
      rejectionReasons.push(
        "HIGH_PROBABILITY_VALUE_TOO_LOW"
      );
    }
  }

  let qualificationType =
    "NONE";

  if (isHighProbability) {
    qualificationType =
      "HIGH_PROBABILITY";
  } else if (isValue) {
    qualificationType =
      "VALUE";
  }

  const reasons = [];

  if (
    probability >=
    CONFIG.highProbabilityMin
  ) {
    reasons.push(
      "High model probability"
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
    bookmakerMovement?.available
  ) {
    reasons.push(
      `Verified bookmaker movement: ${bookmakerMovement.direction}`
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

  return {
    market,
    label,

    probability,

    odds,

    impliedProbability:
      implied,

    valuePercent:
      value,

    score:
      Number(
        score.toFixed(2)
      ),

    accepted,

    qualificationType,

    rejectionReasons:
      accepted
        ? []
        : rejectionReasons,

    movement:
      bookmakerMovement,

    reasons,
  };
}

function buildCandidates({
  prediction,
  odds,
  h2h,
  lineups,
  form,
  bookmakerMovement,
}) {
  const definitions = [
    {
      market: "over15",
      label: "Over 1.5 goals",
      probability:
        prediction.over15,
      odds:
        odds.over15,
    },

    {
      market: "bttsYes",
      label:
        "Both teams to score — Yes",
      probability:
        prediction.bttsYes,
      odds:
        odds.bttsYes,
    },

    {
      market: "over25",
      label: "Over 2.5 goals",
      probability:
        prediction.over25,
      odds:
        odds.over25,
    },

    {
      market: "over35",
      label: "Over 3.5 goals",
      probability:
        prediction.over35,
      odds:
        odds.over35,
    },

    {
      market: "away",
      label: "Away win",
      probability:
        prediction.away,
      odds:
        odds.away,
    },

    {
      market: "home",
      label: "Home win",
      probability:
        prediction.home,
      odds:
        odds.home,
    },

    {
      market: "draw",
      label: "Draw",
      probability:
        prediction.draw,
      odds:
        odds.draw,
    },
  ];

  return definitions
    .map((definition) =>
      createCandidate({
        ...definition,
        prediction,
        h2h,
        lineups,
        form,
        bookmakerMovement,
      })
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score - a.score
    );
}

async function getBundle(id) {
  const eventRaw =
    await getEventDetail(id);

  const event =
    normalizeEvent(eventRaw);

  if (!event) {
    throw new Error(
      `Unable to normalize event ${id}`
    );
  }

  const [
    predictionRaw,
    oddsRaw,
    h2hRaw,
    formRaw,
    statsRaw,
    lineupsRaw,
    refereeRaw,
  ] = await Promise.all([
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
      "head-to-head"
    ),

    getResource(
      id,
      "form"
    ),

    getResource(
      id,
      "stats"
    ),

    getResource(
      id,
      "lineups"
    ),

    getResource(
      id,
      "referee"
    ),
  ]);

  const prediction =
    parsePrediction(
      predictionRaw
    );

  const odds =
    parseOdds(oddsRaw);

  const h2h =
    parseH2HWithFallback(
      h2hRaw,
      eventRaw
    );

  const form =
    parseForm(formRaw);

  const stats =
    parseStats(statsRaw);

  const lineups =
    parseLineups(lineupsRaw);

  const referee =
    parseReferee(
      refereeRaw
    );

  const bookmakerMovement =
    parseBookmakerMovement(
      odds
    );

  const candidates =
    buildCandidates({
      prediction,
      odds,
      h2h,
      lineups,
      form,
      bookmakerMovement,
    });

  const qualified =
    candidates.filter(
      (candidate) =>
        candidate.accepted
    );

  const rejected =
    candidates.filter(
      (candidate) =>
        !candidate.accepted
    );

  return {
    event,

    prediction,

    odds,

    h2h,

    form,

    stats,

    lineups,

    referee,

    exchange:
      exchangeStatus(),

    bookmakerMovement,

    candidates,

    qualified,

    rejected,
  };
}

async function analyzeEvent(id) {
  const bundle =
    await getBundle(id);

  const event =
    bundle.event;

  if (
    !event.league &&
    bundle.prediction?.raw?.event
      ?.league_name
  ) {
    event.league =
      bundle.prediction
        .raw
        .event
        .league_name;
  }

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    event: {
      id:
        event.id,

      home:
        event.home,

      away:
        event.away,

      date:
        event.date,

      status:
        event.status,

      league:
        event.league || "",

      leagueId:
        event.leagueId,

      seasonId:
        event.seasonId,

      raw:
        event.raw,

      predictionAvailable:
        bundle.prediction
          .available,
    },

    eventId:
      String(id),

    prediction:
      bundle.prediction,

    odds:
      bundle.odds,

    h2h:
      bundle.h2h,

    form:
      bundle.form,

    stats:
      bundle.stats,

    lineups:
      bundle.lineups,

    referee:
      bundle.referee,

    exchange:
      bundle.exchange,

    bookmakerMovement:
      bundle.bookmakerMovement,

    candidates:
      bundle.candidates,

    qualified:
      bundle.qualified,

    rejected:
      bundle.rejected,

    coverage: {
      prediction:
        bundle.prediction
          .available,

      odds:
        bundle.odds
          .available,

      h2h:
        bundle.h2h
          .sampleSize > 0,

      stats:
        bundle.stats
          .available,

      form:
        bundle.form
          .available,

      lineups:
        bundle.lineups
          .available,

      incidents:
        true,

      referee:
        bundle.referee
          .available,

      refereeStats:
        bundle.referee
          .statsAvailable,

      bookmakerMovement:
        bundle.bookmakerMovement
          .available,

      exchangeMovement:
        bundle.exchange
          .connected,
    },
  };
}

async function getTopPicks(date) {
  const targetDate =
    normalizeDateInput(date);

  const allEvents =
    await getEvents(
      targetDate
    );

  const upcoming =
    allEvents
      .filter(
        isUpcomingEvent
      )
      .sort((a, b) => {
        const da =
          new Date(
            a.date || 0
          ).getTime();

        const db =
          new Date(
            b.date || 0
          ).getTime();

        return da - db;
      });

  const eventsToAnalyze =
    upcoming.slice(
      0,
      CONFIG.maxEvents
    );

  const analyses = [];

  for (
    const event of
    eventsToAnalyze
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

        eventId:
          String(event.id),

        error:
          error.message,

        event: {
          id:
            event.id,

          home:
            event.home,

          away:
            event.away,

          date:
            event.date,

          status:
            event.status,

          league:
            event.league || "",

          leagueId:
            event.leagueId,
        },
      });
    }
  }

  const qualified = [];

  for (
    const analysis of
    analyses
  ) {
    if (!analysis.ok) {
      continue;
    }

    for (
      const candidate of
      analysis.qualified || []
    ) {
      qualified.push({
        ...candidate,

        eventId:
          analysis.event.id,

        home:
          analysis.event.home,

        away:
          analysis.event.away,

        date:
          analysis.event.date,

        status:
          analysis.event.status,

        league:
          analysis.event.league,

        leagueId:
          analysis.event.leagueId,

        prediction:
          analysis.prediction,

        h2h:
          analysis.h2h,

        lineups:
          analysis.lineups,

        bookmakerMovement:
          analysis.bookmakerMovement,

        exchange:
          analysis.exchange,
      });
    }
  }

  qualified.sort(
    (a, b) => {
      if (
        b.score !==
        a.score
      ) {
        return (
          b.score -
          a.score
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
        (b.valuePercent ?? -999) -
        (a.valuePercent ?? -999)
      );
    }
  );

  const selected = [];

  const usedEvents =
    new Set();

  // First pass:
  // one pick per match.
  for (
    const candidate of
    qualified
  ) {
    if (
      selected.length >=
      CONFIG.topPicksLimit
    ) {
      break;
    }

    if (
      usedEvents.has(
        candidate.eventId
      )
    ) {
      continue;
    }

    selected.push(
      candidate
    );

    usedEvents.add(
      candidate.eventId
    );
  }

  // Second pass:
  // only if fewer than 10
  // different matches qualified.
  if (
    selected.length <
    CONFIG.topPicksLimit
  ) {
    for (
      const candidate of
      qualified
    ) {
      if (
        selected.length >=
        CONFIG.topPicksLimit
      ) {
        break;
      }

      const duplicate =
        selected.some(
          (item) =>
            item.eventId ===
              candidate.eventId &&
            item.market ===
              candidate.market
        );

      if (duplicate) {
        continue;
      }

      selected.push(
        candidate
      );
    }
  }

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    date:
      targetDate,

    universe: {
      eventsReturned:
        allEvents.length,

      upcomingEvents:
        upcoming.length,

      eventsAnalyzed:
        eventsToAnalyze.length,

      eventsExcluded:
        allEvents.length -
        upcoming.length,

      qualificationCount:
        qualified.length,
    },

    filters: {
      highProbability: {
        probabilityMin:
          CONFIG.highProbabilityMin,

        scoreMin:
          CONFIG.highProbabilityScoreMin,

        valueMin:
          CONFIG.highProbabilityValueMin,
      },

      value: {
        probabilityMin:
          CONFIG.valueProbabilityMin,

        scoreMin:
          CONFIG.valueScoreMin,

        valueMin:
          CONFIG.valueMin,
      },

      allowedStatuses: [
        "notstarted",
        "not_started",
        "scheduled",
        "upcoming",
        "pending",
      ],

      excludedStatuses: [
        "finished",
        "cancelled",
        "canceled",
        "postponed",
        "abandoned",
        "suspended",
        "live",
        "inplay",
      ],

      maxEventsAnalyzed:
        CONFIG.maxEvents,

      maxTopPicks:
        CONFIG.topPicksLimit,
    },

    picks:
      selected,

    qualifiedCount:
      qualified.length,

    analyzed:
      analyses.map(
        (analysis) => ({
          ok:
            analysis.ok,

          eventId:
            analysis.event?.id ||
            analysis.eventId,

          home:
            analysis.event?.home,

          away:
            analysis.event?.away,

          date:
            analysis.event?.date,

          status:
            analysis.event?.status,

          qualified:
            analysis.ok
              ? analysis
                  .qualified
                  .length
              : 0,

          topCandidate:
            analysis.ok &&
            analysis.candidates?.length
              ? {
                  market:
                    analysis
                      .candidates[0]
                      .market,

                  label:
                    analysis
                      .candidates[0]
                      .label,

                  probability:
                    analysis
                      .candidates[0]
                      .probability,

                  odds:
                    analysis
                      .candidates[0]
                      .odds,

                  valuePercent:
                    analysis
                      .candidates[0]
                      .valuePercent,

                  score:
                    analysis
                      .candidates[0]
                      .score,

                  accepted:
                    analysis
                      .candidates[0]
                      .accepted,

                  qualificationType:
                    analysis
                      .candidates[0]
                      .qualificationType,
                }
              : null,

          error:
            analysis.ok
              ? null
              : analysis.error,
        })
      ),

    exchange:
      exchangeStatus(),
  };
}

/* =========================
   ROUTES
   ========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name:
      "Bet Analyzer Live",
    version:
      VERSION,
    source:
      SOURCE,
    message:
      "Backend is running.",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version:
      VERSION,
    source:
      SOURCE,
    bsdConfigured:
      Boolean(BSD_API_KEY),
    timestamp:
      new Date().toISOString(),
  });
});

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        normalizeDateInput(
          req.query.date
        );

      const events =
        await getEvents(
          date
        );

      res.json({
        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        date,

        count:
          events.length,

        events:
          events.map(
            (event) => ({
              id:
                event.id,

              home:
                event.home,

              away:
                event.away,

              date:
                event.date,

              status:
                event.status,

              league:
                event.league,

              leagueId:
                event.leagueId,

              seasonId:
                event.seasonId,

              refereeId:
                event.refereeId,

              upcoming:
                isUpcomingEvent(
                  event
                ),

              live:
                isLiveEvent(
                  event
                ),

              finished:
                isFinishedEvent(
                  event
                ),

              h2hSampleSize:
                num(
                  event.raw
                    ?.head_to_head
                    ?.total_matches
                ) || 0,
            })
          ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isInteger(id)
      ) {
        return res.status(400).json({
          ok: false,
          version:
            VERSION,
          error:
            "Invalid event ID.",
        });
      }

      const analysis =
        await analyzeEvent(
          id
        );

      res.json(
        analysis
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        source:
          SOURCE,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        normalizeDateInput(
          req.query.date
        );

      const result =
        await getTopPicks(
          date
        );

      res.json(
        result
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        source:
          SOURCE,
        error:
          error.message,
      });
    }
  }
);

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
        exchangeStatus(),
    });
  }
);

app.get(
  "/api/coverage",
  async (req, res) => {
    try {
      const eventId =
        Number(
          req.query.eventId
        );

      if (
        !Number.isInteger(
          eventId
        )
      ) {
        return res.status(400).json({
          ok: false,
          version:
            VERSION,
          error:
            "eventId is required.",
        });
      }

      const analysis =
        await analyzeEvent(
          eventId
        );

      res.json({
        ok: true,

        version:
          VERSION,

        eventId,

        coverage:
          analysis.coverage,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        error:
          error.message,
      });
    }
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      version:
        VERSION,
      error:
        "Route not found.",
      path:
        req.path,
    });
  }
);

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled error:",
      error
    );

    res.status(500).json({
      ok: false,
      version:
        VERSION,
      error:
        error?.message ||
        "Internal server error.",
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
