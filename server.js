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
const BSD_PUBLIC_BASE = "https://sports.bzzoiro.com/api";

const VERSION = "6.9.2";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;
const MAX_PREDICTIONS = 200;

const MIN_CONFIDENCE = 0.55;
const MIN_PUBLISHED_CONFIDENCE = 0.80;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.50;

const MIN_VALUE_EDGE = 0.0;

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 10) / 10;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeProbability(value) {
  const n = num(value);

  if (n === null) return null;

  if (n > 1) {
    return n / 100;
  }

  return n;
}

function normalizeDate(date) {
  if (!date) return null;

  const value = String(date);

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString().slice(0, 10);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeout || 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Token ${BSD_API_KEY}`
      },
      signal: controller.signal
    });

    const text = await response.text();

    let body = null;

    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    if (!response.ok) {
      const error = new Error(
        `BSD HTTP ${response.status}`
      );

      error.status = response.status;
      error.body = body;

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function extractResults(body) {
  if (!body) return [];

  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body.results)) {
    return body.results;
  }

  if (Array.isArray(body.data)) {
    return body.data;
  }

  if (Array.isArray(body.predictions)) {
    return body.predictions;
  }

  return [];
}

function getPredictionEvent(prediction) {
  if (!prediction || typeof prediction !== "object") {
    return null;
  }

  if (prediction.event && typeof prediction.event === "object") {
    return prediction.event;
  }

  return null;
}

function getEventId(prediction) {
  const event = getPredictionEvent(prediction);

  return (
    num(event?.id) ??
    num(prediction.event_id) ??
    num(prediction.match_id) ??
    null
  );
}

function getTeams(prediction) {
  const event = getPredictionEvent(prediction);

  return {
    home:
      event?.home_team ??
      prediction.home_team ??
      prediction.home ??
      "Home",

    away:
      event?.away_team ??
      prediction.away_team ??
      prediction.away ??
      "Away"
  };
}

function getEventDate(prediction) {
  const event = getPredictionEvent(prediction);

  return (
    event?.event_date ??
    prediction.event_date ??
    prediction.date ??
    null
  );
}

function getStatus(prediction) {
  const event = getPredictionEvent(prediction);

  return (
    event?.status ??
    prediction.status ??
    "unknown"
  );
}

function getConfidence(prediction) {
  return normalizeProbability(
    prediction.confidence ??
    prediction.model?.confidence ??
    null
  );
}

function getMarkets(prediction) {
  const markets = prediction.markets || {};

  const matchResult = markets.match_result || {};
  const overUnder = markets.over_under || {};
  const btts = markets.btts || {};
  const drawNoBet = markets.draw_no_bet || {};

  return {
    homeWin:
      normalizeProbability(
        prediction.prob_home_win ??
        matchResult.prob_home
      ),

    draw:
      normalizeProbability(
        prediction.prob_draw ??
        matchResult.prob_draw
      ),

    awayWin:
      normalizeProbability(
        prediction.prob_away_win ??
        matchResult.prob_away
      ),

    over15:
      normalizeProbability(
        prediction.prob_over_15 ??
        overUnder.prob_over_15
      ),

    over25:
      normalizeProbability(
        prediction.prob_over_25 ??
        overUnder.prob_over_25
      ),

    over35:
      normalizeProbability(
        prediction.prob_over_35 ??
        overUnder.prob_over_35
      ),

    bttsYes:
      normalizeProbability(
        prediction.prob_btts_yes ??
        btts.prob_yes
      ),

    dnbHome:
      normalizeProbability(
        drawNoBet.prob_home
      ),

    predicted:
      prediction.predicted_result ??
      matchResult.predicted ??
      null,

    mostLikelyScore:
      prediction.most_likely_score ??
      markets.score?.most_likely ??
      null
  };
}

function getOdds(prediction) {
  return {
    home:
      num(prediction.odds_home),

    draw:
      num(prediction.odds_draw),

    away:
      num(prediction.odds_away),

    over15:
      num(prediction.odds_over_15),

    over25:
      num(prediction.odds_over_25),

    over35:
      num(prediction.odds_over_35),

    under15:
      num(prediction.odds_under_15),

    under25:
      num(prediction.odds_under_25),

    under35:
      num(prediction.odds_under_35),

    bttsYes:
      num(prediction.odds_btts_yes),

    bttsNo:
      num(prediction.odds_btts_no)
  };
}

function calculateValue(probability, odds) {
  if (
    probability === null ||
    odds === null ||
    odds <= 1
  ) {
    return null;
  }

  const implied = 1 / odds;

  return probability - implied;
}

function valuePercent(probability, odds) {
  const edge = calculateValue(probability, odds);

  return edge === null ? null : pct(edge * 100);
}

function fairOdds(probability) {
  if (!probability || probability <= 0) {
    return null;
  }

  return Math.round((1 / probability) * 100) / 100;
}

function marketCandidate({
  market,
  selection,
  probability,
  odds,
  confidence,
  prediction,
  recommended = false
}) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  if (
    odds < MIN_ODDS ||
    odds > MAX_ODDS
  ) {
    return null;
  }

  const edge = calculateValue(probability, odds);

  if (edge === null) {
    return null;
  }

  const edgePct = edge * 100;

  const confidenceScore =
    confidence !== null
      ? confidence * 100
      : probability * 100;

  let score = 0;

  score += probability * 55;
  score += confidenceScore * 0.25;
  score += clamp(edgePct, -10, 20) * 1.2;

  if (recommended) {
    score += 8;
  }

  if (confidence !== null && confidence >= MIN_PUBLISHED_CONFIDENCE) {
    score += 10;
  }

  return {
    market,
    selection,
    probability: pct(probability * 100),
    confidence: pct(confidence * 100),
    odds,
    fairOdds: fairOdds(probability),
    valueEdge: pct(edgePct),
    score: Math.round(score * 100) / 100,
    recommendedByBSD: recommended,
    eventId: getEventId(prediction)
  };
}

function getCandidates(prediction) {
  const markets = getMarkets(prediction);
  const odds = getOdds(prediction);
  const confidence = getConfidence(prediction);

  const recommendations =
    prediction.recommendations || {};

  const candidates = [];

  const home = marketCandidate({
    market: "1X2",
    selection: "HOME",
    probability: markets.homeWin,
    odds: odds.home,
    confidence,
    prediction,
    recommended: recommendations.winner === true
  });

  if (home) candidates.push(home);

  const draw = marketCandidate({
    market: "1X2",
    selection: "DRAW",
    probability: markets.draw,
    odds: odds.draw,
    confidence,
    prediction,
    recommended: false
  });

  if (draw) candidates.push(draw);

  const away = marketCandidate({
    market: "1X2",
    selection: "AWAY",
    probability: markets.awayWin,
    odds: odds.away,
    confidence,
    prediction,
    recommended: recommendations.winner === true
  });

  if (away) candidates.push(away);

  const over15 = marketCandidate({
    market: "OVER_1.5",
    selection: "OVER 1.5",
    probability: markets.over15,
    odds: odds.over15,
    confidence,
    prediction,
    recommended: recommendations.over_15 === true
  });

  if (over15) candidates.push(over15);

  const over25 = marketCandidate({
    market: "OVER_2.5",
    selection: "OVER 2.5",
    probability: markets.over25,
    odds: odds.over25,
    confidence,
    prediction,
    recommended: recommendations.over_25 === true
  });

  if (over25) candidates.push(over25);

  const over35 = marketCandidate({
    market: "OVER_3.5",
    selection: "OVER 3.5",
    probability: markets.over35,
    odds: odds.over35,
    confidence,
    prediction,
    recommended: recommendations.over_35 === true
  });

  if (over35) candidates.push(over35);

  const btts = marketCandidate({
    market: "BTTS",
    selection: "YES",
    probability: markets.bttsYes,
    odds: odds.bttsYes,
    confidence,
    prediction,
    recommended: recommendations.btts === true
  });

  if (btts) candidates.push(btts);

  return candidates;
}

function getQuality(candidate, prediction) {
  const confidence = getConfidence(prediction);
  const markets = getMarkets(prediction);

  let quality = 0;

  quality += candidate.probability * 0.55;
  quality += Math.max(candidate.valueEdge, 0) * 1.5;

  if (confidence !== null) {
    quality += confidence * 20;
  }

  if (candidate.recommendedByBSD) {
    quality += 10;
  }

  if (
    markets.mostLikelyScore &&
    candidate.market !== "1X2"
  ) {
    quality += 2;
  }

  const event = getPredictionEvent(prediction);

  if (event?.referee) {
    quality += 2;
  }

  if (event?.unavailable_players) {
    quality += 2;
  }

  return Math.round(quality * 100) / 100;
}

function buildPick(prediction, candidate) {
  const event = getPredictionEvent(prediction);
  const teams = getTeams(prediction);
  const markets = getMarkets(prediction);

  return {
    rank: null,

    eventId: getEventId(prediction),

    match: `${teams.home} — ${teams.away}`,

    homeTeam: teams.home,
    awayTeam: teams.away,

    eventDate: getEventDate(prediction),

    status: getStatus(prediction),

    league:
      event?.league_name ??
      event?.league?.name ??
      null,

    country:
      event?.league?.country ??
      null,

    market: candidate.market,

    selection: candidate.selection,

    probability: candidate.probability,

    confidence: candidate.confidence,

    odds: candidate.odds,

    fairOdds: candidate.fairOdds,

    valueEdge: candidate.valueEdge,

    score: markets.mostLikelyScore,

    predictedResult: markets.predicted,

    expectedGoals: {
      home:
        num(
          prediction.expected_home_goals ??
          prediction.markets?.expected_goals?.home
        ),

      away:
        num(
          prediction.expected_away_goals ??
          prediction.markets?.expected_goals?.away
        )
    },

    referee: event?.referee
      ? {
          id: event.referee.id ?? null,
          name: event.referee.name ?? null,
          country: event.referee.country ?? null,
          careerGames:
            num(event.referee.career_games),
          careerYellowCards:
            num(event.referee.career_yellow_cards),
          careerRedCards:
            num(event.referee.career_red_cards)
        }
      : null,

    unavailablePlayers:
      event?.unavailable_players ?? null,

    recommendation:
      candidate.recommendedByBSD,

    qualityScore: null,

    model: {
      version:
        prediction.model_version ??
        prediction.model?.version ??
        null
    }
  };
}

async function getPredictionsForDate(date) {
  const targetDate = normalizeDate(date) || todayUTC();

  const urls = [
    `${BSD_BASE}/predictions/?date_from=${targetDate}&date_to=${targetDate}&limit=${MAX_PREDICTIONS}&offset=0`,
    `${BSD_PUBLIC_BASE}/predictions/?date_from=${targetDate}&date_to=${targetDate}&limit=${MAX_PREDICTIONS}&offset=0`
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const body = await fetchJson(url);

      const results = extractResults(body);

      if (results.length > 0) {
        return {
          results,
          count:
            num(body?.count, results.length),
          endpoint: url
        };
      }
    } catch (error) {
      lastError = {
        message: error.message,
        status: error.status ?? null,
        body: error.body ?? null
      };
    }
  }

  if (lastError) {
    throw new Error(
      `BSD predictions failed: ${lastError.message}`
    );
  }

  return {
    results: [],
    count: 0,
    endpoint: null
  };
}

function dedupeCandidates(candidates) {
  const map = new Map();

  for (const candidate of candidates) {
    const key =
      `${candidate.eventId}:${candidate.market}:${candidate.selection}`;

    const existing = map.get(key);

    if (!existing || candidate.score > existing.score) {
      map.set(key, candidate);
    }
  }

  return Array.from(map.values());
}

function selectTopPicks(predictions) {
  const allCandidates = [];

  for (const prediction of predictions) {
    const confidence = getConfidence(prediction);

    if (
      confidence !== null &&
      confidence < MIN_CONFIDENCE
    ) {
      continue;
    }

    const candidates = getCandidates(prediction);

    for (const candidate of candidates) {
      if (
        candidate.valueEdge !== null &&
        candidate.valueEdge >= MIN_VALUE_EDGE
      ) {
        candidate.internalQuality =
          getQuality(candidate, prediction);

        candidate.prediction = prediction;

        allCandidates.push(candidate);
      }
    }
  }

  const unique = dedupeCandidates(allCandidates);

  unique.sort((a, b) => {
    if (b.internalQuality !== a.internalQuality) {
      return b.internalQuality - a.internalQuality;
    }

    return b.probability - a.probability;
  });

  const usedEvents = new Set();
  const selected = [];

  for (const candidate of unique) {
    if (selected.length >= MAX_TOP_PICKS) {
      break;
    }

    /*
     * One main pick per match.
     * This prevents the analyzer from returning
     * three different markets from the same game.
     */
    if (usedEvents.has(candidate.eventId)) {
      continue;
    }

    const pick = buildPick(
      candidate.prediction,
      candidate
    );

    pick.qualityScore =
      candidate.internalQuality;

    pick.rank = selected.length + 1;

    selected.push(pick);

    usedEvents.add(candidate.eventId);
  }

  return selected;
}

async function analyze(date) {
  const started = Date.now();

  const targetDate =
    normalizeDate(date) || todayUTC();

  const predictionData =
    await getPredictionsForDate(targetDate);

  const predictions =
    predictionData.results.filter((prediction) => {
      const predictionDate =
        normalizeDate(getEventDate(prediction));

      return predictionDate === targetDate;
    });

  const topPicks =
    selectTopPicks(predictions);

  return {
    version: VERSION,
    source: SOURCE,

    date: targetDate,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - started,

    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      message:
        "Betting exchange data is not connected. No exchange movement is fabricated."
    },

    predictionsFound:
      predictions.length,

    qualificationCount:
      topPicks.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    thresholds: {
      minProbability: "derived from market probability",
      minConfidence:
        MIN_CONFIDENCE,

      publishedPredictionConfidence:
        MIN_PUBLISHED_CONFIDENCE,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      minValueEdge:
        `${MIN_VALUE_EDGE}%`
    },

    dataSource: {
      predictionsEndpoint:
        predictionData.endpoint,

      predictionsTotal:
        predictionData.count
    },

    topPicks
  };
}

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "ok",

    endpoints: [
      "/health",
      "/api/events",
      "/api/analyze",
      "/api/top-picks",
      "/api/debug-predictions"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    source: SOURCE,
    time: new Date().toISOString()
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      normalizeDate(req.query.date) ||
      todayUTC();

    const url =
      `${BSD_BASE}/events/?date=${date}&limit=100&offset=0`;

    const body =
      await fetchJson(url);

    res.json({
      version: VERSION,
      source: SOURCE,
      date,
      count:
        num(body?.count, extractResults(body).length),
      events:
        extractResults(body)
    });
  } catch (error) {
    res.status(502).json({
      version: VERSION,
      source: SOURCE,
      error: error.message,
      status: error.status ?? null
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const result =
      await analyze(req.query.date);

    res.json(result);
  } catch (error) {
    res.status(502).json({
      version: VERSION,
      source: SOURCE,
      error: error.message,
      status: error.status ?? null
    });
  }
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const result =
      await analyze(req.query.date);

    res.json({
      version: result.version,
      source: result.source,
      date: result.date,
      generatedAt: result.generatedAt,

      exchange: result.exchange,

      predictionsFound:
        result.predictionsFound,

      qualificationCount:
        result.qualificationCount,

      maxTopPicks:
        result.maxTopPicks,

      topPicks:
        result.topPicks
    });
  } catch (error) {
    res.status(502).json({
      version: VERSION,
      source: SOURCE,
      error: error.message,
      status: error.status ?? null
    });
  }
});

app.get("/api/debug-predictions", async (req, res) => {
  const targetDate =
    normalizeDate(req.query.date) ||
    todayUTC();

  const probes = [];

  const urls = [
    `${BSD_BASE}/predictions/?date_from=${targetDate}&date_to=${targetDate}&limit=5&offset=0`,
    `${BSD_BASE}/predictions/?upcoming=true&limit=5&offset=0`,
    `${BSD_PUBLIC_BASE}/predictions/?date_from=${targetDate}&date_to=${targetDate}&limit=5&offset=0`
  ];

  for (const url of urls) {
    try {
      const body =
        await fetchJson(url);

      const results =
        extractResults(body);

      probes.push({
        url,
        status: 200,
        ok: true,
        count:
          num(body?.count, results.length),
        resultsLength:
          results.length,

        firstPrediction:
          results[0]
            ? {
                id: results[0].id ?? null,
                eventId:
                  getEventId(results[0]),
                event:
                  getPredictionEvent(results[0]),
                confidence:
                  getConfidence(results[0]),
                markets:
                  results[0].markets ?? null,
                odds: {
                  home:
                    num(results[0].odds_home),
                  draw:
                    num(results[0].odds_draw),
                  away:
                    num(results[0].odds_away),
                  over15:
                    num(results[0].odds_over_15),
                  over25:
                    num(results[0].odds_over_25),
                  bttsYes:
                    num(results[0].odds_btts_yes)
                }
              }
            : null
      });
    } catch (error) {
      probes.push({
        url,
        status:
          error.status ?? null,
        ok: false,
        error: error.message,
        body:
          error.body ?? null
      });
    }
  }

  res.json({
    version: VERSION,
    source: SOURCE,
    date: targetDate,
    probes
  });
});

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
