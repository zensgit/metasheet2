/**
 * A save of an integration whose resulting status is active (PUT /integrations/:integrationId), from the
 * route down to the statements, without a database: the database module is replaced by a scripted
 * connection that records every statement.
 *
 * Pinned here: a row that changed under the save answers one and the same 409, byte for byte, whichever
 * way the change is noticed:
 *  - the gate reads the row, under its lock, in another organisation than the one the save read first
 *    (the transaction ends before the organisation lock is taken);
 *  - the row is gone when the gate locks it (the statement then matches no row);
 *  - the row no longer carries the status the gate read under its lock (the statement matches no row);
 *  - with the switch off, the single statement matches no row.
 * Also pinned: the statement and its parameters in each mode, computed before the gate is entered.
 *
 * What PostgreSQL does with these statements is pinned by
 * tests/integration/directory-pull-source-gate.db.test.ts.
 */
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))
const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))

import { Logger } from '../../src/core/logger'
import { APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, directoryOrgLockSql } from '../../src/directory/pull-source-rule'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

const SWITCH = 'APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED'
const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111'
const ORG_LOCK = directoryOrgLockSql('$1')
const CONFLICT = {
  ok: false,
  error: { code: 'DIRECTORY_UPDATE_FAILED', message: 'Directory configuration changed; reload before saving', details: undefined },
}

const isRowLock = (sql: string): boolean => /^SELECT org_id, status\s+FROM directory_integrations\s+WHERE id = \$1 AND provider = \$2\s+FOR UPDATE$/.test(sql)
const isSave = (sql: string): boolean => /^UPDATE directory_integrations\s+SET name = \$2,/.test(sql)
const GUARDED_WHERE = 'WHERE id = $1 AND config IS NOT DISTINCT FROM $10::jsonb AND corp_id = $11 AND status = $12\n'
const PLAIN_WHERE = 'WHERE id = $1 AND config IS NOT DISTINCT FROM $10::jsonb AND corp_id = $11\n'

/** The row the save reads first, before any transaction. */
function integrationRow(status: string) {
  return {
    id: INTEGRATION_ID,
    org_id: 'org-1',
    provider: 'dingtalk',
    name: 'Existing Integration',
    status,
    corp_id: 'corpA',
    config: { appKey: 'app-key-1', appSecret: '', rootDepartmentId: '1' },
    sync_enabled: false,
    schedule_cron: null,
    schedule_timezone: null,
    default_deprovision_policy: 'mark_inactive',
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

type Rows = Array<Record<string, unknown>>
type Statement = { sql: string; params: unknown[] | undefined }

/** The statements of the gate transaction, answered by `script` (no rows by default). */
function scriptedTransaction(script: (sql: string) => Rows | undefined = () => undefined): Statement[] {
  const statements: Statement[] = []
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params })
      return { rows: script(sql) ?? [] }
    },
  }
  pgMocks.transaction.mockImplementation(async (handler: (c: typeof client) => Promise<unknown>) => handler(client))
  return statements
}

/** The pool: the save's first read answers `row`; a save statement on the pool matches no row. */
function scriptedPool(row: Record<string, unknown>): Statement[] {
  const statements: Statement[] = []
  pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params })
    if (isSave(sql)) return { rows: [] }
    return { rows: [row] }
  })
  return statements
}

interface StubResponse {
  statusCode: number
  body: unknown
  status(code: number): StubResponse
  json(payload: unknown): StubResponse
}

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }> }
}

async function saveViaRoute(body: Record<string, unknown>): Promise<StubResponse> {
  const router = adminDirectoryRouter() as unknown as { stack: RouteLayer[] }
  const layer = router.stack.find((entry) => entry.route?.path === '/integrations/:integrationId' && entry.route?.methods?.put)
  if (!layer?.route) throw new Error('PUT /integrations/:integrationId not found')
  const res: StubResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  const req = {
    method: 'PUT',
    params: { integrationId: INTEGRATION_ID },
    query: {},
    body,
    // The legacy admin claim short-circuits the platform-admin RBAC read.
    user: { id: 'admin-7', role: 'admin' },
  } as unknown as Request
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res as unknown as Response, (err?: unknown) => {
    if (err) throw err
  })
  return res
}

const SAVE = { name: 'Existing Integration', corpId: 'corpA', appKey: 'app-key-1', appSecret: 'super-secret', status: 'active' }

