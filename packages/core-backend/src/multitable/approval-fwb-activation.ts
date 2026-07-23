/**
 * FWB activation — production plumbing shared by the rule-save gate and the executor
 * (`write_approval_form_values`, FWB0 design lock `approval-form-writeback-fwb0-designlock-20260712.md`,
 * RATIFIED 2026-07-15).
 *
 * This module owns three things and NOTHING execution-order-sensitive:
 *   1. the runtime flag (default OFF). The lock names no env var (its header only rules "FWB … flag 保持
 *      OFF，直至完整实现 + 8 场景全链验收通过"), so the NAME here is an implementation choice; the
 *      POSTURE (default OFF, execution refuses while OFF, no half-durable path) is the lock's.
 *   2. fail-closed structural validation of the mapping config — the server-side mirror of
 *      `apps/web/src/approvals/fwbMappingConfig.ts` (same issue codes; the FE model is UX, THIS is the
 *      unbypassable boundary — its own header says "the server re-validates on save").
 *   3. the §11 Q6 gate-3 confirmation hash: sha256 over the CANONICALIZED
 *      `{templateId, sourceTemplateVersionId, targetSheetId, mappings}` subject. Save requires the
 *      submitted `confirmationHash` to equal the server-derived one;
 *      execute re-derives from the CURRENT persisted rule row — so "任一映射项或目标（base/sheet/模板…）
 *      变化都令确认失效" holds by construction (a config no longer matching its hash denies G4), and the
 *      recorded confirmation is identifiers+hash only, never values (Q6: 审计只记标识不记值).
 *
 * Gate binding (`buildProductionFwbGateChecks`) implements the §11 Q6 four-gate set with the checks the
 * lock names: G1 admin OR existing `canManageSheetAccess` on the target sheet, G2 source template
 * readable (both existing creator legs), G3 target sheet writable, G4 recorded confirmation — with the
 * per-sheet resolution going through the transaction-local counterpart of
 * `resolveSheetCapabilitiesForUser` as Q6 gate (4) explicitly demands (never a cached/global read).
 */
import { createHash } from 'node:crypto'

import { canonicalizeConfig, deriveActionKey } from './automation-action-idempotency'
import type { FwbFieldMapping } from './approval-form-value-mapping'
import type { FwbGateChecks, FwbWriteMode } from './approval-fwb-permission-gates'
import { enumerateRuleActions } from './automation-rule-fingerprint'
import { deriveFieldPermissions, isFieldWriteForbidden, type FieldLike } from './permission-derivation'
import { loadFieldPermissionScopeMap } from './permission-service'
import { resolveSheetCapabilitiesForUserOnQuery } from '../services/approval-record-link-txn-auth'

export const FWB_ACTION_TYPE = 'write_approval_form_values'

const V1_TARGET_TYPES = new Set(['text', 'number', 'date', 'select'])
const NON_BLANK = /[!-~]/

/** Parsed FWB write mode. Absent/`create` stay byte-compatible with FWB-1 configs. */
export type FwbModeParseResult =
  | { ok: true; mode: FwbWriteMode }
  | { ok: false; issue: 'unknown_mode' }

/**
 * Parse `mode` from a raw action config. Absent / undefined / `'create'` → create; `'update'` → update;
 * any other value is rejected (unknown modes must never silently fall through to create).
 */
export function parseFwbWriteMode(raw: unknown): FwbModeParseResult {
  if (raw === undefined) return { ok: true, mode: 'create' }
  if (raw === 'create') return { ok: true, mode: 'create' }
  if (raw === 'update') return { ok: true, mode: 'update' }
  return { ok: false, issue: 'unknown_mode' }
}

export type FwbUpdateConfigIssue =
  | 'record_link_field_missing'
  | 'record_link_field_blank'

/**
 * FWB-2 update config contract: one non-blank `recordLinkFieldId`. Does not look up the template
 * schema (that needs query access — save/execute do it). Returns the trimmed id or the first issue.
 */
export function normalizeFwbUpdateRecordLinkFieldId(raw: unknown):
  | { ok: true; recordLinkFieldId: string }
  | { ok: false; issue: FwbUpdateConfigIssue } {
  if (raw === undefined || raw === null) return { ok: false, issue: 'record_link_field_missing' }
  if (typeof raw !== 'string') return { ok: false, issue: 'record_link_field_blank' }
  const recordLinkFieldId = raw.trim()
  if (!NON_BLANK.test(recordLinkFieldId)) return { ok: false, issue: 'record_link_field_blank' }
  return { ok: true, recordLinkFieldId }
}

