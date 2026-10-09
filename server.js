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
const BSD_PREDICTIONS_BASE_URL = process.env.BSD_PREDICTIONS_BASE_URL || "https://sports.bzzoiro.com/api";
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
function cacheSet(key, value) { cache.set(key, { time: Date.now(), value }); return value; }

async function bsd(path, { wom = false, odds = false, predictions = false } = {}) {
  if (!BSD_API_KEY) { const e = new Error("BSD_API_KEY is not configured"); e.status = 503; e.code = "BSD_NOT_CONFIGURED"; throw e; }
  const base = predictions ? BSD_PREDICTIONS_BASE_URL : wom ? WOM_BASE_URL : odds ? ODDS_BASE_URL : BSD_BASE_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
      headers: { Authorization: `Token ${BSD_API_KEY}`, Accept: "application/json" },
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const e = new Error(`BSD HTTP ${response.status}`);
      e.status = response.status; e.code = `BSD_HTTP_${response.status}`; e.data = data; throw e;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") { const x = new Error("BSD request timeout"); x.status = 504; x.code = "BSD_TIMEOUT"; throw x; }
    throw e;
  } finally { clearTimeout(timer); }
}

async function safe(path, options = {}) {
  try { return await bsd(path, options); }
  catch (e) { console.error(`[BSD] ${path}`, e.code || e.message); return null; }
}

