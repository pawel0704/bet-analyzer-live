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

const VERSION = "5.3.1";
const SOURCE = "BSD";

const MIN_PROBABILITY = 50;
const MIN_VALUE_PERCENT = 2;
const MIN_SCORE = 55;
const MAX_PICKS = 10;
const MAX_PICKS_PER_EVENT = 2;

const REQUEST_TIMEOUT = 12000;
const RETRIES = 2;

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.matches)) return value.matches;

  return [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pct(value) {
  const n = num(value);
  if (n === null) return null;
  return n <= 1 ? n * 100 : n;
}

function normalizeProbability(value) {
  const n = pct(value);
  if (n === null) return null;
  return clamp(n, 0, 100);
}

function normalizeOdds(value) {
  const n = num(value);
  if (n === null || n <= 1) return null;
  return n;
}

function average(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function safeText(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function addUnique(list, value) {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

async function fetchJson(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY_MISSING");
  }

  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  let lastError = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

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

      clearTimeout(timer);

      const text = await response.text();

      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        const error = new Error(
          `BSD_HTTP_${response.status}: ${safeText(
            typeof data === "string" ? data : JSON.stringify(data)
          ).slice(0, 500)}`
        );

        error.status = response.status;

        if (response.status >= 400 && response.status < 500) {
          throw error;
        }

        lastError = error;
        continue;
      }

      return data;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (attempt < RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1))
        );
      }
    }
  }

  throw lastError || new Error("BSD_REQUEST_FAILED");
}

