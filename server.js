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

const VERSION = "7.0.8";
const SOURCE = "BSD";

if (!BSD_API_KEY) {
  console.error("ERROR: BSD_API_KEY is missing");
}

const headers = {
  Authorization: `Token ${BSD_API_KEY}`,
  Accept: "application/json",
};

const EXCHANGE = {
  connected: false,
  status: "NOT_CONNECTED",
  message:
    "Betting exchange data is not connected. No exchange movement is fabricated.",
};

function round(value, digits = 3) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function pct(value) {
  if (value === null || value === undefined) return null;

  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  return n <= 1 ? n * 100 : n;
}

function normalizeConfidence(value) {
  if (value === null || value === undefined) return null;

  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  return n <= 1 ? n * 100 : n;
}

function safeDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) return null;

  return d;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
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
}

function getRows(data, keys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  return [];
}

/* =========================================================
   EVENT HELPERS
   ========================================================= */

function getEventId(row) {
  return (
    row?.id ??
    row?.event_id ??
    row?.event?.id ??
    null
  );
}

function getEventStatus(row) {
  return String(
    row?.status ??
      row?.event?.status ??
      ""
  ).toLowerCase();
}

function getEventDate(row) {
  return (
    row?.date ??
    row?.event_date ??
    row?.start_time ??
    row?.kickoff ??
    row?.event?.date ??
    row?.event?.event_date ??
    row?.event?.start_time ??
    null
  );
}

function getHomeTeam(row) {
  return (
    row?.home_team ??
    row?.home ??
    row?.event?.home_team ??
    row?.event?.home ??
    "Home"
  );
}

function getAwayTeam(row) {
  return (
    row?.away_team ??
    row?.away ??
    row?.event?.away_team ??
    row?.event?.away ??
    "Away"
  );
}

function getLeague(row) {
  return (
    row?.league?.name ??
    row?.league_name ??
    row?.event?.league?.name ??
    row?.event?.league_name ??
    null
  );
}

/* =========================================================
   UPCOMING EVENTS
   ========================================================= */

async function fetchUpcomingEvents(date) {
  const url =
    `${BSD_BASE}/events/` +
    `?date_from=${encodeURIComponent(date)}` +
    `&date_to=${encodeURIComponent(date)}` +
    `&status=upcoming` +
    `&limit=200` +
    `&offset=0`;

  return fetchJson(url);
}

/* =========================================================
   PREDICTION FOR EVENT
   ========================================================= */

async function fetchEventPrediction(eventId) {
  const url =
    `${BSD_BASE}/events/${encodeURIComponent(eventId)}/prediction/`;

  return fetchJson(url);
}

/* =========================================================
   PREDICTION EXTRACTION
   ========================================================= */

function getPredictionObject(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (data?.prediction && typeof data.prediction === "object") {
    return data.prediction;
  }

  if (data?.data?.prediction) {
    return data.data.prediction;
  }

  return data;
}

function getMarkets(prediction) {
  return prediction?.markets || {};
}

function getConfidence(prediction) {
  return normalizeConfidence(
    prediction?.model?.confidence ??
      prediction?.confidence ??
      prediction?.model_confidence ??
      null
  );
}

function getPredictionRecommendation(prediction) {
  return (
    prediction?.recommendations ??
    null
  );
}

/* =========================================================
   CANDIDATES
   ========================================================= */

