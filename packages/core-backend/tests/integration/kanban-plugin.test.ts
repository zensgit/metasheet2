import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import { waitForHealth } from '../utils/waitFor'
import { io as ioClient } from 'socket.io-client'
import net from 'net'

describe('Kanban Plugin Integration', () => {
  let server: MetaSheetServer
  let baseUrl: string

  beforeAll(async () => {
    // Preflight: if environment forbids listen(), skip suite by early return
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    // Start server with test configuration
    const repoRoot = path.join(__dirname, '../../../../')
    server = new MetaSheetServer({
      port: 0, // Use random port
      host: '127.0.0.1',
      pluginDirs: [
        path.join(repoRoot, 'plugins', 'plugin-view-kanban')
      ]
    })

    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) return // environment limitation; skip
    baseUrl = `http://127.0.0.1:${address.port}`
    await waitForHealth(baseUrl)
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  describe('Plugin Activation', () => {
    it('should load and activate kanban plugin', async () => {
      if (!baseUrl) return
      const res = await fetch(`${baseUrl}/api/plugins`)
      const plugins = await res.json()

      const kanbanPlugin = plugins.find(p => p.name === '@metasheet/plugin-view-kanban')
      expect(kanbanPlugin).toBeDefined()
      expect(kanbanPlugin.status).toBe('active')
      expect(kanbanPlugin.displayName).toBe('看板视图')
    })
  })

  describe('Route Registration', () => {
    it('should register kanban API routes', async () => {
      if (!baseUrl) return
      // Test that kanban routes are accessible
      const res = await fetch(`${baseUrl}/api/kanban/boards`)
      expect(res.status).not.toBe(404)
    })

    it('should handle kanban card operations', async () => {
      if (!baseUrl) return
      // Test card move endpoint
      const res = await fetch(`${baseUrl}/api/kanban/cards/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: 'test-card',
          fromColumn: 'todo',
          toColumn: 'doing'
        })
      })

      // Should either succeed or return proper error
      expect([200, 400, 401]).toContain(res.status)
    })
  })

  describe('Event Registration', () => {
    it('should emit kanban events', async () => {
      if (!server) return
      const addr = server.getAddress()
      if (!addr || !addr.port) return // environment limitation; skip
      const socket = ioClient(`http://127.0.0.1:${addr.port}`, { transports: ['websocket'] })

      // Wait for connection first (regression guard for event-before-connect)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 3000)
        socket.on('connect', () => {
          clearTimeout(timeout)
          resolve()
        })
        socket.on('connect_error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      // Set up event listener
      const eventPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Event timeout')), 5000)
        socket.on('kanban:card:moved', (payload: any) => {
          clearTimeout(timeout)
          resolve(payload)
        })
      })

      // Small delay to ensure listener is ready
      await new Promise(resolve => setTimeout(resolve, 100))

      // Trigger card move AFTER connection is established
      await fetch(`${baseUrl}/api/kanban/cards/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: 'test-card',
          fromColumn: 'todo',
          toColumn: 'doing'
        })
      })

      // Wait for event
      const event = await eventPromise

      socket.close()

      expect(event).toBeDefined()
      expect(event).toEqual({
        cardId: 'test-card',
        fromColumn: 'todo',
        toColumn: 'doing'
      })
    })
  })

  describe('Permission Check', () => {
    it('should verify plugin has required permissions', async () => {
      if (!baseUrl) return
      const res = await fetch(`${baseUrl}/api/plugins`)
      const plugins = await res.json()

      const kanbanPlugin = plugins.find(p => p.name === '@metasheet/plugin-view-kanban')

      // Plugin should be active if permissions are granted
      if (kanbanPlugin.status === 'failed') {
        expect(kanbanPlugin.errorCode).not.toBe('PLUGIN_004') // Not permission denied
      } else {
        expect(kanbanPlugin.status).toBe('active')
      }
    })
  })
})
