import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_DEPROVISION_POLICIES,
  applyDirectoryDeprovisionPolicies,
  evaluateDirectoryDeprovisionCircuitBreaker,
  isDirectoryDeprovisionEnabled,
  resolveDirectoryDeprovisionPolicy,
} from '../../src/directory/directory-sync'

/**
 * SCOPE NOTE — read before adding a test here.
 *
 * A stub client cannot evaluate a `WHERE`. Whatever candidate rows it is handed come back
 * regardless of what the selection SQL says, so nothing in this file can prove *who* gets
 * deprovisioned. An earlier revision missed that: inverting the selection to target every
 * active employee left the whole suite green.
 *
 * So the selection predicate — the sibling guard, the this-run-only transition, the unlinked
 * account — is proved against real Postgres in
 * `tests/integration/directory-deprovision-selection.db.test.ts`, which is wired as a whole
 * file into the approval real-DB step of plugin-tests.yml.
 *
 * What IS unit-testable, and lives here: given candidate rows, the per-person grouping and
 * policy dispatch; the write-shape of each policy; the circuit breaker; the env gate; and the
 * fail-safe direction of policy resolution.
 */
function stubClient(candidates: Array<{ directory_account_id: string; local_user_id: string; deprovision_policy_override: string | null }>) {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql)
      if (/FROM directory_accounts a/i.test(sql) && /JOIN directory_account_links/i.test(sql)) {
        // The stub answers the selection query with whatever the test asked for. It does NOT
        // evaluate the predicate — see the scope note.
        return { rows: candidates }
      }
      if (/INSERT INTO user_external_auth_grants/i.test(sql) || /UPDATE users SET is_active = FALSE/i.test(sql)) {
        return { rows: [] }
      }
      // Anything else is drift: a new query appeared that no test has reasoned about.
      throw new Error(`Unhandled SQL in deprovision stub:\n${sql}`)
    },
  }
}

const wrote = (queries: string[], pattern: RegExp) => queries.some((sql) => pattern.test(sql))
const DEACTIVATES_USER = /UPDATE users SET is_active = FALSE/i
const DISABLES_GRANT = /INSERT INTO user_external_auth_grants/i

const CANDIDATE = { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: null }

describe('DT-OPS-01 deprovision executor (policy dispatch, given candidates)', () => {
  const baseOptions = {
    integrationId: 'dir-1',
    deactivatedAccountIds: ['acct-1'],
    syncedAccountCount: 100,
    integrationDefaultPolicy: 'mark_inactive',
  }

  it('DEFAULT-OFF: counts what it would do and writes nothing', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: false })

    // The load-bearing safety property: merging this cannot deactivate anyone.
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    expect(wrote(client.queries, DISABLES_GRANT)).toBe(false)

    // …but the operator gets the preview.
    expect(outcome).toMatchObject({
      applied: false,
      candidateCount: 1,
      usersDeactivatedCount: 1,
      grantsDisabledCount: 1,
      abortedReason: null,
    })
  })

  it('enabled + mark_inactive: disables the grant AND deactivates the local user', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: true })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(true)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(true)
    expect(outcome.applied).toBe(true)
    expect(outcome.affected).toEqual([{ directoryAccountId: 'acct-1', localUserId: 'user-1', policy: 'mark_inactive' }])
  })

  it('enabled + disable_grant_only: revokes DingTalk login but leaves the local user active', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationDefaultPolicy: 'disable_grant_only',
      enabled: true,
    })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(true)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    expect(outcome).toMatchObject({ grantsDisabledCount: 1, usersDeactivatedCount: 0 })
  })

  it('enabled + manual_review: touches nothing, but the offboarding is counted', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationDefaultPolicy: 'manual_review',
      enabled: true,
    })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(false)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    expect(outcome).toMatchObject({ candidateCount: 1, manualReviewCount: 1, affected: [] })
  })

  it('honours a per-account override inside a batch', async () => {
    const client = stubClient([
      { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: 'manual_review' },
      { directory_account_id: 'acct-2', local_user_id: 'user-2', deprovision_policy_override: null },
    ])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      deactivatedAccountIds: ['acct-1', 'acct-2'],
      enabled: true,
    })

    expect(outcome.candidateCount).toBe(2)
    expect(outcome.manualReviewCount).toBe(1)
    expect(outcome.affected.map((a) => a.localUserId)).toEqual(['user-2'])
  })

  // One PERSON, two departed badges. Deactivating them twice would double-count the audit and
  // — worse — let the harsher of two policies win a decision the gentler one already made.
  it('decides once per person, and the least destructive policy wins', async () => {
    const client = stubClient([
      { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: 'mark_inactive' },
      { directory_account_id: 'acct-2', local_user_id: 'user-1', deprovision_policy_override: 'manual_review' },
    ])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      deactivatedAccountIds: ['acct-1', 'acct-2'],
      enabled: true,
    })

    expect(outcome.candidateCount).toBe(1)
    expect(outcome.manualReviewCount).toBe(1)
    expect(outcome.usersDeactivatedCount).toBe(0)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
  })

  it('does not even query when this run offboarded nobody', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      deactivatedAccountIds: [],
      enabled: true,
    })
    expect(client.queries).toEqual([])
    expect(outcome.candidateCount).toBe(0)
    expect(outcome.affected).toEqual([])
  })

  it('an empty directory fetch aborts before any write, even with candidates in hand', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      syncedAccountCount: 0,
      enabled: true,
    })

    expect(outcome.abortedReason).toBe('empty_directory_fetch')
    expect(outcome.applied).toBe(false)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    expect(wrote(client.queries, DISABLES_GRANT)).toBe(false)
  })

  it('an oversized batch aborts before any write', async () => {
    const client = stubClient([
      { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: null },
      { directory_account_id: 'acct-2', local_user_id: 'user-2', deprovision_policy_override: null },
    ])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      deactivatedAccountIds: ['acct-1', 'acct-2'],
      maxBatch: 1,
      enabled: true,
    })

    expect(outcome.abortedReason).toBe('batch_exceeds_max')
    expect(outcome.applied).toBe(false)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
  })
})

