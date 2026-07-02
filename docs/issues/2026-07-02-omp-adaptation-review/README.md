# Issues — `feat/omp-adaptation` Code Review (2026-07-02)

**审查范围**:`git diff main...HEAD`(18 个文件,+768/-54 行)
**来源审查**:`docs/reviews/2026-07-02-omp-adaptation-code-review.md`
**总数**:30 条 candidate,29 CONFIRMED + 1 PLAUSIBLE

## 严重度图例

- 🔴 **P0** — 生产环境功能静默失效
- 🟠 **P1** — 数据正确性 / 契约不一致
- 🟡 **P2** — 资源泄露 / 行为偏离

## Issues 索引

### 第一波(001-015):初始 max-effort 审查

| # | 严重度 | 文件 | 行 | 摘要 |
|---|--------|------|-----|------|
| [001](./001-p0-trigger-action-void-string.md) | 🔴 P0 | `src/index.ts` | 269 | 裸字符串 `action: "void"` 违反 iii-sdk `TriggerAction` 判别联合 |
| [002](./002-p0-setinterval-missing-unref.md) | 🔴 P0 | `src/index.ts` | 268 | 新 setInterval 缺少 `.unref()`,进程无法干净退出 |
| [003](./003-p0-duplicate-auto-forget-schedule.md) | 🔴 P0 | `src/index.ts` | 263 | 新旧 auto-forget 定时器双轨并行,重复扫描/删除 |
| [004](./004-p0-claude-bridge-graph-disabled.md) | 🔴 P0 | `src/index.ts` | 281 | claude-bridge 和 graph-extraction handler 未注册,功能静默失效 |
| [005](./005-p0-evict-timer-trigger-action-bug.md) | 🔴 P0 | `src/index.ts` | 277 | evict 定时器同样使用裸字符串 `action: "void"` |
| [006](./006-p1-omp-inject-context-unconditional.md) | 🟠 P1 | `integrations/omp/index.ts` | 248 | OMP 无视 `AGENTMEMORY_INJECT_CONTEXT` opt-in,无条件注入上下文 |
| [007](./007-p1-session-shutdown-serverok-gate.md) | 🟠 P1 | `integrations/omp/index.ts` | 211 | `session_shutdown` 受 `!serverOk` gate 影响,可能丢失关闭事件 |
| [008](./008-p1-tool-execution-end-no-error-branch.md) | 🟠 P1 | `integrations/omp/index.ts` | 232 | `tool_execution_end` 把成功和失败路径合并,缺失 `post_tool_failure` |
| [009](./009-p1-turn-end-wrong-hooktype.md) | 🟠 P1 | `integrations/omp/index.ts` | 269 | `turn_end` 用 `hookType: "post_tool_use"` 上报助手消息,语义错误 |
| [010](./010-p1-typebox-undeclared-dep.md) | 🟠 P1 | `integrations/omp/index.ts` | 9 | OMP 引入 `typebox` 但未声明依赖 |
| [011](./011-p1-session-start-double-http-call.md) | 🟠 P1 | `integrations/omp/index.ts` | 150 | `session_start` 双重 HTTP 调用且 `serverOk` 被冗余覆写 |
| [012](./012-p1-omp-resolveproject-contract-drift.md) | 🟠 P1 | `integrations/omp/index.ts` | 84 | OMP `currentProject = process.cwd()` 与 `resolveProject` 契约不一致 |
| [013](./013-p2-turn-end-array-clone-reverse.md) | 🟡 P2 | `integrations/omp/index.ts` | 272 | `[...event.messages].reverse()` 在长会话中全量克隆消息数组 |
| [014](./014-p2-truncate-edge-cases.md) | 🟡 P2 | `integrations/omp/index.ts` | 63 | `truncate` 在 `max<=0` 返回 `"..."` 且切碎 UTF-16 代理对 |
| [015](./015-p2-omp-missing-plaintext-bearer-guard.md) | 🟡 P2 | `integrations/omp/index.ts` | 27 | OMP 缺少 pi extension 的 `createPlaintextBearerAuthGuard` |

### 第二波(016-030):深度 max-effort 审查补充

**来源**:审查 9 角度(5 correctness + 3 cleanup + 1 altitude)后的 max-effort 复审,聚焦未覆盖的契约不匹配、状态机错误、altitude 问题。

