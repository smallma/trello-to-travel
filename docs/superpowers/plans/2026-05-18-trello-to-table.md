# Trello → 旅行社風行程表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個純前端網頁，可上傳 Trello 匯出的 JSON，渲染成旅行社風格的乾淨行程表，並能一鍵複製為結構化 JSON 給 LLM 分析。

**Architecture:** 單頁應用，純靜態檔案（HTML + CSS + JS），無 build step。資料只在瀏覽器解析、不上傳。三大模組：解析（parser）、渲染（renderer）、複製（exporter）。

**Tech Stack:** HTML5 + Tailwind CSS (CDN) + Vanilla JS (ES2020+) + marked.js (CDN, Markdown 渲染) + Noto Serif/Sans TC (Google Fonts)。部署到 Vercel preview。

**Reference Spec:** `docs/superpowers/specs/2026-05-18-trello-to-table-design.md`

---

## File Structure

```
trello-to-table/
├── index.html              主頁面（HTML 結構、CDN 引用、字體）
├── style.css               自訂樣式（Tailwind 不足的部分、配色變數、動畫）
├── app.js                  入口 + UI 互動 + 事件綁定
├── parser.js               解析 Trello JSON → 內部資料結構
├── renderer.js             把內部資料結構畫到 DOM
├── exporter.js             產生「複製給 LLM 的 JSON」
├── trello.json             範例資料（已存在，不動）
├── README.md               推廣型說明文件（最後寫）
└── docs/superpowers/
    ├── specs/2026-05-18-trello-to-table-design.md
    ├── specs/2026-05-18-trello-to-table-design.html
    └── plans/2026-05-18-trello-to-table.md  ← 本檔
```

**模組職責**：
- `parser.js`：純函式，輸入 raw Trello JSON、輸出 `{trip, days, extras, warnings}`。無 DOM 依賴。
- `renderer.js`：純函式，輸入解析後資料、輸出 DOM 操作。負責畫面組裝。
- `exporter.js`：純函式，輸入解析後資料 + options，輸出最終要複製的 JSON 字串。
- `app.js`：黏合層。檔案上傳 / 工具列按鈕 / toast / error banner。

**測試策略**：純前端無 build。使用 `tests.html` 載入各模組並執行斷言式測試（自製極簡 assert，console.log 結果）。重點測試 `parser.js` 與 `exporter.js`（純函式好測），UI 互動手動驗證。

---

## Task 1: 建立專案骨架與基本 HTML

**Files:**
- Create: `index.html`
- Create: `style.css`
- Create: `app.js`

- [ ] **Step 1: 建立 `index.html` 基本骨架**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trello → 旅行社行程表</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@500;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="style.css">
</head>
<body class="bg-[#FAFAF7] text-gray-800 font-sans">
  <header class="border-b-2 border-[#2D5A4E] bg-white">
    <div class="max-w-5xl mx-auto px-6 py-6 flex items-center justify-between">
      <h1 id="trip-title" class="font-serif text-2xl text-[#2D5A4E]">Trello → 旅行社行程表</h1>
      <label class="cursor-pointer bg-[#2D5A4E] hover:bg-[#E07856] text-white px-4 py-2 rounded text-sm transition">
        <span id="upload-label">上傳 JSON</span>
        <input id="file-input" type="file" accept=".json,application/json" class="hidden">
      </label>
    </div>
  </header>

  <div id="banner" class="hidden max-w-5xl mx-auto mt-4 px-4 py-3 rounded text-sm"></div>

  <section id="toolbar" class="hidden max-w-5xl mx-auto px-6 mt-6 flex flex-wrap gap-3 items-center">
    <button id="expand-all" class="px-3 py-1.5 border border-[#2D5A4E] text-[#2D5A4E] rounded text-sm hover:bg-[#2D5A4E] hover:text-white transition">全部展開</button>
    <button id="collapse-all" class="px-3 py-1.5 border border-[#2D5A4E] text-[#2D5A4E] rounded text-sm hover:bg-[#2D5A4E] hover:text-white transition">全部收合</button>
    <div class="flex items-center gap-2 ml-auto">
      <label class="text-sm text-gray-600 flex items-center gap-1.5 cursor-pointer">
        <input id="include-extras" type="checkbox" checked class="accent-[#2D5A4E]">
        包含補充資訊
      </label>
      <button id="copy-json" class="px-4 py-1.5 bg-[#E07856] hover:bg-[#c8633f] text-white rounded text-sm transition">複製為 JSON</button>
    </div>
  </section>

  <main id="main" class="max-w-5xl mx-auto px-6 py-8"></main>

  <div id="toast" class="hidden fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-5 py-2.5 rounded-full text-sm shadow-lg"></div>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 建立 `style.css`（自訂變數與動畫）**