/**
 * The circuit breaker exists because "absent from the fetch" is not "departed". A blank `name`
 * is silently dropped by the DingTalk client, a missing `list` yields zero users with no error,
 * `contain_access_limit:false` hides restricted members, and a narrowed root department shrinks
 * the whole tree. Any of those looks exactly like a company-wide resignation.
 */
describe('DT-OPS-01 circuit breaker', () => {
  it('refuses to act when the fetch returned zero accounts', () => {
    expect(evaluateDirectoryDeprovisionCircuitBreaker({ syncedAccountCount: 0, candidateCount: 1 }))
      .toBe('empty_directory_fetch')
    // Zero fetched wins even when nothing was selected — the fetch itself is untrustworthy.
    expect(evaluateDirectoryDeprovisionCircuitBreaker({ syncedAccountCount: 0, candidateCount: 0 }))
      .toBe('empty_directory_fetch')
  })

  it('refuses a batch larger than the cap, and permits one exactly at it', () => {
    expect(evaluateDirectoryDeprovisionCircuitBreaker({ syncedAccountCount: 10, candidateCount: 3, maxBatch: 2 }))
      .toBe('batch_exceeds_max')
    expect(evaluateDirectoryDeprovisionCircuitBreaker({ syncedAccountCount: 10, candidateCount: 2, maxBatch: 2 }))
      .toBeNull()
  })

  it('permits an ordinary run', () => {
    expect(evaluateDirectoryDeprovisionCircuitBreaker({ syncedAccountCount: 500, candidateCount: 3 })).toBeNull()
  })
})

/**
 * DT-OPS-01 — offboarding policy.
 *
 * The policy columns have existed since the schema was created and were never enforced:
 * removing a member from DingTalk deactivated the shadow account but left their LOCAL
 * account active, so password login kept working.
 *
 * Two hazards constrain the fix, and both are asserted here:
 *  - the column's DB default is already `mark_inactive`, so honouring the stored value
 *    naively would start deactivating users on the next sync of EVERY existing
 *    integration → the executor is env-gated, default off;
 *  - an unrecognised stored value must never be read as "do something destructive".
 */
describe('DT-OPS-01 deprovision policy resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is disabled unless explicitly enabled', () => {
    expect(isDirectoryDeprovisionEnabled()).toBe(false)
    vi.stubEnv('DIRECTORY_DEPROVISION_ENABLED', 'false')
    expect(isDirectoryDeprovisionEnabled()).toBe(false)
    vi.stubEnv('DIRECTORY_DEPROVISION_ENABLED', 'nope')
    expect(isDirectoryDeprovisionEnabled()).toBe(false)
  })

  it('accepts the documented truthy spellings', () => {
    for (const value of ['true', 'TRUE', ' 1 ', 'yes']) {
      vi.stubEnv('DIRECTORY_DEPROVISION_ENABLED', value)
      expect(isDirectoryDeprovisionEnabled()).toBe(true)
    }
  })

  it('exposes exactly the three supported policies', () => {
    expect([...DIRECTORY_DEPROVISION_POLICIES]).toEqual(['manual_review', 'disable_grant_only', 'mark_inactive'])
  })

  it('lets a per-account override win over the integration default', () => {
    expect(resolveDirectoryDeprovisionPolicy('mark_inactive', 'manual_review')).toBe('manual_review')
    expect(resolveDirectoryDeprovisionPolicy('manual_review', 'mark_inactive')).toBe('mark_inactive')
  })

  it('falls back to the integration default when there is no override', () => {
    expect(resolveDirectoryDeprovisionPolicy('disable_grant_only', null)).toBe('disable_grant_only')
    expect(resolveDirectoryDeprovisionPolicy('disable_grant_only', '  ')).toBe('disable_grant_only')
  })

  it('degrades an unknown or missing policy to review-only, never to a destructive action', () => {
    expect(resolveDirectoryDeprovisionPolicy('delete_everything', null)).toBe('manual_review')
    expect(resolveDirectoryDeprovisionPolicy(null, 'DROP TABLE users')).toBe('manual_review')
    expect(resolveDirectoryDeprovisionPolicy(null, null)).toBe('manual_review')
    expect(resolveDirectoryDeprovisionPolicy(undefined, undefined)).toBe('manual_review')
    // Case matters: the stored vocabulary is exact.
    expect(resolveDirectoryDeprovisionPolicy('MARK_INACTIVE', null)).toBe('manual_review')
  })
})
