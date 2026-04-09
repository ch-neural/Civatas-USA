# Civatas — 資料格式說明 (Data Schemas)

## 1. 使用者上傳格式

### 1.1 CSV 格式（最簡單）

三欄：`dimension`, `value`, `weight`

```csv
dimension,value,weight
age,18-24,0.12
age,25-34,0.22
age,35-49,0.28
age,50-64,0.23
age,65+,0.15
gender,男,0.49
gender,女,0.51
district,北屯區,0.10
district,西屯區,0.09
district,南屯區,0.08
district,豐原區,0.06
district,其他,0.67
education,國中以下,0.15
education,高中職,0.30
education,大學,0.40
education,研究所以上,0.15
occupation,服務業,0.25
occupation,製造業,0.20
occupation,科技業,0.15
occupation,教育,0.10
occupation,公務員,0.08
occupation,自營,0.12
occupation,退休,0.10
party_lean,偏藍,0.35
party_lean,偏綠,0.30
party_lean,中間,0.25
party_lean,其他,0.10
issue_1,交通,0.25
issue_1,房價,0.20
issue_1,空污,0.15
issue_1,教育,0.15
issue_1,經濟,0.15
issue_1,治安,0.10
```

### 1.2 JSON 格式（完整版）

直接符合 ProjectConfig schema：

```json
{
  "name": "台中市選舉民調",
  "region": "台中市",
  "locale": "zh-TW",
  "target_count": 5000,
  "dimensions": {
    "age": {
      "type": "range",
      "bins": [
        {"range": "18-24", "weight": 0.12},
        {"range": "25-34", "weight": 0.22},
        {"range": "35-49", "weight": 0.28},
        {"range": "50-64", "weight": 0.23},
        {"range": "65+", "weight": 0.15}
      ]
    },
    "gender": {
      "type": "categorical",
      "categories": [
        {"value": "男", "weight": 0.49},
        {"value": "女", "weight": 0.51}
      ]
    },
    "district": {
      "type": "categorical",
      "categories": [
        {"value": "北屯區", "weight": 0.10},
        {"value": "西屯區", "weight": 0.09}
      ]
    },
    "party_lean": {
      "type": "categorical",
      "categories": [
        {"value": "偏藍", "weight": 0.35},
        {"value": "偏綠", "weight": 0.30},
        {"value": "中間", "weight": 0.25},
        {"value": "其他", "weight": 0.10}
      ]
    }
  },
  "cross_correlations": [
    {
      "dims": ["age", "party_lean"],
      "rules": [
        {"conditions": {"age": "65+", "party_lean": "偏藍"}, "boost": 1.3},
        {"conditions": {"age": "18-24", "party_lean": "偏綠"}, "boost": 1.2}
      ]
    }
  ]
}
```

---

## 2. 中介格式：Person

人口合成層輸出、Persona 層輸入。

```json
{
  "person_id": 0,
  "age": 34,
  "gender": "男",
  "district": "西屯區",
  "education": "大學",
  "occupation": "科技業",
  "income_band": null,
  "household_type": null,
  "marital_status": null,
  "party_lean": "偏藍",
  "issue_1": "交通",
  "issue_2": "房價",
  "media_habit": null,
  "mbti": null,
  "vote_probability": null,
  "custom_fields": {}
}
```

---

## 3. OASIS 輸出格式

### 3.1 Twitter CSV

```csv
name,username,user_char,description,following_agentid_list,previous_tweets
user_0,civatas_00000,"34歲男性，住在西屯區，科技業，大學畢業，關心交通與房價，政治傾向偏藍",34歲男性，西屯區科技業居民,[],[]
user_1,civatas_00001,"29歲女性，住在北屯區，教師，碩士畢業，關心教育與托育，政治傾向中間偏綠",29歲女性，北屯區教師,[0],[]
```

**注意事項：**
- `following_agentid_list` 必須是合法的 Python list 字串（OASIS 用 `ast.literal_eval()` 解析）
- `previous_tweets` 同上
- `user_char` 中不能有會破壞 CSV 的未轉義逗號或換行

### 3.2 Reddit JSON

```json
[
  {
    "realname": "user_0",
    "username": "civatas_00000",
    "bio": "34歲男性，西屯區科技業居民",
    "persona": "34歲男性，住在西屯區，科技業...",
    "age": 34,
    "gender": "male",
    "mbti": "ISTJ",
    "country": "Taiwan"
  }
]
```

---

## 4. 維度參考清單

### 4.1 必填維度
- age（年齡）
- gender（性別）
- district（地區/行政區）

### 4.2 常用選填維度
- education（教育程度）
- occupation（職業）
- income_band（收入級距）
- household_type（家戶類型）
- marital_status（婚姻狀態）
- party_lean（政黨傾向）
- issue_1, issue_2（關注議題）
- media_habit（媒體使用偏好）
- mbti（MBTI 類型）
- vote_probability（投票意願）

### 4.3 自訂維度
使用者可添加任意維度，系統會存入 `custom_fields`。
