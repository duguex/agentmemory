# [P2-014] `truncate` 在 `max<=0` 返回 `"..."` 且切碎 UTF-16 代理对

**严重度**:🟡 P2
**文件**:`integrations/omp/index.ts`
**行**:63-65
**类别**:line-by-line(边界条件 + Unicode)

## 问题

```ts
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}
```

两个边界 bug:

### Bug A:`max<=0` 返回 `"..."` 而非 `""`

- `truncate("hello", 0)` 返回 `"..."`(4 chars),不是 `""`
- 把无意义的占位符写入了 observation corpus,后续 BM25 索引会索引到 `"..."`

### Bug B:`s.slice(0, max)` 切碎 UTF-16 代理对

JavaScript string 是 UTF-16 编码,`length` 是 code unit 数量(非 code point)。`slice` 按 UTF-16 code unit 切分。

- `"😀😀😀".length === 6`(每个 emoji 占 2 个 surrogate code unit)
- `"😀😀😀".slice(0, 1)` = `"\uD83D"`(半截代理对)
- `JSON.stringify` 后变成 `"�"`(U+FFFD REPLACEMENT CHARACTER)
- 下游存储的是乱码

## 影响

- **Bug A**:observation corpus 出现无意义 `"..."` 字符串,污染 BM25 索引和向量检索
- **Bug B**:emoji/CJK 扩展字符/某些罕见汉字被破坏性截断,observation 内容损坏

## 触发场景

```ts
// Bug A
truncate("hello", 0);   // → "..."
truncate("hello", -5);  // → "..."

// Bug B
truncate("😀😀😀", 1);  // → "�..."(乱码 + "...")
truncate("𝕐𝕏𝕎", 1);    // 数学字母数字符号,同样被切碎
```

## 修复

```ts
function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  // 用 Array.from 转 code point,避免切碎代理对
  const codepoints = Array.from(s);
  if (codepoints.length <= max) return s;
  return codepoints.slice(0, max).join("") + "...";
}
```

或使用 `Intl.Segmenter`(Node 16+):

```ts
function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  // 简单方案:先按 code point 切
  const codepoints = Array.from(s);
  if (codepoints.length <= max) return s;
  return codepoints.slice(0, max).join("") + "...";
}
```

## 相关位置

- `src/hooks/post-tool-use.ts:105-114`(Claude plugin 的 truncate,也是类似实现,但目前没有处理这两个边界)