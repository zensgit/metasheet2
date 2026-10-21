-- ============================================================================
-- 01-inventory.sql — READ-ONLY inventory of dangling `connection_id` rows
-- ============================================================================
-- WHY THIS FILE EXISTS. PR #5896 re-pointed
--   integration_external_systems.connection_id
-- at `data_sources(live_id)` — a STORED generated column that equals `id` while
-- the row is live and is NULL once it is soft-deleted — and added the new FK
--   fk_integration_external_systems_live_connection_id
-- as NOT VALID:
--   packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts:96-113
-- NOT VALID means every INSERT/UPDATE from that migration on is checked in full,
-- while rows that were ALREADY dangling when it ran are tolerated and never
-- scanned. Until those pre-existing rows are gone the constraint cannot be
-- VALIDATEd, so the planner may not rely on it and no one can state "there are
-- no bindings pointing at deleted sources" as a fact.
--
-- This file answers, read-only: HOW MANY such rows exist, WHICH ids, and WHICH
-- of two kinds each one is.
--
-- WHAT COUNTS AS DANGLING — exactly the predicate the FK enforces, MATCH SIMPLE:
--   connection_id IS NOT NULL
--   AND NOT EXISTS (SELECT 1 FROM data_sources WHERE live_id = connection_id)
-- Two disjoint sub-cases, reported as `target_state`:
--   'soft-deleted' — a `data_sources` row with that id EXISTS but has
--                    deleted_at IS NOT NULL (so live_id is NULL). The usual
--                    case; includes every force delete performed before #5896.
--   'absent'       — no `data_sources` row with that id at all (hard delete, or
--                    a pointer that never resolved). ON DELETE RESTRICT made
--                    this hard to produce, but the inventory does not assume it
--                    is impossible.
-- NOT dangling, and deliberately NOT listed: the LEGACY binding shape
-- (connection_id IS NULL, pointer in config->>'dataSourceId'). It has no FK,
-- #5896 does not touch it, and VALIDATE never looks at it.
--
-- #5786 F4 DISCIPLINE — COUNT AND IDS FROM ONE SOURCE. The 2026-09-16 pack's
-- review found a count and an id list computed from two different predicates,
-- so the list could contain rows the count did not. Here the TOTAL row, the
-- BY_KIND_TENANT rows and the HIT rows are three branches of ONE statement over
-- ONE `hit` CTE — not three statements that repeat a predicate. It is not
-- possible for them to disagree; verify/run-verify.mjs asserts TOTAL == |HIT|
-- anyway, and proves the assertion bites by re-running a mutant whose TOTAL is
-- computed independently.
--   (A shared TEMP VIEW would be the other way to do this and is unavailable:
--    _preamble.sql pins default_transaction_read_only, under which every CREATE
--    fails with 25006.)
--
-- VALUES-FREE. Output is ids (`integration_external_systems.id`, `tenant_id`),
-- the closed-vocabulary `kind`, booleans, and counts. No `config`, no `name`,
-- no `credentials_encrypted`, no connection target id — the id list is what a
-- remediation is pointed at, and 02 re-derives the target itself.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 01-inventory.sql
--   psql "$DATABASE_URL" -v schema=public -f 01-inventory.sql
-- Read-only: every statement is a SELECT and the session is pinned
-- default_transaction_read_only = on by the preamble.
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Schema probe + dispatch ───────────────────────────────────────────
-- Purpose: this pack is only meaningful AFTER #5896's migration has run. If
--   `data_sources.live_id` does not exist the answer is not "zero dangling
--   rows", it is "not applicable yet" — Q2 is skipped and the RESULT line says
--   status=incomplete reason=missing-column:data_sources.live_id.
-- Resolution: current_schemas(false) — the exact schemas Q2 resolves through.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND (    (table_name = 'data_sources' AND column_name IN ('id', 'live_id', 'deleted_at'))
         OR (table_name = 'integration_external_systems' AND column_name IN ('id', 'connection_id')))
 ORDER BY table_name, column_name;

SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources' AND column_name = 'live_id'
       ) AS has_live_id,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'integration_external_systems' AND column_name = 'connection_id'
       ) AS has_connection_id,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_integration_external_systems_live_connection_id'
            AND conrelid = to_regclass('integration_external_systems')
       ) AS has_live_fk,
       COALESCE((
         SELECT convalidated FROM pg_constraint
          WHERE conname = 'fk_integration_external_systems_live_connection_id'
            AND conrelid = to_regclass('integration_external_systems')
       ), false) AS live_fk_validated
\gset

\echo '-- live FK present / already validated (false = still NOT VALID, which is why this pack exists):'
\echo :has_live_fk :live_fk_validated


\if :has_live_id
\if :has_connection_id

