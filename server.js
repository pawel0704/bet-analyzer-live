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

const VERSION = "7.0.7";
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
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
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

function getEventId(row) {
  return (
    row?.event?.id ??
    row?.event_id ??
    row?.id_event ??
    null
  );
}

function getEventStatus(row) {
  return String(
    row?.event?.status ??
      row?.status ??
      ""
  ).toLowerCase();
}

function getEventDate(row) {
  return (
    row?.event?.date ??
    row?.event?.event_date ??
    row?.event?.start_time ??
    row?.event?.kickoff ??
    row?.date ??
    row?.event_date ??
    row?.start_time ??
    null
  );
}

function getHomeTeam(row) {
  return (
    row?.event?.home_team ??
    row?.event?.home ??
    row?.home_team ??
    row?.home ??
    "Home"
  );
}

function getAwayTeam(row) {
  return (
    row?.event?.away_team ??
    row?.event?.away ??
    row?.away_team ??
    row?.away ??
    "Away"
  );
}

function getLeague(row) {
  return (
    row?.event?.league?.name ??
    row?.event?.league_name ??
    row?.league?.name ??
    row?.league_name ??
    null
  );
}

function getConfidence(row) {
  return normalizeConfidence(
    row?.model?.confidence ??
      row?.confidence ??
      row?.model_confidence ??
      null
  );
}

function getMarkets(row) {
  return row?.markets || {};
}

