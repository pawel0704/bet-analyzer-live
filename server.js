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

    market,

    selection,

    probability,

    quote

  ) {

    if (

      probability === null ||

      !quote?.odds

    ) {

      return;

    }

    candidates.push({

      market,

      selection,

      probability,

      odds:

        quote.odds,

      impliedProbability:

        impliedProbability(

          quote.odds

        ),

      edge:

        edge(

          probability,

          quote.odds

        ),

      movement:

        quote.movement ||

        null,

      previousOdds:

        quote.previousOdds,

      openingOdds:

        quote.openingOdds,

      bookmaker:

        quote.bookmaker,

      bookmakerSlug:

        quote.bookmakerSlug,

      modelAgreement:

        recommendationForMarket(

          prediction,

          market

        )

    });

  }

  add(

    "HOME",

    "1",

    prediction.home,

    odds.home

  );

  add(

    "DRAW",

    "X",

    prediction.draw,

    odds.draw

  );

  add(

    "AWAY",

    "2",

    prediction.away,

    odds.away

  );

  add(

    "OVER15",

    "Over 1.5",

    prediction.over15,

    odds.over15

  );

  add(

    "OVER25",

    "Over 2.5",

    prediction.over25,

    odds.over25

  );

  add(

    "OVER35",

    "Over 3.5",

    prediction.over35,

    odds.over35

  );

  add(

    "BTTS",

    "BTTS TAK",

    prediction.bttsYes,

    odds.bttsYes

  );

  return candidates;

}

/* =========================================================

   FORM IMPACT

========================================================= */

function formImpact(

  homeForm,

  awayForm

) {

  if (

    !homeForm ||

    !awayForm ||

    homeForm.percentage === null ||

    awayForm.percentage === null

  ) {

    return 0;

  }

  return clamp(

    (

      homeForm.percentage -

      awayForm.percentage

    ) / 10,

    -5,

    5

  );

}

/* =========================================================

   MOVEMENT IMPACT

========================================================= */

function movementImpact(

  candidate

) {

  if (!candidate) {

    return 0;

  }

  if (

    candidate.movement ===

    "SHORTENING"

  ) {

    return 2;

  }

  if (

    candidate.movement ===

    "DRIFTING"

  ) {

    return -2;

  }

  return 0;

}

/* =========================================================

   REFEREE IMPACT

========================================================= */

function refereeImpact(

  referee,

  market

) {

  if (!referee) {

    return 0;

  }

  if (

    referee.goalsPerMatch ===

    null

  ) {

    return 0;

  }

  if (

    market === "BTTS"

  ) {

    return clamp(

      (

        referee.goalsPerMatch -

        2.5

      ) * 2,

      -3,

      3

    );

  }

  if (

    market.startsWith("OVER")

  ) {

    return clamp(

      (

        referee.goalsPerMatch -

        2.5

      ) * 1.5,

      -3,

      3

    );

  }

  return 0;

}

/* =========================================================

   CANDIDATE ANALYSIS

========================================================= */

