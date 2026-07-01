import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'

import {
  pinnedHttpsJsonRequest,
  type HttpsRequestFn,
} from '../egress-pinned-transport'

function makeFakeRequest(
  status: number,
  responseBody: string,
  mode: { timeout?: boolean; error?: Error } = {},
) {
  let captured: { address: string; family: number } | null = null
  let capturedHeaders: Record<string, string> = {}
  const writes: string[] = []

  const request = ((_url: unknown, options: any, cb: any) => {
    capturedHeaders = options.headers ?? {}
    const req: any = new EventEmitter()
    req.write = (chunk: string) => { writes.push(String(chunk)) }
    req.destroy = () => {}
    req.end = () => {
      options.lookup('rebind.attacker.example', {}, (_e: unknown, address: string, family: number) => {
        captured = { address, family }
      })
      if (mode.error) { setImmediate(() => req.emit('error', mode.error)); return }
      if (mode.timeout) { setImmediate(() => req.emit('timeout')); return }
      const res: any = new EventEmitter()
      res.statusCode = status
      res.headers = { 'content-type': 'application/json', location: '/next' }
      res.destroy = () => {}
      setImmediate(() => {
        cb(res)
        res.emit('data', Buffer.from(responseBody))
        res.emit('end')
      })
    }
    return req
  }) as unknown as HttpsRequestFn

  return { request, captured: () => captured, headers: () => capturedHeaders, writes: () => writes }
}

describe('pinned HTTPS JSON transport', () => {
  test('connects to the pinned address, preserves Host/SNI identity, and parses bounded JSON', async () => {
    const fake = makeFakeRequest(200, '{"ok":true}')

    const response = await pinnedHttpsJsonRequest(
      {
        normalizedUrl: 'https://api.example.com/hook',
        hostname: 'api.example.com',
        pinnedAddress: '8.8.8.8',
        family: 4,
        method: 'POST',
        headers: { Host: 'evil.example.com', 'X-Keep': 'yes' },
        body: '{"hello":"world"}',
        redirect: 'manual',
        redirectCount: 0,
      },
      { timeoutMs: 1000, maxResponseBytes: 1024, requestImpl: fake.request },
    )

    expect(response).toMatchObject({
      status: 200,
      body: { ok: true },
      headers: { location: '/next' },
    })
    expect(fake.captured()).toEqual({ address: '8.8.8.8', family: 4 })
    expect(fake.headers()).toMatchObject({ host: 'api.example.com', 'X-Keep': 'yes' })
    expect(fake.headers().Host).toBeUndefined()
    expect(fake.writes()).toEqual(['{"hello":"world"}'])
  })

  test('rejects oversized responses before surfacing a body', async () => {
    const fake = makeFakeRequest(200, '{"too":"large"}')

    await expect(pinnedHttpsJsonRequest(
      {
        normalizedUrl: 'https://api.example.com/hook',
        hostname: 'api.example.com',
        pinnedAddress: '8.8.8.8',
        family: 4,
        method: 'GET',
        headers: {},
        redirect: 'manual',
        redirectCount: 0,
      },
      { timeoutMs: 1000, maxResponseBytes: 4, requestImpl: fake.request },
    )).rejects.toThrow('pinned egress response exceeded size limit')
  })
})
