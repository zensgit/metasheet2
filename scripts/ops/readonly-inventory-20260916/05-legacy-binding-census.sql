-- ============================================================================
-- 05-legacy-binding-census.sql — residual LEGACY binding census (read-only)
-- ============================================================================
-- Feeds: the one-shot backfill migration
--   packages/core-backend/src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts
-- (#5896 follow-up). It answers, BEFORE that migration is allowed to run, how
-- many rows of `integration_external_systems` are still in the LEGACY shape
--   connection_id IS NULL  AND  config->>'dataSourceId' IS NOT NULL
-- and — row by row — which of the following mutually exclusive classes each one
-- falls in. Only the LAST class is what the migration rewrites; every other
-- class is left exactly as it is and is reported here for the owner to rule on.
--
--   class                        meaning                                              migration
--   ---------------------------  ---------------------------------------------------  ---------
--   non-sql-readonly-kind        kind <> 'data-source:sql-readonly' (write-gated,     untouched
--                                erp:*, http, …). Those kinds have NO canonical
--                                connection_id at all: the plugin REJECTS
--                                connectionId for them and rewrites connection_id
--                                to NULL on every update (plugin-integration-core/
--                                lib/external-systems.cjs :526-534, :758, :774), so
--                                a backfill would be undone by the next save.
--   rollback-shape-marker-true   legacy_connection_fallback_eligible = TRUE with     untouched
--                                connection_id NULL: the cutover's deliberate
--                                rollback shape (zzzz20260902120000 header); still
--                                resolves via resolveLegacy (connection-resolver.cjs
--                                :205-263). Operator decision, not overwritten.
--   pointer-unresolved           no data_sources row has id = the pointer            untouched
--                                (hard-deleted, or never resolved).
--   source-soft-deleted          data_sources row exists, deleted_at IS NOT NULL.     untouched
--                                Since #5896 the FK targets live_id (NULL when
--                                soft-deleted): writing it would raise 23503.
--   owner-mismatch               config->>'dataSourceOwnerId' is absent or differs   untouched
--                                from data_sources.owner_id — the delete guard does
--                                not count such a pin either (DataSourceManager.ts
--                                :713-718, zzzz20260902120000 :97-106).
--   tenant-unproven              data_sources.tenant_id IS NULL (pre-existing source  untouched
--                                whose tenant membership was never proven).
--   tenant-mismatch              data_sources.tenant_id <> binding tenant_id.         untouched
--   backfillable                 all six predicates hold: sql-readonly, marker not    REWRITTEN
--                                TRUE, pointer resolves, owner matches, source live,
--                                same tenant.
--
-- The classification is applied in the order listed (first match wins), so the
-- eight counts partition the legacy population and sum to `legacy_rows_total`.
-- The count query (Q2) and the id query (Q3) read the SAME `hit` CTE, so
-- `|ids per class| == count per class` is an assertable invariant.
--
-- WHAT THIS FILE DOES NOT DO: it does not look at canonical rows (connection_id
-- IS NOT NULL — those are 01-inventory.sql's business under
-- scripts/ops/live-id-fk-validate-20260920/), does not judge whether an
-- owner-mismatch pin is legitimate, and writes nothing (see _preamble.sql:
-- default_transaction_read_only = on).
--
-- VALUES-FREE: only ids, kind (a closed set), tenant ids, booleans and the
-- class label. No config payload, no credentials, no names.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 05-legacy-binding-census.sql
--   psql "$DATABASE_URL" -v schema=public -f 05-legacy-binding-census.sql
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Column probe + automatic dispatch ───────────────────────────────────
-- The census needs the cutover columns (connection_id, the rollback marker) on
-- integration_external_systems and (owner_id, deleted_at, tenant_id) on
-- data_sources. A schema that predates zzzz20260902120000 has no legacy /
-- canonical distinction yet; the file then reports `incomplete` rather than a
-- misleading zero.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND ((table_name = 'integration_external_systems'
         AND column_name IN ('id', 'tenant_id', 'kind', 'config', 'connection_id',
                             'legacy_connection_fallback_eligible'))
     OR (table_name = 'data_sources'
         AND column_name IN ('id', 'owner_id', 'deleted_at', 'tenant_id', 'live_id')))
 ORDER BY table_name, column_name;

