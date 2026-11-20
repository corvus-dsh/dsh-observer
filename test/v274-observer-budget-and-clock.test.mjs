/**
 * ── v274 (B4-0b-2 W2-1 / W2-2): THE BUDGET OUTLIVES THE PROCESS, AND A BACKWARDS CLOCK IS LOUD ──
 *
 * ── W2-1: a supervisor that RESTARTED is not a supervisor that has corrected less ──────────────
 *
 * `createMonitorState()` starts at zero (`monitor.ts:213`), and `supervisors` is a per-process `Map`
 * (`index.ts`, `dispose()` on unload). So every Host restart / plugin reload handed each main a fresh
 * cap of four. The ledger already remembered WHICH shapes a main needed; it did not remember HOW MANY
 * corrections it had spent, or when the last one was. 「每个主脑最多纠偏 4 次」 was really 「每个进程
 * 生命周期 4 次」, and the trigger spacing that exists to keep nagging rare was reset by a restart.
 *
 * Fixed by seeding the state from the ledger (`hydrateMonitorState`) and writing the budget back on
 * every applied action (`persistQuota` in supervisor.ts). ① is the behavioural proof: two supervisors
 * over the SAME store must share one budget.
 *
 * ── W2-2: a backwards clock used to FREEZE every correction, silently ──────────────────────────
 *
 * `since = now - lastNudgeAt`; when the wall clock steps back (VM resume, NTP correcting a fast clock,
 * a manual change) `since` goes negative, `since < cooldown` stays true forever, and NO correction can
 * ever fire. The same shape after a compaction: `seq - lastNudgeSeq` goes negative and the distance
 * rule holds forever. Both failures are invisible because a blocked trigger is silent by design.
 *
 * ── WHY `lastNudgeAt` BECOMES `now - cooldownMs`, NOT `now` ────────────────────────────────────
 *
 * The dispatch said 「重置 lastNudgeAt=now」. Taken literally it does not fix anything: `since` becomes
 * 0, and the very next line reads 0 as "just nudged" — the same freeze, one line later. The criterion
 * (「必须发出，且带一条 warn」) is what governs, so the anchor states what is true: the previous
 * correction is NOT recent, because the clock that timed it is gone. Recorded here because the next
 * reader will otherwise propose the literal version again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { monitorInternals, supervisorInternals } from '../index.js'

const {
  NUDGE_CAP,
  DEFAULT_MONITOR_OPTIONS,
  createMonitorState,
  describeMonitorState,
  normaliseTimeline,
  hydrateMonitorState,
  stepMonitor,
} = monitorInternals
const { createSupervisor, emptyLedger, findRecord, parseLedger, upsertRecord } = supervisorInternals

// ── shared helpers (same shapes v243 uses) ─────────────────────────────────────────────────────

let seq = 900
const nextSeq = () => (seq += 1)
const toolCall = (name, callId) => ({ type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name } })
const failedResult = (callId) => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { turn: 1, step: 1, message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } } },
})

function recordingController() {
  const delivered = []
  return {
    delivered,
    controller: {
      prompt: async (request) => {
        delivered.push(request.content.map((part) => part.text).join(''))
        return { accepted: true }
      },
    },
  }
}

function fileLedgerStore(dir) {
  const path = join(dir, 'observer-main-ledger.json')
  return {
    path,
    load: () => {
      try {
        return parseLedger(JSON.parse(readFileSync(path, 'utf8')))
      } catch {
        return emptyLedger()
      }
    },
    save: (next) => writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8'),
  }
}

/** No real timers: the idle check must never run during a test. */
const NO_TIMER = { setTimer: () => ({ unref() {} }), clearTimer: () => {} }

/**
 * Three consecutive failures of one tool is one correction; a correction RESETS the streak, so three
 * corrections cost nine failure rounds. Everything timing-related is switched off here on purpose —
 * this test is about the CAP, and letting the cooldown interfere would make it about the cooldown.
 */
const NO_SPACING = { nudgeCooldownMs: 0, nudgeMinSeqGap: 0, now: () => 1_000_000 }

/** Drive enough failure rounds to exhaust the failure budget if the state started at zero. */
async function driveFailureCapacity(supervisor) {
  for (let round = 0; round < 9; round += 1) {
    await supervisor.observe(toolCall('pwsh', `call-${round}`))
    await supervisor.observe(failedResult(`call-${round}`))
  }
}

// ── ① the budget survives a "restart" ─────────────────────────────────────────────────────────

