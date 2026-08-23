// ============================================================================
// PROMISE PRO SCANNER — shared signal engine (server-side port)
// ============================================================================
// This is a faithful port of the SAME deterministic 4H -> 1H -> 15M pipeline
// used by the live browser scanner (index.html). It exists so the background
// notification system evaluates ENTER/WAIT/MISSED using the identical rules
// as what the user sees on-screen — never a second, independent signal engine.
//
// Real Binance market data only. No simulation, no fabricated signals.
// ============================================================================

function findSwingPoints(candles, left = 2, right = 2) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= candles[i].high) isHigh = false;
      if (candles[i - j].low <= candles[i].low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > candles[i].high) isHigh = false;
      if (candles[i + j].low < candles[i].low) isLow = false;
    }
    if (isHigh) swingHighs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) swingLows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { swingHighs, swingLows };
}

function findFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (c1.high < c3.low && c2.close > c2.open) fvgs.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, index: i - 1 });
    else if (c1.low > c3.high && c2.close < c2.open) fvgs.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, index: i - 1 });
  }
  return fvgs;
}

function findOrderBlocks(candles) {
  const obs = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const prev = candles[i - 1], curr = candles[i];
    if (prev.close < prev.open && curr.close > curr.open && (curr.close - curr.open) > (prev.open - prev.close) * 1.5) obs.push({ type: 'BULLISH', high: prev.high, low: prev.low, index: i - 1 });
    else if (prev.close > prev.open && curr.close < curr.open && (prev.close - prev.open) > (curr.open - curr.close) * 1.5) obs.push({ type: 'BEARISH', high: prev.high, low: prev.low, index: i - 1 });
  }
  return obs;
}

function analyze4H(candles) {
  const { swingHighs, swingLows } = findSwingPoints(candles, 2, 2);
  if (swingHighs.length < 2 || swingLows.length < 2) return { bias: 'NEUTRAL' };
  const lastHigh = swingHighs[swingHighs.length - 1], prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1], prevLow = swingLows[swingLows.length - 2];
  let bias = 'NEUTRAL';
  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) bias = 'BULLISH';
  else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) bias = 'BEARISH';
  return { bias, swingHighs, swingLows };
}

function detectLiquiditySweep(candles, direction, lookback = 10, swingLeft = 2, swingRight = 2) {
  if (candles.length < swingLeft + swingRight + 3) return { swept: false };
  const { swingHighs, swingLows } = findSwingPoints(candles, swingLeft, swingRight);
  const pool = direction === 'BULLISH' ? swingLows.slice(-4) : swingHighs.slice(-4);
  const start = Math.max(0, candles.length - lookback);
  for (const level of pool) {
    for (let i = Math.max(start, level.index + 1); i < candles.length; i++) {
      const c = candles[i];
      if (direction === 'BULLISH' && c.low < level.price && c.close > level.price) {
        return { swept: true, level: level.price, sweepIndex: i, ageCandles: candles.length - 1 - i };
      }
      if (direction === 'BEARISH' && c.high > level.price && c.close < level.price) {
        return { swept: true, level: level.price, sweepIndex: i, ageCandles: candles.length - 1 - i };
      }
    }
  }
  return { swept: false };
}

function isFVGValid(fvg, candles) {
  for (let i = fvg.index + 1; i < candles.length; i++) {
    if (fvg.type === 'BULLISH' && candles[i].close < fvg.bottom * 0.997) return false;
    if (fvg.type === 'BEARISH' && candles[i].close > fvg.top * 1.003) return false;
  }
  return true;
}
function isOBValid(ob, candles) {
  for (let i = ob.index + 1; i < candles.length; i++) {
    if (ob.type === 'BULLISH' && candles[i].close < ob.low * 0.997) return false;
    if (ob.type === 'BEARISH' && candles[i].close > ob.high * 1.003) return false;
  }
  return true;
}

