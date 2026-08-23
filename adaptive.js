// ============================================================================
// ADAPTIVE LEARNING ENGINE (spec sections 20-24, 32, 47-48)
// ============================================================================
// This is an ADAPTIVE RANKING LAYER, not a strategy generator. It never
// touches the 4H/1H/15M gating logic, the ENTER definition, or risk
// controls. All it can do, within hard bounds, is nudge a small set of
// RANKING weights (regime weight, score weight, zone-quality weight) used
// to sort/display signals — based on statistically real historical ENTER
// outcomes, recency-weighted, gated by minimum sample size, versioned, and
// auto-rollback if a newly activated version underperforms.
// ============================================================================

const store = require('./store');

const MODEL_KEY = 'adaptive:model:current';
const HISTORY_KEY = 'adaptive:model:history';
const HISTORY_MAX = 20;

const DEFAULT_WEIGHTS = { regimeWeight: 1.0, scoreWeight: 1.0, zoneQualityWeight: 1.0 };
const MAX_WEIGHT_DELTA = 0.05;   // per update — no sudden behavior change
const MIN_WEIGHT = 0.5;
const MAX_WEIGHT = 1.5;
const RECENCY_HALF_LIFE_DAYS = 21;

function learningStage(resolvedCount) {
  if (resolvedCount < 50) return 'COLLECTING_DATA';
  if (resolvedCount < 100) return 'LIMITED_LEARNING';
  return 'LEARNING_ACTIVE';
}

function isWin(outcome) {
  return outcome === 'TP1_HIT' || outcome === 'TP2_HIT' || outcome === 'SL_HIT_AFTER_TP1';
}
function isLoss(outcome) {
  return outcome === 'SL_HIT';
}

function recencyWeight(enteredAt, now) {
  const ageDays = (now - enteredAt) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

function weightedWinRate(trades, now) {
  let wSum = 0, wWin = 0;
  for (const t of trades) {
    if (!isWin(t.outcome) && !isLoss(t.outcome)) continue; // exclude EXPIRED_UNRESOLVED from win-rate math
    const w = recencyWeight(t.enteredAt, now);
    wSum += w;
    if (isWin(t.outcome)) wWin += w;
  }
  return wSum > 0 ? wWin / wSum : null;
}

function groupBy(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

function scoreBucket(score) {
  if (score === null || score === undefined) return null;
  const lo = Math.floor(score / 10) * 10;
  return `${lo}-${lo + 9}`;
}

async function getCurrentModel() {
  const existing = store.configured() ? await store.getJSON(MODEL_KEY) : null;
  if (existing) return existing;
  return { version: '1.0', weights: { ...DEFAULT_WEIGHTS }, createdAt: Date.now(), basedOnSampleSize: 0 };
}

function bumpVersion(v) {
  const [major, minor] = v.split('.').map(Number);
  return `${major}.${minor + 1}`;
}

function clampWeight(w) {
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w));
}

// Builds the human-readable insights panel data (spec section 24) purely
// from real stored resolved trades — no fabricated numbers.
function buildInsights(allTrades, resolvedTrades, currentModel) {
  const now = Date.now();
  const wins = resolvedTrades.filter(t => isWin(t.outcome)).length;
  const losses = resolvedTrades.filter(t => isLoss(t.outcome)).length;
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : null;

  const byRegime = groupBy(resolvedTrades, t => t.regimeAtEntry ? t.regimeAtEntry.state : null);
  let bestRegime = null, weakestRegime = null, bestRegimeRate = -1, weakestRegimeRate = 2;
  for (const [regime, trades] of byRegime.entries()) {
    const rate = weightedWinRate(trades, now);
    if (rate === null) continue;
    if (rate > bestRegimeRate) { bestRegimeRate = rate; bestRegime = regime; }
    if (rate < weakestRegimeRate) { weakestRegimeRate = rate; weakestRegime = regime; }
  }

  const byZone = groupBy(resolvedTrades, t => t.zoneQuality || null);
  let bestZone = null, bestZoneRate = -1;
  for (const [zone, trades] of byZone.entries()) {
    const rate = weightedWinRate(trades, now);
    if (rate !== null && rate > bestZoneRate) { bestZoneRate = rate; bestZone = zone; }
  }

  const byScore = groupBy(resolvedTrades, t => scoreBucket(t.score));
  let bestScoreBucket = null, bestScoreRate = -1;
  for (const [bucket, trades] of byScore.entries()) {
    const rate = weightedWinRate(trades, now);
    if (rate !== null && trades.length >= 5 && rate > bestScoreRate) { bestScoreRate = rate; bestScoreBucket = bucket; }
  }

  return {
    stage: learningStage(resolvedTrades.length),
    enterTradesRecorded: allTrades.length,
    resolved: resolvedTrades.length,
    winning: wins,
    losing: losses,
    winRatePct: winRate !== null ? Number(winRate.toFixed(1)) : null,
    bestPerformingRegime: bestRegime,
    weakestRegime: weakestRegime,
    bestZoneQuality: bestZone,
    bestScoreRange: bestScoreBucket,
    currentModelVersion: currentModel.version,
    modelWeights: currentModel.weights,
    updatedAt: now
  };
}

