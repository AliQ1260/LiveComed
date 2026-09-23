// Shared helpers for the Vercel functions in /api (files in _lib aren't deployed as endpoints).

import { timingSafeEqual } from 'node:crypto';
import webPushModule from 'web-push';
import { normalizeThreshold } from './alerts.mjs';

const webpush = webPushModule?.default || webPushModule;

// ===== HTTP =====

export function json(res, statusCode, payload) {
  res.status(statusCode).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(payload));
}

export function readJson(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

// ===== ENV =====

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name) {
  return process.env[name] || null;
}

// Only the scheduler knows ALERT_CHECK_SECRET. Accepts "x-alert-secret: <secret>" or
// "Authorization: Bearer <secret>"; constant-time compare so the secret can't be guessed by timing.
export function isAuthorized(req) {
  const expected = getOptionalEnv('ALERT_CHECK_SECRET');
  if (!expected) return false;

  const given = String(req.headers['x-alert-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ===== SUPABASE =====

// Talks to Supabase's REST API with the service role key (server-side only - never sent to browsers)
export async function supabaseRequest(path, { method = 'GET', body, headers = {} } = {}) {
  const baseUrl = getRequiredEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Works with both Supabase key styles: the legacy service_role key is a JWT ("eyJ...") and also goes in
  // Authorization; the newer secret key ("sb_secret_...") isn't a JWT and only goes in the apikey header
  const authHeaders = { apikey: serviceRoleKey };
  if (serviceRoleKey.startsWith('eyJ')) authHeaders.Authorization = `Bearer ${serviceRoleKey}`;

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ===== PUSH SUBSCRIPTIONS =====

export function isValidEndpoint(endpoint) {
  return typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1000;
}

// Validate what the browser sent: { subscription: PushSubscription.toJSON(), threshold, reset }.
// reset = true when alerts are turned on or the alert price changes: the device starts fresh, so if the
// price is already above the new threshold the next check alerts (handy for testing). The daily resync
// leaves reset off so it can't re-send an alert that's already showing.
export function subscriptionRecordFromBody(body, userAgent) {
  const subscription = body?.subscription;
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;

  if (!isValidEndpoint(endpoint)) {
    throw new Error('Invalid push subscription endpoint.');
  }
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
    throw new Error('Invalid push subscription keys.');
  }

  const record = {
    endpoint,
    p256dh,
    auth,
    user_agent: String(userAgent || '').slice(0, 300),
    updated_at: new Date().toISOString()
  };
  // No threshold sent (service worker re-subscribe) = keep the saved one, or the column default for a new row
  if (body?.threshold !== undefined) {
    record.threshold = normalizeThreshold(body.threshold);
  }
  if (body?.reset) {
    record.alert_active = false;
    record.below_count = 0;
  }
  return record;
}

export async function deleteSubscription(endpoint) {
  await supabaseRequest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}

// ===== WEB PUSH =====

export function configureWebPush() {
  webpush.setVapidDetails(
    getRequiredEnv('VAPID_SUBJECT'),
    getRequiredEnv('VAPID_PUBLIC_KEY'),
    getRequiredEnv('VAPID_PRIVATE_KEY')
  );
  return webpush;
}

// Send one notification to one device row. Returns 'sent', 'gone' (device unsubscribed or
// reinstalled - row deleted) or 'failed'. Undelivered alerts expire after 15 min; an old alert is useless.
export async function sendPush(push, row, notification) {
  try {
    await push.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(notification),
      { TTL: 15 * 60, urgency: 'high' }
    );
    return 'sent';
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await deleteSubscription(row.endpoint);
      return 'gone';
    }
    console.error('Push failed:', error?.statusCode, error?.body || error?.message);
    return 'failed';
  }
}
