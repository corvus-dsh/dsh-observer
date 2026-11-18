/**
 * ── v235 (B2-T4): `b2-trigger` 第 2 条 —— 主脑多步工作却从未建图，observer 要纠偏 ──────────────────
 *
 * 用户裁定（`b2-trigger` 节点第 2 条）：
 *   observer supervisor：主脑连续 N 轮没有 `memory_graph_update` 且任务明显多步 ⇒ 纠偏。
 *
 * ── 为什么这是第三条纠偏，而不是把现有两条改一改 ───────────────────────────────────────────────
 *
 * 现有的两条纠偏都在说「你没有让别人看见你的进度」：
 *
 *   failureNudgeText      同一个工具连续失败 3 次 —— 你卡住了
 *   stallNudgeText        TODO 板 5 轮没动 —— 你的板停了
 *   stallWithoutBoardText 你连板都没建 —— 你什么进度都没留下
 *
 * 但有一个**它们都看不见**的形态：主脑一直在推 TODO 板（所以不 stall），一直在真干活（用了三种
 * 以上工具），却**从未建立任务图**。板是「这一轮要做什么」，图是「整个计划里我在哪」——
 * 前者随会话消失，后者跨代存在。`memory_graph_update` 在本仓出现次数为 **0** 直到这次。
 *
 * ── 三个条件是三条独立的守卫，不是一条判据换三种写法 ─────────────────────────────────────────
 *
 *   ① 多步证据   —— 最近窗口里 ≥ `GRAPH_DISTINCT_TOOLS_LIMIT` 种不同工具
 *   ② 无图证据   —— 整个日志里没有一次 `memory_graph_update`
 *   ③ 限额未到   —— 复用冷却 / seq 距离 / 上限，且本条每主脑只发一次
 *
 * 删掉 ① 或 ② 中的任意一条，只有一条测试会红，另一条仍然绿 —— 那正是它们各自独立的证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { monitorInternals } from '../index.js'

const {
  DEFAULT_MONITOR_OPTIONS,
  GRAPH_DISTINCT_TOOLS_LIMIT,
  NUDGE_COOLDOWN_MS,
  NUDGE_MARKER,
  STALL_TURNS_LIMIT,
  createMonitorState,
  describeMonitorState,
  stepMonitor,
} = monitorInternals

/* ── 事件构造器：形状与 `monitor.test.mjs` 一致（宿主自己的事件） ───────────────────── */

let seqCounter = 1000
const nextSeq = () => (seqCounter += 1)

const toolCall = (name, callId) => ({ type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name } })

const toolResult = (callId) => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { message: { isError: false, source: { callId } } },
})

const turnEnd = () => ({ type: 'turn/end', seq: nextSeq(), data: {} })

/**
 * 跑 N 轮，每轮用 `toolsPerTurn` 里的工具各调一次。
 *
 * `clock` 是注入的时钟 —— 这个模块是纯函数、零真实时钟，所以时间也必须由测试掌握；否则
 * 「冷却期」这条根本没法定点验证。
 */
function run({ turns, toolsPerTurn, options = {}, includeGraphCall = false }) {
  const state = createMonitorState()
  const opts = { ...DEFAULT_MONITOR_OPTIONS, now: () => 1_000_000, ...options }
  const actions = []
  let callIndex = 0

  if (includeGraphCall) {
    const id = `pre-${(callIndex += 1)}`
    actions.push(...stepMonitor(state, toolCall('memory_graph_update', id), opts))
    actions.push(...stepMonitor(state, toolResult(id), opts))
  }

  for (let turn = 0; turn < turns; turn += 1) {
    const tools = typeof toolsPerTurn === 'function' ? toolsPerTurn(turn) : toolsPerTurn
    for (const tool of tools) {
      const id = `c${(callIndex += 1)}`
      actions.push(...stepMonitor(state, toolCall(tool, id), opts))
      actions.push(...stepMonitor(state, toolResult(id), opts))
    }
    actions.push(...stepMonitor(state, turnEnd(), opts))
  }
  return { state, actions, opts }
}

const graphNudges = (actions) => actions.filter((action) => action.kind === 'nudge' && action.trigger === 'graph')

