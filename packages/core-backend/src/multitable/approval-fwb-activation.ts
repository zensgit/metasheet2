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
 * per-sheet resolution going through `resolveSheetCapabilitiesForUser` as Q6 gate (4) explicitly demands
 * ("权限复核须显式调用目标 sheet 的 resolveSheetCapabilitiesForUser……不能只读一个全局 capability").
 */
import { createHash } from 'node:crypto'

import { canonicalizeConfig } from './automation-action-idempotency'
import type { FwbFieldMapping } from './approval-form-value-mapping'
import type { FwbGateChecks } from './approval-fwb-permission-gates'
import { deriveFieldPermissions, isFieldWriteForbidden, type FieldLike } from './permission-derivation'
import { loadFieldPermissionScopeMap } from './permission-service'
import { resolveSheetCapabilitiesForUser } from './sheet-capabilities'

export const FWB_ACTION_TYPE = 'write_approval_form_values'

/**
 * Runtime flag, default OFF. Execution additionally requires the durable-delivery flag (D9/D10: claim +
 * record + revision + outbox commit in ONE transaction and ride the durable dispatcher — with durable OFF
 * the outbox seam is a no-op, so running would silently drop the chained event: no half-durable path).
 */
export function isFwbWritebackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_FWB_WRITEBACK_ENABLED ?? '').trim().toLowerCase() === 'true'
}

const V1_TARGET_TYPES = new Set(['text', 'number', 'date', 'select'])
const NON_BLANK = /[!-~]/

/**
 * FWB uses the lock's conceptual `text` mapping type while multitable persists ordinary text fields
 * as `string`. Keep the alias explicit at both save and execute time; never broaden it to longText or
 * another writable-looking field type without a separate product decision.
 */
export function isFwbTargetFieldTypeCompatible(
  storedFieldType: string,
  targetType: FwbFieldMapping['targetType'],
): boolean {
  return targetType === 'text'
    ? storedFieldType === 'string' || storedFieldType === 'text'
    : storedFieldType === targetType
}

export type FwbConfigStructuralIssue =
  | 'empty_config'
  | 'invalid_mapping_entry'
  | 'unsupported_target_type'
  | 'select_options_missing'
  | 'duplicate_target'
  | 'confirmation_hash_missing'

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
  /** FWB-1 target = the rule's OWN sheet (lock D2) — bound into the hash so a sheet move invalidates. */
  targetSheetId: string
  /** base containing targetSheetId at confirmation time; a sheet rehome invalidates confirmation. */
  targetBaseId: string
  mappings: readonly FwbFieldMapping[]
}

/**
 * §11 Q6 gate-3 confirmation hash: sha256 over the canonicalized (deep key-sorted; array order kept —
 * it is meaning) subject. Deterministic across process restarts and property order.
 */
export function deriveFwbConfirmationHash(subject: FwbConfirmationSubject): string {
  return createHash('sha256')
    .update(canonicalizeConfig({
      templateId: subject.templateId,
      sourceTemplateVersionId: subject.sourceTemplateVersionId,
      targetBaseId: subject.targetBaseId,
      targetSheetId: subject.targetSheetId,
      mappings: subject.mappings,
    }))
    .digest('hex')
}

/** An action row as persisted on `automation_rules` (top-level pair or `actions[]` entry). */
interface PersistedActionShape {
  type?: unknown
  config?: unknown
}

