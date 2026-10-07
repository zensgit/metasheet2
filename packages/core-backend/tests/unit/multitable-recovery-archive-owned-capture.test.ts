import type { Pool, PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim,
  type RecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { bindRecoveryArchiveOwnedCapture, readRecoveryArchiveCapturedSource,
  type RecoveryArchiveCapturedSource } from '../../src/multitable/recovery-archive-owned-capture'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from '../../src/multitable/recovery-archive-seals'

const clock = vi.hoisted(() => ({ value: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.value } }))
// Phase 1 SQL semantics have their own native suite. Mint through its real private capability path;
// only its claim helpers are isolated here, never the phase 2 reader or authority query results.
vi.mock('../../src/multitable/recovery-archive-key-registry', () => ({ lockActiveRecoveryArchiveKeyForReference: vi.fn() }))
vi.mock('../../src/multitable/recovery-archive-source-pin', () => ({ claimRecoveryArchiveSourcePinIntent: vi.fn() }))
vi.mock('../../src/multitable/recovery-archive-writer-block', () => ({
  prepareArchiveWriterBlockTransaction: vi.fn(),
  claimArchiveWriterBlockPrepared: vi.fn(async (_prepared, input) => ({ state: 'archiving', ownerKind: input.ownerKind,
    ownerId: input.ownerId, fence: '7', leaseUntil: input.leaseUntil, updatedAt: '2026-10-07 00:00:00.123456+00' })),
  checkArchiveWriterBlockOwnerExact: vi.fn(),
}))
vi.mock('../../src/multitable/recovery-archive-section-bootstrap', async () => {
  const { SECTION_CAUSALITY_DATA_SECTION_KINDS: kinds } = await import('../../src/multitable/recovery-archive-seals')
  return {
    allocateRecoveryArchiveSnapshotIdentities: vi.fn(async () => ({ sections: kinds.map((sectionKind, index) => ({
      ordinal: index + 1, sectionKind, operationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      endpointSeq: String(index + 1),
    })), snapshotOperationId: '10000000-0000-4000-8000-000000000010', snapshotSeq: '10' })),
    persistRecoveryArchiveSnapshotReservations: vi.fn(async (_query, plan) => plan),
  }
})

const identity = { actorId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'synthetic_workspace', baseId: 'synthetic_base', sheetId: 'synthetic_sheet' }
const policy = { keyId: 'synthetic_key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }
const limits = { maxBytes: 4096, timeoutMs: 40 }
const timeCode = 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED'
const unavailableCode = 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE'
const usedCode = 'RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE'
const attachment = { attachmentId: 'synthetic_attachment', recordId: null, fieldId: null, storageFileId: 'synthetic_storage',
  storagePath: `11111111-1111-4111-8111-111111111111/sha256-${'a'.repeat(64)}`, storageProvider: 'local',
  sizeBytes: '12', mediaType: 'application/octet-stream', deleted: false, blobPurged: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function mint(attachmentIds: string[] = []) {
  let request: Record<string, unknown> | undefined
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql === 'SHOW statement_timeout') return { rows: [{ statement_timeout: '30s' }] }
    if (sql.startsWith('SELECT s.id')) return { rows: [{ id: identity.sheetId }] }
    if (sql.includes('FROM public.meta_recovery_archive_manual_requests')) return { rows: request ? [request] : [] }
    if (sql.startsWith('INSERT INTO public.meta_recovery_archive_manual_requests')) {
      request = { workspace_id: params[2], base_id: params[3], sheet_id: params[4], generation_id: params[5], request_hash: params[6] }
    }
    if (sql.startsWith('SELECT pg_current_xact_id')) return { rows: [{ xid: 'claim-xid' }] }
    if (sql.includes('FROM public.meta_history_trust_checkpoints')) return { rows: [{ id: 'synthetic_checkpoint' }] }
    if (sql.startsWith('WITH t AS')) return { rows: [{ claimed_at: '2026-10-07 00:00:00.123456+00',
      lease_until: '2026-10-07 00:01:00.123456+00', expires_at: '2026-10-07 01:00:00.123456+00' }] }
    if (sql.startsWith('INSERT INTO public.meta_recovery_archives')) return { rows: [{ created_at: '2026-10-07T00:00:00.123Z' }] }
    if (sql.startsWith('WITH candidate')) {
      const id = attachmentIds.find((value) => params[1] === null || value > String(params[1]))
      if (!id) return { rows: [] }
      const payload = JSON.stringify({ attachmentId: id, purged: false, purgeClaimed: false })
      return { rows: [{ payload_bytes: Buffer.byteLength(payload), entity_key: id, payload }] }
    }
    return { rows: [] }
  })
  const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() } as unknown as PoolClient)), options: { connectionTimeoutMillis: 10 } }
  const result = await bindRecoveryArchiveOwnedClaim(pool, async () => true, policy, { maxBytes: 4096, timeoutMs: 100 })(identity)
  return result.claim!
}

