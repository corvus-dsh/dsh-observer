# `src/core` 模块登记表（机器核对）

> 权威来源：**本表**。由 `test/module-registry.test.mjs` **双向核对** —— 磁盘上每个
> `src/core/*.ts` 必须有一行；每一行必须指向真实文件；依赖列指向的模块必须存在；且从表本身读出的
> 依赖关系不得成环。
>
> **分母算法**：`readdirSync('src/core').filter(f => f.endsWith('.ts'))`。
> `x.ts.bak-cut` 这类证据文件不以 `.ts` 结尾，天然排除。
>
> 行首写 `core/x.ts`（短），磁盘上是 `src/core/x.ts`；测试比较前会补 `src/` 前缀再比 ——
> 判据是「归一后相等」，不是字面相等。

| 模块 | 职责（一句话） | 导出 | 依赖（本地模块） |
|---|---|---|---|
| `core/binding-store.ts` | 主脑-观察者绑定表：读入内存、原子写回、按对查询 | `createBindingStore`, `BindingStore`, `BindingFsLike` | — |
| `core/announce.ts` | 向宿主宣告会话摘要并断言其形状 | `assertSessionSummary` | — |
| `core/confirmation.ts` | 判定「确认」是否已有真实证据 | `checkConfirmation`, `findAskEvidence` | — |
| `core/ignition.ts` | 点火文本识别与点火超时判定 | `igniteSession`, `isIgnitionText`, `ignitionDeadline` | — |
| `core/monitor.ts` | 按失败连击、停滞轮数与冷却决定催促或收割 | `stepMonitor`, `harvestGate`, `createMonitorState` | — |
| `core/paradise-bridge.ts` | 彼岸层磁盘日志的读取桥接与具名拒绝 | `inspectSessionLog`, `ensureParadise`, `escapeSessionDirName` | — |
| `core/paradise-write.ts` | 彼岸层写通道的懒加载与状态查询 | `ensureWriteAdapter`, `writePathStatus` | `core/paradise-bridge.ts` |
| `core/policy.ts` | 监理任务的文本常量（描述、章节、使命） | `OBSERVER_MISSION_TEXT`, `SPAWN_MAIN_DESCRIPTION` | — |
| `core/read-helpers.ts` | 工作目录继承与 Service 解析的读取助手 | `resolveInheritedCwd`, `isAbsoluteCwd`, `resolveService` | — |
| `core/supervisor.ts` | 监理生命周期：空闲判定、收割结果与重建 | `createSupervisor`, `SUPERVISOR_DUTY_TEXT` | `core/monitor.ts`, `core/ignition.ts` |

**依赖方向**：表里读出的箭头一律指向更底层，`v145` 的第三条断言就是「光凭这张表也不成环」。