function buildCandidates(event, prediction) {
  const markets = getMarkets(prediction);

  const matchResult =
    markets.match_result || {};

  const overUnder =
    markets.over_under || {};

  const btts =
    markets.btts || {};

  const confidence =
    getConfidence(prediction);

  const candidates = [];

  const homeProb =
    pct(matchResult.prob_home);

  const drawProb =
    pct(matchResult.prob_draw);

  const awayProb =
    pct(matchResult.prob_away);

  const over15 =
    pct(overUnder.prob_over_15);

  const over25 =
    pct(overUnder.prob_over_25);

  const over35 =
    pct(overUnder.prob_over_35);

  const bttsYes =
    pct(btts.prob_yes);

  const add = (
    market,
    pick,
    marketKey,
    probability,
    recommendationStrength = 0
  ) => {
    if (
      probability === null ||
      probability === undefined ||
      !Number.isFinite(Number(probability))
    ) {
      return;
    }

    candidates.push({
      eventId: getEventId(event),

      event:
        `${getHomeTeam(event)} – ${getAwayTeam(event)}`,

      home: getHomeTeam(event),
      away: getAwayTeam(event),

      date: getEventDate(event),

      league: getLeague(event),

      market,
      pick,
      marketKey,

      probability:
        round(Number(probability), 1),

      confidence:
        round(confidence, 2),

      odds: null,

      fairOdds:
        Number(probability) > 0
          ? round(
              100 / Number(probability),
              3
            )
          : null,

      value: null,

      recommendationStrength,

      bsdRecommendation:
        getPredictionRecommendation(
          prediction
        ),

      score: null,

      oddsSource: "UNAVAILABLE",

      bookmaker: null,

      marketMovement: null,

      exchangeMovement: null,

      status:
        getEventStatus(event) ||
        "upcoming",
    });
  };

  /*
   * EXISTING MARKET GENERATION
   * No ranking weights changed.
   */

  if (
    homeProb !== null &&
    drawProb !== null
  ) {
    add(
      "DOUBLE_CHANCE",
      "1X",
      "1X",
      homeProb + drawProb
    );
  }

  if (
    awayProb !== null &&
    drawProb !== null
  ) {
    add(
      "DOUBLE_CHANCE",
      "X2",
      "X2",
      awayProb + drawProb
    );
  }

  if (homeProb !== null) {
    add(
      "1X2",
      "1",
      "HOME",
      homeProb
    );
  }

  if (drawProb !== null) {
    add(
      "1X2",
      "X",
      "DRAW",
      drawProb
    );
  }

  if (awayProb !== null) {
    add(
      "1X2",
      "2",
      "AWAY",
      awayProb
    );
  }

  if (over15 !== null) {
    add(
      "TOTAL",
      "OVER 1.5",
      "OVER15",
      over15
    );

    add(
      "TOTAL",
      "UNDER 1.5",
      "UNDER15",
      100 - over15
    );
  }

  if (over25 !== null) {
    add(
      "TOTAL",
      "OVER 2.5",
      "OVER25",
      over25
    );

    add(
      "TOTAL",
      "UNDER 2.5",
      "UNDER25",
      100 - over25
    );
  }

  if (over35 !== null) {
    add(
      "TOTAL",
      "OVER 3.5",
      "OVER35",
      over35
    );

    add(
      "TOTAL",
      "UNDER 3.5",
      "UNDER35",
      100 - over35
    );
  }

  if (bttsYes !== null) {
    add(
      "BTTS",
      "BTTS YES",
      "BTTS_YES",
      bttsYes
    );

    add(
      "BTTS",
      "BTTS NO",
      "BTTS_NO",
      100 - bttsYes
    );
  }

  return candidates;
}

/* =========================================================
   ODDS
   ========================================================= */

async function fetchEventOdds(eventId) {
  const url =
    `${BSD_BASE}/odds/` +
    `?event_id=${encodeURIComponent(eventId)}` +
    `&limit=200` +
    `&offset=0`;

  return fetchJson(url);
}

function normalizeOddsFeed(data) {
  const rows =
    getRows(data, ["odds"]);

  return rows.map((row) => ({
    eventId:
      row?.event_id ??
      row?.event?.id ??
      null,

    market:
      String(
        row?.market ??
          row?.market_key ??
          ""
      ).toLowerCase(),

    outcome:
      String(
        row?.outcome ??
          row?.selection ??
          ""
      ),

    odds:
      Number(
        row?.decimal_odds ??
          row?.odds ??
          row?.price ??
          NaN
      ),

    previousOdds:
      row?.previous_decimal_odds !==
        null &&
      row?.previous_decimal_odds !==
        undefined
        ? Number(
            row.previous_decimal_odds
          )
        : null,

    openingOdds:
      row?.opening_decimal_odds !==
        null &&
      row?.opening_decimal_odds !==
        undefined
        ? Number(
            row.opening_decimal_odds
          )
        : null,

    movement:
      row?.movement ?? null,

    bookmaker:
      row?.bookmaker_name ??
      row?.bookmaker_slug ??
      null,

    isMaxQuote:
      row?.is_max_quote,

    bookmakerCount:
      row?.bookmaker_count ?? null,
  }));
}

function oddsToCandidateKey(
  market,
  outcome
) {
  const m =
    String(market).toLowerCase();

  const o =
    String(outcome);

  if (m === "1x2") {
    if (o === "HOME") return "HOME";
    if (o === "DRAW") return "DRAW";
    if (o === "AWAY") return "AWAY";
  }

  if (m === "double_chance") {
    if (o === "1X") return "1X";
    if (o === "X2") return "X2";
    if (o === "12") return "12";
  }

  if (m === "over_under_15") {
    if (o.toLowerCase() === "over")
      return "OVER15";

    if (o.toLowerCase() === "under")
      return "UNDER15";
  }

  if (m === "over_under_25") {
    if (o.toLowerCase() === "over")
      return "OVER25";

    if (o.toLowerCase() === "under")
      return "UNDER25";
  }

  if (m === "over_under_35") {
    if (o.toLowerCase() === "over")
      return "OVER35";

    if (o.toLowerCase() === "under")
      return "UNDER35";
  }

  if (m === "btts") {
    if (o.toLowerCase() === "yes")
      return "BTTS_YES";

    if (o.toLowerCase() === "no")
      return "BTTS_NO";
  }

  return null;
}

