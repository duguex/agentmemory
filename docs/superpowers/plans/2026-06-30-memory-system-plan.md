# OMP 持久记忆系统 — 实施计划

> **For agentic workers:** This is a Phase 1 activation + observation plan. No code changes beyond config. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 激活 OMP 内置 pi-mnemopi 记忆后端，观察其实际行为，为 Phase 2 增强提供依据

**Architecture:** OMP 内置 SQLite 记忆引擎，四路多模态召回（向量+FTS+图谱+时序），通过 `memory.backend: mnemopi` 配置激活

**Tech Stack:** OMP v16.1.7, pi-mnemopi (built-in), ONNX tiny models

## Global Constraints

- 仅修改 `~/.omp/agent/config.yml`，不碰 OMP 二进制或 node_modules
- 所有观察结果记录在 `~/memory/OBSERVATIONS.md`
- 不引入新依赖，不启动额外服务
- 模型下载使用 `omp tiny-models download` 命令

---

### Task 1: 追加记忆配置

**Files:**
- Modify: `~/.omp/agent/config.yml` (在文件末尾追加)

- [ ] **Step 1: 读取当前 config.yml 确认结构**

```bash
cat ~/.omp/agent/config.yml
```

确认文件内容和缩进风格。

- [ ] **Step 2: 追加 memory 配置段**

在 `~/.omp/agent/config.yml` 末尾追加：

```yaml
memory:
  backend: mnemopi

mnemopi:
  scoping: per-project-tagged
  autoRecall: true
  autoRetain: true
  polyphonicRecall: true
  recallLimit: 12
  retainEveryNTurns: 3
  injectionTokenLimit: 6000
  embeddingVariant: en
```

- [ ] **Step 3: 检查 mnemopi 数据库是否自动创建**

```bash
# 启动一个快速 session 触发初始化
omp --no-session "echo memory init test" --print 2>&1 | head -20
# 检查数据库
ls -la ~/.omp/agent/mnemopi/ 2>/dev/null || echo "目录未创建（启动后生成）"
```

- [ ] **Step 4: 下载 ONNX 嵌入模型**

```bash
omp tiny-models download lfm2-350m
```

Expected: 下载完成后无报错。

- [ ] **Step 5: 提交配置更改**

```bash
# 记录配置变更
cd ~/memory
echo "Config updated at $(date): added memory.backend: mnemopi" >> CHANGELOG.md
```

---

### Task 2: 首次 session 观察

**Observation target:** 启动一个正常 session，观察记忆系统的行为

- [ ] **Step 1: 启动 session 并关注首轮输出**

```bash
cd ~/memory
omp "你好，这是记忆测试 session。请告诉我在当前目录下你能看到什么"
```

观察：
- 首轮 context 中是否出现 `<memories>` 块
- agent 是否提及记忆相关内容
- 记录到观察表

- [ ] **Step 2: 测试 `/memory` 命令**

在 session 中依次输入：
```
/memory stats
/memory view
/memory enqueue
```

记录每个命令的输出格式和内容。

- [ ] **Step 3: 执行一些工作产生记忆**

在 session 中做一些可见操作：
```
创建 notes/hello.md，写入 "这是第一次 session 的测试内容"
```

然后退出 session。

---

### Task 3: 跨 session 召回观察

- [ ] **Step 1: 开启第二个 session 检验召回**

```bash
cd ~/memory
omp "我们上次在这里做了什么？"
```

观察：
- `<memories>` 块是否包含前次 session 的记忆
- agent 能否正确回答上次的操作
- 记录到观察表

- [ ] **Step 2: 切换项目测试隔离性**

```bash
cd /tmp && mkdir -p test-project && cd test-project
omp "我所在的这个项目叫什么名字？"
```

观察：
- 应显示不同的项目上下文
- `/memory stats` 应显示不同的 bank

- [ ] **Step 3: 填写完整观察表**

创建 `~/memory/OBSERVATIONS.md`:

```markdown
# Phase 1 观察记录

| 观察项 | 实际结果 | 备注 |
|--------|----------|------|
| `<memories>` 块是否出现 | TBD | |
| `<memories>` 块格式 | TBD | |
| agent 是否主动提及记忆 | TBD | |
| `/memory stats` 输出 | TBD | |
| `/memory view` 输出 | TBD | |
| `/memory enqueue` 行为 | TBD | |
| autoRetain 是否触发 | TBD | |
| 跨 session 召回 | TBD | |
| 项目隔离 | TBD | |
| 嵌入模型下载是否成功 | TBD | |
| memory 数据库路径 | TBD | |

## 决策

基于以上观察，Phase 2 是否需要增强？

- [ ] 继续 Phase 2（Superpowers 自动化增强）
- [ ] 改用 agentmemory 替代
- [ ] pi-mnemopi 已满足需求，不需要增强
```

---

### Task 4: 结论与决策

- [ ] **Step 1: 评估观察结果**

对比实际结果与 spec 中的预期。判断：
1. pi-mnemopi 是否满足 "项目意图/开发历程/本地资源" 三要素
2. 记忆是否足够"可见"（用户感知到）
3. 是否需要 Phase 2 / 替代方案

- [ ] **Step 2: 提交观察记录**

```bash
cd ~/memory
git add OBSERVATIONS.md CHANGELOG.md 2>/dev/null || echo "未初始化 git 仓库"
```

- [ ] **Step 3: 给出下一步建议**

基于观察结果，推荐进入 Phase 2 增强、改用 agentmemory、或保持现状。
