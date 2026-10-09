const VERSION = "7.4.4";
const SPORT_SCORE_BASE = "https://sportscore.com/api/v1";
const scanCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const n = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const isoNow = () => new Date().toISOString();
function getCached(key) {
  const item = scanCache.get(key);
  if (!item || Date.now() - item.time > CACHE_TTL_MS) { scanCache.delete(key); return null; }
  return item.value;
}
function setCached(key, value) { scanCache.set(key, { time: Date.now(), value }); return value; }
function collect(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["fixtures", "matches", "results", "events", "items", "response", "data"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.data && typeof data.data === "object") return collect(data.data);
  return [];
}
async function requestFixtures(sport, date) {
  const url = new URL(`${SPORT_SCORE_BASE}/fixtures/`);
  url.searchParams.set("sport", sport);
  url.searchParams.set("date", date);
  url.searchParams.set("status", "upcoming");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.detail || `SportScore HTTP ${response.status}`);
    error.status = response.status;
    error.code = response.status === 429 ? "SPORTS_DATA_RATE_LIMIT" : `SPORTS_DATA_HTTP_${response.status}`;
    throw error;
  }
  return data;
}
function normalizeMatch(raw, index, sport) {
  const home = raw.home ?? raw.home_team ?? raw.player1 ?? raw.competitors?.[0]?.name ?? raw.participants?.[0]?.name ?? "";
  const away = raw.away ?? raw.away_team ?? raw.player2 ?? raw.competitors?.[1]?.name ?? raw.participants?.[1]?.name ?? "";
  const homeName = typeof home === "string" ? home : (home?.name ?? home?.short_name ?? "");
  const awayName = typeof away === "string" ? away : (away?.name ?? away?.short_name ?? "");
  if (!homeName || !awayName) return null;
  const time = raw.time ?? raw.date ?? raw.start_time ?? raw.startTime ?? raw.utcDate ?? null;
  const league = raw.competition?.name ?? raw.league?.name ?? raw.tournament?.name ?? raw.competition_name ?? raw.league_name ?? raw.tournament_name ?? (typeof raw.competition === "string" ? raw.competition : null) ?? (sport === "tennis" ? "Tenis" : "Koszykówka");
  const status = raw.status_text ?? raw.statusText ?? raw.status ?? "Nadchodzący";
  return {
    id: raw.id ?? raw.fixture_id ?? raw.match_id ?? raw.slug ?? `${sport}-${index}`,
    event: `${homeName} – ${awayName}`,
    home: { name: homeName }, away: { name: awayName },
    league, date: time, status: typeof status === "object" ? (status.long ?? status.name ?? "Nadchodzący") : status,
    slug: raw.slug ?? null,
    homeScore: n(raw.home_score ?? raw.score?.home ?? raw.scores?.home),
    awayScore: n(raw.away_score ?? raw.score?.away ?? raw.scores?.away)
  };
}
async function scanSportScore(sport, date) {
  const cached = getCached(`${sport}:${date}`);
  if (cached) return cached;
  const raw = await requestFixtures(sport, date);
  const matches = collect(raw).map((m, i) => normalizeMatch(m, i, sport)).filter(Boolean).slice(0, 100);
  return setCached(`${sport}:${date}`, {
    source: "EXTERNAL_APIS", version: VERSION, sport, date, generatedAt: isoNow(),
    provider: "SportScore", scannedEvents: matches.length, analyzedEvents: 0,
    predictionRecords: 0, qualifiedEvents: 0, picks: [], matches,
    diagnostics: { rejectedEvents: 0, reasons: matches.length ? {} : { NO_FIXTURES_RETURNED: 0 } },
    exchange: { enabled: false, status: "NOT_AVAILABLE_FOR_THIS_SPORT", message: "Dane Exchange/WOM nie są dostępne dla tego źródła." },
    note: "SportScore udostępnia terminarze i wyniki. To źródło nie zwraca kursów bukmacherskich w tym endpointcie, więc aplikacja nie tworzy na ich podstawie typów ani fikcyjnych prawdopodobieństw."
  });
}
async function scanExtraSport(sport, date) {
  if (sport !== "basketball" && sport !== "tennis") {
    const error = new Error("Nieobsługiwany sport."); error.status = 400; error.code = "UNSUPPORTED_SPORT"; throw error;
  }
  return scanSportScore(sport, date);
}
export { scanExtraSport };
