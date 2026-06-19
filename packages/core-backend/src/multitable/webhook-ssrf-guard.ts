/**
 * SSRF guard for the `send_webhook` button action (B1-S2, design-lock #2897 §3.1) — THE #1 egress
 * control. A field author supplies the target URL, so the server must refuse to be turned into a
 * request-forgery proxy into the internal network.
 *
 * Policy (all required):
 *  - https-only (no http/file/other schemes).
 *  - Block private / loopback / link-local / metadata / "this-host" targets, IPv4 AND IPv6
 *    (incl. IPv4-mapped IPv6, so a private v4 can't be smuggled in mapped form).
 *  - Resolve the name and reject if ANY resolved address is internal (multi-record names included).
 *  - Resolve-then-pin: callers connect to the returned pinned addresses, not the name, to defeat
 *    DNS-rebinding between check and use.
 *
 * Pure + injectable resolver so it is deterministically testable without real DNS.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type SsrfLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export type SsrfCheckResult =
  | { ok: true; protocol: 'https:'; hostname: string; addresses: string[] }
  | { ok: false; reason: string }

/** Internal/unsafe IPv4? Malformed input is treated as unsafe (fail-closed). */
export function isInternalIpv4(ip: string): boolean {
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
  if (a === 169 && b === 254) return true // link-local 169.254/16 (incl. cloud metadata 169.254.169.254)
  return false
}

/** Internal/unsafe IPv6? Handles loopback, unspecified, ULA (fc00::/7), link-local (fe80::/10),
 *  and IPv4-mapped (::ffff:a.b.c.d / ::ffff:HHHH:HHHH) by unwrapping to the embedded IPv4. */
export function isInternalIpv6(ip: string): boolean {
  let a = ip.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = a.indexOf('%') // strip a scope id (fe80::1%eth0)
  if (zone !== -1) a = a.slice(0, zone)
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true // loopback
  if (a === '::' || a === '0:0:0:0:0:0:0:0') return true // unspecified
  // IPv4-mapped: ::ffff:a.b.c.d  (dotted) or ::ffff:HHHH:HHHH (hex) → check the embedded IPv4. Handled
  // BEFORE the net.isIP guard so the dotted-quad form (whose net.isIP support varies) is unambiguous.
  const mappedDotted = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mappedDotted) return isInternalIpv4(mappedDotted[1])
  const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isInternalIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
  }
  // Fail-closed: a malformed-but-first-hextet-parseable string (e.g. "2606:nonsense") would otherwise read
  // as public via the prefix check below. By here `a` is a plain (non-mapped) IPv6, so net.isIP is
  // unambiguous — reject anything that is not a syntactically valid IPv6. (#2950 P3.)
  if (isIP(a) !== 6) return true
  const firstHextet = (a.split(':')[0] || '').padStart(4, '0') // leading "::" → "0000" (not fc/fe)
  const firstByte = parseInt(firstHextet.slice(0, 2), 16)
  const secondByte = parseInt(firstHextet.slice(2, 4), 16)
  if (Number.isNaN(firstByte)) return true // unparseable → fail-closed
  if ((firstByte & 0xfe) === 0xfc) return true // ULA fc00::/7 (fc / fd)
  if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return true // link-local fe80::/10
  return false
}

/** Is a resolved IP literal internal/unsafe (either family)? */
export function isInternalAddress(ip: string): boolean {
  return ip.includes(':') ? isInternalIpv6(ip) : isInternalIpv4(ip)
}

/** Name-based block: never resolve obviously-internal names (defence-in-depth alongside the IP check). */
function isInternalHostname(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === 'localhost') return true
  if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true
  return false
}

/**
 * Validate a target URL for an egress webhook. Returns the pinned addresses on success (caller connects
 * to those, not the name). Rejects (never throws) with a stable reason on any unsafe target.
 */
export async function checkWebhookTargetUrl(rawUrl: unknown, lookupFn: SsrfLookupFn = ((h) => dnsLookup(h, { all: true }))): Promise<SsrfCheckResult> {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return { ok: false, reason: 'URL is required' }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL is malformed' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: `scheme not allowed: ${parsed.protocol} (https only)` }
  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (isInternalHostname(hostname)) return { ok: false, reason: 'target host is internal' }

  // A bare IP literal is checked directly (no DNS). A name is resolved and EVERY address checked.
  if (isInternalAddress(hostname) && (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':'))) {
    return { ok: false, reason: 'target IP is internal' }
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return { ok: true, protocol: 'https:', hostname, addresses: [hostname] } // public IP literal
  }

  let resolved: Array<{ address: string; family: number }>
  try {
    resolved = await lookupFn(hostname)
  } catch {
    return { ok: false, reason: 'target host did not resolve' }
  }
  if (!resolved || resolved.length === 0) return { ok: false, reason: 'target host did not resolve' }
  for (const { address } of resolved) {
    if (isInternalAddress(address)) return { ok: false, reason: 'target resolves to an internal address' }
  }
  return { ok: true, protocol: 'https:', hostname, addresses: resolved.map((r) => r.address) }
}
