/**
 * Time Machine D2: canonical recovery-archive manifest-object envelope v1.
 *
 * This module wraps an already-signed canonical `manifest_json` together with
 * nonempty canonical-base64 wrapped-DEK bytes. The inner RecoveryArchiveManifest
 * v1 object is unchanged: wrapped bytes never become a manifest field. The
 * envelope bytes and their SHA-256 are the durable payload for the existing
 * single manifest object descriptor.
 *
 * No database, KMS, vendor, route, flag, or production-caller work.
 */

import { createHash } from 'node:crypto'

import {
  canonicalizeRecoveryArchiveJson,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifest,
} from './recovery-archive-manifest'

/** Closed envelope version. Distinct from RecoveryArchiveManifest.format_version. */
export const RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION = 1 as const

/** Exact ordered JSON key set. JCS already sorts this the same way. */
export const RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS = [
  'envelope_version',
  'manifest_json',
  'wrapped_dek',
] as const

const BUILD_INPUT_KEYS = ['manifestJson', 'wrappedDek'] as const

/** RFC 4648 standard base64 with required padding; nonempty (at least one quantum). */
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/

export type RecoveryArchiveManifestObjectEnvelopeErrorCode =
  | 'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE'
  | 'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST'
  | 'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK'
  | 'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_NONCANONICAL'

/** Values-free envelope refusal. Message is the closed code; no wrap bytes, key, or cause. */
export class RecoveryArchiveManifestObjectEnvelopeError extends Error {
  readonly code: RecoveryArchiveManifestObjectEnvelopeErrorCode

  constructor(code: RecoveryArchiveManifestObjectEnvelopeErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveManifestObjectEnvelopeError'
    this.code = code
  }
}

export interface RecoveryArchiveManifestObjectEnvelopeResult {
  readonly envelopeVersion: typeof RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION
  readonly manifest: RecoveryArchiveManifest
  readonly manifestJson: string
  readonly wrappedDek: Uint8Array
  readonly envelopeBytes: Uint8Array
  readonly envelopeSha256: string
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Build the exact v1 envelope over one already-signed canonical manifest JSON
 * string plus nonempty wrapped-DEK bytes.
 */
export function buildRecoveryArchiveManifestObjectEnvelope(
  input: unknown,
): RecoveryArchiveManifestObjectEnvelopeResult {
  const admitted = snapshotExactRecord(
    input,
    BUILD_INPUT_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
    new Set(['wrappedDek']),
  )
  const wrappedDek = snapshotNonEmptyBytes(
    admitted.wrappedDek,
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK',
  )
  const manifestJson = admitSignedCanonicalManifestJson(admitted.manifestJson)
  return createEnvelopeResult(manifestJson.manifest, manifestJson.json, wrappedDek)
}

/**
 * Parse exact v1 envelope bytes. Re-canonicalization must match the admitted
 * bytes; extra, missing, accessor, sparse, noncanonical, and unsigned forms
 * refuse. Returned byte fields are defensive copies.
 */
export function parseRecoveryArchiveManifestObjectEnvelope(
  bytes: unknown,
): RecoveryArchiveManifestObjectEnvelopeResult {
  const admittedBytes = snapshotNonEmptyBytes(
    bytes,
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT',
  )
  let decoded: string
  try {
    decoded = utf8Decoder.decode(admittedBytes)
  } catch {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_INPUT')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE')
  }

  const admitted = snapshotExactRecord(
    parsed,
    RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_JSON_KEYS,
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
  )
  if (admitted.envelope_version !== RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE')
  }
  const wrappedDek = decodeCanonicalBase64(admitted.wrapped_dek)
  const manifestJson = admitSignedCanonicalManifestJson(admitted.manifest_json)
  const result = createEnvelopeResult(manifestJson.manifest, manifestJson.json, wrappedDek)
  if (!bytesEqual(result.envelopeBytes, admittedBytes)) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_NONCANONICAL')
  }
  return result
}

function admitSignedCanonicalManifestJson(value: unknown): {
  manifest: RecoveryArchiveManifest
  json: string
} {
  if (typeof value !== 'string' || value.length === 0) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST')
  }
  const manifest = callClosed(
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    () => validateRecoveryArchiveManifest(parsed),
  )
  if (manifest.manifest_mac === null) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST')
  }
  const json = callClosed(
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST',
    () => canonicalizeRecoveryArchiveJson(manifest),
  )
  if (json !== value) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_MANIFEST')
  }
  return { manifest, json }
}

function createEnvelopeResult(
  manifest: RecoveryArchiveManifest,
  manifestJson: string,
  wrappedDek: Uint8Array,
): RecoveryArchiveManifestObjectEnvelopeResult {
  const wrappedDekSnapshot = new Uint8Array(wrappedDek)
  const wrappedDekBase64 = encodeCanonicalBase64(wrappedDekSnapshot)
  const envelopeJson = callClosed(
    'RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE',
    () =>
      canonicalizeRecoveryArchiveJson({
        envelope_version: RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION,
        manifest_json: manifestJson,
        wrapped_dek: wrappedDekBase64,
      }),
  )
  const envelopeBytes = utf8Encoder.encode(envelopeJson)
  if (envelopeBytes.byteLength === 0) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_SHAPE')
  }
  const envelopeSha256 = createHash('sha256').update(envelopeBytes).digest('hex')
  const frozenManifest = Object.freeze({
    ...manifest,
    sections: Object.freeze(manifest.sections.map((section) => Object.freeze({ ...section }))),
  }) as RecoveryArchiveManifest
  return Object.freeze({
    envelopeVersion: RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_VERSION,
    manifest: frozenManifest,
    manifestJson,
    get wrappedDek() {
      return new Uint8Array(wrappedDekSnapshot)
    },
    get envelopeBytes() {
      return new Uint8Array(envelopeBytes)
    },
    envelopeSha256,
  })
}

function encodeCanonicalBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('base64')
  if (encoded.length === 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK')
  }
  return encoded
}

function decodeCanonicalBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !CANONICAL_BASE64_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK')
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK')
  }
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    fail('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_INVALID_WRAPPED_DEK')
  }
  const snapshot = new Uint8Array(decoded.byteLength)
  Uint8Array.prototype.set.call(snapshot, decoded)
  return snapshot
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: RecoveryArchiveManifestObjectEnvelopeErrorCode,
  accessorKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(errorCode)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(errorCode)
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length) fail(errorCode)

    const expected = new Set(expectedKeys)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string' || !expected.has(key)) fail(errorCode)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) fail(errorCode)
      if ('value' in descriptor) {
        snapshot[key] = descriptor.value
      } else if (
        accessorKeys.has(key) &&
        typeof descriptor.get === 'function' &&
        descriptor.set === undefined
      ) {
        snapshot[key] = Reflect.get(value, key)
      } else {
        fail(errorCode)
      }
    }
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function snapshotNonEmptyBytes(
  value: unknown,
  errorCode: RecoveryArchiveManifestObjectEnvelopeErrorCode,
): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) fail(errorCode)
    if (value.byteLength === 0) fail(errorCode)
    const snapshot = new Uint8Array(value.byteLength)
    Uint8Array.prototype.set.call(snapshot, value)
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function callClosed<T>(
  errorCode: RecoveryArchiveManifestObjectEnvelopeErrorCode,
  run: () => T,
): T {
  try {
    return run()
  } catch {
    fail(errorCode)
  }
}

function fail(code: RecoveryArchiveManifestObjectEnvelopeErrorCode): never {
  throw new RecoveryArchiveManifestObjectEnvelopeError(code)
}
