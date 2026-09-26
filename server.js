import express from “express”;
import cors from “cors”;
import dotenv from “dotenv”;

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE = “https://sports.bzzoiro.com/api/v2”;

const VERSION = “6.6.8”;
const SOURCE = “BSD”;

const MAX_TOP_PICKS = 5;
const MAX_EVENTS_TO_ANALYZE = 100;

const MIN_ODDS = 1.25;
const MAX_ODDS = 5.5;

const MIN_PROBABILITY = 50;

const MIN_VALUE_EDGE = 0.0;

const REQUEST_TIMEOUT = 15000;

if (!BSD_API_KEY) {
console.warn(“WARNING: BSD_API_KEY is not configured.”);
}

/* =========================================================
HELPERS
========================================================= */

function normalizeText(value) {
return String(value ?? “”)
.trim()
.toLowerCase()
.replace(/[\s-]+/g, “_”);
}

function numberOrNull(value) {
if (value === null || value === undefined || value === “”) {
return null;
}

const n = Number(value);

return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 3) {
if (
value === null ||
value === undefined ||
!Number.isFinite(Number(value))
) {
return null;
}

const factor = 10 ** decimals;

return Math.round(Number(value) * factor) / factor;
}

function isoDateOnly(value) {
if (!value) return null;

const d = new Date(value);

if (Number.isNaN(d.getTime())) {
return String(value).slice(0, 10);
}

return d.toISOString().slice(0, 10);
}

function getTeamName(event, side) {
if (!event) return null;

if (side === “home”) {
return (
event.home_team ||
event.homeTeam ||
event.home_name ||
event.home?.name ||
event.teams?.home?.name ||
null
);
}

return (
event.away_team ||
event.awayTeam ||
event.away_name ||
event.away?.name ||
event.teams?.away?.name ||
null
);
}

function isUpcomingEvent(event, requestedDate = null) {
if (!event) return false;

const status = normalizeText(event.status);

const badStatuses = new Set([
“finished”,
“completed”,
“cancelled”,
“canceled”,
“postponed”,
“abandoned”,
“live”,
“in_play”,
“inplay”,
“halftime”,
“ht”
]);

if (badStatuses.has(status)) {
return false;
}

if (requestedDate) {
const eventDate = isoDateOnly(
event.event_date ||
event.date ||
event.start_time ||
event.start_at
);

if (eventDate && eventDate !== requestedDate) {
  return false;
}

}

const eventTime =
event.event_date ||
event.date ||
event.start_time ||
event.start_at;

if (eventTime) {
const timestamp = new Date(eventTime).getTime();

if (Number.isFinite(timestamp)) {
  if (timestamp < Date.now() - 5 * 60 * 1000) {
    return false;
  }
}

}

return true;
}

/* =========================================================
BSD API
========================================================= */

async function bsdFetch(path) {
if (!BSD_API_KEY) {
throw new Error(“BSD_API_KEY is missing”);
}

const url = /^https?:///i.test(path)
? path
: ${BSD_BASE}${path.startsWith("/") ? path : /${path}};

const controller = new AbortController();

const timeout = setTimeout(() => {
controller.abort();
}, REQUEST_TIMEOUT);

try {
const response = await fetch(url, {
method: “GET”,
headers: {
Authorization: Token ${BSD_API_KEY},
Accept: “application/json”
},
signal: controller.signal
});

const text = await response.text();
let data;
try {
  data = text ? JSON.parse(text) : null;
} catch {
  data = text;
}
if (!response.ok) {
  const error = new Error(
    `BSD ${response.status} ${response.statusText}`
  );
  error.status = response.status;
  error.data = data;
  throw error;
}
return {
  status: response.status,
  data
};

} finally {
clearTimeout(timeout);
}
}

/* =========================================================
PAGINATION
========================================================= */

function extractRows(data) {
if (!data) return [];

if (Array.isArray(data)) {
return data;
}

if (Array.isArray(data.results)) {
return data.results;
}

if (Array.isArray(data.data)) {
return data.data;
}

if (Array.isArray(data.items)) {
return data.items;
}

return [];
}

function extractCount(data) {
if (!data || typeof data !== “object”) {
return null;
}

return (
numberOrNull(data.count) ??
numberOrNull(data.total) ??
numberOrNull(data.total_count)
);
}

function extractNext(data) {
if (!data || typeof data !== “object”) {
return null;
}

return data.next || null;
}

