# Civatas — 開發路線圖 (Development Roadmap)

## 目前狀態

所有 9 個服務的骨架已建立，包含：
- ✅ Docker Compose 定義（9 個服務）
- ✅ 共用 Pydantic schema（ProjectConfig, Person, TwitterAgent, RedditAgent）
- ✅ i18n 翻譯檔（zh-TW, en）與 Python/TS helper
- ✅ Layer 1 Ingestion：可解析 CSV/JSON/Excel → ProjectConfig
- ✅ Layer 2 Synthesis：加權抽樣生成 Person list
- ✅ Layer 3 Persona：規則模板 + LLM + 混合三種策略
- ✅ Layer 4 Social：Homophily-weighted follow graph 生成
- ✅ Layer 5 Adapter：輸出 OASIS Twitter CSV / Reddit JSON
- ✅ Layer 6 Simulation：stub（待接 OASIS）
- ✅ Layer 7 Analytics：讀取 OASIS .db 的 interview 紀錄
- ✅ API Gateway：串接所有下游的 pipeline 路由
- ✅ Web UI：Next.js 骨架 + 首頁導覽

---

## Phase 0：前置驗證（優先）

### 0-1 驗證 OASIS 可執行
- [ ] 在 Docker 或本機安裝 OASIS 及 camel-ai
- [ ] 用 `source/oasis/examples/twitter_interview.py` 跑通完整流程
- [ ] 確認 INTERVIEW 結果可從 .db 的 trace 表讀取
- [ ] 記錄 OASIS 的 Python 版本與依賴需求

### 0-2 確認 LLM 後端
- [ ] 確認 OpenAI API key 可用
- [ ] 測試 persona 服務的 LLM 生成（單筆）
- [ ] 評估批量生成 1000/5000 agents 的 token 成本

### 0-3 Docker Compose 首次啟動
- [ ] `cp .env.example .env` 並填入 LLM_API_KEY
- [ ] `docker compose up --build`
- [ ] 確認所有 /health 端點回傳 200

---

## Phase 1：核心流程打通（M1）

### 1-1 Ingestion 完善
- [ ] 測試各種格式上傳（CSV、JSON、Excel）
- [ ] 支援使用者直接上傳符合 ProjectConfig 格式的 JSON
- [ ] 支援「一維一檔」模式（使用者分多個檔案上傳不同維度）
- [ ] 加入更完善的錯誤訊息（缺欄位、格式錯誤等）

### 1-2 Synthesis 強化
- [ ] 實作交叉關聯（cross_correlations）的加權修正
- [ ] 可選：引入 IPF（Iterative Proportional Fitting）
- [ ] 加入分布驗證模組：卡方檢定 / KL divergence
- [ ] 輸出分布對比報告（輸入 vs 輸出）

### 1-3 Persona 強化
- [ ] 改進規則模板：處理空欄位不出現亂碼
- [ ] LLM 批次生成：加入 concurrent 處理、失敗重試
- [ ] 加入姓名生成器（依地區/語系）
- [ ] 支援使用者在 UI 上即時預覽 & 編輯 persona

### 1-4 Adapter 驗證
- [ ] 用 OASIS 的 `pd.read_csv()` 實際測試輸出的 CSV
- [ ] 確認 `following_agentid_list` 和 `previous_tweets` 欄位格式正確
- [ ] 用 OASIS 的 `generate_twitter_agent_graph()` 實際載入測試

---

## Phase 2：端到端模擬（M2）

### 2-1 Simulation 服務接入 OASIS
- [ ] 在 simulation 容器中安裝 OASIS
- [ ] 實作 `runner.py`：
  1. 讀取 agent CSV/JSON
  2. 建立 AgentGraph（`generate_twitter_agent_graph` 或 `generate_reddit_agent_graph`）
  3. 建立 OasisEnv
  4. 執行 N 輪互動步驟（LLMAction）
  5. 執行 INTERVIEW（ManualAction + ActionType.INTERVIEW）
  6. 回傳 .db 路徑
