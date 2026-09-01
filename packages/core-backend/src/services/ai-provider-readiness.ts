/**
 * Multitable AI provider readiness — A1 declarative resolver.
 *
 * Design lock: docs/development/multitable-ai-provider-readiness-a1-design-20260610.md §2.1
 * (env contract E-1..E-12 ratified by the M0 result, #1571 table read-only).
 * Mirrors the `resolveEmailTransportReadiness(env?)` precedent
 * (services/email-transport-readiness.ts): pure function, no class, no DB,
 * and — A1-specific — NO provider HTTP call of any kind. `ready` means the
 * declared env contract is satisfied, NOT that the key is valid.
 *
 * Leak policy (hard):
 *   - E-2 / E-5 / E-4 invalid values are echoed as `<invalid>` only — never raw
 *     (an invalid MODEL or BASE_URL value may be a mispasted secret).
 *   - E-3 is a presence-only check; the key value is never read into a message.
 *   - Non-numeric cap values (E-6..E-11) are echoed as `<invalid>` only.
 *   - The report contains no env VALUES — only env NAMES, allowlisted
 *     constants, and parsed numbers — with ONE scoped exception: the LOCAL
 *     lane's `model` is operator-named (no allowlist exists to quote from), so
 *     the report carries it VERBATIM after a shape guard + the shared
 *     secret-shape redactor both accept it; a value either of them rejects is
 *     echoed as `<invalid>` only.
 *   - E-12 is declared informationally and NEVER consumed in A1 (no live-call
 *     path exists for it to gate); real consumption belongs to M2.
 *
 * LOCAL LANE (the #5419 boundary made this deployment the design intent; this
 * file previously made it UNEXPRESSIBLE): provider `local-openai-compat` is a
 * self-hosted OpenAI-compatible server (vLLM / Ollama). Its contract differs
 * from the cloud lanes in exactly three declared ways —
 *   - E-4 BASE_URL is REQUIRED, and its host must pass the routing policy's
 *     OWN positive local proof (`isProvablyLocalHost`, ai-routing-policy.ts —
 *     imported, never approximated: one source of truth for "local");
 *   - E-3 API_KEY is OPTIONAL (many local servers are keyless; when set the
 *     client passes it through as a bearer token);
 *   - E-5 MODEL is operator-named: free-form non-empty, no cloud allowlist —
 *     but blank/missing still blocks (there is no local default model).
 * Everything else (enable flag, caps, E-12 double-confirm) is identical, and
 * the CLOUD contract is byte-for-byte unchanged.
 */

import { redactString } from '../multitable/automation-log-redact'
// DELIBERATE import cycle with ai-routing-policy.ts (which imports this file's
// env-name/type constants): the LOCAL lane's readiness gate reuses the routing
// policy's OWN locality proof — one source of truth, no readiness-side
// approximation. The cycle is eval-time-safe BY CONSTRUCTION: neither module
// touches the other's bindings during module evaluation (this side calls them
// inside resolveAiProviderReadiness only; that side keys its builtin-tier
// table with a literal, documented there), so load order cannot matter.
import {
  AI_ROUTING_POLICY_PATH_ENV,
  effectiveBaseUrlHost,
  isProvablyLocalHost,
  loadAiRoutingPolicyFile,
} from './ai-routing-policy'

export const AI_ENABLED_ENV = 'MULTITABLE_AI_ENABLED' // E-1
export const AI_PROVIDER_ENV = 'MULTITABLE_AI_PROVIDER' // E-2
export const AI_API_KEY_ENV = 'MULTITABLE_AI_API_KEY' // E-3
export const AI_BASE_URL_ENV = 'MULTITABLE_AI_BASE_URL' // E-4
export const AI_MODEL_ENV = 'MULTITABLE_AI_MODEL' // E-5
export const AI_REQUEST_TIMEOUT_MS_ENV = 'MULTITABLE_AI_REQUEST_TIMEOUT_MS' // E-6
export const AI_MAX_OUTPUT_TOKENS_ENV = 'MULTITABLE_AI_MAX_OUTPUT_TOKENS' // E-7
export const AI_TENANT_DAILY_TOKEN_CAP_ENV = 'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP' // E-8
export const AI_TENANT_WEEKLY_TOKEN_CAP_ENV = 'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP' // E-9
export const AI_TENANT_BURST_RPM_ENV = 'MULTITABLE_AI_TENANT_BURST_RPM' // E-10
export const AI_ACCOUNT_DAILY_USD_CAP_ENV = 'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP' // E-11
export const AI_CONFIRM_LIVE_REQUESTS_ENV = 'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS' // E-12

