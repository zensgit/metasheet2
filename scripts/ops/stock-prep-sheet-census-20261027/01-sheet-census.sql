-- ============================================================================
-- 01-sheet-census.sql — read-only doubled-sheet census of the stock-prep
--                       PROJECT SHEETS (batch-refresh step 6d-1a, T6-16)
-- ============================================================================
-- WHAT IT DOES. For every row of the project-sheet registry
-- `integration_stock_prep_project_target` (migration 087; active AND archived),
-- it re-derives the sheet's physical ids, self-checks them against the
-- registry, and counts the doubled-sheet shapes of design-final §6.1 over the
-- sheet's live `meta_records` rows of that project. SELECT only. No package is
-- needed: it runs on the R maintenance line (R74/R75) and on main alike.
--
-- TWIN. The counts are the SAME definitions as the pure module
--   plugins/plugin-integration-core/lib/stock-preparation-sheet-census.cjs
--   (`censusOfRows`), whose header is the one definition list. Parity is the
--   real-DB case S9D-02 (packages/core-backend/tests/integration/
--   stock-preparation-sheet-census-realdb.cases.ts). Change a predicate here
--   and in the module in the SAME PR.
--
-- PREDICATES (JSON semantics of the cell, never its text):
--   active(row)    inactive ONLY when the `active` cell is the JSON boolean
--                  false. The string 'false', 0, null and a missing cell are
--                  ACTIVE (F-11 / F6-17).
--   blank(v)       missing, JSON null, or a JSON string whose JavaScript
--                  trim() is empty — btrim over the exact JS whitespace set
--                  (`ws` below). Boolean false, 0 and [] are NOT blank.
--   root(row)      blank(parentSourceId).
--   component(row) componentSourceId when it is a non-blank JSON string,
--                  UNTRIMMED; else none. key(row): idempotencyKey, same rule.
--   creator(row)   meta_records.created_by is non-blank (GOV-05: the reader
--                  attaches the creator only for a non-blank string).
--   project rows   `data ->> <projectNo field> = registry.project_no` — the
--                  project-scoped reader's own equality filter.
--
-- COUNTS (one line per sheet; integers only):
--   row_count, active_row_count,
--   two_copy_components            active root AND active nested (D1, O-6)
--   inactive_root_remnant_components inactive root, NO active root, >=1
--                                  active nested (D2, the item-10 shape)
--   duplicate_key_groups           keys on >=2 rows, active or not (D3)
--   keyless_rows_without_creator   active, no key, no creator (D4 defect)
--   keyless_rows_with_creator      active, no key, a creator (D4 manual)
--   non_boolean_active_cells       `active` present, not null, not boolean (D5)
--   inactive_rows_with_human_cells inactive rows with >=1 non-blank human cell
--   nested_copies_with_human_cells active nested HEAD rows of a D1/D2
--                                  component with >=1 non-blank human cell
--   sheet_rows_all_projects        PACK ONLY: every live row on the sheet,
--                                  whatever its project (one-sheet-one-project
--                                  visibility); not in the module, not in parity.
--
-- PHYSICAL IDS (F6-27, identical on R74 and main):
--   staging project = tenant_id || ':integration-core'
--   sheet id  = 'sheet_' || first 24 hex of sha1(project ':' object_id)
--   field id  = 'fld_'   || first 24 hex of sha1(project ':' object_id ':' logical id)
--   (packages/core-backend/src/multitable/provisioning.ts stableMetaId). sha1 is
--   pgcrypto's digest(); the probe below refuses to run without it.
--
-- FAIL CLOSED, per sheet: derived sheet id <> registry sheet_id
--   (status=incomplete reason=sheet_id_mismatch — e.g. a workspace-scoped
--   deployment), sheet absent or soft-deleted (reason=sheet_missing), or one of
--   projectNo / idempotencyKey / componentSourceId / parentSourceId / active
--   absent from the sheet's fields (reason=field_missing). Such a sheet prints
--   NO counts. The run is complete only when every sheet is.
--
-- VALUES-FREE (RD G4). Default output: ordinals, the registry status token and
--   integers. objectId handles are a digest of the project number and can be
--   brute-forced, so the ordinal -> object_id map is printed ONLY with
--   `-v emit_private_map=1`, and that output belongs in the PRIVATE record,
--   never in #6079, an issue or a PR body.
--
-- RUN WITH (the only supported form; see README.md):
--   psql "$READONLY_DATABASE_URL" -X -f 01-sheet-census.sql
--   psql "$READONLY_DATABASE_URL" -X -v schema=public -v tenant=<tenant id> -f 01-sheet-census.sql
-- ============================================================================

