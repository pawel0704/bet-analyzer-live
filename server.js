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
const BSD_PUBLIC = "https://sports.bzzoiro.com/api";

const VERSION = "7.0.2";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

const MIN_PROBABILITY = 0.60;
const MIN_CONFIDENCE = 0.55;

const MIN_ODDS = 1.05;
const MAX_ODDS = 12.00;

const REQUEST_TIMEOUT_MS = 10000;

const exchange = {
  connected: false,
  status: "NOT_CONNECTED",
  message:
    "Betting exchange data is not connected. No exchange movement is fabricated."
};

// ======================================================
// BASIC
// ======================================================

function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function normalizeProbability(value) {
  const n = safeNumber(value);

  if (n === null) {
    return null;
  }

  if (n > 1) {
    return Math.min(
      Math.max(n / 100, 0),
      1
    );
  }

  return Math.min(
    Math.max(n, 0),
    1
  );
}

function validOdds(value) {
  const n = safeNumber(value);

  return (
    n !== null &&
    n >= MIN_ODDS &&
    n <= MAX_ODDS
  );
}

function fairOdds(probability) {
  if (
    probability === null ||
    probability <= 0
  ) {
    return null;
  }

  return Number(
    (1 / probability).toFixed(3)
  );
}

function todayUTC() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}

// ======================================================
// HTTP
// ======================================================

function buildHeaders() {
  const headers = {
    Accept: "application/json"
  };

  if (BSD_API_KEY) {
    headers.Authorization =
      `Token ${BSD_API_KEY}`;
  }

  return headers;
}

async function fetchJson(url) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () =>
      controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response =
      await fetch(url, {
        method: "GET",
        headers: buildHeaders(),
        signal:
          controller.signal
      });

    const text =
      await response.text();

    let data = null;

    try {
      data = text
        ? JSON.parse(text)
        : null;
    } catch {
      data = {
        raw: text
      };
    }

    return {
      ok: response.ok,
      status:
        response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error:
        error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// GENERIC
// ======================================================

function getResults(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (
    Array.isArray(
      data.results
    )
  ) {
    return data.results;
  }

  if (
    Array.isArray(data.data)
  ) {
    return data.data;
  }

  if (
    Array.isArray(
      data.predictions
    )
  ) {
    return data.predictions;
  }

  if (
    Array.isArray(data.events)
  ) {
    return data.events;
  }

  return [];
}

function getCount(data) {
  return safeNumber(
    data?.count
  );
}

// ======================================================
// EVENT
// ======================================================

function eventIdOf(item) {
  return firstValue(
    item?.event_id,
    item?.eventId,
    item?.match_id,
    item?.matchId,
    item?.event?.id,
    item?.match?.id,
    item?.id
  );
}

function homeName(item) {
  return firstValue(
    item?.home_team,
    item?.home_team_name,
    item?.homeTeam,
    item?.teams?.home?.name,
    item?.home?.name,
    item?.event?.home_team,
    item?.event?.home_team_name,
    item?.event?.teams?.home?.name,
    item?.match?.home_team,
    "Home"
  );
}

function awayName(item) {
  return firstValue(
    item?.away_team,
    item?.away_team_name,
    item?.awayTeam,
    item?.teams?.away?.name,
    item?.away?.name,
    item?.event?.away_team,
    item?.event?.away_team_name,
    item?.event?.teams?.away?.name,
    item?.match?.away_team,
    "Away"
  );
}

function eventDateOf(item) {
  return firstValue(
    item?.event_date,
    item?.eventDate,
    item?.match_date,
    item?.matchDate,
    item?.start_time,
    item?.startTime,
    item?.kickoff,
    item?.event?.event_date,
    item?.event?.eventDate,
    item?.event?.date,
    item?.event?.start_time,
    item?.event?.startTime,
    item?.match?.event_date,
    item?.match?.eventDate,
    item?.match?.date,
    item?.date
  );
}

function leagueNameOf(item) {
  return firstValue(
    item?.league_name,
    item?.leagueName,
    item?.league?.name,
    item?.competition?.name,
    item?.tournament?.name,
    item?.event?.league?.name,
    item?.match?.league?.name
  );
}

function dateMatches(
  item,
  targetDate
) {
  const raw =
    eventDateOf(item);

  if (!raw) {
    return false;
  }

  const d =
    new Date(raw);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return false;
  }

  return (
    d.toISOString()
      .slice(0, 10) ===
    targetDate
  );
}

function filterPredictionsByDate(
  predictions,
  date
) {
  return predictions.filter(
    item =>
      dateMatches(
        item,
        date
      )
  );
}

