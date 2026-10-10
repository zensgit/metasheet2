# 考勤 QA 问题修复验证 — 2026-10-10

## 当前结论

冻结的本地验收回执记录了本切片若干代码修复与合成验证；它明确没有声称 20 项 QA 问题全部修复。本轮另已将 `main` `548c1d5834` 常规合并进实现分支，合并无冲突；测试链两边合并后无丢项，runner 使用 hosted literal；本地 merge/CI 守卫与 provenance 检查均有结果，详见下文。

本轮独立审阅发现并修复一个 P2：跨午夜的旧刷新，以及审批后迟到的历史请求，均可能覆盖新一天的本人签到状态。两个入口已补齐开始时刻/最终规则时区保护；反例在修复前失败、修复后通过，完整前端回归与 Astra 最终复核通过。原 QA 环境、真实历史、性能与远端 CI 尚未验证，不能声称附件 20 项全部解决。

首轮回执：[`verification.json`](../../artifacts/attendance-qa-fix-20261009/verification.json)，基线 `a16a12aca35d46b6b621ae12f49b380b50b95b48`，首轮修复 `62d6801c5f`。实现分支 `codex/attendance-qa-completion-20261009`，正常合并提交 `c9674c0ab3`，竞态修复提交 `0841cf65ab740b9191ecfcc5cd8f12f87871ebb0`，代码树 `e37e1d079ffb790460930051f50ed2d8ee6f2f98`。本轮合并检查见 [`merge-alignment-results.json`](../../artifacts/attendance-qa-goal-20261010/merge-alignment-results.json)，最终回执见 [`final-verification.json`](../../artifacts/attendance-qa-goal-20261010/final-verification.json)。本文件后续提交仅承载文档/计数回执，代码身份以上述提交和源文件哈希为准。

## 本轮 merge 与守卫证据

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| main 合并 | `548c1d5834` 常规合并，无冲突 | `c9674c0ab3`；未 rebase、未强推 |
| 测试链对齐 | 两边合并，0 项丢失 | 测试链 union 对比通过；不代表远端 CI 已运行 |
| Runner | hosted literal 检查通过 | 检查 runner 配置字面值，不代表 runner 作业远端已执行 |
| CI guard | 267/267 通过 | 本地 guard 检查结果 |
| Unit guard | 63/63 通过 | 本地 unit guard 检查结果 |
| Token/gating 清单 | 559 tokens 与 20 gating 一致 | 一致性检查；不代表原 QA 接受 |
| Provenance | PASS | 来源 `artifacts/attendance-qa-goal-20261010/merge-alignment-results.json`；不证明部署或发布 |

## 最终代码上的复跑

以下为 main 合并与两个竞态入口修复后的新运行，使用 Node 20.20.2；各批次有重叠，不相加。

| 检查 | 结果 | 本轮日志 |
| --- | --- | --- |
| UTC 聚焦前端 | 14 文件，292 通过，0 失败/跳过 | `frontend-final-utc.log` |
| 洛杉矶时区前端与午夜邻居 | 4 文件，149 通过，0 失败/跳过 | `frontend-final-la.log` |
| Chromium 桌面/手机 | 8 通过，0 失败 | `browser-final.log`；1440px / 390px，mock harness，仅本地 |
| Web 项目类型检查 | `vue-tsc -b --force` 通过 | `web-typecheck-final.log` |
| Backend 类型检查 | `tsc --noEmit` 通过 | `backend-typecheck-final.log` |
| 仓库 `validate:all` | 通过；13 个 plugin manifest 有效，9 个既有警告；lint 与项目/verification 类型链通过 | `validate-all-final.log` |
| Web Vite 构建 | 通过 | `web-build-final.log`；仍有原有 large-chunk 提示 |
| 顺序守卫与换班 DB 邻居 | 2 文件，19 通过，0 失败 | `backend-db-final.log`，隔离合成 PostgreSQL 15 |
| 严格 RBAC 夹具 | 两次种子、三类申请各 1 次提交/持久化核对/取消；管理员读取 403 | `selfservice-fixture-final.log` |
| 迁移重放 | 435 已应用，0 待执行 | `migration-count-final.txt` / `migration-replay-final.log` |

日志保存在本地 `artifacts/attendance-qa-goal-20261010/`；可公开的代码身份、计数和审阅结论已另存入该目录的 JSON 回执。先前已迁移空库的 435 项证明见首轮回执；本轮重放没有新增 migration。

## 冻结回执中的本地验证

