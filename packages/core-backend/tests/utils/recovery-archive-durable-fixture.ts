import { createHash, createHmac, randomBytes } from 'node:crypto'

import { authenticateRecoveryArchiveSealedSnapshotManifest } from '../../src/multitable/recovery-archive-authenticated-manifest'
import {
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_KEY_BYTES,
  reserveThenSealRecoveryArchiveSections,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveTransactionDepthProbe,
} from '../../src/multitable/recovery-archive-crypto'
import type {
  RecoveryArchiveManifestBinding,
} from '../../src/multitable/recovery-archive-manifest'
import type {
  RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import { buildRecoveryArchiveSealedSnapshotManifest } from '../../src/multitable/recovery-archive-sealed-snapshot-manifest'
import {
  buildRecoveryArchiveSnapshotPlan,
  type RecoveryArchiveSnapshotSectionRows,
} from '../../src/multitable/recovery-archive-snapshot-plan'

const WRAPPED_DEK_ID = 'test-wrapped-dek-v1'
const DEK_FINGERPRINT_DOMAIN = 'metasheet.recovery-archive.dek-fingerprint.v1'

export interface RecoveryArchiveDurableFixtureObject {
  readonly objectClass: 'manifest' | 'section'
  readonly sectionName: string | null
  readonly objectId: string
  readonly providerVersion: string
  readonly plaintextSha256: string
  readonly ciphertextSha256: string
  readonly sizeBytes: string
}

export interface RecoveryArchiveDurableFixture {
  readonly keyCustody: RecoveryArchiveKeyCustodyAdapter
  readonly custodyCalls: readonly string[]
  readonly rootHash: string
  readonly manifestMac: Uint8Array
  readonly objects: readonly RecoveryArchiveDurableFixtureObject[]
}

export async function createRecoveryArchiveDurableFixture(input: {
  readonly binding: RecoveryArchiveManifestBinding
  readonly keyId: string
  readonly sectionRows: RecoveryArchiveSnapshotSectionRows
  readonly objectStore: RecoveryArchiveObjectStoreProvider
  readonly transactionDepth: RecoveryArchiveTransactionDepthProbe
  readonly objectExpiresAt: string
}): Promise<RecoveryArchiveDurableFixture> {
  const custodyCalls: string[] = []
  const keyCustody = createFixtureKeyCustody(input.keyId, custodyCalls)
  const plan = buildRecoveryArchiveSnapshotPlan({
    sectionRows: input.sectionRows,
    coverageCandidates: [],
    nonces: Object.fromEntries(
      RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name, index) => [
        name,
        Uint8Array.from({ length: 12 }, (_, byteIndex) => index * 12 + byteIndex),
      ]),
    ),
  })
  const sealed = await reserveThenSealRecoveryArchiveSections({
    binding: {
      formatVersion: 1,
      generationId: input.binding.archive_generation_id,
      workspaceId: input.binding.workspace_id,
      baseId: input.binding.base_id,
      sheetId: input.binding.sheet_id,
      anchorOperationId: input.binding.anchor_operation_id,
      anchorSeq: input.binding.anchor_seq,
      checkpointId: input.binding.checkpoint_id,
      keyId: input.keyId,
      aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    },
    keyCustody,
    transactionDepth: input.transactionDepth,
    dekSource: { kind: 'produce' },
    sections: plan,
    reserveNonces: async () => {},
  })
  const authenticated = await authenticateRecoveryArchiveSealedSnapshotManifest({
    sealedManifest: buildRecoveryArchiveSealedSnapshotManifest({
      binding: input.binding,
      keyId: input.keyId,
      plan,
      sealResult: sealed,
    }),
    keyCustody,
    transactionDepth: input.transactionDepth,
  })

  const objects: RecoveryArchiveDurableFixtureObject[] = []
  const manifestDescriptor = await input.objectStore.put({
    generationId: input.binding.archive_generation_id,
    objectId: objectId(input.binding.archive_generation_id, 'manifest'),
    version: '1',
    sha256: digest(authenticated.envelopeBytes),
    size: String(authenticated.envelopeBytes.byteLength),
    expiresAt: input.objectExpiresAt,
    pinned: true,
    bytes: authenticated.envelopeBytes,
  })
  objects.push({
    objectClass: 'manifest',
    sectionName: null,
    objectId: manifestDescriptor.object.objectId,
    providerVersion: manifestDescriptor.object.version,
    plaintextSha256: digest(authenticated.envelopeBytes),
    ciphertextSha256: manifestDescriptor.object.sha256,
    sizeBytes: manifestDescriptor.object.size,
  })

  for (const section of authenticated.sealedSections) {
    const bytes = concatSectionObject(section.ciphertext, section.authTag)
    const descriptor = await input.objectStore.put({
      generationId: input.binding.archive_generation_id,
      objectId: objectId(input.binding.archive_generation_id, `section:${section.sectionName}`),
      version: '1',
      sha256: digest(bytes),
      size: String(bytes.byteLength),
      expiresAt: input.objectExpiresAt,
      pinned: true,
      bytes,
    })
    objects.push({
      objectClass: 'section',
      sectionName: section.sectionName,
      objectId: descriptor.object.objectId,
      providerVersion: descriptor.object.version,
      plaintextSha256: section.plaintextSha256,
      ciphertextSha256: descriptor.object.sha256,
      sizeBytes: descriptor.object.size,
    })
  }

  return Object.freeze({
    keyCustody,
    get custodyCalls() {
      return Object.freeze([...custodyCalls])
    },
    rootHash: authenticated.manifest.root_hash,
    manifestMac: new Uint8Array(authenticated.manifestMacBytes),
    objects: Object.freeze(objects.map((object) => Object.freeze({ ...object }))),
  })
}

