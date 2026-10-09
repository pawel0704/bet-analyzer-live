const VERSION = "7.4.4";
const APISPORTS_BASKETBALL_BASE = "https://v1.basketball.api-sports.io";
const TENNIS_API_BASE = "https://tennis-api-atp-wta-itf.p.rapidapi.com";
const TENNIS_API_HOST = "tennis-api-atp-wta-itf.p.rapidapi.com";
const n = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const pct = value => { const v = n(value); return v === null ? null : Number((v <= 1 ? v * 100 : v).toFixed(2)); };
const isoNow = () => new Date().toISOString();
// Free-tier APIs have strict daily quotas; avoid repeated calls from the app auto-refresh.
const scanCache = new Map();
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000;
function getCached(key) {
  const item = scanCache.get(key);
  if (!item || Date.now() - item.time > SCAN_CACHE_TTL_MS) { scanCache.delete(key); return null; }
  return item.value;
}
function setCached(key, value) { scanCache.set(key, { time: Date.now(), value }); return value; }
const arr = value => Array.isArray(value) ? value : [];
const obj = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function collect(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap(item => collect(item, depth + 1));
  if (typeof value !== "object") return [];
  for (const key of ["response", "matches", "results", "events", "games", "fixtures", "data", "items"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data && typeof value.data === "object") return collect(value.data, depth + 1);
  return [];
}
async function request(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { detail: body }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.detail || data?.error || `API HTTP ${response.status}`);
    error.status = response.status;
    error.code = response.status === 401 || response.status === 403 ? "SPORT_API_AUTH_OR_PLAN" : response.status === 429 ? "SPORT_API_RATE_LIMIT" : `SPORT_API_HTTP_${response.status}`;
    throw error;
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const error = new Error(JSON.stringify(data.errors));
    error.status = 502; error.code = "SPORT_API_PROVIDER_ERROR"; throw error;
  }
  return data;
}
function walk(value, visit, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, depth + 1); return; }
  if (typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") walk(child, visit, depth + 1);
}
function bestBasketballOdds(oddsRows, homeName, awayName) {
  let home = null, away = null, bookmaker = null;
  const homeTerms = new Set(["home", "1", String(homeName || "").toLowerCase()]);
  const awayTerms = new Set(["away", "2", String(awayName || "").toLowerCase()]);
  walk(oddsRows, node => {
    const values = arr(node.values);
    if (!values.length) return;
    const market = String(node.name ?? node.bet?.name ?? node.market ?? "").toLowerCase();
    if (market && !/(winner|moneyline|match winner|1x2|game winner)/i.test(market)) return;
    for (const item of values) {
      const selection = String(item.value ?? item.name ?? item.label ?? "").toLowerCase().trim();
      const odd = n(item.odd ?? item.odds ?? item.price);
      if (odd === null || odd <= 1) continue;
      if (homeTerms.has(selection) || selection.includes(String(homeName || "___").toLowerCase())) {
        if (home === null || odd > home) { home = odd; bookmaker = node.bookmaker?.name ?? node.bookmaker ?? bookmaker; }
      }
      if (awayTerms.has(selection) || selection.includes(String(awayName || "___").toLowerCase())) {
        if (away === null || odd > away) { away = odd; bookmaker = node.bookmaker?.name ?? node.bookmaker ?? bookmaker; }
      }
    }
  });
  return { home, away, bookmaker };
}
function normalizedImplied(oddsA, oddsB) {
  const a = oddsA > 1 ? 1 / oddsA : null, b = oddsB > 1 ? 1 / oddsB : null;
  if (a === null || b === null) return [a === null ? null : a * 100, b === null ? null : b * 100];
  return [Number((a / (a + b) * 100).toFixed(2)), Number((b / (a + b) * 100).toFixed(2))];
}
function makePick({ sport, id, league, date, homeName, awayName, side, odds, probability, bookmaker, probabilitySource }) {
  const isTennis = sport === "tennis";
  const chosenName = side === "home" ? homeName : awayName;
  return {
    key: side === "home" ? (isTennis ? "PLAYER1" : "HOME") : (isTennis ? "PLAYER2" : "AWAY"),
    label: isTennis ? `${chosenName} wygra` : (side === "home" ? "Zwycięstwo gospodarzy" : "Zwycięstwo gości"),
    probability, odds, edge: null,
    score: Math.round(probability),
    impliedProbability: probability,
    probabilitySource,
    bookmaker: bookmaker || null,
    marketMovement: { movement: "UNKNOWN", samples: 0, changePercent: null, confidence: 0 },
    exchange: { usable: false, status: "NOT_AVAILABLE_FOR_THIS_SPORT" },
    context: { probabilitySource, note: "Prawdopodobieństwo z kursów bukmacherskich po normalizacji marży; nie jest niezależną prognozą modelu." },
    sport, league,
    event: { id, event: `${homeName} – ${awayName}`, home: { name: homeName }, away: { name: awayName }, league, date }
  };
}
function finalize(sport, date, eventsCount, picks, source, diagnostics = {}) {
  const sorted = picks.filter(p => p.probability >= 58 && p.odds >= 1.2)
    .sort((a, b) => b.probability - a.probability || b.score - a.score);
  const unique = [], used = new Set();
  for (const pick of sorted) {
    const id = String(pick.event.id);
    if (used.has(id)) continue;
    used.add(id); unique.push(pick);
    if (unique.length >= 10) break;
  }
  return {
    source: "EXTERNAL_APIS", version: VERSION, sport, date, generatedAt: isoNow(),
    provider: source, scannedEvents: eventsCount, analyzedEvents: eventsCount,
    predictionRecords: 0, qualifiedEvents: unique.length, picks: unique,
    diagnostics: { rejectedEvents: Math.max(0, eventsCount - unique.length), reasons: unique.length ? {} : { NO_QUALIFIED_PICK: eventsCount }, ...diagnostics },
    exchange: { enabled: false, status: "NOT_AVAILABLE_FOR_THIS_SPORT", message: "Dane Exchange/WOM nie są dostępne dla tego źródła." },
    note: "Prawdopodobieństwa są wyliczone z kursów bukmacherskich i znormalizowane. To nie jest niezależna prognoza modelu."
  };
}
async function scanBasketball(date, apiKey) {
  const cached = getCached(`basketball:${date}`);
  if (cached) return cached;
  if (!apiKey) {
    const error = new Error("Brak klucza API-Sports dla koszykówki. Dodaj APISPORTS_BASKETBALL_KEY w zmiennych środowiskowych Render.");
    error.status = 503; error.code = "APISPORTS_BASKETBALL_KEY_MISSING"; throw error;
  }
  const headers = { "x-apisports-key": apiKey };
  const [gamesData, oddsData] = await Promise.all([
    request(`${APISPORTS_BASKETBALL_BASE}/games?date=${encodeURIComponent(date)}`, headers),
    request(`${APISPORTS_BASKETBALL_BASE}/odds?date=${encodeURIComponent(date)}`, headers)
  ]);
  const games = collect(gamesData).filter(g => {
    const d = String(g.date ?? g.game?.date ?? "").slice(0, 10);
    const state = String(g.status?.short ?? g.status?.long ?? "").toLowerCase();
    return (!d || d === date) && !/(finished|final|ended|cancelled|postponed|live|quarter|half)/i.test(state);
  }).slice(0, 100);
  const oddsRows = collect(oddsData);
  const picks = [];
  for (const game of games) {
    const id = n(game.id ?? game.game?.id);
    const homeName = game.teams?.home?.name ?? game.home?.name ?? game.home_team?.name;
    const awayName = game.teams?.away?.name ?? game.away?.name ?? game.away_team?.name;
    if (id === null || !homeName || !awayName) continue;
    const matching = oddsRows.filter(row => n(row.game?.id ?? row.game_id ?? row.id) === id);
    const parsed = bestBasketballOdds(matching.length ? matching : oddsRows, homeName, awayName);
    if (parsed.home === null || parsed.away === null) continue;
    const [homeProb, awayProb] = normalizedImplied(parsed.home, parsed.away);
    if (homeProb !== null) picks.push(makePick({ sport: "basketball", id, league: game.league?.name ?? game.league_name ?? "Koszykówka", date: game.date ?? date, homeName, awayName, side: "home", odds: parsed.home, probability: homeProb, bookmaker: parsed.bookmaker, probabilitySource: "API-SPORTS_BOOKMAKER_IMPLIED" }));
    if (awayProb !== null) picks.push(makePick({ sport: "basketball", id, league: game.league?.name ?? game.league_name ?? "Koszykówka", date: game.date ?? date, homeName, awayName, side: "away", odds: parsed.away, probability: awayProb, bookmaker: parsed.bookmaker, probabilitySource: "API-SPORTS_BOOKMAKER_IMPLIED" }));
  }
  return setCached(`basketball:${date}`, finalize("basketball", date, games.length, picks, "API-Sports Basketball", { oddsRecords: oddsRows.length }));
}
function tennisMatches(data) {
  const direct = collect(data);
  if (direct.length) return direct;
  const found = [];
  walk(data, node => { if ((node.player1 || node.player2) && (node.matchId || node.match_id || node.id)) found.push(node); });
  return found;
}
function tennisOdds(match) {
  let p1 = n(match.player1?.odd ?? match.player1?.odds ?? match.odds_player1 ?? match.odds1 ?? match.preMatchOdds?.player1 ?? match.preMatchOdds?.k1);
  let p2 = n(match.player2?.odd ?? match.player2?.odds ?? match.odds_player2 ?? match.odds2 ?? match.preMatchOdds?.player2 ?? match.preMatchOdds?.k2);
  let bookmaker = null;
  walk(match.preMatchOdds ?? match.odds ?? {}, node => {
    const a = n(node.k1 ?? node.player1 ?? node.odds_player1 ?? node.odd1);
    const b = n(node.k2 ?? node.player2 ?? node.odds_player2 ?? node.odd2);
    if (a > 1 && (p1 === null || a > p1)) { p1 = a; bookmaker = node.bookmaker?.name ?? node.bookmaker ?? bookmaker; }
    if (b > 1 && (p2 === null || b > p2)) { p2 = b; bookmaker = node.bookmaker?.name ?? node.bookmaker ?? bookmaker; }
  });
  return { p1: p1 > 1 ? p1 : null, p2: p2 > 1 ? p2 : null, bookmaker };
}
async function scanTennis(date, apiKey) {
  const cached = getCached(`tennis:${date}`);
  if (cached) return cached;
  if (!apiKey) {
    const error = new Error("Brak klucza Tennis API. Dodaj TENNIS_API_KEY w zmiennych środowiskowych Render.");
    error.status = 503; error.code = "TENNIS_API_KEY_MISSING"; throw error;
  }
  const headers = { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": TENNIS_API_HOST };
  const url = `${TENNIS_API_BASE}/tennis/v2/upcoming/matches?date=${encodeURIComponent(date)}&include=preMatchOdds,predictionSummary&limit=100`;
  const data = await request(url, headers);
  const matches = tennisMatches(data).filter(match => {
    const d = String(match.date ?? match.startTime ?? match.start_time ?? "").slice(0, 10);
    return !d || d === date;
  }).slice(0, 100);
  const picks = [];
  for (const match of matches) {
    const id = n(match.matchId ?? match.match_id ?? match.id);
    const homeName = match.player1?.name ?? match.player1_name ?? match.player1Name;
    const awayName = match.player2?.name ?? match.player2_name ?? match.player2Name;
    if (id === null || !homeName || !awayName) continue;
    const odds = tennisOdds(match);
    if (odds.p1 === null || odds.p2 === null) continue;
    const [p1, p2] = normalizedImplied(odds.p1, odds.p2);
    const league = match.tournament?.name ?? match.tournamentName ?? match.tournament_name ?? "Tenis";
    if (p1 !== null) picks.push(makePick({ sport: "tennis", id, league, date: match.date ?? date, homeName, awayName, side: "home", odds: odds.p1, probability: p1, bookmaker: odds.bookmaker, probabilitySource: "TENNIS_API_BOOKMAKER_IMPLIED" }));
    if (p2 !== null) picks.push(makePick({ sport: "tennis", id, league, date: match.date ?? date, homeName, awayName, side: "away", odds: odds.p2, probability: p2, bookmaker: odds.bookmaker, probabilitySource: "TENNIS_API_BOOKMAKER_IMPLIED" }));
  }
  return setCached(`tennis:${date}`, finalize("tennis", date, matches.length, picks, "Tennis API (RapidAPI)", { oddsRecords: matches.filter(m => tennisOdds(m).p1 && tennisOdds(m).p2).length }));
}
async function scanExtraSport(sport, date, config = {}) {
  if (sport === "basketball") return scanBasketball(date, config.apisportsBasketballKey || "");
  if (sport === "tennis") return scanTennis(date, config.tennisApiKey || "");
  const error = new Error("Nieobsługiwany sport."); error.status = 400; error.code = "UNSUPPORTED_SPORT"; throw error;
}
export { scanExtraSport };
