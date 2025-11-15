/**
 * 权限系统测试 - 验证扩展的白名单和权限组
 */

import { describe, it, expect } from 'vitest'
import { PERMISSION_WHITELIST, PERMISSION_GROUPS } from '../src/types/plugin'
import type { PluginManifest } from '../src/types/plugin'

describe('权限白名单扩展测试', () => {
  describe('权限白名单完整性', () => {
    it('应包含所有基础权限类别', () => {
      // 验证各类权限都存在
      const categories = [
        'database', 'http', 'websocket', 'events',
        'storage', 'cache', 'queue', 'auth', 'notification', 'metrics'
      ]

      for (const category of categories) {
        const hasCategory = (PERMISSION_WHITELIST as readonly string[]).some(p => p.startsWith(category + '.'))
        expect(hasCategory, `Should have ${category} permissions`).toBe(true)
      }
    })

    it('应包含新增的细粒度权限', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      // 验证新增权限
      expect(whitelist).toContain('database.transaction')
      expect(whitelist).toContain('http.removeRoute')
      expect(whitelist).toContain('http.middleware')
      expect(whitelist).toContain('websocket.send')
      expect(whitelist).toContain('websocket.listen')
      expect(whitelist).toContain('events.listen')
      expect(whitelist).toContain('storage.read')
      expect(whitelist).toContain('storage.list')
      expect(whitelist).toContain('cache.delete')
      expect(whitelist).toContain('queue.process')
      expect(whitelist).toContain('auth.verify')
      expect(whitelist).toContain('auth.checkPermission')
      expect(whitelist).toContain('notification.email')
      expect(whitelist).toContain('notification.webhook')
      expect(whitelist).toContain('metrics.read')
      expect(whitelist).toContain('metrics.write')
    })

    it('权限数量应该大于原始24个', () => {
      expect(PERMISSION_WHITELIST.length).toBeGreaterThan(24)
      // 预期约40个权限（包含向后兼容的file.*）
      expect(PERMISSION_WHITELIST.length).toBeGreaterThanOrEqual(37)
    })

    it('应包含向后兼容的file.*权限', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      // 验证向后兼容权限仍存在
      expect(whitelist).toContain('file.read')
      expect(whitelist).toContain('file.write')
      expect(whitelist).toContain('file.delete')
    })
  })

  describe('权限组测试', () => {
    it('应定义4个权限组', () => {
      expect(Object.keys(PERMISSION_GROUPS)).toHaveLength(4)
      expect(PERMISSION_GROUPS).toHaveProperty('readonly')
      expect(PERMISSION_GROUPS).toHaveProperty('basic')
      expect(PERMISSION_GROUPS).toHaveProperty('standard')
      expect(PERMISSION_GROUPS).toHaveProperty('advanced')
    })

    it('readonly组应只包含只读权限', () => {
      const readonlyPerms = PERMISSION_GROUPS.readonly as readonly string[]
      for (const perm of readonlyPerms) {
        expect(perm).toMatch(/\.(read|verify)$/)
      }
    })

    it('readonly组应包含新增的auth和metrics权限', () => {
      const readonlyPerms = PERMISSION_GROUPS.readonly as readonly string[]
      expect(readonlyPerms).toContain('auth.verify')
      expect(readonlyPerms).toContain('metrics.read')
    })

    it('basic组应包含基础功能权限', () => {
      const basicPerms = PERMISSION_GROUPS.basic as readonly string[]
      expect(basicPerms).toContain('database.read')
      expect(basicPerms).toContain('http.addRoute')
      expect(basicPerms).toContain('events.emit')
      expect(basicPerms).toContain('cache.read')
      expect(basicPerms).toContain('cache.write')
    })

    it('standard组应包含标准功能权限', () => {
      const standardPerms = PERMISSION_GROUPS.standard as readonly string[]
      expect(standardPerms).toContain('database.read')
      expect(standardPerms).toContain('database.write')
      expect(standardPerms).toContain('storage.read')
      expect(standardPerms).toContain('storage.write')
      expect(standardPerms).toContain('queue.push')
      expect(standardPerms).toContain('auth.verify')
    })

    it('advanced组应包含高级功能和通配符权限', () => {
      const advancedPerms = PERMISSION_GROUPS.advanced as readonly string[]
      expect(advancedPerms).toContain('database.*')
      expect(advancedPerms).toContain('http.request')
      expect(advancedPerms).toContain('websocket.broadcast')
      expect(advancedPerms).toContain('websocket.send')
      expect(advancedPerms).toContain('notification.send')
      expect(advancedPerms).toContain('notification.email')
      expect(advancedPerms).toContain('metrics.read')
      expect(advancedPerms).toContain('metrics.write')
    })

    it('所有权限组的权限都应在白名单中', () => {
      const whitelist = new Set(PERMISSION_WHITELIST as readonly string[])
      const allGroupPerms = [
        ...PERMISSION_GROUPS.readonly,
        ...PERMISSION_GROUPS.basic,
        ...PERMISSION_GROUPS.standard,
        ...PERMISSION_GROUPS.advanced
      ]

      for (const perm of allGroupPerms) {
        expect(whitelist.has(perm), `Permission ${perm} should be in whitelist`).toBe(true)
      }
    })

    it('权限组应有层级关系', () => {
      expect(PERMISSION_GROUPS.basic.length).toBeGreaterThan(PERMISSION_GROUPS.readonly.length)
      expect(PERMISSION_GROUPS.standard.length).toBeGreaterThan(PERMISSION_GROUPS.basic.length)
      expect(PERMISSION_GROUPS.advanced.length).toBeGreaterThan(PERMISSION_GROUPS.standard.length)
    })
  })

  describe('通配符权限测试', () => {
    it('应支持通配符权限', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      expect(whitelist).toContain('database.*')
    })

    it('通配符权限应只在高级组中使用', () => {
      const advancedPerms = PERMISSION_GROUPS.advanced as readonly string[]
      expect(advancedPerms).toContain('database.*')

      const standardPerms = PERMISSION_GROUPS.standard as readonly string[]
      expect(standardPerms).not.toContain('database.*')
      expect(standardPerms).not.toContain('storage.*')
    })
  })

  describe('新权限类别完整性', () => {
    it('auth权限类别应完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const authPerms = whitelist.filter(p => p.startsWith('auth.'))
      expect(authPerms).toContain('auth.verify')
      expect(authPerms).toContain('auth.checkPermission')
      expect(authPerms.length).toBeGreaterThanOrEqual(2)
    })

    it('metrics权限类别应完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const metricsPerms = whitelist.filter(p => p.startsWith('metrics.'))
      expect(metricsPerms).toContain('metrics.read')
      expect(metricsPerms).toContain('metrics.write')
      expect(metricsPerms.length).toBe(2)
    })

    it('storage权限类别应完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const storagePerms = whitelist.filter(p => p.startsWith('storage.'))
      expect(storagePerms).toContain('storage.read')
      expect(storagePerms).toContain('storage.write')
      expect(storagePerms).toContain('storage.delete')
      expect(storagePerms).toContain('storage.list')
      expect(storagePerms.length).toBe(4)
    })

    it('notification权限类别应完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const notificationPerms = whitelist.filter(p => p.startsWith('notification.'))
      expect(notificationPerms).toContain('notification.send')
      expect(notificationPerms).toContain('notification.email')
      expect(notificationPerms).toContain('notification.webhook')
      expect(notificationPerms.length).toBe(3)
    })

    it('http权限类别应扩展完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const httpPerms = whitelist.filter(p => p.startsWith('http.'))
      expect(httpPerms).toContain('http.addRoute')
      expect(httpPerms).toContain('http.removeRoute')
      expect(httpPerms).toContain('http.request')
      expect(httpPerms).toContain('http.middleware')
      expect(httpPerms.length).toBe(4)
    })

    it('websocket权限类别应扩展完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const wsPerms = whitelist.filter(p => p.startsWith('websocket.'))
      expect(wsPerms).toContain('websocket.broadcast')
      expect(wsPerms).toContain('websocket.send')
      expect(wsPerms).toContain('websocket.listen')
      expect(wsPerms.length).toBe(3)
    })

    it('events权限类别应扩展完整', () => {
      const whitelist = PERMISSION_WHITELIST as readonly string[]
      const eventsPerms = whitelist.filter(p => p.startsWith('events.'))
      expect(eventsPerms).toContain('events.emit')
      expect(eventsPerms).toContain('events.listen')
      expect(eventsPerms).toContain('events.on')
      expect(eventsPerms).toContain('events.once')
      expect(eventsPerms).toContain('events.off')
      expect(eventsPerms.length).toBe(5)
    })
  })
})