test('v274 ①: 重启后预算从台账恢复 —— 同一主脑不会被纠正第二次「四次」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v274-budget-'))
  const store = fileLedgerStore(dir)

  const first = recordingController()
  const supervisorA = createSupervisor('obs-1', 'main-1', {
    controller: first.controller,
    ledger: store,
    options: NO_SPACING,
    ...NO_TIMER,
  })
  await driveFailureCapacity(supervisorA)
  supervisorA.dispose()

  /**
   * THE FAILURE BUDGET IS `cap - 1` BY DESIGN (the last slot is reserved for 「从未建图」, v244) — so
   * exhausting failures is the intended 3, and that is what the ledger must now remember.
   */
  assert.equal(first.delivered.length, NUDGE_CAP - 1, `第一次要恰好用掉 ${NUDGE_CAP - 1} 次纠偏`)

  const persisted = findRecord(parseLedger(JSON.parse(readFileSync(store.path, 'utf8'))), 'main-1')
  assert.ok(persisted !== undefined, '台账必须有这一行')
  assert.equal(persisted.nudges, NUDGE_CAP - 1, '台账必须记住「已用几次」')
  assert.ok(persisted.lastNudgeAt > 0, '也必须记住「上一次是什么时候」——否则冷却跨重启失效')

  /** RESTART: a brand-new supervisor, same main id, same store. */
  const second = recordingController()
  const supervisorB = createSupervisor('obs-1', 'main-1', {
    controller: second.controller,
    ledger: store,
    options: NO_SPACING,
    ...NO_TIMER,
  })
  assert.equal(supervisorB.state().nudges, NUDGE_CAP - 1, '重启后的状态必须从台账恢复，而不是 zero')

  await driveFailureCapacity(supervisorB)
  supervisorB.dispose()

  /**
   * THE ASSERTION THE WHOLE ITEM EXISTS FOR. Without hydration the second supervisor starts at zero
   * and delivers three more — the same main, the same shape, twice the budget.
   */
  assert.equal(second.delivered.length, 0, '预算已耗尽 ⇒ 重启后不许再发')
  assert.equal(supervisorB.state().nudges, NUDGE_CAP - 1, '发不出去，预算也就不该涨')
})

// ── ② a v1.3 ledger row (written before these fields existed) still loads ─────────────────────

test('v274 ②: 旧台账（无新字段）仍被读入 —— 缺字段是 0，不是坏行', () => {
  const legacy = parseLedger({
    version: 1,
    records: [{ sessionId: 'old-main', generation: 2, sourceSessionId: 'gen-1', nudgedKinds: ['stall'] }],
  })
  const record = findRecord(legacy, 'old-main')
  assert.ok(record !== undefined, '旧行必须留下 —— 它守着链条，不能因为多了两个字段就被丢掉')
  assert.equal(record.nudges, 0)
  assert.equal(record.lastNudgeAt, 0)
  assert.equal(record.lastNudgeSeq, 0)
  assert.equal(record.stalledTurns, 0)
  assert.equal(record.harvestedReplacement, false)

  /** And hydration from such a row is a no-op, not a throw. */
  const state = createMonitorState()
  hydrateMonitorState(state, record)
  assert.equal(state.nudges, 0)
})

// ── ③ a backwards clock must FIRE, and say so ────────────────────────────────────────────────

test('v274 ③: 时钟倒退 ⇒ 纠偏必须发出，并留下一条 warn（不许静默冻结）', () => {
  const warnings = []
  const options = {
    ...DEFAULT_MONITOR_OPTIONS,
    /** The last correction is recorded 30 minutes in the FUTURE: the clock stepped back. */
    now: () => 60 * 60 * 1000,
    warn: (message) => warnings.push(message),
  }
  const state = createMonitorState()
  state.nudges = 1
  state.lastNudgeAt = 90 * 60 * 1000

  const actions = []
  for (let round = 0; round < 3; round += 1) {
    actions.push(...stepMonitor(state, toolCall('pwsh', `rewind-${round}`), options))
    actions.push(...stepMonitor(state, failedResult(`rewind-${round}`), options))
  }

  const nudges = actions.filter((action) => action.kind === 'nudge')
  assert.equal(nudges.length, 1, `时钟倒退必须仍能纠偏；actual: ${JSON.stringify(actions)}`)
  assert.equal(warnings.length, 1, `必须恰好一条 warn（不是每次事件一条）；got ${warnings.length}: ${warnings.join(' | ')}`)
  assert.match(warnings[0], /时钟倒退/u)
  assert.match(String(describeMonitorState(state).clockRewind), /时钟倒退/u, '状态面板也必须看得见这次纠正')
})

// ── ④ the pre-fix shape, pinned: the OLD guard says "cooldown" forever ──────────────────────

