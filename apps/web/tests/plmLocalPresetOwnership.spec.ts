import { describe, expect, it, vi } from 'vitest'
import {
  runPlmLocalPresetOwnershipAction,
  shouldClearLocalPresetOwnerAfterTeamPresetAction,
  shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore,
} from '../src/views/plm/plmLocalPresetOwnership'

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

  it('keeps the local owner for destructive team preset actions that do not take over the current state', async () => {
    const clearLocalOwner = vi.fn()

    await runPlmLocalPresetOwnershipAction(
      async () => ({ id: 'preset-archived' }),
      {
        clearLocalOwner,
        shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetAction('archive', result),
      },
    )
    await runPlmLocalPresetOwnershipAction(
      async () => ({ processedIds: ['preset-a'] }),
      {
        clearLocalOwner,
        shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetAction('batch-delete', result),
      },
    )

    expect(clearLocalOwner).not.toHaveBeenCalled()
  })

  it('still clears the local owner when a restore-style team preset action reapplies a surviving target', async () => {
    const clearLocalOwner = vi.fn()

    await runPlmLocalPresetOwnershipAction(
      async () => ({ id: 'preset-restored' }),
      {
        clearLocalOwner,
        shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetAction('restore', result),
      },
    )

    expect(clearLocalOwner).toHaveBeenCalledTimes(1)
  })

  it('clears the local owner when clearing a team preset default reapplies a surviving target', async () => {
    const clearLocalOwner = vi.fn()

    await runPlmLocalPresetOwnershipAction(
      async () => ({ id: 'preset-cleared-default' }),
      {
        clearLocalOwner,
        shouldClear: (result) => shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', result),
      },
    )

    expect(clearLocalOwner).toHaveBeenCalledTimes(1)
  })

  it('clears the local owner after batch restore only when the restored preset actually becomes the active owner', () => {
    expect(
      shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(
        { processedIds: ['preset-b'] },
        'preset-b',
        'preset-a',
      ),
    ).toBe(false)

    expect(
      shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(
        { processedIds: ['preset-b'] },
        'preset-b',
        'preset-b',
      ),
    ).toBe(true)
  })
})
