// GET/POST /api/alert-check - run by cron-job.org every minute.
// Reads ComEd's latest 5-minute price and checks it against every device's own alert price,
// sending a "prices are high" alert or an all-clear where needed.
// Only calls ComEd when a new price could exist, so most runs cost ComEd nothing.

import { buildNotification, decideForDevice, decideInterval, INITIAL_STATE, isNewPriceDue } from './_lib/alerts.mjs';
import { configureWebPush, isAuthorized, json, sendPush, supabaseRequest } from './_lib/server.mjs';

const API_5MIN = 'https://hourlypricing.comed.com/api?type=5minutefeed';
const FETCH_TIMEOUT_MS = 10000;

// ===== DATA =====

async function loadState() {
  const rows = await supabaseRequest('alert_state?id=eq.1&select=*');
  return rows?.[0] || { id: 1, ...INITIAL_STATE };
}

// Save only if nobody else processed this interval first (optimistic lock on last_interval_ms).
// Returns false when another overlapping run got there first.
async function saveState(prev, next) {
  const rows = await supabaseRequest(`alert_state?id=eq.1&last_interval_ms=eq.${Number(prev.last_interval_ms) || 0}`, {
    method: 'PATCH',
    body: {
      last_interval_ms: next.last_interval_ms,
      last_price: next.last_price,
      updated_at: new Date().toISOString()
    }
  });
  return Array.isArray(rows) && rows.length > 0;
}

async function fetchLatestPrice() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_5MIN, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`ComEd HTTP ${res.status}`);
    const feed = await res.json();
    // Feed is newest-first; millisUTC is when the 5-minute interval ENDS
    return { ms: Number(feed?.[0]?.millisUTC), price: Number(feed?.[0]?.price) };
  } finally {
    clearTimeout(timer);
  }
}

// ===== PER-DEVICE ALERTS =====

async function checkDevices(latest) {
  const devices = await supabaseRequest('push_subscriptions?select=id,endpoint,p256dh,auth,threshold,alert_active,below_count') || [];
  const push = configureWebPush();
  const tally = { devices: devices.length, high: 0, clear: 0, sent: 0, removed: 0, failed: 0 };

  await Promise.all(devices.map(async (device) => {
    const decision = decideForDevice(device, latest.price);

    // Save the device's new state before sending, so a failed run can't send the same alert twice
    if (decision.changed) {
      await supabaseRequest(`push_subscriptions?id=eq.${device.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: decision.next
      });
    }
    if (decision.action === 'none') return;

    tally[decision.action]++;
    const result = await sendPush(push, device, buildNotification(decision.action, latest, device.threshold));
    if (result === 'sent') tally.sent++;
    else if (result === 'gone') tally.removed++;
    else tally.failed++;
  }));

  return tally;
}

// ===== HANDLER =====

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!isAuthorized(req)) {
    return json(res, 401, { error: 'Unauthorized.' });
  }

  try {
    const now = Date.now();
    const state = await loadState();

    // 1. Nothing new from ComEd yet - don't call them
    if (!isNewPriceDue(state, now)) {
      return json(res, 200, { ok: true, result: 'not-due', lastPrice: state.last_price });
    }

    // 2. Read the latest price; stop if it isn't new
    const latest = await fetchLatestPrice();
    const interval = decideInterval(state, latest, now);
    if (interval.reason === 'already-processed' || interval.reason === 'no-price') {
      return json(res, 200, { ok: true, result: interval.reason, price: latest.price });
    }

    // 3. Claim this interval, so overlapping runs can never process it twice
    const saved = await saveState(state, interval.state);
    if (!saved) {
      return json(res, 200, { ok: true, result: 'handled-by-another-run' });
    }
    if (!interval.process) {
      return json(res, 200, { ok: true, result: interval.reason, price: latest.price });
    }

    // 4. Check every device against its own alert price
    const alerts = await checkDevices(latest);
    return json(res, 200, { ok: true, result: 'checked', price: latest.price, alerts });
  } catch (error) {
    console.error('Alert check error:', error);
    return json(res, 500, { error: error.message || 'Alert check failed.' });
  }
}
