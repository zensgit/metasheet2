# 开发完成度 — 计划与验证汇总(2026-06-18)

> Status: **VERIFICATION + PLAN** for the `/goal` "请并行开发,根据计划及 TODO MD 完成所有开发,完成后给出计划及验证 MD".
> Grounding: `origin/main @ 14ffaf10b` (live-main, 2026-06-18; **pinned snapshot** — the S1b/data-source write track is under active parallel development and moves per-commit, so this MD pins one SHA rather than chasing its tip). Every claim below was verified **against `origin/main` by live code/PR ancestry, not by checkbox** (stale-marker traps recur in this repo — see §5).
> Method: **parallel read-only verification** — three concurrent agents (data-source/integration · attendance annual-leave engine · attendance H2 benchmark) cross-checked against the author's own exhaustive multitable verification this session. Each cited squash SHA was tested with `git merge-base --is-ancestor`; on-main symbols confirmed via `git show`/`git grep`.

## 0. 一页结论 (headline)

**本轮深度验证的四条 track(多维表 · 数据库/系统对接 · 考勤 H2 · 考勤年假引擎)上,所有"显式已授权"的开发都已完成并在 `origin/main` 实测验收闭合;没有可自主开工的已授权剩余开发。** 另:对仓库内全部 plan/TODO MD 做了 authorization-marker(`UNBLOCKED`/`build authorized`/`可建`/`授权`)grep 普查,未发现任何其它带显式"可建"标记的刀 —— 但 approval/PLM/workflow 等 track 仅做此 marker 普查,**未逐一深度验证其完成度**(本 MD 的 COMPLETE 断言只覆盖上述四条 track)。"请并行开发...完成所有开发" 的诚实解析:唯一带 **"⬜ UNBLOCKED — build authorized"** 标记的刀(annual-leave **L5c**)早已由 **#2830** 落地并自带 dev-verification MD;其余每一项都是 **gated**(各自独立 owner opt-in + 具名 design 决策),通用的 "完成所有开发" **不构成**打开这些 gate 的授权(这正是 §6 "每 slice 独立 opt-in" 纪律,违反它在 #2831/#2177 烧过工)。

因此本轮交付 = **验证 + 计划 MD + 两类 ledger hygiene**:(a) 回填三份 stale ledger(把已落地却仍标 ⬜ 的 checkbox 改成 ✅);(b) 本 MD 逐 track 列出 **已完成(带证据锚点)** 与 **gated 剩余(带每项所需的具名 opt-in/决策)**,让 owner 一次性挑选下一批授权。**未自主打开任何 gated arc。**

> ⚠️ Live note:主干持续快速移动,S1b 正由一条**并行 effort 主动执行**(owner 已签 altitude:A 双接口拆分)。截至 `14ffaf10b` 已落:**S1b-1 #2887**(pluggable C6 write-source profile)、**S1b-2 #2892**(multitable raw write-source,own-sheet only,rides C6 lifecycle)、**S1a-retire #2894**(S1b 真实 write-source 落地后移除孤儿 `targetWriteLifecycle` 合同面)。S1b 从 "design-locked, impl gated" 进入 "**impl in-progress(并行 effort 拥有)**";本会话**不触碰**(最高风险写路径,已有 lander)。另:多维表侧 **#2890**(2b-S2 real-DB goldens:view/filter·aggregate·export·link-picker)+ **#2891**(CI:2c FE specs 入 web-guard)= 已完成 track 的测试/CI 加固(非新特性);**#2886** = approval `continuous_managers` **PROPOSED** design-lock(需 owner ratify A vs B,gated;在本 MD 深度验证的四条 track 之外,仅提示)。

## 1. 状态阶梯 — 四条 track 总览

