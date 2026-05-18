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
   進你的 Trello 板 → 右上「⋯」(Show menu) → More → Print, export, and share → Export as JSON → 存檔
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

# 方法一：用 Python 內建 server（推薦，因 ES module 需要 http://）
python3 -m http.server 8000
# 然後開 http://localhost:8000

# 方法二：直接拖進瀏覽器（部分瀏覽器擋 ES module file://，建議用方法一）
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

### 輸出範例

```json
{
  "trip": "2026-06歐洲行",
  "exported_at": "2026-05-18T12:00:00.000Z",
  "days": [
    {
      "list_name": "6/18 (四) 維也納",
      "date": "6/18",
      "items": [
        {
          "title": "聖史蒂芬大教堂",
          "desc": "## 開放時間\n週一–六 06:00–22:00\n週日 07:00–22:00",
          "place": "Stephansdom, Vienna",
          "labels": [{ "color": "green", "name": "必去" }],
          "attachments": [
            { "url": "https://www.stephanskirche.at", "name": "官網" }
          ]
        }
      ]
    }
  ],
  "extras": {
    "餐廳": [...],
    "購物": [...]
  }
}
```

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
