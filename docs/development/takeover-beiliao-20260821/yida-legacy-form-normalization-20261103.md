# 旧备料系统宜搭对接规范化（2026-11-03）

> 范围：只读旧系统源码，把它对宜搭的写法整理成我们自己的规则模板格式。本 PR 只有文档和三份合成模板，不改代码、不开开关。
>
> 代码引用都固定在 `47655efec`（origin/main，2026-11-03）。旧系统引用按压缩包根目录写相对路径，Java 包路径一段统一写成 `<pkg>`。

## 1. 来源与边界

- **来源**：owner 提供的旧备料系统压缩包，内含后端 `后端/stockorder` 和前端 `前端/PrepareMaterial`。
  - 只解压了源码目录。`node_modules`、编译产物和日志都没解，包里的东西一律没有运行。
  - 宜搭和钉钉的调用集中在 `后端/stockorder/src/main/java/<pkg>/util/DingUtil.java`。调用方有三个控制器：`StockInfoController`、`CraftInfoController`、`GeneralStockInfoController`。
- **不进仓库的值（values-free）**：
  - 真实的 formUuid、appType、systemToken、appKey/appSecret、表单字段 id、钉钉 agentId、流程编码和用户 id，本文和模板里一个都没有。
  - 这些值都是现场配置项，不进仓库。
  - 本文的表单按用途命名：物料表、项目号表、发料确认表。字段 id 用的是中性占位名。
- **凭据处置**：
  - 旧系统把钉钉应用凭据和宜搭 systemToken 写死在源码常量里（`DingUtil.java:23-28`、`:51-53`）。
  - 按 AI 协作章程「安全红线」，这些凭据默认视为已泄露，接管时要轮换。
  - 这份压缩包本身也应按含凭据的文件保管。
- **模板的定位**：三份模板都是 `stock-preparation-yida-rule-template` 本地模板，状态是 `local-unverified`。
  - 模板不带 target：`plugins/plugin-integration-core/lib/yida-rule-template.mjs:97` 拒收 target，`:100-101` 只在校验时临时放一个 schema 占位 target。
  - 模板也不代表宜搭远端的真实结构：`plugins/plugin-integration-core/lib/yida-static-plan.mjs:1-2`。

## 2. 三张表单字段目录

变换类型只用七种：直接映射、常量、复制派生、拼接、查表、拆分均分、生成编号。

「我们的来源列」指备料主表模板里的字段，位置在 `plugins/plugin-integration-core/lib/stock-preparation-templates.cjs`。

### 2.1 物料表（旧系统两条写入路径共用这张表）

旧代码位置：

- 备料推送：`StockInfoController.java:1787-1907`
- 工艺推送和刷新：`CraftInfoController.java:175-218`

| 中文名 | 宜搭控件 | 我们的来源列 | 变换类型 | 必填 | 去重键 | 进模板 |
|---|---|---|---|---|---|---|
| 项目号 | 下拉 | `projectNo`（templates.cjs:700） | 拆分均分：组合项目号拆成单个项目号 | 是 | 是 | 是，按文本控件，见 §6 缺口 G5 |
| 项目规格型号 | 文本 | 无。旧代码按项目号查 BOM 表（`StockInfoController.java:1788`） | 查表 | 否 | 否 | 否，见 G4 |
| 图号 | 文本 | `componentCode`（templates.cjs:743） | 直接映射 | 是 | 是 | 是 |
| 部件名称 | 文本 | `componentName`（templates.cjs:744） | 直接映射 | 是 | 是 | 是 |
| 规格型号 | 文本 | `componentSpec`（templates.cjs:754） | 直接映射，可为空 | 否 | 是，可空键 | 是 |
| 材质 | 文本 | `material`（templates.cjs:755） | 直接映射 | 是 | 是 | 是 |
| 版本号 | 文本 | `sourceVersion`（templates.cjs:756） | 直接映射 | 是 | 是 | 是 |
| 父组件图号 | 文本 | `parentComponentCode`（templates.cjs:736） | 直接映射，顶层为空 | 否 | 是，可空键 | 是 |
| 父组件名称 | 文本 | `parentComponentName`（templates.cjs:737） | 直接映射 | 否 | 否 | 是 |
| 部件类别 | 文本 | 与父组件名称同值（`StockInfoController.java:1803`） | 复制派生 | 否 | 否 | 否，见 G3 |
| 总数量 | 数字 | `totalQuantity`（templates.cjs:758） | 拆分均分 | 是 | 否 | 是，见 G7 |
| 毛胚尺寸 | 文本 | 长、宽、厚三列拼一段文字（`StockInfoController.java:1838-1850`）。这三列只存在于客户包（`plugins/plugin-integration-core/lib/customer-packs/factory-a.rehearsal.cjs:118-120`） | 拼接 | 否 | 否 | 否，见 G2 |
| 材料类型 | 文本 | `blankType`（templates.cjs:771-774）。旧代码注释写明这一列「实际上是毛胚类型」（`StockInfoController.java:1851-1853`） | 直接映射 | 否 | 否 | 是 |
| 工艺执行规则 | 下拉 | 无 | 常量，固定值见旧代码 `StockInfoController.java:1854` | — | 否 | 否，见 G1 |
| 是否允许负库存 | 单选 | 无 | 常量（`StockInfoController.java:1855`） | — | 否 | 否，见 G1 |
| 一个只注释为「默认值」的文本字段 | 文本 | 无 | 常量（`StockInfoController.java:1857`） | — | 否 | 否，见 G1；用途待现场核对 |
| 备料行标识 | 文本 | `idempotencyKey`（templates.cjs:701）。旧系统用的是备料表自增 id（`StockInfoController.java:1856`） | 直接映射 | 是 | 否。旧代码按它查询的那一行已注释掉 | 是 |
| 物料编码 | 文本 | 无。旧代码用前缀加随机 UUID（`StockInfoController.java:1896`） | 生成编号 | — | 否 | 否，见 G6 |
| 图纸图片 ×4 | 图片 | 无。旧代码注释写明 2025-10 起停用 | — | — | — | 否，见 G8 |