type FakeOptions = { stall?: string; failedAuthority?: string; candidates?: Array<typeof attachment>;
  transaction?: Record<string, unknown>; nativeError?: boolean; afterSourceFailure?: string; changedXid?: boolean }
function ownedPool(options: FakeOptions = {}) {
  const gate = deferred<{ rows: unknown[] }>()
  const pendingClient = deferred<PoolClient>()
  const release = vi.fn()
  let stalled = false
  let sourceRead = false
  let transactionReads = 0
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const authority = /owned-capture:(binding|heads|reservations|pins)/.exec(sql)?.[1]
    const stage = authority ?? (sql === 'SHOW statement_timeout' ? 'show' : sql.startsWith('BEGIN') ? 'begin'
      : sql === 'ROLLBACK' ? 'rollback' : sql === 'COMMIT' ? 'commit' : sql.includes("set_config('statement_timeout'") ? sql.includes('false')
        ? params[0] === '30s' ? 'session_restore' : 'session_install' : 'local_timeout'
        : sql.includes('owned-capture:transaction') ? 'transaction' : sql.startsWith('WITH scope') ? 'source'
          : sql.includes(' AS present') ? 'scope' : 'reader_transaction')
    if (options.nativeError) throw new Error('SENSITIVE_NATIVE_VALUE')
    if (stage === options.stall && !stalled) { stalled = true; return gate.promise }
    if (stage === 'show') return { rows: [{ statement_timeout: '30s' }] }
    if (authority) return { rows: [{ xid: 'capture-xid', matches: authority !== options.failedAuthority
      && !(sourceRead && authority === options.afterSourceFailure) }] }
    if (stage === 'transaction') transactionReads++
    if (stage === 'transaction' || stage === 'reader_transaction') return { rows: [{ xid: options.changedXid && transactionReads > 1 ? 'other-xid' : 'capture-xid',
      isolation: 'repeatable read', read_only: 'on', advisory_held: false, statement_timeout: '30s', ...options.transaction }] }
    if (stage === 'scope') return { rows: [{ xid: 'capture-xid', present: true }] }
    if (stage === 'source') {
      sourceRead = true
      const row = sql.includes('public.multitable_attachments')
        ? options.candidates?.find((candidate) => params[3] === null || candidate.attachmentId > String(params[3])) : undefined
      if (!row) return { rows: [{ xid: 'capture-xid', entity_key: null, payload_bytes: null, payload: null }] }
      const payload = JSON.stringify(row)
      const payloadBytes = Buffer.byteLength(payload)
      return { rows: [{ xid: 'capture-xid', payload_bytes: payloadBytes,
        entity_key: payloadBytes <= Number(params[4]) ? row.attachmentId : null,
        payload: payloadBytes <= Number(params[4]) ? payload : null }] }
    }
    return { rows: [] }
  })
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(() => options.stall === 'connect' ? pendingClient.promise : Promise.resolve(client))
  const pool = { connect, options: { connectionTimeoutMillis: 10 } } as unknown as Pick<Pool, 'connect' | 'options'>
  return { pool, query, release, gate, pendingClient, client }
}

beforeEach(() => { clock.value = 0 })