以下证据来自本地或隔离的合成检查。各套件覆盖范围有重叠，分别报告，不相加为虚构的唯一总数。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 前端聚焦批次 | 290 通过，0 失败，14 个文件 | `frontend-final-complete.log`；UTC |
| 前端时区邻近用例 | 47 通过，0 失败，3 个文件 | `frontend-final-la.log`；`America/Los_Angeles` |
| 本地浏览器冒烟 | 8 通过，0 失败 | Chromium，1440px 与 390px；仅本地 mock UI harness，不是 CI 或原 QA 环境 |
| 前后端类型检查与前端构建 | 通过 | `web-typecheck.log`、`backend-typecheck.log`、`web-vite-build.log`；现存 large-chunk 提示不能证明性能验收 |
| 实时打卡顺序数据库测试 | 7 通过，0 失败 | 隔离、完整迁移的 PostgreSQL 15 合成库；`backend-order-integration.log` |
| 顺序计算器/合并策略单元测试 | 3 个文件，91 通过，0 失败 | `backend-order-unit.log` |
| Canonical/authoritative 邻近契约 | 2 个文件，30 通过，0 失败 | `backend-order-boundary-neighbors.log` |
| 顺序保护 mutation | 守卫被中和时 3 个匹配案例按预期失败；4 个不匹配案例跳过；恢复守卫后数据库测试 7 项通过 | `backend-order-mutation.log`；守卫文件字节已恢复 |
| 换班 API 邻近测试 | 12 通过，0 失败 | `neighbor-swap-api.log` |
| 选定的打卡 API 邻近测试 | 4 通过、162 跳过、0 失败 | `neighbor-punch-api.log`；仅选定测试 |
| Strict-RBAC self-service 夹具 | 幂等种子运行 2 次；1 个请假类型、1 条加班规则、2 条已发布手工换班排班；请假/加班/换班均已提交、持久化、核对并取消；管理员读取返回 403 | 仅一次性合成数据库；`selfservice-fixture.log`；无 RBAC bypass，不信任 token claims |
| 运维范围/历史契约 | 14 通过，0 失败 | `ops-node-contracts-final.log` |
| CI wiring 契约 | 264 通过，0 失败 | `ci-wiring-final.log`；本地源码契约，不等于远端执行 |
| 夹具 runner 契约 | 198 通过，0 失败 | `fixture-runner-contracts.log` |
| 合成历史 adverse checks | 4 通过，0 失败 | `backend-review-history-final.log` |
| 合成 PostgreSQL 历史证明 | 2 项 microsecond 比较；foreign scope 为空 | `history-realdb-proof.log`；未查询原始历史 |
| Migration replay | 435 项已应用；待 replay 为 0；未新增 schema change | `migrate-replay.log` 和 `verification.json` |

运维套件覆盖有重叠，以上计数不合并求和。

本地浏览器截图位于 [`today-desktop.png`](../../artifacts/attendance-qa-fix-20261009/screenshots/today-desktop.png) 与 [`today-mobile.png`](../../artifacts/attendance-qa-fix-20261009/screenshots/today-mobile.png)。

## 跨午夜覆盖新读取竞态 — 已修复并验证

Astra 在冻结代码 `62d6801c5f` 的独立临时副本复现：新一天的本人查询已显示“已签到”，旧刷新结束后变成“尚未签到”。只修 `refreshAll` 仍不足，Overview 的 focused request「批准」会经过 `resolveRequest → loadRecords` 触发同一竞态。

验证过程分别保留两个失败反例；其中审批入口在仅修 `refreshAll` 时仍为 1 失败/3 通过。两个入口均修复后，4 个午夜用例通过；dashboard 整文件 102 项加 today helper 9 项共 111 通过、0 跳过。Astra 将临时副本恢复为旧代码后反例再次失败，这是反证控制，并非最终修复回退。root 在最终源码上另跑上述 UTC 292、洛杉矶 149、浏览器 8 和类型/构建验证，全部通过。Astra 最终只读复核实际两文件及哈希，未发现新的可操作问题。

证据：[`midnight-history-race/results.json`](../../artifacts/attendance-qa-goal-20261010/midnight-history-race/results.json)、[`astra-review.json`](../../artifacts/attendance-qa-goal-20261010/astra-review.json)。

## 20 项 QA 逐项状态

冻结回执的每项都标为 `original_qa_acceptance: not_run`。下表中的“本地已验证”仅表示代码或合成证据，不表示已部署或修复历史数据。

