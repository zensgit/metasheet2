/**
 * T9-R3 — config-history READ-side gating (the gate口径, fail-closed).
 *
 * Maps a `meta_config_revisions` row's (entity_type, entity_id) to the config-manage capability
 * that gates READING its history — the SAME capability that gates WRITING that config (symmetric
 * access). Returns `null` = DENY (fail-closed) for an unknown entity_type or an unparseable
 * permission scope. See
 * docs/development/multitable-t9-r3-config-history-read-api-design-lock-20260624.md.
 *
 * This is the ACCESS gate (which ROWS a caller may read). The view-row PAYLOAD redaction (view
 * filter literals are field-read-sensitive) is a SEPARATE concern, applied at the endpoint via
 * `redactViewConfigFilterLiterals` — not here.
 */

export type ConfigManageCapKey = 'canManageFields' | 'canManageViews' | 'canManageSheetAccess'

/**
 * Permission rows store `entity_id = `${scope}:${JSON.stringify(parts)}`` (R2's
 * `permissionConfigEntityId`); scope ∈ {field, sheet, view}. We read the scope as the substring
 * before the FIRST `:` and REQUIRE a real `scope:` boundary — a colonless value (e.g. a bare
 * `'field'`) is malformed and yields `''` → DENY (fail-closed). The scope is a fixed enum and
 * never contains `:`.
 */
function permissionScope(entityId: string): string {
  const idx = entityId.indexOf(':')
  return idx > 0 ? entityId.slice(0, idx) : '' // no colon, or colon at position 0 → malformed → ''
}

/**
 * The config-manage capability required to read this row's history, or `null` to DENY.
 * FAIL-CLOSED: anything not explicitly mapped → `null`.
 */
export function configHistoryRequiredCapability(
  entityType: string,
  entityId: string,
): ConfigManageCapKey | null {
  switch (entityType) {
    case 'field':
      return 'canManageFields'
    case 'view':
      return 'canManageViews'
    case 'sheet_config':
      return 'canManageSheetAccess'
    case 'permission':
      switch (permissionScope(entityId)) {
        case 'sheet':
          return 'canManageSheetAccess'
        case 'view':
          return 'canManageViews'
        case 'field':
          return 'canManageFields'
        default:
          return null // FAIL CLOSED — unknown / unparseable permission scope
      }
    default:
      return null // FAIL CLOSED — unknown entity_type
  }
}
