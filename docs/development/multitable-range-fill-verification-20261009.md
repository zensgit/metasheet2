# 多维表矩形复制与填充：验证报告

日期：2026-10-09（Asia/Taipei）。[PR #6271](https://github.com/zensgit/metasheet2/pull/6271)，分支 `codex/multitable-range-fill-20261008`。契约见[设计锁](multitable-range-fill-design-lock-20261008.md)，实现和使用方式见[开发说明](multitable-range-fill-development-20261009.md)。

**结论：本地实现、独立复核及真实 JWT / PostgreSQL API 验收通过；新增规格的远端 CI 尚待完成，浏览器直连后端、staging、合并和部署未验收。** 功能默认关闭，只在构建时精确设置 `VITE_MULTITABLE_RANGE_FILL_ENABLED=true` 才启用。下述 CI 为文档提交时快照，最终状态以对应提交的运行记录为准。

## 验证对象

- 原始基线：`9d65b8318f3d5cbc323b458cb5c96c2240a144f7`。
- 本轮复核前提交：`5638709d34723a5a339bb60c8a9b3f822389baec`。
- 本轮修复、浏览器脚本和截图提交：`74af99627c1068f777019568684dbf06bbf90168`。文档提交为 `d5ee37e48d7de1aa947d4199ca0328142817aec1`；随后在功能分支同步 main 并重跑验证，核心文件哈希不变。
- 已同步的 `origin/main`：`fc139c868ea9ceba8c15eb133437342bfcedbbe9`。唯一人工冲突位于开关登记表，保留 main 的两个审批提示开关和本功能开关；49 个开关定义与 557 个 required 测试条目均核对为两边完整并集。未把功能 PR 合入 main。
- 独立 worktree 内完成修改；未修改其他功能分支的源码、共享 runner 变量或部署配置。
- 真实后端规格及 CI 接线提交：`8bbe8d3c5d`，应用源码和上列基线保持不变；随后只更新本组文档。

复核并恢复变异后的核心文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `apps/web/src/multitable/composables/useMultitableGrid.ts` | `22aea92a30e65aaaf051ce26816ab49bec7b5164607ce14d859656b7de7588df` |
| `apps/web/tests/multitable-range-fill-writer.spec.ts` | `62878a014a4656d16624f1e98c4be83dca51e2e5422e9b7855548358111bd3b9` |

## 复核发现与修复

1. **成功确认不保证返回普通字段值。** `packages/core-backend/src/multitable/record-write-service.ts` 的 `patchRecords`（~L1424、~L1539）只保证逐记录版本确认，`records` 是可选计算字段回声；`routes/univer-meta.ts` 的 `POST /patch`（~L21118）转发这一契约。原范围写入不做乐观更新，却只投影回声，导致普通格可能继续显示旧值。现在完整确认后投影已提交值，再合并服务端回声。
2. **dateTime 必须匹配存储形式。** `multitable/field-codecs.ts` 的 `validateDateTimeValue`（~L1011）存储 UTC ISO；前端在确认后把毫秒值或带明确时区的文本投影为相同形式，空值保持空值。
3. **异常响应不得局部修改界面。** 空、缺失、部分、重复、越界版本及格式异常的确认均在投影之前拒绝；无相应版本确认的其他记录回声被忽略，已被实时删除的记录不会重新生成摘要。
4. **范围请求与现有写入互斥。** 单格、批量、撤销/重做请求进行中时拒绝新的范围提交；范围请求进行中时阻止这些写入。无范围请求时保留原有写入语义。
5. **同步导航也使旧范围失效。** sheet/view 切换立即增加上下文代数，包括同一 tick 内切走再切回；等待响应期间的旧视图结果不能投影到新上下文。

读取上述后端代码用于确认真实响应契约；本轮没有修改后端接口，也没有访问真实业务数据库。

## 验收门和本轮测试

| 门 | 本轮证据 | 状态 |
| --- | --- | --- |
| G1 规划器 | 80 项：四方向、反向非整周期偏移、多行/列、独立数值与日期序列、TSV、类型和上限负例 | 本地通过 |
| G2 网格交互 | 42 项真实组件测试；Chromium 八步操作、真实剪贴板、截图检查 | 本地通过；浏览器 writer 为合成内存实现 |
| G3 安全边界 | 9 项开关测试；权限、只读、锁定、隐藏、过期版本/上下文、异步取消负例 | 本地通过 |
| G4 原子写入 | 82 项：单次请求、版本、完整响应、确认值投影、403/409/422、网络失败、互斥、导航及实时数据 | 本地通过；传输为 mock |
| G5 接线与回归 | 190 项相邻前端；5 项前端清单检查；63 项后端清单守卫；52 项已有后端写入测试；38 项开关登记检查 | 同步 main 后本地通过；`fa99d518...` 两个前端 CI 通过，新增规格的当前提交 CI 待验收 |
| G6 独立复核 | 新守卫变异造成 4 项失败，恢复后 213 项功能测试通过；应用类型检查与 Vite 打包通过 | 本地通过；完整质量链限制见下文 |
| G7 真实后端 | 真实 JWT、前端规划器、生产路由和 PostgreSQL；新增 10 项、邻接 7 项；签名变异与缺失数据库负对照 | 本地 17/17；CI 整文件接线完成，远端执行待验收 |

同步 main 后 **561 项唯一测试通过**：213 功能前端（80+42+9+82）+190 邻接前端+5 前端清单+63 后端清单+52 后端写入+38 开关登记；实际分组为前端 408、后端 115、登记 38。同步前通过 559 项，main 带入两项审批开关测试；不重复计算复跑和子代理测试。后端单测使用 mock 数据库辅助函数，不能当作真实数据库原子性或持久化验收。

Sol 的修复前回执为 31 项新增失败 / 42 项原测试通过；随后 dateTime 回归为 2 失败 / 1 通过。最终主任务独立运行四份功能规格，取得 213/213，通过的 writer 数从 42 增至 82。

### 变异与历史证据

本轮主任务临时去掉 `patchRange` 的 `activeGridWrites` 守卫，精确筛选四种既有写入期间提交范围的测试：**4 失败 / 78 未选中**；用定向补丁恢复后，四份完整功能规格 **213/213**。未选中项不算通过。

前轮的三个独立变异仍保留为历史证据：去掉版本相等检查导致 2 项失败；去掉剪贴板快照检查导致 5 项失败；去掉规划器用户写权限检查导致 1 项失败。前轮规划器在 `TZ=America/Los_Angeles` 下 80 项通过，本轮没有把这次重复算入总数。

## 浏览器验证

实际 Chromium 加载真实 `MetaGridTable` 与工具栏，使用 12 行合成数据和内存提交器。逐次检查 8 个提交：

1. 两个数字种子向下生成等差序列。
2. 真实剪贴板复制一列，再粘贴到相邻列。
3. 严格日期种子向下生成逐日序列。
4. 两行同时向左复制。
5. 两行分别向右生成序列。
6. 2×2 源矩形向下重复。
7. 2×2 源矩形向上重复，并检查目标记录版本。
8. 真实剪贴板复制 2×2，粘贴到单格并扩展为 2×2。

所有提交与剪贴板内容符合预期，无浏览器运行时错误；截图已人工检查。[截图](../../artifacts/range-fill/grid-range-fill.png)。这不是生产路由，也不是已认证后端或 staging 持久化测试。

## 复现命令

本轮使用 Node 20.20.2、Vitest 1.6.1、Vite 7.3.7。以下直接使用已有依赖，避免包管理器在运行检查之前自动重新安装。

在 `apps/web`：

```sh
node node_modules/vitest/vitest.mjs run tests/multitable-range-fill-flag.spec.ts tests/multitable-range-fill-planner.spec.ts tests/multitable-range-fill-writer.spec.ts tests/multitable-range-fill-interaction.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node node_modules/vitest/vitest.mjs run tests/multitable-grid.spec.ts tests/multitable-grid-bulk-edit.spec.ts tests/multitable-grid-cell-edit-commit.spec.ts tests/multitable-grid-cell-edit-commit-round2.spec.ts tests/meta-grid-table-virtualization.spec.ts tests/meta-grid-table-editable-types.spec.ts tests/multitable-grid-grouped-link-chip.spec.ts tests/multitable-workbench.spec.ts tests/run-required-web-tests-shape.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node --max-old-space-size=4096 node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p tsconfig.app.json
node --max-old-space-size=4096 node_modules/vite/bin/vite.js build
```

在 `packages/core-backend`：

```sh
node node_modules/vitest/vitest.mjs run tests/unit/record-write-service.test.ts tests/unit/required-web-lane-registration-shape.test.ts tests/unit/required-web-lane-token-manifest-guard.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

在仓库根目录：

```sh
node --test scripts/ops/global-history-flag-manifest.test.mjs
git diff --check
```

浏览器复现需要两个终端，均位于 `apps/web`：

```sh
# 终端 1：仅对本地合成夹具开启功能
VITE_MULTITABLE_RANGE_FILL_ENABLED=true node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18919 --strictPort
# 终端 2
node scripts/verify-range-fill-browser.mjs
```

夹具：`tests/fixtures/range-fill-browser-demo.html`。输出：仓库根目录 `artifacts/range-fill/grid-range-fill.png`。本轮自建 Vite 进程已停止。

## 已认证 API 与真实 PostgreSQL 验收（后续目标）

新增 `packages/core-backend/tests/integration/multitable-range-fill-realdb.test.ts`，提交 `8bbe8d3c5d`。主任务独立运行 Sol 6.1 编写的规格；没有改动生产鉴权、路由或数据库写入实现。

环境为 Node 20.20.2、PostgreSQL 15.17 和临时本地数据库；角色、用户、表和记录均为合成数据。使用现有迁移运行器成功应用 **426 项迁移**，完全沿用 `plugin-tests.yml` 的六项排除：`008_plugin_infrastructure.sql`、`048_create_event_bus_tables.sql`、`049_create_bpmn_workflow_tables.sql`、`042a_core_model_views.sql`、`20250924140000_create_gantt_tables.ts`、`20250925_create_view_tables.sql`。没有新建或修改迁移，没有访问业务数据库。

测试在导入鉴权模块前关闭 `RBAC_BYPASS`、`RBAC_TOKEN_TRUST`，设置生产模式以禁用开发用户回退。每次运行生成临时签名密钥，真实用户记录包含明确的读写权限；请求经过 `jwtAuthMiddleware`、真实 `univerMetaRouter`、`RecordWriteService` 和 SQL。没有注入 `req.user`、mock SQL 或替换服务。前端纯规划器直接生成真实原子 patch 请求；Vue 写入投影仍由前文的组件及 writer 规格单独覆盖。

| 验证项 | 断言 / 结果 |
| --- | --- |
| 6 格矩形粘贴 | 持久化全部值、dateTime UTC 规范化；每条记录只加一个版本；记录、修改者和历史 patch/snapshot 精确匹配 |
| 数值 / 日期序列 | 闰日正确，源记录版本和值不变；目标经真实读取接口返回 |
| 复制 | 类型化源值持久化，源记录版本不变 |
| 统一历史批次 | 各记录 revision 共享响应 batchId；历史批次读取包含两条目标记录 |
| 过期版本 | 第二条记录冲突返回 409；第一条及全部历史与调用前完全一致 |
| 用户字段只读 | 受限用户返回 403 且全批无变化；同请求由另一非管理员正常写入 |
| 只读用户 / 非法 select | 分别返回 403 / 400；非法末尾字段使整批值、版本及历史不变 |
| 缺失 token / 错误签名 | 均返回 401，SQL 快照不变 |
| 数据库缺失哨兵 | 分别仅设置 `EXPECT_DB=1`、仅设置真实 CI 标记 `METASHEET_REAL_DB_TEST_STEP=1`，缺少 `DATABASE_URL` 均为 1 失败 / 9 跳过，进程非零；跳过项不算通过 |
| 无数据库通道正对照 | 默认配置同时指定新文件及既有 writer 单测，仅收集后者，52/52 通过；不计入新增测试数 |

最终整组结果：**新规格 10/10（含数据库哨兵），邻接 `multitable-fieldperm-write-gate-patch-realdb` 4/4、`multitable-patch-batchid-echo-realdb` 3/3，总计 17/17**。与之前 561 项证据分开记录，没有把复跑或子代理检查重复计数。

鉴权变异：仅将隔离工作区 `AuthService.verifyToken` 内的签名验证暂时改为解码，执行错误签名这一条测试，得到 **1 失败 / 9 未选中**（预期 401，实际 200）。立即按原文恢复，确认该源码没有 Git 差异；恢复后上述三份文件 **17/17**。这证明该负例能识别签名验证缺失。

CI 接线仅向现有迁移后 `multitable-real-db-integration` 命令增加一份整文件参数，并在默认无数据库 `vitest.config.ts` 中排除；保留现有 `DATABASE_URL` 哨兵和 `METASHEET_REAL_DB_TEST_STEP='1'`。语义比较确认其余 workflow 完全不变。当前 provenance manifest 不再固定该 workflow，因此无需改动无关 pin。

复现时先按上述现有 CI 排除清单迁移一个可丢弃的合成数据库，再在 `packages/core-backend` 执行（`DATABASE_URL` 由环境提供）：

```sh
METASHEET_REAL_DB_TEST_STEP=1 node node_modules/vitest/vitest.mjs --config vitest.integration.config.ts run tests/integration/multitable-range-fill-realdb.test.ts tests/integration/multitable-fieldperm-write-gate-patch-realdb.test.ts tests/integration/multitable-patch-batchid-echo-realdb.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

迁移、变异、负对照及最终执行日志位于忽略目录 `artifacts/range-fill-realdb/`；本地运行配置不提交。该证据覆盖内嵌 Express HTTP 请求及真实 PostgreSQL 持久化，不代表浏览器到已部署服务的完整链路、staging 或生产验收。

## 工具链与远端 CI 限制

- 应用 `tsconfig.app.json` 类型检查退出 0；Vite 打包退出 0。同步 main 后两项再次通过，打包包含 3,824 模块，仍有现有大 chunk 提示。
- 运行 `pnpm validate:all` 时，本机 pnpm 入口先触发依赖自动安装，随后以 `ERR_PNPM_IGNORED_BUILDS` 退出，尚未完成插件/lint/全量类型检查链。自动产生的 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 改动已恢复；未批准新的依赖构建脚本，本 PR 不含依赖变更。不能将该聚合命令标为通过。
- 前轮已复现组合 `vue-tsc -b` 的基线 `vite.config.ts:28 TS2769`（链接依赖中 Vite 7 / Vitest Vite 5 类型冲突）。相关配置、包清单和锁文件相对基线无改动；本轮没有重新运行该组合命令，也不宣称完整 package build 通过。
- 四个功能规格均进入 `multitable-web-guard.yml` 的实际运行命令和 required web 清单；PR/push 路径触发也已接线。此前提交曾遗漏 token manifest / 排序，引起 8 项断言失败，已在 `5638709d...` 修正；本轮独立重跑相关 63 项守卫通过。
- 复核前提交 `5638709d...` 的 [Web Tests](https://github.com/zensgit/metasheet2/actions/runs/37811013438) 和 [Plugin System Tests](https://github.com/zensgit/metasheet2/actions/runs/37811013393) 曾在执行前受到账号支付/额度注释阻断，不能作为成功证据。后续 `fa99d5189f46060ab23df247737150fe79baa04f` 的 [Web Tests](https://github.com/zensgit/metasheet2/actions/runs/37892483400) 与 [Multitable Web Guard](https://github.com/zensgit/metasheet2/actions/runs/37892483464) 已成功；[Plugin System Tests](https://github.com/zensgit/metasheet2/actions/runs/37892483436) 在文档提交前仍运行，已进入审批真实数据库步骤。该快照为 22 个成功检查、1 个跳过、1 个运行中。新增真实后端规格不在该旧提交中，必须观察新提交对应的 CI，不能用旧结果代替。

## 模型实际产出与发布边界

Sol 6.1 完成本轮写入审查、修复和回归测试，以及后续真实后端规格；Luna 6 产出开发说明初稿。Grok 4.7 调用被每周额度限制阻断，无代码或测试产出；Kimi K3 咨询 180 秒超时，没有最终复核交付。本轮不将这两次尝试计为完成审查。Codex 主任务接手规划器复核，核对后端契约，独立执行上述检查、守卫变异与八步浏览器验证；后续独立执行真实迁移、17 项数据库测试和鉴权变异，并完成最终文档。

PR 保持 Draft / 默认 OFF。未合入 main，未部署或启用 staging/生产，未处理真实客户数据或外部系统写回；仅在合成临时数据库执行现有迁移。真实已认证 API / PostgreSQL 验收已通过；当前提交的 required CI、浏览器直连已认证后端及上线验收仍是后续发布门。
