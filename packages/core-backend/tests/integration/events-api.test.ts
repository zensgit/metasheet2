import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { Migrator, FileMigrationProvider } from 'kysely'
import { db } from '../../src/db/db'
import * as path from 'path'
import * as fs from 'fs/promises'
import net from 'net'
import http from 'http'

type HttpResponse = { status: number; body?: unknown; raw: string }

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      }
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

async function migrateTestDb(): Promise<void> {
  const provider = new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(__dirname, '../../src/db/migrations'),
  })

  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        const migrations = await provider.getMigrations()
        return Object.fromEntries(
          Object.entries(migrations).filter(([name]) => !name.startsWith('_'))
        )
      },
    },
  })

  const { error } = await migrator.migrateToLatest()
  if (error) {
    throw error
  }
}

describe('Event bus API integration', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const socket = net.createServer()
      socket.once('error', () => resolve(false))
      socket.listen(0, '127.0.0.1', () => socket.close(() => resolve(true)))
    })
    if (!canListen) return

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    process.env.DATABASE_URL = dbUrl
    process.env.SKIP_PLUGINS = 'true'
    await migrateTestDb()

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
    })
    await server.start()
    const address = server.getAddress()
    if (address?.port) {
      baseUrl = `http://127.0.0.1:${address.port}`
    }
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  it('keeps /api/events query and delivery logging operational after schema alignment', async () => {
    if (!baseUrl) return

    const receivedBodies: string[] = []
    const webhookServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        receivedBodies.push(body)
        res.statusCode = 200
        res.end('ok')
      })
    })

    const webhookPort: number = await new Promise((resolve, reject) => {
      webhookServer.once('error', reject)
      webhookServer.listen(0, '127.0.0.1', () => {
        const address = webhookServer.address()
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind webhook server'))
          return
        }
        resolve(address.port)
      })
    })

    let subscriptionId = ''

    try {
      const subscribeRes = await requestJson(`${baseUrl}/api/events/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscriberId: 'integration-webhook',
          eventPattern: 'integration.event',
          webhookUrl: `http://127.0.0.1:${webhookPort}/hook`,
        }),
      })
      expect(subscribeRes.status).toBe(200)
      expect((subscribeRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
      subscriptionId = (subscribeRes.body as { data?: { subscriptionId?: string } } | undefined)?.data?.subscriptionId || ''
      expect(subscriptionId).toBeTruthy()

      const emitRes = await requestJson(`${baseUrl}/api/events/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventName: 'integration.event',
          payload: { source: 'events-api-test' },
        }),
      })
      expect(emitRes.status).toBe(200)
      expect((emitRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 150))
      expect(receivedBodies.length).toBe(1)

      const listRes = await requestJson(`${baseUrl}/api/events?limit=10`)
      expect(listRes.status).toBe(200)
      expect((listRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
      const events = (listRes.body as { data?: { events?: unknown[] } } | undefined)?.data?.events
      expect(Array.isArray(events)).toBe(true)
    } finally {
      if (subscriptionId) {
        await requestJson(`${baseUrl}/api/events/subscribe/${subscriptionId}`, { method: 'DELETE' })
      }
      await new Promise(resolve => webhookServer.close(resolve))
    }
  })
})
