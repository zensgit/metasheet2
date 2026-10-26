import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Directory page "bind + enable DingTalk login" dead end (DT-HARDEN-02 openId source).
 *
 * A corp-scoped grant needs corpId+openId. 通讯录 user/get never returns openId, a DingTalk login
 * only wrote it to user_external_identities, the directory sync overwrote directory_accounts.open_id
 * with NULL on every run, and a re-bind erased the identity's openId — so a member who HAD scanned
 * in could never be granted from the directory page. These tests pin the four repairs at the unit
 * level; directory-dingtalk-openid-grant-path.db.test.ts proves the SQL semantics on real Postgres.
 */

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/security/auth-runtime-config', () => ({
  getBcryptSaltRounds: vi.fn(() => 10),
}))

vi.mock('../../src/auth/invite-ledger', () => ({
  recordInvite: vi.fn(async () => null),
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
}))

import { upsertDirectoryAccountMetadataRows } from '../../src/directory/directory-metadata-batch-upsert'

import {
  DirectoryValidationError,
  __directorySyncInternalsForTests,
  bindDirectoryAccount,
  getDirectoryAccountSummary,
  getDirectoryReviewItem,
  listDirectoryIntegrationAccounts,
  listDirectoryReviewItems,
  resolveDirectoryAutoAdmissionCanGrantDingTalkLogin,
} from '../../src/directory/directory-sync'

const { assertDirectoryAccountCanEnableDingTalkGrant } = __directorySyncInternalsForTests

type GrantCase = {
  name: string
  account: { corp_id: string | null; open_id: string | null; linked_identity_open_id?: string | null }
  grantable: boolean
}

const GRANT_CASES: GrantCase[] = [
  { name: 'corp account, no openId anywhere', account: { corp_id: 'corp-a', open_id: null, linked_identity_open_id: null }, grantable: false },
  { name: 'corp account, linked source field absent', account: { corp_id: 'corp-a', open_id: null }, grantable: false },
  { name: 'corp account, blank openIds', account: { corp_id: 'corp-a', open_id: '  ', linked_identity_open_id: '' }, grantable: false },
  { name: 'corp account, own openId', account: { corp_id: 'corp-a', open_id: 'open-own', linked_identity_open_id: null }, grantable: true },
  { name: 'corp account, only the linked identity openId', account: { corp_id: 'corp-a', open_id: null, linked_identity_open_id: 'open-linked' }, grantable: true },
  { name: 'corp account, both openIds', account: { corp_id: 'corp-a', open_id: 'open-own', linked_identity_open_id: 'open-linked' }, grantable: true },
  { name: 'non-corp account, no openId (unionId-keyed, unchanged)', account: { corp_id: null, open_id: null, linked_identity_open_id: null }, grantable: true },
  { name: 'blank corp account, no openId (unchanged)', account: { corp_id: '  ', open_id: null }, grantable: true },
]

function assertThrows(account: GrantCase['account'], enableDingTalkGrant: boolean): boolean {
  try {
    assertDirectoryAccountCanEnableDingTalkGrant(account, enableDingTalkGrant)
    return false
  } catch (error) {
    expect(error).toBeInstanceOf(DirectoryValidationError)
    expect((error as Error).message).toContain('missing DingTalk openId')
    return true
  }
}

