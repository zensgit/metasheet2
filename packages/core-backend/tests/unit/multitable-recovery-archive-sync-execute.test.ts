import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const syncRestore = vi.hoisted(() => ({
  applyRecoveryArchiveSyncRestore: vi.fn(),
}))

vi.mock('../../src/multitable/recovery-archive-sync-restore', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-sync-restore')>(
    '../../src/multitable/recovery-archive-sync-restore',
  )
  return {
    ...actual,
    applyRecoveryArchiveSyncRestore: syncRestore.applyRecoveryArchiveSyncRestore,
  }
})

import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  type RecoveryArchivePreviewQuery,
  type RecoveryArchivePreviewRuntime,
  type RecoveryArchivePreviewTransaction,
} from '../../src/multitable/recovery-archive-preview'
import {
  executeRecoveryArchiveSync,
  type RecoveryArchiveSyncExecuteInput,
} from '../../src/multitable/recovery-archive-sync-execute'
import { compileRecoveryArchiveSyncPlan } from '../../src/multitable/recovery-archive-sync-plan'
import { RecoveryArchiveReaderError } from '../../src/multitable/recovery-archive-reader'
import { mintExactArchiveRecoveryIdentity } from '../../src/multitable/restore-preview-identity'

const GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const ANCHOR_OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const WORKSPACE_ID = 'workspace-sync'
const BASE_ID = 'base-sync'
const SHEET_ID = 'sheet-sync'
const ACTOR_ID = 'actor-sync'
const ROOT_HASH = 'a'.repeat(64)
const SOURCE_VECTOR_HASH = 'b'.repeat(64)
const KEY_ID = 'key-sync'
const RECORD_ID = 'record-sync'
const FIELD_ID = 'field-sync'
const EXPIRES_AT = '2026-09-28T10:00:00.000Z'
const SHA = (value: string) => value.repeat(64)

const runtime = {
  keyCustody: {},
  objectStore: {},
  transactionDepth: {},
} as RecoveryArchivePreviewRuntime

function token(overrides: Record<string, unknown> = {}) {
  const archivePlanHash = compileRecoveryArchiveSyncPlan({
    workspaceId: WORKSPACE_ID,
    baseId: BASE_ID,
    sheetId: SHEET_ID,
    actorId: ACTOR_ID,
    recoveryMode: 'reset',
    scopeKind: 'selected_fields',
    scopeHash: SHA('c'),
    archiveGenerationId: GENERATION_ID,
    archiveRootHash: ROOT_HASH,
    sourceVectorHash: SOURCE_VECTOR_HASH,
    keyId: KEY_ID,
    selectedRecordIds: [RECORD_ID],
    selectedFieldIds: [FIELD_ID],
  }).planHash
  return mintExactArchiveRecoveryIdentity({
    sheetId: SHEET_ID,
    anchorOperationId: ANCHOR_OPERATION_ID,
    anchorSeq: '9007199254740993',
    checkpointId: 'checkpoint-sync',
    scopeHash: SHA('c'),
    liveSetHash: SHA('d'),
    schemaHash: SHA('e'),
    actorId: ACTOR_ID,
    mode: 'reset',
    authorizedScopeHash: SHA('f'),
    archiveGenerationId: GENERATION_ID,
    archiveRootHash: ROOT_HASH,
    archiveSourceVectorHash: SOURCE_VECTOR_HASH,
    archiveKeyId: KEY_ID,
    archivePlanHash,
    scopeKind: 'selected_fields',
    ...overrides,
  })
}

function archiveRow(overrides: Record<string, unknown> = {}) {
  return {
    generation_id: GENERATION_ID,
    workspace_id: WORKSPACE_ID,
    base_id: BASE_ID,
    sheet_id: SHEET_ID,
    anchor_operation_id: ANCHOR_OPERATION_ID,
    anchor_seq: '9007199254740993',
    checkpoint_id: 'checkpoint-sync',
    root_hash: ROOT_HASH,
    source_vector_hash: SOURCE_VECTOR_HASH,
    key_id: KEY_ID,
    expires_at: EXPIRES_AT,
    ...overrides,
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
      ciphertext_sha256: SHA('2'),
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

function queryFixture(row = archiveRow()) {
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
        if (!normalized.includes(predicate)) throw new Error('archive sync predicate missing')
      }
      const exact = params?.[0] === GENERATION_ID &&
        params?.[1] === WORKSPACE_ID &&
        params?.[2] === BASE_ID &&
        params?.[3] === SHEET_ID
      return { rows: exact ? [row] : [] }
    }
    if (normalized.includes('FROM public.meta_recovery_archive_objects')) {
      return { rows: objectRows() }
    }
    throw new Error(`unexpected query: ${normalized}`)
  })
  return {
    mock: query,
    query: query as unknown as RecoveryArchivePreviewQuery,
  }
}

function transactionFor(query: RecoveryArchivePreviewQuery) {
  return vi.fn(async <T>(work: (fresh: RecoveryArchivePreviewQuery) => Promise<T>) => work(query)) as
    RecoveryArchivePreviewTransaction
}

function input(overrides: Partial<RecoveryArchiveSyncExecuteInput> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    baseId: BASE_ID,
    sheetId: SHEET_ID,
    actorId: ACTOR_ID,
    previewIdentity: token(),
    scope: {
      kind: 'selected_fields' as const,
      recordIds: [RECORD_ID],
      fieldIds: [FIELD_ID],
    },
    recheckAuthority: vi.fn(async () => true),
    preliminaryFullRead: vi.fn(async () => true),
    stabilizeAuthorization: vi.fn(async () => 'ready' as const),
    finalLockedFullRead: vi.fn(async () => true),
    evaluatePlanAuthorization: vi.fn(async () => true),
    auditedReplayHorizonMs: 86_400_000,
    env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' },
    ...overrides,
  } satisfies RecoveryArchiveSyncExecuteInput
}

