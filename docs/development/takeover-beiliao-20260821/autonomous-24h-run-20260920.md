# 第九次自主开发窗口（24h）2026-09-20 → 09-21 设计与验证记录

与 `docs/development/takeover-beiliao-20260821/autonomous-36h-run-20260918.md`（PR #5913，草稿）是相邻窗口：#5913 记录第八次 36h 窗口（09-18 18:55 → 09-20 06:55，及其会话恢复后延续到 09-20 18:20 的收尾）自身的执行，本文只记录第九次 24h 窗口（09-20 18:15 起）的授权、执行与产出，两文不重复对方内容。

状态：**未定稿**。窗口 2026-09-21 18:15 CST 结束，撰写时点约 2026-09-21 10:15 CST（`date -u` 核对），窗口尚未结束，仍在推进。本文按账本 `claude-auto24/STATE.md`「## 2026-09-20 18:15 第九次窗口（24h）开始」至文件末尾一段，与 GitHub 现场（`gh pr view` / `gh pr checks`）核对后落笔；已发生的写实，进行中的写「进行中」，未发生的写「待补」。

---

## 1. 授权原文与边界

**授权原话**（用户，触发本窗口）：
> 接下去的24小时我不在电脑前，你能根据当前代码进行计划安排么？实现无人值守开发，并根据代码难度来选择合适的模型，完成后给出开发及验证日志，另外若5h额度满后能自动定时开启继续开发呢

**窗口**：2026-09-20 18:15 → 2026-09-21 18:15 CST（24 小时）。
**交付约定**：`docs/development/takeover-beiliao-20260821/autonomous-24h-run-20260920.md`（开发 + 验证日志），即本文。
**计划文件**：`claude-auto24/PLAN-24h-20260920.md`。

**边界（沿用第八次窗口，不变）**：
- 不碰：`DataSourcesView.vue` / `components/data-sources/**` / customer-delivery-guide / 审批中心代码 / 同事与 metasheet-4d 会话的分支与 worktree / K3 外部写 / 222 凭据、网络、系统设置 / 生产 PLM 绑定 / 删客户数据。
- 222 部署仅 18:00–08:00 CST；部署前查 nginx 外部流量 ≈ 0、先备份；只上已合入 main 的内容；跑 `migrate`；标记按哈希核对。
- 合并协议：全部检查 SUCCESS（SKIPPED 允许）+ `CLEAN` + `--match-head-commit`；守卫/边界类 PR 必过反驳 ×2 + Fable 终审；不用 `--admin`；不跑 `vue-tsc -b`；开 PR 前字节扫描。
- 代理只在自己的 worktree 里干活；仓库外只报告不动手；不新建 worktree 时优先复用已合并 PR 的闲置树。
- 长命令（>60s）一律后台跑再读输出，防代理停摆。
- 决策：T 层默认前进 + 24h 异步否决并记账；O 层（真实客户数据 / 生产写入 / 外部写回 / 花钱发布）不动。
- 不做：#5841（产品决定需前端配套）；K3；任何外部写；HR/项目/CRM 方向。

**唤醒纪律**：每次唤醒先 `TZ=UTC-8 date`，读 `STATE.md` 尾部；查各工作流 journal 是否有未处理结果；查 `gh pr list`；不空转，队列空则推进 W5–W8；每次唤醒在 `STATE.md` 追加一条带时间戳的条目；过 09-21 18:15 CST 只做收尾文档、心跳。

模型分档规则见第 4 节。

---

## 2. 时间线

