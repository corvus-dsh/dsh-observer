# v1.6.0 修复报告 — 需求对齐闸门

> 日期：2026-11-05
> 版本：`dsh-observer v1.6.0`
> 结论：**我上一轮为修「越权跳过孵化」写入的 "call this tool now" 造成了反向越权——副脑自己定计划、自己孵化，用户全程没看见。**
> 这次除了改提示词，**加了一道代码闸门**：没有 `ask_user_question` 的调用证据，工具直接拒绝。
> 测试 162 → **179 全绿**，preflight 9 项 OK，构建字节可复现。
> **产物指纹**：`index.js` **187,748 字节**，sha256 前 16 位 **`ace73fb99a23fb73`**。

---

## 1. 两次事故，方向相反，根因相同

| 版本 | 我写的规则 | 实际后果 |
|---|---|---|
| v1.3.x | 「只有用户确认**且**工作太大才孵化」 | 用户明确要求孵化 → 模型评估"任务小" → **自己把活干完** |
| v1.4.0 | 「用户重复指令 = **立刻**孵化」 | 用户说"制定计划并孵化" → 模型**自己发明计划、直接孵化、点火开跑**，用户没看过计划 |

**第二次比第一次严重。** 第一次是"该做的事没做"，第二次是"**未经批准的事在跑**"——在真实开发里，一个错误计划一旦自动开跑，成本是指数级的。

两次的共同根因：**规则只存在于提示词里**。提示词是概率，不是闸门。

---

## 2. 修复：三段式 + 代码闸门

### 2.1 提示词：三段式工作流（你要求的第一、二、三条）

**工具描述**（`SPAWN_MAIN_DESCRIPTION`）：

```
BECAUSE IT STARTS ON ITS OWN, THE PLAN MUST BE AGREED FIRST. Required workflow:

  1. RESEARCH & PLAN — analyse the request, research what you need, produce a concrete plan.
  2. ALIGN & CONFIRM — present that plan to the user IN FULL and call `ask_user_question`
    asking them to confirm it. Offer at least「确认，开始执行」and「需要调整」.
  3. EXECUTE & INCUBATE — ONLY after the user has explicitly replied 确认 / 同意 / 开始 / 可以
    may you call this tool, passing `userConfirmed: true`.

HARD PROHIBITION — DO NOT CALL THIS TOOL ON YOUR OWN INITIATIVE. … Deciding the user
"probably agrees", or that the task is simple enough to skip the question, is exactly the
failure this gate exists to stop.

IF THE TASK TURNS OUT COMPLEX: STOP. Show the plan and ask for confirmation. If the user has
not confirmed, KEEP DISCUSSING — never hatch on your own authority.
```

**关键的一句**（针对本次事故）：

> 「孵化主脑来执行」是**授权了交接这个动作**，**不是**批准了一份用户从未见过的计划。

**同时删掉了 v1.4.0 的矫枉过正**：`call this tool now` 已移除，并有测试断言它不得回来。

**System-prompt section** 同步改成三段式（`不可跳过第 2 段`），因为这是每轮渲染、抗压缩的通道。

### 2.2 代码闸门（超出你要求的部分，我认为必须有）

**新增必填语义参数 `userConfirmed`**，并且**去会话日志核实 `ask_user_question` 真的被调用过**：

```ts
// 1. 没有声明 → 拒绝（连日志都不读）
// 2. 声明了但日志里没有 ask_user_question → 拒绝，并指名缺失的事实
// 3. 有证据 → 通过，并在回执里给出 seq
// 4. 日志读不到 → unverifiable：允许，但明确 warn（我们的能力缺失不该让用户失去会话）
```

**为什么必须加代码闸门**：上一轮我只改了提示词，结果它改坏了。你说的"必须强制"我不能用概率去交付。

**这道的诚实边界**：它证明的是"**问过**"，不是"**同意**"。回答以 tool result 形式回来，去解析那段文本等于用正则猜同意。所以回执里写的是 `需求对齐：已核实（seq=0 调用过 ask_user_question）`，不是"用户已同意"。

