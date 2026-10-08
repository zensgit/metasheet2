import {
  allocateRecoveryArchiveSnapshotIdentities,
  consumeRecoveryArchiveBootstrapReservations,
  persistRecoveryArchiveSnapshotReservations,
} from '../../src/multitable/recovery-archive-section-bootstrap'
import {
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type SealQuery,
} from '../../src/multitable/recovery-archive-seals'
import { computeRecoveryArchiveSourceVectorHash } from '../../src/multitable/recovery-archive-source-vector'

const SECTION_HASH = 'a'.repeat(64)

export interface RecoveryArchiveV2ClaimFixtureOwner {
  generationId: string
  sheetId: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

export interface RecoveryArchiveV2ClaimFixtureIdentity {
  anchorOperationId: string
  anchorSeq: string
  sourceVectorHash: string
}

export async function persistRecoveryArchiveV2ClaimFixture(
  query: SealQuery,
  owner: RecoveryArchiveV2ClaimFixtureOwner,
  insertGeneration: (identity: RecoveryArchiveV2ClaimFixtureIdentity) => Promise<void>,
): Promise<RecoveryArchiveV2ClaimFixtureIdentity> {
  const allocated = await allocateRecoveryArchiveSnapshotIdentities(query)
  const sourceVectorHash = computeRecoveryArchiveSourceVectorHash(
    allocated.sections.map((section) => ({
      sourceHeadKind: 'section_bootstrap',
      sectionKind: section.sectionKind,
      operationId: section.operationId,
      headSeq: section.endpointSeq,
    })),
  ).hash
  const identity = {
    anchorOperationId: allocated.snapshotOperationId,
    anchorSeq: allocated.snapshotSeq,
    sourceVectorHash,
  }

  await insertGeneration(identity)
  await persistRecoveryArchiveSnapshotReservations(
    query,
    {
      ...owner,
      sourceVectorHash,
      sections: allocated.sections,
      snapshotOperationId: allocated.snapshotOperationId,
      snapshotSeq: allocated.snapshotSeq,
    },
    allocated,
  )
  return identity
}

export async function consumeRecoveryArchiveV2ClaimFixture(
  query: SealQuery,
  owner: RecoveryArchiveV2ClaimFixtureOwner & { sourceVectorHash: string },
): Promise<void> {
  await consumeRecoveryArchiveBootstrapReservations(query, {
    ...owner,
    sections: SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind) => ({
      sectionKind,
      rowCount: '0',
      sourceHash: SECTION_HASH,
    })),
  })
}
