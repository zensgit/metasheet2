import type { Request } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAttachmentMetadataAdmission, isAttachmentMetadataCommitUncertain } from '../../src/multitable/attachment-metadata-admission'
import { storeAttachment, type StoreAttachmentInput, type AttachmentQueryFn } from '../../src/multitable/attachment-service'
import type { AttachmentPurgeTransaction } from '../../src/multitable/attachment-purge-claim'
import { ensureRecordWriteAllowed } from '../../src/multitable/permission-service'
import { deriveCapabilities } from '../../src/multitable/access'
import { resolveRecoverySheetAuthority } from '../../src/multitable/recovery-authorization-stability'

vi.mock('../../src/multitable/permission-service', () => ({
  ensureRecordWriteAllowed: vi.fn(),
}))

vi.mock('../../src/multitable/recovery-authorization-stability', () => ({ resolveRecoverySheetAuthority: vi.fn() }))

const recovery = {
  status: 409,
  error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' },
}
const defaultAuthority = {
  access: { userId: 'authenticated-principal', permissions: ['multitable:write'], isAdminRole: false },
  capabilities: deriveCapabilities(['multitable:write'], false),
  capabilityOrigin: { source: 'global-rbac' as const, hasSheetAssignments: false },
}
const request = { user: { sub: 'authenticated-principal' } } as unknown as Request
const metadata = { id: 'new-attachment', filename: 'upload.bin' }
const uploaded = { id: 'new-upload-only', path: 'new-upload-only/blob', url: '/file' }
const file = { buffer: Buffer.from('synthetic'), originalname: 'upload.bin', mimetype: 'application/octet-stream', size: 9 }

function fixture(options: {
  state?: unknown
  isolation?: string
  liveness?: 'live' | 'deleted' | 'absent'
  field?: unknown[]
  record?: unknown[]
  stateRows?: unknown[]
  fail?: 'state' | 'insert' | 'commit'
  recordId?: string | null
  fieldId?: string | null
} = {}) {
  const events: string[] = []
  let inTransaction = false
  let insertedSql: string | undefined
  let insertedParams: unknown[] | undefined
  const query = vi.fn<Parameters<AttachmentQueryFn>, ReturnType<AttachmentQueryFn>>(async (sql, params) => {
    expect(inTransaction).toBe(true)
    events.push(sql)
    if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: options.isolation ?? 'read committed' }] }
    if (sql.startsWith('SELECT deleted_at')) return { rows: options.liveness === 'absent' ? [] : [{ deleted_at: options.liveness === 'deleted' ? new Date() : null }] }
    if (sql.startsWith('SELECT recovery_writer_state')) {
      if (options.fail === 'state') throw new Error('private-state-detail')
      return { rows: options.stateRows ?? [{ recovery_writer_state: 'state' in options ? options.state : null }] }
    }
    if (sql.startsWith('SELECT id, type')) return { rows: options.field ?? [{ id: 'field', type: ' AtTaChMeNt ' }] }
    if (sql.startsWith('SELECT id, created_by')) return { rows: options.record ?? [{ id: 'record', created_by: 'authenticated-principal' }] }
    if (sql.startsWith('INSERT')) {
      if (options.fail === 'insert') throw new Error('private-insert-detail')
      insertedSql = sql
      insertedParams = params
      return { rows: [metadata] }
    }
    return { rows: [] }
  })
  const transaction: AttachmentPurgeTransaction = vi.fn(async (work) => {
    events.push('BEGIN')
    inTransaction = true
    try {
      const result = await work({ query })
      if (options.fail === 'commit') throw new Error('private-commit-detail')
      events.push('COMMIT')
      return result
    } catch (error) {
      events.push('ROLLBACK')
      throw error
    } finally {
      inTransaction = false
      events.push('RELEASE')
    }
  })
  const legacyQuery = vi.fn<Parameters<AttachmentQueryFn>, ReturnType<AttachmentQueryFn>>(async () => ({ rows: [metadata] }))
  const upload = vi.fn(async () => {
    expect(inTransaction).toBe(false)
    events.push('UPLOAD')
    return uploaded
  })
  const cleanup = vi.fn(async () => {
    expect(inTransaction).toBe(false)
    events.push('DELETE')
  })
  const storage = {
    upload,
    uploadContentAddressed: vi.fn(upload),
    delete: cleanup,
  } as unknown as StoreAttachmentInput['storage']
  const input = {
    query: legacyQuery,
    transaction,
    request,
    sheetId: 'sheet',
    fieldId: options.fieldId === undefined ? 'field' : options.fieldId,
    recordId: options.recordId === undefined ? 'record' : options.recordId,
    mapFieldType: vi.fn((type: string) => type.trim().toLowerCase()),
  }
  const run = () => storeAttachment({
    query: bindAttachmentMetadataAdmission(input), storage,
    sheetId: input.sheetId, recordId: input.recordId, fieldId: input.fieldId,
    file, uploaderId: 'authenticated-principal', idGenerator: () => 'new-attachment',
  })
  return { events, query, transaction, legacyQuery, input, storage, cleanup, run, insert: () => ({ insertedSql, insertedParams }) }
}

