import sanitizeHtml from 'sanitize-html'
import { normalizeAutoNumberProperty } from './auto-number-property'
import { fieldTypeRegistry } from './field-type-registry'
import { withFieldVisibilityRule } from './field-visibility-rule'

export type MultitableFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'formula'
  | 'select'
  | 'multiSelect'
  | 'link'
  | 'person'
  | 'lookup'
  | 'rollup'
  | 'attachment'
  | 'currency'
  | 'percent'
  | 'rating'
  | 'url'
  | 'email'
  | 'phone'
  | 'barcode'
  | 'qrcode'
  | 'location'
  | 'longText'
  | 'autoNumber'
  | 'createdTime'
  | 'modifiedTime'
  | 'createdBy'
  | 'modifiedBy'
  | 'button'

export type MultitableField = {
  id: string
  name: string
  type: MultitableFieldType
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isPlainObject(parsed)) return parsed
    } catch {
      return {}
    }
  }
  return {}
}

export function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return ''
      })
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizeJsonArray(parsed)
    } catch {
      return []
    }
  }
  return []
}

export function mapFieldType(type: string): MultitableFieldType | string {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'date') return 'date'
  if (
    normalized === 'datetime' ||
    normalized === 'date_time' ||
    normalized === 'date-time' ||
    normalized === 'timestamp'
  ) {
    return 'dateTime'
  }
  if (normalized === 'formula') return 'formula'
  if (normalized === 'button') return 'button'
  if (normalized === 'select') return 'select'
  if (
    normalized === 'multiselect' ||
    normalized === 'multi_select' ||
    normalized === 'multi-select'
  ) {
    return 'multiSelect'
  }
  if (normalized === 'link') return 'link'
  // Native person field (人员 / member, design 2026-06-16). Stored as a first-class
  // `type='person'` whose value is `userId[]` — NOT aliased to `link` anymore.
  // COEXISTENCE: legacy person fields are persisted as `type='link'`+`refKind:'user'`
  // (they were never stored as 'person'), so this flip only affects NEW person fields
  // and never reinterprets a stored link-backed person. See `validatePersonValue`.
  if (normalized === 'person') return 'person'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  if (normalized === 'currency') return 'currency'
  if (normalized === 'percent') return 'percent'
  if (normalized === 'rating') return 'rating'
  if (normalized === 'url') return 'url'
  if (normalized === 'email') return 'email'
  if (normalized === 'phone') return 'phone'
  if (normalized === 'barcode' || normalized === 'bar_code' || normalized === 'bar-code') return 'barcode'
  if (normalized === 'qrcode' || normalized === 'qr_code' || normalized === 'qr-code' || normalized === 'qr') return 'qrcode'
  if (
    normalized === 'location' ||
    normalized === 'geo' ||
    normalized === 'geolocation' ||
    normalized === 'geo_location' ||
    normalized === 'geo-location'
  ) {
    return 'location'
  }
  if (
    normalized === 'autonumber' ||
    normalized === 'auto_number' ||
    normalized === 'auto-number'
  ) {
    return 'autoNumber'
  }
  if (normalized === 'createdtime' || normalized === 'created_time' || normalized === 'created-time') {
    return 'createdTime'
  }
  if (normalized === 'modifiedtime' || normalized === 'modified_time' || normalized === 'modified-time') {
    return 'modifiedTime'
  }
  if (normalized === 'createdby' || normalized === 'created_by' || normalized === 'created-by') return 'createdBy'
  if (normalized === 'modifiedby' || normalized === 'modified_by' || normalized === 'modified-by') return 'modifiedBy'
  if (
    normalized === 'longtext' ||
    normalized === 'long_text' ||
    normalized === 'long-text' ||
    normalized === 'textarea' ||
    normalized === 'multi_line_text' ||
    normalized === 'multiline'
  ) {
    return 'longText'
  }
  if (fieldTypeRegistry.has(normalized)) return normalized
  return 'string'
}

