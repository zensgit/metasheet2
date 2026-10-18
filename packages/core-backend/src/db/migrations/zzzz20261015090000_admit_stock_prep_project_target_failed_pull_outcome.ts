import { sql, type Kysely } from 'kysely'

/**
 * 一个项目一张备料表 — G1 field defect (R67): admit `failed` on the registry's `last_pull_outcome`.
 *
 * WHY. Migration 087 (`packages/core-backend/migrations/087_create_integration_stock_prep_project_target.sql`)
 * installed `integration_stock_prep_project_target_last_pull_outcome_check` with the closed enum
 * ('applied', 'previewed', 'refused'). An apply that RAN but whose target refused rows (the G1 field report:
 * 652 of 652 rows `select_option_not_found`) was therefore stamped `applied`, and the project overview's
 * 「最近拉取」 showed success. The plugin now stamps such an apply `failed` with the dominant row error code
 * (plugins/plugin-integration-core/lib/stock-preparation-project-target-store.cjs PROJECT_TARGET_PULL_OUTCOMES),
 * so the DB-enforced enum must admit it.
 *
 * zzzz-named on purpose (the house rule zzzz20260712120000_stock_prep_audit_immutable_trigger states): it
 * operates on a table a 0xx SQL migration creates, and every `0xx_*.sql` name sorts before every `zzzz*`
 * name, so 087 has always run first. It is a TypeScript migration rather than an `089_*.sql` file because
 * the SQL-file provider (src/db/migration-provider.ts `createSqlFileMigration`) has `up` only, and this
 * change needs the guarded `down()` below.
 *
 * up()   — idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT with the four outcomes. Re-running it
 *          re-creates the same constraint. Existing rows hold only 087's three outcomes (or NULL), so the
 *          ADD validates without touching a row.
 * down() — restores 087's three-outcome constraint ONLY while no row records `failed`. With such rows it
 *          REFUSES (throws, the migration transaction rolls back, the four-outcome constraint stands): it
 *          never rewrites, nulls or deletes a recorded outcome to make the old constraint fit.
 *
 * UPGRADE ORDER: the upgrade must run migrations BEFORE the first apply on the new package. Until this migration
 * has run, 087's CHECK refuses the `failed` stamp, the route logs and swallows that (the stamp never fails the
 * pull), and the registry keeps the dry-run's `previewed` — a failed apply then shows as `previewed`, never as
 * `applied`.
 *
 * VALUES-FREE: the only thing this reads from the table is a count; the refusal names the count.
 */

export const PROJECT_TARGET_TABLE = 'integration_stock_prep_project_target'
export const PULL_OUTCOME_CONSTRAINT = 'integration_stock_prep_project_target_last_pull_outcome_check'
/** 087's closed enum, restored by down(). */
export const PULL_OUTCOMES_087 = Object.freeze(['applied', 'previewed', 'refused'] as const)
/** The enum up() installs: 087's three plus `failed`. */
export const PULL_OUTCOMES = Object.freeze(['applied', 'previewed', 'refused', 'failed'] as const)

export const FAILED_PULL_OUTCOME_DOWN_REFUSED_CODE = 'STOCK_PREP_PROJECT_TARGET_FAILED_OUTCOME_ROWS_PRESENT'

function outcomeList(outcomes: readonly string[]) {
  return sql.join(outcomes.map((outcome) => sql.lit(outcome)), sql`, `)
}

async function replaceOutcomeConstraint(db: Kysely<unknown>, outcomes: readonly string[]): Promise<void> {
  await sql`
    ALTER TABLE ${sql.table(PROJECT_TARGET_TABLE)}
      DROP CONSTRAINT IF EXISTS ${sql.ref(PULL_OUTCOME_CONSTRAINT)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(PROJECT_TARGET_TABLE)}
      ADD CONSTRAINT ${sql.ref(PULL_OUTCOME_CONSTRAINT)}
      CHECK (last_pull_outcome IS NULL OR last_pull_outcome IN (${outcomeList(outcomes)}))
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceOutcomeConstraint(db, PULL_OUTCOMES)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM ${sql.table(PROJECT_TARGET_TABLE)}
     WHERE last_pull_outcome = 'failed'
  `.execute(db)
  const failedRows = Number(result.rows[0]?.count ?? 0)
  if (failedRows > 0) {
    const error = new Error(
      `[zzzz20261015090000_admit_stock_prep_project_target_failed_pull_outcome] down() refused: ${failedRows} registry row(s) record a 'failed' pull outcome, which migration 087's constraint does not admit; the four-outcome constraint stays. Nothing was changed.`,
    )
    ;(error as Error & { code?: string }).code = FAILED_PULL_OUTCOME_DOWN_REFUSED_CODE
    throw error
  }
  await replaceOutcomeConstraint(db, PULL_OUTCOMES_087)
}
