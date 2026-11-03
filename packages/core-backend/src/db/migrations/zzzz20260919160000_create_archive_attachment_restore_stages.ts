import { sql, type Kysely } from 'kysely'

const columns = `actor_id uuid NOT NULL, token_hash text NOT NULL, attachment_id text NOT NULL,
  generation_id uuid NOT NULL, workspace_id text NOT NULL, base_id text NOT NULL,
  sheet_id text NOT NULL, record_id text NOT NULL, field_id text NOT NULL,
  source_version text NOT NULL, plaintext_sha256 text NOT NULL, size_bytes bigint NOT NULL,
  object_id uuid NOT NULL, state text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
  applied_operation_id uuid, applied_at timestamptz,
  displaced_storage_file_id text, displaced_storage_path text,
  token_expires_at timestamptz NOT NULL, abandoned_at timestamptz, cleaned_at timestamptz,
  PRIMARY KEY(actor_id,token_hash,attachment_id), UNIQUE(object_id),
  CHECK (token_hash ~ '^[0-9a-f]{64}$' AND plaintext_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes>=0
    AND attachment_id<>'' AND attachment_id=btrim(attachment_id)
    AND workspace_id<>'' AND workspace_id=btrim(workspace_id)
    AND base_id<>'' AND base_id=btrim(base_id) AND sheet_id<>'' AND sheet_id=btrim(sheet_id)
    AND record_id<>'' AND record_id=btrim(record_id) AND field_id<>'' AND field_id=btrim(field_id)
    AND source_version<>'' AND source_version=btrim(source_version)),
  CHECK (isfinite(token_expires_at) AND token_expires_at>created_at),
  CHECK ((((state='reserved' AND verified_at IS NULL) OR (state='verified' AND verified_at IS NOT NULL))
    AND abandoned_at IS NULL AND cleaned_at IS NULL
    OR state='abandoned' AND abandoned_at IS NOT NULL AND cleaned_at IS NULL
    OR state='cleaned' AND abandoned_at IS NOT NULL AND cleaned_at IS NOT NULL)
    AND applied_operation_id IS NULL AND applied_at IS NULL
    AND displaced_storage_file_id IS NULL AND displaced_storage_path IS NULL
    OR state='applied' AND verified_at IS NOT NULL AND applied_operation_id IS NOT NULL AND applied_at IS NOT NULL
    AND abandoned_at IS NULL AND cleaned_at IS NULL
    AND displaced_storage_file_id IS NOT NULL AND displaced_storage_file_id<>''
    AND displaced_storage_path IS NOT NULL AND displaced_storage_path<>''
    AND displaced_storage_file_id<>object_id::text
    AND displaced_storage_path<>(object_id::text||'/sha256-'||plaintext_sha256))`

