/**
 * dsh-observer v1.3.0 — INCUBATION, AND THE BIDIRECTIONAL PAIR.
 *
 * THE ARCHITECTURE THESE CASES PIN
 *
 *   A blank session starts with NO ROLE. It clarifies requirements; when the agreed work is too big
 *   for one context window it calls `observer_spawn_main` and becomes the OBSERVER, while a NEW
 *   session receives the plan and becomes the MAIN.
 *
 * v1.3.0 CHANGED THE MECHANISM, AND THAT IS WHAT MOST OF THIS FILE NOW TESTS.
 *
 * The old path was `sessionController.create()` + `sessions.get(id).append(...)`. It could not
 * work: a `developer/message` must match the OPEN turn/step, and a freshly created session has no
 * open turn — `turn === null` — so the host refused every write and the catch turned it into a
 * message. The incubated mains ended up with metadata and no plan.
 *
 * The main is now a COLD artifact written through the store-owned writer, exactly as
 * dsh-graft-slice does it:
 *
 *   sessions.prepare(id, { meta: { cwd } })
 *   → build + validate the tape in memory
 *   → sessionPersistence.create(header, { inheritedEventCount: 0 })
 *   → handle.append(events) → handle.flush() → handle.close()
 *   → cold-read verify through sessionQuery
 *
 * and the tape order is
 *
 *   turn/start(1) → step/start(1,1) → system/message → developer/message → session/title
 *   → step/end(1,1) → turn/end(1, completed)
 *
 * with `surfaceOp: 'append'` on the two MESSAGES and on nothing else.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugFollowTransfer, debugObserverState } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const MESSAGE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])

function boot(options = {}) {
  const host = makeHost(options)
  const bindingsPath = join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(host.ctx, { bindingsPath })
  return { ...host, bindingsPath }
}

const spawnMain = (harness, observerSessionId, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId, userConfirmed: true }, {})

/** The one cold tape this incubation wrote. */
const theTape = (harness) => {
  const created = harness.persistence.createCalls
  assert.equal(created.length, 1, 'exactly one persistence.create — one incubated main')
  return { id: created[0].header.id, events: tapeOf(harness.persistence, created[0].header.id), create: created[0] }
}

test('spawn_main: the tool is registered with a mandatory plan', () => {
  const harness = boot()
  const definition = harness.tools.get('observer_spawn_main')
  assert.ok(definition !== undefined, 'observer_spawn_main is registered')
  assert.deepEqual(definition.parameters.required, ['plan'], 'a plan is mandatory bad input guard')
})

/* ── placement ─────────────────────────────────────────────────────────────── */

test('spawn_main: the prepared header carries the CONSULTING session\'s own cwd', async () => {
  const harness = boot({ cwd: 'D:/work/live2d' })
  const reply = await spawnMain(harness, 'session-blank', '## 计划\n1. 做 A\n2. 做 B')

  assert.equal(reply.ok, true, reply.text)
  const { create } = theTape(harness)
  assert.equal(create.header.cwd, 'D:/work/live2d', 'the artifact is placed in the caller\'s workspace')
  assert.equal(create.options.inheritedEventCount, 0, 'zero inheritance: this is a NEW tape, not a fork')
  assert.equal(harness.persistence.createCalls.length, 1)
  assert.match(reply.text, /cwd=D:\/work\/live2d/u, 'and the reply names the exact path')
})

test('spawn_main: the cwd comes from the session HEADER when the session object has no cwd', async () => {
  // `liveHeader` uses `headerCwd`; `workingDirectory` answers the same path, which is the
  // documented fallback on this host.
  const harness = boot({ cwd: 'D:/only/header', headerCwd: 'D:/only/header' })
  const reply = await spawnMain(harness, 'session-blank', 'plan')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(theTape(harness).create.header.cwd, 'D:/only/header')
})

