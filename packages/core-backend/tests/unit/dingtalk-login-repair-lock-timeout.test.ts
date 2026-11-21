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
import { deriveUserAccessLockKey, lockUserAccessExclusive, lockUserAccessShared, USER_ACCESS_LOCK_NAMESPACE } from '../../src/auth/user-access-lock'
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
      return { rows: [] }
    }),
  }
  return { client, seen }
}

const run = { rollback: rollbackDingTalkRepair, release: releaseDingTalkRepair }

describe('user admission key protocol', () => {
  it('pins raw UTF-8 derivation to a signed int4', () => {
    expect(deriveUserAccessLockKey('synthetic-user')).toBe(497012073)
    expect(deriveUserAccessLockKey('用户')).toBe(-1903445409)
    expect(deriveUserAccessLockKey('synthetic-user ')).not.toBe(deriveUserAccessLockKey('synthetic-user'))
  })

  it('shares the same namespace and user key, with every distinct writer key before any row', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ previous: '0' }] })) }
    await lockUserAccessShared(client, 'synthetic-user')
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock_shared($1::int4, $2::int4)', [USER_ACCESS_LOCK_NAMESPACE, 497012073])
    client.query.mockClear()
    await lockUserAccessExclusive(client, ['synthetic-actor', '用户', 'synthetic-user', 'synthetic-user'])
    expect(client.query.mock.calls).toEqual([
      ['SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [USER_ACCESS_LOCK_NAMESPACE, -1903445409]],
      ['SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [USER_ACCESS_LOCK_NAMESPACE, 497012073]],
      ['SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [USER_ACCESS_LOCK_NAMESPACE, 889995239]],
      ['SELECT id FROM users WHERE id = $1 FOR UPDATE', ['synthetic-actor']],
      ['SELECT id FROM users WHERE id = $1 FOR UPDATE', ['synthetic-user']],
      ['SELECT id FROM users WHERE id = $1 FOR UPDATE', ['用户']],
    ])
  })
})

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
    const { client } = fakeClient((sql) => sql.includes("hashtext('directory:identity-maintenance')"))
    db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
    await expect(
      run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password'),
    ).rejects.toThrow(/^REPAIR_LOCK_BUSY$/)
  })

  it.each(['rollback', 'release'] as const)('%s: a 57014 on a user admission key is REPAIR_LOCK_BUSY too', async (action) => {
    const { client, seen } = fakeClient(sql => sql === 'SELECT pg_advisory_xact_lock($1::int4, $2::int4)')
    db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
    await expect(
      run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password'),
    ).rejects.toThrow(/^REPAIR_LOCK_BUSY$/)
    expect(seen.some(sql => sql.startsWith('LOCK TABLE'))).toBe(false)
    expect(seen.some(sql => /FOR UPDATE/.test(sql))).toBe(false)
  })

  it.each(['rollback', 'release'] as const)(
    '%s: a 57014 on the first statement after the lock phase is not mapped by the module',
    async (action) => {
      const { client, seen } = fakeClient((_sql, afterLockTable) => afterLockTable)
      db.transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client))
      const error = await run[action]('synthetic-id', 'synthetic-actor', 'synthetic-digest', action, 'synthetic-password').catch(
        (e) => e,
      )
      expect(error).toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' })
      expect(classifyRepairFailure(error)).toEqual({ code: 'REPAIR_STATEMENT_TIMEOUT', exit: 1 })
      // All user keys precede all rows, then the mutex and table fences, then business work.
      expect(seen.some((s) => s.startsWith('LOCK TABLE '))).toBe(true)
      const keyPositions = seen.flatMap((s, i) => s === 'SELECT pg_advisory_xact_lock($1::int4, $2::int4)' ? [i] : [])
      const rowPositions = seen.flatMap((s, i) => /FOR UPDATE/.test(s) ? [i] : [])
      expect(keyPositions).toHaveLength(2)
      expect(Math.max(...keyPositions)).toBeLessThan(Math.min(...rowPositions))
      expect(Math.max(...rowPositions)).toBeLessThan(seen.findIndex(s => s.startsWith('LOCK TABLE ')))
      expect(seen.filter((s) => /FOR UPDATE/.test(s)).length).toBeGreaterThan(0)
      expect(seen.at(-1)).not.toMatch(/FOR UPDATE|^LOCK TABLE|pg_advisory_xact_lock/)
    },
  )
})
