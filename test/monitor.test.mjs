/**
 * dsh-observer v1.7.0 — THE OBSERVER AS A SITE SUPERVISOR (监理).
 *
 * THE REQUIREMENT THESE CASES REPLACE, IN THE USER'S WORDS
 *
 *   「副脑孵化主脑后，不能就此休眠，它需要充当监理。1. 失败纠偏：如果发现主脑连续 3 次执行相同的
 *    失败工具（或者连续 5 轮没有推进 TODO），副脑主动给主脑发一条提示。2. 空闲记忆提取：当主脑完成
 *    关键节点（或者进入休眠）时，副脑在后台静默调用 memory_harvest。」
 *
 * So there are two contracts and they are tested separately:
 *
 *   A. THE DECISION (pure, in `core/monitor.ts`) — 3 same-tool failures in a row produce exactly
 *      ONE correction; 5 closed turns without moving the TODO list produce one; a success resets the
 *      streak; a rewritable-but-identical board is NOT progress. No clock, no host.
 *   B. THE DELIVERY (in `core/supervisor.ts`) — the correction goes out through the Host's steer
 *      channel (NEVER a log append: a step-scoped write into a running session is impossible to
 *      bind correctly), and the harvest reports what it actually mined instead of claiming success.
 *
 * WHY THE PURE HALF IS SO LARGE: every failure mode here is a COUNTING bug (off by one nudge, a
 * streak that never resets, a cooldown that never cools) and those are invisible in an integration
 * test that only checks "a message happened".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, monitorInternals, supervisorInternals } from '../index.js'
import { makeHost } from './harness.mjs'

const {
  FAILURE_STREAK_LIMIT,
  STALL_TURNS_LIMIT,
  NUDGE_CAP,
  NUDGE_MARKER,
  createMonitorState,
  harvestGate,
  stepMonitor,
  todoItemsFromArguments,
} = monitorInternals

const { SUPERVISOR_DUTY_TEXT, createSupervisor } = supervisorInternals

/* ── event builders (the host's own shapes) ──────────────────────────────── */

let seqCounter = 0
const nextSeq = () => (seqCounter += 1)

function toolCall(name, callId, args) {
  return { type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name, arguments: args } }
}

function toolResult(callId, { failed = false } = {}) {
  const seq = nextSeq()
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      ...(failed
        ? { message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } } }
        : { message: { content: [{ type: 'text', text: 'ok' }], source: { callId } } }),
    },
  }
}

function turnEnd() {
  return { type: 'turn/end', seq: nextSeq(), data: { turn: 1, reason: { kind: 'completed' } } }
}

function todoWrite(callId, todos) {
  return toolCall('todo_write', callId, JSON.stringify({ todos }))
}

/** A clock that only moves when a test says so. */
function fakeClock() {
  let now = 1_000_000
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const OPTIONS = (clock) => ({ ...monitorInternals.DEFAULT_MONITOR_OPTIONS, now: clock.now })

/** Feed a list of events and collect every action they produced. */
function run(state, events, options) {
  const out = []
  for (const event of events) out.push(...stepMonitor(state, event, options))
  return out
}

/* ── A1. failure correction ──────────────────────────────────────────────── */

test('monitor: three failures of the SAME tool produce exactly one correction', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const events = []
  for (let round = 0; round < FAILURE_STREAK_LIMIT; round += 1) {
    events.push(toolCall('pwsh', `call-${round}`))
    events.push(toolResult(`call-${round}`, { failed: true }))
  }
  const actions = run(state, events, OPTIONS(clock))

  assert.equal(actions.length, 1, 'one correction, not one per failure')
  assert.equal(actions[0].kind, 'nudge')
  assert.equal(actions[0].trigger, 'failure')
  assert.equal(state.nudges, 1)
})

