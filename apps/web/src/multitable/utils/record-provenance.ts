// Row-provenance (数据来源) helpers for the multitable record inspector — the FIRST multitable
// consumer of the Data Factory DF-N2-2c by-rowId provenance read.
//
// Wire contract (read-only, unchanged by this module):
//   GET /api/integration/provenance?rowId=…
//     route table  plugins/plugin-integration-core/lib/http-routes.cjs:142
//     handler      plugins/plugin-integration-core/lib/http-routes.cjs:5263 (provenanceByRow)
//     gate         requireAccess(req, 'read') → integration:read | integration:write | admin
//     registry     plugins/plugin-integration-core/lib/pipelines.cjs:727 (listProvenanceByRow)
//   The frontend client already exists (services/integration/workbench.ts
//   listIntegrationProvenanceByRow, added for the DF-N2-3 operator surface); this module adds only
//   the multitable-side row binding + the values-free render whitelist. No new route, no new gate.
//
// WHAT IDENTIFIES A ROW: the provenance view groups on the pipeline's per-row idempotency key
// (`_integration_idempotency_key`, an opaque `idem_<sha256>` — see plugins/plugin-integration-core/
// lib/idempotency.cjs). The multitable target adapter writes that key onto the landed row only when
// the target object is configured with `includeInternalFields: true`
// (lib/adapters/metasheet-multitable-target-adapter.cjs:152). So a sheet that carries the column is
// integration-fed and addressable; a sheet without it is not, and the UI renders nothing at all.
//
// NOT derivable from a landed row: the pipelineId. The adapter stamps only the idempotency key, so
// the timeline is requested by rowId alone. The key already hashes sourceSystem + objectType +
// sourceId + revision + targetSystem, so two pipelines can only collide when all of those match.
import type { MetaField, MetaFieldPermission, MetaRecord } from '../types'

/** The internal column the integration target adapter stamps the per-row idempotency key into. */
export const PROVENANCE_ROW_KEY_FIELD_NAME = '_integration_idempotency_key'

/**
 * The ONLY `attrs` keys this surface renders. `attrs` is a free-form (already write-time redacted)
 * object; a business-facing panel must not spread an arbitrary blob into the DOM, so we render a
 * fixed, values-free vocabulary instead:
 *   - `decision`     add | update | skip | held        (external-write runtime)
 *   - `errorCode`    machine-readable failure code     (both runtimes)
 * Deliberately NOT rendered: `errorMessage` (free text that can embed an ERP response body),
 * `targetKind`/`dryRunRevision` (internal plumbing) and anything a future emitter adds.
 */
export const PROVENANCE_VISIBLE_ATTR_KEYS = ['decision', 'errorCode'] as const

export type ProvenanceVisibleAttrKey = (typeof PROVENANCE_VISIBLE_ATTR_KEYS)[number]

export interface ProvenanceAttrChip {
  key: ProvenanceVisibleAttrKey
  value: string
}

const ATTR_VALUE_MAX_LENGTH = 64

/**
 * The provenance key column as this actor sees it: layer-3 (RBAC field mask) is honoured, so a
 * masked key column makes the row unaddressable rather than silently readable through a query
 * parameter. Layer-2 (property-hidden) is intentionally NOT applied — the column is an internal one
 * that sheets normally hide from the grid, and its value is never rendered, only used as the lookup
 * key.
 */
export function findProvenanceRowKeyField(
  fields: MetaField[] | null | undefined,
  fieldPermissions?: Record<string, MetaFieldPermission> | null,
): MetaField | null {
  if (!Array.isArray(fields)) return null
  const field = fields.find((item) => item?.name === PROVENANCE_ROW_KEY_FIELD_NAME) ?? null
  if (!field) return null
  return fieldPermissions?.[field.id]?.visible === false ? null : field
}

/** True when this sheet is integration-fed (it carries a readable provenance key column). */
export function hasProvenanceRowKeyField(
  fields: MetaField[] | null | undefined,
  fieldPermissions?: Record<string, MetaFieldPermission> | null,
): boolean {
  return findProvenanceRowKeyField(fields, fieldPermissions) !== null
}

/**
 * The `rowId` to query the DF-N2-2c route with, or null when this record has none — a row created
 * by hand on an integration-fed sheet legitimately has no key, and gets the empty state without a
 * request.
 */
export function resolveProvenanceRowId(
  record: MetaRecord | null | undefined,
  fields: MetaField[] | null | undefined,
  fieldPermissions?: Record<string, MetaFieldPermission> | null,
): string | null {
  const field = findProvenanceRowKeyField(fields, fieldPermissions)
  if (!field || !record?.data) return null
  // `data` is keyed by field id; the name-keyed read is a defensive fallback for callers that hand
  // over a name-keyed payload.
  const raw = record.data[field.id] ?? record.data[PROVENANCE_ROW_KEY_FIELD_NAME]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Whitelisted, primitive-only, length-clamped `attrs` projection — see PROVENANCE_VISIBLE_ATTR_KEYS. */
export function pickVisibleProvenanceAttrs(attrs: Record<string, unknown> | null | undefined): ProvenanceAttrChip[] {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return []
  const chips: ProvenanceAttrChip[] = []
  for (const key of PROVENANCE_VISIBLE_ATTR_KEYS) {
    const value = attrs[key]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    const text = String(value).trim()
    if (!text) continue
    chips.push({ key, value: text.length > ATTR_VALUE_MAX_LENGTH ? `${text.slice(0, ATTR_VALUE_MAX_LENGTH)}…` : text })
  }
  return chips
}

/** Short, human-scannable run identifier — never the full opaque id. */
export function shortRunId(runId: string | null | undefined): string {
  const trimmed = typeof runId === 'string' ? runId.trim() : ''
  if (!trimmed) return ''
  return trimmed.length > 12 ? `${trimmed.slice(0, 12)}…` : trimmed
}

/**
 * True when a provenance read failed because this actor is not allowed to read it. The shared
 * envelope parser (parseIntegrationResponse) collapses the response into `Error(message)`, so the
 * classification matches the route's own 401/403 messages plus the `"<status> <statusText>"`
 * fallback the parser builds when the body is not JSON.
 */
export function isProvenanceAccessDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /insufficient integration permissions|authentication required|\bforbidden\b|\bunauthorized\b|\b40[13]\b/i.test(message)
}
