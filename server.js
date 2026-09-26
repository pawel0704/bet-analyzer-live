import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE_URL =
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2";

const VERSION = "7.1.4";
const SOURCE = "BSD";

const MAX_SCAN_EVENTS = Math.min(
  100,
  Math.max(1, Number(process.env.MAX_SCAN_EVENTS || 40))
);

const MAX_PICKS = 10;
const MAX_PICKS_PER_EVENT = 1;

const MIN_PROBABILITY = 58;
const MIN_EDGE = 2;
const MIN_SCORE = 70;

const REQUEST_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 120000;

const cache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  const n = num(value);
  if (n === null) return null;
  return n <= 1 ? n * 100 : n;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function getDate(value) {
  if (!value) return null;

  const d = new Date(value);

  return Number.isNaN(d.getTime()) ? null : d;
}

function impliedProbability(odds) {
  const o = num(odds);

  if (o === null || o <= 1) return null;

  return 100 / o;
}

function edgePercent(probability, odds) {
  const p = pct(probability);
  const implied = impliedProbability(odds);

  if (p === null || implied === null) return null;

  return p - implied;
}

function eventStatus(event) {
  const raw = String(
    event?.status ||
      event?.fixture?.status ||
      event?.fixture?.state ||
      ""
  ).toLowerCase();

  if (
    raw.includes("finished") ||
    raw.includes("complete") ||
    raw.includes("cancel")
  ) {
    return "finished";
  }

  if (
    raw.includes("live") ||
    raw.includes("inplay") ||
    raw.includes("in-play")
  ) {
    return "live";
  }

  return "notstarted";
}

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, {
    time: Date.now(),
    value
  });

  return value;
}

async function bsdRequest(path, options = {}) {
  if (!BSD_API_KEY) {
    const error = new Error("BSD_API_KEY is not configured");
    error.code = "BSD_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${BSD_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`,
      {
        method: options.method || "GET",
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal
      }
    );

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const error = new Error(
        `BSD HTTP ${response.status}`
      );

      error.status = response.status;
      error.code = "BSD_HTTP_ERROR";
      error.data = data;

      throw error;
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("BSD request timeout");
      timeoutError.code = "BSD_TIMEOUT";
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeBsd(path, options = {}) {
  try {
    return await bsdRequest(path, options);
  } catch (error) {
    console.error(
      `[BSD] ${path}`,
      error?.code || error?.message || error
    );

    return null;
  }
}

function unwrapCollection(data) {
  if (!data) return [];

  if (Array.isArray(data)) return data;

  const candidates = [
    data.results,
    data.data,
    data.items,
    data.events,
    data.matches,
    data.fixtures
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }

  if (data.data && typeof data.data === "object") {
    return unwrapCollection(data.data);
  }

  return [];
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  const fixture = firstObject(
    raw.fixture,
    raw.event,
    raw.match
  );

  const home = firstObject(
    raw.home,
    raw.homeTeam,
    raw.teams?.home,
    fixture?.home,
    fixture?.homeTeam,
    fixture?.teams?.home
  );

  const away = firstObject(
    raw.away,
    raw.awayTeam,
    raw.teams?.away,
    fixture?.away,
    fixture?.awayTeam,
    fixture?.teams?.away
  );

  const id =
    raw.id ??
    raw.eventId ??
    raw.event_id ??
    fixture?.id ??
    fixture?.eventId ??
    null;

  if (id === null || id === undefined) {
    return null;
  }

  const homeId =
    home?.id ??
    home?.teamId ??
    home?.team_id ??
    raw.homeTeamId ??
    raw.home_team_id ??
    null;

  const awayId =
    away?.id ??
    away?.teamId ??
    away?.team_id ??
    raw.awayTeamId ??
    raw.away_team_id ??
    null;

  const date =
    raw.date ??
    raw.startTime ??
    raw.start_time ??
    raw.utcDate ??
    fixture?.date ??
    fixture?.startTime ??
    fixture?.start_time ??
    fixture?.utcDate ??
    null;

  return {
    id: Number(id),
    event: String(
      raw.event ||
        raw.name ||
        fixture?.name ||
        `${home?.name || raw.homeName || "Home"} – ${
          away?.name || raw.awayName || "Away"
        }`
    ),
    date,
    status: eventStatus(raw),
    league:
      raw.league?.name ||
      raw.competition?.name ||
      raw.leagueName ||
      null,
    leagueId:
      raw.league?.id ??
      raw.leagueId ??
      null,
    seasonId:
      raw.season?.id ??
      raw.seasonId ??
      null,
    home: {
      id: homeId !== null ? Number(homeId) : null,
      name:
        home?.name ||
        home?.teamName ||
        raw.homeName ||
        "Home"
    },
    away: {
      id: awayId !== null ? Number(awayId) : null,
      name:
        away?.name ||
        away?.teamName ||
        raw.awayName ||
        "Away"
    },
    raw
  };
}

function findPredictionObject(data) {
  if (!data) return null;

  const candidates = [
    data.prediction,
    data.predictions,
    data.model,
    data.forecast,
    data.data?.prediction,
    data.data?.predictions,
    data.results?.prediction
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (candidate.length) return candidate[0];
    } else if (
      candidate &&
      typeof candidate === "object"
    ) {
      return candidate;
    }
  }

  if (
    typeof data === "object" &&
    !Array.isArray(data) &&
    (
      data.home !== undefined ||
      data.draw !== undefined ||
      data.away !== undefined
    )
  ) {
    return data;
  }

  return null;
}

