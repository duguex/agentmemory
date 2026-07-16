# am-daemon.sh (Route-1: 稳+简)

**唯一推荐的本机启停入口。** 禁止日常 `nohup … > daemon.log`（会截断日志）和半套 `pkill`（容易 engine 活、worker 死）。

```bash
bash scripts/am-daemon.sh start     # 追加日志、SUPERVISED=1、等到 true health
bash scripts/am-daemon.sh stop      # 整树停：CLI + iii + dist/index.mjs
bash scripts/am-daemon.sh restart
bash scripts/am-daemon.sh status    # 进程树 + livez/health workers≥1
bash scripts/am-daemon.sh ensure    # 不健康则重启（也可由 systemd timer 调）
bash scripts/am-daemon.sh health    # 仅 true-health，exit 0/1
```

日志：**只追加** `~/.agentmemory/logs/daemon.log`（超 20MB 滚动保留 5 份）。

可选 systemd（user）：从 checkout 根目录执行 installer，先生成版本化 unit，再启用 service/timer。

```bash
# 若 `agentmemory` 不在 PATH，显式指定其绝对路径。
AGENTMEMORY_BIN=/path/to/agentmemory bash scripts/install-systemd.sh
# PATH 中已有 agentmemory 时可省略 AGENTMEMORY_BIN。
bash scripts/install-systemd.sh

systemctl --user enable --now agentmemory.service
systemctl --user enable --now agentmemory-ensure.timer   # 每 2 分钟 ensure
```

环境变量 `AGENTMEMORY_SUPERVISED=1`：iii **不** detach，停主进程时一起收掉。

---

# AgentMemory Scripts

## queue-diag.sh

一键队列 / compress 诊断（P0）：

```bash
bash scripts/queue-diag.sh
bash scripts/queue-diag.sh --log /tmp/daemon-restart.log
bash scripts/queue-diag.sh --json
```

输出：`mem::compress` / `mem::graph-extract` depth+dlq、health 成功率、DLQ 样本
（sessionId/observationId/error）、Ollama 加载模型、日志中 `compress.diag` 行。

应用日志里可 `rg 'compress.diag' LOG` 按 `reason` 过滤：
`orphan_observation|already_llm_compressed|auto_compress_disabled|parse_failed|llm_unavailable|compression_failed|success`。


## backfill-sessions.py

回灌历史 OMP 会话到 agentmemory。

### 原理

读取 `~/.omp/agent/sessions/` 下的 JSONL 会话文件，解析成 conversation turn，
每条 turn 作为一个 observation 发送到 agentmemory 的 `observe` API。

### 格式

每条 observation 使用 `hookType: "post_tool_use"`，tool 名匹配原始会话中第一个
实际调用的工具名（如 `bash`、`task`），纯对话消息则用 `"conversation"`。

格式和正常使用 agentmemory 时完全一致，MiniMax 压缩器会产生同等质量的摘要。

### 用法

```bash
export AGENTMEMORY_SECRET=omp-memory-local

# 预览
python3 scripts/backfill-sessions.py --dry-run
python3 scripts/backfill-sessions.py --dry-run --project=vasp

# 实际执行
python3 scripts/backfill-sessions.py
python3 scripts/backfill-sessions.py --project=crisp --limit=50
```

| 参数 | 作用 |
|------|------|
| `--dry-run` | 预览，不发送数据 |
| `--project FILTER` | 只处理项目名包含该字符串的 session |
| `--limit N` | 只处理前 N 个 session 文件 |

### 质量特性

| 维度 | 说明 |
|------|------|
| 时间戳 | 使用原始JSONL入口的真实时间（非伪造） |
| 工作目录 | 从 session 元数据读取实际 cwd |
| 会话 ID | 保留完整原始 UUID（前缀 `backfill-`） |
| 项目检测 | 从 cwd 路径智能推断（识别 `vasp`、`crisp` 等关键词） |
| tool 配对 | 按 `toolCallId` 精确匹配，非简单轮次匹配 |
| 截断 | 用户输入 3000 字 / 工具输出 12000 字 / 单个工具 4000 字 |
| MiniMax 摘要 | 使用 `post_tool_use` hookType，摘要质量和正常会话一致 |

### 输出示例

```
Found 593 session files

  [   1/5] vasp                 turns=  1 sent=1  (0s)
  [   2/5] vasp                 turns=  4 sent=5  (0s)
  [   3/5] vasp                 turns= 42 sent=47  (0s)
  [   4/5] vasp                 turns= 13 sent=60  (0s)
  [   5/5] vasp                 turns= 28 sent=88  (0s)

Backfilled 88 turns from 5 sessions (0 skipped) in 0s

Per-project summary:
  vasp                     5 turns
```

## agentmemory-backup.sh

使用官方 REST API 备份/恢复 agentmemory 全部数据。

```bash
export AGENTMEMORY_SECRET=omp-memory-local

# 导出全部数据（sessions, observations, memories, graph, 等）
./scripts/agentmemory-backup.sh export

# 列出已有备份
./scripts/agentmemory-backup.sh list

# 导入备份（merge 模式，跳过重复）
./scripts/agentmemory-backup.sh import ~/.agentmemory/backups/agentmemory-export-20260702-122500.json
```

导出格式是 JSON，包含：

| 数据 | 内容 |
|------|------|
| `sessions` | 所有会话信息 |
| `observations` | 所有观察（按 sessionId 分组） |
| `graphNodes` / `graphEdges` | 知识图谱数据 |
| `memories` / `semanticMemories` | 记忆单元 |
| `summaries` | 会话摘要 |
| `accessLogs` | 访问日志 |

自动保留最近 5 份备份。
