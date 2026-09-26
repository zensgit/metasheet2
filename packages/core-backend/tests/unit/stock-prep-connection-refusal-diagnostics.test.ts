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
import { beforeAll, describe, expect, it } from 'vitest'

import {
  CANONICAL_REFUSAL_RESPONSE,
  HOSTILE_ERROR_CODE,
  HOSTILE_ERROR_MESSAGE,
  LOAD_FAILED_MESSAGE,
  OWNER,
  PULL_ACTION_ID,
  REFUSAL_LOG_MESSAGE,
  ROUTE_FAILED_MESSAGE,
  SCHEDULER_USER,
  SENTINEL,
  TENANT,
  createMemoryDataSourcesKysely,
  createMemoryPluginDb,
  createRefusalStack,
  dataSourceRow,
  externalSystemRow,
  hostileReadError,
  logLinesSince,
  postScheduledDryRun,
  refusalStates,
  resolvableState,
  type CapturedResponse,
  type DataSourceRow,
  type LogEntry,
  type RefusalStack,
} from '../utils/connection-refusal-stack'
import { usePinnedServer } from '../utils/pinned-server'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  DataSourceUnavailableError,
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

  async function refusalsOfEveryBranch(): Promise<Array<{ id: string; refusal: Error & Record<string, unknown> }>> {
    const tenantless = dataSourceRow('fa-tenantless', { tenant_id: null, scope_kind: 'private' })
    const foreign = dataSourceRow('fa-foreign', { tenant_id: `${SENTINEL}-tenant-z` })
    const inactive = dataSourceRow('fa-inactive', { is_active: false })
    const manager = new DataSourceManager()
    await manager.initialize(createMemoryDataSourcesKysely([tenantless, foreign, inactive]))
    const facade = createDataSourcePluginFacade(() => manager)
    const out: Array<{ id: string; refusal: Error & Record<string, unknown> }> = []
    for (const [id, options] of [
      [inactive.id, REGISTRATION], // not_loaded
      [tenantless.id, REGISTRATION], // tenantless_scope
      [foreign.id, REGISTRATION], // tenant_mismatch
      [foreign.id, { ...REGISTRATION, principal: `${SENTINEL}-someone-else` }], // owner_mismatch
      [foreign.id, { ...REGISTRATION, tenantId: '' }], // tenant_missing
    ] as const) {
      out.push({ id, refusal: await refusalOf(() => facade.resolveConnectionRegistration(id, options)) })
    }
    return out
  }

  it('(a) each refusal is the same class, code, message, status, own keys and JSON as a plain not-found', async () => {
    for (const { id, refusal } of await refusalsOfEveryBranch()) {
      const plain = new DataSourceUnavailableError(`Data source with id '${id}' not found`)
      expect(refusal).toBeInstanceOf(DataSourceUnavailableError)
      expect({ name: refusal.name, code: refusal.code, message: refusal.message, status: refusal.status })
        .toEqual({ name: plain.name, code: plain.code, message: plain.message, status: plain.status })
      expect(Object.keys(refusal).sort()).toEqual(Object.keys(plain).sort())
      expect(JSON.stringify(refusal)).toBe(JSON.stringify(plain))
    }
  })

  it('(b) each refusal carries its reason as a NON-enumerable diagnostic', async () => {
    const reasons = []
    for (const { refusal } of await refusalsOfEveryBranch()) {
      const descriptor = Object.getOwnPropertyDescriptor(refusal, 'refusalDiagnostic')
      expect(descriptor).toMatchObject({ enumerable: false })
      reasons.push((descriptor!.value as { reason: string }).reason)
    }
    expect(reasons).toEqual(['not_loaded', 'tenantless_scope', 'tenant_mismatch', 'owner_mismatch', 'tenant_missing'])
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

describe('R2 — an error code outside the closed list is logged as the fixed placeholder (no database)', () => {
  let response: CapturedResponse
  let entries: LogEntry[]

  beforeAll(async () => {
    const source = dataSourceRow('r2')
    const stack = await createRefusalStack({
      kysely: createMemoryDataSourcesKysely([source]),
      pluginDb: createMemoryPluginDb([externalSystemRow('r2', source.id, OWNER)], { failWith: hostileReadError() }),
    })
    ;({ response, entries } = await pull(stack, `${SENTINEL}-es-r2`, false))
  }, SETUP_TIMEOUT_MS)

  it('(a) the response is what the code before this change answered (it is not this change\'s to alter)', () => {
    expect(response).toEqual({
      status: 500,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: false, error: { code: HOSTILE_ERROR_CODE, message: HOSTILE_ERROR_MESSAGE } }),
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

  it('(c) values-free: the hostile code (values and a forged line) never reaches the log', () => {
    const everything = JSON.stringify(entries)
    expect(everything.toLowerCase()).not.toContain(SENTINEL)
    expect(everything).not.toContain('FORGED')
    expect(entries.length).toBeGreaterThan(0)
  })
})
