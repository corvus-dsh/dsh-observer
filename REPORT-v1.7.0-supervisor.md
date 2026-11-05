# v1.7.0 修复报告 — 副脑成为监理（监控 + 记忆维护）

> 日期：2026-11-05
> 版本：`dsh-observer v1.7.0`
> 范围：你这次要求的**第一项**（P1 监控与记忆维护）。第二项（dsh-paradise P1）未动工，等你验收后再开。
> 测试 **179 → 206 全绿**（新增 27 条），preflight 9 项 OK，`index.js` 与 src 字节可复现。
> 产物指纹：`index.js` **229,933 字节**，7 个内联模块。

---

## 1. 你要求的两件事，各自的落点

| 你的原话 | 实现 | 可核验处 |
|---|---|---|
| 「监听主脑的 session/event（只读）」 | `session/event` 监听器先喂监理，再走原有的 title 绑定逻辑 | `src/index.ts` 的 `supervised.observe(event)` |
| 「连续 3 次执行相同的失败工具」 | 按 **callId → 工具名**归因，同一工具连续 3 次失败 → **一条**纠偏 | `src/core/monitor.ts` `stepMonitor()` |
| 「连续 5 轮没有推进 TODO」 | 按 `todo_write` 的**内容签名**判定；重写同一份清单不算推进 | 同上 `todoSignature` |
| 「主动给主脑发一条提示」 | `sessionController.prompt(..., { mode: 'steer' })`，失败退化 `queue` | `src/core/supervisor.ts` `deliver()` |
| 「完成任务时静默调用 memory_harvest」 | 清单全完成 → `completed`；安静 90 秒 → `idle` | `harvestGate()` |
| 「被切片替换时」 | **切片主脑时先提炼退役的那个 id，再重建监理** | `resupervise()` |

---

## 2. 三个我认为必须由代码而不是提示词承担的判断

### 2.1 纠偏绝不写主脑日志

这是本次唯一的硬技术约束。`developer/message` 是 step-scoped，宿主按该会话**当前打开的
turn/step** 校验（`requireStep`）；监理无从得知那一对，而 `{turn: 0, step: 0}` 正是 v1.2.2
被整批拒绝的写法。所以投递走宿主自己的 `prompt(steer)`：它落进**正在进行的回合**，
turn/step 归宿主管。

测试 `delivery: it NEVER appends to the main log` 断言这一点：3 次失败后，主脑的 append 计数
**为 0**，而 `prompts` 里恰好一条 `mode: 'steer'`。

### 2.2 「完成」和「提炼到」是两件事

`memory_harvest` 读的是交接账本里的**已退休**会话。活着的主脑不在账本里，所以
`completed` / `idle` 两条路**通常提不出主人公正脑的东西**。如果回执只写「记忆已提炼」，
这就是又一次假成功。实际回执长这样：

```
扫描 N 个已退休会话，本次没有主脑 <id> —— 它还活着，
它的这一轮会在被切片（退休）后自动进入提炼队列
```

真正能提炼到的是 `replaced`（切片）那条。所以**切片路径绕过冷却**（一个主脑只一次），
因为那是一次性窗口：错过了，账本条目会被 `harvestLimit` 挤掉，飞轮就永久丢了这一轮。

### 2.3 三道限流，缺一不可

一个会刷屏的监理比没有监理更糟。所以：

- **冷却** 5 分钟（墙钟）
- **日志距离** ≥ 12 个事件（一次 resume 能在一秒内追加百条，只看墙钟等于按秒唠叨）
- **硬上限** 4 次/主脑（到顶就停，唠叨不是监督）

测试里有一组循环跑 7 轮连击，断言**恰好 4 条**纠偏，之后是静默。

---

## 3. 实测回放（`_scratch/v170-acceptance.mjs`，驱动真实 index.js）

```
=== 1. 孵化：监理是否随之启动 ===
  ok                           true
  ignition                     true via sessionController.prompt
  confirmation                 asked
  supervisors                  session-af3a49de-…
  initial nudges/harvests      0 / 0

=== 2. 连续 3 次同工具失败 ===
  prompts sent                 1
  mode                         steer
  target                       session-af3a49de-…        ← 发给主脑，不是副脑
  text head                    "[dsh-observer 纠偏] 检测到连续 3 次相同的工具失败（pwsh）。"
  appends to MAIN log          0 (out-of-band, never a log write)
  appends to OBSERVER          5 (turn/start, step/start, developer/message, step/end, turn/end)

=== 3. 第 4 次失败（冷却）与一次成功（清零）===
  prompts after 4th failure    1                          ← 冷却生效，没有第二条
  failure streak after success null                       ← 成功真的清零了连击

=== 4. 完成清单 → 后台提炼 ===
  memory_harvest calls         1
  limit                        3
  harvests recorded            1

=== 5. 主脑被切片 → 提炼退役的那个会话 ===
  supervised after slice       session-main-2             ← 旧 id 已被清掉，不再指向退役会话
  harvest calls total          2                          ← 切片多了一次提炼
```

