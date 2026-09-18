/** Internal sealed-envelope continuation. No route, catalog publication or lease takeover. */
import {
  assertKeyCustodyCallOutsideTransaction,
  buildRecoveryArchiveSectionAad,
  reserveThenSealRecoveryArchiveSections,
  type RecoveryArchiveCryptoBinding,
  type RecoveryArchiveReserveThenSealInput,
  type RecoveryArchiveReserveThenSealResult,
  type RecoveryArchiveSealedSection,
} from './recovery-archive-crypto'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from './recovery-archive-contract'
import {
  persistRecoveryArchivePreparedCapture,
  readRecoveryArchivePreparedCapture,
  type RecoveryArchivePreparedCaptureOwner,
} from './recovery-archive-prepared-capture'
import type { SealQuery } from './recovery-archive-seals'
import { parseRecoveryArchiveManifestObjectEnvelope } from './recovery-archive-manifest-object-envelope'

const BINDING_KEYS = ['formatVersion', 'generationId', 'workspaceId', 'baseId', 'sheetId',
  'anchorOperationId', 'anchorSeq', 'checkpointId', 'keyId', 'wrappedDekId', 'dekFingerprint', 'aeadAlgorithm'] as const
const SECTION_KEYS = ['sectionName', 'aeadAlgorithm', 'nonce', 'ciphertext', 'authTag', 'plaintextSha256']
const ATTACHMENT_KEYS = ['attachmentId', 'sourceVersion', 'plaintextSha256', 'sizeBytes', 'nonce', 'ciphertext', 'authTag']
const INVALID = 'RECOVERY_ARCHIVE_PREPARED_ENVELOPE_INVALID'
type PreparedAttachment = NonNullable<RecoveryArchiveReserveThenSealResult['sealedAttachments']>[number]

export interface RecoveryArchivePreparedEnvelope {
  binding: RecoveryArchiveCryptoBinding
  wrappedDek: Buffer
  sections: RecoveryArchiveSealedSection[]
  manifestEnvelope?: Buffer
  attachments?: PreparedAttachment[]
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(INVALID)
  return value as Record<string, unknown>
}

function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') throw new Error(INVALID)
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw new Error(INVALID)
  return result
}

/** Only closed ciphertext fields are encoded; the result cannot retain raw DEK or plaintext properties. */
export function encodeRecoveryArchivePreparedEnvelope(result: RecoveryArchiveReserveThenSealResult, manifestEnvelope?: Uint8Array): Buffer {
  const attachments = result.sealedAttachments
  if (attachments !== undefined && !Array.isArray(attachments)) throw new Error(INVALID)
  const hasAttachments = !!attachments?.length
  const payload = Buffer.from(JSON.stringify({
    version: hasAttachments ? 3 : manifestEnvelope ? 2 : 1,
    ...(hasAttachments || manifestEnvelope ? { manifestEnvelope: manifestEnvelope ? Buffer.from(manifestEnvelope).toString('base64') : null } : {}),
    ...(hasAttachments ? { attachments: attachments.map((object) => ({
      attachmentId: object.attachmentId, sourceVersion: object.sourceVersion,
      plaintextSha256: object.plaintextSha256, sizeBytes: object.sizeBytes,
      nonce: object.nonce.toString('base64'), ciphertext: object.ciphertext.toString('base64'),
      authTag: object.authTag.toString('base64'),
    })) } : {}),
    binding: Object.fromEntries(BINDING_KEYS.map((key) => [key, result.binding[key]])),
    wrappedDek: Buffer.from(result.wrappedDek).toString('base64'),
    sections: result.sealedSections.map((section) => ({
      sectionName: section.sectionName, aeadAlgorithm: section.aeadAlgorithm,
      nonce: section.nonce.toString('base64'), ciphertext: section.ciphertext.toString('base64'),
      authTag: section.authTag.toString('base64'), plaintextSha256: section.plaintextSha256,
    })),
  }), 'utf8')
  decodeRecoveryArchivePreparedEnvelope(payload)
  return payload
}