test('spawn_main: NO workspace means NO session — an orphan is worse than an error', async () => {
  const harness = boot({ cwd: '' })
  const reply = await spawnMain(harness, 'session-blank', 'plan')

  assert.equal(reply.ok, false)
  assert.match(reply.text, /工作目录/u, 'it names what could not be resolved')
  assert.equal(harness.persistence.createCalls.length, 0, 'nothing was reserved')
  assert.equal(harness.persistence.byId.size, 0, 'and nothing is on disk')
  assert.equal(harness.sessions.prepareCalls.length, 0, 'not even a prepared session')
})

test('spawn_main: a RELATIVE cwd is refused, not passed through', async () => {
  const harness = boot({ cwd: 'relative/not/absolute' })
  const reply = await spawnMain(harness, 'session-blank', 'plan')

  assert.equal(reply.ok, false, 'a relative path cannot identify a workspace')
  assert.equal(harness.persistence.createCalls.length, 0)
})

/* ── the physical tape ─────────────────────────────────────────────────────── */

test('spawn_main: the plan is written PHYSICALLY as a cold tape — never appended to a live session', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', '## 计划\n目标、约束、步骤、验证')
  assert.equal(reply.ok, true, reply.text)

  const { events } = theTape(harness)
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'session/title', 'step/end', 'turn/end'],
    'one complete closed skeleton with the VISIBLE briefing inside it',
  )

  // Surface intent: exactly the MESSAGES, and the system head is the FIRST of them.
  for (const [index, event] of events.entries()) {
    assert.equal(Number(event.seq), index, `event ${index} must be contiguous from seq 0`)
    assert.equal(typeof event.time, 'number', `event ${index} must carry a time`)
    if (MESSAGE_TYPES.has(event.type)) {
      assert.equal(event.surfaceOp, 'append', `${event.type} must declare surfaceOp:'append'`)
    } else {
      assert.equal(event.surfaceOp, undefined, `${event.type} must not carry surfaceOp`)
    }
  }
  const surfaceTypes = events.filter((event) => event.surfaceOp === 'append').map((event) => event.type)
  assert.equal(surfaceTypes[0], 'system/message', 'the first SURFACE NODE is the protected system head')
  assert.ok(
    events.findIndex((event) => event.type === 'turn/start') < events.findIndex((event) => event.type === 'system/message'),
    'turn/start precedes the system head: a message outside an open step is refused by the host',
  )

  // No LIVE session was created, and the detached one was never appended through.
  assert.equal(harness.creates.length, 0, 'sessionController.create is not used for the main any more')
  assert.equal(harness.sessions.prepared.size, 1, 'the session was PREPARED (detached)')
  assert.equal(harness.sessions.live.has(theTape(harness).id), false, 'the main stays COLD')
  /**
   * v1.5.0 REVERSED THIS ASSERTION ON PURPOSE, AND THE REVERSAL IS THE FEATURE.
   *
   * v1.3.x asserted `prompts.length === 0` — "no prompt: the main must not start working". That was
   * the right call while the briefing was invisible and the mechanism unproven: a main that woke up
   * and failed would have burned the run. The acceptance run settled it the other way — the user's
   * complaint was 「既然主脑是副脑拉起的，就应该自动跑」.
   *
   * So exactly ONE prompt is admitted, at the very end, after the artifact is durable, verified and
   * bound. The count stays pinned at 1: a second prompt would read to the main as the same
   * instruction given twice.
   */
  assert.equal(harness.prompts.length, 1, 'the main is ignited exactly once, after the tape is durable')
  assert.equal(harness.prompts[0].sessionId, theTape(harness).id, 'and the prompt targets the new main')
  assert.match(
    harness.prompts[0].content[0].text,
    /\[dsh-observer 点火\]/u,
    'carrying the marker a retry uses to recognise its own admission',
  )

  // create → append → flush → close, in that order.
  assert.deepEqual(harness.persistence.order, ['create', 'append', 'flush', 'close'])
})

