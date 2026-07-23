# 考勤 vNext Wave 4（W4-0 / W4-1 / W4-2）开发与验证记录 — 2026-07-22

> 规格真源：`attendance-vnext-wave4-onboarding-design-lock-20260721.md`（RATIFIED，re-ratify via
> #4522 = `7a64424d1`）§0/§3/§4/§5/§6/§9/§10 + 章程
> `attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md` §8.1 十一门。
> 本文是锁 **§10 完成定义**中「验证 MD 在 main」一项的载体，并对其余各项做证据对账（§2）。
> **收官判定属 owner**——本文只呈实证，不宣布收官。
>
> 前置链 W4-PRE-1/1b/1c/1d（#4521/#4526/#4530/#4534）已有独立验证 MD
> `attendance-vnext-w4-pre1-development-verification-20260721.md`（main），本文不重复其内容，仅引用。
>
> 三切片交付（全部已合 main，`git log origin/main` 实证）：
>
> | 切片 | PR | 最终 head | 合入 main | 门禁记录 comment | 正门报告 |
> |---|---|---|---|---|---|
> | W4-0 readiness 底座 | #4541 | `ede4d4fc7` | **`b9495af18`** | #4541 comment-5049697116 | `/tmp/pr4541-review-w4-0-v2-gate.md` |
> | W4-1 向导壳与七步导航 | #4542 | `5d28b1b5a` | **`2365d977a`** | #4542 comment-5051249094 | `/tmp/pr4542-review-w4-1-gate.md` |
> | W4-2 模板预填 + ⑦预览 | #4543 | `34e82029` | **`bbcb8caf3`** | #4543 comment-5052515722 | `/tmp/pr4543-review-w4-2-gate.md` |
>
> 模型分工：W4-0 实现 = Sonnet；W4-1/W4-2 实现 = Fable 主循环；每片三镜预门（只读）→ 修复轮 →
> Opus 对抗正门；W4-0 另有正门 REQUEST_CHANGES → 修复 → 独立 Opus 复核 KILLED-CONFIRMED 一轮。
> 本文全部锚点（file:~line）已对 `bbcb8caf3`（W4-2 合入后 main）逐条重验；行号为近似值。

## 1. 三切片交付映射（锁条文 → 实现，锚点对 `bbcb8caf3` 实证）

### 1.1 W4-0 readiness 底座（#4541）

| 锁条款 | 实现（file:~line 于 `bbcb8caf3`） |
|---|---|
| §4.1 端点 + org 门（OD-W4-1=(a)） | `packages/core-backend/src/routes/attendance-admin.ts:~527` `r.get('/api/attendance-admin/setup-readiness', …)`——复用 S7-5 `canReadAttendanceDirectoryReadiness`（授权先于任何聚合 SQL；G1 用例 2 断言拦截时 `transactionMock` 0 次调用） |
| §4.2 只读证明 = 结构约束 | `packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts:~132` `SET TRANSACTION READ ONLY`（事务首条语句）；负向元断言禁首词/正则只读校验（unit `attendance-admin-setup-readiness-w4-0.test.ts:~624` describe「§9 W4-0-G2 negative meta-assertion」） |
| §4.2 响应键集恒等 | **13 键恒等**——修复轮曾有第 14 键 `viewerIsPlatformAdmin`，被正门判 P2（W4-0 无消费者的前瞻投机）后移除，键集锁定测试同步回 13 键（unit + 真库两级） |
| §3①-⑤ 信号派生（含 ③ errata 公式） | 聚合 CTE 七腿逐项 `org_id=$1`；① 双 `is_active`（`user_orgs` AND `users`）；③ `step3Ready = shiftCount>0 AND (scheduledShiftGroupCount=0 OR activeRotationRuleCount>0)`（owner errata 逐字公式） |
| §3④ / §3.1 闭集 | 4 键闭集（`punchPolicy`/`ipAllowlist`/`geoFence`/`minPunchIntervalMinutes`）vs normalized defaults；判别映射 `default→manual_review_required`（绝不 ready）、`customized→ready`、`unknown→unknown` fail-closed；G5 对账解析**活文件** plugin `DEFAULT_SETTINGS`（键名 + 修复轮补值级双 pin） |
| §3⑥ / §4.5 三信号 port | `deliveryRuntime`（仅读 `getSharedAttendanceScheduler()`，绝不读 worker env；调度器已启动 ⇒ `unknown` 绝不 `ready`）/ `orgRecipientBinding{boundRecipientCount,hasAnyBoundRecipient}`（dingtalk+wecom 双 provider、`local_user_id` NOT NULL + DISTINCT）/ `recipientScopeConfig` 恒 `'unsupported'` |
| §3⑦ / §3.2 previewReady | `= ①②③⑤ 全 ready`，④⑥ advisory 不参与——后端 + FE 纯模块双重独立推导（FE `apps/web/src/views/attendance/attendanceSetupReadiness.ts:~185`） |
| §3.2 effectiveTime 四态 | `perStep[stepId].effectiveTime = {source, posture, effectiveAt?}` 按锁字面嵌套（修复轮吸收）；七步全登记 |
| §7 FE 纯模块值域 | `ATTENDANCE_SETUP_READINESS_STATUS_VALUES` 七值穷尽（`attendanceSetupReadiness.ts:~21`）+ 值域穷尽断言 |
| §9 CI 双点接线 | `plugin-tests.yml:~843` 显式文件 + `packages/core-backend/vitest.config.ts:~419` exclude（防 skip-green）；FE spec 进 web-guard run-list + 双 path filter |
| ④ 探测健壮性（正门 P3-1 吸收） | posture 探测包 SAVEPOINT/ROLLBACK TO SAVEPOINT——`system_configs` 缺失时端点 200 且 ④=`unknown` 其余信号不变（真库负例锁定） |

