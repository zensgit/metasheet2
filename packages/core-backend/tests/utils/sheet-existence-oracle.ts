/**
 * The SHEET EXISTENCE ORACLE fixture — #5839.
 *
 * ── What it is for ────────────────────────────────────────────────────────────
 * A sheet-addressed route that reads the `meta_sheets` row BEFORE its first 403 answers 404 for a
 * soft-deleted or absent sheet and 403 for a live one. That difference is an EXISTENCE ORACLE: an
 * authenticated caller the route would refuse anyway still learns whether a sheet id is live, in the
 * recycle bin, or was never real. Closing it means the authority refusal comes FIRST and the three
 * states become indistinguishable to a caller who may not use the sheet.
 *
 * Proving that needs three sheet ids that differ ONLY in liveness, one identity that every route
 * refuses, and a pool that answers by SQL SHAPE so the assertion can be about WHICH QUERIES RAN, not
 * only about the status code. This file is that apparatus, shared by the #5839 batch (B1/B2/B3/B5) so
 * every slice proves the same property the same way.
 *
 * ── Two disciplines that make a pass mean something ───────────────────────────
 * 1. NOTHING IS HAND-TYPED. `FORBIDDEN`, `SHEET_DELETED_BODY` and `SHEET_ABSENT_BODY` are captured by
 *    CALLING the real `sendForbidden` / `sendSheetNotLive` (multitable/sheet-refusals.ts) against a
 *    capture double. A copied literal would keep passing after the product body changed — which is the
 *    exact drift sheet-refusals.ts exists to prevent. The statuses (403/404) come from the same call.
 * 2. UNKNOWN ID ⇒ LIVE. {@link makeOracleFakePool} reports `live` for any id it does not know as
 *    DELETED or ABSENT, and serves the `deleted_at IS NULL` sheet row ONLY for {@link LIVE}. So an
 *    implementation that asks the liveness question about the WRONG id cannot pass the deleted/absent
 *    cases by accident, and a restored row probe still misses on DELETED/ABSENT and reds.
 * 3. THE LOG CARRIES PARAMETERS. Every entry is an {@link OracleCall} — statement AND `$n` values — so
 *    the evidence assertion compares WHICH SHEET was asked about, not only the statement text. Asking
 *    the right questions about the wrong id is an authorization bug, and a text-only log is blind to
 *    it: the four capability statements are byte-identical whatever id they carry.
 *
 * Callers stay session identities: a `Bearer mst_` token would make oapiScopeGuard refuse an unknown
 * sheet id at MIDDLEWARE level (middleware/api-token-auth.ts), which is a 403 that proves nothing
 * about the handler under test.
 */
import type { Request, Response } from 'express'

import { resolveSheetCapabilities } from '../../src/multitable/permission-service'
import { sendForbidden, sendSheetNotLive } from '../../src/multitable/sheet-refusals'

// ── The three sheet states ──────────────────────────────────────────────────

/** Exists, `deleted_at IS NULL`. */
export const LIVE = 'sht_oracle_live'
/** Exists, soft-deleted — the state that must not be distinguishable from the other two. */
export const DELETED = 'sht_oracle_deleted'
/** No `meta_sheets` row at all. */
export const ABSENT = 'sht_oracle_absent'
/** The three ids a refused caller must not be able to tell apart. */
export const SHEET_IDS = [LIVE, DELETED, ABSENT] as const

export type OracleSheetId = (typeof SHEET_IDS)[number]

// ── Identities ──────────────────────────────────────────────────────────────

export interface OracleIdentity {
  id: string
  roles: string[]
  perms: string[]
}

/**
 * Authenticated, and refused by every route in scope.
 *
 * `perms` is deliberately NON-EMPTY (resolveRequestAccess returns early on a non-empty token perm
 * list, so no RBAC table is consulted and the SQL log stays exactly the capability lookup), yet
 * `comments:read` grants no sheet capability the config routes check (canRead / canEditRecord /
 * canManageFields / canManageSheetAccess are all false — see multitable/access.ts deriveCapabilities).
 */
export const OUTSIDER: OracleIdentity = { id: 'u_oracle_outsider', roles: ['member'], perms: ['comments:read'] }
/** Admin: passes every capability check, so it sees the post-403 liveness answer. */
export const MANAGER: OracleIdentity = { id: 'u_oracle_manager', roles: ['admin'], perms: [] }
/** May read an ordinary sheet, may not manage fields or access. */
export const READ_ONLY: OracleIdentity = { id: 'u_oracle_read_only', roles: ['member'], perms: ['multitable:read'] }

