import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RecoveryArchiveCatalogError,
  type RecoveryArchiveCatalogEntry,
} from '../../src/multitable/recovery-archive-catalog'
import {
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewResult,
} from '../../src/multitable/recovery-archive-preview'
import {
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreJobSnapshot,
} from '../../src/multitable/recovery-archive-restore-jobs'
import {
  registerRecoveryArchiveRestoreOwnerRoutes,
  type RecoveryArchiveRestoreOwnerContext,
  type RecoveryArchiveRestoreOwnerRouteDependencies,
  type RecoveryArchiveRestoreOwnerService,
} from '../../src/routes/recovery-archive-restore-owner'
import { usePinnedServer } from '../utils/pinned-server'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const SHEET_ID = 'sheet-owner-route'
const pinned = usePinnedServer()

const context: RecoveryArchiveRestoreOwnerContext = {
  workspaceId: 'workspace-owner-route',
  baseId: 'base-owner-route',
  sheetId: SHEET_ID,
  actorId: 'actor-owner-route',
  recheckAuthority: async () => true,
  evaluatePlanAuthorization: async () => true,
}

const resolveContext = vi.fn<RecoveryArchiveRestoreOwnerRouteDependencies['resolveContext']>()
const preview = vi.fn<NonNullable<RecoveryArchiveRestoreOwnerService['preview']>>()
const listCatalog = vi.fn<NonNullable<RecoveryArchiveRestoreOwnerService['listCatalog']>>()
const readCatalog = vi.fn<NonNullable<RecoveryArchiveRestoreOwnerService['readCatalog']>>()
const read = vi.fn<RecoveryArchiveRestoreOwnerService['read']>()
const resume = vi.fn<RecoveryArchiveRestoreOwnerService['resume']>()
const cancel = vi.fn<RecoveryArchiveRestoreOwnerService['cancel']>()

function snapshot(
  overrides: Partial<RecoveryArchiveRestoreJobSnapshot> = {},
): RecoveryArchiveRestoreJobSnapshot {
  return {
    id: JOB_ID,
    workspaceId: context.workspaceId,
    baseId: context.baseId,
    sheetId: context.sheetId,
    actorId: context.actorId,
    recoveryMode: 'revert',
    scopeKind: 'whole_sheet',
    state: 'paused_retryable',
    totalCount: '6001',
    completedCount: '5000',
    workerFence: '17',
    resumeDeadline: '2026-08-29T00:00:00.000Z',
    terminalOperationId: '22222222-2222-4222-8222-222222222222',
    terminalAt: null,
    rowVersion: '9',
    ...overrides,
  }
}

function makeApp(serviceOverrides: Partial<RecoveryArchiveRestoreOwnerService> = {}) {
  const app = express()
  app.use(express.json())
  const router = express.Router()
  registerRecoveryArchiveRestoreOwnerRoutes(router, {
    resolveContext,
    service: {
      preview,
      listCatalog,
      readCatalog,
      read,
      resume,
      cancel,
      ...serviceOverrides,
    },
  })
  app.use('/api/multitable', router)
  pinned.setApp(app)
}

function catalogEntry(
  overrides: Partial<RecoveryArchiveCatalogEntry> = {},
): RecoveryArchiveCatalogEntry {
  return {
    generationId: '33333333-3333-4333-8333-333333333333',
    recoveryPointAt: '2026-08-28T09:00:00.000Z',
    archivedAt: '2026-08-28T10:00:00.000Z',
    expiresAt: '2026-09-28T10:00:00.000Z',
    anchorSeq: '9007199254740993',
    coverageRowCount: '77',
    superseded: false,
    ...overrides,
  }
}

function previewResult(
  overrides: Partial<RecoveryArchivePreviewResult> = {},
): RecoveryArchivePreviewResult {
  return {
    generationId: '33333333-3333-4333-8333-333333333333',
    mode: 'revert',
    scopeKind: 'selected_records',
    executionKind: 'sync',
    executable: true,
    blockedReason: null,
    previewIdentity: 'opaque-preview-identity',
    summary: {
      reverts: [{ recordId: 'record-visible', fieldIds: ['field-visible'] }],
      resurrectIds: [],
      deleteIds: [],
      effectiveWriteCount: 1,
      keptCreatedAfterAnchorCount: 0,
      driftCount: 0,
    },
    ...overrides,
  }
}

