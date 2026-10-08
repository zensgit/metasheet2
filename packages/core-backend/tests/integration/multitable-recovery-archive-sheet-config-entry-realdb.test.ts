import { randomUUID } from 'node:crypto'
import express from 'express'
import { Pool } from 'pg'
import { register } from 'prom-client'
import request from 'supertest'
import { z } from 'zod'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { digest, gate, reached, type RecordsEntryFixture } from '../utils/recovery-archive-records-entry-fixture'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const native = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: sheet_config entry real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('SHEET_CONFIG_ENTRY_DATABASE_URL_REQUIRED')
})
const entries = ['ROW_LEVEL_DENY', 'CONDITIONAL_RULES', 'SHEET_RENAME'] as const
type Entry = typeof entries[number]
type State = Awaited<ReturnType<RecordsEntryFixture['snapshot']>>
type Response = { status: number; body: unknown }
type Session = { id: string; roles: string[]; perms: string[] }
const blocked: Response = { status: 409, body: { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } } }
const renameForbidden = 'Renaming requires schema authority: an admin role or the multitable:manage-schema permission. multitable:write alone is not sufficient.'
const deleted: Response = { status: 404, body: { ok: false, error: { code: 'SHEET_DELETED', message: 'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.' } } }
const absent: Response = { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } } }
const flagNames = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', 'ATTACHMENT_PATH']
const columns: Record<Entry, string> = { ROW_LEVEL_DENY: 'row_level_read_permissions_enabled', CONDITIONAL_RULES: 'conditional_read_rules', SHEET_RENAME: 'name' }
const keys: Record<Entry, string> = { ROW_LEVEL_DENY: 'rowLevelReadPermissionsEnabled', CONDITIONAL_RULES: 'conditionalReadRules', SHEET_RENAME: 'name' }
function rows(state: State, table: string): Array<Record<string, unknown>> {
  return (state.rows[table] ?? []).map(item => JSON.parse(item.row) as Record<string, unknown>)
}
function sheet(state: State, sheetId: string) {
  const row = rows(state, 'meta_sheets').find(value => value.id === sheetId)
  if (!row) throw new Error('SHEET_CONFIG_ENTRY_SHEET_MISSING')
  return row
}
function forbidden(entry: Entry): Response {
  return { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: entry === 'SHEET_RENAME' ? renameForbidden : 'Insufficient permissions' } } }
}

