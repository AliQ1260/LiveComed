// POST /api/unsubscribe - delete this device's push subscription (turning alerts off).

import { deleteSubscription, isValidEndpoint, json, readJson } from './_lib/server.mjs';

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
    await deleteSubscription(endpoint);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return json(res, 500, { error: 'Failed to remove subscription.' });
  }
}
