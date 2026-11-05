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
 * v1.0.2 — NO STATE READ, NO POLL, NO CREATE COMMAND, NO RPC ENUMERATION.
 *
 * `sessions.list.getSnapshot()` IS allowed: a synchronous read of the LOCAL store that yields the
 * main session's `cwd`, so it performs no request and prints no transcript row. An actual list
 * CALL, or the `remote.session` namespace, is not.
 */
test('client: no state read, no polling, no create command, no RPC enumeration', () => {
  assert.doesNotMatch(code, /observer-state/u, 'the state command is gone entirely')
  assert.doesNotMatch(code, /observer-create/u, 'the create command is gone (it lost the session id)')
  assert.doesNotMatch(code, /setInterval|setTimeout/u, 'no timers')
  assert.doesNotMatch(code, /sessions\.list\(|remote\.session/u, 'no list RPC — only the local snapshot')
  assert.doesNotMatch(code, /readSessions/u, 'the read-once guard is gone with the read it guarded')
  assert.doesNotMatch(code, /tools\.execute/u, 'there is no client tools service on this host')
})

/**
 * v1.0.2 — THE CLICK PATH, INCLUDING WORKSPACE INHERITANCE.
 *
 * `cwdOf` reads the main session's working directory from the local snapshot so the companion
 * lands in the SAME project instead of 未分组; `sessions.create` then receives it. The jump passes
 * the BARE id (`SessionTarget = SessionId | SubagentAddress`), and the pointer is written by ONE
 * fire-and-forget command line whose reply is never read.
 */
test('client: one click inherits cwd, creates, opens the bare id, then binds', () => {
  assert.match(code, /sessions\.create\(/u, 'creation goes through sessions.create (it returns SessionId)')
  assert.doesNotMatch(code, /startSession\(/u, 'startSession returns void — it cannot supply the id to bind')
  assert.match(code, /openSession\(observerSessionId\)/u, 'the jump passes the bare SessionTarget id')
  assert.doesNotMatch(code, /openSession\(\{\s*kind/u, 'a { kind, sessionId } wrapper is silently ignored')
  assert.match(code, /observer-bind/u, 'the pointer is written by the observer-bind line')

  const summon = code.slice(code.indexOf('const summon ='), code.indexOf('return h('))
  const order = ['cwdOf(', 'createSession(', 'openSession(', 'bridge.bind('].map((step) => summon.indexOf(step))
  assert.ok(order.every((at) => at >= 0), 'the flow is cwd → create → open → bind')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the steps must run in that order')
})

/**
 * v1.0.4 — NO NESTING (from session metadata) AND NO RE-ENTRY (from a module latch).
 *
 * The chip hides itself inside a companion using TWO local sources: the `[副脑]` title the Host
 * writes into the session, read from the client's own snapshot, and the ids this page created
 * (covering the moment between the jump and the rename). localStorage is deliberately NOT used —
 * a stale entry there could hide the button in a session that is not a companion at all.
 */
test('client: a companion is recognised from its own title, with no request and no storage', () => {
  assert.match(code, /const isCompanion = \(sessionId\)/u, 'one place answers "is this a companion?"')
  assert.match(code, /containsMarker\(summary\)/u, 'the session metadata is scanned for the marker')
  assert.match(code, /'\[副脑\]'/u, 'the marker is the title the Host writes')
  assert.match(code, /const companions = new Set\(\)/u, 'a page-local set covers the rename window')
  assert.match(code, /if \(bridge\.isCompanion\(sessionId\)\) return null/u, 'a companion renders no chip')
  assert.doesNotMatch(code, /localStorage/u, 'page storage was removed: it can go stale and lie')
})

test('client: the summon is exclusive across all three seats', () => {
  assert.match(code, /^\s*let summoning = false$/mu, 'the latch is module-scoped, not per component')
  assert.match(code, /if \(summoning\) return/u, 'a second click while one is running is ignored')
  assert.match(code, /summoning = false/u, 'and it is always released')
})

/**
 * v1.0.4 — FOCUS PULL, EVENT DRIVEN.
 *
 * A handoff announces `graft/session-transferred`; the Client opens the new main session straight
 * from the event. No poll, no state read, no lookup.
 */
test('client: the transfer event opens the new session directly', () => {
  assert.match(code, /ctx\.on\('graft\/session-transferred'/u, 'the transfer event is subscribed')
  const handler = code.slice(code.indexOf("ctx.on('graft/session-transferred'"), code.indexOf('console.log(`[dsh-observer] transfer seen'))
  assert.match(handler, /payload\?\.newSessionId/u, 'the new session id comes from the event payload')
  assert.match(handler, /bridge\.openSession\(newSessionId\)/u, 'and it is opened immediately')
  assert.doesNotMatch(handler, /setInterval|await|setTimeout/u, 'the handler is synchronous — nothing to poll')
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
