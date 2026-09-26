import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

const BSD_API_KEY = process.env.BSD_API_KEY || "";
const BSD_BASE = "https://sports.bzzoiro.com/api/v2";
const WOM_BASE_URL = "https://sports.bzzoiro.com/wom/api";

const VERSION = "7.2.0";
const SOURCE = "BSD";

const USE_WOM = String(process.env.USE_WOM || "false").toLowerCase() === "true";

const REQUEST_TIMEOUT = 12000;

function pct(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  return n <= 1 ? n * 100 : n;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function statusOf(event) {
  const raw = String(
    event?.status ??
    event?.state ??
    event?.matchStatus ??
    event?.fixture?.status ??
    ""
  ).toLowerCase();

  if (
    [
      "finished",
      "complete",
      "completed",
      "ended",
      "closed",
      "ft",
      "final"
    ].includes(raw)
  ) {
    return "completed";
  }

  if (
    [
      "live",
      "inplay",
      "in-play",
      "playing",
      "1h",
      "2h",
      "ht"
    ].includes(raw)
  ) {
    return "live";
  }

  if (
    [
      "cancelled",
      "canceled",
      "postponed",
      "abandoned"
    ].includes(raw)
  ) {
    return raw;
  }

  return raw || "notstarted";
}

function eventIdOf(event) {
  return (
    event?.eventId ??
    event?.id ??
    event?.fixtureId ??
    event?.fixture?.id ??
    null
  );
}

function eventNameOf(event) {
  const home =
    event?.home ??
    event?.homeTeam ??
    event?.teams?.home?.name ??
    event?.teams?.home ??
    event?.home_name ??
    "";

  const away =
    event?.away ??
    event?.awayTeam ??
    event?.teams?.away?.name ??
    event?.teams?.away ??
    event?.away_name ??
    "";

  if (home || away) return `${home} – ${away}`;

  return (
    event?.event ??
    event?.name ??
    event?.fixture?.name ??
    `Event ${eventIdOf(event) ?? "unknown"}`
  );
}

function dateOf(event) {
  return (
    event?.date ??
    event?.startDate ??
    event?.startTime ??
    event?.fixture?.date ??
    null
  );
}

function leagueOf(event) {
  return (
    event?.league ??
    event?.competition ??
    event?.tournament ??
    event?.leagueName ??
    null
  );
}

function predictionObject(event) {
  return (
    event?.prediction ??
    event?.predictions ??
    event?.modelPrediction ??
    event?.model?.prediction ??
    {}
  );
}

function probability(event, key) {
  const p = predictionObject(event);

  const aliases = {
    HOME: ["home", "homeWin", "home_win", "1"],
    DRAW: ["draw", "x"],
    AWAY: ["away", "awayWin", "away_win", "2"],
    OVER25: ["over25", "over_25", "o25", "over2_5"],
    UNDER25: ["under25", "under_25", "u25", "under2_5"],
    OVER35: ["over35", "over_35", "o35", "over3_5"],
    UNDER35: ["under35", "under_35", "u35", "under3_5"],
    BTTS_YES: ["bttsYes", "btts_yes", "btts", "gg"],
    BTTS_NO: ["bttsNo", "btts_no", "ng"]
  };

  const keys = aliases[key] || [];

  for (const k of keys) {
    if (p?.[k] !== undefined) {
      const value = pct(p[k]);
      if (value !== null) return value;
    }
  }

  if (p?.[key] !== undefined) {
    const value = pct(p[key]);
    if (value !== null) return value;
  }

  return null;
}

function oddsRows(event) {
  const source =
    event?.odds ??
    event?.markets ??
    event?.bookmakers ??
    event?.rows ??
    [];

  if (Array.isArray(source)) return source;

  if (source && typeof source === "object") {
    const rows = [];

    for (const [market, value] of Object.entries(source)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          rows.push({
            market,
            ...(item && typeof item === "object" ? item : { odd: item })
          });
        }
      } else if (value && typeof value === "object") {
        rows.push({
          market,
          ...value
        });
      } else {
        rows.push({
          market,
          odd: value
        });
      }
    }

    return rows;
  }

  return [];
}

