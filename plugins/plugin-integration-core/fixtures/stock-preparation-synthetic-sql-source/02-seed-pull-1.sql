-- ============================================================================
-- PULL #1 state. Complete, self-contained: every table is emptied and refilled,
-- so re-running this file always returns the source to the pull-1 state.
--
-- projectNo used by every route call: 'SYN-PROJ-0001'
--
-- Structure (all identifiers fabricated; SYN- prefix everywhere):
--
--   SYN-PART-ROOT-A            x2   depth 0   total 2
--   ├── SYN-PART-SUB-B         x3   depth 1   total 6
--   │   ├── SYN-PART-LEAF-D    x4   depth 2   total 24
--   │   └── SYN-PART-LEAF-F    x5   depth 2   total 30   <- REMOVED in pull #2
--   └── SYN-PART-SUB-C         x1   depth 1   total 2    <- qty CHANGED in pull #2
--       ├── SYN-PART-LEAF-D    x2   depth 2   total 4    <- D again, 2nd parent
--       └── SYN-PART-LEAF-E    x6   depth 2   total 12
--
--   SYN-PART-LEAF-G exists in the part master and sits under a RETIRED BOM head
--   (bom_able = '0'); it must NEVER appear in an expansion.
--
-- Expected pull #1 result: status 'expanded', 7 rows, 0 errors, 0 rowErrors.
-- Expected plan against an EMPTY target sheet: add 7 / update 0 / skip 0 /
-- inactive 0 / manual_confirm 0, valid = true.
-- ============================================================================

DELETE FROM DN_PDM_BomDetailsInfo;
DELETE FROM DN_PDM_BomHeadInfo;
DELETE FROM DN_PDM_PartLibraryInfo;
DELETE FROM DN_PDM_OrderDetailInfo;
DELETE FROM DN_PDM_OrderHeadInfo;
DELETE FROM DN_PDM_PathInfo;
DELETE FROM DN_PDM_PathExAttrInfo;

-- Project entry point. Exactly ONE row: a second row with the same FileCode
-- would be a second root path, not an error, but it is not what we want here.
INSERT INTO DN_PDM_PathExAttrInfo (FileCode, Parent_OBJ_ID) VALUES
  ('SYN-PROJ-0001', 'SYN-PATH-1');

-- Exactly one match, or the pull raises rowError 'ambiguous_path'.
INSERT INTO DN_PDM_PathInfo (OBJ_ID) VALUES
  ('SYN-PATH-1');

INSERT INTO DN_PDM_OrderHeadInfo (OBJ_ID, path_id) VALUES
  ('SYN-ORDER-1', 'SYN-PATH-1');

-- Depth-0 line: 2 x root assembly.
INSERT INTO DN_PDM_OrderDetailInfo (order_id, part_id, quantity, sort_id) VALUES
  ('SYN-ORDER-1', 'SYN-PART-ROOT-A', 2, 10);

INSERT INTO DN_PDM_PartLibraryInfo (OBJ_ID, IdentityNo, IdentityName, Material, SysVer) VALUES
  ('SYN-PART-ROOT-A', 'SYN-A-1000', 'Synthetic Root Assembly A', 'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-SUB-B',  'SYN-B-2000', 'Synthetic Sub Assembly B',  'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-SUB-C',  'SYN-C-2100', 'Synthetic Sub Assembly C',  'SYN-MAT-ALU',   'V1'),
  ('SYN-PART-LEAF-D', 'SYN-D-3000', 'Synthetic Leaf Part D',     'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-LEAF-E', 'SYN-E-3100', 'Synthetic Leaf Part E',     'SYN-MAT-ALU',   'V1'),
  ('SYN-PART-LEAF-F', 'SYN-F-3200', 'Synthetic Leaf Part F',     'SYN-MAT-POLY',  'V1'),
  ('SYN-PART-LEAF-G', 'SYN-G-3300', 'Synthetic Leaf Part G',     'SYN-MAT-STEEL', 'V1');

-- SysVer on every head matches its part's SysVer, otherwise the child read
-- (filtered by part_id AND SysVer) finds nothing and the subtree silently
-- disappears. SYN-BOM-C-RETIRED is the negative control: bom_able = '0'.
INSERT INTO DN_PDM_BomHeadInfo (part_id, bom_id, SysVer, bom_able) VALUES
  ('SYN-PART-ROOT-A', 'SYN-BOM-A',         'V1', '1'),
  ('SYN-PART-SUB-B',  'SYN-BOM-B',         'V1', '1'),
  ('SYN-PART-SUB-C',  'SYN-BOM-C',         'V1', '1'),
  ('SYN-PART-SUB-C',  'SYN-BOM-C-RETIRED', 'V1', '0');

INSERT INTO DN_PDM_BomDetailsInfo (bom_pid, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-BOM-A',         'SYN-PART-SUB-B',  3, 10),
  ('SYN-BOM-A',         'SYN-PART-SUB-C',  1, 20),
  ('SYN-BOM-B',         'SYN-PART-LEAF-D', 4, 10),
  ('SYN-BOM-B',         'SYN-PART-LEAF-F', 5, 20),
  ('SYN-BOM-C',         'SYN-PART-LEAF-D', 2, 10),
  ('SYN-BOM-C',         'SYN-PART-LEAF-E', 6, 20),
  ('SYN-BOM-C-RETIRED', 'SYN-PART-LEAF-G', 9, 10);
