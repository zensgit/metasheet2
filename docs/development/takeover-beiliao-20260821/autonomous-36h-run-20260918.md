# 第八次自主开发窗口（36h，2026-09-18）设计与验证

与 `docs/development/autonomous-run-20260920-outcome.md`（PR #5900，「第七窗口接管日」）是两条并行线：#5900 记录另一会话在同一时间段内对第七窗口交接件的接管与合并，本文只记录第八次 36h 窗口自身的授权、执行与产出，两文互不重复对方内容。

状态：**已定稿**（定稿时间 2026-09-21 11:15 CST，`TZ=UTC-8 date` 实测）。账本截至 2026-09-20 18:20 CST（`claude-auto24/STATE.md` 第 622 行，「## 2026-09-18 18:55 第八次窗口（36h）开始」到「## 2026-09-20 18:15 第九次窗口（24h）开始」这一段）为本文覆盖范围；本文按该段账本与 GitHub 现场核验落笔，之后的进展（第九次窗口及以后）不在本文覆盖范围内，见 `docs/development/takeover-beiliao-20260821/autonomous-24h-run-20260920.md`（PR #5930）。撰写时点：约 2026-09-20 18:12 CST（GitHub 服务器时间头核对）。本文经过两轮复核：第一轮（撰写时）对五支已合 PR 逐条核对 `gh pr view --json commits` 的提交 trailer（发现模型分派与计划不符，见第 4 节脚注）、对四支在飞 PR 用 `gh pr checks` 现场核对 CI 结果（发现三支带真回归/已知超时的红检查，见第 3 节）；第二轮（本次定稿，2026-09-21）用 `gh pr view`/`gh pr checks`/`gh issue view` 逐一核实第一轮遗留的全部「待补」格——#5842（→ PR #5915）、#5839 B1（→ PR #5924）、#5839 B3（→ PR #5919）均已合并且 CI 全绿；#5839 B4（→ PR #5921）在飞、CI 大部分绿但尚未合入 main；#5839 B2/B5 仍未开 PR；第一轮记录的三支带真回归的已合 PR（#5873/#5892/#5893）经复核 CI 均已转绿，未发现独立修复 PR；222 上机（R59）截至定稿时仍未执行，详见第 3、7 节。

---

## 1. 授权原文与边界

**授权原话**（2026-09-18 18:5x CST）：
> 接下去36小时我不在电脑前，你能帮我规划开发并持续不间断的进行么？并根据代码难度来选择模型，完成后给出设计及验证MD

**窗口**：2026-09-18 18:55 → 2026-09-20 06:55 CST（36 小时）。
**交付约定**：`docs/development/takeover-beiliao-20260821/autonomous-36h-run-20260918.md`（设计 + 验证），即本文。

**边界**（沿用第七次窗口，未变）：
- 不碰：`DataSourcesView.vue` / `components/data-sources/**` / customer-delivery-guide / 审批中心代码 / 同事分支与 worktree / K3 外部写 / 222 凭据、网络、系统设置 / 生产 PLM 绑定 / 删客户数据。
- 222 部署仅 18:00–08:00 CST（09-19 08:00–18:00 禁部署）；部署前查 nginx 外部流量 ≈ 0。
- 合并协议：13 项 required 检查绿 + `CLEAN` + 0 非 SUCCESS 检查，`--match-head-commit`。
- 守卫/边界类 PR 必过反驳者；开 PR 前字节扫描；不跑 `vue-tsc -b`；不用 `--admin`。
- 代理只在自己的 worktree 里干活；仓库外只报告不动手。

**唤醒纪律**：每次唤醒先 `TZ=UTC-8 date`，读 `STATE.md` 尾部；不空转，队列空则推进 Q9/Q11。

**队列（PLAN-36h-20260918.md 原始版本）**：

| # | 任务 | 计划模型 | 窗口开始时状态 |
|---|---|---|---|
| Q1 | #5867 自动化测试运行 dirty 守卫（#5859） | sonnet | PR 开，等 CI |
| Q2 | #5868 备料表外项目守卫（#5860 A）修复轮 | opus | 修复中 |
| Q3 | DELETE 方法覆写 + 前端自动回退（客户 #1/#4） | opus | 实现中 → 反驳 → PR |
| Q4 | 根选择 contains 模式 + 报告 + 客户预设（#5862） | opus | 实现中 → PR → 222 env 配置（窗口内） |
| Q5 | #5863 冻结列后首行被固定（bug 部分） | sonnet | 待派 |
| Q6 | #5861 使用模板幂等 | opus | 待派 |
| Q7 | #5828 修复（交接件） | opus | 待派 |
| Q8 | #5838 / #5842 修复（交接件） | sonnet/opus 视难度 | 待派 |
| Q9 | #5839 存在性先于权限 28 处 survey → 分批修 | opus | 待派 |
| Q10 | #5863 冻结行（功能） | sonnet | 视时间 |
| Q11 | #5864 字段类型转换矩阵（设计文档先行，不实现） | opus 设计 | 视时间 |
| R59 | 部署 Q1–Q4（+Q5/Q6 若合）到 222 | — | — |
| DOC | 本文档 | — | 收尾 |

