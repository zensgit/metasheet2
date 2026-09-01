/**
 * Governed AI service boundary — DATA-CLASSIFICATION ROUTING POLICY (the security core).
 *
 * This module owns the ONE decision that keeps customer data off cloud LLMs:
 * "given a request's data-sensitivity class and the tier of the configured
 * provider, may this request be served, and by which tier?" It is a leaf: no DB,
 * no HTTP, no provider call — a pure decision plus a deploy-file loader. The
 * boundary service (governed-ai-service.ts) is the only caller.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT (fail-closed, structurally enforced):
 *   BUSINESS-CLASS DATA NEVER ROUTES TO A CLOUD PROVIDER.
 * ─────────────────────────────────────────────────────────────────────────────
 * `decideAiRoute` has NO code path where `dataClass === 'business'` reaches a
 * `cloud`-tier provider — the business refusal is the FIRST branch on the cloud
 * arm and returns before any allowlist is consulted. A deploy-file that tries to
 * list `business` among the cloud-permitted classes is refused AT LOAD (a
 * misconfiguration, not a widening). Both together are defense in depth: the
 * router cannot express business→cloud even if the loader were bypassed.
 *
 * DEFAULT POSTURE (env unset) = LOCAL-ONLY / MOST-RESTRICTIVE. With no policy
 * file the configured provider keeps its BUILT-IN tier (anthropic / openai public
 * endpoints are `cloud`) and NO data class is cloud-permitted, so every request
 * that would touch a cloud provider is refused. A deployment opts IN to cloud for
 * `non-sensitive` by listing it, and opts IN to business AI by declaring its
 * configured provider `local` (a self-hosted, non-public endpoint).
 *
 * WHY A DEPLOY-FILE, WHY DECLARED-TIER NOT URL-SNIFFED. This mirrors the
 * outbound-http-write gate (plugins/plugin-integration-core/lib/
 * outbound-http-write-gate.cjs) and the host's `readDeployJsonObjectFile`
 * (plugin-runtime-config.ts): unset → most-restrictive default with zero I/O;
 * set-but-unreadable/malformed/not-an-object → THROW naming the ENV KEY, never
 * echoing the path (a typo must be distinguishable from "unset", and a broken
 * file must never silently degrade to a widening). A provider's tier is a
 * DECLARED deployment fact, not sniffed from a URL — the write-gate's ruling was
 * that URL matching gives false assurance (a proxy hop / CNAME / IP literal
 * defeats it). The one URL fact we DO enforce is a fail-closed downgrade: a
 * provider declared `local` whose effective base URL is a KNOWN PUBLIC CLOUD HOST
 * (or is unset, so the default public endpoint) is treated as `cloud`, so a
 * mistaken `local` declaration pointed at api.openai.com can never launder
 * business data to the public cloud.
 *
 * VALUES-FREE. A refusal / an invalid-policy error carries a FIXED code, a coarse
 * reason token, the ENV KEY, and booleans/counts — never a base URL, host, key,
 * prompt, record value, or a raw fs/JSON error string.
 */

import { AI_BASE_URL_ENV, type AiProvider } from './ai-provider-readiness'

/** Deploy-file path env (server-side JSON). Unset → most-restrictive default. */
export const AI_ROUTING_POLICY_PATH_ENV = 'MULTITABLE_AI_ROUTING_POLICY'

/**
 * Data-sensitivity classes. `business` = any customer data (BOM / drawings /
 * procurement / records). `non-sensitive` = generic help carrying NO customer
 * data. An unknown / omitted class normalizes to `business` (most restrictive) —
 * a request is never treated as less sensitive than it declares.
 */
export const AI_DATA_CLASSES = ['business', 'non-sensitive'] as const
export type AiDataClass = (typeof AI_DATA_CLASSES)[number]

/** Provider tiers. `local` = self-hosted / on-prem; `cloud` = a third-party API. */
export const AI_PROVIDER_TIERS = ['local', 'cloud'] as const
export type AiProviderTier = (typeof AI_PROVIDER_TIERS)[number]

/**
 * BUILT-IN provider tiers. The two allowlisted providers' PUBLIC endpoints are
 * cloud. A self-hosted deployment overrides this by (a) pointing
 * MULTITABLE_AI_BASE_URL at its own endpoint and (b) declaring `activeProvider.tier
 * = "local"` in the routing policy. Absent that declaration a provider is cloud.
 */
export const AI_BUILTIN_PROVIDER_TIERS: Record<AiProvider, AiProviderTier> = {
  anthropic: 'cloud',
  openai: 'cloud',
}

/**
 * Hosts that are DEFINITIONALLY public cloud. A provider DECLARED `local` but
 * whose effective base URL resolves to one of these is downgraded to `cloud`
 * (fail-closed) — "local" must mean a non-public, self-hosted endpoint.
 */
