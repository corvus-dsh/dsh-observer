/**
 * ── v243 (B3 / F7): 长期监督 + 跨代纠偏 ─────────────────────────────────────────────────────────
 *
 * 改动前的实测：`monitor.ts` 里 `longTerm` / `crossGeneration` 各 **0 次**。现有 monitor 是
 * **单会话、内存态** —— `MonitorState` 随进程消失，所以「上一代也这样」不是没实现，是**不可知**。
 *
 * 本笔只做 §5.2 的 **7a（持久台账）+ 7b（跨代纠偏）**。7c（长期监督：连续多代没推进）需要 observer
 * 读任务图 —— 那是新的跨仓耦合，派工单 §5.5 明令停下报你。**7c 没做。**
 *
 * ── 三条硬规定对应本文件的三条断言 ────────────────────────────────────────────────────────────
 *
 *   ① observer 不读 memory 的 store ⇒ 台账只存「它自己观察到的」：跟过哪些主脑、各自被纠偏过什么
 *   ② 台账有上限、淘汰确定 ⇒ ④
 *   ③ 「重复」按形态 kind 比，不按文案 ⇒ ③（不同形态不许翻旧账）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { supervisorInternals, apply } from '../index.js'
import { makeHost } from './harness.mjs'

const { createSupervisor } = supervisorInternals

const {
  LONG_TERM_CAP,
  emptyLedger,
  parseLedger,
  findRecord,
  generationFor,
  upsertRecord,
  priorGenerationNudge,
  crossGenerationLine,
} = supervisorInternals

// ── ① 持久化：进程重启后仍能读到上一代 ─────────────────────────────────────────────────────

test('v243 ①: 台账写入后重新解析仍能读到上一代（用真文件走一次往返）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v243-'))
  const path = join(dir, 'observer-main-ledger.json')

  /** Round 1: the first generation is corrected for a stall. */
  const first = upsertRecord(emptyLedger(), {
    sessionId: 'main-gen1',
    at: 1_000,
    nudgedKind: 'stall',
  })
  writeFileSync(path, `${JSON.stringify(first, null, 2)}\n`, 'utf8')

  /** Round 2: a NEW process reads the file (no shared memory) and starts the next generation. */
  const reloaded = parseLedger(JSON.parse(readFileSync(path, 'utf8')))
  assert.equal(reloaded.records.length, 1, '重启后必须仍能读到上一代的记录')
  assert.deepEqual(reloaded.records[0].nudgedKinds, ['stall'], '被纠偏过的形态必须跨重启保住')

  /** And the chain gives the new main generation 2. */
  assert.equal(generationFor(reloaded, 'main-gen1'), 2, '接在上一代后面 ⇒ 第 2 代')

  const second = upsertRecord(reloaded, {
    sessionId: 'main-gen2',
    sourceSessionId: 'main-gen1',
    generation: generationFor(reloaded, 'main-gen1'),
    at: 2_000,
    nudgedKind: 'stall',
  })
  writeFileSync(path, `${JSON.stringify(second, null, 2)}\n`, 'utf8')
  const third = parseLedger(JSON.parse(readFileSync(path, 'utf8')))
  assert.equal(third.records.length, 2)
  assert.equal(findRecord(third, 'main-gen2').generation, 2)
})

// ── ② 新一代命中同一形态 ⇒ 文案含「上一代也这样」，且只加一次 ───────────────────────────────