窗口中途（19:08 CST）追加 **Q12**：#5863 通知面板靠视口左缘时内容被裁切（客户截图）。

---

## 2. 时间线

**窗口在跑（09-18 18:55 → 19:50 CST，约 55 分钟，唯一有真实产出的连续区间）**：

| 时间（CST） | 事件 |
|---|---|
| 18:55 | 开窗，读 PLAN-36h-20260918.md；在飞 Q1（CI 中）、Q2（修复轮）、Q3（DELETE 回退实现）、Q4（根选择实现）。222 实读确认 `pull-bom` 动作无 `rootSelection` 覆盖，跑的是默认 `endsWith -A/-B`，客户要 `contains -A/-B/-C/-D`。 |
| 19:05 | 建立会话级 cron 心跳 `b0316f99`（每小时 `:23`，仅空闲时触发）。#5868 修复轮 `4244f541e` 已推。 |
| 19:08 | #5863 改口径为表头 sticky-top 功能（列冻结保留）；新增 Q12；Q11 类型转换矩阵已给方案（二刀预检 + 三刀迁移）等 owner 拍板。 |
| 19:10 | PR #5872（通知面板）、#5873（DELETE 回退）开出；#5873 反驳中。在飞实现：根选择（rootsel）、表头固定（freeze）。 |
| 19:14 | 会话模型切到 Fable 5.1；派活规则确立（sonnet=低难度 / opus=中高难度+反驳 / Fable=终审）；PR #5874（根选择）已开。 |
| 19:19 | #5867 合并 `b4e728d88`（Q1 done）。#5873 浏览器车道触发清单补 `delete-fallback.ts`。 |
| 19:33 | PR #5875（冻结三层）开出。派 Q6 #5861（opus）。 |
| 19:37 | #5868 合并 `9d56202d1`（Q2 done），#5860 关闭。 |
| 19:44 | 心跳检查：无停摆，准备派 Q7/Q8。 |
| 19:47 | 派 Q7 #5828（opus）、Q8 #5838（opus）、#5842（opus）。 |
| **19:50** | **#5872 通知面板合并 `bb77ca5f2`（Q12 done）——账本可核验的最后一次真实产出。** |

**36h 空转（09-18 19:50 → 09-20 08:30 CST，约 36 小时 40 分钟，循环在跑 ≠ 在干活）**：

- 会话级 cron 心跳按设计每小时 `:23` 触发，但自 **09-18 20:43 UTC**（约合 CST 09-19 04:43）起，每次唤醒收到 `400 当前该账号暂不可用`；自 **09-20 00:17 UTC**（约合 CST 09-20 08:17）起，错误改为 `400 此 session 已绑定另外的 ai 账号`。
- 期间心跳**按设计正常触发**（进程存活、按点火），但每一次都在第一个 API 调用上失败，**没有任何代理产出、没有任何 PR、没有任何 STATE.md 新增条目**——这正是「循环在跑 ≠ 在干活」：外部可见的是"进程仍在运行"，内部事实是 36 小时零推进。
- 原会话无法 `--resume`（账号已绑定另一账号，永久失效）。
- 36h 窗口已于 09-20 06:55 CST 到期；222 部署窗口（18:00–08:00）同期关闭，**本轮未上机（R59 未执行）**。

**从残件重建（09-20 08:30 CST 起，新会话 Fable 5.1）**：