```css
:root {
  --bg: #FAFAF7;
  --brand: #2D5A4E;
  --accent: #E07856;
  --line: #e5e7eb;
}

body { font-family: 'Noto Sans TC', sans-serif; }
.font-serif { font-family: 'Noto Serif TC', serif; }

.day-block { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); margin-bottom: 20px; overflow: hidden; }
.day-header { background: var(--brand); color: #fff; padding: 14px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-family: 'Noto Serif TC', serif; font-size: 18px; }
.day-header .chev { transition: transform .25s; }
.day-block.collapsed .day-header .chev { transform: rotate(-90deg); }
.day-body { padding: 8px 0; }
.day-block.collapsed .day-body { display: none; }

.card-item { padding: 14px 20px; border-bottom: 1px solid var(--line); cursor: pointer; transition: background .15s; }
.card-item:last-child { border-bottom: none; }
.card-item:hover { background: #fcfcf9; }
.card-title { font-weight: 500; color: #1f2937; }
.card-preview { color: #6b7280; font-size: 13.5px; margin-top: 4px; }
.card-detail { max-height: 0; opacity: 0; overflow: hidden; transition: max-height .3s ease, opacity .25s, margin-top .25s; }
.card-item.expanded .card-detail { max-height: 4000px; opacity: 1; margin-top: 12px; }
.card-detail .markdown { color: #374151; font-size: 14.5px; line-height: 1.7; }
.card-detail .markdown a { color: var(--brand); text-decoration: underline; }
.card-detail .markdown ul { padding-left: 20px; list-style: disc; }
.card-detail .markdown ol { padding-left: 20px; list-style: decimal; }
.card-detail .markdown code { background: #f3f4f0; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
.card-detail .meta { margin-top: 10px; font-size: 13px; color: #6b7280; display: flex; flex-direction: column; gap: 4px; }
.card-detail .meta a { color: var(--brand); }

.label-chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11.5px; color: #fff; margin-right: 4px; }
.label-green { background: #15803d; }
.label-yellow { background: #ca8a04; color: #1f2937; }
.label-orange { background: #ea580c; }
.label-red { background: #dc2626; }
.label-purple { background: #7c3aed; }
.label-blue { background: #2563eb; }
.label-sky { background: #0284c7; }
.label-lime { background: #65a30d; }
.label-pink { background: #db2777; }
.label-black { background: #1f2937; }

.extras-section { margin-top: 32px; }
.extras-section h2 { font-family: 'Noto Serif TC', serif; color: var(--brand); font-size: 20px; margin-bottom: 12px; }
.extras-group { background: #fff; border-radius: 8px; margin-bottom: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.extras-group-header { padding: 12px 18px; background: #f3f4f0; cursor: pointer; font-weight: 500; color: var(--brand); display: flex; justify-content: space-between; }
.extras-group.collapsed .extras-group-body { display: none; }
.extras-group .chev { transition: transform .25s; }
.extras-group.collapsed .chev { transform: rotate(-90deg); }
```

- [ ] **Step 3: 建立 `app.js` 入口殘骸**

```js
// app.js
console.log('app.js loaded');

const fileInput = document.getElementById('file-input');
const uploadLabel = document.getElementById('upload-label');

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  console.log('file picked:', file.name);
  uploadLabel.textContent = '重新上傳';
});
```

- [ ] **Step 4: 在瀏覽器打開驗證**

Run: `open index.html`（macOS）
Expected: 看到深綠 Header「Trello → 旅行社行程表」與右上「上傳 JSON」按鈕；點按鈕能選檔案；DevTools console 看到 `app.js loaded` 和 `file picked: trello.json`。

