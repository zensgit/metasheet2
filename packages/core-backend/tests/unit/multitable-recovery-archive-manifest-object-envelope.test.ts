import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  authenticateRecoveryArchiveSealedSnapshotManifest,
} from '../../src/multitable/recovery-archive-authenticated-manifest'
import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from '../../src/multitable/recovery-archive-contract'
import {
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_KEY_BYTES,
  RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
  buildRecoveryArchiveManifestMacPreimage,
  createTransactionGuardedKeyCustody,
  openRecoveryArchiveSection,
  reserveThenSealRecoveryArchiveSections,
  scrubRecoveryArchiveDek,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveTransactionDepthProbe,
} from '../../src/multitable/recovery-archive-crypto'
import {
  canonicalizeRecoveryArchiveJson,
  canonicalizeRecoveryArchiveSectionRows,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifestBinding,
} from '../../src/multitable/recovery-archive-manifest'
import {
  buildRecoveryArchiveManifestObjectEnvelope,
  parseRecoveryArchiveManifestObjectEnvelope,
  RecoveryArchiveManifestObjectEnvelopeError,
  type RecoveryArchiveManifestObjectEnvelopeErrorCode,
  RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS,
  RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION,
} from '../../src/multitable/recovery-archive-manifest-object-envelope'
import { buildRecoveryArchiveSealedSnapshotManifest } from '../../src/multitable/recovery-archive-sealed-snapshot-manifest'
import { buildRecoveryArchiveSnapshotPlan } from '../../src/multitable/recovery-archive-snapshot-plan'

const SENTINEL = 'envelope-sensitive-sentinel'
const KEY_ID = 'kms-key-0001'
const WRAPPED_DEK_ID = 'wrapped-dek-0001'
const WRAPPED_DEK = Uint8Array.from({ length: 48 }, (_, index) => 200 - index)
const OTHER_WRAPPED_DEK = Uint8Array.from({ length: 48 }, (_, index) => 50 + index)
const DEK_FINGERPRINT_DOMAIN = 'metasheet.recovery-archive.dek-fingerprint.v1'
const WRAPPING_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
const WRAPPING_IV_BYTES = 12

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

