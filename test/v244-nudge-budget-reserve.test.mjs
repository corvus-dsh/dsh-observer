/**
 * ── v244 (B4-0b-1 A1): the graph trigger keeps one slot of the SHARED nudge budget ───────────────
 *
 * The audit's C-1, verbatim: `monitor.ts:374` `if (state.nudges >= options.nudgeCap) return …` is
 * checked by all three triggers, and `nudgeCap` is 4. So a main that collected failure corrections
 * spent the budget on sentences about TOOLS, and then the one sentence about the missing PLAN could
 * never be delivered. Worse, `observer_status` reported `graph.nudged:false` beside
 * `distinctToolsRecent:3` — a reading that says "no graph needed" while the truth was "no graph
 * correction can be sent".
 *
 * ── the rule this file pins ────────────────────────────────────────────────────────────────────────
 *
 * The total a main can ever receive is UNCHANGED (still `nudgeCap`). What changes is that the LAST
 * slot belongs to the graph trigger: every other trigger may use `cap - 1`. Justification: the graph
 * trigger is once-per-main by construction (`graphNudged`), so its own bound is tighter than any cap;
 * what it lacked was not a budget but a guarantee that another trigger could not spend the last one.
 *
 * ── why ⑫ was not enough ──────────────────────────────────────────────────────────────────────────
 *
 * `v235:138` sets `nudgeCap: 99` in its 「每主脑只发一次」case. That is correct FOR THAT CASE (it wants
 * the cap out of the way so `graphNudged` is the only explanation) but it is exactly why the suite
 * could not see this defect: with the cap at 99, exhausting the budget is not expressible.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { monitorInternals } from '../index.js'

/**
 * The pure decision machine, read through the same seam `v235` uses (`monitorInternals`).
 * `v245`-style rule: the seam exists so a test can drive the real state machine with a fixed clock;
 * it is not a second implementation, and the supervisor calls the very same functions.
 */
const { createMonitorState, DEFAULT_MONITOR_OPTIONS, describeMonitorState, stepMonitor } = monitorInternals

const TOOLS = ['read_file', 'edit_file', 'run_tests']
const STALL = DEFAULT_MONITOR_OPTIONS.stallTurns
const STREAK = DEFAULT_MONITOR_OPTIONS.failureStreak

/** A fixed-timestep harness: every event advances the injected clock, so cooldowns are pinnable. */
function harness(overrides = {}) {
  let clock = 1_000_000
  let seq = 0
  const state = createMonitorState()
  const options = {
    ...DEFAULT_MONITOR_OPTIONS,
    nudgeCooldownMs: 1,
    nudgeMinSeqGap: 1,
    now: () => clock,
    ...overrides,
  }
  const actions = []
  const tick = () => {
    clock += 1_000
    seq += 1
    return seq
  }
  const send = (event) => actions.push(...stepMonitor(state, { seq: tick(), ...event }, options))

  return {
    state,
    options,
    actions,
    send,
    /** One failed tool call: `STREAK` of these in a row trips the failure trigger. */
    failedCall(name = 'edit_file') {
      const callId = `f${(seq += 1)}`
      send({ type: 'tool/call', data: { callId, name } })
      send({ type: 'tool/result', data: { message: { source: { callId }, isError: true } } })
    },
    /** One turn that used three distinct tools — the multi-step evidence. */
    multiStepTurn() {
      for (const tool of TOOLS) {
        const callId = `t${(seq += 1)}`
        send({ type: 'tool/call', data: { callId, name: tool } })
        send({ type: 'tool/result', data: { message: { source: { callId } } } })
      }
      send({ type: 'turn/end', data: {} })
    },
  }
}

const nudgesOf = (actions, trigger) => actions.filter((action) => action.kind === 'nudge' && action.trigger === trigger)

