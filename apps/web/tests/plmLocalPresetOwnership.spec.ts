import { describe, expect, it, vi } from 'vitest'
import { runPlmLocalPresetOwnershipAction } from '../src/views/plm/plmLocalPresetOwnership'

describe('plmLocalPresetOwnership', () => {
  it('clears the local owner after a successful save-style action', async () => {
    const clearLocalOwner = vi.fn()

    await runPlmLocalPresetOwnershipAction(
      async () => undefined,
      { clearLocalOwner },
    )

    expect(clearLocalOwner).toHaveBeenCalledTimes(1)
  })

  it('does not clear the local owner when the action throws', async () => {
    const clearLocalOwner = vi.fn()

    await expect(runPlmLocalPresetOwnershipAction(
      async () => {
        throw new Error('save failed')
      },
      { clearLocalOwner },
    )).rejects.toThrow('save failed')

    expect(clearLocalOwner).not.toHaveBeenCalled()
  })

  it('clears the local owner only when a promote-style action returns a surviving target', async () => {
    const clearLocalOwner = vi.fn()

    const result = await runPlmLocalPresetOwnershipAction(
      async () => null,
      {
        clearLocalOwner,
        shouldClear: (saved) => Boolean(saved),
      },
    )

    expect(result).toBeNull()
    expect(clearLocalOwner).not.toHaveBeenCalled()
  })
})
