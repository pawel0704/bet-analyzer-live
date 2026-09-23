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

const VERSION = "4.2.1";
const SOURCE = "BSD";

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY nie jest ustawiony.");
}

/* =========================================================
   BSD REQUEST
========================================================= */

async function bsd(path, params = {}) {
  const url = new URL(`${BSD_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `BSD zwrócił nieprawidłową odpowiedź HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `BSD HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

/* =========================================================
   HELPERS
========================================================= */

function arr(value) {
  if (Array.isArray(value)) return value;

  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;

  return [];
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function num(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function positiveNum(value) {
  const n = num(value);

  if (n === null || n <= 0) {
    return null;
  }

  return n;
}

function round(value, decimals = 2) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const p = 10 ** decimals;

  return Math.round(Number(value) * p) / p;
}

function percent(value) {
  const n = num(value);

  if (n === null) {
    return null;
  }

  if (n >= 0 && n <= 1) {
    return round(n * 100, 1);
  }

  return round(n, 1);
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function get(obj, paths, fallback = null) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = obj;

    for (const part of parts) {
      if (
        current === null ||
        current === undefined
      ) {
        current = undefined;
        break;
      }

      current = current[part];
    }

    if (
      current !== undefined &&
      current !== null
    ) {
      return current;
    }
  }

  return fallback;
}

/* =========================================================
   RESPONSE UNWRAPPING
========================================================= */

function unwrapEvent(raw) {
  if (!raw) {
    return null;
  }

  if (
    raw.event &&
    typeof raw.event === "object" &&
    !Array.isArray(raw.event)
  ) {
    return raw.event;
  }

  if (
    raw.data &&
    typeof raw.data === "object" &&
    !Array.isArray(raw.data)
  ) {
    if (raw.data.event) {
      return raw.data.event;
    }

    return raw.data;
  }

  if (
    raw.result &&
    typeof raw.result === "object" &&
    !Array.isArray(raw.result)
  ) {
    return raw.result;
  }

  return raw;
}

/* =========================================================
   EVENT NAME
========================================================= */

function teamName(team) {
  if (typeof team === "string") {
    return team;
  }

  if (
    team &&
    typeof team === "object"
  ) {
    return (
      team.name ||
      team.team_name ||
      team.display_name ||
      null
    );
  }

  return null;
}

function eventName(event) {
  const e =
    unwrapEvent(event) || event;

  const home =
    teamName(
      get(e, [
        "home_team",
        "home"
      ])
    ) ||
    get(e, [
      "home_team_name",
      "home_name"
    ]);

  const away =
    teamName(
      get(e, [
        "away_team",
        "away"
      ])
    ) ||
    get(e, [
      "away_team_name",
      "away_name"
    ]);

  if (home && away) {
    return `${home} – ${away}`;
  }

  return "Unknown match";
}

/* =========================================================
   TEAM IDS
========================================================= */

function eventTeams(event) {
  const e =
    unwrapEvent(event) || event;

  const homeId = num(
    get(e, [
      "home_team.id",
      "home.id",
      "home_team_id"
    ])
  );

  const awayId = num(
    get(e, [
      "away_team.id",
      "away.id",
      "away_team_id"
    ])
  );

  return {
    homeId,
    awayId
  };
}

/* =========================================================
   DATES
========================================================= */

function isoDateDaysAgo(days) {
  const d = new Date();

  d.setUTCDate(
    d.getUTCDate() - days
  );

  return d
    .toISOString()
    .slice(0, 10);
}

function todayUTC() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function tomorrowUTC() {
  const d = new Date();

  d.setUTCDate(
    d.getUTCDate() + 1
  );

  return d
    .toISOString()
    .slice(0, 10);
}

/* =========================================================
   PREDICTION
========================================================= */

function extractPrediction(raw) {
  if (!raw) {
    return null;
  }

  let prediction = raw;

  if (
    raw.data &&
    typeof raw.data === "object" &&
    !Array.isArray(raw.data)
  ) {
    prediction =
      raw.data.prediction ||
      raw.data;
  }

  if (
    raw.prediction &&
    typeof raw.prediction === "object"
  ) {
    prediction =
      raw.prediction;
  }

  if (
    Array.isArray(prediction)
  ) {
    prediction =
      prediction[0] || null;
  }

  if (!prediction) {
    return null;
  }

  const markets =
    prediction.markets || {};

  const matchResult =
    markets.match_result || {};

  const expectedGoals =
    markets.expected_goals || {};

  const overUnder =
    markets.over_under || {};

  const btts =
    markets.btts || {};

  const score =
    markets.score || {};

  const drawNoBet =
    markets.draw_no_bet || {};

  const recommendations =
    prediction.recommendations || {};

  const model =
    prediction.model || {};

  const home =
    percent(
      matchResult.prob_home ??
      prediction.prob_home
    );

  const draw =
    percent(
      matchResult.prob_draw ??
      prediction.prob_draw
    );

  const away =
    percent(
      matchResult.prob_away ??
      prediction.prob_away
    );

  const expectedGoalsHome =
    num(
      expectedGoals.home
    );

  const expectedGoalsAway =
    num(
      expectedGoals.away
    );

  const over15 =
    percent(
      overUnder.prob_over_15
    );

  const over25 =
    percent(
      overUnder.prob_over_25
    );

  const over35 =
    percent(
      overUnder.prob_over_35
    );

  const bttsYes =
    percent(
      btts.prob_yes
    );

  const drawNoBetHome =
    percent(
      drawNoBet.prob_home
    );

  const modelConfidenceRaw =
    num(model.confidence);

  const modelConfidence =
    modelConfidenceRaw === null
      ? null
      : (
          modelConfidenceRaw <= 1
            ? round(
                modelConfidenceRaw * 100,
                1
              )
            : round(
                modelConfidenceRaw,
                1
              )
        );

  return {
    home,
    draw,
    away,

    expectedGoalsHome,
    expectedGoalsAway,

    over15,
    over25,
    over35,

    bttsYes,

    drawNoBetHome,

    modelConfidence,

    mostLikelyScore:
      score.most_likely ??
      null,

    predicted:
      matchResult.predicted ??
      null,

    recommendations
  };
}

/* =========================================================
   LINEUPS
========================================================= */

function extractLineups(raw) {
  if (!raw) {
    return {
      status: null,

      home: {
        formation: null,
        confidence: null,
        players: 0,
        unavailable: []
      },

      away: {
        formation: null,
        confidence: null,
        players: 0,
        unavailable: []
      }
    };
  }

  const data =
    raw.lineups ||
    raw.data ||
    raw;

  const home =
    data.home ||
    data.home_team ||
    {};

  const away =
    data.away ||
    data.away_team ||
    {};

  const homePlayers =
    arr(
      home.players ||
      home.lineup ||
      home.xi
    );

  const awayPlayers =
    arr(
      away.players ||
      away.lineup ||
      away.xi
    );

  const unavailableHome =
    arr(
      home.unavailable ||
      home.absent ||
      home.injured
    );

  const unavailableAway =
    arr(
      away.unavailable ||
      away.absent ||
      away.injured
    );

  return {
    status:
      get(data, [
        "lineup_status",
        "status"
      ], null),

    home: {
      formation:
        get(home, [
          "formation"
        ]),

      confidence:
        num(
          get(home, [
            "confidence",
            "lineup_confidence"
          ])
        ),

      players:
        homePlayers.length,

      unavailable:
        unavailableHome
    },

    away: {
      formation:
        get(away, [
          "formation"
        ]),

      confidence:
        num(
          get(away, [
            "confidence",
            "lineup_confidence"
          ])
        ),

      players:
        awayPlayers.length,

      unavailable:
        unavailableAway
    }
  };
}

/* =========================================================
   FORM
========================================================= */

function resultForTeam(
  match,
  teamId
) {
  const homeId =
    num(
      get(match, [
        "home_team.id",
        "home.id",
        "home_team_id"
      ])
    );

  const awayId =
    num(
      get(match, [
        "away_team.id",
        "away.id",
        "away_team_id"
      ])
    );

  const homeScore =
    num(
      get(match, [
        "home_score",
        "scores.home",
        "home_goals",
        "score.home"
      ])
    );

  const awayScore =
    num(
      get(match, [
        "away_score",
        "scores.away",
        "away_goals",
        "score.away"
      ])
    );

  if (
    homeScore === null ||
    awayScore === null
  ) {
    return null;
  }

  if (homeId === teamId) {
    if (homeScore > awayScore) {
      return "W";
    }

    if (homeScore < awayScore) {
      return "L";
    }

    return "D";
  }

  if (awayId === teamId) {
    if (awayScore > homeScore) {
      return "W";
    }

    if (awayScore < homeScore) {
      return "L";
    }

    return "D";
  }

  return null;
}

function calculateForm(
  matches,
  teamId
) {
  const finished =
    arr(matches)
      .filter(match => {
        const status =
          String(
            get(match, [
              "status"
            ], "")
          ).toLowerCase();

        return (
          status === "finished" ||
          status === "ft" ||
          status === "completed" ||
          status === "ended"
        );
      })
      .sort((a, b) => {
        const da =
          new Date(
            get(a, [
              "event_date",
              "date",
              "kickoff"
            ], 0)
          );

        const db =
          new Date(
            get(b, [
              "event_date",
              "date",
              "kickoff"
            ], 0)
          );

        return db - da;
      });

  const results = [];

  for (
    const match of finished
  ) {
    const result =
      resultForTeam(
        match,
        teamId
      );

    if (result) {
      results.push(result);
    }

    if (
      results.length >= 5
    ) {
      break;
    }
  }

  const points =
    results.reduce(
      (sum, result) =>
        sum +
        (
          result === "W"
            ? 3
            : result === "D"
              ? 1
              : 0
        ),
      0
    );

  return {
    last5: results,

    wins:
      results.filter(
        x => x === "W"
      ).length,

    draws:
      results.filter(
        x => x === "D"
      ).length,

    losses:
      results.filter(
        x => x === "L"
      ).length,

    points,

    maxPoints:
      results.length * 3,

    percentage:
      results.length
        ? round(
            points /
            (results.length * 3) *
            100,
            1
          )
        : null
  };
}

async function getTeamForm(
  teamId
) {
  if (!teamId) {
    return null;
  }

  try {
    const data =
      await bsd(
        `/teams/${teamId}/fixtures/`,
        {
          status: "finished",

          date_from:
            isoDateDaysAgo(365),

          date_to:
            todayUTC(),

          limit: 50
        }
      );

    return calculateForm(
      data,
      teamId
    );

  } catch (error) {
    console.warn(
      `Form error team ${teamId}:`,
      error.message
    );

    return null;
  }
}

/* =========================================================
   REFEREE
========================================================= */

function extractReferee(
  raw
) {
  if (!raw) {
    return null;
  }

  const referee =
    raw.referee ||
    raw.data ||
    raw.result ||
    first(
      arr(raw)
    );

  if (!referee) {
    return null;
  }

  return {
    id:
      num(
        get(referee, [
          "id"
        ])
      ),

    name:
      get(referee, [
        "name",
        "full_name"
      ]),

    matches:
      num(
        get(referee, [
          "matches",
          "matches_count"
        ])
      ),

    yellowPerMatch:
      num(
        get(referee, [
          "yellow_cards_per_match",
          "yellow_per_match",
          "cards_per_match",
          "yellows_per_match"
        ])
      ),

    redPerMatch:
      num(
        get(referee, [
          "red_cards_per_match",
          "red_per_match"
        ])
      ),

    foulsPerMatch:
      num(
        get(referee, [
          "fouls_per_match"
        ])
      ),

    penaltiesPerMatch:
      num(
        get(referee, [
          "penalties_per_match"
        ])
      ),

    goalsPerMatch:
      num(
        get(referee, [
          "goals_per_match"
        ])
      )
  };
}

async function getReferee(
  refereeId
) {
  if (!refereeId) {
    return null;
  }

  try {
    const data =
      await bsd(
        `/referees/${refereeId}/`
      );

    return extractReferee(
      data
    );

  } catch (error) {
    console.warn(
      `Referee error ${refereeId}:`,
      error.message
    );

    return null;
  }
}

/* =========================================================
   ODDS
========================================================= */

function normalizeOddsRows(
  raw
) {
  return arr(raw)
    .map(row => {
      const previous =
        positiveNum(
          get(row, [
            "previous_decimal_odds"
          ])
        );

      const opening =
        positiveNum(
          get(row, [
            "opening_decimal_odds"
          ])
        );

      const odds =
        positiveNum(
          get(row, [
            "decimal_odds",
            "odds"
          ])
        );

      return {
        bookmaker:
          get(row, [
            "bookmaker.name",
            "bookmaker_name",
            "bookmaker_slug"
          ]),

        bookmakerSlug:
          get(row, [
            "bookmaker.slug",
            "bookmaker_slug"
          ]),

        market:
          get(row, [
            "market"
          ]),

        outcome:
          get(row, [
            "outcome"
          ]),

        odds,

        previousOdds:
          previous,

        openingOdds:
          opening,

        movement:
          get(row, [
            "movement"
          ], null),

        updatedAt:
          get(row, [
            "updated_at"
          ], null),

        openingAt:
          get(row, [
            "opening_at"
          ], null),

        isMaxQuote:
          Boolean(
            get(row, [
              "is_max_quote"
            ], false)
          )
      };
    })
    .filter(
      row => row.odds !== null
    );
}

function movementSummary(
  rows
) {
  const moved =
    rows.filter(row => {
      if (
        row.movement ===
          "SHORTENING" ||
        row.movement ===
          "DRIFTING"
      ) {
        return true;
      }

      if (
        row.previousOdds !== null &&
        row.odds !==
          row.previousOdds
      ) {
        return true;
      }

      return false;
    });

  const shortening =
    moved.filter(
      row =>
        row.movement ===
        "SHORTENING"
    );

  const drifting =
    moved.filter(
      row =>
        row.movement ===
        "DRIFTING"
    );

  return {
    totalRows:
      rows.length,

    moved:
      moved.length,

    shortening:
      shortening.length,

    drifting:
      drifting.length
  };
}

function selectMarketOdds(
  rows,
  market,
  outcome
) {
  const candidates =
    rows.filter(
      row =>
        row.market === market &&
        row.outcome === outcome
    );

  if (!candidates.length) {
    return null;
  }

  /*
    Najpierw preferujemy max quote.
    Jeżeli nie ma max quote,
    wybieramy najwyższy kurs.
  */

  const maxQuotes =
    candidates.filter(
      x => x.isMaxQuote
    );

  const source =
    maxQuotes.length
      ? maxQuotes
      : candidates;

  source.sort(
    (a, b) =>
      (b.odds || 0) -
      (a.odds || 0)
  );

  return source[0];
}

function extractOdds(
  raw
) {
  const rows =
    normalizeOddsRows(raw);

  const market =
    (
      name,
      outcome
    ) =>
      selectMarketOdds(
        rows,
        name,
        outcome
      );

  return {
    home:
      market(
        "1x2",
        "HOME"
      ),

    draw:
      market(
        "1x2",
        "DRAW"
      ),

    away:
      market(
        "1x2",
        "AWAY"
      ),

    over15:
      market(
        "over_under_15",
        "over"
      ),

    over25:
      market(
        "over_under_25",
        "over"
      ),

    over35:
      market(
        "over_under_35",
        "over"
      ),

    bttsYes:
      market(
        "btts",
        "yes"
      ),

    rows,

    movement:
      movementSummary(rows)
  };
}

async function getOdds(
  eventId
) {
  try {
    const data =
      await bsd(
        `/odds/`,
        {
          event_id:
            eventId,

          limit:
            200
        }
      );

    return extractOdds(
      data
    );

  } catch (error) {
    console.warn(
      `Odds error event ${eventId}:`,
      error.message
    );

    return {
      home: null,
      draw: null,
      away: null,
      over15: null,
      over25: null,
      over35: null,
      bttsYes: null,
      rows: [],

      movement: {
        totalRows: 0,
        moved: 0,
        shortening: 0,
        drifting: 0
      }
    };
  }
}

/* =========================================================
   EDGE
========================================================= */

function impliedProbability(
  odds
) {
  if (
    odds === null ||
    odds === undefined ||
    odds <= 1
  ) {
    return null;
  }

  return round(
    100 / odds,
    1
  );
}

function edge(
  modelProbability,
  odds
) {
  const implied =
    impliedProbability(
      odds
    );

  if (
    modelProbability === null ||
    implied === null
  ) {
    return null;
  }

  return round(
    modelProbability -
      implied,
    2
  );
}

/* =========================================================
   BSD RECOMMENDATIONS
========================================================= */

function recommendationForMarket(
  prediction,
  market
) {
  const r =
    prediction?.recommendations ||
    {};

  const favorite =
    String(
      r.favorite || ""
    ).toLowerCase();

  if (market === "HOME") {
    return (
      favorite === "home"
    );
  }

  if (market === "DRAW") {
    return (
      favorite === "draw"
    );
  }

  if (market === "AWAY") {
    return (
      favorite === "away"
    );
  }

  if (market === "OVER25") {
    return (
      r.over_25 === true
    );
  }

  if (market === "BTTS") {
    return (
      r.btts === true
    );
  }

  /*
    BSD nie musi wystawiać
    osobnej rekomendacji
    dla każdego progu.
  */

  return false;
}

/* =========================================================
   CANDIDATES
========================================================= */

function makeCandidates(
  prediction,
  odds
) {
  if (!prediction) {
    return [];
  }

  const candidates = [];

  function add(
   