describe('DT-HARDEN-02 grant predicate — openId source', () => {
  for (const testCase of GRANT_CASES) {
    it(`${testCase.name}: assertion and auto-admission predicate agree (grantable=${testCase.grantable})`, () => {
      expect(resolveDirectoryAutoAdmissionCanGrantDingTalkLogin(testCase.account)).toBe(testCase.grantable)
      expect(assertThrows(testCase.account, true)).toBe(!testCase.grantable)
      // grant withheld never throws, whatever the openId state
      expect(assertThrows(testCase.account, false)).toBe(false)
    })
  }

  it('the error text points at the real fix (scan in once, refresh, grant) instead of resync', () => {
    let message = ''
    try {
      assertDirectoryAccountCanEnableDingTalkGrant({ corp_id: 'corp-a', open_id: null }, true)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('missing DingTalk openId')
    // the workable order: bind/admit WITHOUT the grant → sign in once → refresh → grant
    // (a pending or unbound member's scan records no openId, so "just scan in" was a dead end)
    expect(message).toContain('bind (or admit) the member without the DingTalk grant first')
    expect(message).toContain('have them sign in with DingTalk once')
    expect(message).toContain('refresh this member')
    expect(message).not.toMatch(/resync/i)
  })
})

const ACCOUNT_ROW = {
  id: 'account-1',
  integration_id: 'dir-1',
  provider: 'dingtalk',
  corp_id: 'dingcorp',
  external_user_id: 'emp-1',
  union_id: 'union-1',
  open_id: null as string | null,
  linked_identity_open_id: null as string | null,
  external_key: 'union-1',
  name: 'Member',
  email: null,
  mobile: '13900001234',
  is_active: true,
}

type Call = { sql: string; params: unknown[] }

function installBindMocks(options: {
  linkedIdentityOpenId: string | null
  existingIdentity: boolean
}): { txCalls: Call[] } {
  const txCalls: Call[] = []
  pgMocks.transaction.mockImplementation(async (handler: (client: unknown) => Promise<unknown>) => handler({
    query: async (sql: string, params: unknown[] = []) => {
      const statement = String(sql)
      txCalls.push({ sql: statement, params })
      if (/FROM directory_accounts account\s+JOIN directory_integrations integration/.test(statement)) {
        return {
          rows: [{
            ...ACCOUNT_ROW,
            linked_identity_open_id: options.linkedIdentityOpenId,
            integration_provider: 'dingtalk',
            integration_corp_id: 'dingcorp',
          }],
        }
      }
      if (/FROM users[\s\S]*FOR UPDATE/.test(statement)) {
        return {
          rows: [{
            id: String(params[0] ?? 'user-1'),
            name: 'Alpha',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 0,
          }],
        }
      }
      if (/UPDATE users[\s\S]*access_generation/.test(statement)) return { rows: [{ access_generation: 1 }] }
      if (/SELECT org_id\s+FROM directory_integrations/.test(statement)) return { rows: [{ org_id: 'default' }] }
      if (/SELECT id\s+FROM user_external_identities\s+WHERE provider = \$1::text AND local_user_id = \$2::text/.test(statement)) {
        return { rows: options.existingIdentity ? [{ id: 'identity-1' }] : [] }
      }
      return { rows: [] }
    },
  }))

  pgMocks.query
    .mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, linked_identity_open_id: options.linkedIdentityOpenId }] })
    .mockResolvedValueOnce({ rows: [{ local_user_id: null, local_user_email: null, local_user_name: null }] })
    .mockResolvedValueOnce({
      rows: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }],
    })
    .mockResolvedValueOnce({
      rows: [{
        integration_id: 'dir-1',
        provider: 'dingtalk',
        corp_id: 'dingcorp',
        directory_account_id: 'account-1',
        external_user_id: 'emp-1',
        union_id: 'union-1',
        open_id: null,
        external_key: 'union-1',
        account_name: 'Member',
        account_email: null,
        account_mobile: '13900001234',
        account_is_active: true,
        account_updated_at: '2026-10-15T00:00:00.000Z',
        link_status: 'linked',
        match_strategy: 'manual_admin',
        reviewed_by: 'admin-1',
        review_note: null,
        link_updated_at: '2026-10-15T00:00:00.000Z',
        local_user_id: 'user-1',
        local_user_email: 'alpha@example.com',
        local_user_name: 'Alpha',
        department_paths: ['DingTalk CN'],
      }],
    })
  return { txCalls }
}

