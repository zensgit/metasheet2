import { describe, expect, it, vi } from 'vitest'

import { MultitableApiClient } from '../src/multitable/api/client'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const plannedJob = {
  jobId: '55555555-5555-4555-8555-555555555555', state: 'planned', totalCount: '6001', completedCount: '0',
  resumeDeadline: '2026-08-30T00:00:00.000Z', terminalAt: null, rowVersion: '1',
} as const

const catalogEntry = {
  generationId: '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9',
  recoveryPointAt: '2026-08-29T00:00:00Z',
  archivedAt: '2026-08-29T00:01:00Z',
  expiresAt: '2026-08-30T00:00:00Z',
  anchorSeq: '12',
  coverageRowCount: '7',
  superseded: false,
} as const

const recoveryArchiveOperationCases: Array<{
  name: string
  message: string
  call(client: MultitableApiClient): Promise<unknown>
}> = [
  {
    name: 'preview',
    message: 'Invalid recovery archive preview response',
    call: (client) => client.previewRecoveryArchive('sheet/a', {
      generationId: catalogEntry.generationId,
      mode: 'revert',
      scope: { kind: 'whole_sheet' },
    }),
  },
  {
    name: 'execute',
    message: 'Invalid recovery archive execute response',
    call: (client) => client.executeRecoveryArchive('sheet/a', {
      previewIdentity: 'server-preview-identity',
      scope: { kind: 'whole_sheet' },
    }),
  },
  {
    name: 'accept',
    message: 'Invalid recovery archive job response',
    call: (client) => client.acceptRecoveryArchiveJob('sheet/a', 'server-preview-identity'),
  },
  {
    name: 'read',
    message: 'Invalid recovery archive job response',
    call: (client) => client.readRecoveryArchiveJob('sheet/a', plannedJob.jobId),
  },
  {
    name: 'resume',
    message: 'Invalid recovery archive job response',
    call: (client) => client.resumeRecoveryArchiveJob('sheet/a', plannedJob.jobId),
  },
  {
    name: 'cancel',
    message: 'Invalid recovery archive job response',
    call: (client) => client.cancelRecoveryArchiveJob('sheet/a', plannedJob.jobId),
  },
]

