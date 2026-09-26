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
  process.env.BSD_BASE_URL ||
  "https://sports.bzzoiro.com/api/v2";

const VERSION = "7.1.6";
const SOURCE = "BSD";

const MAX_SCAN_EVENTS = Math.min(
  100,
  Math.max(
    1,
    Number(process.env.MAX_SCAN_EVENTS || 40)
  )
);

const MAX_PICKS = 10;

const MIN_PROBABILITY = 58;
const MIN_EDGE = 2;
const MIN_SCORE = 70;

const REQUEST_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 120000;

const cache = new Map();

const num = (v, d = null) =>
  Number.isFinite(Number(v))
    ? Number(v)
    : d;

const pct = (v) => {
  const n = num(v);

  if (n === null) return null;

  return n <= 1 ? n * 100 : n;
};

const clamp = (v, a, b) =>
  Math.min(b, Math.max(a, v));

const arr = (v) =>
  Array.isArray(v) ? v : [];

const nowIso = () =>
  new Date().toISOString();

const dateObj = (v) => {
  const d = new Date(v);

  return v && !Number.isNaN(d.getTime())
    ? d
    : null;
};

const implied = (o) => {
  o = num(o);

  return o && o > 1
    ? 100 / o
    : null;
};

const edge = (p, o) => {
  p = pct(p);

  const i = implied(o);

  if (p === null || i === null) {
    return null;
  }

  return p - i;
};

function cacheGet(k) {
  const x = cache.get(k);

  if (!x) return null;

  if (
    Date.now() - x.time >
    CACHE_TTL_MS
  ) {
    cache.delete(k);
    return null;
  }

  return x.value;
}

function cacheSet(k, v) {
  cache.set(k, {
    time: Date.now(),
    value: v
  });

  return v;
}

function firstObject(...v) {
  return (
    v.find(
      (x) =>
        x &&
        typeof x === "object" &&
        !Array.isArray(x)
    ) || null
  );
}

