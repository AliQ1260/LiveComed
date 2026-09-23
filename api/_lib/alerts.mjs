// Price alert rules. No dependencies, so the same logic can be tested in a browser.
// One toggle in the app turns on both alerts for a device:
//   - High:  live price goes above the device's own alert price (then an all-clear when it's back under)
//   - Zero:  live price is at or below 0¢ (once per dip)

// Default alert price. Matches the red "Very High" tier in getPriceRating() in index.html (above 20¢)
export const DEFAULT_THRESHOLD = 20;

// Allowed range for a device's own alert price
export const MIN_THRESHOLD = -10;
export const MAX_THRESHOLD = 100;

// Zero alert fires at or below this price (cents)
export const ZERO_PRICE = 0;

// Two intervals in a row back on the other side (10 minutes) before a high alert clears or a zero alert
// re-arms, so a price bouncing around the line doesn't send a burst of alerts
export const CLEAR_AFTER_INTERVALS = 2;

// Ignore prices older than this - if ComEd's feed stalls we don't alert on old data
export const STALE_AFTER_MS = 20 * 60 * 1000;

export const INTERVAL_MS = 5 * 60 * 1000;

// Wait this long after an interval ends before asking ComEd for the next one
export const PUBLISH_BUFFER_MS = 30 * 1000;

export const INITIAL_STATE = {
  last_interval_ms: 0,
  last_price: null
};

// Clamp and round a user-entered alert price; falls back to the default when it isn't a number
export function normalizeThreshold(value) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, n)) * 10) / 10;
}

// ===== STEP 1: WHICH PRICES ARE NEW? (shared by all devices) =====

// Skip the ComEd request entirely until a new price could exist
export function isNewPriceDue(state, now) {
  if (!state.last_interval_ms) return true;
  return now >= Number(state.last_interval_ms) + INTERVAL_MS + PUBLISH_BUFFER_MS;
}

// feed = ComEd's 5-minute feed, newest first, as [{ ms: interval end (millisUTC), price: cents }].
// Returns every price posted since the last run (oldest first), so a short dip or spike between
// two checks is never skipped - ComEd sometimes posts several late prices at once.
// Returns { intervals, reason, state } where state is what to save.
export function newIntervals(state, feed, now) {
  const prev = { ...INITIAL_STATE, ...state };
  const valid = (feed || []).filter((i) => Number.isFinite(i?.ms) && Number.isFinite(i?.price));
  if (!valid.length) {
    return { intervals: [], reason: 'no-price', state: prev };
  }

  const latest = valid[0];
  const last = Number(prev.last_interval_ms) || 0;
  if (latest.ms <= last) {
    return { intervals: [], reason: 'already-processed', state: prev };
  }

  const next = { ...prev, last_interval_ms: latest.ms, last_price: latest.price };

  // Very first run: only the newest price, don't replay the whole day. Never alert on stale prices.
  const fresh = valid
    .filter((i) => i.ms > last && now - i.ms <= STALE_AFTER_MS && (last > 0 || i === latest))
    .reverse();

  if (!fresh.length) {
    return { intervals: [], reason: 'stale-price', state: next };
  }
  return { intervals: fresh, reason: 'new-price', state: next };
}

// ===== STEP 2: WHAT DOES EACH DEVICE GET? =====

// High alert state machine for one price. Returns { action: 'high' | 'clear' | 'none', next }
export function decideHigh(device, price) {
  const threshold = normalizeThreshold(device.threshold);
  const active = Boolean(device.alert_active);
  const below = Number(device.below_count) || 0;

  if (price > threshold) {
    return { action: active ? 'none' : 'high', next: { alert_active: true, below_count: 0 } };
  }
  if (!active) return { action: 'none', next: { alert_active: false, below_count: 0 } };

  const count = below + 1;
  return count >= CLEAR_AFTER_INTERVALS
    ? { action: 'clear', next: { alert_active: false, below_count: 0 } }
    : { action: 'none', next: { alert_active: true, below_count: count } };
}