export function extractSelectOptions(
  property: unknown,
): Array<{ value: string; color?: string }> | undefined {
  const obj = normalizeJson(property)
  const raw = obj.options
  if (!Array.isArray(raw)) return undefined

  const options: Array<{ value: string; color?: string }> = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const value = item.value
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const color = typeof item.color === 'string' ? item.color : undefined
    options.push({ value: String(value), ...(color ? { color } : {}) })
  }

  return options.length > 0 ? options : undefined
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parseRollupAggregation(value: unknown): 'count' | 'sum' | 'avg' | 'min' | 'max' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'counta') return 'count'
  if (
    normalized === 'count' ||
    normalized === 'sum' ||
    normalized === 'avg' ||
    normalized === 'min' ||
    normalized === 'max'
  ) {
    return normalized as 'count' | 'sum' | 'avg' | 'min' | 'max'
  }
  return null
}

export function sanitizeFieldProperty(
  type: MultitableFieldType | string,
  property: unknown,
): Record<string, unknown> {
  // `visibilityRule` is a CROSS-CUTTING property (any field type may carry it),
  // so it is sanitized + merged uniformly after the per-type normalization
  // rather than relying on each branch's incidental `...obj` passthrough (which
  // would also let a *malformed* rule leak through). See field-visibility-rule.ts.
  return withFieldVisibilityRule(sanitizeFieldPropertyByType(type, property), property)
}

