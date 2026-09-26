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

const VERSION = "7.0.0";
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

// --------------------------------------------------
// BASIC HELPERS
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeProbability(value) {
  const n = safeNumber(value);

  if (n === null) return null;

  if (n > 1) {
    return clamp(n / 100, 0, 1);
  }

  return clamp(n, 0, 1);
}

function normalizeDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) return null;

  return d;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function validOdds(value) {
  const n = safeNumber(value);

  if (n === null) return false;

  return n >= MIN_ODDS && n <= MAX_ODDS;
}

function fairOdds(probability) {
  if (!probability || probability <= 0) return null;

  return Number((1 / probability).toFixed(3));
}

function buildHeaders() {
  const headers = {
    Accept: "application/json"
  };

  if (BSD_API_KEY) {
    headers.Authorization = `Token ${BSD_API_KEY}`;
  }

  return headers;
}

// --------------------------------------------------
// FETCH
// --------------------------------------------------

async function fetchJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data
      };
    }

    return {
      ok: true,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

// --------------------------------------------------
// GENERIC DATA HELPERS
// --------------------------------------------------

function getResults(data) {
  if (!data) return [];

  if (Array.isArray(data)) return data;

  if (Array.isArray(data.results)) return data.results;

  if (Array.isArray(data.data)) return data.data;

  if (Array.isArray(data.predictions)) return data.predictions;

  if (Array.isArray(data.events)) return data.events;

  return [];
}

function getCount(data) {
  if (!data || typeof data !== "object") return null;

  const count = safeNumber(data.count);

  return count !== null ? count : null;
}

function eventIdOf(item) {
  return (
    item?.event_id ??
    item?.eventId ??
    item?.match_id ??
    item?.matchId ??
    item?.id ??
    null
  );
}

function homeName(item) {
  return (
    item?.home_team ??
    item?.home_team_name ??
    item?.homeTeam ??
    item?.home ??
    item?.teams?.home?.name ??
    item?.home?.name ??
    "Home"
  );
}

function awayName(item) {
  return (
    item?.away_team ??
    item?.away_team_name ??
    item?.awayTeam ??
    item?.away ??
    item?.teams?.away?.name ??
    item?.away?.name ??
    "Away"
  );
}

function eventDateOf(item) {
  return (
    item?.event_date ??
    item?.eventDate ??
    item?.match_date ??
    item?.matchDate ??
    item?.date ??
    item?.start_time ??
    item?.startTime ??
    null
  );
}

function leagueNameOf(item) {
  return (
    item?.league_name ??
    item?.leagueName ??
    item?.league?.name ??
    item?.competition?.name ??
    item?.tournament?.name ??
    null
  );
}

// --------------------------------------------------
// PREDICTION DATA
// --------------------------------------------------

function getConfidence(item) {
  return normalizeProbability(
    item?.confidence ??
      item?.model_confidence ??
      item?.prediction?.confidence ??
      item?.prediction?.model_confidence
  );
}

function getProbabilities(item) {
  const source =
    item?.probabilities ??
    item?.probability ??
    item?.prediction?.probabilities ??
    item?.prediction?.probability ??
    item?.prediction ??
    {};

  const home = normalizeProbability(
    source.home ??
      source.home_win ??
      source.homeWin ??
      source["1"] ??
      item?.prob_home ??
      item?.probability_home ??
      item?.home_probability
  );

  const draw = normalizeProbability(
    source.draw ??
      source.x ??
      source.draw_probability ??
      source["X"] ??
      item?.prob_draw ??
      item?.probability_draw ??
      item?.draw_probability
  );

  const away = normalizeProbability(
    source.away ??
      source.away_win ??
      source.awayWin ??
      source["2"] ??
      item?.prob_away ??
      item?.probability_away ??
      item?.away_probability
  );

  const over15 = normalizeProbability(
    source.over_15 ??
      source.over15 ??
      source.over1_5 ??
      item?.prob_over_15 ??
      item?.probability_over_15 ??
      item?.over_15_probability
  );

  const under15 = normalizeProbability(
    source.under_15 ??
      source.under15 ??
      source.under1_5 ??
      item?.prob_under_15 ??
      item?.probability_under_15 ??
      item?.under_15_probability
  );

  const over25 = normalizeProbability(
    source.over_25 ??
      source.over25 ??
      source.over2_5 ??
      item?.prob_over_25 ??
      item?.probability_over_25 ??
      item?.over_25_probability
  );

  const under25 = normalizeProbability(
    source.under_25 ??
      source.under25 ??
      source.under2_5 ??
      item?.prob_under_25 ??
      item?.probability_under_25 ??
      item?.under_25_probability
  );

  const over35 = normalizeProbability(
    source.over_35 ??
      source.over35 ??
      source.over3_5 ??
      item?.prob_over_35 ??
      item?.probability_over_35 ??
      item?.over_35_probability
  );

  const under35 = normalizeProbability(
    source.under_35 ??
      source.under35 ??
      source.under3_5 ??
      item?.prob_under_35 ??
      item?.probability_under_35 ??
      item?.under_35_probability
  );

  const bttsYes = normalizeProbability(
    source.btts_yes ??
      source.bttsYes ??
      source.btts?.yes ??
      item?.prob_btts_yes ??
      item?.probability_btts_yes ??
      item?.btts_yes_probability
  );

  const bttsNo = normalizeProbability(
    source.btts_no ??
      source.bttsNo ??
      source.btts?.no ??
      item?.prob_btts_no ??
      item?.probability_btts_no ??
      item?.btts_no_probability
  );

  return {
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
  };
}

// --------------------------------------------------
// ODDS FROM PREDICTION
// --------------------------------------------------

function getOdds(item) {
  return {
    home: safeNumber(
      item?.odds_home ??
        item?.oddsHome ??
        item?.odds?.home ??
        item?.odds?.match_winner?.home
    ),

    draw: safeNumber(
      item?.odds_draw ??
        item?.oddsDraw ??
        item?.odds?.draw ??
        item?.odds?.match_winner?.draw
    ),

    away: safeNumber(
      item?.odds_away ??
        item?.oddsAway ??
        item?.odds?.away ??
        item?.odds?.match_winner?.away
    ),

    over15: safeNumber(
      item?.odds_over_15 ??
        item?.oddsOver15 ??
        item?.odds?.over_15 ??
        item?.odds?.over_under?.over_15
    ),

    under15: safeNumber(
      item?.odds_under_15 ??
        item?.oddsUnder15 ??
        item?.odds?.under_15 ??
        item?.odds?.over_under?.under_15
    ),

    over25: safeNumber(
      item?.odds_over_25 ??
        item?.oddsOver25 ??
        item?.odds?.over_25 ??
        item?.odds?.over_under?.over_25
    ),

    under25: safeNumber(
      item?.odds_under_25 ??
        item?.oddsUnder25 ??
        item?.odds?.under_25 ??
        item?.odds?.over_under?.under_25
    ),

    over35: safeNumber(
      item?.odds_over_35 ??
        item?.oddsOver35 ??
        item?.odds?.over_35 ??
        item?.odds?.over_under?.over_35
    ),

    under35: safeNumber(
      item?.odds_under_35 ??
        item?.oddsUnder35 ??
        item?.odds?.under_35 ??
        item?.odds?.over_under?.under_35
    ),

    bttsYes: safeNumber(
      item?.odds_btts_yes ??
        item?.oddsBttsYes ??
        item?.odds?.btts?.yes ??
        item?.odds?.btts_yes
    ),

    bttsNo: safeNumber(
      item?.odds_btts_no ??
        item?.oddsBttsNo ??
        item?.odds?.btts?.no ??
        item?.odds?.btts_no
    )
  };
}

// --------------------------------------------------
// RECOMMENDATIONS
// --------------------------------------------------

function recursiveStrings(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string") {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      recursiveStrings(item, output);
    }

    return output;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      recursiveStrings(item, output);
    }
  }

  return output;
}