function parsePrediction(data) {
  const p = findPredictionObject(data);

  if (!p) return null;

  const home = pct(
    p.home ??
      p.homeProbability ??
      p.home_prob ??
      p.homeWin
  );

  const draw = pct(
    p.draw ??
      p.drawProbability ??
      p.draw_prob
  );

  const away = pct(
    p.away ??
      p.awayProbability ??
      p.away_prob ??
      p.awayWin
  );

  const over15 = pct(
    p.over15 ??
      p.over_15 ??
      p.over1_5 ??
      p.o15
  );

  const over25 = pct(
    p.over25 ??
      p.over_25 ??
      p.over2_5 ??
      p.o25
  );

  const under25 = pct(
    p.under25 ??
      p.under_25 ??
      p.under2_5 ??
      p.u25
  );

  const under35 = pct(
    p.under35 ??
      p.under_35 ??
      p.under3_5 ??
      p.u35
  );

  const btts = pct(
    p.btts ??
      p.bothTeamsToScore ??
      p.both_teams_score
  );

  const xgHome = num(
    p.xgHome ??
      p.homeXg ??
      p.home_xg
  );

  const xgAway = num(
    p.xgAway ??
      p.awayXg ??
      p.away_xg
  );

  const confidence = pct(
    p.confidence ??
      p.modelConfidence ??
      p.model_confidence
  );

  return {
    home,
    draw,
    away,
    over15,
    over25,
    under25,
    under35,
    btts,
    xgHome,
    xgAway,
    confidence,
    raw: p
  };
}

function flattenOddsObjects(data) {
  const output = [];

  function visit(value, depth = 0) {
    if (!value || depth > 7) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }

      return;
    }

    if (typeof value !== "object") return;

    const hasOdds =
      value.odds !== undefined ||
      value.price !== undefined ||
      value.value !== undefined ||
      value.decimal !== undefined ||
      value.currentOdds !== undefined;

    const hasMarket =
      value.market !== undefined ||
      value.marketName !== undefined ||
      value.type !== undefined ||
      value.betType !== undefined ||
      value.selection !== undefined ||
      value.name !== undefined;

    if (hasOdds && hasMarket) {
      output.push(value);
    }

    for (const key of [
      "data",
      "results",
      "items",
      "odds",
      "markets",
      "bookmakers",
      "bookies",
      "outcomes",
      "selections"
    ]) {
      if (value[key] !== undefined) {
        visit(value[key], depth + 1);
      }
    }
  }

  visit(data);

  return output;
}

function normalizeMarketName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "");
}

function normalizeSelection(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "");
}

