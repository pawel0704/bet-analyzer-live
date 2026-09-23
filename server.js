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

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "1.4.0"
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

/*
  Pobieramy wszystkie ligi dostępne
  w aktualnej subskrypcji Sportmonks.
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
  Pobieramy aktualne sezony.
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
  Pobieramy nadchodzące mecze
  ze wszystkich lig dostępnych
  w naszej subskrypcji.
*/
app.get("/api/scan", async (req, res) => {
  try {
    const startDate = getDate(0);
    const endDate = getDate(14);

    const data = await sportmonks(
      `/fixtures/between/${startDate}/${endDate}?include=participants;league&order=asc&per_page=50`
    );

    const now = new Date();

    const results = (data.data || [])
      .filter((fixture) => {
        if (!fixture.starting_at) {
          return false;
        }

        const start = new Date(
          fixture.starting_at.replace(" ", "T") + "Z"
        );

        return start >= now;
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

          league:
            fixture.league?.name ||
            "Nieznana liga",

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

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer API running on port ${PORT}`
  );
});
