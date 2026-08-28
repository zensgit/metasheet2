import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  buildPreviewPlanDetails: vi.fn(),
  hydrateLiveLinkProjection: vi.fn(),
  loadAuthoritativeLiveLinkEdgesForSheet: vi.fn(),
  loadFieldSurfaceForPreview: vi.fn(),
  loadLiveByIdForPreview: vi.fn(),
  materializeRecoveryArchiveLinksForSync: vi.fn(),
  prepareMaterializedArchiveRecoveryPreviewScopeInternal: vi.fn(),
  readRecoveryArchiveCompleteSectionState: vi.fn(),
}))

vi.mock('../../src/multitable/exact-anchor-recovery-route', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/exact-anchor-recovery-route')>(
    '../../src/multitable/exact-anchor-recovery-route',
  )
  return {
    ...actual,
    buildPreviewPlanDetails: dependencies.buildPreviewPlanDetails,
    loadFieldSurfaceForPreview: dependencies.loadFieldSurfaceForPreview,
    loadLiveByIdForPreview: dependencies.loadLiveByIdForPreview,
  }
})

vi.mock('../../src/multitable/exact-anchor-recovery-execute', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/exact-anchor-recovery-execute')>(
    '../../src/multitable/exact-anchor-recovery-execute',
  )
  return {
    ...actual,
    prepareMaterializedArchiveRecoveryPreviewScopeInternal:
      dependencies.prepareMaterializedArchiveRecoveryPreviewScopeInternal,
  }
})

vi.mock('../../src/multitable/live-link-projection-integrity', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/live-link-projection-integrity')>(
    '../../src/multitable/live-link-projection-integrity',
  )
  return {
    ...actual,
    hydrateLiveLinkProjection: dependencies.hydrateLiveLinkProjection,
    loadAuthoritativeLiveLinkEdgesForSheet: dependencies.loadAuthoritativeLiveLinkEdgesForSheet,
  }
})

vi.mock('../../src/multitable/recovery-archive-reader', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-reader')>(
    '../../src/multitable/recovery-archive-reader',
  )
  return {
    ...actual,
    readRecoveryArchiveCompleteSectionState: dependencies.readRecoveryArchiveCompleteSectionState,
  }
})

vi.mock('../../src/multitable/recovery-archive-sync-restore', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-sync-restore')>(
    '../../src/multitable/recovery-archive-sync-restore',
  )
  return {
    ...actual,
    materializeRecoveryArchiveLinksForSync: dependencies.materializeRecoveryArchiveLinksForSync,
  }
})

import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  previewRecoveryArchive,
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewInput,
  type RecoveryArchivePreviewQuery,
  type RecoveryArchivePreviewRuntime,
  type RecoveryArchivePreviewTransaction,
} from '../../src/multitable/recovery-archive-preview'
import { verifyExactArchiveRecoveryIdentity } from '../../src/multitable/restore-preview-identity'

const GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const ANCHOR_OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const WORKSPACE_ID = 'workspace-preview'
const BASE_ID = 'base-preview'
const SHEET_ID = 'sheet-preview'
const ACTOR_ID = 'actor-preview'
const ROOT_HASH = 'a'.repeat(64)
const SOURCE_VECTOR_HASH = 'b'.repeat(64)
const KEY_ID = 'key-preview'
const RECORD_ID = 'record-preview'
const FIELD_ID = 'field-preview'
const EXPIRES_AT = '2026-09-28T10:00:00.000Z'

const runtime = {
  keyCustody: {},
  objectStore: {},
  transactionDepth: {},
} as RecoveryArchivePreviewRuntime

const liveById = new Map([
  [RECORD_ID, { data: { [FIELD_ID]: 'live' }, version: 7 }],
])
const targetRecords = new Map([
  [RECORD_ID, {
    recordId: RECORD_ID,
    exists: true,
    data: { [FIELD_ID]: 'archived' },
    version: 3,
  }],
])

function summary(overrides: Record<string, unknown> = {}) {
  return {
    reverts: [{ recordId: RECORD_ID, fieldIds: [FIELD_ID] }],
    resurrectIds: [],
    deleteIds: [],
    effectiveWriteCount: 1,
    keptCreatedAfterAnchorCount: 0,
    driftCount: 0,
    ...overrides,
  }
}

