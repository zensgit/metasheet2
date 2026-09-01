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
  AI_KNOWN_CLOUD_HOSTS,
  AI_ROUTING_POLICY_PATH_ENV,
  AiRoutingPolicyError,
  decideAiRoute,
  loadAiRoutingPolicyFile,
  normalizeAiRoutingPolicy,
  normalizeDataClass,
  resolveActiveProviderTier,
  type AiDataClass,
} from '../../src/services/ai-routing-policy'
import { AI_BASE_URL_ENV, AI_PROVIDER_ALLOWLIST } from '../../src/services/ai-provider-readiness'

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
  it('no policy → the provider BUILT-IN tier (cloud for every allowlisted provider)', () => {
    for (const provider of AI_PROVIDER_ALLOWLIST) {
      expect(AI_BUILTIN_PROVIDER_TIERS[provider]).toBe('cloud')
      expect(resolveActiveProviderTier(provider, null, {})).toEqual({ tier: 'cloud', downgraded: false })
    }
  })

  it('policy declares CLOUD → cloud', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'cloud' } })
    expect(resolveActiveProviderTier('openai', policy, {}).tier).toBe('cloud')
  })

  it('policy declares LOCAL + a private, explicitly-set base URL → local', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const res = resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: 'https://qwen.internal.corp:8000' })
    expect(res).toEqual({ tier: 'local', downgraded: false })
  })

  it('RED: policy declares LOCAL but base URL is UNSET → DOWNGRADED to cloud (default local-only, no leak)', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    expect(resolveActiveProviderTier('openai', policy, {})).toEqual({ tier: 'cloud', downgraded: true })
  })

  it('RED: policy declares LOCAL but base URL is a KNOWN PUBLIC CLOUD HOST → DOWNGRADED to cloud (fail-closed)', () => {
    const policy = normalizeAiRoutingPolicy({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    for (const host of AI_KNOWN_CLOUD_HOSTS) {
      const res = resolveActiveProviderTier('openai', policy, { [AI_BASE_URL_ENV]: `https://${host}/v1` })
      expect(res, host).toEqual({ tier: 'cloud', downgraded: true })
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
