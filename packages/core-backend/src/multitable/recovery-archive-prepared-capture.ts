/** Internal immutable byte store. No authorization, encryption, upload or publication is performed here. */
import { createHash } from 'node:crypto'
import type { SealQuery } from './recovery-archive-seals'

export interface RecoveryArchivePreparedCaptureOwner {
  generationId: string
  ownerKind: string
  ownerId: string
  ownerFence: string
  sourceVectorHash: string
}

async function lockOwner(query: SealQuery, owner: RecoveryArchivePreparedCaptureOwner): Promise<void> {
  const values = parameters(owner)
  const first = await query('SELECT pg_current_xact_id()::text AS xid')
  const second = await query('SELECT pg_current_xact_id()::text AS xid')
  const xid = (first.rows[0] as { xid?: unknown } | undefined)?.xid
  if (typeof xid !== 'string' || !xid || xid !== (second.rows[0] as { xid?: unknown } | undefined)?.xid) {
    throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_TRANSACTION_REQUIRED')
  }
  const result = await query(`SELECT generation_id FROM public.meta_recovery_archives
    WHERE generation_id=$1::uuid AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint
      AND source_vector_hash=$5 AND state='building' AND build_status='active'
      AND coverage_status='incomplete' AND lease_expires_at>clock_timestamp()
      AND expires_at>clock_timestamp() FOR UPDATE`, values)
  if (result.rows.length !== 1) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE')
}

function parameters(owner: RecoveryArchivePreparedCaptureOwner): string[] {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(owner.generationId)
    || !owner.ownerKind || !owner.ownerId || !/^[1-9][0-9]*$/.test(owner.ownerFence)
    || !/^[0-9a-f]{64}$/.test(owner.sourceVectorHash)) {
    throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_INVALID_INPUT')
  }
  return [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash]
}

function decode(row: unknown): Buffer {
  const value = row as { payload?: unknown; payload_sha256?: unknown }
  if (!Buffer.isBuffer(value.payload) || value.payload.length === 0
    || createHash('sha256').update(value.payload).digest('hex') !== value.payload_sha256) {
    throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CORRUPT')
  }
  return Buffer.from(value.payload)
}

async function read(query: SealQuery, owner: RecoveryArchivePreparedCaptureOwner): Promise<Buffer | null> {
  const result = await query(`SELECT payload,payload_sha256 FROM public.meta_recovery_archive_prepared_captures
    WHERE generation_id=$1::uuid AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint
      AND source_vector_hash=$5`, parameters(owner))
  return result.rows.length === 0 ? null : decode(result.rows[0])
}

/** Caller supplies an already sealed envelope and an open transaction on one connection. */
export async function persistRecoveryArchivePreparedCapture(
  query: SealQuery, owner: RecoveryArchivePreparedCaptureOwner, payload: Buffer,
): Promise<Buffer> {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_INVALID_INPUT')
  }
  const bytes = Buffer.from(payload)
  await lockOwner(query, owner)
  await query(`INSERT INTO public.meta_recovery_archive_prepared_captures
    (generation_id,owner_kind,owner_id,owner_fence,source_vector_hash,payload)
    VALUES ($1::uuid,$2,$3,$4::bigint,$5,$6) ON CONFLICT (generation_id) DO NOTHING`,
  [...parameters(owner), bytes])
  const stored = await read(query, owner)
  if (!stored || !stored.equals(bytes)) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT')
  return stored
}

/** Expired/changed owners cannot resume, even when the bytes still exist. */
export async function readRecoveryArchivePreparedCapture(
  query: SealQuery, owner: RecoveryArchivePreparedCaptureOwner,
): Promise<Buffer | null> {
  await lockOwner(query, owner)
  return read(query, owner)
}