副脑那一侧收到的是**一条关闭骨架**（turn/start → … → turn/end，共 5 个事件），
其中 `developer/message` 是原有的 `[系统设定]` 加上新增的**监理职责**：

> 你现在不是执行者，你是这个主脑的**监理**。…1. 失败纠偏… 2. 记忆提炼… 3. 只读判断…

---

## 4. 测试（206 / 206）

新增 `test/monitor.test.mjs`（27 条），分两半：

| 组 | 盯什么 |
|---|---|
| **纯决策**（16 条） | 3 次才触发、2 次不算、成功清零、不同工具各自计数、纠偏文案含工具名与 `memory_search`；5 轮才触发停滞、**重写同一份清单不算推进**、失败的 `todo_write` 不改状态；冷却 / 日志距离 / 上限三道限流；提炼闸门的三种拒绝各自有名字；todo 解析覆盖四种 payload 形状 |
| **投递与接线**（11 条） | steer 模式且发给主脑；**主脑日志 append 恒为 0**；无通道时**报错而不是静默**；steer 被拒不丢提示（退化 queue）；`memory_harvest` 的 limit 与"提炼了谁"；没有 dsh-memory 不影响监理；孵化后监理出现在 `observer_status`；职责文本真的写进副脑；主脑切片后**提炼旧 id 并重建**；**切副脑不占用切片提炼的名额**；**重启后旧配对自动恢复监理** |

回归：187 → 203 → 205 → 206，全绿。preflight：版本一致、无 BOM、无残留相对 import、
schema 在 Loader 子集内、5 个工具都有 `output` 契约、`inject ↔ manifest.services` 一致、
`index.js` 与 fresh build 字节相同。

---

## 5. 重启后请这样验收

| 步骤 | 期望 |
|---|---|
| 1. 孵化一个主脑后调 `observer_status` | 返回里出现 `supervisors: { "<主脑 id>": { mainSessionId, observerSessionId, nudges: 0, harvests: 0, … } }` |
| 2. 让主脑连续失败同一个工具 3 次 | 主脑会话里出现一条 `[dsh-observer 纠偏]` 消息，**UI 可见**（steer 是正常消息） |
| 3. 紧接着再失败一次 | **没有**第二条（冷却中） |
| 4. 让主脑的 TODO 全部完成并结束回合 | 宿主日志出现 `[dsh-observer] 后台提炼：…`，回执如实说明有没有提炼到它 |
| 5. 切片主脑 | 宿主日志出现 `监理已重建`，`observer_status` 的 key 变成新 id |
| 6. 重启后再调 `observer_status` | 旧配对的 `supervisors` 条目还在（`events: 0`，表示没有重放历史） |

**关键判定**：第 4 步如果日志写的是「本次没有主脑 X —— 它还活着」，那**不是 bug**，是实话：
账本里还没有它。等它被切片（第 5 步）时才会真正提炼到。

---

## 6. 诚实边界

1. **重启后旧配对会自动恢复监理，但"恢复"≠"接着盯"。** `apply()` 时按 `observer-bindings.json`
   里的配对重建监理（只有内存表，不回溯日志），所以状态从 0 开始：连击数、停滞轮数、已提炼标记
   都是空的。一个在上个进程里已经失败两次的主脑，重启后再失败一次就会立刻触发纠偏。
2. **`replaced` 那条路依赖 graft 真的发了 `graft/session-transferred`。** 若切片由别的路径完成
   （手动删日志等），监听器不会响，那一轮就不会提炼。
3. **空闲 90 秒是墙钟，不是语义。** 一个跑了 3 分钟的长工具调用期间会被判"空闲"，
   此时 `idle` 提炼会跑一次（闸门只拦重复，不拦"其实还活着"）。我选了宁可多扫一次也不漏。
4. **`dsh-paradise` P1 一行没动。** 你要求"先完成第一项，跑通测试"，我按字面执行了。

---

## 7. 本轮改动的文件

```
dsh-observer/src/core/monitor.ts        新增  — 纯决策状态机（可脱宿主测试）
dsh-observer/src/core/supervisor.ts     新增  — 投递 + 提炼 + 空闲计时
dsh-observer/src/index.ts               改    — 接线：孵化启动监理、切片先提炼再重建、挂载时恢复、status 暴露
dsh-observer/test/monitor.test.mjs      新增  — 27 条
dsh-observer/test/harness.mjs           改    — fixture 支持 memory_harvest；live 会话接受合法骨架
dsh-observer/index.js                   重建  — 229,933 字节
dsh-observer/package.json / manifest.json  改  — 1.6.0 → 1.7.0，redLines/notes 补齐
dsh-observer/README.md                  改    — v1.7.0 结构说明
_scratch/v170-acceptance.mjs            新增  — 上面的实测回放
```