function attachOdds(
  candidate,
  oddsRows
) {
  const matching =
    oddsRows.filter(
      (row) =>
        oddsToCandidateKey(
          row.market,
          row.outcome
        ) === candidate.marketKey &&
        Number.isFinite(row.odds) &&
        row.odds > 1
    );

  if (!matching.length) {
    return;
  }

  matching.sort((a, b) => {
    if (
      a.isMaxQuote === true &&
      b.isMaxQuote !== true
    ) {
      return -1;
    }

    if (
      b.isMaxQuote === true &&
      a.isMaxQuote !== true
    ) {
      return 1;
    }

    return b.odds - a.odds;
  });

  const selected =
    matching[0];

  candidate.odds =
    round(selected.odds, 3);

  candidate.oddsSource =
    "BSD_BEST_AVAILABLE";

  candidate.bookmaker =
    selected.bookmaker ||
    "Consensus";

  candidate.marketMovement =
    selected.movement || "";

  if (
    Number.isFinite(
      selected.previousOdds
    ) &&
    Number.isFinite(
      selected.odds
    ) &&
    selected.previousOdds !==
      selected.odds
  ) {
    candidate.marketMovement =
      selected.movement ||
      (
        selected.odds <
        selected.previousOdds
          ? "SHORTENING"
          : "DRIFTING"
      );
  }

  if (
    candidate.probability > 0
  ) {
    candidate.fairOdds =
      round(
        100 /
          candidate.probability,
        3
      );

    candidate.value =
      round(
        (
          candidate.odds *
          candidate.probability
        ) /
          100 -
          1,
        4
      );
  }
}

/* =========================================================
   SCORE
   ========================================================= */

function calculateScore(
  candidate
) {
  /*
   * SAME SCORE STRUCTURE.
   * No new weights introduced.
   */

  let score =
    Number(
      candidate.probability || 0
    ) +
    Number(
      candidate.confidence || 0
    ) *
      0.1 +
    Number(
      candidate.recommendationStrength ||
        0
    );

  if (
    candidate.value !== null &&
    Number.isFinite(
      candidate.value
    )
  ) {
    score +=
      candidate.value * 20;
  }

  if (
    candidate.marketMovement ===
    "SHORTENING"
  ) {
    score += 0.5;
  } else if (
    candidate.marketMovement ===
    "DRIFTING"
  ) {
    score -= 0.5;
  }

  if (
    candidate.marketKey === "1X" ||
    candidate.marketKey === "X2"
  ) {
    score += 1;
  }

  return round(score, 4);
}

function rankCandidates(
  candidates
) {
  for (const candidate of candidates) {
    candidate.score =
      calculateScore(candidate);
  }

  return candidates.sort(
    (a, b) => {
      if (
        b.score !== a.score
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
        (b.confidence || 0) -
        (a.confidence || 0)
      );
    }
  );
}

/* =========================================================
   TOP PICKS
   ========================================================= */

