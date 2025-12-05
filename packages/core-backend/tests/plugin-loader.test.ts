/**
 * 插件加载器测试 - Manifest校验
 * Tests for PluginLoader manifest validation and error codes
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'
import { PluginErrorCode } from '../src/core/plugin-errors'
import { PERMISSION_WHITELIST } from '../src/types/plugin'
import type { PluginManifest } from '../src/types/plugin'

describe('PluginLoader Manifest Validation', () => {
  let pluginLoader: PluginLoader

  beforeEach(() => {
    // PluginLoader constructor accepts string path or CoreAPI (defaults to './plugins')
    pluginLoader = new PluginLoader('./test-plugins')
  })

  describe('validateManifest', () => {
    it('should throw when manifest is missing name', () => {
      const invalidManifest = {
        version: '1.0.0'
      } as PluginManifest

      expect(() => {
        (pluginLoader as any).validateManifest(invalidManifest)
      }).toThrow('Plugin manifest missing name')
    })

    it('should throw when manifest is missing version', () => {
      const invalidManifest = {
        name: 'test-plugin'
      } as PluginManifest

      expect(() => {
        (pluginLoader as any).validateManifest(invalidManifest)
      }).toThrow('Plugin manifest missing version')
    })

    it('should accept valid manifest with name and version', () => {
      const validManifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0'
      }

      expect(() => {
        (pluginLoader as any).validateManifest(validManifest)
      }).not.toThrow()
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

  describe('PluginLoader基本功能', () => {
    it('should be instantiable with string path', () => {
      const loader = new PluginLoader('./plugins')
      expect(loader).toBeDefined()
    })

    it('should return empty map for getPlugins when no plugins loaded', () => {
      const plugins = pluginLoader.getPlugins()
      expect(plugins).toBeInstanceOf(Map)
      expect(plugins.size).toBe(0)
    })

    it('should return empty array for getAll when no plugins loaded', () => {
      const plugins = pluginLoader.getAll()
      expect(Array.isArray(plugins)).toBe(true)
      expect(plugins.length).toBe(0)
    })

    it('should return undefined for get with non-existent plugin', () => {
      const plugin = pluginLoader.get('non-existent')
      expect(plugin).toBeUndefined()
    })
  })
})
