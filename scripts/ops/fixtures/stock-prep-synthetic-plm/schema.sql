-- ---------------------------------------------------------------------------
-- SYNTHETIC PLM SOURCE — the seven tables the stock-preparation BOM read plan
-- addresses, in the shape proven against a live deployment.
--
-- THIS FILE IS A SHAPE, NOT A SOURCE. scripts/ops/stock-prep-acceptance-bootstrap.mjs
-- deliberately does NOT create or seed it: a deployment brings its own source
-- (a customer PLM, or a synthetic one an operator stood up). This schema exists
-- so that "stand up a synthetic source" is a copy/paste rather than an
-- archaeology exercise, and so the two gotchas below are written down where the
-- person hitting them is looking.
--
-- The plan this mirrors is PLM_STOCK_PREPARATION_BOM_READ_PLAN in
-- plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs
-- (id `plm.stock-preparation.bom-read.dn-pdm.v1`). Object/field names below are
-- that plan's DEFAULTS; a deployment that overrides the plan must move this
-- schema with it.
--
-- ===========================================================================
-- GOTCHA 1 — LOWER CASE IS NOT COSMETIC (PostgreSQL)
-- ===========================================================================
-- The read plan carries names like `DN_PDM_PartLibraryInfo` and `IdentityNo`,
-- and the SQL the read runtime emits does NOT quote them. PostgreSQL folds every
-- unquoted identifier to lower case, so an unquoted reference to
-- `DN_PDM_PartLibraryInfo` resolves to the relation `dn_pdm_partlibraryinfo`.
--
-- A table created as "DN_PDM_PartLibraryInfo" (double-quoted, and therefore
-- stored case-sensitively) is a DIFFERENT relation and the read fails with
-- `relation "dn_pdm_partlibraryinfo" does not exist` — which reads like a
-- missing table and is really a quoting mismatch.
--
-- Therefore: every CREATE TABLE / column below is written unquoted and
-- lower-case. Do not "tidy" them into quoted CamelCase.
--
-- (On SQL Server the same schema works with the plan's CamelCase spelling:
-- SQL Server does not fold identifiers, and the default collation is
-- case-insensitive. The lower-case form is compatible there too, which is why
-- this file uses one spelling for both.)
--
-- ===========================================================================
-- GOTCHA 2 — A MAPPED SOURCE COLUMN THAT DOES NOT EXIST IS SILENT
-- ===========================================================================
-- The `ext_` columns are filled by the ext-field mapping (server config
-- `stockPreparationExtFieldMapping`, see
-- plugins/plugin-integration-core/lib/stock-preparation-ext-field-mapping.cjs).
-- Every mapping entry reads ONE bare column off the PART row
-- (`dn_pdm_partlibraryinfo` — see applyExtFieldMapping's call site in
-- stock-preparation-bom-expansion.cjs, which passes `partRow`).
--
-- A mapping entry whose `sourceColumn` is absent from that row does NOT fail
-- the run. The cell is simply not produced, the row is still written, and the
-- `ext_` column stays EMPTY — indistinguishable, from the outside, from "the
-- source had no value". That is the failure mode the bootstrap script's
-- Criterion 1 exists to catch: it asserts every mapped `ext_` target is
-- non-empty on at least one written row.
--
-- Therefore: every column a mapping entry names MUST exist on
-- `dn_pdm_partlibraryinfo`. The `ext_source_*` columns at the bottom of that
-- table are placeholders for exactly that — rename them to whatever the
-- deployment's mapping actually names, and add more as the mapping grows.
--
-- ===========================================================================
-- No rows are seeded here. Seeding is a deployment decision (how many BOM
-- levels, how wide, which project numbers), and business values do not belong
-- in this repository.
-- ---------------------------------------------------------------------------

