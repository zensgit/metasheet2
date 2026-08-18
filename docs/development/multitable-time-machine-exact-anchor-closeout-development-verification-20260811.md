# 多维表 Time Machine（exact-anchor Revert/Reset）开发线收口 — 开发与验证记录（2026-08-11）

> 载体 PR **#4654** `codex/tm-closeout-integration-20260728`；收口净增量 head `ad8d56c36f`（在 carrier 追平当前 main 的 `5af9e04a6` 之上 9 个 commit）。
> **安全边界（全程不变）**：所有 recovery flag **default-OFF**；authority triggers 出厂 **DISABLED**；本记录只覆盖**开发收口**，不含 O-2 启用阶梯 / staging cutover / 生产开关——那是独立的 owner/ops 决策，本轮**未**触碰。

## 0. 背景与本轮定位

这条线（让多维表能把一张表恢复到某个精确操作锚点，含记录数据 + 权威链接）此前是**四层 Draft 栈** #4472→#4474→#4478→#4519（以及更早的冻结栈 #4417/#4445/#4446）。两轮独立对抗审 + owner 复核在真 PostgreSQL 上**构造证明**了一组缺陷（三类死锁、FK 语义、marker 面、containment 失明、no-oracle 两接口未拆等）。#4654 是把这些收口到 **current main** 的单一 carrier；本轮工作 = 在 #4654 上**闭合门禁与 owner 复核确认的全部缺陷**，把它做到「默认关闭、可落地」，并按代码难度分派 Fable5/Sonnet5/Opus5 执行。

**范围三分（决定"完结"的确切含义）**：
- **合入阻断集**（必修才能默认关闭干净落地）：两接口拆分(治理BLOCK)、fail-closed 假绿、containment 假绿、死代码/假绿测试、marker golden。
- **启用加固集（O-2，触发器出厂 DISABLED ⇒ 合并时打不到）**：40001 平台分类、foreign-fence 可用性、饥饿。**本轮交付了其中代表性 + 数据完整性最关键的部分**，其余枚举留启用相位。
- **Phase D（未启动）**：retention 后归档 / 大批量异步恢复 / 完整 T-state 浏览 / 跨表恢复 / 删除记录精确复活。

## 1. 收口净增量：9 个 commit（各带模型分派与证据）

