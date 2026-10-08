import { createHash, randomUUID } from 'node:crypto'
import { acquireCanonicalSheetFence, assertNoActiveWriterBlock } from './canonical-sheet-fence'
import type { SealQuery } from './recovery-archive-seals'
import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import type { RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import { decodeRecoveryArchivePreparedEnvelope, type RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import { createGuardedRecoveryArchiveAbandonedObjectStore, refuseRecoveryArchiveDiscard, type RecoveryArchiveAbandonedObjectStore,
  type RecoveryArchiveDiscardRequest } from './recovery-archive-abandoned-object-store'
import { snapshotRecoveryArchiveObjectStoreId, validateRecoveryArchiveObjectExpectedBinding, type RecoveryArchiveObjectExpectedBinding } from './recovery-archive-object-store'

type Transaction = RecoveryArchivePreparedUploadInput['transaction']
type Authorize = (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>
type Owner = RecoveryArchivePreparedCaptureOwner

/** D-L prefix: canonical sheet, key, writer block; generation lock belongs to the caller next. */
export async function lockRecoveryArchiveObjectScope(
  query: SealQuery, identity: RecoveryArchiveScopeIdentity, generationId: string, building: boolean,
): Promise<string> {
  await acquireCanonicalSheetFence(query, identity.sheetId)
  const result = await query(`SELECT k.key_id,k.state,pg_current_xact_id()::text AS xid FROM public.meta_recovery_archive_keys k
    JOIN public.meta_recovery_archives a ON a.key_id=k.key_id
    WHERE a.generation_id=$1::uuid AND a.workspace_id=$2 AND a.base_id=$3 AND a.sheet_id=$4
    FOR UPDATE OF k`, [generationId, identity.workspaceId, identity.baseId, identity.sheetId])
  const key = result.rows[0] as { key_id?: string; state?: string; xid?: string } | undefined
  if (result.rows.length !== 1 || !key?.key_id || (building ? key.state !== 'active' : !['active', 'retiring'].includes(key.state ?? ''))) refuseRecoveryArchiveDiscard()
  const current = (await query('SELECT pg_current_xact_id()::text AS xid')).rows[0] as { xid?: string } | undefined
  if (!key.xid || current?.xid !== key.xid) refuseRecoveryArchiveDiscard()
  await assertNoActiveWriterBlock(query, identity.sheetId)
  return key.key_id
}

export interface RecoveryArchiveStagingRegistration {
  binding: RecoveryArchiveObjectExpectedBinding
  objectClass: 'section' | 'attachment' | 'manifest'
  attachmentId: string | null
  keyId: string
}

/** Complete immutable prepared plan, including objects whose PUT has never started. */
export function recoveryArchivePreparedStagingPlan(payload: Buffer, expiresAt: string): RecoveryArchiveStagingRegistration[] {
  const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
  const objects: { objectClass: RecoveryArchiveStagingRegistration['objectClass']; attachmentId: string | null; bytes: Buffer }[] = [
    ...envelope.sections.map((section) => ({ objectClass: 'section' as const, attachmentId: null,
      bytes: Buffer.concat([section.ciphertext, section.authTag]) })),
    ...(envelope.attachments ?? []).map((attachment) => ({ objectClass: 'attachment' as const, attachmentId: attachment.attachmentId,
      bytes: Buffer.concat([attachment.nonce, attachment.ciphertext, attachment.authTag]) })),
    ...(envelope.manifestEnvelope ? [{ objectClass: 'manifest' as const, attachmentId: null, bytes: envelope.manifestEnvelope }] : []),
  ]
  const plan = objects.map((object) => {
    const sha256 = createHash('sha256').update(object.bytes).digest('hex')
    return { objectClass: object.objectClass, attachmentId: object.attachmentId, keyId: envelope.binding.keyId,
      binding: { generationId: envelope.binding.generationId, objectId: sha256, expectedVersion: sha256,
        expectedSha256: sha256, expectedSize: String(object.bytes.length), expectedExpiresAt: expiresAt } }
  })
  if (!plan.length || new Set(plan.map((item) => item.binding.objectId)).size !== plan.length) refuseRecoveryArchiveDiscard()
  return plan
}

/** Caller already holds the exact live builder lock and has compared durable prepared bytes. */
export async function registerRecoveryArchiveStagingObject(
  query: SealQuery, owner: Owner, registration: RecoveryArchiveStagingRegistration, storeId: string,
): Promise<void> {
  try {
    if (!storeId || snapshotRecoveryArchiveObjectStoreId({ storeId }) !== storeId) refuseRecoveryArchiveDiscard()
    const expected = validateRecoveryArchiveObjectExpectedBinding(registration.binding)
    if (expected.generationId !== owner.generationId) refuseRecoveryArchiveDiscard()
    const prior = await query(`SELECT b.store_id,b.provider_version,b.ciphertext_sha256,b.size_bytes::text,b.expires_at,
        b.owner_kind,b.owner_id,b.owner_fence::text,s.object_class,s.attachment_id,s.key_id,s.object_state
      FROM public.meta_recovery_archive_abandoned_bindings b
      JOIN public.meta_recovery_archive_staging_objects s USING(generation_id,staging_object_id)
      WHERE b.generation_id=$1::uuid AND b.object_id=$2`, [owner.generationId, expected.objectId])
    if (prior.rows.length) {
      const row = prior.rows[0] as Record<string, unknown>
      if (row.store_id !== storeId || row.provider_version !== expected.expectedVersion || row.ciphertext_sha256 !== expected.expectedSha256
        || row.size_bytes !== expected.expectedSize || !(row.expires_at instanceof Date) || row.expires_at.toISOString() !== expected.expectedExpiresAt
        || row.owner_kind !== owner.ownerKind || row.owner_id !== owner.ownerId || row.owner_fence !== owner.ownerFence
        || row.object_class !== registration.objectClass || row.attachment_id !== registration.attachmentId
        || row.key_id !== registration.keyId || row.object_state !== 'sealed') refuseRecoveryArchiveDiscard()
      return
    }
    const intents = registration.objectClass === 'attachment' ? await query(`SELECT s.staging_object_id,s.key_id,s.object_state,
        s.terminal_receipt_sha256,s.cleanup_owner_kind,s.cleanup_owner_id,s.cleanup_owner_fence
      FROM public.meta_recovery_archive_staging_objects s
      LEFT JOIN public.meta_recovery_archive_abandoned_bindings b USING(generation_id,staging_object_id)
      WHERE s.generation_id=$1::uuid AND s.object_class='attachment' AND s.attachment_id=$2
        AND b.staging_object_id IS NULL FOR UPDATE OF s`, [owner.generationId, registration.attachmentId]) : { rows: [] }
    const intent = intents.rows[0] as Record<string, unknown> | undefined
    if (intents.rows.length > 1 || (intent && (intent.key_id !== registration.keyId || intent.object_state !== 'pending'
      || intent.terminal_receipt_sha256 !== null || intent.cleanup_owner_kind !== null || intent.cleanup_owner_id !== null
      || intent.cleanup_owner_fence !== null || typeof intent.staging_object_id !== 'string'))) refuseRecoveryArchiveDiscard()
    const stagingId = intent ? String(intent.staging_object_id) : randomUUID()
    if (!intent) await query(`INSERT INTO public.meta_recovery_archive_staging_objects
      (generation_id,staging_object_id,object_class,attachment_id,key_id)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5)`,
    [owner.generationId, stagingId, registration.objectClass, registration.attachmentId, registration.keyId])
    await query(`INSERT INTO public.meta_recovery_archive_abandoned_bindings
      (generation_id,staging_object_id,object_id,provider_version,ciphertext_sha256,size_bytes,expires_at,
        operation_id,owner_kind,owner_id,owner_fence,store_id)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7::timestamptz,$8::uuid,$9,$10,$11::bigint,$12::uuid)`,
    [owner.generationId, stagingId, expected.objectId, expected.expectedVersion, expected.expectedSha256,
      expected.expectedSize, expected.expectedExpiresAt, randomUUID(), owner.ownerKind, owner.ownerId, owner.ownerFence, storeId])
    // The bytes have already been durably sealed; this commits before the first provider PUT.
    await query(`UPDATE public.meta_recovery_archive_staging_objects SET object_state='sealed'
      WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid AND object_state='pending'`, [owner.generationId, stagingId])
  } catch { return refuseRecoveryArchiveDiscard() }
}

interface CleanupInput {
  identity: RecoveryArchiveScopeIdentity
  owner: Owner
}

async function admit(query: SealQuery, authorize: Authorize, input: CleanupInput, expired: boolean, storeId?: string): Promise<void> {
  await lockRecoveryArchiveObjectScope(query, input.identity, input.owner.generationId, false)
  if (!(await authorize(query, input.identity))) refuseRecoveryArchiveDiscard()
  const owner = input.owner
  const generation = await query(`SELECT generation_id,expires_at,key_id FROM public.meta_recovery_archives
    WHERE generation_id=$1::uuid AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint
      AND source_vector_hash=$5 AND state='building' AND build_status='abandoned' AND coverage_status='incomplete'
      AND ${expired ? 'lease_expires_at<=clock_timestamp()' : "lease_expires_at>clock_timestamp() AND owner_kind='archive_cleanup'"}
    FOR UPDATE`, [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash])
  if (generation.rows.length !== 1) refuseRecoveryArchiveDiscard()
  const unsafe = await query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM public.meta_recovery_archive_objects WHERE generation_id=$1::uuid AND state='verified')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_attachment_refs WHERE generation_id=$1::uuid AND reference_class='archive_object')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_legal_holds WHERE generation_id=$1::uuid AND state='active')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_staging_objects s
      LEFT JOIN public.meta_recovery_archive_abandoned_bindings b USING(generation_id,staging_object_id)
      WHERE s.generation_id=$1::uuid AND b.staging_object_id IS NULL)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_objects o
      LEFT JOIN public.meta_recovery_archive_abandoned_bindings b USING(generation_id,object_id)
      WHERE o.generation_id=$1::uuid AND b.object_id IS NULL)`, [owner.generationId])
  if (unsafe.rows.length) refuseRecoveryArchiveDiscard()
  const capture = (await query(`SELECT payload,payload_sha256,source_vector_hash FROM public.meta_recovery_archive_prepared_captures
    WHERE generation_id=$1::uuid`, [owner.generationId])).rows[0] as Record<string, unknown> | undefined
  const archive = generation.rows[0] as Record<string, unknown>
  if (!Buffer.isBuffer(capture?.payload) || createHash('sha256').update(capture.payload).digest('hex') !== capture.payload_sha256
    || !(archive.expires_at instanceof Date)) refuseRecoveryArchiveDiscard()
  const envelope = decodeRecoveryArchivePreparedEnvelope(capture.payload)
  if (envelope.binding.generationId !== owner.generationId || envelope.binding.keyId !== archive.key_id
    || envelope.binding.workspaceId !== input.identity.workspaceId || envelope.binding.baseId !== input.identity.baseId
    || envelope.binding.sheetId !== input.identity.sheetId || capture.source_vector_hash !== owner.sourceVectorHash) refuseRecoveryArchiveDiscard()
  const plan = recoveryArchivePreparedStagingPlan(capture.payload, archive.expires_at.toISOString())
  const mappings = (await query(`SELECT b.store_id,b.object_id,b.provider_version,b.ciphertext_sha256,b.size_bytes::text,b.expires_at,
      s.object_class,s.attachment_id,s.key_id FROM public.meta_recovery_archive_abandoned_bindings b
      JOIN public.meta_recovery_archive_staging_objects s USING(generation_id,staging_object_id)
      WHERE b.generation_id=$1::uuid`, [owner.generationId])).rows as Record<string, unknown>[]
  if (mappings.length !== plan.length) refuseRecoveryArchiveDiscard()
  for (const entry of plan) {
    const row = mappings.find((candidate) => candidate.object_id === entry.binding.objectId)
    if (!row || (storeId !== undefined && row.store_id !== storeId) || row.provider_version !== entry.binding.expectedVersion || row.ciphertext_sha256 !== entry.binding.expectedSha256
      || row.size_bytes !== entry.binding.expectedSize || !(row.expires_at instanceof Date)
      || row.expires_at.toISOString() !== entry.binding.expectedExpiresAt || row.object_class !== entry.objectClass
      || row.attachment_id !== entry.attachmentId || row.key_id !== entry.keyId) refuseRecoveryArchiveDiscard()
  }
}

/** Explicit owner-bound claim only; no scheduler, abandonment policy or automatic lease extension. */
export async function claimRecoveryArchiveAbandonedObjectCleanup(
  transaction: Transaction, authorize: Authorize,
  input: CleanupInput & { cleanupOwnerId: string; leaseExpiresAt: string },
): Promise<Owner> {
  const frozen = { identity: { ...input.identity }, owner: { ...input.owner }, cleanupOwnerId: input.cleanupOwnerId, leaseExpiresAt: input.leaseExpiresAt }
  try {
    return await transaction(async (query) => {
      await admit(query, authorize, frozen, true)
      const owner = frozen.owner
      const result = await query(`SELECT public.meta_recovery_archive_claim_abandoned_cleanup(
        $1::uuid,$2,$3,$4::bigint,'archive_cleanup',$5,$6::timestamptz)::text AS fence`,
      [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, frozen.cleanupOwnerId, frozen.leaseExpiresAt])
      const fence = (result.rows[0] as { fence?: string } | undefined)?.fence
      if (!fence || !/^[1-9][0-9]*$/.test(fence)) refuseRecoveryArchiveDiscard()
      return { ...owner, ownerKind: 'archive_cleanup', ownerId: frozen.cleanupOwnerId, ownerFence: fence }
    })
  } catch { return refuseRecoveryArchiveDiscard() }
}

/** Restart with the same persisted operation UUIDs; ambiguous provider results never release pins. */
export async function cleanupRecoveryArchiveAbandonedObjects(
  transaction: Transaction, authorize: Authorize,
  input: CleanupInput & { provider: RecoveryArchiveAbandonedObjectStore; transactionDepth: RecoveryArchiveTransactionDepthProbe },
): Promise<{ outcome: 'complete' | 'retained'; confirmed: number }> {
  const frozen = { identity: { ...input.identity }, owner: { ...input.owner } }
  const store = createGuardedRecoveryArchiveAbandonedObjectStore(input.provider, input.transactionDepth)
  const storeId = snapshotRecoveryArchiveObjectStoreId(store)
  try {
    if (!storeId) refuseRecoveryArchiveDiscard()
    const rows = await transaction(async (query) => {
      await admit(query, authorize, frozen, false, storeId)
      return (await query(`SELECT b.store_id,b.staging_object_id,b.operation_id,b.object_id,b.provider_version,b.ciphertext_sha256,
        b.size_bytes::text,b.expires_at,s.object_state FROM public.meta_recovery_archive_abandoned_bindings b
        JOIN public.meta_recovery_archive_staging_objects s USING(generation_id,staging_object_id)
        WHERE b.generation_id=$1::uuid ORDER BY b.staging_object_id`, [frozen.owner.generationId])).rows as Record<string, unknown>[]
    })
    let confirmed = 0
    for (const row of rows) {
      if (!(row.expires_at instanceof Date)) refuseRecoveryArchiveDiscard()
      const request: RecoveryArchiveDiscardRequest = {
        storeId: String(row.store_id), generationId: frozen.owner.generationId, operationId: String(row.operation_id), objectId: String(row.object_id),
        expectedVersion: String(row.provider_version), expectedSha256: String(row.ciphertext_sha256),
        expectedSize: String(row.size_bytes), expectedExpiresAt: row.expires_at.toISOString(),
      }
      await transaction((query) => admit(query, authorize, frozen, false, storeId))
      let result = await store.status(request)
      if (result.outcome === 'unknown') {
        await transaction((query) => admit(query, authorize, frozen, false, storeId))
        result = await store.discard(request)
      }
      if (result.outcome !== 'absent') return { outcome: 'retained', confirmed }
      const receipt = result.receiptSha256
      await transaction(async (query) => {
        await admit(query, authorize, frozen, false, storeId)
        const state = (await query(`SELECT object_state,terminal_receipt_sha256
          FROM public.meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid FOR UPDATE`,
        [frozen.owner.generationId, row.staging_object_id])).rows[0] as Record<string, unknown> | undefined
        if (!state) refuseRecoveryArchiveDiscard()
        if (state.object_state === 'absent') {
          if (state.terminal_receipt_sha256 !== receipt) refuseRecoveryArchiveDiscard()
          return
        }
        if (state.object_state !== 'sealed') refuseRecoveryArchiveDiscard()
        await query(`UPDATE public.meta_recovery_archive_staging_objects SET object_state='absent',
          terminal_receipt_sha256=$3,cleanup_owner_kind='archive_cleanup',cleanup_owner_id=$4,cleanup_owner_fence=$5::bigint
          WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid AND object_state='sealed'`,
        [frozen.owner.generationId, row.staging_object_id, receipt, frozen.owner.ownerId, frozen.owner.ownerFence])
      })
      confirmed++
    }
    await transaction(async (query) => {
      await admit(query, authorize, frozen, false, storeId)
      const outstanding = await query(`SELECT 1 FROM public.meta_recovery_archive_staging_objects
        WHERE generation_id=$1::uuid AND object_state NOT IN ('absent','deleted') LIMIT 1`, [frozen.owner.generationId])
      if (outstanding.rows.length) refuseRecoveryArchiveDiscard()
      const pins = await query(`SELECT attachment_id FROM public.meta_recovery_archive_attachment_refs
        WHERE generation_id=$1::uuid AND reference_class='source' ORDER BY attachment_id`, [frozen.owner.generationId])
      for (const pin of pins.rows as { attachment_id: string }[]) {
        await query(`SELECT public.meta_recovery_archive_release_abandoned_source_pin($1::uuid,$2,'archive_cleanup',$3,$4::bigint)`,
        [frozen.owner.generationId, pin.attachment_id, frozen.owner.ownerId, frozen.owner.ownerFence])
      }
    })
    return { outcome: 'complete', confirmed }
  } catch { return refuseRecoveryArchiveDiscard() }
}

/** Internal coordinator reuse; preserves the original D2b admission unchanged. */
export { admit as admitRecoveryArchiveAbandonedObjectCleanup }
