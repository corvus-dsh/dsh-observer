# 越权修复报告 — 副脑自己把活干完了

> 版本：`dsh-observer v1.4.0`
> 日期：2026-11-05
> 结论：**这不是模型不听话，是我们的工具描述把用户的明确指令降级成了一个"可被推翻的建议"。**
> 测试 130 → **143 全绿**，preflight 9 项全 OK，构建字节可复现。
> **产物指纹**：`index.js` **151,455 字节**，sha256 前 16 位 **`18d99b249c3fcb81`**。

---

## 1. 事件还原（从截图读到的）

| 时刻 | 发生的事 | 副脑的判断 |
|---|---|---|
| 第 1 次 | 用户：「帮我写一个 Python 脚本… **请先制定计划，然后孵化主脑来执行**」 | 评估任务规模 → 「简单脚本不大」→ **自己写了代码、画了图**，没孵化 |
| 第 2 次 | 用户**原样重复**同一句 | 理解为「**一个重新提示（可能是模板提醒）**」→ 「用户消息可能是自动续写」→ 继续自己干 |

第二行是这次事件里最刺眼的一条：它把用户**重复的硬指令**读成了系统的自动续写。

---

## 2. 根因：不是边界感，是**措辞**

旧描述原文（v1.3.x）：

```
Call it only after the user has CONFIRMED a plan
AND the work is too large for a single context window.
```

这句话把**用户的指令**和**任务规模**并列成了两个前置条件。模型于是很自然地执行了它读到的逻辑：

1. 检查条件 A（用户确认）→ 满足
2. 检查条件 B（工作太大）→ **不满足**
3. 结论：不该调用

**它严格遵守了我们写的规则。** 我们写的规则本身是错的——它让用户的明确要求变成了一个可以被模型自行称量的因子。

第二个问题同样来自措辞：描述里**完全没有提"重复指令"**，于是模型用「模板提醒 / 自动续写」这个常见解释填了空白。

---

## 3. 修复（三层，不是只改一句话）

### 3.1 工具描述：把"用户的指令"提到第一位，规模降为**兜底**

新描述的结构（`src/core/policy.ts` → `SPAWN_MAIN_DESCRIPTION`）：

```
WHEN TO CALL — the two rules, in this order:

  ① THE USER ASKED. … call this tool. The task being small is NOT a reason to refuse:
    an explicit instruction outranks the model's own estimate of the work.
    If the plan is genuinely thin, write a short plan and hatch anyway —
    the user asked for the handoff, not for a size judgement.

  ② THE USER DID NOT SAY, BUT the work plainly needs multiple steps that will not fit one
    context window … THEN you may propose hatching — but ASK FIRST with ask_user_question;
    do not hatch unilaterally.

NEVER do this when the user did NOT ask and the task is small: finish it here.
Do not use this tool as a way to avoid work, and do not use it as a bookmark.

A REPEATED INSTRUCTION IS NOT A NEW INSTRUCTION. If the user says the same thing again,
that means the earlier one was not carried out — call this tool now.
Do not reinterpret it as a template, a reminder, or auto-continue.
```

关键变化：
- **①在前、②在后**，顺序本身就是优先级；
- 显式否掉「任务小」这个拒绝理由（`NOT a reason to refuse`）；
- 未要求但任务大时，**必须先 `ask_user_question`**，不许擅自孵化；
- **重复指令 = 上次没执行**，禁掉「模板提醒」这个解释路径。

### 3.2 Subagent 区分（你要求的第二件事）

先查了宿主实际语义，没有凭印象写：

| 证据 | 内容 |
|---|---|
| `_dsh_source/dsh-subagent-fork-in-process/lib/index.js` | 注释：*runs each child as a child Agent **SEEDED** with a prefix of the parent's session log — so the child inherits the parent's conversation context* |
| `locale/zh.json` | 「使用父会话的一段历史创建子智能体。」 |

所以准确的区分是：**subagent = 用你的历史做种子的子体，你驱动、它汇报**；**observer = 平级新会话，用户驱动、你退为观察者**。已写进描述：

```
HOW IT DIFFERS FROM THE BUILT-IN SUBAGENT TOOLS: spawning a subagent (or a teammate) creates a
CHILD that runs inside this session's context and reports back; it is a helper you drive. This
tool creates a PEER — a top-level session with its own workspace, its own history and its own id,
which the USER opens and drives, while this session stops being the executor and becomes its
observer.
```

### 3.3 新增的**持久通道**：system-prompt section（这是最关键的一层）

**工具描述只在"模型考虑这个工具时"被读到。** 而 `systemPrompt.section()` 是**每轮请求都从 live state 渲染**、且**结构上免疫压缩**的——`SystemPromptProjection.project()` 会用渲染结果覆盖 surface 节点 0（见 `_dsh_source/SystemPromptProjection.extracted.js` 第 36 行 `this.replace(head.seq, rendered)`）。

