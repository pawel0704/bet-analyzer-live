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

const VERSION = "6.9.4";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;
const PAGE_SIZE = 200;

const MIN_CONFIDENCE = 0.55;
const HIGH_CONFIDENCE = 0.80;

const MIN_PROBABILITY = 0.60;

const MIN_ODDS = 1.15;
const MAX_ODDS = 5.50;

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 10) / 10;
}

function normalizeProbability(value) {
  const n = num(value);

  if (n === null) {
    return null;
  }

  return n > 1 ? n / 100 : n;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const str = String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const date = new Date(str);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

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

    let body;

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
  if (!body) {
    return [];
  }

  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body.results)) {
    return body.results;
  }

  if (Array.isArray(body.data)) {
    return body.data;
  }

  return [];
}

function getEvent(prediction) {
  return prediction?.event || {};
}

function getEventId(prediction) {
  const event = getEvent(prediction);

  return (
    num(event.id) ??
    num(prediction.event_id) ??
    num(prediction.match_id) ??
    null
  );
}

function getEventDate(prediction) {
  const event = getEvent(prediction);

  return (
    event.event_date ??
    prediction.event_date ??
    prediction.date ??
    null
  );
}

function getTeams(prediction) {
  const event = getEvent(prediction);

  return {
    home:
      event.home_team ??
      prediction.home_team ??
      "Home",

    away:
      event.away_team ??
      prediction.away_team ??
      "Away"
  };
}

function getConfidence(prediction) {
  return normalizeProbability(
    prediction.confidence ??
    prediction.model?.confidence ??
    null
  );
}

function getMarkets(prediction) {
  const markets =
    prediction.markets || {};

  const matchResult =
    markets.match_result || {};

  const overUnder =
    markets.over_under || {};

  const btts =
    markets.btts || {};

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

  return probability - (1 / odds);
}

function fairOdds(probability) {
  if (
    probability === null ||
    probability <= 0
  ) {
    return null;
  }

  return Math.round(
    (1 / probability) * 100
  ) / 100;
}

function getRecommendedMarkets(prediction) {
  const recommendations =
    prediction.recommendations || {};

  const markets =
    getMarkets(prediction);

  const result = [];

  if (
    recommendations.over_15 === true &&
    markets.over15 !== null
  ) {
    result.push("OVER_1.5");
  }

  if (
    recommendations.over_25 === true &&
    markets.over25 !== null
  ) {
    result.push("OVER_2.5");
  }

  if (
    recommendations.over_35 === true &&
    markets.over35 !== null
  ) {
    result.push("OVER_3.5");
  }

  if (
    recommendations.btts === true &&
    markets.bttsYes !== null
  ) {
    result.push("BTTS");
  }

  if (
    recommendations.winner === true
  ) {
    result.push("WINNER");
  }

  return result;
}

function makeCandidate(
  prediction,
  market,
  selection,
  probability,
  odds,
  recommended
) {
  if (
    probability === null ||
    probability < MIN_PROBABILITY
  ) {
    return null;
  }

  if (
    odds === null ||
    odds < MIN_ODDS ||
    odds > MAX_ODDS
  ) {
    return null;
  }

  const confidence =
    getConfidence(prediction);

  if (
    confidence !== null &&
    confidence < MIN_CONFIDENCE
  ) {
    return null;
  }

  const value =
    calculateValue(
      probability,
      odds
    );

  const probabilityPct =
    probability * 100;

  const confidencePct =
    confidence !== null
      ? confidence * 100
      : probabilityPct;

  const valuePct =
    value === null
      ? null
      : value * 100;

  /*
   * IMPORTANT:
   *
   * Value no longer decides whether
   * the pick is accepted.
   *
   * BSD itself says its confidence
   * system is not a claim that the
   * bookmaker price is beatable.
   */

  let score = 0;

  score +=
    probabilityPct * 0.60;

  score +=
    confidencePct * 0.25;

  if (
    valuePct !== null
  ) {
    score +=
      Math.max(
        -10,
        Math.min(15, valuePct)
      ) * 0.50;
  }

  if (recommended) {
    score += 15;
  }

  if (
    confidence !== null &&
    confidence >= HIGH_CONFIDENCE
  ) {
    score += 12;
  }

  /*
   * Slight preference for safer odds.
   * This is a ranking factor only.
   */

  if (odds <= 1.60) {
    score += 3;
  } else if (odds <= 2.00) {
    score += 1;
  }

  return {
    prediction,

    eventId:
      getEventId(prediction),

    market,

    selection,

    probability:
      pct(probabilityPct),

    confidence:
      confidence === null
        ? null
        : pct(confidencePct),

    odds,

    fairOdds:
      fairOdds(probability),

    valueEdge:
      valuePct === null
        ? null
        : pct(valuePct),

    recommendedByBSD:
      recommended,

    score:
      Math.round(score * 100) / 100
  };
}

