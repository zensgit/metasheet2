# 多维表 Global History / PIT-restore — gated 剩余项 readiness refresh（送审）— 2026-06-29

> **This is a dated readiness refresh; canonical source remains current `main` + the existing `multitable-global-history-*` docs.** 本文不另立权威、不替代任何 canonical 文档，仅在某一时点把「gated 剩余项」的真实状态核新一遍。
> 产出方式：ultracode workflow，5 个 assessor 各自对一项 gated 剩余项**逐项核 `origin/main` 代码 + canonical 已提交 verification docs**（primary-source，不信 working-tree 草稿）。
> **最佳决策声明（owner 不在场）**：主线已完成到 **flag-gated readiness**（runtime / docs / acceptance）；**prod enablement 与 product entry 仍需逐项 sign-off**。剩余全是 gated 决策。我**没有** enable 任何 flag、没有做 Reset-UI 的产品取舍、没有 build 任何不可逆语义——这正是这条线一贯的「单项 sign-off」纪律（"开 T8-2" 是被一句具体指令授权的）。本文是给你回来后**逐项授权**用的 readiness 依据，非破坏、不改代码。

## 0. 结论（一句话）
**没有「未开发的大块」。** 五项剩余全部是三类门：**环境启用 flag**、**Reset-UI 产品取舍**、**仍未授权的不可逆语义**。其中只有 **1 个真正的工程前置**（permission-revert 并发门），其余皆为 owner 的运营/产品/授权决定。

## 1. 总览

| 项 | 门类 | main 现状（已核） | 可完成性 | 谁来定下一步 |
|---|---|---|---|---|
| **PIT_RESET 启用** | env-enable | runtime + 单事务原子性 + UI 入口（#3301）全 merged，default-off | partial | **环境 owner**：trash-retention STOP-SHIP 确认 + flag-on live smoke + 决定置 true |
| **PIT_UNDELETE 启用** | env-enable | T8-1 Revert-undelete 全 built（#3307/#3310/#3311 + 4 项 pre-rollout 修复），default-off | partial | **环境 owner**：补 flag-on live smoke（+建议补「多 resurrect 强制失败」原子性 golden）后启用 |
| **T9-W 5 个 config flags** | env-enable | 每 tier 的**安全子集**全 built + real-DB 验证，default-off | partial | **逐 tier owner 启用**；其中 **permission-revert 有工程前置（见 §2.5）** |
| **Reset-UI T-source** | product-entry | picker/wiring 已 DONE（#3301，最小 datetime-local 版） | partial | **产品 owner**：是否升级为 history-anchored picker（安全更优）；+ rollout |
| **真·lossy retype / 值级 field undelete** | unauthorized-semantic | 已删字段的列值/links/auto-number **无 tombstone，字节已不存在** | partial（含 impossible 区） | **owner 单项 sign-off**：是否要「向前」捕获能力（不救已删数据） |

## 2. 逐项

### 2.1 PIT_RESET 启用（env-enable）
**现状**：runtime merged + default-off（flag `MULTITABLE_ENABLE_PIT_RESET`，univer-meta.ts:9500；off → 两路由 403 `RESET_DISABLED`）。survivor revert + post-T 软删进回收站，**单 `pool.transaction` 全或无**、版本-CAS、`FOR UPDATE`、identity 绑 delete-set（drift→409）、size ceiling 413、admin-only、typed `confirm:'reset'`。UI 入口 #3301 已接（gated on `pitResetEnabled`）。
**「完成」= 运营放量决定**，非工程：①目标环境 **trash-retention STOP-SHIP** 确认（回收站留存 ≥ 批准窗口，否则「可恢复软删」承诺不成立）；②补 **flag-on live smoke**（入口真渲染 + 真 grid 跑通一次 reset）；③环境 owner 显式置 true + 重启，回滚=关 flag（瞬时 403-inert）。
**风险**：回滚不对称（已执行的 reset：删的可从回收站手工恢，**revert 的不自动回退**，需再 Revert-to-T）；放量粒度只到「按环境」（无 cohort/per-sheet，靠 size ceiling + admin + 回收站兜底）。
**验证**：goldens a–j（含 PIT-2 mutation-proven + 单事务原子性 golden h）已 CI-wired（plugin-tests.yml:233，DATABASE_URL sentinel 防静默 skip）；FE spec + context 契约 + 06-26 owner-run staging acceptance PASS。**开口**：flag-on live render 未验。