| # | commit | 内容 | 模型 | 证据 |
|---|---|---|---|---|
| 1 | `b4da2fae82` | containment helper 强制 `meta_links.foreign_record_id` **无任何 FK** 不变量（conrelid/conkey/attnum，不看名/目标/ON DELETE）+ 变异；workflow 注释与 SHA/sentinel 同步 | Fable5 | 真库三态：干净 PASS / NO ACTION FAIL / CASCADE FAIL / 移除 PASS；变异证承重 |
| 2 | `5ba2f03823` | golden：authority substrate `'unavailable'`（出厂 DISABLED 姿态）⇒ recovery **fail-closed 零写** | Sonnet5 | 真实机制（强制 9 触发器 DISABLED）+ **正控**（ENABLE 时同场景四表真被改）+ 变异（去守卫→完整破坏性写入放行 RED） |
| 3 | `9f325a34f8` | 平台写路径 40001 → 可重试 409（admin-users 6 处）；AuthService 有界重试 + 回填不伪造内存权限；**注册路径改为诚实抛可重试错（不再假报注册成功）** | Sonnet5 | 4 新测试 + 4 变异 RED（含「注册成功但无角色」bug 钉死）；复用既有判别函数非新造。**口径收窄（REQUEST_CHANGES 3 轮）：本 commit 只消除了「假报成功」——`createUser()` 已提交的用户/别名/权限仍残留、角色写失败不整体回滚 ⇒ 真正的注册原子性（同事务）留 O-2，见 §7** |
| 4 | `92bbf77829` | **两接口拆分** `preliminaryFullRead`(不取锁)/`finalLockedFullRead`(锁证据绑定)（owner 已裁形状，此前只交付行为半边）| Sonnet5 | 行为保持 56/56·148/148·70/70·tsc 干净；真库 drift guard；**advisor 复核后自纠**「arity 非对称编译保证」过强声明，改以真库测试为护栏 |
| 5 | `f439500a05` | golden：automation lock/unlock marker operation 可被选作 `anchorOperationId`；空 op 密封不留幻影 endpoint | Fable5 | 幻影锚前提经查已被 operation-ledger 空 op 跳过消解（未造第二道同类闸）；G1/G2 + 变异打 backstop RED |
| 6 | `820fe4bd4e` | **foreign-fence**：统一 fence 所有涉及 sheet（source+foreign）按 id 全序、任何行锁前一次取完 ⇒ foreign 写者不再把 recovery 误判 preview-drift | Opus5 | 构造竞态：source-only 6/6 abort→foreign fence 0/6；三类死锁正控 no-40P01；**强制 source-first→40P01 复现**（全序承重）；source-hunk cp-revert→生产 apply preview-drift |
| 7 | `a043acb985` | 跨切片修复：failclosed golden 的 applyExactAnchorRecovery input 改用两接口字段 | 主循环 | 修复 P2-1(旧 base 接口)与 P2-5(改名)的集成断裂；由 P2-2 报告发现 |
| 8 | `1fc4595700` | CI 三点接线：3 新真库 golden 进 vitest 排除 + plugin-tests 真库步 + wiring 守卫白名单 | 主循环 | wiring 守卫 `node --test` 19/19；防「被触发≠被验证」的手动-only golden |
| 9 | `ad8d56c36f` | 删死判据 `isLiveLinkTargetForeignKeyViolation` + 合成约束单测（FK 已从 schema 移除、调用点不可达）| Sonnet5 | fresh schema 查 pg_constraint 无该 FK；保留 live projection/retryable-conflict/`link-integrity`；tsc 干净、真库 296/296 |

## 2. 七类历史缺陷收口对照（本轮针对的靶子）

1. **P1-A recovery↔权限写 ABBA** — carrier 已换模型（shared-writer/exclusive-recovery 租约 + 全局 NOWAIT，无人等待⇒无环）。
2. **P1-B recovery↔recovery 锁序倒置** — foreign-fence(commit-6)统一全序 fence 消除。
3. **P1-C 普通写↔普通写** — 属触发器施加的平台级串行化；40001 分类(commit-3)交付代表性路径映射，全平台清扫留 O-2。
4. **P2 `meta_links` FK** — carrier 已移除 FK 迁移；本轮补 containment 不变量(commit-1)防其以任何形状复现 + 删残留死判据(commit-9)。
5. **P2 marker mint 面** — automation lock/unlock 现传 ledger；commit-5 补 anchor-selectable golden + 幻影锚防护。
6. **containment 失明** — commit-1 让 helper 真查 FK 形状（此前只查 trigger/function）。
7. **no-oracle 两接口** — commit-4 交付结构拆分（治理 BLOCK 解除）。

## 3. 集成验证

