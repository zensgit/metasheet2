-- ============================================================================
-- fixture.sql — SYNTHETIC schema + rows for the top-level attachment census.
-- Kept under __fixtures__/ so repo-wide write-site scanners (e.g. the attendance
-- W4C-0 DML inventory) treat these synthetic INSERTs as test data, like
-- scripts/ops/__fixtures__/approval-s1-evidence-replay-gate-fixture.sql.
-- ============================================================================
-- Loaded by census-pack.test.mjs into a throwaway `a1census_fixture_*` schema
-- (search_path pinned by the harness). Only the columns the census reads, with
-- the production column TYPES (approval_instances.id is TEXT, version ids are
-- UUID — see zzzz20260411120100_approval_templates_and_instance_extensions.ts
-- and 20250924105000_create_approval_tables.ts). Every name / key / label /
-- field id / submitted value carries the marker `sentinelx` so the harness can
-- prove none of them ever reaches the census output (values-free).
--
-- Expected census readings are asserted in census-pack.test.mjs; the case
-- table there names what each template below is for.
-- ============================================================================

CREATE TABLE approval_templates (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  active_version_id UUID,
  latest_version_id UUID
);

CREATE TABLE approval_template_versions (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  form_schema JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE approval_published_definitions (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL,
  template_version_id UUID NOT NULL,
  is_active BOOLEAN NOT NULL
);

CREATE TABLE approval_instances (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  template_id UUID,
  template_version_id UUID,
  form_snapshot JSONB
);

-- ── templates ───────────────────────────────────────────────────────────────
-- T1 published, one version (active = latest), 2 top-level attachment fields
--    plus a detail group that ALSO nests an attachment column (not counted).
-- T2 published; active v1 clean, latest v2 draft adds an attachment field.
-- T3 published; v1 (superseded) had one, active = latest v2 is clean; v3 is an
--    'archived'-status version row that has one — the column CHECK allows
--    'archived' (zzzz20260411120100_approval_templates_and_instance_extensions.ts:32)
--    though the app never writes that status. Counted by (b) / (b-locate) only.
-- T4 published; attachment ONLY inside a detail group (#5476's shape) — no hit.
-- T5 published; a text field id'd/labelled "attachment" + select option — no hit.
-- T6 draft, never published; latest v1 has one.
-- T7 archived; active = latest v1 has one, published definition still active.
-- T8 published; active v1 has one but its published definition is inactive.
-- T9 published; active v1 has one, latest v2 draft removed it.
-- T11 draft; latest v1 form_schema is a JSON array (malformed) — no hit, no error.
INSERT INTO approval_templates (id, key, name, description, status, active_version_id, latest_version_id) VALUES
  ('11111111-0000-4000-8000-000000000001', 'sentinelx-key-t1', 'sentinelx name t1', 'sentinelx desc', 'published', 'a1a1a1a1-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000002', 'sentinelx-key-t2', 'sentinelx name t2', NULL, 'published', 'a2a2a2a2-0000-4000-8000-000000000001', 'a2a2a2a2-0000-4000-8000-000000000002'),
  ('11111111-0000-4000-8000-000000000003', 'sentinelx-key-t3', 'sentinelx name t3', NULL, 'published', 'a3a3a3a3-0000-4000-8000-000000000002', 'a3a3a3a3-0000-4000-8000-000000000002'),
  ('11111111-0000-4000-8000-000000000004', 'sentinelx-key-t4', 'sentinelx name t4', NULL, 'published', 'a4a4a4a4-0000-4000-8000-000000000001', 'a4a4a4a4-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000005', 'sentinelx-key-t5', 'sentinelx name t5', NULL, 'published', 'a5a5a5a5-0000-4000-8000-000000000001', 'a5a5a5a5-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000006', 'sentinelx-key-t6', 'sentinelx name t6', NULL, 'draft', NULL, 'a6a6a6a6-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000007', 'sentinelx-key-t7', 'sentinelx name t7', NULL, 'archived', 'a7a7a7a7-0000-4000-8000-000000000001', 'a7a7a7a7-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000008', 'sentinelx-key-t8', 'sentinelx name t8', NULL, 'published', 'a8a8a8a8-0000-4000-8000-000000000001', 'a8a8a8a8-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000009', 'sentinelx-key-t9', 'sentinelx name t9', NULL, 'published', 'a9a9a9a9-0000-4000-8000-000000000001', 'a9a9a9a9-0000-4000-8000-000000000002'),
  ('11111111-0000-4000-8000-000000000011', 'sentinelx-key-t11', 'sentinelx name t11', NULL, 'draft', NULL, 'abababab-0000-4000-8000-000000000001');

-- ── versions ────────────────────────────────────────────────────────────────
INSERT INTO approval_template_versions (id, template_id, version, status, form_schema) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_a","type":"attachment","label":"sentinelx label a"},
               {"id":"fld_sentinelx_b","type":"attachment","label":"sentinelx label b"},
               {"id":"fld_sentinelx_note","type":"text","label":"sentinelx note"},
               {"id":"fld_sentinelx_rows","type":"detail","label":"sentinelx rows","columns":[
                  {"id":"col_sentinelx_file","type":"attachment","label":"sentinelx col"}]}]}'),
  ('a2a2a2a2-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_a","type":"text","label":"sentinelx label"}]}'),
  ('a2a2a2a2-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002', 2, 'draft',
   '{"fields":[{"id":"fld_sentinelx_a","type":"text","label":"sentinelx label"},
               {"id":"fld_sentinelx_new","type":"attachment","label":"sentinelx new"}]}'),
  ('a3a3a3a3-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000003', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_c","type":"attachment","label":"sentinelx label c"}]}'),
  ('a3a3a3a3-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000003', 2, 'published',
   '{"fields":[{"id":"fld_sentinelx_c2","type":"text","label":"sentinelx label c2"}]}'),
  ('a3a3a3a3-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000003', 3, 'archived',
   '{"fields":[{"id":"fld_sentinelx_c3","type":"attachment","label":"sentinelx label c3"}]}'),
  ('a4a4a4a4-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000004', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_rows","type":"detail","label":"sentinelx rows","columns":[
                  {"id":"col_sentinelx_file","type":"attachment","label":"sentinelx col"}]}]}'),
  ('a5a5a5a5-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000005', 1, 'published',
   '{"fields":[{"id":"attachment","type":"text","label":"attachment"},
               {"id":"fld_sentinelx_kind","type":"select","label":"sentinelx kind",
                "options":[{"label":"attachment","value":"attachment"}]}]}'),
  ('a6a6a6a6-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000006', 1, 'draft',
   '{"fields":[{"id":"fld_sentinelx_d","type":"attachment","label":"sentinelx label d"}]}'),
  ('a7a7a7a7-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000007', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_e","type":"attachment","label":"sentinelx label e"}]}'),
  ('a8a8a8a8-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000008', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_f","type":"attachment","label":"sentinelx label f"}]}'),
  ('a9a9a9a9-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000009', 1, 'published',
   '{"fields":[{"id":"fld_sentinelx_g","type":"attachment","label":"sentinelx label g"}]}'),
  ('a9a9a9a9-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000009', 2, 'draft',
   '{"fields":[{"id":"fld_sentinelx_g2","type":"text","label":"sentinelx label g2"}]}'),
  ('abababab-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000011', 1, 'draft',
   '[{"id":"fld_sentinelx_h","type":"attachment"}]');

-- ── published definitions ───────────────────────────────────────────────────
INSERT INTO approval_published_definitions (id, template_id, template_version_id, is_active) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001', TRUE),
  ('d2d2d2d2-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002', 'a2a2a2a2-0000-4000-8000-000000000001', TRUE),
  ('d3d3d3d3-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000003', 'a3a3a3a3-0000-4000-8000-000000000001', FALSE),
  ('d3d3d3d3-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000003', 'a3a3a3a3-0000-4000-8000-000000000002', TRUE),
  ('d4d4d4d4-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000004', 'a4a4a4a4-0000-4000-8000-000000000001', TRUE),
  ('d5d5d5d5-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000005', 'a5a5a5a5-0000-4000-8000-000000000001', TRUE),
  ('d7d7d7d7-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000007', 'a7a7a7a7-0000-4000-8000-000000000001', TRUE),
  ('d8d8d8d8-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000008', 'a8a8a8a8-0000-4000-8000-000000000001', FALSE),
  ('d9d9d9d9-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000009', 'a9a9a9a9-0000-4000-8000-000000000001', TRUE);

-- ── instances ───────────────────────────────────────────────────────────────
-- inst-1 on T1v1: a string value and an object value (the two flag-OFF kinds).
-- inst-2 on T1v1: empty values only ("" and null) — not a stored value.
-- inst-3 on T1v1: an id array (the flag-ON kind).
-- inst-4 on T2v1 (clean version) with a same-named key — not frozen on a hit.
-- inst-5 on T3v1 (superseded hit version), rejected, object value.
-- inst-6 on T4v1 (detail-only shape) — not a top-level hit.
-- inst-7 on T1v1 with NULL form_snapshot — counted in (c), not in (d).
-- inst-8 pre-template-system (NULL template_version_id) — never a hit.
INSERT INTO approval_instances (id, status, template_id, template_version_id, form_snapshot) VALUES
  ('inst-1', 'pending',  '11111111-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001',
   '{"fld_sentinelx_a":"sentinelx value string","fld_sentinelx_b":{"fileName":"sentinelx value object.pdf"},"fld_sentinelx_note":"sentinelx note value"}'),
  ('inst-2', 'approved', '11111111-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001',
   '{"fld_sentinelx_a":"","fld_sentinelx_b":null}'),
  ('inst-3', 'pending',  '11111111-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001',
   '{"fld_sentinelx_a":["att_sentinelx_1"]}'),
  ('inst-4', 'pending',  '11111111-0000-4000-8000-000000000002', 'a2a2a2a2-0000-4000-8000-000000000001',
   '{"fld_sentinelx_a":"sentinelx value on clean version"}'),
  ('inst-5', 'rejected', '11111111-0000-4000-8000-000000000003', 'a3a3a3a3-0000-4000-8000-000000000001',
   '{"fld_sentinelx_c":{"name":"sentinelx value old"}}'),
  ('inst-6', 'pending',  '11111111-0000-4000-8000-000000000004', 'a4a4a4a4-0000-4000-8000-000000000001',
   '{"fld_sentinelx_rows":[{"col_sentinelx_file":"sentinelx value nested"}]}'),
  ('inst-7', 'pending',  '11111111-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001', NULL),
  ('inst-8', 'pending',  NULL, NULL, '{"fld_sentinelx_a":"sentinelx value legacy"}');