test('v243 ②: 新一代命中同一形态 ⇒ 有「上一代也这样」，且只加一次（不叠加）', () => {
  const ledger = upsertRecord(
    upsertRecord(emptyLedger(), { sessionId: 'gen1', at: 100, nudgedKind: 'graph' }),
    { sessionId: 'gen2', sourceSessionId: 'gen1', generation: 2, at: 200 },
  )
  const prior = priorGenerationNudge(ledger, 'gen2', 'graph')
  assert.ok(prior !== undefined, '上一代因同一形态被纠偏过 ⇒ 历史有话说')
  assert.equal(prior.generation, 1)

  const line = crossGenerationLine(prior, 'graph')
  assert.match(line, /上一代（第 1 代）也这样/u)
  assert.match(line, /多步工作却从未建立任务图/u, '必须点名是哪个形态')
  /**
   * ONCE, not stacked: the line is appended by the supervisor when it delivers, and the ledger never
   * accumulates a second copy of the same kind — `nudgedKinds` is a set. Two corrections of the same
   * shape therefore produce the same single line, not a growing chorus.
   */
  const twice = upsertRecord(ledger, { sessionId: 'gen2', at: 300, nudgedKind: 'graph' })
  assert.deepEqual(findRecord(twice, 'gen2').nudgedKinds, ['graph'], '同一形态不许记两遍')
  assert.equal(findRecord(twice, 'gen2').nudges, 1, '但次数仍要记（它不是集合，是计数）')
})

// ── ③ 不同形态 ⇒ 不提上一代 ────────────────────────────────────────────────────────────────

test('v243 ③: 不同形态 ⇒ 完全不提上一代（不许把无关的旧纠偏翻出来）', () => {
  const ledger = upsertRecord(
    upsertRecord(emptyLedger(), { sessionId: 'gen1', at: 100, nudgedKind: 'stall' }),
    { sessionId: 'gen2', sourceSessionId: 'gen1', generation: 2, at: 200 },
  )
  /** gen1 stalled; gen2 fails the same tool. Different problem — history has nothing to say. */
  assert.equal(priorGenerationNudge(ledger, 'gen2', 'failure'), undefined, '不同形态必须返回 undefined')
  assert.ok(priorGenerationNudge(ledger, 'gen2', 'stall') !== undefined, '同一形态才有话说')

  /** And no chain means no claim either: a main the observer never watched replaced nothing. */
  assert.equal(priorGenerationNudge(ledger, 'gen2', 'graph'), undefined)
  const orphan = upsertRecord(emptyLedger(), { sessionId: 'solo', at: 300, nudgedKind: 'failure' })
  assert.equal(priorGenerationNudge(orphan, 'solo', 'failure'), undefined, '没有上一代 ⇒ 不许说上一代')
})

// ── ④ 上限与确定性淘汰 ──────────────────────────────────────────────────────────────────────

test('v243 ④: 台账有上限；超出后最旧的被淘汰，且同一输入两次结果相同', () => {
  assert.ok(LONG_TERM_CAP > 0 && LONG_TERM_CAP < 1000, '上限必须是一个真实的数')
  let ledger = emptyLedger()
  for (let index = 0; index < LONG_TERM_CAP + 5; index += 1) {
    ledger = upsertRecord(ledger, { sessionId: `main-${String(index).padStart(3, '0')}`, at: index + 1 })
  }
  assert.equal(ledger.records.length, LONG_TERM_CAP, `超出上限必须被截断到 ${LONG_TERM_CAP}`)
  /** The oldest by lastServiceAt are gone; the newest survive. */
  assert.equal(findRecord(ledger, 'main-000'), undefined, '最旧的必须被淘汰')
  assert.ok(findRecord(ledger, `main-${String(LONG_TERM_CAP + 4).padStart(3, '0')}`) !== undefined)

  /**
   * DETERMINISM: same timestamps twice ⇒ same survivors. Eviction ties break on `sessionId`, so a run
   * that ties on `lastServiceAt` does not depend on insertion order.
   */
  const build = () => {
    let out = emptyLedger()
    for (let index = 0; index < LONG_TERM_CAP + 3; index += 1) {
      /** Every record shares `at` for the second half, to exercise the tie-break. */
      out = upsertRecord(out, { sessionId: `tie-${String(index).padStart(3, '0')}`, at: index < 10 ? index : 5 })
    }
    return out.records.map((record) => record.sessionId)
  }
  assert.deepEqual(build(), build(), '同一输入两次必须淘汰同一批')
})

// ── ⑤ 台账不可读 ⇒ 降级为「不知道上一代」，纠偏照常 ─────────────────────────────────────────