// ======================================================
// PROBABILITIES
// ======================================================

function getProbabilitySources(
  item
) {
  return [
    item?.probabilities,
    item?.probability,
    item?.prediction?.probabilities,
    item?.prediction?.probability,
    item?.prediction,
    item?.forecast,
    item
  ].filter(Boolean);
}

function readProbability(
  sources,
  keys
) {
  for (
    const source
    of sources
  ) {
    for (
      const key
      of keys
    ) {
      const probability =
        normalizeProbability(
          source?.[key]
        );

      if (
        probability !== null
      ) {
        return probability;
      }
    }
  }

  return null;
}

function getProbabilities(
  item
) {
  const sources =
    getProbabilitySources(
      item
    );

  return {
    home:
      readProbability(
        sources,
        [
          "home",
          "home_win",
          "homeWin",
          "home_probability",
          "prob_home",
          "probability_home",
          "1"
        ]
      ),

    draw:
      readProbability(
        sources,
        [
          "draw",
          "draw_probability",
          "prob_draw",
          "probability_draw",
          "x",
          "X"
        ]
      ),

    away:
      readProbability(
        sources,
        [
          "away",
          "away_win",
          "awayWin",
          "away_probability",
          "prob_away",
          "probability_away",
          "2"
        ]
      ),

    over15:
      readProbability(
        sources,
        [
          "over_15",
          "over15",
          "over1_5",
          "over_1_5",
          "prob_over_15",
          "probability_over_15"
        ]
      ),

    under15:
      readProbability(
        sources,
        [
          "under_15",
          "under15",
          "under1_5",
          "under_1_5",
          "prob_under_15",
          "probability_under_15"
        ]
      ),

    over25:
      readProbability(
        sources,
        [
          "over_25",
          "over25",
          "over2_5",
          "over_2_5",
          "prob_over_25",
          "probability_over_25"
        ]
      ),

    under25:
      readProbability(
        sources,
        [
          "under_25",
          "under25",
          "under2_5",
          "under_2_5",
          "prob_under_25",
          "probability_under_25"
        ]
      ),

    over35:
      readProbability(
        sources,
        [
          "over_35",
          "over35",
          "over3_5",
          "over_3_5",
          "prob_over_35",
          "probability_over_35"
        ]
      ),

    under35:
      readProbability(
        sources,
        [
          "under_35",
          "under35",
          "under3_5",
          "under_3_5",
          "prob_under_35",
          "probability_under_35"
        ]
      ),

    bttsYes:
      readProbability(
        sources,
        [
          "btts_yes",
          "bttsYes",
          "BTTS_yes",
          "btts_yes_probability",
          "prob_btts_yes"
        ]
      ),

    bttsNo:
      readProbability(
        sources,
        [
          "btts_no",
          "bttsNo",
          "BTTS_no",
          "btts_no_probability",
          "prob_btts_no"
        ]
      )
  };
}

function getConfidence(
  item
) {
  return normalizeProbability(
    firstValue(
      item?.confidence,
      item?.model_confidence,
      item?.prediction?.confidence,
      item?.prediction?.model_confidence,
      item?.forecast?.confidence
    )
  );
}

// ======================================================
// PREDICTION ODDS
// ======================================================

function getOdds(item) {
  const odds =
    firstValue(
      item?.odds,
      item?.prediction?.odds,
      item?.forecast?.odds
    ) || {};

  return {
    home:
      safeNumber(
        firstValue(
          item?.odds_home,
          item?.oddsHome,
          odds?.home,
          odds?.odds_home,
          odds?.match_winner?.home
        )
      ),

    draw:
      safeNumber(
        firstValue(
          item?.odds_draw,
          item?.oddsDraw,
          odds?.draw,
          odds?.odds_draw,
          odds?.match_winner?.draw
        )
      ),

    away:
      safeNumber(
        firstValue(
          item?.odds_away,
          item?.oddsAway,
          odds?.away,
          odds?.odds_away,
          odds?.match_winner?.away
        )
      ),

    over15:
      safeNumber(
        firstValue(
          item?.odds_over_15,
          item?.oddsOver15,
          odds?.over_15,
          odds?.over15,
          odds?.over_under?.over_15
        )
      ),

    under15:
      safeNumber(
        firstValue(
          item?.odds_under_15,
          item?.oddsUnder15,
          odds?.under_15,
          odds?.under15,
          odds?.over_under?.under_15
        )
      ),

    over25:
      safeNumber(
        firstValue(
          item?.odds_over_25,
          item?.oddsOver25,
          odds?.over_25,
          odds?.over25,
          odds?.over_under?.over_25
        )
      ),

    under25:
      safeNumber(
        firstValue(
          item?.odds_under_25,
          item?.oddsUnder25,
          odds?.under_25,
          odds?.under25,
          odds?.over_under?.under_25
        )
      ),

    over35:
      safeNumber(
        firstValue(
          item?.odds_over_35,
          item?.oddsOver35,
          odds?.over_35,
          odds?.over35,
          odds?.over_under?.over_35
        )
      ),

    under35:
      safeNumber(
        firstValue(
          item?.odds_under_35,
          item?.oddsUnder35,
          odds?.under_35,
          odds?.under35,
          odds?.over_under?.under_35
        )
      ),

    bttsYes:
      safeNumber(
        firstValue(
          item?.odds_btts_yes,
          item?.oddsBttsYes,
          odds?.btts_yes,
          odds?.btts?.yes
        )
      ),

    bttsNo:
      safeNumber(
        firstValue(
          item?.odds_btts_no,
          item?.oddsBttsNo,
          odds?.btts_no,
          odds?.btts?.no
        )
      )
  };
}

