import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { usePinnedServer } from '../utils/pinned-server'
import { createSourceDeletionFixture, deletionKinds, digest, gate, reached, type DeletionKind, type SourceDeletionFixture } from '../utils/recovery-archive-source-deletion-fixture'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'
import type { QueryFn } from '../../src/multitable/permission-service'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const native = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: source deletion real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('SOURCE_DELETION_DATABASE_URL_REQUIRED')
})
const blocked = { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
const flagNames = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE', 'ATTACHMENT_PATH']
type State = Awaited<ReturnType<SourceDeletionFixture['snapshot']>>
function rows(state: State, table: string): Array<Record<string, unknown>> {
  return (state.rows[table] as Array<{ row: string }>).map(item => JSON.parse(item.row) as Record<string, unknown>)
}

native('genuine archive source attachment deletion family', () => {
  const pinned = usePinnedServer()
  let admin: Pool
  let fixture: SourceDeletionFixture | undefined
  let authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>
  let savedFlags: Array<string | undefined>
  let legacyFence: typeof import('../../src/multitable/canonical-sheet-fence').fenceWriterEntry
  const releases = new Set<() => void>()
  const pending = new Set<Promise<unknown>>()
  function barrier() { const value = gate(); releases.add(value.release); return value }
  function tracked<T>(promise: Promise<T>): Promise<T> { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  function currentFixture() { if (!fixture) throw new Error('SOURCE_DELETION_FIXTURE_NOT_INITIALIZED'); return fixture }
  function execute(kind: DeletionKind) {
    const fixture = currentFixture()
    if (kind !== 'http') return tracked(fixture.run(kind))
    // Trigger the supertest thenable immediately; never wait for a barrier on a lazy request.
    return tracked(request(pinned.url()).delete(`/api/multitable/attachments/${fixture.attachmentId}`).then((response: { status: number; body: unknown }) => ({ status: response.status, body: response.body })))
  }
  async function observe(code: string, before: State, outcome: unknown) {
    const fixture = currentFixture()
    const after = await fixture.snapshot()
    await fixture.save(code, { before, after, outcome, providerDepths: fixture.control.providerDepths, transactionDepth: fixture.control.depth })
    return after
  }
  function assertRefusal(kind: DeletionKind, outcome: unknown) {
    if (kind === 'http') expect(outcome).toEqual({ status: 409, body: blocked })
    if (kind === 'direct') expect(outcome).toBeUndefined()
    if (kind === 'orphan') expect(outcome).toEqual({ inspected: 0, deleted: 0, skipped: 0 })
    if (kind === 'blob') expect(outcome).toEqual({ inspected: 0, purged: 0, skipped: 0 })
  }
  async function assertDeleted(kind: DeletionKind, outcome: unknown, before: State, after: State) {
    const fixture = currentFixture()
    // Actual provider missing-source refusal and idempotent ENOENT deletion, beyond an IO call spy.
    let missing = false
    try { await fixture.storage.readContentAddressedBounded(fixture.key, fixture.bytes.length) }
    catch (error) { missing = error instanceof Error && error.message === 'ATTACHMENT_SOURCE_UNAVAILABLE' }
    await fixture.save('OFFICIAL_PROVIDER_ABSENCE', { missing, physical: after.physical })
    expect(missing).toBe(true)
    expect(after.physical).toEqual({ exists: false })
    await fixture.storage.deleteByKey(fixture.key)
    const attachment = rows(after, 'multitable_attachments')[0]
    expect(attachment.deleted_at !== null && attachment.blob_purged_at !== null).toBe(true)
    if (kind === 'http') {
      const response = outcome as { status: number; body: { ok: boolean; data: { deleted: string } } }
      expect(response.status).toBe(200)
      expect(response.body.ok && response.body.data.deleted === fixture.attachmentId).toBe(true)
      const record = rows(after, 'meta_records')[0]
      expect(record.version).toBe(2)
      expect(record.data).toEqual({ [fixture.fieldId]: [], [fixture.noteId]: 'retained' })
      expect(record.modified_by === fixture.identity.actorId).toBe(true)
      const revisions = rows(after, 'meta_record_revisions').filter(row => row.source === 'attachment')
      expect(revisions.length).toBe(1)
      const revision = revisions[0]
      expect(revision.action === 'update' && revision.actor_id === fixture.identity.actorId && revision.version === 2).toBe(true)
      expect(digest(revision.snapshot)).toBe(digest(record.data))
      expect(digest(revision.patch)).toBe(digest({ [fixture.fieldId]: [] }))
      if (process.env.MULTITABLE_ENABLE_WRITER_FENCE === 'true') {
        expect(typeof revision.operation_id === 'string').toBe(true)
        const operations = rows(after, 'meta_record_history_operations')
        expect(operations.length).toBe(rows(before, 'meta_record_history_operations').length + 1)
        const endpoint = operations.find(row => row.operation_id === revision.operation_id)
        expect(Boolean(endpoint && endpoint.sheet_id === fixture.sheetId && Number(endpoint.event_count) > 0 && BigInt(String(endpoint.endpoint_seq)) >= BigInt(String(revision.seq)))).toBe(true)
        expect(rows(after, 'meta_record_version_markers').length).toBeGreaterThanOrEqual(rows(before, 'meta_record_version_markers').length)
      }
    } else {
      expect(digest(rows(after, 'meta_records'))).toBe(digest(rows(before, 'meta_records')))
      for (const table of ['meta_record_revisions', 'meta_record_version_markers', 'meta_record_history_operations']) expect(digest(rows(after, table))).toBe(digest(rows(before, table)))
      if (kind === 'orphan') expect(outcome).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
      if (kind === 'blob') expect(outcome).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      if (kind === 'direct') expect(outcome).toBeUndefined()
    }
    expect(fixture.control.providerDepths.every(depth => depth === 0)).toBe(true)
  }
  beforeAll(() => {
    savedFlags = flagNames.map(name => process.env[name])
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 })
  })
  beforeEach(async () => {
    fixture = undefined
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    __resetRecoveryWriterStateColumnProbe()
    // Public logs contain codes only; original native/provider errors and results stay untouched.
    for (const method of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(Logger.prototype, method).mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => console.log('SOURCE_DELETION_ROUTE_ERROR'))
    fixture = await createSourceDeletionFixture(admin, expect.getState().currentTestName ?? 'SOURCE_DELETION_CASE')
    process.env.ATTACHMENT_PATH = fixture.sourceRoot
    vi.resetModules()
    const logger = await import('../../src/core/logger')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger.Logger.prototype, method).mockImplementation(() => undefined)
    const storageModule = await import('../../src/services/StorageService')
    const originalDelete = storageModule.LocalStorageProvider.prototype.deleteByKey
    vi.spyOn(storageModule.LocalStorageProvider.prototype, 'deleteByKey').mockImplementation(async function (this: InstanceType<typeof storageModule.LocalStorageProvider>, key: string) {
      const fixture = currentFixture()
      fixture.control.providerDepths.push(fixture.control.operationDepth)
      await fixture.control.deleteHook?.()
      return originalDelete.call(this, key)
    })
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const adapter = { query: fixture.query, transaction: fixture.transaction, getInternalPool: () => currentFixture().pool }
    vi.spyOn(poolManager, 'get').mockReturnValue(adapter as unknown as ReturnType<typeof poolManager.get>)
    legacyFence = (await import('../../src/multitable/canonical-sheet-fence')).fenceWriterEntry
    const { univerMetaRouter, hasFullTableReadAccess } = await import('../../src/routes/univer-meta')
    const { bindRecoveryArchiveScopeAuthorization } = await import('../../src/multitable/recovery-archive-worker-authorization')
    authorize = bindRecoveryArchiveScopeAuthorization((query, sheetId, authority) =>
      hasFullTableReadAccess(undefined, query, sheetId, authority.access, authority.capabilities))
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = { id: currentFixture().identity.actorId, roles: ['admin'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter()); pinned.setApp(app)
  }, 30000)
  afterEach(async () => {
    for (const release of releases) release()
    const settled = await Promise.allSettled([...pending])
    releases.clear(); pending.clear()
    try { if (fixture) { await fixture.save('DRAINED', { rejected: settled.filter(value => value.status === 'rejected').length, depth: fixture.control.depth }); await fixture.dispose() } }
    finally { vi.restoreAllMocks(); vi.resetModules(); __resetRecoveryWriterStateColumnProbe() }
  })
  afterAll(async () => {
    flagNames.forEach((name, index) => { if (savedFlags[index] === undefined) delete process.env[name]; else process.env[name] = savedFlags[index] })
    await admin?.end()
  })

  test.each(deletionKinds)('unblocked %s really deletes eligible bytes and preserves unrelated history', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    const before = await fixture.snapshot(), outcome = await execute(kind)
    const after = await observe('UNBLOCKED', before, outcome)
    await assertDeleted(kind, outcome, before, after)
  })

  test.each(['orphan', 'blob'] as const)('default call-time ATTACHMENT_PATH %s deleter really removes eligible bytes', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    const before = await fixture.snapshot(), outcome = await tracked(fixture.run(kind, true))
    const after = await observe('DEFAULT_STORAGE_UNBLOCKED', before, outcome)
    await assertDeleted(kind, outcome, before, after)
  })

  test.each(deletionKinds)('genuine live claim blocks %s without row history or file mutation', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind); await fixture.claim(authorize)
    const before = await fixture.snapshot(), outcome = await execute(kind)
    const after = await observe('LIVE_BLOCK', before, outcome)
    assertRefusal(kind, outcome)
    expect(digest(after)).toBe(digest(before))
    expect(fixture.control.providerDepths).toEqual([])
  })

  test.each(deletionKinds)('real expired claim still blocks %s without source or file mutation', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind); await fixture.claim(authorize, 1); await fixture.expire()
    const before = await fixture.snapshot(), outcome = await execute(kind)
    const after = await observe('EXPIRED_BLOCK', before, outcome)
    assertRefusal(kind, outcome)
    expect(digest(after)).toBe(digest(before))
    expect(fixture.control.providerDepths).toEqual([])
  })

  test.each(deletionKinds)('claim canonical fence first makes %s actually wait then refuse after COMMIT', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    const entered = barrier(), finish = barrier(); let held = false
    fixture.control.hook = async (phase, sql, params) => {
      if (!held && phase === 'claim' && sql.includes('pg_advisory_xact_lock') && params?.includes(fixture.fenceKey)) { held = true; entered.release(); await finish.promise }
    }
    const claiming = tracked(fixture.claim(authorize))
    let outcome: unknown, before: State | undefined
    try {
      await reached(entered.promise)
      const deleting = execute(kind)
      await fixture.waitForBlocking(fixture.control.claimPid)
      finish.release(); await claiming
      before = await fixture.snapshot(); outcome = await deleting
    } finally { finish.release() }
    const after = await observe('CLAIM_FIRST_NATIVE_WAIT', before!, outcome)
    assertRefusal(kind, outcome)
    expect(digest(after)).toBe(digest(before))
    expect(fixture.control.providerDepths).toEqual([])
  })

  test.each(deletionKinds)('%s purge transaction canonical fence first makes genuine publisher wait then refuse', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    const entered = barrier(), finish = barrier(); let fences = 0
    fixture.control.hook = async (phase, sql, params) => {
      if (phase === 'operation' && sql.includes('pg_advisory_xact_lock') && params?.includes(fixture.fenceKey)) {
        fences++
        // HTTP's first fence protects cell-strip metadata; only its second protects purge admission.
        if (fences === (kind === 'http' ? 2 : 1)) { entered.release(); await finish.promise }
      }
    }
    const deleting = execute(kind)
    let refusal = '', outcome: unknown
    try {
      await reached(entered.promise)
      const claiming = tracked(fixture.claim(authorize).then(() => 'UNEXPECTED_CLAIM', error => error instanceof Error ? error.message : 'UNKNOWN'))
      await fixture.waitForBlocking(fixture.control.operationPid)
      finish.release(); outcome = await deleting; refusal = await claiming
    } finally { finish.release() }
    const after = await fixture.snapshot()
    await fixture.save('PURGE_FENCE_FIRST_NATIVE_WAIT', { after, refusal: refusal === 'RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE' ? refusal : 'UNKNOWN', fences, outcome, providerDepths: fixture.control.providerDepths })
    expect(refusal).toBe('RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE')
    expect(fences).toBe(kind === 'http' ? 2 : 1)
    expect(rows(after, 'meta_recovery_archives').length).toBe(0)
    expect(rows(after, 'multitable_attachments')[0].blob_purge_claimed_at !== null).toBe(true)
    expect(after.physical).toEqual({ exists: false })
    expect(fixture.control.providerDepths.every(depth => depth === 0)).toBe(true)
    if (kind === 'http') expect((outcome as { status: number }).status).toBe(200)
    if (kind === 'orphan') expect(outcome).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
    if (kind === 'blob') expect(outcome).toEqual({ inspected: 1, purged: 1, skipped: 0 })
  })

  test.each(deletionKinds)('%s committed purge claim first refuses later genuine publisher outside provider IO', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    const entered = barrier(), finish = barrier()
    fixture.control.deleteHook = async () => { entered.release(); await finish.promise }
    const deleting = execute(kind)
    let refusal = '', before: State | undefined, outcome: unknown
    try {
      await reached(entered.promise)
      before = await fixture.snapshot()
      try { await fixture.claim(authorize) } catch (error) { refusal = error instanceof Error ? error.message : 'UNKNOWN' }
      await fixture.save('PURGE_FIRST_PUBLISHER_REFUSAL', { before, refusal: refusal === 'RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE' ? refusal : 'UNKNOWN', providerDepths: fixture.control.providerDepths })
    } finally { finish.release() }
    outcome = await deleting
    const after = await observe('PURGE_FIRST', before!, outcome)
    expect(refusal).toBe('RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE')
    expect(rows(before!, 'multitable_attachments')[0].blob_purge_claimed_at !== null).toBe(true)
    expect(rows(before!, 'meta_recovery_archives').length).toBe(0)
    expect(rows(after, 'meta_recovery_archives').length).toBe(0)
    expect(fixture.control.providerDepths.every(depth => depth === 0)).toBe(true)
    expect(after.physical).toEqual({ exists: false })
    if (kind === 'http') expect((outcome as { status: number }).status).toBe(200)
    if (kind === 'orphan') expect(outcome).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
    if (kind === 'blob') expect(outcome).toEqual({ inspected: 1, purged: 1, skipped: 0 })
  })

  test('HTTP metadata COMMIT handoff allows genuine publisher pin and preserves tombstoned bytes', async () => {
    const fixture = currentFixture()
    const entered = barrier(), finish = barrier(); let held = false
    fixture.control.hook = async (phase, sql) => {
      if (!held && phase === 'operation' && sql === 'COMMIT') { held = true; entered.release(); await finish.promise }
    }
    const deleting = execute('http')
    let before: State | undefined, outcome: unknown
    try { await reached(entered.promise); await fixture.claim(authorize); before = await fixture.snapshot() }
    finally { finish.release() }
    outcome = await deleting
    const after = await observe('HTTP_METADATA_HANDOFF', before!, outcome)
    expect((outcome as { status: number }).status).toBe(200)
    expect(digest(after)).toBe(digest(before))
    expect(after.physical.exists).toBe(true)
    expect(rows(after, 'multitable_attachments')[0].deleted_at !== null).toBe(true)
    expect(rows(after, 'multitable_attachments')[0].blob_purge_claimed_at).toBeNull()
    expect(fixture.control.providerDepths).toEqual([])
  })

  test.each(deletionKinds)('archive OFF fence ON preserves actual legacy %s parity', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind)
    // Warm the actual legacy column probe in a genuine unblocked native transaction before claim.
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
    await fixture.transaction(({ query }) => legacyFence(query, fixture.sheetId))
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    await fixture.claim(authorize)
    const before = await fixture.snapshot(); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
    const outcome = await execute(kind), after = await observe('ARCHIVE_OFF_PARITY', before, outcome)
    if (kind === 'http') {
      expect(outcome).toEqual({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete attachment' } } })
      expect(digest(after)).toBe(digest(before)); expect(fixture.control.providerDepths).toEqual([])
    } else await assertDeleted(kind, outcome, before, after)
  })

  test.each(deletionKinds)('writer fence OFF preserves actual legacy %s parity', async kind => {
    const fixture = currentFixture()
    await fixture.eligible(kind); await fixture.claim(authorize)
    const before = await fixture.snapshot(); process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'
    const outcome = await execute(kind), after = await observe('WRITER_OFF_PARITY', before, outcome)
    await assertDeleted(kind, outcome, before, after)
  })
})