### 2.2 PIT_UNDELETE 启用（env-enable）— §4a 旧「未设计」已过期
**现状**：T8-1 **Revert-undelete 全 built**，default-off（flag `MULTITABLE_ENABLE_PIT_UNDELETE`，univer-meta.ts:9343；off → `UNDELETE_DISABLED`）。复活「T 时存在、现已删」的记录：用 `reconstructRecordsAtT` 的**完整未掩码 T-snapshot**、原 id、**outbound `meta_links` 重建**、`source='restore'` revision、**单事务全或无、resurrect 先跑**；identity 绑 `resurrectScopeHash`（drift→409）、`canDeleteRecord` floor、typed `confirm:'undelete'`。**inbound 链接不重建**（设计选择 L4-A：当对端记录下次保存时自然回现，golden f 锁定），非缺陷。design-lock #3307 ratified；4 项 pre-rollout 评审修复（统一 cap 413 / resurrect schema-drift 守卫 / `source='restore'` / 无 partial-重排）全部已修。
**「完成」= 启用运营决定**：补 flag-on live smoke（建议先在 sandbox，destructive-adjacent）。
**验证**：goldens a–l（13 个）`multitable-undelete-pit-realdb.test.ts` 已注册 plugin-tests.yml（CI-proven，本地无 postgres）。**开口（doc 自陈）**：goldens 非本地跑（重点看 golden e resurrect 写入）；**「多 resurrect 强制失败」原子性 golden 建议补**（当前单事务由构造保证全或无，但未 golden 钉死）；TOCTOU `FOR UPDATE` 路径未 golden 覆盖；flag-on live smoke。

### 2.3 T9-W config-restore 5 个 flags（env-enable，逐 tier）
**每 tier 的安全子集全 built + real-DB 验证、default-off。** 边界（务必逐 tier 看）：
- **Tier1 `SHEET_CONFIG_REVERT`**：sheet_config 的 conditionalReadRules / rowLevelReadPermissionsEnabled revert——**完整**；FE-reachable；低边际风险（canManageSheetAccess 本就能改）。
- **Tier2 `FIELD_RETYPE_REVERT`**：**仅 schema-only / scalar-safe 无损** retype-revert（排除 formula/lookup/rollup/link/attachment/button/autoNumber/created*/modified*；裸 UPDATE meta_fields，**不迁移单元格值**，golden c：`'hello'` revert 到 number 仍存活）。**待 owner 确认 option I 即 Tier-2 契约**；原设计的「lossy retype」(option II 值变换) **未 build**。
- **Tier3 `CONFIG_UNCREATE`**：撤销「建字段/视图」= **drop**（destructive，**无 v1 undo**：列值永久消失）；HMAC planHash→409 PLAN_DRIFT；typed confirm；**无 FE**（client 不发 confirm）。
- **Tier4 `CONFIG_UNDELETE`**：撤销「删字段/视图」= **仅定义 recreate**（列值/links/auto-number **不恢复**，preview note 明示）；**无 FE**。
- **permission-revert `PERMISSION_REVERT`**：**仅去升级**（escalation→422）；在 `meta_sheets FOR UPDATE` 内复检 live grant 后才 apply；**无 FE**。
**⚠ 工程前置（非 runbook 勾选项，owner 不可豁免）**：permission-revert 的**硬并发门**——**前向 grant/revoke 路由不取 sheet 锁**，并发前向写可把一次「已复检的去升级」交错成净升级；启用前须让前向路由取锁（或条件/版本化写）+ 补**双写者并发 golden**。
**「完成」**：逐 tier 启用 + 给 3 个 typed-confirm tier 补 FE（今天无）+ Tier2 确认 option I + permission 并发门。
**验证**：5 套 real-DB goldens 全注册 plugin-tests.yml（Tier1 closeout / Tier2 6 goldens / Tier3 14 / Tier4 15 / permission a–l）。**完成各项额外需**：逐 tier flag-on live smoke；permission 加锁后双写者 golden；typed-confirm tier 的 FE e2e。

