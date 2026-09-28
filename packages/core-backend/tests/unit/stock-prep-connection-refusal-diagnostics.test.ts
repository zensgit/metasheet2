/**
 * 备料定时试拉 `CONNECTION_CANONICAL_UNAVAILABLE` — refusal reasons reach the SERVER LOG, and the
 * HTTP response does not move by one byte (R1/R2/R3/R7 of
 * docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5).
 *
 * No database: DataSourceManager runs its real load through a real Kysely instance whose driver
 * answers from an in-memory `data_sources` array (tests/utils/connection-refusal-stack.ts). The
 * facade, the plugin's connection resolver, external-system registry and HTTP route table are the
 * real modules, served by a real express app over a real HTTP listener. The same harness runs
 * against PostgreSQL with the repository's migrations in
 * tests/integration/stock-prep-connection-refusal-diagnostics.db.test.ts.
 *
 * Three properties per state:
 *   (a) the response is byte-identical to the bytes the code before this change returned
 *       (CANONICAL_REFUSAL_RESPONSE, captured by running this suite against it). Every state still
 *       answers exactly like every other: no existence leak, no new field.
 *   (b) the server log carries that state's closed-vocabulary reason (R1/R7), the delegation record
 *       (R3) and the response code on the route-failure line (R2) — each exactly once.
 *   (c) no fixture value — id, tenant, owner, login, database name, password — is in any log line.
 */
import util from 'node:util'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CANONICAL_REFUSAL_RESPONSE,
  HOSTILE_ERROR_CODE,
  HOSTILE_ERROR_MESSAGE,
  LOAD_FAILED_MESSAGE,
  OTHER_OWNER,
  OWNER,
  PASSWORD,
  PULL_ACTION_ID,
  REFUSAL_LOG_MESSAGE,
  ROUTE_FAILED_MESSAGE,
  SCHEDULER_USER,
  SENTINEL,
  SHAPED_UNLISTED_ERROR_CODE,
  SHAPED_UNLISTED_ERROR_NAME,
  TENANT,
  createMemoryDataSourcesKysely,
  createMemoryPluginDb,
  createPluginStorage,
  createRefusalStack,
  dataSourceRow,
  externalSystemRow,
  hostileReadError,
  logLinesSince,
  postScheduledDryRun,
  postTableActionRoute,
  refusalStates,
  resolvableState,
  shapedUnlistedCodeError,
  shapedUnlistedNameError,
  type CapturedResponse,
  type DataSourceRow,
  type LogEntry,
  type RefusalStack,
} from '../utils/connection-refusal-stack'
import { usePinnedServer } from '../utils/pinned-server'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
  DataSourceBridgeConfigError,
  DataSourceUnavailableError,
  MISSING_PRINCIPAL_MESSAGE,
  createDataSourcePluginFacade,
} from '../../src/data-adapters/data-source-plugin-facade'

const pinned = usePinnedServer()
const SETUP_TIMEOUT_MS = 120_000

function only(entries: LogEntry[], message: string): LogEntry[] {
  return entries.filter((entry) => entry.message === message)
}

async function pull(
  stack: RefusalStack,
  externalSystemId: string,
  expectRefusal: boolean,
): Promise<{ response: CapturedResponse; entries: LogEntry[] }> {
  pinned.setApp(stack.buildApp({ externalSystemId, user: SCHEDULER_USER }))
  const from = stack.logger.entries.length
  const response = await postScheduledDryRun(pinned.url(), TENANT)
  const entries = await logLinesSince(stack.logger, from, { expectRefusal })
  return { response, entries }
}