/** 三种工具 —— 「多步」的最小证据。 */
const THREE = ['read_file', 'edit_file', 'run_tests']

// ── ⑧ 多步 + 从未建图 ⇒ 产出 kind:'nudge', trigger:'graph' ───────────────────────────────────

test('v235 ⑧: 5 轮用过 ≥3 种工具且从未调 memory_graph_update ⇒ 产出一条 graph 纠偏', () => {
  const { actions } = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: THREE })
  const nudges = graphNudges(actions)
  assert.equal(nudges.length, 1, `必须恰好一条，实测 ${nudges.length}`)
  assert.equal(nudges[0].kind, 'nudge')
  assert.equal(nudges[0].trigger, 'graph')
  assert.match(nudges[0].detail, /从未建立任务图/u)
})

// ── ⑨ 有 memory_graph_update ⇒ 不产出 ───────────────────────────────────────────────────────

test('v235 ⑨: 同样多步，但日志里调过 memory_graph_update ⇒ 不产出（条件 ② 独立生效）', () => {
  const { actions, state } = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: THREE, includeGraphCall: true })
  assert.equal(graphNudges(actions).length, 0, '建过图就不该被要求建图')
  assert.equal(state.sawGraphTool, true)
})

// ── ⑩ 多步证据不足 ⇒ 不产出 ────────────────────────────────────────────────────────────────

test('v235 ⑩: 只用 1 种工具（哪怕是 5 轮）⇒ 不产出（小改不该被要求建图）', () => {
  const { actions } = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: ['read_file'] })
  assert.equal(graphNudges(actions).length, 0, '单工具改一个文件不算多步工作')
})

test('v235 ⑩b: 阈值本身被钉住 —— GO 阈值以下不触发，达到才触发', () => {
  /** 恰好 `limit - 1` 种工具：不够。 */
  const below = ['a', 'b'].slice(0, GRAPH_DISTINCT_TOOLS_LIMIT - 1)
  assert.equal(graphNudges(run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: below }).actions).length, 0)

  /** 恰好 `limit` 种：够。阈值是「至少 N 种」，不是「大于 N 种」。 */
  const at = ['a', 'b', 'c', 'd'].slice(0, GRAPH_DISTINCT_TOOLS_LIMIT)
  assert.equal(graphNudges(run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: at }).actions).length, 1)
})

// ── ⑪ 每主脑只发一次 ───────────────────────────────────────────────────────────────────────

test('v235 ⑪: 同一主脑第二次满足条件 ⇒ 不再产出（这是状态，不是事件）', () => {
  /**
   * 时钟推进到冷却之外，让「不再发」只能由 `graphNudged` 解释 —— 否则这条测试会被冷却伪装成通过，
   * 而冷却一过它又会开始重复。这正是「重复提醒训练读者跳过」要防的。
   */
  let clock = 1_000_000
  const state = createMonitorState()
  const opts = { ...DEFAULT_MONITOR_OPTIONS, nudgeCooldownMs: 1, nudgeMinSeqGap: 1, nudgeCap: 99, now: () => clock }
  let index = 0
  const actions = []
  const turn = () => {
    for (const tool of THREE) {
      const id = `r${(index += 1)}`
      actions.push(...stepMonitor(state, toolCall(tool, id), opts))
      actions.push(...stepMonitor(state, toolResult(id), opts))
    }
    actions.push(...stepMonitor(state, turnEnd(), opts))
  }

  for (let i = 0; i < STALL_TURNS_LIMIT; i += 1) {
    clock += 10_000
    turn()
  }
  const first = graphNudges(actions).length
  assert.equal(first, 1, `第一轮窗口应发一条，实测 ${first}`)

  /** 再跑两倍轮数，时钟每次都推进 —— 冷却与 seq 距离都不再是理由。 */
  for (let i = 0; i < STALL_TURNS_LIMIT * 2; i += 1) {
    clock += 10_000
    turn()
  }
  assert.equal(graphNudges(actions).length, 1, '第二次满足不许再发 —— 否则每 5 分钟重复同一句话')
  assert.equal(state.graphNudged, true)
})

// ── ⑫ 冷却期内不产出 ─────────────────────────────────────────────────────────────────────

