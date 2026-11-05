# dsh-observer — 副脑（跟随者会话）

> **里程碑 `v0.9.0-freeze` → `v1.1.0`（Plan B，2026-11-05）**
>
> 副脑不再由 UI 按钮创建。**入口是主脑的工具 `observer_create`**：模型在对话中调用它，宿主完成创建，`sessionId` 通过工具返回值直接回到模型。UI 上的 chip 已全部删除。

## 核心功能

- **`observer_create`（工具，唯一入口）**：宿主读取主会话自己的 `cwd`，在**同一工作区**创建副脑，标题写成 `[副脑] 跟随 <主会话id>`，并以 `developer/message` 写入 `[系统设定]` 角色说明（**上下文消息，不是 prompt → 副脑保持休眠**），同时写入绑定表。返回值里带 `sessionId`。
- **`observer_bind` / `observer_status` / `observer_consult`（工具）**：手工绑定、只读状态、以及不绑定任何主会话的「前置需求磋商副脑」。
- **`observer-spawn`（斜杠命令 `/observer-spawn <mainId>`）**：给不想让模型代劳的用户留的手动入口；它走命令通道，**每次会留一行**，这是该通道的固有代价。
- **转生跟随**：监听 `graft/session-transferred`，只改一个指针，副脑**永不退休、永不被切片**。

## 路线 A：跟随者指针

副脑在转生链里**不是节点**。主会话切走时只改指针，不参与切片、不退休。这是为了绕开「互相转生」的四个死锁循环：

1. A 退休等 B 转移、B 转移等 A 退休；
2. 两把源锁顺序不一致导致互锁；
3. 转生期间读主日志读到半截；
4. 点火 → 目标又触发自身转生。

## 已知结构性限制（为什么没有按钮）

这是本项目三轮失败后得到的结论，详细复盘见同级文档《副脑插件架构复盘与底层缺陷报告-2026-11-05.md》：

| 编号 | 限制 | 后果 |
|---|---|---|
| **D1** | 第三方 Client **没有插件自有 Remote** | 客户端无法定向、静默地请求本插件做事 |
| **D2** | `commands.execute` **是广播**，且回执形状不稳定 | 任何「请求-应答」控制流都会污染会话流，且拿不到返回值 |
| **D3** | 会话**归属**（workspace/cwd）只有宿主有权威数据 | 客户端建会话必然产生「选择工作区」孤儿页 |

**结论**：副脑只能由**模型工具**（值直达模型）或**宿主侧动作**触发；UI 按钮路线在 0.2.2 上不可行，除非宿主补上插件自有 Remote（typert 构建期声明）。

## 工具一览

| 工具 | 作用 |
|---|---|
| `observer_create` | **主入口**：宿主在主会话同一 cwd 创建副脑，返回 `sessionId` |
| `observer_bind` | 为已存在的会话补写指针（手工/历史场景） |
| `observer_status` | 只读绑定表；`ackFocus: true` 消费一次性焦点请求 |
| `observer_consult` | 开一个不绑定主会话的「前置需求磋商副脑」 |

## 配置

```yaml
- id: dsh-observer
  name: dsh-observer
  config:
    bindingsPath: "C:\\Users\\<you>\\.dsh\\profiles\\<profile>\\data\\dsh-observer\\observer-bindings.json"
```

`bindingsPath` 建议显式给出：desktop 宿主不把 `DSH_PROFILE_DIR` 传给 Electron 主进程，不写会回落到默认路径。

## 测试

```
node scripts/build.mjs && node --test test/*.test.mjs
```

冻结点：**44 / 44**。覆盖：宿主创建（cwd 取自 `session.header.cwd`，`workingDirectory` 兜底，无路径则拒绝且不创建）、标题与物理设定注入、禁止套娃、复用已有副脑、命令注册、空 id 拒绝、客户端无 UI / 无建会话 / 无命令 / 无重命名。

## 许可

MIT
