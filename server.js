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

const VERSION = "6.5.7";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;

const FILTERS = {
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -8,
  minimumOddsForHighProbability: 1.20,

  strongProbabilityMin: 70,
  strongProbabilityScoreMin: 60,
  strongProbabilityValueMin: -3,

  valueScoreMin: 35,
  valueProbabilityMin: 55,
  valuePercentMin: 5
};

// ==================================================
// HELPERS
// ==================================================

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

function normalizeProbability(value) {
  const n = num(value);

  if (n === null) return null;

  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function normalizeConfidence(value) {
  const n = num(value);

  if (n === null) return null;

  if (n > 1 && n <= 100) {
    return n / 100;
  }

  return n;
}

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text = String(value).trim();

  return text || null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}

function extractResults(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.events)) {
    return payload.events;
  }

  if (Array.isArray(payload.predictions)) {
    return payload.predictions;
  }

  if (Array.isArray(payload.odds)) {
    return payload.odds;
  }

  return [];
}

function toDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d;
}

function isUpcomingEvent(event) {
  if (!event) return false;

  const status = String(
    firstDefined(
      event.status,
      event.event_status,
      ""
    )
  ).toLowerCase();

  const date = toDate(
    firstDefined(
      event.event_date,
      event.date,
      event.start_time,
      event.startTime,
      event.kickoff
    )
  );

  if (!date) return false;

  const excludedStatuses = [
    "finished",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "live",
    "inplay",
    "in_play"
  ];

  if (excludedStatuses.includes(status)) {
    return false;
  }

  return date.getTime() > Date.now();
}

// ==================================================
// BSD REQUEST
// ==================================================

