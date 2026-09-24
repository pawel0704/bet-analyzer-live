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

const VERSION = "6.0.0";
const SOURCE = "BSD";

const CONFIG = {
  minProbability: 50,
  minValuePercent: 1.5,
  minScore: 58,
  maxPicks: 10,
  maxPicksPerEvent: 2,
  requestTimeout: 12000,
  retries: 2,
};

if (!BSD_API_KEY) console.warn("WARNING: BSD_API_KEY is not configured.");

function asArray(v) {
  if (Array.isArray(v)) return v;
  for (const key of [
    "results",
    "data",
    "items",
    "events",
    "matches",
    "games",
    "players",
    "lineups",
  ]) {
    if (Array.isArray(v?.[key])) return v[key];
  }
  return [];
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function probability(v) {
  const x = n(v);
  if (x === null) return null;
  return Math.max(0, Math.min(100, x <= 1 ? x * 100 : x));
}

function odds(v) {
  const x = n(v);
  return x !== null && x > 1 ? x : null;
}

function text(v) {
  return v === undefined || v === null ? "" : String(v);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(path, options = {}) {
  if (!BSD_API_KEY) throw new Error("BSD_API_KEY_MISSING");

  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  let lastError;

  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeout
    );

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

      const body = await response.text();
      clearTimeout(timer);

      let data;

      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        data = body;
      }

      if (!response.ok) {
        const e = new Error(`BSD_HTTP_${response.status}`);
        e.status = response.status;
        e.body =
          typeof data === "string" ? data.slice(0, 500) : data;

        if (response.status >= 400 && response.status < 500) {
          throw e;
        }

        lastError = e;
        await sleep(300 * (attempt + 1));
        continue;
      }

      return data;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;

      if (attempt < CONFIG.retries) {
        await sleep(350 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error("BSD_REQUEST_FAILED");
}

async function getEvents(date) {
  let last;

  for (const path of [
    `/events?date=${encodeURIComponent(date)}&page_size=100`,
    `/events?date=${encodeURIComponent(date)}&limit=100`,
    `/events?date=${encodeURIComponent(date)}`,
  ]) {
    try {
      const data = await fetchJson(path);
      const list = asArray(data);

      if (list.length) return list;
    } catch (e) {
      last = e;
    }
  }

  if (last) throw last;

  return [];
}

async function getResource(eventId, resource) {
  for (const path of [
    `/events/${eventId}/${resource}`,
    `/event/${eventId}/${resource}`,
  ]) {
    try {
      return await fetchJson(path);
    } catch (_) {}
  }

  return null;
}

async function getBundle(event) {
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
    oddsRaw,
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
    oddsRaw,
    h2h,
    stats,
    form,
    lineups,
    incidents,
  };
}

function eventInfo(event) {
  return {
    home: text(
      event?.home_team ??
        event?.home_team_name ??
        event?.home?.name ??
        event?.home_name ??
        event?.homeTeam?.name ??
        event?.homeTeam ??
        event?.home ??
        "Home"
    ),

    away: text(
      event?.away_team ??
        event?.away_team_name ??
        event?.away?.name ??
        event?.away_name ??
        event?.awayTeam?.name ??
        event?.awayTeam ??
        event?.away ??
        "Away"
    ),

    date:
      event?.event_date ??
      event?.date ??
      event?.start_time ??
      event?.startTime ??
      event?.datetime ??
      null,

    league: text(
      event?.league_name ??
        event?.league ??
        event?.competition ??
        ""
    ),
  };
}

// BSD 6.x normalizer:
// probabilities are under prediction.markets.
function parsePrediction(raw) {
  const root =
    raw?.prediction ??
    raw?.data ??
    raw?.result ??
    raw ??
    {};

  const markets =
    root?.markets ??
    root?.prediction?.markets ??
    {};

  const match = markets?.match_result ?? {};
  const xg = markets?.expected_goals ?? {};
  const totals = markets?.over_under ?? {};
  const btts = markets?.btts ?? {};
  const model = root?.model ?? {};

  return {
    home: probability(
      match?.prob_home ??
        root?.prob_home ??
        root?.home
    ),

    draw: probability(
      match?.prob_draw ??
        root?.prob_draw ??
        root?.draw
    ),

    away: probability(
      match?.prob_away ??
        root?.prob_away ??
        root?.away
    ),

    over15: probability(
      totals?.prob_over_15 ??
        root?.prob_over_15 ??
        root?.over15
    ),

    over25: probability(
      totals?.prob_over_25 ??
        root?.prob_over_25 ??
        root?.over25
    ),

    over35: probability(
      totals?.prob_over_35 ??
        root?.prob_over_35 ??
        root?.over35
    ),

    bttsYes: probability(
      btts?.prob_yes ??
        root?.prob_btts_yes ??
        root?.btts_yes
    ),

    xgHome: n(
      xg?.home ??
        root?.xg_home
    ),

    xgAway: n(
      xg?.away ??
        root?.xg_away
    ),

    confidence: probability(
      model?.confidence ??
        root?.confidence
    ),

    predicted:
      match?.predicted ??
      null,

    mostLikelyScore:
      markets?.score?.most_likely ??
      null,

    raw,
  };
}

// BSD 6.x normalizer:
// markets are under odds.odds.
function parseOdds(raw) {
  const root =
    raw?.odds ??
    raw?.data ??
    raw?.result ??
    raw ??
    {};

  const market =
    root?.odds ??
    root;

  const previous =
    root?.previous_odds ??
    root?.previous ??
    raw?.previous_odds ??
    raw?.previous ??
    null;

  return {
    home: odds(
      market?.home_win ??
        market?.home ??
        market?.homeWin
    ),

    draw: odds(
      market?.draw
    ),

    away: odds(
      market?.away_win ??
        market?.away ??
        market?.awayWin
    ),

    over15: odds(
      market?.over_15_goals ??
        market?.over15 ??
        market?.over_1_5
    ),

    under15: odds(
      market?.under_15_goals ??
        market?.under15 ??
        market?.under_1_5
    ),

    over25: odds(
      market?.over_25_goals ??
        market?.over25 ??
        market?.over_2_5
    ),

    under25: odds(
      market?.under_25_goals ??
        market?.under25 ??
        market?.under_2_5
    ),

    over35: odds(
      market?.over_35_goals ??
        market?.over35 ??
        market?.over_3_5
    ),

    under35: odds(
      market?.under_35_goals ??
        market?.under35 ??
        market?.under_3_5
    ),

    bttsYes: odds(
      market?.btts_yes ??
        market?.bttsYes
    ),

    bttsNo: odds(
      market?.btts_no ??
        market?.bttsNo
    ),

    previous,

    updatedAt:
      raw?.last_update_at ??
      root?.last_update_at ??
      null,

    raw,
  };
}

function parseH2H(raw) {
  const root =
    raw?.h2h ??
    raw?.data ??
    raw?.result ??
    raw ??
    {};

  const matches = asArray(
    root?.recent_matches ??
      root?.matches ??
      root?.history ??
      root
  );

  const sample =
    n(
      root?.total_matches ??
        root?.totalMatches ??
        root?.sample_size
    ) ?? matches.length;

  const hg = n(
    root?.home_goals ??
      root?.homeGoals
  );

  const ag = n(
    root?.away_goals ??
      root?.awayGoals
  );

  return {
    sampleSize: sample,

    homeWins: n(
      root?.home_wins ??
        root?.homeWins
    ),

    draws: n(
      root?.draws ??
        root?.draw
    ),

    awayWins: n(
      root?.away_wins ??
        root?.awayWins
    ),

    homeGoals: hg,
    awayGoals: ag,

    averageGoals:
      n(
        root?.avg_total_goals ??
          root?.average_total_goals
      ) ??
      (
        hg !== null &&
        ag !== null &&
        sample
          ? (hg + ag) / sample
          : null
      ),

    matches,
    raw,
  };
}

function parseForm(raw) {
  if (!raw) {
    return {
      available: false,
      home: [],
      away: [],
      score: 0,
      details: null,
      raw: null,
    };
  }

  const root =
    raw?.form ??
    raw?.data ??
    raw?.result ??
    raw;

  const home = asArray(
    root?.home ??
      root?.home_form ??
      root?.homeForm
  );

  const away = asArray(
    root?.away ??
      root?.away_form ??
      root?.awayForm
  );

  const all = asArray(root);

  if (
    !home.length &&
    !away.length &&
    all.length
  ) {
    for (const item of all) {
      const side = text(
        item?.side ??
          item?.team_side ??
          item?.venue
      ).toLowerCase();

      if (side === "home") {
        home.push(item);
      }

      if (side === "away") {
        away.push(item);
      }
    }
  }

  const scoreList = (list) =>
    list.reduce((s, item) => {
      const r = text(
        item?.result ??
          item?.form ??
          item?.outcome ??
          item
      ).toUpperCase();

      if (
        r === "W" ||
        r.includes("WIN")
      ) {
        return s + 1;
      }

      if (
        r === "L" ||
        r.includes("LOSS")
      ) {
        return s - 1;
      }

      return s;
    }, 0);

  const hs = scoreList(home);
  const as = scoreList(away);

  return {
    available:
      home.length > 0 ||
      away.length > 0,

    home,
    away,

    score: Math.max(
      -4,
      Math.min(4, hs - as)
    ),

    details: {
      homeCount: home.length,
      awayCount: away.length,
      homeScore: hs,
      awayScore: as,
    },

    raw,
  };
}

function parseStats(raw) {
  if (!raw) {
    return {
      available: false,
      score: 0,
      details: [],
      raw: null,
    };
  }

  const root =
    raw?.stats ??
    raw?.data ??
    raw?.result ??
    raw ??
    {};

  const home =
    root?.home ??
    root?.home_stats ??
    root?.homeStats ??
    {};

  const away =
    root?.away ??
    root?.away_stats ??
    root?.awayStats ??
    {};

  const aliases = {
    shotsOnTarget: [
      "shots_on_target",
      "shotsOnTarget",
      "on_target",
    ],

    shots: [
      "shots",
      "total_shots",
    ],

    possession: [
      "possession",
      "ball_possession",
    ],

    corners: [
      "corners",
      "corner_kicks",
    ],

    dangerousAttacks: [
      "dangerous_attacks",
      "dangerousAttacks",
    ],
  };

  const get = (obj, keys) => {
    for (const key of keys) {
      const value = n(obj?.[key]);

      if (value !== null) {
        return value;
      }
    }

    return null;
  };

  const details = [];
  let score = 0;

  for (const [metric, keys] of Object.entries(aliases)) {
    const h = get(home, keys);
    const a = get(away, keys);

    if (h === null || a === null) {
      continue;
    }

    if (h === a) {
      details.push({
        metric,
        home: h,
        away: a,
        advantage: "EVEN",
      });

      continue;
    }

    const total =
      Math.abs(h) + Math.abs(a);

    const difference =
      Math.abs(h - a);

    const relative =
      total > 0
        ? difference / total
        : 0;

    let points = 0;

    if (relative >= 0.35) {
      points = 2;
    } else if (relative >= 0.15) {
      points = 1;
    }

    const homeBetter = h > a;

    score += homeBetter
      ? points
      : -points;

    details.push({
      metric,
      home: h,
      away: a,
      advantage: homeBetter
        ? "HOME"
        : "AWAY",
      points: homeBetter
        ? points
        : -points,
    });
  }

  return {
    available: details.length > 0,
    score: Math.max(
      -8,
      Math.min(8, score)
    ),
    details,
    raw,
  };
}

function parseLineups(raw) {
  if (!raw) {
    return {
      available: false,
      score: 0,
      details: {
        homePlayers: 0,
        awayPlayers: 0,
      },
      raw: null,
    };
  }

  const root =
    raw?.lineups ??
    raw?.data ??
    raw?.result ??
    raw ??
    {};

  const home = asArray(
    root?.home ??
      root?.home_lineup ??
      root?.homeLineup
  );

  const away = asArray(
    root?.away ??
      root?.away_lineup ??
      root?.awayLineup
  );

  const homeCount = home.length;
  const awayCount = away.length;

  const available =
    homeCount > 0 ||
    awayCount > 0;

  let score = 0;

  if (homeCount >= 11) {
    score += 1;
  }

  if (awayCount >= 11) {
    score += 1;
  }

  return {
    available,
    score,
    details: {
      homePlayers: homeCount,
      awayPlayers: awayCount,
      completeHome:
        homeCount >= 11,
      completeAway:
        awayCount >= 11,
    },
    raw,
  };
}

function parseReferee(event) {
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
    referee?.fullName ??
    null;

  return {
    available: !!(id || name),
    id,
    name,
    statsAvailable: false,
    score: 0,

    note:
      id || name
        ? "Referee identified, but verified referee statistics are not connected."
        : "Referee data unavailable.",
  };
}

function previousMarketOdds(
  previous,
  market
) {
  if (!previous) return null;

  const root =
    previous?.odds ??
    previous?.data ??
    previous?.result ??
    previous;

  const aliases = {
    home: [
      "home_win",
      "home",
    ],

    draw: [
      "draw",
    ],

    away: [
      "away_win",
      "away",
    ],

    over15: [
      "over_15_goals",
      "over15",
      "over_1_5",
    ],

    over25: [
      "over_25_goals",
      "over25",
      "over_2_5",
    ],

    over35: [
      "over_35_goals",
      "over35",
      "over_3_5",
    ],

    bttsYes: [
      "btts_yes",
      "bttsYes",
    ],
  };

  for (const key of aliases[market] || []) {
    const value = odds(
      root?.[key]
    );

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function movement(
  current,
  previous
) {
  if (
    current === null ||
    previous === null ||
    previous <= 1
  ) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null,
    };
  }

  const change =
    ((current - previous) /
      previous) *
    100;

  let direction = "STABLE";

  if (change <= -2) {
    direction = "SHORTENING";
  } else if (change >= 2) {
    direction = "DRIFTING";
  }

  return {
    available: true,
    direction,
    percent: Number(
      change.toFixed(2)
    ),
    current,
    previous,
  };
}

function marketMovement(
  parsedOdds,
  market
) {
  const current =
    parsedOdds?.[market] ?? null;

  const previous =
    previousMarketOdds(
      parsedOdds?.previous,
      market
    );

  return movement(
    current,
    previous
  );
}

function impliedProbability(
  odd
) {
  if (
    odd === null ||
    odd <= 1
  ) {
    return null;
  }

  return 100 / odd;
}

function valuePercent(
  probabilityValue,
  odd
) {
  if (
    probabilityValue === null ||
    odd === null
  ) {
    return null;
  }

  return (
    probabilityValue *
      odd -
    100
  );
}

function buildCandidates(
  prediction,
  parsedOdds
) {
  const candidates = [];

  const add = (
    market,
    label,
    prob,
    odd
  ) => {
    if (
      prob === null ||
      odd === null
    ) {
      return;
    }

    candidates.push({
      market,
      label,
      probability: prob,
      odds: odd,
    });
  };

  add(
    "home",
    "Home win",
    prediction.home,
    parsedOdds.home
  );

  add(
    "draw",
    "Draw",
    prediction.draw,
    parsedOdds.draw
  );

  add(
    "away",
    "Away win",
    prediction.away,
    parsedOdds.away
  );

  add(
    "over15",
    "Over 1.5 goals",
    prediction.over15,
    parsedOdds.over15
  );

  add(
    "over25",
    "Over 2.5 goals",
    prediction.over25,
    parsedOdds.over25
  );

  add(
    "over35",
    "Over 3.5 goals",
    prediction.over35,
    parsedOdds.over35
  );

  add(
    "bttsYes",
    "Both teams to score — Yes",
    prediction.bttsYes,
    parsedOdds.bttsYes
  );

  return candidates;
}

function h2hSignal(
  candidate,
  h2h
) {
  if (
    !h2h ||
    h2h.sampleSize <= 0
  ) {
    return {
      bonus: 0,
      reasons: [],
    };
  }

  const reasons = [];
  let bonus = 0;

  if (
    candidate.market === "home" &&
    h2h.homeWins !== null
  ) {
    const rate =
      h2h.homeWins /
      h2h.sampleSize;

    if (rate >= 0.66) {
      bonus += 2;
      reasons.push(
        "H2H strongly favors home"
      );
    } else if (rate >= 0.5) {
      bonus += 1;
      reasons.push(
        "H2H favors home"
      );
    }
  }

  if (
    candidate.market === "away" &&
    h2h.awayWins !== null
  ) {
    const rate =
      h2h.awayWins /
      h2h.sampleSize;

    if (rate >= 0.66) {
      bonus += 2;
      reasons.push(
        "H2H strongly favors away"
      );
    } else if (rate >= 0.5) {
      bonus += 1;
      reasons.push(
        "H2H favors away"
      );
    }
  }

  if (
    (
      candidate.market === "over15" ||
      candidate.market === "over25"
    ) &&
    h2h.averageGoals !== null
  ) {
    if (
      candidate.market === "over15" &&
      h2h.averageGoals >= 2.5
    ) {
      bonus += 2;
      reasons.push(
        "H2H goal average supports Over 1.5"
      );
    }

    if (
      candidate.market === "over25" &&
      h2h.averageGoals >= 3
    ) {
      bonus += 2;
      reasons.push(
        "H2H goal average supports Over 2.5"
      );
    }
  }

  return {
    bonus,
    reasons,
  };
}

function xgSignal(
  candidate,
  prediction
) {
  if (
    prediction.xgHome === null ||
    prediction.xgAway === null
  ) {
    return {
      bonus: 0,
      reasons: [],
    };
  }

  const total =
    prediction.xgHome +
    prediction.xgAway;

  let bonus = 0;
  const reasons = [];

  if (
    candidate.market === "home" &&
    prediction.xgHome >
      prediction.xgAway
  ) {
    bonus += 3;
    reasons.push(
      "xG favors home"
    );
  }

  if (
    candidate.market === "away" &&
    prediction.xgAway >
      prediction.xgHome
  ) {
    bonus += 3;
    reasons.push(
      "xG favors away"
    );
  }

  if (
    candidate.market === "over15" &&
    total >= 2.5
  ) {
    bonus += 3;
    reasons.push(
      "Combined xG supports Over 1.5"
    );
  }

  if (
    candidate.market === "over25" &&
    total >= 2.8
  ) {
    bonus += 3;
    reasons.push(
      "Combined xG supports Over 2.5"
    );
  }

  if (
    candidate.market === "over35" &&
    total >= 3.5
  ) {
    bonus += 3;
    reasons.push(
      "Very high combined xG"
    );
  }

  if (
    candidate.market === "bttsYes" &&
    prediction.xgHome >= 0.9 &&
    prediction.xgAway >= 0.9
  ) {
    bonus += 3;
    reasons.push(
      "xG supports both teams scoring"
    );
  }

  return {
    bonus,
    reasons,
  };
}

function formCandidateSignal(
  candidate,
  form
) {
  if (
    !form?.available
  ) {
    return {
      bonus: 0,
      reasons: [],
    };
  }

  let bonus = 0;
  const reasons = [];

  if (
    candidate.market === "home" &&
    form.score > 0
  ) {
    bonus += 2;
    reasons.push(
      "Recent form favors home"
    );
  }

  if (
    candidate.market === "away" &&
    form.score < 0
  ) {
    bonus += 2;
    reasons.push(
      "Recent form favors away"
    );
  }

  return {
    bonus,
    reasons,
  };
}

function statsCandidateSignal(
  candidate,
  stats
) {
  if (
    !stats?.available
  ) {
    return {
      bonus: 0,
      reasons: [],
    };
  }

  let bonus = 0;
  const reasons = [];

  if (
    candidate.market === "home" &&
    stats.score > 0
  ) {
    bonus += Math.min(
      2,
      stats.score
    );

    reasons.push(
      "Match statistics favor home"
    );
  }

  if (
    candidate.market === "away" &&
    stats.score < 0
  ) {
    bonus += Math.min(
      2,
      Math.abs(stats.score)
    );

    reasons.push(
      "Match statistics favor away"
    );
  }

  return {
    bonus,
    reasons,
  };
}

function candidateAnalysis(
  candidate,
  prediction,
  parsedOdds,
  h2h,
  form,
  stats,
  lineups,
  referee
) {
  const reasons = [];
  let score = candidate.probability;

  const value = valuePercent(
    candidate.probability,
    candidate.odds
  );

  const xg = xgSignal(
    candidate,
    prediction
  );

  const h2hResult = h2hSignal(
    candidate,
    h2h
  );

  const formResult =
    formCandidateSignal(
      candidate,
      form
    );

  const statsResult =
    statsCandidateSignal(
      candidate,
      stats
    );

  score += xg.bonus;
  score += h2hResult.bonus;
  score += formResult.bonus;
  score += statsResult.bonus;

  reasons.push(...xg.reasons);
  reasons.push(...h2hResult.reasons);
  reasons.push(...formResult.reasons);
  reasons.push(...statsResult.reasons);

  if (
    lineups?.available
  ) {
    score += 1;
    reasons.push(
      "Lineup data available"
    );
  }

  if (
    referee?.available
  ) {
    reasons.push(
      "Referee identified"
    );
  }

  const marketMove =
    marketMovement(
      parsedOdds,
      candidate.market
    );

  if (
    marketMove.available
  ) {
    if (
      marketMove.direction ===
      "SHORTENING"
    ) {
      score += 2;
      reasons.push(
        "Bookmaker odds shortening"
      );
    }

    if (
      marketMove.direction ===
      "DRIFTING"
    ) {
      score -= 2;
      reasons.push(
        "Bookmaker odds drifting"
      );
    }
  }

  if (
    value !== null
  ) {
    score += Math.max(
      -5,
      Math.min(
        5,
        value / 5
      )
    );
  }

  score = Math.max(
    0,
    Math.min(
      100,
      score
    )
  );

  const rejection = [];

  if (
    candidate.probability <
    CONFIG.minProbability
  ) {
    rejection.push(
      "PROBABILITY_LT_MIN"
    );
  }

  if (
    value === null
  ) {
    rejection.push(
      "VALUE_UNAVAILABLE"
    );
  } else if (
    value <
    CONFIG.minValuePercent
  ) {
    rejection.push(
      "VALUE_LT_MIN"
    );
  }

  if (
    score <
    CONFIG.minScore
  ) {
    rejection.push(
      "SCORE_LT_MIN"
    );
  }

  /*
   * Realism guard:
   * High odds require substantially
   * stronger model probability.
   */
  if (
    candidate.odds > 4 &&
    candidate.probability < 65
  ) {
    rejection.push(
      "REALISM_GUARD"
    );
  }

  /*
   * Do not select a weak 1X2 market
   * when the model itself cannot
   * clearly separate the outcomes.
   */
  if (
    ["home", "draw", "away"].includes(
      candidate.market
    )
  ) {
    const oneX2 = [
      prediction.home,
      prediction.draw,
      prediction.away,
    ]
      .filter(
        (v) => v !== null
      )
      .sort(
        (a, b) => b - a
      );

    if (
      oneX2.length >= 2 &&
      oneX2[0] -
        oneX2[1] <
        3 &&
      candidate.probability <
        60
    ) {
      rejection.push(
        "WEAK_1X2_SEPARATION"
      );
    }
  }

  /*
   * Do not blindly trust a very low
   * model confidence.
   */
  if (
    prediction.confidence !== null &&
    prediction.confidence < 35
  ) {
    rejection.push(
      "LOW_MODEL_CONFIDENCE"
    );
  }

  const accepted =
    rejection.length === 0;

  return {
    market:
      candidate.market,

    label:
      candidate.label,

    probability:
      candidate.probability,

    odds:
      candidate.odds,

    impliedProbability:
      impliedProbability(
        candidate.odds
      ),

    valuePercent:
      value === null
        ? null
        : Number(
            value.toFixed(2)
          ),

    score:
      Number(
        score.toFixed(2)
      ),

    accepted,

    rejectionReasons:
      rejection,

    movement:
      marketMove,

    reasons: [
      ...new Set(
        reasons
      ),
    ],
  };
}

function analyzeBundle(
  bundle
) {
  const prediction =
    parsePrediction(
      bundle.prediction
    );

  const parsedOdds =
    parseOdds(
      bundle.oddsRaw
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
      bundle.event
    );

  const candidates =
    buildCandidates(
      prediction,
      parsedOdds
    );

  const analyzed =
    candidates.map(
      (candidate) =>
        candidateAnalysis(
          candidate,
          prediction,
          parsedOdds,
          h2h,
          form,
          stats,
          lineups,
          referee
        )
    );

  analyzed.sort(
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

      return (
        (b.valuePercent ??
          -999) -
        (a.valuePercent ??
          -999)
      );
    }
  );

  const qualified =
    analyzed.filter(
      (x) => x.accepted
    );

  const rejected =
    analyzed.filter(
      (x) => !x.accepted
    );

  return {
    event:
      eventInfo(
        bundle.event
      ),

    eventId:
      bundle.id,

    prediction,
    odds: parsedOdds,
    h2h,
    form,
    stats,
    lineups,
    referee,

    exchange: {
      connected: false,
      status:
        "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
    },

    candidates:
      analyzed,

    qualified,

    rejected,

    coverage: {
      prediction:
        !!bundle.prediction,

      odds:
        !!bundle.oddsRaw,

      h2h:
        !!bundle.h2h,

      stats:
        stats.available,

      form:
        form.available,

      lineups:
        lineups.available,

      incidents:
        !!bundle.incidents,

      referee:
        referee.available,

      refereeStats: false,

      bookmakerMovement:
        analyzed.some(
          (x) =>
            x.movement
              ?.available
        ),

      exchangeMovement: false,
    },
  };
}

