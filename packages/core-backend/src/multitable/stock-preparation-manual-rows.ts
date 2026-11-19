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
 * THE PARENT PAIR (ADR §12, owner-ruled 2026-11-19, revising OQ5). A manual row may name its parent component: 父组件图号
 * and 父组件名称 form their own column class (`parent_assignable`), written only by the three manual-row routes and only
 * as a pair; the pure rules P3 – P5 are at the end of this module.
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
// registry row. The census test requires the plugin template and pins that every one of its 35 columns sits in
// exactly one class below.

/**
 * 人工可填 (6): the locked columns a manual-row route may write ONE BY ONE — the grid edits these single cells through
 * PATCH /records/:recordId/manual-fields, and /context names them as `editableFieldIds`.
 */
export const MANUAL_ROW_FILLABLE_FIELD_IDS = Object.freeze([
  'componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity',
] as const)
export const MANUAL_ROW_COMPONENT_CODE_FIELD_ID = 'componentCode' as const
export const MANUAL_ROW_COMPONENT_NAME_FIELD_ID = 'componentName' as const
export const MANUAL_ROW_PARENT_CODE_FIELD_ID = 'parentComponentCode' as const
export const MANUAL_ROW_PARENT_NAME_FIELD_ID = 'parentComponentName' as const
/**
 * 人工可指定父组件 (2; ADR §12, revising OQ5): 父组件图号 and 父组件名称. The three manual-row routes may write them on a
 * manual row — and ONLY as a pair, under the rules below (`manualRowParentPairProblem`, `isManualRowSelfParent`). They
 * share the lock exemption with the six but are deliberately NOT part of `fillable`: /context never lists them as
 * `editableFieldIds`, so the grid cannot edit one of the two cells on its own and leave the pair mismatched. Every
 * generic write path (/patch, PATCH /records, Yjs, range fill, paste, import, forms, automations) keeps treating
 * them as locked PLM columns, on manual rows and PLM rows alike.
 */
export const MANUAL_ROW_PARENT_FIELD_IDS = Object.freeze([MANUAL_ROW_PARENT_CODE_FIELD_ID, MANUAL_ROW_PARENT_NAME_FIELD_ID] as const)
/** 备料计划 (5, human columns): copied when the actor can read and write them. */
export const MANUAL_ROW_PLAN_FIELD_IDS = Object.freeze([
  'materialType', 'blankType', 'demandDate', 'leadTimeDays', 'makeOrBuy',
] as const)
/** 进度与回复 (8, human columns): never copied; writable on a new manual row as on any row. */
export const MANUAL_ROW_PROGRESS_FIELD_IDS = Object.freeze([
  'stockPreparationStatus', 'notes', 'procurementReply', 'warehouseConfirmation',
  'procurementDone', 'procurementReplyDate', 'warehouseDone', 'actualArrivalDate',
] as const)
/**
 * 身份、RUN 与机器列 (11): left EMPTY on a manual row — never copied, never written by a manual-row route. The last two
 * are the R-71 ⑦.4 PR-4 machine columns: 发料确认日期 (`issueConfirmDate`, written only by the YiDa issue-confirm
 * write-back) and 项目规格型号 (`projectSpecModel`, empty until its source is decided). Copying either onto a new row
 * would put a value on it that no machine path wrote.
 */
