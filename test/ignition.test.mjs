/**
 * dsh-observer v1.9.0 — IGNITION, THROUGH THE 彼岸 LAYER.
 *
 * WHAT CHANGED, AND WHY THIS FILE WAS REWRITTEN RATHER THAN DELETED
 *
 * v1.5.0 tested `src/core/ignition.ts`: the marker, the required AbortSignal, the idempotence check,
 * "unreadable is unknown". That module is now an ARCHIVE — the incubation calls
 * `paradise.session.trigger`, which carries the same four properties, moved into the layer
 * (`adapters/dsh/trigger.ts`).
 *
 * Deleting these cases would have dropped the only guard on a piece of behaviour that cost a release
 * to learn. Keeping them pointed at the archived module would have been worse: they would certify code
 * that no longer runs.
 *
 * So they are REWRITTEN against the path that actually executes, and the properties are asserted
 * through the observer's own receipt — which is what the user sees.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, injectionInternals } from '../index.js'
import { makeHost } from './harness.mjs'

const { ensureWriteAdapter, writePathStatus } = injectionInternals

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

const spawnMain = (harness, plan, extra = {}) =>
  harness.tools
    .get('observer_spawn_main')
    .execute({ plan, observerSessionId: 'session-blank', userConfirmed: true, ...extra }, {})

/* ── 1. the layer is REACHED, and its write surface is what we expect ────── */

test('ignition: the write adapter resolves, and names the layer version it got', async () => {
  const host = boot()
  const writer = await ensureWriteAdapter(host.ctx)
  assert.equal(writer.ok, true, writer.reason)
  assert.match(writer.layerName, /^dsh-/u, 'the adapter bundle names itself')
  assert.equal(typeof writer.session.trigger, 'function', 'trigger is part of the adapter surface')
  assert.equal(typeof writer.deletes, 'function', 'so is the rollback')
})

test('ignition: the write path reports a THREE-VALUED state before anything is used', () => {
  const status = writePathStatus()
  assert.equal(typeof status.resolved, 'boolean')
  assert.equal(typeof status.available, 'boolean')
  assert.ok(status.consequence.length > 0, 'the cost of absence is always stated')
})

/* ── 2. the receipt the tool reports ─────────────────────────────────────── */

test('receipt: a successful incubation reports ignition: attempted + ok + channel', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划\n1. 干活')
  assert.equal(reply.ok, true, reply.text)
  assert.ok(reply.ignition, 'the ignition outcome travels with the success')
  assert.equal(reply.ignition.attempted, true)
  assert.equal(reply.ignition.ok, true)
  assert.match(reply.ignition.channel ?? '', /prompt/u, 'and it names the channel that admitted it')
})

test('receipt: the ignition prompt went through sessionController.prompt', async () => {
  const host = boot()
  await spawnMain(host, '## 计划')
  assert.equal(host.prompts.length >= 1, true, 'a prompt really was admitted')
  const ignitionPrompt = host.prompts.find((entry) => Array.isArray(entry.content))
  assert.ok(ignitionPrompt !== undefined)
  assert.equal(ignitionPrompt.mode, 'queue', 'ignition queues: the session is asleep when it is written')
})

test('receipt: a host with NO ignition channel still incubates and says so plainly', async () => {
  /**
   * A FAILED IGNITION DOES NOT UNDO THE INCUBATION. The artifact is real, carries its plan and is
   * openable by hand; what must not happen is a silent success. This host has no prompt channel.
   */
  const host = boot()
  /** Remove the prompt channel AFTER the adapter would resolve it, by making it throw. */
  const realGet = host.ctx.get
  host.ctx.get = (name) => {
    if (name === 'sessionController') return { create: async () => ({ sessionId: 'x' }), rename: async () => ({}) }
    return realGet.call(host.ctx, name)
  }
  host.ctx.sessionController = { create: async () => ({ sessionId: 'x' }), rename: async () => ({}) }

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, 'the incubation still stands')
  assert.equal(reply.ignition.ok, false, 'but ignition is reported as failed')
  assert.equal(reply.ignition.attempted, false, 'and "was there even a channel?" is answered')
  assert.match(reply.text, /自动点火：失败/u)
  assert.match(reply.text, /没有可用的点火通道/u)
})

/* ── 3. ordering: ignition runs LAST ─────────────────────────────────────── */

test('ordering: ignition happens only after the artifact is durable and bound', async () => {
  /**
   * THE FAILURE MODE THIS PREVENTS: igniting first means the main can start working and fail before
   * anything knows it exists. Observable proof: by the time a prompt is admitted, the persisted tape
   * already exists and the pair is already recorded.
   *
   * HOW THE HOOK IS INSTALLED: the fixture's `ctx.get('sessionController')` returns a FRESH object on
   * every call, so patching the returned value would patch a throwaway. The `get` itself is wrapped.
   */
  const host = boot()
  let persistedWhenPrompted = -1
  let pairWhenPrompted = ''
  const realGet = host.ctx.get
  host.ctx.get = (name) => {
    const value = realGet.call(host.ctx, name)
    if (name !== 'sessionController' || value === undefined) return value
    return {
      ...value,
      async prompt(request, signal) {
        persistedWhenPrompted = host.persistence.createCalls.length
        const { debugObserverState } = await import('../index.js')
        pairWhenPrompted = JSON.stringify(debugObserverState().pairs)
        return value.prompt(request, signal)
      },
    }
  }

  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(persistedWhenPrompted, 1, 'the tape existed before the prompt was admitted')
  assert.match(pairWhenPrompted, /incubated/u, 'and the pair was already recorded')
})

/* ── 4. the four properties the archived module taught, still in force ───── */

test('property: the ignition prompt carries the marker (so a retry can recognise itself)', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  const admitted = host.prompts.find((entry) => Array.isArray(entry.content))
  const text = admitted?.content?.[0]?.text ?? ''
  assert.match(text, /^\[dsh-observer 点火\]/u, 'the marker prefixes every ignition prompt')
})

test('property: the prompt tells the main to START, not to summarise', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  const text = host.prompts.find((entry) => Array.isArray(entry.content))?.content?.[0]?.text ?? ''
  assert.match(text, /直接按方案开始执行/u, 'a main that re-sums up its own plan has wasted a turn')
  assert.match(text, /不要复述方案/u)
  assert.match(text, /不要问「你要我做什么」/u)
})

test('property: the ignition request is bound to the MAIN, never to the observer', async () => {
  const host = boot()
  const reply = await spawnMain(host, '## 计划')
  assert.equal(reply.ok, true, reply.text)
  const admitted = host.prompts.find((entry) => Array.isArray(entry.content))
  assert.equal(admitted.sessionId, reply.sessionId, 'the prompt wakes the main')
  assert.notEqual(admitted.sessionId, 'session-blank', 'not the session that hatched it')
})
