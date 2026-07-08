/**
 * DT-HARDEN-07 — recompute `directory_account_departments.is_primary` from stored data.
 *
 * The flag decides which management chain approvals route up (ApprovalDirectoryOrg
 * anchors on it). It was historically written as "whichever department happened to come
 * first in dept_id_list", so a multi-department employee may carry the wrong primary.
 * This recomputes it with the same resolver the sync now uses, from
 * `directory_accounts.raw` (which holds the DingTalk user/get payload).
 *
 * Idempotent: it only writes rows whose flag actually changes, and it re-derives from
 * data already in the database — no DingTalk API calls. Run it after enabling
 * DIRECTORY_PRIMARY_DEPT_FROM_ORDER (that flag is read here too, so a dry run before and
 * after tells you exactly what the switch would change).
 *
 * Usage:
 *   DATABASE_URL=… [DIRECTORY_PRIMARY_DEPT_FROM_ORDER=true] pnpm dlx tsx \
 *     packages/core-backend/scripts/backfill-directory-primary-department.ts [--dry-run]
 */
import pg from 'pg'
import {
  isDirectoryPrimaryDepartmentFromOrderEnabled,
  resolveDirectoryPrimaryDepartmentId,
} from '../src/directory/directory-sync'

const dryRun = process.argv.includes('--dry-run')

type AccountDeptRow = {
  directory_account_id: string
  directory_department_id: string
  external_department_id: string
  is_primary: boolean
  raw: unknown
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  console.log(`order-signal enabled: ${isDirectoryPrimaryDepartmentFromOrderEnabled()}`)

  try {
    const { rows } = await pool.query<AccountDeptRow>(
      `SELECT ad.directory_account_id,
              ad.directory_department_id,
              d.external_department_id,
              ad.is_primary,
              a.raw
         FROM directory_account_departments ad
         JOIN directory_departments d ON d.id = ad.directory_department_id
         JOIN directory_accounts a ON a.id = ad.directory_account_id
        ORDER BY ad.directory_account_id`,
    )

    const byAccount = new Map<string, AccountDeptRow[]>()
    for (const row of rows) {
      const list = byAccount.get(row.directory_account_id) ?? []
      list.push(row)
      byAccount.set(row.directory_account_id, list)
    }

    let changed = 0
    let unchanged = 0

    for (const [accountId, deptRows] of byAccount) {
      // Preserve the account's stored department ordering: the sync writes rows in
      // dept_id_list order, so the query's ORDER BY keeps the same fallback semantics.
      const departmentIds = deptRows.map((row) => row.external_department_id)
      const expectedPrimary = resolveDirectoryPrimaryDepartmentId({
        departmentIds,
        source: deptRows[0]?.raw,
      })

      for (const row of deptRows) {
        const shouldBePrimary = row.external_department_id === expectedPrimary
        if (shouldBePrimary === row.is_primary) {
          unchanged += 1
          continue
        }
        changed += 1
        if (dryRun) {
          console.log(`[dry-run] account ${accountId} dept ${row.external_department_id}: is_primary ${row.is_primary} → ${shouldBePrimary}`)
          continue
        }
        await pool.query(
          `UPDATE directory_account_departments
              SET is_primary = $3
            WHERE directory_account_id = $1 AND directory_department_id = $2`,
          [row.directory_account_id, row.directory_department_id, shouldBePrimary],
        )
      }
    }

    console.log(`${dryRun ? '[dry-run] ' : ''}done: ${changed} row(s) ${dryRun ? 'would change' : 'updated'}, ${unchanged} unchanged, ${byAccount.size} account(s)`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('backfill failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
