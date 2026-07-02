# 系统修复计划：feat/omp-adaptation 分支 22 项缺陷

**日期**: 2026-07-02
**分支**: `feat/omp-adaptation`
**来源**: max-effort code review + issues #34-#51

## 范围

修复 `feat/omp-adaptation` 分支中 4 个文件的 22 项独立缺陷，覆盖回填脚本、备份脚本、OMP 集成、核心定时器 4 个子系统。

## 分组策略

按文件分组，每文件内部按 P0→P1→P2 优先级。4 组互相独立，可以并行执行。

---

## 文件 1: `scripts/backfill-sessions.py`

### 1.1 toolCall 在 msg.content 中解析 (P0, #45)

**问题**: 真实 OMP JSONL 把工具调用放在 `msg.content` 数组（`type: "toolCall"`），不在顶层 `msg.toolCalls`。

**改动**: `parse_session()` 中 `role == "assistant"` 分支：
- 遍历 `msg.content[]`，对 `type == "toolCall"` 的条目提取 `id`、`name`、`arguments`
- `arguments` 是 dict（非字符串），序列化为 JSON 字符串
- 移除对顶层 `msg.toolCalls` 的依赖

### 1.2 sessionId 截断 (P1, #51-P1-2)

**问题**: `f"backfill-{session_meta['id'][:20]}"` 截断到 20 字符，与 docstring"完整 UUID"矛盾。前 20 字符相同时冲突。

**改动**: 去掉 `[:20]` 截断，用完整 `session_meta['id']`。

### 1.3 裸 except 吞 KeyboardInterrupt (P1, #51-P1-4)

**问题**: 第 348 行 `except:` 同时吞掉 Ctrl-C。

**改动**: `except:` → `except (ValueError, TypeError):`

### 1.4 `--limit` 参数解析无保护 (P2, #42)

**问题**: `int(arg.split('=', 1)[1])` 无 `try/except`，非数字崩溃。

**改动**: 包裹 `try/except ValueError`，打印诊断信息后 `sys.exit(1)`。

### 1.5 末尾重复 parse 算 stats (P2, #43)

**问题**: 主循环已完成解析，汇总块又对全部文件 `parse_session(fpath)` 一遍，总 I/O 翻倍。

**改动**: 在主循环中按 session 累计 `projects` dict 和 turn 计数，删除末尾的二次解析块。

### 1.6 整个 JSONL 读入内存 (P2, #51-P2-1)

**问题**: `lines = [l.strip() for l in f if l.strip()]` 把整个文件读入列表，大文件 OOM。

**改动**: 改为 `for line in f:` 流式处理，不缓存全部行。

### 1.7 无 TCP keepalive (P2, #51-P2-2)

**问题**: 每次 `requests.post(...)` 新建连接，无 keepalive。

**改动**: 模块级 `session = requests.Session()`，`api_post` 用 `session.post(...)`。

---

## 文件 2: `scripts/agentmemory-backup.sh`

### 2.1 AUTH 变量词分割 (P0, #46)

**问题**: `AUTH="${AGENTMEMORY_SECRET:+-H \"Authorization: Bearer $AGENTMEMORY_SECRET\"}"` 转义引号被 bash 当作字面字符，展开成 4 个参数（-H、"Authorization:、Bearer、omp-memory-local"）。

**改动**: 用 bash 数组：
```bash
AUTH=()
[ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTMEMORY_SECRET")
```
调用处改为 `"${AUTH[@]}"`。

### 2.2 import body 缺少 exportData 包装 (P0, #47)

**问题**: 直接 POST 导出 JSON 作为 body，服务端要求 `{exportData: ...}` 包装。

**改动**: 
```bash
curl -s -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  --data-binary "$(jq -nc --argjson data "$(cat "$FILE")" '{exportData: $data, strategy: "replace"}')"
```
同时用 `--data-binary` 替代 `-d "$(cat $FILE)"` 解决 ARG_MAX（#51-P1-1，合并到此修改中）。

---

## 文件 3: `integrations/omp/index.ts`

### 3.1 r.narrative 字段不存在 (P0, #48)

**问题**: `before_agent_start` 读 `r.narrative`，但 `CompactSearchResult` 没有该字段。

**改动**: 方案：调用 `search` 端点获取完整结果（含 narrative），而非 smart-search 的 compact 格式。或扩展 smart-search 响应以包含 narrative（需要改 `src/functions/smart-search.ts` 和 `CompactSearchResult` 类型）。

### 3.2 sessionInjected 在空结果前设置 (P1, #51-P1-3)