工艺推送路径写的是同一张表的子集：项目号、图号、部件名称、材质、父组件名称、父组件图号、版本号、总数量（取自工艺表的数量列）、物料编码。见 `CraftInfoController.java:180-190`、`:209`。

### 2.2 项目号表

| 中文名 | 宜搭控件 | 我们的来源列 | 变换类型 | 必填 | 去重键 | 进模板 |
|---|---|---|---|---|---|---|
| 项目号 | 文本 | `projectNo` | 直接映射，拆分后每个单项目号一条 | 是 | 是 | 是 |

旧代码：`StockInfoController.java:1917-1938`。

### 2.3 发料确认表

| 中文名 | 宜搭控件 | 我们的来源列 | 变换类型 | 必填 | 去重键 | 进模板 |
|---|---|---|---|---|---|---|
| 备料行标识 | 文本 | `idempotencyKey`。旧系统用备料表 id | 直接映射 | 是 | 是 | 是 |
| 项目号 | 文本 | `projectNo` | 直接映射 | 是 | 是 | 是 |

旧代码：`StockInfoController.java:2027-2080`。

## 3. 写入语义

### 旧系统怎么写

- **触发方式**：都是用户点按钮，在请求里同步执行。
  - 逐行 sleep：备料推送 300 ms（`StockInfoController.java:1899`），工艺推送 1 s（`CraftInfoController.java:213`）。
  - 前端提示「推送宜搭耗时较长」（`前端/PrepareMaterial/src/components/stockInfo.vue:1289`）。
- **物料表·备料推送**：
  1. 先把组合项目号拆成单个项目号（`StockInfoController.java:1757`）。
  2. 对每个单项目号，先按项目号查物料表，决定是否逐行查重（`StockInfoController.java:1766`）。
  3. 逐行查重时，按项目号、图号、名称、规格、材质、版本查询（`StockInfoController.java:1866-1876`），再比较父组件图号（`StockInfoController.java:1883`）。相同就记为「重复」并跳过。
  4. 不重复就新建一行，同时生成新的物料编码（`StockInfoController.java:1896-1898`）。
  5. 这条路径只新建，不更新。
  6. 物料推完之后再推项目号表（`StockInfoController.java:1767`、`StockInfoController.java:1769`）。
- **物料表·工艺推送和刷新**：
  - 项目已在物料表里：逐行查询，更新第一条命中（`CraftInfoController.java:199-205`）。
  - 项目不在：全部新建（`CraftInfoController.java:209-211`）。
- **项目号表**：没有才新建（`StockInfoController.java:1923-1931`）。
- **发料确认表**：对勾选的每一行：
  1. 按行标识加项目号查询（`StockInfoController.java:2056`）。
  2. 没有：新建（`StockInfoController.java:2058`），然后回写本地仓库表的「发料确认」日期、更新人和更新时间（`StockInfoController.java:2059-2064`）。
  3. 已有：记为「重复」。
  - 「子件已确认、父件补确认」那条逻辑已注明暂停，方法体是空的（`StockInfoController.java:2086` 起）。

### 规范化后