-- readPlan.pathExAttr — the project-number entry point.
--   object: DN_PDM_PathExAttrInfo, matchField: FileCode, pathIdField: Parent_OBJ_ID
CREATE TABLE IF NOT EXISTS dn_pdm_pathexattrinfo (
  filecode      varchar(128) NOT NULL,
  parent_obj_id varchar(64)  NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_dn_pdm_pathexattrinfo_filecode
  ON dn_pdm_pathexattrinfo (filecode);

-- readPlan.pathInfo — the path node the project number resolves to.
--   object: DN_PDM_PathInfo, idField: OBJ_ID
CREATE TABLE IF NOT EXISTS dn_pdm_pathinfo (
  obj_id varchar(64) NOT NULL PRIMARY KEY
);

-- readPlan.orderHead — orders hanging off a path node.
--   object: DN_PDM_OrderHeadInfo, idField: OBJ_ID, pathIdField: path_id
CREATE TABLE IF NOT EXISTS dn_pdm_orderheadinfo (
  obj_id  varchar(64) NOT NULL PRIMARY KEY,
  path_id varchar(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_dn_pdm_orderheadinfo_path_id
  ON dn_pdm_orderheadinfo (path_id);

-- readPlan.orderDetail — the order's top-level components.
--   object: DN_PDM_OrderDetailInfo, orderIdField: order_id,
--   componentIdField: part_id, quantityField: quantity, sortField: sort_id
CREATE TABLE IF NOT EXISTS dn_pdm_orderdetailinfo (
  order_id varchar(64)   NOT NULL,
  part_id  varchar(64)   NOT NULL,
  quantity numeric(18,6),
  sort_id  integer
);
CREATE INDEX IF NOT EXISTS ix_dn_pdm_orderdetailinfo_order_id
  ON dn_pdm_orderdetailinfo (order_id);

-- readPlan.part — the part library. THE ROW THE EXT-FIELD MAPPING READS.
--   object: DN_PDM_PartLibraryInfo, idField: OBJ_ID, codeField: IdentityNo,
--   nameField: IdentityName, materialField: Material, versionField: SysVer
CREATE TABLE IF NOT EXISTS dn_pdm_partlibraryinfo (
  obj_id       varchar(64)  NOT NULL PRIMARY KEY,
  identityno   varchar(128),
  identityname varchar(256),
  material     varchar(128),
  sysver       varchar(64),
  -- GOTCHA 2: every `sourceColumn` named by the deployment's ext-field mapping
  -- must exist here, or that `ext_` target silently stays empty on every row.
  -- Rename/extend these to match the mapping in use.
  ext_source_a varchar(256),
  ext_source_b varchar(256),
  ext_source_c varchar(256)
);

-- readPlan.bomHead — the BOM revision per parent part.
--   object: DN_PDM_BomHeadInfo, parentPartField: part_id, bomIdField: bom_id,
--   versionField: SysVer, activeField: bom_able
CREATE TABLE IF NOT EXISTS dn_pdm_bomheadinfo (
  part_id  varchar(64) NOT NULL,
  bom_id   varchar(64) NOT NULL,
  sysver   varchar(64),
  bom_able integer
);
CREATE INDEX IF NOT EXISTS ix_dn_pdm_bomheadinfo_part_id
  ON dn_pdm_bomheadinfo (part_id);

-- readPlan.bomDetail — the BOM's child lines. NOTE the quantity column:
-- `Bom_ExAttr1`. On the first customer PLM the quantity lives in an
-- ExAttr slot, not in a column called anything like "quantity" — the plan's
-- default encodes that, and so does this schema.
--   object: DN_PDM_BomDetailsInfo, bomParentField: bom_pid,
--   componentIdField: part_id, quantityField: Bom_ExAttr1, sortField: sort_id
CREATE TABLE IF NOT EXISTS dn_pdm_bomdetailsinfo (
  bom_pid      varchar(64) NOT NULL,
  part_id      varchar(64) NOT NULL,
  bom_exattr1  varchar(64),
  sort_id      integer
);
CREATE INDEX IF NOT EXISTS ix_dn_pdm_bomdetailsinfo_bom_pid
  ON dn_pdm_bomdetailsinfo (bom_pid);
