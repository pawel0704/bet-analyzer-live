import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const VERSION = "7.3.3";
const SOURCE = "BSD";
const PORT = Number(process.env.PORT || 10000);
const BSD_API_KEY = process.env.BSD_API_KEY || "";
const BSD_BASE_URL = process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2";
const WOM_BASE_URL = process.env.WOM_BASE_URL || "https://sports.bzzoiro.com/wom/api";
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
const pct = v => { const n = num(v); return n === null ? null : Number((n <= 1 ? n * 100 : n).toFixed(4)); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowIso = () => new Date().toISOString();
const dateObj = v => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d : null; };
const implied = odds => { const n = num(odds); return n !== null && n > 1 ? 100 / n : null; };
const edge = (probability, odds) => { const p = pct(probability); const i = implied(odds); return p === null || i === null ? null : p - i; };
const firstObject = (...values) => values.find(v => v && typeof v === "object" && !Array.isArray(v)) || null;
const norm = v => String(v ?? "").toUpperCase().replace(/[\s_-]/g, "");

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) { cache.delete(key); return null; }
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function bsd(path, { wom = false } = {}) {
  if (!BSD_API_KEY) {
    const e = new Error("BSD_API_KEY is not configured");
    e.status = 503;
    e.code = "BSD_NOT_CONFIGURED";
    throw e;
  }

  const base = wom ? WOM_BASE_URL : BSD_BASE_URL;
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

  if ([
    "upcoming",
    "scheduled",
    "notstarted",
    "not_started"
  ].includes(s)) return "notstarted";

  if ([
    "live",
    "inplay",
    "in-play",
    "in_progress",
    "inprogress"
  ].includes(s)) return "live";

  if ([
    "finished",
    "complete",
    "completed",
    "ended"
  ].includes(s)) return "finished";

  if ([
    "cancelled",
    "canceled"
  ].includes(s)) return "cancelled";

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
    firstObject(
      raw.fixture,
      raw.event,
      raw.match
    ) || raw;

  const homeValue =
    raw.home_team ??
    raw.homeTeam ??
    raw.teams?.home ??
    raw.home ??
    fixture.home_team ??
    fixture.homeTeam ??
    fixture.teams?.home ??
    fixture.home;

  const awayValue =
    raw.away_team ??
    raw.awayTeam ??
    raw.teams?.away ??
    raw.away ??
    fixture.away_team ??
    fixture.awayTeam ??
    fixture.teams?.away ??
    fixture.away;

  const home = normalizeTeam(
    homeValue,
    raw.homeName || "Home"
  );

  const away = normalizeTeam(
    awayValue,
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

  if ([
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
  ].every(v => v === null)) {
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

  const data = await bsd(
    "/predictions/?upcoming=true&limit=200"
  );

  const map = new Map();

  for (const row of collection(data)) {
    const id = predictionEventId(row);
    if (id === null) continue;

    const prediction = parsePrediction(row);

    if (prediction) {
      map.set(id, prediction);
    }
  }

  return cacheSet(key, map);
}

function normalizeOddValue(value) {
  const n = num(value);
  return n !== null && n > 1 ? n : null;
}

function marketKey(market, selection = "") {
  const m = norm(market);
  const s = norm(selection);
  const combined = `${m}${s}`;

  if (
    m.includes("1X2") ||
    m.includes("MATCHRESULT") ||
    m.includes("FULLTIMERESULT")
  ) {
    if (
      s === "1" ||
      s === "HOME" ||
      s === "HOMEWIN"
    ) return "HOME";

    if (
      s === "X" ||
      s === "DRAW" ||
      s === "TIE"
    ) return "DRAW";

    if (
      s === "2" ||
      s === "AWAY" ||
      s === "AWAYWIN"
    ) return "AWAY";
  }

  if (
    combined.includes("1X") ||
    combined.includes("HOMEDRAW")
  ) return "DC1X";

  if (
    combined.includes("X2") ||
    combined.includes("DRAWAWAY")
  ) return "DCX2";

  if (
    combined.includes("12") ||
    combined.includes("HOMEAWAY")
  ) return "DC12";

  if (
    m.includes("BTTS") ||
    m.includes("BOTHTEAMSTOSCORE") ||
    combined.includes("BTTS")
  ) {
    if (
      s === "YES" ||
      s === "GG" ||
      combined.includes("BTTSYES")
    ) return "BTTS_YES";

    if (
      s === "NO" ||
      s === "NG" ||
      combined.includes("BTTSNO")
    ) return "BTTS_NO";
  }

  const over =
    s.includes("OVER") ||
    m.includes("OVER");

  const under =
    s.includes("UNDER") ||
    m.includes("UNDER");

  if (
    combined.includes("15") ||
    combined.includes("1.5")
  ) {
    if (over) return "OVER15";
    if (under) return "UNDER15";
  }

  if (
    combined.includes("25") ||
    combined.includes("2.5")
  ) {
    if (over) return "OVER25";
    if (under) return "UNDER25";
  }

  if (
    combined.includes("35") ||
    combined.includes("3.5")
  ) {
    if (over) return "OVER35";
    if (under) return "UNDER35";
  }

  return null;
}

function addOdd(target, key, row) {
  if (!key) return;

  const odds =
    normalizeOddValue(
      row?.price ??
      row?.odd ??
      row?.odds ??
      row?.decimal_odds ??
      row?.decimalOdds ??
      row?.value
    );

  if (odds === null) return;

  target[key].push({
    odds,
    previousOdds:
      normalizeOddValue(
        row?.previous_price ??
        row?.previousPrice ??
        row?.previous_odds ??
        row?.previousOdds ??
        row?.old_price ??
        row?.oldPrice ??
        row?.previous_decimal_odds
      ),
    bookmaker:
      row?.bookmaker ??
      row?.bookmaker_name ??
      row?.bookmakerName ??
      row?.source ??
      null,
    raw: row
  });
}

function extractOdds(data) {
  const result = {
    HOME: [],
    DRAW: [],
    AWAY: [],
    DC1X: [],
    DCX2: [],
    DC12: [],
    OVER15: [],
    OVER25: [],
    UNDER15: [],
    UNDER25: [],
    OVER35: [],
    UNDER35: [],
    BTTS_YES: [],
    BTTS_NO: []
  };

  const rows = collection(data);

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    addOdd(
      result,
      marketKey(
        row.market ??
        row.market_name ??
        row.marketName ??
        row.type ??
        row.name,
        row.selection ??
        row.outcome ??
        row.outcome_name ??
        row.outcomeName
      ),
      row
    );
  }

  const odds = data?.odds;

  if (odds && typeof odds === "object") {
    const matchWinner =
      odds.match_winner ??
      odds.matchWinner ??
      odds["1x2"];

    if (matchWinner) {
      addOdd(result, "HOME", {
        price:
          matchWinner.home ??
          matchWinner["1"]
      });

      addOdd(result, "DRAW", {
        price:
          matchWinner.draw ??
          matchWinner.x
      });

      addOdd(result, "AWAY", {
        price:
          matchWinner.away ??
          matchWinner["2"]
      });
    }

    const ou =
      odds.over_under ??
      odds.overUnder ??
      odds.totals;

    if (ou) {
      addOdd(result, "OVER15", {
        price:
          ou.over_15 ??
          ou.over15
      });

      addOdd(result, "OVER25", {
        price:
          ou.over_25 ??
          ou.over25
      });

      addOdd(result, "UNDER25", {
        price:
          ou.under_25 ??
          ou.under25
      });

      addOdd(result, "UNDER35", {
        price:
          ou.under_35 ??
          ou.under35
      });
    }

    const btts =
      odds.btts ??
      odds.BTTS;

    if (btts) {
      addOdd(result, "BTTS_YES", {
        price:
          btts.yes ??
          btts.true
      });

      addOdd(result, "BTTS_NO", {
        price:
          btts.no ??
          btts.false
      });
    }
  }

  return result;
}

function movementFor(rows) {
  const usable = arr(rows).filter(
    x =>
      normalizeOddValue(x?.odds) !== null &&
      normalizeOddValue(x?.previousOdds) !== null
  );

  if (!usable.length) {
    return {
      movement: "UNKNOWN",
      change: null
    };
  }

  const row = usable[0];
  const current = row.odds;
  const previous = row.previousOdds;

  if (current === previous) {
    return {
      movement: "STABLE",
      change: 0
    };
  }

  if (current < previous) {
    return {
      movement: "SHORTENING",
      change: Number(
        ((current - previous) / previous * 100)
          .toFixed(2)
      )
    };
  }

  return {
    movement: "DRIFTING",
    change: Number(
      ((current - previous) / previous * 100)
        .toFixed(2)
    )
  };
}

function bestQuote(rows) {
  const values =
    arr(rows)
      .filter(
        x =>
          normalizeOddValue(x?.odds) !== null
      );

  if (!values.length) return null;

  return values.reduce(
    (best, row) =>
      !best || row.odds > best.odds
        ? row
        : best,
    null
  );
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

    case "OVER15":
      return prediction.over15;

    case "OVER25":
      return prediction.over25;

    case "UNDER15":
      return prediction.under15;

    case "UNDER25":
      return prediction.under25;

    case "OVER35":
      return prediction.over35;

    case "UNDER35":
      return prediction.under35;

    case "BTTS_YES":
      return prediction.btts;

    case "BTTS_NO":
      return prediction.bttsNo;

    default:
      return null;
  }
}

