/**
 * Privilege classification for security actions.
 *
 * A user is HIGH privilege when any persisted grant source confers platform administration,
 * delegated role administration, or an admin-level or sensitive authority code. Every source is
 * read by one statement on the caller's read-committed transaction, so the classification and the
 * witness describe a single snapshot. Token claims, request-user fields and the permission cache are
 * never consulted. When a source cannot be read, or the row does not have the expected shape, the
 * read raises PrivilegeInputsUnavailableError; it never falls back to STANDARD.
 *
 * Each predicate is at least as wide as the authorization reader it mirrors: case and surrounding
 * whitespace are ignored, and codes are taken before namespace admission. A wider predicate can only
 * refuse more.
 *
 * Grant sources in this revision: the users admin flag and role column, role membership, direct and
 * role-derived permission codes, the legacy permission column, namespace admissions (witness only)
 * and the two delegated role administration scope tables. Domain-specific scope tables are not grant
 * sources of this classifier.
 *
 * The witness is a domain-separated SHA-256 over a canonical encoding of every grant input; any change
 * to any input changes it.
 *
 * Classification does not cover account state (active flag, activation status, deletion or purge
 * markers). Callers apply the account gate separately.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { deriveDelegatedAdminNamespace } from '../rbac/namespace-admission'
import { isAdminLevelPermissionCode } from '../rbac/role-assignment'
import type { PrivilegeClass } from './external-login-assurance'

export type { PrivilegeClass }

export type PrivilegeInputsUnavailableReason =
  | 'input_malformed'
  | 'transaction_required'
  | 'read_failed'
  | 'subject_missing'

/**
 * Raised whenever the inputs of a classification cannot be established. The message is fixed and no
 * cause is attached, so no SQL text, identifier or driver detail is projected. After a `read_failed`
 * the caller's transaction is no longer usable and must be rolled back.
 */
export class PrivilegeInputsUnavailableError extends Error {
  readonly status = 503
  readonly code = 'SECURITY_ACTION_UNAVAILABLE'
  constructor(readonly reason: PrivilegeInputsUnavailableReason) {
    super('Privilege inputs are unavailable')
    this.name = 'PrivilegeInputsUnavailableError'
  }
}

declare const privilegeInputsBrand: unique symbol

/**
 * The grant inputs of one user as read by `readPrivilegeInputs`. The brand is type-level only: it
 * keeps inputs assembled elsewhere out of the classifier's signature, while a cast to this type is a
 * review concern rather than a runtime check.
 */
export type PrivilegeInputs = Readonly<{
  userId: string
  isAdmin: boolean
  role: string
  /** Code-unit ascending. */
  roleIds: readonly string[]
  /** Code-unit ascending. */
  directCodes: readonly string[]
  /** `[roleId, permissionCode]` pairs, ascending by canonical encoding. */
  rolePermissions: readonly (readonly [string, string])[]
  /** The stored legacy column value, as stored. */
  legacyPermissions: unknown
  /** `[namespace, enabled]` pairs, ascending by canonical encoding. */
  admissions: readonly (readonly [string, boolean])[]
  /** `[namespace, departmentId]` pairs, ascending by canonical encoding. */
  delegatedDepartmentScopes: readonly (readonly [string, string])[]
  /** `[namespace, groupId]` pairs, ascending by canonical encoding. */
  delegatedMemberGroupScopes: readonly (readonly [string, string])[]
  readonly [privilegeInputsBrand]: true
}>

export const HIGH_PRIVILEGE_REASONS = [
  'platform_admin_flag',
  'platform_admin_role_column',
  'platform_admin_role',
  'delegated_admin_role',
  'delegated_admin_scope',
  'admin_level_code',
  'sensitive_authority_code',
] as const
export type HighPrivilegeReason = (typeof HIGH_PRIVILEGE_REASONS)[number]

export type PrivilegeClassification = Readonly<{
  privilegeClass: PrivilegeClass
  reasons: readonly HighPrivilegeReason[]
}>

export type SecurityActionPrivilegeAssessment = Readonly<{
  privilegeClass: PrivilegeClass
  reasons: readonly HighPrivilegeReason[]
  witness: string
}>

