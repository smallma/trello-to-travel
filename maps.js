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
 * Words that mean the card isn't a real place (overview / transit / etc).
 * If a card title contains any of these AND has no parenthesized hint,
 * we skip it from the route.
 */
const NON_PLACE = [
  '總行程', '行程總覽', '交通', '機場接送', '住宿',
  '購物', '逛街', '退稅', '訂票', '訂位', '預約',
  '攻略', '推薦', '分享', '注意', '提醒', '備註',
  'check-in', 'check in', 'checkin',
];

/**
 * From a list of items, derive a list of waypoint query strings.
 * Skip items that are clearly not places (overview cards, transit notes).
 * Prefer `place` field; otherwise try to extract a clean landmark name from title.
 */
export function itemsToWaypoints(items, dayContext = '') {
  const city = extractCityHint(dayContext);
  return items
    .map(it => {
      const explicit = it.place && it.place.trim();
      if (explicit) {
        return { id: it.id, q: sanitize(explicit) };
      }
      const titleLower = (it.title || '').toLowerCase();
      // Skip non-place cards unless they have a parenthesized landmark
      const hasParen = /[(（]/.test(it.title || '');
      if (!hasParen && NON_PLACE.some(w => titleLower.includes(w.toLowerCase()))) {
        return null;
      }
      const q = sanitize(extractLandmark(it.title, city));
      return q && q.length >= 2 ? { id: it.id, q } : null;
    })
    .filter(Boolean);
}

/**
 * Pull a city name out of a day list name like:
 *   "6/18 (四) 維也納" -> "維也納"
 *   "6/22 (一) - 威尼斯 13:57離開 到16:25米蘭" -> "威尼斯"
 *   "6/25 (四) - 佛羅倫斯 - 比薩, Outlet" -> "佛羅倫斯"
 */
function extractCityHint(listName) {
  if (!listName) return '';
  // Strip date prefix and weekday parens
  let s = listName.replace(/^\s*\d+\/\d+\s*/, '').replace(/\([^)]*\)/g, '').trim();
  // Take first Chinese-string chunk
  const m = s.match(/[一-鿿]{2,}/);
  return m ? m[0] : '';
}

/**
 * Try to extract a clean landmark name from a Trello card title.
 * Strategy:
 *   1) If title has Chinese name + (English/Italian) → prefer the latin name inside parens
 *   2) Drop leading emojis, time, meal prefixes ("午餐："), trailing notes after 👉
 *   3) Append the city as a hint so Google disambiguates
 */
function extractLandmark(rawTitle, city) {
  if (!rawTitle) return '';
  let t = rawTitle
    .replace(/^[🍽️🏨🚆🛍️🎫🏛️📌🎆🍝🗽✈️🍣🍔🍜🍕🍰☕🧊🥐🌭🍦🍷🚇🚌🛂🌟⭐]+\s*/g, '')
    .replace(/\d{1,2}:\d{2}(\s*[~\-–到至]\s*\d{1,2}:\d{2})?/g, '')
    .replace(/^(午餐|晚餐|早餐|brunch|早午餐|宵夜|下午茶)\s*[：:]\s*/i, '')
    .replace(/【[^】]*】/g, '')   // drop 【重頭戲】etc
    .replace(/[👉👈🌟⭐]/g, '')
    .trim();

  // Pull latin/parenthesized hint first
  const paren = t.match(/[(（]([^)）]+)[)）]/);
  if (paren) {
    const inner = paren[1].trim();
    // If the parenthesized part has latin letters, it's usually the real name
    if (/[A-Za-zÀ-ÿ]{3,}/.test(inner)) {
      return city ? `${inner} ${city}` : inner;
    }
  }

  // Otherwise use the leading chunk before any punctuation/note
  t = t
    .split(/[，,、：:]/)[0]
    .replace(/[(（].*$/, '')
    .replace(/\s*已訂位.*$/, '')
    .replace(/\s*已取消.*$/, '')
    .trim();

  if (!t) return '';
  return city && !t.includes(city) ? `${t} ${city}` : t;
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