async function getEvents(date) {
  const attempts = [
    `/events?date=${encodeURIComponent(date)}&page_size=100`,
    `/events?date=${encodeURIComponent(date)}&limit=100`,
    `/events?date=${encodeURIComponent(date)}`,
  ];

  let lastError = null;

  for (const path of attempts) {
    try {
      const data = await fetchJson(path);
      const events = asArray(data);

      if (events.length) {
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

async function getResource(eventId, resource) {
  const paths = [
    `/events/${eventId}/${resource}`,
    `/event/${eventId}/${resource}`,
  ];

  for (const path of paths) {
    try {
      return await fetchJson(path);
    } catch {
      // Try next possible BSD path.
    }
  }

  return null;
}

async function getEventBundle(event) {
  const id =
    event?.id ??
    event?.eventId ??
    event?.event_id ??
    event?.match_id;

  if (id === undefined || id === null) {
    throw new Error("EVENT_ID_MISSING");
  }

  const [
    prediction,
    odds,
    h2h,
    stats,
    form,
    lineups,
    incidents,
  ] = await Promise.all([
    getResource(id, "prediction"),
    getResource(id, "odds"),
    getResource(id, "h2h"),
    getResource(id, "stats"),
    getResource(id, "form"),
    getResource(id, "lineups"),
    getResource(id, "incidents"),
  ]);

  return {
    event,
    id,
    prediction,
    odds,
    h2h,
    stats,
    form,
    lineups,
    incidents,
  };
}

function parsePrediction(raw) {
  if (!raw) {
    return {
      home: null,
      draw: null,
      away: null,
      over15: null,
      over25: null,
      over35: null,
      bttsYes: null,
      confidence: null,
      xgHome: null,
      xgAway: null,
      raw: null,
    };
  }

  const source = raw?.prediction || raw?.data || raw?.result || raw;

  const home = normalizeProbability(
    source?.home ??
      source?.home_win ??
      source?.homeWin ??
      source?.home_probability ??
      source?.homeProbability
  );

  const draw = normalizeProbability(
    source?.draw ??
      source?.draw_probability ??
      source?.drawProbability
  );

  const away = normalizeProbability(
    source?.away ??
      source?.away_win ??
      source?.awayWin ??
      source?.away_probability ??
      source?.awayProbability
  );

  const over15 = normalizeProbability(
    source?.over_1_5 ??
      source?.over15 ??
      source?.over15_probability ??
      source?.over_1_5_probability
  );

  const over25 = normalizeProbability(
    source?.over_2_5 ??
      source?.over25 ??
      source?.over25_probability ??
      source?.over_2_5_probability
  );

  const over35 = normalizeProbability(
    source?.over_3_5 ??
      source?.over35 ??
      source?.over35_probability ??
      source?.over_3_5_probability
  );

  const bttsYes = normalizeProbability(
    source?.btts_yes ??
      source?.bttsYes ??
      source?.both_teams_to_score ??
      source?.btts_probability
  );

  const confidence = normalizeProbability(
    source?.confidence ??
      source?.model_confidence ??
      source?.prediction_confidence
  );

  const xgHome = num(
    source?.xg_home ??
      source?.home_xg ??
      source?.expected_goals_home ??
      source?.xgHome
  );

  const xgAway = num(
    source?.xg_away ??
      source?.away_xg ??
      source?.expected_goals_away ??
      source?.xgAway
  );

  return {
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    confidence,
    xgHome,
    xgAway,
    raw,
  };
}

function parseOdds(raw) {
  if (!raw) {
    return {
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
      raw: null,
    };
  }

  const source = raw?.odds || raw?.data || raw?.result || raw;

  const get = (...keys) => {
    for (const key of keys) {
      const value = normalizeOdds(source?.[key]);
      if (value !== null) return value;
    }
    return null;
  };

  return {
    home: get("home", "home_win", "homeWin"),
    draw: get("draw"),
    away: get("away", "away_win", "awayWin"),

    over15: get(
      "over_1_5",
      "over15",
      "over_1.5"
    ),

    under15: get(
      "under_1_5",
      "under15",
      "under_1.5"
    ),

    over25: get(
      "over_2_5",
      "over25",
      "over_2.5"
    ),

    under25: get(
      "under_2_5",
      "under25",
      "under_2.5"
    ),

    over35: get(
      "over_3_5",
      "over35",
      "over_3.5"
    ),

    under35: get(
      "under_3_5",
      "under35",
      "under_3.5"
    ),

    bttsYes: get(
      "btts_yes",
      "bttsYes",
      "both_teams_to_score_yes"
    ),

    bttsNo: get(
      "btts_no",
      "bttsNo",
      "both_teams_to_score_no"
    ),

    previous:
      source?.previous ??
      source?.previous_odds ??
      source?.opening_odds ??
      source?.opening ??
      null,

    raw,
  };
}

function parseH2H(raw) {
  if (!raw) {
    return {
      sampleSize: 0,
      homeWins: null,
      draws: null,
      awayWins: null,
      homeGoals: null,
      awayGoals: null,
      averageGoals: null,
      matches: [],
    };
  }

  const source = raw?.h2h || raw?.data || raw?.result || raw;

  const matches = asArray(
    source?.matches ??
      source?.games ??
      source?.history ??
      source
  );

  const sampleSize =
    num(
      source?.total_matches ??
        source?.totalMatches ??
        source?.sample_size ??
        source?.sampleSize
    ) ?? matches.length;

  const homeWins = num(
    source?.home_wins ??
      source?.homeWins
  );

  const draws = num(
    source?.draws ??
      source?.draw
  );

  const awayWins = num(
    source?.away_wins ??
      source?.awayWins
  );

  const homeGoals = num(
    source?.home_goals ??
      source?.homeGoals ??
      source?.goals_home
  );

  const awayGoals = num(
    source?.away_goals ??
      source?.awayGoals ??
      source?.goals_away
  );

  const averageGoals =
    num(
      source?.average_total_goals ??
        source?.avg_total_goals ??
        source?.average_goals
    ) ??
    (homeGoals !== null && awayGoals !== null && sampleSize
      ? (homeGoals + awayGoals) / sampleSize
      : null);

  return {
    sampleSize,
    homeWins,
    draws,
    awayWins,
    homeGoals,
    awayGoals,
    averageGoals,
    matches,
    raw,
  };
}

function parseForm(raw) {
  if (!raw) {
    return {
      home: [],
      away: [],
      raw: null,
    };
  }

  const source = raw?.form || raw?.data || raw?.result || raw;

  let home = [];
  let away = [];

  if (Array.isArray(source?.home)) {
    home = source.home;
  }

  if (Array.isArray(source?.away)) {
    away = source.away;
  }

  if (Array.isArray(source?.home_form)) {
    home = source.home_form;
  }

  if (Array.isArray(source?.away_form)) {
    away = source.away_form;
  }

  if (Array.isArray(source?.homeForm)) {
    home = source.homeForm;
  }

  if (Array.isArray(source?.awayForm)) {
    away = source.awayForm;
  }

  const list = asArray(source);

  if (!home.length && !away.length && list.length) {
    for (const item of list) {
      const side = safeText(
        item?.side ??
          item?.team_side ??
          item?.venue
      ).toLowerCase();

      if (side === "home") {
        home.push(item);
      } else if (side === "away") {
        away.push(item);
      }
    }
  }

  return {
    home,
    away,
    raw,
  };
}

function statsSignal(raw) {
  if (!raw) {
    return {
      score: 0,
      available: false,
      details: [],
    };
  }

  const source = raw?.stats || raw?.data || raw?.result || raw;

  const home =
    source?.home ??
    source?.home_stats ??
    source?.homeStats ??
    {};

  const away =
    source?.away ??
    source?.away_stats ??
    source?.awayStats ??
    {};

  const pairs = [
    ["shots_on_target", "shotsOnTarget"],
    ["shots", "shots"],
    ["possession", "possession"],
    ["corners", "corners"],
    ["dangerous_attacks", "dangerousAttacks"],
  ];

  let score = 0;
  let available = 0;
  const details = [];

  for (const [snake, camel] of pairs) {
    const h = num(home?.[snake] ?? home?.[camel]);
    const a = num(away?.[snake] ?? away?.[camel]);

    if (h === null || a === null || h === a) {
      continue;
    }

    available++;

    const diff = Math.abs(h - a);
    const total = Math.abs(h) + Math.abs(a);

    if (!total) continue;

    const relative = diff / total;

    if (relative >= 0.35) {
      score += h > a ? 2 : -2;
    } else if (relative >= 0.15) {
      score += h > a ? 1 : -1;
    }

    details.push({
      metric: snake,
      home: h,
      away: a,
    });
  }

  return {
    score: clamp(score, -6, 6),
    available: available > 0,
    details,
  };
}

function lineupSignal(raw) {
  if (!raw) {
    return {
      score: 0,
      available: false,
      details: [],
    };
  }

  const source = raw?.lineups || raw?.data || raw?.result || raw;

  const home =
    source?.home ??
    source?.home_lineup ??
    source?.homeLineup ??
    [];

  const away =
    source?.away ??
    source?.away_lineup ??
    source?.awayLineup ??
    [];

  const homeArray = asArray(home);
  const awayArray = asArray(away);

  const available =
    homeArray.length > 0 ||
    awayArray.length > 0 ||
    !!source?.home ||
    !!source?.away;

  let score = 0;

  if (homeArray.length >= 11) score += 1;
  if (awayArray.length >= 11) score += 1;

  return {
    score,
    available,
    details: {
      homePlayers: homeArray.length,
      awayPlayers: awayArray.length,
    },
  };
}

function formSignal(raw) {
  if (!raw) {
    return {
      score: 0,
      available: false,
      details: {},
    };
  }

  const parsed = parseForm(raw);

  function formScore(list) {
    let score = 0;
    let count = 0;

    for (const item of list) {
      const value = safeText(
        item?.result ??
          item?.form ??
          item?.outcome ??
          item
      ).toUpperCase();

      if (value.includes("W")) {
        score += 1;
        count++;
      } else if (value.includes("L")) {
        score -= 1;
        count++;
      } else if (value.includes("D")) {
        count++;
      }
    }

    return {
      score,
      count,
    };
  }

  const home = formScore(parsed.home);
  const away = formScore(parsed.away);

  return {
    score: clamp(home.score - away.score, -4, 4),
    available: home.count > 0 || away.count > 0,
    details: {
      home,
      away,
    },
  };
}

function refereeSignal(event) {
  const referee =
    event?.referee ??
    event?.official ??
    null;

  const id =
    referee?.id ??
    event?.referee_id ??
    event?.refereeId ??
    null;

  const name =
    referee?.name ??
    referee?.full_name ??
    null;

  return {
    available: !!(id || name),
    id,
    name,
    score: 0,
    note:
      id || name
        ? "Referee identified; verified referee statistics are not available from the current BSD integration."
        : "Referee data unavailable.",
  };
}

function extractEventInfo(event) {
  const home =
    event?.home_team?.name ??
    event?.homeTeam?.name ??
    event?.home?.name ??
    event?.home_name ??
    event?.homeTeam ??
    event?.home ??
    "Home";

  const away =
    event?.away_team?.name ??
    event?.awayTeam?.name ??
    event?.away?.name ??
    event?.away_name ??
    event?.awayTeam ??
    event?.away ??
    "Away";

  const date =
    event?.date ??
    event?.start_time ??
    event?.startTime ??
    event?.datetime ??
    null;

  return {
    home: safeText(home),
    away: safeText(away),
    date,
  };
}

function previousOddsForMarket(previous, market) {
  if (!previous) return null;

  const source =
    previous?.odds ??
    previous?.data ??
    previous;

  const keys = {
    home: ["home", "home_win", "homeWin"],
    draw: ["draw"],
    away: ["away", "away_win", "awayWin"],
    over15: ["over_1_5", "over15", "over_1.5"],
    over25: ["over_2_5", "over25", "over_2.5"],
    over35: ["over_3_5", "over35", "over_3.5"],
    bttsYes: ["btts_yes", "bttsYes"],
  };

  for (const key of keys[market] || []) {
    const value = normalizeOdds(source?.[key]);
    if (value !== null) return value;
  }

  return null;
}

function movementSignal(odds, market) {
  const current = odds?.[market];

  const previous = previousOddsForMarket(
    odds?.previous,
    market
  );

  if (
    current === null ||
    current === undefined ||
    previous === null
  ) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null,
    };
  }

  const percent = ((current - previous) / previous) * 100;

  let direction = "STABLE";

  if (percent <= -2) {
    direction = "SHORTENING";
  } else if (percent >= 2) {
    direction = "DRIFTING";
  }

  return {
    available: true,
    direction,
    percent: Number(percent.toFixed(2)),
  };
}

function impliedProbability(odds) {
  if (!odds || odds <= 1) return null;
  return 100 / odds;
}

function calculateValue(probability, odds) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  return probability * odds - 100;
}

function buildCandidates(prediction, odds) {
  const candidates = [];

  const push = (
    market,
    label,
    probability,
    odd
  ) => {
    if (
      probability === null ||
      probability === undefined ||
      odd === null ||
      odd === undefined
    ) {
      return;
    }

    candidates.push({
      market,
      label,
      probability,
      odds: odd,
    });
  };

  push(
    "home",
    "Home win",
    prediction.home,
    odds.home
  );

  push(
    "draw",
    "Draw",
    prediction.draw,
    odds.draw
  );

  push(
    "away",
    "Away win",
    prediction.away,
    odds.away
  );

  push(
    "over15",
    "Over 1.5 goals",
    prediction.over15,
    odds.over15
  );

  push(
    "over25",
    "Over 2.5 goals",
    prediction.over25,
    odds.over25
  );

  push(
    "over35",
    "Over 3.5 goals",
    prediction.over35,
    odds.over35
  );

  push(
    "bttsYes",
    "Both teams to score — Yes",
    prediction.bttsYes,
    odds.bttsYes
  );

  return candidates;
}

function candidateContext(
  candidate,
  prediction,
  h2h,
  stats,
  form,
  lineups,
  referee
) {
  let bonus = 0;
  const reasons = [];

  if (candidate.market === "home") {
    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome > prediction.xgAway
    ) {
      bonus += 3;
      reasons.push("Home xG advantage");
    }

    if (
      form.available &&
      form.score > 0
    ) {
      bonus += 2;
      reasons.push("Recent-form signal favors home");
    }

    if (
      stats.available &&
      stats.score > 0
    ) {
      bonus += Math.min(stats.score, 2);
      reasons.push("Match-stat signal favors home");
    }
  }

  if (candidate.market === "away") {
    if (
      prediction.xgAway !== null &&
      prediction.xgHome !== null &&
      prediction.xgAway > prediction.xgHome
    ) {
      bonus += 3;
      reasons.push("Away xG advantage");
    }

    if (
      form.available &&
      form.score < 0
    ) {
      bonus += 2;
      reasons.push("Recent-form signal favors away");
    }

    if (
      stats.available &&
      stats.score < 0
    ) {
      bonus += Math.min(Math.abs(stats.score), 2);
      reasons.push("Match-stat signal favors away");
    }
  }

  if (candidate.market === "over15") {
    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 2.5
    ) {
      bonus += 3;
      reasons.push("Combined xG supports goals");
    }

    if (
      h2h.averageGoals !== null &&
      h2h.averageGoals >= 2.5
    ) {
      bonus += 2;
      reasons.push("H2H goal average supports over");
    }
  }

  if (candidate.market === "over25") {
    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 2.8
    ) {
      bonus += 3;
      reasons.push("Combined xG supports over 2.5");
    }

    if (
      h2h.averageGoals !== null &&
      h2h.averageGoals >= 3
    ) {
      bonus += 2;
      reasons.push("H2H goal average supports over 2.5");
    }
  }

  if (candidate.market === "over35") {
    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome + prediction.xgAway >= 3.5
    ) {
      bonus += 3;
      reasons.push("Very high combined xG");
    }
  }

  if (candidate.market === "bttsYes") {
    if (
      prediction.xgHome !== null &&
      prediction.xgAway !== null &&
      prediction.xgHome >= 0.9 &&
      prediction.xgAway >= 0.9
    ) {
      bonus += 3;
      reasons.push("Both teams have meaningful xG");
    }
  }

  if (lineups.available) {
    bonus += 1;
    reasons.push("Lineup data available");
  }

  if (referee.available) {
    reasons.push("Referee identified");
  }

  return {
    bonus,
    reasons,
  };
}

