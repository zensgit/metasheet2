# 第九次自主开发窗口（24h）2026-09-20 → 09-21 设计与验证记录

与 `docs/development/takeover-beiliao-20260821/autonomous-36h-run-20260918.md`（PR #5913，草稿）是相邻窗口：#5913 记录第八次 36h 窗口（09-18 18:55 → 09-20 06:55，及其会话恢复后延续到 09-20 18:20 的收尾）自身的执行，本文只记录第九次 24h 窗口（09-20 18:15 起）的授权、执行与产出，两文不重复对方内容。

状态：**定稿**（本地定稿时点 2026-09-21 16:14 CST，`TZ=UTC-8 date` 核对）。15:34 CST 起本机两条代理与直连均到不了 GitHub 与 reclaude 网关（见 §2 / §9），本文依据账本 `claude-auto24/STATE.md`「## 2026-09-20 18:15 第九次窗口（24h）开始」至文件末尾一段，以及断网前已用 `gh pr view` / `gh pr checks` 核对过的现场落笔；断网后未再核对的项在 §3/§8 标「截至 15:34」。窗口 18:15 CST 结束；#5947 / #5948 / #5807 三项若在恢复网络后落地，在本 PR 里补一行，不另开文。

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
| 10:18 | **W8 终审 MERGE**（`wf_38f1a060-00a`：反驳咬住「钉住对在只落一个的中间态判红，而这正是当前 main 状态」，修复引入 `PENDING_PAIRS` 分级，终审用真实 `origin/main` 清单探针实证）→ 开 PR。24h 交付文档草稿推送 `7448a5e2f`（189 行）→ 草稿 PR #5930（本文）。 |
| 10:21 | **B1 合 main 完成 `871b44d2e`**（`wf_58565d4a-0c0`：唯一冲突在账本数组，两侧各保留对方要删的行；账本 28−11−4=13，提交 blob 重数=13；变异放回任一串双向红；终审 11 套件 355/355、MERGE；点名未看路径 `GET /sheets/:sheetId/trash`）。 |
| 10:31 | **#5915 真库 429 归因推翻**（`wf_ddda204c-281`）：不是 committing 状态未释放，是提交路由 `:1413` 的 E-10 突发限流器（`tenantBurstRpm` 默认 30、按用户 id 60s 固定窗）——集成套件按执行序发出的第 31 个请求恰好命中 commit 调用；修复 `8bf0f1044` 把集成夹具的租户突发预算调高并新增预算门专用测试，未放宽任何拒绝断言；附带发现 stale-claim 回收经 HTTP 不可达，登记待裁。 |
| 10:37 | **W6 终审 MERGE**（`wf_a65fe7a4-e73`：反驳咬住「已删除提示建议重新开通」与 `ensureSheet` 对软删表必抛矛盾；修复 `0aabe1a3d` 改提示指向恢复 + 21 处路由 catch 译成 409 三态引导）→ 开 PR。 |
| 10:51 | **#5924（B1）合入 `0714f0a3f`**（28 项 SUCCESS、CLEAN、match-head `871b44d2e`）；派 B4 合 main（账本 13→11）与 B2 `rebase --onto` 移植夹具 API（账本 →5）。 |
| 10:55 | **#5929（W8 迁移时间戳唯一性守卫）合入 `3ced939ef`**（26 项 SUCCESS、CLEAN、match-head `9c1730408`）。 |
| 11:00 | **#5873 第三轮终审 MERGE 并合入 `2ab346bf0`**（本轮零源码改动，只推此前未推的提交 + 合 main；真因锁定为第二轮请求日志 if/else 分支多出一个 `this.logger` 造出两个 ancestor-KIND key，冻结清单 50 一字未动；CI 32 项全绿）。客户反馈 #1/#4 至此落主干。 |
| 11:07 | **#5915（#5842）合入 `8d5b1fdd5`**（30 项 SUCCESS、CLEAN、match-head `8bf0f1044`）；含迁移 `zzzz20260919140000_ai_bulk_job_commit_phase_claim`，上机须先跑 migrate。 |
| 11:16 | **B2 rebase 终审 MERGE**（`wf_309c0c7f-1f7`：只重放 B2 三提交、账本 13→5、夹具 API 逐参数级移植）→ 开 PR #5935；终审点名未看路径 `GET /context` 别名多行查询绕过 `EXISTENCE_PROBE` 致账本漏计 → 开 issue #5936。**B4 合 main 终审 MERGE**（`wf_b5e04862-de2`：账本 13→11，三批 diff 逐字节存活，变异 A/B/B1/C 全红）。 |
| 11:21 | 36h 文档（#5913）定稿：11 处待补按 `gh` 现场核实填齐（核查 5/5 ok），合 main 无冲突，等 CI。 |
| 11:22 | **#5934（W6 #5835）合入 `569042ed3`**（26 项 SUCCESS、CLEAN、match-head `0aabe1a3d`）。本窗口累计已合 9 支。 |
| 11:29 | **W7（#5829）终审 FIX（仅注释级）**（`wf_f56b277b-1e3`：反驳 8 条全修——删残留 scratch 探针、GAP 下界按当前 main 重算为 2、FK 指向 `meta_sheets` 确认、三路由零调用方；变异 AUTH 5 红 / GATE_ALL 12 红）→ 派 sonnet 注释更正轮。 |
| 11:38 | **B5 终审 MERGE**（`wf_23c2be3f-723`：反驳 7 条全处置，变异 A/B 各 7 红、C/D/E 各 1 红；`b9c16ff7c`）→ 开 PR #5939。#5839 五批全部有 PR：B1/B3 已合，B2/B4/B5 在 CI，三者同改账本数组，需两轮后落者合 main。 |
| 11:40 | **W7 注释更正完成 `ff766b731`**（核查 5/5 ok）→ 开 PR。跟进 issue #5937（退役旧版 spreadsheet-permissions 三路由）、#5938（grant/revoke 事务内复检 `deleted_at`）。 |
| 11:46 | **#5921（B4）合入 `d18e1e03b`**（28 项 SUCCESS、CLEAN、match-head `b19901ab2`）；#5839 已合 B1/B3/B4（17 条）。 |
| 11:47 | #5913 `test(20.x)` 红判定为运行机抖动（`multitable-automation-dispatch-loop-realdb` 心跳租约毫秒计时断言，与改动无关）→ 已 `gh run rerun --failed`。**W7（#5829）→ PR #5940**。 |
| 12:16 | **#5864 有回复**（zensgit，2026-09-21T04:12Z，设计审阅非拍板）：语义改为「先保留内容再由用户整理」、组合碰撞整次拒绝、只为实际组合建项、确认凭证绑定完整计划哈希、撤销需完整前镜像等要点 → 派方案 v2 工作流（opus 揉入反馈并按当前 main 核对 → Fable 挑漏 → sonnet 回帖）。 |
| 12:18 | **#5940（W7 #5829）合入 `e19855765`**（CLEAN、match-head `ff766b731`）。本窗口累计已合 10 支。 |
| 12:32 | **B2 再合 main 完成 `955172ca4`**（`wf_e5f4c539-ab6`：账本恰 3 条，与 B4 三处逐字节同行同字，diff-of-diffs 逐字相同；终审 MERGE；点名零测试路径）。**#5913（36h 文档）合入 `c5547aad3`**（重跑后 21 项 SUCCESS、CLEAN）。本窗口累计已合 11 支。 |
| 12:50 | **#5864 v2 已回帖**（issuecomment-5755544758：v1 矩阵作废、写入栅栏与前镜像捕获两 flag 默认关闭 fail-closed、三端点统一 `canManageFields`、多选→单选后置、Time Machine 四测试进 -realdb 车道等 10 处挑漏已吸收）；留 8 个 owner 待答问题，最卡排期的是首批配对范围 + 自动建选项上限。 |
| 12:56 | 队列 W1–W8 已尽，不空转：新派两条守卫流水线——**#5938**（grant/revoke/PUT permissions 事务内复检 `deleted_at`，`wt-w9-5938`，分支 `fix/sheet-permissions-txn-liveness-recheck`）、**#5936**（`GET /context` 探测先于 403 + `EXISTENCE_PROBE` 扩别名多行，`wt-w10-5936`，分支 `fix/univer-meta-context-existence-oracle`）；均进行中，尚无 PR。 |
| 12:57–12:58 | 心跳无新结果。#5930 草稿由 sonnet 刷新到 12:57 状态并推送 `66f8fe72c`。 |
| 13:04 | **#5864 owner 第二轮复审到达**（issuecomment-5755647175）：方向已收敛，四条修改（P1 空值四态精确撤销 / P1 撤销遇新增删除改配置整次拒绝 / P1 账本边界不等于通用账本扩展 / P2 数字字面量判据撤回）+ 收敛方式（首批 文本→单选/多选 完整文本一项、多选→单选后置、只读预检可先合、UI 等执行+撤销验收、默认 OFF、无强制覆盖、保留 PATCH 拒绝回归）。→ 派 v2.1 修正稿流水线 `wf_66582f43-842`（opus 起草 → Fable 挑漏 → opus 修正，只出稿不发帖）。 |
| 13:09 | **#5935（B2）合入 `565fa5dd5`**（28 项全绿 CLEAN、match-head `955172ca4`）。→ 派 B5 合 main 轮 `wf_42c51c48-557`。 |
| 13:29 | 用户在线，问 #5864 回复与其它待回复。全库 GraphQL 扫描 91 issue / 305 PR：最后一条来自 owner 且我方未回的近期真项 = #5864、PR #5609（09-15 考勤线交接「请你们裁」）、#5807（09-16 People 表绕过 50 条上限，零评论）、#5943（当日 P3 文案讨论）；其余为 Codex 车道核验记录或封存线，不回。首次逐条 REST 拉取 540s 超时，改 GraphQL 分页后约 2 分钟。 |
| 13:35 | **B5 合 main 轮完成 `fb3a3e940`**：唯一冲突在账本数组，保留 main 3 条只删自己 2 条 → 终态 1 条；diff-of-diffs 只含 B5 三文件；8 套 256 + 集成 2/33 + tsc 绿；内存变异 3/3 红；终审 MERGE；遗留既有 bug（PATCH 走 `resolveMetaSheetId` 视图错表抛未捕获 ConflictError → 500）→ 后开 #5946。 |
| 13:42 | **#5807 分诊已回帖**（issuecomment-5755929332）：五主张四条成立、「同步写邮箱」已被 #5816 修掉但存量行仍带邮箱；建议首刀 flag-free「同一把尺子」（People 表枚举读钳 50 且不许翻窗、导出 403，门不动）；留 owner 一问。**#5946 已开**（sonnet）：`resolveMetaSheetId` 的 ConflictError 10 处调用 7 处不捕获 → 500、3 处捕获但回显 id。 |
| 13:45 | **#5943 已回**（同意 owner 处置，不投入开发）。**PR #5609 只读评审派出** `wf_5c8e8e02-646`（反驳×2 → Fable 终审；owner 账号分支，不推提交）。 |
| 13:58 | **#5864 v2.1 已回帖**（issuecomment-5756043523，7.5k 字，挑漏 12 项吸收：偷换点改回「A/B 两轮未拍板、仍建议 A」、撤销回写路径钉原生 jsonb UPDATE、四态验收补值相等与 revision patch 的 null 哨兵、账本候选 (a) 加范围提示、九问现状表）。 |
| 14:09 | **#5939（B5）合入 `e15a6e315`**（28 项全绿 CLEAN、match-head `fb3a3e940`）。**#5839 五批全部落地，账本 28 → 1**，issue 关闭并列出残留编号（#5910 / #5908 / #5911 / #5936 / #5946）。主检出 ff 到 `e15a6e315`。 |
| 14:12 | **PR #5609 裁决已回帖**（issuecomment-5756151958）：合、但先补四项（rebase 解法 A、合同 spec 三钉、隔离步骤挪到最后 + worker 参数、文案统一 67）；拆大文件现在不做。反驳者实证：顶层/job 级 env 变异 24/24 假绿、改 run 指向别的 spec / 加回 token 双跑均全绿、最自然的冲突解法 C 合并后 26/26 绿但文件跑两次。 |
| 14:16 | **开 draft PR**：**#5947**（#5938，修复轮 head `272e9c9d1`）、**#5948**（#5936，head `b6b41702a`）。 |
| 14:45 | 用户要求加快。#5948 合 main 干跑零冲突（不需再派合 main 轮）；派 **#5807 首刀**守卫流水线 `wf_a37eb6ec-9cb`（`wt-w11-5807`，分支 `fix/people-sheet-read-bound`，基线 `e15a6e315`）；#5946 因与 #5948 同区域，等其落地再派。 |
| 14:51 | 发现心跳 cron 重复两份（进程重启后重建），删 `c908d411` 保留 `eb51785f`。 |
| ~14:55 | **#5947 终审 MERGE**（无必改代码；六条正文注记：sheet_config 两站锁强度由隐含 FOR NO KEY UPDATE 升为 FOR UPDATE、revert 分支复检先于 preview-identity、守卫按 AST 文本位置度量、`record_permissions` 门已由 FOR SHARE + 事务内存活读关闭、两处具名残余待开 issue）。CI 28 项全绿 CLEAN。 |
| 15:34 | **网络中断**：socks5h 10808 / http 52520 / 直连到 api.github.com 全部 000，reclaude 网关同时 EOF。#5947 的正文更新 / ready / merge 三步全部 EOF 未成；#5948 CI 在 `b6b41702a` 全绿 CLEAN 但修复轮与终审卡在网关。带 60s 超时的重试循环把 14:55→15:44 全耗掉。 |
| 16:10 | 探针到期仍断（36 分钟）。应急：主会话本地定稿本文并本地提交，网络恢复后再推。 |

