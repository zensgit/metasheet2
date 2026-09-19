import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { authenticateRecoveryArchiveSealedSnapshotManifest } from '../../src/multitable/recovery-archive-authenticated-manifest'
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
  recoveryArchivePlaintextSha256,
  reserveThenSealRecoveryArchiveSections,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveTransactionDepthProbe,
} from '../../src/multitable/recovery-archive-crypto'
import {
  canonicalizeRecoveryArchiveJson,
  computeRecoveryArchiveManifestRootHash,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifest,
  type RecoveryArchiveManifestBinding,
} from '../../src/multitable/recovery-archive-manifest'
import {
  buildRecoveryArchiveManifestObjectEnvelope,
  parseRecoveryArchiveManifestObjectEnvelope,
} from '../../src/multitable/recovery-archive-manifest-object-envelope'
import {
  createLocalRecoveryArchiveObjectStoreProvider,
  type RecoveryArchiveObjectExpectedBinding,
  type RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import {
  RecoveryArchiveReaderError,
  readRecoveryArchiveCompleteSectionState,
  readRecoveryArchiveCompleteSectionsInternal,
  readRecoveryArchiveAttachmentBytes,
  readRecoveryArchiveAttachmentSource,
  type RecoveryArchiveReaderErrorCode,
  type RecoveryArchiveSelectedBinding,
} from '../../src/multitable/recovery-archive-reader'
import { buildRecoveryArchiveSealedSnapshotManifest } from '../../src/multitable/recovery-archive-sealed-snapshot-manifest'
import { buildRecoveryArchiveSnapshotPlan } from '../../src/multitable/recovery-archive-snapshot-plan'
import { createLocalCustodyBackup, createLocalCustodySession, type LocalArchiveCustodyAdmission } from '../../src/multitable/recovery-local-custody'
import { createLocalCustodyStore } from '../../src/multitable/recovery-local-custody-store'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { stageRecoveryArchiveAttachment } from '../../src/multitable/recovery-archive-attachment-stage'
import { StorageServiceImpl } from '../../src/services/StorageService'

const SENTINEL = 'reader-sensitive-sentinel'
const KEY_ID = 'kms-key-0001'
const WRAPPED_DEK_ID = 'wrapped-dek-0001'
const WRAPPING_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
const WRAPPING_IV_BYTES = 12
const DEK_FINGERPRINT_DOMAIN = 'metasheet.recovery-archive.dek-fingerprint.v1'
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const ANCHOR_SEQ = '9007199254740993'
const SOURCE_VECTOR_HASH = 'b'.repeat(64)

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function fingerprintOfDek(dek: Uint8Array): string {
  return createHmac('sha256', Buffer.from(dek))
    .update(DEK_FINGERPRINT_DOMAIN)
    .digest('hex')
}

function wrappingAad(keyId: string, wrappedDekId: string, generationId: string): Uint8Array {
  return new TextEncoder().encode(
    canonicalizeRecoveryArchiveJson({ generationId, keyId, wrappedDekId }),
  )
}

function concatSectionObject(ciphertext: Uint8Array, authTag: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ciphertext.byteLength + authTag.byteLength)
  bytes.set(ciphertext, 0)
  bytes.set(authTag, ciphertext.byteLength)
  return bytes
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function objectId(generationId: string, slot: string): string {
  return createHash('sha256').update(`d4:${generationId}:${slot}`).digest('hex')
}

function depthProbe(depth: number): RecoveryArchiveTransactionDepthProbe {
  return { currentTransactionDepth: () => depth }
}

function createBoundCustody(options: {
  produceDek?: Uint8Array
  keyId?: string
  wrappingKey?: Uint8Array
  fingerprint?: (dek: Uint8Array) => string
  verify?: () => Promise<boolean>
} = {}): RecoveryArchiveKeyCustodyAdapter & { calls: string[] } {
  const produceDek = options.produceDek === undefined ? undefined : new Uint8Array(options.produceDek)
  const keyId = options.keyId ?? KEY_ID
  const wrappingKey = new Uint8Array(options.wrappingKey ?? WRAPPING_KEY)
  const fingerprint = options.fingerprint ?? fingerprintOfDek
  const calls: string[] = []
  return {
    calls,
    async produceGenerationDek(request) {
      calls.push('produceGenerationDek')
      if (request.keyId !== keyId || produceDek === undefined) throw new Error(SENTINEL)
      const iv = randomBytes(WRAPPING_IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
      cipher.setAAD(wrappingAad(request.keyId, WRAPPED_DEK_ID, request.generationId))
      const ciphertext = Buffer.concat([cipher.update(produceDek), cipher.final()])
      return {
        dek: Buffer.from(produceDek),
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]),
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
      decipher.setAAD(wrappingAad(request.keyId, request.wrappedDekId, request.generationId))
      decipher.setAuthTag(authTag)
      const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dek.byteLength !== RECOVERY_ARCHIVE_AEAD_KEY_BYTES) throw new Error(SENTINEL)
      return { dek, wrappedDekId: request.wrappedDekId, wrappedDek: new Uint8Array(request.wrappedDek) }
    },
    async deriveDekFingerprint(request) {
      calls.push('deriveDekFingerprint')
      return fingerprint(request.dek)
    },
    async macManifestRoot(request) {
      calls.push('macManifestRoot')
      return createHmac('sha256', `mac:${request.keyId}`).update(request.preimage).digest()
    },
    async verifyManifestRootMac(request) {
      calls.push('verifyManifestRootMac')
      if (options.verify) return options.verify()
      const expected = createHmac('sha256', `mac:${request.keyId}`).update(request.preimage).digest()
      return Buffer.from(request.mac).equals(expected)
    },
  }
}

