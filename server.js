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
const BSD_PUBLIC = "https://sports.bzzoiro.com/api";

const VERSION = "7.0.4";
const SOURCE = "BSD";

const authHeaders = () => ({
  Authorization: `Token ${BSD_API_KEY}`,
  Accept: "application/json",
});

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percent(value) {
  const n = numberOrNull(value);

  if (n === null) return null;

  return n <= 1 ? n * 100 : n;
}

function isoDate(value) {
  if (typeof value !== "string") return null;
  return value.slice(0, 10);
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: authHeaders(),
  });

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

/* =========================================================
   PREDICTIONS
   ========================================================= */

function extractPredictions(body) {
  if (Array.isArray(body?.results)) {
    return body.results;
  }

  if (Array.isArray(body?.data)) {
    return body.data;
  }

  if (Array.isArray(body?.predictions)) {
    return body.predictions;
  }

  if (Array.isArray(body)) {
    return body;
  }

  return [];
}

async function fetchAllPredictions() {
  const all = [];

  let offset = 0;
  let total = Infinity;

  while (offset < total && offset < 2000) {
    const url =
      `${BSD_PUBLIC}/predictions/` +
      `?limit=200&offset=${offset}`;

    const result = await fetchJson(url);

    if (!result.ok) {
      throw new Error(
        `BSD predictions HTTP ${result.status}`
      );
    }

    const rows = extractPredictions(result.body);

    total =
      numberOrNull(result.body?.count) ??
      offset + rows.length;

    all.push(...rows);

    if (!rows.length || rows.length < 200) {
      break;
    }

    offset += rows.length;
  }

  return {
    all,
    total,
  };
}

/* =========================================================
   PROBABILITIES
   ========================================================= */

function getProbability(row, market) {
  const p =
    row?.probabilities ??
    row?.prediction ??
    row?.probs ??
    {};

  const aliases = {
    home: [
      "home",
      "home_win",
      "1",
    ],

    draw: [
      "draw",
      "x",
    ],

    away: [
      "away",
      "away_win",
      "2",
    ],

    over15: [
      "over_15",
      "over15",
      "over_1_5",
    ],

    under15: [
      "under_15",
      "under15",
      "under_1_5",
    ],

    over25: [
      "over_25",
      "over25",
      "over_2_5",
    ],

    under25: [
      "under_25",
      "under25",
      "under_2_5",
    ],

    over35: [
      "over_35",
      "over35",
      "over_3_5",
    ],

    under35: [
      "under_35",
      "under35",
      "under_3_5",
    ],

    bttsYes: [
      "btts_yes",
      "bttsYes",
      "yes",
    ],

    bttsNo: [
      "btts_no",
      "bttsNo",
      "no",
    ],
  };

  for (const key of aliases[market] || []) {
    const value = percent(
      p?.[key] ?? row?.[key]
    );

    if (value !== null) {
      return value;
    }
  }

  return null;
}

/* =========================================================
   CANDIDATES
   ========================================================= */

