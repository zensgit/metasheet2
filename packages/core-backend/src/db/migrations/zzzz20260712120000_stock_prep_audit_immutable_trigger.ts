/**
 * Migration: DB-layer immutability backstop for `integration_stock_prep_audit` (migration 066).
 *
 * Stock-prep T5 (#3751 follow-up). Today the append-only guarantee on the stock-prep audit trail is
 * enforced ONLY in the application layer (lib/stock-preparation-audit-store.cjs exposes `append` +
 * `list`, never an update/delete surface). Any OTHER write path (a one-off script, a future
 * maintenance job, a bug) can still `UPDATE`/`DELETE` rows directly against Postgres — nothing at the
 * DB layer stops it.
 *
 * Mechanism choice — REVOKE was considered and REJECTED as a no-op here (would be a FAKE backstop):
 *   - `packages/core-backend/src/integration/db/connection-pool.ts` builds ONE `pg.Pool` from a single
 *     `DATABASE_URL` (`PoolManager` constructor) and `src/db/db.ts` hands that SAME pool to the Kysely
 *     migrator (`src/db/migrate.ts` — `db` import) AND to app runtime queries. There is no separate
 *     migration-role vs. app-role split anywhere in this repo's migrations.
 *   - Concretely: `docker-compose.dev.yml` sets `POSTGRES_USER=metasheet` for BOTH the DB and
 *     `DATABASE_URL`; `.github/workflows/plugin-tests.yml` uses `postgresql://postgres@localhost/...`
 *     for both. Whichever role executes `066_create_integration_stock_prep_audit.sql`'s
 *     `CREATE TABLE` becomes the table OWNER — and that is the exact same role the app queries with.
 *   - Empirically verified against a throwaway `postgres:16-alpine` container: connected AS the owner
 *     role, `REVOKE UPDATE, DELETE ON integration_stock_prep_audit FROM <owner>` executes without
 *     error, and a subsequent `UPDATE`/`DELETE` by that same role STILL SUCCEEDS — owners always retain
 *     their implicit privileges; `REVOKE` cannot take them away. A `REVOKE`-based "backstop" would look
 *     like a control while doing nothing (the exact anti-pattern flagged post-#4126).
 *   - A `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION` trigger has NO such exemption: Postgres runs
 *     row-level triggers for every role, INCLUDING the table owner and superusers (unlike
 *     `REVOKE`/GRANT privilege checks and unlike default RLS, which superusers/owners bypass). This
 *     was also verified against the same throwaway container (including with the connecting role
 *     granted SUPERUSER, matching CI's `postgres` role) — the trigger rejected both UPDATE and DELETE
 *     while INSERT (the store's only write path) remained completely unaffected.
 *
 * Scope: `integration_stock_prep_audit` ONLY. Does not touch any of the 9 stock-prep logical sheets,
 * does not touch http-routes.cjs, does not touch external writes. Pure DDL; idempotent
 * (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`).
 *
 * zzzz-named (runs after every 0xx SQL migration, including 066) per the zzzz-ordering house rule —
 * this migration operates on a table that must already exist.
 */
import { sql, type Kysely } from 'kysely'

export const AUDIT_TABLE = 'integration_stock_prep_audit'
export const DENY_FN = 'integration_stock_prep_audit_deny_mutation'
export const DENY_TRIGGER = 'trg_integration_stock_prep_audit_deny_mutation'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(DENY_FN)}()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'integration_stock_prep_audit is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS ${sql.raw(DENY_TRIGGER)} ON ${sql.raw(AUDIT_TABLE)}`.execute(db)

  await sql`
    CREATE TRIGGER ${sql.raw(DENY_TRIGGER)}
      BEFORE UPDATE OR DELETE ON ${sql.raw(AUDIT_TABLE)}
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(DENY_FN)}()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS ${sql.raw(DENY_TRIGGER)} ON ${sql.raw(AUDIT_TABLE)}`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(DENY_FN)}()`.execute(db)
}