function collection(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["results", "items", "events", "matches", "fixtures", "predictions", "odds"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (Array.isArray(data.data)) return data.data;
  if (data.data && typeof data.data === "object") return collection(data.data);
  return [];
}

function status(raw) {
  const s = String(raw?.status ?? raw?.fixture?.status ?? raw?.state ?? "").toLowerCase();
  if (["upcoming", "scheduled", "notstarted", "not_started"].includes(s)) return "notstarted";
  if (["live", "inplay", "in-play", "in_progress", "inprogress"].includes(s)) return "live";
  if (["finished", "complete", "completed", "ended"].includes(s)) return "finished";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  if (s === "postponed") return "postponed";
  return "unknown";
}

function normalizeTeam(value, fallback = "") {
  if (typeof value === "string") return { id: null, name: value };
  return { id: num(value?.id ?? value?.teamId ?? value?.team_id), name: value?.name ?? value?.teamName ?? fallback };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = firstObject(raw.data, raw.result) || raw;
  const fixture = firstObject(source.fixture, source.event, source.match, raw.fixture, raw.event, raw.match) || source;
  const homeValue = raw.home_team && typeof raw.home_team === "object"
    ? raw.home_team
    : firstObject(raw.homeTeam, raw.teams?.home, raw.home, fixture.home_team, fixture.homeTeam, fixture.teams?.home, fixture.home);
  const awayValue = raw.away_team && typeof raw.away_team === "object"
    ? raw.away_team
    : firstObject(raw.awayTeam, raw.teams?.away, raw.away, fixture.away_team, fixture.awayTeam, fixture.teams?.away, fixture.away);
  const home = normalizeTeam(homeValue, raw.homeName || "Home");
  const away = normalizeTeam(awayValue, raw.awayName || "Away");
  if (home && (raw.home_team_id !== undefined || raw.home_team !== undefined)) home.id = num(raw.home_team_id ?? home.id);
  if (away && (raw.away_team_id !== undefined || raw.away_team !== undefined)) away.id = num(raw.away_team_id ?? away.id);
  if (raw.home_team && typeof raw.home_team === "string") home.name = raw.home_team;
  if (raw.away_team && typeof raw.away_team === "string") away.name = raw.away_team;
  const id = num(raw.id ?? raw.event_id ?? raw.eventId ?? fixture.id ?? fixture.event_id ?? fixture.eventId);
  if (id === null) return null;
  const leagueValue = firstObject(source.league, source.competition, source.tournament, raw.league, raw.competition, raw.tournament, fixture.league, fixture.competition, fixture.tournament);
  const league = leagueValue?.name
    ?? raw.leagueName ?? raw.league_name
    ?? raw.competitionName ?? raw.competition_name
    ?? raw.tournamentName ?? raw.tournament_name
    ?? fixture.leagueName ?? fixture.league_name
    ?? fixture.competitionName ?? fixture.competition_name
    ?? fixture.tournamentName ?? fixture.tournament_name
    ?? (typeof raw.league === "string" ? raw.league : null)
    ?? (typeof raw.competition === "string" ? raw.competition : null)
    ?? (typeof raw.tournament === "string" ? raw.tournament : null)
    ?? null;
  return {
    id,
    event: raw.name ?? fixture.name ?? `${home.name} – ${away.name}`,
    date: raw.event_date ?? raw.date ?? raw.startTime ?? raw.start_time ?? raw.utcDate ?? raw.kickoff ?? fixture.event_date ?? fixture.date ?? fixture.startTime ?? fixture.start_time ?? fixture.utcDate ?? fixture.kickoff ?? null,
    status: status(raw),
    league,
    leagueId: num(raw.league?.id ?? raw.competition?.id ?? raw.tournament?.id ?? raw.leagueId ?? raw.league_id ?? raw.competitionId ?? raw.competition_id ?? raw.tournamentId ?? raw.tournament_id ?? fixture.league?.id ?? fixture.competition?.id ?? fixture.tournament?.id ?? fixture.leagueId ?? fixture.league_id ?? fixture.competitionId ?? fixture.competition_id ?? fixture.tournamentId ?? fixture.tournament_id),
    seasonId: num(raw.season?.id ?? raw.seasonId),
    home, away,
    referee: firstObject(raw.referee, raw.official, fixture.referee),
    raw
  };
}

function predictionEventId(p) {
  return num(
    p?.event_id ?? p?.eventId ?? p?.event?.id ?? p?.fixture?.id ??
    p?.fixture?.event_id ?? p?.match_id ?? p?.match?.id ?? p?.match?.event_id ??
    p?.prediction?.event_id ?? p?.prediction?.eventId ?? p?.prediction?.event?.id
  );
}

function parsePrediction(p) {
  if (!p || typeof p !== "object") return null;
  const root = firstObject(p.prediction, p.predictions, p.forecast, p.data?.prediction, p.data?.predictions) || p;
  const markets = firstObject(root.markets, p.markets) || {};
  const result = firstObject(markets.match_result, markets.matchResult, markets["1x2"], root.match_result) || {};
  const ou = firstObject(markets.over_under, markets.overUnder, markets.goals, root.over_under) || {};
  const btts = firstObject(markets.btts, markets.BTTS, root.btts) || {};
  const model = firstObject(root.model, p.model, root.ai, p.ai) || {};

  // Current BSD /api/predictions/ is flat. Keep the older nested shapes too.
  const home = pct(root.prob_home_win ?? root.home_win_prob ?? root.homeWinProb ?? root.homeProbability ?? root.home_win ?? result.prob_home ?? result.home ?? result.home_prob);
  const draw = pct(root.prob_draw ?? root.draw_prob ?? root.drawProbability ?? root.draw_win_prob ?? result.prob_draw ?? result.draw ?? result.draw_prob);
  const away = pct(root.prob_away_win ?? root.away_win_prob ?? root.awayWinProb ?? root.awayProbability ?? root.away_win ?? result.prob_away ?? result.away ?? result.away_prob);
  const over15 = pct(root.prob_over_15 ?? root.over_1_5_prob ?? root.over15 ?? root.over_15 ?? root.over1_5 ?? ou.prob_over_15 ?? ou.over_15 ?? ou.over15);
  const over25 = pct(root.prob_over_25 ?? root.over_2_5_prob ?? root.over25 ?? root.over_25 ?? root.over2_5 ?? ou.prob_over_25 ?? ou.over_25 ?? ou.over2_5);
  const over35 = pct(root.prob_over_35 ?? root.over_3_5_prob ?? root.over35 ?? root.over_35 ?? root.over3_5 ?? ou.prob_over_35 ?? ou.over_35 ?? ou.over35);
  const under25 = pct(root.prob_under_25 ?? root.under_2_5_prob ?? root.under25 ?? root.under_25 ?? root.under2_5 ?? ou.prob_under_25 ?? ou.under_25 ?? ou.under2_5);
  const under35 = pct(root.prob_under_35 ?? root.under_3_5_prob ?? root.under35 ?? root.under_35 ?? root.under3_5 ?? ou.prob_under_35 ?? ou.under_35 ?? ou.under3_5);
  const bttsYes = pct(root.prob_btts_yes ?? root.btts_yes_prob ?? root.bttsYesProb ?? root.btts ?? root.bothTeamsToScore ?? btts.prob_yes ?? btts.yes ?? btts.prob_btts_yes);
  const bttsNo = pct(root.prob_btts_no ?? root.btts_no_prob ?? root.bttsNoProb ?? btts.prob_no ?? btts.no ?? btts.prob_btts_no);
  const confidence = pct(root.confidence ?? root.modelConfidence ?? root.model_confidence ?? model.confidence);
  const predicted = root.predicted_result ?? root.predictedResult ?? root.prediction_label ?? root.predicted ?? p.predicted_result ?? null;
  const expectedGoals = firstObject(root.expected_goals, root.expectedGoals, model.expected_goals, model.expectedGoals) ||
    ((num(root.expected_home_goals) !== null || num(root.expected_away_goals) !== null)
      ? { home: num(root.expected_home_goals), away: num(root.expected_away_goals) }
      : null);
  const mostLikelyScore = root.most_likely_score ?? root.mostLikelyScore ?? root.score?.most_likely ?? null;
  const favorite = root.favorite ?? null;
  const favoriteProb = pct(root.favorite_prob ?? root.favoriteProbability);
  const recommendations = firstObject(root.recommendations, p.recommendations) || null;

  if ([home, draw, away, over15, over25, over35, under25, under35, bttsYes, bttsNo, confidence].every(v => v === null)) return null;
  return { home, draw, away, over15, over25, over35, under25, under35, btts: bttsYes, bttsNo, confidence, predicted, expectedGoals, mostLikelyScore, favorite, favoriteProb, recommendations, raw: p };
}
async function getPredictionMap(date = nowIso().slice(0, 10)) {
  const key = `predictions:${date}:v8`;
  const cached = cacheGet(key);

  if (cached) return cached;

  // BSD documents /api/predictions/ as the current football prediction feed.
  // Date filters override `upcoming`, so use the date-scoped request first and
  // include Europe/Warsaw to align the feed with the app's requested match day.
  const queries = [
    `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&tz=Europe%2FWarsaw&limit=200&offset=0`,
    `/predictions/?upcoming=true&limit=200&offset=0`,
    `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&limit=200&offset=0`
  ];

  const map = new Map();
  for (const path of queries) {
    const data = await safe(path, { predictions: true });
    for (const row of collection(data)) {
      const id = predictionEventId(row);
      const prediction = parsePrediction(row);
      if (id !== null && prediction) map.set(id, prediction);
    }
    if (map.size > 0) break;
  }

  return cacheSet(key, map);
}
function marketKey(market, line, selection) {
  const raw = String(market ?? "").toUpperCase().trim();
  const m = norm(raw), s = norm(selection);
  const codeHas = token => m.includes(norm(token));
  const explicitLine = line === null || line === undefined || line === "" ? null : num(line);
  const embeddedLine = raw.match(/(?:OU|OVER_UNDER|OVERUNDER|TOTAL|GOALS)[_ -]?(\d+(?:\.\d+)?)/i) || m.match(/(?:OU|OVERUNDER|TOTAL|GOALS)(\d+(?:\.\d+)?)/i);
  const selectionLine = explicitLine ?? (embeddedLine ? Number(embeddedLine[1]) : null);
  const hasFirstHalf = /(?:^|[^A-Z0-9])(1H|HT)(?:$|[^A-Z0-9])/.test(raw);
  const hasSecondHalf = /(?:^|[^A-Z0-9])2H(?:$|[^A-Z0-9])/.test(raw);
  const hasAnyHalfToken = /(?:^|[^A-Z0-9])(1H|HT|2H)(?:$|[^A-Z0-9])/.test(raw);
  const hasFullTime = /(?:^|[^A-Z0-9])FT(?:$|[^A-Z0-9])/.test(raw);
  if (hasFirstHalf || hasSecondHalf || (hasAnyHalfToken && !hasFullTime)) return null;
  if (/^1X2(?:HOME|1)(?:FT)?$/.test(m) || /^1X2HOME/.test(m)) return "HOME";
  if (/^1X2(?:DRAW|X)(?:FT)?$/.test(m) || /^1X2DRAW/.test(m)) return "DRAW";
  if (/^1X2(?:AWAY|2)(?:FT)?$/.test(m) || /^1X2AWAY/.test(m)) return "AWAY";
  if (/^(?:1X2|MATCHRESULT|RESULT|WINNER)/.test(m)) {
    if (["HOME", "1"].includes(s) || codeHas("1X2_HOME")) return "HOME";
    if (["DRAW", "X"].includes(s) || codeHas("1X2_DRAW")) return "DRAW";
    if (["AWAY", "2"].includes(s) || codeHas("1X2_AWAY")) return "AWAY";
  }
  if (m.startsWith("DOUBLE") || m === "DC" || m.startsWith("DOUBLECHANCE")) {
    if (s === "1X" || m.includes("1X")) return "DC1X";
    if (s === "X2" || m.includes("X2")) return "DCX2";
  }
  if (m.startsWith("OU") || m.includes("OVERUNDER") || m.startsWith("TOTAL") || m.startsWith("GOALS")) {
    const isOver = s.includes("OVER") || m.includes("OVER");
    const isUnder = s.includes("UNDER") || m.includes("UNDER");
    if (isOver && selectionLine === 1.5) return "OVER15";
    if (isOver && selectionLine === 2.5) return "OVER25";
    if (isUnder && selectionLine === 2.5) return "UNDER25";
    if (isUnder && selectionLine === 3.5) return "UNDER35";
  }
  if (m.includes("BTTS") || m.includes("BOTHTEAM")) {
    if (["YES", "Y"].includes(s) || m.includes("BTTSYES") || (m.includes("BTTS") && !m.includes("NO") && s === "")) return "BTTS_YES";
    if (["NO", "N"].includes(s) || m.includes("BTTSNO")) return "BTTS_NO";
  }
  return null;
}

function normalizeMovement(movement, currentOdds = null, previousOdds = null) {
  const m = String(movement ?? "").toUpperCase();
  if (["SHORTENING", "DRIFTING", "STABLE"].includes(m)) return m;
  if (["DOWN", "FALL", "FALLING"].includes(m)) return "SHORTENING";
  if (["UP", "RISE", "RISING"].includes(m)) return "DRIFTING";
  const current = num(currentOdds), previous = num(previousOdds);
  if (current !== null && previous !== null && previous > 1) {
    const change = (current - previous) / previous * 100;
    if (change < -0.15) return "SHORTENING";
    if (change > 0.15) return "DRIFTING";
    return "STABLE";
  }
  return "UNKNOWN";
}

function emptyMarkets() { return Object.fromEntries(["HOME","DRAW","AWAY","OVER15","OVER25","UNDER25","UNDER35","BTTS_YES","BTTS_NO","DC1X","DCX2"].map(k => [k, []])); }

function extractOdds(data) {
  const out = emptyMarkets();
  if (!data || typeof data !== "object") return out;
  const push = (key, odds, previousOdds = null, movement = null, meta = {}) => {
    const o = num(odds); if (!key || o === null || o <= 1) return;
    out[key].push({ odds: o, previousOdds: num(previousOdds), movement: normalizeMovement(movement, o, previousOdds), ...meta });
  };
  const root = firstObject(data.odds, data.consensus, data.data?.odds) || {};
  const mw = firstObject(root.match_winner, root.matchWinner, root["1x2"]) || {};
  const ou = firstObject(root.over_under, root.overUnder, root.goals) || {};
  const bt = firstObject(root.btts, root.BTTS) || {};
  const officialValue = (value, previous = null, movement = null) => {
    if (value && typeof value === "object") return [value.price ?? value.decimal_odds ?? value.odds, value.previous_price ?? value.previous_decimal_odds ?? value.previous_odds ?? previous, value.movement ?? movement];
    return [value, previous, movement];
  };
  const [homeOdds, homePrev, homeMove] = officialValue(mw.home ?? root.home_win ?? root.home, root.previous_home_win ?? root.previous_home, root.movement_home);
  const [drawOdds, drawPrev, drawMove] = officialValue(mw.draw ?? root.draw, root.previous_draw, root.movement_draw);
  const [awayOdds, awayPrev, awayMove] = officialValue(mw.away ?? root.away_win ?? root.away, root.previous_away, root.movement_away);
  push("HOME", homeOdds, homePrev, homeMove);
  push("DRAW", drawOdds, drawPrev, drawMove);
  push("AWAY", awayOdds, awayPrev, awayMove);
  const [over15, over15Prev, over15Move] = officialValue(ou.over_15 ?? root.over_15_goals ?? root.over15, root.previous_over_15, root.movement_over_15);
  const [over25, over25Prev, over25Move] = officialValue(ou.over_25 ?? root.over_25_goals ?? root.over25, root.previous_over_25, root.movement_over_25);
  const [under25, under25Prev, under25Move] = officialValue(ou.under_25 ?? root.under_25_goals ?? root.under25, root.previous_under_25, root.movement_under_25);
  const [under35, under35Prev, under35Move] = officialValue(ou.under_35 ?? root.under_35_goals ?? root.under35, root.previous_under_35, root.movement_under_35);
  push("OVER15", over15, over15Prev, over15Move);
  push("OVER25", over25, over25Prev, over25Move);
  push("UNDER25", under25, under25Prev, under25Move);
  push("UNDER35", under35, under35Prev, under35Move);
  push("BTTS_YES", bt.yes ?? root.btts_yes, root.previous_btts_yes, root.movement_btts_yes);
  push("BTTS_NO", bt.no ?? root.btts_no, root.previous_btts_no, root.movement_btts_no);
  for (const row of collection(data)) {
    const key = marketKey(row.market ?? row.market_code ?? row.kind ?? row.type, row.line ?? row.market_line, row.selection ?? row.outcome ?? row.outcome_name ?? row.name);
    push(key, row.decimal_odds ?? row.price ?? row.odds ?? row.value, row.previous_decimal_odds ?? row.previous_price ?? row.previous_odds ?? row.previousOdds, row.movement, {
      bookmaker: row.bookmaker ?? row.bookmaker_name ?? row.bookmakerName ?? null,
      isMaxQuote: row.is_max_quote === true || row.isMaxQuote === true || row.best === true,
      capturedAt: row.updated_at ?? row.captured_at ?? null,
      line: num(row.line ?? row.market_line)
    });
  }
  for (const book of arr(data.bookmakers)) {
    const name = book.bookmaker ?? book.bookmaker_name ?? book.bookmakerName ?? book.bookie ?? null;
    push("HOME", book.odds_home, book.previous_odds_home, book.movement_home, { bookmaker: name });
    push("DRAW", book.odds_draw, book.previous_odds_draw, book.movement_draw, { bookmaker: name });
    push("AWAY", book.odds_away, book.previous_odds_away, book.movement_away, { bookmaker: name });
  }
  for (const market of arr(data.markets)) {
    const kind = market.market_kind ?? market.kind ?? market.market ?? market.type;
    const line = market.market_line ?? market.line;
    const period = String(market.market_period ?? market.period ?? "FT").toUpperCase();
    if (period !== "FT") continue;
    for (const book of arr(market.bookmakers)) {
      const name = book.bookmaker ?? book.bookmaker_name ?? book.bookmaker_slug ?? null;
      const prices = book.prices || book.odds || {};
      for (const [selection, value] of Object.entries(prices)) {
        const v = value && typeof value === "object" ? value : {};
        push(marketKey(kind, line, selection), v.price ?? v.decimal_odds ?? v.odds ?? (typeof value === "number" ? value : null), v.previous_price ?? v.previous_decimal_odds ?? v.previous_odds, v.movement, { bookmaker: name, line: num(line) });
      }
    }
  }
  for (const key of Object.keys(out)) {
    const seen = new Set();
    out[key] = out[key].filter(row => { const id = `${row.bookmaker || "CONSENSUS"}|${row.odds}|${row.previousOdds ?? ""}|${row.line ?? ""}`; if (seen.has(id)) return false; seen.add(id); return true; });
  }
  return out;
}

function movementFor(rows) {
  const valid = arr(rows).filter(x => num(x.odds) > 1 && num(x.previousOdds) > 1);
  if (!valid.length) return { movement: "UNKNOWN", samples: 0, changePercent: null, confidence: 0 };
  const changes = valid.map(x => (x.odds - x.previousOdds) / x.previousOdds * 100);
  const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
  const shortening = changes.filter(x => x < -0.15).length;
  const drifting = changes.filter(x => x > 0.15).length;
  const movement = shortening > drifting && avg < -0.15 ? "SHORTENING" : drifting > shortening && avg > 0.15 ? "DRIFTING" : "STABLE";
  return { movement, samples: valid.length, changePercent: Number(avg.toFixed(2)), confidence: Math.round(Math.max(shortening, drifting) / valid.length * 100) };
}

function bestQuote(rows) {
  const valid = arr(rows).filter(x => num(x.odds) > 1);
  if (!valid.length) return null;
  return valid.reduce((best, row) => !best || row.odds > best.odds ? row : best, null);
}

function marketProb(prediction, key) {
  if (key === "HOME") return prediction.home;
  if (key === "DRAW") return prediction.draw;
  if (key === "AWAY") return prediction.away;
  if (key === "DC1X") return prediction.home !== null && prediction.draw !== null ? prediction.home + prediction.draw : null;
  if (key === "DCX2") return prediction.draw !== null && prediction.away !== null ? prediction.draw + prediction.away : null;
  if (key === "OVER15") return prediction.over15;
  if (key === "OVER25") return prediction.over25;
  if (key === "UNDER25") return prediction.under25;
  if (key === "UNDER35") return prediction.under35;
  if (key === "BTTS") return prediction.btts;
  if (key === "BTTS_NO") return prediction.bttsNo;
  return null;
}

function womKey(row) {

  const raw = String(row?.market ?? row?.market_code ?? row?.market_type ?? "").toUpperCase().trim();
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
  return marketKey(raw, row?.line, row?.selection);
}

function findWom(wom, key) {
  if (!wom?.connected) return { usable: false, status: wom?.status || "NOT_CONNECTED" };
  const womRows = arr(wom.markets).length ? arr(wom.markets) : normalizeWomData(wom);
  const row = womRows.find(x => womKey(x) === key);
  if (!row) return { usable: false, status: "NO_MARKET" };
  const volume = num(row.volume ?? row.market_volume ?? row.marketVolume ?? row.total_volume ?? row.totalVolume);
  const share = num(row.share ?? row.money_share ?? row.moneyShare ?? row.percentage ?? row.percent);
  const impliedProbability = num(row.impliedProbability ?? row.implied_probability ?? row.impliedProb) ?? implied(row.price ?? row.current_price ?? row.currentPrice);
  if (volume === null || share === null || impliedProbability === null) return { usable: false, status: "INCOMPLETE" };
  if (volume < WOM_MIN_VOLUME) return { usable: false, status: "LOW_VOLUME", volume, share, impliedProbability };
  const divergence = num(row.divergence) ?? (share - impliedProbability);
  return { usable: true, status: "USED", volume, share, impliedProbability, divergence: Number(divergence.toFixed(2)), price: num(row.price ?? row.current_price ?? row.currentPrice), previousPrice: num(row.previousPrice ?? row.previous_price ?? row.previousPrice), priceMovement: normalizeMovement(null, row.price ?? row.current_price ?? row.currentPrice, row.previousPrice ?? row.previous_price ?? row.previousPrice), capturedAt: row.capturedAt ?? row.captured_at ?? null };
}

function exchangeScoreBonus(exchange) {
  if (!exchange?.usable) return 0;
  let bonus = 0;
  if (exchange.divergence >= 15) bonus += 6;
  else if (exchange.divergence >= 10) bonus += 4;
  else if (exchange.divergence >= 5) bonus += 2;
  else if (exchange.divergence <= -15) bonus -= 6;
  else if (exchange.divergence <= -10) bonus -= 4;
  else if (exchange.divergence <= -5) bonus -= 2;
  if (exchange.priceMovement === "SHORTENING") bonus += 2;
  if (exchange.priceMovement === "DRIFTING") bonus -= 3;
  return bonus;
}

function score(candidate) {
  let value = 50;
  if (candidate.probability >= 90) value += 18; else if (candidate.probability >= 85) value += 15; else if (candidate.probability >= 80) value += 12; else if (candidate.probability >= 75) value += 8; else if (candidate.probability >= 70) value += 4;
  if (candidate.edge >= 8) value += 12; else if (candidate.edge >= 5) value += 9; else if (candidate.edge >= 3) value += 5; else if (candidate.edge >= 2) value += 2;
  // Market-implied probability is a strength signal, not a value-bet gate.
  // A high-probability market can remain a strong pick even when model edge is negative.
  const marketProbability = num(candidate.impliedProbability);
  if (marketProbability !== null) {
    if (marketProbability >= 85) value += 10;
    else if (marketProbability >= 80) value += 8;
    else if (marketProbability >= 75) value += 5;
    else if (marketProbability >= 70) value += 3;
    if (candidate.probability >= 70 && marketProbability >= 75) value += 2;
  }
  if (candidate.marketMovement.movement === "SHORTENING") value += 7;
  if (candidate.marketMovement.movement === "DRIFTING") value -= 25;
  if (candidate.confidence !== null) { if (candidate.confidence >= 90) value += 5; else if (candidate.confidence >= 80) value += 3; }
  if (candidate.context?.lineupQuality === "CONFIRMED") value += 3;
  else if (candidate.context?.lineupQuality === "PREDICTED") value += 1;
  if (candidate.context?.form?.signal === "HOME" && ["HOME", "DC1X"].includes(candidate.key)) value += 3;
  if (candidate.context?.form?.signal === "AWAY" && ["AWAY", "DCX2"].includes(candidate.key)) value += 3;
  if (candidate.context?.form?.signal === "HOME" && ["AWAY", "DCX2"].includes(candidate.key)) value -= 3;
  if (candidate.context?.form?.signal === "AWAY" && ["HOME", "DC1X"].includes(candidate.key)) value -= 3;
  const formGap = num(candidate.context?.form?.pointsGap);
  if (formGap !== null) value += clamp(formGap, -3, 3);
  if (candidate.context?.h2hSignal === "SUPPORTS") value += 2;
  if (candidate.context?.h2hSignal === "CONTRADICTS") value -= 2;
  if (candidate.context?.statsSignal === "SUPPORTS") value += 3;
  if (candidate.context?.statsSignal === "CONTRADICTS") value -= 3;
  if (candidate.context?.refereeSignal === "SUPPORTS") value += 1;
  if (candidate.context?.refereeSignal === "CONTRADICTS") value -= 1;
  if (candidate.context?.unavailable?.total >= 3) value -= 2;
  value += exchangeScoreBonus(candidate.exchange);
  return Math.round(clamp(value, 0, 100));
}

function candidates(prediction, markets, wom = null, marketType = "ALL") {
  const defs = [["DC1X","1X"],["DCX2","X2"],["OVER15","Over 1.5"],["UNDER35","Under 3.5"],["BTTS","BTTS"],["BTTS_NO","BTTS No"],["OVER25","Over 2.5"],["UNDER25","Under 2.5"],["HOME","Home"],["AWAY","Away"],["DRAW","Draw"]];
  const allowed = marketType === "MATCH_ODDS"
    ? new Set(["HOME","DRAW","AWAY","DC1X","DCX2"])
    : marketType === "OVER_UNDER_25"
      ? new Set(["OVER25","UNDER25"])
      : marketType === "BOTH_TEAMS_TO_SCORE"
        ? new Set(["BTTS","BTTS_NO"])
        : null;
  return defs.filter(([key]) => !allowed || allowed.has(key)).flatMap(([key, label]) => {
    const probability = marketProb(prediction, key);
    const quote = bestQuote(markets[key === "BTTS" ? "BTTS_YES" : key]);
    if (probability === null || !quote) return [];
    const e = edge(probability, quote.odds); if (e === null) return [];
    const candidate = { key, label, probability: Number(probability.toFixed(2)), odds: Number(quote.odds.toFixed(3)), previousOdds: quote.previousOdds, impliedProbability: Number(implied(quote.odds).toFixed(2)), edge: Number(e.toFixed(2)), confidence: prediction.confidence, score: 0, bookmaker: quote.bookmaker || "BEST_AVAILABLE", marketMovement: movementFor(markets[key === "BTTS" ? "BTTS_YES" : key]), exchange: findWom(wom, key === "BTTS" ? "BTTS_YES" : key), context: {} };
    candidate.score = score(candidate);
    return [candidate];
  });
}

function summarizeLineups(data) {
  if (!data || typeof data !== "object") return { quality: "NONE", confirmed: false, predicted: false, players: 0 };
  const rows = collection(data);
  const serialized = JSON.stringify(data).toLowerCase();
  const players = (serialized.match(/player/g) || []).length;
  const confirmed = serialized.includes("confirmed") || serialized.includes("starting_xi") || serialized.includes("startingxi");
  const predicted = serialized.includes("predicted") || serialized.includes("ai-predicted") || serialized.includes("expected");
  return { quality: confirmed ? "CONFIRMED" : predicted ? "PREDICTED" : rows.length || players ? "AVAILABLE" : "NONE", confirmed, predicted, players };
}

function summarizeUnavailable(detail) {
  const u = detail?.unavailable_players ?? detail?.absences ?? detail?.missing_players;
  if (!u) return { available: false, home: 0, away: 0, total: 0 };
  if (Array.isArray(u)) return { available: true, home: 0, away: 0, total: u.length };
  const home = arr(u.home).length, away = arr(u.away).length;
  return { available: true, home, away, total: home + away };
}

function summarizeForm(data, teamId) {
  const rows = collection(data)
    .filter(x => {
      const s = String(x?.status ?? x?.fixture?.status ?? x?.state ?? x?.fixture_status ?? "").toLowerCase();
      return status(x) === "finished" || ["ft", "fulltime", "full_time", "complete", "completed", "ended"].includes(s);
    })
    .sort((a,b) => (dateObj(b.event_date ?? b.match_date ?? b.date ?? b.kickoff ?? b.startTime ?? b.fixture?.date)?.getTime() ?? 0) -
      (dateObj(a.event_date ?? a.match_date ?? a.date ?? a.kickoff ?? a.startTime ?? a.fixture?.date)?.getTime() ?? 0))
    .slice(0, 5);
  const form = []; let points = 0; let goalDifference = 0; let goalsFor = 0; let goalsAgainst = 0;
  for (const row of rows) {
    const event = normalizeEvent(row);
    if (!event) continue;
    const homeScore = num(row.home_score ?? row.home_score_ft ?? row.home_score_fulltime ?? row.score?.home ?? row.home?.score ?? row.scores?.home ?? row.result?.home ?? row.result?.home_score);
    const awayScore = num(row.away_score ?? row.away_score_ft ?? row.away_score_fulltime ?? row.score?.away ?? row.away?.score ?? row.scores?.away ?? row.result?.away ?? row.result?.away_score);
    if (homeScore === null || awayScore === null) continue;
    const isHome = num(row.home_team_id ?? row.homeTeamId ?? row.home?.id ?? event.home.id) === teamId || event.home.id === teamId;
    const isAway = num(row.away_team_id ?? row.awayTeamId ?? row.away?.id ?? event.away.id) === teamId || event.away.id === teamId;
    if (!isHome && !isAway) continue;
    const gf = isHome ? homeScore : awayScore, ga = isHome ? awayScore : homeScore;
    const result = gf > ga ? "W" : gf < ga ? "L" : "D";
    points += result === "W" ? 3 : result === "D" ? 1 : 0;
    goalDifference += gf - ga; goalsFor += gf; goalsAgainst += ga; form.push(result);
  }
  return { matches: form.length, form, points, goalDifference, goalsFor, goalsAgainst, ppg: form.length ? Number((points / form.length).toFixed(2)) : 0 };
}

async function getTeamForm(teamId) {
  if (teamId === null) return { matches: 0, form: [], points: 0, goalDifference: 0, goalsFor: 0, goalsAgainst: 0, ppg: 0 };
  const endpoints = [
    `/teams/${encodeURIComponent(teamId)}/fixtures/?status=finished&limit=30`,
    `/teams/${encodeURIComponent(teamId)}/fixtures/?limit=30`,
    `/events/?team_id=${encodeURIComponent(teamId)}&status=finished&limit=30`
  ];
  for (const path of endpoints) {
    const data = await safe(path);
    const form = summarizeForm(data, teamId);
    if (form.matches > 0) return form;
  }
  return { matches: 0, form: [], points: 0, goalDifference: 0, goalsFor: 0, goalsAgainst: 0, ppg: 0 };
}

function numericStat(data, keys) {
  const wanted = new Set(keys.map(k => norm(k)));
  let found = null;
  const walk = value => {
    if (found !== null || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (typeof value !== "object") return;
    for (const [k,v] of Object.entries(value)) {
      if (wanted.has(norm(k)) && num(v) !== null) { found = num(v); return; }
      walk(v);
    }
  };
  walk(data); return found;
}

function contextSignal(candidateKey, homeValue, awayValue) {
  if (homeValue === null || awayValue === null) return "NEUTRAL";
  const homeFav = homeValue > awayValue + 0.05, awayFav = awayValue > homeValue + 0.05;
  if (homeFav && ["HOME","DC1X"].includes(candidateKey)) return "SUPPORTS";
  if (awayFav && ["AWAY","DCX2"].includes(candidateKey)) return "SUPPORTS";
  if (homeFav && ["AWAY","DCX2"].includes(candidateKey)) return "CONTRADICTS";
  if (awayFav && ["HOME","DC1X"].includes(candidateKey)) return "CONTRADICTS";
  return "NEUTRAL";
}

function summarizeContextSignals(candidateKey, stats, h2h, homeForm, awayForm) {
  const homeXg = numericStat(stats, ["home_xg","xg_home","expected_goals_home","homeExpectedGoals"]);
  const awayXg = numericStat(stats, ["away_xg","xg_away","expected_goals_away","awayExpectedGoals"]);
  const h2hHome = numericStat(h2h, ["home_win_probability","home_win_pct","home_percentage","home_wins"]);
  const h2hAway = numericStat(h2h, ["away_win_probability","away_win_pct","away_percentage","away_wins"]);
  const statsSignal = contextSignal(candidateKey, homeXg, awayXg);
  const h2hSignal = contextSignal(candidateKey, h2hHome, h2hAway);
  return { statsSignal, h2hSignal };
}

async function enrichEvent(event) {
  const [detail, lineups, stats, h2h, homeForm, awayForm] = await Promise.all([
    safe(`/events/${event.id}/`),
    safe(`/events/${event.id}/lineups/`),
    safe(`/events/${event.id}/stats/`),
    safe(`/events/${event.id}/h2h/`),
    getTeamForm(event.home.id),
    getTeamForm(event.away.id)
  ]);
  const referee = detail?.referee ?? detail?.official ?? event.referee ?? null;
  const signal = homeForm.points === awayForm.points ? "EVEN" : homeForm.points > awayForm.points ? "HOME" : "AWAY";
  return {
    refereeKnown: Boolean(referee), referee,
    lineup: summarizeLineups(lineups),
    statsAvailable: Boolean(stats), h2hAvailable: Boolean(h2h), detailAvailable: Boolean(detail),
    stats, h2h,
    unavailable: summarizeUnavailable(detail ?? event.raw),
    form: { home: homeForm, away: awayForm, signal, pointsGap: homeForm.ppg - awayForm.ppg }
  };
}

function normalizeWomData(data) {
  const out = [];
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.market || value.market_code || value.market_type) {
      out.push(value);
    }
    for (const key of ["results", "items", "data", "money", "markets"]) {
      const child = value[key];
      if (child && child !== value) visit(child);
    }
  };
  visit(data);
  return out;
}