function womKey(row) {
  const raw = norm(
    row?.market ??
    row?.market_name ??
    row?.marketName ??
    row?.type ??
    row?.name ??
    ""
  );

  const selection = norm(
    row?.selection ??
    row?.outcome ??
    row?.outcome_name ??
    row?.outcomeName ??
    ""
  );

  if (
    raw.includes("1X2HOME") ||
    raw.includes("1X2HOMEFT") ||
    raw === "HOME"
  ) return "HOME";

  if (
    raw.includes("1X2DRAW") ||
    raw.includes("1X2DRAWFT") ||
    raw === "DRAW"
  ) return "DRAW";

  if (
    raw.includes("1X2AWAY") ||
    raw.includes("1X2AWAYFT") ||
    raw === "AWAY"
  ) return "AWAY";

  if (
    raw.includes("OU15OVER") ||
    raw.includes("OVER15")
  ) return "OVER15";

  if (
    raw.includes("OU15UNDER") ||
    raw.includes("UNDER15")
  ) return "UNDER15";

  if (
    raw.includes("OU25OVER") ||
    raw.includes("OVER25")
  ) return "OVER25";

  if (
    raw.includes("OU25UNDER") ||
    raw.includes("UNDER25")
  ) return "UNDER25";

  if (
    raw.includes("OU35OVER") ||
    raw.includes("OVER35")
  ) return "OVER35";

  if (
    raw.includes("OU35UNDER") ||
    raw.includes("UNDER35")
  ) return "UNDER35";

  if (
    raw.includes("BTTSYES") ||
    (raw.includes("BTTS") && selection === "YES")
  ) return "BTTS_YES";

  if (
    raw.includes("BTTSNO") ||
    (raw.includes("BTTS") && selection === "NO")
  ) return "BTTS_NO";

  return marketKey(raw, selection);
}

