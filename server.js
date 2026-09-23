import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
  ============================
  DATA
  ============================
*/

function getDate(offsetDays = 0) {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() + offsetDays);

  return date.toISOString().slice(0, 10);
}

/*
  ============================
  API-FOOTBALL
  ============================
*/

async function apiFootball(path) {
  const key = process.env.API_FOOTBALL_KEY;

  if (!key) {
    throw new Error("Brak API_FOOTBALL_KEY w Render");
  }

  const response = await fetch(
    `https://v3.football.api-sports.io${path}`,
    {
      headers: {
        "x-apisports-key": key
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.message || `API-Football HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/*
  ============================
  SPORTMONKS
  ============================
*/

async function sportmonks(path) {
  const token = process.env.SPORTMONKS_API_KEY;

  if (!token) {
    throw new Error("Brak SPORTMONKS_API_KEY w Render");
  }

  const separator = path.includes("?") ? "&" : "?";

  const response = await fetch(
    `https://api.sportmonks.com/v3/football${path}${separator}api_token=${token}`
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.message || `Sportmonks HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/*
  ============================
  GŁÓWNY
  ============================
*/

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "2.1.0"
  });
});

/*
  ============================
  HEALTH
  ============================
*/

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",

    configured: {
      sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
      apiFootball: Boolean(process.env.API_FOOTBALL_KEY),
      betfair: Boolean(process.env.BETFAIR_API_KEY)
    }
  });
});

/*
  ============================
  API-FOOTBALL TEST
  ============================
*/

app.get("/api/api-football-test", async (req, res) => {
  try {
    const today = getDate(0);

    const data = await apiFootball(
      `/fixtures?date=${today}`
    );

    res.json({
      source: "API-FOOTBALL",

      date: today,

      count: (data.response || []).length,

      results: data.response || [],

      errors: data.errors || {},

      paging: data.paging || null
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd API-Football",
      message: error.message,
      details: error.data || null
    });
  }
});

/*
  ============================
  GŁÓWNY SCAN
  ============================
*/

app.get("/api/scan", async (req, res) => {
  try {
    const today = getDate(0);
    const tomorrow = getDate(1);

    const todayData = await apiFootball(
      `/fixtures?date=${today}`
    );

    const tomorrowData = await apiFootball(
      `/fixtures?date=${tomorrow}`
    );

    const fixtures = [
      ...(todayData.response || []),
      ...(tomorrowData.response || [])
    ];

    const results = fixtures.map((fixture) => ({
      event:
        `${fixture.teams?.home?.name || "?"} – ` +
        `${fixture.teams?.away?.name || "?"}`,

      league:
        fixture.league?.name || "Nieznana liga",

      country:
        fixture.league?.country || null,

      fixtureId:
        fixture.fixture?.id || null,

      start:
        fixture.fixture?.date || null,

      status:
        fixture.fixture?.status?.short || null,

      market: "Mecz",

      odds: null,

      probability: null,

      edge: null,

      liquidity: null,

      back: null,

      lay: null,

      ltp: null,

      ltpDelta: null,

      volumeDelta: null,

      pressure: "WAITING"
    }));

    res.json({
      sources: ["API-FOOTBALL"],

      period: {
        start: today,
        end: tomorrow
      },

      count: results.length,

      results
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd skanera",

      message: error.message,

      details: error.data || null
    });
  }
});

/*
  ============================
  SPORTMONKS - LIGI
  ============================
*/

app.get("/api/leagues", async (req, res) => {
  try {
    const data = await sportmonks(
      "/leagues?per_page=50"
    );

    const leagues = (data.data || []).map((league) => ({
      id: league.id,

      name: league.name,

      countryId: league.country_id,

      active: league.active
    }));

    res.json({
      count: leagues.length,

      leagues
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd Sportmonks",

      message: error.message,

      details: error.data || null
    });
  }
});

/*
  ============================
  SPORTMONKS - SEZONY
  ============================
*/

app.get("/api/seasons", async (req, res) => {
  try {
    const data = await sportmonks(
      "/seasons?per_page=50"
    );

    const seasons = (data.data || []).map((season) => ({
      id: season.id,

      name: season.name,

      leagueId: season.league_id,

      isCurrent: season.is_current
    }));

    res.json({
      count: seasons.length,

      seasons
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd Sportmonks",

      message: error.message,

      details: error.data || null
    });
  }
});

/*
  ============================
  START
  ============================
*/

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer API running on port ${PORT}`
  );
});