- [ ] 支援背景執行（長時間模擬）
- [ ] 回報進度（幾輪完成、幾個 agent 已訪談）

### 2-2 Analytics 服務完善
- [ ] 實作回答分類（支持候選人 A / B / 未決定 / 拒答）
- [ ] 支援自訂分類規則（關鍵字 / LLM 分類）
- [ ] 實作分群分析（按 age, gender, district, party_lean）
- [ ] 輸出 CSV 報表

---

## Phase 3：Web UI 完整化（M3-M5）

### 3-1 專案管理頁
- [ ] 建立/刪除/複製專案
- [ ] 專案持久化（file-based JSON 或 SQLite）
- [ ] 專案狀態追蹤

### 3-2 上傳頁
- [ ] 拖放上傳元件
- [ ] 上傳後即時預覽（表格 + 圖表）
- [ ] 驗證結果顯示（錯誤/警告）
- [ ] 支援選擇內建範本

### 3-3 人口合成頁
- [ ] 設定生成數量
- [ ] 選擇合成方法（加權抽樣 / IPF）
- [ ] 生成後顯示分布對比圖表
- [ ] 下載中介 persons.csv

### 3-4 Persona 頁
- [ ] 選擇策略（規則/LLM/混合）
- [ ] 模板編輯器（即時預覽）
- [ ] LLM prompt 編輯器
- [ ] 生成進度顯示
- [ ] 結果表格（可搜尋、篩選、單筆重新生成）

### 3-5 匯出頁
- [ ] 選擇格式（Twitter CSV / Reddit JSON）
- [ ] 預覽前 N 筆
- [ ] 下載按鈕

### 3-6 模擬頁
- [ ] 選擇平台（Twitter/Reddit）
- [ ] 設定 LLM model、步數、並行數
- [ ] 編輯 INTERVIEW prompts
- [ ] 啟動模擬 + 進度顯示
- [ ] 完成後連結到分析頁

### 3-7 分析頁
- [ ] 總體結果儀表板
- [ ] 分群切換（地區/年齡/性別/政黨）
- [ ] 圖表（長條圖、圓餅圖）
- [ ] 匯出 CSV / PDF

### 3-8 i18n 完整
- [ ] 語言切換元件
- [ ] 所有頁面使用翻譯 key
- [ ] 確認 en / zh-TW 翻譯完整

---

## Phase 4：進階功能（M6-M7）

### 4-1 社交圖譜視覺化
- [ ] 用 D3.js 或 vis.js 顯示 follow 網路
- [ ] 可互動（縮放、點選節點看 persona）

### 4-2 內建範本庫
- [ ] 台灣各縣市人口統計範本
- [ ] 美國各州範本
- [ ] 其他國家（可由社群貢獻）

### 4-3 多輪模擬
- [ ] 注入多輪事件（初始貼文 → 回應 → 再回應）
- [ ] 輿情擴散追蹤

### 4-4 部署
- [ ] Docker Compose 生產設定（nginx reverse proxy）
- [ ] 環境變數管理
- [ ] 日誌收集

---

## 里程碑

| 里程碑 | 內容 | 預估工作量 |
|--------|------|-----------|
| M0 | OASIS 跑通 + Docker Compose 首次啟動 | 1-2 天 |
| M1 | 核心流程打通（上傳→合成→persona→匯出 CSV） | 3-5 天 |
| M2 | 首次端到端模擬成功 | 2-3 天 |
| M3 | 結果分析 + 基礎報表 | 2-3 天 |
| M4 | Web UI 上傳 + 設定 + 預覽 | 3-5 天 |
| M5 | Web UI 模擬執行 + 結果展示 | 3-5 天 |
| M6 | 社交圖譜 + 範本庫 | 3-5 天 |
| M7 | 部署 + 多語言完善 | 2-3 天 |
