import * as ipaddr from 'ipaddr.js'

import {
  defaultEgressPolicy,
  isBlockedEgressIp,
  validateEgressUrl,
  type EgressPolicy,
  type EgressUrlDenyReason,
} from './egress-guard'

export type EgressResolvedAddress = {
  address: string
  family?: 4 | 6
}

export type EgressAddressResolver = (hostname: string) => Promise<readonly EgressResolvedAddress[]>

export type PinnedEgressTarget = {
  normalizedUrl: string
  hostname: string
  pinnedAddress: string
  family: 4 | 6
}

export type PinnedEgressRequest = PinnedEgressTarget & {
  method: string
  headers: Readonly<Record<string, string>>
  body?: unknown
  redirect: 'manual'
  redirectCount: number
}

export type PinnedEgressResponse = {
  status: number
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>
  body?: unknown
}

/**
 * Transport implementations must connect to pinnedAddress while preserving hostname for Host/SNI.
 * This module deliberately injects the transport so A1 stays testable without live outbound I/O.
 */
export type PinnedEgressTransport = (request: PinnedEgressRequest) => Promise<PinnedEgressResponse>

export type PinnedEgressDenyReason =
  | EgressUrlDenyReason
  | 'DNS_LOOKUP_FAILED'
  | 'DNS_NO_ADDRESSES'
  | 'DNS_INVALID_ADDRESS'
  | 'DNS_IP_BLOCKED'
  | 'HOST_HEADER_NOT_ALLOWED'
  | 'REDIRECT_LOCATION_MALFORMED'
  | 'REDIRECT_LIMIT_EXCEEDED'

export type PinnedEgressDecision =
  | {
      allowed: true
      response: PinnedEgressResponse
      finalUrl: string
      redirectCount: number
    }
  | {
      allowed: false
      reason: PinnedEgressDenyReason
    }

export type DispatchPinnedEgressOptions = {
  policy?: EgressPolicy
  resolveAddresses: EgressAddressResolver
  transport: PinnedEgressTransport
  maxRedirects?: number
}

export type DispatchPinnedEgressInput = {
  url: unknown
  method?: string
  headers?: Readonly<Record<string, string>>
  body?: unknown
}

const DEFAULT_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function parseAddress(address: string): { canonicalAddress: string; family: 4 | 6 } | null {
  const raw = address.trim()
  if (!raw || raw.includes('%') || !ipaddr.isValid(raw)) return null
  const parsed = ipaddr.parse(raw)
  return {
    canonicalAddress: parsed.toString(),
    family: parsed.kind() === 'ipv4' ? 4 : 6,
  }
}

function responseHeader(
  headers: PinnedEgressResponse['headers'],
  name: string,
): string | null {
  if (!headers) return null
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null
    return typeof value === 'string' ? value : null
  }
  return null
}

function hasCallerHostHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'host')
}

async function resolvePinnedTarget(
  normalizedUrl: string,
  hostname: string,
  policy: EgressPolicy,
  resolveAddresses: EgressAddressResolver,
): Promise<{ allowed: true; target: PinnedEgressTarget } | { allowed: false; reason: PinnedEgressDenyReason }> {
  const literal = parseAddress(hostname)
  if (literal) {
    if (isBlockedEgressIp(literal.canonicalAddress, policy.nat64Prefixes)) {
      return { allowed: false, reason: 'DNS_IP_BLOCKED' }
    }
    return {
      allowed: true,
      target: {
        normalizedUrl,
        hostname,
        pinnedAddress: literal.canonicalAddress,
        family: literal.family,
      },
    }
  }

  let addresses: readonly EgressResolvedAddress[]
  try {
    addresses = await resolveAddresses(hostname)
  } catch {
    return { allowed: false, reason: 'DNS_LOOKUP_FAILED' }
  }

  if (addresses.length === 0) return { allowed: false, reason: 'DNS_NO_ADDRESSES' }

  const parsedAddresses: Array<{ canonicalAddress: string; family: 4 | 6 }> = []
  for (const resolved of addresses) {
    const parsed = parseAddress(resolved.address)
    if (!parsed) return { allowed: false, reason: 'DNS_INVALID_ADDRESS' }
    if (resolved.family !== undefined && resolved.family !== parsed.family) {
      return { allowed: false, reason: 'DNS_INVALID_ADDRESS' }
    }
    if (isBlockedEgressIp(parsed.canonicalAddress, policy.nat64Prefixes)) {
      return { allowed: false, reason: 'DNS_IP_BLOCKED' }
    }
    parsedAddresses.push(parsed)
  }

  const first = parsedAddresses[0]
  if (!first) return { allowed: false, reason: 'DNS_NO_ADDRESSES' }
  return {
    allowed: true,
    target: {
      normalizedUrl,
      hostname,
      pinnedAddress: first.canonicalAddress,
      family: first.family,
    },
  }
}

export async function dispatchPinnedEgressRequest(
  input: DispatchPinnedEgressInput,
  options: DispatchPinnedEgressOptions,
): Promise<PinnedEgressDecision> {
  const policy = options.policy ?? defaultEgressPolicy()
  if (hasCallerHostHeader(input.headers)) {
    return { allowed: false, reason: 'HOST_HEADER_NOT_ALLOWED' }
  }
  const maxRedirects = Number.isInteger(options.maxRedirects) && options.maxRedirects !== undefined
    ? Math.max(0, options.maxRedirects)
    : DEFAULT_MAX_REDIRECTS
  let currentUrl = input.url
  let method = input.method || 'GET'
  let body = input.body

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const urlDecision = validateEgressUrl(currentUrl, policy)
    if (urlDecision.allowed === false) return { allowed: false, reason: urlDecision.reason }

    const targetDecision = await resolvePinnedTarget(
      urlDecision.normalizedUrl,
      urlDecision.hostname,
      policy,
      options.resolveAddresses,
    )
    if (targetDecision.allowed === false) return { allowed: false, reason: targetDecision.reason }

    const response = await options.transport({
      ...targetDecision.target,
      method,
      headers: Object.freeze({ ...(input.headers ?? {}) }),
      body,
      redirect: 'manual',
      redirectCount,
    })

    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        allowed: true,
        response,
        finalUrl: targetDecision.target.normalizedUrl,
        redirectCount,
      }
    }

    const location = responseHeader(response.headers, 'location')
    if (!location) {
      return {
        allowed: true,
        response,
        finalUrl: targetDecision.target.normalizedUrl,
        redirectCount,
      }
    }
    if (redirectCount >= maxRedirects) {
      return { allowed: false, reason: 'REDIRECT_LIMIT_EXCEEDED' }
    }

    try {
      currentUrl = new URL(location, targetDecision.target.normalizedUrl).toString()
    } catch {
      return { allowed: false, reason: 'REDIRECT_LOCATION_MALFORMED' }
    }

    if (response.status === 303) {
      method = 'GET'
      body = undefined
    }
  }

  return { allowed: false, reason: 'REDIRECT_LIMIT_EXCEEDED' }
}
