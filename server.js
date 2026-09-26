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

const VERSION = "6.6.6";
const SOURCE = "BSD";

/* =========================
   CONFIG
========================= */

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 100;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.5;

const MIN_PROBABILITY = 50;

/*
 * Important:
 * We allow only a small negative edge.
 * 6.6.5 used -8%, which was far too permissive.
 */
const MIN_VALUE_EDGE = -2.5;

const REQUEST_TIMEOUT = 15000;

/* =========================
   HELPERS
========================= */

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;

  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function getEventId(event) {
  return safeNumber(
    event?.id ??
    event?.event_id ??
    event?.match_id
  );
}

/*
 * BSD may return teams as:
 *
 * home: { name: "..." }
 * home_team: { name: "..." }
 * home_team: "..."
 * home_name: "..."
 *
 * We handle all of them.
 */

function extractTeamName(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "object") {
    return (
      value.name ||
      value.team_name ||
      value.display_name ||
      value.short_name ||
      null
    );
  }

  return null;
}

function getHomeName(event) {
  return (
    extractTeamName(event?.home) ||
    extractTeamName(event?.home_team) ||
    extractTeamName(event?.homeTeam) ||
    event?.home_name ||
    event?.home_team_name ||
    event?.homeTeamName ||
    event?.teams?.home?.name ||
    event?.teams?.home?.team?.name ||
    event?.participants?.home?.name ||
    "Unknown"
  );
}

function getAwayName(event) {
  return (
    extractTeamName(event?.away) ||
    extractTeamName(event?.away_team) ||
    extractTeamName(event?.awayTeam) ||
    event?.away_name ||
    event?.away_team_name ||
    event?.awayTeamName ||
    event?.teams?.away?.name ||
    event?.teams?.away?.team?.name ||
    event?.participants?.away?.name ||
    "Unknown"
  );
}

function getEventDate(event) {
  return (
    event?.date ||
    event?.event_date ||
    event?.start_time ||
    event?.start_at ||
    event?.kickoff_at ||
    event?.kickoff ||
    event?.start ||
    null
  );
}

function getStatus(event) {
  return normalizeText(
    event?.status ||
    event?.state ||
    event?.match_status ||
    event?.event_status ||
    ""
  );
}

function isUpcomingEvent(event) {
  const status = getStatus(event);

  if (
    status === "live" ||
    status === "finished" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "postponed" ||
    status === "inplay" ||
    status === "in play"
  ) {
    return false;
  }

  const date = getEventDate(event);

  if (!date) return false;

  const timestamp = new Date(date).getTime();

  if (!Number.isFinite(timestamp)) return false;

  return timestamp > Date.now();
}

/* =========================
   BSD FETCH
========================= */

