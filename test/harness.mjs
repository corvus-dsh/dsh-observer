/**
 * Shared harness for the observer tests.
 *
 * v1.3.0 — WHY THIS FILE GREW A WHOLE FAKE HOST.
 *
 * The incubation no longer creates a LIVE session (`sessionController.create`) and appends to
 * it. That path could never work: `developer/message` is step-scoped, DSH checks
 * `data.turn`/`data.step` against the OPEN pair, and a freshly created session has no open turn
 * at all — so every write was refused and the catch degraded it to a message.
 *
 * The real path is the one dsh-graft-slice uses: `sessions.prepare()` → build the whole tape in
 * memory → `sessionPersistence.create(header, { inheritedEventCount: 0 })` → `handle.append()`
 * → `handle.flush()`. A test that mocks `sessionController.create` therefore asserts against a
 * mechanism the plugin no longer uses, and — worse — it cannot see the failures that matter.
 *
 * `FakeHost` below models the 0.2.2 contract faithfully enough to catch them:
 *
 *   - `sessions.prepare(id, { meta })` returns a DETACHED session whose `append()` THROWS
 *     `cannot append outside a SessionStore` — the exact error that broke v1.2.2;
 *   - `sessionPersistence.create()` refuses a duplicate id and records every append;
 *   - `sessionQuery.readSession()` reads back what was persisted, so a cold-read verify runs;
 *   - `workspaceRegistry` records the attach, `emit` records the client announcement.
 */

/* ── the durable side ──────────────────────────────────────────────────────── */

export class FakePersistence {
  constructor() {
    this.byId = new Map()
    this.createCalls = []
    this.appendCalls = []
    this.flushCalls = 0
    this.closeCalls = 0
    this.discarded = []
    /** Every mutation, in order, so a test can assert create → append → flush → close. */
    this.order = []
  }

  async create(header, options) {
    if (this.byId.has(header.id)) throw new Error(`session "${header.id}" already exists`)
    const record = { header: clone(header), inheritedEventCount: options?.inheritedEventCount ?? 0, events: [], closed: false }
    this.byId.set(header.id, record)
    this.createCalls.push({ header: clone(header), options: clone(options ?? {}) })
    this.order.push('create')
    return this.handleFor(header.id, record)
  }

  async open(id) {
    const record = this.byId.get(id)
    if (record === undefined) throw new Error(`session "${id}" not found`)
    // `open` is the documented way to take write ownership of a DURABLE artifact: it returns a
    // FRESH handle, so a record closed by an earlier create/flush/close cycle is writable again.
    // (A fake that left `closed` set made every rollback mark throw `handle closed`, which is a
    // property of the fake, not of the host.)
    record.closed = false
    return this.handleFor(id, record)
  }

  async stat(id) {
    const record = this.byId.get(id)
    return record === undefined ? undefined : { header: clone(record.header), sizeBytes: 0 }
  }

  async discardPrepared(id) {
    const record = this.byId.get(id)
    if (record === undefined) return
    /**
     * THE ROLLBACK HOOK MUST ACTUALLY REMOVE THE RECORD.
     *
     * An earlier version only removed a record with ZERO events ("a prepared artifact that was never
     * flushed is simply forgotten"). That modelled a host which refuses to discard anything it has
     * already written to — and it made every mid-write rollback look like a no-op, which is precisely
     * the failure a test of the rollback path needs to see. The real contract is "this artifact is
     * abandoned; drop it", regardless of how far the write got.
     */
    this.byId.delete(id)
    this.discarded.push(id)
  }

  /**
   * THE HOST'S OTHER REMOVAL FACES, modelled so a rollback can actually complete.
   *
   * `discardPrepared` is the "I abandoned this" hook; `remove`/`delete` are the blunt ones. The
   * adapter tries them in order and verifies with `stat` afterwards, so a fake that offers none of
   * them cannot distinguish "the host deleted it" from "the host refused" — and the test would be
   * asserting against the fake's limitations instead of the adapter's behaviour.
   */
  async remove(id) {
    this.byId.delete(id)
    this.discarded.push(id)
  }

  async delete(id) {
    this.byId.delete(id)
    this.discarded.push(id)
  }

  handleFor(id, record) {
    const persistence = this
    return {
      async append(events) {
        persistence.order.push('append')
        if (record.closed) throw new Error('handle closed')
        if (!Array.isArray(events) || events.length === 0) throw new Error('append needs at least one event')
        persistence.appendCalls.push({ id, count: events.length, types: events.map((event) => event.type) })
        record.events.push(...events.map(clone))
      },
      async flush() {
        persistence.order.push('flush')
        persistence.flushCalls += 1
      },
      async close() {
        persistence.order.push('close')
        persistence.closeCalls += 1
        record.closed = true
      },
    }
  }

