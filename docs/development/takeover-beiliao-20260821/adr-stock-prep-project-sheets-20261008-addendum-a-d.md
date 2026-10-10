# 附录：A–D 四点的代码依据与建议（ADR `adr-stock-prep-project-sheets-20261008` 配套，2026-10-08）

> 本附录的建议已于 2026-10-08 并入 ADR 正文（见 ADR 头部「裁决记录」）；保留作依据。
> 基线是 origin/main `9eee3a3cd`。下文的 `path:line` 都用 `git show origin/main:<path>` 核对过。写「ADR §x 行 y」的，指 ADR 分支上草稿的行号。本附录不含主机、凭据、表 id 或真实项目号。
> 已采纳的 owner 裁决（2026-10-08）：(1) 一线不能拉取，只能填表；(2) 删除和恢复由拉取人员负责；(3) 旧混表不要了；(4) 先建空表再预览；(6) 写入授权继承沙箱放行。
> owner 另问：(5) 总览表能否由一线直接填写、子项目表自动更新；(7) 归档由拉取人员操作、归档后不在总览主列表而在其下方显示、一线可按权限看自己归档的表、项目查询页可见归档表。本附录按代码回答 (5)(7)，并给出 (3) 的后果。

## 0. 建议总表

| 点 | 建议 | ADR 要改的地方 |
|---|---|---|
| A 权限三档 | 新增权限码 `stock-prep:pull` 作为「拉取人员」。一线仍是 `read`+`operate`，只失去拉取、建表、归档。另有一个硬缺口：新建的项目表要给一线角色加表级授权（新增 Q7） | Q1、Q2、§2「谁能建」、§4 `may`、§6 的门；新增切片 S0；新增 Q7 |
| B 总览可编辑 | 采用 O1 + O2(a)。不做 O3（仓库里没有任何双向同步机制） | §5 加「采购未完成 / 仓库未完成」两列、「截至时间」和一张「待填写」视图；写明一线的编辑只发生在项目表 |
| C 归档 | 用归档代替删除：登记行状态为 `active`/`archived`，表本身不软删、不动授权，不需要新的宿主 port | Q2、§1.2、§4、§5、§6、§10 S4；「归档」一词要和现有的「归档过」区分开 |
| D 旧混表 | 不登记、不迁移、不删除。env 里的 `action.target` 仍然必须保留，但代码只读它的值。删掉 register-bound 和 `ROWS_IN_BOUND_SHEET` 两项 | 删 §1.3、Q3、§4「防止数据分家」、§6「旧表不能删」、§8 第 2–3 步；§8 补写「关开关」现在意味着什么 |

---

## A. 权限：一线 / 拉取人员 / 管理员

**A.1 现状**
- 三个码之间的阶梯：平台管理员 > `stock-prep:admin` > `read`；`operate` 必须和 `read` 同时持有才算数（`plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs:31-44`，`:55-75`，`:399-408`）。
- 「一线可以自助拉取」是 owner 早先的裁决（`workbench-access.cjs:227`）。判定只有一个函数 `operatorMayRunStockPrepPull`，它委托给 OPERATE 档（`:438-441`）。
  - 唯一调用点在 `http-routes.cjs:1150`，而且只在 legacy `integration:*` 门已经拒绝之后才问（`:1142-1149`）。
  - 它一次覆盖 11 个子路由：dry-run、apply、大 BOM 8 个、reconcile（`workbench-access.cjs:267-371`）。
  - mvp-persist 仍然只给平台管理员（`:374-381`）。
- 一线其他功能都挂在 OPERATE 档上：目录（`:157-161`，路由 `http-routes.cjs:9090`）、看板（`:199-202`，`:9797`）、录入值回读（`:127-131`，`:8763`）、确认「等您拿主意」（`:133-138`，`:8806`）、导出（`:144-149`，`:8948`）、交接推进（`:186-191`，`:9455`）。
- 挂在 READ 档上的：队列列表（`:8727`）、交接状态（`:9222`）。结转 confirm 一直是平台管理员（`http-routes.cjs:8132`）。
- 左侧导航里「今天要处理 / 项目备料 / 项目查询」用的是 operator-board 门，也就是 OPERATE（`workbench-access.cjs:522-527`，`:565`）。没有 OPERATE 的人会落到确认队列（`:607-608`）。
- 前端的拉取按钮由 `canRunStockPrepProjectSync` 决定，条件是平台管理员或 OPERATE（`apps/web/src/services/integration/stockPreparation/workbenchAccess.ts:476-479`）。使用位置：`StockPreparationProjectBoardView.vue:788`、`StockPreparationProjectSyncPanel.vue:464`。
- 演示机的一线角色恰好有 `read`+`operate`，外加 3 个审批码和 1 行表级 write 授权，没有全局 `multitable:read`（`docs/.../frontline-role-permission-plan-20260916.md:16`，`:58-70`，`:82-95`）。

