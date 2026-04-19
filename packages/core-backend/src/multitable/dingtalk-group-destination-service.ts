import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { Logger } from '../core/logger'
import type { Database } from '../db/types'
import { nowTimestamp } from '../db/type-helpers'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import { maskDingTalkWebhookUrl } from '../integrations/dingtalk/runtime-policy'
import type {
  DingTalkGroupDestination,
  DingTalkGroupDestinationCreateInput,
  DingTalkGroupDestinationUpdateInput,
  DingTalkGroupTestSendInput,
} from './dingtalk-group-destinations'

const logger = new Logger('DingTalkGroupDestinationService')

function generateId(): string {
  return randomBytes(16).toString('hex')
}

function rowToDestination(row: {
  id: string
  name: string
  webhook_url: string
  secret: string | null
  enabled: boolean
  created_by: string
  created_at: string | Date
  updated_at?: string | Date | null
  last_tested_at?: string | Date | null
  last_test_status?: string | null
  last_test_error?: string | null
}): DingTalkGroupDestination {
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhook_url,
    secret: row.secret ?? undefined,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at ? (row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at) : undefined,
    lastTestedAt: row.last_tested_at ? (row.last_tested_at instanceof Date ? row.last_tested_at.toISOString() : row.last_tested_at) : undefined,
    lastTestStatus: row.last_test_status === 'success' || row.last_test_status === 'failed'
      ? row.last_test_status
      : undefined,
    lastTestError: row.last_test_error ?? undefined,
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export class DingTalkGroupDestinationService {
  private db: Kysely<Database>
  private fetchFn: typeof fetch

  constructor(db: Kysely<Database>, fetchFn?: typeof fetch) {
    this.db = db
    this.fetchFn = fetchFn ?? globalThis.fetch
  }

  async createDestination(userId: string, input: DingTalkGroupDestinationCreateInput): Promise<DingTalkGroupDestination> {
    const name = input.name?.trim()
    const webhookUrl = input.webhookUrl?.trim()
    if (!name) throw new Error('Destination name is required')
    if (!webhookUrl) throw new Error('Webhook URL is required')
    try {
      const parsed = new URL(webhookUrl)
      if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
        throw new Error('Webhook URL must use HTTPS in production')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTPS')) throw error
      throw new Error('Webhook URL is not a valid URL')
    }

    const id = generateId()
    const enabled = input.enabled ?? true
    const now = new Date().toISOString()

    await this.db.insertInto('dingtalk_group_destinations').values({
      id,
      name,
      webhook_url: webhookUrl,
      secret: input.secret ?? null,
      enabled,
      created_by: userId,
      created_at: now,
    }).execute()

    logger.info(`Created DingTalk group destination ${id} for ${userId}`)
    return {
      id,
      name,
      webhookUrl,
      secret: input.secret,
      enabled,
      createdBy: userId,
      createdAt: now,
    }
  }

  async listDestinations(userId: string): Promise<DingTalkGroupDestination[]> {
    const rows = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('created_by', '=', userId)
      .orderBy('created_at', 'desc')
      .execute()
    return rows.map((row) => rowToDestination(row as Parameters<typeof rowToDestination>[0]))
  }

  async getDestinationById(id: string): Promise<DingTalkGroupDestination | undefined> {
    const row = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return undefined
    return rowToDestination(row as Parameters<typeof rowToDestination>[0])
  }

  async updateDestination(
    id: string,
    userId: string,
    input: DingTalkGroupDestinationUpdateInput,
  ): Promise<DingTalkGroupDestination> {
    const row = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new Error('Destination not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    const updates: Record<string, unknown> = { updated_at: nowTimestamp() }
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new Error('Destination name is required')
      updates.name = name
    }
    if (input.webhookUrl !== undefined) {
      const webhookUrl = input.webhookUrl.trim()
      if (!webhookUrl) throw new Error('Webhook URL is required')
      try {
        const parsed = new URL(webhookUrl)
        if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
          throw new Error('Webhook URL must use HTTPS in production')
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('HTTPS')) throw error
        throw new Error('Webhook URL is not a valid URL')
      }
      updates.webhook_url = webhookUrl
    }
    if (input.secret !== undefined) updates.secret = input.secret || null
    if (input.enabled !== undefined) updates.enabled = input.enabled

    await this.db.updateTable('dingtalk_group_destinations')
      .set(updates as never)
      .where('id', '=', id)
      .execute()

    const updated = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return rowToDestination(updated as Parameters<typeof rowToDestination>[0])
  }

  async deleteDestination(id: string, userId: string): Promise<void> {
    const row = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new Error('Destination not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    await this.db.deleteFrom('dingtalk_group_destinations')
      .where('id', '=', id)
      .execute()
  }

  async testSend(
    id: string,
    userId: string,
    input: DingTalkGroupTestSendInput,
  ): Promise<{ ok: true }> {
    const row = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new Error('Destination not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    const subject = input.subject?.trim() || 'MetaSheet DingTalk group test'
    const content = input.content?.trim() || 'This is a standard DingTalk group destination test message.'
    const payload = buildDingTalkMarkdown(subject, content)
    const signedUrl = buildSignedDingTalkWebhookUrl(row.webhook_url, row.secret ?? undefined)

    try {
      const response = await this.fetchFn(signedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MetaSheet-DingTalk-Destination-Test/1.0',
        },
        body: JSON.stringify(payload),
      })

      const parsed = await readJsonSafely(response)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      validateDingTalkRobotResponse(parsed)

      await this.db.updateTable('dingtalk_group_destinations')
        .set({
          updated_at: nowTimestamp(),
          last_tested_at: nowTimestamp(),
          last_test_status: 'success',
          last_test_error: null,
        })
        .where('id', '=', id)
        .execute()

      logger.info(`DingTalk group destination test sent to ${maskDingTalkWebhookUrl(row.webhook_url)}`)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      await this.db.updateTable('dingtalk_group_destinations')
        .set({
          updated_at: nowTimestamp(),
          last_tested_at: nowTimestamp(),
          last_test_status: 'failed',
          last_test_error: message,
        })
        .where('id', '=', id)
        .execute()
      throw new Error(message)
    }
  }
}