SELECT EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'integration_external_systems') AS has_bindings,
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'data_sources') AS has_sources,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'integration_external_systems'
                  AND column_name = 'connection_id') AS has_connection_id,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'integration_external_systems'
                  AND column_name = 'legacy_connection_fallback_eligible') AS has_marker,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'data_sources'
                  AND column_name = 'tenant_id') AS has_source_tenant,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'data_sources'
                  AND column_name = 'live_id') AS has_live_id
\gset

SELECT :'has_bindings'::boolean AND :'has_sources'::boolean AND :'has_connection_id'::boolean
   AND :'has_marker'::boolean AND :'has_source_tenant'::boolean AS census_ready
\gset


\if :census_ready

-- ── Q2. Legacy population — COUNT per class (one hit CTE, shared with Q3) ──
-- `legacy_rows_total` is the whole legacy shape; the eight class columns
-- partition it. `backfillable` is the exact row count the migration's UPDATE
-- will report. Everything else stays untouched by the migration.
WITH hit AS (
  SELECT b.id,
         b.tenant_id,
         b.kind,
         b.legacy_connection_fallback_eligible AS marker,
         b.config->>'dataSourceId'             AS pointer,
         (b.config->>'dataSourceOwnerId' IS NOT NULL) AS has_owner_stamp,
         ds.id                                 AS source_id,
         ds.tenant_id                          AS source_tenant_id,
         (ds.deleted_at IS NOT NULL)           AS source_soft_deleted,
         (b.config->>'dataSourceOwnerId' = ds.owner_id) AS owner_matches,
         CASE
           WHEN b.kind <> 'data-source:sql-readonly'          THEN 'non-sql-readonly-kind'
           WHEN b.legacy_connection_fallback_eligible IS TRUE THEN 'rollback-shape-marker-true'
           WHEN ds.id IS NULL                                 THEN 'pointer-unresolved'
           WHEN ds.deleted_at IS NOT NULL                     THEN 'source-soft-deleted'
           WHEN b.config->>'dataSourceOwnerId' IS DISTINCT FROM ds.owner_id
                                                              THEN 'owner-mismatch'
           WHEN ds.tenant_id IS NULL                          THEN 'tenant-unproven'
           WHEN ds.tenant_id <> b.tenant_id                   THEN 'tenant-mismatch'
           ELSE                                                    'backfillable'
         END AS class
    FROM integration_external_systems b
    LEFT JOIN data_sources ds
      ON ds.id = b.config->>'dataSourceId'
   WHERE b.connection_id IS NULL
     AND NULLIF(b.config->>'dataSourceId', '') IS NOT NULL
)
SELECT count(*)::int                                                     AS legacy_rows_total,
       count(*) FILTER (WHERE class = 'non-sql-readonly-kind')::int      AS non_sql_readonly_kind,
       count(*) FILTER (WHERE class = 'rollback-shape-marker-true')::int AS rollback_shape_marker_true,
       count(*) FILTER (WHERE class = 'pointer-unresolved')::int         AS pointer_unresolved,
       count(*) FILTER (WHERE class = 'source-soft-deleted')::int        AS source_soft_deleted,
       count(*) FILTER (WHERE class = 'owner-mismatch')::int             AS owner_mismatch,
       count(*) FILTER (WHERE class = 'tenant-unproven')::int            AS tenant_unproven,
       count(*) FILTER (WHERE class = 'tenant-mismatch')::int            AS tenant_mismatch,
       count(*) FILTER (WHERE class = 'backfillable')::int               AS backfillable
  FROM hit;

