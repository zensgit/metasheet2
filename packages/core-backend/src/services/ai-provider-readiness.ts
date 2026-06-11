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
 *   - The report therefore contains no env VALUES at all — only env NAMES,
 *     allowlisted constants, and parsed numbers.
 *   - E-12 is declared informationally and NEVER consumed in A1 (no live-call
 *     path exists for it to gate); real consumption belongs to M2.
 */

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

/** P-1 ratified allowlist: anthropic + openai only; others → blocked. */
export const AI_PROVIDER_ALLOWLIST = ['anthropic', 'openai'] as const
export type AiProvider = (typeof AI_PROVIDER_ALLOWLIST)[number]

/**
 * Per-provider model allowlists (E-5). Operator contract constants — extend by
 * PR, never at runtime. An explicit value outside the table blocks readiness.
 */
export const AI_MODEL_ALLOWLISTS: Record<AiProvider, readonly string[]> = {
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

/** Default model per provider when E-5 is unset. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o-mini',
}

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

    if (envString(env, AI_API_KEY_ENV).length === 0) {
      blockers.push(
        `${AI_API_KEY_ENV} is missing or blank; readiness checks presence only and never echoes or validates the key.`,
      )
    }

    if (provider) {
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
    requiredEnv: [...AI_REQUIRED_ENV],
    optionalEnv: [...AI_OPTIONAL_ENV],
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
