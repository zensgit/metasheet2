/**
 * W4C-0 (#4556) Stage C — branded in-process authorization context
 * (lock section 4.1 "The authorization context is an in-process branded value,
 * never request JSON" + section 8.1 SQL recheck).
 *
 * The host factory normalizes and deep-copies every value, freezes the outer
 * object and nested arrays/objects, and registers it in a module-private
 * `WeakMap<object, canonicalDigest>`. Every use recomputes and constant-time
 * compares that digest before reading a field. The CJS plugin cannot satisfy the
 * runtime check by object-shape imitation, spread, JSON clone, prototype
 * replacement, or post-mint mutation of the original object.
 *
 * W4C-0 ships NO caller cutover: no route or adapter mints this yet. The
 * entrypoint-specific permission checks that PRECEDE minting (W4C-R30 matrix,
 * token-subject binding, source ownership) belong to the private adapters of
 * later slices; this module owns the witness mechanics, the closed
 * capability<->entrypoint matrix, and the transaction-bound SQL recheck.
 */
import crypto from 'node:crypto'
import type { AttendanceSourceEntrypointV1, AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { parseCanonicalAttendanceOrgKeyV1 } from './w4c0-identity'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { AttendanceW4OperationError } from './w4c0-operation-contract'

declare const W4C0AuthOpaque: unique symbol
type Opaque<T, B extends string> = T & { readonly [W4C0AuthOpaque]: B }

export class AttendanceW4AuthorizationError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4AuthorizationError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4AuthorizationError(code)
}

// ---------------------------------------------------------------------------
// Closed enums (lock section 4.1).
// ---------------------------------------------------------------------------

export const ATTENDANCE_ACTOR_POSTURES_V1 = Object.freeze([
  'self',
  'platform_admin',
  'attendance_admin',
  'delegated_import',
  'scheduler',
  'approval_system',
  'operator',
] as const)
export type AttendanceActorPostureV1 = (typeof ATTENDANCE_ACTOR_POSTURES_V1)[number]

export const ATTENDANCE_WRITE_CAPABILITIES_V1 = Object.freeze([
  'punch',
  'import',
  'scheduled',
  'approval_apply',
  'manual_edit',
  'recompute',
  'rollback',
  'retirement',
] as const)
export type AttendanceWriteCapabilityV1 = (typeof ATTENDANCE_WRITE_CAPABILITIES_V1)[number]

/**
 * Closed command-entrypoint -> capability matrix ("A context whose capability
 * does not match the entrypoint fails before source/result DML", lock 4.1).
 * The lock pins the two closed sets; this exact pairing is the W4C-0 reading
 * recorded in HANDOFF-W4C0.md (呈裁点 — the lock does not spell the pairs out).
 */
export const ATTENDANCE_ENTRYPOINT_CAPABILITY_MATRIX_V1: Readonly<
  Record<AttendanceSourceEntrypointV1, AttendanceWriteCapabilityV1>
> = Object.freeze({
  live_punch: 'punch',
  request_create: 'approval_apply',
  request_pending_edit: 'approval_apply',
  request_decision: 'approval_apply',
  request_cancel: 'approval_apply',
  import_batch: 'import',
  integration_batch: 'import',
  scheduled: 'scheduled',
  manual_edit: 'manual_edit',
  recompute: 'recompute',
  import_rollback: 'rollback',
  ops_retirement: 'retirement',
})

// ---------------------------------------------------------------------------
// Branded context type + factory.
// ---------------------------------------------------------------------------

export type AttendanceWriteSubjectScopeV1 =
  | { readonly kind: 'self'; readonly userId: string }
  | { readonly kind: 'explicit_users'; readonly userIds: readonly string[] }
  | { readonly kind: 'org_scheduler' }

export type AuthorizedAttendanceWriteContextV1 = Opaque<
  Readonly<{
    actorId: string
    actorPosture: AttendanceActorPostureV1
    tokenSubjectUserId: string | null
    orgId: string
    subjectScope: AttendanceWriteSubjectScopeV1
    capability: AttendanceWriteCapabilityV1
    sourceRef: string
  }>,
  'AuthorizedAttendanceWriteContextV1'