async function bsdRequest(path) {
  if (!BSD_API_KEY) {
    throw new Error(
      "BSD_API_KEY is missing"
    );
  }

  const url =
    `${BSD_BASE}${path}`;

  const response = await fetch(
    url,
    {
      method: "GET",
      headers: {
        Authorization:
          `Token ${BSD_API_KEY}`,
        Accept:
          "application/json"
      }
    }
  );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

// ==================================================
// EVENTS
// ==================================================

function parseEvent(raw) {
  if (!raw) return null;

  const event =
    raw.event &&
    typeof raw.event === "object"
      ? raw.event
      : raw;

  const id = num(
    firstDefined(
      event.id,
      event.event_id,
      raw.event_id
    )
  );

  if (!id) return null;

  const home =
    cleanText(
      firstDefined(
        event.home_team,
        event.home_team_name,
        event.home,
        raw.home_team,
        raw.home_team_name
      )
    ) || "Home";

  const away =
    cleanText(
      firstDefined(
        event.away_team,
        event.away_team_name,
        event.away,
        raw.away_team,
        raw.away_team_name
      )
    ) || "Away";

  const date =
    firstDefined(
      event.event_date,
      event.date,
      event.start_time,
      event.startTime,
      raw.event_date,
      raw.date
    );

  const status =
    cleanText(
      firstDefined(
        event.status,
        event.event_status,
        raw.status
      )
    );

  const leagueId =
    num(
      firstDefined(
        event.league_id,
        event.leagueId,
        raw.league_id
      )
    );

  const league =
    cleanText(
      firstDefined(
        event.league_name,
        event.league,
        raw.league_name,
        raw.league
      )
    );

  return {
    id,
    home,
    away,
    date,
    status,
    leagueId,
    league
  };
}

// ==================================================
// PREDICTION
// ==================================================

function parsePrediction(raw) {
  if (!raw) return null;

  const markets =
    raw.markets &&
    typeof raw.markets === "object"
      ? raw.markets
      : {};

  const matchResult =
    markets.match_result &&
    typeof markets.match_result === "object"
      ? markets.match_result
      : {};

  const overUnder =
    markets.over_under &&
    typeof markets.over_under === "object"
      ? markets.over_under
      : {};

  const btts =
    markets.btts &&
    typeof markets.btts === "object"
      ? markets.btts
      : {};

  const expectedGoals =
    markets.expected_goals &&
    typeof markets.expected_goals === "object"
      ? markets.expected_goals
      : {};

  const score =
    markets.score &&
    typeof markets.score === "object"
      ? markets.score
      : {};

  const model =
    raw.model &&
    typeof raw.model === "object"
      ? raw.model
      : {};

  const home =
    normalizeProbability(
      firstDefined(
        matchResult.prob_home,
        raw.prob_home,
        raw.home_probability,
        raw.home
      )
    );

  const draw =
    normalizeProbability(
      firstDefined(
        matchResult.prob_draw,
        raw.prob_draw,
        raw.draw_probability,
        raw.draw
      )
    );

  const away =
    normalizeProbability(
      firstDefined(
        matchResult.prob_away,
        raw.prob_away,
        raw.away_probability,
        raw.away
      )
    );

  const over15 =
    normalizeProbability(
      firstDefined(
        overUnder.prob_over_15,
        raw.prob_over_15,
        raw.over15
      )
    );

  const over25 =
    normalizeProbability(
      firstDefined(
        overUnder.prob_over_25,
        raw.prob_over_25,
        raw.over25
      )
    );

  const over35 =
    normalizeProbability(
      firstDefined(
        overUnder.prob_over_35,
        raw.prob_over_35,
        raw.over35
      )
    );

  const bttsYes =
    normalizeProbability(
      firstDefined(
        btts.prob_yes,
        raw.prob_btts_yes,
        raw.bttsYes
      )
    );

  const xgHome =
    num(
      firstDefined(
        expectedGoals.home,
        raw.xg_home,
        raw.expected_goals_home
      )
    );

  const xgAway =
    num(
      firstDefined(
        expectedGoals.away,
        raw.xg_away,
        raw.expected_goals_away
      )
    );

  const confidence =
    normalizeConfidence(
      firstDefined(
        model.confidence,
        raw.confidence
      )
    );

  const predicted =
    cleanText(
      firstDefined(
        matchResult.predicted,
        raw.predicted,
        raw.prediction
      )
    );

  const mostLikelyScore =
    cleanText(
      firstDefined(
        score.most_likely,
        raw.most_likely_score,
        raw.mostLikelyScore
      )
    );

  const hasProbability =
    home !== null ||
    draw !== null ||
    away !== null ||
    over15 !== null ||
    over25 !== null ||
    over35 !== null ||
    bttsYes !== null;

  if (!hasProbability) {
    return null;
  }

  return {
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    xgHome,
    xgAway,
    confidence,
    predicted,
    mostLikelyScore
  };
}

// ==================================================
// GLOBAL PREDICTIONS
// ==================================================

async function getAllPredictions() {
  const diagnostics = [];

  const paths = [
    "/predictions/?upcoming=true&limit=200",
    "/predictions/?limit=200"
  ];

  for (const path of paths) {
    try {
      const response =
        await bsdRequest(path);

      const rows =
        extractResults(
          response.data
        );

      diagnostics.push({
        path,
        status: response.status,
        count: rows.length
      });

      if (
        !response.ok ||
        !rows.length
      ) {
        continue;
      }

      return {
        rows,
        diagnostics,
        status:
          response.status
      };
    } catch (error) {
      diagnostics.push({
        path,
        error: error.message
      });
    }
  }

  return {
    rows: [],
    diagnostics
  };
}

function findPredictionForEvent(
  eventId,
  rows
) {
  const wanted =
    Number(eventId);

  for (const raw of rows) {
    const predictionEvent =
      raw &&
      raw.event &&
      typeof raw.event === "object"
        ? raw.event
        : null;

    const candidateId =
      num(
        firstDefined(
          predictionEvent?.id,
          predictionEvent?.event_id,
          raw?.event_id
        )
      );

    if (
      candidateId === wanted
    ) {
      return raw;
    }
  }

  return null;
}

// ==================================================
// ODDS PARSER 7
// ==================================================

function normalizeCode(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function getPrice(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value === "number"
  ) {
    return num(value);
  }

  if (
    typeof value === "string"
  ) {
    return num(value);
  }

  if (
    typeof value === "object"
  ) {
    return num(
      firstDefined(
        value.price,
        value.odds,
        value.odd,
        value.decimal,
        value.value,
        value.current,
        value.current_odds
      )
    );
  }

  return null;
}

function objectText(obj) {
  try {
    return JSON.stringify(
      obj || {}
    ).toUpperCase();
  } catch {
    return "";
  }
}

function detectMarketInfo(
  obj
) {
  const text =
    objectText(obj);

  // Explicit BSD market codes
  if (
    text.includes(
      "1X2_HOME_FT"
    ) ||
    text.includes(
      "1X2_DRAW_FT"
    ) ||
    text.includes(
      "1X2_AWAY_FT"
    )
  ) {
    return {
      type: "1x2",
      line: null
    };
  }

  if (
    text.includes(
      "BTTS_YES_FT"
    ) ||
    text.includes(
      "BTTS_NO_FT"
    )
  ) {
    return {
      type: "btts",
      line: null
    };
  }

  for (const line of [
    "1.5",
    "2.5",
    "3.5"
  ]) {
    if (
      text.includes(
        `OU_${line}_OVER_FT`
      ) ||
      text.includes(
        `OU_${line}_UNDER_FT`
      )
    ) {
      return {
        type: "ou",
        line: Number(line)
      };
    }
  }

  if (
    text.includes("BTTS") ||
    text.includes(
      "BOTH_TEAMS_TO_SCORE"
    ) ||
    text.includes(
      "BOTH TEAMS TO SCORE"
    )
  ) {
    return {
      type: "btts",
      line: null
    };
  }

  if (
    text.includes("1X2") ||
    text.includes(
      "MATCH_RESULT"
    ) ||
    text.includes(
      "MATCH RESULT"
    )
  ) {
    return {
      type: "1x2",
      line: null
    };
  }

  if (
    text.includes(
      "OVER_UNDER"
    ) ||
    text.includes(
      "OVER/UNDER"
    ) ||
    text.includes(
      "\"OU\""
    ) ||
    text.includes(
      "TOTAL"
    )
  ) {
    let line = null;

    for (const candidate of [
      1.5,
      2.5,
      3.5
    ]) {
      if (
        text.includes(
          String(candidate)
        )
      ) {
        line = candidate;
        break;
      }
    }

    return {
      type: "ou",
      line
    };
  }

  return {
    type: null,
    line: null
  };
}

function detectSelection(
  obj
) {
  const values = [
    obj?.selection,
    obj?.selection_name,
    obj?.outcome,
    obj?.outcome_name,
    obj?.side,
    obj?.name,
    obj?.code,
    obj?.market_code,
    obj?.market
  ];

  const text =
    values
      .filter(
        x =>
          x !== null &&
          x !== undefined
      )
      .map(normalizeCode)
      .join(" ");

  if (
    text.includes(
      "1X2_HOME_FT"
    ) ||
    text.includes("HOME")
  ) {
    return "HOME";
  }

  if (
    text.includes(
      "1X2_DRAW_FT"
    ) ||
    text.includes("DRAW")
  ) {
    return "DRAW";
  }

  if (
    text.includes(
      "1X2_AWAY_FT"
    ) ||
    text.includes("AWAY")
  ) {
    return "AWAY";
  }

  if (
    text.includes(
      "BTTS_YES_FT"
    ) ||
    text === "YES" ||
    text.includes(" YES")
  ) {
    return "YES";
  }

  if (
    text.includes(
      "BTTS_NO_FT"
    ) ||
    text === "NO" ||
    text.includes(" NO")
  ) {
    return "NO";
  }

  if (
    text.includes(
      "_OVER_"
    ) ||
    text.includes("OVER") ||
    text === "O"
  ) {
    return "OVER";
  }

  if (
    text.includes(
      "_UNDER_"
    ) ||
    text.includes("UNDER") ||
    text === "U"
  ) {
    return "UNDER";
  }

  return "";
}

function extractMovement(
  obj,
  current
) {
  let direction =
    cleanText(
      firstDefined(
        obj?.movement,
        obj?.movement_direction,
        obj?.movement_type,
        obj?.direction
      )
    );

  const previous =
    num(
      firstDefined(
        obj?.previous,
        obj?.previous_odds,
        obj?.prev_odds,
        obj?.odds_previous
      )
    );

  const opening =
    num(
      firstDefined(
        obj?.opening,
        obj?.opening_odds,
        obj?.open_odds
      )
    );

  const currentPrice =
    current !== null
      ? current
      : getPrice(obj);

  if (
    !direction &&
    previous !== null &&
    currentPrice !== null
  ) {
    if (
      currentPrice <
      previous
    ) {
      direction =
        "SHORTENING";
    } else if (
      currentPrice >
      previous
    ) {
      direction =
        "DRIFTING";
    } else {
      direction =
        "STABLE";
    }
  }

  if (
    !direction &&
    opening !== null &&
    currentPrice !== null
  ) {
    if (
      currentPrice <
      opening
    ) {
      direction =
        "SHORTENING";
    } else if (
      currentPrice >
      opening
    ) {
      direction =
        "DRIFTING";
    } else {
      direction =
        "STABLE";
    }
  }

  if (direction) {
    direction =
      String(direction)
        .toUpperCase();
  }

  return {
    direction:
      direction || "UNKNOWN",

    current:
      currentPrice,

    previous,

    opening,

    updatedAt:
      firstDefined(
        obj?.updated_at,
        obj?.updatedAt
      ),

    lastChangeAt:
      firstDefined(
        obj?.last_change_at,
        obj?.lastChangeAt,
        obj?.changed_at
      )
  };
}

function aggregateMovement(
  list
) {
  if (!list.length) {
    return {
      direction: "UNKNOWN",
      current: null,
      previous: null,
      opening: null,
      updatedAt: null,
      lastChangeAt: null,
      bookmakerCount: 0
    };
  }

  let direction =
    "STABLE";

  const dirs =
    list.map(
      x => x.direction
    );

  if (
    dirs.includes(
      "SHORTENING"
    )
  ) {
    direction =
      "SHORTENING";
  } else if (
    dirs.includes(
      "DRIFTING"
    )
  ) {
    direction =
      "DRIFTING";
  } else if (
    dirs.includes(
      "UNKNOWN"
    )
  ) {
    direction =
      "UNKNOWN";
  }

  const currents =
    list
      .map(
        x => x.current
      )
      .filter(
        x => x !== null
      );

  return {
    direction,

    current:
      currents.length
        ? Math.min(
            ...currents
          )
        : null,

    previous:
      list.find(
        x =>
          x.previous !==
          null
      )?.previous ??
      null,

    opening:
      list.find(
        x =>
          x.opening !==
          null
      )?.opening ??
      null,

    updatedAt:
      list
        .map(
          x =>
            x.updatedAt
        )
        .filter(Boolean)
        .sort()
        .pop() ||
      null,

    lastChangeAt:
      list
        .map(
          x =>
            x.lastChangeAt
        )
        .filter(Boolean)
        .sort()
        .pop() ||
      null,

    bookmakerCount:
      list.length
  };
}

function parseOdds(raw) {
  if (!raw) return null;

  const result = {
    home: null,
    draw: null,
    away: null,

    over15: null,
    under15: null,
    over25: null,
    under25: null,
    over35: null,
    under35: null,

    bttsYes: null,
    bttsNo: null,

    updatedAt: null,
    lastChangeAt: null,
    nextUpdateAt: null,
    interval: null,

    bookmakers: [],
    rawCount: 0,

    movementByMarket: {}
  };

  const movements = {
    home: [],
    draw: [],
    away: [],
    over15: [],
    under15: [],
    over25: [],
    under25: [],
    over35: [],
    under35: [],
    bttsYes: [],
    bttsNo: []
  };

  function setBetter(
    key,
    value
  ) {
    const price =
      getPrice(value);

    if (
      price === null ||
      price <= 1
    ) {
      return;
    }

    if (
      result[key] === null ||
      price > result[key]
    ) {
      result[key] = price;
    }
  }

  function addBookmaker(
    obj
  ) {
    const name =
      cleanText(
        firstDefined(
          obj?.bookmaker,
          obj?.bookmaker_name,
          obj?.bookmaker_slug,
          obj?.name,
          obj?.source
        )
      );

    if (
      name &&
      !result.bookmakers.includes(
        name
      )
    ) {
      result.bookmakers.push(
        name
      );
    }
  }

  function mapSelection(
    type,
    line,
    selection,
    price,
    obj
  ) {
    if (
      price === null ||
      price <= 1
    ) {
      return;
    }

    const s =
      normalizeCode(
        selection
      );

    const movement =
      extractMovement(
        obj,
        price
      );

    if (
      type === "1x2"
    ) {
      if (
        s.includes("HOME") ||
        s === "1"
      ) {
        setBetter(
          "home",
          price
        );

        movements.home.push(
          movement
        );

        return;
      }

      if (
        s.includes("DRAW") ||
        s === "X"
      ) {
        setBetter(
          "draw",
          price
        );

        movements.draw.push(
          movement
        );

        return;
      }

      if (
        s.includes("AWAY") ||
        s === "2"
      ) {
        setBetter(
          "away",
          price
        );

        movements.away.push(
          movement
        );

        return;
      }
    }

    if (
      type === "btts"
    ) {
      if (
        s.includes("YES") ||
        s === "Y" ||
        s === "TRUE"
      ) {
        setBetter(
          "bttsYes",
          price
        );

        movements.bttsYes.push(
          movement
        );

        return;
      }

      if (
        s.includes("NO") ||
        s === "N" ||
        s === "FALSE"
      ) {
        setBetter(
          "bttsNo",
          price
        );

        movements.bttsNo.push(
          movement
        );

        return;
      }
    }

    if (
      type === "ou"
    ) {
      if (
        line !== 1.5 &&
        line !== 2.5 &&
        line !== 3.5
      ) {
        return;
      }

      const over =
        s.includes("OVER") ||
        s === "O";

      const under =
        s.includes("UNDER") ||
        s === "U";

      if (
        line === 1.5 &&
        over
      ) {
        setBetter(
          "over15",
          price
        );

        movements.over15.push(
          movement
        );
      }

      if (
        line === 1.5 &&
        under
      ) {
        setBetter(
          "under15",
          price
        );

        movements.under15.push(
          movement
        );
      }

      if (
        line === 2.5 &&
        over
      ) {
        setBetter(
          "over25",
          price
        );

        movements.over25.push(
          movement
        );
      }

      if (
        line === 2.5 &&
        under
      ) {
        setBetter(
          "under25",
          price
        );

        movements.under25.push(
          movement
        );
      }

      if (
        line === 3.5 &&
        over
      ) {
        setBetter(
          "over35",
          price
        );

        movements.over35.push(
          movement
        );
      }

      if (
        line === 3.5 &&
        under
      ) {
        setBetter(
          "under35",
          price
        );

        movements.under35.push(
          movement
        );
      }
    }
  }

  // ----------------------------------------------
  // Recursive BSD scanner
  // ----------------------------------------------

  const visited =
    new Set();

  function scan(
    node,
    inheritedMarket = null,
    inheritedLine = null
  ) {
    if (
      node === null ||
      node === undefined
    ) {
      return;
    }

    if (
      typeof node !== "object"
    ) {
      return;
    }

    if (
      visited.has(node)
    ) {
      return;
    }

    visited.add(node);

    addBookmaker(node);

    result.updatedAt =
      firstDefined(
        result.updatedAt,
        node.updated_at,
        node.updatedAt
      );

    result.lastChangeAt =
      firstDefined(
        result.lastChangeAt,
        node.last_change_at,
        node.lastChangeAt
      );

    result.nextUpdateAt =
      firstDefined(
        result.nextUpdateAt,
        node.next_update_at,
        node.nextUpdateAt
      );

    result.interval =
      firstDefined(
        result.interval,
        node.interval
      );

    const detected =
      detectMarketInfo(
        node
      );

    const marketType =
      detected.type ||
      inheritedMarket;

    const line =
      detected.line ||
      inheritedLine;

    // Direct market code fields
    const codeValues = [
      node.market_code,
      node.market,
      node.market_kind,
      node.market_family,
      node.code,
      node.selection,
      node.outcome
    ];

    for (
      const codeValue
      of codeValues
    ) {
      const code =
        normalizeCode(
          codeValue
        );

      if (
        !code
      ) {
        continue;
      }

      // 1X2 explicit codes
      if (
        code ===
        "1X2_HOME_FT"
      ) {
        const price =
          getPrice(
            firstDefined(
              node.price,
              node.odds,
              node.odd,
              node.current,
              node.value
            )
          );

        mapSelection(
          "1x2",
          null,
          "HOME",
          price,
          node
        );
      }

      if (
        code ===
        "1X2_DRAW_FT"
      ) {
        const price =
          getPrice(
            firstDefined(
              node.price,
              node.odds,
              node.odd,
              node.current,
              node.value
            )
          );

        mapSelection(
          "1x2",
          null,
          "DRAW",
          price,
          node
        );
      }

      if (
        code ===
        "1X2_AWAY_FT"
      ) {
        const price =
          getPrice(
            firstDefined(
              node.price,
              node.odds,
              node.odd,
              node.current,
              node.value
            )
          );

        mapSelection(
          "1x2",
          null,
          "AWAY",
          price,
          node
        );
      }

      // BTTS
      if (
        code ===
        "BTTS_YES_FT"
      ) {
        const price =
          getPrice(
            firstDefined(
              node.price,
              node.odds,
              node.odd,
              node.current,
              node.value
            )
          );

        mapSelection(
          "btts",
          null,
          "YES",
          price,
          node
        );
      }

      if (
        code ===
        "BTTS_NO_FT"
      ) {
        const price =
          getPrice(
            firstDefined(
              node.price,
              node.odds,
              node.odd,
              node.current,
              node.value
            )
          );

        mapSelection(
          "btts",
          null,
          "NO",
          price,
          node
        );
      }

      // OU
      for (
        const ouLine
        of [1.5, 2.5, 3.5]
      ) {
        if (
          code ===
          `OU_${ouLine}_OVER_FT`
        ) {
          const price =
            getPrice(
              firstDefined(
                node.price,
                node.odds,
                node.odd,
                node.current,
                node.value
              )
            );

          mapSelection(
            "ou",
            ouLine,
            "OVER",
            price,
            node
          );
        }

        if (
          code ===
          `OU_${ouLine}_UNDER_FT`
        ) {
          const price =
            getPrice(
              firstDefined(
                node.price,
                node.odds,
                node.odd,
                node.current,
                node.value
              )
            );

          mapSelection(
            "ou",
            ouLine,
            "UNDER",
            price,
            node
          );
        }
      }
    }

    // --------------------------------------------
    // Generic current price + selection
    // --------------------------------------------

    const genericPrice =
      getPrice(
        firstDefined(
          node.price,
          node.odds,
          node.odd,
          node.current,
          node.current_odds,
          node.decimal,
          node.value
        )
      );

    if (
      marketType &&
      genericPrice !== null
    ) {
      const selection =
        detectSelection(
          node
        );

      mapSelection(
        marketType,
        line,
        selection,
        genericPrice,
        node
      );
    }

    // --------------------------------------------
    // odds_home / odds_draw / odds_away
    // --------------------------------------------

    if (
      node.odds_home !==
      undefined
    ) {
      mapSelection(
        "1x2",
        null,
        "HOME",
        getPrice(
          node.odds_home
        ),
        {
          ...node,
          current:
            node.odds_home,
          movement:
            firstDefined(
              node.movement_home,
              node.movement
            ),
          previous:
            firstDefined(
              node.previous_home,
              node.prev_home
            ),
          opening:
            firstDefined(
              node.opening_home,
              node.open_home
            )
        }
      );
    }

    if (
      node.odds_draw !==
      undefined
    ) {
      mapSelection(
        "1x2",
        null,
        "DRAW",
        getPrice(
          node.odds_draw
        ),
        {
          ...node,
          current:
            node.odds_draw,
          movement:
            firstDefined(
              node.movement_draw,
              node.movement
            ),
          previous:
            firstDefined(
              node.previous_draw,
              node.prev_draw
            ),
          opening:
            firstDefined(
              node.opening_draw,
              node.open_draw
            )
        }
      );
    }

    if (
      node.odds_away !==
      undefined
    ) {
      mapSelection(
        "1x2",
        null,
        "AWAY",
        getPrice(
          node.odds_away
        ),
        {
          ...node,
          current:
            node.odds_away,
          movement:
            firstDefined(
              node.movement_away,
              node.movement
            ),
          previous:
            firstDefined(
              node.previous_away,
              node.prev_away
            ),
          opening:
            firstDefined(
              node.opening_away,
              node.open_away
            )
        }
      );
    }

    // --------------------------------------------
    // Nested prices
    // --------------------------------------------

    if (
      node.prices &&
      typeof node.prices === "object"
    ) {
      for (
        const [
          selection,
          priceObject
        ]
        of Object.entries(
          node.prices
        )
      ) {
        const price =
          getPrice(
            priceObject
          );

        mapSelection(
          marketType,
          line,
          selection,
          price,
          {
            ...node,
            ...(priceObject &&
            typeof priceObject ===
              "object"
              ? priceObject
              : {})
          }
        );
      }
    }

    // --------------------------------------------
    // Nested selections
    // --------------------------------------------

    if (
      Array.isArray(
        node.selections
      )
    ) {
      for (
        const selection
        of node.selections
      ) {
        if (!selection) {
          continue;
        }

        const name =
          firstDefined(
            selection.name,
            selection.selection,
            selection.outcome,
            selection.code,
            selection.market_code
          );

        const price =
          getPrice(
            firstDefined(
              selection.price,
              selection.odds,
              selection.odd,
              selection
            )
          );

        mapSelection(
          marketType,
          line,
          name,
          price,
          {
            ...node,
            ...selection
          }
        );
      }
    }

    // --------------------------------------------
    // Recursively inspect children
    // --------------------------------------------

    for (
      const value
      of Object.values(node)
    ) {
      if (
        value &&
        typeof value === "object"
      ) {
        scan(
          value,
          marketType,
          line
        );
      }
    }
  }

  // Start recursive scan.
  scan(raw);

  // ----------------------------------------------
  // Additional direct grouped arrays
  // ----------------------------------------------

  if (
    Array.isArray(
      raw.bookmakers
    )
  ) {
    for (
      const bookmaker
      of raw.bookmakers
    ) {
      scan(bookmaker);
    }
  }

  if (
    Array.isArray(
      raw.markets
    )
  ) {
    for (
      const market
      of raw.markets
    ) {
      scan(market);
    }
  }

  // ----------------------------------------------
  // Movement aggregation
  // ----------------------------------------------

  for (
    const key
    of Object.keys(
      movements
    )
  ) {
    result.movementByMarket[key] =
      aggregateMovement(
        movements[key]
      );
  }

  result.rawCount =
    extractResults(raw).length;

  if (
    typeof raw.count === "number"
  ) {
    result.rawCount =
      Math.max(
        result.rawCount,
        raw.count
      );
  }

  if (
    Array.isArray(
      raw.results
    )
  ) {
    result.rawCount =
      Math.max(
        result.rawCount,
        raw.results.length
      );
  }

  if (
    Array.isArray(
      raw.markets
    )
  ) {
    result.rawCount =
      Math.max(
        result.rawCount,
        raw.markets.length
      );
  }

  if (
    Array.isArray(
      raw.bookmakers
    )
  ) {
    result.rawCount =
      Math.max(
        result.rawCount,
        raw.bookmakers.length
      );
  }

  const hasOdds =
    result.home !== null ||
    result.draw !== null ||
    result.away !== null ||
    result.over15 !== null ||
    result.over25 !== null ||
    result.over35 !== null ||
    result.bttsYes !== null ||
    result.bttsNo !== null;

  if (!hasOdds) {
    return null;
  }

  return result;
}

// ==================================================
// ODDS REQUEST
// ==================================================

async function getOdds(
  eventId
) {
  const diagnostics = [];

  const paths = [
    `/odds/?event_id=${eventId}`,
    `/odds/?event=${eventId}`,
    `/odds/${eventId}/`
  ];

  for (
    const path
    of paths
  ) {
    try {
      const response =
        await bsdRequest(
          path
        );

      const rows =
        extractResults(
          response.data
        );

      let count =
        rows.length;

      if (
        response.data &&
        typeof response.data ===
          "object"
      ) {
        if (
          typeof response.data.count ===
          "number"
        ) {
          count =
            Math.max(
              count,
              response.data.count
            );
        }

        if (
          Array.isArray(
            response.data.markets
          )
        ) {
          count =
            Math.max(
              count,
              response.data.markets.length
            );
        }

        if (
          Array.isArray(
            response.data.bookmakers
          )
        ) {
          count =
            Math.max(
              count,
              response.data.bookmakers.length
            );
        }
      }

      const parsed =
        response.ok
          ? parseOdds(
              response.data
            )
          : null;

      diagnostics.push({
        path,
        status:
          response.status,
        count,
        parsed:
          Boolean(parsed),

        parsedMarkets:
          parsed
            ? {
                home:
                  parsed.home,
                draw:
                  parsed.draw,
                away:
                  parsed.away,
                over15:
                  parsed.over15,
                over25:
                  parsed.over25,
                over35:
                  parsed.over35,
                bttsYes:
                  parsed.bttsYes
              }
            : null
      });

      if (parsed) {
        return {
          available: true,
          data: parsed,
          raw: response.data,
          diagnostics
        };
      }
    } catch (error) {
      diagnostics.push({
        path,
        error:
          error.message
      });
    }
  }

  return {
    available: false,
    data: null,
    raw: null,
    diagnostics
  };
}

// ==================================================
// H2H
// ==================================================

function parseH2H(raw) {
  if (!raw) {
    return {
      sampleSize: 0,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      avgGoals: null
    };
  }

  const rows =
    extractResults(
      raw
    );

  let sampleSize = 0;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let totalGoals = 0;

  for (
    const row
    of rows
  ) {
    const homeScore =
      num(
        firstDefined(
          row.home_score,
          row.homeScore,
          row.score_home,
          row.home_goals
        )
      );

    const awayScore =
      num(
        firstDefined(
          row.away_score,
          row.awayScore,
          row.score_away,
          row.away_goals
        )
      );

    if (
      homeScore === null ||
      awayScore === null
    ) {
      continue;
    }

    sampleSize++;

    totalGoals +=
      homeScore +
      awayScore;

    if (
      homeScore >
      awayScore
    ) {
      homeWins++;
    } else if (
      homeScore <
      awayScore
    ) {
      awayWins++;
    } else {
      draws++;
    }
  }

  return {
    sampleSize,
    homeWins,
    draws,
    awayWins,
    avgGoals:
      sampleSize > 0
        ? Number(
            (
              totalGoals /
              sampleSize
            ).toFixed(3)
          )
        : null
  };
}

async function getH2H(
  event
) {
  try {
    const paths = [
      `/events/${event.id}/`,
      `/head-to-head/?event_id=${event.id}`,
      `/h2h/?event_id=${event.id}`
    ];

    for (
      const path
      of paths
    ) {
      try {
        const response =
          await bsdRequest(
            path
          );

        if (!response.ok) {
          continue;
        }

        const payload =
          response.data;

        if (
          payload?.event
            ?.head_to_head
        ) {
          const parsed =
            parseH2H(
              payload.event
                .head_to_head
            );

          if (
            parsed.sampleSize >
            0
          ) {
            return parsed;
          }
        }

        const parsed =
          parseH2H(
            payload
          );

        if (
          parsed.sampleSize >
          0
        ) {
          return parsed;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }

  return parseH2H(null);
}

// ==================================================
// LINEUPS
// ==================================================

function parseLineups(
  raw
) {
  if (!raw) {
    return {
      available: false,
      confirmed: false,
      homePlayers: 0,
      awayPlayers: 0,
      homeFormation: null,
      awayFormation: null
    };
  }

  const lineups =
    raw.lineups ||
    raw;

  const home =
    lineups.home &&
    typeof lineups.home ===
      "object"
      ? lineups.home
      : {};

  const away =
    lineups.away &&
    typeof lineups.away ===
      "object"
      ? lineups.away
      : {};

  const homePlayers =
    Array.isArray(
      home.players
    )
      ? home.players.length
      : num(
          home.player_count
        ) || 0;

  const awayPlayers =
    Array.isArray(
      away.players
    )
      ? away.players.length
      : num(
          away.player_count
        ) || 0;

  return {
    available:
      homePlayers > 0 ||
      awayPlayers > 0,

    confirmed:
      Boolean(
        firstDefined(
          raw.confirmed,
          raw.lineups_confirmed,
          home.confirmed,
          away.confirmed
        )
      ),

    homePlayers,
    awayPlayers,

    homeFormation:
      cleanText(
        firstDefined(
          home.formation,
          home.system
        )
      ),

    awayFormation:
      cleanText(
        firstDefined(
          away.formation,
          away.system
        )
      )
  };
}

// ==================================================
// EVENT DETAIL
// ==================================================

async function getEventDetail(
  eventId
) {
  try {
    const response =
      await bsdRequest(
        `/events/${eventId}/`
      );

    if (!response.ok) {
      return null;
    }

    return response.data;
  } catch {
    return null;
  }
}

function extractReferee(
  detail
) {
  const referee =
    detail?.event?.referee ||
    detail?.referee ||
    null;

  if (!referee) {
    return null;
  }

  return {
    id:
      num(referee.id),

    name:
      cleanText(
        firstDefined(
          referee.name,
          referee.full_name
        )
      )
  };
}

// ==================================================
// MOVEMENT
// ==================================================

function getMovementForMarket(
  market,
  odds
) {
  if (
    odds?.movementByMarket?.[market]
  ) {
    return odds
      .movementByMarket[market];
  }

  return {
    direction: "UNKNOWN",
    current: null,
    previous: null,
    opening: null,
    updatedAt: null,
    lastChangeAt: null,
    bookmakerCount: 0
  };
}

// ==================================================
// SCORING
// ==================================================

function calculateValuePercent(
  probability,
  odds
) {
  if (
    probability === null ||
    odds === null ||
    odds <= 1
  ) {
    return null;
  }

  const implied =
    100 / odds;

  return Number(
    (
      probability -
      implied
    ).toFixed(4)
  );
}

function probabilityScore(
  probability,
  odds
) {
  if (
    probability === null ||
    odds === null
  ) {
    return null;
  }

  return Number(
    (
      probability *
      Math.min(
        1,
        Math.max(
          0.5,
          odds / 2
        )
      )
    ).toFixed(2)
  );
}

function valueScore(
  probability,
  odds,
  valuePercent
) {
  if (
    probability === null ||
    odds === null ||
    valuePercent === null
  ) {
    return null;
  }

  const p =
    Math.max(
      0,
      probability - 50
    );

  const v =
    Math.max(
      0,
      valuePercent + 10
    );

  return Number(
    (
      p * 0.7 +
      v * 3
    ).toFixed(2)
  );
}

function createCandidate(
  market,
  label,
  probability,
  oddsValue,
  prediction,
  odds
) {
  if (
    probability === null ||
    oddsValue === null ||
    oddsValue <= 1
  ) {
    return null;
  }

  const implied =
    Number(
      (
        100 /
        oddsValue
      ).toFixed(4)
    );

  const valuePercent =
    calculateValuePercent(
      probability,
      oddsValue
    );

  const pScore =
    probabilityScore(
      probability,
      oddsValue
    );

  const vScore =
    valueScore(
      probability,
      oddsValue,
      valuePercent
    );

  if (
    pScore === null ||
    vScore === null
  ) {
    return null;
  }

  let accepted = false;
  let qualificationType =
    null;

  let priceAssessment =
    "NORMAL_PRICE";

  if (
    probability >=
      FILTERS.strongProbabilityMin &&
    pScore >=
      FILTERS.strongProbabilityScoreMin &&
    valuePercent >=
      FILTERS.strongProbabilityValueMin &&
    oddsValue >=
      FILTERS.minimumOddsForHighProbability
  ) {
    accepted = true;
    qualificationType =
      "STRONG_PROBABILITY";
  } else if (
    probability >=
      FILTERS.highProbabilityMin &&
    pScore >=
      FILTERS.highProbabilityScoreMin &&
    valuePercent >=
      FILTERS.highProbabilityValueMin &&
    oddsValue >=
      FILTERS.minimumOddsForHighProbability
  ) {
    accepted = true;
    qualificationType =
      "HIGH_PROBABILITY";
  } else if (
    probability >=
      FILTERS.valueProbabilityMin &&
    vScore >=
      FILTERS.valueScoreMin &&
    valuePercent >=
      FILTERS.valuePercentMin
  ) {
    accepted = true;
    qualificationType =
      "VALUE";
  }

  if (
    valuePercent >= 5
  ) {
    priceAssessment =
      "VALUE_PRICE";
  } else if (
    valuePercent <= -8
  ) {
    priceAssessment =
      "EXPENSIVE_PRICE";
  }

  return {
    market,
    label,

    probability:
      Number(
        probability.toFixed(2)
      ),

    odds:
      Number(
        oddsValue.toFixed(3)
      ),

    impliedProbability:
      implied,

    valuePercent,

    probabilityScore:
      pScore,

    valueScore:
      vScore,

    score:
      pScore,

    accepted,

    qualificationType,

    priceAssessment,

    movement:
      getMovementForMarket(
        market,
        odds
      ),

    prediction
  };
}

// ==================================================
// CANDIDATES
// ==================================================

function buildCandidates(
  prediction,
  odds
) {
  if (
    !prediction ||
    !odds
  ) {
    return [];
  }

  const candidates = [];

  const definitions = [
    [
      "home",
      "Home win",
      prediction.home,
      odds.home
    ],
    [
      "draw",
      "Draw",
      prediction.draw,
      odds.draw
    ],
    [
      "away",
      "Away win",
      prediction.away,
      odds.away
    ],
    [
      "over15",
      "Over 1.5 goals",
      prediction.over15,
      odds.over15
    ],
    [
      "over25",
      "Over 2.5 goals",
      prediction.over25,
      odds.over25
    ],
    [
      "over35",
      "Over 3.5 goals",
      prediction.over35,
      odds.over35
    ],
    [
      "bttsYes",
      "BTTS Yes",
      prediction.bttsYes,
      odds.bttsYes
    ]
  ];

  for (
    const [
      market,
      label,
      probability,
      price
    ]
    of definitions
  ) {
    const candidate =
      createCandidate(
        market,
        label,
        probability,
        price,
        prediction,
        odds
      );

    if (candidate) {
      candidates.push(
        candidate
      );
    }
  }

  return candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );
}

// ==================================================
// BUNDLE
// ==================================================

async function getBundle(
  event,
  predictionRows,
  predictionDiagnostics
) {
  const predictionRaw =
    findPredictionForEvent(
      event.id,
      predictionRows
    );

  const prediction =
    parsePrediction(
      predictionRaw
    );

  const oddsResult =
    await getOdds(
      event.id
    );

  const h2h =
    await getH2H(
      event
    );

  const detail =
    await getEventDetail(
      event.id
    );

  const lineups =
    parseLineups(
      detail?.event?.lineups ||
      detail?.lineups
    );

  const referee =
    extractReferee(
      detail
    );

  const candidates =
    buildCandidates(
      prediction,
      oddsResult.data
    );

  return {
    event,

    predictionAvailable:
      Boolean(prediction),

    oddsAvailable:
      Boolean(
        oddsResult.available
      ),

    prediction,

    odds:
      oddsResult.data,

    oddsRaw:
      oddsResult.raw,

    h2h,

    lineups,

    referee,

    candidates,

    predictionDebug: {
      source:
        "/predictions/?upcoming=true&limit=200",

      count:
        predictionRows.length,

      matchedEventId:
        predictionRaw
          ? event.id
          : null,

      diagnostics:
        predictionDiagnostics
    },

    oddsDebug:
      oddsResult.diagnostics,

    exchange: {
      connected: false,
      status:
        "NOT_CONNECTED",
      signal: null,
      note:
        "Exchange data is not available. No exchange signal is fabricated."
    }
  };
}

// ==================================================
// EVENTS FOR DATE
// ==================================================

async function getEventsForDate(
  date
) {
  const nextDate =
    new Date(
      `${date}T00:00:00Z`
    );

  nextDate.setUTCDate(
    nextDate.getUTCDate() +
      1
  );

  const dateTo =
    nextDate
      .toISOString()
      .slice(0, 10);

  const path =
    `/events/?date_from=${date}&date_to=${dateTo}`;

  const response =
    await bsdRequest(
      path
    );

  return {
    response,

    rows:
      extractResults(
        response.data
      ),

    path
  };
}

// ==================================================
// ROUTES
// ==================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE
    });
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const result =
        await getEventsForDate(
          date
        );

      const events =
        result.rows
          .map(parseEvent)
          .filter(Boolean);

      res.json({
        version: VERSION,
        source: SOURCE,
        date,
        count:
          events.length,
        events
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error:
          error.message
      });
    }
  }
);

