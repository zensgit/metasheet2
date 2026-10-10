# 场景 B 页面验收——阶段总览 / 批次详情读路径（W7-A3）设计

日期：2026-09-20
分支：`test/scenario-b-stage-overview-acceptance-v2`
范围：只加测试（`apps/web/tests/StockPreparationScenarioBAcceptance.spec.ts`）+ 两处测试登记；零 `src` 改动。

## 背景

W7 备料接管窗口把场景 B（合成 BOM）拆成三刀：

- W7-A1（#5876）：源侧读取/清洗，未合并。
- W7-A2（#5877）：源运行结果落备料 staging，落库形状实证——1 个快照批次、54 行快照行、两层父子
  6（level 1，子装配）/ 48（level 2，零件），`incomplete=false`。未合并。
- W7-A3（本刀）：把 A2 实证的落点形状，接到**已存在于 main 的两个只读页面**上做验收——不新增功能，
  只验证既有 GET 契约在这个形状下的渲染路径。

侦察结论：A3 对 A1/A2 无代码依赖（两者均是"只加测试，零 src 改动"），所以直接基于 `origin/main` 开
分支，不叠加在 A1/A2 分支之上。

## 覆盖的两层页面

1. **阶段总览** `StockPreparationDashboardView.vue`（内嵌 `StockPreparationStageStepper.vue`）——
   数据来自 `listStockPreparationSnapshotBatches` (`GET /api/integration/stock-preparation/
   snapshot-batches`) 与另外四个阶段汇总读（mapping / unit / prepLine / exceptions）。
2. **批次详情** `StockPreparationSnapshotDiffView.vue`——同一个 `snapshot-batches` 读 + `/diff` +
   `/diff/rows`。

两者都已有各自的 spec（`StockPreparationDashboardView.spec.ts` / `StockPreparationStageOverview.
spec.ts` / `StockPreparationStageStepper.spec.ts` / `StockPreparationSnapshotDiffView.spec.ts`），
本刀新增的 spec 照抄它们的 mock 与挂载方式（`vi.hoisted` 持有 mock 函数、`createApp` 直接挂载、
`flushUi` 轮询 microtask + `nextTick`），只是把断言重新组织成"场景 B 一个批次从上到下怎么显示"这一
条验收主线，而不是逐个状态分支的穷举。

## "54 行" 落在哪两个真实存在的渲染面上

前端 `StockPreparationSnapshotBatchSummary` 类型（`bomSnapshotDiff.ts`）不携带 `bomLevel` 字段——
两层父子结构是后端 staging 表（`plm_stock_preparation_bom_snapshot_line`）的内部形态，值面上只暴露
`lineCount`（批次里的行数）、`incomplete`（完整性布尔）等 values-free 字段。既有两个页面都不做"按
level 分层渲染"这件事，所以本刀**不假造**一个不存在的 UI 分层断言，而是把"54"落在两处已经存在、
已经在渲染这类计数的地方：

- **总览**：`StockPreparationStageStepper` 的 `sync` 阶段计数 = `data.batchCount`（这批次数，场景 B
  = 1，对应"该批次"）；`generate` 阶段计数 = `listStockPreparationPrepLines().rowCount`（从这批 54
  行快照行派生出的备料行数，本刀 mock 为 54，对应"该批次的行数"）。这两个字段都是 main 上早已存在的
  渲染面（`StockPreparationDashboardView.vue:369` / `:386`），本刀只是给它们喂场景 B 的合成数字。
- **详情**：`StockPreparationSnapshotDiffView` 的 diff 行明细表格（`stock-prep-snapshot-diff-row`）
  渲染 `listStockPreparationSnapshotDiffRows()` 返回的 54 条合成 diff 行——每行只携带契约允许的
  `diffId`（`stockprep_diff_<16位hex>` 形状）/ `diffType` 枚举 / `reviewStatus` 枚举 /
  `keyFingerprint`（`sha16:<16位hex>` 形状），不含任何业务字段值。

