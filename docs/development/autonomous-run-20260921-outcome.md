# 第八窗口 24 小时无人值守（2026-09-20/21）开发与验证总结

来源：`autonomous-24h-program-20260909.md` 账本「## 第八窗口」段（2026-09-20 起至文件末尾）。本文只转述该段落已记录的事实；账本未写明的细节一律标注「未记录」，不做推断或补全。凡引用 git 提交历史核对合并提交 sha / PR 号之处均已标注为「经 git log 核对」，与账本原文分开呈现。

**状态：窗口内快照稿，非终稿。** 本文档在窗口正式收尾时刻（本地 09-21 18:21 CST）之前完稿——账本截至本次定稿时最后一条记录为 09-21 08:2xZ（16:2x CST）。协调方已提前派发本文档写手，「占位后回填」；窗口收尾后仍在途的项（合并 sha、CI 结果、是否合并）需由后续一轮回填更新，本文档中相应位置标 `<待填>`。撰写过程中曾遇到一次出网中断（09-21 07:40Z–08:21Z，约 41 分钟，见第 1、5 节），中断期间已暂停并如实报告，网络恢复（探针 200 + 用户确认）后续跑完成分支创建、提交与本 PR。

**订正说明（2026-09-25 补记）**：owner 于 09-21 对本文档做了独立复审，裁决「不按收工销项」，并指出若干过度表述。以下各处已在原位订正（凡标「**订正**」的句子即为改写处）：场景 B 的签收口径、#5917 material 维度演练缺口、#5951 的冲突治理范围、#5903 脱敏覆盖面、#5923 并发边界、停摆与工时的来源性质。复审项 F1–F5 / N1–N3 的后续处置见第 8 节。

---

## 1. 窗口事实

**授权原话（09-20 10:21 本地）**："接下去的24小时我不在电脑前，你能根据当前代码进行计划安排么？实现无人值守开发，并根据代码难度来选择合适的模型，完成后给出开发及验证日志，另外若5h额度满后能自动定时开启继续开发"。

**owner 三裁决（AskUserQuestion）**：
- ①**合并策略 = 自动合 T 层无 DDL**——条件全满才合：严格门（`merge-gate.sh`：MERGEABLE + 0 红 + 0 pending + `--match-head-commit`）+ 保证型必过反驳 0 blocker + 不含迁移/DDL + 不碰 `.github/` + 不读真实客户数据；含 DDL / O 层一律留 OPEN；每次合并记账，owner 24h 内可回退。
- ②**优先线 = 备料接管残余 + 开发吞吐基础**（两条）。
- ③**禁区** = 按章程四类 O 层 + 不动同伴会话 metasheet-57 的工作树/PR（`wt-delfb`/`tpl5861`/`ss5828`/`ai5838`/`ai5842`/`b1-5839`；其 PR #5873/#5891/#5892/#5893）+ 不上 222。

**心跳机制**：CronCreate 每小时心跳（`:17`）按墙钟点火，429/断网时该小时只记一行不派活，限额一恢复即从账本续；每次心跳无论有无变化必须先追加一行「心跳到达」（防止静默死亡与"没事干"混淆）。模型按难度：easy=sonnet / medium=opus / hard=fable；保证型（权限/租户/写路径/迁移）跟 refuter + fix。出网前缀固定为本机代理端口；`gh` 合并用 zensgit 账号，合后切回 skiyakubali0-cloud。磁盘 <6G 先回收（`scratchpad/resume/reclaim-merged-worktrees.sh`，只删 MERGED 且不在同伴清单）。窗口截止后：只观察不派新活，出最终 docs 总结 PR（即本文档）。

**开工时状态**：main 在 `1a6663a41`（接管日 17 支已合）；在飞：第三批加固 `wf_482517f1-2b7`（H1 脱敏 / H2 bulk FK 409 / H3 #5678 表+securitySchemes / H4 runs list 契约 / H5 VALIDATE 脚本包）；候选校准 `wf_4cd04958-35c`（10 路只读，C1–C10）。

**两次停摆**（**订正**：本节停摆时段、时长与下文「有效工时」均出自协调方自己的账本，属协调方自述，本文档未做独立核实，不作为已证事实引用）：
1. **09-20 20:5x CST 起，整机 Claude 进程停摆约 13h**。账本记录：12:52Z（20:52 CST）后无记录，至 09-21 02:02Z（10:02 CST）心跳到达才恢复，条目写明「会话曾重启，wave2/wave3b 工作流被停」；同伴第九窗口会话（`933c938a`）也同样停在 12:42Z。账本未给出这段停摆的具体根因（未记录）。
2. **09-21 11:17–14:17 CST，四次预定心跳（cron `:17`）未见处理痕迹**。账本原文：「03–06Z 四次心跳未见处理痕迹＝会话曾停摆」，恢复点为 06:43Z（14:43 CST）心跳到达、06:45Z（14:45 CST）处理。此次停摆窗口内，`fix:Q1b` 的修复尝试疑因 502 失败过两次（账本 07:40Z 记录：「fix:Q1b 第 3 次尝试在跑（前两次疑因 502 失败）」）。

