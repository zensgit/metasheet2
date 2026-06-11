/**
 * A1 provider readiness resolver — unit tests (A1-T1..T6 of the §3 matrix in
 * docs/development/multitable-ai-provider-readiness-a1-design-20260610.md).
 *
 * Pure env-contract tests: no DB, no HTTP, no real provider call anywhere.
 * Leak policy under test: invalid E-2/E-5/E-4 values echo only `<invalid>`;
 * E-3 is presence-only; no env VALUE ever appears in the serialized report.
 */
import { describe, expect, it } from 'vitest'
import {
  AI_ACCOUNT_DAILY_USD_CAP_ENV,
  AI_API_KEY_ENV,
  AI_BASE_URL_ENV,
  AI_CONFIRM_LIVE_REQUESTS_ENV,
  AI_DEFAULT_MODELS,
  AI_ENABLED_ENV,
  AI_MAX_OUTPUT_TOKENS_ENV,
  AI_MODEL_ENV,
  AI_PROVIDER_ENV,
  AI_REQUEST_TIMEOUT_MS_ENV,
  AI_REQUIRED_ENV,
  AI_TENANT_BURST_RPM_ENV,
  AI_TENANT_DAILY_TOKEN_CAP_ENV,
  AI_TENANT_WEEKLY_TOKEN_CAP_ENV,
  AI_EMITTED_STATUSES,
  AI_RESERVED_STATUSES,
  renderAiProviderReadinessMarkdown,
  resolveAiProviderReadiness,
  type AiProviderReadinessStatus,
} from '../../src/services/ai-provider-readiness'

const READY_ENV = {
  [AI_ENABLED_ENV]: '1',
  [AI_PROVIDER_ENV]: 'anthropic',
  [AI_API_KEY_ENV]: 'test-key-placeholder',
  [AI_MODEL_ENV]: 'claude-sonnet-4-6',
}

// A1-T6 sentinels: one sk-shaped, one non-sk-shaped (URL-embedded password).
const SK_SENTINEL = `sk-${'leak4567'.repeat(4)}`
const URL_PASSWORD_SENTINEL = 'Sup3rS3cretPw'
const URL_USER_SENTINEL = 'leakuser'

