import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyRecycleMove,
  applyRecyclePurge,
  applyRecycleRestore,
  AuditIdentityScrubError,
  auditCreatedAtMatch,
  auditResourceIsUserSubject,
  auditRowMatchesSubject,
  auditSubjectMatchSql,
  listDueRecycleUserIds,
  redactAuditRow,
  resolveUserRecycleRetentionDays,
  scrubPurgedUserIdentity,
  USER_TOMBSTONE_NAME,
  type PurgeAuditRow,
  type RecycleClient,
} from '../../src/admin/user-recycle'

type UserRow = {
  id: string
  email: string | null
  name: string | null
  is_active: boolean
  is_admin: boolean
  role: string
  deleted_at: string | null
  deleted_by: string | null
  purge_after: string | null
  purged_at: string | null
  active_before_delete: boolean | null
  department: string | null
}

function clientFor(users: UserRow[], extras: { aliases?: string[]; identities?: string[] } = {}): RecycleClient & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    query: async (statement, params = []) => {
      sql.push(statement)
      const id = String(params[0] ?? '')
      const user = users.find((row) => row.id === id)
      if (statement.includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (statement.includes('is_sign_in_admin')) {
        const signIn = Boolean(user && user.is_active && !user.deleted_at && !user.purged_at && (user.is_admin || user.role === 'admin'))
        return { rows: [{ is_sign_in_admin: signIn }] }
      }
      if (statement.includes('COUNT(*)')) {
        const liveAdmins = users.filter((row) => row.id !== id && row.is_active && !row.deleted_at && !row.purged_at && (row.is_admin || row.role === 'admin'))
        return { rows: [{ c: liveAdmins.length }] }
      }
      if (statement.includes('to_regclass')) return { rows: [{ rel: String(params[0] ?? '') }] }
      if (statement.includes('FOR UPDATE') && statement.includes('FROM users')) {
        if (!user) return { rows: [] }
        return {
          rows: [{
            ...user,
            deletion_version: user.deleted_at,
            is_platform_admin: user.is_admin || user.role === 'admin',
          } as unknown as Record<string, unknown>],
        }
      }
      if (statement.includes('SET deleted_at')) {
        if (!user || user.deleted_at || user.purged_at) return { rows: [] }
        user.deleted_at = String(params[1])
        user.deleted_by = String(params[2])
        user.active_before_delete = user.is_active
        user.is_active = false
        user.purge_after = 'due'
        return { rows: [{ id: user.id, email: user.email }] }
      }
      if (statement.includes('SET is_active = COALESCE(active_before_delete')) {
        if (!user || !user.deleted_at || user.purged_at) return { rows: [] }
        user.is_active = user.active_before_delete ?? false
        user.deleted_at = null
        user.deleted_by = null
        user.purge_after = null
        user.active_before_delete = null
        return { rows: [{ id: user.id, email: user.email }] }
      }
      if (statement.includes('SET email = NULL')) {
        if (!user || !user.deleted_at || user.purged_at) return { rows: [] }
        expect(params[1]).toBe(USER_TOMBSTONE_NAME)
        user.email = null
        user.name = USER_TOMBSTONE_NAME
        user.department = null
        user.purged_at = String(params[3])
        user.is_active = false
        return { rows: [{ id: user.id }] }
      }
      if (statement.includes('DELETE FROM user_login_aliases') && extras.aliases) extras.aliases.length = 0
      if (statement.includes('DELETE FROM user_external_identities') && extras.identities) extras.identities.length = 0
      if (statement.includes('purge_after <=')) {
        return {
          rows: users
            .filter((row) => row.deleted_at && !row.purged_at && row.purge_after && row.purge_after <= String(params[0]))
            .map((row) => ({ id: row.id, deleted_at: row.deleted_at })),
        }
      }
      return { rows: [] }
    },
  }
}

