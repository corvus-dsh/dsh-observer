/**
 * dsh-observer — the CREATE/BIND contract, asserted through the TOOLS.
 *
 * v1.0.3 moved this file off the command surface: `observer-create` and `observer-consult` are
 * deleted (every command invocation printed a row into the conversation, which is the ghost
 * polling the user kept seeing). The same logic is reachable as `observer_create` /
 * `observer_consult` / `observer_bind`, and that is what these cases exercise.
 *
 * v1.0.4 dropped the `agent/pre-step` staging entirely: the role is now one ordinary message plus
 * a `[副脑]` title, so nothing here touches the decision the agent loop builds.
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
  const listeners = new Map()
  const prompts = []
  const appends = []
  const renames = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessions') {
        return {
          /** A live session: the header carries the cwd Plan B resolves, append captures the setting. */
          get: (id) => ({
            header: { cwd: 'D:/test/project' },
            append: (type, data, options) => {
              appends.push({ id, type, data, options })
            },
          }),
        }
      }
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
          async rename(request) {
            renames.push(request)
            return { title: request.title, seq: renames.length }
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  const path = bindingsPath ?? join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath: path })
  return { tools, commands, listeners, prompts, appends, renames, path }
}

test('observer_create: answers with the observer session id and binds it', async () => {
  const { tools } = boot()
  const created = await tools.get('observer_create').execute({}, { agent: { id: 'main-1' } })
  assert.equal(created.ok, true)
  assert.equal(created.observerSessionId, 'obs-1')
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-1' })
})

test('observer_create: the binding is on DISK, not just in memory', async () => {
  const { tools, path } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-2' } })
  assert.ok(existsSync(path), 'observer-bindings.json was written')
  assert.match(readFileSync(path, 'utf8'), /main-2/u)
})

test('observer_create: a refused bind is ok:false and names the reason', async () => {
  const { tools } = boot()
  await tools.get('observer_create').execute({}, { agent: { id: 'main-3' } })
  // The companion cannot be given a companion of its own.
  const chained = await tools.get('observer_create').execute({}, { agent: { id: 'obs-1' } })
  assert.equal(chained.ok, false)
  assert.match(chained.text, /副脑会话/u)
})

test('observer_create: an unwritable bindings path is reported, never claimed as success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-'))
  const blocker = join(root, 'blocked')
  writeFileSync(blocker, 'not a directory', 'utf8')
  // <file>/observer-bindings.json cannot be created: mkdir fails.
  const { tools } = boot(join(blocker, 'observer-bindings.json'))
  const reply = await tools.get('observer_create').execute({}, { agent: { id: 'main-x' } })
  assert.equal(reply.ok, false, 'a failed write must not look like a successful summon')
  assert.match(reply.text, /绑定表写入失败/u)
})

test('observer_consult: a companion with NO pointer, titled and given its setting physically', async () => {
  const { tools, prompts, appends, renames } = boot()
  const reply = await tools.get('observer_consult').execute({})
  assert.equal(reply.ok, true)
  assert.equal(reply.observerSessionId, 'obs-1')
  assert.deepEqual(debugObserverState().bindings, {}, 'a consultation companion is not bound to anything')
  assert.match(renames[0].title, /\[副脑\]/u)
  assert.equal(prompts.length, 0, 'no prompt: nothing starts the agent loop')
  const message = appends.find((entry) => entry.type === 'developer/message')
  assert.ok(message !== undefined, 'a developer message is written')
  const text = message.data.message.content[0].text
  assert.match(text, /前置需求分析副脑/u)
  assert.match(text, /最终 Prompt/u)
})

/**
 * v1.0.5 — THE SETUP MUST NOT LIE ABOUT A PARTIAL RESULT.
 *
 * If the rename fails, or the setting cannot be written by EITHER channel, the reply says so
 * instead of reporting a clean summon: a companion that can never be recognised by its title would
 * keep showing the summon button, and one with no background would silently misbehave.
 */
test('observer_create: a failed rename and an unwritable log are both reported', async () => {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: () => {} }
      /**
       * The MAIN session carries a header, so Plan B can resolve its cwd. The CREATED companion has
       * neither a live `append` nor a `sessionPersistence`, so the setting cannot be written and the
       * reply has to say so.
       */
      if (name === 'sessions') {
        return { get: (id) => (id === 'main-broken' ? { header: { cwd: 'D:/test/project' } } : {}) }
      }
      if (name === 'sessionController') {
        return {
          async create() {
            return { sessionId: 'obs-broken' }
          },
          async rename() {
            throw new Error('rename refused')
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }
  apply(ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })

  const reply = await tools.get('observer_create').execute({}, { agent: { id: 'main-broken' } })
  assert.equal(reply.ok, true, 'the pointer IS durable, so the summon itself succeeded')
  assert.equal(reply.sessionId, 'obs-broken', 'and the id is still answered to the model')
  assert.match(reply.text, /部分步骤未完成/u, 'but the partial failure is stated, not hidden')
  assert.match(reply.text, /rename refused/u)
  assert.match(reply.text, /设定写入失败/u)
})

/**
 * v1.0.4 — THE STEP PATH IS UNTOUCHED.
 *
 * This is the regression guard for the 404: if any future change registers a listener on
 * `agent/pre-step` again, this fails immediately.
 */
test('no listener is registered on agent/pre-step', () => {
  const { listeners } = boot()
  assert.equal(listeners.has('agent/pre-step'), false, 'the request pipeline must stay untouched')
})