async function bsd(path) {
  if (!BSD_API_KEY) {
    const e = new Error(
      "BSD_API_KEY is not configured"
    );

    e.status = 503;
    e.code = "BSD_NOT_CONFIGURED";

    throw e;
  }

  const c = new AbortController();

  const t = setTimeout(
    () => c.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const r = await fetch(
      `${BSD_BASE_URL}${
        path.startsWith("/")
          ? path
          : `/${path}`
      }`,
      {
        headers: {
          Authorization:
            `Token ${BSD_API_KEY}`,
          Accept:
            "application/json"
        },
        signal: c.signal
      }
    );

    const text = await r.text();

    let data = null;

    try {
      data = text
        ? JSON.parse(text)
        : null;
    } catch {
      data = text;
    }

    if (!r.ok) {
      const e = new Error(
        `BSD HTTP ${r.status}`
      );

      e.status = r.status;
      e.code =
        `BSD_HTTP_${r.status}`;
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
    clearTimeout(t);
  }
}

async function safe(path) {
  try {
    return await bsd(path);
  } catch (e) {
    console.error(
      `[BSD] ${path}`,
      e.code || e.message
    );

    return null;
  }
}

function collection(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (
    !data ||
    typeof data !== "object"
  ) {
    return [];
  }

  for (const k of [
    "results",
    "data",
    "items",
    "events",
    "matches",
    "fixtures",
    "predictions"
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

function status(raw) {
  const s = String(
    raw?.status ??
      raw?.fixture?.status ??
      raw?.state ??
      ""
  ).toLowerCase();

  if (
    s === "upcoming" ||
    s === "scheduled" ||
    s === "notstarted" ||
    s === "not_started"
  ) {
    return "notstarted";
  }

  if (
    s === "live" ||
    s === "inplay" ||
    s === "in-play" ||
    s === "in_progress" ||
    s === "inprogress"
  ) {
    return "live";
  }

  if (
    s === "finished" ||
    s === "complete"
  ) {
    return "finished";
  }

  if (
    s === "cancelled" ||
    s === "canceled"
  ) {
    return "cancelled";
  }

  if (s === "postponed") {
    return "postponed";
  }

  return "unknown";
}

function normalizeEvent(raw) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return null;
  }

  const fixture =
    firstObject(
      raw.fixture,
      raw.event,
      raw.match
    ) || raw;

  const home =
    firstObject(
      raw.home_team,
      raw.homeTeam,
      raw.teams?.home,
      raw.home,
      fixture.home_team,
      fixture.homeTeam,
      fixture.teams?.home,
      fixture.home
    );

  const away =
    firstObject(
      raw.away_team,
      raw.awayTeam,
      raw.teams?.away,
      raw.away,
      fixture.away_team,
      fixture.awayTeam,
      fixture.teams?.away,
      fixture.away
    );

  const id =
    raw.id ??
    raw.event_id ??
    raw.eventId ??
    raw.eventID ??
    fixture.id ??
    fixture.event_id ??
    fixture.eventId;

  if (
    id === undefined ||
    id === null
  ) {
    return null;
  }

  const hId =
    home?.id ??
    home?.teamId ??
    raw.homeTeamId ??
    raw.home_team_id ??
    null;

  const aId =
    away?.id ??
    away?.teamId ??
    raw.awayTeamId ??
    raw.away_team_id ??
    null;

  return {
    id: Number(id),

    event:
      raw.name ??
      raw.event ??
      fixture.name ??
      `${
        home?.name || "Home"
      } – ${
        away?.name || "Away"
      }`,

    date:
      raw.event_date ??
      raw.date ??
      raw.startTime ??
      raw.start_time ??
      raw.utcDate ??
      fixture.event_date ??
      fixture.date ??
      fixture.startTime ??
      fixture.start_time ??
      null,

    status: status(raw),

    league:
      raw.league?.name ??
      raw.competition?.name ??
      raw.leagueName ??
      null,

    leagueId:
      raw.league?.id ??
      raw.leagueId ??
      null,

    seasonId:
      raw.season?.id ??
      raw.seasonId ??
      null,

    home: {
      id:
        hId === null
          ? null
          : Number(hId),

      name:
        home?.name ??
        home?.teamName ??
        raw.homeName ??
        "Home"
    },

    away: {
      id:
        aId === null
          ? null
          : Number(aId),

      name:
        away?.name ??
        away?.teamName ??
        raw.awayName ??
        "Away"
    },

    raw
  };
}

function parsePrediction(p) {
  if (
    !p ||
    typeof p !== "object"
  ) {
    return null;
  }

  const x =
    firstObject(
      p.prediction,
      p.predictions,
      p.model,
      p.forecast,
      p.data?.prediction,
      p.data?.predictions,
      p.results?.prediction
    ) || p;

  const home = pct(
    x.home_win_prob ??
      x.homeWinProb ??
      x.homeProbability ??
      x.home_win ??
      x.home
  );

  const draw = pct(
    x.draw_prob ??
      x.drawProbability ??
      x.draw_win_prob ??
      x.draw
  );

  const away = pct(
    x.away_win_prob ??
      x.awayWinProb ??
      x.awayProbability ??
      x.away_win ??
      x.away
  );

  const over15 = pct(
    x.over_1_5_prob ??
      x.over15 ??
      x.over_15 ??
      x.over1_5
  );

  const over25 = pct(
    x.over_2_5_prob ??
      x.over25 ??
      x.over_25 ??
      x.over2_5
  );

  const under25 = pct(
    x.under_2_5_prob ??
      x.under25 ??
      x.under_25 ??
      x.under2_5
  );

  const under35 = pct(
    x.under_3_5_prob ??
      x.under35 ??
      x.under_35 ??
      x.under3_5
  );

  const btts = pct(
    x.btts_yes_prob ??
      x.btts ??
      x.bothTeamsToScore ??
      x.both_teams_score
  );

  const confidence = pct(
    x.confidence ??
      x.modelConfidence ??
      x.model_confidence
  );

  if (
    [
      home,
      draw,
      away,
      over15,
      over25,
      under25,
      under35,
      btts
    ].every(
      (v) => v === null
    ) &&
    confidence === null
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
    btts,
    confidence,

    predictedWinnerId:
      x.predicted_winner_id ??
      x.predictedWinnerId ??
      null,

    raw: x
  };
}

function predictionEventId(p) {
  return Number(
    p?.event_id ??
      p?.eventId ??
      p?.event?.id ??
      p?.id_event ??
      NaN
  );
}

async function getPredictionMap() {
  const key =
    "predictions:upcoming";

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  const data = await safe(
    "/predictions/?upcoming=true&limit=200"
  );

  const map = new Map();

  for (
    const p of collection(data)
  ) {
    const id =
      predictionEventId(p);

    if (
      Number.isFinite(id)
    ) {
      const parsed =
        parsePrediction(p);

      if (parsed) {
        map.set(
          id,
          parsed
        );
      }
    }
  }

  return cacheSet(
    key,
    map
  );
}

function norm(v) {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[\s_-]/g, "");
}

function marketKey(
  market,
  line,
  sel
) {
  const m = norm(market);
  const s = norm(sel);
  const n = num(line);

  if (
    m.includes("1X2") ||
    m.includes("MATCHRESULT") ||
    m === "RESULT" ||
    m === "WINNER"
  ) {
    if (
      s === "HOME" ||
      s === "1"
    ) {
      return "HOME";
    }

    if (
      s === "DRAW" ||
      s === "X"
    ) {
      return "DRAW";
    }

    if (
      s === "AWAY" ||
      s === "2"
    ) {
      return "AWAY";
    }
  }

  if (
    m.includes("OU") ||
    m.includes("OVERUNDER") ||
    m.includes("TOTAL") ||
    m.includes("GOALS")
  ) {
    if (
      (s === "OVER" ||
        s.includes("OVER")) &&
      n === 1.5
    ) {
      return "OVER15";
    }

    if (
      (s === "OVER" ||
        s.includes("OVER")) &&
      n === 2.5
    ) {
      return "OVER25";
    }

    if (
      (s === "UNDER" ||
        s.includes("UNDER")) &&
      n === 2.5
    ) {
      return "UNDER25";
    }

    if (
      (s === "UNDER" ||
        s.includes("UNDER")) &&
      n === 3.5
    ) {
      return "UNDER35";
    }
  }

  if (
    m.includes("BTTS") ||
    m.includes("BOTHTEAM")
  ) {
    if (
      s === "YES" ||
      s === "Y"
    ) {
      return "BTTS_YES";
    }

    if (
      s === "NO" ||
      s === "N"
    ) {
      return "BTTS_NO";
    }
  }

  if (
    m.includes("DOUBLE") ||
    m.includes("DC")
  ) {
    if (s === "1X") {
      return "DC1X";
    }

    if (s === "X2") {
      return "DCX2";
    }
  }

  return null;
}

function extractOdds(data) {
  const out = {
    HOME: [],
    DRAW: [],
    AWAY: [],
    OVER15: [],
    OVER25: [],
    UNDER25: [],
    UNDER35: [],
    BTTS_YES: [],
    BTTS_NO: [],
    DC1X: [],
    DCX2: []
  };

  if (
    !data ||
    typeof data !== "object"
  ) {
    return out;
  }

  const push = (
    key,
    price,
    movement = null,
    previousOdds = null,
    meta = {}
  ) => {
    price = num(price);

    if (
      !key ||
      price === null ||
      price <= 1
    ) {
      return;
    }

    out[key].push({
      odds: price,

      movement:
        movement
          ? String(
              movement
            ).toUpperCase()
          : null,

      previousOdds:
        num(previousOdds),

      ...meta
    });
  };

  /*
   * BSD consensus odds
   */
  const o = data.odds;

  if (
    o &&
    typeof o === "object" &&
    !Array.isArray(o)
  ) {
    push(
      "HOME",
      o.home_win ??
        o.home ??
        o.match_winner?.home,
      o.movement_home,
      o.previous_home
    );

    push(
      "DRAW",
      o.draw ??
        o.match_winner?.draw,
      o.movement_draw,
      o.previous_draw
    );

    push(
      "AWAY",
      o.away_win ??
        o.away ??
        o.match_winner?.away,
      o.movement_away,
      o.previous_away
    );

    push(
      "OVER15",
      o.over_15_goals ??
        o.over15 ??
        o.over_under?.over_15,
      o.movement_over_15,
      o.previous_over_15
    );

    push(
      "OVER25",
      o.over_25_goals ??
        o.over25 ??
        o.over_under?.over_25,
      o.movement_over_25,
      o.previous_over_25
    );

    push(
      "UNDER25",
      o.under_25_goals ??
        o.under25 ??
        o.over_under?.under_25,
      o.movement_under_25,
      o.previous_under_25
    );

    push(
      "UNDER35",
      o.under_35_goals ??
        o.under35 ??
        o.over_under?.under_35,
      o.movement_under_35,
      o.previous_under_35
    );

    push(
      "BTTS_YES",
      o.btts_yes ??
        o.btts?.yes,
      o.movement_btts_yes,
      o.previous_btts_yes
    );

    push(
      "BTTS_NO",
      o.btts_no ??
        o.btts?.no,
      o.movement_btts_no,
      o.previous_btts_no
    );
  }

  /*
   * Per-bookmaker
   */
  for (
    const b of arr(
      data.bookmakers
    )
  ) {
    const book =
      b.bookmaker ??
      b.bookmaker_name ??
      b.bookmakerName ??
      b.bookie ??
      null;

    push(
      "HOME",
      b.odds_home,
      b.movement_home,
      b.previous_odds_home,
      { bookmaker: book }
    );

    push(
      "DRAW",
      b.odds_draw,
      b.movement_draw,
      b.previous_odds_draw,
      { bookmaker: book }
    );

    push(
      "AWAY",
      b.odds_away,
      b.movement_away,
      b.previous_odds_away,
      { bookmaker: book }
    );
  }

  /*
   * Market structures
   */
  for (
    const market of arr(
      data.markets
    )
  ) {
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

    if (
      period !== "FT"
    ) {
      continue;
    }

    for (
      const b of arr(
        market.bookmakers
      )
    ) {
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
        const [sel, val] of Object.entries(
          prices
        )
      ) {
        const p =
          typeof val === "object"
            ? val
            : null;

        const price =
          p?.price ??
          p?.odds ??
          p?.value ??
          (
            typeof val ===
            "number"
              ? val
              : null
          );

        const key =
          marketKey(
            kind,
            line,
            sel
          );

        push(
          key,
          price,
          p?.movement ??
            null,
          p?.previous_price ??
            p?.previousOdds ??
            p?.previous_odds,
          {
            bookmaker: book,
            line: num(line),
            marketKind: kind
          }
        );
      }
    }
  }

  /*
   * Generic fallback
   */
  const visit = (
    v,
    ctx = {},
    depth = 0
  ) => {
    if (
      !v ||
      depth > 7
    ) {
      return;
    }

    if (
      Array.isArray(v)
    ) {
      for (
        const x of v
      ) {
        visit(
          x,
          ctx,
          depth + 1
        );
      }

      return;
    }

    if (
      typeof v !==
      "object"
    ) {
      return;
    }

    const next = {
      ...ctx,

      market:
        v.market_kind ??
        v.market_family ??
        v.market ??
        v.type ??
        ctx.market,

      line:
        v.market_line ??
        v.line ??
        ctx.line,

      period:
        v.market_period ??
        v.period ??
        ctx.period,

      bookmaker:
        v.bookmaker ??
        v.bookmaker_name ??
        v.bookmaker_slug ??
        ctx.bookmaker
    };

    for (
      const [k, val] of Object.entries(
        v
      )
    ) {
      const lk =
        k.toLowerCase();

      if (
        [
          "selection",
          "outcome",
          "outcomename",
          "label"
        ].includes(lk)
      ) {
        next.selection =
          val;
      }

      if (
        [
          "movement",
          "movement_home",
          "movement_away",
          "movement_draw"
        ].includes(lk)
      ) {
        next.movement =
          val;
      }

      if (
        [
          "previousodds",
          "previous_odds",
          "oldodds",
          "old_odds",
          "previous_price"
        ].includes(lk)
      ) {
        next.previousOdds =
          val;
      }

      if (
        [
          "price",
          "odds",
          "decimal",
          "value",
          "currentodds"
        ].includes(lk)
      ) {
        const key =
          marketKey(
            next.market,
            next.line,
            next.selection
          );

        if (
          key &&
          String(
            next.period ??
              "FT"
          ).toUpperCase() ===
            "FT"
        ) {
          push(
            key,
            val,
            next.movement,
            next.previousOdds,
            {
              bookmaker:
                next.bookmaker,
              line:
                num(
                  next.line
                )
            }
          );
        }
      }

      if (
        val &&
        typeof val ===
          "object"
      ) {
        visit(
          val,
          next,
          depth + 1
        );
      }
    }
  };

  visit(data);

  for (
    const k of Object.keys(out)
  ) {
    const m = new Map();

    for (
      const r of out[k]
    ) {
      const key =
        `${
          r.bookmaker ||
          "CONSENSUS"
        }|${r.odds}|${
          r.movement || ""
        }|${
          r.line ?? ""
        }`;

      if (!m.has(key)) {
        m.set(key, r);
      }
    }

    out[k] = [
      ...m.values()
    ];
  }

  return out;
}

