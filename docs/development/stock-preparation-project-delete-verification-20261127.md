# #6991 备料项目交付清理 · 验证记录

[开发说明与模型规划](./stock-preparation-project-delete-development-20261127.md) · [设计与验收条件](./stock-preparation-project-delete-design-lock-20261127.md) · [PR 检查](https://github.com/zensgit/metasheet2/pull/7004/checks)

## 本轮最终验证

受测代码为 [`41b187b9`](https://github.com/zensgit/metasheet2/commit/41b187b91fcc6bfb60bbb99d9835c4917a29db48)。GitHub Actions 实际检出它与主线 `71c22b92` 的临时合并提交 `ab1a460c`。本轮使用合成项目、真实 PostgreSQL 14、真实插件路由及文件存储，浏览器工作台另用合成 HTTP 响应。以下各行分别引用该代码提交的执行记录。

| 检查 | 结果 |
|---|---|
| PostgreSQL 14 备料与多维表 | 备料套件 **271/271**，恢复档案与作业 **48/48**。整个真库任务 **271 个文件通过，3,669 项通过，2 项既有跳过，0 失败**。跳过项均在独立权限管理矩阵中；备料与恢复专项已包含在总数内。[真库日志](https://github.com/zensgit/metasheet2/actions/runs/46049536604/job/140679830921) |
| 插件与前端集成 | **355 个插件套件全部通过**。前端 **71 个文件，1,841 项全部通过**，其中备料删除界面 19 项。[集成日志](https://github.com/zensgit/metasheet2/actions/runs/46049537122/job/140677122479) |
| Chromium 工作台 | **40/40**，包含预览、确认、审计，以及第二个浏览器刷新后的项目目录。[浏览器日志](https://github.com/zensgit/metasheet2/actions/runs/46049536840/job/140677121957) |
| 迁移 | 36 项迁移回放后，1,094 个数据库目录对象的指纹一致。[迁移日志](https://github.com/zensgit/metasheet2/actions/runs/46049537204/job/140677122840) |
| 后端全量与必需汇总 | 后端全量单测与插件系统必需汇总均通过。[后端单测](https://github.com/zensgit/metasheet2/actions/runs/46049536604/job/140679830976) · [必需汇总](https://github.com/zensgit/metasheet2/actions/runs/46049536604/job/140688441081) |
| 契约与宿主兼容 | OpenAPI/SDK 生成一致性、仓库 Web Tests、PostgreSQL 14–17 权限矩阵和 PowerShell 5.1 验收均通过。[OpenAPI/SDK](https://github.com/zensgit/metasheet2/actions/runs/46049537194/job/140677123241) · [Web Tests](https://github.com/zensgit/metasheet2/actions/runs/46049537214) · [权限矩阵](https://github.com/zensgit/metasheet2/actions/runs/46049537039) · [PowerShell](https://github.com/zensgit/metasheet2/actions/runs/46049537041) |

第 7 项在建表已完成且登记尚未写入时发起清理，反向也在删除持锁时发起建表。两个冲突均被拒绝，表、托管登记和项目登记完整对应。随后从真实消费入口重放旧拉取令牌、已撤销作业的排队消息、旧删除确认，新项目及对照项目的业务行、版本、登记和最近拉取字段全部保持原样；数据源调用次数没有增加。

第 8 项分别在预览前、预览后上传合成附件，检查拒绝原因和整项状态，再从原下载入口读取目标及对照文件的原始内容。目标无成功删除审计，无依赖对照可正常删除。恢复子系统还创建了已验证档案、已受理作业和保全记录，分别验证共用删除依赖检查拒绝，并逐项比较持久数据。

第 9 项在删除事务提交后、返回 JSON 前主动切断客户端套接字。原管理员只凭预览取得的操作编号查回原审计 ID 及全部分类数量。替代项目建立后，原确认被拒，回执仍是同一条；同租户另一管理员、其他租户及其他项目不能读取该次回执。

## 前轮复审与定位过程（11 月 28 日，台北时间）

本轮从前次验证提交 `676c252a` 继续开发，使用合成租户、项目和协同记录。删前归属、活动写入和同号重建分别设置了对照组。

| 验证项 | 用例与判定 |
|---|---|
| 余项确认和撤销 | 同一合成请求分别通过修复前后的生产处理器。修复后，两个入口从目标查询直到写入裁定均持有当前租户及项目的活动锁。另以 PostgreSQL 两条连接和实际确认路由暂停一次写入，验证同项目清理报忙、两个对照范围可加锁、写完后释放。该用例的裁定台账使用测试替身。 |
| 普通共享表 | 插件测试覆盖实时行与回收站行、双向归属冲突、非默认键列和拆分键。真库用例先预览，再改变映射列中的 PLM 键，验证确认拒绝；还把对照行的键指向目标，验证预览拒绝。恢复数据后只删除目标行。 |
| Yjs 记录 ID 复用 | 缓存命中和冷启动两条单测都注入一次清理失败。真库中另一副本重建同 ID 并保存编辑，旧副本两个并发重连都读到新文档，新快照及增量仍各有一条，对照项目可继续恢复。 |
| 权限、重建与目录 | 验证权限探测及无效请求保留权限版本；专表同号重建后，历史绑定须重新审批。两个独立 Chromium 上下文使用合成 HTTP 验证，删除者操作后，另一端刷新才清除自己的旧卡片，对照卡片保留。 |
| 发布与回退 | 已复核开关、旧副本排空、旧定时任务暂停和数据库回退顺序。生产环境启停、恢复演练和生产规模锁时长未实测。 |

### 可复验的运行结果

提交 `915bd3f8` 已通过 PostgreSQL 14 的 269 个备料用例，多维表真库总计 3,666 过、2 跳过。集成插件 355 个套件和 1,838 个前端用例通过；备料 Chromium 40/40。CI 对应的测试合并版本为 `11ea23edc`（主线 `166e1271`）。[多维表与备料真库](https://github.com/zensgit/metasheet2/actions/runs/46042362135/job/140657504462) · [插件及集成前端](https://github.com/zensgit/metasheet2/actions/runs/46042361770/job/140653029012) · [Chromium](https://github.com/zensgit/metasheet2/actions/runs/46042362228/job/140653031437)

[11 月 28 日新增评审](https://github.com/zensgit/metasheet2/pull/7004#pullrequestreview-6091702985) 要求在此基础上补齐第 7–9 条验收。新增的用例暂停真实建表路由、在同号重建后重放令牌和队列消息、从原下载入口读取附件、在恢复子系统实际创建档案/作业/保全记录，并在真实确认事务提交后切断 HTTP 响应，再按预览编号取回成功审计。最终执行结果见本文首节。

### 第 7–9 项验收证据

| 验收条件 | 实际检查位置 |
|---|---|
| 建表与删除互斥；旧操作重放 | [正式建表入口的双向交错](../../packages/core-backend/tests/integration/stock-preparation-project-delete-create-order-realdb.cases.ts) · [从 apply、作业 run 和删除确认入口重放](../../packages/core-backend/tests/integration/stock-preparation-project-delete-delivery-realdb.cases.ts) |
| 保留依赖 | [真实附件在预览前及确认前加入，并从下载接口读回原字节](../../packages/core-backend/tests/integration/stock-preparation-project-delete-retention-realdb.cases.ts) · [已验证档案、已受理恢复作业及保全记录逐项阻断](../../packages/core-backend/tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts) |
| 响应丢失 | [成功提交后断开 HTTP 连接，用预览编号读回原数量](../../packages/core-backend/tests/integration/stock-preparation-project-delete-delivery-realdb.cases.ts) · [原操作者、租户与项目隔离](../../packages/core-backend/tests/integration/stock-preparation-project-delete-realdb.cases.ts) · [只读查询的界面行为](../../apps/web/tests/StockPreparationProjectDelete.spec.ts) |

`1afa9340` 的 PostgreSQL 14 多维表任务首次实跑新增用例，3,668 项通过、1 项失败、2 项原有跳过。两种附件时点以及恢复档案、作业、保全阻断均通过。唯一失败来自旧拉取令牌重放：替代项目业务行完整，但其登记的最近拉取结果被记成“拒绝”，更新时间随之改变。修订在获取新项目的写租约及记录结果前核对已清理项目的令牌。保留原始快照断言，并检查重放期间没有读取数据源。[发现问题的真库实跑](https://github.com/zensgit/metasheet2/actions/runs/46046909270/job/140670850899)

### 复验本轮用例

真库命令须在专用测试库完成仓库迁移后执行。下面的名称过滤匹配各组项目删除用例；同一文件去掉名称过滤即可运行整个备料套件。

```sh
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/stock-preparation-p4-repair-once-realdb.test.ts -t 'project deletion'
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts -t 'stock preparation cleanup refuses'
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/yjs-persistence-hardening.test.ts
```

## 前轮真库结果（`88b4fda6`）

前轮代码提交 `88b4fda6` 的 PostgreSQL 14 删除专项为 **26/26**。第 26 项在数据库上交错执行权限准入、临界撤权与项目确认：过期或撤权时版本变化回滚，成功时仅为受影响的表推进权限版本，同表兄弟项目和另一租户的权限记录保留。整个备料文件 267/267，字段转换和 Yjs 竞态 74/74。多维表总计 271 个文件全部通过，**3664 过、2 跳过、0 失败**；两项跳过均来自独立的权限管理用例。[该提交多维表真库任务](https://github.com/zensgit/metasheet2/actions/runs/45991405101/job/140482840785)

同一代码提交通过后端全量单测、插件系统汇总门槛和 Chromium 工作台验收。审批、运行时、多维表和考勤分别在真实数据库上运行。[后端全量单测](https://github.com/zensgit/metasheet2/actions/runs/45991405101/job/140482840792) · [汇总门槛](https://github.com/zensgit/metasheet2/actions/runs/45991405101/job/140492895215) · [标准 Chromium 验收](https://github.com/zensgit/metasheet2/actions/runs/45991405220/job/140479854115) · [权限目录矩阵](https://github.com/zensgit/metasheet2/actions/runs/45991405489)

**前一轮对照**

提交 `7f15d279` 的 PostgreSQL 14 任务通过了全部 **25/25** 个项目删除场景。承载这些场景的备料文件共 266 项，全数通过；字段转换与撤销的 74 项也全部通过，包括两条真实 Yjs 竞态。多维表任务 271 个文件全部通过，合计 **3663 项通过、2 项跳过、0 项失败**。两项跳过均属于独立的多维表权限管理矩阵文件。[PostgreSQL 实跑日志](https://github.com/zensgit/metasheet2/actions/runs/45983477943/job/140455764018)

下一提交 `9acb6030` 再次通过同一 PostgreSQL 14 任务（25 个删除场景、整项 3663 过 / 2 跳过），审批与运行时数据库任务、Web Tests 和标准 Chromium 套件也通过；浏览器一共 39 项，包含常驻审计范围提示。[多维表数据库](https://github.com/zensgit/metasheet2/actions/runs/45986224988/job/140464497263) · [审批数据库](https://github.com/zensgit/metasheet2/actions/runs/45986224988/job/140464497245) · [运行时数据库](https://github.com/zensgit/metasheet2/actions/runs/45986224988/job/140464497230) · [浏览器验收](https://github.com/zensgit/metasheet2/actions/runs/45986225083/job/140462426647)

## PR #7004 复审验证

评审者在全新 PostgreSQL 16 上运行首版的 14 项删除专项，13 项通过。失败用例从另一张表查询侧栏，目标和对照夹具实际落在不同的库，断言在确认删除之前停止。修订版通过正式建表路径创建确认台账，并先断言两张表所在的库，再检查侧栏、隔离和重建。[评审记录](https://github.com/zensgit/metasheet2/pull/7004#pullrequestreview-6085845653)

主线冲突解除后，修复前提交 `c4263d3289` 的完整多维表 CI 实跑得到 270 个文件通过、1 个文件失败，其中 10 个失败均在删除验收入口。这是共享 CI 数据库中的结果，与评审者的独立空库结果分开记录。[修复前的数据库任务](https://github.com/zensgit/metasheet2/actions/runs/45975431022/job/140427894987)

复审在原 14 项上新增了真库场景，包括预览和普通写入的两种顺序、确认期间的并发写入、批量编辑的锁数量、受限写入角色、旧沙箱和共享检查点、跨副本旧拉取、小连接池、协同记录 ID 复用及业务台账直接写入。原有运行状态用例也增加了专表冲突审批与共享对照的断言。定向命令如下。

```sh
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/stock-preparation-p4-repair-once-realdb.test.ts -t 'project deletion'
```

在提交 `7296c46e8`，GitHub 已成功应用本切片的五项迁移。PostgreSQL 14 实跑 25 个删除场景，其中 24 个通过，协同记录专项在常规回收站步骤收到 HTTP 409。测试文件内没有跳过项。整个多维表任务另有两个字段转换与协同持久化竞态失败，总计 3660 项通过、3 项失败、2 项跳过。[这一轮的 PostgreSQL 实跑](https://github.com/zensgit/metasheet2/actions/runs/45979559846/job/140441789210)

协同专项调整为通过产品的手工行接口创建对照行，先验证服务端写入的创建人和行标识，再走常规删除与恢复。字段转换执行和撤销在只更新数据、版本的活跃行上使用 `FOR NO KEY UPDATE`，从而容许协同持久化取得验证记录代次所需的 `FOR KEY SHARE`。实际写行、删除或另一次转换仍然互斥；原有竞态测试继续验证编辑端收到失效通知以及旧协同状态已被清理。

同轮相邻验收补修如下。

| 相邻验收 | 修正与定向证据 |
|---|---|
| 集成插件与离线交付 | 复用授权路径解析出的租户，活动锁、查找目标表、源读取和后台作业使用同一身份。按实际分发文件更新两个离线 SHA-256 摘要，保留 S4、S5 和 S6-A 的链尾顺序。完整 `pnpm --filter plugin-integration-core test` 本地通过 355 个套件。 |
| PostgreSQL 权限目录 | 对新增的 37 个函数整体核对完整目录摘要，包括函数体、签名、所有者与搜索路径。额外函数、函数体或权限属性发生变化时仍然拒绝授权。权限单测 171 项和守卫测试 8 项通过。 |
| 审批与工作台 | 审批测试启动器固定了主连接池源码，确认使用的查询和事务路径后更新其文件摘要，63 项定向测试通过。备料审计动作加入 `project_delete` 中英文名称和筛选项，客户端与服务端的 22 项词表逐项比较。工作台操作面板及相邻文件 334 项通过。 |
| 历史迁移与检查点 | 历史迁移回滚会重建八张挂有新触发器的表。回放按依赖顺序先拆除、后恢复三个协调迁移，并比较触发器定义。CI 配置专项 43 项通过。三个迁移实际生成的函数声明逐项验证了搜索路径，与相邻迁移测试合计 7 项通过。 |

提交 `7f15d279` 已在 GitHub 验证迁移回放：36 项迁移回滚再应用后，1,094 个目录对象指纹一致。注入一次回滚失败后，恢复并重跑得到相同指纹。权限目录在 PostgreSQL 14、15、16、17 四个版本全部通过。SQL Server 2019、2022 的离线交付验收和集成插件守卫也已通过。[迁移回放](https://github.com/zensgit/metasheet2/actions/runs/45983478261/job/140453063134) · [权限矩阵](https://github.com/zensgit/metasheet2/actions/runs/45983477945) · [离线交付验收](https://github.com/zensgit/metasheet2/actions/runs/45983477897) · [集成守卫](https://github.com/zensgit/metasheet2/actions/runs/45983478046)

同一提交还通过了完整 Web Tests，以及使用已还原触发器的隔离检查点验收。[Web Tests](https://github.com/zensgit/metasheet2/actions/runs/45983478223/job/140453006125) · [隔离检查点](https://github.com/zensgit/metasheet2/actions/runs/45983477943/job/140455764093)

复审后的本地工作台回归为 5 个文件 306 项通过，Yjs 持久化及关闭回写回归为 6 个文件 48 项通过，插件删除与后台试算专项为 27 项通过。后端构建与仓库 lint 通过。

本地专项覆盖写入活动协调、会写凭据的 GET、共享历史拒绝、旧沙箱归属、冲突审批范围和协同写入代次。分别移除关键守卫后，对应断言失败；恢复代码后重跑通过。预览与删除后目录截图来自首版，审计筛选截图来自复审修订。

### 全量单测复审

在 `9acb6030` 上，后端全量单测有 6 个文件的 11 项断言失败。已逐一校正测试清单、实时通信发送点、钉钉身份相关操作登记、数据库 advisory lock 的命名空间，以及授权输入和表权限写入的约束。插件内每个可删业务表都有固定的 SQL 目标，涉及权限的数据由已鉴权的宿主在同一事务处理。原 6 个文件本地复跑 288/288 通过，完整集成插件测试链 355/355 通过。新增真库用例覆盖权限版本行已被占用、过期确认回滚版本增量、同表其他项目与另一租户的权限记录隔离。[复审前的完整单测](https://github.com/zensgit/metasheet2/actions/runs/45986224988/job/140464497225)

## 按需求验收

| 门槛 | 已验证的行为 | 结果 |
|---|---|---|
| G1 预览与归属 | 只拉取、只登记和二者兼有的项目均可清理。共享基线或归属不明时拒绝；旧沙箱保留其他项目；内容变更使原预览失效。 | PostgreSQL 通过 |
| G2 身份与验证码 | 权限或租户不匹配、错误或过期验证码、重放均被拒绝。两个连接并发确认最多提交一次。 | PostgreSQL 通过 |
| G3 原子性与审计 | 中途删除或写审计失败均完整回滚。目标项目与其他项目同时编辑、直接写台账及跨副本在途拉取均按作用范围处理。 | PostgreSQL 通过 |
| G4 工作台与隔离 | Chromium 覆盖预览、取消、提交、返回目录。真实 HTTP 与数据库验证双登记项目的侧栏和旧表、同租户其他项目、另一租户同号以及通用删除保护。 | 浏览器与 PostgreSQL 通过 |
| G5 调度与同号重建 | 原调度收到 ABSENT 后跳过；以同号重建为空表，旧审批、作业和协同文档不能沿用，对照项目仍可正常回收与恢复。 | PostgreSQL 通过 |
| G6 名额与配置 | 200 个登记含归档时限制生效，清理后释放名额，租户数据源绑定及批次设置逐项保持一致。 | PostgreSQL 通过 |

## 已运行

| 检查 | 结果 |
|---|---|
| 插件删除专项 `node --test plugins/plugin-integration-core/__tests__/stock-preparation-project-delete-*.test.cjs` | 20 项通过，0 跳过。加上相邻的 MVP 生成和项目表合同文件后，共 22 项通过。 |
| 邻近插件路径 | 写锁、归档、项目表路由及存储、权限矩阵、审计存储、迁移动作、后台试算、大 BOM、自动化入口等文件分别通过。后台试算返回 202 后仍持有活动锁，直至终态结果持久化。 |
| 工作台回归 | 5 个 Vitest 文件共 306 项通过，其中 15 项为删除专项。范围含项目页、工作台、首页、项目目录和删除组件。浏览器截图使用受控合成 API 响应。 |
| 缓存与迁移 | 表元数据缓存专项和相邻用例 14 项通过；迁移发现、闸门和时间戳唯一性测试 29 项通过。源码和编译产物的迁移发现结果均为 494 项。 |
| 配置、构建与契约 | 后端构建通过，备料前端专项类型检查通过，OpenAPI 构建、SDK 生成和契约检查通过，开关清单 92 项通过，仓库 lint 通过。插件清单验证为 13/13，有 9 条警告。 |
| 调度器 | ABSENT、ARCHIVED 及其他 409 的 3 个专项通过。完整文件 40 项中 38 项通过，另外 2 项依赖本地 HTTP 监听，沙箱返回 `listen EPERM`。 |

守卫变异检查分别移除租户绑定、指纹比较、审计行数检查，或放宽专表和旧共享表的归属证明、旧表缓存身份比对、已删项目的调度拦截、前端验证码匹配。对运行记录另有三次独立变异，分别移除旧作业归属、活动作业拒绝和实际删除行数检查。对应测试均出现失败；恢复实现后重跑通过。

## 复验命令

在仓库根目录运行本地专项。

```sh
node --test plugins/plugin-integration-core/__tests__/stock-preparation-project-delete-*.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-dry-run-jobs.test.cjs
node --test --test-name-pattern '409 STOCK_PREPARATION_PROJECT_ABSENT|409 STOCK_PREPARATION_PROJECT_ARCHIVED|any OTHER 409' scripts/ops/__tests__/stock-preparation-scheduled-pull.test.mjs
pnpm --filter @metasheet/web exec vitest run --watch=false tests/StockPreparationProjectDelete.spec.ts tests/StockPreparationProjectBoard.spec.ts tests/StockPreparationWorkspace.spec.ts tests/StockPreparationOperatorHome.spec.ts tests/StockPreparationOperatorProjectDirectory.spec.ts
pnpm --filter @metasheet/web type-check:verification-stock-prep
pnpm --filter @metasheet/core-backend build
pnpm openapi:build
pnpm openapi:guard
```

双登记交付演练会在独立测试库中通过调度器对合成 PLM 适配器执行试拉和写入，通过多维表 HTTP 接口手填一行，再经专用接口预览、确认。它复用原调度配置重跑，核对只收到一次 ABSENT、源读取次数未增加，并以同号重建空表。三种项目状态的矩阵另用固定夹具逐项比较前后数据。该演练在上述 PostgreSQL 14 任务中已通过。

真实 PostgreSQL 用例已注册在 `plugin-tests.yml` 现有的 real-DB 步骤。在**专用空测试库**设置 `DATABASE_URL` 并使用同一 CI 的迁移和数据库初始化步骤后运行以下命令。环境标记能让缺少数据库 URL 的任务失败，避免把跳过当作通过。

```sh
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/stock-preparation-p4-repair-once-realdb.test.ts
```

本地 PostgreSQL 15 的 `initdb` 在创建共享内存时收到 `EPERM`，Docker 套接字也不可用。本地仅用 Vitest 收集数据库用例。实际迁移应用、历史回放、权限、并发和额满释放见上述 GitHub 任务。生产数据规模下的占锁时长尚未测量。

仓库级 `pnpm validate:all` 在 `tsx` CLI 建立本地 IPC 时被沙箱阻止。使用 `node --import tsx scripts/validate-plugin-manifests.ts` 单独验证了同一清单脚本。继续单独运行 `pnpm type-check`，停在 `apps/web/vite.config.ts` 的 Vite 5/7 插件类型冲突；从上述主线基线提取原配置，配合同一组本地依赖可独立复现。前端应用类型检查和备料专项类型检查均已单独运行。

## 浏览器证据

[预览界面](./assets/stock-preparation-project-delete-20261127/preview.png) · [删除后返回目录](./assets/stock-preparation-project-delete-20261127/success.png) · [按项目号筛选删除审计](./assets/stock-preparation-project-delete-20261127/audit.png)

审计截图使用已有的合成工作台和一条按项目号、删除动作筛出的虚构审计记录。Chromium 验证了搜索前后常驻的三条范围说明。 提交 7f15d279 的浏览器 CI 中，38 项通过，1 项指出审计搜索缺少范围提示。恢复这句话并加强对应断言后，本地用三个原始 Playwright 文件逐项启动 Chromium，39/39 通过。因沙箱限制本地端口监听，浏览器通过测试路由读取同一份前端构建产物。[修订前的浏览器验收](https://github.com/zensgit/metasheet2/actions/runs/45983478361/job/140453024260)

**指纹边界。** 确认时比较范围、内容及可用的行版本。某条记录在两个请求之间新建又被物理移除，并且所有持久痕迹都消失时，当前方案无法从两次盘点区分这种历史；未把这类瞬时变化作为已通过项。
