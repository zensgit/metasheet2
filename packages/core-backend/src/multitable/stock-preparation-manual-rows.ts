/**
 * 人工补充行 (manual supplementary rows) — the HOST half of ADR adr-stock-prep-manual-rows-20261030, slice B2: the PURE
 * part (constants, predicates, the switch's sanitizer, the template column classes). No IO and no heavy imports: this
 * module is required by field-codecs.ts and plm-row-delete-guard.ts, so it may import nothing but the dependency-free
 * grant contract. The IO half (registry reads, the gate, the create extension) is
 * stock-preparation-manual-rows-gate.ts.
 *
 * THE NAMESPACE (ADR §2.2 「前缀行」). A stock-prep project sheet's unique key is written by the PLM pull as a JSON
 * object text, so a PLM key always starts with `{` (ADR §2.3 ①). Every key that starts with `manual:` is RESERVED for
 * rows people make. The comparison is the RAW `startsWith` — never trimmed, case-sensitive — on the host and in the
 * plugin alike (plugins/plugin-integration-core/lib/stock-preparation-manual-rows.cjs); a key with a leading space is
 * not a prefix key anywhere.
 *
 * THE PREDICATE M (ADR §2.2). A row is a MANUAL SUPPLEMENTARY ROW when all four hold:
 *   (a) the HOST registry row of its sheet names plugin `plugin-integration-core` and an object id of the registered
 *       project-sheet shape (`plm_stock_preparation_sandbox_p_<24 hex>`, the R-66 ② rule);
 *   (b) exactly one column carries the exact `stockPreparation` stanza with `key === true` (K);
 *   (c) `meta_records.created_by` is a non-blank string (a whitespace-only creator counts as NO creator);
 *   (d) `data[K]` equals `'manual:v1:' + <this row's id>` exactly (a blank or whitespace-only id is never manual).
 * `isManualSupplementRow` below decides (a)'s object-id half, (c) and (d) over primitive inputs — the same inputs, and
 * the same answers, as the plugin's M′; the registry row's plugin name and (b) are the callers' (they hold the registry
 * row and the fields). The host↔plugin CONTRACT TEST (tests/unit/stock-preparation-manual-rows-contract.test.ts) runs
 * this module over the plugin's own truth table and pins the two prefix constants byte-equal, so M and M′ cannot drift
 * apart. No predicate here looks at the column lock (ADR §2.3 ④).
 *
 * THE DELETE EXEMPTION E (ADR §2.2, OQ2; register R-66 ① as amended). On a sheet R-66 ① guards, a row whose key is a
 * prefix key AND that has a creator may be deleted: the manual rows (M ⊂ E) and the unbound prefix rows the pull no
 * longer maintains. A prefix row without a creator stays undeletable like every other PLM row.
 *
 * THE SWITCH (ADR §4). `property.stockPreparationManualRows` on the key column K: ABSENT or exactly `'allowed'` =
 * manual rows allowed; ANY OTHER present value = disabled. Both field sanitizers normalize a present value that is not
 * `'allowed'` to `'disabled'` — never drop it, since a dropped value reads as "absent" = allowed, i.e. fail OPEN (the
 * reason this is not `withHumanWriteLockKey`'s drop rule). The person field routes cannot change it: POST /fields
 * strips it, PATCH /fields and the config revert carry the STORED value over whatever the body or the revision says.
 *
 * VALUES-FREE: ids and closed tokens only.
 */
import { isStockPreparationProjectSheetObjectId } from './stock-preparation-project-sheet-grant-contract'

/** The reserved namespace (byte-equal to the plugin's MANUAL_ROW_KEY_PREFIX; pinned by the contract test). */
export const MANUAL_ROW_KEY_PREFIX = 'manual:'
/** The manual-row key of THIS version: `manual:v1:<record id>` (byte-equal to the plugin's MANUAL_ROW_KEY_V1_PREFIX). */
export const MANUAL_ROW_KEY_V1_PREFIX = 'manual:v1:'

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Does this key sit in the reserved `manual:` namespace? RAW comparison (no trim). */
export function isManualPrefixKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(MANUAL_ROW_KEY_PREFIX)
}

/** The manual-row key a record with this id carries; null for a blank id. */
export function manualRowKeyFor(recordId: unknown): string | null {
  return isNonBlankString(recordId) ? `${MANUAL_ROW_KEY_V1_PREFIX}${recordId}` : null
}

/** (c): a creator is a non-blank string — a whitespace-only `created_by` is no creator. */
export function hasManualRowCreator(createdBy: unknown): boolean {
  return isNonBlankString(createdBy)
}

