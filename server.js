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

const VERSION = "6.0.1";
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

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  for (const key of [
    "results",
    "data",
    "items",
    "events",
    "matches",
  ]) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  return [];
}

function n(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : null;
}

function probability(value) {
  const v = n(value);

  if (v === null) {
    return null;
  }

  return v <= 1
    ? v * 100
    : v;
}

function odds(value) {
  const v = n(value);

  return v !== null && v > 1
    ? v
    : null;
}

function text(value, fallback = "") {
  return value === undefined ||
    value === null ||
    value === ""
    ? fallback
    : String(value);
}

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

/* =========================================================
   BSD REQUEST
========================================================= */

async function fetchJson(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error(
      "BSD_API_KEY is missing"
    );
  }

  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path}`;

  let lastError;

  for (
    let attempt = 0;
    attempt <= CONFIG.retries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer = setTimeout(
      () =>
        controller.abort(),
      CONFIG.requestTimeout
    );

    try {
      const response =
        await fetch(url, {
          ...options,

          signal:
            controller.signal,

          headers: {
            Accept:
              "application/json",

            Authorization:
              `Token ${BSD_API_KEY}`,

            ...(options.headers || {}),
          },
        });

      const bodyText =
        await response.text();

      let body;

      try {
        body = bodyText
          ? JSON.parse(bodyText)
          : {};
      } catch {
        body = {
          rawText:
            bodyText,
        };
      }

      if (!response.ok) {
        throw new Error(
          `BSD ${response.status} for ${path}`
        );
      }

      return body;
    } catch (error) {
      lastError = error;

      if (
        attempt <
        CONFIG.retries
      ) {
        await sleep(
          350 *
            (attempt + 1)
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ||
    new Error(
      `BSD request failed: ${path}`
    )
  );
}

/* =========================================================
   EVENTS
========================================================= */

async function getEvents(date) {
  const attempts = [
    `/events?date=${encodeURIComponent(
      date
    )}&page_size=100`,

    `/events?date=${encodeURIComponent(
      date
    )}&limit=100`,

    `/events?date=${encodeURIComponent(
      date
    )}`,
  ];

  let lastError;

  for (
    const path of attempts
  ) {
    try {
      const raw =
        await fetchJson(path);

      const events =
        asArray(raw);

      if (
        events.length ||
        raw
      ) {
        return events;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      "Unable to load events"
    )
  );
}

/* =========================================================
   RESOURCES
========================================================= */

async function getResource(
  id,
  resource
) {
  const paths = [
    `/events/${encodeURIComponent(
      id
    )}/${resource}`,

    `/event/${encodeURIComponent(
      id
    )}/${resource}`,

    `/${resource}/${encodeURIComponent(
      id
    )}`,
  ];

  let lastError;

  for (
    const path of paths
  ) {
    try {
      return await fetchJson(
        path
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      `Unable to load ${resource}`
    )
  );
}

/* =========================================================
   BUNDLE
========================================================= */

async function getBundle(event) {
  const id =
    event?.id ??
    event?.event_id ??
    event?.eventId;

  if (!id) {
    throw new Error(
      "Event id is missing"
    );
  }

  const resources = [
    "prediction",
    "odds",
    "h2h",
    "stats",
    "form",
    "lineups",
    "incidents",
  ];

  const results =
    await Promise.all(
      resources.map(
        async (resource) => {
          try {
            return [
              resource,
              await getResource(
                id,
                resource
              ),
            ];
          } catch {
            return [
              resource,
              null,
            ];
          }
        }
      )
    );

  const map =
    Object.fromEntries(
      results
    );

  return {
    id: String(id),
    event,
    prediction:
      map.prediction,
    oddsRaw:
      map.odds,
    h2h:
      map.h2h,
    stats:
      map.stats,
    form:
      map.form,
    lineups:
      map.lineups,
    incidents:
      map.incidents,
  };
}

/* =========================================================
   EVENT PARSER
========================================================= */

function eventInfo(event) {
  const source =
    event?.raw ||
    event?.data ||
    event ||
    {};

  const info =
    source.event ||
    source;

  return {
    home:
      info.home_team ||
      info.homeTeam ||
      info.home ||
      "Unknown",

    away:
      info.away_team ||
      info.awayTeam ||
      info.away ||
      "Unknown",

    date:
      info.event_date ||
      info.eventDate ||
      info.date ||
      null,

    league:
      info.league_name ||
      info.leagueName ||
      info.league ||
      "",
  };
}

/* =========================================================
   PREDICTION
========================================================= */

function parsePrediction(raw) {
  const root =
    raw?.prediction?.raw ||
    raw?.raw ||
    raw?.data ||
    raw ||
    {};

  const markets =
    root.markets ||
    root.prediction?.markets ||
    {};

  const match =
    markets.match_result ||
    markets.matchResult ||
    {};

  const expected =
    markets.expected_goals ||
    markets.expectedGoals ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    {};

  const btts =
    markets.btts ||
    {};

  const score =
    markets.score ||
    {};

  const model =
    root.model ||
    root.prediction?.model ||
    {};

  return {
    home:
      probability(
        match.prob_home ??
        match.home
      ),

    draw:
      probability(
        match.prob_draw ??
        match.draw
      ),

    away:
      probability(
        match.prob_away ??
        match.away
      ),

    over15:
      probability(
        overUnder.prob_over_15 ??
        overUnder.over15
      ),

    over25:
      probability(
        overUnder.prob_over_25 ??
        overUnder.over25
      ),

    over35:
      probability(
        overUnder.prob_over_35 ??
        overUnder.over35
      ),

    bttsYes:
      probability(
        btts.prob_yes ??
        btts.yes
      ),

    xgHome:
      n(expected.home),

    xgAway:
      n(expected.away),

    confidence:
      probability(
        model.confidence
      ),

    predicted:
      match.predicted ||
      null,

    mostLikelyScore:
      score.most_likely ||
      score.mostLikely ||
      null,

    raw:
      raw || null,
  };
}

/* =========================================================
   ODDS
========================================================= */

function parseOdds(raw) {
  const root =
    raw?.odds?.raw ||
    raw?.raw ||
    raw?.data ||
    raw ||
    {};

  const o =
    root.odds ||
    {};

  const previous =
    raw?.previous ||
    root.previous ||
    null;

  return {
    home:
      odds(
        o.home_win ??
        o.home
      ),

    draw:
      odds(
        o.draw
      ),

    away:
      odds(
        o.away_win ??
        o.away
      ),

    over15:
      odds(
        o.over_15_goals ??
        o.over15
      ),

    under15:
      odds(
        o.under_15_goals ??
        o.under15
      ),

    over25:
      odds(
        o.over_25_goals ??
        o.over25
      ),

    under25:
      odds(
        o.under_25_goals ??
        o.under25
      ),

    over35:
      odds(
        o.over_35_goals ??
        o.over35
      ),

    under35:
      odds(
        o.under_35_goals ??
        o.under35
      ),

    bttsYes:
      odds(
        o.btts_yes ??
        o.bttsYes
      ),

    bttsNo:
      odds(
        o.btts_no ??
        o.bttsNo
      ),

    previous,

    updatedAt:
      root.last_update_at ||
      root.updated_at ||
      null,

    raw:
      raw || null,
  };
}

/* =========================================================
   H2H
========================================================= */

function parseH2H(raw) {
  const root =
    raw?.h2h?.raw ||
    raw?.raw ||
    raw?.data ||
    raw ||
    {};

  const matches =
    root.recent_matches ||
    root.matches ||
    root.history ||
    [];

  return {
    sampleSize:
      n(
        root.total_matches ??
        root.sample_size
      ) ?? 0,

    homeWins:
      n(
        root.home_wins
      ) ?? 0,

    draws:
      n(
        root.draws
      ) ?? 0,

    awayWins:
      n(
        root.away_wins
      ) ?? 0,

    homeGoals:
      n(
        root.home_goals
      ) ?? 0,

    awayGoals:
      n(
        root.away_goals
      ) ?? 0,

    averageGoals:
      n(
        root.avg_total_goals ??
        root.average_goals
      ),

    matches:
      Array.isArray(matches)
        ? matches
        : [],

    raw:
      raw || null,
  };
}

/* =========================================================
   FORM
========================================================= */

function parseForm(raw) {
  const root =
    raw?.form?.raw ||
    raw?.raw ||
    raw?.data ||
    raw ||
    {};

  const home =
    asArray(
      root.home ||
      root.home_form ||
      root.homeForm
    );

  const away =
    asArray(
      root.away ||
      root.away_form ||
      root.awayForm
    );

  return {
    available:
      home.length > 0 ||
      away.length > 0,

    home,
    away,

    score:
      n(root.score) ??
      0,

    details:
      root.details ||
      null,

    raw:
      raw || null,
  };
}

/* =========================================================
   STATS
========================================================= */

function parseStats(raw) {
  const root =
    raw?.stats ||
    raw?.data?.stats ||
    raw?.result?.stats ||
    raw?.data ||
    raw ||
    {};

  const home =
    root.home ||
    root.home_stats ||
    {};

  const away =
    root.away ||
    root.away_stats ||
    {};

  const readMetric = (
    obj,
    keys
  ) => {
    for (
      const key of keys
    ) {
      const value =
        n(obj?.[key]);

      if (
        value !== null
      ) {
        return value;
      }
    }

    return null;
  };

  const metrics = [
    {
      name:
        "shotsOnTarget",

      keys: [
        "shots_on_target",
        "shotsOnTarget",
      ],
    },

    {
      name:
        "shots",

      keys: [
        "total_shots",
        "shots",
      ],
    },

    {
      name:
        "possession",

      keys: [
        "ball_possession",
        "possession",
      ],
    },

    {
      name:
        "corners",

      keys: [
        "corner_kicks",
        "corners",
      ],
    },

    {
      name:
        "fouls",

      keys: [
        "fouls",
      ],
    },

    {
      name:
        "yellowCards",

      keys: [
        "yellow_cards",
        "yellowCards",
      ],
    },
  ];

  const details = [];

  for (
    const metric of metrics
  ) {
    const homeValue =
      readMetric(
        home,
        metric.keys
      );

    const awayValue =
      readMetric(
        away,
        metric.keys
      );

    if (
      homeValue === null &&
      awayValue === null
    ) {
      continue;
    }

    let advantage =
      "EVEN";

    if (
      homeValue !== null &&
      awayValue !== null
    ) {
      if (
        homeValue >
        awayValue
      ) {
        advantage =
          "HOME";
      } else if (
        awayValue >
        homeValue
      ) {
        advantage =
          "AWAY";
      }
    }

    details.push({
      metric:
        metric.name,

      home:
        homeValue,

      away:
        awayValue,

      advantage,
    });
  }

  let score = 0;

  for (
    const item of details
  ) {
    if (
      item.advantage ===
      "HOME"
    ) {
      score += 1;
    }

    if (
      item.advantage ===
      "AWAY"
    ) {
      score -= 1;
    }
  }

  return {
    available:
      details.length > 0,

    score:
      Math.max(
        -8,
        Math.min(
          8,
          score
        )
      ),

    details,

    raw:
      raw || null,
  };
}

/* =========================================================
   LINEUPS
========================================================= */

function parseLineups(raw) {
  const root =
    raw?.lineups ||
    raw?.data?.lineups ||
    raw?.result?.lineups ||
    raw?.data ||
    raw ||
    {};

  const home =
    root.home?.players ||
    root.homePlayers ||
    root.home_lineup ||
    [];

  const away =
    root.away?.players ||
    root.awayPlayers ||
    root.away_lineup ||
    [];

  const homeCount =
    Array.isArray(home)
      ? home.length
      : 0;

  const awayCount =
    Array.isArray(away)
      ? away.length
      : 0;

  const status =
    raw?.lineup_status ||
    raw?.data?.lineup_status ||
    root.lineup_status ||
    null;

  let lineupStatus =
    "UNAVAILABLE";

  if (
    homeCount >= 11 &&
    awayCount >= 11
  ) {
    lineupStatus =
      String(status)
        .toLowerCase()
        .includes(
          "predicted"
        )
        ? "PREDICTED"
        : "CONFIRMED";
  } else if (
    homeCount > 0 ||
    awayCount > 0
  ) {
    lineupStatus =
      "PARTIAL";
  }

  return {
    available:
      homeCount >= 11 &&
      awayCount >= 11,

    status:
      lineupStatus,

    score:
      (homeCount >= 11
        ? 1
        : 0) +
      (awayCount >= 11
        ? 1
        : 0),

    details: {
      homePlayers:
        homeCount,

      awayPlayers:
        awayCount,

      completeHome:
        homeCount >= 11,

      completeAway:
        awayCount >= 11,
    },

    raw:
      raw || null,
  };
}

/* =========================================================
   REFEREE
========================================================= */

function parseReferee(event) {
  const source =
    event?.raw ||
    event?.data ||
    event ||
    {};

  const referee =
    source.referee ||
    source.referee_data ||
    null;

  const id =
    referee?.id ??
    source.referee_id ??
    null;

  const name =
    referee?.name ??
    referee?.full_name ??
    null;

  return {
    available:
      Boolean(
        id || name
      ),

    id,

    name,

    statsAvailable:
      false,

    score:
      id || name
        ? 1
        : 0,

    note:
      id || name
        ? "Referee identified; referee statistics unavailable."
        : "Referee data unavailable.",
  };
}

/* =========================================================
   MARKET MOVEMENT
========================================================= */

function previousMarketOdds(
  previous,
  market
) {
  if (!previous) {
    return null;
  }

  const root =
    previous?.odds ||
    previous?.raw?.odds ||
    previous?.data?.odds ||
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
    ],

    over25: [
      "over_25_goals",
      "over25",
    ],

    over35: [
      "over_35_goals",
      "over35",
    ],

    bttsYes: [
      "btts_yes",
      "bttsYes",
    ],
  };

  for (
    const key of
      aliases[market] ||
      []
  ) {
    const value =
      odds(
        root?.[key]
      );

    if (
      value !== null
    ) {
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
    previous <= 0
  ) {
    return {
      available:
        false,

      direction:
        "UNKNOWN",

      percent:
        null,
    };
  }

  const percent =
    ((current - previous) /
      previous) *
    100;

  let direction =
    "STABLE";

  if (
    percent <= -2
  ) {
    direction =
      "SHORTENING";
  } else if (
    percent >= 2
  ) {
    direction =
      "DRIFTING";
  }

  return {
    available:
      true,

    direction,

    percent:
      Number(
        percent.toFixed(2)
      ),
  };
}

function marketMovement(
  parsedOdds,
  market
) {
  const current =
    parsedOdds?.[
      market
    ] ?? null;

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

/* =========================================================
   VALUE
========================================================= */

function impliedProbability(
  odd
) {
  return odd &&
    odd > 0
    ? Number(
        (
          100 /
          odd
        ).toFixed(2)
      )
    : null;
}

function valuePercent(
  probabilityValue,
  odd
) {
  if (
    probabilityValue ===
      null ||
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

/* =========================================================
   CANDIDATES
========================================================= */

function buildCandidates(
  prediction,
  parsedOdds
) {
  const definitions = [
    [
      "home",
      "Home win",
      prediction.home,
      parsedOdds.home,
    ],

    [
      "draw",
      "Draw",
      prediction.draw,
      parsedOdds.draw,
    ],

    [
      "away",
      "Away win",
      prediction.away,
      parsedOdds.away,
    ],

    [
      "over15",
      "Over 1.5 goals",
      prediction.over15,
      parsedOdds.over15,
    ],

    [
      "over25",
      "Over 2.5 goals",
      prediction.over25,
      parsedOdds.over25,
    ],

    [
      "over35",
      "Over 3.5 goals",
      prediction.over35,
      parsedOdds.over35,
    ],

    [
      "bttsYes",
      "Both teams to score — Yes",
      prediction.bttsYes,
      parsedOdds.bttsYes,
    ],
  ];

  return definitions
    .filter(
      ([
        ,
        ,
        p,
        o,
      ]) =>
        p !== null &&
        o !== null
    )
    .map(
      ([
        market,
        label,
        p,
        o,
      ]) => ({
        market,
        label,
        probability:
          p,
        odds:
          o,
      })
    );
}

/* =========================================================
   H2H SIGNAL
========================================================= */

function h2hSignal(
  candidate,
  h2h
) {
  let bonus = 0;
  const reasons = [];

  if (
    !h2h?.sampleSize
  ) {
    return {
      bonus,
      reasons,
    };
  }

  const avg =
    h2h.averageGoals;

  if (
    (
      candidate.market ===
        "over15" ||
      candidate.market ===
        "over25"
    ) &&
    avg !== null
  ) {
    if (
      candidate.market ===
        "over15" &&
      avg >= 2.5
    ) {
      bonus += 2;

      reasons.push(
        "H2H goal average supports Over 1.5"
      );
    }

    if (
      candidate.market ===
        "over25" &&
      avg >= 3
    ) {
      bonus += 2;

      reasons.push(
        "H2H goal average supports Over 2.5"
      );
    }
  }

  if (
    candidate.market ===
      "home" &&
    h2h.homeWins >
      h2h.awayWins
  ) {
    bonus += 2;

    reasons.push(
      "H2H favors home"
    );
  }

  if (
    candidate.market ===
      "away" &&
    h2h.awayWins >
      h2h.homeWins
  ) {
    bonus += 2;

    reasons.push(
      "H2H strongly favors away"
    );
  }

  return {
    bonus,
    reasons,
  };
}

/* =========================================================
   XG SIGNAL
========================================================= */

function xgSignal(
  candidate,
  prediction
) {
  let bonus = 0;
  const reasons = [];

  const home =
    prediction.xgHome;

  const away =
    prediction.xgAway;

  if (
    home === null ||
    away === null
  ) {
    return {
      bonus,
      reasons,
    };
  }

  const total =
    home + away;

  if (
    candidate.market ===
      "home" &&
    home - away >=
      0.4
  ) {
    bonus += 3;

    reasons.push(
      "xG favors home"
    );
  }

  if (
    candidate.market ===
      "away" &&
    away - home >=
      0.4
  ) {
    bonus += 3;

    reasons.push(
      "xG favors away"
    );
  }

  if (
    candidate.market ===
      "over15" &&
    total >= 2.5
  ) {
    bonus += 2;

    reasons.push(
      "Combined xG supports Over 1.5"
    );
  }

  if (
    candidate.market ===
      "over25" &&
    total >= 3
  ) {
    bonus += 2;

    reasons.push(
      "Combined xG supports Over 2.5"
    );
  }

  if (
    candidate.market ===
      "over35" &&
    total >= 3.5
  ) {
    bonus += 3;

    reasons.push(
      "Very high combined xG"
    );
  }

  if (
    candidate.market ===
      "bttsYes" &&
    home >= 1 &&
    away >= 1
  ) {
    bonus += 2;

    reasons.push(
      "xG supports both teams scoring"
    );
  }

  return {
    bonus,
    reasons,
  };
}

/* =========================================================
   FORM SIGNAL
========================================================= */

function formCandidateSignal(
  candidate,
  form
) {
  let bonus = 0;
  const reasons = [];

  if (
    !form?.available
  ) {
    return {
      bonus,
      reasons,
    };
  }

  if (
    candidate.market ===
      "home" &&
    form.score > 0
  ) {
    bonus += 2;

    reasons.push(
      "Recent form supports home"
    );
  }

  if (
    candidate.market ===
      "away" &&
    form.score < 0
  ) {
    bonus += 2;

    reasons.push(
      "Recent form supports away"
    );
  }

  return {
    bonus,
    reasons,
  };
}

/* =========================================================
   STATS SIGNAL
========================================================= */

function statsCandidateSignal(
  candidate,
  stats
) {
  let bonus = 0;
  const reasons = [];

  if (
    !stats?.available
  ) {
    return {
      bonus,
      reasons,
    };
  }

  if (
    candidate.market ===
      "home" &&
    stats.score > 0
  ) {
    bonus += 2;

    reasons.push(
      "Match statistics support home"
    );
  }

  if (
    candidate.market ===
      "away" &&
    stats.score < 0
  ) {
    bonus += 2;

    reasons.push(
      "Match statistics support away"
    );
  }

  return {
    bonus,
    reasons,
  };
}

/* =========================================================
   CANDIDATE ANALYSIS
========================================================= */

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

  let score =
    candidate.probability;

  const value =
    valuePercent(
      candidate.probability,
      candidate.odds
    );

  const xg =
    xgSignal(
      candidate,
      prediction
    );

  const h2hResult =
    h2hSignal(
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

  score +=
    xg.bonus +
    h2hResult.bonus +
    formResult.bonus +
    statsResult.bonus;

  reasons.push(
    ...xg.reasons,
    ...h2hResult.reasons,
    ...formResult.reasons,
    ...statsResult.reasons
  );

  if (
    lineups.status ===
    "CONFIRMED"
  ) {
    score += 2;

    reasons.push(
      "Confirmed lineups available"
    );
  } else if (
    lineups.status ===
    "PREDICTED"
  ) {
    score += 1;

    reasons.push(
      "Predicted lineups available"
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

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  /*
   * HIGH PROBABILITY
   */

  const highProbability =
    candidate.probability >=
      60 &&
    score >= 58 &&
    value !== null &&
    value >= -3;

  /*
   * VALUE
   */

  const valuePick =
    value !== null &&
    value >= 5 &&
    candidate.probability >=
      35 &&
    score >= 55;

  /*
   * REALISM GUARD
   */

  const unrealistic =
    candidate.odds > 4 &&
    candidate.probability <
      65;

  /*
   * 1X2 SEPARATION
   */

  let weak1X2 =
    false;

  if (
    [
      "home",
      "draw",
      "away",
    ].includes(
      candidate.market
    )
  ) {
    const probabilities =
      [
        prediction.home,
        prediction.draw,
        prediction.away,
      ]
        .filter(
          (v) =>
            v !== null
        )
        .sort(
          (a, b) =>
            b - a
        );

    if (
      probabilities.length >=
        2 &&
      probabilities[0] -
        probabilities[1] <
        3 &&
      candidate.probability <
        60
    ) {
      weak1X2 =
        true;
    }
  }

  const rejection = [];

  if (
    unrealistic
  ) {
    rejection.push(
      "REALISM_GUARD"
    );
  }

  if (
    weak1X2
  ) {
    rejection.push(
      "WEAK_1X2_SEPARATION"
    );
  }

  if (
    prediction.confidence !==
      null &&
    prediction.confidence <
      30
  ) {
    rejection.push(
      "LOW_MODEL_CONFIDENCE"
    );
  }

  if (
    !highProbability &&
    !valuePick
  ) {
    if (
      candidate.probability <
      60
    ) {
      rejection.push(
        "NOT_HIGH_PROBABILITY"
      );
    }

    if (
      value === null
    ) {
      rejection.push(
        "VALUE_UNAVAILABLE"
      );
    } else if (
      value < 5
    ) {
      rejection.push(
        "VALUE_BELOW_5_PERCENT"
      );
    }

    if (
      score < 55
    ) {
      rejection.push(
        "SCORE_LT_55"
      );
    }
  }

  const accepted =
    rejection.length === 0 &&
    (
      highProbability ||
      valuePick
    );

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

    type:
      highProbability
        ? "HIGH_PROBABILITY"
        : valuePick
        ? "VALUE"
        : "REJECTED",

    accepted,

    rejectionReasons:
      [
        ...new Set(
          rejection
        ),
      ],

    movement:
      marketMove,

    reasons:
      [
        ...new Set(
          reasons
        ),
      ],
  };
}

/* =========================================================
   COMPLETE ANALYSIS
========================================================= */

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
    (a, b) =>
      b.score -
        a.score ||
      (
        b.valuePercent ??
        -999
      ) -
      (
        a.valuePercent ??
        -999
      )
  );

  const qualified =
    analyzed.filter(
      (x) =>
        x.accepted
    );

  const rejected =
    analyzed.filter(
      (x) =>
        !x.accepted
    );

  return {
    event:
      eventInfo(
        bundle.event
      ),

    eventId:
      bundle.id,

    prediction,

    odds:
      parsedOdds,

    h2h,

    form,

    stats,

    lineups,

    referee,

    exchange: {
      connected:
        false,

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

      refereeStats:
        false,

      bookmakerMovement:
        analyzed.some(
          (x) =>
            x.movement
              ?.available
        ),

      exchangeMovement:
        false,
    },
  };
}

/* =========================================================
   DIAGNOSTICS
========================================================= */

function addRejectionCounts(
  counts,
  rejected
) {
  for (
    const item of
      rejected || []
  ) {
    for (
      const reason of
        item.rejectionReasons ||
        []
    ) {
      counts[reason] =
        (
          counts[reason] ||
          0
        ) + 1;
    }
  }
}

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok:
        true,

      name:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      status:
        "online",
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
      ok:
        true,

      name:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      status:
        "online",

      timestamp:
        new Date().toISOString(),
    });
  }
);

/* =========================================================
   EVENTS
========================================================= */

app.get(
  "/api/events",
  async (
    req,
    res
  ) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(
            0,
            10
          );

      const events =
        await getEvents(
          date
        );

      res.json({
        ok:
          true,

        version:
          VERSION,

        source:
          SOURCE,

        date,

        count:
          events.length,

        events,
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        ok:
          false,

        version:
          VERSION,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   LIVE EVENTS
========================================================= */

app.get(
  "/api/events/live",
  async (
    req,
    res
  ) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(
            0,
            10
          );

      const events =
        await getEvents(
          date
        );

      const live =
        events.filter(
          (event) => {
            const status =
              String(
                event.status ||
                event.event_status ||
                event?.event
                  ?.status ||
                ""
              ).toLowerCase();

            return [
              "live",
              "inplay",
              "in_play",
              "started",
              "1h",
              "2h",
              "ht",
            ].includes(
              status
            );
          }
        );

      res.json({
        ok:
          true,

        version:
          VERSION,

        source:
          SOURCE,

        date,

        count:
          live.length,

        events:
          live,
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        ok:
          false,

        version:
          VERSION,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   SINGLE EVENT
========================================================= */

app.get(
  "/api/events/:id",
  async (
    req,
    res
  ) => {
    try {
      const bundle =
        await getBundle({
          id:
            req.params.id,
        });

      res.json({
        ok:
          true,

        version:
          VERSION,

        source:
          SOURCE,

        ...bundle,
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        ok:
          false,

        version:
          VERSION,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   RESOURCE ROUTES
========================================================= */

const resourceRoutes = [
  "prediction",
  "odds",
  "h2h",
  "stats",
  "form",
  "lineups",
  "incidents",
];

for (
  const resource of
    resourceRoutes
) {
  app.get(
    `/api/events/:id/${resource}`,
    async (
      req,
      res
    ) => {
      try {
        const raw =
          await getResource(
            req.params.id,
            resource
          );

        let parsed =
          raw;

        if (
          resource ===
          "prediction"
        ) {
          parsed =
            parsePrediction(
              raw
            );
        }

        if (
          resource ===
          "odds"
        ) {
          parsed =
            parseOdds(
              raw
            );
        }

        if (
          resource ===
          "h2h"
        ) {
          parsed =
            parseH2H(
              raw
            );
        }

        if (
          resource ===
          "stats"
        ) {
          parsed =
            parseStats(
              raw
            );
        }

        if (
          resource ===
          "form"
        ) {
          parsed =
            parseForm(
              raw
            );
        }

        if (
          resource ===
          "lineups"
        ) {
          parsed =
            parseLineups(
              raw
            );
        }

        res.json({
          ok:
            true,

          version:
            VERSION,

          source:
            SOURCE,

          eventId:
            req.params.id,

          [resource]:
            parsed,

          raw,
        });
      } catch (
        error
      ) {
        res.status(
          500
        ).json({
          ok:
            false,

          version:
            VERSION,

          error:
            error.message,
        });
      }
    }
  );
}

/* =========================================================
   ANALYZE
========================================================= */

app.get(
  "/api/analyze/:id",
  async (
    req,
    res
  ) => {
    try {
      const bundle =
        await getBundle({
          id:
            req.params.id,
        });

      res.json({
        ok:
          true,

        version:
          VERSION,

        source:
          SOURCE,

        ...analyzeBundle(
          bundle
        ),
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        ok:
          false,

        version:
          VERSION,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   TOP PICKS
========================================================= */

app.get(
  "/api/top-picks",
  async (
    req,
    res
  ) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(
            0,
            10
          );

      const events =
        await getEvents(
          date
        );

      const qualified =
        [];

      const rejectionCounts =
        {};

      let analyzedEvents =
        0;

      let analysisErrors =
        0;

      for (
        const event of
          events
      ) {
        try {
          const result =
            analyzeBundle(
              await getBundle(
                event
              )
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

              type:
                pick.type,

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
        } catch {
          analysisErrors++;
        }
      }

      qualified.sort(
        (a, b) =>
          b.score -
            a.score ||
          (
            b.valuePercent ??
            -999
          ) -
          (
            a.valuePercent ??
            -999
          )
      );

      const picks =
        [];

      const perEvent =
        {};

      for (
        const pick of
          qualified
      ) {
        const key =
          String(
            pick.eventId
          );

        if (
          (
            perEvent[key] ||
            0
          ) >=
          CONFIG.maxPicksPerEvent
        ) {
          continue;
        }

        picks.push(
          pick
        );

        perEvent[key] =
          (
            perEvent[key] ||
            0
          ) + 1;

        if (
          picks.length >=
          CONFIG.maxPicks
        ) {
          break;
        }
      }

      res.json({
        ok:
          true,

        version:
          VERSION,

        source:
          SOURCE,

        date,

        exchange: {
          connected:
            false,

          status:
            "EXCHANGE_UNAVAILABLE",

          reason:
            "No verified betting-exchange feed is connected. No exchange signal is fabricated.",
        },

        filters:
          CONFIG,

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
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        ok:
          false,

        version:
          VERSION,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   COVERAGE
========================================================= */

app.get(
  "/api/coverage",
  (req, res) => {
    res.json({
      ok:
        true,

      version:
        VERSION,

      source:
        SOURCE,

      available: {
        events:
          true,

        prediction:
          true,

        odds:
          true,

        h2h:
          true,

        stats:
          true,

        form:
          true,

        lineups:
          true,

        incidents:
          true,

        refereeIdentification:
          true,

        refereeStats:
          false,

        bookmakerMovement:
          "BSD-dependent",

        exchangeMovement:
          false,
      },

      exchange: {
        connected:
          false,

        status:
          "EXCHANGE_UNAVAILABLE",

        reason:
          "A verified betting-exchange feed is not connected.",
      },
    });
  }
);

/* =========================================================
   POLYMARKET / EXCHANGE STATUS
========================================================= */

app.get(
  "/api/events/:id/polymarket",
  (
    req,
    res
  ) => {
    res.json({
      ok:
        true,

      version:
        VERSION,

      source:
        SOURCE,

      eventId:
        req.params.id,

      connected:
        false,

      status:
        "EXCHANGE_UNAVAILABLE",

      reason:
        "This endpoint is not treated as a verified betting-exchange feed. No exchange signal is fabricated.",
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (
    req,
    res
  ) => {
    res.status(
      404
    ).json({
      ok:
        false,

      version:
        VERSION,

      error:
        "NOT_FOUND",

      path:
        req.originalUrl,
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
      `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
    );
  }
);