### 1.2 W4-1 向导壳与七步导航（#4542）

| 锁条款 | 实现（file:~line 于 `bbcb8caf3`） |
|---|---|
| §9 W4-1 组件 | `apps/web/src/views/attendance/AttendanceSetupReadiness.vue`——纯展示 props/emit（零 fetch/零写/零向导态）；tokens.css `--ms-*` 零硬编码 hex |
| composable | `useAttendanceSetupReadiness.ts`——唯一网络调用 = GET；HTTP 折叠：403→`forbidden`（per-surface，不复用 `adminForbidden`）；503+`DB_NOT_READY`→`db_not_ready`；其余全部 fail-closed load error；body 解析 enum-strict（非法枚举 = malformed，绝不静默 fallback） |
| §6.1 section 注册 | `useAttendanceAdminRail.ts:~16` `setup: 'attendance-admin-setup'`（canonical 注册，自动获得 `?section=` query 深链/rail/快速跳转）+ 任务首页 people-groups 组首位 action「启用准备」（不加第 5 组，4 列栅格不动） |
| §6.1 「未完成」徽标 | `deriveAttendanceSetupEntryNeedsAttention` = ①②③⑤ 存在非 ready；④⑥ advisory **不触发**（负例 + mutation 刀④ 锁定）；非访问史信号（`AttendanceView.vue:~14811`「启用准备 · 未完成」） |
| §3① 角色化合同（W4-1 强制） | 平台 admin ⇒ base-aware `/admin/users` path 形深链（`resolveAttendanceSetupAdminUsersHref(BASE_URL)` + 可选 router SPA 导航）；受托 `attendance:admin` ⇒「请联系平台管理员创建或同步人员」说明文案，全组件零 `/admin/users` 入口（绝不渲染必然 403 的操作入口）；角色信号 = `useAuth().hasAdminAccess()` 与 `UserManagementView` 同源，**后端零新键**（W4-0 的 13 键锁维持） |
| §3 L205 每步六要素 | 状态 badge / 缺失项 reason / scope-honest 影响人数（④⑥ =「整个部署（部署级设置）」不带 org 计数；⑦ = ①②计数派生）/ effectiveTime 四态渲染（scheduled 必显 effectiveAt）/ 每步预览入口（①-⑥ = 向导内跳转 ⑦ 卡的 BUTTON，零 href/hash）/ 修复动作 |
| §3⑥ / §4.5(iii) | ⑥ 三行独立信号不合并；修复动作文案恒「查看投递历史」；`unsupported` 渲染「当前版本不支持，无可用操作」——零「配置接收范围/未配置/去配置」 |
| §3⑦ checklist | ⑦「预览影响范围（preview-ready）」+ 人工 canonical activation checklist 无条件列 ④ 与 ⑥ 三信号；文案零「已启用/enabled」完成时态（zh+en 双 translator mount 断言） |
| §4.6 帮助 | 每步四类页内帮助（scenario/impact/recovery/audit），values-free |

### 1.3 W4-2 模板预填 + ⑦预览完整推演（#4543）

