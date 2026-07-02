# AgentMemory Scripts

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