\ir _preamble.sql
\pset tuples_only on
\pset format unaligned

\if :{?tenant}
\else
  \set tenant ''
\endif

-- ── P1. Probe: refuse (as an explicit incomplete line) rather than error ────
SELECT (current_setting('server_encoding') = 'UTF8') AS census_utf8,
       (to_regprocedure('digest(bytea,text)') IS NOT NULL) AS census_has_digest,
       (to_regclass('integration_stock_prep_project_target') IS NOT NULL) AS census_has_registry,
       (to_regclass('meta_sheets') IS NOT NULL
         AND to_regclass('meta_fields') IS NOT NULL
         AND to_regclass('meta_records') IS NOT NULL) AS census_has_meta,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'meta_records' AND column_name = 'created_by') AS census_has_created_by
\gset

\if :census_utf8
\else
  SELECT 'CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=server_encoding_not_utf8';
  \quit
\endif
\if :census_has_digest
\else
  SELECT 'CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=pgcrypto_digest_missing';
  \quit
\endif
\if :census_has_registry
\else
  SELECT 'CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=registry_missing';
  \quit
\endif
\if :census_has_meta
\else
  SELECT 'CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=meta_tables_missing';
  \quit
\endif
\if :census_has_created_by
\else
  SELECT 'CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=missing_column_meta_records_created_by';
  \quit
\endif

-- One snapshot for the private map and the census: the ordinals agree.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- ── P2. PRIVATE ordinal -> object_id map (only with -v emit_private_map=1) ──
\if :{?emit_private_map}
\if :emit_private_map
\echo '-- PRIVATE: the lines below map ordinals to object ids. Keep them in the private record; never post them.'
SELECT 'CENSUS_PRIVATE ordinal=' || reg.ordinal || ' object_id=' || reg.object_id
  FROM (
    SELECT r.object_id,
           row_number() OVER (ORDER BY r.created_at, r.id) AS ordinal
      FROM integration_stock_prep_project_target r
     WHERE :'tenant' = '' OR r.tenant_id = :'tenant'
  ) reg
 ORDER BY reg.ordinal;
\endif
\endif

