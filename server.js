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
const MAX_SCAN_EVENTS = Math.min(100, Math.max(1, Number(process.env.MAX_SCAN_EVENTS || 40)));
const MAX_PICKS = Math.min(10, Math.max(1, Number(process.env.MAX_PICKS || 10)));
const ENRICH_LIMIT = Math.min(20, Math.max(0, Number(process.env.ENRICH_LIMIT || 12)));
const MIN_PROBABILITY = Number(process.env.MIN_PROBABILITY || 58);
const MIN_EDGE = Number(process.env.MIN_EDGE || 1.5);
const MIN_SCORE = Number(process.env.MIN_SCORE || 68);
const WOM_MIN_VOLUME = Number(process.env.WOM_MIN_VOLUME || 5000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);
const cache = new Map();

const num = (v, d = null) => Number.isFinite(Number(v)) ? Number(v) : d;
const arr = v => Array.isArray(v) ? v : [];
const pct = v => {
  const n = num(v);
  return n === null ? null : Number((n <= 1 ? n * 100 : n).toFixed(4));
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowIso = () => new Date().toISOString();
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
  return p === null || i === null ? null : p - i;
};
const firstObject = (...values) =>
  values.find(v => v && typeof v === "object" && !Array.isArray(v)) || null;
const norm = v => String(v ?? "").toUpperCase().replace(/[\s_-]/g, "");

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
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function bsd(path, { wom = false, odds = false } = {}) {
  if (!BSD_API_KEY) {
    const e = new Error("BSD_API_KEY is not configured");
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
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const e = new Error(`BSD HTTP ${response.status}`);
      e.status = response.status;
      e.code = `BSD_HTTP_${response.status}`;
      e.data = data;
      throw e;
    }

    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const x = new Error("BSD request timeout");
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
    console.error(`[BSD] ${path}`, e.code || e.message);
    return null;
  }
}

function collection(data) {
  if (Array.isArray(data)) return data;

  if (!data || typeof data !== "object") return [];

  for (const key of [
    "results",
    "items",
    "events",
    "matches",
    "fixtures",
    "predictions",
    "odds"
  ]) {
    if (Array.isArray(data[key])) return data[key];
  }

  if (Array.isArray(data.data)) return data.data;

  if (data.data && typeof data.data === "object") {
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

  if (["upcoming", "scheduled", "notstarted", "not_started"].includes(s))
    return "notstarted";

  if (["live", "inplay", "in-play", "in_progress", "inprogress"].includes(s))
    return "live";

  if (["finished", "complete", "completed", "ended"].includes(s))
    return "finished";

  if (["cancelled", "canceled"].includes(s))
    return "cancelled";

  if (s === "postponed")
    return "postponed";

  return "unknown";
}

function normalizeTeam(value, fallback = "") {
  if (typeof value === "string") {
    return { id: null, name: value };
  }

  return {
    id: num(value?.id ?? value?.teamId ?? value?.team_id),
    name: value?.name ?? value?.teamName ?? fallback
  };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  const fixture =
    firstObject(raw.fixture, raw.event, raw.match) || raw;

  const homeValue =
    raw.home_team && typeof raw.home_team === "object"
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
    raw.away_team && typeof raw.away_team === "object"
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
    (raw.home_team_id !== undefined ||
      raw.home_team !== undefined)
  ) {
    home.id = num(raw.home_team_id ?? home.id);
  }

  if (
    away &&
    (raw.away_team_id !== undefined ||
      raw.away_team !== undefined)
  ) {
    away.id = num(raw.away_team_id ?? away.id);
  }

  if (raw.home_team && typeof raw.home_team === "string") {
    home.name = raw.home_team;
  }

  if (raw.away_team && typeof raw.away_team === "string") {
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

  if (id === null) return null;

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
      (typeof raw.league === "string" ? raw.league : null),
    leagueId: num(raw.league?.id ?? raw.leagueId),
    seasonId: num(raw.season?.id ?? raw.seasonId),
    home,
    away,
    referee: firstObject(
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
    p?.fixture?.id ??
    p?.match_id ??
    p?.match?.id
  );
}

function parsePrediction(p) {
  if (!p || typeof p !== "object") return null;

  const root =
    firstObject(
      p.prediction,
      p.predictions,
      p.forecast,
      p.data?.prediction,
      p.data?.predictions
    ) || p;

  const markets =
    firstObject(root.markets, p.markets) || {};

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

async function getPredictionMap(
  date = nowIso().slice(0, 10)
) {
  const key = `predictions:${date}:v7`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const queries = [
    `/predictions/?upcoming=true&limit=200`,
    `/predictions/?date_from=${encodeURIComponent(
      date
    )}&date_to=${encodeURIComponent(date)}&limit=200`
  ];

  const map = new Map();

  for (const path of queries) {
    const data = await safe(path);

    for (const row of collection(data)) {
      const id = predictionEventId(row);
      const prediction = parsePrediction(row);

      if (id !== null && prediction) {
        map.set(id, prediction);
      }
    }

    if (
      map.size > 0 &&
      path.includes("upcoming=true")
    ) {
      break;
    }
  }

  /*
   * FALLBACK:
   * Jeżeli zbiorczy endpoint predictions nie zwróci
   * użytecznych rekordów, spraw
