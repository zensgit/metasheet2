/**
 * A statement_timeout (57014) inside the repair lock phase is "still busy" (REPAIR_LOCK_BUSY); a 57014 on a
 * later statement is not mapped by the module and reaches the CLI as REPAIR_STATEMENT_TIMEOUT. Stubbed
 * transaction client: a real 57014 needs a 30 s cumulative lock wait, which the real-DB suite does not stage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: db.query, transaction: db.transaction, pool: null }))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readDingTalkOauthConfig: () => ({
    corpId: 'synthetic-corp',
    clientId: 'synthetic-current-app',
    clientSecret: 'unused',
    redirectUri: 'https://example.test/callback',
  }),
}))
vi.mock('../../src/security/encrypted-secrets', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getEncryptionMaterialIssues: () => [],
}))

import { classifyRepairFailure } from '../../src/auth/dingtalk-identity-repair-cli'
import {
  releaseDingTalkRepair,
  rollbackDingTalkRepair,
} from '../../src/auth/dingtalk-identity-repair'

const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })

/** Records every statement; `failOn` decides which one the server cancels. */
function fakeClient(failOn: (sql: string, afterLockTable: boolean) => boolean) {
  const seen: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      const afterLockTable = seen.some((s) => s.startsWith('LOCK TABLE '))
      seen.push(sql)
      if (failOn(sql, afterLockTable)) throw statementTimeout()
      if (sql.startsWith('SELECT user_id FROM dingtalk_login_repairs')) return { rows: [{ user_id: 'synthetic-user' }] }
      if (sql.includes('SELECT DISTINCT hashtextextended')) return { rows: [{ key: '-1' }, { key: '1' }] }
      return { rows: [] }
    }),
  }
  return { client, seen }
}

const run = { rollback: rollbackDingTalkRepair, release: releaseDingTalkRepair }

describe('57014 classification around the repair lock phase', () => {
  beforeEach(() => {
    db.transaction.mockReset()
  })

  it.each(['rollback', 'release'] as const)('%s: a 57014 on the core-table LOCK TABLE is REPAIR_LOCK_BUSY', async (action) => {
    const { client, seen } = fakeClient((sql) => sql.startsWith('LOCK TABLE'))
    db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
    const pending = run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password')
    await expect(pending).rejects.toThrow(/^REPAIR_LOCK_BUSY$/)
    const error = await pending.catch((e) => e)
    expect(classifyRepairFailure(error)).toEqual({ code: 'REPAIR_LOCK_BUSY', exit: 75 })
    // Nothing after the lock phase ran.
    expect(seen.at(-1)).toMatch(/^LOCK TABLE /)
  })

  it.each(['rollback', 'release'] as const)('%s: a 57014 on the advisory mutex is REPAIR_LOCK_BUSY too', async (action) => {
    const { client } = fakeClient((sql) => sql.includes('pg_advisory_xact_lock'))
    db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
    await expect(
      run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password'),
    ).rejects.toThrow(/^REPAIR_LOCK_BUSY$/)
  })

  it.each(['rollback', 'release'] as const)('%s: a 57014 on a user admission key is REPAIR_LOCK_BUSY too', async (action) => {
    const { client, seen } = fakeClient(sql => sql === 'SELECT pg_advisory_xact_lock($1::bigint)')
    db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
    await expect(
      run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password'),
    ).rejects.toThrow(/^REPAIR_LOCK_BUSY$/)
    expect(seen.some(sql => sql.includes('SELECT DISTINCT hashtextextended'))).toBe(true)
    expect(seen.some(sql => /FOR UPDATE/.test(sql))).toBe(false)
  })

  it.each(['rollback', 'release'] as const)(
    '%s: a 57014 on the first statement after the lock phase is not mapped by the module',
    async (action) => {
      // After LOCK TABLE, user admission keys and row locks are still inside the lock phase.
      const userLockPhase = /SELECT DISTINCT hashtextextended|pg_advisory_xact_lock\(\$1::bigint\)|FOR UPDATE/
      const { client, seen } = fakeClient((sql, afterLockTable) => afterLockTable && !userLockPhase.test(sql))
      db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
      const error = await run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password').catch(
        (e) => e,
      )
      expect(error).toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' })
      expect(classifyRepairFailure(error)).toEqual({ code: 'REPAIR_STATEMENT_TIMEOUT', exit: 1 })
      // The lock phase completed (advisory mutex, LOCK TABLE, user keys and row locks) before cancellation.
      expect(seen.some((s) => s.startsWith('LOCK TABLE '))).toBe(true)
      expect(seen.filter(s => s === 'SELECT pg_advisory_xact_lock($1::bigint)')).toHaveLength(2)
      expect(seen.filter((s) => /FOR UPDATE/.test(s)).length).toBeGreaterThan(0)
      expect(seen.at(-1)).not.toMatch(/FOR UPDATE|^LOCK TABLE|pg_advisory_xact_lock/)
    },
  )
})