const guard = `
BEGIN
  IF TG_WHEN='AFTER' THEN
    IF NEW.state='applied' THEN
      PERFORM 1 FROM public.meta_recovery_archive_sync_receipts r
        JOIN public.meta_recovery_token_burns b ON b.token_sha256=r.token_sha256
        JOIN public.multitable_attachments a ON a.id=NEW.attachment_id
        JOIN public.meta_records record ON record.id=NEW.record_id AND record.sheet_id=NEW.sheet_id
        WHERE r.token_sha256=NEW.token_hash AND r.sheet_id=NEW.sheet_id
          AND r.operation_id=NEW.applied_operation_id AND r.archive_generation_id=NEW.generation_id
          AND b.actor_id=NEW.actor_id::text AND b.sheet_id=NEW.sheet_id AND b.burn_kind='sync'
          AND b.sync_operation_id=NEW.applied_operation_id AND b.archive_generation_id=NEW.generation_id
          AND a.sheet_id=NEW.sheet_id AND a.record_id=NEW.record_id AND a.field_id=NEW.field_id
          AND a.storage_file_id=NEW.object_id::text
          AND a.storage_path=NEW.object_id::text||'/sha256-'||NEW.plaintext_sha256
          AND a.deleted_at IS NULL AND a.blob_purged_at IS NULL AND a.blob_purge_claimed_at IS NULL
          AND (record.data->NEW.field_id) @> jsonb_build_array(NEW.attachment_id);
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_apply_receipt_missing';
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_stage_immutable';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'reserved' OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_stage_transition';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','verified_at','applied_operation_id','applied_at','displaced_storage_file_id','displaced_storage_path','abandoned_at','cleaned_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','verified_at','applied_operation_id','applied_at','displaced_storage_file_id','displaced_storage_path','abandoned_at','cleaned_at'])
      OR NOT ((OLD.state='reserved' AND NEW.state='verified' AND NEW.verified_at IS NOT NULL)
        OR (OLD.state='verified' AND NEW.state='applied' AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at)
        OR (OLD.state IN ('reserved','verified') AND NEW.state='abandoned'
          AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at)
        OR (OLD.state='abandoned' AND NEW.state='cleaned'
          AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
          AND NEW.abandoned_at IS NOT DISTINCT FROM OLD.abandoned_at)) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_stage_transition';
    END IF;
  END IF;
  IF NEW.state IN ('abandoned','cleaned') THEN
    IF NEW.token_expires_at>clock_timestamp() OR EXISTS (
      SELECT 1 FROM public.multitable_attachments a WHERE a.storage_file_id=NEW.object_id::text
        OR a.storage_path=NEW.object_id::text||'/sha256-'||NEW.plaintext_sha256
    ) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_cleanup_refused';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.token_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_token_expired';
  END IF;
  IF TG_OP='UPDATE' AND NEW.state='applied' THEN
    PERFORM 1 FROM public.multitable_attachments a
      WHERE a.id=NEW.attachment_id AND a.sheet_id=NEW.sheet_id
        AND a.record_id=NEW.record_id AND a.field_id=NEW.field_id
        AND a.storage_file_id=NEW.displaced_storage_file_id
        AND a.storage_path=NEW.displaced_storage_path FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_displaced_binding_invalid';
    END IF;
  END IF;
  PERFORM 1 FROM public.meta_recovery_archives
    WHERE generation_id=NEW.generation_id AND workspace_id=NEW.workspace_id
      AND base_id=NEW.base_id AND sheet_id=NEW.sheet_id AND state='verified'
      AND build_status='finalized' AND coverage_status='complete' AND expires_at>clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='archive_attachment_restore_source_unavailable';
  END IF;
  RETURN NEW;
END`

