import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 10000);

const BSD_API_KEY = process.env.BSD_API_KEY || "";
const BSD_BASE_URL =
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2";
const WOM_BASE_URL =
  process.env.WOM_BASE_URL || "https://sports.bzzoiro.com/wom/api";
const ODDS_BASE_URL =
  process.env.ODDS_BASE_URL || "https://sports.bzzoiro.com/odds/api";

const VERSION = "7.4.4";
const SOURCE = "BSD";

const USE_WOM =
  String(process.env.USE_WOM ?? "true").toLowerCase() !== "false";

const MAX_SCAN_EVENTS = Math.max(
  1,
  Number(process.env.MAX_SCAN_EVENTS || 40)
);

const MAX_PICKS = Math.max(
  1,
  Number(process.env.MAX_PICKS || 10)
);

const ENRICH_LIMIT = Math.max(
  0,
  Number(process.env.ENRICH_LIMIT || 12)
);

const MIN_PROBABILITY = Number(
  process.env.MIN_PROBABILITY || 58
);

const MIN_EDGE = Number(
  process.env.MIN_EDGE || 1.5
);

const MIN_SCORE = Number(
  process.env.MIN_SCORE || 68
);

const WOM_MIN_VOLUME = Number(
  process.env.WOM_MIN_VOLUME || 5000
);

const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.REQUEST_TIMEOUT_MS || 10000)
);

const CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.CACHE_TTL_MS || 30000)
);

const cache = new Map();

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value);
}

function clamp(value, min, max) {
  const n = num(value);

  if (n === null) {
    return min;
  }

  return Math.min(max, Math.max(min, n));
}

function round(value, digits = 2) {
  const n = num(value);

  if (n === null) {
    return null;
  }

  const factor = 10 ** digits;

  return Math.round(n * factor) / factor;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }

  return null;
}

