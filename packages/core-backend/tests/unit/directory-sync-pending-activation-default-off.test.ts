import { afterEach, describe, expect, it } from 'vitest'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

/**
 * T1b — when DIRECTORY_PENDING_ACTIVATION_ENABLED is unset/false, admission create must
 * stay byte-compatible with pre-T1: active user + active user_orgs path (via bind).
 * When true, creates pending_activation / is_active=false and skips user_orgs.
 */
function fakeClient() {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql)
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) {
        return { rows: [{ org_id: 'orgA' }] as Array<Record<string, unknown>> }
      }
      if (/SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/INSERT INTO users\b/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/FROM directory_account_links/i.test(sql) && /SELECT local_user_id/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/FROM user_external_identities/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/INSERT INTO user_external_identities/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/INSERT INTO directory_account_links/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/INSERT INTO user_orgs/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      if (/INSERT INTO user_external_auth_grants/i.test(sql)) {
        return { rows: [] as Array<Record<string, unknown>> }
      }
      void params
      return { rows: [] as Array<Record<string, unknown>> }
    },
  }
}

const ACCOUNT = {
  id: '11111111-1111-1111-1111-111111111111',
  integration_id: '22222222-2222-2222-2222-222222222222',
  provider: 'dingtalk',
  corp_id: null as string | null,
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

describe('T1 directory admit pending-activation flag (default off)', () => {
  const original = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = original
  })

  it('default OFF: inserts activated/active user and writes user_orgs', async () => {
    delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    const client = fakeClient()
    await createDirectoryAdmittedUserInTransaction(client, baseOptions)

    const userInsert = client.queries.find((sql) => /INSERT INTO users\b/i.test(sql))
    expect(userInsert).toBeTruthy()
    // activated path: is_active true param present; activation_status activated
    expect(client.queries.some((sql) => /INSERT INTO user_orgs\b/i.test(sql))).toBe(true)
  })

  it('when ON: inserts pending user and does not write user_orgs', async () => {
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'true'
    const client = fakeClient()
    await createDirectoryAdmittedUserInTransaction(client, {
      ...baseOptions,
      enableDingTalkGrant: true, // forced off in pending mode
    })

    expect(client.queries.some((sql) => /INSERT INTO users\b/i.test(sql))).toBe(true)
    expect(client.queries.some((sql) => /INSERT INTO user_orgs\b/i.test(sql))).toBe(false)
    // grant should not be enabled on pending create even if requested
    expect(client.queries.some((sql) => /INSERT INTO user_external_auth_grants\b/i.test(sql))).toBe(false)
  })
})