// ======================================================
// RECOMMENDATION
// ======================================================

function recursiveStrings(
  value,
  output = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (
    typeof value ===
    "string"
  ) {
    output.push(value);
    return output;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item
      of value
    ) {
      recursiveStrings(
        item,
        output
      );
    }

    return output;
  }

  if (
    typeof value ===
    "object"
  ) {
    for (
      const item
      of Object.values(value)
    ) {
      recursiveStrings(
        item,
        output
      );
    }
  }

  return output;
}

function getRecommendationText(
  item
) {
  return recursiveStrings(
    [
      item?.recommendation,
      item?.recommendations,
      item?.prediction?.recommendation,
      item?.prediction?.recommendations,
      item?.tip,
      item?.call,
      item?.pick
    ]
  )
    .join(" | ")
    .trim();
}

function getRecommendationFlags(
  item
) {
  const text =
    getRecommendationText(
      item
    ).toLowerCase();

  return {
    home:
      text.includes("1x") ||
      text.includes("home") ||
      text.includes("win or draw") ||
      text.includes("avoid defeat"),

    away:
      text.includes("x2") ||
      text.includes("away"),

    over15:
      text.includes("over 1.5") ||
      text.includes("over1.5") ||
      text.includes("over_15"),

    over25:
      text.includes("over 2.5") ||
      text.includes("over2.5") ||
      text.includes("over_25"),

    under25:
      text.includes("under 2.5") ||
      text.includes("under2.5") ||
      text.includes("under_25"),

    under35:
      text.includes("under 3.5") ||
      text.includes("under3.5") ||
      text.includes("under_35"),

    btts:
      text.includes("btts") ||
      text.includes(
        "both teams to score"
      )
  };
}

// ======================================================
// MARKETS
// ======================================================

const MARKETS = [
  {
    key: "1X",
    market: "DOUBLE_CHANCE",
    pick: "1X",
    probability: p =>
      p.home !== null &&
      p.draw !== null
        ? p.home + p.draw
        : null,
    odds: () => null
  },

  {
    key: "X2",
    market: "DOUBLE_CHANCE",
    pick: "X2",
    probability: p =>
      p.away !== null &&
      p.draw !== null
        ? p.away + p.draw
        : null,
    odds: () => null
  },

  {
    key: "HOME",
    market: "1X2",
    pick: "1",
    probability: p =>
      p.home,
    odds: o =>
      o.home
  },

  {
    key: "DRAW",
    market: "1X2",
    pick: "X",
    probability: p =>
      p.draw,
    odds: o =>
      o.draw
  },

  {
    key: "AWAY",
    market: "1X2",
    pick: "2",
    probability: p =>
      p.away,
    odds: o =>
      o.away
  },

  {
    key: "OVER15",
    market: "TOTAL",
    pick: "OVER 1.5",
    probability: p =>
      p.over15,
    odds: o =>
      o.over15
  },

  {
    key: "UNDER15",
    market: "TOTAL",
    pick: "UNDER 1.5",
    probability: p =>
      p.under15,
    odds: o =>
      o.under15
  },

  {
    key: "OVER25",
    market: "TOTAL",
    pick: "OVER 2.5",
    probability: p =>
      p.over25,
    odds: o =>
      o.over25
  },

  {
    key: "UNDER25",
    market: "TOTAL",
    pick: "UNDER 2.5",
    probability: p =>
      p.under25,
    odds: o =>
      o.under25
  },

  {
    key: "OVER35",
    market: "TOTAL",
    pick: "OVER 3.5",
    probability: p =>
      p.over35,
    odds: o =>
      o.over35
  },

  {
    key: "UNDER35",
    market: "TOTAL",
    pick: "UNDER 3.5",
    probability: p =>
      p.under35,
    odds: o =>
      o.under35
  },

  {
    key: "BTTS_YES",
    market: "BTTS",
    pick: "BTTS YES",
    probability: p =>
      p.bttsYes,
    odds: o =>
      o.bttsYes
  },

  {
    key: "BTTS_NO",
    market: "BTTS",
    pick: "BTTS NO",
    probability: p =>
      p.bttsNo,
    odds: o =>
      o.bttsNo
  }
];

