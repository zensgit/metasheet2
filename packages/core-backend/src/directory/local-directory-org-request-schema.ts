/**
 * Canonical Org MVP — B2 (local departments/accounts/memberships CRUD), #4304-plan §5.2-5.4.
 *
 * Fail-closed field allowlists for every B2 write endpoint (owner hard requirement — the second
 * half of the `corp_id` guarantee B1 left open, see `getOrCreateLocalIntegration`'s doc comment
 * in `directory-sync.ts`): a B2 request body may ONLY contain keys this module explicitly
 * allows for that operation. `org_id` / `orgId` / `corp_id` / `corpId` are never in any
 * allowlist below, so a request that smuggles them is rejected the same way any other unknown
 * field is — not by a special-cased denylist that could miss a spelling variant, but because
 * the allowlist is closed by construction. Org identity is resolved server-side from the
 * request's authenticated context (`resolveLocalDirectoryOrgId` in `admin-directory-local.ts`),
 * which never reads the request body at all — the allowlist is defense in depth on top of that,
 * not the only thing standing between a client and the org anchor.
 *
 * Pure and dependency-free by design: no DB, no Express types. Testable in the fast unit lane;
 * the route layer is the only caller.
 */

export interface FieldAllowlistResult {
  ok: boolean
  /** Present only when `ok` is false — the caller decides whether/how to log this (values-free: it's a set of JSON key NAMES, never a value). */
  rejectedFields: string[]
}

const EMPTY_RESULT: FieldAllowlistResult = { ok: true, rejectedFields: [] }

/**
 * Fail-closed: any key in `body` that is not in `allowedFields` fails the check. A non-object
 * body (null, array, primitive, undefined) has no keys to reject, so it passes here — callers
 * still separately validate that required fields are present and well-typed.
 */
export function checkFieldAllowlist(body: unknown, allowedFields: readonly string[]): FieldAllowlistResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return EMPTY_RESULT
  }
  const allowed = new Set(allowedFields)
  const rejected = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.has(key))
  if (rejected.length === 0) return EMPTY_RESULT
  return { ok: false, rejectedFields: rejected }
}

/** POST /api/admin/directory/local/departments */
export const CREATE_LOCAL_DEPARTMENT_FIELDS = ['name', 'parentDepartmentId', 'orderIndex'] as const

/** PATCH /api/admin/directory/local/departments/:departmentId */
export const UPDATE_LOCAL_DEPARTMENT_FIELDS = ['name', 'parentDepartmentId', 'orderIndex'] as const

/** POST /api/admin/directory/local/accounts */
export const CREATE_LOCAL_ACCOUNT_FIELDS = ['localUserId', 'name', 'email', 'mobile', 'title'] as const

/** PATCH /api/admin/directory/local/accounts/:accountId */
export const UPDATE_LOCAL_ACCOUNT_FIELDS = ['name', 'email', 'mobile', 'title'] as const

/** POST /api/admin/directory/local/memberships */
export const ADD_LOCAL_MEMBERSHIP_FIELDS = ['accountId', 'departmentId'] as const

/**
 * PATCH /api/admin/directory/local/memberships/:membershipId — a narrow membership update that
 * performs EXACTLY ONE of two mutually-exclusive operations per request (the route enforces the
 * XOR): the explicit primary-department switch (`isPrimary: true`) OR the normalized manager-flag
 * set/unset (`isManager: true|false`, B3 #4215 §5.4). Both keys in one body — or an empty body —
 * is a 400 before any write, so a combined request can never partially apply.
 */
export const UPDATE_LOCAL_MEMBERSHIP_FIELDS = ['isPrimary', 'isManager'] as const

/**
 * Owner P2 (review on #4317): the allowlists above only ever checked field NAMES. A
 * present field with the WRONG TYPE (e.g. `parentDepartmentId: 123`, `email: {}`, `title: []`)
 * fell through the route layer's `typeof x === 'string' ? x : null`-shaped extraction and was
 * silently coerced to `null` — which, for these fields, is the DESTRUCTIVE "clear this value"
 * signal. A malformed request body could therefore CLEAR a department's parent or an account's
 * email/mobile/title instead of being rejected.
 *
 * `checkFieldTypes` closes that gap: every field an endpoint accepts also gets a declared type
 * kind, checked BEFORE the route layer ever extracts/coerces a value. A key that is ABSENT from
 * the body is never checked here — `undefined` continues to mean "leave this field alone"
 * everywhere in B2. A key that IS present must match its kind exactly, or the whole request is
 * rejected (400) before anything is read into the update input, let alone written.
 *
 * Nullable-by-design (kind `'stringOrNull'`, explicit `null` is a legitimate value, not a type
 * error) vs non-nullable (kind `'string'`/`'integer'`, explicit `null` IS a type error) is decided
 * per field from `local-directory-org.ts`'s own input types, not invented here:
 *   - `parentDepartmentId` (department create/update): `string | null` in both
 *     `CreateLocalDepartmentInput` and `UpdateLocalDepartmentInput` — `null` means "no parent /
 *     make root", an explicit, designed operation.
 *   - `email` / `mobile` / `title` (account create/update): `string | null` in both
 *     `CreateLocalAccountInput` and `UpdateLocalAccountInput` — `null` means "no value", likewise
 *     designed.
 *   - `name` (department, account), `orderIndex` (department), `localUserId` (account),
 *     `accountId` / `departmentId` (membership) are all plain `string`/`number` in those same
 *     interfaces — none of them has a "clear to null" operation, so `null` is a type error for
 *     every one of them, exactly like any other wrong type.
 *
 * `'integer'` (only `orderIndex`) requires `Number.isInteger` — this tightens the previous
 * behavior, which silently `Math.trunc`ed any finite number the client sent (so a float or a
 * numeric string masqueraded as accepted input instead of being rejected).
 */