function analyzeBundle(bundle) {
  const prediction = parsePrediction(bundle.prediction);
  const odds = parseOdds(bundle.odds);
  const h2h = parseH2H(bundle.h2h);
  const form = parseForm(bundle.form);
  const stats = statsSignal(bundle.stats);
  const lineup = lineupSignal(bundle.lineups);
  const formScore = formSignal(bundle.form);
  const referee = refereeSignal(bundle.event);

  const candidates = buildCandidates(
    prediction,
    odds
  );

  const rejected = [];

  const analyzed = candidates.map((candidate) => {
    const value = calculateValue(
      candidate.probability,
      candidate.odds
    );

    const movement = movementSignal(
      odds,
      candidate.market
    );

    const context = candidateContext(
      candidate,
      prediction,
      h2h,
      stats,
      formScore,
      lineup,
      referee
    );

    let score = candidate.probability;

    score += context.bonus;

    if (value !== null) {
      score += clamp(value / 5, -5, 5);
    }

    if (movement.available) {
      if (movement.direction === "SHORTENING") {
        score += 2;
      } else if (movement.direction === "DRIFTING") {
        score -= 2;
      }
    }

    score = clamp(score, 0, 100);

    const rejectionReasons = [];

    if (candidate.probability < MIN_PROBABILITY) {
      rejectionReasons.push("PROBABILITY_LT_MIN");
    }

    if (value === null) {
      rejectionReasons.push("NO_VALUE");
    } else if (value < MIN_VALUE_PERCENT) {
      rejectionReasons.push("VALUE_LT_MIN");
    }

    if (score < MIN_SCORE) {
      rejectionReasons.push("SCORE_LT_MIN");
    }

    if (
      candidate.odds > 4 &&
      candidate.probability < 65
    ) {
      rejectionReasons.push("REALISM_GUARD");
    }

    if (
      ["home", "draw", "away"].includes(candidate.market)
    ) {
      const oneX2 = [
        prediction.home,
        prediction.draw,
        prediction.away,
      ].filter((v) => v !== null);

      if (oneX2.length >= 2) {
        const sorted = [...oneX2].sort((a, b) => b - a);

        if (
          sorted.length >= 2 &&
          sorted[0] - sorted[1] < 3 &&
          candidate.probability < 60
        ) {
          rejectionReasons.push(
            "WEAK_1X2_SEPARATION"
          );
        }
      }
    }

    if (rejectionReasons.length) {
      rejected.push({
        market: candidate.market,
        label: candidate.label,
        reason: rejectionReasons[0],
        reasons: rejectionReasons,
      });
    }

    return {
      ...candidate,
      valuePercent:
        value === null
          ? null
          : Number(value.toFixed(2)),
      impliedProbability:
        impliedProbability(candidate.odds),
      score: Number(score.toFixed(2)),
      movement,
      context,
      accepted: rejectionReasons.length === 0,
      rejectionReasons,
    };
  });

  analyzed.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return (
      (b.valuePercent ?? -999) -
      (a.valuePercent ?? -999)
    );
  });

  return {
    event: bundle.event,
    eventId: bundle.id,

    prediction,
    odds,

    h2h,
    form: formScore,
    stats,
    lineups: lineup,
    referee,

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
    },

    candidates: analyzed,

    qualified: analyzed.filter(
      (item) => item.accepted
    ),

    rejected,

    coverage: {
      prediction: !!bundle.prediction,
      odds: !!bundle.odds,
      h2h: !!bundle.h2h,
      stats: !!bundle.stats,
      form: !!bundle.form,
      lineups: !!bundle.lineups,
      incidents: !!bundle.incidents,
      referee: referee.available,
      refereeStats: false,
      bookmakerMovement: analyzed.some(
        (item) => item.movement.available
      ),
      exchangeMovement: false,
    },
  };
}