### 2.4 Reset-UI T-source（product-entry）— 06-26「blocked」已过期
**现状（已纠）**：06-26 doc 的「blocked on product decision」**已被 #3301 取代**（merge-base 确认）。`ResetToPointPicker.vue` 已 built（自由 `datetime-local` 取 T），已接入 `MultitableWorkbench.vue:68`（gated on `pitResetEnabled`），ResetConfirmDialog 不再 inert。**但**#3301 只发了**最小版**，**显式 deferred** 该 doc 自己推荐的 **history-anchored T-source**（从 Global History 时间线落到真实变更点再 reset），标注「Alternative (deferred, 让 owner steer)」。
**「完成」= 2 个 owner 决定**：①产品取舍——保留自由 datetime-local，还是投入 history-anchored picker（**安全更优**：把 T 吸附到真实变更点，减少误删面）；②rollout——置 flag + flag-on live smoke。工程剩余（seam swap / i18n / 摆放）小且跟随产品选择。
**验证**：picker/wire/onDone spec 在 multitable-web-guard CI；context 契约锁 `pitResetEnabled`；vue-tsc 0。**开口**：flag-on live render 未验。

### 2.5 真·lossy retype / 值级 field undelete（unauthorized-semantic）— 三区边界
**IMPOSSIBLE（已毁数据的真 undo）**：恢复**已删字段**的列值 / `meta_links` / auto-number。删字段是 `UPDATE meta_records SET data = data - $fieldId`（univer-meta.ts:5956，**无 tombstone**），delete revision 只记字段**定义**，links/序列硬删——**字节不存在任何地方，没有设计能恢复**。根因是快照不对称：**记录**值有快照（meta_records_trash + revisions）所以记录-undelete 能恢复真值；**字段列删**的值无处捕获。
**ALREADY POSSIBLE（已发、flag-gated、default-off）**：字段/视图**定义**undelete（#3343）、schema-only 无损 retype-revert（#3254）、去升级 permission-revert（#3361）、记录级值 undelete/revert。
**COMPLETABLE 仅「向前」（净新建 + owner sign-off）**：捕获-at-delete 的**字段值 tombstone**（类比 meta_records_trash）→ 让**未来**删字段可恢值；捕获-at-transform 的 pre-image → 让**未来**的 lossy retype 可逆。**都救不了任何已删数据。**
**下一步**：在 canonical doc 记死「值级 field undelete / 救已毁数据 = impossible」（区别于已发的定义-only undelete）；若要「向前」能力，owner **单项**授权两条净新破坏-捕获 slice，各带 link-rebuild 完整性（§4a）、U-L8 损失-oracle 门、per-tier default-off flag、写对称 cap、typed confirm、单事务原子性。**在授权前一律 fail-closed（422/403）。**

## 3. 评估中纠出的 stale 点（canonical 理解刷新）
- 06-25 remaining-dev-plan **§4a「undelete-execute 待设计」** → 已被 **#3307 PIT undelete** 取代（built，default-off）。
- 06-25 **§4b「field undelete 422 today」** → 已被 **#3343 定义-only undelete** 取代。
- 06-26 **reset-ui「blocked on product decision」** → 已被 **#3301 picker/wiring** 取代（但产品取舍被 deferred，仍是 live owner call）。
→ 这些只说明 canonical docs 也在动；**以当前 main 代码为最终锚**。本文不另立权威，建议作为**一次性 readiness 刷新**附在现有 Global History 线下（或留 /tmp）。

## 4. 建议的 sign-off 顺序（逐项，非一锅端）
1. **工程前置先清**：permission-revert 的**前向路由加 sheet 锁 + 双写者 golden**（唯一 owner 不可豁免的工程项）。
2. **最低风险先启**（FE-reachable / 无损）：Tier1 sheet_config、Tier2 field-retype（先确认 option I）——非 prod 环境 + flag-on live smoke。
3. **PIT_RESET / PIT_UNDELETE**：补各自 flag-on live smoke（PIT_RESET 另确认 trash-retention STOP-SHIP）→ 环境 owner 逐环境启用。
4. **Reset-UI 产品取舍**：owner 在「自由 datetime-local」vs「history-anchored（更安全）」二选一。
5. **destructive 无 FE tier（uncreate/undelete）**：接受不可逆边界 + sandbox smoke + 补 FE 再面向用户。
6. **真·lossy retype / 值级 undelete**：仅当确需「向前」能力时，单项授权净新捕获 slice；已毁数据 impossible，记死即可。

## 5. 落地
本文为 dated readiness refresh docs PR；仅新增文档，未改代码、未启用任何 flag、未做 Reset-UI 产品取舍、未 build 不可逆语义。它不另立权威，只记录本次核验结果；后续仍需 owner 逐项点单。
