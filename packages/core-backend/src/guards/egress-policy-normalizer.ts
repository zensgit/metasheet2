import { createHash } from 'crypto'
import * as ipaddr from 'ipaddr.js'

import { defaultEgressPolicy, type EgressPolicy } from './egress-guard'

export type EgressPolicyConfigErrorCode =
  | 'EGRESS_POLICY_MISSING'
  | 'EGRESS_POLICY_MALFORMED'
  | 'EGRESS_POLICY_UNKNOWN_KEY'
  | 'EGRESS_POLICY_EMPTY_ALLOWLIST'
  | 'EGRESS_POLICY_INVALID_HOST'
  | 'EGRESS_POLICY_DUPLICATE_HOST'
  | 'EGRESS_POLICY_INVALID_NAT64_PREFIX'
  | 'EGRESS_POLICY_DUPLICATE_NAT64_PREFIX'

export type EgressPolicyConfigField =
  | 'config'
  | 'allowedHosts'
  | 'allowedHosts[]'
  | 'nat64Prefixes'
  | 'nat64Prefixes[]'

export interface EgressPolicyMetadata {
  policyPresent: boolean
  allowedHostCount: number
  nat64PrefixCount: number
  policyFingerprint: string | null
}

export interface EgressPolicyConfigError {
  code: EgressPolicyConfigErrorCode
  field: EgressPolicyConfigField
}

export type EgressPolicyNormalizationResult =
  | {
      ok: true
      policy: Readonly<EgressPolicy>
      metadata: Readonly<EgressPolicyMetadata>
    }
  | {
      ok: false
      policy: Readonly<EgressPolicy>
      metadata: Readonly<EgressPolicyMetadata>
      error: Readonly<EgressPolicyConfigError>
    }

const ALLOWED_CONFIG_KEYS = new Set(['allowedHosts', 'nat64Prefixes'])
// The guard always decodes RFC 6052's well-known NAT64 prefix; server policy
// config only carries extra deployment-specific prefixes.
const BUILT_IN_NAT64_PREFIXES = new Set(['64:ff9b:0:0:0:0:0:0/96'])

function disabledMetadata(): Readonly<EgressPolicyMetadata> {
  return Object.freeze({
    policyPresent: false,
    allowedHostCount: 0,
    nat64PrefixCount: 0,
    policyFingerprint: null,
  })
}

function fail(
  code: EgressPolicyConfigErrorCode,
  field: EgressPolicyConfigField,
): EgressPolicyNormalizationResult {
  return {
    ok: false,
    policy: Object.freeze({
      allowedHosts: Object.freeze([...(defaultEgressPolicy().allowedHosts ?? [])]),
      nat64Prefixes: Object.freeze([]),
    }),
    metadata: disabledMetadata(),
    error: Object.freeze({ code, field }),
  }
}

type ParsedConfig =
  | { kind: 'ok'; config: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'malformed' }

function parseConfig(rawConfig: unknown): ParsedConfig {
  if (rawConfig === null || rawConfig === undefined) return { kind: 'missing' }
  if (typeof rawConfig === 'string') {
    const trimmed = rawConfig.trim()
    if (!trimmed) return { kind: 'missing' }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { kind: 'ok', config: parsed as Record<string, unknown> }
        : { kind: 'malformed' }
    } catch {
      return { kind: 'malformed' }
    }
  }
  return rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? { kind: 'ok', config: rawConfig as Record<string, unknown> }
    : { kind: 'malformed' }
}

function hasOnlyAllowedConfigKeys(config: Record<string, unknown>): boolean {
  return Object.keys(config).every((key) => ALLOWED_CONFIG_KEYS.has(key))
}

function normalizeHostEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || /[^\x00-\x7F]/.test(raw)) return null
  if (raw.includes('*') || raw.includes('/') || raw.includes('@') || raw.includes('://')) return null
  if (raw.includes(':') || raw.includes('?') || raw.includes('#') || raw.includes('\\')) return null

  const host = raw.toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253 || !host.includes('.')) return null
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null
  }
  if (ipaddr.isValid(host)) return null

  const labels = host.split('.')
  if (labels.some((label) => label.length === 0 || label.length > 63)) return null
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  return host
}

function normalizeNat64Prefix(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (!raw || /[^\x00-\x7F]/.test(raw)) return null
  try {
    const cidr = ipaddr.parseCIDR(raw)
    if (cidr[0].kind() !== 'ipv6' || cidr[1] !== 96) return null
    if (cidr[0].toByteArray().slice(12).some((byte) => byte !== 0)) return null
    return `${cidr[0].toNormalizedString()}/96`
  } catch {
    return null
  }
}

function fingerprintPolicy(allowedHosts: readonly string[], nat64Prefixes: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ allowedHosts, nat64Prefixes }))
    .digest('hex')
    .slice(0, 16)
}

export function normalizeBpmnHttpTaskEgressPolicyConfig(rawConfig: unknown): EgressPolicyNormalizationResult {
  const parsed = parseConfig(rawConfig)
  if (parsed.kind === 'missing') return fail('EGRESS_POLICY_MISSING', 'config')
  if (parsed.kind === 'malformed') return fail('EGRESS_POLICY_MALFORMED', 'config')
  const { config } = parsed
  if (!hasOnlyAllowedConfigKeys(config)) return fail('EGRESS_POLICY_UNKNOWN_KEY', 'config')

  if (!Array.isArray(config.allowedHosts)) return fail('EGRESS_POLICY_MALFORMED', 'allowedHosts')
  if (config.allowedHosts.length === 0) return fail('EGRESS_POLICY_EMPTY_ALLOWLIST', 'allowedHosts')

  const allowedHosts: string[] = []
  const seenHosts = new Set<string>()
  for (const entry of config.allowedHosts) {
    const host = normalizeHostEntry(entry)
    if (!host) return fail('EGRESS_POLICY_INVALID_HOST', 'allowedHosts[]')
    if (seenHosts.has(host)) return fail('EGRESS_POLICY_DUPLICATE_HOST', 'allowedHosts[]')
    seenHosts.add(host)
    allowedHosts.push(host)
  }
  allowedHosts.sort()

  const rawNat64Prefixes = config.nat64Prefixes ?? []
  if (!Array.isArray(rawNat64Prefixes)) return fail('EGRESS_POLICY_MALFORMED', 'nat64Prefixes')

  const nat64Prefixes: string[] = []
  const seenPrefixes = new Set<string>()
  for (const entry of rawNat64Prefixes) {
    const prefix = normalizeNat64Prefix(entry)
    if (!prefix) return fail('EGRESS_POLICY_INVALID_NAT64_PREFIX', 'nat64Prefixes[]')
    if (BUILT_IN_NAT64_PREFIXES.has(prefix)) return fail('EGRESS_POLICY_DUPLICATE_NAT64_PREFIX', 'nat64Prefixes[]')
    if (seenPrefixes.has(prefix)) return fail('EGRESS_POLICY_DUPLICATE_NAT64_PREFIX', 'nat64Prefixes[]')
    seenPrefixes.add(prefix)
    nat64Prefixes.push(prefix)
  }
  nat64Prefixes.sort()

  const policy = Object.freeze({
    allowedHosts: Object.freeze([...allowedHosts]),
    nat64Prefixes: Object.freeze([...nat64Prefixes]),
  })
  const metadata = Object.freeze({
    policyPresent: true,
    allowedHostCount: allowedHosts.length,
    nat64PrefixCount: nat64Prefixes.length,
    policyFingerprint: fingerprintPolicy(allowedHosts, nat64Prefixes),
  })
  return { ok: true, policy, metadata }
}
