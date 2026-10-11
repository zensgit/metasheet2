import { admitRecoveryArchiveOwnedAttempt, type RecoveryArchiveOwnedAttempt } from '../../src/multitable/recovery-archive-owned-authority'
import { planRecoveryArchiveOwnedHistory, consumeRecoveryArchiveOwnedHistory } from '../../src/multitable/recovery-archive-owned-history'
import { computeRecoveryArchiveSourceHash } from '../../src/multitable/recovery-archive-source-hash'
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

describe('owned future history without premature persistence', () => {
  async function prepared() {
    const claim = await mint()
    const owned = ownedPool()
    const captured = await bindRecoveryArchiveOwnedCapture(owned.pool, async () => true, limits)(claim)
    return { owned, captured, detached: readRecoveryArchiveCapturedSource(captured) }
  }
  const nonces = Object.fromEntries([...SECTION_CAUSALITY_DATA_SECTION_KINDS, 'coverage_index']
    .map((name, index) => [name, Buffer.alloc(12, index + 1)]))

  it('precomputes exact 28 coverage candidates without another SQL call or history write', async () => {
    const f = await prepared()
    const attempt = admitRecoveryArchiveOwnedAttempt(f.captured)
    const calls = f.owned.query.mock.calls.length
    const plan = planRecoveryArchiveOwnedHistory(attempt, [], nonces)
    expect(f.owned.query.mock.calls.length).toBe(calls)
    expect(plan.contents.map((item) => item.rowCount)).toEqual(Array(9).fill('0'))
    const section = plan.sections.find((item) => item.sectionName === 'coverage_index')!
    const rows = JSON.parse(Buffer.from(section.plaintext).toString('utf8')) as { payload: { source_kind: string; source_sha256: string; source_id: string } }[]
    expect(section.rowCount).toBe('28')
    expect(rows.filter((row) => row.payload.source_kind === 'section_revision')).toHaveLength(9)
    expect(rows.filter((row) => row.payload.source_kind === 'sealed_operation_endpoint')).toHaveLength(10)
    expect(rows.filter((row) => row.payload.source_kind === 'snapshot_membership')).toHaveLength(9)
    const reservation = f.detached.claim.reservationPlan.sections[0]!
    const expected = computeRecoveryArchiveSourceHash('section_revision', {
      id: reservation.operationId, sheet_id: identity.sheetId, section_kind: 'schema', entity_key: 'section/schema',
      action: 'bootstrap_snapshot', payload: { row_count: '0', source_hash: plan.contents[0]!.sourceHash },
      tombstone: null, seq: reservation.endpointSeq, operation_id: reservation.operationId,
      created_at: '2026-10-07T00:00:00.123Z',
    }, reservation.endpointSeq)
    expect(rows.find((row) => row.payload.source_kind === 'section_revision' && row.payload.source_id === expected.sourceId)?.payload.source_sha256).toBe(expected.hash)
    expect(f.detached.claim.generationClaimedAt).toBe('2026-10-07 00:00:00.123456+00')
  })

  it('consumes genuine captured authority once and refuses detached or cloned phase authority', async () => {
    const f = await prepared()
    expect(() => admitRecoveryArchiveOwnedAttempt(f.detached as unknown as RecoveryArchiveCapturedSource)).toThrow('RECOVERY_ARCHIVE_CAPTURE_CAPABILITY_UNAVAILABLE')
    const token = admitRecoveryArchiveOwnedAttempt(f.captured)
    expect(() => admitRecoveryArchiveOwnedAttempt(f.captured)).toThrow('RECOVERY_ARCHIVE_CAPTURE_CAPABILITY_UNAVAILABLE')
    expect(() => planRecoveryArchiveOwnedHistory({ ...token } as RecoveryArchiveOwnedAttempt, [], nonces)).toThrow('RECOVERY_ARCHIVE_CAPTURE_CAPABILITY_UNAVAILABLE')
    expect(() => planRecoveryArchiveOwnedHistory(token, [], nonces)).not.toThrow()
  })

  it('refuses a missing revision insert before any child endpoint can be sealed', async () => {
    const f = await prepared()
    const token = admitRecoveryArchiveOwnedAttempt(f.captured)
    const plan = planRecoveryArchiveOwnedHistory(token, [], nonces)
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [{ count: 0 }] }
      : { rows: [], rowCount: sql.includes('section_bootstrap_markers') ? 1 : 0 })
    await expect(consumeRecoveryArchiveOwnedHistory(query, token, plan.contents)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_AUTHORITY_UNAVAILABLE')
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO public.meta_record_history_operations'))).toBe(false)
  })
})
