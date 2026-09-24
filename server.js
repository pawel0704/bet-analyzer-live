import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE = "https://sports.bzzoiro.com/api/v2";

const VERSION = "6.5.1";
const SOURCE = "BSD";

const CONFIG = {
  maxEvents: 50,
  topPicksLimit: 10,

  // HIGH PROBABILITY — wracamy do sprawdzonej logiki 6.4.2
  highProbabilityMin: 65,
  highProbabilityScoreMin: 50,
  highProbabilityValueMin: -6.5,
  minimumOddsForHighProbability: 1.20,

  // STRONG PICK jest klasyfikacją dodatkową,
  // a nie osobną barierą dla HIGH_PROBABILITY
  strongPickProbabilityMin: 70,
  strongPickScoreMin: 60,
  strongPickValueMin: -3,

  // VALUE
  valueProbabilityMin: 35,
  valueScoreMin: 55,
  valueMin: 5,

  requestTimeoutMs: 12000,
  retries: 1
};

if (!BSD_API_KEY) {
  console.warn("WARNING: BSD_API_KEY is not configured.");
}

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isUpcomingEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "notstarted",
    "not_started",
    "scheduled",
    "upcoming",
    "pending"
  ].includes(status);
}

function isLiveEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "live",
    "inplay",
    "in_play",
    "playing"
  ].includes(status);
}

function isFinishedEvent(event) {
  const status = normalizeStatus(event?.status);

  return [
    "finished",
    "cancelled",
    "canceled",
    "postponed",
    "abandoned",
    "suspended"
  ].includes(status);
}

function normalizeDateInput(date) {
  if (!date) {
    return new Date().toISOString().slice(0, 10);
  }

  const match = String(date).match(/^(\d{4}-\d{2}-\d{2})/);

  return match ? match[1] : String(date);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bsdFetch(path, options = {}) {
  const url = path.startsWith("http")
    ? path
    : `${BSD_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeoutMs
    );

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Authorization: `Token ${BSD_API_KEY}`,
          Accept: "application/json",
          ...(options.headers || {})
        },
        body: options.body,
        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await response.text();

      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        const error = new Error(
          `BSD ${response.status}: ${
            typeof data === "string"
              ? data
              : JSON.stringify(data)
          }`
        );

        error.status = response.status;
        error.data = data;

        throw error;
      }

      return {
        ok: true,
        status: response.status,
        data
      };
    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (attempt < CONFIG.retries) {
        await sleep(350 * (attempt + 1));
      }
    }
  }

  return {
    ok: false,
    error: lastError?.message || "BSD request failed",
    status: lastError?.status || null,
    data: lastError?.data || null
  };
}

function extractResults(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  const candidates = [
    data.results,
    data.data,
    data.events,
    data.items,
    data.matches
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (candidate && Array.isArray(candidate.results)) {
      return candidate.results;
    }

    if (candidate && Array.isArray(candidate.data)) {
      return candidate.data;
    }
  }

  return [];
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const home = firstDefined(
    event.home_team,
    event.homeTeam,
    event.home,
    event.home_name,
    event.homeTeamName
  );

  const away = firstDefined(
    event.away_team,
    event.awayTeam,
    event.away,
    event.away_name,
    event.awayTeamName
  );

  const eventDate = firstDefined(
    event.event_date,
    event.date,
    event.start_time,
    event.startTime,
    event.kickoff
  );

  const id = num(
    firstDefined(
      event.id,
      event.event_id,
      event.eventId
    )
  );

  if (!id) {
    return null;
  }

  return {
    ...event,
    id,
    eventId: id,
    home: home || "Unknown",
    away: away || "Unknown",
    home_team: home || "Unknown",
    away_team: away || "Unknown",
    date: eventDate || null,
    event_date: eventDate || null,
    status: normalizeStatus(event.status),
    league: firstDefined(
      event.league_name,
      event.league,
      event.leagueName
    ),
    leagueId: num(
      firstDefined(
        event.league_id,
        event.leagueId
      )
    )
  };
}

async function getEvents(date) {
  const dateValue = normalizeDateInput(date);

  const paths = [
    `/events?date=${encodeURIComponent(dateValue)}`,
    `/events?from=${encodeURIComponent(dateValue)}&to=${encodeURIComponent(dateValue)}`,
    `/events?start_date=${encodeURIComponent(dateValue)}&end_date=${encodeURIComponent(dateValue)}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (!result.ok) {
      continue;
    }

    const rows = extractResults(result.data);

    if (rows.length > 0) {
      return rows
        .map(normalizeEvent)
        .filter(Boolean);
    }
  }

  return [];
}

