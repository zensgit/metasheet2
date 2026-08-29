import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from '../../src/multitable/recovery-archive-contract'
import {
  buildRecoveryArchiveManifestMacPreimage,
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  sealRecoveryArchiveSection,
  toRecoveryArchiveNonceHex,
  type RecoveryArchiveReserveThenSealResult,
} from '../../src/multitable/recovery-archive-crypto'
import type { RecoveryArchiveManifestBinding } from '../../src/multitable/recovery-archive-manifest'
import {
  buildRecoveryArchiveSealedSnapshotManifest,
  RecoveryArchiveSealedSnapshotManifestError,
  type RecoveryArchiveSealedSnapshotManifestErrorCode,
} from '../../src/multitable/recovery-archive-sealed-snapshot-manifest'
import { buildRecoveryArchiveSnapshotPlan } from '../../src/multitable/recovery-archive-snapshot-plan'

const SENTINEL = 'caller-secret-sentinel'
const KEY_ID = 'kms-key-0001'
const WRAPPED_DEK_ID = 'wrapped-dek-0001'
const DEK_FINGERPRINT = 'a'.repeat(64)
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const WRAPPED_DEK = Uint8Array.from({ length: 48 }, (_, index) => 200 - index)

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
      schema: [{ field_id: 'field-1', name: 'Name', type: 'text', property: {}, order: 1 }],
      records: [{ record_id: 'record-1', exists: true, version: 1, data: { text: 'value' } }],
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

function makeSealResult(
  plan: ReturnType<typeof makePlan>,
  binding: RecoveryArchiveManifestBinding = BINDING,
  crypto: {
    keyId?: string
    wrappedDekId?: string
    dekFingerprint?: string
  } = {},
): RecoveryArchiveReserveThenSealResult {
  const keyId = crypto.keyId ?? KEY_ID
  const wrappedDekId = crypto.wrappedDekId ?? WRAPPED_DEK_ID
  const dekFingerprint = crypto.dekFingerprint ?? DEK_FINGERPRINT
  const cryptoBinding = {
    formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
    generationId: binding.archive_generation_id,
    workspaceId: binding.workspace_id,
    baseId: binding.base_id,
    sheetId: binding.sheet_id,
    anchorOperationId: binding.anchor_operation_id,
    anchorSeq: binding.anchor_seq,
    checkpointId: binding.checkpoint_id,
    keyId,
    wrappedDekId,
    dekFingerprint,
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  } as const
  const sealedSections = plan.map((section) =>
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
  )
  return {
    binding: cryptoBinding,
    dekFingerprint,
    wrappedDekId,
    wrappedDek: new Uint8Array(WRAPPED_DEK),
    reservations: plan.map((section) => ({
      dekFingerprint,
      nonceHex: toRecoveryArchiveNonceHex(section.nonce),
      generationId: cryptoBinding.generationId,
      sectionName: section.sectionName,
      aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
      formatVersion: cryptoBinding.formatVersion,
    })),
    sealedSections,
  }
}

function makeInput(overrides: Record<string, unknown> = {}) {
  const plan = makePlan()
  return {
    binding: BINDING,
    keyId: KEY_ID,
    plan,
    sealResult: makeSealResult(plan),
    ...overrides,
  }
}

function expectManifestError(
  run: () => unknown,
  code: RecoveryArchiveSealedSnapshotManifestErrorCode,
): void {
  expect(run).toThrow(RecoveryArchiveSealedSnapshotManifestError)
  try {
    run()
  } catch (error) {
    expect(error).toMatchObject({
      name: 'RecoveryArchiveSealedSnapshotManifestError',
      code,
      message: code,
    })
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
    expect(String(error)).not.toContain(SENTINEL)
    expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
  }
}