| 锁条款 | 实现（file:~line 于 `bbcb8caf3`） |
|---|---|
| §5.1 四模板 = FE 常量（OD-W4-3=(a)） | `attendanceSetupTemplates.ts:~214` `ATTENDANCE_SETUP_TEMPLATES`（办公室固定班 fixed_shift / 门店排班 scheduled_shift / 工厂多班次 scheduled_shift 含 22:00-06:00 跨夜 / 销售外勤 free_time）——**BE 零新增**（正门实证 diff 零 backend/plugin/route 文件），字段集与锁附录 A 逐字段一致 |
| §5.2① 覆盖确认 | `AttendanceSetupTemplatePrefillDialog.vue`——confirm 阶段先渲染受影响字段完整清单（9 行，含修复轮补上的 `shift.rounding` 行）再写；apply 是显式按钮，apply 前零写入 |
| §5.2② 快照 + 取消完整恢复 | 快照捕获两表单全字段 + 双 editing id；undo byte-identical；wire 级双腿证明（undo 后保存 ⇒ `PUT /groups/g1` + `PUT /shifts/s1` 原记录精确 body） |
| §5.2③ 只承诺已保存 | applied 文案「尚未保存……未保存的预填在刷新后不会保留」+ undo-scope note（撤销仅在弹窗打开期间可用） |
| §5.2④ 时区禁硬编码 | 模板常量零 timezone 键/零 IANA/UTC/GMT 字面；resolver 三分支（本组织已保存考勤组唯一 distinct 显式时区 / 0 值 / 多值 ⇒ 强制用户选择）；空时区 ⇒ 无 plan，绝不回退浏览器时区 |
| §5.3 ⑦ 只读推演 | ⑦ 卡「只读影响范围推演（不写入）」：影响人数（①②计数派生）+ 必备步骤 recap + 资源计数 + ④⑥ advisory 行；全表面零完成时态（zh+en × 壳与弹窗两表面负向） |
| §7 open-template emit | 向导壳四模板卡逐 id emit `open-template`，宿主 `AttendanceView.vue` 全权编排（同宿主预填，§5.2 机制） |
| OD-W4-7② 未保存离开提示 | `attendanceSetupPrefillLeaveGuard.ts`（共享 signal + confirm helper）三腿：beforeunload + `AttendanceExperienceView.vue:~75` `onBeforeRouteLeave` + `:~265` `selectTab` 顶层 tab 切换 |
| §9 指标 runner 入仓 | `docs/development/assets/w4-2-vnext-20260722/metrics-harness/setup-metrics-walk.ts`（docs 资产姿态，不触任何 workflow path glob——正门实证） |

## 2. 锁 §10 完成定义逐项对账

锁 §10 原文（逐字）：「**完成定义**：三切片全合 + 验证 MD 在 main + §9 指标合成实测记录（含 **W4-0-G1..G5 五组门全绿**）+ 红线四条各有存活的负向断言。」

| # | 完成定义项 | 对账 | 证据锚点 |
|---|---|---|---|
| 1 | 三切片全合 | ✅ | W4-0 #4541=`b9495af18` / W4-1 #4542=`2365d977a` / W4-2 #4543=`bbcb8caf3`，均在 `origin/main` first-parent 提交链上（`git log origin/main --first-parent --oneline` 实证）；严格串行（每片基前片合入后 main） |
| 2 | 验证 MD 在 main | ✅（以本文所在 PR 合入为成立时点） | 本文；前置链引用 `attendance-vnext-w4-pre1-development-verification-20260721.md`（已在 main） |
| 3 | §9 指标合成实测记录 | ✅ | 见 §2.1——#4543 入仓 runner 台账 + 正门独立复放（不触 ④ settings 仍达 `previewReady=true`） |
| 4 | W4-0-G1..G5 五组门全绿 | ✅ | 见 §2.2——正门逐门独立裁定（不信 PR body checklist）全 PASS |
| 5 | 红线四条各有存活的负向断言 | ✅ | 见 §2.3——R1-R4 逐条断言锚点（对 `bbcb8caf3` 在场）+ mutation kill 证据 |

### 2.1 §9 指标：合成 org preview-ready 可达性实测记录

锁 §9 原文（逐字）：「**该合成 org 必须能真的到达 preview-ready**，这正是 §3.2 闭环裁决存在的原因」。