function signedManifestJson(): string {
  const plan = makePlan()
  const unsigned = buildRecoveryArchiveSealedSnapshotManifest({
    binding: BINDING,
    keyId: KEY_ID,
    plan,
    sealResult: {
      binding: {
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
        dekFingerprint: 'a'.repeat(64),
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
      },
      dekFingerprint: 'a'.repeat(64),
      wrappedDekId: WRAPPED_DEK_ID,
      wrappedDek: new Uint8Array(WRAPPED_DEK),
      reservations: plan.map((section) => ({
        dekFingerprint: 'a'.repeat(64),
        nonceHex: Buffer.from(section.nonce).toString('hex'),
        generationId: BINDING.archive_generation_id,
        sectionName: section.sectionName,
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
        formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
      })),
      sealedSections: plan.map((section) => ({
        sectionName: section.sectionName,
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
        nonce: Buffer.from(section.nonce),
        ciphertext: Buffer.from('ciphertext'),
        authTag: Buffer.alloc(16, 1),
        plaintextSha256: section.plaintextSha256,
      })),
    },
  })
  return canonicalizeRecoveryArchiveJson(
    validateRecoveryArchiveManifest({
      ...unsigned.manifest,
      manifest_mac: '00aa',
    }),
  )
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function expectEnvelopeError(
  run: () => unknown,
  code: RecoveryArchiveManifestObjectEnvelopeErrorCode,
): void {
  expect(run).toThrow(RecoveryArchiveManifestObjectEnvelopeError)
  try {
    run()
  } catch (error) {
    expect(error).toMatchObject({
      name: 'RecoveryArchiveManifestObjectEnvelopeError',
      code,
      message: code,
    })
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
    expect(String(error)).not.toContain(SENTINEL)
    expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
    expect(String(error)).not.toContain(Buffer.from(WRAPPED_DEK).toString('base64'))
  }
}

function fingerprintOfDek(dek: Uint8Array): string {
  return createHmac('sha256', Buffer.from(dek))
    .update(DEK_FINGERPRINT_DOMAIN)
    .digest('hex')
}

function concatSectionObject(ciphertext: Uint8Array, authTag: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ciphertext.byteLength + authTag.byteLength)
  bytes.set(ciphertext, 0)
  bytes.set(authTag, ciphertext.byteLength)
  return bytes
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function depthProbe(depth: number): RecoveryArchiveTransactionDepthProbe {
  return { currentTransactionDepth: () => depth }
}

function createBoundCustody(options: {
  produceDek?: Uint8Array
  keyId?: string
  wrappedDekId?: string
  wrappingKey?: Uint8Array
  fingerprint?: (dek: Uint8Array) => string
} = {}): RecoveryArchiveKeyCustodyAdapter & {
  calls: string[]
} {
  const produceDek = options.produceDek === undefined
    ? undefined
    : new Uint8Array(options.produceDek)
  const keyId = options.keyId ?? KEY_ID
  const wrappedDekId = options.wrappedDekId ?? WRAPPED_DEK_ID
  const wrappingKey = new Uint8Array(options.wrappingKey ?? WRAPPING_KEY)
  const calls: string[] = []
  const fingerprint = options.fingerprint ?? fingerprintOfDek
  return {
    calls,
    async produceGenerationDek(request) {
      calls.push('produceGenerationDek')
      if (request.keyId !== keyId || produceDek === undefined) throw new Error(SENTINEL)
      const iv = randomBytes(WRAPPING_IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
      cipher.setAAD(wrappingAad(request.keyId, wrappedDekId, request.generationId))
      const ciphertext = Buffer.concat([
        cipher.update(produceDek),
        cipher.final(),
      ])
      const wrappedDek = Buffer.concat([iv, ciphertext, cipher.getAuthTag()])
      return {
        dek: Buffer.from(produceDek),
        wrappedDekId,
        wrappedDek,
      }
    },
    async unwrapGenerationDek(request) {
      calls.push('unwrapGenerationDek')
      if (request.keyId !== keyId) throw new Error(SENTINEL)
      const tagOffset = request.wrappedDek.byteLength - RECOVERY_ARCHIVE_AEAD_TAG_BYTES
      if (tagOffset <= WRAPPING_IV_BYTES) throw new Error(SENTINEL)
      const iv = request.wrappedDek.slice(0, WRAPPING_IV_BYTES)
      const ciphertext = request.wrappedDek.slice(WRAPPING_IV_BYTES, tagOffset)
      const authTag = request.wrappedDek.slice(tagOffset)
      const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
      decipher.setAAD(
        wrappingAad(request.keyId, request.wrappedDekId, request.generationId),
      )
      decipher.setAuthTag(authTag)
      const dek = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ])
      if (dek.byteLength !== RECOVERY_ARCHIVE_AEAD_KEY_BYTES) throw new Error(SENTINEL)
      return {
        dek,
        wrappedDekId: request.wrappedDekId,
        wrappedDek: new Uint8Array(request.wrappedDek),
      }
    },
    async deriveDekFingerprint(request) {
      calls.push('deriveDekFingerprint')
      return fingerprint(request.dek)
    },
    async macManifestRoot(request) {
      calls.push('macManifestRoot')
      return createHmac('sha256', `mac:${request.keyId}`)
        .update(request.preimage)
        .digest()
    },
    async verifyManifestRootMac(request) {
      calls.push('verifyManifestRootMac')
      const expected = createHmac('sha256', `mac:${request.keyId}`)
        .update(request.preimage)
        .digest()
      return Buffer.from(request.mac).equals(expected)
    },
  }
}

function wrappingAad(keyId: string, wrappedDekId: string, generationId: string): Uint8Array {
  return new TextEncoder().encode(
    canonicalizeRecoveryArchiveJson({ generationId, keyId, wrappedDekId }),
  )
}

type DurableArchive = {
  envelopeBytes: Uint8Array
  envelopeSha256: string
  sectionObjects: readonly Uint8Array[]
}