describe('canonical refusal states on one loaded registry (no database)', () => {
  const states = refusalStates()
  const control = resolvableState()
  const responses = new Map<string, CapturedResponse>()
  const logs = new Map<string, LogEntry[]>()

  beforeAll(async () => {
    const dataSourceRows: DataSourceRow[] = []
    for (const state of [...states, control]) {
      if (state.dataSource) dataSourceRows.push({ ...state.dataSource })
    }
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely(dataSourceRows),
      pluginDb: createMemoryPluginDb([...states, control].map((state) => state.externalSystem)),
    })
    // S6: the table changes AFTER the registry loaded, and not through the manager.
    for (const state of states) {
      if (!state.afterLoad || !state.dataSource) continue
      const row = dataSourceRows.find((candidate) => candidate.id === state.dataSource!.id)
      Object.assign(row!, state.afterLoad)
    }
    for (const state of [...states, control]) {
      const { response, entries } = await pull(stack, String(state.externalSystem.id), state !== control)
      responses.set(state.key, response)
      logs.set(state.key, entries)
    }
  }, SETUP_TIMEOUT_MS)

  for (const state of refusalStates()) {
    it(`${state.key}: (a) the HTTP response is byte-identical to the pre-change refusal`, () => {
      expect(responses.get(state.key)).toEqual(CANONICAL_REFUSAL_RESPONSE)
    })

    it(`${state.key}: (b) R1/R7 — the server log names the facade's reason, once`, () => {
      expect(only(logs.get(state.key)!, REFUSAL_LOG_MESSAGE)).toEqual([{
        level: 'warn',
        message: REFUSAL_LOG_MESSAGE,
        detail: { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', ...state.expected },
      }])
    })

    it(`${state.key}: (b) R3 — the failed load still records whose identity it ran as`, () => {
      expect(only(logs.get(state.key)!, LOAD_FAILED_MESSAGE)).toEqual([{
        level: 'warn',
        message: LOAD_FAILED_MESSAGE,
        detail: { actionId: PULL_ACTION_ID, delegated: state.delegated, bindingShape: 'canonical' },
      }])
    })

    it(`${state.key}: (b) R2 — the route-failure line carries the response code`, () => {
      expect(only(logs.get(state.key)!, ROUTE_FAILED_MESSAGE)).toEqual([{
        level: 'warn',
        message: ROUTE_FAILED_MESSAGE,
        detail: { code: 'CONNECTION_CANONICAL_UNAVAILABLE' },
      }])
    })
  }

  it('(a) the states cannot be told apart from the response: every refusal is one byte string', () => {
    const answers = new Set(refusalStates().map((state) => JSON.stringify(responses.get(state.key))))
    expect(answers.size).toBe(1)
  })

  it('(c) values-free: no fixture value reaches any log line', () => {
    const everything = JSON.stringify([...logs.values()])
    expect(everything.toLowerCase()).not.toContain(SENTINEL)
    // …and the harness did produce the lines it inspects (a vacuous pass is not a pass).
    expect(everything).toContain('connection resolution refused')
    expect(everything).toContain('table action source load failed')
  })

  it('control: a resolvable binding produces no refusal, load-failure or route-failure line', () => {
    const entries = logs.get(control.key)!
    expect(only(entries, REFUSAL_LOG_MESSAGE)).toEqual([])
    expect(only(entries, LOAD_FAILED_MESSAGE)).toEqual([])
    expect(only(entries, ROUTE_FAILED_MESSAGE)).toEqual([])
    expect(responses.get(control.key)!.body).not.toContain('CONNECTION_CANONICAL_UNAVAILABLE')
  })
})

describe('S2e — the registry never loaded (no database)', () => {
  let response: CapturedResponse
  let entries: LogEntry[]

  beforeAll(async () => {
    const source = dataSourceRow('s2e')
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely([source]),
      pluginDb: createMemoryPluginDb([externalSystemRow('s2e', source.id, OWNER)]),
      loadRegistry: false,
    })
    ;({ response, entries } = await pull(stack, `${SENTINEL}-es-s2e`, true))
  }, SETUP_TIMEOUT_MS)

  it('(a) same bytes as every other refusal', () => {
    expect(response).toEqual(CANONICAL_REFUSAL_RESPONSE)
  })

  it('(b) not_loaded / registry_not_loaded, and the table says the row is live', () => {
    expect(only(entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'not_loaded',
      loadOutcome: 'registry_not_loaded',
      persistedLive: true,
    }])
  })

  it('(c) values-free', () => {
    expect(JSON.stringify(entries).toLowerCase()).not.toContain(SENTINEL)
  })
})