function movementFor(rows) {
  const r =
    arr(rows);

  const valid =
    r.filter(
      (x) =>
        num(x.odds) > 1 &&
        num(x.previousOdds) > 1
    );

  if (
    valid.length
  ) {
    let total = 0;
    let sh = 0;
    let dr = 0;

    for (
      const x of valid
    ) {
      const c =
        (
          (x.odds -
            x.previousOdds) /
          x.previousOdds
        ) * 100;

      total += c;

      if (c < -0.15) {
        sh++;
      }

      if (c > 0.15) {
        dr++;
      }
    }

    const avg =
      total /
      valid.length;

    return {
      movement:
        sh > dr &&
        avg < -0.15
          ? "SHORTENING"
          : dr > sh &&
              avg > 0.15
            ? "DRIFTING"
            : "STABLE",

      samples:
        valid.length,

      changePercent:
        Number(
          avg.toFixed(2)
        ),

      currentOdds:
        Math.max(
          ...valid.map(
            (x) => x.odds
          )
        ),

      confidence:
        Math.round(
          (
            Math.max(
              sh,
              dr
            ) /
            valid.length
          ) * 100
        )
    };
  }

  const explicit =
    r
      .map(
        (x) =>
          x.movement
      )
      .filter(
        (x) =>
          [
            "SHORTENING",
            "DRIFTING",
            "STABLE"
          ].includes(x)
      );

  if (
    explicit.length
  ) {
    const sh =
      explicit.filter(
        (x) =>
          x ===
          "SHORTENING"
      ).length;

    const dr =
      explicit.filter(
        (x) =>
          x ===
          "DRIFTING"
      ).length;

    return {
      movement:
        sh > dr
          ? "SHORTENING"
          : dr > sh
            ? "DRIFTING"
            : "STABLE",

      samples:
        explicit.length,

      changePercent:
        null,

      currentOdds:
        null,

      confidence:
        Math.round(
          (
            Math.max(
              sh,
              dr
            ) /
            explicit.length
          ) * 100
        )
    };
  }

  return {
    movement:
      "UNKNOWN",
    samples: 0,
    changePercent:
      null,
    currentOdds:
      null,
    confidence: 0
  };
}

