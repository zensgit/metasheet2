/**
 * A1 — History Field-Audit Permission: governed grant service (business rules + persistence + self-audit).
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * A grant is the ONLY thing that can later (A2) lift the history field mask. This module owns the data-layer
 * LOCK-2 rules — issuer != grantee, default-finite expiry (D5), and the issue/revoke self-audit (LOCK-2c) —
 * plus the active-grant lookup A2 will read. The route owns the authority gate (the platform capability) and
 * subject-existence validation.
 *
 * A1 does NOT wire any reveal into the history mask: `resolveHistoryFieldAuditReveal` returns an empty set
 * (no reveal), so the #2968 history mask is byte-for-byte unchanged. That byte-identity is the A1/A2 seam.
 */
import type { QueryFn } from './permission-service'

/** The standalone platform capability that authorizes issuing/revoking grants. LOCK-2: it is NEVER folded
 *  into any SHEET_* capability set — base-admin (`multitable:admin`) must not gain it implicitly. */
export const HISTORY_FIELD_AUDIT_GRANT_PERMISSION = 'multitable:history-field-audit:grant'

/** D5: when an issue request gives neither an explicit expiry nor explicit standing, this finite window is
 *  applied. Standing (no expiry) must be an explicit choice and is marked on the row + in the audit trail. */
export const DEFAULT_HISTORY_AUDIT_GRANT_WINDOW_DAYS = 90

export type HistoryAuditGrantSubjectType = 'user' | 'role' | 'member-group'

export interface HistoryAuditGrantRow {
  id: string
  baseId: string
  subjectType: HistoryAuditGrantSubjectType
  subjectId: string
  grantedBy: string
  reason: string | null
  ticket: string | null
  expiresAt: string | null
  isStanding: boolean
  createdAt: string
}

export interface IssueHistoryAuditGrantInput {
  baseId: string
  subjectType: HistoryAuditGrantSubjectType
  subjectId: string
  reason?: string | null
  ticket?: string | null
  /** ISO timestamp. Ignored when `standing` is true; defaulted to now()+window when absent and not standing. */
  expiresAt?: string | null
  /** D5: explicit standing (no expiry). Must be set deliberately; never the implicit default. */
  standing?: boolean
}

export type HistoryAuditGrantErrorCode = 'SELF_GRANT' | 'INVALID_EXPIRY'

export class HistoryAuditGrantError extends Error {
  code: HistoryAuditGrantErrorCode
  constructor(code: HistoryAuditGrantErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'HistoryAuditGrantError'
  }
}

function asIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value) return value
  return null
}

function serializeGrantRow(row: Record<string, unknown>): HistoryAuditGrantRow {
  return {
    id: String(row.id),
    baseId: String(row.base_id),
    subjectType: String(row.subject_type) as HistoryAuditGrantSubjectType,
    subjectId: String(row.subject_id),
    grantedBy: String(row.granted_by),
    reason: typeof row.reason === 'string' ? row.reason : null,
    ticket: typeof row.ticket === 'string' ? row.ticket : null,
    expiresAt: asIso(row.expires_at),
    isStanding: row.is_standing === true,
    createdAt: asIso(row.created_at) ?? '',
  }
}

/**
 * LOCK-2c / LOCK-5: write the grant issue/revoke to `operation_audit_logs`. The metadata carries the grant
 * SCOPE (base, subject, reason, ticket, expiry, standing) — never any record field VALUES (A1 reveals
 * nothing). The caller MUST run this together with the grant mutation inside ONE transaction
 * (`pool.transaction`), so a failed audit insert ROLLS BACK the grant — "no successful audit ⇒ the mutation
 * did not happen". Surfacing the error alone is not enough; atomicity is what enforces LOCK-2c.
 */