test('v243 ⑤: 台账不可读 ⇒ 解析为空台账（不抛），纠偏照常进行', () => {
  /** Torn JSON, a JSON scalar, a missing `records` field — every shape a damaged file can take. */
  for (const raw of ['not json at all', '42', 'null', '[]', '{"records":"nope"}', '{}']) {
    const parsed = raw === 'not json at all' ? parseLedger(undefined) : parseLedger(JSON.parse(raw))
    assert.deepEqual(parsed.records, [], `坏台账必须降级为空：${raw}`)
  }
  /** Dropping one torn ROW loses one record, not the whole notebook. */
  const partial = parseLedger({ version: 1, records: [{ sessionId: 'ok', nudgedKinds: ['stall'] }, { nope: true }, null] })
  assert.deepEqual(partial.records.map((record) => record.sessionId), ['ok'], '坏行只丢自己那一行')

  /** And a supervisor with no notebook still supervises: the pure decision never needs it. */
  assert.equal(priorGenerationNudge(emptyLedger(), 'anything', 'stall'), undefined)
})

// ── ⑥ 接线：监理（不是纯函数）真的把纠偏写进台账 ────────────────────────────────────────────

let seqCounter = 500
const nextSeq = () => (seqCounter += 1)

const toolCall = (name, callId) => ({ type: 'tool/call', seq: nextSeq(), data: { turn: 1, step: 1, callId, name } })
const failedResult = (callId) => ({
  type: 'tool/result',
  seq: nextSeq(),
  data: { turn: 1, step: 1, message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } } },
})

/** A controller that records what was steered into the main, and accepts everything. */
function recordingController() {
  const delivered = []
  return {
    delivered,
    controller: {
      prompt: async (request) => {
        delivered.push(request.content.map((part) => part.text).join(''))
        return { accepted: true }
      },
    },
  }
}

/** A real file of the shape `index.ts` writes, with the same load/save seam. */
function fileLedgerStore(dir) {
  const path = join(dir, 'observer-main-ledger.json')
  return {
    path,
    load: () => {
      try {
        return parseLedger(JSON.parse(readFileSync(path, 'utf8')))
      } catch {
        return emptyLedger()
      }
    },
    save: (next) => {
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    },
  }
}

/** Drive `FAILURE_STREAK_LIMIT` failures of one tool through the REAL supervisor. */
async function driveFailureStreak(supervisor) {
  for (let round = 0; round < 3; round += 1) {
    await supervisor.observe(toolCall('pwsh', `call-${round}`))
    await supervisor.observe(failedResult(`call-${round}`))
  }
}

const NO_TIMER = { setTimer: () => ({ unref() {} }), clearTimer: () => {} }

test('v243 ⑥: 监理真的把纠偏写进台账（纯函数测试证明不了这个）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v243-wire-'))
  const store = fileLedgerStore(dir)
  const { delivered, controller } = recordingController()

  const supervisor = createSupervisor('obs-1', 'main-gen1', { controller, ledger: store, ...NO_TIMER })
  await driveFailureStreak(supervisor)
  supervisor.dispose()

  assert.equal(delivered.length, 1, '三连失败必须恰好一条纠偏')
  /**
   * THE POINT OF THIS TEST: the pure functions above are handed a ledger BY the test. Here the
   * supervisor is handed a STORE and nothing else — so this is the only assertion that the wiring
   * (`load` → decide → `save`) exists at all. ㉛: the second door does not inherit the first door's
   * guard, and it does not inherit its writes either.
   */
  const reloaded = parseLedger(JSON.parse(readFileSync(store.path, 'utf8')))
  const record = findRecord(reloaded, 'main-gen1')
  assert.ok(record !== undefined, '监理必须为它跟过的主脑留下记录')
  assert.deepEqual(record.nudgedKinds, ['failure'], '必须记下「哪一种形态」')
  assert.equal(record.generation, 1, '第一代就是第 1 代')
})