| # | 严重度 | 文件 | 行 | 摘要 |
|---|--------|------|-----|------|
| [016](./016-p1-omp-prompt-submit-payload-contract.md) | 🟠 P1 | `integrations/omp/index.ts:191-198` + `observe.ts:110-112` | — | OMP `prompt_submit` 发送 `tool_input`/`tool_name:"user_prompt"`,但 observe.ts 读 `data.prompt`——`raw.userPrompt` 永不填充,`firstPrompt` 永不派生 |
| [017](./017-p1-omp-sessioninjected-poisoned-on-empty-search.md) | 🟠 P1 | `integrations/omp/index.ts` | 269-287 | `sessionInjected=true` 在搜索结果为空检查之前翻转,首次失败永久禁用整个会话的注入 |
| [018](./018-p1-omp-currentproject-stale-after-cd.md) | 🟠 P1 | `integrations/omp/index.ts` | 110, 174 | `currentProject` 仅在模块加载和 session_start 时刷新,`cd` 后所有观察被打错误标签 |
| [019](./019-p1-omp-agent-start-misclassifies-main-as-subagent.md) | 🟠 P1 | `integrations/omp/index.ts` | 203-213 | `agent_start` 无条件发 `hookType:"subagent_start"`,主 agent 被错标 |
| [020](./020-p1-omp-subagent-stop-missing.md) | 🟠 P1 | `integrations/omp/index.ts` | 114, 315-317 | `agent_end` 空操作,与 `agent_start` 形成非对称生命周期 |
| [021](./021-p1-omp-session-shutdown-fire-and-forget.md) | 🟠 P1 | `integrations/omp/index.ts` | 231-233 | `session_shutdown` 用 `void apiPost`,POST 可能未完成进程已退出 |
| [022](./022-p1-omp-empty-systemprompt-leaks-newlines.md) | 🟠 P1 | `integrations/omp/index.ts` | 269-287 | `before_agent_start` 在 `systemPrompt=""` 时产出 `\n\n## Recalled...`,前导换行作系统提示 |
| [023](./023-p1-omp-missing-issdkchildcontext-guard.md) | 🟠 P1 | `integrations/omp/index.ts` | 整个文件 | 缺少 `isSdkChildContext` 守卫,子 agent 加载扩展时递归观察 |
| [024](./024-p1-omp-serverok-no-recovery.md) | 🟠 P1 | `integrations/omp/index.ts` | 177-185 | `serverOk` 仅在 session_start 设一次,守护进程恢复后无重连 |
| [025](./025-p1-omp-apiget-content-type-on-get.md) | 🟠 P1 ⚠️ | `integrations/omp/index.ts` | 60-72 | `apiGet` 在 GET 上发 `Content-Type: application/json`,严格反向代理会以 415 拒绝(PLAUSIBLE) |
| [026](./026-p2-omp-maybewarnplaintextbearer-load-time-only.md) | 🟡 P2 ⚠️ | `integrations/omp/index.ts` | 28-34, 42 | `maybeWarnPlaintextBearer` 模块加载时一次执行,错过 host 后置环境变量(PLAUSIBLE) |
| [027](./027-p0-claude-bridge-graph-dead-imports-no-warning.md) | 🔴 P0 | `src/index.ts` | 60-61, 281 | `claudeBridgeConfig` 和 `isGraphExtractionEnabled()` 死变量+死调用——P0-004 的"假装删除"升级版 |
| [028](./028-p0-cleanup-timers-shutdown-no-clearinterval.md) | 🔴 P0 | `src/index.ts` | 264, 268, 276, 601-612 | `_cleanupTimers` 数组收集后从不消费,shutdown 不调 `clearInterval`——P0-002 的 altitude 升级版 |
| [029](./029-p1-env-var-rename-no-migration.md) | 🟠 P1 | `src/config.ts` | 156-160 + `src/index.ts:545-556` | `AUTO_FORGET_INTERVAL_MS` → `AGENTMEMORY_AUTO_FORGET_INTERVAL` 重命名无迁移路径,生产部署行为静默变化 |
| [030](./030-p1-omp-config-helpers-duplicate-safeparseint.md) | 🟠 P1 | `src/config.ts` | 156-166 | `getAutoForgetIntervalMs` / `getEvictIntervalMs` 是 `safeParseInt` 的复制实现——重复 + 略不同语义 |

## 修复优先级

### 第一波(必须先修)

1. **P0-1 ~ P0-5**(功能性回归,影响生产用户)
2. **P1-1 ~ P1-7**(契约不一致,影响多集成共存)
3. **P2-1 ~ P2-3**(清理项)

### 第二波(同等紧迫)

4. **P0-027, P0-028** — 第一波 P0 的"假装修复"和 altitude 升级,**必须一起修**
5. **P1-016 ~ P1-024** — OMP 集成的契约/状态机问题,影响所有 OMP 用户
6. **P1-025 ~ P1-026** — PLAUSIBLE,需在常见部署环境(nginx, Cloudflare)验证
7. **P1-029, P1-030** — 配置层重构,降低未来技术债务

## 主题分类汇总

### 重复/双轨问题

- P0-003:双 auto-forget 定时器
- P1-029:双环境变量名无迁移
- P1-030:config helper 重复 `safeParseInt`

### 状态机错误

- P1-017:`sessionInjected` 污染
- P1-024:`serverOk` 无恢复
- P0-028:`_cleanupTimers` 收集后不消费

### 假装删除(altitude 问题)

- P0-004, P0-027:claude-bridge/graph 删除不彻底

### OMP 集成契约漂移

- P1-006, P1-016, P1-017, P1-018, P1-019, P1-020, P1-021, P1-022, P1-023, P1-024, P1-025, P1-026

### 异步/资源管理

- P0-001, P0-005:裸字符串 action
- P0-002, P0-028:定时器清理
- P1-021:`void apiPost` 不等待
- P2-013:数组克隆