// ======================================================
// CANDIDATE
// ======================================================

function makeCandidate(
  item,
  definition
) {
  const probabilities =
    getProbabilities(item);

  const odds =
    getOdds(item);

  const probability =
    definition.probability(
      probabilities
    );

  if (
    probability === null ||
    probability <
      MIN_PROBABILITY
  ) {
    return null;
  }

  const rawOdds =
    definition.odds(
      odds
    );

  const actualOdds =
    validOdds(rawOdds)
      ? rawOdds
      : null;

  const confidence =
    getConfidence(item);

  const flags =
    getRecommendationFlags(
      item
    );

  let recommendationStrength = 0;

  if (
    (
      definition.key === "HOME" ||
      definition.key === "1X"
    ) &&
    flags.home
  ) {
    recommendationStrength = 1;
  }

  if (
    (
      definition.key === "AWAY" ||
      definition.key === "X2"
    ) &&
    flags.away
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key ===
      "OVER15" &&
    flags.over15
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key ===
      "OVER25" &&
    flags.over25
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key ===
      "UNDER25" &&
    flags.under25
  ) {
    recommendationStrength = 1;
  }

  if (
    definition.key ===
      "UNDER35" &&
    flags.under35
  ) {
    recommendationStrength = 1;
  }

  if (
    (
      definition.key ===
        "BTTS_YES" ||
      definition.key ===
        "BTTS_NO"
    ) &&
    flags.btts
  ) {
    recommendationStrength = 1;
  }

  const value =
    actualOdds !== null
      ? Number(
          (
            probability *
              actualOdds -
            1
          ).toFixed(4)
        )
      : null;

  return {
    eventId:
      eventIdOf(item),

    event:
      `${homeName(item)} – ${awayName(item)}`,

    home:
      homeName(item),

    away:
      awayName(item),

    date:
      eventDateOf(item),

    league:
      leagueNameOf(item),

    market:
      definition.market,

    pick:
      definition.pick,

    marketKey:
      definition.key,

    probability:
      Number(
        (
          probability * 100
        ).toFixed(1)
      ),

    confidence:
      confidence !== null
        ? Number(
            (
              confidence * 100
            ).toFixed(1)
          )
        : null,

    odds:
      actualOdds,

    fairOdds:
      fairOdds(
        probability
      ),

    value,

    recommendationStrength,

    bsdRecommendation:
      getRecommendationText(
        item
      ) || null,

    score: 0,

    oddsSource:
      actualOdds !== null
        ? "BSD_PREDICTION"
        : "UNAVAILABLE",

    marketMovement:
      null,

    exchangeMovement:
      null,

    bookmaker:
      null
  };
}

function generateCandidates(
  item
) {
  const candidates = [];

  for (
    const definition
    of MARKETS
  ) {
    const candidate =
      makeCandidate(
        item,
        definition
      );

    if (candidate) {
      candidates.push(
        candidate
      );
    }
  }

  return candidates;
}

// ======================================================
// PREDICTIONS
// ======================================================

async function fetchAllPredictions() {
  const all = [];

  const limit = 200;

  let offset = 0;

  let total = null;

  while (true) {
    const url =
      `${BSD_PUBLIC}/predictions/` +
      `?limit=${limit}` +
      `&offset=${offset}`;

    const response =
      await fetchJson(
        url
      );

    if (!response.ok) {
      throw new Error(
        `BSD predictions HTTP ${response.status}`
      );
    }

    const results =
      getResults(
        response.data
      );

    if (
      total === null
    ) {
      total =
        getCount(
          response.data
        );
    }

    all.push(
      ...results
    );

    if (
      results.length <
      limit
    ) {
      break;
    }

    offset += limit;

    if (
      total !== null &&
      all.length >=
        total
    ) {
      break;
    }

    if (
      offset > 5000
    ) {
      break;
    }
  }

  return {
    total:
      total ??
      all.length,

    results:
      all
  };
}

