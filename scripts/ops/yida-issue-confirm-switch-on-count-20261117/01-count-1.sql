-- ============================================================================
-- 01-count-1.sql - read-only, values-free count (1) for switching on the YiDa
--                  issue-confirm date write-back (slice Y9, register R-96 (7);
--                  runbook-yida-issue-confirm-writeback-switch-20261108.md,
--                  item 7 of 打开开关之前)
-- ============================================================================
-- WHEN. Immediately before EVERY switch-on of
-- INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: the first one and every
-- re-enable after a switch-off. Stop value 0: any other number, or no
-- PROBE_RESULT line at all, means do not switch on.
-- WHO. The owner, or a site operator the owner names, on the site database with
-- a read-only role. Never Claude (the count reads the customer's production
-- database: an owner-gated read-only step).
--
-- WHAT IT COUNTS (stock-prep ruling 2026-11-17). Over every row of the
-- project-sheet registry `integration_stock_prep_project_target` (active and
-- archived): the NON-EMPTY `issueConfirmDate` cells, empty being the
-- write-back's own D8 rule (absent, JSON null or ''), that are explained by
-- NEITHER
--   (i)  a dated write-back trace for that row: a row of
--        `integration_yida_issue_confirm_writeback` with outcome written,
--        already_set or written_inactive, on the same sheet and tenant, whose
--        written_date is exactly the cell (the cell is the JSON string
--        'YYYY-MM-DD'), and whose delivery ledger row names THIS row: the
--        ledger's creation_identity_digest equals
--          sha256(canonical({ version: 1, kind: 'yida-creation-identity',
--                             keyValue: <the row's idempotencyKey cell>,
--                             projectNo: <the registry row's project_no> }))
--        - the recipe of plugins/plugin-integration-core/lib/yida-draft-compiler.mjs
--        bindRow (keys sorted, JSON.stringify escaping; PostgreSQL to_json
--        escapes text the same way, and a key value holds no control character).
--        The trace stores no record id (migration zzzz20261106093100), so this
--        digest is the only per-row link SQL can recompute; and a cell whose
--        key is held by more than one record on its sheet is never explained
--        (one trace cannot tell which of them it wrote);
--   NOR (ii) a carry from a predecessor row whose cell is explained by (i).
--        NOT JOINABLE: no table records which predecessor a carry copied from.
--        Lines below are in plugins/plugin-integration-core/lib at final main
--        59876b3d6. The carry confirm (#6928) copies the machine date in the
--        patch of the successor row only (stock-preparation-confirm-writes.cjs
--        :1176-1199); the confirmation ledger row keeps the successor key
--        (`rowIdentity`) and folds the source key into the hashed
--        `inputFingerprint` only (stock-preparation-confirmation-decisions.cjs
--        :668-675, :677-690, :759-771; ledger fields
--        stock-preparation-templates.cjs:1168-1183), and that ledger close is
--        optional (http-routes.cjs:11671, :11831); the audit row keeps counts and
--        an optional decision id (http-routes.cjs:11859-11877;
--        stock-preparation-audit-store.cjs:257-266).
--        So a carried date is NOT auto-explained: it is counted. A non-zero
--        count after a carry is expected; stop and let the owner review.
--
-- OUTPUT (values-free: integers and closed tokens only; no id, key, project
-- number, sheet id or date):
--   COUNT1 sheets=<n> nonempty_cells=<n> explained_by_dated_trace=<n> unexplained=<n> carry_link=not_recorded
--   PROBE_RESULT file=01-count-1.sql status=complete count1=<n>
-- count1 = unexplained, the stop value. A run that prints no PROBE_RESULT line
-- aborted (error, timeout, cancel): that is NOT 0. status=incomplete (schema or
-- pgcrypto missing) is NOT 0 either.
--
-- PHYSICAL IDS (packages/core-backend/src/multitable/provisioning.ts stableMetaId;
-- the same derivation as scripts/ops/stock-prep-pull-batch-site-probe-20261107):
--   staging project = tenant_id || ':integration-core'
--   field id        = 'fld_' || first 24 hex of sha1(project ':' object_id ':' logical id)
-- The cells are read on the registry row's sheet_id (the sheet the write-back
-- writes and traces); count (2) of the same runbook item checks that sheet_id.
--
-- RUN WITH (SELECT only, one REPEATABLE READ READ ONLY snapshot):
--   psql "$READONLY_DATABASE_URL" -X -q -f 01-count-1.sql > count1.log 2>&1
--   optional: -v schema=public   -v tenant=<one tenant id (default: all)>
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off
\pset tuples_only on
\pset format unaligned

\if :{?schema}
  SET search_path = :"schema";
\endif
\if :{?tenant}
\else
  \set tenant ''
\endif

SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- P1. Refuse (as an explicit incomplete line) rather than error.
WITH need(t, c) AS (
  VALUES ('integration_stock_prep_project_target', 'tenant_id'),
         ('integration_stock_prep_project_target', 'project_no'),
         ('integration_stock_prep_project_target', 'sheet_id'),
         ('integration_stock_prep_project_target', 'object_id'),
         ('meta_records', 'id'),
         ('meta_records', 'sheet_id'),
         ('meta_records', 'data'),
         ('integration_yida_issue_confirm_writeback', 'ledger_id'),
         ('integration_yida_issue_confirm_writeback', 'tenant_id'),
         ('integration_yida_issue_confirm_writeback', 'sheet_id'),
         ('integration_yida_issue_confirm_writeback', 'outcome'),
         ('integration_yida_issue_confirm_writeback', 'written_date'),
         ('integration_yida_delivery_ledger', 'id'),
         ('integration_yida_delivery_ledger', 'tenant_id'),
         ('integration_yida_delivery_ledger', 'creation_identity_digest')
)
SELECT (current_setting('server_encoding') = 'UTF8') AS count1_utf8,
       (to_regprocedure('digest(bytea,text)') IS NOT NULL) AS count1_has_digest,
       NOT EXISTS (SELECT 1 FROM need n
                    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                                       WHERE ic.table_schema = ANY (current_schemas(false))
                                         AND ic.table_name = n.t AND ic.column_name = n.c)) AS count1_schema_ok
\gset

\if :count1_utf8
\else
  SELECT 'PROBE_RESULT file=01-count-1.sql status=incomplete reason=server_encoding_not_utf8';
  \quit
\endif
\if :count1_has_digest
\else
  SELECT 'PROBE_RESULT file=01-count-1.sql status=incomplete reason=pgcrypto_digest_missing';
  \quit
\endif
\if :count1_schema_ok
\else
  SELECT 'PROBE_RESULT file=01-count-1.sql status=incomplete reason=schema_missing';
  \quit
\endif

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH
params AS (
  SELECT :'tenant'::text AS tenant
),
reg AS (
  SELECT DISTINCT r.tenant_id, r.project_no, r.sheet_id, r.object_id,
         r.tenant_id || ':integration-core' AS staging_project
    FROM integration_stock_prep_project_target r
   CROSS JOIN params p
   WHERE p.tenant = '' OR r.tenant_id = p.tenant
),
fid AS (
  SELECT reg.*,
         'fld_' || left(encode(digest(convert_to(reg.staging_project || ':' || reg.object_id || ':issueConfirmDate', 'UTF8'), 'sha1'), 'hex'), 24) AS f_date,
         'fld_' || left(encode(digest(convert_to(reg.staging_project || ':' || reg.object_id || ':idempotencyKey', 'UTF8'), 'sha1'), 'hex'), 24) AS f_key
    FROM reg
),
-- Every record of every registered sheet, with the number of records on that sheet holding the same key cell. The
-- trace stores no record id, so one trace can only vouch for a key held by exactly ONE record (a copied row, e.g. a
-- right-click duplicate, carries the key and the date too; the write-back itself answers duplicate_key there).
recs AS (
  SELECT f.tenant_id, f.project_no, f.sheet_id, f.f_date, f.f_key, m.id AS record_id, m.data,
         count(*) OVER (PARTITION BY f.sheet_id, m.data -> f.f_key) AS key_holders
    FROM fid f
    JOIN meta_records m ON m.sheet_id = f.sheet_id
),
-- count1-nonempty:begin (D8: absent, JSON null and '' are empty; every other value is not)
cells AS (
  SELECT r.tenant_id, r.project_no, r.sheet_id, r.record_id, r.key_holders,
         r.data -> r.f_date AS date_cell,
         r.data -> r.f_key AS key_cell
    FROM recs r
   WHERE r.data ? r.f_date
     AND jsonb_typeof(r.data -> r.f_date) <> 'null'
     AND (r.data -> r.f_date) <> '""'::jsonb
),
-- count1-nonempty:end
judged AS (
  SELECT c.*,
         -- count1-dated-trace:begin
         c.key_holders = 1
         AND EXISTS (
           SELECT 1
             FROM integration_yida_issue_confirm_writeback t
             JOIN integration_yida_delivery_ledger l ON l.id = t.ledger_id AND l.tenant_id = t.tenant_id
            WHERE t.tenant_id = c.tenant_id
              AND t.sheet_id = c.sheet_id
              AND t.outcome IN ('written', 'already_set', 'written_inactive')
              AND t.written_date IS NOT NULL
              AND jsonb_typeof(c.date_cell) = 'string'
              AND (c.date_cell #>> '{}') = to_char(t.written_date, 'YYYY-MM-DD')
              AND jsonb_typeof(c.key_cell) = 'string'
              AND l.creation_identity_digest = encode(digest(convert_to(
                    '{"keyValue":' || to_json(c.key_cell #>> '{}')::text
                    || ',"kind":"yida-creation-identity","projectNo":' || to_json(c.project_no)::text
                    || ',"version":1}', 'UTF8'), 'sha256'), 'hex')
         ) AS explained
         -- count1-dated-trace:end
    FROM cells c
),
lines(ordinal, line) AS (
  SELECT 1, 'COUNT1 sheets=' || (SELECT count(DISTINCT sheet_id) FROM reg)
            || ' nonempty_cells=' || count(*)
            || ' explained_by_dated_trace=' || count(*) FILTER (WHERE explained)
            || ' unexplained=' || count(*) FILTER (WHERE NOT explained)
            || ' carry_link=not_recorded'
    FROM judged
  UNION ALL
  -- The completeness line, always LAST. No PROBE_RESULT line => the run aborted => NOT 0.
  SELECT 2, 'PROBE_RESULT file=01-count-1.sql status=complete count1=' || count(*) FILTER (WHERE NOT explained)
    FROM judged
)
SELECT line FROM lines ORDER BY ordinal;

COMMIT;
