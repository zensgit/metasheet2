# 场景 B · 合成 BOM 只读源（W7-A1）设计

2026-09-18。对应 SC-01 owner 裁决的第一刀。

## 1. 裁决原文

> 首个增量做 B：本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收。可先用合成字段，不等
> 客户真实字典；不启动 C 的环境/分页工作，不读真实 PLM/K3，不启用生产 autopersist。

本刀（A1）只做前两段：**合成 BOM 夹具 + 经既有 SQL 只读源跑通读取**。
A2（落 staging）与 A3（页面验收）另派，本刀一行 staging 写入代码都没有。

## 2. 为什么列名是合成的

客户 PLM 源侧列名零语义：含义在三张字典表里，数量藏在 `Bom_ExAttr1`；这份字典 owner 明确说了
本刀不等。仿造一套"像客户"的列名会把一个**还没拿到的映射**假装成已知输入 —— 演示时看着对，
等真字典到位再改，改的是所有引用它的地方。

所以夹具的列名一律合成，带 `syn_`/`SYN-` 前缀，一眼可辨不是客户数据：

```
syn_bom_items(line_no, project_no, parent_no, part_no, part_name,
              qty, uom, rev, level_no, path_key)
```

真实字典到位时要改的只有读取配置 `fieldMap` 的 **source 一侧**；target 一侧是备料 intake 自己的
词表（`plugins/plugin-integration-core/lib/stock-preparation-readonly-intake.cjs:194-232` 的别名
梯子），一个字不动。这就是把"未知输入"限制在一个面上的做法。

## 3. 夹具形状

位置：`plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/`

| 文件 | 角色 |
| --- | --- |
| `scenario-b-synthetic-bom.cjs` | 单一事实来源：54 行、`FIELD_MAP`、`readSourceConfig()`、SQL 生成器 |
| `regenerate.cjs` | 生成下面两个 .sql |
| `01-schema.sql` / `02-seed.sql` | 生成物；测试逐字节比对，手改即红 |
| `README.md` | 灌库步骤、三层接入、验收命令 |

- **54 行、两层父子**：6 条一级（根 → 分总成）+ 48 条二级（分总成 → 零件）。
- 值全假、确定性生成（无 `Date.now` / `Math.random`），所以 SQL 的漂移断言不会变成随机红。
- 标识符不加双引号：PG 折叠成小写，`FIELD_MAP` 的 source 也写小写，宿主 `PostgresAdapter` 同样
  不加引号插值标识符 —— 三边对得上。
- 外部系统 `kind` 用既有的 `data-source:sql-readonly`，**没有新增 kind**。

## 4. 走的读取路径（file:line 以本分支实读为准）

```
夹具行（本机 PG）
  └─ packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:655  select()
        ↑ authorize() :528-552 —— requirePrincipal + DataSourceManager.assertAccess + isReadOnly
  └─ plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:602  read()
        · config.dataSourceId 是唯一数据源选择器（:561），请求换不掉
        · upsert = unsupportedAdapterOperation（:689）
  └─ plugins/plugin-integration-core/lib/read-source-read-runtime.cjs:383  executeConfiguredRead
        · rowSource 'adapter_records'（:336 executeFromAdapterRecords）—— 读适配器的 records 平面
  └─ plugins/plugin-integration-core/lib/stock-preparation-readonly-source-run.cjs:711  runPlmBomReadonlySource
        · 权限门 ensureDependencies :139（admin，`REQUIRED_PERMISSION` :10）
        · kind 白名单 PLM_SOURCE_KINDS :77-81（含 data-source:sql-readonly）
        · 分页/完整性 readAllMappedRows :246
        · 配置字段全解析 assertEveryConfiguredFieldResolved :551
        · 项目域 assertRowsStayInProjectScope :628
  └─ plugins/plugin-integration-core/lib/stock-preparation-readonly-intake.cjs:193  normalizeBomLine
```

HTTP 入口（本刀**未改**，pin 文件）：`plugins/plugin-integration-core/lib/http-routes.cjs:7240`
`stockPreparationPlmBomSourceRun` —— `requireAccess(req,'admin')` :7241、autopersist flag OFF 时
响应逐字节等于只读投影 :7282-7285、内部 staging 写入在 :7295-7308（本刀不触发）。

## 5. 三道守卫，本刀实证了哪几道

场景 B 短名单里的写侧三道守卫：

| 守卫 | 本刀 | 说明 |
| --- | --- | --- |
| ① 租户转向拒绝（autopersist ON 时任何载体 `tenantId` → 400） | **未实证** | 只在 flag ON 时接线；本刀不开 flag，属 A2 |
| ② 结构守卫 `assertPlmAutoPersistSourceConfigSafe` | **未实证** | 同上，只在 flag ON 路径 :7268 |
| ③ 只读/无写入面 | **已实证** | 见 §6 |