-- ── Q2. THE inventory — one statement, one `hit` CTE, three sections ───────
-- Purpose: dangling-row count, the per-kind/per-tenant breakdown, and the id
--   list that 02 (and only 02) is pointed at.
-- Depends on:
--   data_sources.live_id  — zzzz20260920120000_data_source_live_id_binding_lock.ts:82-86
--   integration_external_systems.connection_id — zzzz20260902120000_add_integration_connection_binding.ts:74-77
-- Expected output shape, in this order:
--   section=TOTAL           — EXACTLY ONE row. `n` = number of dangling rows.
--                             `n = 0` is the "nothing to clean, go straight to
--                             03" answer. This row is printed even when n = 0.
--   section=BY_KIND_TENANT  — 0..N rows, one per (kind, tenant_id) that has at
--                             least one hit. sum(n) == TOTAL.n by construction.
--   section=HIT             — 0..N rows, one per dangling binding, n = 1 each.
--                             COUNT OF THESE ROWS == TOTAL.n — same CTE, so the
--                             two cannot disagree. Assert it anyway when you
--                             read the log.
-- Column meanings on a HIT row:
--   key_id          integration_external_systems.id (what 02 updates)
--   target_state    'soft-deleted' | 'absent' (see header)
--   config_pointer  config->>'dataSourceId' is already present and non-blank —
--                   02 leaves such a row's config alone (the receipt exists)
--   config_object   jsonb_typeof(config) = 'object'. FALSE means 02 CANNOT
--                   write a receipt into it and REFUSES to touch the row; it is
--                   reported here so that refusal is never a surprise.
--   legacy_fallback integration_external_systems.legacy_connection_fallback_eligible
--                   — server-owned cutover evidence. 02 never changes it; see
--                   README §"02 之后这行长什么样".
WITH hit AS (
  SELECT es.id                                             AS key_id,
         es.kind                                           AS kind,
         es.tenant_id                                      AS tenant_id,
         CASE WHEN EXISTS (SELECT 1 FROM data_sources d WHERE d.id = es.connection_id)
              THEN 'soft-deleted' ELSE 'absent' END        AS target_state,
         COALESCE(NULLIF(BTRIM(CASE WHEN jsonb_typeof(es.config) = 'object'
                                    THEN es.config->>'dataSourceId' END), ''), '') <> ''
                                                           AS config_pointer,
         jsonb_typeof(es.config) = 'object'                AS config_object,
         es.legacy_connection_fallback_eligible            AS legacy_fallback
    FROM integration_external_systems es
   WHERE es.connection_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM data_sources d WHERE d.live_id = es.connection_id
         )
)
SELECT section, key_id, kind, tenant_id, target_state, config_pointer, config_object, legacy_fallback, n
  FROM (
        SELECT 'TOTAL'::text AS section, NULL::text AS key_id, NULL::text AS kind,
               NULL::text AS tenant_id, NULL::text AS target_state,
               NULL::boolean AS config_pointer, NULL::boolean AS config_object,
               NULL::boolean AS legacy_fallback, count(*)::int AS n
          FROM hit
        UNION ALL
        SELECT 'BY_KIND_TENANT', NULL, hit.kind, hit.tenant_id, NULL, NULL, NULL, NULL, count(*)::int
          FROM hit GROUP BY hit.kind, hit.tenant_id
        UNION ALL
        SELECT 'HIT', hit.key_id, hit.kind, hit.tenant_id, hit.target_state,
               hit.config_pointer, hit.config_object, hit.legacy_fallback, 1
          FROM hit
       ) x
 ORDER BY CASE section WHEN 'TOTAL' THEN 0 WHEN 'BY_KIND_TENANT' THEN 1 ELSE 2 END,
          kind NULLS FIRST, tenant_id NULLS FIRST, key_id NULLS FIRST;

\else
\echo '-- integration_external_systems.connection_id absent — Q2 skipped.'
\endif
\else
\echo '-- data_sources.live_id absent (#5896 migration not applied here) — Q2 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- A run WITHOUT this line is incomplete, whatever else it printed: the file
-- aborted (ON_ERROR_STOP), timed out (57014), was cancelled, or was truncated.
-- Never read an aborted run as "zero dangling rows".
SELECT 'INVENTORY_RESULT file=01-inventory.sql status=' ||
       CASE
         WHEN NOT p.has_es_table   THEN 'incomplete reason=missing-table:integration_external_systems'
         WHEN NOT p.has_ds_table   THEN 'incomplete reason=missing-table:data_sources'
         WHEN NOT p.has_live_id    THEN 'incomplete reason=missing-column:data_sources.live_id'
         WHEN NOT p.has_connection THEN 'incomplete reason=missing-column:integration_external_systems.connection_id'
         ELSE 'complete live_fk=' || CASE WHEN p.has_live_fk THEN 'present' ELSE 'missing' END ||
              ' validated=' || CASE WHEN p.live_fk_validated THEN 'yes' ELSE 'no' END
       END AS inventory_result
  FROM (
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'integration_external_systems') AS has_es_table,
           EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'data_sources') AS has_ds_table,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'data_sources' AND column_name = 'live_id') AS has_live_id,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'integration_external_systems'
                      AND column_name = 'connection_id') AS has_connection,
           EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fk_integration_external_systems_live_connection_id'
                      AND conrelid = to_regclass('integration_external_systems')) AS has_live_fk,
           COALESCE((SELECT convalidated FROM pg_constraint
                      WHERE conname = 'fk_integration_external_systems_live_connection_id'
                        AND conrelid = to_regclass('integration_external_systems')), false)
             AS live_fk_validated
  ) p;
