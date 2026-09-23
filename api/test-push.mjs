// POST /api/test-push - "Send test" button: push a test notification to this device only.
// Only works for a device that's already subscribed, and at most once every 30 seconds.

import { buildTestNotification } from './_lib/alerts.mjs';
import { configureWebPush, isValidEndpoint, json, readJson, sendPush, supabaseRequest } from './_lib/server.mjs';

const TEST_COOLDOWN_MS = 30 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed.' });
  }

  let endpoint;
  try {
    endpoint = readJson(req)?.endpoint;
  } catch (error) {
    return json(res, 400, { error: 'Invalid JSON.' });
  }
  if (!isValidEndpoint(endpoint)) {
    return json(res, 400, { error: 'Invalid endpoint.' });
  }

  try {
    const rows = await supabaseRequest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&select=*`);
    const row = rows?.[0];
    if (!row) {
      return json(res, 404, { error: 'This device is not subscribed. Turn alerts off and on again.' });
    }

    const lastTest = row.last_test_at ? Date.parse(row.last_test_at) : 0;
    if (Date.now() - lastTest < TEST_COOLDOWN_MS) {
      return json(res, 429, { error: 'Please wait a few seconds before sending another test.' });
    }

    await supabaseRequest(`push_subscriptions?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { last_test_at: new Date().toISOString() }
    });

    const result = await sendPush(configureWebPush(), row, buildTestNotification(row.threshold));
    if (result !== 'sent') {
      return json(res, 502, { error: result === 'gone' ? 'This device is no longer subscribed. Turn alerts off and on again.' : 'The push service rejected the test.' });
    }
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Test push error:', error);
    return json(res, 500, { error: 'Failed to send test notification.' });
  }
}
