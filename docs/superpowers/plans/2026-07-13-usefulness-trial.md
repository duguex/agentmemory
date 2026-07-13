# Agentmemory 有用性检验（具体方案）

> **目的：** 在不动架构的前提下，用 **对照实验** 判定记忆是否 **真正减少重讲 / 提高首轮正确**。  
> **不是** 测 health、search 命中率、enrich 字数（那些已在 Phase B 做过）。  
> **周期：** 建议 **5～10 个工作日**，至少完成 **6 个任务对照**（每任务 A+B 或成对任务）。  
> **纪律：** 检验期内 **禁止** 大改 agentmemory / 换底座 / 清战略方向；挂了只用 `bash scripts/am-daemon.sh ensure|restart`。

**关联：**  
- 技术门禁（已通过）：`docs/superpowers/plans/e2e-scorecard.md`  
- 总计划：`docs/superpowers/plans/2026-07-13-on-track-stable-simple.md`

---

## 1. 假设与要证伪的东西

| ID | 假设 | 若假则说明 |
|----|------|------------|
| H1 | 开记忆后，**同一类任务**你更少粘贴/口述项目背景 | 注入或召回没进「你的工作流」 |
| H2 | 开记忆后，agent **首轮**更常接上既有结论/路径 | 有检索无决策影响 |
| H3 | 运维成本 **可接受**（你愿意为 H1/H2 继续开 daemon） | 有用但不可养 |

**成功不要求** H1–H3 全满分；**去留**见第 7 节阈值。

---

## 2. 实验结构（A/B）

### 2.1 两种条件

| 条件 | 设置 | 含义 |
|------|------|------|
| **A：无注入** | `~/.agentmemory/.env` 中 `AGENTMEMORY_INJECT_CONTEXT=false`，然后 `bash scripts/am-daemon.sh restart`；**新开** agent session | 尽量不自动灌记忆（仍可能手动乱搜——A 轮 **禁止** 主动 recall） |
| **B：有注入** | `AGENTMEMORY_INJECT_CONTEXT=true` + restart；**新开** session；允许 agent 使用 memory 工具 | 正常「有记忆」工作方式 |

可选加强 A：**不要**在 prompt 里提 agentmemory；B 可一句「可参考本机 agentmemory」。

### 2.2 配对方式（二选一，推荐 P1）

| 方式 | 做法 | 优点 |
|------|------|------|
| **P1 同任务两轮**（推荐） | 同一 `T#` 先 A 后 B（或隔天对调），**新 session** | 难度一致 |
| **P2 孪生任务** | T1a/T1b 同型不同文件 | 减少「刚做过一遍」练习效应 |

**练习效应控制：**  
- 若用 P1：A→B 时 B 会略占「你刚想过」便宜 → 记在备注；或 **一半任务 B 先做**（见任务表「顺序」列）。  
- 两次 session **必须新建**，禁止同一上下文续聊。

### 2.3 环境固定

- 同一 agent 产品（不要 A 用 Claude、B 用 Cursor）。  
- 同一模型档位（若可选）。  
- daemon：B 轮前 `bash scripts/am-daemon.sh health` 须绿；A 轮同。  
- **检验期不 backfill、不 drain DLQ、不改代码**（除非 daemon 彻底挂死）。

---

## 3. 任务库（具体题干 — 直接复制到 agent）

每条含：**用户开场白**、**你心里的正确锚点**、**评分要点**。  
锚点来自本机已有语料/近期决策，不是抽象题。

### T1 — 运维纪律（agentmemory 自身）

| 字段 | 内容 |
|------|------|
| **开场白** | 「本机 agentmemory 挂了或要重启，正确步骤是什么？哪些做法禁止？用项目里已经定下的习惯回答。」 |
| **正确锚点** | 用 `scripts/am-daemon.sh`；`AGENTMEMORY_SUPERVISED`；不要 `nohup … > daemon.log` 截断日志；不要半套 pkill |
| **A 成功偏弱信号** | 你补充了 am-daemon / 禁止 nohup |
| **B 成功信号** | 首轮即提到 am-daemon / supervised / 禁止截断日志，你 **无需** 再贴运维约定 |
| **建议顺序** | 第 1 天 A，第 2 天 B（或对调） |

### T2 — 单 worker / 配置

| 字段 | 内容 |
|------|------|
| **开场白** | 「我们 supervised 安装下 agentmemory 和 iii 的进程关系应该是怎样的？有几个 worker？用哪个 config？」 |
| **正确锚点** | C-cli：CLI 一个 worker；`iii-config.supervised.yaml`；无第二份 `dist/index.mjs`；workers=1 |
| **B 成功** | 答出单 worker + supervised yaml，无需你纠正「双 worker」 |

