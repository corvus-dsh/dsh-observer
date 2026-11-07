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
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/**
 * v0.1.14 shipped a VERSIONED id (`dsh-observer-v14`) and the next start died with
 * `Web authentication failed`. The rule is not "some plain-looking id" — it is THE PACKAGE NAME:
 * the Host composes the web boot graph with `graphRow(packageName, …)` and the browser loader
 * looks the row up by that id. After the `@corvus-dsh/*` rename, the short id `dsh-observer`
 * produced `loaded without registering "@corvus-dsh/dsh-observer"` and a fallback re-execution
 * that crashed the page on `duplicate factory registration`.
 */
const registered = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(
  client.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, ''),
)
if (registered === null) throw new Error('client.js must register via __ModuleLoader__.load({ id, factory })')
if (registered[1] !== pkg.name) {
  throw new Error(
    `client.js must register the package name "${pkg.name}" (got "${registered[1]}") — the Host keys boot rows by package name`,
  )
}
process.stdout.write(`client.js ${Buffer.byteLength(client)} bytes (id ${registered[1]})\n`)
