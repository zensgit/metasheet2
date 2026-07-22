import { describe, expect, it } from 'vitest'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

/**
 * DT-HARDEN-02 — the orphan-prevention invariant.
 *
 * Pre-fix, sync auto-admission hardcoded `enableDingTalkGrant: true`. For a
 * corp-scoped directory account without an openId, the grant assertion lives in
 * the bind step, which runs AFTER `INSERT INTO users`. The sync loop swallowed the
 * throw and the surrounding transaction committed, leaving an ACTIVE local user
 * with no DingTalk identity and no linked directory account — invisible to the
 * admin review queue.
 *
 * The invariant asserted here: if the requested grant cannot be honored, the
 * function must throw BEFORE any `users` row is written.
 */
function fakeClient() {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql)
      // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
      // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing
      // user_orgs. This fixture's account.integration_id must resolve to SOME org for the
      // grant-feasibility scenarios below to reach the INSERT INTO users assertions they exist
      // to prove — everything else keeps the previous always-empty-rows behavior.
      if (/SELECT org_id\s+FROM directory_integrations/.test(sql)) {
        return { rows: [{ org_id: 'orgA' }] as Array<Record<string, unknown>> }
      }
      return { rows: [] as Array<Record<string, unknown>> }
    },
  }
}

const CORP_ACCOUNT_WITHOUT_OPENID = {
  id: '11111111-1111-1111-1111-111111111111',
  integration_id: '22222222-2222-2222-2222-222222222222',
  provider: 'dingtalk',
  corp_id: 'corpA',
  external_user_id: 'ext-1',
  union_id: 'union-1',
  open_id: null,
  external_key: 'union-1',
  name: '张三',
  email: null,
  mobile: null,
}

const baseOptions = {
  adminUserId: 'admin-1',
  name: '张三',
  email: null,
  username: 'dt_ext_1',
  mobile: null,
  passwordHash: 'hashed',
  mustChangePassword: true,
}

function insertedUsers(queries: string[]): string[] {
  return queries.filter((sql) => /INSERT INTO users\b/i.test(sql))
}

describe('DT-HARDEN-02 auto-admission orphan guard', () => {
  it('throws BEFORE inserting the users row when a corp account without openId requests a grant', async () => {
    const client = fakeClient()

    await expect(
      createDirectoryAdmittedUserInTransaction(client, {
        ...baseOptions,
        account: CORP_ACCOUNT_WITHOUT_OPENID,
        enableDingTalkGrant: true,
      }),
    ).rejects.toThrow(/openId/i)

    // The load-bearing assertion: no orphan user row was written.
    expect(insertedUsers(client.queries)).toHaveLength(0)
  })

  it('admits the same account when the grant is withheld (the DT-HARDEN-02 auto-admission path)', async () => {
    const client = fakeClient()

    const created = await createDirectoryAdmittedUserInTransaction(client, {
      ...baseOptions,
      account: CORP_ACCOUNT_WITHOUT_OPENID,
      enableDingTalkGrant: false,
    })

    expect(created.userId).toBeTruthy()
    expect(insertedUsers(client.queries)).toHaveLength(1)
    // Directory binding still happens; only the DingTalk login grant is withheld.
    expect(client.queries.some((sql) => /INSERT INTO directory_account_links/i.test(sql))).toBe(true)
    expect(client.queries.some((sql) => /user_external_auth_grants/i.test(sql))).toBe(false)
  })

  it('still grants a corp account that has an openId', async () => {
    const client = fakeClient()

    await createDirectoryAdmittedUserInTransaction(client, {
      ...baseOptions,
      account: { ...CORP_ACCOUNT_WITHOUT_OPENID, open_id: 'open-1' },
      enableDingTalkGrant: true,
    })

    expect(insertedUsers(client.queries)).toHaveLength(1)
    expect(client.queries.some((sql) => /user_external_auth_grants/i.test(sql))).toBe(true)
  })
})
