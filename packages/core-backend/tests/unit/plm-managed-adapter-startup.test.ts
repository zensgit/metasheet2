import { expect, it, vi } from 'vitest'

vi.mock('../../src/auth/AuthService', () => {
  throw new Error('optional_managed_adapter_eagerly_loaded_auth_service')
})

it('keeps ordinary adapter import independent of managed authentication startup', async () => {
  const { PLMAdapter } = await import('../../src/data-adapters/PLMAdapter')
  expect(typeof PLMAdapter).toBe('function')
})