function getRecommendationText(item) {
  const values = [
    item?.recommendation,
    item?.recommendations,
    item?.prediction?.recommendation,
    item?.prediction?.recommendations,
    item?.tip,
    item?.call,
    item?.pick
  ];

  return recursiveStrings(values)
    .join(" | ")
    .trim();
}

function getRecommendationFlags(item) {
  const text = getRecommendationText(item).toLowerCase();

  return {
    home:
      text.includes("home") ||
      text.includes("1x") ||
      text.includes("win or draw"),

    away:
      text.includes("away") ||
      text.includes("x2") ||
      text.includes("avoid defeat"),

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
      text.includes("both teams to score")
  };
}

// --------------------------------------------------
// MARKET DEFINITIONS
// --------------------------------------------------

const MARKET_DEFINITIONS = [
  {
    key: "1X",
    market: "DOUBLE_CHANCE",
    pick: "1X",
    probability: (p) =>
      p.home !== null && p.draw !== null ? p.home + p.draw : null,
    odds: (o) => null
  },

  {
    key: "X2",
    market: "DOUBLE_CHANCE",
    pick: "X2",
    probability: (p) =>
      p.away !== null && p.draw !== null ? p.away + p.draw : null,
    odds: (o) => null
  },

  {
    key: "HOME",
    market: "1X2",
    pick: "1",
    probability: (p) => p.home,
    odds: (o) => o.home
  },

  {
    key: "DRAW",
    market: "1X2",
    pick: "X",
    probability: (p) => p.draw,
    odds: (o) => o.draw
  },

  {
    key: "AWAY",
    market: "1X2",
    pick: "2",
    probability: (p) => p.away,
    odds: (o) => o.away
  },

  {
    key: "OVER15",
    market: "TOTAL",
    pick: "OVER 1.5",
    probability: (p) => p.over15,
    odds: (o) => o.over15
  },

  {
    key: "UNDER15",
    market: "TOTAL",
    pick: "UNDER 1.5",
    probability: (p) => p.under15,
    odds: (o) => o.under15
  },

  {
    key: "OVER25",
    market: "TOTAL",
    pick: "OVER 2.5",
    probability: (p) => p.over25,
    odds: (o) => o.over25
  },

  {
    key: "UNDER25",
    market: "TOTAL",
    pick: "UNDER 2.5",
    probability: (p) => p.under25,
    odds: (o) => o.under25
  },

  {
    key: "OVER35",
    market: "TOTAL",
    pick: "OVER 3.5",
    probability: (p) => p.over35,
    odds: (o) => o.over35
  },

  {
    key: "UNDER35",
    market: "TOTAL",
    pick: "UNDER 3.5",
    probability: (p) => p.under35,
    odds: (o) => o.under35
  },

  {
    key: "BTTS_YES",
    market: "BTTS",
    pick: "BTTS YES",
    probability: (p) => p.bttsYes,
    odds: (o) => o.bttsYes
  },

  {
    key: "BTTS_NO",
    market: "BTTS",
    pick: "BTTS NO",
    probability: (p) => p.bttsNo,
    odds: (o) => o.bttsNo
  }
];

