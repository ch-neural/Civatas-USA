# Civatas — 架構文件 (Architecture)

## 1. 目錄結構

```
ap/
├── docker-compose.yml          # 9 個 Docker 服務定義
├── .env.example                # 環境變數範本
├── .gitignore
├── README.md
│
├── shared/                     # 跨服務共用模組
│   ├── __init__.py
│   ├── schemas/                # Pydantic 資料模型
│   │   ├── __init__.py
│   │   ├── distribution.py     # ProjectConfig, Dimension, CategoryItem, RangeBin
│   │   ├── person.py           # Person（合成中介格式）
│   │   └── agent.py            # TwitterAgent, RedditAgent（OASIS 輸出格式）
│   └── i18n/                   # 多國語
│       ├── __init__.py         # load_messages(), t() helper
│       └── locales/
│           ├── zh-TW.json
│           └── en.json
│
├── services/
│   ├── web/                    # [Next.js] 前端 UI
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── next.config.js
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app/
│   │       │   ├── layout.tsx
│   │       │   └── page.tsx    # 首頁，導覽連結
│   │       ├── components/     # (待開發) UI 元件
│   │       └── lib/
│   │           ├── api.ts      # apiFetch(), apiUpload()
│   │           └── i18n.ts     # loadMessages()
│   │
│   ├── api/                    # [FastAPI] API Gateway
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, uvicorn, httpx, python-multipart
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # 入口，掛載 3 個 router
│   │       └── routes/
│   │           ├── __init__.py
│   │           ├── projects.py   # CRUD 專案
│   │           ├── pipeline.py   # 串接各下游服務的端點
│   │           └── templates.py  # 內建範本管理
│   │
│   ├── ingestion/              # [Layer 1] 資料解析
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, pandas, openpyxl, python-multipart
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /parse, POST /validate
│   │       ├── parser.py       # parse_upload() — CSV/JSON/Excel → ProjectConfig
│   │       └── validator.py    # validate_config() — 檢查必填維度、權重總和
│   │
│   ├── synthesis/              # [Layer 2] 人口合成
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, numpy, pandas, scipy
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /generate
│   │       └── builder.py      # build_population() — 加權抽樣，輸出 Person list
│   │
│   ├── persona/                # [Layer 3] Persona 生成
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, openai
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /generate
│   │       ├── generator.py    # generate_personas() — template / llm / hybrid
│   │       └── templates.py    # DEFAULT_TEMPLATES (zh-TW, en)
│   │
│   ├── social/                 # [Layer 4] 社交圖譜（profile: full）
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, networkx, numpy
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /generate
│   │       └── graph.py        # build_follow_graph() — homophily-weighted
│   │
│   ├── adapter/                # [Layer 5] OASIS 格式轉換
│   │   ├── Dockerfile
│   │   ├── requirements.txt    # fastapi, pandas
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /export — 回傳 CSV/JSON 下載
│   │       └── exporter.py     # to_twitter_csv(), to_reddit_json()
│   │
│   ├── simulation/             # [Layer 6] OASIS 模擬執行（profile: full）
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── app/
│   │       ├── __init__.py
│   │       ├── main.py         # POST /run
│   │       └── runner.py       # run_simulation() — **目前為 stub**
│   │
│   └── analytics/              # [Layer 7] 結果分析（profile: full）
│       ├── Dockerfile
│       ├── requirements.txt
│       └── app/
│           ├── __init__.py
│           ├── main.py         # POST /analyze
│           └── analyzer.py     # analyze_interviews() — 讀取 OASIS .db
│
├── templates/                  # 內建地區範本（JSON 格式，待填充）
├── uploads/                    # 使用者上傳暫存
└── outputs/                    # 生成結果（CSV, JSON, .db）
```

---

## 2. 共用 Schema 定義

### 2.1 ProjectConfig (`shared/schemas/distribution.py`)

使用者上傳統計資料後，系統內部統一使用此格式：

```python
class ProjectConfig(BaseModel):
    name: str                                    # 專案名稱
    region: str = ""                             # 目標地區
    locale: str = "zh-TW"                        # 語系
    target_count: int = 1000                     # 目標生成人數
    dimensions: dict[str, Dimension]             # 各維度分布
    cross_correlations: list[CrossCorrelation]   # 交叉關聯（可選）

class Dimension(BaseModel):
    type: DimensionType                 # "categorical" 或 "range"
    categories: list[CategoryItem]      # 分類型維度
    bins: list[RangeBin]                # 範圍型維度（如年齡）

class CategoryItem(BaseModel):
    value: str      # 如 "男", "北屯區", "偏藍"
    weight: float   # 權重（0~1）
```

### 2.2 Person (`shared/schemas/person.py`)

人口合成層的輸出，Persona 層的輸入：

```python
class Person(BaseModel):
    person_id: int
    age: int            # 必填
    gender: str         # 必填
    district: str       # 必填
    education: str | None
    occupation: str | None
    income_band: str | None
    party_lean: str | None
    issue_1: str | None
    issue_2: str | None
    media_habit: str | None
    mbti: str | None
    vote_probability: float | None
    custom_fields: dict[str, str] = {}
```

### 2.3 TwitterAgent / RedditAgent (`shared/schemas/agent.py`)

OASIS 最終吃的格式：

```python
class TwitterAgent(BaseModel):
    name: str
    username: str
    user_char: str                          # 關鍵：進入 OASIS system prompt
    description: str
    following_agentid_list: str = "[]"
    previous_tweets: str = "[]"
```

---

## 3. 服務間通訊

所有服務間透過 HTTP JSON 通訊，由 API Gateway 統一編排：

```
Web UI → API Gateway → 各微服務
```

API Gateway (`services/api/app/routes/pipeline.py`) 使用 `httpx.AsyncClient` 呼叫下游：

| API Gateway 端點 | 下游服務 | 下游端點 |
|-------------------|----------|----------|
| POST /api/pipeline/upload | ingestion:8000 | POST /parse |
| POST /api/pipeline/validate | ingestion:8000 | POST /validate |
| POST /api/pipeline/synthesize | synthesis:8000 | POST /generate |
| POST /api/pipeline/persona | persona:8000 | POST /generate |
| POST /api/pipeline/social | social:8000 | POST /generate |
| POST /api/pipeline/export | adapter:8000 | POST /export |
| POST /api/pipeline/simulate | simulation:8000 | POST /run |
| POST /api/pipeline/analyze | analytics:8000 | POST /analyze |

---

## 4. Docker Compose 設定

- 預設啟動 6 個核心服務：web, api, ingestion, synthesis, persona, adapter
- `--profile full` 額外啟動：social, simulation, analytics
- 所有 Python 服務掛載 `./shared:/app/shared` 以共用 schema 和 i18n
- volumes: `./uploads`, `./outputs`, `./templates` 掛載到對應容器

---

## 5. 環境變數

| 變數 | 說明 | 預設值 |
|------|------|--------|
| LLM_PROVIDER | LLM 提供者 | openai |
| LLM_API_KEY | API Key | (必填) |
| LLM_MODEL | 模型名稱 | gpt-4o-mini |
| LLM_BASE_URL | 自訂 API URL（本地 vLLM 等） | 空 |
| DEFAULT_LOCALE | 預設語系 | zh-TW |
