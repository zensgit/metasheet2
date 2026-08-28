import { describe, expect, it, vi } from 'vitest'

import { MultitableApiClient } from '../src/multitable/api/client'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('MultitableApiClient recovery archive routes', () => {
  it('uses the sheet-scoped catalog, whole-sheet preview, and identity-only execute contracts', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, data: {
        entries: [{
          generationId: '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9', recoveryPointAt: '2026-08-29T00:00:00Z',
          archivedAt: '2026-08-29T00:01:00Z', expiresAt: '2026-08-30T00:00:00Z', anchorSeq: '12', coverageRowCount: '7', superseded: false,
        }], nextCursor: 'cursor-2',
      } }))
      .mockResolvedValueOnce(response({ ok: true, data: {
        generationId: '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9', mode: 'revert', scopeKind: 'whole_sheet', executionKind: 'sync',
        executable: true, blockedReason: null, previewIdentity: 'server-preview-identity',
        summary: { reverts: [], resurrectIds: [], deleteIds: [], effectiveWriteCount: 0, keptCreatedAfterAnchorCount: 3, driftCount: 0 },
      } }))
      .mockResolvedValueOnce(response({ ok: true, data: {
        mode: 'revert', anchorSeq: '12', checkpointId: 'checkpoint', revertedCount: 2, resurrectedCount: 0, deletedCount: 0, keptCreatedAfterAnchor: 3,
      } }))
    const client = new MultitableApiClient({ fetchFn })

    const page = await client.listRecoveryArchiveCatalog('sheet/a', { limit: 20 })
    const preview = await client.previewRecoveryArchive('sheet/a', {
      generationId: '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9', mode: 'revert', scope: { kind: 'whole_sheet' },
    })
    const executed = await client.executeRecoveryArchive('sheet/a', {
      previewIdentity: preview.previewIdentity as string, scope: { kind: 'whole_sheet' },
    })

    expect(page.entries).toHaveLength(1)
    expect(page.nextCursor).toBe('cursor-2')
    expect(executed).toMatchObject({ revertedCount: 2, keptCreatedAfterAnchor: 3 })
    expect(fetchFn.mock.calls).toEqual([
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/catalog?limit=20'],
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/preview', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ generationId: '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9', mode: 'revert', scope: { kind: 'whole_sheet' } }),
      })],
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/execute', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ previewIdentity: 'server-preview-identity', scope: { kind: 'whole_sheet' } }),
      })],
    ])
  })

  it('does not expose the caller-planned async job accept endpoint', () => {
    const client = new MultitableApiClient({ fetchFn: vi.fn() }) as unknown as Record<string, unknown>

    expect(client.acceptRecoveryArchiveJob).toBeUndefined()
    expect(client.resumeRecoveryArchiveJob).toBeUndefined()
  })
})