test('monitor: two failures are NOT enough — the limit is 3', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const actions = run(
    state,
    [
      toolCall('read', 'a'),
      toolResult('a', { failed: true }),
      toolCall('read', 'b'),
      toolResult('b', { failed: true }),
    ],
    OPTIONS(clock),
  )
  assert.deepEqual(actions, [], 'a streak of 2 is noise, not a loop')
  assert.equal(state.failure.count, 2, 'but it is counted')
})

test('monitor: a SUCCESS between failures resets the streak', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const actions = run(
    state,
    [
      toolCall('pwsh', 'a'),
      toolResult('a', { failed: true }),
      toolCall('pwsh', 'b'),
      toolResult('b', { failed: true }),
      toolCall('pwsh', 'c'),
      toolResult('c'), // success
      toolCall('pwsh', 'd'),
      toolResult('d', { failed: true }),
      toolCall('pwsh', 'e'),
      toolResult('e', { failed: true }),
    ],
    OPTIONS(clock),
  )
  assert.deepEqual(actions, [], 'two non-consecutive pairs are not a streak of three')
  assert.equal(state.failure.count, 2, 'the count restarted after the success')
})

test('monitor: a DIFFERENT tool failing keeps its own streak — a real loop is one tool', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const actions = run(
    state,
    [
      toolCall('pwsh', 'a'),
      toolResult('a', { failed: true }),
      toolCall('read', 'b'),
      toolResult('b', { failed: true }),
      toolCall('grep', 'c'),
      toolResult('c', { failed: true }),
    ],
    OPTIONS(clock),
  )
  assert.deepEqual(actions, [], 'three different tools failing is a bad day, not a loop')
  assert.equal(state.failure.tool, 'grep')
  assert.equal(state.failure.count, 1)
})

test('monitor: the correction names the tool and points at the memory store', () => {
  const state = createMonitorState()
  const actions = run(
    state,
    [
      toolCall('pwsh', 'a'),
      toolResult('a', { failed: true }),
      toolCall('pwsh', 'b'),
      toolResult('b', { failed: true }),
      toolCall('pwsh', 'c'),
      toolResult('c', { failed: true }),
    ],
    OPTIONS(fakeClock()),
  )
  const text = actions[0].text
  assert.match(text, /pwsh/u, 'the failing tool is named')
  assert.match(text, /memory_search/u, 'and the memory store is the suggested way out')
  assert.match(text, /连续 3 次/u)
  assert.ok(text.startsWith(NUDGE_MARKER), 'every correction carries the marker')
})

/* ── A2. stall correction ────────────────────────────────────────────────── */

test('monitor: five closed turns without moving the TODO list produce one correction', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const events = [
    todoWrite('t0', [{ content: '阶段 1: 取证', status: 'in_progress' }]),
    toolResult('t0'),
  ]
  // Four quiet turns: no correction yet.
  for (let i = 0; i < STALL_TURNS_LIMIT - 1; i += 1) {
    events.push(toolCall('read', `r${i}`), toolResult(`r${i}`), turnEnd())
  }
  const early = run(state, events, OPTIONS(clock))
  assert.deepEqual(early, [], `no correction before ${STALL_TURNS_LIMIT} turns`)

  // The fifth turn tips it over.
  const late = run(state, [toolCall('read', 'r9'), toolResult('r9'), turnEnd()], OPTIONS(clock))
  assert.equal(late.length, 1)
  assert.equal(late[0].trigger, 'stall')
  assert.match(late[0].text, /没有推进 TODO/u)
  assert.match(late[0].text, /memory_search|换方案/u)
})