// S2e as it happens in production: initialize() runs, and the registry's own `data_sources` query
// fails. loadFromDatabase catches that and warns `Could not load from database` (the S2e signal of
// diagnosis §4.6), so this must read registry_not_loaded — never unknown_at_load, which is what a
// load that COMPLETED with a failed snapshot reads, and would point the operator elsewhere.
describe('S2e — the registry load query fails (no database)', () => {
  const LOAD_FAILURE = new Error('relation "data_sources" does not exist')

  it('initialize resolves; every id reads not_loaded / registry_not_loaded; the load-filter snapshot never ran', async () => {
    const row = dataSourceRow('s2e-query')
    const snapshot = { calls: 0 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let warns: unknown[][] = []
    const manager = new DataSourceManager()
    try {
      await expect(manager.initialize(createMemoryDataSourcesKysely([row], {
        load: { failWith: LOAD_FAILURE },
        snapshot,
      }))).resolves.toBeUndefined()
      warns = warn.mock.calls.map((args) => [...args])
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
    expect(warns.map((args) => args[0])).toEqual(['[DataSourceManager] Could not load from database:'])
    expect(snapshot.calls).toBe(0)
    for (const id of [row.id, `${SENTINEL}-ds-never-existed`]) {
      expect(manager.describeAccessRefusal(id, OWNER)).toEqual({ reason: 'not_loaded', loadOutcome: 'registry_not_loaded' })
    }
    // …and the R7 read still answers from the table: the row is live there.
    await expect(manager.probePersistedLiveRow(row.id)).resolves.toBe(true)
  })

  it('control: the same rows with the load answering read absent_at_load, and the snapshot ran once', async () => {
    const row = dataSourceRow('s2e-query-ok')
    const snapshot = { calls: 0 }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const manager = new DataSourceManager()
    try {
      await manager.initialize(createMemoryDataSourcesKysely([row], { snapshot }))
    } finally {
      log.mockRestore()
    }
    expect(snapshot.calls).toBe(1)
    expect(manager.describeAccessRefusal(row.id, OWNER)).toBeNull()
    expect(manager.describeAccessRefusal(`${SENTINEL}-ds-never-existed`, OWNER))
      .toEqual({ reason: 'not_loaded', loadOutcome: 'absent_at_load' })
  })

  describe('through the scheduled dry-run route', () => {
    let response: CapturedResponse
    let entries: LogEntry[]

    beforeAll(async () => {
      const source = dataSourceRow('s2e-query-http')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      let stack: RefusalStack
      try {
        stack = await createRefusalStack({
          kysely: createMemoryDataSourcesKysely([source], { load: { failWith: LOAD_FAILURE } }),
          pluginDb: createMemoryPluginDb([externalSystemRow('s2e-query-http', source.id, OWNER)]),
        })
      } finally {
        warn.mockRestore()
        log.mockRestore()
      }
      ;({ response, entries } = await pull(stack, `${SENTINEL}-es-s2e-query-http`, true))
    }, SETUP_TIMEOUT_MS)

    it('(a) same bytes as every other refusal', () => {
      expect(response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    })

    it('(b) not_loaded / registry_not_loaded, and the table says the row is live', () => {
      expect(only(entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
        phase: 'canonical',
        code: 'CONNECTION_CANONICAL_UNAVAILABLE',
        reason: 'not_loaded',
        loadOutcome: 'registry_not_loaded',
        persistedLive: true,
      }])
    })

    it('(c) values-free', () => {
      expect(JSON.stringify(entries).toLowerCase()).not.toContain(SENTINEL)
    })
  })
})

describe('S1 — no host facade injected (no database)', () => {
  let response: CapturedResponse
  let entries: LogEntry[]

  beforeAll(async () => {
    const source = dataSourceRow('s1')
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely([source]),
      pluginDb: createMemoryPluginDb([externalSystemRow('s1', source.id, OWNER)]),
      facadeInjected: false,
    })
    ;({ response, entries } = await pull(stack, `${SENTINEL}-es-s1`, true))
  }, SETUP_TIMEOUT_MS)

  it('(a) same bytes as every other refusal', () => {
    expect(response).toEqual(CANONICAL_REFUSAL_RESPONSE)
  })

  it('(b) facade_unavailable', () => {
    expect(only(entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'facade_unavailable',
    }])
  })

  it('(c) values-free', () => {
    expect(JSON.stringify(entries).toLowerCase()).not.toContain(SENTINEL)
  })
})

