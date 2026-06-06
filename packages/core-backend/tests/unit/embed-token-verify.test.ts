import { describe, it, expect } from 'vitest'
import { verifyEmbedToken, EmbedTokenError } from '../../src/auth/embed-token-verify'

// CROSS-LANGUAGE VECTOR: this token + public key were produced by the REAL Yuantus P3-D1 Python
// minter (`yuantus.security.auth.jwt.encode_eddsa`) with a fixed 32-byte seed. Verifying it here
// proves node:crypto accepts a Python-signed Ed25519 JWT (sorted-keys compact JSON, unpadded
// base64url, signature over `header_b64.payload_b64`) — a node↔node roundtrip would NOT.
const PUB = 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg='
const KID = 'embed-1'
const TOKEN =
  'eyJhbGciOiJFZERTQSIsImtpZCI6ImVtYmVkLTEiLCJ0eXAiOiJKV1QifQ' +
  '.eyJhdWQiOiJtZXRhc2hlZXQyLmVtYmVkIiwiZW1iZWRfb3JpZ2luIjoiaHR0cHM6Ly9wbG0uZXhhbXBsZS5jb20iLCJleHAiOjE3NTAwMDAxMjAsImZlYXR1cmVfa2V5IjoiYm9tX211bHRpdGFibGUiLCJpYXQiOjE3NTAwMDAwMDAsImp0aSI6InRlc3QtanRpLTEyMyIsIm9yZ19pZCI6ImFjbWUiLCJwYXJ0X2lkIjoiUDEiLCJzdWIiOiI3IiwidGVuYW50X2lkIjoiZGVmYXVsdCIsInR5cCI6ImVtYmVkIn0' +
  '.LoRjz4keK-gF3fwBpyv4v2geru0cQsKe_75Mn4mRyo_lhyy9LC2X5EpE0ebaYqJF6bDw8XfwoBvkjK0PMEtwCw'
const KEYS = { [KID]: PUB }
const AUD = 'metasheet2.embed'
const NOW = 1750000050 // before exp (1750000120)

describe('verifyEmbedToken (P3-D2 cross-language EdDSA offline verify)', () => {
  it('verifies a token minted by the REAL Yuantus Python minter and returns the claims', () => {
    const claims = verifyEmbedToken(TOKEN, { publicKeysByKid: KEYS, audience: AUD, now: NOW })
    expect(claims.part_id).toBe('P1')
    expect(claims.aud).toBe(AUD)
    expect(claims.typ).toBe('embed')
    expect(claims.embed_origin).toBe('https://plm.example.com')
    expect(claims.tenant_id).toBe('default')
    expect(claims.feature_key).toBe('bom_multitable')
  })

  it('rejects a wrong audience', () => {
    expect(() => verifyEmbedToken(TOKEN, { publicKeysByKid: KEYS, audience: 'someone.else', now: NOW })).toThrow(EmbedTokenError)
  })

  it('rejects an expired token', () => {
    expect(() => verifyEmbedToken(TOKEN, { publicKeysByKid: KEYS, audience: AUD, now: 1750009999 })).toThrow(/expired/)
  })

  it('rejects an unknown kid', () => {
    expect(() => verifyEmbedToken(TOKEN, { publicKeysByKid: { 'other-kid': PUB }, audience: AUD, now: NOW })).toThrow(/key id/)
  })

  it('rejects a tampered signature', () => {
    const [h, p] = TOKEN.split('.')
    const tampered = `${h}.${p}.${'A'.repeat(86)}`
    expect(() => verifyEmbedToken(tampered, { publicKeysByKid: KEYS, audience: AUD, now: NOW })).toThrow(/signature/)
  })

  it('rejects a swapped payload (signature is over the RECEIVED bytes, not re-serialized claims)', () => {
    const [h, , s] = TOKEN.split('.')
    const evilPayload = Buffer.from(
      JSON.stringify({ aud: AUD, typ: 'embed', part_id: 'HACKED', exp: 9999999999 }),
    ).toString('base64url')
    const tampered = `${h}.${evilPayload}.${s}`
    expect(() => verifyEmbedToken(tampered, { publicKeysByKid: KEYS, audience: AUD, now: NOW })).toThrow(/signature/)
  })

  it('rejects a wrong typ', () => {
    expect(() => verifyEmbedToken(TOKEN, { publicKeysByKid: KEYS, audience: AUD, now: NOW, expectedTyp: 'auth' })).toThrow(/token type/)
  })

  it('rejects a malformed token', () => {
    expect(() => verifyEmbedToken('not.a.jwt.token', { publicKeysByKid: KEYS, audience: AUD, now: NOW })).toThrow(EmbedTokenError)
  })
})
