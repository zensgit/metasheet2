import { sql, type Kysely } from 'kysely'

const table = 'public.meta_recovery_archive_nonce_reservations'
const oldCheck = 'chk_meta_recovery_archive_nonce_reservation_section_name'
const newCheck = 'chk_meta_recovery_archive_nonce_reservation_object_name'
const sections = "'schema','records','links','field_value_tombstones','link_tombstones','auto_number','attachments_index','permission_evidence','views_config','coverage_index'"
const attachmentPattern = '^attachment:[0-9a-f]{64}$'
const drift = 'RECOVERY_ARCHIVE_NONCE_OBJECT_SCHEMA_DRIFT'
const reserveBody = `DECLARE inserted_count integer;
  BEGIN
    INSERT INTO public.meta_recovery_archive_nonce_reservations (
      dek_fingerprint, nonce, generation_id, section_name, aead_algorithm, format_version
    ) VALUES (p_dek_fingerprint,p_nonce,p_generation_id,p_section_name,p_aead_algorithm,p_format_version)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count = 0 THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_nonce_reservation_conflict';
    END IF;
  END`
const truncateBody = `BEGIN RAISE EXCEPTION USING
  ERRCODE = '55000', MESSAGE = 'recovery_archive_nonce_reservation_immutable'; END`

function canonicalBody(body: string): string {
  return (body.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map((part) =>
    part.startsWith("'") ? part : part.replace(/\s/g, '')).join('')
}

function guard(extended: boolean): string {
  return `BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_nonce_reservation_immutable';
    END IF;
    IF NEW.dek_fingerprint IS NULL OR NEW.dek_fingerprint !~ '^[0-9a-f]{64}$'
      OR NEW.nonce IS NULL OR NEW.nonce !~ '^[0-9a-f]{24}$'
      OR NEW.generation_id IS NULL OR NEW.section_name IS NULL
      OR ${extended ? '(' : ''}NEW.section_name NOT IN (${sections})${extended ? ` AND NEW.section_name !~ '${attachmentPattern}')` : ''}
      OR NEW.aead_algorithm IS NULL OR NEW.aead_algorithm NOT IN ('aes-256-gcm')
      OR NEW.format_version IS NULL OR NEW.format_version <> 1 OR NEW.created_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'recovery_archive_nonce_reservation_shape_invalid';
    END IF;
    RETURN NEW;
  END`
}

