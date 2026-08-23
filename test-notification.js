const webpush = require('web-push');
const store = require('../lib/store');
const { configureVapid } = require('../lib/push');

// POST body: { endpoint: <subscription.endpoint string> }
// Looks the stored subscription up server-side by endpoint (matches the
// original frontend contract) rather than requiring the browser to resend
// the full subscription object.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!store.configured()) return res.status(500).json({ error: 'Storage not configured' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (!body || !body.endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const id = Buffer.from(body.endpoint).toString('base64url').slice(0, 120);
  const record = await store.collectionGet('pushsub', id);
  if (!record || !record.subscription) {
    return res.status(404).json({ error: 'No subscription found for this device — enable alerts first' });
  }

  if (!configureVapid()) {
    return res.status(500).json({ error: 'VAPID keys are not configured on the server' });
  }

  try {
    const payload = JSON.stringify({
      title: '🧪 PROMISE PRO TEST',
      body: 'Android push notifications are working correctly.',
      test: true,
      timestamp: Date.now()
    });
    await webpush.sendNotification(record.subscription, payload);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await store.collectionDelete('pushsub', id);
      return res.status(410).json({ error: 'Subscription expired — please re-enable alerts' });
    }
    return res.status(500).json({ error: 'Failed to send test notification' });
  }
};
