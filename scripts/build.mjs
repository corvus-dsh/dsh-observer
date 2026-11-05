#!/usr/bin/env node
/**
 * Build index.js from src/**.ts with Node's built-in type stripper.
 *
 * v1.3.0: the composition moved to `scripts/bundle.mjs` — the same composer shape
 * `dsh-graft-slice` uses. The previous version inlined ONE file and refused any relative
 * import, which is why the injection path had no home of its own and ended up crammed into
 * `src/index.ts`. The contract is now: add a module under `src/core/`, import it from
 * `src/index.ts`, and the bundle picks it up in dependency order with no further work.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { composeBundle } from './bundle.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { output, modules } = composeBundle(root)
writeFileSync(join(root, 'index.js'), output, 'utf8')
process.stdout.write(
  `built index.js (${Buffer.byteLength(output)} bytes, ${modules.length} inlined module(s): ${modules.join(', ')})\n`,
)

/**
 * The Client half is plain ESM and is served as `client.js` — no copy, no versioned file.
 * v0.1.14 shipped `client-v14.js` plus a versioned module id and the next start died with
 * `Web authentication failed`; the client entry and its specifier stay exactly where the
 * sibling plugins keep them.
 */
const client = readFileSync(join(root, 'client.js'), 'utf8')
if (/id:\s*'dsh-observer-v/u.test(client)) {
  throw new Error('client.js must register with the plain id `dsh-observer` — a versioned id broke Web auth')
}
process.stdout.write(`client.js ${Buffer.byteLength(client)} bytes (plain id, no polling)\n`)
