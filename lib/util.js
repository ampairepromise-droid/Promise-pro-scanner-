// Runs `worker` over `items` with at most `concurrency` in flight at once.
// Keeps Binance calls fast without hammering rate limits or serverless
// execution-time limits (spec section 53 — efficient concurrency/batching).
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: err.message };
      }
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}

module.exports = { mapWithConcurrency };