export type ManualRowIdentityInput = {
  /** The object id of the sheet's registry row ((a)'s pattern half; the caller checks the plugin name). */
  objectId?: unknown
  /** `meta_records.created_by`. */
  createdBy?: unknown
  /** The record's own id (the envelope id, never a cell). */
  recordId?: unknown
  /** The key column's value in the row's data. */
  key?: unknown
}

/** M over primitive inputs: (a)'s object-id pattern, (c), (d). Same answers as the plugin's M′ (contract-tested). */
export function isManualSupplementRow({ objectId, createdBy, recordId, key }: ManualRowIdentityInput = {}): boolean {
  return isStockPreparationProjectSheetObjectId(objectId)
    && hasManualRowCreator(createdBy)
    && isNonBlankString(recordId)
    && typeof key === 'string'
    && key === `${MANUAL_ROW_KEY_V1_PREFIX}${recordId}`
}

/** 'manual' (a prefix row satisfying M), 'unbound_prefix' (any other prefix row), or null (not a prefix row). */
export function classifyManualPrefixRow(input: ManualRowIdentityInput = {}): 'manual' | 'unbound_prefix' | null {
  if (!isManualPrefixKey(input.key)) return null
  return isManualSupplementRow(input) ? 'manual' : 'unbound_prefix'
}

/** E (OQ2): a prefix-key row with a creator may be deleted on a sheet R-66 ① guards. M ⊂ E. */
export function isManualRowDeleteExempt({ createdBy, key }: { createdBy?: unknown; key?: unknown } = {}): boolean {
  return isManualPrefixKey(key) && hasManualRowCreator(createdBy)
}

// ── the switch (ADR §4) ─────────────────────────────────────────────────────────────────────────────

export const MANUAL_ROWS_POLICY_PROPERTY_KEY = 'stockPreparationManualRows' as const
export const MANUAL_ROWS_POLICY_ALLOWED = 'allowed' as const
export const MANUAL_ROWS_POLICY_DISABLED = 'disabled' as const
export type ManualRowsPolicy = typeof MANUAL_ROWS_POLICY_ALLOWED | typeof MANUAL_ROWS_POLICY_DISABLED

