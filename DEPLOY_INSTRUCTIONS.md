# PROMISE PRO SCANNER — Vercel Deployment (step by step)

This version runs on **Vercel**, not Netlify. Read this whole file once before
starting — there are two honesty notes (background scan frequency, and
market coverage) that affect how you'll use the app day to day.

---

## What you need before you start

1. A GitHub account (free) — Vercel deploys from a Git repo.
2. A Vercel account (free) — sign up at vercel.com with your GitHub account.
3. An Upstash account (free) — this is where trade history, push
   subscriptions, and the market regime/adaptive-learning data live
   persistently. Sign up at upstash.com.
4. A free external scheduler account — cron-job.org is the simplest.
   (Why you need this: see "Honesty note #1" below.)

---

## Step 1 — Put the code on GitHub

1. Go to github.com → New repository → name it e.g. `promise-pro-scanner` →
   Create.
2. On the new repo's page, click "uploading an existing file".
3. Drag in **every file and folder** from this zip (keep the folder
   structure: `api/`, `api/cron/`, `lib/` must stay as folders, not be
   flattened).
4. Commit the files.

## Step 2 — Create the Upstash Redis database

1. In Upstash, click Create Database → Redis. Any free-tier region is fine.
2. Once created, open the database → REST API tab.
3. Copy the two values shown: `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Keep this tab open — you'll paste these into
   Vercel next.

## Step 3 — Import the project into Vercel

1. In Vercel: Add New → Project → Import your `promise-pro-scanner` GitHub
   repo.
2. Before clicking Deploy, open "Environment Variables" and add:

   | Name | Value |
   |---|---|
   | `UPSTASH_REDIS_REST_URL` | (from Step 2) |
   | `UPSTASH_REDIS_REST_TOKEN` | (from Step 2) |
   | `VAPID_PUBLIC_KEY` | `BDfUS4BCIqBOyG-yh2FGL9uEn62nXwBp5q1WCGAaE4v10m5jCsHW6rdyDsR3u31iAUormx3-y8Sw8Vjz7DNeCDM` |
   | `VAPID_PRIVATE_KEY` | `wMlFmwoZ-oIAHzlENUeGE4ISQmgg1QANCC6p1Ze2cPc` |
   | `VAPID_SUBJECT` | `mailto:you@example.com` (any email, doesn't need to be real/monitored) |
   | `CRON_SECRET` | pick any long random string yourself, e.g. `pps-9f3a7c2e1d4b6a8f` |

   (These are the same VAPID keys from the previous Netlify build, reused
   here — they still work, they aren't tied to any one host. If you'd
   rather generate a fresh pair, ask and I'll give you a new one.)

3. Click Deploy. Wait for it to finish, then open the assigned
   `https://your-project.vercel.app` URL to confirm the scanner loads.

## Step 4 — Wire up the background scanner (cron-job.org)

**Honesty note #1 — read this before setting a schedule:**
Vercel's own built-in Cron scheduler only fires **once per day** on the free
Hobby plan — that's a Vercel platform limit, not something this code can
work around. A trading scanner needs to check the market every 1-2 minutes,
so instead this app exposes its scan step as a normal secured web address
(`/api/cron/scan`) and relies on a free *external* scheduler to call that
address every 1-2 minutes. This is the standard, documented way to get
frequent "cron" on Vercel's free tier — it is not a hack, and it costs
nothing. If you later upgrade to Vercel Pro, native per-minute cron becomes
available and you can switch to that instead (ask and I'll set it up).

1. Go to cron-job.org → sign up (free) → Create cronjob.
2. URL: `https://your-project.vercel.app/api/cron/scan?secret=YOUR_CRON_SECRET`
   (use the exact `CRON_SECRET` value you set in Step 3).
3. Schedule: every 2 minutes.
4. Save and enable it. After ~2 minutes, check cron-job.org's execution log
   — you should see `200 OK` responses. If you see `401`, your secret
   doesn't match what's in Vercel's environment variables.

## Step 5 — Enable Android push notifications

1. Open the scanner site on your Android phone in Chrome.
2. Tap "🔔 ENABLE ENTRY ALERTS", allow the notification permission prompt.
3. Tap "🧪 Test Notification" to confirm a real push arrives.
4. Leave the tab, lock your phone — real ENTER alerts will now arrive via
   the background scanner from Step 4, independent of the browser tab.

---

## Honesty note #2 — market coverage

The background scanner (the thing sending you push notifications while the
app is closed) covers the **top ~50 USDT perpetual pairs by 24h volume**,
recomputed fresh on every run — not the entire Binance futures market. This
is a real execution-time constraint (each scan has to fetch and analyze
4H+1H+15M candles for every symbol inside Vercel's function time limit).
The **in-browser live scanner still covers the full eligible market** any
time the page is open. If you want more background coverage, the concurrency
and watchlist size are both adjustable in `api/cron/scan.js` — ask and I can
tune them.

---

## What changed from the previous (Netlify) version

- All `netlify/functions/*.js` became `api/*.js` (Vercel's routing
  convention — any file directly under `/api` is an endpoint automatically).
- Netlify Blobs → Upstash Redis (REST API, works the same way: persists
  across cold starts/redeploys, no code changes needed if you ever migrate
  again since it's accessed only through `lib/store.js`).
- The scheduled Netlify Function (`@netlify/functions` `schedule()`) became
  a plain secured HTTP endpoint (`/api/cron/scan`), because Vercel Hobby
  cron can't run every 2 minutes — see Honesty note #1 above.
- Everything else (the actual 4H → 1H → 15M trading logic, ENTER/WAIT
  states, notification content, no-fake-data rules) is unchanged.
