/**
 * PLM-COLLAB-P3-D2: offline verification of a Yuantus-issued Ed25519 (EdDSA) embed token.
 *
 * The Yuantus deployment signs the token with its PRIVATE key (PLM-COLLAB-P3-D1); metasheet2
 * verifies OFFLINE with the matching PUBLIC key (kid-addressed) and therefore can never mint.
 * We verify the signature over the RECEIVED `header_b64.payload_b64` bytes (NEVER re-serialized
 * claims — the classic JWT bug), then check aud / typ / exp / part_id. EdDSA over Ed25519 is
 * verified via node:crypto (no jose dep): a raw 32-byte public key -> JWK -> KeyObject ->
 * crypto.verify(null, ...). This is wire-compatible with the Python minter (cross-language
 * vector test pins it).
 */
import crypto from 'node:crypto'

export interface EmbedTokenClaims {
  sub?: string
  tenant_id?: string
  org_id?: string
  part_id: string
  feature_key?: string
  aud?: string
  embed_origin?: string
  exp?: number
  iat?: number
  jti?: string
  typ?: string
  [key: string]: unknown
}

export class EmbedTokenError extends Error {}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/** A raw base64 (standard) Ed25519 public key (32 bytes) -> a node KeyObject via JWK. */
function loadEd25519PublicKey(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64, 'base64')
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  })
}

export interface VerifyEmbedTokenOptions {
  publicKeysByKid: Record<string, string> // kid -> base64 raw Ed25519 public key
  audience: string
  now?: number // unix seconds; defaults to Date.now()/1000 (injectable for tests)
  expectedTyp?: string // default "embed"
}

export function verifyEmbedToken(token: string, opts: VerifyEmbedTokenOptions): EmbedTokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new EmbedTokenError('malformed token')
  const [headerB64, payloadB64, sigB64] = parts

  let header: Record<string, unknown>
  let claims: EmbedTokenClaims
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8')) as Record<string, unknown>
    claims = JSON.parse(b64urlToBuf(payloadB64).toString('utf8')) as EmbedTokenClaims
  } catch {
    throw new EmbedTokenError('invalid token encoding')
  }

  if (header.alg !== 'EdDSA') throw new EmbedTokenError('unsupported alg')
  const kid = typeof header.kid === 'string' ? header.kid : ''
  const pubB64 = kid ? opts.publicKeysByKid[kid] : undefined
  if (!kid || !pubB64) throw new EmbedTokenError('unknown key id')

  // verify over the RECEIVED header.payload bytes (never re-serialized)
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii')
  let key: crypto.KeyObject
  try {
    key = loadEd25519PublicKey(pubB64)
  } catch {
    throw new EmbedTokenError('invalid public key')
  }
  let ok = false
  try {
    ok = crypto.verify(null, signingInput, key, b64urlToBuf(sigB64))
  } catch {
    ok = false
  }
  if (!ok) throw new EmbedTokenError('invalid signature')

  // claim checks (standard audience + embed type + REQUIRED expiry + required part binding)
  if (claims.aud !== opts.audience) throw new EmbedTokenError('wrong audience')
  if (claims.typ !== (opts.expectedTyp ?? 'embed')) throw new EmbedTokenError('wrong token type')
  // exp MUST be a finite number -- a missing/non-numeric exp would make the token never expire,
  // breaking the P3-D short-TTL contract.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new EmbedTokenError('missing or invalid exp')
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (now > claims.exp) throw new EmbedTokenError('token expired')
  if (typeof claims.part_id !== 'string' || !claims.part_id) throw new EmbedTokenError('missing part_id')

  return claims
}