**A.2 两条路**

| 路 | 一线会怎样 | 结论 |
|---|---|---|
| **路 1：新增 `stock-prep:pull`** | 只失去拉取、建表、归档，其他都保留 | **推荐** |
| 路 2：把 `operate` 当成拉取人员，一线降到只有 `read` 加表级授权 | 首页、项目备料、项目查询全部看不到（`:565`），落地页变成确认队列（`:607-608`）。连队列页上的项目清单也要 projectDirectory 能力（`StockPreparationConfirmationQueueView.vue:241`），所以一线手上没有任何项目列表。同时失去确认、导出、交接推进 | 收回的权力远超 owner 的裁决，不推荐 |

**A.3 路 1 具体改哪些检查**
1. `workbench-access.cjs`：新增常量 `STOCK_PREP_PULL`，加入 CODES（`:75`）和 DESCRIPTORS（`:78-86`）；`satisfiesStockPrepAccess`（`:399-408`）加一个分支：PULL 需要 `pull`、`operate`、`read` 三个码同时持有（理由同 `:36-44`：拉取面板在看板里，看板要 OPERATE）。管理员和平台管理员的短路（`:402-403`）不用改，管理员档自动包含拉取。
2. `operatorMayRunStockPrepPull` 的 `:440` 从 OPERATE 改成 PULL。`http-routes.cjs:1150` 是唯一调用点，11 个子路由一起移过去；legacy 门不变。
3. ADR 新增的路由：建表、归档、恢复用 PULL；GET target 和总览 refresh 留在 OPERATE。
4. 前端：`workbenchAccess.ts` 的镜像要和后端保持字节一致（F-01，`workbench-access.cjs:489-491`）；`canRunStockPrepProjectSync`（`:476-479`）改成 PULL；看板的空状态不能指向用户没有的按钮（`ProjectBoardView.vue:786-788`），对没有拉取权的人显示「请联系拉取人员」。
5. 迁移：照 `zzzz20260830100000_add_stock_prep_permissions.ts` 的写法播种这个码。角色写入会用 400 `UNKNOWN_PERMISSION_CODE` 拒绝目录里没有的码（`packages/core-backend/src/routes/roles.ts:380-392`）。
6. 测试：operator-pull-gate 套件（`workbench-access.cjs:257`）和两侧的权限矩阵。

**A.4 一线保留什么、失去什么**

| 保留（今天就在用） | 失去 |
|---|---|
| 今天要处理、项目备料看板、项目查询 | 项目接入面板：dry-run、apply、大 BOM、reconcile |
| 确认队列和「等您拿主意」的 confirm、录入值回读 | 新建项目表 |
| 按项目导出 Excel | 归档、恢复 |
| 交接状态、「通知下一步」推进 | — |
| 用深链打开填写视图（前提是有表级授权，见 A.6） | — |

**需要 owner 确认的取舍**：确认裁决和交接推进不在多维表里，而在 `/stock-prep` 工作台里。字面上的「一线只在多维表里填写」会把它们也拿走。建议一线保留这两项：被扣住的行不裁决就不会写入。