async function fetchAllPages(
path,
{
limit = 200,
maxPages = 20,
diagnostics = null
} = {}
) {
const allRows = [];

let offset = 0;

for (let page = 0; page < maxPages; page++) {
const separator = path.includes(”?”) ? “&” : “?”;

const requestPath =
  `${path}${separator}limit=${limit}&offset=${offset}`;
try {
  const response = await bsdFetch(requestPath);
  const data = response.data;
  const rows = extractRows(data);
  const total = extractCount(data);
  const next = extractNext(data);
  if (diagnostics) {
    diagnostics.push({
      path: requestPath,
      status: response.status,
      count: total,
      rows: rows.length,
      hasNext: Boolean(next)
    });
  }
  allRows.push(...rows);
  if (rows.length === 0) {
    break;
  }
  if (
    total !== null &&
    allRows.length >= total
  ) {
    break;
  }
  if (!next && rows.length < limit) {
    break;
  }
  offset += rows.length;
} catch (error) {
  if (diagnostics) {
    diagnostics.push({
      path: requestPath,
      status: error.status || null,
      error: error.message
    });
  }
  break;
}

}

return allRows;
}

/* =========================================================
EVENTS
========================================================= */

async function getEventsForDate(
date,
diagnostics = []
) {
const paths = [
/events/?date=${encodeURIComponent(date)},
/events/?event_date=${encodeURIComponent(date)},
/events/?from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}
];

let bestRows = [];

for (const path of paths) {
const localDiagnostics = [];

const rows = await fetchAllPages(
  path,
  {
    limit: 200,
    maxPages: 10,
    diagnostics: localDiagnostics
  }
);
diagnostics.push(...localDiagnostics);
if (rows.length > bestRows.length) {
  bestRows = rows;
}

}

return bestRows;
}

/* =========================================================
PREDICTIONS
========================================================= */

function parsePredictionRow(row) {
if (!row || typeof row !== “object”) {
return null;
}

const event = row.event || {};

const markets = row.markets || {};

const matchResult =
markets.match_result ||
markets.matchResult ||
row.match_result ||
row.matchResult ||
{};

const overUnder =
markets.over_under ||
markets.overUnder ||
markets.totals ||
row.over_under ||
{};

const btts =
markets.btts ||
markets.BTTS ||
row.btts ||
{};

const score =
markets.score ||
row.score ||
{};

const drawNoBet =
markets.draw_no_bet ||
markets.drawNoBet ||
row.draw_no_bet ||
{};

const home = numberOrNull(
matchResult.prob_home ??
matchResult.home ??
row.prob_home
);

const draw = numberOrNull(
matchResult.prob_draw ??
matchResult.draw ??
row.prob_draw
);

const away = numberOrNull(
matchResult.prob_away ??
matchResult.away ??
row.prob_away
);

const over15 = numberOrNull(
overUnder.prob_over_15 ??
overUnder.over_15 ??
overUnder.over15 ??
row.prob_over_15
);

const over25 = numberOrNull(
overUnder.prob_over_25 ??
overUnder.over_25 ??
overUnder.over25 ??
row.prob_over_25
);

const over35 = numberOrNull(
overUnder.prob_over_35 ??
overUnder.over_35 ??
overUnder.over35 ??
row.prob_over_35
);

const bttsYes = numberOrNull(
btts.prob_yes ??
btts.yes ??
row.prob_btts_yes
);

const dnbHome = numberOrNull(
drawNoBet.prob_home ??
drawNoBet.home ??
row.prob_dnb_home
);

const confidence = numberOrNull(
row.model?.confidence ??
row.confidence
);

return {
eventId:
Number(
event.id ??
row.event_id ??
row.eventId ??
0
) || null,

event,
home,
draw,
away,
over15,
over25,
over35,
bttsYes,
dnbHome,
mostLikelyScore:
  score.most_likely ??
  score.mostLikely ??
  row.most_likely_score ??
  null,
predicted:
  matchResult.predicted ??
  row.predicted ??
  null,
confidence,
raw: row

};
}

async function getAllPredictions(
diagnostics = []
) {
return fetchAllPages(
“/predictions/”,
{
limit: 200,
maxPages: 10,
diagnostics
}
);
}

/* =========================================================
ODDS
========================================================= */

function emptyOdds() {
return {
home: null,
draw: null,
away: null,

doubleChance1X: null,
doubleChanceX2: null,
doubleChance12: null,
over15: null,
over25: null,
over35: null,
under15: null,
under25: null,
under35: null,
bttsYes: null,
bttsNo: null,
rowsCount: 0,
rawCount: 0

};
}

