# 备料 演示 Runbook（2026-09-01）— 步骤 1-3 走查 · 已填充的结构一致源

主讲人脚本。把"演示"从**临场发挥**变成**逐条台词 + 逐个动作 + 指哪一列**。
目标:当着客户 **PMC / 生产 / 采购 / 仓库 + 信息部**，把他们今天在自己备料系统里
的动作，在我们这套上**原样跑一遍**，再用"连通你们真实 PLM"收尾。

> **纪律（committed 文件一律遵守）**
> - 本文**不含任何凭据 / 真实主机名 / 真实数据值**——一律用占位符 `<...>`。
> - **不在演示中亲自连生产 PLM（端点见团队私有记录 `<生产 PLM 端点>`，不入库）去拉数**。连接与体检已在
>   `onsite-connection-test-runbook-20260901.md` 证明；本演示跑的是**合成源**。
> - 客户真实测试 PLM 目前**是空的**（`project_code` 全 NULL、`DrawingType` NULL、
>   名称是 GUID），所以步骤 1-2 只能演在**结构一致的合成数据**上——这正是本 runbook
>   的前提，也是收尾那句话的支点。

---

## 0. 一页故事（开场白）

> 「今天你们 PMC 输一个项目号、点拉取，三个部门在一张共享表里各填各的列，背后是一堆
> PLM/K3/钉钉/宜搭 的胶水在撑着。我们保留你们**一模一样的每日动作**，把胶水换成
> **读计划 + 原生网格 + 自动化**。现在我用**和你们库结构一模一样的合成数据**，把
> 步骤 1-2-3 当场跑一遍;跑完，我把连接切到**你们真实的 PLM**，让你们亲眼看到"系统
> 通了"。」

要复现的三个动作，按顺序:**(1) 输项目号→拉取→BOM 树落表**、**(2) 三个角色各填各的
列 + 重拉不冲掉人填**、**(3) 导出仓库/采购拿走的 Excel**。收尾:**连真实 PLM + 30 秒
体检**。

---

## 1. 演示模式抉择（为什么用终端 runner，不用本机 Web+SQL Server）

我们评估了两种模式，只演**能当场证明跑通**的那种。

| 模式 | 需要什么 | 本环境可行? |
|---|---|---|
| **(A) Web-UI + SQL Server**：浏览器里点 项目接入 面板→拉取→多维表→填列→导出 | 一个**运行中的 MetaSheet 实例**（自带 Postgres `DATABASE_URL`）+ 一个能读的 SQL 源 + 把读计划改绑注入表动作配置 | **否**——本机无 docker、无 MSSQL、无 `DATABASE_URL`，起不了实例也起不了源 |
| **(B) 终端 runner**：`node` 直接驱动**发货管线**跑步骤 1-2-3，逐步叙述输出 | 只需 `node` + 发货的插件模块，**无数据库** | **是**——已验证 GREEN（见下） |

**本 runbook 主推模式 (B)**，因为它**保证可复现**、在任何一台装了 node 的笔记本上都能
当场跑绿；模式 (A) 的**每一条断言在同一份合成源上也已被 (B) 证明**（见附录输出与
`structure-exact-rehearsal-report-20260901.md`）。若现场恰好有一个已部署的实例，可另走
模式 (A)（第 6.4 节给出接线形状），但**本环境未验证 (A)，不声称其可跑**。

### 已验证命令（模式 B）

```
cd plugins/plugin-integration-core
node __tests__/stock-preparation-demo-runner.cjs
```

**尾行**（成功判据）:`stock-preparation-demo-runner.cjs OK`。完整输出见**附录 A**——
演示时直接把这段终端投屏即可，它自带每一步的台词与"指哪一列"。

> 这条 runner 驱动的是**发货代码**（`expandPlmProjectBom`、ext 映射、快照 mapper、
> `planStockPreparationConflicts` 及其 pack 权属推导）——**不是**一个只会附和自己的
> mock;唯一合成的是**数据源**，这正是"结构一致演示"的全部意义。

---

## 2. 上场前准备（Prep）

### 2.1 指向"已填充的演示源"（模式 B，推荐）

演示源 = 结构一致合成夹具，**已随本分支入库**、100% 合成、无凭据:

```
plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/
  01-schema.sql        7 个 DN_*_View 对象（客户 schema 形状）
  02-seed-batch-1.sql  两个项目:SYN-XM-0001（7 行树）、SYN-XM-0002（2 行树）;创建于 09 点
  03-seed-batch-2.sql  重拉 SYN-XM-0001;创建于 10 点;删掉 TZ-E、TZ-C 数量 1→2
```

准备动作只有一条:**打开终端，`cd` 到插件目录，把命令敲好但先别回车**。投屏后回车，
让每一步在观众眼前逐条出现。无需数据库、无需起服务、无需网络。

### 2.2 若走模式 A（可选，需要一个运行中的实例）

见 **6.4 节**。要点:实例自带 `DATABASE_URL`（Postgres，应用自己的库，与客户 PLM 无关）;
合成源作为一个 `sqlserver` 只读数据源注册进实例;读计划按客户词汇改绑注入表动作配置。
接线用引导脚本 `scripts/ops/stock-prep-acceptance-bootstrap.mjs`（**仅环境变量、不走
argv**）。**占位符见 6.4，无凭据。**

---

## 3. 步骤 1 — 项目号搜索 + 分支

**台词**:「你们今天的动作——输一个项目号，点拉取。我们这里一模一样。」

### Web-UI 点法（模式 A，实例上）
登录落在 **「我的应用」**→ 进入 **项目工作台 / 对接总览**→ 顶部 **项目接入** 面板
（`apps/web/src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue`）
→ 在**唯一那个输入框**填项目号（如 `SYN-XM-0001`）→ 点 **同步这个项目**。面板会逐条
亮出四步（dry-run/reconcile/apply/mvp-persist），并给出 `新增 N 行` 的试算句。

### 终端 runner（模式 B，已验证）
runner 的"步骤 1"区块。**指给观众看**:

- `搜索 SYN-XM-0001` → `status=expanded`、`rootMatches=1`、**展开 7 行**、0 错误。
- `搜索 SYN-XM-0002` → **2 行**、与前者是不同零件（**多项目搜索互相独立**）。
- `搜索 SYN-XM-9999`（库里没有）→ `status=not_found`、**0 行**。
  **台词**:「不存在的项目，系统直接说没有，不会拉出半拉数据——这是护栏。」
- **分支**:目标表为空 → 计划 = **全部新增 `add 7`**（首拉 = PULL;有数据时走 FILL，
  见步骤 3）。

---

## 4. 步骤 2 — 拉取 → BOM 落多维表 · 列映射 · 两批次按创建小时

**台词**:「拉过来的就是这棵 BOM 树。我指给你看每一列是从你们哪一列来的。」

### 要指的列（客户词汇 → 落地列）
runner 会打印当前批次 BOM 表。**逐列指**:

| 落地列 | 来自客户列 | 在哪 |
|---|---|---|
| **图号** `componentCode` | `DrawingType` | 规范行 |
| **名称** `componentName` | `TargetName` | 规范行 |
| **材料** `material` | `Material` | 规范行 |
| **总数量** `totalQuantity` | 逐层累乘（量在 `Bom_ExAttr1`） | 规范行 |
| **规格** `ext_spec` | `Specification` | ext 映射 |
| **父组件图号** `parentDrawingNo` | 父行 `DrawingType` | 快照 mapper 批内父连接 |

**指数字**:根 `TZ-A-1000` ×2 → 组件 `TZ-B-2000` ×3 → 封头 `TZ-D-3000` ×2 =
**总数量 12**（逐层累乘）。**指护栏**:停用 BOM 头（`bom_able='0'`）下的废弃件
`TZ-G` **从不展开**。

### 两批次按创建小时区分（物料创建日期精确到小时）
runner 打印:

- 批 #1 = `SYN-XM-0001|2026-08-30T09`（材料创建于 09 点）
- 批 #2 = `SYN-XM-0001|2026-08-30T10`（一小时后重拉，创建于 10 点）
- → 两批次快照行 id **0 重叠**;同一小时重算 id 逐字节一致（幂等）。

> **⚠ 现场必须如实说（见第 7 节 caveat #1）**:"按小时分批"的**推导目前在调用方**
> （runner 手工按 `Createtime` 铸造 `snapshotBatchId`），**尚未进发货代码**。发货
> mapper 收的是调用方给定的 `snapshotBatchId`。这一步是"可行、待接"，别演成已发货。