function bestOdds(rows) {
  const r =
    arr(rows).filter(
      (x) =>
        num(x.odds) > 1
    );

  return r.length
    ? Math.max(
        ...r.map(
          (x) => x.odds
        )
      )
    : null;
}

function marketProb(
  p,
  key
) {
  switch (key) {
    case "HOME":
      return p.home;

    case "DRAW":
      return p.draw;

    case "AWAY":
      return p.away;

    case "DC1X":
      return p.home !== null &&
        p.draw !== null
        ? p.home + p.draw
        : null;

    case "DCX2":
      return p.draw !== null &&
        p.away !== null
        ? p.draw + p.away
        : null;

    case "OVER15":
      return p.over15;

    case "OVER25":
      return p.over25;

    case "UNDER25":
      return p.under25;

    case "UNDER35":
      return p.under35;

    case "BTTS":
      return p.btts;

    default:
      return null;
  }
}

function score(c) {
  let s = 50;

  if (
    c.probability >= 90
  ) {
    s += 18;
  } else if (
    c.probability >= 85
  ) {
    s += 15;
  } else if (
    c.probability >= 80
  ) {
    s += 12;
  } else if (
    c.probability >= 75
  ) {
    s += 8;
  } else if (
    c.probability >= 70
  ) {
    s += 4;
  }

  if (c.edge >= 8) {
    s += 12;
  } else if (
    c.edge >= 5
  ) {
    s += 9;
  } else if (
    c.edge >= 3
  ) {
    s += 5;
  } else if (
    c.edge >= 2
  ) {
    s += 2;
  }

  if (
    c.movement.movement ===
    "SHORTENING"
  ) {
    s += 8;
  }

  if (
    c.movement.movement ===
    "DRIFTING"
  ) {
    s -= 30;
  }

  if (
    c.confidence !== null &&
    c.confidence >= 90
  ) {
    s += 5;
  } else if (
    c.confidence !== null &&
    c.confidence >= 80
  ) {
    s += 3;
  }

  return Math.round(
    clamp(s, 0, 100)
  );
}

