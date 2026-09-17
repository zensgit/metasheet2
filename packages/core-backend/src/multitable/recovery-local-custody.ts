import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RecoveryArchiveCustodyOperations, RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'

const admissionBrand: unique symbol = Symbol('local-custody-admission')
export interface LocalArchiveCustodyAdmission {
  readonly assurance: 'local-v1'
  readonly custodyId: string
  readonly keyId: string
  readonly [admissionBrand]: true
}
const admissions = new WeakMap<LocalArchiveCustodyAdmission, RecoveryArchiveCustodyOperations>()
const releases = new WeakMap<LocalArchiveCustodyAdmission, () => void>()

/** Release authority is tied to the same opaque admission, not to a caller-supplied callback. */
export function resolveLocalArchiveCustodyRelease(input: object): (() => void) | undefined {
  resolveLocalArchiveCustody(input)
  return releases.get(input as LocalArchiveCustodyAdmission)
}

/** Internal guard entry: no structural/manifest-driven fallback for local claims. */
export function resolveLocalArchiveCustody(input: object): RecoveryArchiveCustodyOperations | undefined {
  const operations = admissions.get(input as LocalArchiveCustodyAdmission)
  if (!operations && 'assurance' in input) refuse()
  return operations
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_VERSIONS = 64
const MAX_BACKUP = 16_384
const DOMAIN = 'metasheet.recovery.local-custody.v1'
type Keyring = Map<string, Buffer>

function refuse(): never {
  throw new Error('RECOVERY_LOCAL_CUSTODY_REFUSED')
}

function guarded<T>(probe: RecoveryArchiveTransactionDepthProbe, work: () => T): T {
  try {
    if (probe.currentTransactionDepth() !== 0) refuse()
    return work()
  } catch {
    refuse()
  }
}

function uuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) refuse()
  return value
}

function bytes(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) refuse()
  return Buffer.from(value)
}

function context(...parts: string[]): Buffer {
  return Buffer.from(JSON.stringify([DOMAIN, ...parts]))
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function open(key: Uint8Array, encrypted: Buffer, aad: Uint8Array): Buffer {
  if (encrypted.length < 28) refuse()
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12), { authTagLength: 16 })
  decipher.setAAD(aad)
  decipher.setAuthTag(encrypted.subarray(-16))
  const partial = decipher.update(encrypted.subarray(12, -16))
  try {
    return Buffer.concat([partial, decipher.final()])
  } finally {
    partial.fill(0)
  }
}

function scrub(ring: Keyring): void {
  for (const material of ring.values()) material.fill(0)
  ring.clear()
}

function encodeRing(ring: Keyring): Buffer {
  if (ring.size < 1 || ring.size > MAX_VERSIONS) refuse()
  const result = Buffer.alloc(2 + ring.size * 100)
  result.writeUInt16BE(ring.size)
  let offset = 2
  for (const [id, material] of ring) {
    result.write(uuid(id), offset, 36, 'ascii')
    material.copy(result, offset + 36)
    offset += 100
  }
  return result
}

function decodeRing(plain: Buffer): Keyring {
  const ring: Keyring = new Map()
  try {
    if (plain.length < 2) refuse()
    const count = plain.readUInt16BE()
    if (count < 1 || count > MAX_VERSIONS || plain.length !== 2 + count * 100) refuse()
    for (let offset = 2; offset < plain.length; offset += 100) {
      const id = uuid(plain.subarray(offset, offset + 36).toString('utf8'))
      if (ring.has(id)) refuse()
      ring.set(id, Buffer.from(plain.subarray(offset + 36, offset + 100)))
    }
    return ring
  } catch (error) {
    scrub(ring)
    throw error
  }
}

