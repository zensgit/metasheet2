import { describe, expect, it } from 'vitest'

import {
  defaultEgressPolicy,
  isBlockedIp,
  validateEgressUrl,
  type EgressPolicy,
} from '../egress-guard'

function policy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return { allowedSchemes: ['https'], allowedHosts: [], allowedCidrs: [], ...over }
}

describe('isBlockedIp — L2 classifier', () => {
  const blocked = [
    // IPv4 non-global-unicast
    '127.0.0.1', '127.5.5.5', '0.0.0.0', '255.255.255.255',
    '169.254.169.254', // cloud metadata
    '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', // CGNAT
    '224.0.0.1', '240.0.0.1',
    // IPv6 non-global
    '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::',
    // embedded-IPv4 tunnel forms whose inner v4 is blocked (the top SSRF bypasses)
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '64:ff9b::7f00:1', // NAT64 well-known → 127.0.0.1
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo → blocked outright
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true))
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']
  for (const ip of allowed) {
    it(`allows global-unicast ${ip}`, () => expect(isBlockedIp(ip)).toBe(false))
  }

  it('fail-closes on an unparseable value', () => expect(isBlockedIp('not-an-ip')).toBe(true))
})

describe('validateEgressUrl — scheme + creds (L1)', () => {
  const p = policy({ allowedHosts: ['example.com', '8.8.8.8'] })
  for (const bad of [
    'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/',
    'data:text/plain,hello', 'ws://example.com/', 'mailto:a@example.com',
  ]) {
    it(`rejects scheme: ${bad}`, () => expect(validateEgressUrl(bad, p).allowed).toBe(false))
  }
  it('rejects http when policy is https-only', () =>
    expect(validateEgressUrl('http://example.com/', p).allowed).toBe(false))
  it('accepts https to an allowlisted host', () =>
    expect(validateEgressUrl('https://example.com/', p).allowed).toBe(true))
  it('rejects credentials in the URL', () =>
    expect(validateEgressUrl('https://user:pass@example.com/', p).allowed).toBe(false))
  it('allows http only when explicitly configured (D1)', () =>
    expect(validateEgressUrl('http://example.com/',
      policy({ allowedSchemes: ['https', 'http'], allowedHosts: ['example.com'] })).allowed).toBe(true))
})

describe('validateEgressUrl — IP-literal + host normalization (L2)', () => {
  // Allow every address by CIDR so ONLY the L2 classifier can block — isolates L2.
  const p = policy({ allowedCidrs: ['0.0.0.0/0', '::/0'] })
  const blockedUrls = [
    'https://127.0.0.1/',
    'https://169.254.169.254/', // metadata
    'https://[::1]/',
    'https://10.0.0.1/',
    'https://[::ffff:169.254.169.254]/', // IPv4-mapped metadata
    'https://2130706433/', // decimal 127.0.0.1 — canonicalized by new URL()
    'https://0x7f000001/', // hex 127.0.0.1
    'https://127.1/', // short form 127.0.0.1
  ]
  for (const u of blockedUrls) {
    it(`blocks ${u}`, () => expect(validateEgressUrl(u, p).allowed).toBe(false))
  }
  it('allows a public IP that is allowlisted', () =>
    expect(validateEgressUrl('https://8.8.8.8/', policy({ allowedHosts: ['8.8.8.8'] })).allowed).toBe(true))
})

describe('validateEgressUrl — allowlist (L3) + fail-closed (L7)', () => {
  it('denies a public IP not on the allowlist (empty default)', () =>
    expect(validateEgressUrl('https://8.8.8.8/', defaultEgressPolicy()).allowed).toBe(false))
  it('denies a public DNS host not on the allowlist', () =>
    expect(validateEgressUrl('https://evil.example/', defaultEgressPolicy()).allowed).toBe(false))
  it('allows an allowlisted DNS host', () =>
    expect(validateEgressUrl('https://api.example.com/', policy({ allowedHosts: ['api.example.com'] })).allowed).toBe(true))
  it('allows a public IP via CIDR', () =>
    expect(validateEgressUrl('https://8.8.8.8/', policy({ allowedCidrs: ['8.8.8.0/24'] })).allowed).toBe(true))
  it('L2 overrides L3 — an allowlisted internal IP is still blocked', () =>
    expect(validateEgressUrl('https://127.0.0.1/',
      policy({ allowedHosts: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'] })).allowed).toBe(false))
  it('denies a malformed URL', () =>
    expect(validateEgressUrl('http://', defaultEgressPolicy()).allowed).toBe(false))
  it('a malformed allowlist CIDR never widens access', () =>
    expect(validateEgressUrl('https://8.8.8.8/', policy({ allowedCidrs: ['not-a-cidr'] })).allowed).toBe(false))
})

describe('isBlockedIp — NAT64 Network-Specific Prefix (configurable)', () => {
  it('well-known 64:ff9b::/96 with an embedded internal v4 is blocked by default', () =>
    expect(isBlockedIp('64:ff9b::a00:1')).toBe(true)) // 10.0.0.1
  it('a configured NSP NAT64 embedding an internal v4 is blocked', () =>
    expect(isBlockedIp('2a00:1098:2c::a00:1', ['2a00:1098:2c::/96'])).toBe(true)) // 10.0.0.1
  it('a configured NSP NAT64 embedding cloud metadata is blocked', () =>
    expect(isBlockedIp('2a00:1098:2c::a9fe:a9fe', ['2a00:1098:2c::/96'])).toBe(true)) // 169.254.169.254
  it('a configured NSP NAT64 embedding a PUBLIC v4 decodes and is allowed', () =>
    expect(isBlockedIp('2a00:1098:2c::808:808', ['2a00:1098:2c::/96'])).toBe(false)) // 8.8.8.8
  it('RESIDUAL: an UNCONFIGURED NSP NAT64 is not decoded (documented; L3 allowlist is the backstop)', () =>
    expect(isBlockedIp('2a00:1098:2c::a00:1')).toBe(false))
})

describe('validateEgressUrl — NAT64 NSP via policy (L2 over L3)', () => {
  it('a configured NSP NAT64 pointing at an internal v4 is denied even if the /64 is allowlisted', () =>
    expect(validateEgressUrl('https://[2a00:1098:2c::a00:1]/',
      policy({ nat64Prefixes: ['2a00:1098:2c::/96'], allowedCidrs: ['2a00:1098:2c::/64'] })).allowed).toBe(false))
})
