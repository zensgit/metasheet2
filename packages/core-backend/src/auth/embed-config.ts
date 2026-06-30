/**
 * PLM-COLLAB-P3-D2 embed config. PLM_EMBED_ALLOWED_ORIGINS is the SINGLE source for all three
 * origin layers (the backend embed_origin-claim check, the CSP frame-ancestors value served to
 * the edge, and the frontend postMessage parent-origin allowlist) so they can't drift apart.
 */

/** CSV allowlist of embed origins; a literal '*' is DROPPED (never allow-all, mirrors the mint side). */
export function embedAllowedOrigins(): string[] {
  return (process.env.PLM_EMBED_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*')
}

/** CSP frame-ancestors value. Fail CLOSED when unconfigured: 'none' (the iframe won't render). */
export function frameAncestorsValue(): string {
  const origins = embedAllowedOrigins()
  return origins.length ? `frame-ancestors ${origins.join(' ')}` : "frame-ancestors 'none'"
}

function parsePublicKeysMap(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .map(([kid, pub]) => [kid.trim(), typeof pub === 'string' ? pub.trim() : ''] as const)
      .filter(([kid, pub]) => kid && pub),
  )
}

/** kid -> base64 raw Ed25519 PUBLIC key (Yuantus distributes public keys by deploy config). */
export function embedPublicKeysByKid(): Record<string, string> {
  const map = (process.env.YUANTUS_EMBED_PUBLIC_KEYS || '').trim()
  if (map) {
    return parsePublicKeysMap(map)
  }

  const pub = (process.env.YUANTUS_EMBED_PUBLIC_KEY || '').trim()
  const kid = (process.env.YUANTUS_EMBED_KEY_ID || 'embed-1').trim()
  return pub ? { [kid]: pub } : {}
}

/** The expected JWT `aud` (recipient SERVICE) for standard audience validation. */
export function embedAudience(): string {
  return (process.env.PLM_EMBED_AUDIENCE || 'metasheet2.embed').trim() || 'metasheet2.embed'
}

/** The SERVER-configured PLM data source the embed is bound to (NEVER taken from the request). */
export function embedDataSourceId(): string {
  return (process.env.PLM_EMBED_DATA_SOURCE_ID || '').trim()
}