function analyzeCandidate(

  candidate,

  context

) {

  const {

    prediction,

    homeForm,

    awayForm,

    referee,

    lineups

  } = context;

  let score = 0;

  const reasons = [];

  const warnings = [];

  const probability =

    candidate.probability;

  const edgeValue =

    candidate.edge;

  /* -----------------------------------------

     PROBABILITY

  ----------------------------------------- */

  if (

    probability >= 80

  ) {

    score += 25;

    reasons.push(

      "bardzo wysokie prawdopodobieństwo modelu"

    );

  } else if (

    probability >= 70

  ) {

    score += 21;

    reasons.push(

      "wysokie prawdopodobieństwo modelu"

    );

  } else if (

    probability >= 60

  ) {

    score += 16;

    reasons.push(

      "dobre prawdopodobieństwo modelu"

    );

  } else if (

    probability >= 55

  ) {

    score += 10;

  }

  /* -----------------------------------------

     EDGE

  ----------------------------------------- */

  if (

    edgeValue !== null

  ) {

    if (

      edgeValue >= 10

    ) {

      score += 22;

      reasons.push(

        "wyraźnie dodatni edge względem kursu"

      );

    } else if (

      edgeValue >= 5

    ) {

      score += 17;

      reasons.push(

        "dodatni edge względem kursu"

      );

    } else if (

      edgeValue >= 2

    ) {

      score += 10;

      reasons.push(

        "niewielki dodatni edge"

      );

    } else if (

      edgeValue < 0

    ) {

      score -= 18;

      warnings.push(

        "kurs implikuje wyższe prawdopodobieństwo niż model"

      );

    }

  }

  /* -----------------------------------------

     BSD RECOMMENDATION

  ----------------------------------------- */

  if (

    candidate.modelAgreement

  ) {

    score += 10;

    reasons.push(

      "zgodność z rekomendacją modelu BSD"

    );

  } else if (

    candidate.market === "HOME" ||

    candidate.market === "DRAW" ||

    candidate.market === "AWAY" ||

    candidate.market === "OVER25" ||

    candidate.market === "BTTS"

  ) {

    score -= 4;

    warnings.push(

      "brak potwierdzenia typu przez rekomendację BSD"

    );

  }

  /* -----------------------------------------

     FORM

  ----------------------------------------- */

  const formDiff =

    formImpact(

      homeForm,

      awayForm

    );

  if (

    candidate.market ===

    "HOME"

  ) {

    score += clamp(

      formDiff * 2,

      -8,

      8

    );

  }

  if (

    candidate.market ===

    "AWAY"

  ) {

    score -= clamp(

      formDiff * 2,

      -8,

      8

    );

  }

  if (

    Math.abs(formDiff) >= 2

  ) {

    reasons.push(

      "uwzględniono różnicę formy"

    );

  }

  /* -----------------------------------------

     REFEREE

  ----------------------------------------- */

  const refImpact =

    refereeImpact(

      referee,

      candidate.market

    );

  score += refImpact;

  if (

    referee &&

    referee.goalsPerMatch !==

      null

  ) {

    reasons.push(

      `sędzia: ${referee.goalsPerMatch} gola/mecz`

    );

  }

  /* -----------------------------------------

     ODDS MOVEMENT

  ----------------------------------------- */

  const moveImpact =

    movementImpact(

      candidate

    );

  score += moveImpact;

  if (

    candidate.movement ===

    "SHORTENING"

  ) {

    reasons.push(

      "kurs skraca się"

    );

  }

  if (

    candidate.movement ===

    "DRIFTING"

  ) {

    warnings.push(

      "kurs dryfuje przeciwko typowi"

    );

  }

  /* -----------------------------------------

     LINEUPS

  ----------------------------------------- */

  const homeConfidence =

    num(

      lineups?.home?.confidence

    );

  const awayConfidence =

    num(

      lineups?.away?.confidence

    );

  const unavailable =

    (

      lineups?.home?.unavailable

        ?.length || 0

    ) +

    (

      lineups?.away?.unavailable

        ?.length || 0

    );

  if (

    homeConfidence !== null &&

    awayConfidence !== null

  ) {

    const average =

      (

        homeConfidence +

        awayConfidence

      ) / 2;

    if (

      average >= 0.7

    ) {

      score += 7;

    } else if (

      average >= 0.5

    ) {

      score += 3;

    } else {

      score -= 4;

      warnings.push(

        "niska pewność przewidywanych składów"

      );

    }

  }

  if (

    unavailable >= 4

  ) {

    score -= 5;

    warnings.push(

      `dużo niedostępnych zawodników (${unavailable})`

    );

  }

  /* -----------------------------------------

     MODEL CONFIDENCE

  ----------------------------------------- */

  const confidence =

    prediction?.modelConfidence;

  if (

    confidence !== null

  ) {

    if (

      confidence >= 70

    ) {

      score += 8;

    } else if (

      confidence >= 55

    ) {

      score += 5;

    } else if (

      confidence < 45

    ) {

      score -= 5;

      warnings.push(

        "niska pewność modelu"

      );

    }

  }

  /* -----------------------------------------

     FINAL SCORE

  ----------------------------------------- */

  score = Math.round(

    clamp(

      score,

      0,

      100

    )

  );

  let classification =

    "REJECT";

  /*

    TOP

  */

  if (

    probability >= 65 &&

    edgeValue !== null &&

    edgeValue >= 4 &&

    (

      confidence === null ||

      confidence >= 50

    ) &&

    candidate.movement !==

      "DRIFTING" &&

    score >= 72

  ) {

    classification =

      "TOP";

  }

  /*

    WATCH

  */

  else if (

    probability >= 55 &&

    edgeValue !== null &&

    edgeValue >= 2 &&

    score >= 60

  ) {

    classification =

      "WATCH";

  }

  /*

    TOP bez potwierdzenia BSD

    musi mieć wyraźnie większą przewagę.

  */

  if (

    classification === "TOP" &&

    !candidate.modelAgreement &&

    (

      score < 80 ||

      edgeValue < 8

    )

  ) {

    classification =

      "WATCH";

    warnings.push(

      "brak rekomendacji BSD dla tego rynku"

    );

  }

  /*

    Ujemny edge = odrzucenie.

  */

  if (

    edgeValue !== null &&

    edgeValue < 0

  ) {

    classification =

      "REJECT";

  }

  return {

    ...candidate,

    score,

    classification,

    reasons,

    warnings,

    formDifference:

      round(

        formDiff,

        2

      ),

    refereeImpact:

      round(

        refImpact,

        2

      ),

    movementImpact:

      moveImpact

  };

}