function computeExecutionZone(fvgs, obs, candles, direction, freshnessCandles = 15) {
  const cutoff = candles.length - 1 - freshnessCandles;
  const freshFvgs = fvgs.filter(f => f.type === direction && f.index >= cutoff && isFVGValid(f, candles));
  const freshObs = obs.filter(o => o.type === direction && o.index >= cutoff && isOBValid(o, candles));
  if (!freshFvgs.length && !freshObs.length) return null;
  const fvg = freshFvgs[freshFvgs.length - 1] || null;
  const ob = freshObs[freshObs.length - 1] || null;
  let zoneHigh, zoneLow, quality;
  if (fvg && ob) {
    const overlapHigh = Math.min(fvg.top, ob.high);
    const overlapLow = Math.max(fvg.bottom, ob.low);
    if (overlapHigh > overlapLow) { zoneHigh = overlapHigh; zoneLow = overlapLow; quality = 'CONFLUENCE'; }
    else { zoneHigh = fvg.top; zoneLow = fvg.bottom; quality = 'FVG_ONLY'; }
  } else if (fvg) { zoneHigh = fvg.top; zoneLow = fvg.bottom; quality = 'FVG_ONLY'; }
  else { zoneHigh = ob.high; zoneLow = ob.low; quality = 'OB_ONLY'; }
  return { zoneHigh, zoneLow, quality, idealEntry: (zoneHigh + zoneLow) / 2 };
}

function analyze1H(candles, bias4H) {
  if (bias4H === 'NEUTRAL' || candles.length < 20) return { confirmed: false };
  const sweep = detectLiquiditySweep(candles, bias4H, 24, 2, 2);
  if (!sweep.swept || sweep.ageCandles > 12) return { confirmed: false };
  return { confirmed: true };
}

function analyze15M(candles, bias4H) {
  if (candles.length < 20) return null;
  const { swingHighs, swingLows } = findSwingPoints(candles, 2, 2);
  const fvgs = findFVGs(candles);
  const obs = findOrderBlocks(candles);
  const currentCandle = candles[candles.length - 1];

  const sweep = detectLiquiditySweep(candles, bias4H, 12, 2, 2);
  const sweepDetected = sweep.swept && sweep.ageCandles <= 8;
  const sweepLevel = sweepDetected ? sweep.level : 0;

  let chochDetected = false;
  if (sweepDetected) {
    if (bias4H === 'BULLISH' && swingHighs.length > 0) {
      const recentHigh = swingHighs[swingHighs.length - 1].price;
      if (currentCandle.close > recentHigh || candles[candles.length - 2].close > recentHigh) chochDetected = true;
    } else if (bias4H === 'BEARISH' && swingLows.length > 0) {
      const recentLow = swingLows[swingLows.length - 1].price;
      if (currentCandle.close < recentLow || candles[candles.length - 2].close < recentLow) chochDetected = true;
    }
  }

  let displacementDetected = false;
  if (chochDetected) {
    const window = candles.slice(-10);
    const bodies = window.map(c => Math.abs(c.close - c.open));
    const avgBody = bodies.reduce((s, v) => s + v, 0) / bodies.length || 0.0001;
    displacementDetected = candles.slice(sweep.sweepIndex).some(c => {
      const body = Math.abs(c.close - c.open);
      const isDir = bias4H === 'BULLISH' ? c.close > c.open : c.close < c.open;
      return isDir && body >= avgBody * 1.4;
    });
  }

  const zone = (chochDetected && displacementDetected) ? computeExecutionZone(fvgs, obs, candles, bias4H, 15) : null;

  return { sweepDetected, sweepLevel, chochDetected, displacementDetected, zone, swingHighs, swingLows };
}

function determineEntryStatus(zone, currentPrice, distancePct, maxDrift) {
  if (!zone) return 'INVALID';
  const inZone = currentPrice >= zone.zoneLow && currentPrice <= zone.zoneHigh;
  if (inZone) return 'ENTER';
  if (distancePct <= maxDrift) return 'WAIT';
  return 'MISSED';
}

