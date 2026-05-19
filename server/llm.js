// llm.js — MiniMax wrapper for extracting clean place names from itinerary items.
// Uses the OpenAI-compatible endpoint.

const ENDPOINT = process.env.MINIMAX_ENDPOINT || 'https://api.minimax.io/v1/chat/completions';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '25000', 10);

const SYSTEM_PROMPT = `你是一位地圖路線助理。我會給你一份旅遊行程的卡片列表，請你回傳「真實存在於地圖上、可以被 Google Maps 找到的地點」。

規則：
1. 跳過「總行程」「交通」「住宿」「機場接送」「攻略」「分享」「推薦」「備註」「注意事項」這類非具體地點的卡片。
2. 跳過備註型內容（如「精品街可以外帶皇帝煎餅」「如何申請豁免付稅」），它們不是地名。
3. 餐廳要回真正餐廳名稱（如 "Figlmüller"），不要回「午餐」「晚餐」這種類別字。
4. 若卡片標題含括號內的英文 / 原文（如「聖史蒂芬大教堂 (Stephansdom)」），優先用英文 / 原文。
5. 每個地名加上城市以便 Google 搜尋，格式 "<地點>, <城市>"，如「Stephansdom, Vienna」。
6. 必須保留每張被收錄的卡片 id 原樣。
7. 被跳過的卡片不要出現在輸出中。

只回傳 JSON 陣列，不要任何前置或後置文字、不要 markdown code fence：
[{"id":"...","q":"..."}]`;

/**
 * Ask MiniMax to clean up a day's items into geocodable place names.
 * @param {string} city - city hint for the day, e.g. "維也納"
 * @param {Array<{id:string,title:string,place?:string}>} items
 * @returns {Promise<Array<{id:string,q:string}>>}
 */
export async function extractPlaces(city, items) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set');
  if (!items || items.length === 0) return [];

  const userPayload = {
    city: city || '',
    cards: items.map(it => ({
      id: it.id,
      title: it.title || '',
      ...(it.place ? { place: it.place } : {}),
    })),
  };

  const body = {
    model: MODEL,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload, null, 2) },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MiniMax ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseJsonArray(text);
}

function parseJsonArray(s) {
  if (!s) return [];
  // Strip code fences if model wraps in ```
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Try direct parse first
  try {
    const v = JSON.parse(cleaned);
    if (Array.isArray(v)) return normalize(v);
  } catch {}
  // Fall back: find the first [ ... ] block
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (Array.isArray(v)) return normalize(v);
    } catch {}
  }
  return [];
}

function normalize(arr) {
  return arr
    .filter(x => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.q === 'string')
    .map(x => ({ id: x.id, q: x.q.trim() }))
    .filter(x => x.q.length > 0);
}

// ============================================================================
// AI Tour Guide
// ============================================================================

const GUIDE_PROMPTS = {
  sight: '你是專業導遊。請用中文介紹「{TITLE}」，內容包含：\n📜 故事 / 歷史背景（2-3 句）\n👀 必看亮點（3-5 項列點）\n⚠️ 注意事項（2-3 項列點，如人潮、攝影限制、適合時間）\n💡 在地小訣竅（1-2 項，如最佳拍照角度、隱藏入口）',
  food: '你是在地美食家。請用中文介紹餐廳「{TITLE}」，內容包含：\n🍽️ 招牌菜 / 必點（3-5 項）\n💰 大致預算 / CP 值\n⚠️ 注意（訂位難度、忌諱、用餐時段）\n💡 點餐小訣竅（如該怎麼點、能否拼桌）',
  hotel: '你是旅遊住宿達人。請用中文介紹住宿「{TITLE}」，內容包含：\n🏨 房型 / 設施重點（3-5 項）\n📍 周邊地理（離地鐵站、景點多遠）\n⚠️ 注意事項（check-in 時間、停車、城市稅、有無早餐）\n💡 訂房 / 入住小撇步',
  transit: '你是交通達人。請用中文介紹交通安排「{TITLE}」，內容包含：\n🚆 路線重點 / 班次特性\n💰 票價 / 預訂建議\n⚠️ 注意事項（誤點機率、上下車站名、行李限制）\n💡 在地搭乘小撇步',
  shop: '你是購物嚮導。請用中文介紹購物地點「{TITLE}」：\n🛍️ 必買 / 特色商品（3-5 項）\n💰 價格水位 / 退稅\n⚠️ 容易踩雷的東西（不建議買、品質落差大、假貨）\n💡 殺價 / 退稅小訣竅',
  ticket: '你是票券達人。請用中文介紹票券「{TITLE}」：\n🎫 票券內容 / 包含項目\n💰 票價建議與不同方案差別\n⚠️ 訂購注意（最佳預訂時機、能不能改期、現場買價差）\n💡 使用上的小撇步',
  other: '你是專業導遊。請用中文介紹「{TITLE}」，給出 3-5 段實用的提醒或建議，包含值得注意的細節、在地小訣竅。',
};

