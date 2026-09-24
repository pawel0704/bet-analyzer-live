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

const VERSION = "6.5.3";
const SOURCE = "BSD";

const CONFIG = {
  maxEvents: 50,
  topPicksLimit: 10,

  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -6.5,
  minimumOddsForHighProbability: 1.20,

  strongPickProbabilityMin: 70,
  strongPickScoreMin: 60,
  strongPickValueMin: -3,

  valueProbabilityMin: 35,
  valueScoreMin: 55,
  valueMin: 5,

  requestTimeoutMs: 12000,
  retries: 1
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeDateInput(date) {
  if (!date) {
    return new Date().toISOString().slice(0, 10);
  }

  const match = String(date).match(/^(\d{4}-\d{2}-\d{2})/);

  return match ? match[1] : String(date);
}

function isUpcomingEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "notstarted",
    "not_started",
    "scheduled",
    "upcoming",
    "pending"
  ].includes(status);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bsdFetch(path) {
  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeoutMs
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json"
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
        const error = new Error(
          `BSD ${response.status}: ${
            typeof data === "string"
              ? data
              : JSON.stringify(data)
          }`
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
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt < CONFIG.retries) {
        await sleep(300);
      }
    }
  }

  return {
    ok: false,
    status: lastError?.status || null,
    error: lastError?.message || "BSD request failed",
    data: lastError?.data || null,
    url
  };
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

  if (Array.isArray(data.events)) {
    return data.events;
  }

  if (data.data && Array.isArray(data.data.results)) {
    return data.data.results;
  }

  if (data.odds && Array.isArray(data.odds.results)) {
    return data.odds.results;
  }

  return [];
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const id = num(
    firstDefined(
      event.id,
      event.event_id,
      event.eventId
    )
  );

  if (!id) {
    return null;
  }

  const home = firstDefined(
    event.home_team,
    event.homeTeam,
    event.home,
    event.home_name
  );

  const away = firstDefined(
    event.away_team,
    event.awayTeam,
    event.away,
    event.away_name
  );

  const date = firstDefined(
    event.event_date,
    event.date,
    event.start_time,
    event.startTime,
    event.kickoff
  );

  return {
    ...event,
    id,
    eventId: id,
    home: home || "Unknown",
    away: away || "Unknown",
    date: date || null,
    event_date: date || null,
    status: normalizeStatus(event.status),
    league:
      firstDefined(
        event.league_name,
        event.league,
        event.leagueName
      ),
    leagueId:
      num(
        firstDefined(
          event.league_id,
          event.leagueId
        )
      )
  };
}

async function getEvents(date) {
  const d = normalizeDateInput(date);

  const paths = [
    `/events/?date_from=${encodeURIComponent(d)}&date_to=${encodeURIComponent(d)}`,
    `/events?date_from=${encodeURIComponent(d)}&date_to=${encodeURIComponent(d)}`,
    `/events/?date=${encodeURIComponent(d)}`,
    `/events?date=${encodeURIComponent(d)}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (!result.ok) {
      continue;
    }

    const rows = extractResults(result.data);

    if (rows.length) {
      return rows
        .map(normalizeEvent)
        .filter(Boolean);
    }
  }

  return [];
}

async function getEventDetail(eventId) {
  const paths = [
    `/events/${eventId}/`,
    `/events/${eventId}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result.ok && result.data) {
      return result.data;
    }
  }

  return null;
}

async function getPrediction(eventId) {
  const paths = [
    `/events/${eventId}/prediction/`,
    `/events/${eventId}/prediction`,
    `/predictions/?event_id=${eventId}`,
    `/predictions?event_id=${eventId}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (!result.ok || !result.data) {
      continue;
    }

    if (Array.isArray(result.data.results)) {
      const matching =
        result.data.results.find(
          item =>
            num(
              firstDefined(
                item.event_id,
                item.event?.id,
                item.eventId
              )
            ) === eventId
        );

      if (matching) {
        return matching;
      }
    }

    return result.data;
  }

  return null;
}

/*
 * 6.5.3:
 *
 * Najważniejsza zmiana.
 *
 * W poprzednich wersjach BSD zwracało działające
 * odds przez ogólny resource:
 *
 *   /odds?event_id=ID
 *
 * lub jego wariant.
 *
 * Dlatego sprawdzamy wszystkie warianty i nie
 * zakładamy tylko /events/{id}/odds/.
 */
async function getOdds(eventId) {
  const paths = [
    `/odds/?event_id=${eventId}`,
    `/odds?event_id=${eventId}`,

    `/events/${eventId}/odds/`,
    `/events/${eventId}/odds`,

    `/odds/?event=${eventId}`,
    `/odds?event=${eventId}`,

    `/odds/?match_id=${eventId}`,
    `/odds?match_id=${eventId}`
  ];

  const attempts = [];

  for (const path of paths) {
    const result = await bsdFetch(path);

    attempts.push({
      path,
      ok: result.ok,
      status: result.status,
      count:
        extractResults(result.data).length
    });

    if (!result.ok || !result.data) {
      continue;
    }

    const rows =
      extractResults(result.data);

    /*
     * Musimy mieć faktyczne rekordy odds.
     * Sam pusty wrapper nie wystarcza.
     */
    if (rows.length > 0) {
      return {
        ...(
          typeof result.data === "object"
            ? result.data
            : {}
        ),

        results: rows,

        _debug: {
          endpoint:
            path,

          resultCount:
            rows.length,

          attempts
        }
      };
    }
  }

  return {
    results: [],

    _debug: {
      endpoint: null,
      resultCount: 0,
      attempts
    }
  };
}

async function getResource(resource, eventId) {
  const paths = [
    `/events/${eventId}/${resource}/`,
    `/events/${eventId}/${resource}`,
    `/${resource}/?event_id=${eventId}`,
    `/${resource}?event_id=${eventId}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result.ok && result.data) {
      return result.data;
    }
  }

  return null;
}

