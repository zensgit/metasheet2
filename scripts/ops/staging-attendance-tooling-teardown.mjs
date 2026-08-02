/**
 * W4C-3c P16 — shared tooling-only / W4-backed cleanup classification for
 * scripts/ops/staging-attendance-*.
 *
 * - W4-backed parents (current_calculation_id OR projection_owner <> legacy_untracked
 *   OR any calculation children) MUST retire via the canonical ops_retirement
 *   path. This module never DELETEs those rows.
 * - Pure non-W4 fixture teardown is explicitly named
 *   tooling_only_non_w4_fixture_teardown and requires the closed guard token
 *   plus a zero W4-immutable-row proof before physical DELETE.
 * - Cleanup failures are never swallowed by this helper.
 */
export const ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN =
  'ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN'

export const ATTENDANCE_STAGING_CLEANUP_PURPOSE = Object.freeze({
  W4_BACKED_OPS_RETIREMENT: 'w4_backed_ops_retirement',
  TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN: 'tooling_only_non_w4_fixture_teardown',
})

function asRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function assertBoundedCleanupScope(scope) {
  const hasUserIds = Array.isArray(scope?.userIds) && scope.userIds.length > 0
  const hasRecordIds = Array.isArray(scope?.recordIds) && scope.recordIds.length > 0
  const hasUserIdPrefix = typeof scope?.userIdPrefix === 'string' && scope.userIdPrefix.length > 0
  if (!hasUserIds && !hasRecordIds && !hasUserIdPrefix) {
    const error = new Error('ATTENDANCE_STAGING_CLEANUP_SCOPE_UNBOUNDED')
    error.code = 'ATTENDANCE_STAGING_CLEANUP_SCOPE_UNBOUNDED'
    throw error
  }
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any> }} db
 * @param {{ orgId: string, userIds?: string[], recordIds?: string[], userIdPrefix?: string }} scope
 */
