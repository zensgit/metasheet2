import { afterEach, describe, expect, it } from 'vitest'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

/**
 * T1b — assert INSERT params (not merely SQL text) so state mutations fail the suite.
 * PR #4559 review: previous fake client discarded params → false-green.
 */
function fakeClient() {
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  return {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (/FROM directory_accounts account/.test(sql)) {
        return {
          rows: [{
            ...ACCOUNT,
            integration_provider: ACCOUNT.provider,
            integration_corp_id: 'corpA',
          }] as Array<Record<string, unknown>>,
        }
      }
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) {
        return { rows: [{ org_id: 'orgA' }] as Array<Record<string, unknown>> }
      }
      if (/SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/FROM directory_account_links/i.test(sql) && /SELECT local_user_id/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/FROM user_external_identities/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      return { rows: [] as Array<Record<string, unknown>> }
    },
  }
}

const ACCOUNT = {
  id: '11111111-1111-1111-1111-111111111111',
  integration_id: '22222222-2222-2222-2222-222222222222',
  provider: 'dingtalk',
  corp_id: 'corpA',
  external_user_id: 'ext-1',
  union_id: 'union-1',
  open_id: 'open-1',
  external_key: 'union-1',
  name: '李四',
  email: 'li@example.com',
  mobile: null as string | null,
}

const baseOptions = {
  adminUserId: 'admin-1',
  name: '李四',
  email: 'li@example.com',
  username: null as string | null,
  mobile: null as string | null,
  passwordHash: 'hashed',
  mustChangePassword: true,
  enableDingTalkGrant: false,
  account: ACCOUNT,
}

function findUsersInsert(client: ReturnType<typeof fakeClient>) {
  return client.queries.find((q) => /INSERT INTO users\b/i.test(q.sql))
}

describe('T1 directory admit pending-activation flag (default off)', () => {
  const original = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = original
  })

  it('default OFF: INSERT params are activated + is_active true + local_password_set true', async () => {
    delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    const client = fakeClient()
    await createDirectoryAdmittedUserInTransaction(client, baseOptions)

    const insert = findUsersInsert(client)
    expect(insert).toBeTruthy()
    const params = insert!.params ?? []
    // See createDirectoryAdmittedUserInTransaction param order:
    // [userId, email, username, name, mobile, passwordHash, mustChangePassword, permissionsJson,
    //  isActive, activationStatus, localPasswordSet]
    expect(params[8]).toBe(true) // is_active
    expect(params[9]).toBe('activated')
    expect(params[10]).toBe(true) // local_password_set
    expect(client.queries.some((q) => /INSERT INTO user_orgs\b/i.test(q.sql))).toBe(true)
  })

  it('when ON: INSERT params are pending + is_active false + local_password_set false; no user_orgs', async () => {
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'true'
    const client = fakeClient()
    await createDirectoryAdmittedUserInTransaction(client, {
      ...baseOptions,
      enableDingTalkGrant: true, // forced off in pending mode
    })

    const insert = findUsersInsert(client)
    expect(insert).toBeTruthy()
    const params = insert!.params ?? []
    expect(params[8]).toBe(false) // is_active
    expect(params[9]).toBe('pending_activation')
    expect(params[10]).toBe(false) // local_password_set
    expect(client.queries.some((q) => /INSERT INTO user_orgs\b/i.test(q.sql))).toBe(false)
    expect(client.queries.some((q) => /INSERT INTO user_external_auth_grants\b/i.test(q.sql))).toBe(false)
  })

  it('mutation: inverted activation params would fail the ON assertion', async () => {
    // Guard against false-green: if someone rewrites pending path to activated/true,
    // this expected shape must fail. (Documents the load-bearing params.)
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'true'
    const client = fakeClient()
    await createDirectoryAdmittedUserInTransaction(client, baseOptions)
    const params = findUsersInsert(client)!.params ?? []
    expect([params[8], params[9], params[10]]).not.toEqual([true, 'activated', true])
    expect([params[8], params[9], params[10]]).toEqual([false, 'pending_activation', false])
  })
})
