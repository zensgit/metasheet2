/**
 * PLM-COLLAB-P3-D2 embed config. PLM_EMBED_ALLOWED_ORIGINS is the configured list for all three
 * origin layers (the backend embed_origin-claim check, the CSP frame-ancestors value served to
 * the edge, and the frontend postMessage parent-origin allowlist) so they can't drift apart.
 *
 * PLM_EMBED_SAME_ORIGIN (exact 'true') is the combined-deployment switch from Yuantus #443:
 * the parent embed follows window.location.origin, which changes when the gateway hostname
 * changes. While it is on, an embed origin is also accepted when it is this request's own
 * origin. The configured list is unchanged. The flag does not accept a foreign origin.
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

/**
 * Combined same-origin embed mode. Exact literal 'true' only (no trim, no case folding).
 * Yuantus #443 documents this name and sets it on the shared gateway deployment; MetaSheet
 * reads the same variable.
 */
export function isPlmEmbedSameOrigin(): boolean {
  return process.env.PLM_EMBED_SAME_ORIGIN === 'true'
}

/** Minimal request view so origin checks do not depend on a concrete Express class. */
export interface EmbedRequestView {
  protocol: string
  headers: NodeJS.Dict<string | string[] | undefined>
  get?(name: string): string | undefined
}

interface ResolvedOwnOrigin {
  origin: string
  /** X-Forwarded-Host named a different host than Host, and Host was an internal upstream. */
  forwardedHostAdopted: boolean
  /** undefined: Origin header absent. null: present but not a single canonical origin. */
  statedOrigin: string | null | undefined
}

function headerRaw(req: EmbedRequestView, name: string): string | string[] | undefined {
  const fromGetter = req.get?.(name)
  if (typeof fromGetter === 'string') return fromGetter
  return req.headers[name.toLowerCase()]
}

/** One header field. A comma-separated chain or a multi-value array is ambiguous, not a choice. */
function singleField(value: string | string[] | undefined): { present: boolean; value?: string } {
  if (value === undefined) return { present: false }
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') return { present: true }
    value = value[0]
  }
  if (typeof value !== 'string') return { present: true }
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes(',')) return { present: true }
  return { present: true, value: trimmed }
}

/** Browser origin form, or null when the value is not an http(s) origin. */
export function canonicalOrigin(value: string): string | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 300) return null
  if (value !== value.trim() || value.includes('\\')) return null
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

function hostIsInternal(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1') return true
  if (!host.includes('.')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map((part) => Number(part))
  if (parts.some((part) => part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Origin of this request as MetaSheet sees it behind the gateway.
 *
 * The public host is the Host header the gateway accepted. docker/nginx.conf forwards
 * $http_host (port kept) and the incoming X-Forwarded-Proto when the outer gateway set one.
 * X-Forwarded-Proto may supply a single http or https scheme after TLS termination.
 * A differing X-Forwarded-Host is ignored when Host is already a public name, so a caller
 * cannot rename the request onto a foreign origin. It is used only when Host is an internal
 * upstream (localhost, a single-label service name, or a private address) and the forwarded
 * proto is a single scheme — the shape a tunnel uses when it preserves the browser host in
 * X-Forwarded-Host. A comma-separated forwarded proto is ambiguous and yields no origin.
 * The HTTP Origin header is never treated as this value.
 */
export function resolveOwnOrigin(req: EmbedRequestView): ResolvedOwnOrigin | null {
  const hostField = singleField(headerRaw(req, 'host'))
  if (!hostField.value) return null
  const forwardedProto = singleField(headerRaw(req, 'x-forwarded-proto'))
  let proto: 'http' | 'https' | null = null
  if (forwardedProto.value === 'http' || forwardedProto.value === 'https') proto = forwardedProto.value
  else if (forwardedProto.present) return null
  else if (req.protocol === 'http' || req.protocol === 'https') proto = req.protocol
  if (!proto) return null

  const direct = canonicalOrigin(`${proto}://${hostField.value}`)
  if (!direct) return null
  const directHost = new URL(direct).hostname

  let origin = direct
  let forwardedHostAdopted = false
  const forwardedHost = singleField(headerRaw(req, 'x-forwarded-host'))
  if (forwardedHost.value) {
    const forwarded = canonicalOrigin(`${proto}://${forwardedHost.value}`)
    if (forwarded) {
      const forwardedName = new URL(forwarded).hostname
      if (forwardedName === directHost) {
        if (forwarded !== direct) return null
        origin = direct
      } else if (forwardedProto.value && hostIsInternal(directHost)) {
        origin = forwarded
        forwardedHostAdopted = true
      }
    }
  }

  const statedField = singleField(headerRaw(req, 'origin'))
  let statedOrigin: string | null | undefined
  if (!statedField.present) statedOrigin = undefined
  else statedOrigin = statedField.value ? canonicalOrigin(statedField.value) : null
  if (statedField.value && statedOrigin !== statedField.value) statedOrigin = null

  return { origin, forwardedHostAdopted, statedOrigin }
}

/** Public origin string, or null when the host/proto pair is missing or ambiguous. */
export function requestOwnOrigin(req: EmbedRequestView): string | null {
  return resolveOwnOrigin(req)?.origin ?? null
}

/**
 * Allow-list match is exact and ignores the request, flag on or off.
 * The same-origin exception requires the claim to be this request's own origin.
 * A present Origin header must be that same origin. When the public host was taken from
 * X-Forwarded-Host, the Origin header is required, so a cross-origin caller cannot adopt
 * a forwarded host by omitting Origin. `observedOverride` is the origin a caller already
 * resolved (the adapter re-check); header policy is then the caller's.
 */
export function isEmbedOriginAllowed(
  embedOrigin: unknown,
  req: EmbedRequestView | null = null,
  observedOverride?: string | null,
): boolean {
  if (typeof embedOrigin !== 'string' || !embedOrigin) return false
  if (embedAllowedOrigins().includes(embedOrigin)) return true
  if (!isPlmEmbedSameOrigin()) return false
  if (observedOverride !== undefined) {
    return Boolean(observedOverride) && canonicalOrigin(embedOrigin) === observedOverride
  }
  const resolved = req ? resolveOwnOrigin(req) : null
  if (!resolved || canonicalOrigin(embedOrigin) !== resolved.origin) return false
  if (resolved.forwardedHostAdopted) return resolved.statedOrigin === resolved.origin
  if (resolved.statedOrigin === undefined) return true
  return resolved.statedOrigin === resolved.origin
}

/** Config allowlist for this request. Flag off returns the configured list unchanged. */
export function embedOriginsForRequest(req: EmbedRequestView): string[] {
  const listed = embedAllowedOrigins()
  if (!isPlmEmbedSameOrigin()) return listed
  const own = requestOwnOrigin(req)
  if (!own || listed.includes(own)) return listed
  return [...listed, own]
}

/**
 * Flag off: the configured frame-ancestors value, including fail-closed 'none'.
 * Flag on: 'self' plus any configured origins, so a new gateway hostname does not need a
 * pinned CSP host. The concrete origin is not copied into the directive.
 */
export function frameAncestorsForRequest(_req: EmbedRequestView): string {
  if (!isPlmEmbedSameOrigin()) return frameAncestorsValue()
  const listed = embedAllowedOrigins()
  return listed.length ? `frame-ancestors 'self' ${listed.join(' ')}` : "frame-ancestors 'self'"
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

/** Visual preview relay switch: byte-exact 'true' only (registered in the global flag manifest). */
export function isPlmEmbedVisualPreviewEnabled(): boolean {
  return process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED === 'true'
}
