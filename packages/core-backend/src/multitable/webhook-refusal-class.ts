/**
 * Values-free CLASSIFICATION of an SSRF-guard refusal, for the rule-driven `send_webhook` action
 * (gap G05; the "刀 0" prerequisite of the trigger-port design #5615).
 *
 * WHY A SEPARATE MODULE — the decision to refuse belongs to `checkWebhookTargetUrl` and ONLY to it.
 * This module never decides anything: it is called exclusively on an ALREADY-REFUSED target and turns
 * that refusal into a bounded triage label. Deleting or breaking this module can therefore never turn a
 * refusal into a send; the worst it can do is mislabel one (`internal-other`).
 *
 * VALUES-FREE CONTRACT (the reason this exists at all): an automation rule's webhook URL is
 * attacker-influenced AND credential-bearing (`https://user:pass@host/path?token=…`, plus
 * `config.headers.Authorization`). A refusal must be observable by an operator WITHOUT persisting or
 * logging any of it. So the returned object contains ONLY closed-set enum tokens — the shape of the
 * host ("loopback" / "private" / …), never the host, address, path, query, or any header value.
 * Every field of `WebhookRefusal` is a member of a fixed union; there is no free-text field by
 * construction, so a caller cannot smuggle a value through it.
 *
 * The guard's own rejection `reason` strings are NOT values-free-by-construction (the scheme variant
 * embeds `parsed.protocol`), which is exactly why the caller must log THIS object and not that string.
 */
import { isIP } from 'node:net'

/**
 * Stable, greppable refusal code. Deliberately the SAME literal that the button-field egress route
 * (`routes/multitable-button.ts`) already returns for the identical decision, so one alert/dashboard
 * query covers BOTH egress paths instead of two near-synonyms.
 */
export const WEBHOOK_TARGET_REJECTED = 'WEBHOOK_TARGET_REJECTED' as const

/**
 * Closed set of refusal classes. Every member is a HOST SHAPE, a parse outcome, or (the single
 * post-dispatch member, `redirect-not-allowed`) a RESPONSE SHAPE — never a value.
 */
export type WebhookRefusalClass =
  /** Missing / non-string / unparseable URL (also an out-of-range dotted quad like `999.1.1.1`). */
  | 'invalid-url'
  /** Parsed fine but the scheme is not https (the guard is https-only on both egress paths). */
  | 'scheme-not-allowed'
  /** 127.0.0.0/8, ::1, or the `localhost` name family. */
  | 'loopback'
  /** RFC1918: 10/8, 172.16/12, 192.168/16. */
  | 'private'
  /** 169.254/16 (incl. the cloud metadata address) or IPv6 fe80::/10. */
  | 'link-local'
  /** IPv6 unique-local fc00::/7. */
  | 'unique-local'
  /** 0.0.0.0/8 "this host" or IPv6 `::`. */
  | 'unspecified'
  /** An internal-by-name host: `*.internal` / `*.local`. */
  | 'internal-name'
  /** The name is public-looking but DNS returned at least one internal address. */
  | 'dns-resolved-internal'
  /** The name did not resolve at all (fail-closed: we do not send to an unknown target). */
  | 'dns-unresolved'
  /** Refused for a reason this classifier could not label (fail-safe label; still refused). */
  | 'internal-other'
  /**
   * The ONLY post-dispatch member: the first hop answered 3xx and we refuse to follow it. The gate
   * judges the URL the rule stored; a `Location` is a target the gate never saw, chosen by whoever
   * answers the first hop. `classifyWebhookRefusal` never returns this — the caller sets it from the
   * response status (see `isRefusedRedirectStatus`), which is why the dispatch sites pass
   * `redirect: 'manual'` instead of letting the platform follow.
   */
  | 'redirect-not-allowed'

/** Closed set of host families. `ipv4-mapped-ipv6` records a smuggling attempt (`::ffff:127.0.0.1`). */
export type WebhookRefusalHostFamily = 'ipv4' | 'ipv6' | 'ipv4-mapped-ipv6' | 'name' | 'none'

export interface WebhookRefusal {
  code: typeof WEBHOOK_TARGET_REJECTED
  refusalClass: WebhookRefusalClass
  hostFamily: WebhookRefusalHostFamily
}

