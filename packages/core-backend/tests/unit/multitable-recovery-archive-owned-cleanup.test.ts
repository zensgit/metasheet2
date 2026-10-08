import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS } from '../../src/multitable/recovery-archive-seals'
import { computeRecoveryArchiveSourceVectorHash } from '../../src/multitable/recovery-archive-source-vector'
import { bindRecoveryArchiveOwnedCleanup } from '../../src/multitable/recovery-archive-owned-cleanup'

vi.mock('../../src/multitable/recovery-archive-writer-block', () => ({
  prepareArchiveWriterBlockCleanupTransaction: async (query: (sql: string) => Promise<unknown>) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))')
  },
}))
const applicationFactory = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../src/routes/univer-meta', () => ({ createRecoveryArchiveOwnedCleanup: applicationFactory.create }))
import { createRecoveryArchiveApplication, type RecoveryArchiveApplicationComposition } from '../../src/multitable/recovery-archive-application'
afterEach(() => vi.useRealTimers())
const prepared = vi.hoisted(() => ({ admit: vi.fn(), cleanup: vi.fn() }))
vi.mock('../../src/multitable/recovery-archive-abandoned-object-cleanup', () => ({
  admitRecoveryArchiveAbandonedObjectCleanup: prepared.admit,
  cleanupRecoveryArchiveAbandonedObjects: prepared.cleanup,
}))
beforeEach(() => { prepared.admit.mockReset(); prepared.cleanup.mockReset().mockResolvedValue({ outcome: 'retained', confirmed: 0 }) })
const identity = { actorId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' }
const limits = { maxBytes: 65536, timeoutMs: 1000 }
const policy = { keyId: 'key', keyRowVersion: '1', leaseSeconds: 30, expiresAfterSeconds: 60 }
const code = 'RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED'
type Row = Record<string, unknown>

function fixture() {
  const generationId = randomUUID(), requestId = randomUUID(), raw = '2026-10-07 01:02:03.123456+00'
  const sections = SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({ sourceHeadKind: 'section_bootstrap' as const,
    sectionKind, operationId: randomUUID(), headSeq: String(index + 1) }))
  const vector = computeRecoveryArchiveSourceVectorHash(sections).hash
  const reservations: Row[] = [...sections.map((section, index) => ({ ordinal: index + 1, reservation_kind: section.sourceHeadKind,
    section_kind: section.sectionKind, operation_id: section.operationId, endpoint_seq: section.headSeq })),
  { ordinal: 10, reservation_kind: 'archive_snapshot', section_kind: null, operation_id: randomUUID(), endpoint_seq: '10' }]
    .map(row => ({ ...row, sheet_id: identity.sheetId, source_vector_hash: vector, owner_kind: 'archive_builder', owner_id: generationId, owner_fence: '1', created_at: raw }))
  const request = { actor_id: identity.actorId, request_id: requestId, workspace_id: identity.workspaceId, base_id: identity.baseId,
    sheet_id: identity.sheetId, generation_id: generationId,
    request_hash: createHash('sha256').update(JSON.stringify(['recovery-archive-manual-request', 1, identity.actorId, identity.workspaceId, identity.baseId, identity.sheetId])).digest('hex') }
  const pin = (attachmentId: string): Row => ({ attachment_id: attachmentId, reference_class: 'source', reference_state: 'building',
    availability: 'mutable', immutable_version: null, content_sha256: null, content_size_bytes: null, source_owner_kind: 'archive_builder',
    source_owner_id: generationId, source_owner_fence: '1', source_lease_until: raw, cleanup_owner_kind: null, cleanup_owner_id: null, cleanup_owner_fence: null })
  const intent = (attachmentId: string): Row => ({ staging_object_id: randomUUID(), object_class: 'attachment', attachment_id: attachmentId,
    key_id: 'key', object_state: 'pending', terminal_receipt_sha256: null, cleanup_owner_kind: null, cleanup_owner_id: null, cleanup_owner_fence: null })
  const initial = { generation: { generation_id: generationId, workspace_id: identity.workspaceId, base_id: identity.baseId, sheet_id: identity.sheetId,
    key_id: 'key', state: 'building', build_status: 'active', coverage_status: 'incomplete', owner_kind: 'archive_builder', owner_id: generationId,
    owner_fence: '1', source_vector_hash: vector, created_at: raw, lease_expires_at: raw, expired: true,
    anchor_operation_id: reservations[9]!.operation_id, anchor_seq: '10' } as Row,
    block: { state: 'archiving', kind: 'archive_generation', id: generationId, fence: '7', lease: raw, updated: raw, expired: true } as Row,
    pins: [pin('attachment-a'), pin('attachment-b')], intents: [intent('attachment-a'), intent('attachment-b')], reservations,
    request, keyState: 'active', hazard: false, prepared: false, earlyHazard: false, failTerminal: false, failCas: false, budget: true }
  let committed = structuredClone(initial)
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const provider = { storeId: randomUUID(), discard: vi.fn(), status: vi.fn() }
  const authorize = vi.fn(async () => true)
  const connect = vi.fn(async () => {
    let state = structuredClone(committed)
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      let rows: Row[] = []
      if (sql === 'SELECT pg_current_xact_id()::text AS xid') rows = [{ xid: '42' }]
      else if (sql.includes(' AS within_budget')) rows = [{ within_budget: state.budget }]
      else if (sql === 'SHOW statement_timeout') rows = [{ statement_timeout: '30s' }]
      else if (sql === 'COMMIT') committed = structuredClone(state)
      else if (sql.includes('SELECT k.key_id,k.state')) rows = [{ key_id: 'key', state: state.keyState }]
      else if (sql.startsWith('SELECT recovery_writer_state')) rows = [state.block]
      else if (sql.startsWith('SELECT generation_id::text,workspace_id')) rows = [state.generation]
      else if (sql.includes('FROM public.meta_recovery_archive_manual_requests WHERE generation_id')) rows = [state.request]
      else if (sql.includes('FROM public.meta_recovery_archive_manual_requests WHERE actor_id')) rows = [state.request]
      else if (sql.includes('FROM public.meta_recovery_archive_snapshot_reservations WHERE generation_id')) rows = state.reservations
      else if (sql.startsWith('SELECT 1 WHERE')) rows = (sql.includes("state='verified'") ? state.hazard : state.earlyHazard) ? [{ hazard: true }] : []
      else if (sql.startsWith('SELECT generation_id,octet_length')) rows = state.prepared ? [{ generation_id: generationId, bytes: 100 }] : []
      else if (sql.includes('FROM public.meta_recovery_archive_staging_objects WHERE generation_id')) rows = state.intents
      else if (sql.includes('FROM public.meta_recovery_archive_attachment_refs')) rows = state.pins
      else if (sql.startsWith('UPDATE public.meta_recovery_archives')) { state.generation.build_status = 'abandoned'; rows = [{ generation_id: generationId }] }
      else if (sql.startsWith('UPDATE public.meta_sheets')) {
        if (!state.failCas) { state.block = { state: null, kind: null, id: null, fence: '7', lease: null, updated: null }; rows = [{ id: identity.sheetId }] }
      } else if (sql.includes('meta_recovery_archive_claim_abandoned_cleanup')) {
        state.generation.owner_kind = 'archive_cleanup'; state.generation.owner_id = params[4]; state.generation.owner_fence = String(BigInt(String(params[3])) + 1n)
        state.generation.expired = false; state.generation.lease_expires_at = '2099-01-01 00:00:00+00'; rows = [{ fence: state.generation.owner_fence }]
      } else if (sql.startsWith('UPDATE public.meta_recovery_archive_staging_objects')) {
        if (state.failTerminal) throw new Error('private-db-value')
        const row = state.intents.find(item => item.staging_object_id === params[1])!
        row.object_state = 'absent'; row.terminal_receipt_sha256 = params[2]; rows = [{ staging_object_id: params[1] }]
      } else if (sql.includes('meta_recovery_archive_release_abandoned_source_pin')) {
        if (state.intents.some(row => row.object_state !== 'absent')) throw new Error('ALL_TERMINAL_REQUIRED')
        state.pins = state.pins.filter(row => row.attachment_id !== params[1])
      }
      return { rows, rowCount: rows.length }
    })
    return { query, release: vi.fn() } as unknown as PoolClient
  })
  const pool = { connect, options: { connectionTimeoutMillis: 10 } } as unknown as Pick<Pool, 'connect' | 'options'>
  const command = (captureLimits = limits) => bindRecoveryArchiveOwnedCleanup({ pool, limits: captureLimits, policy, provider, transactionDepth: { currentTransactionDepth: () => 0 } }, authorize)
  return { generationId, calls, provider, authorize, connect, command, pool, get: () => committed, edit: (work: (state: typeof initial) => void) => work(committed) }
}

