# 场景 B 合成 v2 快照 → diff 引擎演练（备料对账第一刀）· 设计 · 2026-09-20

基线 commit：`1a6663a41d4b49de143ff35bd138115c70e998d1`（本文所有 `path:line` 在该 commit 上成立）。

## 这是路线的哪一步

备料接管路线：**演示（合成数据）→ 只读窗口授权 → 历史迁移与双轨对账 → 按项目号切换上线 → 按需扩展**。

第 3 步「双轨对账」的前置能力是：**系统得能把同一批 BOM 的两份快照比出差异来**。这一刀就是那件
能力的**合成演练**——用本机合成数据、在没有客户真实源的前提下，把「两个快照批次 → diff 引擎 →
页面读面」整条对账链真跑一遍，并逐类钉住它认出了什么。

前两刀已经落地：

| 刀 | PR | 证的是 |
| --- | --- | --- |
| A1 | #5876 | 合成 BOM 经既有受控源**读得到**（54 行，两层父子） |
| A2 | #5877 / #5888 | 那 54 行**落得进** staging（不可变批次 + 三道守卫 + 幂等） |
| A3 | 场景 B 页面验收 | 落点形状在页面上**渲染得出来** |
| **Q3a（本刀）** | 本 PR | 两份快照**比得出**——四类变更逐类被认出来 |

## 做了什么

### 1. 夹具加 v2（同一张表的第二份内容）

`plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs`
新增 `ROWS_V2`（54 行）与 `seedSqlV2()`，经 `regenerate.cjs` 生成 `03-seed-v2.sql`（LF，受
`.gitattributes:103` 的 `text eol=lf` 约束）。**`ROWS` / `01-schema.sql` / `02-seed.sql`
一个字节都没动**——v1 是已经灌进本机 PG 的那份，不能回头改。

`ROWS_V2` 相对 `ROWS` 只有四处不同，四类变更各一条，刚好铺满 diff 引擎的三种 `diffType`：

| 变更 | 落在哪一行 | 引擎判成 |
| --- | --- | --- |
| ① 改数量 | `SYN-PRT-01-03`，qty +100 | `changed` / `quantity_changed` |
| ② 原位物料替换 | `SYN-PRT-02-05` → `SYN-PRT-02-05R`，**path_key 不变** | `changed` / `component_code_changed` |
| ③ 新增子件 | `SYN-PRT-06-09` | `added` |
| ④ 删除子件 | `SYN-PRT-04-08` | `removed` |
| 其余 51 行 | 逐字段不变 | `unchanged` |

**② 为什么保持 `path_key` 不变**——这是本刀唯一一处需要论证的设计选择。diff 引擎的配对是
「先按 `pathKey` 配对，配不上的再按 `childDrawingNo|childVersion` 身份配对」
（`lib/stock-preparation-snapshot-diff.cjs:468` 的 `planBomSnapshotDiff`，
`:363` 的 `addMatchedByPathDiffs`，`:392` 的 `addMovedIdentityDiffs`）。在这套语义里
`pathKey` 是**位置地址**（某个父件下的某个装配位），`childDrawingNo` 是「这个位置上装的是哪个
件」。引擎的 `component_code_changed` 正是为「同一位置上件号换了」而设的
（`:224-230` 的注释与判据）。

如果让 v2 的 `path_key` 跟着 `part_no` 走，同一件事会被引擎报成 `removed` + `added`——
`component_code_changed` 这一类就永远走不到，而「原位替换」恰恰是备料评审最需要被点名的一类
变更（`lib/stock-preparation-snapshot-diff.cjs:21-27` 的指纹分解注释把这一点写死了）。所以 v2
的这一行刻意把「位置」和「件号」解耦，生成器里也写明了原因。

v1 的 `path_key` 由 `part_no` 拼出来只是生成方便，不是语义约束。

### 2. 新测试：`__tests__/scenario-b-v2-snapshot-diff.test.cjs`

跑的全是产品代码，一个都没换：真适配器 → 真执行器 → 真 feeder → 真桥 → 真落库 → **真只读 diff
读面**（`lib/stock-preparation-snapshot-reads.cjs`）→ **真 diff 引擎**
（`lib/stock-preparation-snapshot-diff.cjs`）→ 真 http-routes handler（本刀未改 `http-routes.cjs`）。