- [ ] **Step 5: Commit**

```bash
git init  # 若還沒 init
git add index.html style.css app.js
git commit -m "feat: scaffold static page with upload UI"
```

---

## Task 2: 建立 parser.js — 解析 Trello JSON

**Files:**
- Create: `parser.js`
- Create: `tests.html`
- Create: `tests/parser.test.js`

- [ ] **Step 1: 建立 `tests.html`（極簡測試 runner）**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>Tests</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #111; color: #eee; }
    .pass { color: #4ade80; }
    .fail { color: #f87171; }
    .group { color: #fbbf24; margin-top: 14px; font-weight: bold; }
    pre { background: #1f2937; padding: 8px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Tests</h1>
  <div id="out"></div>
  <script type="module">
    const out = document.getElementById('out');
    window.__results = { pass: 0, fail: 0 };
    window.group = (name) => { const d = document.createElement('div'); d.className = 'group'; d.textContent = '▸ ' + name; out.appendChild(d); };
    window.test = (name, fn) => {
      try { fn(); const d = document.createElement('div'); d.className = 'pass'; d.textContent = '  ✓ ' + name; out.appendChild(d); window.__results.pass++; }
      catch (e) { const d = document.createElement('div'); d.className = 'fail'; d.innerHTML = '  ✗ ' + name + '<pre>' + (e.stack || e.message) + '</pre>'; out.appendChild(d); window.__results.fail++; }
    };
    window.assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
    window.assertEq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + '\nExpected: ' + JSON.stringify(b) + '\nActual:   ' + JSON.stringify(a)); };

    await import('./tests/parser.test.js');
    await import('./tests/exporter.test.js').catch(()=>{});

    const summary = document.createElement('div');
    summary.className = window.__results.fail ? 'fail' : 'pass';
    summary.style.marginTop = '20px';
    summary.style.fontSize = '18px';
    summary.textContent = `\n總計: ${window.__results.pass} 通過, ${window.__results.fail} 失敗`;
    out.appendChild(summary);
  </script>
</body>
</html>
```

- [ ] **Step 2: 寫第一批測試（先失敗）**

`tests/parser.test.js`：

```js
import { parseTrello } from '../parser.js';

group('parseTrello — 基本驗證');

test('丟非物件會 throw', () => {
  let err;
  try { parseTrello(null); } catch (e) { err = e; }
  assert(err, 'should throw');
  assert(err.message.includes('Trello'), 'error message should mention Trello');
});

test('缺 cards 或 lists 會 throw', () => {
  let err;
  try { parseTrello({ name: 'x' }); } catch (e) { err = e; }
  assert(err);
});

test('回傳結構含 trip / days / extras / warnings', () => {
  const result = parseTrello({
    name: '測試行程',
    cards: [],
    lists: [],
  });
  assert(result.trip === '測試行程');
  assert(Array.isArray(result.days));
  assert(typeof result.extras === 'object');
  assert(Array.isArray(result.warnings));
});

group('parseTrello — 分類與排序');

test('日期清單依月日排序', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l2', name: '6/20威尼斯', closed: false, pos: 100 },
      { id: 'l1', name: '6/18 (四) 維也納', closed: false, pos: 200 },
      { id: 'l3', name: '7/1 (三) 回台', closed: false, pos: 50 },
    ],
    cards: [],
  });
  assertEq(result.days.map(d => d.date), ['6/18', '6/20', '7/1']);
});

test('過濾 closed 清單', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l1', name: '6/18 開放', closed: false, pos: 1 },
      { id: 'l2', name: '6/18 關閉', closed: true, pos: 2 },
    ],
    cards: [],
  });
  assertEq(result.days.length, 1);
  assertEq(result.days[0].list_name, '6/18 開放');
});

test('過濾 closed 卡片', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [
      { id: 'c1', name: '活', idList: 'l1', closed: false, pos: 1, desc: '' },
      { id: 'c2', name: '封', idList: 'l1', closed: true, pos: 2, desc: '' },
    ],
  });
  assertEq(result.days[0].items.length, 1);
  assertEq(result.days[0].items[0].title, '活');
});