async function audit(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`CREATE TEMP TABLE tm_attachment_restore_expected (${columns}) ON COMMIT DROP`).execute(db)
  const result = await sql<{ valid: boolean }>`WITH tables AS (
    SELECT 'public.meta_recovery_archive_attachment_stages'::regclass AS live,
      'pg_temp.tm_attachment_restore_expected'::regclass AS expected
  ), column_shapes AS (
    SELECT a.attrelid,jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) AS shape
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum,tables t
    WHERE a.attrelid IN (t.live,t.expected) AND a.attnum>0 AND NOT a.attisdropped GROUP BY a.attrelid
  ), constraint_shapes AS (
    SELECT conrelid,jsonb_agg(jsonb_build_array(contype,convalidated,condeferrable,condeferred,
      pg_get_constraintdef(oid)) ORDER BY contype,pg_get_constraintdef(oid)) AS shape
    FROM pg_constraint,tables t WHERE conrelid IN (t.live,t.expected) AND contype NOT IN ('f','t') GROUP BY conrelid
  ) SELECT
    (SELECT relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity
      FROM pg_class WHERE oid=t.live)
    AND (SELECT shape FROM column_shapes WHERE attrelid=t.live)=(SELECT shape FROM column_shapes WHERE attrelid=t.expected)
    AND (SELECT shape FROM constraint_shapes WHERE conrelid=t.live)=(SELECT shape FROM constraint_shapes WHERE conrelid=t.expected)
    AND (SELECT count(*)=1 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred
      AND conkey=ARRAY[4]::smallint[] AND confrelid='public.meta_recovery_archives'::regclass
      AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.meta_recovery_archives'::regclass AND attname='generation_id')]
      AND confdeltype='r' AND confupdtype='a' AND confmatchtype='s')
      FROM pg_constraint WHERE conrelid=t.live AND contype='f')
    AND (SELECT prosrc=${guard} AND NOT prosecdef AND provolatile='v' AND prorettype='trigger'::regtype
      AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND proconfig=ARRAY['search_path=pg_catalog, public']
      FROM pg_proc WHERE oid='public.meta_recovery_archive_attachment_stage_guard()'::regprocedure)
    AND (SELECT count(*)=1 AND bool_and(condeferrable AND condeferred AND convalidated)
      FROM pg_constraint WHERE conrelid=t.live AND contype='t')
    AND (SELECT count(*)=3 AND bool_and(tgenabled='O' AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
      AND tgfoid='public.meta_recovery_archive_attachment_stage_guard()'::regprocedure
      AND ((tgname='trg_mraas_row' AND tgtype=31 AND NOT tgdeferrable AND NOT tginitdeferred)
        OR (tgname='trg_mraas_truncate' AND tgtype=34 AND NOT tgdeferrable AND NOT tginitdeferred)
        OR (tgname='trg_mraas_apply_receipt' AND tgtype=21 AND tgdeferrable AND tginitdeferred)))
      FROM pg_trigger WHERE tgrelid=t.live AND NOT tgisinternal) AS valid FROM tables t`.execute(db)
  await sql`DROP TABLE pg_temp.tm_attachment_restore_expected`.execute(db)
  if (result.rows[0]?.valid !== true) throw new Error('ARCHIVE_ATTACHMENT_RESTORE_STAGE_SCHEMA_DRIFT')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ present: boolean }>`SELECT to_regclass('public.meta_recovery_archive_attachment_stages') IS NOT NULL AS present`.execute(db)
  if (exists.rows[0]?.present) return audit(db)
  await sql.raw(`CREATE TABLE public.meta_recovery_archive_attachment_stages (${columns},
    FOREIGN KEY(generation_id) REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT);
    CREATE FUNCTION public.meta_recovery_archive_attachment_stage_guard()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$${guard}$guard$;
    CREATE TRIGGER trg_mraas_row BEFORE INSERT OR UPDATE OR DELETE
      ON public.meta_recovery_archive_attachment_stages FOR EACH ROW
      EXECUTE FUNCTION public.meta_recovery_archive_attachment_stage_guard();
    CREATE TRIGGER trg_mraas_truncate BEFORE TRUNCATE
      ON public.meta_recovery_archive_attachment_stages FOR EACH STATEMENT
      EXECUTE FUNCTION public.meta_recovery_archive_attachment_stage_guard();
    CREATE CONSTRAINT TRIGGER trg_mraas_apply_receipt AFTER INSERT OR UPDATE
      ON public.meta_recovery_archive_attachment_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION public.meta_recovery_archive_attachment_stage_guard()`).execute(db)
  await audit(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ present: boolean }>`SELECT to_regclass('public.meta_recovery_archive_attachment_stages') IS NOT NULL AS present`.execute(db)
  if (!exists.rows[0]?.present) return
  await audit(db)
  await sql`LOCK TABLE public.meta_recovery_archive_attachment_stages IN ACCESS EXCLUSIVE MODE`.execute(db)
  const used = await sql<{ used: boolean }>`SELECT EXISTS (SELECT 1 FROM public.meta_recovery_archive_attachment_stages) AS used`.execute(db)
  if (used.rows[0]?.used) throw new Error('ARCHIVE_ATTACHMENT_RESTORE_STAGE_DOWN_IN_USE')
  await sql`DROP TABLE public.meta_recovery_archive_attachment_stages`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_attachment_stage_guard()`.execute(db)
}
