-- ============================================================================
-- approval-detail-attachment-census.sql — pre-merge gate for the
-- approval-detail-leaf-attachment-pin-20260904 branch (F1 / F6)
-- ============================================================================
-- Companion to packages/core-backend/src/services/ApprovalProductService.ts's
-- `normalizeDetailFieldParts` STORED_FORM_SCHEMA_CONTEXT tolerance and to
-- tests/unit/approval-detail-attachment-stored-context.test.ts. Counts how
-- many STORED templates/versions/instances actually carry an `attachment`
-- column inside a `detail` group's `columns` — the exact shape flag-OFF
-- `createTemplate` accepted before this branch's fix (and that the write
-- path now rejects unconditionally, in both flag states).
--
-- Why this matters: the read path (`asFormSchema` / STORED_FORM_SCHEMA_CONTEXT)
-- deliberately keeps TOLERATING this one shape so an already-stored template
-- does not start 500ing on read merely because this branch shipped (see the
-- comment at the `normalizeDetailFieldParts` leaf-check call site). That
-- tolerance is legacy scaffolding, not a design goal — it should eventually be
-- removed. This file is how an operator answers "is it safe to remove yet?"
-- without guessing: a 0/0/0 result means no stored data depends on the
-- tolerance and it can be deleted in a follow-up; a nonzero result names
-- exactly which rows still need a data migration (or an author revisit) first.
--
-- READ-ONLY BY CONSTRAINT (self-enforced, see the sibling self-test):
-- scripts/ops/approval-detail-attachment-census.test.mjs statically asserts
-- every top-level statement in this file is a SELECT/WITH — no INSERT/UPDATE/
-- DELETE/DDL. Run with a read-only role where available.
--
-- VALUES-FREE: every SELECT below returns COUNTS (and, for (c)'s WHY-ambiguous
-- note, a values-free id/updated_at listing capped by LIMIT) — never form
-- field labels, submitted values, requester identity, or any other row
-- content. Safe to paste into a PR body or a ticket.
--
-- HOW TO RUN:   psql "$DATABASE_URL" -f scripts/ops/approval-detail-attachment-census.sql
--
-- ============================================================================
-- THE PREDICATE
-- ============================================================================
-- A `form_schema` JSONB value matches when it has a top-level field of type
-- `detail` whose `columns` array contains at least one column of type
-- `attachment`. Expressed as a jsonpath filter (verified against PostgreSQL
-- 15/16 — jsonb_path_exists, SQL/JSON path support since PG12):
--
--   $.fields[*] ? (@.type == "detail") .columns[*] ? (@.type == "attachment")
--
-- This is a STRUCTURAL match (walks the real `fields`/`columns` array shape),
-- not a substring/LIKE search over the serialized JSON text — a field or
-- column merely LABELED "attachment" (e.g. a text field titled 附件说明)
-- does not match; only `"type": "attachment"` nested under a `"type":
-- "detail"` field's `columns` array does. A top-level `attachment` field
-- (the common, supported shape) also does NOT match — this predicate is
-- specifically the excluded/legacy nested shape.
--
-- ============================================================================
-- (c) AMBIGUITY NOTE — read before trusting the instances number
-- ============================================================================
-- `approval_instances.form_snapshot` (zzzz20260411120100_approval_templates_
-- and_instance_extensions.ts) is NOT a FormSchema. It is the SUBMITTED VALUES
-- for an instance's fields, keyed by field id (see ApprovalProductService.ts
-- createApproval's INSERT — `form_snapshot` is bound to `JSON.stringify(
-- normalizedFormData)`, the requester's answers, not the schema definition).
-- A detail field's value is an array of ROW OBJECTS keyed by column id — it
-- carries no `"type"` key at all, so the SAME jsonpath predicate used for (a)/
-- (b) against `form_schema` cannot be run against `form_snapshot` and would
-- silently return zero matches even for an instance built from an
-- attachment-in-detail template (a false-clean read, not a true absence) —
-- and a naive `form_snapshot::text ILIKE '%attachment%'` would go the other
-- way and false-positive on any ordinary attachment VALUE (e.g. a top-level
-- attachment field's stored file ids) that has nothing to do with this shape.
-- Neither is safe to report as "(c)".
--
-- The correct question for instances is therefore NOT "does this instance's
-- form_snapshot contain the word attachment" but "was this instance created
-- from a template VERSION whose form_schema matches the (b) predicate" —
-- answered by joining approval_instances.template_version_id to (b)'s result
-- set. Query (c) below does exactly that (a frozen-schema join, matching how
-- `getApproval`/dispatch actually resolve an instance's schema — via
-- template_version_id, never by re-deriving structure from form_snapshot).
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (a) approval_templates: templates whose ACTIVE OR LATEST version matches
-- ----------------------------------------------------------------------------
-- A template has no `form_schema` column of its own — the schema lives on its
-- versions. "Does this template match" is read as "does the version an author
-- or reader would currently see match" — active_version_id when published,
-- falling back to latest_version_id (mirrors loadTemplateBundleWithClient's
-- own `active_version_id || latest_version_id` preference for the default
-- 'active' read).
--
-- EXPECTED SHAPE: a single row. `matching_templates` counts approval_templates
-- rows; `total_templates` is the denominator (context, not itself the gate).
-- (a)
SELECT
  count(*) FILTER (
    WHERE jsonb_path_exists(
      v.form_schema,
      '$.fields[*] ? (@.type == "detail") .columns[*] ? (@.type == "attachment")'
    )
  ) AS matching_templates,
  count(*) AS total_templates
FROM approval_templates t
LEFT JOIN approval_template_versions v
  ON v.id = COALESCE(t.active_version_id, t.latest_version_id);

-- ----------------------------------------------------------------------------
-- (b) approval_template_versions: EVERY stored version matching, not just the
--     active/latest one per template — an author may have superseded the
--     matching version, but the row (and anything still pointing at it via
--     template_version_id, per (c)) persists.
-- ----------------------------------------------------------------------------
-- EXPECTED SHAPE: a single row. `matching_versions` counts
-- approval_template_versions rows; `total_versions` is the denominator.
-- (b)
SELECT
  count(*) FILTER (
    WHERE jsonb_path_exists(
      form_schema,
      '$.fields[*] ? (@.type == "detail") .columns[*] ? (@.type == "attachment")'
    )
  ) AS matching_versions,
  count(*) AS total_versions
FROM approval_template_versions;

-- ----------------------------------------------------------------------------
-- (c) approval_instances: instances FROZEN to a matching version — the
--     read-path-relevant count (see the AMBIGUITY NOTE above for why this is
--     a join to (b), not a scan of form_snapshot).
-- ----------------------------------------------------------------------------
-- EXPECTED SHAPE: a single row. `matching_instances` counts approval_instances
-- rows whose template_version_id resolves to a (b)-matching version;
-- `total_instances` is the denominator (all rows with a non-null
-- template_version_id — pre-template-system instances, if any survive, have
-- no version to match and are excluded from both counts by the join).
-- (c)
SELECT
  count(*) FILTER (WHERE v.id IS NOT NULL AND matched.is_match) AS matching_instances,
  count(*) FILTER (WHERE v.id IS NOT NULL) AS total_instances
FROM approval_instances i
LEFT JOIN approval_template_versions v ON v.id = i.template_version_id
LEFT JOIN LATERAL (
  SELECT jsonb_path_exists(
    v.form_schema,
    '$.fields[*] ? (@.type == "detail") .columns[*] ? (@.type == "attachment")'
  ) AS is_match
  WHERE v.id IS NOT NULL
) matched ON true;

-- ----------------------------------------------------------------------------
-- (c-detail) values-free locator for a nonzero (c) — template_version_id +
--     instance count only, capped, so an operator can find the affected
--     versions without this file (or its output) ever naming a template,
--     requester, or field value.
-- ----------------------------------------------------------------------------
-- EXPECTED SHAPE: 0 rows when (c)'s matching_instances = 0. Up to 50 rows
-- otherwise, one per matching template_version_id.
-- (c-detail)
SELECT
  v.template_id,
  v.id AS template_version_id,
  v.version,
  count(i.id) AS instance_count
FROM approval_template_versions v
JOIN approval_instances i ON i.template_version_id = v.id
WHERE jsonb_path_exists(
  v.form_schema,
  '$.fields[*] ? (@.type == "detail") .columns[*] ? (@.type == "attachment")'
)
GROUP BY v.template_id, v.id, v.version
ORDER BY instance_count DESC
LIMIT 50;
