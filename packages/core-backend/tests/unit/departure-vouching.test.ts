/**
 * Departure vouching — the single definition (no database).
 *
 * Invariants proved here:
 *  - each scope variant, and its non-local restriction, renders exactly the expression pinned
 *    below (snapshots written out in full, independent of the builder);
 *  - the expression counts directory accounts only: three tables, `linked`, `is_active`, and the
 *    exclusion set;
 *  - every placeholder ordinal is explicit, distinct and referenced exactly where it was given,
 *    so a statement that interpolates a variant stays densely numbered;
 *  - the exclusion set is always a bound array; anything else is refused before it can turn the
 *    expression false;
 *  - each of the four statements that need "nobody vouches" interpolates the builder output with
 *    its ordinals and binds a non-NULL array for the exclusion set.
 */
import { describe, expect, it } from 'vitest'

import {
  applyDirectoryDeprovisionPolicies,
  deactivateUserOrgMembershipIfNoOtherActiveBinding,
} from '../../src/directory/directory-sync'
import {
  bindProspectiveAccountIds,
  globalVouchExists,
  legacyLoginScopeVouchExists,
  noProspectiveDeactivation,
  orgVouchExists,
  strictLoginScopeVouchExists,
} from '../../src/directory/departure-vouching'
import { planDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  DEFAULT_LOCAL_ACCOUNT_MATCH_STRATEGY,
  LOCAL_ACCOUNT_MATCH_STRATEGIES,
  LocalDirectoryValidationError,
  createLocalAccount,
  resolveLocalAccountMatchStrategy,
} from '../../src/directory/local-directory-org'

const FROM_JOINS = `EXISTS (
         SELECT 1
           FROM directory_account_links sibling_link
           JOIN directory_accounts sibling
             ON sibling.id = sibling_link.directory_account_id
           JOIN directory_integrations sibling_integration
             ON sibling_integration.id = sibling.integration_id
          WHERE sibling_link.local_user_id = USER
            AND sibling_link.link_status = 'linked'
            AND sibling.is_active = TRUE
            AND sibling.id <> ALL($PROSPECTIVE::uuid[])`

function frozen(user: string, prospective: number, scope: string[] = []): string {
  return [FROM_JOINS.replace('USER', user).replace('$PROSPECTIVE', `$${prospective}`), ...scope.map((line) => `            AND ${line}`)].join('\n') + '\n       )'
}

describe('departure vouching expressions', () => {
  it('global: any other active linked account', () => {
    expect(globalVouchExists({ user: 'candidate_user.id', prospectiveParam: 5 })).toBe(
      frozen('candidate_user.id', 5),
    )
  })

  it('org: restricted to one organization', () => {
    expect(orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 })).toBe(
      frozen('$1::text', 3, ['sibling_integration.org_id = $2::text']),
    )
  })

  it('legacy login scope: restricted to one provider and corp', () => {
    expect(
      legacyLoginScopeVouchExists({ user: 'l.local_user_id', prospectiveParam: 4, providerParam: 2, corpParam: 3 }),
    ).toBe(
      frozen('l.local_user_id', 4, [
        'sibling_integration.provider = $2::text\n            AND sibling_integration.corp_id = $3::text',
      ]),
    )
  })

  it('strict login scope: restricted to a set of connection ids', () => {
    expect(
      strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 3, connectionIdsParam: 2 }),
    ).toBe(frozen('$1::text', 3, ['sibling_integration.id = ANY($2::uuid[])']))
  })

  it('the non-local restriction is one extra clause on every scope and nothing else', () => {
    const variants = [
      [globalVouchExists({ user: '$1::text', prospectiveParam: 2 }), globalVouchExists({ user: '$1::text', prospectiveParam: 2, nonLocalOnly: true })],
      [
        orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 }),
        orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2, nonLocalOnly: true }),
      ],
      [
        legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 4, providerParam: 2, corpParam: 3 }),
        legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 4, providerParam: 2, corpParam: 3, nonLocalOnly: true }),
      ],
      [
        strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 3, connectionIdsParam: 2 }),
        strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 3, connectionIdsParam: 2, nonLocalOnly: true }),
      ],
    ]
    for (const [plain, restricted] of variants) {
      expect(plain.endsWith('\n       )')).toBe(true)
      expect(restricted).toBe(
        `${plain.slice(0, -'\n       )'.length)}\n            AND sibling_integration.provider <> 'local'\n       )`,
      )
      expect(restricted).toContain("sibling_integration.provider <> 'local'")
      expect(plain).not.toContain("<> 'local'")
    }
  })

  it('counts directory accounts only: three tables, linked, active, and the exclusion set', () => {
    const expressions = [
      globalVouchExists({ user: '$1::text', prospectiveParam: 2 }),
      orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 }),
      legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 4, providerParam: 2, corpParam: 3 }),
      strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 3, connectionIdsParam: 2 }),
    ]
    for (const sql of expressions) {
      const tables = Array.from(sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g), (match) => match[1]).sort()
      expect(tables).toEqual(['directory_account_links', 'directory_accounts', 'directory_integrations'])
      expect(sql).toContain("sibling_link.link_status = 'linked'")
      expect(sql).toContain('sibling.is_active = TRUE')
      expect(sql).toMatch(/sibling\.id <> ALL\(\$\d+::uuid\[\]\)/)
      expect(sql.startsWith('EXISTS (')).toBe(true)
    }
  })
})

