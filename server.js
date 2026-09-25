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

const VERSION = "6.6.2";
const SOURCE = "BSD";

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 10;

const MIN_PROBABILITY = 55;
const MIN_VALUE_EDGE = -0.08;

const UPCOMING_STATUSES = new Set([
  "notstarted",
  "upcoming",
  "scheduled",
  "pending"
]);

const EXCLUDED_STATUSES = new Set([
  "finished",
  "completed",
  "cancelled",
  "canceled",
  "postponed",
  "abandoned",
  "live",
  "inplay",
  "in_progress"
]);

if (!BSD_API_KEY) {
  console.error("BRAK BSD_API_KEY w zmiennych środowiskowych.");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;

  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function pct(value) {
  if (!Number.isFinite(value)) return null;
  return round(value * 100, 2);
}

function safeDate(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString();
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

async function bsdFetch(path) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is missing");
  }

  const url = `${BSD_BASE}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Token ${BSD_API_KEY}`,
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    status: response.status,
    ok: response.ok,
    data
  };
}

/* =========================================================
   EVENTS
========================================================= */

function extractRows(payload) {
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

  if (payload.data && Array.isArray(payload.data.results)) {
    return payload.data.results;
  }

  return [];
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id =
    raw.id ??
    raw.event_id ??
    raw.eventId;

  if (id == null) {
    return null;
  }

  const homeTeam =
    raw.home_team ??
    raw.homeTeam ??
    raw.home?.name ??
    raw.home?.team_name ??
    raw.teams?.home?.name ??
    null;

  const awayTeam =
    raw.away_team ??
    raw.awayTeam ??
    raw.away?.name ??
    raw.away?.team_name ??
    raw.teams?.away?.name ??
    null;

  const eventDate =
    raw.event_date ??
    raw.date ??
    raw.start_time ??
    raw.start_at ??
    raw.kickoff ??
    null;

  const status = normalizeStatus(
    raw.status ??
    raw.event_status ??
    raw.state
  );

  return {
    id: String(id),
    eventDate: safeDate(eventDate),
    status,

    homeTeam: homeTeam || `Home #${id}`,
    awayTeam: awayTeam || `Away #${id}`,

    league:
      raw.league_name ??
      raw.league ??
      raw.competition_name ??
      null,

    leagueId:
      raw.league_id ??
      raw.leagueId ??
      null,

    seasonId:
      raw.season_id ??
      raw.seasonId ??
      null,

    referee:
      raw.referee ??
      null,

    raw
  };
}

function isUpcomingEvent(event) {
  if (!event) return false;

  const status = normalizeStatus(event.status);

  if (EXCLUDED_STATUSES.has(status)) {
    return false;
  }

  if (UPCOMING_STATUSES.has(status)) {
    return true;
  }

  if (event.eventDate) {
    const timestamp = new Date(event.eventDate).getTime();

    if (Number.isFinite(timestamp)) {
      return timestamp > Date.now();
    }
  }

  return false;
}

async function getEvents(date) {
  const path = `/events/?date=${encodeURIComponent(date)}&limit=50`;

  const result = await bsdFetch(path);

  return {
    path,
    status: result.status,
    ok: result.ok,
    rows: extractRows(result.data)
  };
}

/* =========================================================
   PREDICTIONS
========================================================= */

function parsePredictionRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const event =
    row.event && typeof row.event === "object"
      ? row.event
      : null;

  const markets =
    row.markets && typeof row.markets === "object"
      ? row.markets
      : {};

  const matchResult =
    markets.match_result &&
    typeof markets.match_result === "object"
      ? markets.match_result
      : {};

  const expectedGoals =
    markets.expected_goals &&
    typeof markets.expected_goals === "object"
      ? markets.expected_goals
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

  const score =
    markets.score &&
    typeof markets.score === "object"
      ? markets.score
      : {};

  const drawNoBet =
    markets.draw_no_bet &&
    typeof markets.draw_no_bet === "object"
      ? markets.draw_no_bet
      : {};

  if (!event?.id) {
    return null;
  }

  return {
    eventId: String(event.id),

    homeTeam:
      event.home_team ??
      null,

    awayTeam:
      event.away_team ??
      null,

    eventDate:
      safeDate(event.event_date),

    status:
      normalizeStatus(event.status),

    matchResult: {
      home: number(matchResult.prob_home),
      draw: number(matchResult.prob_draw),
      away: number(matchResult.prob_away),
      predicted:
        matchResult.predicted ??
        null
    },

    expectedGoals: {
      home: number(expectedGoals.home),
      away: number(expectedGoals.away)
    },

    overUnder: {
      over15: number(overUnder.prob_over_15),
      over25: number(overUnder.prob_over_25),
      over35: number(overUnder.prob_over_35)
    },

    btts: {
      yes: number(btts.prob_yes)
    },

    score: {
      mostLikely:
        score.most_likely ??
        null
    },

    drawNoBet: {
      home: number(drawNoBet.prob_home)
    },

    confidence:
      number(row.model?.confidence),

    modelVersion:
      row.model?.version ??
      null,

    recommendations:
      row.recommendations ??
      null,

    raw: row
  };
}

async function getPredictions() {
  const diagnostics = [];
  const rows = [];

  const pages = [
    "/predictions/?limit=200",
    "/predictions/?limit=200&offset=200",
    "/predictions/?limit=200&offset=400"
  ];

  for (const path of pages) {
    const result = await bsdFetch(path);

    const pageRows = extractRows(result.data);

    diagnostics.push({
      path,
      status: result.status,
      ok: result.ok,
      count: pageRows.length
    });

    if (result.ok) {
      rows.push(...pageRows);
    }

    if (pageRows.length === 0) {
      break;
    }
  }

  const parsed = rows
    .map(parsePredictionRow)
    .filter(Boolean);

  const map = new Map();

  for (const prediction of parsed) {
    map.set(prediction.eventId, prediction);
  }

  return {
    diagnostics,
    totalRows: rows.length,
    parsedCount: parsed.length,
    map
  };
}

/* =========================================================
   ODDS
   BSD REAL SHAPE:

   {
     event_id,
     market: "1x2",
     outcome: "HOME",
     decimal_odds,
     previous_decimal_odds,
     opening_decimal_odds,
     opening_at,
     implied_probability,
     movement,
     updated_at,
     bookmaker_count
   }
========================================================= */

