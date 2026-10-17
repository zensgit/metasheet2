import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  bindPlmBomWriteGrant,
  getPlmBomWriteManagementUrl,
  listPlmBomWriteBindings,
  personalBomWriteManagementUrl,
  PlmBomWriteBindingError,
  retryPlmBomWriteRetiredRevocations,
  unbindPlmBomWriteBinding,
} from '../src/services/plm/plmBomWriteBindings'

const GRANT = `yuw_${'ab'.repeat(16)}_${'c'.repeat(43)}`
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-1',
  metaTenantId: 'tenant-1',
  dataSourceId: 'plm-ds',
  connectionId: 'conn-1',
  subjectId: 'person-1',
  targetOrigin: 'https://plm.example',
  yuantusTenantId: 'yt-1',
  yuantusOrgId: 'yo-1',
  workspaceId: null,
  scopeKind: 'workspace',
  grantId: 'abc123',
  generation: 2,
  expiresAt: '2026-12-01T00:00:00.000Z',
  bound: true,
  remoteRevokeState: 'pending',
  previousGrantRevokeState: 'unknown',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('plmBomWriteBindings', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('accepts only the live approval page with the exact bom-write hash', () => {
    expect(personalBomWriteManagementUrl('https://plm.example/personal-approval-grants#bom-write'))
      .toBe('https://plm.example/personal-approval-grants#bom-write')
    expect(personalBomWriteManagementUrl('http://synthetic.invalid/personal-approval-grants#bom-write'))
      .toBe('http://synthetic.invalid/personal-approval-grants#bom-write')
    for (const bad of [
      'https://plm.example/personal-approval-grants',
      'https://plm.example/personal-approval-grants/',
      'https://plm.example/personal-approval-grants#approve',
      'https://plm.example/personal-approval-grants#bom-write/',
      'https://plm.example/personal-approval-grants?grant=1#bom-write',
      'https://user:secret@plm.example/personal-approval-grants#bom-write',
      'https://plm.example/personal-bom-write-grants',
      'https://plm.example/personal-bom-write-grants#bom-write',
      'https://plm.example/personal-bom-write-grants/',
      'https://plm.example/personal-bom-write-grants?grant=1',
      'https://user:secret@plm.example/personal-bom-write-grants',
      'ftp://plm.example/personal-approval-grants#bom-write',
    ]) {
      expect(() => personalBomWriteManagementUrl(bad)).toThrow(PlmBomWriteBindingError)
    }
  })

  it('projects owner metadata, keeps pending revoke state, and drops secret fields by failing closed', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ ok: true, data: [{ ...ROW, label: 'visible-name' }] }))
    const rows = await listPlmBomWriteBindings()
    expect(rows).toEqual([ROW])
    expect(apiFetchMock).toHaveBeenCalledWith('/api/me/plm-bom-write-bindings', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      suppressUnauthorizedRedirect: true,
    }))

    apiFetchMock.mockResolvedValueOnce(json({ ok: true, data: [{ ...ROW, encrypted_grant: 'cipher' }] }))
    await expect(listPlmBomWriteBindings()).rejects.toBeInstanceOf(PlmBomWriteBindingError)
    apiFetchMock.mockResolvedValueOnce(json({ ok: true, data: [{ ...ROW, grantId: GRANT }] }))
    await expect(listPlmBomWriteBindings()).rejects.toBeInstanceOf(PlmBomWriteBindingError)
  })

  it('posts dataSourceId, connectionId, and grant, and refuses a missing connection before any fetch', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(json({ ok: true, data: ROW }, 201)))
    const bound = await bindPlmBomWriteGrant('plm-ds', 'personal-fixture', GRANT)
    expect(bound.grantId).toBe('abc123')
    expect(JSON.stringify(bound)).not.toContain(GRANT)
    const [url, init] = apiFetchMock.mock.calls[0] as [string, { body?: string }]
    expect(url).toBe('/api/me/plm-bom-write-bindings')
    expect(url).not.toContain(GRANT)
    expect(url).not.toContain('personal-fixture')
    const posted = JSON.parse(init.body ?? '') as Record<string, unknown>
    expect(posted).toEqual({ dataSourceId: 'plm-ds', connectionId: 'personal-fixture', grant: GRANT })
    expect(Object.keys(posted)).toEqual(['dataSourceId', 'connectionId', 'grant'])

    apiFetchMock.mockClear()
    await bindPlmBomWriteGrant('plm-ds', '连接-甲', GRANT)
    expect(JSON.parse((apiFetchMock.mock.calls[0]?.[1] as { body?: string }).body ?? '')).toEqual({
      dataSourceId: 'plm-ds',
      connectionId: '连接-甲',
      grant: GRANT,
    })

    apiFetchMock.mockClear()
    await bindPlmBomWriteGrant('plm-ds', '甲'.repeat(128), GRANT)
    expect(JSON.parse((apiFetchMock.mock.calls[0]?.[1] as { body?: string }).body ?? '').connectionId).toBe('甲'.repeat(128))

    apiFetchMock.mockClear()
    for (const connectionId of ['', '   ', 'conn\u0000', '甲'.repeat(129), '\uD800']) {
      await expect(bindPlmBomWriteGrant('plm-ds', connectionId, GRANT)).rejects.toMatchObject({
        code: 'PLM_BOM_WRITE_INVALID',
      })
    }
    await expect(bindPlmBomWriteGrant('plm-ds', 'personal-fixture', GRANT.replace('yuw_', 'yua_'))).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_INVALID',
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('asks for a source-derived management URL and does not echo error bodies', async () => {
    apiFetchMock.mockResolvedValueOnce(json({
      ok: true,
      data: { url: 'https://plm.example/personal-approval-grants#bom-write' },
    }))
    await expect(getPlmBomWriteManagementUrl('plm ds')).resolves.toBe('https://plm.example/personal-approval-grants#bom-write')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/me/plm-bom-write-bindings/management-url?dataSourceId=plm%20ds',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    for (const url of [
      'https://plm.example/personal-approval-grants',
      'https://plm.example/personal-bom-write-grants',
      'https://plm.example/personal-bom-write-grants#bom-write',
    ]) {
      apiFetchMock.mockResolvedValueOnce(json({ ok: true, data: { url } }))
      await expect(getPlmBomWriteManagementUrl('plm-ds')).rejects.toBeInstanceOf(PlmBomWriteBindingError)
    }

    apiFetchMock.mockResolvedValueOnce(json({ ok: false, error: { code: 'PLM_BOM_WRITE_FORBIDDEN', message: GRANT } }, 403))
    await expect(getPlmBomWriteManagementUrl('plm-ds')).rejects.toMatchObject({
      message: '当前账号不能使用该数据源的个人 BOM 写入授权。',
    })
  })

  it('returns unbind metadata and posts an empty retired-revoke retry', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ ok: true, data: { ...ROW, bound: false } }))
    const unbound = await unbindPlmBomWriteBinding(ROW.id)
    expect(unbound.remoteRevokeState).toBe('pending')
    expect(unbound.previousGrantRevokeState).toBe('unknown')
    apiFetchMock.mockResolvedValueOnce(json({ ok: true }))
    await retryPlmBomWriteRetiredRevocations()
    expect(apiFetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: '{}',
      cache: 'no-store',
    }))
  })
})
