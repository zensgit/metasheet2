/**
 * Subscription webhook delivery rules — the one place that decides whether a (webhook, event) is delivered
 * and what the delivered body contains.
 *
 * A subscription webhook delivers only what its owner can read through the product at the time of
 * delivery: only the sheet the webhook is bound to, only records the owner can read there, only fields the
 * owner can see. Every decision is re-made from the database (no request claims, no process cache) both
 * before a delivery row is written and before every HTTP attempt, including retries.
 *
 * Two layers:
 *   - `webhookDeliveryFloor` — binding present, event sheet = bound sheet, owner passes request admission
 *     (account live, login gate, no forced password change), owner can read the bound sheet and manage its
 *     automation, the sheet is live and is not a hidden system sheet.
 *   - `authorizeWebhookDeliveryWithQuery` — the floor plus row-level read deny (with record liveness from
 *     the same snapshot), the field mask (same chain as the record read path) and the envelope allow-list.
 *
 * Any failed check refuses. A refusal is logged with its enum reason only (no ids, no values).
 */
import { Logger } from '../core/logger'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'
import { ACCOUNT_INACTIVE_CODE, evaluateUserAuthenticationGate } from '../auth/user-activation'
import type { MultitableCapabilities, ResolvedRequestAccess } from './access'
import {
  isRecordReadDeniedForUserStrict,
  loadRowLevelReadDenyEnabledStrict,
  resolveSheetCapabilitiesForAccess,
  type QueryFn,
} from './permission-service'
import { loadDatabaseFreshRecoveryAccess } from './recovery-authorization-stability'
import { isHiddenSystemSheet } from './system-sheet-predicate'
import { runWebhookDeliveryCheck } from './webhook-authority-transaction'

const logger = new Logger('WebhookDeliveryRules')

const WEBHOOK_REFUSAL_REASONS = [
  'no_sheet_binding',
  'sheet_mismatch',
  'sheet_hidden',
  'owner_inactive',
  'owner_gate',
  'owner_must_change_password',
  'sheet_not_readable',
  'sheet_not_live',
  'automation_not_manageable',
  'record_not_live',
  'record_read_denied',
  'all_values_masked',
  'authority_check_failed',
] as const

export type WebhookRefusalReason = (typeof WEBHOOK_REFUSAL_REASONS)[number]

/** The webhook fields the rules read. `sheetId` is the bound sheet (null = not bound). */
export type WebhookRuleTarget = {
  id: string
  createdBy: string
  sheetId: string | null
}

export type WebhookFloorResult =
  | { ok: false; reason: WebhookRefusalReason }
  | { ok: true; access: ResolvedRequestAccess; capabilities: MultitableCapabilities }

export type WebhookDeliveryDecision =
  | { deliver: true; payload: Record<string, unknown> }
  | { deliver: false; reason: WebhookRefusalReason }

export const WEBHOOK_CHECK_FAILED: WebhookRefusalReason = 'authority_check_failed'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refuse(reason: WebhookRefusalReason): { deliver: false; reason: WebhookRefusalReason } {
  return { deliver: false, reason }
}

export function logWebhookRefusal(reason: WebhookRefusalReason): void {
  logger.info(`webhook delivery refused: reason=${reason}`)
}

const CHECK_ERROR_CODE_SHAPE = /^[0-9A-Z_]{2,48}$/
function describeCheckErrorCode(err: unknown): string {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && CHECK_ERROR_CODE_SHAPE.test(code) ? code : 'unknown'
}

// ─── Floor ────────────────────────────────────────────────────────────────────────────────

/** The event's sheet must be a string equal to the bound sheet. */
function eventSheetMatchesBinding(boundSheetId: string, payload: unknown): boolean {
  if (!isPlainObject(payload)) return false
  const eventSheetId = payload.sheetId
  return typeof eventSheetId === 'string' && eventSheetId === boundSheetId
}

async function isBoundSheetHidden(query: QueryFn, sheetId: string): Promise<boolean> {
  const result = await query(
    `SELECT to_jsonb(s) ->> 'system_kind' AS system_kind, s.description
       FROM meta_sheets s
      WHERE s.id = $1`,
    [sheetId],
  )
  const row = result.rows[0] as { system_kind?: unknown; description?: unknown } | undefined
  return isHiddenSystemSheet(row)
}

/**
 * Owner admission + sheet access, read from the database on the given (transaction-bound) query.
 * Delivery additionally requires automation management and refuses hidden system sheets; the
 * delivery-history read requires request admission, read access and a live sheet.
 */
