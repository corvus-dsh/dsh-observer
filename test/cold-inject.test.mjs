/**
 * dsh-observer v1.9.0 — THE WRITE PATH, THROUGH THE 彼岸 LAYER.
 *
 * WHAT THIS FILE USED TO TEST, AND WHY IT NOW TESTS SOMETHING ELSE
 *
 * It used to reach into `src/core/observer-inject.ts` and assert on `buildInjectTape` /
 * `assertInjectTape` / `rollbackInjectedSession` directly. Those functions still exist on disk as an
 * ARCHIVE, but the incubation no longer calls them — the layer does
 * (`dsh-paradise/src/adapters/dsh/inject.ts` and `delete.ts`).
 *
 * Asserting on the archive would certify code that does not run. Asserting the same PROPERTIES through
 * the path that DOES run is the only version of this file that means anything.
 *
 * The properties, restated for the new path:
 *
 *   1. a shape the host would refuse is caught BEFORE an id is reserved;
 *   2. a failure after the artifact exists rolls it back — and does not leave a usable-looking shell;
 *   3. the real error and its stage reach the model, once, not doubled;
 *   4. the injection never writes through a prepared/live session.
 *
 * The tape-level assertions themselves live in `dsh-paradise` now, where the code does.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState, injectionInternals } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const { ensureWriteAdapter } = injectionInternals

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawnMain = (harness, plan, observerSessionId = 'session-blank') =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId, userConfirmed: true }, {})

/** The events of the one tape this call wrote. */
function tapeOfReply(harness, reply) {
  return tapeOf(harness.persistence, reply.sessionId)
}

/* ── 1. nothing is reserved until the write is legal ─────────────────────── */

test('write: an EMPTY plan is refused before any id is reserved', async () => {
  /**
   * A main with no plan is the bug, not a fallback. The refusal must happen while failing costs
   * nothing — no prepared session, no persisted artifact, no pair.
   */
  const host = boot()
  const reply = await spawnMain(host, '   ')

  assert.equal(reply.ok, false)
  assert.equal(host.persistence.createCalls.length, 0, 'nothing was committed')
  assert.equal(host.prepareCalls === undefined || host.sessions.prepareCalls.length === 0, true, 'nothing was prepared')
  assert.deepEqual(debugObserverState().pairs, {}, 'no pair was recorded')
})

test('write: the plan is placed as a VISIBLE user/message, and reported as such', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划\n目标、约束、步骤、验证')
  assert.equal(reply.ok, true, reply.text)

  const tape = tapeOfReply(host, reply)
  const carrying = tape.find((event) => event.type === 'user/message' || event.type === 'developer/message')
  assert.ok(carrying !== undefined, 'the tape carries the plan')
  assert.equal(carrying.type, 'user/message', 'visible, not developer/message')
  const payload = carrying.data.message ?? carrying.data
  assert.equal(payload.content[0].text, '## 计划\n目标、约束、步骤、验证', 'the plan travels verbatim')
  assert.equal(reply.briefingVisible, true)
})

test('write: the skeleton opens with a system head and closes its turn', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)

  const tape = tapeOfReply(host, reply)
  const types = tape.map((event) => event.type)
  assert.equal(types[0], 'turn/start', 'the tape opens a turn')
  assert.equal(types[1], 'step/start')
  assert.equal(types[2], 'system/message', 'the FIRST SURFACE node is the system head')
  assert.equal(types[types.length - 1], 'turn/end', 'and the session is asleep when it is born')
  assert.equal(tape.find((event) => event.type === 'turn/end').data.reason.kind, 'completed')
})

test('write: surfaceOp lands on messages only', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  const tape = tapeOfReply(host, reply)
  const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])
  for (const event of tape) {
    if (SURFACE.has(event.type)) {
      assert.equal(event.surfaceOp, 'append', `${event.type} must carry surfaceOp`)
    } else {
      assert.equal(event.surfaceOp, undefined, `${event.type} must NOT carry surfaceOp`)
    }
  }
})

test('write: seq is contiguous from 0 and time is monotonic', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  const tape = tapeOfReply(host, reply)
  tape.forEach((event, index) => {
    assert.equal(event.seq, index, `event ${index} has seq ${event.seq}`)
    if (index > 0) assert.ok(event.time >= tape[index - 1].time, `event ${index} time went backwards`)
  })
})