| 时间（CST） | 事件 |
|---|---|
| 18:15 | 开窗。心跳 cron 重建为每小时 `:23`（会话级；限额期间排队，恢复后下一 tick 续跑，7 天自动过期）。在飞九条（W0）承接自窗口 8 末尾：rev5838/rev5828/rev5873 修复轮、fix5893、fix5842（接管，修复→终审）、B1/B4 实现、B3 反驳、36h 文档草稿。 |
| 18:40 | 用户问客户 9 条反馈处理情况：已合 4（#2 #5867、#3 #5874、#7 #5875、#8/#9 #5868），评审中 2（#1/#4 #5873、#5 #5893），设计 1（#6 #5864）；**222 上一条都没有**（r58 早于 #5867/#5868 合入）。用户要求 #6 方案发 issue 讨论 → W5 提前派出（wf_5bd2a5ef-aeb）。 |
| 18:55 | **W4 完成**（wf_7aec82fe-522，sonnet×2）：开 issue #5908（视图侧存在性残留 ⑦⑧）、#5909（模板落到当前 Base ①）、#5910（config-history ③ 待裁决）、#5911（PATCH 残留 ⑤）、#5912（12 组重复迁移时间戳 + 唯一性守卫建议）。 |
| 19:05 | B1 实现推送 `5856d05b3`（夹具 + 11 条删除 + 账本 −11；反驳中）→ **B2 派出**（sonnet 实现 / opus 反驳 / Fable 终审，堆叠在 B1 分支上）。36h 文档草稿推送 `9ef84cec3` → **草稿 PR #5913**。 |
| 19:15 | **W5 完成**：`#5864` 方案评论已发（issuecomment-5749356499），含二刀预检 + 三刀迁移方案核对与 10 条待讨论问题。**#5842 终审 MERGE**（wf_c949030e-33b：17 条全处置，committing 独立状态 + `commit_claim_id` 身份化认领，变异 20/20 红）→ 开 PR #5915。 |
| 19:19–19:20 | **#5892 终审 MERGE**（wf_696b1574-f15，反驳 12 条 0 major）、**#5891 终审 MERGE**（wf_d8928638-250，反驳 10 条 0 major）。两条 CI 均剩 `test(18/20)` 在跑。 |
| 19:25 | **#5891（#5838）合入 `a93323343`**（27 项 SUCCESS、CLEAN、match-head `3eeb6a1b7`）。派 #5892、#5915 两条合 main 解冲突（各走「合并 → 终审」）。 |
| 19:30 | **W6 派出**：#5835（opus 守卫流水线），新工作树 `metasheet-wt-w6-5835`。 |
| 19:40 | **#5893 修复轮完成 `df734d22d`**（wf_5eecfa39-42d，11 条全处置）；CI 红根因定位为迁移导出常量名撞 `MULTITABLE_` 前缀 grep，登记 `NON_GH_EXACT`。 |
| 19:55 | #5915 真库红定性：`multitable-ai-bulk-job.test.ts`「commit re-gate … stale_reprev」第二次 `commitJob` 得 429 而非 200（`:1135`）——上一次提交的认领没有 finish/release，只有真库暴露。→ `findings/5842-realdb.json`。 |
| 20:05 | **#5839 B3 终审 MERGE**（wf_5a2f3e30-f95：实现者因工作树有冻结前半成品按规矩 STOP；反驳者抓到该半成品危险半态；修复轮补齐并开新 spec；终审独立复跑全绿，`ab5a2b806`）→ 开 PR #5919。 |
| 20:20 | **#5839 B4 终审 MERGE**（wf_0a60ccab-bc8：6 条反驳全修，变异三组全红，`855e5abe2`）→ 开 PR #5921。**W7 派出** #5829（opus 守卫流水线，`wt-w7-5829`）。**W8 派出** 迁移时间戳唯一性守卫（sonnet 实现 / opus 反驳，`wt-w8-migguard`）。B3 → PR #5919。 |
| 20:22 | **时间更正（实测 `date`）**：20:05–20:50 一段条目为估算，实际约早 25–35 分钟。此后条目一律先跑 `date`。 |
| 20:28 | **#5915 合 main 完成 `a6ffdcd24`**（wf_8e6b617b-e4b：两段合并，唯一文本冲突 `meta-ai-bulk-labels.ts` 两侧标签都留）。真库 429 未修 → 派第三轮 `wf 5842realdb`。 |
| 20:30 | **#5892 合 main 完成 `fff1cb03f`**（wf_8dd91df0-c1b）。**B5 派出**（wf_23c2be3f-723，opus 守卫流水线，`wt-b5-5839`，基线 `ce9ac29cb`）。 |
| 20:32–20:33 | **#5892（#5828）合入 `e3b5b132d`**（26 项 SUCCESS、CLEAN）；#5828 关闭。**#5893（#5861）合入 `ae500f1a1`**（31 项 SUCCESS、CLEAN）；#5861 关闭。**#5839 B1 终审 MERGE**（wf_bb7795c7-a30：修复 `e73f114c1` 补夹具 SQL 证据参数盲，344 测试绿）→ 开 PR。 |
| 20:40–20:42 | **#5839 B2 终审 FIX**（wf_587cfb4b-8df）：命中「逐套绿整链红」——B2 堆在 B1 旧 tip 上，B1 反驳轮改了夹具 API，rebase 后 B2 spec 六处必红；处置：等 B1 落地后 rebase + 改 API + 复跑。**#5919（B3）合入 `afb4e44a5`**（28 项 SUCCESS、CLEAN）。GitHub 直连开始抖（TLS 超时/EOF），gh 命令改走 `socks5h://127.0.0.1:10808`。B1 派合 main 轮（`wf B1merge`）。 |
| 09-21 10:06 | **会话进程昨晚 20:4x 后退出**（原因未知，约 13h 空转）；所有工作流/监视/心跳随之消失。心跳已重建（`eb51785f`）。现状核实：main 已推进到 `5edf4c3e1`（另一会话夜间合了 #5903/#5914/#5916/#5917/#5920/#5922）；六条工作流用 `resumeFromRunId` 续起：B1merge、W6(#5835)、W7(#5829)、W8(migguard)、5842realdb、B5。222 昨夜部署窗口错过，R59 未做。 |
| 10:07 | #5873 工作树里已有未推的 `c41866932`（请求日志行还原 main 原文，覆写声明日志下沉到 method-override）+ 合 main `7dabe8083`，脏的是三张车道截图与换行噪音。派第三轮精简收尾 `wf_50045a7f-d23`：禁本地跑浏览器车道（前两轮停摆源头）、还原截图、核对守卫、推送。在飞七条：B1merge、W6、W7、W8、5842realdb、B5、5873r3。 |
| 10:10 | 心跳：#5873 第三轮 `wf_50045a7f-d23` 因参数被序列化成字符串（代理收到全 `undefined`）ABORT/BLOCK，零改动，已重派。CI 现状：#5924（B1 merge-main）DIRTY（等重跑）、#5921（B4）CLEAN 全绿（等 B1 落地后合 main）、#5915 `test(20.x)` 红（真库 429，修复中）、#5873 `5f60c1bb0` 红（第三轮中）、#5913 草稿 CLEAN。 |