export async function evaluateWebhookOwnerSheetAccess(
  query: QueryFn,
  ownerId: string,
  sheetId: string,
  options: { requireManageAutomation: boolean; refuseHiddenSheet: boolean },
): Promise<WebhookFloorResult> {
  if (options.refuseHiddenSheet && (await isBoundSheetHidden(query, sheetId))) return { ok: false, reason: 'sheet_hidden' }

  const access = await loadDatabaseFreshRecoveryAccess(query, ownerId)
  // '' is the loader's marker for a missing, inactive or disabled account.
  if (access.userId === '') return { ok: false, reason: 'owner_inactive' }

  const userResult = await query(
    `SELECT is_active, role, activation_status, must_change_password
       FROM users
      WHERE id = $1`,
    [access.userId],
  )
  const user = userResult.rows[0] as {
    is_active?: boolean | null
    role?: string | null
    activation_status?: string | null
    must_change_password?: boolean | null
  } | undefined
  if (!user) return { ok: false, reason: 'owner_inactive' }
  const gate = evaluateUserAuthenticationGate({
    is_active: user.is_active ?? null,
    role: user.role ?? null,
    activation_status: user.activation_status ?? null,
  })
  if (gate) return { ok: false, reason: gate.code === ACCOUNT_INACTIVE_CODE ? 'owner_inactive' : 'owner_gate' }
  if (user.must_change_password === true) return { ok: false, reason: 'owner_must_change_password' }

  // Every read below is keyed by the BOUND sheet id, never by a value taken from the event.
  const resolved = await resolveSheetCapabilitiesForAccess(query, sheetId, access)
  if (resolved.capabilities.canRead !== true) return { ok: false, reason: 'sheet_not_readable' }
  if (resolved.sheetLiveness !== 'live') return { ok: false, reason: 'sheet_not_live' }
  if (options.requireManageAutomation && resolved.capabilities.canManageAutomation !== true) {
    return { ok: false, reason: 'automation_not_manageable' }
  }
  return { ok: true, access: resolved.access, capabilities: resolved.capabilities }
}

async function webhookDeliveryFloor(
  query: QueryFn,
  webhook: WebhookRuleTarget,
  _event: string,
  payload: unknown,
): Promise<WebhookFloorResult> {
  const boundSheetId = typeof webhook.sheetId === 'string' ? webhook.sheetId : ''
  if (!boundSheetId) return { ok: false, reason: 'no_sheet_binding' }
  if (!eventSheetMatchesBinding(boundSheetId, payload)) return { ok: false, reason: 'sheet_mismatch' }
  return evaluateWebhookOwnerSheetAccess(query, webhook.createdBy, boundSheetId, {
    requireManageAutomation: true,
    refuseHiddenSheet: true,
  })
}

// ─── Full layer ───────────────────────────────────────────────────────────────────────────

/** Events whose delivery requires the record to be live (and not denied) at check time on row-level-deny sheets. */
const LIVE_RECORD_REQUIRED_EVENTS: ReadonlySet<string> = new Set([
  'record.created',
  'record.updated',
  'comment.created',
  'record.deleted',
])

/** Envelope allow-list: id keys kept when they are strings; value maps filtered by readable fields. */
const ENVELOPE_ID_KEYS = ['sheetId', 'recordId'] as const
const VALUE_MAP_KEYS = ['data', 'changes'] as const
/** Known keys that are never delivered. */
const NOT_DELIVERED_KEYS: ReadonlySet<string> = new Set(['actorId', '_eventId', '_automationDepth', 'nodeKey', 'entryEpoch'])

type MaskedPayload = {
  payload: Record<string, unknown>
  hadValueMap: boolean
  removedKeys: number
  remainingKeys: number
}

async function loadReadableFieldIds(
  query: QueryFn,
  sheetId: string,
  access: ResolvedRequestAccess,
  capabilities: MultitableCapabilities,
): Promise<{
  readableFieldIds: Set<string>
  filterRecordDataByFieldIds: (data: unknown, allowedFieldIds: Set<string>) => Record<string, unknown>
}> {
  // Loaded on first use: the record read-path field chain lives in the multitable route module.
  const readPath = await import('../routes/univer-meta')
  const readableFieldIds = await readPath.loadReadableRecordFieldIdsForAccess(query, sheetId, access, capabilities)
  return { readableFieldIds, filterRecordDataByFieldIds: readPath.filterRecordDataByFieldIds }
}

