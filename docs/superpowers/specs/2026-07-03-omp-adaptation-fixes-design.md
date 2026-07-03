# 系统修复设计：feat/omp-adaptation 分支 33 项缺陷

**日期**：2026-07-03
**分支**：`feat/omp-adaptation`
**来源**：
- 本次 max-effort code review 的 11 项发现（详见 docs/reviews/2026-07-03-omp-adaptation-code-review.md）
- 现有系统修复计划 `2026-07-02-system-fix-plan.md` 的 22 项修复

## 目标

将 `feat/omp-adaptation` 分支从"代码评审发现问题"状态推进到"可发布质量"。修复所有 33 项缺陷，确保：
1. 数据完整性（时间戳、score、truncated 字段一致）
2. 行为兼容性（默认配置不退化）
3. 防护纵深（双门控、熔断器、显式日志）
4. 端到端一致性（MCP wrapper、REST、白名单、函数实现）

## 范围

5 个独立文件组，共 33 项修复：

| 组 | 文件 | 项数 | 优先级 |
|---|---|---|---|
| G1 | `scripts/backfill-sessions.py` | 8 | P0-P2 |
| G2 | `scripts/agentmemory-backup.sh` | 2 | P0 |
| G3 | `integrations/omp/index.ts` | 11 | P0-P2 |
| G4 | `src/index.ts` + `src/config.ts` | 9 | P0-P2 |
| G5 | `src/functions/smart-search.ts` + `src/mcp/server.ts` + `src/triggers/api.ts` | 4 | P0-P1 |

## 决策记录（已与用户确认）

| 决策点 | 选定方案 | 理由 |
|---|---|---|
| 修复批次 | 合并到单一修复批次 | 避免跨批次文件冲突；测试一次性跑全套 |
| 自动遗忘默认 | 恢复 1h 默认 | 现有部署零配置体验不退化 |
| OMP 熔断器 | 三态熔断器（CLOSED/OPEN/HALF_OPEN） | 行业实践、可靠性最高 |
| graph 杀开关 | 双重门控（注册 + 函数体） | 纵深防御、避免 LLM 配额浪费 |
| MCP 叙述展开 | 仅修复 wrapper unwrap | 业务逻辑不变，最小变更面 |
| 整体方案 | 方案 A：单次大型合并修复 | 5 组独立文件互不依赖 |

---

## G1: `scripts/backfill-sessions.py`（8 项修复）

### G1.1 — toolCall 在 msg.content 中解析 (P0)

**问题**：真实 OMP JSONL 把工具调用放在 `msg.content` 数组（`type: "toolCall"`），不在顶层 `msg.toolCalls`。当前代码读 `msg.toolCalls` 取不到任何工具调用。

**改动**：`parse_session()` 中 `role == "assistant"` 分支：
- 遍历 `msg.content[]`，对 `type == "toolCall"` 的条目提取 `id`、`name`、`arguments`
- `arguments` 是 dict（非字符串），序列化为 JSON 字符串
- 移除对顶层 `msg.toolCalls` 的依赖

### G1.2 — sessionId 截断 (P1)

**问题**：`f"backfill-{session_meta['id'][:20]}"` 截断到 20 字符，与 docstring "完整 UUID" 矛盾。前 20 字符相同时冲突。

**改动**：去掉 `[:20]` 截断，用完整 `session_meta['id']`。

### G1.3 — 裸 except 吞 KeyboardInterrupt (P1)

**问题**：第 348 行 `except:` 同时吞掉 Ctrl-C。

**改动**：`except:` → `except (ValueError, TypeError):`

### G1.4 — `--limit` 参数解析无保护 (P2)

**问题**：`int(arg.split('=', 1)[1])` 无 `try/except`，非数字崩溃。

**改动**：包裹 `try/except ValueError`，打印诊断信息后 `sys.exit(1)`。

### G1.5 — 末尾重复 parse 算 stats (P2)

**问题**：主循环已完成解析，汇总块又对全部文件 `parse_session(fpath)` 一遍，总 I/O 翻倍。

**改动**：在主循环中按 session 累计 `projects` dict 和 turn 计数，删除末尾的二次解析块。

### G1.6 — 整个 JSONL 读入内存 (P2)