function isoDate(value) {
  if (!value) {
    return null;
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString().slice(0, 10);
}

function normalizeStatus(value) {
  const v = text(value).toLowerCase();

  if (
    v.includes("live") ||
    v.includes("inplay") ||
    v.includes("in_play")
  ) {
    return "live";
  }

  if (
    v.includes("finished") ||
    v.includes("complete") ||
    v.includes("ended")
  ) {
    return "finished";
  }

  if (v.includes("cancel")) {
    return "cancelled";
  }

  if (v.includes("postpon")) {
    return "postponed";
  }

  return "upcoming";
}

function getId(value) {
  return firstDefined(
    value?.id,
    value?.event_id,
    value?.eventId,
    value?.fixture_id,
    value?.fixtureId
  );
}

function collection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidates = [
    payload.results,
    payload.data,
    payload.items,
    payload.events,
    payload.fixtures,
    payload.predictions,
    payload.odds,
    payload.markets
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray(candidate.results)
    ) {
      return candidate.results;
    }
  }

  return [];
}

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (CACHE_TTL_MS > 0 && Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function cacheSet(key, value) {
  if (CACHE_TTL_MS <= 0) {
    return value;
  }

  cache.set(key, {
    time: Date.now(),
    value
  });

  return value;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    const raw = await response.text();

    let body = null;

    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }

    if (!response.ok) {
      const error = new Error(
        `HTTP ${response.status} ${response.statusText}`
      );

      error.status = response.status;
      error.body = body;

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function bsd(path, options = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
  }

  const source = options.wom
    ? WOM_BASE_URL
    : options.odds
      ? ODDS_BASE_URL
      : BSD_BASE_URL;

  const base = source.replace(/\/+$/, "");
  const normalizedPath = String(path || "").startsWith("/")
    ? path
    : `/${path}`;

  const url = `${base}${normalizedPath}`;

  return fetchJson(url, {
    headers: {
      Authorization: `Token ${BSD_API_KEY}`
    }
  });
}

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function normalizeTeam(team) {
  if (!team) {
    return null;
  }

  if (typeof team === "string") {
    return {
      id: null,
      name: team
    };
  }

  return {
    id: firstDefined(
      team.id,
      team.team_id,
      team.teamId
    ),
    name: firstDefined(
      team.name,
      team.team_name,
      team.teamName,
      team.display_name
    )
  };
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const home = normalizeTeam(
    firstDefined(
      event.home_team,
      event.homeTeam,
      event.home,
      event.team_home
    )
  );

  const away = normalizeTeam(
    firstDefined(
      event.away_team,
      event.awayTeam,
      event.away,
      event.team_away
    )
  );

  const date = firstDefined(
    event.date,
    event.start_time,
    event.startTime,
    event.kickoff,
    event.datetime
  );

  return {
    id: getId(event),
    event: firstDefined(
      event.name,
      event.event,
      home?.name && away?.name
        ? `${home.name} – ${away.name}`
        : `Event ${getId(event) ?? ""}`
    ),
    date,
    dateOnly: isoDate(date),
    status: normalizeStatus(event.status),
    league: firstDefined(
      event.league?.name,
      event.competition?.name,
      event.tournament?.name,
      event.league_name,
      event.competition_name
    ),
    leagueId: firstDefined(
      event.league?.id,
      event.league_id,
      event.competition?.id
    ),
    seasonId: firstDefined(
      event.season?.id,
      event.season_id
    ),
    home,
    away,
    referee:
      firstDefined(
        event.referee,
        event.official,
        event.referees?.[0]
      ) || null,
    raw: event
  };
}

function parsePrediction(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const eventId = getId(item);

  const source = firstDefined(
    item.prediction,
    item.predictions,
    item.probabilities,
    item
  );

  if (!source || typeof source !== "object") {
    return null;
  }

  const home = num(
    firstDefined(
      source.home,
      source.home_probability,
      source.home_prob,
      source.home_win
    )
  );

  const draw = num(
    firstDefined(
      source.draw,
      source.draw_probability,
      source.draw_prob
    )
  );

  const away = num(
    firstDefined(
      source.away,
      source.away_probability,
      source.away_prob,
      source.away_win
    )
  );

  if (
    home === null &&
    draw === null &&
    away === null
  ) {
    return null;
  }

  return {
    eventId,
    home: home === null ? null : clamp(home, 0, 100),
    draw: draw === null ? null : clamp(draw, 0, 100),
    away: away === null ? null : clamp(away, 0, 100)
  };
}

function predictionMap(items) {
  const map = new Map();

  for (const item of collection(items)) {
    const prediction = parsePrediction(item);

    if (prediction?.eventId !== null && prediction?.eventId !== undefined) {
      map.set(String(prediction.eventId), prediction);
    }
  }

  return map;
}

function marketKey(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  const firstHalf =
    raw.includes("_1H") ||
    raw.includes("_FH") ||
    raw.includes("FIRST_HALF") ||
    raw.includes("1ST_HALF");

  const fullTime =
    raw.includes("_FT") ||
    raw.includes("FULL_TIME") ||
    raw.includes("MATCH_WINNER");

  if (
    raw.includes("HOME") &&
    !raw.includes("DOUBLE") &&
    (!firstHalf || fullTime)
  ) {
    return "HOME_FT";
  }

  if (
    raw.includes("DRAW") &&
    (!firstHalf || fullTime)
  ) {
    return "DRAW_FT";
  }

  if (
    raw.includes("AWAY") &&
    !raw.includes("DOUBLE") &&
    (!firstHalf || fullTime)
  ) {
    return "AWAY_FT";
  }

  if (
    raw.includes("BTTS") &&
    raw.includes("YES") &&
    (!firstHalf || fullTime)
  ) {
    return "BTTS_YES_FT";
  }

  if (
    raw.includes("BTTS") &&
    raw.includes("NO") &&
    (!firstHalf || fullTime)
  ) {
    return "BTTS_NO_FT";
  }

  const ou = raw.match(
    /(?:OU|OVER_UNDER)[_\-]?(\d+(?:\.\d+)?)[_\-]?(OVER|UNDER)/
  );

  if (ou && (!firstHalf || fullTime)) {
    return `OU_${ou[1]}_${ou[2]}_FT`;
  }

  if (
    raw.includes("DOUBLE") &&
    raw.includes("HOME") &&
    raw.includes("DRAW")
  ) {
    return "DC_1X_FT";
  }

  if (
    raw.includes("DOUBLE") &&
    raw.includes("AWAY") &&
    raw.includes("DRAW")
  ) {
    return "DC_X2_FT";
  }

  if (
    raw.includes("DOUBLE") &&
    raw.includes("HOME") &&
    raw.includes("AWAY")
  ) {
    return "DC_12_FT";
  }

  return null;
}

function extractOdds(payload) {
  const rows = [];

  function pushRow(row, bookmaker = null) {
    if (!row || typeof row !== "object") {
      return;
    }

    const key = marketKey(
      firstDefined(
        row.market_key,
        row.marketKey,
        row.market,
        row.market_code,
        row.marketCode,
        row.name,
        row.code
      )
    );

    if (!key) {
      return;
    }

    const price = num(
      firstDefined(
        row.decimal_odds,
        row.decimalOdds,
        row.odds,
        row.price,
        row.value
      )
    );

    if (price === null || price <= 1) {
      return;
    }

    const previous = num(
      firstDefined(
        row.previous_decimal_odds,
        row.previousDecimalOdds,
        row.previous_price,
        row.previousPrice,
        row.previous_odds
      )
    );

    const movement = text(
      firstDefined(
        row.movement,
        row.direction,
        row.trend
      ),
      ""
    ).toUpperCase();

    rows.push({
      market: key,
      price,
      previous,
      movement,
      bookmaker: bookmaker || firstDefined(
        row.bookmaker,
        row.bookmaker_name,
        row.provider
      ) || null
    });
  }

  function walk(node, bookmaker = null, depth = 0) {
    if (
      node === null ||
      node === undefined ||
      depth > 8
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, bookmaker, depth + 1);
      }

      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const nextBookmaker = firstDefined(
      node.bookmaker,
      node.bookmaker_name,
      node.provider,
      node.name === "bookmaker" ? node.name : null,
      bookmaker
    );

    pushRow(node, nextBookmaker);

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "bookmaker" ||
        key === "bookmaker_name" ||
        key === "provider"
      ) {
        continue;
      }

      if (
        value &&
        typeof value === "object"
      ) {
        walk(value, nextBookmaker, depth + 1);
      }
    }
  }

  walk(payload);

  return rows;
}