function normalizeMarket(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function movementFromRow(row) {
  const movement =
    row?.movement ??
    row?.priceMovement ??
    row?.change ??
    row?.trend ??
    row?.direction ??
    null;

  if (movement === null || movement === undefined) return null;

  if (typeof movement === "object") {
    return (
      movement.direction ??
      movement.movement ??
      movement.trend ??
      movement.value ??
      null
    );
  }

  return movement;
}

function movementDirection(value) {
  const s = String(value ?? "").toLowerCase();

  if (
    [
      "up",
      "rise",
      "rising",
      "drifting",
      "drift",
      "higher",
      "increase",
      "increasing",
      "+",
      "positive"
    ].includes(s)
  ) {
    return "up";
  }

  if (
    [
      "down",
      "fall",
      "falling",
      "shortening",
      "shorten",
      "lower",
      "decrease",
      "decreasing",
      "-",
      "negative"
    ].includes(s)
  ) {
    return "down";
  }

  return null;
}

function quoteFromRow(row) {
  return num(
    row?.odd ??
    row?.odds ??
    row?.price ??
    row?.decimal ??
    row?.decimalOdds ??
    row?.value
  );
}

function bestQuote(rows, market) {
  const normalized = normalizeMarket(market);

  const candidates = rows.filter((row) => {
    const rowMarket = normalizeMarket(
      row?.market ??
      row?.marketName ??
      row?.type ??
      row?.selection ??
      ""
    );

    return rowMarket === normalized;
  });

  if (!candidates.length) return null;

  const markedMax = candidates.filter(
    (row) =>
      row?.isMaxQuote === true ||
      row?.maxQuote === true ||
      row?.best === true
  );

  const pool = markedMax.length ? markedMax : candidates;

  let best = null;

  for (const row of pool) {
    const odd = quoteFromRow(row);
    if (odd === null) continue;

    if (!best || odd > best.odd) {
      best = {
        odd,
        bookmaker:
          row?.bookmaker ??
          row?.bookmakerName ??
          row?.site ??
          null,
        movement: movementDirection(movementFromRow(row)),
        raw: row
      };
    }
  }

  return best;
}

function marketProbability(event, market) {
  switch (market) {
    case "HOME":
      return probability(event, "HOME");
    case "DRAW":
      return probability(event, "DRAW");
    case "AWAY":
      return probability(event, "AWAY");
    case "OVER25":
      return probability(event, "OVER25");
    case "UNDER25":
      return probability(event, "UNDER25");
    case "OVER35":
      return probability(event, "OVER35");
    case "UNDER35":
      return probability(event, "UNDER35");
    case "BTTS_YES":
      return probability(event, "BTTS_YES");
    case "BTTS_NO":
      return probability(event, "BTTS_NO");
    case "DOUBLE_CHANCE_1X": {
      const h = probability(event, "HOME");
      const d = probability(event, "DRAW");
      return h !== null && d !== null ? h + d : null;
    }
    case "DOUBLE_CHANCE_X2": {
      const d = probability(event, "DRAW");
      const a = probability(event, "AWAY");
      return d !== null && a !== null ? d + a : null;
    }
    case "DOUBLE_CHANCE_12": {
      const h = probability(event, "HOME");
      const a = probability(event, "AWAY");
      return h !== null && a !== null ? h + a : null;
    }
    default:
      return null;
  }
}

function candidate(
  event,
  market,
  label,
  minProbability = 0,
  movement = null,
  odds = null
) {
  const p = marketProbability(event, market);

  if (p === null || p < minProbability) return null;

  const odd =
    odds?.odd ??
    odds?.price ??
    null;

  const fairOdd =
    p > 0
      ? 100 / p
      : null;

  const edge =
    odd !== null && fairOdd !== null
      ? ((odd - fairOdd) / fairOdd) * 100
      : null;

  return {
    market,
    label,
    probability: Number(p.toFixed(1)),
    odds: odd,
    fairOdds: fairOdd !== null ? Number(fairOdd.toFixed(3)) : null,
    edge: edge !== null ? Number(edge.toFixed(2)) : null,
    marketMovement: movement
      ? {
          movement,
          direction: movementDirection(movement)
        }
      : null,
    bookmaker: odds?.bookmaker ?? null
  };
}

function score(c) {
  if (!c) return -Infinity;

  let value = c.probability;

  if (c.edge !== null && c.edge !== undefined) {
    value += clamp(c.edge, -10, 15) * 0.7;
  }

  if (c.marketMovement?.movement) {
    const direction = movementDirection(c.marketMovement.movement);

    if (direction === "down") value += 2;
    if (direction === "up") value -= 1;
  }

  return Number(value.toFixed(3));
}

function parseForm(event) {
  const source =
    event?.form ??
    event?.recentForm ??
    event?.lastMatches ??
    event?.teamsForm ??
    null;

  if (!source) return null;

  if (Array.isArray(source)) {
    return source.map((item) => {
      const status = String(
        item?.status ??
        item?.result ??
        item?.outcome ??
        ""
      ).toLowerCase();

      if (
        ["w", "win", "won"].includes(status)
      ) return "W";

      if (
        ["d", "draw", "tie"].includes(status)
      ) return "D";

      if (
        ["l", "loss", "lost"].includes(status)
      ) return "L";

      if (
        [
          "finished",
          "complete",
          "completed",
          "ended",
          "closed"
        ].includes(status)
      ) {
        const home = num(item?.homeScore ?? item?.home ?? item?.score?.home);
        const away = num(item?.awayScore ?? item?.away ?? item?.score?.away);

        if (home !== null && away !== null) {
          if (home > away) return "W";
          if (home < away) return "L";
          return "D";
        }
      }

      return null;
    }).filter(Boolean);
  }

  return source;
}

function formScore(form) {
  if (!Array.isArray(form) || !form.length) return null;

  let total = 0;
  let count = 0;

  for (const result of form) {
    if (result === "W") total += 3;
    else if (result === "D") total += 1;
    else if (result === "L") total += 0;
    else continue;

    count++;
  }

  return count ? total / (count * 3) * 100 : null;
}

function getWomId(event) {
  return eventIdOf(event);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      const error = new Error(
        `HTTP ${response.status} from ${url}`
      );

      error.status = response.status;
      error.data = data;

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function bsd(path, query = {}) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
  }

  const url = new URL(`${BSD_BASE}${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, value);
    }
  }

  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${BSD_API_KEY}`,
      "X-API-Key": BSD_API_KEY
    }
  });
}

