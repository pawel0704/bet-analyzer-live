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

function impliedProbability(odds) {
  if (!odds || odds <= 1) return null;
  return 1 / odds;
}

function edgePercent(probability, odds) {
  const implied = impliedProbability(odds);

  if (probability == null || implied == null) {
    return null;
  }

  return Number(
    ((probability - implied) * 100).toFixed(2)
  );
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
      markets.match_result?.prob_home ?? null,

    draw:
      markets.match_result?.prob_draw ?? null,

    away:
      markets.match_result?.prob_away ?? null,

    predicted:
      markets.match_result?.predicted || null,

    expectedGoalsHome:
      markets.expected_goals?.home ?? null,

    expectedGoalsAway:
      markets.expected_goals?.away ?? null,

    over15:
      markets.over_under?.prob_over_15 ?? null,

    over25:
      markets.over_under?.prob_over_25 ?? null,

    over35:
      markets.over_under?.prob_over_35 ?? null,

    bttsYes:
      markets.btts?.prob_yes ?? null,

    mostLikelyScore:
      markets.score?.most_likely || null,

    drawNoBetHome:
      markets.draw_no_bet?.prob_home ?? null,

    modelConfidence:
      p.model?.confidence != null
        ? Number(
            (p.model.confidence * 100).toFixed(1)
          )
        : null,

    recommendations:
      p.recommendations || null,

    createdAt:
      p.created_at || null
  };
}