function getCandidates(prediction) {
  const markets =
    getMarkets(prediction);

  const odds =
    getOdds(prediction);

  const recommendations =
    prediction.recommendations || {};

  const candidates = [];

  /*
   * 1X2
   */

  const home =
    makeCandidate(
      prediction,
      "1X2",
      "HOME",
      markets.homeWin,
      odds.home,
      recommendations.winner === true &&
      recommendations.favorite === "H"
    );

  if (home) {
    candidates.push(home);
  }

  const away =
    makeCandidate(
      prediction,
      "1X2",
      "AWAY",
      markets.awayWin,
      odds.away,
      recommendations.winner === true &&
      recommendations.favorite === "A"
    );

  if (away) {
    candidates.push(away);
  }

  /*
   * OVER 1.5
   */

  const over15 =
    makeCandidate(
      prediction,
      "OVER_1.5",
      "OVER 1.5",
      markets.over15,
      odds.over15,
      recommendations.over_15 === true
    );

  if (over15) {
    candidates.push(over15);
  }

  /*
   * OVER 2.5
   */

  const over25 =
    makeCandidate(
      prediction,
      "OVER_2.5",
      "OVER 2.5",
      markets.over25,
      odds.over25,
      recommendations.over_25 === true
    );

  if (over25) {
    candidates.push(over25);
  }

  /*
   * OVER 3.5
   */

  const over35 =
    makeCandidate(
      prediction,
      "OVER_3.5",
      "OVER 3.5",
      markets.over35,
      odds.over35,
      recommendations.over_35 === true
    );

  if (over35) {
    candidates.push(over35);
  }

  /*
   * BTTS YES
   */

  const btts =
    makeCandidate(
      prediction,
      "BTTS",
      "YES",
      markets.bttsYes,
      odds.bttsYes,
      recommendations.btts === true
    );

  if (btts) {
    candidates.push(btts);
  }

  return candidates;
}

function calculateQuality(candidate) {
  let score =
    candidate.score;

  const prediction =
    candidate.prediction;

  const event =
    getEvent(prediction);

  /*
   * Additional context.
   */

  if (event.referee) {
    score += 2;
  }

  if (event.unavailable_players) {
    score += 2;
  }

  if (
    prediction.expected_home_goals !== undefined ||
    prediction.expected_away_goals !== undefined
  ) {
    score += 2;
  }

  return Math.round(
    score * 100
  ) / 100;
}

