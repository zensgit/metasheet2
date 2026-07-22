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
// W4-PRE-1c (owner 裁决②, #4522 rev3 review, 2026-07-22): `applyDirectoryDeprovisionPolicies`
// now ALSO resolves the run's org (`SELECT org_id FROM directory_integrations ...`, lazily, at
// most once) and — for a policy that actually executed a write — attempts a same-transaction
// `user_orgs` deactivation via `deactivateUserOrgMembershipIfNoOtherActiveBinding` (a row lock
// SELECT, then a conditional UPDATE). This stub answers all three shapes the same "does not
// evaluate the predicate" way the pre-existing shapes do — the org-scoped sibling predicate
// itself is proved against real Postgres in the real-DB suites (this file's own scope note),
// same discipline extended to the new queries.
const STUB_ORG_ID = 'org-1'

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
      if (/SELECT org_id\s+FROM directory_integrations/i.test(sql)) {
        return { rows: [{ org_id: STUB_ORG_ID }] }
      }
      if (/FROM user_orgs WHERE user_id = \$1::text AND org_id = \$2::text\s+FOR UPDATE/i.test(sql)) {
        return { rows: [] }
      }
      if (/UPDATE user_orgs\s+SET is_active = FALSE/i.test(sql)) {
        return { rows: [] }
      }
      // Anything else is drift: a new query appeared that no test has reasoned about.
      throw new Error(`Unhandled SQL in deprovision stub:\n${sql}`)
    },
  }
}

const wrote = (queries: string[], pattern: RegExp) => queries.some((sql) => pattern.test(sql))
const DEACTIVATES_USER = /UPDATE users SET is_active = FALSE/i
const DEACTIVATES_USER_ORG = /UPDATE user_orgs\s+SET is_active = FALSE/i
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
    // W4-PRE-1c (owner 裁决②): disabled must ALSO never attempt the user_orgs deactivation —
    // this is the unit-level half of mutation ①/② (moving the write before the enabled gate,
    // or dropping the gate); the real-DB half lives in the W4-PRE-1c real-DB suite.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(false)

    // …but the operator gets the preview.
    expect(outcome).toMatchObject({
      applied: false,
      candidateCount: 1,
      usersDeactivatedCount: 1,
      grantsDisabledCount: 1,
      // Preview mode reports what WOULD be attempted too — same construction as
      // grantsDisabledCount (review-finding observability fix).
      membershipDeactivationAttemptedCount: 1,
      abortedReason: null,
    })
  })

  it('enabled + mark_inactive: disables the grant, deactivates the local user, AND attempts the user_orgs deactivation', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: true })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(true)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(true)
    // W4-PRE-1c (owner 裁决②): mark_inactive is a policy that "actually executes" — the
    // user_orgs deactivation attempt must fire in the same run. Whether it actually FLIPS the
    // row depends on the org-scoped sibling check (real-DB suites); this stub cannot evaluate
    // that predicate, only that the write was attempted.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(true)
    expect(outcome.applied).toBe(true)
    expect(outcome.affected).toEqual([{ directoryAccountId: 'acct-1', localUserId: 'user-1', policy: 'mark_inactive' }])
    expect(outcome.membershipDeactivationAttemptedCount).toBe(1)
  })

  it('enabled + disable_grant_only: revokes DingTalk login, leaves the local user active, but STILL attempts the user_orgs deactivation', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationDefaultPolicy: 'disable_grant_only',
      enabled: true,
    })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(true)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    // W4-PRE-1c (owner 裁决②, #4522 rev3 review, phrase "策略实际执行" per issuecomment-5042388830):
    // disable_grant_only is NOT manual_review —
    // it revokes real access (the grant) — so per the owner's own carve-out (only
    // manual_review is excluded), this branch ALSO attempts the user_orgs deactivation, even
    // though it leaves `users.is_active` untouched. Flagged for owner confirmation in the PR
    // body's combination-semantics section: this is a genuinely NEW consequence of
    // disable_grant_only that did not exist before this PR.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(true)
    expect(outcome).toMatchObject({ grantsDisabledCount: 1, usersDeactivatedCount: 0, membershipDeactivationAttemptedCount: 1 })
  })

  it('enabled + manual_review: touches nothing (including user_orgs), but the offboarding is counted and exposed as pending', async () => {
    const client = stubClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationDefaultPolicy: 'manual_review',
      enabled: true,
    })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(false)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
    // W4-PRE-1c (owner 裁决②, #4522 rev3 review — issuecomment-5042388830: "manual_review 保持
    // active 并暴露待人工确认状态"): the
    // unique carve-out — no write attempted at all, including user_orgs.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(false)
    expect(outcome).toMatchObject({ candidateCount: 1, manualReviewCount: 1, affected: [], membershipDeactivationAttemptedCount: 0 })
    expect(outcome.manualReviewPending).toEqual([
      { directoryAccountId: 'acct-1', localUserId: 'user-1', orgId: STUB_ORG_ID },
    ])
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
    // Review finding: the circuit-breaker's negative — "not passed ⇒ user_orgs is NEVER
    // touched" — had no test anywhere in the repo. Without this, a future edit that moved the
    // W4-PRE-1c deactivation call ahead of the abort-and-return (e.g. into the candidate
    // dedup loop) would abort correctly for grants/users but still flip user_orgs, and every
    // existing test (including the two in this describe block) would stay green.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(false)
    expect(outcome.membershipDeactivationAttemptedCount).toBe(0)
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
    // Same breaker-negative coverage as the empty-fetch abort test above.
    expect(wrote(client.queries, DEACTIVATES_USER_ORG)).toBe(false)
    expect(outcome.membershipDeactivationAttemptedCount).toBe(0)
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
