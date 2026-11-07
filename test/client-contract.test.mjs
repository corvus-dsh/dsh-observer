/**
 * dsh-observer — the Client half is plain ESM, so these assertions are the only guard
 * `node --test` can offer.
 *
 * v1.1.0 (Plan B): THE CLIENT HAS NO UI AND CREATES NOTHING. The model summons the companion through
 * the `observer_create` tool, because a tool result travels back to the model while a command is
 * broadcast (D2). This file only listens for a transfer and moves the window.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Comments are stripped for the "must not appear" assertions: the header documents the bans. */
const code = bundle.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

test('client: the cache probe is the first statement and sets a window marker', () => {
  const firstStatement = code.split('\n').find((line) => line.trim().length > 0 && !line.trim().startsWith('*'))
  assert.match(firstStatement, /window\.__OBSERVER_LOADED__/u, `the probe must run first, found: ${firstStatement}`)
  assert.match(bundle, /FUCK CACHE/u, 'the visible marker names the cache problem')
  assert.match(bundle, /__OBSERVER_LOADED__\s*=\s*'/u, 'it carries a version value, not just true')
})

test('client: registered through __ModuleLoader__.load with a factory and the PACKAGE id', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u, 'the module registers itself with the loader')
  /**
   * THE ID IS THE PACKAGE NAME, NOT A SHORT ALIAS. The Host keys each web boot-graph row by
   * `package.json` `name` (`graphRow(packageName, …)`), and the browser loader looks the row up by
   * that exact id. The old `'dsh-observer'` survived the `@corvus-dsh/*` rename, so the page boot
   * reported `loaded without registering "@corvus-dsh/dsh-observer"`, re-executed the bundle as a
   * fallback, and died on `duplicate factory registration`.
   */
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const registered = /^\s*id:\s*'([^']+)',$/mu.exec(bundle)
  assert.ok(registered !== null, 'the module must register an id')
  assert.equal(registered[1], pkg.name, `the module id must be the package name (${pkg.name})`)
  assert.doesNotMatch(bundle, /id:\s*'dsh-observer-v\d+/u, 'a versioned id broke Web authentication')
  assert.match(bundle, /factory\s*\(\s*require\s*,\s*styles\s*,\s*host\s*\)/u, 'the factory form is mandatory')
})

/**
 * v1.1.0 — NO UI, NO CREATION, NO COMMANDS, NO RENAMES.
 *
 * Each of these mechanisms failed for a documented structural reason (D1/D2/D3). None of them may
 * creep back: the companion is summoned by the model through a tool, and the Host does the work.
 */
test('client: no UI seats, no session creation, no command channel, no rename', () => {
  assert.doesNotMatch(code, /slots\.register|slots\.inject/u, 'no seat is registered — there is no button')
  assert.doesNotMatch(code, /ObserverChip|makeEntry/u, 'the chip component is gone')
  assert.doesNotMatch(code, /sessions\.create\(|startSession\(/u, 'the client never creates sessions')
  assert.doesNotMatch(code, /commands\.execute/u, 'the broadcast command channel is not used')
  assert.doesNotMatch(code, /\.rename\(/u, 'it does not rename anything either')
  assert.doesNotMatch(code, /locationOf|firstPathIn/u, 'and it does not guess paths')
})

test('client: only the services it actually uses are injected', () => {
  const matches = [...bundle.matchAll(/inject:\s*\[([^\]]*)\]/gu)]
  assert.ok(matches.length > 0, 'the plugin object declares inject')
  const keys = matches[matches.length - 1][1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
  for (const required of ['slots', 'uiWorkspace', 'remote']) {
    assert.ok(keys.includes(required), `inject must include the SERVICE key '${required}'`)
  }
  // Declaring a key that is never used is exactly how `cannot get property … without inject`
  // happened; the list stays honest.
  assert.equal(keys.includes('remote.commands'), false, 'no command channel is declared')
  assert.equal(keys.includes('remote.session'), false, 'no rename namespace is declared')
})

/**
 * v1.1.0 — THE ONE THING THIS FILE STILL DOES.
 *
 * A handoff announces `graft/session-transferred`; the Client opens the new main session straight
 * from the event. No poll, no state read, no lookup.
 */
test('client: the transfer event opens the new session directly', () => {
  assert.match(code, /ctx\.on\('graft\/session-transferred'/u, 'the transfer event is subscribed')
  const handler = code.slice(code.indexOf("ctx.on('graft/session-transferred'"), code.indexOf('transfer seen'))
  assert.match(handler, /payload\?\.newSessionId/u, 'the new session id comes from the event payload')
  assert.match(handler, /openSession\(newSessionId\)/u, 'and it is opened immediately')
  assert.doesNotMatch(handler, /setInterval|await|setTimeout/u, 'the handler is synchronous')
})

test('client: the jump passes the bare SessionTarget id', () => {
  assert.match(code, /openSession\(id\)/u, 'the documented SessionTarget (bare id) is passed')
  assert.doesNotMatch(code, /openSession\(\{\s*kind/u, 'a { kind, sessionId } wrapper is silently ignored')
})

test('client: failures are logged, never swallowed', () => {
  assert.match(code, /uiWorkspace\.openSession 不可用/u, 'a missing service is named')
  assert.match(code, /openSession failed:/u, 'a throwing jump is logged')
  assert.match(code, /transfer handler failed:/u, 'and a throwing handler is logged')
})