// ── ⑦ 接线：第二代真的被告知「上一代也这样」，且只一次 ───────────────────────────────────────

test('v243 ⑦: 第二代命中同一形态 ⇒ 投递文案含「上一代也这样」，且只加一行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v243-chain-'))
  const store = fileLedgerStore(dir)

  /** Generation 1: corrected for `failure`, its record lands in the real file. */
  const first = recordingController()
  const gen1 = createSupervisor('obs-1', 'main-gen1', { controller: first.controller, ledger: store, ...NO_TIMER })
  await driveFailureStreak(gen1)
  gen1.dispose()

  /** Generation 2: a NEW supervisor, the SAME file, and a declared chain link. */
  const second = recordingController()
  const gen2 = createSupervisor('obs-1', 'main-gen2', {
    controller: second.controller,
    ledger: store,
    sourceSessionId: 'main-gen1',
    ...NO_TIMER,
  })
  await driveFailureStreak(gen2)
  gen2.dispose()

  assert.equal(second.delivered.length, 1)
  assert.match(second.delivered[0], /上一代（第 1 代）也这样/u, '第二代必须被告知这是重复形态')
  assert.equal(second.delivered[0].split('上一代（第 1 代）也这样').length - 1, 1, '只能出现一次，不许叠加')

  /** And the chain moved: gen2 is generation 2, replacing gen1. */
  const reloaded = parseLedger(JSON.parse(readFileSync(store.path, 'utf8')))
  assert.equal(findRecord(reloaded, 'main-gen2').generation, 2)
  assert.equal(findRecord(reloaded, 'main-gen2').sourceSessionId, 'main-gen1')
})

// ── ⑧ 接线：台账读不了 ⇒ 纠偏照常，且不许说「上一代」（规则 ⑤） ─────────────────────────────

test('v243 ⑧: 台账 load/save 抛错 ⇒ 纠偏照常投递，且不说「上一代」', async () => {
  const warnings = []
  const { delivered, controller } = recordingController()
  const broken = {
    load: () => {
      throw new Error('EACCES: 台账读不了')
    },
    save: () => {
      throw new Error('EACCES: 台账写不了')
    },
  }
  const supervisor = createSupervisor('obs-1', 'main-x', {
    controller,
    ledger: broken,
    logger: { warn: (message) => warnings.push(message) },
    ...NO_TIMER,
  })
  await driveFailureStreak(supervisor)
  supervisor.dispose()

  assert.equal(delivered.length, 1, '坏台账不许让监理闭嘴')
  assert.doesNotMatch(delivered[0], /上一代/u, '读不到台账就不能声称上一代也这样')
  /** The failed write is REPORTED, not swallowed: it is a fact about this pair. */
  assert.ok(
    warnings.some((line) => /长期台账写入失败/u.test(line)),
    '台账写失败必须留一条 warning',
  )
})

// ── ⑩ 链在切片那一刻落盘 ⇒ 进程重启后仍然知道上一代 ─────────────────────────────────────────

