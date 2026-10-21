import { sql, type Kysely } from 'kysely'

/**
 * Phase D2h: immutable recovery-archive DEK/nonce reservation registry.
 *
 * D-F: before any section bytes are encrypted, sealed, or uploaded, every globally unique
 * `(dek_fingerprint, nonce)` pair is durably reserved here. The registry is a values-free safety
 * TOMBSTONE, not an object reference:
 *
 *   - it has NO foreign key, so it cannot cascade with generation, coverage, staging-object, or
 *     archive-object deletion, and deleting an old ciphertext can never make its pair reusable;
 *   - rows are immutable: UPDATE, DELETE, and TRUNCATE all refuse, so it is never auto-pruned;
 *   - reuse of a nonce under the SAME DEK fingerprint refuses; the same nonce under a provably
 *     different DEK fingerprint is admitted, which D-F explicitly permits.
 *
 * This migration adds no key registry: D1 §5 assigns "key registry / reference-admission lock" and
 * the D-L key lifecycle to D3, and D2a already binds `key_id` on `meta_recovery_archives`.
 *
 * It registers no flag, adds no runtime writer or reader, and authorizes no archive verification,
 * pruning, retention, upload, or key operation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Fail before creating anything when an owned object name already exists, or when a preexisting
  // D2a catalog is type-incompatible with the generation binding stored here. The compatibility
  // check is CONDITIONAL: the registry deliberately has no dependency on the D2a catalog, so an
  // absent catalog is not drift. up() avoids IF NOT EXISTS / CREATE OR REPLACE on purpose: a
  // same-name object must never make a partial or wrong registry look successfully installed.
  await sql`
    DO $$
    DECLARE
      owned_object_count integer;
      catalog_oid oid;
      generation_type text;
    BEGIN
      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_recovery_archive_nonce_reservations',
              'public.uq_meta_recovery_archive_nonce_reservation_generation_section'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_nonce_reservation_guard_row',
             'meta_recovery_archive_nonce_reservation_guard_truncate',
             'meta_recovery_archive_reserve_nonce'
           )
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgname IN (
             'trg_meta_recovery_archive_nonce_reservation_guard_row',
             'trg_meta_recovery_archive_nonce_reservation_guard_truncate'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_crypto_registry_object_conflict';
      END IF;

      catalog_oid := pg_catalog.to_regclass('public.meta_recovery_archives');
      IF catalog_oid IS NOT NULL THEN
        SELECT pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          INTO generation_type
          FROM pg_catalog.pg_attribute attribute
         WHERE attribute.attrelid = catalog_oid
           AND attribute.attname = 'generation_id'
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped;

        IF generation_type IS DISTINCT FROM 'uuid' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_crypto_registry_source_schema_mismatch';
        END IF;
      END IF;
    END $$;
  `.execute(db)

  // Identity columns are `COLLATE "C"` so equality and uniqueness are byte-exact and independent
  // of the database/server collation, and canonical lowercase hex so one nonce has exactly one
  // spelling. Without both, `AABB..` and `aabb..` could become two rows for one real nonce and a
  // genuine same-DEK reuse would go undetected. Counters are never JS numbers: `format_version` is
  // a closed version literal, and no sequence or counter column exists here at all.
  await sql`
    CREATE TABLE public.meta_recovery_archive_nonce_reservations (
      dek_fingerprint text COLLATE "C" NOT NULL,
      nonce text COLLATE "C" NOT NULL,
      generation_id uuid NOT NULL,
      section_name text NOT NULL,
      aead_algorithm text NOT NULL,
      format_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_nonce_reservations
        PRIMARY KEY (dek_fingerprint, nonce),
      -- One generation reserves each section exactly once. Without this a retry could mint a
      -- SECOND nonce for the same section under the same DEK: both pairs are unique, so the
      -- primary key alone admits two live ciphertexts claiming to be one section.
      CONSTRAINT uq_meta_recovery_archive_nonce_reservation_generation_section
        UNIQUE (generation_id, section_name),
      CONSTRAINT chk_meta_recovery_archive_nonce_reservation_fingerprint
        CHECK (dek_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_nonce_reservation_nonce
        CHECK (nonce ~ '^[0-9a-f]{24}$'),
      CONSTRAINT chk_meta_recovery_archive_nonce_reservation_format_version
        CHECK (format_version = 1),
      CONSTRAINT chk_meta_recovery_archive_nonce_reservation_aead_algorithm
        CHECK (aead_algorithm IN ('aes-256-gcm')),
      CONSTRAINT chk_meta_recovery_archive_nonce_reservation_section_name CHECK (
        section_name IN (
          'schema',
          'records',
          'links',
          'field_value_tombstones',
          'link_tombstones',
          'auto_number',
          'attachments_index',
          'permission_evidence',
          'views_config',
          'coverage_index'
        )
      )
      -- Deliberately NO FOREIGN KEY: this reservation must outlive its generation, its staging
      -- objects, and its archive objects. Adding one would reintroduce exactly the cascade D-F
      -- forbids.
    )
  `.execute(db)

  // BEFORE ROW guard. It runs ahead of the declarative CHECK constraints, so a malformed value is
  // refused with a values-free message instead of PostgreSQL's check-violation DETAIL, which would
  // print the failing row (and therefore the nonce and DEK fingerprint) into an ordinary log.
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_nonce_reservation_immutable';
      END IF;

      IF NEW.dek_fingerprint IS NULL
         OR NEW.dek_fingerprint !~ '^[0-9a-f]{64}$'
         OR NEW.nonce IS NULL
         OR NEW.nonce !~ '^[0-9a-f]{24}$'
         OR NEW.generation_id IS NULL
         OR NEW.section_name IS NULL
         OR NEW.section_name NOT IN (
           'schema',
           'records',
           'links',
           'field_value_tombstones',
           'link_tombstones',
           'auto_number',
           'attachments_index',
           'permission_evidence',
           'views_config',
           'coverage_index'
         )
         OR NEW.aead_algorithm IS NULL
         OR NEW.aead_algorithm NOT IN ('aes-256-gcm')
         OR NEW.format_version IS NULL
         OR NEW.format_version <> 1
         OR NEW.created_at IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_nonce_reservation_shape_invalid';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  // Row triggers do not fire on TRUNCATE, so "never auto-pruned" needs its own statement guard.
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'recovery_archive_nonce_reservation_immutable';
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_nonce_reservation_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_nonce_reservations
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_row()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_nonce_reservation_guard_truncate
    BEFORE TRUNCATE ON public.meta_recovery_archive_nonce_reservations
    FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_truncate()
  `.execute(db)

  // Values-free reservation primitive. A bare INSERT that loses a race would surface PostgreSQL's
  // unique-violation DETAIL, which spells out `Key (dek_fingerprint, nonce)=(...)`. DO NOTHING
  // resolves the race inside PostgreSQL and reports the refusal as a closed code carrying no
  // values. Callers reserve a whole batch by calling this once per pair inside one transaction;
  // any refusal aborts that transaction, so the batch is all-or-nothing.
  //
  // The conflict clause is deliberately BARE (no `(dek_fingerprint, nonce)` target). This table
  // now has TWO unique constraints, and a targeted clause absorbs only the one it names: a
  // duplicate `(generation_id, section_name)` would escape as a raw 23505 whose DETAIL prints the
  // generation and section. Bare DO NOTHING absorbs every arbiter, so both refusals are values
  // free and both reach the same closed code.
  //
  // This is a SQL primitive, not the D2 archive runtime: it performs no KMS call, no upload, no
  // catalog write, and no state transition.
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_reserve_nonce(
      p_dek_fingerprint text,
      p_nonce text,
      p_generation_id uuid,
      p_section_name text,
      p_aead_algorithm text,
      p_format_version integer
    )
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      inserted_count integer;
    BEGIN
      INSERT INTO public.meta_recovery_archive_nonce_reservations (
        dek_fingerprint, nonce, generation_id, section_name, aead_algorithm, format_version
      ) VALUES (
        p_dek_fingerprint, p_nonce, p_generation_id, p_section_name, p_aead_algorithm,
        p_format_version
      )
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS inserted_count = ROW_COUNT;

      IF inserted_count = 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_nonce_reservation_conflict';
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Development-only rollback. A nonempty registry refuses: these rows are permanent safety
  // tombstones, and dropping them would make every reserved nonce reusable under its DEK. The
  // refusal is values-free and never reports a fingerprint, nonce, or generation.
  await sql`
    DO $$
    DECLARE
      registry_nonempty boolean;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_nonce_reservations') IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM public.meta_recovery_archive_nonce_reservations LIMIT 1
        ) INTO registry_nonempty;

        IF registry_nonempty THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_crypto_registry_nonempty';
        END IF;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_nonce_reservations') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_nonce_reservation_guard_truncate
          ON public.meta_recovery_archive_nonce_reservations;
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_nonce_reservation_guard_row
          ON public.meta_recovery_archive_nonce_reservations;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DROP FUNCTION IF EXISTS public.meta_recovery_archive_reserve_nonce(
      text, text, uuid, text, text, integer
    )
  `.execute(db)

  await sql`DROP TABLE IF EXISTS public.meta_recovery_archive_nonce_reservations`.execute(db)

  await sql`
    DROP FUNCTION IF EXISTS public.meta_recovery_archive_nonce_reservation_guard_truncate()
  `.execute(db)
  await sql`
    DROP FUNCTION IF EXISTS public.meta_recovery_archive_nonce_reservation_guard_row()
  `.execute(db)
}