beforeEach(() => {
  vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
  vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
  vi.mocked(resolveRecoverySheetAuthority).mockReset()
  vi.mocked(resolveRecoverySheetAuthority).mockResolvedValue(defaultAuthority)
  vi.mocked(ensureRecordWriteAllowed).mockReset()
  vi.mocked(ensureRecordWriteAllowed).mockReturnValue(true)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('attachment metadata admission', () => {
  it('owns only metadata RC transaction; preserves legacy INSERT and result with same-principal revalidation', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ row: metadata, uploaded })
    expect(f.events.slice(0, 5)).toEqual([
      'UPLOAD', 'BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
    ])
    expect(f.events.slice(-2)).toEqual(['COMMIT', 'RELEASE'])
    expect(f.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['meta:auto-number:sheet:sheet'])
    expect(resolveRecoverySheetAuthority).toHaveBeenCalledWith(request, f.query, 'sheet')
    expect(ensureRecordWriteAllowed).toHaveBeenCalledWith(defaultAuthority.capabilities, undefined, defaultAuthority.access, 'authenticated-principal', 'edit')
    expect(f.input.mapFieldType).toHaveBeenCalledWith(' AtTaChMeNt ')
    expect(f.cleanup).not.toHaveBeenCalled()
    expect(f.legacyQuery).not.toHaveBeenCalled()
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'false')
    const old = fixture()
    await old.run()
    expect(f.insert()).toEqual({ insertedSql: old.legacyQuery.mock.calls[0][0], insertedParams: old.legacyQuery.mock.calls[0][1] })
  })

  const flags = [undefined, 'false', 'TRUE', ' true ', '1', 'true']
  for (const archive of flags) for (const fence of flags) {
    if (archive === 'true' && fence === 'true') continue
    it(`preserves exact OFF query/storage/response for ${String(archive)}/${String(fence)}`, async () => {
      if (archive === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', archive)
      if (fence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', fence)
      const f = fixture()
      expect(bindAttachmentMetadataAdmission(f.input)).toBe(f.legacyQuery)
      expect(await f.run()).toEqual({ row: metadata, uploaded })
      expect(f.transaction).not.toHaveBeenCalled()
      expect(f.query).not.toHaveBeenCalled()
      expect(resolveRecoverySheetAuthority).not.toHaveBeenCalled()
      expect(f.storage.upload).toHaveBeenCalledOnce()
      expect(f.storage.uploadContentAddressed).not.toHaveBeenCalled()
    })
  }

  it.each(['fencing', 'applying', 'paused_retryable', 'archiving', 'unknown', undefined])('refuses durable/unknown state %s and cleans only this upload after rollback/release', async (state) => {
    const f = fixture({ state })
    await expect(f.run()).rejects.toMatchObject(recovery)
    expect(f.insert().insertedSql).toBeUndefined()
    expect(f.events.slice(-3)).toEqual(['ROLLBACK', 'RELEASE', 'DELETE'])
    expect(f.cleanup).toHaveBeenCalledOnce()
    expect(f.cleanup).toHaveBeenCalledWith('new-upload-only')
  })

  it.each(['repeatable read', 'serializable', 'unknown'])('refuses actual isolation %s before business reads', async (isolation) => {
    const f = fixture({ isolation })
    await expect(f.run()).rejects.toMatchObject(recovery)
    expect(resolveRecoverySheetAuthority).not.toHaveBeenCalled()
    expect(f.events.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false)
  })

  it.each([{ stateRows: [] }, { stateRows: [{ recovery_writer_state: null }, { recovery_writer_state: null }] }])('refuses non-exact state row set', async ({ stateRows }) => {
    const f = fixture({ stateRows })
    await expect(f.run()).rejects.toMatchObject(recovery)
    expect(f.insert().insertedSql).toBeUndefined()
  })

  it('does not reuse any missing-column cache; direct state SQL failure refuses without details', async () => {
    const f = fixture({ fail: 'state' })
    await expect(f.run()).rejects.toMatchObject(recovery)
    expect(f.events.some((sql) => sql.includes('information_schema'))).toBe(false)
  })

  it.each(['insert', 'commit'] as const)('sanitizes %s failure and preserves cleanup lifecycle', async (fail) => {
    const f = fixture({ fail })
    await expect(f.run()).rejects.toMatchObject({ status: 503, error: { code: 'DB_NOT_READY', message: 'Attachment metadata admission unavailable' } })
    if (fail === 'insert') {
      expect(f.events.slice(-3)).toEqual(['ROLLBACK', 'RELEASE', 'DELETE'])
    } else {
      expect(f.events.slice(-2)).toEqual(['ROLLBACK', 'RELEASE'])
      expect(f.cleanup).not.toHaveBeenCalled()
    }
  })

  it('brands only uncertain commit errors by private identity, not copied fields', async () => {
    const f = fixture({ fail: 'commit' })
    const error = await f.run().catch((error: unknown) => error)
    expect(isAttachmentMetadataCommitUncertain(error)).toBe(true)
    expect(isAttachmentMetadataCommitUncertain({ ...(error as Error) })).toBe(false)
    expect(isAttachmentMetadataCommitUncertain(Object.assign(new Error(), error))).toBe(false)
    expect(f.cleanup).not.toHaveBeenCalled()
    const rejected = fixture({ fail: 'insert' })
    expect(isAttachmentMetadataCommitUncertain(await rejected.run().catch((error: unknown) => error))).toBe(false)
    expect(rejected.cleanup).toHaveBeenCalledWith('new-upload-only')
  })

  it('retains genuine uncertain-error identity on reuse without granting copied DTO authority', async () => {
    const first = fixture({ fail: 'commit' })
    const error = await first.run().catch((error: unknown) => error)
    expect(isAttachmentMetadataCommitUncertain(error)).toBe(true)
    const reused = fixture()
    await expect(storeAttachment({
      query: async () => { throw error }, storage: reused.storage,
      sheetId: 'sheet', recordId: null, fieldId: null, file, uploaderId: 'actor',
    })).rejects.toBe(error)
    expect(reused.cleanup).not.toHaveBeenCalled()
    expect(isAttachmentMetadataCommitUncertain(error)).toBe(true)
  })

  it.each(['field-spoof', 'dto-copy', 'raw-commit', 'raw-sql'])('keeps OFF cleanup for unbranded %s errors', async (kind) => {
    const active = fixture({ fail: 'commit' })
    const genuine = await active.run().catch((error: unknown) => error)
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'false')
    const f = fixture()
    const error = kind === 'dto-copy' ? { ...(genuine as Error) }
      : kind === 'field-spoof' ? Object.assign(new Error('DB_NOT_READY'), { commitUncertain: true, callbackCompleted: true, skipCleanup: true })
        : new Error(kind === 'raw-commit' ? 'COMMIT rejected' : 'SQL rejected')
    f.legacyQuery.mockRejectedValueOnce(error)
    await expect(f.run()).rejects.toBe(error)
    expect(isAttachmentMetadataCommitUncertain(error)).toBe(false)
    expect(f.cleanup).toHaveBeenCalledOnce()
    expect(f.cleanup).toHaveBeenCalledWith('new-upload-only')
    expect(f.transaction).not.toHaveBeenCalled()
  })

  it('conservatively retains upload even when the test transaction definitively rejects COMMIT', async () => {
    const f = fixture({ fail: 'commit' })
    await expect(f.run()).rejects.toMatchObject({ status: 503, error: { code: 'DB_NOT_READY' } })
    expect(f.events).toContain('ROLLBACK')
    expect(f.events).not.toContain('COMMIT')
    expect(f.cleanup).not.toHaveBeenCalled()
    // Retention is safety under uncertainty; this is deliberately not a no-orphan guarantee.
  })

  it('refuses switched-off active configuration before new business SQL', async () => {
    const f = fixture()
    const query = bindAttachmentMetadataAdmission(f.input)
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'false')
    await expect(query('INSERT', [])).rejects.toMatchObject(recovery)
    expect(f.query).not.toHaveBeenCalled()
  })

  it('rechecks permission before revealing liveness or target state', async () => {
    vi.mocked(resolveRecoverySheetAuthority).mockResolvedValue({ ...defaultAuthority, capabilities: { ...defaultAuthority.capabilities, canEditRecord: false } })
    const f = fixture()
    await expect(f.run()).rejects.toMatchObject({ status: 403, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
    expect(f.events.some((sql) => sql.startsWith('SELECT recovery_writer_state'))).toBe(false)
  })

  it.each(['deleted', 'absent'] as const)('refuses fresh sheet liveness %s', async (sheetLiveness) => {
    const f = fixture({ liveness: sheetLiveness })
    await expect(f.run()).rejects.toMatchObject({ status: 404, error: { code: sheetLiveness === 'deleted' ? 'SHEET_DELETED' : 'NOT_FOUND' } })
    expect(f.insert().insertedSql).toBeUndefined()
  })

  it.each([
    [{ field: [] }, 404, 'NOT_FOUND', 'Field not found'],
    [{ field: [{ type: 'string' }] }, 400, 'VALIDATION_ERROR', 'Field is not an attachment field'],
    [{ record: [] }, 404, 'NOT_FOUND', 'Record not found'],
  ] as Array<[Parameters<typeof fixture>[0], number, string, string]>)('refuses fresh target drift %# with closed response', async (options, status, code, message) => {
    const f = fixture(options)
    await expect(f.run()).rejects.toMatchObject({ status, error: { code, message } })
    expect(f.insert().insertedSql).toBeUndefined()
  })

  it('refuses lost record-row write authority', async () => {
    vi.mocked(ensureRecordWriteAllowed).mockReturnValue(false)
    const f = fixture()
    await expect(f.run()).rejects.toMatchObject({ status: 403, error: { code: 'FORBIDDEN', message: 'Record editing is not allowed for this row' } })
    expect(f.insert().insertedSql).toBeUndefined()
  })

  it('passes fresh non-admin write-own authority to the existing real row policy despite stale request admin', async () => {
    const policy = await vi.importActual<typeof import('../../src/multitable/permission-service')>('../../src/multitable/permission-service')
    vi.mocked(ensureRecordWriteAllowed).mockImplementation(policy.ensureRecordWriteAllowed)
    vi.mocked(resolveRecoverySheetAuthority).mockResolvedValue({
      ...defaultAuthority,
      access: { userId: 'authenticated-principal', permissions: ['multitable:write-own'], isAdminRole: false },
      sheetScope: { hasAssignments: true, canRead: true, canAdmin: false, canWriteOwn: true, canWrite: false },
    })
    const f = fixture({ record: [{ created_by: 'different-creator' }] })
    f.input.request = { user: { sub: 'authenticated-principal', role: 'admin' } } as unknown as Request
    await expect(f.run()).rejects.toMatchObject({ status: 403, error: { code: 'FORBIDDEN', message: 'Record editing is not allowed for this row' } })
    expect(f.insert().insertedSql).toBeUndefined()
    const own = fixture()
    await expect(own.run()).resolves.toEqual({ row: metadata, uploaded })
  })

  it('protects draft attachments without inventing field/record requirements', async () => {
    const f = fixture({ fieldId: null, recordId: null })
    await expect(f.run()).resolves.toEqual({ row: metadata, uploaded })
    expect(f.input.mapFieldType).not.toHaveBeenCalled()
    expect(ensureRecordWriteAllowed).not.toHaveBeenCalled()
    expect(f.events).toContain('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1')
  })

  it('keeps provider failure before the transaction and preserves best-effort cleanup failure', async () => {
    const before = fixture()
    vi.mocked(before.storage.uploadContentAddressed).mockRejectedValueOnce(new Error('provider-failure'))
    await expect(before.run()).rejects.toThrow('provider-failure')
    expect(before.transaction).not.toHaveBeenCalled()
    expect(before.cleanup).not.toHaveBeenCalled()
    const after = fixture({ state: 'archiving' })
    after.cleanup.mockRejectedValueOnce(new Error('cleanup-failure'))
    await expect(after.run()).rejects.toMatchObject(recovery)
    expect(after.events).toContain('RELEASE')
  })

  it('leaves OFF metadata error identity and cleanup unchanged', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'false')
    const f = fixture()
    const error = new Error('legacy-error')
    f.legacyQuery.mockRejectedValueOnce(error)
    await expect(f.run()).rejects.toBe(error)
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.cleanup).toHaveBeenCalledOnce()
    expect(f.cleanup).toHaveBeenCalledWith('new-upload-only')
  })
})