test('卡片依 pos 升冪排序', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [
      { id: 'c1', name: 'B', idList: 'l1', closed: false, pos: 200, desc: '' },
      { id: 'c2', name: 'A', idList: 'l1', closed: false, pos: 100, desc: '' },
      { id: 'c3', name: 'C', idList: 'l1', closed: false, pos: 300, desc: '' },
    ],
  });
  assertEq(result.days[0].items.map(i => i.title), ['A', 'B', 'C']);
});

test('非日期清單放到 extras', () => {
  const result = parseTrello({
    name: 't',
    lists: [
      { id: 'l1', name: '6/18 維', closed: false, pos: 1 },
      { id: 'l2', name: '購物', closed: false, pos: 2 },
      { id: 'l3', name: '餐廳', closed: false, pos: 3 },
    ],
    cards: [],
  });
  assertEq(result.days.length, 1);
  assert('購物' in result.extras);
  assert('餐廳' in result.extras);
});

test('卡片欄位完整映射', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18 維', closed: false, pos: 1 }],
    cards: [{
      id: 'c1', name: '聖史蒂芬大教堂', idList: 'l1', closed: false, pos: 1,
      desc: '# 標題\n\n細節說明',
      locationName: 'Stephansdom',
      address: 'Vienna',
      labels: [{ color: 'green', name: '必去' }],
      attachments: [{ url: 'https://x.com', name: '官網' }],
    }],
  });
  const item = result.days[0].items[0];
  assertEq(item.title, '聖史蒂芬大教堂');
  assertEq(item.desc, '# 標題\n\n細節說明');
  assertEq(item.place, 'Stephansdom');
  assertEq(item.labels, [{ color: 'green', name: '必去' }]);
  assertEq(item.attachments, [{ url: 'https://x.com', name: '官網' }]);
});

test('locationName 為空時 fallback 到 address', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '6/18', closed: false, pos: 1 }],
    cards: [{ id: 'c1', name: 'x', idList: 'l1', closed: false, pos: 1, desc: '', locationName: '', address: 'Roma' }],
  });
  assertEq(result.days[0].items[0].place, 'Roma');
});

test('無日期清單會放 warning', () => {
  const result = parseTrello({
    name: 't',
    lists: [{ id: 'l1', name: '購物', closed: false, pos: 1 }],
    cards: [],
  });
  assertEq(result.days.length, 0);
  assert(result.warnings.some(w => w.includes('日期')));
});
```

- [ ] **Step 3: 在瀏覽器執行測試確認全部失敗**

Run: `open tests.html`
Expected: 所有 test 顯示 `✗`（parser.js 還不存在，import 會 error）。

- [ ] **Step 4: 實作 `parser.js`**

```js
// parser.js
// 純函式：解析 Trello 匯出 JSON

const DATE_RE = /^(\d{1,2})\/(\d{1,2})/;

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
  const item = { title: card.name || '' };
  if (card.desc && card.desc.trim()) item.desc = card.desc;
  const place = card.locationName || card.address;
  if (place && place.trim()) item.place = place;
  if (Array.isArray(card.labels) && card.labels.length) {
    item.labels = card.labels.map(l => ({ color: l.color, name: l.name || '' }));
  }
  if (Array.isArray(card.attachments) && card.attachments.length) {
    item.attachments = card.attachments
      .filter(a => a.url)
      .map(a => ({ url: a.url, name: a.name || a.url }));
    if (item.attachments.length === 0) delete item.attachments;
  }
  return item;
}
```

- [ ] **Step 5: 重新跑測試確認全部通過**

Run: `open tests.html`
Expected: 所有 `parseTrello` 測試顯示 `✓`，底部「總計: 11 通過, 0 失敗」。

- [ ] **Step 6: 用真實資料煙霧測試**

開啟瀏覽器 console，貼入：

```js
const r = await fetch('trello.json').then(r => r.json());
const m = await import('./parser.js');
const parsed = m.parseTrello(r);
console.log('trip:', parsed.trip);
console.log('days:', parsed.days.length);
console.log('first day:', parsed.days[0]);
console.log('extras keys:', Object.keys(parsed.extras));
console.log('warnings:', parsed.warnings);
```

Expected: `trip: 2026-06歐洲行`；`days` 數量 > 0 且依日期排序；`extras` 含「購物」「餐廳」「提前訂位」「其他相關資訊」（或其中部分）。

- [ ] **Step 7: Commit**

```bash
git add parser.js tests.html tests/parser.test.js
git commit -m "feat: add parser for Trello board JSON"
```

---

## Task 3: 建立 exporter.js — 產生複製用 JSON

**Files:**
- Create: `exporter.js`
- Create: `tests/exporter.test.js`

- [ ] **Step 1: 寫測試（先失敗）**

`tests/exporter.test.js`：

```js
import { toCopyJson } from '../exporter.js';

