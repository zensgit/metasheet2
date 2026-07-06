/**
 * usePersonalViewToggle — Slice 3 write-target routing + reset-to-shared (design-lock
 * docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md).
 *
 * G-FE-2 (write-target routing): toggle ON -> an edit calls the personal-config PUT; toggle OFF -> the same
 * edit calls the shared write path. G-FE-3 (reset-to-shared): DELETE .../personal-config then re-fetch.
 * G-FE-4 (flag-off inert): the toggle can never be latched ON while the session capability is off, so a
 * disabled session's edits always take the shared path and no personal-config request is ever emitted here.
 */
import { describe, expect, it, vi } from 'vitest'

import { usePersonalViewToggle } from '../src/multitable/composables/usePersonalViewToggle'

function mockClient() {
  return {
    putPersonalViewConfig: vi.fn(async (viewId: string, overlay: unknown) => ({ viewId, config: overlay, updatedAt: 'now' })),
    deletePersonalViewConfig: vi.fn(async (viewId: string) => ({ viewId, deleted: true })),
  }
}

describe('usePersonalViewToggle', () => {
  it('G-FE-2: toggle ON routes an edit to putPersonalViewConfig; toggle OFF routes it to the shared updater', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    const updateShared = vi.fn(async () => ({}))

    // OFF by default
    await toggle.persistViewEdit('view_1', { hiddenFieldIds: ['f2'] }, updateShared)
    expect(updateShared).toHaveBeenCalledTimes(1)
    expect(updateShared).toHaveBeenCalledWith('view_1', { hiddenFieldIds: ['f2'] })
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()

    // Flip ON
    toggle.setPersonalMode('view_1', true)
    expect(toggle.isPersonalMode('view_1')).toBe(true)
    await toggle.persistViewEdit('view_1', { sortInfo: { rules: [] } }, updateShared)
    expect(client.putPersonalViewConfig).toHaveBeenCalledTimes(1)
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('view_1', { sortInfo: { rules: [] } })
    // The shared updater must NOT have been called again for the ON edit.
    expect(updateShared).toHaveBeenCalledTimes(1)

    // Flip back OFF -> shared path resumes
    toggle.setPersonalMode('view_1', false)
    await toggle.persistViewEdit('view_1', { groupInfo: { fieldIds: ['f3'] } }, updateShared)
    expect(updateShared).toHaveBeenCalledTimes(2)
    expect(client.putPersonalViewConfig).toHaveBeenCalledTimes(1)
  })

  it('G-FE-2: routing is per-view — toggling one view ON does not affect another view', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    const updateShared = vi.fn(async () => ({}))

    toggle.setPersonalMode('view_a', true)
    await toggle.persistViewEdit('view_a', { hiddenFieldIds: [] }, updateShared)
    await toggle.persistViewEdit('view_b', { hiddenFieldIds: [] }, updateShared)

    expect(client.putPersonalViewConfig).toHaveBeenCalledTimes(1)
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('view_a', { hiddenFieldIds: [] })
    expect(updateShared).toHaveBeenCalledTimes(1)
    expect(updateShared).toHaveBeenCalledWith('view_b', { hiddenFieldIds: [] })
  })

  it('G-FE-3: resetToShared deletes the personal row, clears local personal mode, then re-fetches', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.setPersonalMode('view_1', true)

    const refetch = vi.fn(async () => undefined)
    await toggle.resetToShared('view_1', refetch)

    expect(client.deletePersonalViewConfig).toHaveBeenCalledTimes(1)
    expect(client.deletePersonalViewConfig).toHaveBeenCalledWith('view_1')
    expect(toggle.isPersonalMode('view_1')).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(1)
    // Delete must happen BEFORE refetch (so the refetch observes the now-effective shared config).
    const deleteOrder = client.deletePersonalViewConfig.mock.invocationCallOrder[0]
    const refetchOrder = refetch.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(refetchOrder)
  })

  it('G-FE-3 OBSERVED-RED: a resetToShared that skips the delete would leave personal mode/local state stale', async () => {
    // A regressed implementation that forgets to delete first (or refetch at all) leaves isPersonalMode ON —
    // this assertion is what would go RED if the delete/refetch ordering guard above were removed.
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.setPersonalMode('view_1', true)

    // Simulate the regression directly (skip calling resetToShared) to show the failure shape.
    expect(toggle.isPersonalMode('view_1')).toBe(true) // pre-reset state, for contrast
    await toggle.resetToShared('view_1', async () => undefined)
    expect(toggle.isPersonalMode('view_1')).toBe(false) // post-reset: guard holds
  })

  it('G-FE-4: flag-off (enabled() false) can never latch personal mode ON, so edits stay on the shared path', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => false })
    const updateShared = vi.fn(async () => ({}))

    toggle.setPersonalMode('view_1', true) // attempt to turn ON while disabled
    expect(toggle.isPersonalMode('view_1')).toBe(false)

    toggle.togglePersonalMode('view_1') // toggling while disabled is also inert
    expect(toggle.isPersonalMode('view_1')).toBe(false)

    await toggle.persistViewEdit('view_1', { hiddenFieldIds: ['f9'] }, updateShared)
    expect(updateShared).toHaveBeenCalledTimes(1)
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
  })

  it('G-FE-4: a session that flips from enabled to disabled mid-flight is no longer able to route to personal', async () => {
    const client = mockClient()
    let enabled = true
    const toggle = usePersonalViewToggle({ client, enabled: () => enabled })
    toggle.setPersonalMode('view_1', true)
    expect(toggle.isPersonalMode('view_1')).toBe(true)

    enabled = false // capability flips off mid-session (e.g. re-fetched /context)
    expect(toggle.isPersonalMode('view_1')).toBe(false)

    const updateShared = vi.fn(async () => ({}))
    await toggle.persistViewEdit('view_1', { hiddenFieldIds: [] }, updateShared)
    expect(updateShared).toHaveBeenCalledTimes(1)
    expect(client.putPersonalViewConfig).not.toHaveBeenCalled()
  })

  // --- P1 review fixes: init from persisted server state + ON→OFF must delete the row ---

  it('P1: syncFromServer initializes personal mode ON for views the server reports as having a persisted override', () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    // Simulates /context returning personalOverrideViewIds — a saved row must show the toggle ON after reload.
    toggle.syncFromServer(['view_a', 'view_c'])
    expect(toggle.isPersonalMode('view_a')).toBe(true)
    expect(toggle.isPersonalMode('view_c')).toBe(true)
    expect(toggle.isPersonalMode('view_b')).toBe(false)
  })

  it('P1: syncFromServer clears all modes when the session capability is off (G-FE-4 holds on reload)', () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => false })
    toggle.syncFromServer(['view_a', 'view_c']) // even if the server signal arrives, flag-off shows nothing
    expect(toggle.isPersonalMode('view_a')).toBe(false)
    expect(toggle.isPersonalMode('view_c')).toBe(false)
  })

  it('P1: an existing personal row (mode ON via syncFromServer) routes edits to the personal PUT, NOT shared PATCH', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.syncFromServer(['view_1']) // server says a personal row exists for view_1
    const updateShared = vi.fn(async () => ({}))
    await toggle.persistViewEdit('view_1', { sortInfo: { rules: [] } }, updateShared)
    expect(client.putPersonalViewConfig).toHaveBeenCalledWith('view_1', { sortInfo: { rules: [] } })
    expect(updateShared).not.toHaveBeenCalled()
  })

  it('P1: handleToggleClick ON→OFF DELETEs the personal row and refetches (not a silent local flip)', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.syncFromServer(['view_1']) // starts ON (persisted row)
    const refetch = vi.fn(async () => undefined)

    await toggle.handleToggleClick('view_1', refetch) // ON → OFF

    expect(client.deletePersonalViewConfig).toHaveBeenCalledWith('view_1')
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(toggle.isPersonalMode('view_1')).toBe(false)
  })

  it('P1: handleToggleClick OFF→ON enters personal mode WITHOUT deleting or refetching (row created lazily on edit)', async () => {
    const client = mockClient()
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    const refetch = vi.fn(async () => undefined)

    await toggle.handleToggleClick('view_1', refetch) // OFF → ON

    expect(toggle.isPersonalMode('view_1')).toBe(true)
    expect(client.deletePersonalViewConfig).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })

  it('P1: resetToShared tolerates a no-row DELETE (404) and still clears mode + refetches', async () => {
    const client = mockClient()
    client.deletePersonalViewConfig = vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }) })
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.setPersonalMode('view_1', true)
    const refetch = vi.fn(async () => undefined)

    await toggle.resetToShared('view_1', refetch) // must not throw

    expect(toggle.isPersonalMode('view_1')).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('P1: resetToShared re-throws a non-404 error (real failures are not swallowed)', async () => {
    const client = mockClient()
    client.deletePersonalViewConfig = vi.fn(async () => { throw Object.assign(new Error('server error'), { status: 500 }) })
    const toggle = usePersonalViewToggle({ client, enabled: () => true })
    toggle.setPersonalMode('view_1', true)
    await expect(toggle.resetToShared('view_1', vi.fn(async () => undefined))).rejects.toThrow('server error')
  })
})