// ======================================================
// ODDS API
// ======================================================

async function fetchOdds(
  eventId
) {
  if (!eventId) {
    return {
      ok: false,
      status: 0,
      data: null,
      source: null
    };
  }

  /*
   * BSD exposes odds as a separate API family.
   *
   * We try the authenticated v2 odds endpoint first,
   * then the public API odds endpoint.
   */

  const urls = [
    `${BSD_BASE}/odds/?event_id=${eventId}`,
    `${BSD_PUBLIC}/odds/?event_id=${eventId}`
  ];

  for (
    const url of urls
  ) {
    const response =
      await fetchJson(url);

    if (
      response.ok
    ) {
      return {
        ...response,
        source: url
      };
    }
  }

  return {
    ok: false,
    status: 404,
    data: null,
    source: null
  };
}

// ======================================================
// ODDS NORMALIZATION
// ======================================================

function extractOddsObject(
  data
) {
  if (!data) {
    return null;
  }

  if (
    data.odds &&
    typeof data.odds ===
      "object"
  ) {
    return data.odds;
  }

  if (
    data.result?.odds &&
    typeof data.result.odds ===
      "object"
  ) {
    return data.result.odds;
  }

  if (
    data.data?.odds &&
    typeof data.data.odds ===
      "object"
  ) {
    return data.data.odds;
  }

  return data;
}

function normalizeOdds(
  data
) {
  const odds =
    extractOddsObject(
      data
    );

  if (
    !odds ||
    typeof odds !==
      "object"
  ) {
    return null;
  }

  const matchWinner =
    odds.match_winner ??
    odds.matchWinner ??
    odds.winner ??
    {};

  const overUnder =
    odds.over_under ??
    odds.overUnder ??
    {};

  const btts =
    odds.btts ??
    odds.BTTS ??
    {};

  return {
    HOME:
      safeNumber(
        firstValue(
          matchWinner.home,
          odds.home,
          odds.odds_home
        )
      ),

    DRAW:
      safeNumber(
        firstValue(
          matchWinner.draw,
          odds.draw,
          odds.odds_draw
        )
      ),

    AWAY:
      safeNumber(
        firstValue(
          matchWinner.away,
          odds.away,
          odds.odds_away
        )
      ),

    OVER15:
      safeNumber(
        firstValue(
          overUnder.over_15,
          overUnder.over15,
          odds.over_15,
          odds.over15
        )
      ),

    UNDER15:
      safeNumber(
        firstValue(
          overUnder.under_15,
          overUnder.under15,
          odds.under_15,
          odds.under15
        )
      ),

    OVER25:
      safeNumber(
        firstValue(
          overUnder.over_25,
          overUnder.over25,
          odds.over_25,
          odds.over25
        )
      ),

    UNDER25:
      safeNumber(
        firstValue(
          overUnder.under_25,
          overUnder.under25,
          odds.under_25,
          odds.under25
        )
      ),

    OVER35:
      safeNumber(
        firstValue(
          overUnder.over_35,
          overUnder.over35,
          odds.over_35,
          odds.over35
        )
      ),

    UNDER35:
      safeNumber(
        firstValue(
          overUnder.under_35,
          overUnder.under35,
          odds.under_35,
          odds.under35
        )
      ),

    BTTS_YES:
      safeNumber(
        firstValue(
          btts.yes,
          odds.btts_yes
        )
      ),

    BTTS_NO:
      safeNumber(
        firstValue(
          btts.no,
          odds.btts_no
        )
      )
  };
}

// ======================================================
// BOOKMAKER / MOVEMENT EXTRACTION
// ======================================================

function recursiveObjects(
  value,
  output = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item
      of value
    ) {
      recursiveObjects(
        item,
        output
      );
    }

    return output;
  }

  if (
    typeof value ===
    "object"
  ) {
    output.push(value);

    for (
      const child
      of Object.values(value)
    ) {
      if (
        typeof child ===
          "object" &&
        child !== null
      ) {
        recursiveObjects(
          child,
          output
        );
      }
    }
  }

  return output;
}