describe('explicit scoped owned-builder cleanup', () => {
  it.each(['active', 'retiring'])('atomically clears raw expired own block, takes higher owner and releases all early pins with %s key', async keyState => {
    const f = fixture(); f.edit(state => { state.keyState = keyState })
    expect(await f.command()({ identity, generationId: f.generationId })).toEqual({ outcome: 'complete', confirmed: 2 })
    expect(f.get().generation).toMatchObject({ build_status: 'abandoned', owner_kind: 'archive_cleanup', owner_fence: '2' })
    expect(f.get().pins).toEqual([])
    expect(f.get().block).toEqual({ state: null, kind: null, id: null, fence: '7', lease: null, updated: null })
    expect(f.get().intents.every(row => row.object_state === 'absent' && /^[0-9a-f]{64}$/.test(String(row.terminal_receipt_sha256)))).toBe(true)
    const clear = f.calls.find(row => row.sql.startsWith('UPDATE public.meta_sheets'))!
    expect(clear.params.slice(4)).toEqual(['2026-10-07 01:02:03.123456+00', '2026-10-07 01:02:03.123456+00'])
    expect(f.calls.filter(row => row.sql === 'COMMIT')).toHaveLength(2)
    expect(f.provider.discard).not.toHaveBeenCalled(); expect(f.provider.status).not.toHaveBeenCalled()
    await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
  })

  it.each([
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.generation.expired = false },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.block.id = randomUUID() },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.block.lease = 'different' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.keyState = 'retired' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.hazard = true },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.earlyHazard = true },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.pins[0]!.source_owner_fence = '2' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.intents[0]!.attachment_id = 'substituted' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.intents[0]!.object_state = 'sealed' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.reservations.pop() },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.request.request_hash = 'wrong' },
    (s: ReturnType<ReturnType<typeof fixture>['get']>) => { s.budget = false },
  ])('refuses guard mutation %# with no committed changes or external IO', async mutate => {
    const f = fixture(); f.edit(mutate); const before = structuredClone(f.get())
    await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
    expect(f.get()).toEqual(before); expect(f.calls.some(row => row.sql === 'COMMIT')).toBe(false)
    expect(f.provider.discard).not.toHaveBeenCalled(); expect(f.provider.status).not.toHaveBeenCalled()
  })

  it('failed block CAS rolls back abandonment and never claims cleanup', async () => {
    const f = fixture(); f.edit(s => { s.failCas = true }); const before = structuredClone(f.get())
    await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
    expect(f.get()).toEqual(before)
    expect(f.calls.some(row => row.sql.includes('meta_recovery_archive_claim_abandoned_cleanup'))).toBe(false)
  })

  it('terminal-write failure retains ALL pins and intents after the separate higher claim', async () => {
    const f = fixture(); f.edit(s => { s.failTerminal = true })
    await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
    expect(f.get().pins).toHaveLength(2); expect(f.get().intents.every(row => row.object_state === 'pending')).toBe(true)
    expect(f.calls.filter(row => row.sql === 'COMMIT')).toHaveLength(1)
  })

  it('accepts exact available pins, preserves zero-pin no-provider boundary, and uses prepared official port separately', async () => {
    const available = fixture(); available.edit(s => { Object.assign(s.pins[0]!, { availability: 'available', immutable_version: 'sha256:immutable', content_sha256: 'a'.repeat(64), content_size_bytes: '10' }) })
    expect(await available.command()({ identity, generationId: available.generationId })).toEqual({ outcome: 'complete', confirmed: 2 })
    const zero = fixture(); zero.edit(s => { s.pins = []; s.intents = [] })
    expect(await zero.command()({ identity, generationId: zero.generationId })).toEqual({ outcome: 'complete', confirmed: 0 })
    expect(zero.provider.status).not.toHaveBeenCalled()
    const stored = fixture(); stored.edit(s => { s.prepared = true })
    expect(await stored.command()({ identity, generationId: stored.generationId })).toEqual({ outcome: 'retained', confirmed: 0 })
    expect(prepared.admit).toHaveBeenCalledWith(expect.any(Function), stored.authorize, expect.objectContaining({ identity }), true, stored.provider.storeId)
    expect(prepared.cleanup).toHaveBeenCalledWith(expect.any(Function), stored.authorize, expect.objectContaining({ provider: expect.objectContaining({ storeId: stored.provider.storeId }) }))
  })

  it('rejects caller owner aliases, current authority loss and missing namespace before external calls', async () => {
    const f = fixture()
    await expect(f.command()({ identity, generationId: f.generationId, owner: {} } as never)).rejects.toThrow(code)
    expect(f.connect).not.toHaveBeenCalled()
    f.authorize.mockResolvedValue(false)
    await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
    expect(f.get().generation.owner_kind).toBe('archive_builder')
    const getter = vi.fn(); Object.defineProperty(f.provider, 'storeId', { get: getter })
    expect(() => f.command()).toThrow(code); expect(getter).not.toHaveBeenCalled()
  })
})