test('monitor: rewriting the SAME board is not progress, rewriting a MOVED board resets', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  const same = [{ content: '阶段 1: 取证', status: 'in_progress' }]

  run(state, [todoWrite('t0', same), toolResult('t0')], options)
  for (let i = 0; i < STALL_TURNS_LIMIT - 1; i += 1) {
    run(state, [toolCall('read', `r${i}`), toolResult(`r${i}`), turnEnd()], options)
  }
  // A rewrite with identical content: the model looked busy without moving.
  run(state, [todoWrite('t1', same), toolResult('t1')], options)
  assert.equal(state.stalledTurns, STALL_TURNS_LIMIT - 1, 'an identical rewrite does not reset the stall')

  // A real move does.
  run(
    state,
    [todoWrite('t2', [{ content: '阶段 1: 取证', status: 'completed' }, { content: '阶段 2: 实现', status: 'in_progress' }]), toolResult('t2')],
    options,
  )
  assert.equal(state.stalledTurns, 0, 'a moved board is progress')
  assert.equal(state.openTodos, 1)
  assert.equal(state.totalTodos, 2)
})

test('monitor: a FAILED todo_write never moves the board', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  run(state, [todoWrite('t0', [{ content: 'a', status: 'in_progress' }]), toolResult('t0')], options)
  const before = state.todoSignature

  run(
    state,
    [todoWrite('t1', [{ content: 'a', status: 'completed' }]), toolResult('t1', { failed: true })],
    options,
  )
  assert.equal(state.todoSignature, before, 'a rejected write is not a state change')
  assert.equal(state.totalTodos, 1)
})

/* ── A3. the limits that keep it from becoming a spammer ─────────────────── */

test('monitor: the cooldown blocks a second correction inside the window', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  const burst = (tag) => [
    toolCall('pwsh', `${tag}a`),
    toolResult(`${tag}a`, { failed: true }),
    toolCall('pwsh', `${tag}b`),
    toolResult(`${tag}b`, { failed: true }),
    toolCall('pwsh', `${tag}c`),
    toolResult(`${tag}c`, { failed: true }),
  ]

  const first = run(state, burst('one-'), options)
  assert.equal(first.length, 1, 'the first correction goes out')

  const second = run(state, burst('two-'), options)
  assert.deepEqual(second, [], 'the same minute does not get a second one')

  clock.advance(monitorInternals.NUDGE_COOLDOWN_MS + 1)
  // The log must also have moved far enough: the seq gate is the second half of the cooldown.
  run(state, Array.from({ length: monitorInternals.NUDGE_MIN_SEQ_GAP + 1 }, (_, i) => toolCall('noop', `pad-${i}`)), options)
  run(state, Array.from({ length: monitorInternals.NUDGE_MIN_SEQ_GAP + 1 }, (_, i) => toolResult(`pad-${i}`)), options)
  const third = run(state, burst('three-'), options)
  assert.equal(third.length, 1, 'after the window AND enough log distance, it may speak again')
  assert.equal(state.nudges, 2)
})

test('monitor: the cap is absolute — nagging is not supervision', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  let fired = 0
  for (let round = 0; round < NUDGE_CAP + 3; round += 1) {
    clock.advance(monitorInternals.NUDGE_COOLDOWN_MS + 1)
    const tag = `r${round}-`
    run(state, Array.from({ length: monitorInternals.NUDGE_MIN_SEQ_GAP + 1 }, (_, i) => toolCall('noop', `${tag}p${i}`)), options)
    run(state, Array.from({ length: monitorInternals.NUDGE_MIN_SEQ_GAP + 1 }, (_, i) => toolResult(`${tag}p${i}`)), options)
    const actions = run(
      state,
      [
        toolCall('pwsh', `${tag}a`),
        toolResult(`${tag}a`, { failed: true }),
        toolCall('pwsh', `${tag}b`),
        toolResult(`${tag}b`, { failed: true }),
        toolCall('pwsh', `${tag}c`),
        toolResult(`${tag}c`, { failed: true }),
      ],
      options,
    )
    fired += actions.filter((action) => action.kind === 'nudge').length
  }
  assert.equal(fired, NUDGE_CAP, `exactly ${NUDGE_CAP} corrections, then silence`)
  assert.equal(state.nudges, NUDGE_CAP)
})

/* ── A4. the harvest gate ────────────────────────────────────────────────── */

