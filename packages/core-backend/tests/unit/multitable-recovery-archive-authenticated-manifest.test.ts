import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  authenticateRecoveryArchiveSealedSnapshotManifest,
  RecoveryArchiveAuthenticatedManifestError,
  type RecoveryArchiveAuthenticatedManifestErrorCode,
} from '../../src/multitable/recovery-archive-authenticated-manifest'
import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from '../../src/multitable/recovery-archive-contract'
import {
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  sealRecoveryArchiveSection,
  toRecoveryArchiveNonceHex,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveReserveThenSealResult,
  type RecoveryArchiveTransactionDepthProbe,
} from '../../src/multitable/recovery-archive-crypto'
import {
  canonicalizeRecoveryArchiveJson,
  computeRecoveryArchiveManifestRootHash,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifestBinding,
} from '../../src/multitable/recovery-archive-manifest'
import {
  parseRecoveryArchiveManifestObjectEnvelope,
  RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION,
} from '../../src/multitable/recovery-archive-manifest-object-envelope'
import {
  buildRecoveryArchiveSealedSnapshotManifest,
  type RecoveryArchiveSealedSnapshotManifestResult,
} from '../../src/multitable/recovery-archive-sealed-snapshot-manifest'
import { buildRecoveryArchiveSnapshotPlan } from '../../src/multitable/recovery-archive-snapshot-plan'

const SENTINEL = 'authenticated-manifest-sensitive-sentinel'
const KEY_ID = 'kms-key-0001'
const WRAPPED_DEK_ID = 'wrapped-dek-0001'
const DEK_FINGERPRINT = 'a'.repeat(64)
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const WRAPPED_DEK = Uint8Array.from({ length: 48 }, (_, index) => 200 - index)
const MAC = Uint8Array.from([0, 1, 15, 16, 255])

const BINDING: RecoveryArchiveManifestBinding = {
  archive_generation_id: 'generation-0001',
  workspace_id: 'workspace-0001',
  base_id: 'base-0001',
  sheet_id: 'sheet-0001',
  anchor_operation_id: 'operation-0001',
  anchor_seq: '9007199254740993',
  checkpoint_id: 'checkpoint-0001',
  created_at: '2026-08-28T00:00:00.000Z',
  expires_at: '2026-09-28T00:00:00.000Z',
  source_vector_hash: 'b'.repeat(64),
}

function makePlan() {
  const nonces = Object.fromEntries(
    RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name, index) => [
      name,
      Uint8Array.from({ length: 12 }, (_, byteIndex) => index * 12 + byteIndex),
    ]),
  ) as Record<RecoveryArchiveSectionName, Uint8Array>
  return buildRecoveryArchiveSnapshotPlan({
    sectionRows: {
      schema: [
        {
          field_id: 'field-1',
          name: 'Name',
          type: 'text',
          property: {},
          order: 1,
        },
      ],
      records: [
        {
          record_id: 'record-1',
          exists: true,
          version: 1,
          data: { text: 'value' },
        },
      ],
      links: [],
      field_value_tombstones: [],
      link_tombstones: [],
      auto_number: [],
      attachments_index: [],
      permission_evidence: [],
      views_config: [],
    },
    coverageCandidates: [],
    nonces,
  })
}

function makeUnsigned(): RecoveryArchiveSealedSnapshotManifestResult {
  const plan = makePlan()
  const cryptoBinding = {
    formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
    generationId: BINDING.archive_generation_id,
    workspaceId: BINDING.workspace_id,
    baseId: BINDING.base_id,
    sheetId: BINDING.sheet_id,
    anchorOperationId: BINDING.anchor_operation_id,
    anchorSeq: BINDING.anchor_seq,
    checkpointId: BINDING.checkpoint_id,
    keyId: KEY_ID,
    wrappedDekId: WRAPPED_DEK_ID,
    dekFingerprint: DEK_FINGERPRINT,
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  } as const
  const sealResult: RecoveryArchiveReserveThenSealResult = {
    binding: cryptoBinding,
    dekFingerprint: DEK_FINGERPRINT,
    wrappedDekId: WRAPPED_DEK_ID,
    wrappedDek: new Uint8Array(WRAPPED_DEK),
    reservations: plan.map((section) => ({
      dekFingerprint: DEK_FINGERPRINT,
      nonceHex: toRecoveryArchiveNonceHex(section.nonce),
      generationId: cryptoBinding.generationId,
      sectionName: section.sectionName,
      aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
      formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
    })),
    sealedSections: plan.map((section) =>
      sealRecoveryArchiveSection({
        binding: {
          ...cryptoBinding,
          sectionName: section.sectionName,
          plaintextSha256: section.plaintextSha256,
        },
        dek: DEK,
        nonce: section.nonce,
        plaintext: section.plaintext,
      }),
    ),
  }
  return buildRecoveryArchiveSealedSnapshotManifest({
    binding: BINDING,
    keyId: KEY_ID,
    plan,
    sealResult,
  })
}

