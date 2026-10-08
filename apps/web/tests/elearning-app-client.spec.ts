import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getElearningAppInstallation, installElearningApp, parseElearningAppInstallation, updateElearningAppInstallation } from '../src/services/elearningApp'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.fetch }))
beforeEach(() => mocks.fetch.mockReset())

describe('elearning installation client', () => {
  it.each(['not-installed', 'inactive', 'active'])('accepts the closed %s response', (status) => {
    expect(parseElearningAppInstallation({ status, notificationsEnabled: false, canManage: true })).toEqual({ status, notificationsEnabled: false, canManage: true })
  })
  it.each([null, [], {}, { status: 'unknown', notificationsEnabled: false },
    { status: 'active', notificationsEnabled: false },
    { status: 'active', notificationsEnabled: false, canManage: 'true' },
    { status: 'unknown', notificationsEnabled: false, canManage: true },
    { status: 'active', notificationsEnabled: 'true', canManage: true },
    { status: 'active', notificationsEnabled: false, canManage: true, secret: 'sensitive' },
    { status: 'active', notificationsEnabled: 'true' }, { status: 'active' },
    { status: 'active', notificationsEnabled: false, secret: 'sensitive' },
    { data: { status: 'active', notificationsEnabled: false } },
  ])('rejects malformed or expanded responses', (payload) => {
    expect(() => parseElearningAppInstallation(payload)).toThrow('invalid_response')
  })
  it('uses fixed paths and closed commands without org overrides', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'inactive', notificationsEnabled: false, canManage: true })))
    await getElearningAppInstallation()
    await installElearningApp()
    await updateElearningAppInstallation(true, false)
    expect(mocks.fetch.mock.calls).toEqual([
      ['/api/elearning-app/installation', { method: 'GET' }],
      ['/api/elearning-app/installation', { method: 'POST', body: '{}' }],
      ['/api/elearning-app/installation', { method: 'PUT', body: '{"enabled":true,"notificationsEnabled":false}' }],
    ])
    expect(() => updateElearningAppInstallation('true' as unknown as boolean, false)).toThrow('invalid_input')
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })
  it('accepts a readonly response without granting management', () => {
    const payload = { status: 'active', notificationsEnabled: true, canManage: false }
    expect(parseElearningAppInstallation(payload)).toEqual(payload)
  })
  it.each([403, 409, 422, 500])('does not expose HTTP %s payloads', async (status) => {
    mocks.fetch.mockResolvedValue(new Response('sensitive', { status }))
    await expect(installElearningApp()).rejects.toThrow(/^request_failed$/)
  })
  it('sanitizes network and JSON failures', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('sensitive'))
    await expect(getElearningAppInstallation()).rejects.toThrow(/^request_failed$/)
    mocks.fetch.mockResolvedValueOnce(new Response('sensitive'))
    await expect(getElearningAppInstallation()).rejects.toThrow(/^invalid_response$/)
  })
})