async function writeGrantAudit(
  query: QueryFn,
  action: 'history_field_audit_grant.issue' | 'history_field_audit_grant.revoke',
  actorId: string,
  grant: HistoryAuditGrantRow,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const meta = JSON.stringify({
    baseId: grant.baseId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    reason: grant.reason,
    ticket: grant.ticket,
    expiresAt: grant.expiresAt,
    isStanding: grant.isStanding,
    ...extra,
  })
  await query(
    `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', $2, 'meta_history_audit_grant', $3, $4::jsonb, $4::jsonb)`,
    [actorId, action, grant.id, meta],
  )
}

/**
 * Issue-time SELF_GRANT guardrail support: is the issuer CURRENTLY a member of the target role / group?
 * Returns false (skip the guardrail) when the membership table is absent — the reveal-time `granted_by`
 * check (A2) is the real closure, so a minimal env never blocks issuing here.
 */
async function issuerBelongsTo(
  query: QueryFn,
  kind: 'role' | 'member-group',
  issuerUserId: string,
  subjectId: string,
): Promise<boolean> {
  try {
    const res = kind === 'role'
      ? await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [issuerUserId, subjectId])
      : await query('SELECT 1 FROM platform_member_group_members WHERE user_id = $1 AND group_id::text = $2 LIMIT 1', [issuerUserId, subjectId])
    return res.rows.length > 0
  } catch {
    return false // membership table missing → cannot confirm; reveal-time closure still applies
  }
}

/**
 * Issue a grant. LOCK-2: issuer != grantee (a user cannot grant to themselves); D5: default-finite expiry
 * unless `standing` is explicitly set. The route MUST have already verified the issuer holds
 * `HISTORY_FIELD_AUDIT_GRANT_PERMISSION` (authority gate) and that the subject/base exist. Writes the
 * issue audit record (LOCK-2c) in the same call.
 */
export async function issueHistoryAuditGrant(
  query: QueryFn,
  input: IssueHistoryAuditGrantInput,
  issuerUserId: string,
  nowMs: number,
): Promise<HistoryAuditGrantRow> {
  // LOCK-2a: issuer != grantee.
  //  - Direct: a user granting to their own user id.
  //  - Indirect: granting to a role / member-group the issuer CURRENTLY belongs to. This is a fast-fail
  //    GUARDRAIL, not the load-bearing closure: membership is mutable (the issuer could join the role/group
  //    AFTER issuing), so an issue-time check can never be complete. The IMMUTABLE, subject-type-agnostic
  //    closure that actually makes LOCK-2 self-grant-proof lives at REVEAL time (A2): deny the reveal when the
  //    matching grant's `granted_by === revealer` (granted_by never changes). The membership tables may be
  //    absent in minimal envs — there the guardrail is skipped (reveal-time still closes it), never blocking.
  if (input.subjectType === 'user' && input.subjectId === issuerUserId) {
    throw new HistoryAuditGrantError('SELF_GRANT', 'An issuer cannot grant history field-audit to themselves')
  }
  if (input.subjectType === 'role' && (await issuerBelongsTo(query, 'role', issuerUserId, input.subjectId))) {
    throw new HistoryAuditGrantError('SELF_GRANT', 'An issuer cannot grant to a role they belong to')
  }
  if (input.subjectType === 'member-group' && (await issuerBelongsTo(query, 'member-group', issuerUserId, input.subjectId))) {
    throw new HistoryAuditGrantError('SELF_GRANT', 'An issuer cannot grant to a member-group they belong to')
  }

  // D5: standing must be explicit; otherwise apply the finite default (or honour an explicit future expiry).
  let expiresAt: string | null
  let isStanding: boolean
  if (input.standing === true) {
    expiresAt = null
    isStanding = true
  } else if (input.expiresAt) {
    const ms = Date.parse(input.expiresAt)
    if (!Number.isFinite(ms)) throw new HistoryAuditGrantError('INVALID_EXPIRY', 'expiresAt is not a valid timestamp')
    if (ms <= nowMs) throw new HistoryAuditGrantError('INVALID_EXPIRY', 'expiresAt must be in the future')
    expiresAt = new Date(ms).toISOString()
    isStanding = false
  } else {
    expiresAt = new Date(nowMs + DEFAULT_HISTORY_AUDIT_GRANT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    isStanding = false
  }

  const res = await query(
    `INSERT INTO meta_history_audit_grants
       (base_id, subject_type, subject_id, granted_by, reason, ticket, expires_at, is_standing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, base_id, subject_type, subject_id, granted_by, reason, ticket, expires_at, is_standing, created_at`,
    [
      input.baseId,
      input.subjectType,
      input.subjectId,
      issuerUserId,
      input.reason ?? null,
      input.ticket ?? null,
      expiresAt,
      isStanding,
    ],
  )
  const grant = serializeGrantRow((res.rows as Array<Record<string, unknown>>)[0])
  await writeGrantAudit(query, 'history_field_audit_grant.issue', issuerUserId, grant)
  return grant
}

/**
 * Revoke (soft-delete) an active grant by id within a base. Returns false if no active grant matched.
 * Writes the revoke audit record (LOCK-2c).
 */
export async function revokeHistoryAuditGrant(
  query: QueryFn,
  baseId: string,
  grantId: string,
  revokerUserId: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE meta_history_audit_grants
       SET revoked_at = now(), revoked_by = $3
     WHERE id = $1 AND base_id = $2 AND revoked_at IS NULL
     RETURNING id, base_id, subject_type, subject_id, granted_by, reason, ticket, expires_at, is_standing, created_at`,
    [grantId, baseId, revokerUserId],
  )
  const rows = res.rows as Array<Record<string, unknown>>
  if (rows.length === 0) return false
  await writeGrantAudit(query, 'history_field_audit_grant.revoke', revokerUserId, serializeGrantRow(rows[0]))
  return true
}

/** List the ACTIVE grants on a base (revoked rows excluded). Read surface for administering grants. */
export async function listHistoryAuditGrants(query: QueryFn, baseId: string): Promise<HistoryAuditGrantRow[]> {
  const res = await query(
    `SELECT id, base_id, subject_type, subject_id, granted_by, reason, ticket, expires_at, is_standing, created_at
     FROM meta_history_audit_grants
     WHERE base_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [baseId],
  )
  return (res.rows as Array<Record<string, unknown>>).map(serializeGrantRow)
}