-- ── Q1. The census: one CENSUS_SHEET line per registry row, then the result ─
WITH
params AS (
  SELECT :'tenant'::text AS tenant
),
-- The exact JavaScript String.prototype.trim() whitespace set.
ws AS (
  SELECT chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
      || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
      || chr(8287) || chr(12288) || chr(65279) AS s
),
logical AS (
  SELECT ARRAY['projectNo', 'idempotencyKey', 'componentSourceId', 'parentSourceId', 'active']::text[] AS required,
         -- census-human-field-ids:begin (pinned to HUMAN_PRESERVED_FIELD_IDS by the plugin suite)
         ARRAY['materialType', 'blankType', 'stockPreparationStatus', 'demandDate', 'leadTimeDays', 'notes',
               'procurementReply', 'warehouseConfirmation', 'makeOrBuy', 'procurementDone',
               'procurementReplyDate', 'warehouseDone', 'actualArrivalDate']::text[] AS human
         -- census-human-field-ids:end
),
reg AS (
  SELECT r.project_no, r.sheet_id, r.object_id, r.status,
         row_number() OVER (ORDER BY r.created_at, r.id) AS ordinal,
         r.tenant_id || ':integration-core' AS staging_project
    FROM integration_stock_prep_project_target r
   CROSS JOIN params p
   WHERE p.tenant = '' OR r.tenant_id = p.tenant
),
derived AS (
  SELECT reg.*,
         'sheet_' || left(encode(digest(convert_to(reg.staging_project || ':' || reg.object_id, 'UTF8'), 'sha1'), 'hex'), 24) AS derived_sheet_id,
         (SELECT jsonb_object_agg(l.id, 'fld_' || left(encode(digest(convert_to(reg.staging_project || ':' || reg.object_id || ':' || l.id, 'UTF8'), 'sha1'), 'hex'), 24))
            FROM logical CROSS JOIN LATERAL unnest(logical.required || logical.human) AS l(id)) AS fid
    FROM reg
),
checked AS (
  SELECT d.*,
         CASE
           WHEN d.derived_sheet_id <> d.sheet_id THEN 'sheet_id_mismatch'
           WHEN NOT EXISTS (SELECT 1 FROM meta_sheets s
                             WHERE s.id = d.sheet_id AND (to_jsonb(s) ->> 'deleted_at') IS NULL) THEN 'sheet_missing'
           WHEN EXISTS (SELECT 1 FROM logical CROSS JOIN LATERAL unnest(logical.required) AS l(id)
                         WHERE NOT EXISTS (SELECT 1 FROM meta_fields f
                                            WHERE f.sheet_id = d.sheet_id AND f.id = d.fid ->> l.id)) THEN 'field_missing'
         END AS reason
    FROM derived d
),
cells AS (
  SELECT c.ordinal,
         m.data -> (c.fid ->> 'active') AS v_active,
         m.data -> (c.fid ->> 'parentSourceId') AS v_parent,
         m.data -> (c.fid ->> 'componentSourceId') AS v_component,
         m.data -> (c.fid ->> 'idempotencyKey') AS v_key,
         m.created_by,
         EXISTS (SELECT 1 FROM logical CROSS JOIN LATERAL unnest(logical.human) AS h(id)
                  WHERE NOT (m.data -> (c.fid ->> h.id) IS NULL
                             OR jsonb_typeof(m.data -> (c.fid ->> h.id)) = 'null'
                             OR (jsonb_typeof(m.data -> (c.fid ->> h.id)) = 'string'
                                 AND btrim(m.data -> (c.fid ->> h.id) #>> '{}', ws.s) = ''))) AS has_human
    FROM checked c
    JOIN meta_records m ON m.sheet_id = c.sheet_id
   CROSS JOIN ws
   WHERE c.reason IS NULL
     AND m.data ->> (c.fid ->> 'projectNo') = c.project_no
),
classified AS (
  SELECT x.ordinal,
         NOT COALESCE(jsonb_typeof(x.v_active) = 'boolean' AND x.v_active = 'false'::jsonb, false) AS is_active,
         (x.v_parent IS NULL OR jsonb_typeof(x.v_parent) = 'null'
           OR (jsonb_typeof(x.v_parent) = 'string' AND btrim(x.v_parent #>> '{}', ws.s) = '')) AS is_root,
         CASE WHEN jsonb_typeof(x.v_component) = 'string' AND btrim(x.v_component #>> '{}', ws.s) <> ''
              THEN x.v_component #>> '{}' END AS component,
         CASE WHEN jsonb_typeof(x.v_key) = 'string' AND btrim(x.v_key #>> '{}', ws.s) <> ''
              THEN x.v_key #>> '{}' END AS row_key,
         COALESCE(btrim(x.created_by, ws.s) <> '', false) AS has_creator,
         COALESCE(jsonb_typeof(x.v_active) NOT IN ('boolean', 'null'), false) AS non_boolean_active,
         x.has_human
    FROM cells x
   CROSS JOIN ws
),
components AS (
  SELECT k.ordinal, k.component,
         (bool_or(k.is_active AND k.is_root) AND bool_or(k.is_active AND NOT k.is_root)) AS two_copy,
         (bool_or(NOT k.is_active AND k.is_root) AND NOT bool_or(k.is_active AND k.is_root)
           AND bool_or(k.is_active AND NOT k.is_root)) AS remnant
    FROM classified k
   WHERE k.component IS NOT NULL
   GROUP BY k.ordinal, k.component
),
row_flags AS (
  SELECT k.*, COALESCE(cp.two_copy OR cp.remnant, false) AS doubled
    FROM classified k
    LEFT JOIN components cp ON cp.ordinal = k.ordinal AND cp.component = k.component
),
row_counts AS (
  SELECT f.ordinal,
         count(*) AS row_count,
         count(*) FILTER (WHERE f.is_active) AS active_row_count,
         count(*) FILTER (WHERE f.is_active AND f.row_key IS NULL AND NOT f.has_creator) AS keyless_rows_without_creator,
         count(*) FILTER (WHERE f.is_active AND f.row_key IS NULL AND f.has_creator) AS keyless_rows_with_creator,
         count(*) FILTER (WHERE f.non_boolean_active) AS non_boolean_active_cells,
         count(*) FILTER (WHERE NOT f.is_active AND f.has_human) AS inactive_rows_with_human_cells,
         count(*) FILTER (WHERE f.is_active AND NOT f.is_root AND f.doubled AND f.has_human) AS nested_copies_with_human_cells
    FROM row_flags f
   GROUP BY f.ordinal
),
component_counts AS (
  SELECT cp.ordinal,
         count(*) FILTER (WHERE cp.two_copy) AS two_copy_components,
         count(*) FILTER (WHERE cp.remnant) AS inactive_root_remnant_components
    FROM components cp
   GROUP BY cp.ordinal
),
key_counts AS (
  SELECT g.ordinal, count(*) AS duplicate_key_groups
    FROM (SELECT k.ordinal, k.row_key FROM classified k
           WHERE k.row_key IS NOT NULL
           GROUP BY k.ordinal, k.row_key
          HAVING count(*) >= 2) g
   GROUP BY g.ordinal
),
lines AS (
  SELECT 0 AS section, c.ordinal,
         'CENSUS_SHEET ordinal=' || c.ordinal || ' registry_status=' || c.status ||
         CASE WHEN c.reason IS NOT NULL THEN ' status=incomplete reason=' || c.reason
         ELSE ' status=complete'
           || ' row_count=' || COALESCE(rc.row_count, 0)
           || ' active_row_count=' || COALESCE(rc.active_row_count, 0)
           || ' two_copy_components=' || COALESCE(cc.two_copy_components, 0)
           || ' inactive_root_remnant_components=' || COALESCE(cc.inactive_root_remnant_components, 0)
           || ' duplicate_key_groups=' || COALESCE(kc.duplicate_key_groups, 0)
           || ' keyless_rows_without_creator=' || COALESCE(rc.keyless_rows_without_creator, 0)
           || ' keyless_rows_with_creator=' || COALESCE(rc.keyless_rows_with_creator, 0)
           || ' non_boolean_active_cells=' || COALESCE(rc.non_boolean_active_cells, 0)
           || ' inactive_rows_with_human_cells=' || COALESCE(rc.inactive_rows_with_human_cells, 0)
           || ' nested_copies_with_human_cells=' || COALESCE(rc.nested_copies_with_human_cells, 0)
           || ' sheet_rows_all_projects=' || (SELECT count(*) FROM meta_records m WHERE m.sheet_id = c.sheet_id)
         END AS line
    FROM checked c
    LEFT JOIN row_counts rc ON rc.ordinal = c.ordinal
    LEFT JOIN component_counts cc ON cc.ordinal = c.ordinal
    LEFT JOIN key_counts kc ON kc.ordinal = c.ordinal
  UNION ALL
  -- COMPLETENESS RESULT (always the LAST line). No CENSUS_RESULT line => the
  -- run aborted => INCOMPLETE, never "zero doubled sheets".
  SELECT 1 AS section, 0 AS ordinal,
         'CENSUS_RESULT file=01-sheet-census.sql status=' ||
         CASE WHEN count(*) FILTER (WHERE c.reason IS NOT NULL) = 0 THEN 'complete'
              ELSE 'incomplete reason=sheet_checks_failed' END ||
         ' sheets=' || count(*) ||
         ' complete=' || count(*) FILTER (WHERE c.reason IS NULL) ||
         ' incomplete=' || count(*) FILTER (WHERE c.reason IS NOT NULL) ||
         ' tenant_filter=' || CASE WHEN (SELECT tenant FROM params) = '' THEN 'off' ELSE 'on' END AS line
    FROM checked c
)
SELECT line FROM lines ORDER BY section, ordinal;

COMMIT;