/** Every table the data statement reads. */
export const PRIVILEGE_GRANT_SOURCE_TABLES = [
  'users',
  'user_roles',
  'user_permissions',
  'role_permissions',
  'user_namespace_admissions',
  'delegated_role_admin_scopes',
  'delegated_role_admin_member_groups',
] as const

export const PRIVILEGE_WITNESS_DOMAIN = 'metasheet:security-action:privilege:v1|'

const PRIVILEGE_INPUTS_STATEMENT = `SELECT u.id::text AS id,
       u.is_admin,
       u.role,
       to_jsonb(u.permissions) AS legacy_permissions,
       COALESCE((SELECT jsonb_agg(ur.role_id)
                   FROM user_roles ur WHERE ur.user_id = $1::text), '[]'::jsonb) AS role_ids,
       COALESCE((SELECT jsonb_agg(up.permission_code)
                   FROM user_permissions up WHERE up.user_id = $1::text), '[]'::jsonb) AS direct_codes,
       COALESCE((SELECT jsonb_agg(jsonb_build_array(rp.role_id, rp.permission_code))
                   FROM user_roles ur
                   JOIN role_permissions rp ON rp.role_id = ur.role_id
                  WHERE ur.user_id = $1::text), '[]'::jsonb) AS role_permission_pairs,
       COALESCE((SELECT jsonb_agg(jsonb_build_array(una.namespace, una.enabled))
                   FROM user_namespace_admissions una WHERE una.user_id = $1::text), '[]'::jsonb) AS admissions,
       COALESCE((SELECT jsonb_agg(jsonb_build_array(s.namespace, s.directory_department_id::text))
                   FROM delegated_role_admin_scopes s WHERE s.admin_user_id = $1::text), '[]'::jsonb) AS department_scopes,
       COALESCE((SELECT jsonb_agg(jsonb_build_array(g.namespace, g.group_id::text))
                   FROM delegated_role_admin_member_groups g WHERE g.admin_user_id = $1::text), '[]'::jsonb) AS member_group_scopes
  FROM users u
 WHERE u.id = $1::text`

