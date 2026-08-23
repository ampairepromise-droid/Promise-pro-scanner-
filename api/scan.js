// ============================================================================
// /api/cron/scan — the ONE background worker (spec sections 41-45, 56, 62)
// ============================================================================
// This route is the entire background engine: real Binance data -> market
// regime -> per-symbol 4H/1H/15M evaluation -> ENTER detection/dedup ->
// trade memory + outcome tracking -> adaptive learning -> Android push.
//
// IMPORTANT — HONEST SCOPE NOTE ON SCHEDULING (read DEPLOY_INSTRUCTIONS.md):
// Vercel's own Cron scheduler is capped at ONCE PER DAY on the Hobby plan.
// A scanner needs to run every 1-2 minutes to be useful, so this route is
// built as a normal secret-protected HTTP endpoint that an external free
// scheduler (cron-job.org, GitHub Actions, etc.) calls every 1-2 minutes.
// This is not a workaround hack — it's the documented, supported pattern
// for frequent "cron" on Vercel Hobby. If/when the project moves to Vercel
// Pro, vercel.json's crons entry can be uncommented to run natively instead.
//
// This route requires a bearer secret (CRON_SECRET env var) so the public
// internet cannot trigger scans or drain your Binance/push quota.
// ============================================================================

const { fetchKlines, fetchCurrentPrice, fetchTopVolumeUniverse, fetch24hTicker } = require('../../lib/binance');
const { evaluateSymbol, analyze4H } = require('../../lib/engine');
const { mapWithConcurrency } = require('../../lib/util');
const store = require('../../lib/store');
const push = require('../../lib/push');
const regimeLib = require('../../lib/regime');
const sessionLib = require('../../lib/session');
const tradeMemory = require('../../lib/tradeMemory');
const adaptive = require('../../lib/adaptive');

const WATCHLIST_SIZE = 50;
const MIN_VOLUME_USD = 2000000;
const ZONE_MATCH_TOLERANCE = 0.002;
const CONCURRENCY = 8;

function zonesMatch(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.zoneLow - b.zoneLow) / b.zoneLow < ZONE_MATCH_TOLERANCE &&
         Math.abs(a.zoneHigh - b.zoneHigh) / b.zoneHigh < ZONE_MATCH_TOLERANCE;
}

