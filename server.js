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

const VERSION = "4.3.2";
const SOURCE = "BSD";

if (!BSD_API_KEY) {
  console.error("ERROR: BSD_API_KEY is missing");
}

const headers = {
  Authorization: `Token ${BSD_API_KEY}`,
  Accept: "application/json",
};

function todayWarsaw() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function probabilityToFairOdds(probability) {
  if (!Number.isFinite(probability) || probability <= 0) return null;
  return round(100 / probability, 2);
}

function calculateValue(probability, odds) {
  if (
    !Number.isFinite(probability) ||
    !Number.isFinite(odds) ||
    probability <= 0 ||
    odds <= 1
  ) {
    return null;
  }

  return round((probability / 100) * odds - 1, 4);
}

function valuePercent(probability, odds) {
  const value = calculateValue(probability, odds);
  if (value === null) return null;
  return round(value * 100, 2);
}

function normalizeProbability(value) {
  if (value === null || value === undefined) return null;

  let n = Number(value);

  if (!Number.isFinite(n)) return null;

  // Obsługa zarówno 0.70 jak i 70
  if (n > 0 && n <= 1) n *= 100;

  return clamp(n, 0, 100);
}

function normalizeMovement(movement) {
  if (!movement) return "UNAVAILABLE";

  const m = String(movement).toUpperCase();

  if (["SHORTENING", "STEAM", "DOWN"].includes(m)) {
    return "SHORTENING";
  }

  if (["DRIFTING", "DRIFT", "UP"].includes(m)) {
    return "DRIFTING";
  }

  if (["STABLE", "UNCHANGED"].includes(m)) {
    return "STABLE";
  }

  return m;
}

async function bsdRequest(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      `BSD HTTP ${response.status}: ${data?.detail || data?.message || text}`
    );

    error.status = response.status;
    error.data = data;

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
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Bet Analyzer Live",
    version: VERSION,
    source: SOURCE,
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   COVERAGE
========================================================= */

app.get("/api/coverage", async (req, res) => {
  try {
    const sport = req.query.sport
      ? `?sport=${encodeURIComponent(req.query.sport)}`
      : "";

    const response = await fetch(
      `https://sports.bzzoiro.com/api/v2/coverage/${sport}`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    const data = await response.json();

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      coverage: data,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
    });
  }
});

/* =========================================================
   EVENTS
========================================================= */

app.get("/api/events", async (req, res) => {
  try {
    const date = req.query.date || todayWarsaw();
    const dateFrom = req.query.date_from || date;
    const dateTo = req.query.date_to || date;

    const params = new URLSearchParams();

    params.set("date_from", dateFrom);
    params.set("date_to", dateTo);

    if (req.query.status) {
      params.set("status", req.query.status);
    }

    if (req.query.league_id) {
      params.set("league_id", req.query.league_id);
    }

    if (req.query.team) {
      params.set("team", req.query.team);
    }

    if (req.query.limit) {
      params.set("limit", String(Math.min(Number(req.query.limit), 200)));
    } else {
      params.set("limit", "100");
    }

    if (req.query.offset) {
      params.set("offset", String(Number(req.query.offset)));
    }

    const data = await bsdRequest(`/events/?${params.toString()}`);

    let results = Array.isArray(data?.results) ? data.results : [];

    // Dodatkowa ochrona przed błędnym filtrem upstream
    if (dateFrom && dateTo) {
      results = results.filter((event) => {
        if (!event?.event_date) return false;

        const d = String(event.event_date).slice(0, 10);

        return d >= dateFrom && d <= dateTo;
      });
    }

    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    if (search) {
      results = results.filter((event) => {
        const home = String(event.home_team || "").toLowerCase();
        const away = String(event.away_team || "").toLowerCase();

        return home.includes(search) || away.includes(search);
      });
    }

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date_from: dateFrom,
      date_to: dateTo,
      count: results.length,
      total_available: data?.count ?? results.length,
      next: data?.next || null,
      previous: data?.previous || null,
      results,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
});

/* =========================================================
   LIVE EVENTS
========================================================= */

app.get("/api/events/live", async (req, res) => {
  try {
    const data = await bsdRequest("/events/live/");

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      count: Array.isArray(data?.results)
        ? data.results.length
        : Array.isArray(data)
        ? data.length
        : 0,
      results: data?.results || data || [],
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
    });
  }
});

/* =========================================================
   EVENT DETAIL
========================================================= */