function buildCandidates(row) {
  const home =
    row?.home_team?.name ??
    row?.home ??
    row?.home_name ??
    "";

  const away =
    row?.away_team?.name ??
    row?.away ??
    row?.away_name ??
    "";

  const eventId =
    row?.event_id ??
    row?.eventId ??
    row?.id;

  const date =
    row?.event_date ??
    row?.date ??
    null;

  const league =
    row?.league?.name ??
    row?.league_name ??
    row?.league ??
    null;

  const confidence = percent(
    row?.confidence ??
    row?.model_confidence
  );

  const homeProbability =
    getProbability(row, "home");

  const drawProbability =
    getProbability(row, "draw");

  const awayProbability =
    getProbability(row, "away");

  const markets = [
    {
      market: "DOUBLE_CHANCE",
      pick: "1X",
      probability:
        homeProbability !== null &&
        drawProbability !== null
          ? homeProbability + drawProbability
          : null,
    },

    {
      market: "DOUBLE_CHANCE",
      pick: "X2",
      probability:
        awayProbability !== null &&
        drawProbability !== null
          ? awayProbability + drawProbability
          : null,
    },

    {
      market: "1X2",
      pick: "1",
      probability: homeProbability,
    },

    {
      market: "1X2",
      pick: "X",
      probability: drawProbability,
    },

    {
      market: "1X2",
      pick: "2",
      probability: awayProbability,
    },

    {
      market: "TOTAL",
      pick: "OVER 1.5",
      probability: getProbability(row, "over15"),
    },

    {
      market: "TOTAL",
      pick: "UNDER 1.5",
      probability: getProbability(row, "under15"),
    },

    {
      market: "TOTAL",
      pick: "OVER 2.5",
      probability: getProbability(row, "over25"),
    },

    {
      market: "TOTAL",
      pick: "UNDER 2.5",
      probability: getProbability(row, "under25"),
    },

    {
      market: "TOTAL",
      pick: "OVER 3.5",
      probability: getProbability(row, "over35"),
    },

    {
      market: "TOTAL",
      pick: "UNDER 3.5",
      probability: getProbability(row, "under35"),
    },

    {
      market: "BTTS",
      pick: "BTTS YES",
      probability: getProbability(row, "bttsYes"),
    },

    {
      market: "BTTS",
      pick: "BTTS NO",
      probability: getProbability(row, "bttsNo"),
    },
  ];

  return markets
    .filter(
      (item) =>
        item.probability !== null
    )
    .map((item) => {
      const probability =
        Math.round(
          item.probability * 10
        ) / 10;

      const fairOdds =
        probability > 0
          ? Math.round(
              (100 / probability) * 1000
            ) / 1000
          : null;

      /*
       * IMPORTANT:
       * Existing model score is preserved.
       * No new weighting system is introduced here.
       */
      const score =
        probability +
        (confidence ?? 0) * 0.18;

      return {
        eventId,

        event:
          `${home} – ${away}`,

        home,
        away,

        date,
        league,

        market:
          item.market,

        pick:
          item.pick,

        marketKey:
          item.pick
            .replace(/[^A-Z0-9]+/gi, "")
            .toUpperCase(),

        probability,

        confidence,

        odds: null,

        fairOdds,

        value: null,

        recommendationStrength: 0,

        bsdRecommendation:
          row?.recommendation ??
          row?.recommended ??
          null,

        score,

        oddsSource: "UNAVAILABLE",

        bookmaker: null,

        marketMovement: null,

        exchangeMovement: null,

        status:
          row?.status ??
          "notstarted",
      };
    });
}

/* =========================================================
   BSD EVENT ODDS
   =========================================================

   Official football endpoint:

   /api/v2/events/{eventId}/odds/

   BSD returns:

   home_win
   draw
   away_win

   over_15_goals
   under_15_goals
   over_25_goals
   under_25_goals
   over_35_goals
   under_35_goals

   btts_yes
   btts_no

   This is now parsed directly.
   No guessing from generic market names.
   ========================================================= */

function normalizeEventOdds(body) {
  const odds =
    body?.odds ??
    body?.data?.odds ??
    body?.result?.odds ??
    null;

  if (!odds || typeof odds !== "object") {
    return {};
  }

  return {
    "1":
      numberOrNull(
        odds.home_win ??
        odds.match_winner?.home
      ),

    "X":
      numberOrNull(
        odds.draw ??
        odds.match_winner?.draw
      ),

    "2":
      numberOrNull(
        odds.away_win ??
        odds.match_winner?.away
      ),

    OVER15:
      numberOrNull(
        odds.over_15_goals ??
        odds.over_15 ??
        odds.over15 ??
        odds.over_under?.over_15
      ),

    UNDER15:
      numberOrNull(
        odds.under_15_goals ??
        odds.under_15 ??
        odds.under15 ??
        odds.over_under?.under_15
      ),

    OVER25:
      numberOrNull(
        odds.over_25_goals ??
        odds.over_25 ??
        odds.over25 ??
        odds.over_under?.over_25
      ),

    UNDER25:
      numberOrNull(
        odds.under_25_goals ??
        odds.under_25 ??
        odds.under25 ??
        odds.over_under?.under_25
      ),

    OVER35:
      numberOrNull(
        odds.over_35_goals ??
        odds.over_35 ??
        odds.over35 ??
        odds.over_under?.over_35
      ),

    UNDER35:
      numberOrNull(
        odds.under_35_goals ??
        odds.under_35 ??
        odds.under35 ??
        odds.over_under?.under_35
      ),

    BTTSYES:
      numberOrNull(
        odds.btts_yes ??
        odds.btts?.yes
      ),

    BTTSNO:
      numberOrNull(
        odds.btts_no ??
        odds.btts?.no
      ),
  };
}