// --------------------------------------------------
// CANDIDATE
// --------------------------------------------------

function makeCandidate(item, definition) {
  const probabilities = getProbabilities(item);
  const odds = getOdds(item);

  const probability = definition.probability(probabilities);

  if (probability === null || probability < MIN_PROBABILITY) {
    return null;
  }

  const rawOdds = definition.odds(odds);

  const actualOdds = validOdds(rawOdds) ? rawOdds : null;

  const fair = fairOdds(probability);

  const value =
    actualOdds !== null
      ? Number((probability * actualOdds - 1).toFixed(4))
      : null;

  const confidence = getConfidence(item);

  const flags = getRecommendationFlags(item);

  let recommendationStrength = 0;

  if (
    (definition.key === "HOME" || definition.key === "1X") &&
    flags.home
  ) {
    recommendationStrength = 1;
  }

  if (
    (definition.key === "AWAY" || definition.key === "X2") &&
    flags.away
  ) {
    recommendationStrength = 1;
  }

  if (definition.key === "OVER15" && flags.over15) {
    recommendationStrength = 1;
  }

  if (definition.key === "OVER25" && flags.over25) {
    recommendationStrength = 1;
  }

  if (definition.key === "UNDER25" && flags.under25) {
    recommendationStrength = 1;
  }

  if (definition.key === "UNDER35" && flags.under35) {
    recommendationStrength = 1;
  }

  if (
    (definition.key === "BTTS_YES" || definition.key === "BTTS_NO") &&
    flags.btts
  ) {
    recommendationStrength = 1;
  }

  return {
    eventId: eventIdOf(item),

    event: `${homeName(item)} – ${awayName(item)}`,

    home: homeName(item),
    away: awayName(item),

    date: eventDateOf(item),

    league: leagueNameOf(item),

    market: definition.market,

    pick: definition.pick,

    marketKey: definition.key,

    probability: Number((probability * 100).toFixed(1)),

    confidence:
      confidence !== null
        ? Number((confidence * 100).toFixed(1))
        : null,

    odds: actualOdds,

    fairOdds: fair,

    value,

    recommendationStrength,

    bsdRecommendation: getRecommendationText(item) || null,

    score: 0,

    oddsSource: actualOdds !== null ? "BSD" : "UNAVAILABLE",

    exchangeMovement: null
  };
}

