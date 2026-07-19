/**
 * FWB production runtime — write_approval_form_values (FWB-0 design lock).
 *
 * Activation (fail-closed):
 *   - APPROVAL_FWB_RUNTIME_ENABLED must be true (default OFF)
 *   - AUTOMATION_DURABLE_DELIVERY_ENABLED must be true (D9/D10 same-txn outbox)
 *   - NEVER uses legacy post-commit emit; outbox must enqueue in the write transaction or the action rolls back
 *
 * Authority:
 *   - form values from form_snapshot; decision values from freeze rows for the CURRENT assignment epoch
 *   - target field types/options/precision from meta_fields (not action config)
 *   - Q6 confirmation from meta_fwb_confirmations (server challenge + ack)
 *   - write identity = rule creator
 */
import { createHash, randomUUID } from 'node:crypto'

import type { EventBus } from '../integration/events/event-bus'
import { isAdmin } from '../rbac/service'
import { withAutomationEventId } from './automation-event-dedup'
import { deriveActionKey } from './automation-action-idempotency'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { produceAutomationEvent } from './automation-durable-activation'
import type { AutomationDeps, CrossBaseWriteGate, ExecutionContext } from './automation-executor'
import type { WriteApprovalFormValuesConfig } from './automation-actions'
import { mapApprovalFormValues, type FwbFieldMapping } from './approval-form-value-mapping'
import {
  executeWriteApprovalFormValues,
  type FwbRecordWriteSeam,
  type FwbWriteActionInput,
} from './approval-fwb-write-action'
import {
  executeUpdateBoundRecord,
  type FwbUpdateActionInput,
  type FwbUpdateSeam,
  type RecordLinkChecks,
  validateRecordLinkAtSubmit,
} from './approval-fwb-record-link'
import {
  executeWriteDecisionValues,
  type FwbDecisionWriteInput,
  type FrozenDecisionSnapshot,
} from './approval-fwb-decision-values'
import type { FwbGateChecks, FwbGateSubject } from './approval-fwb-permission-gates'
import { isFwbRuntimeEnabled, requireFwbActivationForEnabledRule } from './approval-fwb-flags'
import {
  computeFwbConfigFingerprint,
  verifyFwbConfirmation,
  type FwbConfirmationSubject,
} from './approval-fwb-confirmation'
import { isApprovalTemplateVisibleToUser } from './approval-template-visibility'
import {
  buildAuthoritativeMappings,
  loadTargetFieldsFromMeta,
  resolvePinnedRecordLinkTarget,
} from './approval-fwb-target-fields'
import { recordRecordRevision } from './record-history-service'
import { canEditWhileLocked, ensureRecordNotLocked, lockableFromRow } from './record-lock'
import { isRecordReadDeniedForUser } from './permission-service'
import { resolveSheetCapabilitiesForUser, canWriteRecord } from './sheet-capabilities'
import { sanitizeRichLongText } from './field-codecs'
import type { TransactionalQueryable } from './pg-transaction-guard'
import type { Queryable } from './automation-durable-dispatcher'

const NON_BLANK = /[!-~]/
/** External values-free reject shape — no existence oracle, no raw DB messages. */
export const FWB_TARGET_UNAVAILABLE = 'target_unavailable' as const

export type FwbRuntimeConfig = WriteApprovalFormValuesConfig

export type ParseFwbConfigResult =
  | { ok: true; config: FwbRuntimeConfig }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rich-longText is sanitized before entering the transaction and again by the pure mapping core.
 * The second pass is intentional defense-in-depth for direct callers of the lower-level executors.
 */