/** The linked-openId subquery must key on the PERSON (corp + unionId), never on the local user. */
function expectLinkedOpenIdSubquery(sql: string): void {
  expect(sql).toContain('linked_identity_open_id')
  expect(sql).toMatch(/FROM user_external_identities identity/)
  expect(sql).toMatch(/identity\.provider = account\.provider/)
  expect(sql).toMatch(/identity\.corp_id = account\.corp_id/)
  expect(sql).toMatch(/identity\.provider_union_id = account\.union_id/)
  // ambiguity fails closed: more than one distinct openId yields NULL
  expect(sql).toMatch(/COUNT\(DISTINCT identity\.provider_open_id\) = 1/)
  expect(sql).not.toMatch(/identity\.local_user_id/)
}

describe('bindDirectoryAccount — grant backed by the linked identity openId', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
  })

  it('binds AND grants a corp member whose only openId is the one their DingTalk login recorded', async () => {
    const { txCalls } = installBindMocks({ linkedIdentityOpenId: 'open-linked', existingIdentity: true })

    await bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })

    // both reads that feed the assertion carry the corp+union-scoped linked openId
    expectLinkedOpenIdSubquery(String(pgMocks.query.mock.calls[0]?.[0]))
    const lockCall = txCalls.find((call) => /FROM directory_accounts account\s+JOIN directory_integrations/.test(call.sql))
    expect(lockCall).toBeTruthy()
    expectLinkedOpenIdSubquery(lockCall!.sql)

    const grant = txCalls.find((call) => call.sql.includes('INSERT INTO user_external_auth_grants'))
    expect(grant?.params).toEqual(['dingtalk', 'user-1', 'admin-1'])
  })

  it('still rejects the grant when no same corp+union identity openId is known', async () => {
    installBindMocks({ linkedIdentityOpenId: null, existingIdentity: true })

    await expect(bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toThrow('missing DingTalk openId')
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('a re-bind keeps the identity openId while unionId and corp are unchanged (never writes NULL over it)', async () => {
    const { txCalls } = installBindMocks({ linkedIdentityOpenId: 'open-linked', existingIdentity: true })

    await bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: false,
    })

    const update = txCalls.find((call) => call.sql.includes('UPDATE user_external_identities'))
    expect(update, 'expected the existing-identity UPDATE branch').toBeTruthy()
    const normalized = update!.sql.replace(/\s+/g, ' ')
    expect(normalized).not.toMatch(/provider_open_id = \$5::text,/)
    expect(normalized).toContain("provider_open_id = COALESCE( NULLIF($5::text, ''), CASE")
    // `=` on the unionId: a NULL unionId never counts as "the same person"
    expect(normalized).toContain('WHEN provider_union_id = $4::text AND corp_id IS NOT DISTINCT FROM $6::text THEN NULLIF(provider_open_id, \'\')')
    // $4 = unionId, $5 = the directory row's own openId (NULL here), $6 = corp
    // N3: $3 external_key is keyed on the resolved (linked) openId, not flipped to corp:unionId
    expect(update!.params[2]).toBe('dingcorp:open-linked')
    expect(update!.params[3]).toBe('union-1')
    expect(update!.params[4]).toBeNull()
    expect(update!.params[5]).toBe('dingcorp')
  })
})

