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

const VERSION = "6.5.5";
const SOURCE = "BSD";

const MAX_EVENTS_ANALYZED = 50;
const MAX_TOP_PICKS = 5;

const CONFIG = {
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -8,
  minimumOddsForHighProbability: 1.20,

  strongPickMin: 70,
  strongPickScoreMin: 60,
  strongPickValueMin: -3,

  valueMinProbability: 35,
  valueMinScore: 55,
  valueMinValue: 5,

  allowedStatuses: [
    "notstarted",
    "not_started",
    "scheduled",
    "upcoming",
    "pending"
  ]
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
}

function normalizeDateInput(value) {
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  const text = String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const d = new Date(text);

  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

function isUpcomingEvent(event) {
  const status = normalizeStatus(event?.status);

  return CONFIG.allowedStatuses.includes(status);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bsdFetch(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(
      `BSD ${response.status} for ${url}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return {
    ok: true,
    status: response.status,
    data,
    url
  };
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

  if (
    payload.data &&
    Array.isArray(payload.data.results)
  ) {
    return payload.data.results;
  }

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  if (
    payload.data &&
    Array.isArray(payload.data.events)
  ) {
    return payload.data.events;
  }

  return [];
}

/*
 * BSD currently returns event teams as strings:
 *
 * home_team: "Union Sportive Amal Tiznit"
 * away_team: "Ittihad Tanger"
 *
 * Older/alternate shapes are also supported.
 */
function getTeamName(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return firstDefined(
      value.name,
      value.team_name,
      value.display_name
    );
  }

  return null;
}

function normalizeEvent(raw) {
  const id = firstDefined(
    raw?.id,
    raw?.event_id,
    raw?.match_id
  );

  const homeName = firstDefined(
    getTeamName(raw?.home_team),
    getTeamName(raw?.homeTeam),
    getTeamName(raw?.home),
    raw?.home_team_name,
    raw?.homeTeamName
  );

  const awayName = firstDefined(
    getTeamName(raw?.away_team),
    getTeamName(raw?.awayTeam),
    getTeamName(raw?.away),
    raw?.away_team_name,
    raw?.awayTeamName
  );

  const date = firstDefined(
    raw?.event_date,
    raw?.date,
    raw?.start_time,
    raw?.startTime,
    raw?.kickoff,
    raw?.datetime,
    raw?.scheduled_at
  );

  const status = normalizeStatus(
    firstDefined(
      raw?.status,
      raw?.state,
      raw?.match_status
    )
  );

  return {
    id: id !== null ? Number(id) : null,

    event:
      homeName && awayName
        ? `${homeName} – ${awayName}`
        : "Unknown – Unknown",

    home: homeName || null,
    away: awayName || null,

    date: date || null,
    status,

    league: firstDefined(
      getTeamName(raw?.league),
      raw?.league_name,
      raw?.competition?.name
    ),

    leagueId: firstDefined(
      raw?.league_id,
      raw?.league?.id,
      raw?.competition?.id
    ),

    raw
  };
}

/*
 * ------------------------------------------------------------------
 * EVENTS
 * ------------------------------------------------------------------
 */

async function getEvents(date) {
  const paths = [
    `/events/?date_from=${date}&date_to=${date}`,
    `/events?date_from=${date}&date_to=${date}`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const response = await bsdFetch(path);

      const events = extractResults(response.data)
        .map(normalizeEvent)
        .filter(event => event.id !== null);

      return {
        events,
        sourceUrl: response.url
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(
    "Unable to fetch events"
  );
}

async function getEventDetail(eventId) {
  const paths = [
    `/events/${eventId}/`,
    `/events/${eventId}`
  ];

  for (const path of paths) {
    try {
      const response = await bsdFetch(path);

      return response.data;
    } catch {
      // try next endpoint
    }
  }

  return null;
}

/*
 * ------------------------------------------------------------------
 * PREDICTIONS
 *
 * IMPORTANT:
 * BSD's football predictions endpoint is a LIST endpoint.
 *
 * We no longer use:
 * /predictions/?event_id=123
 *
 * Instead:
 * /predictions/?upcoming=true
 *
 * Then we match event_id locally.
 * ------------------------------------------------------------------
 */

let predictionCache = {
  timestamp: 0,
  data: []
};

const PREDICTION_CACHE_MS = 60 * 1000;

async function getAllPredictions() {
  const now = Date.now();

  if (
    predictionCache.data.length > 0 &&
    now - predictionCache.timestamp <
      PREDICTION_CACHE_MS
  ) {
    return predictionCache.data;
  }

  const paths = [
    `/predictions/?upcoming=true&limit=200`,
    `/predictions/?limit=200`,
    `/predictions/`
  ];

  let lastError = null;

  for (const path of paths) {
    try {
      const response = await bsdFetch(path);

      const results =
        extractResults(response.data);

      if (results.length > 0) {
        predictionCache = {
          timestamp: now,
          data: results
        };

        return results;
      }

      /*
       * A successful empty response is still a valid
       * response. Keep trying the fallback endpoint.
       */
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

function predictionEventId(row) {
  return num(firstDefined(
    row?.event_id,
    row?.eventId,
    row?.match_id,
    row?.matchId,
    row?.event?.id,
    row?.match?.id
  ));
}

function parsePrediction(raw) {
  if (!raw) return null;

  const p = raw;

  const home = num(firstDefined(
    p.home,
    p.home_win,
    p.home_win_prob,
    p.homeWin,
    p.probability_home,
    p.home_probability,
    p.probs?.home,
    p.probabilities?.home
  ));

  const draw = num(firstDefined(
    p.draw,
    p.draw_prob,
    p.draw_probability,
    p.probability_draw,
    p.probs?.draw,
    p.probabilities?.draw
  ));

  const away = num(firstDefined(
    p.away,
    p.away_win,
    p.away_win_prob,
    p.awayWin,
    p.probability_away,
    p.away_probability,
    p.probs?.away,
    p.probabilities?.away
  ));

  const over15 = num(firstDefined(
    p.over15,
    p.over_1_5,
    p.over_1_5_prob,
    p.over_1_5_probability,
    p.over15_prob,
    p.probabilities?.over15
  ));

  const over25 = num(firstDefined(
    p.over25,
    p.over_2_5,
    p.over_2_5_prob,
    p.over_2_5_probability,
    p.over25_prob,
    p.probabilities?.over25
  ));

  const over35 = num(firstDefined(
    p.over35,
    p.over_3_5,
    p.over_3_5_prob,
    p.over_3_5_probability,
    p.over35_prob,
    p.probabilities?.over35
  ));

  const bttsYes = num(firstDefined(
    p.bttsYes,
    p.btts_yes,
    p.btts_yes_prob,
    p.btts_yes_probability,
    p.bttsYes_prob,
    p.probabilities?.bttsYes
  ));

  const xgHome = num(firstDefined(
    p.xgHome,
    p.xg_home,
    p.expected_goals_home,
    p.home_xg,
    p.xg?.home
  ));

  const xgAway = num(firstDefined(
    p.xgAway,
    p.xg_away,
    p.expected_goals_away,
    p.away_xg,
    p.xg?.away
  ));

  const confidence = num(firstDefined(
    p.confidence,
    p.model_confidence
  ));

  return {
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

    predicted:
      firstDefined(
        p.predicted,
        p.prediction,
        p.predicted_result,
        p.predicted_winner,
        p.winner
      ),

    mostLikelyScore:
      firstDefined(
        p.mostLikelyScore,
        p.most_likely_score,
        p.most_likely_result,
        p.score
      ),

    raw: p
  };
}

async function getPrediction(
  eventId,
  detail
) {
  /*
   * First check embedded prediction.
   */
  const embedded =
    firstDefined(
      detail?.prediction,
      detail?.predictions,
      detail?.ml_prediction,
      detail?.forecast
    );

  if (embedded) {
    return {
      available: true,
      data:
        parsePrediction(embedded),
      source: "event",
      diagnostics: []
    };
  }

  /*
   * Fetch global prediction list.
   */
  try {
    const rows =
      await getAllPredictions();

    const matching =
      rows.find(row =>
        predictionEventId(row) ===
        Number(eventId)
      );

    if (matching) {
      return {
        available: true,
        data:
          parsePrediction(matching),
        source:
          "/predictions/?upcoming=true",
        diagnostics: [{
          path:
            "/predictions/?upcoming=true",
          status: 200,
          count: rows.length,
          matchedEventId:
            Number(eventId)
        }]
      };
    }

    return {
      available: false,
      data: null,
      source: null,
      diagnostics: [{
        path:
          "/predictions/?upcoming=true",
        status: 200,
        count: rows.length,
        matchedEventId: null
      }]
    };
  } catch (error) {
    return {
      available: false,
      data: null,
      source: null,
      diagnostics: [{
        path:
          "/predictions/?upcoming=true",
        status:
          error.status || null,
        count: 0,
        error:
          error.message
      }]
    };
  }
}

/*
 * ------------------------------------------------------------------
 * ODDS
 * ------------------------------------------------------------------
 */

async function getOdds(eventId, detail) {
  const embedded = firstDefined(
    detail?.odds,
    detail?.markets,
    detail?.bookmaker_odds
  );

  if (embedded) {
    return {
      available: true,
      data: embedded,
      source: "event",
      diagnostics: []
    };
  }

  const paths = [
    `/odds/?event_id=${eventId}`,
    `/odds?event_id=${eventId}`,
    `/events/${eventId}/odds/`,
    `/events/${eventId}/odds`
  ];

  const diagnostics = [];

  for (const path of paths) {
    try {
      const response =
        await bsdFetch(path);

      const rows =
        extractResults(
          response.data
        );

      diagnostics.push({
        path,
        status: response.status,
        count: rows.length
      });

      if (rows.length > 0) {
        return {
          available: true,
          data: rows,
          source: response.url,
          diagnostics
        };
      }
    } catch (error) {
      diagnostics.push({
        path,
        status:
          error.status || null,
        count: 0
      });
    }
  }

  return {
    available: false,
    data: null,
    source: null,
    diagnostics
  };
}

function parseOdds(oddsData) {
  if (!oddsData) {
    return null;
  }

  const rows = Array.isArray(oddsData)
    ? oddsData
    : extractResults(oddsData);

  const odds = {
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

    updatedAt: null,
    lastChangeAt: null,
    nextUpdateAt: null,
    interval: null,

    bookmakers: 0,
    rawCount: rows.length
  };

  function setIfBetter(
    key,
    value
  ) {
    const n = num(value);

    if (
      n === null ||
      n <= 1
    ) {
      return;
    }

    if (
      odds[key] === null ||
      n > odds[key]
    ) {
      odds[key] = n;
    }
  }

  for (const row of rows) {
    const market =
      String(firstDefined(
        row?.market,
        row?.market_name,
        row?.type,
        row?.bet_type,
        row?.name,
        row?.market_kind
      ) || "").toLowerCase();

    const selection =
      String(firstDefined(
        row?.selection,
        row?.selection_name,
        row?.outcome,
        row?.outcome_name,
        row?.label,
        row?.side
      ) || "").toLowerCase();

    const value =
      firstDefined(
        row?.odds,
        row?.price,
        row?.decimal,
        row?.value,
        row?.odd
      );

    /*
     * WINNER / 1X2
     */
    if (
      market.includes("1x2") ||
      market.includes("match winner") ||
      market.includes("winner") ||
      market === "full time" ||
      market === "ft"
    ) {
      if (
        selection === "home" ||
        selection === "1" ||
        selection.includes("home")
      ) {
        setIfBetter(
          "home",
          value
        );
      }

      if (
        selection === "draw" ||
        selection === "x"
      ) {
        setIfBetter(
          "draw",
          value
        );
      }

      if (
        selection === "away" ||
        selection === "2" ||
        selection.includes("away")
      ) {
        setIfBetter(
          "away",
          value
        );
      }
    }

    /*
     * OVER / UNDER
     */
    if (
      market.includes("over/under") ||
      market.includes("goals") ||
      market.includes("total") ||
      market.includes("ou")
    ) {
      if (
        selection.includes("over") &&
        selection.includes("1.5")
      ) {
        setIfBetter(
          "over15",
          value
        );
      }

      if (
        selection.includes("under") &&
        selection.includes("1.5")
      ) {
        setIfBetter(
          "under15",
          value
        );
      }

      if (
        selection.includes("over") &&
        selection.includes("2.5")
      ) {
        setIfBetter(
          "over25",
          value
        );
      }

      if (
        selection.includes("under") &&
        selection.includes("2.5")
      ) {
        setIfBetter(
          "under25",
          value
        );
      }

      if (
        selection.includes("over") &&
        selection.includes("3.5")
      ) {
        setIfBetter(
          "over35",
          value
        );
      }

      if (
        selection.includes("under") &&
        selection.includes("3.5")
      ) {
        setIfBetter(
          "under35",
          value
        );
      }
    }

    /*
     * BTTS
     */
    if (
      market.includes("btts") ||
      market.includes("both teams") ||
      market.includes("both to score")
    ) {
      if (
        selection.includes("yes") ||
        selection === "1"
      ) {
        setIfBetter(
          "bttsYes",
          value
        );
      }

      if (
        selection.includes("no") ||
        selection === "0"
      ) {
        setIfBetter(
          "bttsNo",
          value
        );
      }
    }

    odds.updatedAt =
      firstDefined(
        odds.updatedAt,
        row?.updated_at,
        row?.updatedAt,
        row?.timestamp
      );

    odds.lastChangeAt =
      firstDefined(
        odds.lastChangeAt,
        row?.last_change_at,
        row?.lastChangeAt
      );

    odds.nextUpdateAt =
      firstDefined(
        odds.nextUpdateAt,
        row?.next_update_at,
        row?.nextUpdateAt
      );

    odds.interval =
      firstDefined(
        odds.interval,
        row?.interval,
        row?.update_interval
      );
  }

  const bookmakerSet =
    new Set();

  for (const row of rows) {
    const bookmaker =
      firstDefined(
        row?.bookmaker?.name,
        row?.bookmaker_name,
        row?.bookmaker
      );

    if (bookmaker) {
      bookmakerSet.add(
        String(bookmaker)
      );
    }
  }

  odds.bookmakers =
    bookmakerSet.size;

  const marketsWithOdds = [
    "home",
    "draw",
    "away",
    "over15",
    "under15",
    "over25",
    "under25",
    "over35",
    "under35",
    "bttsYes",
    "bttsNo"
  ];

  const hasAnyOdds =
    marketsWithOdds.some(
      key =>
        odds[key] !== null
    );

  return hasAnyOdds
    ? odds
    : null;
}

/*
 * ------------------------------------------------------------------
 * H2H
 * ------------------------------------------------------------------
 */

function parseH2H(detail) {
  const h2h =
    firstDefined(
      detail?.head_to_head,
      detail?.headToHead,
      detail?.h2h
    );

  if (!h2h) {
    return {
      sampleSize: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      avgGoals: null
    };
  }

  const matches =
    safeArray(
      h2h?.recent_matches ||
      h2h?.results ||
      h2h?.matches ||
      h2h
    );

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;

  let totalGoals = 0;
  let goalSamples = 0;

  for (const match of matches) {
    const homeScore =
      num(firstDefined(
        match?.home_score,
        match?.homeScore,
        match?.score?.home
      ));

    const awayScore =
      num(firstDefined(
        match?.away_score,
        match?.awayScore,
        match?.score?.away
      ));

    if (
      homeScore === null ||
      awayScore === null
    ) {
      continue;
    }

    if (
      homeScore >
      awayScore
    ) {
      homeWins++;
    } else if (
      homeScore ===
      awayScore
    ) {
      draws++;
    } else {
      awayWins++;
    }

    totalGoals +=
      homeScore + awayScore;

    goalSamples++;
  }

  /*
   * Some current BSD event responses already
   * provide aggregated H2H values.
   */
  if (
    goalSamples === 0 &&
    num(h2h.total_matches) !== null
  ) {
    return {
      sampleSize:
        num(h2h.total_matches) || 0,

      homeWins:
        num(h2h.home_wins) || 0,

      draws:
        num(h2h.draws) || 0,

      awayWins:
        num(h2h.away_wins) || 0,

      avgGoals:
        num(h2h.avg_total_goals)
    };
  }

  return {
    sampleSize: goalSamples,
    homeWins,
    draws,
    awayWins,

    avgGoals:
      goalSamples
        ? totalGoals /
          goalSamples
        : null
  };
}

/*
 * ------------------------------------------------------------------
 * LINEUPS / FORM / STATS / REFEREE
 * ------------------------------------------------------------------
 */

function parseLineups(detail) {
  const lineup =
    firstDefined(
      detail?.lineups,
      detail?.lineup,
      detail?.predicted_lineup
    );

  if (!lineup) {
    return {
      available: false,
      confirmed: false,
      homePlayers: 0,
      awayPlayers: 0,

      formations: {
        home: null,
        away: null
      }
    };
  }

  const home =
    safeArray(
      lineup?.home?.players ||
      lineup?.home_players ||
      lineup?.home
    );

  const away =
    safeArray(
      lineup?.away?.players ||
      lineup?.away_players ||
      lineup?.away
    );

  return {
    available: true,

    confirmed: Boolean(
      firstDefined(
        lineup?.confirmed,
        lineup?.is_confirmed
      )
    ),

    homePlayers:
      home.length,

    awayPlayers:
      away.length,

    formations: {
      home:
        firstDefined(
          lineup?.home?.formation,
          lineup?.home_formation
        ),

      away:
        firstDefined(
          lineup?.away?.formation,
          lineup?.away_formation
        )
    }
  };
}

function parseForm(detail) {
  return firstDefined(
    detail?.form,
    detail?.team_form,
    detail?.recent_form
  ) || null;
}

function parseStats(detail) {
  return firstDefined(
    detail?.stats,
    detail?.statistics,
    detail?.team_stats
  ) || null;
}

function parseReferee(detail) {
  const referee =
    firstDefined(
      detail?.referee,
      detail?.officials?.referee
    );

  if (!referee) {
    return null;
  }

  return {
    id:
      firstDefined(
        referee?.id,
        referee?.referee_id
      ),

    name:
      firstDefined(
        referee?.name,
        referee?.full_name
      )
  };
}

/*
 * ------------------------------------------------------------------
 * MOVEMENT
 * ------------------------------------------------------------------
 */

function getMovementForMarket(
  market,
  oddsData
) {
  const rows =
    safeArray(oddsData);

  if (!rows.length) {
    return {
      available: false,
      direction: "UNAVAILABLE",

      changePercentPrevious:
        null,

      changePercentOpening:
        null,

      bookmakerCount: 0
    };
  }

  const matching =
    rows.filter(row => {
      const text =
        JSON.stringify(
          row
        ).toLowerCase();

      if (market === "over15") {
        return (
          text.includes("over") &&
          text.includes("1.5")
        );
      }

      if (market === "over25") {
        return (
          text.includes("over") &&
          text.includes("2.5")
        );
      }

      if (market === "over35") {
        return (
          text.includes("over") &&
          text.includes("3.5")
        );
      }

      if (market === "bttsYes") {
        return (
          (
            text.includes("btts") ||
            text.includes("both teams") ||
            text.includes("both to score")
          ) &&
          text.includes("yes")
        );
      }

      if (market === "home") {
        return (
          text.includes('"home"') ||
          text.includes('"1"')
        );
      }

      if (market === "draw") {
        return (
          text.includes('"draw"') ||
          text.includes('"x"')
        );
      }

      if (market === "away") {
        return (
          text.includes('"away"') ||
          text.includes('"2"')
        );
      }

      return false;
    });

  const bookmakerSet =
    new Set();

  let current = null;
  let previous = null;
  let opening = null;

  for (const row of matching) {
    const bookmaker =
      firstDefined(
        row?.bookmaker?.name,
        row?.bookmaker_name,
        row?.bookmaker
      );

    if (bookmaker) {
      bookmakerSet.add(
        String(bookmaker)
      );
    }

    const currentPrice =
      num(firstDefined(
        row?.odds,
        row?.price,
        row?.decimal,
        row?.value
      ));

    if (
      currentPrice !== null &&
      currentPrice > 1
    ) {
      current =
        current === null
          ? currentPrice
          : Math.min(
              current,
              currentPrice
            );
    }

    previous =
      firstDefined(
        previous,
        num(firstDefined(
          row?.previous_odds,
          row?.previousOdds,
          row?.prev_odds
        ))
      );

    opening =
      firstDefined(
        opening,
        num(firstDefined(
          row?.opening_odds,
          row?.openingOdds,
          row?.open_odds
        ))
      );
  }

  if (
    current === null ||
    current <= 1
  ) {
    return {
      available: false,
      direction: "UNAVAILABLE",

      changePercentPrevious:
        null,

      changePercentOpening:
        null,

      bookmakerCount:
        bookmakerSet.size
    };
  }

  const changePrevious =
    previous && previous > 1
      ? (
          (current - previous) /
          previous
        ) * 100
      : null;

  const changeOpening =
    opening && opening > 1
      ? (
          (current - opening) /
          opening
        ) * 100
      : null;

  const reference =
    changePrevious !== null
      ? changePrevious
      : changeOpening;

  let direction = "STABLE";

  if (
    reference !== null
  ) {
    if (reference <= -1) {
      direction =
        "SHORTENING";
    } else if (
      reference >= 1
    ) {
      direction =
        "DRIFTING";
    }
  }

  return {
    available: true,

    direction,

    changePercentPrevious:
      changePrevious,

    changePercentOpening:
      changeOpening,

    bookmakerCount:
      bookmakerSet.size
  };
}

/*
 * ------------------------------------------------------------------
 * SCORING
 * ------------------------------------------------------------------
 */

function impliedProbability(
  odds
) {
  if (
    !odds ||
    odds <= 1
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
    odds <= 1
  ) {
    return null;
  }

  return (
    (
      (probability / 100) *
      odds
    ) - 1
  ) * 100;
}

function dataQuality(bundle) {
  let score = 0;

  if (
    bundle.prediction
  ) {
    score += 35;
  }

  if (
    bundle.odds
  ) {
    score += 30;
  }

  if (
    bundle.lineups?.available
  ) {
    score += 15;
  }

  if (
    bundle.lineups?.confirmed
  ) {
    score += 5;
  }

  if (bundle.form) {
    score += 5;
  }

  if (
    bundle.h2h?.sampleSize > 0
  ) {
    score += 5;
  }

  if (bundle.referee) {
    score += 5;
  }

  return clamp(score);
}

function createCandidate(
  event,
  bundle,
  market,
  label
) {
  const probability =
    num(
      bundle.prediction?.[market]
    );

  const odds =
    num(
      bundle.odds?.[market]
    );

  /*
   * NEVER create a pick without
   * verified probability AND odds.
   */
  if (
    probability === null ||
    odds === null ||
    odds <= 1
  ) {
    return null;
  }

  const implied =
    impliedProbability(
      odds
    );

  const value =
    calculateValue(
      probability,
      odds
    );

  const movement =
    getMovementForMarket(
      market,
      bundle.oddsRaw
    );

  let probabilityScore =
    probability * 0.75;

  if (
    bundle.prediction?.xgHome !== null &&
    bundle.prediction?.xgAway !== null
  ) {
    probabilityScore += 3;
  }

  if (
    bundle.lineups?.available
  ) {
    probabilityScore += 3;
  }

  if (
    bundle.lineups?.confirmed
  ) {
    probabilityScore += 1;
  }

  if (bundle.form) {
    probabilityScore += 3;
  }

  if (
    bundle.h2h &&
    bundle.h2h.sampleSize > 0
  ) {
    probabilityScore += 1;
  }

  if (bundle.referee) {
    probabilityScore += 1;
  }

  /*
   * Real bookmaker shortening
   * is an additional positive signal.
   */
  if (
    movement.direction ===
    "SHORTENING"
  ) {
    probabilityScore += 2;
  }

  probabilityScore =
    clamp(
      probabilityScore
    );

  let valueScore = 0;

  if (
    value !== null
  ) {
    valueScore =
      clamp(
        20 + value * 2.5,
        0,
        100
      );
  }

  let score =
    probabilityScore;

  if (
    movement.direction ===
    "SHORTENING"
  ) {
    score += 2.5;
  }

  score =
    clamp(score);

  let qualificationType =
    null;

  let accepted = false;

  /*
   * HIGH PROBABILITY
   *
   * Probability >= 65%
   * Score >= 50
   * Value >= -8%
   * Odds >= 1.20
   */
  if (
    probability >=
      CONFIG.highProbabilityMin &&
    probabilityScore >=
      CONFIG.highProbabilityScoreMin &&
    value >=
      CONFIG.highProbabilityValueMin &&
    odds >=
      CONFIG.minimumOddsForHighProbability
  ) {
    accepted = true;

    qualificationType =
      movement.direction ===
      "SHORTENING"
        ? "HIGH_PROBABILITY_MOVEMENT"
        : "HIGH_PROBABILITY";
  }

  /*
   * STRONG PICK
   */
  else if (
    probability >=
      CONFIG.strongPickMin &&
    probabilityScore >=
      CONFIG.strongPickScoreMin &&
    value >=
      CONFIG.strongPickValueMin &&
    odds >=
      CONFIG.minimumOddsForHighProbability
  ) {
    accepted = true;

    qualificationType =
      "STRONG_PICK";
  }

  /*
   * VALUE
   */
  else if (
    probability >=
      CONFIG.valueMinProbability &&
    probabilityScore >=
      CONFIG.valueMinScore &&
    value >=
      CONFIG.valueMinValue
  ) {
    accepted = true;

    qualificationType =
      "VALUE";
  }

  const rejectionReasons = [];

  if (
    probability <
    CONFIG.highProbabilityMin
  ) {
    rejectionReasons.push(
      `Probability below ${CONFIG.highProbabilityMin}%`
    );
  }

  if (
    probabilityScore <
    CONFIG.highProbabilityScoreMin
  ) {
    rejectionReasons.push(
      `Probability score below ${CONFIG.highProbabilityScoreMin}`
    );
  }

  if (
    odds <
    CONFIG.minimumOddsForHighProbability
  ) {
    rejectionReasons.push(
      `Odds below ${CONFIG.minimumOddsForHighProbability}`
    );
  }

  if (
    probability <
      CONFIG.highProbabilityMin &&
    probability >=
      CONFIG.valueMinProbability &&
    value <
      CONFIG.valueMinValue
  ) {
    rejectionReasons.push(
      `Value below ${CONFIG.valueMinValue}%`
    );
  }

  if (
    probability >=
      CONFIG.highProbabilityMin &&
    value <
      CONFIG.highProbabilityValueMin
  ) {
    rejectionReasons.push(
      `Value below ${CONFIG.highProbabilityValueMin}%`
    );
  }

  let priceAssessment =
    "NORMAL_PRICE";

  if (
    value >= 5
  ) {
    priceAssessment =
      "VALUE_PRICE";
  } else if (
    value <= -8
  ) {
    priceAssessment =
      "EXPENSIVE_PRICE";
  }

  return {
    eventId: event.id,
    event: event.event,
    date: event.date,

    market,
    label,

    probability,
    odds,
    impliedProbability:
      implied,

    valuePercent:
      value,

    probabilityScore,
    valueScore,
    score,

    accepted,
    qualificationType,

    priceAssessment,

    movement,

    signal:
      movement.direction ===
      "SHORTENING"
        ? "SHORTENING"
        : movement.direction ===
          "DRIFTING"
          ? "DRIFTING"
          : "NONE",

    prediction:
      bundle.prediction,

    h2h:
      bundle.h2h,

    lineups:
      bundle.lineups,

    formAvailable:
      Boolean(bundle.form),

    statsAvailable:
      Boolean(bundle.stats),

    referee:
      bundle.referee,

    dataQuality:
      dataQuality(bundle),

    rejectionReasons:
      accepted
        ? []
        : rejectionReasons
  };
}

function buildCandidates(
  event,
  bundle
) {
  const markets = [
    ["home", "Home win"],
    ["draw", "Draw"],
    ["away", "Away win"],

    ["over15", "Over 1.5 goals"],
    ["over25", "Over 2.5 goals"],
    ["over35", "Over 3.5 goals"],

    ["bttsYes", "Both teams to score"]
  ];

  return markets
    .map(
      ([market, label]) =>
        createCandidate(
          event,
          bundle,
          market,
          label
        )
    )
    .filter(Boolean);
}

/*
 * ------------------------------------------------------------------
 * BUNDLE
 * ------------------------------------------------------------------
 */

async function getBundle(
  eventId,
  detail
) {
  const [
    predictionResult,
    oddsResult
  ] = await Promise.all([
    getPrediction(
      eventId,
      detail
    ),

    getOdds(
      eventId,
      detail
    )
  ]);

  const prediction =
    predictionResult.data;

  const odds =
    parseOdds(
      oddsResult.data
    );

  const h2h =
    parseH2H(detail);

  const lineups =
    parseLineups(detail);

  const form =
    parseForm(detail);

  const stats =
    parseStats(detail);

  const referee =
    parseReferee(detail);

  return {
    prediction,

    predictionAvailable:
      Boolean(prediction),

    odds,

    oddsAvailable:
      Boolean(odds),

    oddsRaw:
      Array.isArray(
        oddsResult.data
      )
        ? oddsResult.data
        : extractResults(
            oddsResult.data
          ),

    h2h,

    lineups,

    form,

    stats,

    referee,

    predictionDiagnostics:
      predictionResult.diagnostics ||
      null,

    oddsDiagnostics:
      oddsResult.diagnostics ||
      null
  };
}

/*
 * ------------------------------------------------------------------
 * ANALYZE EVENT
 * ------------------------------------------------------------------
 */

async function analyzeEvent(
  event
) {
  const detail =
    await getEventDetail(
      event.id
    );

  const mergedRaw = {
    ...(event.raw || {}),
    ...(detail || {}),
    id: event.id
  };

  const normalizedEvent =
    normalizeEvent(
      mergedRaw
    );

  const bundle =
    await getBundle(
      event.id,
      detail || event.raw
    );

  const candidates =
    buildCandidates(
      normalizedEvent,
      bundle
    );

  const accepted =
    candidates.filter(
      candidate =>
        candidate.accepted
    );

  return {
    event:
      normalizedEvent,

    predictionAvailable:
      bundle.predictionAvailable,

    oddsAvailable:
      bundle.oddsAvailable,

    prediction:
      bundle.prediction,

    odds:
      bundle.odds,

    h2h:
      bundle.h2h,

    lineups:
      bundle.lineups,

    formAvailable:
      Boolean(bundle.form),

    statsAvailable:
      Boolean(bundle.stats),

    referee:
      bundle.referee,

    dataQuality:
      dataQuality(bundle),

    candidates,

    acceptedCandidates:
      accepted,

    oddsDebug:
      bundle.oddsDiagnostics,

    predictionDebug:
      bundle.predictionDiagnostics
  };
}

/*
 * ------------------------------------------------------------------
 * RANKING
 * ------------------------------------------------------------------
 */

function rankingScore(
  candidate
) {
  let score =
    candidate.probabilityScore *
    0.75;

  if (
    candidate.movement?.direction ===
    "SHORTENING"
  ) {
    score += 5;
  }

  if (
    candidate.valuePercent !== null &&
    candidate.valuePercent >= 0
  ) {
    score += 5;
  }

  if (
    candidate.dataQuality >= 80
  ) {
    score += 3;
  }

  if (
    candidate.qualificationType ===
    "STRONG_PICK"
  ) {
    score += 4;
  }

  if (
    candidate.qualificationType ===
    "VALUE"
  ) {
    score += 2;
  }

  return score;
}

/*
 * ------------------------------------------------------------------
 * TOP PICKS
 * ------------------------------------------------------------------
 */

async function getTopPicks(
  dateInput
) {
  const date =
    normalizeDateInput(
      dateInput
    );

  const eventsResponse =
    await getEvents(date);

  const allEvents =
    eventsResponse.events;

  const upcomingEvents =
    allEvents
      .filter(
        isUpcomingEvent
      )
      .slice(
        0,
        MAX_EVENTS_ANALYZED
      );

  const excludedEvents =
    allEvents.length -
    upcomingEvents.length;

  const analyzed = [];

  for (
    const event of upcomingEvents
  ) {
    try {
      const result =
        await analyzeEvent(
          event
        );

      analyzed.push(result);

      await sleep(80);
    } catch (error) {
      analyzed.push({
        event,

        error:
          error.message,

        predictionAvailable:
          false,

        oddsAvailable:
          false,

        candidates: [],

        acceptedCandidates: []
      });
    }
  }

  const allAccepted =
    analyzed
      .flatMap(
        item =>
          item.acceptedCandidates ||
          []
      )
      .sort(
        (a, b) =>
          rankingScore(b) -
          rankingScore(a)
      );

  /*
   * MAXIMUM 5.
   *
   * We do not invent selections
   * just to fill the list.
   */
  const picks =
    allAccepted.slice(
      0,
      MAX_TOP_PICKS
    );

  const picksWithRank =
    picks.map(
      (pick, index) => ({
        rank:
          index + 1,
        ...pick
      })
    );

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    date,

    universe: {
      eventsReturned:
        allEvents.length,

      upcomingEvents:
        upcomingEvents.length,

      eventsAnalyzed:
        analyzed.length,

      eventsExcluded:
        excludedEvents,

      qualificationCount:
        allAccepted.length
    },

    filters: {
      highProbability: {
        probabilityMin:
          CONFIG.highProbabilityMin,

        scoreMin:
          CONFIG.highProbabilityScoreMin,

        valueMin:
          CONFIG.highProbabilityValueMin,

        minOdds:
          CONFIG.minimumOddsForHighProbability
      },

      strongPick: {
        probabilityMin:
          CONFIG.strongPickMin,

        scoreMin:
          CONFIG.strongPickScoreMin,

        valueMin:
          CONFIG.strongPickValueMin
      },

      value: {
        probabilityMin:
          CONFIG.valueMinProbability,

        scoreMin:
          CONFIG.valueMinScore,

        valueMin:
          CONFIG.valueMinValue
      },

      allowedStatuses:
        CONFIG.allowedStatuses,

      maxEventsAnalyzed:
        MAX_EVENTS_ANALYZED,

      maxTopPicks:
        MAX_TOP_PICKS
    },

    picks:
      picksWithRank,

    qualifiedCount:
      allAccepted.length,

    analyzed,

    exchange: {
      connected: false,

      status:
        "EXCHANGE_UNAVAILABLE",

      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated."
    }
  };
}

/*
 * ------------------------------------------------------------------
 * ROUTES
 * ------------------------------------------------------------------
 */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      maxTopPicks:
        MAX_TOP_PICKS,

      status:
        "online"
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      source:
        SOURCE,

      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        normalizeDateInput(
          req.query.date
        );

      const result =
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
          result.events.length,

        events:
          result.events
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        version:
          VERSION,

        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const eventId =
        Number(
          req.params.id
        );

      if (
        !Number.isFinite(
          eventId
        )
      ) {
        return res.status(400).json({
          ok: false,

          error:
            "Invalid event id"
        });
      }

      const detail =
        await getEventDetail(
          eventId
        );

      if (!detail) {
        return res.status(404).json({
          ok: false,

          version:
            VERSION,

          error:
            "Event not found"
        });
      }

      const event =
        normalizeEvent({
          ...detail,
          id: eventId
        });

      const result =
        await analyzeEvent(
          event
        );

      res.json({
        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        ...result
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        version:
          VERSION,

        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const result =
        await getTopPicks(
          req.query.date
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

app.get(
  "/api/exchange/status",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      exchange: {
        connected: false,

        status:
          "EXCHANGE_UNAVAILABLE",

        reason:
          "No verified betting-exchange feed is connected. No exchange signal is fabricated."
      }
    });
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      version:
        VERSION,

      error:
        "Route not found"
    });
  }
);

app.use(
  (error, req, res, next) => {
    console.error(
      "UNHANDLED ERROR:",
      error
    );

    res.status(500).json({
      ok: false,

      version:
        VERSION,

      error:
        error?.message ||
        "Internal server error"
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );

    console.log(
      `Maximum top picks: ${MAX_TOP_PICKS}`
    );
  }
);
