# v1.9.0 报告 — observer 切换至彼岸层（Dogfooding 第一例）

> 日期：2026-11-05
> 版本：`dsh-observer 1.9.0`（**181/181**）· `dsh-paradise 0.3.0`（**122/122**）
> 结论：**写路径已完全走彼岸层；`observer-inject.ts` 保留在盘但不再被调用；零开关、一条活路径。**
> 产物：observer `index.js` 244,425 字节；paradise 156,528 字节。两包 preflight 全绿。

---

## 1. 三个调用点，逐个对照

| 你的要求 | 落地 | 位置 |
|---|---|---|
| `injectColdSession` → `paradise.session.create(items)` | ✅ | `src/core/paradise-write.ts` → `paradise.session.create({ cwd, title, inheritFrom, items })` |
| `igniteSession` → `paradise.session.trigger` | ✅ | `paradise.session.trigger(session, { text, mode })` |
| `rollbackInjectedSession` → `paradise.deleteSession` | ✅ | `paradise.deleteSession(ctx, id, why)` |

**回执映射是刻意保留的**：`briefingRole` / `briefingVisible` / `briefingEventSeq` / `briefingSourceKind`
全部从适配器的 `rendered[]` + `contentSeq` **推导**，不是照抄请求。工具结果与既有测试读的字段没变。

---

## 2. 切换中暴露的两个**真实协议缺陷**

这两个都不是"改一行调用点"能避免的——它们证明**切换本身就是一次协议检验**。

### 2.1 协议 `create` 装不下 plan

第一版把 plan 当 `title` 传，落地成「会话里是它自己的名字，没有工作内容」。测试当场抓到（briefing 逐字比对失败）。

**修法不是绕过，是修协议**：`create` 增加 `items?: ContextItem[]`，理由写进接口注释——

> 顺序写入的宿主上，内容必须在创建时放置；只允许事后 `inject` 的协议在那类宿主上**不可实现**。

### 2.2 运行时旋钮没继承

忘了传 `inheritFrom`，主脑会在**不同** provider/model/preset/权限下开跑——没人会立刻注意，直到账单或权限出意外。

同样修在协议层：`create` 增加 `inheritFrom?: string`，注释写明「继承是协议级关切，不是宿主技巧」。

---

## 3. 一个必须告诉你的**行为变更**

⚠️ **彼岸层从"可选"变成"孵化必需"。**

| 版本 | 缺层时 |
|---|---|
| v1.8.0 | 降级：磁盘核对跳过，**孵化照样成功** |
| **v1.9.0** | **拒绝孵化**：`stage=write-adapter` + `PARADISE_WRITE_UNAVAILABLE` + 原因 + "没有创建任何会话" |

这是"零开关、一条活路径"的必然代价。我删掉了旧断言而不是放宽它，并写了理由：

> 一个假成功（没有方案的主脑、或静默 no-op）比一句清楚的"请安装彼岸层"要坏得多。

**读路径仍是可选**：`inspectSessionLog` 缺层只降级为 `pathSource: 'paradise-unavailable'`。

---

## 4. 真机验收回放（`_scratch/v190-observer-switch.mjs`）

这就是你重启后要验的五件事，按你会看到的顺序：

```
=== 1. 写路径确实是彼岸层 ===
  write adapter resolved             true
  layer bundle name                  dsh-0.2.2
  trigger / delete 可用                true / true
  capabilities.create / trigger      true / true

=== 2. 主脑诞生：方案可见 ===
  ok / stage                         true / inject_success
  briefingRole / Visible             user / true
  方案事件 seq                        3
  tape 序列                            turn/start → step/start → system/message → user/message
                                      → assistant/message → session/title → step/end → turn/end
  承载消息类型                          user/message
  方案逐字一致                          true
  系统头是第一个 surface                system/message

=== 3. 自动点火 ===
  ignition.attempted / ok            true / true
  ignition.channel                   sessionController.prompt(queue)
  prompt 目标 = 主脑                    true
  prompt 模式                         queue

=== 4. 绑定与监理 ===
  pair recorded                      ["incubated"]
  supervisor 已启动                    true

=== 5. 失败：什么都不留 ===
  ok / stage                         false / append
  首次 head                           孵化失败（stage=append）：[CREATE_FAILED] append exploded
  产物已移除                            true
  无残留配对                            true

=== 6. 存档模块 ===
  observer-inject.ts 存在              true
  调用 injectColdSession               false
  调用 igniteSession                   false
  调用 rollbackInjectedSession         false
```

---

## 5. 测试数字：208 → 181，差额去哪了

**不是能力损失，是去处变了。** 原则：**测试必须钉住会执行的那份代码**；钉住归档模块的测试，等于给死人做体检。

| 原位置 | 条数 | 现在 |
|---|---|---|
| `cold-inject.test.mjs` | 24 | 重写为 11 条（断言**新路径**的属性）+ 迁入 paradise |
| `ignition.test.mjs` | 19 | 重写为 9 条（经回执断言）+ paradise `write-lifecycle` |
| `visibility.test.mjs` 的 tape 断言 | 4 | 迁入 `dsh-paradise/test/shape-validation.test.mjs`（**18 条**） |