**问题**：`lines = [l.strip() for l in f if l.strip()]` 把整个文件读入列表，大文件 OOM。

**改动**：改为 `for line in f:` 流式处理，不缓存全部行。

### G1.7 — 无 TCP keepalive (P2)

**问题**：每次 `requests.post(...)` 新建连接，无 keepalive。

**改动**：模块级 `session = requests.Session()`，`api_post` 用 `session.post(...)`。

### G1.8 — 时间戳键名错（新增发现 #1）

**问题**：第 261 行构建工具字典用键 `"ts"`，第 383 行读取 `t.get("timestamp")` — 键名不匹配，`t.get("timestamp")` 永远返回 None，每个工具观察都退化为用户提示的时间戳。

**改动**：第 383 行改为 `tool_ts = t.get("ts") or obs_ts`。

---

## G2: `scripts/agentmemory-backup.sh`（2 项修复）

### G2.1 — AUTH 变量词分割 (P0)

**问题**：`AUTH="${AGENTMEMORY_SECRET:+-H \"Authorization: Bearer $AGENTMEMORY_SECRET\"}"` 转义引号被 bash 当作字面字符，展开成 4 个参数（-H、"Authorization:、Bearer、omp-memory-local"）。

**改动**：用 bash 数组：
```bash
AUTH=()
[ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTMEMORY_SECRET")
```
调用处改为 `"${AUTH[@]}"`。

### G2.2 — import body 缺少 exportData 包装 (P0)

**问题**：直接 POST 导出 JSON 作为 body，服务端要求 `{exportData: ...}` 包装。大文件时 `-d "$(cat $FILE)"` 触发 ARG_MAX 限制。

**改动**：
```bash
TMPBODY="$(mktemp)"
jq -c '{exportData: ., strategy: "replace"}' "$FILE" > "$TMPBODY"
curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  --data-binary @"$TMPBODY" || echo "000"
rm -f "$TMPBODY"
```

---

## G3: `integrations/omp/index.ts`（11 项修复）

### G3.1 — r.narrative 字段不存在 (P0)

**问题**：`before_agent_start` 读 `r.narrative`，但 `CompactSearchResult` 没有该字段。

**改动**：扩展 `CompactSearchResult` 类型加 `narrative?: string` 字段；smart-search.ts:316-323 在 narrative 投影中加 narrative 字段（与 expanded-narrative 一致）。

### G3.2 — sessionInjected 在空结果前设置 (P1)

**问题**：`sessionInjected = true` 设在 `if (!result?.results?.length) return;` 之前，冷启动首次搜索空结果后永久禁用注入。

**改动**：将 `sessionInjected = true` 移到 `if (result?.results?.length)` 检查之后。

### G3.3 — fetch 无 AbortSignal.timeout (P1)

**问题**：`apiPost`/`apiGet` 中的 `fetch` 调用无超时，服务端抖动时 100+ 并发请求排队。

**改动**：加 `signal: AbortSignal.timeout(3000)` 到 fetch 调用 + 简单重试（最多 3 次指数退避 100ms/200ms/400ms）。

### G3.4 — session_shutdown await 无超时 (P1)

**问题**：`await apiPost(...)` 在服务器卡住时阻塞 OMP 退出。

**改动**：`Promise.race([apiPost(...), timeout(3000)])`，超时后 fire-and-forget。

### G3.5 — plaintext bearer 漏掉私有 IP (P2)

**问题**：只检查 `localhost/127.0.0.1/::1`，漏掉 `192.168.x.x`、`10.x.x.x`、`172.16-172.31`。

**改动**：增加 `192.168.`、`10.`、`172.16`-`172.31` 前缀检查。

### G3.6 — String(undefined) 当工具名 (P2)

**问题**：`"toolName" in event ? String(event.toolName) : "unknown"` 在 `toolName=undefined` 时产生 `"undefined"`。

**改动**：
```ts
const raw = "toolName" in event ? event.toolName : undefined;
const toolName = (typeof raw === "string" && raw.length > 0) ? raw : "unknown";
```

### G3.7 — URL 拼接假设无挂载路径 (P2)

**问题**：`${baseUrl()}/agentmemory/${path}` 当 `AGENTMEMORY_URL` 已含 `/agentmemory` 时产生重复路径。

