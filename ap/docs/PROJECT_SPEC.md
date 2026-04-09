# Civatas — 專案規格書 (Project Specification)

## 1. 專案定位

**Civatas** 是一套通用型社會模擬 Agent 生成平台。
使用者上傳任意地區的真實統計資料，系統自動生成符合該地區人口比例的 AI agents，
接入 OASIS 模擬引擎執行社會模擬（選舉民調、輿情擴散、政策反應等），並產出可分析的結果。

- **通用性**：不綁定特定城市或國家，由使用者提供統計資料決定模擬對象
- **多國語**：預設繁體中文 (zh-TW) 與英文 (en)，架構支援擴充
- **微服務**：每一層為獨立 Docker 容器，透過 FastAPI + HTTP 通訊

---

## 2. 核心使用情境

### 情境 A：選舉民調模擬
1. 使用者上傳某城市的年齡、性別、行政區、政黨傾向等統計
2. 系統生成 5000 個 agents，每人有完整 persona（含政治立場、關注議題）
3. 匯出 OASIS CSV，執行模擬
4. 對 agents 發送 INTERVIEW（民調問題）
5. 分析結果：總體支持度、分群支持度、交叉分析

### 情境 B：輿情擴散模擬
1. 上傳人口統計
2. 生成 agents 並建立社交圖譜（follow 關係）
3. 注入一則初始貼文（如假新聞）
4. 模擬互動（轉發、按讚、留言）
5. 分析擴散速度與範圍

### 情境 C：政策反應模擬
1. 上傳人口統計
2. 生成 agents
3. 注入政策公告
4. 觀察 agents 的反應（支持/反對/討論）

---

## 3. 系統架構

### 3.1 七層架構 + Web UI + API Gateway = 9 個 Docker 服務

```
使用者
  │
  ▼
┌──────────────────────────────────────┐
│  Web UI (Next.js, port 3000)          │
└──────────────┬───────────────────────┘
               │ HTTP
               ▼
┌──────────────────────────────────────┐
│  API Gateway (FastAPI, port 8000)     │
│  串接所有下游微服務                    │
└──────────────┬───────────────────────┘
               │
    ┌──────────┼──────────┬──────────┬──────────┬──────────┬──────────┐
    ▼          ▼          ▼          ▼          ▼          ▼          ▼
 Ingestion  Synthesis  Persona   Social    Adapter  Simulation Analytics
 (8001)     (8002)     (8003)    (8004)    (8005)    (8006)    (8007)
```

### 3.2 資料流

```
使用者上傳統計檔
  → [Ingestion] 解析為 ProjectConfig（內部標準格式）
  → [Synthesis] 依分布生成 N 個 Person（結構化中介資料）
  → [Persona] 將 Person 轉為自然語言 agent persona
  → [Social] (可選) 生成 follow 關係
  → [Adapter] 輸出 OASIS 格式 CSV / JSON
  → [Simulation] 執行 OASIS 模擬
  → [Analytics] 從 .db 讀取結果並分析
```

### 3.3 Docker Compose Profile

| Profile | 包含的服務 |
|---------|-----------|
| 預設 | web, api, ingestion, synthesis, persona, adapter |
| `full` | 預設 + social, simulation, analytics |

---

## 4. 技術選型

| 層 | 技術 | 說明 |
|----|------|------|
| Web UI | Next.js 14 + TypeScript | App Router |
| API Gateway | FastAPI (Python) | 轉發請求給各微服務 |
| Layer 1 Ingestion | FastAPI + pandas | 解析 CSV/JSON/Excel |
| Layer 2 Synthesis | FastAPI + numpy/scipy | 加權抽樣 / IPF |
| Layer 3 Persona | FastAPI + OpenAI SDK | 規則模板 or LLM |
| Layer 4 Social | FastAPI + networkx | Homophily-weighted graph |
| Layer 5 Adapter | FastAPI + pandas | 輸出 OASIS CSV/JSON |
| Layer 6 Simulation | FastAPI + OASIS | 執行模擬 |
| Layer 7 Analytics | FastAPI + sqlite3 | 讀取 OASIS .db |
| i18n | JSON 翻譯檔 + helper | 繁中/英文 |
| 容器化 | Docker Compose | 每層一個容器 |

---

## 5. 多國語架構

- 翻譯檔位於 `shared/i18n/locales/`
- 目前有 `zh-TW.json` 和 `en.json`
- Python 服務：`from shared.i18n import t; t("nav.projects", locale="zh-TW")`
- Next.js 前端：`loadMessages("zh-TW")` 載入翻譯
- 新增語言：在 `locales/` 下加一個 JSON 檔即可

---

## 6. OASIS 整合重點

OASIS (https://github.com/camel-ai/oasis) 是模擬引擎，Civatas 是其「前端+資料準備」。

### 6.1 OASIS 需要的輸入

**Twitter CSV 格式：**

| 欄位 | 必填 | 說明 |
|------|------|------|
| name | 是 | 顯示名稱 |
| username | 是 | 系統用戶名 |
| user_char | 是 | 人格描述（進入 agent 的 system prompt，決定行為） |
| description | 是 | 自我介紹 |
| following_agentid_list | 否 | Python list 字串，如 `[0, 1, 2]` |
| previous_tweets | 否 | Python list 字串，如 `["Hello world"]` |

**Reddit JSON 格式：**

```json
[
  {
    "realname": "...",
    "username": "...",
    "bio": "...",
    "persona": "...(進入 system prompt)",
    "age": 30,
    "gender": "male",
    "mbti": "ISTJ",
    "country": "Taiwan"
  }
]
```

### 6.2 OASIS 的運作方式

1. 讀取 agent 檔案 → 建立 SocialAgent（每人一個 LLM agent）
2. `user_char` / `persona` 進入 system prompt：
   ```
   # SELF-DESCRIPTION
   Your actions should be consistent with your self-description and personality.
   Your have profile: {user_char 內容}
   ```
3. 每個 simulation step：
   - 推薦系統刷新 feed
   - 被啟動的 agents 觀察 feed
   - LLM 決定動作（發文/按讚/轉發/關注/什麼都不做）
4. INTERVIEW 動作：直接對 agent 提問，agent 依 persona 回答
5. 所有行為寫入 SQLite `.db`（post, trace, user, follow, like, comment 等表）

### 6.3 OASIS 程式碼位置

OASIS 原始碼在 `/Volumes/AI02/Civatas-Cursor/source/oasis/`

關鍵檔案：
- `oasis/social_agent/agents_generator.py` — agent 生成邏輯
- `oasis/social_platform/config/user.py` — UserInfo 與 system prompt 組成
- `oasis/social_agent/agent.py` — SocialAgent 類別
- `oasis/environment/env.py` — OasisEnv 模擬環境
- `oasis/social_platform/platform.py` — 平台操作（發文、按讚、INTERVIEW 等）
- `examples/twitter_interview.py` — INTERVIEW 完整範例

---

## 7. 設計原則

1. **OASIS 是模擬引擎，不是人口生成器** — Civatas 負責生成 agents
2. **中介 schema 與 OASIS schema 分離** — 方便調整 persona 而不需重跑人口合成
3. **使用者可控** — 統計分布、persona 模板、民調問題、模擬參數全由使用者在 UI 上設定
4. **先 CLI 後 UI** — 核心引擎先以 API 跑通，再包 Web UI
5. **MVP 先做核心** — 人口合成 + persona + OASIS 匯出優先；社交圖譜、模擬、分析可延後