- 三份模板都是 `intent: create`，按业务键去重。
  - 物料表的业务键跟旧系统的查重条件一致：项目号、图号、名称、规格、材质、版本、父组件图号。
  - 规格和父组件图号是可空键（`yida-static-plan.mjs:214-220`）。
- **批内重复**：本地预览会把同一批里业务键相同的行归成一组（`yida-static-plan.mjs:444-449`）。
- **跨批次重复**：交付台账对「租户、工作区、目标、业务键摘要」做 create 预留，靠唯一约束兜住（`packages/core-backend/migrations/091_create_integration_yida_create_fence.sql:1-5`，`plugins/plugin-integration-core/lib/yida-delivery-store.cjs:11`、`:193-195`）。
  - 所以不再需要「先查宜搭再写」。
  - 但这个约束只认得经我们系统写过的行。旧系统已经写进宜搭的行，它不知道。见 §7 Q3。
- **多项目号均分**：用 `equal_integer`（`stock-preparation-yida-allocation.mjs:268-272`），除不尽就报 `QUANTITY_NOT_DIVISIBLE`（`:271`）。
  - 旧系统遇到除不尽是把数量留空，只记一行日志。
  - 有小数时只能改用 `equal_decimal_exact`（`stock-preparation-yida-allocation.mjs:274-288`）：最多 6 位小数，不舍入，除不尽同样报错。
  - 旧系统是保留 1 位小数、四舍五入。选哪种见 §7 Q4。
- **发料确认的本地回写**：模板只管出站，不表达回写。
  - 备料主表里没有「发料确认日期」这一列。相近的列有 `warehouseDone`（templates.cjs:842）、`warehouseConfirmation`（templates.cjs:783）和 `actualArrivalDate`（templates.cjs:845）。
  - 回写到哪一列由 owner 定，见 §7 Q5。

## 4. 钉钉审批流程与工作通知

旧系统除了宜搭表单，还直接调了钉钉：

- **发起审批**：`DingUtil.java:249-266`，调用方在 `StockInfoController.java:1497`、`:1543`，`GeneralStockInfoController.java:416`、`:453`。
  - 表单项有四个：项目号、规格、当前批次物料的时间范围、待办分支。待办分支取「常规」或「<部门>确认」，见 `StockInfoController.java:1480-1493`、`:1525-1539`。
  - 通用件的项目号固定写「通用件」（`GeneralStockInfoController.java:400`）。
- **列出和查询审批实例**：`DingUtil.java:268-303`，调用方在 `StockInfoController.java:1595`、`:1600` 和 `GeneralStockInfoController.java:497`、`:502`。
- **以当前用户身份自动「同意」审批节点**：`DingUtil.java:327-362`，调用方在 `StockInfoController.java:1691` 和 `GeneralStockInfoController.java:590`。
- **工作通知**：按手机号查到用户 id，发 OA 消息（`DingUtil.java:206-240`）。

规范化结论：

- **工作通知**：走现有的钉钉通知动作，对应待办裁决里的方案 A。
- **待办**：最多做单向镜像，对应方案 B（`dingtalk-todo-mirror-b-design-20260916.md:5`）。
- **不做的事**：「以用户身份自动同意」和任何从钉钉回流的写入都属于入站，按同一裁决的方案 C 永不做（`dingtalk-todo-mirror-b-design-20260916.md:37`）。

## 5. 旧逻辑不照搬清单

1. **凭据写死在源码**：appKey/appSecret、systemToken、表单和流程标识都是常量（`DingUtil.java:23-28`、`:51-53`）。规范化后凭据只放在加密的连接配置里，标识是现场配置项。
2. **保存和更新失败被吞掉，永远返回 ok**（`DingUtil.java:95-109`、`:160-175`）。
   - 工艺推送入口也一样：吞掉异常后照样返回「推送成功」（`CraftInfoController.java:161-164`）。
   - 结果是「成功 N 条」的统计不可信。
3. **查询不传分页**（`DingUtil.java:127-133`）：只拿得到第一页。数据量一大，查重就失效，开始重复写入。默认页大小待现场核对。
4. **先查后写不是原子的，物料编码又是随机的**（`StockInfoController.java:1896`、`CraftInfoController.java:209`）。并发或重推时，会生成编码不同的重复行。
5. **数量写法有两处问题**：
   - 「总数量」是数字控件，旧代码却发「数字 + 中文单位」的字符串（`StockInfoController.java:1833`）。
   - 除不尽时数量直接留空，只记日志（`StockInfoController.java:1827`）。
   - 失败又被第 2 条吞掉，所以宜搭里缺数量的行不会被发现。
