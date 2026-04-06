# 🚴 團課小幫手

健身工廠**飛輪**與**拳擊有氧**課表查詢 PWA，支援全台所有分店，可加到手機桌面像 APP 一樣使用。

---

## 功能

- 查詢健身工廠全台分店課表
- 篩選飛輪課程 / 拳擊有氧 / 全部
- 課表按星期分組顯示
- 資料快取 4 小時，避免重複抓取
- PWA：可加到手機桌面

---

## 安裝步驟

### 1. 安裝 Node.js

前往 [nodejs.org](https://nodejs.org) 下載安裝（建議 LTS 版本）

### 2. 進入專案資料夾

```bash
cd path/to/group-class-assistant
```

### 3. 安裝套件

```bash
npm install
```

> 注意：Puppeteer 會自動下載 Chromium（約 170MB），首次安裝需要較長時間，請耐心等待。

### 4. 啟動伺服器

```bash
npm start
```

### 5. 開啟瀏覽器

前往 [http://localhost:3002](http://localhost:3002)

---

## 在手機上使用（加到桌面）

### Android（Chrome）
1. 用手機 Chrome 開啟 `http://電腦IP:3002`
2. 點選右上角選單 `⋮`
3. 點選「**加入主畫面**」

### iPhone（Safari）
1. 用 Safari 開啟 `http://電腦IP:3002`
2. 點選下方「**分享**」按鈕 ↑
3. 選擇「**加入主畫面**」

> 查詢電腦 IP：在終端機執行 `ipconfig`，找 IPv4 位址（如 192.168.1.100）
> 手機與電腦需在同一 WiFi

---

## 技術說明

### 爬蟲機制

本專案使用 **Puppeteer** 模擬瀏覽器操作，抓取健身工廠官網動態載入的課表。

爬蟲流程：
1. 開啟無頭瀏覽器，前往課表頁面
2. 選擇分店、課程類型
3. 攔截 API 回應（若有）或解析渲染後的 HTML
4. 結果快取 4 小時

> **注意**：健身工廠官網結構可能不定期更新，若課表無法正常顯示，可能需要調整 `scraper.js` 中的選擇器設定。

### 快取策略

| 資料 | 快取時間 |
|------|----------|
| 分店清單 | 24 小時 |
| 課表資料 | 4 小時 |

---

## 停止伺服器

在終端機按 `Ctrl + C`

---

## 檔案結構

```
group-class-assistant/
├── server.js        # Express 後端
├── scraper.js       # Puppeteer 爬蟲
├── cache.js         # 記憶體快取
├── package.json
├── public/
│   ├── index.html   # PWA 主頁面
│   ├── manifest.json  # PWA 設定
│   └── sw.js        # Service Worker（離線支援）
└── README.md
```