// ==================================================
// ANALYZE
// ==================================================

app.get(
  "/api/analyze/:eventId",
  async (req, res) => {
    try {
      const eventId =
        Number(
          req.params.eventId
        );

      if (!eventId) {
        return res.status(400).json({
          error:
            "Invalid eventId"
        });
      }

      const detail =
        await getEventDetail(
          eventId
        );

      const event =
        parseEvent(
          detail?.event ||
          detail
        );

      if (!event) {
        return res.status(404).json({
          version: VERSION,
          error:
            "Event not found"
        });
      }

      const predictions =
        await getAllPredictions();

      const bundle =
        await getBundle(
          event,
          predictions.rows,
          predictions.diagnostics
        );

      res.json({
        version: VERSION,
        source: SOURCE,
        ...bundle
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error:
          error.message
      });
    }
  }
);

// ==================================================
// TOP PICKS
// ==================================================

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const eventsResult =
        await getEventsForDate(
          date
        );

      const parsedEvents =
        eventsResult.rows
          .map(parseEvent)
          .filter(Boolean);

      const eventsReturned =
        parsedEvents.length;

      const upcoming =
        parsedEvents
          .filter(
            isUpcomingEvent
          )
          .sort(
            (a, b) =>
              new Date(a.date) -
              new Date(b.date)
          )
          .slice(0, 10);

      const eventsExcluded =
        eventsReturned -
        upcoming.length;

      const predictions =
        await getAllPredictions();

      const analyzed = [];

      for (
        const event
        of upcoming
      ) {
        try {
          const bundle =
            await getBundle(
              event,
              predictions.rows,
              predictions.diagnostics
            );

          analyzed.push(
            bundle
          );
        } catch (error) {
          analyzed.push({
            event,

            predictionAvailable:
              false,

            oddsAvailable:
              false,

            prediction: null,

            odds: null,

            h2h:
              parseH2H(null),

            lineups:
              parseLineups(null),

            referee: null,

            candidates: [],

            predictionDebug: {
              source:
                "/predictions/?upcoming=true&limit=200",

              count:
                predictions.rows.length,

              matchedEventId:
                null,

              diagnostics:
                predictions.diagnostics
            },

            oddsDebug: [],

            exchange: {
              connected: false,
              status:
                "NOT_CONNECTED",
              signal: null
            },

            error:
              error.message
          });
        }
      }

      const qualified = [];

      for (
        const bundle
        of analyzed
      ) {
        for (
          const candidate
          of bundle.candidates ||
          []
        ) {
          if (
            !candidate.accepted
          ) {
            continue;
          }

          qualified.push({
            ...candidate,

            event: {
              id:
                bundle.event.id,

              home:
                bundle.event.home,

              away:
                bundle.event.away,

              date:
                bundle.event.date,

              status:
                bundle.event.status,

              league:
                bundle.event.league,

              leagueId:
                bundle.event.leagueId
            },

            h2h:
              bundle.h2h,

            lineups:
              bundle.lineups,

            referee:
              bundle.referee,

            exchange:
              bundle.exchange
          });
        }
      }

      qualified.sort(
        (a, b) => {
          if (
            b.probabilityScore !==
            a.probabilityScore
          ) {
            return (
              b.probabilityScore -
              a.probabilityScore
            );
          }

          if (
            b.probability !==
            a.probability
          ) {
            return (
              b.probability -
              a.probability
            );
          }

          return (
            b.valuePercent -
            a.valuePercent
          );
        }
      );

      const topPicks =
        qualified.slice(
          0,
          MAX_TOP_PICKS
        );

      res.json({
        version: VERSION,
        source: SOURCE,

        date,

        eventsReturned,

        upcomingEvents:
          upcoming.length,

        eventsAnalyzed:
          analyzed.length,

        eventsExcluded,

        qualificationCount:
          qualified.length,

        maxTopPicks:
          MAX_TOP_PICKS,

        filters:
          FILTERS,

        exchange: {
          connected: false,
          status:
            "NOT_CONNECTED",
          note:
            "No exchange signal is fabricated."
        },

        picks:
          topPicks,

        analyzed:
          analyzed.map(
            bundle => ({
              event:
                bundle.event,

              predictionAvailable:
                bundle.predictionAvailable,

              oddsAvailable:
                bundle.oddsAvailable,

              prediction:
                bundle.prediction,

              odds:
                bundle.odds,

              h2h:
                bundle.h2h,

              lineups:
                bundle.lineups,

              referee:
                bundle.referee,

              candidates:
                bundle.candidates,

              predictionDebug:
                bundle.predictionDebug,

              oddsDebug:
                bundle.oddsDebug,

              exchange:
                bundle.exchange,

              error:
                bundle.error ||
                null
            })
          )
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,
        error:
          error.message
      });
    }
  }
);

// ==================================================
// START
// ==================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