function buildCandidates(row) {
  const markets = getMarkets(row);

  const matchResult = markets.match_result || {};
  const overUnder = markets.over_under || {};
  const btts = markets.btts || {};

  const confidence = getConfidence(row);

  const candidates = [];

  const homeProb = pct(matchResult.prob_home);
  const drawProb = pct(matchResult.prob_draw);
  const awayProb = pct(matchResult.prob_away);

  const over15 = pct(overUnder.prob_over_15);
  const over25 = pct(overUnder.prob_over_25);
  const over35 = pct(overUnder.prob_over_35);

  const bttsYes = pct(btts.prob_yes);

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
      eventId: getEventId(row),
      event: `${getHomeTeam(row)} – ${getAwayTeam(row)}`,
      home: getHomeTeam(row),
      away: getAwayTeam(row),
      date: getEventDate(row),
      league: getLeague(row),
      market,
      pick,
      marketKey,
      probability: round(Number(probability), 1),
      confidence: round(confidence, 2),
      odds: null,
      fairOdds:
        Number(probability) > 0
          ? round(100 / Number(probability), 3)
          : null,
      value: null,
      recommendationStrength,
      bsdRecommendation:
        row?.recommendations || null,
      score: null,
      oddsSource: "UNAVAILABLE",
      bookmaker: null,
      marketMovement: null,
      exchangeMovement: null,
      status: getEventStatus(row) || "unknown",
    });
  };

  /*
   * EXISTING MARKET WEIGHTS / LOGIC
   * --------------------------------
   * No ranking weights are changed here.
   */

  if (homeProb !== null && drawProb !== null) {
    add(
      "DOUBLE_CHANCE",
      "1X",
      "1X",
      homeProb + drawProb
    );
  }

  if (awayProb !== null && drawProb !== null) {
    add(
      "DOUBLE_CHANCE",
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

function normalizeOddsFeed(data) {
  let rows = [];

  if (Array.isArray(data)) {
    rows = data;
  } else if (Array.isArray(data?.results)) {
    rows = data.results;
  } else if (Array.isArray(data?.data)) {
    rows = data.data;
  } else if (Array.isArray(data?.odds)) {
    rows = data.odds;
  }

  return rows.map((row) => ({
    eventId:
      row?.event_id ??
      row?.event?.id ??
      null,

    market: String(
      row?.market ??
        row?.market_key ??
        ""
    ).toLowerCase(),

    outcome: String(
      row?.outcome ??
        row?.selection ??
        ""
    ),

    odds: Number(
      row?.decimal_odds ??
        row?.odds ??
        row?.price ??
        NaN
    ),

    previousOdds:
      row?.previous_decimal_odds !== null &&
      row?.previous_decimal_odds !== undefined
        ? Number(row.previous_decimal_odds)
        : null,

    openingOdds:
      row?.opening_decimal_odds !== null &&
      row?.opening_decimal_odds !== undefined
        ? Number(row.opening_decimal_odds)
        : null,

    movement:
      row?.movement ??
      null,

    bookmaker:
      row?.bookmaker_name ??
      row?.bookmaker_slug ??
      null,

    bookmakerSlug:
      row?.bookmaker_slug ??
      null,

    isMaxQuote:
      row?.is_max_quote,

    bookmakerCount:
      row?.bookmaker_count ?? null,
  }));
}

function oddsToCandidateKey(market, outcome) {
  const m = String(market).toLowerCase();
  const o = String(outcome);

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
    if (o.toLowerCase() === "over") return "OVER15";
    if (o.toLowerCase() === "under") return "UNDER15";
  }

  if (m === "over_under_25") {
    if (o.toLowerCase() === "over") return "OVER25";
    if (o.toLowerCase() === "under") return "UNDER25";
  }

  if (m === "over_under_35") {
    if (o.toLowerCase() === "over") return "OVER35";
    if (o.toLowerCase() === "under") return "UNDER35";
  }

  if (m === "btts") {
    if (o.toLowerCase() === "yes") return "BTTS_YES";
    if (o.toLowerCase() === "no") return "BTTS_NO";
  }

  return null;
}

function selectOddsForCandidates(candidateList, oddsRows) {
  const grouped = new Map();

  for (const row of oddsRows) {
    const key = oddsToCandidateKey(
      row.market,
      row.outcome
    );

    if (!key) continue;

    if (!Number.isFinite(row.odds) || row.odds <= 1) {
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(row);
  }

  for (const candidate of candidateList) {
    const rows = grouped.get(candidate.marketKey) || [];

    if (!rows.length) {
      continue;
    }

    /*
     * BSD free feed currently returns Consensus rows.
     * If multiple rows exist, prefer max quote / highest price.
     */
    rows.sort((a, b) => {
      if (a.isMaxQuote === true && b.isMaxQuote !== true) {
        return -1;
      }

      if (b.isMaxQuote === true && a.isMaxQuote !== true) {
        return 1;
      }

      return b.odds - a.odds;
    });

    const selected = rows[0];

    candidate.odds = round(selected.odds, 3);
    candidate.oddsSource = "BSD_BEST_AVAILABLE";
    candidate.bookmaker = selected.bookmaker || "Consensus";
    candidate.marketMovement = selected.movement || "";

    if (
      Number.isFinite(selected.previousOdds) &&
      Number.isFinite(selected.odds) &&
      selected.previousOdds !== selected.odds
    ) {
      candidate.marketMovement =
        selected.movement ||
        (selected.odds < selected.previousOdds
          ? "SHORTENING"
          : "DRIFTING");
    }

    if (candidate.probability > 0) {
      candidate.fairOdds = round(
        100 / candidate.probability,
        3
      );

      candidate.value = round(
        (candidate.odds * candidate.probability) / 100 - 1,
        4
      );
    }
  }

  return candidateList;
}

function calculateScore(candidate) {
  /*
   * Keep the established scoring structure.
   * Probability is the main component.
   * Confidence and recommendation are secondary.
   * Value/movement only refine the score.
   */

  let score =
    Number(candidate.probability || 0) +
    Number(candidate.confidence || 0) * 0.1 +
    Number(candidate.recommendationStrength || 0);

  if (
    candidate.value !== null &&
    Number.isFinite(candidate.value)
  ) {
    score += candidate.value * 20;
  }

  if (candidate.marketMovement === "SHORTENING") {
    score += 0.5;
  } else if (candidate.marketMovement === "DRIFTING") {
    score -= 0.5;
  }

  /*
   * Existing modest preference for double chance.
   */
  if (candidate.marketKey === "1X" || candidate.marketKey === "X2") {
    score += 1;
  }

  return round(score, 4);
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

async function fetchPredictions(date) {
  const url =
    `${BSD_BASE}/predictions/` +
    `?date_from=${encodeURIComponent(date)}` +
    `&date_to=${encodeURIComponent(date)}` +
    `&status=upcoming` +
    `&limit=200` +
    `&offset=0`;

  return fetchJson(url);
}

async function fetchEventOdds(eventId) {
  const url =
    `${BSD_BASE}/odds/` +
    `?event_id=${encodeURIComponent(eventId)}` +
    `&limit=200` +
    `&offset=0`;

  return fetchJson(url);
}

function getPredictionRows(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.predictions)) {
    return data.predictions;
  }

  return [];
}

function filterUpcomingPredictions(rows) {
  const now = Date.now();

  const stats = {
    received: rows.length,
    accepted: 0,
    rejectedFinished: 0,
    rejectedLive: 0,
    rejectedCancelled: 0,
    rejectedPostponed: 0,
    rejectedOtherStatus: 0,
    rejectedPastKickoff: 0,
    rejectedMissingDate: 0,
  };

  const accepted = [];

  for (const row of rows) {
    const status = getEventStatus(row);
    const eventDate = getEventDate(row);
    const parsedDate = safeDate(eventDate);

    if (status === "finished") {
      stats.rejectedFinished++;
      continue;
    }

    if (status === "live") {
      stats.rejectedLive++;
      continue;
    }

    if (status === "cancelled") {
      stats.rejectedCancelled++;
      continue;
    }

    if (status === "postponed") {
      stats.rejectedPostponed++;
      continue;
    }

    if (
      status &&
      status !== "upcoming"
    ) {
      stats.rejectedOtherStatus++;
      continue;
    }

    if (!parsedDate) {
      stats.rejectedMissingDate++;
      continue;
    }

    /*
     * Important second safety layer:
     * even if BSD says "upcoming", do not analyse
     * a match whose kickoff is already in the past.
     */
    if (parsedDate.getTime() <= now) {
      stats.rejectedPastKickoff++;
      continue;
    }

    stats.accepted++;
    accepted.push(row);
  }

  return {
    accepted,
    stats,
  };
}

function rankCandidates(candidates) {
  for (const candidate of candidates) {
    candidate.score = calculateScore(candidate);
  }

  return candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    if (b.probability !== a.probability) {
      return b.probability - a.probability;
    }

    return (b.confidence || 0) - (a.confidence || 0);
  });
}