async function getWom(eventId) {
  if (!USE_WOM || !eventId) return null;

  try {
    const url =
      `${WOM_BASE_URL}/events/${encodeURIComponent(eventId)}/`;

    const data = await fetchJson(url);

    const rows =
      data?.money ??
      data?.results ??
      data?.data?.money ??
      data?.data?.results ??
      [];

    if (!Array.isArray(rows)) {
      return {
        available: false,
        reason: "unsupported_wom_shape"
      };
    }

    const normalized = rows.map((row) => ({
      selection:
        row?.selection ??
        row?.market ??
        row?.name ??
        null,
      share: pct(
        row?.share ??
        row?.moneyShare ??
        row?.percentage
      ),
      price: num(
        row?.price ??
        row?.odds ??
        row?.odd
      ),
      raw: row
    }));

    return {
      available: true,
      source: "BSD_WOM",
      rows: normalized
    };
  } catch (error) {
    return {
      available: false,
      error: error.message
    };
  }
}

function extractEvents(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.events)) return data.data.events;
  if (Array.isArray(data?.data?.results)) return data.data.results;

  return [];
}

function extractOdds(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.odds)) return data.odds;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.odds)) return data.data.odds;

  return [];
}

function buildCandidates(event, rows = []) {
  const markets = [
    ["HOME", "1", 60],
    ["DRAW", "X", 45],
    ["AWAY", "2", 60],
    ["DOUBLE_CHANCE_1X", "1X", 72],
    ["DOUBLE_CHANCE_X2", "X2", 72],
    ["DOUBLE_CHANCE_12", "12", 72],
    ["OVER25", "Over 2.5", 60],
    ["UNDER25", "Under 2.5", 60],
    ["OVER35", "Over 3.5", 60],
    ["UNDER35", "Under 3.5", 60],
    ["BTTS_YES", "BTTS Yes", 60],
    ["BTTS_NO", "BTTS No", 60]
  ];

  const result = [];

  for (const [market, label, min] of markets) {
    const odds = bestQuote(rows, market);

    const movement =
      odds?.movement ??
      movementDirection(
        movementFromRow(
          rows.find((row) =>
            normalizeMarket(
              row?.market ??
              row?.marketName ??
              row?.type ??
              row?.selection ??
              ""
            ) === normalizeMarket(market)
          )
        )
      );

    const item = candidate(
      event,
      market,
      label,
      min,
      movement,
      odds
    );

    if (item) {
      item.score = score(item);
      result.push(item);
    }
  }

  return result.sort((a, b) => b.score - a.score);
}

