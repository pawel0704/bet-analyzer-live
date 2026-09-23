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
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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

function arr(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function pct(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function impliedProbability(odds) {
  if (!odds || odds <= 1) return null;
  return 1 / odds;
}

function edgePercent(probability, odds) {
  const implied = impliedProbability(odds);

  if (probability === null || implied === null) {
    return null;
  }

  return Number(((probability - implied) * 100).toFixed(2));
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

function mapEvent(event) {
  const home = {
    id: event.home_team_id,
    name: event.home_team
  };

  const away = {
    id: event.away_team_id,
    name: event.away_team
  };

  return {
    id: event.id,

    event:
      `${teamName(home)} – ${teamName(away)}`,

    home,
    away,

    league: {
      id: event.league_id,
      name: event.league_name || null
    },

    seasonId: event.season_id,

    start:
      event.event_date ||
      null,

    status:
      event.status ||
      null,

    refereeId:
      event.referee_id ||
      null,

    venueId:
      event.venue_id ||
      null,

    weather:
      event.weather ||
      null,

    h2h:
      event.head_to_head ||
      null,

    hasXg:
      Boolean(event.has_xg)
  };
}

async function getEventDetails(eventId) {
  const result = {
    event: null,
    stats: null,
    lineups: null,
    h2h: null,
    prediction: null,
    odds: null
  };

  const requests = [
    ["event", `/events/${eventId}/`],
    ["stats", `/events/${eventId}/stats/`],
    ["lineups", `/events/${eventId}/lineups/`],
    ["h2h", `/events/${eventId}/h2h/`],
    ["prediction", `/events/${eventId}/prediction/`],
    ["odds", `/events/${eventId}/odds/`]
  ];

  const values = await Promise.all(
    requests.map(async ([name, path]) => {
      try {
        return [name, await bsd(path)];
      } catch (error) {
        console.log(
          `BSD ${name} ${eventId}:`,
          error.message
        );

        return [name, null];
      }
    })
  );

  for (const [name, value] of values) {
    result[name] = value;
  }

  return result;
}

function extractPrediction(details) {
  const p = details?.prediction;

  if (!p) return null;

  const markets = p.markets || {};

  return {
    home:
      pct(markets.match_result?.prob_home),

    draw:
      pct(markets.match_result?.prob_draw),

    away:
      pct(markets.match_result?.prob_away),

    predicted:
      markets.match_result?.predicted ||
      null,

    expectedGoalsHome:
      markets.expected_goals?.home ??
      null,

    expectedGoalsAway:
      markets.expected_goals?.away ??
      null,

    over15:
      pct(markets.over_under?.prob_over_15),

    over25:
      pct(markets.over_under?.prob_over_25),

    over35:
      pct(markets.over_under?.prob_over_35),

    bttsYes:
      pct(markets.btts?.prob_yes),

    mostLikelyScore:
      markets.score?.most_likely ||
      null,

    drawNoBetHome:
      pct(markets.draw_no_bet?.prob_home),

    modelConfidence:
      p.model?.confidence != null
        ? Number((p.model.confidence * 100).toFixed(1))
        : null,

    recommendations:
      p.recommendations ||
      null,

    createdAt:
      p.created_at ||
      null
  };
}

function extractLineups(details) {
  const data = details?.lineups;

  if (!data) return null;

  const home =
    data.lineups?.home ||
    {};

  const away =
    data.lineups?.away ||
    {};

  return {
    status:
      data.lineup_status ||
      null,

    updatedAt:
      data.updated_at ||
      null,

    home: {
      formation:
        home.formation ||
        null,

      confidence:
        home.confidence ??
        null,

      players:
        home.players ||
        [],

      unavailable:
        data.unavailable_players?.home ||
        []
    },

    away: {
      formation:
        away.formation ||
        null,

      confidence:
        away.confidence ??
        null,

      players:
        away.players ||
        [],

      unavailable:
        data.unavailable_players?.away ||
        []
    }
  };
}

function extractOdds(details) {
  const data = details?.odds;

  if (!data) return null;

  const odds = data.odds || {};

  return {
    homeWin:
      odds.home_win ?? null,

    draw:
      odds.draw ?? null,

    awayWin:
      odds.away_win ?? null,

    over15:
      odds.over_15_goals ?? null,

    over25:
      odds.over_25_goals ?? null,

    over35:
      odds.over_35_goals ?? null,

    under15:
      odds.under_15_goals ?? null,

    under25:
      odds.under_25_goals ?? null,

    under35:
      odds.under_35_goals ?? null,

    bttsYes:
      odds.btts_yes ?? null,

    bttsNo:
      odds.btts_no ?? null,

    updatedAt:
      data.last_update_at ||
      null,

    nextUpdateAt:
      data.next_update_at ||
      null
  };
}

function unavailablePenalty(lineups) {
  if (!lineups) return 0;

  const home =
    lineups.home?.unavailable?.length || 0;

  const away =
    lineups.away?.unavailable?.length || 0;

  return Math.min(12, (home + away) * 1.5);
}

function lineupConfidence(lineups) {
  if (!lineups) return 0;

  const home =
    Number(lineups.home?.confidence || 0);

  const away =
    Number(lineups.away?.confidence || 0);

  if (!home && !away) return 0;

  return clamp(
    ((home + away) / 2) * 100
  );
}

function calculateCandidate(
  prediction,
  odds,
  market
) {
  if (!prediction || !odds) {
    return null;
  }

  let probability = null;
  let price = null;
  let label = "";

  if (market === "HOME") {
    probability = prediction.home;
    price = odds.homeWin;
    label = "1";
  }

  if (market === "DRAW") {
    probability = prediction.draw;
    price = odds.draw;
    label = "X";
  }

  if (market === "AWAY") {
    probability = prediction.away;
    price = odds.awayWin;
    label = "2";
  }

  if (market === "OVER25") {
    probability = prediction.over25;
    price = odds.over25;
    label = "Over 2.5";
  }

  if (market === "OVER15") {
    probability = prediction.over15;
    price = odds.over15;
    label = "Over 1.5";
  }

  if (market === "BTTS_YES") {
    probability = prediction.bttsYes;
    price = odds.bttsYes;
    label = "BTTS – TAK";
  }

  if (probability == null || !price) {
    return null;
  }

  const implied = impliedProbability(price);

  const edge =
    edgePercent(
      probability / 100,
      price
    );

  return {
    market: label,
    probability,
    odds: price,
    impliedProbability:
      Number((implied * 100).toFixed(1)),
    edge
  };
}

function calculateScore({
  candidate,
  prediction,
  lineups,
  h2h,
  event
}) {
  if (!candidate) return 0;

  let score = 50;

  const edge = candidate.edge || 0;

  if (edge >= 15) score += 20;
  else if (edge >= 10) score += 14;
  else if (edge >= 6) score += 8;
  else if (edge >= 3) score += 3;
  else if (edge < 0) score -= 15;

  if (
    prediction?.modelConfidence != null
  ) {
    if (prediction.modelConfidence >= 70) {
      score += 8;
    } else if (
      prediction.modelConfidence >= 55
    ) {
      score += 4;
    }
  }

  if (lineups) {
    score +=
      lineupConfidence(lineups) * 0.08;

    score -=
      unavailablePenalty(lineups);
  }

  if (h2h) {
    const matches =
      h2h.total_matches || 0;

    if (matches >= 5) {
      score += 3;
    }
  }

  if (event?.weather?.code === 3) {
    score -= 1;
  }

  return Number(
    clamp(score).toFixed(1)
  );
}

function classify(score, candidate) {
  if (!candidate) return "SKIP";

  if (
    score >= 75 &&
    candidate.edge >= 6 &&
    candidate.probability >= 60
  ) {
    return "TOP";
  }

  if (
    score >= 62 &&
    candidate.edge >= 2
  ) {
    return "WATCH";
  }

  return "SKIP";
}

function analyzeEvent(event, details) {
  const prediction =
    extractPrediction(details);

  const odds =
    extractOdds(details);

  const lineups =
    extractLineups(details);

  const h2h =
    details.h2h ||
    event.h2h ||
    null;

  const markets = [
    "HOME",
    "DRAW",
    "AWAY",
    "OVER15",
    "OVER25",
    "BTTS_YES"
  ];

  const candidates = [];

  for (const market of markets) {
    const candidate =
      calculateCandidate(
        prediction,
        odds,
        market
      );

    if (!candidate) continue;

    const score =
      calculateScore({
        candidate,
        prediction,
        lineups,
        h2h,
        event
      });

    candidates.push({
      ...candidate,
      score,
      classification:
        classify(score, candidate)
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  const best =
    candidates[0] ||
    null;

  return {
    eventId: event.id,

    event: event.event,

    league: event.league,

    start: event.start,

    status: event.status,

    refereeId: event.refereeId,

    weather: event.weather,

    prediction,

    odds,

    lineups,

    h2h,

    candidates,

    bestPick: best,

    score:
      best?.score ??
      0,

    classification:
      best?.classification ||
      "SKIP"
  };
}

app.get("/", (req, res) => {
  res.json({
    name: "Bet Analyzer Live API",
    status: "online",
    version: "4.0.0",
    source: "BSD"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",

    configured: {
      bsd:
        Boolean(
          process.env.BSD_API_KEY
        ),

      sportmonks:
        Boolean(
          process.env.SPORTMONKS_API_KEY
        ),

      apiFootball:
        Boolean(
          process.env.API_FOOTBALL_KEY
        ),

      betfair:
        Boolean(
          process.env.BETFAIR_API_KEY
        )
    }
  });
});

app.get("/api/scan", async (req, res) => {
  try {
    const today = getDate(0);
    const tomorrow = getDate(1);

    const data =
      await bsd(
        `/events/?date_from=${today}&date_to=${tomorrow}&status=upcoming&limit=100`
      );

    const events =
      arr(data)
        .filter(
          e =>
            e.status ===
            "notstarted"
        )
        .map(mapEvent);

    const analyses = [];

    for (const event of events) {
      try {
        const details =
          await getEventDetails(
            event.id
          );

        const analysis =
          analyzeEvent(
            event,
            details
          );

        analyses.push(
          analysis
        );

      } catch (error) {
        console.log(
          `Analiza ${event.id}:`,
          error.message
        );
      }
    }

    analyses.sort(
      (a, b) =>
        b.score - a.score
    );

    res.json({
      source: "BSD",

      period: {
        start: today,
        end: tomorrow
      },

      totalEvents:
        events.length,

      analyzed:
        analyses.length,

      top:
        analyses
          .filter(
            x =>
              x.classification ===
              "TOP"
          )
          .slice(0, 10),

      watch:
        analyses
          .filter(
            x =>
              x.classification ===
              "WATCH"
          )
          .slice(0, 20),

      all:
        analyses
    });

  } catch (error) {
    res.status(
      error.status || 500
    ).json({
      error:
        "Błąd analizatora BSD",

      message:
        error.message,

      details:
        error.data || null
    });
  }
});

app.get(
  "/api/match/:id",
  async (req, res) => {
    try {
      const eventId =
        req.params.id;

      const event =
        await bsd(
          `/events/${eventId}/`
        );

      const details =
        await getEventDetails(
          eventId
        );

      const analysis =
        analyzeEvent(
          mapEvent(event),
          details
        );

      res.json({
        source: "BSD",
        analysis
      });

    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        error:
          "Błąd analizy meczu",

        message:
          error.message,

        details:
          error.data || null
      });
    }
  }
);

app.get(
  "/api/bsd-test",
  async (req, res) => {
    try {
      const today = getDate(0);
      const tomorrow = getDate(1);

      const data =
        await bsd(
          `/events/?date_from=${today}&date_to=${tomorrow}&limit=50`
        );

      res.json({
        source: "BSD",

        dateFrom: today,
        dateTo: tomorrow,

        count:
          arr(data).length,

        results:
          arr(data)
      });

    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        error: "Błąd BSD",

        message:
          error.message,

        details:
          error.data || null
      });
    }
  }
);

app.get(
  "/api/live",
  async (req, res) => {
    try {
      const data =
        await bsd(
          "/events/live/"
        );

      res.json({
        source: "BSD",

        count:
          arr(data).length,

        results:
          arr(data)
      });

    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        error:
          "Błąd BSD LIVE",

        message:
          error.message,

        details:
          error.data || null
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer API running on port ${PORT}`
    );
  }
);