function normalizeMarket(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeOutcome(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function parseOddsRows(payload) {
  const rows = extractRows(payload);

  const parsed = {
    oneXTwo: {
      home: null,
      draw: null,
      away: null
    },

    doubleChance: {
      "1X": null,
      "X2": null,
      "12": null
    },

    overUnder: {
      over15: null,
      under15: null,
      over25: null,
      under25: null,
      over35: null,
      under35: null
    },

    btts: {
      yes: null,
      no: null
    },

    rowsCount: rows.length
  };

  function buildSelection(row) {
    const current = number(row.decimal_odds);

    if (!Number.isFinite(current) || current <= 1) {
      return null;
    }

    const previous = number(row.previous_decimal_odds);
    const opening = number(row.opening_decimal_odds);

    let changePrevious = null;
    let changeOpening = null;

    if (Number.isFinite(previous) && previous > 0) {
      changePrevious = current / previous - 1;
    }

    if (Number.isFinite(opening) && opening > 0) {
      changeOpening = current / opening - 1;
    }

    return {
      odds: round(current, 3),

      previousOdds:
        Number.isFinite(previous)
          ? round(previous, 3)
          : null,

      openingOdds:
        Number.isFinite(opening)
          ? round(opening, 3)
          : null,

      changePreviousPct:
        pct(changePrevious),

      changeOpeningPct:
        pct(changeOpening),

      impliedProbability:
        number(row.implied_probability) != null
          ? round(number(row.implied_probability) * 100, 2)
          : round(100 / current, 2),

      movement:
        row.movement ??
        null,

      openingAt:
        safeDate(row.opening_at),

      updatedAt:
        safeDate(row.updated_at),

      bookmakerCount:
        number(row.bookmaker_count),

      bookmaker:
        row.bookmaker_name ??
        row.bookmaker_slug ??
        null,

      market:
        row.market ??
        null,

      outcome:
        row.outcome ??
        null,

      outcomeName:
        row.outcome_name ??
        null,

      rowId:
        row.id ??
        null
    };
  }

  for (const row of rows) {
    const market = normalizeMarket(row.market);
    const outcome = normalizeOutcome(row.outcome);

    const selection = buildSelection(row);

    if (!selection) continue;

    /* ---------- 1X2 ---------- */

    if (
      market === "1x2" ||
      market === "match_result" ||
      market === "match_winner"
    ) {
      if (outcome === "HOME") {
        parsed.oneXTwo.home = selection;
      }

      if (outcome === "DRAW") {
        parsed.oneXTwo.draw = selection;
      }

      if (outcome === "AWAY") {
        parsed.oneXTwo.away = selection;
      }
    }

    /* ---------- DOUBLE CHANCE ---------- */

    if (
      market === "double_chance" ||
      market === "doublechance"
    ) {
      if (outcome === "1X") {
        parsed.doubleChance["1X"] = selection;
      }

      if (outcome === "X2") {
        parsed.doubleChance["X2"] = selection;
      }

      if (outcome === "12") {
        parsed.doubleChance["12"] = selection;
      }
    }

    /* ---------- OVER / UNDER ---------- */

    if (
      market === "over_under" ||
      market === "totals" ||
      market === "ou"
    ) {
      const line = number(row.line);

      if (Number.isFinite(line)) {
        if (outcome === "OVER") {
          if (line === 1.5) parsed.overUnder.over15 = selection;
          if (line === 2.5) parsed.overUnder.over25 = selection;
          if (line === 3.5) parsed.overUnder.over35 = selection;
        }

        if (outcome === "UNDER") {
          if (line === 1.5) parsed.overUnder.under15 = selection;
          if (line === 2.5) parsed.overUnder.under25 = selection;
          if (line === 3.5) parsed.overUnder.under35 = selection;
        }
      }
    }

    /* ---------- BTTS ---------- */

    if (
      market === "btts" ||
      market === "both_teams_to_score"
    ) {
      if (
        outcome === "YES" ||
        outcome === "BTTS_YES"
      ) {
        parsed.btts.yes = selection;
      }

      if (
        outcome === "NO" ||
        outcome === "BTTS_NO"
      ) {
        parsed.btts.no = selection;
      }
    }
  }

  return parsed;
}

async function getOdds(eventId) {
  const path = `/odds/?event_id=${encodeURIComponent(eventId)}`;

  const result = await bsdFetch(path);

  const rows = extractRows(result.data);

  const parsed = parseOddsRows(result.data);

  const oddsAvailable =
    Boolean(
      parsed.oneXTwo.home ||
      parsed.oneXTwo.draw ||
      parsed.oneXTwo.away ||
      parsed.doubleChance["1X"] ||
      parsed.doubleChance["X2"] ||
      parsed.overUnder.over15 ||
      parsed.overUnder.over25 ||
      parsed.overUnder.over35 ||
      parsed.btts.yes
    );

  return {
    eventId: String(eventId),

    path,

    status:
      result.status,

    ok:
      result.ok,

    rowsCount:
      rows.length,

    parsed,
    oddsAvailable,

    rawCount:
      number(result.data?.count) ??
      rows.length
  };
}

/* =========================================================
   MOVEMENT
========================================================= */

function movementStrength(selection) {
  if (!selection) return 0;

  const movement =
    String(selection.movement || "").toUpperCase();

  if (movement === "SHORTENING") {
    return 1;
  }

  if (movement === "DRIFTING") {
    return -1;
  }

  return 0;
}

function marketMovement(selection) {
  if (!selection) {
    return {
      direction: null,
      previousPct: null,
      openingPct: null,
      strength: 0
    };
  }

  return {
    direction:
      selection.movement ??
      null,

    previousPct:
      selection.changePreviousPct,

    openingPct:
      selection.changeOpeningPct,

    strength:
      movementStrength(selection)
  };
}

/* =========================================================
   CANDIDATES
========================================================= */

function candidate(
  event,
  prediction,
  selection,
  marketType,
  label,
  probability,
  extra = {}
) {
  if (!selection) return null;

  const p = number(probability);

  if (!Number.isFinite(p)) {
    return null;
  }

  const probabilityDecimal = p / 100;

  const odds = number(selection.odds);

  if (!Number.isFinite(odds) || odds <= 1) {
    return null;
  }

  const implied =
    1 / odds;

  const valueEdge =
    probabilityDecimal - implied;

  const expectedReturn =
    probabilityDecimal * odds - 1;

  const movement =
    marketMovement(selection);

  /*
   * Ruch kursu wpływa tylko na ranking.
   * NIE zmieniamy nim prawdopodobieństwa modelu.
   */

  let movementScore = 0;

  if (movement.direction === "SHORTENING") {
    movementScore = 4;
  }

  if (movement.direction === "DRIFTING") {
    movementScore = -4;
  }

  const bookmakerBonus =
    selection.bookmakerCount >= 10
      ? 2
      : selection.bookmakerCount >= 5
        ? 1
        : 0;

  const probabilityScore =
    Math.max(
      0,
      Math.min(
        100,
        (p - 50) * 2
      )
    );

  const valueScore =
    Math.max(
      -30,
      Math.min(
        30,
        valueEdge * 100
      )
    );

  const rankingScore =
    probabilityScore +
    valueScore +
    movementScore +
    bookmakerBonus;

  return {
    eventId:
      event.id,

    event:
      `${event.homeTeam} – ${event.awayTeam}`,

    date:
      event.eventDate,

    league:
      event.league,

    market:
      marketType,

    selection:
      label,

    probability:
      round(p, 2),

    odds:
      selection.odds,

    impliedProbability:
      selection.impliedProbability,

    valueEdge:
      round(valueEdge * 100, 2),

    expectedReturn:
      round(expectedReturn * 100, 2),

    rankingScore:
      round(rankingScore, 2),

    movement: {
      direction:
        movement.direction,

      previousChangePct:
        movement.previousPct,

      openingChangePct:
        movement.openingPct
    },

    bookmakers:
      selection.bookmakerCount,

    openingOdds:
      selection.openingOdds,

    previousOdds:
      selection.previousOdds,

    updatedAt:
      selection.updatedAt,

    model:
      prediction
        ? {
            confidence:
              prediction.confidence,

            predicted:
              prediction.matchResult.predicted,

            mostLikelyScore:
              prediction.score.mostLikely,

            expectedGoals:
              prediction.expectedGoals
          }
        : null,

    ...extra
  };
}

function buildCandidates(event, prediction, odds) {
  const result = [];

  if (!prediction || !odds?.parsed) {
    return result;
  }

  const p = prediction;

  /* ================= 1X2 ================= */

  if (
    p.matchResult.home != null &&
    odds.parsed.oneXTwo.home
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.oneXTwo.home,
        "1X2",
        "HOME",
        p.matchResult.home
      )
    );
  }

  if (
    p.matchResult.draw != null &&
    odds.parsed.oneXTwo.draw
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.oneXTwo.draw,
        "1X2",
        "DRAW",
        p.matchResult.draw
      )
    );
  }

  if (
    p.matchResult.away != null &&
    odds.parsed.oneXTwo.away
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.oneXTwo.away,
        "1X2",
        "AWAY",
        p.matchResult.away
      )
    );
  }

  /* ================= DOUBLE CHANCE ================= */

  /*
   * BSD prediction model does not directly expose 1X/X2.
   * We calculate only the model probability from the
   * underlying 1X2 probabilities.
   */

  if (
    odds.parsed.doubleChance["1X"] &&
    p.matchResult.home != null &&
    p.matchResult.draw != null
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.doubleChance["1X"],
        "DOUBLE_CHANCE",
        "1X",
        p.matchResult.home + p.matchResult.draw
      )
    );
  }

  if (
    odds.parsed.doubleChance["X2"] &&
    p.matchResult.draw != null &&
    p.matchResult.away != null
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.doubleChance["X2"],
        "DOUBLE_CHANCE",
        "X2",
        p.matchResult.draw + p.matchResult.away
      )
    );
  }

  if (
    odds.parsed.doubleChance["12"] &&
    p.matchResult.home != null &&
    p.matchResult.away != null
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.doubleChance["12"],
        "DOUBLE_CHANCE",
        "12",
        p.matchResult.home + p.matchResult.away
      )
    );
  }

  /* ================= OVER 1.5 ================= */

  if (
    p.overUnder.over15 != null &&
    odds.parsed.overUnder.over15
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.overUnder.over15,
        "TOTALS",
        "OVER 1.5",
        p.overUnder.over15
      )
    );
  }

  /* ================= OVER 2.5 ================= */

  if (
    p.overUnder.over25 != null &&
    odds.parsed.overUnder.over25
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.overUnder.over25,
        "TOTALS",
        "OVER 2.5",
        p.overUnder.over25
      )
    );
  }

  /* ================= OVER 3.5 ================= */

  if (
    p.overUnder.over35 != null &&
    odds.parsed.overUnder.over35
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.overUnder.over35,
        "TOTALS",
        "OVER 3.5",
        p.overUnder.over35
      )
    );
  }

  /* ================= BTTS ================= */

  if (
    p.btts.yes != null &&
    odds.parsed.btts.yes
  ) {
    result.push(
      candidate(
        event,
        p,
        odds.parsed.btts.yes,
        "BTTS",
        "BTTS YES",
        p.btts.yes
      )
    );
  }

  return result.filter(Boolean);
}

