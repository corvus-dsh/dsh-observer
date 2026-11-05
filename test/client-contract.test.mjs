/**
 * dsh-observer — the Client half is plain ESM, so these assertions are the only guard
 * `node --test` can offer. Every rule below is written from a specific failure.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Comments are stripped for the "must not appear" assertions: this file documents the bans. */
const code = bundle.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/**
 * THE CACHE PROBE MUST BE THE FIRST STATEMENT.
 *
 * Three restarts changed nothing on screen at one point. A marker every later diagnostic depends
 * on has to be unconditional and first: if the page does not print it, the file being served is
 * not this file.
 */
test('client: the cache probe is the first statement and sets a window marker', () => {
  const firstStatement = code.split('\n').find((line) => line.trim().length > 0 && !line.trim().startsWith('*'))
  assert.match(firstStatement, /window\.__OBSERVER_LOADED__/u, `the probe must run first, found: ${firstStatement}`)
  assert.match(bundle, /FUCK CACHE/u, 'the visible marker names the cache problem')
  assert.match(bundle, /__OBSERVER_LOADED__\s*=\s*'/u, 'it carries a version value, not just true')
})

test('client: registered through __ModuleLoader__.load with a factory and the PLAIN id', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u, 'the module registers itself with the loader')
  /**
   * v0.1.14 renamed the id to `dsh-observer-v14` (and served a versioned file) to defeat a cache;
   * the next start died with `desktop welcome: Web authentication failed`.
   */
  assert.match(bundle, /^\s*id:\s*'dsh-observer',$/mu, 'the module id is the plain package name')
  assert.doesNotMatch(bundle, /id:\s*'dsh-observer-v\d+/u, 'a versioned id broke Web authentication')
  assert.match(bundle, /factory\s*\(\s*require\s*,\s*styles\s*,\s*host\s*\)/u, 'the factory form is mandatory')
})

/**
 * v1.0.1 — THE SERVICE SET FOLLOWS THE NEW PLAN.
 *
 * `sessions` creates (and returns an id), `uiWorkspace` opens, `remote.commands` fires the
 * fire-and-forget bind line. There is NO `tools` service on the Client half of this host.
 */
test('client: the plugin object injects exactly the services the minimal flow needs', () => {
  const matches = [...bundle.matchAll(/inject:\s*\[([^\]]*)\]/gu)]
  assert.ok(matches.length > 0, 'the plugin object declares inject')
  const keys = matches[matches.length - 1][1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
  for (const required of ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.commands']) {
    assert.ok(keys.includes(required), `inject must include the SERVICE key '${required}'`)
  }
  assert.equal(keys.some((key) => key.startsWith('@')), false, 'package names do not grant service access')
})

/**
 * v1.0.1 — NO STATE READ, NO POLL, NO CREATE COMMAND.
 *
 * The three seats re-render constantly and every command call prints a row into the conversation;
 * that is the transcript flood. Only the single bind line is fired, and only on a click.
 */
test('client: no state read, no polling, no create command, no session enumeration', () => {
  assert.doesNotMatch(code, /observer-state/u, 'the state command is gone entirely')
  assert.doesNotMatch(code, /observer-create/u, 'the create command is gone (it lost the session id)')
  assert.doesNotMatch(code, /setInterval|setTimeout/u, 'no timers')
  assert.doesNotMatch(code, /session\.list\(|sessions\.list/u, 'no session enumeration')
  assert.doesNotMatch(code, /readSessions/u, 'the read-once guard is gone with the read it guarded')
  assert.doesNotMatch(code, /tools\.execute/u, 'there is no client tools service on this host')
})

/**
 * v1.0.1 — THE CLICK PATH.
 *
 * `sessions.create` is the only client API that RETURNS an id (`uiWorkspace.startSession` returns
 * void), the jump passes the BARE id (`SessionTarget = SessionId | SubagentAddress`), and the
 * pointer is written by ONE fire-and-forget command line whose reply is never read.
 */
test('client: one click creates with sessions.create, opens the bare id, then binds', () => {
  assert.match(code, /sessions\.create\(/u, 'creation goes through sessions.create (it returns SessionId)')
  assert.doesNotMatch(code, /startSession\(/u, 'startSession returns void — it cannot supply the id to bind')
  assert.match(code, /openSession\(observerSessionId\)/u, 'the jump passes the bare SessionTarget id')
  assert.doesNotMatch(code, /openSession\(\{\s*kind/u, 'a { kind, sessionId } wrapper is silently ignored')
  assert.match(code, /observer-bind/u, 'the pointer is written by the observer-bind line')

  const summon = code.slice(code.indexOf('const summon ='), code.indexOf('return h('))
  const order = ['createSession()', 'openSession(', 'bridge.bind('].map((step) => summon.indexOf(step))
  assert.ok(order.every((at) => at >= 0), 'the flow is create → open → bind')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the three steps must run in that order')
})

test('client: the bind line is fired once and its reply is never read', () => {
  const bind = code.slice(code.indexOf('const bind ='), code.indexOf('return { get,'))
  assert.equal(
    (bind.match(/commands\.execute\(/gu) ?? []).length,
    1,
    'exactly one bind line per click',
  )
  assert.doesNotMatch(bind, /JSON\.parse|\.text\b/u, 'the wrapped reply is not parsed — that layer lost the id')
})

test('client: a failed bind is reported, never swallowed', () => {
  assert.match(code, /指针未写入/u, 'a bind failure is stated in the chip')
  assert.match(code, /console\.error\('\[dsh-observer\] bind failed:'/u, 'and logged with its reason')
})

test('client: a seat without a session id renders nothing', () => {
  assert.match(code, /if \(sessionId\.length === 0\) return null/u, 'no chip without a session to act on')
})