**另有一次短暂出网中断（09-21 07:40Z–08:21Z，约 41 分钟）**：07:40Z 心跳记录「出网再断（reclaude/GitHub 探针均 000）」，磁盘同时降到 11G 触发 worktree 回收；期间本文档写手因 `git fetch` 三种代理配置均 TLS 握手失败，按边界暂停并落盘草稿（账本 07:58Z 记录）；Q4c PR-2 本地完成（`0000df0cc`）但因出网断未推未开 PR（账本 08:07Z 记录）。08:21Z 探针转 200、出网恢复，PR-2 随即推送并开出 **#5952**，本文档写手同时续跑。

**有效工时（推算，非账本直接给出的汇总数；订正：推算所用的停摆时长是协调方自述，推算结果同样只是协调方自述口径）**：窗口设计时长 24h（09-20 18:21 CST → 09-21 18:21 CST）。两段停摆（约 13h + 约 3h）与一次短暂出网中断（约 41 分钟）合计约 16h41m，若按满 24h 窗口折算，理论有效工作时间约 7h19m。本文档最终定稿时窗口尚未正式收尾（账本最后引用记录截至 09-21 09:13Z/17:13 CST），故上述折算值是对「假设窗口按计划跑满」的估计，不代表窗口已经结束；窗口真正收尾后的产出与工时以协调方回填为准。

**自动合入累计（本次回填时点）**：按账本 08:23Z「累计 16 支」→ 08:39Z「累计 17 支」→ 09:13Z #5950 合并后的顺次推算，累计 **18 支**：#5902 #5904 #5905 #5906 #5914 #5916 #5920 #5922 #5917 #5903 #5931 #5932 #5923 #5925 #5949 #5951 #5665 #5950。09:13Z main 已推进到 `c919db1c4`。

---

## 2. 候选校准（10 路只读侦察关键纠正，`wf_4cd04958-35c`，1.34M tokens）

账本 09-20 10:4x 记录，10/10 全部返回：

- **C3 前提不成立**：`079`/`062` 两处存的是 `external_system_id`/`system_id`，不是 `dataSourceId`；设计文档 `:99` 写错了 → 改做「外部系统删除的二阶指针计数」（对应本窗口 Q2/#5923）。
- **C4 插件半边已由 #5420（merge=union）根治**，只剩 web 侧 `run-required-web-tests.sh:1211` 单行 396 token 未解（对应本窗口 Q8/#5951）。**订正**：「根治」是侦察返回的原话，本文档不背书；web 侧 #5951 的效果只限于消除巨型单行热点，不代表合并时必然执行本地 union driver、从此不再冲突，见第 3 节 #5951 行与第 6 节。
- **C8 (b)(c)(d) 已被第六次 24h 窗口做掉，只剩 (a) 且处于休眠**（本窗口不做，见「不做」清单）。
- **C9 钉钉待办 B 方案已合**（#5772，`0e769bc88`），但 222 上开关处于 OFF，此前的记忆记录已过时（本窗口 Q9/#5920 只补登记 flag 与注释，不涉及功能上线）。
- **C1 真阻塞是 #5665**（12 条写端点 `requireAdminRole` 门）已悬置 8 天，#5680 叠在它之上（对应本窗口 Q1b/Q1c）。
- **C5 ① 机制**：正则 `.` 不匹配 `\r`，导致 CRLF 检出下 `//` 注释未被正确剥离，影响 14 个 `ci-wiring` 守卫（对应本窗口 Q7a/#5916）。
- **C7 双轨对账在代码里零可执行面**，但「合成 v2 快照 → diff 引擎 → 页面」的零件齐全（对应本窗口 Q3a/Q3b/Q3c）。**订正**：Q3a/Q3b/Q3c 合入后，场景 B 只能签「合成数据 diff 引擎演练完成」；它不是客户历史迁移、双轨对账或接管路线第 3 步（历史迁移与双轨对账）的验收。真 PG + 真后端的场景 B 复演未跑（见第 6 节）。

---

## 3. 产出清单

范围：账本第八窗口段出现的全部 PR，共 21 支编号 PR（Q4c PR-2 在撰写期间已开出为 #5952）。