>

const contextDigests = new WeakMap<object, Buffer>()

const CONTEXT_KEYS = [
  'actorId',
  'actorPosture',
  'tokenSubjectUserId',
  'orgId',
  'subjectScope',
  'capability',
  'sourceRef',
] as const

function requireExactKeys(input: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const obj = input as Record<string, unknown>
  if (Object.getOwnPropertySymbols(obj).length > 0) fail(code)
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code)
    const descriptor = Object.getOwnPropertyDescriptor(obj, key)
    if (!descriptor || !('value' in descriptor)) fail(code) // reject getters
  }
  return obj
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code)
  return value
}

function contextDigest(fields: Record<string, unknown>): Buffer {
  return crypto.createHash('sha256').update(canonicalAttendanceJsonV1(fields), 'utf8').digest()
}

function frozenNullProto<T extends Record<string, unknown>>(fields: T): T {
  const out = Object.create(null) as T
  for (const key of Object.keys(fields)) {
    ;(out as Record<string, unknown>)[key] = fields[key]
  }
  return Object.freeze(out)
}

/**
 * Host factory. Normalizes/deep-copies every value into frozen null-prototype
 * objects and registers the canonical digest. Mints ONLY the witness — the
 * entrypoint-specific permission decision precedes calling this in the adapter.
 */
export function createAuthorizedAttendanceWriteContextV1(input: unknown): AuthorizedAttendanceWriteContextV1 {
  const code = 'W4C0_AUTHORIZATION_INPUT_INVALID'
  const fields = requireExactKeys(input, CONTEXT_KEYS, code)

  const actorId = requireNonEmptyString(fields.actorId, code)
  const actorPosture = fields.actorPosture
  if (typeof actorPosture !== 'string' || !(ATTENDANCE_ACTOR_POSTURES_V1 as readonly string[]).includes(actorPosture)) {
    fail(code)
  }
  const tokenSubjectUserId = fields.tokenSubjectUserId === null ? null : requireNonEmptyString(fields.tokenSubjectUserId, code)
  const orgId = parseCanonicalAttendanceOrgKeyV1(fields.orgId) as string
  const capability = fields.capability
  if (
    typeof capability !== 'string' ||
    !(ATTENDANCE_WRITE_CAPABILITIES_V1 as readonly string[]).includes(capability)
  ) {
    fail(code)
  }
  const sourceRef = requireNonEmptyString(fields.sourceRef, code)

  // Subject scope: closed discriminated union, deep-copied.
  const scopeInput = fields.subjectScope
  if (typeof scopeInput !== 'object' || scopeInput === null) fail(code)
  const scopeKind = (scopeInput as { kind?: unknown }).kind
  let subjectScope: AttendanceWriteSubjectScopeV1
  if (scopeKind === 'self') {
    const scope = requireExactKeys(scopeInput, ['kind', 'userId'], code)
    const userId = requireNonEmptyString(scope.userId, code)
    // Self writes reject any requested user override (lock 4.1).
    if (actorPosture === 'self' && userId !== actorId) fail('W4C0_SELF_SCOPE_USER_MISMATCH')
    subjectScope = frozenNullProto({ kind: 'self', userId }) as AttendanceWriteSubjectScopeV1
  } else if (scopeKind === 'explicit_users') {
    const scope = requireExactKeys(scopeInput, ['kind', 'userIds'], code)
    if (!Array.isArray(scope.userIds) || scope.userIds.length === 0) fail(code)
    const userIds = scope.userIds.map((entry) => requireNonEmptyString(entry, code))
    if (new Set(userIds).size !== userIds.length) fail(code)
    subjectScope = frozenNullProto({ kind: 'explicit_users', userIds: Object.freeze([...userIds]) }) as AttendanceWriteSubjectScopeV1
  } else if (scopeKind === 'org_scheduler') {
    requireExactKeys(scopeInput, ['kind'], code)
    // Scheduler scope is available only to the registered internal scheduler identity;
    // posture pairing is the W4C-0 structural half of that rule.
    if (actorPosture !== 'scheduler') fail('W4C0_SCHEDULER_SCOPE_POSTURE_MISMATCH')
    subjectScope = frozenNullProto({ kind: 'org_scheduler' }) as AttendanceWriteSubjectScopeV1
  } else {
    fail(code)
  }
  // Token-subject binding for the self posture (lock 4.1).
  if (actorPosture === 'self' && tokenSubjectUserId !== actorId) fail('W4C0_TOKEN_SUBJECT_MISMATCH')

  const witnessFields = {
    actorId,
    actorPosture,
    tokenSubjectUserId,
    orgId,
    subjectScope,
    capability,
    sourceRef,
  }
  const witness = frozenNullProto(witnessFields) as AuthorizedAttendanceWriteContextV1
  contextDigests.set(witness, contextDigest(witnessFields))
  return witness
}