async function getWom(eventId) {
  if (!USE_WOM) return { connected: false, status: "NOT_CONFIGURED", signalUsed: false, markets: [] };
  try {
    // BSD documents this exact event route for Weight of Money.
    const data = await bsd(`/events/${encodeURIComponent(eventId)}/`, { wom: true });
    const money = normalizeWomData(data).filter(x => num(x.share) !== null && num(x.price) > 1 && x.market);
    return {
      connected: true, status: money.length ? "CONNECTED" : "NO_MARKETS", signalUsed: false, eventId,
      totalVolume: num(data?.total_volume),
      markets: money.map(x => ({
        market: x.market, kind: x.kind ?? null, line: x.line ?? null, selection: x.selection ?? null,
        volume: num(x.volume), share: num(x.share), marketVolume: num(x.market_volume), leagueAvgVolume: num(x.league_avg_volume),
        price: num(x.price), previousPrice: num(x.previous_price),
        impliedProbability: num(x.implied_probability) ?? implied(x.price),
        divergence: num(x.divergence) ?? (num(x.share) !== null && implied(x.price) !== null ? num(x.share) - implied(x.price) : null),
        capturedAt: x.captured_at ?? null
      }))
    };
  } catch (e) {
    const status = e?.status === 401 ? "AUTH_REQUIRED"
      : e?.status === 402 ? "SUBSCRIPTION_REQUIRED"
      : e?.status === 404 ? "EVENT_NOT_COVERED"
      : e?.code === "BSD_TIMEOUT" ? "TIMEOUT"
      : "UNAVAILABLE";
    console.error(`[WOM] event ${eventId}`, e.code || e.message);
    return { connected: false, status, httpStatus: e?.status ?? null, code: e?.code ?? null, signalUsed: false, markets: [] };
  }
}

