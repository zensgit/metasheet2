import { describe, expect, test } from 'vitest'

import {
  dispatchPinnedEgressRequest,
  type EgressAddressResolver,
  type PinnedEgressRequest,
  type PinnedEgressTransport,
} from '../egress-dispatcher'
import type { EgressPolicy } from '../egress-guard'

const policy = (hosts: readonly string[], extra: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowedHosts: hosts,
  ...extra,
})

const resolver = (addresses: readonly { address: string; family?: 4 | 6 }[]): EgressAddressResolver => {
  return async () => addresses
}

const recordingTransport = (
  responses: readonly { status: number; headers?: Record<string, string>; body?: unknown }[],
): { calls: PinnedEgressRequest[]; transport: PinnedEgressTransport } => {
  const calls: PinnedEgressRequest[] = []
  return {
    calls,
    transport: async (request) => {
      calls.push(request)
      return responses[Math.min(calls.length - 1, responses.length - 1)] ?? { status: 204 }
    },
  }
}

describe('R1-A egress pinned dispatcher', () => {
  test('validates allowlist, resolves once, and passes only the pinned public address to transport', async () => {
    const { calls, transport } = recordingTransport([{ status: 200, body: { ok: true } }])
    const resolvedHosts: string[] = []

    const decision = await dispatchPinnedEgressRequest(
      {
        url: 'https://API.Example.com/hook',
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: { hello: 'world' },
      },
      {
        policy: policy(['api.example.com']),
        resolveAddresses: async (hostname) => {
          resolvedHosts.push(hostname)
          return [{ address: '8.8.8.8', family: 4 }]
        },
        transport,
      },
    )

    expect(decision).toMatchObject({
      allowed: true,
      finalUrl: 'https://api.example.com/hook',
      redirectCount: 0,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      normalizedUrl: 'https://api.example.com/hook',
      hostname: 'api.example.com',
      pinnedAddress: '8.8.8.8',
      family: 4,
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: { hello: 'world' },
      redirect: 'manual',
      redirectCount: 0,
    })
    expect(resolvedHosts).toEqual(['api.example.com'])
  })

  test('rejects caller-supplied Host headers before DNS or transport', async () => {
    let resolved = false
    let transported = false

    for (const headers of [{ Host: 'evil.example.com' }, { host: 'evil.example.com' }]) {
      const decision = await dispatchPinnedEgressRequest(
        { url: 'https://api.example.com/hook', headers },
        {
          policy: policy(['api.example.com']),
          resolveAddresses: async () => {
            resolved = true
            return [{ address: '8.8.8.8', family: 4 }]
          },
          transport: async () => {
            transported = true
            return { status: 200 }
          },
        },
      )

      expect(decision).toEqual({ allowed: false, reason: 'HOST_HEADER_NOT_ALLOWED' })
    }
    expect(resolved).toBe(false)
    expect(transported).toBe(false)
  })

  test('fails closed before DNS or transport when URL policy denies the target', async () => {
    let resolved = false
    let transported = false

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/hook' },
      {
        policy: policy([]),
        resolveAddresses: async () => {
          resolved = true
          return [{ address: '8.8.8.8', family: 4 }]
        },
        transport: async () => {
          transported = true
          return { status: 200 }
        },
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'ALLOWLIST_REQUIRED' })
    expect(resolved).toBe(false)
    expect(transported).toBe(false)
  })

  test('denies the whole dispatch if any resolved address is unsafe', async () => {
    let transported = false

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/hook' },
      {
        policy: policy(['api.example.com']),
        resolveAddresses: resolver([
          { address: '8.8.8.8', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
        transport: async () => {
          transported = true
          return { status: 200 }
        },
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'DNS_IP_BLOCKED' })
    expect(transported).toBe(false)
  })

  test('blocks resolved NAT64 addresses that embed an internal IPv4', async () => {
    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/hook' },
      {
        policy: policy(['api.example.com'], { nat64Prefixes: ['2a00:1098:2c::/96'] }),
        resolveAddresses: resolver([{ address: '2a00:1098:2c::a9fe:a9fe', family: 6 }]),
        transport: async () => ({ status: 200 }),
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'DNS_IP_BLOCKED' })
  })

  test('fails closed on DNS uncertainty and invalid resolver output', async () => {
    await expect(
      dispatchPinnedEgressRequest(
        { url: 'https://api.example.com/hook' },
        {
          policy: policy(['api.example.com']),
          resolveAddresses: async () => {
            throw new Error('lookup failed')
          },
          transport: async () => ({ status: 200 }),
        },
      ),
    ).resolves.toEqual({ allowed: false, reason: 'DNS_LOOKUP_FAILED' })

    await expect(
      dispatchPinnedEgressRequest(
        { url: 'https://api.example.com/hook' },
        {
          policy: policy(['api.example.com']),
          resolveAddresses: resolver([]),
          transport: async () => ({ status: 200 }),
        },
      ),
    ).resolves.toEqual({ allowed: false, reason: 'DNS_NO_ADDRESSES' })

    await expect(
      dispatchPinnedEgressRequest(
        { url: 'https://api.example.com/hook' },
        {
          policy: policy(['api.example.com']),
          resolveAddresses: resolver([{ address: 'not-an-ip' }]),
          transport: async () => ({ status: 200 }),
        },
      ),
    ).resolves.toEqual({ allowed: false, reason: 'DNS_INVALID_ADDRESS' })
  })

  test('uses an allowlisted public IP literal as its own pinned address without DNS lookup', async () => {
    let resolved = false
    const { calls, transport } = recordingTransport([{ status: 204 }])

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://8.8.8.8/dns-query' },
      {
        policy: policy(['8.8.8.8']),
        resolveAddresses: async () => {
          resolved = true
          return [{ address: '10.0.0.1', family: 4 }]
        },
        transport,
      },
    )

    expect(decision).toMatchObject({ allowed: true })
    expect(resolved).toBe(false)
    expect(calls[0]).toMatchObject({
      hostname: '8.8.8.8',
      pinnedAddress: '8.8.8.8',
      family: 4,
    })
  })

  test('revalidates redirects and rejects a redirect target outside the allowlist before transport', async () => {
    const { calls, transport } = recordingTransport([
      { status: 302, headers: { Location: 'https://evil.example.com/next' } },
      { status: 200 },
    ])

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/start' },
      {
        policy: policy(['api.example.com']),
        resolveAddresses: resolver([{ address: '8.8.8.8', family: 4 }]),
        transport,
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWLISTED' })
    expect(calls).toHaveLength(1)
  })

  test('revalidates redirect DNS and rejects a redirect that resolves to a private IP', async () => {
    const { calls, transport } = recordingTransport([
      { status: 302, headers: { Location: 'https://safe.example.com/next' } },
      { status: 200 },
    ])
    const addressesByHost: Record<string, readonly { address: string; family: 4 | 6 }[]> = {
      'api.example.com': [{ address: '8.8.8.8', family: 4 }],
      'safe.example.com': [{ address: '10.0.0.8', family: 4 }],
    }

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/start' },
      {
        policy: policy(['api.example.com', 'safe.example.com']),
        resolveAddresses: async (hostname) => addressesByHost[hostname] ?? [],
        transport,
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'DNS_IP_BLOCKED' })
    expect(calls).toHaveLength(1)
  })

  test('follows a revalidated redirect with a freshly pinned public address', async () => {
    const { calls, transport } = recordingTransport([
      { status: 302, headers: { Location: 'https://safe.example.com/next' } },
      { status: 200, body: { ok: true } },
    ])
    const addressesByHost: Record<string, readonly { address: string; family: 4 | 6 }[]> = {
      'api.example.com': [{ address: '8.8.8.8', family: 4 }],
      'safe.example.com': [{ address: '1.1.1.1', family: 4 }],
    }

    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/start' },
      {
        policy: policy(['api.example.com', 'safe.example.com']),
        resolveAddresses: async (hostname) => addressesByHost[hostname] ?? [],
        transport,
      },
    )

    expect(decision).toMatchObject({
      allowed: true,
      finalUrl: 'https://safe.example.com/next',
      redirectCount: 1,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ hostname: 'api.example.com', pinnedAddress: '8.8.8.8' })
    expect(calls[0]?.redirect).toBe('manual')
    expect(calls[1]).toMatchObject({
      hostname: 'safe.example.com',
      pinnedAddress: '1.1.1.1',
      redirect: 'manual',
      redirectCount: 1,
    })
  })

  test('caps redirect chains fail-closed', async () => {
    const decision = await dispatchPinnedEgressRequest(
      { url: 'https://api.example.com/start' },
      {
        policy: policy(['api.example.com']),
        resolveAddresses: resolver([{ address: '8.8.8.8', family: 4 }]),
        maxRedirects: 0,
        transport: async () => ({ status: 302, headers: { Location: 'https://api.example.com/again' } }),
      },
    )

    expect(decision).toEqual({ allowed: false, reason: 'REDIRECT_LIMIT_EXCEEDED' })
  })
})