function normalizeMarket(row) {
return normalizeText(
row.market ??
row.market_name ??
row.market_slug ??
row.market_code ??
“”
);
}

function normalizeOutcome(row) {
return normalizeText(
row.outcome ??
row.outcome_name ??
row.selection ??
row.name ??
“”
);
}

function parseLine(row) {
return numberOrNull(
row.line ??
row.total ??
row.handicap ??
row.points ??
row.goal_line ??
row.threshold
);
}

function parseOddsRow(row) {
if (!row || typeof row !== “object”) {
return null;
}

const market = normalizeMarket(row);
const outcome = normalizeOutcome(row);

const odds = numberOrNull(
row.decimal_odds ??
row.odds ??
row.price ??
row.decimalOdds
);

if (
!Number.isFinite(odds) ||
odds <= 1
) {
return null;
}

const previousOdds = numberOrNull(
row.previous_decimal_odds ??
row.previous_odds ??
row.previousDecimalOdds
);

const openingOdds = numberOrNull(
row.opening_decimal_odds ??
row.opening_odds ??
row.openingDecimalOdds
);

const movement =
String(row.movement ?? “”)
.trim()
.toUpperCase() || null;

const bookmakerCount = numberOrNull(
row.bookmaker_count ??
row.bookmakers_count ??
row.bookmakerCount
);

return {
id: row.id ?? null,

eventId:
  Number(
    row.event_id ??
    row.eventId ??
    0
  ) || null,
market,
outcome,
line: parseLine(row),
odds,
previousOdds,
openingOdds,
movement,
bookmaker:
  row.bookmaker_name ??
  row.bookmaker_slug ??
  null,
bookmakerCount,
updatedAt:
  row.updated_at ??
  row.updatedAt ??
  null,
raw: row

};
}

function marketIs(row, values) {
const market = row.market || “”;

return values.some(
(value) =>
market === value ||
market.includes(value) ||
value.includes(market)
);
}

function outcomeIs(row, values) {
const outcome = row.outcome || “”;

return values.some(
(value) =>
outcome === value ||
outcome.includes(value) ||
value.includes(outcome)
);
}

function selectLatestOdds(rows) {
const map = new Map();

for (const row of rows) {
if (!row) continue;

const key = [
  row.market,
  row.outcome,
  row.line ?? ""
].join("|");
const existing = map.get(key);
if (!existing) {
  map.set(key, row);
  continue;
}
const existingTime =
  existing.updatedAt
    ? new Date(existing.updatedAt).getTime()
    : 0;
const currentTime =
  row.updatedAt
    ? new Date(row.updatedAt).getTime()
    : 0;
if (currentTime >= existingTime) {
  map.set(key, row);
}

}

return […map.values()];
}

function parseOddsRows(rawRows) {
const safeRows =
Array.isArray(rawRows)
? rawRows
: [];

const parsedRows =
safeRows
.map(parseOddsRow)
.filter(Boolean);

const rows =
selectLatestOdds(parsedRows);

const result = emptyOdds();

result.rowsCount = rows.length;
result.rawCount = safeRows.length;

for (const row of rows) {
const market = row.market;
const outcome = row.outcome;

/* 1X2 */
if (
  marketIs(row, [
    "1x2",
    "match_result",
    "matchresult",
    "three_way"
  ])
) {
  if (
    outcomeIs(row, [
      "home",
      "1",
      "1_home"
    ])
  ) {
    result.home = row;
  }
  if (
    outcomeIs(row, [
      "draw",
      "x"
    ])
  ) {
    result.draw = row;
  }
  if (
    outcomeIs(row, [
      "away",
      "2",
      "2_away"
    ])
  ) {
    result.away = row;
  }
}
/* Double chance */
if (
  market.includes("double") ||
  market.includes("double_chance") ||
  market === "dc"
) {
  if (
    outcome === "1x" ||
    outcome.includes("1x")
  ) {
    result.doubleChance1X = row;
  }
  if (
    outcome === "x2" ||
    outcome.includes("x2")
  ) {
    result.doubleChanceX2 = row;
  }
  if (
    outcome === "12" ||
    outcome === "1_2" ||
    outcome.includes("12")
  ) {
    result.doubleChance12 = row;
  }
}
/* Over / Under */
const isOU =
  market.includes("over_under") ||
  market.includes("overunder") ||
  market.includes("totals") ||
  market === "ou" ||
  market.includes("goal");
if (isOU) {
  const line = row.line;
  const isOver =
    outcome.includes("over");
  const isUnder =
    outcome.includes("under");
  if (
    line === 1.5 &&
    isOver
  ) {
    result.over15 = row;
  }
  if (
    line === 2.5 &&
    isOver
  ) {
    result.over25 = row;
  }
  if (
    line === 3.5 &&
    isOver
  ) {
    result.over35 = row;
  }
  if (
    line === 1.5 &&
    isUnder
  ) {
    result.under15 = row;
  }
  if (
    line === 2.5 &&
    isUnder
  ) {
    result.under25 = row;
  }
  if (
    line === 3.5 &&
    isUnder
  ) {
    result.under35 = row;
  }
}
/* BTTS */
if (
  market === "btts" ||
  market.includes("btts") ||
  market.includes("both_teams")
) {
  if (
    outcome === "yes" ||
    outcome.includes("yes")
  ) {
    result.bttsYes = row;
  }
  if (
    outcome === "no" ||
    outcome.includes("no")
  ) {
    result.bttsNo = row;
  }
}

}

return result;
}

