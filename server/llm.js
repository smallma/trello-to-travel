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
