# v1.5.0 修复报告 — 可见性 + 自动点火

> 日期：2026-11-05
> 版本：`dsh-observer v1.5.0`
> 结论：**可见性问题的根因是我自己上一轮加的标记；自动点火已按 graft 的 AbortController 契约移植。**
> 测试 143 → **162 全绿**，preflight 9 项 OK，构建字节可复现。
> **产物指纹**：`index.js` **173,880 字节**，sha256 前 16 位 **`6e6e6f530154ec54`**。

---

## 0. 先纠正我上一轮的一个错误结论

上一轮我把 `projectSessionConversation` 当成了"UI 的会话投影"，据此断言"宿主不渲染 `developer/message`"。

**这个归因不准确。** 我重读了调用链：`projectSessionConversation` 属于 **`dsh-session-reference`** 模块（第 8 行 / `lib/index.js` 第 126 行），它的用途是**跨会话引用的快照投影**——被 `retainReferencedSession`（第 45 行）使用，服务于 session-reference 的参考块，**不是聊天流的渲染器**。

真正的证据链只有两条，但它们已经足够：
1. **graft 的实测结论**（README 原文）：「`assistant/message` 是 DSH 会渲染的 surface；早先尝试的 `developer/message` 在桌面端不可见」；
2. **你的验收截图**：主脑思考里读得到方案（`The user asked: "帮我梳理…先制定计划…"`），UI 上看不到。

**但 `projectSessionConversation` 那段代码仍然解释了一件事**——它第 14 行是：

```js
case 'user/message': {
    const checkpoint = isCompactCheckpointSource(event.data.source);
    if (!checkpoint && event.data.source.kind !== 'user')
        break;
```

**我的 `plugin:observer-briefing` 标记，恰好就是这个 `kind !== 'user'` 的丢弃条件。** 我 v1.3.1 为了"别被当成真人发言"加的标记，在一个读 `source.kind` 的地方等于说"别显示这条"。同一个正确目标，放错了层。

---

## 1. 修复一：可见性改成 graft 的完整形状

### 1.1 关键认识：**来源标记放错层了**

| | 旧（v1.3.1–1.4.0） | 新（v1.5.0） |
|---|---|---|
| `source.kind` | `plugin:observer-briefing` | **`user`**（渲染器只认这个） |
| 归属标记 | 在 source 上 | **在 message id 上**：`observer-briefing-<sessionId>` |
| `rpcId` | 无 | **明确禁止带**（那是真人 prompt 的标记） |

`source.kind` 是**给渲染器看的**，`id` 是**给我们看的**。把归属写在渲染器读的字段上，等于主动隐藏它。

### 1.2 形状改成 graft 那一对

graft 的交接是**两条消息**：目标是 `user/message`，卡片是 `assistant/message`。我现在也是：

```
seq=0 turn/start
seq=1 step/start
seq=2 system/message      surfaceOp=append  role=system    source=system-prompt
seq=3 user/message        surfaceOp=append  role=user      source=user      ← 方案（可见）
seq=4 assistant/message   surfaceOp=append  role=assistant source=model     ← 同一份方案的回显（渲染）
     stream=[]
seq=5 session/title
seq=6 step/end
seq=7 turn/end
```

**诚实的代价**：方案在对话里出现两次（一次像用户说的，一次像助手说的）。这是在一个"渲染器与模型上下文对哪些角色算对话意见不一致"的宿主里换取可见性的成本，我没有藏起来。

### 1.3 校验器同步加严

- 可见形的 `source.kind` 必须**恰好是 `user`**（否则 `BRIEFING_NOT_RENDERABLE`）；
- 必须带 `observer-briefing-` id 前缀（`RED_LINE_BRIEFING_PROVENANCE`）；
- **禁止带 `rpcId`**（`RED_LINE_BRIEFING_PROVENANCE`）；
- 可见形必须配 `assistant/message` 回显，且 `stream: []`、`source.kind` 不得是 `plugin`（`MISSING_ECHO` / `RED_LINE_ECHO_*`）；
- 冷读重跑同一套校验（v1.3.2 的做法保留）。

---

## 2. 修复二：自动点火

移植自 `dsh-graft-slice` 的 `igniteTargetSession`，**连同它踩过的三个坑一起搬**（这些是花钱买来的）：

### 2.1 signal 是**必传**参数

```ts
// 0.2.2-rc.1 的 prompt(request, signal) 第一行就 touch signal.throwIfAborted()
// v0.31 传了 undefined，于是每次点火都在 prompt 被受理之前就死了，
// 唯一症状是一行审计日志 "Cannot read properties of undefined (reading 'throwIfAborted')"
channels.push(['sessionController.prompt', (signal) => service.prompt(request(), signal)])
```