describe('MultitableApiClient recovery archive routes', () => {
  it('uses the sheet-scoped catalog, whole-sheet preview, and identity-only execute contracts', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, data: {
        entries: [catalogEntry], nextCursor: 'cursor-2',
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

  it.each([
    true,
    { nextCursor: null },
    { entries: {}, nextCursor: null },
    { entries: [] },
    { entries: [null], nextCursor: null },
    { entries: [{ generationId: catalogEntry.generationId }], nextCursor: null },
    { entries: [{ ...catalogEntry, objectKey: 'internal' }], nextCursor: null },
    { entries: [{ ...catalogEntry, generationId: 'not-a-uuid' }], nextCursor: null },
    { entries: [{ ...catalogEntry, generationId: 5 }], nextCursor: null },
    { entries: [{ ...catalogEntry, recoveryPointAt: 'invalid' }], nextCursor: null },
    { entries: [{ ...catalogEntry, archivedAt: 0 }], nextCursor: null },
    { entries: [{ ...catalogEntry, expiresAt: 'invalid' }], nextCursor: null },
    { entries: [{ ...catalogEntry, anchorSeq: '-1' }], nextCursor: null },
    { entries: [{ ...catalogEntry, anchorSeq: 12 }], nextCursor: null },
    { entries: [{ ...catalogEntry, coverageRowCount: '01' }], nextCursor: null },
    { entries: [{ ...catalogEntry, coverageRowCount: 7 }], nextCursor: null },
    { entries: [{ ...catalogEntry, superseded: 'false' }], nextCursor: null },
    { entries: [], nextCursor: 1 },
  ])('rejects a malformed successful catalog response instead of treating it as absence', async (data) => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(response({ ok: true, data })),
    })

    await expect(client.listRecoveryArchiveCatalog('sheet/a')).rejects.toThrow(
      'Invalid recovery archive catalog response',
    )
  })

  it.each([
    ['204 response', () => new Response(null, { status: 204 })],
    ['empty 200 response', () => new Response('', { status: 200 })],
  ])('rejects a successful %s with the catalog domain error', async (_label, makeResponse) => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(makeResponse()),
    })

    await expect(client.listRecoveryArchiveCatalog('sheet/a')).rejects.toThrow(
      'Invalid recovery archive catalog response',
    )
  })

  it('accepts, reads, resumes, and cancels an async job without sending plan or worker fields', async () => {
    const planned = plannedJob
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, data: planned }, 202))
      .mockResolvedValueOnce(response({ ok: true, data: { ...planned, state: 'applying', completedCount: '2500', rowVersion: '2' } }))
      .mockResolvedValueOnce(response({ ok: true, data: { ...planned, rowVersion: '3' } }))
      .mockResolvedValueOnce(response({ ok: true, data: { ...planned, state: 'cancelled_zero_write', terminalAt: '2026-08-29T01:00:00.000Z', rowVersion: '4' } }))
    const client = new MultitableApiClient({ fetchFn })

    const accepted = await client.acceptRecoveryArchiveJob('sheet/a', 'server-preview-identity')
    await client.readRecoveryArchiveJob('sheet/a', accepted.jobId)
    await client.resumeRecoveryArchiveJob('sheet/a', accepted.jobId)
    const cancelled = await client.cancelRecoveryArchiveJob('sheet/a', accepted.jobId)

    expect(cancelled).toMatchObject({ state: 'cancelled_zero_write', rowVersion: '4' })
    expect(fetchFn.mock.calls).toEqual([
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/jobs/accept', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ previewIdentity: 'server-preview-identity' }),
      })],
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/jobs/55555555-5555-4555-8555-555555555555'],
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/jobs/55555555-5555-4555-8555-555555555555/resume', expect.objectContaining({
        method: 'POST', body: JSON.stringify({}),
      })],
      ['/api/multitable/sheets/sheet%2Fa/recovery-archive/jobs/55555555-5555-4555-8555-555555555555/cancel', expect.objectContaining({
        method: 'POST', body: JSON.stringify({}),
      })],
    ])
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('workerFence')
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('plan')
  })

  it('encodes a bounded job-list cursor as a sheet-scoped GET query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ ok: true, data: {
      entries: [plannedJob], nextCursor: 'opaque-cursor',
    } }))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.listRecoveryArchiveJobs('sheet/a', {
      cursor: 'opaque /?', limit: 1,
    })).resolves.toEqual({ entries: [plannedJob], nextCursor: 'opaque-cursor' })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/multitable/sheets/sheet%2Fa/recovery-archive/jobs?cursor=opaque%20%2F%3F&limit=1',
    )
  })

  it('accepts every closed job state with its valid terminal shape', async () => {
    const terminalAt = '2026-08-29T01:00:00.000Z'
    const entries = [
      plannedJob,
      { ...plannedJob, state: 'applying', completedCount: '2500', rowVersion: '2' },
      { ...plannedJob, state: 'paused_retryable', completedCount: '2500', rowVersion: '3' },
      { ...plannedJob, state: 'done', completedCount: '6001', terminalAt, rowVersion: '4' },
      { ...plannedJob, state: 'abandoned_partial', completedCount: '2500', terminalAt, rowVersion: '5' },
      { ...plannedJob, state: 'cancelled_zero_write', terminalAt, rowVersion: '6' },
    ]
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(response({ ok: true, data: { entries, nextCursor: null } })),
    })

    await expect(client.listRecoveryArchiveJobs('sheet/a')).resolves.toEqual({ entries, nextCursor: null })
  })

  it.each([
    { nextCursor: null },
    { entries: {}, nextCursor: null },
    { entries: [] },
    { entries: [null], nextCursor: null },
    { entries: [{ jobId: plannedJob.jobId }], nextCursor: null },
    { entries: [{ ...plannedJob, state: 'unknown' }], nextCursor: null },
    { entries: [{ ...plannedJob, workerFence: 'internal' }], nextCursor: null },
    { entries: [{ ...plannedJob, jobId: 'not-a-uuid' }], nextCursor: null },
    { entries: [{ ...plannedJob, jobId: 5 }], nextCursor: null },
    { entries: [{ ...plannedJob, totalCount: 'NaN' }], nextCursor: null },
    { entries: [{ ...plannedJob, totalCount: '5000' }], nextCursor: null },
    { entries: [{ ...plannedJob, totalCount: 6001 }], nextCursor: null },
    { entries: [{ ...plannedJob, completedCount: '-1' }], nextCursor: null },
    { entries: [{ ...plannedJob, completedCount: '6002' }], nextCursor: null },
    { entries: [{ ...plannedJob, completedCount: 0 }], nextCursor: null },
    { entries: [{ ...plannedJob, resumeDeadline: 'invalid' }], nextCursor: null },
    { entries: [{ ...plannedJob, resumeDeadline: 0 }], nextCursor: null },
    { entries: [{ ...plannedJob, terminalAt: 'invalid' }], nextCursor: null },
    { entries: [{ ...plannedJob, state: 'done', completedCount: '6001', terminalAt: 0 }], nextCursor: null },
    { entries: [{ ...plannedJob, terminalAt: '2026-08-29T01:00:00.000Z' }], nextCursor: null },
    { entries: [{ ...plannedJob, rowVersion: '0' }], nextCursor: null },
    { entries: [{ ...plannedJob, rowVersion: 1 }], nextCursor: null },
    { entries: [{ ...plannedJob, state: 1 }], nextCursor: null },
    { entries: [{ ...plannedJob, state: 'done', completedCount: '6001' }], nextCursor: null },
    { entries: [{ ...plannedJob, state: 'done', terminalAt: '2026-08-29T01:00:00.000Z' }], nextCursor: null },
    { entries: [{
      ...plannedJob, state: 'cancelled_zero_write', completedCount: '1', terminalAt: '2026-08-29T01:00:00.000Z',
    }], nextCursor: null },
    { entries: [], nextCursor: 1 },
  ])('rejects a malformed successful job-list response instead of treating it as absence', async (data) => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(response({ ok: true, data })),
    })

    await expect(client.listRecoveryArchiveJobs('sheet/a')).rejects.toThrow(
      'Invalid recovery archive job list response',
    )
  })

  it.each([
    ['204 response', () => new Response(null, { status: 204 })],
    ['empty 200 response', () => new Response('', { status: 200 })],
  ])('rejects a successful %s with the job-list domain error', async (_label, makeResponse) => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(makeResponse()),
    })

    await expect(client.listRecoveryArchiveJobs('sheet/a')).rejects.toThrow(
      'Invalid recovery archive job list response',
    )
  })

  it.each(recoveryArchiveOperationCases)(
    'rejects empty or malformed successful $name responses with the domain error',
    async (operation) => {
      const responseFactories = [
        () => response({ ok: true, data: null }),
        () => response({ ok: true }),
        () => new Response(null, { status: 204 }),
        () => new Response('', { status: 200 }),
      ]

      for (const makeResponse of responseFactories) {
        const client = new MultitableApiClient({
          fetchFn: vi.fn().mockResolvedValue(makeResponse()),
        })
        await expect(operation.call(client)).rejects.toThrow(operation.message)
      }
    },
  )
})