/**
 * The active, non-expired grant for any of the actor's subject keys on a base (or null). A2 reads this to
 * decide whether a reveal is permitted; A1 exposes it for grant administration + tests. `subjectKeys` is the
 * actor's identity set: their user id + role ids + member-group ids, each as `{type, id}`.
 */
export async function loadActiveHistoryAuditGrant(
  query: QueryFn,
  baseId: string,
  subjectKeys: Array<{ type: HistoryAuditGrantSubjectType; id: string }>,
  nowMs: number,
): Promise<HistoryAuditGrantRow | null> {
  if (subjectKeys.length === 0) return null
  const types = subjectKeys.map((k) => k.type)
  const ids = subjectKeys.map((k) => k.id)
  const res = await query(
    `SELECT id, base_id, subject_type, subject_id, granted_by, reason, ticket, expires_at, is_standing, created_at
     FROM meta_history_audit_grants
     WHERE base_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $4)
       AND (subject_type, subject_id) IN (
         SELECT * FROM unnest($2::text[], $3::text[])
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [baseId, types, ids, new Date(nowMs).toISOString()],
  )
  const rows = res.rows as Array<Record<string, unknown>>
  return rows.length > 0 ? serializeGrantRow(rows[0]) : null
}

/**
 * A1/A2 SEAM. A2 will compute the field ids a valid grant + explicit reveal request lifts and UNION them into
 * the #2968 allowed-field set. For A1 this ALWAYS returns an empty set (no reveal) and is NOT called from the
 * history mask path — so the history field mask is byte-for-byte the #2968 behaviour. Do not wire this into
 * `buildHistoryAllowedFieldsBySheet` or the per-record allowed-set until the A2 opt-in.
 */
export async function resolveHistoryFieldAuditReveal(): Promise<Set<string>> {
  return new Set<string>()
}