native('genuine archive admission at existing sheet_config REST entries', () => {
  const pinned = usePinnedServer()
  let admin: Pool, savedFlags: Array<string | undefined>
  let fixture: RecordsEntryFixture | undefined
  let actor: Session, operator: Session
  let authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>
  let resetProbe: typeof import('../../src/multitable/canonical-sheet-fence').__resetRecoveryWriterStateColumnProbe
  const releases = new Set<() => void>(), pending = new Set<Promise<unknown>>()
  function current() { if (!fixture) throw new Error('SHEET_CONFIG_ENTRY_FIXTURE_NOT_INITIALIZED'); return fixture }
  function barrier() { const value = gate(); releases.add(value.release); return value }
  function tracked<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  function changedValue(entry: Entry) {
    if (entry === 'ROW_LEVEL_DENY') return true
    if (entry === 'CONDITIONAL_RULES') return [{ id: 'synthetic-rule', fieldId: current().fields.title, operator: 'eq', value: 'synthetic-denied', effect: 'deny_read' }]
    return 'Synthetic renamed sheet'
  }
  function payload(entry: Entry, value: unknown = changedValue(entry)) {
    return entry === 'ROW_LEVEL_DENY' ? { enabled: value } : entry === 'CONDITIONAL_RULES' ? { rules: value } : { name: value }
  }
  function execute(entry: Entry, sheetId = current().sheetId, body: unknown = payload(entry)): Promise<Response> {
    const path = `/api/multitable/sheets/${sheetId}`
    const http = entry === 'SHEET_RENAME' ? request(pinned.url()).patch(path)
      : request(pinned.url()).put(`${path}/${entry === 'ROW_LEVEL_DENY' ? 'row-level-read-deny' : 'conditional-rules'}`)
    // Eager supertest assimilation starts the actual HTTP request before any native barrier wait.
    return tracked(http.send(body).then(response => ({ status: response.status, body: response.body as unknown })))
  }
  function success(entry: Entry, before: State, sheetId: string, value: unknown = changedValue(entry)): Response {
    const prior = sheet(before, sheetId)
    return { status: 200, body: { ok: true, data: entry === 'ROW_LEVEL_DENY' ? { enabled: value }
      : entry === 'CONDITIONAL_RULES' ? { rules: value }
        : { sheet: { id: sheetId, baseId: prior.base_id, name: value, description: prior.description } } } }
  }
  async function observe(code: string, before: State, response: Response) {
    const f = current(), after = await f.snapshot()
    await f.save(code, { before, after, response, clients: f.control.clients, activeTransactions: f.control.activeTransactions, commits: f.control.commits })
    return after
  }
  function positive(entry: Entry, before: State, after: State, response: Response, sheetId = current().sheetId) {
    const f = current(), prior = sheet(before, sheetId), next = sheet(after, sheetId), column = columns[entry], key = keys[entry], value = changedValue(entry)
    expect(response).toEqual(success(entry, before, sheetId))
    expect(f.control.commits).toBe(1)
    expect(next).toEqual({ ...prior, [column]: value })
    expect(rows(after, 'meta_sheets').filter(row => row.id !== sheetId)).toEqual(rows(before, 'meta_sheets').filter(row => row.id !== sheetId))
    const oldRevisions = rows(before, 'meta_config_revisions'), oldIds = new Set(oldRevisions.map(row => row.id))
    const newRevisions = rows(after, 'meta_config_revisions'), added = newRevisions.filter(row => !oldIds.has(row.id))
    expect(added).toHaveLength(1)
    const revision = added[0]!
    expect(revision).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/), sheet_id: sheetId,
      entity_type: 'sheet_config', entity_id: sheetId, action: 'update',
      before: { [key]: prior[column] }, after: { [key]: value }, changed_keys: [key],
      batch_id: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
      actor_id: f.identity.actorId, created_at: expect.any(String), source: 'mutation', restored_from_id: null, operation_id: null,
    })
    expect(Number.isFinite(Date.parse(String(revision.created_at)))).toBe(true)
    expect(newRevisions.filter(row => oldIds.has(row.id))).toEqual(oldRevisions)
    // These actual config-only writers do not mint a record operation/seq/section seal, even fence ON.
    for (const table of Object.keys(before.rows).filter(name => !['meta_sheets', 'meta_config_revisions'].includes(name))) expect(after.rows[table]).toEqual(before.rows[table])
    expect(after.chainSequence).toEqual(before.chainSequence)
    expect(after.physical).toEqual(before.physical)
  }
  async function session(userId: string): Promise<Session> {
    const result = await current().query('SELECT id,role,permissions FROM users WHERE id=$1', [userId])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0] as { id: string; role: string; permissions: string[] }
    return { id: row.id, roles: [row.role], perms: row.permissions }
  }
  function canonical(sql: string, params: unknown[] | undefined) {
    return sql.includes('pg_advisory_xact_lock') && params?.includes(`meta:auto-number:sheet:${current().sheetId}`)
  }
  beforeAll(() => {
    savedFlags = flagNames.map(name => process.env[name])
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 })
  })
  beforeEach(async () => {
    fixture = undefined
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA = 'false'
    register.clear(); vi.resetModules()
    const logger = await import('../../src/core/logger')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger.Logger.prototype, method).mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => console.log('SHEET_CONFIG_ENTRY_ROUTE_ERROR'))
    // Fixture, real router, custody capabilities and real authorization share this reset module graph.
    const fixtureModule = await import('../utils/recovery-archive-records-entry-fixture')
    fixture = await fixtureModule.createRecordsEntryFixture(admin, expect.getState().currentTestName ?? 'SHEET_CONFIG_ENTRY_CASE')
    const f = current()
    process.env.ATTACHMENT_PATH = f.sourceRoot
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue(f.adapter as unknown as ReturnType<typeof poolManager.get>)
    const fence = await import('../../src/multitable/canonical-sheet-fence')
    fence.__resetRecoveryWriterStateColumnProbe(); resetProbe = fence.__resetRecoveryWriterStateColumnProbe
    const { univerMetaRouter, hasFullTableReadAccess } = await import('../../src/routes/univer-meta')
    const { bindRecoveryArchiveScopeAuthorization } = await import('../../src/multitable/recovery-archive-worker-authorization')
    authorize = bindRecoveryArchiveScopeAuthorization((query, sheetId, authority) => hasFullTableReadAccess(undefined, query, sheetId, authority.access, authority.capabilities))
    actor = await session(f.identity.actorId)
    const operatorId = randomUUID()
    await f.query(`INSERT INTO users(id,email,password_hash,role,permissions) VALUES($1,$2,'synthetic-unused','member','["multitable:read","multitable:write"]')`, [operatorId, `${operatorId}@synthetic.invalid`])
    operator = await session(operatorId)
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = actor; next() })
    app.use('/api/multitable', univerMetaRouter()); pinned.setApp(app)
    f.control.commits = 0
    await f.save('SHEET_CONFIG_CASE_SOURCE', {
      code: 'ACTUAL_ROUTER_SYNTHETIC_DATABASE_SESSIONS', callerFixedBase: '8662ede1f64831c2cb3c480400b9c5b6e12d6135',
      helperOriginMarker: 'LEGACY_INITIALIZED_INPUT_BASE_IS_NOT_CALLER_SOURCE_PROOF',
      source: await f.snapshot(), transactionDepth: f.transactionDepthProbe.currentTransactionDepth(),
    })
  }, 30000)
  afterEach(async () => {
    for (const release of releases) release()
    const settled = await Promise.allSettled([...pending]); releases.clear(); pending.clear()
    try {
      if (fixture) {
        const depthObserved = fixture.nativeCalls.every(call => !/^BEGIN\b/i.test(call.sql) || call.transactionDepth === 1)
          && fixture.nativeCalls.every(call => !/^(COMMIT|ROLLBACK)\b/i.test(call.sql) || call.transactionDepth === 0)
        await fixture.save('DRAINED', { rejected: settled.filter(value => value.status === 'rejected').length, clients: fixture.control.clients, activeTransactions: fixture.control.activeTransactions, depthObserved, nativeCalls: fixture.nativeCalls })
        await fixture.dispose()
        expect(depthObserved).toBe(true)
      }
    } finally { vi.restoreAllMocks(); register.clear(); vi.resetModules(); resetProbe?.() }
  })
  afterAll(async () => {
    flagNames.forEach((name, index) => { if (savedFlags[index] === undefined) delete process.env[name]; else process.env[name] = savedFlags[index] })
    await admin?.end()
  })

  test.each(entries)('%s unblocked actual entry commits only its config revision', async entry => {
    const f = current(), before = await f.snapshot(), response = await execute(entry), after = await observe('UNBLOCKED', before, response)
    positive(entry, before, after, response)
  })
  test.each(entries)('%s genuine live committed claim refuses with unchanged heap, seq and source', async entry => {
    const f = current(); await tracked(f.claim(authorize))
    const leaseBefore = await f.leaseState(), before = await f.snapshot(), response = await execute(entry), after = await observe('LIVE_CLAIM_REFUSAL', before, response), leaseAfter = await f.leaseState()
    await f.save('LIVE_LEASE_PROOF', { leaseBefore, leaseAfter })
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
    expect(leaseBefore).toEqual([{ live: true, expired: false }]); expect(leaseAfter).toEqual(leaseBefore)
  })
  test.each(entries)('%s SQL-clock-expired genuine claim remains blocked without side effects', async entry => {
    const f = current(); await tracked(f.claim(authorize, 1)); await f.expire()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('EXPIRED_CLAIM_REFUSAL', before, response)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s claim holds canonical fence first, actual writer waits then refuses', async entry => {
    const f = current(), entered = barrier(), finish = barrier(), writerEntered = barrier(), writerFinish = barrier()
    f.control.hook = async (phase, sql, params) => {
      if (phase === 'claim' && canonical(sql, params)) { entered.release(); await finish.promise }
    }
    const claiming = tracked(f.claim(authorize)); let writing: Promise<Response> | undefined
    let before: State | undefined, response: Response | undefined
    try {
      await reached(entered.promise); writing = execute(entry)
      await f.waitForBlocking(f.control.claimPid)
      f.control.hook = async (phase, sql, params) => {
        if (phase === 'operation' && canonical(sql, params)) { writerEntered.release(); await writerFinish.promise }
      }
      finish.release(); await claiming; await reached(writerEntered.promise)
      // Genuine claim COMMIT is fulfilled before the comparison snapshot; no archive setup delta hides refusal.
      before = await f.snapshot(); writerFinish.release(); response = await writing
    } finally { finish.release(); writerFinish.release() }
    const after = await observe('CLAIM_FIRST_NATIVE_WAIT', before!, response!)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s writer COMMIT precedes genuine waiting claim reads without inventing a config head', async entry => {
    const f = current(), before = await f.snapshot(), entered = barrier(), finish = barrier(), claimEntered = barrier(), claimFinish = barrier()
    let claimObserved: { config: unknown[]; revisions: unknown[] } | undefined
    f.control.hook = async (phase, sql, params, client) => {
      if (phase === 'operation' && canonical(sql, params)) { entered.release(); await finish.promise }
      if (phase === 'claim' && canonical(sql, params)) { claimEntered.release(); await claimFinish.promise }
      if (phase === 'claim' && sql.includes('WHERE s.id=$1 AND s.base_id=$2 AND b.workspace_id=$3')) {
        // Read-only observer on the SAME real claim client AFTER its original fulfilled live-scope query.
        claimObserved = {
          config: (await client.query('SELECT name,row_level_read_permissions_enabled,conditional_read_rules FROM meta_sheets WHERE id=$1', [f.sheetId])).rows,
          revisions: (await client.query('SELECT to_jsonb(r) AS revision FROM meta_config_revisions r WHERE sheet_id=$1 ORDER BY created_at,id', [f.sheetId])).rows,
        }
      }
    }
    const writing = execute(entry); let claiming: ReturnType<RecordsEntryFixture['claim']> | undefined
    let writerCommitted: State | undefined, response: Response | undefined
    try {
      await reached(entered.promise); claiming = tracked(f.claim(authorize)); await f.waitForBlocking(f.control.operationPid)
      finish.release(); response = await writing; await reached(claimEntered.promise)
      writerCommitted = await f.snapshot(); positive(entry, before, writerCommitted, response)
      claimFinish.release(); await claiming
    } finally { finish.release(); claimFinish.release() }
    const binding = await claiming!, after = await observe('WRITER_FIRST_NATIVE_WAIT', writerCommitted!, response!)
    const committedSheet = sheet(writerCommitted!, f.sheetId)
    expect(claimObserved).toEqual({
      config: [{ name: committedSheet.name, row_level_read_permissions_enabled: committedSheet.row_level_read_permissions_enabled, conditional_read_rules: committedSheet.conditional_read_rules }],
      revisions: rows(writerCommitted!, 'meta_config_revisions').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))).map(revision => ({ revision })),
    })
    // V1 declares record operation and section heads only; these sheet_config columns are outside its projection.
    const operations = rows(writerCommitted!, 'meta_record_history_operations').filter(row => row.sheet_id === f.sheetId).sort((a, b) => BigInt(String(a.endpoint_seq)) < BigInt(String(b.endpoint_seq)) ? 1 : -1)
    const sectionHeads = new Map<string, Record<string, unknown>>()
    const { SECTION_CAUSALITY_DATA_SECTION_KINDS } = await import('../../src/multitable/recovery-archive-seals')
    for (const row of rows(writerCommitted!, 'meta_sheet_section_revisions').filter(row => row.sheet_id === f.sheetId && SECTION_CAUSALITY_DATA_SECTION_KINDS.includes(row.section_kind as typeof SECTION_CAUSALITY_DATA_SECTION_KINDS[number]))) {
      const previous = sectionHeads.get(String(row.section_kind))
      if (!previous || BigInt(String(row.seq)) > BigInt(String(previous.seq))) sectionHeads.set(String(row.section_kind), row)
    }
    const head = operations[0]
    expect(binding.observedHeads).toEqual({
      operationHead: head ? { operationId: head.operation_id, endpointSeq: String(head.endpoint_seq) } : null,
      sectionHeads: [...sectionHeads].sort(([a], [b]) => a.localeCompare(b)).map(([sectionKind, row]) => ({ sectionKind, operationId: row.operation_id, seq: String(row.seq) })),
    })
    expect(after.rows.meta_config_revisions).toEqual(writerCommitted!.rows.meta_config_revisions)
    await f.save('CLAIM_COMMITTED_DECLARED_HEADS', { binding, claimObserved, writerCommitted, code: 'ADMISSION_PROTECTION_NOT_SHEET_CONFIG_ARCHIVE_RESTORE' })
  })
  test.each(entries)('%s exact-owner terminal cleanup permits the same route with durable fence retained', async entry => {
    const f = current(), binding = await tracked(f.claim(authorize, 1)); await f.expire()
    const beforeCleanup = await f.snapshot(), cleanup = await tracked(f.cleanup(binding.generationOwner.generationId)), released = await f.snapshot()
    await f.save('OWNER_TERMINAL_CLEANUP', { binding, cleanup, before: beforeCleanup, after: released })
    expect(cleanup).toEqual({ outcome: 'complete', confirmed: 1 })
    const prior = sheet(beforeCleanup, f.sheetId), next = sheet(released, f.sheetId)
    expect(String(prior.recovery_writer_owner_fence)).toBe(binding.writerBlock.fence)
    expect(next).toEqual({ ...prior, recovery_writer_state: null, recovery_writer_owner_id: null, recovery_writer_owner_kind: null, recovery_writer_lease_until: null, recovery_writer_updated_at: null })
    expect(String(next.recovery_writer_owner_fence)).toBe(binding.writerBlock.fence)
    const generation = rows(released, 'meta_recovery_archives').find(row => row.generation_id === binding.generationOwner.generationId)!
    expect({ state: generation.state, build: generation.build_status, coverage: generation.coverage_status, ownerKind: generation.owner_kind, ownerFence: String(generation.owner_fence) }).toEqual({ state: 'building', build: 'abandoned', coverage: 'incomplete', ownerKind: 'archive_cleanup', ownerFence: '2' })
    expect(rows(released, 'meta_recovery_archive_attachment_refs').filter(row => row.generation_id === generation.generation_id && row.reference_class === 'source')).toEqual([])
    expect(rows(released, 'meta_sheets').filter(row => row.id !== f.sheetId)).toEqual(rows(beforeCleanup, 'meta_sheets').filter(row => row.id !== f.sheetId))
    for (const table of Object.keys(beforeCleanup.rows).filter(name => name !== 'meta_sheets' && !name.startsWith('meta_recovery_archive'))) expect(released.rows[table]).toEqual(beforeCleanup.rows[table])
    expect(released.rows.meta_recovery_archive_keys).toEqual(beforeCleanup.rows.meta_recovery_archive_keys)
    expect(released.chainSequence).toEqual(beforeCleanup.chainSequence); expect(released.physical).toEqual(beforeCleanup.physical)
    const response = await execute(entry), after = await observe('SAME_ENTRY_AFTER_OWNER_CLEANUP', released, response)
    positive(entry, released, after, response)
  })
  test.each(entries)('%s archive OFF and fence ON preserves refusal for a genuine committed claim', async entry => {
    const f = current(); await tracked(f.claim(authorize)); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; resetProbe()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('ARCHIVE_OFF_FENCE_ON', before, response)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s ordinary archive OFF and fence OFF preserves the exact legacy config-only shape', async entry => {
    const f = current(); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'; resetProbe()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('ORDINARY_FLAGS_OFF', before, response)
    positive(entry, before, after, response)
    expect(f.nativeCalls.some(call => call.sql.includes('pg_advisory_xact_lock'))).toBe(false)
  })
  test.each(entries)('%s no-op succeeds without new config history, sequence or physical changes', async entry => {
    const f = current(), before = await f.snapshot(), value = sheet(before, f.sheetId)[columns[entry]]
    const response = await execute(entry, f.sheetId, payload(entry, value)), after = await observe('NO_OP', before, response)
    expect(response).toEqual(success(entry, before, f.sheetId, value)); expect(after).toEqual(before); expect(f.control.commits).toBe(1)
  })
  test.each(entries)('%s real database non-management actor is forbidden before any write', async entry => {
    const f = current(); actor = operator
    const before = await f.snapshot(), response = await execute(entry), after = await observe('NON_MANAGEMENT_ACTOR', before, response)
    expect(response).toEqual(forbidden(entry)); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s invalid payload is refused without heap or allocator changes', async entry => {
    const f = current(), invalid = entry === 'ROW_LEVEL_DENY' ? { enabled: 'true' }
      : entry === 'CONDITIONAL_RULES' ? { rules: [{ id: 'synthetic-rule', fieldId: f.fields.title, operator: 'unknown', effect: 'deny_read' }] }
        : { name: '   ' }
    const before = await f.snapshot(), response = await execute(entry, f.sheetId, invalid), after = await observe('INVALID_PAYLOAD', before, response)
    let message = entry === 'CONDITIONAL_RULES' ? 'invalid rule(s): unknown operator' : 'This endpoint accepts only { name }: a string of 1-255 characters after trimming.'
    if (entry === 'ROW_LEVEL_DENY') {
      const invalidBoolean = z.object({ enabled: z.boolean() }).safeParse(invalid)
      if (invalidBoolean.success) throw new Error('SHEET_CONFIG_ENTRY_INVALID_FIXTURE_ACCEPTED')
      message = invalidBoolean.error.message
    }
    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: entry === 'SHEET_RENAME' ? 'INVALID_NAME' : 'VALIDATION_ERROR', message } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  for (const liveness of ['absent', 'deleted'] as const) {
    for (const authority of ['admin', 'operator'] as const) {
      test.each(entries)(`%s ${liveness} sheet under real ${authority} session preserves auth-first contract`, async entry => {
        const f = current(), id = liveness === 'absent' ? `${f.sheetId}_missing` : f.sheetId
        if (liveness === 'deleted') await f.query('UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id=$1', [id])
        if (authority === 'operator') actor = operator
        const before = await f.snapshot(), response = await execute(entry, id), after = await observe('LIVENESS_AUTHORITY', before, response)
        expect(response).toEqual(authority === 'operator' ? forbidden(entry) : liveness === 'deleted' ? deleted : absent)
        expect(after).toEqual(before); expect(f.control.commits).toBe(0)
      })
    }
  }
  test.each(['ROW_LEVEL_DENY', 'CONDITIONAL_RULES'] as const)('%s committed soft delete between actual preflight and transaction write is rechecked', async entry => {
    const f = current(), entered = barrier(), finish = barrier()
    f.control.hook = async (phase, sql) => { if (phase === 'operation' && /^BEGIN\b/.test(sql)) { entered.release(); await finish.promise } }
    const writing = execute(entry); let before: State | undefined, response: Response | undefined
    try {
      await reached(entered.promise)
      // A separate native transaction legally takes the same fence while the writer is before its fence.
      const deleter = await f.pool.connect()
      try {
        await deleter.query('BEGIN')
        await deleter.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${f.sheetId}`])
        await deleter.query('UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id=$1', [f.sheetId])
        await deleter.query('COMMIT')
      } catch (error) { await deleter.query('ROLLBACK'); throw error }
      finally { deleter.release() }
      before = await f.snapshot(); expect(sheet(before, f.sheetId).deleted_at).not.toBeNull()
      finish.release(); response = await writing
    } finally { finish.release() }
    const after = await observe('COMMITTED_DELETE_TOCTOU', before!, response!)
    const { SHEET_ROW_LOCK_LIVENESS_SQL } = await import('../../src/multitable/sheet-liveness')
    expect(f.nativeCalls.filter(call => call.phase === 'operation' && call.sql === SHEET_ROW_LOCK_LIVENESS_SQL)).toHaveLength(1)
    expect(response).toEqual(deleted); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s own other sheet positive control is usable despite main-sheet genuine claim', async entry => {
    const f = current(), otherId = `${f.sheetId}_other`
    await f.query("INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic other')", [otherId, f.identity.baseId])
    await tracked(f.claim(authorize))
    const before = await f.snapshot(), response = await execute(entry, otherId), after = await observe('FOREIGN_SHEET_POSITIVE', before, response)
    positive(entry, before, after, response, otherId)
    expect(digest(sheet(after, f.sheetId))).toBe(digest(sheet(before, f.sheetId)))
  })
})