async function audit(db: Kysely<unknown>, extended: boolean): Promise<void> {
  // Ask PostgreSQL to canonicalize the expected CHECK, rather than matching DDL text fragments.
  await sql.raw(`CREATE TEMP TABLE tm_nonce_object_expected (
    section_name text CHECK (section_name IN (${sections})${extended ? ` OR section_name ~ '${attachmentPattern}'` : ''})
  ) ON COMMIT DROP`).execute(db)
  const checks = await sql<{ valid: boolean }>`SELECT count(*)=1 AND bool_and(
      actual.convalidated AND NOT actual.condeferrable AND NOT actual.condeferred
      AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)) AS valid
    FROM pg_constraint actual CROSS JOIN pg_constraint expected
    WHERE actual.conrelid=${table}::regclass AND actual.conname=${extended ? newCheck : oldCheck}
      AND expected.conrelid='pg_temp.tm_nonce_object_expected'::regclass`.execute(db)
  const coexist = await sql`SELECT 1 FROM pg_constraint WHERE conrelid=${table}::regclass
    AND conname=${extended ? oldCheck : newCheck}`.execute(db)
  await sql`DROP TABLE pg_temp.tm_nonce_object_expected`.execute(db)
  const functions = await sql<{ body: string; valid: boolean }>`SELECT p.prosrc AS body,
      l.lanname='plpgsql' AND p.prorettype='trigger'::regtype AND NOT p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[] AS valid
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='public.meta_recovery_archive_nonce_reservation_guard_row()'::regprocedure`.execute(db)
  const uniqueness = await sql<{ valid: boolean }>`SELECT count(*)=2 AND bool_and(
      NOT c.condeferrable AND NOT c.condeferred AND c.convalidated AND i.indisvalid
      AND i.indisunique AND i.indimmediate AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.n)
        FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
        = CASE WHEN c.contype='p' THEN ARRAY['dek_fingerprint','nonce']
          ELSE ARRAY['generation_id','section_name'] END) AS valid
    FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
    WHERE c.conrelid=${table}::regclass AND c.contype IN ('p','u')`.execute(db)
  const trigger = await sql<{ valid: boolean }>`SELECT count(*)=1 AND bool_and(tgenabled='O'
      AND tgtype=31 AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
      AND tgfoid='public.meta_recovery_archive_nonce_reservation_guard_row()'::regprocedure) AS valid
    FROM pg_trigger WHERE tgrelid=${table}::regclass
      AND tgname='trg_meta_recovery_archive_nonce_reservation_guard_row'`.execute(db)
  const truncateTrigger = await sql<{ valid: boolean }>`SELECT count(*)=1 AND bool_and(tgenabled='O'
      AND tgtype=34 AND tgqual IS NULL AND tgnargs=0
      AND tgfoid='public.meta_recovery_archive_nonce_reservation_guard_truncate()'::regprocedure) AS valid
    FROM pg_trigger WHERE tgrelid=${table}::regclass
      AND tgname='trg_meta_recovery_archive_nonce_reservation_guard_truncate'`.execute(db)
  for (const expected of [
    { signature: 'public.meta_recovery_archive_reserve_nonce(text,text,uuid,text,text,integer)', body: reserveBody, returns: 'void' },
    { signature: 'public.meta_recovery_archive_nonce_reservation_guard_truncate()', body: truncateBody, returns: 'trigger' },
  ]) {
    const result = await sql<{ body: string; valid: boolean }>`SELECT p.prosrc AS body,
        l.lanname='plpgsql' AND p.prorettype=${expected.returns}::regtype AND NOT p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[] AS valid
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=${expected.signature}::regprocedure`.execute(db)
    if (result.rows.length !== 1 || result.rows[0]?.valid !== true
      || canonicalBody(result.rows[0].body) !== canonicalBody(expected.body)) throw new Error(drift)
  }
  if (coexist.rows.length || checks.rows[0]?.valid !== true || uniqueness.rows[0]?.valid !== true || trigger.rows[0]?.valid !== true
    || truncateTrigger.rows[0]?.valid !== true
    || functions.rows.length !== 1 || functions.rows[0]?.valid !== true
    || canonicalBody(functions.rows[0].body) !== canonicalBody(guard(extended))) throw new Error(drift)
}

async function change(db: Kysely<unknown>, extended: boolean): Promise<void> {
  await sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${extended ? oldCheck : newCheck},
    ADD CONSTRAINT ${extended ? newCheck : oldCheck} CHECK (section_name IN (${sections})${extended ? ` OR section_name ~ '${attachmentPattern}'` : ''})`).execute(db)
  await sql.raw(`CREATE OR REPLACE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_row()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$${guard(extended)}$$`).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`).execute(db)
  const exists = await sql`SELECT 1 FROM pg_constraint WHERE conrelid=${table}::regclass AND conname=${newCheck}`.execute(db)
  await audit(db, exists.rows.length > 0)
  if (!exists.rows.length) await change(db, true)
  await audit(db, true)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`).execute(db)
  const exists = await sql`SELECT 1 FROM pg_constraint WHERE conrelid=${table}::regclass AND conname=${newCheck}`.execute(db)
  await audit(db, exists.rows.length > 0)
  if (!exists.rows.length) return
  const used = await sql`SELECT 1 FROM public.meta_recovery_archive_nonce_reservations
    WHERE section_name LIKE 'attachment:%' LIMIT 1`.execute(db)
  if (used.rows.length) throw new Error('RECOVERY_ARCHIVE_NONCE_OBJECT_DOWN_IN_USE')
  await change(db, false)
  await audit(db, false)
}