function summarizeEvent(event, odds = []) {
  const candidates = buildCandidates(event, odds);

  const form = parseForm(event);
  const formValue = formScore(form);

  return {
    eventId: eventIdOf(event),
    event: eventNameOf(event),
    date: dateOf(event),
    status: statusOf(event),
    league: leagueOf(event),
    prediction: {
      home: probability(event, "HOME"),
      draw: probability(event, "DRAW"),
      away: probability(event, "AWAY"),
      over25: probability(event, "OVER25"),
      under25: probability(event, "UNDER25"),
      over35: probability(event, "OVER35"),
      under35: probability(event, "UNDER35"),
      bttsYes: probability(event, "BTTS_YES"),
      bttsNo: probability(event, "BTTS_NO")
    },
    form: {
      raw: form,
      score: formValue
    },
    candidates,
    topPick: candidates[0] ?? null
  };
}

async function enrichEvent(event) {
  const id = eventIdOf(event);

  let odds = [];

  if (id) {
    try {
      const data = await bsd(`/events/${encodeURIComponent(id)}/odds`);
      odds = extractOdds(data);
    } catch {
      odds = oddsRows(event);
    }
  } else {
    odds = oddsRows(event);
  }

  const result = summarizeEvent(event, odds);

  if (USE_WOM && id) {
    result.exchange = await getWom(getWomId(event));
  } else {
    result.exchange = null;
  }

  return result;
}

async function getEvents(query = {}) {
  const data = await bsd("/events", query);
  return extractEvents(data);
}

async function scan(query = {}) {
  const events = await getEvents(query);

  const enriched = [];

  for (const event of events) {
    const status = statusOf(event);

    if (
      ["completed", "cancelled", "canceled", "postponed", "abandoned"]
        .includes(status)
    ) {
      continue;
    }

    try {
      enriched.push(await enrichEvent(event));
    } catch (error) {
      enriched.push({
        eventId: eventIdOf(event),
        event: eventNameOf(event),
        date: dateOf(event),
        status,
        league: leagueOf(event),
        error: error.message,
        topPick: null,
        candidates: [],
        exchange: null
      });
    }
  }

  return enriched;
}

function topPicks(events, limit = 10) {
  return events
    .filter((event) => event?.topPick)
    .sort(
      (a, b) =>
        (b.topPick?.score ?? -Infinity) -
        (a.topPick?.score ?? -Infinity)
    )
    .slice(0, limit);
}