async function getOdds(
eventId,
diagnostics = []
) {
const path =
/odds/?event_id=${encodeURIComponent(eventId)};

const rows =
await fetchAllPages(
path,
{
limit: 200,
maxPages: 10,
diagnostics
}
);

return {
rawRows: Array.isArray(rows)
? rows
: [],
parsed:
parseOddsRows(rows) ||
emptyOdds()
};
}

/* =========================================================
MOVEMENT
========================================================= */

function movementDirection(row) {
if (!row) return null;

if (row.movement === “SHORTENING”) {
return “SHORTENING”;
}

if (row.movement === “DRIFTING”) {
return “DRIFTING”;
}

const current = row.odds;
const previous = row.previousOdds;

if (
Number.isFinite(current) &&
Number.isFinite(previous) &&
previous > 1
) {
if (current < previous) {
return “SHORTENING”;
}

if (current > previous) {
  return "DRIFTING";
}

}

return null;
}

function movementStrength(row) {
if (!row) return 0;

const direction =
movementDirection(row);

let score = 0;

if (direction === “SHORTENING”) {
score += 5;
}

if (direction === “DRIFTING”) {
score -= 5;
}

if (
Number.isFinite(row.previousOdds) &&
row.previousOdds > 0 &&
Number.isFinite(row.odds)
) {
const change =
(row.odds - row.previousOdds) /
row.previousOdds;

if (change <= -0.05) {
  score += 3;
}
if (change <= -0.10) {
  score += 2;
}
if (change >= 0.05) {
  score -= 3;
}
if (change >= 0.10) {
  score -= 2;
}

}

return score;
}

/* =========================================================
VALUE
========================================================= */

function impliedProbability(odds) {
if (
!Number.isFinite(odds) ||
odds <= 1
) {
return null;
}

return 1 / odds;
}

function valueEdge(
probabilityPercent,
odds
) {
if (
!Number.isFinite(probabilityPercent) ||
!Number.isFinite(odds) ||
odds <= 1
) {
return null;
}

const modelProbability =
probabilityPercent / 100;

const implied =
impliedProbability(odds);

if (!Number.isFinite(implied)) {
return null;
}

return modelProbability - implied;
}

/* =========================================================
CANDIDATE
========================================================= */

function createCandidate({
event,
prediction,
oddsRow,
market,
selection,
probability,
label
}) {
if (!oddsRow) {
return null;
}

if (
!Number.isFinite(probability) ||
probability < MIN_PROBABILITY
) {
return null;
}

if (
!Number.isFinite(oddsRow.odds) ||
oddsRow.odds < MIN_ODDS ||
oddsRow.odds > MAX_ODDS
) {
return null;
}

const edge =
valueEdge(
probability,
oddsRow.odds
);

if (!Number.isFinite(edge)) {
return null;
}

if (edge < MIN_VALUE_EDGE) {
return null;
}

const movementScore =
movementStrength(oddsRow);

const bookmakerCount =
Number(
oddsRow.bookmakerCount || 0
);

const bookmakerBonus =
bookmakerCount >= 15
? 3
: bookmakerCount >= 10
? 2
: bookmakerCount >= 5
? 1
: 0;

const probabilityScore =
probability - MIN_PROBABILITY;

const valueScore =
edge * 200;

const rankingScore =
probabilityScore +
valueScore +
movementScore +
bookmakerBonus;

return {
eventId: Number(event.id),

home:
  getTeamName(event, "home"),
away:
  getTeamName(event, "away"),
eventDate:
  event.event_date ||
  event.date ||
  null,
market,
selection,
label,
probability:
  round(probability, 1),
odds:
  round(oddsRow.odds, 3),
impliedProbability:
  round(
    impliedProbability(
      oddsRow.odds
    ) * 100,
    1
  ),
valueEdge:
  round(
    edge * 100,
    2
  ),
movement:
  movementDirection(
    oddsRow
  ),
movementScore,
bookmakerCount:
  oddsRow.bookmakerCount ?? null,
previousOdds:
  round(
    oddsRow.previousOdds,
    3
  ),
openingOdds:
  round(
    oddsRow.openingOdds,
    3
  ),
rankingScore:
  round(
    rankingScore,
    2
  ),
predictionConfidence:
  prediction?.confidence ??
  null,
scorePrediction:
  prediction?.mostLikelyScore ??
  null

};
}