function createFixtureKeyCustody(
  keyId: string,
  calls: string[],
): RecoveryArchiveKeyCustodyAdapter {
  const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES)
  const wrappedDek = randomBytes(48)
  return {
    async produceGenerationDek(request) {
      calls.push('produce')
      if (request.keyId !== keyId) throw new Error('recovery_archive_fixture_key_mismatch')
      return {
        dek: new Uint8Array(dek),
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: new Uint8Array(wrappedDek),
      }
    },
    async unwrapGenerationDek(request) {
      calls.push('unwrap')
      if (
        request.keyId !== keyId ||
        request.wrappedDekId !== WRAPPED_DEK_ID ||
        !Buffer.from(request.wrappedDek).equals(wrappedDek)
      ) {
        throw new Error('recovery_archive_fixture_unwrap_mismatch')
      }
      return {
        dek: new Uint8Array(dek),
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: new Uint8Array(wrappedDek),
      }
    },
    async deriveDekFingerprint(request) {
      calls.push('fingerprint')
      if (request.keyId !== keyId) throw new Error('recovery_archive_fixture_key_mismatch')
      return createHmac('sha256', Buffer.from(request.dek))
        .update(DEK_FINGERPRINT_DOMAIN)
        .digest('hex')
    },
    async macManifestRoot(request) {
      calls.push('mac')
      if (request.keyId !== keyId) throw new Error('recovery_archive_fixture_key_mismatch')
      return createHmac('sha256', `test-mac:${keyId}`).update(request.preimage).digest()
    },
    async verifyManifestRootMac(request) {
      calls.push('verify')
      if (request.keyId !== keyId) return false
      const expected = createHmac('sha256', `test-mac:${keyId}`).update(request.preimage).digest()
      return Buffer.from(request.mac).equals(expected)
    },
  }
}

function objectId(generationId: string, slot: string): string {
  return createHash('sha256').update(`fixture:${generationId}:${slot}`).digest('hex')
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function concatSectionObject(ciphertext: Uint8Array, authTag: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ciphertext.byteLength + authTag.byteLength)
  bytes.set(ciphertext, 0)
  bytes.set(authTag, ciphertext.byteLength)
  return bytes
}