function buildPick(candidate) {
  const prediction =
    candidate.prediction;

  const event =
    getEvent(prediction);

  const teams =
    getTeams(prediction);

  const markets =
    getMarkets(prediction);

  const expectedGoals =
    prediction.markets?.expected_goals ||
    {};

  return {
    rank: null,

    eventId:
      candidate.eventId,

    match:
      `${teams.home} — ${teams.away}`,

    homeTeam:
      teams.home,

    awayTeam:
      teams.away,

    eventDate:
      getEventDate(prediction),

    status:
      event.status ??
      "unknown",

    league:
      event.league?.name ??
      event.league_name ??
      null,

    country:
      event.league?.country ??
      null,

    market:
      candidate.market,

    selection:
      candidate.selection,

    probability:
      candidate.probability,

    confidence:
      candidate.confidence,

    odds:
      candidate.odds,

    fairOdds:
      candidate.fairOdds,

    valueEdge:
      candidate.valueEdge,

    qualityScore:
      calculateQuality(candidate),

    recommendedByBSD:
      candidate.recommendedByBSD,

    predictedResult:
      markets.predicted,

    mostLikelyScore:
      markets.mostLikelyScore,

    expectedGoals: {
      home:
        num(
          prediction.expected_home_goals ??
          expectedGoals.home
        ),

      away:
        num(
          prediction.expected_away_goals ??
          expectedGoals.away
        )
    },

    referee:
      event.referee
        ? {
            id:
              event.referee.id ??
              null,

            name:
              event.referee.name ??
              null,

            country:
              event.referee.country ??
              null,

            careerGames:
              num(
                event.referee.career_games
              ),

            careerYellowCards:
              num(
                event.referee.career_yellow_cards
              ),

            careerRedCards:
              num(
                event.referee.career_red_cards
              )
          }
        : null,

    unavailablePlayers:
      event.unavailable_players ??
      null,

    funfacts:
      event.funfacts ??
      null,

    model: {
      version:
        prediction.model_version ??
        prediction.model?.version ??
        null
    }
  };
}

async function getAllPredictions() {
  const all = [];

  let offset = 0;
  let total = null;

  while (true) {
    const url =
      `${BSD_PUBLIC_BASE}/predictions/?limit=${PAGE_SIZE}&offset=${offset}`;

    const body =
      await fetchJson(url);

    const results =
      extractResults(body);

    if (
      total === null &&
      body?.count !== undefined
    ) {
      total =
        num(
          body.count,
          null
        );
    }

    all.push(
      ...results
    );

    if (
      results.length === 0
    ) {
      break;
    }

    offset +=
      results.length;

    if (
      total !== null &&
      offset >= total
    ) {
      break;
    }

    if (
      results.length <
      PAGE_SIZE
    ) {
      break;
    }

    if (
      offset >= 1000
    ) {
      break;
    }
  }

  return {
    predictions: all,

    total:
      total ??
      all.length
  };
}

function filterByDate(
  predictions,
  targetDate
) {
  return predictions.filter(
    (prediction) => {
      return (
        normalizeDate(
          getEventDate(
            prediction
          )
        ) === targetDate
      );
    }
  );
}

function dedupeCandidates(
  candidates
) {
  const map =
    new Map();

  for (
    const candidate
    of candidates
  ) {
    const key =
      `${candidate.eventId}:${candidate.market}:${candidate.selection}`;

    const existing =
      map.get(key);

    if (
      !existing ||
      candidate.score >
      existing.score
    ) {
      map.set(
        key,
        candidate
      );
    }
  }

  return Array.from(
    map.values()
  );
}