describe('a save that turns out to act on a changed row answers the same 409 in every mode', () => {
  let saved: string | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    saved = process.env[SWITCH]
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    auditMocks.auditLog.mockReset()
    auditMocks.auditLog.mockResolvedValue(undefined)
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH]
    else process.env[SWITCH] = saved
    warnSpy.mockRestore()
  })

  it('switch on, the row read under its lock in another organisation: 409, the transaction ends before the organisation lock, nothing is written or audited', async () => {
    process.env[SWITCH] = 'true'
    const pool = scriptedPool(integrationRow('paused'))
    const gate = scriptedTransaction((sql) => (isRowLock(sql) ? [{ org_id: 'org-2', status: 'paused' }] : undefined))
    const res = await saveViaRoute(SAVE)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(CONFLICT)
    expect(gate).toHaveLength(4)
    expect(isRowLock(gate[3].sql)).toBe(true)
    expect(gate[3].params).toEqual([INTEGRATION_ID, 'dingtalk'])
    expect(gate.map((statement) => statement.sql)).not.toContain(ORG_LOCK)
    expect(gate.some((statement) => isSave(statement.sql))).toBe(false)
    expect(pool.some((statement) => isSave(statement.sql))).toBe(false)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('switch on, the row gone when the gate locks it: the statement is guarded by a null status, matches no row, 409', async () => {
    process.env[SWITCH] = 'true'
    scriptedPool(integrationRow('paused'))
    const gate = scriptedTransaction()
    const res = await saveViaRoute(SAVE)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(CONFLICT)
    // No row, so no transition to judge: the organisation lock is taken, the check is skipped, the save runs.
    const texts = gate.map((statement) => statement.sql)
    expect(texts.indexOf(ORG_LOCK)).toBe(4)
    expect(texts).not.toContain(APPROVAL_ROUTING_POLICY_EXISTS_SQL)
    const save = gate[5]
    expect(isSave(save.sql)).toBe(true)
    expect(save.sql).toContain(GUARDED_WHERE)
    expect(save.params).toHaveLength(12)
    expect(save.params?.[11]).toBeNull()
    expect(gate).toHaveLength(6)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('switch on, the row no longer carrying the status read under its lock: the statement matches no row, 409', async () => {
    process.env[SWITCH] = 'true'
    scriptedPool(integrationRow('paused'))
    const gate = scriptedTransaction((sql) => {
      if (isRowLock(sql)) return [{ org_id: 'org-1', status: 'paused' }]
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
      return undefined
    })
    const res = await saveViaRoute(SAVE)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(CONFLICT)
    const texts = gate.map((statement) => statement.sql)
    expect(isRowLock(texts[3])).toBe(true)
    expect(texts.slice(4, 7)).toEqual([ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL])
    const save = gate[7]
    expect(isSave(save.sql)).toBe(true)
    expect(save.sql).toContain(GUARDED_WHERE)
    expect(save.params).toHaveLength(12)
    // The twelfth parameter is the status the gate read under the row lock.
    expect(save.params?.[11]).toBe('paused')
    expect(save.params?.slice(0, 4)).toEqual([INTEGRATION_ID, 'Existing Integration', 'active', 'corpA'])
    expect(gate).toHaveLength(8)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('switch off: the single statement it always was, on the pool, matching no row: 409', async () => {
    for (const value of [undefined, 'false']) {
      if (value === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = value
      const pool = scriptedPool(integrationRow('paused'))
      const res = await saveViaRoute(SAVE)
      expect(res.statusCode, String(value)).toBe(409)
      expect(res.body).toEqual(CONFLICT)
      expect(pgMocks.transaction).not.toHaveBeenCalled()
      const saves = pool.filter((statement) => isSave(statement.sql))
      expect(saves).toHaveLength(1)
      expect(saves[0].sql).toContain(PLAIN_WHERE)
      expect(saves[0].sql).not.toContain('$12')
      expect(saves[0].params).toHaveLength(11)
    }
  })

  it('a save to a status other than active is the single statement whatever the switch says', async () => {
    process.env[SWITCH] = 'true'
    const pool = scriptedPool(integrationRow('active'))
    const res = await saveViaRoute({ ...SAVE, status: 'paused' })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(CONFLICT)
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    const saves = pool.filter((statement) => isSave(statement.sql))
    expect(saves).toHaveLength(1)
    expect(saves[0].sql).toContain(PLAIN_WHERE)
    expect(saves[0].params).toHaveLength(11)
  })

  it('the two texts of the statement differ by the status guard and nothing else, and the first eleven parameters are the same', async () => {
    process.env[SWITCH] = 'true'
    scriptedPool(integrationRow('paused'))
    const gate = scriptedTransaction((sql) => (isRowLock(sql) ? [{ org_id: 'org-1', status: 'active' }] : undefined))
    await saveViaRoute(SAVE)
    const guarded = gate.find((statement) => isSave(statement.sql))!
    delete process.env[SWITCH]
    const pool = scriptedPool(integrationRow('paused'))
    await saveViaRoute(SAVE)
    const plain = pool.find((statement) => isSave(statement.sql))!
    expect(guarded.sql.replace(' AND status = $12', '')).toBe(plain.sql)
    // The fifth parameter is the configuration, whose stored secret is encrypted afresh on every save.
    const withoutSecret = (params: unknown[] | undefined) =>
      (params ?? []).slice(0, 11).map((value, index) => (index === 4 ? { ...JSON.parse(String(value)), appSecret: '<stored>' } : value))
    expect(withoutSecret(guarded.params)).toEqual(withoutSecret(plain.params))
    expect(plain.params).toHaveLength(11)
    expect(guarded.params?.[11]).toBe('active')
  })
})
