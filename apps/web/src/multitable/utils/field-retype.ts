/**
 * Which field types the field-manager edit panel may re-type INTO, and nothing else.
 *
 * BOUNDARY (F8A, 2026-09-11 — CHANGED): this table is no longer the only thing
 * standing between a user and a lossy retype. The backend `PATCH /fields/:fieldId`
 * (routes/univer-meta.ts:12905) still performs a raw `UPDATE meta_fields` with **no
 * cell-value migration** (multitable/lossy-retype-oracle.ts:5-7), but it now refuses
 * any (current → next) pair outside the SAME whitelist, 400
 * `FIELD_RETYPE_NOT_LOSSLESS` (core-backend/src/multitable/field-retype-whitelist.ts).
 * THAT copy is the authority; this one is the dropdown the user sees. Both are pinned
 * to one shared truth table —
 * packages/core-backend/tests/fixtures/field-retype-truth-table.json — by two mirror
 * tests, so a one-sided edit reddens its own side and a table edit reddens both.
 *
 * The table lists ONLY directions where the stored JSON value stays readable under the
 * new type (number → text, currency/percent/rating → number|text, select → text,
 * url/email/phone/barcode → text, text → longText, plain longText → text). Data is NOT
 * converted; the values are simply still valid.
 *
 * EXCLUSION MIRROR: no target may be a type the backend's own retype-safety set
 * rejects — `FIELD_RETYPE_EXCLUDED_TYPES` in
 * packages/core-backend/src/multitable/config-restore.ts:78-81
 * (formula/lookup/rollup/link/attachment/button/autoNumber + the system stamp
 * types). Those need the type-transition side effects (autoNumber sequence, formula
 * deps, link join table) that the raw UPDATE skips, and `link`/`formula` conversions
 * carry their own route-side guards (univer-meta.ts:13025/:13060). The server-side
 * whitelist deliberately does NOT rule on pairs touching those types — it defers to
 * those guards, so their behaviour is unchanged. `losslessRetypeTargets` re-filters
 * against that set so a careless table edit can never surface an excluded target in
 * the dropdown.
 *
 * NOT included on purpose: multiSelect/person (array ⇄ scalar, JSON sprayed at the
 * user), checkbox → text (`true/false`, not 是/否), date/dateTime (ISO text is a
 * silent downgrade), text → select (the select write path hard-validates, so the old
 * values could never be saved again), duration/qrcode (storage shape unverified), and
 * RICH longText → text (raw HTML would be exposed — see `losslessRetypeTargets`).
 */

/** Mirror of core-backend config-restore.ts:78-81. Targets in this set are never offered. */
export const RETYPE_EXCLUDED_TARGET_TYPES: ReadonlySet<string> = new Set([
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])

/** source type → allowed target types (lossless, FE-offered directions only). */
export const LOSSLESS_RETYPE: Record<string, string[]> = {
  number: ['string'],
  currency: ['number', 'string'],
  percent: ['number', 'string'],
  rating: ['number', 'string'],
  select: ['string'],
  url: ['string'],
  email: ['string'],
  phone: ['string'],
  barcode: ['string'],
  string: ['longText'],
  // F8A: the one direction this cut adds. A plain longText cell IS a string — nothing
  // about the stored value changes. Gated on `property.rich` below, not here.
  longText: ['string'],
}

/** `property.rich === true` STRICTLY (junk → not rich) — mirrors core-backend field-codecs.ts:801. */
function isRichLongTextProperty(property: unknown): boolean {
  return Boolean(property) && typeof property === 'object' && !Array.isArray(property)
    && (property as { rich?: unknown }).rich === true
}

/**
 * Target types offered for `sourceType`, minus the source itself and minus anything
 * in `RETYPE_EXCLUDED_TARGET_TYPES`. Empty array = the type stays read-only in the UI.
 *
 * `property` is the SOURCE field's stored property. A RICH longText (`rich === true`)
 * offers nothing: its cells hold HTML that a plain text field would show as bare
 * markup — that is not "the value stays readable". A missing / non-object property
 * reads as non-rich, which matches the storage shape (a rich field always carries
 * `rich: true`); the authoritative check runs server-side against the DB row anyway
 * (core-backend/src/multitable/field-retype-whitelist.ts), so a stale/absent property
 * here can only make the dropdown optimistic, never make a lossy write land.
 */
export function losslessRetypeTargets(sourceType: string | null | undefined, property?: unknown): string[] {
  if (!sourceType) return []
  if (sourceType === 'longText' && isRichLongTextProperty(property)) return []
  const targets = LOSSLESS_RETYPE[sourceType]
  if (!targets) return []
  return targets.filter((target) => target !== sourceType && !RETYPE_EXCLUDED_TARGET_TYPES.has(target))
}

/**
 * "Lossless" above is only about the STORED CELL VALUES staying readable. A field's
 * `property.validation` is a *typed contract*, and it does NOT travel: carrying a
 * number field's `min: 10` into a text field would make every non-numeric write fail
 * forever, because the engine's numeric predicates coerce first and reject on
 * `null` (core-backend/src/multitable/field-validation-engine.ts:76-80 →
 * record-service.ts:725-731 throws RecordValidationFailedError). The server does not
 * strip it either — `sanitizeFieldProperty` returns unknown keys as-is for text types
 * (multitable/field-codecs.ts:551) — so the FE must not send them.
 *
 * The catalogue below mirrors, one for one, the rule rows MetaFieldValidationPanel.vue
 * renders per panel type (`data-rule-type=` at :9/:32/:62/:92/:136/:165/:197): a rule
 * survives a retype only if the target type's own panel could have authored it.
 */
export type ValidationPanelType = 'text' | 'number' | 'select'

const VALIDATION_RULES_BY_PANEL_TYPE: Record<ValidationPanelType, ReadonlySet<string>> = {
  // `required` is rendered outside the per-type templates → valid everywhere.
  text: new Set(['required', 'minLength', 'maxLength', 'pattern']),
  number: new Set(['required', 'min', 'max']),
  select: new Set(['required', 'enum']),
}

/** Which validation panel a field type uses, or null when it has no validation surface. */
export function validationPanelTypeFor(fieldType: string | null | undefined): ValidationPanelType | null {
  if (fieldType === 'string' || fieldType === 'longText') return 'text'
  if (fieldType === 'number') return 'number'
  if (fieldType === 'select' || fieldType === 'multiSelect') return 'select'
  return null
}

/**
 * Rules from the pre-retype draft that the TARGET type may keep. Fail-closed: an
 * unknown/valueless target type keeps nothing, and any non-rule entry is dropped.
 * Engine shape in, engine shape out (`{ type, params?, message? }`).
 */
export function retainedRetypeValidationRules(rules: unknown, targetType: string | null | undefined): unknown[] {
  const panelType = validationPanelTypeFor(targetType)
  if (!panelType || !Array.isArray(rules)) return []
  const allowed = VALIDATION_RULES_BY_PANEL_TYPE[panelType]
  return rules.filter((rule) => {
    if (!rule || typeof rule !== 'object') return false
    const ruleType = (rule as { type?: unknown }).type
    return typeof ruleType === 'string' && allowed.has(ruleType)
  })
}