两包合计：**切换前 312 → 切换后 303**，但 `shape-validation` 用 18 条覆盖了原来 4 条的内容
（每个 code 一条独立断言），所以**实际覆盖更细，不是更少**。

### 新增的 preflight 守卫（三项，都是这次切换特有的）

- 产物里写路径必须经 `ensureWriteAdapter → createDshAdapters`；
- 缺层时必须 `PARADISE_WRITE_UNAVAILABLE`（不允许静默 no-op 或崩溃）；
- **`src/index.ts` 不得再调用任何归档写函数** —— 这条直接防"迁移做了一半"。

---

## 6. 深挖出来的一处活代码遗留

验收脚本第 6 组最初报 `igniteSession` 仍被调用。查证后发现：它在 `ignitionInternals` 里被导出，
而**旧 ignition 测试已被我重写、无人再使用它**。

这不是测试失败，是**bundle 里还带着第二份点火实现**——正是彼岸层要消灭的重复。
已移除其余五个导出，只留 `DEFAULT_IGNITION_PROMPT` 与 `IGNITION_MARKER`（前者仍被传给 trigger）。

> 这件事值得记下来：**切换完成后，"没人用但还在"的导出是最难发现的遗留**。
> 测试全绿不会告诉你它存在，只有"数一数谁在调用"会。

---

## 7. 两包状态

| 包 | 测试 | preflight | 产物 |
|---|---|---|---|
| `dsh-paradise 0.3.0` | **122 / 122** | 全绿 | 156,528 字节 / 21 模块 |
| `dsh-observer 1.9.0` | **181 / 181** | 15 项全绿 | 244,425 字节 / 8 模块 |

`graft-slice`：**一行未动**。

---

## 8. 重启后请这样验收

```
1. 宿主日志应出现： [dsh-paradise] layer version 0.3.0 (P1: read + protocol)
2. 宿主日志应出现： [dsh-observer] host version 1.9.0
3. 孵化一次主脑（先说「制定计划」，点确认卡片）
4. 看新窗口：方案应作为一条可见消息出现，且主脑立刻开始干活
5. 回执里应有：
     stage: inject_success
     注入：8 个事件，角色=user（会话里可见）
     自动点火：已触发（via sessionController.prompt(queue)）
     磁盘日志：<字节> / <帧数> 个 zstd 帧 / 8 个事件
```

**判定要点**：这次点火是从**彼岸层的 trigger** 发出的，注入是彼岸层的 **create** 写的。
如果第 4 步主脑没带方案，或方案出现在系统提示而不是聊天流里，那说明映射有问题——请把回执原文发我。

---

## 9. 诚实边界

1. **彼岸层现在是硬依赖**（见 §3）。这是本次切换最重要的一条，必须让你知道。
2. **`observer-inject.ts` 仍被 inlined**，因为两个只读助手还在里面（cwd 供体链、`InjectError`）。想彻底移出得先搬走它们——那是下一次清理。
3. **`inject`（向已存在会话追加）仍未接线**，层里如实报 `NOT_WIRED`。
4. **`injectIntoRunning` 仍为 false**，纠偏走的是 `prompt(steer)`，与本条无关。
5. **测试数下降是搬移不是删除**（见 §5），但如果你认为"数字不能降"是硬指标，我可以把 paradise 的 shape-validation 拆细到 30+ 条来对齐——我不建议，因为那是在凑数字。

---

## 10. 本轮改动的文件

```
新增  dsh-observer/src/core/paradise-write.ts      写路径的唯一入口（懒加载 + 具名降级）
改    dsh-observer/src/index.ts                    三个调用点切换；stageError 统一错误形状；清理死导出
改    dsh-observer/src/core/paradise-bridge.ts      暴露整个 layer 给写路径
改    dsh-observer/scripts/preflight.mjs           新增三项切换守卫
改    dsh-observer/{package,manifest}.json         1.9.0；依赖从 optional 改为 REQUIRED(写路径)
改    dsh-observer/README.md                       v1.9.0 章节 + 行为变更说明
重写  dsh-observer/test/cold-inject.test.mjs       断言新路径（11 条）
重写  dsh-observer/test/ignition.test.mjs          经回执断言（9 条）
改    dsh-observer/test/visibility.test.mjs        tape 断言迁出，保留回执断言（7 条）
改    dsh-observer/test/paradise-bridge.test.mjs   缺层行为断言改为"拒绝孵化"
改    dsh-observer/test/self-audit.test.mjs        stage 名从 validate→verify
改    dsh-observer/test/harness.mjs                rollback 钩子改为真正删除（fixture 缺陷）
改    dsh-paradise/src/protocol/adapters.ts        create 增加 items? 与 inheritFrom?
改    dsh-paradise/src/adapters/dsh/session.ts     透传 items / inheritFrom
改    dsh-paradise/src/adapters/dsh/inject.ts      导出 SURFACE_TYPES
改    dsh-paradise/src/index.ts                    新增 writeShapeInternals 接缝
新增  dsh-paradise/test/shape-validation.test.mjs  18 条（迁入的 tape 断言）
新增  _scratch/v190-observer-switch.mjs            真机验收回放
```