function makeBinding(generationId: string): RecoveryArchiveManifestBinding {
  return {
    archive_generation_id: generationId,
    workspace_id: 'workspace-0001',
    base_id: 'base-0001',
    sheet_id: 'sheet-0001',
    anchor_operation_id: 'operation-0001',
    anchor_seq: ANCHOR_SEQ,
    checkpoint_id: 'checkpoint-0001',
    created_at: '2026-08-28T00:00:00.000Z',
    expires_at: '2026-09-28T00:00:00.000Z',
    source_vector_hash: SOURCE_VECTOR_HASH,
  }
}

type FixtureAttachment = { id: string; bytes: Buffer; deleted: boolean; recordId?: string; fieldId?: string }
function makePlan(attachments: FixtureAttachment[] = []) {
  const nonces = Object.fromEntries(
    RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name, index) => [
      name,
      Uint8Array.from({ length: 12 }, (_, byteIndex) => index * 12 + byteIndex),
    ]),
  ) as Record<RecoveryArchiveSectionName, Uint8Array>
  return buildRecoveryArchiveSnapshotPlan({
    sectionRows: {
      schema: [{ field_id: 'field-1', name: 'Name', type: 'text', property: {}, order: 1 }],
      records: [
        { record_id: 'record-1', exists: true, version: 1, data: { text: 'value' } },
        { record_id: 'record-2', exists: false, version: 2, data: null },
      ],
      links: [],
      field_value_tombstones: [],
      link_tombstones: [],
      auto_number: [],
      attachments_index: attachments.map((item) => ({ attachment_id: item.id, record_id: item.recordId ?? null, field_id: item.fieldId ?? null,
        immutable_object_version: `sha256:${digest(item.bytes)}`, plaintext_sha256: digest(item.bytes),
        size_bytes: String(item.bytes.length), media_type: 'application/octet-stream', deleted: item.deleted })),
      permission_evidence: [],
      views_config: [],
    },
    coverageCandidates: [],
    nonces,
  })
}

type DurableArchive = {
  generationId: string
  binding: RecoveryArchiveManifestBinding
  envelopeBytes: Uint8Array
  envelopeSha256: string
  sectionObjects: readonly Uint8Array[]
  manifest: RecoveryArchiveManifest
  attachmentObjects?: { attachmentId: string; bytes: Uint8Array }[]
}