/* =========================================================

   EVENT ANALYSIS

========================================================= */

async function analyzeEvent(

  event

) {

  const baseEvent =

    unwrapEvent(event) ||

    event;

  const eventId =

    num(

      get(baseEvent, [

        "id",

        "event_id"

      ])

    );

  const {

    homeId,

    awayId

  } =

    eventTeams(

      baseEvent

    );

  const refereeId =

    num(

      get(baseEvent, [

        "referee.id",

        "referee_id"

      ])

    );

  const [

    detailsRaw,

    stats,

    lineupsRaw,

    h2h,

    predictionRaw,

    odds,

    homeForm,

    awayForm,

    referee

  ] =

    await Promise.all([

      bsd(

        `/events/${eventId}/`

      ).catch(

        () => null

      ),

      bsd(

        `/events/${eventId}/stats/`

      ).catch(

        () => null

      ),

      bsd(

        `/events/${eventId}/lineups/`

      ).catch(

        () => null

      ),

      bsd(

        `/events/${eventId}/h2h/`

      ).catch(

        () => null

      ),

      bsd(

        `/events/${eventId}/prediction/`

      ).catch(

        () => null

      ),

      getOdds(

        eventId

      ),

      getTeamForm(

        homeId

      ),

      getTeamForm(

        awayId

      ),

      getReferee(

        refereeId

      )

    ]);

  const details =

    unwrapEvent(

      detailsRaw

    ) || baseEvent;

  /*

    WAŻNE:

    nazwy bierzemy przede wszystkim

    z eventu bazowego, żeby nie dostać

    "Home – Away".

  */

  const displayEvent =

    eventName(

      baseEvent

    ) !== "Unknown match"

      ? eventName(baseEvent)

      : eventName(details);

  const prediction =

    extractPrediction(

      predictionRaw

    );

  const lineups =

    extractLineups(

      lineupsRaw

    );

  const candidates =

    makeCandidates(

      prediction,

      odds

    );

  const analyzedCandidates =

    candidates.map(

      candidate =>

        analyzeCandidate(

          candidate,

          {

            prediction,

            homeForm,

            awayForm,

            referee,

            lineups

          }

        )

    );

  analyzedCandidates.sort(

    (a, b) =>

      b.score - a.score

  );

  const date =

    get(

      baseEvent,

      [

        "event_date",

        "date",

        "kickoff"

      ]

    ) ||

    get(

      details,

      [

        "event_date",

        "date",

        "kickoff"

      ]

    );

  const status =

    get(

      baseEvent,

      [

        "status"

      ]

    ) ||

    get(

      details,

      [

        "status"

      ]

    );

  const league =

    get(

      baseEvent,

      [

        "league.name",

        "league_name"

      ]

    ) ||

    get(

      details,

      [

        "league.name",

        "league_name"

      ]

    );

  const leagueId =

    num(

      get(

        baseEvent,

        [

          "league.id",

          "league_id"

        ]

      )

    ) ||

    num(

      get(

        details,

        [

          "league.id",

          "league_id"

        ]

      )

    );

  const seasonId =

    num(

      get(

        baseEvent,

        [

          "season.id",

          "season_id"

        ]

      )

    ) ||

    num(

      get(

        details,

        [

          "season.id",

          "season_id"

        ]

      )

    );

  return {

    eventId,

    event:

      displayEvent,

    date,

    status,

    league,

    leagueId,

    seasonId,

    referee: {

      id:

        referee?.id ??

        refereeId ??

        null,

      ...(

        referee || {}

      )

    },

    prediction,

    form: {

      home:

        homeForm,

      away:

        awayForm

    },

    lineups,

    odds: {

      movement:

        odds.movement,

      markets: {

        home:

          odds.home,

        draw:

          odds.draw,

        away:

          odds.away,

        over15:

          odds.over15,

        over25:

          odds.over25,

        over35:

          odds.over35,

        bttsYes:

          odds.bttsYes

      }

    },

    stats,

    h2h,

    candidates:

      analyzedCandidates,

    bestPick:

      analyzedCandidates[0] ||

      null

  };

}

