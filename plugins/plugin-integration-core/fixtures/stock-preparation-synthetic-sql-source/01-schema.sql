-- ============================================================================
-- Synthetic PLM BOM read source for the stock-preparation table action.
-- Target: any PostgreSQL 12+ database. 100% fabricated data — no customer
-- schema, no real drawing numbers, no hostnames, no credentials.
--
-- WHAT THIS IS
--   The 备料 (stock-preparation) BOM pull can only read through
--   `data-source:sql-readonly` / `bridge:legacy-sql-readonly`
--   (plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:21-24,
--   enforced in lib/stock-preparation-table-actions.cjs:132-137).
--   Until now no synthetic source existed, so the read -> plan -> apply path
--   could not be exercised without the customer's real database. These tables
--   are exactly the 7 objects the DEFAULT read plan reads
--   (lib/stock-preparation-bom-expansion.cjs:157-204), nothing more.
--
-- WHY THE IDENTIFIERS ARE UNQUOTED
--   The host Postgres adapter interpolates identifiers WITHOUT quoting —
--   packages/core-backend/src/data-adapters/PostgresAdapter.ts:173 emits
--   `SELECT * FROM ${this.sanitizeIdentifier(table)}`, and sanitizeIdentifier
--   (packages/core-backend/src/data-adapters/BaseAdapter.ts:265-281) only
--   VALIDATES the identifier, it does not quote it. So Postgres folds
--   `DN_PDM_PathExAttrInfo` -> `dn_pdm_pathexattrinfo` and `OBJ_ID` -> `obj_id`
--   on both sides. The names below are therefore written in the read plan's
--   own spelling but left UNQUOTED on purpose: adding double quotes anywhere
--   in this file would create genuinely mixed-case objects that the folded
--   query can no longer resolve. The plugin copes with the folded result-set
--   keys via the case-insensitive fallback in
--   lib/stock-preparation-bom-expansion.cjs:353-361 (readField).
--
-- WHICH NAMES ARE PLAN-CONFIGURABLE vs STRUCTURAL
--   CONFIGURABLE (per action, via INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON
--   -> action.source.readPlan; normalized at
--   lib/stock-preparation-bom-expansion.cjs:206-235):
--     every `object` value and every `*Field` value below — matchField,
--     pathExAttr.{object,matchField,pathIdField}, pathInfo.{object,idField},
--     orderHead.{object,idField,pathIdField},
--     orderDetail.{object,orderIdField,componentIdField,quantityField,sortField},
--     part.{object,idField,codeField,nameField,materialField,versionField},
--     bomHead.{object,parentPartField,bomIdField,versionField,activeField},
--     bomDetail.{object,bomParentField,componentIdField,quantityField,sortField},
--     and — only when the OPTIONAL block is present —
--     projectSubtree.pathInfo.parentIdField / projectSubtree.bomHead.pathIdField.
--     Rename the columns here and mirror the rename in the plan and the pull
--     still works.
--   STRUCTURAL (NOT configurable — changing these needs a code change):
--     * the 7-object shape and the traversal graph itself
--       (pathExAttr -> pathInfo -> orderHead -> orderDetail -> part
--        -> bomHead -> bomDetail -> part, lib/…-bom-expansion.cjs:624-835);
--     * `readPlan.matchField` MUST equal `readPlan.pathExAttr.matchField`
--       (…:229-233);
--     * which plan fields are REQUIRED vs OPTIONAL (…:221-227). OPTIONAL:
--       orderDetail.sortField, bomDetail.sortField, part.codeField/nameField/
--       materialField/versionField, bomHead.versionField/activeField.
--       Everything else is required;
--     * `sourceKind` ∈ {data-source:sql-readonly, bridge:legacy-sql-readonly}
--       (…:21-24);
--     * the emitted MetaSheet row field names (componentCode, totalQuantity, …)
--       — frozen by STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
--       (lib/stock-preparation-templates.cjs:522-593), not by this schema.
--
-- LOAD ORDER
--   01-schema.sql  ->  02-seed-pull-1.sql  ->  (pull #1)
--                  ->  03-seed-pull-2.sql  ->  (pull #2)
--   04-optional-duplicate-expanded-key.sql is applied ON TOP of 02 only when
--   you deliberately want the duplicate-key hold. See README.md.
--   05-seed-subtree-roots.sql is applied ON TOP of 02 only when you want the
--   OPTIONAL readPlan.projectSubtree path exercised. It is INERT for the
--   default plan: the order pull over 02 + 05 still returns the same 7 rows,
--   because nothing in the default plan reads Parent_OBJ_ID or path_id.
-- ============================================================================

DROP TABLE IF EXISTS DN_PDM_BomDetailsInfo;
DROP TABLE IF EXISTS DN_PDM_BomHeadInfo;
DROP TABLE IF EXISTS DN_PDM_PartLibraryInfo;
DROP TABLE IF EXISTS DN_PDM_OrderDetailInfo;
DROP TABLE IF EXISTS DN_PDM_OrderHeadInfo;
DROP TABLE IF EXISTS DN_PDM_PathInfo;
DROP TABLE IF EXISTS DN_PDM_PathExAttrInfo;

-- readPlan.pathExAttr — the project entry point.
-- Read once with { FileCode: <projectNo> } (…-bom-expansion.cjs:626).
CREATE TABLE DN_PDM_PathExAttrInfo (
  FileCode      varchar(64) NOT NULL,
  Parent_OBJ_ID varchar(64) NOT NULL
);

-- readPlan.pathInfo — existence/uniqueness check on the path the project
-- points at. More than one match => rowError 'ambiguous_path' (…:780-783).
--
-- Parent_OBJ_ID is the folder tree's self-reference and is read ONLY by the
-- OPTIONAL readPlan.projectSubtree block (projectSubtree.pathInfo.parentIdField).
-- Column name verified read-only against the customer test PLM on 2026-09-05
-- (`SELECT OBJ_ID, Parent_OBJ_ID FROM DN_PDM_PathInfo` succeeds); it is spelled
-- here exactly as it is there. NULL on a project (top) node.
CREATE TABLE DN_PDM_PathInfo (
  OBJ_ID        varchar(64) NOT NULL,
  Parent_OBJ_ID varchar(64)
);

-- readPlan.orderHead — the order(s) hanging off that path.
CREATE TABLE DN_PDM_OrderHeadInfo (
  OBJ_ID  varchar(64) NOT NULL,
  path_id varchar(64) NOT NULL
);

-- readPlan.orderDetail — the depth-0 (root) component lines.
-- quantity feeds BOTH rawQuantity and totalQuantity at depth 0 (…:816-826).
CREATE TABLE DN_PDM_OrderDetailInfo (
  order_id varchar(64) NOT NULL,
  part_id  varchar(64) NOT NULL,
  quantity numeric(18,6) NOT NULL,
  sort_id  integer
);

-- readPlan.part — component master. idField is the only required member;
-- the other four are optional and simply come back empty when absent.
CREATE TABLE DN_PDM_PartLibraryInfo (
  OBJ_ID       varchar(64) NOT NULL,
  IdentityNo   varchar(64),
  IdentityName varchar(128),
  Material     varchar(64),
  SysVer       varchar(32)
);

-- readPlan.bomHead — parent part -> BOM id.
-- The child read filters on { part_id: <parent OBJ_ID> } AND, when the parent
-- part row carried a SysVer, { SysVer: <that value> } (…:689-693). So a head
-- whose SysVer does not match its part's SysVer is INVISIBLE to the pull.
-- bom_able is the optional activeField: '0' / 'false' / 'n' / 'no' /
-- 'disabled' / 'inactive' / false / 0 mean inactive; anything else (including
-- NULL/empty) means active (isActiveBomHead, …:385-395).
--
-- path_id is the folder node this head hangs off, read ONLY by the OPTIONAL
-- readPlan.projectSubtree block (projectSubtree.bomHead.pathIdField). Column
-- name verified read-only against the customer test PLM on 2026-09-05
-- (`SELECT bom_id, part_id, path_id, SysVer FROM DN_PDM_BomHeadInfo` succeeds);
-- spelled here exactly as it is there. NULL on a head the folder tree does not
-- reference — the ORDER path never reads this column at all.
CREATE TABLE DN_PDM_BomHeadInfo (
  part_id  varchar(64) NOT NULL,
  bom_id   varchar(64) NOT NULL,
  SysVer   varchar(32),
  bom_able varchar(8),
  path_id  varchar(64)
);

-- readPlan.bomDetail — BOM lines. Bom_ExAttr1 is the quantity column (yes,
-- really: that is the plan default, …:201). A head with ZERO detail rows
-- produces rowError 'missing_child_bom' (…:718-724) and fails the plan.
CREATE TABLE DN_PDM_BomDetailsInfo (
  bom_pid     varchar(64) NOT NULL,
  part_id     varchar(64) NOT NULL,
  Bom_ExAttr1 numeric(18,6) NOT NULL,
  sort_id     integer
);

-- Indexes on exactly the columns the pull filters by. Not required for
-- correctness; present so a larger dataset behaves like a real source.
CREATE INDEX ix_syn_pathexattr_filecode ON DN_PDM_PathExAttrInfo (FileCode);
CREATE INDEX ix_syn_pathinfo_objid ON DN_PDM_PathInfo (OBJ_ID);
CREATE INDEX ix_syn_orderhead_pathid ON DN_PDM_OrderHeadInfo (path_id);
CREATE INDEX ix_syn_orderdetail_orderid ON DN_PDM_OrderDetailInfo (order_id);
CREATE INDEX ix_syn_part_objid ON DN_PDM_PartLibraryInfo (OBJ_ID);
CREATE INDEX ix_syn_bomhead_partid_sysver ON DN_PDM_BomHeadInfo (part_id, SysVer);
-- Only the OPTIONAL projectSubtree block filters by these two.
CREATE INDEX ix_syn_pathinfo_parentobjid ON DN_PDM_PathInfo (Parent_OBJ_ID);
CREATE INDEX ix_syn_bomhead_pathid ON DN_PDM_BomHeadInfo (path_id);
CREATE INDEX ix_syn_bomdetail_bompid ON DN_PDM_BomDetailsInfo (bom_pid);
