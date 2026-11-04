/**
 * v0.1.4 GUARD — an entry that omits a tool's `output` contract kills the whole Web boot.
 *
 * Measured on 0.2.2-rc.1:
 *   TypeError: tool "…" must declare output { schema, render, presentationMeta? }
 *   → "1 个条目未激活" → the application does not start at all.
 *
 * The tool's own behaviour is irrelevant here: it is the REGISTRATION that is invalid, and
 * no behavioural test can see that. So this scans the source and the built bundle.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function toolRegistrations(source) {
  const blocks = []
  const marker = 'ctx.tools?.register('
  const fallback = 'ctx.tools.register('
  let from = 0
  for (;;) {
    let at = source.indexOf(marker, from)
    let used = marker
    if (at < 0) {
      at = source.indexOf(fallback, from)
      used = fallback
    }
    if (at < 0) break
    const open = source.indexOf('{', at)
    if (open < 0) break
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end < 0) break
    blocks.push(source.slice(at, end))
    from = end + used.length
  }
  return blocks
}

const nameOf = (block) => /name:\s*'([^']+)'/u.exec(block)?.[1] ?? '(unnamed)'

for (const file of ['src/index.ts', 'index.js']) {
  test(`output contract: every tool in ${file} declares output { schema, render }`, () => {
    const source = readFileSync(join(root, file), 'utf8')
    const blocks = toolRegistrations(source)
    assert.ok(blocks.length > 0, `${file}: no tool registrations found — the scan would be vacuous`)

    const offenders = []
    for (const block of blocks) {
      const outputAt = block.search(/\boutput:\s*\{/u)
      if (outputAt < 0) {
        offenders.push(`${nameOf(block)} (no output)`)
        continue
      }
      const outputPart = block.slice(outputAt)
      if (!/\bschema:\s*\{/u.test(outputPart)) offenders.push(`${nameOf(block)} (output without schema)`)
      if (!/\brender:\s*/u.test(outputPart)) offenders.push(`${nameOf(block)} (output without render)`)
    }
    assert.deepEqual(offenders, [], `${file}: registrations that would abort activation: ${offenders.join(', ')}`)
  })
}

test('output contract: the built bundle exposes the same tool set as src/index.ts', () => {
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const built = readFileSync(join(root, 'index.js'), 'utf8')
  assert.deepEqual(
    toolRegistrations(built).map(nameOf).sort(),
    toolRegistrations(source).map(nameOf).sort(),
    'run scripts/build.mjs — the shipped tool set differs from src',
  )
})