test('spawn_main: the briefing holds the plan verbatim, as a VISIBLE user/message', async () => {
  const harness = boot()
  const plan = '## 计划\n目标、约束、步骤、验证'
  await spawnMain(harness, 'session-blank', plan)

  const briefing = theTape(harness).events.find((event) => event.type === 'user/message')
  assert.ok(briefing !== undefined, 'the briefing must be a user/message: developer/message is never rendered')
  assert.equal(briefing.data.role, 'user')
  assert.equal(briefing.data.content[0].text, plan, 'the text is exactly what was passed')
  assert.equal(briefing.data.turn, undefined, 'a user/message is NOT step-scoped on this host')
  assert.equal(briefing.data.step, undefined)
  assert.equal(briefing.data.source.kind, 'user', 'kind:user is what the renderer requires in order to show it')
  assert.match(briefing.data.id, /^observer-briefing-/u, 'provenance is on the ID, which the projector never reads')
  assert.equal(briefing.data.source.rpcId, undefined, 'and no rpcId: that field marks a real human prompt')
  assert.equal(briefing.surfaceOp, 'append')
})

test('spawn_main: the tool result states the stage and proves the plan from DISK', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', 'plan')
  assert.equal(reply.stage, 'inject_success')
  assert.equal(reply.briefingVisible, true)
  assert.match(reply.text, /stage: inject_success/u)
  assert.match(reply.text, /磁盘核对|磁盘日志/u, 'the result carries the durable-log evidence')
  assert.match(reply.text, /可见|渲染/u, 'and says whether the conversation will show it')
})

test('spawn_main: the turn is CLOSED with reason completed, so the main opens asleep', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const turnEnd = theTape(harness).events.find((event) => event.type === 'turn/end')
  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'completed' } })
})

test('spawn_main: the title travels INSIDE the tape — a cold session has no live rename', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const title = theTape(harness).events.find((event) => event.type === 'session/title')
  assert.ok(title !== undefined, 'the sidebar name is part of the artifact')
  assert.match(title.data.title, /\[主脑\]/u)
  assert.deepEqual(title.data.messageSeqs, [], 'no human message exists for it to cite')
  assert.deepEqual(title.data.source, { kind: 'user' }, 'empty refs REQUIRE kind:user on this host')
})

test('spawn_main: the artifact is cold-read VERIFIED before it is reported as done', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', 'plan')
  assert.match(reply.text, /冷读校验 通过/u, 'the reply states the verification, not an assumption')
})

test('spawn_main: the cold main is announced to the client and attached to the workspace', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const { id, create } = theTape(harness)

  const added = harness.emitted.filter((entry) => entry.event === 'api-session/added')
  assert.equal(added.length, 1, 'the Web UI learns about sessions only from this event')
  assert.equal(added[0].payload.sessionId, id)
  assert.equal(added[0].payload.cwd, create.header.cwd, 'with the placement, so the row lands in the right group')
  assert.equal(added[0].payload.blank, false)
  assert.equal(added[0].payload.running, false)

  assert.deepEqual(harness.attached, [{ path: create.header.cwd, sessionId: id }], 'and it joins the caller\'s workspace')
})

test('spawn_main: runtime knobs from the source are carried as LOG-ONLY events after the turn', async () => {
  const harness = boot({
    sourceEvents: [
      { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'full' } },
      { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', seq: 2, time: 3, data: { policy: 'never' } },
      { type: 'model/selection', seq: 3, time: 4, data: { provider: 'deepseek', model: 'v4' } },
      { type: 'agent-preset/selected', seq: 4, time: 5, data: { agentPreset: 'cordis' } },
    ],
    sourceHeader: { agentPreset: 'standard' },
  })
  await spawnMain(harness, 'session-blank', 'plan')
  const { events, create } = theTape(harness)

  assert.equal(create.header.agentPreset, 'cordis', 'the EFFECTIVE preset, not the header\'s initial one')
  const turnEndAt = events.findIndex((event) => event.type === 'turn/end')
  const knobs = events.slice(turnEndAt + 1)
  assert.deepEqual(
    knobs.map((event) => event.type),
    ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection'],
    'knobs follow the closed turn, exactly where DSH writes them',
  )
  for (const knob of knobs) assert.equal(knob.surfaceOp, undefined, `${knob.type} is log-only`)
})

/* ── the pair ──────────────────────────────────────────────────────────────── */