- 08:30：确认中断真相，工作状态从 worktree 未提交草稿 + STATE.md + GitHub 现场重建（无法从旧 session 恢复）。本地 main ff 到 `origin/main`（合入前 = `868c8d2b2`，含同事 #5849）。合入 #5874（`2f99f3a02`）、#5875（`b87794a6b`），均 21/25 项检查全 SUCCESS、CLEAN、`--match-head-commit`。#5873 判定为真回归（非假红）：`attendance-web-guard` 六条 spec 全红，根因方向指向夹具对非 GET 请求一律 `route.abort()`，已派修复轮。四条中断代理的未提交草稿（wt-delfb/wt-tpl5861/wt-ss5828/wt-ai5838）逐一确认仍在，派出四条 opus impl-hard 续接。
- 08:50：用户追加要求「请根据代码难度来自动分别不同的模型」，会话切 Fable 5.1，模型分档规则正式固定（见第 4 节）。起两条工作流：`wf_70741390-2e8`（#5842 守卫流水线）、`wf_d4a141f3-2de`（#5839 只读调研）。
- 09:38–11:09（多次）：观测到另一 Claude 会话 `metasheet-4d` 在同仓库持续 ff 主检出（非本会话操作），只读无害，已知不处理。
- **09:40–10:36：reclaude 隧道中断**（本机 reclaude 守护进程对上游连续 EOF，10:00–10:20 每 10 分钟 500–760 次错误，10:30 仍在断）。表现为所有 opus 代理返回「502 Cannot reach the reclaude gateway」，#5873 两次、#5828/#5838/#5861 各一次断线中招。处置：停止盲目续跑，改为单次探活唤醒（`curl www.reclaude.ai` 通即报），Fable 主会话不受影响，只读/设计类工作在间歇通畅时继续完成。10:36 隧道恢复（`curl 200` + 60 秒零错误）。
- 11:05–11:50：隧道恢复后依次交活——#5838 → PR #5891（11:05）、#5861 → PR #5893（11:15）、#5873 修复轮交活（11:30，根因从「探针闩锁」更正为「模块路径命中夹具通配」）、#5839 调研工作流完成（11:50，见第 6 节）。
- 12:20：B1（#5839 第一批）派出；同时确认另一会话 `metasheet-4d` 已合并数支 PR、回收了部分工作树，跨会话协调消息已发（勿动本会话在飞工作树）。
- **约 13:30–17:45：会话被限额挂起，随会话进程运行的八条工作流全部冻结**（工作流不是独立进程，会话被挂起即整体停摆）。17:45 用户 continue 后才恢复；账本原话「额度早恢复了——额度早好了，是会话没被唤醒」，即**限额解除时刻与会话恢复时刻不是同一时刻**，中间的空档同样是「循环（心跳）在跑 ≠ 在干活」的另一次重复。
- 18:05：恢复后核对八条流水线各自所处阶段（评审四条在跑套件验证、B1 在账本阶段、B3 反驳中、B4 写 spec），并对当时的 CI 红做定性（详见第 3 节）；加速措施到位（B2/文档 worktree 建好，B1 推送触发器就绪）；交付文档起草派出（本文由此而来）。
- 18:20：发现用 Agent 工具直派的两个代理（文档草稿、#5893 修复）在首句后流停、输出 0 字节（同时段工作流内的 opus 代理运行正常），判定为直派通道问题、非模型问题，两者已停止，改走工作流重新派发（#5893 修复→终审、#5842 修复→终审各一条工作流；文档起草工作流 `wf_e6199ab0-8e6`，即产出本文）。确认 #5842 分支尚未推送到 `origin`（`git ls-remote` 为空），B1/B3/B4 同样尚未推送。

---

## 3. 产出清单