/* =========================================================
   PREDICTION
   ========================================================= */

function parsePrediction(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  let source = raw;

  if (
    raw.data &&
    typeof raw.data === "object"
  ) {
    source = raw.data;
  }

  if (
    source.results &&
    Array.isArray(source.results)
  ) {
    source =
      source.results[0] || {};
  }

  const markets =
    source.markets ||
    {};

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    {};

  const expectedGoals =
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

  const recommendations =
    source.recommendations ||
    {};

  const model =
    source.model ||
    {};

  const home = num(
    firstDefined(
      matchResult.prob_home,
      matchResult.home,
      source.prob_home,
      source.home
    )
  );

  const draw = num(
    firstDefined(
      matchResult.prob_draw,
      matchResult.draw,
      source.prob_draw,
      source.draw
    )
  );

  const away = num(
    firstDefined(
      matchResult.prob_away,
      matchResult.away,
      source.prob_away,
      source.away
    )
  );

  const over15 = num(
    firstDefined(
      overUnder.prob_over_15,
      overUnder.over15,
      source.prob_over_15,
      source.over15
    )
  );

  const over25 = num(
    firstDefined(
      overUnder.prob_over_25,
      overUnder.over25,
      source.prob_over_25,
      source.over25
    )
  );

  const over35 = num(
    firstDefined(
      overUnder.prob_over_35,
      overUnder.over35,
      source.prob_over_35,
      source.over35
    )
  );

  const bttsYes = num(
    firstDefined(
      btts.prob_yes,
      btts.yes,
      source.prob_btts_yes,
      source.bttsYes
    )
  );

  const xgHome = num(
    firstDefined(
      expectedGoals.home,
      source.xg_home,
      source.xgHome
    )
  );

  const xgAway = num(
    firstDefined(
      expectedGoals.away,
      source.xg_away,
      source.xgAway
    )
  );

  const confidence = num(
    firstDefined(
      model.confidence,
      source.confidence
    )
  );

  const predicted =
    firstDefined(
      matchResult.predicted,
      recommendations.favorite,
      source.predicted
    );

  const mostLikelyScore =
    firstDefined(
      score.most_likely,
      source.mostLikelyScore,
      source.most_likely_score
    );

  const available = [
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes
  ].some(
    value => value !== null
  );

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

    raw
  };
}

/* =========================================================
   ODDS
   ========================================================= */

