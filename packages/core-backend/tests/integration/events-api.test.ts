import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import * as path from 'path'
import net from 'net'
import http from 'http'
import type { Database } from '../../src/db/types'

type HttpResponse = { status: number; body?: unknown; raw: string }
type TestServer = {
  start: () => Promise<void>
  stop?: () => Promise<void>
  getAddress: () => { port?: number } | null
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const migrationLoaders = import.meta.glob('../../src/db/migrations/*.ts')

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

function createTestDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  })
}

function createIsolatedSchemaName(): string {
  return `events_api_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function withSearchPath(connectionString: string, schemaName: string): string {
  const url = new URL(connectionString)
  const existingOptions = url.searchParams.get('options')
  const schemaOption = `-c search_path=${schemaName}`
  url.searchParams.set('options', existingOptions ? `${existingOptions} ${schemaOption}` : schemaOption)
  return url.toString()
}

async function createSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  } finally {
    await adminPool.end()
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  } finally {
    await adminPool.end()
  }
}

async function migrateTestDb(testDb: Kysely<Database>, schemaName: string): Promise<void> {
  const migrator = new Migrator({
    db: testDb,
    migrationTableSchema: schemaName,
    migrationLockTableSchema: schemaName,
    provider: {
      async getMigrations() {
        const migrations = await Promise.all(
          Object.entries(migrationLoaders).map(async ([filePath, load]) => {
            const migration = await load()
            return [path.basename(filePath, '.ts'), migration] as const
          })
        )
        return Object.fromEntries(
          migrations
            .filter(([name]) => !name.startsWith('_'))
            .sort(([left], [right]) => left.localeCompare(right))
        )
      },
    },
  })

  const { error } = await migrator.migrateToLatest()
  if (error) {
    throw error
  }
}

async function waitForReceivedBodies(receivedBodies: string[]): Promise<void> {
  const deadline = Date.now() + 5000
  while (receivedBodies.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(receivedBodies.length).toBe(1)
}

const describeWithDb = dbUrl ? describe : describe.skip

describeWithDb('Event bus API integration', () => {
  let server: TestServer | undefined
  let testDb: Kysely<Database> | undefined
  let schemaName = ''
  let baseUrl = ''

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const socket = net.createServer()
      socket.once('error', () => resolve(false))
      socket.listen(0, '127.0.0.1', () => socket.close(() => resolve(true)))
    })
    if (!canListen) return

    schemaName = createIsolatedSchemaName()
    await createSchema(dbUrl as string, schemaName)

    const isolatedDbUrl = withSearchPath(dbUrl as string, schemaName)
    process.env.DATABASE_URL = isolatedDbUrl
    process.env.SKIP_PLUGINS = 'true'
    testDb = createTestDb(isolatedDbUrl)
    await migrateTestDb(testDb, schemaName)

    const { MetaSheetServer } = await import('../../src/index')
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
    if (testDb) {
      await testDb.destroy()
    }
    if (schemaName) {
      await dropSchema(dbUrl as string, schemaName)
    }
  })

  it('keeps /api/events query and delivery logging operational after schema alignment', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=events-admin&roles=admin&perms=admin`)
    expect(tokenRes.status).toBe(200)
    const authToken = (tokenRes.body as { token?: string } | undefined)?.token
    expect(authToken).toBeTruthy()

    const authHeaders = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    }

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
        headers: authHeaders,
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
        headers: authHeaders,
        body: JSON.stringify({
          eventName: 'integration.event',
          payload: { source: 'events-api-test' },
        }),
      })
      expect(emitRes.status).toBe(200)
      expect((emitRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
      const eventId = (emitRes.body as { data?: { eventId?: string } } | undefined)?.data?.eventId || ''
      expect(eventId).toBeTruthy()

      await waitForReceivedBodies(receivedBodies)

      const listRes = await requestJson(`${baseUrl}/api/events?limit=10`, {
        headers: authHeaders,
      })
      expect(listRes.status).toBe(200)
      expect((listRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
      const events = (listRes.body as { data?: { events?: unknown[] } } | undefined)?.data?.events
      expect(Array.isArray(events)).toBe(true)

      const replayRes = await requestJson(`${baseUrl}/api/events/replay`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          criteria: {
            event_ids: [eventId],
          },
          reason: 'integration coverage',
        }),
      })
      expect(replayRes.status).toBe(200)
      expect((replayRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
      const replayId = (replayRes.body as { data?: { replayId?: string } } | undefined)?.data?.replayId || ''
      expect(replayId).toBeTruthy()
    } finally {
      if (subscriptionId) {
        await requestJson(`${baseUrl}/api/events/subscribe/${subscriptionId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        })
      }
      await new Promise(resolve => webhookServer.close(resolve))
    }
  })
})