function archiveRow() {
  return {
    generation_id: GENERATION_ID,
    workspace_id: WORKSPACE_ID,
    base_id: BASE_ID,
    sheet_id: SHEET_ID,
    anchor_operation_id: ANCHOR_OPERATION_ID,
    anchor_seq: '9007199254740993',
    checkpoint_id: 'checkpoint-preview',
    root_hash: ROOT_HASH,
    source_vector_hash: SOURCE_VECTOR_HASH,
    key_id: KEY_ID,
    expires_at: EXPIRES_AT,
  }
}

function objectRows() {
  return [
    {
      generation_id: GENERATION_ID,
      object_id: '1'.padStart(64, '0'),
      object_class: 'manifest',
      section_name: null,
      key_id: KEY_ID,
      provider_version: 'manifest-version',
      ciphertext_sha256: 'c'.repeat(64),
      size_bytes: '10',
    },
    ...RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName, index) => ({
      generation_id: GENERATION_ID,
      object_id: String(index + 2).padStart(64, '0'),
      object_class: 'section',
      section_name: sectionName,
      key_id: KEY_ID,
      provider_version: `section-version-${index}`,
      ciphertext_sha256: String(index + 10).padStart(64, '0'),
      size_bytes: '20',
    })),
  ]
}

function queryFixture(options: {
  archiveVisible?: boolean
  objects?: readonly Record<string, unknown>[]
} = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ')
    if (normalized.includes('FROM public.meta_recovery_archives')) {
      for (const predicate of [
        'generation_id = $1::uuid',
        'workspace_id = $2',
        'base_id = $3',
        'sheet_id = $4',
        "state = 'verified'",
        "build_status = 'finalized'",
        "coverage_status = 'complete'",
        'expires_at > clock_timestamp()',
        'FROM public.meta_recovery_archive_legal_holds',
        "hold_row.state = 'active'",
      ]) {
        if (!normalized.includes(predicate)) throw new Error('archive authority predicate missing')
      }
      const exactScope = params?.[0] === GENERATION_ID &&
        params?.[1] === WORKSPACE_ID &&
        params?.[2] === BASE_ID &&
        params?.[3] === SHEET_ID
      return { rows: exactScope && options.archiveVisible !== false ? [archiveRow()] : [] }
    }
    if (normalized.includes('FROM public.meta_recovery_archive_objects')) {
      if (!normalized.includes("state = 'verified'")) {
        throw new Error('object receipt predicate missing')
      }
      return { rows: [...(options.objects ?? objectRows())] }
    }
    if (normalized.includes('FROM meta_fields')) {
      return { rows: [{ id: FIELD_ID, type: 'text', property: {} }] }
    }
    throw new Error(`unexpected query: ${normalized}`)
  })
  return {
    mock: query,
    query: query as unknown as RecoveryArchivePreviewQuery,
  }
}

function makeInput(overrides: Partial<RecoveryArchivePreviewInput> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    baseId: BASE_ID,
    sheetId: SHEET_ID,
    actorId: ACTOR_ID,
    generationId: GENERATION_ID,
    mode: 'revert' as const,
    scope: { kind: 'selected_records' as const, recordIds: [RECORD_ID] },
    recheckAuthority: vi.fn(async () => true),
    evaluatePlanAuthorization: vi.fn(async () => true),
    env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' },
    ...overrides,
  } satisfies RecoveryArchivePreviewInput
}

function makeTransaction(
  query: RecoveryArchivePreviewQuery,
  state: { inTransaction: boolean },
) {
  return vi.fn(async <T>(work: (freshQuery: RecoveryArchivePreviewQuery) => Promise<T>) => {
    state.inTransaction = true
    try {
      return await work(query)
    } finally {
      state.inTransaction = false
    }
  }) as RecoveryArchivePreviewTransaction
}

