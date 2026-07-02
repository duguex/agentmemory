# [P1-025] OMP `apiGet` 在无 body 的 GET 请求上发送 `Content-Type: application/json`——严格反向代理会以 400/415 拒绝

**严重度**:🟠 P1(PLAUSIBLE,取决于代理配置)
**文件**:`integrations/omp/index.ts:60-72, 38-43`
**类别**:cross-file(HTTP 协议契约)

## 问题

```ts
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };  // ← 无条件添加
  const s = secret();
  if (s) h.Authorization = `Bearer ${s}`;
  return h;
}

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: authHeaders(),  // ← 包含 Content-Type
    });
    // ...
  }
}
```

`authHeaders()` 无条件添加 `Content-Type: application/json`,**包括 GET 请求**。

## 影响

严格的反向代理和 WAF 会拒绝带 Content-Type 头的 GET 请求:

- **nginx** 配置 `if ($request_method = GET) { return 415; }` 或带 body 检查规则
- **Cloudflare WAF** 规则检查 GET 上的 Content-Type
- **AWS ALB** 在某些配置下拒绝
- **Traefik** 中间件链检查 Content-Type

触发后:
- `apiGet("health")` 返回 null
- `agentmemory_status` 工具报告 "unreachable"
- `serverOk` 翻为 false(P1-024 的问题)
- **整个会话的 observe 全部 no-op**

但**多数**生产代理(nginx 默认、Cloudflare 默认)对 GET 上的 Content-Type 是容忍的——所以是 PLAUSIBLE,不是 CONFIRMED。

## 触发场景

1. OMP 部署在 nginx 后面,nginx 配置 `large_client_header_buffers 4 16k` + `client_max_body_size 1m` 但有 WAF 规则 `if ($http_content_type ~ "application/json" && $request_method = "GET") { return 415; }`
2. `agentmemory_status` 工具调用 `apiGet("health")`
3. nginx 返回 415,apiGet 返回 null,`serverOk = false`
4. 整个会话的 observe 全部短路
5. 用户感知:agentmemory 完全不工作,但 OMP 看起来健康

## 修复

`authHeaders` 应该只对有 body 的请求设置 Content-Type:

```ts
function authHeaders(includeContentType: boolean = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (includeContentType) h["Content-Type"] = "application/json";
  const s = secret();
  if (s) h.Authorization = `Bearer ${s}`;
  return h;
}

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: authHeaders(false),  // ← GET 不带 Content-Type
    });
    // ...
  }
}

async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(true),  // ← POST 带 Content-Type
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // ...
  }
}
```

## 验证步骤

1. 在 nginx 后面加 WAF 规则拒绝 GET+Content-Type
2. 调用 `agentmemory_status`
3. 修复前:返回 "unreachable",`serverOk=false`,所有 observe 短路
4. 修复后:返回 "healthy",observe 正常入库

**这是与已有 [P2-015](./015-p2-omp-missing-plaintext-bearer-guard.md)(明文 bearer 守卫)同源的设计缺陷**——`authHeaders` 应该更精细地根据 HTTP 方法决定头部。