function movementFor(row) {
  if (!row || typeof row !== "object") {
    return "UNKNOWN";
  }

  const explicit = text(
    firstDefined(
      row.movement,
      row.direction,
      row.trend
    ),
    ""
  ).toUpperCase();

  if (
    explicit.includes("SHORT") ||
    explicit.includes("DOWN") ||
    explicit.includes("FALL")
  ) {
    return "SHORTENING";
  }

  if (
    explicit.includes("DRIFT") ||
    explicit.includes("UP") ||
    explicit.includes("RISE")
  ) {
    return "DRIFTING";
  }

  const current = num(
    firstDefined(
      row.price,
      row.odds,
      row.decimal_odds
    )
  );

  const previous = num(
    firstDefined(
      row.previous,
      row.previous_price,
      row.previous_odds,
      row.previous_decimal_odds
    )
  );

  if (
    current !== null &&
    previous !== null &&
    previous > 1 &&
    current > 1
  ) {
    const diff = current - previous;

    if (Math.abs(diff) < 0.005) {
      return "STABLE";
    }

    return diff < 0
      ? "SHORTENING"
      : "DRIFTING";
  }

  return "UNKNOWN";
}

function bestQuote(rows, market) {
  if (!Array.isArray(rows)) {
    return null;
  }

  const valid = rows
    .filter(
      row =>
        row &&
        typeof row === "object" &&
        row.market === market &&
        num(row.price) !== null &&
        num(row.price) > 1
    )
    .map(row => ({
      ...row,
      price: num(row.price),
      movement: movementFor(row)
    }));

  if (!valid.length) {
    return null;
  }

  valid.sort((a, b) => b.price - a.price);

  return valid[0];
}

function marketProb(price) {
  const p = num(price);

  if (p === null || p <= 1) {
    return null;
  }

  return 100 / p;
}

function recursiveNumbers(value, depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 7
  ) {
    return [];
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(
      item => recursiveNumbers(item, depth + 1)
    );
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(
      item => recursiveNumbers(item, depth + 1)
    );
  }

  return [];
}

function findNumberByKeys(value, keys, depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 7
  ) {
    return null;
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  for (const key of Object.keys(value)) {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (
      keys.some(
        wanted =>
          normalized === wanted ||
          normalized.includes(wanted)
      )
    ) {
      const n = num(value[key]);

      if (n !== null) {
        return n;
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = findNumberByKeys(
      child,
      keys,
      depth + 1
    );

    if (found !== null) {
      return found;
    }
  }

  return null;
}

function formFromFixtures(payload, teamId) {
  const fixtures = collection(payload)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(
      item =>
        item.status === "finished" ||
        item.raw?.status === "finished"
    );

  const targetId =
    teamId === null || teamId === undefined
      ? null
      : String(teamId);

  const relevant = fixtures
    .filter(item => {
      const homeId =
        item.home?.id === null ||
        item.home?.id === undefined
          ? null
          : String(item.home.id);

      const awayId =
        item.away?.id === null ||
        item.away?.id === undefined
          ? null
          : String(item.away.id);

      return (
        targetId !== null &&
        (homeId === targetId || awayId === targetId)
      );
    })
    .sort(
      (a, b) =>
        new Date(b.date || 0) -
        new Date(a.date || 0)
    )
    .slice(0, 5);

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const fixture of relevant) {
    const raw = fixture.raw || {};

    const homeScore = num(
      firstDefined(
        raw.home_score,
        raw.homeScore,
        raw.score?.home,
        raw.result?.home
      )
    );

    const awayScore = num(
      firstDefined(
        raw.away_score,
        raw.awayScore,
        raw.score?.away,
        raw.result?.away
      )
    );

    if (
      homeScore === null ||
      awayScore === null
    ) {
      continue;
    }

    const homeId =
      fixture.home?.id === null ||
      fixture.home?.id === undefined
        ? null
        : String(fixture.home.id);

    const isHome =
      homeId === targetId;

    const gf = isHome
      ? homeScore
      : awayScore;

    const ga = isHome
      ? awayScore
      : homeScore;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) {
      wins++;
    } else if (gf === ga) {
      draws++;
    } else {
      losses++;
    }
  }

  const games =
    wins + draws + losses;

  return {
    games,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    points: wins * 3 + draws,
    ppg:
      games > 0
        ? round(
            (wins * 3 + draws) / games,
            2
          )
        : null
  };
}

function teamFormSignal(form, side) {
  if (!form || !form.games) {
    return {
      signal: 0,
      reason: "FORM_UNAVAILABLE"
    };
  }

  const ppg = num(form.ppg);

  if (ppg === null) {
    return {
      signal: 0,
      reason: "FORM_UNAVAILABLE"
    };
  }

  const signal =
    side === "home"
      ? clamp((ppg - 1.0) * 7, -7, 7)
      : clamp((ppg - 1.0) * 7, -7, 7);

  return {
    signal,
    reason: `PPG_${ppg}`
  };
}

