-- ============================================================================
-- BATCH #1 state. Complete and self-contained: every table is emptied then
-- refilled, so re-running this file always returns the source to batch-1.
--
-- TWO projects (proves multi-project search) — all fabricated, SYN-/TZ- prefixed:
--
--   project_code SYN-XM-0001  (the main tree; 7 expanded rows)
--     TZ-A 总装配体A            x2   depth 0   total 2
--     ├── TZ-B 筒体组件B        x3   depth 1   total 6
--     │   ├── TZ-D 标准封头D     x2   depth 2   total 12
--     │   └── TZ-E 接管短节E     x4   depth 2   total 24   <- REMOVED in batch #2
--     └── TZ-C 支腿组件C        x1   depth 1   total 2    <- qty CHANGED in batch #2
--         ├── TZ-D 标准封头D     x1   depth 2   total 2    (D again, 2nd parent)
--         └── TZ-F 法兰F        x6   depth 2   total 12
--     TZ-G 废弃件G sits under a RETIRED head (bom_able='0'); must NEVER expand.
--
--   project_code SYN-XM-0002  (a separate, smaller project; 2 expanded rows)
--     TZ-P 泵体总成P            x1   depth 0   total 1
--     └── TZ-Q 叶轮Q            x2   depth 1   total 2
--
-- Createtime on EVERY material in batch #1 is hour 09 (2026-08-30T09:...), so the
-- batch-hour rule the driver applies buckets the whole pull into ...|2026-08-30T09.
-- ============================================================================

DELETE FROM DN_BomDetails_View;
DELETE FROM DN_BomHead_View;
DELETE FROM DN_PartLibrary_View;
DELETE FROM DN_ProjectRootLine_View;
DELETE FROM DN_ProjectRoot_View;
DELETE FROM DN_ProjectPath_View;
DELETE FROM DN_Project_View;

-- Two projects, two path anchors. A search for a project_code not listed here
-- returns zero rows -> the not_found branch.
INSERT INTO DN_Project_View (project_code, path_id) VALUES
  ('SYN-XM-0001', 'SYN-PATH-1'),
  ('SYN-XM-0002', 'SYN-PATH-2');

INSERT INTO DN_ProjectPath_View (path_id) VALUES
  ('SYN-PATH-1'),
  ('SYN-PATH-2');

INSERT INTO DN_ProjectRoot_View (root_id, path_id) VALUES
  ('SYN-ROOT-1', 'SYN-PATH-1'),
  ('SYN-ROOT-2', 'SYN-PATH-2');

-- Depth-0 lines: the top assembly of each project.
INSERT INTO DN_ProjectRootLine_View (root_id, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-ROOT-1', 'TZ-A', 2, 10),
  ('SYN-ROOT-2', 'TZ-P', 1, 10);

-- Part master. DrawingType 图号 / TargetName 名称 / Material 材料 /
-- Specification 规格 / Createtime (hour 09) / Creator / SysVer.
INSERT INTO DN_PartLibrary_View
  (part_id, DrawingType, TargetName, Material, Specification, Createtime, Creator, SysVer) VALUES
  ('TZ-A', 'TZ-A-1000', '总装配体A', 'Q345R',  'DN1200',        '2026-08-30T09:15:00', 'SYN-USER-1', 'V1'),
  ('TZ-B', 'TZ-B-2000', '筒体组件B', 'Q345R',  'DN1200x2000',   '2026-08-30T09:15:00', 'SYN-USER-1', 'V1'),
  ('TZ-C', 'TZ-C-2100', '支腿组件C', 'Q235B',  'L100x10',       '2026-08-30T09:15:00', 'SYN-USER-2', 'V1'),
  ('TZ-D', 'TZ-D-3000', '标准封头D', 'S30408', 'EHA-DN1200x12', '2026-08-30T09:15:00', 'SYN-USER-2', 'V1'),
  ('TZ-E', 'TZ-E-3100', '接管短节E', '16MnDR', 'DN80x6',        '2026-08-30T09:15:00', 'SYN-USER-2', 'V1'),
  ('TZ-F', 'TZ-F-3200', '法兰F',     'S31603', 'HG-T20592-DN80','2026-08-30T09:15:00', 'SYN-USER-3', 'V1'),
  ('TZ-G', 'TZ-G-3300', '废弃件G',   'Q235B',  'RETIRED',       '2026-08-30T09:15:00', 'SYN-USER-3', 'V1'),
  ('TZ-P', 'TZ-P-4000', '泵体总成P', 'S30408', 'DN200',         '2026-08-30T09:15:00', 'SYN-USER-1', 'V1'),
  ('TZ-Q', 'TZ-Q-4100', '叶轮Q',     'S31603', 'D150',          '2026-08-30T09:15:00', 'SYN-USER-1', 'V1');

-- SysVer on each head matches its part's SysVer, or the version-pinned child read
-- finds nothing. SYN-BOM-C-RETIRED is the negative control: bom_able='0'.
INSERT INTO DN_BomHead_View (part_id, bom_id, SysVer, bom_able) VALUES
  ('TZ-A', 'SYN-BOM-A',         'V1', '1'),
  ('TZ-B', 'SYN-BOM-B',         'V1', '1'),
  ('TZ-C', 'SYN-BOM-C',         'V1', '1'),
  ('TZ-C', 'SYN-BOM-C-RETIRED', 'V1', '0'),
  ('TZ-P', 'SYN-BOM-P',         'V1', '1');

INSERT INTO DN_BomDetails_View (bom_pid, part_id, Bom_ExAttr1, sort_id) VALUES
  ('SYN-BOM-A',         'TZ-B', 3, 10),
  ('SYN-BOM-A',         'TZ-C', 1, 20),
  ('SYN-BOM-B',         'TZ-D', 2, 10),
  ('SYN-BOM-B',         'TZ-E', 4, 20),
  ('SYN-BOM-C',         'TZ-D', 1, 10),
  ('SYN-BOM-C',         'TZ-F', 6, 20),
  ('SYN-BOM-C-RETIRED', 'TZ-G', 9, 10),
  ('SYN-BOM-P',         'TZ-Q', 2, 10);
