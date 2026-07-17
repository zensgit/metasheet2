import type { MetaField } from '../types'
import { isSystemField } from './system-fields'

export function isPropertyHiddenField(field: Pick<MetaField, 'property'>): boolean {
  return field.property?.hidden === true || field.property?.visible === false
}

// B4 (multitable-remaining-development-inventory-and-sequencing-20260712.md §5): client-side mirror
// of the server's ALWAYS-read-only predicate — `isFieldAlwaysReadOnly` in
// packages/core-backend/src/multitable/permission-derivation.ts:58-68. That function is the one every
// write path (record-service.ts, records.ts, univer-meta.ts's PATCH handlers, the Yjs bridge write-input
// builder) rejects a mutation against; it also feeds `deriveFieldPermissions`, whose per-field `readOnly`
// flag the grid/drawer/form already thread through by ID (`fieldPermissions[id].readOnly` /
// `fieldReadOnlyIds`) — so this is DEFENSE-IN-DEPTH, not the only gate: it makes the FE independently
// correct even before/without a server round trip (a stale or not-yet-loaded `fieldPermissions` map,
// or a future call site that forgets to thread it), rather than relying solely on ID-list plumbing.
// Must stay byte-for-byte in sync with the server predicate — the parity guard at
// packages/core-backend/tests/unit/field-always-readonly-web-parity.test.ts live-imports BOTH sides and
// fails on drift; a source-scan canary there also fails loud if the server predicate grows a new branch
// this helper doesn't mirror yet.
export function isFieldAlwaysReadOnly(field: Pick<MetaField, 'type' | 'property'> | null | undefined): boolean {
  if (!field) return false
  if (field.type === 'formula' || field.type === 'lookup' || field.type === 'rollup') return true
  if (isSystemField(field)) return true
  const property = field.property as Record<string, unknown> | undefined
  const mirrorOf = property?.mirrorOf
  if (typeof mirrorOf === 'string' && mirrorOf.length > 0) return true
  return property?.readonly === true || property?.readOnly === true
}

export function filterPropertyVisibleFields<T extends Pick<MetaField, 'property'>>(fields: T[]): T[] {
  return fields.filter((field) => !isPropertyHiddenField(field))
}

const NON_BULK_EDITABLE_TYPES = new Set<string>([
  'formula',
  'lookup',
  'rollup',
  'attachment',
  'link',
])

export function isFieldBulkEditable(args: {
  field: MetaField
  canEdit: boolean
  fieldPermission?: { readOnly?: boolean }
}): boolean {
  if (!args.canEdit) return false
  if (args.fieldPermission?.readOnly === true) return false
  if (isSystemField(args.field)) return false
  const property = args.field.property as Record<string, unknown> | undefined
  if (property?.readonly === true || property?.readOnly === true) return false
  if (NON_BULK_EDITABLE_TYPES.has(args.field.type)) return false
  if (isPropertyHiddenField(args.field)) return false
  return true
}
