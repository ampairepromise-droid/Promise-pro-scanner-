// ============================================================================
// TRADE MEMORY + OUTCOME TRACKING (spec sections 17-19, 44-46)
// ============================================================================
// Only a genuine ENTER transition ever creates a record here. Outcomes are
// determined purely from real subsequent market prices — never guessed,
// never backfilled from "what should have happened."
// ============================================================================

const store = require('./store');

const COLLECTION = 'trades';
const OPEN_INDEX = 'trades:open';
const RESOLVED_INDEX = 'trades:resolved';
const MAX_OPEN_AGE_MS = 48 * 60 * 60 * 1000; // 48h — beyond this, an unresolved trade is closed EXPIRED/UNRESOLVED, never silently deleted

async function recordEnterTrade(trade) {
  const record = {
    ...trade,
    status: 'OPEN',
    outcome: null,
    outcomeTimestamp: null,
    timeToOutcomeMs: null,
    tp1Hit: false,
    tp2Hit: false,
    mfe: 0,   // max favorable excursion, in R multiples of initial risk
    mae: 0,   // max adverse excursion, in R multiples of initial risk
    maxRAchieved: 0,
    pricePath: [{ t: trade.enteredAt, price: trade.entryPrice }]
  };
  await store.collectionPut(COLLECTION, trade.signalId, record);
  await store.indexAdd(OPEN_INDEX, trade.signalId);
  return record;
}

function riskOf(trade) {
  return Math.abs(trade.entryPrice - trade.stopLoss) || null;
}

// Given a real current price, updates MFE/MAE and returns whether/what the
// trade should close as. Never invents an outcome — SL/TP levels and price
// are the only inputs.
function evaluateOutcome(trade, currentPrice, nowTs) {
  const risk = riskOf(trade);
  if (!risk) return { closed: false };

  const isLong = trade.direction === 'LONG';
  const favorableMove = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
  const rMultiple = favorableMove / risk;

  const updates = {};
  if (rMultiple > trade.mfe) updates.mfe = rMultiple;
  if (-rMultiple > trade.mae) updates.mae = -rMultiple;
  if (rMultiple > trade.maxRAchieved) updates.maxRAchieved = rMultiple;

  const hitSL = isLong ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;
  const hitTP1 = trade.tp1 !== null && (isLong ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1);
  const hitTP2 = trade.tp2 !== null && (isLong ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2);

  if (hitSL) {
    return { closed: true, outcome: trade.tp1Hit ? 'SL_HIT_AFTER_TP1' : 'SL_HIT', updates };
  }
  if (hitTP2) {
    return { closed: true, outcome: 'TP2_HIT', updates };
  }
  if (hitTP1 && !trade.tp1Hit) {
    updates.tp1Hit = true;
    // If there's no TP2 target for this trade, TP1 is the final target.
    if (trade.tp2 === null) return { closed: true, outcome: 'TP1_HIT', updates };
    return { closed: false, updates }; // keep running toward TP2
  }

  const age = nowTs - trade.enteredAt;
  if (age >= MAX_OPEN_AGE_MS) {
    return { closed: true, outcome: 'EXPIRED_UNRESOLVED', updates };
  }
  return { closed: false, updates };
}

// Sweeps every currently-open trade against a fresh real price and closes
// out any that have hit SL/TP/expiry. Returns the list of trades that
// closed this run (for the adaptive engine to learn from).
async function trackOpenTrades(getCurrentPriceFn) {
  const openIds = await store.indexMembers(OPEN_INDEX);
  const justClosed = [];
  const nowTs = Date.now();

  for (const id of openIds) {
    const trade = await store.collectionGet(COLLECTION, id);
    if (!trade) { await store.indexRemove(OPEN_INDEX, id); continue; }

    let currentPrice;
    try {
      currentPrice = await getCurrentPriceFn(trade.symbol);
    } catch {
      continue; // real API failure for this symbol this run — never guess a price, just retry next run
    }

    const result = evaluateOutcome(trade, currentPrice, nowTs);
    const merged = { ...trade, ...(result.updates || {}) };
    merged.pricePath = [...trade.pricePath.slice(-49), { t: nowTs, price: currentPrice }];

    if (result.closed) {
      merged.status = 'CLOSED';
      merged.outcome = result.outcome;
      merged.outcomeTimestamp = nowTs;
      merged.timeToOutcomeMs = nowTs - trade.enteredAt;
      await store.collectionPut(COLLECTION, id, merged);
      await store.indexRemove(OPEN_INDEX, id);
      await store.indexAdd(RESOLVED_INDEX, id);
      justClosed.push(merged);
    } else {
      await store.collectionPut(COLLECTION, id, merged);
    }
  }
  return justClosed;
}

async function getResolvedTrades() {
  const items = await store.collectionList(COLLECTION);
  const resolvedIds = new Set(await store.indexMembers(RESOLVED_INDEX));
  return items.filter(i => resolvedIds.has(i.id)).map(i => i.value);
}

async function getAllTrades() {
  const items = await store.collectionList(COLLECTION);
  return items.map(i => i.value);
}

module.exports = { recordEnterTrade, trackOpenTrades, getResolvedTrades, getAllTrades };
