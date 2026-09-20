-- 场景 B / W7-A1 合成 BOM 夹具 —— 由
--   plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs
-- 生成。不要手改：__tests__/scenario-b-synthetic-bom-source-run.test.cjs 逐字节比对本文件与生成器
-- 的输出，手改会直接红。要改内容就改生成器，再重跑
--   node fixtures/scenario-b-synthetic-bom/regenerate.cjs
--
-- 全部是假数据：SYN- 前缀、编造的编号、没有客户名、没有真实图号、没有任何凭据。
-- 标识符一律不加双引号，PG 会折叠成小写，读取配置的 fieldMap 也写小写 —— 两边对得上。

DROP TABLE IF EXISTS syn_bom_items;

CREATE TABLE syn_bom_items (
  line_no    integer PRIMARY KEY,
  project_no text    NOT NULL,
  parent_no  text    NOT NULL,
  part_no    text    NOT NULL,
  part_name  text    NOT NULL,
  qty        numeric NOT NULL,
  uom        text    NOT NULL,
  rev        text    NOT NULL,
  level_no   integer NOT NULL,
  path_key   text    NOT NULL UNIQUE
);