app.get("/api/events/:id", async (req, res) => {
  try {
    const data = await bsdRequest(`/events/${req.params.id}/`);

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      event: data,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
    });
  }
});

/* =========================================================
   PREDICTION
========================================================= */

app.get("/api/events/:id/prediction", async (req, res) => {
  try {
    const data = await bsdRequest(
      `/events/${req.params.id}/prediction/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      prediction: data,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
});

/* =========================================================
   ODDS
========================================================= */

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const data = await bsdRequest(
      `/events/${req.params.id}/odds/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      odds: data,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
});

/* =========================================================
   GENERIC SUBRESOURCES
========================================================= */

async function proxyEventResource(req, res, resource) {
  try {
    const data = await bsdRequest(
      `/events/${req.params.id}/${resource}/`
    );

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      [resource]: data,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
}

app.get("/api/events/:id/h2h", (req, res) =>
  proxyEventResource(req, res, "h2h")
);

app.get("/api/events/:id/stats", (req, res) =>
  proxyEventResource(req, res, "stats")
);

app.get("/api/events/:id/lineups", (req, res) =>
  proxyEventResource(req, res, "lineups")
);

app.get("/api/events/:id/incidents", (req, res) =>
  proxyEventResource(req, res, "incidents")
);

app.get("/api/events/:id/polymarket", (req, res) =>
  proxyEventResource(req, res, "polymarket")
);

/* =========================================================
   NORMALIZE PREDICTION
========================================================= */

function normalizePrediction(raw) {
  const prediction = raw?.prediction || raw || {};
  const markets = prediction?.markets || {};
  const match = markets?.match_result || {};
  const goals = markets?.expected_goals || {};
  const ou = markets?.over_under || {};
  const btts = markets?.btts || {};
  const score = markets?.score || {};
  const dnb = markets?.draw_no_bet || {};

  const home = normalizeProbability(match.prob_home);
  const draw = normalizeProbability(match.prob_draw);
  const away = normalizeProbability(match.prob_away);

  return {
    home,
    draw,
    away,

    over15: normalizeProbability(ou.prob_over_15),
    over25: normalizeProbability(ou.prob_over_25),
    over35: normalizeProbability(ou.prob_over_35),

    under15:
      ou.prob_under_15 !== undefined
        ? normalizeProbability(ou.prob_under_15)
        : ou.prob_over_15 !== undefined
        ? round(100 - normalizeProbability(ou.prob_over_15), 2)
        : null,

    under25:
      ou.prob_under_25 !== undefined
        ? normalizeProbability(ou.prob_under_25)
        : ou.prob_over_25 !== undefined
        ? round(100 - normalizeProbability(ou.prob_over_25), 2)
        : null,

    under35:
      ou.prob_under_35 !== undefined
        ? normalizeProbability(ou.prob_under_35)
        : ou.prob_over_35 !== undefined
        ? round(100 - normalizeProbability(ou.prob_over_35), 2)
        : null,

    bttsYes: normalizeProbability(btts.prob_yes),

    bttsNo:
      btts.prob_no !== undefined
        ? normalizeProbability(btts.prob_no)
        : btts.prob_yes !== undefined
        ? round(100 - normalizeProbability(btts.prob_yes), 2)
        : null,

    xgHome: Number.isFinite(Number(goals.home))
      ? Number(goals.home)
      : null,

    xgAway: Number.isFinite(Number(goals.away))
      ? Number(goals.away)
      : null,

    mostLikelyScore: score.most_likely || null,

    dnbHome: normalizeProbability(dnb.prob_home),

    predicted: match.predicted || null,

    confidence: normalizeProbability(
      prediction?.model?.confidence
    ),
  };
}

/* =========================================================
   NORMALIZE ODDS
========================================================= */

function normalizeOdds(raw) {
  const oddsRoot = raw?.odds || raw || {};

  return {
    home: Number.isFinite(Number(oddsRoot.home_win))
      ? Number(oddsRoot.home_win)
      : null,

    draw: Number.isFinite(Number(oddsRoot.draw))
      ? Number(oddsRoot.draw)
      : null,

    away: Number.isFinite(Number(oddsRoot.away_win))
      ? Number(oddsRoot.away_win)
      : null,

    over15: Number.isFinite(Number(oddsRoot.over_15_goals))
      ? Number(oddsRoot.over_15_goals)
      : null,

    over25: Number.isFinite(Number(oddsRoot.over_25_goals))
      ? Number(oddsRoot.over_25_goals)
      : null,

    over35: Number.isFinite(Number(oddsRoot.over_35_goals))
      ? Number(oddsRoot.over_35_goals)
      : null,

    under15: Number.isFinite(Number(oddsRoot.under_15_goals))
      ? Number(oddsRoot.under_15_goals)
      : null,

    under25: Number.isFinite(Number(oddsRoot.under_25_goals))
      ? Number(oddsRoot.under_25_goals)
      : null,

    under35: Number.isFinite(Number(oddsRoot.under_35_goals))
      ? Number(oddsRoot.under_35_goals)
      : null,

    bttsYes: Number.isFinite(Number(oddsRoot.btts_yes))
      ? Number(oddsRoot.btts_yes)
      : null,

    bttsNo: Number.isFinite(Number(oddsRoot.btts_no))
      ? Number(oddsRoot.btts_no)
      : null,

    lastUpdateAt: raw?.last_update_at || null,
    nextUpdateAt: raw?.next_update_at || null,
    updateIntervalSeconds:
      raw?.update_interval_seconds ?? null,
    updateReason: raw?.update_reason || null,

    // BSD w tej odpowiedzi nie zwraca historii kursu
    movement: "UNAVAILABLE",
    previousOdds: null,
  };
}

/* =========================================================
   EXCHANGE STATUS
========================================================= */

function getExchangeStatus() {
  return {
    available: false,
    status: "EXCHANGE_UNAVAILABLE",
    signal: null,
    source: null,
    note:
      "Brak rzeczywistych danych giełdowych w dostarczonym źródle. Nie jest używane jako sygnał.",
  };
}

/* =========================================================
   BUILD MARKET CANDIDATES
========================================================= */

function makeCandidate({
  event,
  market,
  selection,
  probability,
  odds,
  reason,
}) {
  if (
    !Number.isFinite(probability) ||
    !Number.isFinite(odds) ||
    odds <= 1
  ) {
    return null;
  }

  const fairOdds = probabilityToFairOdds(probability);
  const value = calculateValue(probability, odds);
  const valuePct = valuePercent(probability, odds);

  // Prawdopodobieństwo rynkowe bez marży
  const implied = round(100 / odds, 2);

  let score = 0;

  // Najważniejsze: prawdopodobieństwo
  if (probability >= 75) score += 42;
  else if (probability >= 70) score += 38;
  else if (probability >= 65) score += 34;
  else if (probability >= 60) score += 29;
  else if (probability >= 55) score += 23;
  else if (probability >= 50) score += 15;
  else score += 5;

  // Value
  if (valuePct !== null) {
    if (valuePct >= 10) score += 25;
    else if (valuePct >= 7) score += 20;
    else if (valuePct >= 5) score += 15;
    else if (valuePct >= 3) score += 10;
    else if (valuePct > 0) score += 4;
    else score -= 8;
  }

  // Na razie brak ruchu kursu
  const movement = "UNAVAILABLE";

  return {
    eventId: event.id,
    event: `${event.home_team} – ${event.away_team}`,
    date: event.event_date,
    league: event.league_name || event.league || null,

    market,
    selection,

    probability: round(probability, 2),
    odds: round(odds, 2),
    impliedProbability: implied,
    fairOdds,

    value: value,
    valuePercent: valuePct,

    movement,
    movementScore: 0,

    score: Math.round(score),

    reason,
  };
}

/* =========================================================
   ANALYZE EVENT
========================================================= */

async function buildAnalysis(eventId) {
  const results = await Promise.allSettled([
    bsdRequest(`/events/${eventId}/`),
    bsdRequest(`/events/${eventId}/prediction/`),
    bsdRequest(`/events/${eventId}/odds/`),
    bsdRequest(`/events/${eventId}/h2h/`),
    bsdRequest(`/events/${eventId}/stats/`),
    bsdRequest(`/events/${eventId}/lineups/`),
    bsdRequest(`/events/${eventId}/incidents/`),
  ]);

  const [
    eventResult,
    predictionResult,
    oddsResult,
    h2hResult,
    statsResult,
    lineupsResult,
    incidentsResult,
  ] = results;

  const event =
    eventResult.status === "fulfilled"
      ? eventResult.value
      : null;

  const predictionRaw =
    predictionResult.status === "fulfilled"
      ? predictionResult.value
      : null;

  const oddsRaw =
    oddsResult.status === "fulfilled"
      ? oddsResult.value
      : null;

  const h2h =
    h2hResult.status === "fulfilled"
      ? h2hResult.value
      : null;

  const stats =
    statsResult.status === "fulfilled"
      ? statsResult.value
      : null;

  const lineups =
    lineupsResult.status === "fulfilled"
      ? lineupsResult.value
      : null;

  const incidents =
    incidentsResult.status === "fulfilled"
      ? incidentsResult.value
      : null;

  if (!event) {
    throw new Error(`Event ${eventId} not found`);
  }

  const prediction = normalizePrediction(predictionRaw);
  const odds = normalizeOdds(oddsRaw);
  const exchange = getExchangeStatus();

  const candidates = [];

  // 1X2
  candidates.push(
    makeCandidate({
      event,
      market: "1X2",
      selection: event.home_team,
      probability: prediction.home,
      odds: odds.home,
      reason: "Model probability for home win",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "1X2",
      selection: "Draw",
      probability: prediction.draw,
      odds: odds.draw,
      reason: "Model probability for draw",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "1X2",
      selection: event.away_team,
      probability: prediction.away,
      odds: odds.away,
      reason: "Model probability for away win",
    })
  );

  // Goals
  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Over 1.5",
      probability: prediction.over15,
      odds: odds.over15,
      reason: "High model probability for at least 2 goals",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Under 1.5",
      probability: prediction.under15,
      odds: odds.under15,
      reason: "Complement of BSD Over 1.5 probability",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Over 2.5",
      probability: prediction.over25,
      odds: odds.over25,
      reason: "Model probability for at least 3 goals",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Under 2.5",
      probability: prediction.under25,
      odds: odds.under25,
      reason: "Complement of BSD Over 2.5 probability",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Over 3.5",
      probability: prediction.over35,
      odds: odds.over35,
      reason: "Model probability for at least 4 goals",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "Goals",
      selection: "Under 3.5",
      probability: prediction.under35,
      odds: odds.under35,
      reason: "Complement of BSD Over 3.5 probability",
    })
  );

  // BTTS
  candidates.push(
    makeCandidate({
      event,
      market: "BTTS",
      selection: "Yes",
      probability: prediction.bttsYes,
      odds: odds.bttsYes,
      reason: "BSD BTTS Yes probability",
    })
  );

  candidates.push(
    makeCandidate({
      event,
      market: "BTTS",
      selection: "No",
      probability: prediction.bttsNo,
      odds: odds.bttsNo,
      reason: "Complement of BSD BTTS Yes probability",
    })
  );

  let picks = candidates
    .filter(Boolean)
    .filter((pick) => pick.probability >= 52)
    .filter((pick) => pick.valuePercent === null || pick.valuePercent >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.probability - a.probability;
    });

  // Nie pokazujemy więcej niż 5 typów z jednego meczu
  picks = picks.slice(0, 5);

  const matchResultSpread =
    prediction.home !== null &&
    prediction.draw !== null &&
    prediction.away !== null
      ? Math.max(
          prediction.home,
          prediction.draw,
          prediction.away
        ) -
        Math.min(
          prediction.home,
          prediction.draw,
          prediction.away
        )
      : null;

  const winnerTooClose =
    matchResultSpread !== null &&
    matchResultSpread < 15;

  const warnings = [];

  if (winnerTooClose) {
    warnings.push(
      "Model nie wskazuje wyraźnego faworyta 1X2."
    );
  }

  if (!odds.lastUpdateAt) {
    warnings.push(
      "BSD nie podało last_update_at — brak potwierdzonej historii ruchu kursu."
    );
  }

  if (!exchange.available) {
    warnings.push(
      "Brak danych giełdowych — giełda nie wpływa na scoring."
    );
  }

  return {
    ok: true,
    version: VERSION,
    source: SOURCE,

    event,

    prediction: {
      ...prediction,
      fairOdds: {
        home: probabilityToFairOdds(prediction.home),
        draw: probabilityToFairOdds(prediction.draw),
        away: probabilityToFairOdds(prediction.away),
        over15: probabilityToFairOdds(prediction.over15),
        over25: probabilityToFairOdds(prediction.over25),
        over35: probabilityToFairOdds(prediction.over35),
        bttsYes: probabilityToFairOdds(prediction.bttsYes),
      },
    },

    odds,

    exchange,

    data: {
      h2h,
      stats,
      lineups,
      incidents,
    },

    picks,

    filters: {
      winnerMarketRejected:
        winnerTooClose ||
        prediction.home === null ||
        prediction.draw === null ||
        prediction.away === null,
      minimumProbability: 52,
      requireNonNegativeValue: true,
      exchangeRequired: false,
    },

    warnings,

    generatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   ANALYZE ENDPOINT
========================================================= */

app.get("/api/analyze/:id", async (req, res) => {
  try {
    const analysis = await buildAnalysis(req.params.id);

    res.json(analysis);
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
});

/* =========================================================
   TOP PICKS
========================================================= */

app.get("/api/top-picks", async (req, res) => {
  try {
    const date = req.query.date || todayWarsaw();

    const params = new URLSearchParams();

    params.set("date_from", date);
    params.set("date_to", date);
    params.set("limit", "100");

    if (req.query.league_id) {
      params.set("league_id", req.query.league_id);
    }

    const eventsData = await bsdRequest(
      `/events/?${params.toString()}`
    );

    let events = Array.isArray(eventsData?.results)
      ? eventsData.results
      : [];

    // Bezpieczne lokalne filtrowanie daty
    events = events.filter((event) => {
      if (!event?.event_date) return false;

      return String(event.event_date).slice(0, 10) === date;
    });

    // Nie analizujemy zakończonych
    events = events.filter((event) => {
      const status = String(event.status || "").toLowerCase();

      return ![
        "finished",
        "cancelled",
        "postponed",
        "completed",
      ].includes(status);
    });

    const requestedLimit = Math.min(
      Math.max(Number(req.query.limit || 10), 1),
      10
    );

    // Ograniczamy liczbę eventów, żeby nie zrobić
    // setek zapytań do BSD.
    const maxEvents = Math.min(events.length, 25);

    const analyzed = [];

    for (const event of events.slice(0, maxEvents)) {
      try {
        const analysis = await buildAnalysis(event.id);

        for (const pick of analysis.picks || []) {
          analyzed.push({
            ...pick,
            confidence: analysis.prediction?.confidence ?? null,
            xgHome: analysis.prediction?.xgHome ?? null,
            xgAway: analysis.prediction?.xgAway ?? null,
            mostLikelyScore:
              analysis.prediction?.mostLikelyScore ?? null,
            exchange:
              analysis.exchange?.status || "EXCHANGE_UNAVAILABLE",
          });
        }
      } catch (error) {
        // Jeden uszkodzony mecz nie może zatrzymać całego TOP
        console.warn(
          `TOP PICKS event ${event.id} failed:`,
          error.message
        );
      }
    }

    const unique = [];

    const seen = new Set();

    for (const pick of analyzed.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      if (b.probability !== a.probability) {
        return b.probability - a.probability;
      }

      return (b.valuePercent || 0) - (a.valuePercent || 0);
    })) {
      const key = `${pick.eventId}-${pick.market}-${pick.selection}`;

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(pick);
    }

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      date,

      generatedAt: new Date().toISOString(),

      totalEventsFound: events.length,

      eventsAnalyzed: maxEvents,

      picks: unique.slice(0, requestedLimit),

      rules: {
        maximumPicks: 10,
        minimumProbability: 52,
        minimumValuePercent: 0,
        exchangeCanImproveScore: false,
        exchangeUnavailableDoesNotCreateSignal: true,
      },

      note:
        "TOP PICKS nie uzupełnia listy sztucznymi typami. Jeżeli mniej niż 10 zakładów spełnia filtry, zwracana jest krótsza lista.",
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
      details: error.data || null,
    });
  }
});

/* =========================================================
   SEARCH
========================================================= */

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "Missing q parameter",
      });
    }

    const date = req.query.date || todayWarsaw();

    const params = new URLSearchParams();

    params.set("date_from", date);
    params.set("date_to", date);
    params.set("limit", "100");

    const data = await bsdRequest(
      `/events/?${params.toString()}`
    );

    const search = q.toLowerCase();

    const results = (data?.results || []).filter((event) => {
      const home = String(event.home_team || "").toLowerCase();
      const away = String(event.away_team || "").toLowerCase();

      return home.includes(search) || away.includes(search);
    });

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      date,
      query: q,
      count: results.length,
      results,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      version: VERSION,
      source: SOURCE,
      error: error.message,
    });
  }
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: "Endpoint not found",
    path: req.originalUrl,
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    ok: false,
    version: VERSION,
    error: error.message || "Internal server error",
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer Live ${VERSION} running on port ${PORT}`
  );
});