export const AI_KNOWN_CLOUD_HOSTS = ['api.anthropic.com', 'api.openai.com'] as const

/** The class that may NEVER appear in a policy's cloud-permitted set. */
const CLOUD_FORBIDDEN_CLASS: AiDataClass = 'business'

// ─── Normalized policy shape ────────────────────────────────────────────────

export interface NormalizedAiRoutingPolicy {
  policyId: string
  policyVersion: number
  /** Operator-declared tier of the configured provider (before the URL downgrade). */
  declaredProviderTier: AiProviderTier
  /** Classes a CLOUD-tier provider may serve. `business` can never be a member. */
  cloudDataClasses: readonly AiDataClass[]
}

export class AiRoutingPolicyError extends Error {
  code: 'AI_ROUTING_POLICY_INVALID'
  reason: string
  envKey: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'AiRoutingPolicyError'
    this.code = 'AI_ROUTING_POLICY_INVALID'
    this.reason = reason
    this.envKey = AI_ROUTING_POLICY_PATH_ENV
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Values-free: `reason` is a coarse token; no file value is ever echoed.
function fail(reason: string, message: string): never {
  throw new AiRoutingPolicyError(reason, message)
}

const POLICY_KEYS = ['policyId', 'policyVersion', 'activeProvider', 'cloudDataClasses'] as const
const ACTIVE_PROVIDER_KEYS = ['tier'] as const

function assertClosedKeySet(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail('unsupported_key', `${label}.${key} is not a supported key`)
  }
}

/**
 * Normalize + validate a routing policy OBJECT (already read from the deploy file).
 * Every fault is fatal (fail-closed). Refuses `business` in `cloudDataClasses` as a
 * misconfiguration — the one thing this gate exists to forbid must never be
 * expressible in config.
 */
export function normalizeAiRoutingPolicy(raw: unknown): NormalizedAiRoutingPolicy {
  if (!isPlainObject(raw)) {
    fail('not_an_object', `${AI_ROUTING_POLICY_PATH_ENV} must point at a JSON object`)
  }
  assertClosedKeySet(raw, POLICY_KEYS, 'aiRoutingPolicy')

  const policyId = typeof raw.policyId === 'string' && raw.policyId.trim() ? raw.policyId.trim() : null
  if (!policyId) fail('missing_policy_id', 'policyId is required')

  if (!Number.isInteger(raw.policyVersion) || (raw.policyVersion as number) <= 0) {
    fail('invalid_policy_version', 'policyVersion must be a positive integer')
  }

  if (!isPlainObject(raw.activeProvider)) {
    fail('missing_active_provider', 'activeProvider must be an object declaring its tier')
  }
  assertClosedKeySet(raw.activeProvider, ACTIVE_PROVIDER_KEYS, 'aiRoutingPolicy.activeProvider')
  const tier = raw.activeProvider.tier
  if (tier !== 'local' && tier !== 'cloud') {
    fail('invalid_provider_tier', 'activeProvider.tier must be "local" or "cloud"')
  }

  // cloudDataClasses is OPTIONAL; absent → no class may reach a cloud provider.
  let cloudDataClasses: AiDataClass[] = []
  if (raw.cloudDataClasses !== undefined && raw.cloudDataClasses !== null) {
    if (!Array.isArray(raw.cloudDataClasses)) {
      fail('invalid_cloud_classes', 'cloudDataClasses must be an array of data classes')
    }
    const seen = new Set<string>()
    for (const entry of raw.cloudDataClasses) {
      if (typeof entry !== 'string' || !(AI_DATA_CLASSES as readonly string[]).includes(entry)) {
        fail('unknown_cloud_class', 'cloudDataClasses contains an unknown data class')
      }
      // THE HARD REFUSAL: business can never be authorized for cloud, not even
      // by an explicit deploy-file entry. Listing it is a misconfiguration.
      if (entry === CLOUD_FORBIDDEN_CLASS) {
        fail(
          'business_cloud_forbidden',
          'cloudDataClasses must not include "business"; business data never routes to a cloud provider',
        )
      }
      if (seen.has(entry)) fail('duplicate_cloud_class', 'cloudDataClasses must not repeat a class')
      seen.add(entry)
      cloudDataClasses.push(entry as AiDataClass)
    }
  }

  return Object.freeze({
    policyId,
    policyVersion: raw.policyVersion as number,
    declaredProviderTier: tier as AiProviderTier,
    cloudDataClasses: Object.freeze(cloudDataClasses),
  })
}

export type AiReadEnv = Record<string, string | undefined>