async function restartFromDurable(
  durable: DurableArchive,
  options: {
    keyCustody: RecoveryArchiveKeyCustodyAdapter
    transactionDepth: RecoveryArchiveTransactionDepthProbe
    envelopeBytes?: Uint8Array
    expectedEnvelopeSha256?: string
    unwrapKeyId?: string
    unwrapWrappedDekId?: string
    unwrapWrappedDek?: Uint8Array
  },
): Promise<{
  rowCounts: string[]
  plaintextSha256: string[]
}> {
  const envelopeBytes = options.envelopeBytes ?? durable.envelopeBytes
  const expectedSha256 =
    options.expectedEnvelopeSha256 ?? durable.envelopeSha256
  const actualSha256 = createHash('sha256').update(envelopeBytes).digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new RecoveryArchiveManifestObjectEnvelopeError(
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_NONCANONICAL',
    )
  }

  const envelope = parseRecoveryArchiveManifestObjectEnvelope(envelopeBytes)
  const manifest = envelope.manifest
  const first = manifest.sections[0]
  if (first === undefined) {
    throw new RecoveryArchiveManifestObjectEnvelopeError(
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    )
  }

  const custody = createTransactionGuardedKeyCustody(
    options.keyCustody,
    options.transactionDepth,
  )
  const macPreimage = buildRecoveryArchiveManifestMacPreimage({
    formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
    generationId: manifest.archive_generation_id,
    workspaceId: manifest.workspace_id,
    baseId: manifest.base_id,
    sheetId: manifest.sheet_id,
    anchorOperationId: manifest.anchor_operation_id,
    anchorSeq: manifest.anchor_seq,
    checkpointId: manifest.checkpoint_id,
    keyId: first.key_id,
    wrappedDekId: first.wrapped_dek_id,
    dekFingerprint: first.dek_fingerprint,
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    rootHash: manifest.root_hash,
    createdAt: manifest.created_at,
    expiresAt: manifest.expires_at,
    sourceVectorHash: manifest.source_vector_hash,
  })
  const verified = await custody.verifyManifestRootMac({
    keyId: first.key_id,
    preimage: macPreimage,
    mac: Buffer.from(manifest.manifest_mac ?? '', 'hex'),
  })
  if (verified !== true) {
    throw new RecoveryArchiveManifestObjectEnvelopeError(
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    )
  }

  const unwrapped = await custody.unwrapGenerationDek({
    keyId: options.unwrapKeyId ?? first.key_id,
    generationId: manifest.archive_generation_id,
    wrappedDekId: options.unwrapWrappedDekId ?? first.wrapped_dek_id,
    wrappedDek: options.unwrapWrappedDek ?? envelope.wrappedDek,
  })
  try {
    const dekFingerprint = await custody.deriveDekFingerprint({
      keyId: first.key_id,
      dek: unwrapped.dek,
    })
    if (dekFingerprint !== first.dek_fingerprint) {
      throw new RecoveryArchiveManifestObjectEnvelopeError(
        'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
      )
    }

    const rowCounts: string[] = []
    const plaintextSha256: string[] = []
    for (const [index, descriptor] of manifest.sections.entries()) {
      const objectBytes = durable.sectionObjects[index]
      if (objectBytes === undefined) {
        throw new RecoveryArchiveManifestObjectEnvelopeError(
          'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
        )
      }
      const authTag = objectBytes.slice(
        objectBytes.byteLength - RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
      )
      const ciphertext = objectBytes.slice(
        0,
        objectBytes.byteLength - RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
      )
      const plaintext = openRecoveryArchiveSection({
        binding: {
          formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
          generationId: manifest.archive_generation_id,
          workspaceId: manifest.workspace_id,
          baseId: manifest.base_id,
          sheetId: manifest.sheet_id,
          anchorOperationId: manifest.anchor_operation_id,
          anchorSeq: manifest.anchor_seq,
          checkpointId: manifest.checkpoint_id,
          keyId: descriptor.key_id,
          wrappedDekId: descriptor.wrapped_dek_id,
          dekFingerprint: descriptor.dek_fingerprint,
          aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
          sectionName: descriptor.name,
          plaintextSha256: descriptor.plaintext_sha256,
        },
        dek: unwrapped.dek,
        nonce: hexToBytes(descriptor.nonce),
        ciphertext,
        authTag,
      })
      const canonical = canonicalizeRecoveryArchiveSectionRows(
        descriptor.name,
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
      )
      if (
        canonical.rowCount !== descriptor.row_count ||
        canonical.plaintextSha256 !== descriptor.plaintext_sha256
      ) {
        throw new RecoveryArchiveManifestObjectEnvelopeError(
          'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
        )
      }
      rowCounts.push(canonical.rowCount)
      plaintextSha256.push(canonical.plaintextSha256)
    }
    return { rowCounts, plaintextSha256 }
  } finally {
    scrubRecoveryArchiveDek(unwrapped.dek)
  }
}

