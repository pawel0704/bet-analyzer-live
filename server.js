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
    version: "1.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend działa poprawnie",
    configured: {
      sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
      betfair: Boolean(process.env.BETFAIR_API_KEY)
    }
  });
});

app.get("/api/scan", (req, res) => {
  res.json({
    sources: ["DEMO"],
    results: [
      {
        event: "Arsenal – Brighton",
        market: "1X2: Arsenal",
        odds: 1.72,
        probability: 68.4,
        edge: 5.8,
        liquidity: 12840,
        back: 2.31,
        lay: 2.34,
        ltp: 2.33,
        ltpDelta: 0.012,
        volumeDelta: 1840,
        pressure: "BUYING"
      },
      {
        event: "Inter – Torino",
        market: "O 2.5",
        odds: 1.78,
        probability: 66.9,
        edge: 4.7,
        liquidity: 9120,
        back: 1.81,
        lay: 1.83,
        ltp: 1.82,
        ltpDelta: -0.018,
        volumeDelta: 1210,
        pressure: "BUYING"
      },
      {
        event: "Lech – Jagiellonia",
        market: "BTTS: TAK",
        odds: 1.74,
        probability: 65.7,
        edge: 4.1,
        liquidity: 6040,
        back: 1.76,
        lay: 1.79,
        ltp: 1.78,
        ltpDelta: -0.011,
        volumeDelta: 980,
        pressure: "BUYING"
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Bet Analyzer API running on port ${PORT}`);
});
