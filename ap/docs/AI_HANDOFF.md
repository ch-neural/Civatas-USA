# Civatas — AI 接手指南 (AI Handoff Context)

本文件為提供給接手 AI 助手（如 Google Antigravity 或其他 AI 開發工具）的完整上下文摘要。

---

## 專案一句話

Civatas 讓使用者上傳真實人口統計，生成符合比例的 AI agents，接入 OASIS 做社會模擬（如選舉民調）。

---

## 當前進度

### 已完成
- [x] 9 個 Docker 服務的完整骨架（Dockerfile + requirements.txt + FastAPI app）
- [x] 共用 Pydantic schema（ProjectConfig, Person, TwitterAgent, RedditAgent）
- [x] i18n 多國語架構（zh-TW, en）+ Python/TS helper
- [x] Layer 1 Ingestion：CSV/JSON/Excel 解析 → ProjectConfig
- [x] Layer 2 Synthesis：加權抽樣 → Person list
- [x] Layer 3 Persona：規則模板 + LLM + 混合策略
- [x] Layer 4 Social：Homophily-weighted follow graph
- [x] Layer 5 Adapter：輸出 OASIS Twitter CSV / Reddit JSON
- [x] Layer 6 Simulation：stub（框架在，邏輯待實作）
- [x] Layer 7 Analytics：讀取 OASIS .db 的 interview 紀錄
- [x] API Gateway：串接所有下游的 pipeline 路由
- [x] Web UI：Next.js 骨架 + 首頁導覽
- [x] docker-compose.yml
- [x] README.md
- [x] 完整文件（5 份 docs/）

### 待完成（依優先順序）
1. **Phase 0**：驗證 OASIS 可執行、Docker Compose 首次啟動
2. **Phase 1**：核心流程打通（上傳→合成→persona→匯出可用的 OASIS CSV）
3. **Phase 2**：simulation 服務實際接入 OASIS
4. **Phase 3**：Web UI 各頁面實作
5. **Phase 4**：進階功能（範本庫、視覺化、部署）

詳見 `docs/DEVELOPMENT_ROADMAP.md`

---

## 關鍵設計決策（已做的）

| 決策 | 選擇 | 理由 |
|------|------|------|
| 架構 | 微服務（每層一個 Docker） | 使用者要求 |
| 前端 | Next.js 14 | 通用、生態好 |
| 後端 | FastAPI | Python 生態與 OASIS 一致 |
| 人口合成 | 自行實作加權抽樣 | MVP 先輕量，後續可接 PopulationSim |
| Persona | 規則模板 + LLM 雙軌 | 成本彈性 |
| i18n | JSON 翻譯檔 | 簡單、跨 Python/TS |
| 語系 | 預設 zh-TW + en | 使用者要求 |
| Docker profile | 預設 6 服務 / full 9 服務 | social/simulation/analytics 可延後 |

---

## 待做的設計決策（需要決定的）

| 項目 | 選項 | 建議 |
|------|------|------|
| 專案持久化 | file-based JSON / SQLite / PostgreSQL | M4 時決定 |
| 前端狀態管理 | React Context / Zustand / Redux | 開發 UI 時決定 |
| LLM persona 批次 | sequential / concurrent / chunked | 依 API 限速決定 |
| 姓名生成 | 規則 / LLM / Faker 庫 | 依語系需求決定 |
| OASIS 安裝方式 | pip install / 原始碼 mount | 依 OASIS 版本決定 |

---

## 檔案導覽

| 路徑 | 說明 |
|------|------|
| `docs/PROJECT_SPEC.md` | 專案規格書（定位、情境、架構、技術選型） |
| `docs/ARCHITECTURE.md` | 架構文件（目錄結構、schema、服務通訊） |
| `docs/DEVELOPMENT_ROADMAP.md` | 開發路線圖（Phase 0-4、里程碑） |
| `docs/OASIS_INTEGRATION.md` | OASIS 整合指南（格式、API、程式碼位置） |
| `docs/API_REFERENCE.md` | API 參考（所有端點） |
| `docs/DATA_SCHEMAS.md` | 資料格式說明（上傳格式、中介格式、OASIS 格式） |
| `docs/AI_HANDOFF.md` | 本文件 |
| `shared/schemas/` | 共用 Pydantic schema |
| `shared/i18n/` | 多國語翻譯 |
| `services/*/app/main.py` | 各服務入口 |
| `docker-compose.yml` | Docker 服務定義 |

---

## OASIS 原始碼位置

OASIS 不在 `ap/` 目錄下，而在：
```
/Volumes/AI02/Civatas-Cursor/source/oasis/
```

關鍵檔案見 `docs/OASIS_INTEGRATION.md` 第 5 節。

---

## 啟動方式

```bash
cd /Volumes/AI02/Civatas-Cursor/ap
cp .env.example .env
# 編輯 .env 填入 LLM_API_KEY

# 啟動核心服務
docker compose up --build

# 或啟動全部服務
docker compose --profile full up --build
```

---

## 使用者的核心需求

1. **通用**：不綁定特定城市/國家
2. **使用者上傳統計**：使用者提供真實數據，不是系統內建
3. **多國語**：繁中 + 英文，架構支援擴充
4. **Docker 微服務**：每層獨立容器
5. **接入 OASIS**：最終目的是模擬社會行為（選舉民調等）