test('spawn_main: the pair is recorded with ROLES, both ways, only after the artifact exists', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', 'plan text')
  const { id } = theTape(harness)
  assert.equal(reply.sessionId, id)

  const state = debugObserverState()
  // The pair key is order-independent (`[a, b].sort().join('|')`), so it is read through the
  // index rather than rebuilt in the test: an id whose hex tail sorts before "blank" would
  // otherwise make a correct implementation look wrong.
  const key = state.pairOf['session-blank']
  assert.equal(key, state.pairOf[id], 'both members index the same row')
  assert.equal(state.pairs[key].observerSessionId, 'session-blank')
  assert.equal(state.pairs[key].mainSessionId, id)
  assert.equal(state.pairs[key].origin, 'incubated')
  assert.equal(Object.keys(state.pairs).length, 1, 'one row, not one per direction')
  assert.equal(existsSync(harness.bindingsPath), true, 'and it is on disk')
})

test('spawn_main: only the OBSERVER is renamed — the main\'s name is already in its tape', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan text')
  assert.equal(harness.renames.length, 1, 'one rename, on the live half')
  assert.equal(harness.renames[0].sessionId, 'session-blank')
  assert.match(harness.renames[0].title, /\[副脑\]/u)
})

/* ── refusals: nothing is created, and the reason is stated ────────────────── */

test('spawn_main: an empty plan is refused before anything is created', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'session-blank', '   ')

  assert.equal(reply.ok, false)
  assert.match(reply.text, /方案为空/u)
  assert.equal(harness.persistence.createCalls.length, 0, 'no session, no orphan')
  assert.equal(harness.sessions.prepareCalls.length, 0)
})

test('spawn_main: a session that is already a MAIN cannot hatch another main', async () => {
  const harness = boot()
  const first = await spawnMain(harness, 'session-blank', 'plan')
  const again = await spawnMain(harness, first.sessionId, 'another plan')

  assert.equal(again.ok, false)
  assert.match(again.text, /已经是主脑/u)
  assert.equal(harness.persistence.createCalls.length, 1, 'no second incubation')
})

/**
 * v1.2.3 — THE INVARIANT THAT SHIPPED BROKEN.
 *
 * `recordPair` wrote the new row and overwrote `pairOf`, but left every PREVIOUS row naming the same
 * session. Three incubations from one consulting session therefore produced three rows sharing an
 * observer, with `pairOf` keeping only the newest — "which pair is this session in?" had three
 * answers, and the live bindings file showed exactly that.
 *
 * A re-incubation now DISSOLVES the older pair. One session, one pair, always.
 */
test('pairs: re-incubating dissolves the previous pair instead of stacking a third', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan A')
  await spawnMain(harness, 'session-blank', 'plan B')
  const third = await spawnMain(harness, 'session-blank', 'plan C')

  assert.equal(third.ok, true, third.text)
  assert.equal(harness.persistence.createCalls.length, 3, 'each attempt created its own artifact')

  const state = debugObserverState()
  assert.equal(Object.keys(state.pairs).length, 1, 'exactly ONE pair survives')
  const only = Object.values(state.pairs)[0]
  assert.equal(only.observerSessionId, 'session-blank')
  assert.equal(only.mainSessionId, third.sessionId, 'the newest main is the bound one')

  // The index must agree with the single remaining row, and no stale member may linger.
  assert.equal(Object.keys(state.pairOf).length, 2, 'only the two live members are indexed')
  assert.equal(state.pairOf['session-blank'], Object.keys(state.pairs)[0])
  assert.equal(state.pairOf[third.sessionId], Object.keys(state.pairs)[0])
  const earlier = harness.persistence.createCalls.slice(0, 2).map((call) => call.header.id)
  for (const retired of earlier) {
    assert.equal(state.pairOf[retired], undefined, `${retired} is no longer indexed`)
  }

  // And the reply says so, because a `[主脑]` session left in the sidebar with no pointer is
  // otherwise inexplicable to the user.
  assert.match(third.text, /上一个主脑/u)
  assert.match(third.text, /绑定已解除/u)
})