我加了测试：**断言第二参数是真实的 `AbortSignal` 实例**，且在 prompt 内部真的调用 `signal.throwIfAborted()`。

### 2.2 幂等：不能点火两次

`alreadyIgnited()` 读主脑**自己的日志**找 `[dsh-observer 点火]` 标记。排队的重复 prompt 会让主脑把同一条指令读成两次用户意图。

### 2.3 「读不到」≠「已点火」

这是 graft v0.32 P0 的原话：*an unknown used to return `true`, i.e. "already ignited". That turned a failed READ into a reported SUCCESS, so the queue entry was deleted and the target was never woken.*

我的实现：
- **missing session** → `false`（没点火过，去点）；
- **其它读失败** → **抛错 → 报失败**，交给调用方决定重试；
- 绝不把"不知道"报成"已完成"。

### 2.4 点火失败**不回滚**孵化

主脑已经创建、有方案、可手动打开。因为一次 prompt 超时就把一个好产物烧掉，比让用户点一下更糟。失败写进 `problems` 和 `ignition` 字段，日志里也有一条 warn。

点火时机：**冷读校验通过 + 配对记录落盘之后**（graft 是 flush 之后 + 退休之后）。如果先点火，主脑可能在任何东西知道它存在之前就开始工作并失败。

---

## 3. 返回给模型的证据

```
stage: inject_success
已孵化主脑 session-…（cwd=… via sessions.get().header.cwd）。
注入：8 个事件，角色=user（会话里可见），冷读校验 通过。
方案事件：seq=3，source.kind="user"，属于会话会渲染的类型。
自动点火：已触发（via sessionController.prompt）
磁盘日志：…
```

字段化：`ignition: {attempted, ok, channel, promptChars}`、`briefingRole`、`briefingVisible`、`briefingEventSeq`、`briefingSourceKind`、`diskLog`。

---

## 4. 测试（162 / 162）

新增 `test/ignition.test.mjs`（19 条）：

| 组 | 盯什么 |
|---|---|
| prompt / marker | 提示词要求"直接开始、别复述、别问要我做什么"；自定义 prompt 自动补标记且不重复 |
| **signal** | 第二参数必须是真 `AbortSignal`，且能 `throwIfAborted()` |
| **幂等** | 日志有标记 → 一次都不点；没标记 → 点一次 |
| **unknown** | 读失败 → 报失败且不点；session not found → 点 |
| 通道 | controller 优先、Remote 兜底；无通道要明说；`accepted:false` 算拒绝 |
| deadline | 超时会 abort 并说明；挂死的 prompt 不会阻塞孵化 |
| 回执 | 成功带 `ignition.ok`；**无通道时孵化仍成功**且明说"可手动打开" |

形状相关测试同步更新：事件数 7→8、`source.kind` 改断言 `user`、归属改断言 id、surface 序列加 `assistant/message`。

---

## 5. 重启后请这样验收

| 步骤 | 期望 |
|---|---|
| 让它「制定计划并孵化主脑」 | 返回 `自动点火：已触发（via sessionController.prompt）` |
| **打开主脑** | ① 会话里**看得见**方案（灰底）；② 它**自己开始跑**，不需要你发"请继续" |

判定要点：
- 方案应出现**两次**（一次用户侧、一次助手侧）。这是预期的，不是 bug。
- 若方案仍不可见：把 `diskLog` 段贴回来。
- 若没有自动跑：看 `自动点火：失败 —— …` 的原因，或日志里 `[dsh-observer] ignition FAILED for …`。

---

## 6. 诚实边界

1. **我无法在代码里确认 UI 一定渲染。** 我能确认的是：tape 里有 `user/message`（`kind:user`）+ `assistant/message`（`stream:[]`），这正是 graft 在真机上被证明可见的那一对形状。最终一眼仍然只能由你看。
2. **`user/message` 的 `id` 不是宿主契约字段**，只是我们自己用来存归属的。若宿主将来校验 message id 格式，`observer-briefing-*` 可能需要调整——但它是自由字符串，风险低。
3. **点火只做一次、不排队重试**（graft 有 `.graft-pending-ignition.json` 持久队列）。若这次 prompt 因宿主忙而失败，需要用户手动打开或重新孵化。这是本轮的范围边界，不是无意遗漏。
4. `dsh-graft-slice` 本轮**未改动**（542/542，`git status` 干净）。
5. 第二项（副脑持续监控 + memory_harvest）和第三项（dsh-paradise P1）**尚未动工**，等这次验收后再开始。