function sanitizeFieldPropertyByType(
  type: MultitableFieldType | string,
  property: unknown,
): Record<string, unknown> {
  const obj = normalizeJson(property)
  if (type === 'select' || type === 'multiSelect') {
    const options = extractSelectOptions(obj) ?? []
    return { ...obj, options }
  }

  if (type === 'link') {
    const { foreignBaseId: _omitForeignBaseId, ...cleanObj } = obj
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    // ②b slice 1 — promote foreignBaseId (the cross-base opt-in claim) to an EXPLICIT normalized key
    // (trim; empty → omitted), mirroring univer-meta.ts's sanitizeFieldProperty so the claim is
    // contractual, not incidental `...obj` passthrough (wire-vs-fixture).
    const foreignBaseId =
      typeof obj.foreignBaseId === 'string' && obj.foreignBaseId.trim().length > 0
        ? obj.foreignBaseId.trim()
        : ''
    // Bidirectional / mirror links (design 2026-06-14) — mirror univer-meta.ts's sanitizeFieldProperty so
    // the pairing config (twoWay / mirrorFieldId / mirrorOf) is contractual, not incidental `...obj`
    // passthrough (wire-vs-fixture). The derived side (`mirrorOf` set) is forced read-only.
    const mirrorFieldId =
      typeof obj.mirrorFieldId === 'string' && obj.mirrorFieldId.trim().length > 0
        ? obj.mirrorFieldId.trim()
        : ''
    const mirrorOf =
      typeof obj.mirrorOf === 'string' && obj.mirrorOf.trim().length > 0
        ? obj.mirrorOf.trim()
        : ''
    return {
      ...cleanObj,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId } : {}),
      ...(foreignSheetId && foreignBaseId ? { foreignBaseId } : {}),
      limitSingleRecord: obj.limitSingleRecord === true,
      ...(typeof obj.refKind === 'string' && obj.refKind.trim().length > 0
        ? { refKind: obj.refKind.trim() }
        : {}),
      ...(obj.twoWay === true ? { twoWay: true } : {}),
      ...(mirrorFieldId ? { mirrorFieldId } : {}),
      ...(mirrorOf ? { mirrorOf, readOnly: true } : {}),
    }
  }

  if (type === 'person') {
    // Native person (人员) — value is `userId[]`. The ONLY user-controlled option is
    // `limitSingleRecord` (single vs multi). CRITICAL default: `!== false` → undefined
    // defaults to TRUE, matching the legacy person path (univer-meta normalizeFieldWriteInput
    // + people-import) so single/multi behaviour never silently flips between a legacy
    // link-backed person and a native person. NOT readOnly (person is user-editable).
    //
    // `restrictToMemberGroupIds` is an OPTIONAL future narrowing config (member-group scope);
    // sanitized to a deduped string[] when present, omitted otherwise. NOTE: it is config-shape
    // ONLY and NOT YET ENFORCED — `validatePersonValue` checks SHEET membership, not the group
    // subset, so a field carrying this still accepts any sheet member. Enforcement (intersect the
    // member set with the configured groups) is a follow-up; until then this is a stored hint, not
    // an active restriction. (Sanitizing the shape now keeps the contract stable for that follow-up.)
    const restrict = sanitizeStringArray(obj.restrictToMemberGroupIds)
    return {
      limitSingleRecord: obj.limitSingleRecord !== false,
      ...(restrict.length > 0 ? { restrictToMemberGroupIds: Array.from(new Set(restrict)) } : {}),
    }
  }

  if (type === 'lookup') {
    const linkFieldId =
      typeof (obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId) ===
      'string'
        ? String(
            obj.linkFieldId ??
              obj.relatedLinkFieldId ??
              obj.linkedFieldId ??
              obj.sourceFieldId,
          ).trim()
        : ''
    const targetFieldId =
      typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) ===
      'string'
        ? String(
            obj.targetFieldId ??
              obj.lookUpTargetFieldId ??
              obj.lookupTargetFieldId ??
              obj.lookupFieldId,
          ).trim()
        : ''
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, relatedLinkFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId, lookUpTargetFieldId: targetFieldId } : {}),
      ...(foreignSheetId
        ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId }
        : {}),
    }
  }

  if (type === 'rollup') {
    const linkFieldId =
      typeof (obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId) ===
      'string'
        ? String(
            obj.linkFieldId ??
              obj.linkedFieldId ??
              obj.relatedLinkFieldId ??
              obj.sourceFieldId,
          ).trim()
        : ''
    const targetFieldId =
      typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) ===
      'string'
        ? String(
            obj.targetFieldId ??
              obj.lookUpTargetFieldId ??
              obj.lookupTargetFieldId ??
              obj.lookupFieldId,
          ).trim()
        : ''
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    const aggregation =
      parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction) ??
      'count'
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, linkedFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId } : {}),
      aggregation,
      ...(foreignSheetId
        ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId }
        : {}),
    }
  }

  if (type === 'formula') {
    return {
      ...obj,
      expression: typeof obj.expression === 'string' ? obj.expression.trim() : '',
    }
  }

  if (type === 'attachment') {
    const maxFiles = typeof obj.maxFiles === 'number' ? obj.maxFiles : Number(obj.maxFiles)
    return {
      ...obj,
      ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles: Math.round(maxFiles) } : {}),
      acceptedMimeTypes: sanitizeStringArray(obj.acceptedMimeTypes),
    }
  }

  if (type === 'currency') {
    const codeRaw = typeof obj.code === 'string' ? obj.code.trim().toUpperCase() : ''
    const code = /^[A-Z]{3}$/.test(codeRaw) ? codeRaw : 'CNY'
    const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
    const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
      ? Math.round(decimalsRaw)
      : 2
    return { ...obj, code, decimals }
  }

  if (type === 'number') {
    const next: Record<string, unknown> = { ...obj }
    if ('decimals' in obj) {
      const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
      if (Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6) {
        next.decimals = Math.round(decimalsRaw)
      } else {
        delete next.decimals
      }
    }
    next.thousands = obj.thousands === true
    const unit = typeof obj.unit === 'string' ? obj.unit.trim().slice(0, 24) : ''
    if (unit) next.unit = unit
    else delete next.unit
    return next
  }

  if (type === 'percent') {
    const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
    const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
      ? Math.round(decimalsRaw)
      : 1
    return { ...obj, decimals }
  }

  if (type === 'rating') {
    const maxRaw = typeof obj.max === 'number' ? obj.max : Number(obj.max)
    const max = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 10 ? Math.round(maxRaw) : 5
    return { ...obj, max }
  }

  if (type === 'dateTime') {
    const rawTimezone = typeof obj.timezone === 'string' ? obj.timezone.trim() : ''
    let timezone = rawTimezone || 'UTC'
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    } catch {
      timezone = 'UTC'
    }
    return { ...obj, timezone }
  }

  if (type === 'url' || type === 'email' || type === 'phone' || type === 'barcode' || type === 'qrcode' || type === 'location') {
    return obj
  }

  if (type === 'longText') {
    // `rich` flag (§4) — strict boolean: only `true` opts into rich-text mode; junk → false.
    // This is pure / read-path-safe (runs on every serializeFieldRow); the populated-field
    // toggle rejection (§4 backward-compat) lives in the field-UPDATE route handler, which
    // has the prior field state + a DB connection to count existing values.
    const next = { ...obj }
    if (next.rich === true) next.rich = true
    else delete next.rich
    return next
  }

  if (type === 'autoNumber') {
    return normalizeAutoNumberProperty(obj)
  }

  if (type === 'button') {
    // Button (B1): a value-less, non-editable action trigger. Sanitize the §6
    // config SHAPE only; `actionType ∈ AutomationActionType` is enforced at the
    // field create/update route + at execution (B1-a1), NOT here — this read-path
    // codec stays dependency-light / acyclic (no import of automation-actions).
    // All §6 keys are whitelisted (so editing one never drops actionConfig), and
    // the field is always readOnly (clicked, never edited).
    const next: Record<string, unknown> = { readOnly: true }
    if (typeof obj.label === 'string' && obj.label.trim()) next.label = obj.label.trim()
    if (obj.variant === 'primary' || obj.variant === 'secondary' || obj.variant === 'danger') {
      next.variant = obj.variant
    }
    if (typeof obj.actionType === 'string' && obj.actionType.trim()) next.actionType = obj.actionType.trim()
    if (isPlainObject(obj.actionConfig)) next.actionConfig = obj.actionConfig
    if (isPlainObject(obj.confirm)) {
      const c = obj.confirm
      const confirm: Record<string, unknown> = { enabled: c.enabled === true }
      if (typeof c.message === 'string' && c.message.trim()) confirm.message = c.message.trim()
      next.confirm = confirm
    }
    return next
  }

  if (SYSTEM_FIELD_TYPES.has(type)) {
    return { ...obj, readOnly: true }
  }

  const customDef = fieldTypeRegistry.get(type)
  if (customDef) {
    return customDef.sanitizeProperty(property)
  }

  return obj
}