async function buildDurableArchive(options: {
  custody?: RecoveryArchiveKeyCustodyAdapter
  local?: LocalArchiveCustodyAdmission
  mutateManifest?: (manifest: RecoveryArchiveManifest) => RecoveryArchiveManifest
  tamperSignedManifest?: (manifest: RecoveryArchiveManifest) => RecoveryArchiveManifest
  replaceRecordsPlaintext?: Uint8Array
  attachments?: FixtureAttachment[]
} = {}): Promise<DurableArchive> {
  const generationId = randomUUID()
  const binding = makeBinding(generationId)
  const produceCustody = options.local ?? createBoundCustody({ produceDek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES) })
  const keyId = options.local?.keyId ?? KEY_ID
  const plan = makePlan(options.attachments)
  const sections = plan.map((section) => {
    if (options.replaceRecordsPlaintext && section.sectionName === 'records') {
      return {
        sectionName: section.sectionName,
        plaintext: options.replaceRecordsPlaintext,
        nonce: section.nonce,
      }
    }
    return {
      sectionName: section.sectionName,
      plaintext: section.plaintext,
      nonce: section.nonce,
    }
  })
  const sealResult = await reserveThenSealRecoveryArchiveSections({
    binding: {
      formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
      generationId,
      workspaceId: binding.workspace_id,
      baseId: binding.base_id,
      sheetId: binding.sheet_id,
      anchorOperationId: binding.anchor_operation_id,
      anchorSeq: binding.anchor_seq,
      checkpointId: binding.checkpoint_id,
      keyId,
      aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    },
    keyCustody: produceCustody,
    transactionDepth: depthProbe(0),
    dekSource: { kind: 'produce' },
    sections,
    attachments: options.attachments?.map((item) => ({ attachmentId: item.id,
      sourceVersion: `sha256:${digest(item.bytes)}`, plaintext: item.bytes, nonce: randomBytes(12) })),
    reserveNonces: async () => {},
  })

  let envelopeBytes: Uint8Array
  let envelopeSha256: string
  let manifest: RecoveryArchiveManifest
  let sectionObjects: Uint8Array[]

  if (options.replaceRecordsPlaintext || options.mutateManifest) {
    const unsigned = options.replaceRecordsPlaintext
      ? null
      : buildRecoveryArchiveSealedSnapshotManifest({
          binding,
          keyId,
          plan,
          sealResult,
        })
    let unsignedManifest: RecoveryArchiveManifest
    if (unsigned) {
      unsignedManifest = unsigned.manifest
      sectionObjects = unsigned.sealedSections.map((section) =>
        concatSectionObject(section.ciphertext, section.authTag),
      )
    } else {
      const descriptors = plan.map((section, index) => {
        const sealed = sealResult.sealedSections[index]
        if (sealed === undefined) throw new Error('missing-sealed-section')
        const plaintext =
          section.sectionName === 'records' && options.replaceRecordsPlaintext
            ? options.replaceRecordsPlaintext
            : section.plaintext
        return {
          name: section.sectionName,
          row_count: section.sectionName === 'records' ? '1' : section.rowCount,
          plaintext_sha256: recoveryArchivePlaintextSha256(plaintext),
          aead_algorithm: RECOVERY_ARCHIVE_V1_AEAD_ALGORITHM_VALUE,
          key_id: keyId,
          wrapped_dek_id: sealResult.wrappedDekId,
          dek_fingerprint: sealResult.dekFingerprint,
          nonce: Buffer.from(section.nonce).toString('hex'),
        }
      })
      const body = {
        format_version: RECOVERY_ARCHIVE_FORMAT_VERSION,
        ...binding,
        sections: descriptors,
      }
      unsignedManifest = {
        ...body,
        root_hash: computeRecoveryArchiveManifestRootHash(body),
        manifest_mac: null,
      }
      sectionObjects = sealResult.sealedSections.map((section) =>
        concatSectionObject(section.ciphertext, section.authTag),
      )
    }
    const mutated = options.mutateManifest
      ? options.mutateManifest({ ...unsignedManifest, manifest_mac: null })
      : unsignedManifest
    const macCustody = options.custody ?? createBoundCustody()
    const first = mutated.sections[0]
    if (first === undefined) throw new Error('missing-section')
    const mac = await macCustody.macManifestRoot({
      keyId: first.key_id,
      preimage: buildRecoveryArchiveManifestMacPreimage({
        formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
        generationId: mutated.archive_generation_id,
        workspaceId: mutated.workspace_id,
        baseId: mutated.base_id,
        sheetId: mutated.sheet_id,
        anchorOperationId: mutated.anchor_operation_id,
        anchorSeq: mutated.anchor_seq,
        checkpointId: mutated.checkpoint_id,
        keyId: first.key_id,
        wrappedDekId: first.wrapped_dek_id,
        dekFingerprint: first.dek_fingerprint,
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
        rootHash: mutated.root_hash,
        createdAt: mutated.created_at,
        expiresAt: mutated.expires_at,
        sourceVectorHash: mutated.source_vector_hash,
      }),
    })
    const signed = validateRecoveryArchiveManifest({
      ...mutated,
      manifest_mac: Buffer.from(mac).toString('hex'),
    })
    const envelope = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson: canonicalizeRecoveryArchiveJson(signed),
      wrappedDek: sealResult.wrappedDek,
    })
    envelopeBytes = envelope.envelopeBytes
    envelopeSha256 = envelope.envelopeSha256
    manifest = envelope.manifest
  } else {
    const unsigned = buildRecoveryArchiveSealedSnapshotManifest({
      binding,
      keyId,
      plan,
      sealResult,
    })
    const authenticated = await authenticateRecoveryArchiveSealedSnapshotManifest({
      sealedManifest: unsigned,
      keyCustody: options.local ?? options.custody ?? createBoundCustody(),
      transactionDepth: depthProbe(0),
    })
    envelopeBytes = authenticated.envelopeBytes
    envelopeSha256 = authenticated.envelopeSha256
    manifest = authenticated.manifest
    sectionObjects = authenticated.sealedSections.map((section) =>
      concatSectionObject(section.ciphertext, section.authTag),
    )
  }

  if (options.tamperSignedManifest) {
    const parsed = parseRecoveryArchiveManifestObjectEnvelope(envelopeBytes)
    const tampered = validateRecoveryArchiveManifest(options.tamperSignedManifest(manifest))
    const envelope = buildRecoveryArchiveManifestObjectEnvelope({
      manifestJson: canonicalizeRecoveryArchiveJson(tampered),
      wrappedDek: parsed.wrappedDek,
    })
    envelopeBytes = envelope.envelopeBytes
    envelopeSha256 = envelope.envelopeSha256
    manifest = envelope.manifest
  }

  return { generationId, binding, envelopeBytes, envelopeSha256, sectionObjects, manifest,
    ...(sealResult.sealedAttachments?.length ? { attachmentObjects: sealResult.sealedAttachments.map((item) => ({
      attachmentId: item.attachmentId, bytes: Buffer.concat([item.nonce, item.ciphertext, item.authTag]),
    })) } : {}) }
}

const RECOVERY_ARCHIVE_V1_AEAD_ALGORITHM_VALUE = 'aes-256-gcm' as const

