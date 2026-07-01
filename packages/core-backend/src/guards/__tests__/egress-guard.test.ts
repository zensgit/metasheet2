import { describe, expect, test } from 'vitest'

import {
  defaultEgressPolicy,
  isBlockedEgressIp,
  validateEgressUrl,
  type EgressPolicy,
} from '../egress-guard'

const policy = (hosts: readonly string[]): EgressPolicy => ({ allowedHosts: hosts })

describe('R1-A egress guard — IP deny-list', () => {
  test.each([
    '127.0.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '192.0.2.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::7f00:1',
    '::a00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2000::5efe:169.254.169.254',
    '2000::200:5efe:a9fe:a9fe',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ])('blocks unsafe IP literal %s', (ip) => {
    expect(isBlockedEgressIp(ip)).toBe(true)
  })

  test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows globally-routable IP literal %s at the deny-list layer',
    (ip) => {
      expect(isBlockedEgressIp(ip)).toBe(false)
    },
  )
})

describe('R1-A egress guard — URL policy', () => {
  test('fails closed when no allowlist is configured', () => {
    expect(validateEgressUrl('https://api.example.com/hook', defaultEgressPolicy())).toEqual({
      allowed: false,
      reason: 'ALLOWLIST_REQUIRED',
    })
  })

  test('allows an exact allowlisted https host and normalizes host case', () => {
    expect(validateEgressUrl('https://API.Example.com/hook?a=1', policy(['api.example.com']))).toMatchObject({
      allowed: true,
      protocol: 'https:',
      hostname: 'api.example.com',
    })
  })

  test('rejects non-https schemes, including otherwise-allowlisted http', () => {
    expect(validateEgressUrl('http://api.example.com/hook', policy(['api.example.com']))).toEqual({
      allowed: false,
      reason: 'SCHEME_NOT_ALLOWED',
    })
    for (const scheme of ['file', 'ftp', 'gopher', 'data', 'ws', 'wss', 'mailto']) {
      expect(validateEgressUrl(`${scheme}:example`, policy(['api.example.com']))).toMatchObject({
        allowed: false,
        reason: 'SCHEME_NOT_ALLOWED',
      })
    }
  })

  test('rejects credentials in URL even for an allowlisted host', () => {
    expect(validateEgressUrl('https://user:pass@api.example.com/hook', policy(['api.example.com']))).toEqual({
      allowed: false,
      reason: 'URL_CREDENTIALS_NOT_ALLOWED',
    })
  })

  test('requires exact host allowlisting; suffixes and wildcards do not match', () => {
    expect(validateEgressUrl('https://evil.api.example.com/hook', policy(['api.example.com']))).toEqual({
      allowed: false,
      reason: 'HOST_NOT_ALLOWLISTED',
    })
    expect(validateEgressUrl('https://api.example.com/hook', policy(['*.example.com', 'example.com/24']))).toEqual({
      allowed: false,
      reason: 'ALLOWLIST_REQUIRED',
    })
  })

  test('rejects local/internal hostnames even if accidentally allowlisted', () => {
    for (const host of ['localhost', 'service.localhost', 'service.local', 'service.internal']) {
      expect(validateEgressUrl(`https://${host}/`, policy([host]))).toEqual({
        allowed: false,
        reason: 'HOST_INTERNAL_NAME',
      })
    }
  })

  test('checks IP literals after URL canonicalization, including decimal/hex/short IPv4 forms', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://2130706433/',
      'https://0x7f000001/',
      'https://127.1/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::7f00:1]/',
      'https://[64:ff9b::7f00:1]/',
      'https://[2000::5efe:169.254.169.254]/',
      'https://[2000::200:5efe:a9fe:a9fe]/',
    ]) {
      expect(validateEgressUrl(url, defaultEgressPolicy())).toEqual({
        allowed: false,
        reason: 'IP_BLOCKED',
      })
    }
  })

  test('allows a public IP literal only when the exact IP host is allowlisted', () => {
    expect(validateEgressUrl('https://8.8.8.8/dns-query', policy(['8.8.8.8']))).toMatchObject({
      allowed: true,
      hostname: '8.8.8.8',
    })
    expect(validateEgressUrl('https://8.8.8.8/dns-query', policy(['dns.google']))).toEqual({
      allowed: false,
      reason: 'HOST_NOT_ALLOWLISTED',
    })
  })

  test('allows a public IPv6 literal only when the exact IP host is allowlisted', () => {
    expect(validateEgressUrl('https://[2606:4700:4700::1111]/', policy(['2606:4700:4700::1111']))).toMatchObject({
      allowed: true,
      hostname: '2606:4700:4700::1111',
    })
  })

  test('treats CIDR-like allowlist entries as invalid in v1, never as a widened allow', () => {
    expect(validateEgressUrl('https://8.8.8.8/dns-query', policy(['8.8.8.0/24']))).toEqual({
      allowed: false,
      reason: 'ALLOWLIST_REQUIRED',
    })
  })
})