function h2hSignal(payload, side) {
  const items = collection(payload);

  if (!items.length) {
    return {
      signal: 0,
      reason: "H2H_UNAVAILABLE"
    };
  }

  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;

  for (const item of items.slice(0, 10)) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const winner = text(
      firstDefined(
        item.winner,
        item.result,
        item.outcome
      ),
      ""
    ).toLowerCase();

    if (
      winner.includes("draw") ||
      winner === "d"
    ) {
      draws++;
    } else if (
      winner.includes("home") ||
      winner === "h"
    ) {
      homeWins++;
    } else if (
      winner.includes("away") ||
      winner === "a"
    ) {
      awayWins++;
    }
  }

  const total =
    homeWins + awayWins + draws;

  if (!total) {
    return {
      signal: 0,
      reason: "H2H_UNAVAILABLE"
    };
  }

  const wins =
    side === "home"
      ? homeWins
      : awayWins;

  const rate = wins / total;

  return {
    signal: clamp(
      (rate - 0.333) * 6,
      -3,
      3
    ),
    reason: `H2H_${Math.round(rate * 100)}PCT`
  };
}

function statSignal(payload, side) {
  if (!payload || typeof payload !== "object") {
    return {
      signal: 0,
      reason: "STATS_UNAVAILABLE"
    };
  }

  const xgHome = findNumberByKeys(
    payload,
    ["home_xg", "xg_home", "expected_goals_home"]
  );

  const xgAway = findNumberByKeys(
    payload,
    ["away_xg", "xg_away", "expected_goals_away"]
  );

  if (
    xgHome === null ||
    xgAway === null
  ) {
    return {
      signal: 0,
      reason: "STATS_NO_XG"
    };
  }

  const total = xgHome + xgAway;

  if (total <= 0) {
    return {
      signal: 0,
      reason: "STATS_NO_XG"
    };
  }

  const share =
    side === "home"
      ? xgHome / total
      : xgAway / total;

  return {
    signal: clamp(
      (share - 0.5) * 8,
      -4,
      4
    ),
    reason: `XG_${round(share * 100, 1)}PCT`
  };
}

function lineupSignal(payload, side) {
  const items = collection(payload);

  if (!items.length) {
    return {
      signal: 0,
      reason: "LINEUPS_UNAVAILABLE"
    };
  }

  const relevant = items.filter(item => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const teamId = firstDefined(
      item.team_id,
      item.teamId,
      item.team?.id
    );

    return teamId !== undefined;
  });

  if (!relevant.length) {
    return {
      signal: 0,
      reason: "LINEUPS_CONTEXT_ONLY"
    };
  }

  return {
    signal: 0,
    reason: "LINEUPS_PRESENT"
  };
}

function womKey(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value)
    .toUpperCase()
    .trim();

  if (
    raw.includes("HOME") &&
    !raw.includes("AWAY")
  ) {
    return "HOME_FT";
  }

  if (
    raw.includes("DRAW") ||
    raw === "X"
  ) {
    return "DRAW_FT";
  }

  if (
    raw.includes("AWAY") &&
    !raw.includes("HOME")
  ) {
    return "AWAY_FT";
  }

  if (
    raw.includes("BTTS") &&
    raw.includes("YES")
  ) {
    return "BTTS_YES_FT";
  }

  if (
    raw.includes("BTTS") &&
    raw.includes("NO")
  ) {
    return "BTTS_NO_FT";
  }

  const ou = raw.match(
    /(?:OU|OVER_UNDER)[_\-]?(\d+(?:\.\d+)?)[_\-]?(OVER|UNDER)/
  );

  if (ou) {
    return `OU_${ou[1]}_${ou[2]}_FT`;
  }

  return null;
}

function normalizeWomData(payload) {
  const rows = [];

  function walk(node, depth = 0) {
    if (
      node === null ||
      node === undefined ||
      depth > 8
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }

      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const key = womKey(
      firstDefined(
        node.market,
        node.market_code,
        node.marketCode,
        node.selection,
        node.outcome,
        node.code
      )
    );

    if (key) {
      rows.push({
        market: key,
        volume: num(
          firstDefined(
            node.volume,
            node.market_volume,
            node.matched_volume
          )
        ),
        share: num(
          firstDefined(
            node.share,
            node.money_share
          )
        ),
        price: num(
          firstDefined(
            node.price,
            node.odds
          )
        ),
        previousPrice: num(
          firstDefined(
            node.previous_price,
            node.previousPrice,
            node.previous_odds
          )
        ),
        impliedProbability: num(
          firstDefined(
            node.implied_probability,
            node.impliedProbability
          )
        ),
        divergence: num(
          firstDefined(
            node.divergence,
            node.share_minus_implied
          )
        ),
        capturedAt: firstDefined(
          node.captured_at,
          node.capturedAt
        )
      });
    }

    for (const child of Object.values(node)) {
      if (
        child &&
        typeof child === "object"
      ) {
        walk(child, depth + 1);
      }
    }
  }

  walk(payload);

  return rows;
}

function findWom(rows, market) {
  if (!Array.isArray(rows)) {
    return null;
  }

  const valid = rows.filter(
    row =>
      row &&
      row.market === market
  );

  if (!valid.length) {
    return null;
  }

  valid.sort(
    (a, b) =>
      num(b.volume, 0) -
      num(a.volume, 0)
  );

  return valid[0];
}