**A.5 演示角色怎么改**
- 一线角色 `stock-prep-operator` 不用改。
- 新建一个角色「备料拉取人员」，权限为 read+operate+pull。在「角色管理」里配：`PUT /api/roles/:id` 自 #5802 起会写入权限集（`roles.ts:588`）。不要用迁移写角色，角色是现场数据。
- **生效时机**：这个改动不跟开关走，升级后立即生效，一线马上失去拉取。这和 ADR §8「开关关着时逐字节不变」矛盾，需要在 ADR 里写明是有意的，并在决策登记册里记下 owner 推翻了 `:227` 的旧裁决。
- 定时试拉脚本的 token 如果是一线账号，升级后会 403。脚本只调 dry-run 和 apply（`scripts/ops/stock-preparation-scheduled-pull.mjs:369-373`），legacy 门是 `integration:read` / `integration:write`（`workbench-access.cjs:272,278`）。
- 因此 runbook 必须先建好「备料拉取人员」角色，再升级。
- **2026-10-10 订正（R-39，切片 S5a）**：上面三处已不成立。(1)「升级前先建角色」做不到：`stock-prep:pull` 随 S0 迁移才进目录，角色编辑器对目录外的码回 400（`roles.ts:381-393`），所以真实顺序是 R63 迁移跑完后在角色管理里手工建 id 为 `stock-prep_puller` 的角色（read+operate+pull）。(2)「不要用迁移写角色」已被 R-33 推翻：四个内置角色（`stock-prep_admin` / `stock-prep_puller` / `stock-prep_developer` / `stock-prep_frontline`）由 S5a 迁移 `zzzz20261010124500_seed_stock_prep_role_templates` 播种为零成员模板；R63 手建的 `stock-prep_puller` 被原样采纳（不改名、不改码、不动成员）。(3)「一线角色 `stock-prep-operator` 不用改」也随 ADR §11.2-1 改为迁到 `stock-prep_frontline`，用 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs`（ADR §8 第 3 步；在任何服务器上运行都是 owner 动作）。

**A.6 ADR 没写到的硬缺口：新项目表的表级授权（建议列为 Q7）**
- 一线没有全局 `multitable:read`，读一张表靠这张表上的授权行（`permission-service.ts:1508-1515` 的兜底分支；frontline plan `:84-99`）。
- 新建的项目表一条授权行都没有：插件的 provisioning 端口没有授权动词（`multitable/plugin-scope.ts:347-565`）；看板路由自己写明插件「没有用户感知的 ACL 接缝」（`http-routes.cjs:9790-9794`）。
- 后果：拉取人员建表成功，一线点「打开」在 `/context` 得到 403。
- 三种做法：
  - **G1（推荐，放进 S1）**：新增一个窄宿主 port。先例是插件写 `field_permissions` 的那个窄口（`services/stock-preparation-field-permissions.ts:1-40`）。限制为：只对插件自有的项目表；只写 role 主体；权限级别固定为 `spreadsheet:write`；角色清单来自服务端配置；只增不删；写审计。
  - **G2（G1 落地前的过渡）**：管理员在「权限」里逐表手工授权（`univer-meta.ts:9797-9816`）。这需要 `canManageSheetAccess`，即管理员，或「持有 `multitable:share` 且能读这张表」（`multitable/access.ts:120-121`，`permission-service.ts:1482,1494`）。
  - **G3（不选）**：给一线全局 `multitable:write`。已被否决，因为这个码没有租户边界（frontline plan `:86-93`）。
- G1 是一项新的写权力，所以要 owner 拍板。

## B. 总览能不能让一线编辑，并让子项目表自动更新

**B.1 一线今天到底填什么**
- **物料行上的人工列**，在多维表里填。主表有 13 个 `human_preserved` 列（`stock-preparation-templates.cjs:767-845`），例如材料类型、备料状态、需求日期、采购回复、采购完成、仓库完成、实际到货日期。填写视图只隐藏 12 个 plm_system 列（`:891-904`），按父组件分组，只显示有效行（`:915-919`；视图描述符在 `target-provisioning.cjs:610-645`）。apply 只刷新 PLM 来的列，保留人工列（`templates.cjs:691-698`）。
- **裁决**，不在多维表里填。一线在 `/stock-prep` 队列里调用 confirm（`http-routes.cjs:8801-8806`）。一线对账本表没有表级授权（frontline plan `:82`）。账本里的人工列见 `templates.cjs:1007-1010`。

**B.2 现在有没有跨项目的工作面**
- 裁决有，但只到「项目」这一级：确认队列页上的「您这边等着处理的项目」（`ConfirmationQueueView.vue:240-262`），数据来自目录行的 `pendingDecisionCount`（`stock-preparation-operator-project-directory.cjs:552`）；首页的「等您拿主意」筛选。
- 逐条裁决的列表必须带 `projectNo`（`http-routes.cjs:8733-8736`），所以没有跨项目的逐条列表。
- 物料行的填写进度：完全没有跨项目的面。

**B.3 多维表现有的跨表机制**
- **lookup / rollup**：都是计算列，写入会被拒（`record-write-service.ts:563`），只能单向回显。插件模板只允许 5 种字段类型（`templates.cjs:11`），连 link 列都建不出来。
- **跨库镜像** `/crossbase/mirror-link`：只改链接边，不改值；同库镜像一律只读；默认关闭（`univer-meta.ts:20682-20699`）。
- **自动化 `update_record`**：跨表时 targetSheetId 和 targetRecordId 都要写死（`automation-executor.ts:963-974`），没法按行路由；而且是裸 SQL 写入，绕过写校验（`:3122-3127`）。
- **记录事件** `multitable.record.updated`：消费者只有自动化和 webhook（`automation-routing-manifest.ts:90`），插件代码里一处订阅都没有。
- **结论：仓库里没有任何双向同步机制。**

**B.4 三个方案**

| 方案 | 成本 | 风险 |
|---|---|---|
| **O1**：总览严格只读。每行深链到该项目的「待填写」视图；裁决仍以账本作为跨项目队列 | 低。新视图用 `ensureView`（`plugin-scope.ts:526`），照填写视图的先例（`target-provisioning.cjs:647-689`） | 无新的写面 |
| **O2(a)**：项目级的列（负责人、备注、计划完成）存在登记表里，通过插件路由修改（OPERATE 档；审计只记「改了哪一列」，不记值），在项目查询或首页卡片上编辑，投影到总览只读。这些列**不**同步到物料行 | 中：登记表加 3 列、1 个路由、1 个小表单 | 和 Q5「宿主层面只读」不冲突 |
| O2(b)：在总览网格里直接改这几列 | Q5 要从「整表只读」改成「按列」 | 插件唯一的列写权工具是按角色的 field_permissions 端口（`stock-preparation-field-permissions.ts:1-40`），没列到的角色管不住。v1 不推荐 |
| **O3**：一张跨项目的「待处理行」表，镜像物料行并写回（双向同步） | 很高 | 见下文 |

O3 为什么不安全：
1. **没有触发点**。插件收不到行编辑事件（`automation-routing-manifest.ts:90`），自动化又不能逐行路由（`:963-974`），所以得新建一条宿主事件到插件的通道。
2. **会多出一个写入者**。项目表今天唯一的机器写入者是 apply：它按 `idempotencyKey` 定位行（`templates.cjs:701`），并保留人工列。写回器、apply、结转、人工四方会并发改同一个人工列，跨表又没有版本比较，会丢更新。
3. **撞上一表一项目守卫**。装了多个项目行的表，正是 #5860 守卫要拒绝的形状（`stock-preparation-table-actions.cjs:1059-1100`）。
4. **权限被绕开**。镜像表上的一条授权就等于能看、能改所有项目的行，因为授权只按表匹配（`permission-service.ts:1473-1506`）。写回又以插件身份写，绕过一线在项目表上的列写权。
5. **校验被绕开**。自动化路径不经过写校验（`automation-executor.ts:3122-3127`）。

**B.5 推荐 O1 + O2(a)。在这个方案下，「子项目表自动更新」的意思是：**
- 一线的编辑只发生在项目表里，项目表是唯一的数据源，所以根本没有「同步」这一步。
- 自动更新的是**总览上的数字**：拉取和裁决驱动的列在插件事件发生时更新（ADR §5）；新增两列反映人工填写进度：「采购未完成 / 仓库未完成」，按 `procurementDone` / `warehouseDone` 这两个布尔列计数（`templates.cjs:840,842`）。不能用「备料状态」当判断条件，它的选项值由客户自定义（`:775-778`）。这两列只在 refresh 时或打开首页时有界重算，因为没有行事件。总览上要显示「截至 hh:mm」。

## C. 归档生命周期

**C.1 现状**
- 「项目查询」是导航项 `project-query`，门和项目备料相同（`workbench-access.cjs:524-527`）。页面组件是 `StockPreparationProjectQueryView.vue`。数据是目录读（`:311`）并上本机记忆（`projectQuery.ts:9-16`）；选中某行后再读这个项目的看板（`View.vue:658`）。
- **「归档」这个词已经被占用了**：项目查询的「来源」筛选里，`mvp` 显示为「归档过 / Archived」（`ProjectQueryView.vue:512,562-563`；`projectQuery.ts:40,57`）；首页提示语写着「管理员归档过的项目」（`OperatorHome.vue:245`）；另见 `plainLanguage.ts:1226`；目录模块里的 archive 指的是 MVP 项目表的行（`directory.cjs:472,606`）。**建议**：旧的 `mvp` 来源改个名（例如「平台登记」，由 owner 定词），让新的生命周期独占「已归档」。代码里新状态叫 `archived`。
- **宿主没有「隐藏表」开关**：`meta_sheets` 只有 `deleted_at`（`db/types.ts:628-636`）；列表里会隐藏的只有 People 目录表（`system-sheet-predicate.ts:55-60`）；表一旦软删，宿主所有按表的路径都拒绝访问（`univer-meta.ts:16253-16258`），一线就看不到归档的表了。所以**归档不能用软删实现**。

**C.2 生命周期设计**
- **谁可以操作**：拉取人员，即 PULL 档（含 `stock-prep:admin` 和平台管理员）。
- **状态存在哪里**：登记表新增 `status IN ('active','archived')`，以及 `archived_by/at`、`restored_by/at`，加约束 `CHECK ((status='archived') = (archived_at IS NOT NULL))`。迁移 088 的审计动作改为 `project_target_create/_archive/_restore` 和 `project_overview_refresh`。
- **表本身**：不软删、不动授权、不改名。恢复就是把状态改回 active 并写审计。因此：ADR §6「宿主缺两个口」不再需要；`provisioning.ts:481-500` 那个「软删旧行仍占着表 id」的冲突也不存在了；「撤销新建」可以删掉：用户取消后留下的空表，拉取人员把它归档即可。
- **200 张上限**：按登记行总数计算，因为归档的表仍然是活表。

**C.3 归档后各路由的行为**

| 路由 | 归档后 |
|---|---|
| 建表、dry-run、apply、大 BOM、reconcile、mvp-persist | 409 `STOCK_PREPARATION_PROJECT_ARCHIVED`；GET target 返回 `status:'archived'` 和 `may.restore` |
| confirm 裁决、交接推进 | 同一个 409（不改账本，不发钉钉） |
| 看板、导出、交接状态、录入值回读 | 照常可用（只读） |
| 定时试拉 | 当作「跳过」，和 ABSENT 一样 |
| 多维表网格 | **不受影响**：宿主不知道「归档」，原来能写的人仍然能写。如果要让网格只读，就得撤销或降级授权（见 A.6），v1 不做，请 owner 确认 |

**C.4 展示**
- **总览**：归档的行留在表里，状态显示「已归档」。一个网格视图画不出「主列表 + 下方分区」，所以由插件建两张视图：默认视图「进行中」（状态 ≠ 已归档）和「已归档」视图。
- **首页**：卡片主列表排除归档项目，下方放一个折叠区「已归档（N）」。`stockPrepPosture`（`projectPosture.ts:115`）里，「已归档」优先于其他状态。
- **项目查询**：行上加「已归档」标签，另加一个独立开关「含已归档」，默认打开。不要把它加进 `STOCK_PREP_HOME_FILTER_KEYS`（`projectQuery.ts:50`），那组键和首页共用，改了会连带改首页的筛选按钮。

**C.5 一线能不能看到归档的表**
- 归档不动授权，所以原来谁能读这张表，归档后照样能读。不需要建立按人的归属模型。
- 「看到自己的归档表」的落地方式：列表层面，目录本来就是按租户的（`directory.cjs:34-39`），一线在项目查询里能看到本租户所有归档项目的号和名；能不能打开，由表级授权决定（`http-routes.cjs:9790-9794`）。`created_by`、`last_pull_by` 只是记录的事实，不用来授权（ADR §9）。

**C.6 还需要「删除」吗？** 不需要，归档代替删除，不做硬删也不做软删。

**代价，请 owner 确认**：归档的表仍然会出现在多维表左侧的表列表里，对有授权的人可见。也就是说，0924 #1b 说的「删不掉」，在多维表那一侧不会消失。要真正从列表里消失，只能软删（和「一线可看归档表」矛盾），或者给宿主加隐藏标记（新的宿主改动）。

## D. 旧混表「不要了」意味着什么

**D.1 env 里仍然不能删的部分**
- **env 里的动作 JSON 必须仍带 `target.sheetId`**（`table-actions.cjs:281,840`）。`normalizeTarget` 要求它（`:190-200`，具体在 `:196`），而且在构造注册表时就做规整（`:885-888`，`:475`）。缺了它，整个动作返回 422 `TABLE_ACTION_CONFIG_INVALID`，`source`（`:474`）也一起失效。受影响的有：source-preflight、数据源绑定、集成总览（`http-routes.cjs:7093,8526,8621,5023`）。
- **Q6 写入门的第 4 条**读 env 里的 `target.objectId`，看它在不在沙箱放行清单里（门在 `table-actions.cjs:2384-2400`）。
- **客户包重装**需要知道旧 objectId 装过哪个包（ADR §2）。

以上三处都只用到值，不读旧表的内容，所以**旧表可以原样放着不动**。

**D.2 必须切掉，否则旧表会继续干扰**
- **ADR §4「防止数据分家」（`…_ROWS_IN_BOUND_SHEET`）**：只要某项目在旧混表里还有有效行，它就会被拒绝建新表，这直接违背「不要了」。**删掉这一条。**
- **目录的并集扫描和首页顶部的「打开备料多维表」按钮**：两者都读 env 表（`directory.cjs:468-486,512`；`OperatorHome.vue:49-66`）。开关打开时要改成读登记行，否则首页会继续把人引回旧表，还提示「请按项目号在备料表里找到您的项目」（`:62-65`）。
- **其他还在读 env 表的路由**：看板的 boundTarget（`http-routes.cjs:9826-9836`）、导出（`:8990`）、交接推进的探针（`:9547`）、结转（`:8175`）、conflict-policies 缺省走旧表（`:6930/6940/6952`）——ADR §3 写的「缺省用旧表」要改成：开关开时不带 `projectNo` 就返回 400。
- **ADR 的源码守卫**：只取 source 的 4 个调用点（`:5023,7093,8526,8621`）需要一个显式标记，否则守卫会变红，或者被迫错用 `readiness`。

**D.3 关开关现在意味着什么**：所有路由回到旧表。旧表混着多个项目，#5860 守卫会对其余项目返回 409（`table-actions.cjs:1090-1100`）。所以「关开关」等于停用拉取，而不是回到旧行为。ADR §8 要按这个改写。

**D.4 演示机对旧表做什么（只是运维操作，不涉及代码）**
1. 不登记、不迁移、不删除。界面上本来也删不掉（`univer-meta.ts:16199-16200`），而且它是唯一的回退目标。
2. 管理员在旧表的「权限」里撤销一线角色的授权，或者降为只读（`univer-meta.ts:9797`），免得一线继续往一张没人读的表里填。
3. 暂停挂在旧表上的自动化（0924 §1）。
4. 告诉客户：旧表里已经填的人工列不会带进新的项目表（ADR §9），新表第一次拉取后人工列是空的。
5. 定时试拉 `MS_PROJECT_NOS` 里的项目，在建表之前都是 ABSENT，会被跳过。需要拉取人员把每个项目建一次表。

## E. ADR 逐节修改清单

- **待拍板表**：Q1 改为「只有拉取人员（`stock-prep:pull` 及以上）能建表」，R-33 的例外对象从一线改成拉取人员；Q2 改为「归档和恢复由拉取人员负责，不删除」；Q3 删掉；Q4 去掉「撤销新建」；新增 Q7（新表授权，选 G1 还是 G2）和 Q8（旧的「归档过」改叫什么）。
- **§1.2**：状态 `deleted` 改为 `archived`；`deleted_*` 列改为 `archived_*`；删掉 `origin` 列，或只保留 `provisioned` 一个值；088 动作清单按 C.2 改。
- **§1.3**：整节删除。
- **§2**：「谁能建」从 OPERATE 改为 PULL；补一句「建表后授权」，引用 Q7。
- **§3**：解析表里 deleted 改 archived，错误码改为 `…_ARCHIVED`；conflict-policies 那一行按 D.2 改；补上 D.2 列出的需要切换的点；删掉所有 bound_legacy 相关的句子。
- **§4**：`may` 改为 `{create, archive, restore}`，按 PULL 计算；删掉「防止数据分家」；没有权限的人看到「请联系拉取人员」。
- **§5**：「已删除」改为「已归档」；加「采购未完成 / 仓库未完成」两列和「截至」时间；建两张视图，外加一张「待填写」深链视图；refresh 用 OPERATE 门。
- **§6**：整节改写为「归档与恢复」（按 C.2、C.3）；删掉宿主两个 port 和「旧表不能删」。
- **§8**：删掉第 2、3 步；加「升级前先建拉取人员角色」和「撤销一线在旧表上的授权」；补写 D.3；写明拉取门的改动不跟开关走。
- **§9**：加两条不做的事：O3 双向同步、宿主隐藏表标记。
- **§10**：新增 S0：PULL 码、播种迁移、门、前端镜像，可以先于 S1 随 R63 发布；S4 改为在插件内实现归档，不改宿主，可以并入 S1 或 S2。
