import { describe, expect, test } from 'vitest'

import { normalizeBpmnHttpTaskEgressPolicyConfig } from '../egress-policy-normalizer'

describe('R1-A3-a BPMN HTTP-task egress policy normalizer', () => {
  test('fails closed when config is missing, empty, or malformed', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const result = normalizeBpmnHttpTaskEgressPolicyConfig(raw)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'EGRESS_POLICY_MISSING', field: 'config' },
        policy: { allowedHosts: [] },
        metadata: {
          policyPresent: false,
          allowedHostCount: 0,
          nat64PrefixCount: 0,
          policyFingerprint: null,
        },
      })
    }
    for (const raw of ['{bad-json', '[]', [], true, 42]) {
      expect(normalizeBpmnHttpTaskEgressPolicyConfig(raw)).toMatchObject({
        ok: false,
        error: { code: 'EGRESS_POLICY_MALFORMED', field: 'config' },
      })
    }
  })

  test('normalizes exact ASCII DNS hosts and values-free metadata', () => {
    const result = normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['API.Example.com.', 'xn--bcher-kva.example'],
      nat64Prefixes: ['2A00:1098:2C::/96'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected policy config to normalize')
    expect(result.policy).toEqual({
      allowedHosts: ['api.example.com', 'xn--bcher-kva.example'],
      nat64Prefixes: ['2a00:1098:2c:0:0:0:0:0/96'],
    })
    expect(result.metadata).toMatchObject({
      policyPresent: true,
      allowedHostCount: 2,
      nat64PrefixCount: 1,
    })
    expect(result.metadata.policyFingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(result.metadata)).not.toContain('api.example.com')
    expect(JSON.stringify(result.metadata)).not.toContain('xn--bcher-kva')
  })

  test('accepts server-owned JSON config input without echoing config in evidence', () => {
    const result = normalizeBpmnHttpTaskEgressPolicyConfig(JSON.stringify({
      allowedHosts: ['Webhook.Example.com'],
      nat64Prefixes: [],
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected JSON policy config to normalize')
    expect(result.policy.allowedHosts).toEqual(['webhook.example.com'])
    expect(JSON.stringify(result.metadata)).not.toContain('Webhook')
  })

  test('rejects empty allowlists and unknown top-level config keys', () => {
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({ allowedHosts: [] })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_EMPTY_ALLOWLIST', field: 'allowedHosts' },
    })
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['api.example.com'],
      timeoutMs: 5000,
    })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_UNKNOWN_KEY', field: 'config' },
    })
  })

  test.each([
    'https://api.example.com',
    'api.example.com/path',
    'api.example.com?x=1',
    'api.example.com#frag',
    'user@api.example.com',
    'api.example.com:443',
    '*.example.com',
    '.example.com',
    'example.com/24',
    '8.8.8.8',
    '2606:4700:4700::1111',
    'localhost',
    'service.localhost',
    'service.local',
    'service.internal',
    'api',
    'bücher.example',
    'api..example.com',
    '-api.example.com',
    'api-.example.com',
  ])('rejects non-exact-host policy entry %s', (host) => {
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({ allowedHosts: [host] })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_INVALID_HOST', field: 'allowedHosts[]' },
    })
  })

  test('rejects duplicate hosts after canonicalization', () => {
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['API.Example.com', 'api.example.com.'],
    })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_DUPLICATE_HOST', field: 'allowedHosts[]' },
    })
  })

  test.each([
    '2a00:1098:2c::/64',
    '8.8.8.0/24',
    'not-a-prefix',
    '2a00:1098:2c::',
    '64:ff9b::/６',
  ])('rejects malformed or non-/96 NAT64 prefix %s', (prefix) => {
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['api.example.com'],
      nat64Prefixes: [prefix],
    })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_INVALID_NAT64_PREFIX', field: 'nat64Prefixes[]' },
    })
  })

  test('rejects duplicate NAT64 prefixes after normalization', () => {
    expect(normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['api.example.com'],
      nat64Prefixes: [
        '2A00:1098:2C::/96',
        '2a00:1098:002c:0000:0000:0000:0000:0000/96',
      ],
    })).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_DUPLICATE_NAT64_PREFIX', field: 'nat64Prefixes[]' },
    })
  })

  test('sorts normalized sets so policy fingerprint is order-independent', () => {
    const first = normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['z.example.com', 'a.example.com'],
      nat64Prefixes: ['2a00:1098:2c::/96', '2a01:1098:2c::/96'],
    })
    const second = normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['A.Example.com.', 'z.example.com'],
      nat64Prefixes: ['2A01:1098:002C:0000:0000:0000:0000:0000/96', '2a00:1098:2c::/96'],
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected both policies to normalize')
    expect(first.policy).toEqual(second.policy)
    expect(first.metadata.policyFingerprint).toBe(second.metadata.policyFingerprint)
    expect(first.policy.allowedHosts).toEqual(['a.example.com', 'z.example.com'])
    expect(first.policy.nat64Prefixes).toEqual([
      '2a00:1098:2c:0:0:0:0:0/96',
      '2a01:1098:2c:0:0:0:0:0/96',
    ])
  })

  test('error result is values-free and never echoes rejected host or secret-shaped config', () => {
    const result = normalizeBpmnHttpTaskEgressPolicyConfig({
      allowedHosts: ['secret-customer-host.example.com/path'],
      bearerToken: 'SECRET-TOKEN-NEVER-ECHO',
    })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-customer-host')
    expect(serialized).not.toContain('SECRET-TOKEN')
    expect(serialized).not.toContain('/path')
  })
})
