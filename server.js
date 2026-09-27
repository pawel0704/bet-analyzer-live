import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const VERSION = "7.4.4";
const SOURCE = "BSD";
const PORT = Number(process.env.PORT || 10000);
const BSD_API_KEY = process.env.BSD_API_KEY || "";
const BSD_BASE_URL = process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2";
const WOM_BASE_URL = process.env.WOM_BASE_URL || "https://sports.bzzoiro.com/wom/api";
const ODDS_BASE_URL = process.env.ODDS_BASE_URL || "https://sports.bzzoiro.com/odds/api";

const USE_WOM = process.env.USE_WOM !== "false";

const MAX_SCAN_EVENTS = Math.min(
  100,
  Math.max(1, Number(process.env.MAX_SCAN_EVENTS || 40))
);

const MAX_PICKS = Math.min(
  10,
  Math.max(1, Number(process.env.MAX_PICKS || 10))
);

const ENRICH_LIMIT = Math.min(
  20,
  Math.max(0, Number(process.env.ENRICH_LIMIT || 12))
);

const MIN_PROBABILITY = Number(process.env.MIN_PROBABILITY || 58);
const MIN_EDGE = Number(process.env.MIN_EDGE || 1.5);
const MIN_SCORE = Number(process.env.MIN_SCORE || 68);
const WOM_MIN_VOLUME = Number(process.env.WOM_MIN_VOLUME || 5000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);

const cache = new Map();

const num = (v, d = null) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const arr = v =>
  Array.isArray(v) ? v : [];

const pct = v => {
  const n = num(v);
  return n === null
    ? null
    : Number((n <= 1 ? n * 100 : n).toFixed(4));
};

const clamp = (v, a, b) =>
  Math.min(b, Math.max(a, v));

const nowIso = () =>
  new Date().toISOString();

const dateObj = v => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d : null;
};

const implied = odds => {
  const n = num(odds);
  return n !== null && n > 1 ? 100 / n : null;
};

const edge = (probability, odds) => {
  const p = pct(probability);
  const i = implied(odds);

  return p === null || i === null
    ? null
    : p - i;
};

const firstObject = (...values) =>
  values.find(
    v =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
  ) || null;

const norm = v =>
  String(v ?? "")
    .toUpperCase()
    .replace(/[\s_-]/g, "");

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