describe('buildRecoveryArchiveSealedSnapshotManifest', () => {
  test('binds all ten canonical sections to the unsigned root and exact MAC preimage', () => {
    const input = makeInput()
    const compiled = buildRecoveryArchiveSealedSnapshotManifest(input)

    expect(compiled.manifest.manifest_mac).toBeNull()
    expect(compiled.manifest.sections.map((section) => section.name)).toEqual(RECOVERY_ARCHIVE_V1_SECTION_NAMES)
    expect(compiled.manifest.sections.map((section) => section.row_count)).toEqual([
      '1', '1', '0', '0', '0', '0', '0', '0', '0', '0',
    ])
    expect(compiled.manifest.sections.map((section) => section.plaintext_sha256)).toEqual(
      input.plan.map((section) => section.plaintextSha256),
    )
    expect(compiled.sealedSections.map((section) => section.sectionName)).toEqual(
      RECOVERY_ARCHIVE_V1_SECTION_NAMES,
    )
    expect(compiled.sealedSections).toHaveLength(10)
    expect(compiled.macPreimage).toEqual(Uint8Array.from(
      buildRecoveryArchiveManifestMacPreimage({
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
        rootHash: compiled.manifest.root_hash,
        createdAt: BINDING.created_at,
        expiresAt: BINDING.expires_at,
        sourceVectorHash: BINDING.source_vector_hash,
      }),
    ))
  })

  test('returns frozen metadata and fresh byte snapshots for every sealed byte field', () => {
    const input = makeInput()
    const compiled = buildRecoveryArchiveSealedSnapshotManifest(input)
    const first = compiled.sealedSections[0]
    if (first === undefined) throw new Error('missing-test-section')
    const inputSection = input.sealResult.sealedSections[0]
    if (inputSection === undefined) throw new Error('missing-test-input-section')
    const expected = {
      nonce: Uint8Array.from(first.nonce),
      ciphertext: Uint8Array.from(first.ciphertext),
      authTag: Uint8Array.from(first.authTag),
    }
    const firstMacPreimage = compiled.macPreimage
    firstMacPreimage.fill(0)

    for (const field of ['nonce', 'ciphertext', 'authTag'] as const) {
      inputSection[field].fill(0)
      first[field].fill(0)
      expect(first[field]).toEqual(expected[field])
    }

    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.manifest)).toBe(true)
    expect(Object.isFrozen(compiled.manifest.sections)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(compiled.macPreimage).not.toEqual(firstMacPreimage)
    expect(first.ciphertextSha256).toBe(createHash('sha256').update(expected.ciphertext).digest('hex'))
    expect(first.ciphertextSizeBytes).toBe(String(expected.ciphertext.byteLength))

    const expectedWrappedDek = Uint8Array.from(compiled.wrappedDek)
    input.sealResult.wrappedDek.fill(0)
    compiled.wrappedDek.fill(0)
    expect(compiled.wrappedDek).toEqual(expectedWrappedDek)
    expect(compiled.wrappedDek).toEqual(WRAPPED_DEK)
    expect(Object.prototype.hasOwnProperty.call(compiled.manifest, 'wrapped_dek')).toBe(false)
  })

  test('refuses a plan whose plaintext hash or bytes are not canonical for its section', () => {
    const input = makeInput()
    const forgedPlan = input.plan.map((section) => ({
      ...section,
      plaintextSha256: section.sectionName === 'records' ? 'c'.repeat(64) : section.plaintextSha256,
    }))
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({ ...input, plan: forgedPlan }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES',
    )

    const nonCanonicalPlan = input.plan.map((section) => ({ ...section }))
    const records = nonCanonicalPlan.find((section) => section.sectionName === 'records')
    if (records === undefined) throw new Error('missing-test-records')
    records.plaintext = new TextEncoder().encode('[ ]')
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({ ...input, plan: nonCanonicalPlan }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES',
    )
  })

  test('refuses every reservation identity mismatch', () => {
    for (const [field, value] of [
      ['generationId', 'generation-other'],
      ['dekFingerprint', 'c'.repeat(64)],
      ['formatVersion', 2],
      ['nonceHex', 'f'.repeat(24)],
      ['sectionName', 'records'],
      ['aeadAlgorithm', 'unknown-aead'],
    ] as const) {
      const input = makeInput()
      const reservations = input.sealResult.reservations.map((reservation, index) =>
        index === 0 ? { ...reservation, [field]: value } : reservation,
      )
      expectManifestError(
        () => buildRecoveryArchiveSealedSnapshotManifest({
          ...input,
          sealResult: { ...input.sealResult, reservations },
        }),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
      )
    }

    const reordered = makeInput()
    const reservations = [...reordered.sealResult.reservations]
    ;[reservations[0], reservations[1]] = [reservations[1], reservations[0]]
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({
        ...reordered,
        sealResult: { ...reordered.sealResult, reservations },
      }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
    )
  })

  test('refuses reordered or mismatched sealed section identity', () => {
    for (const mutate of [
      (input: ReturnType<typeof makeInput>) => {
        const sealedSections = [...input.sealResult.sealedSections]
        ;[sealedSections[0], sealedSections[1]] = [sealedSections[1], sealedSections[0]]
        return sealedSections
      },
      (input: ReturnType<typeof makeInput>) => input.sealResult.sealedSections.map((section, index) =>
        index === 0
          ? { ...section, nonce: Buffer.from(input.plan[1]?.nonce ?? new Uint8Array(12)) }
          : section,
      ),
      (input: ReturnType<typeof makeInput>) => input.sealResult.sealedSections.map((section, index) =>
        index === 0 ? { ...section, plaintextSha256: 'c'.repeat(64) } : section,
      ),
    ]) {
      const input = makeInput()
      expectManifestError(
        () => buildRecoveryArchiveSealedSnapshotManifest({
          ...input,
          sealResult: { ...input.sealResult, sealedSections: mutate(input) },
        }),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
      )
    }
  })

  test('refuses blank crypto identities and binds valid key identities into root and MAC', () => {
    const blankWrapped = makeInput()
    blankWrapped.sealResult = {
      ...blankWrapped.sealResult,
      binding: { ...blankWrapped.sealResult.binding, wrappedDekId: ' ' },
      wrappedDekId: ' ',
    }
    for (const input of [
      { ...makeInput(), keyId: ' ' },
      blankWrapped,
    ]) {
      expectManifestError(
        () => buildRecoveryArchiveSealedSnapshotManifest(input),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING',
      )
    }

    const baseline = buildRecoveryArchiveSealedSnapshotManifest(makeInput())
    for (const crypto of [
      { keyId: 'kms-key-0002' },
      { wrappedDekId: 'wrapped-dek-0002' },
    ]) {
      const plan = makePlan()
      const input = {
        binding: BINDING,
        keyId: crypto.keyId ?? KEY_ID,
        plan,
        sealResult: makeSealResult(plan, BINDING, crypto),
      }
      const changed = buildRecoveryArchiveSealedSnapshotManifest(input)
      expect(changed.manifest.root_hash).not.toBe(baseline.manifest.root_hash)
      expect(changed.macPreimage).not.toEqual(baseline.macPreimage)
    }
  })

  test('refuses a manifest key identity that differs from the identity used for section AAD', () => {
    const keyMismatch = makeInput()
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({ ...keyMismatch, keyId: 'kms-key-0002' }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
    )

    const wrappedMismatch = makeInput()
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({
        ...wrappedMismatch,
        sealResult: { ...wrappedMismatch.sealResult, wrappedDekId: 'wrapped-dek-0002' },
      }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
    )
  })

  test('refuses manifest scope identity that differs from the section AAD binding', () => {
    for (const [field, value] of [
      ['archive_generation_id', 'generation-other'],
      ['workspace_id', 'workspace-other'],
      ['base_id', 'base-other'],
      ['sheet_id', 'sheet-other'],
      ['anchor_operation_id', 'operation-other'],
      ['anchor_seq', '9007199254740994'],
      ['checkpoint_id', 'checkpoint-other'],
    ] as const) {
      const input = makeInput()
      expectManifestError(
        () => buildRecoveryArchiveSealedSnapshotManifest({
          ...input,
          binding: { ...input.binding, [field]: value },
        }),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH',
      )
    }
  })

  test('normalizes hostile reflection and result shape failures without retaining values', () => {
    const hostile = new Proxy(makeInput(), {
      ownKeys() {
        throw new Error(SENTINEL)
      },
    })
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest(hostile),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT',
    )

    const forged = new RecoveryArchiveSealedSnapshotManifestError(
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT',
    )
    forged.message = SENTINEL
    forged.stack = SENTINEL
    const forgedErrorProxy = new Proxy(makeInput(), {
      ownKeys() {
        throw forged
      },
    })
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest(forgedErrorProxy),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT',
    )

    const malformed = makeInput()
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({ ...malformed, sealResult: { ...malformed.sealResult, sealedSections: [] } }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
    )
  })

  test('refuses a missing or empty wrapped-DEK carrier on the seal result', () => {
    const input = makeInput()
    const { wrappedDek: _dropped, ...withoutWrappedDek } = input.sealResult as Record<string, unknown>
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({ ...input, sealResult: withoutWrappedDek }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
    )
    expectManifestError(
      () => buildRecoveryArchiveSealedSnapshotManifest({
        ...input,
        sealResult: { ...input.sealResult, wrappedDek: new Uint8Array() },
      }),
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
    )
  })

  test('refuses unknown additive keys at each input boundary', () => {
    for (const [input, code] of [
      [{ ...makeInput(), injected: true }, 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT'],
      [
        (() => {
          const input = makeInput()
          return { ...input, binding: { ...input.binding, injected: true } }
        })(),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING',
      ],
      [
        (() => {
          const input = makeInput()
          return { ...input, sealResult: { ...input.sealResult, injected: true } }
        })(),
        'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
      ],
    ] as const) {
      expectManifestError(() => buildRecoveryArchiveSealedSnapshotManifest(input), code)
    }
  })

  test('binds root and MAC preimage to a changed source vector', () => {
    const first = buildRecoveryArchiveSealedSnapshotManifest(makeInput())
    const changedBinding = { ...BINDING, source_vector_hash: 'd'.repeat(64) }
    const plan = makePlan()
    const second = buildRecoveryArchiveSealedSnapshotManifest({
      binding: changedBinding,
      keyId: KEY_ID,
      plan,
      sealResult: makeSealResult(plan, changedBinding),
    })

    expect(second.manifest.root_hash).not.toBe(first.manifest.root_hash)
    expect(second.macPreimage).not.toEqual(first.macPreimage)
  })
})