/**
 * Every use recomputes and constant-time compares the registered digest before
 * reading a field. Plain objects, spreads, JSON clones, prototype lookalikes,
 * and any mutated registered object fail with the closed 403 code.
 */
export function verifyAuthorizedAttendanceWriteContextV1(
  context: unknown,
): AuthorizedAttendanceWriteContextV1 {
  if (typeof context !== 'object' || context === null) {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  const registered = contextDigests.get(context)
  if (!registered) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  let recomputed: Buffer
  try {
    const obj = context as Record<string, unknown>
    const fields: Record<string, unknown> = {}
    for (const key of CONTEXT_KEYS) fields[key] = obj[key]
    recomputed = contextDigest(fields)
  } catch {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  if (registered.length !== recomputed.length || !crypto.timingSafeEqual(registered, recomputed)) {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  return context as AuthorizedAttendanceWriteContextV1
}

/** Capability<->entrypoint matching (fails before source/result DML). */
export function requireAuthorizedCapabilityForEntrypointV1(
  context: unknown,
  entrypoint: AttendanceSourceEntrypointV1,
): AuthorizedAttendanceWriteContextV1 {
  const verified = verifyAuthorizedAttendanceWriteContextV1(context)
  const expected = ATTENDANCE_ENTRYPOINT_CAPABILITY_MATRIX_V1[entrypoint]
  if (!expected || verified.capability !== expected) {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  return verified
}

// ---------------------------------------------------------------------------
// Transaction-bound SQL recheck (lock 4.1/8.1): active user + activation status
// + active membership for actor and every explicit subject. The platform-admin
// posture may waive the ACTOR's membership but never org/subject/source
// predicates. A directory deprovision or activation change between mint and use
// therefore invalidates the witness.
// ---------------------------------------------------------------------------

export async function recheckAttendanceAuthorizationInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  context: unknown,
): Promise<void> {
  const verified = verifyAuthorizedAttendanceWriteContextV1(context)
  const subjectUserIds: string[] =
    verified.subjectScope.kind === 'self'
      ? [verified.subjectScope.userId]
      : verified.subjectScope.kind === 'explicit_users'
        ? [...verified.subjectScope.userIds]
        : []

  const requireActiveUser = async (userId: string): Promise<void> => {
    const result = await trx.query(
      "SELECT 1 FROM users WHERE id = $1 AND is_active = true AND COALESCE(activation_status, 'activated') = 'activated'",
      [userId],
    )
    if (result.rows.length !== 1) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  const requireActiveMembership = async (userId: string): Promise<void> => {
    const result = await trx.query(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true',
      [userId, verified.orgId],
    )
    if (result.rows.length !== 1) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }

  await requireActiveUser(verified.actorId)
  if (verified.actorPosture !== 'platform_admin') {
    await requireActiveMembership(verified.actorId)
  }
  for (const userId of subjectUserIds) {
    if (userId === verified.actorId) continue
    await requireActiveUser(userId)
    await requireActiveMembership(userId)
  }
}
