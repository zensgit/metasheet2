import { describe, expect, it } from 'vitest'
import { IDENTITY_FENCE_TABLES, observeNotificationQueries } from '../utils/notification-lock-evidence'

describe('notification lock evidence stop rule', () => {
  it.each(['SHARE', 'KEY SHARE', 'NO KEY UPDATE', 'UPDATE'])('stops after an explicit users FOR %s', async mode => {
    const observer = observeNotificationQueries(async () => ({ rows: [{}] }), new Set(), 'background')
    await observer.query(`SELECT id FROM public.users FOR ${mode}`)
    await expect(observer.query('UPDATE directory_integrations SET name=name')).rejects.toMatchObject({
      code: 'N78_USER_LOCK_BEFORE_FENCE_WRITE', location: 'background:statement-2', table: 'directory_integrations',
    })
  })
  it.each(IDENTITY_FENCE_TABLES)('stops %s writes after a users FK child write', async table => {
    const observer = observeNotificationQueries(async () => ({ rows: [] }), new Set(['synthetic_child']), 'scan')
    await observer.query('INSERT INTO synthetic_child(user_id) VALUES ($1)', ['synthetic'])
    await expect(observer.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: 'N78_USER_LOCK_BEFORE_FENCE_WRITE', table })
    expect(observer.violations).toEqual([{ location: 'scan:statement-2', table, source: 'scan' }])
    expect(observer.statements).toHaveLength(1)
  })
  it('forwards exact SQL and values and retains only digests and fixed codes', async () => {
    const calls: unknown[] = []
    const observer = observeNotificationQueries(async (sql, params) => { calls.push([sql, params]); return { rows: [] } }, new Set(), 'background')
    await observer.query('SELECT id FROM users WHERE id=$1 FOR SHARE', ['private-value'])
    await observer.query('UPDATE directory_integrations SET name=name')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['SELECT id FROM users WHERE id=$1 FOR SHARE', ['private-value']])
    expect(JSON.stringify(observer)).not.toContain('private-value')
    expect(observer.statements.every(row => row.code === 'OK' && row.elapsedMs >= 0)).toBe(true)
  })
})
