/**
 * dsh-observer — the Client half is plain ESM, so these assertions are the only guard
 * `node --test` can offer. Every rule below is written from a specific failure.
 *
 * v1.0.9 ARCHITECTURE: the CLIENT NO LONGER CREATES SESSIONS AT ALL. It asks the Host over the one
 * generic client→host channel this Host offers a third-party half (a command, which is broadcast —
 * one row per summon), then opens the id it is given.
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

test('client: the cache probe is the first statement and sets a window marker', () => {
  const firstStatement = code.split('\n').find((line) => line.trim().length > 0 && !line.trim().startsWith('*'))
  assert.match(firstStatement, /window\.__OBSERVER_LOADED__/u, `the probe must run first, found: ${firstStatement}`)
  assert.match(bundle, /FUCK CACHE/u, 'the visible marker names the cache problem')
  assert.match(bundle, /__OBSERVER_LOADED__\s*=\s*'/u, 'it carries a version value, not just true')
})

test('client: registered through __ModuleLoader__.load with a factory and the PLAIN id', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u, 'the module registers itself with the loader')
  assert.match(bundle, /^\s*id:\s*'dsh-observer',$/mu, 'the module id is the plain package name')
  assert.doesNotMatch(bundle, /id:\s*'dsh-observer-v\d+/u, 'a versioned id broke Web authentication')
  assert.match(bundle, /factory\s*\(\s*require\s*,\s*styles\s*,\s*host\s*\)/u, 'the factory form is mandatory')
})

test('client: the plugin object injects every service the flow needs', () => {
  const matches = [...bundle.matchAll(/inject:\s*\[([^\]]*)\]/gu)]
  assert.ok(matches.length > 0, 'the plugin object declares inject')
  const keys = matches[matches.length - 1][1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
  for (const required of ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.commands', 'remote.session']) {
    assert.ok(keys.includes(required), `inject must include the SERVICE key '${required}'`)
  }
  assert.equal(keys.some((key) => key.startsWith('@')), false, 'package names do not grant service access')
})

/**
 * v1.0.9 — THE CLIENT NEVER CREATES A SESSION.
 *
 * Every client-side way of creating one failed to place it in a workspace on this build (`cwd` is
 * absent from the local summary), which is exactly the "选择工作区" empty draft the user kept
 * landing on. Creation belongs to the Host, which reads the MAIN session's own header.
 */
test('client: no session creation of any kind', () => {
  assert.doesNotMatch(code, /sessions\.create\(/u, 'the client does not create sessions')
  assert.doesNotMatch(code, /startSession\(/u, 'nor through the workspace blank API')
  assert.doesNotMatch(code, /locationOf|firstPathIn/u, 'and no longer guesses a path at all')
})

/**
 * v1.0.9 — ONE COMMAND, AND IT IS THE REQUEST.
 *
 * A command is the only generic channel to the Host, and it IS broadcast, so this costs one row per
 * summon. That cost is accepted deliberately: correctness of placement outranks a silent row.
 */
test('client: exactly one command is sent, and it asks the host to spawn', () => {
  const spawn = code.slice(code.indexOf('const spawnOnHost ='), code.indexOf('return { get,'))
  assert.match(spawn, /commands\.execute\(/u, 'it goes through the command channel')
  assert.equal((spawn.match(/commands\.execute\(/gu) ?? []).length, 1, 'exactly one command per click')
  assert.match(spawn, /\/observer-spawn /u, 'and it is the spawn request')
  assert.doesNotMatch(code, /observer-bind|observer-state|observer-create/u, 'the old commands are gone')
})

test('client: the new id is taken from the reply, else from one settle and one read', () => {
  const spawn = code.slice(code.indexOf('const spawnOnHost ='), code.indexOf('return { get,'))
  assert.match(spawn, /looksLikeId/u, 'the bare id in the reply is used when present')
  assert.equal((spawn.match(/setTimeout\(/gu) ?? []).length, 1, 'exactly one settle, never a loop')
  assert.doesNotMatch(spawn, /setInterval|while \(/u, 'no polling')
  assert.match(spawn, /宿主没有创建出新的会话/u, 'and a missing session is refused, not guessed')
})

/**
 * v1.0.4 — NO NESTING, FROM SESSION METADATA ONLY.
 *
 * The companion carries a `[副脑]` title, read from the client's own snapshot: no request, and
 * deliberately no page storage (a stale entry there could hide the button in an innocent session).
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
  assert.match(code, /if \(summoning\) \{/u, 'a second click while one is running is reported, not queued')
  assert.match(code, /上一次召唤还在进行中/u, 'and it says so instead of doing nothing')
  assert.match(code, /summoning = false/u, 'the latch is always released')
})

/**
 * v1.0.4 — FOCUS PULL, EVENT DRIVEN.
 *
 * A handoff announces `graft/session-transferred`; the Client opens the new main session straight
 * from the event. No poll, no state read, no lookup.
 */
test('client: the transfer event opens the new session directly', () => {
  assert.match(code, /ctx\.on\('graft\/session-transferred'/u, 'the transfer event is subscribed')
  const handler = code.slice(code.indexOf("ctx.on('graft/session-transferred'"), code.indexOf('transfer seen'))
  assert.match(handler, /payload\?\.newSessionId/u, 'the new session id comes from the event payload')
  assert.match(handler, /bridge\.openSession\(newSessionId\)/u, 'and it is opened immediately')
  assert.doesNotMatch(handler, /setInterval|await|setTimeout/u, 'the handler is synchronous')
})

/**
 * v1.0.7 — NOTHING FAILS SILENTLY.
 *
 * "Click does nothing" was indistinguishable from a dead button, because an exception left the chip
 * exactly as it was. Every step logs its result, and the whole click is wrapped so a throw becomes a
 * visible note plus a console error.
 */
test('client: every step of a click is logged and a throw becomes a visible note', () => {
  const summon = code.slice(code.indexOf('const summon ='), code.indexOf('return h('))
  assert.match(summon, /console\.log\('\[dsh-observer\] click:/u, 'the click is logged')
  assert.match(summon, /console\.log\('\[dsh-observer\] spawn result:'/u, 'the spawn result is logged')
  assert.match(summon, /console\.log\('\[dsh-observer\] opened:'/u, 'the open result is logged')
  assert.match(summon, /catch \(error\) \{/u, 'a throw is caught')
  assert.match(summon, /console\.error\('\[dsh-observer\] summon threw:'/u, 'and logged with its detail')
  assert.match(summon, /setNote\(`召唤失败：\$\{detail\}`\)/u, 'and shown on the chip')
})

test('client: a failed mount is reported, never silent', () => {
  assert.match(code, /MOUNT FAILED/u, 'a throwing apply() names itself in the console')
  assert.match(code, /registration failed:/u, 'each seat reports its own failure')
})

test('client: the jump passes the bare SessionTarget id', () => {
  assert.match(code, /openSession\(id\)/u, 'the documented SessionTarget (bare id) is passed')
  assert.doesNotMatch(code, /openSession\(\{\s*kind/u, 'a { kind, sessionId } wrapper is silently ignored')
})

test('client: a seat without a session id renders nothing', () => {
  assert.match(code, /if \(sessionId\.length === 0\) return null/u, 'no chip without a session to act on')
})
