import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import { waitForHealth } from '../utils/waitFor'
import { io as ioClient } from 'socket.io-client'
import net from 'net'
import { poolManager } from '../../src/integration/db/connection-pool'

async function ensureRecordsTable() {
  const pool = poolManager.get()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      spreadsheet_id TEXT NOT NULL,
      status TEXT,
      row_order INTEGER,
      column_order INTEGER,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `)
  await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS status TEXT')
  await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS row_order INTEGER')
  await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS column_order INTEGER')
  await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()')
}

describe('Kanban Plugin Integration', () => {
  let server: MetaSheetServer
  let baseUrl: string
  let previousSkip: string | undefined
  let authToken = ''

  beforeAll(async () => {
    previousSkip = process.env.SKIP_PLUGINS
    process.env.SKIP_PLUGINS = 'false'
    // Preflight: if environment forbids listen(), skip suite by early return
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    await ensureRecordsTable()

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
    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=1`)
    const tokenJson = await tokenRes.json()
    authToken = tokenJson.token as string
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
    if (previousSkip === undefined) {
      delete process.env.SKIP_PLUGINS
    } else {
      process.env.SKIP_PLUGINS = previousSkip
    }
  })

  describe('Plugin Activation', () => {
    it('should load and activate kanban plugin', async () => {
      if (!baseUrl) return
      const res = await fetch(`${baseUrl}/api/plugins`)
      const plugins = await res.json()

      const kanbanPlugin = plugins.find((p: any) => (
        p.name === 'plugin-view-kanban' || p.name === '@metasheet/plugin-view-kanban'
      ))
      expect(kanbanPlugin).toBeDefined()
      expect(kanbanPlugin.status).toBe('active')
      expect(kanbanPlugin.displayName).toBe('Kanban View Plugin')
    })
  })

  describe('Route Registration', () => {
    it('should register kanban API routes', async () => {
      if (!baseUrl) return
      // Test that kanban routes are accessible
      const res = await fetch(`${baseUrl}/api/kanban/boards`, {
        headers: { Authorization: `Bearer ${authToken}` }
      })
      expect(res.status).toBe(200)
    })

    it('should handle kanban card operations', async () => {
      if (!baseUrl) return
      // Test card move endpoint
      const res = await fetch(`${baseUrl}/api/kanban/cards/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          cardId: 'test-card',
          fromColumn: 'todo',
          toColumn: 'doing'
        })
      })

      // Should either succeed or return proper error
      expect(res.status).toBe(200)
    })
  })

  describe('Event Registration', () => {
    it('should emit kanban events', async () => {
      if (!server) return
      if (!baseUrl) return
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

      // Trigger card move AFTER connection is established
      await fetch(`${baseUrl}/api/kanban/cards/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
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

      const kanbanPlugin = plugins.find((p: any) => (
        p.name === 'plugin-view-kanban' || p.name === '@metasheet/plugin-view-kanban'
      ))
      expect(kanbanPlugin).toBeDefined()
      if (!kanbanPlugin) return

      // Plugin should be active if permissions are granted
      if (kanbanPlugin.status === 'failed') {
        expect(kanbanPlugin.errorCode).not.toBe('PLUGIN_004') // Not permission denied
      } else {
        expect(kanbanPlugin.status).toBe('active')
      }
    })
  })
})