describe('directory sync upsert — openId is not overwritten with NULL', () => {
  // The exact statement syncDirectoryIntegration executes (a module constant, also run against
  // real Postgres by directory-dingtalk-openid-grant-path.db.test.ts).
  const statement = __directorySyncInternalsForTests.DIRECTORY_ACCOUNT_UPSERT_SQL

  it('is the statement the sync loop runs', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/directory/directory-sync.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toMatch(/import\s*\{[^}]*\bupsertDirectoryAccountMetadataRows\b[^}]*\}\s*from '\.\/directory-metadata-batch-upsert'/)
    expect(source.match(/\bupsertDirectoryAccountMetadataRows\s*\(/g)).toHaveLength(1)
    expect(source).toMatch(/await upsertDirectoryAccountMetadataRows\(\s*\(sql, params\) => client\.query\(sql, params\),\s*userList\.map\(/)
    expect(source).not.toContain('INSERT INTO directory_accounts (')
    const batchSource = readFileSync(
      fileURLToPath(new URL('../../src/directory/directory-metadata-batch-upsert.ts', import.meta.url)),
      'utf8',
    )
    expect(batchSource.match(/INSERT INTO directory_accounts \(/g)).toHaveLength(1)
    const row = Array.from({ length: 16 }, (_, index) => `bind-${index}`)
    const execute = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ created: true }] }))
    expect(await upsertDirectoryAccountMetadataRows(execute, [row])).toEqual({ createdCount: 1, updatedCount: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(statement, row)
  })

  function accountUpsertConflictClause(): string {
    expect(statement.startsWith('INSERT INTO directory_accounts (')).toBe(true)
    const conflict = statement.indexOf('ON CONFLICT (integration_id, external_user_id)')
    const end = statement.indexOf('RETURNING', conflict)
    expect(conflict).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(conflict)
    return statement
      .slice(conflict, end)
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
  }

  it('keeps the stored openId when the pull has none and unionId/corp are unchanged; clears it otherwise', () => {
    const clause = accountUpsertConflictClause()
    expect(clause).not.toMatch(/open_id = EXCLUDED\.open_id,/)
    expect(clause).toContain(
      "open_id = CASE WHEN COALESCE(EXCLUDED.open_id, '') <> '' THEN EXCLUDED.open_id "
      + 'WHEN directory_accounts.union_id = EXCLUDED.union_id '
      + 'AND directory_accounts.corp_id IS NOT DISTINCT FROM EXCLUDED.corp_id '
      + 'THEN directory_accounts.open_id ELSE NULL END,',
    )
  })
})

const SUMMARY_ROW = {
  integration_id: 'dir-1',
  provider: 'dingtalk',
  corp_id: 'dingcorp',
  directory_account_id: 'account-1',
  external_user_id: 'emp-1',
  union_id: 'union-1',
  open_id: null as string | null,
  linked_identity_open_id: null as string | null,
  external_key: 'union-1',
  account_name: 'Member',
  account_email: null,
  account_mobile: null,
  account_is_active: true,
  account_updated_at: '2026-10-15T00:00:00.000Z',
  link_status: 'linked',
  match_strategy: 'manual_admin',
  reviewed_by: 'admin-1',
  review_note: null,
  link_updated_at: '2026-10-15T00:00:00.000Z',
  local_user_id: 'user-1',
  local_user_email: 'alpha@example.com',
  local_user_username: null,
  local_user_name: 'Alpha',
  department_paths: [],
}


/**
 * The four places the directory page reads an account from. Each must load the linked openId
 * through the shared subquery (alias `a`) and compute the verdict with the shared predicate.
 * The mock only hands back `linked_identity_open_id` when the SQL actually selects it through
 * that subquery — so dropping the subquery from ANY one source flips that source's verdict.
 */
type VerdictSource = {
  name: string
  run: () => Promise<{ grantOpenIdAvailable?: boolean; missingOpenId?: boolean } | null>
  /** marks the statement that loads the account row(s) */
  rowsSqlMarker: RegExp
  /** extra rows the source issues before/after the row load (counts, recommendations) */
  otherRows?: (sql: string) => Array<Record<string, unknown>> | null
  review: boolean
}

