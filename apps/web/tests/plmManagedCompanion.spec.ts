import { describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { startManagedLogin, unlinkManagedSource } from '../src/services/plm/plmManagedCompanion'

function response(text: string, ok = true): Response {
  return { ok, text: async () => text } as Response
}

describe('managed companion client', () => {
  it('refuses a payload that carries a native credential and sends cookies', async () => {
    fetchMock.mockResolvedValueOnce(response('{"ok":true,"navigationUrl":"https://native.example.test/managed-login?code_verifier=abc"}'))
    await expect(startManagedLogin('source-1', 'part')).rejects.toThrow('托管登录')
    fetchMock.mockResolvedValueOnce(response('{"ok":true,"credential":"yur_secret"}'))
    await expect(unlinkManagedSource('source-1')).rejects.toThrow('托管登录响应被拒绝')
    fetchMock.mockResolvedValueOnce(response('{"ok":true,"navigationUrl":"https://native.example.test/managed-login?client_id=managed-fixture"}'))
    await expect(startManagedLogin('source-1', 'part')).resolves.toEqual({
      navigationUrl: 'https://native.example.test/managed-login?client_id=managed-fixture',
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/plm/managed-login/start', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
  })
})
