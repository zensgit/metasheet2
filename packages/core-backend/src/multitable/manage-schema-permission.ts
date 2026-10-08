/**
 * `multitable:manage-schema` — SCHEMA MANAGEMENT, separated from RECORD WRITING.
 *
 * ── The defect this module closes ──────────────────────────────────────────────
 * Until this change `canManageFields` was derived as `canWrite` (multitable/access.ts and its
 * byte-identical clone in multitable/sheet-capabilities.ts), and `canWrite` is
 * `isAdminRole || hasPermission(permissions, 'multitable:write')`. So EVERY actor who could edit a
 * record VALUE also held structural authority over the TABLE: rename a field, retype a field, delete
 * a field, and drive the field-scoped config-restore paths. Found on a live customer-facing
 * deployment: a stock-preparation shop-floor operator — who must be able to fill the human columns
 * (quantities, dates, notes) and therefore holds `multitable:write` — could delete the "total
 * quantity" column outright. Filling a cell and destroying the column it lives in are not the same
 * authority.
 *
 * The sibling management capabilities were ALREADY separated: `canManageSheetAccess` has
 * `multitable:share`, `canManageAutomation` has the `workflow:*` family. Schema management is the one
 * that stayed fused to the record-write code. This module gives it its own code.
 *
 * ── Semantics ─────────────────────────────────────────────────────────────────
 * `canManageFields := isAdminRole || hasPermission(permissions, 'multitable:manage-schema')`
 *
 * ZERO automatic holders. The seed migration
 * (`db/migrations/zzzz20260830160000_add_multitable_manage_schema_permission.ts`) inserts the code
 * into `permissions` and inserts NO `role_permissions` row — no role receives it implicitly, exactly
 * as the stock-prep O2/R-11 seed does. A platform admin keeps every capability through `isAdminRole`,
 * the same short-circuit every other capability uses, without holding the code.
 *
 * `hasPermission`'s existing wildcard semantics still apply: `multitable:*` and `*:*` satisfy the new
 * code, because those grants are already superuser-shaped by construction. This module does not widen
 * or narrow that.
 *
 * ── Transition switch (owner-gated, DEFAULT OFF) ───────────────────────────────
 * `MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA=true` ALSO accepts `multitable:write` for
 * `canManageFields`, restoring the pre-change fused behaviour.
 *
 *   THIS FLAG IS A REGRESSION OF THE FIX WHILE IT IS ON. It exists for exactly one reason: an already-
 *   running deployment can flip it on, grant `multitable:manage-schema` to the humans who genuinely
 *   administer table structure, and only then flip it back off — instead of taking the capability away
 *   from everyone in a single deploy. It is a staging aid, NOT a supported configuration. The tightened
 *   default (flag unset / anything other than the literal string `true`) is the intended end state, and
 *   every deployment is expected to reach it.
 *
 * The flag widens NOTHING else. It is consulted only by {@link deriveCanManageFields}; no other
 * capability, route, or permission code reads it. When it is off the derivation cannot see
 * `multitable:write` at all.
 *
 * Read at call time (not module load) so a process can be exercised in both postures — the repo's
 * `String(env.X ?? '').trim().toLowerCase() === 'true'` flag idiom (cf. canonical-sheet-fence.ts,
 * history-integrity-precheck.ts).
 */

/** The permission code that grants multitable schema management. */
export const MULTITABLE_MANAGE_SCHEMA_PERMISSION = 'multitable:manage-schema'

/** The record-write code that USED to imply schema management, and no longer does. */
export const MULTITABLE_WRITE_PERMISSION = 'multitable:write'

/** Env var name of the owner-gated, default-OFF transition switch. */
export const MULTITABLE_LEGACY_MANAGE_SCHEMA_FLAG_ENV =
  'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA'

/**
 * True iff the deployment has EXPLICITLY opted back into the legacy fused behaviour
 * (`multitable:write` implies schema management). Unset / any value other than the literal `true`
 * (case-insensitive, trimmed) → false → the tightened behaviour.
 */
export function isLegacyWriteImpliesManageSchemaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    String(env[MULTITABLE_LEGACY_MANAGE_SCHEMA_FLAG_ENV] ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

/**
 * The single policy implementation behind `canManageFields`, shared by the REST derivation
 * (multitable/access.ts) and the Yjs-bridge/OAPI derivation (multitable/sheet-capabilities.ts) so the
 * two clones cannot drift apart.
 *
 * `hasPermissionFn` is injected because the two callers each carry their own (identical) wildcard-aware
 * `hasPermission`; passing it keeps this module free of a cross-import between them.
 */
export function deriveCanManageFields(
  permissions: string[],
  isAdminRole: boolean,
  hasPermissionFn: (permissions: string[], code: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isAdminRole) return true
  if (hasPermissionFn(permissions, MULTITABLE_MANAGE_SCHEMA_PERMISSION)) return true
  // Transition switch ONLY. Off by default; see the header — a REGRESSION of the fix while on.
  if (
    isLegacyWriteImpliesManageSchemaEnabled(env) &&
    hasPermissionFn(permissions, MULTITABLE_WRITE_PERMISSION)
  ) {
    return true
  }
  return false
}