| PR 号 | 项（队列编号） | 模型 | 改了什么（一句） | 验证证据（变异 / 反驳 / CI） | 合并 sha 或状态 |
|---|---|---|---|---|---|
| #5902 | H4 | opus/sonnet（账本未按子项拆分具体模型） | 补 `GET /api/integration/runs` 列表契约（#5895 后续，docs） | CI 22/0（`f98e7538e`）；账本未记录独立反驳结论 | `779af1fc3` |
| #5903 | H1 | opus/sonnet | `admin-routes.ts` 本体 13 个读侧 GET 的 500 分支不再回显驱动错误文本（ADM-05 后续脱敏）。**订正**：覆盖面只到这 13 个 GET；挂在 `/api/admin` 下的子路由的原文回显是既存残余，不在本 PR 覆盖面内（见第 6 节） | 反驳 pass；首轮 CI 出现 1 项红（`test(20.x)` 的 `elearning-scope-access.db.test`，10,000 规则扫描 30s 超时，判定与本 PR 零交集→假红）；rerun attempt 2 = success，假红坐实 | `5edf4c3e1` |
| #5904 | H2 | opus/sonnet | 批量删改 `data_sources` 撞绑定 FK 时返回 409 引用拒绝，不再裸 500（#5896 后续） | 反驳 pass；CI 27/0（`13e6ef877`） | `70916cbc1` |
| #5905 | H3 | opus/sonnet | `admin-api.yaml` 补 `bearerAuth` securitySchemes 与 403 响应（ADM-05 后续，对应 #5678 盘点表） | CI 26/0（`3b14aecb3`）；账本未记录独立反驳结论 | `7aa1b3c84` |
| #5906 | H5 | opus/sonnet | `live_id` FK 存量悬空行盘点/清理/VALIDATE 脚本包（#5896 后续，写清理步骤交 owner 执行） | 反驳首轮 2 blocker（①并发重绑竞态无再校验 ②`marker=TRUE` 行后置状态陈述错）→ fix `e53b65145`（STEP1/2 加 `connection_id IS NOT DISTINCT FROM` 快照 target + `NOT EXISTS` live 再校验，STEP2b 记 `stale_skipped`；marker 分叉后置状态陈述改对）→ CI 21/0 | `36d659c8a` |
| #5914 | Q1a | opus（含 refuter） | `/slo/status` 与子路由 `/snapshots` 补 `requireAdminRole`——`/api/admin` 读侧无门 GET 归零，闭世界扫描改递归 | 反驳首轮 1 blocker（`snapshot-labels.ts:145` 子路由 GET 无门且闭世界扫描不递归）→ fix `263939430` 真收官（含 `/snapshots` 子路由加门 + 递归闭世界扫描）→ CI 26/0；残余跟进指针 #5918（账本未展开其内容） | `ce9ac29cb` |
| #5916 | Q7a | opus | `ci-wiring` 守卫 CRLF 归一解析 + python 解释器 ENOENT 回退（本机假红根治，CI 行为不变） | CI 20/0（非保证型，账本未记录独立反驳） | `4307bbff0` |
| #5917 | Q3a | opus | 场景 B 合成 v2 快照经 diff 引擎四类变更演练——`ROWS_V2` + `03-seed-v2.sql`（v1 字节未动），经引擎直调 + `/diff` + `/diff/rows` 读出同一分布（55 = changed 2/added 1/removed 1/unchanged 51） | 三内存级变异各红；CI 23/0 CLEAN；`test-chain` 插 `:64`；A3 spec 加用例 ⑥；合入时两条残余：changeCounts 词表落后引擎——由 #5932 补齐词表并改写断言；**订正**：material_changed 未演练——#5932 未改场景 B 夹具，Q3a 演练也没有增加 material 维度，该演练缺口保留（见第 6 节） | `f8168fa35` |
| #5920 | Q9 | sonnet | 登记 `DINGTALK_TODO_MIRROR_ENABLED`/`INTERVAL_MS` 两条 env flag 到 `global-history-flag-manifest` + grep 扩展 + `STATUSES` 加 denylist + 更正 `index.ts` 过期注释 | 两条变异各红，30/30 + 20/20；账本未记录独立反驳结论 | `b88e150f1` |
| #5922 | Q7b | sonnet | `dist-sdk` `build.mjs` 改用 `require.resolve` + `process.execPath` 调用 CLI（Windows ENOENT 根治，无 shell），产物逐字节不变 | 6/6 测试；账本未记录独立反驳结论 | `d7f98dc77` |
| #5923 | Q2 | opus（含 refuter） | 外部系统删除守卫计数 `079`/`062` 二阶引用（关闭悬空后数据源可删的二阶漏口），设计文档 `:99` 纠正为二阶指针计数 | 反驳首轮 blockers → fix `28ee9d04e` → 反驳 pass。**订正**：只封串行删除——计数与删除之间没有事务或行锁，并发 bind/delete 未封（见第 6 节） | `0e73ac2eb` |
| #5925 | Q4a | opus（含 refuter，保证型：新读路由租户域） | 新增 `GET /api/integration/runs/:runId/provenance` 子路由 + 工作台面板溯源区（#5895 后续），三键 WHERE `tenant_id`+`workspace_id`+`run_id` 按 `event_index` 排序 | 反驳 pass（06:45Z 记录，账本未展开 blocker 细节） | `96cd7b57c`（**注**：账本 06:48Z 原文写「#5925(Q4a) → 未合」，同一条紧接写「main checkout 96cd7b57c」；经本地 `git log` 核对，`96cd7b57c` 正是该 PR 的合并提交且已在本地 main 历史顶端。账本文字与 git 状态之间存在数分钟级未及更新的落差，此处以 git 核对结果为准并如实标注差异，供协调方复核） |
| #5926 | Q6 | sonnet | `ops-sql-pack-verify.yml` 独立泳道（hermetic + postgres:16 execution-proof，matrix 预留 H5） | 账本未展开独立验证细节（本地提交 `fdf97b066` → zensgit 推送开 PR） | **留 OPEN（触碰 `.github/`，策略明确排除自动合并，需 owner 审批）**（**后续**：owner 复审 F5 判当前版不放行，补丁后于 2026-09-24 合入 `fad4ccedf`，见第 8 节） |
| #5931 | Q3b | opus | 场景 B 一键复演脚本 `scripts/ops/scenario-b-replay.mjs`：11 级步骤梯逐步状态码判成败；沙箱门取自 `target-provisioning.cjs:99,103` + `preflight.cjs:299`（生产 Apply 姿态须 closed 且必须有正向沙箱标记）；永不设 autopersist / 不发 tenantId | 24 例 + 三内存级变异各红；真复演因本机无 PG 二进制未跑，改用真 socket + 桩后端层补证（残余：未跑过一次针对真实 PG 的复演）。**订正**：场景 B 只签「合成数据 diff 引擎演练完成」，见第 6 节；复审 F2–F4 由 #6041 修复，见第 8 节 | `1c856368e` |
| #5932 | Q3c | sonnet | 批次 diff 视图导出 values-free 对账摘要 CSV + `changeCounts` 词表补齐 `componentCodeChanged`/`materialChanged`（前后端），改写两处「已知缺口」断言为真值（**订正**：只收口 #5917/Q3a 的词表残余；场景 B 夹具与 Q3a 演练没有增加 material 维度，material_changed 演练缺口仍在） | 首次 CI `test(18.x)`+`test(20.x)` 双红，定位为真失败——新 spec `StockPreparationDiffSummaryExport.spec.ts` 未登记进 `apps/web/scripts/run-required-web-tests.sh`（代理自述两点登记未落实）→ 补登记后修复推送 `22285041e`，`enumeration` 4/4 绿；`vue-tsc -b` 绿，变异红 | `90d269a34` |
| #5933 | Q5 | fable（含 refuter，保证型） | sql-readonly legacy 行 `connection_id` 回填：设计 + census SQL + DML 迁移 + 文本断言 + 便携 PG 验证（S0–S3） | 反驳 1 blocker（05 普查未接盘点包契约守卫）→ fix `b591dd957` | **留 OPEN（含 DML 数据迁移，策略明确排除自动合并，需 owner 审批执行）**（**后续**：owner 复审 F1 判当前版不放行，不是只差授权；修复与独立对抗核验已完成，仍 OPEN 待 owner 授权，见第 8 节） |
| #5950 | Q4b | sonnet | 运行详情轮询：5s 轮询、到终态停止、面板关闭时清定时器 | 变异红；`run-required` 709/710，唯一红项为既有 flake（与本改动无交集）；首轮门拒（红）——账本 08:23Z 定位根因为 `tests/ui-foundation-style-guard.spec.ts`（UF-6：`<style>` 里不许 hex/rgb() 字面量）打在 `IntegrationMonitoringSection.vue`（本 PR 新加的自动刷新标签样式）→ 改成设计 token，修复 `1e204c554`（守卫 124/124 绿，`vue-tsc -b` 干净） | `c919db1c4`（**后续**：复审 N1/N2 由 #5959 修复，见第 8 节） |
| #5949 | Q4c（PR-1） | sonnet | `/api/integration/*` 读侧契约补齐（pipelines×2/external-systems×2/provenance/dead-letters 共六条） | `build`/`validate`/`generate:sdk`/`guard:codegen` 绿；账本 08:23Z 记录「已 MERGED」 | `74d9fa496` |
| #5952 | Q4c（PR-2） | sonnet | `/api/integration/*` 剩余读侧契约（stock-prep 读面）：snapshot-batches/diff/diff-rows 三契约 + 6 schema，`changeCounts` 10 键齐；实读发现三条路由是 `requireAccess('admin')`、`workspaceId` 查询参数是死参数 | `build`/`validate`/`generate:sdk`/`guard:codegen` 绿；账本 09:04Z 记录首轮门拒 CONFLICTING/DIRTY——基于 `96cd7b57c` 开分支，与之后合入的 #5949 同改 `packages/openapi/src/base.yml` 与 `dist`/`dist-sdk` 生成物 → merge origin/main + 重生成 dist 后复推，09:09Z 记录冲突已解、四条 openapi 脚本绿 | **OPEN，等 CI 过门**（账本最后记录 09:09Z：head `f431ab0f4`，MERGEABLE，排在 #5950 链之后等 CI；截至本次回填账本尚未出现其合并 sha）（**后续**：2026-09-21 09:57Z 合入 `aac8fd853`，经 `gh pr view` 核实） |
| #5951 | Q8 | opus（含 refuter，保证型） | `run-required-web-tests.sh` exec 行多行字母序 + `.gitattributes` union + 新守卫 `required-web-lane-registration-shape`（18 例）+ enumeration/G2 改续行解析 + token 集合 diff 脚本 | 反驳 pass（0 blocker / 5 non-blocker：无守卫断言每个 token 至少命中一个 spec；union 作用于整文件含 1250 行注释）；账本 08:23Z 记录「已 MERGED」。**订正**：效果只限于消除巨型单行热点（11KB 单物理行拆成一行一个 token 的字母序块）；`merge=union` 只在本地 git merge/rebase 读取 `.gitattributes` 时生效，GitHub 服务端合并是否执行它未实证（#5951 正文自述不作保证），不代表从此不再冲突；PR 标题里的「并发登记冲突根治」按此收窄 | `8d0aff7e9` |
| #5665 | Q1b | opus（含 refuter，保证型） | rebase 12 条写端点 `requireAdminRole` 门到 main（此前已悬置 9 天的既有 PR） | 反驳 1 blocker（bulk 路由加门打红 #5904 的 `admin-bulk-data-sources-fk-409.test`）→ 按 howToFix 补 rbac `vi.mock` 修好，fix `ec59754a1` CI 27/0 全绿，满足策略过门 | `309b551eb` |

