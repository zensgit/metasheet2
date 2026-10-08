-- ============================================================================
-- STRUCTURE-EXACT synthetic PLM BOM read source — mirrors the SHAPE of the
-- customer's real DN_PDM / DN_*_View schema family, so the only variable left
-- for an on-site test is the customer's DATA.
--
-- 100% fabricated. No customer schema names beyond the family spelling, no real
-- drawing numbers, no project codes, no names, no hostnames, no credentials.
-- Every identifier is SYN-/TZ- prefixed and every material grade is a published
-- national-standard designation (GB/T — industry vocabulary, not anyone's data).
--
-- WHY A SECOND FIXTURE (the first is stock-preparation-synthetic-sql-source/):
--   The first fixture proves the DEFAULT read plan's read surface, column for
--   column, and its guard test forbids any column the default plan never reads.
--   That is exactly right for the default plan — and exactly why it cannot carry
--   the columns THIS one has to: the customer's live views expose SEMANTIC
--   columns under the customer's own vocabulary (project_code, DrawingType 图号,
--   TargetName 名称, Material 材料, Specification 规格, the quantity in the
--   generic slot Bom_ExAttr1, and Createtime), and reading them needs a per-
--   action read-plan OVERRIDE plus the ext-field mapping. This fixture models
--   that shape and is driven by that override — see the rehearsal driver
--   __tests__/stock-preparation-structure-exact-rehearsal.test.cjs and the
--   REBIND read plan it carries.
--
-- WHAT THE RECON MEASURED (docs/development/takeover-beiliao-20260821, live
-- 2026-08-31 read of the customer test PLM):
--   * The BOM family is the DN PDM family — the dn-pdm-family preset
--     (plugins/plugin-integration-core/lib/source-vendor-presets) targets it.
--   * The semantic columns live on VIEWS (DN_BomHead_View / DN_Bom_View /
--     DN_BomDetails_View): bom_id, part_id, bom_pid (parent link), sort_id,
--     project_code, DrawingType (图号), TargetName (名称), Material (材料),
--     Specification (规格), Createtime/Creator, and quantity (总数量) hiding in
--     the generic dictionary slot Bom_ExAttr1.
--   * On the TEST db these are structurally present but UNPOPULATED (project_code
--     null, DrawingType null, names opaque GUIDs) — a skeleton with no business
--     content, which is why steps 1-2 cannot be demoed against it and why this
--     synthetic fixture exists.
--
-- IDENTIFIERS ARE UNQUOTED ON PURPOSE (same gotcha as the sibling fixture):
--   the host Postgres adapter interpolates identifiers WITHOUT quoting
--   (PostgresAdapter.ts:173 + BaseAdapter.ts sanitizeIdentifier), so Postgres
--   folds DN_BomHead_View -> dn_bomhead_view and DrawingType -> drawingtype on
--   both sides. Quoting any name here would create a genuinely mixed-case object
--   the folded query can no longer resolve. The plugin copes with the folded
--   result keys via the case-insensitive readField fallback.
--
-- THE 7-OBJECT TRAVERSAL IS STRUCTURAL, THE COLUMN NAMES ARE CONFIGURABLE:
--   expandPlmProjectBom always walks
--     project entry -> path -> root -> root line -> part
--                   -> bomHead -> bomDetail -> part (recursively).
--   The OBJECT and *Field names are per-action config (action.source.readPlan).
--   The rehearsal driver overrides them to the customer vocabulary below. The
--   three project/root objects model HOW A PROJECT ANCHORS ITS TOP ASSEMBLY —
--   the one binding the recon could NOT trace against the empty test data, and
--   the one the on-site runbook flags as the single thing to confirm live.
--
-- LOAD ORDER
--   01-schema.sql -> 02-seed-batch-1.sql -> (pull, batch #1, Createtime hour 09)
--                 -> 03-seed-batch-2.sql -> (re-pull, batch #2, hour 10)
-- ============================================================================

DROP TABLE IF EXISTS DN_BomDetails_View;
DROP TABLE IF EXISTS DN_BomHead_View;
DROP TABLE IF EXISTS DN_PartLibrary_View;
DROP TABLE IF EXISTS DN_ProjectRootLine_View;
DROP TABLE IF EXISTS DN_ProjectRoot_View;
DROP TABLE IF EXISTS DN_ProjectPath_View;
DROP TABLE IF EXISTS DN_Project_View;

-- readPlan.pathExAttr — the PROJECT SEARCH entry point. Matched once with
-- { project_code: <the searched project> }. project_code is the customer's own
-- project column (recon: native on the BOM views). A search that matches zero
-- rows is the not_found branch — the guard that stops a phantom project pulling.
CREATE TABLE DN_Project_View (
  project_code varchar(64) NOT NULL,
  path_id      varchar(64) NOT NULL
);

-- readPlan.pathInfo — existence/uniqueness of the path a project points at.
CREATE TABLE DN_ProjectPath_View (
  path_id varchar(64) NOT NULL
);

-- readPlan.orderHead — the project's top-assembly anchor. ON SITE this maps to
-- however the customer identifies a project's root BOM (the binding to confirm).
CREATE TABLE DN_ProjectRoot_View (
  root_id varchar(64) NOT NULL,
  path_id varchar(64) NOT NULL
);

-- readPlan.orderDetail — the depth-0 (root) component line(s). The quantity is
-- read from the generic dictionary slot Bom_ExAttr1, EXACTLY as on the BOM side
-- (recon: 数量藏在 Bom_ExAttr1). It feeds both rawQuantity and totalQuantity at
-- depth 0.
CREATE TABLE DN_ProjectRootLine_View (
  root_id     varchar(64)   NOT NULL,
  part_id     varchar(64)   NOT NULL,
  Bom_ExAttr1 numeric(18,6) NOT NULL,
  sort_id     integer
);

-- readPlan.part — the part/material master. idField (part_id) is required; the
-- rest are the customer's SEMANTIC columns:
--   DrawingType   图号   -> componentCode  (plan.part.codeField)
--   TargetName    名称   -> componentName  (plan.part.nameField)
--   Material      材料   -> material        (plan.part.materialField)
--   SysVer        版本   -> sourceVersion   (plan.part.versionField)
-- Specification (规格), Createtime and Creator are NOT canonical row columns:
-- they are read off THIS row by the ext-field mapping into ext_spec / ext_designer
-- (and Createtime feeds the batch-hour rule the driver applies). They are the
-- denormalized attributes a real 备料 landing sheet carries.
CREATE TABLE DN_PartLibrary_View (
  part_id       varchar(64) NOT NULL,
  DrawingType   varchar(64),
  TargetName    varchar(128),
  Material      varchar(64),
  Specification varchar(64),
  Createtime    varchar(32),
  Creator       varchar(64),
  SysVer        varchar(32)
);

-- readPlan.bomHead — parent part -> BOM id, pinned per version. bom_able is the
-- optional activeField: '0'/'false'/'n'/'no'/'disabled'/'inactive' mean inactive,
-- anything else (incl. null) means active.
CREATE TABLE DN_BomHead_View (
  part_id  varchar(64) NOT NULL,
  bom_id   varchar(64) NOT NULL,
  SysVer   varchar(32),
  bom_able varchar(8)
);

-- readPlan.bomDetail — BOM child lines. Bom_ExAttr1 is the quantity slot (总数量
-- per line, before roll-up). bom_pid is the parent link; part_id is the child.
CREATE TABLE DN_BomDetails_View (
  bom_pid     varchar(64)   NOT NULL,
  part_id     varchar(64)   NOT NULL,
  Bom_ExAttr1 numeric(18,6) NOT NULL,
  sort_id     integer
);

-- Indexes on exactly the columns the pull filters by (behaviour parity with a
-- real source; not required for correctness).
CREATE INDEX ix_sx_project_code       ON DN_Project_View (project_code);
CREATE INDEX ix_sx_path_id            ON DN_ProjectPath_View (path_id);
CREATE INDEX ix_sx_root_pathid        ON DN_ProjectRoot_View (path_id);
CREATE INDEX ix_sx_rootline_rootid    ON DN_ProjectRootLine_View (root_id);
CREATE INDEX ix_sx_part_partid        ON DN_PartLibrary_View (part_id);
CREATE INDEX ix_sx_bomhead_partid_ver ON DN_BomHead_View (part_id, SysVer);
CREATE INDEX ix_sx_bomdetail_bompid   ON DN_BomDetails_View (bom_pid);