- **实现侧台账（#4543 body，runner 已入仓可复现）**：真 `MetaSheetServer` + plugin-attendance +
  本机真 Postgres；walk 基线 `previewReady=false`/成员 0 → `POST /api/admin/users`（显式
  `attendanceOrgId`，W4-PRE-1 canonical 面）→ groups → members → shifts → approval-flows →
  settings（人工 canonical 确认路径，定向恢复原值）→ 终态精确断言全过：
  `orgActiveMemberCount=1 / groupCount=1 / groupsWithMembers=1 / shiftCount=1 /
  scheduledShiftGroupCount=0 / approvalFlowCount=1 / punchPolicyPosture='customized' /
  previewReady=true`；7 个管理面动作，API 墙钟 0.61s；清理 residue=0。
- **正门独立复放（metricReplay，constructedIndependently）**：审阅者自写 walk（非作者 runner）于
  自建迁移真库复放，**故意不执行 ④ settings PUT**——终态 `previewReady=true`、
  `punchPolicyPosture='default'`——比实现侧更强地独立证明 §3.2「④⑥ advisory 不 gate」闭环裁决
  可执行（否则 ④「待确认」会让指标永远不可达）。
- **测量语义（如实，runner 输出内置同段声明）**：API 墙钟只证**可达性与步数**，不是章程「新 HR
  20 分钟」人类预算的测量（20 分钟为预算上界）；「不输入 JSON 或内部 ID」属性属 UI 流程，由向导
  spec（模板 gallery → 预填 → canonical 表单，零 JSON 输入面）持有，不由 runner 证明。

### 2.2 W4-0-G1..G5 五组门（正门逐门独立裁定，全 PASS）

来源 = `/tmp/pr4541-review-w4-0-v2-gate.md`「逐门独立裁定」表（审阅者真跑 + 独立 mutation，不信
PR body checklist）；测试载体 = `attendance-setup-readiness-w4-0.db.test.ts` +
`attendance-admin-setup-readiness-w4-0.test.ts`（两文件均在 `bbcb8caf3` 且 CI 双点接线在场）。

| 门 | Verdict | 关键证据 |
|---|---|---|
| G1 org 门 + 身份 fixture | PASS | 受托管理员身份 fixture 亲验（无平台 admin 声明/是 A 成员/非 B 成员）；case2 伪造 `orgId=B` ⇒ 403 且零聚合调用；**M9 独立刀**把门谓词 neuter 成 `uo.org_id=uo.org_id` ⇒ case2 翻红——证明 fixture 是真双组织、非假阴性；case3 平台 admin 旁路单列标注不替代 case2 |
| G2 只读证明 | PASS | 真 Postgres 三攻击（裸 UPDATE / writable CTE / 多语句 `SELECT 1; DELETE`）均被 `read-only transaction` 拒绝（db.test `:~372/~380/~392`）；**M2 承重刀**剥除 READ ONLY ⇒ 三 reject 全翻红；负向元断言亲 grep 零首词/正则守卫 |
| G3 ① 两正控 | PASS | 纯本地 org：`orgActiveMemberCount>0` ∧ `directoryLinked=false` ∧ `previewReady=true`（配全 ①②③⑤ 夹具，可抓 `count>0 && directoryLinked` 误接变异体）；钉钉已联通 org 两者均 true |
| G4 ⑥ 三信号不塌缩 | PASS | `notify` 恒三独立字段；worker-env=true+调度器 null ⇒ `not_ready`；调度器非 null ⇒ `unknown`（绝不 ready）；`recipientScopeConfig` 恒 `unsupported`；`previewReady` 在所有 notify 组合下不变（M4a/M4b/M8 三刀锁定） |
| G5 ④ 闭集 | PASS | 亲验负控：只改 `holidaySync.lastRun` / `annualLeavePolicy` ⇒ 仍 `default`（M7：改整包比对 ⇒ 负控翻红）；`default→manual_review_required`（M3：FE 改 `default→ready` ⇒ 翻红）；键名对账解析活文件 + 修复轮值级双 pin（镜像逐值亲验今日无漂移） |

### 2.3 红线四条（R1-R4）——存活的负向断言逐条锚定

全部锚点对 `bbcb8caf3` grep 在场；「存活」= 断言在 main、接入 CI（web-guard run-list + 双 path
filter / plugin-tests 显式文件 + vitest exclude），且各有至少一刀 mutation 亲证翻红（非空转）。