function parseOdds(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const rows =
    extractResults(raw);

  const findRow = (
    market,
    outcome
  ) => {
    return rows.find(row => {
      if (
        String(row.market || "")
          .toLowerCase() !==
        market.toLowerCase()
      ) {
        return false;
      }

      if (
        String(row.outcome || "")
          .toLowerCase() !==
        outcome.toLowerCase()
      ) {
        return false;
      }

      return true;
    });
  };

  const rowData = row => {
    if (!row) {
      return null;
    }

    const current =
      num(
        firstDefined(
          row.decimal_odds,
          row.odds,
          row.price
        )
      );

    const previous =
      num(
        row.previous_decimal_odds
      );

    const opening =
      num(
        row.opening_decimal_odds
      );

    const changePercent =
      current !== null &&
      previous !== null &&
      previous > 0
        ? Number(
            (
              (
                current -
                previous
              ) /
              previous *
              100
            ).toFixed(2)
          )
        : null;

    const openingChangePercent =
      current !== null &&
      opening !== null &&
      opening > 0
        ? Number(
            (
              (
                current -
                opening
              ) /
              opening *
              100
            ).toFixed(2)
          )
        : null;

    return {
      odds: current,

      previousOdds:
        previous,

      openingOdds:
        opening,

      changePercent,

      openingChangePercent,

      movement:
        row.movement || null,

      updatedAt:
        row.updated_at || null,

      openingAt:
        row.opening_at || null,

      bookmaker:
        row.bookmaker_name ||
        row.bookmaker_slug ||
        null,

      bookmakerCount:
        num(row.bookmaker_count),

      impliedProbability:
        current !== null &&
        current > 1
          ? Number(
              (
                100 /
                current
              ).toFixed(2)
            )
          : null
    };
  };

  const home =
    rowData(
      findRow(
        "1x2",
        "HOME"
      )
    );

  const draw =
    rowData(
      findRow(
        "1x2",
        "DRAW"
      )
    );

  const away =
    rowData(
      findRow(
        "1x2",
        "AWAY"
      )
    );

  const over15 =
    rowData(
      findRow(
        "over_under_15",
        "over"
      )
    );

  const under15 =
    rowData(
      findRow(
        "over_under_15",
        "under"
      )
    );

  const over25 =
    rowData(
      findRow(
        "over_under_25",
        "over"
      )
    );

  const under25 =
    rowData(
      findRow(
        "over_under_25",
        "under"
      )
    );

  const over35 =
    rowData(
      findRow(
        "over_under_35",
        "over"
      )
    );

  const under35 =
    rowData(
      findRow(
        "over_under_35",
        "under"
      )
    );

  const bttsYes =
    rowData(
      findRow(
        "btts",
        "yes"
      )
    );

  const bttsNo =
    rowData(
      findRow(
        "btts",
        "no"
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
  ].some(
    item =>
      item?.odds !== null &&
      item?.odds !== undefined
  );

  const movementRows =
    rows
      .map(row => {
        const current =
          num(row.decimal_odds);

        const previous =
          num(
            row.previous_decimal_odds
          );

        const opening =
          num(
            row.opening_decimal_odds
          );

        return {
          market:
            row.market || null,

          outcome:
            row.outcome || null,

          current,

          previous,

          opening,

          movement:
            row.movement || null,

          changePercent:
            current !== null &&
            previous !== null &&
            previous > 0
              ? Number(
                  (
                    (
                      current -
                      previous
                    ) /
                    previous *
                    100
                  ).toFixed(2)
                )
              : null,

          openingChangePercent:
            current !== null &&
            opening !== null &&
            opening > 0
              ? Number(
                  (
                    (
                      current -
                      opening
                    ) /
                    opening *
                    100
                  ).toFixed(2)
                )
              : null,

          bookmakerCount:
            num(
              row.bookmaker_count
            ),

          updatedAt:
            row.updated_at || null
        };
      })
      .filter(
        row =>
          row.current !== null
      );

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

    rows:
      movementRows,

    debug: {
      resultCount:
        rows.length,

      endpoint:
        raw._debug?.endpoint ||
        null,

      attempts:
        raw._debug?.attempts ||
        []
    },

    raw
  };
}

/* =========================================================
   H2H
   ========================================================= */

function parseH2H(raw, eventDetail) {
  let source =
    raw?.head_to_head ||
    raw?.h2h ||
    raw?.data?.head_to_head ||
    raw?.data ||
    null;

  if (!source) {
    source =
      eventDetail?.head_to_head ||
      eventDetail?.h2h ||
      null;
  }

  if (!source) {
    return {
      available: false,
      sampleSize: 0
    };
  }

  const matches =
    safeArray(
      source.recent_matches ||
      source.matches
    );

  const sampleSize =
    num(
      firstDefined(
        source.total_matches,
        source.sample_size,
        matches.length
      )
    ) || 0;

  return {
    available:
      sampleSize > 0 ||
      matches.length > 0,

    sampleSize,

    homeWins:
      num(
        firstDefined(
          source.home_wins,
          source.homeWins
        )
      ),

    draws:
      num(source.draws),

    awayWins:
      num(
        firstDefined(
          source.away_wins,
          source.awayWins
        )
      ),

    homeGoals:
      num(
        firstDefined(
          source.home_goals,
          source.homeGoals
        )
      ),

    awayGoals:
      num(
        firstDefined(
          source.away_goals,
          source.awayGoals
        )
      ),

    averageGoals:
      num(
        firstDefined(
          source.avg_total_goals,
          source.average_goals
        )
      ),

    matches,

    raw
  };
}

/* =========================================================
   LINEUPS
   ========================================================= */

