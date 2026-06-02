import { afterEach, describe, expect, it, vi } from 'vitest'

describe('publishMultitableSheetRealtime', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('invalidates the records cache and publishes value-free sheet metadata', async () => {
    const publish = vi.fn()
    vi.doMock('../../src/integration/events/event-bus', () => ({
      eventBus: { publish, emit: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
    }))

    const { publishMultitableSheetRealtime, setRealtimeCacheInvalidator } = await import('../../src/multitable/realtime-publish')
    const invalidate = vi.fn()
    setRealtimeCacheInvalidator(invalidate)

    publishMultitableSheetRealtime({
      spreadsheetId: 'sheet_ops',
      actorId: 'user_editor',
      source: 'multitable',
      kind: 'record-updated',
      recordId: 'rec_1',
      recordIds: ['rec_1'],
      fieldIds: ['fld_secret'],
      recordPatches: [{
        recordId: 'rec_1',
        version: 9,
        patch: { fld_secret: 'SECRET_REALTIME_CANARY' },
      }],
    })

    expect(invalidate).toHaveBeenCalledWith('sheet_ops')
    expect(publish).toHaveBeenCalledWith('spreadsheet.cell.updated', {
      spreadsheetId: 'sheet_ops',
      actorId: 'user_editor',
      source: 'multitable',
      kind: 'record-updated',
      recordId: 'rec_1',
      recordIds: ['rec_1'],
      fieldIds: ['fld_secret'],
    })
    const payload = publish.mock.calls[0]?.[1]
    expect(payload).not.toHaveProperty('recordPatches')
    expect(JSON.stringify(payload)).not.toContain('SECRET_REALTIME_CANARY')
  })
})