/**
 * Extract the exact single `{ recordId: string }` shape from a form_snapshot value (D3: 0 or multi →
 * reject). Values-free: returns null for any malformed shape (no existence oracle / no free-text id).
 */
export function extractExactLinkedRecordId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'recordId') return null
  const recordId = (value as { recordId?: unknown }).recordId
  if (typeof recordId !== 'string') return null
  const trimmed = recordId.trim()
  return NON_BLANK.test(trimmed) ? trimmed : null
}

/** Top-level record-link field props used to derive the FWB-2 write target (never client-supplied). */
export interface FwbRecordLinkTarget {
  fieldId: string
  baseId: string
  sheetId: string
}

/**
 * Locate a top-level `record-link` field in a form schema and return its pinned baseId/sheetId props.
 * Nested (detail) fields are ignored — v1 record-link is top-level only.
 */
export function resolveRecordLinkTargetFromSchema(
  formSchema: unknown,
  recordLinkFieldId: string,
): FwbRecordLinkTarget | null {
  if (!recordLinkFieldId || !NON_BLANK.test(recordLinkFieldId)) return null
  const schema = formSchema && typeof formSchema === 'object' && !Array.isArray(formSchema)
    ? formSchema as { fields?: unknown }
    : null
  const fields = Array.isArray(schema?.fields) ? schema.fields : []
  for (const field of fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue
    const f = field as { id?: unknown; type?: unknown; props?: unknown }
    if (f.id !== recordLinkFieldId) continue
    if (f.type !== 'record-link') return null
    const props = f.props && typeof f.props === 'object' && !Array.isArray(f.props)
      ? f.props as Record<string, unknown>
      : null
    const baseId = typeof props?.baseId === 'string' ? props.baseId.trim() : ''
    const sheetId = typeof props?.sheetId === 'string' ? props.sheetId.trim() : ''
    if (!NON_BLANK.test(baseId) || !NON_BLANK.test(sheetId)) return null
    return { fieldId: recordLinkFieldId, baseId, sheetId }
  }
  return null
}

/**
 * Runtime flag, default OFF. Execution additionally requires the durable-delivery flag (D9/D10: claim +
 * record + revision + outbox commit in ONE transaction and ride the durable dispatcher — with durable OFF
 * the outbox seam is a no-op, so running would silently drop the chained event: no half-durable path).
 */
export function isFwbWritebackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_FWB_WRITEBACK_ENABLED ?? '').trim().toLowerCase() === 'true'
}

export type FwbConfigStructuralIssue =
  | 'empty_config'
  | 'invalid_mapping_entry'
  | 'unsupported_target_type'
  | 'select_options_missing'
  | 'duplicate_target'
  | 'confirmation_hash_missing'
  | 'unknown_mode'
  | 'record_link_field_missing'
  | 'record_link_field_blank'

/**
 * Structural (schema-free) validation of a `write_approval_form_values` action config. Mirrors the FE
 * model's fail-closed rules (`fwbMappingConfig.ts`): empty config, non-v1 target types, select without
 * options and duplicate targets are all save-rejected. Field EXISTENCE (unknown_form_field /
 * unknown_target_field) needs the template/sheet schemas, so it lives in the save validator
 * (automation-service) which has query access. Returns the typed mappings or the first issue.
 */
export function normalizeFwbMappings(raw: unknown):
  | { ok: true; mappings: FwbFieldMapping[] }
  | { ok: false; issue: FwbConfigStructuralIssue } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, issue: 'empty_config' }
  const mappings: FwbFieldMapping[] = []
  const seenTargets = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, issue: 'invalid_mapping_entry' }
    const m = entry as Record<string, unknown>
    const formFieldId = typeof m.formFieldId === 'string' ? m.formFieldId.trim() : ''
    const targetFieldId = typeof m.targetFieldId === 'string' ? m.targetFieldId.trim() : ''
    const targetType = typeof m.targetType === 'string' ? m.targetType : ''
    if (!NON_BLANK.test(formFieldId) || !NON_BLANK.test(targetFieldId)) return { ok: false, issue: 'invalid_mapping_entry' }
    if (!V1_TARGET_TYPES.has(targetType)) return { ok: false, issue: 'unsupported_target_type' }
    let selectOptions: string[] | undefined
    if (targetType === 'select') {
      const opts = Array.isArray(m.selectOptions)
        ? m.selectOptions.filter((o): o is string => typeof o === 'string' && o.length > 0)
        : []
      if (opts.length === 0) return { ok: false, issue: 'select_options_missing' }
      selectOptions = opts
    }
    if (seenTargets.has(targetFieldId)) return { ok: false, issue: 'duplicate_target' }
    seenTargets.add(targetFieldId)
    mappings.push({
      formFieldId,
      targetFieldId,
      targetType: targetType as FwbFieldMapping['targetType'],
      ...(selectOptions ? { selectOptions } : {}),
    })
  }
  return { ok: true, mappings }
}

