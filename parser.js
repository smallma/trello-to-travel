// parser.js
// Pure function: parse Trello export JSON into {trip, days, extras, warnings}

const DATE_RE = /^(\d{1,2})\/(\d{1,2})/;
// Match time like "12:30", "18:30 ~ 21:00", "08:15-10:00"
const TIME_RE = /\b(\d{1,2}:\d{2})\s*(?:[~\-–到至]\s*(\d{1,2}:\d{2}))?/;
const URL_RE = /https?:\/\/[^\s<>"'\)\]]+/g;

// Category keywords (Chinese + common English).
// We match against the TITLE first (strong signal), then fall back to title+desc+labels.
// Order matters: more specific categories first to avoid false positives.
const CATEGORY_RULES = [
  { type: 'hotel',    emoji: '🏨', label: '住宿', keywords: ['住宿', '飯店', '旅館', '民宿', 'hotel', 'check-in', 'check in', 'checkin', '入住', '退房', '訂房'] },
  { type: 'transit',  emoji: '🚆', label: '交通', keywords: ['火車', '高鐵', '機票', '航班', '飛機', '搭乘', '巴士', '計程車', 'uber', '機場', '車站', '轉乘', '租車', 'train', 'flight', 'airport', '碼頭', '渡輪', '接送', '交通'] },
  { type: 'food',     emoji: '🍽️', label: '餐廳', keywords: ['餐廳', '午餐', '晚餐', '早餐', 'brunch', '咖啡', 'café', 'cafe', '甜點', '冰淇淋', 'gelato', '小吃', '美食', '酒吧', 'restaurant', '訂位'] },
  { type: 'shop',     emoji: '🛍️', label: '購物', keywords: ['購物', 'outlet', '免稅', '採買', '伴手禮', '退稅'] },
  { type: 'ticket',   emoji: '🎫', label: '票券', keywords: ['訂票', '票券', 'ticket', 'reservation'] },
  { type: 'sight',    emoji: '🏛️', label: '景點', keywords: ['教堂', '宮殿', '博物館', '美術館', '廣場', '城堡', '古城', '遺跡', '塔', '橋', '公園', '花園', '景點', '參觀', '展覽', 'museum', 'cathedral', 'palace', 'castle', '神殿', '聖殿'] },
];

export function parseTrello(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('這不像是 Trello 匯出的板：請傳入有效物件');
  }
  if (!Array.isArray(raw.cards) || !Array.isArray(raw.lists)) {
    throw new Error('這不像是 Trello 匯出的板：缺少 cards 或 lists 欄位');
  }

  const warnings = [];
  const openLists = raw.lists.filter(l => !l.closed);
  const openCards = raw.cards.filter(c => !c.closed);

  const cardsByList = new Map();
  for (const c of openCards) {
    if (!cardsByList.has(c.idList)) cardsByList.set(c.idList, []);
    cardsByList.get(c.idList).push(c);
  }
  for (const arr of cardsByList.values()) {
    arr.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  }

  const days = [];
  const extras = {};

  for (const list of openLists) {
    const items = (cardsByList.get(list.id) || []).map(toItem);
    const m = list.name.match(DATE_RE);
    if (m) {
      // Keep original Trello pos order; time is for display only, not for sorting.
      days.push({
        list_name: list.name,
        date: `${parseInt(m[1], 10)}/${parseInt(m[2], 10)}`,
        _sortKey: parseInt(m[1], 10) * 100 + parseInt(m[2], 10),
        items,
      });
    } else {
      extras[list.name] = items;
    }
  }

  days.sort((a, b) => a._sortKey - b._sortKey);
  for (const d of days) delete d._sortKey;

  if (days.length === 0) {
    warnings.push('未偵測到日期格式的清單，僅顯示補充資訊');
  }

  return {
    trip: raw.name || '未命名行程',
    days,
    extras,
    warnings,
  };
}

