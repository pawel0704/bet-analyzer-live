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

const VERSION = "7.0.6";
const SOURCE = "BSD";

const headers = {
  Authorization: `Token ${BSD_API_KEY}`,
  Accept: "application/json",
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function confidencePercent(v) {
  const n = num(v);

  if (n === null) return null;

  return n <= 1 ? n * 100 : n;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers,
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

async function fetchPredictions(date) {
  const url =
    `${BSD_BASE}/predictions/` +
    `?date_from=${encodeURIComponent(date)}` +
    `&date_to=${encodeURIComponent(date)}` +
    `&limit=200` +
    `&offset=0`;

  const result = await getJson(url);

  if (!result.ok) {
    throw new Error(
      `BSD predictions HTTP ${result.status}`
    );
  }

  const rows = Array.isArray(result.body?.results)
    ? result.body.results
    : Array.isArray(result.body)
      ? result.body
      : [];

  return {
    rows,
    total:
      num(result.body?.count) ??
      rows.length,
  };
}

/* =========================================================
   BSD PREDICTION SCHEMA
   ========================================================= */

function predictionMarkets(row) {
  return (
    row?.markets ??
    row?.prediction?.markets ??
    {}
  );
}

function probability(row, type) {
  const markets =
    predictionMarkets(row);

  switch (type) {
    case "HOME":
      return num(
        markets?.match_result?.prob_home
      );

    case "DRAW":
      return num(
        markets?.match_result?.prob_draw
      );

    case "AWAY":
      return num(
        markets?.match_result?.prob_away
      );

    case "OVER15":
      return num(
        markets?.over_under?.prob_over_15
      );

    case "UNDER15":
      return (
        num(
          markets?.over_under?.prob_under_15
        ) ??
        (
          (() => {
            const over =
              num(
                markets?.over_under
                  ?.prob_over_15
              );

            return over === null
              ? null
              : 100 - over;
          })()
        )
      );

    case "OVER25":
      return num(
        markets?.over_under?.prob_over_25
      );

    case "UNDER25":
      return (
        num(
          markets?.over_under?.prob_under_25
        ) ??
        (
          (() => {
            const over =
              num(
                markets?.over_under
                  ?.prob_over_25
              );

            return over === null
              ? null
              : 100 - over;
          })()
        )
      );

    case "OVER35":
      return num(
        markets?.over_under?.prob_over_35
      );

    case "UNDER35":
      return (
        num(
          markets?.over_under
            ?.prob_under_35
        ) ??
        (
          (() => {
            const over =
              num(
                markets?.over_under
                  ?.prob_over_35
              );

            return over === null
              ? null
              : 100 - over;
          })()
        )
      );

    case "BTTSYES":
      return num(
        markets?.btts?.prob_yes
      );

    case "BTTSNO":
      return (
        num(
          markets?.btts?.prob_no
        ) ??
        (
          (() => {
            const yes =
              num(
                markets?.btts?.prob_yes
              );

            return yes === null
              ? null
              : 100 - yes;
          })()
        )
      );

    default:
      return null;
  }
}

/* =========================================================
   EVENT INFORMATION
   ========================================================= */

function eventInfo(row) {
  const event =
    row?.event ??
    {};

  return {
    eventId:
      event?.id ??
      row?.event_id ??
      row?.eventId ??
      row?.id ??
      null,

    home:
      event?.home_team ??
      row?.home_team ??
      row?.home ??
      "",

    away:
      event?.away_team ??
      row?.away_team ??
      row?.away ??
      "",

    date:
      event?.event_date ??
      event?.date ??
      event?.kickoff_at ??
      row?.event_date ??
      row?.date ??
      null,

    league:
      event?.league?.name ??
      event?.league_name ??
      row?.league?.name ??
      row?.league_name ??
      null,

    status:
      event?.status ??
      row?.status ??
      "notstarted",
  };
}

/* =========================================================
   CANDIDATES
   ========================================================= */

function candidate(
  info,
  market,
  pick,
  probabilityValue,
  confidence
) {
  if (
    probabilityValue === null ||
    probabilityValue === undefined
  ) {
    return null;
  }

  const probabilityRounded =
    Math.round(
      probabilityValue * 10
    ) / 10;

  const fairOdds =
    probabilityRounded > 0
      ? Math.round(
          (100 /
            probabilityRounded) *
          1000
        ) / 1000
      : null;

  /*
   * EXISTING MODEL SCORING.
   * DO NOT CHANGE WEIGHTS.
   */
  const score =
    probabilityRounded +
    (confidence ?? 0) * 0.18;

  return {
    eventId:
      info.eventId,

    event:
      `${info.home} – ${info.away}`,

    home:
      info.home,

    away:
      info.away,

    date:
      info.date,

    league:
      info.league,

    market,

    pick,

    marketKey:
      pick
        .replace(
          /[^A-Z0-9]+/gi,
          ""
        )
        .toUpperCase(),

    probability:
      probabilityRounded,

    confidence,

    odds: null,

    fairOdds,

    value: null,

    recommendationStrength: 0,

    bsdRecommendation:
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
      info.status,
  };
}

function buildCandidates(row) {
  const info =
    eventInfo(row);

  const confidence =
    confidencePercent(
      row?.model?.confidence ??
      row?.confidence ??
      null
    );

  const list = [];

  const home =
    probability(
      row,
      "HOME"
    );

  const draw =
    probability(
      row,
      "DRAW"
    );

  const away =
    probability(
      row,
      "AWAY"
    );

  const over15 =
    probability(
      row,
      "OVER15"
    );

  const under15 =
    probability(
      row,
      "UNDER15"
    );

  const over25 =
    probability(
      row,
      "OVER25"
    );

  const under25 =
    probability(
      row,
      "UNDER25"
    );

  const over35 =
    probability(
      row,
      "OVER35"
    );

  const under35 =
    probability(
      row,
      "UNDER35"
    );

  const bttsYes =
    probability(
      row,
      "BTTSYES"
    );

  const bttsNo =
    probability(
      row,
      "BTTSNO"
    );

  const markets = [
    [
      "DOUBLE_CHANCE",
      "1X",
      home !== null &&
      draw !== null
        ? home + draw
        : null,
    ],

    [
      "DOUBLE_CHANCE",
      "X2",
      away !== null &&
      draw !== null
        ? away + draw
        : null,
    ],

    [
      "1X2",
      "1",
      home,
    ],

    [
      "1X2",
      "X",
      draw,
    ],

    [
      "1X2",
      "2",
      away,
    ],

    [
      "TOTAL",
      "OVER 1.5",
      over15,
    ],

    [
      "TOTAL",
      "UNDER 1.5",
      under15,
    ],

    [
      "TOTAL",
      "OVER 2.5",
      over25,
    ],

    [
      "TOTAL",
      "UNDER 2.5",
      under25,
    ],

    [
      "TOTAL",
      "OVER 3.5",
      over35,
    ],

    [
      "TOTAL",
      "UNDER 3.5",
      under35,
    ],

    [
      "BTTS",
      "BTTS YES",
      bttsYes,
    ],

    [
      "BTTS",
      "BTTS NO",
      bttsNo,
    ],
  ];

  for (
    const [
      market,
      pick,
      p,
    ] of markets
  ) {
    const item =
      candidate(
        info,
        market,
        pick,
        p,
        confidence
      );

    if (item) {
      list.push(item);
    }
  }

  return list;
}

/* =========================================================
   ODDS FEED
   ========================================================= */

function extractOddsRows(body) {
  if (
    Array.isArray(
      body?.results
    )
  ) {
    return body.results;
  }

  if (
    Array.isArray(
      body?.data
    )
  ) {
    return body.data;
  }

  if (
    Array.isArray(body)
  ) {
    return body;
  }

  return [];
}

function oddsMarketKey(
  row
) {
  const market =
    String(
      row?.market ??
      ""
    ).toLowerCase();

  const outcome =
    String(
      row?.outcome ??
      ""
    ).toUpperCase();

  if (
    market === "1x2"
  ) {
    if (outcome === "HOME")
      return "1";

    if (outcome === "DRAW")
      return "X";

    if (outcome === "AWAY")
      return "2";
  }

  if (
    market ===
    "double_chance"
  ) {
    if (outcome === "1X")
      return "1X";

    if (outcome === "X2")
      return "X2";
  }

  if (
    market ===
    "over_under_15"
  ) {
    if (
      outcome.toLowerCase() ===
      "over"
    )
      return "OVER15";

    if (
      outcome.toLowerCase() ===
      "under"
    )
      return "UNDER15";
  }

  if (
    market ===
    "over_under_25"
  ) {
    if (
      outcome.toLowerCase() ===
      "over"
    )
      return "OVER25";

    if (
      outcome.toLowerCase() ===
      "under"
    )
      return "UNDER25";
  }

  if (
    market ===
    "over_under_35"
  ) {
    if (
      outcome.toLowerCase() ===
      "over"
    )
      return "OVER35";

    if (
      outcome.toLowerCase() ===
      "under"
    )
      return "UNDER35";
  }

  if (
    market === "btts"
  ) {
    if (
      outcome.toLowerCase() ===
      "yes"
    )
      return "BTTSYES";

    if (
      outcome.toLowerCase() ===
      "no"
    )
      return "BTTSNO";
  }

  return null;
}

function parseOdds(
  body
) {
  const rows =
    extractOddsRows(
      body
    );

  const markets =
    {};

  for (
    const row
    of rows
  ) {
    const key =
      oddsMarketKey(
        row
      );

    if (!key) {
      continue;
    }

    const decimalOdds =
      num(
        row?.decimal_odds ??
        row?.odds ??
        row?.price
      );

    if (
      decimalOdds === null
    ) {
      continue;
    }

    /*
     * Prefer the current best quote.
     * If BSD returns several bookmakers,
     * is_max_quote identifies the best one.
     */
    const current =
      markets[key];

    if (
      !current ||
      row?.is_max_quote === true ||
      decimalOdds >
        current.odds
    ) {
      markets[key] = {
        odds:
          decimalOdds,

        bookmaker:
          row?.bookmaker_name ??
          row?.bookmaker_slug ??
          row?.bookmaker ??
          "Consensus",

        movement:
          row?.movement ??
          null,

        previousOdds:
          num(
            row?.previous_decimal_odds
          ),

        updatedAt:
          row?.updated_at ??
          null,
      };
    }
  }

  return {
    markets,
    rowsCount:
      rows.length,
  };
}

async function fetchOdds(
  eventId
) {
  const url =
    `${BSD_BASE}/odds/` +
    `?event_id=${encodeURIComponent(
      eventId
    )}` +
    `&limit=200` +
    `&offset=0`;

  const result =
    await getJson(url);

  return {
    ...result,

    endpoint:
      `${BSD_BASE}/odds/`,

    parsed:
      result.ok
        ? parseOdds(
            result.body
          )
        : {
            markets: {},
            rowsCount: 0,
          },
  };
}

/* =========================================================
   APPLY ODDS
   ========================================================= */

function applyOdds(
  item,
  odds
) {
  const key =
    item.marketKey;

  const market =
    odds.markets?.[key];

  if (!market) {
    return item;
  }

  item.odds =
    market.odds;

  item.bookmaker =
    market.bookmaker;

  item.oddsSource =
    "BSD_BEST_AVAILABLE";

  item.marketMovement =
    market.movement;

  item.fairOdds =
    item.probability > 0
      ? Math.round(
          (100 /
            item.probability) *
          1000
        ) / 1000
      : null;

  item.value =
    item.odds !== null &&
    item.fairOdds !== null
      ? Math.round(
          (
            item.odds /
              item.fairOdds -
            1
          ) * 10000
        ) / 10000
      : null;

  return item;
}

/* =========================================================
   RANKING
   ========================================================= */

function rankingScore(
  item
) {
  let score =
    item.score;

  /*
   * Existing ranking philosophy.
   * No new probability weighting.
   */
  if (
    item.value !== null
  ) {
    score +=
      item.value * 20;
  } else {
    score -= 5;
  }

  /*
   * Existing market-movement signal.
   * Only real BSD movement.
   */
  if (
    item.marketMovement ===
    "SHORTENING"
  ) {
    score += 0.5;
  }

  if (
    item.marketMovement ===
    "DRIFTING"
  ) {
    score -= 0.5;
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

    const started =
      Date.now();

    try {
      const predictions =
        await fetchPredictions(
          date
        );

      const rows =
        predictions.rows;

      let candidates =
        rows.flatMap(
          buildCandidates
        );

      /*
       * Select top 30 events using
       * the existing model score.
       */
      const events =
        Array.from(
          new Map(
            candidates
              .sort(
                (a, b) =>
                  b.score -
                  a.score
              )
              .map(
                item => [
                  item.eventId,
                  item,
                ]
              )
          ).values()
        ).slice(0, 30);

      let oddsRequests = 0;
      let oddsSuccessful = 0;
      let oddsFailed = 0;
      let oddsRows = 0;

      for (
        const event
        of events
      ) {
        oddsRequests++;

        const result =
          await fetchOdds(
            event.eventId
          );

        if (
          result.ok
        ) {
          oddsSuccessful++;

          oddsRows +=
            result.parsed.rowsCount;
        } else {
          oddsFailed++;
        }

        const eventCandidates =
          candidates.filter(
            item =>
              item.eventId ===
              event.eventId
          );

        for (
          const item
          of eventCandidates
        ) {
          applyOdds(
            item,
            result.parsed
          );
        }
      }

      /*
       * Final ranking.
       */
      const ranked =
        candidates
          .map(
            item => ({
              ...item,
              rankScore:
                rankingScore(
                  item
                ),
            })
          )
          .sort(
            (a, b) =>
              b.rankScore -
              a.rankScore
          );

      /*
       * Maximum 5.
       * No duplicate event.
       * Maximum 3 TOTAL markets.
       * No artificial filling.
       */
      const topPicks = [];

      const usedEvents =
        new Set();

      let totalCount = 0;

      for (
        const item
        of ranked
      ) {
        if (
          topPicks.length >= 5
        ) {
          break;
        }

        if (
          usedEvents.has(
            item.eventId
          )
        ) {
          continue;
        }

        if (
          item.odds === null
        ) {
          continue;
        }

        if (
          item.market ===
            "TOTAL" &&
          totalCount >= 3
        ) {
          continue;
        }

        usedEvents.add(
          item.eventId
        );

        if (
          item.market ===
          "TOTAL"
        ) {
          totalCount++;
        }

        const {
          rankScore,
          ...output
        } = item;

        output.exchangeMovement =
          null;

        topPicks.push(
          output
        );
      }

      res.json({
        version:
          VERSION,

        source:
          SOURCE,

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
          predictions.total,

        predictionsDownloaded:
          rows.length,

        predictionsFound:
          rows.length,

        candidatesFound:
          candidates.length,

        qualificationCount:
          topPicks.length,

        maxTopPicks:
          5,

        oddsStatus: {
          endpoint:
            "/api/v2/odds/?event_id={id}",

          requests:
            oddsRequests,

          successful:
            oddsSuccessful,

          failed:
            oddsFailed,

          rows:
            oddsRows,

          message:
            oddsSuccessful > 0
              ? "Real BSD bookmaker odds were retrieved and parsed."
              : "No BSD odds were retrieved.",
        },

        topPicks,
      });

    } catch (error) {
      console.error(
        "TOP PICKS ERROR",
        error
      );

      res.status(500).json({
        version:
          VERSION,

        source:
          SOURCE,

        error:
          error?.message ??
          "Unknown error",
      });
    }
  }
);

/* =========================================================
   DEBUG PREDICTION
   ========================================================= */

app.get(
  "/api/debug-prediction",
  async (
    req,
    res
  ) => {
    const date =
      req.query.date ??
      new Date()
        .toISOString()
        .slice(0, 10);

    try {
      const result =
        await fetchPredictions(
          date
        );

      res.json({
        version:
          VERSION,

        date,

        count:
          result.rows.length,

        first:
          result.rows[0] ??
          null,
      });

    } catch (error) {
      res.status(500).json({
        version:
          VERSION,

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
  async (
    req,
    res
  ) => {
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
        await fetchOdds(
          eventId
        );

      res
        .status(
          result.status ||
          500
        )
        .json({
          version:
            VERSION,

          eventId,

          endpoint:
            `${BSD_BASE}/odds/?event_id=${eventId}`,

          httpStatus:
            result.status,

          parsed:
            result.parsed,

          raw:
            result.body,
        });

    } catch (error) {
      res.status(500).json({
        version:
          VERSION,

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
