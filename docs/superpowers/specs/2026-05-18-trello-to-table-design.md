# Trello → 旅行社風行程表 Web App

**日期**：2026-05-18
**狀態**：Design approved, pending spec review

---

## 1. 目的

把 Trello 匯出的 JSON（旅遊行程板）轉成乾淨的「旅行社風格」網頁行程表，並能一鍵複製出**結構化 JSON** 給 Gemini 等 LLM 進行行程分析。

### 核心使用情境
1. 使用者把 Trello 板（如「2026-06歐洲行」）匯出 JSON
2. 上傳到本網頁 → 立即看到按日排序的行程
3. 想看細節時點開卡片
4. 想丟給 AI 分析時，點「複製為 JSON」→ 貼到 Gemini

---

## 2. 設計原則

- **乾淨優先**：預設只顯示標題、地點、描述第一行；細節展開才看
- **不漏資料**：複製 JSON 時保留 Trello 卡片所有有意義的欄位（標題、描述、地點、附件、標籤）
- **隱私至上**：純前端，JSON 在瀏覽器解析，**不上傳任何資料**
- **零負擔**：無 build step、無依賴管理、直接 deploy

---

## 3. 技術棧

| 項目 | 選擇 |
|---|---|
| 結構 | HTML5 單檔 |
| 樣式 | Tailwind CSS（CDN）+ 自訂 `style.css` |
| 邏輯 | Vanilla JS（ES2020+）|
| Markdown 渲染 | `marked` (CDN) |
| 字體 | Google Fonts — Noto Serif TC（標題）、Noto Sans TC（內文） |
| 部署 | Vercel preview |

---

## 4. UI 結構

### 4.1 頁面區塊（由上到下）

```
┌───────────────────────────────────────────────┐
│ Header                                         │
│   行程名稱（從 board.name 帶入，未上傳時顯示應用名）│
│   [上傳 / 重新上傳 JSON]                        │
├───────────────────────────────────────────────┤
│ Toolbar                                        │
│   [全部展開] [全部收合] [複製為 JSON ▼]         │
│                          └ ☑ 包含補充資訊       │
├───────────────────────────────────────────────┤
│ 行程主區（按日期排序）                          │
│   ┌─────────────────────────────────────────┐ │
│   │ 6/18 (四) 維也納       ▾                │ │
│   │ ─────────────────────────────────────── │ │
│   │ • 卡片標題                              │ │
│   │   描述第一行預覽…                       │ │
│   │   ─ 展開後 ─                            │ │
│   │   完整 Markdown 描述                     │ │
│   │   📍 地點名稱                            │ │
│   │   🔗 附件連結 ×N                         │ │
│   │   🏷️ 標籤 ×N                            │ │
│   │ • …                                     │ │
│   └─────────────────────────────────────────┘ │
│   （每一天一個區塊）                            │
├───────────────────────────────────────────────┤
│ 補充資訊（預設收起、可展開）                     │
│   ▸ 購物                                       │
│   ▸ 餐廳                                       │
│   ▸ 提前訂位                                   │
│   ▸ 其他相關資訊                                │
└───────────────────────────────────────────────┘
```

### 4.2 視覺風格（旅行社感）

| 元素 | 規格 |
|---|---|
| 背景 | 米白 `#FAFAF7` |
| 主色 | 深綠 `#2D5A4E`（標題、按鈕） |
| Accent | 暖橘 `#E07856`（hover、強調） |
| 卡片底 | 純白 `#FFFFFF`，圓角 12px，陰影 `0 1px 3px rgba(0,0,0,.06)` |
| 日期區塊頭 | 主色色條 + 襯線字體大標題 |
| 字體 | 標題 `Noto Serif TC`；內文 `Noto Sans TC` |
| 動畫 | 展開/收合 `transition: max-height .25s ease, opacity .25s` |

### 4.3 互動

| 行為 | 結果 |
|---|---|
| 點卡片標題列 | 展開/收合該張卡片的詳細區 |
| 點「全部展開」 | 所有卡片同時展開 |
| 點「全部收合」 | 所有卡片同時收合 |
| 勾選「包含補充資訊」 | 影響「複製為 JSON」的輸出範圍 |
| 點「複製為 JSON」 | 寫入剪貼簿 + 顯示 toast「已複製」 |
| 點日期區塊頭 | 收合/展開該日所有卡片（整區） |

---

## 5. 資料處理邏輯

### 5.1 解析步驟

1. `FileReader` 讀檔 → `JSON.parse`
2. 驗證必要欄位：`name`、`cards`、`lists`；缺一就報錯
3. 過濾 `lists.filter(l => !l.closed)`、`cards.filter(c => !c.closed)`
4. 分類 lists：
   - **日期清單**：`name` 開頭符合 regex `/^(\d{1,2})\/(\d{1,2})/`
   - **補充清單**：其餘