it('absolute command deadline rejects a hung/late provider and permits no next IO or terminal transaction', async () => {
  const f = fixture(); f.edit(s => { s.prepared = true })
  let complete!: (value: { outcome: 'unknown' }) => void
  f.provider.status.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  prepared.cleanup.mockImplementation(async (_transaction, _authorize, input) => {
    await input.provider.status({})
    await input.provider.discard({})
    return { outcome: 'complete', confirmed: 1 }
  })
  const operation = f.command({ ...limits, timeoutMs: 40 })({ identity, generationId: f.generationId })
  await expect(operation).rejects.toThrow(code)
  expect(f.provider.status).toHaveBeenCalledOnce(); const statements = f.calls.length
  complete({ outcome: 'unknown' }); await new Promise<void>(resolve => setImmediate(resolve))
  expect(f.provider.discard).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(statements)
  expect(f.get().pins).toHaveLength(2)
})

it('expired cleanup-owner retry derives original source proof from immutable rows, without reviving builder lease', async () => {
  const f = fixture(); f.edit(s => { s.failTerminal = true })
  await expect(f.command()({ identity, generationId: f.generationId })).rejects.toThrow(code)
  f.edit(s => { s.failTerminal = false; s.generation.expired = true })
  expect(await f.command()({ identity, generationId: f.generationId })).toEqual({ outcome: 'complete', confirmed: 2 })
  expect(f.get().generation.owner_fence).toBe('3'); expect(f.get().pins).toEqual([])
  expect(f.calls.filter(row => row.sql.startsWith('UPDATE public.meta_sheets'))).toHaveLength(1)
})

