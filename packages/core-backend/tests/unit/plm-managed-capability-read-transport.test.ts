import { afterEach, expect, it, vi } from 'vitest'
import { nativeManagedContext, setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'
import type { ManagedClientRegistration } from '../../src/services/plm-managed-companion'

const registration: ManagedClientRegistration = {
  issuer: 'https://native.example/installation', clientId: 'client', clientSecret: 'installation-control-secret',
  origin: 'https://meta.example', callback: 'https://meta.example/callback',
  nativeBaseUrl: 'https://native.example', nativeTenantId: 'native-tenant', nativeOrgId: 'native-org',
}
function install(fetcher: typeof fetch) {
  vi.stubEnv('PLM_MANAGED_COMPANION_TEST_HOOKS', 'true')
  setManagedNativeFetchForTests(fetcher)
}
afterEach(() => {
  setManagedNativeFetchForTests(null)
  vi.unstubAllEnvs()
})

it('reads the existing root-scoped endpoint with only the personal read credential', async () => {
  const body = { integration_capabilities: { provider: 'yuantus-plm', advisory: true, features: {} } }
  const fetched = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
    new Response(JSON.stringify(body)))
  install(fetched)
  expect(await nativeManagedContext(registration, 'yur_synthetic-read', 'part/encoded')).toEqual(body)
  expect(fetched).toHaveBeenCalledOnce()
  const [url, options] = fetched.mock.calls[0]
  expect(url).toBe('https://native.example/api/v1/bom/multitable/part%2Fencoded/managed-context')
  expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: {
    authorization: 'Bearer yur_synthetic-read', 'x-tenant-id': 'native-tenant', 'x-org-id': 'native-org',
  } })
  expect(new Headers(options?.headers).has('cookie')).toBe(false)
  expect(JSON.stringify(options)).not.toContain(registration.clientSecret)
  expect(String(url)).not.toContain('yur_')
})

it.each(['yuw_write', 'yua_approval', 'shared-user-token', ''])('refuses non-read credential %s before transport', async credential => {
  const fetched = vi.fn(async () => new Response('{}'))
  install(fetched)
  await expect(nativeManagedContext(registration, credential, 'part')).rejects.toMatchObject({ code: 'PLM_MANAGED_CREDENTIAL_REFUSED' })
  expect(fetched).not.toHaveBeenCalled()
})

it.each([302, 401, 403, 503])('has no public or shared fallback after native read HTTP %s', async status => {
  const fetched = vi.fn(async () => new Response('{}', { status }))
  install(fetched)
  await expect(nativeManagedContext(registration, 'yur_synthetic-read', 'part')).rejects.toMatchObject({ code: 'PLM_MANAGED_READ_REFUSED' })
  expect(fetched).toHaveBeenCalledOnce()
})

it('does not fall back when the authenticated native read aborts', async () => {
  const fetched = vi.fn(async () => { throw new Error('synthetic timeout') })
  install(fetched)
  await expect(nativeManagedContext(registration, 'yur_synthetic-read', 'part')).rejects.toThrow('synthetic timeout')
  expect(fetched).toHaveBeenCalledOnce()
})