group('toCopyJson');

const sampleData = {
  trip: '測試行程',
  days: [
    {
      list_name: '6/18 (四) 維也納',
      date: '6/18',
      items: [
        { title: '聖史蒂芬大教堂', desc: '細節', place: 'Stephansdom' },
        { title: '吃晚餐' },
      ],
    },
  ],
  extras: {
    '購物': [{ title: 'Outlet' }],
    '餐廳': [{ title: '推薦餐廳' }],
  },
  warnings: [],
};

test('includeExtras=true 時包含 extras key', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: true }));
  assert(obj.extras);
  assertEq(Object.keys(obj.extras), ['購物', '餐廳']);
});

test('includeExtras=false 時不含 extras key', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  assert(!('extras' in obj));
});

test('含 trip / exported_at / days 必要欄位', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  assertEq(obj.trip, '測試行程');
  assert(typeof obj.exported_at === 'string');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(obj.exported_at));
  assertEq(obj.days.length, 1);
});

test('days[i].items 保留所有欄位', () => {
  const obj = JSON.parse(toCopyJson(sampleData, { includeExtras: false }));
  const item = obj.days[0].items[0];
  assertEq(item.title, '聖史蒂芬大教堂');
  assertEq(item.desc, '細節');
  assertEq(item.place, 'Stephansdom');
});

test('輸出是格式化的 JSON（含換行）', () => {
  const json = toCopyJson(sampleData, { includeExtras: false });
  assert(json.includes('\n'), 'JSON should be pretty-printed');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `open tests.html`
Expected: exporter 5 個測試全部 `✗`。

- [ ] **Step 3: 實作 `exporter.js`**

```js
// exporter.js
// 將解析後資料轉成可複製、給 LLM 讀的 JSON 字串

export function toCopyJson(data, options = {}) {
  const includeExtras = options.includeExtras !== false;

  const output = {
    trip: data.trip,
    exported_at: new Date().toISOString(),
    days: data.days.map(d => ({
      list_name: d.list_name,
      date: d.date,
      items: d.items,
    })),
  };

  if (includeExtras && data.extras && Object.keys(data.extras).length > 0) {
    output.extras = data.extras;
  }

  return JSON.stringify(output, null, 2);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `open tests.html`
Expected: 所有 exporter 測試 `✓`，總計 16 pass / 0 fail。

- [ ] **Step 5: Commit**

```bash
git add exporter.js tests/exporter.test.js
git commit -m "feat: add JSON exporter for LLM consumption"
```

---

## Task 4: 建立 renderer.js — 把資料畫到 DOM

**Files:**
- Create: `renderer.js`

無自動化測試（DOM 渲染以肉眼驗證為主，純函式測 expensive 又脆弱）。

- [ ] **Step 1: 實作 `renderer.js`（完整檔案）**

```js
// renderer.js
// 純 DOM 操作：把解析後資料畫到 #main

const LABEL_COLORS = ['green','yellow','orange','red','purple','blue','sky','lime','pink','black'];

export function renderApp(data) {
  document.getElementById('trip-title').textContent = data.trip;
  const main = document.getElementById('main');
  main.innerHTML = '';

  for (const day of data.days) {
    main.appendChild(renderDay(day));
  }

  if (Object.keys(data.extras).length > 0) {
    main.appendChild(renderExtras(data.extras));
  }
}

function renderDay(day) {
  const block = el('div', 'day-block');
  block.dataset.role = 'day';

  const header = el('div', 'day-header');
  header.innerHTML = `<span>${escape(day.list_name)}</span><span class="chev">▾</span>`;
  header.addEventListener('click', () => block.classList.toggle('collapsed'));
  block.appendChild(header);

  const body = el('div', 'day-body');
  for (const item of day.items) {
    body.appendChild(renderCard(item));
  }
  if (day.items.length === 0) {
    body.appendChild(el('div', 'card-item', '（這天還沒有安排）'));
  }
  block.appendChild(body);

  return block;
}

function renderCard(item) {
  const card = el('div', 'card-item');
  card.dataset.role = 'card';

  const title = el('div', 'card-title', item.title);
  card.appendChild(title);

  const preview = previewText(item.desc);
  if (preview) {
    card.appendChild(el('div', 'card-preview', preview));
  }

  const detail = el('div', 'card-detail');
  if (item.desc) {
    const md = el('div', 'markdown');
    md.innerHTML = window.marked.parse(item.desc);
    detail.appendChild(md);
  }
  const meta = el('div', 'meta');
  if (item.place) {
    meta.appendChild(el('div', '', '📍 ' + item.place));
  }
  if (item.attachments && item.attachments.length) {
    for (const a of item.attachments) {
      const row = el('div', '');
      row.innerHTML = `🔗 <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener">${escape(a.name)}</a>`;
      meta.appendChild(row);
    }
  }
  if (item.labels && item.labels.length) {
    const row = el('div', '');
    row.innerHTML = '🏷️ ' + item.labels.map(l => {
      const color = LABEL_COLORS.includes(l.color) ? l.color : 'black';
      return `<span class="label-chip label-${color}">${escape(l.name || color)}</span>`;
    }).join('');
    meta.appendChild(row);
  }
  if (meta.childNodes.length) detail.appendChild(meta);
  card.appendChild(detail);

  card.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    card.classList.toggle('expanded');
  });

  return card;
}

