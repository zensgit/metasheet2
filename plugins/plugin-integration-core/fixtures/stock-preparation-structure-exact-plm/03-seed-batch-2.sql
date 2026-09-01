-- ============================================================================
-- BATCH #2 state — a RE-PULL of the SAME project SYN-XM-0001, one hour later.
-- Complete and self-contained (every table emptied then refilled).
--
-- Two deliberate changes vs batch #1, so the refresh (fill) path exercises
-- update / skip / mark_inactive together, exactly like the sibling fixture:
--   * TZ-C line under SYN-BOM-A: qty 1 -> 2  (ripples: TZ-C, TZ-D@C, TZ-F totals)
--   * TZ-E line under SYN-BOM-B: REMOVED     (the leaf that disappears)
--
-- Expected re-pull of SYN-XM-0001: 6 rows. Planned against the batch-1 target
-- rows: add 0 / update 3 / skip 3 / inactive 1, human cells untouched.
--
-- Createtime on every material is hour 10 (2026-08-30T10:...), so the driver's
-- batch-hour rule buckets this pull into ...|2026-08-30T10 — a DIFFERENT batch
-- from batch #1's ...|2026-08-30T09. Only project SYN-XM-0001 is re-seeded here;
-- the batch #2 comparison pulls that project.
-- ============================================================================

DELETE FROM DN_BomDetails_View;
DELETE FROM DN_BomHead_View;
DELETE FROM DN_PartLibrary_View;
DELETE FROM DN_ProjectRootLine_View;
DELETE FROM DN_ProjectRoot_View;
DELETE FROM DN_ProjectPath_View;
DELETE FROM DN_Project_View;

INSERT INTO DN_Project_View (project_code, path_id) VALUES
  ('SYN-XM-0001', 'SYN-PATH-1');

INSERT INTO DN_ProjectPath_View (path_id) VALUES
  ('SYN-PATH-1');

INSERT INTO DN_ProjectRoot_View (root_id, path_id) VALUES
  ('SYN-ROOT-1', 'SYN-PATH-1');

INSERT INTO DN_ProjectRootLine_View (root_id, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-ROOT-1', 'TZ-A', 2, 10);

-- Same part identities, Createtime bumped to hour 10 (the re-pull's material hour).
INSERT INTO DN_PartLibrary_View
  (part_id, DrawingType, TargetName, Material, Specification, Createtime, Creator, SysVer) VALUES
  ('TZ-A', 'TZ-A-1000', '总装配体A', 'Q345R',  'DN1200',        '2026-08-30T10:05:00', 'SYN-USER-1', 'V1'),
  ('TZ-B', 'TZ-B-2000', '筒体组件B', 'Q345R',  'DN1200x2000',   '2026-08-30T10:05:00', 'SYN-USER-1', 'V1'),
  ('TZ-C', 'TZ-C-2100', '支腿组件C', 'Q235B',  'L100x10',       '2026-08-30T10:05:00', 'SYN-USER-2', 'V1'),
  ('TZ-D', 'TZ-D-3000', '标准封头D', 'S30408', 'EHA-DN1200x12', '2026-08-30T10:05:00', 'SYN-USER-2', 'V1'),
  ('TZ-F', 'TZ-F-3200', '法兰F',     'S31603', 'HG-T20592-DN80','2026-08-30T10:05:00', 'SYN-USER-3', 'V1'),
  ('TZ-G', 'TZ-G-3300', '废弃件G',   'Q235B',  'RETIRED',       '2026-08-30T10:05:00', 'SYN-USER-3', 'V1');

INSERT INTO DN_BomHead_View (part_id, bom_id, SysVer, bom_able) VALUES
  ('TZ-A', 'SYN-BOM-A',         'V1', '1'),
  ('TZ-B', 'SYN-BOM-B',         'V1', '1'),
  ('TZ-C', 'SYN-BOM-C',         'V1', '1'),
  ('TZ-C', 'SYN-BOM-C-RETIRED', 'V1', '0');

-- SYN-BOM-A.TZ-C is now x2 (was x1); SYN-BOM-B no longer carries TZ-E.
INSERT INTO DN_BomDetails_View (bom_pid, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-BOM-A',         'TZ-B', 3, 10),
  ('SYN-BOM-A',         'TZ-C', 2, 20),
  ('SYN-BOM-B',         'TZ-D', 2, 10),
  ('SYN-BOM-C',         'TZ-D', 1, 10),
  ('SYN-BOM-C',         'TZ-F', 6, 20),
  ('SYN-BOM-C-RETIRED', 'TZ-G', 9, 10);