async function getEvents(date) {
  const d = await safe(`/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&status=upcoming&limit=200`);
  const events = collection(d).map(normalizeEvent).filter(Boolean).filter(e => e.status === "notstarted");

  // BSD v2 events can expose only league_id. Resolve those ids through the
  // documented league endpoint so every returned pick has a real league name.
  const leagueIds = [...new Set(events.map(e => e.leagueId).filter(id => Number.isFinite(id)))];
  if (leagueIds.length) {
    const resolved = await Promise.all(leagueIds.map(async id => {
      const data = await safe(`/leagues/${id}/`);
      const league = data && typeof data === "object" ? data : null;
      return [id, league?.name || null];
    }));
    const names = new Map(resolved.filter(([, name]) => name).map(([id, name]) => [id, name]));
    for (const event of events) {
      if (!event.league && names.has(event.leagueId)) event.league = names.get(event.leagueId);
    }
  }
  return events;
}

function mergeOdds(a, b) {
  const merged = emptyMarkets();
  for (const key of Object.keys(merged)) {
    const rows = [...arr(a[key]), ...arr(b[key])];
    const seen = new Set();
    merged[key] = rows.filter(row => { const id = `${row.bookmaker || "BEST"}|${row.odds}|${row.previousOdds ?? ""}|${row.line ?? ""}`; if (seen.has(id)) return false; seen.add(id); return true; });
  }
  return merged;
}