export function serializeFieldRow(row: any): MultitableField {
  const rawType = String(row.type ?? 'string')
  const mappedType = mapFieldType(rawType)
  const property = sanitizeFieldProperty(mappedType, row.property)
  const order = Number(row.order ?? 0)
  return {
    id: String(row.id),
    name: String(row.name),
    type: mappedType as MultitableFieldType,
    ...(mappedType === 'select' || mappedType === 'multiSelect' ? { options: extractSelectOptions(property) } : {}),
    order: Number.isFinite(order) ? order : 0,
    property,
  }
}

// ---------------------------------------------------------------------------
// MF2 field-types batch 1: currency / percent / rating / url / email / phone / barcode / location / dateTime
// ---------------------------------------------------------------------------
//
// Validation regex chosen to match Feishu's lenient client-side checks and
// keep the server free of external deps. Coercion functions normalize the
// value before it lands in the JSON `data` column. Coercion failures throw
// an `Error` that the caller surfaces as a `RecordValidationError`.

// Permissive ASCII URL: protocol required to differentiate from plain text.
export const URL_REGEX = /^https?:\/\/[^\s]+$/i
// Standard "local@domain.tld" email shape; Unicode in the local part is OK.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Lenient phone: digits + optional separators, 6–24 chars total. Leading +, digit, or ( all allowed.
export const PHONE_REGEX = /^[+\d(][\d\s\-().]{4,23}$/

export function coerceNumericValue(
  value: unknown,
  fieldId: string,
  label: string,
): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} value must be a finite number for ${fieldId}`)
    }
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} value must be numeric for ${fieldId}: ${value}`)
    }
    return parsed
  }
  throw new Error(`${label} value must be a number for ${fieldId}`)
}

export function coerceCurrencyValue(value: unknown, fieldId: string): number | null {
  return coerceNumericValue(value, fieldId, 'Currency')
}

export function coercePercentValue(value: unknown, fieldId: string): number | null {
  return coerceNumericValue(value, fieldId, 'Percent')
}

export function coerceRatingValue(
  value: unknown,
  fieldId: string,
  max: number,
): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = coerceNumericValue(value, fieldId, 'Rating')
  if (num === null) return null
  if (!Number.isInteger(num)) {
    throw new Error(`Rating value must be an integer for ${fieldId}`)
  }
  if (num < 0 || num > max) {
    throw new Error(`Rating value must be between 0 and ${max} for ${fieldId}`)
  }
  return num
}