function backupRing(custodyId: string, ring: Keyring, secret: Uint8Array): Uint8Array {
  const key = bytes(secret, 32)
  let plain: Buffer | undefined
  try {
    plain = encodeRing(ring)
    const sealed = seal(key, plain, context('backup', custodyId))
    return Buffer.from(JSON.stringify({
      version: 1, assurance: 'local-v1', custodyId,
      nonce: sealed.subarray(0, 12).toString('base64'),
      ciphertext: sealed.subarray(12, -16).toString('base64'),
      tag: sealed.subarray(-16).toString('base64'),
    }))
  } finally {
    key.fill(0)
    plain?.fill(0)
  }
}

function base64(value: unknown): Buffer {
  if (typeof value !== 'string') refuse()
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) refuse()
  return decoded
}

function restoreRing(custodyId: string, backup: Uint8Array, secret: Uint8Array): Keyring {
  if (!(backup instanceof Uint8Array) || backup.byteLength > MAX_BACKUP) refuse()
  const value = JSON.parse(Buffer.from(backup).toString()) as Record<string, unknown>
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'assurance,ciphertext,custodyId,nonce,tag,version') refuse()
  if (value.version !== 1 || value.assurance !== 'local-v1' || value.custodyId !== custodyId) refuse()
  const nonce = base64(value.nonce)
  const tag = base64(value.tag)
  const ciphertext = base64(value.ciphertext)
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 102 || ciphertext.length > 2 + MAX_VERSIONS * 100) refuse()
  const key = bytes(secret, 32)
  let plain: Buffer | undefined
  try {
    plain = open(key, Buffer.concat([nonce, ciphertext, tag]), context('backup', custodyId))
    return decodeRing(plain)
  } finally {
    key.fill(0)
    plain?.fill(0)
  }
}

/** Explicit provisioning produces encrypted bytes only; it never saves a key or unlocks a session. */
export function createLocalCustodyBackup(input: {
  custodyId: string
  recoverySecret: Uint8Array
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}): Uint8Array {
  return guarded(input.transactionDepth, () => {
    const custodyId = uuid(input.custodyId)
    const ring: Keyring = new Map([[randomUUID(), randomBytes(64)]])
    try {
      return backupRing(custodyId, ring, input.recoverySecret)
    } finally {
      scrub(ring)
    }
  })
}

export interface LocalWrappedDek {
  keyId: string
  wrappedId: string
  wrapped: Uint8Array
}

