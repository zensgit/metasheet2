import { createHash } from 'node:crypto'
import {
  createTransactionGuardedKeyCustody,
  RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveTransactionDepthProbe,
} from './recovery-archive-crypto'
import { createRecoveryResourceHttps, decodeRecoveryResourceBase64, type RecoveryResourceHttpsOptions } from './recovery-resource-https'

export interface RecoveryOpenBaoCustodyOptions extends RecoveryResourceHttpsOptions {
  keyId: string
  wrappingKey: string
  fingerprintKey: string
  fingerprintKeyVersion: number
  manifestKey: string
  manifestKeyVersion: number
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const NAME = /^[A-Za-z0-9_-]{1,128}$/
const ERROR = 'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED'
function refuse(): never { throw new Error(ERROR) }
function wrappedId(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
function text(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString('utf8')
  if (!Buffer.from(value).equals(Buffer.from(bytes))) refuse()
  return value
}
function transitValue(value: unknown, exactVersion?: number): { value: string; version: number; digest: Buffer } {
  if (typeof value !== 'string') refuse()
  const match = /^vault:v([1-9][0-9]{0,5}):(.+)$/.exec(value)
  if (!match || (exactVersion !== undefined && Number(match[1]) !== exactVersion)) refuse()
  const digest = decodeRecoveryResourceBase64(match[2], 8192)
  return { value, version: Number(match[1]), digest }
}

/** Candidate for one staging key; constructing this adapter performs no external IO. */
export function createRecoveryOpenBaoCustody(options: RecoveryOpenBaoCustodyOptions): RecoveryArchiveKeyCustodyAdapter {
  try {
    const { keyId, wrappingKey, fingerprintKey, fingerprintKeyVersion, manifestKey, manifestKeyVersion, transactionDepth } = options
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)
      || [wrappingKey, fingerprintKey, manifestKey].some(n => typeof n !== 'string' || !NAME.test(n))
      || new Set([wrappingKey, fingerprintKey, manifestKey]).size !== 3
      || [fingerprintKeyVersion, manifestKeyVersion].some(n => !Number.isSafeInteger(n) || n < 1 || n > 999999)) refuse()
    const post = createRecoveryResourceHttps(options, 'x-vault-token')
    const admit = (requestKey: string) => { if (requestKey !== keyId) refuse() }
    const aad = (requestKey: string, generationId: string) => {
      admit(requestKey)
      if (!UUID.test(generationId)) refuse()
      return Buffer.from(JSON.stringify(['metasheet.recovery-archive.openbao-wrap.v1', keyId, generationId])).toString('base64')
    }
    const call = async (path: string, input: object): Promise<Record<string, unknown>> => {
      const result = await post(`/v1/transit/${path}`, input)
      if (!result || typeof result !== 'object' || Array.isArray(result) || !('data' in result)
        || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) refuse()
      return result.data as Record<string, unknown>
    }
    const macInput = (preimage: Uint8Array) => {
      if (!(preimage instanceof Uint8Array) || !preimage.length || preimage.length > 32768) refuse()
      return Buffer.from(preimage).toString('base64')
    }
    const adapter: RecoveryArchiveKeyCustodyAdapter = {
      async produceGenerationDek(request) {
        const data = await call(`datakey/plaintext/${wrappingKey}`, { bits: 256, associated_data: aad(request.keyId, request.generationId) })
        const dek = decodeRecoveryResourceBase64(data.plaintext, 32)
        try {
          if (dek.length !== 32) refuse()
          const ciphertext = transitValue(data.ciphertext).value
          const wrappedDek = Buffer.from(ciphertext)
          return { dek: new Uint8Array(dek), wrappedDekId: wrappedId(wrappedDek), wrappedDek }
        } finally { dek.fill(0) }
      },
      async unwrapGenerationDek(request) {
        const associated_data = aad(request.keyId, request.generationId)
        const bytes = new Uint8Array(request.wrappedDek)
        if (!bytes.length || bytes.length > 16384 || wrappedId(bytes) !== request.wrappedDekId) refuse()
        const ciphertext = transitValue(text(bytes)).value
        const data = await call(`decrypt/${wrappingKey}`, { ciphertext, associated_data })
        const dek = decodeRecoveryResourceBase64(data.plaintext, 32)
        try {
          if (dek.length !== 32) refuse()
          return { dek: new Uint8Array(dek), wrappedDekId: request.wrappedDekId, wrappedDek: bytes }
        } finally { dek.fill(0) }
      },
      async deriveDekFingerprint(request) {
        admit(request.keyId)
        const input = Buffer.concat([Buffer.from(RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN + '\0'), Buffer.from(request.dek)])
        try {
          const data = await call(`hmac/${fingerprintKey}/sha2-256`, { input: input.toString('base64'), key_version: fingerprintKeyVersion })
          const { digest } = transitValue(data.hmac, fingerprintKeyVersion)
          if (digest.length !== 32) refuse()
          return digest.toString('hex')
        } finally { input.fill(0) }
      },
      async macManifestRoot(request) {
        admit(request.keyId)
        const data = await call(`hmac/${manifestKey}/sha2-256`, { input: macInput(request.preimage), key_version: manifestKeyVersion })
        const result = transitValue(data.hmac, manifestKeyVersion)
        if (result.digest.length !== 32) refuse()
        return Buffer.from(result.value)
      },
      async verifyManifestRootMac(request) {
        admit(request.keyId)
        const hmac = transitValue(text(request.mac))
        if (hmac.version > manifestKeyVersion || hmac.digest.length !== 32) refuse()
        const data = await call(`verify/${manifestKey}/sha2-256`, { input: macInput(request.preimage), hmac: hmac.value })
        if (typeof data.valid !== 'boolean') refuse()
        return data.valid
      },
    }
    return createTransactionGuardedKeyCustody(adapter, transactionDepth)
  } catch { return refuse() }
}