/* =========================================================
   QUALIFICATION
========================================================= */

function isQualified(item) {
  if (!item) return false;

  if (
    !Number.isFinite(item.probability) ||
    item.probability < MIN_PROBABILITY
  ) {
    return false;
  }

  if (
    !Number.isFinite(item.valueEdge) ||
    item.valueEdge < MIN_VALUE_EDGE
  ) {
    return false;
  }

  /*
   * Nie przepuszczamy typów z bardzo dużym kursem
   * tylko po to, żeby nabić listę.
   */

  if (item.odds > 5.5) {
    return false;
  }

  return true;
}

function rankCandidates(candidates) {
  return candidates
    .filter(Boolean)
    .sort((a, b) => {
      if (b.rankingScore !== a.rankingScore) {
        return b.rankingScore - a.rankingScore;
      }

      if (b.probability !== a.probability) {
        return b.probability - a.probability;
      }

      return b.valueEdge - a.valueEdge;
    });
}

/*
 * Maksymalnie jeden typ z jednego meczu w TOP.
 * Dzięki temu lista nie będzie np.:
 * 1X, Over 1.5, BTTS z tego samego spotkania.
 */
function selectTopPicks(candidates) {
  const ranked = rankCandidates(
    candidates.filter(isQualified)
  );

  const selected = [];
  const usedEvents = new Set();

  for (const item of ranked) {
    if (selected.length >= MAX_TOP_PICKS) {
      break;
    }

    if (usedEvents.has(item.eventId)) {
      continue;
    }

    usedEvents.add(item.eventId);
    selected.push(item);
  }

  return selected;
}

