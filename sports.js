const VERSION = "7.4.4";
const ROOT = "https://sports.bzzoiro.com";

const rows = value => Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : Array.isArray(value?.data) ? value.data : [];
const n = value => Number.isFinite(Number(value)) ? Number(value) : null;
const percent = value => {
  const v = n(value);
  return v === null ? null : Number((v <= 1 ? v * 100 : v).toFixed(2));
};
const isoNow = () => new Date().toISOString();

async function requestSport(sport, path, apiKey) {
  const base = `${ROOT}/${sport}/api/v2`;
  const response = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!response.ok) {
    const error = new Error(data?.detail || data?.error || `BSD HTTP ${response.status}`);
    error.status = response.status;
    error.code = response.status === 402 ? "SPORTS_ADDON_REQUIRED" : response.status === 401 ? "BSD_AUTH_REQUIRED" : `BSD_HTTP_${response.status}`;
    throw error;
  }
  return data;
}

function eventIdOfPrediction(p, sport) {
  return n(sport === "tennis" ? (p.match_id ?? p.match?.id) : (p.event_id ?? p.event?.id));
}

function movement(value) {
  const raw = String(value || "UNKNOWN").toUpperCase();
  return ["SHORTENING", "DRIFTING", "STABLE"].includes(raw) ? raw : "UNKNOWN";
}

function bestOdds(rows, field) {
  const values = rows.map(row => ({
    odds: n(row?.[field]),
    movement: movement(row?.[`movement_${field.replace("odds_", "")}`] ?? row?.[`movement_${field.replace("odds_", "")}`]),
    bookmaker: row?.bookmaker ?? null
  })).filter(row => row.odds !== null && row.odds > 1);
  return values.sort((a, b) => b.odds - a.odds)[0] || null;
}

function sportScore(probability, odds, confidence) {
  const impliedProbability = 100 / odds;
  const confidenceValue = confidence ?? probability;
  return Math.round(Math.max(0, Math.min(100, probability * 0.65 + confidenceValue * 0.2 + impliedProbability * 0.15)));
}