6. **工艺刷新的查询条件写错**：「部件名称」条件填的是图号（`CraftInfoController.java:196`）。名称和图号不同的行永远匹配不上，更新被静默跳过。
7. **每次调用都重新取 access token**，靠 sleep 限流（`DingUtil.java:46-58`，`StockInfoController.java:1899`）。
8. **查询和更新用写死的操作人 id**（`DingUtil.java:130`、`:157`）。新建用的则是按手机号查到的当前用户。

## 6. 与现有模板的对照与缺口

**已覆盖**：

- 直接映射：`yida-static-plan.mjs:12`、`:177-203`。
- 业务键，最多 8 个（`yida-static-plan.mjs:209-213`）。
- 可空键（`yida-static-plan.mjs:214-220`）。
- 必填一致性（`yida-static-plan.mjs:204-207`）。
- 多项目号均分：`stock-preparation-yida-allocation.mjs:72-76`、`:79-95`。

**缺口**（每一条都用合成数据在今天的校验器上实测过，见 PR 说明）：

- **G1 常量**：映射项只能有 `source`、`target`、`type`、`required` 四个键（`yida-static-plan.mjs:12`、`:191`），没有固定值。今天只能由源表补一列常量列。
- **G2 拼接**：没有多列合成一列的表达方式。今天只能在源表预先算好。
- **G3 复制派生**：同一来源列不能映射到两个目标（`yida-static-plan.mjs:183`、`:194`、`:200`），所以「部件类别 = 父组件名称」写不进模板。
- **G4 查表**：模板只读本行的列，不能跨表取值，例如项目规格型号。今天只能在源表预先补列。
- **G5 动态下拉**：
  - 下拉和单选必须带静态选项，1 到 64 个（`yida-static-plan.mjs:158-163`）。值不在选项里就报 `FIELD_OPTION_INVALID`（`:467-470`）。
  - 宜搭里的「项目号」是下拉，选项会随项目增长。模板里只能先按文本控件表达。
  - 宜搭的接口是否接受选项以外的值，待现场核对，本文不下结论。
- **G6 生成编号**：模板不生成值。物料编码应改成由业务键确定性派生，或者交给宜搭自己的流水号字段。选哪种见 Q2。
- **G7 带单位的数量**：
  - 数字控件只收 number（`yida-static-plan.mjs:195`、`:457-459`），带单位的字符串会被拒收（`FIELD_TYPE`）。
  - 单位如果要显示在宜搭里，需要单独一个文本字段，待现场核对。
- **G8 图片控件**：控件只有 text、number、select、radio 四种（`yida-static-plan.mjs:15`）。旧系统已停用图纸图片，不补。

## 7. 建议与待定问题

**建议**：

- 先做一组封闭的声明式变换：常量、拼接、复制派生、查表、确定性编号。这五种加上已有的直接映射和拆分均分，正好覆盖旧系统对宜搭的全部写法，不需要任意代码。
- 这组变换落地之前，缺口字段由源表预先算成列，再按普通映射进模板。
- 这一步要改代码，需要 owner 另批。

**待定问题**：

- **Q1（现场）**：宜搭「项目号」下拉经接口写入选项以外的值时，是被拒收、存成文本，还是不显示？
- **Q2（owner）**：物料编码是由业务键确定性派生，还是改用宜搭流水号字段？
- **Q3（现场 + owner）**：切换时，宜搭里已有旧系统写的物料行。是先导入一次基线，让交付台账认得它们，还是从切换日起只写新项目？
- **Q4（owner）**：有小数的数量是精确均分、除不尽就拒绝，还是沿用旧系统的保留 1 位四舍五入？后者会改变总量。
- **Q5（owner）**：发料确认回写到备料主表的哪一列？现在没有对应的日期列。
- **Q6（现场）**：物料表里那个只注释为「默认值」的文本字段是什么用途？查询的默认页大小是多少？
- **Q7（现场）**：材质为空的行在今天的模板下会被挡住（`KEY_MISSING`）。旧数据里是否存在空材质？

## 8. 本 PR 附带的合成模板

位置：`docs/development/takeover-beiliao-20260821/yida-legacy-templates/`

| 文件 | 表单 | 字段数 | 均分方式 |
|---|---|---|---|
| `material.json` | 物料表 | 11 | `equal_integer`，按 `projectNo` 均分 `totalQuantity` |
| `project-registry.json` | 项目号表 | 1 | `original` |
| `issue-confirm.json` | 发料确认表 | 2 | `original` |

- 三份文件都由我们自己的 `exportYidaRuleTemplate` 生成，再用 `parseYidaRuleTemplate` 读回比对，字节一致。
- 目标字段 id 都是中性占位名，不是宜搭的真实字段 id。
- 现场接入时，在界面里把占位名对到真实字段，同时填入 target。
