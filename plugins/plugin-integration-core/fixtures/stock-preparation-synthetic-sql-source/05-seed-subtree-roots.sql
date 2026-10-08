-- ============================================================================
-- OPTIONAL fixture — applied ON TOP of 02-seed-pull-1.sql (additive INSERT and
-- one UPDATE-free re-INSERT only). It exercises the OPTIONAL
-- `readPlan.projectSubtree` block: root discovery through the project's FOLDER
-- TREE instead of (in addition to) the order module.
--
-- IT IS INERT FOR THE DEFAULT PLAN. Nothing the shipped
-- PLM_STOCK_PREPARATION_BOM_READ_PLAN reads is touched: the order pull over
-- 02 + 05 still produces the same 7 rows, because `Parent_OBJ_ID` and
-- `path_id` are read ONLY by the optional block, and the one part this file
-- adds hangs off no order line and no BOM under an order root.
--
-- WHAT IT ADDS
--
--   SYN-PATH-1                       the project node (already in 02)
--   └── SYN-PATH-1-SUB               depth-1 folder node, Parent_OBJ_ID = SYN-PATH-1
--       ├── SYN-BOM-H       head, path_id = SYN-PATH-1-SUB, part_id = SYN-PART-SUBTREE-H, SysVer V1
--       └── SYN-BOM-H-V0    head, path_id = SYN-PATH-1-SUB, part_id = SYN-PART-SUBTREE-H, SysVer V0
--                           ^ the SAME part with a SECOND (superseded) head. ONE root,
--                             not two: two roots on one part_id would carry
--                             byte-identical idempotencyKeys, which the conflict
--                             planner groups and HOLDS — the whole plan becomes
--                             manual_confirm. Root discovery filters heads by
--                             path_id ONLY (no version), so it genuinely sees both
--                             and has to collapse them itself.
--
--   SYN-PART-SUBTREE-H  x1  depth 0  total 1   <- root, quantity DEFAULTED (no order line)
--   ├── SYN-PART-LEAF-J x2  depth 1  total 2
--   └── SYN-PART-LEAF-K x3  depth 1  total 3
--
-- SYN-PART-SUBTREE-H appears in NO order detail line anywhere, which is the
-- point: with the block off it is unreachable, and with the block on it is the
-- only thing the second segment adds.
--
-- WHY THE ROOT'S QUANTITY IS 1
--   A folder-discovered root has no order line, so there is no measured
--   quantity to read. `parseQuantity`'s hold-not-zero rule refuses an absent
--   one rather than letting it become a real 0 that multiplies down every
--   descendant, so the expander writes the declared neutral multiplier 1 and
--   COUNTS it in summary.subtree.rootQuantitySource.subtreeDefault. The row
--   itself cannot say "this 1 was defaulted"; the evidence can.
--
-- WHAT YOU WILL SEE (default plan + the projectSubtree block, over 02 + 05)
--   expansion : status 'expanded', 10 rows (the order path's 7 + these 3),
--               0 errors, 0 rowErrors.
--   summary.subtree : rootsDiscovered 1, rootsExpanded 1,
--                     rootsSkippedAlreadyExpanded 0, rootsWithoutChildren 0,
--                     rootQuantitySource { orderDetail: 1, subtreeDefault: 1 }.
--
-- TO REMOVE: re-run 02-seed-pull-1.sql (it starts by emptying every table).
-- ============================================================================

-- The depth-1 folder node under the project node. `Parent_OBJ_ID` on
-- SYN-PATH-1 itself stays NULL (02 inserts it without the column), which is the
-- shape a top node has.
INSERT INTO DN_PDM_PathInfo (OBJ_ID, Parent_OBJ_ID) VALUES
  ('SYN-PATH-1-SUB', 'SYN-PATH-1');

-- The subtree root part and its two children. None of them is in any order.
INSERT INTO DN_PDM_PartLibraryInfo (OBJ_ID, IdentityNo, IdentityName, Material, SysVer) VALUES
  ('SYN-PART-SUBTREE-H', 'SYN-H-4000', 'Synthetic Subtree Root H', 'SYN-MAT-STEEL', 'V1'),
  ('SYN-PART-LEAF-J',    'SYN-J-4100', 'Synthetic Leaf Part J',    'SYN-MAT-ALU',   'V1'),
  ('SYN-PART-LEAF-K',    'SYN-K-4200', 'Synthetic Leaf Part K',    'SYN-MAT-POLY',  'V1');

-- TWO heads, ONE part, BOTH active and BOTH on the same folder node. Root
-- discovery filters by path_id only, so it sees both and must collapse them to
-- one root by part_id.
--
-- The current head's SysVer matches the part's ('V1'), because expandChildren
-- re-reads bomHead filtered by part_id AND SysVer — a mismatch there and the
-- root lands with no children at all (counted as
-- summary.subtree.rootsWithoutChildren). The superseded head is 'V0', so that
-- second read does NOT return it and the root expands exactly once.
INSERT INTO DN_PDM_BomHeadInfo (part_id, bom_id, SysVer, bom_able, path_id) VALUES
  ('SYN-PART-SUBTREE-H', 'SYN-BOM-H',    'V1', '1', 'SYN-PATH-1-SUB'),
  ('SYN-PART-SUBTREE-H', 'SYN-BOM-H-V0', 'V0', '1', 'SYN-PATH-1-SUB');

-- Only the current head carries lines. SYN-BOM-H-V0 is deliberately line-less:
-- nothing ever reads it, because the version filter excludes it from the child
-- read and root discovery had already collapsed it into the same single root.
INSERT INTO DN_PDM_BomDetailsInfo (bom_pid, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-BOM-H', 'SYN-PART-LEAF-J', 2, 10),
  ('SYN-BOM-H', 'SYN-PART-LEAF-K', 3, 20);
