// GET /api/config - public VAPID key the browser needs to subscribe to push.

import { getOptionalEnv, json } from './_lib/server.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const vapidPublicKey = getOptionalEnv('VAPID_PUBLIC_KEY');
  return json(res, 200, {
    vapidPublicKey,
    pushConfigured: Boolean(vapidPublicKey)
  });
}
