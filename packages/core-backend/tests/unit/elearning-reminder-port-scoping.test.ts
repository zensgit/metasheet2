import { afterEach, describe, expect, it, vi } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { PluginContext } from '../../src/types/plugin'

type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }

const FLAG_NAMES = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
  'ELEARNING_MEDIA_ENABLED',
  'ELEARNING_ASSESSMENT_ENABLED',
] as const
const originalFlags = Object.fromEntries(
  FLAG_NAMES.map((name) => [name, process.env[name]]),
)

function contextFor(name: string): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  return (server as unknown as ContextBuilder).createPluginContext({
    manifest: { name, version: '0.0.0' },
    path: `/nonexistent/${name}`,
  })
}

function setFlags(values: Partial<Record<(typeof FLAG_NAMES)[number], string>>): void {
  for (const name of FLAG_NAMES) delete process.env[name]
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const name of FLAG_NAMES) {
    const value = originalFlags[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('e-learning L2 reminder producer port scoping', () => {
  it('injects the narrow port only into plugin-elearning', () => {
    const elearning = contextFor('plugin-elearning').services
    expect(elearning.elearningReminderProducer).toBeDefined()
    expect(typeof elearning.elearningReminderProducer?.produce).toBe('function')
    expect(typeof elearning.elearningExamExpirySettlement?.settle).toBe('function')
    expect(typeof elearning.elearningNotificationEligibility?.check).toBe('function')
    expect(elearning.elearningNotificationDispatch).toBeUndefined()

    expect(contextFor('plugin-attendance').services.elearningReminderProducer).toBeUndefined()
    expect(contextFor('plugin-attendance').services.elearningExamExpirySettlement).toBeUndefined()
    expect(contextFor('plugin-attendance').services.elearningNotificationEligibility).toBeUndefined()
    expect(contextFor('plugin-integration-core').services.elearningReminderProducer).toBeUndefined()
    expect(contextFor('plugin-integration-core').services.elearningExamExpirySettlement).toBeUndefined()
    expect(contextFor('plugin-integration-core').services.elearningNotificationEligibility).toBeUndefined()
    expect(contextFor('plugin-some-other').services.elearningReminderProducer).toBeUndefined()
    expect(contextFor('plugin-some-other').services.elearningExamExpirySettlement).toBeUndefined()
    expect(contextFor('plugin-some-other').services.elearningNotificationEligibility).toBeUndefined()
  })

  it('rechecks master, content, media, and assessment flags before expiry settlement', async () => {
    const port = contextFor('plugin-elearning').services.elearningExamExpirySettlement
    if (!port) throw new Error('expected e-learning exam expiry settlement port')
    const poolGet = vi.spyOn(poolManager, 'get').mockImplementation(() => {
      throw new Error('database touched')
    })
    const input = {
      orgId: 'org-exam-expiry-port',
      attemptId: '11111111-1111-4111-8111-111111111111',
    }
    for (const flags of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'true' },
      {
        ELEARNING_ENABLED: 'true',
        ELEARNING_CONTENT_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: 'true',
      },
      {
        ELEARNING_ENABLED: 'true',
        ELEARNING_CONTENT_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: 'true',
        ELEARNING_ASSESSMENT_ENABLED: 'TRUE',
      },
    ]) {
      setFlags(flags)
      await expect(port.settle(input)).rejects.toMatchObject({ code: 'unavailable' })
    }
    expect(poolGet).not.toHaveBeenCalled()

    setFlags({
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_MEDIA_ENABLED: 'true',
      ELEARNING_ASSESSMENT_ENABLED: 'true',
    })
    await expect(port.settle(input)).rejects.toThrow('database touched')
    expect(poolGet).toHaveBeenCalledTimes(1)
  })

  it('rechecks master, content, and assignment flags before touching the database', async () => {
    const port = contextFor('plugin-elearning').services.elearningReminderProducer
    if (!port) throw new Error('expected e-learning reminder producer port')
    const eligibility = contextFor('plugin-elearning').services.elearningNotificationEligibility
    if (!eligibility) throw new Error('expected e-learning notification eligibility port')
    const poolGet = vi.spyOn(poolManager, 'get').mockImplementation(() => {
      throw new Error('database touched')
    })
    const input = {
      orgId: 'org-port-gate',
      assignmentMemberId: '11111111-1111-4111-8111-111111111111',
      occurrenceKey: 'assignment:a:user:u:window:w',
      windowStart: '2026-08-27T00:00:00.000Z',
      dueAt: '2026-08-27T00:00:00.000Z',
    }
    for (const flags of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'true' },
      {
        ELEARNING_ENABLED: 'true',
        ELEARNING_CONTENT_ENABLED: 'true',
        ELEARNING_ASSIGNMENT_ENABLED: 'TRUE',
      },
    ]) {
      setFlags(flags)
      await expect(port.produce(input)).rejects.toMatchObject({ code: 'unavailable' })
      await expect(eligibility.check({
        orgId: input.orgId,
        assignmentMemberId: input.assignmentMemberId,
        recipientUserId: 'learner',
      })).rejects.toMatchObject({ code: 'unavailable' })
    }
    expect(poolGet).not.toHaveBeenCalled()

    setFlags({
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'true',
    })
    await expect(port.produce(input)).rejects.toThrow('database touched')
    await expect(eligibility.check({
      orgId: input.orgId,
      assignmentMemberId: input.assignmentMemberId,
      recipientUserId: 'learner',
    })).rejects.toThrow('database touched')
    expect(poolGet).toHaveBeenCalledTimes(2)
  })
})