/** Names whose presence forms the readiness contract (A1-T1). */
export const AI_REQUIRED_ENV = [
  AI_ENABLED_ENV,
  AI_PROVIDER_ENV,
  AI_API_KEY_ENV,
  AI_MODEL_ENV,
] as const

/** Optional names: E-4 plus the declarative caps and the M2-only E-12 flag. */
export const AI_OPTIONAL_ENV = [
  AI_BASE_URL_ENV,
  AI_REQUEST_TIMEOUT_MS_ENV,
  AI_MAX_OUTPUT_TOKENS_ENV,
  AI_TENANT_DAILY_TOKEN_CAP_ENV,
  AI_TENANT_WEEKLY_TOKEN_CAP_ENV,
  AI_TENANT_BURST_RPM_ENV,
  AI_ACCOUNT_DAILY_USD_CAP_ENV,
  AI_CONFIRM_LIVE_REQUESTS_ENV,
] as const

/**
 * The LOCAL lane's presence contract, reported when E-2 = AI_LOCAL_PROVIDER:
 * BASE_URL moves into required (no default endpoint exists), API_KEY moves out
 * (keyless servers are first-class). The default/cloud lists above stay the
 * report surface for every other provider value, unchanged.
 */
export const AI_LOCAL_REQUIRED_ENV = [
  AI_ENABLED_ENV,
  AI_PROVIDER_ENV,
  AI_MODEL_ENV,
  AI_BASE_URL_ENV,
] as const

export const AI_LOCAL_OPTIONAL_ENV = [
  AI_API_KEY_ENV,
  AI_REQUEST_TIMEOUT_MS_ENV,
  AI_MAX_OUTPUT_TOKENS_ENV,
  AI_TENANT_DAILY_TOKEN_CAP_ENV,
  AI_TENANT_WEEKLY_TOKEN_CAP_ENV,
  AI_TENANT_BURST_RPM_ENV,
  AI_ACCOUNT_DAILY_USD_CAP_ENV,
  AI_CONFIRM_LIVE_REQUESTS_ENV,
] as const

/** P-1 ratified CLOUD allowlist: anthropic + openai. */
export const AI_CLOUD_PROVIDER_ALLOWLIST = ['anthropic', 'openai'] as const
export type AiCloudProvider = (typeof AI_CLOUD_PROVIDER_ALLOWLIST)[number]

/**
 * The ONE local lane: a self-hosted OpenAI-compatible server (vLLM / Ollama
 * serving e.g. Qwen / DeepSeek weights) on a PROVABLY LOCAL host — the
 * deployment the governed-AI boundary (#5419) names as its design intent.
 * A single token in a closed vocabulary: a second local protocol is an
 * extend-by-PR decision, never a runtime widening.
 */
export const AI_LOCAL_PROVIDER = 'local-openai-compat' as const

/** The full provider vocabulary: the two cloud lanes + the one local lane; others → blocked. */
export const AI_PROVIDER_ALLOWLIST = [...AI_CLOUD_PROVIDER_ALLOWLIST, AI_LOCAL_PROVIDER] as const
export type AiProvider = (typeof AI_PROVIDER_ALLOWLIST)[number]

/**
 * Per-CLOUD-provider model allowlists (E-5). Operator contract constants —
 * extend by PR, never at runtime. An explicit value outside the table blocks
 * readiness. The LOCAL lane deliberately has NO allowlist: the operator names
 * whatever model their own server hosts (shape-guarded below).
 */
export const AI_MODEL_ALLOWLISTS: Record<AiCloudProvider, readonly string[]> = {
  anthropic: [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
  ],
}

/** Default model per CLOUD provider when E-5 is unset. The local lane has NO default — E-5 is required there. */
export const AI_DEFAULT_MODELS: Record<AiCloudProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o-mini',
}