async function buildDurableArchive(
  custody: RecoveryArchiveKeyCustodyAdapter,
): Promise<DurableArchive & { fingerprint: string }> {
  const plan = makePlan()
  const sealResult = await reserveThenSealRecoveryArchiveSections({
    binding: {
      formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
      generationId: BINDING.archive_generation_id,
      workspaceId: BINDING.workspace_id,
      baseId: BINDING.base_id,
      sheetId: BINDING.sheet_id,
      anchorOperationId: BINDING.anchor_operation_id,
      anchorSeq: BINDING.anchor_seq,
      checkpointId: BINDING.checkpoint_id,
      keyId: KEY_ID,
      aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    },
    keyCustody: custody,
    transactionDepth: depthProbe(0),
    dekSource: { kind: 'produce' },
    sections: plan.map((section) => ({
      sectionName: section.sectionName,
      plaintext: section.plaintext,
      nonce: section.nonce,
    })),
    reserveNonces: async () => {},
  })
  const unsigned = buildRecoveryArchiveSealedSnapshotManifest({
    binding: BINDING,
    keyId: KEY_ID,
    plan,
    sealResult,
  })
  const authenticated = await authenticateRecoveryArchiveSealedSnapshotManifest({
    sealedManifest: unsigned,
    keyCustody: custody,
    transactionDepth: depthProbe(0),
  })
  return {
    envelopeBytes: authenticated.envelopeBytes,
    envelopeSha256: authenticated.envelopeSha256,
    sectionObjects: authenticated.sealedSections.map((section) =>
      concatSectionObject(section.ciphertext, section.authTag),
    ),
    fingerprint: sealResult.dekFingerprint,
  }
}