function mutableBundle(unsigned = makeUnsigned()) {
  return {
    manifest: JSON.parse(unsigned.manifestJson),
    bodyJson: unsigned.bodyJson,
    manifestJson: unsigned.manifestJson,
    macPreimage: unsigned.macPreimage,
    sealedSections: unsigned.sealedSections.map((section) => ({
      sectionName: section.sectionName,
      aeadAlgorithm: section.aeadAlgorithm,
      plaintextSha256: section.plaintextSha256,
      ciphertextSha256: section.ciphertextSha256,
      ciphertextSizeBytes: section.ciphertextSizeBytes,
      nonce: section.nonce,
      ciphertext: section.ciphertext,
      authTag: section.authTag,
    })),
    wrappedDek: unsigned.wrappedDek,
  }
}

function refreshManifestEnvelope(
  bundle: ReturnType<typeof mutableBundle>,
): void {
  const {
    manifest_mac: _manifestMac,
    root_hash: _rootHash,
    ...body
  } = bundle.manifest
  bundle.manifest.root_hash = computeRecoveryArchiveManifestRootHash(body)
  bundle.bodyJson = canonicalizeRecoveryArchiveJson(body)
  bundle.manifestJson = canonicalizeRecoveryArchiveJson(bundle.manifest)
}

function custody(
  macManifestRoot: RecoveryArchiveKeyCustodyAdapter['macManifestRoot'] = async () =>
    new Uint8Array(MAC),
): RecoveryArchiveKeyCustodyAdapter & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async produceGenerationDek() {
      throw new Error('unused')
    },
    async unwrapGenerationDek() {
      throw new Error('unused')
    },
    async deriveDekFingerprint() {
      throw new Error('unused')
    },
    async macManifestRoot(request) {
      calls.push('macManifestRoot')
      return macManifestRoot(request)
    },
    async verifyManifestRootMac() {
      throw new Error('unused')
    },
  }
}

function depthProbe(depth: number): RecoveryArchiveTransactionDepthProbe {
  return { currentTransactionDepth: () => depth }
}

async function errorOf(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected-refusal')
}

async function expectAuthError(
  run: () => Promise<unknown>,
  code: RecoveryArchiveAuthenticatedManifestErrorCode,
): Promise<void> {
  const error = await errorOf(run)
  expect(error).toBeInstanceOf(RecoveryArchiveAuthenticatedManifestError)
  expect(error).toMatchObject({
    name: 'RecoveryArchiveAuthenticatedManifestError',
    code,
    message: code,
  })
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  expect(String(error)).not.toContain(SENTINEL)
  expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
}