| Track | 已完成 (on main) | gated 剩余 | 权威 ledger |
|---|---|---|---|
| **多维表 (multitable)** | 2a 全标量 CRDT · 2b 条件读权限 S1–S4(读-deny 8/9 surface)· 2c 人员目录 S2–S4 · #18 行级读拒 | **2b trash/restore rule-deny 继承(owner-gated Build/Defer)** · roadmap pool(导出/required-if/仪表盘联动/网格虚拟化 reopen-only/AI rings/原生同步表/FOL 深链/A6 余项) | `multitable-gated-remainder-development-plan/todo-20260618.md` |
| **数据库/系统对接 (data-source)** | C2–C6 · Release · S1a(合同层;orphaned 面已由 #2894 retire) | **S1b(impl 进行中 #2887/#2892,S1b-3 续接)** · S2 · S3 · S4 · S5 · 首笔生产外部写 | `data-source-system-integration-plan-and-verification-20260618.md` |
| **考勤 H2 (attendance core)** | 一天多班次 · 排班发布/草稿 · 临时班次 · 加班三段 · 自动对班 A2 · C5 通知 · **排班合规引擎(block-on-save runtime)** · **打卡策略组** | §1 OUT 红线(算薪/防作弊/AI/人脸/原生 app/插件市场,🚫) · H3 高级(调度/换班/多门店,gated;3a 可建) | `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` |
| **考勤年假引擎 (annual-leave)** | 引擎 L0–L5c(含 L5a/b/c admin)+ 员工自助 surfaces | **L6 staging smoke(owner-run gate,非自主构建)** | `attendance-annual-leave-admin-operations-dev-plan-20260617.md` |

## 2. 已完成 — 逐 track 证据 (COMPLETE, evidence-anchored)

### 2.1 多维表 (multitable) — 全部完成
- **2a 实时标量 CRDT(全标量集)**:select/date **#2832**、duration **#2838**、dateTime **#2849**(canonical-UTC-ISO 不变量);number/currency/percent/boolean/rating/multiSelect 此前已落。无标量类型仍是 REST-only。
- **2b #18 条件读权限规则 S1–S4**:evaluator **#2836** · enforcement(接入 #18 seam,flag-off inert)**#2841** · authoring UI/API **#2847** · content-keyed parse cache(staleness-free)**#2861**。**读-deny 覆盖 8/9 read surfaces**(list/view/search-filter · single-record · summary · aggregate/dashboard · export · link-picker;real-DB goldens 由 **#2890** 补齐,green in `test (20.x)`)。**第 9 个 surface —— trash list/restore —— 是 deliberate deferral,不是缺陷**:`loadRuleDeniedRecordIds` 只评估 live `meta_records`,trashed 记录不在该 live 路径里(code-acknowledged),故"把条件 rule-deny 完全继承到 trash/restore"是**新的 access-control 行为 = 显式 owner-gated Build-vs-Defer 决策**(见 §3.3,及权威 `multitable-development-completion-verification-20260618.md` L14–16/26 + TODO §5)。**恢复(restore)功能本身已可用、已完成**;待决的只是这条安全增强。(注:`plugins/plugin-intelligent-restore` 是旧的/示例式 plugin 壳,**不是**已交付的主线恢复功能,不能据它判断完成度。)
- **2c 人员字段 → 组织成员目录 S2–S4**:source = B 设计锁 **#2860** · resolver **#2866** · `canEditRecord`-gated directory endpoint **#2867** · `MetaPersonPicker` 接线 **#2869** · S4 inactive/historical 显示线索(read-only cell/summary cue)**#2874**;fail-closed 写校验 **#2833 + #2854**。
- **closeout/ledger 一致性**:**#2878**(2c COMPLETE closeout)· **#2881**(P1/P2/P3 reconciliation + #2877 carve-out)· **#2883**(grounding-line 2c)· **#2885**(`MetaPersonPicker` 注释对齐)。**#2877**(2c-S4 picker-chip)= **CLOSED not-landed**(S4 口径由 #2874 cell/summary cue 满足;picker chip 为不同 surface 的补充打磨,非正确性缺口)。

### 2.2 数据库/系统对接 (data-source) — C2–C6 + Release + S1a 完成
- **C2** 只读 SQL 源 — #2600;**C3** 增量/watermark — #2609/#2619/#2625/#2628/#2631;**C4** UI/配置 — #2643/#2646/#2649/#2652/#2655;**C5** K3 generic MSSQL seam — #2670 PASS + #2700 runbook(K3 红线 `SQLSERVER_WRITE_EXECUTOR_DISABLED` 保留);**C6** 外部写 sandbox 链路 — #2719/#2720/#2761/#2820(实体机 controlled bad-row PASS,values-free dead-letter/provenance)。
- **Release** 总包 scoped 验收 — #2769 PASS,package `79ab455e`。
- **S1a** 可选写能力合同层 — #2872 + opaque-keyHash #2876 + values-free 加固 #2882(`contracts.cjs` 含 `revisionHash`/`valuesFreeMetadata`/`assertErrorCode`/`CODE_PATTERN`;`REQUIRED_ADAPTER_METHODS` 5 法未变;零 runtime 消费者)。
- 设计文档:S1b keystone design-lock + 本汇总 plan/verification — docs-only #2884。

### 2.3 考勤 H2 (attendance core) — 全部 MUST/SHOULD/OPTIONAL 完成(含此前误判为 gated 的两项)
- **一天多班次** M0–M5 — #2426/#2427/#2428/#2429/#2445/#2446(staging `multi-shift-m5-*`)。
- **排班发布/草稿** — #2430→#2436(`ATTENDANCE_SCHEDULE_PUBLISH_STATUSES = {draft,pending,published}`;staging `publish-p4-*`)。
- **临时班次** — #2437→#2443(`assignment_kind='temporary'` replace-only overlay;staging `temp-shift-t6-*`)。
- **加班三段引擎** O1–O6 — design-lock + O1–O6(`overtimeSegmentation`;staging `overtime-o6-*`)。
- **自动对班 A2 自动写入** — A2-1/A2-2 runtime + A2-3 admin UI #2471(staging 35/35 `autoshift-a2-smoke-*`);grey-gate **已满足**(双 env flag + 三 org 条件),非待办。
- **C5 外发通知 / fan-out** — #2487→#2498→#2502→#2504→#2507→#2515(真实 DingTalk staging 27/27 `c5-delivery-*`)。
- **排班合规引擎(block-on-save)** — **runtime 已建,非 design-lock-only**:`enforceShiftComplianceCap` → 422 `SHIFT_COMPLIANCE_CAP_EXCEEDED`,日/周/月三粒度 × 全 save 路径事务内投影;链 #2213→#2214→#2218→#2221(staging 13/13);#2242 是其上的 settings 卡。默认 `enforcement` off(config 默认,非未建)。
- **打卡策略组** — 已建:`punchPolicy.{merge, outdoor, unscheduled}`;链 #2204→#2209→#2304/#2308→#2329/#2333/#2336/#2344。

### 2.4 考勤年假引擎 (annual-leave) — L0–L5c 完成,仅 L6 owner-run 剩余
- **L0** latent config + `deductLeaveBalance` helper — #2627;**L1** expiry `source_type` 泛化(`annual_leave_expiry`)— #2633;**L2** accrual 引擎 + provenance + dry-run + manual adjust — #2638/#2678/#2687(`NOT_ELIGIBLE_UNDER_ONE_YEAR` gate · `attendance_leave_accrual_runs` provenance);**L3** 审批扣减 — #2713;**L4** 结转/年末过期 — #2717/#2718;**L0–L4 capstone** — #2753。
- **L5a** admin 余额/台账读 — #2779;**L5b** policy 配置 UI — #2782;**L5c** admin 操作 UI(手工调整/回填/计提,in-DOM 两步确认 + 失败码 + policy-off 全禁用)— design #2795 / impl **#2830** / policy-off fix #2834 / closeout #2835/#2844;自带 dev-verification MD。
- 员工自助(超出 L0–L6 范围的 bonus,已落)— /me 余额读 #2850 + overview 卡 #2853。

## 3. Gated 剩余 — 每项所需 owner opt-in / 决策 (next-batch menu)

> 以下 **均不可自主开工**;每项需 owner 显式 opt-in + 列出的具名决策。本会话不打开任何一项。

### 3.1 数据库/系统对接
- **S1b(自有 multitable target 走泛化安全写,keystone)** — **impl 进行中(并行 effort 拥有)**:S1b-1 #2887(pluggable write-source profile)+ S1b-2 #2892(multitable raw write-source,own-sheet only)已落;S1a 孤儿合同面由 #2894 retire;S1b-3 续接。altitude 问题(`lookup/apply` = 内部数据通路 vs 证据投影)owner 已签 A(双接口拆分)。**本会话不触碰**(最高风险写路径,已有并行 lander)。
- **S2(K3 WebAPI target 走同一安全写)** — opt-in + 实体机 smoke(operator 执行);红线保留;仅 sandbox。当前 K3 WebAPI 仅 read-only smoke,未接入 C6 写。
- **S3(first-class `integration-template` 对象)** — opt-in;K3/PLM 各出一个参考模版。
- **S4(adapter 自描述元数据)** — opt-in;替换 `ADAPTER_METADATA` 静态字面量(现仍为静态 literal)。
- **S5(统一 field-mapping + PLM stock-prep 吸收)** — opt-in(低优先,短期不重写专用链路)。
- **首笔生产外部写** — owner 授权;序列 = 多样本只读 dry-run → sandbox apply → re-pull 幂等+人工字段保留 → 生产。

### 3.2 考勤
- **年假 L6 staging smoke** — **owner-run gate(非自主构建)**:需 staging-realm `attendance:admin` JWT(prod token 在 staging 401)+ 一次性单成员 org,经 UI 驱动三个 L5c endpoint + L1 年末 reaper(`AttendanceExpiryService`),断言 residue=0。跑通后年假引擎 §0.4 总目标方翻 ✅。
- **H3 钉钉级高级**(调度/换班/多门店/设备围栏/人脸/算薪)— gated,不一口吞;**3a 可建**(多门店挂部门,约 1–2 周)单点 opt-in;3b 不自研。
- **§1 OUT 红线**(算薪 SaaS/防作弊/AI/人脸/原生 app/插件市场)— 🚫 明确不做。

### 3.3 多维表 — 待决 owner 决策 + roadmap pool

- **【安全决策 · 非 reopen-only】2b 条件读权限 → trash list/restore 继承(owner-gated Build vs Defer)**:条件 rule-deny 现覆盖 8/9 read surfaces;**trash list/restore 未继承**(`loadRuleDeniedRecordIds` 只评估 live `meta_records`,trashed 记录不在该路径)。**Build** = 关闭「被 rule 隐藏的记录仍可能经 trash 可见/可恢复」这条 read-deny 旁路 —— 需先出 design-lock(rule 如何对 trashed 记录求值:它们有 stored 字段值但无 live `meta_records` 行);**Defer** = 记录为已知、bounded、被接受的 gap(仅当 #18 phase-2 规则开启 ∧ 记录已 trash ∧ 用户有 trash 访问 三者同时成立才暴露)。**本会话不自建,等 owner 明确选 Build 或 Defer。**

**roadmap pool(reopen-only / 未来候选):** 服务端全量导出 · 表单 `required-if` · 仪表盘联动筛选/下钻 · 仪表盘缺失日期桶/系列数上限 · **网格虚拟化(D2 verdict 判定不需要,reopen-only)** · AI rings 进阶 · 原生同步/外源表 · FOL 深链(多跳/公式套公式/物化/Yjs 重算/automation 触发)· automation A6 余项。各为独立 gated opt-in。

## 4. 本轮 ledger hygiene(已做,非 gated)

把"已落地却仍标 ⬜"的 stale checkbox 回填为 ✅,防止下个会话把已发货的工作误读为未开工(#2831 浪费的根因):
- **`attendance-annual-leave-admin-operations-dev-plan-20260617.md`** — Status 行翻 ✅ BUILT+MERGED(#2830/#2834/#2835/#2844)+ 39 个 build-step ⬜ → ✅;唯一保留的 🔒 是 L6 owner-run gate(§7/G1)。
- **`attendance-dingtalk-benchmark-target-and-tracker-20260601.md` §0.4** — L0–L5 行 ⬜ → ✅(带 PR 锚点);**L6 行保持 ⬜(正确 — owner-run staging gate 未跑,不可翻)**。
- **`attendance-annual-leave-balance-engine-design-lock-20260615.md`** — 状态行从 "实现 gated…未开工" 改为 "L0–L5c 已 BUILT+MERGED;仅 L6 owner-run 剩余"。

## 5. 本轮经验 (lessons)
- **验证按代码、不按 checkbox。** 一个并行 agent 因信任 §0.4 的 stale ⬜,误报年假引擎 "runtime unbuilt";按 `origin/main` 实测纠正为 L0–L5c 已建。账本 marker 滞后于 main 是本仓库的常态陷阱。
- **"完成所有开发" ≠ 打开 gated arc。** 唯一带显式授权标记的刀(L5c)早已发货;通用 goal 不授权打开 S1b/S2–S5/H3/年假 L-series 重开等 gated 项。诚实路径 = 验证 + 计划 + opt-in 菜单,而非制造并行去开 gate。
- **主干快速移动 + 并行 lander。** 验证/刷新期间 S1b 连续落 #2887→#2892→#2894(retire),S1b 被并行 effort 持续执行;本 MD 以最新 `origin/main` 校准并**显式 pin 一个 SHA(snapshot,不逐 commit 追)**,既避免把旧快照当最终树,也避免陷入追 tip 的 treadmill。

## 6. 结论 + 建议
**所有已授权开发已建、已验、在 `origin/main`。** 四条 track 的主体链路全部闭合(多维表 2a/2b/2c + closeout;data-source C2–C6/Release/S1a;考勤 H2 全 MUST/SHOULD/OPTIONAL;年假引擎 L0–L5c)。**没有可自主开工的已授权剩余开发** — 剩余项全部 gated,每项需 owner 显式 opt-in + §3 所列具名决策。S1b 已由并行 effort 持续执行(#2887/#2892,S1a-retire #2894),本会话不触碰。**建议**:owner 从 §3 菜单挑选下一批授权(最近的自然候选 = 年假 L6 owner-run staging smoke;S1b-3 由现有并行 lander 续接)。在拿到具名 opt-in 前,本会话不开任何 gated arc。
