const { removeSubscriptionByEndpoint } = require('../lib/push');
const store = require('../lib/store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!store.configured()) return res.status(500).json({ error: 'Storage not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const endpoint = body && body.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    await removeSubscriptionByEndpoint(endpoint);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
