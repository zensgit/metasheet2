/**
 * 权限组测试
 */

import { describe, it, expect } from 'vitest'
import { PERMISSION_WHITELIST, PERMISSION_GROUPS } from '../src/types/plugin'
import type { PluginManifest } from '../src/types/plugin'

describe('权限组定义测试', () => {
  const whitelist = new Set(PERMISSION_WHITELIST as readonly string[])

  describe('权限组基础验证', () => {
    it('应定义4个权限组', () => {
      expect(Object.keys(PERMISSION_GROUPS)).toHaveLength(4)
      expect(PERMISSION_GROUPS).toHaveProperty('readonly')
      expect(PERMISSION_GROUPS).toHaveProperty('basic')
      expect(PERMISSION_GROUPS).toHaveProperty('standard')
      expect(PERMISSION_GROUPS).toHaveProperty('advanced')
    })

    it('每个权限组应有权限', () => {
      for (const [groupName, perms] of Object.entries(PERMISSION_GROUPS)) {
        expect(perms.length).toBeGreaterThan(0)
      }
    })
  })

  describe('权限组白名单验证', () => {
    it('所有权限组的权限都应在白名单中', () => {
      for (const [groupName, perms] of Object.entries(PERMISSION_GROUPS)) {
        for (const perm of perms as readonly string[]) {
          expect(whitelist.has(perm), `权限 ${perm} 在组 ${groupName} 中但不在白名单`).toBe(true)
        }
      }
    })

    it('readonly组应只包含只读权限', () => {
      for (const perm of PERMISSION_GROUPS.readonly) {
        expect(perm).toMatch(/\.(read)$/)
      }
    })

    it('basic组应包含基础功能权限', () => {
      expect(PERMISSION_GROUPS.basic).toContain('database.read')
      expect(PERMISSION_GROUPS.basic).toContain('file.read')
      expect(PERMISSION_GROUPS.basic).toContain('events.emit')
    })

    it('standard组应包含标准业务权限', () => {
      expect(PERMISSION_GROUPS.standard).toContain('database.read')
      expect(PERMISSION_GROUPS.standard).toContain('database.write')
      expect(PERMISSION_GROUPS.standard).toContain('http.addRoute')
      expect(PERMISSION_GROUPS.standard).toContain('websocket.broadcast')
    })

    it('advanced组应包含高级权限', () => {
      const advPerms = PERMISSION_GROUPS.advanced as readonly string[]
      expect(advPerms).toContain('database.*')
      expect(advPerms).toContain('http.request')
      expect(advPerms).toContain('notification.send')
    })
  })

  describe('权限组层级关系', () => {
    it('basic组应包含readonly组的所有权限', () => {
      for (const perm of PERMISSION_GROUPS.readonly) {
        expect(PERMISSION_GROUPS.basic).toContain(perm)
      }
    })

    it('standard组应包含更多权限', () => {
      expect(PERMISSION_GROUPS.standard.length).toBeGreaterThan(PERMISSION_GROUPS.basic.length)
    })

    it('advanced组应包含最多权限', () => {
      expect(PERMISSION_GROUPS.advanced.length).toBeGreaterThan(PERMISSION_GROUPS.standard.length)
    })
  })

  describe('权限组使用场景', () => {
    it('readonly组适用于分析插件', () => {
      const manifest: Partial<PluginManifest> = {
        name: 'analytics-plugin',
        permissions: [...PERMISSION_GROUPS.readonly]
      }

      // 验证只有读权限
      for (const perm of manifest.permissions!) {
        expect(perm).not.toContain('write')
        expect(perm).not.toContain('delete')
      }
    })

    it('basic组适用于工具插件', () => {
      const manifest: Partial<PluginManifest> = {
        name: 'tool-plugin',
        permissions: [...PERMISSION_GROUPS.basic]
      }

      // 验证有基础权限
      expect(manifest.permissions).toContain('database.read')
      expect(manifest.permissions).toContain('events.emit')
    })

    it('standard组适用于业务插件', () => {
      const manifest: Partial<PluginManifest> = {
        name: 'business-plugin',
        permissions: [...PERMISSION_GROUPS.standard]
      }

      // 验证有业务权限
      expect(manifest.permissions).toContain('database.write')
      expect(manifest.permissions).toContain('queue.push')
    })

    it('advanced组适用于管理插件', () => {
      const manifest: Partial<PluginManifest> = {
        name: 'admin-plugin',
        permissions: [...PERMISSION_GROUPS.advanced]
      }

      // 验证有高级权限
      expect(manifest.permissions).toContain('database.*')
      expect(manifest.permissions!.length).toBeGreaterThan(10)
    })
  })
})