test('v274 ④: 旧守卫的算术（since<0 ⇒ 永在冷却中）—— 冻结的实物证据', () => {
  /**
   * This does NOT call `stepMonitor`: since v1.4 that function repairs the timeline first, so it can
   * no longer exhibit the freeze. What it pins instead is the ARITHMETIC that produced it — the guard
   * as it was written before the fix, verbatim, against the same state.
   *
   * A negative `since` is smaller than ANY cooldown, so the rule that protects against nagging also
   * protects the freeze. That is the whole defect in one line, and it is not a typo: it is what a
   * comparison against an unsanitised clock DOES, whether or not the clock is meant to be trusted.
   */
  const state = createMonitorState()
  state.nudges = 1
  state.lastNudgeAt = 90 * 60 * 1000
  const options = { ...DEFAULT_MONITOR_OPTIONS, now: () => 60 * 60 * 1000 }

  const since = options.now() - state.lastNudgeAt
  assert.ok(since < 0, '前提：这个场景里 since 必须为负')
  assert.ok(since < options.nudgeCooldownMs, '负数必然小于冷却 ⇒ 旧守卫永远说「冷却中」')

  /** The old guard, verbatim: `state.nudges > 0 && since < nudgeCooldownMs`. */
  const oldGuardBlocks = state.nudges > 0 && since < options.nudgeCooldownMs
  assert.equal(oldGuardBlocks, true, '旧守卫在这个状态下永远为真 —— 没有事件能改变它')
})

// ── ⑤ a backwards seq resets the distance rule ──────────────────────────────────────────────

test('v274 ⑤: 日志 seq 回退（压缩/重建）⇒ 距离规则重置，纠偏发出', () => {
  const warnings = []
  const options = {
    ...DEFAULT_MONITOR_OPTIONS,
    nudgeCooldownMs: 0,
    now: () => 1_000_000,
    warn: (message) => warnings.push(message),
  }
  const state = createMonitorState()
  state.nudges = 1
  /** The main was compacted: its log restarted well below the recorded seq. */
  state.lastNudgeSeq = 5_000

  const actions = []
  for (let round = 0; round < 3; round += 1) {
    actions.push(...stepMonitor(state, toolCall('pwsh', `compact-${round}`), options))
    actions.push(...stepMonitor(state, failedResult(`compact-${round}`), options))
  }
  assert.equal(actions.filter((action) => action.kind === 'nudge').length, 1, 'seq 回退后必须仍能纠偏')
  assert.equal(warnings.length, 1, 'seq 回退也要说一次')
  assert.match(warnings[0], /seq 回退/u)
  assert.equal(state.lastNudgeSeq > 0, true, '发出后记下新的 seq，规则重新生效')
})

// ── ⑥ the repair does not fire on a sane timeline ───────────────────────────────────────────

test('v274 ⑥: 时间线正常时刻不触发纠正（不是「永远 warn」）', () => {
  const warnings = []
  const options = { ...DEFAULT_MONITOR_OPTIONS, nudgeCooldownMs: 0, now: () => 1_000_000, warn: (m) => warnings.push(m) }
  const state = createMonitorState()
  state.nudges = 1
  state.lastNudgeAt = options.now() - 1_000
  state.lastNudgeSeq = 1
  normaliseTimeline(state, 5, options)
  assert.deepEqual(warnings, [], '正常时间线不许 warn')
  assert.equal(state.clockRewind, '', '正常时间线不许留痕')
})

// ── ⑦ the ledger row is ONE row: shape and budget are written together ──────────────────────

test('v274 ⑦: 形态与预算写进同一行 —— 不会出现「形态说四次、预算说一次」', () => {
  let ledger = emptyLedger()
  ledger = upsertRecord(ledger, {
    sessionId: 'main-7',
    at: 100,
    nudgedKind: 'failure',
    quota: { nudges: 1, lastNudgeAt: 100, lastNudgeSeq: 42, stalledTurns: 2, harvestedReplacement: false },
  })
  let record = findRecord(ledger, 'main-7')
  assert.equal(record.nudges, 1)
  assert.deepEqual(record.nudgedKinds, ['failure'])
  assert.equal(record.lastNudgeSeq, 42)
  assert.equal(record.stalledTurns, 2)

  /** A later save of the SAME budget must not increment: `quota` SETS, `nudgedKind` increments. */
  ledger = upsertRecord(ledger, {
    sessionId: 'main-7',
    at: 200,
    quota: { nudges: 1, lastNudgeAt: 200, lastNudgeSeq: 60, stalledTurns: 0, harvestedReplacement: true },
  })
  record = findRecord(ledger, 'main-7')
  assert.equal(record.nudges, 1, '二次保存同一预算不许把次数加一')
  assert.equal(record.lastNudgeSeq, 60)
  assert.equal(record.harvestedReplacement, true)
  assert.equal(record.nudgedKinds.length, 1, '形态集合不受预算保存影响')
})