function findBookmakerOdds(
  data
) {
  const objects =
    recursiveObjects(
      data
    );

  const result = {};

  for (
    const object
    of objects
  ) {
    const bookmaker =
      firstValue(
        object?.bookmaker_name,
        object?.bookmaker,
        object?.name
      );

    const prices =
      object?.prices;

    if (
      !prices ||
      typeof prices !==
        "object"
    ) {
      continue;
    }

    const save =
      (
        key,
        aliases
      ) => {
        for (
          const alias
          of aliases
        ) {
          const raw =
            prices?.[alias];

          const price =
            typeof raw ===
              "object"
              ? safeNumber(
                  raw?.price
                )
              : safeNumber(
                  raw
                );

          if (
            !validOdds(
              price
            )
          ) {
            continue;
          }

          if (
            !result[key] ||
            price >
              result[key].odds
          ) {
            result[key] = {
              odds: price,

              bookmaker:
                bookmaker ??
                null,

              movement:
                typeof raw ===
                  "object"
                  ? raw?.movement ??
                    raw?.direction ??
                    null
                  : null
            };
          }

          break;
        }
      };

    save(
      "HOME",
      [
        "HOME",
        "home",
        "1"
      ]
    );

    save(
      "DRAW",
      [
        "DRAW",
        "draw",
        "X",
        "x"
      ]
    );

    save(
      "AWAY",
      [
        "AWAY",
        "away",
        "2"
      ]
    );

    save(
      "OVER15",
      [
        "OVER_15",
        "over_15",
        "over15"
      ]
    );

    save(
      "UNDER15",
      [
        "UNDER_15",
        "under_15",
        "under15"
      ]
    );

    save(
      "OVER25",
      [
        "OVER_25",
        "over_25",
        "over25"
      ]
    );

    save(
      "UNDER25",
      [
        "UNDER_25",
        "under_25",
        "under25"
      ]
    );

    save(
      "OVER35",
      [
        "OVER_35",
        "over_35",
        "over35"
      ]
    );

    save(
      "UNDER35",
      [
        "UNDER_35",
        "under_35",
        "under35"
      ]
    );

    save(
      "BTTS_YES",
      [
        "YES",
        "yes",
        "BTTS_YES",
        "btts_yes"
      ]
    );

    save(
      "BTTS_NO",
      [
        "NO",
        "no",
        "BTTS_NO",
        "btts_no"
      ]
    );
  }

  return result;
}

// ======================================================
// ENRICH
// ======================================================

async function enrichCandidate(
  candidate,
  oddsCache
) {
  const eventId =
    candidate.eventId;

  const oddsResponse =
    oddsCache.get(
      eventId
    );

  if (
    oddsResponse &&
    oddsResponse.ok
  ) {
    const consensus =
      normalizeOdds(
        oddsResponse.data
      );

    const bookmakerOdds =
      findBookmakerOdds(
        oddsResponse.data
      );

    const best =
      bookmakerOdds[
        candidate.marketKey
      ];

    /*
     * Prefer a real bookmaker price
     * when one exists.
     */

    if (
      best &&
      validOdds(
        best.odds
      )
    ) {
      candidate.odds =
        best.odds;

      candidate.oddsSource =
        best.bookmaker
          ? `BSD/${best.bookmaker}`
          : "BSD_BOOKMAKER";

      candidate.bookmaker =
        best.bookmaker ??
        null;

      candidate.marketMovement =
        best.movement ??
        null;
    }

    /*
     * Otherwise use BSD consensus odds.
     */

    if (
      !validOdds(
        candidate.odds
      ) &&
      consensus
    ) {
      const price =
        consensus[
          candidate.marketKey
        ];

      if (
        validOdds(price)
      ) {
        candidate.odds =
          price;

        candidate.oddsSource =
          "BSD_CONSENSUS";
      }
    }

    /*
     * Recalculate value only from a
     * real retrieved price.
     */

    if (
      validOdds(
        candidate.odds
      )
    ) {
      candidate.value =
        Number(
          (
            (
              candidate.probability /
              100
            ) *
              candidate.odds -
            1
          ).toFixed(4)
        );
    }

    candidate.fairOdds =
      fairOdds(
        candidate.probability /
          100
      );
  }

  return candidate;
}

// ======================================================
// RANKING
// ======================================================