---

## 4. 留 OPEN 待 owner

- **#5933（Q5，sql-readonly legacy 行 `connection_id` 回填）**：含 DML 数据迁移，按窗口合并策略「含 DDL/DML → 一律留 OPEN」明确排除自动合并；需 owner 审批后执行迁移。反驳已发现 1 blocker（05 普查未接盘点包契约守卫）并已修复（`b591dd957`），但迁移本身的执行权限仍在 owner。**订正**：owner 独立复审发现 F1（P1，并发覆盖：READ COMMITTED 下候选快照会把并发提交的合法重绑覆盖回旧源），当时版本不放行，不是「只差授权」；后续处置见第 8 节。
- **#5926（Q6，`ops-sql-pack-verify.yml` 独立泳道）**：改动落在 `.github/`，按窗口合并策略「不碰 `.github/` → 一律留 OPEN」明确排除自动合并；需 owner 审批。**订正**：owner 独立复审发现 F5（P2，触发 `paths` 漏了被测迁移文件），当时版本不放行；后续已补丁并合入，见第 8 节。

（**#5665** 不属于本节：它不含 DDL、不碰 `.github/`，先前的 OPEN 状态只是尚未过门，账本 08:39Z 记录已 **MERGED `309b551eb`**，见第 3 节产出表。）