/* =========================================================
BUILD CANDIDATES
========================================================= */

function buildCandidates(
event,
prediction,
odds
) {
const candidates = [];

/*

* MICROFIX 6.6.8:
* zabezpieczenie przed null/undefined
* zarówno prediction, jak i odds.
    */
    if (!prediction || !odds) {
    return candidates;
    }

/* 1X2 */

const home =
createCandidate({
event,
prediction,
oddsRow: odds.home,
market: “1X2”,
selection: “HOME”,
label: “Gospodarze”,
probability: prediction.home
});

if (home) {
candidates.push(home);
}

const draw =
createCandidate({
event,
prediction,
oddsRow: odds.draw,
market: “1X2”,
selection: “DRAW”,
label: “Remis”,
probability: prediction.draw
});

if (draw) {
candidates.push(draw);
}

const away =
createCandidate({
event,
prediction,
oddsRow: odds.away,
market: “1X2”,
selection: “AWAY”,
label: “Goście”,
probability: prediction.away
});

if (away) {
candidates.push(away);
}

/* DOUBLE CHANCE */

if (
Number.isFinite(prediction.home) &&
Number.isFinite(prediction.draw)
) {
const p1x =
prediction.home +
prediction.draw;

const candidate =
  createCandidate({
    event,
    prediction,
    oddsRow:
      odds.doubleChance1X,
    market: "DOUBLE_CHANCE",
    selection: "1X",
    label:
      "1X — gospodarze lub remis",
    probability: p1x
  });
if (candidate) {
  candidates.push(candidate);
}

}

if (
Number.isFinite(prediction.draw) &&
Number.isFinite(prediction.away)
) {
const px2 =
prediction.draw +
prediction.away;

const candidate =
  createCandidate({
    event,
    prediction,
    oddsRow:
      odds.doubleChanceX2,
    market: "DOUBLE_CHANCE",
    selection: "X2",
    label:
      "X2 — remis lub goście",
    probability: px2
  });
if (candidate) {
  candidates.push(candidate);
}

}

if (
Number.isFinite(prediction.home) &&
Number.isFinite(prediction.away)
) {
const p12 =
prediction.home +
prediction.away;

const candidate =
  createCandidate({
    event,
    prediction,
    oddsRow:
      odds.doubleChance12,
    market: "DOUBLE_CHANCE",
    selection: "12",
    label:
      "12 — bez remisu",
    probability: p12
  });
if (candidate) {
  candidates.push(candidate);
}

}

/* TOTALS */

const over15 =
createCandidate({
event,
prediction,
oddsRow: odds.over15,
market: “TOTALS”,
selection: “OVER_1.5”,
label: “Powyżej 1.5 gola”,
probability: prediction.over15
});

if (over15) {
candidates.push(over15);
}

const over25 =
createCandidate({
event,
prediction,
oddsRow: odds.over25,
market: “TOTALS”,
selection: “OVER_2.5”,
label: “Powyżej 2.5 gola”,
probability: prediction.over25
});

if (over25) {
candidates.push(over25);
}

const over35 =
createCandidate({
event,
prediction,
oddsRow: odds.over35,
market: “TOTALS”,
selection: “OVER_3.5”,
label: “Powyżej 3.5 gola”,
probability: prediction.over35
});

if (over35) {
candidates.push(over35);
}

/* BTTS */

const btts =
createCandidate({
event,
prediction,
oddsRow: odds.bttsYes,
market: “BTTS”,
selection: “YES”,
label:
“Obie drużyny strzelą”,
probability:
prediction.bttsYes
});

if (btts) {
candidates.push(btts);
}

return candidates;
}

/* =========================================================
ANALYZE EVENT
========================================================= */

