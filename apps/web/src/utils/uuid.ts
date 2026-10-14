/**
 * The ONE place in apps/web/src that may touch `crypto.randomUUID`.
 *
 * Why: `crypto.randomUUID` is only exposed in a secure context (HTTPS or localhost). A deployment
 * reached over plain HTTP by IP — e.g. a customer intranet — has `isSecureContext === false`, so
 * `crypto.randomUUID` is `undefined` there while `crypto.getRandomValues` (not secure-context gated)
 * still works. Call sites that used `crypto.randomUUID` directly failed before sending any request.
 *
 * Contract:
 *   1. `crypto.randomUUID()` when it is a function (looked up on every call, so test spies on
 *      `globalThis.crypto.randomUUID` keep working). Errors it throws are NOT swallowed.
 *   2. Otherwise an RFC 4122 version-4 UUID built from `crypto.getRandomValues` (CSPRNG).
 *   3. Neither available: throw `UuidUnavailableError`. There is deliberately NO Math.random
 *      fallback — request ids / idempotency keys / nonces must not silently become predictable.
 *
 * Guarded by apps/web/tests/uuid-no-bare-randomuuid.spec.ts (no other file in src may mention the
 * native API name).
 */

export class UuidUnavailableError extends Error {
  constructor() {
    super('No Web Crypto random source available (neither crypto.randomUUID nor crypto.getRandomValues)')
    this.name = 'UuidUnavailableError'
  }
}

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T
}

export function randomUuid(): string {
  const cryptoApi = (globalThis as { crypto?: CryptoLike }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx (RFC 4122)
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new UuidUnavailableError()
}