async function maskWebhookPayload(
  query: QueryFn,
  sheetId: string,
  access: ResolvedRequestAccess,
  capabilities: MultitableCapabilities,
  payload: Record<string, unknown>,
): Promise<MaskedPayload> {
  const masked: Record<string, unknown> = {}
  for (const key of ENVELOPE_ID_KEYS) {
    if (typeof payload[key] === 'string') masked[key] = payload[key]
  }
  const valueMapKeys = VALUE_MAP_KEYS.filter((key) => isPlainObject(payload[key]))
  let removedKeys = 0
  let remainingKeys = 0
  if (valueMapKeys.length > 0) {
    const { readableFieldIds, filterRecordDataByFieldIds } = await loadReadableFieldIds(query, sheetId, access, capabilities)
    for (const key of valueMapKeys) {
      const valueMap = payload[key] as Record<string, unknown>
      const filtered = filterRecordDataByFieldIds(valueMap, readableFieldIds)
      removedKeys += Object.keys(valueMap).length - Object.keys(filtered).length
      remainingKeys += Object.keys(filtered).length
      masked[key] = filtered
    }
  }
  let unknownKeys = 0
  for (const key of Object.keys(payload)) {
    if ((ENVELOPE_ID_KEYS as readonly string[]).includes(key)) continue
    if ((VALUE_MAP_KEYS as readonly string[]).includes(key)) continue
    if (NOT_DELIVERED_KEYS.has(key)) continue
    unknownKeys += 1
  }
  if (unknownKeys > 0) logger.info(`webhook payload unknown keys dropped: count=${unknownKeys}`)
  return { payload: masked, hadValueMap: valueMapKeys.length > 0, removedKeys, remainingKeys }
}

export async function authorizeWebhookDeliveryWithQuery(
  query: QueryFn,
  webhook: WebhookRuleTarget,
  event: string,
  payload: unknown,
): Promise<WebhookDeliveryDecision> {
  const floor = await webhookDeliveryFloor(query, webhook, event, payload)
  if (floor.ok === false) return refuse(floor.reason)
  const sheetId = webhook.sheetId as string
  const body = payload as Record<string, unknown>

  // Row-level read deny (admin owners follow the read path's admin exception).
  if (!floor.access.isAdminRole && (await loadRowLevelReadDenyEnabledStrict(query, sheetId))) {
    const recordId = typeof body.recordId === 'string' ? body.recordId : ''
    if (!recordId) return refuse('record_not_live')
    if (LIVE_RECORD_REQUIRED_EVENTS.has(event)) {
      const live = await query('SELECT 1 FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
      if (live.rows.length === 0) return refuse('record_not_live')
    }
    if (await isRecordReadDeniedForUserStrict(query, sheetId, recordId, webhook.createdBy)) {
      return refuse('record_read_denied')
    }
  }

  const masked = await maskWebhookPayload(query, sheetId, floor.access, floor.capabilities, body)
  // An update whose every carried value was removed by the mask is not delivered (the fact that a hidden
  // field changed is itself information). Updates that carry no value map are delivered as id-only.
  if (event === 'record.updated' && masked.hadValueMap && masked.removedKeys > 0 && masked.remainingKeys === 0) {
    return refuse('all_values_masked')
  }
  return { deliver: true, payload: masked.payload }
}

// ─── Entry points (own read transaction each) ─────────────────────────────────────────────

/**
 * Decide one (webhook, event) delivery. Never throws: a failed check resolves to a refusal with reason
 * `authority_check_failed`, which callers handle as an error (not as an endpoint failure).
 */
export async function authorizeWebhookDelivery(
  db: Kysely<Database>,
  webhook: WebhookRuleTarget,
  event: string,
  payload: unknown,
): Promise<WebhookDeliveryDecision> {
  let decision: WebhookDeliveryDecision
  try {
    decision = await runWebhookDeliveryCheck(db, (query) =>
      authorizeWebhookDeliveryWithQuery(query, webhook, event, payload),
    )
  } catch (err) {
    logger.warn(`webhook delivery check failed (code=${describeCheckErrorCode(err)})`)
    decision = refuse(WEBHOOK_CHECK_FAILED)
  }
  if (decision.deliver === false) logWebhookRefusal(decision.reason)
  return decision
}

/**
 * Delivery-history read: the owner must currently pass request admission, read the bound sheet, and the
 * sheet must be live. Not bounded by the delivery-check permits (an interactive read). Never throws.
 */
export async function authorizeWebhookOwnerCurrentAccess(
  db: Kysely<Database>,
  webhook: WebhookRuleTarget,
): Promise<{ ok: true } | { ok: false; reason: WebhookRefusalReason }> {
  const boundSheetId = typeof webhook.sheetId === 'string' ? webhook.sheetId : ''
  if (!boundSheetId) return { ok: false, reason: 'no_sheet_binding' }
  try {
    const result = await runWebhookDeliveryCheck(
      db,
      (query) =>
        evaluateWebhookOwnerSheetAccess(query, webhook.createdBy, boundSheetId, {
          requireManageAutomation: false,
          refuseHiddenSheet: false,
        }),
      { bounded: false },
    )
    return result.ok === false ? { ok: false, reason: result.reason } : { ok: true }
  } catch (err) {
    logger.warn(`webhook delivery history check failed (code=${describeCheckErrorCode(err)})`)
    return { ok: false, reason: WEBHOOK_CHECK_FAILED }
  }
}