/**
 * Read the routing policy off the environment. THREE states, exactly like the
 * outbound-write gate:
 *   * env unset / blank     -> `null` (MOST-RESTRICTIVE DEFAULT; zero file I/O).
 *   * env set, file usable  -> a frozen, validated policy.
 *   * env set, anything else -> THROWS AiRoutingPolicyError. Never `null`: a typo
 *     in the path must be distinguishable from "unset", and a broken file must
 *     never silently degrade into a widening.
 *
 * `env` is a seam for tests only; production calls it with no args. `readFileSync`
 * is required lazily so the leaf carries no eager fs dependency.
 */
export function loadAiRoutingPolicyFile(env: AiReadEnv = process.env): NormalizedAiRoutingPolicy | null {
  const raw = env[AI_ROUTING_POLICY_PATH_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const filePath = raw.trim()

  let contents: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    contents = (require('node:fs') as typeof import('node:fs')).readFileSync(filePath, 'utf8')
  } catch {
    // Values-free: the path is deployment topology, named by ENV KEY, never echoed.
    fail('unreadable', `${AI_ROUTING_POLICY_PATH_ENV} points at a file that could not be read`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    fail('malformed_json', `${AI_ROUTING_POLICY_PATH_ENV} must point at a file containing valid JSON`)
  }
  return normalizeAiRoutingPolicy(parsed)
}

// ─── Provider-tier resolution (declared tier + fail-closed URL downgrade) ────

function effectiveBaseUrlHost(env: AiReadEnv): string | null {
  const raw = typeof env[AI_BASE_URL_ENV] === 'string' ? env[AI_BASE_URL_ENV]!.trim() : ''
  if (!raw) return null
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

export interface ResolvedProviderTier {
  tier: AiProviderTier
  /** True when a declared `local` provider was forced to `cloud` by the URL guard. */
  downgraded: boolean
}

/**
 * Resolve the EFFECTIVE tier of the configured provider.
 *
 *   - No policy (null) OR policy declares `cloud`  -> the provider's BUILT-IN tier
 *     (anthropic / openai = cloud). Most-restrictive default.
 *   - Policy declares `local`  -> `local` ONLY IF the effective base URL is a
 *     non-public, explicitly-set host; otherwise DOWNGRADED to `cloud`
 *     (fail-closed) so a `local` claim pointed at (or defaulting to) a public
 *     cloud host can never carry business data off-prem.
 */
export function resolveActiveProviderTier(
  provider: AiProvider,
  policy: NormalizedAiRoutingPolicy | null,
  env: AiReadEnv = process.env,
): ResolvedProviderTier {
  const builtin = AI_BUILTIN_PROVIDER_TIERS[provider] ?? 'cloud'
  if (!policy || policy.declaredProviderTier !== 'local') {
    return { tier: builtin, downgraded: false }
  }
  // Declared local: require an explicit, non-public base URL.
  const host = effectiveBaseUrlHost(env)
  if (host === null || (AI_KNOWN_CLOUD_HOSTS as readonly string[]).includes(host)) {
    return { tier: 'cloud', downgraded: true }
  }
  return { tier: 'local', downgraded: false }
}

// ─── The decision (the pure security core) ──────────────────────────────────

export type AiRouteRefusalReason =
  | 'business_data_cloud_forbidden'
  | 'class_not_cloud_authorized'

export type AiRouteDecision =
  | { allowed: true; tier: AiProviderTier }
  | { allowed: false; reason: AiRouteRefusalReason }

/**
 * THE DECISION. Pure, total, and structurally incapable of business→cloud.
 *
 * `dataClass` is normalized by the caller (unknown → 'business'); passing an
 * unexpected value here is treated as business too (belt and suspenders).
 *
 * A `local` provider serves ANY class (local is strictly safer). A `cloud`
 * provider serves a class ONLY IF it is not business AND the class is
 * cloud-permitted. The business refusal is the FIRST cloud-arm branch — no
 * allowlist can reach past it.
 */
export function decideAiRoute(
  dataClass: AiDataClass | string,
  tier: AiProviderTier,
  cloudDataClasses: readonly AiDataClass[],
): AiRouteDecision {
  // Normalize defensively: anything that is not the explicit non-sensitive token
  // is treated as business (most restrictive).
  const normalized: AiDataClass = dataClass === 'non-sensitive' ? 'non-sensitive' : 'business'

  if (tier === 'local') {
    return { allowed: true, tier: 'local' }
  }

  // tier === 'cloud' from here.
  if (normalized === 'business') {
    // HARD BAN — first, before any allowlist consult.
    return { allowed: false, reason: 'business_data_cloud_forbidden' }
  }
  if (cloudDataClasses.includes(normalized)) {
    return { allowed: true, tier: 'cloud' }
  }
  return { allowed: false, reason: 'class_not_cloud_authorized' }
}

/** Normalize a caller-supplied (possibly omitted) data class to the most-restrictive certain value. */
export function normalizeDataClass(value: AiDataClass | string | undefined | null): AiDataClass {
  return value === 'non-sensitive' ? 'non-sensitive' : 'business'
}
