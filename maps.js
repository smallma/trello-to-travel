// maps.js
// Build Google Maps Embed URLs from a list of items.
// API key is injected at runtime via setMapsKey() — never hard-coded.

let API_KEY = '';

export function setMapsKey(key) {
  API_KEY = key || '';
}

export function hasMapsKey() {
  return !!API_KEY;
}

/**
 * From a list of items, derive a list of waypoint query strings.
 * Prefer `place` (locationName / address); fall back to title (Google geocodes it well for landmarks).
 * Items without any usable text are skipped.
 */
export function itemsToWaypoints(items) {
  return items
    .map(it => {
      const q = sanitize((it.place && it.place.trim()) || cleanTitle(it.title));
      return q ? { id: it.id, q } : null;
    })
    .filter(Boolean);
}

/**
 * Ensure a string survives encodeURIComponent (drop lone surrogates).
 * Returns '' if the cleaned string is empty.
 */
function sanitize(s) {
  if (!s) return '';
  // Strip unpaired UTF-16 surrogate halves
  const cleaned = s.replace(/[\uD800-\uDFFF]/g, (ch, i, str) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) return ch; // valid high+low pair, keep
      return ''; // lone high surrogate
    }
    const prev = str.charCodeAt(i - 1);
    if (prev >= 0xD800 && prev <= 0xDBFF) return ch; // already kept as part of pair
    return ''; // lone low surrogate
  }).trim();
  try {
    encodeURIComponent(cleaned);
    return cleaned;
  } catch {
    return '';
  }
}

function cleanTitle(t) {
  if (!t) return '';
  return t
    .replace(/^[🍽️🏨🚆🛍️🎫🏛️📌🎆🍝🗽✈️🍣🍔🍜🍕🍰☕🧊🥐🌭🍦🍷]+\s*/g, '') // strip leading emojis
    .replace(/\([^)]*\)/g, '')   // strip parentheses
    .replace(/\d{1,2}:\d{2}/g, '') // strip times
    .replace(/[👉👈]/g, '')
    .trim();
}

/**
 * Build the embed URL for `directions` mode.
 * Requires at least 2 waypoints (origin + destination).
 */
export function buildEmbedUrl(waypoints, mode = 'driving') {
  if (!API_KEY) return null;
  if (waypoints.length < 2) return null;
  const origin = encodeURIComponent(waypoints[0].q);
  const destination = encodeURIComponent(waypoints[waypoints.length - 1].q);
  const middle = waypoints.slice(1, -1).map(w => encodeURIComponent(w.q)).join('|');
  let url = `https://www.google.com/maps/embed/v1/directions?key=${API_KEY}&origin=${origin}&destination=${destination}&mode=${mode}`;
  if (middle) url += `&waypoints=${middle}`;
  return url;
}

/**
 * Build the "place" embed URL for a single point.
 */
export function buildPlaceUrl(waypoint) {
  if (!waypoint) return null;
  return `https://www.google.com/maps/embed/v1/place?key=${API_KEY}&q=${encodeURIComponent(waypoint.q)}`;
}

/**
 * Build a "open in Google Maps" link (no key needed) for the same route.
 */
export function buildOpenUrl(waypoints, mode = 'driving') {
  if (!waypoints.length) return null;
  if (waypoints.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(waypoints[0].q)}`;
  }
  const origin = encodeURIComponent(waypoints[0].q);
  const destination = encodeURIComponent(waypoints[waypoints.length - 1].q);
  const middle = waypoints.slice(1, -1).map(w => encodeURIComponent(w.q)).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=${mode}`;
  if (middle) url += `&waypoints=${middle}`;
  return url;
}