async function getEventDetail(eventId) {
  const paths = [
    `/events/${eventId}`,
    `/event/${eventId}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result.ok && result.data) {
      return result.data;
    }
  }

  return null;
}

async function getResource(resource, eventId) {
  const paths = [
    `/${resource}?event_id=${eventId}`,
    `/${resource}/${eventId}`,
    `/events/${eventId}/${resource}`
  ];

  for (const path of paths) {
    const result = await bsdFetch(path);

    if (result.ok && result.data) {
      return result.data;
    }
  }

  return null;
}

function parsePrediction(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.prediction ||
    raw.data ||
    raw;

  const event =
    source?.event ||
    raw?.event ||
    null;

  const markets =
    source?.markets ||
    raw?.markets ||
    {};

  const matchResult =
    markets?.match_result ||
    markets?.matchResult ||
    {};

  const expectedGoals =
    markets?.expected_goals ||
    markets?.expectedGoals ||
    {};

  const overUnder =
    markets?.over_under ||
    markets?.overUnder ||
    {};

  const btts =
    markets?.btts ||
    {};

  const model =
    source?.model ||
    raw?.model ||
    {};

  const home = num(
    firstDefined(
      source?.home,
      source?.prob_home,
      matchResult?.prob_home,
      matchResult?.home
    )
  );

  const draw = num(
    firstDefined(
      source?.draw,
      source?.prob_draw,
      matchResult?.prob_draw,
      matchResult?.draw
    )
  );

  const away = num(
    firstDefined(
      source?.away,
      source?.prob_away,
      matchResult?.prob_away,
      matchResult?.away
    )
  );

  const over15 = num(
    firstDefined(
      source?.over15,
      source?.prob_over_15,
      overUnder?.prob_over_15
    )
  );

  const over25 = num(
    firstDefined(
      source?.over25,
      source?.prob_over_25,
      overUnder?.prob_over_25
    )
  );

  const over35 = num(
    firstDefined(
      source?.over35,
      source?.prob_over_35,
      overUnder?.prob_over_35
    )
  );

  const bttsYes = num(
    firstDefined(
      source?.bttsYes,
      source?.prob_btts_yes,
      btts?.prob_yes
    )
  );

  const xgHome = num(
    firstDefined(
      source?.xgHome,
      source?.xg_home,
      expectedGoals?.home
    )
  );

  const xgAway = num(
    firstDefined(
      source?.xgAway,
      source?.xg_away,
      expectedGoals?.away
    )
  );

  const confidence = num(
    firstDefined(
      source?.confidence,
      model?.confidence
    )
  );

  const predicted = firstDefined(
    source?.predicted,
    matchResult?.predicted,
    source?.recommendations?.favorite
  );

  const mostLikelyScore = firstDefined(
    source?.mostLikelyScore,
    source?.most_likely_score,
    markets?.score?.most_likely
  );

  const available = [
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes
  ].some(value => value !== null);

  return {
    available,
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    bttsYes,
    xgHome,
    xgAway,
    confidence,
    predicted,
    mostLikelyScore,
    raw
  };
}

function parseOdds(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.odds ||
    raw.data ||
    raw;

  const markets =
    source?.markets ||
    raw?.markets ||
    {};

  const result =
    markets?.match_result ||
    markets?.matchResult ||
    {};

  const totals =
    markets?.over_under ||
    markets?.overUnder ||
    {};

  const btts =
    markets?.btts ||
    {};

  const home = num(
    firstDefined(
      source?.home,
      source?.home_win,
      result?.home,
      result?.home_win
    )
  );

  const draw = num(
    firstDefined(
      source?.draw,
      result?.draw
    )
  );

  const away = num(
    firstDefined(
      source?.away,
      source?.away_win,
      result?.away,
      result?.away_win
    )
  );

  const over15 = num(
    firstDefined(
      source?.over15,
      source?.over_15,
      totals?.over15,
      totals?.over_15
    )
  );

  const under15 = num(
    firstDefined(
      source?.under15,
      source?.under_15,
      totals?.under15,
      totals?.under_15
    )
  );

  const over25 = num(
    firstDefined(
      source?.over25,
      source?.over_25,
      totals?.over25,
      totals?.over_25
    )
  );

  const under25 = num(
    firstDefined(
      source?.under25,
      source?.under_25,
      totals?.under25,
      totals?.under_25
    )
  );

  const over35 = num(
    firstDefined(
      source?.over35,
      source?.over_35,
      totals?.over35,
      totals?.over_35
    )
  );

  const under35 = num(
    firstDefined(
      source?.under35,
      source?.under_35,
      totals?.under35,
      totals?.under_35
    )
  );

  const bttsYes = num(
    firstDefined(
      source?.bttsYes,
      source?.btts_yes,
      btts?.yes
    )
  );

  const bttsNo = num(
    firstDefined(
      source?.bttsNo,
      source?.btts_no,
      btts?.no
    )
  );

  const updatedAt = firstDefined(
    raw?.updated_at,
    raw?.updatedAt,
    source?.updated_at,
    source?.updatedAt
  );

  const lastChangeAt = firstDefined(
    raw?.last_change_at,
    raw?.lastChangeAt,
    source?.last_change_at,
    source?.lastChangeAt
  );

  const nextUpdateAt = firstDefined(
    raw?.next_update_at,
    raw?.nextUpdateAt,
    source?.next_update_at,
    source?.nextUpdateAt
  );

  const interval = num(
    firstDefined(
      raw?.interval,
      source?.interval
    )
  );

  const reason = firstDefined(
    raw?.reason,
    source?.reason
  );

  const available = [
    home,
    draw,
    away,
    over15,
    under15,
    over25,
    under25,
    over35,
    under35,
    bttsYes,
    bttsNo
  ].some(value => value !== null);

  return {
    available,
    home,
    draw,
    away,
    over15,
    under15,
    over25,
    under25,
    over35,
    under35,
    bttsYes,
    bttsNo,
    updatedAt,
    lastChangeAt,
    nextUpdateAt,
    interval,
    reason,
    raw
  };
}

function parseH2H(raw) {
  if (!raw) {
    return {
      available: false,
      sampleSize: 0
    };
  }

  const source =
    raw.head_to_head ||
    raw.h2h ||
    raw.data ||
    raw;

  const matches = safeArray(
    firstDefined(
      source?.recent_matches,
      source?.matches,
      raw?.matches
    )
  );

  const sampleSize = num(
    firstDefined(
      source?.total_matches,
      source?.sample_size,
      matches.length
    )
  ) || 0;

  return {
    available:
      sampleSize > 0 ||
      matches.length > 0,

    sampleSize,

    homeWins: num(
      firstDefined(
        source?.home_wins,
        source?.homeWins
      )
    ),

    draws: num(source?.draws),

    awayWins: num(
      firstDefined(
        source?.away_wins,
        source?.awayWins
      )
    ),

    homeGoals: num(
      firstDefined(
        source?.home_goals,
        source?.homeGoals
      )
    ),

    awayGoals: num(
      firstDefined(
        source?.away_goals,
        source?.awayGoals
      )
    ),

    averageGoals: num(
      firstDefined(
        source?.avg_total_goals,
        source?.average_goals,
        source?.averageGoals
      )
    ),

    matches,
    raw
  };
}

function parseH2HWithFallback(raw, eventDetail) {
  const parsed = parseH2H(raw);

  if (parsed.available) {
    return parsed;
  }

  const fallback =
    eventDetail?.head_to_head ||
    eventDetail?.h2h ||
    eventDetail?.event?.head_to_head ||
    eventDetail?.event?.h2h;

  if (!fallback) {
    return parsed;
  }

  return parseH2H({
    head_to_head: fallback
  });
}

function parseForm(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.form ||
    raw.data ||
    raw;

  const matches = safeArray(
    firstDefined(
      source?.matches,
      source?.recent,
      source?.results
    )
  );

  return {
    available: matches.length > 0,
    matches,
    raw
  };
}

function parseStats(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.stats ||
    raw.data ||
    raw;

  const numericKeys = [
    "possession",
    "shots",
    "shots_on_target",
    "corners",
    "xg",
    "goals",
    "dangerous_attacks"
  ];

  const hasNumericData =
    numericKeys.some(key =>
      num(source?.[key]) !== null
    );

  return {
    available: hasNumericData,
    possession: num(source?.possession),
    shots: num(source?.shots),

    shotsOnTarget: num(
      firstDefined(
        source?.shots_on_target,
        source?.shotsOnTarget
      )
    ),

    corners: num(source?.corners),
    xg: num(source?.xg),
    goals: num(source?.goals),
    raw
  };
}

function parseLineups(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.lineups ||
    raw.data?.lineups ||
    raw.data ||
    raw;

  const home =
    source?.home ||
    source?.home_team ||
    {};

  const away =
    source?.away ||
    source?.away_team ||
    {};

  const homePlayers =
    safeArray(home?.players);

  const awayPlayers =
    safeArray(away?.players);

  const homeCount =
    num(
      firstDefined(
        raw?.lineups?.home?.players_count,
        home?.players_count,
        homePlayers.length
      )
    ) || 0;

  const awayCount =
    num(
      firstDefined(
        raw?.lineups?.away?.players_count,
        away?.players_count,
        awayPlayers.length
      )
    ) || 0;

  const status =
    firstDefined(
      raw?.lineup_status,
      raw?.status
    );

  const available =
    homeCount > 0 ||
    awayCount > 0 ||
    Boolean(status);

  return {
    available,

    score:
      homeCount >= 11 &&
      awayCount >= 11
        ? 2
        : available
          ? 1
          : 0,

    details: {
      homePlayers: homeCount,
      awayPlayers: awayCount,

      completeHome:
        homeCount >= 11,

      completeAway:
        awayCount >= 11,

      homeFormation:
        firstDefined(
          home?.formation,
          null
        ),

      awayFormation:
        firstDefined(
          away?.formation,
          null
        ),

      status: status || null
    },

    raw
  };
}

function parseReferee(raw) {
  if (!raw) {
    return {
      available: false
    };
  }

  const source =
    raw.referee ||
    raw.data ||
    raw;

  const id =
    firstDefined(
      source?.id,
      source?.referee_id
    );

  const name =
    firstDefined(
      source?.name,
      source?.referee_name
    );

  return {
    available:
      Boolean(id || name),

    id: id || null,
    name: name || null,
    raw
  };
}

function parseBookmakerMovement(raw) {
  if (!raw) {
    return {
      available: false,
      direction: "UNKNOWN",
      percent: null,
      lastChangeAt: null,
      note:
        "Previous bookmaker odds are not available."
    };
  }

  const source =
    raw.movement ||
    raw.data ||
    raw;

  const percent = num(
    firstDefined(
      source?.percent,
      source?.change_percent,
      source?.changePercent
    )
  );

  let direction =
    firstDefined(
      source?.direction,
      source?.trend
    );

  if (!direction && percent !== null) {
    if (percent > 0.15) {
      direction = "UP";
    } else if (percent < -0.15) {
      direction = "DOWN";
    } else {
      direction = "STABLE";
    }
  }

  return {
    available:
      percent !== null ||
      Boolean(direction),

    direction:
      direction || "UNKNOWN",

    percent,

    lastChangeAt:
      firstDefined(
        source?.last_change_at,
        source?.lastChangeAt,
        raw?.last_change_at,
        raw?.lastChangeAt
      ),

    note:
      percent === null
        ? "Previous bookmaker odds are not available."
        : "Bookmaker movement data available.",

    raw
  };
}

function exchangeStatus() {
  return {
    connected: false,

    status:
      "EXCHANGE_UNAVAILABLE",

    reason:
      "No verified betting-exchange feed is connected. No exchange signal is fabricated."
  };
}

function impliedProbability(odds) {
  const value = num(odds);

  if (
    value === null ||
    value <= 1
  ) {
    return null;
  }

  return 100 / value;
}

function calculateValue(probability, odds) {
  const p = num(probability);
  const o = num(odds);

  if (
    p === null ||
    o === null ||
    o <= 1
  ) {
    return null;
  }

  return p - impliedProbability(o);
}

function getDataQuality(bundle) {
  let points = 0;

  if (bundle.prediction?.available) {
    points += 3;
  }

  if (
    bundle.prediction?.xgHome !== null &&
    bundle.prediction?.xgAway !== null
  ) {
    points += 2;
  }

  if (bundle.lineups?.available) {
    points += 2;
  }

  if (
    bundle.lineups?.details?.completeHome &&
    bundle.lineups?.details?.completeAway
  ) {
    points += 1;
  }

  if (bundle.form?.available) {
    points += 2;
  }

  if (bundle.h2h?.sampleSize >= 3) {
    points += 1;
  }

  if (bundle.referee?.available) {
    points += 1;
  }

  if (bundle.stats?.available) {
    points += 1;
  }

  if (bundle.bookmakerMovement?.available) {
    points += 1;
  }

  return points;
}

function createCandidate(
  market,
  label,
  probability,
  odds,
  bundle
) {
  const p = num(probability);
  const o = num(odds);

  if (
    p === null ||
    o === null ||
    o <= 1
  ) {
    return null;
  }

  const implied =
    impliedProbability(o);

  const value =
    calculateValue(p, o);

  /*
   * PROBABILITY SCORE
   *
   * Nie jest karany za ujemne value.
   * Dzięki temu 72% nie znika tylko dlatego,
   * że kurs jest trochę za niski względem modelu.
   */
  let probabilityScore =
    p * 0.75;

  if (
    bundle.prediction?.xgHome !== null &&
    bundle.prediction?.xgAway !== null
  ) {
    probabilityScore += 3;
  }

  if (bundle.lineups?.available) {
    probabilityScore += 3;
  }

  if (
    bundle.lineups?.details?.completeHome &&
    bundle.lineups?.details?.completeAway
  ) {
    probabilityScore += 1;
  }

  if (bundle.form?.available) {
    probabilityScore += 3;
  }

  if (bundle.h2h?.sampleSize >= 3) {
    probabilityScore += 1;
  }

  if (bundle.referee?.available) {
    probabilityScore += 1;
  }

  probabilityScore = clamp(
    Number(
      probabilityScore.toFixed(2)
    ),
    0,
    100
  );

  /*
   * VALUE SCORE
   *
   * Pozostaje oddzielny od probabilityScore.
   */
  let valueScore =
    p * 0.70;

  if (value !== null) {
    valueScore +=
      clamp(value, -10, 10) * 2;
  }

  if (
    bundle.prediction?.xgHome !== null &&
    bundle.prediction?.xgAway !== null
  ) {
    valueScore += 2;
  }

  if (bundle.h2h?.sampleSize >= 3) {
    valueScore += 1;
  }

  if (bundle.lineups?.available) {
    valueScore += 2;
  }

  if (bundle.form?.available) {
    valueScore += 2;
  }

  valueScore = clamp(
    Number(
      valueScore.toFixed(2)
    ),
    0,
    100
  );

  const dataQuality =
    getDataQuality(bundle);

  const rejectionReasons = [];

  /*
   * Najpierw sprawdzamy twarde powody odrzucenia.
   */
  if (
    o <
    CONFIG.minimumOddsForHighProbability
  ) {
    rejectionReasons.push(
      `Odds below realistic minimum ${CONFIG.minimumOddsForHighProbability}`
    );
  }

  if (
    p <
    CONFIG.valueProbabilityMin
  ) {
    rejectionReasons.push(
      `Probability below ${CONFIG.valueProbabilityMin}%`
    );
  }

  if (
    p >= CONFIG.highProbabilityMin &&
    probabilityScore <
      CONFIG.highProbabilityScoreMin
  ) {
    rejectionReasons.push(
      `Probability score below ${CONFIG.highProbabilityScoreMin}`
    );
  }

  if (
    p >= CONFIG.highProbabilityMin &&
    value !== null &&
    value <
      CONFIG.highProbabilityValueMin
  ) {
    rejectionReasons.push(
      `Model value below ${CONFIG.highProbabilityValueMin}%`
    );
  }

  /*
   * HIGH PROBABILITY
   *
   * To jest główna ścieżka.
   */
  const highProbability =
    p >=
      CONFIG.highProbabilityMin &&
    probabilityScore >=
      CONFIG.highProbabilityScoreMin &&
    (value === null ||
      value >=
        CONFIG.highProbabilityValueMin) &&
    o >=
      CONFIG.minimumOddsForHighProbability;

  /*
   * STRONG PICK
   *
   * Jest tylko mocniejszą etykietą
   * dla już zaakceptowanego typu.
   */
  const strongPick =
    highProbability &&
    p >=
      CONFIG.strongPickProbabilityMin &&
    probabilityScore >=
      CONFIG.strongPickScoreMin &&
    (value === null ||
      value >=
        CONFIG.strongPickValueMin);

  /*
   * VALUE
   */
  const valuePick =
    p >=
      CONFIG.valueProbabilityMin &&
    valueScore >=
      CONFIG.valueScoreMin &&
    value !== null &&
    value >=
      CONFIG.valueMin &&
    o >= 1.20;

  let accepted = false;
  let qualificationType = "NONE";

  if (strongPick) {
    accepted = true;
    qualificationType =
      "STRONG_PICK";
  } else if (highProbability) {
    accepted = true;
    qualificationType =
      "HIGH_PROBABILITY";
  } else if (valuePick) {
    accepted = true;
    qualificationType =
      "VALUE";
  }

  /*
   * Jeśli VALUE kwalifikuje się mimo tego,
   * że nie spełnia HIGH PROBABILITY,
   * nie dodajemy powodów dotyczących
   * high probability.
   */
  if (accepted) {
    rejectionReasons.length = 0;
  }

  let priceAssessment =
    "UNKNOWN";

  if (value !== null) {
    if (value >= 5) {
      priceAssessment =
        "GOOD_VALUE";
    } else if (value >= 0) {
      priceAssessment =
        "FAIR_PRICE";
    } else if (value >= -3) {
      priceAssessment =
        "SLIGHTLY_EXPENSIVE";
    } else if (value >= -6.5) {
      priceAssessment =
        "NORMAL_PRICE";
    } else {
      priceAssessment =
        "EXPENSIVE";
    }
  }

  const reasons = [];

  if (p >= 65) {
    reasons.push(
      "High model probability"
    );
  }

  if (
    bundle.prediction?.xgHome !== null &&
    bundle.prediction?.xgAway !== null
  ) {
    reasons.push(
      "Expected-goals data available"
    );
  }

  if (
    bundle.lineups?.available &&
    bundle.lineups?.details?.completeHome &&
    bundle.lineups?.details?.completeAway
  ) {
    reasons.push(
      "Confirmed lineup data available"
    );
  } else if (
    bundle.lineups?.available
  ) {
    reasons.push(
      "Lineup data available"
    );
  }

  if (bundle.form?.available) {
    reasons.push(
      "Recent form data available"
    );
  }

  if (
    bundle.h2h?.sampleSize >= 3
  ) {
    reasons.push(
      "Sufficient H2H sample"
    );
  }

  if (bundle.referee?.available) {
    reasons.push(
      "Referee data available"
    );
  }

  if (
    value !== null &&
    value >= 5
  ) {
    reasons.push(
      "Positive model value"
    );
  } else if (
    value !== null &&
    value < 0
  ) {
    reasons.push(
      "Model value below bookmaker implied probability"
    );
  }

  if (
    bundle.bookmakerMovement?.available
  ) {
    if (
      bundle.bookmakerMovement.direction ===
      "DOWN"
    ) {
      reasons.push(
        "Bookmaker price moved down"
      );
    } else if (
      bundle.bookmakerMovement.direction ===
      "UP"
    ) {
      reasons.push(
        "Bookmaker price moved up"
      );
    } else if (
      bundle.bookmakerMovement.direction ===
      "STABLE"
    ) {
      reasons.push(
        "Bookmaker price stable"
      );
    }
  }

  return {
    market,
    label,

    probability:
      Number(p.toFixed(2)),

    odds:
      Number(o.toFixed(2)),

    impliedProbability:
      implied === null
        ? null
        : Number(
            implied.toFixed(2)
          ),

    valuePercent:
      value === null
        ? null
        : Number(
            value.toFixed(2)
          ),

    probabilityScore,
    valueScore,

    // frontend compatibility
    score: probabilityScore,

    dataQuality,

    accepted,
    qualificationType,
    priceAssessment,
    rejectionReasons,
    reasons,

    movement:
      bundle.bookmakerMovement,

    exchange:
      bundle.exchange,

    eventId:
      bundle.event?.id,

    home:
      bundle.event?.home,

    away:
      bundle.event?.away,

    date:
      bundle.event?.date,

    status:
      bundle.event?.status,

    league:
      bundle.event?.league,

    leagueId:
      bundle.event?.leagueId,

    prediction:
      bundle.prediction,

    h2h:
      bundle.h2h,

    form:
      bundle.form,

    stats:
      bundle.stats,

    lineups:
      bundle.lineups,

    referee:
      bundle.referee
  };
}

function buildCandidates(bundle) {
  const prediction =
    bundle.prediction;

  const odds =
    bundle.odds;

  if (
    !prediction?.available ||
    !odds?.available
  ) {
    return [];
  }

  const candidates = [];

  const add = (
    market,
    label,
    probability,
    price
  ) => {
    const candidate =
      createCandidate(
        market,
        label,
        probability,
        price,
        bundle
      );

    if (candidate) {
      candidates.push(candidate);
    }
  };

  add(
    "home",
    "Home win",
    prediction.home,
    odds.home
  );

  add(
    "draw",
    "Draw",
    prediction.draw,
    odds.draw
  );

  add(
    "away",
    "Away win",
    prediction.away,
    odds.away
  );

  add(
    "over15",
    "Over 1.5 goals",
    prediction.over15,
    odds.over15
  );

  add(
    "over25",
    "Over 2.5 goals",
    prediction.over25,
    odds.over25
  );

  add(
    "over35",
    "Over 3.5 goals",
    prediction.over35,
    odds.over35
  );

  add(
    "bttsYes",
    "Both teams to score",
    prediction.bttsYes,
    odds.bttsYes
  );

  return candidates;
}

async function getBundle(event) {
  const eventId = event.id;

  const [
    detailRaw,
    predictionRaw,
    oddsRaw,
    h2hRaw,
    formRaw,
    statsRaw,
    lineupsRaw,
    refereeRaw,
    movementRaw
  ] = await Promise.all([
    getEventDetail(eventId),
    getResource(
      "predictions",
      eventId
    ),
    getResource(
      "odds",
      eventId
    ),
    getResource(
      "head-to-head",
      eventId
    ),
    getResource(
      "form",
      eventId
    ),
    getResource(
      "stats",
      eventId
    ),
    getResource(
      "lineups",
      eventId
    ),
    getResource(
      "referee",
      eventId
    ),
    getResource(
      "odds/movement",
      eventId
    )
  ]);

  const detailEvent =
    detailRaw?.event ||
    detailRaw ||
    {};

  const normalizedDetail =
    normalizeEvent({
      ...event,

      ...detailEvent,

      id:
        firstDefined(
          detailEvent?.id,
          event.id
        ),

      home_team:
        firstDefined(
          detailEvent?.home_team,
          event.home
        ),

      away_team:
        firstDefined(
          detailEvent?.away_team,
          event.away
        ),

      event_date:
        firstDefined(
          detailEvent?.event_date,
          event.date
        ),

      status:
        firstDefined(
          detailEvent?.status,
          event.status
        ),

      league_name:
        firstDefined(
          detailEvent?.league_name,
          event.league
        ),

      league_id:
        firstDefined(
          detailEvent?.league_id,
          event.leagueId
        )
    });

  const mergedEvent = {
    ...event,
    ...(normalizedDetail || {})
  };

  const prediction =
    parsePrediction(
      predictionRaw
    );

  const odds =
    parseOdds(
      oddsRaw
    );

  const h2h =
    parseH2HWithFallback(
      h2hRaw,
      detailRaw
    );

  const form =
    parseForm(
      formRaw
    );

  const stats =
    parseStats(
      statsRaw
    );

  const lineups =
    parseLineups(
      lineupsRaw
    );

  const referee =
    parseReferee(
      refereeRaw
    );

  const bookmakerMovement =
    parseBookmakerMovement(
      movementRaw
    );

  const exchange =
    exchangeStatus();

  return {
    event:
      mergedEvent,

    detail:
      detailRaw,

    prediction,
    odds,
    h2h,
    form,
    stats,
    lineups,
    referee,
    bookmakerMovement,
    exchange
  };
}

async function analyzeEvent(event) {
  try {
    const bundle =
      await getBundle(event);

    if (
      !bundle.event.league &&
      bundle.prediction?.raw?.event?.league_name
    ) {
      bundle.event.league =
        bundle.prediction.raw.event.league_name;
    }

    if (
      !bundle.event.leagueId &&
      bundle.prediction?.raw?.event?.league_id
    ) {
      bundle.event.leagueId =
        num(
          bundle.prediction.raw.event.league_id
        );
    }

    const candidates =
      buildCandidates(
        bundle
      );

    const accepted =
      candidates
        .filter(
          candidate =>
            candidate.accepted
        )
        .sort(
          (a, b) => {
            const rank = {
              STRONG_PICK: 3,
              HIGH_PROBABILITY: 2,
              VALUE: 1,
              NONE: 0
            };

            const typeDifference =
              rank[b.qualificationType] -
              rank[a.qualificationType];

            if (
              typeDifference !== 0
            ) {
              return typeDifference;
            }

            if (
              b.probabilityScore !==
              a.probabilityScore
            ) {
              return (
                b.probabilityScore -
                a.probabilityScore
              );
            }

            return (
              (b.valueScore || 0) -
              (a.valueScore || 0)
            );
          }
        );

    /*
     * Diagnostic:
     * pokazujemy wszystkie kandydaty,
     * także odrzucone, ale bez zwracania
     * ogromnego raw payloadu.
     */
    const diagnostics =
      candidates.map(
        candidate => ({
          market:
            candidate.market,

          label:
            candidate.label,

          probability:
            candidate.probability,

          odds:
            candidate.odds,

          valuePercent:
            candidate.valuePercent,

          probabilityScore:
            candidate.probabilityScore,

          valueScore:
            candidate.valueScore,

          dataQuality:
            candidate.dataQuality,

          accepted:
            candidate.accepted,

          qualificationType:
            candidate.qualificationType,

          priceAssessment:
            candidate.priceAssessment,

          rejectionReasons:
            candidate.rejectionReasons
        })
      );

    return {
      ok: true,
      version: VERSION,
      source: SOURCE,

      event:
        bundle.event,

      prediction:
        bundle.prediction,

      odds:
        bundle.odds,

      h2h:
        bundle.h2h,

      form:
        bundle.form,

      stats:
        bundle.stats,

      lineups:
        bundle.lineups,

      referee:
        bundle.referee,

      bookmakerMovement:
        bundle.bookmakerMovement,

      exchange:
        bundle.exchange,

      candidates,

      diagnostics,

      acceptedCandidates:
        accepted,

      bestPick:
        accepted[0] || null
    };
  } catch (error) {
    return {
      ok: false,
      version: VERSION,
      source: SOURCE,

      event,

      error:
        error.message
    };
  }
}

function pickRankingScore(pick) {
  const typeWeight = {
    STRONG_PICK: 30,
    HIGH_PROBABILITY: 20,
    VALUE: 10
  };

  let score =
    typeWeight[
      pick.qualificationType
    ] || 0;

  score +=
    pick.probabilityScore || 0;

  if (
    pick.valuePercent !== null
  ) {
    score +=
      clamp(
        pick.valuePercent,
        -6.5,
        10
      ) * 0.8;
  }

  score +=
    Math.min(
      pick.dataQuality || 0,
      14
    ) * 0.35;

  /*
   * Ruch bukmacherski:
   * tylko rzeczywiste dane.
   */
  if (
    pick.movement?.available
  ) {
    if (
      pick.movement.direction ===
      "DOWN"
    ) {
      score += 1.5;
    } else if (
      pick.movement.direction ===
      "STABLE"
    ) {
      score += 0.5;
    }
  }

  /*
   * Exchange:
   * zero punktów, jeżeli feed
   * nie jest podłączony.
   */
  if (
    pick.exchange?.connected
  ) {
    score += 2;
  }

  return Number(
    score.toFixed(2)
  );
}

async function getTopPicks(date) {
  const dateValue =
    normalizeDateInput(
      date
    );

  const allEvents =
    await getEvents(
      dateValue
    );

  /*
   * Tylko mecze, które BSD oznacza
   * jako jeszcze nierozpoczęte.
   */
  const upcoming =
    allEvents
      .filter(
        isUpcomingEvent
      )
      .filter(
        event =>
          !isLiveEvent(event)
      )
      .filter(
        event =>
          !isFinishedEvent(event)
      )
      .sort(
        (a, b) => {
          const da =
            new Date(
              a.date || 0
            ).getTime();

          const db =
            new Date(
              b.date || 0
            ).getTime();

          return da - db;
        }
      )
      .slice(
        0,
        CONFIG.maxEvents
      );

  const analyzed = [];

  for (
    const event of upcoming
  ) {
    const result =
      await analyzeEvent(
        event
      );

    analyzed.push(
      result
    );

    await sleep(80);
  }

  const allAccepted = [];

  for (
    const result of analyzed
  ) {
    if (!result.ok) {
      continue;
    }

    for (
      const pick of
      result.acceptedCandidates ||
      []
    ) {
      pick.rankingScore =
        pickRankingScore(
          pick
        );

      allAccepted.push(
        pick
      );
    }
  }

  /*
   * Najpierw jeden najlepszy typ
   * z każdego meczu.
   */
  const bestPerEvent =
    new Map();

  for (
    const pick of allAccepted
  ) {
    const existing =
      bestPerEvent.get(
        pick.eventId
      );

    if (
      !existing ||
      pick.rankingScore >
        existing.rankingScore
    ) {
      bestPerEvent.set(
        pick.eventId,
        pick
      );
    }
  }

  const primary =
    Array.from(
      bestPerEvent.values()
    );

  primary.sort(
    (a, b) => {
      if (
        b.rankingScore !==
        a.rankingScore
      ) {
        return (
          b.rankingScore -
          a.rankingScore
        );
      }

      if (
        b.probabilityScore !==
        a.probabilityScore
      ) {
        return (
          b.probabilityScore -
          a.probabilityScore
        );
      }

      return (
        (b.valueScore || 0) -
        (a.valueScore || 0)
      );
    }
  );

  const selected =
    primary.slice(
      0,
      CONFIG.topPicksLimit
    );

  /*
   * Jeśli mamy mniej niż 10 różnych meczów,
   * możemy dołożyć drugi typ tylko wtedy,
   * gdy jest naprawdę mocny.
   */
  if (
    selected.length <
    CONFIG.topPicksLimit
  ) {
    const selectedKeys =
      new Set(
        selected.map(
          pick =>
            `${pick.eventId}:${pick.market}`
        )
      );

    const secondary =
      allAccepted
        .filter(
          pick =>
            !selectedKeys.has(
              `${pick.eventId}:${pick.market}`
            )
        )
        .filter(
          pick =>
            pick.qualificationType ===
              "STRONG_PICK" ||
            (
              pick.qualificationType ===
                "HIGH_PROBABILITY" &&
              pick.probability >= 70 &&
              pick.probabilityScore >= 60
            ) ||
            (
              pick.qualificationType ===
                "VALUE" &&
              pick.valuePercent >= 7 &&
              pick.valueScore >= 60
            )
        )
        .sort(
          (a, b) =>
            b.rankingScore -
            a.rankingScore
        );

    /*
     * Najpierw inne mecze.
     */
    const selectedEvents =
      new Set(
        selected.map(
          pick =>
            pick.eventId
        )
      );

    for (
      const pick of secondary
    ) {
      if (
        selected.length >=
        CONFIG.topPicksLimit
      ) {
        break;
      }

      if (
        selectedEvents.has(
          pick.eventId
        )
      ) {
        continue;
      }

      selected.push(
        pick
      );

      selectedEvents.add(
        pick.eventId
      );

      selectedKeys.add(
        `${pick.eventId}:${pick.market}`
      );
    }

    /*
     * Dopiero na końcu drugi typ
     * z już wybranego meczu.
     */
    for (
      const pick of secondary
    ) {
      if (
        selected.length >=
        CONFIG.topPicksLimit
      ) {
        break;
      }

      const key =
        `${pick.eventId}:${pick.market}`;

      if (
        selectedKeys.has(key)
      ) {
        continue;
      }

      selected.push(
        pick
      );

      selectedKeys.add(
        key
      );
    }
  }

  const exchange =
    exchangeStatus();

  /*
   * Szczegółowy diagnostyczny wynik
   * dla każdego analizowanego meczu.
   */
  const analyzedSummary =
    analyzed.map(
      result => ({
        eventId:
          result.event?.id,

        home:
          result.event?.home,

        away:
          result.event?.away,

        date:
          result.event?.date,

        status:
          result.event?.status,

        qualified:
          result.acceptedCandidates
            ?.length || 0,

        bestPick:
          result.bestPick
            ? {
                market:
                  result.bestPick.market,

                label:
                  result.bestPick.label,

                probability:
                  result.bestPick.probability,

                odds:
                  result.bestPick.odds,

                valuePercent:
                  result.bestPick.valuePercent,

                probabilityScore:
                  result.bestPick.probabilityScore,

                valueScore:
                  result.bestPick.valueScore,

                qualificationType:
                  result.bestPick.qualificationType
              }
            : null,

        diagnostics:
          result.diagnostics || [],

        error:
          result.ok
            ? null
            : result.error
      })
    );

  return {
    ok: true,

    version: VERSION,

    source: SOURCE,

    date:
      dateValue,

    universe: {
      eventsReturned:
        allEvents.length,

      upcomingEvents:
        upcoming.length,

      eventsAnalyzed:
        analyzed.length,

      eventsExcluded:
        Math.max(
          0,
          allEvents.length -
            upcoming.length
        ),

      qualificationCount:
        allAccepted.length
    },

    filters: {
      highProbability: {
        probabilityMin:
          CONFIG.highProbabilityMin,

        scoreMin:
          CONFIG.highProbabilityScoreMin,

        valueMin:
          CONFIG.highProbabilityValueMin,

        minOdds:
          CONFIG.minimumOddsForHighProbability
      },

      strongPick: {
        probabilityMin:
          CONFIG.strongPickProbabilityMin,

        scoreMin:
          CONFIG.strongPickScoreMin,

        valueMin:
          CONFIG.strongPickValueMin
      },

      value: {
        probabilityMin:
          CONFIG.valueProbabilityMin,

        scoreMin:
          CONFIG.valueScoreMin,

        valueMin:
          CONFIG.valueMin
      },

      allowedStatuses: [
        "notstarted",
        "not_started",
        "scheduled",
        "upcoming",
        "pending"
      ],

      excludedStatuses: [
        "finished",
        "cancelled",
        "canceled",
        "postponed",
        "abandoned",
        "suspended",
        "live",
        "inplay"
      ],

      maxEventsAnalyzed:
        CONFIG.maxEvents,

      maxTopPicks:
        CONFIG.topPicksLimit
    },

    picks:
      selected,

    qualifiedCount:
      selected.length,

    analyzed:
      analyzedSummary,

    exchange
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name:
      "Bet Analyzer Live",
    version:
      VERSION,
    source:
      SOURCE,
    status:
      "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version:
      VERSION,
    source:
      SOURCE,
    status:
      "healthy",
    timestamp:
      new Date().toISOString()
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const date =
      normalizeDateInput(
        req.query.date
      );

    const events =
      await getEvents(
        date
      );

    res.json({
      ok: true,
      version:
        VERSION,
      source:
        SOURCE,
      date,
      count:
        events.length,
      events
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version:
        VERSION,
      source:
        SOURCE,
      error:
        error.message
    });
  }
});

app.get(
  "/api/analyze/:id",
  async (req, res) => {
    try {
      const eventId =
        num(
          req.params.id
        );

      if (!eventId) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid event id"
        });
      }

      const eventDetail =
        await getEventDetail(
          eventId
        );

      let event =
        normalizeEvent(
          eventDetail?.event ||
          eventDetail
        );

      if (!event) {
        event = {
          id: eventId,
          eventId,
          home:
            "Unknown",
          away:
            "Unknown",
          status:
            "notstarted",
          date:
            null,
          league:
            null,
          leagueId:
            null
        };
      }

      const result =
        await analyzeEvent(
          event
        );

      res.json(
        result
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        source:
          SOURCE,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/top-picks",
  async (req, res) => {
    try {
      const date =
        normalizeDateInput(
          req.query.date
        );

      const result =
        await getTopPicks(
          date
        );

      res.json(
        result
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        source:
          SOURCE,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/exchange/status",
  (req, res) => {
    res.json({
      ok: true,
      version:
        VERSION,
      source:
        SOURCE,
      exchange:
        exchangeStatus()
    });
  }
);

app.get(
  "/api/coverage",
  async (req, res) => {
    try {
      const date =
        normalizeDateInput(
          req.query.date
        );

      const events =
        await getEvents(
          date
        );

      const upcoming =
        events.filter(
          isUpcomingEvent
        );

      res.json({
        ok: true,
        version:
          VERSION,
        source:
          SOURCE,
        date,

        coverage: {
          eventsReturned:
            events.length,

          upcomingEvents:
            upcoming.length,

          eventsWithPrediction:
            null,

          eventsWithOdds:
            null,

          eventsWithLineups:
            null,

          eventsWithH2H:
            null,

          eventsWithForm:
            null,

          eventsWithReferee:
            null,

          exchangeConnected:
            false
        },

        note:
          "Detailed coverage is calculated during /api/top-picks analysis."
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version:
          VERSION,
        source:
          SOURCE,
        error:
          error.message
      });
    }
  }
);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    version:
      VERSION,
    source:
      SOURCE,
    error:
      "Endpoint not found"
  });
});

app.use(
  (error, req, res, next) => {
    console.error(error);

    res.status(500).json({
      ok: false,
      version:
        VERSION,
      source:
        SOURCE,
      error:
        "Internal server error"
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} listening on port ${PORT}`
    );
  }
);
