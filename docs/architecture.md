# agentmemory 架构

> 一张图说明系统是什么。更新于 2026-07-10。

## 整体

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI 编程 agent                                 │
│  (Claude Code, OMP/Pi, Codex, OpenCode)                        │
│                                                                 │
│  每次工具调用触发 hook 脚本                                     │
│  → POST http://localhost:3111/agentmemory/observe              │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              iii-engine  (单一二进制, 端口 49134 + 3111)        │
│                                                                 │
│  - 拥有 HTTP 端口 3111                                          │
│  - 将 HTTP 请求路由到已注册的函数                              │
│  - 拥有队列 (mem::compress, mem::graph-extract)                │
│  - 拥有 KV 存储 (SQLite, ~/.agentmemory/data/)                  │
└────────────────────────┬────────────────────────────────────────┘
                         │ 进程内
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│          agentmemory daemon  (Node.js 进程)                     │
│                                                                 │
│  - 270 个 mem::*/api::*/event::* 函数                          │
│  - 每个函数就是一个 (payload) => Promise<result> 处理器        │
│  - mem::compress 是主要的那个 (见下文)                          │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP /v1/chat/completions
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Ollama  (独立进程)                          │
│                                                                 │
│  - 拥有 GPU (V100 32GB)                                        │
│  - 跑 qwen3.6:35b (22GB VRAM) 用于 mem::compress              │
│  - 跑 nomic-embed-text (0.3GB VRAM) 用于 mem::embed           │
│  - 模型 5 分钟无请求自动卸载 (Ollama 默认)                     │
└─────────────────────────────────────────────────────────────────┘
```

**四个进程。这就是整个系统。**

| 进程 | 由谁启动 | 拥有 |
|---|---|---|
| **agent** | (用户) | (只调 hook 脚本) |
| **iii-engine** | agentmemory daemon (spawn) | HTTP 3111、队列、KV |
| **agentmemory daemon** | `nohup agentmemory` (手动) | 270 个函数 |
| **Ollama** | (系统服务) | GPU + LLM 模型 |

## 观测从哪来

观测进入 agentmemory 有**两条路径**，都汇合到同一个
`mem::compress` LLM 调用。

### 路径 A: 实时工具调用

Agent 正在运行。每个工具调用被 hook 抓取。

```
[见下面 "tool call → observation" 流程]
```

Agent 工作中会产生稳定的 observation 流。

### 路径 B: 聊天历史 backfill (一次性)

Agent 的过去聊天历史存在某些导出格式 (JSONL, JSON dump,
sqlite)。还没进入 agentmemory。我们一次性导入。

```
1.  OMP/Pi 聊天历史 → 某个文件格式
    (如 ~/.claude/history.jsonl, ~/.omp/sessions/*.json)
2.  scripts/backfill-sessions.py (或类似脚本)
    读文件
    把每条消息转为 tool-call 格式的 JSON:
        {
          "hookType": "post_tool_use",
          "sessionId": "backfill-<uuid>",
          "project": <提取>,
          "cwd": <提取>,
          "timestamp": <提取>,
          "data": {
            "tool_name": <从消息提取>,
            "tool_input": <从消息提取>,
            "tool_output": <从消息提取>,
            "user_prompt": <用户消息如果有>,
          },
        }
3.  对每条消息，POST /agentmemory/observe
    (跟实时工具调用一样的端点 —— daemon 不区分)
4.  iii-engine → mem::observe (同一个处理器)
5.  每条 obs 入队到 mem::compress
6.  2460 条 backfill obs 以 ~4 obs/min 排空队列
    (一次 LLM 调用处理一条 obs, qwen3.6:35b on V100 32GB → ~5s/obs)
7.  ~10 小时后台排空后, backfill 观测
    全部 LLM 压缩完成, 跟实时 obs 不可区分。
```

**backfill 流水线复用实时流水线**。不是单独的"批量导入"路径。
唯一区别是源不同: 实时 agent 调用 vs. 离线脚本喂同一个
`/observe` 端点。

Backfill 完成后, 脚本还会通过 `/agentmemory/summarize` 写每
session 的摘要, 通过 `/agentmemory/graph-extract` 写实体关系。
这些作为 `mem::summarize` 和 `mem::graph-extract` 队列任务跑,
concurrency 各 2, 每 session ~1-2 分钟。

### 不在 corpus 里的

- 用户的纯聊天文本 (无 tool call) — 这些被打包进触发了
  tool 的那条 obs (user_prompt 字段)
- LLM 的纯文本回复 — 同上: 打包进 agent 用 tool 时的那条 obs
- Tool 调用之间的多轮推理 — 当前会丢失。obs 是 per-tool-call
  不是 per-turn。如果想要 per-turn 记忆, 需要新流水线

## tool call → observation 流程

```
1.  Claude 跑一个工具 (如 Bash "ls /tmp")
2.  Claude 的 PostToolUse hook 触发
3.  plugin/scripts/post-tool-use.mjs
    从 stdin 读 JSON, POST 到 /agentmemory/observe
4.  iii-engine 收到 HTTP 请求
5.  iii-engine 调用已注册的函数:  mem::observe
6.  mem::observe (在 daemon 里) 做:
      a. 隐私过滤 (脱敏)
      b. SHA-256 dedup (5 分钟内见过则跳过)
      c. kv.set (synthetic 占位 obs)
      d. 入队 mem::compress (后台 LLM 工作)
7.  iii-engine 立刻给 hook 返回 200。
    Hook 进程退出。Claude 不被阻塞。
8.  同时, 后台:
    iii-engine 从队列里取任务
    调用 daemon 里的 mem::compress。
9.  mem::compress (在 daemon 里) 做:
      a. 从 KV 读 synthetic obs
      b. 如果 obs 缺失 → silently ack (orphan skip)
      c. 如果 obs 已经 LLM 压缩过 → silently ack (skip)
      d. 调 Ollama: POST /v1/chat/completions
         带 obs 文本 + 要求 XML 压缩的 prompt
      e. 解析 XML 响应
      f. kv.delete + kv.set (schema-lock workaround)
      g. 重新索引到 BM25 + 向量
10. obs 现在在 corpus 里, 可检索。
```

**关键属性**: 第 10 步完全在 agent 工具调用的关键路径之外。
第 4 步在毫秒内返回 200; 第 9 步的 LLM 工作要几秒, 后台跑。

## query → context 流程

```
1.  Agent 的 "before_agent_start" hook 触发
2.  Plugin 脚本 POST /agentmemory/smart-search
    body: {query: "VASP binary cleanup workflow 是什么?"}
3.  iii-engine 调用 mem::smart-search
4.  mem::smart-search 做:
      a. (可选) 触发 mem::expand-query
         → LLM 生成查询的 3-5 个改写
         → 200ms 预算, 失败回退到原始查询
      b. HybridSearch.searchWithExpansion(query, limit, expansion)
         - 对每个改写, 跑 tripleStreamSearch:
           * BM25 (title/narrative/concepts 的字面匹配)
           * 向量 (768d 嵌入的余弦相似度)
           * 图 (基于实体的检索)
         - 通过 RRF 融合 (k=60, 权重 bm25:0.4, vector:0.6)
         - 多样化 (每 session 最多 3 条)
         - 用 ms-marco-MiniLM 跨编码器重排 top-20
         - 截断到 limit
      c. (可选) recallLessons (单独的 LLM 调用)
5.  返回 top-K 观测到 agent 的 system prompt
```

## 现在 agentmemory 里有什么

- 94 个 backfill session (来自 OMP/Pi 聊天历史)
- 2460 条总观测
- 100% LLM 压缩 (每条 obs 都过了 LLM)
- 0 unknown, 0 synthetic
- 格式: 每条 obs 有 `title`, `narrative`, `type`, `importance`,
  `concepts`, `files`, `compressionKind: "llm"`

## 现在队列里有什么

| 队列 | 作用 | 并发 |
|---|---|---|
| `mem::compress` | LLM 压缩 synthetic obs | 1 |
| `mem::graph-extract` | 抽取实体 + 关系 | 2 |
| `agentmemory.session.started` / `.ended` | 发布订阅事件 | n/a |

`mem::compress` 是忙的那个。每次调用:
- 从 KV 读 1 条 obs
- 调 Ollama (qwen3.6:35b)
- 写 1 条压缩后 obs 回 KV
- V100 32GB 上 ~4-6 秒/调用

### 并发和调度

`mem::compress` 队列 **concurrency=1** (一次一条 obs)。~5s/obs 意味
着 **峰值 ~12 obs/min 吞吐**, 但实际通常 ~4 obs/min, 因为
`mem::graph-extract` 跟它争同一个 Ollama 实例。

队列的 retry 参数 (在 `iii-config.yaml`):
```
max_retries: 1        # 瞬时错误重试 1 次
backoff_ms: 2000      # 重试间隔 2s
message_group_field: observationId   # per-obs FIFO 顺序
```

### 单条 vs 批量 LLM 调用

`mem::compress` 一次只发 **一条 LLM 调用处理一条 obs**。每次
调用是 `POST /v1/chat/completions`, user prompt 里放一条 obs
的文本, 要求返回一个 `<observation>` XML。5s/obs 的耗时主要来自:

- Ollama 卸载模型后第一次请求的 30-60s 冷加载 (摊到多 obs 上 ~0s)
- V100 32GB + 22GB qwen3.6:35b 上每条 obs ~3-5s 推理
- ~1s 编排开销 (KV 读写, BM25 + 向量重索引)

这对**正确性**是对的 — 每条 obs 是独立 LLM 事务, 一条
obs 解析失败不影响其他, per-observationId 的 FIFO 顺序保留。
这对**吞吐**是错的 — 见下面 "Open issue #1"。

批量模式会把 N 条 obs buffer 起来, 一次 chat completion
请求里全发, 从结果里解析 N 个 `<observation>` 响应。取舍:
更大的 prompt → 更多 VRAM, 但一次冷加载摊到 N 条 obs 上。
这是已知的设计替代方案, **没实现**。见
`docs/known-issues.md` #1。

### 队列 hold: "LLM 不可用" vs "请求错误"

Ollama 端点返回错误时, `mem::compress` 必须判断: 这是
"LLM 临时挂了, hold 这条 obs 等下次重试" 还是 "请求有
问题, 修了也没用"?

- **LLM 不可用** (Ollama 模型卸载了, ECONNREFUSED, "model
  not found"): 返回 `{success: true, skipped: true, reason:
  "llm_unavailable"}` —— engine ack 这条消息不重试, obs 隐式
  等待下次入队。
- **真错误** (解析失败, XML 格式错, 非瞬时 5xx): 返回
  `{success: false}` —— engine 重试 1 次, 然后 DLQ。

LLM 不可用检测在 `OpenAIProvider.isLlmUnavailable()` 里
(`src/providers/openai.ts`), `src/functions/compress.ts` 的
catch 块调用。

### 熔断器

LLM provider 给每次调用包了熔断器
(`src/providers/circuit-breaker.ts`):
- 60s 窗口内 3 次失败 → 熔断打开
- 熔断保持打开 30s
- 30s 后 → 一次探测调用 (half-open 状态)
- 探测成功 → 熔断关闭, 恢复正常流量
- 探测失败 → 熔断再开 30s

这防止一连串失败把 Ollama 端点打挂。30s 开期足够短, 临时
中断能自愈。

### 去重

`mem::observe` 按事件 SHA-256 指纹去重, **5 分钟窗口**。
如果一个工具调用的事件指纹在最近 5 分钟内见过, 新事件被静
默丢弃。防止有 bug 的或话多的 hook 用同一条 obs 灌爆 corpus。

5 分钟窗口硬编码在 `src/functions/observe.ts`。更长窗口
(横跨整个 agent session) 会去重更激进, 但可能误丢合法的
distinct-but-similar 事件重试。

### Ollama 模型卸载

Ollama 默认行为: 模型 5 分钟无请求后从 VRAM 卸载。
`qwen3.6:35b` 是 22GB, 这点很重要 — 让它常驻会阻塞其他
GPU 工作。

**然而**: 只要 `mem::compress` 在从队列里消费 (它在以任何
速率消费), 模型就不会 idle, 也不会卸载。在我们的设置下
队列很少空, 所以卸载很少发生。

Daemon 上**不**设 `OLLAMA_KEEP_ALIVE`。这个 env 变量在
commit `0b43c4c` 移除了, 因为一直 pin 模型是错误的取舍:
每条 obs 延迟快了, 但 22GB VRAM 永远占着。队列就是设计来
absorb 第一次 idle 后 30-60s 冷加载延迟的。

## 存储里有什么

```
~/.agentmemory/
├── .env                     # OPENAI_BASE_URL=http://localhost:11434/v1
│                            # OPENAI_MODEL=qwen3.6:35b-a3b-mtp-q4_K_M
│                            # OPENAI_API_KEY=ollama
│                            # AGENTMEMORY_SECRET=omp-memory-local
│                            # AGENTMEMORY_AUTO_COMPRESS=true
│                            # (不设 OLLAMA_KEEP_ALIVE — Ollama 默认 5min)
│
├── worker.pid               # daemon pid
├── iii.pid                  # engine pid
│
└── data/
    ├── state_store.db/      # SQLite 后端的 KV (每个 scope 一个文件)
    │   ├── mem%3Aobservations%3A<sid>.bin   # 每个 session 的观测
    │   ├── mem%3Asessions.bin              # session 列表
    │   ├── mem%3Asummaries%3A<sid>.bin    # 每个 session 的摘要
    │   ├── mem%3Aindex%3Abm25:...bin       # BM25 索引
    │   ├── mem%3Aindex%3Avectors:...bin    # 向量索引
    │   ├── mem%3Agraph%3A...               # 图节点/边
    │   └── ...
    │
    ├── queue_store/         # file-based 队列 (iii-engine 管理)
    │   └── _queue_lists.bin
    │
    └── stream_store/        # 发布订阅流
```

## 组件清单

| 组件 | 作用 | 在哪 |
|---|---|---|
| **Hooks** | 抓取 agent 的工具调用 | `src/hooks/*.ts` (打包到 plugins) |
| **REST API** | `POST /observe`, `GET /smart-search`, ... | `src/triggers/api.ts` |
| **mem::observe** | dedup + 隐私 + 入队 compress | `src/functions/observe.ts` |
| **mem::compress** | LLM 压缩处理器 | `src/functions/compress.ts` |
| **队列** | 内置 iii-queue, file-based | `iii-config.yaml` |
| **StateKV** | per-scope SQLite | `src/state/kv.ts` |
| **向量索引** | nomic-embed-text 768d | `src/state/vector-index.ts` |
| **BM25 索引** | per-shard 倒排索引 | `src/state/search-index.ts` |
| **HybridSearch** | BM25 + 向量 + 图 + rerank 融合 | `src/state/hybrid-search.ts` |
| **Reranker** | 跨编码器 (ms-marco-MiniLM) | `src/state/reranker.ts` |
| **LLM provider** | OpenAI 兼容 → Ollama | `src/providers/openai.ts` |
| **Query expansion** | LLM 改写 (可选) | `src/functions/query-expansion.ts` |
| **图抽取** | 实体 + 关系 | `src/functions/graph-extract.ts` |
| **OMP 集成** | OMP/Pi agent ↔ agentmemory 桥 | `integrations/omp/index.ts` |
| **Status / 诊断** | 一次性系统状态 | `scripts/status.sh`, `scripts/health.sh` |
| **Trace 单条 obs** | 跟踪一条记录全流程 | `scripts/trace-obs.sh` |

## 什么不在范围内 (设计上的取舍)

agentmemory 故意不做的事:

- **Tool 调用之间的多轮推理**不存。每条观测是 per-tool-call。
  LLM 的纯文本回复被打包进触发了 tool 的那条 obs, 不单独
  存储。
- **跨 session 用户身份**不强制。session 由 `sessionId` (字符
  串) 标识, 无 auth。`AGENTMEMORY_SECRET` 里的 bearer token
  是唯一的访问控制。
- **实时事件流**给 agent。agent 只在通过 `/smart-search`
  查询时看到观测; 没有相关 obs 落地时触发的 push 通道。
- **观测编辑/删除 API**给最终用户。agent 可以观察和搜索,
  但没有 `DELETE /observations` 端点。删除通过直接编辑
  SQLite 完成 (见 `scripts/drain-dlq.py` 例子)。
- **批量 LLM 调用**用于压缩。每条 obs 是独立的 LLM 调用。
  见 `docs/known-issues.md` 为什么这是已知的性能限制。

## 已知限制和陷阱

这些不是 bug —— 是你会撞到的设计约束。

- **`/agentmemory/sessions` 在 100+ session 时慢。** Handler
  读完整 session 列表, 然后逐个 fetch per-session 摘要, 顺序
  执行。在当前 134-session corpus 上可能要 >10s。诊断工具
  (`scripts/health.sh`, `scripts/trace-obs.sh`) 绕开这个端点。
  用 `scripts/health.sh` 做快速状态查询; 留 `/sessions` 给
  显式浏览。
- **Idle 后第一次 LLM 请求慢 (30-60s)。** Ollama 要把
  qwen3.6:35b 从磁盘加载到 22GB VRAM。队列 absorb 这个延迟
  — obs 不丢, 只是等在队列里。这是"不永远 pin 模型"的取舍。
- **Daemon 重启可能留 orphan workers。** daemon 崩溃 + 重启
  后, `/health` 显示 `workers: 2` 而不是 `workers: 1`。老的
  worker 注册在 engine 上 stale 但 engine 没察觉。修法: 重启
  前 kill 任何 `node.*agentmemory` 进程。
- **per-obs LLM 调用是吞吐瓶颈。** qwen3.6:35b 在 V100 32GB
  上每条 obs ~5s。concurrency=1 封顶 ~12 obs/min, 实际 ~4。
  这是单 GPU 硬件限制, 不是软件 bug。
- **三个 commit 让 24h keep_alive 没必要** (commits
  `e769842`, `ced858e`, `0b43c4c`)。如果你看到 daemon 用
  `nohup env OLLAMA_KEEP_ALIVE=24h agentmemory` 启动, 这条
  命令是 stale; 现代等价物就是 `nohup agentmemory`。

更多开放问题和当前状态, 见 `docs/known-issues.md` 和
GitHub issue tracker。

## 怎么跟它交互

```bash
# 看系统状态
bash scripts/status.sh          # daemon, queue, observations, recent log
bash scripts/health.sh          # 同一个, 但绕过 /sessions 端点

# 跟踪一条观测
bash scripts/trace-obs.sh <sid> <oid>

# 跑检索质量 benchmark
cd /home/duguex/memory/agentmemory
npx tsx benchmark/backfill-quality-eval.ts
```

## 另见

- `docs/IMPROVEMENTS.md` — 改动历史
- `docs/known-issues.md` — 当前开放问题
- `docs/final_purpose.md` — 7/2 设计目标状态
- `AGENTS.md` — 编码约定
- `CLAUDE.md` — 快速参考
