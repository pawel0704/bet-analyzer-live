import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =========================
// BASIC
// =========================

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "1.2.0"
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
// SPORTMONKS RAW
// =========================

app.get("/api/sportmonks", async (req, res) => {
  try {
    const token = process.env.SPORTMONKS_API_KEY;

    if (!token) {
      return res.status(500).json({
        error: "Brak SPORTMONKS_API_KEY w Render"
      });
    }

    const today = new Date();

    const startDate = today.toISOString().slice(0, 10);

    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + 7);

    const endDate = futureDate.toISOString().slice(0, 10);

    const url =
      `https://api.sportmonks.com/v3/football/fixtures/between/` +
      `${startDate}/${endDate}` +
      `?api_token=${token}` +
      `&include=participants` +
      `&order=asc` +
      `&per_page=50`;

    const response = await fetch(url);

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      period: {
        start: startDate,
        end: endDate
      },
      data: data.data || [],
      pagination: data.pagination || null,
      rate_limit: data.rate_limit || null
    });

  } catch (error) {
    res.status(500).json({
      error: "Błąd połączenia ze Sportmonks",
      message: error.message
    });
  }
});

// =========================
// SCAN
// =========================

app.get("/api/scan", async (req, res) => {
  try {
    const token = process.env.SPORTMONKS_API_KEY;

    if (!token) {
      return res.status(500).json({
        error: "Brak SPORTMONKS_API_KEY"
      });
    }

    const today = new Date();

    const startDate = today.toISOString().slice(0, 10);

    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + 7);

    const endDate = futureDate.toISOString().slice(0, 10);

    const url =
      `https://api.sportmonks.com/v3/football/fixtures/between/` +
      `${startDate}/${endDate}` +
      `?api_token=${token}` +
      `&include=participants` +
      `&order=asc` +
      `&per_page=50`;

    const response = await fetch(url);

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const results = (data.data || [])
      .filter((fixture) => {
        return fixture.starting_at;
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
    res.status(500).json({
      error: "Błąd skanera",
      message: error.message
    });
  }
});

// =========================
// START
// =========================

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer API running on port ${PORT}`
  );
});