function normalizeWomData(data) {
  const source =
    Array.isArray(data?.money)
      ? data.money
      : Array.isArray(data?.markets)
        ? data.markets
        : collection(data);

  return source
    .map(row => {
      const volume = num(
        row?.volume ??
        row?.money_volume ??
        row?.matched_volume ??
        row?.matchedVolume ??
        row?.market_volume
      );

      const share = pct(
        row?.share ??
        row?.money_share ??
        row?.moneyShare ??
        row?.percentage ??
        row?.money_percentage
      );

      const price = num(
        row?.price ??
        row?.odds ??
        row?.odd
      );

      const previousPrice = num(
        row?.previous_price ??
        row?.previousPrice ??
        row?.old_price ??
        row?.oldPrice
      );

      const impliedProbability = pct(
        row?.implied_probability ??
        row?.impliedProbability ??
        row?.implied_prob ??
        row?.impliedProb
      );

      const divergence =
        num(
          row?.divergence ??
          row?.money_divergence ??
          row?.moneyDivergence
        ) ??
        (
          share !== null &&
          impliedProbability !== null
            ? share - impliedProbability
            : null
        );

      const movement =
        price !== null &&
        previousPrice !== null
          ? price < previousPrice
            ? "SHORTENING"
            : price > previousPrice
              ? "DRIFTING"
              : "STABLE"
          : "UNKNOWN";

      return {
        market:
          row?.market ??
          row?.market_name ??
          row?.marketName ??
          row?.type ??
          null,
        key: womKey(row),
        volume,
        share,
        price,
        previousPrice,
        impliedProbability,
        divergence,
        movement,
        raw: row
      };
    })
    .filter(x => x.key);
}