function selectTopPicks(candidates) {
  const selected = [];
  const usedEvents = new Set();

  let totalCount = 0;

  for (const candidate of candidates) {
    if (selected.length >= 5) {
      break;
    }

    if (usedEvents.has(candidate.eventId)) {
      continue;
    }

    /*
     * Do not allow the whole shortlist to become totals.
     * Maximum 3 TOTAL picks.
     */
    if (
      candidate.market === "TOTAL" &&
      totalCount >= 3
    ) {
      continue;
    }

    usedEvents.add(candidate.eventId);

    if (candidate.market === "TOTAL") {
      totalCount++;
    }

    selected.push(candidate);
  }

  return selected;
}

async function buildTopPicks(date) {
  const started = Date.now();

  const predictionData = await fetchPredictions(date);
  const rawRows = getPredictionRows(predictionData);

  const {
    accepted: predictionRows,
    stats: filterStats,
  } = filterUpcomingPredictions(rawRows);

  const candidates = [];

  for (const row of predictionRows) {
    const rowCandidates = buildCandidates(row);

    for (const candidate of rowCandidates) {
      if (candidate.eventId !== null) {
        candidates.push(candidate);
      }
    }
  }

  /*
   * Keep the existing candidate generation/ranking.
   * Only enrich a limited number of events with odds.
   */
  const rankedPreOdds = rankCandidates(
    [...candidates]
  );

  const uniqueEventIds = [];

  for (const candidate of rankedPreOdds) {
    if (!uniqueEventIds.includes(candidate.eventId)) {
      uniqueEventIds.push(candidate.eventId);
    }

    if (uniqueEventIds.length >= 30) {
      break;
    }
  }

  const oddsMap = new Map();

  let oddsRequests = 0;
  let oddsSuccessful = 0;
  let oddsFailed = 0;
  let oddsRows = 0;

  for (const eventId of uniqueEventIds) {
    oddsRequests++;

    try {
      const oddsData = await fetchEventOdds(eventId);
      const normalized = normalizeOddsFeed(oddsData);

      oddsSuccessful++;
      oddsRows += normalized.length;

      oddsMap.set(eventId, normalized);
    } catch (error) {
      oddsFailed++;

      oddsMap.set(eventId, []);

      console.error(
        `Odds error for event ${eventId}:`,
        error?.status || error?.message || error
      );
    }
  }

  /*
   * Attach real BSD odds.
   */
  for (const candidate of candidates) {
    const eventOdds =
      oddsMap.get(candidate.eventId) || [];

    selectOddsForCandidates(
      [candidate],
      eventOdds
    );
  }

  const ranked = rankCandidates(candidates);

  const qualified = ranked.filter(
    (candidate) =>
      candidate.probability >= 60 &&
      candidate.confidence >= 40
  );

  const topPicks = selectTopPicks(
    qualified
  );

  return {
    version: VERSION,
    source: SOURCE,
    date,
    generatedAt: new Date().toISOString(),
    processingMs: Date.now() - started,

    exchange: EXCHANGE,

    predictionsTotal:
      predictionData?.count ??
      rawRows.length,

    predictionsDownloaded:
      rawRows.length,

    predictionsFound:
      predictionRows.length,

    filterStats,

    candidatesFound:
      candidates.length,

    qualificationCount:
      qualified.length,

    maxTopPicks: 5,

    oddsStatus: {
      endpoint:
        "/api/v2/odds/?event_id={id}",
      requests: oddsRequests,
      successful: oddsSuccessful,
      failed: oddsFailed,
      rows: oddsRows,
      message:
        oddsSuccessful > 0
          ? "Real BSD bookmaker odds were retrieved and parsed."
          : "No BSD odds were retrieved.",
    },

    topPicks,
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    endpoints: [
      "/api/top-picks?date=YYYY-MM-DD",
      "/api/debug-prediction?date=YYYY-MM-DD",
      "/api/debug-odds?eventId=EVENT_ID",
    ],
  });
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const result =
      await buildTopPicks(date);

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
        error?.status || null,
      details:
        error?.data || null,
    });
  }
});