function extractLineups(details) {
  const data = details?.lineups;

  if (!data) return null;

  const home =
    data.lineups?.home || {};

  const away =
    data.lineups?.away || {};

  return {
    status:
      data.lineup_status || null,

    updatedAt:
      data.updated_at || null,

    home: {
      formation:
        home.formation || null,

      confidence:
        Number(home.confidence || 0),

      players:
        home.players || [],

      unavailable:
        data.unavailable_players?.home ||
        []
    },

    away: {
      formation:
        away.formation || null,

      confidence:
        Number(away.confidence || 0),

      players:
        away.players || [],

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
      data.last_update_at || null,

    nextUpdateAt:
      data.next_update_at || null
  };
}

function unavailableCount(lineups) {
  if (!lineups) return 0;

  return (
    (lineups.home?.unavailable?.length || 0) +
    (lineups.away?.unavailable?.length || 0)
  );
}

function lineupConfidence(lineups) {
  if (!lineups) return 0;

  const home =
    Number(lineups.home?.confidence || 0);

  const away =
    Number(lineups.away?.confidence || 0);

  if (!home && !away) return 0;

  return (
    ((home + away) / 2) * 100
  );
}

function h2hStrength(h2h, market) {
  if (!h2h) return 0;

  const matches =
    Number(h2h.total_matches || 0);

  if (matches < 3) return 0;

  if (market === "HOME") {
    return Number(
      h2h.home_win_rate || 0
    ) * 100;
  }

  if (market === "AWAY") {
    return Number(
      h2h.away_win_rate || 0
    ) * 100;
  }

  if (
    market === "OVER15" ||
    market === "OVER25"
  ) {
    const avg =
      Number(
        h2h.avg_total_goals || 0
      );

    if (market === "OVER25") {
      if (avg >= 3.2) return 100;
      if (avg >= 2.8) return 75;
      if (avg >= 2.5) return 50;
      return 25;
    }

    if (avg >= 2.5) return 100;
    if (avg >= 2.1) return 75;
    if (avg >= 1.8) return 50;

    return 25;
  }

  return 0;
}

function candidateProbability(
  prediction,
  market
) {
  if (!prediction) return null;

  switch (market) {
    case "HOME":
      return prediction.home;

    case "DRAW":
      return prediction.draw;

    case "AWAY":
      return prediction.away;

    case "OVER15":
      return prediction.over15;

    case "OVER25":
      return prediction.over25;

    case "BTTS":
      return prediction.bttsYes;

    default:
      return null;
  }
}

function candidateOdds(
  odds,
  market
) {
  if (!odds) return null;

  switch (market) {
    case "HOME":
      return odds.homeWin;

    case "DRAW":
      return odds.draw;

    case "AWAY":
      return odds.awayWin;

    case "OVER15":
      return odds.over15;

    case "OVER25":
      return odds.over25;

    case "BTTS":
      return odds.bttsYes;

    default:
      return null;
  }
}

function marketLabel(market) {
  switch (market) {
    case "HOME":
      return "1";

    case "DRAW":
      return "X";

    case "AWAY":
      return "2";

    case "OVER15":
      return "Over 1.5";

    case "OVER25":
      return "Over 2.5";

    case "BTTS":
      return "BTTS – TAK";

    default:
      return market;
  }
}

function buildCandidate(
  prediction,
  odds,
  market
) {
  const probability =
    candidateProbability(
      prediction,
      market
    );

  const price =
    candidateOdds(
      odds,
      market
    );

  if (
    probability == null ||
    !price ||
    price <= 1
  ) {
    return null;
  }

  const implied =
    impliedProbability(price);

  const edge =
    edgePercent(
      probability / 100,
      price
    );

  return {
    market,
    selection:
      marketLabel(market),

    probability:
      Number(
        probability.toFixed(1)
      ),

    odds:
      Number(
        price.toFixed(2)
      ),

    impliedProbability:
      Number(
        (implied * 100).toFixed(1)
      ),

    edge,

    modelAgreement:
      false,

    exchangeConfirmation:
      "NOT_CONNECTED"
  };
}

function recommendationAgreement(
  prediction,
  market
) {
  const r =
    prediction?.recommendations;

  if (!r) return false;

  if (market === "HOME") {
    return (
      r.favorite === "H" &&
      r.bet_favorite === true
    );
  }

  if (market === "AWAY") {
    return (
      r.favorite === "A" &&
      r.bet_favorite === true
    );
  }

  if (market === "OVER15") {
    return r.over_15 === true;
  }

  if (market === "OVER25") {
    return r.over_25 === true;
  }

  if (market === "BTTS") {
    return r.btts === true;
  }

  return false;
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

  const p =
    candidate.probability;

  const edge =
    candidate.edge || 0;

  /*
   * 1. REALISTIC PROBABILITY
   */

  if (p >= 75) score += 12;
  else if (p >= 65) score += 8;
  else if (p >= 60) score += 5;
  else if (p < 50) score -= 12;

  /*
   * 2. EDGE
   *
   * Ograniczamy wpływ edge,
   * żeby model nie produkował
   * absurdalnych typów.
   */

  if (edge >= 15) score += 5;
  else if (edge >= 10) score += 4;
  else if (edge >= 6) score += 3;
  else if (edge >= 3) score += 1;
  else if (edge < 0) score -= 12;

  /*
   * 3. MODEL CONFIDENCE
   */

  const confidence =
    prediction?.modelConfidence || 0;

  if (confidence >= 70) score += 8;
  else if (confidence >= 60) score += 5;
  else if (confidence >= 55) score += 2;
  else if (confidence < 45) score -= 8;

  /*
   * 4. AGREEMENT Z REKOMENDACJĄ BSD
   */

  if (
    candidate.modelAgreement
  ) {
    score += 7;
  }

  /*
   * 5. SKŁADY
   */

  const lineupConf =
    lineupConfidence(lineups);

  if (lineupConf >= 70) score += 5;
  else if (lineupConf >= 60) score += 3;
  else if (lineupConf >= 50) score += 1;
  else if (
    lineups &&
    lineupConf < 45
  ) {
    score -= 5;
  }

  /*
   * 6. ABSENCJE
   */

  const missing =
    unavailableCount(lineups);

  if (missing === 0) {
    score += 3;
  } else if (missing <= 2) {
    score += 1;
  } else if (missing >= 4) {
    score -= 6;
  }

  /*
   * 7. H2H
   */

  const h2hValue =
    h2hStrength(
      h2h,
      candidate.market
    );

  if (h2hValue >= 75) {
    score += 4;
  } else if (
    h2hValue >= 60
  ) {
    score += 2;
  }

  /*
   * 8. xG
   */

  const xgHome =
    Number(
      prediction?.expectedGoalsHome || 0
    );

  const xgAway =
    Number(
      prediction?.expectedGoalsAway || 0
    );

  const totalXg =
    xgHome + xgAway;

  if (
    candidate.market === "OVER25"
  ) {
    if (totalXg >= 3.0) score += 5;
    else if (totalXg >= 2.7) score += 3;
    else if (totalXg < 2.3) score -= 5;
  }

  if (
    candidate.market === "OVER15"
  ) {
    if (totalXg >= 2.4) score += 4;
    else if (totalXg >= 2.1) score += 2;
  }

  /*
   * 9. WEATHER
   */

  if (
    event?.weather?.wind_speed != null &&
    Number(event.weather.wind_speed) >= 30
  ) {
    score -= 3;
  }

  return Number(
    clamp(score).toFixed(1)
  );
}

function classify(
  score,
  candidate,
  prediction
) {
  if (!candidate) {
    return "REJECT";
  }

  const p =
    candidate.probability;

  const edge =
    candidate.edge || 0;

  const confidence =
    prediction?.modelConfidence || 0;

  /*
   * TOP:
   * kilka warunków musi być
   * spełnionych jednocześnie.
   */

  if (
    score >= 78 &&
    p >= 65 &&
    edge >= 4 &&
    confidence >= 55 &&
    candidate.modelAgreement
  ) {
    return "TOP";
  }

  /*
   * WATCH:
   * interesujący, ale jeszcze
   * nie spełnia wszystkich
   * warunków.
   */

  if (
    score >= 65 &&
    p >= 58 &&
    edge >= 2 &&
    confidence >= 50
  ) {
    return "WATCH";
  }

  return "REJECT";
}

function reasons(
  candidate,
  prediction,
  lineups,
  h2h
) {
  const result = [];

  if (
    candidate.probability >= 70
  ) {
    result.push(
      "wysokie prawdopodobieństwo modelu"
    );
  } else if (
    candidate.probability >= 60
  ) {
    result.push(
      "dobre prawdopodobieństwo modelu"
    );
  }

  if (
    candidate.edge >= 8
  ) {
    result.push(
      "dodatni edge względem kursu"
    );
  }

  if (
    candidate.modelAgreement
  ) {
    result.push(
      "zgodność z rekomendacją BSD"
    );
  }

  if (
    prediction?.expectedGoalsHome != null &&
    prediction?.expectedGoalsAway != null
  ) {
    result.push(
      `xG ${prediction.expectedGoalsHome} – ${prediction.expectedGoalsAway}`
    );
  }

  if (
    lineups &&
    lineupConfidence(lineups) >= 60
  ) {
    result.push(
      "przewidywane składy mają dobrą pewność"
    );
  }

  if (
    h2h &&
    h2h.total_matches >= 5
  ) {
    result.push(
      "dostępna większa próbka H2H"
    );
  }

  return result;
}

function warnings(
  candidate,
  prediction,
  lineups
) {
  const result = [];

  if (
    candidate.edge >= 15
  ) {
    result.push(
      "bardzo duży edge modelowy — wymaga potwierdzenia rynkiem"
    );
  }

  if (
    prediction?.modelConfidence != null &&
    prediction.modelConfidence < 55
  ) {
    result.push(
      "niska pewność modelu"
    );
  }

  if (
    lineups &&
    lineupConfidence(lineups) < 50
  ) {
    result.push(
      "niska pewność przewidywanych składów"
    );
  }

  if (
    !lineups ||
    lineups.status !== "confirmed"
  ) {
    result.push(
      "składy nie są jeszcze potwierdzone"
    );
  }

  result.push(
    "Betfair Exchange nie jest jeszcze podłączony"
  );

  return result;
}

function analyzeEvent(
  event,
  details
) {
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

  if (!prediction || !odds) {
    return {
      eventId: event.id,
      event: event.event,
      league: event.league,
      start: event.start,
      status: event.status,
      classification: "REJECT",
      score: 0,
      reason:
        "Brak kompletu predykcji lub kursów",
      candidates: []
    };
  }

  const markets = [
    "HOME",
    "DRAW",
    "AWAY",
    "OVER15",
    "OVER25",
    "BTTS"
  ];

  const candidates = [];

  for (const market of markets) {
    const candidate =
      buildCandidate(
        prediction,
        odds,
        market
      );

    if (!candidate) {
      continue;
    }

    candidate.modelAgreement =
      recommendationAgreement(
        prediction,
        market
      );

    candidate.score =
      calculateScore({
        candidate,
        prediction,
        lineups,
        h2h,
        event
      });

    candidate.classification =
      classify(
        candidate.score,
        candidate,
        prediction
      );

    candidate.reasons =
      reasons(
        candidate,
        prediction,
        lineups,
        h2h
      );

    candidate.warnings =
      warnings(
        candidate,
        prediction,
        lineups
      );

    candidates.push(candidate);
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  const top =
    candidates.filter(
      x =>
        x.classification ===
        "TOP"
    );

  const watch =
    candidates.filter(
      x =>
        x.classification ===
        "WATCH"
    );

  return {
    eventId: event.id,

    event: event.event,

    league: event.league,

    start: event.start,

    status: event.status,

    refereeId:
      event.refereeId,

    weather:
      event.weather,

    prediction,

    odds,

    lineups,

    h2h,

    bestPick:
      candidates[0] || null,

    top,

    watch,

    candidates,

    score:
      candidates[0]?.score || 0,

    classification:
      top.length > 0
        ? "TOP"
        : watch.length > 0
          ? "WATCH"
          : "REJECT"
  };
}

app.get("/", (req, res) => {
  res.json({
    name:
      "Bet Analyzer Live API",

    status:
      "online",

    version:
      "4.1.0",

    source:
      "BSD",

    exchange:
      "NOT_CONNECTED"
  });
});

app.get(
  "/api/health",
  (req, res) => {
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
  }
);

app.get(
  "/api/scan",
  async (req, res) => {
    try {
      const today =
        getDate(0);

      const tomorrow =
        getDate(1);

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

      /*
       * Limitujemy liczbę meczów,
       * żeby nie zabić darmowego API.
       */

      const selected =
        events.slice(0, 30);

      for (
        const event of selected
      ) {
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

      const top = [];

      const watch = [];

      for (
        const analysis
        of analyses
      ) {
        for (
          const candidate
          of analysis.candidates || []
        ) {
          if (
            candidate.classification ===
            "TOP"
          ) {
            top.push({
              eventId:
                analysis.eventId,

              event:
                analysis.event,

              league:
                analysis.league,

              start:
                analysis.start,

              ...candidate
            });
          }

          if (
            candidate.classification ===
            "WATCH"
          ) {
            watch.push({
              eventId:
                analysis.eventId,

              event:
                analysis.event,

              league:
                analysis.league,

              start:
                analysis.start,

              ...candidate
            });
          }
        }
      }

      top.sort(
        (a, b) =>
          b.score - a.score
      );

      watch.sort(
        (a, b) =>
          b.score - a.score
      );

      res.json({
        source: "BSD",

        version:
          "4.1.0",

        exchange:
          "NOT_CONNECTED",

        period: {
          start: today,
          end: tomorrow
        },

        totalEvents:
          events.length,

        analyzed:
          analyses.length,

        top:
          top.slice(0, 10),

        watch:
          watch.slice(0, 20),

        rejected:
          analyses.filter(
            x =>
              x.classification ===
              "REJECT"
          ).length,

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
  }
);

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
        source:
          "BSD",

        version:
          "4.1.0",

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
      const today =
        getDate(0);

      const tomorrow =
        getDate(1);

      const data =
        await bsd(
          `/events/?date_from=${today}&date_to=${tomorrow}&limit=50`
        );

      res.json({
        source:
          "BSD",

        dateFrom:
          today,

        dateTo:
          tomorrow,

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
          "Błąd BSD",

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
        source:
          "BSD",

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
