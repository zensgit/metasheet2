-- R12 installation census. Run using psql -X -w -qAt -v ON_ERROR_STOP=1 -f <file>.
-- Use the same approved connection as s06. Optionally pass -v schema=<schema>.
-- Only the two counts and the completion marker belong in the QA report.
\set ON_ERROR_STOP on
\pset pager off
\pset tuples_only on
\pset format unaligned

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
-- A role subject to an RLS policy must error instead of returning a partial census.
SET LOCAL row_security = off;
\if :{?schema}
\else
  \set schema public
\endif
SET LOCAL search_path = :"schema", public;

WITH multisource_orgs AS (
  -- Same active-source predicate and identity as directory/pull-source-rule.ts.
  SELECT i.org_id
  FROM :"schema".directory_integrations i
  WHERE i.provider <> 'local' AND i.status = 'active'
  GROUP BY i.org_id
  HAVING count(DISTINCT (i.provider, i.corp_id)) >= 2
), registered_fields AS (
  -- Same physical field ID as the YiDa issue-confirm count probe.
  -- Include active and archived registry entries. Count each physical cell once.
  SELECT DISTINCT r.sheet_id,
         'fld_' || left(encode(digest(
           convert_to(r.tenant_id || ':integration-core:' || r.object_id || ':issueConfirmDate', 'UTF8'),
           'sha1'
         ), 'hex'), 24) AS field_id
  FROM :"schema".integration_stock_prep_project_target r
), nonempty_cells AS (
  SELECT 1
  FROM registered_fields f
  JOIN :"schema".meta_records m ON m.sheet_id = f.sheet_id
  WHERE m.data ? f.field_id
    AND m.data -> f.field_id <> 'null'::jsonb
    AND m.data -> f.field_id <> '""'::jsonb
)
SELECT format(
  'R12COUNT orgs_with_2plus_active_pull_sources=%s nonempty_issue_confirm_date_cells=%s',
  (SELECT count(*) FROM multisource_orgs),
  (SELECT count(*) FROM nonempty_cells)
);

ROLLBACK;
SELECT 'R12COUNT_RESULT file=r12-install-counts.sql status=complete';
