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
 * v1.0.6 — NO STATE READ, NO POLL, NO COMMAND CHANNEL, NO ENUMERATION.
 *
 * `sessions.list.getSnapshot()` IS allowed: a synchronous read of the LOCAL store. An actual list
 * CALL is not. `remote.session.rename` IS allowed — a plain Remote call, not a command, so it
 * prints no transcript row (that is the whole point of v1.0.6).
 */
test('client: no state read, no polling, no command channel, no enumeration', () => {
  assert.doesNotMatch(code, /observer-state|observer-create/u, 'the polling commands are gone entirely')
  assert.doesNotMatch(code, /setInterval|setTimeout/u, 'no timers')
  assert.doesNotMatch(code, /sessions\.list\(/u, 'no list RPC — only the local snapshot')
  assert.doesNotMatch(code, /readSessions/u, 'the read-once guard is gone with the read it guarded')
  assert.doesNotMatch(code, /tools\.execute/u, 'there is no client tools service on this host')
  /**
   * THE BROADCAST CHANNEL IS GONE. `commands.execute` renders a row in the conversation whatever
   * the handler returns, so it cannot be used for silent bookkeeping.
   */
  assert.doesNotMatch(code, /commands\.execute|observer-bind/u, 'nothing is sent over the command channel')
})

/**
 * v1.0.6 — THE CLICK PATH, INCLUDING WORKSPACE INHERITANCE.
 *
 * `locationOf` finds the main session's PATH or WORKSPACE from the local snapshot so the companion
 * lands in the same project instead of a "选择工作区" empty page — and a session with no location is
 * refused rather than created and abandoned. The jump passes the BARE id
 * (`SessionTarget = SessionId | SubagentAddress`). The binding is not requested: the companion is
 * MARKED with a title, and the Host derives the pointer from its own event feed.
 */
test('client: one click inherits the location, creates, marks, then opens', () => {
  assert.match(code, /sessions\.create\(/u, 'creation goes through sessions.create (it returns SessionId)')
  assert.doesNotMatch(code, /startSession\(/u, 'startSession returns void — it cannot supply the id')
  assert.match(code, /openSession\(observerSessionId\)/u, 'the jump passes the bare SessionTarget id')
  assert.doesNotMatch(code, /openSession\(\{\s*kind/u, 'a { kind, sessionId } wrapper is silently ignored')
  assert.match(code, /markCompanion/u, 'the companion is marked, not bound through a command')
  assert.match(code, /remote\.session\.rename|namespace\.rename/u, 'the mark is a plain Remote rename')
  assert.match(code, /\[副脑\] 跟随/u, 'and the title is the marker the Host parses')
  assert.match(code, /拿不到主会话的工作区或路径/u, 'a locationless create is refused, not attempted')

  const summon = code.slice(code.indexOf('const summon ='), code.indexOf('return h('))
  // `locationOf` is the ARGUMENT of `createSession`, so textually it comes second; what matters is
  // that the location is computed for that call, and that mark precedes open.
  assert.match(summon, /createSession\(bridge\.locationOf\(sessionId\)\)/u, 'the location feeds the create call')
  const order = ['createSession(', 'markCompanion(', 'openSession('].map((step) => summon.indexOf(step))
  assert.ok(order.every((at) => at >= 0), 'the flow is create → mark → open')
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

/**
 * v1.0.6 — THE MARKING CALL IS A PLAIN REMOTE, AND ITS FAILURE IS VISIBLE.
 *
 * `remote.session.rename` is used instead of a command precisely because a command is broadcast
 * into the conversation. If the rename fails the chip says the companion was created but NOT
 * marked, because an unmarked companion would keep showing the summon button inside itself.
 */
test('client: the marking call is a plain rename and its failure is reported', () => {
  const mark = code.slice(code.indexOf('const markCompanion ='), code.indexOf('return { get,'))
  assert.match(mark, /namespace\.rename\(/u, 'it renames through the Remote namespace')
  assert.doesNotMatch(mark, /commands\.execute/u, 'never through the broadcast command channel')
  assert.equal((mark.match(/rename\(/gu) ?? []).length, 1, 'exactly one rename per click')
  assert.match(mark, /副脑未被标记/u, 'a failure names what did not happen')

  assert.match(code, /但未被标记/u, 'and the chip states it instead of pretending success')
  assert.match(code, /console\.error\('\[dsh-observer\] mark failed:'/u, 'the detail is logged')
})

test('client: a seat without a session id renders nothing', () => {
  assert.match(code, /if \(sessionId\.length === 0\) return null/u, 'no chip without a session to act on')
})