- **切片级**：每切片在独立 worktree 本地真库验证 + 变异自证（见 §1 证据列）。
- **跨切片**：唯一集成断裂（P2-1 golden × P2-5 改名）由 P2-2 诚实报告、commit-7 修复。
- **CI 接线守卫**：`node --test multitable-exact-anchor-ci-wiring.test.mjs` = 19/19（3 新 golden 两点接线 + 「waiter matcher 保持 ≥2、拒绝 ≥1 弱化」）。
- **完整 required CI**：首推 `ad8d56c36f` 时 4 红（Sealed-export S5×2 / S5-S6A gate / integration-guard）经逐层查证=**s6a-pin 跨线耦合非 TM 缺陷**（sealed-export `package-provenance.cjs:290` 冻结 `plugin-tests.yml`，我接线 3 golden 改其 run-list ⇒ digest 变；纯 main `0287b250b3` 上 provenance PASS、我的树 FAIL，仅此一处 pin 变）——修=同步重算 `evidenceFiles.pluginTestsWorkflow` `6e6653d6…`→`a698464126…`（commit `4822e512c3`），provenance 转 OK。修复后 required CI 全绿（含 integration-guard 恢复）。
- **独立 Opus 对抗终门 @ `ad8d56c36f`（净增量 9 commit）= CLEAR，0 P1 / 0 P2**：8 个恢复真库套件**一起**跑 142/142；6 个变异各红对应守卫（authorityLease-unavailable / P25 post-lock swap / FK seed / run-list 删项 / register re-throw / empty-op seal）证全部承重非空转；**foreign-fence 三类死锁全 NO-40P01 且 in-test CONTROL 强制 source-first→40P01**（全序承重）；跨切片修复证实（failclosed 在 P25 拆分下通过）；死代码零残留 + live-link 55/55；skip-green 控制 sentinel 抛错非绿跳；CI-wiring 守卫在 required `test(20.x)` 内；对新 main 无 gate-file 漂移。findings 全 P3/NIT（见 §4）。MD=`/tmp/pr4654-regate-claude-20260811.md`。
- **已知 pre-existing 失败**：`multitable-record-form.api.test.ts`（mock harness `Unhandled SQL`，baseline 同样红，不碰 meta_links，非本轮回归；非真库 required 步）。

## 4. 剩余开发（按相位）

**O-2 启用加固（触发器 DISABLED 时打不到；启用前必做）**
- **注册原子性（O-2，非默认关闭合并阻断）**：`createUser()` 先提交，`assignUserRoles()` 在另一事务有界重试；忙碌耗尽抛具名可重试错，但用户/别名/权限已存在、路由最终 500、再注册报「已存在」。O-2 正解 = 用户创建 + 角色写入**同事务** + 整事务有界重试 + 失败后四类数据归零验证 + 随后重试成功。
- **40001 全平台清扫**：本轮覆盖 admin-users + AuthService 代表性路径；剩余枚举写者（`directory/deprovision-*`、`invite-accept-writes`、`user-activate`(mapActivateError)、`attendance-admin`、`spreadsheet-permissions`、`permissions`、`roles`、`directory-sync`、`dingtalk-oauth`、`routes/auth.ts` 注册 handler 塌 500）。
- **foreign-fence 残余（可用性非死锁）**：共享查找表形状（FK KEY SHARE vs 行锁 FOR UPDATE），pre-existing 未拓宽；根治需围栏所有 link-in sheet（无界）或弱化记录锁（drift 检测改动）。
- **饥饿/可用性**：写者持共享租约时 recovery 立即 busy ⇒ 持续普通写下 recovery 可能长期抢不到排他租约（非死锁）；需退避/优先级/维护窗口口径。

**Phase D（未启动，需先立 D1 设计锁；`v3.7 §12` 8–12 pw）**：retention 后不可变归档 + 完整性校验 + 大批量异步恢复 + 进度/重试 UI。

**其它产品能力（未开发）**：完整 T-state 浏览（服务端 `/point-in-time` 只列存活记录=一处路由级改动；前端全仓零消费者=整条读路径从零；#4205 设计锁不在 main）；跨 sheet 原子恢复（无设计）；删除记录精确复活（当前 fail-closed；逻辑可逆运营通常不可逆）。

## 5. 旧栈处置（收口后）

- 七个旧 Draft（#4472/#4474/#4478/#4519 + #4417/#4445/#4446）内容已被 #4654 在 current main 上取代——**均已标 superseded 关闭（2026-08-12）**。
- **#4446 先抽 resurrect 参考件落 main**（77 行 apply + 5 golden + 594 行 realdb + owner 亲抓**一处** P1 级修复；见 §8 勘误）——它是本线唯一把 trash 行互斥/锚点态 vs 终态快照/链接重建幂等做对的范例，从未接线，丢的是参考实现非已交付能力。

## 6. 安全边界重申