### T3 — VASP / KPOINTS 代码上下文

| 字段 | 内容 |
|------|------|
| **开场白** | 「接着我们 VASP 相关代码：KPOINTS 读取/relax 流程里，关键文件和既有结论是什么？不要从零设计，优先沿用仓库里已经做过的。」 |
| **正确锚点** | 语料中有 `kpoints_reader.hpp`、`relax.hpp`、INCAR/KPOINTS 类工作；应指向已有文件/测试而非空白重构 |
| **B 成功** | 首轮点名已有路径/文件；你少贴「我们上次在写 reader」 |

### T4 — WAVECAR / 恢复类操作

| 字段 | 内容 |
|------|------|
| **开场白** | 「之前有一次从 git 恢复 WAVECAR/INCAR/OUTCAR 一类操作。我们当时怎么做的？若要再做应注意什么？」 |
| **正确锚点** | backfill/session 中有 WAVECAR restore、git commit 恢复类记录 |
| **B 成功** | 能提到恢复/git/WAVECAR 相关既有做法，而非纯通用 VASP 教科书 |

### T5 — 本地 LLM 约定

| 字段 | 内容 |
|------|------|
| **开场白** | 「本机压缩/聊天用的本地模型链路是怎样的？Qwen/Ollama 和 agentmemory 的关系？并发上我们定过什么原则？」 |
| **正确锚点** | Ollama + qwen3.6；chat **串行 gate**；不要多路抢 35B；AUTO_COMPRESS 费 token 的警告 |
| **B 成功** | 提到本地 Ollama/Qwen + 勿并行打爆 GPU/串行，无需你重讲 |

### T6 — 失败与队列（认知题）

| 字段 | 内容 |
|------|------|
| **开场白** | 「mem::compress 的 DLQ 是什么？失败了我们更希望怎样处理？health 绿是否等于没问题？」 |
| **正确锚点** | DLQ=死信；health 绿仍可能 depth/dlq 高；你倾向失败可见 + requeue 而非静默堆积 |
| **B 成功** | 能区分 depth vs dlq，且不把 health 绿说成一切正常（若记忆里有 queue-diag 会话） |

### T7 —（可选）开放真实工单

| 字段 | 内容 |
|------|------|
| **开场白** | 当天真实要改的一小任务（你自拟一句） |
| **正确锚点** | 你自己的「若无记忆必讲的背景」写在记录表 |
| **B 成功** | 相对 A 少讲背景或少返工 |

**最低完成量：** T1–T6 中 **至少 4 条** 完成 A+B；T7 加分。

---

## 4. 单次任务操作清单（逐条勾）

对每个 `T#` × 条件：

1. [ ] `bash scripts/am-daemon.sh health` 绿  
2. [ ] 确认 inject 开关符合 A/B（改 `.env` 后必须 restart）  
3. [ ] **新建** agent session（不要续旧窗）  
4. [ ] 只粘贴「开场白」，**A 轮禁止**再贴长背景；B 轮同样先只开场白  
5. [ ] 看 **前 2 轮** agent 回复（首轮+你一次短澄清内）  
6. [ ] 填记录表（第 5 节），**立即写**，勿隔天凭印象  
7. [ ] 不把标准答案贴进对话后再评「它会了」

**允许：** 任务失败后你再教学——但评分只看 **教学之前**。  
**禁止：** 为了让 B 好看先 search 再把结果贴进 prompt。

---

## 5. 记录表（复制到你的笔记 / 下方附录填）

### 5.1 主表

| ID | 日 | 序 | 条件 | 重讲背景? (0/1) | 首轮锚点命中? (0/1/0.5) | 返工轮数 | 估时(min) | 运维打断? (0/1) | 备注 |
|----|----|----|------|-----------------|-------------------------|----------|-----------|-----------------|------|
| T1 | | A 先/B 先 | A | | | | | | |
| T1 | | | B | | | | | | |
| T2 | | | A | | | | | | |
| T2 | | | B | | | | | | |
| … | | | | | | | | | |

**字段定义：**

| 字段 | 定义 |
|------|------|
| **重讲背景=1** | 你在 **评分窗口内** 又粘贴/口述了锚点里的关键约定 |
| **首轮锚点命中=1** | 前 2 轮内出现正确锚点中的 **≥1 个关键事实**（文件名/命令/结论）且无致命相反建议 |
| **首轮=0.5** | 沾边但不完整，或对一半错一半 |
| **返工轮数** | 你为纠正方向额外发的消息数（评分窗口内） |
| **运维打断=1** | 因 daemon/半死/重启导致任务中断 |

