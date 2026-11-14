/**
 * Migration: `meta_automation_job_leases` — the per-scope JOB LEASE of the `run_integration_job` automation
 * action (R-69 1b-ii; design baseline v2.3 §10.2.3 I-1..I-6 / §10.2.4; ADR adr-automation-pipeline-bridge-20261103
 * §3.4 Q5). R-69 is OPEN: this table is dormant until INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED is 'true'
 * (default OFF) and a rule carries the action; nothing on main writes or reads it before that.
 *
 * ONE ROW PER SCOPE (`scope_key` = 'stock_prep_pull:<tenantId>:<projectNo>' | 'pipeline:<pipelineId>'), and
 * ROWS ONLY GROW: a lease is CLAIMED by one single-statement UPSERT (`INSERT … ON CONFLICT (scope_key) DO
 * UPDATE … WHERE lease_expires_at <= now() RETURNING fence`), RENEWED by a heartbeat, and RELEASED by a
 * fence-CAS UPDATE that sets `lease_expires_at = now()` and `holder = NULL` — NEVER a DELETE (I-1, I-2). A row
 * that is never deleted is what makes `fence` truly monotonic: a timed-out zombie holder returning with its
 * old fence hits 0 rows and cannot touch its successor's lease (the same posture as
 * zzzz20260716140000_event_fires_lease.ts; `fence bigint` for the same 2^53 reason, read back as `::text`).
 *
 * The DB clock (`now()`) decides liveness so every process compares against the same time; the TTL is short
 * (120 s default, automation-job-lease.ts) and a heartbeat renews it — a dead holder is reclaimable within one
 * TTL, a slow live one is never reclaimed while its heartbeat runs.
 *
 * down(): REFUSES while any row exists (the fence history of a deployed scope is part of the single-writer
 * guarantee; a down that drops rows would let a later up() start every scope at fence 1 again). Precedent:
 * zzzz20261022150000_add_meta_sheets_grid_export_closure.ts down(). Values-free: the refusal carries a count only.
 */
import { sql, type Kysely } from 'kysely'

export const AUTOMATION_JOB_LEASES_TABLE = 'meta_automation_job_leases'
export const AUTOMATION_JOB_LEASES_DOWN_REFUSED_CODE = 'AUTOMATION_JOB_LEASES_DOWN_REFUSED'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_job_leases (
      scope_key text PRIMARY KEY
        CONSTRAINT automation_job_leases_scope_key_nonblank CHECK (scope_key ~ '[!-~]'),
      holder text,
      fence bigint NOT NULL DEFAULT 0
        CONSTRAINT automation_job_leases_fence_nonneg CHECK (fence >= 0),
      lease_expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM meta_automation_job_leases
  `.execute(db)
  const rows = Number(result.rows[0]?.count ?? 0)
  if (rows > 0) {
    const error = new Error(
      `[zzzz20261106111100_create_automation_job_leases] down() refused: ${rows} job-lease row(s) exist; dropping the table would reset every scope's fence history. Nothing was changed.`,
    )
    ;(error as Error & { code?: string }).code = AUTOMATION_JOB_LEASES_DOWN_REFUSED_CODE
    throw error
  }
  await sql`DROP TABLE IF EXISTS meta_automation_job_leases`.execute(db)
}
