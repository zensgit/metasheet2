import { afterEach, describe, expect, it, vi } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { PluginContext } from '../../src/types/plugin'

type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }

const FLAG_NAMES = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
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

    expect(contextFor('plugin-attendance').services.elearningReminderProducer).toBeUndefined()
    expect(contextFor('plugin-integration-core').services.elearningReminderProducer).toBeUndefined()
    expect(contextFor('plugin-some-other').services.elearningReminderProducer).toBeUndefined()
  })

  it('rechecks master, content, and assignment flags before touching the database', async () => {
    const port = contextFor('plugin-elearning').services.elearningReminderProducer
    if (!port) throw new Error('expected e-learning reminder producer port')
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
    }
    expect(poolGet).not.toHaveBeenCalled()

    setFlags({
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'true',
    })
    await expect(port.produce(input)).rejects.toThrow('database touched')
    expect(poolGet).toHaveBeenCalledTimes(1)
  })
})