describe('single-use owned fresh RR capture', () => {
  it('mints detached frozen metadata after COMMIT, restoration and healthy release only', async () => {
    const claim = await mint([attachment.attachmentId])
    const binding = readRecoveryArchiveCommittedClaim(claim)
    const owned = ownedPool({ candidates: [attachment] })
    const captured = await bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)
    const snapshot = readRecoveryArchiveCapturedSource(captured)
    expect(snapshot).toEqual({ claim: binding, snapshotXid: 'capture-xid',
      source: { sections: { schema: [], records: [], links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [], views_config: [] }, attachmentCandidates: [attachment] },
      attachmentDescriptors: [{ attachmentId: attachment.attachmentId, storageKey: attachment.storagePath,
        immutableVersion: `sha256:${'a'.repeat(64)}`, contentSha256: 'a'.repeat(64), contentSizeBytes: '12' }] })
    expect(Object.isFrozen(snapshot.source.attachmentCandidates[0])).toBe(true)
    expect(Object.isFrozen(snapshot.claim.reservationPlan.sections)).toBe(true)
    expect(readRecoveryArchiveCapturedSource(captured)).not.toBe(snapshot)
    expect(owned.query.mock.calls.slice(-2)).toEqual([['COMMIT', undefined], ["SELECT set_config('statement_timeout',$1,false)", ['30s']]])
    expect(owned.release.mock.calls).toEqual([[]])
    expect(owned.query.mock.calls.slice(0, 4)).toEqual([['ROLLBACK', undefined], ['SHOW statement_timeout', undefined],
      ["SELECT set_config('statement_timeout',$1,false)", ['40ms']], ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', undefined]])
    expect(owned.query.mock.calls.filter(([sql]) => sql.startsWith('WITH scope'))).toHaveLength(9)
    expect(owned.query.mock.calls.findIndex(([sql]) => sql.includes('owned-capture:pins')))
      .toBeLessThan(owned.query.mock.calls.findIndex(([sql]) => sql.startsWith('WITH scope')))
    expect(owned.query.mock.calls.some(([sql]) => /FOR UPDATE|FOR SHARE|pg_advisory|\bINSERT\b|\bDELETE\b/.test(sql))).toBe(false)
    const authorityBinding = JSON.parse(owned.query.mock.calls.find(([sql]) => sql.includes('owned-capture:binding'))![1]![0] as string)
    expect(authorityBinding.writerBlock.fence).toBe('7')
    expect(authorityBinding.generationOwner.ownerFence).toBe('1')
    expect(SECTION_CAUSALITY_DATA_SECTION_KINDS).toHaveLength(9)
  })

  it.each([{}, { claim: true }, null])('rejects forged claim before any acquisition (%#)', async (fake) => {
    const owned = ownedPool()
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(fake as RecoveryArchiveCommittedClaim))
      .rejects.toMatchObject({ code: usedCode })
    expect(owned.pool.connect).not.toHaveBeenCalled()
  })

  it('burns globally before first await, rejecting concurrent binders and DTO readback', async () => {
    const claim = await mint()
    const owned = ownedPool()
    const gate = deferred<boolean>()
    const first = bindRecoveryArchiveOwnedCapture(owned.pool, () => gate.promise, limits)(claim)
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: usedCode })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(readRecoveryArchiveCommittedClaim(claim) as unknown as RecoveryArchiveCommittedClaim))
      .rejects.toMatchObject({ code: usedCode })
    gate.resolve(true)
    await first
    expect(owned.pool.connect).toHaveBeenCalledTimes(1)
  })

  it.each(['binding', 'heads', 'reservations', 'pins'])('refuses %s mismatch before source reads and never revives claim', async (failedAuthority) => {
    const claim = await mint()
    const owned = ownedPool({ failedAuthority })
    const capture = bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)
    await expect(capture(claim)).rejects.toMatchObject({ code: unavailableCode })
    await expect(capture(claim)).rejects.toMatchObject({ code: usedCode })
    expect(owned.query.mock.calls.some(([sql]) => sql.startsWith('WITH scope') || sql === 'COMMIT')).toBe(false)
    expect(owned.release.mock.calls).toEqual([[true]])
  })

  it.each([{ isolation: 'read committed' }, { read_only: 'off' }, { xid: '' }, { advisory_held: true }])
    ('rejects invalid RR transaction before authorization (%#)', async (transaction) => {
      const claim = await mint()
      const owned = ownedPool({ transaction })
      const authorize = vi.fn(async () => true)
      await expect(bindRecoveryArchiveOwnedCapture(owned.pool, authorize, limits)(claim)).rejects.toMatchObject({
        code: transaction.advisory_held ? 'RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD' : 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED',
      })
      expect(authorize).not.toHaveBeenCalled()
      expect(owned.release.mock.calls).toEqual([[true]])
    })

  it('authorization cannot replace the original owned RR transaction', async () => {
    const claim = await mint()
    const owned = ownedPool({ changedXid: true })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED' })
    expect(owned.query.mock.calls.some(([sql]) => sql.includes('owned-capture:binding'))).toBe(false)
  })

  it.each(['binding', 'pins'])('expired final %s refuses after metadata enumeration but before COMMIT', async (afterSourceFailure) => {
    const claim = await mint()
    const owned = ownedPool({ afterSourceFailure })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim))
      .rejects.toMatchObject({ code: unavailableCode })
    expect(owned.query.mock.calls.filter(([sql]) => sql.startsWith('WITH scope'))).toHaveLength(8)
    expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  })

  it.each([false, new Error('SENSITIVE_AUTHORIZATION_VALUE')])('refuses denied or failed SQL authority (%#)', async (value) => {
    const claim = await mint()
    const owned = ownedPool()
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => { if (value instanceof Error) throw value; return value }, limits)(claim))
      .rejects.toMatchObject({ code: unavailableCode, message: unavailableCode })
    expect(owned.query.mock.calls.some(([sql]) => sql.includes('owned-capture:binding'))).toBe(false)
  })

  it('retained authorizer query cannot send native SQL after release', async () => {
    const claim = await mint()
    const owned = ownedPool()
    let retained!: SealQuery
    await bindRecoveryArchiveOwnedCapture(owned.pool, async (query) => { retained = query; return true }, limits)(claim)
    const count = owned.query.mock.calls.length
    await expect(retained('SELECT SENSITIVE_LATE_VALUE')).rejects.toMatchObject({ code: unavailableCode })
    expect(owned.query).toHaveBeenCalledTimes(count)
  })

  it.each([undefined, 0, -1, 1.5, Infinity, 41])('explicit acquisition policy failure consumes once before connect (%#)', async (value) => {
    const claim = await mint()
    const owned = ownedPool()
    owned.pool.options.connectionTimeoutMillis = value
    const capture = bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)
    await expect(capture(claim)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID' })
    await expect(capture(claim)).rejects.toMatchObject({ code: usedCode })
    expect(owned.pool.connect).not.toHaveBeenCalled()
  })

  it.each(['rollback', 'show', 'session_install', 'begin', 'transaction', 'binding', 'heads', 'reservations', 'pins', 'source', 'commit', 'session_restore'])
    ('stalled %s discards once and late continuation sends no SQL', async (stall) => {
      const claim = await mint()
      const owned = ownedPool({ stall })
      await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: timeCode })
      expect(owned.release.mock.calls).toEqual([[true]])
      const count = owned.query.mock.calls.length
      owned.gate.resolve({ rows: [] })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(owned.query).toHaveBeenCalledTimes(count)
      expect(owned.release.mock.calls).toEqual([[true]])
    })

  it('late acquisition never begins SQL', async () => {
    const claim = await mint()
    const owned = ownedPool({ stall: 'connect' })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: timeCode })
    owned.pendingClient.resolve(owned.client)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(owned.query).not.toHaveBeenCalled()
    expect(owned.release.mock.calls).toEqual([[true]])
  })

  it('healthy release crossing deadline still issues no capture authority', async () => {
    const claim = await mint()
    const owned = ownedPool()
    owned.release.mockImplementation(() => { clock.value = 41 })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: timeCode })
    expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
    expect(owned.release.mock.calls).toEqual([[]])
  })

  it('final candidate freeze crossing deadline cannot mint after successful COMMIT', async () => {
    const claim = await mint()
    const owned = ownedPool()
    const original = Object.freeze
    const spy = vi.spyOn(Object, 'freeze').mockImplementation((value) => {
      if (value && typeof value === 'object' && 'snapshotXid' in value) clock.value = 41
      return original(value)
    })
    try {
      await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: timeCode })
      expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
      expect(owned.release.mock.calls).toEqual([[]])
    } finally { spy.mockRestore() }
  })

  it.each([{ ...attachment, storageProvider: 's3' }, { ...attachment, storagePath: 'mutable-path' }, { ...attachment, blobPurged: true }])
    ('refuses an unavailable immutable descriptor without COMMIT (%#)', async (candidate) => {
      const claim = await mint([attachment.attachmentId])
      const owned = ownedPool({ candidates: [candidate] })
      await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)).rejects.toMatchObject({ code: unavailableCode })
      expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
    })

  it('real low reader rejects SQL-withheld over-budget attachment payload', async () => {
    const claim = await mint([attachment.attachmentId])
    const owned = ownedPool({ candidates: [attachment] })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, { ...limits, maxBytes: 1 })(claim))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
    expect(owned.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  })

  it('one cumulative reader budget is reduced between transferred attachment rows', async () => {
    const second = { ...attachment, attachmentId: 'synthetic_attachment_z' }
    const claim = await mint([attachment.attachmentId, second.attachmentId])
    const owned = ownedPool({ candidates: [attachment, second] })
    const firstBytes = Buffer.byteLength(JSON.stringify(attachment))
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, { ...limits, maxBytes: firstBytes + 1 })(claim))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_CAPTURE_BYTES_EXCEEDED' })
    const reads = owned.query.mock.calls.filter(([sql]) => sql.startsWith('WITH scope') && sql.includes('public.multitable_attachments'))
    expect(reads.map(([, params]) => params?.slice(3))).toEqual([[null, firstBytes + 1], [attachment.attachmentId, 1]])
    expect(owned.release.mock.calls).toEqual([[true]])
  })

  it('native errors stay values-free; captured clones and forgeries carry no read authority', async () => {
    const claim = await mint()
    const owned = ownedPool({ nativeError: true })
    await expect(bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim))
      .rejects.toMatchObject({ code: unavailableCode, message: unavailableCode })
    const good = await bindRecoveryArchiveOwnedCapture(ownedPool().pool, async () => true, limits)(await mint())
    for (const fake of [{}, { ...good }, structuredClone(good), readRecoveryArchiveCapturedSource(good), null]) {
      expect(() => readRecoveryArchiveCapturedSource(fake as RecoveryArchiveCapturedSource)).toThrow(unavailableCode)
    }
  })
})