被替掉的只有两个宿主注入点：只读 data-source facade（A1/A2 同款被动替身）与 multitable
records/provisioning（内存 staging 落点）。两者都不是任何守卫的背书——它们只提供「行存在于某处」
这个事实；守卫本身的断言在 A2 与 core-backend 的姊妹套件里。

八条断言：

1. **两个不可变批次真的落下来**：批次 1（v1，version 1）+ 批次 2（v2，version 2），108 行快照行，
   快照行一次 `patch` 都没有；被删的行只在批次 1、新增的行只在批次 2；替换那行两批次同 `pathKey`
   但 `childDrawingNo` 不同、数量与版本不动。
2. **引擎直调**：55 条 diff = changed 2 + added 1 + removed 1 + unchanged 51；四类变更逐类点名；
   **九个未改动的维度一个都不许被误报**；两条 `changed` 各自只带自己那一种业务变更（替换那条不是
   靠 quantity 顺带报出来的）；`evidence` values-free。
3. **经页面读的那两条真路由**（`GET /snapshot-batches/:id/diff`、`/diff/rows`）读出同一份四类
   变更；base 批次由**服务端**按「版本严格小于当前的最高版本」自动挑出来，不是请求指定的；
   `reviewStatus=held` 过滤正好是那四行；四个响应体 values-free；全程零外部写。
4. **批次不可变**：精确重放 = 200 `internal_noop`；同批次改内容重跑 = 409
   `PERSIST_IDEMPOTENCY_CONFLICT` / `snapshot_line` / `content_mismatch`，一行不动；因此同一对批次
   再读一次 diff 逐字节一样（对账结果可重放）。
5. **变异 ①**：v2 把被删的子件放回去 → `removed` 归零（另外三类照旧）。
6. **变异 ②**：diff 引擎换成「只比行数」→ 54 vs 54 直接判「没事」，55 条 diff 全部消失。
7. **变异 ③**：v2 把替换件改回原件号 → `component_code_changed` 归零、指纹变化只剩 1 次。
8. **flag 默认 OFF 没被动**：不设 = 只读投影，一行都不写。

变异一律**内存级**（`Module._compile` 编出一个改过的模块对象），磁盘上的文件一个字节都没改。
变异锚点刻意只占**一行**：`lib/*.cjs` 在 Windows 检出下是 CRLF，跨行锚点会在本机永远命不中、
在 CI 的 LF 检出下才命中——那种探针是假的（本刀第一版就踩了这个，见验证文档）。

### 3. 夹具漂移断言扩到 v2

`__tests__/scenario-b-synthetic-bom-source-run.test.cjs` 的
`testCommittedSqlMatchesGenerator` 现在覆盖 `03-seed-v2.sql`，并额外钉住「`03` 相对 `02` 恰好是
3 : 3 的行级对称差」——多改一行、少改一行都会红。

### 4. 页面侧：A3 spec 零改 src 加一个用例

`apps/web/tests/StockPreparationScenarioBAcceptance.spec.ts` 新增用例 ⑥：两批次、55 条 diff 行的
形状喂给 `StockPreparationSnapshotDiffView`，断言汇总计数按 `data-kind` 逐格读出、逐行明细按
`data-diff-type` 逐类可数、`component_code_changed` 在逐行明细里被点名、整页 values-free。
**`src/` 一个字都没改**。

## 退出条件：「对账引擎跑通一次（合成数据即可）」满足了吗

**满足，但要说清它的确切边界。**

满足的部分：

- 两个**真落库**的不可变快照批次（不是手捏的两个数组）经**产品自己的**读面与引擎比了一次；
- 四类变更**逐类**被认出来，且未改动的九个维度一个都没被误报；
- 结论经**页面实际调用的那两条路由**读出来，形状与引擎直调一致；
- 结果可重放（同批次改内容会 409 而不是悄悄改写历史）。

不能由本刀主张的部分：

