/**
 * API Utils 单元测试
 * 测试 auth headers 和 API base URL 工具函数
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getApiBase, authHeaders } from '../../src/utils/api'

describe('API Utils', () => {
  describe('getApiBase()', () => {
    const originalLocation = window.location

    beforeEach(() => {
      // 重置环境
      vi.clearAllMocks()
      vi.unstubAllEnvs()
    })

    afterEach(() => {
      // 恢复环境
      vi.unstubAllEnvs()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true
      })
    })

    it('应返回环境变量配置的 API URL', () => {
      // 使用 Vitest 的 stubEnv 模拟环境变量
      vi.stubEnv('VITE_API_URL', 'https://api.example.com')

      const result = getApiBase()
      expect(result).toBe('https://api.example.com')
    })

    it('应在没有环境变量时返回 window.location.origin', () => {
      // 确保没有 VITE_API_URL 环境变量
      vi.unstubAllEnvs()

      // 模拟 window.location.origin
      Object.defineProperty(window, 'location', {
        value: { origin: 'https://app.example.com' },
        writable: true,
        configurable: true
      })

      const result = getApiBase()
      expect(result).toBe('https://app.example.com')
    })

    it('应在所有环境都不可用时返回默认的 localhost:8900', () => {
      // 确保没有 VITE_API_URL 环境变量
      vi.unstubAllEnvs()

      // 模拟 window.location 不可用
      Object.defineProperty(window, 'location', {
        value: undefined,
        writable: true,
        configurable: true
      })

      const result = getApiBase()
      expect(result).toBe('http://localhost:8900')
    })

    it('应过滤空字符串环境变量', () => {
      // 模拟空字符串环境变量
      vi.stubEnv('VITE_API_URL', '')

      Object.defineProperty(window, 'location', {
        value: { origin: 'https://app.example.com' },
        writable: true,
        configurable: true
      })

      const result = getApiBase()
      expect(result).toBe('https://app.example.com')
    })

    it('应处理不同的 URL 格式', () => {
      const testCases = [
        'http://localhost:3000',
        'https://api.production.com',
        'https://staging.api.example.com:8080'
      ]

      testCases.forEach(url => {
        vi.stubEnv('VITE_API_URL', url)
        const result = getApiBase()
        expect(result).toBe(url)
        vi.unstubAllEnvs()
      })
    })
  })

  describe('authHeaders()', () => {
    it('应返回包含 Content-Type 的基础 headers', () => {
      const headers = authHeaders()

      expect(headers).toHaveProperty('Content-Type')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('应在提供 token 时添加 Authorization header', () => {
      const token = 'test-jwt-token-12345'
      const headers = authHeaders(token)

      expect(headers).toHaveProperty('Authorization')
      expect(headers.Authorization).toBe(`Bearer ${token}`)
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('应在没有 token 时不添加 Authorization header', () => {
      const headers = authHeaders()

      expect(headers).not.toHaveProperty('Authorization')
      expect(Object.keys(headers)).toHaveLength(1)
    })

    it('应处理空字符串 token', () => {
      const headers = authHeaders('')

      expect(headers).not.toHaveProperty('Authorization')
      expect(Object.keys(headers)).toHaveLength(1)
    })

    it('应处理 undefined token', () => {
      const headers = authHeaders(undefined)

      expect(headers).not.toHaveProperty('Authorization')
      expect(Object.keys(headers)).toHaveLength(1)
    })

    it('应正确格式化不同长度的 token', () => {
      const testTokens = [
        'short',
        'medium-length-token',
        'very-long-jwt-token-with-many-characters-1234567890abcdef'
      ]

      testTokens.forEach(token => {
        const headers = authHeaders(token)
        expect(headers.Authorization).toBe(`Bearer ${token}`)
      })
    })

    it('应返回不可变的 headers 对象结构', () => {
      const headers1 = authHeaders('token1')
      const headers2 = authHeaders('token2')

      // 修改 headers1 不应影响 headers2
      headers1.Authorization = 'Modified'
      expect(headers2.Authorization).toBe('Bearer token2')
    })
  })

  describe('Integration - 完整API调用场景', () => {
    it('应支持 GET 请求场景', () => {
      const apiBase = getApiBase()
      const headers = authHeaders('user-token')

      expect(typeof apiBase).toBe('string')
      expect(apiBase.length).toBeGreaterThan(0)
      expect(headers).toMatchObject({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer user-token'
      })
    })

    it('应支持 POST 请求场景', () => {
      const apiBase = getApiBase()
      const token = 'admin-token-xyz'
      const headers = authHeaders(token)

      // 模拟 POST 请求构造
      const requestConfig = {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: 'test' })
      }

      expect(requestConfig.headers).toHaveProperty('Authorization')
      expect(requestConfig.headers).toHaveProperty('Content-Type')
    })

    it('应支持无认证的公开 API 调用', () => {
      const apiBase = getApiBase()
      const headers = authHeaders()

      const requestConfig = {
        method: 'GET',
        headers
      }

      expect(requestConfig.headers).not.toHaveProperty('Authorization')
      expect(requestConfig.headers['Content-Type']).toBe('application/json')
    })
  })

  describe('Edge Cases - 边界情况处理', () => {
    it('应处理包含 / 结尾的 API base URL', () => {
      vi.stubEnv('VITE_API_URL', 'https://api.example.com/')

      const apiBase = getApiBase()
      // 注意：当前实现不处理尾部斜杠，这是已知行为
      expect(apiBase).toBe('https://api.example.com/')
    })

    it('应处理包含特殊字符的 token', () => {
      const specialTokens = [
        'token.with.dots',
        'token-with-dashes',
        'token_with_underscores',
        'tokenWith123Numbers'
      ]

      specialTokens.forEach(token => {
        const headers = authHeaders(token)
        expect(headers.Authorization).toBe(`Bearer ${token}`)
      })
    })

    it('应处理非常长的环境变量 URL', () => {
      const longUrl = 'https://very-long-subdomain-name.example.com/api/v1/endpoint'
      vi.stubEnv('VITE_API_URL', longUrl)

      const result = getApiBase()
      expect(result).toBe(longUrl)
    })
  })

  describe('Type Safety - 类型安全性', () => {
    it('getApiBase() 应始终返回字符串', () => {
      const result = getApiBase()
      expect(typeof result).toBe('string')
    })

    it('authHeaders() 应始终返回对象', () => {
      const headers1 = authHeaders()
      const headers2 = authHeaders('token')

      expect(typeof headers1).toBe('object')
      expect(typeof headers2).toBe('object')
      expect(headers1).not.toBeNull()
      expect(headers2).not.toBeNull()
    })

    it('authHeaders() 返回的对象应具有正确的键类型', () => {
      const headers = authHeaders('token')

      Object.keys(headers).forEach(key => {
        expect(typeof key).toBe('string')
        expect(typeof headers[key]).toBe('string')
      })
    })
  })
})
