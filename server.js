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
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

  if (
    ["upcoming", "scheduled", "notstarted", "not_started"].includes(s)
  ) {
    return "notstarted";
  }

  if (
    ["live", "inplay", "in-play", "in_progress", "inprogress"].includes(s)
  ) {
    return "live";
  }

  if (
    ["finished", "complete", "completed", "ended"].includes(s)
  ) {
    return "finished";
  }

  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  if (s === "postponed") return "postponed";

  return "unknown";
}

function normalizeTeam(value, fallback = "") {
  if (typeof value === "string") {
    return {
      id: null,
      name: value
    };
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
      (typeof raw.league === "string"
        ? raw.league
        : null),

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
    root.home_win_prob ??
    root.homeWinProb ??
    root.homeProbability ??
    root.home_win ??
    result.prob_home ??
    result.home ??
    result.home_prob
  );

  const draw = pct(
    root.draw_prob ??
    root.drawProbability ??
    root.draw_win_prob ??
    result.prob_draw ??
    result.draw ??
    result.draw_prob
  );

  const away = pct(
    root.away_win_prob ??
    root.awayWinProb ??
    root.awayProbability ??
    root.away_win ??
    result.prob_away ??
    result.away ??
    result.away_prob
  );

  const over15 = pct(
    root.over_1_5_prob ??
    root.over15 ??
    root.over_15 ??
    root.over1_5 ??
    ou.prob_over_15 ??
    ou.over_15 ??
    ou.over15
  );

  const over25 = pct(
    root.over_2_5_prob ??
    root.over25 ??
    root.over_25 ??
    root.over2_5 ??
    ou.prob_over_25 ??
    ou.over_25 ??
    ou.over25
  );

  const under25 = pct(
    root.under_2_5_prob ??
    root.under25 ??
    root.under_25 ??
    root.under2_5 ??
    ou.prob_under_25 ??
    ou.under_25 ??
    ou.under25
  );

  const under35 = pct(
    root.under_3_5_prob ??
    root.under35 ??
    root.under_35 ??
    root.under3_5 ??
    ou.prob_under_35 ??
    ou.under_35 ??
    ou.under35
  );

  const bttsYes = pct(
    root.btts_yes_prob ??
    root.bttsYesProb ??
    root.btts ??
    root.bothTeamsToScore ??
    btts.prob_yes ??
    btts.yes ??
    btts.prob_btts_yes
  );

  const bttsNo = pct(
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

async function getPredictionMap() {
  const key = "predictions:upcoming:v5";
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safe(
    "/predictions/?upcoming=true&limit=200"
  );

  const map = new Map();

  for (const row of collection(data)) {
    const id = predictionEventId(row);
    const prediction = parsePrediction(row);

    if (id !== null && prediction) {
      map.set(id, prediction);
    }
  }

  return cacheSet(key, map);
}

function marketKey(market, line, selection) {
  const raw = String(market ?? "").toUpperCase().trim();
  const compact = norm(raw);
  const sel = String(selection ?? "").toUpperCase().trim();

  if (
    compact === "1X2HOME" ||
    compact === "1X2HOMEFT" ||
    compact === "MATCHWINNERHOME"
  ) {
    return "HOME";
  }

  if (
    compact === "1X2DRAW" ||
    compact === "1X2DRAWFT" ||
    compact === "MATCHWINNERDRAW"
  ) {
    return "DRAW";
  }

  if (
    compact === "1X2AWAY" ||
    compact === "1X2AWAYFT" ||
    compact === "MATCHWINNERAWAY"
  ) {
    return "AWAY";
  }

  if (
    compact === "OU15OVERFT" ||
    compact === "OU15OVER"
  ) {
    return "OVER15";
  }

  if (
    compact === "OU15UNDERFT" ||
    compact === "OU15UNDER"
  ) {
    return "UNDER15";
  }

  if (
    compact === "OU25OVERFT" ||
    compact === "OU25OVER"
  ) {
    return "OVER25";
  }

  if (
    compact === "OU25UNDERFT" ||
    compact === "OU25UNDER"
  ) {
    return "UNDER25";
  }

  if (
    compact === "OU35UNDERFT" ||
    compact === "OU35UNDER"
  ) {
    return "UNDER35";
  }

  if (
    compact === "BTTSYESFT" ||
    compact === "BTTSYES"
  ) {
    return "BTTS_YES";
  }

  if (
    compact === "BTTSNOFT" ||
    compact === "BTTSNO"
  ) {
    return "BTTS_NO";
  }

  const lineNumber = num(
    line ??
    String(raw).match(/(\d+(?:\.\d+)?)/)?.[1]
  );

  if (
    compact.includes("OU") &&
    lineNumber !== null
  ) {
    if (sel.includes("OVER")) {
      if (lineNumber === 1.5) return "OVER15";
      if (lineNumber === 2.5) return "OVER25";
    }

    if (sel.includes("UNDER")) {
      if (lineNumber === 1.5) return "UNDER15";
      if (lineNumber === 2.5) return "UNDER25";
      if (lineNumber === 3.5) return "UNDER35";
    }
  }

  if (compact.includes("BTTS")) {
    if (
      sel === "YES" ||
      compact.includes("YES")
    ) {
      return "BTTS_YES";
    }

    if (
      sel === "NO" ||
      compact.includes("NO")
    ) {
      return "BTTS_NO";
    }
  }

  return null;
}

function movementFor(rows) {
  const row = arr(rows)[0];

  if (!row) {
    return {
      movement: "UNKNOWN",
      odds: null,
      previousOdds: null
    };
  }

  const odds = num(
    row.odds ??
    row.price ??
    row.decimal_odds
  );

  const previousOdds = num(
    row.previousOdds ??
    row.previousPrice ??
    row.previous_price ??
    row.previous_decimal_odds
  );

  if (
    odds === null ||
    previousOdds === null
  ) {
    return {
      movement: "UNKNOWN",
      odds,
      previousOdds
    };
  }

  if (odds < previousOdds) {
    return {
      movement: "SHORTENING",
      odds,
      previousOdds
    };
  }

  if (odds > previousOdds) {
    return {
      movement: "DRIFTING",
      odds,
      previousOdds
    };
  }

  return {
    movement: "STABLE",
    odds,
    previousOdds
  };
}

function bestQuote(rows) {
  const valid = arr(rows)
    .map(row => ({
      ...row,
      odds: num(
        row?.odds ??
        row?.price ??
        row?.decimal_odds
      )
    }))
    .filter(row =>
      row.odds !== null &&
      row.odds > 1
    );

  if (!valid.length) return null;

  return valid.reduce(
    (best, row) =>
      !best || row.odds > best.odds
        ? row
        : best,
    null
  );
}

function extractOdds(data) {
  const out = {
    HOME: [],
    DRAW: [],
    AWAY: [],
    OVER15: [],
    UNDER15: [],
    OVER25: [],
    UNDER25: [],
    UNDER35: [],
    BTTS_YES: [],
    BTTS_NO: []
  };

  const nested =
    firstObject(
      data?.odds,
      data?.data?.odds
    );

  if (nested) {
    const mw = nested.match_winner ?? {};

    if (num(mw.home) !== null) {
      out.HOME.push({
        odds: num(mw.home),
        previousOdds: num(
          mw.previous_home ??
          mw.home_previous
        )
      });
    }

    if (num(mw.draw) !== null) {
      out.DRAW.push({
        odds: num(mw.draw),
        previousOdds: num(
          mw.previous_draw ??
          mw.draw_previous
        )
      });
    }

    if (num(mw.away) !== null) {
      out.AWAY.push({
        odds: num(mw.away),
        previousOdds: num(
          mw.previous_away ??
          mw.away_previous
        )
      });
    }

    const ou = nested.over_under ?? {};

    const pushNested = (key, value) => {
      if (num(value) !== null) {
        out[key].push({
          odds: num(value)
        });
      }
    };

    pushNested("OVER15", ou.over_15);
    pushNested("UNDER15", ou.under_15);
    pushNested("OVER25", ou.over_25);
    pushNested("UNDER25", ou.under_25);
    pushNested("UNDER35", ou.under_35);

    const btts = nested.btts ?? {};

    pushNested("BTTS_YES", btts.yes);
    pushNested("BTTS_NO", btts.no);
  }

  for (const row of collection(data)) {
    const key = marketKey(
      row?.market ??
      row?.market_code ??
      row?.market_type,
      row?.line,
      row?.selection
    );

    if (!key || !out[key]) continue;

    const odds = num(
      row?.odds ??
      row?.price ??
      row?.decimal_odds
    );

    if (odds === null || odds <= 1) continue;

    out[key].push({
      odds,
      previousOdds: num(
        row?.previousOdds ??
        row?.previousPrice ??
        row?.previous_price ??
        row?.previous_decimal_odds
      )
    });
  }

  return out;
}

function womKey(row) {
  const raw = String(
    row?.market ??
    row?.market_code ??
    row?.market_type ??
    ""
  )
    .toUpperCase()
    .trim();

  const code = norm(raw).replace(/\./g, "");

  if (/^1X2HOME/.test(code)) return "HOME";
  if (/^1X2DRAW/.test(code)) return "DRAW";
  if (/^1X2AWAY/.test(code)) return "AWAY";

  if (/^OU15OVER/.test(code)) return "OVER15";
  if (/^OU15UNDER/.test(code)) return "UNDER15";

  if (/^OU25OVER/.test(code)) return "OVER25";
  if (/^OU25UNDER/.test(code)) return "UNDER25";

  if (/^OU35UNDER/.test(code)) return "UNDER35";

  if (/^BTTSYES/.test(code)) return "BTTS_YES";
  if (/^BTTSNO/.test(code)) return "BTTS_NO";

  return marketKey(
    raw,
    row?.line,
    row?.selection
  );
}

function normalizeWomData(data) {
  const source =
    collection(data).length
      ? collection(data)
      : arr(data?.money).length
        ? data.money
        : arr(data?.markets).length
          ? data.markets
          : [];

  return source
    .map(row => ({
      ...row,
      market:
        row?.market ??
        row?.market_code ??
        row?.market_type ??
        null,

      volume: num(
        row?.volume ??
        row?.money ??
        row?.turnover
      ),

      share: num(
        row?.share ??
        row?.money_share
      ),

      price: num(
        row?.price ??
        row?.odds ??
        row?.decimal_odds
      ),

      previous_price: num(
        row?.previous_price ??
        row?.previousPrice ??
        row?.previous_odds
      ),

      implied_probability: num(
        row?.implied_probability ??
        row?.impliedProbability
      ),

      divergence: num(
        row?.divergence
      ),

      capturedAt:
        row?.captured_at ??
        row?.capturedAt ??
        null
    }))
    .filter(row => row.market);
}

async function getWom(eventId) {
  if (!USE_WOM) {
    return {
      connected: false,
      status: "DISABLED",
      markets: []
    };
  }

  const key = `wom:${eventId}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safe(
    `/events/${encodeURIComponent(eventId)}/`,
    { wom: true }
  );

  if (!data) {
    return cacheSet(key, {
      connected: false,
      status: "NOT_CONNECTED",
      markets: []
    });
  }

  return cacheSet(key, {
    connected: true,
    status: "CONNECTED",
    markets: normalizeWomData(data)
  });
}

function findWom(wom, key) {
  if (!wom?.connected) {
    return {
      usable: false,
      status: wom?.status || "NOT_CONNECTED"
    };
  }

  const row = arr(wom.markets)
    .find(x => womKey(x) === key);

  if (!row) {
    return {
      usable: false,
      status: "NO_MARKET"
    };
  }

  const volume = num(row.volume);
  const share = num(row.share);
  const impliedProbability = num(
    row.impliedProbability ??
    row.implied_probability
  );

  if (
    volume === null ||
    share === null ||
    impliedProbability === null
  ) {
    return {
      usable: false,
      status: "INCOMPLETE"
    };
  }

  if (volume < WOM_MIN_VOLUME) {
    return {
      usable: false,
      status: "LOW_VOLUME",
      volume,
      share,
      impliedProbability
    };
  }

  const divergence =
    num(row.divergence) ??
    (share - impliedProbability);

  return {
    usable: true,
    status: "USED",
    volume,
    share,
    impliedProbability,
    divergence: Number(
      divergence.toFixed(2)
    ),
    price: num(row.price),
    previousPrice: num(
      row.previous_price ??
      row.previousPrice
    ),
    priceMovement: normalizeMovement(
      null,
      row.price,
      row.previous_price ??
      row.previousPrice
    ),
    capturedAt:
      row.capturedAt ??
      row.captured_at ??
      null
  };
}

function normalizeMovement(
  movement,
  current,
  previous
) {
  if (movement) return movement;

  const c = num(current);
  const p = num(previous);

  if (c === null || p === null) {
    return "UNKNOWN";
  }

  if (c < p) return "SHORTENING";
  if (c > p) return "DRIFTING";

  return "STABLE";
}

function exchangeScoreBonus(exchange) {
  if (!exchange?.usable) return 0;

  let bonus = 0;

  if (exchange.divergence >= 20) bonus += 8;
  else if (exchange.divergence >= 10) bonus += 5;
  else if (exchange.divergence >= 5) bonus += 3;

  if (
    exchange.priceMovement === "SHORTENING"
  ) {
    bonus += 4;
  }

  if (
    exchange.priceMovement === "DRIFTING"
  ) {
    bonus -= 5;
  }

  return clamp(bonus, -10, 12);
}

function summarizeLineups(data) {
  const home =
    firstObject(
      data?.home,
      data?.home_team,
      data?.homeTeam
    );

  const away =
    firstObject(
      data?.away,
      data?.away_team,
      data?.awayTeam
    );

  const confirmed =
    Boolean(
      home?.confirmed ||
      away?.confirmed ||
      data?.confirmed
    );

  return {
    quality: confirmed
      ? "CONFIRMED"
      : "UNKNOWN",

    home: home || null,
    away: away || null
  };
}

function summarizeForm(data, teamId) {
  const rows = collection(data)
    .filter(row => {
      const h = num(
        row?.home_team?.id ??
        row?.homeTeam?.id ??
        row?.home_team_id
      );

      const a = num(
        row?.away_team?.id ??
        row?.awayTeam?.id ??
        row?.away_team_id
      );

      return h === teamId || a === teamId;
    });

  let points = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const row of rows) {
    const homeId = num(
      row?.home_team?.id ??
      row?.homeTeam?.id ??
      row?.home_team_id
    );

    const homeGoals = num(
      row?.score?.home ??
      row?.home_score ??
      row?.homeGoals
    );

    const awayGoals = num(
      row?.score?.away ??
      row?.away_score ??
      row?.awayGoals
    );

    if (
      homeGoals === null ||
      awayGoals === null
    ) {
      continue;
    }

    const isHome = homeId === teamId;

    const gf = isHome
      ? homeGoals
      : awayGoals;

    const ga = isHome
      ? awayGoals
      : homeGoals;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) points += 3;
    else if (gf === ga) points += 1;
  }

  return {
    matches: rows.length,
    points,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    ppg: rows.length
      ? Number(
          (points / rows.length).toFixed(2)
        )
      : 0
  };
}

function marketProb(prediction, key) {
  if (!prediction) return null;

  switch (key) {
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

    case "UNDER25":
      return prediction.under25;

    case "UNDER35":
      return prediction.under35;

    case "BTTS_YES":
      return prediction.btts;

    case "BTTS_NO":
      return prediction.bttsNo;

    case "DC1X":
      return prediction.home !== null &&
        prediction.draw !== null
        ? prediction.home + prediction.draw
        : null;

    case "DCX2":
      return prediction.draw !== null &&
        prediction.away !== null
        ? prediction.draw + prediction.away
        : null;

    case "DC12":
      return prediction.home !== null &&
        prediction.away !== null
        ? prediction.home + prediction.away
        : null;

    default:
      return null;
  }
}

function score(candidate) {
  const probability = num(candidate.probability, 0);
  const candidateEdge = num(candidate.edge, 0);
  const confidence = num(
    candidate.confidence,
    50
  );

  let value = 0;

  value += probability * 0.55;
  value += clamp(candidateEdge, -20, 20) * 1.2;
  value += clamp(confidence, 0, 100) * 0.15;

  if (
    candidate.marketMovement?.movement ===
    "SHORTENING"
  ) {
    value += 4;
  }

  if (
    candidate.marketMovement?.movement ===
    "DRIFTING"
  ) {
    value -= 8;
  }

  value += exchangeScoreBonus(
    candidate.exchange
  );

  return Number(
    clamp(value, 0, 100).toFixed(2)
  );
}

function candidates(prediction, odds, wom) {
  const definitions = [
    ["HOME", "1"],
    ["DRAW", "X"],
    ["AWAY", "2"],
    ["OVER15", "Over 1.5"],
    ["OVER25", "Over 2.5"],
    ["UNDER25", "Under 2.5"],
    ["UNDER35", "Under 3.5"],
    ["BTTS_YES", "BTTS Yes"],
    ["BTTS_NO", "BTTS No"]
  ];

  const output = [];

  for (const [key, label] of definitions) {
    const probability = marketProb(
      prediction,
      key
    );

    if (probability === null) continue;

    const quote = bestQuote(
      odds?.[key]
    );

    if (!quote) continue;

    const candidateEdge = edge(
      probability,
      quote.odds
    );

    if (candidateEdge === null) continue;

    const marketMovement =
      movementFor(
        odds?.[key]
      );

    const exchange =
      findWom(wom, key);

    const candidate = {
      key,
      label,
      probability,
      odds: quote.odds,
      edge: Number(
        candidateEdge.toFixed(2)
      ),
      confidence:
        prediction.confidence,
      marketMovement,
      exchange
    };

    candidate.score = score(
      candidate
    );

    output.push(candidate);
  }

  return output;
}

function qualify(candidate) {
  if (!candidate) return false;

  if (
    num(candidate.probability, 0) <
    MIN_PROBABILITY
  ) {
    return false;
  }

  if (
    num(candidate.edge, 0) <
    MIN_EDGE
  ) {
    return false;
  }

  if (
    num(candidate.score, 0) <
    MIN_SCORE
  ) {
    return false;
  }

  if (
    candidate.marketMovement?.movement ===
    "DRIFTING"
  ) {
    return false;
  }

  return true;
}

async function getEvents(date) {
  const key = `events:${date}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await safe(
    `/events/?date=${encodeURIComponent(date)}&limit=200`
  );

  const events = collection(data)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(event =>
      ["notstarted", "live"].includes(
        event.status
      )
    );

  return cacheSet(key, events);
}

async function analyzeEvent(event, predictionMap) {
  const prediction =
    predictionMap.get(event.id) || null;

  const oddsData = await safe(
    `/events/${encodeURIComponent(event.id)}/odds/`,
    { odds: true }
  );

  const odds = extractOdds(
    oddsData || {}
  );

  const wom = await getWom(
    event.id
  );

  const picks = candidates(
    prediction,
    odds,
    wom
  )
    .filter(qualify)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.probability - a.probability
    );

  return {
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
    picks,
    odds,
    exchange: wom
  };
}

async function scan(date) {
  const events = await getEvents(
    date
  );

  const predictionMap =
    await getPredictionMap();

  const preliminary = events.slice(
    0,
    MAX_SCAN_EVENTS
  );

  const results = [];

  for (
    const event of preliminary
  ) {
    try {
      results.push(
        await analyzeEvent(
          event,
          predictionMap
        )
      );
    } catch (e) {
      results.push({
        eventId: event.id,
        event: event.event,
        status: "ERROR",
        error: e.code || e.message,
        picks: []
      });
    }
  }

  const allPicks = results
    .flatMap(result =>
      arr(result.picks).map(pick => ({
        ...pick,
        eventId: result.eventId,
        event: result.event,
        date: result.date,
        league: result.league,
        home: result.home,
        away: result.away
      }))
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.probability - a.probability
    );

  const picks =
    allPicks.slice(
      0,
      MAX_PICKS
    );

  const reasons = {};

  for (const result of results) {
    if (
      result.status === "ERROR"
    ) {
      const key =
        result.error || "ERROR";

      reasons[key] =
        (reasons[key] || 0) + 1;
    }
  }

  return {
    ok: true,
    source: SOURCE,
    version: VERSION,
    date,
    scannedEvents: results.length,
    predictionRecords:
      predictionMap.size,
    qualifiedEvents:
      picks.length,
    picks,

    diagnostics: {
      rejectedEvents:
        results.filter(
          r =>
            r.status !==
            "QUALIFIED"
        ).length,

      reasons,
      contextAudited:
        preliminary.length
    },

    exchange: {
      enabled: USE_WOM,
      status: USE_WOM
        ? "WOM_ENABLED"
        : "NOT_CONFIGURED",

      message:
        "WOM is a separate BSD feed; when available and liquid enough, it affects scoring."
    }
  };
}

function selfTest() {
  const tests = [];

  const add = (
    name,
    pass,
    details = null
  ) => {
    tests.push({
      name,
      pass: Boolean(pass),
      ...(details
        ? { details }
        : {})
    });
  };

  add(
    "pct_decimal",
    pct(0.72) === 72
  );

  add(
    "pct_percent",
    pct(72) === 72
  );

  add(
    "edge",
    Math.abs(
      edge(60, 2) - 10
    ) < 0.001
  );

  add(
    "status_finished",
    status({
      status: "completed"
    }) === "finished"
  );

  add(
    "status_live",
    status({
      status: "live"
    }) === "live"
  );

  const event =
    normalizeEvent({
      id: 7,
      home_team: "Home FC",
      away_team: "Away FC",
      status: "upcoming"
    });

  add(
    "event_string_teams",
    event?.home.name ===
      "Home FC" &&
    event?.away.name ===
      "Away FC"
  );

  add(
    "nested_collection",
    collection({
      data: {
        results: [{ id: 1 }]
      }
    }).length === 1
  );

  const prediction =
    parsePrediction({
      event: { id: 7 },

      markets: {
        match_result: {
          prob_home: 0.55,
          prob_draw: 0.25,
          prob_away: 0.20
        },

        over_under: {
          prob_over_15: 0.72,
          prob_under_35: 0.78
        },

        btts: {
          prob_yes: 0.51,
          prob_no: 0.49
        }
      },

      model: {
        confidence: 0.87
      }
    });

  add(
    "prediction_nested",
    prediction?.home === 55 &&
      prediction?.draw === 25 &&
      prediction?.away === 20 &&
      prediction?.over15 === 72 &&
      prediction?.under35 === 78 &&
      prediction?.btts === 51 &&
      prediction?.bttsNo === 49 &&
      prediction?.confidence === 87
  );

  const odds =
    extractOdds({
      odds: {
        match_winner: {
          home: 2.1,
          draw: 3.2,
          away: 3.6
        },

        over_under: {
          over_15: 1.28,
          over_25: 2.05,
          under_25: 1.78,
          under_35: 1.26
        },

        btts: {
          yes: 2,
          no: 1.8
        }
      }
    });

  add(
    "odds_nested",
    odds.HOME.length === 1 &&
      odds.DRAW.length === 1 &&
      odds.AWAY.length === 1 &&
      odds.OVER15.length === 1 &&
      odds.OVER25.length === 1 &&
      odds.UNDER25.length === 1 &&
      odds.UNDER35.length === 1 &&
      odds.BTTS_YES.length === 1 &&
      odds.BTTS_NO.length === 1
  );

  const rowOdds =
    extractOdds({
      results: [
        {
          market:
            "1X2_HOME_FT",
          selection: "HOME",
          decimal_odds: 2.1,
          previous_decimal_odds: 2.2
        },

        {
          market:
            "OU_2.5_OVER_FT",
          selection: "OVER",
          decimal_odds: 2.05
        },

        {
          market:
            "BTTS_FT",
          selection: "NO",
          decimal_odds: 1.9
        }
      ]
    });

  add(
    "odds_code_rows",
    rowOdds.HOME.length === 1 &&
      rowOdds.OVER25.length === 1 &&
      rowOdds.BTTS_NO.length === 1
  );

  add(
    "movement_shortening",
    movementFor([
      {
        odds: 2,
        previousOdds: 2.2
      }
    ]).movement ===
      "SHORTENING"
  );

  add(
    "movement_drifting",
    movementFor([
      {
        odds: 2.2,
        previousOdds: 2
      }
    ]).movement ===
      "DRIFTING"
  );

  add(
    "best_quote_true_max",
    bestQuote([
      { odds: 2 },
      { odds: 2.2 }
    ]).odds === 2.2
  );

  add(
    "wom_code_home",
    womKey({
      market: "1X2_HOME_FT"
    }) === "HOME"
  );

  add(
    "wom_code_over25",
    womKey({
      market: "OU_2.5_OVER_FT"
    }) === "OVER25"
  );

  add(
    "wom_code_btts",
    womKey({
      market: "BTTS_YES_FT"
    }) === "BTTS_YES"
  );

  const nestedWom =
    normalizeWomData({
      id: 7,

      money: [
        {
          market:
            "1X2_HOME_FT",
          share: 80,
          volume: 10000,
          price: 2,
          previous_price: 2.1,
          implied_probability: 50
        }
      ]
    });

  add(
    "wom_nested_money",
    nestedWom.length === 1 &&
      nestedWom[0].market ===
        "1X2_HOME_FT"
  );

  const lowWom = {
    connected: true,

    markets: [
      {
        market:
          "1X2_HOME_FT",
        volume: 4999,
        share: 80,
        price: 2,
        previousPrice: 2.1,
        impliedProbability: 50
      }
    ]
  };

  add(
    "wom_low_volume_rejected",
    findWom(
      lowWom,
      "HOME"
    ).usable === false &&
      findWom(
        lowWom,
        "HOME"
      ).status ===
        "LOW_VOLUME"
  );

  const goodWom = {
    connected: true,

    markets: [
      {
        market:
          "1X2_HOME_FT",
        volume: 10000,
        share: 80,
        price: 2,
        previousPrice: 2.1,
        impliedProbability: 50,
        divergence: 30
      }
    ]
  };

  const c =
    candidates(
      {
        home: 60,
        draw: 20,
        away: 20,
        confidence: null
      },
      {
        HOME: [
          { odds: 2 }
        ]
      },
      goodWom
    ).find(
      x => x.key === "HOME"
    );

  add(
    "wom_changes_score",
    c?.exchange?.usable === true &&
      c.score > 50
  );

  add(
    "no_wom_probability_change",
    c?.probability === 60
  );

  const lineups =
    summarizeLineups({
      home: {
        confirmed: true,
        players: [{ id: 1 }]
      }
    });

  add(
    "lineup_detection",
    lineups.quality ===
      "CONFIRMED"
  );

  const form =
    summarizeForm(
      { results: [] },
      1
    );

  add(
    "empty_form_safe",
    form.matches === 0 &&
      form.points === 0
  );

  const m =
    marketProb(
      {
        home: 60,
        draw: 25,
        away: 15
      },
      "DC1X"
    );

  add(
    "double_chance",
    m === 85
  );

  add(
    "score_clamped",
    score({
      probability: 99,
      edge: 20,

      marketMovement: {
        movement:
          "SHORTENING"
      },

      confidence: 99,

      exchange: {
        usable: true,
        divergence: 30,
        priceMovement:
          "SHORTENING"
      }
    }) <= 100
  );

  const badMarket =
    marketKey(
      "OU_2.5_OVER_1H",
      2.5,
      "OVER"
    );

  add(
    "market_period_guard",
    badMarket === null
  );

  const ftMarket =
    marketKey(
      "OU_2.5_OVER_FT",
      null,
      "OVER"
    );

  add(
    "embedded_line_parse",
    ftMarket ===
      "OVER25"
  );

  const formRows = {
    results: [
      {
        id: 1,
        status: "finished",
        date:
          "2026-09-25T12:00:00Z",

        home_team: {
          id: 1,
          name: "A"
        },

        away_team: {
          id: 2,
          name: "B"
        },

        score: {
          home: 2,
          away: 0
        }
      },

      {
        id: 2,
        status: "finished",
        date:
          "2026-09-20T12:00:00Z",

        home_team: {
          id: 3,
          name: "C"
        },

        away_team: {
          id: 1,
          name: "A"
        },

        score: {
          home: 1,
          away: 1
        }
      }
    ]
  };

  const formCheck =
    summarizeForm(
      formRows,
      1
    );

  add(
    "form_points_and_goals",
    formCheck.points === 4 &&
      formCheck.goalDifference === 2 &&
      formCheck.ppg === 2
  );

  const officialOddsShape =
    extractOdds({
      odds: {
        match_winner: {
          home: 2.1,
          draw: 3.2,
          away: 3.6
        },

        over_under: {
          over_15: 1.28,
          under_15: 3.75,
          over_25: 2.05,
          under_25: 1.78,
          under_35: 1.26
        },

        btts: {
          yes: 2.0,
          no: 1.8
        }
      }
    });

  add(
    "official_odds_shape",
    officialOddsShape.HOME[0]?.odds === 2.1 &&
      officialOddsShape.DRAW[0]?.odds === 3.2 &&
      officialOddsShape.AWAY[0]?.odds === 3.6 &&
      officialOddsShape.OVER15[0]?.odds === 1.28 &&
      officialOddsShape.OVER25[0]?.odds === 2.05 &&
      officialOddsShape.UNDER25[0]?.odds === 1.78 &&
      officialOddsShape.UNDER35[0]?.odds === 1.26 &&
      officialOddsShape.BTTS_YES[0]?.odds === 2.0 &&
      officialOddsShape.BTTS_NO[0]?.odds === 1.8
  );

  const bsdEventShape =
    normalizeEvent({
      id: 123,
      home_team_id: 10,
      home_team: "Home FC",
      away_team_id: 20,
      away_team: "Away FC",
      event_date:
        "2026-09-26T18:00:00Z",
      status: "notstarted"
    });

  add(
    "bsd_event_shape",
    bsdEventShape?.date ===
      "2026-09-26T18:00:00Z" &&
      bsdEventShape?.home?.id ===
        10 &&
      bsdEventShape?.home?.name ===
        "Home FC" &&
      bsdEventShape?.away?.id ===
        20 &&
      bsdEventShape?.away?.name ===
        "Away FC"
  );

  const womHistoryShape =
    normalizeWomData({
      results: [
        {
          money: [
            {
              market:
                "1X2_AWAY_FT",
              volume: 12000,
              share: 72,
              price: 1.8,
              previous_price: 1.9,
              implied_probability:
                55.56
            }
          ]
        }
      ]
    });

  add(
    "wom_results_shape",
    womHistoryShape.length === 1 &&
      womHistoryShape[0].market ===
        "1X2_AWAY_FT"
  );

  add(
    "qualification_rejects_drift",
    qualify({
      probability: 70,
      edge: 5,
      score: 90,

      marketMovement: {
        movement:
          "DRIFTING"
      }
    }) === false
  );

  return {
    version: VERSION,
    passed:
      tests.filter(
        t => t.pass
      ).length,
    total: tests.length,
    ok: tests.every(
      t => t.pass
    ),
    tests
  };
}

app.get("/", (req, res) =>
  res.json({
    ok: true,
    service:
      "Bet Analyzer Backend",
    version: VERSION,
    source: SOURCE,
    time: nowIso()
  })
);

app.get(
  ["/health", "/api/health"],
  (req, res) =>
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
    })
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
    try {
      const date =
        req.query.date ||
        nowIso().slice(0, 10);

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
      res
        .status(
          e.status || 500
        )
        .json({
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
    try {
      const map =
        await getPredictionMap();

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        count: map.size,

        predictions:
          [
            ...map.entries()
          ].map(
            ([
              eventId,
              prediction
            ]) => ({
              eventId,
              prediction
            })
          )
      });
    } catch (e) {
      res
        .status(
          e.status || 500
        )
        .json({
          ok: false,
          error:
            e.code ||
            e.message
        });
    }
  }
);

