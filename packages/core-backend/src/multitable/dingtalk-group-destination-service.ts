import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { Logger } from '../core/logger'
import type { Database } from '../db/types'
import { nowTimestamp } from '../db/type-helpers'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  normalizeDingTalkRobotSecret,
  normalizeDingTalkRobotWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import { maskDingTalkWebhookUrl } from '../integrations/dingtalk/runtime-policy'
import type {
  DingTalkGroupDelivery,
  DingTalkGroupDestination,
  DingTalkGroupDestinationCreateInput,
  DingTalkGroupDestinationUpdateInput,
  DingTalkGroupTestSendInput,
} from './dingtalk-group-destinations'

const logger = new Logger('DingTalkGroupDestinationService')
const DINGTALK_REQUEST_TIMEOUT_MS = 5_000
const DINGTALK_SAVE_PRECHECK_SUBJECT = 'MetaSheet DingTalk group verification'
const DINGTALK_SAVE_PRECHECK_CONTENT = 'P4 / metasheet destination verification before saving this DingTalk group robot.'
const DINGTALK_VALIDITY_TEST_SUBJECT = 'P4 metasheet DingTalk group validity test'
const DINGTALK_VALIDITY_TEST_CONTENT = 'P4 / metasheet robot validity check from MetaSheet.'

type DingTalkGroupDestinationRow = {
  id: string
  name: string
  webhook_url: string
  secret: string | null
  enabled: boolean
  sheet_id: string | null
  org_id: string | null
  created_by: string
  created_at: string | Date
  updated_at?: string | Date | null
  last_tested_at?: string | Date | null
  last_test_status?: string | null
  last_test_error?: string | null
}

function generateId(): string {
  return randomBytes(16).toString('hex')
}