/** Shape validation is not AEAD authentication; existing open/restore cryptography still owns that check. */
export function decodeRecoveryArchivePreparedEnvelope(payload: Buffer): RecoveryArchivePreparedEnvelope {
  try {
    const parsed = JSON.parse(payload.toString('utf8'))
    const wire = closed(parsed, ['version', 'binding', 'wrappedDek', 'sections',
      ...(parsed?.version === 2 || parsed?.version === 3 ? ['manifestEnvelope'] : []),
      ...(parsed?.version === 3 ? ['attachments'] : [])])
    if (wire.version !== 1 && wire.version !== 2 && wire.version !== 3) throw new Error(INVALID)
    const binding = closed(wire.binding, BINDING_KEYS) as unknown as RecoveryArchiveCryptoBinding
    const wrappedDek = bytes(wire.wrappedDek)
    if (!wrappedDek.length || !Array.isArray(wire.sections)
      || wire.sections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) throw new Error(INVALID)
    const nonces = new Set<string>()
    const sections = wire.sections.map((item: unknown, index: number): RecoveryArchiveSealedSection => {
      const section = closed(item, SECTION_KEYS)
      const sectionName = RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]!
      if (section.sectionName !== sectionName || section.aeadAlgorithm !== binding.aeadAlgorithm) throw new Error(INVALID)
      const nonce = bytes(section.nonce, 12)
      if (nonces.has(nonce.toString('hex'))) throw new Error(INVALID)
      nonces.add(nonce.toString('hex'))
      buildRecoveryArchiveSectionAad({ ...binding, sectionName, plaintextSha256: section.plaintextSha256 as string })
      return { sectionName, aeadAlgorithm: binding.aeadAlgorithm, nonce,
        ciphertext: bytes(section.ciphertext), authTag: bytes(section.authTag, 16),
        plaintextSha256: section.plaintextSha256 as string }
    })
    let attachments: PreparedAttachment[] | undefined
    if (wire.version === 3) {
      if (!Array.isArray(wire.attachments) || !wire.attachments.length) throw new Error(INVALID)
      const identities = new Set<string>()
      attachments = wire.attachments.map((item: unknown) => {
        const object = closed(item, ATTACHMENT_KEYS)
        if (typeof object.attachmentId !== 'string' || !object.attachmentId.trim()
          || typeof object.sourceVersion !== 'string' || !object.sourceVersion.trim()
          || typeof object.plaintextSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(object.plaintextSha256)
          || typeof object.sizeBytes !== 'number' || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0
          || identities.has(object.attachmentId)) throw new Error(INVALID)
        identities.add(object.attachmentId)
        const nonce = bytes(object.nonce, 12)
        if (nonces.has(nonce.toString('hex'))) throw new Error(INVALID)
        nonces.add(nonce.toString('hex'))
        const ciphertext = bytes(object.ciphertext)
        if (ciphertext.length !== object.sizeBytes) throw new Error(INVALID)
        return { attachmentId: object.attachmentId, sourceVersion: object.sourceVersion,
          plaintextSha256: object.plaintextSha256, sizeBytes: object.sizeBytes, nonce,
          ciphertext, authTag: bytes(object.authTag, 16) }
      })
    }
    const manifestEnvelope = wire.version === 2 || (wire.version === 3 && wire.manifestEnvelope !== null)
      ? bytes(wire.manifestEnvelope) : undefined
    if (manifestEnvelope) {
      const signed = parseRecoveryArchiveManifestObjectEnvelope(manifestEnvelope)
      const manifest = signed.manifest
      if (manifest.archive_generation_id !== binding.generationId || manifest.workspace_id !== binding.workspaceId
        || manifest.base_id !== binding.baseId || manifest.sheet_id !== binding.sheetId
        || manifest.anchor_operation_id !== binding.anchorOperationId || manifest.anchor_seq !== binding.anchorSeq
        || manifest.checkpoint_id !== binding.checkpointId || !Buffer.from(signed.wrappedDek).equals(wrappedDek)
        || manifest.sections.some((entry, index) => entry.name !== sections[index]!.sectionName
          || entry.key_id !== binding.keyId || entry.wrapped_dek_id !== binding.wrappedDekId
          || entry.dek_fingerprint !== binding.dekFingerprint || entry.aead_algorithm !== binding.aeadAlgorithm
          || entry.nonce !== sections[index]!.nonce.toString('hex')
          || entry.plaintext_sha256 !== sections[index]!.plaintextSha256)) throw new Error(INVALID)
    }
    return { binding, wrappedDek, sections, ...(manifestEnvelope ? { manifestEnvelope } : {}),
      ...(attachments ? { attachments } : {}) }
  } catch { throw new Error(INVALID) }
}

