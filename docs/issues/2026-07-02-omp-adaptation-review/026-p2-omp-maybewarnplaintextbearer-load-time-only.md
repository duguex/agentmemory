# [P2-026] OMP `maybeWarnPlaintextBearer` 仅在模块加载时执行一次——错过 host 后置设置的环境变量

**严重度**:🟡 P2(PLAUSIBLE,取决于 host 初始化顺序)
**文件**:`integrations/omp/index.ts:28-34, 42`
**类别**:line-by-line(初始化时机)

## 问题

```ts
// 第 28-34 行
function maybeWarnPlaintextBearer(): void {
  const url = process.env.AGENTMEMORY_URL ?? "";
  if (!url.startsWith("http://")) return;
  if (!process.env.AGENTMEMORY_SECRET) return;
  if (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1")) return;
  console.warn("[agentmemory] Sending bearer token over plaintext HTTP to " + url + ". Use https:// in production.");
}

// 第 42 行:top-level 调用
maybeWarnPlaintextBearer();
```

函数在模块加载时(top-level)调用一次,读取 `process.env.AGENTMEMORY_URL` 和 `AGENTMEMORY_SECRET` 的当前值。

## 影响

若 host agent 的初始化顺序是:

1. `import agentmemory-omp`(模块加载,触发 `maybeWarnPlaintextBearer()`)
2. **之后**才设置 `process.env.AGENTMEMORY_URL = "http://prod-internal:3111"` 和 `process.env.AGENTMEMORY_SECRET = "secret"`

那么 `maybeWarnPlaintextBearer` 在步骤 1 运行时看到的环境变量都是 undefined,在第 30-31 行的 early-return 后**不会触发警告**。但后续 fetch 实际会用 bearer token 通过明文 HTTP 访问生产服务器——**警告被静默跳过**。

## 与 [P2-015](./015-p2-omp-missing-plaintext-bearer-guard.md) 的关系

P2-015 指出 OMP 缺少 pi 的 `createPlaintextBearerAuthGuard`(运行时守卫)。本条是同一类问题的更窄表现:即使有警告函数,如果在错误的时机调用,功能失效。

修复方向一致:将守卫移到 fetch 调用路径上,每次请求时检查。

## 触发场景

1. Host agent 启动,加载 `agentmemory-omp`(无环境变量,`maybeWarnPlaintextBearer` no-op)
2. Host agent 从配置文件加载 `AGENTMEMORY_URL=http://prod-internal:3111`(明文)+ `AGENTMEMORY_SECRET=secret`
3. OMP 开始工作,`apiPost` 使用 bearer token 通过明文 HTTP 访问生产服务器
4. **没有 console.warn 提示用户存在安全风险**
5. 抓包可看到 bearer token 在明文 HTTP 请求中传输

## 修复

**方案 A**:将检查移到 `authHeaders()` 调用路径:

```ts
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const s = secret();
  if (s) h.Authorization = `Bearer ${s}`;

  // 运行时检查,覆盖后置环境变量
  maybeWarnPlaintextBearer();  // 每次都调用,内部去重

  return h;
}
```

并在 `maybeWarnPlaintextBearer` 内加入去重(避免重复警告):

```ts
let warned = false;
function maybeWarnPlaintextBearer(): void {
  if (warned) return;
  // ... existing checks ...
  warned = true;
}
```

**方案 B(更彻底)**:在 `apiPost` / `apiGet` 入口检查,如果 URL 是明文 HTTP 且有 secret,直接抛错或拒绝请求:

```ts
async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
  if (!allowInsecureTransport()) {
    throw new Error("Refusing to send bearer token over plaintext HTTP");
  }
  // ...
}
```

## 验证步骤

1. 不预设环境变量,启动 host agent(模拟加载顺序)
2. host agent 之后设置 `AGENTMEMORY_URL=http://example.com` 和 `AGENTMEMORY_SECRET=token`
3. 检查 console 是否有警告
4. 修复前:无警告;修复后:首次 fetch 时触发警告

**这是与 P2-015、明文 bearer 安全风险的同源设计问题**——一次性加载时检查不足以覆盖所有部署场景。