function rowToDestination(row: DingTalkGroupDestinationRow): DingTalkGroupDestination {
  const scope = row.org_id ? 'org' : row.sheet_id ? 'sheet' : 'private'
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhook_url,
    secret: row.secret ?? undefined,
    enabled: row.enabled,
    scope,
    sheetId: row.sheet_id ?? undefined,
    orgId: row.org_id ?? undefined,
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

function rowToDelivery(row: {
  id: string
  destination_id: string
  source_type: string
  subject: string
  content: string
  success: boolean
  http_status: number | null
  response_body: string | null
  error_message: string | null
  automation_rule_id: string | null
  record_id: string | null
  initiated_by: string | null
  created_at: string | Date
  delivered_at?: string | Date | null
}): DingTalkGroupDelivery {
  return {
    id: row.id,
    destinationId: row.destination_id,
    sourceType: row.source_type === 'manual_test' ? 'manual_test' : 'automation',
    subject: row.subject,
    content: row.content,
    success: row.success,
    httpStatus: row.http_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    errorMessage: row.error_message ?? undefined,
    automationRuleId: row.automation_rule_id ?? undefined,
    recordId: row.record_id ?? undefined,
    initiatedBy: row.initiated_by ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    deliveredAt: row.delivered_at ? (row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at) : undefined,
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

type DingTalkRobotDeliveryResult = {
  httpStatus: number
  responseBody: string | null
}

class DingTalkRobotDeliveryError extends Error {
  httpStatus: number | null
  responseBody: string | null

  constructor(message: string, httpStatus: number | null, responseBody: string | null) {
    super(message)
    this.httpStatus = httpStatus
    this.responseBody = responseBody
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
    const webhookUrl = normalizeDingTalkRobotWebhookUrl(input.webhookUrl)
    const secret = normalizeDingTalkRobotSecret(input.secret)
    const sheetId = typeof input.sheetId === 'string' && input.sheetId.trim() ? input.sheetId.trim() : null
    const orgId = typeof input.orgId === 'string' && input.orgId.trim() ? input.orgId.trim() : null
    const scope = input.scope ?? (orgId ? 'org' : sheetId ? 'sheet' : 'private')
    if (!name) throw new Error('Destination name is required')
    if (sheetId && orgId) throw new Error('DingTalk group destination cannot be both sheet and organization scoped')
    if (scope === 'sheet' && !sheetId) throw new Error('sheetId is required for sheet-scoped DingTalk group destinations')
    if (scope === 'org' && !orgId) throw new Error('orgId is required for organization DingTalk group destinations')
    if (scope === 'private' && (sheetId || orgId)) throw new Error('private DingTalk group destinations cannot include sheetId or orgId')

    const precheck = await this.verifyRobotBeforeSave(webhookUrl, secret)
    const id = generateId()
    const enabled = input.enabled ?? true
    const now = new Date().toISOString()

    await this.db.insertInto('dingtalk_group_destinations').values({
      id,
      name,
      webhook_url: webhookUrl,
      secret: secret ?? null,
      enabled,
      sheet_id: sheetId,
      org_id: orgId,
      created_by: userId,
      created_at: now,
      updated_at: now,
      last_tested_at: now,
      last_test_status: 'success',
      last_test_error: null,
    }).execute()

    await this.recordDeliverySafely({
      destinationId: id,
      sourceType: 'manual_test',
      subject: DINGTALK_SAVE_PRECHECK_SUBJECT,
      content: DINGTALK_SAVE_PRECHECK_CONTENT,
      initiatedBy: userId,
      success: true,
      httpStatus: precheck.httpStatus,
      responseBody: precheck.responseBody,
    })

    logger.info(`Created DingTalk group destination ${id} for ${userId}`)
    return {
      id,
      name,
      webhookUrl,
      secret,
      enabled,
      scope,
      ...(sheetId ? { sheetId } : {}),
      ...(orgId ? { orgId } : {}),
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
      lastTestStatus: 'success',
    }
  }

  async listDestinations(userId: string, sheetId?: string, orgId?: string): Promise<DingTalkGroupDestination[]> {
    const normalizedSheetId = typeof sheetId === 'string' && sheetId.trim() ? sheetId.trim() : ''
    const normalizedOrgId = typeof orgId === 'string' && orgId.trim() ? orgId.trim() : ''
    let builder = this.db.selectFrom('dingtalk_group_destinations').selectAll()
    if (normalizedOrgId) {
      builder = builder.where((eb) =>
        eb.or([
          eb('org_id', '=', normalizedOrgId),
          eb.and([
            eb('sheet_id', 'is', null),
            eb('org_id', 'is', null),
            eb('created_by', '=', userId),
          ]),
        ]),
      )
    } else if (normalizedSheetId) {
      builder = builder.where((eb) =>
        eb.or([
          eb('sheet_id', '=', normalizedSheetId),
          eb.exists(
            eb.selectFrom('user_orgs')
              .select('user_id')
              .whereRef('user_orgs.org_id', '=', 'dingtalk_group_destinations.org_id')
              .where('user_orgs.user_id', '=', userId)
              .where('user_orgs.is_active', '=', true),
          ),
          eb.and([
            eb('sheet_id', 'is', null),
            eb('org_id', 'is', null),
            eb('created_by', '=', userId),
          ]),
        ]),
      )
    } else {
      builder = builder.where((eb) =>
        eb.or([
          eb.exists(
            eb.selectFrom('user_orgs')
              .select('user_id')
              .whereRef('user_orgs.org_id', '=', 'dingtalk_group_destinations.org_id')
              .where('user_orgs.user_id', '=', userId)
              .where('user_orgs.is_active', '=', true),
          ),
          eb.and([
            eb('sheet_id', 'is', null),
            eb('org_id', 'is', null),
            eb('created_by', '=', userId),
          ]),
        ]),
      )
    }
    const rows = await builder.orderBy('created_at', 'desc').execute()
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

  async listDeliveries(id: string, limit = 50): Promise<DingTalkGroupDelivery[]> {
    const rows = await this.db.selectFrom('dingtalk_group_deliveries')
      .selectAll()
      .where('destination_id', '=', id)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map((row) => rowToDelivery(row as Parameters<typeof rowToDelivery>[0]))
  }

  private async loadAuthorizedDestination(
    id: string,
    userId: string,
    sheetId?: string,
    orgId?: string,
  ): Promise<DingTalkGroupDestinationRow> {
    const row = await this.db.selectFrom('dingtalk_group_destinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new Error('Destination not found')
    if (row.sheet_id !== null) {
      if (!sheetId || row.sheet_id !== sheetId) throw new Error('Not authorized')
      return row
    }
    if (row.org_id !== null) {
      if (!orgId || row.org_id !== orgId) throw new Error('Not authorized')
      return row
    }
    if (row.created_by !== userId) throw new Error('Not authorized')
    return row
  }

  async updateDestination(
    id: string,
    userId: string,
    input: DingTalkGroupDestinationUpdateInput,
    sheetId?: string,
    orgId?: string,
  ): Promise<DingTalkGroupDestination> {
    const current = await this.loadAuthorizedDestination(id, userId, sheetId, orgId)

    const updates: Record<string, unknown> = { updated_at: nowTimestamp() }
    let nextWebhookUrl = current.webhook_url
    let nextSecret = current.secret ?? undefined
    let shouldVerifyBeforeSave = false
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new Error('Destination name is required')
      updates.name = name
    }
    if (input.webhookUrl !== undefined) {
      nextWebhookUrl = normalizeDingTalkRobotWebhookUrl(input.webhookUrl)
      updates.webhook_url = nextWebhookUrl
      shouldVerifyBeforeSave = true
    }
    if (input.secret !== undefined) {
      nextSecret = normalizeDingTalkRobotSecret(input.secret)
      updates.secret = nextSecret ?? null
      shouldVerifyBeforeSave = true
    }
    if (input.enabled !== undefined) updates.enabled = input.enabled

    if (shouldVerifyBeforeSave) {
      const precheck = await this.verifyRobotBeforeSave(nextWebhookUrl, nextSecret)
      updates.last_tested_at = nowTimestamp()
      updates.last_test_status = 'success'
      updates.last_test_error = null
      await this.recordDeliverySafely({
        destinationId: id,
        sourceType: 'manual_test',
        subject: DINGTALK_SAVE_PRECHECK_SUBJECT,
        content: DINGTALK_SAVE_PRECHECK_CONTENT,
        initiatedBy: userId,
        success: true,
        httpStatus: precheck.httpStatus,
        responseBody: precheck.responseBody,
      })
    }

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

  async deleteDestination(id: string, userId: string, sheetId?: string, orgId?: string): Promise<void> {
    await this.loadAuthorizedDestination(id, userId, sheetId, orgId)
    await this.db.deleteFrom('dingtalk_group_destinations')
      .where('id', '=', id)
      .execute()
  }

  async testSend(
    id: string,
    userId: string,
    input: DingTalkGroupTestSendInput,
    sheetId?: string,
    orgId?: string,
  ): Promise<{ ok: true }> {
    const row = await this.loadAuthorizedDestination(id, userId, sheetId, orgId)

    const subject = input.subject?.trim() || DINGTALK_VALIDITY_TEST_SUBJECT
    const content = input.content?.trim() || DINGTALK_VALIDITY_TEST_CONTENT
    let deliveryRecorded = false
    let responseStatus: number | null = null
    let responseBody: string | null = null

    try {
      const result = await this.sendRobotMessage(
        normalizeDingTalkRobotWebhookUrl(row.webhook_url),
        normalizeDingTalkRobotSecret(row.secret ?? undefined),
        subject,
        content,
      )
      responseStatus = result.httpStatus
      responseBody = result.responseBody
      deliveryRecorded = true
      await this.recordDeliverySafely({
        destinationId: id,
        sourceType: 'manual_test',
        subject,
        content,
        initiatedBy: userId,
        success: true,
        httpStatus: result.httpStatus,
        responseBody,
      })

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
      if (error instanceof DingTalkRobotDeliveryError) {
        responseStatus = error.httpStatus
        responseBody = error.responseBody
      }
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (!deliveryRecorded) {
        await this.recordDeliverySafely({
          destinationId: id,
          sourceType: 'manual_test',
          subject,
          content,
          initiatedBy: userId,
          success: false,
          httpStatus: responseStatus,
          responseBody,
          errorMessage: message,
        })
      }
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

  private async verifyRobotBeforeSave(webhookUrl: string, secret?: string): Promise<DingTalkRobotDeliveryResult> {
    try {
      return await this.sendRobotMessage(
        webhookUrl,
        secret,
        DINGTALK_SAVE_PRECHECK_SUBJECT,
        DINGTALK_SAVE_PRECHECK_CONTENT,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DingTalk group destination verification failed'
      throw new Error(`DingTalk group destination verification failed: ${message}`)
    }
  }

  private async sendRobotMessage(
    webhookUrl: string,
    secret: string | undefined,
    subject: string,
    content: string,
  ): Promise<DingTalkRobotDeliveryResult> {
    const payload = buildDingTalkMarkdown(subject, content)
    const signedUrl = buildSignedDingTalkWebhookUrl(webhookUrl, secret)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DINGTALK_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchFn(signedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MetaSheet-DingTalk-Destination-Test/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const parsed = await readJsonSafely(response)
    const responseBody = parsed ? JSON.stringify(parsed) : response.statusText || null
    if (!response.ok) {
      throw new DingTalkRobotDeliveryError(`HTTP ${response.status}: ${response.statusText}`, response.status, responseBody)
    }
    try {
      validateDingTalkRobotResponse(parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DingTalk robot response validation failed'
      throw new DingTalkRobotDeliveryError(message, response.status, responseBody)
    }
    return {
      httpStatus: response.status,
      responseBody,
    }
  }

  private async recordDelivery(input: {
    destinationId: string
    sourceType: 'manual_test' | 'automation'
    subject: string
    content: string
    initiatedBy?: string | null
    automationRuleId?: string | null
    recordId?: string | null
    success: boolean
    httpStatus?: number | null
    responseBody?: string | null
    errorMessage?: string | null
  }): Promise<void> {
    await this.db.insertInto('dingtalk_group_deliveries').values({
      id: generateId(),
      destination_id: input.destinationId,
      source_type: input.sourceType,
      subject: input.subject,
      content: input.content,
      success: input.success,
      http_status: input.httpStatus ?? null,
      response_body: input.responseBody ?? null,
      error_message: input.errorMessage ?? null,
      automation_rule_id: input.automationRuleId ?? null,
      record_id: input.recordId ?? null,
      initiated_by: input.initiatedBy ?? null,
      delivered_at: input.success ? sql<string>`CURRENT_TIMESTAMP` : null,
    }).execute()
  }

  private async recordDeliverySafely(input: Parameters<DingTalkGroupDestinationService['recordDelivery']>[0]): Promise<void> {
    try {
      await this.recordDelivery(input)
    } catch (error) {
      logger.warn('Failed to persist DingTalk group delivery history', {
        error: error instanceof Error ? error.message : String(error),
        destinationId: input.destinationId,
        sourceType: input.sourceType,
      })
    }
  }
}
