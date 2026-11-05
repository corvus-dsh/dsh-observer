/**
 * dsh-observer v1.3.0 — THE HOST SHAPE, NOT A CONVENIENT ONE.
 *
 * Two wirings are real on DSH 0.2.2, and the plugin has to work under both:
 *
 *   A. `ctx.get('sessions')`            — the accessor the CLIENT half uses everywhere.
 *   B. `ctx.sessions` (direct property) — what an entry that DECLARES the service in `inject`
 *                                        gets, and what dsh-graft-slice relies on for
 *                                        `ctx.sessions.prepare`.
 *
 * These cases drive the incubation through each shape on its own, so "it works on my fixture"
 * cannot hide a host that only offers the other one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, VERSION } from '../index.js'
import { makeHost, tapeOf } from './harness.mjs'

const bindingsFor = () => join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')

/**
 * Reshape a host's ctx so the requested accessor is the ONLY one for the INJECTED services.
 *
 * `tools` and `commands` are not injected services — they are plain plugin-context properties the
 * entry registers through (`ctx.tools.register`, `ctx.commands.register`) and the host always
 * provides them. Deleting those would test a host that does not exist.
 */
const INJECTED = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionController', 'workspaceRegistry', 'workingDirectory']

function shaped(host, mode) {
  const original = host.ctx.get
  if (mode === 'get-only') {
    for (const key of INJECTED) delete host.ctx[key]
    return host
  }
  // 'property-only': `get` answers nothing for the injected services; they are plain properties.
  host.ctx.get = (name) => (INJECTED.includes(name) ? undefined : original(name))
  for (const key of INJECTED) host.ctx[key] = original(key)
  return host
}

const spawnMain = (harness, plan) =>
  harness.tools.get('observer_spawn_main').execute({ plan, observerSessionId: 'session-blank', userConfirmed: true }, {})

test('host shape: the incubation works when services arrive ONLY through ctx.get()', async () => {
  const host = shaped(makeHost(), 'get-only')
  apply(host.ctx, { bindingsPath: bindingsFor() })

  const reply = await spawnMain(host, 'plan through get')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(tapeOf(host.persistence, reply.sessionId).length, 8)
})

test('host shape: the incubation works when services arrive ONLY as direct properties', async () => {
  const host = shaped(makeHost(), 'property-only')
  apply(host.ctx, { bindingsPath: bindingsFor() })

  const reply = await spawnMain(host, 'plan through properties')
  assert.equal(reply.ok, true, reply.text)
  assert.equal(tapeOf(host.persistence, reply.sessionId).length, 8)
})

test('host shape: a genuinely absent sessionPersistence is still a refusal, not a fallback', async () => {
  const host = makeHost()
  const original = host.ctx.get
  host.ctx.get = (name) => (name === 'sessionPersistence' ? undefined : original(name))
  // Direct property absent too — the service really is not mounted.
  delete host.ctx.sessionPersistence
  apply(host.ctx, { bindingsPath: bindingsFor() })

  const reply = await spawnMain(host, 'plan')
  assert.equal(reply.ok, false)
  assert.match(reply.text, /sessionPersistence/u)
})

test('version: the constant matches the package so the host log identifies the live copy', async () => {
  const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})