it.each(['status', 'discard'] as const)('actual application drains the original deferred provider %s after caller deadline, before custody release', async verb => {
  const f = fixture(); f.edit(s => { s.prepared = true })
  let complete!: (value: { outcome: 'unknown' }) => void
  f.provider[verb].mockImplementation(() => new Promise(resolve => { complete = resolve }))
  prepared.cleanup.mockImplementation(async (_transaction, _authorize, input) => {
    await input.provider[verb]({}); await input.provider[verb === 'status' ? 'discard' : 'status']({}); return { outcome: 'complete', confirmed: 1 }
  })
  applicationFactory.create.mockImplementation(options => bindRecoveryArchiveOwnedCleanup(options, f.authorize))
  const composition = { objectStore: { ...f.provider, put: vi.fn(), get: vi.fn(), head: vi.fn(), pin: vi.fn(), deleteExpired: vi.fn() },
    keyCustody: { produceGenerationDek: vi.fn(), unwrapGenerationDek: vi.fn(), deriveDekFingerprint: vi.fn(), macManifestRoot: vi.fn(), verifyManifestRootMac: vi.fn() },
    manualCapture: policy, manualCaptureLimits: { ...limits, timeoutMs: 40 }, auditedReplayHorizonMs: 1000, asyncResumeHorizonMs: 1000, workerIntervalMs: 1000,
    worker: { recheckAuthority: vi.fn(), processDerivedWork: vi.fn(), leaseMs: 1000, replayHorizonMs: 1000,
      apply: { preliminaryFullRead: vi.fn(), finalLockedFullRead: vi.fn(), stabilizeAuthorization: vi.fn(), evaluatePlanAuthorization: vi.fn() } } } as RecoveryArchiveApplicationComposition
  const app = createRecoveryArchiveApplication(() => composition, () => ({ query: vi.fn(), transaction: vi.fn(),
    nativePool: f.pool, transactionDepthProbe: { currentTransactionDepth: () => 0 } }),
  { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' })
  await expect(app.cleanupExpiredBuilder(identity, f.generationId)).rejects.toThrow(code)
  const statements = f.calls.length
  let drained = false; const stop = app.stopWorker().then(() => { drained = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(drained).toBe(false)
    expect(() => app.releaseCustody()).toThrow('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED')
  } finally { complete({ outcome: 'unknown' }); await stop }
  expect(drained).toBe(true); expect(() => app.releaseCustody()).not.toThrow()
  expect(f.calls).toHaveLength(statements); expect(f.provider[verb === 'status' ? 'discard' : 'status']).not.toHaveBeenCalled(); expect(f.get().pins).toHaveLength(2)
})
