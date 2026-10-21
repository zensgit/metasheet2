/**
 * A1 provider readiness resolver — unit tests (A1-T1..T6 of the §3 matrix in
 * docs/development/multitable-ai-provider-readiness-a1-design-20260610.md).
 *
 * Pure env-contract tests: no DB, no HTTP, no real provider call anywhere.
 * Leak policy under test: invalid E-2/E-5/E-4 values echo only `<invalid>`;
 * E-3 is presence-only; no env VALUE ever appears in the serialized report.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import {
  AI_ACCOUNT_DAILY_USD_CAP_ENV,
  AI_API_KEY_ENV,
  AI_BASE_URL_ENV,
  AI_CONFIRM_LIVE_REQUESTS_ENV,
  AI_DEFAULT_MODELS,
  AI_ENABLED_ENV,
  AI_LOCAL_PROVIDER,
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
import { AI_ROUTING_POLICY_PATH_ENV } from '../../src/services/ai-routing-policy'

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

/**
 * LOCAL LANE (local-openai-compat) — the readiness contract can finally EXPRESS
 * the deployment the #5419 boundary header promises (self-hosted vLLM/Ollama):
 *   - MULTITABLE_AI_BASE_URL becomes REQUIRED and its host must pass the routing
 *     policy's OWN positive local proof (isProvablyLocalHost — one source of
 *     truth, no readiness-side approximation);
 *   - MULTITABLE_AI_API_KEY becomes OPTIONAL (many local servers are keyless);
 *   - MULTITABLE_AI_MODEL is operator-named (no cloud allowlist) but must be
 *     non-empty and not secret-shaped (it rides into the report).
 * Cloud posture is UNCHANGED — witnessed below by the cloud-regression cases.
 */
