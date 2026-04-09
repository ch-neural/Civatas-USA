# Civatas — OASIS 整合指南 (OASIS Integration Guide)

## 1. OASIS 是什麼

OASIS 是由 CAMEL-AI 開發的開源社群模擬引擎。
它在本地 SQLite 資料庫中模擬類 Twitter / Reddit 的社群平台，
讓 AI agents 在其中發文、按讚、轉發、關注、留言，
所有行為都記錄在資料庫中，可事後分析。

- GitHub: https://github.com/camel-ai/oasis
- 本地原始碼: `/Volumes/AI02/Civatas-Cursor/source/oasis/`

---

## 2. OASIS 的 Agent 檔案格式

### 2.1 Twitter 格式（CSV）

OASIS 用 `pd.read_csv()` 讀取。

**必要欄位：**
- `name` — 顯示名稱
- `username` — 系統用戶名
- `user_char` — 人格描述（**最關鍵，進入 LLM 的 system prompt**）
- `description` — 自我介紹

**可選欄位：**
- `following_agentid_list` — Python list 字串，如 `[0, 1, 2]` 或 `[]`
- `previous_tweets` — Python list 字串，如 `["Hello"]` 或 `[]`

**範例：**
```csv
name,username,user_char,description,following_agentid_list,previous_tweets
user_0,civatas_00000,"45歲男性，住在西屯區，科技業...",45歲男性，西屯區居民,[],[]
user_1,civatas_00001,"29歲女性，住在北屯區，教師...",29歲女性，北屯區教師,[0],[]
```

### 2.2 Reddit 格式（JSON）

```json
[
  {
    "realname": "James Miller",
    "username": "james_m",
    "bio": "短自我介紹",
    "persona": "詳細人格描述（進入 system prompt）",
    "age": 40,
    "gender": "male",
    "mbti": "ESTJ",
    "country": "Taiwan"
  }
]
```

---

## 3. OASIS 如何使用 user_char / persona

### 3.1 Twitter 平台的 system prompt

來自 `oasis/social_platform/config/user.py` 的 `to_twitter_system_message()`：

```
# OBJECTIVE
You're a Twitter user, and I'll present you with some tweets.
After you see the tweets, choose some actions from the following functions.

# SELF-DESCRIPTION
Your actions should be consistent with your self-description and personality.
Your name is {username}.
Your have profile: {user_char 的內容}.

# RESPONSE METHOD
Please perform actions by tool calling.
```

### 3.2 Reddit 平台的 system prompt

來自 `to_reddit_system_message()`，額外包含 gender, age, mbti, country：

```
# SELF-DESCRIPTION
Your name is {username}.
Your have profile: {persona 的內容}.
You are a {gender}, {age} years old, with an MBTI personality type of {mbti}
from {country}.
```

**重點：`user_char` / `persona` 的內容直接決定 agent 的行為模式。**
寫入政治傾向、關注議題、語氣風格，agent 就會依此做出反應。

---

## 4. OASIS 的使用流程

### 4.1 新版 API（推薦）

```python
import oasis
from oasis import ActionType, ManualAction, LLMAction, generate_twitter_agent_graph

# 1. 建立 AgentGraph
agent_graph = await generate_twitter_agent_graph(
    profile_path="agents.csv",
    model=openai_model,
    available_actions=[
        ActionType.CREATE_POST,
        ActionType.LIKE_POST,
        ActionType.REPOST,
        ActionType.FOLLOW,
        ActionType.DO_NOTHING,
    ],
)

# 2. 建立環境
env = oasis.make(
    agent_graph=agent_graph,
    platform=oasis.DefaultPlatformType.TWITTER,
    database_path="./simulation.db",
)
await env.reset()

# 3. 互動步驟
actions_1 = {agent: LLMAction() for _, agent in env.agent_graph.get_agents([0,1,2,3,4])}
await env.step(actions_1)

# 4. INTERVIEW（民調）
actions_2 = {}
actions_2[env.agent_graph.get_agent(0)] = ManualAction(
    action_type=ActionType.INTERVIEW,
    action_args={"prompt": "您支持哪位候選人？"}
)
await env.step(actions_2)

# 5. 讀取結果
import sqlite3, json
conn = sqlite3.connect("./simulation.db")
cursor = conn.cursor()
cursor.execute("SELECT user_id, info FROM trace WHERE action = 'interview'")
for user_id, info_json in cursor.fetchall():
    info = json.loads(info_json)
    print(f"Agent {user_id}: {info['response']}")
conn.close()

# 6. 關閉
await env.close()
```

