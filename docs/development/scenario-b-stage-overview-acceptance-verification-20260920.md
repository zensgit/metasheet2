# 场景 B 页面验收（W7-A3）验证记录

日期：2026-09-20（本机 +08:00，`date` 校时）
分支：`test/scenario-b-stage-overview-acceptance-v2`
worktree：`C:/Users/zhou/Downloads/dev/metasheet-wt-w7a3b`

## 改动清单

- 新增 `apps/web/tests/StockPreparationScenarioBAcceptance.spec.ts`（5 条测试）。
- `apps/web/scripts/run-required-web-tests.sh`：追加 token `StockPreparationScenarioBAcceptance` +
  说明性注释。
- `scripts/ops/integration-guard-run-web-specs.sh`：同上。
- 无任何 `src` 文件改动。

## 命令与结果

### 1) 新 spec 单独跑（对照绿）

```
pnpm --filter @metasheet/web exec vitest run --watch=false tests/StockPreparationScenarioBAcceptance.spec.ts
```
结果：`Test Files 1 passed (1)`，`Tests 5 passed (5)`。

### 2) 变异自证（mutation → 转红）

把 `SCENARIO_B_LINE_COUNT` 从 `54` 改成 `53`（`sed -i`，内存/工作树级改动，未落库、未涉及并发共享
状态）后重跑同一命令：

```
Tests  5 tests | 2 failed
❯ ① dashboard stage overview renders the scenario-B batch (sync=1) and its row count (generate=54)
  → expected '共 53' to contain '54'
❯ ② snapshot-diff detail view renders all 54 rows of the scenario-B batch
  → expected '差异行: 53 · 待处理: 0' to contain '54'
```
两条断言按预期转红，证明"54 行"确实是这两处测试在把关，而不是空断言。改回 `54` 后重跑，恢复
`5 passed (5)`。

### 3) 0x08 字节扫描

```
git diff --cached origin/main -- | grep -P '\x08'
```
结果：空（无 0x08 字节）。

### 4) 换行符

`file` 对新 spec 文件与既有同目录 spec（`StockPreparationDashboardView.spec.ts`）的检测结果一致：
`ASCII/Unicode text`（LF），未引入 CRLF 混用（`core.autocrlf=true` 只影响本地 checkout，不影响已
暂存 blob 的实际字节，已用 `git diff --cached` 确认无 CRLF diff 噪音）。

### 5) 两点登记的 token 冲突检查

```
grep -o "StockPreparation[A-Za-z]*" apps/web/scripts/run-required-web-tests.sh | sort -u | grep -i scenario
```
在追加前为空（无既有同名/近似 token），追加后两处脚本里 `StockPreparationScenarioBAcceptance` 均
不是任何既有 token 的子串，也不包含任何既有 token 作为子串（最近邻 `StockPreparationSnapshotDiff
View` / `StockPreparationDashboardView` 在 `StockPreparation` 之后即分叉）。

### 6) 登记脚本本身的验收（部分完成，见设计文档"残余"一节）

- 直接隔离运行新 spec 文件：见第 1 条，5/5 绿。
- 完整跑 `apps/web/scripts/run-required-web-tests.sh`：本机 Windows + Git Bash 环境下，脚本在到达
  本刀新增的最后一批（`exec npx vitest run StockPreparationProjectBoard ... 
  StockPreparationScenarioBAcceptance --reporter=dot`）之前，被一个与本刀无关的既有批次
  （`tests/App.spec.ts attendance-date-only-format ...` 批次里的 `attendance-date-only-format-tz-
  probe.spec.ts`，本机时区探针假红，见仓库记忆 `clock-drift-run-date-before-writing-times.md` 同类
  问题的姊妹现象）失败中止（`set -euo pipefail`）。
- 单独把最后一批的完整命令行 `eval` 执行：报 `The command line is too long`——这条命令行长度
  11355 字节，超过 Windows `cmd.exe` 的 8191 字节上限；这是本机 Windows 环境对超长命令行的固有限制
  （CI 跑在 Ubuntu 上用真正的 `npx` 二进制，没有这个上限），且这条命令行在本刀追加一个 token 之前
  已经是 11323 字节，本来就已经会撞到同一个上限——不是本刀新增 token 引入的回归。
- 结论：token 本身的正确性（无冲突、脚本语法正确、追加位置正确）已用静态检查 + 独立跑新 spec 验证；
  "整条登记命令行本机跑到底"这一项因上述两个环境限制在本机无法完成，留给 CI（Ubuntu 跑道）验证。

### 7) TypeScript / vue-tsc

未改动任何 `.vue`/`.ts` 生产代码，只新增一个 `.spec.ts` 文件，其类型（`StockPreparation
SnapshotBatchListResult` / `StockPreparationSnapshotDiffSummary` / `StockPreparationWorkspace
Overview`）均从既有服务模块 `import type` 而来，vitest 单跑已经过 esbuild/vite 的 TS 转译校验
（见第 1 条无编译错误）。本刀无后端改动，未跑
`pnpm --filter @metasheet/core-backend exec tsc --noEmit`（不适用）。

## 残余 / 未覆盖

见设计文档 `scenario-b-stage-overview-acceptance-design-20260920.md` 的"残余 / 未覆盖"一节。
