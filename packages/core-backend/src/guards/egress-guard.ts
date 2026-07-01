/**
 * Egress guard — BPMN HTTP service-task SSRF boundary (R1, slice 1).
 *
 * Design-lock: docs/development/workflow-bpmn-http-task-ssrf-boundary-design-lock-20260630.md.
 *
 * SCOPE (slice 1): the standalone, synchronous validator + policy config + the reusable IP
 * classifier. It performs **no DNS resolution and opens no sockets**, and it is **not wired to**
 * `BPMNWorkflowEngine.executeHttpTask`. The atomic resolve-and-pin dispatcher (slice 2) and the
 * engine wiring / header-method hardening (slice 3, L8) are separate, later, opt-in slices.
 *
 * Why synchronous: DNS resolution must be *atomic* with the pinned connection to defeat DNS
 * rebinding (TOCTOU). Resolving here and re-resolving in the dispatcher would reopen that hole,
 * so full hostname L2 lives entirely in slice 2 — which calls `isBlockedIp` (below) on each
 * resolved address and then pins it. Slice 1 classifies only IP-literal hosts.
 *
 * NAT64 note (residual): the classifier decodes the embedded IPv4 for the well-known NAT64 prefix
 * `64:ff9b::/96` and any operator-configured `nat64Prefixes`. A deployment that runs a NAT64
 * gateway on its egress path using a Network-Specific Prefix MUST list that prefix in
 * `EgressPolicy.nat64Prefixes`, otherwise an IP-literal in that prefix is treated as ordinary
 * global-unicast (it is still gated by the L3 allowlist — an attacker's NAT64 literal must be
 * explicitly allowlisted to pass). NAT64 with a non-`/96` RFC 6052 prefix length is not decoded.
 */
import ipaddr from 'ipaddr.js'

/** NAT64 prefixes whose embedded IPv4 is always decoded (RFC 6052 well-known). */
const WELL_KNOWN_NAT64_PREFIXES = ['64:ff9b::/96'] as const

/** Egress policy. Fail-closed: an empty allowlist denies every destination. */
export interface EgressPolicy {
  /** Allowed URL schemes without the trailing ':'. Fail-closed default: `['https']` (D1). */
  allowedSchemes: string[]
  /** Exact hostnames permitted — DNS names or IP literals (D2). */
  allowedHosts: string[]
  /** CIDR ranges permitted for IP-literal hosts, e.g. a known public integration range (D2). */
  allowedCidrs: string[]
  /**
   * Extra `/96` NAT64 prefixes this deployment translates (in addition to the well-known
   * `64:ff9b::/96`). Required when a NAT64 gateway using a Network-Specific Prefix sits on the
   * egress path, so an embedded internal IPv4 cannot be smuggled past the classifier.
   */
  nat64Prefixes?: string[]
}

export interface EgressDecision {
  allowed: boolean
  /** Populated only when `allowed === false`. */
  blockedReason?: string
}

/**
 * The fail-closed default policy (L7): `https`-only, and an **empty allowlist that denies every
 * destination** until an operator explicitly configures one.
 */
export function defaultEgressPolicy(): EgressPolicy {
  return { allowedSchemes: ['https'], allowedHosts: [], allowedCidrs: [] }
}

const block = (blockedReason: string): EgressDecision => ({ allowed: false, blockedReason })
const ALLOW: EgressDecision = { allowed: true }

/** A plain IPv4 is a candidate target only when it is globally-routable unicast. */
function isGlobalUnicastV4(addr: ipaddr.IPv4): boolean {
  // ipaddr.js IPv4 range() ∈ {unicast, unspecified, broadcast, multicast, linkLocal, loopback,
  // carrierGradeNat, private, reserved}. Only 'unicast' is a public destination.
  return addr.range() === 'unicast'
}

function embeddedIpv4At96(v6: ipaddr.IPv6): ipaddr.IPv4 {
  const p = v6.parts // eight 16-bit groups; low 32 bits are the embedded v4 for a /96 prefix
  return ipaddr.fromByteArray([p[6] >> 8, p[6] & 0xff, p[7] >> 8, p[7] & 0xff]) as ipaddr.IPv4
}

/** If `v6` sits in a configured `/96` NAT64 prefix, return its embedded IPv4; else null. */
function nat64EmbeddedIpv4(v6: ipaddr.IPv6, nat64Prefixes: readonly string[]): ipaddr.IPv4 | null {
  for (const cidr of nat64Prefixes) {
    let range: ipaddr.IPv4 | ipaddr.IPv6
    let bits: number
    try {
      ;[range, bits] = ipaddr.parseCIDR(cidr)
    } catch {
      continue
    }
    if (range.kind() !== 'ipv6' || bits !== 96) continue // slice 1 handles /96 NAT64
    if (v6.match(range, 96)) return embeddedIpv4At96(v6)
  }
  return null
}

function isTeredo(v6: ipaddr.IPv6): boolean {
  return v6.parts[0] === 0x2001 && v6.parts[1] === 0x0000
}