function sanitizeFwbSourceValues(
  mappings: readonly FwbFieldMapping[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sanitized = { ...values }
  for (const mapping of mappings) {
    if (!mapping.richLongText) continue
    const value = sanitized[mapping.formFieldId]
    if (typeof value === 'string') sanitized[mapping.formFieldId] = sanitizeRichLongText(value)
  }
  return sanitized
}

/** Normalize + validate action config. Types/options are NOT accepted as authority. */
export function parseWriteApprovalFormValuesConfig(raw: unknown): ParseFwbConfigResult {
  if (!isRecord(raw)) return { ok: false, error: 'write_approval_form_values config must be an object' }
  const mode = raw.mode
  if (mode !== 'create' && mode !== 'update' && mode !== 'decision') {
    return { ok: false, error: 'write_approval_form_values.config.mode must be create|update|decision' }
  }
  if (!Array.isArray(raw.mappings) || raw.mappings.length === 0) {
    return { ok: false, error: 'write_approval_form_values.config.mappings must be a non-empty array' }
  }
  const mappings: Array<{ formFieldId: string; targetFieldId: string }> = []
  const seenTargets = new Set<string>()
  for (const [i, m] of raw.mappings.entries()) {
    if (!isRecord(m)) return { ok: false, error: `mappings[${i}] must be an object` }
    const formFieldId = typeof m.formFieldId === 'string' ? m.formFieldId.trim() : ''
    const targetFieldId = typeof m.targetFieldId === 'string' ? m.targetFieldId.trim() : ''
    if (!NON_BLANK.test(formFieldId) || !NON_BLANK.test(targetFieldId)) {
      return { ok: false, error: `mappings[${i}] formFieldId/targetFieldId required` }
    }
    if (seenTargets.has(targetFieldId)) {
      return { ok: false, error: `mappings[${i}] duplicate targetFieldId` }
    }
    seenTargets.add(targetFieldId)
    mappings.push({ formFieldId, targetFieldId })
  }
  const confirmationId = typeof raw.confirmationId === 'string' ? raw.confirmationId.trim() : ''
  if (!NON_BLANK.test(confirmationId)) {
    return { ok: false, error: 'write_approval_form_values.config.confirmationId is required (Q6)' }
  }
  const recordLinkFieldId = typeof raw.recordLinkFieldId === 'string' ? raw.recordLinkFieldId.trim() : ''
  const decisionNodeKey = typeof raw.decisionNodeKey === 'string' ? raw.decisionNodeKey.trim() : ''
  if ((mode === 'update' || mode === 'decision') && !NON_BLANK.test(recordLinkFieldId)) {
    return { ok: false, error: `write_approval_form_values.config.recordLinkFieldId is required for mode=${mode}` }
  }
  if (mode === 'decision' && !NON_BLANK.test(decisionNodeKey)) {
    return { ok: false, error: 'write_approval_form_values.config.decisionNodeKey is required for mode=decision' }
  }
  const targetBaseId = typeof raw.targetBaseId === 'string' && raw.targetBaseId.trim()
    ? raw.targetBaseId.trim()
    : undefined
  return {
    ok: true,
    config: {
      mode,
      mappings,
      confirmationId,
      ...(recordLinkFieldId ? { recordLinkFieldId } : {}),
      ...(decisionNodeKey ? { decisionNodeKey } : {}),
      ...(targetBaseId ? { targetBaseId } : {}),
    },
  }
}

/** Identifier-pair fingerprint helper (tests / save). Prefer computeFwbConfigFingerprint for Q6. */
export function computeFwbConfirmationHash(input: {
  sourceTemplateId: string
  targetSheetId: string
  targetBaseId?: string | null
  mappings: readonly { formFieldId: string; targetFieldId: string }[]
  templateVersionId?: string
}): string {
  return computeFwbConfigFingerprint({
    templateId: input.sourceTemplateId,
    templateVersionId: input.templateVersionId ?? '',
    targetBaseId: input.targetBaseId ?? null,
    targetSheetId: input.targetSheetId,
    mappings: input.mappings,
  })
}

export function extractApprovalInstanceId(triggerEvent: unknown): string | null {
  if (!isRecord(triggerEvent)) return null
  const approval = triggerEvent.approval
  if (!isRecord(approval)) return null
  const id = approval.instanceId
  return typeof id === 'string' && NON_BLANK.test(id) ? id : null
}

export function extractApprovalTemplateId(triggerEvent: unknown): string | null {
  if (!isRecord(triggerEvent)) return null
  const approval = triggerEvent.approval
  if (!isRecord(approval)) return null
  const id = approval.templateId
  return typeof id === 'string' && NON_BLANK.test(id) ? id : null
}

export function parseRecordLinkValue(raw: unknown): { ok: true; recordId: string } | { ok: false } {
  if (!isRecord(raw)) return { ok: false }
  const recordId = typeof raw.recordId === 'string' ? raw.recordId.trim() : ''
  if (!NON_BLANK.test(recordId)) return { ok: false }
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'recordId') return { ok: false }
  return { ok: true, recordId }
}

export interface FwbRuntimeDeps {
  queryFn: AutomationDeps['queryFn']
  transaction: NonNullable<AutomationDeps['transaction']>
  eventBus: EventBus
  evaluateCrossBaseWriteGate: (
    actorId: string | null,
    triggerSheetId: string,
    targetSheetId: string,
    declaredTargetBaseId: string | undefined,
  ) => Promise<CrossBaseWriteGate>
  gateChecks?: FwbGateChecks
  linkChecks?: RecordLinkChecks
  env?: NodeJS.ProcessEnv
}