| 红线 | 存活断言（file:~line 于 `bbcb8caf3`） | mutation kill 证据 |
|---|---|---|
| **R1 只读 readiness** | 聚合 `SET TRANSACTION READ ONLY`（`AttendanceSetupReadinessAggregate.ts:~132`，事务首条语句）；G2 三拒绝用例（`attendance-setup-readiness-w4-0.db.test.ts:~372/~380/~392`）；负向元断言禁首词/正则（`attendance-admin-setup-readiness-w4-0.test.ts:~624-646`，聚合模块 + 路由文件双腿） | 正门 M2（剥除 READ ONLY ⇒ 三 reject 全翻红）、M10（注入 live-code `.toUpperCase().startsWith(` + quoted-string `.startsWith(` ⇒ 元断言两腿均红——证 grep 守卫非空转）、M1（聚合前移到授权门前 ⇒ G1「403 zero aggregation」红） |
| **R2 canonical form 深链、禁 hash** | `AttendanceSetupReadiness.spec.ts:~302-315` describe「R2 — canonical deep links only, hash form appears ZERO times」——全状态×双角色遍历断言任何 anchor href 不含 `#`；预览入口为 BUTTON 非 anchor（`:~485`）；① 链 = base-aware path 形 | W4-1 正门刀①（① 深链改 hash 形 ⇒ **7 红**：R2 负向 + resolver 精确 + 平台 admin 链断言） |
| **R3 无副作用 preview** | `attendance-setup-templates.spec.ts:~1028`「R3 (§0, mutation target: any wizard-phase PUT ⇒ red): the FULL wizard/template/prefill walk issues ZERO write-method requests」（mock 层 `writes deepEqual []`，walk 覆盖时区变更/预设/apply/undo/go-shift/双清单跳转/reload） | W4-2 正门刀①（`applySetupTemplate` 内注 `POST /groups` ⇒ **2 红**：R3 + R4 whole-walk belt——修复前该缺口两测试都抓不到，预门立功后闭合） |
| **R4 禁触碰 S7/worker/外发/生产 flag** | `attendance-setup-templates.spec.ts:~603` `R4_BANNED_DOOR_PATTERNS`（settings PUT 门首位；env 层开关无 HTTP 面由 R3 零写超集覆盖，spec 注释逐条点名 §5.4 清单）+ `:~1086` 逐 door 零调用 + settings GET-only belt + whole-walk 零写 belt-2（`:~1106`） | W4-2 正门刀②（`applySetupTemplate` 内注 `PUT /settings` ⇒ **2 红**：R3 + R4 settings door） |

配套完成时态负向（§5.3，R3/R4 的文案面）：壳与弹窗两表面 × zh+en 双腿零「已启用/enabled」——
W4-1 正门刀④⑤（checklist 删 ④ 条目 / EN 'enabled' 回填）与 W4-2 正门 zh/en 双刀各自恰 1 红。

## 3. 实跑总表（每片终态数字，全部本地真跑 + CI 绿）

数字来源 = 各 PR body 逐轮实跑记录 + 门禁记录 comment + 正门报告；不一致处以逐轮记录为准并注明。

| 片 | 终态 head | 实跑（终态数字） |
|---|---|---|
| W4-0 | `ede4d4fc7` | 后端 unit **48/48**；真库集成 **24/24**；FE spec **36/36**；相邻真库回归 11/11；双 typecheck 0 错；独立复核（审阅者自建库）复跑 **48/24/36 全绿**。附：attendance 域真库回归 32 文件 **460/460**（首版 head 实跑；修复轮重跑时 2 既有文件 18 用例失败，经 `git stash` A/B 双跑证明为本地共享库既有污染、与本 PR diff 无关——PR body 如实登记）；web-guard 完整 run-list 首版 30 文件 **601/601** → 修复轮 **604/604**（+3 scope 断言；门记录 comment 终态段记 601/601，与首版数一致，此处按 PR body 逐轮记录并注）。三视口 **N/A**（W4-0 无 UI，owner 追加门禁 5） |
| W4-1 | `5d28b1b5a` | 新 spec：组件 **30** + composable **26**（= 56；门记录 comment 作「新 spec 45+20」，与正门报告实跑数 30+26 不一致，以正门实跑为准并注）；正门实跑 5 文件 **126 tests PASS**（含 W4-0 纯模块 36 / TaskHome 4 / anchor-nav 30）；web-guard 精确 run-list **32 文件 / 660 tests 全绿**（CI 真收集两新 spec）；`vue-tsc -b` 0 错；build 成功；**14 required checks 全绿** |
| W4-2 | `34e82029` | W4-2 spec **45/45**；web-guard 全 run-list **33 文件 / 705/705**（CI 真收集）；`vue-tsc` 0 错；build ✓；W4-0 门回归 **24/24 + 48/48**；§9 指标 walk 全步过 + residue=0；三视口 harness 复跑 **8/8 presence PASS**（scrollWidth==clientWidth 于 1440/1024/390 全三视口） |