async function analyzeEvent(
event,
prediction,
diagnostics
) {
const oddsDiagnostics = [];

const oddsResult =
await getOdds(
event.id,
oddsDiagnostics
);

/*

* MICROFIX 6.6.8:
* nawet gdy BSD zwróci null,
* analizator dostaje bezpieczny obiekt odds.
    */
    const parsedOdds =
    oddsResult?.parsed ||
    emptyOdds();

const rawOdds =
Array.isArray(
oddsResult?.rawRows
)
? oddsResult.rawRows
: [];

if (diagnostics) {
diagnostics.push({
eventId: event.id,
odds: oddsDiagnostics
});
}

const candidates =
buildCandidates(
event,
prediction,
parsedOdds
);

return {
eventId:
Number(event.id),

home:
  getTeamName(event, "home"),
away:
  getTeamName(event, "away"),
eventDate:
  event.event_date ||
  event.date ||
  null,
status:
  event.status ||
  null,
predictionAvailable:
  Boolean(prediction),
prediction:
  prediction
    ? {
        home:
          prediction.home,
        draw:
          prediction.draw,
        away:
          prediction.away,
        over15:
          prediction.over15,
        over25:
          prediction.over25,
        over35:
          prediction.over35,
        bttsYes:
          prediction.bttsYes,
        dnbHome:
          prediction.dnbHome,
        score:
          prediction.mostLikelyScore,
        confidence:
          prediction.confidence
      }
    : null,
oddsAvailable:
  rawOdds.length > 0,
odds: {
  home:
    parsedOdds.home
      ? round(
          parsedOdds.home.odds,
          3
        )
      : null,
  draw:
    parsedOdds.draw
      ? round(
          parsedOdds.draw.odds,
          3
        )
      : null,
  away:
    parsedOdds.away
      ? round(
          parsedOdds.away.odds,
          3
        )
      : null,
  over15:
    parsedOdds.over15
      ? round(
          parsedOdds.over15.odds,
          3
        )
      : null,
  over25:
    parsedOdds.over25
      ? round(
          parsedOdds.over25.odds,
          3
        )
      : null,
  over35:
    parsedOdds.over35
      ? round(
          parsedOdds.over35.odds,
          3
        )
      : null,
  bttsYes:
    parsedOdds.bttsYes
      ? round(
          parsedOdds.bttsYes.odds,
          3
        )
      : null,
  rowsCount:
    parsedOdds.rowsCount,
  rawCount:
    parsedOdds.rawCount
},
candidates

};
}

/* =========================================================
MAIN ANALYSIS
========================================================= */

async function runAnalysis(date) {
const started =
Date.now();

const eventDiagnostics = [];
const predictionDiagnostics = [];
const oddsDiagnostics = [];

const rawEvents =
await getEventsForDate(
date,
eventDiagnostics
);

/* UNIQUE EVENTS */

const eventMap =
new Map();

for (const event of rawEvents) {
if (!event || !event.id) {
continue;
}

eventMap.set(
  Number(event.id),
  event
);

}

const allEvents =
[…eventMap.values()];

/* UPCOMING */

const upcomingEvents =
allEvents.filter(
(event) =>
isUpcomingEvent(
event,
date
)
);

/* CHRONOLOGICAL */

upcomingEvents.sort(
(a, b) => {
const da =
new Date(
a.event_date ||
a.date ||
a.start_time ||
0
).getTime();

  const db =
    new Date(
      b.event_date ||
      b.date ||
      b.start_time ||
      0
    ).getTime();
  return da - db;
}

);

const eventsToAnalyze =
upcomingEvents.slice(
0,
MAX_EVENTS_TO_ANALYZE
);

/* PREDICTIONS */

const rawPredictions =
await getAllPredictions(
predictionDiagnostics
);

const predictions =
new Map();

let predictionsParsed = 0;

for (const row of rawPredictions) {
const parsed =
parsePredictionRow(row);

if (
  parsed &&
  parsed.eventId
) {
  predictions.set(
    Number(parsed.eventId),
    parsed
  );
  predictionsParsed++;
}

}

/* EVENTS */

const analyzed = [];

for (
const event of eventsToAnalyze
) {
const prediction =
predictions.get(
Number(event.id)
) || null;

const result =
  await analyzeEvent(
    event,
    prediction,
    oddsDiagnostics
  );
analyzed.push(result);

}

/* ALL CANDIDATES */

const allCandidates =
analyzed.flatMap(
(item) =>
item.candidates || []
);

/*

* Jedna propozycja z jednego meczu.
    */

const bestByEvent =
new Map();

for (
const candidate of allCandidates
) {
const existing =
bestByEvent.get(
candidate.eventId
);

if (
  !existing ||
  candidate.rankingScore >
    existing.rankingScore
) {
  bestByEvent.set(
    candidate.eventId,
    candidate
  );
}

}

/*

* Ranking końcowy.
    */

const qualifiedCandidates =
[…bestByEvent.values()]
.sort(
(a, b) =>
b.rankingScore -
a.rankingScore
);

/*

* MAX 5.
* Nie uzupełniamy sztucznie.
    */

const topPicks =
qualifiedCandidates
.slice(
0,
MAX_TOP_PICKS
)
.map(
(candidate, index) => ({
rank: index + 1,
…candidate
})
);

return {
version: VERSION,
source: SOURCE,

date,
generatedAt:
  new Date().toISOString(),
processingMs:
  Date.now() - started,
exchange: {
  connected: false,
  status: "NOT_CONNECTED",
  message:
    "Betting exchange data is not connected. No exchange movement is fabricated."
},
eventsReturned:
  allEvents.length,
upcomingEvents:
  upcomingEvents.length,
eventsAnalyzed:
  analyzed.length,
eventsExcluded:
  allEvents.length -
  upcomingEvents.length,
predictionsTotal:
  rawPredictions.length,
predictionsParsed,
qualificationCount:
  qualifiedCandidates.length,
maxTopPicks:
  MAX_TOP_PICKS,
thresholds: {
  minProbability:
    MIN_PROBABILITY,
  minOdds:
    MIN_ODDS,
  maxOdds:
    MAX_ODDS,
  minValueEdge:
    `${MIN_VALUE_EDGE * 100}%`,
  maxEventsAnalyzed:
    MAX_EVENTS_TO_ANALYZE
},
predictionDiagnostics,
eventDiagnostics,
topPicks,
analysis: analyzed

};
}