// Evaluates one symbol end-to-end given already-fetched candle arrays.
// Mirrors index.html's evaluateSymbol() gating logic (minus trend-line score
// bonuses, which only affect the display score, never the ENTER/WAIT gate).
function evaluateSymbol(symbol, c4h, c1h, c15m, currentPrice) {
  if (!c4h.length || !c1h.length || !c15m.length) return null;

  const res4H = analyze4H(c4h);
  if (res4H.bias === 'NEUTRAL') return null;
  const direction = res4H.bias;

  const res1H = analyze1H(c1h, direction);
  if (!res1H.confirmed) return null;

  const res15M = analyze15M(c15m, direction);
  if (!res15M || !res15M.sweepDetected || !res15M.chochDetected || !res15M.displacementDetected) return null;
  const zone = res15M.zone;
  if (!zone) return null;

  let trSum = 0;
  const atrLen = Math.min(14, c15m.length);
  for (let i = c15m.length - atrLen; i < c15m.length; i++) trSum += (c15m[i].high - c15m[i].low);
  const atr15m = trSum / atrLen;
  const atr15mPct = (atr15m / currentPrice) * 100;

  const idealEntry = zone.idealEntry;
  let stopLoss, tp1 = null, tp2 = null, targets;

  if (direction === 'BULLISH') {
    const invalidationPoint = Math.min(res15M.sweepLevel, zone.zoneLow);
    stopLoss = invalidationPoint - (atr15m * 0.35);
    const risk = idealEntry - stopLoss;
    if (risk <= 0) return null;
    targets = [...res4H.swingHighs.map(s => s.price), ...res15M.swingHighs.map(s => s.price)]
      .filter(p => p > idealEntry * 1.001).sort((a, b) => a - b)
      .filter((p, i, arr) => i === 0 || (p - arr[i - 1]) / arr[i - 1] > 0.002);
    if (targets.length >= 2) { tp1 = targets[0]; tp2 = targets[1]; }
  } else {
    const invalidationPoint = Math.max(res15M.sweepLevel, zone.zoneHigh);
    stopLoss = invalidationPoint + (atr15m * 0.35);
    const risk = stopLoss - idealEntry;
    if (risk <= 0) return null;
    targets = [...res4H.swingLows.map(s => s.price), ...res15M.swingLows.map(s => s.price)]
      .filter(p => p < idealEntry * 0.999).sort((a, b) => b - a)
      .filter((p, i, arr) => i === 0 || (arr[i - 1] - p) / p > 0.002);
    if (targets.length >= 2) { tp1 = targets[0]; tp2 = targets[1]; }
  }

  const rrRatio = tp2 !== null ? Math.abs(tp2 - idealEntry) / Math.abs(idealEntry - stopLoss) : null;

  const zoneSizePct = ((zone.zoneHigh - zone.zoneLow) / idealEntry) * 100;
  const maxDrift = Math.max(zoneSizePct, atr15mPct * 1.2, 0.3);
  const distPct = Math.abs((currentPrice - idealEntry) / idealEntry) * 100;
  const entryStatus = determineEntryStatus(zone, currentPrice, distPct, maxDrift);

  // Structural score — same formula/weights as the frontend's structuralScore (25+20+15+15+10+20 = 105 max).
  const scoreZone = zone.quality === 'CONFLUENCE' ? 20 : 10;
  const structuralRaw = 25 + 20 + 15 + 15 + 10 + scoreZone;
  const structuralScore = Math.round((structuralRaw / 105) * 100);

  return {
    symbol,
    direction: direction === 'BULLISH' ? 'LONG' : 'SHORT',
    direction4H: direction,
    entryStatus,
    entryPrice: idealEntry,
    stopLoss, tp1, tp2, rrRatio,
    zoneLow: zone.zoneLow, zoneHigh: zone.zoneHigh, zoneQuality: zone.quality,
    sweepLevel: res15M.sweepLevel,
    currentPrice, distPct, maxDrift,
    structuralScore
  };
}

module.exports = { evaluateSymbol, analyze4H, analyze1H, analyze15M };
