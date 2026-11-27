# #6991 备料项目交付清理 · 验证记录

首版基线为 `6babc578ec`，复审修订已对齐主线 `e33d447552`。测试均使用合成项目。删除专项已在 GitHub PostgreSQL 14 通过 26/26。开关默认关闭，生产启用由业主决定。[开发说明](./stock-preparation-project-delete-development-20261127.md) · [设计锁](./stock-preparation-project-delete-design-lock-20261127.md)

## 11 月 28 日复审补充（台北时间）

提交 `676c252a` 的 GitHub Actions 有 39 个工作流成功，1 个按条件跳过。其 PostgreSQL 删除专项已有 26 个通过场景。随后独立复审报告记录了三个当时未覆盖的阻塞项。

| 项目 | 本次验证 | 仍需验收 |
|---|---|---|
| 余项确认与撤销 | 用相同的合成请求分别运行原版与本次更改的生产处理器函数。原版的两个入口在查询目标和写入裁定时都未持有活动锁；新版在两个位置都持有已核实租户及项目的锁，且均在答复之前释放。此试验使用会话与存储替身。 | 新增 PostgreSQL 双连接用例，暂停真实确认路由的裁定写入，检查目标项目清理报忙、同租户其他项目和其他租户同号项目仍可加锁、写完可清理。等待本提交的真库运行。 |
| 普通共享拉取表归属 | 新用例用合成事务覆盖实时行和回收站行的双向矛盾、非默认物理键列、合法拆分键、非法后缀和对照行保留。在同一用例上原版未拒绝，新版通过。 | 新增普通共享拉取表的 PostgreSQL 用例，验证预览后篡改、反向矛盾及对照行保留。等待此提交的真库运行。 |
| 同号重建后的协同编辑 | 核对了 `YjsSyncService` 对隔离记录按 ID 重试清除，以及持久层 `purgeRecords` 的删除条件。现有真库用例覆盖旧文档压缩与释放；隔离重试属于另一条路径。 | 旧副本一次清理失败后，新副本同 ID 重建并编辑，再由旧副本重连。新编辑及其持久状态须完整保留。 |

运行上述新用例：

```bash
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/stock-preparation-p4-repair-once-realdb.test.ts -t 'a pending remnant decision'
```

真实数据库和升级、回退演练均须使用合成环境。发布前同时复核旧绑定审批、其他浏览器的目录缓存、权限探测和 API 契约。

## 修复版真库结论

最新代码提交 `88b4fda6` 的 PostgreSQL 14 删除专项为 **26/26**。第 26 项在数据库上交错执行权限准入、临界撤权与项目确认：过期或撤权时版本变化回滚，成功时仅为受影响的表推进权限版本，同表兄弟项目和另一租户的权限记录保留。整个备料文件 267/267，字段转换和 Yjs 竞态 74/74。多维表总计 271 个文件全部通过，**3664 过、2 跳过、0 失败**；两项跳过均来自独立的权限管理用例。[最终多维表真库任务](https://github.com/zensgit/metasheet2/actions/runs/45991405101/job/140482840785)

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