async function fetchEventOdds(eventId) {
  const endpoint =
    `${BSD_BASE}/events/${eventId}/odds/`;

  const result =
    await fetchJson(endpoint);

  return {
    endpoint,
    ...result,

    odds:
      result.ok
        ? normalizeEventOdds(result.body)
        : {},
  };
}

/* =========================================================
   MARKET KEY
   ========================================================= */

function marketKeyFromPick(pick) {
  return pick
    .replace(/[^A-Z0-9]+/gi, "")
    .toUpperCase();
}

/* =========================================================
   APPLY ODDS
   ========================================================= */

function applyOdds(candidate, oddsData) {
  const key =
    marketKeyFromPick(
      candidate.pick
    );

  const odds =
    oddsData[key] ??
    null;

  candidate.odds = odds;

  candidate.fairOdds =
    candidate.probability > 0
      ? Math.round(
          (100 / candidate.probability) *
          1000
        ) / 1000
      : null;

  candidate.value =
    odds !== null &&
    candidate.probability !== null
      ? Math.round(
          (
            odds *
            (candidate.probability / 100) -
            1
          ) * 10000
        ) / 10000
      : null;

  candidate.oddsSource =
    odds !== null
      ? "BSD_CONSENSUS"
      : "UNAVAILABLE";

  candidate.bookmaker =
    odds !== null
      ? "Consensus"
      : null;

  return candidate;
}

/* =========================================================
   RANKING
   =========================================================

   Existing score remains the primary model score.

   Odds/value are used only after the model score,
   not as a replacement for the model weights.
   ========================================================= */

function rankingScore(candidate) {
  let score =
    candidate.score;

  /*
   * Keep existing score philosophy.
   * Value is a secondary market-quality signal.
   */

  if (candidate.value !== null) {
    score +=
      candidate.value * 20;
  } else {
    score -= 5;
  }

  return score;
}

/* =========================================================
   ROOT
   ========================================================= */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
  });
});

/* =========================================================
   TOP PICKS
   ========================================================= */