/**
 * LOCAL-lane model shape guard. The local model name is the one env-derived
 * value the report carries verbatim (there is no allowlist constant to quote
 * instead), so a mispasted secret must be caught BEFORE it can ride into the
 * report: plausible model names (`qwen2.5:14b-instruct`,
 * `Qwen/Qwen2.5-72B-Instruct`, `llama3.1:70b-instruct-q4_K_M`) are short runs
 * of `[A-Za-z0-9._:/-]`; anything else — whitespace, `@`, `?`, over-length —
 * is `<invalid>`. The shared secret-shape redactor is applied on top (an
 * `sk-…` key fits this charset; `redactString` catches it).
 */
export const AI_LOCAL_MODEL_MAX_LENGTH = 200
const LOCAL_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/**
 * T6 status enum — FULL set declared at A1; only the first three are ever
 * emitted here. The reserved four are derived by A2 (which owns closing T6).
 */
export type AiProviderReadinessStatus =
  | 'disabled'
  | 'blocked'
  | 'ready'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_error'
  | 'unsafe_input'

export const AI_EMITTED_STATUSES = ['disabled', 'blocked', 'ready'] as const
export const AI_RESERVED_STATUSES = [
  'rate_limited',
  'quota_exhausted',
  'provider_error',
  'unsafe_input',
] as const

/** Declarative caps (#1571 §2.4/§2.6 approved defaults/bounds). A1 has NO enforcement point. */
export interface AiProviderCaps {
  requestTimeoutMs: number
  maxOutputTokens: number
  tenantDailyTokenCap: number
  tenantWeeklyTokenCap: number
  tenantBurstRpm: number
  accountDailyUsdCap: number
}

export interface AiProviderReadinessReport {
  ok: boolean
  status: AiProviderReadinessStatus
  provider?: AiProvider
  model?: string
  caps: AiProviderCaps
  messages: string[]
  requiredEnv: string[]
  optionalEnv: string[]
}

export type AiReadinessEnv = Record<string, string | undefined>

const INVALID = '<invalid>'

interface CapSpec {
  name: string
  capKey: keyof AiProviderCaps
  approvedDefault: number
  min?: number
  max?: number
}

// #1571-approved numbers: E-6 default 15000 [1000..60000]; E-7 default 1024
// [64..4096]; E-8 default 100000 (min 1000); E-9/E-10/E-11 defaults only
// (500000 / 30 / 10) — no approved bounds, so invalid input falls back to the
// approved default instead of clamping. Intentional divergence from the email
// precedent (which blocks on invalid numerics): A1 caps are declaration-only
// with no execution point, so degrading to the approved default is more
// proportionate than blocking readiness; the message keeps it auditable.
const CAP_SPECS: readonly CapSpec[] = [
  { name: AI_REQUEST_TIMEOUT_MS_ENV, capKey: 'requestTimeoutMs', approvedDefault: 15000, min: 1000, max: 60000 },
  { name: AI_MAX_OUTPUT_TOKENS_ENV, capKey: 'maxOutputTokens', approvedDefault: 1024, min: 64, max: 4096 },
  { name: AI_TENANT_DAILY_TOKEN_CAP_ENV, capKey: 'tenantDailyTokenCap', approvedDefault: 100000, min: 1000 },
  { name: AI_TENANT_WEEKLY_TOKEN_CAP_ENV, capKey: 'tenantWeeklyTokenCap', approvedDefault: 500000 },
  { name: AI_TENANT_BURST_RPM_ENV, capKey: 'tenantBurstRpm', approvedDefault: 30 },
  { name: AI_ACCOUNT_DAILY_USD_CAP_ENV, capKey: 'accountDailyUsdCap', approvedDefault: 10 },
]

function envString(env: AiReadinessEnv, name: string): string {
  const value = env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function isValidHttpUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** Parse one cap env: clamp into approved bounds, or fall back to the approved default. Never blocks. */
function resolveCap(env: AiReadinessEnv, spec: CapSpec, messages: string[]): number {
  const raw = envString(env, spec.name)
  if (!raw) return spec.approvedDefault
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    // Raw value may be a mispasted secret — echo `<invalid>` only.
    messages.push(
      `${spec.name}=${INVALID} is not a positive integer; falling back to the approved default ${spec.approvedDefault}.`,
    )
    return spec.approvedDefault
  }
  if (spec.min !== undefined && value < spec.min) {
    messages.push(`${spec.name}=${value} is below the approved minimum; clamped to ${spec.min}.`)
    return spec.min
  }
  if (spec.max !== undefined && value > spec.max) {
    messages.push(`${spec.name}=${value} is above the approved maximum; clamped to ${spec.max}.`)
    return spec.max
  }
  return value
}

