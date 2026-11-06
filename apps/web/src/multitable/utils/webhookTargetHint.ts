// Webhook target hints (since on-prem R81 the server refuses any webhook target that is not a public
// https address). Used by the two places a user types a webhook target:
//   - MetaAutomationRuleEditor.vue, 「发送 Webhook」 action URL
//   - MetaApiTokenManager.vue, 「API 与 Webhook」 subscription URL
//
// `classifyWebhookTarget` MIRRORS the server's URL-only check
// (packages/core-backend/src/multitable/webhook-ssrf-guard.ts `checkWebhookTargetUrlShape`) — same
// emptiness rule, same WHATWG `new URL` parse, same https-only rule, same internal-name list, same
// internal-IP ranges and IPv4-mapped IPv6 unwrapping, same order of checks. It decides NOTHING: the
// server is the boundary. The UI only shows a warning from it and never blocks a save on it, so a
// divergence can at worst show (or miss) a hint, never stop a valid save.
//
// Drift guard: packages/core-backend/tests/fixtures/webhook-target-shape-truth-table.json is replayed by
// BOTH apps/web/tests/webhook-target-hint.spec.ts (this file) and
// packages/core-backend/tests/unit/webhook-target-shape-parity.test.ts (the server check). Change one
// side without the other and that side's own run turns red.
//
// Not covered here (by design): a public-looking name that RESOLVES to an internal address. The browser
// cannot resolve names; the server refuses those at send time only. The help text says so.

/** Closed set of hint classes, one per `checkWebhookTargetUrlShape` outcome. */
export type WebhookTargetHintClass =
  /** Server: `{ ok: true }`. */
  | 'ok'
  /** Server: 'URL is required' (missing, non-string, blank). */
  | 'empty'
  /** Server: 'URL is malformed' (`new URL` throws). */
  | 'malformed'
  /** Server: 'scheme not allowed: … (https only)'. */
  | 'not_https'
  /** Server: 'target host is internal' (localhost, *.localhost, *.internal, *.local). */
  | 'internal_name'
  /** Server: 'target IP is internal' (internal or unparseable IP literal). */
  | 'internal_ip'

/** Mirror of the server's `isInternalIpv4` (malformed = internal, fail-closed). */
function isInternalIpv4(ip: string): boolean {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return true
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = nums
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 127) return true // loopback 127/8
  if (a === 10) return true // RFC1918 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918 172.16/12
  if (a === 192 && b === 168) return true // RFC1918 192.168/16
  if (a === 169 && b === 254) return true // link-local 169.254/16 (incl. the cloud metadata address)
  return false
}

/**
 * Browser stand-in for the server's `net.isIP(a) === 6`. The only strings that reach it are WHATWG-parsed
 * https hosts, which the URL parser has already validated and re-serialized in compressed hex form, so for
 * every reachable input this answers true exactly like `net.isIP`. It is still a real syntax check so the
 * fail-closed branch below keeps its meaning.
 */
function isIpv6Syntax(address: string): boolean {
  let s = address
  const dottedTail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dottedTail) {
    const octets = dottedTail[2].split('.').map(Number)
    if (octets.some((n) => n > 255)) return false
    s = `${dottedTail[1]}0:0`
  }
  const halves = s.split('::')
  if (halves.length > 2) return false
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const groups = halves.length === 2 ? [...groupsOf(halves[0]), ...groupsOf(halves[1])] : groupsOf(halves[0])
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return false
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8
}

/** Mirror of the server's `isInternalIpv6`. */
function isInternalIpv6(ip: string): boolean {
  let a = ip.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true // loopback
  if (a === '::' || a === '0:0:0:0:0:0:0:0') return true // unspecified
  const mappedDotted = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mappedDotted) return isInternalIpv4(mappedDotted[1])
  const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isInternalIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
  }
  if (!isIpv6Syntax(a)) return true // fail-closed, like the server
  const firstHextet = (a.split(':')[0] || '').padStart(4, '0')
  const firstByte = parseInt(firstHextet.slice(0, 2), 16)
  const secondByte = parseInt(firstHextet.slice(2, 4), 16)
  if (Number.isNaN(firstByte)) return true
  if ((firstByte & 0xfe) === 0xfc) return true // ULA fc00::/7
  if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return true // link-local fe80::/10
  return false
}