test('v235 ⑫: 冷却期内 ⇒ 不产出（复用 NUDGE_COOLDOWN_MS，不新增限额常量）', () => {
  /**
   * 让「别的纠偏」先把冷却用掉，再看 graph 是否被同一个闸门挡住 —— 这证明它复用的是同一套限额，
   * 而不是自己的第二套。
   */
  const state = createMonitorState()
  let clock = 1_000_000
  const opts = { ...DEFAULT_MONITOR_OPTIONS, now: () => clock }
  let index = 0
  const actions = []
  const feed = (name) => {
    const id = `d${(index += 1)}`
    actions.push(...stepMonitor(state, toolCall(name, id), opts))
    actions.push(...stepMonitor(state, toolResult(id), opts))
  }

  /** 前 4 轮：三种工具，但只有 4 轮 —— 窗口还没填满，不该发。 */
  for (let i = 0; i < STALL_TURNS_LIMIT - 1; i += 1) {
    for (const tool of THREE) feed(tool)
    actions.push(...stepMonitor(state, turnEnd(), opts))
  }
  assert.equal(graphNudges(actions).length, 0, '窗口未满，不许提前发')

  /** 第 5 轮：条件满足，但把 now 推进一点点让「冷却」成为唯一可能的拒绝理由。 */
  for (const tool of THREE) feed(tool)
  /** 人为制造「刚刚发过一条」：先让它发，然后时钟只走 1 秒再补一轮。 */
  actions.push(...stepMonitor(state, turnEnd(), opts))
  assert.equal(graphNudges(actions).length, 1, '第 5 轮条件满足，应发一条')

  clock += 1000
  for (const tool of THREE) feed(tool)
  actions.push(...stepMonitor(state, turnEnd(), opts))
  assert.equal(
    graphNudges(actions).length,
    1,
    `冷却 ${NUDGE_COOLDOWN_MS}ms 内不许再发，实测 ${graphNudges(actions).length} 条`,
  )
})

// ── ⑬ 文案 ──────────────────────────────────────────────────────────────────────────────────

test('v235 ⑬: 文案含 NUDGE_MARKER，且点出 memory_graph_update 与 bootstrap', () => {
  const { actions } = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: THREE })
  const text = graphNudges(actions)[0].text
  assert.match(text, new RegExp(NUDGE_MARKER.replace(/[[\]]/gu, '\\$&'), 'u'), '必须带纠偏前缀，读者要能与用户回合区分')
  assert.match(text, /memory_graph_update/u, '必须点名工具')
  assert.match(text, /bootstrap/u, '必须点名 op:bootstrap（从零建整张计划）')
  /** 它引用了自己的测量值，读者可以据此判断这条纠偏是否成立。 */
  assert.match(text, /用过 \d+ 种工具/u)
})

// ── ⑭ describeMonitorState 能报告「本条是否已发过」 ────────────────────────────────────────

test('v235 ⑭: describeMonitorState 报告 graph 触发器的四个事实（哑了还是没到条件，要能区分）', () => {
  const before = describeMonitorState(createMonitorState())
  assert.ok(before.graph !== undefined, '必须有一段 graph 读数 —— 否则运维无法区分「哑了」与「没到条件」')
  assert.equal(before.graph.sawTool, false)
  assert.equal(before.graph.nudged, false)
  assert.equal(before.graph.distinctToolsRecent, 0)
  assert.equal(before.graph.windowTurns, 0)

  const { state } = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: THREE })
  const after = describeMonitorState(state)
  assert.equal(after.graph.sawTool, false)
  assert.equal(after.graph.nudged, true, '发过之后必须能读出来')
  assert.equal(after.graph.distinctToolsRecent, 3)
  assert.equal(after.graph.windowTurns, STALL_TURNS_LIMIT, '窗口轮数被 stallTurns 限制住，不是无限累积')

  /** 另一种「哑」的原因：图已建。两者要靠不同字段区分。 */
  const built = run({ turns: STALL_TURNS_LIMIT, toolsPerTurn: THREE, includeGraphCall: true })
  const builtView = describeMonitorState(built.state)
  assert.equal(builtView.graph.sawTool, true)
  assert.equal(builtView.graph.nudged, false, '建过图 ⇒ 没发过，而且不该发 —— 与「哑了」完全不同')
})