export type LocalDirectoryFieldKind = 'string' | 'stringOrNull' | 'integer' | 'boolean'

export interface LocalDirectoryFieldSpec {
  field: string
  kind: LocalDirectoryFieldKind
}

export interface FieldTypeCheckResult {
  ok: boolean
  /** Present only when `ok` is false — the field NAME that failed (never its value — values-free). */
  field?: string
  /** Present only when `ok` is false — a static, field-name-only message (never echoes the received value). */
  message?: string
}

function describeFieldKind(kind: LocalDirectoryFieldKind): string {
  switch (kind) {
    case 'string':
      return 'a string'
    case 'stringOrNull':
      return 'a string or null'
    case 'integer':
      // int4-bounded (see matchesFieldKind) — say so, or a 3e9 rejection reads as a lie
      // ("3000000000 IS an integer"). Message precision is a review contract in this repo.
      return 'an integer within the int4 range'
    case 'boolean':
      return 'a boolean'
  }
}

function matchesFieldKind(value: unknown, kind: LocalDirectoryFieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string'
    case 'stringOrNull':
      return value === null || typeof value === 'string'
    case 'integer':
      // int4 bounds included: an integer beyond the column's range would pass a bare
      // Number.isInteger gate and then blow up as a 500 at INSERT time — same
      // "type gate exists but the write still fails loudly" seam, closed here as a 400.
      return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
    case 'boolean':
      return typeof value === 'boolean'
  }
}

/**
 * Strict per-field type validation, run AFTER `checkFieldAllowlist` has already confirmed every
 * key in `body` is one this endpoint accepts. Checks only the keys `body` actually contains
 * (`undefined`/absent fields are never touched — see module doc comment); stops at the first
 * mismatch and reports that field's name (never its value).
 */
export function checkFieldTypes(body: unknown, specs: readonly LocalDirectoryFieldSpec[]): FieldTypeCheckResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: true }
  }
  const record = body as Record<string, unknown>
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(record, spec.field)) continue
    if (!matchesFieldKind(record[spec.field], spec.kind)) {
      return { ok: false, field: spec.field, message: `${spec.field} must be ${describeFieldKind(spec.kind)}` }
    }
  }
  return { ok: true }
}

/** POST /api/admin/directory/local/departments — types for `CREATE_LOCAL_DEPARTMENT_FIELDS`. */
export const CREATE_LOCAL_DEPARTMENT_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'name', kind: 'string' },
  { field: 'parentDepartmentId', kind: 'stringOrNull' },
  { field: 'orderIndex', kind: 'integer' },
]

/** PATCH /api/admin/directory/local/departments/:departmentId — types for `UPDATE_LOCAL_DEPARTMENT_FIELDS`. */
export const UPDATE_LOCAL_DEPARTMENT_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'name', kind: 'string' },
  { field: 'parentDepartmentId', kind: 'stringOrNull' },
  { field: 'orderIndex', kind: 'integer' },
]

/** POST /api/admin/directory/local/accounts — types for `CREATE_LOCAL_ACCOUNT_FIELDS`. */
export const CREATE_LOCAL_ACCOUNT_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'localUserId', kind: 'string' },
  { field: 'name', kind: 'string' },
  { field: 'email', kind: 'stringOrNull' },
  { field: 'mobile', kind: 'stringOrNull' },
  { field: 'title', kind: 'stringOrNull' },
]

/** PATCH /api/admin/directory/local/accounts/:accountId — types for `UPDATE_LOCAL_ACCOUNT_FIELDS`. */
export const UPDATE_LOCAL_ACCOUNT_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'name', kind: 'string' },
  { field: 'email', kind: 'stringOrNull' },
  { field: 'mobile', kind: 'stringOrNull' },
  { field: 'title', kind: 'stringOrNull' },
]

/** POST /api/admin/directory/local/memberships — types for `ADD_LOCAL_MEMBERSHIP_FIELDS`. */
export const ADD_LOCAL_MEMBERSHIP_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'accountId', kind: 'string' },
  { field: 'departmentId', kind: 'string' },
]

/**
 * PATCH /api/admin/directory/local/memberships/:membershipId — types for `UPDATE_LOCAL_MEMBERSHIP_FIELDS`.
 * Both fields are booleans. `isManager` (B3 #4215 §5.4) legitimately accepts BOTH `true` (set the
 * normalized manager flag) and `false` (unset it), so this type gate is what rejects (400) an
 * `isManager` sent as a string/number BEFORE the route ever reads it — the same coercion class the
 * account/department endpoints close. `isPrimary` keeps its stricter route-layer contract too
 * (`body.isPrimary !== true` in admin-directory-local.ts rejects anything but the literal `true`);
 * it still gets a boolean spec HERE so the allowlist ↔ type-spec drift guard holds by set-equality —
 * a field present in an allowlist with NO type spec is exactly the drift this pairing forbids.
 */
export const UPDATE_LOCAL_MEMBERSHIP_FIELD_TYPES: readonly LocalDirectoryFieldSpec[] = [
  { field: 'isPrimary', kind: 'boolean' },
  { field: 'isManager', kind: 'boolean' },
]
