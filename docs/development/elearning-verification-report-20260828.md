# MetaSheet 云课堂集成验证报告（2026-08-29）

> 结论：PASS FOR LOCAL DRAFT/HOLD INTEGRATION CANDIDATE
>
> 非结论：不是 merge、Ready、flag、deploy、production 或 L0–L6 全部完成证明。
>
> 被测代码 checkpoint：15dccfbbecc79b90fc9dc4437f382377d936f71e
>（tree 4692dc234e6fe47bc32757b78ec9335e8ecb5c7e）。
> 报告提交只增加本文与开发报告，不改变被测代码树。

## 1. Exact-head 与 ancestry

| 检查 | 结果 |
|---|---|
| landing branch | codex/elearning-landing-candidate-20260829 |
| current-main base | c479e9b321fe772149e367b5d90cb01c21654766 |
| governance head | cba0d93957b0df34a8dac9a61bfd958c1fcf95d1 |
| authority head | 20ec53f9f15a6eec6376fdf5dd40247ae1552d48 |
| code head/tree | 15dccfbbec... / 4692dc234e... |
| 三个 ancestor 检查 | PASS |
| git diff --check | PASS |
| tracked dirty set before reports | empty |

## 2. 当前树测试

### 2.1 后端 unit

命令按磁盘枚举 61 个 tests/unit/elearning-*.test.ts，作为 whole-file 参数运行。

- Test files：61/61 PASS
- Tests：589/589 PASS
- 动态 CI wiring：15/15 PASS
- selector census：61 files，missing=0

其中 C replay 新增的 category/content/course/document/open-completion 12 个文件已进入 plugin-tests.yml canary。

### 2.2 Web

云课堂六文件直接门：

- Test files：6/6 PASS
- Tests：160/160 PASS
- 学员限时考试文件：61/61 PASS

全 required-web exact-tree 门：

- Test files：406/406 PASS
- Tests：5150/5150 PASS
- 云课堂六文件在该门中再次执行并通过 160/160

Web selector census：

- 磁盘 e-learning specs：6
- elearning-web-guard.yml missing：0
- run-required-web-tests.sh missing：0

### 2.3 Plugin

