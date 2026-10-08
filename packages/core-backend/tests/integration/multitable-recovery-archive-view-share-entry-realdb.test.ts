import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Request } from 'express'
import { Pool } from 'pg'
import { register } from 'prom-client'
import request from 'supertest'
import { z } from 'zod'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { gate, reached, type RecordsEntryFixture } from '../utils/recovery-archive-records-entry-fixture'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const native = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: view_share entry real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('VIEW_SHARE_ENTRY_DATABASE_URL_REQUIRED')
})
const entries = ['VIEW_CREATE', 'VIEW_DELETE', 'LAZY_GET', 'FORM_SHARE_PATCH', 'FORM_SHARE_REGENERATE'] as const
const explicitWriters = ['VIEW_CREATE', 'VIEW_DELETE', 'FORM_SHARE_PATCH', 'FORM_SHARE_REGENERATE'] as const
const viewLoaders = ['VIEW_DELETE', 'FORM_SHARE_PATCH', 'FORM_SHARE_REGENERATE'] as const
const formWriters = ['FORM_SHARE_PATCH', 'FORM_SHARE_REGENERATE'] as const
const historyKeys = ['name', 'type', 'filterInfo', 'sortInfo', 'groupInfo', 'hiddenFieldIds', 'config']
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
type Entry = typeof entries[number]
type State = Awaited<ReturnType<RecordsEntryFixture['snapshot']>>
type Response = { status: number; body: unknown }
type Session = { id: string; roles: string[]; perms: string[] }
type Row = Record<string, unknown>
const blocked: Response = { status: 409, body: { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } } }
const forbidden: Response = { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } } }
const absent: Response = { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } } }
const deleted: Response = { status: 404, body: { ok: false, error: { code: 'SHEET_DELETED', message: 'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.' } } }
const flagNames = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE', 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', 'MULTITABLE_ENABLE_PERSONAL_VIEWS', 'ATTACHMENT_PATH']
function rows(state: State, table: string): Row[] {
  return (state.rows[table] ?? []).map(item => JSON.parse(item.row) as Row)
}
function requiredRow(state: State, table: string, id: string): Row {
  const row = rows(state, table).find(value => value.id === id)
  if (!row) throw new Error('VIEW_SHARE_ENTRY_ROW_MISSING')
  return row
}
function projection(row: Row): Row {
  return { name: row.name, type: row.type, filterInfo: row.filter_info, sortInfo: row.sort_info, groupInfo: row.group_info, hiddenFieldIds: row.hidden_field_ids, config: row.config }
}
function wireView(row: Row): Row {
  return { id: row.id, sheetId: row.sheet_id, ...projection(row) }
}

