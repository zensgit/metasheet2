/**
 * FWB-1 slice ③ — `write_approval_form_values` executor: gates → mapping → SAME-TRANSACTION
 * claim + record + revision + outbox (#4203 §3 D9/D10).
 *
 * Composition (all inside the CALLER-provided transaction client):
 *   1. §11 Q6 four-gate execute-time recheck — any gate down → 'rejected' (PERMANENT; the action must
 *      never run on revoked authority);
 *   2. fail-closed all-or-nothing value mapping — any mapping error → 'rejected' (PERMANENT; config bug);
 *   3. Class-A business claim (`claimActionApplied`) — 'duplicate' → 'already_applied' (net-once: a prior
 *      apply won; skip the write, report success upstream);
 *   4. the record write (injected seam — the real record-service call at final wiring; MUST create the
 *      record AND its revision on the SAME trx) + `produceAutomationEvent` on the SAME trx (durable
 *      downstream fan-out commits or rolls back WITH the claim and the record).
 *
 * Any throw from the seam propagates and aborts the caller's transaction — claim, record, revision and
 * outbox rows all vanish together (proven in the real-DB spec). The production caller is
 * `executeWriteApprovalFormValuesAction` (automation-executor.ts), which runs the recheck seam and this
 * executor inside ONE transaction behind the FWB + durable-delivery flags.
 *
 * Also exports `resolveFwbRuntimeMappings` — the execute-time target-field recheck (current select
 * option set + canonical number precision, fail-closed on missing/retyped fields) that MUST run before
 * `mapApprovalFormValues`; the production caller is `executeWriteApprovalFormValuesAction`
 * (automation-executor.ts), which invokes it inside the same transaction as this executor.
 */
import type { Queryable } from './automation-durable-dispatcher'
import type { TransactionalQueryable } from './pg-transaction-guard'
import { claimActionApplied } from './automation-action-idempotency'
import { mapApprovalFormValues, type FwbFieldMapping } from './approval-form-value-mapping'
import { recheckFwbPermissionGates, type FwbGateChecks, type FwbGateId, type FwbGateSubject } from './approval-fwb-permission-gates'
import { extractSelectOptions, sanitizeFieldProperty } from './field-codecs'
import { isFwbTargetFieldTypeCompatible } from './approval-fwb-activation'

type SqlQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

export type FwbRuntimeMappingsResult =
  | { ok: true; mappings: FwbFieldMapping[] }
  | { ok: false; code: 'mapping_target_changed' }

function parseFieldProperty(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { return null }
  }
  return null
}

function hasCanonicalNumberPrecisionLexeme(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length > 0 && /^-?\d+(?:\.\d+)?$/.test(normalized)
}

/**
 * Execute-time target-field recheck (FWB0 §5 「字段类型 fire 时复验」 + D6): re-derive the runtime
 * mappings from the CURRENT `meta_fields` rows INSIDE the caller's transaction (`FOR SHARE`), never
 * trusting the saved mapping's stale metadata:
 *   - any target field missing, or its type changed since save → fail closed;
 *   - `select` mappings get the intersection of the explicitly confirmed and currently existing option
 *     values. Removed values and newly-added-but-unconfirmed values both reject (D6 closed vocabulary);
 *     absent/unparseable/empty current options fail closed (no open-vocabulary write);
 *   - `number` mappings get `numberPrecision` from the canonical `property.decimals` (the field codec
 *     contract — no second spelling): the saved mapping's precision is DISCARDED first, then the current
 *     cap is attached only when valid — a tightened cap applies (§11 Q5), a removed cap stays removed,
 *     and a stale saved value never survives.
 * The failure carries NO values — callers map it to the values-free `fwb_rejected:mapping_target_changed`.
 */
