// ============================================================================
// MARKET REGIME ENGINE v2 (spec sections 25-32, 56-57)
// ============================================================================
// Answers: "is the broader crypto/altcoin market supporting or weakening the
// direction individual coin setups are pointing?" Real data only — BTC/ETH
// structure from the same 4H analyzer used for individual symbols, plus
// altcoin breadth measured directly across the scanned universe.
//
// CRITICAL — no one-candle overreaction (section 30): the DISPLAYED regime
// only changes once the newly-computed raw classification has repeated on
// two consecutive scan runs. A single noisy run never flips the badge; it
// just gets recorded as "transitioning" in the history so a genuine
// multi-run trend still comes through quickly (a 2-minute cron means a
// real transition is confirmed within ~4 minutes, not one stale candle).
// ============================================================================

const { analyze4H } = require('./engine');
const store = require('./store');

const REGIME_KEY = 'regime:current';
const HISTORY_KEY = 'regime:history';
const HISTORY_MAX = 8;

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

// Simple momentum/volatility read on a 4H or 1H series: % change over last
// 6 candles (momentum) and average true range as % of price (volatility).
function momentumAndVol(candles) {
  if (!candles || candles.length < 8) return { momentumPct: 0, atrPct: 0 };
  const recent = candles.slice(-6);
  const momentumPct = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close) * 100;
  const atrWindow = candles.slice(-14);
  const atr = atrWindow.reduce((s, c) => s + (c.high - c.low), 0) / atrWindow.length;
  const atrPct = (atr / candles[candles.length - 1].close) * 100;
  return { momentumPct, atrPct };
}

// universeBias: array of { symbol, bias4H } already computed while scanning
// the watchlist — we reuse that work rather than re-fetching data.
function computeRawSnapshot({ btc4h, btc1h, eth4h, eth1h, universeBias }) {
  const btc = analyze4H(btc4h);
  const eth = analyze4H(eth4h);
  const btcMom = momentumAndVol(btc1h.length ? btc1h : btc4h);
  const ethMom = momentumAndVol(eth1h.length ? eth1h : eth4h);

  const total = universeBias.length;
  const bullishCount = universeBias.filter(u => u.bias4H === 'BULLISH').length;
  const bearishCount = universeBias.filter(u => u.bias4H === 'BEARISH').length;
  const bullishPct = pct(bullishCount, total);
  const bearishPct = pct(bearishCount, total);

  return {
    timestamp: Date.now(),
    btcBias: btc.bias,
    ethBias: eth.bias,
    btcMomentumPct: Number(btcMom.momentumPct.toFixed(2)),
    ethMomentumPct: Number(ethMom.momentumPct.toFixed(2)),
    btcVolatilityPct: Number(btcMom.atrPct.toFixed(2)),
    breadthSampleSize: total,
    bullishPct, bearishPct,
    neutralPct: Math.max(0, 100 - bullishPct - bearishPct)
  };
}

// Raw single-run classification. No persistence/smoothing applied here —
// that happens in updateRegime().
function classifyRaw(snap, prevSnap) {
  const breadthDelta = prevSnap ? snap.bullishPct - prevSnap.bullishPct : 0;
  const bothBullish = snap.btcBias === 'BULLISH' && snap.ethBias !== 'BEARISH';
  const bothBearish = snap.btcBias === 'BEARISH' && snap.ethBias !== 'BULLISH';
  const weakeningMomentum = snap.btcMomentumPct < 0 || snap.ethMomentumPct < 0;

  if (bothBearish && snap.bearishPct >= 55) return 'BEARISH';

  if (bothBullish && snap.bullishPct >= 55) {
    // Bullish structurally, but is it fading?
    if ((breadthDelta <= -10 && weakeningMomentum) || (snap.btcMomentumPct < -1.5 && snap.ethMomentumPct < -1.5)) {
      return 'BULLISH_WEAKENING';
    }
    return 'BULLISH';
  }

  // Structurally mixed/eroding: flip risk if breadth is falling fast toward
  // parity or bearish count is overtaking bullish count.
  if (snap.bullishPct < 55 && (breadthDelta <= -15 || snap.bearishPct > snap.bullishPct)) {
    return 'FLIP_RISK_HIGH';
  }

  if (bothBullish) return 'BULLISH_WEAKENING';
  if (bothBearish) return 'FLIP_RISK_HIGH';
  return snap.bullishPct >= snap.bearishPct ? 'BULLISH_WEAKENING' : 'FLIP_RISK_HIGH';
}

const LABELS = {
  BULLISH: '🟢 ALT MARKET — BULLISH',
  BULLISH_WEAKENING: '🟡 ALT MARKET — BULLISH / WEAKENING',
  FLIP_RISK_HIGH: '🟠 ALT MARKET — FLIP RISK HIGH',
  BEARISH: '🔴 ALT MARKET — BEARISH'
};

// Reads history, computes this run's raw state, only updates the DISPLAYED
// state if it agrees with the immediately preceding run's raw state
// (2-in-a-row confirmation — see header note on one-candle overreaction).
async function updateRegime(snapshot) {
  let history = [];
  let current = null;
  if (store.configured()) {
    history = (await store.getJSON(HISTORY_KEY)) || [];
    current = await store.getJSON(REGIME_KEY);
  }
  const prevSnap = history.length ? history[history.length - 1] : null;
  const rawState = classifyRaw(snapshot, prevSnap);
  const prevRaw = prevSnap ? prevSnap._rawState : null;

  let displayedState = current ? current.state : rawState;
  let confirmed = true;
  if (!current) {
    displayedState = rawState; // first run ever — nothing to compare against
  } else if (rawState === current.state) {
    displayedState = current.state; // no change proposed
  } else if (rawState === prevRaw) {
    // Same new raw reading two runs in a row -> confirmed transition.
    displayedState = rawState;
  } else {
    // Single-run blip — keep prior displayed state, mark as transitioning.
    displayedState = current.state;
    confirmed = false;
  }

  const record = { ...snapshot, _rawState: rawState };
  history.push(record);
  if (history.length > HISTORY_MAX) history.shift();

  const result = {
    state: displayedState,
    label: LABELS[displayedState] || displayedState,
    rawState,
    transitioning: rawState !== displayedState,
    confirmed,
    snapshot,
    updatedAt: Date.now()
  };

  if (store.configured()) {
    await store.setJSON(REGIME_KEY, result);
    await store.setJSON(HISTORY_KEY, history);
  }
  return result;
}

async function getCurrentRegime() {
  if (!store.configured()) return null;
  return store.getJSON(REGIME_KEY);
}

// Ranking influence per spec section 29 — a bounded multiplier applied to
// display ranking only, never to the ENTER/WAIT gate itself.
function rankingMultiplierFor(direction, regimeState) {
  if (!regimeState) return 1;
  if (direction === 'LONG') {
    if (regimeState === 'BULLISH') return 1.0;
    if (regimeState === 'BULLISH_WEAKENING') return 0.9;
    if (regimeState === 'FLIP_RISK_HIGH') return 0.7;
    if (regimeState === 'BEARISH') return 0.55;
  } else { // SHORT
    if (regimeState === 'BEARISH') return 1.0;
    if (regimeState === 'FLIP_RISK_HIGH') return 1.05;
    if (regimeState === 'BULLISH_WEAKENING') return 0.9;
    if (regimeState === 'BULLISH') return 0.7;
  }
  return 1;
}

module.exports = { computeRawSnapshot, updateRegime, getCurrentRegime, rankingMultiplierFor, LABELS };