native('genuine archive admission at existing shared-view and form-share REST entries', () => {
  const pinned = usePinnedServer()
  let admin: Pool, savedFlags: Array<string | undefined>
  let fixture: RecordsEntryFixture | undefined
  let actor: Session, operator: Session, nonReader: Session
  let authorize: (query: QueryFn, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>
  let resetProbe: typeof import('../../src/multitable/canonical-sheet-fence').__resetRecoveryWriterStateColumnProbe
  const releases = new Set<() => void>(), pending = new Set<Promise<unknown>>()
  function current() { if (!fixture) throw new Error('VIEW_SHARE_ENTRY_FIXTURE_NOT_INITIALIZED'); return fixture }
  function barrier() { const value = gate(); releases.add(value.release); return value }
  function tracked<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  function createPayload(sheetId: string) {
    return { id: `${sheetId}_new`, sheetId, name: 'Synthetic created view', type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [current().fields.note], config: { synthetic: true } }
  }
  async function prepare(entry: Entry, sheetId = current().sheetId) {
    // Remove only the synthetic seeded view, before any claim or comparison baseline.
    if (entry === 'LAZY_GET') await current().query('DELETE FROM meta_views WHERE sheet_id=$1', [sheetId])
  }
  function execute(entry: Entry, sheetId = current().sheetId, viewId = current().viewId, body?: unknown): Promise<Response> {
    const path = `/api/multitable/sheets/${sheetId}/views/${viewId}/form-share`
    const http = entry === 'VIEW_CREATE' ? request(pinned.url()).post('/api/multitable/views').send(body ?? createPayload(sheetId))
      : entry === 'VIEW_DELETE' ? request(pinned.url()).delete(`/api/multitable/views/${viewId}`)
        : entry === 'LAZY_GET' ? request(pinned.url()).get('/api/multitable/views').query({ sheetId })
          : entry === 'FORM_SHARE_PATCH' ? request(pinned.url()).patch(path).send(body ?? { enabled: true, accessMode: 'dingtalk' })
            : request(pinned.url()).post(`${path}/regenerate`).send({})
    // Eager assimilation starts the real HTTP request before native barrier waits.
    return tracked(http.then(response => ({ status: response.status, body: response.body as unknown })))
  }
  function shareResponse(config: Row): Row {
    const publicForm = config.publicForm as Row
    return { enabled: publicForm.enabled, publicToken: publicForm.publicToken, expiresAt: null, status: publicForm.enabled ? 'active' : 'disabled', accessMode: publicForm.accessMode, allowedUserIds: [], allowedUsers: [], allowedMemberGroupIds: [], allowedMemberGroups: [] }
  }
  async function observe(code: string, before: State, response: Response) {
    const f = current(), after = await f.snapshot()
    await f.save(code, { before, after, response, clients: f.control.clients, activeTransactions: f.control.activeTransactions, commits: f.control.commits })
    return after
  }
  function positive(entry: Entry, before: State, after: State, response: Response, sheetId = current().sheetId, viewId = current().viewId) {
    const f = current(), oldViews = rows(before, 'meta_views'), newViews = rows(after, 'meta_views')
    let entityId = viewId, beforeValue: Row | null = null, afterValue: Row | null = null
    let action = 'update', changedKeys = ['config']
    if (entry === 'VIEW_CREATE' || entry === 'LAZY_GET') {
      const addedViews = newViews.filter(row => !oldViews.some(prior => prior.id === row.id))
      expect(addedViews).toHaveLength(1)
      const added = addedViews[0]!
      entityId = String(added.id); action = 'create'; changedKeys = historyKeys
      const value = entry === 'VIEW_CREATE' ? createPayload(sheetId) : { id: entityId, sheetId, name: '默认视图', type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} }
      if (entry === 'LAZY_GET') expect(entityId).toMatch(/^view_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
      expect(added).toEqual({ id: value.id, sheet_id: sheetId, name: value.name, type: value.type, filter_info: value.filterInfo, sort_info: value.sortInfo, group_info: value.groupInfo, hidden_field_ids: value.hiddenFieldIds, config: value.config, created_at: expect.any(String), updated_at: added.created_at })
      expect(Number.isFinite(Date.parse(String(added.created_at)))).toBe(true)
      expect(newViews.filter(row => row.id !== entityId)).toEqual(oldViews)
      afterValue = { name: value.name, type: value.type, filterInfo: value.filterInfo, sortInfo: value.sortInfo, groupInfo: value.groupInfo, hiddenFieldIds: value.hiddenFieldIds, config: value.config }
      expect(response).toEqual({ status: entry === 'VIEW_CREATE' ? 201 : 200, body: { ok: true, data: entry === 'VIEW_CREATE' ? { view: value } : { views: [value] } } })
    } else if (entry === 'VIEW_DELETE') {
      const prior = requiredRow(before, 'meta_views', viewId)
      beforeValue = projection(prior); action = 'delete'; changedKeys = historyKeys
      expect(newViews).toEqual(oldViews.filter(row => row.id !== viewId))
      expect(response).toEqual({ status: 200, body: { ok: true, data: { deleted: viewId } } })
    } else {
      const prior = requiredRow(before, 'meta_views', viewId), next = requiredRow(after, 'meta_views', viewId)
      const config = prior.config as Row, publicForm = config.publicForm as Row
      let nextPublicForm: Row
      if (entry === 'FORM_SHARE_PATCH') nextPublicForm = { ...publicForm, enabled: true, accessMode: 'dingtalk' }
      else {
        const token = (next.config as Row).publicForm as Row
        expect(token.publicToken).toMatch(/^pub_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
        expect(token.publicToken).not.toBe(publicForm.publicToken)
        nextPublicForm = { ...publicForm, publicToken: token.publicToken }
      }
      const nextConfig = { ...config, publicForm: nextPublicForm }
      expect(next).toEqual({ ...prior, config: nextConfig })
      expect(newViews.filter(row => row.id !== viewId)).toEqual(oldViews.filter(row => row.id !== viewId))
      beforeValue = { config }; afterValue = { config: nextConfig }
      expect(response).toEqual({ status: 200, body: { ok: true, data: entry === 'FORM_SHARE_PATCH' ? shareResponse(nextConfig) : { publicToken: nextPublicForm.publicToken } } })
    }
    expect(f.control.commits).toBe(1)
    const oldRevisions = rows(before, 'meta_config_revisions'), oldIds = new Set(oldRevisions.map(row => row.id))
    const newRevisions = rows(after, 'meta_config_revisions'), added = newRevisions.filter(row => !oldIds.has(row.id))
    expect(added).toHaveLength(1)
    const revision = added[0]!
    expect(revision).toEqual({ id: expect.stringMatching(uuid), sheet_id: sheetId, entity_type: 'view', entity_id: entityId, action, before: beforeValue, after: afterValue, changed_keys: changedKeys, batch_id: expect.stringMatching(uuid), actor_id: f.identity.actorId, created_at: expect.any(String), source: 'mutation', restored_from_id: null, operation_id: null })
    expect(Number.isFinite(Date.parse(String(revision.created_at)))).toBe(true)
    expect(newRevisions.filter(row => oldIds.has(row.id))).toEqual(oldRevisions)
    // V1 view projection exists; admission here does not establish capture or restore.
    for (const table of Object.keys(before.rows).filter(name => !['meta_views', 'meta_config_revisions'].includes(name))) expect(after.rows[table]).toEqual(before.rows[table])
    expect(after.chainSequence).toEqual(before.chainSequence); expect(after.physical).toEqual(before.physical)
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
    process.env.MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA = 'false'; process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'false'
    register.clear(); vi.resetModules()
    const logger = await import('../../src/core/logger')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger.Logger.prototype, method).mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => console.log('VIEW_SHARE_ENTRY_ROUTE_ERROR'))
    const fixtureModule = await import('../utils/recovery-archive-records-entry-fixture')
    fixture = await fixtureModule.createRecordsEntryFixture(admin, expect.getState().currentTestName ?? 'VIEW_SHARE_ENTRY_CASE')
    const f = current()
    process.env.ATTACHMENT_PATH = f.sourceRoot
    await f.query('UPDATE meta_views SET config=$2::jsonb WHERE id=$1', [f.viewId, JSON.stringify({ synthetic: 'retained', publicForm: { enabled: false, publicToken: `pub_${randomUUID()}`, accessMode: 'public', allowedUserIds: [], allowedMemberGroupIds: [] } })])
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue(f.adapter as unknown as ReturnType<typeof poolManager.get>)
    const fence = await import('../../src/multitable/canonical-sheet-fence')
    fence.__resetRecoveryWriterStateColumnProbe(); resetProbe = fence.__resetRecoveryWriterStateColumnProbe
    const { univerMetaRouter, hasFullTableReadAccess } = await import('../../src/routes/univer-meta')
    const { bindRecoveryArchiveScopeAuthorization } = await import('../../src/multitable/recovery-archive-worker-authorization')
    authorize = bindRecoveryArchiveScopeAuthorization((query, sheetId, authority) => hasFullTableReadAccess(undefined, query, sheetId, authority.access, authority.capabilities))
    actor = await session(f.identity.actorId)
    const operatorId = randomUUID()
    await f.query(`INSERT INTO users(id,email,password_hash,role,permissions) VALUES($1,$2,'synthetic-unused','member','["multitable:read"]')`, [operatorId, `${operatorId}@synthetic.invalid`])
    operator = await session(operatorId)
    const nonReaderId = randomUUID()
    await f.query(`INSERT INTO users(id,email,password_hash,role,permissions) VALUES($1,$2,'synthetic-unused','member','["comments:read"]')`, [nonReaderId, `${nonReaderId}@synthetic.invalid`])
    nonReader = await session(nonReaderId)
    const { resolveSheetCapabilities } = await import('../../src/multitable/permission-service')
    const actorCapabilities: Record<string, { canRead: boolean; canManageViews: boolean }> = {}
    for (const [code, principal, expected] of [
      ['ADMIN', actor, { canRead: true, canManageViews: true }],
      ['READ_ONLY_OPERATOR', operator, { canRead: true, canManageViews: false }],
      ['NON_READER', nonReader, { canRead: false, canManageViews: false }],
    ] as const) {
      // Synthetic request-shaped session seam; principals were hydrated from the real DB.
      const { capabilities } = await resolveSheetCapabilities({ user: principal } as unknown as Request, f.adapter.query, f.sheetId)
      actorCapabilities[code] = { canRead: capabilities.canRead, canManageViews: capabilities.canManageViews }
      expect(actorCapabilities[code]).toEqual(expected)
    }
    await f.save('ACTOR_CAPABILITIES', { code: 'PRODUCTION_SCOPE_CAPABILITY_POSITIVE_CONTROLS', actorCapabilities })
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = actor; next() })
    app.use('/api/multitable', univerMetaRouter()); pinned.setApp(app)
    f.control.commits = 0
    await f.save('VIEW_SHARE_CASE_SOURCE', { code: 'ACTUAL_ROUTER_SYNTHETIC_DATABASE_SESSIONS', callerFixedBase: '003bad9f2e78094322ea1cc18e66bacac3205daa', helperOriginMarker: 'LEGACY_INITIALIZED_INPUT_BASE_IS_NOT_CALLER_SOURCE_PROOF', source: await f.snapshot(), transactionDepth: f.transactionDepthProbe.currentTransactionDepth(), pendingCharacterization: 'COMMITTED_DELETE_TOCTOU_AND_CURRENT_TRANSACTION_AUTHORITY' })
  }, 30000)
  afterEach(async () => {
    for (const release of releases) release()
    const settled = await Promise.allSettled([...pending]); releases.clear(); pending.clear()
    try {
      if (fixture) {
        const depthObserved = fixture.nativeCalls.every(call => !/^BEGIN\b/i.test(call.sql) || call.transactionDepth === 1)
          && fixture.nativeCalls.every(call => !/^(COMMIT|ROLLBACK)\b/i.test(call.sql) || call.transactionDepth === 0)
        try { await fixture.save('DRAINED', { rejected: settled.filter(value => value.status === 'rejected').length, clients: fixture.control.clients, activeTransactions: fixture.control.activeTransactions, depthObserved, nativeCalls: fixture.nativeCalls }) }
        finally { await fixture.dispose() }
        expect(depthObserved).toBe(true)
      }
    } finally { vi.restoreAllMocks(); register.clear(); vi.resetModules(); resetProbe?.() }
  })
  afterAll(async () => {
    flagNames.forEach((name, index) => { if (savedFlags[index] === undefined) delete process.env[name]; else process.env[name] = savedFlags[index] })
    await admin?.end()
  })

  test.each(entries)('%s unblocked actual entry commits only its view config revision', async entry => {
    await prepare(entry)
    const f = current(), before = await f.snapshot(), response = await execute(entry), after = await observe('UNBLOCKED', before, response)
    positive(entry, before, after, response)
  })
  test.each(entries)('%s genuine live committed claim refuses with unchanged heap, seq and source', async entry => {
    await prepare(entry)
    const f = current(); await tracked(f.claim(authorize))
    const leaseBefore = await f.leaseState(), before = await f.snapshot(), response = await execute(entry), after = await observe('LIVE_CLAIM_REFUSAL', before, response), leaseAfter = await f.leaseState()
    await f.save('LIVE_LEASE_PROOF', { leaseBefore, leaseAfter })
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
    expect(leaseBefore).toEqual([{ live: true, expired: false }]); expect(leaseAfter).toEqual(leaseBefore)
  })
  test.each(entries)('%s SQL-clock-expired genuine claim remains blocked without side effects', async entry => {
    await prepare(entry)
    const f = current(); await tracked(f.claim(authorize, 1)); await f.expire()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('EXPIRED_CLAIM_REFUSAL', before, response)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s claim holds canonical fence first, actual writer waits then refuses', async entry => {
    await prepare(entry)
    const f = current(), entered = barrier(), finish = barrier(), writerEntered = barrier(), writerFinish = barrier()
    f.control.hook = async (phase, sql, params) => {
      if (phase === 'claim' && canonical(sql, params)) { entered.release(); await finish.promise }
    }
    const claiming = tracked(f.claim(authorize)); let writing: Promise<Response> | undefined
    let before: State | undefined, response: Response | undefined
    try {
      await reached(entered.promise); writing = execute(entry); await f.waitForBlocking(f.control.claimPid)
      f.control.hook = async (phase, sql, params) => {
        if (phase === 'operation' && canonical(sql, params)) { writerEntered.release(); await writerFinish.promise }
      }
      finish.release(); await claiming; await reached(writerEntered.promise)
      before = await f.snapshot(); writerFinish.release(); response = await writing
    } finally { finish.release(); writerFinish.release() }
    const after = await observe('CLAIM_FIRST_NATIVE_WAIT', before!, response!)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s writer COMMIT is visible on the genuine original waiting claim client', async entry => {
    await prepare(entry)
    const f = current(), before = await f.snapshot(), entered = barrier(), finish = barrier(), claimEntered = barrier(), claimFinish = barrier()
    let claimObserved: { views: unknown[]; revisions: unknown[] } | undefined
    f.control.hook = async (phase, sql, params, client) => {
      if (phase === 'operation' && canonical(sql, params)) { entered.release(); await finish.promise }
      if (phase === 'claim' && canonical(sql, params)) { claimEntered.release(); await claimFinish.promise }
      if (phase === 'claim' && sql.includes('WHERE s.id=$1 AND s.base_id=$2 AND b.workspace_id=$3')) {
        // Observer uses the original real claim client after its fulfilled native scope query.
        claimObserved = {
          views: (await client.query('SELECT to_jsonb(v) AS view FROM meta_views v WHERE sheet_id=$1 ORDER BY id COLLATE "C"', [f.sheetId])).rows,
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
    await f.save('CLAIM_COMMITTED_VIEW_OBSERVATION', { binding, claimObserved, writerCommitted, after, nativeCalls: f.nativeCalls, code: 'ADMISSION_PROTECTION_NOT_VIEW_ARCHIVE_CAPTURE_OR_RESTORE' })
    expect(claimObserved).toEqual({
      views: rows(writerCommitted!, 'meta_views').filter(row => row.sheet_id === f.sheetId).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0).map(view => ({ view })),
      revisions: rows(writerCommitted!, 'meta_config_revisions').filter(row => row.sheet_id === f.sheetId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))).map(revision => ({ revision })),
    })
    // Config writers mint no record operation, allocator value or section head.
    const operations = rows(writerCommitted!, 'meta_record_history_operations').filter(row => row.sheet_id === f.sheetId).sort((a, b) => BigInt(String(a.endpoint_seq)) < BigInt(String(b.endpoint_seq)) ? 1 : -1)
    const sectionHeads = new Map<string, Row>()
    const { SECTION_CAUSALITY_DATA_SECTION_KINDS } = await import('../../src/multitable/recovery-archive-seals')
    for (const row of rows(writerCommitted!, 'meta_sheet_section_revisions').filter(row => row.sheet_id === f.sheetId && SECTION_CAUSALITY_DATA_SECTION_KINDS.includes(row.section_kind as typeof SECTION_CAUSALITY_DATA_SECTION_KINDS[number]))) {
      const previous = sectionHeads.get(String(row.section_kind))
      if (!previous || BigInt(String(row.seq)) > BigInt(String(previous.seq))) sectionHeads.set(String(row.section_kind), row)
    }
    const head = operations[0]
    expect(binding.observedHeads).toEqual({ operationHead: head ? { operationId: head.operation_id, endpointSeq: String(head.endpoint_seq) } : null, sectionHeads: [...sectionHeads].sort(([a], [b]) => a.localeCompare(b)).map(([sectionKind, row]) => ({ sectionKind, operationId: row.operation_id, seq: String(row.seq) })) })
    expect(after.rows.meta_views).toEqual(writerCommitted!.rows.meta_views)
    expect(after.rows.meta_config_revisions).toEqual(writerCommitted!.rows.meta_config_revisions)
    expect(after.rows.meta_record_history_operations).toEqual(writerCommitted!.rows.meta_record_history_operations)
    expect(after.rows.meta_sheet_section_revisions).toEqual(writerCommitted!.rows.meta_sheet_section_revisions)
    // The writer leaves the allocator unchanged; the subsequent real claim allocates its plan.
    const plan = binding.reservationPlan, reservationCount = plan.sections.length + 1
    expect(f.nativeCalls.filter(call => /\bnextval\s*\(/i.test(call.sql))).toEqual([{
      phase: 'claim', sql: `SELECT ordinal::int AS ordinal, nextval('meta_record_chain_seq')::text AS endpoint_seq
       FROM generate_series(1, $1::int) AS ordinal
      ORDER BY ordinal`, params: [reservationCount], rowCount: reservationCount, transactionDepth: 1,
    }])
    expect(after.chainSequence).toEqual([{ last_value: plan.snapshotSeq, is_called: true }])
    const oldReservations = rows(writerCommitted!, 'meta_recovery_archive_snapshot_reservations')
    const newReservations = rows(after, 'meta_recovery_archive_snapshot_reservations')
    const addedReservations = newReservations.filter(row => row.generation_id === plan.generationId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    expect(oldReservations.filter(row => row.generation_id === plan.generationId)).toEqual([])
    expect(newReservations.filter(row => row.generation_id !== plan.generationId)).toEqual(oldReservations)
    const expectedReservations = [
      ...plan.sections.map(section => ({ ordinal: section.ordinal, reservation_kind: binding.repeat ? 'section_checkpoint' : 'section_bootstrap', section_kind: section.sectionKind, operation_id: section.operationId, endpoint_seq: section.endpointSeq })),
      { ordinal: reservationCount, reservation_kind: 'archive_snapshot', section_kind: null, operation_id: plan.snapshotOperationId, endpoint_seq: plan.snapshotSeq },
    ].map(row => ({ ...row, generation_id: plan.generationId, sheet_id: plan.sheetId, source_vector_hash: plan.sourceVectorHash, owner_kind: plan.ownerKind, owner_id: plan.ownerId, owner_fence: plan.ownerFence, created_at: expect.any(String) }))
    expect(addedReservations.map(row => ({ ...row, endpoint_seq: String(row.endpoint_seq), owner_fence: String(row.owner_fence) }))).toEqual(expectedReservations)
    for (const row of addedReservations) expect(Date.parse(String(row.created_at))).toBe(Date.parse(binding.generationClaimedAt))
    expect(writerCommitted!.chainSequence).toHaveLength(1)
    const priorSequence = writerCommitted!.chainSequence[0] as { last_value: string; is_called: boolean }
    const firstReservedSeq = BigInt(priorSequence.last_value) + (priorSequence.is_called ? 1n : 0n)
    expect(addedReservations.map(row => String(row.endpoint_seq))).toEqual(Array.from({ length: reservationCount }, (_, index) => String(firstReservedSeq + BigInt(index))))
    expect(after.physical).toEqual(writerCommitted!.physical)
  })
  test.each(entries)('%s exact-owner terminal cleanup permits the same route with durable fence retained', async entry => {
    await prepare(entry)
    const f = current(), binding = await tracked(f.claim(authorize, 1)); await f.expire()
    const beforeCleanup = await f.snapshot(), cleanup = await tracked(f.cleanup(binding.generationOwner.generationId)), released = await f.snapshot()
    await f.save('OWNER_TERMINAL_CLEANUP', { binding, cleanup, before: beforeCleanup, after: released })
    expect(cleanup).toEqual({ outcome: 'complete', confirmed: 1 })
    const prior = requiredRow(beforeCleanup, 'meta_sheets', f.sheetId), next = requiredRow(released, 'meta_sheets', f.sheetId)
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
    await prepare(entry)
    const f = current(); await tracked(f.claim(authorize)); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; resetProbe()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('ARCHIVE_OFF_FENCE_ON', before, response)
    expect(response).toEqual(blocked); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(entries)('%s ordinary archive OFF and fence OFF preserves exact legacy view history', async entry => {
    await prepare(entry)
    const f = current(); process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'; process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'; resetProbe()
    const before = await f.snapshot(), response = await execute(entry), after = await observe('ORDINARY_FLAGS_OFF', before, response)
    positive(entry, before, after, response)
    expect(f.nativeCalls.some(call => call.sql.includes('pg_advisory_xact_lock'))).toBe(false)
  })
  test.each(explicitWriters)('%s real database non-management actor is forbidden before any write', async entry => {
    const f = current(); actor = operator
    const before = await f.snapshot(), response = await execute(entry), after = await observe('NON_MANAGEMENT_ACTOR', before, response)
    expect(response).toEqual(forbidden); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test('empty GET by a real non-management reader succeeds without lazy insertion under genuine claim', async () => {
    const f = current(); await prepare('LAZY_GET'); await tracked(f.claim(authorize)); actor = operator
    const before = await f.snapshot(), response = await execute('LAZY_GET'), after = await observe('READ_ONLY_EMPTY_GET', before, response)
    expect(response).toEqual({ status: 200, body: { ok: true, data: { views: [] } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(['admin', 'operator'] as const)('populated GET under real %s session is read-only under genuine claim', async authority => {
    const f = current(); await tracked(f.claim(authorize)); if (authority === 'operator') actor = operator
    const before = await f.snapshot(), response = await execute('LAZY_GET'), after = await observe('READ_ONLY_POPULATED_GET', before, response)
    expect(response).toEqual({ status: 200, body: { ok: true, data: { views: [wireView(requiredRow(before, 'meta_views', f.viewId))] } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test('GET with no real database read authority refuses before lazy insertion', async () => {
    const f = current(); await prepare('LAZY_GET'); actor = nonReader
    const before = await f.snapshot(), response = await execute('LAZY_GET'), after = await observe('GET_NO_READ_AUTHORITY', before, response)
    expect(response).toEqual(forbidden); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test('GET missing sheetId query is rejected before any write', async () => {
    const f = current(), before = await f.snapshot()
    const response = await tracked<Response>(request(pinned.url()).get('/api/multitable/views').then(value => ({ status: value.status, body: value.body as unknown })))
    const after = await observe('GET_MISSING_QUERY', before, response)
    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(viewLoaders)('%s missing view returns actual lookup refusal before any write', async entry => {
    const f = current(), viewId = `${f.viewId}_missing`; actor = operator
    const before = await f.snapshot(), response = await execute(entry, f.sheetId, viewId), after = await observe('MISSING_VIEW', before, response)
    expect(response).toEqual({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(formWriters)('%s sheet/view mismatch preserves actual lookup contract', async entry => {
    const f = current(), sheetId = `${f.sheetId}_mismatch`; actor = operator
    const before = await f.snapshot(), response = await execute(entry, sheetId), after = await observe('SHEET_VIEW_MISMATCH', before, response)
    expect(response).toEqual({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: `View ${f.viewId} does not belong to sheet ${sheetId}` } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test.each(['VIEW_CREATE', 'LAZY_GET'] as const)('%s missing sheet refuses without heap or allocator changes', async entry => {
    const f = current(), sheetId = `${f.sheetId}_missing`
    const before = await f.snapshot(), response = await execute(entry, sheetId), after = await observe('MISSING_SHEET', before, response)
    expect(response).toEqual(absent); expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  for (const authority of ['admin', 'operator'] as const) {
    test.each(entries)(`%s preflight deleted sheet under real ${authority} session preserves exact refusal`, async entry => {
      await prepare(entry)
      const f = current(); await f.query('UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id=$1', [f.sheetId])
      if (authority === 'operator') actor = operator
      const before = await f.snapshot(), response = await execute(entry), after = await observe('PREFLIGHT_DELETED_SHEET', before, response)
      expect(response).toEqual(authority === 'operator' && entry !== 'LAZY_GET' ? forbidden : deleted)
      expect(after).toEqual(before); expect(f.control.commits).toBe(0)
    })
  }
  test.each(['VIEW_CREATE', 'FORM_SHARE_PATCH'] as const)('%s invalid payload refuses without heap or allocator changes', async entry => {
    const f = current(), invalid = entry === 'VIEW_CREATE' ? { sheetId: f.sheetId, name: '' } : { enabled: 'true' }
    const parsed = entry === 'VIEW_CREATE' ? z.object({ sheetId: z.string().min(1).max(50), name: z.string().min(1).max(255) }).safeParse(invalid) : z.object({ enabled: z.boolean().optional() }).safeParse(invalid)
    if (parsed.success) throw new Error('VIEW_SHARE_ENTRY_INVALID_FIXTURE_ACCEPTED')
    const before = await f.snapshot(), response = await execute(entry, f.sheetId, f.viewId, invalid), after = await observe('INVALID_PAYLOAD', before, response)
    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test('form-share invalid accessMode is rejected rather than silently normalized', async () => {
    const f = current(), invalid = { accessMode: 'unknown' }, parsed = z.object({ accessMode: z.enum(['public', 'dingtalk', 'dingtalk_granted']).optional() }).safeParse(invalid)
    if (parsed.success) throw new Error('VIEW_SHARE_ENTRY_INVALID_FIXTURE_ACCEPTED')
    const before = await f.snapshot(), response = await execute('FORM_SHARE_PATCH', f.sheetId, f.viewId, invalid), after = await observe('INVALID_ACCESS_MODE', before, response)
    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(0)
  })
  test('form-share no-op succeeds without new config revision, allocator or physical change', async () => {
    const f = current(), before = await f.snapshot(), config = requiredRow(before, 'meta_views', f.viewId).config as Row
    const response = await execute('FORM_SHARE_PATCH', f.sheetId, f.viewId, {}), after = await observe('FORM_SHARE_NO_OP', before, response)
    expect(response).toEqual({ status: 200, body: { ok: true, data: shareResponse(config) } })
    expect(after).toEqual(before); expect(f.control.commits).toBe(1)
  })
  test.each(entries)('%s same-base other-sheet positive remains usable despite main-sheet genuine claim', async entry => {
    const f = current(), otherId = `${f.sheetId}_other`, otherViewId = `${otherId}_view`
    await f.query("INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic other')", [otherId, f.identity.baseId])
    if (entry !== 'LAZY_GET') await f.query('INSERT INTO meta_views(id,sheet_id,name,type,config) SELECT $1,$2,name,type,config FROM meta_views WHERE id=$3', [otherViewId, otherId, f.viewId])
    await tracked(f.claim(authorize))
    const before = await f.snapshot(), response = await execute(entry, otherId, otherViewId), after = await observe('OTHER_SHEET_POSITIVE', before, response)
    positive(entry, before, after, response, otherId, otherViewId)
  })
  // These five routes have preflight liveness checks only. Native committed-delete TOCTOU
  // and current-transaction authority characterization remain pending, with no claimed guard.
})
