# Trello → Travel ✈️

> 把 Trello 旅遊板變成可編輯、可拖曳、附 AI 導遊、附地圖、可備份匯入的「**個人旅遊管理系統**」。
> 多裝置同步、純自架、資料在你自己的 GCP VM。

---

## 你是不是也這樣？

- 用 Trello 規劃旅行，**清單越開越多**：每一天一個清單、購物餐廳訂房又一堆，翻來翻去看不到全貌
- 想丟給 ChatGPT / Gemini **幫你分析行程**（時間夠嗎？順路嗎？怎麼安排？）→ 整片 Trello JSON 2 MB 起跳，AI 讀得吃力又會漏
- 想知道**每個景點怎麼玩**：開放時間、必看、注意事項——上網一個個查太累
- 想要**自由編輯、拖曳順序、加新行程、加照片**——但 Trello 介面對旅遊規劃不夠優雅
- 想**換手機也看得到同一份行程**——但 localStorage 留不下

**這個工具就是為了解決這些事而生。**

---

## 主要功能

### 📋 行程顯示
- 🗓️ **垂直時間軸**（每天區塊 + 卡片），自動依時間軸排序
- 🎨 卡片**按類型上色**：景點 / 餐廳 / 住宿 / 交通 / 購物 / 票券
- 📍 自動偵測標題裡的時間（`14:30 進飯店` → 在卡片左側顯示時間）
- 🔢 卡片左上**對應地圖編號**徽章
- 🖼️ 圖片附件當卡片**封面縮圖**，點擊放大 lightbox

### 🗺️ 每日地圖（Leaflet + OpenStreetMap）
- 自動 geocode 每個景點，**marker 含編號 + 中文標題**
- **景點 chips**（地圖上方）點擊飛到該 marker
- 虛線標示路線順序
- 「在 Google Maps 開啟 ↗」一鍵跳轉看即時路況
- 完全免 API key、永久免費

### 🎙️ AI 導遊（MiniMax）
- 展開卡片自動產生**繁中導覽**：故事 / 必看 / 注意 / 在地訣竅
- **依類型客製 prompt**（景點重歷史、餐廳重必點、住宿重設施）
- **依旅人偏好調整風格**（在設定頁填）
- 結果**永久 cache 在 DB**，切換板再回來不會重打 token

### 💬 景點問答
- 每張卡片下方 **「問問題」** 區，AI 帶當天行程脈絡回答
- **一般回覆** vs **✨ 最新資訊**（Tavily 上網搜尋整理）
- 答案 cache，可單筆刪除

### ✏️ 編輯 / 新增 / 排序
- 卡片 hover **✏️ 編輯**、自訂卡 **🗑 刪除**、Trello 卡 **× 隱藏**（可從設定還原）
- 每天頂部 **「+ 新增行程」**，**先建草稿可邊填邊上傳附件**
- **拖曳 `⋮⋮`**：同日或跨日重排卡片、整天順序也能調換

### 📎 附件
- 拖檔案到 modal dropzone（或點選）→ 上傳
- **sharp 自動縮圖**：300px / 800px / 原圖三檔
- 圖片在卡片內當縮圖牆，點擊放大 lightbox、下載原檔
- 非圖片附件（PDF / Word / ZIP …）顯示為下載連結
- 任一張圖可設為**封面**（⭐ 按鈕）
- 上限：單檔 10 MB、每卡片 20 張圖 / 30 個檔，總配額 5 GB
- **磁碟空間防呆**：剩 < 500 MB 自動拒絕上傳並提示

### 📦 一鍵備份 / 匯入
- 每份行程可**匯出為 ZIP**（含所有資料庫 row + 上傳檔案 + AI cache）
- 上傳 ZIP 即可在另一台機器**完整還原**
- 衝突自動換新 ID + 改名「(匯入 2)」

### 🔐 密碼保護 + 多裝置同步
- 後端 API 用 `API_PASSWORD` 統一驗證
- 第一次輸入後存 localStorage，下次自動帶
- 同一網址在手機、平板、電腦登入 → 看到**完全一樣的資料**

### 🤖 AI-Ready JSON 匯出
- 點「複製為 JSON」→ 把整份行程**乾淨格式化**到剪貼簿，直接貼給 Gemini 分析
- 比直接貼 Trello JSON 小 100 倍、結構也更利於 LLM 理解

---

## 架構

```
瀏覽器 ──HTTPS──► Caddy (auto Let's Encrypt)
                    │
                    └─ http://127.0.0.1:5566 (Hono + Node 22)
                        │
                        ├─ SQLite (boards / custom_items / overrides /
                        │           orders / hidden / settings /
                        │           guide_cache / place_cache / qa /
                        │           attachments / geocode_cache)
                        ├─ uploads/ (sharp-resized images + originals)
                        ├─ MiniMax M2.7 (AI 嚮導 + 問答)
                        ├─ Tavily (可選，網路最新搜尋)
                        └─ Nominatim + Photon (geocode，無 key)
```

