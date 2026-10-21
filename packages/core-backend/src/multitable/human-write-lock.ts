/**
 * HUMAN WRITE LOCK — a field whose value is owned by a SYSTEM writer (a plugin's records SDK path) and is
 * therefore read-only for every person, administrators included.
 *
 * WHY THIS EXISTS (stock-prep option B, awaiting the owner's A/B/C ruling). On a one-sheet-per-project
 * 备料 sheet the PLM columns (project no, unique key, PLM material id, BOM path, quantities, the
 * refresh trace …) are written by the PLM pull — dry-run → apply through `context.api.multitable.records`
 * — and are the identity the NEXT pull matches rows on. A person who range-fills 1,000 cells over the
 * unique key cannot undo it, and the next pull then plans against corrupted keys. So the plugin marks
 * those columns and the host refuses a HUMAN write to them.
 *
 * WHAT IT IS, PRECISELY.
 *   - A closed-vocabulary field property, `property.humanWriteLock = 'plm_system'`. Anything else
 *     (absent, another string, a boolean, an object) is NOT a lock — the predicate below answers false
 *     and both sanitizers drop the junk value.
 *   - Folded into the PERSON-facing permission derivation (`deriveFieldPermissions` → `readOnly: true`,
 *     so the grid / drawer / form render the column read-only and every route that gates on
 *     `isFieldWriteForbidden` refuses it) and into the three property-level write guards the person
 *     write spines use (routes/univer-meta.ts, record-service.ts, the Yjs bridge in index.ts).
 *   - Deliberately NOT folded into `isFieldAlwaysReadOnly`. That predicate is ALSO the plugin records
 *     SDK's guard (`records.ts buildNormalizedPatch`), and the plugin's apply IS the writer of these
 *     columns. Keeping the two predicates apart is the whole "bypass": the plugin records path never
 *     consults this module, so it keeps writing. There is no flag, no actor check and no exemption list —
 *     the person paths and the plugin path are different functions, and only the person paths look here.
 *     tests/unit/multitable-human-write-lock.test.ts pins both halves (a person path that stops refusing
 *     goes red, AND a plugin path that starts refusing goes red).
 *
 * WHO MAY SET OR CLEAR IT. Only plugin provisioning (`provisioning.patchObjectFieldProperty`, which is
 * object-scope checked to the owning plugin). The person field routes cannot: `POST /fields` strips it
 * and `PATCH /fields/:fieldId` carries the stored value over whatever the body says
 * (`carryHumanWriteLock`). A sheet copy drops it (the copy is the copier's sheet; nothing system-writes
 * it). There is NO administrator override — by design, until the owner asks for one.
 *
 * VALUES-FREE. Refusals name the caller-submitted field ids (the caller already knows them) and a fixed
 * code; never a value.
 *
 * No heavy imports: this module is required by field-codecs.ts and permission-derivation.ts, so it
 * must not import either (no load cycle).
 */

export const FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY = 'humanWriteLock' as const

/** The closed vocabulary. One kind today; a new kind needs its own refusal code below. */
export const FIELD_HUMAN_WRITE_LOCK_KINDS = ['plm_system'] as const
export type FieldHumanWriteLockKind = (typeof FIELD_HUMAN_WRITE_LOCK_KINDS)[number]

/** The closed refusal code a person write to a locked column answers with (HTTP 403). */
export const FIELD_READONLY_PLM_SYSTEM_CODE = 'FIELD_READONLY_PLM_SYSTEM' as const

const REFUSAL_CODE_BY_KIND: Readonly<Record<FieldHumanWriteLockKind, string>> = Object.freeze({
  plm_system: FIELD_READONLY_PLM_SYSTEM_CODE,
})

const KIND_SET: ReadonlySet<string> = new Set<string>(FIELD_HUMAN_WRITE_LOCK_KINDS)

/** Values-free message: says what kind of column it is and who writes it, never a value. */
export const FIELD_READONLY_PLM_SYSTEM_MESSAGE =
  'These columns are written by the PLM pull and are read-only here; change them in PLM and pull again.'

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

/** The lock kind a raw or sanitized property carries, or null. Exact closed-vocabulary match only. */
export function humanWriteLockKindOfProperty(property: unknown): FieldHumanWriteLockKind | null {
  const obj = asPropertyObject(property)
  if (!obj) return null
  const value = obj[FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY]
  return typeof value === 'string' && KIND_SET.has(value) ? (value as FieldHumanWriteLockKind) : null
}

export function fieldHumanWriteLockKind(field: { property?: unknown } | null | undefined): FieldHumanWriteLockKind | null {
  if (!field) return null
  return humanWriteLockKindOfProperty(field.property)
}

/**
 * Is this field read-only for PEOPLE because a system writer owns its value? Never consulted by the
 * plugin records SDK path (see the module header) — that is what keeps the PLM apply writing.
 */
export function isFieldHumanWriteLocked(field: { property?: unknown } | null | undefined): boolean {
  return fieldHumanWriteLockKind(field) !== null
}

/**
 * Does the sheet carry a column that is BOTH human-write-locked AND required by its own validation rules
 * (`property.validation` holds a `{ type: 'required' }` rule — the shape record-service.ts
 * `buildDirectValidationFields` / `validateRecord` enforce on every person record create)?
 *
 * If so, no person can ever create a record on the sheet: leaving the column empty fails the required
 * rule (422), and filling it is a write to a locked column (403). `GET /context` reports this as
 * `capabilities.recordCreateBlockedByLock` so the web hides its "+ row" / add-record / duplicate / new
 * form entries instead of offering actions that always fail. Display-only — every create path keeps its
 * own server refusal. Only the explicit rule counts: the type defaults (getDefaultValidationRules) never
 * contain `required`, and a conditional `requiredWhen` can be satisfied, so neither blocks.
 */