/** Collect every FWB action config on a persisted/incoming rule shape (top-level + actions array). */
export function collectFwbActionConfigs(
  actionType: string | null | undefined,
  actionConfig: unknown,
  actions: readonly PersistedActionShape[] | null | undefined,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (actionType === FWB_ACTION_TYPE && actionConfig && typeof actionConfig === 'object' && !Array.isArray(actionConfig)) {
    out.push(actionConfig as Record<string, unknown>)
  }
  for (const action of actions ?? []) {
    if (action && action.type === FWB_ACTION_TYPE && action.config && typeof action.config === 'object' && !Array.isArray(action.config)) {
      out.push(action.config as Record<string, unknown>)
    }
  }
  return out
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

/** Canonical layer-2/layer-3 create-field gate for every FWB target field. */
export async function canUserWriteFwbTargetFields(
  queryFn: QueryFn,
  userId: string,
  sheetId: string,
  targetFieldIds: readonly string[],
): Promise<boolean> {
  if (!userId || targetFieldIds.length === 0) return false
  const uniqueIds = [...new Set(targetFieldIds)]
  const [resolved, fieldScopeMap, fieldResult] = await Promise.all([
    resolveSheetCapabilitiesForUser(queryFn, sheetId, userId),
    loadFieldPermissionScopeMap(queryFn, sheetId, userId),
    queryFn(
      'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, uniqueIds],
    ),
  ])
  if (!resolved.capabilities.canCreateRecord) return false
  const fields: FieldLike[] = (fieldResult.rows as Array<{ id?: unknown; type?: unknown; property?: unknown }>)
    .filter((row): row is { id: string; type: string; property?: unknown } => (
      typeof row.id === 'string' && typeof row.type === 'string'
    ))
    .map((row) => ({ id: row.id, type: row.type, property: parseFieldProperty(row.property) }))
  if (fields.length !== uniqueIds.length) return false
  const permissions = deriveFieldPermissions(fields, resolved.capabilities, {
    allowCreateOnly: true,
    fieldScopeMap,
  })
  return uniqueIds.every((fieldId) => !isFieldWriteForbidden(permissions[fieldId]))
}

/**
 * The REAL §11 Q6 gate set bound at AutomationService construction. Every check is fail-closed at the
 * caller (`recheckFwbPermissionGates` counts a thrown check as failed), so none of these needs its own
 * try/catch. Per-sheet checks go through `resolveSheetCapabilitiesForUser` (Q6 gate 4 — never a global
 * capability read).
 */
export function buildProductionFwbGateChecks(deps: ProductionFwbGateDeps): FwbGateChecks {
  return {
    isAdmin: (userId) => deps.isAdminFn(userId),
    canManageSheetAccess: async (userId, sheetId) => {
      const resolved = await resolveSheetCapabilitiesForUser(deps.queryFn, sheetId, userId)
      return resolved.capabilities.canManageSheetAccess
    },
    canReadTemplate: (userId, templateId) => deps.canReadTemplateFn(userId, templateId),
    canWriteSheet: async (userId, sheetId) => {
      // FWB-1 writes = record CREATE on the target sheet (lock §4 mode:'create').
      const resolved = await resolveSheetCapabilitiesForUser(deps.queryFn, sheetId, userId)
      return resolved.capabilities.canCreateRecord
    },
    canWriteTargetFields: async (userId, ruleId, sheetId) => {
      const res = await deps.queryFn(
        'SELECT action_type, action_config, actions FROM automation_rules WHERE id = $1 AND sheet_id = $2',
        [ruleId, sheetId],
      )
      const row = res.rows[0] as {
        action_type?: unknown
        action_config?: unknown
        actions?: unknown
      } | undefined
      if (!row) return false
      const configs = collectFwbActionConfigs(
        typeof row.action_type === 'string' ? row.action_type : null,
        parseJsonObject(row.action_config),
        parseJsonArray(row.actions) as PersistedActionShape[] | null,
      )
      const targetFieldIds: string[] = []
      for (const config of configs) {
        const normalized = normalizeFwbMappings(config.mappings)
        if (!normalized.ok) return false
        targetFieldIds.push(...normalized.mappings.map((mapping) => mapping.targetFieldId))
      }
      return canUserWriteFwbTargetFields(deps.queryFn, userId, sheetId, targetFieldIds)
    },
    hasRecordedConfirmation: async (ruleId) => {
      // G4 re-derivation against the CURRENT persisted rule: every FWB action's stored confirmationHash
      // must equal the hash of its CURRENT normalized config + the rule's CURRENT sheet/template. A rule
      // with no FWB action, a broken config, or ANY stale hash → false (fail-closed).
      const res = await deps.queryFn(
        `SELECT r.sheet_id, s.base_id, r.trigger_config, r.action_type, r.action_config, r.actions
           FROM automation_rules r
           JOIN meta_sheets s ON s.id = r.sheet_id
          WHERE r.id = $1`,
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
      if (!row || typeof row.sheet_id !== 'string' || typeof row.base_id !== 'string') return false
      const triggerConfig = parseJsonObject(row.trigger_config)
      const templateId = typeof triggerConfig?.templateId === 'string' ? triggerConfig.templateId : ''
      if (!templateId) return false
      const templateResult = await deps.queryFn(
        'SELECT active_version_id FROM approval_templates WHERE id = $1',
        [templateId],
      )
      const activeVersionId = (templateResult.rows[0] as { active_version_id?: unknown } | undefined)?.active_version_id
      if (typeof activeVersionId !== 'string' || !activeVersionId) return false
      const configs = collectFwbActionConfigs(
        typeof row.action_type === 'string' ? row.action_type : null,
        parseJsonObject(row.action_config),
        parseJsonArray(row.actions) as PersistedActionShape[] | null,
      )
      if (configs.length === 0) return false
      for (const config of configs) {
        const normalized = normalizeFwbMappings(config.mappings)
        if (!normalized.ok) return false
        const confirmedVersionId = typeof config.sourceTemplateVersionId === 'string'
          ? config.sourceTemplateVersionId
          : ''
        if (confirmedVersionId !== activeVersionId) return false
        const stored = typeof config.confirmationHash === 'string' ? config.confirmationHash : ''
        const expected = deriveFwbConfirmationHash({
          templateId,
          sourceTemplateVersionId: confirmedVersionId,
          targetBaseId: row.base_id,
          targetSheetId: row.sheet_id,
          mappings: normalized.mappings,
        })
        if (stored !== expected) return false
      }
      return true
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