describe('user recycle bin', () => {
  it('defaults retention to 30 days and clamps configuration', () => {
    expect(resolveUserRecycleRetentionDays({})).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '0' })).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: 'nope' })).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '14' })).toBe(14)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '99999' })).toBe(3650)
  })

  it('soft-deletes into the bin and refuses self-delete and the last platform admin', async () => {
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: true, is_admin: false, role: 'user', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: '装配' },
      { id: 'admin-1', email: 'admin@example.com', name: '管理员', is_active: true, is_admin: true, role: 'admin', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: null },
    ]
    const db = clientFor(users)
    const moved = await applyRecycleMove(db, { userId: 'user-lin', actorId: 'admin-1', retentionDays: 30, index: 0, now: new Date('2026-10-01T00:00:00.000Z') })
    expect(moved).toMatchObject({ ok: true, code: null, message: '已移入回收站' })
    expect(users[0]?.is_active).toBe(false)
    expect(users[0]?.deleted_by).toBe('admin-1')
    expect(users[0]?.active_before_delete).toBe(true)
    expect(db.sql.some((statement) => /DELETE\s+FROM\s+users/i.test(statement))).toBe(false)

    const self = await applyRecycleMove(db, { userId: 'admin-1', actorId: 'admin-1', retentionDays: 30, index: 1 })
    expect(self.code).toBe('SELF_DELETE_FORBIDDEN')

    const lastAdmin = await applyRecycleMove(db, { userId: 'admin-1', actorId: 'user-lin', retentionDays: 30, index: 2 })
    expect(lastAdmin.code).toBe('LAST_PLATFORM_ADMIN')
    expect(users[1]?.deleted_at).toBeNull()
  })

  it('restores the previous active flag and refuses a purged account', async () => {
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-01T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-10-31T00:00:00.000Z', purged_at: null, active_before_delete: false, department: '装配' },
    ]
    const db = clientFor(users)
    const restored = await applyRecycleRestore(db, { userId: 'user-lin', actorId: 'admin-1', index: 0 })
    expect(restored.ok).toBe(true)
    expect(users[0]?.deleted_at).toBeNull()
    expect(users[0]?.is_active).toBe(false)

    users[0]!.deleted_at = '2026-10-01T00:00:00.000Z'
    users[0]!.purged_at = '2026-11-01T00:00:00.000Z'
    const purged = await applyRecycleRestore(db, { userId: 'user-lin', actorId: 'admin-1', index: 1 })
    expect(purged.code).toBe('ALREADY_PURGED')
  })

  it('anonymizes a due account and leaves the user row in place', async () => {
    const aliases = ['lin@example.com']
    const identities = ['ding-1']
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-01T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-10-31T00:00:00.000Z', purged_at: null, active_before_delete: true, department: '装配' },
      { id: 'user-next', email: 'next@example.com', name: '下一位', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-20T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-11-20T00:00:00.000Z', purged_at: null, active_before_delete: true, department: null },
    ]
    const db = clientFor(users, { aliases, identities })
    const due = await listDueRecycleUserIds(db, new Date('2026-10-31T12:00:00.000Z'))
    expect(due).toEqual(['user-lin'])

    const purged = await applyRecyclePurge(db, {
      userId: 'user-lin',
      actorId: 'system:user-recycle',
      index: 0,
      now: new Date('2026-10-31T12:00:00.000Z'),
      passwordHash: 'unusable',
    })
    expect(purged.ok).toBe(true)
    expect(users[0]).toMatchObject({ email: null, name: USER_TOMBSTONE_NAME, department: null, purged_at: '2026-10-31T12:00:00.000Z' })
    expect(users[0]?.deleted_at).toBeTruthy()
    expect(aliases).toEqual([])
    expect(identities).toEqual([])
    expect(db.sql.some((statement) => /DELETE\s+FROM\s+users\b/i.test(statement))).toBe(false)
    expect(db.sql.some((statement) => statement.includes('DELETE FROM user_login_aliases'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('hire_date = NULL'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('cumulative_service_start_date = NULL'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('last_login_at = NULL'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('UPDATE directory_accounts'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes("THEN 'unlinked'"))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('user_login_alias_collision_report'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('FROM audit_logs') && statement.includes('split_part(resource_id'))).toBe(true)
    expect(db.sql.some((statement) => statement.includes('position('))).toBe(false)
    expect(db.sql.some((statement) => statement.includes("link_status = 'linked'"))).toBe(true)
  })

  it('declares recycle columns in the migration', () => {
    const migration = readFileSync(resolve(__dirname, '../../src/db/migrations/zzzz20261031120000_add_users_recycle_bin.ts'), 'utf8')
    for (const column of ['deleted_at', 'deleted_by', 'purge_after', 'purged_at', 'purged_by', 'active_before_delete']) {
      expect(migration).toContain(column)
    }
    expect(migration).not.toContain('DROP TABLE users')
    expect(migration).toContain('active_before_delete')
    expect(migration).toContain('purged_at IS NULL')
  })

  it('does not treat an inactive administrator as the last sign-in admin', async () => {
    const users: UserRow[] = [
      { id: 'admin-inactive', email: 'old@example.com', name: '旧管理员', is_active: false, is_admin: true, role: 'admin', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: null },
      { id: 'admin-live', email: 'live@example.com', name: '在任', is_active: true, is_admin: true, role: 'admin', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: null },
    ]
    const db = clientFor(users)
    const moved = await applyRecycleMove(db, { userId: 'admin-inactive', actorId: 'admin-live', retentionDays: 30, index: 0 })
    expect(moved.ok).toBe(true)
    const blocked = await applyRecycleMove(db, { userId: 'admin-live', actorId: 'admin-inactive', retentionDays: 30, index: 1 })
    expect(blocked.code).toBe('LAST_PLATFORM_ADMIN')
  })

  it('redacts audit fields by subject id and leaves colliding keys and other users unchanged', async () => {
    const subjectId = 'user-admin'
    const unrelated: PurgeAuditRow = {
      id: 9,
      created_at: '2026-10-01T00:00:00.000Z',
      resource_type: 'user',
      resource_id: 'user-other',
      resource_name: '其他同事',
      user_id: 77,
      user_email: 'other@example.com',
      user_name: '其他同事',
      action_details: {
        adminUserId: 'operator-1',
        outcome: 'updated',
        email: 'other@example.com',
        name: '其他同事',
      },
      request_body: { name: '其他同事', department: '仓储' },
    }
    const unrelatedSnapshot = JSON.stringify(unrelated)
    const subject: PurgeAuditRow = {
      id: 10,
      created_at: '2026-10-02T00:00:00.000Z',
      resource_type: 'user',
      resource_id: subjectId,
      resource_name: '管理员账号',
      user_id: 3,
      user_email: 'admin@example.com',
      user_name: '管理员账号',
      action_details: {
        adminUserId: 'operator-1',
        email: 'admin@example.com',
        username: 'admin',
        name: '管理员账号',
        colleague: { id: 'user-other', email: 'other@example.com', name: '其他同事' },
      },
      request_body: { email: 'admin@example.com', note: 'keep-me' },
    }
    const actorOnly: PurgeAuditRow = {
      id: 11,
      created_at: '2026-10-03T00:00:00.000Z',
      resource_type: 'user',
      resource_id: 'user-other',
      resource_name: '其他同事',
      user_id: subjectId,
      user_email: 'admin@example.com',
      user_name: '管理员账号',
      action_details: {
        adminUserId: 'operator-1',
        email: 'other@example.com',
        name: '其他同事',
      },
      request_body: { email: 'other@example.com' },
    }
    const sameIdRole: PurgeAuditRow = {
      id: 12,
      created_at: '2026-10-04T00:00:00.000Z',
      resource_type: 'role',
      resource_id: subjectId,
      resource_name: 'Warehouse lead',
      user_id: subjectId,
      user_email: 'admin@example.com',
      user_name: '管理员账号',
      action_details: { name: 'Warehouse lead', permissions: ['roles.read'] },
      request_body: { name: 'Warehouse lead' },
    }
    const roleGrant: PurgeAuditRow = {
      id: 13,
      created_at: '2026-10-05T00:00:00.000Z',
      resource_type: 'user-role',
      resource_id: `${subjectId}:role-1`,
      resource_name: '管理员账号',
      user_id: 3,
      user_email: 'admin@example.com',
      user_name: '管理员账号',
      action_details: { name: '管理员账号', email: 'admin@example.com', roleId: 'role-1' },
      request_body: { email: 'admin@example.com' },
    }
    const actorDetails = JSON.stringify(actorOnly.action_details)
    const actorBody = JSON.stringify(actorOnly.request_body)
    const roleDetails = JSON.stringify(sameIdRole.action_details)
    const roleBody = JSON.stringify(sameIdRole.request_body)
    const rows = [unrelated, subject, actorOnly, sameIdRole, roleGrant]
    expect(auditRowMatchesSubject(unrelated, subjectId)).toBe(false)
    expect(auditRowMatchesSubject(subject, subjectId)).toBe(true)
    expect(auditRowMatchesSubject(actorOnly, subjectId)).toBe(true)

    const client: RecycleClient = {
      query: async (statement, params = []) => {
        if (statement.includes('to_regclass')) {
          const name = String(params[0] ?? '')
          return { rows: [{ rel: name === 'audit_logs' ? 'audit_logs' : null }] }
        }
        if (statement.includes('FROM audit_logs') && statement.includes('split_part(resource_id')) {
          return { rows: rows.filter((row) => auditRowMatchesSubject(row, String(params[0]))).map((row) => ({ ...row })) }
        }
        if (statement.includes('UPDATE audit_logs')) {
          const id = params[0]
          const found = rows.find((row) => row.id === id)
          if (!found) return { rows: [], rowCount: 0 }
          if (statement.includes('::timestamptz') && String(params[1]).includes('GMT')) {
            return { rows: [], rowCount: 0 }
          }
          if (!statement.includes('action_details')) {
            expect(statement).not.toContain('request_body')
            expect(statement).toContain('user_id::text = $3')
            found.user_email = null
            found.user_name = null
            return { rows: [{ id: found.id }], rowCount: 1 }
          }
          found.action_details = JSON.parse(String(params[2]))
          found.request_body = JSON.parse(String(params[3]))
          found.user_email = params[4] == null ? null : String(params[4])
          found.user_name = params[5] == null ? null : String(params[5])
          found.resource_name = params[6] == null ? null : String(params[6])
          return { rows: [{ id: found.id }], rowCount: 1 }
        }
        return { rows: [] }
      },
    }
    await scrubPurgedUserIdentity(client, {
      userId: subjectId,
      email: 'admin@example.com',
      username: 'admin',
      mobile: null,
      at: '2026-11-01T00:00:00.000Z',
    })

    expect(JSON.stringify(unrelated)).toBe(unrelatedSnapshot)
    expect(redactAuditRow(subject, subjectId).action_details).toMatchObject({
      adminUserId: 'operator-1',
      email: null,
      username: null,
      name: USER_TOMBSTONE_NAME,
      colleague: { id: 'user-other', email: 'other@example.com', name: '其他同事' },
    })
    expect(subject.action_details).toMatchObject({
      adminUserId: 'operator-1',
      colleague: { id: 'user-other', email: 'other@example.com', name: '其他同事' },
    })
    expect(JSON.stringify(actorOnly.action_details)).toBe(actorDetails)
    expect(JSON.stringify(actorOnly.request_body)).toBe(actorBody)
    expect(actorOnly.user_email).toBeNull()
    expect(actorOnly.user_name).toBeNull()
    expect(actorOnly.resource_name).toBe('其他同事')
    expect(JSON.stringify(sameIdRole.action_details)).toBe(roleDetails)
    expect(JSON.stringify(sameIdRole.request_body)).toBe(roleBody)
    expect(sameIdRole.resource_name).toBe('Warehouse lead')
    expect(sameIdRole.user_email).toBeNull()
    expect(sameIdRole.user_name).toBeNull()
    expect(roleGrant.action_details).toMatchObject({
      name: USER_TOMBSTONE_NAME,
      email: null,
      roleId: 'role-1',
    })
    expect(roleGrant.resource_name).toBe(USER_TOMBSTONE_NAME)
  })

  it('matches a user subject by resource type and id shape', () => {
    const userId = 'user-admin'
    expect(auditResourceIsUserSubject('user', userId, userId)).toBe(true)
    expect(auditResourceIsUserSubject('user-password', userId, userId)).toBe(true)
    expect(auditResourceIsUserSubject('user-session', userId, userId)).toBe(true)
    expect(auditResourceIsUserSubject('user', `${userId}:extra`, userId)).toBe(false)
    expect(auditResourceIsUserSubject('user-role', `${userId}:role-1`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('user-role', userId, userId)).toBe(false)
    expect(auditResourceIsUserSubject('user-role', `${userId}:role-1:extra`, userId)).toBe(false)
    expect(auditResourceIsUserSubject('role', userId, userId)).toBe(false)
    expect(auditResourceIsUserSubject('user-batch', userId, userId)).toBe(false)
    expect(auditResourceIsUserSubject('user-invite', userId, userId)).toBe(false)
    expect(auditResourceIsUserSubject('platform-member-group', `group-1:${userId}`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('platform-member-group', `${userId}:someone`, userId)).toBe(false)
    expect(auditResourceIsUserSubject('delegated-admin-scope', `${userId}:ns`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('delegated-admin-scope', `${userId}:ns:dept`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('delegated-admin-group-scope', `${userId}:ns:group:g1`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('delegated-admin-group-scope', `${userId}:ns:other:g1`, userId)).toBe(false)
    expect(auditResourceIsUserSubject('delegated-admin-scope-template', `${userId}:ns:template:t1`, userId)).toBe(true)
    expect(auditResourceIsUserSubject('delegated-admin-scope-template', `template:${userId}:group:g1`, userId)).toBe(false)
    expect(auditResourceIsUserSubject('user-namespace-admission', `${userId}:attendance`, userId)).toBe(true)
    const sql = auditSubjectMatchSql()
    expect(sql).toContain("resource_type = 'user'")
    expect(sql).toContain("resource_type = 'user-role'")
    expect(sql).toContain('user_id::text = $1')
    expect(sql).not.toContain("resource_type = 'role'")
    expect(sql).not.toContain("resource_type = 'user-batch'")
    expect(sql).not.toContain("resource_type = 'user-invite'")
    const roleRow: PurgeAuditRow = {
      id: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      resource_type: 'role',
      resource_id: userId,
      resource_name: 'Warehouse lead',
      user_id: null,
      user_email: null,
      user_name: null,
      action_details: { name: 'Warehouse lead' },
      request_body: { name: 'Warehouse lead' },
    }
    expect(auditRowMatchesSubject(roleRow, userId)).toBe(false)
    expect(redactAuditRow(roleRow, userId).action_details).toEqual({ name: 'Warehouse lead' })
  })

  it('anonymizes confirmed directory links and only detaches pending guesses', async () => {
    const accounts = [
      { id: 'acct-linked', org: 'org-a', name: '林岚', email: 'lin@example.com', mobile: '13800000000' },
      { id: 'acct-pending', org: 'org-b', name: '林岚', email: 'lin@example.com', mobile: '13800000000' },
    ]
    const pendingSnapshot = JSON.stringify(accounts[1])
    const links = [
      { accountId: 'acct-linked', localUserId: 'user-lin' as string | null, status: 'linked' },
      { accountId: 'acct-pending', localUserId: 'user-lin' as string | null, status: 'pending' },
    ]
    const client: RecycleClient = {
      query: async (statement, params = []) => {
        const userId = String(params[0] ?? '')
        if (statement.includes('to_regclass')) {
          const name = String(params[0] ?? '')
          return { rows: [{ rel: name.startsWith('directory_') ? name : null }] }
        }
        if (statement.includes('UPDATE directory_accounts')) {
          if (!statement.includes("link_status = 'linked'")) throw new Error('directory anonymization must require a confirmed link')
          for (const link of links) {
            if (link.localUserId === userId && link.status === 'linked') {
              const account = accounts.find((item) => item.id === link.accountId)
              if (!account) continue
              account.name = USER_TOMBSTONE_NAME
              account.email = null
              account.mobile = null
            }
          }
          return { rows: [] }
        }
        if (statement.includes('UPDATE directory_account_links')) {
          for (const link of links) {
            if (link.localUserId !== userId) continue
            if (link.status === 'linked') link.status = 'unlinked'
            link.localUserId = null
          }
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
    await scrubPurgedUserIdentity(client, {
      userId: 'user-lin',
      email: 'lin@example.com',
      username: null,
      mobile: '13800000000',
      at: '2026-11-01T00:00:00.000Z',
    })
    expect(accounts[0]).toMatchObject({ name: USER_TOMBSTONE_NAME, email: null, mobile: null })
    expect(JSON.stringify(accounts[1])).toBe(pendingSnapshot)
    expect(links).toEqual([
      { accountId: 'acct-linked', localUserId: null, status: 'unlinked' },
      { accountId: 'acct-pending', localUserId: null, status: 'pending' },
    ])
  })

  it('redacts accountLabel and sibling identity labels on a create audit', async () => {
    const subjectId = 'qa-um-single'
    const rows = [{
      id: 177,
      created_at: '2026-11-04 05:31:00.123456+00',
      resource_type: 'user',
      resource_id: subjectId,
      resource_name: 'QA Single',
      user_id: '3',
      user_email: 'qa-um-single@example.test',
      user_name: 'QA Single',
      action_details: {
        email: 'qa-um-single@example.test',
        username: 'qa-um-single',
        mobile: '13800001111',
        accountLabel: 'qa-um-single@example.test',
        account_label: 'qa-um-single@example.test',
        loginName: 'qa-um-single',
        displayName: 'QA Single',
        phone: '13800001111',
        position: '装配',
        jobNumber: 'E-100',
        name: 'QA Single',
        roleId: 'user',
        adminUserId: 'operator-1',
        colleague: { id: 'user-other', accountLabel: 'other@example.test', displayName: '其他同事' },
      },
      request_body: { accountLabel: 'qa-um-single@example.test', note: 'keep-me' },
    }]
    const client: RecycleClient = {
      query: async (statement, params = []) => {
        if (statement.includes('to_regclass')) {
          const name = String(params[0] ?? '')
          return { rows: [{ rel: name === 'audit_logs' || name === 'audit_logs_archive' ? name : null }] }
        }
        if (statement.includes('FROM audit_logs')) {
          return { rows: rows.map((row) => ({ ...row, action_details: { ...row.action_details }, request_body: { ...row.request_body } })) }
        }
        if (statement.includes('UPDATE audit_logs')) {
          const found = rows.find((row) => row.id === params[0])
          if (!found) return { rows: [], rowCount: 0 }
          found.action_details = JSON.parse(String(params[2]))
          found.request_body = JSON.parse(String(params[3]))
          return { rows: [{ id: found.id }], rowCount: 1 }
        }
        return { rows: [] }
      },
    }
    await scrubPurgedUserIdentity(client, {
      userId: subjectId,
      email: 'qa-um-single@example.test',
      username: 'qa-um-single',
      mobile: '13800001111',
      at: '2026-11-04T05:31:00.000Z',
    })
    expect(rows[0]?.action_details).toMatchObject({
      email: null,
      username: null,
      mobile: null,
      accountLabel: null,
      account_label: null,
      loginName: null,
      displayName: USER_TOMBSTONE_NAME,
      phone: null,
      position: null,
      jobNumber: null,
      name: USER_TOMBSTONE_NAME,
      roleId: 'user',
      adminUserId: 'operator-1',
      colleague: { id: 'user-other', accountLabel: 'other@example.test', displayName: '其他同事' },
    })
    expect(rows[0]?.request_body).toEqual({ accountLabel: null, note: 'keep-me' })
  })

  it('matches audit rows by primary key text and refuses a JS Date string', () => {
    expect(auditCreatedAtMatch('2026-11-04 05:31:00.123456+00')).toEqual({
      whereSql: 'id = $1 AND created_at = $2::timestamptz',
      param: '2026-11-04 05:31:00.123456+00',
    })
    const instant = new Date('2026-11-04T05:31:00.123Z')
    expect(auditCreatedAtMatch(instant).whereSql).toContain("INTERVAL '1 millisecond'")
    expect(auditCreatedAtMatch(instant).param).toBe(instant.toISOString())
    expect(auditCreatedAtMatch(instant).param).not.toBe(String(instant))
    expect(() => auditCreatedAtMatch(String(instant))).toThrow(AuditIdentityScrubError)
  })

  it('fails the purge scrub when the audit update matches no row', async () => {
    const client: RecycleClient = {
      query: async (statement) => {
        if (statement.includes('to_regclass')) return { rows: [{ rel: 'audit_logs' }] }
        if (statement.includes('FROM audit_logs')) {
          return {
            rows: [{
              id: 10,
              created_at: '2026-11-04 05:31:00.123456+00',
              resource_type: 'user',
              resource_id: 'user-admin',
              resource_name: '管理员账号',
              user_id: '3',
              user_email: 'admin@example.com',
              user_name: '管理员账号',
              action_details: { email: 'admin@example.com' },
              request_body: null,
            }],
          }
        }
        if (statement.includes('UPDATE audit_logs')) return { rows: [], rowCount: 0 }
        return { rows: [] }
      },
    }
    await expect(scrubPurgedUserIdentity(client, {
      userId: 'user-admin',
      email: 'admin@example.com',
      username: null,
      mobile: null,
      at: '2026-11-01T00:00:00.000Z',
    })).rejects.toMatchObject({ name: 'AuditIdentityScrubError', code: 'AUDIT_ROW_NOT_UPDATED' })
  })

  it('updates a microsecond-truncated Date without sending Date.toString to Postgres', async () => {
    const instant = new Date('2026-11-04T05:31:00.123Z')
    const statements: string[] = []
    const paramsSeen: unknown[][] = []
    const client: RecycleClient = {
      query: async (statement, params = []) => {
        statements.push(statement)
        paramsSeen.push(params)
        if (statement.includes('to_regclass')) {
          return { rows: [{ rel: String(params[0]) === 'audit_logs' ? 'audit_logs' : null }] }
        }
        if (statement.includes('FROM audit_logs')) {
          expect(statement).toContain('created_at::text')
          return {
            rows: [{
              id: 10,
              created_at: instant,
              resource_type: 'user',
              resource_id: 'user-admin',
              resource_name: '管理员账号',
              user_id: '3',
              user_email: 'admin@example.com',
              user_name: '管理员账号',
              action_details: { email: 'admin@example.com' },
              request_body: null,
            }],
          }
        }
        if (statement.includes('UPDATE audit_logs')) {
          expect(statement).toContain("INTERVAL '1 millisecond'")
          expect(String(params[1])).toBe(instant.toISOString())
          expect(String(params[1])).not.toContain('GMT')
          return { rows: [{ id: 10 }], rowCount: 1 }
        }
        return { rows: [] }
      },
    }
    await scrubPurgedUserIdentity(client, {
      userId: 'user-admin',
      email: 'admin@example.com',
      username: null,
      mobile: null,
      at: '2026-11-01T00:00:00.000Z',
    })
    expect(statements.some((statement) => statement.includes('UPDATE audit_logs'))).toBe(true)
    expect(paramsSeen.some((params) => params.some((value) => typeof value === 'string' && value.includes('GMT')))).toBe(false)
  })
})
