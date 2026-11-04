/**
 * S0-a (2026-11-03) — subscription create AND update give an EARLY error for a target the delivery check
 * would always refuse, in every environment.
 *
 * Before: `createWebhook` required https only when NODE_ENV=production; `updateWebhook` checked URL syntax
 * only, so any http / internal target could be stored. The boundary stays the per-attempt check in
 * `executeDelivery` (pinned); these checks only move the error to save time. No DNS here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import { WebhookService } from '../../src/multitable/webhook-service'

const STORED = {
  id: 'wh1',
  name: 'w',
  url: 'https://hooks.example.test/in',
  secret: null,
  events: JSON.stringify(['record.updated']),
  active: true,
  created_by: 'owner1',
  created_at: '2026-11-03T00:00:00.000Z',
  failure_count: 0,
  max_retries: 3,
  sheet_id: 'sheet1',
}

function mockDb() {
  const writes: Array<{ kind: string; data: unknown }> = []
  const chain = (kind: string) => {
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit']) self[m] = vi.fn(() => self)
    self.set = vi.fn((data: unknown) => { writes.push({ kind, data }); return self })
    self.values = vi.fn((data: unknown) => { writes.push({ kind, data }); return self })
    self.execute = vi.fn(async () => [])
    self.executeTakeFirst = vi.fn(async () => STORED)
    self.executeTakeFirstOrThrow = vi.fn(async () => STORED)
    return self
  }
  const db = {
    selectFrom: vi.fn(() => chain('select')),
    insertInto: vi.fn(() => chain('insert')),
    updateTable: vi.fn(() => chain('update')),
    deleteFrom: vi.fn(() => chain('delete')),
  }
  return { db: db as unknown as Kysely<Database>, writes }
}

const create = (svc: WebhookService, url: string) =>
  svc.createWebhook('owner1', { sheetId: 'sheet1', name: 'Hook', url, events: ['record.updated'] })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('subscription target — early error at create and update', () => {
  const refused: Array<[string, string, string]> = [
    ['http scheme', 'http://hooks.example.test/in', 'Webhook URL must use HTTPS'],
    ['loopback literal', 'https://127.0.0.1/in', 'WEBHOOK_TARGET_REJECTED:loopback'],
    ['private literal', 'https://10.0.0.8/in', 'WEBHOOK_TARGET_REJECTED:private'],
    ['link-local literal', 'https://169.254.169.254/latest', 'WEBHOOK_TARGET_REJECTED:link-local'],
    ['internal name', 'https://printer.local/in', 'WEBHOOK_TARGET_REJECTED:internal-name'],
    ['localhost', 'https://localhost:8443/in', 'WEBHOOK_TARGET_REJECTED:loopback'],
  ]

  for (const [label, url, message] of refused) {
    it(`create refuses ${label} outside production too, writes nothing, and the message does not quote the URL`, async () => {
      vi.stubEnv('NODE_ENV', 'test')
      const { db, writes } = mockDb()
      const svc = new WebhookService(db)
      await expect(create(svc, url)).rejects.toThrow(message)
      await create(svc, url).catch((err: Error) => expect(err.message).not.toContain(url))
      expect(writes).toEqual([])
    })

    it(`update refuses ${label}, writes nothing`, async () => {
      const { db, writes } = mockDb()
      const svc = new WebhookService(db)
      await expect(svc.updateWebhook('wh1', 'owner1', { url })).rejects.toThrow(message)
      expect(writes).toEqual([])
    })
  }

  it('create and update accept a public https target without resolving it', async () => {
    const { db, writes } = mockDb()
    const lookup = vi.fn(async () => [{ address: '203.0.113.10', family: 4 }])
    const svc = new WebhookService(db, undefined, lookup)
    await expect(create(svc, 'https://hooks.example.test/in')).resolves.toMatchObject({ url: 'https://hooks.example.test/in' })
    await expect(svc.updateWebhook('wh1', 'owner1', { url: 'https://hooks.example.test/other' })).resolves.toBeDefined()
    expect(lookup).not.toHaveBeenCalled()
    expect(writes.length).toBeGreaterThan(0)
  })

  it('a malformed URL keeps the existing message', async () => {
    const { db } = mockDb()
    const svc = new WebhookService(db)
    await expect(create(svc, 'not a url')).rejects.toThrow('Webhook URL is not a valid URL')
    await expect(svc.updateWebhook('wh1', 'owner1', { url: 'not a url' })).rejects.toThrow('Webhook URL is not a valid URL')
  })
})