**部署 ≠ 启用**：截至 2026-08-12，#4654 镜像已落 **prod + staging**（3 条 recovery 迁移均已执行），但装入的是 **inert 基座**——flags 全 default-OFF、9 触发器出厂 DISABLED、无 `meta_links.foreign_record_id` FK。本轮**无 flag 翻转 / 无 trigger 启用 / 无 auto-merge**（镜像发布是常规部署，不是能力开关）。O-2 启用与 flag cutover 仍是独立 owner/ops 决策；双主机 inert 姿态由 postdeploy-full `target=both` PASS 证实（§8）。

## 7. 门后 REQUEST_CHANGES 轮次（2026-08-11/12，owner 三轮独立复核）

独立终门（Opus，绑 `ad8d56c36f`）判 CLEAR 后，owner 逐轮独立复核（多为在真库/真环境复现），逐条闭合：

- **轮 1（最终 head 专项，owner「你先审阅么」促成）**：终门绑旧 head，其后我 solo 推了 pin 修复（改 sealed-export 安全清单）+MD。补的独立门绑最终 head `67edb98443` = CLEAR，并独立判定 solo pin 修复为「正确维护非安全削弱」（新 pin==真文件 sha256/verifier `.cjs` 对 main 逐字节相同/只改一行/manifest 强制 exact-ID-set/pin 变异证承重）。收 2 条 P3 comment/doc drift（`56db337a2f`）。**教训：终门 verdict 是 head-scoped，gate 后再 solo 推 commit 必须重新独立审最终 head，不可用「转移」推理替代。**
- **轮 2（3 P2 + 2 P3）**：① default-inertness 代码侧——containment env-check 从 2 flag 扩到 **4 flag**（+`MULTITABLE_HISTORY_CONTIGUITY_STRICT` +`MULTITABLE_ENABLE_WRITER_FENCE`）；② release gate——merge origin/main 追平（落后 0、merge-tree CLEAR、s6a-pin 仍匹配、CI 全绿）；③ 第三处 FK 注释（`multitable-cross-base-automation-delete-lock.test.ts:176`，前轮只扫 src 漏 test）；④ PR body 收口更新段。
- **轮 3（1 P2 + 2 P3）**：① **4-flag containment 未被 CI 钉住**（owner 删 WRITER_FENCE 后 8/8 仍绿=假开关空转）⇒ 在 required 的 `multitable-recovery-schema-containment.test.mjs`（跑于 plugin-tests.yml:179 → test 20.x）补 **FLAGS 精确契约**：断言 `FLAGS` 集合恰等于四项 + 两处 `for f in $FLAGS` 循环均存在；**变异证：删任一 flag 或任一循环即红**（删 WRITER_FENCE → 9→8/1）；② line 47「the two flags」→「four flags」；③ 本 MD 更新 + 注册口径收窄（见 §1 commit 3 / §4）。

**收口后续（2026-08-12 结算，明细见 §8）**：① staging/prod 容器 4 flag 均未启用——**已由 postdeploy-full `target=both` PASS 证实**（run `31651250987`，双主机同刻同指纹）；② 合并决定（安装 DISABLED 平台授权触发器 DDL = owner 治理授权）**已合入** #4654 @ `12f1f8c466` + 旧七 Draft **已全 superseded 关闭**（#4446 先抽 resurrect 参考件）；③ **仍待（后续独立）**：O-2 启用相位（注册同事务原子性 + 40001 全平台清扫）；发布链 SSH host-key pinning（`docker-build.yml` 等，见 §8 发布侧残留）。

## 8. 合并落地与后续（2026-08-12）