function findWom(exchange, key) {
  if (!exchange?.connected) {
    return {
      usable: false,
      status: "NOT_CONNECTED"
    };
  }

  const row =
    arr(exchange.markets)
      .find(
        x =>
          x.key === key
      );

  if (!row) {
    return {
      usable: false,
      status: "MARKET_NOT_FOUND"
    };
  }

  if (
    row.volume === null ||
    row.volume < WOM_MIN_VOLUME
  ) {
    return {
      ...row,
      usable: false,
      status: "LOW_VOLUME"
    };
  }

  let bonus = 0;

  if (row.share !== null) {
    if (row.share >= 65) bonus += 4;
    else if (row.share >= 55) bonus += 2;
    else if (row.share <= 35) bonus -= 2;
  }

  if (row.divergence !== null) {
    if (row.divergence >= 10) bonus += 3;
    else if (row.divergence >= 5) bonus += 2;
    else if (row.divergence <= -10) bonus -= 3;
    else if (row.divergence <= -5) bonus -= 2;
  }

  if (row.movement === "SHORTENING") {
    bonus += 1;
  } else if (row.movement === "DRIFTING") {
    bonus -= 1;
  }

  return {
    ...row,
    usable: true,
    status: "USABLE",
    bonus: clamp(bonus, -8, 8)
  };
}

async function getWom(eventId) {
  if (!USE_WOM) {
    return {
      connected: false,
      markets: []
    };
  }

  const data = await safe(
    `/events/${encodeURIComponent(eventId)}/`,
    { wom: true }
  );

  if (!data) {
    return {
      connected: false,
      markets: []
    };
  }

  return {
    connected: true,
    markets: normalizeWomData(data)
  };
}

async function getOdds(eventId) {
  const data = await safe(
    `/events/${encodeURIComponent(eventId)}/odds/`
  );

  if (!data) {
    return {
      data: null,
      parsed: {}
    };
  }

  return {
    data,
    parsed: extractOdds(data)
  };
}

async function getEventDetail(eventId) {
  return safe(
    `/events/${encodeURIComponent(eventId)}/`
  );
}

function summarizeForm(data, teamId = null) {
  const rows =
    collection(data)
      .filter(
        row =>
          teamId === null ||
          num(
            row?.home_team?.id ??
            row?.homeTeam?.id ??
            row?.home_team_id ??
            row?.away_team?.id ??
            row?.awayTeam?.id ??
            row?.away_team_id
          ) === teamId
      );

  let points = 0;

  for (const row of rows) {
    const result =
      String(
        row?.result ??
        row?.outcome ??
        ""
      ).toUpperCase();

    if (result === "W") points += 3;
    if (result === "D") points += 1;
  }

  return {
    matches: rows.length,
    points,
    results: rows
      .slice(0, 5)
      .map(
        row =>
          row.result ??
          row.outcome ??
          null
      )
  };
}