describe('权限使用场景测试', () => {
  it('只读分析插件场景', () => {
    const readonlyManifest: Partial<PluginManifest> = {
      name: 'analytics-plugin',
      permissions: [...PERMISSION_GROUPS.readonly]
    }

    // 验证只有读权限
    for (const perm of readonlyManifest.permissions!) {
      expect(perm).not.toContain('write')
      expect(perm).not.toContain('delete')
      expect(perm).not.toContain('remove')
    }
  })

  it('文件管理插件场景', () => {
    const fileManifest: Partial<PluginManifest> = {
      name: 'file-manager',
      permissions: [
        'storage.read',
        'storage.write',
        'storage.delete',
        'storage.list',
        'http.addRoute'
      ]
    }

    // 验证所有权限都在白名单中
    const whitelist = new Set(PERMISSION_WHITELIST as readonly string[])
    for (const perm of fileManifest.permissions!) {
      expect(whitelist.has(perm)).toBe(true)
    }
  })

  it('通知集成插件场景', () => {
    const notificationManifest: Partial<PluginManifest> = {
      name: 'notification-hub',
      permissions: [
        'notification.send',
        'notification.email',
        'notification.webhook',
        'queue.push',
        'events.listen'
      ]
    }

    // 验证所有权限都在白名单中
    const whitelist = new Set(PERMISSION_WHITELIST as readonly string[])
    for (const perm of notificationManifest.permissions!) {
      expect(whitelist.has(perm)).toBe(true)
    }
  })

  it('实时协作插件场景', () => {
    const realtimeManifest: Partial<PluginManifest> = {
      name: 'realtime-collab',
      permissions: [
        'websocket.broadcast',
        'websocket.send',
        'websocket.listen',
        'database.read',
        'database.write',
        'cache.write'
      ]
    }

    // 验证所有权限都在白名单中
    const whitelist = new Set(PERMISSION_WHITELIST as readonly string[])
    for (const perm of realtimeManifest.permissions!) {
      expect(whitelist.has(perm)).toBe(true)
    }
  })

  it('系统管理插件场景', () => {
    const adminManifest: Partial<PluginManifest> = {
      name: 'admin-plugin',
      permissions: [...PERMISSION_GROUPS.advanced]
    }

    // 验证包含高级权限
    expect(adminManifest.permissions).toContain('database.*')
    expect(adminManifest.permissions).toContain('metrics.write')
    expect(adminManifest.permissions!.length).toBeGreaterThan(20)
  })
})