function extractOdds(data) {
  const rows = flattenOddsObjects(data);

  const markets = {
    HOME: [],
    DRAW: [],
    AWAY: [],
    OVER15: [],
    OVER25: [],
    UNDER25: [],
    UNDER35: [],
    BTTS_YES: [],
    BTTS_NO: [],
    DC1X: [],
    DCX2: []
  };

  for (const row of rows) {
    const market = normalizeMarketName(
      row.market ??
        row.marketName ??
        row.type ??
        row.betType ??
        row.name
    );

    const selection = normalizeSelection(
      row.selection ??
        row.outcome ??
        row.outcomeName ??
        row.label ??
        row.name
    );

    const odds = num(
      row.currentOdds ??
        row.odds ??
        row.price ??
        row.decimal ??
        row.value
    );

    if (odds === null || odds <= 1) continue;

    let key = null;

    if (
      market.includes("1x2") ||
      market.includes("matchresult") ||
      market === "result" ||
      market === "winner"
    ) {
      if (
        selection === "1" ||
        selection.includes("home")
      ) {
        key = "HOME";
      } else if (
        selection === "x" ||
        selection.includes("draw")
      ) {
        key = "DRAW";
      } else if (
        selection === "2" ||
        selection.includes("away")
      ) {
        key = "AWAY";
      }
    }

    if (
      market.includes("overunder") ||
      market.includes("totals") ||
      market.includes("goals")
    ) {
      if (
        selection.includes("over1.5") ||
        selection.includes("over15")
      ) {
        key = "OVER15";
      }

      if (
        selection.includes("over2.5") ||
        selection.includes("over25")
      ) {
        key = "OVER25";
      }

      if (
        selection.includes("under2.5") ||
        selection.includes("under25")
      ) {
        key = "UNDER25";
      }

      if (
        selection.includes("under3.5") ||
        selection.includes("under35")
      ) {
        key = "UNDER35";
      }
    }

    if (
      market.includes("btts") ||
      market.includes("bothteamstoscore")
    ) {
      if (
        selection === "yes" ||
        selection === "y"
      ) {
        key = "BTTS_YES";
      }

      if (
        selection === "no" ||
        selection === "n"
      ) {
        key = "BTTS_NO";
      }
    }

    if (
      market.includes("doublechance") ||
      market.includes("double")
    ) {
      if (
        selection.includes("1x") ||
        selection === "1x"
      ) {
        key = "DC1X";
      }

      if (
        selection.includes("x2") ||
        selection === "x2"
      ) {
        key = "DCX2";
      }
    }

    if (key) {
      markets[key].push({
        odds,
        previousOdds: num(
          row.previousOdds ??
            row.previous_odds ??
            row.oldOdds ??
            row.old_odds
        ),
        bookmaker:
          row.bookmaker?.name ||
          row.bookmakerName ||
          row.bookie ||
          row.source ||
          null,
        raw: row
      });
    }
  }

  return markets;
}

function aggregateMovement(rows) {
  const valid = arr(rows).filter(
    (row) =>
      num(row.odds) !== null &&
      num(row.previousOdds) !== null &&
      num(row.previousOdds) > 1 &&
      num(row.odds) > 1
  );

  if (!valid.length) {
    return {
      movement: "UNKNOWN",
      previousOdds: null,
      currentOdds: null,
      changePercent: null,
      samples: 0,
      confidence: 0
    };
  }

  let totalChange = 0;
  let shortening = 0;
  let drifting = 0;

  for (const row of valid) {
    const previous = num(row.previousOdds);
    const current = num(row.odds);

    const change = ((current - previous) / previous) * 100;

    totalChange += change;

    if (change < -0.15) shortening++;
    if (change > 0.15) drifting++;
  }

  const avgChange = totalChange / valid.length;

  let movement = "STABLE";

  if (shortening > drifting && avgChange < -0.15) {
    movement = "SHORTENING";
  } else if (
    drifting > shortening &&
    avgChange > 0.15
  ) {
    movement = "DRIFTING";
  }

  const currentOdds = Math.max(
    ...valid.map((row) => num(row.odds))
  );

  const representative = valid
    .slice()
    .sort(
      (a, b) =>
        Math.abs(
          num(a.odds) - currentOdds
        ) -
        Math.abs(
          num(b.odds) - currentOdds
        )
    )[0];

  return {
    movement,
    previousOdds: num(
      representative?.previousOdds
    ),
    currentOdds,
    changePercent: avgChange,
    samples: valid.length,
    confidence: Math.round(
      clamp(
        Math.max(shortening, drifting) /
          valid.length *
          100,
        0,
        100
      )
    )
  };
}

function movementFor(markets, key) {
  const rows = markets?.[key] || [];

  return aggregateMovement(rows);
}

function bestCurrentOdds(markets, key) {
  const rows = arr(markets?.[key]).filter(
    (row) =>
      num(row.odds) !== null &&
      num(row.odds) > 1
  );

  if (!rows.length) return null;

  return Math.max(
    ...rows.map((row) => num(row.odds))
  );
}