test('harvest: a live main that never closed a turn is NOT mined', () => {
  const state = createMonitorState()
  const gate = harvestGate(state, 'idle', OPTIONS(fakeClock()))
  assert.equal(gate.ok, false)
  assert.match(gate.detail, /没有关闭过任何回合/u, 'the refusal names its reason')
})

test('harvest: a completed board is mined ONCE, not on every turn/end', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  const actions = run(
    state,
    [
      todoWrite('t0', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]),
      toolResult('t0'),
      turnEnd(),
      turnEnd(),
    ],
    options,
  )
  const harvests = actions.filter((action) => action.kind === 'harvest')
  assert.ok(harvests.length >= 1, 'a fully completed board asks for a harvest')
  assert.equal(harvests[0].reason, 'completed')

  // Two free passes through the gate (the actions above did NOT consume it — the delivery half
  // consumes it), then the second is refused as a duplicate board.
  assert.equal(harvestGate(state, 'completed', options).ok, true)
  const second = harvestGate(state, 'completed', options)
  assert.equal(second.ok, false)
  assert.match(second.detail, /已经提炼过/u)
})

test('harvest: the 30-minute cooldown holds even for a NEW board', () => {
  const clock = fakeClock()
  const state = createMonitorState()
  const options = OPTIONS(clock)
  state.turnsClosed = 3
  assert.equal(harvestGate(state, 'idle', options).ok, true)
  const blocked = harvestGate(state, 'idle', options)
  assert.equal(blocked.ok, false)
  assert.match(blocked.detail, /冷却中/u)
  clock.advance(monitorInternals.HARVEST_COOLDOWN_MS + 1)
  assert.equal(harvestGate(state, 'idle', options).ok, true)
})

/* ── A5. the todo parser ─────────────────────────────────────────────────── */

test('todo parser: every payload shape a log carries is understood', () => {
  assert.deepEqual(todoItemsFromArguments('{"todos":[{"content":"a","status":"completed"}]}'), [
    { text: 'a', done: true },
  ])
  assert.deepEqual(todoItemsFromArguments({ todos: [{ content: 'b', completed: true }] }), [{ text: 'b', done: true }])
  assert.deepEqual(todoItemsFromArguments([{ content: 'c' }]), [{ text: 'c', done: false }])
  assert.equal(todoItemsFromArguments('not json'), undefined)
  assert.equal(todoItemsFromArguments({ nope: 1 }), undefined)
})

/* ── B1. delivery: steer, never a log append ─────────────────────────────── */

