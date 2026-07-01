# [P1-012] OMP `currentProject = process.cwd()` 与 `resolveProject` 契约不一致

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:84, 86, 152
**类别**:cross-file(既有 helper)

## 问题

```ts
let currentProject = process.cwd();
```

Claude plugin 用 `src/hooks/_project.ts` 的 `resolveProject(cwd?)`,优先级:
1. `AGENTMEMORY_PROJECT_NAME` 环境变量
2. `git rev-parse --show-toplevel`
3. `basename(cwd)`

OMP 用 `process.cwd()` 直接,跳过了前两层。

## 影响

用户在 monorepo 中设置 `AGENTMEMORY_PROJECT_NAME=monorepo`:
- Claude session 记录 `cwd: monorepo`
- OMP session 记录 `cwd: /Users/foo/monorepo/packages/api`

同一字段、不同值,破坏下游按 `cwd` 分组/聚合的逻辑(`src/state/schema.ts` 的 KV 索引等)。

## 触发场景

```bash
# monorepo 根目录
cd ~/monorepo
AGENTMEMORY_PROJECT_NAME=monorepo claude  # session 1
cd packages/api
AGENTMEMORY_PROJECT_NAME=monorepo omp      # session 2
# session 1 和 session 2 在 KV 里 cwd 不同,无法聚合
```

## 修复

复用 Claude plugin 的 helper:

```ts
// 在 extensions 之间共享 _project 逻辑
function resolveProject(cwd: string): string {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME;
  if (explicit) return explicit;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    const dir = out.trim();
    return basename(dir);
  } catch {}
  return basename(cwd);
}

// OMP extension 中:
let currentProject = resolveProject(process.cwd());
```

理想方案:把 `resolveProject` 提取到 `integrations/_lib/project.ts`,Claude plugin 和 OMP/Pi extension 共用。

## 相关位置

- `src/hooks/_project.ts`(Claude plugin 的实现)
- `src/hooks/prompt-submit.ts`, `post-tool-use.ts`, `session-start.ts`, `subagent-start.ts` 等(全部 6+ 处 `resolveProject` 调用)
- `integrations/pi/index.ts`(OMP 的 sibling,需要确认是否也用 `process.cwd()`)