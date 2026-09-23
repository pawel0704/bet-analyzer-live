import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

function getDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

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

// =========================
// HOME
// =========================

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "1.3.0"
  });
});

// =========================
// HEALTH
// =========================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    configured: {
      sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
      betfair: Boolean(process.env.BETFAIR_API_KEY)
    }
  });
});

// =========================
// DIAGNOSTYKA — LIGI
// =========================

app.get("/api/leagues", async (req, res) => {
  try {
    const data = await sportmonks(
      "/leagues?include=currentSeason&per_page=50"
    );

    const leagues = (data.data || []).map((league) => ({
      id: league.id,
      name: league.name,
      countryId: league.country_id,
      active: league.active,
      currentSeason: league.currentSeason
        ? {
            id: league.currentSeason.id,
            name: league.currentSeason.name
          }
        : null
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

// =========================
// DIAGNOSTYKA — DZISIAJ
// =========================

app.get("/api/today", async (req, res) => {
  try {
    const date = getDate(0);

    const data = await sportmonks(
      `/leagues/date/${date}?include=currentSeason`
    );

    res.json({
      date,
      count: (data.data || []).length,
      leagues: data.data || [],
      pagination: data.pagination || null,
      rate_limit: data.rate_limit || null
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd Sportmonks",
      message: error.message,
      details: error.data || null
    });
  }
});

// =========================
// DIAGNOSTYKA — JUTRO
// =========================

app.get("/api/tomorrow", async (req, res) => {
  try {
    const date = getDate(1);

    const data = await sportmonks(
      `/leagues/date/${date}?include=currentSeason`
    );

    res.json({
      date,
      count: (data.data || []).length,
      leagues: data.data || [],
      pagination: data.pagination || null,
      rate_limit: data.rate_limit || null
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd Sportmonks",
      message: error.message,
      details: error.data || null
    });
  }
});

// =========================
// SPORTMONKS — FIXTURES
// =========================

app.get("/api/sportmonks", async (req, res) => {
  try {
    const startDate = getDate(0);
    const endDate = getDate(7);

    const data = await sportmonks(
      `/fixtures/between/${startDate}/${endDate}?include=participants&order=asc&per_page=50`
    );

    res.json({
      period: {
        start: startDate,
        end: endDate
      },
      count: (data.data || []).length,
      data: data.data || [],
      pagination: data.pagination || null,
      rate_limit: data.rate_limit || null
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd Sportmonks",
      message: error.message,
      details: error.data || null
    });
  }
});

// =========================
// SCAN
// =========================

app.get("/api/scan", async (req, res) => {
  try {
    const startDate = getDate(0);
    const endDate = getDate(7);

    const data = await sportmonks(
      `/fixtures/between/${startDate}/${endDate}?include=participants&order=asc&per_page=50`
    );

    const results = (data.data || [])
      .filter((fixture) => {
        return (
          fixture.starting_at &&
          new Date(fixture.starting_at.replace(" ", "T") + "Z") >= new Date()
        );
      })
      .map((fixture) => {
        const participants = fixture.participants || [];

        const home =
          participants.find(
            (team) => team.meta?.location === "home"
          )?.name || null;

        const away =
          participants.find(
            (team) => team.meta?.location === "away"
          )?.name || null;

        return {
          event:
            home && away
              ? `${home} – ${away}`
              : fixture.name || "Nieznany mecz",

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

          pressure: "WAITING",

          fixtureId: fixture.id,
          start: fixture.starting_at,

          leagueId: fixture.league_id,
          seasonId: fixture.season_id,

          hasOdds: Boolean(fixture.has_odds)
        };
      });

    res.json({
      sources: ["SPORTMONKS"],

      period: {
        start: startDate,
        end: endDate
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

// =========================
// START
// =========================

app.listen(PORT, () => {
  console.log(`Bet Analyzer API running on port ${PORT}`);
});