export function resolveAiProviderReadiness(
  env: AiReadinessEnv = process.env,
): AiProviderReadinessReport {
  const statusMessages: string[] = []
  const capMessages: string[] = []

  // Declarative caps are always resolved — they have no execution point in A1.
  const caps = {} as AiProviderCaps
  for (const spec of CAP_SPECS) {
    caps[spec.capKey] = resolveCap(env, spec, capMessages)
  }

  let status: AiProviderReadinessStatus
  let provider: AiProvider | undefined
  let model: string | undefined

  const enabled = envString(env, AI_ENABLED_ENV) === '1'
  if (!enabled) {
    status = 'disabled'
    statusMessages.push(
      `${AI_ENABLED_ENV} is not '1'; multitable AI readiness is disabled (default deployment posture).`,
    )
  } else {
    const blockers: string[] = []

    const providerRaw = envString(env, AI_PROVIDER_ENV)
    if (!providerRaw) {
      blockers.push(`${AI_PROVIDER_ENV} is required when ${AI_ENABLED_ENV}=1.`)
    } else if ((AI_PROVIDER_ALLOWLIST as readonly string[]).includes(providerRaw)) {
      provider = providerRaw as AiProvider
    } else {
      blockers.push(
        `${AI_PROVIDER_ENV}=${INVALID} is not an allowed provider (${AI_PROVIDER_ALLOWLIST.join(', ')}).`,
      )
    }

    // E-3: presence is required for the CLOUD lanes (and while the provider is
    // unset/invalid — the cloud contract is the default posture). The LOCAL
    // lane treats the key as OPTIONAL: many self-hosted servers are keyless,
    // and demanding a dummy value here was exactly the lie this lane removes.
    // When set, the client passes it through as a bearer token.
    if (provider !== AI_LOCAL_PROVIDER && envString(env, AI_API_KEY_ENV).length === 0) {
      blockers.push(
        `${AI_API_KEY_ENV} is missing or blank; readiness checks presence only and never echoes or validates the key.`,
      )
    }

    if (provider === AI_LOCAL_PROVIDER) {
      // E-5, LOCAL lane: operator-named, free-form — but NON-EMPTY (there is no
      // local default model) and shape-guarded (it rides into the report; see
      // the leak-policy exception in the header).
      const modelRaw = envString(env, AI_MODEL_ENV)
      if (!modelRaw) {
        blockers.push(
          `${AI_MODEL_ENV} is required for provider '${AI_LOCAL_PROVIDER}': name the model your local server hosts; there is no default and no cloud allowlist applies.`,
        )
      } else if (
        modelRaw.length > AI_LOCAL_MODEL_MAX_LENGTH ||
        !LOCAL_MODEL_SHAPE.test(modelRaw) ||
        redactString(modelRaw) !== modelRaw
      ) {
        blockers.push(
          `${AI_MODEL_ENV}=${INVALID} is not a plausible local model name ([A-Za-z0-9._:/-], max ${AI_LOCAL_MODEL_MAX_LENGTH} chars, not secret-shaped); the raw value is never echoed.`,
        )
      } else {
        model = modelRaw
      }
    } else if (provider) {
      const modelRaw = envString(env, AI_MODEL_ENV)
      if (!modelRaw) {
        model = AI_DEFAULT_MODELS[provider]
        statusMessages.push(`${AI_MODEL_ENV} is not set; using the ${provider} default "${model}".`)
      } else if (AI_MODEL_ALLOWLISTS[provider].includes(modelRaw)) {
        model = modelRaw
      } else {
        blockers.push(`${AI_MODEL_ENV}=${INVALID} is not in the ${provider} model allowlist.`)
      }
    }

    const baseUrlRaw = envString(env, AI_BASE_URL_ENV)
    if (baseUrlRaw && !isValidHttpUrl(baseUrlRaw)) {
      blockers.push(
        `${AI_BASE_URL_ENV}=${INVALID} is not a valid http(s) URL; the raw value is never echoed (URLs may embed credentials).`,
      )
    }

    // E-4, LOCAL lane: REQUIRED, and the host must pass the routing policy's
    // OWN positive local proof. THE GUARANTEE this lane keeps: you cannot
    // configure business data onto a public endpoint by CALLING it local —
    // the same `isProvablyLocalHost` that decides the routing tier decides
    // readiness (imported from ai-routing-policy.ts; one source of truth).
    if (provider === AI_LOCAL_PROVIDER) {
      if (!baseUrlRaw) {
        blockers.push(
          `${AI_BASE_URL_ENV} is required for provider '${AI_LOCAL_PROVIDER}': the local lane has no default endpoint.`,
        )
      } else if (isValidHttpUrl(baseUrlRaw)) {
        let localHosts: readonly string[] = []
        let policyBroken = false
        try {
          const policy = loadAiRoutingPolicyFile(env)
          localHosts = policy ? policy.localHosts : []
        } catch {
          // Fail CLOSED: a broken policy file must never silently degrade to an
          // empty `localHosts` (that could flip a listed on-prem host to blocked
          // silently — or worse, mask a widening the operator believes is active).
          policyBroken = true
        }
        if (policyBroken) {
          blockers.push(
            `${AI_ROUTING_POLICY_PATH_ENV} is set but unusable, so the '${AI_LOCAL_PROVIDER}' locality proof cannot consult localHosts; failing closed (fix or unset the policy file).`,
          )
        } else if (!isProvablyLocalHost(effectiveBaseUrlHost(env), localHosts)) {
          blockers.push(
            `${AI_BASE_URL_ENV} host is NOT provably local, so provider '${AI_LOCAL_PROVIDER}' is blocked: point it at loopback / an RFC1918-class address, a .local/.internal/.lan/.home.arpa name, or a host listed in the routing policy's localHosts. Business data never reaches a public endpoint by naming it local; the raw URL is never echoed.`,
          )
        }
      }
    }

    if (blockers.length > 0) {
      status = 'blocked'
      statusMessages.push(...blockers)
    } else {
      status = 'ready'
      statusMessages.push(
        'AI provider env contract is satisfied; declarative readiness only — no provider request is sent and the API key is not validated.',
      )
    }
  }

  return {
    ok: status === 'ready',
    status,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    caps,
    messages: [
      ...statusMessages,
      ...capMessages,
      // E-12 informational declaration — unconditional and never consumed in A1
      // (A1-T4b: the report must be byte-identical whether or not E-12 is set).
      `${AI_CONFIRM_LIVE_REQUESTS_ENV} is declared for M2 live-request confirmation only; A1 never consumes it and has no live call path.`,
    ],
    requiredEnv: provider === AI_LOCAL_PROVIDER ? [...AI_LOCAL_REQUIRED_ENV] : [...AI_REQUIRED_ENV],
    optionalEnv: provider === AI_LOCAL_PROVIDER ? [...AI_LOCAL_OPTIONAL_ENV] : [...AI_OPTIONAL_ENV],
  }
}