function summarizeLineups(data) {
  if (!data || typeof data !== "object") {
    return {
      quality: "UNKNOWN",
      home: 0,
      away: 0
    };
  }

  const home =
    arr(
      data.home?.players ??
      data.home_team?.players ??
      data.homeTeam?.players
    );

  const away =
    arr(
      data.away?.players ??
      data.away_team?.players ??
      data.awayTeam?.players
    );

  if (home.length || away.length) {
    return {
      quality: "CONFIRMED",
      home: home.length,
      away: away.length
    };
  }

  return {
    quality: "UNKNOWN",
    home: 0,
    away: 0
  };
}

function score(candidate) {
  let value =
    Number(candidate.probability || 0);

  value += clamp(
    Number(candidate.edge || 0),
    -10,
    10
  ) * 0.7;

  if (
    candidate.marketMovement?.movement ===
    "SHORTENING"
  ) value += 2;

  if (
    candidate.marketMovement?.movement ===
    "DRIFTING"
  ) value -= 2;

  if (
    candidate.confidence !== null &&
    candidate.confidence !== undefined
  ) {
    value +=
      clamp(
        candidate.confidence - 60,
        -20,
        20
      ) * 0.15;
  }

  if (
    candidate.exchange?.usable
  ) {
    value +=
      clamp(
        candidate.exchange.bonus || 0,
        -8,
        8
      );
  }

  if (
    candidate.context?.lineupQuality ===
    "CONFIRMED"
  ) {
    value += 1;
  }

  return Number(
    clamp(value, 0, 100).toFixed(2)
  );
}

function qualify(candidate) {
  if (!candidate) return false;

  if (
    candidate.probability <
    MIN_PROBABILITY
  ) return false;

  if (
    candidate.edge === null ||
    candidate.edge < MIN_EDGE
  ) return false;

  if (
    candidate.score <
    MIN_SCORE
  ) return false;

  if (
    candidate.marketMovement?.movement ===
    "DRIFTING"
  ) {
    if (
      candidate.marketMovement.change !== null &&
      candidate.marketMovement.change > 8
    ) return false;
  }

  if (
    candidate.exchange?.usable &&
    candidate.exchange.divergence !== null &&
    candidate.exchange.divergence < -15
  ) {
    return false;
  }

  return true;
}

function candidates(
  prediction,
  odds,
  exchange = {
    connected: false,
    markets: []
  }
) {
  const keys = [
    "HOME",
    "DRAW",
    "AWAY",
    "DC1X",
    "DCX2",
    "DC12",
    "OVER15",
    "OVER25",
    "UNDER25",
    "UNDER35",
    "BTTS_YES",
    "BTTS_NO"
  ];

  const result = [];

  for (const key of keys) {
    const probability =
      marketProb(
        prediction,
        key
      );

    if (
      probability === null ||
      probability < MIN_PROBABILITY
    ) continue;

    const quote =
      bestQuote(
        odds?.[key]
      );

    if (!quote) continue;

    const candidate = {
      key,
      probability: Number(
        probability.toFixed(2)
      ),
      odds: quote.odds,
      fairOdds: Number(
        (100 / probability)
          .toFixed(3)
      ),
      edge: Number(
        edge(
          probability,
          quote.odds
        ).toFixed(2)
      ),
      bookmaker: quote.bookmaker,
      marketMovement:
        movementFor(
          odds?.[key]
        ),
      exchange:
        findWom(
          exchange,
          key
        )
    };

    candidate.score =
      score(candidate);

    result.push(candidate);
  }

  return result;
}

