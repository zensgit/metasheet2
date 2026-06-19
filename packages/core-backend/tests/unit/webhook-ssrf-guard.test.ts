/**
 * SSRF guard goldens for send_webhook (B1-S2, #2897 §3.1) — the #1 egress control. Adversarial: every
 * private/loopback/link-local/metadata range (IPv4 + IPv6 + IPv4-mapped) must be rejected; a name that
 * resolves to ANY internal address must be rejected (incl. multi-record / rebinding-shaped); only a
 * public https target with all-public resolved addresses is allowed (and pinned).
 */
import { describe, test, expect } from 'vitest'
import {
  isInternalIpv4,
  isInternalIpv6,
  isInternalAddress,
  checkWebhookTargetUrl,
  type SsrfLookupFn,
} from '../../src/multitable/webhook-ssrf-guard'

describe('SSRF guard — IPv4 ranges', () => {
  test('private / loopback / link-local / metadata / this-host are internal', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
      expect(isInternalIpv4(ip), ip).toBe(true)
    }
  })
  test('public IPv4 is allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
      expect(isInternalIpv4(ip), ip).toBe(false)
    }
  })
  test('malformed IPv4 fails closed (treated as internal)', () => {
    for (const ip of ['bad', '1.2.3', '999.1.1.1', '1.2.3.4.5', '']) expect(isInternalIpv4(ip), ip).toBe(true)
  })
})

describe('SSRF guard — IPv6 ranges', () => {
  test('loopback / unspecified / ULA / link-local are internal', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1']) {
      expect(isInternalIpv6(ip), ip).toBe(true)
    }
  })
  test('IPv4-mapped private is internal (dotted AND hex forms — no smuggling)', () => {
    expect(isInternalIpv6('::ffff:127.0.0.1')).toBe(true)
    expect(isInternalIpv6('::ffff:10.0.0.1')).toBe(true)
    expect(isInternalIpv6('::ffff:7f00:1')).toBe(true) // hex form of 127.0.0.1
    expect(isInternalIpv6('::ffff:0a00:1')).toBe(true) // hex form of 10.0.0.1
  })
  test('public IPv6 (and public IPv4-mapped) is allowed', () => {
    expect(isInternalIpv6('2606:4700:4700::1111')).toBe(false) // public
    expect(isInternalIpv6('::ffff:8.8.8.8')).toBe(false)
    expect(isInternalIpv6('fe80::1%eth0')).toBe(true) // scope id stripped, still link-local
  })
  test('isInternalAddress dispatches by family', () => {
    expect(isInternalAddress('10.0.0.1')).toBe(true)
    expect(isInternalAddress('fc00::1')).toBe(true)
    expect(isInternalAddress('8.8.8.8')).toBe(false)
  })
})

describe('SSRF guard — checkWebhookTargetUrl', () => {
  const noLookup: SsrfLookupFn = async () => { throw new Error('should not resolve') }
  const resolveTo = (addrs: string[]): SsrfLookupFn => async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

  test('non-https schemes are rejected', async () => {
    expect((await checkWebhookTargetUrl('http://example.com', noLookup)).ok).toBe(false)
    expect((await checkWebhookTargetUrl('file:///etc/passwd', noLookup)).ok).toBe(false)
  })
  test('missing / malformed URL is rejected', async () => {
    expect((await checkWebhookTargetUrl('', noLookup)).ok).toBe(false)
    expect((await checkWebhookTargetUrl('not a url', noLookup)).ok).toBe(false)
    expect((await checkWebhookTargetUrl(undefined, noLookup)).ok).toBe(false)
  })
  test('internal hostnames are rejected without resolving', async () => {
    for (const u of ['https://localhost/x', 'https://api.internal/x', 'https://db.local/x']) {
      expect((await checkWebhookTargetUrl(u, noLookup)).ok, u).toBe(false)
    }
  })
  test('internal IP literals are rejected (no DNS)', async () => {
    for (const u of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://[fc00::1]/x']) {
      expect((await checkWebhookTargetUrl(u, noLookup)).ok, u).toBe(false)
    }
  })
  test('a public IP literal is allowed (pinned to itself)', async () => {
    const r = await checkWebhookTargetUrl('https://8.8.8.8/hook', noLookup)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.addresses).toEqual(['8.8.8.8'])
  })
  test('a name resolving to an internal address is rejected (incl. one internal among many)', async () => {
    expect((await checkWebhookTargetUrl('https://evil.example.com/x', resolveTo(['10.0.0.5']))).ok).toBe(false)
    expect((await checkWebhookTargetUrl('https://evil.example.com/x', resolveTo(['93.184.216.34', '169.254.169.254']))).ok).toBe(false)
    expect((await checkWebhookTargetUrl('https://evil.example.com/x', resolveTo(['::ffff:127.0.0.1']))).ok).toBe(false)
  })
  test('a public name resolving to all-public addresses is allowed and pinned', async () => {
    const r = await checkWebhookTargetUrl('https://hooks.example.com/x', resolveTo(['93.184.216.34', '2606:4700::1111']))
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.hostname).toBe('hooks.example.com'); expect(r.addresses).toContain('93.184.216.34') }
  })
  test('a name that does not resolve is rejected', async () => {
    expect((await checkWebhookTargetUrl('https://nope.example.com/x', resolveTo([]))).ok).toBe(false)
  })
})