本窗口未记录到 reclaude 隧道/网关中断（该类事件出现在窗口 8 段落，见 #5913 §5「环境与流程教训」）；本窗口唯一的网络异常是 20:42 起的 GitHub 直连 TLS 抖动，处置为切换 `gh` 走 `socks5h://127.0.0.1:10808`，未见影响工作流本身。

---

## 3. 产出清单

| PR / 项 | 状态 | 一句话 | 模型 | 验证方式 |
|---|---|---|---|---|
| [#5891](https://github.com/zensgit/metasheet2/pull/5891)（Closes #5838） | **已合**（`a93323343`，2026-09-20 19:07:50 CST） | 同步 `bulk-preview` 每行外发前复查表存活，删表后停止外发 | opus 实现 / opus 反驳×2（shape/behavior）/ opus 修复 / Fable 终审 | CI 27 项 SUCCESS + CLEAN + match-head `3eeb6a1b7`；内存级变异探针：删表用例 provider 调用次数由 1 变 3（复现 #5838 原 bug）；活表控制组存活查询数由 7 变 4 |
| [#5892](https://github.com/zensgit/metasheet2/pull/5892)（Closes #5828） | **已合**（`e3b5b132d`，2026-09-20 20:32:07 CST） | 遗留 `:sheetId` 路由补父表存活守卫，并把 `:sheetId` 绑定到 `:id` | opus 实现 / opus 反驳×2 / opus 修复 / Fable 终审 | 合 main（含 #5891）后：9 支套件 247 passed + 集成 29 passed + tsc 0 + 字节扫描 0；变异：GAP 下限 `>=5→6` 红（恰等 5）、拔掉 `egressStops`/`parentLivenessTables` 接线均红 |
| [#5893](https://github.com/zensgit/metasheet2/pull/5893)（Closes #5861） | **已合**（`ae500f1a1`，2026-09-20 20:33:12 CST） | 「使用模板」按 (租户,用户,模板,工作区,Base 名) 去重，窗口内重复安装返回同一个 Base | opus 实现 / 两位 hollow 评审 + 协调方 4 条 / opus 修复 / Fable 终审 | 23 例新增测试；变异探针全条红（D4/D4b/D9b/D12/D19/D20 等）；`generate:sdk` 重生成后与提交内容逐字节一致；**含迁移 `zzzz20260919140000_create_multitable_template_install_ledger`，上机须先跑 `migrate`** |
| [#5919](https://github.com/zensgit/metasheet2/pull/5919)（#5839 B3） | **已合**（`afb4e44a5`，2026-09-20 20:40:05 CST） | 关掉 4 个 univer-meta 处理器（prepare/export-xlsx/dry-run/attachments）的表存在性预言机，补行为级证据 | opus 守卫流水线（实现接手冻结前半成品 / 反驳 / 修复 / Fable 终审） | 新增 `multitable-sheet-existence-oracle-b3.test.ts` 26 cells；相关 13 套件 321 passed；变异逐条红（A_prepare 6红/B_export 8红+1红/C_dryrun 2红/D_attachments 2红+6红）；字节扫描 0 |
| [#5924](https://github.com/zensgit/metasheet2/pull/5924)（#5839 B1） | **进行中**（OPEN，head `871b44d2e`，mergeState BLOCKED，等 CI） | univer-meta 表配置族 11 条路由权限判定先于表行探测，未授权者对存活/软删/不存在的表同得 403 | opus 守卫流水线（实现 / 反驳 fixture+behavior / 修复 `e73f114c1` / Fable 终审 MERGE） | 终审已判 MERGE（`bb7795c7-a30`）：11 文件 344 测试绿、tsc 0、字节扫描 0；合 main（含 B3 #5919）解一处冲突（账本 28−11−4=13 条，合并后实测 13），等长尾 CI 跑完即可合入 |
| [#5921](https://github.com/zensgit/metasheet2/pull/5921)（#5839 B4） | **进行中**（OPEN，head `855e5abe2`，mergeState **CLEAN**，等 B1 落地后合 main 重跑） | 记录权限两条事务路由的表存活判定移到权限判定之后，values-free 拒绝 | opus 守卫流水线（反驳 6 条全修 / Fable 终审 MERGE `wf_0a60ccab-bc8`） | 新 spec 9→13 例，8 files/206 tests 全绿、tsc 0、字节扫描 0；变异探针 5 条全红（挪回 403 前→12 红等）；接受一条已定档 RESIDUAL（审批投影 base 内仍可辨 present/absent） |
| [#5915](https://github.com/zensgit/metasheet2/pull/5915)（Closes #5842） | **进行中**（OPEN，head `a6ffdcd24`，mergeState BLOCKED，`test(20.x)` 红 30m15s） | 批量任务提交阶段独立状态 `committing` + 身份化认领 `commit_claim_id`，取消后不再外发已取消行 | opus（反驳 race/hollow 17 条 8 major）/ Fable 终审 MERGE（`dd5aa9d4a`） | 20 项内存级变异全红、0 存活；本地 125+72 测试绿、tsc 0、vue-tsc 0、字节扫描 0；合 main 后仍绿；**真库集成 CI 红**（commit re-gate stale_reprev 第二次 commitJob 得 429 非 200），第三轮修复中（`5842realdb` 工作流） |
| [#5873](https://github.com/zensgit/metasheet2/pull/5873) | **进行中**（OPEN，head `5f60c1bb0`，mergeState BLOCKED，`test(18.x)`/`test(20.x)` 红） | DELETE 方法覆写中间件 + 前端 DELETE 传输自动回退（客户出网丢弃 DELETE，客户反馈 #1/#4） | opus 实现 / opus 反驳×2 / Fable 终审（两轮 FIX） | 三条浏览器车道 6/29/17 全绿、web 73、backend 18；第二轮根因定位为浏览器 harness 模块路径命中 `**/api/**` 通配；未推提交 `c41866932` + 合 main `7dabe8083` 待第三轮推送（10:10 心跳：第三轮因代理参数序列化 bug 中止，已重派） |
| [#5913](https://github.com/zensgit/metasheet2/pull/5913) | **进行中**（OPEN，draft，CLEAN） | 第八次 36h 窗口设计与验证记录草稿（本窗口内开出，内容记录窗口 8） | sonnet 草稿 | 11 处待补，收尾时转正式；与本文互引 |
| #5839 B2 | **待开 PR**（无 PR 号，堆在 B1 旧 tip `5856d05b3`） | 字段/视图/导入/汇总族 8 条纯删（config-history 摘出） | sonnet 实现 / opus 反驳 / Fable 终审 | 终审曾判 FIX：8 条删除 + 44+ 例自身实（197/197、变异成立），但反驳夹具 API 与 B1 落地后不一致，需 `rebase --onto origin/main 5856d05b3` + 改 6 处夹具 API + 复跑 + 终审（`findings/B2-rebase.json` 已备），等 B1（#5924）落地 |
| #5839 B5 | **待开 PR**（`wf_23c2be3f-723`，wt-b5-5839，基线 `ce9ac29cb`） | submit + PATCH 提交阶段账本清零批（匿名 401 / 已登录无权限 403 分层） | opus 守卫流水线 | 进行中；只删自己 2 条账本串，清零由最终合 main 轮做 |
| #5835（W6） | **待开 PR**（`metasheet-wt-w6-5835`） | 售后插件对象表已删时静默回退到推导表 id | opus 守卫流水线（实现 / 反驳 callers+hollow / Fable 终审） | 进行中，`resumeFromRunId` 续跑 |
| #5829（W7） | **待开 PR**（`wt-w7-5829`） | 旧版 spreadsheet-permissions 三条路由补表存活 + `canManageSheetAccess` | opus 守卫流水线 | 进行中，`resumeFromRunId` 续跑 |
| 迁移时间戳唯一性守卫（W8） | **待开 PR**（`wt-w8-migguard`） | 迁移时间戳唯一性守卫，允许清单钉住既有 12 组 + #5893/#5915 的 `20260919140000` 对 | sonnet 实现 / opus 反驳 | 进行中，`resumeFromRunId` 续跑 |

---

## 4. 模型分派规则与实际分派

**固定规则**（`PLAN-24h-20260920.md`）：
- sonnet = 只读调研、机械改动、文档、开 issue。
- opus = 实现（impl-hard）与反驳（refuter）。
- Fable（会话模型）= 终审（security-judge）与挑漏。

**流水线形态**：
- **守卫流水线**（`wf-guarded-fix.js`）：实现 → 反驳 ×2 → 修复 → 终审。本窗口用于 #5891/#5892/#5893/#5919/B1/B3/B4/B5/W6/W7 等全部触及授权、存活性判定、写路径的改动。
- **精简修复流水线**（`wf-fix-judge.js`）：修复 → 终审，读预置 findings 文件。用于 #5842（接管修复轮，输入 findings/5861.json + CI 红定性）、#5873 各轮修复。
- **sonnet 实现版守卫流水线**（`wf-guarded-fix-sonnet.js`/`wf-guarded-fix-sonnet-b2.js`）：sonnet 实现 / opus 反驳 / Fable 终审。用于 B2（低风险的纯删除批次）、W8（迁移时间戳守卫）实现侧。
- **只读调研**（多代理）：用于 W4（sonnet×2 开 issue）、W5（opus 核对方案 + Fable 挑漏 + sonnet 发评论，wf_5bd2a5ef-aeb）。

**实际分派对照**：#5893（opus 实现，两位 hollow 评审）、#5915/#5842（opus 反驳 race/hollow，Fable 终审）、B4（opus 守卫流水线，Fable 终审 `wf_0a60ccab-bc8`）均按 opus 承担实现与反驳、Fable 承担终审的分工执行；文档（本文、#5913）与开 issue（W4）由 sonnet 承担，与计划一致。

---

## 5. 验证方法

**合并协议**（沿用第八次窗口，见 §1）：全部检查 SUCCESS（SKIPPED 允许）+ `CLEAN` + `--match-head-commit`；守卫/边界类 PR 必过反驳 ×2 + Fable 终审；不用 `--admin`；不跑 `vue-tsc -b`；开 PR 前字节扫描（`grep -nP '[\x00-\x08\x0b\x0c\x0e-\x1f]'`）。四支已合 PR 的 CI 项数：#5891 27 项、#5892 26 项、#5893 31 项、#5919 28 项，均 SUCCESS + CLEAN + match-head。

**五类漏法终审**（[[adversarial-verify-guarantee-prs]] 的框架：假件背书 / 守卫没接线 / 边界无强制 / 逐套绿整链红 / 触发与边界不同量）在本窗口的具体命中：
- **逐套绿整链红**：B2 堆在 B1 旧 tip 上，B1 反驳轮 `e73f114c1` 改了夹具 API（`sqlLog→calls`、`capabilitySqlFor→capabilityCallsFor`、`beyondCapability` 签名），B2 rebase 到新 tip 后六处 spec 必红（20:40 条目）——本身通过、依赖的夹具变了，套件对不上，不是 B2 代码退化。
- **假件背书**：#5893 反驳第 2 条钉住 `x-tenant-id` 免疫的假件盲区（harness 从不设 `req.user.tenantId`）；#5915 反驳（race/hollow）第 1 条抓到集成测试导入已删函数 `setHeaderRunning`，让假绿的引用面暴露。
- **边界无强制**：#5919 反驳点名 dry-run 分支「注释宣称不存在的守卫」（危险半态：只删探测未补拒绝），修复轮补齐 (c)(d) 两分支的真实拒绝。
- **触发与边界不同量**：B1 反驳（fixture 镜头）抓到 SQL 证据参数盲——「改错 id 仍绿」，夹具没记录实际传入的 SQL 参数，无法证明拒绝确实针对被寻址的那张表；修复轮 `e73f114c1` 改为记录 `{sql, params}` 并断言参数带本表 id。

**内存级变异探针**：全部 PR 的变异证据均在内存里做（vite `transform` 钩子改写模块文本或守卫的 `readSource()`，磁盘上的文件字节不动），控制组先验证绿，再逐条改写守卫/实现观察是否转红。典型例子：#5892 把 `PARENT_LIVENESS_TABLES` 条目改指别的文件（机制未接线）→ 3 处结构化断言红；#5915 合并后删掉三处停发接线（worker 取消检查 / worker 存活停发 / bulk-preview 存活停发）逐条验证均转红，证明合并后两侧接线都还在。

**CI 长尾**：本窗口六条 PR 的长尾检查均落在 `test(20.x)`（真库集成泳道）。#5919/#5892/#5893 各剩 1 项、#5921 2 项、#5924 3 项、#5915（新头 `a6ffdcd24`）4 项——多数为等待执行，唯一真正的红是 #5915：`multitable-ai-bulk-job.test.ts` 里的 commit re-gate 用例只有真库才暴露（上一次提交认领没有 finish/release，任务停在 `committing`）。

**各 PR 正文验证表要点摘录**：
- #5891/#5892：新增行为测试走 `usePinnedServer()` + `request(pinned.url())`（tests/unit 禁 `request(app)`，#4154），并对每次拒绝断言「网关之下什么都没跑」（记录 SQL 调用账本为空）。
- #5893：`hashtextextended($1, 0)` 参数补 `::text`；三条新 SQL 语句形状由 D20 逐条钉死；真 Postgres 泳道未做，登记为 owner 项（本仓 real-DB 只能靠独立 workflow 文件，推分支的 token 无 `workflow` scope）。
- #5919：新增 spec 自带 fake pool（SELF-CONTAINED），直接建模 `deleted_at` 并回答真正的解析器读，避免"只答旧查询"的 fixture 把存活性从已不再跑的探针里翻译出来。
- #5924（B1）：`grep '\bsheet\.'` 改前改后各验一次 = 0 命中，确认被删的局部变量确无其它引用。
- #5915（#5842）：状态机表以「唯一写 `status` 列的地方」为单位逐条列出 entered by / leaves to，并对每个消费点做 UPDATED/UNAFFECTED 两类穷举扫描（含跨表误伤检查，如 `workflow-job-contract.ts` 的枚举确认未被误宽）。

---

## 6. #5839 五批进展与账本清零路径

issue #5839（`GET/PUT/POST` 等 univer-meta 多个路由「先查表行回 404 再判权限」，未授权者能分辨表是否存在或已删）拆成 B1–B5 五批，账本基线 28 条（`EXISTENCE_BEFORE_AUTHORITY_GAP.handlers`）：

| 批次 | 内容 | 状态 | 账本变化 |
|---|---|---|---|
| B1 | 表配置族 11 条纯删（含夹具 `tests/utils/sheet-existence-oracle.ts`） | 终审 MERGE，PR #5924 待合 main 长尾 CI | 28 → 17 |
| B2 | 字段/视图/导入/汇总 8 条纯删 | 终审曾判 FIX，因 B1 改夹具 API 需 rebase + 改 6 处 API，**无 PR 号** | 计划 −8 |
| B3 | 需补/搬拒绝 4 条（prepare/export-xlsx/dry-run/attachments） | **已合**，PR #5919，`afb4e44a5` | 已生效 −4（与 B1 合并后实测 13） |
| B4 | 事务内记录权限 2 条 | 终审 MERGE，PR #5921（CLEAN，等 B1 落地后合 main 重跑） | 计划 −2 |
| B5 | submit + PATCH（账本清零批，最后合） | 进行中（`wf_23c2be3f-723`），**无 PR 号** | 计划 −2 |

**后落者合 main 规则**（各 PR 正文一致写明）：B1 先落，其余批次依次 `rebase --onto origin/main <B1 旧 tip>` 或 `git merge origin/main`，保留 main 数组、只删自己那一批的账本字符串，重新核对总数。B3 已实证：合并后 `28 − 11(B1) − 4(B3) = 13`，与合并后实测账本条数逐位相符。

**账本清零路径**：五批全部落地后，账本理论剩余 `28 − 11 − 8 − 4 − 2 − 2 = 1`，即唯一保留项 `GET /sheets/:sheetId/config-history`（issue #5910，owner 待裁决是否收窄；本窗口内不动）。issue #5839 本身待五批全部合入 main 后关闭。

---

## 7. 客户反馈九条对照表

来源：`docs/development/takeover-beiliao-20260821/customer-anomaly-triage-20260918.md`。本窗口内无一条新裁定，仅推进已立案项到合并；**本窗口无上机，R59 因部署窗口错过未做，222 上无一条本窗口改动**。

| # | 客户描述 | 对应 issue/PR | 主干状态 | 222 状态 |
|---|---|---|---|---|
| 1/4 | 删除整个表/记录/模板报「无法连接服务器」（DELETE 被客户侧丢包） | #5873 | 进行中（评审中，第三轮修复） | 未上 |
| 2 | 自动化「发送通知」测试运行报 NO_RECIPIENTS（编辑器 dirty 时未保存） | #5867 | 已合（窗口前，`b4e728d88`） | 未上 |
| 3 | 层级 0 根选择规则（图号模式待确认） | #5874 | 已合（窗口前，2026-09-20T00:28:57Z） | 未上 |
| 5 | 「使用模板」无幂等，重复点击出现多个同名 Base | #5893 | 已合（本窗口，`ae500f1a1`，2026-09-20 20:33:12 CST） | 未上 |
| 6 | 字段类型只支持文本↔长文本；面板高度不可调 | #5864 | 设计（方案评论已发，issuecomment-5749356499，含 10 条待讨论问题，**未实现**） | 未上 |
| 7 | 冻结只有列没有行；冻结列后首行被固定 | #5875 | 已合（窗口前，2026-09-20T00:29:16Z） | 未上 |
| 8/9 | 换项目号重拉后三个视图仍显示旧项目行 | #5868 | 已合（窗口前，2026-09-18T11:37:16Z） | 未上 |

窗口开始时（18:40 条目）已合 4 条（#2/#3/#7/#8-9），窗口内新增合入 1 条（#5，#5893），评审中 1 条（#1/4，#5873），设计 1 条（#6，#5864 方案已发未实现）。

---

## 8. 未完成与交接

| 项 | 状态 | 说明 |
|---|---|---|
| R59（222 上机） | **未做** | 昨夜 20:4x 会话进程退出，18:00–08:00 部署窗口整段错过；09-21 08:00–18:00 是禁发时段，窗口剩余时间内不再有可用部署窗口 |
| B2/B5 落地 | 进行中 | B2 需等 #5924（B1）落地后 rebase + 改 6 处夹具 API；B5（`wf_23c2be3f-723`）独立进行中，最后合 |
| #5915 真库 429 | 进行中 | commit re-gate 用例在真库暴露认领 finish/release 缺口，`5842realdb` 工作流第三轮修复中 |
| #5873 收尾 | 进行中 | 第三轮 `wf_50045a7f-d23` 首次因代理参数序列化 bug 中止（零改动，已重派）；本地已有未推提交 `c41866932` + 合 main `7dabe8083` |
| #5924（B1）合 main 长尾 CI | 进行中 | 终审已判 MERGE，等 CI 跑完（10:10 心跳记为 DIRTY，随后复检为 BLOCKED，属波动） |
| #5921（B4）等 B1 落地后合 main | 进行中 | 当前 CLEAN 全绿，B1 落地前不合并（同改账本数组，避免冲突） |
| W6/W7/W8 | 进行中 | `resumeFromRunId` 续跑中，均无 PR 号 |

**owner 待裁决项**（本窗口内新增或复述自 PR 正文，均未由本窗口自行拍板）：
- #5893：缺表时 fail-open 还是 503；300s 窗口长度（锚 nginx `proxy_read_timeout`，未实测有无余量）；15s 锁等待上限；客户机上跑迁移的时机；真 Postgres 泳道缺失（token 无 `workflow` scope）。
- #5839：8 项裁决（详见 `scratchpad/5839/plan-r2.md`）——①错误码/消息对客户端可见变更、②submit 公开入口 404→401/403、③config-history (i)/(ii)、④attachments 500→404、⑤PATCH 残留、⑥throw 路径码变、⑦⑧视图侧具名残留。B1 已按①落地（values-free 404）；③（config-history）独立开 issue #5910 待裁。
- #5864：10 条待讨论问题（第一批配对范围、自动建选项上限、置空 vs 整体拒绝、撤销窗口、谁能跑、预检是否强制、开关默认、面板高度是配置区还是外框、两条 API 缝是否收紧、插件 `ensureFields` 是否同链）。

---

## 9. 教训

- **工作流随会话进程退出而消失，恢复靠 journal 缓存 + `resumeFromRunId`。** 昨夜 20:4x 后会话进程退出，约 13h 空转，所有工作流/监视/心跳随之消失；09-21 10:06 恢复后，六条在飞工作流均用 `resumeFromRunId` 续起（未从零重派），确认 journal 缓存跨会话进程存活。
- **同模型才命中 `resumeFromRunId` 缓存。** 与 [[workflow-resume-after-model-switch-reruns-live]] 一致：本窗口恢复时会话模型未切换，六条工作流均正常续跑；这条记忆里记录的"模型切换后整段重跑"风险本次未触发，但仍需在下次唤醒前核对会话模型与工作流派出时是否一致。
- **浏览器车道本地跑易停摆，交 CI。** #5873 前两轮修复都因本地跑浏览器车道（attendance/stock-prep Playwright harness）而停摆，第三轮精简收尾（`wf_50045a7f-d23`）明确禁止本地跑浏览器车道，改为只做文本/守卫核对后直接推送。
- **估算时间戳必须先跑 `date`。** 20:22 CST 条目明确记录：此前标注 20:05–20:50 的几条账本时间是估算，实际提前约 25–35 分钟；此后账本条目一律先跑 `date` 再落笔（与 [[clock-drift-run-date-before-writing-times]] 一致）。
- **GitHub 直连抖动走 socks5。** 20:42 起 GitHub 直连出现 TLS 超时/EOF，`gh` 命令随即切换到 `socks5h://127.0.0.1:10808`；本文撰写时同样按此前缀调用 `gh`（与 [[github-egress-needs-local-proxy]] 一致）。
- **代理参数序列化可能整体丢参。** #5873 第三轮工作流首次派出时因参数被序列化成字符串（代理收到全 `undefined`）触发 ABORT/BLOCK；代理判断正确（零改动），但暴露了派单通道本身的一个脆弱点，值得在后续窗口留意同类"首句即空"的信号。

---

*基线：账本 `claude-auto24/STATE.md`「## 2026-09-20 18:15 第九次窗口（24h）开始」至文件末尾（撰写时点约 2026-09-21 10:15 CST）；PR/issue 数据经 `gh pr view/checks`、`gh issue view` 现场核对，均标注截至时点。窗口尚未结束，第 3/8 节列出的进行中项可能在窗口收尾前变化，届时按定稿流程更新本文。*