app.get(
  ["/api/scan", "/api/top-picks"],
  async (req, res) => {
    try {
      res.json(
        await scan(
          req.query.date ||
          nowIso().slice(0, 10)
        )
      );
    } catch (e) {
      res
        .status(
          e.status || 500
        )
        .json({
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
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        num(req.params.id);

      if (id === null) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_EVENT_ID"
          });
      }

      const raw =
        await safe(
          `/events/${encodeURIComponent(id)}/`
        );

      const event =
        normalizeEvent(raw);

      if (!event) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "EVENT_NOT_FOUND"
          });
      }

      const map =
        await getPredictionMap();

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        ...(await analyzeEvent(
          event,
          map
        ))
      });
    } catch (e) {
      res
        .status(
          e.status || 500
        )
        .json({
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
    const id =
      num(req.params.id);

    if (id === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "INVALID_EVENT_ID"
        });
    }

    const data =
      await safe(
        `/events/${encodeURIComponent(id)}/odds/`
      );

    if (!data) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "ODDS_NOT_FOUND"
        });
    }

    res.json({
      ok: true,
      source: SOURCE,
      version: VERSION,
      eventId: id,
      data,
      parsed:
        extractOdds(data)
    });
  }
);

app.use(
  (req, res) =>
    res
      .status(404)
      .json({
        ok: false,
        error: "NOT_FOUND",
        path: req.path,
        version: VERSION
      })
);

app.use(
  (err, req, res, next) => {
    console.error(err);

    res
      .status(500)
      .json({
        ok: false,
        error:
          err.message ||
          "INTERNAL_SERVER_ERROR",
        version: VERSION
      });
  }
);

if (
  process.env.TEST_MODE !==
  "true"
) {
  app.listen(
    PORT,
    () =>
      console.log(
        `Bet Analyzer ${VERSION} listening on ${PORT}`
      )
  );
}

export {
  selfTest,
  collection,
  normalizeEvent,
  parsePrediction,
  extractOdds,
  marketKey,
  movementFor,
  bestQuote,
  marketProb,
  womKey,
  normalizeWomData,
  findWom,
  candidates,
  score,
  qualify
};
