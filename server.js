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

const VERSION = "4.3.0";
const SOURCE = "BSD";

/* =========================================================
   BASIC
========================================================= */

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    exchange: "optional",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

/* =========================================================
   BSD REQUEST
========================================================= */

async function bsdRequest(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${BSD_API_KEY}`,
      "X-API-Key": BSD_API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `BSD API ${response.status}: ${
        typeof data === "object"
          ? JSON.stringify(data)
          : String(data)
      }`
    );
  }

  return data;
}

/* =========================================================
   HELPERS
========================================================= */

function num(value, fallback = null) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function probabilityToOdds(probability) {
  if (!Number.isFinite(probability) || probability <= 0) {
    return null;
  }

  return round(100 / probability, 2);
}

function isValidProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

/* =========================================================
   EXCHANGE
========================================================= */

function normalizeExchange(exchange) {
  if (!exchange) {
    return {
      connected: false,
      status: "NOT_CONNECTED",
      usable: false,
      reason: "No exchange data available"
    };
  }

  const status = String(
    exchange.status ||
    exchange.state ||
    exchange.connection ||
    ""
  ).toUpperCase();

  const connected =
    status === "CONNECTED" ||
    status === "LIVE" ||
    status === "OK";

  if (!connected) {
    return {
      connected: false,
      status: status || "NOT_CONNECTED",
      usable: false,
      reason: "Exchange data unavailable"
    };
  }

  return {
    connected: true,
    status,
    usable: true,
    reason: null
  };
}

/*
  VERY IMPORTANT:

  NOT_CONNECTED must NEVER be interpreted as:
  - no money
  - no market movement
  - negative movement
  - positive movement

  It simply means:
  WE DO NOT HAVE EXCHANGE DATA.
*/

function getExchangeSignal(exchange) {
  const normalized = normalizeExchange(exchange);

  if (!normalized.usable) {
    return {
      available: false,
      signal: "UNKNOWN",
      strength: 0,
      movement: null
    };
  }

  const movement = num(
    exchange.movement ??
    exchange.priceMovement ??
    exchange.oddsMovement ??
    exchange.change
  );

  if (movement === null) {
    return {
      available: true,
      signal: "NEUTRAL",
      strength: 0,
      movement: null
    };
  }

  if (movement > 0.5) {
    return {
      available: true,
      signal: "UP",
      strength: clamp(Math.abs(movement), 0, 100),
      movement
    };
  }

  if (movement < -0.5) {
    return {
      available: true,
      signal: "DOWN",
      strength: clamp(Math.abs(movement), 0, 100),
      movement
    };
  }

  return {
    available: true,
    signal: "NEUTRAL",
    strength: 0,
    movement
  };
}

/* =========================================================
   PREDICTION NORMALIZATION
========================================================= */

function normalizePrediction(prediction = {}) {
  let home = num(
    prediction.home ??
    prediction.homeWin ??
    prediction.homeProbability
  );

  let draw = num(
    prediction.draw ??
    prediction.drawProbability
  );

  let away = num(
    prediction.away ??
    prediction.awayWin ??
    prediction.awayProbability
  );

  /*
    Some APIs can return decimal probabilities.
    Convert e.g. 0.35 -> 35.
  */

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

  home = clamp(home ?? 0, 0, 100);
  draw = clamp(draw ?? 0, 0, 100);
  away = clamp(away ?? 0, 0, 100);

  const total = home + draw + away;

  if (total > 0) {
    home = (home / total) * 100;
    draw = (draw / total) * 100;
    away = (away / total) * 100;
  }

  return {
    home: round(home),
    draw: round(draw),
    away: round(away)
  };
}

/* =========================================================
   MARKET GENERATION
========================================================= */

function buildMarkets(prediction) {
  const home = prediction.home;
  const draw = prediction.draw;
  const away = prediction.away;

  const markets = [];

  // 1X
  const oneX = home + draw;

  markets.push({
    market: "1X",
    label: "Gospodarz lub remis",
    probability: round(oneX),
    odds: probabilityToOdds(oneX),
    risk: oneX >= 75 ? "LOW" : oneX >= 65 ? "MEDIUM" : "HIGH"
  });

  // X2
  const x2 = draw + away;

  markets.push({
    market: "X2",
    label: "Remis lub goście",
    probability: round(x2),
    odds: probabilityToOdds(x2),
    risk: x2 >= 75 ? "LOW" : x2 >= 65 ? "MEDIUM" : "HIGH"
  });

  // 12
  const twelve = home + away;

  markets.push({
    market: "12",
    label: "Bez remisu",
    probability: round(twelve),
    odds: probabilityToOdds(twelve),
    risk: twelve >= 75 ? "LOW" : twelve >= 65 ? "MEDIUM" : "HIGH"
  });

  // Double chance / strongest side
  if (home >= away) {
    markets.push({
      market: "HOME",
      label: "Wygrana gospodarzy",
      probability: home,
      odds: probabilityToOdds(home),
      risk: home >= 65 ? "MEDIUM" : "HIGH"
    });
  } else {
    markets.push({
      market: "AWAY",
      label: "Wygrana gości",
      probability: away,
      odds: probabilityToOdds(away),
      risk: away >= 65 ? "MEDIUM" : "HIGH"
    });
  }

  /*
    Conservative draw protection.
    We don't automatically recommend exact scores,
    corners, cards, scorers etc. without appropriate data.
  */

  return markets;
}

/* =========================================================
   QUALITY FILTER
========================================================= */

function filterMarkets(markets) {
  return markets
    .filter(market => {
      if (!isValidProbability(market.probability)) {
        return false;
      }

      /*
        Remove extremely speculative selections.
      */
      if (market.probability < 55) {
        return false;
      }

      /*
        Avoid absurdly high artificial odds.
      */
      if (
        market.odds !== null &&
        market.odds > 2.0 &&
        market.probability < 60
      ) {
        return false;
      }

      return true;
    })
    .sort((a, b) => b.probability - a.probability);
}

/* =========================================================
   SCORE
========================================================= */

function calculateConfidence({
  probability,
  exchangeSignal,
  dataQuality
}) {
  let score = probability;

  /*
    Exchange movement is only a BONUS.

    If exchange is NOT_CONNECTED:
    score remains based on available data.
  */

  if (exchangeSignal.available) {
    if (exchangeSignal.signal === "UP") {
      score += 2;
    }

    if (exchangeSignal.signal === "DOWN") {
      score -= 2;
    }
  }

  if (dataQuality === "LIMITED") {
    score -= 3;
  }

  return clamp(round(score), 0, 99);
}

/* =========================================================
   ANALYZE EVENT
========================================================= */

function analyzeEvent(event) {
  const prediction = normalizePrediction(event.prediction);

  const exchange = normalizeExchange(event.exchange);

  const exchangeSignal = getExchangeSignal(event.exchange);

  const dataQuality =
    exchangeSignal.available
      ? "GOOD"
      : "LIMITED";

  let markets = buildMarkets(prediction);

  markets = filterMarkets(markets);

  const analyzed = markets.map(market => ({
    ...market,
    confidence: calculateConfidence({
      probability: market.probability,
      exchangeSignal,
      dataQuality
    }),
    exchangeSupport:
      exchangeSignal.available
        ? exchangeSignal.signal
        : "UNAVAILABLE"
  }));

  return {
    eventId: event.eventId ?? null,
    event: event.event ?? "Unknown event",
    date: event.date ?? null,
    status: event.status ?? "unknown",

    prediction,

    exchange: {
      connected: exchange.connected,
      status: exchange.status,
      usable: exchange.usable,
      signal: exchangeSignal.signal,
      movement: exchangeSignal.movement
    },

    dataQuality,

    markets: analyzed,

    warning:
      !exchange.usable
        ? "Exchange data unavailable. Analysis does not use exchange movement."
        : null
  };
}

/* =========================================================
   GENERIC EVENT ENDPOINT
========================================================= */

app.post("/analyze", async (req, res) => {
  try {
    const event = req.body;

    if (!event || typeof event !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Invalid request body"
      });
    }

    const result = analyzeEvent(event);

    return res.json({
      ok: true,
      source: SOURCE,
      version: VERSION,
      generatedAt: new Date().toISOString(),
      analysis: result
    });

  } catch (error) {
    console.error("ANALYZE ERROR:", error);

    return res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message
    });
  }
});

/* =========================================================
   BSD EVENT
========================================================= */

app.get("/event/:id", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);

    /*
      Try common BSD event routes.
      The first successful response is used.
    */

    const paths = [
      `/events/${id}`,
      `/event/${id}`,
      `/matches/${id}`,
      `/match/${id}`
    ];

    let data = null;
    let lastError = null;

    for (const path of paths) {
      try {
        data = await bsdRequest(path);
        if (data) break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!data) {
      throw lastError || new Error("Event not found");
    }

    const event =
      data.event ||
      data.match ||
      data.data ||
      data;

    const result = analyzeEvent(event);

    return res.json({
      ok: true,
      source: SOURCE,
      version: VERSION,
      generatedAt: new Date().toISOString(),
      analysis: result,
      rawAvailable: true
    });

  } catch (error) {
    console.error("EVENT ERROR:", error);

    return res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message
    });
  }
});

/* =========================================================
   TOP PICKS
========================================================= */

app.post("/top-picks", async (req, res) => {
  try {
    const events = Array.isArray(req.body)
      ? req.body
      : req.body.events;

    if (!Array.isArray(events)) {
      return res.status(400).json({
        ok: false,
        error: "events must be an array"
      });
    }

    const analyzed = events
      .map(event => {
        try {
          return analyzeEvent(event);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const picks = [];

    for (const analysis of analyzed) {
      for (const market of analysis.markets) {
        picks.push({
          eventId: analysis.eventId,
          event: analysis.event,
          date: analysis.date,

          market: market.market,
          label: market.label,

          probability: market.probability,
          odds: market.odds,

          confidence: market.confidence,

          exchange:
            analysis.exchange.usable
              ? analysis.exchange.signal
              : "NOT_CONNECTED",

          dataQuality: analysis.dataQuality
        });
      }
    }

    /*
      Sort only by confidence/probability.
      No fake "guaranteed" labels.
    */

    picks.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }

      return b.probability - a.probability;
    });

    const top10 = picks.slice(0, 10);

    return res.json({
      ok: true,
      source: SOURCE,
      version: VERSION,
      generatedAt: new Date().toISOString(),

      count: top10.length,

      disclaimer:
        "These are statistical selections, not guaranteed outcomes.",

      picks: top10
    });

  } catch (error) {
    console.error("TOP PICKS ERROR:", error);

    return res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message
    });
  }
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

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
  console.log("=======================================");
  console.log(" BET ANALYZER LIVE");
  console.log(` VERSION: ${VERSION}`);
  console.log(` SOURCE: ${SOURCE}`);
  console.log(` PORT: ${PORT}`);
  console.log(" EXCHANGE: OPTIONAL");
  console.log("=======================================");
});