### 5.2 汇总（全部任务做完后算）

```text
n     = 完成的任务条数（同一 T 的 A/B 算一对，n=对数）
RA    = A 条件「重讲背景=1」的比例
RB    = B 条件「重讲背景=1」的比例
HA    = A「首轮锚点命中」平均分（0/0.5/1 当 0/0.5/1）
HB    = B 同上
Ops   = 全程「运维打断」次数
```

---

## 6. 评分规则（防自我欺骗）

1. **只评开场白之后、你贴标准答案之前。**  
2. **命中必须可指认：** 写下 agent 原句里对上锚点的词（记在备注）。  
3. **通用正确 ≠ 命中：** 教科书式 VASP 正确但没接你们仓库/运维约定 → 锚点 0。  
4. **B 先做时** 若 A 更好，照实记——可能记忆在帮倒忙。  
5. **技术旁证（可选，不计入主阈值）：**  
   - B 轮 enrich 是否非空（Read 相关文件时）  
   - 不得用「enrich>500 字」代替「你少重讲」

---

## 7. 判决阈值（写死，避免事后改口）

在 **n≥4 对** 任务后：

| 代号 | 条件 | 判决 |
|------|------|------|
| **U1 有用** | `RB ≤ RA − 0.25` **或** `HB ≥ HA + 0.25`（至少一个成立） | 记忆 **有效用** |
| **U0 无效** | 重讲与命中 **都无** 实质改善（两边差 &lt;0.25） | 管道通但 **工作流无用** |
| **U− 有害** | `HB + 0.25 ≤ HA` 且你主观「纠偏更多」 | 考虑关 inject |
| **O1 可养** | `Ops ≤ 2`（整段检验）且你愿继续开 daemon | 运维可接受 |
| **O0 不可养** | 频繁半死/你拒绝再开 | 即使 U1 也要减配或换道 |

**综合去留（检验结束日填写）：**

| U | O | 行动 |
|---|---|------|
| U1 | O1 | **留下**；再排小修（可见性等） |
| U1 | O0 | **有用但换运维形态**（slim/换道） |
| U0/U− | * | **关 inject 或冻结投资**；勿再堆功能 |
| 不足 n&lt;4 | * | **延长检验**，禁止提前战略转向 |

---

## 8. 日程模板（示例 7 天）

| 日 | 动作 |
|----|------|
| D0 | 读本文；确认 T1–T6 锚点你认同；建空记录表 |
| D1 | T1A, T3A |
| D2 | T1B, T3B |
| D3 | T2A, T5A |
| D4 | T2B, T5B |
| D5 | T4A/B 或 T6A/B |
| D6 | 补缺对；算 RA/RB/HA/HB/Ops |
| D7 | 按第 7 节写 **一行判决** 进本文附录 |

可压缩到 4 天（每天 1～2 对），不可少于 4 对。

---

## 9. 开关备忘（A/B 切换）

```bash
# 编辑 ~/.agentmemory/.env
# A: AGENTMEMORY_INJECT_CONTEXT=false
# B: AGENTMEMORY_INJECT_CONTEXT=true

bash scripts/am-daemon.sh restart
bash scripts/am-daemon.sh health
```

每切换一次 **必须新 session**。

---

## 10. 附录：判决记录（检验结束填写）

```text
日期：
n 对数：
RA=   RB=   （重讲率）
HA=   HB=   （首轮命中均分）
Ops=
判决：U1 / U0 / U−    O1 / O0
一行结论：
下一步（留下小修 / 关 inject / 换道）：
```

| ID | 日 | 序 | 条件 | 重讲 | 命中 | 返工 | 分 | 运维 | 备注（引用 agent 原词） |
|----|----|----|------|------|------|------|----|------|------------------------|
| | | | | | | | | | |

---

## 11. 设计自检

| 要求 | 落点 |
|------|------|
| 具体题干 | 第 3 节 T1–T6 可复制 |
| 可对照 | A/B + 开关步骤 |
| 可计分 | 第 5–7 节 |
| 防自欺 | 第 6 节 |
| 与战略衔接 | 第 7 节去留表 |
| 不测错对象 | 开篇声明非 health/search |

**开始检验的标志：** 填了 D0，并完成第一对 T1A/T1B 记录。  
**结束检验的标志：** 附录判决三行写完。

---

## 附录 B — 代理实验（自动跑，2026-07-13）

