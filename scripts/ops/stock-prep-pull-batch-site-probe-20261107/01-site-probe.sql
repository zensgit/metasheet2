-- ============================================================================
-- 01-site-probe.sql - read-only, values-free site probe for the stock-prep
--                     pull-batch install (pull batch BI-6a, design-final
--                     section 14 row BI-6a, owner item O-BI-9)
-- ============================================================================
-- WHAT IT DOES. For every row of the project-sheet registry
-- `integration_stock_prep_project_target` (migration 087; active AND archived)
-- and, when the operator names it, the deployment's env-bound sheet, it reports
-- the facts the per-sheet pull-batch install decision rests on: the target kind,
-- the PLM column lock, the view the sheet opens on, frozen views and personal
-- column orders, the created_at spread and add-stamp coverage, who created the
-- rows, manual / locked / trashed rows, and the automation rules, webhooks and
-- generic configured writers aimed at the sheet; plus the copies made of those
-- sheets and two site facts about the database time zone. SELECT only, inside
-- one REPEATABLE READ READ ONLY snapshot; CTEs only (no temp table, no view,
-- no function). No package is needed: it reads only relations and columns that
-- exist on the R line (onprem-r74 .. onprem-r82) and on main alike, and refuses
-- with an explicit incomplete line when one is missing (P1 below).
--
-- WHAT IT CANNOT SEE. The project-sheets switch
-- (MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED, exact 'true'), the table label
-- locale (MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE) and the Node process time
-- zone live in the host's app.env / process environment, not in the database.
-- 02-site-env.ps1 in this directory answers those, values-free (yes/no).
--
-- TARGET KINDS.
--   project  a registry row. object_shape=derived when the object id has the
--            project-sheet shape `plm_stock_preparation_sandbox_p_<24 hex>`,
--            adopted otherwise (an older sandbox sheet adopted by the runbook).
--   env      the deployment's env-bound sheet, only when the operator passes
--            -v env_project_id=<staging project id> -v env_object_id=<object id>
--            (both read PRIVATELY from the env table-action JSON; never echoed).
--            One PROBE_ENV_SHEET line, then one PROBE_PROJECT kind=env line per
--            project number found on that sheet.
--   copy     a sheet whose meta_sheets.copied_from_sheet_id chain leads to a
--            project or env sheet (sheet copy keeps the source creator and drops
--            the PLM lock). Copies get NEW field and view ids (copy-sheet-remap),
--            so only sheet-level counts are reported for them.
--
-- PHYSICAL IDS (identical on R74..R82 and main):
--   staging project = tenant_id || ':integration-core' (registry rows)
--   sheet id  = 'sheet_' || first 24 hex of sha1(project ':' object_id)
--   field id  = 'fld_'   || first 24 hex of sha1(project ':' object_id ':' logical id)
--   view id   = 'view_'  || first 24 hex of sha1(project ':' object_id ':' logical view id)
--   (packages/core-backend/src/multitable/provisioning.ts stableMetaId).
--
-- ROW CLASSES (design-final 8.4; per project = rows whose projectNo cell equals
--   the project number, the project-scoped reader's own equality filter):
--   creator       meta_records.created_by non-blank (JS trim whitespace set).
--   manual_rows   the idempotencyKey cell is a JSON string whose raw text starts
--                 'manual:v1:' (ADR adr-stock-prep-manual-rows-20261030).
--   machine_rows  no creator and not a manual row (plugin INSERTs name no creator).
--   person_rows   a creator and not a manual row: new-record button rows, imports and right-click
--                 duplicates. person_rows_with_key = those carrying a non-blank
--                 idempotencyKey (a right-click duplicate copies the PLM key).
--   locked_rows   meta_records.locked is true.
--   trashed_rows  meta_records_trash rows of the sheet whose stored projectNo
--                 cell equals the project number.
--
-- STAMPS (F24'): lastPlmRefreshDecision = 'add' marks the row the creating
--   execution wrote; lastPlmRefreshAt is that execution's PLAN time, a stored
--   string. A cell is never cast unless it is a strict ISO-8601 instant whose
--   day exists in its month, so one malformed cell cannot abort the run.
--   add_stamp_clusters        distinct raw plan-time strings over add rows.
--   add_stamps_after_create   add rows whose plan time is > created_at + 5 s
--                             (design 8.3 step 2: the degenerate-createdAt sign).
--   created_at_gap_clusters   1 + the number of gaps > 30 min between
--                             consecutive machine rows by created_at (the
--                             design's default G); 0 without machine rows.
--
-- VALUES-FREE (RD G4). Default output: ordinals, closed tokens and integers.
--   No project number, object id, sheet / field / view id, tenant, name, URL,
--   cell value or timestamp. Time zone facts are yes/no against -v expected_tz
--   (default Asia/Shanghai), never the zone itself. The ordinal -> handle map is
--   printed ONLY with -v emit_private_map=1 (PROBE_PRIVATE lines) and belongs in
--   the PRIVATE record, never in #6079, an issue or a PR body.
--
-- RUN WITH (the only supported form; see README.md):
--   psql "$READONLY_DATABASE_URL" -X -q -f 01-site-probe.sql
--   psql "$READONLY_DATABASE_URL" -X -q -v schema=public -v tenant=<tenant id> \
--        -v env_project_id=<project id> -v env_object_id=<object id> -f 01-site-probe.sql
-- ============================================================================

\ir _preamble.sql
\pset tuples_only on
\pset format unaligned

\if :{?tenant}
\else
  \set tenant ''
\endif
\if :{?env_project_id}
\else
  \set env_project_id ''
\endif
\if :{?env_object_id}
\else
  \set env_object_id ''
\endif
\if :{?env_sheet_id}
\else
  \set env_sheet_id ''
\endif
\if :{?expected_tz}
\else
  \set expected_tz 'Asia/Shanghai'
\endif

-- -- P1. Probe: refuse (as an explicit incomplete line) rather than error -----
-- probe-required-columns:begin (each pair is pinned to its creating migration by the plugin suite)
WITH need(t, c) AS (
  VALUES ('integration_stock_prep_project_target', 'id'),
         ('integration_stock_prep_project_target', 'tenant_id'),
         ('integration_stock_prep_project_target', 'project_no'),
         ('integration_stock_prep_project_target', 'sheet_id'),
         ('integration_stock_prep_project_target', 'object_id'),
         ('integration_stock_prep_project_target', 'status'),
         ('integration_stock_prep_project_target', 'created_at'),
         ('meta_sheets', 'id'),
         ('meta_sheets', 'copied_from_sheet_id'),
         ('meta_sheets', 'copied_at'),
         ('meta_fields', 'id'),
         ('meta_fields', 'sheet_id'),
         ('meta_fields', 'name'),
         ('meta_fields', 'property'),
         ('meta_views', 'id'),
         ('meta_views', 'sheet_id'),
         ('meta_views', 'config'),
         ('meta_views', 'created_at'),
         ('meta_view_personal_configs', 'view_id'),
         ('meta_view_personal_configs', 'config'),
         ('meta_records', 'sheet_id'),
         ('meta_records', 'data'),
         ('meta_records', 'created_by'),
         ('meta_records', 'created_at'),
         ('meta_records', 'locked'),
         ('meta_records_trash', 'sheet_id'),
         ('meta_records_trash', 'data'),
         ('automation_rules', 'sheet_id'),
         ('automation_rules', 'enabled'),
         ('automation_rules', 'action_config'),
         ('automation_rules', 'actions'),
         ('multitable_webhooks', 'active'),
         ('multitable_webhooks', 'sheet_id'),
         ('integration_external_systems', 'id'),
         ('integration_external_systems', 'kind'),
         ('integration_external_systems', 'config'),
         ('integration_pipelines', 'target_system_id'),
         ('integration_pipelines', 'status')
)
-- probe-required-columns:end
SELECT (current_setting('server_encoding') = 'UTF8') AS probe_utf8,
       (to_regprocedure('digest(bytea,text)') IS NOT NULL) AS probe_has_digest,
       NOT EXISTS (SELECT 1 FROM need n
                    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                                       WHERE ic.table_schema = ANY (current_schemas(false))
                                         AND ic.table_name = n.t AND ic.column_name = n.c)) AS probe_schema_ok,
       COALESCE((SELECT string_agg(n.t || '.' || n.c, ',' ORDER BY n.t, n.c) FROM need n
                  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                                     WHERE ic.table_schema = ANY (current_schemas(false))
                                       AND ic.table_name = n.t AND ic.column_name = n.c)), '') AS probe_missing
\gset

\if :probe_utf8
\else
  SELECT 'PROBE_RESULT file=01-site-probe.sql status=incomplete reason=server_encoding_not_utf8';
  \quit
\endif
\if :probe_has_digest
\else
  SELECT 'PROBE_RESULT file=01-site-probe.sql status=incomplete reason=pgcrypto_digest_missing';
  \quit
\endif
\if :probe_schema_ok
\else
  -- Schema identifiers only (table.column), never a value.
  SELECT 'PROBE_RESULT file=01-site-probe.sql status=incomplete reason=schema_missing missing=' || :'probe_missing';
  \quit
\endif

-- The private section of the one query below prints only when this is 1.
\set probe_private 0
\if :{?emit_private_map}
\if :emit_private_map
\echo '-- PRIVATE: the private lines of this run map ordinals to handles. Keep them in the private record; never post them.'
\set probe_private 1
\endif
\endif

-- One snapshot for everything, the private map included: the ordinals agree.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- -- Q1. The probe: site line, one line per target / project / copy, result --
WITH RECURSIVE
params AS (
  SELECT :'tenant'::text AS tenant,
         :'env_project_id'::text AS env_project,
         :'env_object_id'::text AS env_object,
         :'env_sheet_id'::text AS env_sheet,
         :'expected_tz'::text AS expected_tz,
         :'probe_private'::text AS private
),
-- The exact JavaScript String.prototype.trim() whitespace set.
ws AS (
  SELECT chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
      || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
      || chr(8287) || chr(12288) || chr(65279) AS s
),
logical AS (
  SELECT
         -- probe-plm-system-field-ids:begin (pinned to the main template's plm_system columns by the plugin suite)
         ARRAY['projectNo', 'idempotencyKey', 'componentSourceId', 'parentSourceId', 'parentComponentCode',
               'parentComponentName', 'path', 'depth', 'componentCode', 'componentName', 'componentSpec',
               'material', 'sourceVersion', 'rawQuantity', 'totalQuantity', 'active', 'lastPlmRefreshRunId',
               'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary']::text[] AS plm,
         -- probe-plm-system-field-ids:end
         -- probe-view-logical-ids:begin (host default view, fill view, to-fill view)
         ARRAY['default', 'prep-fill', 'prep-todo']::text[] AS views,
         -- probe-view-logical-ids:end
         'add'::text AS add_decision,
         chr(26377) || chr(25928) AS active_label_zh,
         'Active'::text AS active_label_en
),
reg AS (
  SELECT r.project_no, r.sheet_id, r.object_id, r.status,
         row_number() OVER (ORDER BY r.created_at, r.id) AS ordinal,
         r.tenant_id || ':integration-core' AS staging_project
    FROM integration_stock_prep_project_target r
   CROSS JOIN params p
   WHERE p.tenant = '' OR r.tenant_id = p.tenant
),
-- Every sheet the probe reads by derived ids: the registry sheets, then the env sheet.
tsheet AS (
  SELECT 'project'::text AS kind, reg.ordinal, reg.sheet_id, reg.staging_project, reg.object_id, reg.status,
         CASE WHEN reg.object_id ~ '^plm_stock_preparation_sandbox_p_[0-9a-f]{24}$' THEN 'derived' ELSE 'adopted' END AS object_shape
    FROM reg
  UNION ALL
  SELECT 'env'::text, 1::bigint,
         CASE WHEN p.env_sheet <> '' THEN p.env_sheet
              ELSE 'sheet_' || left(encode(digest(convert_to(p.env_project || ':' || p.env_object, 'UTF8'), 'sha1'), 'hex'), 24) END,
         p.env_project, p.env_object, 'env'::text, 'env'::text
    FROM params p
   WHERE p.env_project <> '' AND p.env_object <> ''
),
derived AS (
  SELECT t.*,
         'sheet_' || left(encode(digest(convert_to(t.staging_project || ':' || t.object_id, 'UTF8'), 'sha1'), 'hex'), 24) AS derived_sheet_id,
         (SELECT jsonb_object_agg(l.id, 'fld_' || left(encode(digest(convert_to(t.staging_project || ':' || t.object_id || ':' || l.id, 'UTF8'), 'sha1'), 'hex'), 24))
            FROM logical CROSS JOIN LATERAL unnest(logical.plm) AS l(id)) AS fid,
         (SELECT jsonb_object_agg(l.id, 'view_' || left(encode(digest(convert_to(t.staging_project || ':' || t.object_id || ':' || l.id, 'UTF8'), 'sha1'), 'hex'), 24))
            FROM logical CROSS JOIN LATERAL unnest(logical.views) AS l(id)) AS vid
    FROM tsheet t
),
checked AS (
  SELECT d.*,
         CASE
           WHEN d.derived_sheet_id <> d.sheet_id THEN 'sheet_id_mismatch'
           WHEN NOT EXISTS (SELECT 1 FROM meta_sheets s
                             WHERE s.id = d.sheet_id AND (to_jsonb(s) ->> 'deleted_at') IS NULL) THEN 'sheet_missing'
           WHEN NOT EXISTS (SELECT 1 FROM meta_fields f
                             WHERE f.sheet_id = d.sheet_id AND f.id = d.fid ->> 'projectNo') THEN 'field_missing'
         END AS reason
    FROM derived d
),
-- Sheet-level facts of every checked sheet (registry and env).
sheet_facts AS (
  SELECT c.kind, c.ordinal, c.sheet_id,
         (SELECT count(*) FROM logical l CROSS JOIN LATERAL unnest(l.plm) AS x(id)
            JOIN meta_fields f ON f.sheet_id = c.sheet_id AND f.id = c.fid ->> x.id) AS plm_cols_present,
         (SELECT count(*) FROM logical l CROSS JOIN LATERAL unnest(l.plm) AS x(id)
            JOIN meta_fields f ON f.sheet_id = c.sheet_id AND f.id = c.fid ->> x.id
           WHERE f.property ->> 'humanWriteLock' = 'plm_system') AS plm_cols_locked,
         (SELECT cardinality(l.plm) FROM logical l) AS plm_cols_total,
         (SELECT CASE WHEN f.name = l.active_label_zh THEN 'zh' WHEN f.name = l.active_label_en THEN 'en' ELSE 'other' END
            FROM meta_fields f CROSS JOIN logical l
           WHERE f.sheet_id = c.sheet_id AND f.id = c.fid ->> 'active') AS labels,
         (SELECT count(*) FROM meta_views v WHERE v.sheet_id = c.sheet_id) AS view_count,
         (SELECT count(*) FROM meta_views v
           WHERE v.sheet_id = c.sheet_id
             AND v.created_at = (SELECT min(v2.created_at) FROM meta_views v2 WHERE v2.sheet_id = c.sheet_id)) AS views_at_first,
         (SELECT CASE WHEN count(*) = 0 THEN 'none'
                      WHEN count(*) > 1 THEN 'tie'
                      WHEN bool_or(v.id = c.vid ->> 'default') THEN 'default'
                      WHEN bool_or(v.id = c.vid ->> 'prep-fill') THEN 'prep-fill'
                      WHEN bool_or(v.id = c.vid ->> 'prep-todo') THEN 'prep-todo'
                      ELSE 'other' END
            FROM meta_views v
           WHERE v.sheet_id = c.sheet_id
             AND v.created_at = (SELECT min(v2.created_at) FROM meta_views v2 WHERE v2.sheet_id = c.sheet_id)) AS first_view,
         (SELECT count(*) FROM meta_views v
           WHERE v.sheet_id = c.sheet_id AND v.id IN (c.vid ->> 'prep-fill', c.vid ->> 'prep-todo')) AS plugin_views,
         (SELECT count(*) FROM meta_views v
           WHERE v.sheet_id = c.sheet_id
             AND CASE WHEN jsonb_typeof(v.config -> 'frozenLeftColumnIds') = 'array'
                      THEN jsonb_array_length(v.config -> 'frozenLeftColumnIds') > 0
                           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.config -> 'frozenLeftColumnIds') e(x)
                                            WHERE jsonb_typeof(e.x) <> 'string')
                      ELSE false END) AS views_with_frozen,
         (SELECT count(*) FROM meta_view_personal_configs pc
            JOIN meta_views v ON v.id = pc.view_id
           WHERE v.sheet_id = c.sheet_id
             AND CASE WHEN jsonb_typeof(pc.config -> 'fieldOrder') = 'array'
                      THEN jsonb_array_length(pc.config -> 'fieldOrder') > 0
                      ELSE false END) AS personal_order_overrides,
         (SELECT count(*) FROM automation_rules a WHERE a.sheet_id = c.sheet_id) AS automation_rules,
         (SELECT count(*) FROM automation_rules a WHERE a.sheet_id = c.sheet_id AND a.enabled IS TRUE) AS automation_rules_enabled,
         (SELECT count(*) FROM automation_rules a
           WHERE a.sheet_id IS DISTINCT FROM c.sheet_id
             AND strpos(COALESCE(a.action_config::text, '') || ' ' || COALESCE(a.actions::text, ''), c.sheet_id) > 0) AS automation_rules_elsewhere,
         (SELECT count(*) FROM multitable_webhooks w WHERE w.sheet_id = c.sheet_id AND w.active IS TRUE) AS webhooks_active,
         (SELECT count(*) FROM integration_external_systems es
           WHERE es.kind = 'metasheet:multitable'
             AND CASE WHEN jsonb_typeof(es.config -> 'objects') = 'object'
                      THEN EXISTS (SELECT 1 FROM jsonb_each(es.config -> 'objects') o(k, v)
                                    WHERE jsonb_typeof(o.v) = 'object' AND o.v ->> 'sheetId' = c.sheet_id)
                      ELSE false END) AS writer_systems,
         (SELECT count(*) FROM integration_pipelines ip
           WHERE ip.target_system_id IN (
                   SELECT es.id FROM integration_external_systems es
                    WHERE es.kind = 'metasheet:multitable'
                      AND CASE WHEN jsonb_typeof(es.config -> 'objects') = 'object'
                               THEN EXISTS (SELECT 1 FROM jsonb_each(es.config -> 'objects') o(k, v)
                                             WHERE jsonb_typeof(o.v) = 'object' AND o.v ->> 'sheetId' = c.sheet_id)
                               ELSE false END)) AS writer_pipelines,
         (SELECT count(*) FROM integration_pipelines ip
           WHERE ip.status = 'active'
             AND ip.target_system_id IN (
                   SELECT es.id FROM integration_external_systems es
                    WHERE es.kind = 'metasheet:multitable'
                      AND CASE WHEN jsonb_typeof(es.config -> 'objects') = 'object'
                               THEN EXISTS (SELECT 1 FROM jsonb_each(es.config -> 'objects') o(k, v)
                                             WHERE jsonb_typeof(o.v) = 'object' AND o.v ->> 'sheetId' = c.sheet_id)
                               ELSE false END)) AS writer_pipelines_active,
         (SELECT count(*) FROM meta_records m WHERE m.sheet_id = c.sheet_id) AS sheet_rows_all_projects
    FROM checked c
   WHERE c.reason IS NULL
),
-- Projects: one per registry row; one per distinct project number on the env sheet.
env_projects AS (
  SELECT g.project_no, row_number() OVER (ORDER BY g.first_at, g.project_no) AS ordinal
    FROM (SELECT m.data ->> (c.fid ->> 'projectNo') AS project_no, min(m.created_at) AS first_at
            FROM checked c
            JOIN meta_records m ON m.sheet_id = c.sheet_id
           CROSS JOIN ws
           WHERE c.kind = 'env' AND c.reason IS NULL
             AND jsonb_typeof(m.data -> (c.fid ->> 'projectNo')) = 'string'
             AND btrim(m.data ->> (c.fid ->> 'projectNo'), ws.s) <> ''
           GROUP BY 1) g
),
units AS (
  SELECT c.kind, c.ordinal, c.sheet_id, c.fid, reg.project_no
    FROM checked c
    JOIN reg ON reg.ordinal = c.ordinal
   WHERE c.kind = 'project' AND c.reason IS NULL
  UNION ALL
  SELECT c.kind, ep.ordinal, c.sheet_id, c.fid, ep.project_no
    FROM checked c
   CROSS JOIN env_projects ep
   WHERE c.kind = 'env' AND c.reason IS NULL
),
cells AS (
  SELECT u.kind, u.ordinal, m.created_at,
         COALESCE(btrim(m.created_by, ws.s) <> '', false) AS has_creator,
         CASE WHEN jsonb_typeof(m.data -> (u.fid ->> 'idempotencyKey')) = 'string'
              THEN m.data ->> (u.fid ->> 'idempotencyKey') END AS row_key,
         COALESCE(jsonb_typeof(m.data -> (u.fid ->> 'active')) = 'boolean' AND m.data -> (u.fid ->> 'active') = 'false'::jsonb, false) AS is_inactive,
         COALESCE(jsonb_typeof(m.data -> (u.fid ->> 'lastPlmRefreshDecision')) = 'string'
                  AND m.data ->> (u.fid ->> 'lastPlmRefreshDecision') = (SELECT add_decision FROM logical), false) AS is_add,
         CASE WHEN jsonb_typeof(m.data -> (u.fid ->> 'lastPlmRefreshDecision')) = 'string'
              THEN btrim(m.data ->> (u.fid ->> 'lastPlmRefreshDecision'), ws.s) <> '' ELSE false END AS has_decision,
         CASE WHEN jsonb_typeof(m.data -> (u.fid ->> 'lastPlmRefreshAt')) = 'string'
              THEN m.data ->> (u.fid ->> 'lastPlmRefreshAt') END AS stamp,
         m.locked IS TRUE AS is_locked
    FROM units u
    JOIN meta_records m ON m.sheet_id = u.sheet_id AND m.data ->> (u.fid ->> 'projectNo') = u.project_no
   CROSS JOIN ws
),
stamped AS (
  SELECT x.*,
         COALESCE(x.stamp ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$', false) AS stamp_shape,
         COALESCE(x.row_key LIKE 'manual:v1:%', false) AS is_manual,
         COALESCE(btrim(x.row_key, ws.s) <> '', false) AS has_key
    FROM cells x
   CROSS JOIN ws
),
parsed AS (
  SELECT s.*,
         CASE WHEN s.stamp_shape
              THEN substr(s.stamp, 9, 2)::int <= extract(day FROM (make_date(substr(s.stamp, 1, 4)::int, substr(s.stamp, 6, 2)::int, 1) + interval '1 month' - interval '1 day'))
              ELSE false END AS stamp_ok
    FROM stamped s
),
classified AS (
  SELECT p.*,
         CASE WHEN p.stamp_ok THEN p.stamp::timestamptz END AS plan_at,
         NOT p.has_creator AND NOT p.is_manual AS is_machine
    FROM parsed p
),
gaps AS (
  SELECT k.kind, k.ordinal,
         k.created_at - lag(k.created_at) OVER (PARTITION BY k.kind, k.ordinal ORDER BY k.created_at) AS gap
    FROM classified k
   WHERE k.is_machine
),
gap_counts AS (
  SELECT g.kind, g.ordinal, 1 + count(*) FILTER (WHERE g.gap > interval '30 minutes') AS created_at_gap_clusters
    FROM gaps g
   GROUP BY g.kind, g.ordinal
),
trash_counts AS (
  SELECT u.kind, u.ordinal, count(t.sheet_id) AS trashed_rows
    FROM units u
    LEFT JOIN meta_records_trash t ON t.sheet_id = u.sheet_id AND t.data ->> (u.fid ->> 'projectNo') = u.project_no
   GROUP BY u.kind, u.ordinal
),
row_counts AS (
  SELECT k.kind, k.ordinal,
         count(*) AS row_count,
         count(*) FILTER (WHERE NOT k.is_inactive) AS active_row_count,
         count(*) FILTER (WHERE k.is_machine) AS machine_rows,
         count(*) FILTER (WHERE k.has_creator AND NOT k.is_manual) AS person_rows,
         count(*) FILTER (WHERE k.has_creator AND NOT k.is_manual AND k.has_key) AS person_rows_with_key,
         count(*) FILTER (WHERE k.is_manual) AS manual_rows,
         count(*) FILTER (WHERE k.is_locked) AS locked_rows,
         COALESCE(floor(extract(epoch FROM max(k.created_at) - min(k.created_at)) / 86400)::bigint, 0) AS created_span_days,
         count(DISTINCT date_trunc('day', k.created_at)) AS created_days,
         count(*) FILTER (WHERE k.has_decision) AS stamped_rows,
         count(*) FILTER (WHERE k.is_add) AS add_stamp_rows,
         count(*) FILTER (WHERE k.is_add AND k.stamp_ok) AS add_stamp_iso_rows,
         count(DISTINCT k.stamp) FILTER (WHERE k.is_add AND k.stamp_ok) AS add_stamp_clusters,
         count(*) FILTER (WHERE k.is_add AND k.plan_at > k.created_at + interval '5 seconds') AS add_stamps_after_create
    FROM classified k
   GROUP BY k.kind, k.ordinal
),
unit_lines AS (
  SELECT u.kind, u.ordinal,
         ' row_count=' || COALESCE(rc.row_count, 0)
      || ' active_row_count=' || COALESCE(rc.active_row_count, 0)
      || ' machine_rows=' || COALESCE(rc.machine_rows, 0)
      || ' person_rows=' || COALESCE(rc.person_rows, 0)
      || ' person_rows_with_key=' || COALESCE(rc.person_rows_with_key, 0)
      || ' manual_rows=' || COALESCE(rc.manual_rows, 0)
      || ' locked_rows=' || COALESCE(rc.locked_rows, 0)
      || ' trashed_rows=' || COALESCE(tc.trashed_rows, 0)
      || ' created_span_days=' || COALESCE(rc.created_span_days, 0)
      || ' created_days=' || COALESCE(rc.created_days, 0)
      || ' created_at_gap_clusters=' || COALESCE(gc.created_at_gap_clusters, 0)
      || ' stamped_rows=' || COALESCE(rc.stamped_rows, 0)
      || ' add_stamp_rows=' || COALESCE(rc.add_stamp_rows, 0)
      || ' add_stamp_iso_rows=' || COALESCE(rc.add_stamp_iso_rows, 0)
      || ' add_stamp_clusters=' || COALESCE(rc.add_stamp_clusters, 0)
      || ' add_stamps_after_create=' || COALESCE(rc.add_stamps_after_create, 0) AS counts
    FROM units u
    LEFT JOIN row_counts rc ON rc.kind = u.kind AND rc.ordinal = u.ordinal
    LEFT JOIN trash_counts tc ON tc.kind = u.kind AND tc.ordinal = u.ordinal
    LEFT JOIN gap_counts gc ON gc.kind = u.kind AND gc.ordinal = u.ordinal
),
sheet_lines AS (
  SELECT sf.kind, sf.ordinal,
         ' plm_lock=' || CASE WHEN sf.plm_cols_present = 0 THEN 'none'
                              WHEN sf.plm_cols_locked = sf.plm_cols_present AND sf.plm_cols_present = sf.plm_cols_total THEN 'all'
                              WHEN sf.plm_cols_locked = 0 THEN 'none'
                              ELSE 'partial' END
      || ' plm_cols_locked=' || sf.plm_cols_locked
      || ' plm_cols_unlocked=' || (sf.plm_cols_present - sf.plm_cols_locked)
      || ' plm_cols_missing=' || (sf.plm_cols_total - sf.plm_cols_present)
      || ' labels=' || COALESCE(sf.labels, 'missing')
      || ' view_count=' || sf.view_count
      || ' first_view=' || sf.first_view
      || ' views_at_first=' || sf.views_at_first
      || ' plugin_views=' || sf.plugin_views
      || ' views_with_frozen=' || sf.views_with_frozen
      || ' personal_order_overrides=' || sf.personal_order_overrides
      || ' automation_rules=' || sf.automation_rules
      || ' automation_rules_enabled=' || sf.automation_rules_enabled
      || ' automation_rules_elsewhere=' || sf.automation_rules_elsewhere
      || ' webhooks_active=' || sf.webhooks_active
      || ' writer_systems=' || sf.writer_systems
      || ' writer_pipelines=' || sf.writer_pipelines
      || ' writer_pipelines_active=' || sf.writer_pipelines_active
      || ' copies=' || (SELECT count(*) FROM copy_tree ct WHERE ct.root_kind = sf.kind AND ct.root_ordinal = sf.ordinal)
      || ' sheet_rows_all_projects=' || sf.sheet_rows_all_projects AS facts
    FROM sheet_facts sf
),
-- Copies of the probed sheets, any depth (a copy of a copy), live or soft-deleted.
copy_tree AS (
  SELECT s.id AS sheet_id, c.kind AS root_kind, c.ordinal AS root_ordinal, 1 AS depth, s.copied_at,
         (to_jsonb(s) ->> 'deleted_at') IS NOT NULL AS deleted
    FROM checked c
    JOIN meta_sheets s ON s.copied_from_sheet_id = c.sheet_id
   WHERE c.reason IS NULL OR c.reason = 'field_missing'
  UNION ALL
  SELECT s.id, ct.root_kind, ct.root_ordinal, ct.depth + 1, s.copied_at,
         (to_jsonb(s) ->> 'deleted_at') IS NOT NULL
    FROM copy_tree ct
    JOIN meta_sheets s ON s.copied_from_sheet_id = ct.sheet_id
   WHERE ct.depth < 8
),
copies AS (
  SELECT ct.*, row_number() OVER (ORDER BY ct.copied_at NULLS LAST, ct.sheet_id) AS ordinal
    FROM copy_tree ct
),
copy_lines AS (
  SELECT cp.ordinal,
         'PROBE_COPY ordinal=' || cp.ordinal
      || ' source_kind=' || cp.root_kind
      || ' source_ordinal=' || cp.root_ordinal
      || ' depth=' || cp.depth
      || ' deleted=' || CASE WHEN cp.deleted THEN 'yes' ELSE 'no' END
      || ' row_count=' || (SELECT count(*) FROM meta_records m WHERE m.sheet_id = cp.sheet_id)
      || ' person_rows=' || (SELECT count(*) FROM meta_records m CROSS JOIN ws
                               WHERE m.sheet_id = cp.sheet_id AND COALESCE(btrim(m.created_by, ws.s) <> '', false))
      || ' locked_rows=' || (SELECT count(*) FROM meta_records m WHERE m.sheet_id = cp.sheet_id AND m.locked IS TRUE)
      || ' locked_fields=' || (SELECT count(*) FROM meta_fields f
                                 WHERE f.sheet_id = cp.sheet_id AND f.property ->> 'humanWriteLock' = 'plm_system')
      || ' view_count=' || (SELECT count(*) FROM meta_views v WHERE v.sheet_id = cp.sheet_id)
      || ' automation_rules=' || (SELECT count(*) FROM automation_rules a WHERE a.sheet_id = cp.sheet_id)
      || ' webhooks_active=' || (SELECT count(*) FROM multitable_webhooks w WHERE w.sheet_id = cp.sheet_id AND w.active IS TRUE) AS line
    FROM copies cp
),
site AS (
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p.expected_tz) AS tz_known,
         current_setting('TimeZone') = p.expected_tz AS tz_same_name,
         (SELECT extract(epoch FROM z.utc_offset) FROM pg_timezone_names z WHERE z.name = p.expected_tz)
           = extract(timezone FROM now()) AS tz_same_offset
    FROM params p
),
lines AS (
  SELECT 0 AS section, 0::bigint AS ordinal,
         'PROBE_SITE server_encoding_utf8=yes'
      || ' expected_tz_known=' || CASE WHEN st.tz_known THEN 'yes' ELSE 'no' END
      || ' db_timezone_is_expected=' || CASE WHEN st.tz_same_name THEN 'yes' ELSE 'no' END
      || ' db_utc_offset_is_expected=' || CASE WHEN st.tz_same_offset THEN 'yes' WHEN st.tz_known THEN 'no' ELSE 'unknown' END
      || ' registry_rows=' || (SELECT count(*) FROM reg)
      || ' webhooks_active_total=' || (SELECT count(*) FROM multitable_webhooks w WHERE w.active IS TRUE)
      || ' webhooks_active_unbound=' || (SELECT count(*) FROM multitable_webhooks w WHERE w.active IS TRUE AND w.sheet_id IS NULL)
      || ' writer_systems_total=' || (SELECT count(*) FROM integration_external_systems es WHERE es.kind = 'metasheet:multitable')
      || ' env_input=' || CASE WHEN (SELECT env_project <> '' AND env_object <> '' FROM params) THEN 'given' ELSE 'absent' END
      || ' tenant_filter=' || CASE WHEN (SELECT tenant FROM params) = '' THEN 'off' ELSE 'on' END AS line
    FROM site st
  UNION ALL
  SELECT 1, c.ordinal,
         'PROBE_PROJECT kind=project ordinal=' || c.ordinal || ' registry_status=' || c.status
      || ' object_shape=' || c.object_shape ||
         CASE WHEN c.reason IS NOT NULL THEN ' status=incomplete reason=' || c.reason
              ELSE ' status=complete' || sl.facts || ul.counts END
    FROM checked c
    LEFT JOIN sheet_lines sl ON sl.kind = c.kind AND sl.ordinal = c.ordinal
    LEFT JOIN unit_lines ul ON ul.kind = c.kind AND ul.ordinal = c.ordinal
   WHERE c.kind = 'project'
  UNION ALL
  SELECT 2, 0,
         'PROBE_ENV_SHEET' ||
         CASE WHEN c.reason IS NOT NULL THEN ' status=incomplete reason=' || c.reason
              ELSE ' status=complete'
                || ' in_registry=' || CASE WHEN EXISTS (SELECT 1 FROM reg WHERE reg.sheet_id = c.sheet_id) THEN 'yes' ELSE 'no' END
                || ' projects=' || (SELECT count(*) FROM env_projects)
                || ' rows_without_project=' || (SELECT count(*) FROM meta_records m CROSS JOIN ws
                                                  WHERE m.sheet_id = c.sheet_id
                                                    AND NOT COALESCE(jsonb_typeof(m.data -> (c.fid ->> 'projectNo')) = 'string'
                                                                     AND btrim(m.data ->> (c.fid ->> 'projectNo'), ws.s) <> '', false))
                || sl.facts END
    FROM checked c
    LEFT JOIN sheet_lines sl ON sl.kind = c.kind AND sl.ordinal = c.ordinal
   WHERE c.kind = 'env'
  UNION ALL
  SELECT 3, u.ordinal,
         'PROBE_PROJECT kind=env ordinal=' || u.ordinal || ' status=complete' || ul.counts
    FROM units u
    JOIN unit_lines ul ON ul.kind = u.kind AND ul.ordinal = u.ordinal
   WHERE u.kind = 'env'
  UNION ALL
  SELECT 4, cl.ordinal, cl.line FROM copy_lines cl
  UNION ALL
  -- probe-private:begin (the ONLY place a handle is selected; printed only with -v emit_private_map=1)
  SELECT 8, pv.grp * 1000000 + pv.ordinal, pv.line
    FROM (SELECT 1 AS grp, reg.ordinal, 'PROBE_PRIVATE kind=project ordinal=' || reg.ordinal || ' object_id=' || reg.object_id AS line FROM reg
          UNION ALL
          SELECT 2, ep.ordinal, 'PROBE_PRIVATE kind=env ordinal=' || ep.ordinal || ' project_no=' || ep.project_no FROM env_projects ep
          UNION ALL
          SELECT 3, cp.ordinal, 'PROBE_PRIVATE kind=copy ordinal=' || cp.ordinal || ' sheet_id=' || cp.sheet_id FROM copies cp) pv
   CROSS JOIN params p
   WHERE p.private = '1'
  -- probe-private:end
  UNION ALL
  -- COMPLETENESS RESULT (always the LAST line). No PROBE_RESULT line => the run
  -- aborted => INCOMPLETE, never "nothing to report".
  SELECT 9, 0,
         'PROBE_RESULT file=01-site-probe.sql status=' ||
         CASE WHEN count(*) FILTER (WHERE c.reason IS NOT NULL) = 0 THEN 'complete'
              ELSE 'incomplete reason=target_checks_failed' END ||
         ' targets=' || count(*) ||
         ' complete=' || count(*) FILTER (WHERE c.reason IS NULL) ||
         ' incomplete=' || count(*) FILTER (WHERE c.reason IS NOT NULL) ||
         ' copies=' || (SELECT count(*) FROM copies) ||
         ' env=' || CASE WHEN NOT bool_or(c.kind = 'env') OR count(*) = 0 THEN 'absent'
                         WHEN bool_or(c.kind = 'env' AND c.reason IS NOT NULL) THEN 'incomplete'
                         ELSE 'complete' END AS line
    FROM checked c
)
SELECT line FROM lines ORDER BY section, ordinal;

COMMIT;