function parseLineups(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.lineups ||
    raw.data?.lineups ||
    raw.data ||
    {};

  const home =
    source.home ||
    source.home_team ||
    {};

  const away =
    source.away ||
    source.away_team ||
    {};

  const homePlayers =
    safeArray(
      home.players
    );

  const awayPlayers =
    safeArray(
      away.players
    );

  const homeCount =
    num(
      firstDefined(
        home.players_count,
        homePlayers.length
      )
    ) || 0;

  const awayCount =
    num(
      firstDefined(
        away.players_count,
        awayPlayers.length
      )
    ) || 0;

  const status =
    firstDefined(
      raw.lineup_status,
      raw.status
    );

  return {
    available:
      homeCount > 0 ||
      awayCount > 0 ||
      Boolean(status),

    score:
      homeCount >= 11 &&
      awayCount >= 11
        ? 2
        : 1,

    details: {
      homePlayers:
        homeCount,

      awayPlayers:
        awayCount,

      completeHome:
        homeCount >= 11,

      completeAway:
        awayCount >= 11,

      homeFormation:
        home.formation ||
        null,

      awayFormation:
        away.formation ||
        null,

      status:
        status ||
        null
    },

    raw
  };
}

/* =========================================================
   FORM / STATS / REFEREE
   ========================================================= */

function parseForm(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.form ||
    raw.data ||
    raw;

  const matches =
    safeArray(
      source.matches ||
      source.recent ||
      source.results
    );

  return {
    available:
      matches.length > 0,

    matches,

    raw
  };
}

function parseStats(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.stats ||
    raw.data?.stats ||
    raw.data ||
    raw;

  const home =
    source.home ||
    {};

  const away =
    source.away ||
    {};

  const xgHome =
    num(
      firstDefined(
        home.xg?.estimated,
        home.xg?.actual
      )
    );

  const xgAway =
    num(
      firstDefined(
        away.xg?.estimated,
        away.xg?.actual
      )
    );

  return {
    available:
      xgHome !== null ||
      xgAway !== null,

    xgHome,
    xgAway,

    raw
  };
}

function parseReferee(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.referee ||
    raw.data ||
    raw;

  return {
    available:
      Boolean(
        source.id ||
        source.name ||
        source.referee_id ||
        source.referee_name
      ),

    id:
      firstDefined(
        source.id,
        source.referee_id
      ),

    name:
      firstDefined(
        source.name,
        source.referee_name
      ),

    raw
  };
}

/* =========================================================
   MOVEMENT
   ========================================================= */

function getMovementForMarket(
  oddsEntry,
  market,
  outcome
) {
  if (!oddsEntry?.rows) {
    return null;
  }

  return (
    oddsEntry.rows.find(
      row =>
        String(row.market)
          .toLowerCase() ===
          market.toLowerCase() &&
        String(row.outcome)
          .toLowerCase() ===
          outcome.toLowerCase()
    ) || null
  );
}

/* =========================================================
   SCORING
   ========================================================= */

function impliedProbability(odds) {
  const o = num(odds);

  if (!o || o <= 1) {
    return null;
  }

  return 100 / o;
}

function calculateValue(
  probability,
  odds
) {
  const p = num(probability);
  const o = num(odds);

  if (
    p === null ||
    o === null ||
    o <= 1
  ) {
    return null;
  }

  return (
    p -
    impliedProbability(o)
  );
}

function dataQuality(bundle) {
  let score = 0;

  if (
    bundle.prediction.available
  ) {
    score += 3;
  }

  if (
    bundle.prediction.xgHome !== null &&
    bundle.prediction.xgAway !== null
  ) {
    score += 2;
  }

  if (
    bundle.lineups.available
  ) {
    score += 2;
  }

  if (
    bundle.lineups.details?.completeHome &&
    bundle.lineups.details?.completeAway
  ) {
    score += 1;
  }

  if (
    bundle.h2h.sampleSize >= 3
  ) {
    score += 1;
  }

  if (
    bundle.form.available
  ) {
    score += 2;
  }

  if (
    bundle.referee.available
  ) {
    score += 1;
  }

  if (
    bundle.stats.available
  ) {
    score += 1;
  }

  return score;
}