本窗口的网络异常两段：① 20:42 起 GitHub 直连 TLS 抖动，处置为 `gh` 走 `socks5h://127.0.0.1:10808`；② 15:34 CST 起两条代理与直连全部到不了 GitHub，reclaude 网关同时 EOF（`daemon.log` 逐分钟 tunnel error），持续到本文定稿仍未恢复——这不是 GitHub 单点，是本机出网上游。本机代理进程仍在监听（10808），未动任何网络 / 系统设置。

---

## 3. 产出清单

| PR / 项 | 状态 | 一句话 | 模型 | 验证方式 |
|---|---|---|---|---|
| [#5891](https://github.com/zensgit/metasheet2/pull/5891)（Closes #5838） | **已合**（`a93323343`，2026-09-20 19:07:50 CST） | 同步 `bulk-preview` 每行外发前复查表存活，删表后停止外发 | opus 实现 / opus 反驳×2（shape/behavior）/ opus 修复 / Fable 终审 | CI 27 项 SUCCESS + CLEAN + match-head `3eeb6a1b7`；内存级变异探针：删表用例 provider 调用次数由 1 变 3（复现 #5838 原 bug）；活表控制组存活查询数由 7 变 4 |
| [#5892](https://github.com/zensgit/metasheet2/pull/5892)（Closes #5828） | **已合**（`e3b5b132d`，2026-09-20 20:32:07 CST） | 遗留 `:sheetId` 路由补父表存活守卫，并把 `:sheetId` 绑定到 `:id` | opus 实现 / opus 反驳×2 / opus 修复 / Fable 终审 | 合 main（含 #5891）后：9 支套件 247 passed + 集成 29 passed + tsc 0 + 字节扫描 0；变异：GAP 下限 `>=5→6` 红（恰等 5）、拔掉 `egressStops`/`parentLivenessTables` 接线均红 |
| [#5893](https://github.com/zensgit/metasheet2/pull/5893)（Closes #5861） | **已合**（`ae500f1a1`，2026-09-20 20:33:12 CST） | 「使用模板」按 (租户,用户,模板,工作区,Base 名) 去重，窗口内重复安装返回同一个 Base | opus 实现 / 两位 hollow 评审 + 协调方 4 条 / opus 修复 / Fable 终审 | 23 例新增测试；变异探针全条红（D4/D4b/D9b/D12/D19/D20 等）；`generate:sdk` 重生成后与提交内容逐字节一致；**含迁移 `zzzz20260919140000_create_multitable_template_install_ledger`，上机须先跑 `migrate`** |
| [#5919](https://github.com/zensgit/metasheet2/pull/5919)（#5839 B3） | **已合**（`afb4e44a5`，2026-09-20 20:40:05 CST） | 关掉 4 个 univer-meta 处理器（prepare/export-xlsx/dry-run/attachments）的表存在性预言机，补行为级证据 | opus 守卫流水线（实现接手冻结前半成品 / 反驳 / 修复 / Fable 终审） | 新增 `multitable-sheet-existence-oracle-b3.test.ts` 26 cells；相关 13 套件 321 passed；变异逐条红（A_prepare 6红/B_export 8红+1红/C_dryrun 2红/D_attachments 2红+6红）；字节扫描 0 |
| [#5924](https://github.com/zensgit/metasheet2/pull/5924)（#5839 B1） | **已合**（`0714f0a3f`，2026-09-21 10:50:49 CST） | univer-meta 表配置族 11 条路由权限判定先于表行探测，未授权者对存活/软删/不存在的表同得 403 | opus 守卫流水线（实现 / 反驳 fixture+behavior / 修复 `e73f114c1` / Fable 终审 MERGE） | 终审判 MERGE（`bb7795c7-a30`）后合 main（`871b44d2e`：账本 28−11−4=13，两侧变异互证，点名未看路径 `GET /sheets/:sheetId/trash`）；11 文件 344 测试绿、tsc 0、字节扫描 0；28 项 SUCCESS + CLEAN + match-head `871b44d2e` |
| [#5921](https://github.com/zensgit/metasheet2/pull/5921)（#5839 B4） | **已合**（`d18e1e03b`，2026-09-21 11:45:45 CST） | 记录权限两条事务路由的表存活判定移到权限判定之后，values-free 拒绝 | opus 守卫流水线（反驳 6 条全修 / Fable 终审 MERGE `wf_0a60ccab-bc8`） | 新 spec 9→13 例，8 files/206 tests 全绿、tsc 0、字节扫描 0；B1 落地后合 main（`wf_b5e04862-de2`：账本 13→11，三批 diff 逐字节存活，变异 A/B/B1/C 全红，13 套 383 绿）；28 项 SUCCESS + CLEAN + match-head `b19901ab2`；接受一条已定档 RESIDUAL（审批投影 base 内仍可辨 present/absent） |
| [#5915](https://github.com/zensgit/metasheet2/pull/5915)（Closes #5842） | **已合**（`8d5b1fdd5`，2026-09-21 11:07:21 CST） | 批量任务提交阶段独立状态 `committing` + 身份化认领 `commit_claim_id`，取消后不再外发已取消行 | opus（反驳 race/hollow 17 条 8 major）/ Fable 终审 MERGE（`dd5aa9d4a`） | 20 项内存级变异全红、0 存活；本地 125+72 测试绿、tsc 0、vue-tsc 0、字节扫描 0；**真库 429 归因推翻**——非 committing 未释放，是提交路由 E-10 突发限流器（`tenantBurstRpm` 默认 30/60s）在集成套件第 31 个请求命中；修复 `8bf0f1044` 调高夹具突发预算 + 新增预算门专用测试，未放宽拒绝断言；30 项 SUCCESS + CLEAN + match-head `8bf0f1044`；**含迁移 `zzzz20260919140000_ai_bulk_job_commit_phase_claim`，上机须先跑 migrate** |
| [#5873](https://github.com/zensgit/metasheet2/pull/5873) | **已合**（`2ab346bf0`，2026-09-21 11:00:13 CST） | DELETE 方法覆写中间件 + 前端 DELETE 传输自动回退（客户出网丢弃 DELETE，客户反馈 #1/#4） | opus 实现 / opus 反驳×2 / Fable 终审（三轮：FIX→FIX→MERGE `wf_636e9dc9-55d`） | 第三轮（本窗口）零源码改动，仅补推此前未推的提交 `c41866932`（请求日志行还原 main 原文）+ 合 main `7dabe8083`；终审确认真因是第二轮请求日志 if/else 分支多出一个 `this.logger` 造出两个 ancestor-KIND key，冻结清单未变（50 一字未动）；探针 RED-BEFORE/GREEN-AFTER 数字与 CI 逐位相同；53 个读 `index.ts` 的 spec 批跑无第四条锚；CI 32 项全绿 CLEAN |
| [#5934](https://github.com/zensgit/metasheet2/pull/5934)（W6，Closes #5835） | **已合**（`569042ed3`，2026-09-21 11:22:41 CST） | 售后插件对象表已删/缺失时改为 fail-closed + 可执行的引导提示 | opus 守卫流水线（实现对脏树 STOP / 反驳 callers+hollow / 修复 `0aabe1a3d` / Fable 终审 MERGE `wf_a65fe7a4-e73`） | 反驳咬住「已删除提示建议重新开通」与 `ensureSheet` 对软删表必抛矛盾；修复把提示改指向恢复、假件测试重写、21 处路由 catch 译成 409 三态引导、扫描器改源码派生闭包；终审四种走样探针均红；26 项 SUCCESS + CLEAN + match-head `0aabe1a3d` |
| [#5940](https://github.com/zensgit/metasheet2/pull/5940)（W7，#5829） | **已合**（`e19855765`，2026-09-21 12:18:06 CST） | 旧版 `spreadsheet-permissions` 三条路由补表存活 + `canManageSheetAccess` | opus 守卫流水线（反驳 8 条全修 / Fable 终审 FIX 仅注释级 `wf_f56b277b-1e3` / sonnet 注释更正轮 `ff766b731`） | 反驳删残留 scratch 探针、GAP 下界按当前 main 重算为 2、确认 FK 指向 `meta_sheets`（legacy SQL 036 为已废弃标记）、确认三路由无 apps/web/plugins 调用方；变异 AUTH 5 红 / GATE_ALL 12 红；注释更正核查 5/5 ok；26 项全绿（含 1 项 SKIPPED）+ CLEAN + match-head `ff766b731`；跟进 issue #5937（退役旧路由）、#5938（grant/revoke 事务内复检 `deleted_at`） |
| [#5929](https://github.com/zensgit/metasheet2/pull/5929)（W8，#5912） | **已合**（`3ced939ef`，2026-09-21 10:55:22 CST） | 迁移文件时间戳前缀唯一性守卫——允许清单钉住既有 12 组 + #5893/#5915 的 `20260919140000` 对 | sonnet 实现 / opus 反驳 / Fable 终审 MERGE `wf_38f1a060-00a` | 反驳咬住「钉住对在只落一个的中间态判红，而这正是当前 main 状态」；修复引入 `PENDING_PAIRS`（0/1/2 文件态不红、第三个文件即红）；终审用真实 `origin/main` 清单探针实证；26 项 SUCCESS + CLEAN + match-head `9c1730408` |
| [#5913](https://github.com/zensgit/metasheet2/pull/5913) | **已合**（`c5547aad3`，2026-09-21 12:32:47 CST） | 第八次 36h 窗口设计与验证记录定稿（内容记录窗口 8 本身，本窗口内完成定稿并合入，不在本文展开，详见 #5913） | sonnet 草稿与定稿 | 11 处待补按 `gh` 现场核实填齐，核查 5/5 ok；`test(20.x)` 首次红判定为运行机抖动（`multitable-automation-dispatch-loop-realdb` 心跳租约毫秒计时断言，与改动无关）已 rerun；重跑后 21 项 SUCCESS + CLEAN |
| [#5935](https://github.com/zensgit/metasheet2/pull/5935)（#5839 B2） | **已合**（`565fa5dd5`，2026-09-21 13:09:55 CST） | 字段/视图/导入/汇总族 8 条纯删（config-history 摘出）；rebase 轮 + 再合 main 轮各一次 | sonnet 实现 / opus 反驳×2 / Fable 终审（rebase 与再合 main 轮各一次 opus 修复 + Fable 终审） | 28 项全绿、CLEAN、`--match-head-commit 955172ca4` |
| [#5939](https://github.com/zensgit/metasheet2/pull/5939)（#5839 B5） | **已合**（`e15a6e315`，2026-09-21 14:09:42 CST） | 公开表单 submit + 记录 PATCH 的表行探测搬到权限判定之后，匿名 401 / 已登录无权限 403 三态同形；账本清零批（→1） | opus 守卫流水线 + 合 main 轮（opus 修复 / Fable 终审） | 28 项全绿、CLEAN、`--match-head-commit fb3a3e940`；内存变异 3/3 红（vite `resolve.alias` 换 `node:fs` 才生效） |
| [#5947](https://github.com/zensgit/metasheet2/pull/5947)（#5938） | **待合（截至 15:34：终审 MERGE、CI 28 项全绿、CLEAN、head `272e9c9d1`；正文更新 / ready / merge 因断网未成）** | grant/revoke/PUT permissions 等九处访问控制写点在事务内「锁 + 读 `deleted_at`」同一语句复检，关闭锁外存活读的 TOCTOU 窗；结构守卫 + 全树锁普查；真库探针改 LIKE 绑定导出常量 | opus 实现 / opus 反驳×2（同抓「改写行锁 SQL 让真库探针失明」）/ opus 修复 / Fable 终审 | 8 套 251 + ops 38 + tsc 0；内存变异 neuter 23+14+4 红 |
| [#5948](https://github.com/zensgit/metasheet2/pull/5948)（#5936） | **进行中（截至 15:34：draft，head `b6b41702a` CI 28 项全绿 CLEAN；修复轮与终审卡在网关）** | `GET /context` 403 → liveness → 404 先于表行读，`Sheet not found: <id>` 回显移除；`EXISTENCE_PROBE` 扩到别名多行形态，新命中仅 /context 一处，账本零登记 | opus 实现 / opus 反驳×2（均 minor）/ opus 修复 / Fable 终审 | 20 文件 700 绿、新 spec 10、守卫 9/78、tsc 0；内存变异 P1–P5 按预期红/绿（P3 复现 main 盲点） |
| #5807 首刀（无 PR） | **进行中**（`wt-w11-5807`，分支 `fix/people-sheet-read-bound`，opus 实现阶段） | People 表枚举读钳 50 且不许翻窗、导出/聚合 403，门不动；先证 records-summary displayMap 与 Yjs 入口 | opus 守卫流水线 | — |
| 评论 / issue | 已发 | #5864 v2（issuecomment-5755544758）与 v2.1（issuecomment-5756043523）；#5807 分诊（issuecomment-5755929332）；#5943 同意处置（issuecomment-5755934663）；PR #5609 裁决（issuecomment-5756151958）；#5839 收口并关闭；新开 #5936 / #5937 / #5938 / #5946 | opus 起草 + Fable 挑漏（#5864）；opus 只读核对（#5807）；反驳×2 + Fable（#5609）；sonnet（#5946） | 逐条 path:line 在冻结 sha 上重读 |

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
| B1 | 表配置族 11 条纯删（含夹具 `tests/utils/sheet-existence-oracle.ts`） | **已合**，PR #5924，`0714f0a3f`（2026-09-21 10:50:49 CST） | 28 → 17 |
| B2 | 字段/视图/导入/汇总 8 条纯删（config-history 摘出） | **已合**，PR #5935，`565fa5dd5`（2026-09-21 13:09:55 CST） | 11 → 3 |
| B3 | 需补/搬拒绝 4 条（prepare/export-xlsx/dry-run/attachments） | **已合**，PR #5919，`afb4e44a5` | 已生效 −4（与 B1 合并后实测 13） |
| B4 | 事务内记录权限 2 条 | **已合**，PR #5921，`d18e1e03b`（2026-09-21 11:45:45 CST） | 13 → 11（合 main 时点已实测） |
| B5 | submit + PATCH（账本清零批，最后合） | **已合**，PR #5939，`e15a6e315`（2026-09-21 14:09:42 CST） | 3 → 1 |

**后落者合 main 规则**（各 PR 正文一致写明）：B1 先落，其余批次依次 `rebase --onto origin/main <B1 旧 tip>` 或 `git merge origin/main`，保留 main 数组、只删自己那一批的账本字符串，重新核对总数。已实证三例：B3 合并后 `28 − 11(B1) − 4(B3) = 13`（11:16 CST 前）；B4 合 main 时账本 `13 → 11`（11:16 CST，`wf_b5e04862-de2`，与实测账本条数逐位相符）；B2 rebase 后 `13 → 5`，B4 落地后再合 main 一轮，账本恰 3 条（12:32 CST，`wf_e5f4c539-ab6`，与 B4 三处逐字节同行同字）。

**账本清零已完成**：五批全部落地，`EXISTENCE_BEFORE_AUTHORITY_GAP.handlers` 实测 `28 − 11 − 4 − 2 − 8 − 2 = 1`，唯一保留项 `GET /sheets/:sheetId/config-history`（issue #5910，owner 待裁决是否收窄）。issue #5839 于 2026-09-21 14:10 CST 关闭，收口评论列出残留编号：#5910（config-history）、#5908（视图侧）、#5911（PATCH 记录行探针）、#5936（`GET /context` + 探针扩宽，PR #5948）、#5946（ConflictError 500）。8 项裁决按「默认前进 + 24h 异步否决」记入 Decision Register。

---

## 7. 客户反馈九条对照表

来源：`docs/development/takeover-beiliao-20260821/customer-anomaly-triage-20260918.md`。本窗口内无一条新裁定，仅推进已立案项到合并；**本窗口无上机，R59 因部署窗口错过未做，222 上无一条本窗口改动**。

| # | 客户描述 | 对应 issue/PR | 主干状态 | 222 状态 |
|---|---|---|---|---|
| 1/4 | 删除整个表/记录/模板报「无法连接服务器」（DELETE 被客户侧丢包） | #5873 | **已合**（`2ab346bf0`，2026-09-21 11:00:13 CST） | 未上 |
| 2 | 自动化「发送通知」测试运行报 NO_RECIPIENTS（编辑器 dirty 时未保存） | #5867 | 已合（窗口前，`b4e728d88`） | 未上 |
| 3 | 层级 0 根选择规则（图号模式待确认） | #5874 | 已合（窗口前，2026-09-20T00:28:57Z） | 未上 |
| 5 | 「使用模板」无幂等，重复点击出现多个同名 Base | #5893 | 已合（本窗口，`ae500f1a1`，2026-09-20 20:33:12 CST） | 未上 |
| 6 | 字段类型只支持文本↔长文本；面板高度不可调 | #5864 | 设计（方案 v1 已发 issuecomment-5749356499；owner 已审阅 2026-09-21T04:12Z，语义调整非拍板；方案 v2 已回帖 issuecomment-5755544758，留 8 个 owner 待答问题；**未实现**） | 未上 |
| 7 | 冻结只有列没有行；冻结列后首行被固定 | #5875 | 已合（窗口前，2026-09-20T00:29:16Z） | 未上 |
| 8/9 | 换项目号重拉后三个视图仍显示旧项目行 | #5868 | 已合（窗口前，2026-09-18T11:37:16Z） | 未上 |

窗口开始时（18:40 条目）已合 4 条（#2/#3/#7/#8-9），窗口内新增合入 2 条（#5 #5893、#1/4 #5873）：7 行客户反馈中 6 行已合入主干，剩 1 行（#6，#5864）处于设计阶段，v2 方案已回帖，留 8 个 owner 待答问题（见 §8）。

---

## 8. 未完成与交接

| 项 | 状态 | 说明 |
|---|---|---|
| R59（222 上机） | **未做** | 本窗口 18:00–08:00 部署时段整段错过（夜间会话进程退出）；09-21 08:00–18:15 是禁发时段，窗口结束前无可用部署窗口，交接给 owner；本窗口合入的 #5893（迁移 `zzzz20260919140000_create_multitable_template_install_ledger`）与 #5915（迁移 `zzzz20260919140000_ai_bulk_job_commit_phase_claim`）均含迁移，上机须先跑 `migrate` |
| #5947（#5938 TOCTOU） | **待合** | 截至 15:34：终审 MERGE、28 项全绿、CLEAN、head `272e9c9d1`；网络恢复后三步：`gh pr edit --body-file`（补六条终审注记 + 验证行，稿在 scratchpad/prs/pr-5938-body.md）→ `gh pr ready` → `gh pr merge --squash --match-head-commit 272e9c9d1`（squash message 末行改 Fable 尾署）。两处具名残余待开 issue：`univer-meta.ts` 跨库镜像多表 `FOR UPDATE` 不复读存活；`services/elearning-stats-multitable-projection.ts` 投影表锁不读 `deleted_at`。 |
| #5948（#5936 GET /context） | 进行中 | 截至 15:34：draft，head `b6b41702a` CI 全绿 CLEAN，合 main 干跑零冲突；修复轮（两反驳均 minor）与终审卡在网关，恢复后 `resumeFromRunId wf_75461294-8c6`；终审 MERGE 后转 ready、CI 绿即合。detached 树 `metasheet-wt-m5948` 是为手工合 main 备的，未用，可删。 |
| #5864 owner 待答 | 待 owner | v2.1（issuecomment-5756043523）后仍差一句话的五项：权限门（建议 `canManageFields` + 全表可读）、前镜像保留天数、往返保真 A/B（仍建议 A）、客户侧确认首批配对、面板范围。条款被接受后合成 ≤3 页「首批窄范围设计锁」ADR 走 PR，第二刀只读预检从那份文本起工。 |
| #5910（config-history 裁决） | 待 owner | #5839 五批全部落地后账本唯一保留项，是否收窄待 owner 裁决，本窗口内不动 |
| #5807 首刀 | 进行中 | `wf_a37eb6ec-9cb` 实现阶段（断网期间本地仍在写）；恢复后 `resumeFromRunId`；落地形态 = 新 PR（标题见任务单），大概率交下一窗口。owner 一问：人员字段长期不含邮箱是否可接受。 |
| PR #5609（考勤守卫 CI 卫生项） | 待 owner 选路 | 裁决已回帖：可合但先补四项；默认原分支补齐我们复核，owner 选「我们承接」则下一窗口从 main 另起分支。评审树 `metasheet-wt-r5609`（detached）待清理：先 `cmd /c rmdir` 拆三处 junction 再 `git worktree remove`。 |
| #5946（ConflictError 500） | 待派 | 与 #5948 同区域，等其落地后派 sonnet 实现版守卫流水线（7 处不捕获 + 3 处回显 id，保持 B5 spec ⑤ 三态同形）。 |
| 考勤线 #5573 / #5639 | 待定 | owner 开的 staging soak 功能 bug，零分诊；是否接取决于考勤线是否算交接给本线。#5669 是隔离机部署任务，owner 层。 |
| 网络中断 | 未恢复 | 15:34 CST 起；本机代理仍监听、上游 EOF；未动网络/系统设置。恢复后顺序：#5947 三步 → #5948 resume → 残余 issue ×2 → 本 PR 推送 + ready。 |

**owner 待裁决项**（本窗口内新增或复述自 PR 正文，均未由本窗口自行拍板）：
- #5893：缺表时 fail-open 还是 503；300s 窗口长度（锚 nginx `proxy_read_timeout`，未实测有无余量）；15s 锁等待上限；客户机上跑迁移的时机；真 Postgres 泳道缺失（token 无 `workflow` scope）。
- #5839：8 项裁决（详见 `scratchpad/5839/plan-r2.md`）——①错误码/消息对客户端可见变更、②submit 公开入口 404→401/403、③config-history (i)/(ii)、④attachments 500→404、⑤PATCH 残留、⑥throw 路径码变、⑦⑧视图侧具名残留。B1/B3/B4 已合入 main（①按 values-free 404 落地）；B2/B5 终审均已判 MERGE，待 CI/合 main 落地；③（config-history）独立 issue #5910 待裁；⑦⑧视图侧具名残留见 issue #5908；⑤PATCH 残留见 issue #5911；新发现的跟进项 #5936（GET /context 探测先于 403）、#5937（退役旧版 spreadsheet-permissions）、#5938（grant/revoke TOCTOU）均待排期。
- #5864：v2 方案（issuecomment-5755544758）已把 10 处挑漏吸收进设计（多选→单选后置、写入栅栏与前镜像捕获默认关闭 fail-closed、三端点统一 `canManageFields`、Time Machine 四测试进 -realdb 车道等），留 8 个 owner 待答问题，最卡排期为①首批配对范围、②自动建选项上限，其余具体条目待核。

---

## 9. 教训

- **工作流随会话进程退出而消失，恢复靠 journal 缓存 + `resumeFromRunId`。** 昨夜 20:4x 后会话进程退出，约 13h 空转，所有工作流/监视/心跳随之消失；09-21 10:06 恢复后，六条在飞工作流均用 `resumeFromRunId` 续起（未从零重派），确认 journal 缓存跨会话进程存活。
- **同模型才命中 `resumeFromRunId` 缓存。** 与 [[workflow-resume-after-model-switch-reruns-live]] 一致：本窗口恢复时会话模型未切换，六条工作流均正常续跑；这条记忆里记录的"模型切换后整段重跑"风险本次未触发，但仍需在下次唤醒前核对会话模型与工作流派出时是否一致。
- **浏览器车道本地跑易停摆，交 CI。** #5873 前两轮修复都因本地跑浏览器车道（attendance/stock-prep Playwright harness）而停摆，第三轮精简收尾（`wf_50045a7f-d23`）明确禁止本地跑浏览器车道，改为只做文本/守卫核对后直接推送。
- **估算时间戳必须先跑 `date`。** 20:22 CST 条目明确记录：此前标注 20:05–20:50 的几条账本时间是估算，实际提前约 25–35 分钟；此后账本条目一律先跑 `date` 再落笔（与 [[clock-drift-run-date-before-writing-times]] 一致）。
- **GitHub 直连抖动走 socks5。** 20:42 起 GitHub 直连出现 TLS 超时/EOF，`gh` 命令随即切换到 `socks5h://127.0.0.1:10808`；本文撰写时同样按此前缀调用 `gh`（与 [[github-egress-needs-local-proxy]] 一致）。
- **代理参数序列化可能整体丢参。** #5873 第三轮工作流首次派出时因参数被序列化成字符串（代理收到全 `undefined`）触发 ABORT/BLOCK；代理判断正确（零改动），但暴露了派单通道本身的一个脆弱点，值得在后续窗口留意同类"首句即空"的信号。10:07 CST 重派后（同一参数结构）第三轮工作流正常执行并于 11:00 CST 推动 #5873 终审 MERGE 合入，说明问题出在单次调用的序列化环节，通道本身未持续故障。
- **真库集成红不一定是业务逻辑退化，也可能是限流器与测试并发量的耦合。** #5915 的 `test(20.x)` 红最初被归因为 committing 状态未释放；10:31 CST 归因推翻——真正原因是提交路由 `:1413` 的 E-10 突发限流器（`tenantBurstRpm` 默认 30、按用户 id 60s 固定窗），集成套件按执行序发出的第 31 个请求恰好命中 commit 调用；修复只是把集成夹具的租户突发预算调高（`MULTITABLE_AI_TENANT_BURST_RPM=1000`）并新增预算门专用测试，未放宽任何拒绝断言。
- **断网时先探活再操作。** 15:34 断网后，带 60s 超时 × 5 次重试的 gh 循环把近 50 分钟白耗在 EOF 上；正确顺序是 `curl -m 10 https://api.github.com/` 探活（两条代理 + 直连）→ 通了才跑 gh，断着就挂后台探针、转做本地能做的事（本文定稿即如此）。
- **心跳 cron 会随进程重启而重复。** 重启后重建的 cron 与原有的并存，心跳在 12:57 / 13:46 / 13:50 / 14:48 / 14:50 密集触发；每次重建前先 `CronList`。
- **内存变异探针：`NODE_OPTIONS --import` 补 `fs.readFileSync` 对 ESM 内置命名空间无效，会假绿；Vite `resolve.alias` 把 `node:fs` 换成 shim 才真生效**（B5 合 main 轮实测：前者 8/8 假绿，后者 3/3 红）。
- **代理提交尾署会按模型如实写 Opus。** 三条流水线的实现/修复代理都拒绝署 Fable；协调方在 squash message 里改末行即可，不 force-push。
- **全库「待回复」扫描要按账号而非按人。** owner 账号被 Codex 车道共用，逐条 REST 拉 300+ PR 会超时；GraphQL 分页一次拉全，再按「最后一条来自 owner 且我方未回」过滤，最后人工剔除封存线与核验记录。


## 10. 窗口末补记（16:10–18:15）

本文 §1–§9 于 16:15 CST 在断网期本地定稿（PR #5930，合入 `947954ea1`），记录截至 16:10。以下补记此后发生的事，构成本窗口的完整结论。

| 时间 | 事件 |
|---|---|
| 16:18 | **网络恢复**（socks5h 通、reclaude 200），共断 44 分钟（15:34→16:18）。本机代理全程在监听，上游 EOF；未动任何网络/系统设置。 |
| 16:19 | **#5947（#5938 权限写入 TOCTOU）合入 `58d48934e`**——九处访问控制写点在事务内以「锁 + 读 `deleted_at`」同一语句复检，结构守卫 + 全树锁普查 + 真库探针改绑导出常量。 |
| 16:24 | **#5807 首刀 draft PR #5953 开出**（head `3ed20c32a`）让 CI 早跑；**#5946 守卫流水线派出**（`wf_aad90e12-e78`）。gh 活动账号一度漂到另一账号，已切回。 |
| 16:25 | **#5947 两处具名残余开 issue**：**#5954**（跨库镜像 `POST /crossbase/mirror-link` 多表 `FOR UPDATE` 不复读存活，真实缺口）、**#5955**（e-learning 投影表锁不读 `deleted_at`，经两道守卫证实该表无法被软删，影响为理论性）。 |
| 16:57 | **#5930（本文 §1–§9）合入 `947954ea1`**。 |
| 17:19 | **#5948（#5936 `GET /context` 探测先于 403 + 探针扩别名多行）合入 `ea90d8027`**——终审判纯顺序调整，新登记 GAP 条目 0。 |
| 17:35 | **#5807 不可抄近路**：当前 head CI 虽已全绿，bypass 反驳者抓出 3 处 major——① `POST /sheets/:sheetId/charts/preview-data` 与已堵的 `dashboard/query` 同源、group-by 一次拉全名册未钳；② `GET /sheets/:sheetId/point-in-time` 以 `asOf=now` 翻当前名册、offset 无上限，被放进 EXEMPT 当已知洞未修；③ 结构守卫对 `GET /records` 的读法是盲的，去掉钳仍绿。合绿头会放出不完整收口，近路作废。 |
| 18:01 | **#5946 交接 draft PR #5957 开出**（head `d6be37ab3`，修复轮已吸收反驳×2）；其**终审阶段撞 Fable 用量上限未产出裁决**，正文已标「合并前需补独立终审」。#5807 修复轮仍在跑。 |

**本窗口合并总计 17 支**：#5891 #5892 #5893 #5919 #5924 #5921 #5915 #5873 #5934 #5940 #5929 #5913 #5935 #5939 #5947 #5948（代码 16 支）+ #5930（本文）。

**交接给下一窗口**

| 项 | 状态 | 下一步 |
|---|---|---|
| #5953（#5807 People 读侧钳量） | draft，修复轮在跑 | 修复需补 `charts/preview-data`、堵或拒 `point-in-time`、修守卫对 `GET /records` 的盲区、把别名导致的恒等自比测试改成真比较；再跑 CI → 终审 → 合 |
| #5957（#5946 ConflictError 收口） | draft，head `d6be37ab3` | **补一轮独立终审**后按 CI 合；反驳×2 已过并被修复轮吸收 |
| #5954 / #5955 | 待派 | #5954 建议多 id 版 `assertSheetsLiveForUpdate`；#5955 影响为理论性，可低优先 |
| #5864 字段类型转换 | 待 owner | v2.1（修正稿）已发，仅差五项一句话：权限门、前镜像保留天数、往返保真 A/B、客户确认首批配对、面板范围。条款被接受后合成 ≤3 页「首批窄范围设计锁」ADR 走 PR，第二刀只读预检从那份文本起工 |
| PR #5609（考勤守卫） | 待 owner 选路 | 裁决已回帖：可合但先补四项；默认原分支补齐我方复核，或由我方从 main 另起分支承接 |
| R59（222 上机） | **未做** | 部署时段 18:00–08:00 与窗口尾不重叠；本窗口合入的 #5893/#5915/#5947 等带迁移，上机需跑 `migrate`；属 owner 层 |
| 模型额度 | ⚠ 阻塞 | `security-judge` 走 Fable 额度且已耗尽（`judge:w12-5946` failed）。下窗口开工前需补额度或把终审档位改 Opus，否则所有边界 PR 卡在终审 |

**本窗口新增教训（补 §9）**

- **绿头不等于可合。** #5807 当前 head 的 CI 全绿，若按「CI 绿就合」抢进度，会放出一个漏了两条同源路由（`charts/preview-data`、`point-in-time`）且守卫对主读路径失效的名册收口。边界 PR 必过反驳×2 + 终审这条规矩，挡住的正是这种。
- **断网期要转做本地可做的事。** 15:34 断网后，带 60s 超时 × 5 次重试的 gh 循环把近 50 分钟白耗在 EOF 上；改为先 `curl -m 10` 探活、断着就挂后台探针并本地定稿文档，网络一通即推。
- **判官档位与会话模型解耦。** 终审继承会话模型，会话模型的额度耗尽会让整条流水线卡在最后一步而前面四个阶段的产出全部就绪；派长流水线前应确认终审档位的额度。

---

*基线：账本 `claude-auto24/STATE.md`「## 2026-09-20 18:15 第九次窗口（24h）开始」至文件末尾（本地定稿时点 2026-09-21 16:14 CST，断网后未再核对 GitHub）；PR/issue 数据经 `gh pr view/checks`、`gh issue view` 现场核对，均标注截至时点。窗口尚未结束，第 3/8 节列出的进行中项可能在窗口收尾前变化，届时按定稿流程更新本文。*
