'use strict'

// DF-T2a — pure derivation helper. Turns an operator-local RAW working sample (e.g. a K3
// GetDetail material) into a DRAFT { payloadTemplate, fieldRules } that the SHIPPED DF-T1
// preview/composer already consume. No UI, no K3 write, no new shaper — it emits the DF-T1
// rule vocabulary and lets `k3-save-body-composer` do the shaping at preview/Save time.
//
// HARD redaction boundary (DF-T2 design / the #1882 round-trip footgun): the executable
// payloadTemplate is built from RAW values and FAILS CLOSED on redaction markers / unfilled
// placeholders / secret-shaped values. `sanitizeIntegrationPayload` is NEVER used to produce a
// template (display/export only); `summarizeTemplateForEvidence()` is the values-free view for
// docs / PR / run evidence (customer reference values stay operator-local).

const {
  isPlainObject,
  isBlankValue,
  findUnfilledPlaceholders,
} = require('./adapters/k3-save-body-composer.cjs')
const { scrubSecretStringValue } = require('./payload-redaction.cjs')

// DF-T1 rule vocabulary. MUST stay within http-routes.cjs DF_T1_SOURCE_TYPES / DF_T1_SHAPES /
// DF_T1_COMPLETENESS (those Sets are route-local; mirrored here and cross-checked end-to-end by
// the DF-T1 preview at the T2c wire slice).
const SOURCE_FROM_STAGING = 'from_staging'
const SOURCE_PRESERVE_TEMPLATE = 'preserve_template'
const SHAPE_SCALAR = 'scalar'
const SHAPE_OBJECT_PASSTHROUGH = 'object-passthrough'
const COMPLETENESS_NONE = 'none'
const COMPLETENESS_FNUMBER_FNAME = 'require-fnumber-fname'
const COMPLETENESS_FID_FNAME = 'require-fid-fname'

// Any shared-scrubber redaction marker that must NEVER be frozen into an executable template:
// the bare `[redacted]` plus every suffixed form the scrubber emits (`[redacted-jwt]`,
// `[redacted-secret-id]`, and future `[redacted-*]`), and the defensive `<redacted…>` angle form.
const REDACTION_MARKER_RE = /\[redacted[^\]]*\]|<redacted[^>]*>/i

class TemplateDeriveError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TemplateDeriveError'
    this.details = details
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

// Walk every string in the value; return the first path whose string satisfies `predicate`.
function findOffendingString(value, predicate, basePath = '') {
  if (typeof value === 'string') return predicate(value) ? (basePath || '(root)') : null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findOffendingString(value[i], predicate, `${basePath}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const hit = findOffendingString(value[key], predicate, basePath ? `${basePath}.${key}` : key)
      if (hit) return hit
    }
    return null
  }
  return null
}

function containsRedactionMarker(str) {
  return REDACTION_MARKER_RE.test(str)
}

// A string is "secret-shaped" iff the shared scrubber would change it (DSN/URL userinfo,
// password=/token=, Bearer, …). We REJECT such a sample rather than scrub it into a template.
function isSecretShaped(str) {
  return scrubSecretStringValue(str) !== str
}

// Fail-closed gate: a RAW sample must be clean before it can seed an executable template.
function assertSampleExecutable(sample) {
  if (!isPlainObject(sample)) {
    throw new TemplateDeriveError('sample must be a plain object')
  }
  const redacted = findOffendingString(sample, containsRedactionMarker)
  if (redacted) {
    throw new TemplateDeriveError(
      `sample contains a redaction marker at ${redacted}; a redacted object must never seed an executable template (use the raw operator-local sample)`,
      { field: redacted, reason: 'redaction_marker' },
    )
  }
  const placeholders = findUnfilledPlaceholders(sample)
  if (placeholders.length > 0) {
    throw new TemplateDeriveError(
      `sample has an unfilled <…> placeholder at ${placeholders[0]}; resolve it before deriving a template`,
      { field: placeholders[0], reason: 'unfilled_placeholder' },
    )
  }
  const secret = findOffendingString(sample, isSecretShaped)
  if (secret) {
    throw new TemplateDeriveError(
      `sample has a secret-shaped value at ${secret}; secrets come from the connector profile's secretsRef, never the template`,
      { field: secret, reason: 'secret_shaped' },
    )
  }
}