---

## 5. 环境与流程教训

- **UTC/本地时间标注**：账本明确纠正——第八窗口段所有用 bash `date` 写的时间戳都是 UTC（Git Bash 时钟为 UTC），本地时间需 +8h；窗口实际对应本地时间为 09-20 18:21 → 09-21 18:21。本文档所有本地时间均已按此换算。
- **门链输出被 grep 过滤掉 try 行**：09-20 12:01 记录，#5914/#5916 首次「门未过」的原因是操作者把 `merge-gate` 输出用 `grep` 过滤掉了 `try` 行，看不到真实判定；教训写入账本：「调门时保留全部输出」。
- **`test(20.x)` 长杆 + 账号切换互斥**：账本记录 CI 长杆是 `test(20.x)`（每支 40+ 分钟），多支 PR 各剩它一项待收官；同一时段三条合并链只能串行等待，原因是「账号切换互斥」（`gh` 合并需切到 zensgit、合完切回）。
- **#5932 两点登记漏**：新 spec `StockPreparationDiffSummaryExport.spec.ts` 首次提交时未登记进 `apps/web/scripts/run-required-web-tests.sh`，导致 `stock-prep-web-ci-coverage-enumeration.test.ts` 的必跑覆盖断言在 CI 上真实失败（`test(18.x)`+`test(20.x)` 双红），而非泳道 flake；代理自述「两点登记未落实」，修复后补齐并复推。
- **CRLF 变异锚点**：候选校准 C5① 定位到根因是正则 `.` 不匹配 `\r`，导致 CRLF 检出下 `// ` 注释未被正确剥离，影响 14 个 `ci-wiring` 守卫；本窗口 Q7a/#5916 即为该根因的修复。
- **磁盘回收（junction 安全）**：09-21 07:40Z 磁盘降到 11G（<15G 阈值）触发回收已合并的 `w8*` worktree；09-21 07:51Z 回收结果「SUMMARY removed=13 skipped=1 failed=0 main=22/25/47/3 worktrees=61」，磁盘回升到 14G；下一条记录进一步回收 14 支已合并工作树（含 `w8l` 丢弃 dist-sdk CRLF 噪声后删），并核对「主检出四处 `node_modules` 计数不变」以确认回收未误伤主检出的 junction 链接。
- **reclaude 502 与出网中断**：09-21 07:40Z 心跳记录「出网再断（reclaude/GitHub 探针均 000）」，`fix:Q1b` 第 3 次尝试疑因前两次 502 失败而重试；此前 09-21 02:05Z 曾记录「隧道健康（reclaude/GitHub 探针 200，daemon.log 最近桶 22:30 CST 仅 8 次）」说明网络状态在窗口内多次波动，恢复与再断反复出现。
- **SilentCleanup**：账本第八窗口段未见该词的记录（未记录）；本节仅按上文「磁盘回收」一项呈现账本中实际记录的清理过程。

---

## 6. 残余与未覆盖

