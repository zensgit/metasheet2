/** Narrow V1 member-provenance extension. Old five-key effects remain byte-identical. */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION attendance_w4c3a_member_ordinals_valid(ordinals jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
    DECLARE entry jsonb; previous bigint := -1; current_ordinal bigint;
    BEGIN
      IF jsonb_typeof(ordinals) IS DISTINCT FROM 'array' OR jsonb_array_length(ordinals) = 0 THEN RETURN false; END IF;
      FOR entry IN SELECT value FROM jsonb_array_elements(ordinals) LOOP
        IF jsonb_typeof(entry) <> 'number' OR entry::text !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        IF entry::numeric > 2147483647 THEN RETURN false; END IF;
        current_ordinal := entry::bigint;
        IF current_ordinal <= previous THEN RETURN false; END IF;
        previous := current_ordinal;
      END LOOP;
      RETURN true;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_group_effect_valid(effect jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    BEGIN
      IF jsonb_typeof(effect) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF effect ->> 'kind' = 'ensure_group' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            ARRAY['kind', 'groupId', 'normalizedName', 'displayName', 'code',
              'timezone', 'ruleSetId', 'groupExistedAtPrepare']
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'groupId')
          AND jsonb_typeof(effect -> 'normalizedName') = 'string'
          AND length(effect ->> 'normalizedName') > 0
          AND jsonb_typeof(effect -> 'displayName') = 'string'
          AND length(effect ->> 'displayName') > 0
          AND jsonb_typeof(effect -> 'groupExistedAtPrepare') = 'boolean'
          AND (effect -> 'code' IS NULL OR jsonb_typeof(effect -> 'code') IN ('string', 'null'))
          AND jsonb_typeof(effect -> 'timezone') = 'string'
          AND (
            effect -> 'ruleSetId' IS NULL
            OR jsonb_typeof(effect -> 'ruleSetId') = 'null'
            OR attendance_w4c3a_uuid_text(effect ->> 'ruleSetId')
          );
      END IF;
      IF effect ->> 'kind' = 'ensure_member' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            CASE WHEN effect ? 'sourceOrdinals' THEN
              ARRAY['kind', 'memberId', 'groupRef', 'userId', 'membershipExistedAtPrepare', 'sourceOrdinals']
            ELSE ARRAY['kind', 'memberId', 'groupRef', 'userId', 'membershipExistedAtPrepare'] END
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'memberId')
          AND attendance_w4c3a_uuid_text(effect ->> 'groupRef')
          AND jsonb_typeof(effect -> 'userId') = 'string'
          AND length(effect ->> 'userId') > 0
          AND jsonb_typeof(effect -> 'membershipExistedAtPrepare') = 'boolean'
          AND (NOT effect ? 'sourceOrdinals' OR attendance_w4c3a_member_ordinals_valid(effect -> 'sourceOrdinals'));
      END IF;
      RETURN false;
    END
    $fn$
  `.execute(db)

}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE attendance_import_legacy_execution_plan_chunks IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM attendance_import_legacy_execution_plan_chunks c,
          LATERAL jsonb_array_elements(c.chunk -> 'groupEffects') e
        WHERE e.value ? 'sourceOrdinals'
      ) THEN RAISE EXCEPTION 'W4C3A_MEMBER_SOURCE_HISTORY_DOWN_DENIED'; END IF;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_group_effect_valid(effect jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    BEGIN
      IF jsonb_typeof(effect) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF effect ->> 'kind' = 'ensure_group' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            ARRAY['kind', 'groupId', 'normalizedName', 'displayName', 'code',
              'timezone', 'ruleSetId', 'groupExistedAtPrepare']
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'groupId')
          AND jsonb_typeof(effect -> 'normalizedName') = 'string'
          AND length(effect ->> 'normalizedName') > 0
          AND jsonb_typeof(effect -> 'displayName') = 'string'
          AND length(effect ->> 'displayName') > 0
          AND jsonb_typeof(effect -> 'groupExistedAtPrepare') = 'boolean'
          AND (effect -> 'code' IS NULL OR jsonb_typeof(effect -> 'code') IN ('string', 'null'))
          AND jsonb_typeof(effect -> 'timezone') = 'string'
          AND (
            effect -> 'ruleSetId' IS NULL
            OR jsonb_typeof(effect -> 'ruleSetId') = 'null'
            OR attendance_w4c3a_uuid_text(effect ->> 'ruleSetId')
          );
      END IF;
      IF effect ->> 'kind' = 'ensure_member' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            ARRAY['kind', 'memberId', 'groupRef', 'userId', 'membershipExistedAtPrepare']
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'memberId')
          AND attendance_w4c3a_uuid_text(effect ->> 'groupRef')
          AND jsonb_typeof(effect -> 'userId') = 'string'
          AND length(effect ->> 'userId') > 0
          AND jsonb_typeof(effect -> 'membershipExistedAtPrepare') = 'boolean';
      END IF;
      RETURN false;
    END
    $fn$
  `.execute(db)
  await sql`DROP FUNCTION attendance_w4c3a_member_ordinals_valid(jsonb)`.execute(db)
}