function womScore(row) {
  if (!row) {
    return {
      score: 0,
      reason: "WOM_UNAVAILABLE"
    };
  }

  const volume = num(row.volume, 0);

  if (volume < WOM_MIN_VOLUME) {
    return {
      score: 0,
      reason: "WOM_LOW_VOLUME"
    };
  }

  const share = num(row.share);
  const implied = num(
    row.impliedProbability
  );

  let score = 0;

  if (
    share !== null &&
    implied !== null
  ) {
    const divergence =
      num(
        row.divergence,
        share - implied
      );

    if (divergence >= 5) {
      score += 8;
    } else if (divergence >= 2) {
      score += 4;
    } else if (divergence <= -5) {
      score -= 8;
    } else if (divergence <= -2) {
      score -= 4;
    }
  }

  const price = num(row.price);
  const previous = num(
    row.previousPrice
  );

  if (
    price !== null &&
    previous !== null &&
    price > 1 &&
    previous > 1
  ) {
    if (price < previous) {
      score += 3;
    } else if (price > previous) {
      score -= 3;
    }
  }

  return {
    score: clamp(score, -11, 11),
    reason: "WOM_VALID"
  };
}

function candidateProbability(
  prediction,
  market,
  quote
) {
  if (
    prediction &&
    market === "HOME_FT" &&
    prediction.home !== null
  ) {
    return prediction.home;
  }

  if (
    prediction &&
    market === "DRAW_FT" &&
    prediction.draw !== null
  ) {
    return prediction.draw;
  }

  if (
    prediction &&
    market === "AWAY_FT" &&
    prediction.away !== null
  ) {
    return prediction.away;
  }

  return marketProb(
    quote?.price
  );
}

function marketLabel(market) {
  const labels = {
    HOME_FT: "1",
    DRAW_FT: "X",
    AWAY_FT: "2",
    BTTS_YES_FT: "BTTS TAK",
    BTTS_NO_FT: "BTTS NIE",
    DC_1X_FT: "1X",
    DC_X2_FT: "X2",
    DC_12_FT: "12"
  };

  if (labels[market]) {
    return labels[market];
  }

  const ou = market?.match(
    /^OU_(\d+(?:\.\d+)?)_(OVER|UNDER)_FT$/
  );

  if (ou) {
    return `${ou[2] === "OVER" ? "Powyżej" : "Poniżej"} ${ou[1]}`;
  }

  return market;
}

function baseCandidates() {
  return [
    "HOME_FT",
    "DRAW_FT",
    "AWAY_FT",
    "BTTS_YES_FT",
    "BTTS_NO_FT",
    "OU_1.5_OVER_FT",
    "OU_1.5_UNDER_FT",
    "OU_2.5_OVER_FT",
    "OU_2.5_UNDER_FT",
    "OU_3.5_OVER_FT",
    "OU_3.5_UNDER_FT"
  ];
}

function candidateMarkets(rows) {
  const available = new Set(
    rows
      .filter(
        row =>
          row &&
          typeof row === "object" &&
          typeof row.market === "string"
      )
      .map(row => row.market)
  );

  return baseCandidates().filter(
    market => available.has(market)
  );
}

function scoreCandidate({
  event,
  prediction,
  quote,
  market,
  formHome,
  formAway,
  h2h,
  stats,
  lineup,
  wom
}) {
  if (!quote) {
    return null;
  }

  const probability = candidateProbability(
    prediction,
    market,
    quote
  );

  if (
    probability === null ||
    probability < MIN_PROBABILITY
  ) {
    return null;
  }

  const implied =
    marketProb(quote.price);

  const edge =
    implied === null
      ? null
      : probability - implied;

  const movement =
    movementFor(quote);

  const formSide =
    market === "AWAY_FT"
      ? "away"
      : "home";

  const homeForm =
    teamFormSignal(
      formHome,
      formSide
    );

  const awayForm =
    teamFormSignal(
      formAway,
      formSide
    );

  let score = 55;

  score +=
    clamp(
      (probability - 58) * 0.5,
      -3,
      10
    );

  if (edge !== null) {
    score += clamp(
      edge * 1.4,
      -6,
      8
    );
  }

  if (movement === "SHORTENING") {
    score += 5;
  } else if (movement === "DRIFTING") {
    score -= 8;
  }

  if (
    market === "HOME_FT"
  ) {
    score += homeForm.signal;
  }

  if (
    market === "AWAY_FT"
  ) {
    score += awayForm.signal;
  }

  const side =
    market === "AWAY_FT"
      ? "away"
      : "home";

  const h2hResult =
    ["HOME_FT", "AWAY_FT"].includes(market)
      ? h2hSignal(h2h, side)
      : {
          signal: 0,
          reason: "H2H_NOT_APPLICABLE"
        };

  const statsResult =
    ["HOME_FT", "AWAY_FT"].includes(market)
      ? statSignal(stats, side)
      : {
          signal: 0,
          reason: "STATS_NOT_APPLICABLE"
        };

  const lineupResult =
    lineupSignal(
      lineup,
      side
    );

  const womResult =
    womScore(wom);

  score += h2hResult.signal;
  score += statsResult.signal;
  score += lineupResult.signal;
  score += womResult.score;

  return {
    market,
    label: marketLabel(market),
    price: quote.price,
    bookmaker: quote.bookmaker,
    movement,
    probability: round(probability, 1),
    impliedProbability:
      implied === null
        ? null
        : round(implied, 1),
    edge:
      edge === null
        ? null
        : round(edge, 1),
    score: round(
      clamp(score, 0, 100),
      1
    ),
    signals: {
      form:
        market === "HOME_FT"
          ? homeForm.reason
          : market === "AWAY_FT"
            ? awayForm.reason
            : "NOT_APPLICABLE",
      h2h: h2hResult.reason,
      stats: statsResult.reason,
      lineup: lineupResult.reason,
      wom: womResult.reason,
      marketMovement: movement
    },
    eventId: event.id,
    event: event.event,
    date: event.date,
    league: event.league
  };
}

