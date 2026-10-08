import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { createHash } from 'node:crypto'

const TABLE = 'attendance_report_projection_anchors'
const IMMUTABLE_GUARD = 'attendance_report_projection_anchor_identity_guard'

// Pin semantic catalog data rather than database-local OIDs or object names.
async function schemaFingerprint(db: Kysely<unknown>): Promise<string> {
  const result = await sql<{ shape: Record<string, unknown> }>`
    SELECT jsonb_build_object(
      'relation', (SELECT jsonb_build_array(relkind, relpersistence, relrowsecurity, relforcerowsecurity)
        FROM pg_class WHERE oid = to_regclass(${TABLE})),
      'columns', (SELECT jsonb_agg(jsonb_build_array(a.attname,
          format_type(a.atttypid, a.atttypmod), a.attnotnull,
          pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated,
          (SELECT jsonb_build_array(n.nspname, c.collname, c.collprovider, c.collisdeterministic)
            FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE c.oid = a.attcollation)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass(${TABLE}) AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(jsonb_build_array(contype, convalidated,
          condeferrable, condeferred, pg_get_constraintdef(oid, false))
          ORDER BY contype, pg_get_constraintdef(oid, false))
        FROM pg_constraint WHERE conrelid = to_regclass(${TABLE})),
      'indexes', (SELECT jsonb_agg(jsonb_build_array(indisunique, indisprimary,
          indisvalid, indisready, indkey::text, indoption::text,
          pg_get_expr(indexprs, indrelid), pg_get_expr(indpred, indrelid),
          (SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = indexrelid),
          (SELECT jsonb_agg(jsonb_build_array(n.nspname, o.opcname) ORDER BY x.ordinality)
            FROM unnest(indclass) WITH ORDINALITY x(oid, ordinality)
            JOIN pg_opclass o ON o.oid = x.oid JOIN pg_namespace n ON n.oid = o.opcnamespace),
          (SELECT jsonb_agg(jsonb_build_array(n.nspname, c.collname, c.collprovider, c.collisdeterministic) ORDER BY x.ordinality)
            FROM unnest(indcollation) WITH ORDINALITY x(oid, ordinality)
            LEFT JOIN pg_collation c ON c.oid = x.oid LEFT JOIN pg_namespace n ON n.oid = c.collnamespace))
          ORDER BY indisprimary, indkey::text)
        FROM pg_index WHERE indrelid = to_regclass(${TABLE})),
      'triggers', (SELECT jsonb_agg(jsonb_build_array(t.tgname, t.tgtype, t.tgenabled,
          t.tgattr::text, encode(t.tgargs, 'hex'), pg_get_expr(t.tgqual, t.tgrelid),
          p.proname, n.nspname, p.prosrc, p.prosecdef, p.provolatile, p.proconfig, l.lanname,
          pg_get_function_identity_arguments(p.oid), p.prorettype::regtype::text)
          ORDER BY t.tgname)
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_language l ON l.oid = p.prolang
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE t.tgrelid = to_regclass(${TABLE}) AND NOT t.tgisinternal)
    ) AS shape
  `.execute(db)
  const shape = result.rows[0]?.shape
  // Constraint rows form a set; database-locale ordering is not schema semantics.
  // Compare complete bytes, never normalize literals or internal column ordering.
  if (Array.isArray(shape?.constraints)) {
    shape.constraints = [...shape.constraints].sort((left, right) => {
      const a = JSON.stringify(left)
      const b = JSON.stringify(right)
      return a < b ? -1 : a > b ? 1 : 0
    })
  }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

async function assertSchema(db: Kysely<unknown>): Promise<void> {
  if (await schemaFingerprint(db) !== '6f02326815187f905ff1b7429a2b8442e0c6090ed28fc68dd6397b8fa57cfd3e') {
    throw new Error('ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT')
  }
}

async function inTransaction(db: Kysely<unknown>, action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  if (db.isTransaction) return action(db)
  await db.transaction().execute(action)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, createOrVerify)
}

async function createOrVerify(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ present: boolean }>`SELECT to_regclass(${TABLE}) IS NOT NULL AS present`.execute(db)
  if (present.rows[0]?.present) {
    await sql`LOCK TABLE ${sql.table(TABLE)} IN ACCESS EXCLUSIVE MODE`.execute(db)
    await assertSchema(db)
    return
  }
  const functionPresent = await sql<{ present: boolean }>`SELECT to_regprocedure(${IMMUTABLE_GUARD + '()'}) IS NOT NULL AS present`.execute(db)
  if (functionPresent.rows[0]?.present) throw new Error('ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT')
  await sql`
    CREATE TABLE attendance_report_projection_anchors (
      projection_record_id text PRIMARY KEY
        CHECK (projection_record_id = btrim(projection_record_id) AND projection_record_id <> '')
        REFERENCES meta_records(id) ON DELETE CASCADE ON UPDATE RESTRICT,
      org_id text NOT NULL CHECK (org_id = btrim(org_id) AND org_id <> ''),
      canonical_record_id uuid NOT NULL,
      source_selector text NOT NULL
        CHECK (source_selector IN ('current_calculation', 'latest_completed_calculation')),
      source_calculation_id uuid NOT NULL,
      source_calculation_version integer NOT NULL CHECK (source_calculation_version >= 1),
      canonical_source_digest char(64) NOT NULL
        CHECK (canonical_source_digest ~ '^[0-9a-f]{64}$'),
      source_fingerprint char(40) NOT NULL
        CHECK (source_fingerprint ~ '^[0-9a-f]{40}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_attendance_report_projection_anchor_canonical
        UNIQUE (org_id, canonical_record_id),
      CONSTRAINT fk_attendance_report_projection_anchor_record
        FOREIGN KEY (canonical_record_id, org_id)
        REFERENCES attendance_records(id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_attendance_report_projection_anchor_calculation
        FOREIGN KEY (source_calculation_id, canonical_record_id, org_id)
        REFERENCES attendance_record_calculations(id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION ${sql.raw(IMMUTABLE_GUARD)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.projection_record_id IS DISTINCT FROM OLD.projection_record_id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.canonical_record_id IS DISTINCT FROM OLD.canonical_record_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ATTENDANCE_CLEANING_ANCHOR_IDENTITY_IMMUTABLE';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_attendance_report_projection_anchor_identity ON ${sql.table(TABLE)}`.execute(db)
  await sql`
    CREATE TRIGGER trg_attendance_report_projection_anchor_identity
      BEFORE UPDATE ON ${sql.table(TABLE)}
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(IMMUTABLE_GUARD)}()
  `.execute(db)
  await assertSchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await inTransaction(db, dropEmpty)
}

async function dropEmpty(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ present: boolean }>`SELECT to_regclass(${TABLE}) IS NOT NULL AS present`.execute(db)
  if (!present.rows[0]?.present) return
  await sql`LOCK TABLE ${sql.table(TABLE)} IN ACCESS EXCLUSIVE MODE`.execute(db)
  const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(TABLE)}`.execute(db)
  if (count.rows[0]?.count !== '0') throw new Error('ATTENDANCE_CLEANING_ANCHOR_DOWN_IN_USE')
  await sql`DROP TRIGGER IF EXISTS trg_attendance_report_projection_anchor_identity ON ${sql.table(TABLE)}`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(IMMUTABLE_GUARD)}()`.execute(db)
  await sql`DROP TABLE ${sql.table(TABLE)}`.execute(db)
}
