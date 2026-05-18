# GCP VM 部署步驟

把以下指令依序貼到 VM 跑（你的 VM：`35.238.52.132`，Debian 12 bookworm）。

---

## 0. 前置：DNS 與防火牆

1. 在你的 DNS 設定加 A record：
   ```
   travel.taiwanno1.cc  →  35.238.52.132
   ```
2. GCP Console → VPC network → Firewall → 確認 `80`, `443` port 對 `0.0.0.0/0` 開放。

---

## 1. SSH 上 VM，安裝 Node 22 + 工具

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git build-essential

# Node.js 22 (LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node --version   # 應顯示 v22.x
npm --version
```

## 2. 安裝 Caddy（自動處理 HTTPS）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 3. 建立專用使用者並 clone 程式碼

```bash
sudo useradd -r -m -d /opt/trello-to-table -s /bin/bash trello
sudo -u trello git clone https://github.com/<YOUR_USERNAME>/trello-to-table.git /opt/trello-to-table
cd /opt/trello-to-table/server
sudo -u trello npm install --omit=dev
```

> **把 `<YOUR_USERNAME>` 換成你 GitHub 帳號**。若 repo 尚未 push，先 push 上去。

## 4. 設定環境變數

> ⚠️ 請把下面 `<...>` 三個值替換成你的真實設定再貼指令。

```bash
sudo tee /etc/trello-to-table.env > /dev/null <<EOF
PORT=5566
API_PASSWORD=<你的密碼，長一點，避免被掃>
GOOGLE_MAPS_KEY=<Google Cloud Console 產的 Maps Embed API key>
DATA_DIR=/var/lib/trello-to-table
STATIC_DIR=/opt/trello-to-table
EOF
sudo chmod 600 /etc/trello-to-table.env
```

**Google Maps key 安全設定**（必做）：
- Application restrictions → **Websites** → 加 `https://travel.taiwanno1.cc/*`
- API restrictions → 只勾 **Maps Embed API**

建立資料目錄：

```bash
sudo mkdir -p /var/lib/trello-to-table
sudo chown trello:trello /var/lib/trello-to-table
```

## 5. 啟動 API（systemd）

```bash
sudo cp /opt/trello-to-table/server/trello-to-table.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trello-to-table

# 驗證
sudo systemctl status trello-to-table --no-pager
curl http://127.0.0.1:5566/api/ping
# 預期: {"ok":true}
```

如果出錯看 log：

```bash
sudo journalctl -u trello-to-table -n 50 --no-pager
```

## 6. 設定 Caddy 反代 + HTTPS

```bash
sudo cp /opt/trello-to-table/server/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 驗證
curl -I https://travel.taiwanno1.cc
# 預期: HTTP/2 200 (Caddy 第一次會花 5-30 秒申請憑證)
```

如果 Caddy 出錯：

```bash
sudo journalctl -u caddy -n 50 --no-pager
```

## 7. 開瀏覽器測試

開 `https://travel.taiwanno1.cc`：

1. 應該看到行程表前端
2. 第一次會跳出輸入「API 密碼」對話框 → 貼你在 `/etc/trello-to-table.env` 設的 `API_PASSWORD`
3. 上傳一份 Trello JSON
4. 換手機開同一個網址 → 也輸入一次密碼 → 應該看到同一份行程

---

## 之後更新程式碼

```bash
cd /opt/trello-to-table
sudo -u trello git pull
cd server
sudo -u trello npm install --omit=dev
sudo systemctl restart trello-to-table
```

## 備份 DB

```bash
# 用 SQLite 的 .backup（線上熱備份，不會鎖庫）
sudo -u trello sqlite3 /var/lib/trello-to-table/app.db ".backup '/tmp/app-backup-$(date +%Y%m%d).db'"
```

## 關閉 / 維護

```bash
sudo systemctl stop trello-to-table   # 停
sudo systemctl start trello-to-table  # 開
sudo systemctl restart trello-to-table # 重啟
```