  read(id) {
    const record = this.byId.get(id)
    if (record === undefined) return undefined
    return {
      session: clone(record.header),
      inheritedEventCount: record.inheritedEventCount,
      events: record.events.map(clone),
    }
  }
}

/* ── the session store: prepare is read-only until a store publishes it ─────── */

export class FakeSessions {
  constructor(persistence) {
    this.persistence = persistence
    this.live = new Map()
    this.prepared = new Map()
    this.prepareCalls = []
  }

  get(id) {
    return this.live.get(id)
  }

  /** A DETACHED, read-only session — the 0.2.2 shape, refusal included. */
  prepare(id, options = {}) {
    if (this.live.has(id)) throw new Error(`session "${id}" already exists`)
    this.prepareCalls.push({ id, options: clone(options) })
    const header = {
      type: 'session',
      version: 4,
      id,
      createdAt: Date.now(),
      isSeeded: false,
      delegationDepth: 0,
      ...(options?.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
      ...(options?.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
    }
    const session = {
      id,
      header,
      append() {
        throw new Error('cannot append outside a SessionStore')
      },
    }
    this.prepared.set(id, session)
    return session
  }

  /** Test seam: make an id live, as `sessionController.create` would. */
  publish(session) {
    this.live.set(session.id, session)
  }
}

/* ── the whole host ────────────────────────────────────────────────────────── */

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function makeHost({
  cwd = 'D:/work/project',
  headerCwd,
  liveHeader = true,
  persistence = new FakePersistence(),
  sourceEvents = [],
  sourceHeader,
  memory,
  createThrows = false,
  emitThrows = false,
  /**
   * v1.6.0: does the CALLING session's log contain an `ask_user_question` call?
   *
   * The incubation now refuses to run without one, so every happy-path test needs this evidence.
   * Default `true` — a test that wants the refusal sets it to `false` explicitly, which is the
   * direction that keeps failures meaningful: absent evidence must be a deliberate choice in a
   * test, never an accident of the fixture.
   */
  askedUser = true,
  /**
   * v1.7.0: the `memory_harvest` answer the supervisor's background extraction receives.
   *
   * Default `undefined` means "the profile has dsh-memory, and nothing is retired": the harvest
   * runs and reports zero mined sessions, which is the REAL answer for a live main. A test that
   * wants "our main was mined" passes `{ harvested: [{ sessionId: '…' }] }`.
   */
  harvest = undefined,
} = {}) {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const appends = []
  const renames = []
  const prompts = []
  const creates = []
  const memoryCalls = []
  const attached = []
  const emitted = []
  const sessions = new FakeSessions(persistence)
  let created = 0

  const sourceId = 'session-blank'
  /**
   * v1.7.0 — THE FIXTURE LIVE SESSION NOW ACCEPTS A LEGAL SKELETON.
   *
   * It already accepted `developer/message` and `session/title` and threw for everything else, which
   * modelled "a surface write is the host's job". But `injectSetting` writes a CLOSED skeleton
   * (turn/start → step/start → developer/message → step/end → turn/end) whenever the session has no
   * open turn — and an IDLE live session really does accept that: it is the same legal write the
   * companion path has always used. Throwing on `turn/start` therefore did not model the host, it
   * modelled a session that can never be written to, and the supervisor's duty text silently fell
   * through to a persistence handle that does not exist for a live id.
   *
   * The fixture still records every append, so a test can assert WHAT was written and in which order.
   */
  const liveSource =
    liveHeader && cwd.length > 0
      ? {
          id: sourceId,
          header: { cwd: headerCwd ?? cwd },
          append: (type, data, options) => {
            appends.push({ id: sourceId, type, data, options })
          },
        }
      : undefined
  if (liveSource !== undefined) sessions.live.set(sourceId, liveSource)
  sessions.live.set('session-blank-2', { id: 'session-blank-2', header: { cwd: cwd.length > 0 ? cwd : undefined } })

  const ctx = {
    get(name) {
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      if (name === 'sessions') return sessions
      if (name === 'tools') {
        return {
          register: (definition) => tools.set(definition.name, definition),
          execute: async (request) => {
            memoryCalls.push(request)
            /**
             * v1.7.0: `memory_harvest` is a DIFFERENT tool from `memory_search`, and the
             * supervisor's background extraction calls it. The two answers are kept apart so a
             * test can say "the search found nothing but the harvest mined this session" without
             * one fixture standing in for both.
             */
            if (request?.name === 'memory_harvest') {
              if (harvest === 'throw') throw new Error('UNKNOWN_TOOL: memory_harvest')
              if (harvest?.error !== undefined) {
                return { isError: true, error: { message: harvest.error }, content: [] }
              }
              return {
                isError: false,
                value: {
                  ok: true,
                  scanned: Array.isArray(harvest?.harvested) ? harvest.harvested.length : 0,
                  harvested: harvest?.harvested ?? [],
                  skipped: [],
                  warnings: [],
                  suggestionsQueued: 0,
                },
                content: [],
              }
            }
            if (memory === undefined || memory === 'throw') throw new Error('UNKNOWN_TOOL: memory_search')
            if (memory.error !== undefined) return { isError: true, error: { message: memory.error }, content: [] }
            return { isError: false, value: { hint: memory.hint }, content: [] }
          },
        }
      }
      if (name === 'sessionController') {
        return {
          async create(request) {
            if (createThrows) throw new Error('create refused')
            creates.push(request)
            created += 1
            const session = { id: `session-live-${created}`, header: { ...(request?.cwd === undefined ? {} : { cwd: request.cwd }) }, append: () => {} }
            sessions.publish(session)
            return { sessionId: session.id }
          },
          async prompt(request) {
            prompts.push(request)
            return { accepted: true }
          },
          async rename(request) {
            renames.push(request)
            return { title: request.title, seq: renames.length }
          },
        }
      }
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') {
        return {
          async readSession(id) {
            if (id === sourceId) {
              const stored = persistence.read(sourceId)
              if (stored !== undefined) return stored
              /**
               * v1.6.0: the calling session's own log, which the confirmation gate reads.
               *
               * `askedUser: true` puts one `ask_user_question` tool call in it, which is the
               * evidence the gate looks for. With `askedUser: false` the log is present but the
               * evidence is absent — the exact shape of "the session hatched without asking".
               */
              const askEvents = askedUser
                ? [
                    {
                      type: 'tool/call',
                      seq: 0,
                      time: 1,
                      data: {
                        turn: 1,
                        step: 2,
                        callId: 'call-ask-1',
                        name: 'ask_user_question',
                        arguments: '{"questions":[{"id":"plan","question":"确认这份计划？"}]}',
                      },
                    },
                  ]
                : []
              return {
                session: { id: sourceId, cwd: headerCwd ?? cwd, ...(sourceHeader ?? {}) },
                inheritedEventCount: 0,
                events: [...askEvents, ...clone(sourceEvents)],
              }
            }
            const stored = persistence.read(id)
            if (stored === undefined) throw new Error(`session "${id}" not found`)
            return stored
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          async resolveByPath(path) {
            return { id: 'ws-1', path, attachSession: async (sessionId) => attached.push({ path, sessionId }) }
          },
          async create(path) {
            return { id: 'ws-new', path, attachSession: async (sessionId) => attached.push({ path, sessionId }) }
          },
        }
      }
      if (name === 'workingDirectory') {
        return { get: () => cwd }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
    emit(event, payload) {
      if (emitThrows) throw new Error('emit refused')
      emitted.push({ event, payload })
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
  }

  return {
    ctx,
    tools,
    commands,
    listeners,
    appends,
    renames,
    prompts,
    creates,
    memoryCalls,
    attached,
    emitted,
    persistence,
    sessions,
    sourceId,
  }
}

/** Extract the developer messages from a captured append log. */
export function developerMessages(appends) {
  return appends
    .filter((entry) => entry.type === 'developer/message')
    .map((entry) => ({
      id: entry.id,
      role: entry.data?.message?.role,
      text: entry.data?.message?.content?.[0]?.text ?? '',
      turn: entry.data?.turn,
      step: entry.data?.step,
    }))
}

/** Every event type written, in order — used to assert the skeleton shape. */
export function eventTypes(appends) {
  return appends.map((entry) => entry.type)
}

/**
 * A mock `append` that records the three-argument form (`type`, `data`, `options`) so a test can see
 * `surfaceOp`, and that returns nothing (the real one is synchronous and void).
 */
export function recordingAppend(appends, id) {
  return (type, data, options) => {
    appends.push({ id, type, data, options })
  }
}

/** The events one cold tape holds, read back out of the fake persistence. */
export function tapeOf(persistence, sessionId) {
  const stored = persistence.read(sessionId)
  return stored === undefined ? [] : stored.events
}