export interface FwbConfirmationSubject {
  /** the approval template the rule listens on (trigger_config.templateId). */
  templateId: string
  /** exact published form schema whose field meanings were explicitly confirmed. */
  sourceTemplateVersionId: string
  /**
   * Write target sheet. FWB-1 = the rule's OWN sheet (lock D2). FWB-2 = derived from the pinned
   * record-link field's props (never client-supplied). Bound into the hash so a rehome/repin invalidates.
   */
  targetSheetId: string
  /** base containing targetSheetId at confirmation time; a sheet rehome invalidates confirmation. */
  targetBaseId: string
  mappings: readonly FwbFieldMapping[]
  /**
   * FWB-2 only. When mode is `'update'`, both `mode` and `recordLinkFieldId` are part of the
   * confirmation subject. Create-mode subjects OMIT these keys so existing create-mode hashes stay
   * byte-identical.
   */
  mode?: FwbWriteMode
  recordLinkFieldId?: string
}

/**
 * §11 Q6 gate-3 confirmation hash: sha256 over the canonicalized (deep key-sorted; array order kept —
 * it is meaning) subject. Deterministic across process restarts and property order.
 *
 * Create-mode subjects intentionally omit `mode`/`recordLinkFieldId` so pre-FWB-2 hashes remain
 * byte-compatible. Update-mode subjects bind mode + recordLinkFieldId + derived target base/sheet.
 */
export function deriveFwbConfirmationHash(subject: FwbConfirmationSubject): string {
  const body: Record<string, unknown> = {
    templateId: subject.templateId,
    sourceTemplateVersionId: subject.sourceTemplateVersionId,
    targetBaseId: subject.targetBaseId,
    targetSheetId: subject.targetSheetId,
    mappings: subject.mappings,
  }
  if (subject.mode === 'update') {
    body.mode = 'update'
    body.recordLinkFieldId = subject.recordLinkFieldId ?? ''
  }
  return createHash('sha256')
    .update(canonicalizeConfig(body))
    .digest('hex')
}

/** An action row as persisted on `automation_rules` (top-level pair or `actions[]` entry). */
interface PersistedActionShape {
  type?: unknown
  config?: unknown
}

export interface PersistedFwbAction {
  config: Record<string, unknown>
  structuralPath: string
  actionKey: string
}

/**
 * Enumerate the effective runtime action set with the executor's exact identity rules. When `actions[]`
 * is non-empty it wins; the legacy `action_type`/`action_config` pair is only the fallback. This mirrors
 * `toExecutorRule` and prevents stale legacy columns from participating in save/execute authorization.
 */
export function collectPersistedFwbActions(
  actionType: string | null | undefined,
  actionConfig: unknown,
  actions: readonly PersistedActionShape[] | null | undefined,
): PersistedFwbAction[] {
  const effectiveActions: Array<{ type: string; config?: unknown }> = []
  if (Array.isArray(actions) && actions.length > 0) {
    for (const action of actions) {
      if (action && typeof action.type === 'string') {
        effectiveActions.push({ type: action.type, config: action.config })
      }
    }
  } else if (typeof actionType === 'string') {
    effectiveActions.push({ type: actionType, config: actionConfig })
  }

  const out: PersistedFwbAction[] = []
  for (const { action, structuralPath } of enumerateRuleActions(effectiveActions)) {
    if (action.type !== FWB_ACTION_TYPE || !action.config || typeof action.config !== 'object' || Array.isArray(action.config)) {
      continue
    }
    const config = action.config as Record<string, unknown>
    out.push({
      config,
      structuralPath,
      actionKey: deriveActionKey({ structuralPath, actionType: FWB_ACTION_TYPE, canonicalConfig: config }),
    })
  }
  return out
}