const MAX_CANONICAL_DEPTH = 64

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value.trim() === value
    // eslint-disable-next-line no-control-regex -- Subject identifiers must explicitly reject embedded ASCII controls.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Plain string comparison: UTF-16 code units, independent of locale and collation. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deterministic JSON: object keys sorted by code unit, arrays in the given order, strings and finite
 * numbers via JSON.stringify. Anything JSON cannot represent exactly (undefined, bigint, non-finite
 * numbers, functions, symbols, class instances) and nesting beyond a fixed depth throws.
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new RangeError('Canonical encoding exceeds the depth limit')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical encoding requires finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareCodeUnits)
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`
  }
  throw new TypeError('Canonical encoding does not accept this value')
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(compareCodeUnits))
}

function sortedTuples<T extends readonly unknown[]>(values: readonly T[]): readonly T[] {
  return Object.freeze(values
    .map((tuple) => ({ tuple: Object.freeze(tuple), key: canonicalJson(tuple) }))
    .sort((a, b) => compareCodeUnits(a.key, b.key))
    .map((entry) => entry.tuple))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPairArray<A, B>(value: unknown, first: (v: unknown) => v is A, second: (v: unknown) => v is B): value is Array<[A, B]> {
  return Array.isArray(value) && value.every((item) => Array.isArray(item) && item.length === 2 && first(item[0]) && second(item[1]))
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

function parsePrivilegeRow(row: Record<string, unknown>, userId: string): PrivilegeInputs {
  if (row.id !== userId) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isBoolean(row.is_admin) || !isString(row.role)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isStringArray(row.role_ids) || !isStringArray(row.direct_codes)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isPairArray(row.role_permission_pairs, isString, isString)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isPairArray(row.admissions, isString, isBoolean)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isPairArray(row.department_scopes, isString, isString)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (!isPairArray(row.member_group_scopes, isString, isString)) throw new PrivilegeInputsUnavailableError('input_malformed')
  try {
    canonicalJson(row.legacy_permissions)
  } catch {
    throw new PrivilegeInputsUnavailableError('input_malformed')
  }
  const inputs = {
    userId,
    isAdmin: row.is_admin,
    role: row.role,
    roleIds: sortedStrings(row.role_ids),
    directCodes: sortedStrings(row.direct_codes),
    rolePermissions: sortedTuples(row.role_permission_pairs),
    legacyPermissions: row.legacy_permissions,
    admissions: sortedTuples(row.admissions),
    delegatedDepartmentScopes: sortedTuples(row.department_scopes),
    delegatedMemberGroupScopes: sortedTuples(row.member_group_scopes),
  }
  return Object.freeze(inputs) as unknown as PrivilegeInputs
}

/**
 * Reads every grant source of `userId` with one statement on `executor`, which must be a handle on
 * an ongoing READ COMMITTED transaction. Issues exactly four statements: the isolation probe, two
 * transaction probes and the data statement. Throws `PrivilegeInputsUnavailableError` with:
 * - `input_malformed` before any statement when `userId` is not a canonical identifier, and after
 *   the read when the row does not have the expected shape or more than one row came back;
 * - `transaction_required` when the handle is unusable, the isolation level is not read committed,
 *   the two transaction probes disagree, or a probe fails (an already-aborted transaction fails here);
 * - `read_failed` when the data statement fails for any reason; the caller's transaction is then
 *   aborted and must be rolled back;
 * - `subject_missing` when no row exists for `userId`.
 */
export async function readPrivilegeInputs(executor: Queryable, userId: string): Promise<PrivilegeInputs> {
  if (!isCanonicalId(userId)) throw new PrivilegeInputsUnavailableError('input_malformed')

  try {
    if (!executor || typeof executor.query !== 'function') throw new Error('Missing transaction')
    const isolation = await executor.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
      throw new Error('Wrong isolation')
    }
    await assertInTransaction(executor, 'Security action privilege')
  } catch {
    throw new PrivilegeInputsUnavailableError('transaction_required')
  }

  let rows: Array<Record<string, unknown>>
  try {
    rows = (await executor.query(PRIVILEGE_INPUTS_STATEMENT, [userId])).rows
  } catch {
    // Never project SQL errors, database identifiers or underlying error causes.
    throw new PrivilegeInputsUnavailableError('read_failed')
  }
  if (!Array.isArray(rows)) throw new PrivilegeInputsUnavailableError('input_malformed')
  if (rows.length === 0) throw new PrivilegeInputsUnavailableError('subject_missing')
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new PrivilegeInputsUnavailableError('input_malformed')
  return parsePrivilegeRow(rows[0], userId)
}

/** The same per-element normalization the authorization aggregator applies: `String(v ?? '').trim()`. */
function normalizeCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function collectCodes(inputs: PrivilegeInputs): readonly string[] {
  const legacy = Array.isArray(inputs.legacyPermissions) ? inputs.legacyPermissions : []
  const codes = new Set<string>()
  for (const value of [...inputs.directCodes, ...inputs.rolePermissions.map((pair) => pair[1]), ...legacy]) {
    const code = normalizeCode(value)
    if (code) codes.add(code)
  }
  return sortedStrings([...codes])
}

function asInputMalformed(error: unknown): never {
  if (error instanceof PrivilegeInputsUnavailableError) throw error
  throw new PrivilegeInputsUnavailableError('input_malformed')
}

/**
 * The permission codes of a user before namespace admission: direct codes, the code of every held
 * (role, code) pair and every element of the legacy array, each normalized, emptied, de-duplicated and
 * sorted by code unit. A legacy value that is not an array contributes no code. Any failure while
 * normalizing an element raises `PrivilegeInputsUnavailableError('input_malformed')`.
 */
export function collectPrivilegeCodes(inputs: PrivilegeInputs): readonly string[] {
  try {
    return collectCodes(inputs)
  } catch (error) {
    return asInputMalformed(error)
  }
}

function foldCode(code: string): string {
  return code.trim().toLowerCase()
}

/** The role editor's elevation shapes on top of `isAdminLevelPermissionCode`. */
function isEditorElevatedShape(code: string): boolean {
  const normalized = foldCode(code)
  if (!normalized) return false
  if (normalized === '*' || normalized === '*:*') return true
  if (normalized.endsWith(':*')) return true
  const resource = normalized.split(':')[0]
  return resource === '*' || resource === 'admin'
}

const SENSITIVE_AUTHORITY_RESOURCES: ReadonlySet<string> = new Set(['users', 'roles', 'permissions'])

function isSensitiveAuthorityCode(code: string): boolean {
  const separator = code.indexOf(':')
  if (separator < 0) return false
  const resource = foldCode(code.slice(0, separator))
  const action = foldCode(code.slice(separator + 1))
  return SENSITIVE_AUTHORITY_RESOURCES.has(resource) && action === 'write'
}

function isPlatformAdminRoleId(roleId: string): boolean {
  return foldCode(roleId) === 'admin'
}

function isDelegatedAdminRoleId(roleId: string): boolean {
  return deriveDelegatedAdminNamespace(roleId) !== null || deriveDelegatedAdminNamespace(foldCode(roleId)) !== null
}

function classify(inputs: PrivilegeInputs): PrivilegeClassification {
  const codes = collectPrivilegeCodes(inputs)
  const hits: Record<HighPrivilegeReason, boolean> = {
    platform_admin_flag: inputs.isAdmin === true,
    platform_admin_role_column: foldCode(inputs.role) === 'admin',
    platform_admin_role: inputs.roleIds.some(isPlatformAdminRoleId),
    delegated_admin_role: inputs.roleIds.some(isDelegatedAdminRoleId),
    delegated_admin_scope: inputs.delegatedDepartmentScopes.length + inputs.delegatedMemberGroupScopes.length > 0,
    admin_level_code: codes.some((code) => isAdminLevelPermissionCode(code) || isEditorElevatedShape(code)),
    sensitive_authority_code: codes.some(isSensitiveAuthorityCode),
  }
  const reasons = Object.freeze(HIGH_PRIVILEGE_REASONS.filter((reason) => hits[reason]))
  return Object.freeze({ privilegeClass: reasons.length > 0 ? 'high' : 'standard', reasons })
}

/**
 * Classifies grant inputs. HIGH with every matching reason in the fixed order of
 * `HIGH_PRIVILEGE_REASONS`, otherwise STANDARD with no reason. Any failure while normalizing the
 * inputs raises `PrivilegeInputsUnavailableError('input_malformed')`.
 */
export function classifyPrivilege(inputs: PrivilegeInputs): PrivilegeClassification {
  try {
    return classify(inputs)
  } catch (error) {
    return asInputMalformed(error)
  }
}

function witnessOf(inputs: PrivilegeInputs): string {
  const encoded = canonicalJson({
    isAdmin: inputs.isAdmin,
    role: inputs.role,
    roleIds: inputs.roleIds,
    directCodes: inputs.directCodes,
    rolePermissions: inputs.rolePermissions,
    legacyPermissions: inputs.legacyPermissions,
    admissions: inputs.admissions,
    delegatedDepartmentScopes: inputs.delegatedDepartmentScopes,
    delegatedMemberGroupScopes: inputs.delegatedMemberGroupScopes,
  })
  return createHash('sha256').update(PRIVILEGE_WITNESS_DOMAIN + encoded, 'utf8').digest('hex')
}

/**
 * Domain-separated SHA-256 (64 lowercase hex characters) over the canonical encoding of every grant
 * input. Any failure to encode raises `PrivilegeInputsUnavailableError('input_malformed')`.
 */
export function computePrivilegeWitness(inputs: PrivilegeInputs): string {
  try {
    return witnessOf(inputs)
  } catch (error) {
    return asInputMalformed(error)
  }
}

/**
 * Reads the grant inputs once on the caller's transaction and returns the class, the reasons and the
 * witness of that single read. Consumers use this entry point, so a class and a witness can never
 * come from two different reads.
 *
 * Any exception raised while normalizing, classifying or hashing the inputs is mapped to
 * `PrivilegeInputsUnavailableError('input_malformed')`. Account state is not part of the
 * classification; callers apply the account gate separately.
 */
export async function assessSecurityActionPrivilege(executor: Queryable, userId: string): Promise<SecurityActionPrivilegeAssessment> {
  const inputs = await readPrivilegeInputs(executor, userId)
  try {
    const { privilegeClass, reasons } = classify(inputs)
    return Object.freeze({ privilegeClass, reasons, witness: witnessOf(inputs) })
  } catch (error) {
    return asInputMalformed(error)
  }
}