async function persistDurable(
  durable: DurableArchive,
  replacements: { envelopeBytes?: Uint8Array; sectionObjects?: readonly Uint8Array[]; objectStore?: RecoveryArchiveObjectStoreProvider } = {},
): Promise<{
  objectStore: RecoveryArchiveObjectStoreProvider
  selectedBinding: RecoveryArchiveSelectedBinding
  manifestObject: RecoveryArchiveObjectExpectedBinding
  sectionObjects: RecoveryArchiveObjectExpectedBinding[]
  attachmentObjects?: { attachmentId: string; binding: RecoveryArchiveObjectExpectedBinding }[]
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d4-reader-'))
  temporaryRoots.push(root)
  const objectStore = replacements.objectStore ?? createLocalRecoveryArchiveObjectStoreProvider({
    environment: 'test',
    basePath: root,
  })
  const envelopeBytes = replacements.envelopeBytes ?? durable.envelopeBytes
  const sectionBytes = replacements.sectionObjects ?? durable.sectionObjects
  const manifestPut = await objectStore.put({
    generationId: durable.generationId,
    objectId: objectId(durable.generationId, 'manifest'),
    version: '1',
    sha256: digest(envelopeBytes),
    size: String(envelopeBytes.byteLength),
    expiresAt: EXPIRES_AT,
    pinned: true,
    bytes: envelopeBytes,
  })
  const sectionObjects: RecoveryArchiveObjectExpectedBinding[] = []
  for (const [index, name] of RECOVERY_ARCHIVE_V1_SECTION_NAMES.entries()) {
    const bytes = sectionBytes[index]
    if (bytes === undefined) throw new Error('missing-section-bytes')
    const put = await objectStore.put({
      generationId: durable.generationId,
      objectId: objectId(durable.generationId, `section:${name}`),
      version: '1',
      sha256: digest(bytes),
      size: String(bytes.byteLength),
      expiresAt: EXPIRES_AT,
      pinned: true,
      bytes,
    })
    sectionObjects.push({
      generationId: put.object.generationId,
      objectId: put.object.objectId,
      expectedVersion: put.object.version,
      expectedSha256: put.object.sha256,
      expectedSize: put.object.size,
      expectedExpiresAt: put.object.expiresAt,
    })
  }
  const attachmentObjects = []
  for (const item of durable.attachmentObjects ?? []) {
    const put = await objectStore.put({ generationId: durable.generationId,
      objectId: objectId(durable.generationId, `attachment:${item.attachmentId}`), version: '1',
      sha256: digest(item.bytes), size: String(item.bytes.length), expiresAt: durable.manifest.expires_at,
      pinned: true, bytes: item.bytes })
    attachmentObjects.push({ attachmentId: item.attachmentId, binding: {
      generationId: put.object.generationId, objectId: put.object.objectId,
      expectedVersion: put.object.version, expectedSha256: put.object.sha256,
      expectedSize: put.object.size, expectedExpiresAt: put.object.expiresAt,
    } })
  }
  return {
    objectStore,
    ...(attachmentObjects.length ? { attachmentObjects } : {}),
    selectedBinding: {
      generationId: durable.binding.archive_generation_id,
      workspaceId: durable.binding.workspace_id,
      baseId: durable.binding.base_id,
      sheetId: durable.binding.sheet_id,
      anchorOperationId: durable.binding.anchor_operation_id,
      anchorSeq: durable.binding.anchor_seq,
      checkpointId: durable.binding.checkpoint_id,
      rootHash: durable.manifest.root_hash,
      sourceVectorHash: durable.binding.source_vector_hash,
    },
    manifestObject: {
      generationId: manifestPut.object.generationId,
      objectId: manifestPut.object.objectId,
      expectedVersion: manifestPut.object.version,
      expectedSha256: manifestPut.object.sha256,
      expectedSize: manifestPut.object.size,
      expectedExpiresAt: manifestPut.object.expiresAt,
    },
    sectionObjects,
  }
}

function expectReaderError(error: unknown, code: RecoveryArchiveReaderErrorCode): void {
  expect(error).toBeInstanceOf(RecoveryArchiveReaderError)
  expect(error).toMatchObject({ name: 'RecoveryArchiveReaderError', code, message: code })
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  expect(String(error)).not.toContain(SENTINEL)
  expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
}

