import { isUndefinedColumnError, isUndefinedTableError } from '../utils/database-errors'
import { acquireCanonicalSheetFence, isWriterBlockState } from './canonical-sheet-fence'
import type { RetentionQueryFn } from './meta-revision-retention'
import { assertInTransaction } from './pg-transaction-guard'

export type RetentionTransactionRunner = <T>(
  work: (client: { query: RetentionQueryFn }) => Promise<T>,
) => Promise<T>

export type TombstoneRetentionTable = 'meta_field_value_tombstones' | 'meta_link_tombstones'

/** Never expose native SQL errors or transaction probe identifiers to the scheduler logger. */
export class TombstoneRetentionAdmissionError extends Error {
  readonly code = 'TOMBSTONE_RETENTION_ADMISSION_REFUSED'
  constructor() {
    super('TOMBSTONE_RETENTION_ADMISSION_REFUSED')
    this.name = 'TombstoneRetentionAdmissionError'
  }
}

/** Bounded discovery routes work; only fresh eligibility under the sheet fence authorizes deletion. */
export async function sweepProtectedTombstoneRetention(
  outerQuery: RetentionQueryFn,
  config: { days: number; batchSize: number },
  table: TombstoneRetentionTable,
  transaction?: RetentionTransactionRunner,
): Promise<number> {
  if (!transaction) throw new TombstoneRetentionAdmissionError()
  const anchor = table === 'meta_link_tombstones' ? 'source_revision_id' : 'config_revision_id'
  try {
    let discoverFloor = false
    if (table === 'meta_link_tombstones') {
      // A metadata branch preserves old-schema routing without aborting a caller's query handle.
      const schema = await outerQuery(`/* retention-admission:floor-schema */
        SELECT to_regclass('${table}') IS NOT NULL AS source_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = to_regclass('${table}')
              AND attname = 'operation_id' AND NOT attisdropped) AS operation_present,
          to_regclass('meta_records_trash') IS NOT NULL AS table_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = to_regclass('meta_records_trash')
              AND attname = 'delete_revision_id' AND NOT attisdropped) AS floor_present`)
      const row = schema.rows[0] as { source_present?: unknown; operation_present?: unknown; table_present?: unknown; floor_present?: unknown } | undefined
      if (schema.rows.length !== 1) throw new TombstoneRetentionAdmissionError()
      if (row?.source_present === false || (row?.source_present === true && row.operation_present === false)) return 0
      if (row?.source_present !== true || row.operation_present !== true || row.table_present !== true || typeof row.floor_present !== 'boolean') {
        throw new TombstoneRetentionAdmissionError()
      }
      discoverFloor = row.floor_present
    }
    const groups = await outerQuery(`/* retention-admission:discover-groups */
      SELECT g.anchor, g.sheet_id FROM (
        SELECT ${anchor} AS anchor, min(sheet_id) AS sheet_id, max(created_at) AS newest
        FROM ${table} WHERE ${anchor} IS NOT NULL
        GROUP BY ${anchor}
        HAVING bool_and(operation_id IS NULL) AND count(DISTINCT sheet_id) = 1
      ) g
      WHERE g.newest < now() - ($1::int * interval '1 day')
        ${discoverFloor ? 'AND NOT EXISTS (SELECT 1 FROM meta_records_trash tr WHERE tr.delete_revision_id = g.anchor::text)' : ''}
      LIMIT $2`, [config.days, config.batchSize])
    const loose = await outerQuery(`/* retention-admission:discover-loose */
      SELECT id, sheet_id FROM ${table}
      WHERE ${anchor} IS NULL AND operation_id IS NULL
        AND created_at < now() - ($1::int * interval '1 day')
      LIMIT $2`, [config.days, config.batchSize])
    const sheets = new Map<string, { anchors: string[]; ids: string[] }>()
    for (const [rows, key] of [[groups.rows, 'anchor'], [loose.rows, 'id']] as const) {
      for (const value of rows) {
        const row = value as Record<string, unknown>
        if (typeof row?.sheet_id !== 'string' || !row.sheet_id || typeof row[key] !== 'string' || !row[key]) {
          throw new TombstoneRetentionAdmissionError()
        }
        const candidates = sheets.get(row.sheet_id) ?? { anchors: [], ids: [] }
        if (key === 'anchor') candidates.anchors.push(row[key] as string)
        else candidates.ids.push(row[key] as string)
        sheets.set(row.sheet_id, candidates)
      }
    }
    let deleted = 0
    for (const [sheetId, candidates] of sheets) {
      deleted += await transaction(async ({ query }) => {
        // These source-free statements must precede the first snapshot-bearing query.
        await query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        const isolation = await query('SHOW transaction_isolation')
        if (isolation.rows.length !== 1 ||
          (isolation.rows[0] as { transaction_isolation?: unknown }).transaction_isolation !== 'read committed') {
          throw new TombstoneRetentionAdmissionError()
        }
        await assertInTransaction({ query: async (sql, params) => {
          const result = await query(sql, params)
          return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? null }
        } }, 'TOMBSTONE_RETENTION_ADMISSION')
        await acquireCanonicalSheetFence(query, sheetId)
        const stateResult = await query('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [sheetId])
        if (stateResult.rows.length !== 1) throw new TombstoneRetentionAdmissionError()
        const state = (stateResult.rows[0] as { recovery_writer_state?: unknown }).recovery_writer_state
        if (isWriterBlockState(state)) return 0
        if (state !== null) throw new TombstoneRetentionAdmissionError()

        let count = 0
        if (candidates.anchors.length > 0) {
          const groupedSql = (floor: boolean) => `/* retention-admission:fresh-groups */
            DELETE FROM ${table}
            WHERE sheet_id = $2 AND operation_id IS NULL AND ${anchor} IN (
              SELECT g.anchor FROM (
                SELECT ${anchor} AS anchor, max(created_at) AS newest
                FROM ${table} WHERE ${anchor} = ANY($3::uuid[])
                GROUP BY ${anchor}
                HAVING bool_and(operation_id IS NULL)
                  AND count(DISTINCT sheet_id) = 1 AND min(sheet_id) = $2
              ) g
              WHERE g.newest < now() - ($1::int * interval '1 day')
              ${floor ? 'AND NOT EXISTS (SELECT 1 FROM meta_records_trash tr WHERE tr.delete_revision_id = g.anchor::text)' : ''}
            )`
          const params = [config.days, sheetId, candidates.anchors]
          if (table === 'meta_link_tombstones') {
            // Recover only this optional floor query; a native 42703 otherwise aborts the transaction.
            await query('SAVEPOINT retention_admission_floor')
            try {
              count += (await query(groupedSql(true), params)).rowCount ?? 0
            } catch (error) {
              if (!isUndefinedColumnError(error, 'delete_revision_id')) throw error
              await query('ROLLBACK TO SAVEPOINT retention_admission_floor')
              count += (await query(groupedSql(false), params)).rowCount ?? 0
            }
            await query('RELEASE SAVEPOINT retention_admission_floor')
          } else {
            count += (await query(groupedSql(false), params)).rowCount ?? 0
          }
        }
        if (candidates.ids.length > 0) {
          count += (await query(`/* retention-admission:fresh-loose */
            DELETE FROM ${table}
            WHERE id = ANY($3::uuid[]) AND sheet_id = $2
              AND ${anchor} IS NULL AND operation_id IS NULL
              AND created_at < now() - ($1::int * interval '1 day')`,
          [config.days, sheetId, candidates.ids])).rowCount ?? 0
        }
        return count
      })
    }
    return deleted
  } catch (error) {
    if (isUndefinedColumnError(error, 'operation_id') || isUndefinedTableError(error, table)) return 0
    throw new TombstoneRetentionAdmissionError()
  }
}