function boot(overrides = {}) {
  const host = makeHost(overrides)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

function supervisorOn(host, overrides = {}) {
  const controller = host.ctx.get('sessionController')
  const tools = host.ctx.get('tools')
  return createSupervisor('session-blank', 'session-main', {
    controller,
    tools,
    logger: host.ctx.logger,
    idleMs: 60_000,
    setTimer: () => null,
    clearTimer: () => {},
    ...overrides,
  })
}

async function feedFailures(supervisor, rounds = FAILURE_STREAK_LIMIT) {
  for (let i = 0; i < rounds; i += 1) {
    await supervisor.observe(toolCall('pwsh', `c-${i}`))
    await supervisor.observe(toolResult(`c-${i}`, { failed: true }))
  }
}

test('delivery: the correction goes out through sessionController.prompt in STEER mode', async () => {
  const host = boot()
  const supervisor = supervisorOn(host)
  await feedFailures(supervisor)

  assert.equal(host.prompts.length, 1, 'exactly one prompt')
  assert.equal(host.prompts[0].mode, 'steer', 'steer lands in the OPEN turn — the whole point')
  assert.equal(host.prompts[0].sessionId, 'session-main', 'addressed to the main, not the observer')
  assert.match(host.prompts[0].content[0].text, /纠偏/u)
})

test('delivery: it NEVER appends to the main log — no step-scoped write, no {turn:0,step:0}', async () => {
  const host = boot()
  const supervisor = supervisorOn(host)
  await feedFailures(supervisor)

  // `harness.appends` records every append the fake host received. A correction must produce NONE:
  // a supervisor cannot know the main's open turn/step, and guessing 0/0 is the exact write the
  // host rejects.
  assert.deepEqual(host.appends, [], 'supervision is out-of-band, never a log write')
})

test('delivery: no channel means a REPORTED failure, not a silent no-op', async () => {
  const host = boot()
  const warnings = []
  const supervisor = supervisorOn(host, {
    controller: undefined,
    logger: { info() {}, warn: (message) => warnings.push(message) },
  })
  await feedFailures(supervisor)

  assert.equal(host.prompts.length, 0)
  assert.ok(
    warnings.some((line) => /纠偏投递失败/u.test(line)),
    `a correction that could not be delivered must be logged, got: ${warnings.join(' | ')}`,
  )
})

test('delivery: a steer the host refuses falls back to queue rather than dropping the hint', async () => {
  const host = boot()
  const calls = []
  const controller = {
    async prompt(request) {
      calls.push(request.mode)
      return { accepted: request.mode === 'queue' }
    },
  }
  const supervisor = supervisorOn(host, { controller })
  await feedFailures(supervisor)

  assert.deepEqual(calls, ['steer', 'queue'], 'steer is tried first, queue is the fallback')
})

/* ── B2. delivery: the harvest tells the truth about what it mined ───────── */

test('harvest: a live main is NOT claimed as mined, and the report says so', async () => {
  const host = boot({ harvest: { harvested: [] } })
  const supervisor = supervisorOn(host)
  await supervisor.observe(todoWrite('t0', [{ content: 'a', status: 'completed' }]))
  await supervisor.observe(toolResult('t0'))
  await supervisor.observe(turnEnd())

  const request = host.memoryCalls.find((call) => call.name === 'memory_harvest')
  assert.ok(request !== undefined, 'memory_harvest was called')
  assert.equal(request.arguments.limit, 3, 'a bounded background harvest')
  assert.equal(supervisor.describe().harvests, 1)
})

test('harvest: when the store reports our main was mined, the count reflects it', async () => {
  const host = boot({ harvest: { harvested: [{ sessionId: 'session-main' }] } })
  const supervisor = supervisorOn(host)
  await supervisor.observe(todoWrite('t0', [{ content: 'a', status: 'completed' }]))
  await supervisor.observe(toolResult('t0'))
  await supervisor.observe(turnEnd())

  assert.equal(host.memoryCalls.filter((call) => call.name === 'memory_harvest').length, 1)
})

test('harvest: a profile WITHOUT dsh-memory does not break supervision', async () => {
  const host = boot({ harvest: 'throw' })
  const warnings = []
  const supervisor = supervisorOn(host, { logger: { info() {}, warn: (message) => warnings.push(message) } })
  await supervisor.observe(todoWrite('t0', [{ content: 'a', status: 'completed' }]))
  await supervisor.observe(toolResult('t0'))
  await supervisor.observe(turnEnd())

  assert.ok(warnings.some((line) => /后台提炼/u.test(line)), 'the absence is reported, not swallowed')
})

/* ── B3. the wiring: an incubated main is supervised from the moment it exists */

test('wiring: incubation starts a supervisor that is visible in observer_status', async () => {
  const host = boot({ memory: { hint: '' } })
  const reply = await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划\n1. 干活', observerSessionId: 'session-blank', userConfirmed: true }, {})
  assert.equal(reply.ok, true, reply.text)
  assert.match(reply.text, /监理：已启动/u, 'the receipt states the supervision')

  const status = await host.tools.get('observer_status').execute({}, {})
  const supervised = Object.keys(status.supervisors)
  assert.deepEqual(supervised, [reply.sessionId], 'the main is the key')
  assert.equal(status.supervisors[reply.sessionId].mainSessionId, reply.sessionId)
  assert.equal(status.supervisors[reply.sessionId].observerSessionId, 'session-blank')
})

test('wiring: the observer is told what the supervisor does on its behalf', async () => {
  const host = boot({ memory: { hint: '' } })
  await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})

  const duty = host.appends
    .filter((entry) => entry.type === 'developer/message' && entry.id === 'session-blank')
    .map((entry) => entry.data.message.content[0].text)
    .join('\n')
  assert.match(duty, /监理/u, 'the duty text reached the observer half')
  assert.match(SUPERVISOR_DUTY_TEXT, /失败纠偏/u)
  assert.match(SUPERVISOR_DUTY_TEXT, /记忆提炼/u)
  assert.match(SUPERVISOR_DUTY_TEXT, /不是执行者/u, 'and it does not become the executor')
})

