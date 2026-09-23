// Price alert rules. No dependencies, so the same logic can be tested in a browser.

// Default alert price. Matches the red "Very High" tier in getPriceRating() in index.html (above 20¢)
export const DEFAULT_THRESHOLD = 20;

// Allowed range for a device's own alert price
export const MIN_THRESHOLD = -10;
export const MAX_THRESHOLD = 100;

// Two intervals in a row at/below the threshold (10 minutes) before sending the all-clear,
// so a price bouncing around the threshold doesn't send a burst of alerts
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

// ===== STEP 1: IS THERE A NEW PRICE TO PROCESS? (shared by all devices) =====

// Skip the ComEd request entirely until a new price could exist
export function isNewPriceDue(state, now) {
  if (!state.last_interval_ms) return true;
  return now >= Number(state.last_interval_ms) + INTERVAL_MS + PUBLISH_BUFFER_MS;
}

// latest = { ms: interval end time (ComEd's millisUTC), price: cents }
// Returns { process, reason, state } - process is true only for a new, fresh price
export function decideInterval(state, latest, now) {
  const prev = { ...INITIAL_STATE, ...state };

  if (!latest || !Number.isFinite(latest.ms) || !Number.isFinite(latest.price)) {
    return { process: false, reason: 'no-price', state: prev };
  }

  // Each 5-minute interval is only processed once, however often the check runs
  if (latest.ms <= Number(prev.last_interval_ms)) {
    return { process: false, reason: 'already-processed', state: prev };
  }

  const next = { ...prev, last_interval_ms: latest.ms, last_price: latest.price };

  if (now - latest.ms > STALE_AFTER_MS) {
    return { process: false, reason: 'stale-price', state: next };
  }
  return { process: true, reason: 'new-price', state: next };
}

// ===== STEP 2: WHAT DOES EACH DEVICE GET? =====

// device = { threshold, alert_active, below_count } (a push_subscriptions row)
// Returns { action: 'high' | 'clear' | 'none', changed, next: { alert_active, below_count } }
export function decideForDevice(device, price) {
  const threshold = normalizeThreshold(device.threshold);
  const active = Boolean(device.alert_active);
  const below = Number(device.below_count) || 0;
  const result = (action, alert_active, below_count) => ({
    action,
    changed: alert_active !== active || below_count !== below,
    next: { alert_active, below_count }
  });

  if (price > threshold) {
    return active ? result('none', true, 0) : result('high', true, 0);
  }
  if (!active) return result('none', false, 0);

  const count = below + 1;
  return count >= CLEAR_AFTER_INTERVALS ? result('clear', false, 0) : result('none', true, count);
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

// Same tag for every alert, so the all-clear replaces the high-price alert on the lock screen
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
    body: `Notifications are working. You'll be alerted when the live price goes above ${thresholdText(threshold)}.`,
    tag: 'voltra-test',
    url: '/'
  };
}