> **性质：** 无法代替真人在 IDE 里的「少重讲」检验。  
> **做了什么：** 对 T1–T6，用本机 **Ollama `qwen3.6:27b`** 各答两次：  
> - **A**：无记忆上下文  
> - **B**：`smart-search` + `enrich` 拼进 prompt  
> 锚点关键词命中率 = 协议里的「首轮锚点命中」代理。  
> 原始 JSON：`.superpowers/sdd/usefulness-proxy-results.json`

### 汇总

| 指标 | 值 |
|------|-----|
| HA（无记忆答锚点均分） | **0.56** |
| HB（有记忆答锚点均分） | **0.88** |
| Δ = HB−HA | **+0.32** |
| HM（召回文本自身含锚点，上限） | **0.86** |
| 协议 U1 代理阈值 Δ≥0.25 | **成立（U1_proxy）** |
| daemon | workers=1 healthy |

### 分题

| ID | mem含锚点 | A | B | 解读 |
|----|-----------|---|---|------|
| T1 运维 am-daemon | 0.50 | 0.00 | 0.25 | 记忆里运维纪律不全；B 仅抓到 am-daemon |
| T2 单 worker/config | 1.00 | 0.33 | **1.00** | 记忆明显抬升 |
| T3 VASP/KPOINTS | 0.67 | 0.67 | **1.00** | 通用知识已部分会；记忆补全 kpoints_reader |
| T4 WAVECAR/git | 1.00 | 1.00 | 1.00 | 常识即可，难显记忆增量 |
| T5 Ollama/Qwen/串行 | 1.00 | 0.33 | **1.00** | 记忆增量大 |
| T6 DLQ/health | 1.00 | 1.00 | 1.00 | 常识/训练数据已会 |

### 判决（代理层）

- **U1_proxy：有用（检索上下文能提高答题锚点命中）**  
- **不能**据此写 O1/重讲率——未测真人会话。  
- **上限信号：** HM=0.86 → 多数题召回侧已有料；瓶颈在 **T1 运维约定是否进语料** 与 **真人是否少打字**。  

### 建议你补的真人半程（最短）

只做 **T1、T2、T5** 的 A/B 真人 session（各新建窗），填主表「重讲 0/1」——这三题代理层增量最大，最值得人工确认。


---

## 附录 C — OMP CLI 注入试验（2026-07-13）

### 方法

```bash
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_SECRET=omp-memory-local   # 必填，否则 health/search 401，注入静默失败
export AGENTMEMORY_INJECT_CONTEXT=true|false
export AGENTMEMORY_INJECT_DEBUG=true         # 可选：stderr 打 [agentmemory:inject]

omp -p --no-session --no-tools --thinking=off --max-time=100 \
  --cwd /path/to/agentmemory \
  --model grok-4.5 \
  "我们 supervised 安装下 agentmemory 与 iii 的进程关系？几个 worker？哪个 config？"
```

扩展：`~/.omp/agent/settings.json` → `integrations/omp/index.ts`  
注入路径：`before_agent_start` → `POST /agentmemory/search` → `systemPrompt` 追加 `## Recalled from memory`

### 结果

| 条件 | stderr 诊断 | 含义 |
|------|-------------|------|
| **B** `INJECT=true` | `search query len=72` → **`inject ok lines=5`** | **OMP 注入成功**（5 条回忆写入 systemPrompt） |
| **A** `INJECT=false` | `skip: INJECT_CONTEXT not true` | 门控有效 |
| 用户可见 stdout | **通常看不到** `## Recalled from memory` | 块在 **system**，不一定回显到 print 文本 |
| 首次 B（max-time 过短 / 余额） | `Deadline exceeded` / 401 | **模型/计费问题**，不是注入逻辑 |

### 关键发现

1. **`AGENTMEMORY_SECRET` 必须进 omp 进程**；无 secret 时 `/health` 401 → `ensureServerOk` 失败 → 整段注入跳过。  
2. 仅 `~/.agentmemory/.env` **不够**，除非 omp 启动时 export 了同样变量。  
3. 模型 stdout 答「1 worker / iii-config.yaml」**不能单独证明**注入；要以 **`inject ok`** 或 debug 为准。  
4. 注入内容质量取决于 `search` 叙事结果（本次标题含 am-daemon restart、iii-config 等），**不等于**已写入 `iii-config.supervised.yaml` 的最新结论一定被搜到。

### 判决

- **OMP 注入路径：已在 CLI 验证通过（B 成功 / A 门控）**  
- **「有用」仍取决于回忆内容是否命中你要的决策**；注入成功 ≠ 答案一定对  

