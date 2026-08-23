const webpush = require('web-push');
const store = require('./store');

const SUB_COLLECTION = 'pushsub';

function configureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

async function saveSubscription(subscription) {
  const id = Buffer.from(subscription.endpoint).toString('base64url').slice(0, 120);
  const existing = await store.collectionGet(SUB_COLLECTION, id);
  const record = {
    subscription,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    active: true
  };
  await store.collectionPut(SUB_COLLECTION, id, record);
  return id;
}

async function removeSubscriptionByEndpoint(endpoint) {
  const id = Buffer.from(endpoint).toString('base64url').slice(0, 120);
  await store.collectionDelete(SUB_COLLECTION, id);
}

async function sendToAll(payloadObj) {
  if (!configureVapid()) {
    return { sent: 0, failed: 0, skipped: true, reason: 'VAPID keys not configured' };
  }
  const items = await store.collectionList(SUB_COLLECTION);
  const payload = JSON.stringify(payloadObj);
  let sent = 0, failed = 0;

  for (const { id, value: record } of items) {
    if (!record || record.active === false) continue;
    try {
      await webpush.sendNotification(record.subscription, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await store.collectionPut(SUB_COLLECTION, id, { ...record, active: false });
      }
    }
  }
  return { sent, failed, skipped: false };
}

async function sendTestToSubscription(subscription) {
  if (!configureVapid()) throw new Error('VAPID keys not configured on the server');
  const payload = JSON.stringify({
    title: '🧪 PROMISE PRO TEST',
    body: 'Android push notifications are working correctly.',
    test: true,
    url: '/'
  });
  await webpush.sendNotification(subscription, payload);
}

module.exports = { saveSubscription, removeSubscriptionByEndpoint, sendToAll, sendTestToSubscription, configureVapid };
