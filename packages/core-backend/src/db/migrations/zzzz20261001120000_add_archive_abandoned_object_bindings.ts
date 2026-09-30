import { sql, type Kysely } from 'kysely'

const columns = `generation_id uuid NOT NULL, staging_object_id uuid NOT NULL,
  object_id text NOT NULL, provider_version text NOT NULL, ciphertext_sha256 text NOT NULL,
  size_bytes bigint NOT NULL, expires_at timestamptz NOT NULL, operation_id uuid NOT NULL,
  owner_kind text NOT NULL, owner_id text NOT NULL, owner_fence bigint NOT NULL,
  PRIMARY KEY(generation_id,staging_object_id), UNIQUE(generation_id,object_id), UNIQUE(operation_id),
  CHECK (object_id ~ '^[0-9a-f]{64}$' AND ciphertext_sha256 ~ '^[0-9a-f]{64}$'
    AND provider_version<>'' AND provider_version=btrim(provider_version)
    AND size_bytes>=0 AND isfinite(expires_at) AND owner_kind='archive_builder'
    AND owner_id<>'' AND owner_id=btrim(owner_id) AND owner_fence>=1),
  FOREIGN KEY(generation_id,staging_object_id)
    REFERENCES public.meta_recovery_archive_staging_objects(generation_id,staging_object_id) ON DELETE RESTRICT`

const guard = `
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_abandoned_binding_immutable';
  END IF;
  PERFORM 1 FROM public.meta_recovery_archives a
    JOIN public.meta_recovery_archive_staging_objects s ON s.generation_id=a.generation_id
    WHERE a.generation_id=NEW.generation_id AND s.staging_object_id=NEW.staging_object_id
      AND a.owner_kind=NEW.owner_kind AND a.owner_id=NEW.owner_id AND a.owner_fence=NEW.owner_fence
      AND a.state='building' AND a.build_status='active' AND a.coverage_status='incomplete'
      AND a.lease_expires_at>clock_timestamp() AND a.expires_at=NEW.expires_at
      AND s.object_state='pending' AND s.key_id=a.key_id
    FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_abandoned_binding_owner_refused';
  END IF;
  RETURN NEW;
END`

async function audit(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`CREATE TEMP TABLE tm_abandoned_binding_expected (${columns.split(",\n  FOREIGN KEY")[0]}) ON COMMIT DROP`).execute(db)
  const result = await sql<{ valid: boolean }>`WITH tables AS (
    SELECT 'public.meta_recovery_archive_abandoned_bindings'::regclass AS live,
      'pg_temp.tm_abandoned_binding_expected'::regclass AS expected
  ), columns AS (
    SELECT a.attrelid,jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) AS shape
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum,tables t
    WHERE a.attrelid IN (t.live,t.expected) AND a.attnum>0 AND NOT a.attisdropped GROUP BY a.attrelid
  ), constraints AS (
    SELECT conrelid,jsonb_agg(jsonb_build_array(contype,convalidated,condeferrable,condeferred,
      pg_get_constraintdef(oid)) ORDER BY contype,pg_get_constraintdef(oid)) AS shape
    FROM pg_constraint,tables t WHERE conrelid IN (t.live,t.expected) AND contype<>'f' GROUP BY conrelid
  ) SELECT
    (SELECT relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity
      FROM pg_class WHERE oid=t.live)
    AND (SELECT shape FROM columns WHERE attrelid=t.live)=(SELECT shape FROM columns WHERE attrelid=t.expected)
    AND (SELECT shape FROM constraints WHERE conrelid=t.live)=(SELECT shape FROM constraints WHERE conrelid=t.expected)
    AND (SELECT count(*)=1 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred
      AND conkey=ARRAY[1,2]::smallint[] AND confrelid='public.meta_recovery_archive_staging_objects'::regclass
      AND confkey=ARRAY[1,2]::smallint[] AND confdeltype='r' AND confupdtype='a' AND confmatchtype='s')
      FROM pg_constraint WHERE conrelid=t.live AND contype='f')
    AND (SELECT count(*)=2 AND bool_and(tgenabled='O' AND NOT tgisinternal AND tgconstraint=0 AND NOT tgdeferrable AND NOT tginitdeferred
      AND ((tgname='trg_meta_recovery_archive_abandoned_binding_guard' AND tgtype=31)
        OR (tgname='trg_meta_recovery_archive_abandoned_binding_truncate_guard' AND tgtype=34))
      AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
      AND tgfoid='public.meta_recovery_archive_abandoned_binding_guard()'::regprocedure)
      FROM pg_trigger WHERE tgrelid=t.live AND NOT tgisinternal)
    AND (SELECT prosrc=${guard} AND NOT prosecdef AND provolatile='v' AND prorettype='trigger'::regtype
      AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND proconfig=ARRAY['search_path=pg_catalog, public']
      FROM pg_proc WHERE oid='public.meta_recovery_archive_abandoned_binding_guard()'::regprocedure)
    AS valid FROM tables t`.execute(db)
  await sql`DROP TABLE tm_abandoned_binding_expected`.execute(db)
  if (result.rows[0]?.valid !== true) throw new Error('archive_abandoned_binding_schema_mismatch')
}

/** Additive, inert pre-upload bindings. Production runner owns the enclosing transaction. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ present: boolean }>`SELECT
    to_regclass('public.meta_recovery_archive_abandoned_bindings') IS NOT NULL AS present`.execute(db)
  if (!result.rows[0]?.present) {
    await sql.raw(`CREATE TABLE public.meta_recovery_archive_abandoned_bindings (${columns})`).execute(db)
    await sql.raw(`CREATE FUNCTION public.meta_recovery_archive_abandoned_binding_guard()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, public AS $guard$${guard}$guard$`).execute(db)
    await sql`CREATE TRIGGER trg_meta_recovery_archive_abandoned_binding_guard
      BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_abandoned_bindings
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_abandoned_binding_guard()`.execute(db)
    await sql`CREATE TRIGGER trg_meta_recovery_archive_abandoned_binding_truncate_guard
      BEFORE TRUNCATE ON public.meta_recovery_archive_abandoned_bindings
      FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_abandoned_binding_guard()`.execute(db)
  }
  await audit(db)
}

/** Empty development rollback only; durable inventory is never force-dropped. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const surface = await sql<{ present: boolean }>`SELECT
    to_regclass('public.meta_recovery_archive_abandoned_bindings') IS NOT NULL AS present`.execute(db)
  if (!surface.rows[0]?.present) return
  await sql`LOCK TABLE public.meta_recovery_archive_abandoned_bindings IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result = await sql<{ present: boolean }>`SELECT EXISTS(
    SELECT 1 FROM public.meta_recovery_archive_abandoned_bindings LIMIT 1) AS present`.execute(db)
  if (result.rows[0]?.present) throw new Error('archive_abandoned_binding_nonempty')
  await sql`DROP TABLE public.meta_recovery_archive_abandoned_bindings`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_abandoned_binding_guard()`.execute(db)
}