export function validateUrlValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`URL value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!URL_REGEX.test(trimmed)) {
    throw new Error(`Invalid URL for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

export function validateEmailValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`Email value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new Error(`Invalid email for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

export function validatePhoneValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`Phone value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!PHONE_REGEX.test(trimmed)) {
    throw new Error(`Invalid phone number for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

/**
 * Rich-text `longText` — XSS-safe-by-construction sanitizer (§5 of the design-lock).
 *
 * This is the AUTHORITATIVE write-path defense. The allow-list below is the single
 * source of truth for what a stored rich-`longText` value may contain. Anything not
 * on the list is removed, so every persisted byte is allow-list-clean ("inert by
 * construction"). The FE render lane re-sanitizes client-side (DOMPurify, mXSS
 * defense) but TRUSTS this storage invariant — every user-content writer of
 * `meta_records.data` MUST route rich-`longText` through `sanitizeRichLongText`.
 *
 * Allow-list (§5):
 *  - tags: b strong i em u s · a · ul ol li · h1 h2 h3 · p br blockquote code pre
 *  - attrs: href on <a> only; protocols http/https/mailto; forced rel/target on links
 *  - dropped WITH CONTENTS: script style iframe object embed form svg (no inner-text leak)
 *  - dropped: all on* handlers, style/class/id/src/data-* and any non-listed attr/tag
 */
const RICH_LONGTEXT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'b', 'strong', 'i', 'em', 'u', 's',
    'a',
    'span',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3',
    'p', 'br', 'blockquote', 'code', 'pre',
  ],
  // `rel`/`target` are FORCED by transformTags below (never user-controlled), but must
  // be allow-listed or sanitize-html would strip them after the transform adds them.
  // `data-mention-id` on `<span>` ONLY carries the B5 people-mention chip
  // (`<span data-mention-id="…">@Label</span>`); the chip survives storage inert.
  // This must stay IDENTICAL to the client allow-list (rich-longtext.ts) — see the
  // module header lock-step note. NO other attribute is permitted on a <span>, so a
  // forged `<span data-mention-id onclick=…>` keeps only the inert id, never the
  // handler. The a→span fallback below emits a span with NO attributes (the {} on the
  // transform result), so a rejected link can never masquerade as a chip.
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    span: ['data-mention-id'],
  },
  // Decode-then-check protocol allow-list; rejects `javascript:` and `&#106;avascript:`
  // (entity-encoded) alike. `allowProtocolRelative:false` blocks `//evil.com`.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  // Drop these WITH their contents — sanitize-html's default would unwrap and KEEP
  // inner text, which leaks `<noscript>…`-style payloads. Listing them in
  // nonTextTags removes the element and everything inside it.
  nonTextTags: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'noscript', 'textarea', 'title'],
  // Force safe link rels + new-tab on every surviving <a>. Drops links whose href was
  // stripped (protocol rejected) so we never emit a bare <a> with a dead/unsafe href.
  transformTags: {
    a: (tagName, attribs) => {
      const href = typeof attribs.href === 'string' ? attribs.href : ''
      if (!href) {
        // An href-LESS / empty-href anchor → keep the text, drop the anchor. (A
        // rejected-PROTOCOL anchor still has its href HERE — the scheme filter runs
        // AFTER this transform — so it stays a bare <a>, not a span; see the #c5/#c6
        // canaries that pin both shapes.)
        // NOTE (B5): now that `<span>` is allow-listed for the mention chip, this
        // fallback span SURVIVES as `<span>text</span>` (previously it was discarded
        // because span was not allow-listed). The `attribs: {}` here is load-bearing:
        // the fallback span carries NO `data-mention-id`, so an href-less link can
        // NEVER masquerade as a mention chip. The B5 #c5 regression canary pins this
        // exact shape so the behaviour change is intentional, not silent.
        return { tagName: 'span', attribs: {} }
      }
      return {
        tagName: 'a',
        attribs: {
          href,
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }
    },
  },
  // No CSS/style processing at all.
  allowedStyles: {},
  disallowedTagsMode: 'discard',
}