app.get(
  "/api/top-picks",
  async (req, res) => {
    const date =
      req.query.date ??
      new Date()
        .toISOString()
        .slice(0, 10);

    try {
      const started =
        Date.now();

      const predictionData =
        await fetchAllPredictions();

      const all =
        predictionData.all;

      const dateRows =
        all.filter(
          (row) =>
            isoDate(
              row?.event_date ??
              row?.date ??
              row?.event?.date
            ) === date
        );

      let candidates =
        dateRows.flatMap(
          buildCandidates
        );

      /*
       * Only 30 events are enriched with odds.
       * This keeps the BSD request load reasonable.
       *
       * The selection here uses the EXISTING
       * model score only.
       */
      const preliminaryEvents =
        Array.from(
          new Map(
            [...candidates]
              .sort(
                (a, b) =>
                  b.score -
                  a.score
              )
              .map(
                (candidate) => [
                  candidate.eventId,
                  candidate,
                ]
              )
          ).values()
        ).slice(0, 30);

      let requests = 0;
      let successful = 0;
      let failed = 0;

      for (
        const base
        of preliminaryEvents
      ) {
        requests++;

        const oddsResult =
          await fetchEventOdds(
            base.eventId
          );

        if (oddsResult.ok) {
          successful++;
        } else {
          failed++;
        }

        const eventCandidates =
          candidates.filter(
            (candidate) =>
              candidate.eventId ===
              base.eventId
          );

        for (
          const candidate
          of eventCandidates
        ) {
          applyOdds(
            candidate,
            oddsResult.odds
          );
        }
      }

      /*
       * Rank after real odds have been attached.
       */

      const ranked =
        candidates
          .map(
            (candidate) => ({
              ...candidate,
              internalRank:
                rankingScore(
                  candidate
                ),
            })
          )
          .sort(
            (a, b) =>
              b.internalRank -
              a.internalRank
          );

      /*
       * Maximum 5.
       * Never more than one pick
       * from the same event.
       *
       * Do not force 5 picks.
       */

      const topPicks = [];

      const usedEvents =
        new Set();

      let totalMarkets = 0;

      for (
        const candidate
        of ranked
      ) {
        if (
          usedEvents.has(
            candidate.eventId
          )
        ) {
          continue;
        }

        /*
         * A pick without an actual BSD
         * price is not allowed into final
         * top picks.
         */
        if (
          candidate.odds === null
        ) {
          continue;
        }

        /*
         * Maximum 3 total markets
         * in the final five.
         *
         * This prevents the list from
         * becoming five identical
         * Over/Under selections.
         */
        if (
          candidate.market ===
            "TOTAL" &&
          totalMarkets >= 3
        ) {
          continue;
        }

        usedEvents.add(
          candidate.eventId
        );

        if (
          candidate.market ===
          "TOTAL"
        ) {
          totalMarkets++;
        }

        const {
          internalRank,
          ...output
        } = candidate;

        /*
         * No exchange movement is invented.
         */
        output.exchangeMovement =
          null;

        topPicks.push(
          output
        );

        if (
          topPicks.length >= 5
        ) {
          break;
        }
      }

      res.json({
        version: VERSION,

        source: SOURCE,

        date,

        generatedAt:
          new Date().toISOString(),

        processingMs:
          Date.now() -
          started,

        exchange: {
          connected: false,

          status:
            "NOT_CONNECTED",

          message:
            "Betting exchange data is not connected. No exchange movement is fabricated.",
        },

        predictionsTotal:
          all.length,

        predictionsDownloaded:
          all.length,

        predictionsFound:
          dateRows.length,

        candidatesFound:
          candidates.length,

        qualificationCount:
          topPicks.length,

        maxTopPicks: 5,

        oddsStatus: {
          endpoint:
            "/api/v2/events/{id}/odds/",

          requests,

          successful,

          failed,

          message:
            successful > 0
              ? "Real BSD consensus odds were retrieved and included in ranking."
              : "No BSD event odds were retrieved.",
        },

        topPicks,
      });

    } catch (error) {
      console.error(
        "TOP PICKS ERROR:",
        error
      );

      res.status(500).json({
        version: VERSION,

        source: SOURCE,

        error:
          error?.message ??
          "Unknown error",
      });
    }
  }
);

/* =========================================================
   DEBUG ODDS
   ========================================================= */

app.get(
  "/api/debug-odds",
  async (req, res) => {
    const eventId =
      req.query.eventId;

    if (!eventId) {
      return res
        .status(400)
        .json({
          error:
            "eventId required",
        });
    }

    try {
      const result =
        await fetchEventOdds(
          eventId
        );

      res
        .status(
          result.status || 500
        )
        .json({
          version: VERSION,

          eventId,

          endpoint:
            `${BSD_BASE}/events/${eventId}/odds/`,

          httpStatus:
            result.status,

          normalized:
            result.odds,

          raw:
            result.body,
        });

    } catch (error) {
      res.status(500).json({
        version: VERSION,
        eventId,
        error:
          error?.message ??
          "Unknown error",
      });
    }
  }
);

/* =========================================================
   START
   ========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Bet Analyzer Live ${VERSION} listening on ${PORT}`
    );
  }
);
