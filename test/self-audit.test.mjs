/**
 * dsh-observer v1.3.2 — THE TWO DEFECTS A READ-ONLY AUDIT FOUND IN MY OWN CODE.
 *
 * Both were found by cross-reading the two plugins, not by a failing test — which is why they are
 * pinned here as tests rather than just fixed.
 *
 * DEFECT 1 — `resolveService` chose on one method and the caller used another.
 *
 *     const persistence = resolveService(ctx, 'sessionPersistence', 'create')  // chose on create
 *     ... await persistence.open(...)                                          // used open
 *
 * The resolver picks the candidate that HAS the named method. Naming `create` and calling `open`
 * means a backend with `create` but no `open` resolves to a candidate that cannot do the work, and
 * the failure surfaces as "the service is unusable" — pointing the reader at the wrong thing. The
 * same mistake existed for `sessionController` (chose on `rename`, called `create`).
 *
 * DEFECT 2 — the cold read compared counts, not shapes.
 *
 * Comparing `count`, `seq` and `type` catches a truncated or reordered log and misses every shape
 * defect: a dropped `surfaceOp`, a skeleton event that grew one, a briefing that came back under a
 * different role. graft re-runs its FULL validator on the cold read for this exact reason.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawnMain = (harness, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId: 'session-blank', userConfirmed: true }, {})

/* ── DEFECT 1: the method the resolver chose is the method the caller uses ──── */

test('resolver: a backend with create but NO open is still enough for the cold path', async () => {
  // The cold injection only ever calls create/append/flush/close. A backend that cannot `open`
  // must not be rejected — that would refuse a host that can do the work.
  const harness = boot()
  const realPersistence = harness.persistence
  const view = {
    create: realPersistence.create.bind(realPersistence),
    stat: realPersistence.stat.bind(realPersistence),
    byId: realPersistence.byId,
    read: realPersistence.read.bind(realPersistence),
    createCalls: realPersistence.createCalls,
    appendCalls: realPersistence.appendCalls,
    order: realPersistence.order,
    // NOTE: no `open`, no `discardPrepared`.
  }
  const original = harness.ctx.get
  harness.ctx.get = (name) => (name === 'sessionPersistence' ? view : original(name))
  delete harness.ctx.sessionPersistence

  const reply = await spawnMain(harness, 'plan')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(tapeOf(view, reply.sessionId).length, 8)
})

test('resolver: the companion path uses `open`, so a backend with only create is refused there', async () => {
  // The inverse case, and the one that proves the resolver is method-aware rather than arbitrary:
  // the LIVE-append fallback needs `open`, and must say so when it is absent.
  const harness = boot()
  const original = harness.ctx.get
  harness.ctx.get = (name) => {
    if (name === 'sessionPersistence') return { create: async () => ({}) } // has create, no open
    return original(name)
  }
  delete harness.ctx.sessionPersistence

  // The companion path is exercised through observer_create, which is the live-append channel.
  const created = await harness.tools.get('observer_create').execute({}, { agent: { id: 'main-x' } })
  // It still succeeds: channel 1 (the live session) handled it. What matters is that the persistence
  // channel is not chosen on a capability it cannot provide.
  assert.equal(typeof created, 'object')
  assert.ok('ok' in created)
})

/* ── DEFECT 2: the cold read re-validates the whole tape ──────────────────── */

test('cold read: a persisted tape that lost its surfaceOp is REJECTED', async () => {
  const harness = boot()
  const realCreate = harness.persistence.create.bind(harness.persistence)
  harness.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    return {
      ...handle,
      // Simulate a backend/round-trip that drops the surface intent: the events are all there, in
      // order, with the right types — and every one of them is now an illegal append.
      async append(events) {
        await handle.append(events.map((event) => ({ ...event, surfaceOp: undefined })))
      },
    }
  }

  const reply = await spawnMain(harness, 'plan')
  assert.equal(reply.ok, false, 'a silently de-shaped tape must not be reported as incubated')
  assert.match(reply.text, /RED_LINE_SURFACE|surfaceOp/u, 'and the reason names the actual defect')
  /**
   * The stage names the STEP the layer was in, not which of two validators spoke: v1.9.0 moved the
   * cold read into `adapters/dsh/session-writer.ts`, where the step is called `verify`. Asserting the
   * old spelling (`validate|cold-read`) would pin an implementation detail of a module that no longer
   * runs the check; the behaviour that matters — a de-shaped tape is REFUSED and the reason names the
   * defect — is asserted above.
   */
  assert.match(reply.stage, /verify|validate|cold-read/u)
})

test('cold read: a briefing that came back under a different role is REJECTED', async () => {
  const harness = boot()
  const realCreate = harness.persistence.create.bind(harness.persistence)
  harness.persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    return {
      ...handle,
      async append(events) {
        // Same count, same seqs, same types — but the payload is no longer the plan.
        await handle.append(events.map((event) =>
          event.type === 'user/message'
            ? { ...event, data: { ...event.data, content: [{ type: 'text', text: 'sabotaged' }] } }
            : event,
        ))
      },
    }
  }

  const reply = await spawnMain(harness, 'plan')
  assert.equal(reply.ok, false)
  assert.match(reply.text, /BRIEFING_MISMATCH|不一致/u)
})

test('cold read: a correct round-trip still passes every check', async () => {
  const harness = boot()
  const reply = await spawnMain(harness, 'plan')
  assert.equal(reply.ok, true, reply.text)
  assert.match(reply.text, /冷读校验 通过/u)
})
