\ir _preamble.sql
-- ============================================================================
-- 01-top-level-attachment-census.sql — approval attachment canary readiness,
-- TOP-LEVEL `attachment` field census (F2-A1, 2026-09-30)
-- ============================================================================
-- Runbook: docs/development/approval-attachment-canary-runbook-20260930.md
--
-- WHAT THIS COUNTS: approval form schemas that carry an `attachment` field at
-- the TOP LEVEL of `form_schema.fields` — the shape that turns into a real
-- uploader on the fill page the moment APPROVAL_ATTACHMENTS_ENABLED goes ON
-- (apps/web/src/views/approval/ApprovalNewView.vue:522). The template authoring
-- UI cannot create this shape before attachment rung 4 (`attachment` is not an
-- AuthorableFieldType, apps/web/src/approvals/templateAuthoring.ts:87), so
-- every hit here is a historical or API-created template.
--
-- WHAT THIS DOES NOT COUNT: an `attachment` column INSIDE a `detail` group.
-- That census — and the (b) = 0 gate the runbook reads from it — lives in
-- OPEN PR #5476 (`scripts/ops/approval-detail-attachment-census.sql`, not on
-- main at the time of writing) and follows #5476's disposition (owner). This
-- file deliberately contains no detail-shaped predicate.
--
-- READ-ONLY BY CONSTRUCTION: every statement below is a SELECT; the preamble
-- sets default_transaction_read_only, so a write fails with SQLSTATE 25006.
-- Self-test: verify/census-pack.test.mjs (hermetic layer + synthetic
-- PostgreSQL layer; CI lane .github/workflows/ops-sql-pack-verify.yml).
--
-- VALUES-FREE: the output is counts, row ids (template / version), version
-- numbers, lifecycle statuses, booleans, and `jsonb_typeof` kind names. It
-- never prints a template name/key/description, a field id or label, a
-- submitted value, or any requester identity. Field ids are read inside the
-- (d) predicate only, never selected.
--
-- HOW TO RUN (read-only role, whole file, keep the log):
--   psql "$READONLY_DATABASE_URL" -v schema=public \
--     -f scripts/ops/approval-attachment-canary-census-20260930/01-top-level-attachment-census.sql \
--     > top-level-attachment-census.log 2>&1
--   grep '^INVENTORY_RESULT' top-level-attachment-census.log
-- No INVENTORY_RESULT line ⇒ the run is INCOMPLETE, never "zero".
--
-- THE PREDICATE (one definition, psql variable below; the self-test pins it):
--   $.fields[*] ? (@.type == "attachment")
-- A STRUCTURAL match on `fields[*].type`. A field merely labelled or id'd
-- "attachment", and an attachment column nested in a detail group, do NOT
-- match.
--
-- WHICH VERSION ROW EACH READER USES (main @ cffd5dacbc):
--   fill page     GET /api/approval-templates/:id → getTemplate reads 'latest'
--                 (ApprovalProductService.ts:6343), i.e.
--                 COALESCE(latest_version_id, active_version_id) (:13824).
--   form upload   POST /api/approval/attachments resolves the field against
--                 the ACTIVE version of a PUBLISHED template that has an active
--                 published definition (approval-attachment-runtime.ts:229-245).
--   instances     frozen on approval_instances.template_version_id.
-- ============================================================================

\set tla_path '$.fields[*] ? (@.type == "attachment")'

\echo '== approval attachment canary census — TOP-LEVEL attachment fields (values-free) =='
\echo '== detail-embedded attachment columns: NOT counted here — see #5476 census (owner disposition) =='

-- ----------------------------------------------------------------------------
-- (a) approval_templates — one row.
--   fill_page_templates      latest-read version has a top-level attachment
--                            field ⇒ the fill page renders the uploader flag-ON.
--   upload_target_templates  published + active version (with an active
--                            published definition) has one ⇒ the upload route
--                            accepts files for it flag-ON.
--   fill_page_not_upload_target  uploader shown, upload rejected (400
--                            not_an_attachment_field, routes/approval-attachments.ts:229)
--                            — typically a newer draft that added the field
--                            on top of a clean active one.
--   upload_target_not_fill_page  the reverse drift.
-- ----------------------------------------------------------------------------
SELECT
  count(*)::int AS total_templates,
  count(*) FILTER (WHERE latest_match)::int AS fill_page_templates,
  count(*) FILTER (WHERE upload_target)::int AS upload_target_templates,
  count(*) FILTER (WHERE latest_match AND NOT upload_target)::int AS fill_page_not_upload_target,
  count(*) FILTER (WHERE upload_target AND NOT latest_match)::int AS upload_target_not_fill_page
