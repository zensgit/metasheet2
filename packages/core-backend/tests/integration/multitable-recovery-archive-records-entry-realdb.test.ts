import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { register } from 'prom-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { recordEntries, digest, gate, reached, type RecordEntry, type RecordsEntryFixture } from '../utils/recovery-archive-records-entry-fixture'
import type { CreatedMultitableRecord, DeletedMultitableRecord, LoadedMultitableRecord } from '../../src/multitable/records'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'
import type { RecoveryArchiveApplication } from '../../src/multitable/recovery-archive-application'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const native = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: records entry real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('RECORDS_ENTRY_DATABASE_URL_REQUIRED')
})
const blocked = { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
const flagNames = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED', 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED', 'ATTACHMENT_PATH']
type State = Awaited<ReturnType<RecordsEntryFixture['snapshot']>>
type Sdk = {
  createRecord(input: { sheetId: string; data: Record<string, unknown> }): Promise<CreatedMultitableRecord>
  patchRecord(input: { sheetId: string; recordId: string; changes: Record<string, unknown>; expectedVersion?: number }): Promise<LoadedMultitableRecord>
  deleteRecord(input: { sheetId: string; recordId: string }): Promise<DeletedMultitableRecord>
}
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
function rows(state: State, table: string): Array<Record<string, unknown>> {
  return (state.rows[table] ?? []).map(item => JSON.parse(item.row) as Record<string, unknown>)
}
function data(row: Record<string, unknown>) { return row.data as Record<string, unknown> }

