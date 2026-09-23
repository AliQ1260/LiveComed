// POST /api/subscribe - save this device's push subscription and alert price (turning alerts on,
// changing the alert price, or the daily resync). Upserts on endpoint, so repeat calls just update the row.

import { deleteSubscription, isValidEndpoint, json, readJson, subscriptionRecordFromBody, supabaseRequest } from './_lib/server.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  let record;
  try {
    body = readJson(req);
    record = subscriptionRecordFromBody(body, req.headers['user-agent']);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  try {
    // Browser rotated the subscription (sent from the service worker): carry over the old alert price
    const oldEndpoint = body?.oldEndpoint;
    if (isValidEndpoint(oldEndpoint) && oldEndpoint !== record.endpoint) {
      const old = await supabaseRequest(`push_subscriptions?endpoint=eq.${encodeURIComponent(oldEndpoint)}&select=threshold`);
      if (old?.[0] && record.threshold === undefined) record.threshold = old[0].threshold;
      await deleteSubscription(oldEndpoint);
    }

    await supabaseRequest('push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [record]
    });
    return json(res, 200, { ok: true, threshold: record.threshold });
  } catch (error) {
    console.error('Subscribe error:', error);
    return json(res, 500, { error: 'Failed to save subscription.' });
  }
}
