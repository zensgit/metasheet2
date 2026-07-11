# 多维表 UI-P2-1c Lane-A 迁移扫尾波 — 设计与验证记录(2026-07-11)

**类型**:会话级设计与验证记录(docs-only,零 runtime,可自验)。承接 batch1(#4066)与既有 UI-P2-1c 迁移线(completion-verification-20260707.md 记录的 16/16 clean 首批 + tail 设计锁 #3866),本波把 owner `/goal`「这条线剩余开发」里的 Lane-A presentation-only 迁移**继续推进 5 批**并全部落地。

**安全边界**:本仓公开;本文只覆盖 presentation/迁移类事实,无权限/出口内容。

---

## 1. 目标与刀法

owner `/goal`(2026-07-10):多维表这条线剩余开发,规划+排序+并行+固定节奏,完成给设计+验证 MD,按难度自动选模型(Fable5/Sonnet5,Fable 不可用→Opus4.8),AFK 自动处理。Lane-A = presentation-only 把 bespoke 原生 `<button>` 迁到共享原语(MtButton/MtIconButton),**owner 已 PASS 六次**的固定 bar:逐字节行为守恒 · 每组件 runnable `*-migration.spec.ts` 交互测试 + mutation-red 证据 · 测试卫生(mounts 数组 + afterEach 全卸载 + 残留守卫)· token-only 零新 hex · 全 sharer 迁毕才删 class CSS · vue-tsc 干净 · **每刀独立 adversarial-reviewer 门禁**(非自审)→ 自合线(5 required 全绿 + update-to-main)。

## 2. 本波落地(5 批 / 5 PR 全 MERGED)

| 批 | PR | 范围 | 键数 | 闸 |
|---|---|---|---|---|
| batch3 | #4092 | MetaFieldManager footer/dryrun 切片 · MetaViewManager footer · MetaBasePicker '+' | 14 | MERGE_CLEAN |
| batch4 | #4089 | HistoryCenterModal · ResetConfirmDialog · MetaAutomationLogViewer | 8 | MERGE_CLEAN |
| batch5 | #4105 | MultitableTemplateCenterView · TemplateDetailView · PublicMultitableFormView | 6 | MERGE_CLEAN(+P3 修) |
| batch6 | #4099 | MetaCalendarView · MetaGalleryView 分页 · MetaKanbanView clear | 6 | MERGE_CLEAN |
| batch7 | #4106 | MetaFormView reset(极保守,只 1 键) | 1 | MERGE_CLEAN |

**合计 35 个 bespoke 按钮迁到共享原语**,零行为变更,零新 hex,批批独立对抗闸过。

## 3. 每批的关键取舍(门禁实证)

- **batch3 sharer 部分迁移**:`meta-field-mgr__dryrun-btn` 8 sharers 只迁 4 个单跳,defer 4 个 formula-suggest(accept/reject/regenerate 是 generate 异步 resolve 后才渲染的 behind-flow)。闸核实该 class **无 bespoke CSS** → 部分迁移不产生 double-styling(P3 而非 P2)。
- **batch4 `.stop`/re-emit**:门禁读 MtButton 源码确认 `onClick(evt){emit('click',evt)}` 传同一原生 MouseEvent,mutation 去 `.stop` → 行冒泡 collapse → 断言红,实证 `@click.stop` 语义真被覆盖。
- **batch5 submit 排除 + P3 硬化**:三 view grep 零 `<form>`/零 `type=submit`;门禁发现 active-category overlay 靠 stylesheet source-order 取胜(specificity 平手),**当波内修复**——`.mt-button.category-btn--active` 提到 (0,3,0) 稳胜 `.mt-button--ghost` (0,2,0)。
- **batch6 sharer-CSS split(本波最大风险)**:Calendar 的 today-btn 与 held 的 create-btn/day-create **原共享一条多选择器规则**;PR **split 非 delete**——移除 today-btn 选择器、create/day-create 声明块字节等价保留,迁后无 `.today-btn` CSS 规则(grep 实证)→ 无 double-styling、不破 create 外观。
- **batch7 保守铁律**:MetaToolbar 整体跳过(in-file 注释确认 popover 内件是前 MtPopover 刀刻意保留的 deliberate-verbatim);MetaFieldValidationPanel 整体跳过(5 个 close-× glyph = T1-adjacent,#3866 未 ratify);MetaFormView 只迁 reset(submit/nav-soft-tint/link 全排除)。**只迁 1 键,不碰任何 gated 面**。

## 4. gated 排除纪律(零违反)

tail 设计锁 #3866(PROPOSED 未 ratify)定义的 T1-T5 gated 面本波**一律不碰**:
- **T2 soft-tinted create**(Gallery create-btn/empty-action · Kanban header-add×2/add-btn · Calendar create/day-create 保守 held)— 全部保留 bespoke,门禁独立核实无一被迁。
- **T1 close-×/glyph**(各 dialog 的 __close · FieldValidationPanel __remove)— 未动。
- **T3 link-shape**(__btn-inline · __link-btn · reset-entry)— 未动。
- **type=submit**(FormView __submit · 各表单提交)— 未动(非逐字节等价)。
- **deliberate-verbatim**(MetaToolbar popover 内件)— 整组件跳过。

## 5. 事故与纪律(诚实记录)

- **gh 账号漂移 → 403**:落地 #4099 途中 gh active account 漂移到 `rhe91709-netizen`,`UpdatePullRequestBranch` 被拒。切回 zensgit 修复,并给落地循环加**每轮账号守卫**(见 [[gh-auth-account-drift-403]])。
- **#4106 无关 real-DB flake**:required `test (20.x)` 在 `multitable-permmatrix-b1-yjs-bridge-flush-realdb.test.ts` flaky 失败——姊妹 PR #4105 同 job 绿 + origin/main 近三次该 workflow 全 success + batch7 纯前端不可能影响后端权限 real-DB 测试 → 三方证据判 flaky,rerun 清除。
- **热 main 跑步机**:strict + enforce_admins,每次 update-branch 重跑 8 分钟 test(20.x),main 每几分钟一 commit → 多 PR 同 arm 互抢绿窗饥饿。改**慢 cadence(4 分钟)+ 串行聚焦**让 test 跑完;merge-queue(owner 已在别线拍板)落地后此类磨损消失。

## 6. 剩余与不主张

- **Lane-A 剩余**:tail 设计锁 #3866 的 T1-T5 全部**等 owner ratify + 变体决定**(尤其 T2 需 MtButton 加 plain/tinted 变体——当前只有 primary/ghost/danger,属 Opus-reviewed 原语扩展)。这些是设计裁量,不在自合线。
- 不主张 Lane-A「完成」——clean 单一 class + cleanly-mountable 的**未 gated 面本波已扫净**;剩余全部落在 #3866 的 gated 尾部,等 owner。
- 不主张任何 gated 项已解锁;不碰权限/AI/删除逻辑(batch 只动按钮 + CSS)。

## 7. 方法学

- **实现=Sonnet5,闸=Opus adversarial-reviewer,主循环=Opus4.8**;每刀实现→独立对抗闸→自合线,6 次闸全一轮 MERGE_CLEAN(含 1 次当波内 P3 硬化)。
- **impl-lane 勿 advisor 再次实证**:batch1(上会话)+ batch5 impl + #4092 gate 三次代理 stall 均发生在 advisor 调用前;复活时明令跳过 advisor 后全部顺利交付。impl/gate 代理提示已内置「绝不 call advisor」。
- **并行会话纪律**:全程独立 worktree,不触碰他人 worktree/canonical 树;5 批文件无重叠(component vs view 分层),门禁逐一核实零文件交集。
