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

const VERSION = "7.1.0";
const SOURCE = "BSD";

if (!BSD_API_KEY) {
  console.error("ERROR: BSD_API_KEY is missing.");
}

const MAX_TOP_PICKS = 5;
const MAX_TOTAL_PICKS = 3;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }

  const p = Math.pow(10, digits);
  return Math.round(Number(value) * p) / p;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeProbability(value) {
  const n = toNumber(value);

  if (n === null) return null;

  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function dateBounds(date) {
  return {
    from: `${date}T00:00:00Z`,
    to: `${date}T23:59:59Z`
  };
}

function isFutureKickoff(dateValue) {
  if (!dateValue) return false;

  const t = new Date(dateValue).getTime();

  if (!Number.isFinite(t)) return false;

  return t > Date.now();
}

// ------------------------------------------------------------
// BSD request
// ------------------------------------------------------------

async function bsdFetch(path, options = {}) {
  const url = `${BSD_BASE}${path}`;

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
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      `BSD HTTP ${response.status} for ${path}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

// ------------------------------------------------------------
// Pagination helper
// ------------------------------------------------------------

async function fetchAllPages(pathBuilder, maxPages = 20) {
  const results = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * 200;

    const data = await bsdFetch(
      pathBuilder({
        limit: 200,
        offset
      })
    );

    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.results)
        ? data.results
        : [];

    results.push(...rows);

    const count = toNumber(data?.count);

    if (rows.length < 200) {
      break;
    }

    if (count !== null && results.length >= count) {
      break;
    }
  }

  return results;
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------

async function fetchEventsForDate(date) {
  const { from, to } = dateBounds(date);

  return fetchAllPages(({ limit, offset }) => {
    const params = new URLSearchParams({
      date_from: from,
      date_to: to,
      status: "upcoming",
      limit: String(limit),
      offset: String(offset)
    });

    return `/events/?${params.toString()}`;
  });
}

function normalizeEventStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

function filterFutureEvents(events) {
  const stats = {
    received: events.length,
    accepted: 0,
    acceptedNotstarted: 0,
    acceptedUpcoming: 0,
    rejectedFinished: 0,
    rejectedLive: 0,
    rejectedCancelled: 0,
    rejectedPostponed: 0,
    rejectedOtherStatus: 0,
    rejectedPastKickoff: 0,
    rejectedMissingDate: 0
  };

  const future = [];

  for (const event of events) {
    const status = normalizeEventStatus(event?.status);

    const eventDate =
      event?.date ||
      event?.event_date ||
      event?.start_time ||
      event?.kickoff ||
      event?.scheduled_at ||
      null;

    if (!eventDate) {
      stats.rejectedMissingDate++;
      continue;
    }

    const finishedStatuses = new Set([
      "finished",
      "ft",
      "full_time",
      "ended"
    ]);

    const liveStatuses = new Set([
      "live",
      "1st_half",
      "2nd_half",
      "halftime",
      "extra_time",
      "penalties",
      "in_progress"
    ]);

    const cancelledStatuses = new Set([
      "cancelled",
      "canceled"
    ]);

    const postponedStatuses = new Set([
      "postponed"
    ]);

    if (finishedStatuses.has(status)) {
      stats.rejectedFinished++;
      continue;
    }

    if (liveStatuses.has(status)) {
      stats.rejectedLive++;
      continue;
    }

    if (cancelledStatuses.has(status)) {
      stats.rejectedCancelled++;
      continue;
    }

    if (postponedStatuses.has(status)) {
      stats.rejectedPostponed++;
      continue;
    }

    if (status !== "notstarted" && status !== "upcoming") {
      stats.rejectedOtherStatus++;
      continue;
    }

    if (!isFutureKickoff(eventDate)) {
      stats.rejectedPastKickoff++;
      continue;
    }

    stats.accepted++;

    if (status === "notstarted") {
      stats.acceptedNotstarted++;
    }

    if (status === "upcoming") {
      stats.acceptedUpcoming++;
    }

    future.push({
      ...event,
      normalizedDate: eventDate,
      normalizedStatus: status
    });
  }

  return {
    future,
    stats
  };
}

// ------------------------------------------------------------
// Predictions — BULK
// ------------------------------------------------------------

async function fetchPredictionsForDate(date) {
  const { from, to } = dateBounds(date);

  return fetchAllPages(({ limit, offset }) => {
    const params = new URLSearchParams({
      date_from: from,
      date_to: to,
      limit: String(limit),
      offset: String(offset)
    });

    return `/predictions/?${params.toString()}`;
  });
}

function getPredictionEventId(prediction) {
  return (
    prediction?.event?.id ??
    prediction?.event_id ??
    prediction?.eventId ??
    null
  );
}

function mapPredictionsByEvent(predictions) {
  const map = new Map();

  for (const prediction of predictions) {
    const eventId = getPredictionEventId(prediction);

    if (eventId === null) continue;

    map.set(String(eventId), prediction);
  }

  return map;
}

// ------------------------------------------------------------
// Prediction parsing
// ------------------------------------------------------------

function getMarkets(prediction) {
  return prediction?.markets || {};
}

function getConfidence(prediction) {
  const modelConfidence =
    prediction?.model?.confidence ??
    prediction?.confidence ??
    null;

  const normalized = normalizeProbability(modelConfidence);

  return normalized;
}

function getRecommendationStrength(prediction, marketKey, probability) {
  const rec = prediction?.recommendations;

  if (!rec) return 0;

  let strength = 0;

  const favorite = String(rec.favorite ?? "").toLowerCase();

  if (
    marketKey === "HOME" &&
    favorite === "home"
  ) {
    strength += 1;
  }

  if (
    marketKey === "DRAW" &&
    favorite === "draw"
  ) {
    strength += 1;
  }

  if (
    marketKey === "AWAY" &&
    (favorite === "away" || favorite === "a")
  ) {
    strength += 1;
  }

  if (
    marketKey === "OVER15" &&
    rec.over_15 === true
  ) {
    strength += 1;
  }

  if (
    marketKey === "OVER25" &&
    rec.over_25 === true
  ) {
    strength += 1;
  }

  if (
    marketKey === "OVER35" &&
    rec.over_35 === true
  ) {
    strength += 1;
  }

  if (
    marketKey === "BTTS_YES" &&
    rec.btts === true
  ) {
    strength += 1;
  }

  if (
    rec.winner === true &&
    ["HOME", "DRAW", "AWAY"].includes(marketKey)
  ) {
    strength += 1;
  }

  if (probability >= 80) {
    strength += 0;
  }

  return strength;
}

function buildPredictionCandidates(event, prediction) {
  const markets = getMarkets(prediction);

  const matchResult = markets.match_result || {};
  const overUnder = markets.over_under || {};
  const btts = markets.btts || {};

  const homeProbability =
    normalizeProbability(matchResult.prob_home);

  const drawProbability =
    normalizeProbability(matchResult.prob_draw);

  const awayProbability =
    normalizeProbability(matchResult.prob_away);

  const over15 =
    normalizeProbability(overUnder.prob_over_15);

  const over25 =
    normalizeProbability(overUnder.prob_over_25);

  const over35 =
    normalizeProbability(overUnder.prob_over_35);

  const bttsYes =
    normalizeProbability(btts.prob_yes);

  const candidates = [];

  const add = (
    market,
    pick,
    marketKey,
    probability
  ) => {
    if (
      probability === null ||
      probability === undefined ||
      !Number.isFinite(probability)
    ) {
      return;
    }

    if (probability < 60) {
      return;
    }

    candidates.push({
      eventId: event.id,
      event: `${event.home_team || event.home || "Home"} – ${event.away_team || event.away || "Away"}`,
      home: event.home_team || event.home || null,
      away: event.away_team || event.away || null,
      date:
        event.normalizedDate ||
        event.date ||
        event.event_date ||
        null,
      league:
        event.league?.name ||
        event.league_name ||
        event.league ||
        null,
      market,
      pick,
      marketKey,
      probability: round(probability, 1),
      confidence: round(getConfidence(prediction), 2),
      odds: null,
      fairOdds:
        probability > 0
          ? round(100 / probability, 3)
          : null,
      value: null,
      recommendationStrength:
        getRecommendationStrength(
          prediction,
          marketKey,
          probability
        ),
      bsdRecommendation: prediction?.recommendations || null,
      score: null,
      oddsSource: "UNAVAILABLE",
      bookmaker: null,
      marketMovement: null,
      exchangeMovement: null,
      status: event.normalizedStatus || event.status || null
    });
  };

  // 1X2
  add("1X2", "HOME", "HOME", homeProbability);
  add("1X2", "DRAW", "DRAW", drawProbability);
  add("1X2", "AWAY", "AWAY", awayProbability);

  // Double chance
  if (
    homeProbability !== null &&
    drawProbability !== null
  ) {
    add(
      "DOUBLE_CHANCE",
      "1X",
      "1X",
      homeProbability + drawProbability
    );
  }

  if (
    drawProbability !== null &&
    awayProbability !== null
  ) {
    add(
      "DOUBLE_CHANCE",
      "X2",
      "X2",
      drawProbability + awayProbability
    );
  }

  // Totals
  if (over15 !== null) {
    add("TOTAL", "OVER 1.5", "OVER15", over15);
    add("TOTAL", "UNDER 1.5", "UNDER15", 100 - over15);
  }

  if (over25 !== null) {
    add("TOTAL", "OVER 2.5", "OVER25", over25);
    add("TOTAL", "UNDER 2.5", "UNDER25", 100 - over25);
  }

  if (over35 !== null) {
    add("TOTAL", "OVER 3.5", "OVER35", over35);
    add("TOTAL", "UNDER 3.5", "UNDER35", 100 - over35);
  }

  // BTTS
  if (bttsYes !== null) {
    add("BTTS", "BTTS YES", "BTTS_YES", bttsYes);
    add("BTTS", "BTTS NO", "BTTS_NO", 100 - bttsYes);
  }

  return candidates;
}

// ------------------------------------------------------------
// Odds feed
// ------------------------------------------------------------

function extractRows(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.odds)) {
    return data.odds;
  }

  return [];
}

async function fetchEventOdds(eventId) {
  const params = new URLSearchParams({
    event_id: String(eventId),
    limit: "200",
    offset: "0"
  });

  return bsdFetch(`/odds/?${params.toString()}`);
}

function normalizeOddsRow(row) {
  const market = String(
    row?.market ??
    row?.market_type ??
    row?.market_name ??
    ""
  ).toLowerCase();

  const outcome = String(
    row?.outcome ??
    row?.selection ??
    ""
  );

  const odds =
    toNumber(row?.decimal_odds) ??
    toNumber(row?.odds) ??
    toNumber(row?.price) ??
    null;

  const previousOdds =
    toNumber(row?.previous_decimal_odds) ??
    null;

  const movementRaw =
    row?.movement ??
    null;

  let movement = null;

  if (
    previousOdds !== null &&
    odds !== null &&
    previousOdds !== odds
  ) {
    if (movementRaw === "SHORTENING") {
      movement = "SHORTENING";
    } else if (movementRaw === "DRIFTING") {
      movement = "DRIFTING";
    } else if (odds < previousOdds) {
      movement = "SHORTENING";
    } else if (odds > previousOdds) {
      movement = "DRIFTING";
    }
  }

  if (
    previousOdds !== null &&
    odds !== null &&
    previousOdds === odds
  ) {
    movement = null;
  }

  return {
    market,
    outcome,
    odds,
    previousOdds,
    movement,
    bookmaker:
      row?.bookmaker_name ??
      row?.bookmaker ??
      "Consensus",
    bookmakerSlug:
      row?.bookmaker_slug ??
      "consensus",
    isMaxQuote:
      row?.is_max_quote === true
  };
}

function oddsKey(market, outcome) {
  return `${market}|${String(outcome).toUpperCase()}`;
}

function normalizeOddsFeed(data) {
  const rows = extractRows(data);

  const map = new Map();

  for (const rawRow of rows) {
    const row = normalizeOddsRow(rawRow);

    if (row.odds === null || row.odds <= 1) {
      continue;
    }

    const market = row.market;
    const outcome = row.outcome;

    let normalizedMarket = null;
    let normalizedOutcome = null;

    if (market === "1x2") {
      normalizedMarket = "1X2";

      if (outcome.toUpperCase() === "HOME") {
        normalizedOutcome = "HOME";
      } else if (outcome.toUpperCase() === "DRAW") {
        normalizedOutcome = "DRAW";
      } else if (outcome.toUpperCase() === "AWAY") {
        normalizedOutcome = "AWAY";
      }
    }

    if (market === "double_chance") {
      normalizedMarket = "DOUBLE_CHANCE";

      const upper = outcome.toUpperCase();

      if (
        upper === "1X" ||
        upper === "12" ||
        upper === "X2"
      ) {
        normalizedOutcome = upper;
      }
    }

    if (
      market === "over_under_15" ||
      market === "over_under_25" ||
      market === "over_under_35"
    ) {
      normalizedMarket = "TOTAL";

      const upper = outcome.toLowerCase();

      if (upper === "over") {
        normalizedOutcome = `OVER${market.endsWith("15") ? "15" : market.endsWith("25") ? "25" : "35"}`;
      }

      if (upper === "under") {
        normalizedOutcome = `UNDER${market.endsWith("15") ? "15" : market.endsWith("25") ? "25" : "35"}`;
      }
    }

    if (market === "btts") {
      normalizedMarket = "BTTS";

      const upper = outcome.toLowerCase();

      if (upper === "yes") {
        normalizedOutcome = "BTTS_YES";
      }

      if (upper === "no") {
        normalizedOutcome = "BTTS_NO";
      }
    }

    if (!normalizedMarket || !normalizedOutcome) {
      continue;
    }

    const key = oddsKey(
      normalizedMarket,
      normalizedOutcome
    );

    const existing = map.get(key);

    // Free BSD keys normally return consensus.
    // If multiple rows are available, prefer:
    // 1. consensus
    // 2. max quote
    // 3. highest price
    const priority = (
      r
    ) => {
      let score = 0;

      if (r.bookmakerSlug === "consensus") {
        score += 1000;
      }

      if (r.isMaxQuote) {
        score += 100;
      }

      score += r.odds;

      return score;
    };

    if (!existing || priority(row) > priority(existing)) {
      map.set(key, row);
    }
  }

  return map;
}

// ------------------------------------------------------------
// Odds summary fallback
// ------------------------------------------------------------

async function fetchEventOddsSummary(eventId) {
  try {
    const data = await bsdFetch(
      `/events/${eventId}/odds/`
    );

    return data;
  } catch {
    return null;
  }
}

function getSummaryOdds(summary, marketKey) {
  const odds = summary?.odds;

  if (!odds) return null;

  const map = {
    HOME: odds.home_win,
    DRAW: odds.draw,
    AWAY: odds.away_win,

    OVER15: odds.over_15_goals,
    UNDER15: odds.under_15_goals,

    OVER25: odds.over_25_goals,
    UNDER25: odds.under_25_goals,

    OVER35: odds.over_35_goals,
    UNDER35: odds.under_35_goals,

    BTTS_YES: odds.btts_yes,
    BTTS_NO: odds.btts_no
  };

  const value = toNumber(map[marketKey]);

  return value !== null && value > 1
    ? value
    : null;
}

// ------------------------------------------------------------
// Apply odds
// ------------------------------------------------------------

async function enrichCandidateWithOdds(candidate, oddsMap, eventId) {
  const market =
    candidate.marketKey === "HOME" ||
    candidate.marketKey === "DRAW" ||
    candidate.marketKey === "AWAY"
      ? "1X2"
      : candidate.marketKey === "1X" ||
        candidate.marketKey === "X2"
        ? "DOUBLE_CHANCE"
        : candidate.marketKey.startsWith("BTTS")
          ? "BTTS"
          : "TOTAL";

  const key = oddsKey(
    market,
    market === "TOTAL"
      ? candidate.marketKey
      : market === "BTTS"
        ? candidate.marketKey
        : candidate.marketKey
  );

  let row = oddsMap.get(key);

  // For 1X2 our normalized key is straightforward.
  if (!row) {
    row = oddsMap.get(
      oddsKey(
        market,
        candidate.marketKey
      )
    );
  }

  if (row) {
    candidate.odds = round(row.odds, 3);
    candidate.oddsSource = "BSD_BEST_AVAILABLE";
    candidate.bookmaker = row.bookmaker;
    candidate.marketMovement = row.movement;

    if (
      candidate.probability !== null &&
      candidate.odds !== null
    ) {
      candidate.value = round(
        candidate.probability / 100 * candidate.odds - 1,
        4
      );
    }

    return candidate;
  }

  // Double chance is not guaranteed to be present in
  // the eleven-key event summary. Do not invent it.
  // For all other markets use BSD's consensus summary
  // as a real fallback.
  if (candidate.marketKey !== "1X" &&
      candidate.marketKey !== "X2") {

    const summary =
      await fetchEventOddsSummary(eventId);

    const summaryOdds =
      getSummaryOdds(
        summary,
        candidate.marketKey
      );

    if (summaryOdds !== null) {
      candidate.odds = round(summaryOdds, 3);
      candidate.oddsSource = "BSD_EVENT_CONSENSUS";
      candidate.bookmaker = "Consensus";

      candidate.value = round(
        candidate.probability / 100 *
          candidate.odds - 1,
        4
      );
    }
  }

  return candidate;
}

// ------------------------------------------------------------
// Scoring
// IMPORTANT: preserve existing weighting
// ------------------------------------------------------------

function calculateScore(candidate) {
  const probability =
    candidate.probability ?? 0;

  const confidence =
    candidate.confidence ?? 0;

  const recommendation =
    candidate.recommendationStrength ?? 0;

  const value =
    candidate.value ?? 0;

  // Existing 7.x weighting.
  // Do not change these weights merely to alter the output.
  let score =
    probability +
    confidence * 0.1 +
    recommendation +
    value * 20;

  if (candidate.marketMovement === "SHORTENING") {
    score += 0.5;
  }

  if (candidate.marketMovement === "DRIFTING") {
    score -= 0.5;
  }

  if (
    candidate.marketKey === "1X" ||
    candidate.marketKey === "X2"
  ) {
    score += 1;
  }

  return round(score, 3);
}

// ------------------------------------------------------------
// Candidate qualification
// ------------------------------------------------------------

function qualifyCandidates(candidates) {
  return candidates.filter(candidate => {
    if (
      candidate.probability === null ||
      candidate.probability < 60
    ) {
      return false;
    }

    if (
      candidate.confidence !== null &&
      candidate.confidence < 40
    ) {
      return false;
    }

    return true;
  });
}

// ------------------------------------------------------------
// Final ranking
// ------------------------------------------------------------

function selectTopPicks(candidates) {
  const sorted = [...candidates]
    .sort((a, b) => {
      const scoreDiff =
        (b.score ?? -Infinity) -
        (a.score ?? -Infinity);

      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const valueDiff =
        (b.value ?? -Infinity) -
        (a.value ?? -Infinity);

      if (valueDiff !== 0) {
        return valueDiff;
      }

      return (
        (b.probability ?? 0) -
        (a.probability ?? 0)
      );
    });

  const selected = [];
  const usedEvents = new Set();

  let totalCount = 0;

  for (const candidate of sorted) {
    if (selected.length >= MAX_TOP_PICKS) {
      break;
    }

    const eventId = String(candidate.eventId);

    if (usedEvents.has(eventId)) {
      continue;
    }

    if (
      candidate.market === "TOTAL"
    ) {
      if (totalCount >= MAX_TOTAL_PICKS) {
        continue;
      }
    }

    usedEvents.add(eventId);

    if (candidate.market === "TOTAL") {
      totalCount++;
    }

    selected.push(candidate);
  }

  return selected;
}

// ------------------------------------------------------------
// Main analysis
// ------------------------------------------------------------

async function analyzeDate(date) {
  const startedAt = Date.now();

  // 1. Events
  const rawEvents =
    await fetchEventsForDate(date);

  const {
    future: futureEvents,
    stats: eventFilterStats
  } = filterFutureEvents(rawEvents);

  // 2. Predictions — ONE bulk retrieval
  const allPredictions =
    await fetchPredictionsForDate(date);

  const predictionsByEvent =
    mapPredictionsByEvent(
      allPredictions
    );

  const candidates = [];

  let predictionsFound = 0;

  for (const event of futureEvents) {
    const prediction =
      predictionsByEvent.get(
        String(event.id)
      );

    if (!prediction) {
      continue;
    }

    predictionsFound++;

    const eventCandidates =
      buildPredictionCandidates(
        event,
        prediction
      );

    candidates.push(
      ...eventCandidates
    );
  }

  // 3. Qualify
  const qualified =
    qualifyCandidates(candidates);

  // 4. Take preliminary top candidates for odds
  const preliminary =
    [...qualified]
      .sort((a, b) => {
        const aBase =
          (a.probability ?? 0) +
          (a.confidence ?? 0) * 0.1;

        const bBase =
          (b.probability ?? 0) +
          (b.confidence ?? 0) * 0.1;

        return bBase - aBase;
      })
      .filter(
        (candidate, index, arr) =>
          index ===
          arr.findIndex(
            x =>
              String(x.eventId) ===
              String(candidate.eventId) &&
              x.marketKey ===
              candidate.marketKey
          )
      )
      .slice(0, 30);

  // 5. Odds
  const oddsStatus = {
    endpoint: "/api/v2/odds/?event_id={id}",
    requests: 0,
    successful: 0,
    failed: 0,
    rows: 0,
    message: ""
  };

  const enriched = [];

  for (const candidate of preliminary) {
    oddsStatus.requests++;

    try {
      const oddsData =
        await fetchEventOdds(
          candidate.eventId
        );

      oddsStatus.successful++;

      const rows =
        extractRows(oddsData);

      oddsStatus.rows += rows.length;

      const oddsMap =
        normalizeOddsFeed(
          oddsData
        );

      const enrichedCandidate =
        await enrichCandidateWithOdds(
          candidate,
          oddsMap,
          candidate.eventId
        );

      enriched.push(
        enrichedCandidate
      );
    } catch {
      oddsStatus.failed++;

      enriched.push(candidate);
    }

    await sleep(10);
  }

  oddsStatus.message =
    oddsStatus.successful > 0
      ? "Real BSD bookmaker odds were retrieved and parsed."
      : "No BSD odds were retrieved.";

  // 6. Recalculate score AFTER odds
  for (const candidate of enriched) {
    candidate.score =
      calculateScore(candidate);
  }

  // 7. Add remaining qualified candidates without
  // additional odds requests.
  //
  // This preserves the complete candidate universe while
  // keeping the API load controlled.
  const enrichedMap =
    new Map(
      enriched.map(candidate => [
        `${candidate.eventId}|${candidate.marketKey}`,
        candidate
      ])
    );

  for (const candidate of qualified) {
    const key =
      `${candidate.eventId}|${candidate.marketKey}`;

    if (enrichedMap.has(key)) {
      continue;
    }

    candidate.score =
      calculateScore(candidate);

    enrichedMap.set(key, candidate);
  }

  const finalCandidates =
    Array.from(enrichedMap.values());

  const topPicks =
    selectTopPicks(
      finalCandidates
    );

  // 8. Exchange is intentionally NOT fabricated.
  const exchange = {
    connected: false,
    status: "NOT_CONNECTED",
    message:
      "Betting exchange data is not connected. No exchange movement is fabricated."
  };

  return {
    version: VERSION,
    source: SOURCE,
    date,
    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - startedAt,

    exchange,

    eventsDownloaded:
      rawEvents.length,

    eventsFound:
      futureEvents.length,

    eventFilterStats,

    predictionsTotal:
      allPredictions.length,

    predictionsDownloaded:
      allPredictions.length,

    predictionsFound,

    predictionStatus: {
      requests: 1,
      successful:
        allPredictions.length > 0
          ? 1
          : 0,
      failed:
        allPredictions.length > 0
          ? 0
          : 1,
      mode: "BULK_DATE_QUERY"
    },

    candidatesFound:
      candidates.length,

    qualificationCount:
      qualified.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    oddsStatus,

    topPicks
  };
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online"
  });
});

// Main endpoint
app.get("/api/analyze", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const result =
      await analyzeDate(date);

    res.json(result);
  } catch (error) {
    console.error(
      "ANALYZE ERROR:",
      error?.message,
      error?.data || ""
    );

    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      error: "Analysis failed",
      message: error?.message || "Unknown error"
    });
  }
});

// Alias
app.get("/api/picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const result =
      await analyzeDate(date);

    res.json(result);
  } catch (error) {
    console.error(
      "PICKS ERROR:",
      error?.message
    );

    res.status(500).json({
      version: VERSION,
      source: SOURCE,
      error: "Analysis failed",
      message: error?.message || "Unknown error"
    });
  }
});

// Debug events
app.get("/api/debug-events", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const rawEvents =
      await fetchEventsForDate(date);

    const filtered =
      filterFutureEvents(rawEvents);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,
      received: rawEvents.length,
      eventsFound:
        filtered.future.length,
      filterStats:
        filtered.stats,
      events:
        filtered.future.map(event => ({
          id: event.id,
          home:
            event.home_team ||
            event.home ||
            null,
          away:
            event.away_team ||
            event.away ||
            null,
          date:
            event.normalizedDate ||
            event.date ||
            null,
          status:
            event.normalizedStatus ||
            event.status ||
            null,
          league:
            event.league?.name ||
            event.league_name ||
            event.league ||
            null
        }))
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      error: error?.message
    });
  }
});

// Debug bulk predictions
app.get("/api/debug-predictions", async (req, res) => {
  try {
    const date =
      req.query.date ||
      getTodayUTC();

    const predictions =
      await fetchPredictionsForDate(
        date
      );

    res.json({
      version: VERSION,
      source: SOURCE,
      date,
      count: predictions.length,
      predictions:
        predictions.slice(0, 20).map(p => ({
          id: p.id ?? null,
          eventId:
            getPredictionEventId(p),
          event:
            p.event
              ? {
                  id: p.event.id,
                  home:
                    p.event.home_team,
                  away:
                    p.event.away_team
                }
              : null,
          confidence:
            getConfidence(p),
          markets:
            p.markets || null
        }))
    });
  } catch (error) {
    res.status(500).json({
      version: VERSION,
      error: error?.message
    });
  }
});

// Debug one prediction
app.get("/api/debug-prediction", async (req, res) => {
  try {
    const eventId =
      req.query.eventId;

    if (!eventId) {
      return res.status(400).json({
        error:
          "eventId is required"
      });
    }

    const prediction =
      await bsdFetch(
        `/events/${eventId}/prediction/`
      );

    res.json({
      version: VERSION,
      source: SOURCE,
      eventId,
      prediction
    });
  } catch (error) {
    res.status(
      error?.status || 500
    ).json({
      version: VERSION,
      source: SOURCE,
      error:
        error?.message ||
        "Prediction request failed",
      details:
        error?.data || null
    });
  }
});

// Debug odds
app.get("/api/debug-odds", async (req, res) => {
  try {
    const eventId =
      req.query.eventId;

    if (!eventId) {
      return res.status(400).json({
        error:
          "eventId is required"
      });
    }

    const data =
      await fetchEventOdds(
        eventId
      );

    const rows =
      extractRows(data);

    const normalized =
      normalizeOddsFeed(data);

    res.json({
      version: VERSION,
      source: SOURCE,
      eventId,
      rawRows: rows.length,
      normalizedRows:
        Array.from(
          normalized.entries()
        ).map(
          ([key, value]) => ({
            key,
            ...value
          })
        ),
      raw:
        data
    });
  } catch (error) {
    res.status(
      error?.status || 500
    ).json({
      version: VERSION,
      source: SOURCE,
      error:
        error?.message ||
        "Odds request failed",
      details:
        error?.data || null
    });
  }
});

// Debug complete event
app.get("/api/debug-event", async (req, res) => {
  try {
    const eventId =
      req.query.eventId;

    if (!eventId) {
      return res.status(400).json({
        error:
          "eventId is required"
      });
    }

    const event =
      await bsdFetch(
        `/events/${eventId}/`
      );

    res.json({
      version: VERSION,
      source: SOURCE,
      event
    });
  } catch (error) {
    res.status(
      error?.status || 500
    ).json({
      version: VERSION,
      source: SOURCE,
      error:
        error?.message ||
        "Event request failed",
      details:
        error?.data || null
    });
  }
});

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