| # | 项目 | 冻结回执中的状态 | 未完成事项 |
| ---: | --- | --- | --- |
| 1 | 时区显示 | 既有修复，本地验证通过 | 核对原环境时区显示与部署构建身份。 |
| 2 | 跨工作日打卡配对 | 合成数据库验证通过 | 未查询/修复原用户日期记录；未改变显式客户端时区优先级。 |
| 3 | 打卡顺序颠倒 | 新写入守卫，本地验证通过 | 既有颠倒记录未改；需单独核对原报告记录。 |
| 4 | 配对后工时为零 | 需按策略评估 | 核实原规则、舍入方式与持久化配对后再判断是否缺陷。 |
| 5 | 迟到/早退数值极大 | 尚未确认为缺陷 | 核实预期策略和原记录；未做指标批量改写。 |
| 6 | 历史时间戳漂移或极性变化 | 已加只读诊断，历史未核验 | 未读取或改写原历史；有界调查仍需另行授权。 |
| 7 | 成功上班打卡在报表缺失 | 已加只读诊断，历史未核验 | 缺失事件/记录未恢复，也未证明存在。 |
| 8 | 完成配对在 UI 显示为上班中 | 代码与合成验证通过 | 需在原部署构建复核；未处理历史持久化极性。 |
| 9 | 历史行影响今日状态 | 修复并本地验证通过；跨午夜两个入口也已闭环 | 原环境部署和用户验收待进行。 |
| 10 | 打卡/报表延迟 | UI 部分修复；性能未验证 | 未测原环境延迟、负载或服务级目标。 |
| 11 | `rules/me` 拒绝 override headers | 既有修复，本地验证通过 | 需核验原部署和真实 session 规则可用性。 |
| 12 | 无可选请假类型 | 合成夹具流程验证通过 | 未在原 QA 夹具/账户验证；政策和余额审批另计。 |
| 13 | 无可选加班规则 | 合成夹具流程验证通过 | 原 QA 配置、部署和加班验收待完成。 |
| 14 | 无可用换班排班 | 合成夹具流程验证通过 | 原 QA 配置与参与者换班验收未验证。 |
| 15 | 有派生行但详情无原始打卡事件 | 导航/预填已修，历史未核验 | 未重建历史事件；原环境接口可用性与事件关联未验证。 |
| 16 | 字段配置 degraded | 单凭 degraded 状态不能判为缺陷 | 原 metadata backing 可用性及修复未确认。 |
| 17 | 顶栏身份截断/共享浏览器账户 | 既有身份逻辑本地验证 | 共享浏览器与原多设备视觉验收未执行。 |
| 18 | 年假/调休余额为零 | 尚未确认为缺陷 | 核实原账户授权/余额政策；夹具未改余额。 |
| 19 | 活跃/撤销 session 数量 | 尚未确认为缺陷 | 原共享 session 或设备状态验收未执行。 |
| 20 | 旧 records 路由空白 | 既有重定向，本地验证通过 | 需在可确认构建身份的原部署验证路由。 |

逐项详情和源代码路径以回执为准。表格保留代码修复、夹具修复、策略/配置判断与真实历史未验证之间的区别。

## 本轮模型与审阅状态

| 模型/参与者 | 本轮实际范围 | 状态 |
| --- | --- | --- |
| Sol 6.1，复杂度中等 | 实现整合、main merge、CI/测试链检查、两处竞态最窄修复与回归 | 完成；实际模型 `gpt-6.1-sol` |
| Astra，复杂度高 | 时区/事务反证审阅、两入口复现、最终源码复核 | 发现并闭环 1 个 P2；实际模型 `gpt-6-astra` |
| Luna，复杂度低 | 本两份 Markdown 文档整理 | 文档完成；未参与代码验收 |
| Kimi K3 | 已核实 `kimi-code/k3`，调用只读历史脚本 advisory | 180 秒超时，无最终结论；不计入通过证据，由 Astra 承接复杂审查 |
| Grok 4.7 | 预检未认证 | 未参与实现或审阅结论，不记为已使用 |

## 交付与外部验收状态

冻结回执记载当时为 `DRAFT_HOLD`、无已发布 PR、远端 CI 未运行、未合并、未部署、生产未变化、真实历史未修复。上述为冻结回执状态；本轮 main merge 状态已在前文单列。本轮 CI guard、unit guard 与 wiring 检查是本地证据，不能替代最终提交上的远端 required CI。

尚未完成：公开仓库的 Draft PR 发布授权及最终 head 上的 fresh required CI；原 QA 环境构建/组织/用户/日期范围识别、历史调查、延迟测量和业务验收。公开发布遵循仓库 AGENTS.md 的 owner「先批后动」要求，保持 HOLD。未获得真实历史范围时，不使用附件凭证代替授权。

## 重现命令

以下在已安装依赖、Node 20 的仓库根目录执行。数据库测试需先准备隔离的合成数据库并完成 migrate，不能指向生产。

```sh
pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts tests/attendanceTodayWorkbench.spec.ts tests/attendanceRecordRequestPrefill.spec.ts tests/attendance-record-timeline.spec.ts --maxWorkers=1 --minWorkers=1
TZ=America/Los_Angeles pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts tests/attendanceTodayWorkbench.spec.ts tests/attendanceRecordRequestPrefill.spec.ts tests/attendance-record-timeline.spec.ts --maxWorkers=1 --minWorkers=1
node --test scripts/ops/attendance-import-scope.test.mjs scripts/ops/attendance-history-reconcile.test.mjs
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-live-punch-order.db.test.ts tests/integration/attendance-shift-swap.test.ts --maxWorkers=1 --minWorkers=1
pnpm validate:all
```

浏览器的额外两条 today 冒烟使用本地忽略的 QA harness；不声称已进入 CI。新增/新增必需的三个 frontend spec 已在 attendance-web-guard 与 required-web 两点接线，DB 守卫和合成夹具接入 plugin-tests。

本记录所列证据没有读取或改动生产/客户数据，也没有使用 QA 压缩包中的凭证。文档仅记录不含业务值的计数、代码和仓库相对证据路径。
