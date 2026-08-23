const { saveSubscription } = require('../lib/push');
const store = require('../lib/store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!store.configured()) return res.status(500).json({ error: 'Storage not configured (UPSTASH_REDIS_REST_URL / TOKEN missing)' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const subscription = body && body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription' });
    }
    await saveSubscription(subscription);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