/** An express Request carrying a SESSION identity (never an api token). */
export function reqFor(user: OracleIdentity | undefined): Request {
  return ({ ...(user ? { user } : {}), headers: {} }) as unknown as Request
}

// ── Response constants, captured from the real refusal helpers ──────────────

interface CapturedRefusal {
  status: number
  body: unknown
}

/** Runs a refusal helper against a capture double and returns exactly what it emitted. */
function capture(emit: (res: Response) => unknown): CapturedRefusal {
  const captured: CapturedRefusal = { status: 200, body: undefined }
  const double = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: unknown) {
      captured.body = body
      return this
    },
  }
  emit(double as unknown as Response)
  return captured
}

const FORBIDDEN_REFUSAL = capture((res) => sendForbidden(res))
const DELETED_REFUSAL = capture((res) => sendSheetNotLive(res, 'deleted'))
const ABSENT_REFUSAL = capture((res) => sendSheetNotLive(res, 'absent'))

/** The authority refusal body — whatever `sendForbidden` currently emits. */
export const FORBIDDEN = FORBIDDEN_REFUSAL.body
export const FORBIDDEN_STATUS = FORBIDDEN_REFUSAL.status
/** The soft-deleted refusal body (SHEET_DELETED code + the restore hint). */
export const SHEET_DELETED_BODY = DELETED_REFUSAL.body
/** The absent refusal body (values-free NOT_FOUND — no id echoed). */
export const SHEET_ABSENT_BODY = ABSENT_REFUSAL.body
export const SHEET_NOT_LIVE_STATUS = ABSENT_REFUSAL.status

// ── What a refused caller must never cause ──────────────────────────────────

/**
 * Reads and writes that lie BEYOND the capability lookup. `spreadsheet_permissions`,
 * `platform_member_group_members` and `user_roles` are absent on purpose: the scope-map query the
 * capability lookup itself issues touches exactly those.
 *
 * The sheet-row probe shape is listed by name, so a restored `loadSheetRow` is caught here as well as
 * by the call-log equality.
 */
export const BEYOND_CAPABILITY =
  /\b(meta_records|meta_fields|field_permissions|record_permissions|conditional_read_rules|row_level_read_permissions_enabled|users|roles|platform_member_groups|multitable_config_revisions|meta_config_revisions)\b|FROM meta_sheets WHERE id = \$1 AND deleted_at IS NULL|\bFOR UPDATE\b|^\s*(INSERT|UPDATE|DELETE)\b/i

/** The statements of a call log that went beyond the capability lookup (empty ⇒ nothing leaked). */
export function beyondCapability(calls: readonly OracleCall[]): string[] {
  return calls.filter((call) => BEYOND_CAPABILITY.test(call.sql)).map((call) => call.sql)
}

// ── The fake pool ───────────────────────────────────────────────────────────

export interface OracleQueryResult {
  rows: any[]
  rowCount?: number
}

export type OracleQuery = (sql: string, params?: unknown[]) => Promise<OracleQueryResult>

/**
 * One query as the pool saw it: the whitespace-normalised statement AND the parameters it carried.
 *
 * The parameters are part of the record ON PURPOSE. The four statements `resolveSheetCapabilities`
 * issues are byte-identical whatever sheet they are about — only `$1` changes — so a TEXT-ONLY log
 * cannot distinguish `resolveSheetCapabilities(req, query, sheetId)` from the same call made about a
 * DIFFERENT sheet id. That difference is a real authorization bug (capabilities resolved from another
 * sheet's scope map, liveness read for another sheet) and it is precisely what rule 2 of the header
 * claims to catch. Comparing CALLS, not statements, is what makes the claim true for the refused
 * caller too — whose only other evidence is a status code that is 403 either way.
 */
export interface OracleCall {
  sql: string
  params: unknown[]
}

export interface OracleFakePoolOptions {
  /**
   * Route-specific rows (a person field, a record, a subject row …), consulted AFTER the four
   * capability segments and the sheet-row probe so it can never shadow the oracle itself. Return
   * `undefined` to fall through to the empty default.
   */
  answer?: (sql: string, params: unknown[]) => OracleQueryResult | undefined
}