describe('Time Machine recovery archive preview authority', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', 'unit-test-recovery-archive-preview-secret')
    for (const dependency of Object.values(dependencies)) dependency.mockReset()
    dependencies.readRecoveryArchiveCompleteSectionState.mockResolvedValue({
      records: targetRecords,
      links: [],
    })
    dependencies.materializeRecoveryArchiveLinksForSync.mockReturnValue([])
    dependencies.loadLiveByIdForPreview.mockResolvedValue({ ok: true, liveById })
    dependencies.loadFieldSurfaceForPreview.mockResolvedValue({
      fieldIds: new Set([FIELD_ID]),
      fieldById: new Map([[FIELD_ID, { type: 'text' }]]),
      rawTypeById: new Map([[FIELD_ID, 'text']]),
      writableLinkFieldIds: new Set(),
    })
    dependencies.hydrateLiveLinkProjection.mockImplementation(async (_query, live) => live)
    dependencies.loadAuthoritativeLiveLinkEdgesForSheet.mockResolvedValue([])
    dependencies.prepareMaterializedArchiveRecoveryPreviewScopeInternal.mockReturnValue({
      ok: true,
      anchorTarget: targetRecords,
      targetRecords,
      liveById,
    })
    dependencies.buildPreviewPlanDetails.mockReturnValue({
      summary: summary(),
      plan: { reverts: [], resurrects: [], createdAfterAnchor: [], deletedAtAnchorLiveNow: [] },
      revertWrites: [],
      deleteRecordIds: [],
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('selects exact server-owned archive authority and mints only after fresh plan authorization', async () => {
    const fixture = queryFixture()
    const transactionState = { inTransaction: false }
    const transaction = makeTransaction(fixture.query, transactionState)
    dependencies.readRecoveryArchiveCompleteSectionState.mockImplementationOnce(async (request) => {
      expect(transactionState.inTransaction).toBe(false)
      expect(request.selectedBinding).toEqual({
        generationId: GENERATION_ID,
        workspaceId: WORKSPACE_ID,
        baseId: BASE_ID,
        sheetId: SHEET_ID,
        anchorOperationId: ANCHOR_OPERATION_ID,
        anchorSeq: '9007199254740993',
        checkpointId: 'checkpoint-preview',
        rootHash: ROOT_HASH,
        sourceVectorHash: SOURCE_VECTOR_HASH,
      })
      expect(request.manifestObject).toMatchObject({
        generationId: GENERATION_ID,
        expectedVersion: 'manifest-version',
        expectedExpiresAt: EXPIRES_AT,
      })
      expect(request.sectionObjects).toHaveLength(RECOVERY_ARCHIVE_V1_SECTION_NAMES.length)
      return { records: targetRecords, links: [] }
    })
    const input = makeInput()

    const result = await previewRecoveryArchive(transaction, fixture.query, runtime, input)

    expect(result).toMatchObject({
      generationId: GENERATION_ID,
      mode: 'revert',
      scopeKind: 'selected_records',
      executionKind: 'sync',
      executable: true,
      blockedReason: null,
      summary: summary(),
    })
    expect(result.previewIdentity).toEqual(expect.any(String))
    const verified = verifyExactArchiveRecoveryIdentity(result.previewIdentity!, {
      sheetId: SHEET_ID,
      actorId: ACTOR_ID,
    })
    expect(verified.valid).toBe(true)
    expect(verified.claims).toMatchObject({
      archiveGenerationId: GENERATION_ID,
      archiveRootHash: ROOT_HASH,
      archiveSourceVectorHash: SOURCE_VECTOR_HASH,
      archiveKeyId: KEY_ID,
      mode: 'revert',
      scopeKind: 'selected_records',
    })
    expect(input.recheckAuthority).toHaveBeenCalledTimes(1)
    expect(input.evaluatePlanAuthorization).toHaveBeenCalledTimes(1)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('refuses disabled and freshly unauthorized requests before archive or object reads', async () => {
    const disabledFixture = queryFixture()
    const disabledTransaction = makeTransaction(disabledFixture.query, { inTransaction: false })
    await expect(previewRecoveryArchive(
      disabledTransaction,
      disabledFixture.query,
      runtime,
      makeInput({ env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'false' } }),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_DISABLED' })
    expect(disabledTransaction).not.toHaveBeenCalled()

    const deniedFixture = queryFixture()
    const deniedTransaction = makeTransaction(deniedFixture.query, { inTransaction: false })
    await expect(previewRecoveryArchive(
      deniedTransaction,
      deniedFixture.query,
      runtime,
      makeInput({ recheckAuthority: vi.fn(async () => false) }),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED' })
    expect(deniedFixture.mock).not.toHaveBeenCalled()
    expect(dependencies.readRecoveryArchiveCompleteSectionState).not.toHaveBeenCalled()
  })

  it('existence-hides a generation outside the exact workspace, base, and sheet scope', async () => {
    const fixture = queryFixture()
    const transaction = makeTransaction(fixture.query, { inTransaction: false })

    await expect(previewRecoveryArchive(
      transaction,
      fixture.query,
      runtime,
      makeInput({ workspaceId: 'other-workspace' }),
    )).rejects.toEqual(new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND'))
    expect(dependencies.readRecoveryArchiveCompleteSectionState).not.toHaveBeenCalled()
  })

  it('refuses an additive verified section row instead of silently collapsing the roster', async () => {
    const rows = objectRows()
    rows.push({ ...rows[1], object_id: 'f'.repeat(64) })
    const fixture = queryFixture({ objects: rows })
    const transaction = makeTransaction(fixture.query, { inTransaction: false })

    await expect(previewRecoveryArchive(
      transaction,
      fixture.query,
      runtime,
      makeInput(),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID' })
    expect(dependencies.readRecoveryArchiveCompleteSectionState).not.toHaveBeenCalled()
  })

  it('does not mint a token for no-op, schema-drift, or resurrection plans', async () => {
    for (const [blockedReason, blockedSummary] of [
      ['no_changes', summary({ reverts: [], effectiveWriteCount: 0 })],
      ['schema_drift', summary({ driftCount: 1 })],
      ['inbound_unprovable', summary({ resurrectIds: ['record-resurrect'] })],
    ] as const) {
      dependencies.buildPreviewPlanDetails.mockReturnValueOnce({
        summary: blockedSummary,
        plan: { reverts: [], resurrects: [], createdAfterAnchor: [], deletedAtAnchorLiveNow: [] },
        revertWrites: [],
        deleteRecordIds: [],
      })
      const fixture = queryFixture()
      const result = await previewRecoveryArchive(
        makeTransaction(fixture.query, { inTransaction: false }),
        fixture.query,
        runtime,
        makeInput(),
      )
      expect(result).toMatchObject({
        executable: false,
        blockedReason,
        previewIdentity: null,
      })
    }
  })

  it('requires fresh write authorization even when the computed plan would be blocked', async () => {
    dependencies.buildPreviewPlanDetails.mockReturnValueOnce({
      summary: summary({ reverts: [], effectiveWriteCount: 0 }),
      plan: { reverts: [], resurrects: [], createdAfterAnchor: [], deletedAtAnchorLiveNow: [] },
      revertWrites: [],
      deleteRecordIds: [],
    })
    const fixture = queryFixture()

    await expect(previewRecoveryArchive(
      makeTransaction(fixture.query, { inTransaction: false }),
      fixture.query,
      runtime,
      makeInput({ evaluatePlanAuthorization: vi.fn(async () => false) }),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED' })
  })

  it('classifies over-threshold scope as async without minting a sync token', async () => {
    const largeTarget = new Map(
      Array.from({ length: 5001 }, (_, index) => [
        `record-${index}`,
        { recordId: `record-${index}`, exists: true, data: {}, version: 1 },
      ]),
    )
    dependencies.prepareMaterializedArchiveRecoveryPreviewScopeInternal.mockReturnValueOnce({
      ok: true,
      anchorTarget: largeTarget,
      targetRecords,
      liveById,
    })
    const fixture = queryFixture()

    const result = await previewRecoveryArchive(
      makeTransaction(fixture.query, { inTransaction: false }),
      fixture.query,
      runtime,
      makeInput(),
    )

    expect(result).toMatchObject({
      executionKind: 'async',
      executable: false,
      blockedReason: 'async_plan_required',
      previewIdentity: null,
    })
  })
})
