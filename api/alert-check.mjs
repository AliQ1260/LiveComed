// GET/POST /api/alert-check - run by cron-job.org (every 1-5 minutes).
// Reads every 5-minute price ComEd has posted since the last run and checks each device:
// a high alert / all-clear against its own alert price, and a zero alert at or below 0¢.
// Only calls ComEd when a new price could exist, so most runs cost ComEd nothing.

import { evaluateDevice, INITIAL_STATE, isNewPriceDue, newIntervals } from './_lib/alerts.mjs';
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

// Whole 24h feed, newest first; millisUTC is when each 5-minute interval ENDS
async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_5MIN, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`ComEd HTTP ${res.status}`);
    const feed = await res.json();
    return (Array.isArray(feed) ? feed : []).map((i) => ({ ms: Number(i.millisUTC), price: Number(i.price) }));
  } finally {
    clearTimeout(timer);
  }
}

// ===== PER-DEVICE ALERTS =====

async function checkDevices(intervals) {
  const devices = await supabaseRequest('push_subscriptions?select=id,endpoint,p256dh,auth,threshold,alert_active,below_count,zero_active,zero_count') || [];
  const push = configureWebPush();
  const tally = { devices: devices.length, notifications: 0, sent: 0, removed: 0, failed: 0 };

  await Promise.all(devices.map(async (device) => {
    const result = evaluateDevice(device, intervals);

    // Save the device's new state before sending, so a failed run can't send the same alert twice
    if (result.changed) {
      await supabaseRequest(`push_subscriptions?id=eq.${device.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: result.next
      });
    }

    for (const notification of result.notifications) {
      tally.notifications++;
      const outcome = await sendPush(push, device, notification);
      if (outcome === 'sent') tally.sent++;
      else if (outcome === 'failed') tally.failed++;
      else { tally.removed++; break; } // Device is gone - skip its other notifications
    }
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

    // 2. Read the feed; stop if nothing is new
    const feed = await fetchFeed();
    const batch = newIntervals(state, feed, now);
    const price = feed[0]?.price;
    if (batch.reason === 'already-processed' || batch.reason === 'no-price') {
      return json(res, 200, { ok: true, result: batch.reason, price });
    }

    // 3. Claim these intervals, so overlapping runs can never process them twice
    const saved = await saveState(state, batch.state);
    if (!saved) {
      return json(res, 200, { ok: true, result: 'handled-by-another-run' });
    }
    if (!batch.intervals.length) {
      return json(res, 200, { ok: true, result: batch.reason, price });
    }

    // 4. Check every device against every new price
    const alerts = await checkDevices(batch.intervals);
    return json(res, 200, { ok: true, result: 'checked', price, newPrices: batch.intervals.length, alerts });
  } catch (error) {
    console.error('Alert check error:', error);
    return json(res, 500, { error: error.message || 'Alert check failed.' });
  }
}