export async function countW4ImmutableAttendanceRows(db, scope) {
  const params = [scope.orgId]
  let filter = 'org_id = $1'
  if (Array.isArray(scope.recordIds) && scope.recordIds.length > 0) {
    params.push(scope.recordIds)
    filter += ` AND id = ANY($${params.length}::uuid[])`
  }
  if (Array.isArray(scope.userIds) && scope.userIds.length > 0) {
    params.push(scope.userIds)
    filter += ` AND user_id = ANY($${params.length}::text[])`
  }
  if (typeof scope.userIdPrefix === 'string' && scope.userIdPrefix.length > 0) {
    params.push(scope.userIdPrefix)
    filter += ` AND left(user_id, $${params.length}) = $${params.length}`
  }
  const result = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM attendance_records
      WHERE ${filter}
        AND (
          current_calculation_id IS NOT NULL
          OR projection_owner IS DISTINCT FROM 'legacy_untracked'
          OR EXISTS (
            SELECT 1 FROM attendance_record_calculations c
             WHERE c.attendance_record_id = attendance_records.id
               AND c.org_id = attendance_records.org_id
          )
        )`,
    params,
  )
  const rows = asRows(result)
  return Number(rows[0]?.n ?? 0)
}

/**
 * Fail closed when a staging helper attempts raw DELETE against W4-backed rows.
 */
export function assertToolingOnlyNonW4FixtureTeardownAllowed(input) {
  if (input?.purpose !== ATTENDANCE_STAGING_CLEANUP_PURPOSE.TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN) {
    const error = new Error('ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
    error.code = 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN'
    throw error
  }
  if (input?.explicitGuardToken !== ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN) {
    const error = new Error('ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
    error.code = 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN'
    throw error
  }
  if (!Number.isSafeInteger(input?.w4ImmutableRowCount) || input.w4ImmutableRowCount !== 0) {
    const error = new Error('ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
    error.code = 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN'
    throw error
  }
}

/**
 * Authenticated retirement executor for staging smokes that have BASE_URL + token.
 * Uses the same HTTP ops-retirement boundary as production; command identity is
 * a stable UUIDv5-style id from commandSeed + recordId (never random).
 *
 * @param {{ baseUrl: string, token: string, commandSeed: string, reason?: string, ticket?: string }} options
 */
export function createAuthenticatedOpsRetirementExecutor(options) {
  const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '')
  const token = String(options?.token || '')
  const commandSeed = String(options?.commandSeed || '')
  if (!baseUrl || !token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandSeed)) {
    const error = new Error('ATTENDANCE_STAGING_RETIREMENT_EXECUTOR_INVALID')
    error.code = 'ATTENDANCE_STAGING_RETIREMENT_EXECUTOR_INVALID'
    throw error
  }
  const reason = options.reason || 'staging W4-backed cleanup via ops_retirement'
  const ticket = String(options.ticket || 'STAGING-OPS-RETIRE').slice(0, 128)

  return async function retireRecord(row) {
    const recordId = String(row.id || row.record_id || '')
    if (!recordId) {
      const error = new Error('ATTENDANCE_STAGING_RETIREMENT_RECORD_ID_REQUIRED')
      error.code = 'ATTENDANCE_STAGING_RETIREMENT_RECORD_ID_REQUIRED'
      throw error
    }
    const crypto = await import('node:crypto')
    const name = `ops_retirement:${commandSeed.toLowerCase()}:${recordId.toLowerCase()}`
    const hash = crypto.createHash('sha1').update(name, 'utf8').digest()
    hash[6] = (hash[6] & 0x0f) | 0x50
    hash[8] = (hash[8] & 0x3f) | 0x80
    const hex = hash.subarray(0, 16).toString('hex')
    const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

    const response = await fetch(`${baseUrl}/api/attendance/records/${encodeURIComponent(recordId)}/ops-retirement`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationId, reason, ticket }),
    })
    const raw = await response.text()
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    if (!response.ok || body?.ok === false) {
      const error = new Error(
        body?.error?.message || raw || `ops_retirement HTTP ${response.status}`,
      )
      error.code = body?.error?.code || `HTTP_${response.status}`
      error.status = response.status
      throw error
    }
    return body
  }
}

export async function classifyStagingAttendanceCleanup(db, scope) {
  const w4Count = await countW4ImmutableAttendanceRows(db, scope)
  if (w4Count > 0) {
    return {
      purpose: ATTENDANCE_STAGING_CLEANUP_PURPOSE.W4_BACKED_OPS_RETIREMENT,
      w4ImmutableRowCount: w4Count,
      allowedDelete: false,
      instruction: 'invoke ops_retirement boundary per W4-backed record; never DELETE',
    }
  }
  return {
    purpose: ATTENDANCE_STAGING_CLEANUP_PURPOSE.TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN,
    w4ImmutableRowCount: 0,
    allowedDelete: true,
    explicitGuardToken: ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN_TOKEN,
  }
}

/**
 * Run tooling-only DELETE only after the closed guard. W4-backed scopes throw.
 * Proves immutable-row absence again immediately before physical delete.
 */
export async function runStagingAttendanceRecordTeardown(db, scope) {
  assertBoundedCleanupScope(scope)
  const classification = await classifyStagingAttendanceCleanup(db, scope)
  if (!classification.allowedDelete) {
    const error = new Error('ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
    error.code = 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN'
    error.classification = classification
    throw error
  }
  // Re-prove zero W4 immutable rows immediately before DELETE (lock §7.10).
  const provenCount = await countW4ImmutableAttendanceRows(db, scope)
  assertToolingOnlyNonW4FixtureTeardownAllowed({
    purpose: classification.purpose,
    explicitGuardToken: classification.explicitGuardToken,
    w4ImmutableRowCount: provenCount,
  })
  const params = [scope.orgId]
  let filter = 'org_id = $1'
  if (Array.isArray(scope.userIds) && scope.userIds.length > 0) {
    params.push(scope.userIds)
    filter += ` AND user_id = ANY($${params.length}::text[])`
  }
  if (Array.isArray(scope.recordIds) && scope.recordIds.length > 0) {
    params.push(scope.recordIds)
    filter += ` AND id = ANY($${params.length}::uuid[])`
  }
  if (typeof scope.userIdPrefix === 'string' && scope.userIdPrefix.length > 0) {
    params.push(scope.userIdPrefix)
    filter += ` AND left(user_id, $${params.length}) = $${params.length}`
  }
  await db.query(
    `/* tooling_only_non_w4_fixture_teardown */
     DELETE FROM attendance_records
      WHERE ${filter}
        AND current_calculation_id IS NULL
        AND projection_owner IS NOT DISTINCT FROM 'legacy_untracked'
        AND NOT EXISTS (
          SELECT 1 FROM attendance_record_calculations c
           WHERE c.attendance_record_id = attendance_records.id
             AND c.org_id = attendance_records.org_id
        )`,
    params,
  )
  // Residue proof: zero rows remain in scope.
  const residue = await db.query(
    `SELECT COUNT(*)::int AS n FROM attendance_records WHERE ${filter}`,
    params,
  )
  const remaining = Number(asRows(residue)[0]?.n ?? 0)
  if (remaining !== 0) {
    const error = new Error('ATTENDANCE_STAGING_CLEANUP_RESIDUE')
    error.code = 'ATTENDANCE_STAGING_CLEANUP_RESIDUE'
    error.remaining = remaining
    throw error
  }
  return classification
}

/**
 * Full staging cleanup for a scope:
 * 1) ops_retirement for every W4-backed parent (requires retireRecord)
 * 2) tooling-only DELETE for remaining non-W4 rows after immutable-count guard
 * 3) residue proof
 *
 * @param {{ query: Function }} db
 * @param {{ orgId: string, userIds?: string[], recordIds?: string[], userIdPrefix?: string }} scope
 * @param {{ retireRecord?: (row: Record<string, unknown>) => Promise<void> }} [options]
 */
export async function cleanupStagingAttendanceScope(db, scope, options = {}) {
  if (!scope || typeof scope.orgId !== 'string' || !scope.orgId) {
    const error = new Error('ATTENDANCE_STAGING_CLEANUP_SCOPE_INVALID')
    error.code = 'ATTENDANCE_STAGING_CLEANUP_SCOPE_INVALID'
    throw error
  }
  assertBoundedCleanupScope(scope)
  const params = [scope.orgId]
  let filter = 'org_id = $1'
  if (Array.isArray(scope.userIds) && scope.userIds.length > 0) {
    params.push(scope.userIds)
    filter += ` AND user_id = ANY($${params.length}::text[])`
  }
  if (Array.isArray(scope.recordIds) && scope.recordIds.length > 0) {
    params.push(scope.recordIds)
    filter += ` AND id = ANY($${params.length}::uuid[])`
  }
  if (typeof scope.userIdPrefix === 'string' && scope.userIdPrefix.length > 0) {
    params.push(scope.userIdPrefix)
    filter += ` AND left(user_id, $${params.length}) = $${params.length}`
  }

  const listed = await db.query(
    `SELECT id::text AS id, user_id::text AS user_id, work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason
       FROM attendance_records
      WHERE ${filter}`,
    params,
  )
  const rows = asRows(listed)

  // A row is W4-backed when it has a pointer, non-legacy owner, or calculation children.
  const w4Rows = []
  const nonW4Ids = []
  for (const row of rows) {
    const childCountResult = await db.query(
      `SELECT COUNT(*)::int AS n FROM attendance_record_calculations
        WHERE attendance_record_id = $1::uuid AND org_id = $2`,
      [row.id, scope.orgId],
    )
    const childCount = Number(asRows(childCountResult)[0]?.n ?? 0)
    const isW4 =
      row.current_calculation_id != null
      || (row.projection_owner != null && row.projection_owner !== 'legacy_untracked')
      || childCount > 0
    if (isW4) w4Rows.push(row)
    else nonW4Ids.push(row.id)
  }

  const retired = []
  const activeW4 = w4Rows.filter((row) => row.visibility_reason !== 'operator_retirement')
  if (activeW4.length > 0) {
    if (typeof options.retireRecord !== 'function') {
      const error = new Error('ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN')
      error.code = 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN'
      error.message = 'W4-backed rows require retireRecord (ops_retirement); bare DELETE forbidden'
      throw error
    }
    for (const row of activeW4) {
      await options.retireRecord(row)
      retired.push(row.id)
    }
  }

  if (nonW4Ids.length > 0) {
    await runStagingAttendanceRecordTeardown(db, {
      orgId: scope.orgId,
      recordIds: nonW4Ids,
    })
  }

  // Final residue: only already-retired W4 rows (or none) may remain.
  const after = await db.query(
    `SELECT id::text AS id, visibility_reason
       FROM attendance_records
      WHERE ${filter}`,
    params,
  )
  const remaining = asRows(after)
  const illegalResidue = remaining.filter(
    (row) => row.visibility_reason !== 'operator_retirement',
  )
  if (illegalResidue.length > 0) {
    const error = new Error('ATTENDANCE_STAGING_CLEANUP_RESIDUE')
    error.code = 'ATTENDANCE_STAGING_CLEANUP_RESIDUE'
    error.remaining = illegalResidue
    throw error
  }

  return {
    retiredCount: retired.length,
    toolingDeletedCount: nonW4Ids.length,
    retired,
    toolingDeleted: nonW4Ids,
  }
}
