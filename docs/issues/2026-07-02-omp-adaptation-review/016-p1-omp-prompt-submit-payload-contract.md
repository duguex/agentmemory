# [P1-016] OMP `prompt_submit` 发送 `tool_input`/`tool_name:"user_prompt"`,但 observe.ts 读取 `data.prompt`——契约不匹配

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:191-198` + `src/functions/observe.ts:110-112`
**类别**:cross-file(契约不匹配)

## 问题

OMP `turn_start` 处理器发送:

```ts
void apiPost("observe", {
  hookType: "prompt_submit",
  // ...
  data: { tool_name: "user_prompt", tool_input: truncate(text, 2000) },
});
```

而服务器 `src/functions/observe.ts:110-111`:

```ts
if (payload.hookType === "prompt_submit") {
  raw.userPrompt = d["prompt"] as string | undefined;
}
```

服务器读取 `data.prompt`,但 OMP 发送的是 `data.tool_input`。`raw.userPrompt` 永远是 `undefined`,`session.firstPrompt`(observe.ts:145, 238)永远不被派生。

## 影响

- OMP 会话中所有用户提示都被持久化在原始 blob 中,但**从未被提升到 `raw.userPrompt` 字段**
- `session.firstPrompt`(observe.ts:238)永远是 undefined,/smart-search 依赖 firstPrompt 的查询错过用户意图
- `raw.userPrompt` 是搜索/排序的关键字段,缺失意味着 OMP 会话的提示词**永远不被有效检索**
- 对比 Claude 的 `plugin/scripts/prompt-submit.mjs` 直接发送 `data.prompt`

## 触发场景

1. 用户在 OMP 中输入 "修复 auth middleware 的 bug"
2. `turn_start` 触发,发送 `hookType:"prompt_submit"` + `data:{tool_name:"user_prompt", tool_input:"修复 auth middleware 的 bug"}`
3. 服务器接收,sanitizeRaw 通过,但 `prompt_submit` 分支读到 `data.prompt` 是 undefined
4. `raw.userPrompt` 不被设置,`session.firstPrompt` 永远是 undefined
5. 后续 `agentmemory_search("修复 auth")` 检索不到这条记忆——尽管它确实被存了

## 修复

将 OMP 发送的 data 字段从 `tool_input` 改为 `prompt`,与服务器契约一致:

```ts
data: { prompt: truncate(text, 2000) },
```

或同时发送两个字段以兼容旧版本(不推荐,容易掩盖契约漂移)。

## 验证步骤

1. 在 OMP 会话中输入测试提示
2. 查询 KV `kv.get(KV.sessions, sessionId).firstPrompt`
3. 修复前:undefined;修复后:应该是用户输入的字符串
4. 进一步,运行 `/agentmemory/smart-search` 检索该提示关键词,确认能被检索到

**这是与已有 P1-011(session_start 双重调用)同一类型的契约漂移问题,但发生在 prompt_submit 路径上**——审查未在 `001-015` 中覆盖。
