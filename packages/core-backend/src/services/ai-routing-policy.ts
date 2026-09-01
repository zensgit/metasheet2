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
 * defeats it). But a DECLARATION ALONE IS NOT ENOUGH, and this is the correction
 * that adversarial review forced: an earlier revision downgraded a `local` claim
 * only when its host matched a two-entry DENYLIST of known cloud hosts, so a
 * provider declared `local` pointed at `api.deepseek.com` (or any other public
 * endpoint outside the two names) stayed `local` and business data was POSTed to
 * it. A denylist of public AI hosts can never be complete.
 *
 * So the tier check is now POSITIVE: a provider may be treated as `local` ONLY IF
 * its effective base-URL host is PROVABLY non-public — loopback, an RFC1918 /
 * link-local / unique-local / CGNAT address, a `.local`/`.internal`/`.lan`/
 * `.home.arpa` name, or a host the deployment explicitly listed in the policy's
 * `localHosts` on-prem allowlist. ANYTHING ELSE IS `cloud`, whatever the policy
 * declares. A self-hosted vLLM/Ollama endpoint is exactly a private address, so
 * the intended deployment is unaffected. The IP classification REUSES the
 * hardened `isBlockedEgressIp` from guards/egress-guard.ts (ipaddr.js), which
 * already resolves IPv4-mapped IPv6, NAT64, 6to4 and ISATAP smuggling — a
 * hand-rolled private-range regex here would be a strictly worse copy.
 *
 * VALUES-FREE. A refusal / an invalid-policy error carries a FIXED code, a coarse
 * reason token, the ENV KEY, and booleans/counts — never a base URL, host, key,
 * prompt, record value, or a raw fs/JSON error string.
 */

import { isBlockedEgressIp } from '../guards/egress-guard'
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
 * DNS suffixes that are definitionally non-public. Everything else must prove
 * itself private by IP class or by the policy's explicit `localHosts` allowlist.
 */
export const AI_PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.localhost'] as const

/** The class that may NEVER appear in a policy's cloud-permitted set. */
const CLOUD_FORBIDDEN_CLASS: AiDataClass = 'business'

// ─── Normalized policy shape ────────────────────────────────────────────────

export interface NormalizedAiRoutingPolicy {
  policyId: string
  policyVersion: number
  /** Operator-declared tier of the configured provider (a CLAIM — the positive check still decides). */
  declaredProviderTier: AiProviderTier
  /** Classes a CLOUD-tier provider may serve. `business` can never be a member. */
  cloudDataClasses: readonly AiDataClass[]
  /**
   * Explicit on-prem host allowlist: hosts the deployment certifies are its own
   * self-hosted infrastructure. The escape hatch for an on-prem endpoint behind a
   * PUBLIC DNS NAME that resolves to a private address (e.g. `llm.corp.example.com`)
   * — which the IP/suffix checks cannot see, because this module classifies the
   * hostname STRING and never resolves DNS. Exact hosts only; no wildcards.
   */
  localHosts: readonly string[]
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

const POLICY_KEYS = ['policyId', 'policyVersion', 'activeProvider', 'cloudDataClasses', 'localHosts'] as const
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

  // Optional on-prem allowlist. Exact hosts only — a wildcard here would rebuild
  // the "anything can claim local" hole the positive check exists to close.
  const localHosts: string[] = []
  if (raw.localHosts !== undefined && raw.localHosts !== null) {
    if (!Array.isArray(raw.localHosts)) fail('invalid_local_hosts', 'localHosts must be an array of hosts')
    for (const entry of raw.localHosts) {
      if (typeof entry !== 'string' || !entry.trim()) {
        fail('invalid_local_hosts', 'localHosts entries must be non-empty host strings')
      }
      const host = entry.trim().toLowerCase().replace(/\.$/, '')
      if (host.includes('*') || host.includes('/') || host.includes('://') || host.includes('@')) {
        fail('local_host_wildcard', 'localHosts must name exact hosts; no wildcard, scheme, path or userinfo')
      }
      if (localHosts.includes(host)) fail('duplicate_local_host', 'localHosts must not repeat a host')
      localHosts.push(host)
    }
  }