/**
 * `true` when the IP literal must never be an outbound target (L2). Blocks loopback, link-local
 * (incl. cloud metadata `169.254.169.254`), private, CGNAT, IPv6 ULA, multicast, reserved,
 * unspecified/broadcast — and **decomposes embedded-IPv4 tunnel forms** (IPv4-mapped, 6to4, and
 * NAT64 in the well-known or any configured `/96` prefix) so those wrappers cannot smuggle a
 * blocked v4. Teredo is blocked outright. Unparseable → fail-closed. See the NAT64 residual note
 * in the file header for the non-configured-NSP / non-`/96` limits.
 */
export function isBlockedIp(
  ip: string,
  nat64Prefixes: readonly string[] = WELL_KNOWN_NAT64_PREFIXES,
): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return true // unparseable → fail closed
  }

  if (addr.kind() === 'ipv4') {
    return !isGlobalUnicastV4(addr as ipaddr.IPv4)
  }

  const v6 = addr as ipaddr.IPv6

  // IPv4-mapped (::ffff:a.b.c.d) → classify the embedded v4.
  if (v6.isIPv4MappedAddress()) {
    return !isGlobalUnicastV4(v6.toIPv4Address())
  }

  // NAT64 (well-known + configured /96 prefixes) → classify the embedded v4.
  const nat64Inner = nat64EmbeddedIpv4(v6, nat64Prefixes)
  if (nat64Inner) {
    return !isGlobalUnicastV4(nat64Inner)
  }

  // 6to4 (2002::/16) → the v4 gateway is bits 16..47.
  if (v6.parts[0] === 0x2002) {
    const p = v6.parts
    const inner = ipaddr.fromByteArray([p[1] >> 8, p[1] & 0xff, p[2] >> 8, p[2] & 0xff]) as ipaddr.IPv4
    return !isGlobalUnicastV4(inner)
  }

  // Teredo (2001:0::/32) — deprecated tunnel, never a legitimate target.
  if (isTeredo(v6)) {
    return true
  }

  // Plain IPv6: only global unicast is a candidate target.
  return v6.range() !== 'unicast'
}

/** Strip the brackets WHATWG `URL` keeps on IPv6 hostnames (`[::1]` → `::1`). */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function ipMatchesCidrs(ip: ipaddr.IPv4 | ipaddr.IPv6, cidrs: string[]): boolean {
  for (const cidr of cidrs) {
    let range: ipaddr.IPv4 | ipaddr.IPv6
    let bits: number
    try {
      ;[range, bits] = ipaddr.parseCIDR(cidr)
    } catch {
      continue // a malformed allowlist entry never *widens* access
    }
    if (range.kind() !== ip.kind()) continue
    if (ip.match(range, bits)) return true
  }
  return false
}

function hostInAllowedHosts(host: string, allowedHosts: string[]): boolean {
  const h = host.toLowerCase()
  return allowedHosts.some((a) => a.toLowerCase() === h)
}

/**
 * Synchronous SSRF egress validation for a single URL (L1 scheme+creds, L3 allowlist, and L2 for
 * IP-literal hosts). **Does not resolve DNS.** A DNS hostname is allowlist-checked only; its
 * resolved addresses are classified with `isBlockedIp` and pinned by the slice-2 dispatcher.
 * Every failure path — including a malformed URL or an empty allowlist — denies (fail-closed).
 */
export function validateEgressUrl(rawUrl: string, policy: EgressPolicy): EgressDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return block('malformed URL')
  }

  // L1 — scheme allowlist (URL canonicalization already lower-cased the scheme).
  const scheme = url.protocol.replace(/:$/, '')
  if (!policy.allowedSchemes.some((s) => s.toLowerCase() === scheme)) {
    return block(`scheme not allowed: ${scheme}`)
  }

  // L1 — reject credentials in the URL (userinfo).
  if (url.username !== '' || url.password !== '') {
    return block('credentials in URL are not allowed')
  }

  const host = unbracket(url.hostname)
  if (host === '') {
    return block('empty host')
  }

  const nat64Prefixes = [...WELL_KNOWN_NAT64_PREFIXES, ...(policy.nat64Prefixes ?? [])]

  if (ipaddr.isValid(host)) {
    // IP-literal host — classify (L2) then require allowlist membership (L3).
    if (isBlockedIp(host, nat64Prefixes)) {
      return block('destination IP is in a blocked range')
    }
    const ip = ipaddr.parse(host)
    if (hostInAllowedHosts(host, policy.allowedHosts) || ipMatchesCidrs(ip, policy.allowedCidrs)) {
      return ALLOW
    }
    return block('destination IP is not in the egress allowlist')
  }

  // DNS hostname — slice 1 does not resolve; exact-host allowlist only (CIDR is IP-only).
  if (hostInAllowedHosts(host, policy.allowedHosts)) {
    return ALLOW
  }
  return block('destination host is not in the egress allowlist')
}
