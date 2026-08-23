// ============================================================================
// PERSISTENT STORE — Upstash Redis REST wrapper
// ============================================================================
// Vercel serverless functions are stateless and have no local disk that
// survives between invocations, so all critical state (push subscriptions,
// ENTER trade history, outcomes, dedup/signal state, adaptive model config)
// must live in an external persistent store that survives cold starts,
// redeploys, and restarts — per spec section 39.
//
// We use Upstash Redis (REST API, no TCP connection needed — works from any
// serverless runtime including Vercel Edge/Node functions) rather than
// Vercel-specific KV, so this same code works whether the project is
// connected to Upstash directly or via the "Vercel Marketplace: Upstash"
// integration (which just injects the same two env vars).
//
// Required environment variables (see DEPLOY_INSTRUCTIONS.md):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// No data is ever fabricated here — this module only stores/retrieves
// real values the rest of the app gives it.
// ============================================================================

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function configured() {
  return Boolean(BASE && TOKEN);
}

async function cmd(parts) {
  if (!configured()) {
    throw new Error('Storage not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Redis command failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

// ---- basic key/value (JSON-serialized) ----
async function getJSON(key) {
  const raw = await cmd(['GET', key]);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setJSON(key, value) {
  return cmd(['SET', key, JSON.stringify(value)]);
}

async function del(key) {
  return cmd(['DEL', key]);
}

// ---- indexed collections ----
// Redis has no cheap "list all keys matching prefix" at scale, so every
// collection maintains its own Redis SET of member ids alongside the
// per-item hash keys. This keeps listing O(collection size), not O(all
// keys in the database).
async function indexAdd(indexKey, member) {
  return cmd(['SADD', indexKey, member]);
}
async function indexRemove(indexKey, member) {
  return cmd(['SREM', indexKey, member]);
}
async function indexMembers(indexKey) {
  const result = await cmd(['SMEMBERS', indexKey]);
  return Array.isArray(result) ? result : [];
}

// Store an item in a named collection: writes the item under `${collection}:${id}`
// and adds `id` to the `${collection}:index` set in one round trip pair.
async function collectionPut(collection, id, value) {
  await setJSON(`${collection}:${id}`, value);
  await indexAdd(`${collection}:index`, id);
}
async function collectionGet(collection, id) {
  return getJSON(`${collection}:${id}`);
}
async function collectionDelete(collection, id) {
  await del(`${collection}:${id}`);
  await indexRemove(`${collection}:index`, id);
}
async function collectionList(collection) {
  const ids = await indexMembers(`${collection}:index`);
  if (!ids.length) return [];
  // Batch fetch via pipeline for efficiency.
  const pipeline = ids.map(id => ['GET', `${collection}:${id}`]);
  const res = await fetch(`${BASE}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline)
  });
  if (!res.ok) throw new Error(`Redis pipeline failed (${res.status})`);
  const results = await res.json();
  const out = [];
  results.forEach((r, i) => {
    if (r && r.result) {
      try { out.push({ id: ids[i], value: JSON.parse(r.result) }); } catch { /* skip corrupt entry */ }
    }
  });
  return out;
}

module.exports = {
  configured,
  getJSON, setJSON, del,
  indexAdd, indexRemove, indexMembers,
  collectionPut, collectionGet, collectionDelete, collectionList
};
