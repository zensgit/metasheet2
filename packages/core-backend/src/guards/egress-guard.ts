import * as ipaddr from 'ipaddr.js'

export interface EgressPolicy {
  /**
   * Exact destination hosts allowed by policy. V1 intentionally supports exact
   * hosts only: no wildcard, suffix, CIDR, or scheme-bearing entries.
   */
  allowedHosts?: readonly string[]
  /**
   * Extra `/96` NAT64 prefixes this deployment translates, in addition to the
   * well-known `64:ff9b::/96`. Required when a NAT64 gateway on a Network-Specific
   * Prefix sits on the egress path, so an embedded internal IPv4 cannot be smuggled
   * past the classifier. Non-`/96` prefixes are ignored.
   */
  nat64Prefixes?: readonly string[]
}

/** NAT64 prefixes whose embedded IPv4 is always decoded (RFC 6052 well-known). */
const WELL_KNOWN_NAT64_PREFIXES = ['64:ff9b::/96'] as const

export type EgressUrlDenyReason =
  | 'URL_REQUIRED'
  | 'URL_MALFORMED'
  | 'SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS_NOT_ALLOWED'
  | 'HOST_REQUIRED'
  | 'HOST_INTERNAL_NAME'
  | 'ALLOWLIST_REQUIRED'
  | 'HOST_NOT_ALLOWLISTED'
  | 'IP_BLOCKED'

export type EgressUrlDecision =
  | {
      allowed: true
      normalizedUrl: string
      protocol: 'https:'
      hostname: string
    }
  | {
      allowed: false
      reason: EgressUrlDenyReason
    }

export function defaultEgressPolicy(): EgressPolicy {
  return { allowedHosts: [] }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
}

function normalizeHost(hostname: string): string {
  const withoutBrackets = stripIpv6Brackets(hostname.trim().toLowerCase())
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1) : withoutBrackets
}

function normalizeAllowedHost(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (raw.includes('*') || raw.includes('/') || raw.includes('@') || raw.includes('://')) return null
  return normalizeHost(raw)
}

function normalizedAllowedHosts(policy: EgressPolicy): Set<string> {
  const hosts = new Set<string>()
  for (const host of policy.allowedHosts ?? []) {
    const normalized = normalizeAllowedHost(host)
    if (normalized) hosts.add(normalized)
  }
  return hosts
}

function isInternalHostname(hostname: string): boolean {
  const h = normalizeHost(hostname)
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
}

function parseIp(hostname: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const host = stripIpv6Brackets(hostname.trim())
  if (!host || host.includes('%') || !ipaddr.isValid(host)) return null
  return ipaddr.parse(host)
}

function ipv4FromBytes(bytes: readonly number[]): ipaddr.IPv4 {
  return ipaddr.parse(bytes.join('.')) as ipaddr.IPv4
}

function isBlockedIpv4(address: ipaddr.IPv4): boolean {
  return address.range() !== 'unicast'
}

function isBlockedIpv6(address: ipaddr.IPv6, nat64Prefixes: readonly string[]): boolean {
  if (address.isIPv4MappedAddress()) {
    return isBlockedIpv4(address.toIPv4Address())
  }

  const bytes = address.toByteArray()
  // NAT64 (well-known + any operator-configured /96 prefix) -> classify the embedded v4.
  for (const prefix of nat64Prefixes) {
    let cidr: [ipaddr.IPv4 | ipaddr.IPv6, number]
    try {
      cidr = ipaddr.parseCIDR(prefix)
    } catch {
      continue
    }
    if (cidr[0].kind() !== 'ipv6' || cidr[1] !== 96) continue
    if (address.match(cidr)) {
      return isBlockedIpv4(ipv4FromBytes(bytes.slice(12, 16)))
    }
  }
  if (address.match(ipaddr.parseCIDR('2002::/16'))) {
    return isBlockedIpv4(ipv4FromBytes(bytes.slice(2, 6)))
  }

  return address.range() !== 'unicast'
}

export function isBlockedEgressIp(
  hostname: string,
  nat64Prefixes: readonly string[] = WELL_KNOWN_NAT64_PREFIXES,
): boolean {
  const address = parseIp(hostname)
  if (!address) return false
  if (address.kind() === 'ipv4') {
    return isBlockedIpv4(address as ipaddr.IPv4)
  }
  return isBlockedIpv6(address as ipaddr.IPv6, nat64Prefixes)
}

export function validateEgressUrl(rawUrl: unknown, policy: EgressPolicy = defaultEgressPolicy()): EgressUrlDecision {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { allowed: false, reason: 'URL_REQUIRED' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: 'URL_MALFORMED' }
  }

  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'SCHEME_NOT_ALLOWED' }
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'URL_CREDENTIALS_NOT_ALLOWED' }
  }

  const hostname = normalizeHost(parsed.hostname)
  if (!hostname) return { allowed: false, reason: 'HOST_REQUIRED' }
  if (isInternalHostname(hostname)) return { allowed: false, reason: 'HOST_INTERNAL_NAME' }

  const nat64Prefixes = [...WELL_KNOWN_NAT64_PREFIXES, ...(policy.nat64Prefixes ?? [])]
  if (isBlockedEgressIp(hostname, nat64Prefixes)) {
    return { allowed: false, reason: 'IP_BLOCKED' }
  }

  const allowedHosts = normalizedAllowedHosts(policy)
  if (allowedHosts.size === 0) return { allowed: false, reason: 'ALLOWLIST_REQUIRED' }
  if (!allowedHosts.has(hostname)) return { allowed: false, reason: 'HOST_NOT_ALLOWLISTED' }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
    protocol: 'https:',
    hostname,
  }
}