-- ── Q3. Same population — IDS with class (identical hit CTE) ───────────────
-- Unbounded by design (count AND id). If Q2's total is in the thousands, stop
-- here, report the counts, and ask for an explicit output budget first.
WITH hit AS (
  SELECT b.id,
         b.tenant_id,
         b.kind,
         b.legacy_connection_fallback_eligible AS marker,
         b.config->>'dataSourceId'             AS pointer,
         (b.config->>'dataSourceOwnerId' IS NOT NULL) AS has_owner_stamp,
         ds.id                                 AS source_id,
         ds.tenant_id                          AS source_tenant_id,
         (ds.deleted_at IS NOT NULL)           AS source_soft_deleted,
         (b.config->>'dataSourceOwnerId' = ds.owner_id) AS owner_matches,
         CASE
           WHEN b.kind <> 'data-source:sql-readonly'          THEN 'non-sql-readonly-kind'
           WHEN b.legacy_connection_fallback_eligible IS TRUE THEN 'rollback-shape-marker-true'
           WHEN ds.id IS NULL                                 THEN 'pointer-unresolved'
           WHEN ds.deleted_at IS NOT NULL                     THEN 'source-soft-deleted'
           WHEN b.config->>'dataSourceOwnerId' IS DISTINCT FROM ds.owner_id
                                                              THEN 'owner-mismatch'
           WHEN ds.tenant_id IS NULL                          THEN 'tenant-unproven'
           WHEN ds.tenant_id <> b.tenant_id                   THEN 'tenant-mismatch'
           ELSE                                                    'backfillable'
         END AS class
    FROM integration_external_systems b
    LEFT JOIN data_sources ds
      ON ds.id = b.config->>'dataSourceId'
   WHERE b.connection_id IS NULL
     AND NULLIF(b.config->>'dataSourceId', '') IS NOT NULL
)
SELECT class,
       id            AS binding_id,
       tenant_id     AS binding_tenant_id,
       kind,
       marker,
       pointer       AS legacy_pointer,
       has_owner_stamp,
       source_id,
       source_tenant_id,
       source_soft_deleted,
       owner_matches
  FROM hit
 ORDER BY class, tenant_id, id;

-- ── Q4 (SUPPLEMENTARY). Non-sql-readonly legacy pointers grouped by kind ───
-- The owner asked for the "other kinds" to be listed, not backfilled. This is
-- the per-kind breakdown of Q2's `non_sql_readonly_kind` column.
SELECT b.kind,
       count(*)::int AS legacy_pointer_rows
  FROM integration_external_systems b
 WHERE b.connection_id IS NULL
   AND NULLIF(b.config->>'dataSourceId', '') IS NOT NULL
   AND b.kind <> 'data-source:sql-readonly'
 GROUP BY b.kind
 ORDER BY b.kind;

-- ── Q5 (SUPPLEMENTARY, denominator). Shape of the whole binding table ──────
SELECT count(*)::int                                                                AS bindings_total,
       count(*) FILTER (WHERE connection_id IS NOT NULL)::int                       AS canonical_rows,
       count(*) FILTER (WHERE connection_id IS NULL
                          AND NULLIF(config->>'dataSourceId', '') IS NOT NULL)::int AS legacy_rows,
       count(*) FILTER (WHERE connection_id IS NULL
                          AND NULLIF(config->>'dataSourceId', '') IS NULL)::int     AS unbound_rows,
       count(*) FILTER (WHERE kind = 'data-source:sql-readonly')::int               AS sql_readonly_rows
  FROM integration_external_systems;

\else
\echo '-- cutover columns or tables absent — Q2..Q5 skipped (see INVENTORY_RESULT below).'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line ⇒ aborted run (error / statement timeout 57014 /
-- cancellation / truncated output) ⇒ INCOMPLETE, never "zero legacy rows".
-- `live_id` is reported as a note only: the census itself reads deleted_at, but
-- its absence means #5896 has not run here yet and the backfill must wait.
SELECT 'INVENTORY_RESULT file=05-legacy-binding-census.sql status=' ||
       CASE WHEN p.missing = '' THEN 'complete classes=8'
            ELSE 'incomplete reason=missing-column:' || p.missing
       END ||
       CASE WHEN NOT p.has_live_id THEN ' note=data_sources.live_id-absent(#5896-not-applied)' ELSE '' END
       AS inventory_result
  FROM (
    SELECT has_live_id,
           btrim(
             CASE WHEN NOT has_bindings       THEN 'integration_external_systems ' ELSE '' END ||
             CASE WHEN NOT has_sources        THEN 'data_sources ' ELSE '' END ||
             CASE WHEN NOT has_connection_id  THEN 'integration_external_systems.connection_id ' ELSE '' END ||
             CASE WHEN NOT has_marker         THEN 'integration_external_systems.legacy_connection_fallback_eligible ' ELSE '' END ||
             CASE WHEN NOT has_source_tenant  THEN 'data_sources.tenant_id ' ELSE '' END
           ) AS missing
      FROM (
        SELECT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'integration_external_systems') AS has_bindings,
               EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'data_sources') AS has_sources,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'integration_external_systems'
                          AND column_name = 'connection_id') AS has_connection_id,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'integration_external_systems'
                          AND column_name = 'legacy_connection_fallback_eligible') AS has_marker,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'data_sources'
                          AND column_name = 'tenant_id') AS has_source_tenant,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'data_sources'
                          AND column_name = 'live_id') AS has_live_id
      ) q
  ) p;
