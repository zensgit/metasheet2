import { describe, expect, it } from 'vitest'
import { readDeprovisionRuntimeFlags } from '../../src/directory/deprovision-evidence-api'

describe('readDeprovisionRuntimeFlags', () => {
  it('defaults deprovision writer OFF', () => {
    const prev = process.env.DIRECTORY_DEPROVISION_ENABLED
    delete process.env.DIRECTORY_DEPROVISION_ENABLED
    const flags = readDeprovisionRuntimeFlags()
    expect(flags.enabled).toBe(false)
    expect(flags.maxBatch).toBe(25)
    expect(flags.policyNote).toMatch(/策略≠已执行/)
    if (prev === undefined) delete process.env.DIRECTORY_DEPROVISION_ENABLED
    else process.env.DIRECTORY_DEPROVISION_ENABLED = prev
  })
})