- **#5906（H5）**：脚本本身只做存量悬空行的盘点/清理准备/VALIDATE，commit 标题明确写明「写清理步骤交 owner 执行」——这是合入 ≠ 生产执行的又一例。
- **#5914（Q1a）**：残余跟进指针 #5918（账本未展开其具体内容）。
- **#5917（Q3a）**：合入时残余「material_changed 未演练（夹具无 material 列）」与「changeCounts 词表落后引擎（缺 componentCodeChanged/materialChanged，`reads.cjs:263` + `DiffView.vue:448`）」。**订正**：同窗口 #5932/Q3c 只收口了词表一条（词表补齐 + 断言改写为真值）；material_changed 演练缺口没有被收口——#5932 未改 `plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/`（该目录在 #5917 之后到 main `4189aa096` 无任何提交），夹具仍无 material 列，演练断言钉的是 `materialChanged: 0`（`scenario-b-v2-snapshot-diff.test.cjs:486`、`StockPreparationScenarioBAcceptance.spec.ts:218,398`）。该缺口保留。
- **#5931（Q3b）**：真复演因本机无 PG 二进制未跑，改用真 socket + 桩后端层补证；账本原文明确标注这是未覆盖项，不是等价替代证据。
- **场景 B 整体口径（订正）**：#5917/#5931/#5932 合起来只能签「合成数据 diff 引擎演练完成」，不是客户历史迁移、双轨对账或接管路线第 3 步的验收。真 PG + 真后端的复演未跑；复审修复 #6041 新增的 `scenario-b-replay-verify.yml` 是 hermetic 泳道（无数据库、无网络），#6041 正文也写明「真 PG + 真后端复演仍未执行」。
- **#5952（Q4c PR-2）**：实读发现三条路由是 `requireAccess('admin')`（而非普通租户级读权限）、`workspaceId` 查询参数是死参数（接收但不生效）——这两点是代理实读代码时发现并记入的既有行为，不是本 PR 引入的新问题，但账本未记录是否已有独立跟踪单。此外首轮门拒 CONFLICTING/DIRTY——与合入更早的 #5949 同改 `packages/openapi/src/base.yml` 与 `dist`/`dist-sdk` 生成物；已 merge origin/main + 重生成 dist 解决冲突（新 head `f431ab0f4`），但截至本文档最后一次核对仍在等 CI 过门，需窗口收尾后核对最终结果。
- **#5951（Q8）**：反驳给出 5 条 non-blocker，其中「无守卫断言每个 token 至少命中一个 spec」是明确写出的覆盖缺口（token 命中守卫缺）；另一条「union 作用于整文件含 1250 行注释」是范围过宽的已知盲区。**订正**：#5951 的作用限于消除巨型单行热点——把 11KB、397 token 的单物理行拆成一行一个 token 的字母序块，使并发登记的冲突面从整条巨行缩小到字母序相近的少数几行。它不保证「从此不再冲突」：`merge=union` 只在本地 git merge/rebase 读取 `.gitattributes` 时生效，GitHub 服务端合并是否执行该 driver 未实证（#5951 正文原话：「只作本地 rebase/merge 兜底……故不作保证」）。
- **#5950（Q4b）**：首轮门拒（CI 红 2：`approval-web-guard` + `web-tests`），账本 08:23Z 定位根因为 UF-6 样式守卫（`<style>` 里不许 hex/rgb() 字面量）打在本 PR 新加的自动刷新标签样式上，非既有 flake；已改用设计 token 修复（`1e204c554`）并合入，不再是残留项，此处仅作记录。
- **H1/#5903**：commit 标题与账本队列描述均明确限定为「读侧 GET 的 500 分支」；写侧（PUT/POST/DELETE 等）回显是否同样处理，账本第八窗口段未提及，需另行确认。**订正**：脱敏只覆盖 `admin-routes.ts` 本体的 13 个 GET（#5903 正文逐条列出）。挂在 `/api/admin` 下的子路由（`admin-routes.ts:2386` `/snapshots` → `snapshot-labels.ts`，`:2387` `/safety/rules` → `protection-rules.ts`）在 500 分支仍把 `(error as Error).message` 原文写进响应体，其中 GET 有 `snapshot-labels.ts:206`、`protection-rules.ts:198,227`（main `4189aa096` 实读）。这是 #5903 之前就存在的残余，不是 #5903 引入的；据协调方告知，当前窗口另有 PR 在处理（本订正开出时未见其 PR 编号）。`admin-routes.ts` 本体里写侧路由的回显同样仍在，#5903 未处理。
- **Q2/#5923**（订正）：守卫只封串行删除。`deleteExternalSystem` 先计数（`external-systems.cjs:1343-1344`）再删（`:1369`），两步之间没有事务或行锁；计数之后提交的并发 bind 不会被拦住，并发 bind/delete 未封。

---

## 7. 下一步候选（仅列账本第八窗口段出现过的）