function createCandidate(
  market,
  label,
  probability,
  oddsData,
  movementData,
  bundle
) {
  const p = num(probability);
  const o = num(
    oddsData?.odds
  );

  if (
    p === null ||
    o === null ||
    o <= 1
  ) {
    return null;
  }

  const implied =
    impliedProbability(o);

  const value =
    calculateValue(
      p,
      o
    );

  let probabilityScore =
    p * 0.75;

  if (
    bundle.prediction.xgHome !== null &&
    bundle.prediction.xgAway !== null
  ) {
    probabilityScore += 3;
  }

  if (
    bundle.lineups.available
  ) {
    probabilityScore += 3;
  }

  if (
    bundle.lineups.details?.completeHome &&
    bundle.lineups.details?.completeAway
  ) {
    probabilityScore += 1;
  }

  if (
    bundle.form.available
  ) {
    probabilityScore += 3;
  }

  if (
    bundle.h2h.sampleSize >= 3
  ) {
    probabilityScore += 1;
  }

  if (
    bundle.referee.available
  ) {
    probabilityScore += 1;
  }

  if (
    movementData?.movement ===
    "SHORTENING"
  ) {
    probabilityScore += 2;
  }

  probabilityScore =
    Number(
      clamp(
        probabilityScore,
        0,
        100
      ).toFixed(2)
    );

  let valueScore =
    p * 0.70;

  if (value !== null) {
    valueScore +=
      clamp(
        value,
        -10,
        10
      ) * 2;
  }

  if (
    bundle.prediction.xgHome !== null &&
    bundle.prediction.xgAway !== null
  ) {
    valueScore += 2;
  }

  if (
    bundle.h2h.sampleSize >= 3
  ) {
    valueScore += 1;
  }

  if (
    bundle.lineups.available
  ) {
    valueScore += 2;
  }

  if (
    bundle.form.available
  ) {
    valueScore += 2;
  }

  valueScore =
    Number(
      clamp(
        valueScore,
        0,
        100
      ).toFixed(2)
    );

  const reasons = [];
  const rejectionReasons = [];

  if (p >= 65) {
    reasons.push(
      "High model probability"
    );
  }

  if (
    bundle.prediction.xgHome !== null &&
    bundle.prediction.xgAway !== null
  ) {
    reasons.push(
      "Expected-goals data available"
    );
  }

  if (
    bundle.lineups.details?.completeHome &&
    bundle.lineups.details?.completeAway
  ) {
    reasons.push(
      "Confirmed lineup data available"
    );
  }

  if (
    bundle.h2h.sampleSize >= 3
  ) {
    reasons.push(
      "H2H sample available"
    );
  }

  if (
    movementData?.movement ===
    "SHORTENING"
  ) {
    reasons.push(
      "Real bookmaker shortening"
    );
  }

  if (
    movementData?.movement ===
    "DRIFTING"
  ) {
    reasons.push(
      "Real bookmaker drift"
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

  const highProbability =
    p >=
      CONFIG.highProbabilityMin &&
    probabilityScore >=
      CONFIG.highProbabilityScoreMin &&
    (value === null ||
      value >=
        CONFIG.highProbabilityValueMin) &&
    o >=
      CONFIG.minimumOddsForHighProbability;

  const strongPick =
    highProbability &&
    p >=
      CONFIG.strongPickProbabilityMin &&
    probabilityScore >=
      CONFIG.strongPickScoreMin &&
    (value === null ||
      value >=
        CONFIG.strongPickValueMin);

  const valuePick =
    p >=
      CONFIG.valueProbabilityMin &&
    valueScore >=
      CONFIG.valueScoreMin &&
    value !== null &&
    value >=
      CONFIG.valueMin &&
    o >= 1.20;

  let accepted = false;
  let qualificationType = "NONE";

  if (strongPick) {
    accepted = true;
    qualificationType =
      "STRONG_PICK";
  } else if (highProbability) {
    accepted = true;
    qualificationType =
      "HIGH_PROBABILITY";
  } else if (valuePick) {
    accepted = true;
    qualificationType =
      "VALUE";
  }

  if (!accepted) {
    if (
      o <
      CONFIG.minimumOddsForHighProbability
    ) {
      rejectionReasons.push(
        `Odds below ${CONFIG.minimumOddsForHighProbability}`
      );
    }

    if (
      p <
      CONFIG.valueProbabilityMin
    ) {
      rejectionReasons.push(
        `Probability below ${CONFIG.valueProbabilityMin}%`
      );
    }

    if (
      p >=
        CONFIG.highProbabilityMin &&
      probabilityScore <
        CONFIG.highProbabilityScoreMin
    ) {
      rejectionReasons.push(
        `Probability score below ${CONFIG.highProbabilityScoreMin}`
      );
    }

    if (
      p >=
        CONFIG.highProbabilityMin &&
      value !== null &&
      value <
        CONFIG.highProbabilityValueMin
    ) {
      rejectionReasons.push(
        `Value below ${CONFIG.highProbabilityValueMin}%`
      );
    }

    if (
      p >= 35 &&
      value !== null &&
      value < CONFIG.valueMin
    ) {
      rejectionReasons.push(
        `Value below ${CONFIG.valueMin}%`
      );
    }
  }

  let priceAssessment =
    "UNKNOWN";

  if (value !== null) {
    if (value >= 5) {
      priceAssessment =
        "GOOD_VALUE";
    } else if (value >= 0) {
      priceAssessment =
        "FAIR_PRICE";
    } else if (value >= -3) {
      priceAssessment =
        "SLIGHTLY_EXPENSIVE";
    } else if (value >= -6.5) {
      priceAssessment =
        "NORMAL_PRICE";
    } else {
      priceAssessment =
        "EXPENSIVE";
    }
  }

  return {
    market,
    label,

    probability:
      Number(
        p.toFixed(2)
      ),

    odds:
      Number(
        o.toFixed(3)
      ),

    impliedProbability:
      implied === null
        ? null
        : Number(
            implied.toFixed(2)
          ),

    valuePercent:
      value === null
        ? null
        : Number(
            value.toFixed(2)
          ),

    probabilityScore,
    valueScore,

    score:
      probabilityScore,

    dataQuality:
      dataQuality(bundle),

    accepted,
    qualificationType,

    priceAssessment,

    reasons,
    rejectionReasons,

    movement:
      movementData || {
        movement: null
      },

    eventId:
      bundle.event.id,

    home:
      bundle.event.home,

    away:
      bundle.event.away,

    date:
      bundle.event.date,

    status:
      bundle.event.status,

    league:
      bundle.event.league,

    prediction:
      bundle.prediction,

    h2h:
      bundle.h2h,

    lineups:
      bundle.lineups,

    form:
      bundle.form,

    stats:
      bundle.stats,

    referee:
      bundle.referee
  };
}

/* =========================================================
   CANDIDATES
   ========================================================= */

function buildCandidates(bundle) {
  if (
    !bundle.prediction.available ||
    !bundle.odds.available
  ) {
    return [];
  }

  const candidates = [];

  function add(
    market,
    label,
    probability,
    oddsKey,
    movementMarket,
    movementOutcome
  ) {
    const oddsData =
      bundle.odds[oddsKey];

    if (!oddsData) {
      return;
    }

    const movement =
      getMovementForMarket(
        bundle.odds,
        movementMarket,
        movementOutcome
      );

    const candidate =
      createCandidate(
        market,
        label,
        probability,
        oddsData,
        movement,
        bundle
      );

    if (candidate) {
      candidates.push(
        candidate
      );
    }
  }

  add(
    "home",
    "Home win",
    bundle.prediction.home,
    "home",
    "1x2",
    "HOME"
  );

  add(
    "draw",
    "Draw",
    bundle.prediction.draw,
    "draw",
    "1x2",
    "DRAW"
  );

  add(
    "away",
    "Away win",
    bundle.prediction.away,
    "away",
    "1x2",
    "AWAY"
  );

  add(
    "over15",
    "Over 1.5 goals",
    bundle.prediction.over15,
    "over15",
    "over_under_15",
    "over"
  );

  add(
    "over25",
    "Over 2.5 goals",
    bundle.prediction.over25,
    "over25",
    "over_under_25",
    "over"
  );

  add(
    "over35",
    "Over 3.5 goals",
    bundle.prediction.over35,
    "over35",
    "over_under_35",
    "over"
  );

  add(
    "bttsYes",
    "Both teams to score",
    bundle.prediction.bttsYes,
    "bttsYes",
    "btts",
    "yes"
  );

  return candidates;
}

/* =========================================================
   BUNDLE
   ========================================================= */

async function getBundle(event) {
  const eventId =
    event.id;

  const [
    detailRaw,
    predictionRaw,
    oddsRaw,
    h2hRaw,
    formRaw,
    statsRaw,
    lineupsRaw,
    refereeRaw
  ] = await Promise.all([
    getEventDetail(eventId),
    getPrediction(eventId),
    getOdds(eventId),
    getResource("h2h", eventId),
    getResource("form", eventId),
    getResource("stats", eventId),
    getResource("lineups", eventId),
    getResource("referee", eventId)
  ]);

  const detailEvent =
    detailRaw?.event ||
    detailRaw ||
    {};

  const mergedEvent =
    normalizeEvent({
      ...event,
      ...detailEvent,

      id:
        firstDefined(
          detailEvent.id,
          event.id
        ),

      home_team:
        firstDefined(
          detailEvent.home_team,
          event.home
        ),

      away_team:
        firstDefined(
          detailEvent.away_team,
          event.away
        ),

      event_date:
        firstDefined(
          detailEvent.event_date,
          event.date
        ),

      status:
        firstDefined(
          detailEvent.status,
          event.status
        ),

      league_name:
        firstDefined(
          detailEvent.league_name,
          event.league
        ),

      league_id:
        firstDefined(
          detailEvent.league_id,
          event.leagueId
        )
    });

  return {
    event:
      mergedEvent ||
      event,

    prediction:
      parsePrediction(
        predictionRaw
      ),

    odds:
      parseOdds(
        oddsRaw
      ),

    h2h:
      parseH2H(
        h2hRaw,
        detailRaw
      ),

    form:
      parseForm(
        formRaw
      ),

    stats:
      parseStats(
        statsRaw
      ),

    lineups:
      parseLineups(
        lineupsRaw
      ),

    referee:
      parseReferee(
        refereeRaw
      )
  };
}

/* =========================================================
   ANALYZE
   ========================================================= */

async function analyzeEvent(event) {
  try {
    const bundle =
      await getBundle(
        event
      );

    const candidates =
      buildCandidates(
        bundle
      );

    const accepted =
      candidates
        .filter(
          candidate =>
            candidate.accepted
        )
        .sort(
          (a, b) =>
            (
              b.probabilityScore -
              a.probabilityScore
            ) ||
            (
              b.valueScore -
              a.valueScore
            )
        );

    return {
      ok: true,
      version:
        VERSION,
      source:
        SOURCE,

      event:
        bundle.event,

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

      candidates,

      acceptedCandidates:
        accepted,

      bestPick:
        accepted[0] ||
        null
    };
  } catch (error) {
    return {
      ok: false,
      version:
        VERSION,
      source:
        SOURCE,
      event,
      error:
        error.message
    };
  }
}

/* =========================================================
   RANKING
   ========================================================= */

function rankingScore(pick) {
  const typeWeight = {
    STRONG_PICK: 30,
    HIGH_PROBABILITY: 20,
    VALUE: 10
  };

  let score =
    typeWeight[
      pick.qualificationType
    ] || 0;

  score +=
    pick.probabilityScore ||
    0;

  score +=
    Math.min(
      pick.dataQuality ||
      0,
      14
    ) * 0.4;

  if (
    pick.valuePercent !== null
  ) {
    score +=
      clamp(
        pick.valuePercent,
        -6.5,
        10
      ) * 0.8;
  }

  if (
    pick.movement?.movement ===
    "SHORTENING"
  ) {
    score += 2.5;
  }

  if (
    pick.movement?.movement ===
    "DRIFTING"
  ) {
    score -= 1;
  }

  return Number(
    score.toFixed(2)
  );
}

/* =========================================================
   TOP PICKS
   ========================================================= */

async function getTopPicks(date) {
  const dateValue =
    normalizeDateInput(
      date
    );

  const allEvents =
    await getEvents(
      dateValue
    );

  const upcoming =
    allEvents
      .filter(
        isUpcomingEvent
      )
      .sort(
        (a, b) =>
          new Date(
            a.date || 0
          ).getTime() -
          new Date(
            b.date || 0
          ).getTime()
      )
      .slice(
        0,
        CONFIG.maxEvents
      );

  const analyzed = [];

  for (
    const event of upcoming
  ) {
    analyzed.push(
      await analyzeEvent(
        event
      )
    );

    await sleep(70);
  }

  const allAccepted = [];

  for (
    const result of analyzed
  ) {
    if (!result.ok) {
      continue;
    }

    for (
      const pick of
      result.acceptedCandidates ||
      []
    ) {
      pick.rankingScore =
        rankingScore(
          pick
        );

      allAccepted.push(
        pick
      );
    }
  }

  const bestPerEvent =
    new Map();

  for (
    const pick of allAccepted
  ) {
    const current =
      bestPerEvent.get(
        pick.eventId
      );

    if (
      !current ||
      pick.rankingScore >
        current.rankingScore
    ) {
      bestPerEvent.set(
        pick.eventId,
        pick
      );
    }
  }

  let selected =
    Array.from(
      bestPerEvent.values()
    ).sort(
      (a, b) =>
        b.rankingScore -
        a.rankingScore
    );

  if (
    selected.length <
    CONFIG.topPicksLimit
  ) {
    const selectedKeys =
      new Set(
        selected.map(
          pick =>
            `${pick.eventId}:${pick.market}`
        )
      );

    const secondary =
      allAccepted
        .filter(
          pick =>
            !selectedKeys.has(
              `${pick.eventId}:${pick.market}`
            )
        )
        .sort(
          (a, b) =>
            b.rankingScore -
            a.rankingScore
        );

    for (
      const pick of secondary
    ) {
      if (
        selected.length >=
        CONFIG.topPicksLimit
      ) {
        break;
      }

      const key =
        `${pick.eventId}:${pick.market}`;

      if (
        selectedKeys.has(
          key
        )
      ) {
        continue;
      }

      selected.push(
        pick
      );

      selectedKeys.add(
        key
      );
    }
  }

  const analyzedSummary =
    analyzed.map(
      result => {
        const diagnostics =
          (
            result.candidates ||
            []
          ).map(
            candidate => ({
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

              probabilityScore:
                candidate.probabilityScore,

              valueScore:
                candidate.valueScore,

              movement:
                candidate.movement,

              accepted:
                candidate.accepted,

              qualificationType:
                candidate.qualificationType,

              rejectionReasons:
                candidate.rejectionReasons
            })
          );

        return {
          eventId:
            result.event?.id,

          home:
            result.event?.home,

          away:
            result.event?.away,

          date:
            result.event?.date,

          status:
            result.event?.status,

          predictionAvailable:
            Boolean(
              result.prediction?.available
            ),

          oddsAvailable:
            Boolean(
              result.odds?.available
            ),

          predictionMarkets:
            result.prediction?.available
              ? {
                  home:
                    result.prediction.home,

                  draw:
                    result.prediction.draw,

                  away:
                    result.prediction.away,

                  over15:
                    result.prediction.over15,

                  over25:
                    result.prediction.over25,

                  over35:
                    result.prediction.over35,

                  bttsYes:
                    result.prediction.bttsYes
                }
              : null,

          oddsMarkets:
            result.odds?.available
              ? {
                  home:
                    result.odds.home?.odds,

                  draw:
                    result.odds.draw?.odds,

                  away:
                    result.odds.away?.odds,

                  over15:
                    result.odds.over15?.odds,

                  over25:
                    result.odds.over25?.odds,

                  over35:
                    result.odds.over35?.odds,

                  bttsYes:
                    result.odds.bttsYes?.odds
                }
              : null,

          oddsDebug:
            result.odds?.debug ||
            null,

          qualified:
            result.acceptedCandidates
              ?.length ||
            0,

          bestPick:
            result.bestPick
              ? {
                  market:
                    result.bestPick.market,

                  label:
                    result.bestPick.label,

                  probability:
                    result.bestPick.probability,

                  odds:
                    result.bestPick.odds,

                  valuePercent:
                    result.bestPick.valuePercent,

                  probabilityScore:
                    result.bestPick.probabilityScore,

                  qualificationType:
                    result.bestPick.qualificationType
                }
              : null,

          diagnostics,

          error:
            result.ok
              ? null
              : result.error
        };
      }
    );

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    date:
      dateValue,

    universe: {
      eventsReturned:
        allEvents.length,

      upcomingEvents:
        upcoming.length,

      eventsAnalyzed:
        analyzed.length,

      eventsExcluded:
        Math.max(
          0,
          allEvents.length -
            upcoming.length
        ),

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
          CONFIG.strongPickProbabilityMin,

        scoreMin:
          CONFIG.strongPickScoreMin,

        valueMin:
          CONFIG.strongPickValueMin
      },

      value: {
        probabilityMin:
          CONFIG.valueProbabilityMin,

        scoreMin:
          CONFIG.valueScoreMin,

        valueMin:
          CONFIG.valueMin
      },

      allowedStatuses: [
        "notstarted",
        "not_started",
        "scheduled",
        "upcoming",
        "pending"
      ],

      maxEventsAnalyzed:
        CONFIG.maxEvents,

      maxTopPicks:
        CONFIG.topPicksLimit
    },

    picks:
      selected,

    qualifiedCount:
      selected.length,

    analyzed:
      analyzedSummary,

    exchange: {
      connected: false,
      status:
        "EXCHANGE_UNAVAILABLE",
      reason:
        "No verified betting-exchange feed is connected. No exchange signal is fabricated."
    }
  };
}

/* =========================================================
   ROUTES
   ========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name:
      "Bet Analyzer Live",
    version:
      VERSION,
    source:
      SOURCE,
    status:
      "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version:
      VERSION,
    source:
      SOURCE,
    status:
      "healthy",
    timestamp:
      new Date().toISOString()
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
        events
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

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const eventId =
        num(
          req.params.id
        );

      if (!eventId) {
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

      let event =
        normalizeEvent(
          detail?.event ||
          detail
        );

      if (!event) {
        event = {
          id:
            eventId,

          eventId:
            eventId,

          home:
            "Unknown",

          away:
            "Unknown",

          status:
            "notstarted",

          date:
            null,

          league:
            null,

          leagueId:
            null
        };
      }

      const result =
        await analyzeEvent(
          event
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
          error.message
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
      console.error(error);

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

      source:
        SOURCE,

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
      source:
        SOURCE,
      error:
        "Endpoint not found"
    });
  }
);

app.use(
  (error, req, res, next) => {
    console.error(error);

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

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
    );
  }
);