/* =========================================================
   ANALYSIS
========================================================= */

async function analyze(date) {
  const startedAt = Date.now();

  const eventsResult = await getEvents(date);

  const normalizedEvents =
    eventsResult.rows
      .map(normalizeEvent)
      .filter(Boolean);

  const upcomingEvents =
    normalizedEvents.filter(isUpcomingEvent);

  const sortedUpcoming =
    upcomingEvents
      .sort((a, b) => {
        const ta =
          a.eventDate
            ? new Date(a.eventDate).getTime()
            : Infinity;

        const tb =
          b.eventDate
            ? new Date(b.eventDate).getTime()
            : Infinity;

        return ta - tb;
      });

  const eventsToAnalyze =
    sortedUpcoming.slice(
      0,
      MAX_EVENTS_TO_ANALYZE
    );

  const predictions =
    await getPredictions();

  const analysis = [];
  const allCandidates = [];

  /*
   * Pobieramy kursy równolegle, ale ograniczamy
   * liczbę requestów do analizowanych meczów.
   */

  const oddsResults =
    await Promise.all(
      eventsToAnalyze.map(async event => {
        try {
          return await getOdds(event.id);
        } catch (error) {
          return {
            eventId: event.id,
            status: null,
            ok: false,
            rowsCount: 0,
            oddsAvailable: false,
            parsed: {
              oneXTwo: {
                home: null,
                draw: null,
                away: null
              },
              doubleChance: {
                "1X": null,
                "X2": null,
                "12": null
              },
              overUnder: {
                over15: null,
                under15: null,
                over25: null,
                under25: null,
                over35: null,
                under35: null
              },
              btts: {
                yes: null,
                no: null
              }
            },
            error: error.message
          };
        }
      })
    );

  const oddsMap = new Map();

  for (const odds of oddsResults) {
    oddsMap.set(
      String(odds.eventId),
      odds
    );
  }

  for (const event of eventsToAnalyze) {
    const prediction =
      predictions.map.get(
        String(event.id)
      ) || null;

    const odds =
      oddsMap.get(
        String(event.id)
      ) || null;

    const candidates =
      buildCandidates(
        event,
        prediction,
        odds
      );

    allCandidates.push(
      ...candidates
    );

    analysis.push({
      eventId:
        event.id,

      event:
        `${event.homeTeam} – ${event.awayTeam}`,

      homeTeam:
        event.homeTeam,

      awayTeam:
        event.awayTeam,

      date:
        event.eventDate,

      status:
        event.status,

      league:
        event.league,

      referee:
        event.referee,

      predictionAvailable:
        Boolean(prediction),

      prediction:
        prediction
          ? {
              matchResult:
                prediction.matchResult,

              expectedGoals:
                prediction.expectedGoals,

              overUnder:
                prediction.overUnder,

              btts:
                prediction.btts,

              score:
                prediction.score,

              drawNoBet:
                prediction.drawNoBet,

              confidence:
                prediction.confidence,

              modelVersion:
                prediction.modelVersion
            }
          : null,

      oddsAvailable:
        Boolean(
          odds?.oddsAvailable
        ),

      odds:
        odds?.parsed || null,

      oddsDiagnostics:
        odds
          ? {
              status:
                odds.status,

              ok:
                odds.ok,

              rowsCount:
                odds.rowsCount,

              rawCount:
                odds.rawCount,

              parsed:
                odds.parsed
            }
          : null,

      candidates:
        candidates.map(item => ({
          market:
            item.market,

          selection:
            item.selection,

          probability:
            item.probability,

          odds:
            item.odds,

          valueEdge:
            item.valueEdge,

          movement:
            item.movement
        }))
    });
  }

  const topPicks =
    selectTopPicks(
      allCandidates
    );

  const qualifiedCandidates =
    allCandidates.filter(
      isQualified
    );

  const exchange = {
    connected: false,
    status: "NOT_CONNECTED",
    message:
      "Betting exchange data is not connected. No exchange movement is fabricated."
  };

  return {
    version: VERSION,
    source: SOURCE,

    date,

    generatedAt:
      new Date().toISOString(),

    processingMs:
      Date.now() - startedAt,

    eventsReturned:
      normalizedEvents.length,

    upcomingEvents:
      upcomingEvents.length,

    eventsAnalyzed:
      eventsToAnalyze.length,

    eventsExcluded:
      normalizedEvents.length -
      upcomingEvents.length,

    predictionsTotal:
      predictions.totalRows,

    predictionsParsed:
      predictions.parsedCount,

    predictionDiagnostics:
      predictions.diagnostics,

    qualificationCount:
      qualifiedCandidates.length,

    maxTopPicks:
      MAX_TOP_PICKS,

    thresholds: {
      minimumProbability:
        MIN_PROBABILITY,

      minimumValueEdgePct:
        MIN_VALUE_EDGE * 100,

      maximumOdds:
        5.5
    },

    exchange,

    topPicks,

    analysis
  };
}