async function scanExtraSport(sport, date, apiKey) {
  if (!["basketball", "tennis"].includes(sport)) {
    const error = new Error("Nieobsługiwany sport.");
    error.status = 400;
    error.code = "UNSUPPORTED_SPORT";
    throw error;
  }
  if (!apiKey) {
    const error = new Error("Backend nie ma skonfigurowanego klucza BSD.");
    error.status = 503;
    error.code = "BSD_NOT_CONFIGURED";
    throw error;
  }

  const isTennis = sport === "tennis";
  const eventPath = isTennis
    ? `/matches/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&status=scheduled&limit=200`
    : `/events/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&status=scheduled&limit=200`;
  const predictionPath = isTennis
    ? `/predictions/?date_from=${encodeURIComponent(date)}&date_to=${encodeURIComponent(date)}&upcoming=true&limit=200`
    : "/predictions/?days=3&limit=200";

  const [eventData, predictionData] = await Promise.all([
    requestSport(sport, eventPath, apiKey),
    requestSport(sport, predictionPath, apiKey)
  ]);
  const events = rows(eventData).filter(event => {
    const eventDate = String(event.match_date ?? event.event_date ?? event.date ?? "");
    return !eventDate || eventDate.slice(0, 10) === date;
  }).slice(0, 40);
  const predictions = new Map(rows(predictionData).map(p => [String(eventIdOfPrediction(p, sport)), p]).filter(([id]) => id !== "null"));

  const picks = [];
  const audit = [];
  let analyzed = 0;
  const batches = [];
  for (let i = 0; i < events.length; i += 8) batches.push(events.slice(i, i + 8));

  for (const batch of batches) {
    const enriched = await Promise.all(batch.map(async event => {
      const id = n(event.id);
      const prediction = predictions.get(String(id));
      if (!prediction) return { event, prediction: null, oddsData: null };
      let oddsData = event;
      const hasOdds = isTennis
        ? n(event.odds_player1) > 1 && n(event.odds_player2) > 1
        : n(event.odds_home) > 1 || n(event.odds_away) > 1;
      if (!hasOdds) {
        try {
          const path = isTennis ? `/matches/${id}/odds/` : `/events/${id}/odds/`;
          oddsData = { ...event, ...(await requestSport(sport, path, apiKey)) };
        } catch (error) {
          if (error.status === 402 || error.status === 401) throw error;
          oddsData = event;
        }
      }
      return { event, prediction, oddsData };
    }));
    for (const item of enriched) {
      if (!item.prediction) continue;
      analyzed++;
      const { event, prediction, oddsData } = item;
      const id = n(event.id);
      const homeProb = percent(isTennis
        ? (prediction.player1_win_prob ?? prediction.player1WinProb)
        : (prediction.home_win_prob ?? prediction.homeWinProb));
      const awayProb = percent(isTennis
        ? (prediction.player2_win_prob ?? prediction.player2WinProb)
        : (prediction.away_win_prob ?? prediction.awayWinProb));
      if (homeProb === null || awayProb === null) continue;
      const bookmakerRows = Array.isArray(oddsData.bookmakers) ? oddsData.bookmakers : [];
      const homeOdds = isTennis
        ? n(oddsData.odds_player1) ?? bestOdds(bookmakerRows, "odds_home")?.odds
        : n(oddsData.odds_home) ?? bestOdds(bookmakerRows, "odds_home")?.odds;
      const awayOdds = isTennis
        ? n(oddsData.odds_player2) ?? bestOdds(bookmakerRows, "odds_away")?.odds
        : n(oddsData.odds_away) ?? bestOdds(bookmakerRows, "odds_away")?.odds;
      const homeMovement = movement(isTennis ? null : bestOdds(bookmakerRows, "odds_home")?.movement);
      const awayMovement = movement(isTennis ? null : bestOdds(bookmakerRows, "odds_away")?.movement);
      const league = isTennis
        ? (event.tournament?.name ?? event.tournament_name ?? "Tenis")
        : (event.league?.name ?? event.league_name ?? "Koszykówka");
      const homeName = isTennis
        ? (event.player1?.name ?? event.player1_name ?? "Zawodnik 1")
        : (event.home_team?.name ?? event.home_team_name ?? "Gospodarze");
      const awayName = isTennis
        ? (event.player2?.name ?? event.player2_name ?? "Zawodnik 2")
        : (event.away_team?.name ?? event.away_team_name ?? "Goście");
      const candidates = [
        { key: isTennis ? "PLAYER1" : "HOME", label: isTennis ? `${homeName} wygra` : "Zwycięstwo gospodarzy", probability: homeProb, odds: homeOdds, move: homeMovement },
        { key: isTennis ? "PLAYER2" : "AWAY", label: isTennis ? `${awayName} wygra` : "Zwycięstwo gości", probability: awayProb, odds: awayOdds, move: awayMovement }
      ];
      const valid = candidates.filter(c => c.odds !== null && c.odds >= 1.2 && c.probability >= 58 && c.move !== "DRIFTING")
        .map(c => ({
          ...c,
          score: sportScore(c.probability, c.odds, percent(prediction.confidence)),
          edge: Number((c.probability - 100 / c.odds).toFixed(2))
        }))
        .filter(c => c.score >= 58)
        .sort((a, b) => b.probability - a.probability || b.score - a.score);
      for (const c of candidates) {
        audit.push({ event: `${homeName} – ${awayName}`, key: c.key, probability: c.probability, odds: c.odds, movement: c.move, qualified: valid.some(v => v.key === c.key) });
      }
      const chosen = valid[0];
      if (!chosen) continue;
      const movementInfo = { movement: chosen.move, samples: 0, changePercent: null, confidence: 0 };
      picks.push({
        key: chosen.key,
        label: chosen.label,
        probability: chosen.probability,
        odds: chosen.odds,
        edge: chosen.edge,
        score: chosen.score,
        impliedProbability: Number((100 / chosen.odds).toFixed(2)),
        marketMovement: movementInfo,
        exchange: { usable: false, status: "NOT_AVAILABLE_FOR_THIS_SPORT" },
        context: {},
        sport,
        league,
        event: {
          id,
          event: `${homeName} – ${awayName}`,
          home: { name: homeName },
          away: { name: awayName },
          league,
          date: event.match_date ?? event.event_date ?? event.date ?? null
        }
      });
    }
  }

  picks.sort((a, b) => b.probability - a.probability || b.score - a.score);
  const uniquePicks = [];
  const used = new Set();
  for (const pick of picks) {
    const id = String(pick.event.id);
    if (used.has(id)) continue;
    used.add(id);
    uniquePicks.push(pick);
    if (uniquePicks.length >= 10) break;
  }
  return {
    source: "BSD",
    version: VERSION,
    sport,
    date,
    generatedAt: isoNow(),
    scannedEvents: events.length,
    analyzedEvents: analyzed,
    predictionRecords: predictions.size,
    qualifiedEvents: uniquePicks.length,
    picks: uniquePicks,
    diagnostics: {
      rejectedEvents: Math.max(0, events.length - analyzed),
      reasons: uniquePicks.length ? {} : { NO_QUALIFIED_PICK: analyzed || events.length },
      candidateAudit: audit.slice(0, 20)
    },
    exchange: { enabled: false, status: "NOT_AVAILABLE_FOR_THIS_SPORT", message: "WOM/Exchange pozostaje dostępny tylko w obsługiwanym feedzie piłkarskim." }
  };
}

export { scanExtraSport };