async function enrichEvent(event) {
  const detail =
    await getEventDetail(
      event.id
    );

  const raw =
    detail || event.raw || {};

  const lineups =
    summarizeLineups(
      raw.lineups ??
      raw.lineup ??
      raw
    );

  const refereeKnown =
    Boolean(
      event.referee?.name ||
      event.referee?.id ||
      raw.referee?.name ||
      raw.referee?.id
    );

  const statsAvailable =
    Boolean(
      raw.stats ||
      raw.statistics
    );

  const h2hAvailable =
    Boolean(
      raw.h2h ||
      raw.head_to_head ||
      raw.headToHead
    );

  return {
    lineup: lineups,
    refereeKnown,
    statsAvailable,
    h2hAvailable,
    form: {
      home: summarizeForm(
        raw.home_form ??
        raw.homeTeamForm ??
        [],
        event.home.id
      ),
      away: summarizeForm(
        raw.away_form ??
        raw.awayTeamForm ??
        [],
        event.away.id
      )
    },
    unavailable:
      raw.injuries ??
      raw.absences ??
      []
  };
}

async function getEvents(date) {
  const query =
    new URLSearchParams({
      date_from: date,
      date_to: date,
      limit: String(MAX_SCAN_EVENTS),
      offset: "0"
    });

  const key =
    `events:${query.toString()}`;

  const cached =
    cacheGet(key);

  if (cached) return cached;

  const data =
    await bsd(
      `/events/?${query.toString()}`
    );

  const events =
    collection(data)
      .map(normalizeEvent)
      .filter(Boolean)
      .filter(
        event =>
          event.status !== "finished" &&
          event.status !== "cancelled" &&
          event.status !== "postponed"
      )
      .slice(
        0,
        MAX_SCAN_EVENTS
      );

  return cacheSet(
    key,
    events
  );
}