---

## 5. 步骤 3 — 人工填列 + 人列墙（杀手锏）+ 导出

**这一步赢下整场。** 客户最深的恐惧:「我重拉 BOM，是不是把我们三个部门填的全冲掉?」

**台词**:「你们最怕的:重拉会不会把我填的都冲掉?看好了。」

### 5.1 人工填列
在落地表上，由人填 **16 个人列**——规范人列带（材料类型 / 毛胚类型 / 备料情况 /
需求日期 / 提前周期 / 备注 / 采购回复 / 仓库确认）**加** pack 人列带（备料日期
`ext_stockPrepDate` / 领料节点 `ext_pickingNode` / 交接工段 / 毛胚尺寸 `ext_blank*`）。
Web-UI 上这是三个角色各在自己的列上原生内联编辑（列级权限，服务端强制）。

### 5.2 人列墙——**照着念这一段**
1. 「我现在**重拉一次**（模拟 PLM 出了新批次）。」→ runner 的批 #2 重拉。
2. 计划 = **`add 0 / update 3 / skip 3 / inactive 1`**。
3. 「改动的列**只有** `rawQuantity / totalQuantity`——也就是 PLM 的量。**任何一条决策都
   不携带人列。**」
4. 「应用刷新后:**7 行 × 16 个人列，逐字节不变。** 你填的一个字都没动。」
5. **负对照（这句最有杀伤力）**:「同样这次刷新，如果**不过**权属过滤器——**16 个人列
   全被冲掉**。所以这堵墙是**承重的**，不是我嘴上说说。」

### 5.3 导出仓库/采购拿走的 Excel
1. Web-UI:多维表工具栏 → **导出 XLSX**，走
   `GET /api/multitable/sheets/:sheetId/export-xlsx`。
2. runner 打印导出投影:**活跃物料行 6 × 列 10**（图号/名称/规格/材料/总数量 +
   备料情况/需求日期/领料节点/备料日期/毛胚长度）。**停用的那一行掉出拣料单。**
3. 「每一行既带自己的图号身份，又带你们填的 `备料情况 / 备料日期`——这就是仓库直接
   拿去领料的单子。」

> 二进制打包由 `packages/core-backend/src/multitable/xlsx-service.ts` 的
> `buildXlsxBuffer` 完成、并由现有 vitest（`multitable-xlsx-routes.test.ts`）覆盖;
> runner 证明的是**投影（物料内容）**。

---

## 6. 收尾 FINALE — 连你们真实的 PLM

跑完合成演示后，**当场把连接切到客户真实 PLM**，做一次**连接证明**——这是把"演示"变成
"这就是你们的系统"的关键转折。

### 6.1 动作
1. 用**只读账号**把 `data-source:sql-readonly` 指到客户生产 PLM 端点（连接细节、只读
   口令轮换、体检 SQL **全部在** `onsite-connection-test-runbook-20260901.md`，**本文不
   复制**）。
2. 跑该 runbook **第 2 节的 30 秒数据体检**（体检 1:非空 `project_code` 计数）。
3. 预期结果:**连接 test 通过（active）**，但体检返回 **"connected, 0 project codes"**
   （客户测试库是空的）。

### 6.2 台词（收尾定音）
> 「**系统通了**——连接活的、表在、列在。你们库里现在**没填项目**。你们**填一个真项目**，
> 刚才这一整套，就在**你们自己的数据**上照跑。现场唯一的变量，就是你们的数据。」

### 6.3 交球给客户
顺势把 `onsite-connection-test-runbook-20260901.md` **第 4 节"给客户的精确数据要求"**
交给信息部:一个填齐的项目——项目号、带图号/名称/材料/数量（在 `Bom_ExAttr1`）的多层
BOM 树、以及项目到根 BOM 的对应关系;只读账号即可。

### 6.4 若走模式 A（Web-UI，可选，需运行中的实例）

> **本环境未验证此路**（无 docker/MSSQL/`DATABASE_URL`）。以下是**接线形状**，供有实例
> 的部署现场参考;**全部占位符，无凭据**。

引导脚本 `scripts/ops/stock-prep-acceptance-bootstrap.mjs` **只收环境变量**:

```
MS_API=<https://<host>/api>            # 部署实例 API 根，含 /api
MS_TOKEN=<admin bearer>                # 管理员 bearer
MS_PROJECT_NO=<要演示的项目号>          # 演示合成源用 SYN-XM-0001
MS_PACK_ID=<服务端持有的 pack id>
MS_DATA_SOURCE_ID=<只读数据源 id>
MS_EXTERNAL_SYSTEM_ID=<该表动作读取的 external system id>
# 只读连接（作为一组给出，用后立即轮换）:
MS_DS_TYPE=sqlserver
MS_DS_HOST=<源主机>  MS_DS_PORT=<端口>  MS_DS_DATABASE=<库>
MS_DS_USER=<只读账号>  MS_DS_PASSWORD=<只读口令>  MS_DS_SCHEMA=<schema>
```

脚本按序:preflight → 建表 → 装 pack → 接线数据源并 `.../test` → 干跑 → 应用 → 幂等复核。
**读计划改绑**（客户列名 → 发货 7 对象遍历）注入表动作配置
`INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` 的 `action.source.readPlan`，
与 runner 里的 `REBIND_READ_PLAN`、on-site runbook 的改绑表**一模一样**。实例的应用侧
自身还需 Postgres `DATABASE_URL`（应用自己的库，与客户 PLM 无关）。

---

## 7. 诚实边界（演示中**主动**说，不等追问）

这三点是**净新、未接线**，**不要**摆成在跑:

1. **按创建小时分批的推导（物料创建日期精确到小时）**——**可行**（runner 已在真实
   `Createtime` 上算出并喂给发货 mapper），但发货代码目前收**调用方给定**的
   `snapshotBatchId`;同项目多批次现由持久化层单调 `snapshotVersion` 区分。把"小时桶"
   推导接到 `snapshotBatchId` 铸造处是**一个小函数**的净新工作。
2. **多人审批 hand-off 链到备料**——平台**有**审批运行时，但**未接**到备料流。属净新。
3. **钉钉待办 / 审批推送**——**无**连接器接线。属净新。

> 追问时的答法:「在路线图上，**尚未发货**。今天演示的步骤 1-2-3 是**已发货、已验证**
> 的部分;这三点我们如实标为待建。」

---

## 附录 A — 已验证 runner 完整输出（证据）

命令:`cd plugins/plugin-integration-core && node __tests__/stock-preparation-demo-runner.cjs`
（终端有颜色;下面是去色文本，尾行 `... OK` 即成功）。