// Proposes and, if it validates, activates a new bounded weight set. Returns
// { activated: bool, model, reason }. Never called at all unless stage is
// LIMITED_LEARNING or LEARNING_ACTIVE — COLLECTING_DATA never touches weights.
async function maybeUpdateModel(resolvedTrades) {
  const stage = learningStage(resolvedTrades.length);
  const current = await getCurrentModel();
  if (stage === 'COLLECTING_DATA') {
    return { activated: false, model: current, reason: 'COLLECTING_DATA — sample size below 50, no weight changes' };
  }

  const now = Date.now();
  const overallRate = weightedWinRate(resolvedTrades, now);
  if (overallRate === null) return { activated: false, model: current, reason: 'no decided trades yet' };

  const byRegime = groupBy(resolvedTrades, t => t.regimeAtEntry ? t.regimeAtEntry.state : null);
  const regimePerf = {};
  for (const [regime, trades] of byRegime.entries()) {
    const rate = weightedWinRate(trades, now);
    if (rate !== null && trades.length >= 5) regimePerf[regime] = rate - overallRate; // relative edge
  }
  const avgRegimeEdge = Object.values(regimePerf).length
    ? Object.values(regimePerf).reduce((s, v) => s + v, 0) / Object.values(regimePerf).length
    : 0;

  const proposed = {
    regimeWeight: clampWeight(current.weights.regimeWeight + clamp(avgRegimeEdge, -MAX_WEIGHT_DELTA, MAX_WEIGHT_DELTA)),
    scoreWeight: current.weights.scoreWeight,
    zoneQualityWeight: current.weights.zoneQualityWeight
  };

  // Validate: only activate if the change is non-trivial (avoids version churn
  // for noise) and sample size supports it under LIMITED_LEARNING (half weight cap).
  const delta = Math.abs(proposed.regimeWeight - current.weights.regimeWeight);
  const cappedDelta = stage === 'LIMITED_LEARNING' ? MAX_WEIGHT_DELTA / 2 : MAX_WEIGHT_DELTA;
  if (delta < 0.01) {
    return { activated: false, model: current, reason: 'no statistically meaningful change this cycle' };
  }
  const finalRegimeWeight = clampWeight(
    current.weights.regimeWeight + clamp(proposed.regimeWeight - current.weights.regimeWeight, -cappedDelta, cappedDelta)
  );

  const newModel = {
    version: bumpVersion(current.version),
    weights: { ...current.weights, regimeWeight: finalRegimeWeight },
    createdAt: now,
    basedOnSampleSize: resolvedTrades.length,
    performanceAtActivation: overallRate
  };

  if (store.configured()) {
    const history = (await store.getJSON(HISTORY_KEY)) || [];
    history.push(current);
    if (history.length > HISTORY_MAX) history.shift();
    await store.setJSON(HISTORY_KEY, history);
    await store.setJSON(MODEL_KEY, newModel);
  }
  return { activated: true, model: newModel, reason: `regime weight adjusted by ${(finalRegimeWeight - current.weights.regimeWeight).toFixed(3)}` };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Rollback: if trades entered under the CURRENT model version show a
// recency-weighted win rate meaningfully worse than the PREVIOUS model's
// own recorded performance-at-activation, and there's enough of a sample
// to judge, revert to the previous version automatically.
async function checkRollback(allResolvedTrades) {
  if (!store.configured()) return { rolledBack: false };
  const current = await getCurrentModel();
  const history = (await store.getJSON(HISTORY_KEY)) || [];
  if (!history.length) return { rolledBack: false };
  const previous = history[history.length - 1];

  const tradesUnderCurrent = allResolvedTrades.filter(t => t.modelVersionAtEntry === current.version);
  if (tradesUnderCurrent.length < 20) return { rolledBack: false, reason: 'not enough resolved trades under current model yet' };

  const currentRate = weightedWinRate(tradesUnderCurrent, Date.now());
  if (currentRate === null) return { rolledBack: false };

  if (previous.performanceAtActivation !== undefined && currentRate < previous.performanceAtActivation - 0.08) {
    history.pop();
    await store.setJSON(HISTORY_KEY, history);
    await store.setJSON(MODEL_KEY, previous);
    return { rolledBack: true, revertedTo: previous.version, reason: `current model win rate ${(currentRate * 100).toFixed(1)}% underperformed previous model's ${(previous.performanceAtActivation * 100).toFixed(1)}%` };
  }
  return { rolledBack: false };
}

module.exports = { learningStage, getCurrentModel, buildInsights, maybeUpdateModel, checkRollback, isWin, isLoss };
