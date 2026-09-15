import { sql, type Kysely } from 'kysely'

const TABLE = 'meta_recovery_archive_derived_effects'
const DRIFT = 'RECOVERY_ARCHIVE_DERIVED_EFFECTS_SCHEMA_DRIFT'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS public.meta_recovery_archive_derived_effects (
    revision_id uuid PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES public.meta_recovery_archive_jobs(id) ON DELETE RESTRICT,
    record_id text NOT NULL,
    field_ids text[] NOT NULL,
    link_invalidations jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_attempt_at timestamptz,
    completed_at timestamptz
  )`.execute(db)
  const columns = await sql<{ name: string; type: string; required: boolean; expression: string | null }>`
    SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
           a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid='public.meta_recovery_archive_derived_effects'::regclass
       AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum
  `.execute(db)
  const expected = [
    ['revision_id', 'uuid', true, null], ['job_id', 'uuid', true, null],
    ['record_id', 'text', true, null], ['field_ids', 'text[]', true, null],
    ['link_invalidations', 'jsonb', true, null], ['created_at', 'timestamp with time zone', true, 'now()'],
    ['last_attempt_at', 'timestamp with time zone', false, null], ['completed_at', 'timestamp with time zone', false, null],
  ]
  if (JSON.stringify(columns.rows.map(c => [c.name, c.type, c.required, c.expression])) !== JSON.stringify(expected)) throw new Error(DRIFT)
  const constraints = await sql<{ definition: string; deferrable: boolean; deferred: boolean; validated: boolean }>`
    SELECT pg_get_constraintdef(oid) AS definition, condeferrable AS deferrable,
           condeferred AS deferred, convalidated AS validated
      FROM pg_catalog.pg_constraint WHERE conrelid='public.meta_recovery_archive_derived_effects'::regclass
      ORDER BY contype
  `.execute(db)
  const definitions = constraints.rows.map(c => c.definition.replace('public.meta_recovery_archive_jobs', 'meta_recovery_archive_jobs'))
  if (constraints.rows.some(c => c.deferrable || c.deferred || !c.validated) ||
    JSON.stringify(definitions) !== JSON.stringify([
      'FOREIGN KEY (job_id) REFERENCES meta_recovery_archive_jobs(id) ON DELETE RESTRICT',
      'PRIMARY KEY (revision_id)',
    ])) throw new Error(DRIFT)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ present: string | null }>`SELECT to_regclass('public.meta_recovery_archive_derived_effects')::text AS present`.execute(db)
  if (!present.rows[0]?.present) return
  await sql.raw(`LOCK TABLE public.${TABLE} IN ACCESS EXCLUSIVE MODE`).execute(db)
  const rows = await sql`SELECT 1 FROM public.meta_recovery_archive_derived_effects LIMIT 1`.execute(db)
  if (rows.rows.length) throw new Error('RECOVERY_ARCHIVE_DERIVED_EFFECTS_DOWN_IN_USE')
  await sql`DROP TABLE public.meta_recovery_archive_derived_effects`.execute(db)
}