function scoreCandidate(
  candidate
) {
  const probability =
    candidate.probability /
    100;

  const confidence =
    candidate.confidence !==
      null
      ? candidate.confidence /
        100
      : 0;

  /*
   * Probability remains the primary factor.
   * Odds/value become important only when
   * real odds have actually been retrieved.
   */

  let score =
    probability * 100 +
    confidence * 18;

  if (
    confidence >= 0.90
  ) {
    score += 3;
  } else if (
    confidence >= 0.80
  ) {
    score += 2;
  } else if (
    confidence >= 0.70
  ) {
    score += 1;
  }

  if (
    validOdds(
      candidate.odds
    )
  ) {
    const value =
      candidate.value ??
      0;

    /*
     * Value can improve the score,
     * but is capped so a longshot does
     * not automatically beat a high-probability pick.
     */

    score += Math.min(
      Math.max(
        value * 25,
        -5
      ),
      12
    );

    if (
      candidate.odds >=
      candidate.fairOdds
    ) {
      score += 2;
    }
  }

  if (
    candidate.recommendationStrength >
    0
  ) {
    score += 2;
  }

  if (
    candidate.marketKey ===
      "1X" ||
    candidate.marketKey ===
      "X2"
  ) {
    score += 1.5;
  }

  candidate.score =
    Number(
      score.toFixed(2)
    );

  return candidate;
}

// ======================================================
// TOP 5
// ======================================================

function chooseTopPicks(
  candidates
) {
  const scored =
    candidates
      .map(
        scoreCandidate
      )
      .sort(
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
            (
              b.confidence ??
              0
            ) -
            (
              a.confidence ??
              0
            )
          );
        }
      );

  const selected = [];

  const usedEvents =
    new Set();

  const marketCounts =
    {};

  /*
   * First pass:
   * no more than three TOTAL selections
   * when there are other close alternatives.
   */

  for (
    const candidate
    of scored
  ) {
    if (
      selected.length >=
      MAX_TOP_PICKS
    ) {
      break;
    }

    const eventId =
      String(
        candidate.eventId
      );

    if (
      usedEvents.has(
        eventId
      )
    ) {
      continue;
    }

    const count =
      marketCounts[
        candidate.market
      ] ?? 0;

    if (
      candidate.market ===
        "TOTAL" &&
      count >= 3
    ) {
      continue;
    }

    usedEvents.add(
      eventId
    );

    marketCounts[
      candidate.market
    ] =
      count + 1;

    selected.push(
      candidate
    );
  }

  /*
   * Fill remaining positions
   * only if necessary.
   */

  if (
    selected.length <
    MAX_TOP_PICKS
  ) {
    for (
      const candidate
      of scored
    ) {
      if (
        selected.length >=
        MAX_TOP_PICKS
      ) {
        break;
      }

      const eventId =
        String(
          candidate.eventId
        );

      if (
        usedEvents.has(
          eventId
        )
      ) {
        continue;
      }

      usedEvents.add(
        eventId
      );

      selected.push(
        candidate
      );
    }
  }

  return selected;
}

// ======================================================
// ANALYSIS
// ======================================================

async function analyze(
  date
) {
  const started =
    Date.now();

  const allPredictions =
    await fetchAllPredictions();

  let predictions =
    filterPredictionsByDate(
      allPredictions.results,
      date
    );

  if (
    predictions.length === 0
  ) {
    predictions =
      allPredictions.results.filter(
        item => {
          const raw =
            eventDateOf(item);

          return (
            raw &&
            String(raw)
              .startsWith(date)
          );
        }
      );
  }

  const allCandidates =
    [];

  for (
    const prediction
    of predictions
  ) {
    allCandidates.push(
      ...generateCandidates(
        prediction
      )
    );
  }

  /*
   * Sort by probability before requesting
   * odds. This keeps API traffic reasonable.
   */

  const enrichmentPool =
    [...allCandidates]
      .sort(
        (a, b) =>
          b.probability -
          a.probability
      )
      .slice(0, 50);

  const oddsCache =
    new Map();

  let oddsRequests =
    0;

  let oddsSuccessful =
    0;

  let oddsFailed =
    0;

  /*
   * One odds request per unique event.
   */

  const uniqueEventIds =
    [
      ...new Set(
        enrichmentPool
          .map(
            candidate =>
              candidate.eventId
          )
          .filter(Boolean)
      )
    ];

  for (
    const eventId
    of uniqueEventIds
  ) {
    if (
      oddsCache.has(
        eventId
      )
    ) {
      continue;
    }

    oddsRequests++;

    try {
      const result =
        await fetchOdds(
          eventId
        );

      oddsCache.set(
        eventId,
        result
      );

      if (
        result.ok
      ) {
        oddsSuccessful++;
      } else {
        oddsFailed++;
      }
    } catch {
      oddsCache.set(
        eventId,
        {
          ok: false,
          status: 0,
          data: null
        }
      );

      oddsFailed++;
    }
  }

  /*
   * Enrich candidates.
   */

  for (
    const candidate
    of enrichmentPool
  ) {
    await enrichCandidate(
      candidate,
      oddsCache
    );
  }

  /*
   * Re-score after odds.
   */

  for (
    const candidate
    of allCandidates
  ) {
    scoreCandidate(
      candidate
    );
  }

  const topPicks =
    chooseTopPicks(
      allCandidates
    );

  return {
    version:
      VERSION,

    source:
      SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() -
      started,

    exchange,

    predictionsTotal:
      allPredictions.total,

    predictionsDownloaded:
      allPredictions.results.length,

    predictionsFound:
      predictions.length,

    candidatesFound:
      allCandidates.length,

    qualificationCount:
      allCandidates.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    oddsStatus: {
      requests:
        oddsRequests,

      successful:
        oddsSuccessful,

      failed:
        oddsFailed,

      message:
        oddsSuccessful > 0
          ? "Real BSD odds were retrieved for at least some events."
          : "No usable BSD odds were retrieved. No odds or value are fabricated."
    },

    methodology: {
      primaryFactor:
        "model probability",

      secondaryFactors: [
        "model confidence",
        "real bookmaker odds",
        "BSD consensus odds",
        "fair odds",
        "value",
        "BSD recommendation",
        "market diversification"
      ],

      valueFormula:
        "probability × odds - 1",

      onePickPerEvent:
        true,

      maxTopPicks:
        MAX_TOP_PICKS,

      exchangeRule:
        "Exchange movement is shown only when real exchange data is connected."
    },

    topPicks
  };
}

