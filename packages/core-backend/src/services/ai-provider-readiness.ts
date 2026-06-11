export const MULTITABLE_AI_ENABLED_ENV = 'MULTITABLE_AI_ENABLED'
export const MULTITABLE_AI_PROVIDER_ENV = 'MULTITABLE_AI_PROVIDER'
export const MULTITABLE_AI_API_KEY_ENV = 'MULTITABLE_AI_API_KEY'
export const MULTITABLE_AI_BASE_URL_ENV = 'MULTITABLE_AI_BASE_URL'
export const MULTITABLE_AI_MODEL_ENV = 'MULTITABLE_AI_MODEL'
export const MULTITABLE_AI_REQUEST_TIMEOUT_MS_ENV = 'MULTITABLE_AI_REQUEST_TIMEOUT_MS'
export const MULTITABLE_AI_MAX_OUTPUT_TOKENS_ENV = 'MULTITABLE_AI_MAX_OUTPUT_TOKENS'
export const MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP_ENV = 'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP'
export const MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP_ENV = 'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP'
export const MULTITABLE_AI_TENANT_BURST_RPM_ENV = 'MULTITABLE_AI_TENANT_BURST_RPM'
export const MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP_ENV = 'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP'
export const MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV = 'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS'

export const AI_REQUIRED_ENV = [
  MULTITABLE_AI_ENABLED_ENV,
  MULTITABLE_AI_PROVIDER_ENV,
  MULTITABLE_AI_API_KEY_ENV,
  MULTITABLE_AI_MODEL_ENV,
] as const

export const AI_OPTIONAL_ENV = [
  MULTITABLE_AI_BASE_URL_ENV,
  MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV,
] as const

export type AiProvider = 'anthropic' | 'openai'

export type AiProviderReadinessStatus =
  | 'disabled'
  | 'blocked'
  | 'ready'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_error'
  | 'unsafe_input'

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

export type AiProviderEnv = Record<string, string | undefined>

export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
}

export const AI_ALLOWED_MODELS: Record<AiProvider, readonly string[]> = {
  anthropic: [
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-sonnet-4-20250514',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
  ],
}

const DEFAULT_CAPS: AiProviderCaps = Object.freeze({
  requestTimeoutMs: 15_000,
  maxOutputTokens: 1_024,
  tenantDailyTokenCap: 100_000,
  tenantWeeklyTokenCap: 500_000,
  tenantBurstRpm: 30,
  accountDailyUsdCap: 10,
})

function envString(env: AiProviderEnv, name: string): string {
  const value = env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function isEnabled(value: string): boolean {
  return value === '1'
}

function resolveProvider(value: string): AiProvider | undefined {
  if (value === 'anthropic' || value === 'openai') return value
  return undefined
}

function parseIntegerEnv(
  env: AiProviderEnv,
  name: string,
  fallback: number,
  messages: string[],
  options: { min?: number; max?: number } = {},
): number {
  const raw = envString(env, name)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    messages.push(`${name} is invalid; using default ${fallback}.`)
    return fallback
  }
  if (typeof options.min === 'number' && parsed < options.min) {
    messages.push(`${name} is below minimum; clamped to ${options.min}.`)
    return options.min
  }
  if (typeof options.max === 'number' && parsed > options.max) {
    messages.push(`${name} is above maximum; clamped to ${options.max}.`)
    return options.max
  }
  return parsed
}

function resolveCaps(env: AiProviderEnv, messages: string[]): AiProviderCaps {
  return {
    requestTimeoutMs: parseIntegerEnv(env, MULTITABLE_AI_REQUEST_TIMEOUT_MS_ENV, DEFAULT_CAPS.requestTimeoutMs, messages, {
      min: 1_000,
      max: 60_000,
    }),
    maxOutputTokens: parseIntegerEnv(env, MULTITABLE_AI_MAX_OUTPUT_TOKENS_ENV, DEFAULT_CAPS.maxOutputTokens, messages, {
      min: 64,
      max: 4_096,
    }),
    tenantDailyTokenCap: parseIntegerEnv(env, MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP_ENV, DEFAULT_CAPS.tenantDailyTokenCap, messages, {
      min: 1_000,
    }),
    tenantWeeklyTokenCap: parseIntegerEnv(env, MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP_ENV, DEFAULT_CAPS.tenantWeeklyTokenCap, messages),
    tenantBurstRpm: parseIntegerEnv(env, MULTITABLE_AI_TENANT_BURST_RPM_ENV, DEFAULT_CAPS.tenantBurstRpm, messages),
    accountDailyUsdCap: parseIntegerEnv(env, MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP_ENV, DEFAULT_CAPS.accountDailyUsdCap, messages),
  }
}