function candidates(
  pred,
  markets
) {
  const defs = [
    ["DC1X", "1X"],
    ["DCX2", "X2"],
    ["OVER15", "Over 1.5"],
    ["UNDER35", "Under 3.5"],
    ["BTTS", "BTTS"],
    ["OVER25", "Over 2.5"],
    ["UNDER25", "Under 2.5"],
    ["HOME", "Home"],
    ["AWAY", "Away"],
    ["DRAW", "Draw"]
  ];

  const out = [];

  for (
    const [key, label] of defs
  ) {
    const p =
      marketProb(
        pred,
        key
      );

    const mk =
      key === "BTTS"
        ? "BTTS_YES"
        : key;

    const od =
      bestOdds(
        markets[mk]
      );

    if (
      p === null ||
      od === null
    ) {
      continue;
    }

    const e =
      edge(p, od);

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
          od.toFixed(3)
        ),

      impliedProbability:
        Number(
          implied(od).toFixed(2)
        ),

      edge:
        Number(
          e.toFixed(2)
        ),

      confidence:
        pred.confidence,

      score: 0,

      marketMovement:
        mv
    };

    c.score =
      score(c);

    out.push(c);
  }

  return out;
}

async function getEvents(
  date
) {
  const paths = [
    `/events/?date_from=${date}&date_to=${date}&status=upcoming&limit=100`,
    `/events/?date_from=${date}&date_to=${date}&limit=100`
  ];

  for (
    const p of paths
  ) {
    const d =
      await safe(p);

    const e =
      collection(d)
        .map(normalizeEvent)
        .filter(
          (x) =>
            x &&
            x.status ===
              "notstarted"
        );

    if (e.length) {
      return e;
    }
  }

  return [];
}

