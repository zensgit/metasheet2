import { describe, expect, it } from 'vitest'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import { USER_LOCK_SQL, mapBusy, sortedUserLocks, withUserLocks, type NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { Db } from '../../src/notifications/recipient-resolver'

function recorder() {
  const log: Array<{ sql: string; params: unknown[] | undefined }> = []
  const client: Db = { query: async (sql, params) => { log.push({ sql, params }); return { rows: [] } } }
  const deps: NotificationDbDeps = { db: client, transaction: async (fn) => fn(client) }
  return { log, deps }
}

describe('user locks', () => {
  it('are taken in ascending (organization, user) order, once per user', () => {
    const keys = [
      { orgId: 'b', userId: 'x' },
      { orgId: 'a', userId: 'z' },
      { orgId: 'a', userId: 'y' },
      { orgId: 'a', userId: 'z' },
    ]
    expect(sortedUserLocks(keys)).toEqual([
      { orgId: 'a', userId: 'y' },
      { orgId: 'a', userId: 'z' },
      { orgId: 'b', userId: 'x' },
    ])
    expect(sortedUserLocks([...keys].reverse())).toEqual(sortedUserLocks(keys))
  })

  it('do not confuse two pairs whose joined text would be equal', () => {
    expect(sortedUserLocks([{ orgId: 'a:b', userId: 'c' }, { orgId: 'a', userId: 'b:c' }])).toHaveLength(2)
  })

  it('hash the organization and the user as two arguments', () => {
    expect(USER_LOCK_SQL).toBe(`SELECT pg_advisory_xact_lock(hashtext('notif-user:' || $1::text), hashtext($2::text))`)
  })

  it('run, in a transaction, after the isolation level and the wait bound and before the work, in order', async () => {
    const { log, deps } = recorder()
    const out = await withUserLocks(deps, [{ orgId: 'o', userId: 'u2' }, { orgId: 'o', userId: 'u1' }], async (client) => {
      await client.query('WORK')
      return 7
    })
    expect(out).toBe(7)
    expect(log.map((entry) => entry.sql)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      `SET LOCAL lock_timeout = '5s'`,
      USER_LOCK_SQL,
      USER_LOCK_SQL,
      'WORK',
    ])
    expect(log[2].params).toEqual(['o', 'u1'])
    expect(log[3].params).toEqual(['o', 'u2'])
  })
})

describe('a failure that is worth retrying', () => {
  it('maps a lock wait, a deadlock, a serialization failure and a cancelled statement to a 503', () => {
    for (const code of ['55P03', '40P01', '40001', '57014']) {
      const mapped = mapBusy(Object.assign(new Error('x'), { code })) as NotificationHttpError
      expect([mapped.status, mapped.code, mapped.details]).toEqual([503, 'NOTIFICATION_BUSY', undefined])
    }
  })

  it('passes everything else through, including a service error', () => {
    const own = new NotificationHttpError(409, 'ADDRESS_ALREADY_BOUND')
    expect(mapBusy(own)).toBe(own)
    const other = Object.assign(new Error('x'), { code: '23505' })
    expect(mapBusy(other)).toBe(other)
    expect(mapBusy('text')).toBe('text')
  })
})