- plugins/plugin-elearning/__tests__/*.test.cjs
- Test files：10/10 PASS
- Tests：10/10 PASS
- test-chain-completeness：0 intentional exclusions

### 2.4 Type、lint 与 API

| 门 | 结果 |
|---|---|
| core-backend tsc --noEmit | PASS |
| web vue-tsc -b + verification config | PASS |
| core e-learning source ESLint（package config） | PASS |
| timed learner Web source/spec ESLint | PASS |
| OpenAPI generate + codegen guard | PASS |
| sealed-export provenance | 1/1 PASS |

第一次从仓库根直接执行后端 ESLint 时，parser 错绑根 tsconfig，文件在解析前失败；改用 packages/core-backend/.eslintrc.json 所在 workspace 后完成有效 lint。该环境姿态失败不计为代码测试失败。

OpenAPI 第一次运行因隔离 worktree 缺 dist-sdk/node_modules/openapi-typescript 而在 SDK 生成前中止；复用同仓已安装依赖后，完整 generate + guard PASS，生成物无 tracked drift。

## 3. Fresh PostgreSQL

隔离数据库创建前确认不存在，使用本机 PostgreSQL 127.0.0.1:5432。

步骤：

1. 从空库执行完整 db:migrate；
2. 第二次执行 db:migrate，确认无新增迁移；
3. 运行磁盘全部 28 个 elearning-*.db.test.ts；
4. DROP 隔离库；
5. 查询同前缀数据库残留。

结果：

- Fresh full migration：PASS
- Migration replay：PASS
- Test files：28/28 PASS
- Tests：256/256 PASS
- credit authority scratch drain：CLEAN
- residual backends：0
- database prefix residue：0

本次 real-DB 集合包含 schema、watch、publish、exam、scope、assignment、training plan、jobs、assessment、manual grading、notification、media 与 credit authority。

## 4. 累积判别证据

以下是最终候选继承且已在对应 exact checkpoint 复核过的判别门；本节不把历史 checkpoint 冒充本次重跑。

### 4.1 Manual grading

- 4 个 whole-file canary / 32 tests；
- 相同 payload 重试复用 request id；
- 修改 score/comment 后生成新 id；
- 移除 409 reconciliation guard 时对应测试精确变红；
- detail 或 queue 任一刷新失败都不允许显示成功。

### 4.2 Credit authority

- credit policy/ledger/postgres unit：27/27；
- authority real-DB：4/4；
- 删除全局 effect unique：migration/drift 门变红；
- 删除 conflict 后 exact request-hash：异 payload 并发不再 conflict，门变红；
- 删除 daily bucket FOR UPDATE：同日不同 effect 结果变为重复发放，门变红；
- 恢复后全部通过。

### 4.3 B-AWARD

- scoped unit：22/22；
- 只有 graded + passed 触发 pass_exam；
- submit、expiry、manual-grade 三条终态复用同一 attempt effect identity；
- incentive flag 关闭时不触发 credit authority；
- credit authority 失败保持评分事务 fail-closed。

### 4.4 Publish readiness/lifecycle

- C2-R1：移除 readiness authority 调用，publish test 精确变红；
- C2-R2：移除 lifecycle transition guard，publish test 精确变红；
- draft/final pointer compare-and-set 0 行均返回 values-free unavailable；
- 本次最终树 61-file unit 和 28-file real-DB 已覆盖恢复态。

## 5. Selector-union 证明

| 集合 | 数量 | missing |
|---|---:|---:|
| e-learning backend unit | 61 | 0 |
| e-learning real-DB | 28 | 0 |
| e-learning Web guard | 6 | 0 |
| e-learning required Web | 6 | 0 |
| plugin tests | 10 | 0 |

plugin-tests.yml 与 vitest.config.ts 保留 current-main、Time Machine 和既有云课堂路径；shared CI 改动是 superset，不删除已有 selector。provenance pin 已在最终 workflow 内容上重新生成并通过 fail-closed 测试。

## 6. Refute-first 结论

### P1

0 个未关闭 P1。

本轮发现并关闭：

1. publish readiness 的 measurementAuthority 保持 unknown，使 core typecheck 失败；
2. C 新增 12 个 unit 文件没有进入 whole-file canary；
3. shared workflow 变化后 sealed-export provenance pin 漂移；
4. media S3 iterator 的 while (true) 违反现有 lint gate。

### P2

0 个当前候选阻断 P2。

### P3 / 明确边界

1. 当前只实现 pass_exam 自动学分 consumer；完整 L4 rules/wallet/adjust/title/cert 未完成；
2. C1/C2 的 document/article/external-link 与 stats 缺 production SoR→API→UI；
3. L5/L6 仍主要是输入 policy，不是用户可达闭环；
4. 旧 PR supersede 尚未执行，需 replacement Draft exact ancestry 后再处理；
5. 未执行真实浏览器 UAT、部署或 production acceptance。

## 7. 发布状态

| 动作 | 状态 |
|---|---|
| local integration candidate | 完成 |
| local exact-tree gates | 完成 |
| push / replacement Draft PR | 未授权、未执行 |
| Ready / merge | 未授权、未执行 |
| feature flags | 全部保持默认 OFF |
| deploy / dispatch | 未授权、未执行 |
| production / real tenant data | 未触及 |

本地候选可进入独立审阅与后续 Draft/HOLD 落地窗口；不能据此宣称云课堂 L0–L6 已完成。

---

## 8. 2026-09-05 successor verification：在线报名与 raster-v2

> 本节验证 `#5426` code head `408e61411688bfd8f994f5e50998e2566b78ef4f`
>（base `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`，tree
> `7591090a91e6f28fc9de54bf54970513e53880c2`）。上文 `15dccf...` 的历史证据不变。

### 8.1 Code-head 远端终态

- GitHub exact-head matrix：**49 SUCCESS + 1 expected SKIP / 0 pending / 0 bad**，共 50 contexts。
- `elearning-web-guard`：run `33942439293` / job `101242333446`，SUCCESS。
- `migration-replay`：run `33942439257` / job `101242333468`，SUCCESS。
- `web-tests`：run `33942439249` / job `101242333247`，SUCCESS。
- Plugin System `test (18.x)`：run `33942439382` / job `101242334219`，SUCCESS。
- Plugin System `test (20.x)`：run `33942439382` / job `101242334275`，SUCCESS（完成时间 `2026-09-05T04:14:29Z`）。

这是 code head 的终态。追加本节产生的提交是 report-only child，须单独等待其 exact-head CI；
二者不能互相替代。

### 8.2 本地 exact-tree 门

| 验证面 | 结果 |
|---|---:|
| backend focused | 9 files / 85 tests PASS |
| Web focused + 主线邻接 | 4 files / 154 tests PASS |
| required-web | 422 files / 5461 tests PASS |
| OpenAPI focused | 17/17 PASS；canonical build、validate、guard PASS |
| e-learning wiring + global flag contract | 45/45 PASS |
| core/Web typecheck、package-scoped source ESLint | PASS |
| positive provenance + full sealed-export S5 | PASS；frozen/live differenceCount=0 |

### 8.3 PostgreSQL 与判别 mutation

PostgreSQL 15 实际执行对象是 `7e28ff30a449484522e536c319a1b7071a4eb749`：完整 fresh
migration、第二次 replay 与 watch-challenge authority **13/13 PASS**，结束时 residual
backends `0`、数据库前缀残留 `0`。`7e28ff...` 到 `408e...` 只合入主线四个备料/required-web
文件；backend runtime、watch migration 与 integration test 字节一致。因此这里引用的是
`7e28ff...` 的真库执行证据及其对 `408e...` 的字节等价证明，不冒称在 `408e...` 上重新跑库。

- mutation：重新向公开响应加入 `targets` 时 backend closed-shape contract 精确 RED；恢复后 GREEN。
- mutation：DOM 重新暴露 option UUID 时 learner-view 精确 RED；恢复后 GREEN。
- 独立 Sol 对 raster fix exact range 复审：`P1/P2/P3 = 0/0/0`。
- 合并后独立 Terra 对 `408e...` 复审：`P1/P2/P3 = 0/0/0`。

### 8.4 视觉证据与诚实边界

本地 ignored artifact 目录 `artifacts/elearning-watch-challenge-raster/` 包含：

- `sample-a.png`、`sample-b.png`：两份不同选项排列的真实 renderer 输出；
- `overlay-desktop.png`、`overlay-narrow.png`：桌面与窄屏叠层截图。

人工检查确认 PNG 可见、六个点击矩形与图像选项对齐，窄屏无溢出。artifact 不进入发布包，
截图也不替代服务端 authority 测试。该机制只消除公开结构化“目标 → 答案 id”连接；OCR、
视觉 AI 与非视觉等价挑战仍是明确边界。

### 8.5 发布状态

`#5426` 的 code head 验证通过不等于 Ready、merge、启旗或部署。PR 继续 Draft/HOLD；所有
相关 flags 保持默认 OFF，未触及 staging、production 或真实租户数据。