| PR | 状态 | 一句话 | 模型 | 验证方式 |
|---|---|---|---|---|
| [#5867](https://github.com/zensgit/metasheet2/pull/5867) | 已合（`b4e728d88`） | 自动化规则有未保存改动时禁用「测试运行」并提示先保存 | opus（提交 trailer 实证，见第 4 节脚注；PLAN 定 sonnet） | `tests/multitable-automation-rule-editor.spec.ts` 179/179；变异（守卫恒 false）→ 新用例红；字节扫描 3 文件 0 控制字节 |
| [#5868](https://github.com/zensgit/metasheet2/pull/5868) | 已合（`9d56202d1`） | 目标表含其他项目有效行时拒绝拉取（方案 A，表级守卫 fail-closed） | opus（修复轮） | `stock-preparation-table-actions.test.cjs`（+4 用例）、`http-routes.test.cjs` OK；变异两处（反转条件、去掉 dry-run 调用）各红；字节扫描 4 文件 0 控制字节；`pluginHttpRoutes` provenance pin 40 项全过 |
| [#5872](https://github.com/zensgit/metasheet2/pull/5872) | 已合（`bb77ca5f2`） | 通知面板靠视口左缘时改左对齐，内容不再被裁切 | opus（提交 trailer 实证，见第 4 节脚注；PLAN 未列此项） | spec 13/13；变异（阈值比较反转）→ 两条新用例红；字节扫描 2 文件 0 控制字节 |
| [#5874](https://github.com/zensgit/metasheet2/pull/5874) | 已合（`2f99f3a02`） | 根选择支持 contains 匹配与前缀可选，输出 values-free 根选择报告（#5862） | opus | bom-expansion / table-actions 两套 OK（+ 新用例 a–f）；8 个内存级变异全部红；无 pin 文件改动；字节扫描 6 文件 0 控制字节；21 项检查全 SUCCESS、CLEAN、`--match-head-commit` |
| [#5875](https://github.com/zensgit/metasheet2/pull/5875) | 已合（`b87794a6b`） | 表头随滚动固定 + 视图可冻结前 N 行，与冻结列叠加（#5863） | opus（提交 trailer 实证，见第 4 节脚注） | 5 个 spec 205/205；三处变异各红；字节扫描 8 文件 0 控制字节；审批 tripwire 0；25 项检查全 SUCCESS（1 SKIPPED）、CLEAN、`--match-head-commit` |
| [#5873](https://github.com/zensgit/metasheet2/pull/5873) | 已合（`2ab346bf0`，2026-09-21T03:00:13Z） | DELETE 方法覆写中间件 + 前端 DELETE 传输自动回退（客户出网丢弃 DELETE），并顺带修好自身打红的三条浏览器车道 | opus（实现 + 修复轮） | PR 正文自报：playwright 三配置 6/29/17 全过、web vitest 73 passed、backend vitest 18 passed、三处内存级变异各红。**定稿现场复核（`gh pr checks`，合并后）**：全部检查 pass（含 `test (18.x)`/`test (20.x)`）、1 项 skipping；此前记录的 `elearning-media-playback-runtime` 三条真回归在合并前最终一跑已转绿，未找到独立修复 PR，本次未深挖是瞬时问题还是被其他改动顺带修复 |
| [#5891](https://github.com/zensgit/metasheet2/pull/5891) | 已合（`a93323343`，2026-09-20T11:07:50Z） | 同步 bulk-preview 每行外发前复查表存活，删表后停止外发（#5838，摘除守卫具名 GAP 豁免） | opus | PR 正文自报：守卫 77/77、新增 spec 5/5、`ai-bulk-job-sheet-liveness` 6/6、变异探针删表用例外发 1→3 次复现。**现场核验**：26 pass、1 skipping、0 fail（全绿），与 STATE.md「#5891 全绿 CLEAN」一致；定稿复核（合并后）同样全绿 |
| [#5892](https://github.com/zensgit/metasheet2/pull/5892) | 已合（`e3b5b132d`，2026-09-20T12:32:07Z） | 遗留 `:sheetId` 路由补父表存活守卫，并把 `:sheetId` 绑定到 `:id`（#5828，摘除守卫具名 GAP 豁免） | opus | PR 正文自报：守卫 74 passed（豁免摘除后）、四消费方合计 213 passed、新增 spec 14 passed、既有 + 新增 112 passed、集成套件 29 passed、6 项变异使新行为测试红、2 项使守卫自身红。合并前一次现场核验曾见 `test (20.x)` fail（`elearning-scope-access` 真库 10,000 规则扫描 30s 超时，判定与本 PR 无关）；**定稿复核（合并后 `gh pr checks`）**：重跑已转绿，全部检查 pass |
| [#5893](https://github.com/zensgit/metasheet2/pull/5893) | 已合（`ae500f1a1`，2026-09-20T12:33:12Z） | 「使用模板」按 (租户,用户,模板,工作区,Base名) 去重，窗口内重复安装返回同一个 Base（#5861，客户 #5） | opus | PR 正文自报：unit 5 文件 73 passed、集成 81 passed、web 10 文件 154 passed、openapi-parity pass、7 项变异表全红。合并前一次现场核验曾见 `test (18.x)`/`test (20.x)` 两项 fail（`global-history-flag-manifest` completeness 未登记新增 env 读取，判定为真回归，修复轮随后完成，未产生独立 PR）；**定稿复核（合并后 `gh pr checks`）**：全部检查 pass |
| [#5842 → PR #5915](https://github.com/zensgit/metasheet2/pull/5915) | 已合（`8d5b1fdd5`，2026-09-21T03:07:21Z）；issue #5842 已随合并关闭（CLOSED） | 批量任务取消后立即提交的竞态修复（守卫流水线） | opus/Fable（修复→终审） | PR 正文自报：反驳发现的 17 条含 8 项 major 全部 FIXED；新增 `ai-bulk-job-cancel-commit-state.test.ts`（13 例）+ 20 项内存级变异全红；与 main 两轮合并逐 hunk 核对；字节扫描 0 控制字节。**现场核验（`gh pr checks`）**：28/30 pass、2 skipping、0 fail |
| [#5839 B1 → PR #5924](https://github.com/zensgit/metasheet2/pull/5924) | 已合（`0714f0a3f`，2026-09-21T02:50:49Z） | 表配置族 11 条路由权限判定先于表行探测，未授权者对存活/软删/不存在的表同得 403（config-history 摘出）+ 共享测试夹具 `sheet-existence-oracle.ts` | opus | **现场核验（`gh pr checks`）**：27/28 pass、1 skipping、0 fail |
| [#5839 B3 → PR #5919](https://github.com/zensgit/metasheet2/pull/5919) | 已合（`afb4e44a5`，2026-09-20T12:40:05Z） | 关掉四个 univer-meta 处理器的表存在性预言机（prepare/export-xlsx/dry-run/attachments），补行为级证据 | opus | **现场核验（`gh pr checks`）**：27/28 pass、1 skipping、0 fail |
| [#5839 B4 → PR #5921](https://github.com/zensgit/metasheet2/pull/5921) | 评审中/CI 中（OPEN，`mergeStateStatus=BLOCKED`）。**现场核验（`gh pr checks`，本次定稿时）**：24 项已 pass、`test (18.x)`/`test (20.x)`/`web-tests` 三项仍 pending、1 项 skipping，尚未合入 main | 事务内两条记录权限路由的表存活判定移到权限判定之后，values-free 拒绝 | opus | 未合并，暂无终态核验 |
| #5839 B2 | 在飞，尚未开 PR。GitHub 侧核验（`gh pr list --search 5839`）确认无对应 PR；触发器 `bry660an4` 是否已因 B1（PR #5924）合并而点火、脚本进度如何，超出本次可核验范围（无内部工作流可读接口），如实写"未核实" | 字段/视图/导入/汇总 8 条纯删除，复用 B1 夹具 | sonnet（计划） | 未核实（无 PR 可查） |
| #5839 B5 | 在飞，尚未开 PR（同上，GitHub 侧确认无对应 PR）；账本清零批，仍等 owner 对第 6 节裁决②/③/⑤ 拍板后才可合并 | 公开表单入口 `POST /views/:viewId/submit` + `PATCH /records/:recordId` | opus（计划） | 未核实（无 PR 可查） |

---

## 4. 模型分派规则与实际分派

**分派规则**（09-20 08:50 CST 确立）：

| 档位 | 定义 |
|---|---|
| sonnet | 只读调研 / 机械改动 / 文档 |
| opus | 实现（impl-hard）与反驳（refuter） |
| Fable（会话模型） | 终审（security-judge）与挑漏 |

**流水线形态**：
1. **单代理**：无边界/权限影响的机械改动或文档（如 #5867、#5872）。
2. **守卫流水线**：实现 → 反驳 ×2（不同视角） → 修复 → 终审，用于触及表存活守卫、鉴权边界、去重/并发正确性的改动（#5842、#5839 各批、#5873/#5891/#5892/#5893 的评审阶段）。
3. **只读调研流水线**：多名 sonnet 读者分摊路由勘察 → opus 出分批方案（可多轮）→ Fable 挑漏（可多轮），只产出方案不落代码，用于 #5839（3 sonnet 读者分摊 28 路由 → opus 分批方案 → Fable 挑漏两轮）。

**实际分派表**：

| 任务/产物 | 模型 | 形态 | worktree / 工作流 |
|---|---|---|---|
| Q1 #5867 | opus（见脚注，PLAN 定 sonnet） | 单代理（窗口开始前已在 CI） | — |
| Q2 #5868 | opus | 单代理修复轮 | — |
| Q3 #5873 | opus | 守卫流水线（security/hollow 两镜头反驳 → 修复 → 终审） | wt-delfb |
| Q4 #5874 | opus | 单代理实现 → PR | rootsel |
| Q5/Q10 #5875 | opus（见脚注，PLAN 定 Q5=sonnet、Q10=sonnet） | 单代理实现 → PR | freeze |
| Q6 #5861 → #5893 | opus | 单代理实现 → 交活 → 修复轮工作流 `wf_5eecfa39-42d`（修复→终审） | wt-tpl5861 |
| Q7 #5828 → #5892 | opus | 单代理实现（中断续接）→ 反驳 → 终审工作流 `wf_696b1574-f15` | wt-ss5828 |
| Q8 #5838 → #5891 | opus | 单代理实现（中断续接）→ 反驳 → 终审工作流 `wf_d8928638-250` | wt-ai5838 |
| Q8 附 #5842 | opus | 守卫流水线 `wf_70741390-2e8`；修复代理六次停摆后改 `wf_c949030e-33b` | wt-ai5842 |
| Q9 #5839 调研 | sonnet（读者）+ opus（分批方案）+ Fable（挑漏） | 只读调研流水线 `wf_d4a141f3-2de`，两轮挑漏 | — |
| Q9 #5839 B1 | opus | 守卫流水线 `wf_bb7795c7-a30`（实现 → 反驳 fixture/behavior → 修复 → 终审） | metasheet-wt-b1-5839 |
| Q9 #5839 B2 | sonnet（待派） | 机械删除，复用 B1 夹具 | metasheet-wt-b2-5839（已建，未派） |
| Q11 #5864 | opus | 单代理设计（方案已给，未实现，等 owner 拍板） | — |
| Q12 #5872 | opus（见脚注，PLAN 未列 Q12，是窗口中途追加项） | 单代理 | bellpos |
| DOC 本文档 | sonnet | 单代理直派两次 0 字节停摆后改工作流 `wf_e6199ab0-8e6` | docs36h（本 worktree） |
| R59 部署 | — | 未执行（36h 期满，222 部署窗口关闭，本轮不上机） | — |

**脚注（模型核实）**：`git log --format='%B' <merge-sha>` 与 `gh pr view <n> --json commits` 对 #5867/#5872/#5875/#5874/#5868 五个已合 PR 逐条核对，**全部**提交（含 #5875 的两条分提交）trailer 均为 `Co-Authored-By: Claude Opus 5 (1M context)`，无一条 sonnet trailer。这与 `PLAN-36h-20260918.md` 原定 Q1=sonnet、Q5=sonnet、Q10=sonnet 不符（Q2/Q4 计划本就是 opus，与实际一致）；Q12（#5872）是窗口中途追加项，PLAN 未预先定档。STATE.md 在 19:14 CST 才写「派活规则确立」，本窗口前 55 分钟（含 Q1/Q12）落地时该规则或许尚未生效，或者当时按更高难度就近改派 opus——账本未记录改派理由，本文只如实记录提交事实，不做推断。

---

## 5. 验证方法

**通用方法论**（沿用既有对抗核验框架，五类漏法）：假件背书（fake 不按真实 SQL/中间件形状作答）、守卫没接线（拒绝逻辑存在但未挂到路由上）、边界无强制（只测正向不测越权）、逐套绿整链红（分段测试绿但端到端红）、触发与边界不同量（测的是一个条件，代码判的是另一个）。守卫/边界类改动必须过两个不同视角的反驳者才能进终审。

**变异探针**：本窗口全部按内存级方式做（vite transform 插件在加载时改写模块、`vi.mock`/内存 fake，均不落盘、不改工作树），符合「并行反驳者同树变异互撞」教训（并发反驳镜头不得做落盘变异）。

**合并协议**：13 项 required 检查绿 + `CLEAN` + 0 非 SUCCESS 检查 + `--match-head-commit`；#5874/#5875 合并前均现场核验（21/25 项检查全 SUCCESS、CLEAN、`--match-head-commit`）。

**各 PR 正文验证要点（原样摘录关键行）**：
- #5868：「变异 ①反转条件 → 空表用例红，②去掉 computeDryRun 调用 → 用例 1 红」。
- #5874：「8 个内存级变异全部红（contains→endsWith、去掉总图先行、忽略前缀标志、忽略未知键、接受任意模式、无 flags、不投影证据、token 在首位）」。
- #5875：「变异：去掉表头常开 sticky → 3 用例红；上限改 50 → 用例红；去掉冻结行 top 偏移 → 2 用例红」。
- #5873：「本地复现（不是猜测）：装上同形状的路由拦截后，被 `**/api/**` 吞掉的请求有且只有 `GET /src/api/delete-fallback.ts`」；变异证据「把模块放回 `src/api/` → attendance 6/6 红」。
- #5891：「任一条证明塌掉，该条目即判为假（新增 `#5838: … falls when EITHER proof falls` 自测）」；变异「删表用例 provider 由 1 次变 3 次（#5838 原 bug 复现）」。
- #5892：「去掉守卫后新增行为测试变红」六项变异表 + 「守卫侧」两项变异表，均逐条列出结果；顺手修复 main 上既有的一条真红集成测试（`spreadsheet-integration.test.ts`）并用「临时换成 origin/main 版本跑过」的方式确认该红与本 PR 无关。
- #5893：「拿掉的守卫｜变红的用例」七行对照表；「事务级咨询锁」「唯一索引」「事务」三层并发保证均逐条给测试证据。

---

## 6. #5839 调研结论

**范围**：univer-meta.ts 中 28 处「先探表存在性、后判权限」的处理函数（存在性先于权限，可被匿名/无权限调用方当作表存在性 oracle 使用）。

**方案**：5 批共 28 条路由，`uncovered=[]`（全覆盖）。**裁决：不引入生产侧共享 helper，只引入共享测试夹具**（`tests/utils/sheet-existence-oracle.ts`）。三条理由：(1) 28 条路由的能力闸各不相同，一个通用 helper 要么参数堆砌要么覆盖不到一半；(2) 闭世界守卫靠**文本**识别 403/404 拒绝，把拒绝收进新命名的 helper 会让守卫从「读顺序」退化为「认识特定 helper 名字」；(3) B4（事务内两条）、B5（公开表单 + PATCH）四条硬路由本身用不上通用 helper。

| 批次 | 路由数 | 模型 | 处理方式 |
|---|---|---|---|
| B1 | 12（config-history 摘出后 11） | opus | 表配置族纯删除探测代码，复用已有 `sheetLiveness !== 'live'` 拒绝；首个夹具消费者 |
| B2 | 8 | sonnet | 字段/视图/导入/汇总，机械纯删除，复用 B1 夹具 |
| B3 | 4 | opus | prepare/export-xlsx 需搬移探测到拒绝之后；dry-run 需删探测并**就地在 else 分支内**补拒绝（不得跨分支提升变量，否则触发守卫绑定正则误判）；attachments 需删探测并把拒绝改为 `sendSheetNotLive`（同时修正软删表今日回 500 的既有缺陷） |
| B4 | 2 | opus | 事务内记录权限路由，`resolveSheetCapabilitiesForUserOnQuery` 无 `sheetLiveness` 输出，须补插 `loadSheetLiveness` 查询，钉死字面拒绝形状，禁止扩 `GUARD_PATTERNS` |
| B5 | 2 | opus（计划） | 公开表单 `submit`（视图行不可搬移，因为是授权输入；表行可搬移） + `PATCH /records/:recordId`（表行搬移，记录行探测结构性保留）；本批清零 #5839 台账，须最后合并 |

**挑漏 r2（REVISE，5 处缺口，均已给最小修）**：
1. **[behavior]** B5 submit 测试原按「匿名三态统一 403」写，但代码在 403 之前先回 401（有集成测试钉住）——最小修：改为「匿名无效 token → 三态同一 401」+「已登录零权限 → 三态同一 403」两条。
2. **[consumer]** B2 删除 `form-share-candidates` 探测后，既有单测 `multitable-form-share-candidates-bounded` 的假池只在投影分支尊重 `sheetExists:false`，会打红一条既有用例——最小修：B2 任务书写明改这个假池的 liveness 分支。
3. **[guard]** 闭世界守卫的 `GUARD_PATTERNS`/绑定正则不认识 `loadSheetLiveness`，B4 若把拒绝写成跨分支变量会被守卫误判——最小修：钉死字面形状 `const sheetLiveness = await loadSheetLiveness(query, sheetId); if (sheetLiveness !== 'live') return sheetNotLiveOutcome(sheetLiveness)`，禁止扩 `GUARD_PATTERNS`。
4. **[behavior]** B1 对 `config-history` 只删探测，残留「已登录非管理者仍可分辨存活/软删（404 vs 空列表）」——账本条目从 B1 摘出、等 owner 裁决（选项 (i) 接受现状 / (ii) 并入 B1 把 liveness 检查移到空列表返回之后）。
5. **[behavior，低优先级]** `export-xlsx`/`view-aggregate` 各有一条视图不存在 404 排在表级 403 之前，打的是 `meta_views` 不在守卫正则内——建议从「本计划不修」升级为 B2/B3 顺手搬移改 values-free。

**8 项 owner 裁决原文摘要**（`scratchpad/5839/plan-r2.md`）：
① 全部 28 条的错误消息/错误码对客户端可见地改变（`Sheet not found: <id>` → values-free；软删表新增 `SHEET_DELETED` 码），需确认无客户端依赖旧文本/旧码。
② `POST /views/:viewId/submit` 是公开表单入口，改动对未登录外部用户可见：无效/缺失 token 的匿名调用方对软删/不存在的表从 404（可区分）变 403（不可区分），需 owner 明确批准后再合 B5。
③ `GET /sheets/:sheetId/config-history` 的残留取舍：(i) 接受现状并单开跟进 issue（推荐），或 (ii) 把 liveness 检查移到空列表返回之后、并入 B1。
④ `POST /attachments` 状态码修正：软删表从 500 变 404 SHEET_DELETED；不存在的表从潜在的「先写对象存储后被外键打回 500」变 404 NOT_FOUND；同时推翻一段声称「absent 应交给服务层回 409」的既有注释，需确认该推翻成立。
⑤ `PATCH /records/:recordId` 的残留取舍：推荐接受「ABSENT 表答案与『记录不在该表上』逐字相同、不构成 oracle」的现状；替代方案是先按声明的 sheetId 判定 401/403/存活再查记录行，代价是「声明错误 sheetId 的调用方从 404 变 403」。
⑥ `POST /fields` 与 `POST /person-fields/prepare` 从 `throw NotFoundError` 改为 `sendSheetNotLive`/搬移后 values-free，若有调用方依赖「表不存在必为 NOT_FOUND 码」需同步。
⑦ 具名残留（本计划不修，建议另开 issue）：`export-xlsx`/`view-aggregate` 的视图存在性 404 排在表级 403 之前，打的是 `meta_views`，账本清零不等于视图侧 oracle 也关闭。
⑧ 具名残留（同上，需 owner 定是否另开 issue）：`submit` 的视图存在性 404 是授权输入的一部分，无法搬到 403 之后；若要求公开表单的视图 id 也不可枚举，是独立设计改动。

---

## 7. 未完成与交接

| 事项 | 状态 | 需要谁 |
|---|---|---|
| #5839 B5 与 config-history 处置（挑漏缺口④/owner 裁决③） | 未派，等 owner 二选一 | owner |
| #5839 8 项 owner 裁决（①–⑧，见第 6 节） | 待拍板 | owner |
| #5864 字段类型转换矩阵（二刀预检 + 三刀迁移方案已给，未实现） | 待拍板 | owner |
| #5842 竞态修复 | 已合并（PR #5915，`8d5b1fdd5`，2026-09-21T03:07:21Z） | 无（已完成） |
| #5839 B1/B3/B4 | B1 已合（PR #5924，`0714f0a3f`）；B3 已合（PR #5919，`afb4e44a5`）；B4 评审中/CI 中（PR #5921 OPEN，24/28 项已 pass，`test(18.x)/(20.x)/web-tests` 仍 pending，未合入 main） | B1/B3 无（已完成）；B4 走既定合并协议（13 项 required 绿 + CLEAN + 0 非 SUCCESS + `--match-head-commit`），无需 owner |
| #5839 B2 | 在飞，尚未开 PR；`gh pr list --search 5839` 确认 GitHub 上无对应 PR，触发器 `bry660an4` 是否已点火、脚本进度如何超出本次可核验范围（无内部工作流可读接口） | 待核实（下次唤醒） |
| #5893 修复轮 | 已完成，随 PR #5893 一并合并（`ae500f1a1`，2026-09-20T12:33:12Z），未产生独立修复 PR；合并后 `gh pr checks` 现场核验：`test (18.x)/(20.x)` 均转 pass，此前的 `global-history-flag-manifest` completeness 真回归已消失 | 无（已完成） |
| #5873/#5891/#5892 | 三支均已合并——#5891（`a93323343`，全绿）；#5873（`2ab346bf0`，此前 `test(18.x)/(20.x)` 真回归在合并前最终一跑已转绿，未找到独立修复 PR）；#5892（`e3b5b132d`，此前 `test(20.x)` 超时在最终一跑已转绿） | 无（已完成） |
| 222 上机（R59） | 36h 窗口内未执行部署（窗口 06:55 CST 到期时部署窗口 18:00–08:00 已关闭）。按派工单给出的账本事实：本窗口内合并的 PR 以及随后第九次窗口（PR #5930，仍为草稿）内合并的 PR，截至本文定稿时均未上机——36h 窗口内没有任何一次 222 上机，第九窗口截至定稿时也尚未上机（本次任务边界不含 222 现场访问，未独立复核该事实，以派工单账本为准）；是否在下一个 18:00–08:00 CST 部署窗口上机 | owner |
| 交付件（本文档） | 提交并推送分支，不开 PR（按派工单要求） | — |

---

## 8. 教训四条

1. **会话绑定另一账号后 `--resume` 必败，判断「是否在干活」要看账本 mtime、不要看心跳是否还在触发。** 本窗口心跳进程正常触发了约 36 小时，但账号绑定错误使每次触发都在第一个 API 调用上失败，账本因此 36 小时零新增；只有对比 STATE.md 最后一条真实产出的时间戳，才能发现「循环在跑 ≠ 在干活」。
2. **reclaude 502 要看 `~/.reclaude/logs/daemon.log` 按分钟计数 tunnel error 判断是否真的断了，不要盲目续跑。** 09:40–10:36 隧道中断期间，续跑只会让代理反复吃到「502 Cannot reach the reclaude gateway」，正确处置是装单次探活唤醒（`curl` 通即报），只读/设计类工作在间歇通畅时继续，opus 实现类工作暂停。
3. **`apps/web/src` 下不要新建 `api/` 目录；根因假设在证伪之前要显式标成「待证伪」，不要写成定论。** #5873 最初把浏览器车道全红归因于「探针闩锁」，后被实现者用本地复现证伪——真根因是浏览器验证 harness 对 `**/api/**` 做通配拦截，而 `src/api/delete-fallback.ts` 的模块 URL 恰好命中该通配，与「探针」本身无关；`origin/main` 上此前不存在任何 `src/api/` 目录，这是本 PR 自己踩出来的坑。
4. **工作流跑在会话进程里，会随会话一起被限额冻结，额度恢复不等于会话被唤醒。** 约 13:30–17:45 CST，会话被限额挂起后，八条工作流全部随之冻结；17:45 用户手动 continue 才恢复。账本原话「额度早恢复了——额度早好了，是会话没被唤醒」提示：限额解除时刻与「工作流重新开始产出」时刻之间可能存在无人触发的空档，需要主动 continue 才能收口。

---

*本文由第八次自主开发窗口内派出的交付文档工作流（`wf_e6199ab0-8e6`）起草，素材截至 `claude-auto24/STATE.md` 第 622 行（2026-09-20 18:20 CST）；经两轮独立复核（`gh pr view`/`gh pr checks`/`git log` 现场核对），第一轮修正模型分派记录与 CI 现状描述，第二轮（2026-09-21 11:15 CST 定稿）补齐全部「待补」格并转为正式 PR，见第 3、4、7 节标注处。*