/** The literal, so dispatch sites cannot typo it. */
export const REDIRECT_NOT_ALLOWED = 'redirect-not-allowed' as const satisfies WebhookRefusalClass

/**
 * Is this response status a redirect we refuse to follow? Measured on this repo's runtime
 * (Node v25.9.0, undici): `fetch(url, { redirect: 'manual' })` resolves with the REAL 3xx status
 * (`status: 307`, `ok: false`, `type: 'basic'`) and makes no second request. The WHATWG profile that
 * browsers use instead yields an opaque-redirect filtered response (`type: 'opaqueredirect'`,
 * `status: 0`); both are treated as a redirect here so the refusal does not depend on which profile
 * the host runtime implements. A caller-supplied `fetchFn` (test seam) may return either shape.
 */
export function isRefusedRedirectStatus(response: { status?: number; type?: string } | null | undefined): boolean {
  if (!response) return false
  if (response.type === 'opaqueredirect') return true
  const status = response.status
  return typeof status === 'number' && status >= 300 && status < 400
}

/* ──────────────────────────────────────────────────────────────────────────────────────────────────
 * POST-GATE FAILURE CLASSES (#5619 review, P2 "日志脱敏尚未完成").
 *
 * The block above labels a target the guard REFUSED. This block labels a delivery the guard ALLOWED and
 * that then failed — the other half of the same values-free promise, and the half that was still broken:
 * the failure log handed the transport's free text to the shared redactor
 * (`failure: redactString(lastError)`), and the real client's free text can BE the credential. Measured
 * on this repo's runtime (Node v25.9.0, undici), a rule whose URL carries userinfo makes `fetch` throw
 *
 *     TypeError: Request cannot be constructed from a URL that includes credentials: https://svc:<pw>@host/x
 *
 * while CONSTRUCTING the Request — before any socket. `automation-log-redact.ts` has no generic userinfo
 * rule (its only URL-credential rule is for `postgres://`/`mysql://`), so that whole URL, password and
 * query token included, was written verbatim on every attempt. The redactor is shared by four channels
 * plus a web mirror and is deliberately NOT changed; the fix is to stop shipping free text at all.
 *
 * SO: `classifyWebhookFailure` returns a member of a fixed union and NEVER READS `error.message`. That is
 * the load-bearing property — a value cannot reach a label the function cannot see. It reads only the
 * structural identifiers (`name`, `code`, `cause.name`, `cause.code`), which are runtime/system tokens,
 * not attacker text.
 *
 * DELIBERATE NON-MEMBERS:
 *   - `aborted` — the only abort on these two dispatch sites is our OWN per-attempt timeout controller,
 *     so an `aborted` distinct from `timeout` would be unreachable and untestable; a caller abort is
 *     honestly reported as `timeout`.
 *   - `redirect-not-allowed` — a 3xx never reaches this classifier: both dispatch sites treat it as a
 *     terminal REFUSAL (`WebhookRefusalClass`) before any failure bookkeeping.
 * ────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Closed set of failure classes for a delivery the gate ALLOWED. Every member is a SHAPE — an HTTP
 * status band, or a transport outcome — never a value, and there is no free-text member by construction.
 */
export type WebhookFailureClass =
  /** The receiver answered 4xx (the request was built and sent). */
  | 'http-4xx'
  /** The receiver answered 5xx. */
  | 'http-5xx'
  /** A non-2xx/3xx/4xx/5xx status (1xx, or something out of range from a caller-supplied client). */
  | 'http-other'
  /** Our per-attempt timeout fired, or the caller aborted. */
  | 'timeout'
  /**
   * The CLIENT refused to build/dispatch the request — nothing left the process. The credential-in-URL
   * `TypeError` above is the case that matters: the operator needs to know the URL itself is unusable,
   * and this label says so without quoting it.
   */
  | 'invalid-request'
  /** DNS did not resolve the target (`ENOTFOUND` / `EAI_AGAIN`). */
  | 'dns-failure'
  /** TCP connection refused — no listener (`ECONNREFUSED`). */
  | 'conn-refused'
  /** TLS/certificate handshake failure (the handshake precedes the body leaving the client). */
  | 'tls-failure'
  /** Any other transport failure (reset, unknown system code, a non-object rejection…). */
  | 'transport-error'
  /** No attempt was recorded at all — defensive; a loop that ran zero times. */
  | 'unknown'

