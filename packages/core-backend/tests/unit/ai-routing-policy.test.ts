/**
 * Governed AI boundary — DATA-CLASS ROUTING POLICY (the security core).
 *
 * Witnessed RED, all values-free:
 *  - business data NEVER reaches a cloud provider (mutate the first-branch refusal → red);
 *  - a deploy-file listing `business` among cloud classes is refused AT LOAD (poison config);
 *  - default-unset = local-only / most-restrictive (a `local` claim with no/known-cloud base URL
 *    downgrades to cloud, fail-closed);
 *  - a broken policy file THROWS (a typo must be distinguishable from "unset").
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  AI_BUILTIN_PROVIDER_TIERS,
  AI_DATA_CLASSES,
  AI_ROUTING_POLICY_PATH_ENV,
  AiRoutingPolicyError,
  authorizeAiRoute,
  decideAiRoute,
  isProvablyLocalHost,
  loadAiRoutingPolicyFile,
  normalizeAiRoutingPolicy,
  normalizeDataClass,
  resolveActiveProviderTier,
  type AiDataClass,
} from '../../src/services/ai-routing-policy'
import {
  AI_BASE_URL_ENV,
  AI_CLOUD_PROVIDER_ALLOWLIST,
  AI_LOCAL_PROVIDER,
  AI_PROVIDER_ALLOWLIST,
} from '../../src/services/ai-provider-readiness'

const scratch = mkdtempSync(join(tmpdir(), 'ai-routing-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function policyFile(json: unknown): string {
  const path = join(scratch, `policy-${counter++}.json`)
  writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json), 'utf8')
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
describe('decideAiRoute — the pure security core (business NEVER to cloud)', () => {
  it('a LOCAL provider serves ANY class', () => {
    expect(decideAiRoute('business', 'local', [])).toEqual({ allowed: true, tier: 'local' })
    expect(decideAiRoute('non-sensitive', 'local', [])).toEqual({ allowed: true, tier: 'local' })
    // even with nothing cloud-permitted, local serves.
    expect(decideAiRoute('business', 'local', ['non-sensitive'])).toEqual({ allowed: true, tier: 'local' })
  })

  it('BUSINESS + CLOUD is REFUSED — the witnessed RED', () => {
    const d = decideAiRoute('business', 'cloud', [])
    expect(d).toEqual({ allowed: false, reason: 'business_data_cloud_forbidden' })
  })

  it('POISON: business + cloud stays refused EVEN IF cloudDataClasses somehow lists business (defense in depth)', () => {
    // The loader refuses this config at load; but if the router were reached with it
    // directly, the first-branch business refusal must still win. Mutating the router
    // to consult the allowlist before the business guard turns THIS red.
    const d = decideAiRoute('business', 'cloud', ['business' as AiDataClass, 'non-sensitive'])
    expect(d).toEqual({ allowed: false, reason: 'business_data_cloud_forbidden' })
  })

  it('an UNKNOWN / malformed class normalizes to business → refused on cloud', () => {
    expect(decideAiRoute('totally-unknown', 'cloud', ['non-sensitive'])).toEqual({
      allowed: false,
      reason: 'business_data_cloud_forbidden',
    })
    expect(decideAiRoute('', 'cloud', ['non-sensitive'])).toEqual({
      allowed: false,
      reason: 'business_data_cloud_forbidden',
    })
  })

  it('non-sensitive + cloud is refused UNLESS explicitly permitted', () => {
    expect(decideAiRoute('non-sensitive', 'cloud', [])).toEqual({
      allowed: false,
      reason: 'class_not_cloud_authorized',
    })
    expect(decideAiRoute('non-sensitive', 'cloud', ['non-sensitive'])).toEqual({
      allowed: true,
      tier: 'cloud',
    })
  })

  it('EXHAUSTIVE: across every declared data class, business is the only cloud-forbidden one and no class is ever allowed business→cloud', () => {
    for (const cls of AI_DATA_CLASSES) {
      const local = decideAiRoute(cls, 'local', [])
      expect(local.allowed).toBe(true)
    }
    // business is refused on cloud regardless of the permitted set; non-sensitive
    // is the only class that CAN be permitted.
    expect(decideAiRoute('business', 'cloud', ['non-sensitive']).allowed).toBe(false)
    expect(decideAiRoute('non-sensitive', 'cloud', ['non-sensitive']).allowed).toBe(true)
  })
})

describe('normalizeDataClass — unknown is the most-restrictive class', () => {
  it('omitted / unknown → business; only the exact token is non-sensitive', () => {
    expect(normalizeDataClass(undefined)).toBe('business')
    expect(normalizeDataClass(null)).toBe('business')
    expect(normalizeDataClass('' as AiDataClass)).toBe('business')
    expect(normalizeDataClass('nonsense')).toBe('business')
    expect(normalizeDataClass('business')).toBe('business')
    expect(normalizeDataClass('non-sensitive')).toBe('non-sensitive')
  })
})

describe('resolveActiveProviderTier — declared tier + fail-closed URL downgrade', () => {
  // Minimal update for the local lane: the loop below used to iterate
  // AI_PROVIDER_ALLOWLIST, which now includes `local-openai-compat`. That
  // provider CLAIMS local by selection, so with no base URL it is a fail-closed
  // DOWNGRADE (cloud, downgraded:true), not a builtin resolution — covered by
  // its own cases further down. The builtin-tier property is a CLOUD-provider
  // property, so the loop now iterates the cloud allowlist; the builtin table
  // itself stays all-cloud (pinned for every provider, local lane included).
  it('no policy → the provider BUILT-IN tier (cloud for every CLOUD provider); the builtin table never grants local', () => {
    for (const provider of AI_PROVIDER_ALLOWLIST) {
      expect(AI_BUILTIN_PROVIDER_TIERS[provider], provider).toBe('cloud')
    }
    for (const provider of AI_CLOUD_PROVIDER_ALLOWLIST) {
      expect(resolveActiveProviderTier(provider, null, {})).toEqual({ tier: 'cloud', downgraded: false })
    }
  })

  it('RED (local lane): local-openai-compat + provably-local base URL → local, NO policy file needed', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://10.1.2.3:8000', 'https://vllm.internal:8000']) {
      expect(resolveActiveProviderTier(AI_LOCAL_PROVIDER, null, { [AI_BASE_URL_ENV]: url }), url).toEqual({
        tier: 'local',
        downgraded: false,
      })
    }
  })

  it('RED (local lane): local-openai-compat on a PUBLIC host (or with no URL) is DOWNGRADED to cloud — the name is a claim, not evidence', () => {
    for (const env of [
      {},
      { [AI_BASE_URL_ENV]: 'https://api.deepseek.com/v1' },
      { [AI_BASE_URL_ENV]: 'https://api.example.com' },
      { [AI_BASE_URL_ENV]: 'https://qwen.internal.corp:8443' }, // looks internal, is NOT (.internal.corp ≠ .internal)
    ]) {
      expect(resolveActiveProviderTier(AI_LOCAL_PROVIDER, null, env), JSON.stringify(env)).toEqual({
        tier: 'cloud',
        downgraded: true,
      })
    }
  })

  it('RED (local lane): authorizeAiRoute serves BUSINESS on a proven-local local-openai-compat and refuses it on a public one', () => {
    const ok = authorizeAiRoute(AI_LOCAL_PROVIDER, 'business', { [AI_BASE_URL_ENV]: 'http://127.0.0.1:11434' })
    expect(ok.allowed).toBe(true)
    if (ok.allowed) expect(ok.tier).toBe('local')
    const refused = authorizeAiRoute(AI_LOCAL_PROVIDER, 'business', { [AI_BASE_URL_ENV]: 'https://api.example.com' })
    expect(refused.allowed).toBe(false)
    if (!refused.allowed) expect(refused.reason).toBe('business_data_cloud_forbidden')
  })

  it('policy declares CLOUD → cloud', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'cloud' } })
    expect(resolveActiveProviderTier('openai', policy, {}).tier).toBe('cloud')
  })

  it('policy declares LOCAL + a PROVABLY PRIVATE base URL → local', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    for (const url of [
      'http://10.1.2.3:8000', // RFC1918
      'http://192.168.4.4:11434', // RFC1918 (ollama)
      'http://172.16.9.9', // RFC1918
      'http://127.0.0.1:8000', // loopback
      'http://localhost:8000',
      'http://[::1]:8000',
      'https://qwen.internal:8000', // private suffix
      'https://llm.corp.local', // private suffix
    ]) {
      expect(resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: url }), url).toEqual({
        tier: 'local',
        downgraded: false,
      })
    }
  })

  it('RED: policy declares LOCAL but base URL is UNSET → DOWNGRADED to cloud (default local-only, no leak)', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    expect(resolveActiveProviderTier('openai', policy, {})).toEqual({ tier: 'cloud', downgraded: true })
  })

  it('RED (the denylist hole): a LOCAL claim on ANY public host is cloud — not just the two once-denylisted names', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    for (const host of [
      'api.deepseek.com', // the PROVEN leak: passed the old two-entry denylist
      'api.openai.com',
      'api.anthropic.com',
      'api.moonshot.cn',
      'dashscope.aliyuncs.com',
      'open.bigmodel.cn',
      'generativelanguage.googleapis.com',
      'example.com',
      '8.8.8.8', // a PUBLIC ip literal is not local either
    ]) {
      expect(
        resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: `https://${host}/v1` }),
        host,
      ).toEqual({ tier: 'cloud', downgraded: true })
    }
  })

  it('the positive check is a POSITIVE test: an unrecognised host fails it', () => {
    expect(isProvablyLocalHost('api.deepseek.com')).toBe(false)
    expect(isProvablyLocalHost('some-new-ai-vendor.example')).toBe(false)
    expect(isProvablyLocalHost(null)).toBe(false)
    expect(isProvablyLocalHost('')).toBe(false)
    expect(isProvablyLocalHost('10.0.0.1')).toBe(true)
    expect(isProvablyLocalHost('vllm.internal')).toBe(true)
  })

  it('the on-prem allowlist is the ONLY way a public DNS name becomes local (and it is exact-match)', () => {
    const policy = normalizeAiRoutingPolicy({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
      localHosts: ['llm.corp.example.com'],
    })
    expect(
      resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: 'https://llm.corp.example.com/v1' }),
    ).toEqual({ tier: 'local', downgraded: false })
    // a DIFFERENT public host is still cloud — listing one host does not widen
    expect(
      resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: 'https://api.deepseek.com/v1' }),
    ).toEqual({ tier: 'cloud', downgraded: true })
  })

  it('localHosts refuses wildcards / schemes at load (no rebuilding the "anything is local" hole)', () => {
    for (const bad of ['*', '*.corp.example.com', 'https://llm.corp.example.com', 'a/b', 'u@h']) {
      expect(() =>
        normalizeAiRoutingPolicy({
          policyId: 'p',
          policyVersion: 1,
          activeProvider: { tier: 'local' },
          localHosts: [bad],
        }),
        bad,
      ).toThrow(AiRoutingPolicyError)
    }
  })
})

describe('normalizeAiRoutingPolicy — fail-closed validation (business is unexpressible)', () => {
  it('a minimal cloud policy normalizes', () => {
    const p = normalizeAiRoutingPolicy({ policyId: 'acme', policyVersion: 3, activeProvider: { tier: 'cloud' } })
    expect(p.policyId).toBe('acme')
    expect(p.policyVersion).toBe(3)
    expect(p.declaredProviderTier).toBe('cloud')
    expect(p.cloudDataClasses).toEqual([])
  })

  it('non-sensitive may be cloud-permitted', () => {
    const p = normalizeAiRoutingPolicy({
      policyId: 'a',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['non-sensitive'],
    })
    expect(p.cloudDataClasses).toEqual(['non-sensitive'])
  })

  it('POISON CONFIG: business in cloudDataClasses is REFUSED at load', () => {
    let caught: AiRoutingPolicyError | null = null
    try {
      normalizeAiRoutingPolicy({
        policyId: 'a',
        policyVersion: 1,
        activeProvider: { tier: 'cloud' },
        cloudDataClasses: ['business'],
      })
    } catch (e) {
      caught = e as AiRoutingPolicyError
    }
    expect(caught).toBeInstanceOf(AiRoutingPolicyError)
    expect(caught?.reason).toBe('business_cloud_forbidden')
    expect(caught?.code).toBe('AI_ROUTING_POLICY_INVALID')
  })

  it('rejects: not an object / bad version / bad tier / unknown class / unknown key / duplicate', () => {
    expect(() => normalizeAiRoutingPolicy([])).toThrow(AiRoutingPolicyError)
    expect(() => normalizeAiRoutingPolicy({ policyId: 'a', policyVersion: 0, activeProvider: { tier: 'cloud' } })).toThrow()
    expect(() => normalizeAiRoutingPolicy({ policyId: 'a', policyVersion: 1, activeProvider: { tier: 'edge' } })).toThrow()
    expect(() =>
      normalizeAiRoutingPolicy({ policyId: 'a', policyVersion: 1, activeProvider: { tier: 'cloud' }, cloudDataClasses: ['weird'] }),
    ).toThrow()
    expect(() =>
      normalizeAiRoutingPolicy({ policyId: 'a', policyVersion: 1, activeProvider: { tier: 'cloud' }, extra: true }),
    ).toThrow()
    expect(() =>
      normalizeAiRoutingPolicy({
        policyId: 'a',
        policyVersion: 1,
        activeProvider: { tier: 'cloud' },
        cloudDataClasses: ['non-sensitive', 'non-sensitive'],
      }),
    ).toThrow()
  })
})

describe('loadAiRoutingPolicyFile — three states (unset / usable / broken)', () => {
  it('env UNSET / blank → null (most-restrictive default, zero I/O)', () => {
    expect(loadAiRoutingPolicyFile({})).toBeNull()
    expect(loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: '   ' })).toBeNull()
  })

  it('env set + usable file → a normalized policy', () => {
    const path = policyFile({ policyId: 'ok', policyVersion: 1, activeProvider: { tier: 'local' } })
    const p = loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: path })
    expect(p?.policyId).toBe('ok')
    expect(p?.declaredProviderTier).toBe('local')
  })

  it('RED: a MISSING path THROWS (a typo must be distinguishable from "unset")', () => {
    const missing = join(scratch, 'does-not-exist.json')
    expect(existsSync(missing)).toBe(false)
    let caught: AiRoutingPolicyError | null = null
    try {
      loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: missing })
    } catch (e) {
      caught = e as AiRoutingPolicyError
    }
    expect(caught).toBeInstanceOf(AiRoutingPolicyError)
    expect(caught?.reason).toBe('unreadable')
    // Values-free: the path is never echoed.
    expect(caught?.message).not.toContain(missing)
    expect(caught?.message).toContain(AI_ROUTING_POLICY_PATH_ENV)
  })

  it('malformed JSON / non-object file THROWS', () => {
    const bad = policyFile('{ not json')
    expect(() => loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: bad })).toThrow(AiRoutingPolicyError)
    const arr = policyFile([1, 2, 3])
    expect(() => loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: arr })).toThrow(AiRoutingPolicyError)
  })

  it('authorizeAiRoute (THE shared choke) never throws — a broken file is a REFUSAL, not an exception', () => {
    const missing = join(scratch, 'absent-policy.json')
    const decision = authorizeAiRoute('openai', 'business', { [AI_ROUTING_POLICY_PATH_ENV]: missing })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('routing_policy_invalid')
  })

  it('authorizeAiRoute refuses business on the default (no-policy) cloud posture, and serves it on a private local one', () => {
    expect(authorizeAiRoute('openai', 'business', {}).allowed).toBe(false)
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const ok = authorizeAiRoute('openai', 'business', {
      [AI_ROUTING_POLICY_PATH_ENV]: path,
      [AI_BASE_URL_ENV]: 'http://10.0.0.9:8000',
    })
    expect(ok.allowed).toBe(true)
    if (ok.allowed) expect(ok.tier).toBe('local')
  })

  it('POISON CONFIG on disk: business in cloudDataClasses THROWS at load', () => {
    const poison = policyFile({
      policyId: 'x',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['business'],
    })
    let caught: AiRoutingPolicyError | null = null
    try {
      loadAiRoutingPolicyFile({ [AI_ROUTING_POLICY_PATH_ENV]: poison })
    } catch (e) {
      caught = e as AiRoutingPolicyError
    }
    expect(caught?.reason).toBe('business_cloud_forbidden')
  })
})