describe('R1-A egress guard — NAT64 Network-Specific Prefix (configurable)', () => {
  test('well-known 64:ff9b::/96 embedding an internal v4 is blocked by default', () => {
    expect(isBlockedEgressIp('64:ff9b::a00:1')).toBe(true) // 10.0.0.1
  })
  test('a configured NSP NAT64 embedding an internal v4 is blocked', () => {
    expect(isBlockedEgressIp('2a00:1098:2c::a00:1', ['2a00:1098:2c::/96'])).toBe(true) // 10.0.0.1
  })
  test('a configured NSP NAT64 embedding cloud metadata is blocked', () => {
    expect(isBlockedEgressIp('2a00:1098:2c::a9fe:a9fe', ['2a00:1098:2c::/96'])).toBe(true) // 169.254.169.254
  })
  test('a configured NSP NAT64 embedding a public v4 decodes and is not blocked', () => {
    expect(isBlockedEgressIp('2a00:1098:2c::808:808', ['2a00:1098:2c::/96'])).toBe(false) // 8.8.8.8
  })
  test('RESIDUAL: an unconfigured NSP NAT64 is not decoded (L3 allowlist is the backstop)', () => {
    expect(isBlockedEgressIp('2a00:1098:2c::a00:1')).toBe(false)
  })
  test('end-to-end: a configured NSP NAT64 pointing at an internal v4 is IP_BLOCKED', () => {
    const p: EgressPolicy = { allowedHosts: [], nat64Prefixes: ['2a00:1098:2c::/96'] }
    expect(validateEgressUrl('https://[2a00:1098:2c::a00:1]/', p)).toEqual({
      allowed: false,
      reason: 'IP_BLOCKED',
    })
  })
})

describe('R1-A egress guard — isBlockedEgressIp always folds in well-known NAT64 (P3 API hardening)', () => {
  // REGRESSION-CATCHER (red before the fix, green after). A direct caller passing ONLY a custom
  // prefix must still decode the well-known 64:ff9b::/96. Pre-fix the custom prefix REPLACED the
  // default, so 64:ff9b:: skipped the decode loop and fell through to ipaddr.js's rfc6052 range
  // → range() !== 'unicast' → conservatively (and here wrongly) blocked. Post-fix well-known is
  // always merged, so the inner PUBLIC v4 (8.8.8.8) is decoded and correctly allowed. This is the
  // single assertion whose result differs between old and new code.
  test('REGRESSION: well-known NAT64 embedding a PUBLIC v4 is decoded even when only a custom prefix is passed', () => {
    expect(isBlockedEgressIp('64:ff9b::808:808', ['2a00:1098:2c::/96'])).toBe(false) // 8.8.8.8
  })

  // GUARDS: true on both old and new code (the rfc6052 fallback already blocks these). They assert
  // the security direction is never weakened by the change — not that they catch the P3 regression.
  test('GUARD: well-known NAT64 embedding cloud metadata stays blocked with a custom-only prefix', () => {
    expect(isBlockedEgressIp('64:ff9b::a9fe:a9fe', ['2a00:1098:2c::/96'])).toBe(true) // 169.254.169.254
  })
  test('GUARD: a single custom-prefix call keeps BOTH the custom NSP and well-known active', () => {
    expect(isBlockedEgressIp('2a00:1098:2c::a00:1', ['2a00:1098:2c::/96'])).toBe(true) // custom NSP → 10.0.0.1
    expect(isBlockedEgressIp('64:ff9b::a00:1', ['2a00:1098:2c::/96'])).toBe(true) // well-known → 10.0.0.1
  })

  // ZERO-DRIFT: validateEgressUrl source is untouched; its existing explicit [...WELL_KNOWN, ...policy]
  // merge is byte-identical after the helper's Set-dedup, so the main path is unchanged.
  test('ZERO-DRIFT: validateEgressUrl still blocks well-known NAT64 metadata under a configured-NSP policy', () => {
    const p: EgressPolicy = { allowedHosts: [], nat64Prefixes: ['2a00:1098:2c::/96'] }
    expect(validateEgressUrl('https://[64:ff9b::a9fe:a9fe]/', p)).toEqual({
      allowed: false,
      reason: 'IP_BLOCKED',
    })
  })
})
