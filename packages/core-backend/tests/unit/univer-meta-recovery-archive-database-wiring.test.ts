import type { Request } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => ({
  ownerDependencies: undefined as unknown,
  preview: vi.fn(),
  executeSync: vi.fn(),
  listCatalog: vi.fn(),
  readCatalog: vi.fn(),
  listJobs: vi.fn(),
  accept: vi.fn(),
  read: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('../../src/routes/recovery-archive-restore-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/routes/recovery-archive-restore-owner')>()),
  registerRecoveryArchiveRestoreOwnerRoutes: vi.fn((_router, dependencies) => {
    routeMocks.ownerDependencies = dependencies
  }),
}))

vi.mock('../../src/multitable/recovery-archive-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-preview')>()),
  previewRecoveryArchive: routeMocks.preview,
}))

vi.mock('../../src/multitable/recovery-archive-sync-execute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-sync-execute')>()),
  executeRecoveryArchiveSync: routeMocks.executeSync,
}))

vi.mock('../../src/multitable/recovery-archive-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-catalog')>()),
  listRecoveryArchiveCatalog: routeMocks.listCatalog,
  readRecoveryArchiveCatalogEntry: routeMocks.readCatalog,
}))

vi.mock('../../src/multitable/recovery-archive-async-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-async-plan')>()),
  acceptFrozenRecoveryArchiveRestoreJob: routeMocks.accept,
}))

vi.mock('../../src/multitable/recovery-archive-restore-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-restore-jobs')>()),
  listRecoveryArchiveRestoreJobs: routeMocks.listJobs,
  readRecoveryArchiveRestoreJobStatus: routeMocks.read,
  resumeRecoveryArchiveRestoreJob: routeMocks.resume,
  cancelRecoveryArchiveRestoreJob: routeMocks.cancel,
}))

vi.mock('../../src/multitable/recovery-authorization-stability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-authorization-stability')>()),
  resolveRecoverySheetAuthority: vi.fn(async () => ({
    access: {
      userId: 'actor',
      isAdminRole: true,
      permissions: [],
    },
    capabilities: {
      canManageSheetAccess: true,
    },
  })),
}))

import { poolManager } from '../../src/integration/db/connection-pool'
import type { RecoveryArchivePreviewRuntime } from '../../src/multitable/recovery-archive-preview'
import type {
  RecoveryArchiveRestoreOwnerContext,
  RecoveryArchiveRestoreOwnerRouteDependencies,
} from '../../src/routes/recovery-archive-restore-owner'
import {
  univerMetaRouter,
  type RecoveryArchiveRouterDatabaseRuntime,
  type UniverMetaRouterOptions,
} from '../../src/routes/univer-meta'

beforeEach(() => {
  routeMocks.ownerDependencies = undefined
  for (const mock of [
    routeMocks.preview,
    routeMocks.executeSync,
    routeMocks.listCatalog,
    routeMocks.readCatalog,
    routeMocks.listJobs,
    routeMocks.accept,
    routeMocks.read,
    routeMocks.resume,
    routeMocks.cancel,
  ]) {
    mock.mockReset()
    mock.mockResolvedValue({})
  }
  routeMocks.executeSync.mockResolvedValue({ ok: false, reason: 'forbidden' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('univer-meta recovery archive database binding', () => {
  it('keeps context and every owner operation on the injected canonical database', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM public.meta_sheets')
        ? [{ base_id: 'base', workspace_id: 'workspace' }]
        : [],
      rowCount: 0,
    }))
    const transaction = vi.fn(async (work) => work(query))
    const transactionDepthProbe = Object.freeze({ currentTransactionDepth: () => 0 })
    const database: RecoveryArchiveRouterDatabaseRuntime = Object.freeze({
      transaction,
      query,
      transactionDepthProbe,
    })
    const runtime = Object.freeze({
      keyCustody: {
        produceGenerationDek: vi.fn(),
        unwrapGenerationDek: vi.fn(),
        deriveDekFingerprint: vi.fn(),
        macManifestRoot: vi.fn(),
        verifyManifestRootMac: vi.fn(),
      },
      objectStore: {
        put: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        deleteExpired: vi.fn(),
        pin: vi.fn(),
      },
      transactionDepth: transactionDepthProbe,
    }) as RecoveryArchivePreviewRuntime
    const options: UniverMetaRouterOptions = Object.freeze({
      recoveryArchiveRuntime: runtime,
      recoveryArchiveDatabaseRuntime: database,
      recoveryArchiveAuditedReplayHorizonMs: 86_400_000,
      recoveryArchiveAsyncResumeHorizonMs: 3_600_000,
    })

    univerMetaRouter(options)
    const dependencies = routeMocks.ownerDependencies as RecoveryArchiveRestoreOwnerRouteDependencies
    expect(dependencies).toBeDefined()

    const getMainPool = vi.spyOn(poolManager, 'get').mockImplementation(() => {
      throw new Error('recovery route re-resolved the main pool')
    })
    const contextResolution = await dependencies.resolveContext(
      {} as Request,
      'sheet',
    )
    expect(contextResolution.ok).toBe(true)

    const context = contextResolution.ok
      ? contextResolution.context
      : fakeContext()
    await dependencies.service.preview?.(context, {
      generationId: 'generation',
      mode: 'revert',
      scope: { kind: 'whole_sheet' },
    })
    await dependencies.service.executeSync?.(context, {
      previewIdentity: 'preview',
      scope: { kind: 'whole_sheet' },
    })
    await dependencies.service.listCatalog?.(context, {})
    await dependencies.service.readCatalog?.(context, 'generation')
    await dependencies.service.listJobs?.(context, {})
    await dependencies.service.accept?.(context, { token: 'preview' })
    await dependencies.service.read(context, 'job')
    await dependencies.service.resume(context, 'job')
    await dependencies.service.cancel?.(context, 'job')

    expect(routeMocks.preview.mock.calls[0]?.slice(0, 3)).toEqual([
      database.transaction,
      database.query,
      runtime,
    ])
    expect(routeMocks.executeSync.mock.calls[0]?.slice(0, 3)).toEqual([
      database.transaction,
      database.query,
      runtime,
    ])
    expect(routeMocks.listCatalog.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(routeMocks.readCatalog.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(routeMocks.listJobs.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(routeMocks.accept.mock.calls[0]?.slice(0, 3)).toEqual([
      database.transaction,
      runtime.objectStore,
      database.transactionDepthProbe,
    ])
    expect(routeMocks.read.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(routeMocks.resume.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(routeMocks.cancel.mock.calls[0]?.[0]).toBe(database.transaction)
    expect(runtime.transactionDepth).toBe(database.transactionDepthProbe)
    expect(query).toHaveBeenCalled()
    expect(getMainPool).not.toHaveBeenCalled()
  })
})

function fakeContext(): RecoveryArchiveRestoreOwnerContext {
  return {
    workspaceId: 'workspace',
    baseId: 'base',
    sheetId: 'sheet',
    actorId: 'actor',
    recheckAuthority: async () => true,
    evaluatePlanAuthorization: async () => true,
  }
}
