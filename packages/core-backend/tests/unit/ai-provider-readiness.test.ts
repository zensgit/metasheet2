import { describe, expect, it } from 'vitest'
import {
  AI_REQUIRED_ENV,
  MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP_ENV,
  MULTITABLE_AI_API_KEY_ENV,
  MULTITABLE_AI_BASE_URL_ENV,
  MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV,
  MULTITABLE_AI_ENABLED_ENV,
  MULTITABLE_AI_MAX_OUTPUT_TOKENS_ENV,
  MULTITABLE_AI_MODEL_ENV,
  MULTITABLE_AI_PROVIDER_ENV,
  MULTITABLE_AI_REQUEST_TIMEOUT_MS_ENV,
  MULTITABLE_AI_TENANT_BURST_RPM_ENV,
  MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP_ENV,
  MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP_ENV,
  renderAiProviderReadinessMarkdown,
  resolveAiProviderReadiness,
} from '../../src/services/ai-provider-readiness'

const READY_ENV = {
  [MULTITABLE_AI_ENABLED_ENV]: '1',
  [MULTITABLE_AI_PROVIDER_ENV]: 'openai',
  [MULTITABLE_AI_API_KEY_ENV]: 'sk-test-secret-00000000000000000000',
  [MULTITABLE_AI_MODEL_ENV]: 'gpt-4o-mini',
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('AI provider readiness', () => {
  it('keeps AI disabled by default and declares the env contract', () => {
    const report = resolveAiProviderReadiness({})

    expect(report.ok).toBe(false)
    expect(report.status).toBe('disabled')
    expect(report.requiredEnv).toEqual([...AI_REQUIRED_ENV])
    expect(report.optionalEnv).toEqual([
      MULTITABLE_AI_BASE_URL_ENV,
      MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV,
    ])
    expect(report.messages.join('\n')).toContain('disabled')
  })

  it('blocks non-allowlisted providers without echoing the raw value', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_PROVIDER_ENV]: 'azure-openai',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.provider).toBeUndefined()
    expect(report.messages.join('\n')).toContain('<invalid>')
    expect(serialized(report)).not.toContain('azure-openai')
  })

  it('blocks non-allowlisted models without echoing the raw model value', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_MODEL_ENV]: 'sk-model-shaped-secret-0000000000',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.model).toBeUndefined()
    expect(report.messages.join('\n')).toContain('<invalid>')
    expect(serialized(report)).not.toContain('sk-model-shaped-secret')
  })

  it('blocks invalid base URLs without leaking embedded credentials', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_BASE_URL_ENV]: 'https://user:secret-pass@example.com:bad',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain('<invalid>')
    expect(serialized(report)).not.toContain('secret-pass')
    expect(serialized(report)).not.toContain('user:secret-pass')
  })

  it('blocks enabled providers when API key is missing', () => {
    const report = resolveAiProviderReadiness({
      [MULTITABLE_AI_ENABLED_ENV]: '1',
      [MULTITABLE_AI_PROVIDER_ENV]: 'anthropic',
      [MULTITABLE_AI_MODEL_ENV]: 'claude-3-5-sonnet-latest',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.provider).toBe('anthropic')
    expect(report.messages.join('\n')).toContain(MULTITABLE_AI_API_KEY_ENV)
  })

  it('passes ready configuration without sending a live provider request', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_REQUEST_TIMEOUT_MS_ENV]: '25000',
      [MULTITABLE_AI_MAX_OUTPUT_TOKENS_ENV]: '2048',
      [MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP_ENV]: '200000',
      [MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP_ENV]: '700000',
      [MULTITABLE_AI_TENANT_BURST_RPM_ENV]: '15',
      [MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP_ENV]: '4',
    })

    expect(report.ok).toBe(true)
    expect(report.status).toBe('ready')
    expect(report.provider).toBe('openai')
    expect(report.model).toBe('gpt-4o-mini')
    expect(report.caps).toEqual({
      requestTimeoutMs: 25000,
      maxOutputTokens: 2048,
      tenantDailyTokenCap: 200000,
      tenantWeeklyTokenCap: 700000,
      tenantBurstRpm: 15,
      accountDailyUsdCap: 4,
    })
    expect(report.messages.join('\n')).toContain('declarative readiness only')
  })

  it('does not consume the live-request confirmation flag in A1', () => {
    const base = resolveAiProviderReadiness({})
    const withConfirm = resolveAiProviderReadiness({
      [MULTITABLE_AI_CONFIRM_LIVE_REQUESTS_ENV]: '1',
    })

    expect(withConfirm).toEqual(base)
  })

  it('clamps bounded caps and defaults unbounded invalid caps without blocking readiness', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_REQUEST_TIMEOUT_MS_ENV]: '999999',
      [MULTITABLE_AI_MAX_OUTPUT_TOKENS_ENV]: '8',
      [MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP_ENV]: '1',
      [MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP_ENV]: 'not-a-number',
      [MULTITABLE_AI_TENANT_BURST_RPM_ENV]: 'nope',
      [MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP_ENV]: 'NaN',
    })

    expect(report.ok).toBe(true)
    expect(report.status).toBe('ready')
    expect(report.caps).toEqual({
      requestTimeoutMs: 60000,
      maxOutputTokens: 64,
      tenantDailyTokenCap: 1000,
      tenantWeeklyTokenCap: 500000,
      tenantBurstRpm: 30,
      accountDailyUsdCap: 10,
    })
    expect(report.messages.join('\n')).toContain('clamped')
    expect(report.messages.join('\n')).toContain('using default')
  })

  it('does not leak secret-shaped env values in JSON or Markdown reports', () => {
    const skSecret = 'sk-live-secret-abcdefghijklmnopqrstuvwxyz'
    const baseUrlSecret = 'base-url-password'
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [MULTITABLE_AI_API_KEY_ENV]: skSecret,
      [MULTITABLE_AI_BASE_URL_ENV]: `https://user:${baseUrlSecret}@gateway.example.com`,
    })
    const combined = `${JSON.stringify(report)}\n${renderAiProviderReadinessMarkdown(report)}`

    expect(combined).not.toContain(skSecret)
    expect(combined).not.toContain(baseUrlSecret)
    expect(combined).not.toContain('user:base-url-password')
  })
})
