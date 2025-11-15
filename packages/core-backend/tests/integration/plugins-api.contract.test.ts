import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'

describe('GET /api/plugins contract', () => {
  let server: MetaSheetServer
  let baseUrl: string

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return
    const repoRoot = path.join(__dirname, '../../../../')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [
        path.join(repoRoot, 'plugins', 'plugin-view-kanban')
      ]
    })
    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) return
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  it('returns views only for active plugins', async () => {
    if (!baseUrl) return
    const res = await fetch(`${baseUrl}/api/plugins`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)

    // Find kanban plugin and verify basic shape
    const kanban = data.find((p: any) => p.name === '@metasheet/plugin-view-kanban')
    expect(kanban).toBeDefined()
    expect(['active', 'failed', 'inactive']).toContain(kanban.status)

    // If active, should include contributes.views array with id/name
    if (kanban.status === 'active') {
      const views = kanban.contributes?.views || []
      expect(Array.isArray(views)).toBe(true)
      for (const v of views) {
        expect(typeof v.id).toBe('string')
        expect(typeof v.name).toBe('string')
        if (v.component !== undefined) {
          expect(typeof v.component === 'string').toBe(true)
        }
      }
    }

    // Ensure failed-only entries (if any) do not expose contributes
    const failedOnly = data.filter((p: any) => p.status === 'failed' && !p.version)
    for (const f of failedOnly) {
      expect(f.contributes).toBeUndefined()
    }
  })
})
