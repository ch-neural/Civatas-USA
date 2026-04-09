# Civatas — API 參考 (API Reference)

所有服務均為 FastAPI，啟動後可在 `http://localhost:{port}/docs` 查看 Swagger UI。

---

## API Gateway (port 8000)

### 專案管理

| Method | Path | 說明 |
|--------|------|------|
| GET | /api/projects/ | 列出所有專案 |
| POST | /api/projects/ | 建立新專案 |
| GET | /api/projects/{id} | 取得專案詳情 |
| DELETE | /api/projects/{id} | 刪除專案 |

### Pipeline（串接下游服務）

| Method | Path | 下游服務 | 說明 |
|--------|------|----------|------|
| POST | /api/pipeline/upload | ingestion | 上傳統計檔案並解析 |
| POST | /api/pipeline/validate | ingestion | 驗證統計檔案 |
| POST | /api/pipeline/synthesize | synthesis | 生成人口樣本 |
| POST | /api/pipeline/persona | persona | 生成 persona |
| POST | /api/pipeline/social | social | 生成社交圖譜 |
| POST | /api/pipeline/export | adapter | 匯出 OASIS 格式 |
| POST | /api/pipeline/simulate | simulation | 執行 OASIS 模擬 |
| POST | /api/pipeline/analyze | analytics | 分析結果 |

### 範本

| Method | Path | 說明 |
|--------|------|------|
| GET | /api/templates/ | 列出內建範本 |
| GET | /api/templates/{name} | 取得特定範本 |

---

## Ingestion Service (port 8001)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /parse | 上傳檔案 → 回傳 ProjectConfig JSON |
| POST | /validate | 上傳檔案 → 回傳驗證報告 |

**上傳格式：** multipart/form-data，欄位名 `file`
**支援格式：** .csv, .json, .xlsx, .xls

**CSV 格式要求：** 三欄 `dimension, value, weight`

```csv
dimension,value,weight
age,18-24,0.12
age,25-34,0.22
gender,男,0.49
gender,女,0.51
district,北屯區,0.10
```

**JSON 格式：** 直接符合 ProjectConfig schema

---

## Synthesis Service (port 8002)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /generate | 接收 ProjectConfig → 回傳 Person list |

**Request body:** ProjectConfig JSON
**Response:**
```json
{
  "count": 5000,
  "persons": [
    {"person_id": 0, "age": 34, "gender": "男", "district": "西屯區", ...},
    ...
  ]
}
```

---

## Persona Service (port 8003)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /generate | 接收 Person list → 回傳帶 persona 的 agent list |

**Request body:**
```json
{
  "persons": [...],
  "strategy": "template",   // "template" | "llm" | "hybrid"
  "locale": "zh-TW",
  "template": null,          // 自訂模板（可選）
  "llm_prompt": null         // 自訂 LLM prompt（可選）
}
```

**Response:**
```json
{
  "count": 5000,
  "agents": [
    {
      "person_id": 0,
      "name": "user_0",
      "username": "civatas_00000",
      "user_char": "34歲男性，住在西屯區...",
      "description": "34歲男性，西屯區居民"
    },
    ...
  ]
}
```

---

## Social Service (port 8004, profile: full)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /generate | 接收 agent list → 回傳 follow edges |

**Request body:**
```json
{
  "agents": [...],
  "density": 0.02,
  "homophily_fields": ["district", "party_lean"]
}
```

---

## Adapter Service (port 8005)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /export | 接收 agents + edges → 回傳 CSV 或 JSON 檔案下載 |

**Request body:**
```json
{
  "agents": [...],
  "edges": [...],
  "format": "twitter_csv"   // "twitter_csv" | "reddit_json"
}
```

---

## Simulation Service (port 8006, profile: full)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /run | 啟動 OASIS 模擬（**目前為 stub**） |

**Request body:**
```json
{
  "agent_file": "/data/outputs/agents.csv",
  "platform": "twitter",
  "llm_model": "gpt-4o-mini",
  "steps": 3,
  "concurrency": 64,
  "interview_prompts": ["您支持哪位候選人？"],
  "interview_sample_ratio": 1.0
}
```

---

## Analytics Service (port 8007, profile: full)

| Method | Path | 說明 |
|--------|------|------|
| GET | /health | 健康檢查 |
| POST | /analyze | 分析 OASIS .db 的 interview 結果 |

**Request body:**
```json
{
  "db_path": "/data/outputs/simulation.db",
  "group_by": ["district", "age"]
}
```