function parseLineups(data) {
  if (!data) {
    return {
      available: false,
      home: null,
      away: null,
      confidence: null,
      unavailable: []
    };
  }

  const root =
    firstObject(
      data.lineups,
      data.data?.lineups,
      data
    ) || {};

  const home =
    root.home ||
    root.homeTeam ||
    root.teams?.home ||
    null;

  const away =
    root.away ||
    root.awayTeam ||
    root.teams?.away ||
    null;

  const unavailable = [
    ...arr(
      home?.unavailable ||
        home?.injured ||
        home?.absent
    ),
    ...arr(
      away?.unavailable ||
        away?.injured ||
        away?.absent
    )
  ];

  const confidence = pct(
    root.confidence ??
      data.confidence
  );

  return {
    available: Boolean(
      home || away
    ),
    home,
    away,
    confidence,
    unavailable
  };
}

function parseReferee(data) {
  if (!data) return null;

  const r =
    firstObject(
      data.referee,
      data.data?.referee,
      data
    );

  if (!r) return null;

  return {
    id: r.id ?? r.refereeId ?? null,
    name: r.name ?? null,
    matches: num(
      r.matches ??
        r.totalMatches
    ),
    yellow: num(
      r.yellow ??
        r.yellowCards ??
        r.avgYellow
    ),
    red: num(
      r.red ??
        r.redCards ??
        r.avgRed
    ),
    penalties: num(
      r.penalties ??
        r.penaltyCount
    )
  };
}

function parseForm(data, teamId) {
  const matches = unwrapCollection(data);

  if (!teamId || !matches.length) {
    return {
      available: false,
      matches: [],
      points: null,
      goalsFor: null,
      goalsAgainst: null
    };
  }

  const normalized = [];

  for (const raw of matches) {
    const event = normalizeEvent(raw);

    if (!event) continue;

    const homeId = event.home.id;
    const awayId = event.away.id;

    const numericTeamId = Number(teamId);

    const isHome =
      homeId !== null &&
      Number(homeId) === numericTeamId;

    const isAway =
      awayId !== null &&
      Number(awayId) === numericTeamId;

    if (!isHome && !isAway) continue;

    const scoreHome = num(
      raw.score?.home ??
        raw.homeScore ??
        raw.goals?.home
    );

    const scoreAway = num(
      raw.score?.away ??
        raw.awayScore ??
        raw.goals?.away
    );

    if (
      scoreHome === null ||
      scoreAway === null
    ) {
      continue;
    }

    let points = 0;

    if (scoreHome === scoreAway) {
      points = 1;
    } else if (
      (isHome && scoreHome > scoreAway) ||
      (isAway && scoreAway > scoreHome)
    ) {
      points = 3;
    }

    normalized.push({
      date: event.date,
      points,
      goalsFor: isHome
        ? scoreHome
        : scoreAway,
      goalsAgainst: isHome
        ? scoreAway
        : scoreHome
    });
  }

  const lastFive = normalized
    .sort((a, b) => {
      const da = getDate(a.date)?.getTime() || 0;
      const db = getDate(b.date)?.getTime() || 0;

      return db - da;
    })
    .slice(0, 5);

  if (!lastFive.length) {
    return {
      available: false,
      matches: [],
      points: null,
      goalsFor: null,
      goalsAgainst: null
    };
  }

  return {
    available: true,
    matches: lastFive,
    points: lastFive.reduce(
      (sum, m) => sum + m.points,
      0
    ),
    goalsFor: lastFive.reduce(
      (sum, m) => sum + m.goalsFor,
      0
    ),
    goalsAgainst: lastFive.reduce(
      (sum, m) => sum + m.goalsAgainst,
      0
    )
  };
}

async function getTeamForm(teamId) {
  if (!teamId) return null;

  const key = `form:${teamId}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safeBsd(
    `/teams/${teamId}/matches?limit=5`
  );

  return cacheSet(
    key,
    parseForm(data, teamId)
  );
}

async function getReferee(refereeId) {
  if (!refereeId) return null;

  const key = `ref:${refereeId}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safeBsd(
    `/referees/${refereeId}`
  );

  return cacheSet(
    key,
    parseReferee(data)
  );
}