/** Mirror of the server's `isInternalAddress`. */
function isInternalAddress(ip: string): boolean {
  return ip.includes(':') ? isInternalIpv6(ip) : isInternalIpv4(ip)
}

/** Mirror of the server's `isInternalHostname`. */
function isInternalHostname(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === 'localhost') return true
  if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true
  return false
}

/** Mirror of the server's `checkWebhookTargetUrlShape`, answering a closed-set class instead of a reason. */
export function classifyWebhookTarget(rawUrl: unknown): WebhookTargetHintClass {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return 'empty'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return 'malformed'
  }
  if (parsed.protocol !== 'https:') return 'not_https'
  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (isInternalHostname(hostname)) return 'internal_name'
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
  if (isIpLiteral && isInternalAddress(hostname)) return 'internal_ip'
  return 'ok'
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────────

export type WebhookTargetLabelKey =
  | 'help'
  | 'warn.malformed'
  | 'warn.notHttps'
  | 'warn.internalName'
  | 'warn.internalIp'
  | 'refused.dnsResolvedInternal'
  | 'refused.generic'
  | 'refused.prefix'

// One table for both forms, so the rule editor and the subscription form cannot word the same rule
// differently. Never interpolates the URL.
const LABELS: Record<WebhookTargetLabelKey, { en: string; zh: string }> = {
  help: {
    en: 'Only a publicly reachable https address works. http, intranet IPs and intranet names (such as localhost, *.local, *.internal) are refused and nothing is sent. A normal-looking name that resolves to an intranet address is also refused when sending.',
    zh: '只能填公网可访问的 https 地址；http、内网 IP、内网域名（如 localhost、*.local、*.internal）会被拒绝，不会发出。看起来正常、但解析到内网地址的域名，也会在发送时被拒绝。',
  },
  'warn.malformed': {
    en: 'This is not a valid URL and will be refused. Enter a full https:// address.',
    zh: '这不是有效的网址，会被拒绝。请填写完整的 https:// 地址。',
  },
  'warn.notHttps': {
    en: 'Only https:// addresses are allowed; http and other schemes are refused and nothing is sent.',
    zh: '只能使用 https:// 开头的地址；http 等其他协议会被拒绝，不会发出。',
  },
  'warn.internalName': {
    en: 'This is an intranet name (such as localhost, *.local, *.internal); it is refused and nothing is sent. Enter a publicly reachable https address.',
    zh: '这是内网域名（如 localhost、*.local、*.internal），会被拒绝，不会发出。请填写公网可访问的 https 地址。',
  },
  'warn.internalIp': {
    en: 'This is an intranet or local address; it is refused and nothing is sent. Enter a publicly reachable https address.',
    zh: '这是内网或本机地址，会被拒绝，不会发出。请填写公网可访问的 https 地址。',
  },
  'refused.dnsResolvedInternal': {
    en: 'This name resolves to an intranet address; it is refused and nothing is sent.',
    zh: '该域名解析到了内网地址，会被拒绝，不会发出。',
  },
  'refused.generic': {
    en: 'The target address was refused: only a publicly reachable https address is allowed.',
    zh: '目标地址被拒绝：只能填公网可访问的 https 地址。',
  },
  'refused.prefix': {
    en: 'Not saved: ',
    zh: '未保存：',
  },
}