本刀额外实证了读侧的四道：admin 权限门、kind 白名单、项目域守卫、完整性证明。
owner 门（跨主体不可见）在宿主 facade 一侧实证。

## 6. `adapter_reported` 在 B 路径上到底成立不成立（实证结论）

任务书要求实证"`adapter_reported` 完整性契约在 B 的 feeder 路径应当成立"。实测结论是
**它不适用于这条 kind，但这不是缺口**：

- `data-source:sql-readonly` 在 `SOURCE_KIND_CAPABILITIES` 里登记的是
  `limitContract: 'honours_request'`（`stock-preparation-readonly-source-run.cjs:59-62`），
  不是 `adapter_reported`。理由写在它自己的注释里：这个适配器**不钳制** —— 它把 `request.limit`
  原样交给宿主 facade 的 `select`，宿主交给 PG 的 `LIMIT`。
- `adapter_reported` 是给**会钳制**的 kind 用的（Bridge Agent 把 500 钳成 20 并在
  `metadata.limit` 回显，`:67-70`）。sql-readonly 适配器**不回显** `metadata.limit`/
  `effectiveLimit`（`data-source-sql-readonly-source-adapter.cjs:663-685` 只回
  object/dataSourceId/offset/count），所以 `effectivePageSize` 走 `honours_request` 分支用请求值。
- B 路径上"完整性"成立的形式是**证明二选一**：`short_page`（源给的比它自己施加的页宽少）或
  `declared_total`（收到的行数等于源自报总数）。两者都证不出就失败关闭。

实跑结果（细节见 verification 文档）：54 行 → 单页短页 → `completenessProof: 'short_page'`；
10 页全满 → `SOURCE_RUN_RESULT_TOO_LARGE`；源无视页宽多给 → 同码按名字拒。

**已知盲区（写成断言，不是写成散文）**：一个**悄悄钳制**的源在这条 kind 上抓不住 —— 没有独立
证人能区分"我要 1000、它只给 20 且说没有更多"与"源就只有 20 行"。测试
`testKnownGapSilentlyClampingSourceIsNotDetected` 把这个盲区钉住。B 的合成源由我们自己灌数据，
A1 不致命；要消掉它得在**适配器**补 `metadata.limit` 回显、再把这条 kind 改登记成
`adapter_reported` —— 那是产品改动，不在本刀范围，建议 A2 之前请 owner 裁决。

（对照：短名单 §C 的第 3 条已由 owner 在 2026-09-16 更正为"待实现缺口"，那说的是 **PipelineRunner**
那条链完全不过 feeder；本文说的是 feeder 链**内部** sql-readonly 这一 kind 的契约形状，两件不同的事。）

## 7. 测试布局与为什么分两处

| 套件 | 跑什么 | 需要 DB |
| --- | --- | --- |
| `plugins/plugin-integration-core/__tests__/scenario-b-synthetic-bom-source-run.test.cjs` | 整条读取链：真适配器 + 真执行器 + 真 feeder + 真 intake；宿主 facade 是被动替身 | 否 |
| `packages/core-backend/tests/integration/scenario-b-synthetic-bom-source-run.test.ts` | 真 facade + 真 `DataSourceManager`：owner 门、只读姿态；外加 `DATABASE_URL` 时的整条真 PG feeder 跑 | owner/只读两个 describe 否；feeder describe 是 |

分两处的原因是边界：宿主 facade 是跨包注入点，插件侧 node:test 够不着它。插件侧那个替身**不是**
owner/租户门的背书 —— 它不拒绝任何人，只记录收到的参数，用来证伪"principal 被原样递下去了吗、
dataSourceId 会不会被请求换掉"这类传递性事实。真门的断言在宿主侧套件里。

`test-chain.txt` 只加了一行（第 61 行），`package.json` 未动。

## 8. A2 需要的接口 / 本刀未做

- **落 staging**：入口是 `http-routes.cjs:7288-7308` 的 autopersist 分支
  （`buildPlmSourcePersistInput` → `persistStockPreparationSyncRun`，
  `targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)`、`lockTenantId = tenantId`）。
  A1 产出的 `runPlmBomReadonlySource` 返回值里的 `result.intake` 就是它的输入，形状未变。
- **flag**：`MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED`。owner 裁决明确"不启用生产
  autopersist" —— A2 若要开，只能在本机/沙箱开，并且要把 §5 的 ①② 两道守卫补上实证。
- **未做**：staging 写入、autopersist、页面验收、n8n 触发、审计账本、真实字典映射、222 上机。
- **待 owner 裁决**：§6 的盲区要不要在 A2 之前消（改适配器 metadata + 改 kind 契约登记）。