function fmtPrice(n) {
  if (n === null || n === undefined) return '--';
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2);
}

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured — allow (documented as "set this before going live" in deploy instructions)
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.query.secret;
  return provided === secret;
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!store.configured()) return res.status(500).json({ error: 'Storage not configured (UPSTASH_REDIS_REST_URL / TOKEN missing)' });

  const funnel = {
    scanned: 0, volumeFilterPassed: 0, valid4H: 0, valid1H: 0, valid15M: 0,
    zoneFormed: 0, reachedEnterZone: 0, currentlyEnter: 0, apiErrors: 0
  };

  let universe;
  try {
    universe = await fetchTopVolumeUniverse(WATCHLIST_SIZE, MIN_VOLUME_USD);
    funnel.volumeFilterPassed = universe.length;
  } catch (err) {
    return res.status(200).json({ ok: false, stage: 'universe fetch failed', error: err.message });
  }

  // ---- per-symbol evaluation (concurrency-limited) ----
  const evaluated = await mapWithConcurrency(universe, CONCURRENCY, async (item) => {
    const symbol = item.symbol;
    funnel.scanned++;
    const [c4h, c1h, c15m, currentPrice] = await Promise.all([
      fetchKlines(symbol, '4h', 360),
      fetchKlines(symbol, '1h', 168),
      fetchKlines(symbol, '15m', 96),
      fetchCurrentPrice(symbol)
    ]);
    const result = evaluateSymbol(symbol, c4h, c1h, c15m, currentPrice);
    return { symbol, result, c4h, c1h, c15m, currentPrice };
  });

  const usable = evaluated.filter(e => !e.__error);
  funnel.apiErrors = evaluated.length - usable.length;

  // ---- market regime (BTC + ETH + breadth across this same universe) ----
  const universeBias = usable.map(e => ({
    symbol: e.symbol,
    bias4H: e.c4h && e.c4h.length ? analyze4H(e.c4h).bias : 'NEUTRAL'
  }));
  let regimeResult = null;
  try {
    const btcRow = usable.find(e => e.symbol === 'BTCUSDT');
    const ethRow = usable.find(e => e.symbol === 'ETHUSDT');
    const [btc4h, btc1h] = btcRow ? [btcRow.c4h, btcRow.c1h] : await Promise.all([fetchKlines('BTCUSDT', '4h', 360), fetchKlines('BTCUSDT', '1h', 168)]);
    const [eth4h, eth1h] = ethRow ? [ethRow.c4h, ethRow.c1h] : await Promise.all([fetchKlines('ETHUSDT', '4h', 360), fetchKlines('ETHUSDT', '1h', 168)]);
    const snapshot = regimeLib.computeRawSnapshot({ btc4h, btc1h, eth4h, eth1h, universeBias });
    regimeResult = await regimeLib.updateRegime(snapshot);
  } catch (err) {
    // Never fabricate a regime — if BTC/ETH data fails, leave the last known regime in place.
    regimeResult = await regimeLib.getCurrentRegime();
  }

  const session = sessionLib.getCurrentSession();
  const currentModel = await adaptive.getCurrentModel();

  // ---- ENTER detection, dedup, trade memory, notifications ----
  for (const row of usable) {
    const { symbol, result: fresh } = row;
    for (const direction of ['LONG', 'SHORT']) {
      const key = `signalstate:${symbol}_${direction}`;
      const existing = await store.getJSON(key);
      const matchesDirection = fresh && fresh.direction === direction;

      if (matchesDirection) {
        funnel.valid4H++;
        if (fresh.entryStatus !== 'INVALID') funnel.valid1H++;
        funnel.valid15M++;
        funnel.zoneFormed++;
        if (fresh.entryStatus === 'ENTER' || fresh.entryStatus === 'WAIT') funnel.reachedEnterZone++;
        if (fresh.entryStatus === 'ENTER') funnel.currentlyEnter++;
      }

      if (!matchesDirection) {
        if (existing) await store.del(key);
        continue;
      }

      const freshZone = { zoneLow: fresh.zoneLow, zoneHigh: fresh.zoneHigh };
      const sameSetup = existing && zonesMatch(freshZone, existing.zone);
      let setupId, notifiedEnter;
      if (sameSetup) {
        setupId = existing.setupId;
        notifiedEnter = existing.notifiedEnter;
      } else {
        setupId = `${symbol}-${direction}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
        notifiedEnter = false;
      }

      await store.setJSON(key, { setupId, zone: freshZone, entryStatus: fresh.entryStatus, notifiedEnter, lastSeenAt: Date.now() });

      if (fresh.entryStatus === 'ENTER' && !notifiedEnter) {
        await store.setJSON(key, { setupId, zone: freshZone, entryStatus: fresh.entryStatus, notifiedEnter: true, lastSeenAt: Date.now() });

        // Real 24h ticker for volume/volatility context on the trade record (best-effort).
        let ticker = null;
        try { ticker = await fetch24hTicker(symbol); } catch { /* non-critical, omit if unavailable */ }

        const tradeRecord = {
          signalId: setupId,
          symbol, direction,
          entryPrice: fresh.entryPrice, stopLoss: fresh.stopLoss, tp1: fresh.tp1, tp2: fresh.tp2,
          enteredAt: Date.now(),
          score: fresh.structuralScore,
          rrRatio: fresh.rrRatio,
          zoneQuality: fresh.zoneQuality,
          conditions: {
            bias4H: fresh.direction4H,
            liquidity1H: true,
            structure15M: true,
            fvgOrOB: fresh.zoneQuality
          },
          regimeAtEntry: regimeResult ? { state: regimeResult.state, label: regimeResult.label } : null,
          marketData: {
            atr15mPct: fresh.maxDrift ?? null,
            volume24hUsd: ticker ? ticker.quoteVolume : null,
            priceChange24hPct: ticker ? ticker.priceChangePercent : null
          },
          session: { label: session.label, sessions: session.sessions, overlap: session.overlap, eat: session.eat },
          modelVersionAtEntry: currentModel.version
        };

        await tradeMemory.recordEnterTrade(tradeRecord);

        const pushResult = await push.sendToAll({
          title: '🚨 PROMISE PRO — ENTRY',
          body: `${symbol} ${direction} • Entry $${fmtPrice(fresh.entryPrice)} • Score ${fresh.structuralScore}`,
          signalId: setupId, symbol, direction,
          entry: fresh.entryPrice, stopLoss: fresh.stopLoss, tp1: fresh.tp1, tp2: fresh.tp2,
          score: fresh.structuralScore,
          timeLabel: new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()) + ' EAT',
          url: `/?signal=${encodeURIComponent(setupId)}`
        });
        tradeRecord._pushResult = pushResult;
      }
    }
  }

  // ---- outcome tracking for previously-open ENTER trades ----
  let justClosed = [];
  try {
    justClosed = await tradeMemory.trackOpenTrades(fetchCurrentPrice);
  } catch (err) {
    funnel.apiErrors++;
  }

  // ---- adaptive learning (only meaningful work when new trades resolved) ----
  let adaptiveResult = { activated: false, reason: 'no newly resolved trades this run' };
  let rollbackResult = { rolledBack: false };
  if (justClosed.length > 0) {
    const resolved = await tradeMemory.getResolvedTrades();
    adaptiveResult = await adaptive.maybeUpdateModel(resolved);
    rollbackResult = await adaptive.checkRollback(resolved);
  }

  await store.setJSON('scan:lastDiagnostics', { ...funnel, universeSize: universe.length, timestamp: Date.now() });

  return res.status(200).json({
    ok: true,
    scannedSymbols: universe.length,
    funnel,
    regime: regimeResult ? { state: regimeResult.state, label: regimeResult.label, confirmed: regimeResult.confirmed } : null,
    session: session.label,
    closedTradesThisRun: justClosed.length,
    adaptive: adaptiveResult,
    rollback: rollbackResult
  });
};