describe('Time Machine recovery archive synchronous execution', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', 'unit-test-recovery-archive-sync-secret')
    syncRestore.applyRecoveryArchiveSyncRestore.mockReset()
    syncRestore.applyRecoveryArchiveSyncRestore.mockResolvedValue({
      ok: true,
      mode: 'reset',
      anchorSeq: '9007199254740993',
      checkpointId: 'checkpoint-sync',
      applied: { reverts: 1, resurrects: 0, deletes: 0 },
      keptCreatedAfterAnchor: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reselects exact server authority and forwards only the token-bound selected scope to L8', async () => {
    const fixture = queryFixture()
    const supplied = input()

    const result = await executeRecoveryArchiveSync(
      transactionFor(fixture.query),
      fixture.query,
      runtime,
      supplied,
    )

    expect(result).toMatchObject({ ok: true, mode: 'reset' })
    expect(supplied.recheckAuthority).toHaveBeenCalledTimes(1)
    expect(syncRestore.applyRecoveryArchiveSyncRestore).toHaveBeenCalledTimes(1)
    const forwarded = syncRestore.applyRecoveryArchiveSyncRestore.mock.calls[0][0]
    expect(forwarded).toMatchObject({
      query: fixture.query,
      selectedRecordIds: [RECORD_ID],
      selectedFieldIds: [FIELD_ID],
      auditedReplayHorizonMs: 86_400_000,
      archive: {
        selectedBinding: {
          generationId: GENERATION_ID,
          workspaceId: WORKSPACE_ID,
          baseId: BASE_ID,
          sheetId: SHEET_ID,
          rootHash: ROOT_HASH,
          sourceVectorHash: SOURCE_VECTOR_HASH,
        },
      },
      apply: {
        token: supplied.previewIdentity,
        sheetId: SHEET_ID,
        actorId: ACTOR_ID,
      },
    })
  })

  it('rejects wrong actor and scope tokens before opening a catalog transaction', async () => {
    const actorFixture = queryFixture()
    const actorTransaction = transactionFor(actorFixture.query)
    const wrongActor = input({ actorId: 'other-actor' })
    await expect(executeRecoveryArchiveSync(
      actorTransaction,
      actorFixture.query,
      runtime,
      wrongActor,
    )).resolves.toEqual({ ok: false, reason: 'identity-invalid' })
    expect(actorTransaction).not.toHaveBeenCalled()

    const scopeFixture = queryFixture()
    const scopeTransaction = transactionFor(scopeFixture.query)
    const wrongScope = input({ scope: { kind: 'whole_sheet' } })
    await expect(executeRecoveryArchiveSync(
      scopeTransaction,
      scopeFixture.query,
      runtime,
      wrongScope,
    )).resolves.toEqual({ ok: false, reason: 'identity-invalid' })
    expect(scopeTransaction).not.toHaveBeenCalled()
    expect(syncRestore.applyRecoveryArchiveSyncRestore).not.toHaveBeenCalled()
  })

  it('rejects changed selected ids before catalog or archive object reads', async () => {
    const fixture = queryFixture()
    const catalogTransaction = transactionFor(fixture.query)

    const result = await executeRecoveryArchiveSync(
      catalogTransaction,
      fixture.query,
      runtime,
      input({
        scope: {
          kind: 'selected_fields',
          recordIds: ['different-record'],
          fieldIds: [FIELD_ID],
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'identity-invalid' })
    expect(catalogTransaction).not.toHaveBeenCalled()
    expect(fixture.mock).not.toHaveBeenCalled()
    expect(syncRestore.applyRecoveryArchiveSyncRestore).not.toHaveBeenCalled()
  })

  it('fails closed when the selected catalog binding no longer matches signed claims', async () => {
    const fixture = queryFixture(archiveRow({ root_hash: SHA('9') }))

    const result = await executeRecoveryArchiveSync(
      transactionFor(fixture.query),
      fixture.query,
      runtime,
      input(),
    )

    expect(result).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(syncRestore.applyRecoveryArchiveSyncRestore).not.toHaveBeenCalled()
  })

  it('maps archive reader failures to one fixed substrate refusal before L8 writes', async () => {
    const fixture = queryFixture()
    syncRestore.applyRecoveryArchiveSyncRestore.mockRejectedValueOnce(
      new RecoveryArchiveReaderError('RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED'),
    )

    await expect(executeRecoveryArchiveSync(
      transactionFor(fixture.query),
      fixture.query,
      runtime,
      input(),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID' })
  })

  it('refuses disabled and freshly unauthorized execution before D4 or L8', async () => {
    const disabledFixture = queryFixture()
    const disabledTransaction = transactionFor(disabledFixture.query)
    await expect(executeRecoveryArchiveSync(
      disabledTransaction,
      disabledFixture.query,
      runtime,
      input({ env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'false' } }),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_DISABLED' })
    expect(disabledTransaction).not.toHaveBeenCalled()

    const deniedFixture = queryFixture()
    const deniedTransaction = transactionFor(deniedFixture.query)
    await expect(executeRecoveryArchiveSync(
      deniedTransaction,
      deniedFixture.query,
      runtime,
      input({ recheckAuthority: vi.fn(async () => false) }),
    )).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED' })
    expect(deniedFixture.mock).not.toHaveBeenCalled()
    expect(syncRestore.applyRecoveryArchiveSyncRestore).not.toHaveBeenCalled()
  })
})