describe('local provider readiness (local-openai-compat)', () => {
  const policyScratch = mkdtempSync(join(tmpdir(), 'ai-readiness-policy-'))
  afterAll(() => rmSync(policyScratch, { recursive: true, force: true }))
  let policyCounter = 0
  function policyFile(json: unknown): string {
    const path = join(policyScratch, `policy-${policyCounter++}.json`)
    writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json), 'utf8')
    return path
  }

  const LOCAL_BASE = {
    [AI_ENABLED_ENV]: '1',
    [AI_PROVIDER_ENV]: AI_LOCAL_PROVIDER,
  }

  it('RED (a): provably-local base URL + NO api key + operator-named model → ready', () => {
    for (const [url, model] of [
      ['http://127.0.0.1:11434', 'qwen2.5:14b-instruct'], // ollama loopback
      ['http://vllm.internal:8000', 'Qwen/Qwen2.5-72B-Instruct'], // .internal suffix
      ['http://10.20.30.40:8000/v1-compat', 'deepseek-r1:32b'], // RFC1918
      ['http://localhost:8000', 'llama3.1:70b-instruct-q4_K_M'],
    ] as const) {
      const report = resolveAiProviderReadiness({
        ...LOCAL_BASE,
        [AI_BASE_URL_ENV]: url,
        [AI_MODEL_ENV]: model,
      })
      expect(report.status, `${url} ${model}`).toBe('ready')
      expect(report.ok).toBe(true)
      expect(report.provider).toBe(AI_LOCAL_PROVIDER)
      expect(report.model).toBe(model)
    }
  })

  it('RED (a2): the api key is OPTIONAL, not forbidden — setting one stays ready', () => {
    const report = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
      [AI_API_KEY_ENV]: 'local-server-token',
    })
    expect(report.status).toBe('ready')
  })

  it('RED (b): a PUBLIC host is blocked with the locality reason — aliasing a cloud endpoint as local is unexpressible', () => {
    for (const url of [
      'https://api.example.com/v1',
      'https://api.deepseek.com',
      'https://dashscope.aliyuncs.com',
      'http://8.8.8.8:8000', // public IP literal
    ]) {
      const report = resolveAiProviderReadiness({
        ...LOCAL_BASE,
        [AI_BASE_URL_ENV]: url,
        [AI_MODEL_ENV]: 'qwen2.5:14b',
      })
      expect(report.status, url).toBe('blocked')
      const joined = report.messages.join('\n')
      expect(joined).toContain('provably local')
      expect(joined).toContain(AI_LOCAL_PROVIDER)
      // Values-free: the host/URL is deployment topology and is never echoed.
      expect(JSON.stringify(report)).not.toContain('api.example.com')
      expect(JSON.stringify(report)).not.toContain('deepseek')
      expect(JSON.stringify(report)).not.toContain('8.8.8.8')
    }
  })

  it('REFUTATION: qwen.internal.corp LOOKS internal but is NOT per the suffix rules (.internal.corp ≠ .internal) → blocked', () => {
    // Mirrors the real mistake the positive-proof correction caught: "internal"
    // appearing INSIDE a public DNS name proves nothing — only the exact
    // definitionally-private suffixes (or the policy's localHosts) count.
    const report = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_BASE_URL_ENV]: 'https://qwen.internal.corp:8443',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain('provably local')
    expect(JSON.stringify(report)).not.toContain('qwen.internal.corp')
  })

  it('RED (c): missing base URL → blocked naming the env (the local lane has no default endpoint)', () => {
    const report = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain(AI_BASE_URL_ENV)
  })

  it('RED (c2): missing / blank model → blocked (free-form does NOT mean optional; no local default exists)', () => {
    for (const env of [
      { ...LOCAL_BASE, [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434' },
      { ...LOCAL_BASE, [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434', [AI_MODEL_ENV]: '   ' },
    ]) {
      const report = resolveAiProviderReadiness(env)
      expect(report.status).toBe('blocked')
      expect(report.messages.join('\n')).toContain(AI_MODEL_ENV)
      expect(report.model).toBeUndefined()
    }
  })

  it('a secret-shaped or malformed local model value is blocked and never echoed (it would ride into the report)', () => {
    const skShaped = `sk-${'localleak'.repeat(3)}`
    for (const bad of [skShaped, 'has spaces in it', 'user:p@ss-model', 'x'.repeat(201)]) {
      const report = resolveAiProviderReadiness({
        ...LOCAL_BASE,
        [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434',
        [AI_MODEL_ENV]: bad,
      })
      expect(report.status, bad.slice(0, 24)).toBe('blocked')
      expect(JSON.stringify(report)).not.toContain(skShaped)
      expect(report.messages.join('\n')).toContain(`${AI_MODEL_ENV}=<invalid>`)
    }
  })

  it('the routing policy localHosts escape hatch works at readiness too (one locality truth, both layers agree)', () => {
    const path = policyFile({
      policyId: 'onprem',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
      localHosts: ['llm.corp.example.com'],
    })
    const ready = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_ROUTING_POLICY_PATH_ENV]: path,
      [AI_BASE_URL_ENV]: 'https://llm.corp.example.com/v1',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(ready.status).toBe('ready')
    // A DIFFERENT public host is still blocked — the allowlist is exact-match.
    const blocked = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_ROUTING_POLICY_PATH_ENV]: path,
      [AI_BASE_URL_ENV]: 'https://api.deepseek.com/v1',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(blocked.status).toBe('blocked')
  })

  it('a BROKEN routing-policy file fails CLOSED at readiness (never silently degrades to empty localHosts)', () => {
    const report = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_ROUTING_POLICY_PATH_ENV]: join(policyScratch, 'does-not-exist.json'),
      [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain(AI_ROUTING_POLICY_PATH_ENV)
  })

  it('the local report states ITS env contract: BASE_URL required, API_KEY optional', () => {
    const report = resolveAiProviderReadiness({
      ...LOCAL_BASE,
      [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(report.requiredEnv).toContain(AI_BASE_URL_ENV)
    expect(report.requiredEnv).not.toContain(AI_API_KEY_ENV)
    expect(report.optionalEnv).toContain(AI_API_KEY_ENV)
  })

  it('RED (d): CLOUD posture unchanged — key still required, unlisted model still blocked, no locality demand', () => {
    // openai without a key: still blocked on key presence.
    const keyless = resolveAiProviderReadiness({
      [AI_ENABLED_ENV]: '1',
      [AI_PROVIDER_ENV]: 'openai',
      [AI_MODEL_ENV]: 'gpt-4o-mini',
    })
    expect(keyless.status).toBe('blocked')
    expect(keyless.messages.join('\n')).toContain(AI_API_KEY_ENV)
    // openai with a free-form (local-style) model: still blocked by the allowlist.
    const freeform = resolveAiProviderReadiness({
      [AI_ENABLED_ENV]: '1',
      [AI_PROVIDER_ENV]: 'openai',
      [AI_API_KEY_ENV]: 'test-key-placeholder',
      [AI_MODEL_ENV]: 'qwen2.5:14b',
    })
    expect(freeform.status).toBe('blocked')
    expect(freeform.messages.join('\n')).toContain(`${AI_MODEL_ENV}=<invalid>`)
    // and the ready cloud shape from READY_ENV still resolves ready (pinned above in A1-T4).
    expect(resolveAiProviderReadiness(READY_ENV).status).toBe('ready')
  })
})