graft 一直用这个通道放红线，**observer 此前一次都没用过**——触发策略的全部落点只有一段工具描述。这就是它为什么这么容易依据错误措辞自行决策。

现在注册了 `observer:trigger` section（`order = PLAN_POLICY - 1`），每轮都渲染：

```
## 孵化主脑（observer_spawn_main）的触发规则

用户明确要求「制定计划并孵化主脑 / 开新会话执行 / 交手给新窗口」时，**必须**调用
`observer_spawn_main`。任务看起来小、你觉得可以直接写完 —— 都不是拒绝的理由。
用户要的是交接这个动作本身，不是你对工作量大小的评估。

用户没有要求时：只有在工作明显跨多个步骤、一个上下文窗口装不下时，才可以用
`ask_user_question` **先征询**，不要擅自孵化。简单任务直接在当前会话做完。

用户重复同一条指令 = 上一次没执行，**现在就去执行**。不要把它理解成模板提醒、重复提示或自动续写。

与内置 Subagent 的区别：Subagent 是你在本会话里驱动、干完汇报的子智能体；
`observer_spawn_main` 产出的是一个**平级**的顶级会话（有自己的工作区、历史和 id），
由**用户**打开并驱动，而本会话转为它的观察者。
```

宿主没有 `systemPrompt.section` 时**不致命**：降级为仅工具描述，并写一条 warn（"静默缺席"本身就是要避免的失败模式）。

### 3.4 副脑不是执行者

第二半事故：孵化之后副脑继续干活。它的角色文本说了"观察者"，但**没有任何一句禁止它接管**。现在 `OBSERVER_MISSION_TEXT` 明说：

```
你现在**不是执行者**。
你不要做的：不要替主脑写它的交付物，不要在主脑还活着时「顺手把它做完」，
不要因为主脑做得慢就自己接管。用户想让你接手时会明说。
```

并导出 `permitsExecution(role)`：`observer → false`，`main → true`，无配对会话 → `true`。

---

## 4. 测试（143 / 143）

新增 `test/trigger-policy.test.mjs`（13 条），全部盯**模型实际读到的那些句子**，而不是盯函数行为：

| 用例 | 盯什么 |
|---|---|
| ① 在 ② 之前 | 顺序即优先级，索引位置断言 |
| 「太大才孵化」不再是前置条件 | 正则否定旧措辞 + 肯定新措辞 |
| 「任务小」明确不是拒绝理由 | `NOT a reason to refuse` |
| 未要求但任务大 → 必须先征询 | `ASK FIRST with ask_user_question` |
| **重复指令 ≠ 新指令** | `A REPEATED INSTRUCTION IS NOT A NEW INSTRUCTION` |
| 描述里讲清与 subagent 的区别 | CHILD / PEER / own workspace, history, id |
| section 已注册且 text 是函数 | 每轮渲染，不是常量字符串 |
| 无 systemPrompt 时仍能启动 | 降级路径不炸 |
| 副脑被明确告知不是执行者 | `不是执行者` / `不要替主脑写` |
| `permitsExecution` 三分支 | observer=false |

> 这些是**措辞级**断言。很难看，但这正是上一轮失败的地方——错的是词，不是逻辑，所以只能测词。

---

## 5. 验收（重启后你会跑的两步）

| 你的步骤 | 期望看到 |
|---|---|
| **① 说「你好」** | 不孵化。工具没被调用，当前会话正常回一句。 |
| **② 说复杂多步任务 + 「制定计划并孵化主脑」** | 先给计划，**然后调用** `observer_spawn_main`，返回 `stage: inject_success` + 新主脑 id。 |

判定依据（如果它又自己干了）：
- 宿主日志应有 `[dsh-observer] trigger-rule section registered (observer:trigger)`；
- 若无这一行，说明 section 没注册成功，模型只看到工具描述——把日志贴回来，那是通道问题，不是措辞问题。

---

## 6. 诚实边界

1. **Prompt 只能提高概率，不能保证服从。** 我能做的是把它读到的每条规则改成"用户优先、重复即执行"，并把它放进每轮都渲染的通道。它理论上仍可能自行其是——那时就是模型行为问题，不再是描述缺陷。
2. **我没有在真机上验证 section 是否真的渲染进了提示词。** 我验证的是：`systemPrompt.section()` 被调用、参数正确、宿主无此服务时降级不炸。真机日志里那行 `trigger-rule section registered` 是第一个可观测点。
3. **section 是全局的**（对所有会话生效，不只副脑），因为"只在孵化后才生效"无法阻止第一次错误决策。代价是每轮多约 200 字中文。
4. `dsh-graft-slice` 本轮**未改动**（542/542 仍全绿，`git status` 干净）。