/**
 * Sanitize a rich-`longText` HTML string against the §5 allow-list. Pure, no DOM.
 * Returns allow-list-clean HTML. Used by `validateLongTextValue` (the 5 record-write
 * validators) AND directly by other user-content writers (automation actions) so the
 * stored invariant holds at every write boundary, not just one line.
 */
export function sanitizeRichLongText(value: string): string {
  return sanitizeHtml(value, RICH_LONGTEXT_SANITIZE_OPTIONS)
}

/**
 * True iff a field property opts the `longText` field into rich-text mode.
 * `property.rich === true` strictly (junk → not rich).
 */
export function isRichLongTextProperty(property: unknown): boolean {
  return isPlainObject(property) && property.rich === true
}

/**
 * True iff a field-property change is an OFF→ON rich-`longText` toggle, i.e. the NEXT
 * state is a rich `longText` field and the CURRENT state was NOT already rich `longText`.
 * Pure; the caller maps the raw stored type via `mapFieldType` before passing it in.
 *
 * Shared by the HTTP field-PATCH route and the plugin-SDK provisioning property write so
 * the backward-compat gate (below) fires identically on both write boundaries.
 */
export function isRichLongTextTurningOn(
  currentType: string,
  currentProperty: unknown,
  nextType: string,
  nextProperty: unknown,
): boolean {
  return (
    nextType === 'longText' &&
    isRichLongTextProperty(nextProperty) &&
    !(currentType === 'longText' && isRichLongTextProperty(currentProperty))
  )
}

/** Minimal query surface for {@link assertRichLongTextToggleAllowed}. */
export type RichLongTextToggleQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Backward-compat gate (§4) shared by every write boundary that can flip a `longText`
 * field to rich. Old plain `longText` values were stored NEVER-SANITIZED; flipping a
 * POPULATED field to `rich` would retroactively reinterpret that raw text as HTML (a
 * stored-XSS hole the write sanitizer never saw). Reject the rich toggle-ON unless the
 * field is empty. No-op on any non-OFF→ON change (rename, already-rich, non-longText).
 *
 * Throws the supplied `makeError(message)` so each caller raises its own error type
 * (HTTP `ValidationError` vs a provisioning `Error`).
 */
export async function assertRichLongTextToggleAllowed(args: {
  query: RichLongTextToggleQueryFn
  sheetId: string
  fieldId: string
  currentType: string
  currentProperty: unknown
  nextType: string
  nextProperty: unknown
  makeError: (message: string) => Error
}): Promise<void> {
  if (
    !isRichLongTextTurningOn(args.currentType, args.currentProperty, args.nextType, args.nextProperty)
  ) {
    return
  }
  const populated = await args.query(
    `SELECT 1 FROM meta_records
     WHERE sheet_id = $1 AND data ? $2 AND NULLIF(data ->> $2, '') IS NOT NULL
     LIMIT 1`,
    [args.sheetId, args.fieldId],
  )
  if ((populated.rows?.length ?? 0) > 0) {
    throw args.makeError(
      '无法对已有数据的长文本字段开启富文本：历史纯文本值未经过净化。请先清空该字段或新建富文本字段。',
    )
  }
}

/**
 * Unified plain-text projection (§7). Strip tags from a (possibly rich) `longText`
 * value down to its text content, decoding entities. ONE helper, used by xlsx export
 * (so a cell is the text, not `<p>…</p>`) and anywhere search/display needs text not
 * markup. Safe to call on plain (non-rich) values too — they have no tags, so the
 * decode-only pass returns them effectively unchanged.
 */
export function richLongTextToPlainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
}

/**
 * Single write-path validator for `longText`, invoked from all 5 record-write call
 * sites (record-service ×2, record-write-service ×2, univer-meta form-submit ×1).
 *
 * The `property` argument is REQUIRED (not optional) on purpose: a call site that
 * forgets to thread the field property would otherwise silently no-op the sanitizer
 * (an unsanitized stored write that isolated unit tests still pass). Requiring it
 * turns "did every site wire it?" into a `tsc` compile error.
 *
 * When the field is rich (`property.rich === true`), the value is sanitized against
 * the §5 allow-list before it is returned for storage — so the persisted value is
 * inert by construction. Plain (non-rich) `longText` is returned verbatim (unchanged
 * legacy behavior).
 */