**改动**：检测 `baseUrl()` 是否已含 `/agentmemory`，避免重复。

### G3.8 — SDK child guard 偏离 canonical (P2)

**问题**：OMP 只检查 `AGENTMEMORY_SDK_CHILD` 环境变量，而 canonical `isSdkChildContext` 还识别 `payload.entrypoint === "sdk-ts"` 分支。

**改动**：从 `src/hooks/sdk-guard.ts` 导入 `isSdkChildContext`（需要先确认该文件存在）。

### G3.9 — serverOk 熔断器（新增发现 #8）

**问题**：`serverOk` 是单布尔门控，无熔断器、无重试预算、无错误可见性。服务器抖动时产生静默数据丢失。

**改动**：引入三态熔断器：
```ts
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
let circuitState: CircuitState = "CLOSED";
let consecutiveFailures = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

function recordSuccess() {
  consecutiveFailures = 0;
  circuitState = "CLOSED";
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitState = "OPEN";
    lastFailureTime = Date.now();
    console.warn(`[agentmemory] Circuit OPEN: ${consecutiveFailures} consecutive failures, cooling down for ${COOLDOWN_MS}ms`);
  }
}

function canRequest(): boolean {
  if (circuitState === "CLOSED") return true;
  if (circuitState === "OPEN") {
    if (Date.now() - lastFailureTime > COOLDOWN_MS) {
      circuitState = "HALF_OPEN";
      return true;
    }
    return false;
  }
  // HALF_OPEN: allow single probe
  return true;
}
```

所有 `apiPost`/`apiGet` 调用前先检查 `canRequest()`，成功后 `recordSuccess()`，失败后 `recordFailure()`。

### G3.10 — maybeWarnPlaintextBearer 重新求值（新增发现 #10）

**问题**：`maybeWarnPlaintextBearer()` 在模块导入时运行一次，但 `baseUrl()`/`secret()` 每次请求重新读取。late-bound env 变更会绕过警告。

**改动**：将检查内联到 `authHeaders()` 内或独立的 `checkPlaintextBearer()` 函数，每次 URL 变更时调用。

### G3.11 — narrative undefined 防护（新增发现 #11）

**问题**：`r.observation.narrative` 读取无空值检查，可能拼出 `"undefined"` 字面量。

**改动**：在 smart-search.ts:194, 320 改为 `narrative: typeof r.observation.narrative === "string" ? r.observation.narrative : ""`。

---

## G4: `src/index.ts` + `src/config.ts`（9 项修复）

### G4.1 — 新定时器缺 .unref() (P0)

**问题**：`_cleanupTimers` 中的 auto-forget 和 evict setInterval 没有 `.unref()`。

**改动**：`setInterval(...)` 返回值加 `.unref()`。

### G4.2 — 新旧双 auto-forget 定时器 (P0)

**问题**：新 env var `AGENTMEMORY_AUTO_FORGET_INTERVAL` 和旧 `AUTO_FORGET_INTERVAL_MS` 两个定时器并行。

**改动**：`getAutoForgetIntervalMs() > 0` 时，将 `process.env.AUTO_FORGET_ENABLED = "false"` 禁用旧定时器。

### G4.3 — claude-bridge/graph 端点 404 (P0)

**问题**：handler 注册已删除，但 `src/triggers/api.ts` 仍注册 8 个对应 HTTP 端点。

**改动**：方案 A（恢复 handler 注册，带 config gate）。在 `src/index.ts` 恢复 `if (claudeBridgeConfig.enabled)` 和 `if (isGraphExtractionEnabled())` 门控。

### G4.4 — consolidation 无条件注册 (P1)

**问题**：`registerConsolidationPipelineFunction` 不再受 `isConsolidationEnabled()` 门控。

**改动**：将调用包在 `if (isConsolidationEnabled())` 内。

### G4.5 — 旧定时器 shutdown 不清理 (P2)

**问题**：shutdown 只清 `_cleanupTimers`（新 2 个），5 个旧定时器未追踪。

**改动**：将 5 个旧定时器的返回值也加入 `_cleanupTimers` 数组，shutdown 时统一 `clearInterval`。

### G4.6 — 自动遗忘默认值恢复 1h（新增发现 #2）