- **#4654 MERGED @ `12f1f8c466`**（squash，手动合并、无 auto-merge；owner 明确治理授权「接受 8 张平台授权表安装 9 个 DISABLED triggers + 6 functions」；≠授权启用）。合并前 required 全绿、behind 0；`test (18.x)` 一次 attendance-integration flake（非本线；`test (20.x)` 同 suite 绿）重跑即绿。main 现含 `RECONSTRUCTION_CAUSALITY_LANDED = true` + containment helper + 两模式 containment workflow。flags 全 default-OFF、triggers 出厂 DISABLED = **inert 落地**。
- **合并前主机证据（predeploy-flags）**：run `31609975258`（`workflow_dispatch`，只读，`Contents: read`），target=both、mode=predeploy-flags：`metasheet-backend`(prod) + `metasheet-staging-backend`(staging) 四 flag（SHEET_REVERT/PIT_RESET/HISTORY_CONTIGUITY_STRICT/WRITER_FENCE）在 running env 与 next-restart compose 均 CONTAINED；`VERDICT: PASS (predeploy-flags)`（明写 schema NOT verified）。
- **两模式 containment（对应 owner 收尾计划 stage 4-5）**：`predeploy-flags`=运行态+next-restart 四开关（当前镜像即可，已 PASS）；`postdeploy-full`=另加 9 disabled triggers + 6 function 指纹 + 无 `meta_links.foreign_record_id` FK（需部署新镜像后逐主机跑）。**postdeploy-full 双主机 PASS 已取得（2026-08-12，见下条部署台账）。**
- **#4446 resurrect 参考设计**：抽为 `multitable-4446-resurrect-reference-design-20260812.md`（supersede #4446 前保全）。勘误：#4446 只有**一处** owner 亲抓 P1（`a5a154f17a`，打包 FOR UPDATE 锁 + outbound 重建 + trash DELETE）；`NOT EXISTS` 幂等为自评 P3。且 #4446 的锚机制**明确拒绝墙钟**（非「基于墙钟锚点」——那是它取代的旧 PIT-reset 路径）；它 reference-only 的真因=从未接线 + at-anchor **inbound** authority 从未建（=#4654 `INBOUND_UNPROVABLE` fail-close 根因）。
- **部署台账（2026-08-12，实际顺序 = 生产先行，非原计划的 staging→prod）**：#4654 合并**自动触发** `Build and Push Docker Images` run **`31615811214`** → 部署 `12f1f8c466` 到生产（`metasheet-backend`），3 条 recovery 迁移成功执行、`/health` build==`12f1f8c466`。其后依次：
  - **生产 postdeploy-full** run **`31650980676`**（`target=production`、`mode=postdeploy-full`、只读、host-key pinned）= **PASS**：4 flag CONTAINED（running + next-restart）、recovery-authority-triggers 9/9 disabled（`8c1be0b0…`）、functions 6/6（`14c180aa…`）、meta_links FK 0/0。
  - **staging 部署** run **`31651154126`**（Attendance Staging Window Runner，`action=deploy`、`deploy_sha=12f1f8c466…`、`set_window_env=none`）→ `12f1f8c466` 落 `metasheet-staging-backend`，同 3 条迁移成功执行、health build 匹配。
  - **双主机 postdeploy-full** run **`31651250987`**（`target=both`）= **PASS**：`metasheet-backend` 与 `metasheet-staging-backend` **同刻同指纹**（triggers `8c1be0b0…`、functions `14c180aa…`、FK 0/0、4 flag 全 CONTAINED）——即 owner 收尾计划要求的「最终双主机同刻证据」。
- **旧七 Draft**（#4417/#4445/#4446/#4472/#4474/#4478/#4519）**已全 superseded 关闭**；#4446 先抽 resurrect 参考件 @ #4885 `b4492c3047`。
- **发布侧残留（P1，下一次生产部署前修）**：`docker-build.yml:95,169` 用 `StrictHostKeyChecking=no` 承载部署命令+密钥 ⇒ 须改 `DEPLOY_KNOWN_HOSTS` + `StrictHostKeyChecking=yes`（containment-check 与 staging-window-runner 已 pinned，可参照）。同类未 pin 尚有 `attendance-remote-{env-reconcile,log-snapshot,metrics,preflight,upload-cleanup}-prod`、`yjs-staging-validation`（是否一并纳入由 owner 裁范围）。
- **后续独立能力（不计入本次收尾完成）**：O-2（注册同事务原子性 + 40001 全平台清扫 + 启用阶梯）、retention 后恢复、整表 resurrect、归档/大表异步恢复。
