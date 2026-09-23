import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "1.1.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    configured: {
      sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
      betfair: Boolean(process.env.BETFAIR_API_KEY)
    }
  });
});

app.get("/api/sportmonks", async (req, res) => {
  try {
    const token = process.env.SPORTMONKS_API_KEY;

    if (!token) {
      return res.status(500).json({
        error: "Brak SPORTMONKS_API_KEY w Render"
      });
    }

    const response = await fetch(
      `https://api.sportmonks.com/v3/football/fixtures?api_token=${token}&include=participants`
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Błąd połączenia ze Sportmonks",
      message: error.message
    });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const token = process.env.SPORTMONKS_API_KEY;

    if (!token) {
      return res.status(500).json({
        error: "Brak SPORTMONKS_API_KEY"
      });
    }

    const response = await fetch(
      `https://api.sportmonks.com/v3/football/fixtures?api_token=${token}&include=participants`
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const results = (data.data || []).map((fixture) => ({
      event: fixture.name || "Nieznany mecz",
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
      start: fixture.starting_at
    }));

    res.json({
      sources: ["SPORTMONKS"],
      results
    });
  } catch (error) {
    res.status(500).json({
      error: "Błąd skanera",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Bet Analyzer API running on port ${PORT}`);
});