function asPropertyObject(property: unknown): Record<string, unknown> | null {
  if (property && typeof property === 'object' && !Array.isArray(property)) return property as Record<string, unknown>
  if (typeof property === 'string' && property.trim()) {
    try {
      const parsed = JSON.parse(property)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/**
 * The switch value a raw or sanitized property CARRIES, normalized: null when the key is absent (or its value is
 * `undefined`, which JSON cannot store); `'allowed'` only for the exact literal; `'disabled'` for every other present
 * value (another string, null, a boolean, a number, an object).
 */
export function manualRowsPolicyValueOf(property: unknown): ManualRowsPolicy | null {
  const obj = asPropertyObject(property)
  if (!obj || !Object.prototype.hasOwnProperty.call(obj, MANUAL_ROWS_POLICY_PROPERTY_KEY)) return null
  const value = obj[MANUAL_ROWS_POLICY_PROPERTY_KEY]
  if (value === undefined) return null
  return value === MANUAL_ROWS_POLICY_ALLOWED ? MANUAL_ROWS_POLICY_ALLOWED : MANUAL_ROWS_POLICY_DISABLED
}

/** The switch's EFFECT: absent = allowed; `'allowed'` = allowed; anything else present = disabled. */
export function manualRowsPolicyOfProperty(property: unknown): ManualRowsPolicy {
  return manualRowsPolicyValueOf(property) ?? MANUAL_ROWS_POLICY_ALLOWED
}

/** The person field-write entry (`POST /fields`, `PATCH /fields/:fieldId`): a person can never SET the key. */
export function stripManualRowPolicyKey(property: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(property, MANUAL_ROWS_POLICY_PROPERTY_KEY)) return property
  const { [MANUAL_ROWS_POLICY_PROPERTY_KEY]: _dropped, ...rest } = property
  return rest
}

/**
 * Cross-cutting sanitizer rule (both `sanitizeFieldProperty` chokepoints — field-codecs.ts, which the provisioning
 * write and the read serializer use, and the route-local sibling in routes/univer-meta.ts): a present value is kept
 * as `'allowed'` or normalized to `'disabled'`, an absent one stays absent. Applied OUTSIDE the per-type switch so a
 * closed-allowlist branch cannot drop it. Never mutates a shared property object: a rewrite or a removal happens on a
 * copy.
 */
export function withManualRowPolicyKey(sanitized: Record<string, unknown>, source: unknown): Record<string, unknown> {
  const policy = manualRowsPolicyValueOf(source)
  if (policy === null) return stripManualRowPolicyKey(sanitized)
  if (sanitized[MANUAL_ROWS_POLICY_PROPERTY_KEY] === policy) return sanitized
  return { ...sanitized, [MANUAL_ROWS_POLICY_PROPERTY_KEY]: policy }
}

/**
 * `PATCH /fields/:fieldId` and the field config revert: a person can never SET, CLEAR or CHANGE the switch. Whatever
 * the body said, the STORED value (normalized) is carried onto the next property; a field without one gets none.
 */
export function carryManualRowPolicy(storedProperty: unknown, nextProperty: Record<string, unknown>): Record<string, unknown> {
  const next = stripManualRowPolicyKey(nextProperty)
  const policy = manualRowsPolicyValueOf(storedProperty)
  return policy === null ? next : { ...next, [MANUAL_ROWS_POLICY_PROPERTY_KEY]: policy }
}

// ── the template's columns, by what a manual row may do with them (ADR §3.2 / §3.3) ───────────────
//
// LOGICAL ids of the frozen main template (plugins/plugin-integration-core/lib/stock-preparation-templates.cjs). The
// physical id of each on a project sheet is DERIVED by the host (provisioning.ts getObjectFieldId) from the sheet's
// registry row. The census test requires the plugin template and pins that every one of its 33 columns sits in
// exactly one class below.

/** 人工可填 (6): the only locked columns the manual-row routes may write (the lock exemption). */
export const MANUAL_ROW_FILLABLE_FIELD_IDS = Object.freeze([
  'componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity',
] as const)
/** 谱系显示 (2): never copied (OQ5) and never written by a manual-row route. */
export const MANUAL_ROW_LINEAGE_FIELD_IDS = Object.freeze(['parentComponentCode', 'parentComponentName'] as const)
/** 备料计划 (5, human columns): copied when the actor can read and write them. */
export const MANUAL_ROW_PLAN_FIELD_IDS = Object.freeze([
  'materialType', 'blankType', 'demandDate', 'leadTimeDays', 'makeOrBuy',
] as const)
/** 进度与回复 (8, human columns): never copied; writable on a new manual row as on any row. */
export const MANUAL_ROW_PROGRESS_FIELD_IDS = Object.freeze([
  'stockPreparationStatus', 'notes', 'procurementReply', 'warehouseConfirmation',
  'procurementDone', 'procurementReplyDate', 'warehouseDone', 'actualArrivalDate',
] as const)
/** 身份与 RUN (9): left EMPTY on a manual row — never copied, never written by a manual-row route. */
export const MANUAL_ROW_IDENTITY_RUN_FIELD_IDS = Object.freeze([
  'componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion',
  'lastPlmRefreshRunId', 'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary',
] as const)
/** 盖章 (3): written by the server only (项目号 from the plugin registry, the key, 有效 = true). */
export const MANUAL_ROW_STAMP_FIELD_IDS = Object.freeze(['projectNo', 'idempotencyKey', 'active'] as const)

export const MANUAL_ROW_PROJECT_NO_FIELD_ID = 'projectNo' as const
export const MANUAL_ROW_KEY_FIELD_ID = 'idempotencyKey' as const
export const MANUAL_ROW_ACTIVE_FIELD_ID = 'active' as const

/** The required rewrite of ONE manual-row create (ADR §3.2): these lose `required` … */
export const MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS = Object.freeze(['componentSourceId', 'path'] as const)
/** … and these gain it. The edit route refuses to CLEAR the same two the dialog marks required (§3.4). */
export const MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS = Object.freeze(['componentName'] as const)
export const MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS = Object.freeze(['componentName', 'totalQuantity'] as const)

export type ManualRowTemplateClass = 'fillable' | 'lineage' | 'plan' | 'progress' | 'identity_run' | 'stamp'

export const MANUAL_ROW_TEMPLATE_CLASSES: Readonly<Record<ManualRowTemplateClass, readonly string[]>> = Object.freeze({
  fillable: MANUAL_ROW_FILLABLE_FIELD_IDS,
  lineage: MANUAL_ROW_LINEAGE_FIELD_IDS,
  plan: MANUAL_ROW_PLAN_FIELD_IDS,
  progress: MANUAL_ROW_PROGRESS_FIELD_IDS,
  identity_run: MANUAL_ROW_IDENTITY_RUN_FIELD_IDS,
  stamp: MANUAL_ROW_STAMP_FIELD_IDS,
})

/** The classes a manual-row route may never write a value into (the server stamps or leaves them empty). */
export const MANUAL_ROW_NEVER_WRITTEN_CLASSES: readonly ManualRowTemplateClass[] = Object.freeze(['lineage', 'identity_run', 'stamp'] as const)

/** A value the edit route treats as CLEARING a not-clearable column. */
export function isClearingManualRowValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}
