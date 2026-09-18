import { describe, expect, test, vi } from 'vitest'
import type { ExactAnchorPlanAuthContext } from '../../src/multitable/exact-anchor-recovery-execute'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveWorkerIdentity } from '../../src/multitable/recovery-archive-async-restore'
import { createRecoveryArchiveWorkerAuthorization, createRecoveryArchiveManualContinuation } from '../../src/routes/univer-meta'
import { createHash, randomUUID } from 'node:crypto'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import type { RecoveryArchivePreparedUploadInput } from '../../src/multitable/recovery-archive-prepared-upload'
import { bindRecoveryArchiveScopeAuthorization } from '../../src/multitable/recovery-archive-worker-authorization'

const identity: RecoveryArchiveWorkerIdentity = Object.freeze({ jobId: 'job', actorId: 'actor', workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' })
function database() {
  const state = { active: true, exists: true, base: 'base', workspace: 'workspace' }
  const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async (sql) => {
    if (sql.includes('SELECT sheet_row.base_id')) {
      expect(sql).toContain('sheet_row.deleted_at IS NULL')
      expect(sql).toContain('base_row.deleted_at IS NULL')
      return { rows: state.exists ? [{ base_id: state.base, workspace_id: state.workspace }] : [] }
    }
    if (sql.includes('FROM users')) return { rows: [{ role: 'admin', permissions: [], is_active: state.active, rbac_admin: true }] }
    return { rows: [] }
  })
  return { state, query }
}
function context(): ExactAnchorPlanAuthContext {
  return { mode: 'revert', actorId: identity.actorId, sheetId: identity.sheetId,
    plan: { reverts: [], resurrects: [], deletedAtAnchorLiveNow: [], createdAfterAnchor: [], driftCount: 0, unchangedCount: 0 },
    revertWrites: [], deleteRecordIds: [] }
}

describe('production archive worker authorization', () => {
  test('shared scope authorization requires full-read even for a database administrator', async () => {
    const { query } = database()
    const fullRead = vi.fn(async () => false)
    expect(await bindRecoveryArchiveScopeAuthorization(fullRead)(query, identity)).toBe(false)
    expect(fullRead).toHaveBeenCalledTimes(1)
    expect(fullRead).toHaveBeenCalledWith(query, identity.sheetId, expect.any(Object))
  })
  test('manual continuation uses canonical fresh actor/scope policy before every resumed section', async () => {
    const { state, query: authorityQuery } = database()
    const generationId = randomUUID()
    const binding = { formatVersion: 1, generationId, workspaceId: identity.workspaceId, baseId: identity.baseId,
      sheetId: identity.sheetId, anchorOperationId: randomUUID(), anchorSeq: '1', checkpointId: 'checkpoint',
      keyId: 'key', aeadAlgorithm: 'aes-256-gcm' as const }
    const payload = Buffer.from(JSON.stringify({ version: 1,
      binding: { ...binding, wrappedDekId: 'wrapped', dekFingerprint: 'a'.repeat(64) }, wrappedDek: 'AQ==',
      sections: RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName, index) => ({ sectionName,
        aeadAlgorithm: 'aes-256-gcm', nonce: Buffer.alloc(12, index).toString('base64'),
        ciphertext: 'AQ==', authTag: Buffer.alloc(16).toString('base64'), plaintextSha256: 'b'.repeat(64),
      })),
    }))
    const query = async (text: string, params?: unknown[]) => {
      if (text.includes('pg_current_xact_id')) return { rows: [{ xid: '1' }] }
      if (text.includes('FROM public.meta_recovery_archives')) return { rows: [{ generation_id: generationId }] }
      if (text.includes('FROM public.meta_recovery_archive_prepared_captures')) {
        return { rows: [{ payload, payload_sha256: createHash('sha256').update(payload).digest('hex') }] }
      }
      return authorityQuery(text, params)
    }
    const transaction: RecoveryArchivePreparedUploadInput['transaction'] = async (work) => work(query)
    const run = createRecoveryArchiveManualContinuation(transaction)
    const capture = vi.fn(async (): Promise<never> => { throw new Error('NO_RECAPTURE') })
    const upload = vi.fn(async () => {})
    const input = { identity, binding, owner: { generationId, ownerKind: 'archive_builder', ownerId: 'builder',
      ownerFence: '1', sourceVectorHash: 'c'.repeat(64) }, capture, upload,
    transactionDepth: { currentTransactionDepth: () => 0 } }
    await run(input)
    expect(upload).toHaveBeenCalledTimes(10)
    expect(capture).not.toHaveBeenCalled()
    expect(authorityQuery.mock.calls.filter(([sql]) => sql.includes('FROM users'))).toHaveLength(11)
    upload.mockClear()
    state.active = false
    await expect(run(input)).rejects.toThrow('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
    expect(upload).not.toHaveBeenCalled()
    state.active = true
    upload.mockImplementation(async () => { state.active = false })
    await expect(run(input)).rejects.toThrow('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
    expect(upload).toHaveBeenCalledTimes(1)
    state.active = true
    upload.mockClear()
    state.base = 'different'
    await expect(run(input)).rejects.toThrow('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
    expect(upload).not.toHaveBeenCalled()
    await expect(run({ ...input, identity: { ...identity, sheetId: 'different' } }))
      .rejects.toThrow('RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH')
    expect(capture).not.toHaveBeenCalled()
    state.base = identity.baseId
    authorityQuery.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_DATABASE_DETAIL'))
    await expect(run(input)).rejects.toThrow(/^RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE$/)
    expect(upload).not.toHaveBeenCalled()
  })
  test('uses persisted actor and fresh database without any HTTP request', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    expect(await worker.recheckAuthority(query, identity)).toBe(true)
    expect(await worker.apply.preliminaryFullRead(query, identity)).toBe(true)
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM users'))?.[1]).toEqual(['actor'])
    state.active = false
    expect(await worker.recheckAuthority(query, identity)).toBe(false)
    expect(await worker.apply.preliminaryFullRead(query, identity)).toBe(false)
  })
  test.each(['base', 'workspace', 'deleted'] as const)('denies %s scope drift before actor lookup', async (change) => {
    const { state, query } = database()
    if (change === 'deleted') state.exists = false
    else state[change] = 'other'
    expect(await createRecoveryArchiveWorkerAuthorization().recheckAuthority(query, identity)).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM users'))).toBe(false)
  })
  test.each(['jobId', 'actorId', 'workspaceId', 'baseId', 'sheetId'] as const)('rejects malformed %s before query', async (key) => {
    const { query } = database()
    expect(await createRecoveryArchiveWorkerAuthorization().recheckAuthority(query, { ...identity, [key]: ' ' })).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
  test('final full-read requires the source sheet in the lock scope and rechecks revocation', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    const scope = { authoritySheetIds: ['other'], liveRows: [], lockedRecordKeys: new Set<string>() }
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(false)
    expect(query).not.toHaveBeenCalled()
    scope.authoritySheetIds = [identity.sheetId]
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(true)
    state.active = false
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(false)
  })
  test('plan authorization uses canonical shared policy and rejects mismatched identity', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    expect(await worker.apply.evaluatePlanAuthorization(query, context(), identity)).toBe(true)
    state.active = false
    expect(await worker.apply.evaluatePlanAuthorization(query, context(), identity)).toBe(false)
    query.mockClear()
    const wrong = { ...context(), actorId: 'other' }
    expect(await worker.apply.evaluatePlanAuthorization(query, wrong, identity)).toBe(false)
    expect(await worker.apply.stabilizeAuthorization(query, wrong, identity)).toBe('unavailable')
    expect(query).not.toHaveBeenCalled()
  })
})