export interface OracleFakePool {
  /** The pool double to hand `poolManager.get()`. */
  pool: { query: OracleQuery; transaction: (fn: (client: { query: OracleQuery }) => Promise<unknown>) => Promise<unknown>; getInternalPool: () => unknown }
  query: OracleQuery
  /** Every call issued since the last {@link reset}: statement (whitespace-normalised) + parameters. */
  calls: OracleCall[]
  /** Transactions opened since the last {@link reset}. */
  transactions: number
  reset(): void
  /** The exact call list ONE standalone `resolveSheetCapabilities` run produces for this caller/sheet. */
  capabilityCallsFor(user: OracleIdentity | undefined, sheetId: string): Promise<OracleCall[]>
}

// Matched against the WHITESPACE-NORMALISED sql, so a multi-line query matches the same shape a
// single-line one does (the scope map and the e-learning map are both written across lines).
const LIVENESS_SQL = /SELECT deleted_at FROM meta_sheets WHERE id = \$1/
const SCOPE_MAP_SQL = /FROM spreadsheet_permissions sp WHERE sp\.sheet_id = ANY\(\$2::text\[\]\)/
const APPROVAL_PROJECTION_SQL = /SELECT id FROM meta_sheets WHERE id = ANY\(\$1::text\[\]\) AND base_id = \$2/
const ELEARNING_PROJECTION_SQL = /SELECT sheet_id, org_id FROM \S+ WHERE sheet_id = ANY\(\$1::text\[\]\)/i
const SHEET_ROW_SQL = /FROM meta_sheets WHERE id = \$1 AND deleted_at IS NULL/

/** The soft-delete timestamp. A fixed instant so a body that ever echoed it would be obvious. */
const DELETED_AT = new Date('2026-09-01T00:00:00.000Z')

export function makeOracleFakePool(options: OracleFakePoolOptions = {}): OracleFakePool {
  // IDENTITY-STABLE: emptied in place, never reassigned, so a suite may hold on to the array.
  const calls: OracleCall[] = []
  const state = { transactions: 0 }

  const query: OracleQuery = async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim()
    // Parameters are COPIED: a caller that reuses one array for several queries must not rewrite history.
    calls.push({ sql: flat, params: [...params] })

    // 1/4 liveness — the one query loadSheetLiveness issues. UNKNOWN ID ⇒ LIVE (see header).
    if (LIVENESS_SQL.test(flat)) {
      const id = params[0]
      if (id === ABSENT) return { rows: [] }
      return { rows: [{ deleted_at: id === DELETED ? DELETED_AT : null }] }
    }
    // 2/4 loadSheetPermissionScopeMap — no sheet-scoped grant for anyone.
    if (SCOPE_MAP_SQL.test(flat)) return { rows: [] }
    // 3/4 approval projection membership (non-admins only) — none of these sheets is a projection sheet.
    if (APPROVAL_PROJECTION_SQL.test(flat)) return { rows: [] }
    // 4/4 e-learning projection map — never reached for these ids (they do not match the
    // sht_el_stats_<32 hex> candidate pattern), answered anyway so a widened pattern cannot 500.
    if (ELEARNING_PROJECTION_SQL.test(flat)) return { rows: [] }

    // The EXISTENCE PROBE this issue removes. A row only for LIVE, so a probe that survived is caught
    // by its 404 on DELETED/ABSENT — including one that asks about the wrong id.
    if (SHEET_ROW_SQL.test(flat)) {
      return params[0] === LIVE
        ? { rows: [{ id: LIVE, base_id: 'base_oracle', name: 'Oracle', description: null }] }
        : { rows: [] }
    }

    const extra = options.answer?.(flat, params)
    if (extra) return extra
    return { rows: [], rowCount: 0 }
  }

  const pool = {
    query,
    transaction: async (fn: (client: { query: OracleQuery }) => Promise<unknown>) => {
      state.transactions += 1
      return fn({ query })
    },
    getInternalPool: () => ({}),
  }

  return {
    pool,
    query,
    calls,
    get transactions() {
      return state.transactions
    },
    reset() {
      calls.length = 0
      state.transactions = 0
    },
    async capabilityCallsFor(user, sheetId) {
      // The probe run must leave the caller's log exactly as it found it.
      const saved = calls.splice(0, calls.length)
      try {
        await resolveSheetCapabilities(reqFor(user), query, sheetId)
        return calls.splice(0, calls.length)
      } finally {
        calls.length = 0
        calls.push(...saved)
      }
    },
  }
}