function qualify(candidate) {
  const strongProbability = candidate.probability >= 70;
  const requiredScore = strongProbability ? Math.min(MIN_SCORE, 62) : MIN_SCORE;
  return candidate.probability >= MIN_PROBABILITY &&
    candidate.score >= requiredScore &&
    candidate.marketMovement.movement !== "DRIFTING";
}

async function analyzeEvent(event, predictionMap, marketType = "ALL") {
  const prediction = predictionMap.get(event.id) || null;
  if (!prediction) return { event, status: "REJECT", reason: "NO_PREDICTION" };
  const [oddsRaw, oddsFeedRaw] = await Promise.all([safe(`/events/${event.id}/odds/`), safe(`/events/${event.id}/?sport=football`, { odds: true })]);
  // The BSD /events/ list does not always include league metadata. The event-detail
  // response used here can contain it, so merge it into the normalized event before
  // the pick is returned to the frontend.
  if (!event.league && oddsFeedRaw) {
    const detailEvent = normalizeEvent(oddsFeedRaw);
    if (detailEvent?.league) {
      event.league = detailEvent.league;
      event.leagueId = detailEvent.leagueId ?? event.leagueId;
      event.seasonId = detailEvent.seasonId ?? event.seasonId;
    }
  }
  const markets = mergeOdds(extractOdds(oddsRaw), extractOdds(oddsFeedRaw));
  if (!Object.values(markets).some(rows => rows.length)) return { event, status: "REJECT", reason: "NO_RECOGNIZED_ODDS", prediction };
  const exchange = await getWom(event.id);
  const initial = candidates(prediction, markets, exchange, marketType);
  if (!initial.length) {
    return { event, status: "REJECT", reason: "NO_CANDIDATES", prediction, candidates: [], qualified: [], exchange, markets };
  }
  // Do not qualify before contextual enrichment. Form, H2H, stats and lineups
  // must be allowed to improve or downgrade every model+odds candidate.
  return { event, status: "ANALYZED", reason: null, prediction, candidates: initial, qualified: [], exchange, markets };
}