describe('authenticateRecoveryArchiveSealedSnapshotManifest', () => {
  test('MACs the reconstructed binding and emits one canonical signed manifest', async () => {
    const unsigned = makeUnsigned()
    let seenKeyId = ''
    let seenPreimage = new Uint8Array()
    const keyCustody = custody(async (request) => {
      seenKeyId = request.keyId
      seenPreimage = new Uint8Array(request.preimage)
      return new Uint8Array(MAC)
    })
    const authenticated =
      await authenticateRecoveryArchiveSealedSnapshotManifest({
        sealedManifest: unsigned,
        keyCustody,
        transactionDepth: depthProbe(0),
      })

    expect(keyCustody.calls).toEqual(['macManifestRoot'])
    expect(seenKeyId).toBe(KEY_ID)
    expect(seenPreimage).toEqual(unsigned.macPreimage)
    expect(authenticated.manifest.manifest_mac).toBe('00010f10ff')
    expect(authenticated.manifestMacBytes).toEqual(MAC)
    expect(
      Uint8Array.from(
        Buffer.from(authenticated.manifest.manifest_mac ?? '', 'hex'),
      ),
    ).toEqual(authenticated.manifestMacBytes)
    expect(authenticated.bodyJson).toBe(unsigned.bodyJson)
    expect(authenticated.manifest.root_hash).toBe(unsigned.manifest.root_hash)
    expect(authenticated.manifest.sections).toEqual(unsigned.manifest.sections)
    expect(authenticated.manifestJson).toBe(
      canonicalizeRecoveryArchiveJson(authenticated.manifest),
    )
    expect(
      validateRecoveryArchiveManifest(JSON.parse(authenticated.manifestJson)),
    ).toEqual(authenticated.manifest)

    const parsedEnvelope = parseRecoveryArchiveManifestObjectEnvelope(
      authenticated.envelopeBytes,
    )
    expect(parsedEnvelope.envelopeVersion).toBe(
      RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION,
    )
    expect(parsedEnvelope.manifestJson).toBe(authenticated.manifestJson)
    expect(parsedEnvelope.manifest).toEqual(authenticated.manifest)
    expect(parsedEnvelope.wrappedDek).toEqual(WRAPPED_DEK)
    expect(parsedEnvelope.envelopeSha256).toBe(authenticated.envelopeSha256)
    expect(authenticated.envelopeSha256).toBe(
      createHash('sha256').update(authenticated.envelopeBytes).digest('hex'),
    )
    expect(authenticated.manifest).not.toHaveProperty('wrapped_dek')
    expect(JSON.parse(authenticated.manifestJson)).not.toHaveProperty(
      'wrapped_dek',
    )
    expect(
      Object.prototype.hasOwnProperty.call(unsigned, 'envelopeBytes'),
    ).toBe(false)
  })

  test('snapshots identities and sealed bytes before awaiting KMS and returns fresh byte copies', async () => {
    const unsigned = makeUnsigned()
    const bundle = mutableBundle(unsigned)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapterMac = new Uint8Array(MAC)
    const keyCustody = custody(async (request) => {
      const preimage = new Uint8Array(request.preimage)
      enter()
      await gate
      expect(request.preimage).toEqual(preimage)
      return adapterMac
    })

    const pending = authenticateRecoveryArchiveSealedSnapshotManifest({
      sealedManifest: bundle,
      keyCustody,
      transactionDepth: depthProbe(0),
    })
    await entered
    bundle.manifest.workspace_id = 'mutated-after-admission'
    bundle.macPreimage.fill(0)
    bundle.sealedSections[0]?.ciphertext.fill(0)
    bundle.wrappedDek.fill(0)
    release()
    const authenticated = await pending

    adapterMac.fill(9)
    const firstMacRead = authenticated.manifestMacBytes
    firstMacRead.fill(8)
    const firstCiphertextRead = authenticated.sealedSections[0]?.ciphertext
    firstCiphertextRead?.fill(7)
    const firstEnvelopeRead = authenticated.envelopeBytes
    firstEnvelopeRead.fill(6)
    expect(authenticated.manifest.workspace_id).toBe(BINDING.workspace_id)
    expect(authenticated.manifestMacBytes).toEqual(MAC)
    expect(authenticated.sealedSections[0]?.ciphertextSha256).toBe(
      createHash('sha256')
        .update(authenticated.sealedSections[0]?.ciphertext ?? new Uint8Array())
        .digest('hex'),
    )
    expect(authenticated.envelopeBytes).not.toEqual(firstEnvelopeRead)
    expect(
      parseRecoveryArchiveManifestObjectEnvelope(authenticated.envelopeBytes)
        .wrappedDek,
    ).toEqual(WRAPPED_DEK)
  })

  test('refuses a signed input and every cached identity, root, preimage, or section substitution', async () => {
    const cases: Array<() => ReturnType<typeof mutableBundle>> = [
      () => {
        const bundle = mutableBundle()
        bundle.manifest.manifest_mac = '00'
        bundle.manifestJson = canonicalizeRecoveryArchiveJson(bundle.manifest)
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        bundle.manifest.workspace_id = 'workspace-other'
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        bundle.manifest.root_hash = 'c'.repeat(64)
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        bundle.manifest.sections[0].key_id = 'kms-key-other'
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        bundle.macPreimage[0] ^= 1
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        ;[bundle.sealedSections[0], bundle.sealedSections[1]] = [
          bundle.sealedSections[1],
          bundle.sealedSections[0],
        ]
        return bundle
      },
      () => {
        const bundle = mutableBundle()
        bundle.sealedSections[0].ciphertext[0] ^= 1
        return bundle
      },
    ]

    for (const makeCase of cases) {
      const keyCustody = custody()
      const error = await errorOf(() =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: makeCase(),
          keyCustody,
          transactionDepth: depthProbe(0),
        }),
      )
      expect(error).toBeInstanceOf(RecoveryArchiveAuthenticatedManifestError)
      expect(keyCustody.calls).toEqual([])
    }
  })

  test('reconstructs the MAC preimage after coherent identity and root/JCS substitutions', async () => {
    const substitutions: Array<
      (bundle: ReturnType<typeof mutableBundle>) => void
    > = [
      (bundle) => {
        bundle.manifest.workspace_id = 'workspace-other'
      },
      (bundle) => {
        bundle.manifest.base_id = 'base-other'
      },
      (bundle) => {
        bundle.manifest.sheet_id = 'sheet-other'
      },
      (bundle) => {
        bundle.manifest.anchor_operation_id = 'operation-other'
      },
      (bundle) => {
        for (const section of bundle.manifest.sections)
          section.key_id = 'kms-key-other'
      },
      (bundle) => {
        for (const section of bundle.manifest.sections)
          section.wrapped_dek_id = 'wrapped-dek-other'
      },
    ]

    for (const substitute of substitutions) {
      const bundle = mutableBundle()
      substitute(bundle)
      refreshManifestEnvelope(bundle)
      const keyCustody = custody()
      await expectAuthError(
        () =>
          authenticateRecoveryArchiveSealedSnapshotManifest({
            sealedManifest: bundle,
            keyCustody,
            transactionDepth: depthProbe(0),
          }),
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH',
      )
      expect(keyCustody.calls).toEqual([])
    }
  })

  test('refuses when the KMS adapter mutates the snapshotted request preimage', async () => {
    await expectAuthError(
      () =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: makeUnsigned(),
          keyCustody: custody(async (request) => {
            request.preimage[0] ^= 1
            return new Uint8Array(MAC)
          }),
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
    )
  })

  test('fails before KMS when transaction depth is nonzero or unreadable', async () => {
    for (const transactionDepth of [
      depthProbe(1),
      { currentTransactionDepth: () => Number.NaN },
      {
        currentTransactionDepth: () => {
          throw new Error(SENTINEL)
        },
      },
    ]) {
      const keyCustody = custody()
      await expectAuthError(
        () =>
          authenticateRecoveryArchiveSealedSnapshotManifest({
            sealedManifest: makeUnsigned(),
            keyCustody,
            transactionDepth,
          }),
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
      )
      expect(keyCustody.calls).toEqual([])
    }
  })

  test('normalizes hostile shapes, accessors, forged errors, and invalid MAC results', async () => {
    const proxy = new Proxy(mutableBundle(), {
      ownKeys() {
        throw new Error(SENTINEL)
      },
    })
    await expectAuthError(
      () =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: proxy,
          keyCustody: custody(),
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    )

    let accessorRan = false
    const accessor = mutableBundle()
    Object.defineProperty(accessor.manifest, 'workspace_id', {
      enumerable: true,
      get() {
        accessorRan = true
        throw new Error(SENTINEL)
      },
    })
    await expectAuthError(
      () =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: accessor,
          keyCustody: custody(),
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    )
    expect(accessorRan).toBe(false)

    const forged = new RecoveryArchiveAuthenticatedManifestError(
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
    )
    forged.message = SENTINEL
    forged.stack = SENTINEL
    await expectAuthError(
      () =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: makeUnsigned(),
          keyCustody: custody(async () => {
            throw forged
          }),
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
    )

    for (const invalid of [new Uint8Array(), '00', null]) {
      await expectAuthError(
        () =>
          authenticateRecoveryArchiveSealedSnapshotManifest({
            sealedManifest: makeUnsigned(),
            keyCustody: custody(async () => invalid as Uint8Array),
            transactionDepth: depthProbe(0),
          }),
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
      )
    }
  })

  test('refuses an empty wrapped-DEK carrier before KMS', async () => {
    const keyCustody = custody()
    await expectAuthError(
      () =>
        authenticateRecoveryArchiveSealedSnapshotManifest({
          sealedManifest: { ...mutableBundle(), wrappedDek: new Uint8Array() },
          keyCustody,
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    )
    expect(keyCustody.calls).toEqual([])
  })

  test('rejects additive outer and section keys before KMS', async () => {
    for (const sealedManifest of [
      { ...mutableBundle(), injected: true },
      (() => {
        const bundle = mutableBundle()
        return {
          ...bundle,
          sealedSections: bundle.sealedSections.map((section, index) =>
            index === 0 ? { ...section, injected: true } : section,
          ),
        }
      })(),
    ]) {
      const keyCustody = custody()
      await expectAuthError(
        () =>
          authenticateRecoveryArchiveSealedSnapshotManifest({
            sealedManifest,
            keyCustody,
            transactionDepth: depthProbe(0),
          }),
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
      )
      expect(keyCustody.calls).toEqual([])
    }
  })
})