export function validateLongTextValue(
  value: unknown,
  fieldId: string,
  property: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`Long text value must be a string for ${fieldId}`)
  }
  if (isRichLongTextProperty(property)) {
    return sanitizeRichLongText(value)
  }
  return value
}

export function validateBarcodeValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Barcode value must be a string for ${fieldId}`)
  }
  const trimmed = String(value).trim()
  if (trimmed === '') return null
  if (trimmed.length > 256) {
    throw new Error(`Barcode value must be 256 characters or fewer for ${fieldId}`)
  }
  return trimmed
}

// QR-code field is text-backed like barcode: the stored value is the plain
// string (URL/text) that the frontend renders into a QR image. Render-only —
// the codec never produces image data, only validates/normalizes the source
// string. Cap matches barcode; QR can encode more, but 256 keeps cells sane.
export function validateQrcodeValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`QR code value must be a string for ${fieldId}`)
  }
  const trimmed = String(value).trim()
  if (trimmed === '') return null
  if (trimmed.length > 256) {
    throw new Error(`QR code value must be 256 characters or fewer for ${fieldId}`)
  }
  return trimmed
}

export type LocationValue = {
  address: string
  latitude?: number
  longitude?: number
}

function coerceLocationCoordinate(
  value: unknown,
  label: 'latitude' | 'longitude',
  fieldId: string,
  min: number,
  max: number,
): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) {
    throw new Error(`Location ${label} must be a finite number for ${fieldId}`)
  }
  if (num < min || num > max) {
    throw new Error(`Location ${label} must be between ${min} and ${max} for ${fieldId}`)
  }
  return num
}

export function validateLocationValue(value: unknown, fieldId: string): LocationValue | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') {
    const address = String(value).trim()
    if (!address) return null
    if (address.length > 512) {
      throw new Error(`Location address must be 512 characters or fewer for ${fieldId}`)
    }
    return { address }
  }
  if (!isPlainObject(value)) {
    throw new Error(`Location value must be a string or object for ${fieldId}`)
  }

  const rawAddress = value.address ?? value.name ?? value.fullAddress
  const address = rawAddress === null || rawAddress === undefined ? '' : String(rawAddress).trim()
  if (address.length > 512) {
    throw new Error(`Location address must be 512 characters or fewer for ${fieldId}`)
  }

  const rawLatitude = value.latitude ?? value.lat
  const rawLongitude = value.longitude ?? value.lng ?? value.lon
  const latitude = coerceLocationCoordinate(rawLatitude, 'latitude', fieldId, -90, 90)
  const longitude = coerceLocationCoordinate(rawLongitude, 'longitude', fieldId, -180, 180)
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new Error(`Location latitude and longitude must be provided together for ${fieldId}`)
  }
  if (!address && latitude === undefined) return null

  return {
    address,
    ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}),
  }
}

export function validateDateTimeValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    throw new Error(`DateTime value must be a string, number, or Date for ${fieldId}`)
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid DateTime for ${fieldId}: ${String(value)}`)
  }
  return date.toISOString()
}

export function normalizeMultiSelectValue(
  value: unknown,
  fieldId: string,
  options: string[],
): string[] {
  if (value === null || value === undefined || value === '') return []
  if (!Array.isArray(value)) {
    throw new Error(`Multi-select value must be an array for ${fieldId}`)
  }

  const allowed = new Set(options)
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new Error(`Multi-select option must be a string for ${fieldId}`)
    }
    const option = String(item).trim()
    if (!option) continue
    if (!allowed.has(option)) {
      throw new Error(`Invalid multi-select option for ${fieldId}: ${option}`)
    }
    if (!seen.has(option)) {
      seen.add(option)
      normalized.push(option)
    }
  }
  return normalized
}