function addRejectionCounts(counts, reasons) {
  for (const reason of reasons) {
    counts[reason] = (counts[reason] || 0) + 1;
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const events = await getEvents(date);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      count: events.length,
      events,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/live", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const events = await getEvents(date);

    const live = events.filter((event) => {
      const status = safeText(
        event?.status ??
          event?.state ??
          event?.match_status
      ).toLowerCase();

      return [
        "live",
        "inplay",
        "in_play",
        "1h",
        "2h",
        "ht",
      ].includes(status);
    });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      count: live.length,
      events: live,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const bundle = await getEventBundle({
      id,
    });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      ...bundle,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/prediction", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "prediction"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      prediction: parsePrediction(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "odds"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      odds: parseOdds(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/h2h", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "h2h"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      h2h: parseH2H(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/stats", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "stats"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      stats: statsSignal(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/form", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "form"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      form: formSignal(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/lineups", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "lineups"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      lineups: lineupSignal(raw),
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/events/:id/incidents", async (req, res) => {
  try {
    const raw = await getResource(
      req.params.id,
      "incidents"
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId: req.params.id,
      raw,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/analyze/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const bundle = await getEventBundle({
      id,
    });

    const result = analyzeBundle(bundle);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const events = await getEvents(date);

    const rejectionCounts = {};

    const allQualified = [];

    let quickCandidates = 0;

    for (const event of events) {
      try {
        const bundle = await getEventBundle(event);

        const result = analyzeBundle(bundle);

        const accepted =
          result.qualified || [];

        if (accepted.length) {
          quickCandidates += accepted.length;
        }

        for (const item of accepted) {
          allQualified.push({
            eventId: result.eventId,
            event: result.event,
            market: item.market,
            label: item.label,
            probability: item.probability,
            odds: item.odds,
            valuePercent: item.valuePercent,
            score: item.score,
            movement: item.movement,
            reasons: item.context?.reasons || [],
            prediction: result.prediction,
            h2h: result.h2h,
            form: result.form,
            stats: result.stats,
            lineups: result.lineups,
            referee: result.referee,
          });
        }

        addRejectionCounts(
          rejectionCounts,
          (result.rejected || []).map(
            (item) => item.reason
          )
        );
      } catch (error) {
        rejectionCounts.ANALYSIS_ERROR =
          (rejectionCounts.ANALYSIS_ERROR || 0) + 1;
      }
    }

    allQualified.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        (b.valuePercent ?? -999) -
        (a.valuePercent ?? -999)
      );
    });

    const selected = [];
    const perEvent = {};

    for (const pick of allQualified) {
      const eventId = String(pick.eventId);

      if (
        (perEvent[eventId] || 0) >=
        MAX_PICKS_PER_EVENT
      ) {
        continue;
      }

      selected.push(pick);

      perEvent[eventId] =
        (perEvent[eventId] || 0) + 1;

      if (selected.length >= MAX_PICKS) {
        break;
      }
    }

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,

      exchange: {
        connected: false,
        status: "EXCHANGE_UNAVAILABLE",
        reason:
          "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
      },

      filters: {
        minimumProbability: MIN_PROBABILITY,
        minimumValuePercent: MIN_VALUE_PERCENT,
        minimumScore: MIN_SCORE,
        maxPicks: MAX_PICKS,
        maxPicksPerEvent: MAX_PICKS_PER_EVENT,
      },

      eventsScanned: events.length,
      quickCandidates,
      qualifiedPicks: allQualified.length,

      picks: selected,

      diagnostics: {
        rejectionCounts,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const q = safeText(req.query.q).toLowerCase();

    const events = await getEvents(date);

    if (!q) {
      return res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        date,
        count: events.length,
        events,
      });
    }

    const filtered = events.filter((event) => {
      const info = extractEventInfo(event);

      const text = [
        info.home,
        info.away,
        safeText(event?.league),
        safeText(event?.league_name),
        safeText(event?.competition),
      ]
        .join(" ")
        .toLowerCase();

      return text.includes(q);
    });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      query: q,
      count: filtered.length,
      events: filtered,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
    });
  }
});

app.get("/api/coverage", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,

    available: {
      events: true,
      prediction: true,
      odds: true,
      h2h: true,
      stats: true,
      form: true,
      lineups: true,
      incidents: true,
      refereeIdentification: true,
      refereeStats: false,
      bookmakerMovement: "BSD-dependent",
      exchangeMovement: false,
    },

    exchange: {
      connected: false,
      status: "EXCHANGE_UNAVAILABLE",
      reason:
        "A verified betting-exchange feed is not connected.",
    },

    notes: [
      "No exchange movement is fabricated.",
      "Bookmaker movement is reported only when previous odds are supplied by BSD.",
      "Referee identification is supported, but verified referee statistics are not currently connected.",
      "Recent-form parsing depends on the schema returned by BSD.",
    ],
  });
});

app.get("/api/events/:id/polymarket", async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    eventId: req.params.id,

    connected: false,

    status: "EXCHANGE_UNAVAILABLE",

    reason:
      "This endpoint is not treated as a verified betting-exchange feed. No exchange signal is fabricated.",
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "NOT_FOUND",
    path: req.originalUrl,
  });
});

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
  );
});