async function scan(date, marketType = "ALL") {
  const [events, predictionMap] = await Promise.all([getEvents(date), getPredictionMap(date)]);
  const selected = events.sort((a, b) => (dateObj(a.date)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (dateObj(b.date)?.getTime() ?? Number.MAX_SAFE_INTEGER)).slice(0, MAX_SCAN_EVENTS);
  const results = [];
  // Keep batches bounded, but avoid serially waiting on every five-event group.
  // Each event can require several BSD requests, so larger batches reduce scan
  // time substantially without opening all 40+ events at once.
  for (let i = 0; i < selected.length; i += 20) {
    const batch = selected.slice(i, i + 20);
    results.push(...await Promise.all(batch.map(e => analyzeEvent(e, predictionMap, marketType).catch(error => ({ event: e, status: "ERROR", reason: error.code || error.message || "ANALYZE_ERROR" })))));
  }

  // Enrich the best raw candidates first. Multiple markets can belong to the
  // same event; fetch context once per event and share it across its candidates.
  const allCandidates = results.flatMap(r => arr(r.candidates).map(c => ({ candidate: c, result: r })));
  const preliminary = allCandidates
    .sort((a, b) => b.candidate.score - a.candidate.score)
    .slice(0, ENRICH_LIMIT);
  const uniqueEvents = [...new Map(preliminary.map(item => [String(item.result.event.id), item.result.event])).entries()];
  const contextEntries = await Promise.all(uniqueEvents.map(async ([id, event]) => {
    try { return [id, await enrichEvent(event)]; }
    catch (error) {
      console.error("[ENRICH]", id, error.code || error.message);
      return [id, { refereeKnown: false, referee: null, lineup: { quality: "NONE" }, statsAvailable: false, h2hAvailable: false, stats: null, h2h: null, unavailable: { available: false, home: 0, away: 0, total: 0 }, form: { home: { matches: 0, form: [], points: 0, ppg: 0 }, away: { matches: 0, form: [], points: 0, ppg: 0 }, signal: "EVEN", pointsGap: 0 } }];
    }
  }));
  const contextByEvent = new Map(contextEntries);
  for (const item of preliminary) {
    const context = contextByEvent.get(String(item.result.event.id));
    if (!context) continue;
    const signals = summarizeContextSignals(item.candidate.key, context.stats, context.h2h, context.form.home, context.form.away);
    item.candidate.context = {
      lineupQuality: context.lineup.quality,
      refereeKnown: context.refereeKnown,
      refereeSignal: "NEUTRAL",
      statsAvailable: context.statsAvailable,
      h2hAvailable: context.h2hAvailable,
      statsSignal: signals.statsSignal,
      h2hSignal: signals.h2hSignal,
      form: context.form,
      unavailable: context.unavailable
    };
    item.candidate.score = score(item.candidate);
    item.candidate.exchange = findWom(item.result.exchange, item.candidate.key === "BTTS" ? "BTTS_YES" : item.candidate.key);
    item.candidate.context.enriched = true;
  }

  // Only candidates that survived the full contextual audit can become final picks.
  // This prevents a raw model/odds candidate from bypassing lineup/form/H2H checks.
  const enrichedCandidates = preliminary;
  const candidateAudit = enrichedCandidates
    .slice()
    .sort((a, b) => b.candidate.probability - a.candidate.probability || b.candidate.score - a.candidate.score || b.candidate.edge - a.candidate.edge)
    .map(item => {
      const c = item.candidate;
      const reasons = [];
      if (c.probability < MIN_PROBABILITY) reasons.push("LOW_PROBABILITY");
      if (c.edge < MIN_EDGE) reasons.push("LOW_EDGE");
      const requiredScore = c.probability >= 70 ? Math.min(MIN_SCORE, 62) : MIN_SCORE;
      if (c.score < requiredScore) reasons.push("LOW_SCORE");
      if (c.marketMovement?.movement === "DRIFTING") reasons.push("DRIFTING");
      return {
        eventId: item.result.event.id,
        event: item.result.event.event,
        key: c.key,
        probability: c.probability,
        odds: c.odds,
        edge: c.edge,
        score: c.score,
        movement: c.marketMovement?.movement ?? "UNKNOWN",
        movementChangePercent: c.marketMovement?.changePercent ?? null,
        exchangeUsable: Boolean(c.exchange?.usable),
        exchangeStatus: c.exchange?.status ?? null,
        exchangeDivergence: c.exchange?.divergence ?? null,
        reasons
      };
    });
  const picks = [];
  const usedEvents = new Set();
  for (const item of enrichedCandidates.sort((a, b) => b.candidate.probability - a.candidate.probability || b.candidate.score - a.candidate.score || b.candidate.edge - a.candidate.edge)) {
    const c = item.candidate;
    if (!qualify(c)) continue;
    const eventId = String(item.result.event.id);
    if (usedEvents.has(eventId)) continue;
    usedEvents.add(eventId);
    picks.push({ ...c, event: item.result.event, exchange: c.exchange ?? findWom(item.result.exchange, c.key === "BTTS" ? "BTTS_YES" : c.key) });
    if (picks.length >= MAX_PICKS) break;
  }
  const reasons = {};
  for (const result of results) if (result.status !== "QUALIFIED") reasons[result.reason || "NO_QUALIFIED_PICK"] = (reasons[result.reason || "NO_QUALIFIED_PICK"] || 0) + 1;
  return {
    source: SOURCE, version: VERSION, date, generatedAt: nowIso(), scannedEvents: selected.length, analyzedEvents: results.length,
    predictionRecords: predictionMap.size, qualifiedEvents: picks.length, picks,
    diagnostics: {
      rejectedEvents: results.filter(r => r.status !== "QUALIFIED").length,
      reasons,
      contextAudited: preliminary.length,
      candidateAudit
    },
    exchange: { enabled: USE_WOM, status: USE_WOM ? "WOM_ENABLED" : "NOT_CONFIGURED", message: "WOM is a separate BSD feed; when available and liquid enough, it affects scoring." }
  };
}

function selfTest() {
  const tests = [];
  const add = (name, pass, details = null) => tests.push({ name, pass: Boolean(pass), ...(details ? { details } : {}) });
  add("pct_decimal", pct(0.72) === 72);
  add("pct_percent", pct(72) === 72);
  add("edge", Math.abs(edge(60, 2) - 10) < 0.001);
  add("status_finished", status({ status: "completed" }) === "finished");
  add("status_live", status({ status: "live" }) === "live");
  const event = normalizeEvent({ id: 7, home_team: "Home FC", away_team: "Away FC", status: "upcoming" });
  add("event_string_teams", event?.home.name === "Home FC" && event?.away.name === "Away FC");
  add("nested_collection", collection({ data: { results: [{ id: 1 }] } }).length === 1);
  const prediction = parsePrediction({ event: { id: 7 }, markets: { match_result: { prob_home: .55, prob_draw: .25, prob_away: .20 }, over_under: { prob_over_15: .72, prob_under_35: .78 }, btts: { prob_yes: .51, prob_no: .49 } }, model: { confidence: .87 } });
  add("prediction_nested", prediction?.home === 55 && prediction?.draw === 25 && prediction?.away === 20 && prediction?.over15 === 72 && prediction?.under35 === 78 && prediction?.btts === 51 && prediction?.bttsNo === 49 && prediction?.confidence === 87);
  const flatPrediction = parsePrediction({ event: { id: 99 }, prob_home_win: 0.62, prob_draw: 0.21, prob_away_win: 0.17, prob_over_15: 0.84, prob_over_25: 0.61, prob_under_25: 0.39, prob_under_35: 0.79, prob_btts_yes: 0.57, prob_btts_no: 0.43, confidence: 0.86 });
  add("prediction_bsd_flat_shape", flatPrediction?.home === 62 && flatPrediction?.draw === 21 && flatPrediction?.away === 17 && flatPrediction?.over15 === 84 && flatPrediction?.over25 === 61 && flatPrediction?.under25 === 39 && flatPrediction?.under35 === 79 && flatPrediction?.btts === 57 && flatPrediction?.bttsNo === 43 && flatPrediction?.confidence === 86);
  const odds = extractOdds({ odds: { match_winner: { home: 2.1, draw: 3.2, away: 3.6 }, over_under: { over_15: 1.28, over_25: 2.05, under_25: 1.78, under_35: 1.26 }, btts: { yes: 2, no: 1.8 } } });
  add("odds_nested", odds.HOME.length === 1 && odds.DRAW.length === 1 && odds.AWAY.length === 1 && odds.OVER15.length === 1 && odds.OVER25.length === 1 && odds.UNDER25.length === 1 && odds.UNDER35.length === 1 && odds.BTTS_YES.length === 1 && odds.BTTS_NO.length === 1);
  const rowOdds = extractOdds({ results: [{ market: "1X2_HOME_FT", selection: "HOME", decimal_odds: 2.1, previous_decimal_odds: 2.2 }, { market: "OU_2.5_OVER_FT", selection: "OVER", decimal_odds: 2.05 }, { market: "BTTS_FT", selection: "NO", decimal_odds: 1.9 }] });
  add("odds_code_rows", rowOdds.HOME.length === 1 && rowOdds.OVER25.length === 1 && rowOdds.BTTS_NO.length === 1);
  add("movement_shortening", movementFor([{ odds: 2, previousOdds: 2.2 }]).movement === "SHORTENING");
  add("movement_drifting", movementFor([{ odds: 2.2, previousOdds: 2 }]).movement === "DRIFTING");
  add("best_quote_true_max", bestQuote([{ odds: 2 }, { odds: 2.2 }]).odds === 2.2);
  add("wom_code_home", womKey({ market: "1X2_HOME_FT" }) === "HOME");
  add("wom_code_over25", womKey({ market: "OU_2.5_OVER_FT" }) === "OVER25");
  add("wom_code_btts", womKey({ market: "BTTS_YES_FT" }) === "BTTS_YES");
  const nestedWom = normalizeWomData({ id: 7, money: [{ market: "1X2_HOME_FT", share: 80, volume: 10000, price: 2, previous_price: 2.1, implied_probability: 50 }] });
  add("wom_nested_money", nestedWom.length === 1 && nestedWom[0].market === "1X2_HOME_FT");
  const lowWom = { connected: true, markets: [{ market: "1X2_HOME_FT", volume: 4999, share: 80, price: 2, previousPrice: 2.1, impliedProbability: 50 }] };
  add("wom_low_volume_rejected", findWom(lowWom, "HOME").usable === false && findWom(lowWom, "HOME").status === "LOW_VOLUME");
  const goodWom = { connected: true, markets: [{ market: "1X2_HOME_FT", volume: 10000, share: 80, price: 2, previousPrice: 2.1, impliedProbability: 50, divergence: 30 }] };
  const c = candidates({ home: 60, draw: 20, away: 20, confidence: null }, { HOME: [{ odds: 2 }] }, goodWom).find(x => x.key === "HOME");
  add("wom_changes_score", c?.exchange?.usable === true && c.score > 50);
  add("no_wom_probability_change", c?.probability === 60);
  const lineups = summarizeLineups({ home: { confirmed: true, players: [{ id: 1 }] } });
  add("lineup_detection", lineups.quality === "CONFIRMED");
  const form = summarizeForm({ results: [] }, 1);
  add("empty_form_safe", form.matches === 0 && form.points === 0);
  const m = marketProb({ home: 60, draw: 25, away: 15 }, "DC1X");
  add("double_chance", m === 85);
  add("score_clamped", score({ probability: 99, edge: 20, marketMovement: { movement: "SHORTENING" }, confidence: 99, exchange: { usable: true, divergence: 30, priceMovement: "SHORTENING" } }) <= 100);
  const badMarket = marketKey("OU_2.5_OVER_1H", 2.5, "OVER");
  add("market_period_guard", badMarket === null);
  const ftMarket = marketKey("OU_2.5_OVER_FT", null, "OVER");
  add("embedded_line_parse", ftMarket === "OVER25");
  const formRows = { results: [
    { id: 1, status: "finished", date: "2026-09-25T12:00:00Z", home_team: { id: 1, name: "A" }, away_team: { id: 2, name: "B" }, score: { home: 2, away: 0 } },
    { id: 2, status: "finished", date: "2026-09-20T12:00:00Z", home_team: { id: 3, name: "C" }, away_team: { id: 1, name: "A" }, score: { home: 1, away: 1 } }
  ]};
  const formCheck = summarizeForm(formRows, 1);
  add("form_points_and_goals", formCheck.points === 4 && formCheck.goalDifference === 2 && formCheck.ppg === 2);

  const officialOddsShape = extractOdds({ odds: { match_winner: { home: 2.1, draw: 3.2, away: 3.6 }, over_under: { over_15: 1.28, under_15: 3.75, over_25: 2.05, under_25: 1.78, under_35: 1.26 }, btts: { yes: 2.0, no: 1.8 } } });
  add("official_odds_shape", officialOddsShape.HOME[0]?.odds === 2.1 && officialOddsShape.DRAW[0]?.odds === 3.2 && officialOddsShape.AWAY[0]?.odds === 3.6 && officialOddsShape.OVER15[0]?.odds === 1.28 && officialOddsShape.OVER25[0]?.odds === 2.05 && officialOddsShape.UNDER25[0]?.odds === 1.78 && officialOddsShape.UNDER35[0]?.odds === 1.26 && officialOddsShape.BTTS_YES[0]?.odds === 2.0 && officialOddsShape.BTTS_NO[0]?.odds === 1.8);
  const bsdEventShape = normalizeEvent({ id: 123, home_team_id: 10, home_team: "Home FC", away_team_id: 20, away_team: "Away FC", event_date: "2026-09-26T18:00:00Z", status: "notstarted" });
  add("bsd_event_shape", bsdEventShape?.date === "2026-09-26T18:00:00Z" && bsdEventShape?.home?.id === 10 && bsdEventShape?.home?.name === "Home FC" && bsdEventShape?.away?.id === 20 && bsdEventShape?.away?.name === "Away FC");
  const womHistoryShape = normalizeWomData({ results: [{ money: [{ market: "1X2_AWAY_FT", volume: 12000, share: 72, price: 1.8, previous_price: 1.9, implied_probability: 55.56 }] }] });
  add("wom_results_shape", womHistoryShape.length === 1 && womHistoryShape[0].market === "1X2_AWAY_FT");
  add("qualification_rejects_drift", qualify({ probability: 70, edge: 5, score: 90, marketMovement: { movement: "DRIFTING" } }) === false);
  return { version: VERSION, passed: tests.filter(t => t.pass).length, total: tests.length, ok: tests.every(t => t.pass), tests };
}

app.get("/", (req, res) => res.json({ ok: true, service: "Bet Analyzer Backend", version: VERSION, source: SOURCE, time: nowIso() }));
app.get(["/health", "/api/health"], (req, res) => res.json({ ok: true, version: VERSION, source: SOURCE, bsdConfigured: Boolean(BSD_API_KEY), wom: { enabled: USE_WOM, minVolume: WOM_MIN_VOLUME }, time: nowIso() }));
async function diagnosticRequest(base, path) {
  const started = Date.now();
  try {
    if (!BSD_API_KEY) return { ok: false, status: 503, code: "BSD_NOT_CONFIGURED", elapsedMs: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Token ${BSD_API_KEY}`, Accept: "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      const rows = collection(data);
      const sample = rows[0] ?? null;
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Date.now() - started,
        contentType: response.headers.get("content-type"),
        shape: Array.isArray(data) ? "array" : data && typeof data === "object" ? "object" : typeof data,
        collectionKey: Array.isArray(data) ? "array" : ["results","items","events","matches","fixtures","predictions","odds","data"].find(k => Array.isArray(data?.[k])) || null,
        count: rows.length,
        total: num(data?.count),
        sampleEventId: sample ? predictionEventId(sample) : null,
        sampleParseable: sample ? Boolean(parsePrediction(sample)) : false,
        samplePrediction: sample ? parsePrediction(sample) : null,
        sample
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      ok: false,
      status: e?.status || 500,
      code: e?.code || "DIAGNOSTIC_ERROR",
      error: String(e?.message || e),
      elapsedMs: Date.now() - started
    };
  }
}

app.get("/api/debug-predictions", async (req, res) => {
  const date = String(req.query.date || nowIso().slice(0, 10));
  const paths = [
    `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&tz=Europe%2FWarsaw&limit=5&offset=0`,
    `/predictions/?upcoming=true&limit=5&offset=0`,
    `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&limit=5&offset=0`,
    `/predictions/?upcoming=false&limit=5&offset=0`
  ];
  const bases = [
    { name: "dedicated_predictions_api", base: BSD_PREDICTIONS_BASE_URL },
    { name: "legacy_bsd_api_v2", base: BSD_BASE_URL }
  ];
  const results = [];
  for (const target of bases) {
    for (const path of paths) {
      const result = await diagnosticRequest(target.base, path);
      results.push({ ...target, path, ...result });
    }
  }
  const usable = results.filter(r => r.ok && r.count > 0 && r.sampleParseable && r.sampleEventId !== null);
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    date,
    configured: Boolean(BSD_API_KEY),
    predictionBase: BSD_PREDICTIONS_BASE_URL,
    legacyBase: BSD_BASE_URL,
    usableFeeds: usable.length,
    results
  });
});

app.get("/api/self-test", (req, res) => { const result = selfTest(); res.status(result.ok ? 200 : 500).json(result); });
app.get("/api/debug-wom", async (req, res) => {
  const eventId = num(req.query.eventId);
  if (eventId === null) return res.status(400).json({ ok: false, error: "INVALID_EVENT_ID" });
  if (!USE_WOM) return res.json({ ok: true, enabled: false, status: "NOT_CONFIGURED" });
  const result = await getWom(eventId);
  let coverage = null;
  try {
    const data = await bsd("/coverage/", { wom: true });
    coverage = { ok: true, data };
  } catch (e) {
    coverage = { ok: false, status: e?.status ?? null, code: e?.code ?? null, error: e?.message ?? null };
  }
  res.json({ ok: true, version: VERSION, source: SOURCE, eventId, womBase: WOM_BASE_URL, result, coverage });
});
app.get("/api/events", async (req, res) => { try { const date = req.query.date || nowIso().slice(0, 10); const events = await getEvents(date); res.json({ ok: true, source: SOURCE, version: VERSION, date, count: events.length, events }); } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.code || e.message }); } });
app.get("/api/predictions", async (req, res) => { try { const map = await getPredictionMap(); res.json({ ok: true, source: SOURCE, version: VERSION, count: map.size, predictions: [...map.entries()].map(([eventId, prediction]) => ({ eventId, prediction })) }); } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.code || e.message }); } });
app.get(["/api/scan", "/api/top-picks"], async (req, res) => { try { res.json(await scan(req.query.date || nowIso().slice(0, 10), String(req.query.market || "ALL").toUpperCase())); } catch (e) { res.status(e.status || 500).json({ ok: false, source: SOURCE, version: VERSION, error: e.code || e.message }); } });
app.get("/api/analyze/:id", async (req, res) => { try { const id = num(req.params.id); if (id === null) return res.status(400).json({ ok: false, error: "INVALID_EVENT_ID" }); const raw = await safe(`/events/${encodeURIComponent(id)}/`); const event = normalizeEvent(raw); if (!event) return res.status(404).json({ ok: false, error: "EVENT_NOT_FOUND" }); const map = await getPredictionMap(); res.json({ ok: true, source: SOURCE, version: VERSION, ...(await analyzeEvent(event, map)) }); } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.code || e.message }); } });
app.get("/api/events/:id/odds", async (req, res) => { const id = num(req.params.id); if (id === null) return res.status(400).json({ ok: false, error: "INVALID_EVENT_ID" }); const data = await safe(`/events/${encodeURIComponent(id)}/odds/`); if (!data) return res.status(404).json({ ok: false, error: "ODDS_NOT_FOUND" }); res.json({ ok: true, source: SOURCE, version: VERSION, eventId: id, data, parsed: extractOdds(data) }); });
app.use((req, res) => res.status(404).json({ ok: false, error: "NOT_FOUND", path: req.path, version: VERSION }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ ok: false, error: err.message || "INTERNAL_SERVER_ERROR", version: VERSION }); });

if (process.env.TEST_MODE !== "true") app.listen(PORT, () => console.log(`Bet Analyzer ${VERSION} listening on ${PORT}`));

export { selfTest, collection, normalizeEvent, parsePrediction, extractOdds, marketKey, movementFor, bestQuote, marketProb, womKey, normalizeWomData, findWom, candidates, score, qualify };