describe('facade: the refusal itself is unchanged, and it never waits for the R7 table read', () => {
  const REGISTRATION = { tenantId: TENANT, principal: OWNER, runAs: 'user' as const }

  async function refusalOf(action: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
    try {
      await action()
    } catch (error) {
      return error as Error & Record<string, unknown>
    }
    throw new Error('expected the facade to refuse')
  }

  type BranchRefusal = { id: string; refusal: Error & Record<string, unknown>; plain: Error & Record<string, unknown> }

  // Every refusal branch of resolveConnectionRegistration that the real manager can reach, each with
  // the error that branch threw BEFORE this change (`plain`). principal_missing is the odd one: its
  // error is requirePrincipal's own DataSourceBridgeConfigError, not a not-found, and the diagnostic
  // is attached to that error rather than to a fresh DataSourceUnavailableError.
  // scope_missing is on the list but cannot be reached with the real manager: assertAccess already
  // refuses (as not_loaded) when the id has no scope, and getScope reads that same map right after it
  // with no await in between, so the `!scope` check behind it is a defensive re-check.
  async function refusalsOfEveryBranch(): Promise<BranchRefusal[]> {
    const tenantless = dataSourceRow('fa-tenantless', { tenant_id: null, scope_kind: 'private' })
    const legacyTenantless = dataSourceRow('fa-legacy-tenantless', { tenant_id: null, scope_kind: 'legacy_private' })
    const foreign = dataSourceRow('fa-foreign', { tenant_id: `${SENTINEL}-tenant-z` })
    const inactive = dataSourceRow('fa-inactive', { is_active: false })
    const manager = new DataSourceManager()
    await manager.initialize(createMemoryDataSourcesKysely([tenantless, legacyTenantless, foreign, inactive]))
    const facade = createDataSourcePluginFacade(() => manager)
    const notFound = (id: string) => new DataSourceUnavailableError(`Data source with id '${id}' not found`) as unknown as Error & Record<string, unknown>
    const principalRequired = () => new DataSourceBridgeConfigError(
      DATA_SOURCE_PRINCIPAL_REQUIRED_CODE, MISSING_PRINCIPAL_MESSAGE, 'DataSourcePrincipalRequiredError',
    ) as unknown as Error & Record<string, unknown>
    const out: BranchRefusal[] = []
    for (const [id, options, plain] of [
      [inactive.id, REGISTRATION, notFound(inactive.id)], // not_loaded
      [tenantless.id, REGISTRATION, notFound(tenantless.id)], // tenantless_scope
      [foreign.id, REGISTRATION, notFound(foreign.id)], // tenant_mismatch
      [foreign.id, { ...REGISTRATION, principal: `${SENTINEL}-someone-else` }, notFound(foreign.id)], // owner_mismatch
      [foreign.id, { ...REGISTRATION, tenantId: '' }, notFound(foreign.id)], // tenant_missing
      [foreign.id, { ...REGISTRATION, principal: '' }, principalRequired()], // principal_missing
      [foreign.id, { ...REGISTRATION, runAs: `${SENTINEL}-bogus` }, notFound(foreign.id)], // run_as_invalid
      [legacyTenantless.id, { ...REGISTRATION, runAs: 'service' }, notFound(legacyTenantless.id)], // tenantless_service
    ] as const) {
      out.push({
        id,
        refusal: await refusalOf(() => facade.resolveConnectionRegistration(id, options as never)),
        plain,
      })
    }
    return out
  }

  it('(a) each refusal is the same class, code, message, status, own keys and JSON as that branch threw before', async () => {
    const refusals = await refusalsOfEveryBranch()
    expect(refusals).toHaveLength(8)
    for (const { refusal, plain } of refusals) {
      expect(refusal.constructor).toBe(plain.constructor)
      expect({ name: refusal.name, code: refusal.code, message: refusal.message, status: refusal.status })
        .toEqual({ name: plain.name, code: plain.code, message: plain.message, status: plain.status })
      expect(Object.keys(refusal).sort()).toEqual(Object.keys(plain).sort())
      expect(JSON.stringify(refusal)).toBe(JSON.stringify(plain))
    }
    // principal_missing keeps requirePrincipal's own error: it is NOT turned into a not-found.
    const principalMissing = refusals[5].refusal
    expect(principalMissing).toBeInstanceOf(DataSourceBridgeConfigError)
    expect(principalMissing).not.toBeInstanceOf(DataSourceUnavailableError)
    expect(principalMissing.code).toBe(DATA_SOURCE_PRINCIPAL_REQUIRED_CODE)
  })

  it('(b) each refusal carries its reason as a NON-enumerable diagnostic', async () => {
    const reasons = []
    for (const { refusal } of await refusalsOfEveryBranch()) {
      const descriptor = Object.getOwnPropertyDescriptor(refusal, 'refusalDiagnostic')
      expect(descriptor).toMatchObject({ enumerable: false })
      reasons.push((descriptor!.value as { reason: string }).reason)
    }
    expect(reasons).toEqual([
      'not_loaded', 'tenantless_scope', 'tenant_mismatch', 'owner_mismatch', 'tenant_missing',
      'principal_missing', 'run_as_invalid', 'tenantless_service',
    ])
  })

  it('(timing) the refusal is thrown before the R7 read is issued; the read runs only when the log writer asks', async () => {
    const inactive = dataSourceRow('fa-timing', { is_active: false })
    let open!: () => void
    const probe = { calls: 0, gate: new Promise<void>((resolve) => { open = resolve }) }
    const manager = new DataSourceManager()
    await manager.initialize(createMemoryDataSourcesKysely([inactive], { probe }))
    const facade = createDataSourcePluginFacade(() => manager)

    const started = Date.now()
    const refusal = await refusalOf(() => facade.resolveConnectionRegistration(inactive.id, REGISTRATION))
    expect(Date.now() - started).toBeLessThan(1000)
    expect(probe.calls).toBe(0)

    const diagnostic = refusal.refusalDiagnostic as { reason: string; probePersistedLive?: () => Promise<boolean | null> }
    expect(diagnostic.reason).toBe('not_loaded')
    const answer = diagnostic.probePersistedLive!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(probe.calls).toBe(1)
    open()
    await expect(answer).resolves.toBe(false)
  })
})