### 4.2 資料庫 Schema

OASIS 使用 SQLite，主要表：

| 表名 | 說明 |
|------|------|
| user | agent 帳號（user_id, agent_id, user_name, name, bio） |
| post | 貼文（post_id, user_id, content, created_at, num_likes...） |
| trace | **所有動作紀錄**（user_id, action, info, created_at） |
| follow | 關注關係（follower_id, followee_id） |
| like | 按讚紀錄 |
| comment | 留言 |
| dislike | 倒讚 |
| rec | 推薦內容 |

**trace 表的 action 欄位值：**
sign_up, create_post, like_post, unlike_post, dislike_post, repost,
quote_post, follow, unfollow, mute, unmute, search_posts, search_user,
create_comment, like_comment, dislike_comment, do_nothing, interview,
report_post, send_group_message, create_group, join_group, leave_group,
refresh, trend, purchase_product

**interview 的 info 欄位格式：**
```json
{
  "prompt": "您支持哪位候選人？",
  "response": "我比較傾向支持...",
  "interview_id": "xxx"
}
```

---

## 5. OASIS 關鍵檔案對照

| 檔案 | 說明 |
|------|------|
| `oasis/social_agent/agents_generator.py` | agent 生成與資料庫註冊 |
| `oasis/social_platform/config/user.py` | UserInfo 類別與 system prompt 組成 |
| `oasis/social_agent/agent.py` | SocialAgent 類別（含 perform_interview） |
| `oasis/environment/env.py` | OasisEnv（reset, step, close） |
| `oasis/social_platform/platform.py` | 平台操作邏輯（發文、按讚、INTERVIEW 等） |
| `oasis/social_platform/typing.py` | ActionType 列舉 |
| `oasis/social_platform/schema/` | SQL schema 定義 |
| `examples/twitter_interview.py` | INTERVIEW 完整範例 |
| `generator/twitter/gen.py` | OASIS 內建的 Twitter agent 生成器 |
| `generator/reddit/user_generate.py` | OASIS 內建的 Reddit agent 生成器 |

---

## 6. Civatas simulation 服務的實作指引

`services/simulation/app/runner.py` 目前是 stub。實作時：

1. **安裝 OASIS**：在 simulation 容器的 Dockerfile 中 `pip install oasis-ai` 或從原始碼安裝
2. **載入 agent 檔案**：從 `/data/outputs/` 讀取 Adapter 產生的 CSV/JSON
3. **建立 model**：使用 camel 的 `ModelFactory.create()`
4. **建立 AgentGraph**：
   - Twitter: `generate_twitter_agent_graph(profile_path, model, available_actions)`
   - Reddit: `generate_reddit_agent_graph(profile_path, model, available_actions)`
5. **建立 OasisEnv**：`oasis.make(agent_graph, platform, database_path)`
6. **執行 step**：用 LLMAction 讓 agents 互動
7. **執行 INTERVIEW**：用 ManualAction + ActionType.INTERVIEW
8. **回傳 .db 路徑**：供 analytics 服務讀取

---

## 7. 開源工具參考

若未來想用更嚴謹的人口合成方法取代 Civatas 目前的加權抽樣：

| 工具 | 說明 | 適合場景 |
|------|------|----------|
| PopulationSim | ActivitySim 的人口合成器，IPF + 熵最大化 | 正式版，需要多層級控制 |
| PopGen3 | IPU 演算法，同時控制 person + household | 需要 household 層級 |
| UDST/synthpop | 輕量 synthetic population | 快速 PoC |
| TinyTroupe (Microsoft) | LLM multi-agent persona 模擬 | persona 豐富化 |