FROM (
  SELECT
    COALESCE(jsonb_path_exists(lv.form_schema, :'tla_path'), false) AS latest_match,
    COALESCE(
      t.status = 'published'
        AND jsonb_path_exists(av.form_schema, :'tla_path')
        AND EXISTS (
          SELECT 1
            FROM approval_published_definitions pd
           WHERE pd.template_version_id = av.id
             AND pd.is_active = TRUE
        ),
      false
    ) AS upload_target
  FROM approval_templates t
  LEFT JOIN approval_template_versions lv
    ON lv.id = COALESCE(t.latest_version_id, t.active_version_id)
  LEFT JOIN approval_template_versions av
    ON av.id = t.active_version_id
) tpl;

-- ----------------------------------------------------------------------------
-- (b) approval_template_versions — one row. EVERY stored version, any status
--     (draft / published / archived, current or superseded).
-- ----------------------------------------------------------------------------
SELECT
  count(*) FILTER (WHERE jsonb_path_exists(form_schema, :'tla_path'))::int AS matching_versions,
  count(*)::int AS total_versions
FROM approval_template_versions;

-- ----------------------------------------------------------------------------
-- (b-locate) one row per (b)-matching version — NO row cap, so its row count
--     must equal (b).matching_versions. Values-free locator: ids, version
--     number, status, which reader lands on it, how many attachment fields it
--     has, and how many instances are frozen on it.
-- ----------------------------------------------------------------------------
SELECT
  v.template_id,
  v.id AS template_version_id,
  v.version,
  v.status AS version_status,
  t.status AS template_status,
  COALESCE(t.active_version_id = v.id, false) AS is_active_version,
  COALESCE(COALESCE(t.latest_version_id, t.active_version_id) = v.id, false) AS is_fill_page_version,
  jsonb_array_length(jsonb_path_query_array(v.form_schema, :'tla_path'))::int AS attachment_field_count,
  (SELECT count(*) FROM approval_instances i WHERE i.template_version_id = v.id)::int AS frozen_instance_count
FROM approval_template_versions v
LEFT JOIN approval_templates t ON t.id = v.template_id
WHERE jsonb_path_exists(v.form_schema, :'tla_path')
ORDER BY v.template_id, v.version, v.id;

-- ----------------------------------------------------------------------------
-- (c) approval_instances frozen on a (b)-matching version — one row per
--     instance status (no rows ⇒ none). Pre-template-system instances (NULL
--     template_version_id) cannot match and are excluded by the join.
-- ----------------------------------------------------------------------------
SELECT
  i.status AS instance_status,
  count(*)::int AS frozen_instances
FROM approval_instances i
JOIN approval_template_versions v ON v.id = i.template_version_id
WHERE jsonb_path_exists(v.form_schema, :'tla_path')
GROUP BY i.status
ORDER BY i.status;

-- ----------------------------------------------------------------------------
-- (d) stored VALUES under those fields, by JSON kind only — one row per kind
--     (no rows ⇒ none). While the flag is OFF the only accepted value kinds are
--     `string` and `object` (ApprovalGraphExecutor.ts:539-541, legacy mode);
--     `array` is the flag-ON attachment-id array. Empty values (null, "", [],
--     {}) are not counted. Flag-ON, the detail page renders attachment fields
--     only from id arrays (apps/web/src/approvals/detailField.ts:588,
--     attachmentRefs.ts:77,104), so `string` / `object` rows here are the
--     instances whose old value stops showing inline after ON (static reading;
--     see the runbook UAT (a)).
-- ----------------------------------------------------------------------------
SELECT
  jsonb_typeof(i.form_snapshot -> (f.field ->> 'id')) AS value_kind,
  count(DISTINCT i.id)::int AS instances,
  count(*)::int AS field_values
FROM approval_instances i
JOIN approval_template_versions v ON v.id = i.template_version_id
CROSS JOIN LATERAL jsonb_path_query(v.form_schema, :'tla_path') AS f(field)
WHERE jsonb_typeof(i.form_snapshot) = 'object'
  AND (f.field ->> 'id') IS NOT NULL
  AND i.form_snapshot ? (f.field ->> 'id')
  AND (i.form_snapshot -> (f.field ->> 'id')) NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
GROUP BY 1
ORDER BY 1;

-- ----------------------------------------------------------------------------
-- COMPLETENESS RESULT — must stay the LAST statement. Reaching it means every
-- query above ran (ON_ERROR_STOP aborts on the first error).
-- ----------------------------------------------------------------------------
SELECT 'INVENTORY_RESULT file=01-top-level-attachment-census.sql status=complete predicate=top-level-attachment scope=top-level-only' AS inventory_result;