function isValidBaseUrl(value: string): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function resolveModel(provider: AiProvider, explicitModel: string, messages: string[]): string | undefined {
  const model = explicitModel || AI_DEFAULT_MODELS[provider]
  if (AI_ALLOWED_MODELS[provider].includes(model)) return model
  messages.push(`${MULTITABLE_AI_MODEL_ENV} is <invalid> for provider ${provider}.`)
  return undefined
}

export function resolveAiProviderReadiness(
  env: AiProviderEnv = process.env,
): AiProviderReadinessReport {
  const messages: string[] = []
  const caps = resolveCaps(env, messages)
  const enabled = isEnabled(envString(env, MULTITABLE_AI_ENABLED_ENV))

  if (!enabled) {
    messages.push('AI provider is disabled; set MULTITABLE_AI_ENABLED=1 to evaluate provider readiness.')
    return {
      ok: false,
      status: 'disabled',
      caps,
      messages,
      requiredEnv: [...AI_REQUIRED_ENV],
      optionalEnv: [...AI_OPTIONAL_ENV],
    }
  }

  const providerRaw = envString(env, MULTITABLE_AI_PROVIDER_ENV)
  const provider = resolveProvider(providerRaw)
  if (!provider) {
    messages.push(`${MULTITABLE_AI_PROVIDER_ENV} is <invalid>; allowed values are anthropic or openai.`)
  }

  const apiKey = envString(env, MULTITABLE_AI_API_KEY_ENV)
  if (!apiKey) {
    messages.push(`${MULTITABLE_AI_API_KEY_ENV} is required when AI is enabled.`)
  }

  const baseUrl = envString(env, MULTITABLE_AI_BASE_URL_ENV)
  if (!isValidBaseUrl(baseUrl)) {
    messages.push(`${MULTITABLE_AI_BASE_URL_ENV} is <invalid>.`)
  }

  const model = provider
    ? resolveModel(provider, envString(env, MULTITABLE_AI_MODEL_ENV), messages)
    : undefined

  if (envString(env, MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV)) {
    messages.push(`${MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV} is informational in A1; live provider calls remain disabled.`)
  }

  const blocked = !provider || !apiKey || !model || !isValidBaseUrl(baseUrl)

  if (!blocked) {
    messages.push('AI provider env is present; declarative readiness only, no live provider request was sent.')
  }

  return {
    ok: !blocked,
    status: blocked ? 'blocked' : 'ready',
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    caps,
    messages,
    requiredEnv: [...AI_REQUIRED_ENV],
    optionalEnv: [...AI_OPTIONAL_ENV],
  }
}

export function renderAiProviderReadinessMarkdown(report: AiProviderReadinessReport): string {
  const lines = [
    '# Multitable AI Provider Readiness',
    '',
    `- Status: \`${report.status}\``,
    `- Provider: \`${report.provider ?? '<unset>'}\``,
    `- Model: \`${report.model ?? '<unset>'}\``,
    '',
    '## Messages',
    '',
    ...report.messages.map((message) => `- ${message}`),
    '',
    '## Caps',
    '',
    '| Name | Value |',
    '| --- | ---: |',
    `| requestTimeoutMs | ${report.caps.requestTimeoutMs} |`,
    `| maxOutputTokens | ${report.caps.maxOutputTokens} |`,
    `| tenantDailyTokenCap | ${report.caps.tenantDailyTokenCap} |`,
    `| tenantWeeklyTokenCap | ${report.caps.tenantWeeklyTokenCap} |`,
    `| tenantBurstRpm | ${report.caps.tenantBurstRpm} |`,
    `| accountDailyUsdCap | ${report.caps.accountDailyUsdCap} |`,
    '',
    '## Environment Contract',
    '',
    `- Required env: ${report.requiredEnv.map((name) => `\`${name}\``).join(', ')}`,
    `- Optional env: ${report.optionalEnv.map((name) => `\`${name}\``).join(', ')}`,
    '',
    '## Notes',
    '',
    '- This gate validates declarative provider configuration only; it never calls an AI provider.',
    '- API keys, custom endpoint credentials, auth tokens, and raw secret-shaped values are not rendered in this report.',
  ]

  return `${lines.join('\n')}\n`
}