async function getOddsFeed(eventId) {
  const key = `odds:${eventId}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safeBsd(
    `/odds?event_id=${encodeURIComponent(eventId)}`
  );

  return cacheSet(key, data);
}

async function getEventDetails(id) {
  const [prediction, odds, stats, lineups, h2h] =
    await Promise.all([
      safeBsd(`/events/${id}/prediction`),
      safeBsd(`/events/${id}/odds`),
      safeBsd(`/events/${id}/stats`),
      safeBsd(`/events/${id}/lineups`),
      safeBsd(`/events/${id}/h2h`)
    ]);

  return {
    prediction,
    odds,
    stats,
    lineups,
    h2h
  };
}

function marketProbability(
  prediction,
  key
) {
  switch (key) {
    case "HOME":
      return prediction.home;

    case "DRAW":
      return prediction.draw;

    case "AWAY":
      return prediction.away;

    case "DC1X":
      if (
        prediction.home !== null &&
        prediction.draw !== null
      ) {
        return prediction.home + prediction.draw;
      }
      return null;

    case "DCX2":
      if (
        prediction.draw !== null &&
        prediction.away !== null
      ) {
        return prediction.draw + prediction.away;
      }
      return null;

    case "OVER15":
      return prediction.over15;

    case "OVER25":
      return prediction.over25;

    case "UNDER25":
      return prediction.under25;

    case "UNDER35":
      return prediction.under35;

    case "BTTS":
      return prediction.btts;

    default:
      return null;
  }
}

function marketOdds(markets, key) {
  if (key === "BTTS") {
    return bestCurrentOdds(
      markets,
      "BTTS_YES"
    );
  }

  return bestCurrentOdds(
    markets,
    key
  );
}

function scoreCandidate({
  probability,
  edge,
  movement,
  prediction,
  formHome,
  formAway,
  lineups,
  referee
}) {
  let score = 50;

  if (probability >= 75) score += 18;
  else if (probability >= 70) score += 14;
  else if (probability >= 65) score += 10;
  else if (probability >= 60) score += 5;

  if (edge >= 8) score += 12;
  else if (edge >= 5) score += 9;
  else if (edge >= 3) score += 5;
  else if (edge >= 2) score += 2;

  if (movement === "SHORTENING") {
    score += 8;
  }

  if (movement === "DRIFTING") {
    score -= 30;
  }

  if (
    prediction?.confidence !== null &&
    prediction?.confidence >= 70
  ) {
    score += 5;
  }

  if (
    formHome?.available &&
    formAway?.available
  ) {
    score += 2;
  }

  if (lineups?.available) {
    score += 2;
  }

  if (referee) {
    score += 1;
  }

  return Math.round(
    clamp(score, 0, 100)
  );
}

function buildCandidates({
  prediction,
  markets,
  lineups,
  formHome,
  formAway,
  referee
}) {
  const definitions = [
    ["DC1X", "1X"],
    ["DCX2", "X2"],
    ["OVER15", "Over 1.5"],
    ["UNDER35", "Under 3.5"],
    ["BTTS", "BTTS"],
    ["OVER25", "Over 2.5"],
    ["UNDER25", "Under 2.5"],
    ["HOME", "Home"],
    ["AWAY", "Away"],
    ["DRAW", "Draw"]
  ];

  const candidates = [];

  for (const [key, label] of definitions) {
    const probability =
      marketProbability(
        prediction,
        key
      );

    const odds =
      marketOdds(
        markets,
        key
      );

    if (
      probability === null ||
      odds === null
    ) {
      continue;
    }

    const edge =
      edgePercent(
        probability,
        odds
      );

    if (edge === null) continue;

    const movement =
      movementFor(
        markets,
        key === "BTTS"
          ? "BTTS_YES"
          : key
      );

    const score =
      scoreCandidate({
        probability,
        edge,
        movement:
          movement.movement,
        prediction,
        formHome,
        formAway,
        lineups,
        referee
      });

    candidates.push({
      key,
      label,
      probability: Number(
        probability.toFixed(2)
      ),
      odds: Number(
        odds.toFixed(3)
      ),
      impliedProbability: Number(
        impliedProbability(odds).toFixed(2)
      ),
      edge: Number(
        edge.toFixed(2)
      ),
      score,
      marketMovement: movement
    });
  }

  return candidates;
}

function classifyCandidate(candidate) {
  const reasons = [];
  const warnings = [];

  if (
    candidate.marketMovement.movement ===
    "DRIFTING"
  ) {
    reasons.push(
      "Odrzucono: agregowany rynek driftuje."
    );

    return {
      ...candidate,
      classification: "REJECT",
      reasons,
      warnings
    };
  }

  if (
    candidate.probability <
    MIN_PROBABILITY
  ) {
    reasons.push(
      `Probability < ${MIN_PROBABILITY}%`
    );
  }

  if (
    candidate.edge <
    MIN_EDGE
  ) {
    reasons.push(
      `Edge < ${MIN_EDGE}%`
    );
  }

  if (
    candidate.score <
    MIN_SCORE
  ) {
    reasons.push(
      `Score < ${MIN_SCORE}`
    );
  }

  if (
    candidate.marketMovement.movement ===
    "UNKNOWN"
  ) {
    warnings.push(
      "Brak wystarczających danych o ruchu kursu."
    );
  }

  if (reasons.length) {
    return {
      ...candidate,
      classification: "REJECT",
      reasons,
      warnings
    };
  }

  if (
    candidate.marketMovement.movement ===
    "SHORTENING"
  ) {
    reasons.push(
      "Kurs skraca się na agregowanym rynku."
    );
  }

  return {
    ...candidate,
    classification: "QUALIFIED",
    reasons,
    warnings
  };
}

async function analyzeEvent(event) {
  const details =
    await getEventDetails(
      event.id
    );

  const prediction =
    parsePrediction(
      details.prediction
    );

  if (!prediction) {
    return {
      event,
      status: "REJECT",
      reason: "NO_PREDICTION"
    };
  }

  const markets =
    extractOdds(
      details.odds
    );

  const hasAnyOdds =
    Object.values(markets)
      .some(
        (rows) =>
          Array.isArray(rows) &&
          rows.length
      );

  if (!hasAnyOdds) {
    return {
      event,
      status: "REJECT",
      reason: "NO_RECOGNIZED_ODDS"
    };
  }

  const lineups =
    parseLineups(
      details.lineups
    );

  const refereeId =
    details.referee?.id ??
    details.stats?.referee?.id ??
    event.raw?.referee?.id ??
    null;

  const [formHome, formAway, referee, oddsFeed] =
    await Promise.all([
      getTeamForm(event.home.id),
      getTeamForm(event.away.id),
      getReferee(refereeId),
      getOddsFeed(event.id)
    ]);

  if (oddsFeed) {
    const feedMarkets =
      extractOdds(
        oddsFeed
      );

    for (const key of Object.keys(feedMarkets)) {
      if (
        feedMarkets[key].length
      ) {
        markets[key] = [
          ...markets[key],
          ...feedMarkets[key]
        ];
      }
    }
  }

  const candidates =
    buildCandidates({
      prediction,
      markets,
      lineups,
      formHome,
      formAway,
      referee
    }).map(
      classifyCandidate
    );

  const qualified =
    candidates.filter(
      (candidate) =>
        candidate.classification ===
        "QUALIFIED"
    );

  return {
    event,
    status:
      qualified.length
        ? "QUALIFIED"
        : "REJECT",
    prediction,
    lineups,
    form: {
      home: formHome,
      away: formAway
    },
    referee,
    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      signalUsed: false,
      message:
        "Brak zweryfikowanego feedu betting exchange. Nie generuję danych giełdowych."
    },
    candidates,
    qualified
  };
}

async function getEvents(date) {
  const paths = [
    `/events?date=${encodeURIComponent(
      date
    )}`,
    `/fixtures?date=${encodeURIComponent(
      date
    )}`,
    `/matches?date=${encodeURIComponent(
      date
    )}`
  ];

  for (const path of paths) {
    const data =
      await safeBsd(path);

    const events =
      unwrapCollection(data)
        .map(normalizeEvent)
        .filter(Boolean);

    if (events.length) {
      return events;
    }
  }

  return [];
}

function selectInitialEvents(events) {
  return events
    .filter(
      (event) =>
        event.status ===
        "notstarted"
    )
    .sort((a, b) => {
      const da =
        getDate(a.date)?.getTime() ||
        Number.MAX_SAFE_INTEGER;

      const db =
        getDate(b.date)?.getTime() ||
        Number.MAX_SAFE_INTEGER;

      return da - db;
    });
}

async function scan(date) {
  const allEvents =
    await getEvents(date);

  const upcoming =
    selectInitialEvents(
      allEvents
    );

  const selected =
    upcoming.slice(
      0,
      MAX_SCAN_EVENTS
    );

  const results = [];

  const BATCH_SIZE = 5;

  for (
    let i = 0;
    i < selected.length;
    i += BATCH_SIZE
  ) {
    const batch =
      selected.slice(
        i,
        i + BATCH_SIZE
      );

    const analyzed =
      await Promise.all(
        batch.map(
          (event) =>
            analyzeEvent(event)
              .catch((error) => ({
                event,
                status: "ERROR",
                reason:
                  error?.code ||
                  error?.message ||
                  "ANALYZE_ERROR"
              }))
        )
      );

    results.push(...analyzed);
  }

  const picks = [];

  for (const result of results) {
    for (const candidate of arr(
      result.qualified
    )) {
      picks.push({
        ...candidate,
        event: result.event,
        exchange:
          result.exchange
      });
    }
  }

  picks.sort(
    (a, b) =>
      b.score - a.score ||
      b.edge - a.edge ||
      b.probability -
        a.probability
  );

  const finalPicks = [];
  const usedEvents =
    new Set();

  for (const pick of picks) {
    if (
      finalPicks.length >=
      MAX_PICKS
    ) {
      break;
    }

    const eventId =
      String(
        pick.event.id
      );

    if (
      usedEvents.has(
        eventId
      )
    ) {
      continue;
    }

    usedEvents.add(eventId);
    finalPicks.push(pick);
  }

  const rejected =
    results.filter(
      (result) =>
        result.status ===
          "REJECT" ||
        result.status ===
          "ERROR"
    );

  return {
    source: SOURCE,
    version: VERSION,
    date,
    generatedAt: nowIso(),
    scannedEvents:
      selected.length,
    analyzedEvents:
      results.length,
    qualifiedEvents:
      finalPicks.length,
    picks: finalPicks,
    diagnostics: {
      rejectedEvents:
        rejected.length,
      reasons:
        rejected.reduce(
          (acc, item) => {
            const reason =
              item.reason ||
              "NO_QUALIFIED_PICK";

            acc[reason] =
              (acc[reason] ||
                0) + 1;

            return acc;
          },
          {}
        )
    },
    exchange: {
      connected: false,
      status: "NOT_CONNECTED",
      message:
        "Betting exchange nie jest podłączony. Dane giełdowe nie są fabrykowane."
    }
  };
}

function runSelfTests() {
  const tests = [];

  tests.push({
    name: "pct_decimal",
    pass: pct(0.72) === 72
  });

  tests.push({
    name: "pct_percent",
    pass: pct(72) === 72
  });

  tests.push({
    name: "edge_60_at_2",
    pass:
      edgePercent(
        60,
        2
      ) === 10
  });

  const shortening =
    aggregateMovement([
      {
        previousOdds: 2,
        odds: 1.8
      },
      {
        previousOdds: 1.9,
        odds: 1.75
      },
      {
        previousOdds: 1.85,
        odds: 1.72
      }
    ]);

  tests.push({
    name: "movement_shortening",
    pass:
      shortening.movement ===
      "SHORTENING"
  });

  const drifting =
    aggregateMovement([
      {
        previousOdds: 1.7,
        odds: 1.85
      },
      {
        previousOdds: 1.8,
        odds: 1.95
      },
      {
        previousOdds: 1.75,
        odds: 1.9
      }
    ]);

  tests.push({
    name: "movement_drifting",
    pass:
      drifting.movement ===
      "DRIFTING"
  });

  const markets = {
    HOME: [
      {
        odds: 2
      },
      {
        odds: 2.1
      }
    ]
  };

  tests.push({
    name: "best_current_odds",
    pass:
      bestCurrentOdds(
        markets,
        "HOME"
      ) === 2.1
  });

  const dcPrediction = {
    home: 55,
    draw: 25,
    away: 20
  };

  tests.push({
    name: "double_chance_math",
    pass:
      marketProbability(
        dcPrediction,
        "DC1X"
      ) === 80 &&
      marketProbability(
        dcPrediction,
        "DCX2"
      ) === 45
  });

  const rejectedDrift =
    classifyCandidate({
      key: "HOME",
      label: "Home",
      probability: 80,
      odds: 2,
      impliedProbability: 50,
      edge: 30,
      score: 95,
      marketMovement: {
        movement: "DRIFTING",
        previousOdds: null,
        currentOdds: 2,
        changePercent: 4,
        samples: 3,
        confidence: 80
      }
    });

  tests.push({
    name: "drift_without_previous_odds_rejected",
    pass:
      rejectedDrift.classification ===
      "REJECT"
  });

  const exchange = {
    connected: false,
    status: "NOT_CONNECTED",
    signalUsed: false
  };

  tests.push({
    name: "exchange_not_fabricated",
    pass:
      exchange.connected === false &&
      exchange.status ===
        "NOT_CONNECTED" &&
      exchange.signalUsed === false
  });

  const passed =
    tests.filter(
      (test) => test.pass
    ).length;

  return {
    version: VERSION,
    passed,
    total: tests.length,
    ok:
      passed ===
      tests.length,
    tests
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service:
      "Bet Analyzer Backend",
    version: VERSION,
    source: SOURCE,
    time: nowIso()
  });
});

app.get(
  ["/health", "/api/health"],
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      bsdConfigured:
        Boolean(BSD_API_KEY),
      exchange: {
        connected: false,
        status: "NOT_CONNECTED"
      },
      time: nowIso()
    });
  }
);

app.get(
  "/api/self-test",
  (req, res) => {
    const result =
      runSelfTests();

    res.status(
      result.ok ? 200 : 500
    ).json(result);
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

      const events =
        await getEvents(
          date
        );

      res.json({
        source: SOURCE,
        version: VERSION,
        date,
        count:
          events.length,
        events
      });
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        error:
          error?.code ||
          error?.message ||
          "EVENTS_ERROR"
      });
    }
  }
);

app.get(
  ["/api/events/live", "/api/live"],
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const events =
        await getEvents(
          date
        );

      const live =
        events.filter(
          (event) =>
            event.status ===
            "live"
        );

      res.json({
        source: SOURCE,
        version: VERSION,
        count:
          live.length,
        events: live
      });
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        error:
          error?.code ||
          error?.message ||
          "LIVE_ERROR"
      });
    }
  }
);

app.get(
  "/api/events/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_EVENT_ID"
          });
      }

      const eventData =
        await safeBsd(
          `/events/${id}`
        );

      if (!eventData) {
        return res
          .status(404)
          .json({
            error:
              "EVENT_NOT_FOUND"
          });
      }

      res.json({
        source: SOURCE,
        version: VERSION,
        event:
          normalizeEvent(
            eventData
          ) || eventData
      });
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        error:
          error?.code ||
          error?.message ||
          "EVENT_ERROR"
      });
    }
  }
);

const detailRoutes = [
  "prediction",
  "odds",
  "stats",
  "lineups",
  "h2h",
  "incidents"
];

for (const route of detailRoutes) {
  app.get(
    `/api/events/:id/${route}`,
    async (req, res) => {
      try {
        const id =
          Number(req.params.id);

        if (!Number.isFinite(id)) {
          return res
            .status(400)
            .json({
              error:
                "INVALID_EVENT_ID"
            });
        }

        const data =
          await safeBsd(
            `/events/${id}/${route}`
          );

        if (!data) {
          return res
            .status(404)
            .json({
              error:
                "DATA_NOT_FOUND"
            });
        }

        res.json({
          source: SOURCE,
          version: VERSION,
          eventId: id,
          data
        });
      } catch (error) {
        res.status(
          error?.status || 500
        ).json({
          error:
            error?.code ||
            error?.message ||
            "DETAIL_ERROR"
        });
      }
    }
  );
}

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_EVENT_ID"
          });
      }

      const raw =
        await safeBsd(
          `/events/${id}`
        );

      const event =
        normalizeEvent(raw);

      if (!event) {
        return res
          .status(404)
          .json({
            error:
              "EVENT_NOT_FOUND"
          });
      }

      const result =
        await analyzeEvent(
          event
        );

      res.json({
        source: SOURCE,
        version: VERSION,
        ...result
      });
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        error:
          error?.code ||
          error?.message ||
          "ANALYZE_ERROR"
      });
    }
  }
);

app.get(
  "/api/match/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_EVENT_ID"
          });
      }

      const raw =
        await safeBsd(
          `/events/${id}`
        );

      const event =
        normalizeEvent(raw);

      if (!event) {
        return res
          .status(404)
          .json({
            error:
              "EVENT_NOT_FOUND"
          });
      }

      const result =
        await analyzeEvent(
          event
        );

      res.json({
        source: SOURCE,
        version: VERSION,
        ...result
      });
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        error:
          error?.code ||
          error?.message ||
          "MATCH_ERROR"
      });
    }
  }
);

app.get(
  ["/api/scan", "/api/top-picks"],
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      const result =
        await scan(date);

      res.json(result);
    } catch (error) {
      res.status(
        error?.status || 500
      ).json({
        source: SOURCE,
        version: VERSION,
        error:
          error?.code ||
          error?.message ||
          "SCAN_ERROR"
      });
    }
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      error: "NOT_FOUND",
      path: req.path,
      version: VERSION
    });
  }
);

app.use(
  (error, req, res, next) => {
    console.error(error);

    res.status(500).json({
      error:
        error?.message ||
        "INTERNAL_SERVER_ERROR",
      version: VERSION
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer ${VERSION} listening on port ${PORT}`
    );
  }
);