/**
 * Generate a tour-guide-style writeup for a single itinerary item.
 * @param {object} item - {id, title, category, place?, desc?}
 * @param {string} city - city hint, e.g. "維也納"
 * @param {string} preference - free-form board-level preference, may be empty
 * @returns {Promise<string>} markdown content
 */
export async function generateGuide(item, city, preference) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set');

  const type = item?.category?.type || 'other';
  const tmpl = GUIDE_PROMPTS[type] || GUIDE_PROMPTS.other;
  const base = tmpl.replace('{TITLE}', item.title || '此行程');

  const extra = [];
  if (city) extra.push(`城市：${city}`);
  if (item.place) extra.push(`地點：${item.place}`);
  if (item.desc) extra.push(`卡片上的備註：${truncate(item.desc, 400)}`);
  if (preference) extra.push(`旅人偏好：${preference}`);

  const system = `${base}

【嚴格輸出規則】
- 直接回答，不要任何思考過程、推理、自言自語
- 不要說「用戶要求」「我需要」「讓我組織」這類後設語言
- 不要 markdown code fence、不要 JSON、不要 XML 標籤
- 全程使用「繁體中文」（不要簡體字）
- 不要前言（不說「好的」「以下是」「沒問題」）
- 用 emoji 標題分段，內容用條列或短句
- 總長度 200-350 字
- 不熟悉就說「資訊有限，建議查當地最新評論」，不要亂編
- 根據旅人偏好調整重點（若提供）

【輸出範例格式】
📜 故事
（內容）

👀 必看亮點
- ...
- ...

⚠️ 注意事項
- ...

💡 在地小訣竅
- ...`;

  const user = extra.join('\n') || '請依標題介紹';

  const body = {
    model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
    max_tokens: 800,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MiniMax ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return cleanGuideText(text);
}

/**
 * MiniMax-M2 series are reasoning models — they often dump their internal
 * thinking (in Simplified Chinese, with "用户要求"/"让我组织" preambles) before
 * the actual answer. Strip everything up to the first emoji-prefixed section,
 * which is where the user-facing content starts per our prompt template.
 * Also convert any leftover Simplified Chinese to Traditional via a small
 * lookup table for the most common cases.
 */
function cleanGuideText(raw) {
  if (!raw) return '';
  let text = raw
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Find the first emoji-headed section. Our template starts with one of
  // 📜 👀 ⚠️ 💡 🍽️ 🏨 🚆 🛍️ 🎫 📍 🌟 — slice from there onward.
  const sectionStart = text.search(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  if (sectionStart > 0) {
    // If the first ~60 chars before the emoji contain reasoning keywords, drop them.
    const head = text.slice(0, sectionStart);
    const reasoning = /用户|讓我|让我|我需要|首先|好的|以下是|我对|对这个/.test(head);
    if (reasoning || sectionStart > 100) {
      text = text.slice(sectionStart).trim();
    }
  }

  // Remove any stray "用户要求" / "我需要組織" lines that slipped past
  text = text
    .split('\n')
    .filter(line => !/^(用户要求|让我|讓我|我需要|首先|好的，|以下是我|我对|对这个|這座|建于)/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