/* =========================================================
ROUTES
========================================================= */

app.get(
“/”,
(req, res) => {
res.json({
status: “ok”,
service:
“Bet Analyzer Live”,
version: VERSION,
source: SOURCE,
message:
“Backend is running.”
});
}
);

app.get(
“/health”,
(req, res) => {
res.json({
status: “ok”,
version: VERSION,
source: SOURCE
});
}
);

/* =========================================================
EVENTS
========================================================= */

app.get(
“/api/events”,
async (req, res) => {
try {
const date =
req.query.date ||
new Date()
.toISOString()
.slice(0, 10);

  const diagnostics = [];
  const rows =
    await getEventsForDate(
      date,
      diagnostics
    );
  const events =
    rows
      .filter(
        (event) =>
          isUpcomingEvent(
            event,
            date
          )
      )
      .map(
        (event) => ({
          id: event.id,
          home:
            getTeamName(
              event,
              "home"
            ),
          away:
            getTeamName(
              event,
              "away"
            ),
          eventDate:
            event.event_date ||
            event.date ||
            null,
          status:
            event.status ||
            null,
          league:
            event.league_name ||
            event.league?.name ||
            null
        })
      );
  res.json({
    version: VERSION,
    source: SOURCE,
    date,
    count:
      events.length,
    events,
    diagnostics
  });
} catch (error) {
  res.status(500).json({
    version: VERSION,
    error:
      error.message
  });
}

}
);

/* =========================================================
ANALYZE
========================================================= */

app.get(
“/api/analyze”,
async (req, res) => {
try {
const date =
req.query.date ||
new Date()
.toISOString()
.slice(0, 10);

  const result =
    await runAnalysis(
      date
    );
  res.json(result);
} catch (error) {
  console.error(error);
  res.status(500).json({
    version: VERSION,
    source: SOURCE,
    error:
      error.message,
    stack:
      process.env.NODE_ENV ===
      "production"
        ? undefined
        : error.stack
  });
}

}
);

/* =========================================================
TOP PICKS
========================================================= */

app.get(
“/api/top-picks”,
async (req, res) => {
try {
const date =
req.query.date ||
new Date()
.toISOString()
.slice(0, 10);

  const result =
    await runAnalysis(
      date
    );
  res.json({
    version:
      result.version,
    source:
      result.source,
    date:
      result.date,
    generatedAt:
      result.generatedAt,
    exchange:
      result.exchange,
    qualificationCount:
      result.qualificationCount,
    maxTopPicks:
      result.maxTopPicks,
    thresholds:
      result.thresholds,
    topPicks:
      result.topPicks
  });
} catch (error) {
  console.error(error);
  res.status(500).json({
    version: VERSION,
    source: SOURCE,
    error:
      error.message
  });
}

}
);