app.get("/api/debug-prediction", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const data =
      await fetchPredictions(date);

    const rows =
      getPredictionRows(data);

    const filtered =
      filterUpcomingPredictions(rows);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,

      request: {
        endpoint: "/api/v2/predictions/",
        status: "upcoming",
        date_from: date,
        date_to: date,
        limit: 200,
      },

      count:
        data?.count ?? null,

      downloaded:
        rows.length,

      filterStats:
        filtered.stats,

      acceptedPreview:
        filtered.accepted
          .slice(0, 10)
          .map((row) => ({
            id: row?.id ?? null,
            eventId: getEventId(row),
            event:
              `${getHomeTeam(row)} – ${getAwayTeam(row)}`,
            date: getEventDate(row),
            status: getEventStatus(row),
            confidence: getConfidence(row),
          })),
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
        error?.status || null,
      details:
        error?.data || null,
    });
  }
});

app.get("/api/debug-odds", async (req, res) => {
  try {
    const eventId =
      Number(req.query.eventId);

    if (!Number.isFinite(eventId)) {
      return res.status(400).json({
        error: true,
        message:
          "eventId must be a number",
      });
    }

    const data =
      await fetchEventOdds(eventId);

    const rows =
      normalizeOddsFeed(data);

    res.json({
      version: VERSION,
      source: SOURCE,
      eventId,

      endpoint:
        "/api/v2/odds/?event_id={id}",

      rawCount:
        Array.isArray(data)
          ? data.length
          : data?.count ?? null,

      parsedRows:
        rows.length,

      rows: rows.slice(0, 100),
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
        error?.status || null,
      details:
        error?.data || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