describe('departure vouching placeholders', () => {
  const referenced = (sql: string) =>
    Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])).sort((a, b) => a - b)

  it('references exactly the ordinals it was given, each once, with typed placeholders', () => {
    expect(referenced(globalVouchExists({ user: '$1::text', prospectiveParam: 2 }))).toEqual([1, 2])
    expect(referenced(globalVouchExists({ user: 'candidate_user.id', prospectiveParam: 5 }))).toEqual([5])
    expect(referenced(orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 }))).toEqual([1, 2, 3])
    expect(referenced(orgVouchExists({ user: 'l.local_user_id', prospectiveParam: 3, orgParam: 2 }))).toEqual([2, 3])
    expect(
      referenced(legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 4, providerParam: 2, corpParam: 3 })),
    ).toEqual([1, 2, 3, 4])
    expect(
      referenced(strictLoginScopeVouchExists({ user: 'l.local_user_id', prospectiveParam: 3, connectionIdsParam: 2 })),
    ).toEqual([2, 3])
  })

  it('does not count: a repeated or malformed ordinal is refused', () => {
    expect(() => orgVouchExists({ user: '$1::text', prospectiveParam: 1, orgParam: 2 })).toThrow(/distinct/)
    expect(() => orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 2 })).toThrow(/distinct/)
    expect(() =>
      legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 4, providerParam: 2, corpParam: 2 }),
    ).toThrow(/distinct/)
    for (const bad of [0, -1, 1.5, Number.NaN, 1000, '3' as unknown as number, undefined as unknown as number]) {
      expect(() => orgVouchExists({ user: '$1::text', prospectiveParam: bad, orgParam: 2 })).toThrow(/ordinal/)
      expect(() => orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: bad })).toThrow(/ordinal/)
    }
  })

  it('accepts a qualified column or a typed placeholder as the person, nothing else', () => {
    for (const ok of ['l.local_user_id', 'candidate_user.id', '$1::text']) {
      expect(() => globalVouchExists({ user: ok, prospectiveParam: 9 })).not.toThrow()
    }
    for (const bad of ['', '$1', '1::text', 'x', 'l.local_user_id; DROP TABLE users', "'a'", 'l.local_user_id OR TRUE', 'a.b.c']) {
      expect(() => globalVouchExists({ user: bad, prospectiveParam: 9 })).toThrow(/user reference/)
    }
    expect(() => globalVouchExists({ user: undefined as unknown as string, prospectiveParam: 9 })).toThrow(/user reference/)
  })
})