/* =========================================================
   DEBUG ODDS
========================================================= */

function sanitizeDebugValue(value, depth = 0) {
  if (depth > 4) {
    return "[MAX_DEPTH]";
  }

  if (value == null) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map(item =>
        sanitizeDebugValue(
          item,
          depth + 1
        )
      );
  }

  if (typeof value === "object") {
    const output = {};

    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase();

      if (
        lower.includes("token") ||
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower.includes("apikey") ||
        lower.includes("secret")
      ) {
        output[key] = "[REDACTED]";
      } else {
        output[key] =
          sanitizeDebugValue(
            val,
            depth + 1
          );
      }
    }

    return output;
  }

  return String(value);
}

app.get(
  "/api/debug-odds",
  async (req, res) => {
    try {
      const eventId =
        req.query.eventId;

      if (!eventId) {
        return res.status(400).json({
          error:
            "Brak eventId. Użyj ?eventId=207827"
        });
      }

      const result =
        await bsdFetch(
          `/odds/?event_id=${encodeURIComponent(eventId)}`
        );

      const rows =
        extractRows(result.data);

      return res.json({
        version: VERSION,
        source: SOURCE,
        eventId: String(eventId),
        status: result.status,
        ok: result.ok,

        debug: {
          payloadType:
            Array.isArray(result.data)
              ? "array"
              : typeof result.data,

          topLevelKeys:
            result.data &&
            typeof result.data === "object" &&
            !Array.isArray(result.data)
              ? Object.keys(result.data)
              : [],

          resultCount:
            rows.length,

          firstRows:
            rows
              .slice(0, 10)
              .map(sanitizeDebugValue),

          payloadSample:
            sanitizeDebugValue(result.data)
        }
      });
    } catch (error) {
      return res.status(500).json({
        version: VERSION,
        source: SOURCE,
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DEBUG PREDICTIONS
========================================================= */

app.get(
  "/api/debug-predictions",
  async (req, res) => {
    try {
      const predictions =
        await getPredictions();

      const firstRows =
        Array.from(
          predictions.map.values()
        )
          .slice(0, 10)
          .map(item => item.raw);

      return res.json({
        version: VERSION,
        source: SOURCE,

        count:
          predictions.totalRows,

        parsedCount:
          predictions.parsedCount,

        diagnostics:
          predictions.diagnostics,

        firstRows:
          sanitizeDebugValue(
            firstRows
          )
      });
    } catch (error) {
      return res.status(500).json({
        version: VERSION,
        source: SOURCE,
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TOP PICKS
========================================================= */

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const result =
        await analyze(date);

      return res.json({
        version:
          result.version,

        source:
          result.source,

        date:
          result.date,

        generatedAt:
          result.generatedAt,

        exchange:
          result.exchange,

        qualificationCount:
          result.qualificationCount,

        maxTopPicks:
          result.maxTopPicks,

        topPicks:
          result.topPicks
      });
    } catch (error) {
      return res.status(500).json({
        version: VERSION,
        source: SOURCE,
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ANALYZE
========================================================= */

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
        await analyze(date);

      return res.json(result);
    } catch (error) {
      console.error(
        "ANALYZE ERROR:",
        error
      );

      return res.status(500).json({
        version: VERSION,
        source: SOURCE,
        ok: false,
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
  async (req, res) => {
    return res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      service: "bet-analyzer-backend",
      time:
        new Date().toISOString(),
      bsdConfigured:
        Boolean(BSD_API_KEY)
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "Bet Analyzer Live Backend",

      version:
        VERSION,

      source:
        SOURCE,

      endpoints: {
        health:
          "/api/health",

        analyze:
          "/api/analyze?date=YYYY-MM-DD",

        topPicks:
          "/api/top-picks?date=YYYY-MM-DD",

        debugOdds:
          "/api/debug-odds?eventId=207827",

        debugPredictions:
          "/api/debug-predictions"
      }
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
    );
  }
);
