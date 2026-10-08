-- 076_create_integration_stock_prep_pack_installs.sql
-- plugin-integration-core · stock-prep customer-pack INSTALL LEDGER
--
-- WHY THIS TABLE EXISTS
-- The pack-aware refresh planner (derivePackAwarePlmWritableFields) needs to know WHICH `ext_`
-- columns a sheet actually carries and WHO owns them. The multitable provisioning surface has no
-- list-fields primitive — every read is keyed by ids the caller must already hold — so without a
-- record of what an install landed, the refresh path can only fall back to the frozen-template
-- bands. This ledger is that record: the CANDIDATE id set plus the pack PROVENANCE. It is NOT the
-- source of truth for what is live on the sheet; the host still is. A refresh reads the ids from
-- here and then re-reads them through readObjectFieldsContent, so a column deleted in the UI simply
-- drops out of the response and the ledger cannot resurrect it.
--
-- SHAPE REUSED FROM plugin_after_sales_template_installs (migration zzzz20260407140000), with the
-- disciplines that matter kept intact:
--   * TERMINAL STATES ONLY — 'installed' | 'partial' | 'failed'. There is never a 'pending' or
--     'installing' row: the installer UPSERTs only after the whole additive flow has completed, so
--     a crash mid-install leaves NO row and a retry is safe (the install itself is idempotent).
--   * status is DERIVED — warnings.length === 0 ? 'installed' : 'partial'.
--   * ONE ROW per install identity, refreshed by UPSERT (never appended). The identity here is
--     finer-grained than after-sales' (tenant_id, app_id): a pack lands on ONE object in ONE
--     project, and a tenant may install several packs, so the key is
--     (tenant_id, project_id, object_id, pack_id).
--   * mode records the LAST ATTEMPTED install mode. It is audit, not a statement of intent.
--
-- THE ONE GENUINE SHAPE EXTENSION over after-sales is installed_fields_json. After-sales stores a
-- flat array of created OBJECT ids; a pack install must store, per field, the ownership band that
-- decides whether a PLM refresh may overwrite that column. Entries are
--   [{ "fieldId": "ext_x", "ownership": "plm_system"|"human_preserved",
--      "preserveOnRefresh": bool, "extension": true }]
-- and fieldId is always the LOGICAL id (the host resolves logical -> physical), never a physical
-- one: physical ids are per-project derivations and would make the ledger unreadable after a move.
--
-- VALUES-FREE by construction, enforced store-side in
-- plugins/plugin-integration-core/lib/stock-preparation-pack-install-store.cjs:
--   * installed_fields_json — schema ids + the two frozen ownership tokens + booleans.
--   * summary_json          — numeric counts only.
--   * warnings_json         — enum-shaped tokens only.
-- No option value, no label, no business row ever reaches this table.
--
-- Ownership: logically owned by plugin-integration-core. Created by a CORE SQL migration because
-- there is no plugin-side migration runner (same reason as the after-sales ledger), and
-- deliberately NOT registered in packages/core-backend/src/db/types.ts — the plugin reaches it only
-- through the scoped CRUD helper in lib/db.cjs, whose ALLOWED_PREFIX is `integration_`.
--
-- Scoping follows 057/062/066: tenant_id NOT NULL; workspace_id nullable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_pack_installs (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  workspace_id          TEXT,
  project_id            TEXT NOT NULL,                 -- multitable project the pack landed in
  object_id             TEXT NOT NULL,                 -- canonical stock-preparation main table
  pack_id               TEXT NOT NULL,
  pack_version          TEXT NOT NULL,
  -- Last attempted install mode written with this terminal row (audit, not intent).
  mode                  TEXT NOT NULL CHECK (mode IN ('install', 'reinstall')),
  -- Terminal states only. A 'pending'/'installing' value is unrepresentable by design.
  status                TEXT NOT NULL CHECK (status IN ('installed', 'partial', 'failed')),
  -- [{fieldId, ownership, preserveOnRefresh, extension}] — LOGICAL field ids only.
  installed_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- numeric counts only (created / stamped / alreadyStamped / optionFields / views ...)
  summary_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- enum-shaped warning tokens only
  warnings_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_install_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The UPSERT key. One terminal row per (tenant, project, object, pack); a re-install refreshes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_stock_prep_pack_installs_identity
  ON integration_stock_prep_pack_installs (tenant_id, project_id, object_id, pack_id);

-- The refresh read: "which packs are installed on this sheet" (all packs, one object).
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_pack_installs_target
  ON integration_stock_prep_pack_installs (tenant_id, project_id, object_id);
