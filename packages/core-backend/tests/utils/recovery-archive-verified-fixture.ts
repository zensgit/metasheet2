import { createHash, randomUUID } from 'node:crypto'

import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import type {
  RecoveryArchiveRestoreJobQuery,
  RecoveryArchiveRestoreJobTransaction,
} from '../../src/multitable/recovery-archive-restore-jobs'
import {
  consumeRecoveryArchiveV2ClaimFixture,
  persistRecoveryArchiveV2ClaimFixture,
  type RecoveryArchiveV2ClaimFixtureIdentity,
} from './recovery-archive-v2-claim-fixture'
import type { RecoveryArchiveDurableFixtureObject } from './recovery-archive-durable-fixture'

export interface Fixture {
  workspaceId: string
  baseId: string
  sheetId: string
  actorId: string
  checkpointId: string
  keyId: string
  generationId: string
  rootHash: string
  sourceVectorHash: string
  anchorOperationId: string
  anchorSeq: string
}

export interface MaterializedArchiveObjects {
  readonly rootHash: string
  readonly manifestMac: Uint8Array
  readonly objects: readonly RecoveryArchiveDurableFixtureObject[]
}

export async function seedVerifiedArchive(input: {
  readonly prefix: string
  readonly query: RecoveryArchiveRestoreJobQuery
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  readonly label: string
  readonly expiresAt?: string
  readonly materialize?: (
    fixture: Fixture,
  ) => Promise<MaterializedArchiveObjects>
}): Promise<Fixture> {
  const {
    prefix,
    query,
    transaction,
    label,
    expiresAt = '2099-12-31T00:00:00.000Z',
    materialize,
  } = input
  const sha = (value: string): string =>
    createHash('sha256').update(value).digest('hex')
  const suffix = `${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const fixture: Fixture = {
    workspaceId: `${prefix}_${suffix}_workspace`,
    baseId: `${prefix}_${suffix}_base`,
    sheetId: `${prefix}_${suffix}_sheet`,
    actorId: `${prefix}_${suffix}_actor`,
    checkpointId: `${prefix}_${suffix}_checkpoint`,
    keyId: `${prefix}_${suffix}_key`,
    generationId: randomUUID(),
    rootHash: sha(`${prefix}|${suffix}|root`),
    sourceVectorHash: '',
    anchorOperationId: '',
    anchorSeq: '',
  }

  await query(
    `INSERT INTO public.meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)`,
    [fixture.baseId, `${prefix} base`, fixture.workspaceId],
  )
  await query(
    `INSERT INTO public.meta_sheets (id, base_id, name) VALUES ($1, $2, $3)`,
    [fixture.sheetId, fixture.baseId, `${prefix} sheet`],
  )
  await query(
    `INSERT INTO public.meta_history_trust_checkpoints (
       id, sheet_id, state, trusted_since_seq, activated_at
     ) VALUES ($1, $2, 'active', 1, clock_timestamp())`,
    [fixture.checkpointId, fixture.sheetId],
  )
  await query(
    `INSERT INTO public.meta_recovery_archive_keys (key_id) VALUES ($1)`,
    [fixture.keyId],
  )

  await transaction(async (transactionQuery) => {
    await persistRecoveryArchiveV2ClaimFixture(
      transactionQuery,
      {
        generationId: fixture.generationId,
        sheetId: fixture.sheetId,
        ownerKind: 'archive_builder',
        ownerId: `${prefix}_builder`,
        ownerFence: '1',
      },
      async (identity: RecoveryArchiveV2ClaimFixtureIdentity) => {
        fixture.sourceVectorHash = identity.sourceVectorHash
        fixture.anchorOperationId = identity.anchorOperationId
        fixture.anchorSeq = identity.anchorSeq
        await transactionQuery(
          `INSERT INTO public.meta_recovery_archives (
             generation_id, workspace_id, base_id, sheet_id,
             anchor_operation_id, anchor_seq, checkpoint_id, format_version,
             state, build_status, coverage_status, source_vector_hash, key_id,
             owner_kind, owner_id, owner_fence, lease_expires_at, expires_at
           ) VALUES (
             $1::uuid, $2, $3, $4,
             $5::uuid, $6::bigint, $7, 1,
             'building', 'active', 'incomplete', $8, $9,
             'archive_builder', $10, 1,
             '2099-01-01T00:00:00.000Z'::timestamptz,
             $11::timestamptz
           )`,
          [
            fixture.generationId,
            fixture.workspaceId,
            fixture.baseId,
            fixture.sheetId,
            identity.anchorOperationId,
            identity.anchorSeq,
            fixture.checkpointId,
            identity.sourceVectorHash,
            fixture.keyId,
            `${prefix}_builder`,
            expiresAt,
          ],
        )
      },
    )
  })

  const materialized = materialize ? await materialize(fixture) : undefined
  if (materialized) fixture.rootHash = materialized.rootHash

  await transaction(async (transactionQuery) => {
    const slots: readonly RecoveryArchiveDurableFixtureObject[] =
      materialized?.objects ?? [
        ...RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => ({
          objectClass: 'section' as const,
          sectionName,
          objectId: sha(
            `${fixture.generationId}|section:${sectionName}|object`,
          ),
          providerVersion: `${prefix}_provider_v1`,
          plaintextSha256: sha(
            `${fixture.generationId}|section:${sectionName}|plaintext`,
          ),
          ciphertextSha256: sha(
            `${fixture.generationId}|section:${sectionName}|ciphertext`,
          ),
          sizeBytes: '1',
        })),
        {
          objectClass: 'manifest' as const,
          sectionName: null,
          objectId: sha(`${fixture.generationId}|manifest|object`),
          providerVersion: `${prefix}_provider_v1`,
          plaintextSha256: sha(`${fixture.generationId}|manifest|plaintext`),
          ciphertextSha256: sha(`${fixture.generationId}|manifest|ciphertext`),
          sizeBytes: '1',
        },
      ]
    for (const slot of slots) {
      await transactionQuery(
        `INSERT INTO public.meta_recovery_archive_objects (
           generation_id, object_id, object_class, section_name, attachment_id,
           key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
           idempotency_key, put_receipt_sha256, head_receipt_sha256,
           owner_kind, owner_id, owner_fence
         ) VALUES (
           $1::uuid, $2, $3, $4, NULL,
           $5, $6, $7, $8, $9::bigint,
           $2, $10, $11,
           'archive_builder', $12, 1
         )`,
        [
          fixture.generationId,
          slot.objectId,
          slot.objectClass,
          slot.sectionName,
          fixture.keyId,
          slot.providerVersion,
          slot.plaintextSha256,
          slot.ciphertextSha256,
          slot.sizeBytes,
          sha(`${fixture.generationId}|${slot.objectId}|put`),
          sha(`${fixture.generationId}|${slot.objectId}|head`),
          `${prefix}_builder`,
        ],
      )
    }
    await transactionQuery(
      `UPDATE public.meta_recovery_archive_objects
          SET state='verified', verified_at=clock_timestamp()
        WHERE generation_id=$1::uuid AND state='uploaded'`,
      [fixture.generationId],
    )
    await consumeRecoveryArchiveV2ClaimFixture(transactionQuery, {
      generationId: fixture.generationId,
      sheetId: fixture.sheetId,
      sourceVectorHash: fixture.sourceVectorHash,
      ownerKind: 'archive_builder',
      ownerId: `${prefix}_builder`,
      ownerFence: '1',
    })
    await transactionQuery(
      `UPDATE public.meta_recovery_archives
          SET state='verified', build_status='finalized', coverage_status='complete',
              root_hash=$2, coverage_section_hash=$3, coverage_row_count=0,
              manifest_mac=$4::bytea
        WHERE generation_id=$1::uuid`,
      [
        fixture.generationId,
        fixture.rootHash,
        sha(`${fixture.generationId}|coverage`),
        materialized?.manifestMac ?? Buffer.from(`${prefix}|manifest`),
      ],
    )
  })

  return fixture
}
