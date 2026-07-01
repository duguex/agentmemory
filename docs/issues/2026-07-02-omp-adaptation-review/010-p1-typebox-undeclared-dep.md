# [P1-010] OMP 引入 `typebox` 但未声明依赖

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts` + `integrations/omp/package.json`
**行**:9
**类别**:cross-file(依赖管理)

## 问题

```ts
import { Type } from "typebox";
```

`integrations/omp/package.json` 没有 `typebox` 依赖项;根 `package.json` 也没有。`grep -n typebox package.json integrations/omp/package.json` 无输出。Sibling `integrations/pi/index.ts` 也有同样问题(预存在 bug),OMP 把它扩散了。

## 影响

OMP 运行时之所以能工作,是因为 host agent(OMP/Pi)恰好 bundled typebox。任何独立 bundling、CI smoke test、或第三方用户单独打包 OMP extension 都会失败:`Cannot find module 'typebox'`。

## 触发场景

```bash
cd integrations/omp
npm install  # 没有 typebox
node --experimental-strip-types index.ts
# Error: Cannot find module 'typebox'
```

或在 CI 中:

```yaml
- run: cd integrations/omp && npx tsc --noEmit
# 失败:typebox 类型找不到
```

## 修复

**方案 A(推荐)**:在 `integrations/omp/package.json` 声明依赖:

```json
{
  "name": "agentmemory-omp-extension",
  "private": true,
  "type": "module",
  "dependencies": {
    "typebox": "^1.0.0"
  }
}
```

**方案 B**:去掉 typebox 依赖,把 3 个 tool schema 改为标准 JSON-Schema 字面量:

```ts
// 替代 Type.Object({})
parameters: {
  type: "object",
  properties: {},
}

// 替代 Type.String({ description: "..." })
parameters: {
  type: "object",
  properties: {
    content: { type: "string", description: "What to remember" },
  },
  required: ["content"],
}
```

OMP/Pi runtime 的工具注册应该接受标准 JSON-Schema。方案 B 减少依赖,更可移植。

## 相关位置

- `integrations/omp/index.ts:95, 110, 127`(3 个 typebox schema 使用点)
- `integrations/pi/index.ts:2`(相同预存在 bug)