export const MANUAL_ROW_IDENTITY_RUN_FIELD_IDS = Object.freeze([
  'componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion',
  'lastPlmRefreshRunId', 'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary',
  'issueConfirmDate', 'projectSpecModel',
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

export type ManualRowTemplateClass = 'fillable' | 'parent_assignable' | 'plan' | 'progress' | 'identity_run' | 'stamp'

export const MANUAL_ROW_TEMPLATE_CLASSES: Readonly<Record<ManualRowTemplateClass, readonly string[]>> = Object.freeze({
  fillable: MANUAL_ROW_FILLABLE_FIELD_IDS,
  parent_assignable: MANUAL_ROW_PARENT_FIELD_IDS,
  plan: MANUAL_ROW_PLAN_FIELD_IDS,
  progress: MANUAL_ROW_PROGRESS_FIELD_IDS,
  identity_run: MANUAL_ROW_IDENTITY_RUN_FIELD_IDS,
  stamp: MANUAL_ROW_STAMP_FIELD_IDS,
})

/** The classes a manual-row route may never write a value into (the server stamps or leaves them empty). */
export const MANUAL_ROW_NEVER_WRITTEN_CLASSES: readonly ManualRowTemplateClass[] = Object.freeze(['identity_run', 'stamp'] as const)

/**
 * The classes the LOCK EXEMPTION covers (ADR §12.3 「锁豁免的边界变化」): 6 + 2 = 8 columns, on the three manual-row routes
 * only, and only for a new manual row or a row that satisfies M. Disjoint from the never-written classes.
 */
export const MANUAL_ROW_LOCK_EXEMPT_CLASSES: readonly ManualRowTemplateClass[] = Object.freeze(['fillable', 'parent_assignable'] as const)

/**
 * 「新增人工补充行」's columns, in the dialog's order (ADR §8 B3.3: 名称*、总用量*、图号、规格、材质、用量、备注). Logical ids;
 * /context sends the physical ones (`dialogFieldIds`, slice B3) — the web cannot derive a physical id (it is a hash of the
 * host registry row's project and object, provisioning.ts getObjectFieldId) and the field stanza carries no logical id.
 * Six fillable columns plus 备注 (a human column, writable on any row).
 */
export const MANUAL_ROW_DIALOG_FIELD_IDS = Object.freeze([
  'componentName', 'totalQuantity', 'componentCode', 'componentSpec', 'material', 'rawQuantity', 'notes',
] as const)

/** A value the edit route treats as CLEARING a not-clearable column. */
export function isClearingManualRowValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

// ── the parent pair (ADR §12.3, rules P3 – P5) ──────────────────────────────────────────────────────
//
// 父组件图号 / 父组件名称 of a manual row are a DISPLAY attribute of that one row (P6: the server never checks that the
// parent exists on the sheet, and no reference is created). What the server does hold is the shape of the pair:
//   P3  the two columns travel together: a request that names one names the other too;
//   P4  each value is a string or null. Both blank = no parent. 图号 non-blank + 名称 blank = a parent without a name
//       (PLM has such parents). 名称 non-blank + 图号 blank is refused — the fill view groups by 图号, so a parent that
//       has only a name cannot be grouped. BLANK is judged on the trimmed value; the STORED value is the submitted
//       one, never rewritten (a candidate picked from the sheet must match the PLM text byte for byte, or the row
//       lands in another group);
//   P5  a row is not its own parent: 父组件图号 must differ from the row's own 图号 (`isManualRowSelfParent`).

/** P4 「空」: null / absent, or a string that is empty once trimmed. */
export function isBlankManualRowParentValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/** P4: the only value types a pair column takes. */
export function isManualRowParentValueType(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export type ManualRowParentPairProblem = 'pair_incomplete' | 'not_text' | 'name_without_code'

/**
 * P3 and P4 for ONE request (or one source row, for the copy). `hasCode` / `hasName` say whether the column was named
 * at all; a request that names neither has no pair to judge (null). Pure; reads nothing but its arguments.
 */
export function manualRowParentPairProblem(input: { hasCode: boolean; hasName: boolean; code?: unknown; name?: unknown }): ManualRowParentPairProblem | null {
  if (!input.hasCode && !input.hasName) return null
  if (input.hasCode !== input.hasName) return 'pair_incomplete'
  if (!isManualRowParentValueType(input.code) || !isManualRowParentValueType(input.name)) return 'not_text'
  if (isBlankManualRowParentValue(input.code) && !isBlankManualRowParentValue(input.name)) return 'name_without_code'
  return null
}

/**
 * What a 图号 cell COMPARES as for P5: its text without the surrounding whitespace, or null when there is nothing to
 * compare. A number or boolean a raw client stored in the text column compares as its String() form, which is what
 * the grid groups it under. Never used to rewrite a stored value.
 */
export function comparableManualRowCode(value: unknown): string | null {
  const text = typeof value === 'string'
    ? value
    : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : null
  if (text === null) return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * P5: the row would be its own parent. Case-sensitive, surrounding whitespace ignored on both sides (the 图号 rule
 * the same-material reminder uses, ADR §5.3). A blank parent or a row without its own 图号 is never a self-parent.
 */
export function isManualRowSelfParent(parentCode: unknown, componentCode: unknown): boolean {
  const parent = comparableManualRowCode(parentCode)
  return parent !== null && parent === comparableManualRowCode(componentCode)
}