describe('resolveAiProviderReadiness (A1)', () => {
  it('A1-T1: all-default env resolves to disabled with the E-1/E-2/E-3/E-5 required contract', () => {
    const report = resolveAiProviderReadiness({})

    expect(report.status).toBe('disabled')
    expect(report.ok).toBe(false)
    expect(report.requiredEnv).toEqual([
      AI_ENABLED_ENV,
      AI_PROVIDER_ENV,
      AI_API_KEY_ENV,
      AI_MODEL_ENV,
    ])
    expect(report.requiredEnv).toEqual([...AI_REQUIRED_ENV])
    // E-4 BASE_URL is optional, not required; E-12 is declared informationally.
    expect(report.optionalEnv).toContain(AI_BASE_URL_ENV)
    expect(report.optionalEnv).toContain(AI_CONFIRM_LIVE_REQUESTS_ENV)
    expect(report.requiredEnv).not.toContain(AI_BASE_URL_ENV)
    // Declared caps fall back to the #1571-approved defaults even while disabled.
    expect(report.caps).toEqual({
      requestTimeoutMs: 15000,
      maxOutputTokens: 1024,
      tenantDailyTokenCap: 100000,
      tenantWeeklyTokenCap: 500000,
      tenantBurstRpm: 30,
      accountDailyUsdCap: 10,
    })
  })

  it('A1-T2: enabled with provider=azure-openai blocks and never echoes the raw value', () => {
    const report = resolveAiProviderReadiness({
      [AI_ENABLED_ENV]: '1',
      [AI_PROVIDER_ENV]: 'azure-openai',
      [AI_API_KEY_ENV]: 'test-key-placeholder',
    })

    expect(report.status).toBe('blocked')
    expect(report.ok).toBe(false)
    expect(report.provider).toBeUndefined()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('azure-openai')
    expect(report.messages.join('\n')).toContain(`${AI_PROVIDER_ENV}=<invalid>`)
  })

  it('A1-T2b: explicit model outside the per-provider allowlist blocks with <invalid> only', () => {
    const bogusModel = 'maybe-a-pasted-secret-value'
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [AI_MODEL_ENV]: bogusModel,
    })

    expect(report.status).toBe('blocked')
    expect(report.model).toBeUndefined()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(bogusModel)
    expect(report.messages.join('\n')).toContain(`${AI_MODEL_ENV}=<invalid>`)
  })

  it('A1-T2c: syntactically invalid BASE_URL with embedded credentials blocks without leaking them', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      // Space in host → URL() throws; embedded user:password must never surface.
      [AI_BASE_URL_ENV]: `http://${URL_USER_SENTINEL}:${URL_PASSWORD_SENTINEL}@bad host/v1`,
    })

    expect(report.status).toBe('blocked')
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(URL_PASSWORD_SENTINEL)
    expect(serialized).not.toContain(URL_USER_SENTINEL)
    expect(report.messages.join('\n')).toContain(`${AI_BASE_URL_ENV}=<invalid>`)
  })

  it('A1-T2c: non-http(s) scheme also fails BASE_URL syntax validation', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [AI_BASE_URL_ENV]: 'ftp://proxy.example.com/v1',
    })

    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain(`${AI_BASE_URL_ENV}=<invalid>`)
  })

  it('A1-T3: enabled + valid provider + missing key blocks on presence only', () => {
    const report = resolveAiProviderReadiness({
      [AI_ENABLED_ENV]: '1',
      [AI_PROVIDER_ENV]: 'anthropic',
    })

    expect(report.status).toBe('blocked')
    expect(report.ok).toBe(false)
    expect(report.provider).toBe('anthropic')
    expect(report.messages.join('\n')).toContain(AI_API_KEY_ENV)
    // Nothing secret-shaped may appear anywhere in the report.
    expect(JSON.stringify(report)).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/)
  })

  it('A1-T4: fully valid config resolves ready with parsed caps and the declarative-only caveat', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [AI_REQUEST_TIMEOUT_MS_ENV]: '30000',
      [AI_MAX_OUTPUT_TOKENS_ENV]: '2048',
      [AI_TENANT_DAILY_TOKEN_CAP_ENV]: '50000',
      [AI_TENANT_WEEKLY_TOKEN_CAP_ENV]: '900000',
      [AI_TENANT_BURST_RPM_ENV]: '10',
      [AI_ACCOUNT_DAILY_USD_CAP_ENV]: '25',
    })

    expect(report.status).toBe('ready')
    expect(report.ok).toBe(true)
    expect(report.provider).toBe('anthropic')
    expect(report.model).toBe('claude-sonnet-4-6')
    expect(report.caps).toEqual({
      requestTimeoutMs: 30000,
      maxOutputTokens: 2048,
      tenantDailyTokenCap: 50000,
      tenantWeeklyTokenCap: 900000,
      tenantBurstRpm: 10,
      accountDailyUsdCap: 25,
    })
    expect(report.messages.join('\n')).toContain('declarative readiness only')
  })

  it('falls back to the per-provider default model when E-5 is unset', () => {
    const env: Record<string, string> = { ...READY_ENV }
    delete env[AI_MODEL_ENV]
    const report = resolveAiProviderReadiness(env)

    expect(report.status).toBe('ready')
    expect(report.model).toBe(AI_DEFAULT_MODELS.anthropic)
  })

  it('A1-T4b: setting only E-12=1 produces a report identical to the all-default report', () => {
    const baseline = resolveAiProviderReadiness({})
    const withConfirm = resolveAiProviderReadiness({
      [AI_CONFIRM_LIVE_REQUESTS_ENV]: '1',
    })

    expect(withConfirm).toEqual(baseline)
  })

  it('A1-T5: E-6/E-7/E-8 clamp to approved bounds; E-9..E-11 fall back to approved defaults; never blocks', () => {
    const report = resolveAiProviderReadiness({
      ...READY_ENV,
      [AI_REQUEST_TIMEOUT_MS_ENV]: '999999', // > max 60000 → clamp
      [AI_MAX_OUTPUT_TOKENS_ENV]: '8', // < min 64 → clamp
      [AI_TENANT_DAILY_TOKEN_CAP_ENV]: '5', // < approved min 1000 → clamp
      [AI_TENANT_WEEKLY_TOKEN_CAP_ENV]: 'not-a-number', // no approved bounds → default
      [AI_TENANT_BURST_RPM_ENV]: '-3', // not a positive integer → default
      [AI_ACCOUNT_DAILY_USD_CAP_ENV]: 'abc', // → default
    })

    expect(report.status).toBe('ready')
    expect(report.ok).toBe(true)
    expect(report.caps).toEqual({
      requestTimeoutMs: 60000,
      maxOutputTokens: 64,
      tenantDailyTokenCap: 1000,
      tenantWeeklyTokenCap: 500000,
      tenantBurstRpm: 30,
      accountDailyUsdCap: 10,
    })
    const joined = report.messages.join('\n')
    for (const name of [
      AI_REQUEST_TIMEOUT_MS_ENV,
      AI_MAX_OUTPUT_TOKENS_ENV,
      AI_TENANT_DAILY_TOKEN_CAP_ENV,
      AI_TENANT_WEEKLY_TOKEN_CAP_ENV,
      AI_TENANT_BURST_RPM_ENV,
      AI_ACCOUNT_DAILY_USD_CAP_ENV,
    ]) {
      expect(joined).toContain(name)
    }
    // Non-numeric raw values may be pasted secrets — only <invalid> is echoed.
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('not-a-number')
    expect(serialized).not.toContain('abc')
  })

  it('A1-T6: leak sentinels (sk-shaped key + URL-embedded password) never appear in report JSON or markdown', () => {
    const env = {
      ...READY_ENV,
      [AI_API_KEY_ENV]: SK_SENTINEL,
      // Syntactically valid URL with embedded credentials → stays ready, must not leak.
      [AI_BASE_URL_ENV]: `https://${URL_USER_SENTINEL}:${URL_PASSWORD_SENTINEL}@proxy.example.com/v1`,
    }
    const report = resolveAiProviderReadiness(env)

    expect(report.status).toBe('ready')
    const serialized = JSON.stringify(report)
    const markdown = renderAiProviderReadinessMarkdown(report)
    for (const surface of [serialized, markdown]) {
      expect(surface).not.toContain(SK_SENTINEL)
      expect(surface).not.toContain(URL_PASSWORD_SENTINEL)
      expect(surface).not.toContain(URL_USER_SENTINEL)
    }
  })

  it('declares the full T6 status enum while A1 only ever emits disabled/blocked/ready', () => {
    // The exported constants ARE the locked contract surface (A2 derives the four
    // reserved states from AI_RESERVED_STATUSES; the union type gives the compile check).
    const reserved: readonly AiProviderReadinessStatus[] = AI_RESERVED_STATUSES
    expect(reserved).toEqual(['rate_limited', 'quota_exhausted', 'provider_error', 'unsafe_input'])
    expect(AI_EMITTED_STATUSES).toEqual(['disabled', 'blocked', 'ready'])

    for (const env of [
      {},
      { [AI_ENABLED_ENV]: '1' },
      READY_ENV,
    ]) {
      const report = resolveAiProviderReadiness(env)
      expect(AI_EMITTED_STATUSES).toContain(report.status)
    }
  })
})
