# Issues — `feat/omp-adaptation` Code Review (2026-07-02)

**审查范围**:`git diff main...HEAD`(18 个文件,+768/-54 行)
**来源审查**:`docs/reviews/2026-07-02-omp-adaptation-code-review.md`
**总数**:15 条 candidate,全部 CONFIRMED

## 严重度图例

- 🔴 **P0** — 生产环境功能静默失效
- 🟠 **P1** — 数据正确性 / 契约不一致
- 🟡 **P2** — 资源泄露 / 行为偏离

## Issues 索引

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

## 修复优先级

1. **P0-1 ~ P0-5 必须先修**(功能性回归,影响生产用户)
2. **P1-1 ~ P1-7 紧接着**(契约不一致,影响多集成共存)
3. **P2-1 ~ P2-3 是清理项**