/** Collect every effective FWB action config (including branch actions the executor can enumerate). */
export function collectFwbActionConfigs(
  actionType: string | null | undefined,
  actionConfig: unknown,
  actions: readonly PersistedActionShape[] | null | undefined,
): Array<Record<string, unknown>> {
  return collectPersistedFwbActions(actionType, actionConfig, actions).map(({ config }) => config)
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface ProductionFwbGateDeps {
  queryFn: QueryFn
  /** platform admin check (rbac/service.isAdmin in production wiring). */
  isAdminFn(userId: string): Promise<boolean>
  /**
   * G2 source-readable: BOTH existing creator legs (`approvals:read` + template visibility_scope), the
   * same pair the approval.completed trigger enforces at save AND fire (lock §2.1: FWB "不新增任何
   * 检查器，挂进同一对钩子").
   */
  canReadTemplateFn(userId: string, templateId: string): Promise<boolean>
}

function parseFieldProperty(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* fail closed below */ }
  }
  return {}
}

/**
 * Canonical layer-2/layer-3 field-write gate for every FWB target field.
 * - create (default): sheet canCreateRecord + create-field permissions (allowCreateOnly).
 * - update: sheet canEditRecord + update-field permissions (must NOT require create).
 */
export async function canUserWriteFwbTargetFields(
  queryFn: QueryFn,
  userId: string,
  sheetId: string,
  targetFieldIds: readonly string[],
  mode: FwbWriteMode = 'create',
): Promise<boolean> {
  if (!userId || targetFieldIds.length === 0) return false
  const uniqueIds = [...new Set(targetFieldIds)]
  const [resolved, fieldScopeMap, fieldResult] = await Promise.all([
    resolveSheetCapabilitiesForUserOnQuery(queryFn, sheetId, userId),
    loadFieldPermissionScopeMap(queryFn, sheetId, userId),
    queryFn(
      'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, uniqueIds],
    ),
  ])
  if (mode === 'update') {
    if (!resolved.capabilities.canEditRecord) return false
  } else if (!resolved.capabilities.canCreateRecord) {
    return false
  }
  const fields: FieldLike[] = (fieldResult.rows as Array<{ id?: unknown; type?: unknown; property?: unknown }>)
    .filter((row): row is { id: string; type: string; property?: unknown } => (
      typeof row.id === 'string' && typeof row.type === 'string'
    ))
    .map((row) => ({ id: row.id, type: row.type, property: parseFieldProperty(row.property) }))
  if (fields.length !== uniqueIds.length) return false
  const permissions = deriveFieldPermissions(fields, resolved.capabilities, {
    allowCreateOnly: mode !== 'update',
    fieldScopeMap,
  })
  return uniqueIds.every((fieldId) => !isFieldWriteForbidden(permissions[fieldId]))
}

/**
 * The REAL §11 Q6 gate set bound at AutomationService construction. Every check is fail-closed at the
 * caller (`recheckFwbPermissionGates` counts a thrown check as failed), so none of these needs its own
 * try/catch. Per-sheet checks go through `resolveSheetCapabilitiesForUserOnQuery` (Q6 gate 4 — the
 * caller supplies the current write transaction, never a global/cached capability read).
 */
