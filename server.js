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

const VERSION = "7.0.5";
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

function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null
    ) {
      return value;
    }
  }

  return null;
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

/*
 * IMPORTANT:
 * BSD supports date_from/date_to on predictions.
 *
 * We now ask BSD directly for the requested date
 * instead of downloading everything and trying to
 * infer the date locally.
 */
async function fetchPredictionsForDate(date) {
  const url =
    `${BSD_PUBLIC}/predictions/` +
    `?date_from=${encodeURIComponent(date)}` +
    `&date_to=${encodeURIComponent(date)}` +
    `&limit=200` +
    `&offset=0`;

  const result = await fetchJson(url);

  if (!result.ok) {
    throw new Error(
      `BSD predictions HTTP ${result.status}`
    );
  }

  const rows =
    extractPredictions(result.body);

  return {
    rows,
    total:
      numberOrNull(
        result.body?.count
      ) ?? rows.length,
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
      "over_15_goals",
    ],

    under15: [
      "under_15",
      "under15",
      "under_1_5",
      "under_15_goals",
    ],

    over25: [
      "over_25",
      "over25",
      "over_2_5",
      "over_25_goals",
    ],

    under25: [
      "under_25",
      "under25",
      "under_2_5",
      "under_25_goals",
    ],

    over35: [
      "over_35",
      "over35",
      "over_3_5",
      "over_35_goals",
    ],

    under35: [
      "under_35",
      "under35",
      "under_3_5",
      "under_35_goals",
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

  for (
    const key of
    aliases[market] || []
  ) {
    const value =
      percent(
        p?.[key] ??
        row?.[key]
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

function getTeamName(
  row,
  side
) {
  if (side === "home") {
    return (
      row?.home_team?.name ??
      row?.home?.name ??
      row?.home ??
      row?.home_name ??
      ""
    );
  }

  return (
    row?.away_team?.name ??
    row?.away?.name ??
    row?.away ??
    row?.away_name ??
    ""
  );
}

function getEventId(row) {
  return (
    row?.event_id ??
    row?.eventId ??
    row?.event?.id ??
    row?.id
  );
}

function getEventDate(row) {
  return (
    row?.event_date ??
    row?.eventDate ??
    row?.date ??
    row?.kickoff_at ??
    row?.event?.event_date ??
    row?.event?.date ??
    row?.event?.kickoff_at ??
    null
  );
}

function getLeague(row) {
  return (
    row?.league?.name ??
    row?.league_name ??
    row?.competition?.name ??
    row?.league ??
    null
  );
}

function buildCandidates(row) {
  const home =
    getTeamName(row, "home");

  const away =
    getTeamName(row, "away");

  const eventId =
    getEventId(row);

  const date =
    getEventDate(row);

  const league =
    getLeague(row);

  const confidence =
    percent(
      row?.confidence ??
      row?.model_confidence
    );

  const homeProbability =
    getProbability(
      row,
      "home"
    );

  const drawProbability =
    getProbability(
      row,
      "draw"
    );

  const awayProbability =
    getProbability(
      row,
      "away"
    );

  const markets = [
    {
      market:
        "DOUBLE_CHANCE",

      pick:
        "1X",

      probability:
        homeProbability !== null &&
        drawProbability !== null
          ? homeProbability +
            drawProbability
          : null,
    },

    {
      market:
        "DOUBLE_CHANCE",

      pick:
        "X2",

      probability:
        awayProbability !== null &&
        drawProbability !== null
          ? awayProbability +
            drawProbability
          : null,
    },

    {
      market:
        "1X2",

      pick:
        "1",

      probability:
        homeProbability,
    },

    {
      market:
        "1X2",

      pick:
        "X",

      probability:
        drawProbability,
    },

    {
      market:
        "1X2",

      pick:
        "2",

      probability:
        awayProbability,
    },

    {
      market:
        "TOTAL",

      pick:
        "OVER 1.5",

      probability:
        getProbability(
          row,
          "over15"
        ),
    },

    {
      market:
        "TOTAL",

      pick:
        "UNDER 1.5",

      probability:
        getProbability(
          row,
          "under15"
        ),
    },

    {
      market:
        "TOTAL",

      pick:
        "OVER 2.5",

      probability:
        getProbability(
          row,
          "over25"
        ),
    },

    {
      market:
        "TOTAL",

      pick:
        "UNDER 2.5",

      probability:
        getProbability(
          row,
          "under25"
        ),
    },

    {
      market:
        "TOTAL",

      pick:
        "OVER 3.5",

      probability:
        getProbability(
          row,
          "over35"
        ),
    },

    {
      market:
        "TOTAL",

      pick:
        "UNDER 3.5",

      probability:
        getProbability(
          row,
          "under35"
        ),
    },

    {
      market:
        "BTTS",

      pick:
        "BTTS YES",

      probability:
        getProbability(
          row,
          "bttsYes"
        ),
    },

    {
      market:
        "BTTS",

      pick:
        "BTTS NO",

      probability:
        getProbability(
          row,
          "bttsNo"
        ),
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
              (100 / probability) *
              1000
            ) / 1000
          : null;

      /*
       * EXISTING SCORE.
       * NO WEIGHT SYSTEM CHANGE.
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
            .replace(
              /[^A-Z0-9]+/gi,
              ""
            )
            .toUpperCase(),

        probability,

        confidence,

        odds: null,

        fairOdds,

        value: null,

        recommendationStrength:
          0,

        bsdRecommendation:
          row?.recommendation ??
          row?.recommended ??
          null,

        score,

        oddsSource:
          "UNAVAILABLE",

        bookmaker:
          null,

        marketMovement:
          null,

        exchangeMovement:
          null,

        status:
          row?.status ??
          "notstarted",
      };
    });
}

/* =========================================================
   ODDS PARSER
   ========================================================= */

function normalizeEventOdds(body) {
  /*
   * BSD can expose the odds block directly,
   * or under body.odds / body.data.odds.
   */
  const source =
    body?.odds ??
    body?.data?.odds ??
    body?.result?.odds ??
    body;

  if (
    !source ||
    typeof source !== "object"
  ) {
    return {};
  }

  const matchWinner =
    source.match_winner ??
    source.matchWinner ??
    {};

  const overUnder =
    source.over_under ??
    source.overUnder ??
    {};

  const btts =
    source.btts ??
    {};

  return {
    "1":
      numberOrNull(
        firstDefined(
          source.home_win,
          source.home,
          matchWinner.home
        )
      ),

    "X":
      numberOrNull(
        firstDefined(
          source.draw,
          matchWinner.draw
        )
      ),

    "2":
      numberOrNull(
        firstDefined(
          source.away_win,
          source.away,
          matchWinner.away
        )
      ),

    OVER15:
      numberOrNull(
        firstDefined(
          source.over_15_goals,
          source.over_15,
          source.over15,
          overUnder.over_15,
          overUnder.over15
        )
      ),

    UNDER15:
      numberOrNull(
        firstDefined(
          source.under_15_goals,
          source.under_15,
          source.under15,
          overUnder.under_15,
          overUnder.under15
        )
      ),

    OVER25:
      numberOrNull(
        firstDefined(
          source.over_25_goals,
          source.over_25,
          source.over25,
          overUnder.over_25,
          overUnder.over25
        )
      ),

    UNDER25:
      numberOrNull(
        firstDefined(
          source.under_25_goals,
          source.under_25,
          source.under25,
          overUnder.under_25,
          overUnder.under25
        )
      ),

    OVER35:
      numberOrNull(
        firstDefined(
          source.over_35_goals,
          source.over_35,
          source.over35,
          overUnder.over_35,
          overUnder.over35
        )
      ),

    UNDER35:
      numberOrNull(
        firstDefined(
          source.under_35_goals,
          source.under_35,
          source.under35,
          overUnder.under_35,
          overUnder.under35
        )
      ),

    BTTSYES:
      numberOrNull(
        firstDefined(
          source.btts_yes,
          btts.yes
        )
      ),

    BTTSNO:
      numberOrNull(
        firstDefined(
          source.btts_no,
          btts.no
        )
      ),
  };
}

/* =========================================================
   EVENT ODDS
   ========================================================= */

async function fetchEventOdds(
  eventId
) {
  const endpoint =
    `${BSD_BASE}/events/${eventId}/odds/`;

  const result =
    await fetchJson(endpoint);

  return {
    endpoint,

    ...result,

    odds:
      result.ok
        ? normalizeEventOdds(
            result.body
          )
        : {},
  };
}

/* =========================================================
   MARKET KEY
   ========================================================= */

function marketKeyFromPick(
  pick
) {
  return pick
    .replace(
      /[^A-Z0-9]+/gi,
      ""
    )
    .toUpperCase();
}

/* =========================================================
   APPLY ODDS
   ========================================================= */

function applyOdds(
  candidate,
  oddsData
) {
  const key =
    marketKeyFromPick(
      candidate.pick
    );

  const odds =
    oddsData[key] ??
    null;

  candidate.odds =
    odds;

  candidate.fairOdds =
    candidate.probability > 0
      ? Math.round(
          (100 /
            candidate.probability) *
          1000
        ) / 1000
      : null;

  candidate.value =
    odds !== null &&
    candidate.probability !== null
      ? Math.round(
          (
            odds *
              (candidate.probability /
                100) -
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
   ========================================================= */

function rankingScore(
  candidate
) {
  let score =
    candidate.score;

  /*
   * Existing score stays primary.
   * Odds/value remain secondary.
   */

  if (
    candidate.value !== null
  ) {
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

app.get(
  "/",
  (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
    });
  }
);

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

      /*
       * STEP 1
       * Ask BSD directly for the date.
       */
      const predictionData =
        await fetchPredictionsForDate(
          date
        );

      const dateRows =
        predictionData.rows;

      /*
       * STEP 2
       * Build all market candidates.
       */
      let candidates =
        dateRows.flatMap(
          buildCandidates
        );

      /*
       * STEP 3
       * Select preliminary events
       * using the existing model score.
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

      /*
       * STEP 4
       * Get odds for each event.
       */
      for (
        const base
        of preliminaryEvents
      ) {
        requests++;

        const oddsResult =
          await fetchEventOdds(
            base.eventId
          );

        if (
          oddsResult.ok
        ) {
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
       * STEP 5
       * Rank after odds are attached.
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
       * STEP 6
       * Final maximum 5.
       *
       * Never force five.
       * No duplicate event.
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
         * No real odds = no final pick.
         */
        if (
          candidate.odds === null
        ) {
          continue;
        }

        /*
         * Maximum three TOTAL
         * selections.
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
          predictionData.total,

        predictionsDownloaded:
          dateRows.length,

        predictionsFound:
          dateRows.length,

        candidatesFound:
          candidates.length,

        qualificationCount:
          topPicks.length,

        maxTopPicks:
          5,

        oddsStatus: {
          endpoint:
            "/api/v2/events/{id}/odds/",

          requests,

          successful,

          failed,

          message:
            successful > 0
              ? "Real BSD event odds were retrieved and included in ranking."
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
