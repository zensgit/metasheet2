import { describe, expect, it, vi } from 'vitest'

import { enqueueDirectoryElearningOnboarding } from '../../src/directory/elearning-onboarding-lifecycle'
import { ElearningOnboardingAssignmentError } from '../../src/services/elearning-onboarding-assignment'

const ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
}

function input(env: NodeJS.ProcessEnv = ON) {
  return {
    client: {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    },
    orgId: 'org-onboarding-lifecycle',
    users: [
      { userId: 'user-b' },
      { userId: 'user-a', hiredDate: '2026-08-31' },
      { userId: 'user-a', hiredDate: '2026-08-31' },
    ],
    eventAt: '2026-08-31T01:02:03.000Z',
    env,
  }
}

describe('directory e-learning onboarding lifecycle', () => {
  it.each([
    {},
    { ...ON, ELEARNING_ENABLED: 'TRUE' },
    { ...ON, ELEARNING_CONTENT_ENABLED: '1' },
    { ...ON, ELEARNING_ASSIGNMENT_ENABLED: 'yes' },
  ])('does no SQL or enqueue work unless all exact flags are true', async (env) => {
    const value = input(env)
    const enqueue = vi.fn()
    await expect(enqueueDirectoryElearningOnboarding(value, enqueue)).resolves.toEqual({
      enabled: false,
      candidateUserCount: 0,
      eligibleUserCount: 0,
      skippedUserCount: 0,
      matchedPolicyCount: 0,
      enqueuedCount: 0,
    })
    expect(enqueue).not.toHaveBeenCalled()
    expect(value.client.query).not.toHaveBeenCalled()
  })

  it('does not enumerate or validate candidates while disabled', async () => {
    const value = input({})
    value.users = [{ userId: '', hiredDate: '2026-02-31' }]
    await expect(enqueueDirectoryElearningOnboarding(value, vi.fn())).resolves.toMatchObject({
      enabled: false,
      candidateUserCount: 0,
    })
    expect(value.client.query).not.toHaveBeenCalled()
  })

  it('deduplicates users, fills only a missing hire date, and skips an ineligible candidate', async () => {
    const value = input()
    const enqueue = vi.fn()
      .mockResolvedValueOnce({ matchedPolicyCount: 2, enqueuedCount: 2 })
      .mockRejectedValueOnce(new ElearningOnboardingAssignmentError('not_eligible'))

    await expect(enqueueDirectoryElearningOnboarding(value, enqueue)).resolves.toEqual({
      enabled: true,
      candidateUserCount: 2,
      eligibleUserCount: 1,
      skippedUserCount: 1,
      matchedPolicyCount: 2,
      enqueuedCount: 2,
    })
    expect(enqueue.mock.calls.map((call) => call[1])).toEqual([
      { orgId: 'org-onboarding-lifecycle', userId: 'user-a', eventAt: '2026-08-31T01:02:03.000Z' },
      { orgId: 'org-onboarding-lifecycle', userId: 'user-b', eventAt: '2026-08-31T01:02:03.000Z' },
    ])
    const fillSql = value.client.query.mock.calls[0]?.[0]
    expect(fillSql).toContain('directory-elearning-onboarding:fill-hire-date')
    expect(fillSql).toContain('COALESCE(platform_user.hire_date, $3::date)')
    expect(fillSql).toContain('platform_user.hire_date IS NULL')
    expect(value.client.query).toHaveBeenCalledWith(
      expect.any(String),
      ['org-onboarding-lifecycle', 'user-a', '2026-08-31'],
    )
  })

  it('rejects conflicting source hire dates before doing SQL', async () => {
    const value = input()
    value.users = [
      { userId: 'user-a', hiredDate: '2026-08-30' },
      { userId: 'user-a', hiredDate: '2026-08-31' },
    ]
    await expect(enqueueDirectoryElearningOnboarding(value, vi.fn())).rejects.toThrow(
      'Conflicting directory onboarding hire date',
    )
    expect(value.client.query).not.toHaveBeenCalled()
  })

  it('rejects an impossible source hire date before doing SQL', async () => {
    const value = input()
    value.users = [{ userId: 'user-a', hiredDate: '2026-02-31' }]
    await expect(enqueueDirectoryElearningOnboarding(value, vi.fn())).rejects.toThrow(
      'Invalid directory onboarding hire date',
    )
    expect(value.client.query).not.toHaveBeenCalled()
  })

  it('fails the directory transaction closed for queue or authority failures', async () => {
    const error = new ElearningOnboardingAssignmentError('unavailable')
    const enqueue = vi.fn().mockRejectedValue(error)
    await expect(enqueueDirectoryElearningOnboarding(input(), enqueue)).rejects.toBe(error)
  })
})