// --------------------------------------------------
// GENERATE ALL MARKETS
// --------------------------------------------------

function generateCandidates(item) {
  const candidates = [];

  for (const definition of MARKET_DEFINITIONS) {
    const candidate = makeCandidate(item, definition);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

// --------------------------------------------------
// FETCH ALL PREDICTIONS
// --------------------------------------------------

async function fetchAllPredictions() {
  const all = [];

  const limit = 200;

  let offset = 0;

  let total = null;

  while (true) {
    const url =
      `${BSD_PUBLIC}/predictions/` +
      `?limit=${limit}&offset=${offset}`;

    const response = await fetchJson(url);

    if (!response.ok) {
      throw new Error(
        `BSD predictions HTTP ${response.status}`
      );
    }

    const results = getResults(response.data);

    if (total === null) {
      total = getCount(response.data);
    }

    all.push(...results);

    if (results.length < limit) {
      break;
    }

    offset += limit;

    if (total !== null && all.length >= total) {
      break;
    }

    if (offset > 5000) {
      break;
    }

    await sleep(100);
  }

  return {
    total: total ?? all.length,
    results: all
  };
}

// --------------------------------------------------
// DATE FILTER
// --------------------------------------------------

function filterPredictionsByDate(predictions, date) {
  return predictions.filter((item) => {
    const raw = eventDateOf(item);

    if (!raw) return false;

    const d = normalizeDate(raw);

    if (!d) return false;

    return d.toISOString().slice(0, 10) === date;
  });
}

// --------------------------------------------------
// EVENT DETAIL
// --------------------------------------------------

async function fetchEventDetails(eventId) {
  if (!eventId) return null;

  const urls = [
    `${BSD_BASE}/events/${eventId}/`,
    `${BSD_BASE}/events/${eventId}/odds/`
  ];

  const result = {
    event: null,
    odds: null
  };

  const eventResponse = await fetchJson(urls[0]);

  if (eventResponse.ok) {
    result.event = eventResponse.data;
  }

  const oddsResponse = await fetchJson(urls[1]);

  if (oddsResponse.ok) {
    result.odds = oddsResponse.data;
  }

  return result;
}

// --------------------------------------------------
// ODDS PARSING
// --------------------------------------------------

function parseConsensusOdds(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const odds =
    data.odds ??
    data.consensus ??
    data.consensus_odds ??
    data;

  if (!odds || typeof odds !== "object") {
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
    home: safeNumber(
      matchWinner.home ??
        odds.odds_home
    ),

    draw: safeNumber(
      matchWinner.draw ??
        odds.odds_draw
    ),

    away: safeNumber(
      matchWinner.away ??
        odds.odds_away
    ),

    over15: safeNumber(
      overUnder.over_15 ??
        overUnder.over15 ??
        odds.over_15 ??
        odds.odds_over_15
    ),

    under15: safeNumber(
      overUnder.under_15 ??
        overUnder.under15 ??
        odds.under_15 ??
        odds.odds_under_15
    ),

    over25: safeNumber(
      overUnder.over_25 ??
        overUnder.over25 ??
        odds.over_25 ??
        odds.odds_over_25
    ),

    under25: safeNumber(
      overUnder.under_25 ??
        overUnder.under25 ??
        odds.under_25 ??
        odds.odds_under_25
    ),

    over35: safeNumber(
      overUnder.over_35 ??
        overUnder.over35 ??
        odds.over_35 ??
        odds.odds_over_35
    ),

    under35: safeNumber(
      overUnder.under_35 ??
        overUnder.under35 ??
        odds.under_35 ??
        odds.odds_under_35
    ),

    bttsYes: safeNumber(
      btts.yes ??
        odds.btts_yes
    ),

    bttsNo: safeNumber(
      btts.no ??
        odds.btts_no
    )
  };
}

function parseMarkets(data) {
  const output = {};

  if (!data || !Array.isArray(data.markets)) {
    return output;
  }

  for (const market of data.markets) {
    const family =
      String(
        market.market_family ??
          market.market_kind ??
          ""
      ).toUpperCase();

    const line = safeNumber(market.market_line);

    const books = Array.isArray(market.bookmakers)
      ? market.bookmakers
      : [];

    for (const book of books) {
      const prices = book?.prices ?? {};

      const add = (key, selection) => {
        const priceObject = prices[selection];

        const price =
          typeof priceObject === "object"
            ? safeNumber(priceObject?.price)
            : safeNumber(priceObject);

        if (!validOdds(price)) return;

        const movement =
          typeof priceObject === "object"
            ? priceObject?.movement ?? null
            : null;

        if (!output[key]) {
          output[key] = {
            odds: price,
            bookmaker: book?.bookmaker ?? null,
            movement: movement
          };
        } else if (price > output[key].odds) {
          output[key] = {
            odds: price,
            bookmaker: book?.bookmaker ?? null,
            movement: movement
          };
        }
      };

      if (
        family === "1X2" ||
        family === "WINNER"
      ) {
        add("HOME", "HOME");
        add("DRAW", "DRAW");
        add("AWAY", "AWAY");
      }

      if (
        family === "OU" ||
        family === "TOTAL"
      ) {
        if (line === 1.5) {
          add("OVER15", "OVER");
          add("UNDER15", "UNDER");
        }

        if (line === 2.5) {
          add("OVER25", "OVER");
          add("UNDER25", "UNDER");
        }

        if (line === 3.5) {
          add("OVER35", "OVER");
          add("UNDER35", "UNDER");
        }
      }

      if (
        family === "BTTS" ||
        family === "BOTH_TEAMS_TO_SCORE"
      ) {
        add("BTTS_YES", "YES");
        add("BTTS_NO", "NO");
      }
    }
  }

  return output;
}

function extractOddsInfo(detail) {
  if (!detail) return null;

  const fromConsensus = parseConsensusOdds(detail);

  const fromMarkets = parseMarkets(detail);

  return {
    consensus: fromConsensus,
    markets: fromMarkets
  };
}

// --------------------------------------------------
// ENRICH CANDIDATE
// --------------------------------------------------

function enrichCandidate(candidate, details) {
  if (!details) return candidate;

  const event = details.event ?? {};
  const oddsData = details.odds ?? null;

  const parsed = extractOddsInfo(oddsData);

  const marketOdds = parsed?.markets?.[candidate.marketKey];

  let newOdds = candidate.odds;

  let oddsSource = candidate.oddsSource;

  let movement = null;

  if (marketOdds && validOdds(marketOdds.odds)) {
    newOdds = marketOdds.odds;

    oddsSource = marketOdds.bookmaker
      ? `BSD/${marketOdds.bookmaker}`
      : "BSD";

    movement = marketOdds.movement ?? null;
  }

  if (
    !validOdds(newOdds) &&
    parsed?.consensus
  ) {
    const consensusOdds = parsed.consensus;

    const mapping = {
      HOME: consensusOdds.home,
      DRAW: consensusOdds.draw,
      AWAY: consensusOdds.away,
      OVER15: consensusOdds.over15,
      UNDER15: consensusOdds.under15,
      OVER25: consensusOdds.over25,
      UNDER25: consensusOdds.under25,
      OVER35: consensusOdds.over35,
      UNDER35: consensusOdds.under35,
      BTTS_YES: consensusOdds.bttsYes,
      BTTS_NO: consensusOdds.bttsNo
    };

    const candidateOdds =
      mapping[candidate.marketKey];

    if (validOdds(candidateOdds)) {
      newOdds = candidateOdds;
      oddsSource = "BSD_CONSENSUS";
    }
  }

  candidate.odds = newOdds ?? null;

  candidate.oddsSource = oddsSource;

  candidate.exchangeMovement = null;

  candidate.bookmakerCount =
    safeNumber(
      oddsData?.bookmakers_count ??
        oddsData?.bookmaker_count ??
        event?.bookmakers_count
    );

  candidate.marketMovement = movement;

  if (validOdds(candidate.odds)) {
    candidate.value = Number(
      (
        (candidate.probability / 100) *
          candidate.odds -
        1
      ).toFixed(4)
    );
  }

  candidate.fairOdds = fairOdds(
    candidate.probability / 100
  );

  candidate.referee =
    event?.referee?.name ??
    event?.referee_name ??
    null;

  candidate.status =
    event?.status ??
    event?.match_status ??
    null;

  candidate.venue =
    event?.venue?.name ??
    event?.venue_name ??
    null;

  candidate.unavailablePlayers =
    event?.unavailable_players ??
    event?.unavailablePlayers ??
    [];

  candidate.predictedScore =
    event?.predicted_score ??
    event?.predictedScore ??
    null;

  return candidate;
}

// --------------------------------------------------
// RANKING
// --------------------------------------------------

function scoreCandidate(candidate) {
  const probability =
    candidate.probability / 100;

  const confidence =
    candidate.confidence !== null
      ? candidate.confidence / 100
      : 0;

  /*
   * Probability is the primary component.
   * Confidence supports it but cannot completely
   * override a materially lower probability.
   */

  let score =
    probability * 100 +
    confidence * 18;

  // Strong model confidence
  if (confidence >= 0.90) {
    score += 3;
  } else if (confidence >= 0.80) {
    score += 2;
  } else if (confidence >= 0.70) {
    score += 1;
  }

  // Actual bookmaker price
  if (validOdds(candidate.odds)) {
    const value = candidate.value ?? 0;

    /*
     * Value is important, but deliberately capped.
     * This prevents a longshot with huge theoretical
     * value from destroying the high-probability logic.
     */

    score += clamp(value * 25, -5, 12);

    // A price close to or above fair price is useful.
    if (
      candidate.odds >=
      candidate.fairOdds
    ) {
      score += 2;
    }
  }

  // BSD recommendation is supporting evidence,
  // never the sole deciding factor.
  if (candidate.recommendationStrength > 0) {
    score += 2;
  }

  // Double chance receives a modest structural bonus
  // because it is a different risk profile from totals.
  if (
    candidate.marketKey === "1X" ||
    candidate.marketKey === "X2"
  ) {
    score += 1.5;
  }

  candidate.score = Number(
    score.toFixed(2)
  );

  return candidate;
}

// --------------------------------------------------
// PICK SELECTION
// --------------------------------------------------

function chooseTopPicks(candidates) {
  const scored = candidates
    .map(scoreCandidate)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
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
        (b.confidence ?? 0) -
        (a.confidence ?? 0)
      );
    });

  const selected = [];

  const usedEvents = new Set();

  const marketCounts = {};

  /*
   * First pass:
   * take genuinely strongest selections,
   * but avoid filling the entire TOP 5 with
   * identical market types when alternatives
   * are close in score.
   */

  for (const candidate of scored) {
    if (selected.length >= MAX_TOP_PICKS) {
      break;
    }

    const eventId = String(
      candidate.eventId
    );

    if (usedEvents.has(eventId)) {
      continue;
    }

    const marketCount =
      marketCounts[candidate.market] ?? 0;

    /*
     * Soft concentration limit.
     *
     * We do NOT ban Over 1.5.
     * We simply prevent five almost identical
     * selections when other markets are close.
     */

    if (
      candidate.market === "TOTAL" &&
      marketCount >= 3
    ) {
      continue;
    }

    usedEvents.add(eventId);

    marketCounts[candidate.market] =
      marketCount + 1;

    selected.push(candidate);
  }

  /*
   * Second pass:
   * if the soft diversification rule left
   * empty slots, fill them with the strongest
   * remaining events.
   */

  if (
    selected.length <
    MAX_TOP_PICKS
  ) {
    for (const candidate of scored) {
      if (
        selected.length >=
        MAX_TOP_PICKS
      ) {
        break;
      }

      const eventId = String(
        candidate.eventId
      );

      if (usedEvents.has(eventId)) {
        continue;
      }

      usedEvents.add(eventId);

      selected.push(candidate);
    }
  }

  return selected;
}

