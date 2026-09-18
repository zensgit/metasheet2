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

const BINDING_KEYS = ['formatVersion', 'generationId', 'workspaceId', 'baseId', 'sheetId',
  'anchorOperationId', 'anchorSeq', 'checkpointId', 'keyId', 'wrappedDekId', 'dekFingerprint', 'aeadAlgorithm'] as const
const SECTION_KEYS = ['sectionName', 'aeadAlgorithm', 'nonce', 'ciphertext', 'authTag', 'plaintextSha256']
const INVALID = 'RECOVERY_ARCHIVE_PREPARED_ENVELOPE_INVALID'

export interface RecoveryArchivePreparedEnvelope {
  binding: RecoveryArchiveCryptoBinding
  wrappedDek: Buffer
  sections: RecoveryArchiveSealedSection[]
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
export function encodeRecoveryArchivePreparedEnvelope(result: RecoveryArchiveReserveThenSealResult): Buffer {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
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
    const wire = closed(JSON.parse(payload.toString('utf8')), ['version', 'binding', 'wrappedDek', 'sections'])
    if (wire.version !== 1) throw new Error(INVALID)
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
    return { binding, wrappedDek, sections }
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
  transactionDepth: SealInput['transactionDepth']
  upload: (envelope: RecoveryArchivePreparedEnvelope, section: RecoveryArchiveSealedSection) => Promise<void>
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
    const sealed = await reserveThenSealRecoveryArchiveSections({
      binding: capture.binding, keyCustody: capture.keyCustody, transactionDepth: input.transactionDepth,
      dekSource: capture.dekSource, sections: capture.sections, reserveNonces: capture.reserveNonces,
    })
    payload = encodeRecoveryArchivePreparedEnvelope(sealed)
    await input.checkAuthority()
    payload = await input.transaction((query) => persistRecoveryArchivePreparedCapture(query, owner, payload!))
  }
  const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
  verifyBinding(envelope.binding)
  for (let index = 0; index < envelope.sections.length; index += 1) {
    await input.checkAuthority()
    const current = await input.transaction((query) => readRecoveryArchivePreparedCapture(query, owner))
    if (!current?.equals(payload)) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT')
    outside()
    // Fresh decode prevents a provider mutating one callback's object from changing subsequent uploads.
    const original = decodeRecoveryArchivePreparedEnvelope(payload)
    await input.upload(original, original.sections[index]!)
  }
}