export function renderAiProviderReadinessMarkdown(report: AiProviderReadinessReport): string {
  const lines = [
    '# Multitable AI Provider Readiness (A1)',
    '',
    `- Status: \`${report.status}\``,
    `- OK: \`${report.ok ? 'yes' : 'no'}\``,
    `- Provider: \`${report.provider ?? '<unset>'}\``,
    `- Model: \`${report.model ?? '<unset>'}\``,
    '',
    '## Declared caps (no enforcement point in A1)',
    '',
    '| Cap | Value |',
    '| --- | --- |',
    `| requestTimeoutMs | ${report.caps.requestTimeoutMs} |`,
    `| maxOutputTokens | ${report.caps.maxOutputTokens} |`,
    `| tenantDailyTokenCap | ${report.caps.tenantDailyTokenCap} |`,
    `| tenantWeeklyTokenCap | ${report.caps.tenantWeeklyTokenCap} |`,
    `| tenantBurstRpm | ${report.caps.tenantBurstRpm} |`,
    `| accountDailyUsdCap | ${report.caps.accountDailyUsdCap} |`,
    '',
    '## Messages',
    '',
    ...report.messages.map((message) => `- ${message}`),
    '',
    '## Required env (presence contract)',
    '',
    ...report.requiredEnv.map((name) => `- \`${name}\``),
    '',
    '## Optional env',
    '',
    ...report.optionalEnv.map((name) => `- \`${name}\``),
    '',
    '## Notes',
    '',
    '- This is a declarative readiness gate: it never calls the provider and never validates the API key.',
    '- Env values are never rendered — invalid values are reported as `<invalid>` only.',
  ]
  return `${lines.join('\n')}\n`
}