function renderExtras(extras) {
  const wrap = el('section', 'extras-section');
  wrap.appendChild(el('h2', '', '📌 補充資訊'));

  for (const [name, items] of Object.entries(extras)) {
    const group = el('div', 'extras-group collapsed');
    const header = el('div', 'extras-group-header');
    header.innerHTML = `<span>${escape(name)}（${items.length}）</span><span class="chev">▾</span>`;
    header.addEventListener('click', () => group.classList.toggle('collapsed'));
    group.appendChild(header);

    const body = el('div', 'extras-group-body');
    for (const item of items) {
      body.appendChild(renderCard(item));
    }
    if (items.length === 0) {
      body.appendChild(el('div', 'card-item', '（沒有項目）'));
    }
    group.appendChild(body);

    wrap.appendChild(group);
  }
  return wrap;
}

function previewText(desc) {
  if (!desc) return '';
  const firstLine = desc.split('\n').map(s => s.trim()).find(s => s.length > 0) || '';
  const clean = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '');
  return clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function escapeAttr(s) { return escape(s); }
```

- [ ] **Step 2: Commit（先存檔，下一個 task 才接上 app.js）**

```bash
git add renderer.js
git commit -m "feat: add DOM renderer for parsed data"
```

---

## Task 5: 串接 app.js — 檔案上傳到畫面渲染

**Files:**
- Modify: `app.js`

- [ ] **Step 1: 重寫 `app.js`（完整檔案）**

```js
// app.js
import { parseTrello } from './parser.js';
import { renderApp } from './renderer.js';
import { toCopyJson } from './exporter.js';

const fileInput = document.getElementById('file-input');
const uploadLabel = document.getElementById('upload-label');
const toolbar = document.getElementById('toolbar');
const banner = document.getElementById('banner');
const main = document.getElementById('main');
const toast = document.getElementById('toast');

let currentData = null;

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
    return showError('請上傳合法的 JSON 檔（副檔名 .json）');
  }

  try {
    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return showError('JSON 格式錯誤：' + err.message);
    }
    const data = parseTrello(raw);
    currentData = data;
    hideBanner();
    if (data.warnings.length) showWarning(data.warnings.join('；'));
    renderApp(data);
    toolbar.classList.remove('hidden');
    uploadLabel.textContent = '重新上傳';
    fileInput.value = ''; // 允許同一檔重複上傳觸發 change
  } catch (err) {
    showError(err.message || '解析失敗');
  }
});