function addRejectionCounts(
  counts,
  rejected
) {
  for (
    const item of rejected
  ) {
    for (
      const reason of
        item.rejectionReasons || []
    ) {
      counts[reason] =
        (counts[reason] || 0) +
        1;
    }
  }
}

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      name:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE,
      status: "online",
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      name:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE,
      status: "online",
      timestamp:
        new Date().toISOString(),
    });
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const events =
        await getEvents(
          date
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        date,
        count:
          events.length,
        events,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id",
  async (req, res) => {
    try {
      const bundle =
        await getBundle({
          id: req.params.id,
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
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/prediction",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "prediction"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        prediction:
          parsePrediction(
            raw
          ),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/odds",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "odds"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        odds:
          parseOdds(raw),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/h2h",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "h2h"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        h2h:
          parseH2H(raw),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/stats",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "stats"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        stats:
          parseStats(raw),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/form",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "form"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        form:
          parseForm(raw),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/lineups",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "lineups"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        lineups:
          parseLineups(raw),
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/events/:id/incidents",
  async (req, res) => {
    try {
      const raw =
        await getResource(
          req.params.id,
          "incidents"
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        raw,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
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
      const bundle =
        await getBundle({
          id: req.params.id,
        });

      const result =
        analyzeBundle(
          bundle
        );

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
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const events =
        await getEvents(
          date
        );

      const qualified = [];
      const rejectionCounts = {};

      let analyzedEvents = 0;
      let analysisErrors = 0;

      for (
        const event of events
      ) {
        try {
          const bundle =
            await getBundle(
              event
            );

          const result =
            analyzeBundle(
              bundle
            );

          analyzedEvents++;

          addRejectionCounts(
            rejectionCounts,
            result.rejected
          );

          for (
            const pick of
              result.qualified
          ) {
            qualified.push({
              eventId:
                result.eventId,

              event:
                result.event,

              market:
                pick.market,

              label:
                pick.label,

              probability:
                pick.probability,

              odds:
                pick.odds,

              valuePercent:
                pick.valuePercent,

              score:
                pick.score,

              movement:
                pick.movement,

              reasons:
                pick.reasons,

              prediction:
                result.prediction,

              h2h:
                result.h2h,

              form:
                result.form,

              stats:
                result.stats,

              lineups:
                result.lineups,

              referee:
                result.referee,
            });
          }
        } catch (_) {
          analysisErrors++;
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

          return (
            (b.valuePercent ??
              -999) -
            (a.valuePercent ??
              -999)
          );
        }
      );

      const picks = [];
      const perEvent = {};

      for (
        const pick of
          qualified
      ) {
        const key =
          String(
            pick.eventId
          );

        if (
          (perEvent[key] ||
            0) >=
          CONFIG.maxPicksPerEvent
        ) {
          continue;
        }

        picks.push(
          pick
        );

        perEvent[key] =
          (perEvent[key] ||
            0) + 1;

        if (
          picks.length >=
          CONFIG.maxPicks
        ) {
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

          status:
            "EXCHANGE_UNAVAILABLE",

          reason:
            "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
        },

        filters: {
          minimumProbability:
            CONFIG.minProbability,

          minimumValuePercent:
            CONFIG.minValuePercent,

          minimumScore:
            CONFIG.minScore,

          maxPicks:
            CONFIG.maxPicks,

          maxPicksPerEvent:
            CONFIG.maxPicksPerEvent,
        },

        eventsScanned:
          events.length,

        eventsAnalyzed:
          analyzedEvents,

        analysisErrors,

        qualifiedPicks:
          qualified.length,

        picks,

        diagnostics: {
          rejectionCounts,
        },
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/coverage",
  (req, res) => {
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
        bookmakerMovement:
          "BSD-dependent",
        exchangeMovement: false,
      },

      exchange: {
        connected: false,
        status:
          "EXCHANGE_UNAVAILABLE",

        reason:
          "A verified betting-exchange feed is not connected.",
      },

      notes: [
        "BSD prediction markets are normalized from the actual nested BSD response.",
        "BSD odds are normalized from the actual nested BSD response.",
        "H2H recent_matches are supported.",
        "Bookmaker movement is used only when previous odds are supplied.",
        "No exchange movement is fabricated.",
        "Referee statistics are not claimed unless a verified feed is connected.",
      ],
    });
  }
);

app.get(
  "/api/events/:id/polymarket",
  async (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      eventId:
        req.params.id,

      connected: false,

      status:
        "EXCHANGE_UNAVAILABLE",

      reason:
        "This endpoint is not treated as a verified betting-exchange feed. No exchange signal is fabricated.",
    });
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      version: VERSION,
      error:
        "NOT_FOUND",
      path:
        req.originalUrl,
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
    );
  }
);
