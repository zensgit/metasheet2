import { describe, expect, it, vi } from 'vitest'
import { strictGuardLookups } from '../strict-guard-lookups'

vi.mock('../namespace-admission', () => ({
  derivePermissionNamespace: (code: string) => code.split(':')[0],
  inspectPermissionCodesByNamespaceAdmission: vi.fn().mockResolvedValue({ codes: [], unavailable: false }),
}))

describe('strict transaction guard lookups', () => {
  it('does not reach a direct grant when namespace admission denies the requested code', async () => {
    const query = vi.fn(async () => ({ rows: [{}] }))
    expect(await strictGuardLookups(query).hasPermission('subject', 'attendance:read')).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
})