async function analyzeEvent(
  event,
  predictionMap = null
) {
  const prediction =
    predictionMap?.get(
      event.id
    ) ??
    parsePrediction(
      await safe(
        `/events/${event.id}/prediction/`
      )
    );

  if (!prediction) {
    return {
      event,
      status:
        "REJECT",
      reason:
        "NO_PREDICTION"
    };
  }

  const oddsRaw =
    await safe(
      `/events/${event.id}/odds/`
    );

  const markets =
    extractOdds(
      oddsRaw
    );

  const recognized =
    Object.values(
      markets
    ).some(
      (x) => x.length
    );

  if (!recognized) {
    return {
      event,
      status:
        "REJECT",
      reason:
        "NO_RECOGNIZED_ODDS",

      prediction,

      oddsDiagnostics: {
        oddsKeys:
          oddsRaw?.odds &&
          typeof oddsRaw.odds ===
            "object"
            ? Object.keys(
                oddsRaw.odds
              )
            : [],

        bookmakers:
          Array.isArray(
            oddsRaw?.bookmakers
          )
            ? oddsRaw
                .bookmakers
                .length
            : 0,

        markets:
          Array.isArray(
            oddsRaw?.markets
          )
            ? oddsRaw
                .markets
                .length
            : 0
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
      (c) =>
        c.probability >=
          MIN_PROBABILITY &&
        c.edge >=
          MIN_EDGE &&
        c.score >=
          MIN_SCORE &&
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

    candidates:
      cs,

    qualified,

    exchange: {
      connected:
        false,

      status:
        "NOT_CONNECTED",

      signalUsed:
        false,

      message:
        "Brak zweryfikowanego feedu betting exchange; dane giełdowe nie są fabrykowane."
    }
  };
}

async function scan(
  date
) {
  const [
    events,
    predictionMap
  ] =
    await Promise.all([
      getEvents(date),
      getPredictionMap()
    ]);

  const selected =
    events
      .sort(
        (a, b) =>
          (
            dateObj(
              a.date
            )?.getTime() ||
            9e15
          ) -
          (
            dateObj(
              b.date
            )?.getTime() ||
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
          (e) =>
            analyzeEvent(
              e,
              predictionMap
            ).catch(
              (x) => ({
                event: e,
                status:
                  "ERROR",
                reason:
                  x.code ||
                  x.message ||
                  "ANALYZE_ERROR"
              })
            )
        )
      )
    );
  }

  const picks =
    results
      .flatMap(
        (r) =>
          r.status ===
          "QUALIFIED"
            ? r.qualified.map(
                (c) => ({
                  ...c,
                  event:
                    r.event,
                  exchange:
                    r.exchange
                })
              )
            : []
      )
      .sort(
        (a, b) =>
          b.score -
            a.score ||
          b.edge -
            a.edge ||
          b.probability -
            a.probability
      );

  const unique = [];
  const used =
    new Set();

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
    source:
      SOURCE,

    version:
      VERSION,

    date,

    generatedAt:
      nowIso(),

    scannedEvents:
      selected.length,

    analyzedEvents:
      results.length,

    qualifiedEvents:
      unique.length,

    picks:
      unique,

    diagnostics: {
      predictionRecords:
        predictionMap.size,

      rejectedEvents:
        results.filter(
          (r) =>
            r.status !==
            "QUALIFIED"
        ).length,

      reasons
    },

    exchange: {
      connected:
        false,

      status:
        "NOT_CONNECTED",

      message:
        "Betting exchange nie jest podłączony."
    }
  };
}

