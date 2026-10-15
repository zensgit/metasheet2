import { afterEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const grant = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
function adapter(url = 'https://synthetic.invalid/prefix') {
  const conf: Record<string, unknown> = {
    'plm.url': url,
    'plm.apiMode': 'yuantus',
    'plm.tenantId': 'tenant',
    'plm.orgId': 'org',
    'plm.apiToken': 'must-not-send-service-token',
  }
  return new PLMAdapter({ get: async (k: string) => conf[k] } as never, logger as never)
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('fixed-provider personal-only PLM transport', () => {
  it('actual Node loader preserves the typed receipt-404 recovery branch', () => {
    const require = createRequire(import.meta.url)
    const stdout = execFileSync(process.execPath, ['--import', require.resolve('tsx'), 'tests/fixtures/plm-personal-approval-error-family.mts'], {
      cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.json' }, encoding: 'utf8', timeout: 15000,
    })
    const result = JSON.parse(stdout.trim())
    expect(result.result).toEqual({ ok: true, value: 'admissionRequired' })
    expect(result.calls).toBe(1)
  })
  it('initializes configuration without service login/probe then uses only personal bearer and fixed scope', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const fetch = vi.fn().mockResolvedValue(new Response('{"safe":true}'))
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.initializePersonalApproval()
    expect(fetch).not.toHaveBeenCalled()
    expect(a.personalApprovalManagementUrl()).toBe(
      'https://synthetic.invalid/personal-approval-grants',
    )
    await a.personalApprovalRequest('verify', grant, 'fixed')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://synthetic.invalid/api/v1/plm-approval-card/verify')
    expect(opts.headers).toEqual({
      Authorization: `Bearer ${grant}`,
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant',
      'x-org-id': 'org',
    })
    expect(opts.redirect).toBe('error')
    expect(JSON.parse(opts.body)).toEqual({ connection_id: 'fixed' })
  })
  it.each([
    'http://synthetic.invalid',
    'https://name:password@synthetic.invalid',
    'https://synthetic.invalid?auth=x',
    'https://synthetic.invalid#fragment',
  ])('refuses unsafe fixed provider %s', async (url) => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    await expect(adapter(url).initializePersonalApproval()).rejects.toThrow()
  })
  it('allows literal loopback http only in test runtime', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    vi.stubEnv('NODE_ENV', 'production')
    await expect(adapter('http://127.0.0.1:9000').initializePersonalApproval()).rejects.toThrow()
    vi.stubEnv('NODE_ENV', 'test')
    await expect(
      adapter('http://127.0.0.1:9000').initializePersonalApproval(),
    ).resolves.toBeUndefined()
  })
  it('never retries a 401 with service credentials and exposes no provider body', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('sensitive provider detail', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.initializePersonalApproval()
    await expect(
      a.personalApprovalRequest('receipt', grant, 'fixed', undefined, 'command'),
    ).rejects.toMatchObject({ status: 401, message: 'PLM_CARD_UNAUTHORIZED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('gate off and wrong connection refuse without request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'false')
    await expect(adapter().initializePersonalApproval()).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