test('wiring: a transferred main is RE-supervised, never left watching a retired id', async () => {
  const host = boot({ memory: { hint: '' } })
  const reply = await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})
  const oldMain = reply.sessionId

  host.listeners.get('graft/session-transferred')({ sourceSessionId: oldMain, newSessionId: 'session-main-2' })
  /**
   * The listener must NOT block the transfer, so it returns before the supervision swap finishes
   * (the swap awaits a harvest of the retired main). One macrotask is all the fake host needs.
   */
  await new Promise((resolve) => setTimeout(resolve, 0))

  const status = await host.tools.get('observer_status').execute({}, {})
  const keys = Object.keys(status.supervisors)
  assert.deepEqual(keys, ['session-main-2'], `the old id must be gone, got ${keys.join(', ')}`)
  assert.equal(status.supervisors['session-main-2'].observerSessionId, 'session-blank')
})

test('wiring: slicing the MAIN mines the retired session (that is the one the ledger knows)', async () => {
  const host = boot({ memory: { hint: '' }, harvest: { harvested: [{ sessionId: 'will-be-old' }] } })
  const reply = await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})
  const oldMain = reply.sessionId

  // Pretend a harvest of this exact main is what the store will report.
  host.listeners.get('graft/session-transferred')({ sourceSessionId: oldMain, newSessionId: 'session-main-2' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const harvests = host.memoryCalls.filter((call) => call.name === 'memory_harvest')
  assert.equal(harvests.length, 1, 'a slice triggers exactly one background extraction')
})

test('wiring: a restart REHYDRATES the supervisors of existing pairs', async () => {
  /**
   * THE FAILURE THIS PREVENTS: the supervisor table is in memory. Without rehydration a restarted
   * process supervises only mains hatched in THAT process, while yesterday's pair sits in the
   * sidebar looking supervised and nothing watches it.
   */
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-'))
  const bindingsPath = join(root, 'observer-bindings.json')

  const first = makeHost({ memory: { hint: '' } })
  apply(first.ctx, { bindingsPath })
  const reply = await first.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})

  // A NEW process: fresh module state, the same bindings file.
  const second = makeHost({ memory: { hint: '' } })
  apply(second.ctx, { bindingsPath })
  const status = await second.tools.get('observer_status').execute({}, {})
  assert.deepEqual(
    Object.keys(status.supervisors),
    [reply.sessionId],
    'the pair from the previous process is supervised again, without a new incubation',
  )
  assert.equal(status.supervisors[reply.sessionId].events, 0, 'and nothing was replayed into it')
})

test('wiring: slicing the OBSERVER does not spend the retirement harvest slot', async () => {
  const host = boot({ memory: { hint: '' } })
  const reply = await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})

  host.listeners.get('graft/session-transferred')({ sourceSessionId: 'session-blank', newSessionId: 'observer-2' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(
    host.memoryCalls.filter((call) => call.name === 'memory_harvest').length,
    0,
    'the main is still alive — there is nothing retired to mine',
  )
  const status = await host.tools.get('observer_status').execute({}, {})
  assert.deepEqual(Object.keys(status.supervisors), [reply.sessionId], 'the main keeps being supervised')
  assert.equal(
    status.supervisors[reply.sessionId].observerSessionId,
    'observer-2',
    'only the partner id moved',
  )
})