const VERDICT_SOURCES: VerdictSource[] = [
  {
    name: 'account summary (getDirectoryAccountSummary)',
    run: async () => {
      const summary = await getDirectoryAccountSummary('account-1')
      return summary ? { grantOpenIdAvailable: summary.grantOpenIdAvailable } : null
    },
    rowsSqlMarker: /AS directory_account_id/,
    review: false,
  },
  {
    name: 'member list (listDirectoryIntegrationAccounts)',
    run: async () => {
      const result = await listDirectoryIntegrationAccounts('dir-1', { limit: 10, offset: 0 })
      const item = result.items[0]
      return item ? { grantOpenIdAvailable: item.grantOpenIdAvailable } : null
    },
    rowsSqlMarker: /AS directory_account_id/,
    otherRows: (sql) => (/COUNT\(\*\)::int AS total/.test(sql) ? [{ total: 1 }] : null),
    review: false,
  },
  {
    name: 'review list (listDirectoryReviewItems)',
    run: async () => {
      const result = await listDirectoryReviewItems('dir-1', { limit: 10, offset: 0 })
      const item = result.items[0]
      return item ? { grantOpenIdAvailable: item.account.grantOpenIdAvailable, missingOpenId: item.flags.missingOpenId } : null
    },
    rowsSqlMarker: /AS review_kind/,
    otherRows: (sql) => (/COUNT\(\*\)::int AS total/.test(sql) ? [{ total: 1 }] : null),
    review: true,
  },
  {
    name: 'single review-item refresh (getDirectoryReviewItem)',
    run: async () => {
      const item = await getDirectoryReviewItem('account-1')
      return item ? { grantOpenIdAvailable: item.account.grantOpenIdAvailable, missingOpenId: item.flags.missingOpenId } : null
    },
    rowsSqlMarker: /AS review_kind/,
    review: true,
  },
]

const VERDICT_CASES: Array<{ name: string; row: Partial<typeof SUMMARY_ROW>; available: boolean }> = [
  { name: 'corp member, no openId anywhere', row: {}, available: false },
  { name: 'corp member who scanned in (linked openId only)', row: { linked_identity_open_id: 'open-linked' }, available: true },
  { name: 'corp member with own openId', row: { open_id: 'open-own' }, available: true },
  { name: 'non-corp member, no openId', row: { corp_id: null }, available: true },
]

function selectsLinkedOpenIdThroughSharedSubquery(sql: string): boolean {
  return sql.includes('AS linked_identity_open_id')
    && sql.includes('identity.provider = a.provider')
    && sql.includes('identity.corp_id = a.corp_id')
    && sql.includes('identity.provider_union_id = a.union_id')
    && sql.includes('COUNT(DISTINCT identity.provider_open_id) = 1')
}

describe('page verdict — every source the page reads computes grantOpenIdAvailable with the shared predicate + subquery', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
  })

  for (const source of VERDICT_SOURCES) {
    for (const testCase of VERDICT_CASES) {
      it(`${source.name}: ${testCase.name} → grantOpenIdAvailable=${testCase.available}${source.review ? `, missingOpenId=${!testCase.available}` : ''}`, async () => {
        const row: Record<string, unknown> = {
          ...SUMMARY_ROW,
          ...testCase.row,
          ...(source.review ? { review_kind: 'inactive_linked', review_reason: 'x', missing_union_id: false } : {}),
        }
        const rowSqls: string[] = []
        pgMocks.query.mockImplementation(async (sql: string) => {
          const statement = String(sql)
          const other = source.otherRows?.(statement)
          if (other) return { rows: other }
          if (source.rowsSqlMarker.test(statement)) {
            rowSqls.push(statement)
            // a real database only returns the column the statement selects
            const returned = { ...row }
            if (!selectsLinkedOpenIdThroughSharedSubquery(statement)) delete returned.linked_identity_open_id
            return { rows: [returned] }
          }
          return { rows: [] }
        })

        const verdict = await source.run()
        expect(rowSqls, 'expected exactly one account-row statement').toHaveLength(1)
        expect(selectsLinkedOpenIdThroughSharedSubquery(rowSqls[0]!)).toBe(true)
        expect(verdict?.grantOpenIdAvailable).toBe(testCase.available)
        // the page verdict and the server-side bind/admit assertion can never disagree
        expect(assertThrows(row as GrantCase['account'], true)).toBe(!testCase.available)
        if (source.review) {
          // the "缺 openId" chip is exactly the inverse of the verdict
          expect(verdict?.missingOpenId).toBe(!testCase.available)
          expect(rowSqls[0]).not.toContain('AS missing_open_id')
        }
      })
    }
  }
})