native('genuine archive admission at actual records REST and SDK entries', () => {
  const pinned = usePinnedServer()
  let admin: Pool, savedFlags: Array<string | undefined>
  let fixture: RecordsEntryFixture | undefined, sdk: Sdk
  let hostApplication: RecoveryArchiveApplication | undefined
  let authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>
  let blockedError: typeof import('../../src/multitable/canonical-sheet-fence').SheetWriterBlockedError
  let resetProbe: typeof import('../../src/multitable/canonical-sheet-fence').__resetRecoveryWriterStateColumnProbe
  let subject: CreatedMultitableRecord, second: CreatedMultitableRecord, target: CreatedMultitableRecord, inbound: CreatedMultitableRecord
  const releases = new Set<() => void>(), pending = new Set<Promise<unknown>>()
  function barrier() { const value = gate(); releases.add(value.release); return value }
  function tracked<T>(promise: Promise<T>): Promise<T> { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  function current() { if (!fixture) throw new Error('RECORDS_ENTRY_FIXTURE_NOT_INITIALIZED'); return fixture }
  function select(entry: RecordEntry) {
    process.env.MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED = entry === 'SDK_DELETE_D1' ? 'false' : 'true'
    // D1 intentionally has capture ON: it still must not enter the nested D2 side door.
    process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED = 'true'
  }
  function execute(entry: RecordEntry): Promise<Outcome> {
    select(entry)
    const f = current(), create = { [f.fields.title]: 'created', [f.fields.note]: 'retained', [f.fields.link]: [target.id] }
    const patch = { [f.fields.title]: 'patched' }
    let promise: Promise<unknown>
    if (entry === 'SDK_CREATE') promise = sdk.createRecord({ sheetId: f.sheetId, data: create })
    else if (entry === 'SDK_PATCH') promise = sdk.patchRecord({ sheetId: f.sheetId, recordId: subject.id, changes: patch, expectedVersion: subject.version })
    else if (entry.startsWith('SDK_DELETE')) promise = sdk.deleteRecord({ sheetId: f.sheetId, recordId: subject.id })
    else {
      const http = entry === 'REST_CREATE' ? request(pinned.url()).post('/api/multitable/records').send({ sheetId: f.sheetId, data: create })
        : entry === 'REST_PATCH' ? request(pinned.url()).patch(`/api/multitable/records/${subject.id}`).send({ sheetId: f.sheetId, expectedVersion: subject.version, data: patch })
          : entry === 'REST_DELETE' ? request(pinned.url()).delete(`/api/multitable/records/${subject.id}`).query({ expectedVersion: subject.version })
            : request(pinned.url()).post('/api/multitable/patch').send({ sheetId: f.sheetId, partialSuccess: entry === 'REST_BULK_PARTIAL', changes: [subject, second].map(row => ({ recordId: row.id, fieldId: f.fields.title, value: 'patched', expectedVersion: row.version })) })
      // Eagerly assimilate supertest: waiting for a native barrier on a lazy thenable is invalid.
      promise = http.then(response => ({ status: response.status, body: response.body as unknown }))
    }
    return tracked(promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })))
  }
  async function observe(code: string, before: State, outcome: Outcome) {
    const f = current(), after = await f.snapshot()
    const savedOutcome = outcome.ok === true ? outcome : { ok: false, error: outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message, stack: outcome.error.stack, code: Reflect.get(outcome.error, 'code') } : 'UNKNOWN_REJECTION' }
    await f.save(code, { before, after, outcome: savedOutcome, clients: f.control.clients, activeTransactions: f.control.activeTransactions, commits: f.control.commits })
    return after
  }
  function refuse(entry: RecordEntry, outcome: Outcome) {
    if (entry.startsWith('REST')) {
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.value).toEqual({ status: 409, body: blocked })
    } else {
      expect(outcome.ok).toBe(false)
      if (outcome.ok === false) expect(outcome.error instanceof blockedError && outcome.error.code === 'SHEET_WRITER_BLOCKED').toBe(true)
    }
  }
  function positive(entry: RecordEntry, before: State, after: State, outcome: Outcome) {
    const f = current(), isCreate = entry.endsWith('CREATE'), isDelete = entry.includes('DELETE'), isBulk = entry.includes('BULK')
    expect(outcome.ok).toBe(true)
    expect(f.control.commits).toBe(entry === 'REST_BULK_PARTIAL' ? 2 : 1)
    if (outcome.ok && entry.startsWith('REST')) {
      const response = outcome.value as { status: number; body: { ok: boolean; data: { deleted?: string; updated?: Array<{ recordId: string; version: number }>; failed?: unknown[] } } }
      expect(response.status).toBe(200); expect(response.body.ok).toBe(true)
      if (isDelete) expect(response.body.data.deleted === subject.id).toBe(true)
      if (isBulk) {
        expect(response.body.data.updated?.slice().sort((a, b) => a.recordId.localeCompare(b.recordId))).toEqual(
          [subject, second].map(row => ({ recordId: row.id, version: 2 })).sort((a, b) => a.recordId.localeCompare(b.recordId)),
        )
        if (entry === 'REST_BULK_PARTIAL') expect(response.body.data.failed).toEqual([])
      }
    }
    const beforeRevs = rows(before, 'meta_record_revisions'), beforeIds = new Set(beforeRevs.map(row => row.id))
    const revisions = rows(after, 'meta_record_revisions').filter(row => !beforeIds.has(row.id))
    expect(revisions.length).toBe(isBulk ? 2 : 1)
    expect(revisions.every(row => row.action === (isCreate ? 'create' : isDelete ? 'delete' : 'update') && row.source === (entry.startsWith('SDK') ? 'plugin' : 'rest') && row.actor_id === (entry.startsWith('SDK') ? null : f.identity.actorId))).toBe(true)
    const oldRecords = rows(before, 'meta_records'), newRecords = rows(after, 'meta_records')
    const affected = isCreate ? newRecords.filter(row => !oldRecords.some(old => old.id === row.id)) : newRecords.filter(row => [subject.id, ...(isBulk ? [second.id] : [])].includes(String(row.id)))
    if (isDelete) {
      expect(affected.length).toBe(0)
      expect(digest(revisions[0]?.snapshot)).toBe(digest(data(oldRecords.find(row => row.id === subject.id)!)))
      expect(rows(before, 'meta_links').filter(row => row.record_id === subject.id || row.foreign_record_id === subject.id).length).toBe(2)
      expect(rows(after, 'meta_links').filter(row => row.record_id === subject.id || row.foreign_record_id === subject.id).length).toBe(0)
      const trash = rows(after, 'meta_records_trash').filter(row => row.record_id === subject.id)
      const tombstones = rows(after, 'meta_link_tombstones').filter(row => row.foreign_record_id === subject.id)
      if (entry === 'SDK_DELETE_D1') { expect(trash.length).toBe(0); expect(tombstones.length).toBe(0) }
      else {
        expect(trash.length).toBe(1); expect(tombstones.length).toBe(1)
        expect(digest(trash[0]?.data)).toBe(digest(data(oldRecords.find(row => row.id === subject.id)!)))
        expect(trash[0]?.delete_revision_id === revisions[0]?.id && tombstones[0]?.source_revision_id === revisions[0]?.id).toBe(true)
        expect(trash[0]?.original_version === subject.version && trash[0]?.deleted_by === (entry.startsWith('SDK') ? null : f.identity.actorId)).toBe(true)
      }
    } else {
      expect(affected.length).toBe(isBulk ? 2 : 1)
      expect(affected.every(row => row.version === (isCreate ? 1 : 2) && data(row)[f.fields.title] === (isCreate ? 'created' : 'patched') && data(row)[f.fields.note] === 'retained' && typeof data(row)[f.fields.number] === 'number')).toBe(true)
      for (const revision of revisions) expect(digest(revision.snapshot)).toBe(digest(data(newRecords.find(row => row.id === revision.record_id)!)))
      if (isCreate) expect(rows(after, 'meta_links').some(row => row.record_id === affected[0]?.id && row.foreign_record_id === target.id && row.field_id === f.fields.link)).toBe(true)
      if (isBulk) { expect(new Set(revisions.map(row => row.batch_id)).size).toBe(1); expect(typeof revisions[0]?.batch_id).toBe('string') }
    }
    if (outcome.ok === true && entry.startsWith('REST') && !isBulk) {
      const response = outcome.value as { status: number; body: unknown }
      const record = isDelete ? undefined : { id: affected[0]!.id, version: affected[0]!.version, data: data(affected[0]!) }
      const body = isDelete ? { ok: true, data: { deleted: subject.id } }
        : isCreate ? { ok: true, data: { record } }
          : { ok: true, data: {
            record: { ...record, locked: false, lockedBy: null, lockedAt: null },
            commentsScope: { targetType: 'meta_record', targetId: subject.id, baseId: f.identity.baseId, sheetId: f.sheetId, viewId: null, recordId: subject.id, containerType: 'meta_sheet', containerId: f.sheetId },
          } }
      expect(response).toEqual({ status: 200, body })
    }
    if (outcome.ok && entry.startsWith('SDK')) {
      const expected = { id: isDelete ? subject.id : affected[0]!.id, sheetId: f.sheetId, version: isCreate || isDelete ? 1 : 2 }
      expect(outcome.value).toEqual(isDelete ? expected : {
        ...expected, data: data(affected[0]!),
        ...(entry === 'SDK_PATCH' ? { locked: false, lockedBy: null, lockedAt: null } : {}),
      })
    }
    // Both source subjects have real outgoing links; neither unrelated target nor inbound source may be erased.
    for (const id of [target.id, inbound.id, ...(isBulk ? [] : [second.id])]) expect(digest(newRecords.find(row => row.id === id))).toBe(digest(oldRecords.find(row => row.id === id)))
    if (process.env.MULTITABLE_ENABLE_WRITER_FENCE === 'true') {
      expect(revisions.every(row => typeof row.operation_id === 'string')).toBe(true)
      const operations = rows(after, 'meta_record_history_operations')
      expect(revisions.every(revision => operations.some(row => row.operation_id === revision.operation_id && row.sheet_id === f.sheetId && Number(row.event_count) > 0 && BigInt(String(row.endpoint_seq)) >= BigInt(String(revision.seq))))).toBe(true)
    } else expect(revisions.every(row => row.operation_id === null)).toBe(true)
    expect(digest(after.physical)).toBe(digest(before.physical))
  }
  beforeAll(() => { savedFlags = flagNames.map(name => process.env[name]); admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 }) })
  beforeEach(async () => {
    fixture = undefined; hostApplication = undefined
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED = 'true'; process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED = 'true'
    // The fixture custody WeakMaps and real host are from the SAME graph after reset.
    register.clear()
    vi.resetModules()
    const logger = await import('../../src/core/logger')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger.Logger.prototype, method).mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => console.log('RECORDS_ENTRY_ROUTE_ERROR'))
    const fixtureModule = await import('../utils/recovery-archive-records-entry-fixture')
    fixture = await fixtureModule.createRecordsEntryFixture(admin, expect.getState().currentTestName ?? 'RECORDS_ENTRY_CASE')
    process.env.ATTACHMENT_PATH = fixture.sourceRoot
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue(fixture.adapter as unknown as ReturnType<typeof poolManager.get>)
    const fence = await import('../../src/multitable/canonical-sheet-fence')
    fence.__resetRecoveryWriterStateColumnProbe(); resetProbe = fence.__resetRecoveryWriterStateColumnProbe; blockedError = fence.SheetWriterBlockedError
    const { univerMetaRouter, hasFullTableReadAccess, createRecoveryArchiveWorkerCallbacks } = await import('../../src/routes/univer-meta')
    const { bindRecoveryArchiveScopeAuthorization } = await import('../../src/multitable/recovery-archive-worker-authorization')
    authorize = bindRecoveryArchiveScopeAuthorization((query, sheetId, authority) => hasFullTableReadAccess(undefined, query, sheetId, authority.access, authority.capabilities))
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], createRecoveryArchiveComposition: () => ({
      keyCustody: current().keyCustody, objectStore: current().objectStore,
      auditedReplayHorizonMs: 900000, asyncResumeHorizonMs: 900000, workerIntervalMs: 20,
      worker: { ...createRecoveryArchiveWorkerCallbacks(current().database), leaseMs: 60000, replayHorizonMs: 900000, sweepLimit: 1, maxChunksPerRun: 1, workerOwnerId: 'synthetic-records-entry-worker' },
    }) })
    const host = server as unknown as { createCoreAPI(): { multitable: { records: Sdk } }; recoveryArchiveApplication: RecoveryArchiveApplication }
    sdk = host.createCoreAPI().multitable.records; hostApplication = host.recoveryArchiveApplication
    // Constructor only. Never server.start(): that would immediately schedule genuine restore workers.
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = { id: current().identity.actorId, roles: ['admin'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter()); pinned.setApp(app)
    const f = current(), initial = (title: string, links: string[]) => ({ [f.fields.title]: title, [f.fields.note]: 'retained', [f.fields.link]: links })
    target = await sdk.createRecord({ sheetId: f.sheetId, data: initial('target', []) })
    subject = await sdk.createRecord({ sheetId: f.sheetId, data: initial('subject', [target.id]) })
    second = await sdk.createRecord({ sheetId: f.sheetId, data: initial('second', [target.id]) })
    inbound = await sdk.createRecord({ sheetId: f.sheetId, data: initial('inbound', [subject.id]) })
    f.control.commits = 0
    await f.save('HOST_AND_SOURCE_READY', { code: 'ACTUAL_CORE_API_CONSTRUCTOR_ONLY', source: await f.snapshot(), nativeAcquisitionMs: f.pool.options.connectionTimeoutMillis, transactionDepth: f.transactionDepthProbe.currentTransactionDepth() })
  }, 30000)
  afterEach(async () => {
    for (const release of releases) release()
    const settled = await Promise.allSettled([...pending]); releases.clear(); pending.clear()
    try {
      if (fixture) {
        const depthObserved = fixture.nativeCalls.every(call => !/^BEGIN\b/i.test(call.sql) || call.transactionDepth === 1) && fixture.nativeCalls.every(call => !/^(COMMIT|ROLLBACK)\b/i.test(call.sql) || call.transactionDepth === 0)
        await fixture.save('DRAINED', { rejected: settled.filter(value => value.status === 'rejected').length, clients: fixture.control.clients, activeTransactions: fixture.control.activeTransactions, depthObserved, nativeCalls: fixture.nativeCalls })
        // Drain only our authentic idle archive application; server.stop() would close global DB pools.
        await hostApplication?.stopWorker(); hostApplication?.releaseCustody()
        await fixture.dispose()
        expect(depthObserved).toBe(true)
      }
    } finally { vi.restoreAllMocks(); register.clear(); vi.resetModules(); resetProbe?.() }
  })
  afterAll(async () => { flagNames.forEach((name, index) => { if (savedFlags[index] === undefined) delete process.env[name]; else process.env[name] = savedFlags[index] }); await admin?.end() })

  test.each(recordEntries)('%s unblocked actual entry is usable with full materialized history', async entry => {
    const f = current(), before = await f.snapshot(), outcome = await execute(entry), after = await observe('UNBLOCKED', before, outcome)
    positive(entry, before, after, outcome)
  })
  test.each(recordEntries)('%s genuine live claim refuses with unchanged source and allocator', async entry => {
    const f = current(); await tracked(f.claim(authorize))
    const leaseBefore = await f.leaseState(), before = await f.snapshot(), outcome = await execute(entry), after = await observe('LIVE_CLAIM_REFUSAL', before, outcome), leaseAfter = await f.leaseState()
    await f.save('LIVE_LEASE_PROOF', { leaseBefore, leaseAfter })
    refuse(entry, outcome); expect(digest(after)).toBe(digest(before)); expect(leaseBefore.length === 1 && leaseBefore[0].live === true && leaseAfter.length === 1 && leaseAfter[0].live === true).toBe(true)
  })
  test.each(recordEntries)('%s genuinely SQL-clock-expired claim still refuses without side effects', async entry => {
    const f = current(); await tracked(f.claim(authorize, 1)); await f.expire()
    const before = await f.snapshot(), outcome = await execute(entry), after = await observe('EXPIRED_CLAIM_REFUSAL', before, outcome)
    refuse(entry, outcome); expect(digest(after)).toBe(digest(before))
  })
  test.each(recordEntries)('%s claim canonical fence first makes actual writer wait then refuse', async entry => {
    const f = current(), entered = barrier(), finish = barrier()
    f.control.hook = async (phase, sql, params) => {
      if (phase === 'claim' && sql.includes('pg_advisory_xact_lock') && params?.includes(`meta:auto-number:sheet:${f.sheetId}`)) { entered.release(); await finish.promise }
    }
    const claiming = tracked(f.claim(authorize)); let writing: Promise<Outcome> | undefined, outcome: Outcome | undefined, before: State | undefined
    try {
      await reached(entered.promise); writing = execute(entry)
      await f.waitForBlocking(f.control.claimPid)
      // Pause only after original claim COMMIT, before the waiting writer can change any source row.
      const committed = barrier(), resume = barrier()
      f.control.hook = async (phase, sql) => { if (phase === 'operation' && sql.includes('pg_advisory_xact_lock')) { committed.release(); await resume.promise } }
      finish.release(); await claiming; await reached(committed.promise); before = await f.snapshot(); resume.release(); outcome = await writing
    } finally { finish.release(); for (const release of releases) release() }
    const after = await observe('CLAIM_FIRST_NATIVE_WAIT', before!, outcome!)
    refuse(entry, outcome!); expect(digest(after)).toBe(digest(before))
  })
  test.each(recordEntries)('%s writer canonical fence first enters the next genuine claim committed head', async entry => {
    const f = current(), before = await f.snapshot(), entered = barrier(), finish = barrier(); let fences = 0
    f.control.hook = async (phase, sql, params) => {
      if (phase === 'operation' && sql.includes('pg_advisory_xact_lock') && params?.includes(`meta:auto-number:sheet:${f.sheetId}`)) {
        if (++fences === (entry === 'REST_BULK_PARTIAL' ? 2 : 1)) { entered.release(); await finish.promise }
      }
    }
    const writing = execute(entry); let claiming: ReturnType<RecordsEntryFixture['claim']> | undefined, outcome: Outcome | undefined
    try { await reached(entered.promise); claiming = tracked(f.claim(authorize)); await f.waitForBlocking(f.control.operationPid); finish.release(); outcome = await writing; await claiming }
    finally { finish.release() }
    const after = await observe('WRITER_FIRST_NATIVE_WAIT', before, outcome!)
    const binding = await claiming!, operations = rows(after, 'meta_record_history_operations').sort((a, b) => BigInt(String(a.endpoint_seq)) < BigInt(String(b.endpoint_seq)) ? -1 : 1)
    const head = operations.at(-1)
    await f.save('CLAIM_COMMITTED_HEAD', { binding, head, fences })
    positive(entry, before, after, outcome!)
    expect(binding.observedHeads.operationHead?.operationId === head?.operation_id && binding.observedHeads.operationHead?.endpointSeq === String(head?.endpoint_seq)).toBe(true)
  })
  test.each(recordEntries)('%s exact-owner terminal cleanup restores the same actual entry', async entry => {
    const f = current(), binding = await tracked(f.claim(authorize, 1)); await f.expire()
    const beforeCleanup = await f.snapshot(), cleanup = await tracked(f.cleanup(binding.generationOwner.generationId)), released = await f.snapshot()
    await f.save('OWNER_TERMINAL_CLEANUP', { binding, cleanup, before: beforeCleanup, after: released })
    expect(cleanup).toEqual({ outcome: 'complete', confirmed: 1 })
    const priorSheet = rows(beforeCleanup, 'meta_sheets').find(row => row.id === f.sheetId)!
    expect(String(priorSheet.recovery_writer_owner_fence)).toBe(binding.writerBlock.fence)
    const sheet = rows(released, 'meta_sheets').find(row => row.id === f.sheetId)!
    expect({ state: sheet.recovery_writer_state, ownerId: sheet.recovery_writer_owner_id, ownerKind: sheet.recovery_writer_owner_kind, ownerFence: String(sheet.recovery_writer_owner_fence), lease: sheet.recovery_writer_lease_until, updated: sheet.recovery_writer_updated_at }).toEqual({ state: null, ownerId: null, ownerKind: null, ownerFence: binding.writerBlock.fence, lease: null, updated: null })
    const generation = rows(released, 'meta_recovery_archives').find(row => row.generation_id === binding.generationOwner.generationId)!
    expect({ state: generation.state, build: generation.build_status, coverage: generation.coverage_status, ownerKind: generation.owner_kind, ownerFence: String(generation.owner_fence) }).toEqual({ state: 'building', build: 'abandoned', coverage: 'incomplete', ownerKind: 'archive_cleanup', ownerFence: '2' })
    expect(rows(released, 'meta_recovery_archive_attachment_refs').filter(row => row.generation_id === generation.generation_id && row.reference_class === 'source')).toEqual([])
    for (const table of Object.keys(beforeCleanup.rows).filter(name => name !== 'meta_sheets' && !name.startsWith('meta_recovery_archive'))) expect(released.rows[table]).toEqual(beforeCleanup.rows[table])
    expect(released.rows.meta_recovery_archive_keys).toEqual(beforeCleanup.rows.meta_recovery_archive_keys)
    expect(released.chainSequence).toEqual(beforeCleanup.chainSequence); expect(released.physical).toEqual(beforeCleanup.physical)
    const outcome = await execute(entry), after = await observe('SAME_ENTRY_AFTER_OWNER_CLEANUP', released, outcome)
    positive(entry, released, after, outcome)
  })
  test.each(recordEntries)('%s archive OFF keeps legacy fence refusal', async entry => {
    const f = current(); await tracked(f.claim(authorize)); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; resetProbe()
    const before = await f.snapshot(), outcome = await execute(entry), after = await observe('ARCHIVE_OFF_FENCE_ON', before, outcome)
    refuse(entry, outcome); expect(digest(after)).toBe(digest(before))
  })
  test.each(recordEntries)('%s writer fence OFF retains ordinary legacy behavior', async entry => {
    const f = current(); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'; resetProbe()
    const before = await f.snapshot(), outcome = await execute(entry), after = await observe('WRITER_OFF', before, outcome)
    positive(entry, before, after, outcome)
  })
})