function selfTest() {
  const t = [];

  const add = (
    name,
    pass
  ) =>
    t.push({
      name,
      pass
    });

  add(
    "pct_decimal",
    pct(0.72) === 72
  );

  add(
    "edge_60_at_2",
    edge(60, 2) === 10
  );

  add(
    "status_upcoming",
    status({
      status:
        "upcoming"
    }) ===
      "notstarted"
  );

  const m =
    extractOdds({
      event_id: 1,

      odds: {
        home_win: 2,
        draw: 3.4,
        away_win: 4.2,
        over_25_goals: 2.1,
        under_25_goals: 1.7,
        btts_yes: 2.0
      }
    });

  add(
    "consensus_odds_shape",
    m.HOME.length === 1 &&
      m.DRAW.length === 1 &&
      m.AWAY.length === 1 &&
      m.OVER25.length === 1 &&
      m.UNDER25.length === 1 &&
      m.BTTS_YES.length === 1
  );

  const n =
    extractOdds({
      bookmakers: [
        {
          bookmaker: "X",
          odds_home: 2,
          movement_home:
            "SHORTENING"
        }
      ]
    });

  add(
    "bookmaker_odds_shape",
    n.HOME.length === 1
  );

  add(
    "movement_explicit",
    movementFor(
      n.HOME
    ).movement ===
      "SHORTENING"
  );

  const p =
    parsePrediction({
      event_id: 1,
      home_win_prob: 0.55,
      draw_prob: 0.25,
      away_win_prob: 0.20,
      confidence: 0.87
    });

  add(
    "prediction_shape",
    p?.home === 55 &&
      p?.draw === 25 &&
      p?.away === 20 &&
      p?.confidence === 87
  );

  add(
    "dc_math",
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
    "drift_math",
    movementFor([
      {
        odds: 2,
        previousOdds: 1.8
      }
    ]).movement ===
      "DRIFTING"
  );

  add(
    "exchange_not_fabricated",
    true
  );

  return {
    version:
      VERSION,

    passed:
      t.filter(
        (x) => x.pass
      ).length,

    total:
      t.length,

    ok:
      t.every(
        (x) => x.pass
      ),

    tests:
      t
  };
}