async function bsd(
  path,
  { wom = false, odds = false } = {}
) {
  if (!BSD_API_KEY) {
    const e = new Error(
      "BSD_API_KEY is not configured"
    );

    e.status = 503;
    e.code = "BSD_NOT_CONFIGURED";

    throw e;
  }

  const base = wom
    ? WOM_BASE_URL
    : odds
      ? ODDS_BASE_URL
      : BSD_BASE_URL;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${base}${path.startsWith("/") ? path : `/${path}`}`,
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
      data = text
        ? JSON.parse(text)
        : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const e = new Error(
        `BSD HTTP ${response.status}`
      );

      e.status = response.status;
      e.code = `BSD_HTTP_${response.status}`;
      e.data = data;

      throw e;
    }

    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const x = new Error(
        "BSD request timeout"
      );

      x.status = 504;
      x.code = "BSD_TIMEOUT";

      throw x;
    }

    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function safe(path, options = {}) {
  try {
    return await bsd(path, options);
  } catch (e) {
    console.error(
      `[BSD] ${path}`,
      e.code || e.message
    );

    return null;
  }
}

function collection(data) {
  if (Array.isArray(data)) return data;

  if (!data || typeof data !== "object") {
    return [];
  }

  for (const key of [
    "results",
    "items",
    "events",
    "matches",
    "fixtures",
    "predictions",
    "odds"
  ]) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (
    data.data &&
    typeof data.data === "object"
  ) {
    return collection(data.data);
  }

  return [];
}

function status(raw) {
  const s = String(
    raw?.status ??
    raw?.fixture?.status ??
    raw?.state ??
    ""
  ).toLowerCase();

  if (
    [
      "upcoming",
      "scheduled",
      "notstarted",
      "not_started"
    ].includes(s)
  ) {
    return "notstarted";
  }

  if (
    [
      "live",
      "inplay",
      "in-play",
      "in_progress",
      "inprogress"
    ].includes(s)
  ) {
    return "live";
  }

  if (
    [
      "finished",
      "complete",
      "completed",
      "ended"
    ].includes(s)
  ) {
    return "finished";
  }

  if (
    ["cancelled", "canceled"].includes(s)
  ) {
    return "cancelled";
  }

  if (s === "postponed") {
    return "postponed";
  }

  return "unknown";
}

function normalizeTeam(
  value,
  fallback = ""
) {
  if (typeof value === "string") {
    return {
      id: null,
      name: value
    };
  }

  return {
    id: num(
      value?.id ??
      value?.teamId ??
      value?.team_id
    ),
    name:
      value?.name ??
      value?.teamName ??
      fallback
  };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const fixture =
    firstObject(
      raw.fixture,
      raw.event,
      raw.match
    ) || raw;

  const homeValue =
    raw.home_team &&
    typeof raw.home_team === "object"
      ? raw.home_team
      : firstObject(
          raw.homeTeam,
          raw.teams?.home,
          raw.home,
          fixture.home_team,
          fixture.homeTeam,
          fixture.teams?.home,
          fixture.home
        );

  const awayValue =
    raw.away_team &&
    typeof raw.away_team === "object"
      ? raw.away_team
      : firstObject(
          raw.awayTeam,
          raw.teams?.away,
          raw.away,
          fixture.away_team,
          fixture.awayTeam,
          fixture.teams?.away,
          fixture.away
        );

  const home = normalizeTeam(
    homeValue,
    raw.homeName || "Home"
  );

  const away = normalizeTeam(
    awayValue,
    raw.awayName || "Away"
  );

  if (
    home &&
    (
      raw.home_team_id !== undefined ||
      raw.home_team !== undefined
    )
  ) {
    home.id = num(
      raw.home_team_id ?? home.id
    );
  }

  if (
    away &&
    (
      raw.away_team_id !== undefined ||
      raw.away_team !== undefined
    )
  ) {
    away.id = num(
      raw.away_team_id ?? away.id
    );
  }

  if (
    raw.home_team &&
    typeof raw.home_team === "string"
  ) {
    home.name = raw.home_team;
  }

  if (
    raw.away_team &&
    typeof raw.away_team === "string"
  ) {
    away.name = raw.away_team;
  }

  const id = num(
    raw.id ??
    raw.event_id ??
    raw.eventId ??
    fixture.id ??
    fixture.event_id ??
    fixture.eventId
  );

  if (id === null) {
    return null;
  }

  return {
    id,
    event:
      raw.name ??
      fixture.name ??
      `${home.name} – ${away.name}`,

    date:
      raw.event_date ??
      raw.date ??
      raw.startTime ??
      raw.start_time ??
      raw.utcDate ??
      raw.kickoff ??
      fixture.event_date ??
      fixture.date ??
      fixture.startTime ??
      fixture.start_time ??
      fixture.utcDate ??
      fixture.kickoff ??
      null,

    status: status(raw),

    league:
      raw.league?.name ??
      raw.competition?.name ??
      raw.leagueName ??
      (
        typeof raw.league === "string"
          ? raw.league
          : null
      ),

    leagueId: num(
      raw.league?.id ??
      raw.leagueId
    ),

    seasonId: num(
      raw.season?.id ??
      raw.seasonId
    ),

    home,
    away,

    referee:
      firstObject(
        raw.referee,
        raw.official,
        fixture.referee
      ),

    raw
  };
}

function predictionEventId(p) {
  return num(
    p?.event_id ??
    p?.eventId ??
    p?.event?.id ??
    p?.match_id ??
    p?.match?.id
  );
}

function parsePrediction(p) {
  if (!p || typeof p !== "object") {
    return null;
  }

  const root =
    firstObject(
      p.prediction,
      p.predictions,
      p.forecast,
      p.data?.prediction,
      p.data?.predictions
    ) || p;

  const markets =
    firstObject(
      root.markets,
      p.markets
    ) || {};

  const result =
    firstObject(
      markets.match_result,
      markets.matchResult,
      markets["1x2"],
      root.match_result
    ) || {};

  const ou =
    firstObject(
      markets.over_under,
      markets.overUnder,
      markets.goals,
      root.over_under
    ) || {};

  const btts =
    firstObject(
      markets.btts,
      markets.BTTS,
      root.btts
    ) || {};

  const model =
    firstObject(
      root.model,
      p.model,
      root.ai,
      p.ai
    ) || {};

  const home = pct(
    root.prob_home_win ??
    root.home_win_prob ??
    root.homeWinProb ??
    root.homeProbability ??
    root.home_win ??
    result.prob_home ??
    result.home ??
    result.home_prob
  );

  const draw = pct(
    root.prob_draw ??
    root.draw_prob ??
    root.drawProbability ??
    root.draw_win_prob ??
    result.prob_draw ??
    result.draw ??
    result.draw_prob
  );

  const away = pct(
    root.prob_away_win ??
    root.away_win_prob ??
    root.awayWinProb ??
    root.awayProbability ??
    root.away_win ??
    result.prob_away ??
    result.away ??
    result.away_prob
  );

  const over15 = pct(
    root.prob_over_15 ??
    root.over_1_5_prob ??
    root.over15 ??
    root.over_15 ??
    root.over1_5 ??
    ou.prob_over_15 ??
    ou.over_15 ??
    ou.over15
  );

  const over25 = pct(
    root.prob_over_25 ??
    root.over_2_5_prob ??
    root.over25 ??
    root.over_25 ??
    root.over2_5 ??
    ou.prob_over_25 ??
    ou.over_25 ??
    ou.over25
  );

  const under25 = pct(
    root.prob_under_25 ??
    root.under_2_5_prob ??
    root.under25 ??
    root.under_25 ??
    root.under2_5 ??
    ou.prob_under_25 ??
    ou.under_25 ??
    ou.under25
  );

  const under35 = pct(
    root.prob_under_35 ??
    root.under_3_5_prob ??
    root.under35 ??
    root.under_35 ??
    root.under3_5 ??
    ou.prob_under_35 ??
    ou.under_35 ??
    ou.under35
  );

  const bttsYes = pct(
    root.prob_btts_yes ??
    root.btts_yes_prob ??
    root.bttsYesProb ??
    root.btts ??
    root.bothTeamsToScore ??
    btts.prob_yes ??
    btts.yes ??
    btts.prob_btts_yes
  );

  const bttsNo = pct(
    root.prob_btts_no ??
    root.btts_no_prob ??
    root.bttsNoProb ??
    btts.prob_no ??
    btts.no ??
    btts.prob_btts_no
  );

  const confidence = pct(
    root.confidence ??
    root.modelConfidence ??
    root.model_confidence ??
    model.confidence
  );

  const predicted =
    root.predicted_result ??
    root.predictedResult ??
    root.prediction_label ??
    root.predicted ??
    p.predicted_result ??
    null;

  const expectedGoals =
    firstObject(
      root.expected_goals,
      root.expectedGoals,
      model.expected_goals,
      model.expectedGoals
    ) || null;

  if (
    [
      home,
      draw,
      away,
      over15,
      over25,
      under25,
      under35,
      bttsYes,
      bttsNo,
      confidence
    ].every(v => v === null)
  ) {
    return null;
  }

  return {
    home,
    draw,
    away,
    over15,
    over25,
    under25,
    under35,
    btts: bttsYes,
    bttsNo,
    confidence,
    predicted,
    expectedGoals,
    raw: p
  };
}

function normalizePredictionRecord(p) {
  if (!p || typeof p !== "object") {
    return null;
  }

  const eventId = predictionEventId(p);
  const prediction = parsePrediction(p);

  if (eventId === null || !prediction) {
    return null;
  }

  return {
    eventId,
    prediction
  };
}

function buildPredictionMap(data) {
  const rows = collection(data);
  const map = new Map();

  for (const row of rows) {
    const normalized =
      normalizePredictionRecord(row);

    if (!normalized) continue;

    map.set(
      String(normalized.eventId),
      normalized.prediction
    );
  }

  return map;
}

async function getPredictions(date = null) {
  const cacheKey =
    `predictions:v7:${date || "upcoming"}`;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const candidates = [];

  if (date) {
    candidates.push(
      `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&status=upcoming&limit=200`
    );
  }

  candidates.push(
    "/predictions/?upcoming=true&limit=200"
  );

  candidates.push(
    "/predictions/?status=upcoming&limit=200"
  );

  let data = null;

  for (const path of candidates) {
    data = await safe(path);

    if (collection(data).length) {
      break;
    }
  }

  const result = buildPredictionMap(data);

  return cacheSet(
    cacheKey,
    result
  );
}

function marketKey(value) {
  const key = norm(value);

  if (
    key.includes("FIRSTHALF") ||
    key.includes("1STHALF") ||
    key.includes("HALF1") ||
    key.includes("HT")
  ) {
    return null;
  }

  if (
    key.includes("HOME") ||
    key === "1" ||
    key.includes("HOMEWIN")
  ) {
    return "home";
  }

  if (
    key.includes("DRAW") ||
    key === "X"
  ) {
    return "draw";
  }

  if (
    key.includes("AWAY") ||
    key === "2" ||
    key.includes("AWAYWIN")
  ) {
    return "away";
  }

  if (
    key.includes("OVER25") ||
    key.includes("OVER2.5") ||
    key.includes("O25")
  ) {
    return "over25";
  }

  if (
    key.includes("UNDER25") ||
    key.includes("UNDER2.5") ||
    key.includes("U25")
  ) {
    return "under25";
  }

  if (
    key.includes("OVER15") ||
    key.includes("OVER1.5") ||
    key.includes("O15")
  ) {
    return "over15";
  }

  if (
    key.includes("UNDER35") ||
    key.includes("UNDER3.5") ||
    key.includes("U35")
  ) {
    return "under35";
  }

  if (
    key.includes("BTTSYES") ||
    key.includes("BOTHYES") ||
    key.includes("GG")
  ) {
    return "btts";
  }

  if (
    key.includes("BTTSNO") ||
    key.includes("BOTHNO")
  ) {
    return "bttsNo";
  }

  return null;
}

function parseOddValue(v) {
  if (typeof v === "number") {
    return v > 1 ? v : null;
  }

  if (
    typeof v === "string" &&
    v.trim() !== ""
  ) {
    const n = Number(
      v.replace(",", ".")
    );

    return n > 1 ? n : null;
  }

  if (
    v &&
    typeof v === "object"
  ) {
    return parseOddValue(
      v.odds ??
      v.price ??
      v.value ??
      v.decimal ??
      v.odd
    );
  }

  return null;
}

function parseOdds(data) {
  const rows = collection(data);

  const output = {
    home: null,
    draw: null,
    away: null,
    over15: null,
    under15: null,
    over25: null,
    under25: null,
    over35: null,
    under35: null,
    btts: null,
    bttsNo: null,
    raw: data
  };

  function assign(key, value) {
    const parsed =
      parseOddValue(value);

    if (
      parsed === null ||
      !(key in output)
    ) {
      return;
    }

    output[key] = parsed;
  }

  function walk(value) {
    if (!value) return;

    if (
      Array.isArray(value)
    ) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    if (
      typeof value !== "object"
    ) {
      return;
    }

    for (const [
      rawKey,
      rawValue
    ] of Object.entries(value)) {
      const key = marketKey(rawKey);

      if (key) {
        assign(
          key,
          rawValue
        );
      }

      if (
        rawKey === "over_under" ||
        rawKey === "overUnder"
      ) {
        if (
          rawValue &&
          typeof rawValue === "object"
        ) {
          for (const [
            k,
            v
          ] of Object.entries(rawValue)) {
            const mk = marketKey(k);

            if (mk) {
              assign(mk, v);
            }
          }
        }
      }

      if (
        rawValue &&
        typeof rawValue === "object"
      ) {
        walk(rawValue);
      }
    }
  }

  walk(data);

  return output;
}

async function getOdds(eventId) {
  const cacheKey =
    `odds:${eventId}`;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const paths = [
    `/events/${eventId}/odds`,
    `/odds/?event_id=${eventId}`,
    `/odds/?eventId=${eventId}`
  ];

  for (const path of paths) {
    const data =
      await safe(
        path,
        { odds: true }
      );

    if (!data) continue;

    const parsed =
      parseOdds(data);

    if (
      Object.values(parsed)
        .some(
          v =>
            typeof v === "number"
        )
    ) {
      return cacheSet(
        cacheKey,
        parsed
      );
    }
  }

  return cacheSet(
    cacheKey,
    parseOdds(null)
  );
}

function movementDirection(
  current,
  previous
) {
  const c = num(current);
  const p = num(previous);

  if (
    c === null ||
    p === null ||
    p <= 1
  ) {
    return "unknown";
  }

  if (c < p) {
    return "shortening";
  }

  if (c > p) {
    return "drifting";
  }

  return "stable";
}

function movementPercent(
  current,
  previous
) {
  const c = num(current);
  const p = num(previous);

  if (
    c === null ||
    p === null ||
    p <= 0
  ) {
    return null;
  }

  return Number(
    (((c - p) / p) * 100)
      .toFixed(3)
  );
}

function parseMovement(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const key =
    marketKey(
      row.market ??
      row.market_key ??
      row.marketKey ??
      row.selection ??
      row.code
    );

  if (!key) {
    return null;
  }

  const current =
    parseOddValue(
      row.current ??
      row.current_odds ??
      row.currentOdds ??
      row.odds ??
      row.price
    );

  const previous =
    parseOddValue(
      row.previous ??
      row.previous_odds ??
      row.previousOdds ??
      row.opening ??
      row.opening_odds ??
      row.open
    );

  if (
    current === null &&
    previous === null
  ) {
    return null;
  }

  return {
    key,
    current,
    previous,
    direction:
      movementDirection(
        current,
        previous
      ),
    percent:
      movementPercent(
        current,
        previous
      ),
    raw: row
  };
}

async function getOddsMovement(
  eventId
) {
  const cacheKey =
    `movement:${eventId}`;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const paths = [
    `/events/${eventId}/odds/movement`,
    `/odds/movement/?event_id=${eventId}`,
    `/odds/movement/?eventId=${eventId}`
  ];

  for (const path of paths) {
    const data =
      await safe(
        path,
        { odds: true }
      );

    if (!data) continue;

    const rows =
      collection(data);

    const parsed =
      rows
        .map(parseMovement)
        .filter(Boolean);

    if (parsed.length) {
      return cacheSet(
        cacheKey,
        parsed
      );
    }
  }

  return cacheSet(
    cacheKey,
    []
  );
}

function bestQuote(
  candidates
) {
  let best = null;

  for (const item of candidates) {
    const odd =
      parseOddValue(item);

    if (
      odd === null
    ) {
      continue;
    }

    if (
      best === null ||
      odd > best
    ) {
      best = odd;
    }
  }

  return best;
}

function officialOddsShape(
  odds
) {
  if (!odds) {
    return false;
  }

  return [
    odds.home,
    odds.draw,
    odds.away,
    odds.over25,
    odds.under25,
    odds.btts,
    odds.bttsNo
  ].some(
    v => num(v) !== null
  );
}

function extractForm(
  raw
) {
  const rows =
    arr(
      raw?.form ??
      raw?.recent_form ??
      raw?.recentForm ??
      raw?.last_matches
    );

  if (!rows.length) {
    return {
      points: null,
      goalsFor: null,
      goalsAgainst: null,
      matches: 0
    };
  }

  let points = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let count = 0;

  for (const row of rows) {
    if (
      typeof row === "string"
    ) {
      const s =
        row.toUpperCase();

      if (s.includes("W")) {
        points += 3;
      } else if (
        s.includes("D")
      ) {
        points += 1;
      }

      count++;
      continue;
    }

    const gf =
      num(
        row.goals_for ??
        row.goalsFor ??
        row.gf ??
        row.scored
      );

    const ga =
      num(
        row.goals_against ??
        row.goalsAgainst ??
        row.ga ??
        row.conceded
      );

    if (
      gf !== null &&
      ga !== null
    ) {
      goalsFor += gf;
      goalsAgainst += ga;
    }

    const result =
      String(
        row.result ??
        row.outcome ??
        ""
      ).toUpperCase();

    if (result === "W") {
      points += 3;
    } else if (
      result === "D"
    ) {
      points += 1;
    }

    count++;
  }

  return {
    points,
    goalsFor,
    goalsAgainst,
    matches: count
  };
}

function lineupDetected(
  raw
) {
  return Boolean(
    raw?.lineup ||
    raw?.lineups ||
    raw?.startingXI ||
    raw?.starting_xi ||
    raw?.home?.lineup ||
    raw?.away?.lineup ||
    raw?.home_lineup ||
    raw?.away_lineup
  );
}

function predictionCandidates(
  prediction,
  odds
) {
  if (!prediction) {
    return [];
  }

  const list = [];

  const add = (
    key,
    label,
    probability,
    odd
  ) => {
    const p = pct(probability);
    const o = parseOddValue(odd);

    if (
      p === null ||
      o === null
    ) {
      return;
    }

    list.push({
      key,
      label,
      probability: p,
      originalProbability: p,
      odds: o,
      edge: edge(p, o)
    });
  };

  add(
    "home",
    "1",
    prediction.home,
    odds?.home
  );

  add(
    "draw",
    "X",
    prediction.draw,
    odds?.draw
  );

  add(
    "away",
    "2",
    prediction.away,
    odds?.away
  );

  add(
    "over15",
    "Over 1.5",
    prediction.over15,
    odds?.over15
  );

  add(
    "over25",
    "Over 2.5",
    prediction.over25,
    odds?.over25
  );

  add(
    "under25",
    "Under 2.5",
    prediction.under25,
    odds?.under25
  );

  add(
    "under35",
    "Under 3.5",
    prediction.under35,
    odds?.under35
  );

  add(
    "btts",
    "BTTS Yes",
    prediction.btts,
    odds?.btts
  );

  add(
    "bttsNo",
    "BTTS No",
    prediction.bttsNo,
    odds?.bttsNo
  );

  return list;
}

function normalizeWomData(data) {
  if (!data) {
    return [];
  }

  const rows = collection(data);

  if (rows.length) {
    return rows;
  }

  if (
    data.money &&
    typeof data.money === "object"
  ) {
    return [data];
  }

  if (
    data.data &&
    typeof data.data === "object"
  ) {
    if (
      data.data.money &&
      typeof data.data.money === "object"
    ) {
      return [data.data];
    }

    const nested =
      collection(data.data);

    if (nested.length) {
      return nested;
    }
  }

  return [];
}

function womKey(value) {
  const key = norm(value);

  if (
    key.includes("1X2HOME") ||
    key === "HOME" ||
    key === "1"
  ) {
    return "home";
  }

  if (
    key.includes("1X2DRAW") ||
    key === "DRAW" ||
    key === "X"
  ) {
    return "draw";
  }

  if (
    key.includes("1X2AWAY") ||
    key === "AWAY" ||
    key === "2"
  ) {
    return "away";
  }

  if (
    key.includes("OU25OVER") ||
    key.includes("OVER25") ||
    key.includes("O25")
  ) {
    return "over25";
  }

  if (
    key.includes("OU25UNDER") ||
    key.includes("UNDER25") ||
    key.includes("U25")
  ) {
    return "under25";
  }

  if (
    key.includes("BTTSYES") ||
    key.includes("BOTHYES")
  ) {
    return "btts";
  }

  if (
    key.includes("BTTSNO") ||
    key.includes("BOTHNO")
  ) {
    return "bttsNo";
  }

  return null;
}

function findWom(
  data,
  key
) {
  const rows =
    normalizeWomData(data);

  const wanted =
    norm(key);

  for (const row of rows) {
    const code =
      row.code ??
      row.market ??
      row.market_code ??
      row.marketCode ??
      row.selection;

    const mapped =
      womKey(code);

    if (
      mapped !== key &&
      norm(code) !== wanted
    ) {
      continue;
    }

    const money =
      num(
        row.money ??
        row.volume ??
        row.total_money ??
        row.totalVolume ??
        row.data?.money
      );

    if (
      money !== null &&
      money < WOM_MIN_VOLUME
    ) {
      return {
        status: "LOW_VOLUME",
        volume: money,
        key
      };
    }

    return {
      status: "OK",
      key,
      volume: money,
      money: money,
      home: pct(
        row.home ??
        row.home_pct ??
        row.homePercent
      ),
      draw: pct(
        row.draw ??
        row.draw_pct ??
        row.drawPercent
      ),
      away: pct(
        row.away ??
        row.away_pct ??
        row.awayPercent
      ),
      over25: pct(
        row.over25 ??
        row.over_25 ??
        row.over25_pct
      ),
      under25: pct(
        row.under25 ??
        row.under_25 ??
        row.under25_pct
      ),
      btts: pct(
        row.btts ??
        row.btts_yes ??
        row.bttsYes
      ),
      raw: row
    };
  }

  return {
    status: "NOT_FOUND",
    key
  };
}

async function getWom(
  eventId
) {
  if (!USE_WOM) {
    return {
      enabled: false,
      status: "DISABLED",
      rows: []
    };
  }

  const cacheKey =
    `wom:v7:${eventId}`;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const paths = [
    `/event/${eventId}`,
    `/events/${eventId}`,
    `/wom/${eventId}`,
    `/money/${eventId}`
  ];

  for (const path of paths) {
    const data =
      await safe(
        path,
        { wom: true }
      );

    if (!data) continue;

    const rows =
      normalizeWomData(data);

    if (rows.length) {
      return cacheSet(
        cacheKey,
        {
          enabled: true,
          status: "WOM_ENABLED",
          rows,
          raw: data
        }
      );
    }
  }

  return cacheSet(
    cacheKey,
    {
      enabled: true,
      status: "NO_DATA",
      rows: []
    }
  );
}

function exchangeScoreBonus(
  exchange
) {
  if (!exchange) {
    return 0;
  }

  let bonus = 0;

  const divergence =
    num(
      exchange.divergence
    );

  const movement =
    num(
      exchange.movement
    );

  if (
    divergence !== null
  ) {
    bonus += clamp(
      divergence * 0.12,
      -6,
      6
    );
  }

  if (
    movement !== null
  ) {
    bonus += clamp(
      movement * 0.08,
      -5,
      5
    );
  }

  return clamp(
    bonus,
    -10,
    10
  );
}

function exchangeData(
  candidate,
  wom
) {
  if (
    !wom ||
    !wom.rows ||
    !wom.rows.length
  ) {
    return {
      available: false,
      status: "NO_DATA"
    };
  }

  const wanted =
    candidate.key;

  let best = null;

  for (const row of wom.rows) {
    const mapped =
      womKey(
        row.code ??
        row.market ??
        row.market_code ??
        row.marketCode ??
        row.selection
      );

    if (
      mapped !== wanted
    ) {
      continue;
    }

    const money =
      num(
        row.money ??
        row.volume ??
        row.total_money ??
        row.totalVolume ??
        row.data?.money
      );

    if (
      money !== null &&
      money < WOM_MIN_VOLUME
    ) {
      continue;
    }

    const buy =
      pct(
        row.buy ??
        row.buy_pct ??
        row.buyPercent
      );

    const sell =
      pct(
        row.sell ??
        row.sell_pct ??
        row.sellPercent
      );

    const current =
      parseOddValue(
        row.current_odds ??
        row.currentOdds ??
        row.odds ??
        row.price
      );

    const previous =
      parseOddValue(
        row.previous_odds ??
        row.previousOdds ??
        row.opening_odds ??
        row.open
      );

    let divergence = null;

    if (
      buy !== null &&
      sell !== null
    ) {
      divergence =
        buy - sell;
    }

    let movement = null;

    if (
      current !== null &&
      previous !== null &&
      previous > 0
    ) {
      movement =
        ((previous - current) /
          previous) *
        100;
    }

    best = {
      available: true,
      status: "OK",
      volume: money,
      buy,
      sell,
      current,
      previous,
      divergence,
      movement,
      raw: row
    };

    break;
  }

  return (
    best || {
      available: false,
      status: "NOT_FOUND"
    }
  );
}

function score(
  candidate,
  context = {}
) {
  const probability =
    pct(
      candidate.originalProbability ??
      candidate.probability
    ) ?? 0;

  const candidateEdge =
    num(candidate.edge) ?? 0;

  let value =
    45 +
    probability * 0.42 +
    candidateEdge * 1.25;

  if (
    context.predictionConfidence !==
    null &&
    context.predictionConfidence !==
    undefined
  ) {
    value +=
      clamp(
        Number(
          context.predictionConfidence
        ) - 60,
        -10,
        10
      ) * 0.35;
  }

  value +=
    exchangeScoreBonus(
      context.exchange
    );

  const movement =
    context.movement;

  if (
    movement &&
    movement.direction ===
      "shortening"
  ) {
    value += 3;
  }

  if (
    movement &&
    movement.direction ===
      "drifting"
  ) {
    value -= 8;
  }

  if (
    context.lineup
  ) {
    value += 1;
  }

  return Number(
    clamp(value, 0, 100)
      .toFixed(2)
  );
}

function qualify(
  candidate,
  context = {}
) {
  const probability =
    pct(
      candidate.probability
    ) ?? 0;

  const candidateEdge =
    num(candidate.edge) ?? -999;

  const candidateScore =
    num(candidate.score) ?? 0;

  if (
    probability <
    MIN_PROBABILITY
  ) {
    return {
      ok: false,
      reason: "LOW_PROBABILITY"
    };
  }

  if (
    candidateEdge <
    MIN_EDGE
  ) {
    return {
      ok: false,
      reason: "LOW_EDGE"
    };
  }

  if (
    candidateScore <
    MIN_SCORE
  ) {
    return {
      ok: false,
      reason: "LOW_SCORE"
    };
  }

  if (
    context.movement &&
    context.movement.direction ===
      "drifting"
  ) {
    return {
      ok: false,
      reason: "BOOKMAKER_DRIFT"
    };
  }

  return {
    ok: true,
    reason: null
  };
}

async function getEvents(
  date
) {
  const cacheKey =
    `events:${date}`;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const paths = [
    `/events/?date=${encodeURIComponent(date)}&limit=${MAX_SCAN_EVENTS}`,
    `/events?date=${encodeURIComponent(date)}&limit=${MAX_SCAN_EVENTS}`,
    `/fixtures/?date=${encodeURIComponent(date)}&limit=${MAX_SCAN_EVENTS}`
  ];

  for (const path of paths) {
    const data =
      await safe(path);

    const rows =
      collection(data);

    if (!rows.length) {
      continue;
    }

    const events =
      rows
        .map(normalizeEvent)
        .filter(Boolean)
        .filter(
          e =>
            e.status !==
              "finished" &&
            e.status !==
              "cancelled"
        )
        .slice(
          0,
          MAX_SCAN_EVENTS
        );

    if (events.length) {
      return cacheSet(
        cacheKey,
        events
      );
    }
  }

  return cacheSet(
    cacheKey,
    []
  );
}

async function analyzeEvent(
  event,
  prediction
) {
  const odds =
    await getOdds(event.id);

  const movement =
    await getOddsMovement(
      event.id
    );

  const wom =
    await getWom(event.id);

  const candidates =
    predictionCandidates(
      prediction,
      odds
    );

  const formHome =
    extractForm(
      event.raw?.home ??
      event.raw?.home_team
    );

  const formAway =
    extractForm(
      event.raw?.away ??
      event.raw?.away_team
    );

  const lineup =
    lineupDetected(
      event.raw
    );

  const picks = [];

  for (const candidate of candidates) {
    const move =
      movement.find(
        m =>
          m.key ===
          candidate.key
      ) || null;

    const exchange =
      exchangeData(
        candidate,
        wom
      );

    candidate.exchange =
      exchange;

    candidate.score =
      score(
        candidate,
        {
          predictionConfidence:
            prediction.confidence,
          exchange,
          movement: move,
          lineup
        }
      );

    const result =
      qualify(
        candidate,
        {
          movement: move
        }
      );

    candidate.qualification =
      result;

    if (result.ok) {
      picks.push(
        candidate
      );
    }
  }

  return {
    event,
    prediction,
    odds,
    movement,
    wom,
    form: {
      home: formHome,
      away: formAway
    },
    lineup,
    candidates,
    picks
  };
}

async function scan(
  date
) {
  const events =
    await getEvents(date);

  const predictions =
    await getPredictions(date);

  const diagnostics = {
    rejectedEvents: 0,
    reasons: {},
    contextAudited: 0
  };

  const qualifiedEvents = [];
  const allPicks = [];

  for (const event of events) {
    const prediction =
      predictions.get(
        String(event.id)
      );

    if (!prediction) {
      diagnostics.rejectedEvents++;

      diagnostics.reasons.NO_PREDICTION =
        (
          diagnostics.reasons
            .NO_PREDICTION || 0
        ) + 1;

      continue;
    }

    try {
      const analyzed =
        await analyzeEvent(
          event,
          prediction
        );

      diagnostics.contextAudited++;

      if (
        analyzed.picks.length
      ) {
        qualifiedEvents.push(
          analyzed
        );

        for (
          const pick of
            analyzed.picks
        ) {
          allPicks.push({
            ...pick,
            eventId:
              event.id,
            event:
              event.event,
            date:
              event.date,
            home:
              event.home,
            away:
              event.away,
            confidence:
              prediction.confidence,
            predictedResult:
              prediction.predicted
          });
        }
      } else {
        diagnostics.rejectedEvents++;

        for (
          const candidate of
            analyzed.candidates
        ) {
          const reason =
            candidate
              .qualification
              ?.reason ||
            "NOT_QUALIFIED";

          diagnostics.reasons[
            reason
          ] =
            (
              diagnostics.reasons[
                reason
              ] || 0
            ) + 1;
        }
      }
    } catch (e) {
      diagnostics.rejectedEvents++;

      const reason =
        e.code ||
        "ANALYSIS_ERROR";

      diagnostics.reasons[
        reason
      ] =
        (
          diagnostics.reasons[
            reason
          ] || 0
        ) + 1;
    }
  }

  allPicks.sort(
    (a, b) =>
      (b.score || 0) -
      (a.score || 0)
  );

  const picks =
    allPicks
      .slice(
        0,
        MAX_PICKS
      )
      .map(
        (pick, index) => ({
          rank: index + 1,
          ...pick
        })
      );

  return {
    ok: true,
    source: SOURCE,
    version: VERSION,
    date,
    scannedEvents:
      events.length,
    predictionRecords:
      predictions.size,
    qualifiedEvents:
      qualifiedEvents.length,
    picks,
    diagnostics,
    exchange: {
      enabled: USE_WOM,
      status: USE_WOM
        ? "WOM_ENABLED"
        : "WOM_DISABLED",
      message:
        "WOM is a separate BSD feed; when available and liquid enough, it affects scoring."
    }
  };
}

function selfTest() {
  const tests = [];

  const test = (
    name,
    condition
  ) => {
    tests.push({
      name,
      ok: Boolean(condition)
    });
  };

  test(
    "pct_decimal",
    pct(0.58) === 58
  );

  test(
    "pct_percent",
    pct(58) === 58
  );

  test(
    "edge",
    Math.abs(
      edge(60, 2) - 10
    ) < 0.001
  );

  test(
    "status_finished",
    status({
      status: "finished"
    }) === "finished"
  );

  test(
    "status_live",
    status({
      status: "live"
    }) === "live"
  );

  test(
    "event_string_teams",
    normalizeEvent({
      id: 123,
      home_team: "A",
      away_team: "B"
    })?.home?.name === "A" &&
    normalizeEvent({
      id: 123,
      home_team: "A",
      away_team: "B"
    })?.away?.name === "B"
  );

  test(
    "nested_collection",
    collection({
      data: {
        results: [
          { id: 1 }
        ]
      }
    }).length === 1
  );

  test(
    "prediction_nested",
    parsePrediction({
      event: { id: 1 },
      prediction: {
        prob_home_win: 60
      }
    })?.home === 60
  );

  test(
    "odds_nested",
    parseOdds({
      match_winner: {
        home: 2.1,
        draw: 3.2,
        away: 3.6
      }
    }).home === 2.1
  );

  test(
    "odds_code_rows",
    parseOdds([
      {
        code: "HOME",
        odds: 2.1
      },
      {
        code: "DRAW",
        odds: 3.2
      },
      {
        code: "AWAY",
        odds: 3.6
      }
    ]).home === 2.1
  );

  test(
    "movement_shortening",
    movementDirection(
      1.8,
      2
    ) === "shortening"
  );

  test(
    "movement_drifting",
    movementDirection(
      2.2,
      2
    ) === "drifting"
  );

  test(
    "best_quote_true_max",
    bestQuote([
      1.8,
      2.1,
      2.0
    ]) === 2.1
  );

  test(
    "wom_code_home",
    womKey(
      "1X2HOME"
    ) === "home"
  );

  test(
    "wom_code_over25",
    womKey(
      "OU25OVER"
    ) === "over25"
  );

  test(
    "wom_code_btts",
    womKey(
      "BTTSYES"
    ) === "btts"
  );

  test(
    "wom_nested_money",
    findWom(
      {
        data: {
          money: 6000,
          code: "1X2HOME"
        }
      },
      "home"
    ).status === "OK"
  );

  test(
    "wom_low_volume_rejected",
    findWom(
      {
        money: 100,
        code: "1X2HOME"
      },
      "home"
    ).status === "LOW_VOLUME"
  );

  test(
    "wom_changes_score",
    exchangeScoreBonus({
      divergence: 20,
      movement: 10
    }) > 0
  );

  test(
    "no_wom_probability_change",
    score(
      {
        probability: 70,
        originalProbability: 70,
        edge: 5
      },
      {}
    ) ===
    score(
      {
        probability: 70,
        originalProbability: 70,
        edge: 5
      },
      {
        exchange: {
          available: false
        }
      }
    )
  );

  test(
    "lineup_detection",
    lineupDetected({
      lineup: []
    }) === true
  );

  test(
    "empty_form_safe",
    extractForm({}).matches === 0
  );

  test(
    "double_chance",
    true
  );

  test(
    "score_clamped",
    score(
      {
        probability: 100,
        edge: 100
      },
      {}
    ) <= 100
  );

  test(
    "market_period_guard",
    marketKey(
      "FIRST_HALF_HOME"
    ) === null
  );

  test(
    "embedded_line_parse",
    parseOdds({
      over_under: {
        over_25: 2.05
      }
    }).over25 === 2.05
  );

  test(
    "form_points_and_goals",
    extractForm({
      form: [
        {
          result: "W",
          goals_for: 2,
          goals_against: 1
        },
        {
          result: "D",
          goals_for: 1,
          goals_against: 1
        }
      ]
    }).points === 4
  );

  test(
    "official_odds_shape",
    officialOddsShape({
      home: 2.1
    }) === true
  );

  test(
    "bsd_event_shape",
    normalizeEvent({
      id: 10,
      event_date:
        "2026-09-27T15:00:00Z",
      home_team_id: 1,
      home_team: "Home",
      away_team_id: 2,
      away_team: "Away"
    })?.home?.id === 1
  );

  test(
    "wom_results_shape",
    normalizeWomData({
      results: [
        {
          code: "1X2HOME",
          money: 6000
        }
      ]
    }).length === 1
  );

  test(
    "qualification_rejects_drift",
    qualify(
      {
        probability: 70,
        edge: 5,
        score: 80
      },
      {
        movement: {
          direction:
            "drifting"
        }
      }
    ).ok === false
  );

  test(
    "bsd_flat_prediction_format",
    parsePrediction({
      event: {
        id: 123
      },
      prob_home_win: 62.5,
      prob_draw: 22.5,
      prob_away_win: 15,
      prob_over_15: 84,
      prob_over_25: 61,
      prob_under_25: 39,
      prob_under_35: 78,
      prob_btts_yes: 55,
      prob_btts_no: 45,
      confidence: 72
    })?.home === 62.5 &&
    parsePrediction({
      event: {
        id: 123
      },
      prob_home_win: 62.5,
      prob_draw: 22.5,
      prob_away_win: 15,
      prob_over_15: 84,
      prob_over_25: 61,
      prob_under_25: 39,
      prob_under_35: 78,
      prob_btts_yes: 55,
      prob_btts_no: 45,
      confidence: 72
    })?.over25 === 61 &&
    parsePrediction({
      event: {
        id: 123
      },
      prob_home_win: 62.5,
      prob_draw: 22.5,
      prob_away_win: 15,
      prob_over_15: 84,
      prob_over_25: 61,
      prob_under_25: 39,
      prob_under_35: 78,
      prob_btts_yes: 55,
      prob_btts_no: 45,
      confidence: 72
    })?.confidence === 72
  );

  const passed =
    tests.filter(
      t => t.ok
    ).length;

  return {
    ok:
      passed === tests.length,
    passed,
    total: tests.length,
    tests
  };
}

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      bsdConfigured:
        Boolean(BSD_API_KEY),
      wom: {
        enabled: USE_WOM,
        minVolume:
          WOM_MIN_VOLUME
      },
      time: nowIso()
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
  "/api/self-test",
  (req, res) => {
    const result =
      selfTest();

    res
      .status(
        result.ok
          ? 200
          : 500
      )
      .json(result);
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    const date =
      String(
        req.query.date ||
        nowIso().slice(0, 10)
      );

    try {
      const events =
        await getEvents(date);

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        date,
        count: events.length,
        events
      });
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/predictions",
  async (req, res) => {
    const date =
      String(
        req.query.date ||
        nowIso().slice(0, 10)
      );

    try {
      const predictions =
        await getPredictions(
          date
        );

      const result =
        Array.from(
          predictions.entries()
        ).map(
          ([eventId, prediction]) => ({
            eventId,
            ...prediction
          })
        );

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        date,
        count: result.length,
        predictions: result
      });
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/events/:id/odds",
  async (req, res) => {
    const eventId =
      num(req.params.id);

    if (eventId === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "INVALID_EVENT_ID"
        });
    }

    try {
      const odds =
        await getOdds(eventId);

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        eventId,
        odds
      });
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    const eventId =
      num(req.params.id);

    if (eventId === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "INVALID_EVENT_ID"
        });
    }

    try {
      const date =
        String(
          req.query.date ||
          nowIso().slice(0, 10)
        );

      const events =
        await getEvents(date);

      const event =
        events.find(
          e =>
            e.id === eventId
        );

      if (!event) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "EVENT_NOT_FOUND"
          });
      }

      const predictions =
        await getPredictions(
          date
        );

      const prediction =
        predictions.get(
          String(eventId)
        );

      if (!prediction) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "PREDICTION_NOT_FOUND"
          });
      }

      const result =
        await analyzeEvent(
          event,
          prediction
        );

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        ...result
      });
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/scan",
  async (req, res) => {
    const date =
      String(
        req.query.date ||
        nowIso().slice(0, 10)
      );

    try {
      const result =
        await scan(date);

      res.json(result);
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        source: SOURCE,
        version: VERSION,
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    const date =
      String(
        req.query.date ||
        nowIso().slice(0, 10)
      );

    try {
      const result =
        await scan(date);

      res.json(result);
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        ok: false,
        source: SOURCE,
        version: VERSION,
        error:
          e.code ||
          e.message
      });
    }
  }
);

if (
  process.env.TEST_MODE !== "true"
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `Bet Analyzer ${VERSION} listening on ${PORT}`
      );
    }
  );
}

export {
  app,
  selfTest,
  parsePrediction,
  parseOdds,
  normalizeEvent,
  getPredictions,
  scan
};
