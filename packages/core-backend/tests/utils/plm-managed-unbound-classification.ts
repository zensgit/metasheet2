import { expect, vi } from 'vitest'
import { setManagedBindingReaderForTests } from '../../src/services/plm-managed-companion'

/**
 * Ordinary legacy fixtures prove a durable no-link by running the real binding
 * query. A missing DATABASE_URL, a schema error, or an outage is not that proof.
 * This double answers only the binding select (empty) and ordinary audit inserts.
 * Any other statement throws. It does not install a reader that returns unbound.
 */
export const SYNTHETIC_UNBOUND_DATABASE_URL = 'postgresql://synthetic@localhost/unused'

const BINDING_FROM = 'FROM plm_managed_source_bindings'
const BINDING_WHERE = 'WHERE b.data_source_id = $1'
const AUDIT_INSERT = 'INSERT INTO operation_audit_logs'

export interface DurableUnboundCall {
  sql: string
  params: unknown
  rows: 0
}

type QueryResponder = (sql: string, params?: unknown) => Promise<{ rows: unknown[]; rowCount: number }>

interface QueryMock {
  mockReset(): void
  mockImplementation(impl: QueryResponder): void
}

function emptyBinding(calls: DurableUnboundCall[], sql: string, params: unknown): { rows: []; rowCount: 0 } {
  calls.push({ sql, params, rows: 0 })
  return { rows: [], rowCount: 0 }
}

function install(queryMock: QueryMock, calls: DurableUnboundCall[], respond: QueryResponder): void {
  calls.length = 0
  queryMock.mockReset()
  queryMock.mockImplementation(respond)
}

export function armDurableUnboundClassification(queryMock: QueryMock, calls: DurableUnboundCall[]): void {
  install(queryMock, calls, async (sql, params) => {
    const text = String(sql)
    if (text.includes(BINDING_FROM)) return emptyBinding(calls, text, params)
    if (text.includes(AUDIT_INSERT)) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected sql ${text}`)
  })
}

/** Binding select succeeds. Every later statement fails, so an attempt-audit outage stays an audit outage. */
export function rejectOther(queryMock: QueryMock, calls: DurableUnboundCall[], error: Error): void {
  install(queryMock, calls, async (sql, params) => {
    const text = String(sql)
    if (text.includes(BINDING_FROM)) return emptyBinding(calls, text, params)
    throw error
  })
}

/**
 * Binding select succeeds. The first non-binding statement (the attempt audit) succeeds.
 * The next one (the outcome audit) fails, so a lost outcome cannot consume the classification answer.
 */
export function succeedOnceThenReject(queryMock: QueryMock, calls: DurableUnboundCall[], error: Error): void {
  let nonBinding = 0
  install(queryMock, calls, async (sql, params) => {
    const text = String(sql)
    if (text.includes(BINDING_FROM)) return emptyBinding(calls, text, params)
    nonBinding += 1
    if (nonBinding === 1 && text.includes(AUDIT_INSERT)) return { rows: [], rowCount: 1 }
    throw error
  })
}

export function beginDurableUnboundClassification(queryMock: QueryMock, calls: DurableUnboundCall[]): void {
  vi.stubEnv('DATABASE_URL', SYNTHETIC_UNBOUND_DATABASE_URL)
  setManagedBindingReaderForTests(null)
  armDurableUnboundClassification(queryMock, calls)
}

export function expectDurableUnboundClassification(calls: DurableUnboundCall[], sourceId: string): void {
  expect(sourceId.length).toBeGreaterThan(0)
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    expect(call.sql).toContain(BINDING_FROM)
    expect(call.sql).toContain(BINDING_WHERE)
    expect(call.params).toEqual([sourceId])
    expect(call.rows).toBe(0)
  }
}

/** The rejected-claim path may classify, and it must not issue a legacy list or audit statement. */
export function expectOnlyDurableUnboundClassification(
  queryCalls: ReadonlyArray<ReadonlyArray<unknown>>,
  calls: DurableUnboundCall[],
  sourceId: string,
): void {
  expectDurableUnboundClassification(calls, sourceId)
  expect(queryCalls).toHaveLength(calls.length)
  for (const call of queryCalls) {
    const sql = String(call[0])
    expect(sql).toContain(BINDING_FROM)
    expect(sql).not.toContain(AUDIT_INSERT)
  }
}

export function finishDurableUnboundClassification(calls: DurableUnboundCall[], sourceId: string): void {
  if (calls.length > 0) expectDurableUnboundClassification(calls, sourceId)
  setManagedBindingReaderForTests(null)
  vi.unstubAllEnvs()
}
