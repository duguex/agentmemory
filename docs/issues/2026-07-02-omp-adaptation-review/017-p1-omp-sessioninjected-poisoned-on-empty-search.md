# [P1-017] OMP `sessionInjected` 在搜索结果为空时被永久污染,整个会话上下文注入失效

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:269-287`
**类别**:line-by-line(状态机错误)

## 问题

`before_agent_start` 处理器:

```ts
pi.on("before_agent_start", async (event: unknown) => {
  if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
  if (!isInjectContextEnabled()) return;
  if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) return;
  sessionInjected = true;   // ← 第 273 行:在 await 之前翻转
  const result = await apiPost<...>("smart-search", { query: event.prompt, limit: 5 });
  if (!result?.results?.length) return;  // ← 第 278 行:空结果时直接返回,但 sessionInjected 已 true
  // ...
});
```

`sessionInjected` 翻转发生在 `await apiPost` 之前,**也发生在空结果检查之前**。

## 影响

- 首次 `before_agent_start` 触发时,服务器返回 200 但 `result.results = []`(尚无匹配记忆,或新项目),`sessionInjected` 已被设为 true,函数在第 278 行返回
- 后续所有 `before_agent_start` 事件在第 270 行短路 (`if (sessionInjected) return`),**整个会话的上下文注入被永久禁用**
- 即便后续记忆被添加(其他会话写入),当前会话也不会重新检索
- API 错误(apiPost 返回 null)同样会触发该 bug——网络抖动一次性烧掉整个会话的注入能力
- 重置仅发生在 `session_start`(第 175 行 `sessionInjected = false`)

## 触发场景

1. 用户启动新 OMP 会话,项目中无历史记忆(冷启动)
2. 第一个用户提示触发 `before_agent_start`,`sessionInjected` 翻转为 true
3. 服务器返回 `result.results = []`,函数返回,**未注入任何上下文**
4. 用户继续工作,每次 `before_agent_start` 都因 `sessionInjected=true` 而短路
5. 即使后续其他会话写入了相关记忆,本会话永远无法 recall
6. 只有重启会话(session_start 重新触发)才能恢复

## 修复

将 `sessionInjected = true` 移至成功注入之后:

```ts
pi.on("before_agent_start", async (event: unknown) => {
  if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
  if (!isInjectContextEnabled()) return;
  if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) return;

  const result = await apiPost<...>("smart-search", { query: event.prompt, limit: 5 });
  if (!result?.results?.length) return;  // ← 空结果时直接返回,sessionInjected 保持 false

  sessionInjected = true;  // ← 仅在确实要注入时才翻转
  // ... 其余逻辑
});
```

或采用更通用的方案:不维护 `sessionInjected` 本地状态,改为请求头传入 `X-Session-Id`,由服务器端判断是否注入(单一事实来源)。

## 验证步骤

1. 启动 OMP 会话,确认 KV 中无相关记忆
2. 触发首个 `before_agent_start`,观察 `sessionInjected` 是否翻转
3. 在另一个会话中添加相关记忆(写入几条 `remember`)
4. 触发第二个 `before_agent_start`(或新会话中的提示)
5. 修复前:仍然短路,无 recall;修复后:成功注入新记忆

**这是 P1-006(inject-context-unconditional)的对称问题**——P1-006 是无条件注入,本条是首次失败后永久禁用。两个 bug 都需要 `sessionInjected` 状态机重写。
