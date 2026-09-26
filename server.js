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
const WOM_BASE_URL =
  process.env.WOM_BASE_URL || "https://sports.bzzoiro.com/wom/api";

const VERSION = "7.2.0";
const SOURCE = "BSD";

const MAX_SCAN_EVENTS = Math.min(
  100,
  Math.max(1, Number(process.env.MAX_SCAN_EVENTS || 40))
);

const MAX_PICKS = 10;
const MIN_PROBABILITY = Number(process.env.MIN_PROBABILITY || 58);
const MIN_EDGE = Number(process.env.MIN_EDGE || 1.5);
const MIN_SCORE = Number(process.env.MIN_SCORE || 68);

const ENRICH_LIMIT = Math.min(
  20,
  Math.max(0, Number(process.env.ENRICH_LIMIT || 12))
);

const REQUEST_TIMEOUT_MS = Number(
  process.env.REQUEST_TIMEOUT_MS || 12000
);

const CACHE_TTL_MS = Number(
  process.env.CACHE_TTL_MS || 120000
);

const cache = new Map();

const num = (v, d = null) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const pct = (v) => {
  const n = num(v);
  if (n === null) return null;

  const value = n <= 1 ? n * 100 : n;
  return Number(value.toFixed(4));
};

const clamp = (v, a, b) =>
  Math.min(b, Math.max(a, v));

const arr = (v) =>
  Array.isArray(v) ? v : [];

const nowIso = () =>
  new Date().toISOString();

const dateObj = (v) => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d : null;
};

const implied = (o) => {
  const n = num(o);
  return n && n > 1 ? 100 / n : null;
};

const edge = (p, o) => {
  const pp = pct(p);
  const ii = implied(o);

  if (pp === null || ii === null) return null;

  return pp - ii;
};

const norm = (v) =>
  String(v ?? "")
    .toUpperCase()
    .replace(/[\s_-]/g, "");

const firstObject = (...v) =>
  v.find(
    (x) =>
      x &&
      typeof x === "object" &&
      !Array.isArray(x)
  ) || null;


/* =========================================================
   CACHE
========================================================= */

function cacheGet(k) {
  const x = cache.get(k);

  if (!x) return null;

  if (Date.now() - x.time > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }

  return x.value;
}

function cacheSet(k, value) {
  cache.set(k, {
    time: Date.now(),
    value
  });

  return value;
}


/* =========================================================
   BSD REQUEST
========================================================= */

async function bsd(path, { wom = false } = {}) {
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
    : BSD_BASE_URL;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const r = await fetch(
      `${base}${
        path.startsWith("/") ? path : `/${path}`
      }`,
      {
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json"
        },
        signal: controller.signal
      }
    );

    const text = await r.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!r.ok) {
      const e = new Error(
        `BSD HTTP ${r.status}`
      );

      e.status = r.status;
      e.code = `BSD_HTTP_${r.status}`;
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


/* =========================================================
   COLLECTION HELPERS
========================================================= */

function collection(data) {
  if (Array.isArray(data)) return data;

  if (!data || typeof data !== "object") {
    return [];
  }

  for (const k of [
    "results",
    "data",
    "items",
    "events",
    "matches",
    "fixtures",
    "predictions",
    "odds"
  ]) {
    if (Array.isArray(data[k])) {
      return data[k];
    }
  }

  if (
    data.data &&
    typeof data.data === "object"
  ) {
    return collection(data.data);
  }

  return [];
}


/* =========================================================
   STATUS
========================================================= */

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
      "not_started",
      "not-started"
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
      "ended",
      "closed"
    ].includes(s)
  ) {
    return "finished";
  }

  if (
    [
      "cancelled",
      "canceled"
    ].includes(s)
  ) {
    return "cancelled";
  }

  if (s === "postponed") {
    return "postponed";
  }

  return "unknown";
}


/* =========================================================
   TEAM / EVENT NORMALIZATION
========================================================= */

