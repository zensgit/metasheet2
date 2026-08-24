-- ============================================================================
-- PULL #2 state. Same complete-refill shape as 02: apply it after pull #1 has
-- been applied to the target sheet, then run dry-run again.
--
-- DELTA vs pull #1 — exactly two edits, both PLM-owned, structure otherwise
-- identical (same parts, same parents, same paths, same versions):
--
--   1. SYN-BOM-A -> SYN-PART-SUB-C quantity 1 -> 3
--      Rolls up: SUB-C total 2 -> 6, LEAF-D under C total 4 -> 12,
--      LEAF-E total 12 -> 36.  => 3 UPDATE decisions.
--   2. SYN-BOM-B -> SYN-PART-LEAF-F line DELETED.
--      Its row is now missing from the expansion while the target sheet still
--      holds it.  => 1 INACTIVE decision (missingFromPlmPolicy is pinned to
--      'mark_inactive', lib/stock-preparation-conflict-planner.cjs:151-162).
--
-- Deliberately NOT changed: componentCode / componentName / material /
-- sourceVersion. Those are IDENTITY_FIELD_IDS
-- (lib/stock-preparation-conflict-planner.cjs:40-45) and any change to them
-- produces a 'component_identity_conflict' manual_confirm instead of an
-- update, which would make this pull invalid. See README "what this fixture
-- deliberately does not cover".
--
-- Expected pull #2 result: status 'expanded', 6 rows, 0 errors, 0 rowErrors.
-- Expected plan against the pull-1 target rows: add 0 / update 3 / skip 3 /
-- inactive 1 / manual_confirm 0, valid = true.
-- Human-preserved cells (materialType, blankType, stockPreparationStatus,
-- demandDate, leadTimeDays, notes, procurementReply, warehouseConfirmation)
-- appear in NO patch — enforced by assertNoHumanFields in the planner.
-- ============================================================================

DELETE FROM DN_PDM_BomDetailsInfo;
DELETE FROM DN_PDM_BomHeadInfo;
DELETE FROM DN_PDM_PartLibraryInfo;
DELETE FROM DN_PDM_OrderDetailInfo;
DELETE FROM DN_PDM_OrderHeadInfo;
DELETE FROM DN_PDM_PathInfo;
DELETE FROM DN_PDM_PathExAttrInfo;

INSERT INTO DN_PDM_PathExAttrInfo (FileCode, Parent_OBJ_ID) VALUES
  ('SYN-PROJ-0001', 'SYN-PATH-1');

INSERT INTO DN_PDM_PathInfo (OBJ_ID) VALUES
  ('SYN-PATH-1');

INSERT INTO DN_PDM_OrderHeadInfo (OBJ_ID, path_id) VALUES
  ('SYN-ORDER-1', 'SYN-PATH-1');

INSERT INTO DN_PDM_OrderDetailInfo (order_id, part_id, quantity, sort_id) VALUES
  ('SYN-ORDER-1', 'SYN-PART-ROOT-A', 2, 10);

-- Unchanged from pull #1, on purpose: identity churn is a different case.
INSERT INTO DN_PDM_PartLibraryInfo (OBJ_ID, IdentityNo, IdentityName, Material, SysVer) VALUES
  ('SYN-PART-ROOT-A', 'SYN-A-1000', 'Synthetic Root Assembly A', 'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-SUB-B',  'SYN-B-2000', 'Synthetic Sub Assembly B',  'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-SUB-C',  'SYN-C-2100', 'Synthetic Sub Assembly C',  'SYN-MAT-ALU',   'V1'),
  ('SYN-PART-LEAF-D', 'SYN-D-3000', 'Synthetic Leaf Part D',     'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-LEAF-E', 'SYN-E-3100', 'Synthetic Leaf Part E',     'SYN-MAT-ALU',   'V1'),
  ('SYN-PART-LEAF-F', 'SYN-F-3200', 'Synthetic Leaf Part F',     'SYN-MAT-POLY',  'V1'),
  ('SYN-PART-LEAF-G', 'SYN-G-3300', 'Synthetic Leaf Part G',     'SYN-MAT-STEEL', 'V1');

INSERT INTO DN_PDM_BomHeadInfo (part_id, bom_id, SysVer, bom_able) VALUES
  ('SYN-PART-ROOT-A', 'SYN-BOM-A',         'V1', '1'),
  ('SYN-PART-SUB-B',  'SYN-BOM-B',         'V1', '1'),
  ('SYN-PART-SUB-C',  'SYN-BOM-C',         'V1', '1'),
  ('SYN-PART-SUB-C',  'SYN-BOM-C-RETIRED', 'V1', '0');

INSERT INTO DN_PDM_BomDetailsInfo (bom_pid, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-BOM-A',         'SYN-PART-SUB-B',  3, 10),
  ('SYN-BOM-A',         'SYN-PART-SUB-C',  3, 20),   -- CHANGED: was 1
  ('SYN-BOM-B',         'SYN-PART-LEAF-D', 4, 10),
  -- REMOVED: ('SYN-BOM-B', 'SYN-PART-LEAF-F', 5, 20)
  ('SYN-BOM-C',         'SYN-PART-LEAF-D', 2, 10),
  ('SYN-BOM-C',         'SYN-PART-LEAF-E', 6, 20),
  ('SYN-BOM-C-RETIRED', 'SYN-PART-LEAF-G', 9, 10);