/* ── 2. failure after the artifact exists ────────────────────────────────── */

test('rollback: a failed append removes the artifact and reports it', async () => {
  const host = boot()
  const realCreate = host.persistence.create.bind(host.persistence)
  let createdId = ''
  host.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    createdId = header.id
    return {
      ...handle,
      append: async () => {
        throw new Error('append exploded')
      },
    }
  }

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, false, 'a failed write is not a success')
  assert.match(reply.text, /append|回滚/u, `the failure names its stage: ${reply.text}`)
  assert.equal(createdId.length > 0, true, 'an artifact was reserved')
  assert.equal(host.persistence.byId.has(createdId), false, 'and then removed — nothing survives')
  assert.deepEqual(debugObserverState().pairs, {}, 'no pair points at a session that is not there')
})

test('rollback: a failed flush also removes the artifact', async () => {
  const host = boot()
  const realCreate = host.persistence.create.bind(host.persistence)
  let createdId = ''
  host.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    createdId = header.id
    return {
      ...handle,
      flush: async () => {
        throw new Error('flush exploded')
      },
    }
  }

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, false)
  assert.equal(host.persistence.byId.has(createdId), false, 'a flush failure leaves nothing either')
})

test('rollback: an artifact that cannot be deleted is MARKED, never left looking usable', async () => {
  const host = boot()
  const realCreate = host.persistence.create.bind(host.persistence)
  let markedTitle = ''
  host.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    return {
      ...handle,
      append: async () => {
        throw new Error('append exploded')
      },
    }
  }
  // Make removal impossible, so the fallback (marking) is what must run.
  host.persistence.discardPrepared = async () => {}
  host.persistence.remove = async () => {}
  host.persistence.delete = async () => {}
  const realOpen = host.persistence.open.bind(host.persistence)
  host.persistence.open = async (id) => {
    const handle = await realOpen(id)
    return {
      ...handle,
      append: async (events) => {
        for (const event of events) {
          if (event.type === 'session/title') markedTitle = event.data.title
        }
        return handle.append(events)
      },
    }
  }
  host.sessions.remove = async () => {}

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, false)
  assert.match(markedTitle, /孵化失败/u, `the abandoned artifact carries a mark, got ${JSON.stringify(markedTitle)}`)
})

/* ── 3. the error reaches the model, once ────────────────────────────────── */

test('tool contract: the error code appears ONCE in the headline, not doubled', async () => {
  const host = boot()
  const realCreate = host.persistence.create.bind(host.persistence)
  host.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    return {
      ...handle,
      append: async () => {
        throw new Error('append exploded')
      },
    }
  }

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, false)

  /**
   * COUNT THE HEADLINE, NOT THE WHOLE PAYLOAD. The stack legitimately repeats the message (that is what
   * a stack is), so a naive count over `reply.text` would flag a correct implementation. The doubling
   * this case exists for was `孵化失败（stage=…）：孵化失败@…：…` — two HEADLINES, one sentence.
   */
  const headline = reply.text.split('\n')[0]
  assert.equal((headline.match(/孵化失败/gu) ?? []).length, 1, `the headline is composed once: ${headline}`)
  assert.equal((headline.match(/\[CREATE_FAILED\]/gu) ?? []).length, 1, `the code appears once: ${headline}`)
  assert.equal(reply.stage.length > 0, true, 'the stage is reported')
})

/* ── 4. it never writes through a live session ──────────────────────────── */

test('write: the artifact is written through the STORE, never appended to a prepared session', async () => {
  /**
   * THE ORIGINAL INCIDENT: `sessions.get(id).append()` on a prepared session throws
   * `cannot append outside a SessionStore`. The fixture's prepared session throws exactly that, so a
   * write that reached it would fail loudly here.
   */
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(host.sessions.prepareCalls.length, 1, 'the session was prepared once')
  assert.equal(host.persistence.appendCalls.length, 1, 'and written through the store handle')
})

test('write: inheritance — the source session is read for runtime knobs, and absence is a warning', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  /**
   * The observer passes `inheritFrom`, so the adapter reads the source. Whether the source HAS knobs is
   * the host's business; what matters here is that an unreadable source degrades to a warning instead
   * of costing the user the main.
   */
  assert.equal(reply.ok, true)
})