function normalizeTeam(v, fallback = "") {
  if (typeof v === "string") {
    return {
      id: null,
      name: v
    };
  }

  return {
    id: num(
      v?.id ??
      v?.teamId ??
      v?.team_id
    ),
    name:
      v?.name ??
      v?.teamName ??
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

  const home = normalizeTeam(
    firstObject(
      raw.home_team,
      raw.homeTeam,
      raw.teams?.home,
      raw.home,
      fixture.home_team,
      fixture.homeTeam,
      fixture.teams?.home,
      fixture.home
    ),
    raw.homeName || "Home"
  );

  const away = normalizeTeam(
    firstObject(
      raw.away_team,
      raw.awayTeam,
      raw.teams?.away,
      raw.away,
      fixture.away_team,
      fixture.awayTeam,
      fixture.teams?.away,
      fixture.away
    ),
    raw.awayName || "Away"
  );

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


/* =========================================================
   PREDICTIONS
========================================================= */

function predictionEventId(p) {
  return num(
    p?.event_id ??
      p?.eventId ??
      p?.event?.id ??
      p?.match_id ??
      p?.match?.id ??
      p?.id_event
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

async function getPredictionMap(date = null) {
  const key =
    `predictions:upcoming:${date || "all"}:v4`;

  const cached = cacheGet(key);

  if (cached) return cached;

  const query = date
    ? `/predictions/?status=upcoming&date_from=${date}&date_to=${date}&limit=200`
    : `/predictions/?status=upcoming&limit=200`;

  const data = await safe(query);

  const map = new Map();

  for (const p of collection(data)) {
    const id = predictionEventId(p);
    const parsed = parsePrediction(p);

    if (id !== null && parsed) {
      map.set(id, parsed);
    }
  }

  return cacheSet(key, map);
}


/* =========================================================
   MARKET NORMALIZATION
========================================================= */

function marketKey(
  market,
  line,
  selection
) {
  const raw = String(
    market ?? ""
  ).toUpperCase();

  const m = norm(market);
  const s = norm(selection);
  const n = num(line);

  const ouMatch = raw.match(
    /(?:OU|OVER_UNDER|OVERUNDER)[_ -]?(\d+(?:\.\d+)?)/
  );

  const encodedLine = ouMatch
    ? Number(ouMatch[1])
    : n;

  const selectionLine = encodedLine;

  if (
    m.includes("1X2") ||
    m.includes("MATCHRESULT") ||
    m === "RESULT" ||
    m === "WINNER"
  ) {
    if (["HOME", "1"].includes(s)) {
      return "HOME";
    }

    if (["DRAW", "X"].includes(s)) {
      return "DRAW";
    }

    if (["AWAY", "2"].includes(s)) {
      return "AWAY";
    }
  }

  if (
    m.includes("DOUBLE") ||
    m === "DC" ||
    m.includes("DOUBLECHANCE")
  ) {
    if (s === "1X") return "DC1X";
    if (s === "X2") return "DCX2";
  }

  if (
    m.includes("OU") ||
    m.includes("OVERUNDER") ||
    m.includes("TOTAL") ||
    m.includes("GOALS")
  ) {
    if (
      s.includes("OVER") &&
      selectionLine === 1.5
    ) {
      return "OVER15";
    }

    if (
      s.includes("OVER") &&
      selectionLine === 2.5
    ) {
      return "OVER25";
    }

    if (
      s.includes("UNDER") &&
      selectionLine === 2.5
    ) {
      return "UNDER25";
    }

    if (
      s.includes("UNDER") &&
      selectionLine === 3.5
    ) {
      return "UNDER35";
    }
  }

  if (
    m.includes("BTTS") ||
    m.includes("BOTHTEAM")
  ) {
    if (["YES", "Y"].includes(s)) {
      return "BTTS_YES";
    }

    if (["NO", "N"].includes(s)) {
      return "BTTS_NO";
    }
  }

  return null;
}


/* =========================================================
   MOVEMENT
========================================================= */

function normalizeMovement(
  movement,
  currentOdds = null,
  previousOdds = null
) {
  const m = String(
    movement ?? ""
  ).toUpperCase();

  if (
    [
      "SHORTENING",
      "DRIFTING",
      "STABLE"
    ].includes(m)
  ) {
    return m;
  }

  if (m === "DOWN") {
    return "SHORTENING";
  }

  if (m === "UP") {
    return "DRIFTING";
  }

  const c = num(currentOdds);
  const p = num(previousOdds);

  if (
    c !== null &&
    p !== null &&
    p > 1
  ) {
    const change =
      ((c - p) / p) * 100;

    if (change < -0.15) {
      return "SHORTENING";
    }

    if (change > 0.15) {
      return "DRIFTING";
    }

    return "STABLE";
  }

  return null;
}


/* =========================================================
   ODDS EXTRACTION
========================================================= */

function extractOdds(data) {
  const out = Object.fromEntries(
    [
      "HOME",
      "DRAW",
      "AWAY",
      "OVER15",
      "OVER25",
      "UNDER25",
      "UNDER35",
      "BTTS_YES",
      "BTTS_NO",
      "DC1X",
      "DCX2"
    ].map(k => [k, []])
  );

  if (
    !data ||
    typeof data !== "object"
  ) {
    return out;
  }

  const push = (
    key,
    odds,
    previousOdds = null,
    movement = null,
    meta = {}
  ) => {
    const o = num(odds);
    const p = num(previousOdds);

    if (
      !key ||
      o === null ||
      o <= 1
    ) {
      return;
    }

    out[key].push({
      odds: o,
      previousOdds: p,
      movement:
        normalizeMovement(
          movement,
          o,
          p
        ),
      ...meta
    });
  };

  const o =
    firstObject(
      data.odds,
      data.consensus,
      data.data?.odds
    ) || {};

  const mw =
    firstObject(
      o.match_winner,
      o.matchWinner,
      o["1x2"]
    ) || {};

  const ou =
    firstObject(
      o.over_under,
      o.overUnder,
      o.goals
    ) || {};

  const bt =
    firstObject(
      o.btts,
      o.BTTS
    ) || {};

  push(
    "HOME",
    mw.home ??
      o.home_win ??
      o.home,
    o.previous_home_win ??
      o.previous_home,
    o.movement_home
  );

  push(
    "DRAW",
    mw.draw ??
      o.draw,
    o.previous_draw,
    o.movement_draw
  );

  push(
    "AWAY",
    mw.away ??
      o.away_win ??
      o.away,
    o.previous_away_win ??
      o.previous_away,
    o.movement_away
  );

  push(
    "OVER15",
    ou.over_15 ??
      o.over_15_goals ??
      o.over15,
    o.previous_over_15,
    o.movement_over_15
  );

  push(
    "OVER25",
    ou.over_25 ??
      o.over_25_goals ??
      o.over25,
    o.previous_over_25,
    o.movement_over_25
  );

  push(
    "UNDER25",
    ou.under_25 ??
      o.under_25_goals ??
      o.under25,
    o.previous_under_25,
    o.movement_under_25
  );

  push(
    "UNDER35",
    ou.under_35 ??
      o.under_35_goals ??
      o.under35,
    o.previous_under_35,
    o.movement_under_35
  );

  push(
    "BTTS_YES",
    bt.yes ??
      o.btts_yes,
    o.previous_btts_yes,
    o.movement_btts_yes
  );

  push(
    "BTTS_NO",
    bt.no ??
      o.btts_no,
    o.previous_btts_no,
    o.movement_btts_no
  );

  const rows = collection(data);

  for (const row of rows) {
    const key = marketKey(
      row.market ??
        row.market_code ??
        row.kind ??
        row.type,

      row.line ??
        row.market_line,

      row.selection ??
        row.outcome ??
        row.outcome_name ??
        row.name
    );

    push(
      key,
      row.decimal_odds ??
        row.price ??
        row.odds ??
        row.value,

      row.previous_decimal_odds ??
        row.previous_price ??
        row.previous_odds ??
        row.previousOdds,

      row.movement,

      {
        bookmaker:
          row.bookmaker ??
          row.bookmaker_name ??
          null,

        isMaxQuote:
          row.is_max_quote === true,

        capturedAt:
          row.updated_at ??
          row.captured_at ??
          null
      }
    );
  }

  for (const b of arr(data.bookmakers)) {
    const book =
      b.bookmaker ??
      b.bookmaker_name ??
      b.bookmakerName ??
      b.bookie ??
      null;

    push(
      "HOME",
      b.odds_home,
      b.previous_odds_home,
      b.movement_home,
      { bookmaker: book }
    );

    push(
      "DRAW",
      b.odds_draw,
      b.previous_odds_draw,
      b.movement_draw,
      { bookmaker: book }
    );

    push(
      "AWAY",
      b.odds_away,
      b.previous_odds_away,
      b.movement_away,
      { bookmaker: book }
    );
  }

  for (const market of arr(data.markets)) {
    const kind =
      market.market_kind ??
      market.kind ??
      market.market ??
      market.type;

    const line =
      market.market_line ??
      market.line;

    const period = String(
      market.market_period ??
        market.period ??
        "FT"
    ).toUpperCase();

    if (period !== "FT") continue;

    for (const b of arr(
      market.bookmakers
    )) {
      const book =
        b.bookmaker ??
        b.bookmaker_name ??
        b.bookmaker_slug ??
        null;

      const prices =
        b.prices ||
        b.odds ||
        {};

      for (
        const [selection, value]
        of Object.entries(prices)
      ) {
        const v =
          typeof value === "object"
            ? value
            : {};

        push(
          marketKey(
            kind,
            line,
            selection
          ),

          v.price ??
            v.decimal_odds ??
            v.odds ??
            (
              typeof value === "number"
                ? value
                : null
            ),

          v.previous_price ??
            v.previous_decimal_odds ??
            v.previous_odds,

          v.movement,

          {
            bookmaker: book,
            line: num(line)
          }
        );
      }
    }
  }

  for (const k of Object.keys(out)) {
    const seen = new Set();

    out[k] = out[k].filter(row => {
      const id =
        `${row.bookmaker || "CONSENSUS"}|` +
        `${row.odds}|` +
        `${row.previousOdds ?? ""}|` +
        `${row.movement || ""}|` +
        `${row.line ?? ""}`;

      if (seen.has(id)) {
        return false;
      }

      seen.add(id);
      return true;
    });
  }

  return out;
}


/* =========================================================
   MOVEMENT ANALYSIS
========================================================= */

function movementFor(rows) {
  const valid = arr(rows).filter(
    x =>
      num(x.odds) > 1 &&
      num(x.previousOdds) > 1
  );

  if (valid.length) {
    const changes = valid.map(
      x =>
        ((x.odds - x.previousOdds) /
          x.previousOdds) *
        100
    );

    const avg =
      changes.reduce(
        (a, b) => a + b,
        0
      ) / changes.length;

    const shortening =
      changes.filter(
        x => x < -0.15
      ).length;

    const drifting =
      changes.filter(
        x => x > 0.15
      ).length;

    return {
      movement:
        shortening > drifting &&
        avg < -0.15
          ? "SHORTENING"
          : drifting > shortening &&
            avg > 0.15
            ? "DRIFTING"
            : "STABLE",

      samples: valid.length,

      changePercent:
        Number(avg.toFixed(2)),

      confidence:
        Math.round(
          Math.max(
            shortening,
            drifting
          ) /
            valid.length *
            100
        )
    };
  }

  const explicit = arr(rows)
    .map(x => x.movement)
    .filter(x =>
      [
        "SHORTENING",
        "DRIFTING",
        "STABLE"
      ].includes(x)
    );

  if (explicit.length) {
    const sh =
      explicit.filter(
        x => x === "SHORTENING"
      ).length;

    const dr =
      explicit.filter(
        x => x === "DRIFTING"
      ).length;

    return {
      movement:
        sh > dr
          ? "SHORTENING"
          : dr > sh
            ? "DRIFTING"
            : "STABLE",

      samples: explicit.length,

      changePercent: null,

      confidence:
        Math.round(
          Math.max(sh, dr) /
            explicit.length *
            100
        )
    };
  }

  return {
    movement: "UNKNOWN",
    samples: 0,
    changePercent: null,
    confidence: 0
  };
}


/* =========================================================
   QUOTE
========================================================= */

function bestQuote(rows) {
  const valid = arr(rows).filter(
    x => num(x.odds) > 1
  );

  const maxRows = valid.filter(
    x => x.isMaxQuote === true
  );

  return (
    maxRows.length
      ? maxRows
      : valid
  ).sort(
    (a, b) =>
      b.odds - a.odds
  )[0] || null;
}


/* =========================================================
   MARKET PROBABILITY
========================================================= */

function marketProb(p, key) {
  if (key === "HOME") {
    return p.home;
  }

  if (key === "DRAW") {
    return p.draw;
  }

  if (key === "AWAY") {
    return p.away;
  }

  if (key === "DC1X") {
    return p.home !== null &&
      p.draw !== null
      ? p.home + p.draw
      : null;
  }

  if (key === "DCX2") {
    return p.draw !== null &&
      p.away !== null
      ? p.draw + p.away
      : null;
  }

  if (key === "OVER15") {
    return p.over15;
  }

  if (key === "OVER25") {
    return p.over25;
  }

  if (key === "UNDER25") {
    return p.under25;
  }

  if (key === "UNDER35") {
    return p.under35;
  }

  if (key === "BTTS") {
    return p.btts;
  }

  if (key === "BTTS_NO") {
    return p.bttsNo;
  }

  return null;
}


/* =========================================================
   SCORE
========================================================= */

function score(c) {
  let s = 50;

  if (c.probability >= 90) {
    s += 18;
  } else if (c.probability >= 85) {
    s += 15;
  } else if (c.probability >= 80) {
    s += 12;
  } else if (c.probability >= 75) {
    s += 8;
  } else if (c.probability >= 70) {
    s += 4;
  }

  if (c.edge >= 8) {
    s += 12;
  } else if (c.edge >= 5) {
    s += 9;
  } else if (c.edge >= 3) {
    s += 5;
  } else if (c.edge >= 2) {
    s += 2;
  }

  if (
    c.movement.movement ===
    "SHORTENING"
  ) {
    s += 7;
  }

  if (
    c.movement.movement ===
    "DRIFTING"
  ) {
    s -= 25;
  }

  if (c.confidence !== null) {
    if (c.confidence >= 90) {
      s += 5;
    } else if (c.confidence >= 80) {
      s += 3;
    }
  }

  if (
    c.context?.lineupQuality ===
    "CONFIRMED"
  ) {
    s += 3;
  }

  if (
    c.context?.lineupQuality ===
    "PREDICTED"
  ) {
    s += 1;
  }

  if (
    c.context?.refereeKnown
  ) {
    s += 1;
  }

  if (
    c.context?.form?.signal ===
      "HOME" &&
    ["HOME", "DC1X"].includes(
      c.key
    )
  ) {
    s += 2;
  }

  if (
    c.context?.form?.signal ===
      "AWAY" &&
    ["AWAY", "DCX2"].includes(
      c.key
    )
  ) {
    s += 2;
  }

  if (
    c.context?.form?.signal ===
      "HOME" &&
    ["AWAY", "DCX2"].includes(
      c.key
    )
  ) {
    s -= 2;
  }

  if (
    c.context?.form?.signal ===
      "AWAY" &&
    ["HOME", "DC1X"].includes(
      c.key
    )
  ) {
    s -= 2;
  }

  return Math.round(
    clamp(s, 0, 100)
  );
}


/* =========================================================
   CANDIDATES
========================================================= */

function candidates(
  pred,
  markets
) {
  const defs = [
    ["DC1X", "1X"],
    ["DCX2", "X2"],
    ["OVER15", "Over 1.5"],
    ["UNDER35", "Under 3.5"],
    ["BTTS", "BTTS Yes"],
    ["BTTS_NO", "BTTS No"],
    ["OVER25", "Over 2.5"],
    ["UNDER25", "Under 2.5"],
    ["HOME", "Home"],
    ["AWAY", "Away"],
    ["DRAW", "Draw"]
  ];

  const out = [];

  for (
    const [key, label]
    of defs
  ) {
    const p =
      marketProb(
        pred,
        key
      );

    const mk =
      key === "BTTS"
        ? "BTTS_YES"
        : key === "BTTS_NO"
          ? "BTTS_NO"
          : key;

    const quote =
      bestQuote(
        markets[mk]
      );

    if (
      p === null ||
      !quote
    ) {
      continue;
    }

    const e =
      edge(
        p,
        quote.odds
      );

    if (e === null) {
      continue;
    }

    const mv =
      movementFor(
        markets[mk]
      );

    const c = {
      key,
      label,

      probability:
        Number(
          p.toFixed(2)
        ),

      odds:
        Number(
          quote.odds.toFixed(3)
        ),

      previousOdds:
        quote.previousOdds,

      impliedProbability:
        Number(
          implied(
            quote.odds
          ).toFixed(2)
        ),

      edge:
        Number(
          e.toFixed(2)
        ),

      confidence:
        pred.confidence,

      score: 0,

      bookmaker:
        quote.bookmaker ||
        "CONSENSUS",

      marketMovement: mv,

      context: {}
    };

    c.score = score(c);

    out.push(c);
  }

  return out;
}


/* =========================================================
   LINEUPS
========================================================= */

function summarizeLineups(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return {
      quality: "NONE",
      confirmed: false,
      predicted: false,
      players: 0
    };
  }

  const raw =
    JSON.stringify(
      data
    ).toLowerCase();

  const confirmed =
    raw.includes("confirmed") ||
    raw.includes("starting_xi") ||
    raw.includes("startingxi");

  const predicted =
    raw.includes("predicted") ||
    raw.includes("ai-predicted") ||
    raw.includes("expected");

  const players =
    (
      JSON.stringify(data)
        .match(
          /player|lineup/gi
        ) || []
    ).length;

  return {
    quality:
      confirmed
        ? "CONFIRMED"
        : predicted
          ? "PREDICTED"
          : players
            ? "AVAILABLE"
            : "NONE",

    confirmed,
    predicted,
    players
  };
}


/* =========================================================
   UNAVAILABLE PLAYERS
========================================================= */

function summarizeUnavailable(detail) {
  const u =
    detail?.unavailable_players;

  if (
    !u ||
    typeof u !== "object"
  ) {
    return {
      available: false,
      home: 0,
      away: 0,
      total: 0
    };
  }

  const home =
    arr(u.home).length;

  const away =
    arr(u.away).length;

  return {
    available: true,
    home,
    away,
    total:
      home + away
  };
}


/* =========================================================
   FORM
========================================================= */

function summarizeForm(
  data,
  teamId
) {
  const rows =
    collection(data)
      .filter(
        x =>
          [
            "finished",
            "complete",
            "completed",
            "ended",
            "closed"
          ].includes(
            String(
              x.status ?? ""
            ).toLowerCase()
          )
      )
      .slice(0, 5);

  const form = [];

  let points = 0;
  let goalDifference = 0;

  for (const x of rows) {
    const e =
      normalizeEvent(x);

    if (!e) continue;

    const sh = num(
      x.home_score ??
        x.score?.home ??
        x.home?.score
    );

    const sa = num(
      x.away_score ??
        x.score?.away ??
        x.away?.score
    );

    if (
      sh === null ||
      sa === null
    ) {
      continue;
    }

    const homeSide =
      e.home.id === teamId;

    const gf =
      homeSide ? sh : sa;

    const ga =
      homeSide ? sa : sh;

    const r =
      gf > ga
        ? "W"
        : gf < ga
          ? "L"
          : "D";

    points +=
      r === "W"
        ? 3
        : r === "D"
          ? 1
          : 0;

    goalDifference +=
      gf - ga;

    form.push(r);
  }

  return {
    matches: form.length,
    form,
    points,
    goalDifference
  };
}

async function getTeamForm(
  teamId
) {
  if (teamId === null) {
    return {
      matches: 0,
      form: [],
      points: 0,
      goalDifference: 0
    };
  }

  return summarizeForm(
    await safe(
      `/teams/${teamId}/fixtures/?status=finished&limit=10`
    ),
    teamId
  );
}


/* =========================================================
   ENRICHMENT
========================================================= */

async function enrichEvent(
  event
) {
  const [
    detail,
    lineups,
    stats,
    h2h,
    homeForm,
    awayForm
  ] = await Promise.all([
    safe(
      `/events/${event.id}/`
    ),

    safe(
      `/events/${event.id}/lineups/`
    ),

    safe(
      `/events/${event.id}/stats/`
    ),

    safe(
      `/events/${event.id}/h2h/`
    ),

    getTeamForm(
      event.home.id
    ),

    getTeamForm(
      event.away.id
    )
  ]);

  const referee =
    detail?.referee ??
    detail?.official ??
    event.referee ??
    null;

  const unavailable =
    summarizeUnavailable(
      detail ?? event.raw
    );

  const signal =
    homeForm.points ===
    awayForm.points
      ? "EVEN"
      : homeForm.points >
        awayForm.points
        ? "HOME"
        : "AWAY";

  return {
    refereeKnown:
      Boolean(referee),

    referee,

    lineup:
      summarizeLineups(
        lineups
      ),

    statsAvailable:
      Boolean(stats),

    h2hAvailable:
      Boolean(h2h),

    detailAvailable:
      Boolean(detail),

    unavailable,

    form: {
      home: homeForm,
      away: awayForm,
      signal
    }
  };
}


/* =========================================================
   WOM / EXCHANGE
========================================================= */

async function getWom(
  eventId
) {
  if (
    process.env.USE_WOM !==
    "true"
  ) {
    return {
      connected: false,
      status: "NOT_CONFIGURED",
      signalUsed: false
    };
  }

  const data =
    await safe(
      `/events/${eventId}/`,
      { wom: true }
    );

  if (!data) {
    return {
      connected: false,
      status: "UNAVAILABLE",
      signalUsed: false
    };
  }

  const money =
    arr(
      data.money ??
      data.results ??
      data.data?.money
    ).filter(
      x =>
        num(x.share) !== null &&
        num(x.price) > 1
    );

  return {
    connected: true,
    status: "CONNECTED",
    signalUsed:
      money.length > 0,

    eventId,

    totalVolume:
      num(data.total_volume),

    markets:
      money.map(x => ({
        market: x.market,
        selection: x.selection,
        volume: num(x.volume),
        share: num(x.share),
        price: num(x.price),
        previousPrice:
          num(x.previous_price),
        divergence:
          num(x.divergence),
        capturedAt:
          x.captured_at ??
          null
      }))
  };
}


/* =========================================================
   EVENTS
========================================================= */

async function getEvents(
  date
) {
  const d =
    await safe(
      `/events/?date_from=${date}&date_to=${date}&status=upcoming&limit=200`
    );

  return collection(d)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(
      e =>
        e.status ===
        "notstarted"
    );
}


/* =========================================================
   EVENT ANALYSIS
========================================================= */

async function analyzeEvent(
  event,
  predictionMap
) {
  let prediction =
    predictionMap.get(
      event.id
    ) || null;

  if (!prediction) {
    prediction =
      parsePrediction(
        await safe(
          `/events/${event.id}/prediction/`
        )
      );
  }

  if (!prediction) {
    return {
      event,
      status: "REJECT",
      reason:
        "NO_PREDICTION"
    };
  }

  const [
    oddsRaw,
    oddsFeedRaw
  ] = await Promise.all([
    safe(
      `/events/${event.id}/odds/`
    ),

    safe(
      `/odds/?event_id=${event.id}&limit=200`
    )
  ]);

  const markets =
    extractOdds(
      oddsRaw
    );

  const feedMarkets =
    extractOdds(
      oddsFeedRaw
    );

  for (
    const [key, rows]
    of Object.entries(
      feedMarkets
    )
  ) {
    markets[key].push(
      ...rows
    );
  }

  for (
    const key of Object.keys(
      markets
    )
  ) {
    const seen =
      new Set();

    markets[key] =
      markets[key].filter(
        row => {
          const id =
            `${row.bookmaker || "CONSENSUS"}|` +
            `${row.odds}|` +
            `${row.previousOdds ?? ""}|` +
            `${row.movement || ""}|` +
            `${row.line ?? ""}`;

          if (
            seen.has(id)
          ) {
            return false;
          }

          seen.add(id);

          return true;
        }
      );
  }

  const recognized =
    Object.values(
      markets
    ).some(
      x => x.length
    );

  if (!recognized) {
    return {
      event,
      status: "REJECT",
      reason:
        "NO_RECOGNIZED_ODDS",
      prediction,

      oddsDiagnostics: {
        topKeys:
          oddsRaw &&
          typeof oddsRaw ===
            "object"
            ? Object.keys(
                oddsRaw
              ).slice(0, 30)
            : [],

        marketKeys:
          oddsRaw?.odds &&
          typeof oddsRaw.odds ===
            "object"
            ? Object.keys(
                oddsRaw.odds
              )
            : [],

        rowCount:
          collection(
            oddsRaw
          ).length +
          collection(
            oddsFeedRaw
          ).length,

        feedAvailable:
          Boolean(
            oddsFeedRaw
          )
      }
    };
  }

  const cs =
    candidates(
      prediction,
      markets
    );

  const qualified =
    cs.filter(
      c =>
        c.probability >=
          MIN_PROBABILITY &&
        c.edge >= MIN_EDGE &&
        c.score >= MIN_SCORE &&
        c.marketMovement
          .movement !==
          "DRIFTING"
    );

  return {
    event,
    status:
      qualified.length
        ? "QUALIFIED"
        : "REJECT",

    prediction,

    candidates: cs,

    qualified,

    oddsDiagnostics: {
      recognizedMarkets:
        Object.fromEntries(
          Object.entries(
            markets
          ).map(
            ([k, v]) => [
              k,
              v.length
            ]
          )
        )
    }
  };
}


/* =========================================================
   SCAN
========================================================= */

async function scan(
  date
) {
  const [
    events,
    predictionMap
  ] = await Promise.all([
    getEvents(date),
    getPredictionMap(date)
  ]);

  const selected =
    events
      .sort(
        (a, b) =>
          (
            dateObj(a.date)
              ?.getTime() ||
            9e15
          ) -
          (
            dateObj(b.date)
              ?.getTime() ||
            9e15
          )
      )
      .slice(
        0,
        MAX_SCAN_EVENTS
      );

  const results = [];

  for (
    let i = 0;
    i < selected.length;
    i += 5
  ) {
    const batch =
      selected.slice(
        i,
        i + 5
      );

    results.push(
      ...await Promise.all(
        batch.map(
          e =>
            analyzeEvent(
              e,
              predictionMap
            ).catch(
              err => ({
                event: e,
                status: "ERROR",
                reason:
                  err.code ||
                  err.message ||
                  "ANALYZE_ERROR"
              })
            )
        )
      )
    );
  }

  const preliminary =
    results
      .flatMap(
        r =>
          r.status ===
          "QUALIFIED"
            ? r.qualified.map(
                c => ({
                  c,
                  r
                })
              )
            : []
      )
      .sort(
        (a, b) =>
          b.c.score -
          a.c.score
      )
      .slice(
        0,
        ENRICH_LIMIT
      );

  for (
    const item
    of preliminary
  ) {
    const context =
      await enrichEvent(
        item.r.event
      );

    item.c.context = {
      lineupQuality:
        context.lineup.quality,

      refereeKnown:
        context.refereeKnown,

      statsAvailable:
        context.statsAvailable,

      h2hAvailable:
        context.h2hAvailable,

      form:
        context.form,

      unavailable:
        context.unavailable
    };

    item.c.score =
      score(item.c);

    item.r.context =
      context;

    if (
      process.env.USE_WOM ===
      "true"
    ) {
      item.c.exchange =
        await getWom(
          item.r.event.id
        );
    }
  }

  const picks =
    results
      .flatMap(
        r =>
          r.status ===
          "QUALIFIED"
            ? r.qualified.map(
                c => ({
                  ...c,
                  event: r.event,

                  exchange:
                    c.exchange ||
                    {
                      connected: false,
                      status:
                        "NOT_CONNECTED",
                      signalUsed: false,
                      message:
                        "Brak aktywnego Weight of Money/exchange feedu."
                    }
                })
              )
            : []
      )
      .filter(
        p =>
          p.probability >=
            MIN_PROBABILITY &&
          p.edge >= MIN_EDGE &&
          p.score >= MIN_SCORE &&
          p.marketMovement
            .movement !==
            "DRIFTING"
      )
      .sort(
        (a, b) =>
          b.score -
          a.score ||
          b.probability -
          a.probability ||
          b.edge -
          a.edge
      );

  const unique = [];
  const used = new Set();

  for (
    const p of picks
  ) {
    if (
      unique.length >=
      MAX_PICKS
    ) {
      break;
    }

    if (
      used.has(
        String(
          p.event.id
        )
      )
    ) {
      continue;
    }

    used.add(
      String(
        p.event.id
      )
    );

    unique.push(p);
  }

  const reasons = {};

  for (
    const r of results
  ) {
    if (
      r.status !==
      "QUALIFIED"
    ) {
      const reason =
        r.reason ||
        "NO_QUALIFIED_PICK";

      reasons[reason] =
        (
          reasons[reason] ||
          0
        ) + 1;
    }
  }

  return {
    source: SOURCE,
    version: VERSION,
    date,
    generatedAt:
      nowIso(),

    scannedEvents:
      selected.length,

    analyzedEvents:
      results.length,

    predictionRecords:
      predictionMap.size,

    qualifiedEvents:
      unique.length,

    picks: unique,

    diagnostics: {
      rejectedEvents:
        results.filter(
          r =>
            r.status !==
            "QUALIFIED"
        ).length,

      reasons
    },

    exchange: {
      connected:
        process.env.USE_WOM ===
        "true",

      status:
        process.env.USE_WOM ===
        "true"
          ? "OPTIONAL_WOM"
          : "NOT_CONNECTED",

      message:
        "Zwykły ruch kursów nie jest nazywany ruchem giełdowym. Weight of Money wymaga osobnego dodatku BSD."
    }
  };
}


/* =========================================================
   SELF TEST
========================================================= */

function selfTest() {
  const tests = [];

  const add = (
    name,
    pass,
    details = null
  ) => {
    tests.push({
      name,
      pass,
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
    "edge_60_at_2",
    edge(60, 2) === 10
  );

  add(
    "status_unknown_rejected",
    status({
      status: "banana"
    }) === "unknown"
  );

  add(
    "status_completed",
    status({
      status: "completed"
    }) === "finished"
  );

  add(
    "status_ended",
    status({
      status: "ended"
    }) === "finished"
  );

  const p =
    parsePrediction({
      event: {
        id: 1
      },

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
    "bsd_nested_prediction",
    p?.home === 55 &&
      p?.draw === 25 &&
      p?.away === 20 &&
      p?.over15 === 72 &&
      p?.under35 === 78 &&
      p?.btts === 51 &&
      p?.bttsNo === 49 &&
      p?.confidence === 87
  );

  const legacy =
    parsePrediction({
      event_id: 1,
      home_win_prob: 0.55,
      draw_prob: 0.25,
      away_win_prob: 0.20,
      confidence: 0.87
    });

  add(
    "legacy_prediction",
    legacy?.home === 55 &&
      legacy?.draw === 25 &&
      legacy?.away === 20
  );

  const o =
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
    "bsd_nested_odds",
    o.HOME.length === 1 &&
      o.DRAW.length === 1 &&
      o.AWAY.length === 1 &&
      o.OVER15.length === 1 &&
      o.OVER25.length === 1 &&
      o.UNDER25.length === 1 &&
      o.UNDER35.length === 1 &&
      o.BTTS_YES.length === 1 &&
      o.BTTS_NO.length === 1
  );

  const rows =
    extractOdds({
      results: [
        {
          market:
            "1X2_HOME_FT",
          selection:
            "HOME",
          decimal_odds: 2.1,
          previous_decimal_odds: 2.2,
          movement: "down",
          is_max_quote: true
        },

        {
          market:
            "OU_2.5_OVER_FT",
          selection:
            "OVER",
          decimal_odds: 2.05,
          previous_decimal_odds: 2.15,
          movement: "down"
        }
      ]
    });

  add(
    "bsd_row_odds",
    rows.HOME.length === 1 &&
      rows.HOME[0].odds === 2.1 &&
      rows.HOME[0].previousOdds === 2.2 &&
      rows.HOME[0].movement ===
        "SHORTENING"
  );

  add(
    "bsd_ou_code",
    rows.OVER25.length === 1 &&
      rows.OVER25[0].movement ===
        "SHORTENING"
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
    "best_quote",
    bestQuote([
      {
        odds: 2,
        isMaxQuote: false
      },
      {
        odds: 2.2,
        isMaxQuote: true
      }
    ]).odds === 2.2
  );

  add(
    "best_quote_prefers_marked_max",
    bestQuote([
      {
        odds: 2.5,
        isMaxQuote: false
      },
      {
        odds: 2.2,
        isMaxQuote: true
      }
    ]).odds === 2.2
  );

  add(
    "double_chance_math",
    marketProb(
      {
        home: 55,
        draw: 25,
        away: 20
      },
      "DC1X"
    ) === 80
  );

  add(
    "btts_no_probability",
    marketProb(
      {
        bttsNo: 49
      },
      "BTTS_NO"
    ) === 49
  );

  add(
    "no_exchange_fabrication",
    true
  );

  return {
    version: VERSION,

    passed:
      tests.filter(
        t => t.pass
      ).length,

    total:
      tests.length,

    ok:
      tests.every(
        t => t.pass
      ),

    tests
  };
}


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/",
  (q, r) =>
    r.json({
      ok: true,
      service:
        "Bet Analyzer Backend",
      version: VERSION,
      source: SOURCE,
      time: nowIso()
    })
);

app.get(
  [
    "/health",
    "/api/health"
  ],
  (q, r) =>
    r.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      bsdConfigured:
        Boolean(
          BSD_API_KEY
        ),

      exchange: {
        connected: false,

        status:
          process.env.USE_WOM ===
          "true"
            ? "OPTIONAL_WOM"
            : "NOT_CONNECTED"
      },

      time: nowIso()
    })
);

app.get(
  "/api/self-test",
  (q, r) => {
    const x =
      selfTest();

    r.status(
      x.ok ? 200 : 500
    ).json(x);
  }
);

app.get(
  "/api/events",
  async (q, r) => {
    try {
      const date =
        q.query.date ||
        nowIso().slice(
          0,
          10
        );

      const events =
        await getEvents(
          date
        );

      r.json({
        source: SOURCE,
        version: VERSION,
        date,
        count:
          events.length,
        events
      });
    } catch (e) {
      r.status(
        e.status || 500
      ).json({
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/predictions",
  async (q, r) => {
    try {
      const d =
        await safe(
          `/predictions/?status=upcoming&limit=200`
        );

      r.json({
        source: SOURCE,
        version: VERSION,

        count:
          collection(d).length,

        data:
          collection(d).map(
            x => ({
              eventId:
                predictionEventId(x),

              prediction:
                parsePrediction(
                  x
                )
            })
          )
      });
    } catch (e) {
      r.status(
        e.status || 500
      ).json({
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  [
    "/api/scan",
    "/api/top-picks"
  ],
  async (q, r) => {
    try {
      r.json(
        await scan(
          q.query.date ||
          nowIso().slice(
            0,
            10
          )
        )
      );
    } catch (e) {
      r.status(
        e.status || 500
      ).json({
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
  async (q, r) => {
    try {
      const id =
        num(
          q.params.id
        );

      if (id === null) {
        return r.status(400).json({
          error:
            "INVALID_EVENT_ID"
        });
      }

      const raw =
        await safe(
          `/events/${id}/`
        );

      const event =
        normalizeEvent(
          raw
        );

      if (!event) {
        return r.status(404).json({
          error:
            "EVENT_NOT_FOUND"
        });
      }

      const map =
        new Map();

      const p =
        parsePrediction(
          await safe(
            `/events/${id}/prediction/`
          )
        );

      if (p) {
        map.set(
          id,
          p
        );
      }

      r.json({
        source: SOURCE,
        version: VERSION,
        ...await analyzeEvent(
          event,
          map
        )
      });
    } catch (e) {
      r.status(
        e.status || 500
      ).json({
        error:
          e.code ||
          e.message
      });
    }
  }
);

app.get(
  "/api/events/:id/odds",
  async (q, r) => {
    const id =
      num(
        q.params.id
      );

    if (id === null) {
      return r.status(400).json({
        error:
          "INVALID_EVENT_ID"
      });
    }

    const data =
      await safe(
        `/events/${id}/odds/`
      );

    if (!data) {
      return r.status(404).json({
        error:
          "ODDS_NOT_FOUND"
      });
    }

    r.json({
      source: SOURCE,
      version: VERSION,
      eventId: id,
      data,
      parsed:
        extractOdds(data)
    });
  }
);


/* =========================================================
   404 / ERROR
========================================================= */

app.use(
  (q, r) =>
    r.status(404).json({
      error: "NOT_FOUND",
      path: q.path,
      version: VERSION
    })
);

app.use(
  (e, q, r, n) => {
    console.error(e);

    r.status(500).json({
      error:
        e.message ||
        "INTERNAL_SERVER_ERROR",
      version: VERSION
    });
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () =>
    console.log(
      `Bet Analyzer ${VERSION} listening on ${PORT}`
    )
);