// R2 admits a code from a closed LIST. The first case is free text that no identifier filter would
// pass either; the other two are well-formed identifiers that a shape filter (a character-class
// regex) WOULD pass — so only these two tell "a list" from "a shape".
for (const hostile of [
  { key: 'r2', label: 'free text carrying values and a forged line', error: hostileReadError, code: HOSTILE_ERROR_CODE },
  { key: 'r2-code', label: 'a well-formed code that is not on the list', error: shapedUnlistedCodeError, code: SHAPED_UNLISTED_ERROR_CODE },
  { key: 'r2-name', label: 'a well-formed class name (no code) that is not on the list', error: shapedUnlistedNameError, code: SHAPED_UNLISTED_ERROR_NAME },
]) {
  describe(`R2 — ${hostile.label}: logged as the fixed placeholder (no database)`, () => {
    let response: CapturedResponse
    let entries: LogEntry[]

    beforeAll(async () => {
      const source = dataSourceRow(hostile.key)
      const stack = await createRefusalStack({
        kysely: createMemoryDataSourcesKysely([source]),
        pluginDb: createMemoryPluginDb([externalSystemRow(hostile.key, source.id, OWNER)], { failWith: hostile.error() }),
      })
      ;({ response, entries } = await pull(stack, `${SENTINEL}-es-${hostile.key}`, false))
    }, SETUP_TIMEOUT_MS)

    it('(a) the response is what the code before this change answered (it is not this change\'s to alter)', () => {
      expect(response).toEqual({
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: false, error: { code: hostile.code, message: HOSTILE_ERROR_MESSAGE } }),
      })
    })

    it('(b) the route-failure line names UNLISTED, and the failed load records an unreadable peek', () => {
      expect(only(entries, ROUTE_FAILED_MESSAGE)).toEqual([{
        level: 'warn',
        message: ROUTE_FAILED_MESSAGE,
        detail: { code: 'UNLISTED' },
      }])
      expect(only(entries, LOAD_FAILED_MESSAGE)).toEqual([{
        level: 'warn',
        message: LOAD_FAILED_MESSAGE,
        detail: { actionId: PULL_ACTION_ID, delegated: false, bindingShape: 'unreadable' },
      }])
      expect(only(entries, REFUSAL_LOG_MESSAGE)).toEqual([])
    })

    it('(c) values-free: the unlisted code never reaches the log', () => {
      const everything = JSON.stringify(entries)
      expect(everything.toLowerCase()).not.toContain(SENTINEL)
      expect(everything).not.toContain('FORGED')
      expect(entries.length).toBeGreaterThan(0)
    })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))
async function macrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) await macrotask()
}
function persistedLiveOf(entries: LogEntry[]): unknown[] {
  return only(entries, REFUSAL_LOG_MESSAGE).map((entry) => (entry.detail as { persistedLive?: unknown }).persistedLive)
}