export function webhookTargetLabel(key: WebhookTargetLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

/** The fixed help line shown under both URL inputs. */
export function webhookTargetHelpText(isZh: boolean): string {
  return webhookTargetLabel('help', isZh)
}

const HINT_KEY: Record<WebhookTargetHintClass, WebhookTargetLabelKey | null> = {
  ok: null,
  empty: null, // nothing typed yet: the help line is enough
  malformed: 'warn.malformed',
  not_https: 'warn.notHttps',
  internal_name: 'warn.internalName',
  internal_ip: 'warn.internalIp',
}

/** Live warning while typing, or null when there is nothing to warn about. Never blocks a save. */
export function webhookTargetHint(rawUrl: unknown, isZh: boolean): string | null {
  const key = HINT_KEY[classifyWebhookTarget(rawUrl)]
  return key ? webhookTargetLabel(key, isZh) : null
}

// ── Save-time refusals ───────────────────────────────────────────────────────────────────────────

/**
 * Server refusal classes (packages/core-backend/src/multitable/webhook-refusal-class.ts
 * `WebhookRefusalClass`) → copy. A class missing here falls back to `refused.generic`, never the raw code.
 */
const REFUSAL_CLASS_KEY: Record<string, WebhookTargetLabelKey> = {
  'invalid-url': 'warn.malformed',
  'scheme-not-allowed': 'warn.notHttps',
  loopback: 'warn.internalIp',
  private: 'warn.internalIp',
  'link-local': 'warn.internalIp',
  'unique-local': 'warn.internalIp',
  unspecified: 'warn.internalIp',
  'internal-name': 'warn.internalName',
  'dns-resolved-internal': 'refused.dnsResolvedInternal',
}

/** Copy for one server refusal class; unknown / missing classes get the generic sentence. */
export function webhookRefusalClassMessage(refusalClass: string | null | undefined, isZh: boolean): string {
  const key = (refusalClass && Object.prototype.hasOwnProperty.call(REFUSAL_CLASS_KEY, refusalClass))
    ? REFUSAL_CLASS_KEY[refusalClass]
    : 'refused.generic'
  return webhookTargetLabel(key, isZh)
}

/** Is this refusal class one the copy table names specifically (not the generic fallback)? */
export function isKnownWebhookRefusalClass(refusalClass: string): boolean {
  return Object.prototype.hasOwnProperty.call(REFUSAL_CLASS_KEY, refusalClass)
}

export const WEBHOOK_TARGET_REJECTED_CODE = 'WEBHOOK_TARGET_REJECTED'

// The three server sentences this maps (all values-free: they never carry the URL):
//   rules          automation-service.ts preflightAutomationWebhookTargets:
//                  code WEBHOOK_TARGET_REJECTED, 'send_webhook target refused (<class>) at <path>'
//   subscriptions  webhook-service.ts assertTargetShape (code <ACTION>_FAILED or WEBHOOK_TARGET_REJECTED):
//                  'Webhook URL is not a valid URL' | 'Webhook URL must use HTTPS' | 'WEBHOOK_TARGET_REJECTED:<class>'
const RULE_REFUSAL = /^send_webhook target refused \(([a-z0-9-]+)\)/
const SUBSCRIPTION_REFUSAL = /^WEBHOOK_TARGET_REJECTED:([a-z0-9-]+)$/

/**
 * Readable copy for a save the server refused because of the webhook target, or null when the error is
 * something else (the caller keeps its own handling). The result never contains the URL.
 */
export function webhookTargetSaveErrorMessage(err: unknown, isZh: boolean): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : ''
  const message = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : ''
  const prefix = webhookTargetLabel('refused.prefix', isZh)
  if (message === 'Webhook URL is not a valid URL') return prefix + webhookTargetLabel('warn.malformed', isZh)
  if (message === 'Webhook URL must use HTTPS') return prefix + webhookTargetLabel('warn.notHttps', isZh)
  const ruleMatch = message.match(RULE_REFUSAL)
  const subscriptionMatch = message.match(SUBSCRIPTION_REFUSAL)
  if (code !== WEBHOOK_TARGET_REJECTED_CODE && !ruleMatch && !subscriptionMatch) return null
  const refusalClass = ruleMatch?.[1] ?? subscriptionMatch?.[1] ?? null
  return prefix + webhookRefusalClassMessage(refusalClass, isZh)
}