// ======================================================
// ROUTES
// ======================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status:
        "ok",

      service:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      exchange
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      version:
        VERSION,

      source:
        SOURCE,

      exchange
    });
  }
);

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const data =
        await fetchAllPredictions();

      res.json({
        version:
          VERSION,

        count:
          data.total,

        downloaded:
          data.results.length,

        sample:
          data.results
            .slice(0, 10)
            .map(
              item => ({
                eventId:
                  eventIdOf(item),

                event:
                  `${homeName(item)} – ${awayName(item)}`,

                date:
                  eventDateOf(item),

                probabilities:
                  getProbabilities(
                    item
                  ),

                confidence:
                  getConfidence(
                    item
                  ),

                odds:
                  getOdds(item),

                recommendation:
                  getRecommendationText(
                    item
                  )
              })
            )
      });
    } catch (
      error
    ) {
      res.status(500)
        .json({
          version:
            VERSION,

          error:
            error.message
        });
    }
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const data =
        await fetchAllPredictions();

      const predictions =
        filterPredictionsByDate(
          data.results,
          date
        );

      res.json({
        version:
          VERSION,

        date,

        count:
          predictions.length,

        events:
          predictions.map(
            item => ({
              eventId:
                eventIdOf(item),

              event:
                `${homeName(item)} – ${awayName(item)}`,

              date:
                eventDateOf(item),

              league:
                leagueNameOf(item),

              confidence:
                getConfidence(
                  item
                ),

              probabilities:
                getProbabilities(
                  item
                ),

              odds:
                getOdds(item),

              recommendation:
                getRecommendationText(
                  item
                )
            })
          )
      });
    } catch (
      error
    ) {
      res.status(500)
        .json({
          version:
            VERSION,

          error:
            error.message
        });
    }
  }
);

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        todayUTC();

      const result =
        await analyze(
          date
        );

      res.json(
        result
      );
    } catch (
      error
    ) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500)
        .json({
          version:
            VERSION,

          source:
            SOURCE,

          error:
            error.message,

          exchange
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
        todayUTC();

      const result =
        await analyze(
          date
        );

      res.json({
        version:
          result.version,

        source:
          result.source,

        date:
          result.date,

        generatedAt:
          result.generatedAt,

        processingMs:
          result.processingMs,

        exchange:
          result.exchange,

        predictionsTotal:
          result.predictionsTotal,

        predictionsDownloaded:
          result.predictionsDownloaded,

        predictionsFound:
          result.predictionsFound,

        candidatesFound:
          result.candidatesFound,

        qualificationCount:
          result.qualificationCount,

        maxTopPicks:
          result.maxTopPicks,

        oddsStatus:
          result.oddsStatus,

        topPicks:
          result.topPicks
      });
    } catch (
      error
    ) {
      console.error(
        "TOP PICKS ERROR:",
        error
      );

      res.status(500)
        .json({
          version:
            VERSION,

          source:
            SOURCE,

          error:
            error.message,

          exchange
        });
    }
  }
);

// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );

    console.log(
      `BSD API configured: ${
        BSD_API_KEY
          ? "YES"
          : "NO"
      }`
    );
  }
);
