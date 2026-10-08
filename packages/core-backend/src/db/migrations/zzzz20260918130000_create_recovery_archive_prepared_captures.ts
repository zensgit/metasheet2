import { sql, type Kysely } from 'kysely'

const columns = `generation_id uuid PRIMARY KEY,
    owner_kind text NOT NULL, owner_id text NOT NULL, owner_fence bigint NOT NULL,
    source_vector_hash text NOT NULL, payload bytea NOT NULL,
    payload_sha256 text GENERATED ALWAYS AS (encode(sha256(payload),'hex')) STORED NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_mrapc_shape CHECK (
      owner_kind<>'' AND owner_id<>'' AND owner_fence>=1
      AND source_vector_hash ~ '^[0-9a-f]{64}$' AND octet_length(payload)>0
    )`

const guard = `
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='recovery_archive_prepared_capture_immutable';
  END IF;
  PERFORM 1 FROM public.meta_recovery_archives
    WHERE generation_id=NEW.generation_id AND owner_kind=NEW.owner_kind
      AND owner_id=NEW.owner_id AND owner_fence=NEW.owner_fence
      AND source_vector_hash=NEW.source_vector_hash
      AND state='building' AND build_status='active' AND coverage_status='incomplete'
      AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='recovery_archive_prepared_capture_owner_unavailable';
  END IF;
  RETURN NEW;
END`

async function audit(db: Kysely<unknown>): Promise<void> {
  // PostgreSQL canonicalizes defaults/generated expressions and the CHECK itself.
  // The reference is built from authored DDL, never from the live table.
  await sql.raw(`CREATE TEMP TABLE tm_mrapc_expected (${columns}) ON COMMIT DROP`).execute(db)
  const result = await sql<{ valid: boolean }>`SELECT
    (SELECT relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity
      FROM pg_class WHERE oid='public.meta_recovery_archive_prepared_captures'::regclass)
    AND
    (SELECT count(*)=8 AND bool_and(attnotnull) FROM pg_attribute
      WHERE attrelid='public.meta_recovery_archive_prepared_captures'::regclass
        AND attnum>0 AND NOT attisdropped)
    AND (SELECT prosrc=${guard} AND NOT prosecdef AND provolatile='v'
      AND prorettype='trigger'::regtype AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND proconfig=ARRAY['search_path=pg_catalog, public']
      FROM pg_proc WHERE oid='public.meta_recovery_archive_prepared_capture_guard()'::regprocedure)
    AND (SELECT count(*)=2 AND bool_and(tgenabled='O' AND NOT tgisinternal
        AND tgfoid='public.meta_recovery_archive_prepared_capture_guard()'::regprocedure
        AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
        AND ((tgname='trg_mrapc_row' AND tgtype=31) OR (tgname='trg_mrapc_truncate' AND tgtype=34)))
      FROM pg_trigger WHERE tgrelid='public.meta_recovery_archive_prepared_captures'::regclass
        AND NOT tgisinternal)
    AND (SELECT count(*)=3 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred)
      FROM pg_constraint WHERE conrelid='public.meta_recovery_archive_prepared_captures'::regclass)
    AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.meta_recovery_archive_prepared_captures'::regclass
        AND a.attnum>0 AND NOT a.attisdropped)
      = (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='pg_temp.tm_mrapc_expected'::regclass AND a.attnum>0 AND NOT a.attisdropped)
    AND (SELECT pg_get_expr(conbin,conrelid) FROM pg_constraint
      WHERE conrelid='public.meta_recovery_archive_prepared_captures'::regclass AND contype='c')
      = (SELECT pg_get_expr(conbin,conrelid) FROM pg_constraint
      WHERE conrelid='pg_temp.tm_mrapc_expected'::regclass AND contype='c')
    AND EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.meta_recovery_archive_prepared_captures'::regclass AND contype='p' AND conkey=ARRAY[1]::smallint[])
    AND EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.meta_recovery_archive_prepared_captures'::regclass AND contype='f'
        AND conkey=ARRAY[1]::smallint[] AND confrelid='public.meta_recovery_archives'::regclass
        AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.meta_recovery_archives'::regclass AND attname='generation_id')]
        AND confdeltype='r' AND confupdtype='a' AND confmatchtype='s')
    AS valid`.execute(db)
  await sql`DROP TABLE pg_temp.tm_mrapc_expected`.execute(db)
  if (result.rows[0]?.valid !== true) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_SCHEMA_DRIFT')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ present: boolean }>`SELECT to_regclass('public.meta_recovery_archive_prepared_captures') IS NOT NULL AS present`.execute(db)
  if (exists.rows[0]?.present) return audit(db)
  await sql.raw(`CREATE TABLE public.meta_recovery_archive_prepared_captures (${columns},
    FOREIGN KEY(generation_id) REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT)`).execute(db)
  await sql.raw(`CREATE FUNCTION public.meta_recovery_archive_prepared_capture_guard()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$${guard}$guard$`).execute(db)
  await sql.raw(`CREATE TRIGGER trg_mrapc_row BEFORE INSERT OR UPDATE OR DELETE
    ON public.meta_recovery_archive_prepared_captures FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archive_prepared_capture_guard();
    CREATE TRIGGER trg_mrapc_truncate BEFORE TRUNCATE
    ON public.meta_recovery_archive_prepared_captures FOR EACH STATEMENT
    EXECUTE FUNCTION public.meta_recovery_archive_prepared_capture_guard()`).execute(db)
  await audit(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ present: boolean }>`SELECT to_regclass('public.meta_recovery_archive_prepared_captures') IS NOT NULL AS present`.execute(db)
  if (!exists.rows[0]?.present) return
  await audit(db)
  await sql`LOCK TABLE public.meta_recovery_archive_prepared_captures IN ACCESS EXCLUSIVE MODE`.execute(db)
  const used = await sql<{ used: boolean }>`SELECT EXISTS (SELECT 1 FROM public.meta_recovery_archive_prepared_captures) AS used`.execute(db)
  if (used.rows[0]?.used) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_DOWN_IN_USE')
  await sql`DROP TABLE public.meta_recovery_archive_prepared_captures`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_prepared_capture_guard()`.execute(db)
}