describe('Time Machine D5 owner routes', () => {
  beforeEach(() => {
    resolveContext.mockReset()
    preview.mockReset()
    listCatalog.mockReset()
    readCatalog.mockReset()
    read.mockReset()
    resume.mockReset()
    cancel.mockReset()
    resolveContext.mockResolvedValue({ ok: true, context })
    preview.mockResolvedValue(previewResult())
    listCatalog.mockResolvedValue({ entries: [catalogEntry()], nextCursor: 'opaque-cursor' })
    readCatalog.mockResolvedValue(catalogEntry())
    read.mockResolvedValue(snapshot())
    resume.mockResolvedValue(snapshot({ state: 'planned' }))
    cancel.mockResolvedValue(snapshot({ state: 'abandoned_partial' }))
    makeApp()
  })

  it('rejects additive preview keys before resolving authority', async () => {
    const result = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/preview`)
      .send({
        generationId: '33333333-3333-4333-8333-333333333333',
        mode: 'revert',
        scope: { kind: 'whole_sheet' },
        rootHash: 'caller-controlled',
      })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Request shape is invalid.' },
    })
    expect(resolveContext).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
  })

  it('projects only values-free preview fields and passes the closed request scope', async () => {
    const result = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/preview`)
      .send({
        generationId: '33333333-3333-4333-8333-333333333333',
        mode: 'revert',
        scope: { kind: 'selected_records', recordIds: ['record-visible'] },
      })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, data: previewResult() })
    expect(preview).toHaveBeenCalledWith(context, {
      generationId: '33333333-3333-4333-8333-333333333333',
      mode: 'revert',
      scope: { kind: 'selected_records', recordIds: ['record-visible'] },
    })
    for (const forbidden of ['rootHash', 'sourceVectorHash', 'keyId', 'planHash', 'targetData']) {
      expect(result.text).not.toContain(forbidden)
    }
  })

  it('maps hidden and invalid preview substrate to fixed values-free responses', async () => {
    preview.mockRejectedValueOnce(new RecoveryArchivePreviewError(
      'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND',
    ))
    preview.mockRejectedValueOnce(new RecoveryArchivePreviewError(
      'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID',
    ))

    const hidden = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/preview`)
      .send({
        generationId: '33333333-3333-4333-8333-333333333333',
        mode: 'revert',
        scope: { kind: 'whole_sheet' },
      })
    const invalid = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/preview`)
      .send({
        generationId: '33333333-3333-4333-8333-333333333333',
        mode: 'revert',
        scope: { kind: 'whole_sheet' },
      })

    expect(hidden.status).toBe(404)
    expect(hidden.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND',
        message: 'Recovery point not found.',
      },
    })
    expect(invalid.status).toBe(503)
    expect(invalid.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID',
        message: 'Archive recovery catalog is unavailable.',
      },
    })
    expect(`${hidden.text}${invalid.text}`).not.toContain(SHEET_ID)
  })

  it('rejects additive catalog query keys before resolving authority', async () => {
    const result = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/catalog?limit=10&workerFence=99`)

    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Request shape is invalid.' },
    })
    expect(resolveContext).not.toHaveBeenCalled()
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('projects bounded catalog pages without hashes, key identity, or owner fields', async () => {
    const listResult = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/catalog?limit=25&cursor=opaque`)
    const getResult = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/catalog/33333333-3333-4333-8333-333333333333`)

    expect(listResult.status).toBe(200)
    expect(listResult.body).toEqual({
      ok: true,
      data: {
        entries: [catalogEntry()],
        nextCursor: 'opaque-cursor',
      },
    })
    expect(getResult.status).toBe(200)
    expect(getResult.body).toEqual({ ok: true, data: catalogEntry() })
    expect(listCatalog).toHaveBeenCalledWith(context, { limit: 25, cursor: 'opaque' })
    expect(readCatalog).toHaveBeenCalledWith(
      context,
      '33333333-3333-4333-8333-333333333333',
    )
    for (const forbidden of ['rootHash', 'sourceVectorHash', 'keyId', 'ownerId', 'ownerFence']) {
      expect(listResult.text).not.toContain(forbidden)
      expect(getResult.text).not.toContain(forbidden)
    }
  })

  it('maps disabled and cross-scope catalog reads to fixed values-free responses', async () => {
    listCatalog.mockRejectedValueOnce(new RecoveryArchiveCatalogError(
      'RECOVERY_ARCHIVE_CATALOG_DISABLED',
    ))
    readCatalog.mockRejectedValueOnce(new RecoveryArchiveCatalogError(
      'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND',
    ))

    const disabled = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/catalog`)
    const hidden = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/catalog/33333333-3333-4333-8333-333333333333`)

    expect(disabled.status).toBe(503)
    expect(disabled.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED',
        message: 'Archive recovery is disabled.',
      },
    })
    expect(hidden.status).toBe(404)
    expect(hidden.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND',
        message: 'Recovery point not found.',
      },
    })
    expect(hidden.text).not.toContain(SHEET_ID)
  })

  it('rejects caller fences and every additive request key before resolving authority', async () => {
    const accept = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/accept`)
      .send({ previewIdentity: 'opaque-token', plan: {}, workerFence: '99' })
    const resumeResult = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}/resume`)
      .send({ workerFence: '99' })
    const status = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}?workerFence=99`)

    for (const result of [accept, resumeResult, status]) {
      expect(result.status).toBe(400)
      expect(result.body).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request shape is invalid.' },
      })
    }
    expect(resolveContext).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('fails closed after authorization when owner policy or archive runtime is not configured', async () => {
    makeApp({ cancel: undefined })
    const acceptResult = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/accept`)
      .send({ previewIdentity: 'opaque-token', plan: {} })
    const cancelResult = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}/cancel`)
      .send({})

    for (const result of [acceptResult, cancelResult]) {
      expect(result.status).toBe(503)
      expect(result.body).toEqual({
        ok: false,
        error: {
          code: 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE',
          message: 'Archive recovery runtime is unavailable.',
        },
      })
    }
    expect(resolveContext).toHaveBeenCalledTimes(2)
    expect(read).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('projects only owner-safe status fields and never exposes authority or worker fences', async () => {
    const result = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}`)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      data: {
        jobId: JOB_ID,
        state: 'paused_retryable',
        totalCount: '6001',
        completedCount: '5000',
        resumeDeadline: '2026-08-29T00:00:00.000Z',
        terminalAt: null,
        rowVersion: '9',
      },
    })
    expect(read).toHaveBeenCalledWith(context, JOB_ID)
    for (const forbidden of [
      'workspaceId',
      'baseId',
      'sheetId',
      'actorId',
      'workerFence',
      'terminalOperationId',
    ]) {
      expect(result.text).not.toContain(forbidden)
    }
  })

  it('passes only the path job identity to owner resume and cancel services', async () => {
    const resumed = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}/resume`)
      .send({})
    const cancelled = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}/cancel`)
      .send({})

    expect(resumed.status).toBe(200)
    expect(cancelled.status).toBe(200)
    expect(resume).toHaveBeenCalledWith(context, JOB_ID)
    expect(cancel).toHaveBeenCalledWith(context, JOB_ID)
  })

  it('existence-hides owner mismatch with a fixed values-free response', async () => {
    read.mockRejectedValue(new RecoveryArchiveRestoreJobError(
      'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND',
    ))
    const result = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}`)

    expect(result.status).toBe(404)
    expect(result.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND',
        message: 'Recovery job not found.',
      },
    })
    expect(result.text).not.toContain(SHEET_ID)
    expect(result.text).not.toContain(JOB_ID)
  })

  it('keeps access refusals and unknown failures values-free', async () => {
    resolveContext.mockResolvedValueOnce({ ok: false, status: 403, code: 'FORBIDDEN' })
    const denied = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}`)

    read.mockRejectedValueOnce(new Error('customer-value-sentinel'))
    const failed = await request(pinned.url())
      .get(`/api/multitable/sheets/${SHEET_ID}/recovery-archive/jobs/${JOB_ID}`)

    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' },
    })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Archive recovery request failed.' },
    })
    expect(failed.text).not.toContain('customer-value-sentinel')
  })
})