- 这是**合成数据**。它证的是引擎与读面在一份「只差四处」的输入上行为正确，不证任何客户真实
  BOM 的形状（客户 PLM 列名零语义、含义藏在三张字典表、数量藏在 `Bom_ExAttr1`，那份字典 owner
  明确说了本刀不等）。
- 这是**同源两份快照**的对账，不是**双轨对账**。双轨对账是「新系统的结果 vs 老系统的结果」，
  两侧数据来自两套不同的系统、两套不同的字段词表；本刀两侧都来自同一张合成表、同一份
  `FIELD_MAP`。

## 与真实双轨对账的差距

按「差什么」而不是「缺什么 kind」列，因为后者容易写成一句不成立的绝对话：

1. **源 kind 不是缺口，字典才是。** 需要更正一处常见说法：「MySQL 源 kind 不存在」**不成立**。
   备料 feeder 允许的源 kind 见 `lib/stock-preparation-readonly-source-run.cjs:54-75`，其中
   `data-source:sql-readonly` 的适配器**不认数据库品类**——它只拿 `config.dataSourceId`
   （`lib/adapters/data-source-sql-readonly-source-adapter.cjs:561`），品类由宿主 `DataSourceManager`
   的适配器表决定，而 MySQL 在那张表里
   （`packages/core-backend/src/data-adapters/DataSourceManager.ts:198` → `MySQLAdapter`）。
   所以「读客户的 MySQL 老库」在**能力**上已经具备：建一个 `options.readOnly` 为真的 mysql 数据源
   + 一个 `kind: 'data-source:sql-readonly'` 的外接系统 + 一份已批准读取配置即可。
   真正缺的是那份**读取配置的 `fieldMap.source` 一侧**——客户老库的列名到备料词表的映射。
2. **老侧没有快照批次。** 本刀的对账两侧都是备料自己的 `bom_snapshot_batch` 行。老系统（客户现
   用备料系统）的结果不会以这个形状存在，双轨对账需要先把老侧结果**也**落成一个可寻址的批次
   （或者给引擎加一条「外部结果集」入口）。这是第 3 步真正的第一道工。
3. **汇总词表落后于引擎词表**（已知缺口，见下）。
4. **对账口径未定**：双轨对账要比的是「备料结果行」（物料/数量/单位换算后），不一定是「BOM 快照
   行」。本刀比的是后者。前者对应的是 `prep_line` 那一层，引擎与读面都还没有对应的 diff 面。

## 已知缺口（写成断言，不写成散文）

| 缺口 | 位置 | 本刀怎么处理 |
| --- | --- | --- |
| 汇总 `changeCounts` 的词表里没有 `componentCodeChanged` / `materialChanged` | `lib/stock-preparation-snapshot-reads.cjs:263-276` `changeCountsFromEvidence`；前端 `StockPreparationSnapshotDiffView.vue:448-464` `changeCountEntries` | 原位物料替换在**汇总**表上只能以 `fingerprintChanged` 露头；逐行读面才点名。后端与前端**各钉了一条断言**（`fingerprintChanged === 2`、汇总里不存在 `componentCodeChanged` 这一格），不是靠文档记着 |
| `material_changed` 这一维度未被演练 | 夹具没有 `material` 列 | 本刀**不**给 v1 加列（那会改动已灌库的 `02-seed.sql` 字节）。断言里显式钉住 `material_changed` 未出现，并列入残余 |
| `apps/web/tests/**` 不在 `vue-tsc -b` 的 include 里 | `apps/web/tsconfig.app.json` 的 `include` 只有 `src/**` | 既有缺口，不是本刀引入。本刀的 spec 靠 `vitest run` 实跑把关；列入残余 |

## 安全面

- 不连任何真实数据库；不读真实 PLM/K3；不启用生产 autopersist（flag 只在测试进程内置为 `'true'`，
  跑完即还原，仓库默认值依旧「不设 = OFF」）。
- 外部写面：本刀新增的链路全程零外部写，且有断言。
- values-free：夹具是 `SYN-` 前缀的合成数据；四个 HTTP 响应体与引擎 evidence 都有「业务值不得出现」
  的反例断言，并配有正例自检（哨兵确实到了写侧）。