/**
 * Native person (人员 / member) value validator — design 2026-06-16.
 *
 * The stored value is a deduped `userId[]` (mirrors {@link normalizeMultiSelectValue}'s
 * array normalization, NOT the recordId[] of a legacy link-backed person). It enforces
 * the SECURITY membership boundary: every userId MUST be in `allowedUserIds` (the sheet/
 * base member set), reusing the SAME member-set resolved once per request batch by the
 * caller (parallel to the link-target-exists loop) so a record cell and a notify recipient
 * share one membership control.
 *
 * - empty / null / '' → `[]`
 * - non-array → throws (callers surface as RecordValidationError)
 * - each id: string|number, trimmed, deduped (order-preserving)
 * - non-member id → throws (the 403/validation reject)
 * - `limitSingleRecord` true → reject more than one id
 *
 * `allowedUserIds === null` means "membership not resolvable for this sheet" — treated as
 * a CLOSED set (reject any non-empty value) so a missing member set can never become an
 * open egress. Callers pass a real Set when a person field is present.
 */
export function validatePersonValue(
  value: unknown,
  fieldId: string,
  allowedUserIds: ReadonlySet<string> | null,
  limitSingleRecord: boolean,
): string[] {
  if (value === null || value === undefined || value === '') return []
  if (!Array.isArray(value)) {
    throw new Error(`Person value must be an array for ${fieldId}`)
  }

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new Error(`Person value must be an array of user ids for ${fieldId}`)
    }
    const userId = String(item).trim()
    if (!userId) continue
    if (userId.length > 50) {
      throw new Error(`Person user id too long (>50) for ${fieldId}: ${userId}`)
    }
    if (!seen.has(userId)) {
      seen.add(userId)
      normalized.push(userId)
    }
  }

  if (normalized.length === 0) return []

  if (limitSingleRecord && normalized.length > 1) {
    throw new Error(`Person field only allows a single user for ${fieldId}`)
  }

  // SECURITY: reject any userId outside the sheet member set. A null set is a closed set.
  const allowed = allowedUserIds ?? new Set<string>()
  const nonMembers = normalized.filter((userId) => !allowed.has(userId))
  if (nonMembers.length > 0) {
    throw new Error(
      `Person user(s) not a member of this sheet for ${fieldId}: ${nonMembers.join(', ')}`,
    )
  }

  return normalized
}

/** True iff `limitSingleRecord` is enabled on a person field property (default TRUE). */
export function isPersonSingleRecord(property: Record<string, unknown> | undefined): boolean {
  return property?.limitSingleRecord !== false
}

/**
 * Coerce / validate a value for one of the MF2 batch-1 field types and
 * return the normalized form to persist. Returns the original value if
 * the field type is not in the batch.
 */
export function coerceBatch1Value(
  fieldType: string,
  property: Record<string, unknown> | undefined,
  fieldId: string,
  value: unknown,
): unknown {
  if (fieldType === 'currency') return coerceCurrencyValue(value, fieldId)
  if (fieldType === 'percent') return coercePercentValue(value, fieldId)
  if (fieldType === 'rating') {
    const sanitized = sanitizeFieldProperty('rating', property ?? {})
    const max = Number(sanitized.max)
    return coerceRatingValue(value, fieldId, Number.isFinite(max) && max > 0 ? max : 5)
  }
  if (fieldType === 'url') return validateUrlValue(value, fieldId)
  if (fieldType === 'email') return validateEmailValue(value, fieldId)
  if (fieldType === 'phone') return validatePhoneValue(value, fieldId)
  if (fieldType === 'barcode') return validateBarcodeValue(value, fieldId)
  if (fieldType === 'qrcode') return validateQrcodeValue(value, fieldId)
  if (fieldType === 'location') return validateLocationValue(value, fieldId)
  if (fieldType === 'dateTime') return validateDateTimeValue(value, fieldId)
  return value
}

export const BATCH1_FIELD_TYPES: ReadonlySet<string> = new Set([
  'currency',
  'percent',
  'rating',
  'url',
  'email',
  'phone',
  'barcode',
  'qrcode',
  'location',
  'dateTime',
])

export const SYSTEM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'autoNumber',
  'createdTime',
  'modifiedTime',
  'createdBy',
  'modifiedBy',
])

export function isSystemFieldType(type: string): boolean {
  return SYSTEM_FIELD_TYPES.has(type)
}