function selectTopPicks(
  predictions
) {
  const allCandidates = [];

  for (
    const prediction
    of predictions
  ) {
    const candidates =
      getCandidates(
        prediction
      );

    allCandidates.push(
      ...candidates
    );
  }

  const unique =
    dedupeCandidates(
      allCandidates
    );

  unique.sort(
    (a, b) => {
      const qa =
        calculateQuality(a);

      const qb =
        calculateQuality(b);

      if (qb !== qa) {
        return qb - qa;
      }

      return (
        b.probability -
        a.probability
      );
    }
  );

  const selected = [];

  const usedEvents =
    new Set();

  for (
    const candidate
    of unique
  ) {
    if (
      selected.length >=
      MAX_TOP_PICKS
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

    const pick =
      buildPick(
        candidate
      );

    pick.rank =
      selected.length + 1;

    selected.push(
      pick
    );

    usedEvents.add(
      candidate.eventId
    );
  }

  return selected;
}

async function analyze(
  requestedDate
) {
  const started =
    Date.now();

  const targetDate =
    normalizeDate(
      requestedDate
    ) || todayUTC();

  const data =
    await getAllPredictions();

  const predictions =
    filterByDate(
      data.predictions,
      targetDate
    );

  const topPicks =
    selectTopPicks(
      predictions
    );

  return {
    version:
      VERSION,

    source:
      SOURCE,

    date:
      targetDate,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - started,

    exchange: {
      connected: false,

      status:
        "NOT_CONNECTED",

      message:
        "Betting exchange data is not connected. No exchange movement is fabricated."
    },

    predictionsTotal:
      data.total,

    predictionsDownloaded:
      data.predictions.length,

    predictionsFound:
      predictions.length,

    candidatesFound:
      predictions.reduce(
        (total, prediction) =>
          total +
          getCandidates(
            prediction
          ).length,
        0
      ),

    qualificationCount:
      topPicks.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    filters: {
      minConfidence:
        MIN_CONFIDENCE,

      highConfidence:
        HIGH_CONFIDENCE,

      minProbability:
        MIN_PROBABILITY,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      valueIsRankingFactor:
        true,

      valueIsHardFilter:
        false
    },

    topPicks
  };
}

app.get(
  "/",
  (req, res) => {
    res.json({
      name:
        "Bet Analyzer Live",

      version:
        VERSION,

      source:
        SOURCE,

      status:
        "ok",

      endpoints: [
        "/health",
        "/api/events",
        "/api/analyze",
        "/api/top-picks",
        "/api/debug-predictions"
      ]
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

      time:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        normalizeDate(
          req.query.date
        ) || todayUTC();

      const url =
        `${BSD_BASE}/events/?date_from=${date}&date_to=${date}&limit=100&offset=0`;

      const body =
        await fetchJson(url);

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        date,

        count:
          num(
            body?.count,
            extractResults(body).length
          ),

        events:
          extractResults(body)
      });
    } catch (error) {
      res.status(502).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message,

        status:
          error.status ?? null
      });
    }
  }
);

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const result =
        await analyze(
          req.query.date
        );

      res.json(result);
    } catch (error) {
      res.status(502).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message,

        status:
          error.status ?? null
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const result =
        await analyze(
          req.query.date
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

        filters:
          result.filters,

        topPicks:
          result.topPicks
      });
    } catch (error) {
      res.status(502).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message,

        status:
          error.status ?? null
      });
    }
  }
);

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const data =
        await getAllPredictions();

      const targetDate =
        normalizeDate(
          req.query.date
        ) || todayUTC();

      const dayPredictions =
        filterByDate(
          data.predictions,
          targetDate
        );

      const sample =
        dayPredictions
          .slice(0, 10)
          .map(
            (prediction) => ({
              id:
                prediction.id ??
                null,

              eventId:
                getEventId(
                  prediction
                ),

              date:
                getEventDate(
                  prediction
                ),

              teams:
                getTeams(
                  prediction
                ),

              confidence:
                getConfidence(
                  prediction
                ),

              recommendations:
                prediction.recommendations ??
                null,

              candidates:
                getCandidates(
                  prediction
                ).map(
                  (candidate) => ({
                    market:
                      candidate.market,

                    selection:
                      candidate.selection,

                    probability:
                      candidate.probability,

                    confidence:
                      candidate.confidence,

                    odds:
                      candidate.odds,

                    valueEdge:
                      candidate.valueEdge,

                    recommendedByBSD:
                      candidate.recommendedByBSD
                  })
                )
            })
          );

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

        total:
          data.total,

        downloaded:
          data.predictions.length,

        targetDate,

        dayPredictions:
          dayPredictions.length,

        sample
      });
    } catch (error) {
      res.status(502).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          error.message,

        status:
          error.status ?? null
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
