/**
 * 插件加载器测试 - PR#2 Manifest校验增强
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'
import { PluginErrorCode } from '../src/core/plugin-errors'
import { PERMISSION_WHITELIST } from '../src/types/plugin'
import type { PluginManifest, CoreAPI } from '../src/types/plugin'

// Mock CoreAPI
const createMockCoreAPI = (): CoreAPI => ({
  http: {
    addRoute: vi.fn(),
    removeRoute: vi.fn(),
    middleware: vi.fn()
  },
  database: {
    query: vi.fn(),
    transaction: vi.fn(),
    model: vi.fn()
  },
  auth: {
    verifyToken: vi.fn(),
    checkPermission: vi.fn(),
    createToken: vi.fn()
  },
  events: {
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    off: vi.fn()
  },
  storage: {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    getUrl: vi.fn()
  },
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn()
  },
  queue: {
    push: vi.fn(),
    process: vi.fn(),
    cancel: vi.fn()
  },
  websocket: {
    broadcast: vi.fn(),
    sendTo: vi.fn(),
    onConnection: vi.fn()
  }
})

describe('PluginLoader Manifest Validation', () => {
  let pluginLoader: PluginLoader
  let mockCoreAPI: CoreAPI

  beforeEach(() => {
    mockCoreAPI = createMockCoreAPI()
    pluginLoader = new PluginLoader(mockCoreAPI)
  })

  describe('validateManifest', () => {
    it('应该拒绝缺少必填字段的manifest并记录PLUGIN_002', () => {
      const invalidManifest = {
        // 缺少 name 和 version
        displayName: 'Test Plugin'
      } as any

      // 使用反射访问私有方法进行测试
      const result = (pluginLoader as any).validateManifest(invalidManifest)
      expect(result).toBe(false)
    })

    it('应该接受有效的manifest', () => {
      // ManifestValidator requires many fields - provide them all
      const validManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        manifestVersion: '1.0.0',
        displayName: 'Test Plugin',
        description: 'A test plugin',
        author: 'Test Author',
        engine: '^1.0.0',
        main: { backend: 'dist/index.js' },
        capabilities: ['custom-views'],
        permissions: {
          database: { read: ['*'] }
        }
      }

      const result = (pluginLoader as any).validateManifest(validManifest)
      expect(result).toBe(true)
    })

    it('应该拒绝版本不匹配的manifest (PLUGIN_003)', () => {
      const manifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        engines: {
          metasheet: '>=99.0.0' // 不可能满足的版本
        }
      }

      const result = (pluginLoader as any).validateManifest(manifest)
      expect(result).toBe(false)
    })
  })

  describe('checkPermissions', () => {
    it('应该接受白名单内的权限', () => {
      // checkPermissions uses internal hardcoded list: http.addRoute, websocket.broadcast, database.query,
      // events.on, events.emit, storage.upload, storage.download, storage.delete, queue.push, queue.process,
      // messaging.publish, messaging.subscribe, messaging.request
      const manifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        permissions: ['database.query', 'http.addRoute'] as any // Use permissions from internal list
      }

      expect(() => {
        (pluginLoader as any).checkPermissions(manifest)
      }).not.toThrow()
    })

    it('应该拒绝非法权限', () => {
      const manifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        permissions: ['system.shutdown', 'admin.deleteAll'] as any // 非法权限
      }

      expect(() => {
        (pluginLoader as any).checkPermissions(manifest)
      }).toThrow(/Permission not allowed/)
    })
  })

  describe('错误码定义', () => {
    it('PLUGIN_002 应该对应 INVALID_MANIFEST', () => {
      expect(PluginErrorCode.INVALID_MANIFEST).toBe('PLUGIN_002')
    })

    it('PLUGIN_003 应该对应 VERSION_MISMATCH', () => {
      expect(PluginErrorCode.VERSION_MISMATCH).toBe('PLUGIN_003')
    })

    it('PLUGIN_004 应该对应 PERMISSION_DENIED', () => {
      expect(PluginErrorCode.PERMISSION_DENIED).toBe('PLUGIN_004')
    })
  })

  describe('权限白名单', () => {
    it('权限白名单应该被正确导出', () => {
      expect(Array.isArray(PERMISSION_WHITELIST)).toBe(true)
      expect(PERMISSION_WHITELIST.length).toBeGreaterThan(0)
    })

    it('权限白名单应包含核心权限', () => {
      expect(PERMISSION_WHITELIST).toContain('database.read')
      expect(PERMISSION_WHITELIST).toContain('database.write')
      expect(PERMISSION_WHITELIST).toContain('http.addRoute')
      expect(PERMISSION_WHITELIST).toContain('websocket.broadcast')
    })
  })
})