**100% 自架**：沒有第三方追蹤、沒有任何外部資料庫；只有 LLM / search / geocode 是必要的外部呼叫，全部由後端 proxy（前端拿不到 API key）。

---

## 三大特色

### 🔒 純自架、零外部資料庫
你的旅遊行程、住宿地址、訂房連結、上傳照片都存在**你自己的 VM SQLite**。要驗證？打開 DevTools 看 Network 沒任何第三方追蹤。

### 🎨 旅行社級排版 + 不輸 Notion 的編輯體驗
深綠 + 米白 + 暖橘，襯線字體大標題，預設精簡、想看細節再展開。垂直時間軸 + 地圖 + AI 導遊 + 拖曳——比 Trello 直覺、比 Notion 輕量。

### ✨ AI-Ready
複製 JSON 一鍵丟給 Gemini / ChatGPT 分析；卡片內建 AI 導遊隨時可問；可選 Tavily web search 拿最新資訊。

---

## 怎麼用（使用者視角）

### 1. 匯出 Trello JSON
進你的 Trello 板 → 右上「⋯」(Show menu) → More → Print, export, and share → **Export as JSON** → 存檔

### 2. 打開網站
連到你部署的網址（例：`https://travel.your-domain.com`），輸入密碼

### 3. 開始用
- **左側 sidebar**「+ 新增」→ 拖 JSON 進來
- 每張卡片可編輯、加照片、加附件
- 展開卡片看 AI 導遊、問問題
- 拖曳調整順序
- 想分享給朋友：點「📦 匯出」拿 ZIP

---

## 部署到自己的 VM

### 需要

- 一台 Linux VM（Ubuntu / Debian 都行）—— 我用 GCP e2-micro（free tier）
- 一個網域，A record 指到 VM IP（建議；不然只能 http 直連）
- Node.js 22（建議用 nvm）
- MiniMax API key（[platform.minimax.io](https://platform.minimax.io)，Starter $10/月起）
- 可選：Tavily API key（[tavily.com](https://tavily.com)，1000 次/月免費）

### 一鍵啟動腳本

repo 內 `server/start.sh`：

```bash
git clone https://github.com/<你的帳號>/trello-to-travel.git
cd trello-to-travel/server
cp .env.example .env
nano .env   # 填 API_PASSWORD、MINIMAX_API_KEY、TAVILY_API_KEY
./start.sh -d
```

加 Caddy 反代 → HTTPS：repo 內 `server/SETUP.md` 有完整步驟。

### 環境變數

```env
PORT=5566
API_PASSWORD=<你的密碼，建議 16 字以上隨機>
MINIMAX_API_KEY=<MiniMax token>
MINIMAX_MODEL=MiniMax-M2.7
TAVILY_API_KEY=<可選>
DATA_DIR=/var/lib/trello-to-travel
LLM_TIMEOUT_MS=60000
```

---

## 為什麼用這個，不直接複製 Trello JSON 給 AI？

| | 直接貼 Trello JSON | 本工具的輸出 |
|---|---|---|
| 大小 | ~2 MB | ~10–50 KB |
| 雜訊 | actions / memberships / customFieldItems 一堆 | 沒有 |
| 排序 | 沒有 | 按日期、可手動拖曳 |
| AI 理解難度 | 高 | 低 |
| 隱私風險 | 整塊 board metadata 都送出去 | 只送行程相關 |
| 編輯 | 必須回 Trello | 直接編輯，AI 導遊現場跑 |

---

## Roadmap

- [ ] 行程匯出 PDF / 列印優化（A4 友善）
- [ ] PWA（手機加到主畫面、離線可看）
- [ ] 行程公開唯讀連結（給朋友看不能改）
- [ ] 多人協作（共同編輯）
- [ ] 暗色模式
- [ ] 英文介面 i18n

---

## License

MIT — 自由使用、修改、商用、再散佈都歡迎。覺得好用就給個 ⭐！

---

## 致謝

- [Hono](https://hono.dev/) — 輕量快速的 web framework
- [Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/) + [CartoDB](https://carto.com/) — 免費好用的地圖
- [Nominatim](https://nominatim.openstreetmap.org/) + [Photon](https://photon.komoot.io/) — 開源 geocoding
- [MiniMax](https://platform.minimax.io) — AI 導遊與問答
- [Tavily](https://tavily.com) — 給 LLM 用的 web search
- [SortableJS](https://sortablejs.github.io/Sortable/) — 拖曳排序
- [sharp](https://sharp.pixelplumbing.com/) — 圖片縮圖
- [Caddy](https://caddyserver.com/) — 自動 HTTPS