// Zero alert state machine for one price: alert once per dip, re-arm (silently) after the price
// has been above 0¢ for two intervals. Returns { action: 'zero' | 'none', next }
export function decideZero(device, price) {
  const active = Boolean(device.zero_active);
  const above = Number(device.zero_count) || 0;

  if (price <= ZERO_PRICE) {
    return { action: active ? 'none' : 'zero', next: { zero_active: true, zero_count: 0 } };
  }
  if (!active) return { action: 'none', next: { zero_active: false, zero_count: 0 } };

  const count = above + 1;
  return count >= CLEAR_AFTER_INTERVALS
    ? { action: 'none', next: { zero_active: false, zero_count: 0 } }
    : { action: 'none', next: { zero_active: true, zero_count: count } };
}

// Run a device through every new price, oldest first. Returns
// { next: state columns to save, changed, notifications: [...] }
export function evaluateDevice(device, intervals) {
  const start = {
    alert_active: Boolean(device.alert_active),
    below_count: Number(device.below_count) || 0,
    zero_active: Boolean(device.zero_active),
    zero_count: Number(device.zero_count) || 0
  };
  let state = { ...start };
  const highEvents = [];
  let lastZero = null;

  for (const interval of intervals) {
    const high = decideHigh({ ...device, ...state }, interval.price);
    const zero = decideZero({ ...device, ...state }, interval.price);
    state = { ...state, ...high.next, ...zero.next };
    if (high.action !== 'none') highEvents.push({ action: high.action, interval });
    if (zero.action === 'zero') lastZero = interval;
  }

  const notifications = [];

  // High: only the net result. A spike that went up and came back down between two checks
  // isn't worth a late "high" + "back down" pair
  if (highEvents.length) {
    const first = highEvents[0];
    const last = highEvents[highEvents.length - 1];
    if (!(first.action === 'high' && last.action === 'clear')) {
      notifications.push(buildNotification(last.action, last.interval, device.threshold));
    }
  }

  // Zero: always tell them, even if it was brief - that's the point of this alert
  if (lastZero) notifications.push(buildNotification('zero', lastZero, device.threshold));

  const changed = Object.keys(start).some((k) => start[k] !== state[k]);
  return { next: state, changed, notifications };
}

// ===== NOTIFICATION TEXT =====

// "8:10–8:15 PM" in Chicago time for an interval that ENDS at endMs
export function formatIntervalWindow(endMs) {
  const fmt = (ms) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit'
  }).format(new Date(ms));
  return `${fmt(endMs - INTERVAL_MS).replace(/\s?[AP]M$/i, '')}–${fmt(endMs)}`;
}

// Prices always show one decimal (24.3¢); alert prices show like the app does (20¢, 12.5¢)
const cents = (n) => `${Number(n).toFixed(1)}¢`;
const thresholdText = (n) => {
  const t = normalizeThreshold(n);
  return Number.isInteger(t) ? `${t}¢` : `${t.toFixed(1)}¢`;
};

// High alert and its all-clear share a tag (the all-clear replaces it on the lock screen);
// zero alerts use their own tag so they never overwrite a high alert
export function buildNotification(action, latest, threshold) {
  const timeWindow = formatIntervalWindow(latest.ms);

  if (action === 'high') {
    return {
      title: 'Prices are high',
      body: `Live price is ${cents(latest.price)} (${timeWindow}), above your ${thresholdText(threshold)} alert. Consider holding off on heavy appliances.`,
      tag: 'voltra-price',
      url: '/'
    };
  }

  if (action === 'zero') {
    return {
      title: 'Prices are at or below 0¢',
      body: `Live price is ${cents(latest.price)} (${timeWindow}). A great time to run heavy appliances.`,
      tag: 'voltra-zero',
      url: '/'
    };
  }

  return {
    title: 'Prices are back down',
    body: `Live price is ${cents(latest.price)} (${timeWindow}), back under your ${thresholdText(threshold)} alert.`,
    tag: 'voltra-price',
    url: '/'
  };
}

export function buildTestNotification(threshold) {
  return {
    title: 'Voltra test alert',
    body: `Notifications are working. You'll be alerted when the live price goes above ${thresholdText(threshold)} or drops to 0¢ or below.`,
    tag: 'voltra-test',
    url: '/'
  };
}
