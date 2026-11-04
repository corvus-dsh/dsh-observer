/**
 * v0.1.8 GUARD — NO FALSE SUCCESS, AND THE CONSULT MODE.
 *
 * The live page reported `回执 {"ok":true}，但绑定表里没有该会话的副脑`. Two separate faults
 * were behind it, and both are pinned here:
 *
 *   1. the create command carried an `input` key that is not part of the command registration
 *      shape, and while it was there that ONE command never registered — the gateway answered
 *      the unknown line with a bare `{ok:true}`;
 *   2. `save()` swallowed write errors, so a failed write still produced a success reply.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'

function boot(bindingsPath) {
  const tools = new Map()
  const commands = new Map()
  const prompts = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessionController') {
        return {
          async create() {
            created += 1
            return { sessionId: `obs-${created}` }
          },
          async prompt(request) {
            prompts.push(request)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  const path = bindingsPath ?? join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath: path })
  return { tools, commands, prompts, path }
}

test('create command: no `input` key (it silently prevented registration)', () => {
  const { commands } = boot()
  const definition = commands.get('observer-create')
  assert.ok(definition !== undefined, 'observer-create is registered')
  assert.equal('input' in definition, false, 'an `input` hint kept this command from registering')
})

test('create command: answers JSON carrying the observer session id', async () => {
  const { commands } = boot()
  const reply = await commands.get('observer-create').handler({ rawInput: '/observer-create main-1' })
  assert.equal(reply.kind, 'success')
  const payload = JSON.parse(reply.text)
  assert.equal(payload.ok, true)
  assert.equal(payload.observerSessionId, 'obs-1')
  assert.equal(payload.mainSessionId, 'main-1')
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
})

test('create command: the binding is on DISK, not just in memory', async () => {
  const { commands, path } = boot()
  await commands.get('observer-create').handler({ rawInput: '/observer-create main-2' })
  assert.ok(existsSync(path), 'observer-bindings.json was written')
  const text = readFileSync(path, 'utf8')
  assert.match(text, /main-2/u)
})

test('create command: a refused bind is ok:false and names the reason', async () => {
  const { commands } = boot()
  await commands.get('observer-create').handler({ rawInput: '/observer-create main-3' })
  // The companion cannot be given a companion of its own.
  const chained = await commands.get('observer-create').handler({ rawInput: '/observer-create obs-1' })
  const payload = JSON.parse(chained.text)
  assert.equal(chained.kind, 'error')
  assert.equal(payload.ok, false)
  assert.match(payload.text, /副脑会话/u)
})

test('create command: an unwritable bindings path is reported, never claimed as success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-'))
  const blocker = join(root, 'blocked')
  writeFileSync(blocker, 'not a directory', 'utf8')
  // <file>/observer-bindings.json cannot be created: mkdir fails.
  const { commands } = boot(join(blocker, 'observer-bindings.json'))
  const reply = await commands.get('observer-create').handler({ rawInput: '/observer-create main-x' })
  const payload = JSON.parse(reply.text)
  assert.equal(reply.kind, 'error', 'a failed write must not look like a successful summon')
  assert.equal(payload.ok, false)
  assert.match(payload.text, /绑定表写入失败/u)
})

test('consult command: opens a companion with NO pointer and the pre-discussion mission', async () => {
  const { commands, prompts } = boot()
  const reply = await commands.get('observer-consult').handler({})
  assert.equal(reply.kind, 'success')
  const payload = JSON.parse(reply.text)
  assert.equal(payload.ok, true)
  assert.equal(payload.observerSessionId, 'obs-1')
  assert.deepEqual(debugObserverState().bindings, {}, 'a consultation companion is not bound to anything')
  assert.match(prompts[0].content[0].text, /前置需求分析副脑/u)
  assert.match(prompts[0].content[0].text, /最终 Prompt/u)
})
