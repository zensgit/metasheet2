import { afterEach, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import {
  readSharedTransportAudit,
  resetSharedTransportAudit,
  setManagedBindingReaderForTests,
} from '../../src/services/plm-managed-companion'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setManagedBindingReaderForTests(null)
  resetSharedTransportAudit()
})

function adapter() {
  return new PLMAdapter(
    { get: async () => undefined } as never,
    { info() {}, warn() {}, error() {}, debug() {} } as never,
    { id: 'bound-source', name: 'bound', type: 'plm', connection: { url: 'https://native.invalid' } },
  )
}

function connectedClient() {
  return {
    request: vi.fn(async () => ({ data: [{ native_secret: 'sentinel' }] })),
    get: vi.fn(async () => ({ status: 200, data: {} })),
    post: vi.fn(async () => ({ data: { native_secret: 'sentinel' } })),
    put: vi.fn(async () => ({ data: { native_secret: 'sentinel' } })),
    delete: vi.fn(async () => ({ data: { native_secret: 'sentinel' } })),
    head: vi.fn(async () => ({ status: 200 })),
  }
}

function attach(a: PLMAdapter, client: ReturnType<typeof connectedClient>) {
  ;(a as unknown as { client: unknown }).client = client
  return a
}

it('blocks inherited select before a previously connected shared client can read', async () => {
  setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: {} as never }))
  const a = adapter()
  const request = vi.fn(async () => ({ data: [{ native_secret: 'sentinel' }] }))
  ;(a as unknown as { client: unknown }).client = { request }
  await expect(a.select('/native-data')).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  expect(request).not.toHaveBeenCalled()
  expect(readSharedTransportAudit().calls).toBe(0)
})

it('blocks mock getProducts for a durable managed binding', async () => {
  setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: {} as never }))
  const a = adapter()
  ;(a as unknown as { mockMode: boolean }).mockMode = true
  await expect(a.getProducts()).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  expect(readSharedTransportAudit().calls).toBe(0)
})

it.each([
  ['false', 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'],
  ['removed', 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'],
  ['schema-missing', 'PLM_MANAGED_SCHEMA_MISSING'],
  ['unavailable', 'PLM_MANAGED_BINDING_UNAVAILABLE'],
] as const)('refuses an already connected client for %s', async (mode, code) => {
  if (mode === 'removed') delete process.env.PLM_MANAGED_COMPANION_ENABLED
  else vi.stubEnv('PLM_MANAGED_COMPANION_ENABLED', 'false')
  setManagedBindingReaderForTests(async () => (
    mode === 'schema-missing' || mode === 'unavailable'
      ? { kind: mode }
      : { kind: 'bound', row: {} as never }
  ))
  const client = connectedClient()
  const fetched = vi.spyOn(globalThis, 'fetch')
  const a = attach(adapter(), client)
  ;(a as unknown as { mockMode: boolean }).mockMode = true
  await expect(a.select('/native-data')).rejects.toMatchObject({ code })
  await expect(a.insert('/native-data', { name: 'x' })).rejects.toMatchObject({ code })
  await expect(a.update('/native-data', { name: 'x' }, { id: '1' })).rejects.toMatchObject({ code })
  await expect(a.delete('/native-data', { id: '1' })).rejects.toMatchObject({ code })
  await expect(a.tableExists('/native-data')).rejects.toMatchObject({ code })
  await expect(a.download('/native-data')).rejects.toMatchObject({ code })
  await expect(a.testConnection()).rejects.toMatchObject({ code })
  await expect(a.getSchema()).rejects.toMatchObject({ code })
  await expect(a.getProducts()).rejects.toMatchObject({ code })
  await expect(a.exchangeDiscussionSession('embed')).rejects.toMatchObject({ code })
  expect(client.request).not.toHaveBeenCalled()
  expect(client.get).not.toHaveBeenCalled()
  expect(client.post).not.toHaveBeenCalled()
  expect(client.put).not.toHaveBeenCalled()
  expect(client.delete).not.toHaveBeenCalled()
  expect(client.head).not.toHaveBeenCalled()
  expect(fetched).not.toHaveBeenCalled()
  expect(readSharedTransportAudit().calls).toBe(0)
})

it('keeps a proven unbound adapter usable and closes it after the same client becomes bound', async () => {
  let bound = false
  setManagedBindingReaderForTests(async () => (
    bound ? { kind: 'bound', row: {} as never } : { kind: 'unbound' }
  ))
  const client = connectedClient()
  const a = attach(adapter(), client)
  const selected = await a.select('/native-data')
  expect(selected.data[0]).toMatchObject({ native_secret: 'sentinel' })
  expect(client.request).toHaveBeenCalledOnce()
  expect(readSharedTransportAudit().calls).toBe(1)
  ;(a as unknown as { mockMode: boolean }).mockMode = true
  const products = await a.getProducts()
  expect(products.data.map((row) => row.name)).toContain('iPhone 15 Pro')
  bound = true
  client.request.mockClear()
  resetSharedTransportAudit()
  await expect(a.select('/native-data')).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  await expect(a.getProducts()).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  await expect(a.insert('/native-data', { name: 'x' })).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  await expect(a.tableExists('/native-data')).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  expect(client.request).not.toHaveBeenCalled()
  expect(client.head).not.toHaveBeenCalled()
  expect(readSharedTransportAudit().calls).toBe(0)
  await expect(a.personalBomWriteRequest(
    'verify',
    'nope',
    'connection',
    { origin: 'https://native.invalid', tenantId: 'tenant', orgId: 'org' },
  )).rejects.not.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
})
