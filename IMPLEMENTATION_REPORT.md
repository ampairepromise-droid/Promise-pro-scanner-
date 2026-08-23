# PROMISE PRO SCANNER v11 — Implementation Report

Answers spec section 68 point by point. Anything not actually verifiable
(no live deployment exists yet at report time) is marked as such rather
than claimed as tested.

## 1. Files changed
- `index.html` — endpoint paths repointed from `/.netlify/functions/*` to
  `/api/*`; added the "Background Engine" panel (broader regime, session,
  adaptive insights, why-no-trade funnel) and its polling JS.
- `sw.js` — unchanged (already platform-agnostic).

## 2. Files added
- `api/subscribe.js`, `api/unsubscribe.js`, `api/test-notification.js`,
  `api/get-signal.js`, `api/insights.js` — Vercel API routes (replace the
  old Netlify Functions).
- `api/cron/scan.js` — the single background worker (replaces
  `scan-and-notify.js`).
- `lib/store.js` — Upstash Redis REST persistence wrapper (replaces
  `@netlify/blobs`).
- `lib/binance.js`, `lib/engine.js` — ported unchanged from the previous
  build (same 4H→1H→15M logic, same ATR/FVG/OB/swing detection).
- `lib/regime.js` — new market regime engine v2 (BTC+ETH+altcoin breadth).
- `lib/session.js` — new trading-session calculator (display only).
- `lib/tradeMemory.js` — new ENTER-trade recording + real-outcome tracking.
- `lib/adaptive.js` — new adaptive ranking-weight learning engine.
- `lib/push.js` — Web Push send/cleanup helper.
- `lib/util.js` — small concurrency-limited batch runner.
- `vercel.json`, `package.json`, `DEPLOY_INSTRUCTIONS.md`, this report.

## 3. Backend architecture
Vercel serverless Node.js functions under `/api`. One route
(`/api/cron/scan`) does all real work: fetch market data → evaluate
signals → update regime → detect ENTER → record trade → track outcomes →
run adaptive learning → send push. All other routes are thin (subscribe,
unsubscribe, test notification, signal lookup, insights read).

## 4. Database/storage used
Upstash Redis via its REST API (no persistent TCP connection needed, works
from any serverless runtime). Chosen because it survives cold starts,
redeploys, and restarts, and needs no Vercel-specific SDK — `lib/store.js`
is the only file that talks to it, so swapping providers later only means
editing one file.