describe('recovery-archive manifest-object envelope v1', () => {
  test('the JSON field set is exact, closed, and already JCS-sorted', () => {
    expect([...RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS]).toEqual([
      'envelope_version',
      'manifest_json',
      'wrapped_dek',
    ])
    expect([...RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS]).toEqual(
      [...RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS].sort(),
    )
    expect(RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION).toBe(1)
  })

  test('build/parse round-trips with defensive copies and a stable descriptor sha256', () => {
    const manifestJson = signedManifestJson()
    const built = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson,
      wrappedDek: WRAPPED_DEK,
    })
    expect(built.envelopeVersion).toBe(1)
    expect(built.manifestJson).toBe(manifestJson)
    expect(built.manifest.manifest_mac).toBe('00aa')
    expect(built.manifest).not.toHaveProperty('wrapped_dek')
    expect(JSON.parse(built.manifestJson)).not.toHaveProperty('wrapped_dek')
    expect(built.wrappedDek).toEqual(WRAPPED_DEK)
    expect(built.envelopeSha256).toBe(
      createHash('sha256').update(built.envelopeBytes).digest('hex'),
    )
    expect(built.envelopeSha256).toMatch(/^[0-9a-f]{64}$/)

    const parsed = parseRecoveryArchiveManifestObjectEnvelope(built.envelopeBytes)
    expect(parsed.manifestJson).toBe(built.manifestJson)
    expect(parsed.manifest).toEqual(built.manifest)
    expect(parsed.wrappedDek).toEqual(WRAPPED_DEK)
    expect(parsed.envelopeSha256).toBe(built.envelopeSha256)
    expect(parsed.envelopeBytes).toEqual(built.envelopeBytes)

    const firstWrap = parsed.wrappedDek
    const firstBytes = parsed.envelopeBytes
    firstWrap.fill(0)
    firstBytes.fill(0)
    expect(parsed.wrappedDek).toEqual(WRAPPED_DEK)
    expect(parsed.envelopeBytes).toEqual(built.envelopeBytes)

    const rebuilt = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson,
      wrappedDek: new Uint8Array(WRAPPED_DEK),
    })
    expect(rebuilt.envelopeSha256).toBe(built.envelopeSha256)
  })

  test('build admits a wrappedDek getter and snapshots the bytes', () => {
    const source = new Uint8Array(WRAPPED_DEK)
    const input = {
      manifestJson: signedManifestJson(),
    } as { manifestJson: string; wrappedDek?: Uint8Array }
    Object.defineProperty(input, 'wrappedDek', {
      enumerable: true,
      get() {
        return source
      },
    })
    const built = buildRecoveryArchiveManifestObjectEnvelope(input)
    source.fill(0)
    expect(built.wrappedDek).toEqual(WRAPPED_DEK)
  })

  test('rejects extra, missing, accessor, sparse, unsigned, and noncanonical forms', () => {
    const manifestJson = signedManifestJson()
    const built = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson,
      wrappedDek: WRAPPED_DEK,
    })
    const decoded = JSON.parse(new TextDecoder().decode(built.envelopeBytes)) as {
      envelope_version: number
      manifest_json: string
      wrapped_dek: string
    }

    expectEnvelopeError(
      () =>
        buildRecoveryArchiveManifestObjectEnvelope({
          manifestJson,
          wrappedDek: WRAPPED_DEK,
          injected: SENTINEL,
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
    )
    expectEnvelopeError(
      () => buildRecoveryArchiveManifestObjectEnvelope({ manifestJson }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
    )
    expectEnvelopeError(
      () =>
        buildRecoveryArchiveManifestObjectEnvelope({
          manifestJson,
          wrappedDek: new Uint8Array(),
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK',
    )

    let accessorRan = false
    const accessorInput: Record<string, unknown> = { wrappedDek: WRAPPED_DEK }
    Object.defineProperty(accessorInput, 'manifestJson', {
      enumerable: true,
      get() {
        accessorRan = true
        throw new Error(SENTINEL)
      },
    })
    expectEnvelopeError(
      () => buildRecoveryArchiveManifestObjectEnvelope(accessorInput),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
    )
    expect(accessorRan).toBe(false)

    const sparse = [] as unknown as { manifestJson: string; wrappedDek: Uint8Array }
    sparse[0] = manifestJson
    expectEnvelopeError(
      () => buildRecoveryArchiveManifestObjectEnvelope(sparse),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
    )

    const unsigned = JSON.parse(manifestJson) as Record<string, unknown>
    unsigned.manifest_mac = null
    expectEnvelopeError(
      () =>
        buildRecoveryArchiveManifestObjectEnvelope({
          manifestJson: canonicalizeRecoveryArchiveJson(unsigned),
          wrappedDek: WRAPPED_DEK,
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    )

    expectEnvelopeError(
      () =>
        buildRecoveryArchiveManifestObjectEnvelope({
          manifestJson: `${manifestJson} `,
          wrappedDek: WRAPPED_DEK,
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    )

    const reordered = encodeUtf8(
      JSON.stringify({
        wrapped_dek: decoded.wrapped_dek,
        envelope_version: decoded.envelope_version,
        manifest_json: decoded.manifest_json,
      }),
    )
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(reordered),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_NONCANONICAL',
    )

    const extra = encodeUtf8(
      JSON.stringify({ ...decoded, injected: SENTINEL }),
    )
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(extra),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
    )

    const { wrapped_dek: _dropped, ...missing } = decoded
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(encodeUtf8(JSON.stringify(missing))),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
    )

    const wrongVersion = encodeUtf8(
      canonicalizeRecoveryArchiveJson({ ...decoded, envelope_version: 2 }),
    )
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(wrongVersion),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
    )

    expectEnvelopeError(
      () =>
        parseRecoveryArchiveManifestObjectEnvelope(
          encodeUtf8(
            canonicalizeRecoveryArchiveJson({
              ...decoded,
              wrapped_dek: `${decoded.wrapped_dek} `,
            }),
          ),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK',
    )

    const urlSafe = decoded.wrapped_dek.replace(/\+/g, '-').replace(/\//g, '_')
    expect(urlSafe).not.toBe(decoded.wrapped_dek)
    expectEnvelopeError(
      () =>
        parseRecoveryArchiveManifestObjectEnvelope(
          encodeUtf8(
            canonicalizeRecoveryArchiveJson({
              ...decoded,
              wrapped_dek: urlSafe,
            }),
          ),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK',
    )

    const tampered = new Uint8Array(built.envelopeBytes)
    tampered[0] ^= 1
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(tampered),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
    )

    const other = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson,
      wrappedDek: OTHER_WRAPPED_DEK,
    })
    expect(other.envelopeSha256).not.toBe(built.envelopeSha256)
    expect(other.wrappedDek).toEqual(OTHER_WRAPPED_DEK)
  })
})

describe('recovery-archive envelope restart round-trip', () => {
  test('preserves only envelope bytes plus ten section objects and reopens every section', async () => {
    const durable = await buildDurableArchive(
      createBoundCustody({
        produceDek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      }),
    )
    const custody = createBoundCustody()
    const fingerprint = durable.fingerprint
    const envelopeBytes = new Uint8Array(durable.envelopeBytes)
    const envelopeSha256 = durable.envelopeSha256
    const sectionObjects = durable.sectionObjects.map((bytes) => new Uint8Array(bytes))

    durable.envelopeBytes.fill(0)
    for (const objectBytes of durable.sectionObjects) objectBytes.fill(0)

    const restarted = await restartFromDurable(
      { envelopeBytes, envelopeSha256, sectionObjects },
      { keyCustody: custody, transactionDepth: depthProbe(0) },
    )

    expect(custody.calls).toContain('verifyManifestRootMac')
    expect(custody.calls).toContain('unwrapGenerationDek')
    expect(custody.calls).toContain('deriveDekFingerprint')
    expect(restarted.rowCounts).toEqual([
      '1',
      '1',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
    ])
    expect(restarted.plaintextSha256).toHaveLength(10)
    const parsed = parseRecoveryArchiveManifestObjectEnvelope(envelopeBytes)
    expect(parsed.manifest.sections.map((section) => section.plaintext_sha256)).toEqual(
      restarted.plaintextSha256,
    )
    expect(parsed.manifest.sections[0]?.dek_fingerprint).toBe(fingerprint)
    expect(parsed.manifest).not.toHaveProperty('wrapped_dek')
  })

  test('swapped or empty wrapped blobs, altered envelope hash, wrong key/id/fingerprint, and in-transaction KMS fail before trusted rows', async () => {
    const durable = await buildDurableArchive(
      createBoundCustody({
        produceDek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      }),
    )
    const custody = createBoundCustody()
    const baselineCalls = custody.calls.length
    const trusted: string[][] = []

    const recordFailure = async (
      run: () => Promise<unknown>,
      expected:
        | RecoveryArchiveManifestObjectEnvelopeErrorCode
        | 'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED'
        | 'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION'
        | 'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID'
        | 'RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT',
    ) => {
      try {
        const opened = await run()
        trusted.push((opened as { rowCounts: string[] }).rowCounts)
        throw new Error('expected-refusal')
      } catch (error) {
        expect((error as { message?: string }).message).toBe(expected)
        expect(String(error)).not.toContain(SENTINEL)
        expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
        expect(String(error)).not.toContain(
          Buffer.from(durable.envelopeBytes).toString('base64'),
        )
      }
    }

    const swapped = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson: parseRecoveryArchiveManifestObjectEnvelope(durable.envelopeBytes)
        .manifestJson,
      wrappedDek: OTHER_WRAPPED_DEK,
    })
    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          envelopeBytes: swapped.envelopeBytes,
          expectedEnvelopeSha256: swapped.envelopeSha256,
        }),
      'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED',
    )
    expect(custody.calls.slice(baselineCalls)).toEqual([
      'verifyManifestRootMac',
      'unwrapGenerationDek',
    ])

    const emptyWrapJson = canonicalizeRecoveryArchiveJson({
      envelope_version: 1,
      manifest_json: parseRecoveryArchiveManifestObjectEnvelope(durable.envelopeBytes)
        .manifestJson,
      wrapped_dek: '',
    })
    expectEnvelopeError(
      () => parseRecoveryArchiveManifestObjectEnvelope(encodeUtf8(emptyWrapJson)),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK',
    )

    const callsBeforeAltered = custody.calls.length
    const altered = new Uint8Array(swapped.envelopeBytes)
    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          envelopeBytes: altered,
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_NONCANONICAL',
    )
    expect(custody.calls.length).toBe(callsBeforeAltered)

    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          unwrapKeyId: 'kms-key-other',
        }),
      'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED',
    )

    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          unwrapWrappedDekId: 'wrapped-dek-other',
        }),
      'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED',
    )

    const fingerprintMismatchCustody: RecoveryArchiveKeyCustodyAdapter = {
      ...custody,
      async deriveDekFingerprint() {
        custody.calls.push('deriveDekFingerprint')
        return 'c'.repeat(64)
      },
    }
    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: fingerprintMismatchCustody,
          transactionDepth: depthProbe(0),
        }),
      'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    )

    const depthCallsBefore = custody.calls.length
    await recordFailure(
      () =>
        restartFromDurable(durable, {
          keyCustody: custody,
          transactionDepth: depthProbe(1),
        }),
      'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION',
    )
    expect(custody.calls.slice(depthCallsBefore)).toEqual([])
    expect(trusted).toEqual([])
  })
})
