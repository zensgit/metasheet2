/**
 * API Utils 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiFetch,
  authHeaders,
  clearStoredAuthState,
  getApiBase,
  getStoredAuthToken,
} from '../../src/utils/api'

describe('API Utils', () => {
  describe('getApiBase()', () => {
    const originalLocation = window.location

    beforeEach(() => {
      vi.clearAllMocks()
      vi.unstubAllEnvs()
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    })

    it('returns VITE_API_URL when provided', () => {
      vi.stubEnv('VITE_API_URL', 'https://api.example.com')
      expect(getApiBase()).toBe('https://api.example.com')
    })

    it('supports VITE_API_BASE fallback', () => {
      vi.stubEnv('VITE_API_URL', '')
      vi.stubEnv('VITE_API_BASE', 'https://api-base.example.com')
      expect(getApiBase()).toBe('https://api-base.example.com')
    })

    it('ignores loopback VITE API env on non-loopback browser origins', () => {
      vi.stubEnv('VITE_API_URL', '')
      vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:7778')
      Object.defineProperty(window, 'location', {
        value: { origin: 'http://192.168.1.222' },
        writable: true,
        configurable: true,
      })
      expect(getApiBase()).toBe('http://192.168.1.222')
    })

    it('falls back to location.origin', () => {
      vi.unstubAllEnvs()
      Object.defineProperty(window, 'location', {
        value: { origin: 'https://app.example.com' },
        writable: true,
        configurable: true,
      })
      expect(getApiBase()).toBe('https://app.example.com')
    })

    it('falls back to localhost:8900 when origin missing', () => {
      vi.unstubAllEnvs()
      Object.defineProperty(window, 'location', {
        value: undefined,
        writable: true,
        configurable: true,
      })
      expect(getApiBase()).toBe('http://localhost:8900')
    })
  })

  describe('token helpers', () => {
    beforeEach(() => {
      window.localStorage.clear()
    })

    it('prefers auth_token then falls back to jwt/devToken', () => {
      expect(getStoredAuthToken()).toBe('')

      window.localStorage.setItem('jwt', 'legacy-jwt')
      expect(getStoredAuthToken()).toBe('legacy-jwt')

      window.localStorage.setItem('devToken', 'legacy-dev-token')
      expect(getStoredAuthToken()).toBe('legacy-jwt')

      window.localStorage.setItem('auth_token', 'primary-token')
      expect(getStoredAuthToken()).toBe('primary-token')
    })

    it('clearStoredAuthState removes token and auth context keys', () => {
      window.localStorage.setItem('auth_token', 'token-a')
      window.localStorage.setItem('jwt', 'token-b')
      window.localStorage.setItem('devToken', 'token-c')
      window.localStorage.setItem('metasheet_features', '{}')
      window.localStorage.setItem('metasheet_product_mode', 'attendance')
      window.localStorage.setItem('user_permissions', '[]')
      window.localStorage.setItem('user_roles', '[]')

      clearStoredAuthState()

      expect(window.localStorage.getItem('auth_token')).toBeNull()
      expect(window.localStorage.getItem('jwt')).toBeNull()
      expect(window.localStorage.getItem('devToken')).toBeNull()
      expect(window.localStorage.getItem('metasheet_features')).toBeNull()
      expect(window.localStorage.getItem('metasheet_product_mode')).toBeNull()
      expect(window.localStorage.getItem('user_permissions')).toBeNull()
      expect(window.localStorage.getItem('user_roles')).toBeNull()
    })
  })

  describe('authHeaders()', () => {
    beforeEach(() => {
      window.localStorage.clear()
    })

    it('does not set Content-Type by default', () => {
      const headers = authHeaders()
      expect(headers).not.toHaveProperty('Content-Type')
      expect(headers).not.toHaveProperty('Authorization')
    })

    it('adds Authorization when explicit token is passed', () => {
      const headers = authHeaders('token-value')
      expect(headers.Authorization).toBe('Bearer token-value')
    })

    it('uses stored token when explicit token is not passed', () => {
      window.localStorage.setItem('auth_token', 'stored-token')
      const headers = authHeaders()
      expect(headers.Authorization).toBe('Bearer stored-token')
    })
  })

  describe('apiFetch() unauthorized handling', () => {
    const originalLocation = window.location

    beforeEach(() => {
      window.localStorage.clear()
      vi.restoreAllMocks()
      vi.stubEnv('VITE_API_URL', 'https://api.example.com')
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    })

    it('clears auth state and redirects on 401 for protected endpoints', async () => {
      const replace = vi.fn()
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/attendance',
          search: '?tab=overview',
          hash: '',
          replace,
          href: 'https://app.example.com/attendance?tab=overview',
          origin: 'https://app.example.com',
        },
        writable: true,
        configurable: true,
      })

      window.localStorage.setItem('auth_token', 'expired-token')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))

      await apiFetch('/api/attendance/records')

      expect(window.localStorage.getItem('auth_token')).toBeNull()
      expect(replace).toHaveBeenCalledTimes(1)
      expect(replace.mock.calls[0][0]).toContain('/login?redirect=')
    })

    it('redirects root-route unauthorized responses to plain /login without a redundant redirect query', async () => {
      const replace = vi.fn()
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/',
          search: '',
          hash: '',
          replace,
          href: 'https://app.example.com/',
          origin: 'https://app.example.com',
        },
        writable: true,
        configurable: true,
      })

      window.localStorage.setItem('auth_token', 'expired-token')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))

      await apiFetch('/api/attendance/records')

      expect(window.localStorage.getItem('auth_token')).toBeNull()
      expect(replace).toHaveBeenCalledWith('/login')
    })

    it('does not redirect when /api/auth/login returns 401', async () => {
      const replace = vi.fn()
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/login',
          search: '',
          hash: '',
          replace,
          href: 'https://app.example.com/login',
          origin: 'https://app.example.com',
        },
        writable: true,
        configurable: true,
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
      await apiFetch('/api/auth/login', { method: 'POST', body: '{}' })

      expect(replace).not.toHaveBeenCalled()
    })

    it('does not redirect when unauthorized redirect suppression is enabled', async () => {
      const replace = vi.fn()
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/login',
          search: '',
          hash: '',
          replace,
          href: 'https://app.example.com/login',
          origin: 'https://app.example.com',
        },
        writable: true,
        configurable: true,
      })

      window.localStorage.setItem('auth_token', 'expired-token')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))

      await apiFetch('/api/auth/me', {
        suppressUnauthorizedRedirect: true,
      })

      expect(window.localStorage.getItem('auth_token')).toBe('expired-token')
      expect(replace).not.toHaveBeenCalled()
    })
  })

  describe('apiFetch() content type handling', () => {
    beforeEach(() => {
      vi.restoreAllMocks()
      vi.stubEnv('VITE_API_URL', 'https://api.example.com')
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    })

    it('adds application/json automatically for non-FormData bodies', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      await apiFetch('/api/multitable/context', {
        method: 'POST',
        body: JSON.stringify({ hello: 'world' }),
      })

      const [, init] = fetchMock.mock.calls[0] ?? []
      expect(init?.headers).toBeInstanceOf(Headers)
      expect((init?.headers as Headers).get('Content-Type')).toBe('application/json')
    })

    it('does not inject application/json for FormData bodies', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
      const formData = new FormData()
      formData.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt')

      await apiFetch('/api/multitable/attachments', {
        method: 'POST',
        body: formData,
      })

      const [, init] = fetchMock.mock.calls[0] ?? []
      expect(init?.headers).toBeInstanceOf(Headers)
      expect((init?.headers as Headers).get('Content-Type')).toBeNull()
    })
  })
})