test('v244 ①: 配额被别的触发器吃光之后，graph 纠偏仍然发得出（预留给它一个名额）', () => {
  const h = harness()
  /**
   * Spend the budget the way the defect described: repeated failures. `nudgeCap` defaults to 4 and
   * every other trigger may use `cap - 1 = 3`, so this stops after the third one — and the FOURTH
   * attempt is refused with `cap`, which is what must be visible in the readout (② asserts that).
   */
  for (let i = 0; i < 6; i += 1) {
    for (let k = 0; k < STREAK; k += 1) h.failedCall()
  }
  const failureNudges = nudgesOf(h.actions, 'failure')
  assert.equal(failureNudges.length, h.options.nudgeCap - 1,
    `其它触发器只该用掉 cap-1 个名额，实测 ${failureNudges.length}`)

  /** Now the case that used to be impossible: multi-step work with no graph, after a spent budget. */
  for (let turn = 0; turn < STALL; turn += 1) h.multiStepTurn()

  const graph = nudgesOf(h.actions, 'graph')
  assert.equal(graph.length, 1,
    'graph 纠偏在「配额已被吃光」之后必须仍能发出 —— 它就是那条唯一跨会话的提示')
  assert.equal(h.state.graphNudged, true)

  /** The total is unchanged: the reservation moves the last slot, it does not add one. */
  assert.equal(h.state.nudges, h.options.nudgeCap, `总条数仍应受 ${h.options.nudgeCap} 约束，实测 ${h.state.nudges}`)
})

test('v244 ②: `blockedBy` 说出「哑了」与「不需要」的区别 —— 配额耗尽时是 cap', () => {
  const h = harness()
  for (let i = 0; i < 6; i += 1) {
    for (let k = 0; k < STREAK; k += 1) h.failedCall()
  }

  /** The failure trigger has been refused by the budget — that is a fact about the WORDS, not work. */
  const afterFailures = describeMonitorState(h.state, h.options)
  assert.equal(afterFailures.blocked.failure, 'cap',
    `failure 触发器被配额挡住时必须写明 cap，实测 ${JSON.stringify(afterFailures.blocked)}`)
  assert.equal(afterFailures.blocked.cap, h.options.nudgeCap, '读数必须同时给出配额本身')

  /**
   * And the graph trigger, in a state where the budget is genuinely gone and it never spoke:
   * `blockedBy: 'cap'`, NOT `null`. `null` would (correctly) mean "the conditions are not met";
   * `cap` means "the conditions WERE met and the sentence could not be delivered".
   */
  const spent = createMonitorState()
  spent.nudges = h.options.nudgeCap
  const probe = { ...h.options }
  let seq = 0
  for (let turn = 0; turn < STALL; turn += 1) {
    for (const tool of TOOLS) {
      const callId = `s${(seq += 1)}`
      stepMonitor(spent, { type: 'tool/call', seq, data: { callId, name: tool } }, probe)
      stepMonitor(spent, { type: 'tool/result', seq, data: { message: { source: { callId } } } }, probe)
    }
    stepMonitor(spent, { type: 'turn/end', seq: (seq += 1), data: {} }, probe)
  }
  const view = describeMonitorState(spent, probe)
  assert.equal(view.graph.blockedBy, 'cap',
    `graph 被配额挡住时必须是 cap 而不是「不需要」，实测 ${JSON.stringify(view.graph)}`)

  /** The positive control: a graph that DID speak says `fired`, not `null`. */
  const speaking = harness()
  for (let turn = 0; turn < STALL; turn += 1) speaking.multiStepTurn()
  assert.equal(nudgesOf(speaking.actions, 'graph').length, 1, 'control: 这个夹具必须真的发出一次')
  assert.equal(describeMonitorState(speaking.state, speaking.options).graph.blockedBy, 'fired')
})

test('v244 ③: 没有被任何规则挡住时是 null —— 不在「不需要」上撒谎', () => {
  const state = createMonitorState()
  const view = describeMonitorState(state, DEFAULT_MONITOR_OPTIONS)
  assert.equal(view.graph.blockedBy, null, '既没发也没被挡 ⇒ null（条件不满足）')
  assert.equal(view.blocked.failure, null)
  assert.equal(view.blocked.stall, null)
})