**问题**：`getAutoForgetIntervalMs()` 未设置时返回 0，现有部署静默丢失 1h 自动遗忘。

**改动**：恢复 1h 默认：
```ts
export function getAutoForgetIntervalMs(): number {
  const val = getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL")
    || process.env.AUTO_FORGET_INTERVAL_MS
    || "3600000";  // 恢复默认 1h
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600000;
}
```

### G4.7 — graph 双重门控（新增发现 #5）

**问题**：`registerGraphFunction` 无条件注册，函数体不检查 `isGraphExtractionEnabled()`。

**改动**：双重门控：
1. `src/index.ts`：恢复 `if (isGraphExtractionEnabled()) { registerGraphFunction(...) }` 门控
2. `src/functions/graph.ts`：在 `mem::graph-extract` 函数体起始处加检查
```ts
mem::graph-extract = async (data) => {
  if (!isGraphExtractionEnabled()) {
    return { success: false, error: "graph extraction disabled" };
  }
  // 实际逻辑...
};
```

### G4.8 — claude-bridge 恢复注册门控（新增发现 #9）

**问题**：`registerClaudeBridgeFunction` 无条件注册。函数体自我检查（OK），但注册门控缺失导致内省工具误报。

**改动**：在 `src/index.ts` 恢复 `if (claudeBridgeConfig.enabled)` 门控（与 G4.3 配套）。

### G4.9 — evict 定时器配置策略（新功能，非修复）

**背景**：evict 定时器是本次分支新引入的功能（main 中不存在 setInterval 调度 `mem::evict`）。`getEvictIntervalMs()` 默认 0（禁用）。

**决策**：保留 opt-in 默认值（0），不强制启用。运维需要主动设置 `AGENTMEMORY_EVICT_INTERVAL` 才启用。理由：
1. evict 操作可能涉及大量数据删除（stale sessions、capped observations），opt-in 更安全
2. auto-forget 是温和的衰减操作，evict 是强力的删除操作，风险等级不同
3. 现有部署没有这个定时器的概念，强制启用可能造成意外的数据删除

**改动**：保持 `getEvictIntervalMs()` 默认 0 不变。在 README 中加文档说明新功能。

---

## G5: `src/functions/smart-search.ts` + `src/mcp/server.ts` + `src/triggers/api.ts`（4 项修复）

### G5.1 — MCP wrapper 修复（新增发现 #3）

**问题**：`memory_smart_search` MCP handler 只在 `result.mode === "expanded" && result.format === "narrative"` 时展开 `result.text`。紧凑模式叙述响应（mode: "compact"）被 JSON.stringify 浪费。

**改动**：修改 `src/mcp/server.ts:286` 的 gate：
```ts
if (result && typeof result === "object" && result.format === "narrative" && typeof result.text === "string") {
  return {
    status_code: 200,
    body: { content: [{ type: "text", text: result.text }] },
  };
}
```
移除 `result.mode === "expanded"` 条件，兼容 expanded 和 compact 两种 mode。

### G5.2 — REST format 白名单修复（新增发现 #4）

**问题**：`/agentmemory/smart-search` REST 端点 payload 白名单不含 `format` 字段，REST 消费者无法使用 narrative 格式。

**改动**：修改 `src/triggers/api.ts:1157-1166`，在白名单中加 `format`：
```ts
const payload = {
  query: req.body?.query,
  expandIds: req.body?.expandIds,
  limit: req.body?.limit,
  project: req.body?.project,
  includeLessons: req.body?.includeLessons,
  agentId: req.body?.agentId,
  sessionId: req.body?.sessionId,
  source: req.body?.source ?? sourceFromHeader,
  format: req.body?.format,  // 新增
};
```

### G5.3 — score 一致性（新增发现 #6）

**问题**：展开-紧凑（line 184）和展开-叙述（line 195）硬编码 `score: undefined`，与紧凑-叙述（line 321）的 `score: r.combinedScore` 不一致。

**改动**：
- `src/functions/smart-search.ts:184`：`score: r.combinedScore`
- `src/functions/smart-search.ts:195`：`score: r.combinedScore`

注意：展开-紧凑分支的 `r` 是 `expanded[i]` 类型，需要确认是否有 `combinedScore` 字段。如果没有，沿用 `score: r.observation.score || undefined`。