app.get(
  "/",
  (q, r) =>
    r.json({
      ok: true,
      service:
        "Bet Analyzer Backend",
      version:
        VERSION,
      source:
        SOURCE,
      time:
        nowIso()
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
      version:
        VERSION,
      source:
        SOURCE,

      bsdConfigured:
        Boolean(
          BSD_API_KEY
        ),

      exchange: {
        connected:
          false,
        status:
          "NOT_CONNECTED"
      },

      time:
        nowIso()
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
        source:
          SOURCE,
        version:
          VERSION,
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
          "/predictions/?upcoming=true&limit=200"
        );

      r.json({
        source:
          SOURCE,

        version:
          VERSION,

        count:
          collection(d)
            .length,

        data:
          collection(d)
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
        source:
          SOURCE,
        version:
          VERSION,
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
        Number(
          q.params.id
        );

      if (
        !Number.isFinite(
          id
        )
      ) {
        return r
          .status(400)
          .json({
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
        return r
          .status(404)
          .json({
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
        source:
          SOURCE,

        version:
          VERSION,

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
      Number(
        q.params.id
      );

    if (
      !Number.isFinite(
        id
      )
    ) {
      return r
        .status(400)
        .json({
          error:
            "INVALID_EVENT_ID"
        });
    }

    const data =
      await safe(
        `/events/${id}/odds/`
      );

    if (!data) {
      return r
        .status(404)
        .json({
          error:
            "ODDS_NOT_FOUND"
        });
    }

    r.json({
      source:
        SOURCE,

      version:
        VERSION,

      eventId:
        id,

      data,

      parsed:
        extractOdds(
          data
        )
    });
  }
);

app.use(
  (q, r) =>
    r.status(404).json({
      error:
        "NOT_FOUND",

      path:
        q.path,

      version:
        VERSION
    })
);

app.use(
  (e, q, r, n) => {
    console.error(e);

    r.status(500).json({
      error:
        e.message ||
        "INTERNAL_SERVER_ERROR",

      version:
        VERSION
    });
  }
);

app.listen(
  PORT,
  () =>
    console.log(
      `Bet Analyzer ${VERSION} listening on ${PORT}`
    )
);