  return Object.freeze({
    policyId,
    policyVersion: raw.policyVersion as number,
    declaredProviderTier: tier as AiProviderTier,
    cloudDataClasses: Object.freeze(cloudDataClasses),
    localHosts: Object.freeze(localHosts),
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

// ─── Provider-tier resolution (declared tier + POSITIVE local proof) ────────

function effectiveBaseUrlHost(env: AiReadEnv): string | null {
  const raw = typeof env[AI_BASE_URL_ENV] === 'string' ? env[AI_BASE_URL_ENV]!.trim() : ''
  if (!raw) return null
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

/**
 * POSITIVE local proof — the correction for the denylist hole. A host counts as
 * local ONLY IF it proves itself non-public:
 *
 *   1. the deployment listed it in the policy's `localHosts` on-prem allowlist
 *      (the escape hatch for a private endpoint behind a public DNS name), OR
 *   2. it is `localhost` or carries a definitionally-private DNS suffix, OR
 *   3. it is an IP LITERAL that is not publicly routable — delegated to
 *      `isBlockedEgressIp` (guards/egress-guard.ts), which returns true for
 *      loopback / RFC1918 / link-local / unique-local / CGNAT and also decodes
 *      IPv4-mapped IPv6, NAT64, 6to4 and ISATAP smuggling.
 *
 * ANY other host — a public DNS name like `api.deepseek.com`, a public IP — is
 * NOT local. This is a positive test: an unrecognised host fails it, so a new
 * public AI vendor can never slip through the way a denylist let DeepSeek through.
 */
export function isProvablyLocalHost(host: string | null, localHosts: readonly string[] = []): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  // 1. explicit, reviewed on-prem allowlist
  if (localHosts.includes(h)) return true
  // 2. definitionally-private names
  if (h === 'localhost') return true
  for (const suffix of AI_PRIVATE_HOST_SUFFIXES) {
    if (h.endsWith(suffix)) return true
  }
  // 3. non-publicly-routable IP literals (reuses the hardened egress classifier).
  //    isBlockedEgressIp returns FALSE for a non-IP hostname, so a public DNS
  //    name falls through to the refusal below — exactly the intended default.
  try {
    if (isBlockedEgressIp(h)) return true
  } catch {
    // A classifier fault must never be read as "local".
    return false
  }
  return false
}

export interface ResolvedProviderTier {
  tier: AiProviderTier
  /** True when a declared `local` provider failed the positive local proof and was forced to `cloud`. */
  downgraded: boolean
}

/**
 * Resolve the EFFECTIVE tier of the configured provider.
 *
 *   - No policy (null) OR policy declares `cloud`  -> the provider's BUILT-IN tier
 *     (anthropic / openai = cloud). Most-restrictive default.
 *   - Policy declares `local`  -> `local` ONLY IF the explicitly-set base-URL host
 *     PASSES the positive local proof; otherwise DOWNGRADED to `cloud`. A
 *     declaration is a claim, not evidence.
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
  // Declared local: the host must PROVE it. Unset base URL → the default public
  // endpoint → not local.
  const host = effectiveBaseUrlHost(env)
  if (!isProvablyLocalHost(host, policy.localHosts)) {
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

// ─── THE CHOKE every provider call passes through ───────────────────────────

export type AiRouteAuthorizationReason = AiRouteRefusalReason | 'routing_policy_invalid'

export type AiRouteAuthorization =
  | { allowed: true; tier: AiProviderTier }
  | { allowed: false; reason: AiRouteAuthorizationReason; message: string }

/**
 * Load the policy, resolve the effective tier, and decide — the WHOLE routing
 * gate as ONE call, so there is exactly one implementation of "may this data
 * class reach this provider?" and no consumer can assemble a weaker variant.
 *
 * BOTH consumers use this:
 *   - `GovernedAiService.suggest()` (the boundary, for new features);
 *   - `runShortcutCore()` in ai-bulk-shared.ts — the shipped multitable-AI
 *     shortcut / bulk-fill / async-worker path, whose prompts carry customer
 *     record content and which previously called the provider with NO data-class
 *     gate at all (the adversarial-review P0).
 *
 * NEVER THROWS. A broken deploy-file is caught and returned as a REFUSAL
 * (`routing_policy_invalid`) — fail-closed for routing (no provider is called),
 * while leaving the caller free to degrade gracefully. The thrown error's message
 * is values-free but is deliberately NOT propagated to the caller's message here;
 * a fixed string keeps refusals uniform.
 */
export function authorizeAiRoute(
  provider: AiProvider,
  dataClass: AiDataClass | string,
  env: AiReadEnv = process.env,
): AiRouteAuthorization {
  let policy: NormalizedAiRoutingPolicy | null
  try {
    policy = loadAiRoutingPolicyFile(env)
  } catch {
    return {
      allowed: false,
      reason: 'routing_policy_invalid',
      message: 'AI routing policy is misconfigured; the request was not sent to any provider.',
    }
  }

  const tier = resolveActiveProviderTier(provider, policy, env).tier
  const decision = decideAiRoute(dataClass, tier, policy ? policy.cloudDataClasses : [])
  // `in`-guard (not `!decision.allowed`): non-strict tsconfig, no boolean-discriminant narrowing.
  if ('reason' in decision) {
    return {
      allowed: false,
      reason: decision.reason,
      message:
        decision.reason === 'business_data_cloud_forbidden'
          ? 'Business-class data is not routed to a cloud AI provider; the request was not sent.'
          : 'This data class is not authorized for a cloud AI provider; the request was not sent.',
    }
  }
  return { allowed: true, tier: decision.tier }
}
