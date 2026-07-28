/**
 * FWB-0 Layer 2 — canonical per-(sheet, record) transaction advisory lock for row-level
 * record_permissions serialization.
 *
 * Why advisory (not only FOR UPDATE on record_permissions rows):
 *   A concurrent INSERT of access_level='none' is a phantom — FOR UPDATE on zero existing rows
 *   does not block it. Final create re-reads record_permissions for deny; writers that INSERT/
 *   DELETE deny grants must take the SAME xact advisory key before auth/read/write so create
 *   either observes the deny or the writer parks until create commits.
 *
 * Key format is stable — do not change without a dual-write migration plan.
 */
import type { QueryFn } from '../multitable/permission-service'

export const RECORD_LINK_ROW_AUTH_LOCK_PREFIX = 'record-link:row-auth:' as const

export function recordLinkRowAuthLockKey(sheetId: string, recordId: string): string {
  return `${RECORD_LINK_ROW_AUTH_LOCK_PREFIX}${sheetId.trim()}:${recordId.trim()}`
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as { code?: unknown })?.code === 'string'
    ? (err as { code: string }).code
    : null
  const message = typeof (err as { message?: unknown })?.message === 'string'
    ? (err as { message: string }).message
    : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation "${tableName}" does not exist`)
}

/**
 * Acquire the sheet+record row-auth fence on the CURRENT transaction.
 * Also FOR UPDATE any existing record_permissions rows for (sheet, record) so concurrent
 * UPDATE/DELETE of known grants serialize. Phantom INSERT is covered by the advisory alone.
 * Fail-closed: rethrows on unexpected errors (only missing record_permissions table is soft).
 */
export async function acquireRecordLinkRowAuthLockOnQuery(
  query: QueryFn,
  sheetId: string,
  recordId: string,
): Promise<void> {
  const sid = sheetId.trim()
  const rid = recordId.trim()
  if (!sid || !rid) return
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [recordLinkRowAuthLockKey(sid, rid)])
  // Optional relation in some envs: SAVEPOINT so 42P01 does not abort the outer txn (25P02).
  try {
    await query('SAVEPOINT record_link_row_auth_perms')
    try {
      await query(
        `SELECT id FROM record_permissions
         WHERE sheet_id = $1 AND record_id = $2
         FOR UPDATE`,
        [sid, rid],
      )
      await query('RELEASE SAVEPOINT record_link_row_auth_perms')
    } catch (err) {
      try {
        await query('ROLLBACK TO SAVEPOINT record_link_row_auth_perms')
      } catch {
        // ignore
      }
      if (!isUndefinedTableError(err, 'record_permissions')) throw err
    }
  } catch (err) {
    if (!isUndefinedTableError(err, 'record_permissions')) throw err
  }
}