export type FwbRuntimeStepResult =
  | { status: 'success'; output: Record<string, unknown>; alreadyApplied?: boolean }
  | { status: 'failed'; error: string; output?: Record<string, unknown> }

function asTrx(query: AutomationDeps['queryFn']): TransactionalQueryable {
  return {
    query: async (sql, params) => {
      const r = await query(sql, params)
      return {
        rows: (r.rows as Array<Record<string, unknown>>) ?? [],
        rowCount: r.rowCount ?? null,
      }
    },
    isTransaction: true,
  }
}

function queryFromTrx(trx: Queryable): AutomationDeps['queryFn'] {
  return async (sql, params) => {
    const r = await trx.query(sql, params)
    return { rows: r.rows, rowCount: r.rowCount ?? undefined }
  }
}

async function loadFormSnapshot(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
): Promise<Record<string, unknown> | null> {
  const res = await queryFn(`SELECT form_snapshot FROM approval_instances WHERE id = $1`, [instanceId])
  const row = res.rows[0] as { form_snapshot?: unknown } | undefined
  if (!row || !isRecord(row.form_snapshot)) return null
  return row.form_snapshot
}

async function loadInstanceTemplateVersion(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
): Promise<{ templateId: string; templateVersionId: string } | null> {
  const res = await queryFn(
    `SELECT template_id::text AS template_id, template_version_id::text AS template_version_id
       FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const row = res.rows[0] as { template_id?: string; template_version_id?: string } | undefined
  if (!row?.template_id || !row?.template_version_id) return null
  return { templateId: row.template_id, templateVersionId: row.template_version_id }
}

async function loadRecordLinkBinding(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
  recordLinkFieldId: string,
): Promise<{ sheetId: string; recordId: string; baseId: string | null } | { error: typeof FWB_TARGET_UNAVAILABLE }> {
  const inst = await queryFn(
    `SELECT form_snapshot FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const row = inst.rows[0] as { form_snapshot?: unknown } | undefined
  if (!row || !isRecord(row.form_snapshot)) return { error: FWB_TARGET_UNAVAILABLE }
  const parsed = parseRecordLinkValue(row.form_snapshot[recordLinkFieldId])
  if (!parsed.ok) return { error: FWB_TARGET_UNAVAILABLE }
  const ver = await queryFn(
    `SELECT v.form_schema
       FROM approval_instances i
       JOIN approval_template_versions v ON v.id = i.template_version_id
      WHERE i.id = $1`,
    [instanceId],
  )
  const formSchema = (ver.rows[0] as { form_schema?: unknown } | undefined)?.form_schema
  const fields = isRecord(formSchema) && Array.isArray(formSchema.fields) ? formSchema.fields : []
  const field = fields.find((f) => isRecord(f) && f.id === recordLinkFieldId && f.type === 'record-link')
  if (!isRecord(field)) return { error: FWB_TARGET_UNAVAILABLE }
  const props = isRecord(field.props) ? field.props : {}
  // Fail closed: sheetId + baseId must exist and baseId must match non-deleted meta_sheets.base_id.
  const pinned = await resolvePinnedRecordLinkTarget(queryFn, props)
  if (!pinned.ok) return { error: FWB_TARGET_UNAVAILABLE }
  return { sheetId: pinned.sheetId, recordId: parsed.recordId, baseId: pinned.baseId }
}

/**
 * FWB-3: resolve the CURRENT node-entry epoch from live assignments (not max freeze epoch).
 * Then require a complete freeze set for exactly that epoch.
 */
export async function loadFrozenDecisionForCurrentEpoch(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
  nodeKey: string,
  requiredFieldIds: readonly string[],
): Promise<FrozenDecisionSnapshot | { error: 'decision_values_missing' | 'decision_epoch_missing' }> {
  const epochRes = await queryFn(
    `SELECT MAX(entry_epoch)::int AS epoch
       FROM approval_assignments
      WHERE instance_id = $1 AND node_key = $2 AND entry_epoch IS NOT NULL AND entry_epoch >= 1`,
    [instanceId, nodeKey],
  )
  const epoch = Number((epochRes.rows[0] as { epoch?: number | null } | undefined)?.epoch)
  if (!Number.isInteger(epoch) || epoch < 1) return { error: 'decision_epoch_missing' }

  const res = await queryFn(
    `SELECT field_id, value, created_at
       FROM approval_node_decision_values
      WHERE instance_id = $1 AND node_key = $2 AND entry_epoch = $3`,
    [instanceId, nodeKey, epoch],
  )
  if (res.rows.length === 0) return { error: 'decision_values_missing' }
  const values: Record<string, unknown> = {}
  let frozenAt = new Date(0).toISOString()
  for (const raw of res.rows) {
    const row = raw as { field_id: string; value: unknown; created_at: string | Date }
    values[row.field_id] = row.value
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    if (at > frozenAt) frozenAt = at
  }
  for (const fid of requiredFieldIds) {
    if (!(fid in values)) return { error: 'decision_values_missing' }
  }
  return Object.freeze({
    nodeKey,
    entryEpoch: epoch,
    values: Object.freeze(values),
    frozenAt,
  })
}

function buildProductionGateChecks(
  queryFn: AutomationDeps['queryFn'],
  mode: 'create' | 'update' | 'decision',
): FwbGateChecks {
  return {
    async isAdmin(userId) {
      return isAdmin(userId)
    },
    async canManageSheetAccess(userId, sheetId) {
      const { capabilities } = await resolveSheetCapabilitiesForUser(queryFn, sheetId, userId)
      return capabilities.canManageSheetAccess === true
    },
    async canReadTemplate(userId, templateId) {
      // Same trusted-actor visibility predicate as AutomationService (not a mere existence check).
      return isApprovalTemplateVisibleToUser(queryFn, templateId, userId)
    },
    async canWriteSheet(userId, sheetId) {
      const { capabilities } = await resolveSheetCapabilitiesForUser(queryFn, sheetId, userId)
      if (mode === 'create') return capabilities.canCreateRecord === true
      return capabilities.canEditRecord === true
    },
    // Q6 confirmation is verified explicitly via verifyFwbConfirmation before gates run.
    async hasRecordedConfirmation() {
      return true
    },
  }
}

export function buildProductionLinkChecks(queryFn: AutomationDeps['queryFn']): RecordLinkChecks {
  return {
    async fillerCanReadRecord(fillerUserId, sheetId, recordId) {
      const rec = await queryFn(
        `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      if (rec.rows.length === 0) return false
      const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(queryFn, sheetId, fillerUserId)
      if (isAdminRole) return true
      if (!capabilities.canRead) return false
      // Row-level read-deny (confused-deputy close).
      if (await isRecordReadDeniedForUser(queryFn, sheetId, recordId, fillerUserId)) return false
      return true
    },
    async recordExists(trx, sheetId, recordId) {
      const res = await trx.query(`SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2`, [recordId, sheetId])
      return res.rows.length > 0
    },
    async recordIsLocked(trx, sheetId, recordId) {
      const res = await trx.query(
        `SELECT locked, locked_by, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      const row = res.rows[0] as { locked?: unknown; locked_by?: unknown; created_by?: unknown } | undefined
      if (!row) return true
      // Treat locked-for-actor using ensureRecordNotLocked semantics (automation actor = null → hard lock).
      return row.locked === true && !canEditWhileLocked(null, lockableFromRow(row))
    },
    async configurerCanWriteRecord(configurerUserId, sheetId, recordId) {
      const rec = await queryFn(
        `SELECT created_by FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      if (rec.rows.length === 0) return false
      const createdBy = (rec.rows[0] as { created_by?: string | null }).created_by ?? null
      const { capabilities, sheetScope, isAdminRole } = await resolveSheetCapabilitiesForUser(
        queryFn,
        sheetId,
        configurerUserId,
      )
      return canWriteRecord(capabilities, sheetScope, isAdminRole, configurerUserId, createdBy)
    },
  }
}

/**
 * Under FOR UPDATE: lock the target row once, recheck existence / lock / write permission,
 * then apply values + revision. Failures throw FWB_TARGET_UNAVAILABLE (values-free).
 */
async function updateBoundRecordUnderLock(
  trx: TransactionalQueryable,
  input: {
    sheetId: string
    recordId: string
    values: Record<string, string | number>
    configurerUserId: string
    queryFn: AutomationDeps['queryFn']
  },
): Promise<void> {
  const existing = await trx.query(
    `SELECT data, version, locked, locked_by, created_by
       FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`,
    [input.recordId, input.sheetId],
  )
  if (existing.rows.length === 0) {
    throw new Error(FWB_TARGET_UNAVAILABLE)
  }
  const row = existing.rows[0] as {
    data: Record<string, unknown>
    version: number
    locked?: unknown
    locked_by?: unknown
    created_by?: unknown
  }
  ensureRecordNotLocked(
    input.configurerUserId,
    row,
    () => new Error(FWB_TARGET_UNAVAILABLE),
  )
  const { capabilities, sheetScope, isAdminRole } = await resolveSheetCapabilitiesForUser(
    input.queryFn,
    input.sheetId,
    input.configurerUserId,
  )
  const createdBy = typeof row.created_by === 'string' ? row.created_by : null
  if (!canWriteRecord(capabilities, sheetScope, isAdminRole, input.configurerUserId, createdBy)) {
    throw new Error(FWB_TARGET_UNAVAILABLE)
  }
  if (!capabilities.canEditRecord && !isAdminRole) {
    throw new Error(FWB_TARGET_UNAVAILABLE)
  }
  const nextData = { ...(isRecord(row.data) ? row.data : {}), ...input.values }
  const nextVersion = Number(row.version ?? 0) + 1
  // lock-guarded: FWB update calls ensureRecordNotLocked for the effective rule-configurer actor.
  // revision-emitted: FWB update records the new version below in this same transaction.
  await trx.query(
    `UPDATE meta_records SET data = $3::jsonb, version = $4, updated_at = now()
      WHERE id = $1 AND sheet_id = $2`,
    [input.recordId, input.sheetId, JSON.stringify(nextData), nextVersion],
  )
  await recordRecordRevision(queryFromTrx(trx), {
    sheetId: input.sheetId,
    recordId: input.recordId,
    version: nextVersion,
    action: 'update',
    source: 'automation',
    actorId: input.configurerUserId,
    changedFieldIds: Object.keys(input.values),
    patch: input.values,
    snapshot: nextData,
  })
}

async function enqueueFwbOutboxRequired(
  trx: TransactionalQueryable,
  event: { eventType: string; eventId: string; payload: unknown; automationDepth: number },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // D9/D10: durable outbox in the SAME transaction is mandatory. Fail/rollback if not enqueued.
  if (!isDurableDeliveryEnabled(env)) {
    throw new Error('FWB requires AUTOMATION_DURABLE_DELIVERY_ENABLED=true for same-transaction outbox')
  }
  const payload = event.payload as Record<string, unknown>
  const stamped = withAutomationEventId({
    ...payload,
    _eventId: event.eventId,
    _automationDepth: event.automationDepth,
  })
  const res = await produceAutomationEvent(
    trx,
    {
      eventType: event.eventType,
      eventId: event.eventId,
      payload: stamped,
      automationDepth: event.automationDepth,
    },
    env,
  )
  if (res === null) {
    throw new Error('FWB durable outbox enqueue failed — rolling back write')
  }
}

/**
 * Activation gate: FWB flag ON + durable delivery ON.
 * Use for runtime execution and for enabling (enabled=true) a FWB rule.
 * Do NOT use for disabled draft saves — use requireFwbActivationForEnabledRule(false) which is a no-op.
 */
export function assertFwbRuntimeActivatable(env: NodeJS.ProcessEnv = process.env): string | null {
  // Same policy as enabled-save; reuses the staging-aware helper with enabled=true.
  return requireFwbActivationForEnabledRule(true, env)
}

export { requireFwbActivationForEnabledRule }

export async function runWriteApprovalFormValues(
  deps: FwbRuntimeDeps,
  context: ExecutionContext,
  rawConfig: unknown,
  structuralPath: string,
): Promise<FwbRuntimeStepResult> {
  const env = deps.env ?? process.env
  const activationErr = assertFwbRuntimeActivatable(env)
  if (activationErr) {
    return { status: 'failed', error: activationErr, output: { reason: 'fwb_disabled' } }
  }

  const parsed = parseWriteApprovalFormValuesConfig(rawConfig)
  if (!parsed.ok) return { status: 'failed', error: (parsed as { ok: false; error: string }).error }
  const config = parsed.config

  const instanceId = extractApprovalInstanceId(context.triggerEvent)
  if (!instanceId) {
    return { status: 'failed', error: 'write_approval_form_values requires approval.completed trigger' }
  }
  const sourceTemplateId = extractApprovalTemplateId(context.triggerEvent)
  if (!sourceTemplateId) {
    return { status: 'failed', error: 'write_approval_form_values requires approval.templateId' }
  }
  const configurerUserId = context.ruleCreatedBy
  if (!configurerUserId || !NON_BLANK.test(configurerUserId)) {
    return { status: 'failed', error: 'write_approval_form_values requires rule creator identity' }
  }

  const depth = (() => {
    const te = context.triggerEvent
    if (isRecord(te) && typeof te._automationDepth === 'number' && Number.isFinite(te._automationDepth)) {
      return te._automationDepth
    }
    return 0
  })()
  const outDepth = depth + 1

  let targetSheetId = context.sheetId
  let boundRecordId: string | null = null
  let declaredTargetBaseId: string | undefined = config.targetBaseId

  if (config.mode === 'update' || config.mode === 'decision') {
    const binding = await loadRecordLinkBinding(deps.queryFn, instanceId, config.recordLinkFieldId!)
    if ('error' in binding) {
      return { status: 'failed', error: FWB_TARGET_UNAVAILABLE, output: { reason: FWB_TARGET_UNAVAILABLE } }
    }
    targetSheetId = binding.sheetId
    boundRecordId = binding.recordId
    // The record-link field is server authority; never preserve a client-supplied base claim.
    declaredTargetBaseId = binding.baseId
  }

  // Server meta_fields authority — config types ignored.
  const fieldRes = await loadTargetFieldsFromMeta(
    deps.queryFn,
    targetSheetId,
    config.mappings.map((m) => m.targetFieldId),
  )
  if (!fieldRes.ok) {
    const fail = fieldRes as { ok: false; code: string; fieldId?: string }
    return {
      status: 'failed',
      error: 'FWB target field missing or unsupported type',
      output: { reason: 'target_schema', code: fail.code },
    }
  }
  const authoritativeMappings = buildAuthoritativeMappings(config.mappings, fieldRes.fields)

  const tplVer = await loadInstanceTemplateVersion(deps.queryFn, instanceId)
  if (!tplVer) {
    return { status: 'failed', error: 'approval template version missing' }
  }
  const subject: FwbConfirmationSubject = {
    templateId: sourceTemplateId,
    templateVersionId: tplVer.templateVersionId,
    targetBaseId: declaredTargetBaseId ?? null,
    targetSheetId,
    mappings: config.mappings,
  }
  const conf = await verifyFwbConfirmation(deps.queryFn, {
    confirmationId: config.confirmationId,
    configurerUserId,
    subject,
  })
  if (!conf.ok) {
    const fail = conf as { ok: false; code: string }
    return {
      status: 'failed',
      error: 'FWB Q6 confirmation invalid or stale',
      output: { reason: 'confirmation', code: fail.code },
    }
  }

  const gate = await deps.evaluateCrossBaseWriteGate(
    configurerUserId,
    context.sheetId,
    targetSheetId,
    declaredTargetBaseId,
  )
  if (gate.crossBase && gate.ok === false) {
    return { status: 'failed', error: FWB_TARGET_UNAVAILABLE, output: { reason: 'cross_base_denied' } }
  }

  // Mode-specific sheet capability.
  {
    const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(
      deps.queryFn,
      targetSheetId,
      configurerUserId,
    )
    if (!isAdminRole) {
      if (config.mode === 'create' && !capabilities.canCreateRecord) {
        return { status: 'failed', error: FWB_TARGET_UNAVAILABLE, output: { reason: FWB_TARGET_UNAVAILABLE } }
      }
      if ((config.mode === 'update' || config.mode === 'decision') && !capabilities.canEditRecord) {
        return { status: 'failed', error: FWB_TARGET_UNAVAILABLE, output: { reason: FWB_TARGET_UNAVAILABLE } }
      }
    }
  }

  const actionKey = deriveActionKey({
    structuralPath,
    actionType: 'write_approval_form_values',
    canonicalConfig: config,
  })
  const claimId = `fwb_${randomUUID()}`
  const eventId = (() => {
    const te = context.triggerEvent
    if (isRecord(te) && typeof te.eventId === 'string' && te.eventId) {
      return `${te.eventId}:fwb:${createHash('sha256').update(actionKey).digest('hex').slice(0, 12)}`
    }
    return `fwb_evt_${randomUUID()}`
  })()

  const gateSubject: FwbGateSubject = {
    configurerUserId,
    ruleId: context.ruleId,
    sourceTemplateId,
    targetSheetId,
  }
  const gates = deps.gateChecks ?? buildProductionGateChecks(deps.queryFn, config.mode)
  const linkChecks = deps.linkChecks ?? buildProductionLinkChecks(deps.queryFn)

  let formValues: Record<string, unknown> = {}
  let decisionSnapshot: FrozenDecisionSnapshot | null = null
  if (config.mode === 'decision') {
    const required = authoritativeMappings.map((m) => m.formFieldId)
    const loaded = await loadFrozenDecisionForCurrentEpoch(
      deps.queryFn,
      instanceId,
      config.decisionNodeKey!,
      required,
    )
    if ('error' in loaded) {
      return {
        status: 'failed',
        error: 'no frozen decision values for current node entry epoch',
        output: { reason: loaded.error },
      }
    }
    decisionSnapshot = loaded
  } else {
    const snap = await loadFormSnapshot(deps.queryFn, instanceId)
    if (!snap) return { status: 'failed', error: 'approval form_snapshot not found' }
    const allowed = new Set(config.mappings.map((m) => m.formFieldId))
    for (const [k, v] of Object.entries(snap)) {
      if (allowed.has(k)) formValues[k] = v
    }
  }

  if (config.mode === 'decision' && decisionSnapshot) {
    decisionSnapshot = {
      ...decisionSnapshot,
      values: sanitizeFwbSourceValues(authoritativeMappings, decisionSnapshot.values),
    }
  } else {
    formValues = sanitizeFwbSourceValues(authoritativeMappings, formValues)
  }

  const mappedPre = mapApprovalFormValues(
    authoritativeMappings,
    config.mode === 'decision' && decisionSnapshot ? decisionSnapshot.values : formValues,
  )
  if (!mappedPre.ok) {
    return {
      status: 'failed',
      error: 'FWB mapping rejected',
      output: { reason: 'mapping', errors: (mappedPre as { ok: false; errors: unknown }).errors },
    }
  }

  const chainEventPayload: Record<string, unknown> = {
    sheetId: targetSheetId,
    recordId: boundRecordId ?? '',
    actorId: configurerUserId,
    _automationDepth: outDepth,
    source: 'write_approval_form_values',
    approvalInstanceId: instanceId,
  }

  try {
    const result = await deps.transaction(async ({ query }) => {
      const trx = asTrx(query)
      const createSeam: FwbRecordWriteSeam = {
        async createRecordWithRevision(t, sheetId, values) {
          const recordId = `rec_${randomUUID()}`
          // revision-emitted: FWB create records version 1 below in this same transaction.
          await t.query(
            `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)`,
            [recordId, sheetId, JSON.stringify(values)],
          )
          await recordRecordRevision(queryFromTrx(t), {
            sheetId,
            recordId,
            version: 1,
            action: 'create',
            source: 'automation',
            actorId: configurerUserId,
            changedFieldIds: Object.keys(values),
            patch: values,
            snapshot: values,
          })
          chainEventPayload.recordId = recordId
          chainEventPayload.data = values
          return recordId
        },
        async enqueueOutbox(t, e) {
          await enqueueFwbOutboxRequired(
            t as TransactionalQueryable,
            {
              eventType: e.eventType,
              eventId: e.eventId,
              payload: { ...chainEventPayload, sheetId: targetSheetId, recordId: chainEventPayload.recordId },
              automationDepth: e.automationDepth,
            },
            env,
          )
        },
      }
      const updateSeam: FwbUpdateSeam = {
        async updateRecordWithRevision(t, sheetId, recordId, values) {
          await updateBoundRecordUnderLock(t as TransactionalQueryable, {
            sheetId,
            recordId,
            values,
            configurerUserId,
            queryFn: deps.queryFn,
          })
          chainEventPayload.recordId = recordId
          chainEventPayload.data = values
        },
        async enqueueOutbox(t, e) {
          await enqueueFwbOutboxRequired(
            t as TransactionalQueryable,
            {
              eventType: e.eventType,
              eventId: e.eventId,
              payload: { ...chainEventPayload, sheetId: targetSheetId, recordId: boundRecordId },
              automationDepth: e.automationDepth,
            },
            env,
          )
        },
      }

      if (config.mode === 'create') {
        const input: FwbWriteActionInput = {
          claimId,
          instanceId,
          ruleId: context.ruleId,
          actionKey,
          gateSubject,
          mappings: authoritativeMappings,
          formValues,
          eventId,
          automationDepth: outDepth,
        }
        return executeWriteApprovalFormValues(trx, input, gates, createSeam)
      }
      if (config.mode === 'update') {
        // Skip separate pre-lock exists/locked checks that race; update seam locks once under FOR UPDATE.
        const skipLink: RecordLinkChecks = {
          ...linkChecks,
          recordExists: async () => true,
          recordIsLocked: async () => false,
          configurerCanWriteRecord: async () => true,
        }
        const input: FwbUpdateActionInput = {
          claimId,
          instanceId,
          ruleId: context.ruleId,
          actionKey,
          gateSubject,
          boundRecordId: boundRecordId!,
          mappings: authoritativeMappings,
          formValues,
          eventId,
          automationDepth: outDepth,
        }
        return executeUpdateBoundRecord(trx, input, gates, skipLink, updateSeam)
      }
      const skipLink: RecordLinkChecks = {
        ...linkChecks,
        recordExists: async () => true,
        recordIsLocked: async () => false,
        configurerCanWriteRecord: async () => true,
      }
      const input: FwbDecisionWriteInput = {
        claimId,
        instanceId,
        ruleId: context.ruleId,
        actionKey,
        gateSubject,
        boundRecordId: boundRecordId!,
        snapshot: decisionSnapshot!,
        mappings: authoritativeMappings,
        eventId,
        automationDepth: outDepth,
      }
      return executeWriteDecisionValues(trx, input, gates, skipLink, updateSeam)
    })

    if (result.status === 'already_applied') {
      return { status: 'success', alreadyApplied: true, output: { alreadyApplied: true } }
    }
    if (result.status === 'rejected') {
      // Normalize bound-record rejects to values-free shape.
      const reason = result.reason
      const external =
        reason === 'record_missing' || reason === 'record_locked' || reason === 'record_not_writable' || reason === 'link_not_readable'
          ? FWB_TARGET_UNAVAILABLE
          : `FWB rejected: ${reason}`
      return {
        status: 'failed',
        error: external,
        output: { reason: external === FWB_TARGET_UNAVAILABLE ? FWB_TARGET_UNAVAILABLE : reason },
      }
    }

    // NO legacy emit — durable outbox was required in-transaction.
    const recordId =
      result.status === 'applied' && 'recordId' in result ? result.recordId : boundRecordId
    return {
      status: 'success',
      output: {
        mode: config.mode,
        recordId,
        sheetId: targetSheetId,
        instanceId,
        actionKey,
        ...(config.mode === 'decision' && decisionSnapshot
          ? { nodeKey: decisionSnapshot.nodeKey, entryEpoch: decisionSnapshot.entryEpoch }
          : {}),
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === FWB_TARGET_UNAVAILABLE) {
      return { status: 'failed', error: FWB_TARGET_UNAVAILABLE, output: { reason: FWB_TARGET_UNAVAILABLE } }
    }
    // Never surface raw DB err.message with ids to external step error in production paths —
    // keep a values-free generic for unknown failures.
    return {
      status: 'failed',
      error: msg.startsWith('FWB ') || msg.includes('requires') || msg.includes('disabled')
        ? msg
        : 'FWB write failed',
      output: { reason: 'write_failed' },
    }
  }
}

/**
 * Persist freeze snapshot inside dispatchAction lock txn.
 * Fails closed on UNIQUE conflict (concurrent freeze) — no silent ON CONFLICT DO NOTHING.
 */
export async function persistFrozenDecisionValues(
  trx: Queryable,
  input: {
    instanceId: string
    assignmentId?: string | null
    actorId?: string | null
    snapshot: FrozenDecisionSnapshot
  },
): Promise<void> {
  for (const [fieldId, value] of Object.entries(input.snapshot.values)) {
    await trx.query(
      `INSERT INTO approval_node_decision_values
         (id, instance_id, node_key, entry_epoch, assignment_id, field_id, value, actor_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        `adv_${randomUUID()}`,
        input.instanceId,
        input.snapshot.nodeKey,
        input.snapshot.entryEpoch,
        input.assignmentId ?? null,
        fieldId,
        JSON.stringify(value ?? null),
        input.actorId ?? null,
        input.snapshot.frozenAt,
      ],
    )
  }
}

export async function assertRecordLinksReadableAtSubmit(
  checks: Pick<RecordLinkChecks, 'fillerCanReadRecord'>,
  fillerUserId: string,
  links: readonly { sheetId: string; recordId: string }[],
): Promise<{ ok: true } | { ok: false; code: 'link_not_readable' }> {
  for (const link of links) {
    const r = await validateRecordLinkAtSubmit(checks, fillerUserId, link.sheetId, link.recordId)
    if (!r.ok) return r
  }
  return { ok: true }
}
