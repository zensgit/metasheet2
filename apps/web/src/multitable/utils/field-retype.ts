/**
 * Which field types the field-manager edit panel may re-type INTO, and nothing else.
 *
 * BOUNDARY: the backend `PATCH /fields/:fieldId` already accepts `type`
 * (routes/univer-meta.ts:12544) and performs a raw `UPDATE meta_fields` with **no
 * cell-value migration** (multitable/lossy-retype-oracle.ts:5-7). So the only thing
 * standing between a user and a lossy retype is this table: it lists ONLY directions
 * where the stored JSON value stays readable under the new type (number → text,
 * currency/percent/rating → number|text, select → text, url/email/phone/barcode →
 * text, text → longText). Data is NOT converted; the values are simply still valid.
 *
 * EXCLUSION MIRROR: no target may be a type the backend's own retype-safety set
 * rejects — `FIELD_RETYPE_EXCLUDED_TYPES` in
 * packages/core-backend/src/multitable/config-restore.ts:78-82
 * (formula/lookup/rollup/link/attachment/button/autoNumber + the system stamp
 * types). Those need the type-transition side effects (autoNumber sequence, formula
 * deps, link join table) that the raw UPDATE skips, and `link`/`formula` targets are
 * additionally rejected by the route (univer-meta.ts:12655/:12688 → 400).
 * `losslessRetypeTargets` re-filters against that set so a careless table edit can
 * never surface an excluded target in the dropdown.
 *
 * NOT included on purpose: multiSelect (array ⇄ scalar), longText → string (rich
 * HTML would be exposed raw), date/dateTime (display semantics change).
 */

/** Mirror of core-backend config-restore.ts:78-82. Targets in this set are never offered. */
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
}

/**
 * Target types offered for `sourceType`, minus the source itself and minus anything
 * in `RETYPE_EXCLUDED_TARGET_TYPES`. Empty array = the type stays read-only in the UI.
 */
export function losslessRetypeTargets(sourceType: string | null | undefined): string[] {
  if (!sourceType) return []
  const targets = LOSSLESS_RETYPE[sourceType]
  if (!targets) return []
  return targets.filter((target) => target !== sourceType && !RETYPE_EXCLUDED_TARGET_TYPES.has(target))
}