**问题**: `sessionInjected = true` 设在 `if (!result?.results?.length) return;` 之前，冷启动首次搜索空结果后永久禁用注入。

**改动**: 将 `sessionInjected = true` 移到 `if (result?.results?.length)` 检查之后。

### 3.3 fetch 无 AbortSignal.timeout (P1, #51-P1-5)

**问题**: `apiPost`/`apiGet` 中的 `fetch` 调用无超时，服务端抖动时 100+ 并发请求排队。

**改动**: 加 `signal: AbortSignal.timeout(3000)` 到 fetch 调用 + 简单内存重试队列（最多 3 次，指数退避）。

### 3.4 session_shutdown await 无超时 (P1, #44)

**问题**: `await apiPost(...)` 在服务器卡住时阻塞 OMP 退出。

**改动**: `Promise.race([apiPost(...), timeout(3000)])`，超时后 fire-and-forget。

### 3.5 plaintext bearer 漏掉私有 IP (P2, #39)

**问题**: 只检查 `localhost/127.0.0.1/::1`，漏掉 `192.168.x.x`、`10.x.x.x`。

**改动**: 增加 `192.168.`、`10.`、`172.16`-`172.31` 前缀检查。

### 3.6 String(undefined) 当工具名 (P2, #40)

**问题**: `"toolName" in event ? String(event.toolName) : "unknown"` 在 `toolName=undefined` 时产生 `"undefined"`。

**改动**: 
```ts
const raw = "toolName" in event ? event.toolName : undefined;
const toolName = (typeof raw === "string" && raw.length > 0) ? raw : "unknown";
```

### 3.7 URL 拼接假设无挂载路径 (P2, #41)

**问题**: `${baseUrl()}/agentmemory/${path}` 当 `AGENTMEMORY_URL` 已含 `/agentmemory` 时产生重复路径。

**改动**: 检测 `baseUrl()` 是否已含 `/agentmemory`，避免重复。

### 3.8 SDK child guard 偏离 canonical (P2, #51-P2-3)

**问题**: OMP 只检查 `AGENTMEMORY_SDK_CHILD` 环境变量，而 canonical `isSdkChildContext` 还识别 `payload.entrypoint === "sdk-ts"` 分支。

**改动**: 从 `src/hooks/sdk-guard.ts` 导入 `isSdkChildContext`（需要确认该文件存在且可导入 OMP 上下文）。

---

## 文件 4: `src/index.ts` + `src/triggers/api.ts`

### 4.1 新定时器缺 .unref() (P0, #49)

**问题**: `_cleanupTimers` 中的 auto-forget 和 evict setInterval 没有 `.unref()`。

**改动**: `setInterval(...)` 返回值加 `.unref()`。

### 4.2 新旧双 auto-forget 定时器 (P0, #50)

**问题**: 新 env var `AGENTMEMORY_AUTO_FORGET_INTERVAL` 和旧 `AUTO_FORGET_INTERVAL_MS` 两个定时器并行。

**改动**: `getAutoForgetIntervalMs() > 0` 时，将 `process.env.AUTO_FORGET_ENABLED = "false"` 禁用旧定时器。更彻底的修复是统一为单个 schedule。

### 4.3 claude-bridge/graph 端点 404 (P0, #35)

**问题**: handler 注册已删除，但 `src/triggers/api.ts` 仍注册 8 个对应 HTTP 端点。

**改动**: 二选一：
- A: 恢复 handler 注册（带 config gate）
- B: 删除 api.ts 中 claude-bridge 和 graph 的 8 个端点

### 4.4 consolidation 无条件注册 (P1, #36)

**问题**: `registerConsolidationPipelineFunction` 不再受 `isConsolidationEnabled()` 门控。

**改动**: 将调用包在 `if (isConsolidationEnabled())` 内。

### 4.5 旧定时器 shutdown 不清理 (P2, #37)

**问题**: shutdown 只清 `_cleanupTimers`（新 2 个），5 个旧定时器未追踪。

**改动**: 将 5 个旧定时器的返回值也加入 `_cleanupTimers` 数组（或新建 `_legacyTimers` 数组），shutdown 时统一 `clearInterval`。

---

## 执行方案

1. 用 `writing-plans` 技能生成 4 份独立的实施计划
2. 用 `task` subagent 并行执行每文件的修改
3. 每文件修改后 build + 验证
4. 最终提交 + push

## 依赖关系

- `backfill-sessions.py` 与 `agentmemory-backup.sh` 无依赖
- `integrations/omp/index.ts` 与 `src/index.ts` 无依赖
- 所有 4 组可以全并行
- `src/triggers/api.ts` 依赖 `src/index.ts` 的决策（#35 二选一）
