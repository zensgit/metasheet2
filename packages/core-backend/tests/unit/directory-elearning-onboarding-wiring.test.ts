import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(
  path.resolve(here, '../../src/directory/directory-sync.ts'),
  'utf8',
)

describe('directory e-learning onboarding wiring', () => {
  it('carries the provider hire date into the admitted user row', () => {
    expect(source).toContain('hireDate: resolveDirectoryElearningOnboardingHireDate(')
    expect(source).toMatch(/mobile, hire_date, password_hash/)
    expect(source).toMatch(/options\.mobile,\s+hireDate,\s+options\.passwordHash/)
  })

  it('collects activated admissions and membership reactivations', () => {
    expect(source).toContain('onboardingLifecycleUsers.set(created.userId, directoryUser.hiredDate)')
    expect(source).toMatch(
      /if \([\s\S]*?directoryElearningOnboardingEnabled[\s\S]*?membershipChanged[\s\S]*?!newlyAdmittedUserIds\.has\(localUserId\)[\s\S]*?\) \{[\s\S]*?onboardingLifecycleUsers\.set\(localUserId, directoryUser\?\.hiredDate\)/,
    )
  })

  it('enqueues inside the directory transaction before the durable run completion', () => {
    const enqueueAt = source.indexOf('const onboardingLifecycle = await enqueueDirectoryElearningOnboarding({')
    const completionAt = source.indexOf('UPDATE directory_sync_runs', enqueueAt)
    expect(enqueueAt).toBeGreaterThan(0)
    expect(completionAt).toBeGreaterThan(enqueueAt)
    expect(source).toContain('...(onboardingLifecycle.enabled')
    expect(source).toContain('elearningOnboardingEnqueuedCount: onboardingLifecycle.enqueuedCount')
  })
})
