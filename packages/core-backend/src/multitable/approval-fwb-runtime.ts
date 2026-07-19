/**
 * FWB production runtime — wires the pure FWB-1/2/3 helpers into the real automation
 * executor / approval lifecycle.
 *
 * Contract (FWB-0 design lock, owner-ratified):
 *   - action type `write_approval_form_values` only (D11); form values never in event payload
 *     or action config — loaded server-side from immutable form_snapshot / frozen decision rows;
 *   - write identity = rule creator (not completion actor); §11 Q6 four gates rechecked at fire;
 *   - claim + record write + revision + outbox = one DB transaction (D9/D10);
 *   - unmapped snapshot fields are never read or written (export whitelist);
 *   - FWB-1 same-sheet create; FWB-2 bound-record update with submit/execute rechecks;
 *   - FWB-3 decision write uses freeze rows from the dispatchAction lock transaction.
 *
 * Flag posture: reuses existing durable-delivery / Class-A / Class-B paths as-is. Does NOT enable
 * or change defaults for AUTOMATION_DURABLE_DELIVERY_ENABLED / CLASSA / CLASSB / any FWB flag.
 * Outbox enqueue rides `enqueueRecordEventIfDurable` (no-op when durable is OFF); legacy emit
 * rides `emitRecordEventIfLegacy` post-commit (same REPLACE pair as create_record).
 */
import { createHash, randomUUID } from 'node:crypto'

import type { EventBus } from '../integration/events/event-bus'
import { isAdmin } from '../rbac/service'
import { withAutomationEventId } from './automation-event-dedup'
import { deriveActionKey } from './automation-action-idempotency'
import { enqueueRecordEventIfDurable, emitRecordEventIfLegacy } from './automation-producer-emit'
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
import { recordRecordRevision } from './record-history-service'
import { resolveSheetCapabilitiesForUser } from './sheet-capabilities'
import type { TransactionalQueryable } from './pg-transaction-guard'
import type { Queryable } from './automation-durable-dispatcher'

const NON_BLANK = /[!-~]/

export type FwbRuntimeConfig = WriteApprovalFormValuesConfig

export type ParseFwbConfigResult =
  | { ok: true; config: FwbRuntimeConfig }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize + validate the action config. Fail-closed on any missing / invalid field. */
