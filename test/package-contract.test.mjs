/**
 * v0.1.10 GUARD — NO BOM, AND THE PACKAGE FILES MUST PARSE.
 *
 * This is written from the second occurrence of one mistake. Editing `package.json` with
 * PowerShell's `Set-Content -Encoding UTF8` writes a BOM (EF BB BF); the Loader reads the file
 * as UTF-8 JSON, the BOM makes `JSON.parse` fail, and the Plugins page then shows the entry as
 * 「异常 · 包不可用」 while the code itself is perfectly fine. The same thing happened once to
 * dsh-graft-slice/manifest.json.
 *
 * A BOM is invisible in every editor that tolerates it, so it has to be asserted here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const noBom = (file) => {
  const bytes = readFileSync(join(root, file))
  return !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
}

for (const file of ['package.json', 'manifest.json']) {
  test(`${file}: no UTF-8 BOM (a BOM makes the entry report 包不可用)`, () => {
    assert.equal(noBom(file), true, `${file} starts with EF BB BF — rewrite it without a BOM`)
  })

  test(`${file}: parses as JSON`, () => {
    const text = readFileSync(join(root, file), 'utf8')
    assert.doesNotThrow(() => JSON.parse(text), `${file} must be valid JSON or the plugin cannot load`)
  })
}

test('package.json and manifest.json agree on the version and the entry file', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.equal(pkg.version, manifest.version, 'the two versions drifted apart')
  assert.equal(pkg.main, 'index.js')
  assert.equal(manifest.entry, 'index.js')
  assert.equal(pkg.dsh.client.platform, 'web', 'the client half is only loaded for a declared web platform')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})