type SealInput = Omit<RecoveryArchiveReserveThenSealInput, 'uploadSealedSection' | 'sealSection'>
export interface RecoveryArchivePreparedUploadInput {
  owner: RecoveryArchivePreparedCaptureOwner
  binding: SealInput['binding']
  transaction: <T>(work: (query: SealQuery) => Promise<T>) => Promise<T>
  /** Must recheck current manage/full-read/live-scope; this internal module grants no authority. */
  checkAuthority: () => Promise<void>
  /** Invoked only when no persisted envelope exists. Source capture remains caller-owned. */
  capture: () => Promise<SealInput>
  /** When supplied, the durable package must contain an authenticated manifest, including on resume. */
  authenticateCapture?: (sealed: RecoveryArchiveReserveThenSealResult) => Promise<Uint8Array>
  transactionDepth: SealInput['transactionDepth']
  upload: (envelope: RecoveryArchivePreparedEnvelope, section: RecoveryArchiveSealedSection) => Promise<void>
  uploadAttachment?: (envelope: RecoveryArchivePreparedEnvelope, attachment: PreparedAttachment) => Promise<void>
}

/** Persist all sealed bytes before the first upload. Resume never invokes capture/custody/encryption. */
export async function uploadRecoveryArchivePreparedCapture(input: RecoveryArchivePreparedUploadInput): Promise<void> {
  const owner = { ...input.owner }
  const binding = { ...input.binding }
  closed(binding, BINDING_KEYS.filter((key) => key !== 'wrappedDekId' && key !== 'dekFingerprint'))
  const outside = () => {
    assertKeyCustodyCallOutsideTransaction(input.transactionDepth)
  }
  const verifyBinding = (actual: RecoveryArchiveCryptoBinding | SealInput['binding']) => {
    if (binding.generationId !== owner.generationId
      || Object.keys(binding).some((key) => actual[key as keyof typeof actual] !== binding[key as keyof typeof binding])) {
      throw new Error('RECOVERY_ARCHIVE_PREPARED_UPLOAD_BINDING_MISMATCH')
    }
  }
  outside()
  await input.checkAuthority()
  let payload = await input.transaction((query) => readRecoveryArchivePreparedCapture(query, owner))
  if (!payload) {
    outside()
    const capture = await input.capture()
    verifyBinding(capture.binding)
    if (capture.attachments?.length && !input.uploadAttachment) throw new Error('RECOVERY_ARCHIVE_ATTACHMENT_UPLOAD_REQUIRED')
    const sealed = await reserveThenSealRecoveryArchiveSections({
      binding: capture.binding, keyCustody: capture.keyCustody, transactionDepth: input.transactionDepth,
      dekSource: capture.dekSource, sections: capture.sections, attachments: capture.attachments,
      reserveNonces: capture.reserveNonces,
    })
    const manifest = input.authenticateCapture ? await input.authenticateCapture(sealed) : undefined
    payload = encodeRecoveryArchivePreparedEnvelope(sealed, manifest)
    await input.checkAuthority()
    payload = await input.transaction((query) => persistRecoveryArchivePreparedCapture(query, owner, payload!))
  }
  const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
  if (input.authenticateCapture && !envelope.manifestEnvelope) throw new Error('RECOVERY_ARCHIVE_PREPARED_MANIFEST_REQUIRED')
  verifyBinding(envelope.binding)
  const uploadAttachment = input.uploadAttachment
  if (envelope.attachments?.length && !uploadAttachment) throw new Error('RECOVERY_ARCHIVE_ATTACHMENT_UPLOAD_REQUIRED')
  for (let index = 0; index < envelope.sections.length + (envelope.attachments?.length ?? 0); index += 1) {
    await input.checkAuthority()
    const current = await input.transaction((query) => readRecoveryArchivePreparedCapture(query, owner))
    if (!current?.equals(payload)) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT')
    outside()
    // Fresh decode prevents a provider mutating one callback's object from changing subsequent uploads.
    const original = decodeRecoveryArchivePreparedEnvelope(payload)
    if (index < original.sections.length) await input.upload(original, original.sections[index]!)
    else await uploadAttachment!(original, original.attachments![index - original.sections.length]!)
  }
}
