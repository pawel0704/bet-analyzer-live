import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BSD_BASE_URL = "https://sports.bzzoiro.com/api/v2";

function getDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function bsd(path) {
  const key = process.env.BSD_API_KEY;

  if (!key) {
    throw new Error("Brak BSD_API_KEY w Render");
  }

  const response = await fetch(`${BSD_BASE_URL}${path}`, {
    headers: {
      Authorization: `Token ${key}`,
      Accept: "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.detail ||
      data?.message ||
      `BSD HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

function firstArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function teamName(team) {
  if (!team) return "?";

  return (
    team.name ||
    team.team_name ||
    team.short_name ||
    "?"
  );
}

function mapFixture(fixture) {
  const home =
    fixture.home_team ||
    fixture.home ||
    fixture.teams?.home ||
    {};

  const away =
    fixture.away_team ||
    fixture.away ||
    fixture.teams?.away ||
    {};

  return {
    event:
      `${teamName(home)} – ${teamName(away)}`,

    league:
      fixture.league?.name ||
      fixture.competition?.name ||
      fixture.league_name ||
      "Nieznana liga",

    country:
      fixture.league?.country ||
      fixture.country ||
      null,

    fixtureId:
      fixture.id ||
      fixture.event_id ||
      fixture.fixture_id ||
      null,

    start:
      fixture.start_time ||
      fixture.kickoff ||
      fixture.date ||
      fixture.event_date ||
      null,

    status:
      fixture.status ||
      fixture.match_status ||
      null,

    homeTeamId:
      home.id ||
      home.team_id ||
      null,

    awayTeamId:
      away.id ||
      away.team_id ||
      null,

    homeScore:
      fixture.home_score ??
      fixture.score?.home ??
      null,

    awayScore:
      fixture.away_score ??
      fixture.score?.away ??
      null,

    market: "1X2",

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

    source: "BSD"
  };
}

async function getOdds(eventId) {
  if (!eventId) return null;

  try {
    return await bsd(`/events/${eventId}/odds/`);
  } catch (error) {
    console.log(
      `Nie udało się pobrać kursów dla ${eventId}:`,
      error.message
    );

    return null;
  }
}

function applyOdds(item, oddsData) {
  if (!oddsData) return item;

  const odds = oddsData.odds || {};

  return {
    ...item,

    odds: {
      home: odds.home_win ?? null,
      draw: odds.draw ?? null,
      away: odds.away_win ?? null,

      over15: odds.over_15_goals ?? null,
      over25: odds.over_25_goals ?? null,
      over35: odds.over_35_goals ?? null,

      under15: odds.under_15_goals ?? null,
      under25: odds.under_25_goals ?? null,
      under35: odds.under_35_goals ?? null,

      bttsYes: odds.btts_yes ?? null,
      bttsNo: odds.btts_no ?? null
    },

    oddsUpdatedAt:
      oddsData.last_update_at ||
      null,

    oddsNextUpdateAt:
      oddsData.next_update_at ||
      null
  };
}

async function getEventExtras(eventId) {
  if (!eventId) {
    return {
      stats: null,
      lineups: null,
      h2h: null,
      prediction: null,
      odds: null
    };
  }

  const result = {
    stats: null,
    lineups: null,
    h2h: null,
    prediction: null,
    odds: null
  };

  const endpoints = [
    ["stats", `/events/${eventId}/stats/`],
    ["lineups", `/events/${eventId}/lineups/`],
    ["h2h", `/events/${eventId}/h2h/`],
    ["prediction", `/events/${eventId}/prediction/`],
    ["odds", `/events/${eventId}/odds/`]
  ];

  for (const [key, path] of endpoints) {
    try {
      result[key] = await bsd(path);
    } catch (error) {
      console.log(
        `BSD ${key} ${eventId}:`,
        error.message
      );
    }
  }

  return result;
}

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "3.0.0",
    source: "BSD"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",

    configured: {
      bsd: Boolean(process.env.BSD_API_KEY),
      sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
      apiFootball: Boolean(process.env.API_FOOTBALL_KEY),
      betfair: Boolean(process.env.BETFAIR_API_KEY)
    }
  });
});

app.get("/api/bsd-test", async (req, res) => {
  try {
    const today = getDate(0);
    const tomorrow = getDate(1);

    const data = await bsd(
      `/events/?date_from=${today}&date_to=${tomorrow}&limit=50`
    );

    const fixtures = firstArray(data);

    res.json({
      source: "BSD",
      dateFrom: today,
      dateTo: tomorrow,
      count: fixtures.length,
      results: fixtures
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd BSD",
      message: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/live", async (req, res) => {
  try {
    const data = await bsd("/events/live/");

    res.json({
      source: "BSD",
      count: firstArray(data).length,
      results: firstArray(data)
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd BSD LIVE",
      message: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const today = getDate(0);
    const tomorrow = getDate(1);

    const data = await bsd(
      `/events/?date_from=${today}&date_to=${tomorrow}&status=upcoming&limit=200`
    );

    const fixtures = firstArray(data);

    const results = [];

    for (const fixture of fixtures) {
      const item = mapFixture(fixture);

      const oddsData = await getOdds(item.fixtureId);

      results.push(
        applyOdds(item, oddsData)
      );
    }

    res.json({
      source: "BSD",
      period: {
        start: today,
        end: tomorrow
      },

      count: results.length,

      results
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd skanera BSD",
      message: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/match/:id", async (req, res) => {
  try {
    const eventId = req.params.id;

    const data = await bsd(
      `/events/${eventId}/`
    );

    const extras =
      await getEventExtras(eventId);

    res.json({
      source: "BSD",
      event: data,
      stats: extras.stats,
      lineups: extras.lineups,
      h2h: extras.h2h,
      prediction: extras.prediction,
      odds: extras.odds
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd meczu BSD",
      message: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/odds", async (req, res) => {
  try {
    const params = new URLSearchParams();

    if (req.query.event_id) {
      params.set(
        "event_id",
        req.query.event_id
      );
    }

    if (req.query.market) {
      params.set(
        "market",
        req.query.market
      );
    }

    if (req.query.movement) {
      params.set(
        "movement",
        req.query.movement
      );
    }

    params.set("limit", "200");

    const data = await bsd(
      `/odds/?${params.toString()}`
    );

    res.json({
      source: "BSD",
      count: firstArray(data).length,
      results: firstArray(data)
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: "Błąd kursów BSD",
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