### G5.4 — truncated 一致性（新增发现 #7）

**问题**：紧凑-叙述响应（line 333-340）缺 `truncated` 字段。展开-叙述（line 201）和紧凑-紧凑（line 347）都有。

**改动**：在 `narrativeResponse` 中加 `truncated`：
```ts
const narrativeResponse = {
  mode: "compact",
  format: "narrative",
  results: narrativeResults,
  text,
  truncated: filteredHybrid.length > narrativeResults.length,  // 类似展开分支的语义
};
```

---

## 错误处理策略

每个修复的错误处理遵循现有项目模式（AGENTS.md 第 105-107 行）：

- **边界处验证输入**：MCP handler、REST endpoint、Python argparse、bash 变量引用
- **静默失败的兜底**：fetch timeout → `null` 返回，熔断器记录失败次数
- **错误日志**：保留 `console.warn` 和 `logger.warn` 用于运维可见性
- **审计追踪**：状态变更操作（`mem::graph-extract` 拒绝时）记录 `recordAudit()`

## 测试策略

### 单元测试

- `test/backfill-sessions.test.ts`（新增）：覆盖 G1 全部 8 项
- `test/agentmemory-backup.test.ts`（新增）：shell 脚本测试（用 bash -n + bats 或类似）
- `test/omp-integration.test.ts`（更新）：覆盖 G3 全部 11 项
- `test/smart-search.test.ts`（更新）：覆盖 G5 全部 4 项
- `test/index-config.test.ts`（更新）：覆盖 G4 全部 9 项

### 集成测试

- `test/integration.test.ts` 不在 `npm test` 范围内，需要手动跑 `npm run test:integration`
- 端到端覆盖：MCP narrative 展开、REST format 字段、auto-forget 默认、graph 双重门控、熔断器状态转换

### 回归测试

- 紧凑-紧凑响应完全不变（已有测试覆盖）
- 展开-紧凑/叙述响应增加 `score` 字段（可能破坏依赖 `score === undefined` 的测试，需更新断言）
- 紧凑-叙述响应增加 `truncated` 字段（同上）

## 数据不变性保证

| 修复 | 不变性 | 影响范围 |
|---|---|---|
| G1.8 时间戳 | obs 数量不变，时间戳更精确 | 新行为更准确 |
| G4.6 自动遗忘 | 默认 1h 恢复，与原代码一致 | 现有部署零行为变化 |
| G4.7 graph 双门控 | `GRAPH_EXTRACTION_ENABLED=true` 时行为不变 | 仅 false 时拦截 |
| G5.3 score | 展开分支 score 从 undefined 变 combinedScore | 类型变窄，需要下游配合 |
| G5.4 truncated | 紧凑-叙述新增 truncated 字段 | 新增字段，不破坏现有消费者 |

## 执行顺序

5 组互不依赖，可完全并行：
- **Wave 1**（并行）：G1、G2、G3、G4.1-G4.5、G5
- **Wave 2**（依赖 Wave 1 的 G4.3 决策）：G4.6-G4.9

每组内部按 P0 → P1 → P2 顺序执行。

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| G4.6 自动遗忘默认恢复后，现有运维人员的环境仍设 AUTO_FORGET_ENABLED=false | 低 | 低 | bootLog 输出明确状态 |
| G4.7 graph 双门控后，`GRAPH_EXTRACTION_ENABLED=false` 部署首次调用 graph-extract 收到新错误响应 | 中 | 中 | 错误消息清晰，建议运维检查 env |
| G5.3 score 字段从 undefined 变 combinedScore，下游消费者可能依赖 undefined 分支 | 中 | 中 | 测试覆盖两种情况，更新断言 |
| G5.4 truncated 新字段，下游消费者可能不识别 | 低 | 低 | JSON 兼容，新增字段不破坏 |
| 熔断器阈值（5 次失败、60s 冷却）需要调优 | 中 | 中 | 通过配置化或默认值文档化 |

## 待澄清事项

1. **G3.9 熔断器阈值**：失败 5 次 / 冷却 60s 是建议默认值。如需调整请说明。
2. **G4.7 graph 函数体错误响应格式**：建议 `{ success: false, error: "graph extraction disabled" }`。如需其他格式请说明。