- **Q1c**（rebase #5680 到 main、base 改 main、反向对照改正向、删过期豁免，对应 C1 B-3）：前置条件 #5665/Q1b 已合入 `309b551eb`，账本 08:24Z 记录已派出（opus + refuter，`wt-w8u`，`wf_f9fbe88c-372`），08:39Z 记录「Q1c impl 在跑（前置 #5665 已合）」；结果以账本后续记录为准，本文档未见其产出。（**后续**：#5680 于 2026-09-21 09:33Z 合入 `0d87232cb`，经 `gh pr view` 核实；owner 复审对其提出 N3，见第 8 节。）
- **H5/#5906 的 VALIDATE 后续生产执行**：commit 标题明确写明「写步骤交 owner 执行」，属 owner 层一次性批准事项，非本窗口自动化范围。
- **#5786 相关生产执行**（账本历史遗留提法，本窗口未见新增讨论）：未记录本窗口是否有新进展，若仍未执行，仍属 owner 单独批准事项。
- **verify 泳道合入**：账本第八窗口段未展开具体内容（未记录），仅作为候选名目列出，供协调方核对是否仍在等待队列中。
- **#5952（Q4c PR-2）CI 收官后按策略过门**：账本最后一次核对时（09:09Z）冲突已解、四条 openapi 脚本绿，排在 #5950 链之后等 CI，尚无合并结果记录，需窗口收尾后核对实际合并结果。（**后续**：2026-09-21 09:57Z 合入 `aac8fd853`，经 `gh pr view` 核实。）

---

## 8. owner 独立复审与后续处置（2026-09-25 补记）

owner 于 2026-09-21 对本窗口产出做了独立复审（复审材料在 owner 本地，未入库），裁决：**不按收工销项，发最小修复，无需回滚**。第 4 节把 #5933、#5926 写成只待 owner 审批，这一口径据此撤回：两者当时都有复审缺陷，当前版不放行。复审项与处置如下；状态与合并时间均于 2026-09-25 用 `gh pr view <号> --json state,mergedAt,mergeCommit` 核实，时间为 UTC。

| 复审项 | 级别 | 针对 | 问题（一句） | 处置 PR | 状态 |
|---|---|---|---|---|---|
| F1 | P1 | #5933 | READ COMMITTED 下候选快照覆盖并发提交的新绑定，账本也记旧源 | #5933 本身（修复提交 `697284b0a`、`e4e4cdf90`） | **OPEN**，待 owner 授权 |
| F2 | P1 | #5931（已合） | loopback 按字符串前缀判定，非本机名也被当本机 | #6041 | MERGED 2026-09-24 05:01Z，`b7e1cbbeb` |
| F3 | P1 | #5931（已合） | 配置作用域与运行作用域不一致，真实链路源运行 404 | #6041 | 同上 |
| F4 | P2 | #5931（已合） | 不能连续复演（第二次审批 409、同版本多前驱 409） | #6041 | 同上 |
| F5 | P2 | #5926 | 泳道触发 `paths` 漏了被测迁移文件 | #5926 本身（补丁 `74ba66c98`、`df3776918`、`a0b703a2c`：补 paths、接线测试独立成 job、装依赖） | MERGED 2026-09-24 04:53Z，`fad4ccedf` |
| N1 | 见注 | #5950（已合） | 面板卸载后迟到的响应重新启动轮询 | #5959 | MERGED 2026-09-24 04:01Z，`2bfa103fb` |
| N2 | 见注 | #5950（已合） | 手动刷新与后台请求重叠，loading 永久不消 | #5959 | 同上 |
| N3 | 见注 | #5680（已合） | 结构守卫把 `.get(门).all(无门)` 误算为写方法有门（测试缺口） | #6040 | MERGED 2026-09-24 04:51Z，`ec0130319` |

注：F1 级别见 #5933 修复评论，F2–F4 级别见 #6041 正文，F5 级别见协调方账本；N1–N3 的级别只见于协调方记录（P2），PR 正文未写。

**#5933 当前状态**：
- 修复内容（见 PR 评论）：UPDATE 自身 WHERE 对当前行逐条复核六个绑定侧条件，锁等待后由 PG 按新行版本重判；候选 CTE 加 `FOR SHARE OF ds` 覆盖源侧条件；账本只由 `UPDATE … RETURNING` 喂；`down()` 补 tenant 与 owner 戳复核，与 `up()` 对齐。
- 仓库回归：两连接真 PG 竞争回归（`legacy-binding-connection-id-backfill-race.db.test.ts`，14 条）与结构钉（15 条），接入独立车道 `legacy-binding-backfill-race-realdb.yml`。
- 独立对抗核验：已完成；验证文档记录了核验发现的 `down()` 反例 Sf4/Sf5 并已修（`e4e4cdf90`）。核验规模（对真实迁移链 schema 跑 37 个场景、未见错写）是协调方记录，PR 线程未留档。
- 已知代价（PR 评论自述）：迁移对候选源持 `FOR SHARE` 直到批次提交；写入者锁序不同时可能出现 40P01 死锁，整体回滚后可直接重跑。
- 当前 head 为 `cb765d4e7`，是 2026-09-25 把 main 合进分支的合并提交；与 `e4e4cdf90` 相比，PR 自身文件无差异。
- 性质：**DDL（新建账本表）+ DML（回填）**。合并、生产普查与生产应用都须 owner 授权，协调方不代为合并。

**本轮订正所据的「不能说的话」**（owner 复审原意，已在上文各处落实）：场景 B 只签「合成数据 diff 引擎演练完成」；真 PG + 真后端复演未跑；material_changed 未演练；#5951 只是消除巨型单行热点；#5903 脱敏限 `admin-routes.ts` 本体 13 个 GET；#5923 不封并发 bind/delete；停摆时长与有效工时是协调方自述。

---

