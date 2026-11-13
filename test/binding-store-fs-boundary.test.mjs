/**
 * THE IO BOUNDARY IS A REAL SEAM — proven by the absence of disk writes, not by reading the code.
 *
 * ── WHY THIS FILE EXISTS (阶段 6 · #2 依赖倒置, 2026-11-13) ───────────────────────────────────────
 *
 * The binding table moved into `core/binding-store.ts` and takes its IO as a parameter
 * (`BindingFsLike`). That parameter is the whole point of the inversion: before it, `load()` and
 * `writeAtomic()` called `node:fs` directly from `index.ts`, so every test that exercised the
 * binding table touched a real file — or had to fish `createBindingStore` out of a bundle seam.
 *
 * A parameter is only a boundary if SOMETHING FAILS when it is bypassed. Two ways to test that,
 * and only one of them is worth anything:
 *
 *   · "the fake received the calls" — true, but also true if the module called `node:fs` FIRST and
 *     then called the fake as well. A half-passing assertion.
 *   · "the real directory is still empty after a full save()" — this fails the moment one line
 *     reaches around the parameter to `node:fs`.
 *
 * So this file asserts BOTH, in that order of importance: zero files on the real disk, then the
 * call sequence on the fake. The first one is the guarantee; the second one explains what happened.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not test the production path (no `fs` argument ⇒ `node:fs`) by writing to disk. That path
 * is exercised end-to-end by every test that calls `apply()`, and asserting it here would mean
 * creating the very files this test exists to prove are avoidable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'

import { createBindingStore } from '../src/core/binding-store.ts'

/** A temp directory that a REAL write would land in — so "nothing here" is a meaningful claim. */
const scratch = mkdtempSync(join(tmpdir(), 'binding-fs-boundary-'))
const bindingsPath = join(scratch, 'observer-bindings.json')

before(() => {
  assert.deepEqual(readdirSync(scratch), [], 'the temp directory must start empty')
})

after(() => {
  // Clean up only what this test could have created. `rmSync` is scoped to the mkdtemp path.
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * A recording fake. Structurally it is `BindingFsLike`; nothing else is reachable through it —
 * which is the second half of the boundary (see the note on `BindingFsLike` in the module).
 */
function makeFakeFs(seed = {}) {
  const files = new Map(Object.entries(seed))
  const dirs = new Set()
  const calls = []
  return {
    calls,
    files,
    io: {
      readFileSync(path, encoding) {
        calls.push(['readFileSync', path, encoding])
        if (!files.has(path)) {
          const error = new Error(`ENOENT: ${path}`)
          error.code = 'ENOENT'
          throw error
        }
        return files.get(path)
      },
      writeFileSync(path, data, encoding) {
        calls.push(['writeFileSync', path, encoding])
        files.set(path, String(data))
      },
      renameSync(from, to) {
        calls.push(['renameSync', from, to])
        if (!files.has(from)) throw new Error(`ENOENT: ${from}`)
        files.set(to, files.get(from))
        files.delete(from)
      },
      mkdirSync(path, options) {
        calls.push(['mkdirSync', path, options])
        dirs.add(path)
      },
      existsSync(path) {
        calls.push(['existsSync', path])
        return files.has(path) || dirs.has(path)
      },
    },
  }
}

test('a full save() through the fake leaves the REAL temp directory completely empty', () => {
  const fake = makeFakeFs()
  const store = createBindingStore({ bindingsPath, fs: fake.io })

  store.load()
  const recorded = store.recordPair('session-obs', 'session-main', 'incubated')
  assert.equal(recorded.ok, true, 'recordPair must report success so save() is actually exercised')

  // THE ASSERTION THIS FILE EXISTS FOR. If any code path reached `node:fs` instead of the parameter,
  // one of these would be non-empty — a torn temp file counts, which is why we compare the listing
  // rather than just the target file.
  assert.deepEqual(readdirSync(scratch), [], 'no file may appear on the real disk')
  assert.equal(existsSync(bindingsPath), false, 'the real bindings file must not exist')
  assert.equal(existsSync(`${bindingsPath}.tmp-0`), false, 'and no temp remnant either')
})

test('the fake received the exact call sequence, including mkdir before the atomic write', () => {
  const fake = makeFakeFs()
  const store = createBindingStore({ bindingsPath, fs: fake.io })

  store.load()
  store.recordPair('session-obs', 'session-main', 'incubated')

  const sequence = fake.calls.map((call) => call[0])

  /**
   * `load()` starts with a read that throws ENOENT (first run). Then `recordPair` saves:
   * mkdir → write temp → rename temp → target.
   *
   * `mkdirSync` is asserted explicitly because it was the IO point MISSED when the boundary was
   * first sketched: `writeAtomic` was parameterised but the `mkdir` in front of it was not, and a
   * real-fs `mkdirSync` inside `save()` would recreate the directory this test just proved empty.
   */
  assert.deepEqual(sequence, ['readFileSync', 'mkdirSync', 'writeFileSync', 'renameSync'])

  const mkdir = fake.calls.find((call) => call[0] === 'mkdirSync')
  assert.deepEqual(mkdir[2], { recursive: true }, 'mkdir must keep its recursive option')

  // The write goes to a TEMP path and is renamed into place: a reader never sees half a document.
  const write = fake.calls.find((call) => call[0] === 'writeFileSync')
  const rename = fake.calls.find((call) => call[0] === 'renameSync')
  assert.notEqual(write[1], bindingsPath, 'the write must target a temp path, not the final one')
  assert.match(write[1], /\.json\.tmp-/u, 'temp path keeps the writeAtomic naming')
  assert.equal(rename[1], write[1], 'rename must move the temp file it just wrote')
  assert.equal(rename[2], bindingsPath, 'and land on the real target path')

  // What landed there is the serialized state, with the atomic-write formatting intact.
  const persisted = JSON.parse(fake.files.get(bindingsPath))
  assert.deepEqual(Object.keys(persisted).sort(), ['bindings', 'focus', 'pairOf', 'pairs', 'reverse'])
  assert.equal(persisted.bindings['session-main'], 'session-obs')
  assert.equal(persisted.reverse['session-obs'], 'session-main')
})

test('the fake is the ONLY reachable IO: an fs that refuses everything breaks save() loudly', () => {
  const refusing = {
    readFileSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    writeFileSync() { throw new Error('write refused by the test boundary') },
    renameSync() { throw new Error('rename refused by the test boundary') },
    mkdirSync() { throw new Error('mkdir refused by the test boundary') },
    existsSync() { return false },
  }
  const store = createBindingStore({ bindingsPath, fs: refusing })

  store.load() // ENOENT is expected on first run and must be swallowed
  const result = store.recordPair('session-obs', 'session-main', 'incubated')

  /**
   * `save()` reports the failure rather than throwing, and `recordPair` rolls the in-memory table
   * back to EXACTLY what it was. Asserting the rollback here is the reason this third case exists:
   * a boundary that is bypassed on the error path is not a boundary.
   */
  assert.equal(result.ok, false)
  assert.match(String(result.error), /refused by the test boundary/u)
  assert.deepEqual(store.snapshot().pairs, {}, 'a failed write must not leave a half-recorded pair')
  assert.equal(store.pairOf('session-main'), undefined)

  assert.deepEqual(readdirSync(scratch), [], 'the refusal path must not touch the real disk either')
})