async function bsdFetch(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${BSD_BASE}${path}`,
      {
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json"
        },
        signal: controller.signal
      }
    );

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message =
        data?.detail ||
        data?.message ||
        text?.slice(0, 300) ||
        `BSD ${response.status}`;

      const error = new Error(
        `BSD ${response.status} ${message}`
      );

      error.status = response.status;

      throw error;
    }

    return {
      status: response.status,
      data
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================
   PAGINATION
========================= */

async function fetchAllPages(
  path,
  {
    limit = 200,
    maxPages = 20,
    diagnostics = null
  } = {}
) {
  const all = [];

  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const separator = path.includes("?")
      ? "&"
      : "?";

    const requestPath =
      `${path}${separator}limit=${limit}&offset=${offset}`;

    try {
      const result =
        await bsdFetch(requestPath);

      const data = result.data || {};

      const rows =
        Array.isArray(data)
          ? data
          : Array.isArray(data.results)
            ? data.results
            : Array.isArray(data.data)
              ? data.data
              : [];

      const count =
        safeNumber(data.count) ??
        rows.length;

      all.push(...rows);

      if (diagnostics) {
        diagnostics.push({
          path: requestPath,
          status: result.status,
          count,
          rows: rows.length,
          hasNext: Boolean(data.next)
        });
      }

      if (
        rows.length === 0 ||
        !data.next ||
        all.length >= count
      ) {
        break;
      }

      offset += limit;
    } catch (error) {
      if (diagnostics) {
        diagnostics.push({
          path: requestPath,
          status: error.status || 500,
          error: String(
            error.message || error
          )
            .replace(/\s+/g, " ")
            .slice(0, 300)
        });
      }

      break;
    }
  }

  return all;
}

/* =========================
   EVENTS
========================= */

async function getEventsForDate(
  date,
  diagnostics
) {
  const paths = [
    `/events/?date=${encodeURIComponent(date)}`,
    `/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}`
  ];

  let best = [];

  for (const path of paths) {
    const localDiagnostics = [];

    const rows =
      await fetchAllPages(path, {
        limit: 200,
        maxPages: 5,
        diagnostics: localDiagnostics
      });

    if (diagnostics) {
      diagnostics.push(
        ...localDiagnostics
      );
    }

    if (rows.length > best.length) {
      best = rows;
    }
  }

  return best;
}

/* =========================
   PREDICTIONS
========================= */

function parsePredictionRow(row) {
  if (!row) return null;

  const eventId = safeNumber(
    row.event_id ??
    row.eventId ??
    row.match_id ??
    row.matchId ??
    row.event?.id ??
    row.match?.id
  );

  if (!eventId) return null;

  const markets =
    row.markets ||
    row.prediction?.markets ||
    row.data?.markets ||
    {};

  const matchResult =
    markets.match_result ||
    markets.matchResult ||
    row.match_result ||
    row.matchResult ||
    {};

  const overUnder =
    markets.over_under ||
    markets.overUnder ||
    row.over_under ||
    row.overUnder ||
    {};

  const btts =
    markets.btts ||
    row.btts ||
    {};

  const score =
    markets.score ||
    row.score ||
    {};

  const drawNoBet =
    markets.draw_no_bet ||
    markets.drawNoBet ||
    row.draw_no_bet ||
    row.drawNoBet ||
    {};

  return {
    eventId,

    home: safeNumber(
      matchResult.prob_home ??
      matchResult.home ??
      row.prob_home ??
      row.home_probability ??
      row.home_prob
    ),

    draw: safeNumber(
      matchResult.prob_draw ??
      matchResult.draw ??
      row.prob_draw ??
      row.draw_probability ??
      row.draw_prob
    ),

    away: safeNumber(
      matchResult.prob_away ??
      matchResult.away ??
      row.prob_away ??
      row.away_probability ??
      row.away_prob
    ),

    over15: safeNumber(
      overUnder.prob_over_15 ??
      overUnder.over_15 ??
      row.prob_over_15
    ),

    over25: safeNumber(
      overUnder.prob_over_25 ??
      overUnder.over_25 ??
      row.prob_over_25
    ),

    over35: safeNumber(
      overUnder.prob_over_35 ??
      overUnder.over_35 ??
      row.prob_over_35
    ),

    bttsYes: safeNumber(
      btts.prob_yes ??
      btts.yes ??
      row.prob_btts_yes
    ),

    dnbHome: safeNumber(
      drawNoBet.prob_home ??
      drawNoBet.home ??
      row.prob_dnb_home
    ),

    score:
      score.most_likely ??
      score.mostLikely ??
      row.most_likely_score ??
      row.score_prediction ??
      null,

    confidence: safeNumber(
      row.model?.confidence ??
      row.prediction?.confidence ??
      row.confidence
    )
  };
}

async function getAllPredictions(
  diagnostics
) {
  const rows =
    await fetchAllPages(
      "/predictions/",
      {
        limit: 200,
        maxPages: 20,
        diagnostics
      }
    );

  const map = new Map();

  for (const row of rows) {
    const parsed =
      parsePredictionRow(row);

    if (!parsed) continue;

    map.set(
      parsed.eventId,
      parsed
    );
  }

  return {
    map,
    total: rows.length,
    parsed: map.size
  };
}

/* =========================
   ODDS
========================= */

function normalizeMarket(row) {
  return normalizeText(
    row?.market ??
    row?.market_name ??
    row?.market_slug ??
    row?.market_code ??
    row?.market_kind ??
    row?.market_family ??
    ""
  );
}

function normalizeOutcome(row) {
  return normalizeText(
    row?.outcome ??
    row?.outcome_name ??
    row?.selection ??
    row?.name ??
    row?.outcome_code ??
    ""
  );
}

function getLine(row) {
  return safeNumber(
    row?.line ??
    row?.total ??
    row?.handicap ??
    row?.points ??
    row?.goal_line ??
    row?.threshold
  );
}

function getOddsValue(row) {
  return safeNumber(
    row?.decimal_odds ??
    row?.odds ??
    row?.price ??
    row?.value
  );
}

function getPreviousOdds(row) {
  return safeNumber(
    row?.previous_decimal_odds ??
    row?.previous_odds ??
    row?.previous_price
  );
}

function getOpeningOdds(row) {
  return safeNumber(
    row?.opening_decimal_odds ??
    row?.opening_odds ??
    row?.opening_price
  );
}

function getBookmakerCount(row) {
  return safeNumber(
    row?.bookmaker_count ??
    row?.bookmakers_count ??
    row?.books_count ??
    row?.market_bookmaker_count
  );
}

function classifyOddsRow(row) {
  const market =
    normalizeMarket(row);

  const outcome =
    normalizeOutcome(row);

  const line =
    getLine(row);

  const odds =
    getOddsValue(row);

  if (!odds || odds <= 1) {
    return null;
  }

  const base = {
    odds,
    line,

    bookmakerCount:
      getBookmakerCount(row),

    previousOdds:
      getPreviousOdds(row),

    openingOdds:
      getOpeningOdds(row),

    updatedAt:
      row?.updated_at ||
      row?.timestamp ||
      row?.last_updated ||
      row?.created_at ||
      null,

    movement:
      row?.movement || null
  };

  const is1X2 =
    market.includes("1x2") ||
    market.includes("match result") ||
    market.includes("match winner") ||
    market === "winner" ||
    market === "moneyline";

  const isDoubleChance =
    market.includes("double chance") ||
    market.includes("double_chance") ||
    market.includes("doublechance");

  const isOverUnder =
    market.includes("over under") ||
    market.includes("over/under") ||
    market.includes("total goals") ||
    market.includes("totals") ||
    market.includes("goals");

  const isBTTS =
    market.includes("btts") ||
    market.includes("both teams");

  if (is1X2) {
    if (
      outcome === "home" ||
      outcome === "1" ||
      outcome.includes("home")
    ) {
      return {
        type: "HOME",
        ...base
      };
    }

    if (
      outcome === "draw" ||
      outcome === "x" ||
      outcome.includes("draw")
    ) {
      return {
        type: "DRAW",
        ...base
      };
    }

    if (
      outcome === "away" ||
      outcome === "2" ||
      outcome.includes("away")
    ) {
      return {
        type: "AWAY",
        ...base
      };
    }
  }

  if (isDoubleChance) {
    if (
      outcome === "1x" ||
      outcome === "1 x" ||
      outcome.includes("home or draw") ||
      outcome.includes("home/draw")
    ) {
      return {
        type: "1X",
        ...base
      };
    }

    if (
      outcome === "x2" ||
      outcome === "x 2" ||
      outcome.includes("draw or away") ||
      outcome.includes("draw/away")
    ) {
      return {
        type: "X2",
        ...base
      };
    }

    if (
      outcome === "12" ||
      outcome === "1 2" ||
      outcome.includes("home or away") ||
      outcome.includes("home/away")
    ) {
      return {
        type: "12",
        ...base
      };
    }
  }

  if (isOverUnder) {
    if (
      outcome.includes("over") ||
      outcome === "o"
    ) {
      if (line === null) {
        return null;
      }

      const normalizedLine =
        Number(line.toFixed(2));

      if (normalizedLine === 1.5) {
        return {
          type: "OVER15",
          ...base,
          line: normalizedLine
        };
      }

      if (normalizedLine === 2.5) {
        return {
          type: "OVER25",
          ...base,
          line: normalizedLine
        };
      }

      if (normalizedLine === 3.5) {
        return {
          type: "OVER35",
          ...base,
          line: normalizedLine
        };
      }
    }
  }

  if (isBTTS) {
    if (
      outcome === "yes" ||
      outcome === "y" ||
      outcome.includes("yes")
    ) {
      return {
        type: "BTTS_YES",
        ...base
      };
    }
  }

  return null;
}

function chooseLatest(
  current,
  incoming
) {
  if (!current) {
    return incoming;
  }

  const a =
    current.updatedAt
      ? new Date(
          current.updatedAt
        ).getTime()
      : 0;

  const b =
    incoming.updatedAt
      ? new Date(
          incoming.updatedAt
        ).getTime()
      : 0;

  return b >= a
    ? incoming
    : current;
}

async function getOdds(eventId) {
  const rows =
    await fetchAllPages(
      `/odds/?event_id=${encodeURIComponent(eventId)}`,
      {
        limit: 200,
        maxPages: 10
      }
    );

  const odds = {
    home: null,
    draw: null,
    away: null,

    dc1x: null,
    dcx2: null,
    dc12: null,

    over15: null,
    over25: null,
    over35: null,

    bttsYes: null,

    rowsCount: rows.length,
    rawCount: rows.length
  };

  for (const row of rows) {
    const item =
      classifyOddsRow(row);

    if (!item) continue;

    switch (item.type) {
      case "HOME":
        odds.home =
          chooseLatest(
            odds.home,
            item
          );
        break;

      case "DRAW":
        odds.draw =
          chooseLatest(
            odds.draw,
            item
          );
        break;

      case "AWAY":
        odds.away =
          chooseLatest(
            odds.away,
            item
          );
        break;

      case "1X":
        odds.dc1x =
          chooseLatest(
            odds.dc1x,
            item
          );
        break;

      case "X2":
        odds.dcx2 =
          chooseLatest(
            odds.dcx2,
            item
          );
        break;

      case "12":
        odds.dc12 =
          chooseLatest(
            odds.dc12,
            item
          );
        break;

      case "OVER15":
        odds.over15 =
          chooseLatest(
            odds.over15,
            item
          );
        break;

      case "OVER25":
        odds.over25 =
          chooseLatest(
            odds.over25,
            item
          );
        break;

      case "OVER35":
        odds.over35 =
          chooseLatest(
            odds.over35,
            item
          );
        break;

      case "BTTS_YES":
        odds.bttsYes =
          chooseLatest(
            odds.bttsYes,
            item
          );
        break;
    }
  }

  return odds;
}

/* =========================
   MOVEMENT
========================= */

function calculateMovement(
  oddsObject
) {
  if (!oddsObject) {
    return {
      movement: null,
      movementScore: 0
    };
  }

  const current =
    safeNumber(oddsObject.odds);

  const previous =
    safeNumber(
      oddsObject.previousOdds
    );

  const opening =
    safeNumber(
      oddsObject.openingOdds
    );

  let movement =
    oddsObject.movement ||
    null;

  let score = 0;

  if (
    current &&
    previous &&
    previous > 0
  ) {
    const change =
      ((current - previous) /
        previous) *
      100;

    if (change <= -1) {
      movement = "SHORTENING";
      score += 3;
    } else if (change <= -0.25) {
      movement = "SHORTENING";
      score += 1;
    } else if (change >= 1) {
      movement = "DRIFTING";
      score -= 3;
    } else if (change >= 0.25) {
      movement = "DRIFTING";
      score -= 1;
    }
  }

  if (
    current &&
    opening &&
    opening > 0
  ) {
    const openingChange =
      ((current - opening) /
        opening) *
      100;

    if (openingChange <= -2) {
      score += 1;
    }

    if (openingChange >= 2) {
      score -= 1;
    }
  }

  return {
    movement,
    movementScore:
      clamp(score, -4, 4)
  };
}

/* =========================
   CANDIDATES
========================= */

function makeCandidate({
  event,
  prediction,
  type,
  probability,
  oddsObject,
  label
}) {
  const p =
    safeNumber(probability);

  const o =
    safeNumber(
      oddsObject?.odds
    );

  if (p === null || o === null) {
    return null;
  }

  if (p < MIN_PROBABILITY) {
    return null;
  }

  if (
    o < MIN_ODDS ||
    o > MAX_ODDS
  ) {
    return null;
  }

  const implied =
    (1 / o) * 100;

  const valueEdge =
    p - implied;

  /*
   * Main protection against the 6.6.5 problem.
   */
  if (
    valueEdge <
    MIN_VALUE_EDGE
  ) {
    return null;
  }

  const movement =
    calculateMovement(
      oddsObject
    );

  const bookmakerCount =
    safeNumber(
      oddsObject.bookmakerCount
    ) || 0;

  /*
   * Probability:
   * strong probability matters,
   * but cannot dominate everything.
   */
  const probabilityScore =
    clamp(
      (p - 50) * 0.8,
      0,
      32
    );

  /*
   * Value:
   * positive edge is rewarded.
   * negative edge is penalized heavily.
   */
  let valueScore =
    valueEdge * 4;

  valueScore =
    clamp(
      valueScore,
      -12,
      20
    );

  /*
   * Movement is deliberately small.
   * It cannot rescue a bad price.
   */
  const movementScore =
    movement.movementScore;

  /*
   * More bookmakers = slightly more confidence.
   */
  const bookmakerBonus =
    clamp(
      bookmakerCount / 8,
      0,
      3
    );

  /*
   * Market quality.
   */
  let marketBonus = 0;

  if (
    type === "1X" ||
    type === "X2"
  ) {
    marketBonus = 2;
  }

  if (
    type === "HOME" ||
    type === "AWAY"
  ) {
    marketBonus = 1;
  }

  if (
    type === "OVER15" ||
    type === "OVER25" ||
    type === "BTTS"
  ) {
    marketBonus = 1;
  }

  /*
   * Additional protection:
   * if value is clearly negative,
   * movement cannot push it into
   * the top purely by itself.
   */
  let qualityScore =
    probabilityScore +
    valueScore +
    movementScore +
    bookmakerBonus +
    marketBonus;

  if (valueEdge < -1) {
    qualityScore -= 2;
  }

  if (valueEdge < -2) {
    qualityScore -= 3;
  }

  return {
    eventId:
      getEventId(event),

    home:
      getHomeName(event),

    away:
      getAwayName(event),

    eventDate:
      getEventDate(event),

    market:
      type,

    selection:
      type,

    label,

    probability:
      round(p, 1),

    odds:
      round(o, 3),

    impliedProbability:
      round(implied, 1),

    valueEdge:
      round(valueEdge, 2),

    movement:
      movement.movement,

    movementScore:
      movement.movementScore,

    bookmakerCount,

    previousOdds:
      oddsObject.previousOdds ??
      null,

    openingOdds:
      oddsObject.openingOdds ??
      null,

    probabilityScore:
      round(
        probabilityScore,
        2
      ),

    valueScore:
      round(
        valueScore,
        2
      ),

    bookmakerBonus:
      round(
        bookmakerBonus,
        2
      ),

    marketBonus,

    qualityScore:
      round(
        qualityScore,
        2
      ),

    predictionConfidence:
      prediction?.confidence ??
      null,

    scorePrediction:
      prediction?.score ??
      null,

    warnings:
      valueEdge < 0
        ? ["value poniżej rynku"]
        : []
  };
}

/* =========================
   BUILD CANDIDATES
========================= */

function buildCandidates(
  event,
  prediction,
  odds
) {
  if (!prediction || !odds) {
    return [];
  }

  const candidates = [];

  function add(
    type,
    probability,
    oddsObject,
    label
  ) {
    const candidate =
      makeCandidate({
        event,
        prediction,
        type,
        probability,
        oddsObject,
        label
      });

    if (candidate) {
      candidates.push(candidate);
    }
  }

  add(
    "HOME",
    prediction.home,
    odds.home,
    "Wygrana gospodarzy"
  );

  add(
    "DRAW",
    prediction.draw,
    odds.draw,
    "Remis"
  );

  add(
    "AWAY",
    prediction.away,
    odds.away,
    "Wygrana gości"
  );

  /*
   * Double Chance probabilities:
   *
   * 1X = Home + Draw
   * X2 = Draw + Away
   * 12 = Home + Away
   */
  if (
    prediction.home !== null &&
    prediction.draw !== null
  ) {
    add(
      "1X",
      prediction.home +
        prediction.draw,
      odds.dc1x,
      "Gospodarze lub remis"
    );
  }

  if (
    prediction.draw !== null &&
    prediction.away !== null
  ) {
    add(
      "X2",
      prediction.draw +
        prediction.away,
      odds.dcx2,
      "Remis lub goście"
    );
  }

  if (
    prediction.home !== null &&
    prediction.away !== null
  ) {
    add(
      "12",
      prediction.home +
        prediction.away,
      odds.dc12,
      "Gospodarze lub goście"
    );
  }

  add(
    "OVER15",
    prediction.over15,
    odds.over15,
    "Powyżej 1.5 gola"
  );

  add(
    "OVER25",
    prediction.over25,
    odds.over25,
    "Powyżej 2.5 gola"
  );

  add(
    "OVER35",
    prediction.over35,
    odds.over35,
    "Powyżej 3.5 gola"
  );

  add(
    "BTTS",
    prediction.bttsYes,
    odds.bttsYes,
    "Obie drużyny strzelą"
  );

  return candidates;
}

/* =========================
   RANKING
========================= */

function rankCandidates(
  candidates
) {
  /*
   * Only one pick per match.
   */
  const bestPerEvent =
    new Map();

  for (const candidate of candidates) {
    const existing =
      bestPerEvent.get(
        candidate.eventId
      );

    if (
      !existing ||
      candidate.qualityScore >
        existing.qualityScore
    ) {
      bestPerEvent.set(
        candidate.eventId,
        candidate
      );
    }
  }

  return [
    ...bestPerEvent.values()
  ]
    .sort((a, b) => {
      if (
        b.qualityScore !==
        a.qualityScore
      ) {
        return (
          b.qualityScore -
          a.qualityScore
        );
      }

      if (
        b.valueEdge !==
        a.valueEdge
      ) {
        return (
          b.valueEdge -
          a.valueEdge
        );
      }

      return (
        b.probability -
        a.probability
      );
    })
    .slice(
      0,
      MAX_TOP_PICKS
    )
    .map(
      (item, index) => ({
        rank: index + 1,
        ...item
      })
    );
}

/* =========================
   ANALYZE
========================= */

async function analyzeDate(
  date
) {
  const started =
    Date.now();

  const eventDiagnostics = [];
  const predictionDiagnostics = [];

  const events =
    await getEventsForDate(
      date,
      eventDiagnostics
    );

  const predictions =
    await getAllPredictions(
      predictionDiagnostics
    );

  const upcomingEvents =
    events.filter(
      isUpcomingEvent
    );

  const eventsToAnalyze =
    upcomingEvents.slice(
      0,
      MAX_EVENTS_TO_ANALYZE
    );

  const analysis = [];
  const allCandidates = [];

  for (
    const event of
    eventsToAnalyze
  ) {
    const eventId =
      getEventId(event);

    if (!eventId) {
      continue;
    }

    const prediction =
      predictions.map.get(
        eventId
      ) || null;

    const odds =
      await getOdds(
        eventId
      );

    const candidates =
      buildCandidates(
        event,
        prediction,
        odds
      );

    analysis.push({
      eventId,

      home:
        getHomeName(event),

      away:
        getAwayName(event),

      eventDate:
        getEventDate(event),

      status:
        event.status ||
        event.state ||
        event.match_status ||
        "unknown",

      predictionAvailable:
        Boolean(prediction),

      prediction,

      oddsAvailable:
        Boolean(
          odds.home ||
          odds.draw ||
          odds.away ||
          odds.dc1x ||
          odds.dcx2 ||
          odds.dc12 ||
          odds.over15 ||
          odds.over25 ||
          odds.over35 ||
          odds.bttsYes
        ),

      odds: {
        home:
          odds.home?.odds ??
          null,

        draw:
          odds.draw?.odds ??
          null,

        away:
          odds.away?.odds ??
          null,

        doubleChance1X:
          odds.dc1x?.odds ??
          null,

        doubleChanceX2:
          odds.dcx2?.odds ??
          null,

        doubleChance12:
          odds.dc12?.odds ??
          null,

        over15:
          odds.over15?.odds ??
          null,

        over25:
          odds.over25?.odds ??
          null,

        over35:
          odds.over35?.odds ??
          null,

        bttsYes:
          odds.bttsYes?.odds ??
          null,

        rowsCount:
          odds.rowsCount,

        rawCount:
          odds.rawCount
      },

      candidates
    });

    allCandidates.push(
      ...candidates
    );
  }

  const topPicks =
    rankCandidates(
      allCandidates
    );

  return {
    version: VERSION,
    source: SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() -
      started,

    exchange: {
      connected: false,

      status:
        "NOT_CONNECTED",

      message:
        "Betting exchange data is not connected. No exchange movement is fabricated."
    },

    eventsReturned:
      events.length,

    upcomingEvents:
      upcomingEvents.length,

    eventsAnalyzed:
      eventsToAnalyze.length,

    eventsExcluded:
      Math.max(
        0,
        events.length -
        upcomingEvents.length
      ),

    predictionsTotal:
      predictions.total,

    predictionsParsed:
      predictions.parsed,

    qualificationCount:
      allCandidates.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    thresholds: {
      minProbability:
        MIN_PROBABILITY,

      minOdds:
        MIN_ODDS,

      maxOdds:
        MAX_ODDS,

      minValueEdge:
        `${MIN_VALUE_EDGE}%`,

      maxEventsAnalyzed:
        MAX_EVENTS_TO_ANALYZE
    },

    predictionDiagnostics,

    eventDiagnostics,

    topPicks,

    analysis
  };
}

/* =========================
   ROUTES
========================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "ok",
      service:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE,
      message:
        "Backend is running."
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",
      service:
        "Bet Analyzer Live",
      version: VERSION,
      source: SOURCE
    });
  }
);

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const result =
        await analyzeDate(
          date
        );

      res.json(result);
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      res.status(500).json({
        version: VERSION,
        source: SOURCE,
        status: "error",
        message:
          error?.message ||
          "Analysis failed."
      });
    }
  }
);

/* =========================
   DEBUG ODDS
========================= */

app.get(
  "/api/debug-odds",
  async (req, res) => {
    try {
      const eventId =
        safeNumber(
          req.query.eventId
        );

      if (!eventId) {
        return res.status(400).json({
          error:
            "eventId is required"
        });
      }

      const diagnostics = [];

      const rows =
        await fetchAllPages(
          `/odds/?event_id=${eventId}`,
          {
            limit: 200,
            maxPages: 10,
            diagnostics
          }
        );

      res.json({
        version: VERSION,

        eventId,

        status: 200,

        count:
          rows.length,

        diagnostics,

        firstRows:
          rows.slice(
            0,
            30
          )
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,

        error:
          error?.message ||
          "debug odds failed"
      });
    }
  }
);

/* =========================
   DEBUG PREDICTIONS
========================= */

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const diagnostics = [];

      const result =
        await getAllPredictions(
          diagnostics
        );

      res.json({
        version: VERSION,

        count:
          result.total,

        parsed:
          result.parsed,

        diagnostics,

        sample:
          [
            ...result.map.values()
          ].slice(
            0,
            10
          )
      });
    } catch (error) {
      res.status(500).json({
        version: VERSION,

        error:
          error?.message ||
          "debug predictions failed"
      });
    }
  }
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} running on port ${PORT}`
    );
  }
);