/* =========================================================

   UPCOMING EVENTS

========================================================= */

async function getUpcomingEvents() {

  const start =

    todayUTC();

  const end =

    tomorrowUTC();

  const data =

    await bsd(

      `/events/`,

      {

        date_from:

          start,

        date_to:

          end,

        status:

          "upcoming",

        limit:

          100

      }

    );

  return arr(data)

    .filter(event => {

      const status =

        String(

          get(

            event,

            ["status"],

            ""

          )

        ).toLowerCase();

      return (

        status !==

          "postponed" &&

        status !==

          "cancelled" &&

        status !==

          "unresolved"

      );

    });

}

/* =========================================================

   SCAN

========================================================= */

app.get(

  "/api/scan",

  async (

    req,

    res

  ) => {

    try {

      const events =

        await getUpcomingEvents();

      const selected =

        events.slice(

          0,

          30

        );

      const results = [];

      for (

        const event of selected

      ) {

        try {

          const analysis =

            await analyzeEvent(

              event

            );

          results.push(

            analysis

          );

        } catch (error) {

          console.warn(

            `Event ${event.id} failed:`,

            error.message

          );

        }

      }

      const allCandidates =

        results.flatMap(

          item =>

            item.candidates ||

            []

        );

      const top =

        allCandidates

          .filter(

            x =>

              x.classification ===

              "TOP"

          )

          .sort(

            (a, b) =>

              b.score -

              a.score

          );

      const watch =

        allCandidates

          .filter(

            x =>

              x.classification ===

              "WATCH"

          )

          .sort(

            (a, b) =>

              b.score -

              a.score

          );

      const rejected =

        allCandidates.filter(

          x =>

            x.classification ===

            "REJECT"

        );

      function enrich(

        list

      ) {

        return list.map(

          item => {

            const event =

              results.find(

                e =>

                  e.candidates?.some(

                    c =>

                      c.market ===

                        item.market &&

                      c.selection ===

                        item.selection

                  )

              );

            return {

              eventId:

                event?.eventId ??

                null,

              event:

                event?.event ??

                "Unknown",

              date:

                event?.date ??

                null,

              league:

                event?.league ??

                null,

              ...item

            };

          }

        );

      }

      res.json({

        source:

          SOURCE,

        version:

          VERSION,

        exchange:

          "NOT_CONNECTED",

        period: {

          start:

            todayUTC(),

          end:

            tomorrowUTC()

        },

        totalEvents:

          events.length,

        analyzed:

          results.length,

        top:

          enrich(top),

        watch:

          enrich(watch),

        rejected:

          enrich(rejected),

        all:

          results,

        generatedAt:

          new Date().toISOString()

      });

    } catch (error) {

      console.error(

        "SCAN ERROR:",

        error

      );

      res.status(500).json({

        source:

          SOURCE,

        version:

          VERSION,

        error:

          error.message

      });

    }

  }

);