### 2.3 顺序修正（我自己的 bug）

闸门最初排在"已是主脑"检查之前，导致一个本身就不能孵化的会话收到"你还没问用户"——**归因错误会把它赶去问一个无意义的问题**。已改为：身份检查 → 确认闸门 → 创建。

---

## 3. 实测两条路径

### A. 声称已确认，但从未问过（**这就是本次事故**）

```
ok = false | stage = confirm
拒绝孵化：用户确认环节没有完成。
核实结果：本会话日志里没有 ask_user_question 的调用记录（共 0 个事件）。
        也就是说，你还没有把计划展示给用户并请他确认。
1. 把计划完整写出来…  2. 调用 ask_user_question…  3. 等用户明确回复后再调用
**不要**为了通过这个检查而伪造 userConfirmed。

→ 创建的会话数: 0    → 点火的次数: 0
```

### B. 连参数都没传

```
ok = false
核实结果：调用方没有声明 userConfirmed: true
→ 创建的会话数: 0
```

### C. 正确路径

```
ok = true | stage = inject_success
自动点火：已触发（via sessionController.prompt）
需求对齐：已核实（seq=0 调用过 ask_user_question）
用户确认：调用方声明已确认
→ tape 事件数: 8    → 点火次数: 1
```

---

## 4. 测试（179 / 179）

新增 `test/confirmation.test.mjs`（15 条），专测闸门：

| 组 | 盯什么 |
|---|---|
| `findAskEvidence` | 取**最后一次** ask；无关工具不算；tool/result 不算 tool/call |
| 判定矩阵 | 无声明→拒绝（且不读日志）／有声明无证据→拒绝／有证据→通过并给 seq／读不到→unverifiable 允许但 warn／用户授权跳过→允许并标记 |
| 工具层 | 拒绝时 **createCalls=0 / prepareCalls=0 / prompts=0**（不留任何痕迹）|
| 回执 | 通过时 `confirmation.evidence='asked'` 且文本含"已核实" |
| 拒绝文案 | 必须指名去调 `ask_user_question`，且禁止伪造 `userConfirmed` |

`test/trigger-policy.test.mjs` 重写（15 条）：三段式顺序、硬禁令、**v1.4.0 的 "call this tool now" 不得回来**、复杂任务要 STOP 而非孵化、逃生舱只认"关于确认本身"的话。

---

## 5. 重启后请这样验收

| 步骤 | 期望 |
|---|---|
| 说「帮我做个电商站，先制定计划，然后孵化主脑」 | ① 写出计划 ② **弹 `ask_user_question` 卡片**等你点 ③ **不孵化** |
| 你点「确认，开始执行」 | 这时才调 `observer_spawn_main`，返回 `需求对齐：已核实（seq=N …）` |
| 直接说「孵化主脑」（不给计划） | 它应当先给计划并问你，**而不是**自己编一份就孵化 |

**关键判定**：如果它又自己定了计划直接孵化，返回值会是 `ok:false / stage:confirm` + 「本会话日志里没有 ask_user_question 的调用记录」——**闸门会拦住它，并把它赶回去问你**。这一次不是靠自觉。

---

## 6. 诚实边界

1. **闸门证明"问过"，不证明"同意"。** 用户若在卡片上点了"需要调整"，模型仍可能传 `userConfirmed: true`。要真正闭合，需要解析 ask 的 tool result（那是下一轮的事，且要处理多问一次的情况）。
2. **`unverifiable` 分支是放行的。** 宿主读不到日志时不拦——不能让我们的能力缺失变成用户的损失。代价是这个环境下闸门退化为纯声明。
3. **我又一次只改了行为、没改交付物之外的东西**：`dsh-graft-slice` 未动（542/542，`git status` 干净）。
4. 第二项（副脑监控 + memory_harvest）与第三项（dsh-paradise P1）**仍未动工**，等你这次验收。