function toItem(card) {
  const rawTitle = card.name || '';
  const id = card.id || card.shortLink || ('c_' + Math.random().toString(36).slice(2, 10));

  // Extract time from title
  const tm = rawTitle.match(TIME_RE);
  const time_start = tm ? tm[1] : null;
  const time_end = tm && tm[2] ? tm[2] : null;

  // Clean title: remove time + trailing separators
  let title = rawTitle;
  if (tm) {
    title = title.replace(tm[0], '').trim();
    // strip trailing separator chars
    title = title.replace(/[\-–—|·,，、:：\s]+$/, '').trim();
  }
  // Collapse duplicate emojis (e.g., 🍝🍝 -> 🍝)
  title = collapseDuplicateEmoji(title);

  const item = { id, title, raw_title: rawTitle };
  if (time_start) item.time_start = time_start;
  if (time_end) item.time_end = time_end;

  // desc handling: extract URLs separately, keep clean desc
  const desc = (card.desc || '').trim();
  if (desc) {
    const urls = (desc.match(URL_RE) || []).map(u => u.replace(/[.,;:]+$/, ''));
    // Remove pure URL lines from desc; replace inline URLs with empty
    let cleanDesc = desc
      .split('\n')
      .map(line => {
        // Drop lines that are essentially just a URL or markdown URL
        const trimmed = line.trim();
        if (/^\[?https?:\/\//.test(trimmed) && !/[一-龥a-zA-Z]{3,}.*[一-龥a-zA-Z]{3,}/.test(trimmed.replace(/https?:\/\/\S+/g, ''))) {
          return '';
        }
        return line;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (cleanDesc) item.desc = cleanDesc;
    if (urls.length) {
      // De-duplicate
      const seen = new Set();
      item.links = urls.filter(u => {
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      });
    }
  }

  const place = card.locationName || card.address;
  if (place && place.trim()) item.place = place;

  if (Array.isArray(card.labels) && card.labels.length) {
    item.labels = card.labels.map(l => ({ color: l.color, name: l.name || '' }));
  }

  if (Array.isArray(card.attachments) && card.attachments.length) {
    const images = [];
    const otherLinks = [];
    for (const a of card.attachments) {
      if (!a.url) continue;
      if (isImageAttachment(a)) {
        images.push(toImage(a));
      } else {
        otherLinks.push(a.url);
      }
    }
    if (images.length) item.images = images;
    if (otherLinks.length) {
      const seen = new Set(item.links || []);
      const merged = [...(item.links || [])];
      for (const url of otherLinks) {
        if (!seen.has(url)) { merged.push(url); seen.add(url); }
      }
      if (merged.length) item.links = merged;
    }
  }

  // Also scan item.links (from desc URLs) for image links → move them to images
  if (item.links && item.links.length) {
    const stillLinks = [];
    for (const url of item.links) {
      if (/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(url)) {
        item.images = item.images || [];
        item.images.push({ thumb: url, full: url });
      } else {
        stillLinks.push(url);
      }
    }
    if (stillLinks.length) item.links = stillLinks; else delete item.links;
  }

  // Categorize
  item.category = categorize(title, item.desc, card.labels);

  return item;
}

function isImageAttachment(a) {
  if (a.mimeType && a.mimeType.startsWith('image/')) return true;
  if (a.url && /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(a.url)) return true;
  return false;
}

function toImage(a) {
  // Trello attachments have a `previews` array sorted small→large.
  // Pick a medium thumbnail (~300-600px) for the card thumb, keep full URL for lightbox.
  if (Array.isArray(a.previews) && a.previews.length) {
    const sorted = [...a.previews].sort((x, y) => (x.width || 0) - (y.width || 0));
    const thumb = sorted.find(p => (p.width || 0) >= 250) || sorted[Math.floor(sorted.length / 2)] || sorted[0];
    const full = sorted[sorted.length - 1] || thumb;
    return { thumb: thumb.url, full: full.url || a.url, name: a.name };
  }
  return { thumb: a.url, full: a.url, name: a.name };
}

function categorize(title, desc, labels) {
  const titleLower = title.toLowerCase();
  // Pass 1: match against title only (strong signal)
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (titleLower.includes(kw.toLowerCase())) {
        return { type: rule.type, emoji: rule.emoji, label: rule.label };
      }
    }
  }
  // Pass 2: match against title+desc+labels (fallback)
  const haystack = (title + ' ' + (desc || '') + ' ' + (labels || []).map(l => l.name).join(' ')).toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return { type: rule.type, emoji: rule.emoji, label: rule.label };
      }
    }
  }
  return { type: 'other', emoji: '📌', label: '行程' };
}

function collapseDuplicateEmoji(s) {
  // Collapse consecutive identical surrogate pairs / emojis
  return s.replace(/(\p{Extended_Pictographic})\1+/gu, '$1');
}
