import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE = "https://sports.bzzoiro.com/api/v2";

const VERSION = "4.3.1";
const SOURCE = "BSD";

/* =========================================================
   BASIC
========================================================= */

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is missing");
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function probabilityToOdds(probability) {
  if (!Number.isFinite(probability) || probability <= 0) {
    return null;
  }

  return round(100 / probability, 2);
}

/* =========================================================
   BSD REQUEST
========================================================= */

async function bsdRequest(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured on Render");
  }

  const response = await fetch(`${BSD_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Token ${BSD_API_KEY}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.detail ||
      data?.error ||
      `BSD API HTTP ${response.status}`
    );

    error.status = response.status;
    error.code = data?.code || null;

    throw error;
  }

  return data;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Bet Analyzer Live",
    version: VERSION,
    status: "healthy",
    bsdConfigured: Boolean(BSD_API_KEY),
    timestamp: new Date().toISOString()
  });
});

/* =========================================================
   COVERAGE
========================================================= */

app.get("/api/coverage", async (req, res) => {
  try {
    const data = await fetch(
      "https://sports.bzzoiro.com/api/v2/coverage/?sport=football"
    ).then(r => r.json());

    res.json({
      ok: true,
      version: VERSION,
      coverage: data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   EVENTS
========================================================= */

app.get("/api/events", async (req, res) => {
  try {
    const params = new URLSearchParams();

    const allowed = [
      "league_id",
      "season_id",
      "team_id",
      "team_name",
      "status",
      "date_from",
      "date_to",
      "stage",
      "round",
      "limit",
      "offset"
    ];

    for (const key of allowed) {
      if (req.query[key] !== undefined) {
        params.set(key, String(req.query[key]));
      }
    }

    if (!params.has("limit")) {
      params.set("limit", "50");
    }

    const data = await bsdRequest(`/events/?${params.toString()}`);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      ...data
    });

  } catch (error) {
    console.error("EVENTS ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      version: VERSION,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   LIVE EVENTS
========================================================= */

app.get("/api/events/live", async (req, res) => {
  try {
    const params = new URLSearchParams();

    for (const key of ["league_id", "season_id", "team_id"]) {
      if (req.query[key] !== undefined) {
        params.set(key, String(req.query[key]));
      }
    }

    const suffix = params.toString()
      ? `?${params.toString()}`
      : "";

    const data = await bsdRequest(`/events/live/${suffix}`);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      live: data
    });

  } catch (error) {
    console.error("LIVE ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   EVENT DETAIL
========================================================= */

app.get("/api/events/:id", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const event = await bsdRequest(`/events/${id}/`);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      event
    });

  } catch (error) {
    console.error("EVENT DETAIL ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   PREDICTION
========================================================= */

app.get("/api/events/:id/prediction", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const prediction = await bsdRequest(
      `/events/${id}/prediction/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      prediction
    });

  } catch (error) {
    console.error("PREDICTION ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   ODDS
========================================================= */

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const odds = await bsdRequest(
      `/events/${id}/odds/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      odds
    });

  } catch (error) {
    console.error("ODDS ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   H2H
========================================================= */

app.get("/api/events/:id/h2h", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const h2h = await bsdRequest(
      `/events/${id}/h2h/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      h2h
    });

  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   STATS
========================================================= */

app.get("/api/events/:id/stats", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const stats = await bsdRequest(
      `/events/${id}/stats/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      stats
    });

  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   LINEUPS
========================================================= */

app.get("/api/events/:id/lineups", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const lineups = await bsdRequest(
      `/events/${id}/lineups/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      lineups
    });

  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   INCIDENTS
========================================================= */

app.get("/api/events/:id/incidents", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const incidents = await bsdRequest(
      `/events/${id}/incidents/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      incidents
    });

  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   POLYMARKET
========================================================= */

app.get("/api/events/:id/polymarket", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    const polymarket = await bsdRequest(
      `/events/${id}/polymarket/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      available: true,
      polymarket
    });

  } catch (error) {
    /*
      404 simply means there is no active market.
    */

    if (error.status === 404) {
      return res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        available: false,
        polymarket: null
      });
    }

    res.status(error.status || 500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   NORMALIZE PREDICTION
========================================================= */

function normalizePrediction(prediction) {
  const market =
    prediction?.markets?.match_result ||
    prediction?.prediction?.markets?.match_result ||
    {};

  let home = num(
    market.prob_home ??
    prediction?.home ??
    prediction?.home_win_prob
  );

  let draw = num(
    market.prob_draw ??
    prediction?.draw ??
    prediction?.draw_prob
  );

  let away = num(
    market.prob_away ??
    prediction?.away ??
    prediction?.away_win_prob
  );

  if (
    home !== null &&
    draw !== null &&
    away !== null &&
    home <= 1 &&
    draw <= 1 &&
    away <= 1
  ) {
    home *= 100;
    draw *= 100;
    away *= 100;
  }

  if (
    home === null ||
    draw === null ||
    away === null
  ) {
    return null;
  }

  const total = home + draw + away;

  if (total <= 0) {
    return null;
  }

  return {
    home: round((home / total) * 100, 1),
    draw: round((draw / total) * 100, 1),
    away: round((away / total) * 100, 1)
  };
}

/* =========================================================
   ODDS NORMALIZATION
========================================================= */

function normalizeOdds(odds) {
  const result = {
    match: {},
    goals: {},
    btts: {},
    doubleChance: {},
    movements: []
  };

  if (!odds) {
    return result;
  }

  /*
    BSD can return an object containing:
    markets[]
    or rows/results depending on endpoint/version.
  */

  const rows = [];

  if (Array.isArray(odds)) {
    rows.push(...odds);
  }

  if (Array.isArray(odds.results)) {
    rows.push(...odds.results);
  }

  if (Array.isArray(odds.markets)) {
    for (const market of odds.markets) {
      if (Array.isArray(market.bookmakers)) {
        for (const bookmaker of market.bookmakers) {
          rows.push({
            ...market,
            ...bookmaker
          });
        }
      }
    }
  }

  /*
    Direct match winner shape.
  */

  if (odds.match_winner) {
    result.match = odds.match_winner;
  }

  if (odds.matchWinner) {
    result.match = odds.matchWinner;
  }

  /*
    Consensus shape.
  */

  if (odds.consensus) {
    result.match = {
      ...result.match,
      ...odds.consensus
    };
  }

  for (const row of rows) {
    const market = String(
      row.market ||
      row.market_kind ||
      row.market_family ||
      ""
    ).toLowerCase();

    const outcome = String(
      row.outcome ||
      row.selection ||
      ""
    );

    const price = num(
      row.decimal_odds ??
      row.odds ??
      row.price ??
      row.current_odds
    );

    const previous = num(
      row.previous_decimal_odds ??
      row.previous_odds
    );

    const opening = num(
      row.opening_decimal_odds ??
      row.opening_odds
    );

    const movement =
      row.movement ||
      null;

    const item = {
      market,
      outcome,
      odds: price,
      previousOdds: previous,
      openingOdds: opening,
      movement,
      bookmaker:
        row.bookmaker_name ||
        row.bookmaker_slug ||
        "consensus",
      updatedAt: row.updated_at || null
    };

    if (
      movement ||
      (
        previous !== null &&
        price !== null &&
        previous !== price
      )
    ) {
      result.movements.push(item);
    }

    if (
      market === "1x2" ||
      market === "match_winner" ||
      market === "winner"
    ) {
      if (outcome === "HOME") {
        result.match.home = item;
      }

      if (outcome === "DRAW") {
        result.match.draw = item;
      }

      if (outcome === "AWAY") {
        result.match.away = item;
      }
    }

    if (market === "btts") {
      if (outcome.toLowerCase() === "yes") {
        result.btts.yes = item;
      }

      if (outcome.toLowerCase() === "no") {
        result.btts.no = item;
      }
    }

    if (market === "double_chance") {
      if (outcome === "1X") {
        result.doubleChance["1X"] = item;
      }

      if (outcome === "X2") {
        result.doubleChance["X2"] = item;
      }

      if (outcome === "12") {
        result.doubleChance["12"] = item;
      }
    }

    if (market.includes("over_under_25")) {
      if (outcome.toLowerCase() === "over") {
        result.goals.over25 = item;
      }

      if (outcome.toLowerCase() === "under") {
        result.goals.under25 = item;
      }
    }
  }

  return result;
}

/* =========================================================
   MARKET CANDIDATES
========================================================= */

function createCandidates(prediction, odds) {
  const candidates = [];

  if (!prediction) {
    return candidates;
  }

  const home = prediction.home;
  const draw = prediction.draw;
  const away = prediction.away;

  /*
    Conservative markets first.
  */

  candidates.push({
    market: "1X",
    label: "1X — gospodarz lub remis",
    probability: home + draw,
    price: odds.doubleChance?.["1X"]?.odds ?? null,
    movement: odds.doubleChance?.["1X"]?.movement ?? null,
    source: "BSD prediction"
  });

  candidates.push({
    market: "X2",
    label: "X2 — remis lub goście",
    probability: away + draw,
    price: odds.doubleChance?.["X2"]?.odds ?? null,
    movement: odds.doubleChance?.["X2"]?.movement ?? null,
    source: "BSD prediction"
  });

  candidates.push({
    market: "12",
    label: "12 — bez remisu",
    probability: home + away,
    price: odds.doubleChance?.["12"]?.odds ?? null,
    movement: odds.doubleChance?.["12"]?.movement ?? null,
    source: "BSD prediction"
  });

  /*
    Straight winner only when model gives enough separation.
  */

  if (home >= 55) {
    candidates.push({
      market: "HOME",
      label: "1 — wygrana gospodarzy",
      probability: home,
      price: odds.match?.home?.odds ?? null,
      movement: odds.match?.home?.movement ?? null,
      source: "BSD prediction"
    });
  }

  if (away >= 55) {
    candidates.push({
      market: "AWAY",
      label: "2 — wygrana gości",
      probability: away,
      price: odds.match?.away?.odds ?? null,
      movement: odds.match?.away?.movement ?? null,
      source: "BSD prediction"
    });
  }

  /*
    Goals / BTTS are only added if BSD actually provides
    those model probabilities.
  */

  /*
    We intentionally DO NOT invent probability for:
    - corners
    - cards
    - exact score
    - player scorers
    - handicaps

    unless BSD provides it.
  */

  return candidates;
}

/* =========================================================
   MARKET SCORING
========================================================= */

function scoreCandidate(candidate) {
  let score = candidate.probability;

  /*
    Odds value check.

    If model probability is materially above
    the implied probability, mark as value.
  */

  if (candidate.price && candidate.price > 1) {
    const implied = 100 / candidate.price;

    candidate.impliedProbability = round(implied, 1);

    candidate.edge = round(
      candidate.probability - implied,
      1
    );

    if (candidate.edge >= 5) {
      score += 4;
    } else if (candidate.edge >= 2) {
      score += 2;
    } else if (candidate.edge < -5) {
      score -= 5;
    } else if (candidate.edge < -2) {
      score -= 2;
    }
  } else {
    candidate.impliedProbability = null;
    candidate.edge = null;
  }

  /*
    Genuine market movement.

    SHORTENING = odds falling.
    DRIFTING = odds rising.

    Movement is never treated as proof of outcome.
  */

  if (candidate.movement === "SHORTENING") {
    score += 2;
  }

  if (candidate.movement === "DRIFTING") {
    score -= 2;
  }

  candidate.score = clamp(round(score, 1), 0, 99);

  return candidate;
}

/* =========================================================
   ANALYSIS
========================================================= */

async function buildAnalysis(eventId) {
  const [
    event,
    prediction,
    odds,
    h2h
  ] = await Promise.allSettled([
    bsdRequest(`/events/${eventId}/`),
    bsdRequest(`/events/${eventId}/prediction/`),
    bsdRequest(`/events/${eventId}/odds/`),
    bsdRequest(`/events/${eventId}/h2h/`)
  ]);

  const eventData =
    event.status === "fulfilled"
      ? event.value
      : null;

  const predictionData =
    prediction.status === "fulfilled"
      ? prediction.value
      : null;

  const oddsData =
    odds.status === "fulfilled"
      ? odds.value
      : null;

  const h2hData =
    h2h.status === "fulfilled"
      ? h2h.value
      : null;

  const normalizedPrediction =
    normalizePrediction(predictionData);

  const normalizedOdds =
    normalizeOdds(oddsData);

  let candidates =
    createCandidates(
      normalizedPrediction,
      normalizedOdds
    );

  candidates =
    candidates
      .map(scoreCandidate)
      .filter(candidate => {
        /*
          No ultra-low probability bets.
        */

        return candidate.probability >= 55;
      })
      .sort((a, b) => {
        return b.score - a.score;
      });

  /*
    Maximum 10.
  */

  candidates = candidates.slice(0, 10);

  const exchangeAvailable = false;

  return {
    event: eventData,

    prediction: normalizedPrediction,

    odds: normalizedOdds,

    h2h: h2hData,

    exchange: {
      available: exchangeAvailable,
      status: "NOT_CONNECTED",
      signal: null,
      message:
        "Exchange data is not connected. No exchange signal is used in scoring."
    },

    candidates,

    dataQuality: {
      prediction: Boolean(normalizedPrediction),
      odds: Boolean(oddsData),
      h2h: Boolean(h2hData),
      exchange: false
    },

    generatedAt: new Date().toISOString()
  };
}

/* =========================================================
   ANALYZE ONE MATCH
========================================================= */

app.get("/api/analyze/:id", async (req, res) => {
  try {
    const eventId = Number(req.params.id);

    if (!Number.isInteger(eventId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid event id"
      });
    }

    const analysis =
      await buildAnalysis(eventId);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      analysis
    });

  } catch (error) {
    console.error("ANALYSIS ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      version: VERSION,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   TOP PICKS
========================================================= */

app.get("/api/top-picks", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const eventsData =
      await bsdRequest(
        `/events/?status=upcoming&date_from=${date}&date_to=${date}&limit=50`
      );

    const events =
      Array.isArray(eventsData)
        ? eventsData
        : eventsData.results || [];

    const picks = [];

    /*
      Analyze matches sequentially with a small delay
      to avoid hammering the API.
    */

    for (const event of events.slice(0, 30)) {
      const eventId =
        event.id ??
        event.event_id;

      if (!eventId) continue;

      try {
        const analysis =
          await buildAnalysis(eventId);

        for (const candidate of analysis.candidates) {
          picks.push({
            eventId,

            home:
              event.home_team?.name ??
              event.home_team ??
              event.home ??
              null,

            away:
              event.away_team?.name ??
              event.away_team ??
              event.away ??
              null,

            kickoff:
              event.kickoff_at ??
              event.date ??
              event.start_time ??
              null,

            market: candidate.market,
            label: candidate.label,

            probability:
              candidate.probability,

            odds:
              candidate.price,

            impliedProbability:
              candidate.impliedProbability,

            edge:
              candidate.edge,

            movement:
              candidate.movement,

            score:
              candidate.score,

            exchange:
              "NOT_CONNECTED"
          });
        }

        await new Promise(
          resolve => setTimeout(resolve, 120)
        );

      } catch (error) {
        console.warn(
          `Skipping event ${eventId}:`,
          error.message
        );
      }
    }

    /*
      Remove duplicates.
    */

    const unique = [];

    const seen = new Set();

    for (const pick of picks) {
      const key =
        `${pick.eventId}-${pick.market}`;

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(pick);
    }

    unique.sort(
      (a, b) => b.score - a.score
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      exchange:
        "NOT_CONNECTED",
      exchangeMessage:
        "Exchange data unavailable. Picks are not scored using exchange movement.",
      count:
        Math.min(unique.length, 10),
      picks:
        unique.slice(0, 10),
      disclaimer:
        "Statistical analysis only. No outcome is guaranteed."
    });

  } catch (error) {
    console.error("TOP PICKS ERROR:", error);

    res.status(error.status || 500).json({
      ok: false,
      version: VERSION,
      error: error.message,
      code: error.code || null
    });
  }
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  res.status(500).json({
    ok: false,
    version: VERSION,
    error: "Internal server error"
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log("---------------------------------------");
  console.log(" BET ANALYZER LIVE");
  console.log(` VERSION: ${VERSION}`);
  console.log(` PORT: ${PORT}`);
  console.log(` BSD: ${BSD_BASE}`);
  console.log(" FOOTBALL API: CONNECTED");
  console.log(" EXCHANGE: OPTIONAL");
  console.log("---------------------------------------");
});