## 附：验证记录

本文档撰写期间对以下事项做过独立核实（均为只读操作，未改动仓库任何内容）：

- `git -C <主检出/worktree> log --oneline 96cd7b57c..origin/main` 核对本窗口内 main 分支后续实际合并的提交序列，用于交叉核实上表中的合并 sha 与 PR 号（工具与用途见任务说明第 3 条允许范围）。
- `git show --no-patch --format="%H %P %s"` 核对 `96cd7b57c` 与 `0e73ac2eb` 的父子关系，确认 #5925 的合并提交确实存在于 main 历史中（用于第 3 节 #5925 行的注记）；同法核对 `74d9fa496`（#5949）与 `8d0aff7e9`（#5951）的 commit 标题均含对应 PR 号，确认已在 `origin/main` 历史中。
- （首轮，08:2x 核对时）`git log --oneline --all` 按 `#5950)`/`#5665)`/`#5952)` 关键字搜索，确认这三支当时均未出现在任何本地已知分支的合并历史中，判定仍为 OPEN。
- 网络连通性诊断（第一轮，出网中断期间）：`git fetch origin`（多种本机代理配置）、`curl -v` 到 `api.github.com`（含强制 TLS 1.2/1.3）均失败于 TLS 握手阶段；对照组 `curl` 到国内站点成功，判定问题出在代理上游隧道而非本机代理进程本身；本机 reclaude 隧道日志显示持续的 tunnel EOF 错误，时间上与账本自身记录的「09-21 07:40Z 出网再断」相吻合。协调方确认「探针 200 + 用户确认」出网已恢复后，`git fetch origin` 重试即成功（`58d48934e..74d9fa496`），随后 `git worktree add` 成功。
- （第二轮回填，收到协调方回填指令后）重新 `git fetch origin` 成功；`git merge-base --is-ancestor 309b551eb origin/main` 与 `git merge-base --is-ancestor c919db1c4 origin/main` 均返回真，且 `git log --oneline 74d9fa496..origin/main` 显示这两个 commit 的标题分别含 `(#5665)`/`(#5950)`，与协调方给出的合并 sha 一致；同一命令未见任何 `(#5952)` 字样的 commit，判定 #5952 截至本次核对仍为 OPEN，与协调方消息「CI 跑中」一致。

**本次执行结果**：第一轮因出网中断，按任务边界「失败就停并报告」未创建 worktree/分支/提交/PR，仅将文档草稿完整落在 scratchpad（详见协调方交接记录）。网络恢复后收到协调方续跑指令，重新 `fetch` 成功、创建 worktree `../metasheet-wt-docs8` 与分支 `docs/autonomous-run-20260921-outcome`，将草稿迁入 `docs/development/` 并按账本最新尾部（09-21 07:4xZ 之后新增的条目）回填了 #5949/#5951 的合并 sha、#5952（原 PR-2）的 PR 号与内容、#5950/#5665 的最新 CI/反驳状态，随后提交、推送并开出 **#5956**。协调方随后回复账本已进一步推进（09-21 09:13Z），带来 #5665 → `309b551eb`、#5950 → `c919db1c4` 两个新合并 sha 与 Q1c 已派出的消息；本次为第二轮回填，把这两项从 `<待填>` 更新为确认过的合并 sha（已用 `git merge-base --is-ancestor` 独立核对），#5952 因账本与 git 历史均未见其合并记录、协调方也明确指示保持 OPEN，故原样保留 `<待填>`/OPEN 状态描述，并同步更新了第 1 节窗口事实、第 4/6/7 节与本附录。

**第三轮（2026-09-25 订正，owner 独立复审后）**所做的只读核实：
- `gh pr view 5932 --json files` 与 `git show 90d269a34`：#5932 未改 `fixtures/scenario-b-synthetic-bom/`，只把两处断言改为 `componentCodeChanged: 1`、`materialChanged: 0`；`git log 90d269a34..origin/main -- plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/` 无输出，夹具目录内 grep `material` 无命中。
- `.github/workflows/scenario-b-replay-verify.yml`（#6041 新增）实读：两个 job 只有 checkout + setup-node（wiring job 另装依赖），无数据库 service；#6041 正文「边界与残余」原话写明真 PG + 真后端复演仍未执行。
- `gh pr view 5951 --json body`：`merge=union` 一段原话为「只作本地 rebase/merge 兜底……本仓未做实证，故不作保证」。
- `gh pr view 5903 --json body` 列出的 13 个 GET；main `4189aa096` 上 `admin-routes.ts:2386-2387` 挂载子路由，`snapshot-labels.ts:206`、`protection-rules.ts:198,227` 的 GET 仍回显原文错误。
- main `4189aa096` 上 `external-systems.cjs:1324-1369` 实读：`deleteExternalSystem` 计数与删除之间无事务、无行锁。
- `gh pr view <号> --json state,mergedAt,mergeCommit`：#5959、#5926、#6040、#6041、#5680、#5952 均 MERGED（时间与 sha 见第 3、7、8 节）；#5933 OPEN。`git diff --quiet e4e4cdf90 cb765d4e7 -- <#5933 的全部 10 个 PR 文件>` 退出码 0。