describe('departure vouching exclusion set', () => {
  it('is always an array: anything else is refused, never bound', () => {
    for (const bad of [null, undefined, 'a', 7, {}, new Set(['a'])]) {
      expect(() => bindProspectiveAccountIds(bad)).toThrow(/exclusion set must be an array/)
    }
  })

  it('trims, drops blanks and de-duplicates; the empty set is an empty array', () => {
    expect(bindProspectiveAccountIds([' a ', 'a', '', '  ', 'b'])).toEqual(['a', 'b'])
    expect(bindProspectiveAccountIds([])).toEqual([])
    expect(noProspectiveDeactivation()).toEqual([])
    expect(Array.isArray(noProspectiveDeactivation())).toBe(true)
    expect(noProspectiveDeactivation()).not.toBe(noProspectiveDeactivation())
  })

  it('the error names no value', () => {
    try {
      bindProspectiveAccountIds('secret-account-id')
      throw new Error('expected a throw')
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-account-id')
      expect((error as { code?: string }).code).toBe('DEPARTURE_VOUCHING_INVALID_INPUT')
    }
  })
})

type Recorded = { sql: string; params: unknown[] | undefined }

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000a1'

function recordingClient() {
  const recorded: Recorded[] = []
  return {
    recorded,
    query: async (sql: string, params?: unknown[]) => {
      recorded.push({ sql, params })
      if (/FROM directory_accounts a\b/.test(sql) && /JOIN directory_account_links l/.test(sql)) {
        return {
          rows: [{ directory_account_id: ACCOUNT_ID, local_user_id: 'user-1', deprovision_policy_override: null }],
        }
      }
      if (/SELECT org_id\s+FROM directory_integrations/i.test(sql)) return { rows: [{ org_id: 'org-1' }] }
      if (/^\s*SELECT id FROM users WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) {
        return { rows: [{ id: String(params?.[0]) }] }
      }
      if (/FROM users candidate_user/.test(sql)) {
        return {
          rows: [{
            activation_status: 'activated',
            is_active: true,
            access_generation: 1,
            linked_at_apply: true,
            org_membership_active: true,
            org_candidacy_clear: true,
            globally_clear: true,
            org_candidacy_clear_non_local: true,
            globally_clear_non_local: true,
            login_grant_provider: 'dingtalk',
            login_grant_enabled: true,
            login_grant_row_exists: true,
          }],
        }
      }
      if (/^\s*UPDATE users\s+SET access_generation/.test(sql)) return { rows: [{ access_generation: 2 }] }
      if (/^\s*UPDATE user_orgs\s+SET is_active = FALSE/.test(sql)) return { rows: [{ user_id: 'user-1' }] }
      if (/^\s*INSERT INTO user_external_auth_grants/.test(sql)) return { rows: [] }
      if (/^\s*UPDATE user_external_auth_grants/.test(sql)) return { rows: [{ local_user_id: 'user-1' }] }
      if (/^\s*UPDATE directory_deprovision_(?:effects|events)\s+SET status = 'superseded'/.test(sql)) return { rows: [] }
      if (/^\s*INSERT INTO directory_deprovision_events/.test(sql)) return { rows: [{ id: 'event-1' }] }
      if (/FROM information_schema\.columns/.test(sql)) return { rows: [{ present: true }] }
      if (/^\s*INSERT INTO directory_deprovision_effects \(/.test(sql)) return { rows: [] }
      throw new Error(`Unhandled SQL in vouching call-site fake:\n${sql}`)
    },
  }
}

describe('statements that need "nobody vouches"', () => {
  const only = (recorded: Recorded[], pattern: RegExp): Recorded => {
    const matches = recorded.filter((entry) => pattern.test(entry.sql))
    expect(matches).toHaveLength(1)
    return matches[0]
  }

  it('candidate selection interpolates the org expression and binds an empty exclusion array', async () => {
    const client = recordingClient()
    await applyDirectoryDeprovisionPolicies(client, {
      integrationId: 'dir-1',
      runId: 'run-1',
      triggeredBy: 'unit-test',
      deactivatedAccountIds: [ACCOUNT_ID],
      syncedAccountCount: 100,
      integrationDefaultPolicy: 'mark_inactive',
      enabled: true,
    })
    const candidate = only(client.recorded, /FROM directory_accounts a\b[\s\S]*JOIN directory_account_links l/)
    expect(candidate.sql).toContain(
      `NOT ${orgVouchExists({ user: 'l.local_user_id', prospectiveParam: 3, orgParam: 2 })}`,
    )
    expect(candidate.params).toEqual([[ACCOUNT_ID], 'org-1', []])
    expect(Array.isArray(candidate.params?.[2])).toBe(true)
  })

  it('the state read interpolates all four expressions on the same ordinals', async () => {
    const client = recordingClient()
    await planDirectoryDeprovisionCandidate(client, {
      localUserId: 'user-1',
      orgId: 'org-1',
      integrationId: '00000000-0000-4000-8000-0000000000b1',
      directoryAccountId: ACCOUNT_ID,
      policy: 'mark_inactive',
      write: false,
      prospectiveDeactivatedAccountIds: [ACCOUNT_ID],
      requireSourceInactive: false,
    })
    const read = only(client.recorded, /FROM users candidate_user/)
    const common = { user: 'candidate_user.id', prospectiveParam: 5 }
    expect(read.sql).toContain(`NOT ${orgVouchExists({ ...common, orgParam: 4 })} AS org_candidacy_clear,`)
    expect(read.sql).toContain(`NOT ${globalVouchExists(common)} AS globally_clear,`)
    expect(read.sql).toContain(
      `NOT ${orgVouchExists({ ...common, orgParam: 4, nonLocalOnly: true })} AS org_candidacy_clear_non_local,`,
    )
    expect(read.sql).toContain(
      `NOT ${globalVouchExists({ ...common, nonLocalOnly: true })} AS globally_clear_non_local`,
    )
    expect(read.params?.[4]).toEqual([ACCOUNT_ID])
    // every ordinal 1..6 is referenced: nothing unbound, nothing unreferenced
    const ordinals = new Set(Array.from(read.sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))
    expect(Array.from(ordinals).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(read.params).toHaveLength(6)
  })

  it('the state read binds an empty array, not NULL, when no account is excluded', async () => {
    const client = recordingClient()
    await planDirectoryDeprovisionCandidate(client, {
      localUserId: 'user-1',
      orgId: 'org-1',
      integrationId: '00000000-0000-4000-8000-0000000000b1',
      directoryAccountId: ACCOUNT_ID,
      policy: 'mark_inactive',
      write: false,
    })
    const read = only(client.recorded, /FROM users candidate_user/)
    expect(read.params?.[4]).toEqual([])
    expect(Array.isArray(read.params?.[4])).toBe(true)
  })

  it('the write-time membership recheck interpolates the org expression and binds an empty exclusion array', async () => {
    const client = recordingClient()
    await applyDirectoryDeprovisionPolicies(client, {
      integrationId: 'dir-1',
      runId: 'run-1',
      triggeredBy: 'unit-test',
      deactivatedAccountIds: [ACCOUNT_ID],
      syncedAccountCount: 100,
      integrationDefaultPolicy: 'mark_inactive',
      enabled: true,
    })
    const recheck = only(client.recorded, /^\s*UPDATE user_orgs\s+SET is_active = FALSE/)
    expect(recheck.sql).toContain(
      `NOT ${orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 })}`,
    )
    expect(recheck.params).toEqual(['user-1', 'org-1', []])
    expect(Array.isArray(recheck.params?.[2])).toBe(true)
  })

  it('the membership helper interpolates the org expression and binds an empty exclusion array', async () => {
    const client = recordingClient()
    await deactivateUserOrgMembershipIfNoOtherActiveBinding(
      { query: async (sql, params) => { client.recorded.push({ sql, params }); return { rows: [] } } },
      { userId: 'user-1', orgId: 'org-1' },
    )
    const update = only(client.recorded, /^\s*UPDATE user_orgs/)
    expect(update.sql).toContain(
      `NOT ${orgVouchExists({ user: '$1::text', prospectiveParam: 3, orgParam: 2 })}`,
    )
    expect(update.params).toEqual(['user-1', 'org-1', []])
    expect(Array.isArray(update.params?.[2])).toBe(true)
  })
})

describe('suppressedByLocal', () => {
  const row = (flags: Partial<Record<string, boolean>>) => ({
    activation_status: 'activated',
    is_active: true,
    access_generation: 1,
    linked_at_apply: true,
    org_membership_active: true,
    org_candidacy_clear: true,
    globally_clear: true,
    org_candidacy_clear_non_local: true,
    globally_clear_non_local: true,
    login_grant_provider: 'dingtalk',
    login_grant_enabled: true,
    login_grant_row_exists: true,
    ...flags,
  })
  const planWith = async (flags: Partial<Record<string, boolean>>) => {
    const { plan } = await planDirectoryDeprovisionCandidate(
      { query: async () => ({ rows: [row(flags)] }) },
      {
        localUserId: 'user-1',
        orgId: 'org-1',
        integrationId: '00000000-0000-4000-8000-0000000000b1',
        directoryAccountId: ACCOUNT_ID,
        policy: 'mark_inactive',
        write: false,
      },
    )
    return plan
  }

  it('is false on both legs when nobody vouches', async () => {
    expect((await planWith({})).suppressedByLocal).toEqual({ membership: false, global: false })
  })

  it('is true when only local accounts vouch: the all-provider expression is vouched and the non-local one is clear', async () => {
    const plan = await planWith({
      org_candidacy_clear: false,
      globally_clear: false,
    })
    expect(plan.suppressedByLocal).toEqual({ membership: true, global: true })
  })

  it('is false when a non-local account also vouches', async () => {
    const plan = await planWith({
      org_candidacy_clear: false,
      globally_clear: false,
      org_candidacy_clear_non_local: false,
      globally_clear_non_local: false,
    })
    expect(plan.suppressedByLocal).toEqual({ membership: false, global: false })
  })

  it('reports each leg on its own', async () => {
    const plan = await planWith({
      org_candidacy_clear: false,
      globally_clear: false,
      globally_clear_non_local: false,
    })
    expect(plan.suppressedByLocal).toEqual({ membership: true, global: false })
  })

  it('does not change a decision input: the effects follow the all-provider expressions only', async () => {
    const vouchedLocally = await planWith({ org_candidacy_clear: false, globally_clear: false })
    expect(vouchedLocally.effects).toEqual([])
    const clear = await planWith({})
    expect(clear.effects.map((effect) => effect.type).sort()).toEqual([
      'grant_changed',
      'membership_changed',
      'user_changed',
    ])
  })
})

describe('local account match strategy', () => {
  it('defaults to the administrator\'s explicit creation and accepts only members of the closed set', () => {
    expect(DEFAULT_LOCAL_ACCOUNT_MATCH_STRATEGY).toBe('local_explicit')
    expect([...LOCAL_ACCOUNT_MATCH_STRATEGIES]).toContain(DEFAULT_LOCAL_ACCOUNT_MATCH_STRATEGY)
    expect(resolveLocalAccountMatchStrategy(undefined)).toBe('local_explicit')
    for (const member of LOCAL_ACCOUNT_MATCH_STRATEGIES) {
      expect(resolveLocalAccountMatchStrategy(member)).toBe(member)
    }
  })

  it('refuses anything outside the set, including near misses and non-strings', () => {
    for (const bad of ['', ' local_explicit', 'LOCAL_EXPLICIT', 'manual_admin', 'name_exact', null, 0, {}, ['local_explicit']]) {
      expect(() => resolveLocalAccountMatchStrategy(bad)).toThrow(LocalDirectoryValidationError)
    }
  })

  it('createLocalAccount refuses an unsupported strategy before touching the database', async () => {
    await expect(
      createLocalAccount({ orgId: 'org-1', localUserId: 'user-1', matchStrategy: 'bulk_import' as never }),
    ).rejects.toBeInstanceOf(LocalDirectoryValidationError)
  })
})