## 4. Mutation 总表（实现自报 + 门侧独立，全部 killed → 还原复绿）

| 片 | 实现自报 | 门侧独立 |
|---|---|---|
| W4-0 | 首版 4 刀 + 修复轮 2 刀 + 二轮 3 刀（其一含 db 侧独立复核腿 ①b） | **正门 11 变异全 killed**（报告表 M1-M10，其中 M4 拆 a/b 两刀；门记录 comment 台账 11/11——含 READ ONLY strip、org 门谓词 neuter、G2 grep 双腿、第 15 键注入、整包比对、worker-env 误读）+ **修复轮独立复核 3 刀亲测精确红**（KILLED-CONFIRMED：第 14 键加回 ⇒ 键集锁红 / SAVEPOINT 退裸 try-catch ⇒ 500 复现 / 镜像值改 5 ⇒ 值级对账红） |
| W4-1 | 首轮 4 刀 + 复审轮 4 刀 | **正门 5/5 killed**：①深链改 hash（7 红）②⑥文案改「去配置接收范围」（zh+en 2 红）③受托渲染 admin 深链（1 红）④⑦checklist 删 punch-policy 条目（2 红）⑤EN 'enabled' 回填——验证预门 P2 EN 腿非空转（1 红） |
| W4-2 | 6 刀（含两处修复前 vacuous、修复后翻红的 finding 命中点：shift wire、非 banned-door 写） | 正门报告记 **6 刀 / 7 变异行全 killed**（③ 拆 zh/en 双腿；preview 注 PUT / settings 写 / zh「已启用」/ en "enabled" / 静默覆盖 / 快照恢复 neuter / leave-guard neuter）；门记录 comment 台账作 **8/8 killed**（zh/en 分列 + 双语法零写 belt 单列）——两口径均全 killed，本文按更保守的正门报告刀数记 |

W4-0 正门另记取证纪律一则：首刀 M1 曾误命中同名 S7-5 `directory-readiness` 路由而假 survive，
改锚到 setup-readiness 路由（唯一 403 文案）后 killed——记录以示变异必须锚定被测路由。

## 5. 门禁链路表（预门 findings → 修复 → 正门 verdict，逐片）

| 片 | 实现 head | 三镜预门 findings | 修复轮 | 正门 verdict | 后续 |
|---|---|---|---|---|---|
| W4-0 | `a1ef72e33`（Sonnet，材料库 14 项 reportLedger 四态处置） | **17**（P2×5 / P3×12，含跨镜重复计次） | `c32f62dec`（8 类代码修复 + 1 文档化 + 4 披露待门审） | **REQUEST_CHANGES**（1 P2 / 2 P3 / 1 NIT；G1-G5 逐门独立裁定全 PASS、11 变异全 killed） | 修复轮 `ede4d4fc7`（P2 `viewerIsPlatformAdmin` 第 14 键移除回 13 键恒等 / P3-1 ④ 探测 SAVEPOINT 隔离 / P3-2 G5 键名+值双 pin）→ **独立 Opus 复核 KILLED-CONFIRMED**（三刀亲测精确红 + diff 范围核验 + 独立库复跑 48/24/36 全绿）⇒ **实效 APPROVE 0 P1/P2** |
| W4-1 | `e69bbd7b7`（Fable，UI 重切片） | **10**（P2×2 / 余 P3） | 10 项吸收 = `5d28b1b5a` | **APPROVE 0 P1 / 0 P2 / 0 P3**（1 NIT） | — |
| W4-2 | `a38b3555d`（Fable） | **11**（P2×4 / 余 P3；2 条为同一 roundingMinutes 缺行的重复报告） | 11 项吸收 = `34e82029`（runner 入仓、leave-guard 补路由腿、wire 级 undo 证明补全） | **APPROVE 0 P1 / 0 P2 / 0 P3**（1 NIT） | — |

**预门立功项（挑真实抓到的承重缺陷，非流程装饰）**：