document.getElementById('expand-all').addEventListener('click', () => {
  document.querySelectorAll('.card-item').forEach(c => c.classList.add('expanded'));
  document.querySelectorAll('.day-block').forEach(c => c.classList.remove('collapsed'));
  document.querySelectorAll('.extras-group').forEach(c => c.classList.remove('collapsed'));
});

document.getElementById('collapse-all').addEventListener('click', () => {
  document.querySelectorAll('.card-item').forEach(c => c.classList.remove('expanded'));
});

document.getElementById('copy-json').addEventListener('click', async () => {
  if (!currentData) return showToast('請先上傳 JSON');
  const includeExtras = document.getElementById('include-extras').checked;
  const text = toCopyJson(currentData, { includeExtras });
  const ok = await copyToClipboard(text);
  showToast(ok ? '已複製到剪貼簿' : '複製失敗，請改用 HTTPS 或手動複製');
});

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function showError(msg) {
  banner.className = 'max-w-5xl mx-auto mt-4 px-4 py-3 rounded text-sm bg-red-100 text-red-800 border border-red-300';
  banner.textContent = '⚠ ' + msg;
  banner.classList.remove('hidden');
}

function showWarning(msg) {
  banner.className = 'max-w-5xl mx-auto mt-4 px-4 py-3 rounded text-sm bg-yellow-100 text-yellow-800 border border-yellow-300';
  banner.textContent = '⚠ ' + msg;
  banner.classList.remove('hidden');
}

