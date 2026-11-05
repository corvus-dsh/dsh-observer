/**
 * dsh-observer v1.0.9 — THE HOST CREATES THE COMPANION.
 *
 * The Client used to create the session through `sessions.create`, and on this build that could not
 * place it in a workspace (the local summary carries no `cwd`): the create went out bare and the UI
 * fell into the "选择工作区" empty draft. Creation now belongs to the Host, which reads the MAIN
 * session's own header — the authoritative path — and hands it to its own create call.
 *
 * These cases pin the whole host-side path: the cwd is resolved from the session header (with the
 * `workingDirectory` service as the documented fallback), the create receives it, and the companion
 * is titled + given its setting + bound. A missing cwd REFUSES instead of creating an orphan.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, debugObserverState } from '../index.js'

/**
 * `mainSession` is what `sessions.get(mainId)` answers; `workingDirectoryPath` is what the
 * `workingDirectory` service answers. Either can be null to exercise the refusal.
 */
function boot({ mainSession = { header: { cwd: 'D:/project' } }, workingDirectoryPath = null } = {}) {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const prompts = []
  const appends = []
  const renames = []
  const creates = []
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessions') {
        return {
          get: (id) => {
            if (id === 'obs-new' || String(id).startsWith('obs-')) return { append: (type, data) => appends.push({ id, type, data }) }
            return mainSession ?? undefined
          },
        }
      }
      if (name === 'workingDirectory') return { get: () => workingDirectoryPath ?? '' }
      if (name === 'sessionController') {
        return {
          async create(request) {
            creates.push(request)
            created += 1
            return { sessionId: 'obs-new' }
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
  const bindingsPath = join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json')
  apply(ctx, { bindingsPath })
  return { commands, tools, listeners, prompts, appends, renames, creates, bindingsPath }
}

const spawnWith = async (harness, mainSessionId) => {
  const handler = harness.commands.get('observer-spawn').handler
  return handler({ rawInput: `/observer-spawn ${mainSessionId}` })
}

test('spawn: exactly one command is registered, and it is the spawn request', () => {
  const harness = boot()
  assert.deepEqual([...harness.commands.keys()], ['observer-spawn'])
})

test('spawn: the companion is created IN the main session\'s cwd, from the session header', async () => {
  const harness = boot({ mainSession: { header: { cwd: 'D:/work/live2d' } } })
  const reply = await spawnWith(harness, 'main-1')

  assert.equal(harness.creates.length, 1, 'the host created exactly one session')
  assert.deepEqual(harness.creates[0], { cwd: 'D:/work/live2d' }, 'with the MAIN session\'s own path')
  assert.equal(reply.kind, 'success')
  assert.equal(reply.text, 'obs-new', 'the new id is the command reply')
  assert.deepEqual(debugObserverState().bindings, { 'main-1': 'obs-new' })
})

test('spawn: the workingDirectory service is the documented fallback for the path', async () => {
  const harness = boot({ mainSession: {}, workingDirectoryPath: 'D:/fallback/dir' })
  await spawnWith(harness, 'main-2')
  assert.deepEqual(harness.creates[0], { cwd: 'D:/fallback/dir' })
})

test('spawn: no path available means NO SESSION, with the reason stated', async () => {
  const harness = boot({ mainSession: {}, workingDirectoryPath: '' })
  const reply = await spawnWith(harness, 'main-3')

  assert.equal(reply.kind, 'error')
  assert.match(reply.text, /拿不到主会话的工作目录/u, 'it names what could not be resolved')
  assert.equal(harness.creates.length, 0, 'and creates nothing — no orphan session')
  assert.deepEqual(debugObserverState().bindings, {})
})

test('spawn: the companion is titled, given its setting physically, and never prompted', async () => {
  const harness = boot()
  await spawnWith(harness, 'main-4')

  assert.equal(harness.renames.length, 1, 'titled once')
  assert.match(harness.renames[0].title, /\[副脑\]/u, 'with the marker the client reads')
  assert.equal(harness.prompts.length, 0, 'NOT prompted: the agent loop must not start')

  assert.equal(harness.appends.length, 1, 'the setting is written into the log')
  assert.equal(harness.appends[0].type, 'developer/message', 'a developer message is context, not a turn')
  assert.equal(harness.appends[0].data.message.role, 'developer')
  assert.match(harness.appends[0].data.message.content[0].text, /\[系统设定\]/u)
})

test('spawn: an existing companion is reused instead of creating a second one', async () => {
  const harness = boot()
  await spawnWith(harness, 'main-5')
  const again = await spawnWith(harness, 'main-5')

  assert.equal(again.kind, 'success')
  assert.equal(again.text, 'obs-new', 'the existing id is answered, so the client can open it')
  assert.equal(harness.creates.length, 1, 'a second click does not spawn a second session')
})

test('spawn: a companion cannot be given a companion of its own', async () => {
  const harness = boot()
  await spawnWith(harness, 'main-6')
  const chained = await spawnWith(harness, 'obs-new')

  assert.equal(chained.kind, 'error')
  assert.match(chained.text, /副脑会话/u)
  assert.equal(harness.creates.length, 1, 'no chain is created')
})

test('spawn: an empty main id is refused before anything is created', async () => {
  const harness = boot()
  const reply = await harness.commands.get('observer-spawn').handler({ rawInput: '/observer-spawn' })

  assert.equal(reply.kind, 'error')
  assert.match(reply.text, /没有可绑定的主会话 id/u)
  assert.equal(harness.creates.length, 0)
})
