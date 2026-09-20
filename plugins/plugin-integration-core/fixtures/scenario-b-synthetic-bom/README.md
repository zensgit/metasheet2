# 场景 B 合成 BOM 只读源夹具（W7-A1）

一张本机 PostgreSQL 假 BOM 表，让**场景 B 的备料 feeder**（`POST /api/integration/stock-preparation/
mvp/source-runs/plm-bom` 背后的 `runPlmBomReadonlySource`）能在没有 mock PLM 服务、没有客户真实
字典的前提下被真正跑一遍。

owner 裁决（SC-01）:「首个增量做 B：本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收。
可先用合成字段，不等客户真实字典；不启动 C 的环境/分页工作，不读真实 PLM/K3，不启用生产
autopersist」。本目录是这句话里的第一段。

## 它和 `../stock-preparation-synthetic-sql-source/` 的区别

那套夹具喂的是**表动作的展开器/冲突计划器**（`stock-preparation-bom-expansion.cjs`），七张表、
沿用客户 `DN_PDM_*` 的拼写。本目录喂的是**另一条链**：已批准只读读取配置 → `executeConfiguredRead`
→ 备料 feeder → intake 契约。两者互不替代，也不共享表。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `scenario-b-synthetic-bom.cjs` | 单一事实来源：行、字段映射、读取配置、SQL 生成器 |
| `regenerate.cjs` | 重新生成下面两个 .sql |
| `01-schema.sql` | 一张表 `syn_bom_items`，10 列 |
| `02-seed.sql` | 54 行，两层父子（6 条一级 + 48 条二级） |

`01`/`02` 是**生成物**。`__tests__/scenario-b-synthetic-bom-source-run.test.cjs` 逐字节比对它们与
生成器的输出，手改会直接红 —— 这样"psql 灌进去的那批行"和"测试里断言的那批行"不可能各自漂移。

## 为什么列名是合成的

客户 PLM 的列名零语义（含义藏在三张字典表，数量在 `Bom_ExAttr1`），那份字典 owner 明确说了本刀
不等。仿一套"看起来像客户"的列名，等于把一个还没拿到的映射假装成已知输入。所以这里是
`part_no / parent_no / qty / uom / rev / path_key / level_no / project_no / part_name / line_no`，
`SYN-` 前缀，一眼就能看出不是客户数据。

真实字典到位后要改的只有 `FIELD_MAP` 的 `source` 一侧；`target` 一侧是备料 intake 自己的词表
（`lib/stock-preparation-readonly-intake.cjs:194-232` 的别名梯子），一个字都不动。

## 灌进本机 Postgres

```bash
createdb syn_bom_b1
psql -d syn_bom_b1 -v ON_ERROR_STOP=1 -f 01-schema.sql
psql -d syn_bom_b1 -v ON_ERROR_STOP=1 -f 02-seed.sql
```

**PASS**：`01` 打印一条 `CREATE TABLE`；`02` 打印 `DELETE` 后 `INSERT 0 54`。核对：

```sql
SELECT count(*) FROM syn_bom_items;                    -- 54
SELECT count(*) FROM syn_bom_items WHERE level_no = 1; --  6
SELECT count(*) FROM syn_bom_items WHERE level_no = 2; -- 48
```

标识符一律不加双引号 —— PG 折叠成小写，`FIELD_MAP` 的 `source` 也写小写，两边对得上。宿主的
`PostgresAdapter` 同样不加引号插值标识符，所以不要给 DDL 加引号。

## 接进插件（三层，都不带口令进插件）

1. **宿主数据源**：`POST /api/data-sources`，`type: "postgresql"`，`options.readOnly` 必须为真
   （可写源在 facade 的 `authorize()` 里连读都会被拒）。凭据只存在这一层。
2. **集成外部系统**：`POST /api/integration/external-systems`，
   `kind: "data-source:sql-readonly"`（既有 kind，本刀不新增），`config.dataSourceId` 指向第 1 层。
3. **已批准读取配置**：`scenario-b-synthetic-bom.cjs` 的 `readSourceConfig()` 就是它的 S1 形状，
   `object` 填表名（可带一个点做 schema 限定，如 `public.syn_bom_items`）。

## 验收

- 插件侧（无需数据库，在 `pnpm test` 链里）：
  `node __tests__/scenario-b-synthetic-bom-source-run.test.cjs`
- 宿主侧（owner 门 / 只读姿态无需数据库；整条 feeder 需 `DATABASE_URL`）：
  `packages/core-backend/tests/integration/scenario-b-synthetic-bom-source-run.test.ts`

设计与实证记录：`docs/development/scenario-b-synthetic-bom-source-design-20260918.md` 与
`docs/development/scenario-b-synthetic-bom-source-verification-20260918.md`。