这一处理方式的代价（残余，见验证文档"未覆盖"一节）：两层父子（6/48）本身不在前端可验证的渲染面
上，这支 spec 无法、也不应该断言它。

## 五条断言

1. ① 总览渲染出该批次（`sync` 计数=1）与行数（`generate` 计数=54）。
2. ② 详情视图渲染 54 行（先选中批次展开 diff 汇总，再展开逐行明细，断言 `stock-prep-snapshot-
   diff-row` 数组长度=54，且 meta 行文案含"54"）。
3. ③ 空态：0 批次时，总览的 `sync` 计数=0，详情视图渲染 `stock-prep-snapshot-empty` 且不发 diff GET。
4. ④ 错误态：`snapshot-batches` GET 5xx 时，两个视图都渲染各自的中性错误态（`stock-prep-dashboard-
   error` / `stock-prep-snapshot-error`），且 DOM 里绝不出现原始错误体（连接串/密码样式字符串）。
5. ⑤ values-free：两个视图渲染出的完整 DOM 文本里，既不出现 `http://`/`https://` 主机字符串，也不
   匹配连接串样式的 `key=value;...pwd=`/`password=`/`secret=` 模式。

## 变异自证

把合成行数从 54 改成 53（`SCENARIO_B_LINE_COUNT`），① 与 ② 两条断言按预期转红（`共 53` 不含
`54`、`差异行: 53 · 待处理: 0` 不含 `54`），改回后重新验证全绿。

## 两点登记

按仓库记忆"并发加 spec 必撞同两行"的教训，把新 token `StockPreparationScenarioBAcceptance` 分别追加
到：

- `apps/web/scripts/run-required-web-tests.sh`（保留原有 main 行内容，仅在最后一个 `exec npx vitest
  run ...` 命令的既有 token 列表末尾、`--reporter=dot` 之前追加，并补一段说明性注释，含子串碰撞
  检查结论）。
- `scripts/ops/integration-guard-run-web-specs.sh`（同样只追加末尾 token，补说明性注释）。

两处都未删除或重排任何既有 token，冲突面最小。

## 残余 / 未覆盖（诚实记录）

- 两层父子（6/48）结构在前端契约里不存在对应字段，因此这支 spec 无法在 UI 层验证它——只能验证
  "54 行总数"这个可观察的渲染结果。如果未来要在页面上验收"分层"本身，需要先在后端契约或专用只读
  端点里把 `bomLevel`/父子关系暴露出来，这是一个新的功能面，不在本刀范围内。
- 本刀不依赖、也不验证 A1（#5876）/A2（#5877）的落库写路径本身是否合入 main；只要两个既有 GET
  契约（`snapshot-batches` / `.../diff` / `.../diff/rows`）的响应形状不变，这支 spec 就与它们的
  合并状态无关。
- 本机 Windows + Git Bash 环境下，`apps/web/scripts/run-required-web-tests.sh` 的完整跑批被两个与
  本刀无关的既有问题挡住：① 脚本用 `set -euo pipefail`，前面某个批次（`attendance-date-only-
  format-tz-probe.spec.ts`，已知的本机时区探针假红）失败会导致脚本在到达本刀新增的最后一批之前就
  退出；② 把该最后一批的完整 `npx vitest run <300+ tokens>` 命令行单独 `eval` 时，命令行长度
  （11355 字节）超过 Windows `cmd.exe` 的 8191 字节上限，报 "The command line is too long"（这是
  Windows 本地环境的限制，CI 跑在 Ubuntu 上没有这个上限，且这条巨长命令行本来就已经在本刀之前存在，
  不是本刀引入的回归）。因此"两个登记脚本本身确认能找到新 spec"这一验收项，本机只能验证到"新 token
  被正确追加、且与既有 token 无子串碰撞"，未能在本机把完整登记命令行跑到底；这条命令行本身
  （去掉本刀新增的一个 token）在 Windows 本机也早已无法通过 `eval` 直接执行。已单独隔离运行本刀新增
  的 spec 文件本身，5/5 绿，且变异自证有效。