describe('recovery-archive D4 complete-section reader', () => {
  test.each(['success', 'crash-retry', 'verified-retry', 'collision', 'denied', 'transaction', 'receipt-failure', 'false-readback', 'mutating-upload'] as const)(
    'stages authenticated attachment bytes with owned identity: %s', async (mode) => {
      const binary = Buffer.from([0, 255, 128, 1])
      const durable = await buildDurableArchive({ attachments: [
        { id: 'att-original', bytes: binary, deleted: false, recordId: 'record-1', fieldId: 'attachment' },
      ] })
      const stored = await persistDurable(durable)
      const state = await readRecoveryArchiveCompleteSectionState({ ...stored,
        keyCustody: createBoundCustody(), transactionDepth: depthProbe(0),
        query: async (sql: string) => {
          if (sql.includes('meta_history_trust_checkpoints')) return { rows: [{
            id: durable.binding.checkpoint_id, sheet_id: durable.binding.sheet_id,
            state: 'active', trusted_since_seq: '0', trusted_from_at: null, system_kind: null, pruned_at: null,
          }] }
          if (sql.includes('UNION ALL') || sql.includes('meta_history_baselines')) return { rows: [] }
          throw new Error(SENTINEL)
        },
      })
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-restore-stage-'))
      temporaryRoots.push(root)
      const service = StorageServiceImpl.createLocalService(root, '/synthetic-files')
      const objectId = randomUUID()
      const storageKey = `${objectId}/sha256-${digest(binary)}`
      const events: string[] = []
      let depth = 0
      if (mode === 'crash-retry' || mode === 'verified-retry' || mode === 'collision') {
        await service.uploadByKey(storageKey, mode === 'collision' ? Buffer.from('foreign') : binary)
      }
      const pending = stageRecoveryArchiveAttachment({ state, attachmentId: 'att-original',
        original: { generationId: durable.generationId, workspaceId: durable.binding.workspace_id,
          baseId: durable.binding.base_id, sheetId: durable.binding.sheet_id, recordId: 'record-1', fieldId: 'attachment' },
        transactionDepth: { currentTransactionDepth: () => depth },
        authorize: async () => mode !== 'denied',
        ledger: {
          reserve: async identity => {
            events.push('reserved')
            expect(identity.plaintextSha256).toBe(digest(binary))
            if (mode === 'transaction') depth = 1
            return { objectId, state: mode === 'verified-retry' ? 'verified' : 'reserved' }
          },
          verified: async id => {
            events.push('verified')
            expect(id).toBe(objectId)
            if (mode === 'receipt-failure') throw new Error(SENTINEL)
          },
        },
        storage: {
          uploadByKey: async (key, bytes, mediaType) => {
            expect(events).toEqual(['reserved'])
            events.push('upload')
            if (mode === 'mutating-upload') bytes.fill(0)
            await service.uploadByKey(key, bytes, mediaType)
          },
          readContentAddressed: async key => {
            events.push('read')
            const result = await StorageServiceImpl.createLocalService(root, '/synthetic-files').readContentAddressed(key)
            if (mode === 'false-readback') result.bytes = Buffer.alloc(binary.length)
            return result
          },
        },
      })
      if (mode === 'success' || mode === 'crash-retry' || mode === 'verified-retry') {
        expect(await pending).toMatchObject({ objectId, storageKey, plaintextSha256: digest(binary), sizeBytes: '4' })
        expect(events).toEqual(mode === 'verified-retry' ? ['reserved', 'read', 'verified'] : ['reserved', 'upload', 'read', 'verified'])
        expect(await service.downloadByKey(storageKey)).toEqual(binary)
      } else {
        await expect(pending).rejects.toThrow('RECOVERY_ARCHIVE_ATTACHMENT_STAGE_REFUSED')
        if (mode !== 'receipt-failure') expect(events).not.toContain('verified')
        if (mode === 'denied') expect(events).toEqual([])
        if (mode === 'transaction') expect(events).toEqual(['reserved'])
        if (mode === 'collision') expect(await service.downloadByKey(storageKey)).toEqual(Buffer.from('foreign'))
        if (mode === 'receipt-failure') expect(await service.downloadByKey(storageKey)).toEqual(binary)
      }
    },
  )

  test.each([false, true])('restore source is privately bound to the authenticated original scope (complete=%s)', async (complete) => {
    const binary = Buffer.from([0, 255, 128, 1])
    const durable = await buildDurableArchive({ attachments: [
      { id: 'att-original', bytes: binary, deleted: false, recordId: 'record-1', fieldId: 'attachment' },
      { id: 'att-deleted', bytes: binary, deleted: true, recordId: 'record-1', fieldId: 'attachment' },
    ] })
    const stored = await persistDurable(durable)
    const input = { ...stored, keyCustody: createBoundCustody(), transactionDepth: depthProbe(0) }
    const opened = complete ? await readRecoveryArchiveCompleteSectionState({ ...input,
      query: async (sql: string) => {
        if (sql.includes('meta_history_trust_checkpoints')) return { rows: [{
          id: durable.binding.checkpoint_id, sheet_id: durable.binding.sheet_id,
          state: 'active', trusted_since_seq: '0', trusted_from_at: null, system_kind: null, pruned_at: null,
        }] }
        if (sql.includes('UNION ALL') || sql.includes('meta_history_baselines')) return { rows: [] }
        throw new Error(SENTINEL)
      },
    }) : await readRecoveryArchiveCompleteSectionsInternal(input)
    const scope = { generationId: durable.generationId, workspaceId: durable.binding.workspace_id,
      baseId: durable.binding.base_id, sheetId: durable.binding.sheet_id, recordId: 'record-1', fieldId: 'attachment' }
    const source = readRecoveryArchiveAttachmentSource(opened, 'att-original', scope)
    expect(source).toEqual({ sourceVersion: `sha256:${digest(binary)}`, plaintextSha256: digest(binary),
      bytes: binary, sizeBytes: '4', mediaType: 'application/octet-stream' })
    source.bytes.fill(0)
    expect(readRecoveryArchiveAttachmentSource(opened, 'att-original', scope).bytes).toEqual(binary)
    for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
      expect(() => readRecoveryArchiveAttachmentSource(opened, 'att-original', { ...scope, [key]: 'other' }))
        .toThrow('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    }
    expect(() => readRecoveryArchiveAttachmentSource(opened, 'att-deleted', scope))
      .toThrow('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    expect(() => readRecoveryArchiveAttachmentSource(opened, 'att-missing', scope))
      .toThrow('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    expect(() => readRecoveryArchiveAttachmentSource({ ...opened }, 'att-original', scope))
      .toThrow('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
  })

  test('authenticates attachment bytes privately and rejects absent, swapped and AEAD-corrupt objects', async () => {
    const attachments = [
      { id: 'att-live', bytes: Buffer.from([0, 255, 1, 2]), deleted: false },
      { id: 'att-deleted', bytes: Buffer.from([128, 0, 3, 4]), deleted: true },
    ]
    const durable = await buildDurableArchive({ attachments })
    const stored = await persistDurable(durable)
    const input = { ...stored, keyCustody: createBoundCustody(), transactionDepth: depthProbe(0) }
    const opened = await readRecoveryArchiveCompleteSectionsInternal(input)
    expect(Object.keys(opened).sort()).toEqual(['manifest', 'sections'])
    for (const item of attachments) {
      const copy = readRecoveryArchiveAttachmentBytes(opened, item.id)
      expect(copy.bytes).toEqual(item.bytes)
      copy.bytes.fill(0)
      expect(readRecoveryArchiveAttachmentBytes(opened, item.id).bytes).toEqual(item.bytes)
    }
    expect(() => readRecoveryArchiveAttachmentBytes({ ...opened }, 'att-live')).toThrow('RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
    await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input,
      attachmentObjects: [...stored.attachmentObjects!, { ...stored.attachmentObjects![0]!, attachmentId: 'att-unlisted' }],
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID' })
    await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input, attachmentObjects: [] }))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID' })
    await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input,
      attachmentObjects: stored.attachmentObjects!.map((item, index, all) => ({ ...item, binding: all[1 - index]!.binding })),
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED' })
    const corrupt = { ...durable, attachmentObjects: durable.attachmentObjects!.map((item, index) => {
      const bytes = Buffer.from(item.bytes)
      if (index === 0) bytes[bytes.length - 1] ^= 1
      return { ...item, bytes }
    }) }
    const corruptStored = await persistDurable(corrupt)
    await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input, ...corruptStored }))
      .rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED' })
  })
  test('reopens persistent archive and encrypted custody roots, refusing missing or wrong recovery components', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-local-reopen-'))
    temporaryRoots.push(root)
    const archivePath = path.join(root, 'archive')
    const custodyPath = path.join(root, 'custody')
    await fs.mkdir(archivePath, { mode: 0o700 })
    await fs.mkdir(custodyPath, { mode: 0o700 })
    const custodyId = randomUUID()
    const recoverySecret = randomBytes(32)
    const wrongSecret = randomBytes(32)
    const transactionDepth = depthProbe(0)
    const custodyOptions = { archivePath, custodyPath, custodyId, transactionDepth }
    const objectOptions = { basePath: archivePath, storeId: randomUUID(), maxObjectBytes: 1024 * 1024, transactionDepth }
    const writer = createLocalCustodySession(transactionDepth)
    const reader = createLocalCustodySession(transactionDepth)
    try {
      await provisionRecoveryArchiveFileRoot(objectOptions)
      const custodyStore = await createLocalCustodyStore(custodyOptions)
      const backup = createLocalCustodyBackup({ custodyId, recoverySecret, transactionDepth })
      const original = await custodyStore.putBackup(randomUUID(), backup)
      writer.unlock({ custodyId, recoverySecret, backup })
      const durable = await buildDurableArchive({ local: writer.admitForArchive(custodyId) })
      const persisted = await persistDurable(durable, { objectStore: await createRecoveryArchiveFileStoreProvider(objectOptions) })
      const rotated = await custodyStore.putBackup(randomUUID(), writer.exportRotatedBackup(recoverySecret))
      writer.lock()

      const reopenedCustody = await createLocalCustodyStore(custodyOptions)
      const reopenedBackup = await reopenedCustody.readBackup(rotated)
      expect(reader.isUnlocked()).toBe(false)
      expect(() => reader.unlock({ custodyId, recoverySecret: wrongSecret, backup: reopenedBackup })).toThrow('RECOVERY_LOCAL_CUSTODY_REFUSED')
      expect(reader.isUnlocked()).toBe(false)
      reader.unlock({ custodyId, recoverySecret, backup: reopenedBackup })
      const input = { ...persisted, objectStore: await createRecoveryArchiveFileStoreProvider(objectOptions), transactionDepth, keyCustody: reader.admitForArchive(custodyId) }
      const opened = await readRecoveryArchiveCompleteSectionsInternal(input)
      expect(opened.sections.records.map(row => row.payload)).toEqual([
        { record_id: 'record-1', exists: true, version: 1, data: { text: 'value' } },
        { record_id: 'record-2', exists: false, version: 2, data: null },
      ])
      expect(await reopenedCustody.readBackup(original)).toEqual(backup)
      await fs.unlink(path.join(custodyPath, `${custodyId}-${rotated.backupId}.custody`))
      await expect(reopenedCustody.readBackup(rotated)).rejects.toThrow('RECOVERY_LOCAL_CUSTODY_STORE_REFUSED')
      const section = persisted.sectionObjects[0]!
      await fs.unlink(path.join(archivePath, `${section.generationId}-${section.objectId}.object`))
      await expect(readRecoveryArchiveCompleteSectionsInternal(input)).rejects.toBeInstanceOf(RecoveryArchiveReaderError)
    } finally {
      writer.lock()
      reader.lock()
      recoverySecret.fill(0)
      wrongSecret.fill(0)
    }
  })
  test('local admission seals and authenticates real sections, then recovers retained records in a fresh session', async () => {
    const custodyId = randomUUID()
    const recoverySecret = randomBytes(32)
    const transactionDepth = depthProbe(0)
    const backup = createLocalCustodyBackup({ custodyId, recoverySecret, transactionDepth })
    const writer = createLocalCustodySession(transactionDepth)
    writer.unlock({ custodyId, recoverySecret, backup })
    const admission = writer.admitForArchive(custodyId)
    const durable = await buildDurableArchive({ local: admission })
    const persisted = await persistDurable(durable)
    const rotated = writer.exportRotatedBackup(recoverySecret)
    writer.lock()
    const reader = createLocalCustodySession(transactionDepth)
    expect(reader.isUnlocked()).toBe(false)
    reader.unlock({ custodyId, recoverySecret, backup: rotated })
    const input = {
      ...persisted,
      transactionDepth,
      keyCustody: reader.admitForArchive(custodyId),
    }
    try {
      const opened = await readRecoveryArchiveCompleteSectionsInternal(input)
      expect(opened.manifest.format_version).toBe(1)
      expect(opened.manifest.sections.every(section => section.key_id === admission.keyId)).toBe(true)
      expect(opened.sections.records.map(row => row.payload)).toEqual([
        { record_id: 'record-1', exists: true, version: 1, data: { text: 'value' } },
        { record_id: 'record-2', exists: false, version: 2, data: null },
      ])
      await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input, keyCustody: admission })).rejects.toBeInstanceOf(RecoveryArchiveReaderError)
      await expect(readRecoveryArchiveCompleteSectionsInternal({ ...input, keyCustody: createBoundCustody() })).rejects.toBeInstanceOf(RecoveryArchiveReaderError)
      reader.lock()
      await expect(readRecoveryArchiveCompleteSectionsInternal(input)).rejects.toBeInstanceOf(RecoveryArchiveReaderError)
    } finally {
      writer.lock()
      reader.lock()
      recoverySecret.fill(0)
    }
  })
  test('opens the authenticated ten-section snapshot with defensive copies and exact bigint seq', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody()
    const opened = await readRecoveryArchiveCompleteSectionsInternal({
      selectedBinding: persisted.selectedBinding,
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      objectStore: persisted.objectStore,
      manifestObject: persisted.manifestObject,
      sectionObjects: persisted.sectionObjects,
    })

    expect(custody.calls).toEqual([
      'verifyManifestRootMac',
      'unwrapGenerationDek',
      'deriveDekFingerprint',
    ])
    expect(opened.manifest.anchor_seq).toBe(ANCHOR_SEQ)
    expect(opened.manifest.anchor_seq).not.toBe(String(Number(ANCHOR_SEQ)))
    expect(opened.sections.schema).toHaveLength(1)
    expect(opened.sections.records).toHaveLength(2)
    expect(opened.sections.records[0]?.payload).toEqual({
      record_id: 'record-1',
      exists: true,
      version: 1,
      data: { text: 'value' },
    })
    expect(opened.sections.records[1]?.payload).toEqual({
      record_id: 'record-2',
      exists: false,
      version: 2,
      data: null,
    })
    for (const name of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
      expect(opened.sections[name]).toBeDefined()
    }

    const mutated = opened.sections.records[0]?.payload as { data?: { text?: string } }
    expect(() => {
      mutated.data = { text: SENTINEL }
    }).toThrow()
    expect(opened.sections.records[0]?.payload).toEqual({
      record_id: 'record-1',
      exists: true,
      version: 1,
      data: { text: 'value' },
    })
  })

  test('the public D4 authority returns the composed complete state', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const query = async (sql: string) => {
      if (sql.includes('meta_history_trust_checkpoints')) {
        return {
          rows: [{
            id: durable.binding.checkpoint_id,
            sheet_id: durable.binding.sheet_id,
            state: 'active',
            trusted_since_seq: '0',
            trusted_from_at: null,
            system_kind: null,
            pruned_at: null,
          }],
        }
      }
      if (sql.includes('UNION ALL') || sql.includes('meta_history_baselines')) {
        return { rows: [] }
      }
      throw new Error(SENTINEL)
    }

    const state = await readRecoveryArchiveCompleteSectionState({
      query,
      selectedBinding: persisted.selectedBinding,
      keyCustody: createBoundCustody(),
      transactionDepth: depthProbe(0),
      objectStore: persisted.objectStore,
      manifestObject: persisted.manifestObject,
      sectionObjects: persisted.sectionObjects,
    })

    expect(state.records.get('record-1')).toEqual({
      recordId: 'record-1',
      exists: true,
      version: 1,
      data: { text: 'value' },
    })
    expect(state.records.get('record-2')).toEqual({
      recordId: 'record-2',
      exists: false,
      version: 2,
      data: null,
    })
    expect(state.schema).toHaveLength(1)
  })

  test('manifest object must belong to the selected archive generation', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const foreignGenerationId = randomUUID()
    const foreign = await persisted.objectStore.put({
      generationId: foreignGenerationId,
      objectId: objectId(foreignGenerationId, 'manifest'),
      version: '1',
      sha256: digest(durable.envelopeBytes),
      size: String(durable.envelopeBytes.byteLength),
      expiresAt: EXPIRES_AT,
      pinned: true,
      bytes: durable.envelopeBytes,
    })
    const custody = createBoundCustody()

    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: {
          generationId: foreign.object.generationId,
          objectId: foreign.object.objectId,
          expectedVersion: foreign.object.version,
          expectedSha256: foreign.object.sha256,
          expectedSize: foreign.object.size,
          expectedExpiresAt: foreign.object.expiresAt,
        },
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    }
    expect(custody.calls).toEqual([])
  })

  test('wrong MAC refuses before unwrap and leaks no custody sentinel', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody({ verify: async () => false })
    const sectionObjectIds = new Set(persisted.sectionObjects.map((binding) => binding.objectId))
    let sectionObjectReads = 0
    const countingStore: RecoveryArchiveObjectStoreProvider = {
      ...persisted.objectStore,
      async get(request) {
        if (sectionObjectIds.has(request.objectId)) sectionObjectReads += 1
        return persisted.objectStore.get(request)
      },
    }
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        objectStore: countingStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_MAC_INVALID')
    }
    expect(custody.calls).toEqual(['verifyManifestRootMac'])
    expect(sectionObjectReads).toBe(0)
  })

  test('a signed manifest changed after MAC creation refuses with the real verifier', async () => {
    const durable = await buildDurableArchive({
      tamperSignedManifest: (manifest) => {
        const body = {
          format_version: manifest.format_version,
          archive_generation_id: manifest.archive_generation_id,
          workspace_id: manifest.workspace_id,
          base_id: manifest.base_id,
          sheet_id: manifest.sheet_id,
          anchor_operation_id: manifest.anchor_operation_id,
          anchor_seq: manifest.anchor_seq,
          checkpoint_id: manifest.checkpoint_id,
          created_at: '2026-08-28T00:00:01.000Z',
          expires_at: manifest.expires_at,
          source_vector_hash: manifest.source_vector_hash,
          sections: manifest.sections,
        }
        return {
          ...body,
          root_hash: computeRecoveryArchiveManifestRootHash(body),
          manifest_mac: manifest.manifest_mac,
        }
      },
    })
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody()
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_MAC_INVALID')
    }
    expect(custody.calls).toEqual(['verifyManifestRootMac'])
  })

  test('wrong unwrap key and fingerprint refuse with distinct codes', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)

    const wrongKey = createBoundCustody({ keyId: 'kms-key-other' })
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: wrongKey,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED')
    }

    const wrongFingerprint = createBoundCustody({ fingerprint: () => 'c'.repeat(64) })
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: wrongFingerprint,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_DEK_FINGERPRINT_MISMATCH')
    }
    expect(wrongFingerprint.calls).toEqual([
      'verifyManifestRootMac',
      'unwrapGenerationDek',
      'deriveDekFingerprint',
    ])
  })

  test('truncated section bytes and flipped auth tags refuse distinctly', async () => {
    const durable = await buildDurableArchive()
    const truncated = durable.sectionObjects.map((bytes, index) =>
      index === 1 ? bytes.slice(0, RECOVERY_ARCHIVE_AEAD_TAG_BYTES - 1) : new Uint8Array(bytes),
    )
    const persistedTruncated = await persistDurable(durable, { sectionObjects: truncated })
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persistedTruncated.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persistedTruncated.objectStore,
        manifestObject: persistedTruncated.manifestObject,
        sectionObjects: persistedTruncated.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_AUTH_TAG_INVALID')
    }

    const flipped = durable.sectionObjects.map((bytes, index) => {
      const copy = new Uint8Array(bytes)
      if (index === 1) copy[copy.byteLength - 1] ^= 1
      return copy
    })
    const persistedFlipped = await persistDurable(durable, { sectionObjects: flipped })
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persistedFlipped.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persistedFlipped.objectStore,
        manifestObject: persistedFlipped.manifestObject,
        sectionObjects: persistedFlipped.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED')
    }
  })

  test('binding and root mismatch refuse only after MAC verification', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody()
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: { ...persisted.selectedBinding, rootHash: 'd'.repeat(64) },
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    }
    expect(custody.calls[0]).toBe('verifyManifestRootMac')
    expect(custody.calls).not.toContain('unwrapGenerationDek')
  })

  test('missing, reordered, and duplicate section objects refuse before trusted rows', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody()

    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects.slice(1),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
    }

    const reordered = [...persisted.sectionObjects]
    const first = reordered[0]
    const second = reordered[1]
    if (first === undefined || second === undefined) throw new Error('missing-bindings')
    reordered[0] = second
    reordered[1] = first
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: reordered,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED')
    }

    const duplicate = [...persisted.sectionObjects]
    duplicate[2] = persisted.sectionObjects[1]
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: duplicate,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
    }
  })

  test('forged row count and plaintext hash refuse with distinct codes', async () => {
    const forgedCount = await buildDurableArchive({
      mutateManifest: (manifest) => {
        const sections = manifest.sections.map((section, index) =>
          index === 1 ? { ...section, row_count: '99' } : section,
        )
        const body = {
          format_version: manifest.format_version,
          archive_generation_id: manifest.archive_generation_id,
          workspace_id: manifest.workspace_id,
          base_id: manifest.base_id,
          sheet_id: manifest.sheet_id,
          anchor_operation_id: manifest.anchor_operation_id,
          anchor_seq: manifest.anchor_seq,
          checkpoint_id: manifest.checkpoint_id,
          created_at: manifest.created_at,
          expires_at: manifest.expires_at,
          source_vector_hash: manifest.source_vector_hash,
          sections,
        }
        return {
          ...body,
          root_hash: computeRecoveryArchiveManifestRootHash(body),
          manifest_mac: null,
        }
      },
    })
    const persistedCount = await persistDurable(forgedCount)
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persistedCount.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persistedCount.objectStore,
        manifestObject: persistedCount.manifestObject,
        sectionObjects: persistedCount.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_SECTION_INTEGRITY_MISMATCH')
    }

    const forgedHash = await buildDurableArchive({
      mutateManifest: (manifest) => {
        const sections = manifest.sections.map((section, index) =>
          index === 1 ? { ...section, plaintext_sha256: 'e'.repeat(64) } : section,
        )
        const body = {
          format_version: manifest.format_version,
          archive_generation_id: manifest.archive_generation_id,
          workspace_id: manifest.workspace_id,
          base_id: manifest.base_id,
          sheet_id: manifest.sheet_id,
          anchor_operation_id: manifest.anchor_operation_id,
          anchor_seq: manifest.anchor_seq,
          checkpoint_id: manifest.checkpoint_id,
          created_at: manifest.created_at,
          expires_at: manifest.expires_at,
          source_vector_hash: manifest.source_vector_hash,
          sections,
        }
        return {
          ...body,
          root_hash: computeRecoveryArchiveManifestRootHash(body),
          manifest_mac: null,
        }
      },
    })
    const persistedHash = await persistDurable(forgedHash)
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persistedHash.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persistedHash.objectStore,
        manifestObject: persistedHash.manifestObject,
        sectionObjects: persistedHash.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED')
    }
  })

  test('hostile JSON and extra envelope keys refuse as plaintext invalid', async () => {
    const hostile = Buffer.from(
      JSON.stringify([{ entity_key: 'record/record-1', payload: { record_id: 'record-1' }, extra: SENTINEL }]),
    )
    const durable = await buildDurableArchive({ replaceRecordsPlaintext: hostile })
    const persisted = await persistDurable(durable)
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
      expect(String(error)).not.toContain(SENTINEL)
    }
  })

  test('hostile deep plaintext maps canonicalization failure to plaintext invalid', async () => {
    const nested = `${'['.repeat(12_000)}null${']'.repeat(12_000)}`
    const plaintext = Buffer.from(
      `[{"entity_key":"record/record-1","payload":{"record_id":"record-1","exists":true,"version":1,"data":${nested}}}]`,
    )
    const durable = await buildDurableArchive({ replaceRecordsPlaintext: plaintext })
    const persisted = await persistDurable(durable)
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: createBoundCustody(),
        transactionDepth: depthProbe(0),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
    }
  })

  test('in-transaction key custody refuses before KMS', async () => {
    const durable = await buildDurableArchive()
    const persisted = await persistDurable(durable)
    const custody = createBoundCustody()
    try {
      await readRecoveryArchiveCompleteSectionsInternal({
        selectedBinding: persisted.selectedBinding,
        keyCustody: custody,
        transactionDepth: depthProbe(1),
        objectStore: persisted.objectStore,
        manifestObject: persisted.manifestObject,
        sectionObjects: persisted.sectionObjects,
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReaderError(error, 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_IN_TRANSACTION')
    }
    expect(custody.calls).toEqual([])
  })
})