/* =========================================================

   SINGLE MATCH

========================================================= */

app.get(

  "/api/match/:id",

  async (

    req,

    res

  ) => {

    try {

      const eventId =

        Number(

          req.params.id

        );

      if (

        !Number.isFinite(

          eventId

        )

      ) {

        return res

          .status(400)

          .json({

            error:

              "Nieprawidłowe event ID"

          });

      }

      const eventRaw =

        await bsd(

          `/events/${eventId}/`

        );

      const event =

        unwrapEvent(

          eventRaw

        );

      const result =

        await analyzeEvent(

          event

        );

      res.json({

        source:

          SOURCE,

        version:

          VERSION,

        exchange:

          "NOT_CONNECTED",

        ...result

      });

    } catch (error) {

      console.error(

        "MATCH ERROR:",

        error

      );

      res.status(500).json({

        error:

          error.message

      });

    }

  }

);

/* =========================================================

   BSD TEST

========================================================= */

app.get(

  "/api/bsd-test",

  async (

    req,

    res

  ) => {

    try {

      const data =

        await bsd(

          `/events/`,

          {

            date_from:

              todayUTC(),

            date_to:

              tomorrowUTC(),

            limit:

              50

          }

        );

      res.json({

        source:

          SOURCE,

        dateFrom:

          todayUTC(),

        dateTo:

          tomorrowUTC(),

        count:

          arr(data).length,

        results:

          arr(data)

      });

    } catch (error) {

      res.status(500).json({

        source:

          SOURCE,

        error:

          error.message

      });

    }

  }

);

/* =========================================================

   LIVE

========================================================= */

app.get(

  "/api/live",

  async (

    req,

    res

  ) => {

    try {

      const data =

        await bsd(

          `/events/live/`

        );

      res.json({

        source:

          SOURCE,

        exchange:

          "NOT_CONNECTED",

        count:

          arr(data).length,

        results:

          arr(data)

      });

    } catch (error) {

      res.status(500).json({

        source:

          SOURCE,

        error:

          error.message

      });

    }

  }

);

/* =========================================================

   HEALTH

========================================================= */

app.get(

  "/api/health",

  (

    req,

    res

  ) => {

    res.json({

      status:

        "ok",

      source:

        SOURCE,

      version:

        VERSION,

      exchange:

        "NOT_CONNECTED",

      bsdConfigured:

        Boolean(

          BSD_API_KEY

        ),

      time:

        new Date().toISOString()

    });

  }

);

/* =========================================================

   ROOT

========================================================= */

app.get(

  "/",

  (

    req,

    res

  ) => {

    res.json({

      name:

        "Bet Analyzer Live API",

      status:

        "online",

      version:

        VERSION,

      source:

        SOURCE,

      exchange:

        "NOT_CONNECTED"

    });

  }

);

/* =========================================================

   SERVER

========================================================= */

app.listen(

  PORT,

  () => {

    console.log(

      `Bet Analyzer Live ${VERSION}`

    );

    console.log(

      `Port: ${PORT}`

    );

    console.log(

      `Source: ${SOURCE}`

    );

  }

);