/** Local assurance is NOT the format-v1 KMS adapter. No startup or implicit fallback wiring. */
export function createLocalCustodySession(probe: RecoveryArchiveTransactionDepthProbe) {
  let ring: Keyring = new Map()
  let custodyId: string | null = null
  let epoch = 0
  const activeKey = () => {
    if (!custodyId || ring.size === 0) refuse()
    return [...ring.keys()][ring.size - 1]
  }
  const key = (id: string) => {
    if (!custodyId) refuse()
    const material = ring.get(uuid(id))
    if (!material) refuse()
    return material
  }
  const aad = (generationId: string, request: LocalWrappedDek) => context(
    'dek', custodyId!, uuid(request.keyId), uuid(generationId), uuid(request.wrappedId),
  )
  const mac = (keyId: string, preimage: Uint8Array) => {
    const material = key(keyId)
    if (!(preimage instanceof Uint8Array) || preimage.byteLength > 16 * 1024 * 1024) refuse()
    return createHmac('sha256', material.subarray(32)).update(context('manifest', custodyId!, keyId)).update(preimage).digest()
  }
  const session = Object.freeze({
    assurance: 'local-v1' as const,
    isUnlocked: () => custodyId !== null,
    lock() {
      epoch++
      scrub(ring)
      custodyId = null
    },
    unlock(input: { custodyId: string; backup: Uint8Array; recoverySecret: Uint8Array }) {
      return guarded(probe, () => {
        if (custodyId) refuse()
        const id = uuid(input.custodyId)
        const restored = restoreRing(id, input.backup, input.recoverySecret)
        ring = restored
        custodyId = id
      })
    },
    exportRotatedBackup(recoverySecret: Uint8Array) {
      return guarded(probe, () => {
        activeKey()
        if (ring.size >= MAX_VERSIONS) refuse()
        const next = new Map([...ring].map(([id, material]) => [id, Buffer.from(material)]))
        try {
          next.set(randomUUID(), randomBytes(64))
          return backupRing(custodyId!, next, recoverySecret)
        } finally {
          scrub(next)
        }
      })
    },
    issueLocalDek(generationId: string): LocalWrappedDek & { dek: Uint8Array } {
      return guarded(probe, () => {
        uuid(generationId)
        const keyId = activeKey()
        const dek = randomBytes(32)
        try {
          const descriptor = { keyId, wrappedId: randomUUID(), wrapped: new Uint8Array() }
          return { ...descriptor, wrapped: seal(key(keyId).subarray(0, 32), dek, aad(generationId, descriptor)), dek: Buffer.from(dek) }
        } finally {
          dek.fill(0)
        }
      })
    },
    openLocalDek(input: LocalWrappedDek & { generationId: string }): Uint8Array {
      return guarded(probe, () => open(key(input.keyId).subarray(0, 32), bytes(input.wrapped, 60), aad(input.generationId, input)))
    },
    localDekIdentity(dek: Uint8Array): string {
      return guarded(probe, () => {
        activeKey()
        const copy = bytes(dek, 32)
        try {
          return createHash('sha256').update(context('actual-dek-identity')).update(copy).digest('hex')
        } finally {
          copy.fill(0)
        }
      })
    },
    signLocalManifest(keyId: string, preimage: Uint8Array): Uint8Array {
      return guarded(probe, () => mac(keyId, preimage))
    },
    verifyLocalManifest(keyId: string, preimage: Uint8Array, signature: Uint8Array): boolean {
      return guarded(probe, () => {
        const expected = mac(keyId, preimage)
        return signature instanceof Uint8Array && signature.byteLength === 32 && timingSafeEqual(expected, signature)
      })
    },
    admitForArchive(expectedCustodyId: string): LocalArchiveCustodyAdmission {
      return guarded(probe, () => {
        const active = activeKey()
        if (uuid(expectedCustodyId) !== custodyId) refuse()
        const admittedEpoch = epoch
        const prefix = `local-v1:${custodyId}:`
        const parse = (id: string) => {
          if (epoch !== admittedEpoch || custodyId !== expectedCustodyId || typeof id !== 'string' || !id.startsWith(prefix)) refuse()
          const localId = uuid(id.slice(prefix.length))
          key(localId)
          return localId
        }
        const capability: LocalArchiveCustodyAdmission = Object.freeze({
          assurance: 'local-v1', custodyId: expectedCustodyId, keyId: `${prefix}${active}`, [admissionBrand]: true as const,
        })
        admissions.set(capability, Object.freeze({
          async produceGenerationDek(request) {
            return guarded(probe, () => {
              if (parse(request.keyId) !== activeKey()) refuse()
              const issued = session.issueLocalDek(request.generationId)
              return { dek: issued.dek, wrappedDekId: issued.wrappedId, wrappedDek: issued.wrapped }
            })
          },
          async unwrapGenerationDek(request) {
            return guarded(probe, () => ({
              dek: session.openLocalDek({ keyId: parse(request.keyId), generationId: request.generationId, wrappedId: request.wrappedDekId, wrapped: request.wrappedDek }),
              wrappedDekId: request.wrappedDekId, wrappedDek: new Uint8Array(request.wrappedDek),
            }))
          },
          async deriveDekFingerprint(request) {
            return guarded(probe, () => { parse(request.keyId); return session.localDekIdentity(request.dek) })
          },
          async macManifestRoot(request) {
            return guarded(probe, () => session.signLocalManifest(parse(request.keyId), request.preimage))
          },
          async verifyManifestRootMac(request) {
            return guarded(probe, () => session.verifyLocalManifest(parse(request.keyId), request.preimage, request.mac))
          },
        }))
        releases.set(capability, () => {
          if (epoch === admittedEpoch) session.lock()
        })
        return capability
      })
    },
  })
  return session
}
