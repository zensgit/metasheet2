# 考勤 QA 问题修复验证 — 2026-10-10

本文件的本轮状态冻结于提交、推送之前；新 head 的远端 CI 实跑结果由 PR 描述及后续收尾回执单独记录，保留此处的失败与待验事实。

## 当前结论

2026-10-10 已获得公开 Draft PR 与 CI 持续运行的明确授权；[Draft PR #6300](https://github.com/zensgit/metasheet2/pull/6300) 已发布。首轮远端 CI 在两个源域清单登记处失败，登记已补齐、定向回归通过。上一轮 head `58d52892b80d5083ecafa15f9dcefe14990ebd04`、基线 `00caf5f639050700cb4590448d9261f0fef2b101` 的 13 项 required checks 全绿；本轮已正常合并新固定 main `d6638148a528a7451fc9d4e8da8b7c13836c6941`。纯合并树 `e10d52fc2b39ed55f399c2de60c596e65d75e762` 的定向本地门通过；Node 20 完整 checkpoint 在本机文件系统上 FAIL，新 PR head 尚未 commit/push。此前各轮授权与验证仍按其冻结状态记录。PR Ready/合并、部署与真实数据操作继续 HOLD。

冻结的本地验收回执记录了本切片若干代码修复与合成验证；它明确没有声称 20 项 QA 问题全部修复。上一轮对齐固定 main `00caf5f639` 的回执与本轮新 main 树分开：纯合并树的定向本地门已通过，但 Node 20 完整 checkpoint 在本机文件系统上 FAIL；需在新 head 的 Linux CI 原生支持文件系统上完成全量 checkpoint。新 PR head 尚未 commit/push，对应远端 CI 尚未运行。当前证据及待完成项见下文“新 main 收尾状态”。

本轮独立审阅发现并修复一个 P2：跨午夜的旧刷新，以及审批后迟到的历史请求，均可能覆盖新一天的本人签到状态。两个入口已补齐开始时刻/最终规则时区保护；反例在修复前失败、修复后通过，完整前端回归与 Astra 最终复核通过。原 QA 环境、真实历史与性能仍未验证；上一轮固定基线的远端 required checks 已通过，新 main 树上的远端 CI 尚未验证，不能声称附件 20 项全部解决。

首轮回执：[`verification.json`](../../artifacts/attendance-qa-fix-20261009/verification.json)，基线 `a16a12aca35d46b6b621ae12f49b380b50b95b48`，首轮修复 `62d6801c5f`。实现分支 `codex/attendance-qa-completion-20261009`，早期正常合并提交 `c9674c0ab3`，竞态修复提交 `0841cf65ab740b9191ecfcc5cd8f12f87871ebb0`，代码树 `e37e1d079ffb790460930051f50ed2d8ee6f2f98`。该批合并检查见 [`merge-alignment-results.json`](../../artifacts/attendance-qa-goal-20261010/merge-alignment-results.json)，对应回执见 [`final-verification.json`](../../artifacts/attendance-qa-goal-20261010/final-verification.json)。各批证据保留自己的冻结代码身份；当前代码见下一节。


## 新 main 收尾状态

固定 main `d6638148a528a7451fc9d4e8da8b7c13836c6941` 已常规 `--no-ff --no-commit` 合并，无冲突；以下本地门证据只针对纯合并源码树 `e10d52fc2b39ed55f399c2de60c596e65d75e762`，其中包含 #6266 task M4 迁移/Vitest/flags、#6298 admin-directory 和 #6299 AttendanceView 样式。Node 20.20.2 / pnpm 10.33.0 下 frozen-lockfile force restore 已完成；workspace 与 lockfile 字节均与 index 一致，没有依赖变更。早先 Node 24 / pnpm 12 shim 意外触发依赖安装并中断，恢复后的文件与 index 一致；这次失败日志保留在 ignored artifacts，不计作通过。

纯合并树上的前端聚焦回归整跑 6 个文件、304 通过、0 失败/跳过；后端聚焦回归整跑 7 个文件、370 通过、0 失败/跳过；四个 ops 文件共 238 通过、0 失败/跳过。`validate:all` exit 0，含 13 个 plugin manifest、9 个既有 warning、lint 与完整 Web/Backend 类型链；Vite build exit 0，仍有 large-chunk warning。隔离 PostgreSQL 验证完成 436 项 migration、replay 0、M4 migration 确认；strict self-service fixture PASS；attendance order 7、swap 12、M4 schema 59 项均通过，数据库及服务清理 PASS。独立 backend-drain 验证 3/3 通过，三个 timer 用例耗时 1575/500/10060 ms，隔离资源清理 PASS。Provenance candidate tree verified，包含 63 个 pinned file digest。Astra 对该纯 merge tree 的独立只读审阅结论为无新增可操作发现。

Node 20 完整 checkpoint 在本机 exit 1：相邻 real-DB 文件 47 项中 46 通过、1 失败，错误为 `RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED`；runner 确认其自有数据库、连接和合成 cluster 均已清理。Astra/root 实测本机 APFS filesystem type 26；现有 file-store 与 custody-store 的 Darwin allowlist 仅接受 type 25，源码与固定 main `d6638148a528a7451fc9d4e8da8b7c13836c6941` 一致，设置 canonical `TMPDIR` 也不能改变挂载类型。这是本机文件系统不满足既有 storage guard 的要求，不是本次考勤改动引入；该本地失败保留为 FAIL，不改记 PASS，也不通过改 guard 或 mock 绕过。

因此完整 checkpoint 状态为 **PENDING**：须在新 head 的 Linux CI、原生受支持文件系统上运行完整 checkpoint，并满足 exit 0、fourCLEAN 全部成立及 values-free scan 为 0。该 remote supported-filesystem gate 尚未运行；当前新 PR head 尚未 commit/push。前述定向前端、后端、ops、隔离 DB、drain、provenance 与 Astra review 门仍各自保持 PASS，但不代表完整本地 checkpoint 或最终文档/source tree 通过。可公开摘要见 [`verification.json`](../../artifacts/attendance-qa-closeout-20261010/verification.json)；完整本地日志保留在同目录的 ignored 文件中。

上一轮冻结身份仍有效但范围有限：head `58d52892b80d5083ecafa15f9dcefe14990ebd04` / tree `66cfcb232f9c0ed278580716e11920d2dfb3869d`，基线 `00caf5f639050700cb4590448d9261f0fef2b101`。该轮 13 项 required checks 全绿，整条 PR checks 为 55 项成功、1 项跳过；唯一跳过项是可选 Strict E2E check，不是失败日志输出步骤。FE 双点实跑 9/19/19/102 项、零跳过；Chromium 6 项挂载真实 AttendanceView，但 HTTP 仍为 mock。DB order 7 项及 ops 两文件 7 项全通过、零跳过。strict-RBAC 合成夹具结果为 `rbacBypass=false`、`tokenClaimsTrusted=false`、`adminReadDenied=true`，双次 seed、请假/加班/换班各提交并持久化核验 1 次后取消，取消共 3 次。以上均是上一轮冻结结果，不能替代新树本地复验或 CI。

本地 ops 批次 14 项的组成是 history 4 + import 3 + 既有 advanced-import/strict/OpenAPI 7；上一轮 CI 中两个独立 ops 文件为 history 4 + import 3，共 7 项。两种统计范围不同，不应混称为同一批次。原始 20 项矩阵继续保留每项 `original_qa_acceptance: not_run`；本地与 CI 合成证据不等于原 QA 环境闭环。

## 首轮远端 CI 与源域清单登记

head `63f14abd7f1cf2f9930f7f870eb2682bfc2a13b5` 的 [Node 20 作业](https://github.com/zensgit/metasheet2/actions/runs/38020430064/job/114120065008)在主测试步骤有 3 个失败断言：W7 派生域缺少新增顺序 helper 的分类，Intl 站点清单缺少历史诊断的无小时年月日 formatter（29 个实际站点、28 个登记）。该步另有 18480 项通过、1722 项跳过；后续新增数据库守卫及合成夹具步骤因此跳过，不能作为远端通过证据。

修复已将 helper 加入 calculation 集合，继续接受 W6 模块引用与 HTTP 路由消费两项禁令；Intl 清单按现有 date-only 规则登记 `localDay`，不授予 `allowsHourOption`。扫描域、覆盖等式、禁令和正控制保留。Node 20 上三个完整守卫 spec 共 39 项通过（W7 preservation 13、Intl 16、W6 import graph 10），历史运维契约另 4 项通过，均无失败或跳过。Sol 完成两处最窄登记修复及回归，Astra 独立审阅实际 diff 通过；两个生产文件字节未变。新提交将重新运行最终 head 的 required CI。

同 head 的 attendance-web-guard 与 web-tests 已实际执行 today/prefill/timeline/dashboard 整文件 9/19/19/102 项，均无失败或跳过；考勤门禁另执行既有 Chromium 补卡浏览器 6 项，不能与本地 mock 的 8 项混计。这些首轮结果保留该 head 身份，后续验收以新 head 的新作业为准。

## #6296 对齐后的当前代码

正常合并固定 main `00caf5f639050700cb4590448d9261f0fef2b101`（#6296），合并提交 `703c3c233e54a0100222581c1e0d07c2d1bf04fe`，树 `70addd34eaaf28a21f7ee10e4ecc776f9dc3da31`；无冲突、无手工源码解冲突、未 rebase 或强推。考勤 View/dashboard/today/prefill、attendance-web-guard、web-tests、plugin-tests、token manifest、backend Vitest 和 integration test chain 保持原哈希；required-web 脚本仅注释变化，运行 token 仍为 559，三项新增前端 spec 的双点接线保留。

在上述树上 Node 20 / pnpm 10.33 新跑两个受影响审批 spec **20 通过、0 失败/跳过**（return candidates 11、can-decide 9），完整 Web 类型脚本、provenance 与 **3 项审批 CI 接线契约**通过。守卫首次调用因 PATH 先匹配 Corepack pnpm 而报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`；改为优先现有 pnpm 10.33 后通过，未改 package/lockfile。Playwright `--list` 收集 **9 文件、60 项**，其中 return-candidates 6 项；这是收集证明，未执行浏览器用例。未改动的考勤、backend/数据库及此前浏览器结果保留原冻结身份，未重复执行。

证据：[`approval-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/approval-main-alignment.json)。日志为 `approval-main-affected-frontend.log`、`approval-main-web-typecheck.log`、`approval-main-ci-contract.log`、`approval-main-browser-list.log` 和 `approval-main-provenance.log`；首次环境失败留在 `approval-main-ci-contract-initial.log`。公开 Draft PR 已发布，最终 head 远端 CI 正在推进；PR 合并、部署、真实历史操作及原 QA/性能验收保持各自授权边界。

## #6285 考勤代码对齐

本地正常合并固定 main 快照 `e0205875d7e523466f68f2ecb0ecd19c25b9cbbf`，合并提交 `895acd06b7678d7d2add1eac4f183318eee28591`，树 `177793708e5b8fbdf724b767db97f36cb4f46da0`；无冲突、无手工源码解冲突、未 rebase 或强推。

#6285 修改员工/管理页面样式，并将日历覆盖配置移到节假日页面，故完整 View 哈希已变化。Sol 比对确认 11 个关键保护函数/监听器、today/prefill 两个纯 helper 与 dashboard 整文件保持不变，测试链并集无丢项。Astra 独立核对实际 staged blobs/tree：员工模板保留，四申请卡行为代码不变，未发现新的兼容性缺陷；该结论不等于独立执行本轮测试。

在上述树上使用 Node 20 新跑 5 文件 **287 通过、0 失败/跳过**（admin 145、dashboard 102、presentation 21、task home 10、today helper 9）；完整 web 类型脚本通过，包含 app、approval verification 和 stock-prep verification。既有本地合成 Chromium 8 项桌面/手机用例、Vite 构建与 provenance 通过；构建保留原有 large-chunk 提示。未改动的 backend/数据库/ops 套件未重跑，继续保留原冻结身份；本轮浏览器 8 项不包括 #6285 新增的 admin 浏览器用例。

证据：[`attendance-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/attendance-main-alignment.json)、[`attendance-main-adversarial-review.json`](../../artifacts/attendance-qa-goal-20261010/attendance-main-adversarial-review.json)。本地日志为 `attendance-main-affected-frontend.log`、`attendance-main-web-typecheck.log`、`attendance-main-browser.log`、`attendance-main-web-build.log` 和 `attendance-main-provenance.log`。公开 Draft PR/远端 CI 仍待批准，PR 合并、部署与真实历史操作保持 HOLD。

## 目标恢复后的 20c705 main 对齐

当次目标状态已恢复为 `active`。当次正常合并快照为 `20c705add7c86fdabb486e834735f9a1913e6de2`，合并提交 `7eff381b9b37df0bff684be8045d13246a504713`，树 `6d440078048cf68e1a87807d7065458f44577904`；无冲突，未 rebase、未强推。

这次 main 新增 #6294 的审批 return-candidates 浏览器验证与 #6248 的 task design-lock 修订；考勤 View/dashboard 源码哈希仍与已审阅代码相同，考勤 CI/manifest/test-chain 路径无改动或丢项。Node 20 上新跑审批 verification 类型检查与 provenance 均通过，审批浏览器 CI 接线契约 **3 通过、0 失败/跳过**。Playwright `--list` 收集到 **9 文件、64 项测试**，其中新增 return-candidates 10 项；这只是收集证明，未执行这些浏览器用例。未改动的考勤和数据库套件未重复执行，继续保留各自原冻结身份。

证据：[`resumed-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/resumed-main-alignment.json)。目标恢复不等于公开发布授权：公开 Draft PR 与远端 CI 仍待批准，PR 合并、部署及真实历史操作保持 HOLD。

## continue 后的 0f17 main 对齐

此前正常合并快照为 `0f17cf6085c0c6e52a73a847e41e7f3525936120`（#6293，审批 DTO/服务与 OpenAPI）。合并提交 `c8f0a2e228729d9df6a4702dfb4b187a2b02f611`，树 `27a360c496f35d72e9244ac4d17db490945b82f4`；无冲突，未 rebase、未强推。下文 `548c1d5834` 的记录保留为更早的冻结证据。

考勤 View/dashboard 源码哈希与已独立审阅的修复相同，CI/manifest/test-chain 路径无改动或丢项。本轮在合并后的树上新跑 dashboard 102 + today helper 9，共 **111 通过、0 跳过**；provenance、完整 `validate:all` 与 Vite 构建通过。构建仍有原有 large-chunk 提示，plugin manifest 仍有 9 个既有警告。

证据：[`continuation-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/continuation-main-alignment.json)。日志为 `continuation-dashboard-today-helper.log`、`continuation-provenance.log`、`continuation-validate-all.log` 和 `continuation-web-build.log`。此前 UTC 292、洛杉矶 149、浏览器 8、数据库 19 等结果保留其原冻结代码身份，本轮不将未重跑的批次伪称为本轮执行。

公开 Draft PR 授权仍待对“continue”发布范围的明确答复；远端 CI 尚未运行，原 QA 范围与真实历史/性能验收仍未获得。PR 合并、部署继续 HOLD。

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

## 0841 代码上的复跑

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
| 本地运维契约批次 | 14 通过，0 失败：历史 4、导入范围 3、既有 advanced-import/strict/OpenAPI 7 | `ops-node-contracts-final.log`；本地批次，不等于远端新增作业 |
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

Draft PR #6300 已发布。上一轮 head 的 13 项 required checks 全绿；新 main 纯合并树的定向本地门已通过，但 Node 20 完整 checkpoint 在本机 filesystem gate FAIL；须由新 head 的 Linux CI 在原生受支持文件系统完成 exit 0、fourCLEAN 与 values-free scan 0。该 gate PENDING，新 PR head 尚未 commit/push，fresh required CI 尚未运行。原 QA 环境构建/组织/用户/日期范围识别、历史调查、延迟测量和业务验收仍未完成。2026-10-10 的 Draft/CI 授权见当前结论；Ready/合并、部署与真实历史仍保持 HOLD。未获得真实历史范围时，不使用附件凭证代替授权。

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