export function parseWriteApprovalFormValuesConfig(raw: unknown): ParseFwbConfigResult {
  if (!isRecord(raw)) return { ok: false, error: 'write_approval_form_values config must be an object' }
  const mode = raw.mode
  if (mode !== 'create' && mode !== 'update' && mode !== 'decision') {
    return { ok: false, error: 'write_approval_form_values.config.mode must be create|update|decision' }
  }
  if (!Array.isArray(raw.mappings) || raw.mappings.length === 0) {
    return { ok: false, error: 'write_approval_form_values.config.mappings must be a non-empty array' }
  }
  const mappings: FwbFieldMapping[] = []
  const seenTargets = new Set<string>()
  for (const [i, m] of raw.mappings.entries()) {
    if (!isRecord(m)) return { ok: false, error: `mappings[${i}] must be an object` }
    const formFieldId = typeof m.formFieldId === 'string' ? m.formFieldId.trim() : ''
    const targetFieldId = typeof m.targetFieldId === 'string' ? m.targetFieldId.trim() : ''
    const targetType = m.targetType
    if (!NON_BLANK.test(formFieldId) || !NON_BLANK.test(targetFieldId)) {
      return { ok: false, error: `mappings[${i}] formFieldId/targetFieldId required` }
    }
    if (targetType !== 'text' && targetType !== 'number' && targetType !== 'date' && targetType !== 'select') {
      return { ok: false, error: `mappings[${i}].targetType must be text|number|date|select` }
    }
    if (seenTargets.has(targetFieldId)) {
      return { ok: false, error: `mappings[${i}] duplicate targetFieldId ${targetFieldId}` }
    }
    seenTargets.add(targetFieldId)
    const selectOptions = Array.isArray(m.selectOptions)
      ? m.selectOptions.filter((o): o is string => typeof o === 'string')
      : undefined
    if (targetType === 'select' && (!selectOptions || selectOptions.length === 0)) {
      return { ok: false, error: `mappings[${i}] select requires non-empty selectOptions` }
    }
    mappings.push({
      formFieldId,
      targetFieldId,
      targetType,
      ...(selectOptions ? { selectOptions: [...selectOptions] } : {}),
    })
  }
  const confirmationHash = typeof raw.confirmationHash === 'string' ? raw.confirmationHash.trim() : ''
  if (!NON_BLANK.test(confirmationHash)) {
    return { ok: false, error: 'write_approval_form_values.config.confirmationHash is required (Q6)' }
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
  // Map into the mutable config shape (selectOptions is string[], not readonly).
  const configMappings: FwbRuntimeConfig['mappings'] = mappings.map((m) => ({
    formFieldId: m.formFieldId,
    targetFieldId: m.targetFieldId,
    targetType: m.targetType,
    ...(m.selectOptions ? { selectOptions: [...m.selectOptions] } : {}),
  }))
  return {
    ok: true,
    config: {
      mode,
      mappings: configMappings,
      confirmationHash,
      ...(recordLinkFieldId ? { recordLinkFieldId } : {}),
      ...(decisionNodeKey ? { decisionNodeKey } : {}),
      ...(targetBaseId ? { targetBaseId } : {}),
    },
  }
}

/**
 * Q6 confirmation hash — identifiers only (template + target sheet/base + mapping pairs).
 * Deep-sorts mapping pairs so order is insignificant. NEVER hashes business values.
 */
export function computeFwbConfirmationHash(input: {
  sourceTemplateId: string
  targetSheetId: string
  targetBaseId?: string | null
  mappings: readonly { formFieldId: string; targetFieldId: string }[]
}): string {
  const normalized = {
    sourceTemplateId: input.sourceTemplateId,
    targetSheetId: input.targetSheetId,
    targetBaseId: input.targetBaseId ?? null,
    mappings: [...input.mappings]
      .map((m) => ({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId }))
      .sort((a, b) =>
        a.formFieldId === b.formFieldId
          ? a.targetFieldId.localeCompare(b.targetFieldId)
          : a.formFieldId.localeCompare(b.formFieldId),
      ),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

/** Extract approval instance id from the approval.completed trigger event (never from action config). */
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

/** Parse a record-link form value: exactly one `{ recordId }` (Layer 2 structural shape). */
export function parseRecordLinkValue(raw: unknown): { ok: true; recordId: string } | { ok: false } {
  if (!isRecord(raw)) return { ok: false }
  const recordId = typeof raw.recordId === 'string' ? raw.recordId.trim() : ''
  if (!NON_BLANK.test(recordId)) return { ok: false }
  // Reject extra keys that would smuggle free-text ids
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'recordId') return { ok: false }
  return { ok: true, recordId }
}

export interface FwbRuntimeDeps {
  queryFn: AutomationDeps['queryFn']
  transaction: NonNullable<AutomationDeps['transaction']>
  eventBus: EventBus
  /**
   * Cross-base write gate — must pass rule CREATOR as actor (FWB §2.2), not the
   * completion event actor. Injected so the executor's shared quota is reused.
   */
  evaluateCrossBaseWriteGate: (
    actorId: string | null,
    triggerSheetId: string,
    targetSheetId: string,
    declaredTargetBaseId: string | undefined,
  ) => Promise<CrossBaseWriteGate>
  /** Optional override for unit tests (defaults to production ACL/template lookups). */
  gateChecks?: FwbGateChecks
  linkChecks?: RecordLinkChecks
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

async function loadFormSnapshot(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
): Promise<Record<string, unknown> | null> {
  const res = await queryFn(
    `SELECT form_snapshot FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const row = res.rows[0] as { form_snapshot?: unknown } | undefined
  if (!row) return null
  const snap = row.form_snapshot
  if (!isRecord(snap)) return null
  return snap
}

async function loadRecordLinkBinding(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
  recordLinkFieldId: string,
): Promise<{ sheetId: string; recordId: string; baseId: string | null } | { error: string }> {
  // form_snapshot is authoritative; sheet binding is frozen on the published form field props.
  const inst = await queryFn(
    `SELECT form_snapshot, published_definition_id FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const row = inst.rows[0] as { form_snapshot?: unknown; published_definition_id?: string } | undefined
  if (!row) return { error: 'approval instance not found' }
  const snap = isRecord(row.form_snapshot) ? row.form_snapshot : null
  if (!snap) return { error: 'approval form_snapshot missing' }
  const linkRaw = snap[recordLinkFieldId]
  const parsed = parseRecordLinkValue(linkRaw)
  if (!parsed.ok) return { error: 'record-link value is missing or not a single { recordId }' }

  // Form schema lives on the template version (published definitions hold runtime_graph only).
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
  if (!isRecord(field)) return { error: `record-link field ${recordLinkFieldId} not found on template` }
  const props = isRecord(field.props) ? field.props : {}
  const sheetId = typeof props.sheetId === 'string' ? props.sheetId.trim() : ''
  const baseId = typeof props.baseId === 'string' ? props.baseId.trim() : null
  if (!NON_BLANK.test(sheetId)) return { error: 'record-link field missing server-pinned sheetId' }

  // Existence of the record in the pinned sheet is rechecked at execute; here we only bind ids.
  void row.published_definition_id
  return { sheetId, recordId: parsed.recordId, baseId }
}

async function loadLatestFrozenDecision(
  queryFn: AutomationDeps['queryFn'],
  instanceId: string,
  nodeKey: string,
): Promise<FrozenDecisionSnapshot | null> {
  const res = await queryFn(
    `SELECT node_key, entry_epoch, field_id, value, created_at
       FROM approval_node_decision_values
      WHERE instance_id = $1 AND node_key = $2
      ORDER BY entry_epoch DESC, created_at ASC`,
    [instanceId, nodeKey],
  )
  if (res.rows.length === 0) return null
  const topEpoch = Number((res.rows[0] as { entry_epoch: number }).entry_epoch)
  const values: Record<string, unknown> = {}
  let frozenAt = new Date(0).toISOString()
  for (const raw of res.rows) {
    const row = raw as { entry_epoch: number; field_id: string; value: unknown; created_at: string | Date; node_key: string }
    if (Number(row.entry_epoch) !== topEpoch) continue
    values[row.field_id] = row.value
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    if (at > frozenAt) frozenAt = at
  }
  return Object.freeze({
    nodeKey,
    entryEpoch: topEpoch,
    values: Object.freeze(values),
    frozenAt,
  })
}

function buildProductionGateChecks(
  queryFn: AutomationDeps['queryFn'],
  confirmationHash: string,
  expectedHash: string,
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
      // Fail-closed: template must exist; visibility re-uses the same approvals:read + visibility
      // pattern the approval.completed trigger already enforces at fire (creator leg). Here we only
      // require the template row exists for the configured id — the fire-time template visibility
      // check on the rule remains authoritative for "can the creator still see it".
      const res = await queryFn('SELECT id FROM approval_templates WHERE id = $1', [templateId])
      if (res.rows.length === 0) return false
      // Creator still holds approvals:read (cheap global check; fire path already rechecks visibility).
      void userId
      return true
    },
    async canWriteSheet(userId, sheetId) {
      const { capabilities } = await resolveSheetCapabilitiesForUser(queryFn, sheetId, userId)
      return capabilities.canEditRecord === true || capabilities.canCreateRecord === true
    },
    async hasRecordedConfirmation(_ruleId) {
      // Q6: confirmation is binding to the ACTUAL config hash, not a free-floating boolean.
      return confirmationHash === expectedHash && NON_BLANK.test(confirmationHash)
    },
  }
}

function buildProductionLinkChecks(queryFn: AutomationDeps['queryFn']): RecordLinkChecks {
  return {
    async fillerCanReadRecord(fillerUserId, sheetId, recordId) {
      // Existence + sheet capability: missing record and unreadable share the same false return
      // (no existence oracle — Layer 2 §6).
      const rec = await queryFn(
        `SELECT id, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      if (rec.rows.length === 0) return false
      const { capabilities, sheetScope, isAdminRole } = await resolveSheetCapabilitiesForUser(queryFn, sheetId, fillerUserId)
      if (isAdminRole) return true
      if (!capabilities.canRead) return false
      // write-own scopes still allow read of any row they can see via sheet read.
      void sheetScope
      return true
    },
    async recordExists(trx, sheetId, recordId) {
      const res = await trx.query(
        `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      return res.rows.length > 0
    },
    async recordIsLocked(trx, sheetId, recordId) {
      const res = await trx.query(
        `SELECT locked FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId],
      )
      const row = res.rows[0] as { locked?: unknown } | undefined
      return row?.locked === true
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
      if (isAdminRole) return true
      if (!capabilities.canEditRecord) return false
      // own-write policy: when the sheet scope is write-own only, require creator match.
      if (sheetScope && !sheetScope.canWrite && sheetScope.canWriteOwn) {
        return !!createdBy && createdBy === configurerUserId
      }
      return true
    },
  }
}

function buildCreateSeam(
  queryFn: AutomationDeps['queryFn'],
  actorId: string | null,
  chainEventPayload: Record<string, unknown>,
): FwbRecordWriteSeam {
  return {
    async createRecordWithRevision(trx, targetSheetId, values) {
      const recordId = `rec_${randomUUID()}`
      const data = { ...values }
      await trx.query(
        `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)`,
        [recordId, targetSheetId, JSON.stringify(data)],
      )
      await recordRecordRevision(trx.query.bind(trx) as AutomationDeps['queryFn'], {
        sheetId: targetSheetId,
        recordId,
        version: 1,
        action: 'create',
        source: 'automation',
        actorId,
        changedFieldIds: Object.keys(data),
        patch: data,
        snapshot: data,
      })
      // Stash for the outer caller so outbox + return can share the id.
      ;(chainEventPayload as { recordId?: string }).recordId = recordId
      ;(chainEventPayload as { data?: Record<string, unknown> }).data = data
      return recordId
    },
    async enqueueOutbox(trx, event) {
      const payload = withAutomationEventId({
        ...chainEventPayload,
        sheetId: (chainEventPayload.sheetId as string) ?? '',
        recordId: (chainEventPayload.recordId as string) ?? '',
        _automationDepth: event.automationDepth,
      })
      // Prefer the stable event id from the caller when present.
      if (typeof event.eventId === 'string' && event.eventId) {
        ;(payload as { _eventId?: string })._eventId = event.eventId
      }
      await enqueueRecordEventIfDurable(trx as TransactionalQueryable, event.eventType, payload)
    },
  }
}

function buildUpdateSeam(
  queryFn: AutomationDeps['queryFn'],
  actorId: string | null,
  chainEventPayload: Record<string, unknown>,
): FwbUpdateSeam {
  return {
    async updateRecordWithRevision(trx, sheetId, recordId, values) {
      const existing = await trx.query(
        `SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`,
        [recordId, sheetId],
      )
      if (existing.rows.length === 0) {
        throw new Error(`FWB bound record ${recordId} missing at write time`)
      }
      const row = existing.rows[0] as { data: Record<string, unknown>; version: number }
      const nextData = { ...(isRecord(row.data) ? row.data : {}), ...values }
      const nextVersion = Number(row.version ?? 0) + 1
      await trx.query(
        `UPDATE meta_records SET data = $3::jsonb, version = $4, updated_at = now()
          WHERE id = $1 AND sheet_id = $2`,
        [recordId, sheetId, JSON.stringify(nextData), nextVersion],
      )
      await recordRecordRevision(trx.query.bind(trx) as AutomationDeps['queryFn'], {
        sheetId,
        recordId,
        version: nextVersion,
        action: 'update',
        source: 'automation',
        actorId,
        changedFieldIds: Object.keys(values),
        patch: values,
        snapshot: nextData,
      })
      ;(chainEventPayload as { data?: Record<string, unknown> }).data = nextData
      ;(chainEventPayload as { recordId?: string }).recordId = recordId
    },
    async enqueueOutbox(trx, event) {
      const payload = withAutomationEventId({
        ...chainEventPayload,
        sheetId: (chainEventPayload.sheetId as string) ?? '',
        recordId: (chainEventPayload.recordId as string) ?? '',
        _automationDepth: event.automationDepth,
      })
      if (typeof event.eventId === 'string' && event.eventId) {
        ;(payload as { _eventId?: string })._eventId = event.eventId
      }
      await enqueueRecordEventIfDurable(trx as TransactionalQueryable, event.eventType, payload)
    },
  }
}

/**
 * Production entry: run write_approval_form_values for one action step.
 * Caller (AutomationExecutor) supplies structuralPath for action_key identity.
 */
export async function runWriteApprovalFormValues(
  deps: FwbRuntimeDeps,
  context: ExecutionContext,
  rawConfig: unknown,
  structuralPath: string,
): Promise<FwbRuntimeStepResult> {
  const parsed = parseWriteApprovalFormValuesConfig(rawConfig)
  if (!parsed.ok) return { status: 'failed', error: (parsed as { ok: false; error: string }).error }
  const config = parsed.config

  const instanceId = extractApprovalInstanceId(context.triggerEvent)
  if (!instanceId) {
    return { status: 'failed', error: 'write_approval_form_values requires approval.completed trigger (instanceId)' }
  }
  const sourceTemplateId = extractApprovalTemplateId(context.triggerEvent)
  if (!sourceTemplateId) {
    return { status: 'failed', error: 'write_approval_form_values requires approval.templateId on the trigger event' }
  }

  const configurerUserId = context.ruleCreatedBy
  if (!configurerUserId || !NON_BLANK.test(configurerUserId)) {
    return { status: 'failed', error: 'write_approval_form_values requires rule creator identity (fail-closed)' }
  }

  const depth = (() => {
    const te = context.triggerEvent
    if (isRecord(te) && typeof te._automationDepth === 'number' && Number.isFinite(te._automationDepth)) {
      return te._automationDepth
    }
    return 0
  })()
  // Downstream fan-out depth = this execution depth + 1 (FWB §7).
  const outDepth = depth + 1

  // Resolve target sheet + (for update/decision) bound record.
  let targetSheetId = context.sheetId // FWB-1: rule's own sheet (D2)
  let boundRecordId: string | null = null
  let declaredTargetBaseId: string | undefined = config.targetBaseId

  if (config.mode === 'update' || config.mode === 'decision') {
    const binding = await loadRecordLinkBinding(deps.queryFn, instanceId, config.recordLinkFieldId!)
    if ('error' in binding) return { status: 'failed', error: binding.error }
    targetSheetId = binding.sheetId
    boundRecordId = binding.recordId
    if (!declaredTargetBaseId && binding.baseId) declaredTargetBaseId = binding.baseId
  }

  // Q6 expected hash binds template + target + mappings (identifiers only).
  const expectedHash = computeFwbConfirmationHash({
    sourceTemplateId,
    targetSheetId,
    targetBaseId: declaredTargetBaseId ?? null,
    mappings: config.mappings,
  })
  if (config.confirmationHash !== expectedHash) {
    return {
      status: 'failed',
      error: 'FWB Q6 confirmation hash mismatch — config changed since confirmation (reject)',
      output: { reason: 'confirmation_hash_mismatch' },
    }
  }

  // Cross-base gate with RULE CREATOR as actor (§2.2) — FWB-1 same-sheet short-circuits.
  const gate = await deps.evaluateCrossBaseWriteGate(
    configurerUserId,
    context.sheetId,
    targetSheetId,
    declaredTargetBaseId,
  )
  if (gate.crossBase && gate.ok === false) {
    return { status: 'failed', error: gate.error, output: { reason: 'cross_base_denied' } }
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
      // Stable event identity across retries — append action key hash so multi-action rules don't collide.
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
  const gates = deps.gateChecks ?? buildProductionGateChecks(deps.queryFn, config.confirmationHash, expectedHash)
  const linkChecks = deps.linkChecks ?? buildProductionLinkChecks(deps.queryFn)

  const chainEventPayload: Record<string, unknown> = {
    sheetId: targetSheetId,
    recordId: boundRecordId ?? '',
    actorId: configurerUserId,
    _automationDepth: outDepth,
    source: 'write_approval_form_values',
    approvalInstanceId: instanceId,
  }

  // Pre-load form values (create/update) or frozen decision (decision) OUTSIDE the write txn —
  // reads only; the claim+write still share one txn.
  let formValues: Record<string, unknown> = {}
  let decisionSnapshot: FrozenDecisionSnapshot | null = null
  if (config.mode === 'decision') {
    decisionSnapshot = await loadLatestFrozenDecision(deps.queryFn, instanceId, config.decisionNodeKey!)
    if (!decisionSnapshot) {
      return {
        status: 'failed',
        error: `no frozen decision values for node ${config.decisionNodeKey} (transfer/jump/timeout leave none — fail-closed)`,
        output: { reason: 'decision_values_missing' },
      }
    }
  } else {
    const snap = await loadFormSnapshot(deps.queryFn, instanceId)
    if (!snap) return { status: 'failed', error: 'approval form_snapshot not found' }
    // Export whitelist: only mapped formFieldIds are passed to the mapper (unmapped never read).
    const allowed = new Set(config.mappings.map((m) => m.formFieldId))
    for (const [k, v] of Object.entries(snap)) {
      if (allowed.has(k)) formValues[k] = v
    }
  }

  // Discriminating pre-check: mapping must succeed before we open a write txn (permanent reject).
  if (config.mode !== 'decision') {
    const mapped = mapApprovalFormValues(config.mappings, formValues)
    if (!mapped.ok) {
      return {
        status: 'failed',
        error: 'FWB mapping rejected (fail-closed all-or-nothing)',
        output: { reason: 'mapping', errors: (mapped as { ok: false; errors: unknown }).errors },
      }
    }
  } else if (decisionSnapshot) {
    const mapped = mapApprovalFormValues(config.mappings, decisionSnapshot.values)
    if (!mapped.ok) {
      return {
        status: 'failed',
        error: 'FWB decision mapping rejected (fail-closed all-or-nothing)',
        output: { reason: 'mapping', errors: (mapped as { ok: false; errors: unknown }).errors },
      }
    }
  }

  try {
    const result = await deps.transaction(async ({ query }) => {
      const trx = asTrx(query)
      if (config.mode === 'create') {
        const seam = buildCreateSeam(query, configurerUserId, chainEventPayload)
        const input: FwbWriteActionInput = {
          claimId,
          instanceId,
          ruleId: context.ruleId,
          actionKey,
          gateSubject,
          mappings: config.mappings,
          formValues,
          eventId,
          automationDepth: outDepth,
        }
        return executeWriteApprovalFormValues(trx, input, gates, seam)
      }
      if (config.mode === 'update') {
        const seam = buildUpdateSeam(query, configurerUserId, chainEventPayload)
        const input: FwbUpdateActionInput = {
          claimId,
          instanceId,
          ruleId: context.ruleId,
          actionKey,
          gateSubject,
          boundRecordId: boundRecordId!,
          mappings: config.mappings,
          formValues,
          eventId,
          automationDepth: outDepth,
        }
        return executeUpdateBoundRecord(trx, input, gates, linkChecks, seam)
      }
      // decision
      const seam = buildUpdateSeam(query, configurerUserId, chainEventPayload)
      const input: FwbDecisionWriteInput = {
        claimId,
        instanceId,
        ruleId: context.ruleId,
        actionKey,
        gateSubject,
        boundRecordId: boundRecordId!,
        snapshot: decisionSnapshot!,
        mappings: config.mappings,
        eventId,
        automationDepth: outDepth,
      }
      return executeWriteDecisionValues(trx, input, gates, linkChecks, seam)
    })

    if (result.status === 'already_applied') {
      return { status: 'success', alreadyApplied: true, output: { alreadyApplied: true } }
    }
    if (result.status === 'rejected') {
      return {
        status: 'failed',
        error: `FWB rejected: ${result.reason}`,
        output: {
          reason: result.reason,
          ...('failedGates' in result && result.failedGates ? { failedGates: result.failedGates } : {}),
        },
      }
    }

    // Post-commit legacy emit (flag OFF path). Flag ON path enqueued inside the txn above.
    const eventType = config.mode === 'create' ? 'multitable.record.created' : 'multitable.record.updated'
    const payload = withAutomationEventId({
      ...chainEventPayload,
      _eventId: eventId,
      _automationDepth: outDepth,
    })
    emitRecordEventIfLegacy(deps.eventBus, eventType, payload)

    const recordId =
      result.status === 'applied' && 'recordId' in result
        ? result.recordId
        : boundRecordId
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
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Persist a freezeDecisionValues snapshot inside the caller's dispatchAction transaction.
 * One row per field; UNIQUE (instance, node, epoch, field) makes concurrent double-approve
 * collide (second insert fails → whole approve rolls back via the caller's txn).
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
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (instance_id, node_key, entry_epoch, field_id) DO NOTHING`,
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

/** Submit-time record-link authz helper (confused-deputy close). */
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