## 5. Android Web Push implementation
Web Push standard: Service Worker (`sw.js`) + Push API + Notifications API
+ VAPID, via the `web-push` npm package server-side. No Telegram, email,
SMS, or native app. Same VAPID keypair reused from the prior build (keys
aren't host-specific).

## 6. Service Worker implementation
Unchanged from the previous version: listens for `push` events, shows a
notification built from the payload, and on `notificationclick` focuses an
existing tab or opens `/?signal=<id>`.

## 7. How ENTER detection works
`evaluateSymbol()` in `lib/engine.js` runs the unchanged 4H bias → 1H
liquidity-sweep confirmation → 15M sweep/CHoCH/displacement/FVG+OB zone
pipeline. `entryStatus` is `ENTER` only when current price is inside the
computed 15M entry zone and every upstream condition still holds. 5M is not
part of this pipeline at all (matches spec sections 1-2).

## 8. How duplicate prevention works
Per `symbol_direction`, a state record (`signalstate:<symbol>_<direction>`
in Redis) tracks a `setupId` and a `notifiedEnter` boolean. A push only
fires the run `entryStatus` transitions to `ENTER` while `notifiedEnter` is
still false; it's flipped to true immediately. A new zone that doesn't
match the stored one (>0.2% difference) is treated as a genuinely new
setup with a fresh id and `notifiedEnter: false`.

## 9. How signal IDs work
`{SYMBOL}-{DIRECTION}-{yyyyMMddHHmm}`, e.g. `BTCUSDT-LONG-202608231432`,
minted once per genuinely new setup and reused across scans as long as the
zone matches (see #8).

## 10. How ENTER trades are stored
`lib/tradeMemory.recordEnterTrade()` writes a full record (see spec
section 18 fields — symbol, direction, entry/SL/TP1/TP2, timestamp, score,
condition flags, regime-at-entry, session, 24h volume/volatility,
model-version-at-entry) into the `trades` Redis collection, indexed for
both full listing and an "open trades" subset.

## 11. How trade outcomes are tracked
Every scan run, `trackOpenTrades()` re-fetches the real current price for
every open trade and checks it against stored SL/TP1/TP2. Outcomes:
`TP1_HIT`, `TP2_HIT`, `SL_HIT`, `SL_HIT_AFTER_TP1`, `EXPIRED_UNRESOLVED`
(48h cap). MFE/MAE and max-R-achieved are updated every run from the real
price, never estimated.

## 12. How adaptive learning works
A recency-weighted (21-day half-life) statistical comparison of resolved
ENTER trades grouped by market regime, zone quality, and score bucket. It
can only nudge a small set of ranking weights (currently: regime weight)
by at most ±0.05 per update, clamped to [0.5, 1.5]. It never touches the
4H/1H/15M gate, the ENTER definition, or risk controls — see `lib/adaptive.js`
header comment.

## 13. Minimum sample size
`<50` resolved trades → `COLLECTING_DATA` (no weight changes at all).
`50–100` → `LIMITED_LEARNING` (half the normal max weight delta).
`100+` → `LEARNING_ACTIVE` (full bounded delta).

## 14. Adaptive safety limits
Max weight change per update: ±0.05. Weight bounds: [0.5, 1.5]. Updates
skipped entirely if the proposed change is below a noise threshold (0.01).
Versioned — every activation snapshots the prior model into history first.

## 15. Rollback mechanism
`checkRollback()` compares the recency-weighted win rate of trades entered
under the *current* model version (once ≥20 have resolved) against the
*previous* model's win rate at the time it was activated. If the current
model is underperforming by more than 8 percentage points, the previous
model is restored automatically.

## 16. Market-regime logic
`lib/regime.js`: BTC and ETH 4H structural bias (same swing-based analyzer
as individual symbols) + momentum/ATR context, plus altcoin breadth (%
bullish vs bearish 4H bias across the scanned watchlist). Classified into
BULLISH / BULLISH_WEAKENING / FLIP_RISK_HIGH / BEARISH.

## 17. Altcoin flip-warning logic
A raw classification is computed every run, but the **displayed** regime
only changes once the same raw classification appears on two consecutive
runs (see spec section 30 — no one-candle overreaction). A single-run
disagreement is recorded as "transitioning" in the UI but doesn't flip the
badge or the ranking multiplier yet.

## 18. Market coverage
Top ~50 USDT perpetuals by 24h quote volume (≥$2M), recomputed every scan
— not the full market. Documented honestly in `DEPLOY_INSTRUCTIONS.md` and
in-app copy. The in-browser live scanner (unchanged from before) still
covers the full eligible market when the page is open.

## 19. Background scanning mechanism
`/api/cron/scan` is a normal secret-protected HTTP endpoint, not Vercel's
built-in Cron (which is capped at once/day on the Hobby plan — a platform
limit, not a code limitation). An external free scheduler (cron-job.org or
equivalent) calls it every 1-2 minutes. Documented as a deliberate,
supported pattern in `DEPLOY_INSTRUCTIONS.md`, not glossed over.

## 20. Trading-session calculation
`lib/session.js`: pure function of UTC hour → Asia / London / New York /
overlap windows, displayed alongside an EAT clock (UTC+3, no DST). Never
referenced anywhere in the signal engine or ENTER/WAIT gate.

## 21. EAT timezone handling
`Intl.DateTimeFormat` with `timeZone: 'Africa/Nairobi'` for both the
session panel and push-notification timestamps.

## 22. Security/environment variables
VAPID private key, Upstash REST token, and the cron secret are all read
from `process.env` server-side only — never embedded in `index.html` or
any file served to the browser. Only the VAPID **public** key is embedded
client-side (that's the one designed to be public). `/api/cron/scan`
requires a bearer/query secret matching `CRON_SECRET`.

## 23. Tests performed
None yet — this is freshly written code delivered as a zip, not a live
deployment. I have not run it against live Binance data or a real Upstash
instance. Per spec section 68's own instruction ("do not say a feature is
working unless it has actually been tested"), treat every claim above as
"implemented as designed," not "verified in production." Once deployed,
walk through spec section 65's 42-point test list against the live URL —
I'm glad to help interpret results or fix anything that doesn't behave as
described here.

## 24. Known limitations
- Background coverage is ~50 symbols, not the full market (see #18).
- Background scan cadence depends on an external scheduler actually
  running reliably — if cron-job.org (or whatever you choose) has an
  outage, background alerts pause until it recovers; the in-browser
  scanner is unaffected.
- Adaptive learning is a bounded statistical reweighting, not a machine-
  learning model — this matches what the spec actually asks for ("adaptive
  ranking layer," not a strategy generator), but is worth stating plainly
  so expectations are accurate.
- The regime engine's breadth/momentum thresholds (55%, ±1.5% momentum,
  etc.) are reasonable starting points, not values tuned against historical
  data — they're straightforward to adjust once you've watched it run for
  a while.
- No automated test suite exists; verification is manual against the live
  URL per spec section 65.