- W4-0：§4.2 `perStep` 嵌套形与锁字面不一致（P2）；RD-3 双 `is_active` 的 `users.is_active=false`
  腿真库 0 覆盖（P2）；G3 纯本地正控无法观测 previewReady、误接变异体不翻红（P2）；真库 sentinel
  位于 `describeIfDatabase` 内部结构性不可能翻红（skip-green 反模式，P3×2）。
- W4-1：**EN-locale ⑥ 帮助文案含 'enabled' 且 zh-only 负向腿对 EN 空转**（P2——完成时态负向若只
  测 zh 即为 skip-shaped）；裸 `<a href="/admin/users">` 绕过 Vue Router、子路径部署 404（P2）。
- W4-2：**§5.2① 确认表格漏 `roundingMinutes` 行但 apply 写它**（owner round-2 附加条件的直接偏差，
  P2）；弹窗 zh 腿从未真渲染（§5.3 负向扫不覆盖弹窗表面，P2——W4-1 教训复现被抓）；§9 指标
  runner 未入仓不可审计（P2）；R3/R4 测试命名超覆盖（walk 未点 go-shift、R4 无整体零写 belt，P2）。

## 6. 三视口资产清点（对 `origin/main` `git ls-tree` 实数）

| 目录 | PNG | 取证驱动 |
|---|---|---|
| `docs/development/assets/w4-1-vnext-20260722/` | **5**（1440×3 态：all-ready-admin / mixed-missing-admin / mixed-missing-delegated；1024 mixed-missing-admin；390 mixed-missing-delegated） | capture-harness ×3（`capture-setup-readiness.mjs` / `setup-readiness-harness.html` / `w41SetupReadinessHarness.ts`） |
| `docs/development/assets/w4-2-vnext-20260722/` | **8**（gallery：1440 all-ready / 1440 mixed-missing / 1024 all-ready / 390 all-ready；dialog：1440 confirm / 1440 applied-pending / 1024 confirm / 390 confirm-no-tz） | capture-harness ×3（`capture-setup-templates.mjs` / `setup-templates-harness.html` / `w42SetupTemplatesHarness.ts`）+ metrics-harness ×1（`setup-metrics-walk.ts`） |

两片均为「拍前真在场断言 fail-closed + 门审逐张目检」取证（harness 入仓、门审本地复跑：W4-1
五图重跑 4 张字节相同、1 张仅抗锯齿级差异；W4-2 8/8 presence PASS）；同视口双角色对照
（1440 admin vs delegated）为 §3① 角色分支的可视铁证；390 档 scrollWidth==clientWidth 实测零横滚。
W4-0 三视口 N/A（无 UI，owner 追加门禁 5）。

## 7. 剩余项（honest 台账）

### 7.1 NIT（每片各一，正门记录，不阻断）

| 片 | NIT |
|---|---|
| W4-0 | §4.4 读放大/限流路径未在本 PR 断言（属既有中间件行为，非本 PR 引入）；另 watch-item（门记录 comment）：db 侧 13 键恒等目前由 P3-1 负例的全量 `toEqual` 附带守护（unit 侧有专锁）——若未来软化为 `toMatchObject` 需补 db 侧专锁 |
| W4-1 | 步① 已 `ready` 时仍渲染修复动作链（属 L210「每步显示修复动作」范围内，导航始终合法；轻微 UX 冗余，可按需隐藏） |
| W4-2 | `AttendanceSetupTemplatePrefillDialog.vue:~391` 头注对「新增 apply 写必红」的表述略过声（row-set deepEqual 结构上抓删行；「新增写且不加行且逃过 snapshot/undo 全表单捕获」的协同变更概率极低） |

### 7.2 审美/真源裁量（owner 可调，各片 PR body 已呈报）

1. **rail 注册位次**：`attendance-admin-setup` 在 Workspace 组 Settings/User Access 之后（非组首）——
   `adminSectionNavItems[0]` 兼任 observer-sync 默认 active，置首会污染「最近访问」信号（§6.1
   明确拒绝访问史信号）；主入口 = 任务首页首位 action（锁 §6.1 指定形态）。
2. **任务首页 primary 让位**：「启用准备」取 people-groups 首位并携 primary，原首位「考勤组」降为
   非 primary（一组一 primary 的既有视觉惯例）。
3. **组织时区真源**：= 本组织已保存考勤组的唯一 distinct 显式时区；0 或多值 ⇒ 强制用户选择
   （fail-closed 不猜）——已在 #4543 body 供 owner ratify 复核。