test('v243 ⑨b: 切片后进程重启（mount 恢复，没有 caller 链）⇒ 仍能说「上一代也这样」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v243-restart-'))
  const bindingsPath = join(dir, 'observer-bindings.json')

  const driving = (host) => {
    const onEvent = host.listeners.get('session/event')
    const emit = async (sessionId, type, data) => {
      onEvent({ id: sessionId }, { type, data })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return async (sessionId) => {
      for (let round = 0; round < 3; round += 1) {
        const callId = `r-${round}`
        await emit(sessionId, 'tool/call', { turn: 1, step: 1, callId, name: 'pwsh' })
        await emit(sessionId, 'tool/result', {
          turn: 1,
          step: 1,
          message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } },
        })
      }
    }
  }

  /** Process 1: gen1 is corrected, then the MAIN is sliced to gen2 — and gen2 is never nudged. */
  const first = makeHost({ memory: { hint: '' } })
  apply(first.ctx, { bindingsPath })
  const spawned = await first.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})
  const gen1 = spawned.sessionId
  await driving(first)(gen1)
  first.listeners.get('graft/session-transferred')({ sourceSessionId: gen1, newSessionId: 'session-main-gen2' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  /**
   * The chain link is now durable ON ITS OWN: at transfer time the new main was written into the
   * ledger with `sourceSessionId: gen1`. Without that write this test would fail — the restarted
   * process has no `replacedMainId` to pass (`restored at mount` genuinely does not know one).
   */
  const stored = parseLedger(JSON.parse(readFileSync(join(dir, 'observer-main-ledger.json'), 'utf8')))
  assert.equal(findRecord(stored, 'session-main-gen2')?.sourceSessionId, gen1, '链必须在切片那一刻就落盘')
  assert.equal(findRecord(stored, 'session-main-gen2')?.nudges, 0, '还没被纠偏过 —— 记的是链，不是次数')

  /** Process 2: a NEW host, the same bindings file. The pair is rehydrated by mount. */
  const second = makeHost({ memory: { hint: '' } })
  apply(second.ctx, { bindingsPath })
  await driving(second)('session-main-gen2')

  const steered = second.prompts
    .filter((entry) => entry.sessionId === 'session-main-gen2')
    .map((entry) => entry.content.map((part) => part.text).join(''))
  assert.ok(steered.length > 0, '重启后仍必须纠偏')
  assert.ok(
    steered.some((text) => /上一代（第 1 代）也这样/u.test(text)),
    `重启后历史仍必须可用；实际投递：${steered.join(' || ')}`,
  )
})

test('v243 ⑨a: 真机路径——切片后新监理拿到链，第二代被告知「上一代也这样」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v243-e2e-'))
  const bindingsPath = join(dir, 'observer-bindings.json')
  const host = makeHost({ memory: { hint: '' } })
  apply(host.ctx, { bindingsPath })

  const spawned = await host.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划', observerSessionId: 'session-blank', userConfirmed: true }, {})
  const first = spawned.sessionId

  const onEvent = host.listeners.get('session/event')
  const emit = async (sessionId, type, data) => {
    onEvent({ id: sessionId }, { type, data })
    /** `observe()` is voided by the listener (it must not block the host's feed), so yield. */
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const failThreeTimes = async (sessionId) => {
    for (let round = 0; round < 3; round += 1) {
      const callId = `e2e-${round}`
      await emit(sessionId, 'tool/call', { turn: 1, step: 1, callId, name: 'pwsh' })
      await emit(sessionId, 'tool/result', {
        turn: 1,
        step: 1,
        message: { isError: true, content: [{ type: 'text', text: 'boom' }], source: { callId } },
      })
    }
  }

  await failThreeTimes(first)
  /**
   * THE LEDGER IS WHERE THE PLUGIN SAYS IT IS: beside the bindings file the caller configured.
   * (My first version derived it from the DEFAULT path and would have written into `cwd` while the
   * bindings lived in the test's temp dir — a second store pretending to be the first one.)
   */
  const ledgerPath = join(dir, 'observer-main-ledger.json')
  const reloaded = parseLedger(JSON.parse(readFileSync(ledgerPath, 'utf8')))
  assert.deepEqual(findRecord(reloaded, first)?.nudgedKinds, ['failure'], '第一代的形态必须落进真文件')

  /** A real transfer, through the listener the Host fires — not an injected `sourceSessionId`. */
  host.listeners.get('graft/session-transferred')({ sourceSessionId: first, newSessionId: 'session-main-gen2' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  await failThreeTimes('session-main-gen2')
  const steered = host.prompts
    .filter((entry) => entry.sessionId === 'session-main-gen2')
    .map((entry) => entry.content.map((part) => part.text).join(''))
  assert.ok(steered.length > 0, '第二代必须被纠偏')
  assert.ok(
    steered.some((text) => /上一代（第 1 代）也这样/u.test(text)),
    `切片路径必须把旧主脑 id 交给新监理；实际投递：${steered.join(' || ')}`,
  )
})