export function buildProductionFwbGateChecks(deps: ProductionFwbGateDeps): FwbGateChecks {
  type ResolvedGateAction = {
    mode: FwbWriteMode
    targetSheetId: string
    mappings: FwbFieldMapping[]
    confirmationValid: boolean
  }

  const resolveGateAction = async (ruleId: string, actionKey: string): Promise<ResolvedGateAction | null> => {
    if (!ruleId || !actionKey) return null
    const res = await deps.queryFn(
      `SELECT r.sheet_id, s.base_id, r.trigger_config, r.action_type, r.action_config, r.actions
         FROM automation_rules r
         JOIN meta_sheets s ON s.id = r.sheet_id
        WHERE r.id = $1 AND r.enabled = TRUE`,
      [ruleId],
    )
    const row = res.rows[0] as {
      sheet_id?: unknown
      base_id?: unknown
      trigger_config?: unknown
      action_type?: unknown
      action_config?: unknown
      actions?: unknown
    } | undefined
    if (!row || typeof row.sheet_id !== 'string' || typeof row.base_id !== 'string') return null

    const matches = collectPersistedFwbActions(
      typeof row.action_type === 'string' ? row.action_type : null,
      parseJsonObject(row.action_config),
      parseJsonArray(row.actions) as PersistedActionShape[] | null,
    ).filter((candidate) => candidate.actionKey === actionKey)
    if (matches.length !== 1) return null

    const config = matches[0].config
    const modeParsed = parseFwbWriteMode(config.mode)
    const normalized = normalizeFwbMappings(config.mappings)
    if (!modeParsed.ok || !normalized.ok) return null

    const triggerConfig = parseJsonObject(row.trigger_config)
    const templateId = typeof triggerConfig?.templateId === 'string' ? triggerConfig.templateId : ''
    if (!templateId) return null
    const templateResult = await deps.queryFn(
      `SELECT t.active_version_id, v.form_schema
         FROM approval_templates t
         JOIN approval_template_versions v ON v.id = t.active_version_id
        WHERE t.id = $1`,
      [templateId],
    )
    const templateRow = templateResult.rows[0] as {
      active_version_id?: unknown
      form_schema?: unknown
    } | undefined
    const activeVersionId = templateRow?.active_version_id
    if (typeof activeVersionId !== 'string' || !activeVersionId) return null
    const formSchema = parseJsonObject(templateRow?.form_schema)
      ?? (() => {
        if (typeof templateRow?.form_schema === 'string') {
          try {
            const parsed = JSON.parse(templateRow.form_schema) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
          } catch { /* fail closed */ }
        }
        return null
      })()

    let targetBaseId = row.base_id
    let targetSheetId = row.sheet_id
    let recordLinkFieldId: string | undefined
    if (modeParsed.mode === 'update') {
      const linkField = normalizeFwbUpdateRecordLinkFieldId(config.recordLinkFieldId)
      if (!linkField.ok) return null
      const derived = resolveRecordLinkTargetFromSchema(formSchema, linkField.recordLinkFieldId)
      if (!derived) return null
      const membership = await deps.queryFn('SELECT base_id FROM meta_sheets WHERE id = $1', [derived.sheetId])
      const liveBase = (membership.rows[0] as { base_id?: unknown } | undefined)?.base_id
      if (typeof liveBase !== 'string' || liveBase !== derived.baseId) return null
      targetBaseId = derived.baseId
      targetSheetId = derived.sheetId
      recordLinkFieldId = linkField.recordLinkFieldId
    }

    const confirmedVersionId = typeof config.sourceTemplateVersionId === 'string'
      ? config.sourceTemplateVersionId
      : ''
    const stored = typeof config.confirmationHash === 'string' ? config.confirmationHash : ''
    const expected = deriveFwbConfirmationHash({
      templateId,
      sourceTemplateVersionId: confirmedVersionId,
      targetBaseId,
      targetSheetId,
      mappings: normalized.mappings,
      ...(modeParsed.mode === 'update'
        ? { mode: 'update' as const, recordLinkFieldId }
        : {}),
    })

    return {
      mode: modeParsed.mode,
      targetSheetId,
      mappings: normalized.mappings,
      confirmationValid: confirmedVersionId === activeVersionId && stored === expected,
    }
  }

  return {
    isAdmin: (userId) => deps.isAdminFn(userId),
    canManageSheetAccess: async (userId, sheetId) => {
      const resolved = await resolveSheetCapabilitiesForUserOnQuery(deps.queryFn, sheetId, userId)
      return resolved.capabilities.canManageSheetAccess
    },
    canReadTemplate: (userId, templateId) => deps.canReadTemplateFn(userId, templateId),
    canWriteSheet: async (userId, sheetId, mode = 'create') => {
      // FWB-1 = record CREATE (canCreateRecord). FWB-2 = record UPDATE (canEditRecord — not create).
      const resolved = await resolveSheetCapabilitiesForUserOnQuery(deps.queryFn, sheetId, userId)
      return mode === 'update'
        ? resolved.capabilities.canEditRecord
        : resolved.capabilities.canCreateRecord
    },
    canWriteTargetFields: async (userId, ruleId, actionKey, sheetId, mode = 'create') => {
      const action = await resolveGateAction(ruleId, actionKey)
      if (!action || action.mode !== mode || action.targetSheetId !== sheetId) return false
      return canUserWriteFwbTargetFields(
        deps.queryFn,
        userId,
        sheetId,
        action.mappings.map((mapping) => mapping.targetFieldId),
        mode,
      )
    },
    hasRecordedConfirmation: async (ruleId, actionKey) => {
      const action = await resolveGateAction(ruleId, actionKey)
      return action?.confirmationValid === true
    },
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* fall through */ }
  }
  return null
}

function parseJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) return parsed
    } catch { /* fall through */ }
  }
  return null
}