/**
 * Values-free description of ONE attempt's outcome. The caller passes the raw error, not its message, so
 * that the "never read `message`" rule lives in ONE place instead of at every call site.
 */
export type WebhookFailureInput =
  | { kind: 'response'; status: number }
  | { kind: 'error'; error: unknown }
  | { kind: 'none' }

/** Node/undici DNS codes — the request body never left the client. */
const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN'])
/**
 * TLS handshake codes. Kept in step with `automation-outbound-intent.ts`'s `TLS_HANDSHAKE_CODES` (the
 * at-most-once classifier) so the two views of one attempt do not describe it differently; they are
 * separate lists on purpose — that module's list decides RETRY ELIGIBILITY, this one only names a label,
 * and a label must never be able to change a delivery decision.
 */
const TLS_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH',
])

function codeClass(code: string): WebhookFailureClass {
  if (DNS_CODES.has(code)) return 'dns-failure'
  if (code === 'ECONNREFUSED') return 'conn-refused'
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return 'tls-failure'
  return 'transport-error'
}

/**
 * Label ONE failed webhook attempt with a closed-set token.
 *
 * READS `name` / `code` / `cause.name` / `cause.code` ONLY — never `message`, never the URL, never the
 * body. A test pins that by passing an error whose `message` getter throws.
 */
export function classifyWebhookFailure(input: WebhookFailureInput): WebhookFailureClass {
  if (input.kind === 'none') return 'unknown'
  if (input.kind === 'response') {
    const status = input.status
    if (!Number.isFinite(status)) return 'http-other'
    if (status >= 500 && status < 600) return 'http-5xx'
    if (status >= 400 && status < 500) return 'http-4xx'
    return 'http-other'
  }

  const error = input.error
  // A non-object rejection (a thrown string — e.g. the URL itself) has no structure to read; it is NOT
  // stringified into the label, it just falls into the generic transport class.
  if (typeof error !== 'object' || error === null) return 'transport-error'

  const name = (error as { name?: unknown }).name
  const cause = (error as { cause?: unknown }).cause
  const causeIsObject = typeof cause === 'object' && cause !== null
  const causeName = causeIsObject ? (cause as { name?: unknown }).name : undefined
  if (name === 'AbortError' || name === 'TimeoutError' || causeName === 'AbortError' || causeName === 'TimeoutError') {
    return 'timeout'
  }

  const directCode = (error as { code?: unknown }).code
  const causeCode = causeIsObject ? (cause as { code?: unknown }).code : undefined
  const code = typeof directCode === 'string' ? directCode : typeof causeCode === 'string' ? causeCode : null
  if (code) return codeClass(code)

  // No transport code AND no `cause` at all: undici attaches the socket error as the `cause` of its
  // `TypeError: fetch failed` on every TRANSPORT failure, so a bare, cause-less `TypeError` is the client
  // REFUSING TO BUILD the request (credentials in the URL, an illegal header name, a bad method…).
  if (name === 'TypeError' && cause === undefined) return 'invalid-request'
  return 'transport-error'
}

/** The guard's dotted-quad literal test — kept identical so we classify exactly what it classified. */
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Shape of an IPv4 literal. `null` = not internal (public) — the classifier's callers never expect
 * that, but returning it keeps this a pure description rather than a second decision.
 */
