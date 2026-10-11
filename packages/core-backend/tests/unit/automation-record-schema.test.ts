import { describe, expect, it, vi } from 'vitest'
import { captureAutomationRecordSchema, resolveAutomationRecordSchemaRevision,
  type AutomationRecordSchemaToken } from '../../src/multitable/automation-record-schema'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const SHEET = 'synthetic-schema-sheet'
const REVISION = '11111111-1111-4111-8111-111111111111'
const NEXT = '22222222-2222-4222-8222-222222222222'
const ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' }

// Query-contract fixture only. The separate real-PG suite proves lock/savepoint/DDL behavior.
function fixture() {
  const state = { xid: '123', isolation: 'read committed', consistent: true, held: true,
    live: true, exists: true, epoch: true, revision: REVISION, failAt: '', errorCode: '55P03', rollbackFails: false }
  const statements: string[] = []
  const query = vi.fn(async (sql: string) => {
    statements.push(sql)
    if (state.failAt && sql.includes(state.failAt)) throw Object.assign(new Error('synthetic SQL failure'), { code: state.errorCode })
    if (sql.startsWith('ROLLBACK TO') && state.rollbackFails) throw new Error('synthetic rollback failure')
    if (sql === 'SELECT pg_current_xact_id()::text AS xid') return { rows: [{ xid: state.xid }] }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation") return { rows: [{ isolation: state.isolation }] }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT|LOCK TABLE) /u.test(sql)) return { rows: [] }
    if (sql.includes('pg_catalog.pg_locks')) return { rows: [{ held: state.held }] }
    if (sql.includes('count(c.oid) = 4')) return { rows: [{ consistent: state.consistent }] }
    if (sql === 'SELECT id, deleted_at FROM meta_sheets WHERE id = $1') {
      return { rows: state.exists ? [{ id: SHEET, deleted_at: state.live ? null : 'synthetic-deleted' }] : [] }
    }
    if (sql.includes('SELECT revision FROM automation_read_material_epochs')) {
      return { rows: state.epoch ? [{ revision: state.revision }] : [] }
    }
    throw new Error('Unexpected schema fixture query')
  })
  const trx: TransactionalQueryable = {
    isTransaction: true,
    query: async sql => {
      const result = await query(sql)
      return { ...result, rowCount: result.rows.length }
    },
  }
  return { state, statements, query, trx }
}

describe('automation record schema — private transaction-local query contract', () => {
  it.each([undefined, 'false', '', '0', '1'])('OFF is inert even before input validation (%s)', async flag => {
    const { trx, query } = fixture()
    expect(await captureAutomationRecordSchema(trx, '', { AUTOMATION_DURABLE_DELIVERY_ENABLED: flag })).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, undefined)).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it.each(['TRUE', ' true'])('inherits the existing internal durable flag parser, not an external-write switch (%s)', async flag => {
    const { trx } = fixture()
    const captured = await captureAutomationRecordSchema(trx, SHEET, { AUTOMATION_DURABLE_DELIVERY_ENABLED: flag })
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBe(REVISION)
  })

  it.each(['', ' padded ', 'bad\nidentity', 'x'.repeat(257)])('rejects noncanonical identity before IO %#', async id => {
    const { trx, query } = fixture()
    await expect(captureAutomationRecordSchema(trx, id, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_INPUT_INVALID')
    expect(query).not.toHaveBeenCalled()
  })

  it('captures opaque immutable evidence under a savepoint, then resolves only the same transaction', async () => {
    const { trx, statements } = fixture()
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Reflect.ownKeys(captured!)).toEqual([])
    expect(statements.findIndex(sql => sql.startsWith('SAVEPOINT '))).toBeLessThan(statements.findIndex(sql => sql.startsWith('LOCK TABLE ')))
    expect(statements.at(-1)).toBe('RELEASE SAVEPOINT automation_record_schema_capture')
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBe(REVISION)
    expect(statements.filter(sql => sql.startsWith('LOCK TABLE '))).toHaveLength(1)
  })

  it.each(['repeatable read', 'serializable', ''])('refuses wrong isolation (%s)', async isolation => {
    const { trx, state, statements } = fixture()
    state.isolation = isolation
    await expect(captureAutomationRecordSchema(trx, SHEET, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_TRANSACTION_REQUIRED')
    expect(statements.some(sql => sql.startsWith('SAVEPOINT '))).toBe(false)
  })

  it('does not permit inconsistent schemas or RLS to certify a nonce', async () => {
    const { trx, state } = fixture()
    state.consistent = false
    await expect(captureAutomationRecordSchema(trx, SHEET, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_UNAVAILABLE')
  })

  it.each(['LOCK TABLE ', 'SELECT revision FROM'])('only NOWAIT conflict is optional, with rollback then release (%s)', async failAt => {
    const { trx, state, statements } = fixture()
    state.failAt = failAt
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    expect(statements.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT automation_record_schema_capture', 'RELEASE SAVEPOINT automation_record_schema_capture'])
    state.failAt = ''
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBeNull()
    // No late recapture after the ordinary DML would have happened.
    expect(statements.filter(sql => sql.startsWith('LOCK TABLE '))).toHaveLength(1)
  })

  it.each(['42P01', '42501', '42703', '40P01', '57014', ''])('other SQL failures propagate as unavailable, not optional %s', async errorCode => {
    const { trx, state } = fixture()
    state.failAt = 'LOCK TABLE '
    state.errorCode = errorCode
    await expect(captureAutomationRecordSchema(trx, SHEET, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_UNAVAILABLE')
  })

  it('does not report successful optional capture if rollback itself fails', async () => {
    const { trx, state } = fixture()
    state.failAt = 'LOCK TABLE '
    state.rollbackFails = true
    await expect(captureAutomationRecordSchema(trx, SHEET, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_UNAVAILABLE')
  })

  it.each(['live', 'exists', 'epoch'] as const)('absent/dead metadata never manufactures evidence (%s)', async key => {
    const { trx, state } = fixture()
    state[key] = false
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    state[key] = true
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBeNull()
  })

  it('rejects malformed nonces rather than signing them as available', async () => {
    const { trx, state } = fixture()
    state.revision = 'not-a-database-nonce'
    await expect(captureAutomationRecordSchema(trx, SHEET, ON)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_UNAVAILABLE')
  })

  it('rejects structural copies, another sheet, and another handle sharing the same query', async () => {
    const { trx } = fixture()
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    await expect(resolveAutomationRecordSchemaRevision(trx, SHEET, { ...captured } as AutomationRecordSchemaToken)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
    await expect(resolveAutomationRecordSchemaRevision(trx, 'other-sheet', captured)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
    await expect(resolveAutomationRecordSchemaRevision({ ...trx }, SHEET, captured)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
  })

  it.each([false, true])('rejects reuse across xid even for an unavailable token (%s)', async busy => {
    const { trx, state } = fixture()
    if (busy) state.failAt = 'LOCK TABLE '
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    state.failAt = ''
    state.xid = '124'
    await expect(resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).rejects.toThrow('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
  })

  it('own-transaction epoch change cannot silently replace the pre-DML nonce', async () => {
    const { trx, state } = fixture()
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    state.revision = NEXT
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBeNull()
  })

  it('lost source table fences do not allow a nonce-only proof even if contents are unchanged', async () => {
    const { trx, state } = fixture()
    const captured = await captureAutomationRecordSchema(trx, SHEET, ON)
    state.held = false
    expect(await resolveAutomationRecordSchemaRevision(trx, SHEET, captured)).toBeNull()
  })
})