export function hasHumanWriteLockedRequiredField(fields: ReadonlyArray<{ property?: unknown }>): boolean {
  return fields.some((field) => {
    if (!isFieldHumanWriteLocked(field)) return false
    const rules = asPropertyObject(field.property)?.validation
    return Array.isArray(rules) && rules.some((rule) =>
      Boolean(rule) && typeof rule === 'object' && (rule as { type?: unknown }).type === 'required')
  })
}

export function humanWriteLockRefusalCode(kind: FieldHumanWriteLockKind): string {
  return REFUSAL_CODE_BY_KIND[kind]
}

/**
 * Cross-cutting sanitizer rule (both `sanitizeFieldProperty` chokepoints): keep the key ONLY when its value
 * is in the closed vocabulary; drop it otherwise. Applied OUTSIDE the per-type switch for the same reason
 * `withLayer2VisibilityKeys` is — a closed-allowlist branch (person / button / a custom codec) must not be
 * able to silently drop a lock, because a dropped lock fails OPEN.
 */
export function withHumanWriteLockKey(sanitized: Record<string, unknown>, source: unknown): Record<string, unknown> {
  const kind = humanWriteLockKindOfProperty(source)
  if (kind) {
    // A passthrough branch may hand back the caller's own object; only write when the value differs, so a
    // valid lock never mutates a shared property object.
    if (sanitized[FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY] !== kind) sanitized[FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY] = kind
    return sanitized
  }
  // A junk value is dropped on a COPY, never deleted in place (same shared-object reason).
  return stripHumanWriteLockKey(sanitized)
}

/** The person field-write entry (`POST /fields`, `PATCH /fields/:fieldId`): a person can never SET the key. */
export function stripHumanWriteLockKey(property: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(property, FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY)) return property
  const { [FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY]: _dropped, ...rest } = property
  return rest
}

/**
 * `PATCH /fields/:fieldId`: a person can never CLEAR or CHANGE the key either. Whatever the body said, the
 * stored lock (if any) is carried onto the next property and nothing else is.
 */
export function carryHumanWriteLock(storedProperty: unknown, nextProperty: Record<string, unknown>): Record<string, unknown> {
  const next = stripHumanWriteLockKey(nextProperty)
  const kind = humanWriteLockKindOfProperty(storedProperty)
  return kind ? { ...next, [FIELD_HUMAN_WRITE_LOCK_PROPERTY_KEY]: kind } : next
}

/**
 * The caller-submitted field ids that are human-write-locked, in first-seen order, de-duplicated.
 * `canSee` (optional) keeps the closed code to fields the caller can see — an invisible field falls
 * through to the route's generic refusal, so the code is never an existence/kind oracle.
 */
export function listHumanWriteLockedFieldIds(
  fields: ReadonlyArray<{ id: string; property?: unknown }>,
  submittedFieldIds: Iterable<string>,
  canSee: (fieldId: string) => boolean = () => true,
): string[] {
  const lockedIds = new Set(fields.filter((field) => isFieldHumanWriteLocked(field)).map((field) => field.id))
  const out: string[] = []
  for (const fieldId of submittedFieldIds) {
    if (lockedIds.has(fieldId) && canSee(fieldId) && !out.includes(fieldId)) out.push(fieldId)
  }
  return out
}

/**
 * The automation / approval-writeback refusal (a failed step's `error`, and the values-free log line): the fixed
 * code first, then a fixed sentence — never a field id, value, sheet or rule name.
 */
export const HUMAN_WRITE_LOCK_AUTOMATION_REFUSAL =
  `${FIELD_READONLY_PLM_SYSTEM_CODE}: this step writes a column the PLM pull owns; automations cannot write it` as const

type LockLookupQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/**
 * Which of `fieldIds` on `sheetId` are human-write-locked — the bare-SQL writers' check (automation
 * `update_record` / `create_record`, the approval `resultWriteback` sink). Those writers act on behalf of a rule a
 * PERSON authored (`canManageAutomation`), never as the plugin, so they are person writes. No ids → no statement.
 */
export async function findHumanWriteLockedFieldIds(
  query: LockLookupQueryFn,
  sheetId: string,
  fieldIds: Iterable<string>,
): Promise<string[]> {
  const ids = [...new Set([...fieldIds].filter((id) => typeof id === 'string' && id.length > 0))]
  if (!sheetId || ids.length === 0) return []
  const res = await query('SELECT id, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])', [sheetId, ids])
  return (res.rows as Array<{ id?: unknown; property?: unknown }>)
    .filter((row) => typeof row.id === 'string' && humanWriteLockKindOfProperty(row.property) !== null)
    .map((row) => row.id as string)
}

/** The 403 body every person route answers a locked write with. */
export function humanWriteLockRefusalBody(fieldIds: string[]): {
  ok: false
  error: { code: string; message: string; fieldIds: string[] }
} {
  return {
    ok: false,
    error: {
      code: FIELD_READONLY_PLM_SYSTEM_CODE,
      message: FIELD_READONLY_PLM_SYSTEM_MESSAGE,
      fieldIds: [...fieldIds],
    },
  }
}