export async function resolveFwbRuntimeMappings(
  query: SqlQueryFn,
  targetSheetId: string,
  mappings: readonly FwbFieldMapping[],
): Promise<FwbRuntimeMappingsResult> {
  const fail: FwbRuntimeMappingsResult = { ok: false, code: 'mapping_target_changed' }
  const result = await query(
    `SELECT id, type, property
       FROM meta_fields
      WHERE sheet_id = $1 AND id = ANY($2::text[])
      FOR SHARE`,
    [targetSheetId, mappings.map((mapping) => mapping.targetFieldId)],
  )
  const targetFields = new Map(
    (result.rows as Array<{ id?: unknown; type?: unknown; property?: unknown }>)
      .filter((row): row is { id: string; type: string; property?: unknown } => (
        typeof row.id === 'string' && typeof row.type === 'string'
      ))
      .map((row) => [row.id, { type: row.type, property: parseFieldProperty(row.property) }] as const),
  )
  if (targetFields.size !== mappings.length) return fail
  const runtimeMappings: FwbFieldMapping[] = []
  for (const mapping of mappings) {
    const field = targetFields.get(mapping.targetFieldId)
    if (!field || !isFwbTargetFieldTypeCompatible(field.type, mapping.targetType)) return fail
    if (mapping.targetType === 'select') {
      // The effective vocabulary is the INTERSECTION of the values explicitly confirmed in the
      // persisted mapping and the values that still exist now. Replacing the confirmed list with the
      // whole current field vocabulary would let a newly-added option bypass the confirmation hash.
      const current = field.property
        ? extractSelectOptions(field.property)?.map((option) => option.value)
        : undefined
      const confirmed = mapping.selectOptions ?? []
      if (!current || current.length === 0 || confirmed.length === 0) return fail
      const currentSet = new Set(current)
      const allowed = confirmed.filter((value) => currentSet.has(value))
      if (allowed.length === 0) return fail
      runtimeMappings.push({ ...mapping, selectOptions: allowed })
      continue
    }
    if (mapping.targetType === 'number') {
      // Current field metadata REPLACES the saved mapping's: a saved numberPrecision must not survive
      // when the field's own cap was removed (stale tightening) or changed (stale value) since save.
      if (!field.property) return fail
      const { numberPrecision: _savedPrecision, ...withoutSavedPrecision } = mapping
      const hasPrecision = Object.prototype.hasOwnProperty.call(field.property, 'decimals')
      const rawPrecision = field.property.decimals
      // The shared field sanitizer intentionally accepts broad UI inputs via Number(...). At execute
      // time that coercion would turn true/blank/arrays/hex into an invented precision. A present value
      // therefore needs a plain-decimal lexeme before we reuse the established rounding/range policy.
      if (hasPrecision && !hasCanonicalNumberPrecisionLexeme(rawPrecision)) return fail
      const sanitized = sanitizeFieldProperty('number', field.property)
      const precision = sanitized.decimals
      // Absence means the field deliberately has no scale cap. Presence with a value the canonical
      // field-property sanitizer rejects must fail closed instead of silently becoming uncapped.
      if (hasPrecision && (
        typeof precision !== 'number'
        || !Number.isSafeInteger(precision)
        || precision < 0
      )) return fail
      runtimeMappings.push({
        ...withoutSavedPrecision,
        ...(hasPrecision && typeof precision === 'number'
          ? { numberPrecision: precision }
          : {}),
      })
      continue
    }
    runtimeMappings.push(mapping)
  }
  return { ok: true, mappings: runtimeMappings }
}

export interface FwbWriteActionInput {
  /** idempotency identity (ledger): */
  claimId: string
  instanceId: string
  ruleId: string
  actionKey: string
  applicationMode?: 'apply' | 'test_run'
  /** permission subject (§11 Q6): */
  gateSubject: FwbGateSubject
  /** mapping config + submitted form values: */
  mappings: readonly FwbFieldMapping[]
  formValues: Readonly<Record<string, unknown>>
  /** durable event identity for the outbox row (stable original event id): */
  eventId: string
  automationDepth?: number
}

export interface FwbRecordWriteSeam {
  /** Create the record + its revision on the SAME trx; returns the new record id (identifier only). */
  createRecordWithRevision(trx: Queryable, targetSheetId: string, values: Record<string, string>): Promise<string>
  /** Durable outbox enqueue on the SAME trx (final wiring passes produceAutomationEvent; flag-gated there). */
  enqueueOutbox(trx: Queryable, event: { eventType: string; eventId: string; payload: unknown; automationDepth: number }): Promise<void>
}

export type FwbWriteActionResult =
  | { status: 'applied'; recordId: string }
  | { status: 'already_applied' }
  | { status: 'rejected'; reason: 'permission_gates' | 'mapping'; failedGates?: FwbGateId[] }

/**
 * Execute the write action INSIDE the caller's transaction. See module doc for the four-step contract.
 * `trx` carries the TransactionalQueryable brand (post-#4336/#4340 hardening): the brand is compile-time
 * documentation only — the REAL enforcement is `claimActionApplied`'s pg_current_xact_id probe, which
 * rejects any pool/autocommit handle at runtime regardless of the brand.
 */
export async function executeWriteApprovalFormValues(
  trx: TransactionalQueryable,
  input: FwbWriteActionInput,
  gates: FwbGateChecks,
  seam: FwbRecordWriteSeam,
): Promise<FwbWriteActionResult> {
  const gate = (await recheckFwbPermissionGates(gates, input.gateSubject)) as { ok: boolean; failed?: FwbGateId[] }
  if (!gate.ok) return { status: 'rejected', reason: 'permission_gates', failedGates: gate.failed ?? [] }

  const mapped = mapApprovalFormValues(input.mappings, input.formValues)
  if (!mapped.ok) return { status: 'rejected', reason: 'mapping' }

  const claim = await claimActionApplied(trx, {
    id: input.claimId,
    instanceId: input.instanceId,
    ruleId: input.ruleId,
    actionKey: input.actionKey,
    applicationMode: input.applicationMode ?? 'apply',
  })
  if (claim === 'duplicate') return { status: 'already_applied' }

  const recordId = await seam.createRecordWithRevision(trx, input.gateSubject.targetSheetId, mapped.values)
  // durable downstream fan-out, SAME trx (the injected enqueue is flag-gated at final wiring).
  await seam.enqueueOutbox(trx, {
    eventType: 'multitable.record.created',
    eventId: input.eventId,
    payload: { recordId, sheetId: input.gateSubject.targetSheetId },
    automationDepth: input.automationDepth ?? 0,
  })
  return { status: 'applied', recordId }
}
