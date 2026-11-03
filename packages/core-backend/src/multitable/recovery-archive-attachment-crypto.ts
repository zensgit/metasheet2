import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { buildRecoveryArchiveSectionAad, type RecoveryArchiveCryptoBinding } from './recovery-archive-crypto'

export type ArchiveAttachmentBinding = {
  generation: RecoveryArchiveCryptoBinding
  attachmentId: string
  sourceVersion: string
  plaintextSha256: string
}

export type SealedArchiveAttachment = {
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

const INVALID = 'RECOVERY_ARCHIVE_ATTACHMENT_CRYPTO_INVALID'

/** Stable registry identity for an opaque source ID; the AEAD still binds the full original ID. */
export function recoveryArchiveAttachmentNonceIdentity(attachmentId: string): `attachment:${string}` {
  if (typeof attachmentId !== 'string' || !attachmentId.trim()) throw new Error(INVALID)
  return `attachment:${createHash('sha256').update(attachmentId, 'utf8').digest('hex')}`
}

function aad(binding: ArchiveAttachmentBinding): Buffer {
  if (typeof binding.attachmentId !== 'string' || !binding.attachmentId.trim()
    || typeof binding.sourceVersion !== 'string' || !binding.sourceVersion.trim()) throw new Error(INVALID)
  const generation = buildRecoveryArchiveSectionAad({ ...binding.generation,
    sectionName: 'attachments_index', plaintextSha256: binding.plaintextSha256 })
  // A distinct domain prevents a binary attachment from being substituted for the index section.
  return Buffer.from(JSON.stringify(['metasheet.recovery-archive.attachment.v1',
    generation.toString('base64'), binding.attachmentId, binding.sourceVersion]))
}

function material(key: Uint8Array, nonce: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32
    || !(nonce instanceof Uint8Array) || nonce.byteLength !== 12) throw new Error(INVALID)
}

/** Internal primitive: the producer must durably reserve the shared DEK/nonce before calling. */
export function sealRecoveryArchiveAttachment(input: {
  binding: ArchiveAttachmentBinding; dek: Uint8Array; nonce: Uint8Array; plaintext: Uint8Array
}): SealedArchiveAttachment {
  let key: Buffer | undefined
  try {
    material(input.dek, input.nonce)
    if (!(input.plaintext instanceof Uint8Array)
      || createHash('sha256').update(input.plaintext).digest('hex') !== input.binding.plaintextSha256) throw new Error(INVALID)
    const authenticated = aad(input.binding)
    key = Buffer.from(input.dek)
    const nonce = Buffer.from(input.nonce)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(authenticated)
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
    return { nonce, ciphertext, authTag: cipher.getAuthTag() }
  } catch { throw new Error(INVALID) } finally { key?.fill(0) }
}

export function openRecoveryArchiveAttachment(input: {
  binding: ArchiveAttachmentBinding; dek: Uint8Array; sealed: SealedArchiveAttachment
}): Buffer {
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    material(input.dek, input.sealed.nonce)
    if (!(input.sealed.authTag instanceof Uint8Array) || input.sealed.authTag.byteLength !== 16
      || !(input.sealed.ciphertext instanceof Uint8Array)) throw new Error(INVALID)
    key = Buffer.from(input.dek)
    const decipher = createDecipheriv('aes-256-gcm', key, input.sealed.nonce)
    decipher.setAAD(aad(input.binding))
    decipher.setAuthTag(input.sealed.authTag)
    const pending = decipher.update(input.sealed.ciphertext)
    try { plaintext = Buffer.concat([pending, decipher.final()]) } finally { pending.fill(0) }
    if (createHash('sha256').update(plaintext).digest('hex') !== input.binding.plaintextSha256) throw new Error(INVALID)
    return plaintext
  } catch { plaintext?.fill(0); throw new Error(INVALID) } finally { key?.fill(0) }
}