/* =========================================================
DEBUG ODDS
========================================================= */

app.get(
“/api/debug-odds”,
async (req, res) => {
try {
const eventId =
Number(
req.query.eventId
);

  if (!eventId) {
    return res.status(400).json({
      version: VERSION,
      error:
        "eventId is required"
    });
  }
  const diagnostics = [];
  const result =
    await getOdds(
      eventId,
      diagnostics
    );
  const parsed =
    result?.parsed ||
    emptyOdds();
  const rawRows =
    Array.isArray(
      result?.rawRows
    )
      ? result.rawRows
      : [];
  res.json({
    version: VERSION,
    eventId,
    rawCount:
      rawRows.length,
    parsed: {
      home:
        parsed.home
          ? {
              odds:
                parsed
                  .home
                  .odds,
              previousOdds:
                parsed
                  .home
                  .previousOdds,
              openingOdds:
                parsed
                  .home
                  .openingOdds,
              movement:
                parsed
                  .home
                  .movement
            }
          : null,
      draw:
        parsed.draw
          ? {
              odds:
                parsed
                  .draw
                  .odds,
              previousOdds:
                parsed
                  .draw
                  .previousOdds,
              openingOdds:
                parsed
                  .draw
                  .openingOdds,
              movement:
                parsed
                  .draw
                  .movement
            }
          : null,
      away:
        parsed.away
          ? {
              odds:
                parsed
                  .away
                  .odds,
              previousOdds:
                parsed
                  .away
                  .previousOdds,
              openingOdds:
                parsed
                  .away
                  .openingOdds,
              movement:
                parsed
                  .away
                  .movement
            }
          : null,
      over15:
        parsed.over15
          ? {
              odds:
                parsed
                  .over15
                  .odds,
              previousOdds:
                parsed
                  .over15
                  .previousOdds,
              openingOdds:
                parsed
                  .over15
                  .openingOdds,
              movement:
                parsed
                  .over15
                  .movement,
              line:
                parsed
                  .over15
                  .line
            }
          : null,
      over25:
        parsed.over25
          ? {
              odds:
                parsed
                  .over25
                  .odds,
              previousOdds:
                parsed
                  .over25
                  .previousOdds,
              openingOdds:
                parsed
                  .over25
                  .openingOdds,
              movement:
                parsed
                  .over25
                  .movement,
              line:
                parsed
                  .over25
                  .line
            }
          : null,
      over35:
        parsed.over35
          ? {
              odds:
                parsed
                  .over35
                  .odds,
              previousOdds:
                parsed
                  .over35
                  .previousOdds,
              openingOdds:
                parsed
                  .over35
                  .openingOdds,
              movement:
                parsed
                  .over35
                  .movement,
              line:
                parsed
                  .over35
                  .line
            }
          : null,
      bttsYes:
        parsed.bttsYes
          ? {
              odds:
                parsed
                  .bttsYes
                  .odds,
              previousOdds:
                parsed
                  .bttsYes
                  .previousOdds,
              openingOdds:
                parsed
                  .bttsYes
                  .openingOdds,
              movement:
                parsed
                  .bttsYes
                  .movement
            }
          : null
    },
    diagnostics
  });
} catch (error) {
  res.status(500).json({
    version: VERSION,
    error:
      error.message
  });
}

}
);

/* =========================================================
DEBUG PREDICTIONS
========================================================= */

app.get(
“/api/debug-predictions”,
async (req, res) => {
try {
const diagnostics = [];

  const rows =
    await getAllPredictions(
      diagnostics
    );
  const parsed =
    rows
      .map(
        parsePredictionRow
      )
      .filter(Boolean);
  res.json({
    version: VERSION,
    source: SOURCE,
    count:
      rows.length,
    parsedCount:
      parsed.length,
    diagnostics,
    firstRows:
      parsed.slice(
        0,
        10
      )
  });
} catch (error) {
  res.status(500).json({
    version: VERSION,
    error:
      error.message
  });
}

}
);

/* =========================================================
ERROR HANDLER
========================================================= */

app.use(
(
err,
req,
res,
next
) => {
console.error(err);

res.status(500).json({
  version: VERSION,
  error:
    err?.message ||
    "Internal server error"
});

}
);

/* =========================================================
START
========================================================= */

app.listen(
PORT,
() => {
console.log(
Bet Analyzer Live ${VERSION} running on port ${PORT}
);
}
);
