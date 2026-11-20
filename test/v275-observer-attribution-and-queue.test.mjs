/**
 * ── v275 (B4-0b-2 W2-3 / W2-4): SAME TOOL vs SAME NOTHING, AND SPENDING IS NOT DELIVERING ──────
 *
 * ── W2-3: four DIFFERENT failures used to look like one repeated failure ──────────────────────
 *
 * `monitor.ts` resolved a tool name from the result's `callId`. When a result carried no `callId`,
 * `tool` stayed `''` and every such failure was filed under the SAME label, `'(unknown)'`. Four
 * different tools failing once each — four unrelated problems — therefore produced a four-long
 * "(unknown) streak" and a correction asserting the main had retried one tool repeatedly.
 *
 * That sentence is false, and it is false in the direction that destroys trust in the supervisor: the
 * main had not retried anything. The streak's entire meaning is SAMENESS, and sameness is exactly what
 * an unattributed result cannot establish. So it is counted separately (`unattributedResults`, shown
 * in `observer_status`) and never compared.
 *
 * ── W2-4: a correction skipped because the channel was busy still cost a slot ──────────────────
 *
 * `monitor.ts` increments `nudges` when it DECIDES. The busy guard in `supervisor.ts` ran later and
 * threw the action away. The main never saw the hint, `observer_status` counted it as given, and one
 * of the four corrections it is ever allowed was gone. Fix: queue and drain, never discard — because
 * only the delivery can say whether a correction happened.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { monitorInternals, supervisorInternals } from '../index.js'

const {
  DEFAULT_MONITOR_OPTIONS,
  createMonitorState,
  describeMonitorState,
  stepMonitor,
} = monitorInternals
const { createSupervisor } = supervisorInternals

const NO_TIMER = { setTimer: () => ({ unref() {} }), clearTimer: () => {} }
const NO_SPACING = { nudgeCooldownMs: 0, nudgeMinSeqGap: 0, now: () => 1_000_000 }

let seq = 4_000
const nextSeq = () => (seq += 1)
const toolCall = (name, callId) => ({ type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name } })
/** A failure whose result carries NO `callId` — the shape that used to collapse into one label. */
const unattributedFailure = () => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { turn: 1, step: 1, message: { isError: true, content: [{ type: 'text', text: 'boom' }] } },
})
const attributedFailure = (callId) => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { turn: 1, step: 1, message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } } },
})

// ── ① four different tools, no callId ⇒ ZERO corrections ────────────────────────────────────

test('v275 ①: 四个不同工具各失败一次（结果无 callId）⇒ 0 条纠偏，且单独计数', () => {
  const options = { ...DEFAULT_MONITOR_OPTIONS, ...NO_SPACING }
  const state = createMonitorState()
  const actions = []
  for (const name of ['pwsh', 'read', 'write', 'grep']) {
    actions.push(...stepMonitor(state, toolCall(name, `call-${name}`), options))
    actions.push(...stepMonitor(state, unattributedFailure(), options))
  }
  assert.equal(
    actions.filter((action) => action.kind === 'nudge').length,
    0,
    `四个不同工具不许被当成同一工具的四连击；actual: ${JSON.stringify(actions)}`,
  )
  assert.equal(state.unattributedResults, 4, '无法归因的结果必须被数出来，不是被丢掉')
  assert.equal(state.nudges, 0, '没有任何纠偏被发出')
  assert.equal(describeMonitorState(state).unattributedResults, 4, '状态面板也要看得见')
})

// ── ② the same tool WITH a callId still forms a streak (the check did not blunt the rule) ────

test('v275 ②: 同一工具有 callId 三连失败 ⇒ 仍然恰好一条纠偏（规则没被削钝）', () => {
  const options = { ...DEFAULT_MONITOR_OPTIONS, ...NO_SPACING }
  const state = createMonitorState()
  const actions = []
  for (let round = 0; round < 3; round += 1) {
    actions.push(...stepMonitor(state, toolCall('pwsh', `same-${round}`), options))
    actions.push(...stepMonitor(state, attributedFailure(`same-${round}`), options))
  }
  const nudges = actions.filter((action) => action.kind === 'nudge')
  assert.equal(nudges.length, 1, '同工具三连仍必须纠偏 —— 否则①只是把门禁关掉了')
  assert.match(nudges[0].text, /pwsh/u)
  assert.equal(state.unattributedResults, 0, '有归因的结果不进这个计数')
})

// ── ③ a burst while the channel is busy: every spent slot must be delivered ────────────────

test('v275 ③: 投递慢（150ms）时并发喂事件 ⇒ 已扣的配额必须全部投出，不许丢弃', async () => {
  const delivered = []
  const controller = {
    prompt: async (request) => {
      /** 150 ms is the delay the dispatch names; it is enough to make the second batch see `busy`. */
      await new Promise((resolve) => setTimeout(resolve, 150))
      delivered.push(request.content.map((part) => part.text).join(''))
      return { accepted: true }
    },
  }
  const supervisor = createSupervisor('obs-9', 'main-9', {
    controller,
    options: NO_SPACING,
    ...NO_TIMER,
  })

  /** Fire everything at once: two corrections worth of failures, deliveries deliberately slow. */
  const fires = []
  for (let round = 0; round < 6; round += 1) {
    fires.push(supervisor.observe(toolCall('pwsh', `burst-${round}`)))
    fires.push(supervisor.observe(attributedFailure(`burst-${round}`)))
  }
  await Promise.all(fires)
  supervisor.dispose()

  /**
   * THE ASSERTION W2-4 IS ABOUT: the budget was charged when the decision was made, so the number of
   * REAL `prompt` calls must equal it. A dropped action shows up here as `delivered < nudges`.
   */
  assert.equal(supervisor.state().nudges, 2, '两次决策 ⇒ 预算被扣两次')
  assert.equal(delivered.length, 2, `两次扣账必须有两次真实投递；actual: ${delivered.length}`)
  assert.ok(delivered.every((text) => text.includes('纠偏') || text.length > 0), '投出去的是真文案，不是空串')
})

// ── ④ a single slow delivery is not duplicated by the drain ─────────────────────────────────

test('v275 ④: 队列排空不会重复投递同一条（一次决策 = 一次投递）', async () => {
  const delivered = []
  const controller = {
    prompt: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      delivered.push(request.content.map((part) => part.text).join(''))
      return { accepted: true }
    },
  }
  const supervisor = createSupervisor('obs-10', 'main-10', { controller, options: NO_SPACING, ...NO_TIMER })
  for (let round = 0; round < 3; round += 1) {
    await supervisor.observe(toolCall('pwsh', `solo-${round}`))
    await supervisor.observe(attributedFailure(`solo-${round}`))
  }
  supervisor.dispose()
  assert.equal(delivered.length, 1, '顺序投递只该有一条')
  assert.equal(supervisor.state().nudges, 1)
})