// --------------------------------------------------
// ANALYSIS
// --------------------------------------------------

async function analyze(date) {
  const started = Date.now();

  const allPredictions =
    await fetchAllPredictions();

  const predictions =
    filterPredictionsByDate(
      allPredictions.results,
      date
    );

  const allCandidates = [];

  for (const prediction of predictions) {
    const candidates =
      generateCandidates(
        prediction
      );

    allCandidates.push(
      ...candidates
    );
  }

  /*
   * Enrich the strongest candidates with
   * real event/odds data.
   *
   * We don't request every event in order
   * to avoid unnecessary API traffic.
   */

  const enrichmentPool =
    [...allCandidates]
      .sort((a, b) => {
        const pa =
          a.probability ?? 0;

        const pb =
          b.probability ?? 0;

        return pb - pa;
      })
      .slice(0, 40);

  const detailsCache =
    new Map();

  for (const candidate of enrichmentPool) {
    const eventId =
      candidate.eventId;

    if (!eventId) continue;

    if (
      !detailsCache.has(eventId)
    ) {
      try {
        const details =
          await fetchEventDetails(
            eventId
          );

        detailsCache.set(
          eventId,
          details
        );

        await sleep(80);
      } catch {
        detailsCache.set(
          eventId,
          null
        );
      }
    }

    enrichCandidate(
      candidate,
      detailsCache.get(eventId)
    );
  }

  /*
   * Recalculate all scores after
   * bookmaker odds enrichment.
   */

  for (const candidate of allCandidates) {
    scoreCandidate(candidate);
  }

  const topPicks =
    chooseTopPicks(
      allCandidates
    );

  const processingMs =
    Date.now() - started;

  return {
    version: VERSION,

    source: SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs,

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

    methodology: {
      description:
        "All supported markets are compared. BSD recommendation is supporting evidence, not an automatic pick.",

      primaryFactor:
        "model probability",

      secondaryFactors: [
        "model confidence",
        "actual bookmaker odds when available",
        "fair odds",
        "value",
        "BSD recommendation",
        "market diversification"
      ],

      valueFormula:
        "probability × odds - 1",

      exchangeRule:
        "Exchange movement is displayed only when real exchange data is connected.",

      onePickPerEvent:
        true,

      maxSameMarketInInitialSelection:
        3
    },

    topPicks
  };
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    exchange
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE,
    exchange
  });
});

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const data =
        await fetchAllPredictions();

      res.json({
        version: VERSION,
        count: data.total,
        downloaded:
          data.results.length,
        first:
          data.results.slice(0, 5)
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error: error.message
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
        version: VERSION,
        date,
        count: predictions.length,
        events: predictions.map(
          (item) => ({
            eventId:
              eventIdOf(item),

            event:
              `${homeName(item)} – ${awayName(item)}`,

            date:
              eventDateOf(item),

            league:
              leagueNameOf(item),

            confidence:
              getConfidence(item),

            probabilities:
              getProbabilities(item),

            odds:
              getOdds(item),

            recommendation:
              getRecommendationText(
                item
              )
          })
        )
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error: error.message
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
        await analyze(date);

      res.json(result);
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500).json({
        version: VERSION,
        source: SOURCE,
        error: error.message,
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
        await analyze(date);

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

        maxTopPicks:
          result.maxTopPicks,

        candidatesFound:
          result.candidatesFound,

        topPicks:
          result.topPicks
      });
    } catch (error) {
      console.error(
        "TOP PICKS ERROR:",
        error
      );

      res.status(500).json({
        version: VERSION,
        source: SOURCE,
        error: error.message,
        exchange
      });
    }
  }
);

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );

  console.log(
    `BSD API configured: ${BSD_API_KEY ? "YES" : "NO"}`
  );
});