### 7.3 operator 项（锁 §10：「owner 裁决⑥，不计 UI 完成度」——本文不计入完成定义对账）

- S7 flag 默认 OFF（启用属 operator opt-in）。
- 真实租户视觉复核。
- `DIRECTORY_DEPROVISION_ENABLED` 保持 OFF（锁 header：owner 指示，启用属 operator 决策）。

### 7.4 deferred P3（既有登记，非本波引入）

- **全局守卫 TOCTOU**：deprovision 全局守卫为批量级 check-then-act 无写时重查（org 侧有
  `FOR UPDATE`，全局侧无）——W4-PRE-1d 记录（PRE-1 验证 MD §9），TOCTOU 纪律需构造并发验证，
  随后续周期呈 owner 定级。

### 7.5 其余登记项（如实移交）

- **壳内集成态截图（W4-1 偏离⑥ 的登记欠账，仍开放）**：W4-1 曾把「向导挂在 AttendanceView 管理区
  壳内（rail/section 容器/任务首页往返）的集成态截图」登记为「W4-2 / 波次验证 MD 收口项」；W4-2
  取证 harness 仍为组件级挂载（`w42SetupTemplatesHarness.ts` 只 import
  `AttendanceSetupReadiness` + 弹窗，实证），该**布局**证据在两片均未出——如实移交 owner 处置。
  壳内**行为**面（section 注册/深链/重进/badge）已由挂载 wiring spec 覆盖，且真实租户视觉复核本就
  是 §7.3 的 operator 项。
- **OD-W4-5 已裁 (b)**：W2 规则卡透传英文 API 错误串留 deferred 小刀，不混入 Wave 4（锁条文既定，
  非本波欠账）。
- **OD-W4-7② 残余边界（#4543 body 如实登记，正门复核认可）**：/attendance 内 query 态浏览器回退
  落 route-leave confirm 腿（残余面为零可达实践路径）；feature-flag 收缩强制换 tab 属运维动作非
  用户导航，不经 confirm。
- **W4-0 顺手发现 ×2（pre-existing，#4541 body 登记待 owner/后续 PR）**：
  1. `attendance-w4pre1d-departure-candidate-split.db.test.ts` 在 `plugin-tests.yml:~842` 有显式
     接线，但 `packages/core-backend/vitest.config.ts` 缺对应 exclude 条目（对 `bbcb8caf3` 复核
     仍缺）；
  2. 本地共享真库 `attendance-plugin.test.ts` 跨用例 `system_configs`（shiftCompliance）状态未完全
     隔离，向后污染同进程 `attendance-schedule-dispatch.test.ts`（`git stash` A/B 双跑证明与
     W4-0 diff 无关）。
- **Wave 5 explainability**：维持 DATA-CONTRACT-GATED，不与 Wave 4 并开（锁 header owner 裁定）。

## 8. §11.1 六项记录（本 MD 所在 docs PR）

1. **基线 SHA**：`origin/main` **`bbcb8caf3`**（W4-2 #4543 合入后，2026-07-22）。三切片链
   `7a64424d1`（re-ratify）→ `b9495af18` → `2365d977a` → `bbcb8caf3` 全部在该基线祖先链上。
2. **查重**：`docs/development/` 对 `origin/main` grep `wave4|w4` ——Wave 4 相关仅锁本文档与
   PRE-1 验证 MD，**无既有 W4-0..W4-2 波次验证 MD**；`gh pr list --search "wave4 verification"`
   零在飞；无同名分支。
3. **修改文件**：仅本 MD 一份（纯 docs，零 runtime/测试/workflow 改动）。
4. **IN/OUT**：IN = 三切片交付映射 / §10 完成定义对账 / 实跑与 mutation 台账 / 门禁链路 / 资产
   清点 / honest 剩余项；OUT = 任何锁条款修订、任何 runtime 变更、收官判定与后续波次解锁
   （均属 owner）。
5. **权威数据源**：三 PR body（#4541/#4542/#4543）+ 门禁记录 comment（5049697116 / 5051249094 /
   5052515722）+ 三份正门报告 + `bbcb8caf3` 上代码/资产/workflow 实证；本文不新增任何 runtime
   事实，数字逐个对源核对，不一致处按更保守口径记载并注明（§3/§4 各注）。
6. **完成门**：docs-only——引号仅逐字可 grep 原文；锚点全部对 `bbcb8caf3` 重验（行号为近似值）。
