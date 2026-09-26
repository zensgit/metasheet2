import { describe, expect, it } from 'vitest'

describe('tasks auth gate harness', () => {
  it('pins TASKS_ENABLED to the exact string true', () => {
    expect(process.env.TASKS_ENABLED).toBe('true')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
  })
})