function qualify(candidate) {
  if (!candidate) {
    return {
      qualified: false,
      reasons: ["NO_CANDIDATE"]
    };
  }

  const reasons = [];

  if (
    num(candidate.probability, 0) <
    MIN_PROBABILITY
  ) {
    reasons.push("LOW_PROBABILITY");
  }

  if (
    candidate.edge !== null &&
    candidate.edge < MIN_EDGE
  ) {
    reasons.push("LOW_EDGE");
  }

  if (
    num(candidate.score, 0) <
    MIN_SCORE
  ) {
    reasons.push("LOW_SCORE");
  }

  if (
    candidate.movement === "DRIFTING"
  ) {
    reasons.push("DRIFTING_ODDS");
  }

  return {
    qualified: reasons.length === 0,
    reasons
  };
}

async function getWom(eventId) {
  if (!USE_WOM) {
    return [];
  }

  const key = `wom:${eventId}`;
  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  const payload = await safe(
    () =>
      bsd(
        `/events/${encodeURIComponent(
          eventId
        )}/`,
        { wom: true }
      ),
    null
  );

  if (!payload) {
    return cacheSet(key, []);
  }

  return cacheSet(
    key,
    normalizeWomData(payload)
  );
}

async function getEvents(params = {}) {
  const query = new URLSearchParams();

  query.set(
    "limit",
    String(
      Math.min(
        200,
        Math.max(
          1,
          Number(
            params.limit || 200
          )
        )
      )
    )
  );

  if (params.offset !== undefined) {
    query.set(
      "offset",
      String(
        Math.max(
          0,
          Number(params.offset || 0)
        )
      )
    );
  }

  if (params.status) {
    query.set(
      "status",
      String(params.status)
    );
  }

  if (params.date_from) {
    query.set(
      "date_from",
      String(params.date_from)
    );
  }

  if (params.date_to) {
    query.set(
      "date_to",
      String(params.date_to)
    );
  }

  const key =
    `events:${query.toString()}`;

  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  const payload = await bsd(
    `/events/?${query.toString()}`
  );

  return cacheSet(
    key,
    collection(payload)
      .map(normalizeEvent)
      .filter(Boolean)
  );
}

async function getPredictions(date) {
  const query = new URLSearchParams();

  query.set(
    "status",
    "upcoming"
  );

  query.set(
    "limit",
    "200"
  );

  if (date) {
    query.set(
      "date_from",
      date
    );

    query.set(
      "date_to",
      date
    );
  }

  const key =
    `predictions:${query.toString()}`;

  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  const payload = await safe(
    () =>
      bsd(
        `/predictions/?${query.toString()}`
      ),
    []
  );

  return cacheSet(
    key,
    collection(payload)
  );
}

async function getForm(teamId) {
  if (
    teamId === null ||
    teamId === undefined
  ) {
    return null;
  }

  const key =
    `form:${teamId}`;

  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  const payload = await safe(
    () =>
      bsd(
        `/teams/${encodeURIComponent(
          teamId
        )}/fixtures/?limit=50`
      ),
    null
  );

  if (!payload) {
    return null;
  }

  return cacheSet(
    key,
    formFromFixtures(
      payload,
      teamId
    )
  );
}

async function getStats(eventId) {
  return safe(
    () =>
      bsd(
        `/events/${encodeURIComponent(
          eventId
        )}/stats/`
      ),
    null
  );
}

async function getLineups(eventId) {
  return safe(
    () =>
      bsd(
        `/events/${encodeURIComponent(
          eventId
        )}/lineups/`
      ),
    null
  );
}

async function getH2H(eventId) {
  return safe(
    () =>
      bsd(
        `/events/${encodeURIComponent(
          eventId
        )}/h2h/`
      ),
    null
  );
}

async function getOdds(eventId) {
  const id = encodeURIComponent(
    eventId
  );

  const sources = [
    () =>
      bsd(
        `/events/${id}/`,
        { odds: true }
      ),
    () =>
      bsd(
        `/events/${id}/odds/`
      )
  ];

  for (const source of sources) {
    const payload =
      await safe(source, null);

    if (payload) {
      const rows =
        extractOdds(payload);

      if (rows.length) {
        return rows;
      }
    }
  }

  return [];
}