describe('R7 bounds — the table read behind persistedLive: 2s, at most 4 in flight, a slot held until its query settles (no database)', () => {
  // Restated here, NOT imported: a test that reads a bound off the code under test keeps passing
  // whatever that bound is changed to.
  const PROBE_TIMEOUT_MS = 2000
  const PROBE_MAX_IN_FLIGHT = 4

  it('the 5th concurrent read answers null at once without reading; the 4 hung reads answer null at exactly 2s; their slots stay held until the queries settle', async () => {
    const row = dataSourceRow('r7-bounds', { is_active: false })
    let open!: () => void
    const probe = { calls: 0, gate: new Promise<void>((resolve) => { open = resolve }) }
    const manager = new DataSourceManager()
    await manager.initialize(createMemoryDataSourcesKysely([row], { probe }))

    // Only the timeout's own clock is faked; setImmediate stays real so `macrotasks()` drains the
    // promise chains without moving time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const answers: Array<boolean | null | 'pending'> = []
      const ask = () => {
        const index = answers.push('pending') - 1
        void manager.probePersistedLiveRow(row.id).then((value) => { answers[index] = value })
      }

      for (let i = 0; i <= PROBE_MAX_IN_FLIGHT; i += 1) ask()
      await macrotasks()
      expect(probe.calls).toBe(PROBE_MAX_IN_FLIGHT)
      expect(answers).toEqual(['pending', 'pending', 'pending', 'pending', null])

      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
      expect(answers.slice(0, PROBE_MAX_IN_FLIGHT)).toEqual(['pending', 'pending', 'pending', 'pending'])
      await vi.advanceTimersByTimeAsync(1)
      expect(answers.slice(0, PROBE_MAX_IN_FLIGHT)).toEqual([null, null, null, null])

      // The timeout answered, but the four queries are still running: their slots are still held,
      // so a slow database cannot accumulate reads past the cap by timing each one out.
      ask()
      await macrotasks()
      expect(answers[5]).toBe(null)
      expect(probe.calls).toBe(PROBE_MAX_IN_FLIGHT)

      // The queries settle: the slots come back, and the next read is issued and answered.
      open()
      await macrotasks()
      ask()
      await macrotasks()
      expect(answers[6]).toBe(false)
      expect(probe.calls).toBe(PROBE_MAX_IN_FLIGHT + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R7 end to end — a hung table read never holds the response, and its line comes from the manager\'s 2s timeout (no database)', () => {
  it('four refusals answer at once; their lines arrive with null well before the resolver\'s 3s budget; a fifth logs null with no fifth read', async () => {
    const rows: DataSourceRow[] = []
    const systems: Array<Record<string, unknown>> = []
    for (let i = 0; i < 6; i += 1) {
      const row = dataSourceRow(`hang${i}`, { is_active: false })
      rows.push(row)
      systems.push(externalSystemRow(`hang${i}`, row.id, OWNER))
    }
    let open!: () => void
    const probe = { calls: 0, gate: new Promise<void>((resolve) => { open = resolve }) }
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely(rows, { probe }),
      pluginDb: createMemoryPluginDb(systems),
    })
    const refusalLines = () => only(stack.logger.entries, REFUSAL_LOG_MESSAGE)

    for (let i = 0; i < 4; i += 1) {
      pinned.setApp(stack.buildApp({ externalSystemId: `${SENTINEL}-es-hang${i}`, user: SCHEDULER_USER }))
      const started = Date.now()
      const response = await postScheduledDryRun(pinned.url(), TENANT)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    }
    expect(refusalLines()).toEqual([])

    const waitStarted = Date.now()
    while (refusalLines().length < 4 && Date.now() - waitStarted < 5000) await sleep(5)
    const waited = Date.now() - waitStarted
    expect(persistedLiveOf(stack.logger.entries)).toEqual([null, null, null, null])
    expect(probe.calls).toBe(4)
    // The manager's own 2s timeout answered, not the resolver's 3s budget.
    expect(waited).toBeGreaterThanOrEqual(1500)
    expect(waited).toBeLessThan(2800)

    // All four reads are still hung: a fifth refusal logs null at once and issues no fifth read.
    const fifthStarted = Date.now()
    const fifth = await pull(stack, `${SENTINEL}-es-hang4`, true)
    expect(Date.now() - fifthStarted).toBeLessThan(1500)
    expect(fifth.response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    expect(persistedLiveOf(fifth.entries)).toEqual([null])
    expect(probe.calls).toBe(4)

    // Once the hung queries settle, the next refusal reads the table again and gets its answer.
    open()
    await sleep(50)
    const sixth = await pull(stack, `${SENTINEL}-es-hang5`, true)
    expect(persistedLiveOf(sixth.entries)).toEqual([false])
    expect(probe.calls).toBe(5)
    expect(JSON.stringify(stack.logger.entries).toLowerCase()).not.toContain(SENTINEL)
  }, 30_000)
})

describe('startup — the load-filter snapshot failing costs the diagnostic, never the load (no database)', () => {
  // Restated verbatim: the ONE line this failure may write, with nothing after it.
  const SNAPSHOT_UNAVAILABLE_WARNING =
    '[DataSourceManager] Load-filter snapshot unavailable; unloaded-source diagnostics degrade to unknown_at_load'
  // A driver-style error whose text carries a host, a login and a password (synthetic, SENTINEL-marked).
  const DRIVER_ERROR_TEXT = `connect ECONNREFUSED ${SENTINEL}-db-host:5432 user=${SENTINEL}_login password=${PASSWORD}`

  async function initialized(snapshotFails: boolean) {
    const live = dataSourceRow('snap-live')
    const inactive = dataSourceRow('snap-inactive', { is_active: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const manager = new DataSourceManager()
      await manager.initialize(createMemoryDataSourcesKysely([live, inactive], {
        snapshot: snapshotFails ? { failWith: new Error(DRIVER_ERROR_TEXT) } : undefined,
      }))
      return { manager, live, inactive, warns: warn.mock.calls.map((args) => [...args]) }
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  }

  it('the load completes and serves the loaded source; exactly one fixed, values-free warn; unloaded ids read unknown_at_load', async () => {
    const { manager, live, inactive, warns } = await initialized(true)
    expect(manager.describeAccessRefusal(live.id, OWNER)).toBeNull()
    expect(warns).toEqual([[SNAPSHOT_UNAVAILABLE_WARNING]])
    expect(util.inspect(warns, { depth: 8 }).toLowerCase()).not.toContain(SENTINEL)
    expect(manager.describeAccessRefusal(inactive.id, OWNER)).toEqual({ reason: 'not_loaded', loadOutcome: 'unknown_at_load' })
    expect(manager.describeAccessRefusal(`${SENTINEL}-ds-never-existed`, OWNER))
      .toEqual({ reason: 'not_loaded', loadOutcome: 'unknown_at_load' })
  })

  it('control: with the snapshot answering, the same rows read inactive / absent_at_load and nothing is warned', async () => {
    const { manager, live, inactive, warns } = await initialized(false)
    expect(manager.describeAccessRefusal(live.id, OWNER)).toBeNull()
    expect(warns).toEqual([])
    expect(manager.describeAccessRefusal(inactive.id, OWNER)).toEqual({ reason: 'not_loaded', loadOutcome: 'inactive' })
    expect(manager.describeAccessRefusal(`${SENTINEL}-ds-never-existed`, OWNER))
      .toEqual({ reason: 'not_loaded', loadOutcome: 'absent_at_load' })
  })
})

describe('startup — a row skipped at load reads load_failed or decrypt_failed by what actually failed (no database)', () => {
  // decrypt_failed points an operator at ENCRYPTION_KEY; load_failed at the row itself. Each side is
  // asserted against the other on one load, so neither word can stand in for both.
  it('decrypt failure → decrypt_failed; JSON-null config or a throwing adapter constructor → load_failed; unknown type → unsupported_type', async () => {
    const unconstructible = 'refusal-probe-unconstructible-at-load'
    const decrypt = dataSourceRow('lo-decrypt', {
      config: {
        connection: { host: 'localhost', port: 5432, database: `${SENTINEL}_never_connected` },
        credentials: { username: `${SENTINEL}_login`, password: 'enc:AAAAAAAAAAAA' },
        options: { readOnly: true, autoConnect: false },
      },
    })
    const nullConfig = dataSourceRow('lo-null-config', { config: null })
    const throwingAdapter = dataSourceRow('lo-ctor-throws', { type: unconstructible })
    const unsupported = dataSourceRow('lo-unsupported', { type: 'oracle' })
    const live = dataSourceRow('lo-live')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const manager = new DataSourceManager()
    try {
      manager.registerAdapterType(unconstructible, class {
        constructor() {
          throw new Error('adapter construction refused')
        }
      } as never)
      await manager.initialize(createMemoryDataSourcesKysely([decrypt, nullConfig, throwingAdapter, unsupported, live]))
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
    expect(manager.describeAccessRefusal(live.id, OWNER)).toBeNull()
    expect([decrypt, nullConfig, throwingAdapter, unsupported].map((row) => manager.describeAccessRefusal(row.id, OWNER))).toEqual([
      { reason: 'not_loaded', loadOutcome: 'decrypt_failed' },
      { reason: 'not_loaded', loadOutcome: 'load_failed' },
      { reason: 'not_loaded', loadOutcome: 'load_failed' },
      { reason: 'not_loaded', loadOutcome: 'unsupported_type' },
    ])
  })
})

describe('unloaded outcomes recorded at runtime: removed, and an update whose re-add failed (no database)', () => {
  function runtimeConfig(key: string) {
    return {
      id: `${SENTINEL}-ds-${key}`,
      name: `${SENTINEL} runtime ${key}`,
      type: 'postgresql',
      connection: { host: 'localhost', port: 5432, database: `${SENTINEL}_never_connected` },
      credentials: { username: `${SENTINEL}_login`, password: PASSWORD },
      options: { readOnly: true, autoConnect: false },
    }
  }

  it('removed through the manager: the id reads removed, not registry_not_loaded', async () => {
    const manager = new DataSourceManager()
    const config = runtimeConfig('rt-removed')
    await manager.addDataSource(config as never, { ownerId: OWNER, tenantId: TENANT, persist: false })
    expect(manager.describeAccessRefusal(config.id, OWNER)).toBeNull()
    await manager.removeDataSource(config.id)
    expect(manager.describeAccessRefusal(config.id, OWNER)).toEqual({ reason: 'not_loaded', loadOutcome: 'removed' })
  })

  it('an update whose re-add throws: the error is rethrown untouched, and the id reads load_failed', async () => {
    const manager = new DataSourceManager()
    const unconstructible = 'refusal-probe-unconstructible'
    manager.registerAdapterType(unconstructible, class {
      constructor() {
        throw new Error('adapter construction refused')
      }
    } as never)
    const config = runtimeConfig('rt-readd')
    await manager.addDataSource(config as never, { ownerId: OWNER, tenantId: TENANT, persist: false })
    await expect(manager.updateDataSource(config.id, { ...config, type: unconstructible } as never))
      .rejects.toThrow('adapter construction refused')
    expect(manager.describeAccessRefusal(config.id, OWNER)).toEqual({ reason: 'not_loaded', loadOutcome: 'load_failed' })
  })
})

describe('R3 — a logger that throws on the load-failure line changes nothing a caller sees (no database)', () => {
  let response: CapturedResponse
  let entries: LogEntry[]
  let attempts = 0

  beforeAll(async () => {
    const source = dataSourceRow('r3-throw')
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely([source]),
      pluginDb: createMemoryPluginDb([externalSystemRow('r3-throw', source.id, OTHER_OWNER)]),
    })
    // The resolver and the route table hold this same logger object and look `warn` up per call.
    const write = stack.logger.warn
    stack.logger.warn = (message: string, detail?: unknown) => {
      if (message === LOAD_FAILED_MESSAGE) {
        attempts += 1
        throw new Error(`${SENTINEL} logger down`)
      }
      write(message, detail)
    }
    ;({ response, entries } = await pull(stack, `${SENTINEL}-es-r3-throw`, true))
  }, SETUP_TIMEOUT_MS)

  it('(a) the response is byte-identical to every other refusal', () => {
    expect(response).toEqual(CANONICAL_REFUSAL_RESPONSE)
  })

  it('(b) the load-failure line was attempted once and cost only itself: the refusal and route-failure lines are each written once', () => {
    expect(attempts).toBe(1)
    expect(only(entries, LOAD_FAILED_MESSAGE)).toEqual([])
    expect(only(entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'owner_mismatch',
    }])
    expect(only(entries, ROUTE_FAILED_MESSAGE).map((entry) => entry.detail)).toEqual([{ code: 'CONNECTION_CANONICAL_UNAVAILABLE' }])
    expect(JSON.stringify(entries).toLowerCase()).not.toContain(SENTINEL)
  })
})

describe('R3 — scoped to the frozen action: no other action id reaches the source load (no database)', () => {
  // WHY THE SCOPE HOLDS. The R3 record is written only when the identity peek ran, and the peek runs
  // only for the frozen pull id. What keeps every OTHER action id away from the load is upstream:
  // all five call sites of the source load take their action from assertStockPreparationTargetReady,
  // which re-normalizes it and admits only the frozen id (stock-preparation-table-actions.cjs,
  // normalizeStockPreparationActionConfig). The one door that does not come from the configured
  // registry is a stored large-BOM job, whose run route loads from the job's own action SNAPSHOT —
  // so that is the door tested here: two jobs on one binding the host refuses, one as stored, one
  // with its snapshot's action id rewritten. If that fence is ever relaxed, the second case goes red
  // and the R3 scope has to be re-examined.
  const OTHER_ACTION_ID = 'plm.stock-preparation.not-the-frozen-pull.v1'
  type Run = { response: CapturedResponse; entries: LogEntry[] }
  let control: Run
  let offAction: Run

  beforeAll(async () => {
    const source = dataSourceRow('r3-scope')
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely([source]),
      pluginDb: createMemoryPluginDb([externalSystemRow('r3-scope', source.id, OTHER_OWNER)]),
    })
    const storage = createPluginStorage()
    pinned.setApp(stack.buildApp({ externalSystemId: `${SENTINEL}-es-r3-scope`, user: SCHEDULER_USER, storage }))

    async function startJob(): Promise<string> {
      const started = await postTableActionRoute(pinned.url(), TENANT, 'large-bom/expansion-jobs', {
        parameters: { projectNo: 'P-SYNTH-0001' },
      })
      expect(started.status).toBe(202)
      return String((JSON.parse(started.body) as { data: { jobId: string } }).data.jobId)
    }
    async function runJob(jobId: string, expectRefusal: boolean): Promise<Run> {
      const from = stack.logger.entries.length
      const response = await postTableActionRoute(
        pinned.url(), TENANT, `large-bom/expansion-jobs/${encodeURIComponent(jobId)}/run`, {},
      )
      return { response, entries: await logLinesSince(stack.logger, from, { expectRefusal }) }
    }

    const controlJob = await startJob()
    const offActionJob = await startJob()
    let rewritten = 0
    for (const [key, job] of [...storage.entries()] as Array<[string, Record<string, unknown>]>) {
      if (!key.endsWith(`:${offActionJob}`)) continue
      const snapshot = job.actionSnapshot as Record<string, unknown>
      Map.prototype.set.call(storage, key, { ...job, actionSnapshot: { ...snapshot, actionId: OTHER_ACTION_ID } })
      rewritten += 1
    }
    expect(rewritten).toBe(1)

    control = await runJob(controlJob, true)
    offAction = await runJob(offActionJob, false)
  }, SETUP_TIMEOUT_MS)

  it('control: the frozen action\'s refused load writes the record (the negative below is not vacuous)', () => {
    expect(control.response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    expect(only(control.entries, LOAD_FAILED_MESSAGE)).toEqual([{
      level: 'warn',
      message: LOAD_FAILED_MESSAGE,
      detail: { actionId: PULL_ACTION_ID, delegated: true, bindingShape: 'canonical' },
    }])
  })

  it('another action id is refused before any source load: the host is never asked, and no load-failure record is written', () => {
    expect(offAction.response.status).toBe(422)
    expect((JSON.parse(offAction.response.body) as { error: { code: string } }).error.code).toBe('TABLE_ACTION_CONFIG_INVALID')
    expect(only(offAction.entries, REFUSAL_LOG_MESSAGE)).toEqual([])
    expect(only(offAction.entries, LOAD_FAILED_MESSAGE)).toEqual([])
    expect(JSON.stringify([control.entries, offAction.entries]).toLowerCase()).not.toContain(SENTINEL)
  })
})
