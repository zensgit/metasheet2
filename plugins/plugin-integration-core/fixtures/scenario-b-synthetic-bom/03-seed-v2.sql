-- 场景 B / W7-A1 合成 BOM 夹具 —— 由
--   plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs
-- 生成。不要手改：__tests__/scenario-b-synthetic-bom-source-run.test.cjs 逐字节比对本文件与生成器
-- 的输出，手改会直接红。要改内容就改生成器，再重跑
--   node fixtures/scenario-b-synthetic-bom/regenerate.cjs
--
-- 全部是假数据：SYN- 前缀、编造的编号、没有客户名、没有真实图号、没有任何凭据。
-- 标识符一律不加双引号，PG 会折叠成小写，读取配置的 fieldMap 也写小写 —— 两边对得上。

-- v2（第二批次）：把 02-seed.sql 灌进去的那 54 行整体替换成 v2 的 54 行。
-- 相对 v1 只有四处不同：1 行改数量、1 行原位物料替换（path_key 不变、件号变）、1 行新增、1 行删除。

DELETE FROM syn_bom_items;

INSERT INTO syn_bom_items (line_no, project_no, parent_no, part_no, part_name, qty, uom, rev, level_no, path_key) VALUES
  (1, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-01', '合成分总成 1', 2, 'SET', 'A1', 1, '/SYN-ASM-ROOT/SYN-SUB-01'),
  (2, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-01', '合成零件 1-1', 3, 'KG', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-01'),
  (3, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-02', '合成零件 1-2', 4, 'PCS', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-02'),
  (4, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-03', '合成零件 1-3', 105, 'SET', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-03'),
  (5, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-04', '合成零件 1-4', 6, 'KG', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-04'),
  (6, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-05', '合成零件 1-5', 7, 'PCS', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-05'),
  (7, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-06', '合成零件 1-6', 8, 'SET', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-06'),
  (8, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-07', '合成零件 1-7', 2, 'KG', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-07'),
  (9, 'SYN-PRJ-B1', 'SYN-SUB-01', 'SYN-PRT-01-08', '合成零件 1-8', 3, 'PCS', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-01/SYN-PRT-01-08'),
  (10, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-02', '合成分总成 2', 3, 'KG', 'A2', 1, '/SYN-ASM-ROOT/SYN-SUB-02'),
  (11, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-01', '合成零件 2-1', 4, 'PCS', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-01'),
  (12, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-02', '合成零件 2-2', 6, 'SET', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-02'),
  (13, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-03', '合成零件 2-3', 8, 'KG', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-03'),
  (14, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-04', '合成零件 2-4', 3, 'PCS', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-04'),
  (15, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-05R', '合成替换件 2-5', 5, 'SET', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-05'),
  (16, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-06', '合成零件 2-6', 7, 'KG', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-06'),
  (17, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-07', '合成零件 2-7', 2, 'PCS', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-07'),
  (18, 'SYN-PRJ-B1', 'SYN-SUB-02', 'SYN-PRT-02-08', '合成零件 2-8', 4, 'SET', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-02/SYN-PRT-02-08'),
  (19, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-03', '合成分总成 3', 1, 'PCS', 'A3', 1, '/SYN-ASM-ROOT/SYN-SUB-03'),
  (20, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-01', '合成零件 3-1', 5, 'SET', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-01'),
  (21, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-02', '合成零件 3-2', 8, 'KG', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-02'),
  (22, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-03', '合成零件 3-3', 4, 'PCS', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-03'),
  (23, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-04', '合成零件 3-4', 7, 'SET', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-04'),
  (24, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-05', '合成零件 3-5', 3, 'KG', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-05'),
  (25, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-06', '合成零件 3-6', 6, 'PCS', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-06'),
  (26, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-07', '合成零件 3-7', 2, 'SET', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-07'),
  (27, 'SYN-PRJ-B1', 'SYN-SUB-03', 'SYN-PRT-03-08', '合成零件 3-8', 5, 'KG', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-03/SYN-PRT-03-08'),
  (28, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-04', '合成分总成 4', 2, 'SET', 'A4', 1, '/SYN-ASM-ROOT/SYN-SUB-04'),
  (29, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-01', '合成零件 4-1', 6, 'KG', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-01'),
  (30, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-02', '合成零件 4-2', 3, 'PCS', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-02'),
  (31, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-03', '合成零件 4-3', 7, 'SET', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-03'),
  (32, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-04', '合成零件 4-4', 4, 'KG', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-04'),
  (33, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-05', '合成零件 4-5', 8, 'PCS', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-05'),
  (34, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-06', '合成零件 4-6', 5, 'SET', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-06'),
  (35, 'SYN-PRJ-B1', 'SYN-SUB-04', 'SYN-PRT-04-07', '合成零件 4-7', 2, 'KG', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-04/SYN-PRT-04-07'),
  (37, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-05', '合成分总成 5', 3, 'KG', 'A0', 1, '/SYN-ASM-ROOT/SYN-SUB-05'),
  (38, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-01', '合成零件 5-1', 7, 'PCS', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-01'),
  (39, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-02', '合成零件 5-2', 5, 'SET', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-02'),
  (40, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-03', '合成零件 5-3', 3, 'KG', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-03'),
  (41, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-04', '合成零件 5-4', 8, 'PCS', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-04'),
  (42, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-05', '合成零件 5-5', 6, 'SET', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-05'),
  (43, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-06', '合成零件 5-6', 4, 'KG', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-06'),
  (44, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-07', '合成零件 5-7', 2, 'PCS', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-07'),
  (45, 'SYN-PRJ-B1', 'SYN-SUB-05', 'SYN-PRT-05-08', '合成零件 5-8', 7, 'SET', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-05/SYN-PRT-05-08'),
  (46, 'SYN-PRJ-B1', 'SYN-ASM-ROOT', 'SYN-SUB-06', '合成分总成 6', 1, 'PCS', 'A1', 1, '/SYN-ASM-ROOT/SYN-SUB-06'),
  (47, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-01', '合成零件 6-1', 8, 'SET', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-01'),
  (48, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-02', '合成零件 6-2', 7, 'KG', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-02'),
  (49, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-03', '合成零件 6-3', 6, 'PCS', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-03'),
  (50, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-04', '合成零件 6-4', 5, 'SET', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-04'),
  (51, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-05', '合成零件 6-5', 4, 'KG', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-05'),
  (52, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-06', '合成零件 6-6', 3, 'PCS', 'B2', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-06'),
  (53, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-07', '合成零件 6-7', 2, 'SET', 'B3', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-07'),
  (54, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-08', '合成零件 6-8', 8, 'KG', 'B0', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-08'),
  (55, 'SYN-PRJ-B1', 'SYN-SUB-06', 'SYN-PRT-06-09', '合成新增零件 6-9', 7, 'PCS', 'B1', 2, '/SYN-ASM-ROOT/SYN-SUB-06/SYN-PRT-06-09');

-- PASS: DELETE 54 之后 INSERT 0 54
-- SELECT count(*) FROM syn_bom_items;                 -- 54
-- SELECT count(*) FROM syn_bom_items WHERE level_no = 1; -- 6
-- SELECT count(*) FROM syn_bom_items WHERE level_no = 2; -- 48