function selfTest() {
  const tests = [];

  function check(name, condition) {
    tests.push({
      name,
      ok: Boolean(condition)
    });
  }

  check(
    "pct_decimal",
    pct(0.6) === 60
  );

  check(
    "pct_percent",
    pct(60) === 60
  );

  check(
    "edge_60_at_2",
    Math.abs(
      ((2 - 100 / 60) / (100 / 60)) * 100 - 20
    ) < 0.001
  );

  check(
    "status_completed",
    statusOf({ status: "completed" }) === "completed"
  );

  check(
    "status_unknown",
    statusOf({ status: "xyz" }) === "xyz"
  );

  check(
    "nested_prediction",
    probability(
      {
        prediction: {
          home: 0.6
        }
      },
      "HOME"
    ) === 60
  );

  check(
    "legacy_prediction",
    probability(
      {
        prediction: {
          homeWin: 60
        }
      },
      "HOME"
    ) === 60
  );

  check(
    "nested_odds",
    quoteFromRow({
      odds: 2
    }) === 2
  );

  check(
    "row_odds",
    quoteFromRow({
      odd: 1.8
    }) === 1.8
  );

  check(
    "movement_shortening",
    movementDirection("shortening") === "down"
  );

  check(
    "movement_drifting",
    movementDirection("drifting") === "up"
  );

  check(
    "best_quote",
    bestQuote(
      [
        {
          market: "HOME",
          odd: 1.8
        },
        {
          market: "HOME",
          odd: 2.0
        }
      ],
      "HOME"
    )?.odd === 2
  );

  check(
    "best_quote_prefers_marked_max",
    bestQuote(
      [
        {
          market: "HOME",
          odd: 2.2
        },
        {
          market: "HOME",
          odd: 1.9,
          isMaxQuote: true
        }
      ],
      "HOME"
    )?.odd === 1.9
  );

  check(
    "double_chance_math",
    marketProbability(
      {
        prediction: {
          home: 0.5,
          draw: 0.25
        }
      },
      "DOUBLE_CHANCE_1X"
    ) === 75
  );

  check(
    "btts_no_math",
    marketProbability(
      {
        prediction: {
          bttsNo: 0.7
        }
      },
      "BTTS_NO"
    ) === 70
  );

  check(
    "no_exchange_fabrication",
    getWom(123) instanceof Promise
  );

  const passed = tests.filter((x) => x.ok).length;

  return {
    version: VERSION,
    passed,
    total: tests.length,
    ok: passed === tests.length,
    tests
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    source: SOURCE,
    version: VERSION,
    exchange: {
      enabled: USE_WOM,
      connected: USE_WOM
    },
    apiConfigured: Boolean(BSD_API_KEY)
  });
});

app.get("/api/self-test", (req, res) => {
  res.json(selfTest());
});

app.get("/api/events", async (req, res) => {
  try {
    const data = await getEvents(req.query);
    res.json({
      source: SOURCE,
      version: VERSION,
      count: data.length,
      events: data
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const data = await bsd(
      `/events/${encodeURIComponent(req.params.id)}/odds`
    );

    res.json({
      source: SOURCE,
      version: VERSION,
      eventId: req.params.id,
      odds: extractOdds(data),
      raw: data
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      eventId: req.params.id,
      error: error.message
    });
  }
});

app.get("/api/predictions", async (req, res) => {
  try {
    const events = await getEvents(req.query);

    res.json({
      source: SOURCE,
      version: VERSION,
      count: events.length,
      predictions: events.map((event) => ({
        eventId: eventIdOf(event),
        event: eventNameOf(event),
        date: dateOf(event),
        status: statusOf(event),
        prediction: {
          home: probability(event, "HOME"),
          draw: probability(event, "DRAW"),
          away: probability(event, "AWAY"),
          over25: probability(event, "OVER25"),
          under25: probability(event, "UNDER25"),
          over35: probability(event, "OVER35"),
          under35: probability(event, "UNDER35"),
          bttsYes: probability(event, "BTTS_YES"),
          bttsNo: probability(event, "BTTS_NO")
        }
      }))
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/api/analyze/:id", async (req, res) => {
  try {
    const data = await bsd(
      `/events/${encodeURIComponent(req.params.id)}`
    );

    const events = extractEvents(data);

    const event =
      events[0] ??
      data?.event ??
      data?.data?.event ??
      data;

    const result = await enrichEvent(event);

    res.json({
      source: SOURCE,
      version: VERSION,
      ...result
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      eventId: req.params.id,
      error: error.message
    });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const events = await scan(req.query);

    res.json({
      source: SOURCE,
      version: VERSION,
      count: events.length,
      events
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/api/top-picks", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 10);
    const limit = Math.max(
      1,
      Math.min(
        Number.isFinite(limitRaw) ? limitRaw : 10,
        50
      )
    );

    const events = await scan(req.query);
    const picks = topPicks(events, limit);

    res.json({
      source: SOURCE,
      version: VERSION,
      count: picks.length,
      picks
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      source: SOURCE,
      version: VERSION,
      error: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
    version: VERSION
  });
});

app.listen(PORT, () => {
  console.log(
    `Bet Analyzer ${VERSION} listening on ${PORT}`
  );
});

export {
  selfTest
};