5. 日期清單按擷取的 `(month, day)` 排序（月→日）
6. 每個 list 的 cards 按 `pos` 升冪排序
7. 建立 `cards` lookup（用 `idList` 分群）

### 5.2 卡片渲染欄位來源

| 顯示欄位 | Trello 欄位 |
|---|---|
| 標題 | `card.name` |
| 描述預覽（第一行） | `card.desc` 第一個非空行（去掉 markdown 符號）|
| 完整描述 | `card.desc`（用 marked 渲染為 HTML） |
| 地點 | `card.locationName` 優先；無則 `card.address` |
| 附件 | `card.attachments[].url` + `.name` |
| 標籤 | `card.labels[].color` + `.name`（顯示為色塊） |

### 5.3 複製用 JSON 結構

```json
{
  "trip": "2026-06歐洲行",
  "exported_at": "2026-05-18T...Z",
  "days": [
    {
      "list_name": "6/18 (四) 維也納",
      "date": "6/18",
      "items": [
        {
          "title": "...",
          "desc": "...",
          "place": "...",
          "labels": [{"color": "green", "name": "必去"}],
          "attachments": [{"name": "...", "url": "https://..."}]
        }
      ]
    }
  ],
  "extras": {
    "購物": [ /* 同 items 結構 */ ],
    "餐廳": [ ... ],
    "提前訂位": [ ... ],
    "其他相關資訊": [ ... ]
  }
}
```

- **未勾選「包含補充資訊」**：輸出物件**不含** `extras` key
- 空欄位（如沒有 `place`）：直接省略該 key，保持輸出乾淨
- `desc` 保留原始 Markdown 文字（LLM 能讀懂）

---

## 6. 錯誤處理

| 情境 | 行為 |
|---|---|
| 非 JSON 檔 | 紅色 banner：「請上傳合法的 JSON 檔」 |
| JSON parse 失敗 | 紅色 banner：「JSON 格式錯誤：<訊息>」 |
| 缺 `cards` 或 `lists` 欄位 | 紅色 banner：「這不像是 Trello 匯出的板」 |
| 沒有任何日期清單 | 黃色 banner：「未偵測到日期清單，僅顯示補充資訊」 |
| 剪貼簿 API 不可用（HTTP 環境） | toast：「請改用 HTTPS 或手動複製」 + 彈出 textarea |

---

## 7. 檔案結構

```
trello-to-table/
├── index.html              主頁面（含 Tailwind CDN、字體、marked CDN）
├── app.js                  解析 + 渲染 + 複製 + 互動邏輯
├── style.css               自訂樣式（補 Tailwind 不足）
├── README.md               推廣型說明文件（後寫）
├── trello.json             範例資料（不變動）
└── docs/superpowers/specs/
    └── 2026-05-18-trello-to-table-design.md
```

---

## 8. 模組職責（app.js 內部）

| 模組 | 職責 |
|---|---|
| `parseTrello(json)` | 驗證 + 分類 lists + 排序 + 回傳 `{trip, days, extras}` |
| `renderApp(data)` | 把資料畫到頁面 |
| `renderDay(day)` | 畫單日區塊 |
| `renderCard(item)` | 畫單張卡片（含收合/展開兩態） |
| `renderExtras(extras)` | 畫補充資訊區 |
| `toCopyJson(data, includeExtras)` | 產生最終要複製的 JSON 物件 |
| `copyToClipboard(text)` | 寫入剪貼簿，含 fallback |
| `bindToolbar()` | 全展開、全收合、複製按鈕的事件 |
| `showToast(msg)` | 通用提示 |
| `showError(msg)` | 紅色錯誤 banner |

---

## 9. README（推廣型）大綱

實作完成後另寫，預定章節：

1. **一句話介紹** — 「把 Trello 行程板變成 AI 看得懂的乾淨行程表」
2. **痛點** — Trello 排程亂、想丟給 ChatGPT/Gemini 分析卻整片貼不進、人類看也累
3. **解決方案 / Demo 截圖**
4. **三大特色** — ✨ 一鍵 AI-ready JSON / 🔒 純前端不上傳 / 🎨 旅行社級排版
5. **使用方式（3 步驟）**
6. **本機跑** — 雙擊 `index.html` 就好
7. **部署到 Vercel** — `vercel` 一鍵
8. **未來規劃 / 歡迎 PR**
9. **授權 MIT**

---

## 10. Non-goals（YAGNI）

明確**不做**的事，避免範圍蔓延：

- ❌ 雙向同步回 Trello
- ❌ 編輯卡片內容
- ❌ 後端 / 帳號 / 登入
- ❌ localStorage 自動記憶（每次重新上傳）
- ❌ 多板對比
- ❌ 列印 / PDF 匯出（瀏覽器本身已可印）
- ❌ i18n（介面預設中文，受眾以使用者本人 + 中文使用者為主）