function selectTopPicks(
  candidates
) {
  const selected = [];

  const usedEvents =
    new Set();

  let totalCount = 0;

  for (const candidate of candidates) {
    if (
      selected.length >= 5
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

    if (
      candidate.market ===
        "TOTAL" &&
      totalCount >= 3
    ) {
      continue;
    }

    usedEvents.add(
      candidate.eventId
    );

    if (
      candidate.market ===
      "TOTAL"
    ) {
      totalCount++;
    }

    selected.push(candidate);
  }

  return selected;
}

/* =========================================================
   MAIN ANALYZER
   ========================================================= */

async function buildTopPicks(
  date
) {
  const started =
    Date.now();

  /*
   * STEP 1:
   * Real upcoming fixture list.
   */
  const eventsData =
    await fetchUpcomingEvents(
      date
    );

  const eventRows =
    getRows(eventsData);

  const now =
    Date.now();

  const validEvents = [];

  const eventFilterStats = {
    received:
      eventRows.length,

    accepted: 0,

    rejectedFinished: 0,
    rejectedLive: 0,
    rejectedCancelled: 0,
    rejectedPostponed: 0,
    rejectedOtherStatus: 0,
    rejectedPastKickoff: 0,
    rejectedMissingDate: 0,
  };

  for (const event of eventRows) {
    const status =
      getEventStatus(event);

    const eventDate =
      getEventDate(event);

    const parsedDate =
      safeDate(eventDate);

    if (
      status ===
      "finished"
    ) {
      eventFilterStats.rejectedFinished++;
      continue;
    }

    if (
      status === "live"
    ) {
      eventFilterStats.rejectedLive++;
      continue;
    }

    if (
      status ===
      "cancelled"
    ) {
      eventFilterStats.rejectedCancelled++;
      continue;
    }

    if (
      status ===
      "postponed"
    ) {
      eventFilterStats.rejectedPostponed++;
      continue;
    }

    if (
      status &&
      status !==
        "upcoming"
    ) {
      eventFilterStats.rejectedOtherStatus++;
      continue;
    }

    if (!parsedDate) {
      eventFilterStats.rejectedMissingDate++;
      continue;
    }

    if (
      parsedDate.getTime() <=
      now
    ) {
      eventFilterStats.rejectedPastKickoff++;
      continue;
    }

    eventFilterStats.accepted++;

    validEvents.push(event);
  }

  /*
   * STEP 2:
   * Get prediction individually for every
   * genuinely upcoming event.
   */
  const candidates = [];

  let predictionRequests = 0;
  let predictionSuccessful = 0;
  let predictionFailed = 0;

  const predictionDebug = [];

  for (const event of validEvents) {
    const eventId =
      getEventId(event);

    if (!eventId) {
      continue;
    }

    predictionRequests++;

    try {
      const predictionData =
        await fetchEventPrediction(
          eventId
        );

      const prediction =
        getPredictionObject(
          predictionData
        );

      if (
        !prediction ||
        !prediction.markets
      ) {
        predictionFailed++;

        predictionDebug.push({
          eventId,
          status:
            "NO_PREDICTION_MARKETS",
        });

        continue;
      }

      predictionSuccessful++;

      const rowCandidates =
        buildCandidates(
          event,
          prediction
        );

      candidates.push(
        ...rowCandidates
      );

      predictionDebug.push({
        eventId,
        status: "OK",
        candidates:
          rowCandidates.length,
      });
    } catch (error) {
      predictionFailed++;

      predictionDebug.push({
        eventId,
        status: "ERROR",
        httpStatus:
          error?.status ??
          null,
      });

      console.error(
        `Prediction error for event ${eventId}:`,
        error?.status ||
          error?.message ||
          error
      );
    }
  }

  /*
   * STEP 3:
   * Preliminary ranking to select events
   * for odds enrichment.
   */
  const rankedPreOdds =
    rankCandidates(
      [...candidates]
    );

  const uniqueEventIds =
    [];

  for (const candidate of rankedPreOdds) {
    if (
      !uniqueEventIds.includes(
        candidate.eventId
      )
    ) {
      uniqueEventIds.push(
        candidate.eventId
      );
    }

    if (
      uniqueEventIds.length >=
      30
    ) {
      break;
    }
  }

  /*
   * STEP 4:
   * Real BSD odds.
   */
  const oddsMap =
    new Map();

  let oddsRequests = 0;
  let oddsSuccessful = 0;
  let oddsFailed = 0;
  let oddsRows = 0;

  for (const eventId of uniqueEventIds) {
    oddsRequests++;

    try {
      const oddsData =
        await fetchEventOdds(
          eventId
        );

      const normalized =
        normalizeOddsFeed(
          oddsData
        );

      oddsSuccessful++;

      oddsRows +=
        normalized.length;

      oddsMap.set(
        eventId,
        normalized
      );
    } catch (error) {
      oddsFailed++;

      oddsMap.set(
        eventId,
        []
      );

      console.error(
        `Odds error for event ${eventId}:`,
        error?.status ||
          error?.message ||
          error
      );
    }
  }

  /*
   * STEP 5:
   * Attach odds.
   */
  for (const candidate of candidates) {
    const oddsRowsForEvent =
      oddsMap.get(
        candidate.eventId
      ) || [];

    attachOdds(
      candidate,
      oddsRowsForEvent
    );
  }

  /*
   * STEP 6:
   * Final ranking.
   */
  const ranked =
    rankCandidates(
      candidates
    );

  const qualified =
    ranked.filter(
      (candidate) =>
        candidate.probability >=
          60 &&
        candidate.confidence >=
          40
    );

  const topPicks =
    selectTopPicks(
      qualified
    );

  return {
    version: VERSION,

    source: SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() -
      started,

    exchange: EXCHANGE,

    /*
     * IMPORTANT:
     * predictionsTotal now refers to
     * actual upcoming fixtures found
     * by /events/.
     */
    predictionsTotal:
      validEvents.length,

    predictionsDownloaded:
      validEvents.length,

    predictionsFound:
      predictionSuccessful,

    eventFilterStats,

    predictionStatus: {
      requests:
        predictionRequests,

      successful:
        predictionSuccessful,

      failed:
        predictionFailed,
    },

    candidatesFound:
      candidates.length,

    qualificationCount:
      qualified.length,

    maxTopPicks: 5,

    oddsStatus: {
      endpoint:
        "/api/v2/odds/?event_id={id}",

      requests:
        oddsRequests,

      successful:
        oddsSuccessful,

      failed:
        oddsFailed,

      rows:
        oddsRows,

      message:
        oddsSuccessful > 0
          ? "Real BSD bookmaker odds were retrieved and parsed."
          : "No BSD odds were retrieved.",
    },

    topPicks,
  };
}

/* =========================================================
   ROOT
   ========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,

    name:
      "Bet Analyzer Live",

    version: VERSION,

    source: SOURCE,

    architecture:
      "upcoming events -> event prediction -> odds -> ranking",

    endpoints: [
      "/api/top-picks?date=YYYY-MM-DD",
      "/api/debug-events?date=YYYY-MM-DD",
      "/api/debug-prediction?eventId=EVENT_ID",
      "/api/debug-odds?eventId=EVENT_ID",
    ],
  });
});

/* =========================================================
   TOP PICKS
   ========================================================= */

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const result =
        await buildTopPicks(
          date
        );

      res.json(result);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        version: VERSION,

        source: SOURCE,

        error: true,

        message:
          error?.message ||
          "Unknown server error",

        status:
          error?.status ??
          null,

        details:
          error?.data ??
          null,
      });
    }
  }
);