```
备料 DEMO — 客户步骤 1-2-3 走查(结构一致合成 PLM 源 · 驱动发货管线)
  源 = plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/  (100% 合成, 无凭据无真实值)
  管线 = 发货代码 expandPlmProjectBom / ext 映射 / 快照 mapper / 冲突计划 / pack 权属推导
  读计划改绑 = 客户词汇 project_code / DrawingType 图号 / TargetName 名称 / Material 材料 / 规格 / 数量在 Bom_ExAttr1
  ✓ 读入源结构:7 个 DN_*_View 对象 (project → path → root → root-line → part → bomHead → bomDetail)

步骤 1 — 项目号搜索 + 分支(无数据→拉取 / 有数据→填写)
  搜索 SYN-XM-0001 …
    → status=expanded  rootMatches=1  展开 7 行,0 错误
  搜索 SYN-XM-0002 (另一个项目,证明多项目搜索互相独立) …
    → status=expanded  展开 2 行,与 SYN-XM-0001 是不同的零件
  搜索 SYN-XM-9999 (库里没有这个项目) …
    → status=not_found  0 行 —— 空项目护栏:不存在的项目不会拉出半拉数据
  分支:目标表为空 → 计划 = 全部新增 add 7 (首拉 = PULL;有数据时走 FILL,见步骤 3)
  步骤 1 通过

步骤 2 — 拉取 → BOM 落多维表,列映射;同项目两批次按创建小时区分
  当前批次 BOM(点这几列:图号 / 名称 / 材料 / 规格 / 总数量):
  图号(DrawingType)  名称(TargetName)  材料(Material)  规格(Specification)  总数量  层级
  TZ-A-1000          总装配体A         Q345R           DN1200               2       0
    TZ-B-2000        筒体组件B         Q345R           DN1200x2000          6       1
      TZ-D-3000      标准封头D         S30408          EHA-DN1200x12        12      2
      TZ-E-3100      接管短节E         16MnDR          DN80x6               24      2
    TZ-C-2100        支腿组件C         Q235B           L100x10              2       1
      TZ-D-3000      标准封头D         S30408          EHA-DN1200x12        2       2
      TZ-F-3200      法兰F             S31603          HG-T20592-DN80       12      2
  ✓ 数量逐层累乘:根 x2 → 组件 x3 → 封头 x2 = 总数量 12
  ✓ 停用的 BOM 头(bom_able='0')下的废弃件 TZ-G 从不展开
  ✓ 快照行携父组件图号(批内父连接):TZ-D-3000 的父组件图号 = TZ-B-2000,父名称 = 筒体组件B
  同项目两批次按创建小时区分 (物料创建日期精确到小时):
    批 #1 = SYN-XM-0001|2026-08-30T09  (材料创建于 09 点)
    批 #2 = SYN-XM-0001|2026-08-30T10  (一小时后重拉,创建于 10 点)
    → 两批次快照行 id 0 重叠;同一小时重算 id 逐字节一致(幂等)
  ⚠ 诚实说明:按小时分批的推导目前在调用方(本 runner 手工铸造),尚未进发货代码 —— 见文末与 runbook。
  步骤 2 通过

步骤 3 — 人工填列 + 人列墙(杀手锏)+ 仓库导出
  人填 16 个人列(材料类型/毛胚类型/备料情况/需求日期/提前周期/备注/备料日期/领料节点/毛胚尺寸…)于 7 行
  重拉一次(批 #2) → 计划 = add 0 / update 3 / skip 3 / inactive 1
    改动的列只有 rawQuantity / totalQuantity(PLM 的量);任何决策都不携带人列
    应用刷新后:7 行 × 16 个人列取值 逐字节不变 ✅ 人列墙成立
  负对照:同样的刷新若 不过权属过滤器 → 16 个人列 全被冲掉 —— 证明这堵墙是承重的,不是摆设
  导出(仓库/采购拿走的 XLSX 投影) —— 活跃物料行 6 × 列 10(停用的那一行掉出拣料单):
  图号       名称       规格  材料    总数量  备料情况     需求日期    领料节点         备料日期    毛胚长度
  TZ-A-1000  总装配体A        Q345R   2       20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  TZ-B-2000  筒体组件B        Q345R   6       20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  TZ-D-3000  标准封头D        S30408  12      20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  TZ-C-2100  支腿组件C        Q235B   4       20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  TZ-D-3000  标准封头D        S30408  4       20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  TZ-F-3200  法兰F            S31603  24      20 - 已下单  2026-09-20  10 - 示例节点一  2026-09-02  1250
  步骤 3 通过

演示要如实说明的边界(净新 · 未接线 —— 别演成已有)
  1. 按创建小时分批的推导:可行,但发货 mapper 目前收调用方给定的 snapshotBatchId —— 需加一小段调用方推导。属净新,一个小函数。
  2. 多人审批 hand-off 链到备料:平台有审批运行时,但未接线到备料流。属净新,未接线。
  3. 钉钉待办推送:无连接器接线。属净新,未接线。

DEMO 全绿
  步骤 1-2-3 在结构一致合成源上,驱动发货管线,全部通过。
stock-preparation-demo-runner.cjs OK
```

---

## 附:相关文件

- 演示 runner（无 DB，已验证）:`plugins/plugin-integration-core/__tests__/stock-preparation-demo-runner.cjs`
- 演示源（结构一致合成夹具）:`plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/`
- 机制排练驱动（更重的断言）:`plugins/plugin-integration-core/__tests__/stock-preparation-structure-exact-rehearsal.test.cjs`（PR #5408）
- 排练报告:`docs/development/takeover-beiliao-20260821/structure-exact-rehearsal-report-20260901.md`（PR #5408）
- **现场连接测试 runbook（连接 + 30 秒体检 + 数据要求,收尾引用它）**:
  `docs/development/takeover-beiliao-20260821/onsite-connection-test-runbook-20260901.md`（PR #5408）
- 引导脚本（模式 A 接线）:`scripts/ops/stock-prep-acceptance-bootstrap.mjs`
- 项目接入面板（Web-UI 点法）:`apps/web/src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue`
