import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import fixtures from '../fixtures/plm-change-event-v1-fixtures.json'

afterEach(() => vi.unstubAllEnvs())
describe('PLM source fact verification', () => {
  it.each(fixtures.cases)('verifies HTTP for $name and rejects altered facts or revoked credentials', async ({ event }) => {
    vi.unstubAllGlobals() // setup.ts stubs fetch; this suite exercises the real HTTP transport.
    vi.stubEnv('NODE_ENV', 'test')
    const expected = { ...event, source: { ...event.source, tenant_id: 'tenant-one' } }
    const requests: Array<{ url: string; authorization?: string; tenant?: string | string[] }> = []
    let body: unknown = expected, status = 200
    const server = createServer((req, res) => {
      requests.push({ url: req.url!, authorization: req.headers.authorization, tenant: req.headers['x-tenant-id'] })
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const config = { id: 'source', name: 'Source', type: 'plm',
      connection: { url: `http://127.0.0.1:${port}` }, credentials: { token: 'fixture-token' },
      options: { apiMode: 'yuantus', tenantId: 'tenant-one', orgId: expected.source.org_id } }
    const adapter = new PLMAdapter({ get: vi.fn() } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    try {
      await expect(adapter.verifyPlmChangeEvent(expected, config as never)).resolves.toEqual(expected)
      expect(requests).toHaveLength(1)
      const url = new URL(requests[0].url, config.connection.url)
      expect(url.pathname).toBe(`/api/v1/bom/multitable/${expected.source.part_id}/change-events/${expected.event_id}`)
      expect(url.searchParams.get('binding_id')).toBe(expected.binding_id)
      expect(requests[0]).toMatchObject({ authorization: 'Bearer fixture-token', tenant: 'tenant-one' })
      body = { ...expected, occurred_at: '2026-10-14T13:00:00.999999Z' }
      await expect(adapter.verifyPlmChangeEvent(expected, config as never)).rejects.toThrow('PLM change source unavailable')
      body = { ...expected, source: { ...expected.source, org_id: 'foreign' } }
      await expect(adapter.verifyPlmChangeEvent(expected, config as never)).rejects.toThrow()
      status = 401
      await expect(adapter.verifyPlmChangeEvent(expected, config as never)).rejects.toMatchObject({ response: { status: 401 } })
      expect(requests).toHaveLength(4)
      await expect(adapter.verifyPlmChangeEvent({ ...expected, actor_auth_id: 42 }, config as never)).rejects.toThrow()
      await expect(adapter.verifyPlmChangeEvent(expected, { ...config, credentials: {} } as never)).rejects.toThrow()
      expect(requests).toHaveLength(4)
      status = 200
      const pageRequest = { binding_id: expected.binding_id, binding_version: expected.binding_version, source: expected.source }
      const baseline = { schema: 'yuantus.plm-change-page.v1', source: expected.source,
        head_sequence: 1, next_sequence: 1, events: [] }
      body = baseline
      await expect(adapter.getPlmChangePage(pageRequest, config as never)).resolves.toEqual(baseline)
      expect(new URL(requests.at(-1)!.url, config.connection.url).searchParams.has('after_sequence')).toBe(false)
      body = { ...baseline, events: [{ sequence: 1, event: expected }] }
      await expect(adapter.getPlmChangePage({ ...pageRequest, after_sequence: 0 }, config as never)).resolves.toEqual(body)
      expect(new URL(requests.at(-1)!.url, config.connection.url).searchParams.get('after_sequence')).toBe('0')
      body = { ...baseline, source: { ...expected.source, part_id: 'foreign' } }
      await expect(adapter.getPlmChangePage(pageRequest, config as never)).rejects.toThrow('PLM change page unavailable')
      status = 403
      await expect(adapter.getPlmChangePage(pageRequest, config as never)).rejects.toMatchObject({ response: { status: 403 } })
      expect(requests).toHaveLength(8)
      await expect(adapter.getPlmChangePage({ ...pageRequest, after_sequence: -1 }, config as never)).rejects.toThrow()
      expect(requests).toHaveLength(8)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  })
})