// Classify one top-level field by its value SHAPE → a draft DF-T1 rule. The operator refines
// later (T2b); references default to preserve (a single staging lookup can't synthesize a
// 2-field reference object — #1824).
function deriveFieldRule(field, value) {
  if (isPlainObject(value)) {
    if (!isBlankValue(value.FNumber) && !isBlankValue(value.FName)) {
      return { targetField: field, sourceType: SOURCE_PRESERVE_TEMPLATE, shape: SHAPE_OBJECT_PASSTHROUGH, completeness: COMPLETENESS_FNUMBER_FNAME }
    }
    if (!isBlankValue(value.FID) && !isBlankValue(value.FName)) {
      return { targetField: field, sourceType: SOURCE_PRESERVE_TEMPLATE, shape: SHAPE_OBJECT_PASSTHROUGH, completeness: COMPLETENESS_FID_FNAME }
    }
    return { targetField: field, sourceType: SOURCE_PRESERVE_TEMPLATE, shape: SHAPE_OBJECT_PASSTHROUGH, completeness: COMPLETENESS_NONE }
  }
  if (Array.isArray(value)) {
    return { targetField: field, sourceType: SOURCE_PRESERVE_TEMPLATE, shape: SHAPE_OBJECT_PASSTHROUGH, completeness: COMPLETENESS_NONE }
  }
  // Scalar — operator maps it to a cleansed staging column (draft suggests the same name).
  return { targetField: field, sourceType: SOURCE_FROM_STAGING, sourceField: field, shape: SHAPE_SCALAR, required: false }
}

// Derive a DRAFT { payloadTemplate, fieldRules } from a RAW operator-local sample.
// opts.gatedFields: fields the operator may NOT author in v1 (excluded from fieldRules).
function deriveTemplateDraft(rawSample, opts = {}) {
  assertSampleExecutable(rawSample)
  const gatedFields = Array.isArray(opts.gatedFields) ? opts.gatedFields.map(String) : []
  const gatedSet = new Set(gatedFields)
  const payloadTemplate = cloneJson(rawSample)
  const fieldRules = []
  for (const field of Object.keys(rawSample)) {
    if (gatedSet.has(field)) continue // locked — not authorable in v1
    fieldRules.push(deriveFieldRule(field, rawSample[field]))
  }
  return {
    payloadTemplate,
    fieldRules,
    gatedFields: gatedFields.filter((field) => Object.prototype.hasOwnProperty.call(rawSample, field)),
  }
}

// Values-free summary for docs / PR / run evidence: field names + shape presence ONLY, never
// the operator-local reference VALUES (customer business data stays off Git).
function summarizeTemplateForEvidence(draft) {
  if (!isPlainObject(draft) || !Array.isArray(draft.fieldRules)) {
    throw new TemplateDeriveError('summarizeTemplateForEvidence: a derive draft is required')
  }
  const template = isPlainObject(draft.payloadTemplate) ? draft.payloadTemplate : {}
  return {
    fields: draft.fieldRules.map((rule) => ({
      field: rule.targetField,
      sourceType: rule.sourceType,
      shape: rule.shape,
      ...(rule.completeness ? { completeness: rule.completeness } : {}),
      isReference: isPlainObject(template[rule.targetField]),
      hasValue: !isBlankValue(template[rule.targetField]),
    })),
    gatedFields: Array.isArray(draft.gatedFields) ? [...draft.gatedFields] : [],
  }
}

// K3 WISE Material convenience: the M1-proven gated set — FBaseUnitID is intentionally NOT
// authorable (default-projecting it broke the M1 dry-run/Save; the contract omits it).
const K3_MATERIAL_GATED_FIELDS = Object.freeze(['FBaseUnitID'])

// The K3 Save body / GetDetail response wraps the material under `Data` (the bodyKey). This
// helper expects the INNER material object — fail closed on an outer { Data: {…} } / { Data: [{…}] }
// body so the operator extracts the inner object first (never silently derive `Data` as one field).
function assertNotK3Envelope(sample) {
  if (isPlainObject(sample) && (isPlainObject(sample.Data) || Array.isArray(sample.Data))) {
    throw new TemplateDeriveError(
      'sample looks like an outer K3 body/response ({ Data: … }); pass the inner material object (the Data payload), not the envelope',
      { field: 'Data', reason: 'k3_outer_envelope' },
    )
  }
}

function deriveK3MaterialTemplateDraft(rawSample) {
  assertNotK3Envelope(rawSample)
  return deriveTemplateDraft(rawSample, { gatedFields: K3_MATERIAL_GATED_FIELDS })
}

module.exports = {
  TemplateDeriveError,
  deriveTemplateDraft,
  summarizeTemplateForEvidence,
  deriveK3MaterialTemplateDraft,
  K3_MATERIAL_GATED_FIELDS,
  __internals: {
    assertSampleExecutable,
    assertNotK3Envelope,
    deriveFieldRule,
    isSecretShaped,
    containsRedactionMarker,
    findOffendingString,
  },
}