/* =========================================================
   DEBUG EVENTS
   ========================================================= */

app.get(
  "/api/debug-events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const data =
        await fetchUpcomingEvents(
          date
        );

      const rows =
        getRows(data);

      res.json({
        version: VERSION,

        source: SOURCE,

        date,

        endpoint:
          "/api/v2/events/",

        status:
          "upcoming",

        count:
          data?.count ??
          rows.length,

        downloaded:
          rows.length,

        events:
          rows.map(
            (event) => ({
              id:
                getEventId(
                  event
                ),

              event:
                `${getHomeTeam(event)} – ${getAwayTeam(event)}`,

              date:
                getEventDate(
                  event
                ),

              status:
                getEventStatus(
                  event
                ),

              league:
                getLeague(
                  event
                ),
            })
          ),
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,

        source: SOURCE,

        error: true,

        message:
          error?.message ||
          "Unknown server error",

        status:
          error?.status ??
          null,

        details:
          error?.data ??
          null,
      });
    }
  }
);

/* =========================================================
   DEBUG PREDICTION
   ========================================================= */

app.get(
  "/api/debug-prediction",
  async (req, res) => {
    try {
      const eventId =
        Number(
          req.query.eventId
        );

      if (
        !Number.isFinite(
          eventId
        )
      ) {
        return res
          .status(400)
          .json({
            error: true,

            message:
              "eventId must be a number",
          });
      }

      const data =
        await fetchEventPrediction(
          eventId
        );

      res.json({
        version: VERSION,

        source: SOURCE,

        eventId,

        prediction:
          getPredictionObject(
            data
          ),
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,

        source: SOURCE,

        error: true,

        message:
          error?.message ||
          "Unknown server error",

        status:
          error?.status ??
          null,

        details:
          error?.data ??
          null,
      });
    }
  }
);

/* =========================================================
   DEBUG ODDS
   ========================================================= */

app.get(
  "/api/debug-odds",
  async (req, res) => {
    try {
      const eventId =
        Number(
          req.query.eventId
        );

      if (
        !Number.isFinite(
          eventId
        )
      ) {
        return res
          .status(400)
          .json({
            error: true,

            message:
              "eventId must be a number",
          });
      }

      const data =
        await fetchEventOdds(
          eventId
        );

      const rows =
        normalizeOddsFeed(
          data
        );

      res.json({
        version: VERSION,

        source: SOURCE,

        eventId,

        endpoint:
          "/api/v2/odds/?event_id={id}",

        rawCount:
          data?.count ??
          rows.length,

        parsedRows:
          rows.length,

        rows:
          rows.slice(
            0,
            100
          ),
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,

        source: SOURCE,

        error: true,

        message:
          error?.message ||
          "Unknown server error",

        status:
          error?.status ??
          null,

        details:
          error?.data ??
          null,
      });
    }
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