/**
 * Either half can hit the watermark and be grafted. The pointer moves; the other half is untouched
 * and NOTHING waits — which is what keeps a mutual-graft deadlock impossible.
 */
test('transfer: when the MAIN is grafted, the observer follows it', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const mainId = Object.values(debugObserverState().pairs)[0].mainSessionId

  const followed = debugFollowTransfer(mainId, 'session-main-1b')
  assert.equal(followed.followed, true)
  assert.equal(followed.role, 'main', 'the MAIN half moved')

  const state = debugObserverState()
  assert.equal(state.pairs[`session-blank|session-main-1b`].mainSessionId, 'session-main-1b', 'the new main is the member')
  assert.equal(state.pairs[`session-blank|session-main-1b`].observerSessionId, 'session-blank', 'the observer is unchanged')
  assert.equal(state.pairOf[mainId], undefined, 'the stale id is no longer indexed')
})

test('transfer: when the OBSERVER is grafted, the main follows it', async () => {
  const harness = boot()
  const first = await spawnMain(harness, 'session-blank', 'plan')

  const followed = debugFollowTransfer('session-blank', 'session-blank-2')
  assert.equal(followed.followed, true)
  assert.equal(followed.role, 'observer', 'the OBSERVER half moved')

  const state = debugObserverState()
  const key = state.pairOf['session-blank-2']
  assert.equal(state.pairs[key].observerSessionId, 'session-blank-2')
  assert.equal(state.pairs[key].mainSessionId, first.sessionId, 'the main is unchanged')
  assert.equal(state.pairOf['session-blank'], undefined, 'the old observer id is gone from the index')
})

test('transfer: the focus note names the MAIN, whichever half moved', async () => {
  const harness = boot()
  const first = await spawnMain(harness, 'session-blank', 'plan')

  debugFollowTransfer('session-blank', 'session-blank-2') // observer moves
  assert.equal(debugObserverState().focus.sessionId, first.sessionId, 'the user is sent to the main')

  debugFollowTransfer(first.sessionId, 'session-main-1b') // main moves
  assert.equal(debugObserverState().focus.sessionId, 'session-main-1b', 'and follows the main')
})

test('transfer: an unrelated session is ignored, and the pair survives', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')
  const before = JSON.stringify(debugObserverState().pairs)

  const followed = debugFollowTransfer('someone-else', 'somewhere-else')
  assert.equal(followed.followed, false)
  assert.equal(JSON.stringify(debugObserverState().pairs), before, 'nothing moved')
})

/**
 * v1.2.0 — ONE PAIR PER SESSION.
 *
 * `pairOf` is the index every role question goes through, so a session appearing in two pairs would
 * make "is this the observer?" ambiguous. `recordPair` overwrites the index for its own members,
 * and these cases prove the invariant holds through an incubation and a transfer.
 */
test('pairs: a session indexes exactly one pair, before and after a transfer', async () => {
  const harness = boot()
  await spawnMain(harness, 'session-blank', 'plan')

  const check = (state) => {
    for (const [sessionId, key] of Object.entries(state.pairOf)) {
      assert.ok(state.pairs[key] !== undefined, `pairOf[${sessionId}] must point at a real row`)
      const pair = state.pairs[key]
      assert.ok(
        pair.observerSessionId === sessionId || pair.mainSessionId === sessionId,
        `${sessionId} must be a member of ${key}`,
      )
    }
    const seen = new Set()
    for (const [key, pair] of Object.entries(state.pairs)) {
      assert.ok(!seen.has(pair.observerSessionId), 'an observer belongs to one pair')
      assert.ok(!seen.has(pair.mainSessionId), 'a main belongs to one pair')
      seen.add(pair.observerSessionId)
      seen.add(pair.mainSessionId)
      assert.equal(state.pairOf[pair.observerSessionId], key)
      assert.equal(state.pairOf[pair.mainSessionId], key)
    }
  }

  check(debugObserverState())
  debugFollowTransfer('session-blank', 'session-blank-2')
  check(debugObserverState())
})
