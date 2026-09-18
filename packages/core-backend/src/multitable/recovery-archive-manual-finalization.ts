import { createHash } from 'node:crypto'
import { acquireCanonicalSheetFence, assertNoActiveWriterBlock } from './canonical-sheet-fence'
import { lockActiveRecoveryArchiveKeyForReference, type RecoveryArchiveKeyReferenceInput } from './recovery-archive-key-registry'
import { readRecoveryArchiveManualRequest, type RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { readRecoveryArchivePreparedCapture, type RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import { decodeRecoveryArchivePreparedEnvelope, type RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import { parseRecoveryArchiveManifestObjectEnvelope } from './recovery-archive-manifest-object-envelope'
import { readRecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { readRecoveryArchiveManualSnapshotPlan } from './recovery-archive-manual-admission'
import { verifyRecoveryArchiveObjectReceipt, type RecoveryArchiveObjectReceiptEvidence } from './recovery-archive-object-receipts'
import type { SealQuery } from './recovery-archive-seals'
import type { RecoveryArchiveCoverageIndexPayload } from './recovery-archive-coverage-plan'
import { buildRecoveryArchiveManifestMacPreimage, createTransactionGuardedKeyCustody,
  type RecoveryArchiveCustodyInput, type RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'

export interface RecoveryArchiveManualFinalizationInput {
  identity: RecoveryArchiveManualRequest
  owner: RecoveryArchivePreparedCaptureOwner
  /** Server-owned admission policy, not a request-body key/version selector. */
  key: RecoveryArchiveKeyReferenceInput
  keyCustody: RecoveryArchiveCustodyInput
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}

function refuse(): never { throw new Error('RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED') }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Verify MAC outside transactions, then bind the unchanged bytes to one atomic publication transaction. */
export function bindRecoveryArchiveManualFinalization(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
) {
  return async (input: RecoveryArchiveManualFinalizationInput): Promise<void> => {
    const identity = { ...input.identity }
    const owner = { ...input.owner }
    const key = { ...input.key }
    const readAdmitted = async (query: SealQuery) => {
      await acquireCanonicalSheetFence(query, identity.sheetId)
      await lockActiveRecoveryArchiveKeyForReference(query, key)
      let allowed = false
      try { allowed = await authorize(query, identity) } catch { /* Values-free refusal. */ }
      if (!allowed) refuse()
      await assertNoActiveWriterBlock(query, identity.sheetId)
      if (await readRecoveryArchiveManualRequest(query, identity) !== owner.generationId) refuse()
      const payload = await readRecoveryArchivePreparedCapture(query, owner)
      if (!payload) refuse()
      return payload
    }
    const payload = await transaction(readAdmitted).catch(() => refuse())
    const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
    if (!envelope.manifestEnvelope) refuse()
    const signed = parseRecoveryArchiveManifestObjectEnvelope(envelope.manifestEnvelope)
    const manifest = signed.manifest
    const preimage = buildRecoveryArchiveManifestMacPreimage({ ...envelope.binding,
      rootHash: manifest.root_hash, createdAt: manifest.created_at, expiresAt: manifest.expires_at,
      sourceVectorHash: manifest.source_vector_hash })
    const custody = createTransactionGuardedKeyCustody(input.keyCustody, input.transactionDepth)
    const verified = await custody.verifyManifestRootMac({ keyId: key.keyId, preimage,
      mac: Buffer.from(manifest.manifest_mac!, 'hex') }).catch(() => refuse())
    if (verified !== true) refuse()
    await transaction(async (query) => {
      if (!(await readAdmitted(query)).equals(payload)) refuse()
      if (manifest.archive_generation_id !== owner.generationId || manifest.workspace_id !== identity.workspaceId
        || manifest.base_id !== identity.baseId || manifest.sheet_id !== identity.sheetId
        || manifest.source_vector_hash !== owner.sourceVectorHash || envelope.binding.keyId !== key.keyId) refuse()
      const generation = (await query(`SELECT workspace_id,base_id,sheet_id,format_version,anchor_operation_id::text,anchor_seq::text,checkpoint_id,key_id,created_at,expires_at
        FROM meta_recovery_archives WHERE generation_id=$1::uuid`, [owner.generationId])).rows[0] as Record<string, unknown>
      if (generation.workspace_id !== identity.workspaceId || generation.base_id !== identity.baseId
        || generation.sheet_id !== identity.sheetId || generation.format_version !== manifest.format_version
        || generation.anchor_operation_id !== manifest.anchor_operation_id || generation.anchor_seq !== manifest.anchor_seq
        || generation.checkpoint_id !== manifest.checkpoint_id || generation.key_id !== key.keyId
        || !(generation.created_at instanceof Date) || generation.created_at.toISOString() !== manifest.created_at
        || !(generation.expires_at instanceof Date) || generation.expires_at.toISOString() !== manifest.expires_at) refuse()
      const trust = await query(`SELECT id FROM meta_history_trust_checkpoints
        WHERE sheet_id=$1 AND id=$2 AND state IN ('active','superseded') AND pruned_at IS NULL
          AND trusted_since_seq <= $3::bigint FOR SHARE`, [identity.sheetId, manifest.checkpoint_id, manifest.anchor_seq])
      if (trust.rows.length !== 1 || (trust.rows[0] as { id: string }).id !== manifest.checkpoint_id) refuse()
      const source = await readRecoveryArchiveCaptureSource(query, identity)
      const nonces = Object.fromEntries(envelope.sections.map((section) => [section.sectionName, section.nonce]))
      const plan = await readRecoveryArchiveManualSnapshotPlan(query, identity.sheetId, manifest.anchor_operation_id, source, nonces)
      if (plan.some((section, index) => section.rowCount !== manifest.sections[index]?.row_count
        || section.plaintextSha256 !== manifest.sections[index]?.plaintext_sha256)) refuse()
      const coverageSection = plan.find((section) => section.sectionName === 'coverage_index')!
      const coverage = JSON.parse(Buffer.from(coverageSection.plaintext).toString('utf8')) as { payload: RecoveryArchiveCoverageIndexPayload }[]
      const objects = (await query(`SELECT generation_id::text AS "generationId",object_id AS "objectId",
        object_class AS "objectClass",section_name AS "sectionName",attachment_id AS "attachmentId",key_id AS "keyId",
        provider_version AS "providerVersion",plaintext_sha256 AS "plaintextSha256",ciphertext_sha256 AS "ciphertextSha256",
        size_bytes::text AS "sizeBytes",idempotency_key AS "idempotencyKey",put_receipt_sha256 AS "putReceiptSha256",
        head_receipt_sha256 AS "headReceiptSha256",owner_kind AS "ownerKind",owner_id AS "ownerId",owner_fence::text AS "ownerFence"
        FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid AND state='uploaded' FOR UPDATE`,
      [owner.generationId])).rows as RecoveryArchiveObjectReceiptEvidence[]
      if (objects.length !== 11) refuse()
      const expected = [...envelope.sections.map((section) => ({ objectClass: 'section', sectionName: section.sectionName,
        bytes: Buffer.concat([section.ciphertext, section.authTag]), plaintextHash: section.plaintextSha256 })),
      { objectClass: 'manifest', sectionName: null, bytes: envelope.manifestEnvelope, plaintextHash: hash(envelope.manifestEnvelope) }]
      for (const item of expected) {
        const digest = hash(item.bytes)
        const matches = objects.filter((object) => object.objectClass === item.objectClass && object.sectionName === item.sectionName)
        const object = matches[0]
        if (matches.length !== 1 || !object || object.attachmentId !== null || object.objectId !== digest
          || object.providerVersion !== digest || object.ciphertextSha256 !== digest || object.keyId !== key.keyId
          || object.plaintextSha256 !== item.plaintextHash || object.sizeBytes !== String(item.bytes.byteLength)
          || object.ownerKind !== owner.ownerKind || object.ownerId !== owner.ownerId || object.ownerFence !== owner.ownerFence) refuse()
        await verifyRecoveryArchiveObjectReceipt(query, object)
      }
      for (const { payload: item } of coverage) {
        await query(`INSERT INTO meta_recovery_archive_coverage_items
          (generation_id,source_kind,source_id,source_seq,source_sha256,bound_section)
          VALUES ($1::uuid,$2,$3,$4::bigint,$5,$6)`,
        [owner.generationId, item.source_kind, item.source_id, item.source_seq, item.source_sha256, item.bound_section])
      }
      const result = await query(`UPDATE meta_recovery_archives SET state='verified',build_status='finalized',coverage_status='complete',
        root_hash=$2,coverage_section_hash=$3,coverage_row_count=$4::bigint,manifest_mac=$5::bytea
        WHERE generation_id=$1::uuid AND state='building' AND build_status='active'
          AND owner_kind=$6 AND owner_id=$7 AND owner_fence=$8::bigint
          AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() RETURNING generation_id`,
      [owner.generationId, manifest.root_hash, coverageSection.plaintextSha256, coverageSection.rowCount,
        Buffer.from(manifest.manifest_mac!, 'hex'), owner.ownerKind, owner.ownerId, owner.ownerFence])
      if (result.rows.length !== 1) refuse()
    }).catch(() => refuse())
  }
}