async function analyzeEvent(
  event,
  predictionMap
) {
  const prediction =
    predictionMap.get(
      event.id
    );

  if (!prediction) {
    return {
      event,
      status: "NO_PREDICTION",
      reason: "NO_PREDICTION"
    };
  }

  const odds =
    await getOdds(
      event.id
    );

  const exchange =
    await getWom(
      event.id
    );

  const rawCandidates =
    candidates(
      prediction,
      odds.parsed,
      exchange
    );

  const preliminary =
    rawCandidates
      .filter(
        candidate =>
          candidate.edge !== null &&
          candidate.edge >= MIN_EDGE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(
        0,
        5
      );

  if (!preliminary.length) {
    return {
      event,
      status: "NO_CANDIDATE",
      reason: "NO_CANDIDATE",
      candidates: []
    };
  }

  const enriched =
    await enrichEvent(
      event
    );

  for (const candidate of preliminary) {
    candidate.context = {
      lineupQuality:
        enriched.lineup.quality,
      refereeKnown:
        enriched.refereeKnown,
      statsAvailable:
        enriched.statsAvailable,
      h2hAvailable:
        enriched.h2hAvailable,
      form:
        enriched.form,
      unavailable:
        enriched.unavailable
    };

    candidate.score =
      score(candidate);
  }

  const candidatesAfterContext =
    preliminary
      .sort(
        (a, b) =>
          b.score - a.score
      );

  return {
    event,
    status: "ANALYZED",
    prediction,
    odds: odds.parsed,
    exchange,
    context: enriched,
    candidates:
      candidatesAfterContext
  };
}

async function scan(date) {
  const events =
    await getEvents(
      date
    );

  const predictionMap =
    await getPredictionMap();

  const selected =
    events.slice(
      0,
      ENRICH_LIMIT ||
      events.length
    );

  const results = [];

  for (const event of selected) {
    try {
      results.push(
        await analyzeEvent(
          event,
          predictionMap
        )
      );
    } catch (error) {
      results.push({
        event,
        status: "ERROR",
        reason:
          error.message,
        candidates: []
      });
    }
  }

  const preliminary = [];

  for (const result of results) {
    if (
      result.status !==
      "ANALYZED"
    ) continue;

    for (const candidate of result.candidates) {
      if (
        qualify(candidate)
      ) {
        preliminary.push({
          result,
          candidate
        });
      }
    }
  }

  const picks = [];
  const usedEvents =
    new Set();

  for (
    const item of preliminary.sort(
      (a, b) =>
        b.candidate.score -
          a.candidate.score ||
        b.candidate.probability -
          a.candidate.probability ||
        b.candidate.edge -
          a.candidate.edge
    )
  ) {
    const candidate =
      item.candidate;

    if (!qualify(candidate)) {
      continue;
    }

    const eventId =
      String(
        item.result.event.id
      );

    if (
      usedEvents.has(
        eventId
      )
    ) {
      continue;
    }

    usedEvents.add(
      eventId
    );

    picks.push({
      ...candidate,
      event:
        item.result.event,
      exchange:
        candidate.exchange ??
        findWom(
          item.result.exchange,
          candidate.key === "BTTS"
            ? "BTTS_YES"
            : candidate.key
        )
    });

    if (
      picks.length >=
      MAX_PICKS
    ) {
      break;
    }
  }

  const reasons = {};

  for (const result of results) {
    if (
      result.status !==
      "QUALIFIED"
    ) {
      const reason =
        result.reason ||
        "NO_QUALIFIED_PICK";

      reasons[reason] =
        (reasons[reason] || 0) +
        1;
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
      picks.length,
    picks,
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
      enabled: USE_WOM,
      status:
        USE_WOM
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
  ) =>
    tests.push({
      name,
      pass: Boolean(pass),
      ...(details
        ? { details }
        : {})
    });

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
        results: [
          { id: 1 }
        ]
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
          selection:
            "HOME",
          decimal_odds:
            2.1,
          previous_decimal_odds:
            2.2
        },
        {
          market:
            "OU_2.5_OVER_FT",
          selection:
            "OVER",
          decimal_odds:
            2.05
        },
        {
          market:
            "BTTS_FT",
          selection:
            "NO",
          decimal_odds:
            1.9
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
      market:
        "1X2_HOME_FT"
    }) === "HOME"
  );

  add(
    "wom_code_over25",
    womKey({
      market:
        "OU_2.5_OVER_FT"
    }) === "OVER25"
  );

  add(
    "wom_code_btts",
    womKey({
      market:
        "BTTS_YES_FT"
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
      x =>
        x.key === "HOME"
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
        players: [
          { id: 1 }
        ]
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

  return {
    version: VERSION,
    passed:
      tests.filter(
        t => t.pass
      ).length,
    total: tests.length,
    ok:
      tests.every(
        t => t.pass
      ),
    tests
  };
}

app.get(
  "/",
  (req, res) =>
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
  [
    "/health",
    "/api/health"
  ],
  (req, res) =>
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      bsdConfigured:
        Boolean(
          BSD_API_KEY
        ),
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

    res.status(
      result.ok
        ? 200
        : 500
    ).json(result);
  }
);

app.get(
  "/api/events",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        nowIso().slice(
          0,
          10
        );

      const events =
        await getEvents(
          date
        );

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        date,
        count:
          events.length,
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
    try {
      const map =
        await getPredictionMap();

      res.json({
        ok: true,
        source: SOURCE,
        version: VERSION,
        count:
          map.size,
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
  [
    "/api/scan",
    "/api/top-picks"
  ],
  async (req, res) => {
    try {
      res.json(
        await scan(
          req.query.date ||
          nowIso().slice(
            0,
            10
          )
        )
      );
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
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const id =
        num(
          req.params.id
        );

      if (id === null) {
        return res.status(400)
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
        normalizeEvent(
          raw
        );

      if (!event) {
        return res.status(404)
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
        ...(
          await analyzeEvent(
            event,
            map
          )
        )
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
    const id =
      num(
        req.params.id
      );

    if (id === null) {
      return res.status(400)
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
      return res.status(404)
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
        extractOdds(
          data
        )
    });
  }
);

app.use(
  (req, res) =>
    res.status(404)
      .json({
        ok: false,
        error:
          "NOT_FOUND",
        path:
          req.path,
        version: VERSION
      })
);

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(500)
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
