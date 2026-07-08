import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_DEPROVISION_POLICIES,
  applyDirectoryDeprovisionPolicies,
  isDirectoryDeprovisionEnabled,
  resolveDirectoryDeprovisionPolicy,
} from '../../src/directory/directory-sync'

function fakeClient(candidates: Array<{ directory_account_id: string; local_user_id: string; deprovision_policy_override: string | null }>) {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql)
      if (/FROM directory_accounts a/i.test(sql) && /JOIN directory_account_links/i.test(sql)) {
        return { rows: candidates }
      }
      return { rows: [] }
    },
  }
}

const wrote = (queries: string[], pattern: RegExp) => queries.some((sql) => pattern.test(sql))
const DEACTIVATES_USER = /UPDATE users SET is_active = FALSE/i
const DISABLES_GRANT = /INSERT INTO user_external_auth_grants/i

const CANDIDATE = { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: null }

describe('DT-OPS-01 deprovision executor', () => {
  const baseOptions = {
    integrationId: 'dir-1',
    syncTimestamp: '2026-07-08T00:00:00.000Z',
    integrationDefaultPolicy: 'mark_inactive',
  }

  it('DEFAULT-OFF: counts what it would do and writes nothing', async () => {
    const client = fakeClient([CANDIDATE])
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
    })
  })

  it('enabled + mark_inactive: disables the grant AND deactivates the local user', async () => {
    const client = fakeClient([CANDIDATE])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: true })

    expect(wrote(client.queries, DISABLES_GRANT)).toBe(true)
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(true)
    expect(outcome.applied).toBe(true)
    expect(outcome.affected).toEqual([{ directoryAccountId: 'acct-1', localUserId: 'user-1', policy: 'mark_inactive' }])
  })

  it('enabled + disable_grant_only: revokes DingTalk login but leaves the local user active', async () => {
    const client = fakeClient([CANDIDATE])
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
    const client = fakeClient([CANDIDATE])
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
    const client = fakeClient([
      { directory_account_id: 'acct-1', local_user_id: 'user-1', deprovision_policy_override: 'manual_review' },
      { directory_account_id: 'acct-2', local_user_id: 'user-2', deprovision_policy_override: null },
    ])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: true })

    expect(outcome.candidateCount).toBe(2)
    expect(outcome.manualReviewCount).toBe(1)
    expect(outcome.affected.map((a) => a.localUserId)).toEqual(['user-2'])
  })

  it('does nothing when nobody was offboarded', async () => {
    const client = fakeClient([])
    const outcome = await applyDirectoryDeprovisionPolicies(client, { ...baseOptions, enabled: true })
    expect(outcome.candidateCount).toBe(0)
    expect(outcome.affected).toEqual([])
    expect(wrote(client.queries, DEACTIVATES_USER)).toBe(false)
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