function hideBanner() {
  banner.classList.add('hidden');
  banner.textContent = '';
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000);
}
```

- [ ] **Step 2: 用真實檔案手動測試**

Run: `open index.html`

驗證清單：
- [ ] 上傳 `trello.json` 後 Header 標題變為「2026-06歐洲行」
- [ ] 看到多個日期區塊（6/18、6/19、6/20…），由小到大排序
- [ ] 每個區塊內有卡片，顯示標題；有 desc 的卡片有預覽行
- [ ] 點卡片可展開，展開後看到完整描述（Markdown 渲染）、地點、附件、標籤
- [ ] 點日期區塊頭可收合該天
- [ ] 點「全部展開」所有卡片同時展開
- [ ] 點「全部收合」所有卡片同時收合
- [ ] 頁面底部有「補充資訊」區，含「購物 / 餐廳 / 提前訂位 / 其他相關資訊」
- [ ] 補充資訊預設收起，點標題可展開
- [ ] 點「複製為 JSON」→ toast 顯示「已複製到剪貼簿」
- [ ] 把剪貼簿內容貼到文字編輯器：是合法 JSON，含 `trip`、`exported_at`、`days`、`extras`
- [ ] 取消勾選「包含補充資訊」再複製：JSON **不含** `extras` key
- [ ] 重新上傳同一個檔案能成功觸發更新

- [ ] **Step 3: 故意上傳壞檔測試錯誤處理**

- [ ] 上傳一個 `.txt` 檔 → 紅 banner「請上傳合法的 JSON 檔」
- [ ] 上傳一個內容為 `{not valid json` 的 .json → 紅 banner「JSON 格式錯誤：...」
- [ ] 上傳一個 `{"name":"x"}` 的 .json → 紅 banner「這不像是 Trello 匯出的板...」

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: wire up upload, render, copy flow"
```

---

## Task 6: 撰寫推廣型 README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: 撰寫 README（完整檔案）**

```markdown
# Trello → 旅行社風行程表 ✈️

> 把你那塊亂糟糟的 Trello 旅遊板，一鍵變成乾淨好讀的旅行社風格行程表，順便產出 AI 看得懂的結構化 JSON。

---

## 你是不是也這樣？

- 用 Trello 規劃旅行，**清單越開越多**：「6/18 維也納」、「6/19 維也納」、「購物」、「餐廳」、「提前訂位」…翻來翻去看不到全貌
- 想丟給 ChatGPT / Gemini **幫你分析行程**（時間夠嗎？順路嗎？要怎麼安排？）
  → 結果整片 Trello JSON 2 MB 起跳，AI 讀得吃力又會漏
- 想把行程**寄給家人或同行朋友**，但 Trello 介面不適合分享

**這個小工具就是為了解決這三件事而生。**

---

## 三大特色

### ✨ 一鍵 AI-Ready JSON
複製出來的 JSON 已經幫 AI 整理好：去除雜訊、依日期排序、欄位扁平。直接貼到 Gemini / ChatGPT 就能問「我這趟夠不夠時間」、「幫我加一天威尼斯怎麼排」。

### 🔒 純前端、不上傳
你的旅遊行程、住宿地址、訂房連結都是隱私。本工具**完全在你的瀏覽器執行**，沒有後端、沒有伺服器、沒有任何 telemetry。要驗證？打開 DevTools 看 Network 一片空白。

### 🎨 旅行社級排版
深綠 + 米白 + 暖橘，襯線字體大標題，預設精簡、想看細節再展開。比 Trello 原生介面好看 10 倍，也比 Notion 好整理。

---

## 怎麼用（30 秒）

1. **匯出 Trello JSON**
   進你的 Trello 板 → 右上「⋯」→ Print, export, and share → Export as JSON → 存檔
2. **打開本工具**
   雙擊 [`index.html`](./index.html)，或開啟線上版（見下方部署）
3. **上傳 → 看 → 複製**
   上傳剛剛存的 JSON → 行程瞬間排好 → 點「複製為 JSON」→ 貼到你愛的 LLM

---

## 本機跑

不用 install、不用 npm、不用任何工具。

```bash
git clone https://github.com/<your-name>/trello-to-table.git
cd trello-to-table
open index.html       # macOS
# 或 start index.html  # Windows
# 或直接拖進瀏覽器
```

---

## 部署到 Vercel（30 秒）

```bash
npm i -g vercel       # 第一次用 Vercel CLI
vercel                # 跟著問答，預設值即可
```

得到一個 `xxx.vercel.app` 網址，丟給朋友就能用。

---

## 為什麼用這個，不直接複製 Trello JSON 給 AI？

| | 直接貼 Trello JSON | 本工具的輸出 |
|---|---|---|
| 大小 | ~2 MB | ~10–50 KB |
| 雜訊 | actions / memberships / customFieldItems / nodeId 一堆 | 沒有 |
| 排序 | 沒有 | 按日期 |
| AI 理解難度 | 高（要先學 Trello schema） | 低（欄位名直白） |
| 隱私風險 | 把整塊 board metadata 都送出去 | 只送行程相關 |

---

## Roadmap（歡迎 PR）

- [ ] 支援多板合併
- [ ] 一鍵分享為唯讀連結（網址承載 JSON）
- [ ] 列印優化（A4 友善）
- [ ] 暗色模式
- [ ] 英文介面 i18n

---

## License

MIT — 自由使用、修改、商用、再散佈都歡迎。覺得好用就給個 ⭐！
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add promotional README"
```

---

## Task 7: 部署到 Vercel preview

**Files:** 無新檔，純部署

- [ ] **Step 1: 確認 Vercel CLI 已安裝**

Run: `vercel --version`
Expected: 輸出版本號（如 `32.x`）。若沒有：`npm i -g vercel`。

- [ ] **Step 2: 在專案目錄執行 link + deploy**

Run（在 `/Users/rain_lin/Documents/ASUS/Project/Personal/trello-to-table`）：

```bash
vercel
```

依提示回答：
- Set up and deploy? **Y**
- Which scope? 選個人帳號
- Link to existing project? **N**
- Project name? **trello-to-table**（接受預設）
- In which directory is your code? **./**
- Want to override settings? **N**

Expected: 部署完成後輸出 `https://trello-to-table-xxx.vercel.app`。

- [ ] **Step 3: 把網址貼給使用者並請他驗證**

開瀏覽器打開該網址，上傳 `trello.json`，確認行為與本機一致。

- [ ] **Step 4: 不要 push to prod**

除非使用者明確說要 production，否則停在 preview 即可。

---

## 完成檢查

- [ ] 所有 7 個 task 完成
- [ ] `tests.html` 全部測試通過（16 pass / 0 fail）
- [ ] 真實 `trello.json` 上傳後行為符合預期
- [ ] 錯誤處理三種情境都有正確 banner
- [ ] README.md 已寫
- [ ] Vercel preview URL 已交付使用者