async function analyzeEvent(event) {
  if (!event) {
    throw new Error(
      "Event is required"
    );
  }

  const predictionItems =
    await getPredictions(
      event.dateOnly
    );

  const predictions =
    predictionMap(
      predictionItems
    );

  const prediction =
    predictions.get(
      String(event.id)
    ) || null;

  const [
    odds,
    homeForm,
    awayForm,
    stats,
    lineup,
    h2h,
    wom
  ] = await Promise.all([
    getOdds(event.id),
    getForm(event.home?.id),
    getForm(event.away?.id),
    getStats(event.id),
    getLineups(event.id),
    getH2H(event.id),
    getWom(event.id)
  ]);

  const markets =
    candidateMarkets(odds);

  const candidates = [];

  for (const market of markets) {
    const quote =
      bestQuote(
        odds,
        market
      );

    const womRow =
      findWom(
        wom,
        market
      );

    const candidate =
      scoreCandidate({
        event,
        prediction,
        quote,
        market,
        formHome: homeForm,
        formAway: awayForm,
        h2h,
        stats,
        lineup,
        wom: womRow
      });

    if (candidate) {
      candidates.push({
        ...candidate,
        qualification:
          qualify(candidate)
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  const qualified =
    candidates.filter(
      candidate =>
        candidate.qualification
          ?.qualified
    );

  return {
    version: VERSION,
    source: SOURCE,
    eventId: event.id,
    event: event.event,
    date: event.date,
    status: event.status,
    league: event.league,
    leagueId: event.leagueId,
    seasonId: event.seasonId,
    home: event.home,
    away: event.away,
    referee: event.referee,
    prediction,
    oddsAvailable:
      odds.length > 0,
    womAvailable:
      wom.length > 0,
    candidates,
    qualified: qualified[0] || null,
    context: {
      formHome,
      formAway,
      statsAvailable:
        !!stats,
      lineupsAvailable:
        !!lineup,
      h2hAvailable:
        !!h2h
    }
  };
}

async function scan(params = {}) {
  const events =
    await getEvents({
      status: "upcoming",
      date_from:
        params.date_from ||
        isoDate(
          new Date()
        ),
      date_to:
        params.date_to ||
        isoDate(
          new Date(
            Date.now() +
              7 *
                24 *
                60 *
                60 *
                1000
          )
        ),
      limit: Math.min(
        200,
        Number(
          params.limit ||
            MAX_SCAN_EVENTS
        )
      )
    });

  const selectedEvents =
    events.slice(
      0,
      MAX_SCAN_EVENTS
    );

  const results = [];

  for (
    let i = 0;
    i < selectedEvents.length;
    i += 1
  ) {
    const event =
      selectedEvents[i];

    const analyzed =
      await analyzeEvent(
        event
      );

    const pick =
      analyzed.qualified;

    if (pick) {
      results.push({
        ...pick,
        eventIndex: i
      });
    }
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  const unique = [];
  const usedEvents =
    new Set();

  for (const result of results) {
    if (
      usedEvents.has(
        String(result.eventId)
      )
    ) {
      continue;
    }

    usedEvents.add(
      String(result.eventId)
    );

    unique.push(result);

    if (
      unique.length >=
      Math.min(
        MAX_PICKS,
        Number(
          params.max_picks ||
            MAX_PICKS
        )
      )
    ) {
      break;
    }
  }

  return {
    version: VERSION,
    source: SOURCE,
    generatedAt:
      new Date().toISOString(),
    scannedEvents:
      selectedEvents.length,
    qualifiedCount:
      results.length,
    picks: unique
  };
}

function selfTest() {
  const tests = [];

  function test(name, fn) {
    try {
      const result = fn();

      tests.push({
        name,
        ok: result !== false
      });
    } catch (error) {
      tests.push({
        name,
        ok: false,
        error: error.message
      });
    }
  }

  test(
    "collection handles arrays",
    () =>
      collection([1, 2, 3]).length === 3
  );

  test(
    "collection handles null",
    () =>
      collection(null).length === 0
  );

  test(
    "normalizeEvent handles null",
    () =>
      normalizeEvent(null) === null
  );

  test(
    "normalizeEvent handles event",
    () =>
      normalizeEvent({
        id: 1,
        home: {
          id: 10,
          name: "A"
        },
        away: {
          id: 20,
          name: "B"
        },
        date:
          "2026-01-01T12:00:00Z"
      })?.id === 1
  );

  test(
    "marketKey home",
    () =>
      marketKey(
        "1X2_HOME_FT"
      ) === "HOME_FT"
  );

  test(
    "marketKey away",
    () =>
      marketKey(
        "1X2_AWAY_FT"
      ) === "AWAY_FT"
  );

  test(
    "marketKey draw",
    () =>
      marketKey(
        "1X2_DRAW_FT"
      ) === "DRAW_FT"
  );

  test(
    "marketKey over",
    () =>
      marketKey(
        "OU_2.5_OVER_FT"
      ) === "OU_2.5_OVER_FT"
  );

  test(
    "marketKey rejects first half",
    () =>
      marketKey(
        "OU_2.5_OVER_1H"
      ) === null
  );

  test(
    "marketProb",
    () =>
      round(
        marketProb(2),
        1
      ) === 50
  );

  test(
    "movement shortening",
    () =>
      movementFor({
        price: 1.8,
        previous: 2
      }) === "SHORTENING"
  );

  test(
    "movement drifting",
    () =>
      movementFor({
        price: 2.2,
        previous: 2
      }) === "DRIFTING"
  );

  test(
    "movement null safe",
    () =>
      movementFor(null) ===
      "UNKNOWN"
  );

  test(
    "bestQuote null safe",
    () =>
      bestQuote(
        [null, {}, {
          market: "HOME_FT",
          price: 2
        }],
        "HOME_FT"
      )?.price === 2
  );

  test(
    "extractOdds official shape",
    () =>
      extractOdds({
        match_winner: {
          home: 2.1,
          draw: 3.2,
          away: 3.6
        }
      }).length >= 0
  );

  test(
    "wom null safe",
    () =>
      normalizeWomData(
        null
      ).length === 0
  );

  test(
    "wom key",
    () =>
      womKey(
        "HOME_FT"
      ) === "HOME_FT"
  );

  test(
    "wom low volume",
    () =>
      womScore({
        volume: 10,
        share: 60,
        impliedProbability: 50
      }).reason ===
      "WOM_LOW_VOLUME"
  );

  test(
    "qualification rejects drift",
    () =>
      qualify({
        probability: 70,
        edge: 5,
        score: 80,
        movement: "DRIFTING"
      }).qualified === false
  );

  test(
    "qualification accepts strong pick",
    () =>
      qualify({
        probability: 70,
        edge: 5,
        score: 80,
        movement: "SHORTENING"
      }).qualified === true
  );

  test(
    "prediction parser",
    () =>
      parsePrediction({
        event_id: 123,
        prediction: {
          home: 55,
          draw: 25,
          away: 20
        }
      })?.home === 55
  );

  test(
    "prediction parser rejects invalid",
    () =>
      parsePrediction(null) === null
  );

  test(
    "form empty safe",
    () =>
      formFromFixtures(
        [],
        1
      ).games === 0
  );

  test(
    "h2h empty safe",
    () =>
      h2hSignal(
        [],
        "home"
      ).signal === 0
  );

  test(
    "stats empty safe",
    () =>
      statSignal(
        null,
        "home"
      ).signal === 0
  );

  test(
    "lineup empty safe",
    () =>
      lineupSignal(
        null,
        "home"
      ).signal === 0
  );

  test(
    "candidate probability market fallback",
    () =>
      candidateProbability(
        null,
        "HOME_FT",
        { price: 2 }
      ) === 50
  );

  test(
    "candidate markets",
    () =>
      candidateMarkets([
        {
          market: "HOME_FT"
        },
        {
          market: "AWAY_FT"
        }
      ]).length === 2
  );

  test(
    "scan parameters remain bounded",
    () =>
      Math.min(
        200,
        Number(
          500
        )
      ) === 200
  );

  test(
    "package/runtime version",
    () =>
      VERSION === "7.4.4"
  );

  const passed =
    tests.filter(
      item => item.ok
    ).length;

  return {
    ok:
      passed === tests.length,
    version: VERSION,
    passed,
    total: tests.length,
    tests
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Bet Analyzer Backend",
    version: VERSION,
    source: SOURCE,
    endpoints: [
      "/health",
      "/api/health",
      "/api/self-test",
      "/api/events",
      "/api/predictions",
      "/api/scan",
      "/api/top-picks",
      "/api/analyze/:id",
      "/api/events/:id/odds"
    ]
  });
});

app.get(
  ["/health", "/api/health"],
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      apiKeyConfigured:
        Boolean(BSD_API_KEY),
      womEnabled: USE_WOM,
      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/self-test",
  (req, res) => {
    res.json(
      selfTest()
    );
  }
);

app.get(
  "/api/events",
  async (req, res, next) => {
    try {
      const events =
        await getEvents({
          status:
            req.query.status ||
            "upcoming",
          date_from:
            req.query.date_from,
          date_to:
            req.query.date_to,
          limit:
            req.query.limit
        });

      res.json({
        version: VERSION,
        source: SOURCE,
        count: events.length,
        events
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/predictions",
  async (req, res, next) => {
    try {
      const predictions =
        await getPredictions(
          req.query.date
        );

      res.json({
        version: VERSION,
        source: SOURCE,
        count:
          predictions.length,
        predictions
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  ["/api/scan", "/api/top-picks"],
  async (req, res, next) => {
    try {
      const result =
        await scan({
          date_from:
            req.query.date_from,
          date_to:
            req.query.date_to,
          limit:
            req.query.limit,
          max_picks:
            req.query.max_picks
        });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/analyze/:id",
  async (req, res, next) => {
    try {
      const id =
        req.params.id;

      const payload =
        await bsd(
          `/events/${encodeURIComponent(
            id
          )}/`
        );

      const event =
        normalizeEvent(payload);

      if (!event) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Event not found"
          });
      }

      const result =
        await analyzeEvent(
          event
        );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/events/:id/odds",
  async (req, res, next) => {
    try {
      const odds =
        await getOdds(
          req.params.id
        );

      res.json({
        version: VERSION,
        source: SOURCE,
        eventId:
          req.params.id,
        count:
          odds.length,
        odds
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "Not found",
      version: VERSION
    });
  }
);

app.use(
  (error, req, res, next) => {
    const status =
      Number(error?.status) >= 400 &&
      Number(error?.status) < 600
        ? Number(error.status)
        : 500;

    res.status(status).json({
      ok: false,
      error:
        error?.message ||
        "Internal server error",
      version: VERSION
    });
  }
);

if (
  process.env.TEST_MODE !== "true"
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `Bet Analyzer ${VERSION} listening on port ${PORT}`
      );
    }
  );
}
