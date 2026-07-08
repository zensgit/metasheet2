/**
 * DT-HARDEN-07 — recompute `directory_account_departments.is_primary` from stored data.
 *
 * The flag decides which management chain approvals route up (ApprovalDirectoryOrg anchors
 * on it). It was historically written as "whichever department happened to come first in
 * dept_id_list", so a multi-department employee may carry the wrong primary. This recomputes
 * it with the same resolver the sync now uses, reading `directory_accounts.raw` — the stored
 * DingTalk `user/get` payload. No DingTalk API calls.
 *
 * The department ORDER comes from `raw.dept_id_list`, never from row order. There is no
 * ordering column on `directory_account_departments`, so a `SELECT` returns heap order and
 * every `UPDATE` moves the tuple to the heap tail. Deriving `departmentIds` from row order
 * made this script non-idempotent: it walked the primary department one step further on each
 * run, WITH THE FLAG OFF. It also made `--dry-run` — which the design-lock names as the
 * operator's go/no-go for flipping a live approval-routing flag — report changes the sync
 * would never make.
 *
 * With `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` unset this script is now a provable no-op against
 * a synced database: it derives exactly what the sync writes. Turn the flag on and re-run
 * `--dry-run` to see precisely which people the switch would re-route.
 *
 * An account whose `raw` carries no usable `dept_id_list` is SKIPPED and reported, never
 * guessed at: guessing would silently re-route a live approval chain.
 *
 * Usage:
 *   DATABASE_URL=… [DIRECTORY_PRIMARY_DEPT_FROM_ORDER=true] pnpm dlx tsx \
 *     packages/core-backend/scripts/backfill-directory-primary-department.ts \
 *     [--dry-run] [--integration=<uuid>]
 */
import pg from 'pg'
import {
  isDirectoryPrimaryDepartmentFromOrderEnabled,
  resolveDirectoryPrimaryDepartmentId,
} from '../src/directory/directory-sync'

type AccountDeptRow = {
  directory_account_id: string
  directory_department_id: string
  external_department_id: string
  is_primary: boolean
  raw: unknown
}

export type BackfillSummary = {
  changed: number
  unchanged: number
  skipped: number
  accounts: number
}

/** Just enough of `pg.Pool` to run the backfill — lets a test pass a scoped pool. */
type BackfillPool = {
  query: <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<pg.QueryResult<R>>
  connect: () => Promise<pg.PoolClient>
}

/**
 * The department order the sync itself used: `raw.dept_id_list`, restricted to departments
 * this account actually has rows for. Departments present as rows but absent from the payload
 * (a stale membership, or one merged in from another department's listing) are appended in a
 * stable order, so the result never depends on heap layout.
 *
 * Returns null when the payload carries no usable list — the caller must skip, not guess.
 */
export function resolveBackfillDepartmentOrder(raw: unknown, rowDepartmentIds: string[]): string[] | null {
  const payload = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
  const list = payload?.dept_id_list ?? payload?.deptIdList
  if (!Array.isArray(list)) return null

  const declared = list.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (declared.length === 0) return null

  const rows = new Set(rowDepartmentIds)
  const ordered = declared.filter((id) => rows.has(id))
  const extras = rowDepartmentIds.filter((id) => !declared.includes(id)).sort()
  const result = [...ordered, ...extras]
  return result.length > 0 ? result : null
}

/**
 * Exported so a real-DB test can drive the actual loop. The P1 this replaced — a primary
 * department that walked one step per run with the flag off, and a `--dry-run` that predicted
 * changes the sync would never make — was invisible to every test, because nothing exercised
 * the script at all.
 */
export async function runPrimaryDepartmentBackfill(
  pool: BackfillPool,
  options: { dryRun: boolean; integrationId?: string; log?: (message: string) => void } = { dryRun: true },
): Promise<BackfillSummary> {
  const log = options.log ?? (() => undefined)
  const { dryRun, integrationId } = options

  const { rows } = await pool.query<AccountDeptRow>(
    `SELECT ad.directory_account_id,
            ad.directory_department_id,
            d.external_department_id,
            ad.is_primary,
            a.raw
       FROM directory_account_departments ad
       JOIN directory_departments d ON d.id = ad.directory_department_id
       JOIN directory_accounts a ON a.id = ad.directory_account_id
      WHERE $1::uuid IS NULL OR a.integration_id = $1::uuid
      ORDER BY ad.directory_account_id, d.external_department_id`,
    [integrationId ?? null],
  )

  const byAccount = new Map<string, AccountDeptRow[]>()
  for (const row of rows) {
    const list = byAccount.get(row.directory_account_id) ?? []
    list.push(row)
    byAccount.set(row.directory_account_id, list)
  }

  const summary: BackfillSummary = { changed: 0, unchanged: 0, skipped: 0, accounts: byAccount.size }

  for (const [accountId, deptRows] of byAccount) {
    const departmentIds = resolveBackfillDepartmentOrder(
      deptRows[0]?.raw,
      deptRows.map((row) => row.external_department_id),
    )
    if (!departmentIds) {
      summary.skipped += 1
      log(`[skip] account ${accountId}: raw has no usable dept_id_list — refusing to guess a primary department`)
      continue
    }

    const expectedPrimary = resolveDirectoryPrimaryDepartmentId({ departmentIds, source: deptRows[0]?.raw })
    const updates = deptRows.filter((row) => (row.external_department_id === expectedPrimary) !== row.is_primary)
    summary.unchanged += deptRows.length - updates.length
    if (updates.length === 0) continue

    summary.changed += updates.length
    if (dryRun) {
      for (const row of updates) {
        log(`[dry-run] account ${accountId} dept ${row.external_department_id}: is_primary ${row.is_primary} → ${!row.is_primary}`)
      }
      continue
    }

    // One transaction per account. Moving the flag between departments takes two statements;
    // a crash between them would leave the account with two primaries or none, and the
    // approval resolver would then pick by chance.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const row of updates) {
        await client.query(
          `UPDATE directory_account_departments
              SET is_primary = $3
            WHERE directory_account_id = $1 AND directory_department_id = $2`,
          [row.directory_account_id, row.directory_department_id, row.external_department_id === expectedPrimary],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return summary
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const dryRun = process.argv.includes('--dry-run')
  const integrationId = process.argv.find((arg) => arg.startsWith('--integration='))?.split('=')[1]

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  console.log(`order-signal enabled: ${isDirectoryPrimaryDepartmentFromOrderEnabled()}`)
  console.log(`scope: ${integrationId ?? 'ALL integrations'}`)
  if (dryRun) console.log('[dry-run] no rows will be written')

  try {
    const summary = await runPrimaryDepartmentBackfill(pool, { dryRun, integrationId, log: (message) => console.log(message) })
    console.log(
      `${dryRun ? '[dry-run] ' : ''}done: ${summary.changed} row(s) ${dryRun ? 'would change' : 'updated'}, `
      + `${summary.unchanged} unchanged, ${summary.skipped} account(s) skipped, ${summary.accounts} account(s) scanned`,
    )
  } finally {
    await pool.end()
  }
}

// Importing this module (a test does) must not run the backfill.
if (process.argv[1]?.includes('backfill-directory-primary-department')) {
  main().catch((err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