function ipv4Class(ip: string): WebhookRefusalClass | null {
  const parts = ip.trim().split('.')
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (parts.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'invalid-url'
  const [a, b] = nums
  if (a === 0) return 'unspecified'
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  return null
}

/** Shape of an IPv6 literal, unwrapping IPv4-mapped forms to the embedded v4 shape. */
function ipv6Class(raw: string): { refusalClass: WebhookRefusalClass | null; hostFamily: WebhookRefusalHostFamily } {
  let a = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return { refusalClass: 'loopback', hostFamily: 'ipv6' }
  if (a === '::' || a === '0:0:0:0:0:0:0:0') return { refusalClass: 'unspecified', hostFamily: 'ipv6' }
  // IPv4-mapped (dotted or hex) — mirror the guard's unwrapping so a private v4 smuggled in mapped
  // form is labelled by its REAL shape, with the family recording that it arrived mapped.
  const mappedDotted = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mappedDotted) return { refusalClass: ipv4Class(mappedDotted[1]), hostFamily: 'ipv4-mapped-ipv6' }
  const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return {
      refusalClass: ipv4Class(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`),
      hostFamily: 'ipv4-mapped-ipv6',
    }
  }
  if (isIP(a) !== 6) return { refusalClass: 'invalid-url', hostFamily: 'ipv6' }
  const firstHextet = (a.split(':')[0] || '').padStart(4, '0')
  const firstByte = parseInt(firstHextet.slice(0, 2), 16)
  const secondByte = parseInt(firstHextet.slice(2, 4), 16)
  if (Number.isNaN(firstByte)) return { refusalClass: 'invalid-url', hostFamily: 'ipv6' }
  if ((firstByte & 0xfe) === 0xfc) return { refusalClass: 'unique-local', hostFamily: 'ipv6' }
  if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return { refusalClass: 'link-local', hostFamily: 'ipv6' }
  return { refusalClass: null, hostFamily: 'ipv6' }
}

/** Internal-by-NAME shape (the guard blocks these before any DNS). */
function internalNameClass(host: string): WebhookRefusalClass | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback'
  if (h.endsWith('.internal') || h.endsWith('.local')) return 'internal-name'
  return null
}

/**
 * The host SHAPE of a URL, with no judgement attached — the one field a values-free log line may carry
 * about a target the guard ALLOWED (a failed delivery, a refused redirect). Returns a closed-set token
 * only: never the host, port, path, query or userinfo. Mirrors the family fallback used below, so a
 * refusal log and a post-dispatch log describe the same URL the same way.
 */
export function webhookHostFamily(rawUrl: unknown): WebhookRefusalHostFamily {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return 'none'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return 'none'
  }
  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (IPV4_LITERAL.test(hostname)) return 'ipv4'
  if (hostname.includes(':')) return 'ipv6'
  return 'name'
}

/**
 * Label an ALREADY-REFUSED webhook target. `guardReason` is the guard's rejection reason and is used
 * ONLY to distinguish outcomes that cannot be read off the URL (scheme / DNS); it is never returned,
 * logged, or persisted by this function.
 *
 * Precedence: an internal HOST SHAPE wins over the reason, so `http://127.0.0.1` (which the guard
 * refuses at the scheme check, before it ever looks at the host) is still labelled `loopback` — the
 * operator-actionable fact. A public-looking host falls back to the reason mapping.
 */
export function classifyWebhookRefusal(rawUrl: unknown, guardReason?: string): WebhookRefusal {
  const wrap = (refusalClass: WebhookRefusalClass, hostFamily: WebhookRefusalHostFamily): WebhookRefusal =>
    ({ code: WEBHOOK_TARGET_REJECTED, refusalClass, hostFamily })

  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return wrap('invalid-url', 'none')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return wrap('invalid-url', 'none')
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const isV4Literal = IPV4_LITERAL.test(hostname)
  const isV6Literal = hostname.includes(':')

  if (isV4Literal) {
    const cls = ipv4Class(hostname)
    if (cls) return wrap(cls, 'ipv4')
  } else if (isV6Literal) {
    const { refusalClass, hostFamily } = ipv6Class(hostname)
    if (refusalClass) return wrap(refusalClass, hostFamily)
  } else {
    const byName = internalNameClass(hostname)
    if (byName) return wrap(byName, 'name')
  }

  // Same computation as `webhookHostFamily` by construction (rawUrl parsed fine above, so the 'none'
  // branch there is unreachable here) — call it rather than repeating it, so the two cannot drift.
  const hostFamily: WebhookRefusalHostFamily = webhookHostFamily(rawUrl)
  const reason = typeof guardReason === 'string' ? guardReason : ''
  if (reason.startsWith('scheme not allowed')) return wrap('scheme-not-allowed', hostFamily)
  if (reason === 'target resolves to an internal address') return wrap('dns-resolved-internal', hostFamily)
  if (reason === 'target host did not resolve') return wrap('dns-unresolved', hostFamily)
  if (reason === 'URL is required' || reason === 'URL is malformed') return wrap('invalid-url', hostFamily)
  // Unlabelled refusal (e.g. the guard grew a new reason). Still a refusal — only the label degrades.
  return wrap('internal-other', hostFamily)
}
