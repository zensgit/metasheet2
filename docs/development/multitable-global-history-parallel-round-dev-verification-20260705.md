# Multitable Global History / Version-Restore — 固定节奏并行开发轮:设计 + 验证(2026-07-05)

**Round scope:** 以 #3542 verified-state-map + decision-menu 为总目标池,取其中全部**非闸门**可建项,三车道并行建设、逐个评审、顺序落地。所有 owner-gated 项(flag 启用、T-source picker、破坏性 tier FE、不可逆语义 slice)保持关闭,本轮不触碰。

**Cadence & model policy(本轮实际执行):** 编排/评审/落地 = 主会话(高推理模型);三条实现车道 = 并行隔离 worktree 子代理(标准实现模型);每车道 build → 主会话人审(mutation/安全/纪律逐点核验)→ auto-merge + keep-sync 落地。

---

## 0. 本轮落地清单

| # | PR | 内容 | 结果 |
|---|---|---|---|
| 0a | #3541 | fix: config-revision retention sweep 接入 scheduler(T9 D4 one-knob-ages-both,本线最后一个 runtime 缺口) | MERGED `05a8593aa` |
| 0b | #3542 | docs: verified state map + owner decision menu + stale 状态头修正 | MERGED `c4533ec9c` |
| A | #3606 | test: PIT 加固金测试 — 跨 strategy token 拒收矩阵 + route-level golden | MERGED `1393f1c13` |
| B | #3609 | feat: config-tier 验收 harness(uncreate / config-undelete / permission-revert)+ runbook | MERGED `50f7f77fd` |
| C | #3608 | feat: Global History Center 内联 masked per-field diff | MERGED `84675392f` |

---

## 1. Lane A — PIT 加固金测试(#3606)

**依据:** state-map §5 明示的两项 test-hardening 建议。

**设计:**
- **Golden 1(多记录 resurrect 强制失败原子性)— 已存在于 main**:核验 #3351 的 test `(m)` 与建议等价(2 记录 undelete,trigger 强制第 2 条失败,断言全量回滚)。不重复建;改为 mutation-proof:临时把单事务拆成每记录一事务 → `(m)` 在 `liveRow(U)` 断言处变红(观察到部分 resurrect),复原。readiness-refresh 文档 §2.2 仍列其为"建议补" = 文档过时(见 §4 文档修正)。
- **Golden 2(跨 strategy preview-token 拒收)— 新建**:8 个 `type` 判别 preview-identity 家族共享同一 HS256 secret,签名/过期校验不区分家族,唯一防线是 `type` claim。
  - 单元:8×7=56 全序对矩阵,逐对断言 `valid:false` + `reason==='wrong_type'` 精确匹配;每家族 round-trip sanity;家族数 pin(`===8`,防静默增删)。
  - route-level `(n)`:合法签名的单记录 restore-preview token 提交给 PIT undelete execute 路由 → `409 PREVIEW_IDENTITY_INVALID`(`wrong_type`)+ 零写入断言 —— 证明防线接在路由上,不只在单元契约里。

**验证:** 一次性 docker Postgres + 全量迁移真跑:realdb 套件 **15/15**、单元 **72/72**;两个 mutation 红灯证据(拆事务 → (m) 红;禁用 config-restore 家族 wrong_type → 恰好 7 对矩阵红,65/72);`tsc --noEmit` 干净;纯测试改动 +117,零 runtime 触碰。**P1 发现:无** —— 所有 verify 均先查 `type`,56 对全部拒收。

## 2. Lane B — config-tier 验收 harness(#3609)

**依据:** state-map §4a 三个 built-but-unsmoked tier;沿用既定 rollout 节奏(harness → owner 跑 staging 验收 → 才谈启用/FE)。

**设计:** 单脚本 `scripts/config-tier-acceptance.mjs`,三 tier 各自独立可 SKIP:
- per tier:flag-off 契约(preview+execute 双 403 `<TIER>_DISABLED`,flag 状态由服务器首个真实响应探测,同一二进制适配两种 staging 姿态)→ flag-on 走查(throwaway sheet 上铺前置历史 → preview 断言 masked 形状+token → typed-confirm execute → 后续读回验证效果)→ 关键负例(无/错 confirm 400;stale token 409 `PLAN_DRIFT`/`ID_COLLISION`/`GRANT_DRIFT`;越级 422,自动化 20260630 runbook 的 5 个 smoke 点)。
- 安全:只写自建 base+sheet(结束删除);`EDITOR_TOKEN` 仅作 throwaway sheet 上的降级对象,缺席则整 tier 干净 SKIP;token 从不打印;任一 FAIL → exit 1。
- 全部断言码 source-traced 至 `univer-meta.ts`/`config-restore.ts` 并与三个 real-DB golden 套件交叉核对(含 `GRANT_DRIFT` 409 先于越级 422 的执行顺序,~8379 < ~8385)。

**Runbook** `multitable-config-tier-acceptance-runbook-20260705.md`:env 契约、per-tier 场景表、停机条件、证据采集;明示 **prod flag 不因本工作改变**、每 tier 的 staging 翻转是独立的 owner 签核动作、**harness 尚未 live-run(首跑即 staging 验收)**。

**验证:** `node --check` 通过;码表溯源(零杜撰);品牌名扫描 CLEAN。**诚实缺口:** 本地 live-run 未达成 —— 卡在两个与本改动无关的预存 dev-DB 迁移链 bug(`tables_owner_id_fkey` 类型不匹配;`zzzz20260411120100_approval…` 中被 `.catch()` 吞掉的错误毒化事务),均已回滚无残留、已在 PR #3609 评论中记录供 owner 单独处置。

## 3. Lane C — Global History Center 内联 per-field diff(#3608)

**依据:** state-map §4b 唯一明示"Optional"的非闸门产品项。

**设计:** `HistoryCenterModal` 批次详情展开处,按 post-mask 的 `changedFieldIds` 逐字段渲染(本代码永不扩集):双侧有值 → before→after 行;仅 after → *set* 徽章(复用 `record.restorePreviewSet`);仅 before → *clear* 徽章(复用 `record.restorePreviewUnset`);双侧皆无 → masked 占位(新 key `record.historyDiffMasked`,en/zh)。只读只显示:零 API 变更、零新请求、LOCK-3 掩码不动;count 摘要保留;新元素带 `data-test` 选择器。

**Wire-shape 锚定(防 wire-vs-fixture 盲点):** fixture 对齐真实载荷 `HistoryChange`(`types.ts:352`)⟷ `loadHistoryBatchDetail`(`history-projection.ts:~552`)。**如实记录:今天后端 `before` 恒为 `null`**(T1b hydration 是未来服务端工作),故专门有一条 spec 覆盖这个真实形状(全部渲染为 *set*);T1b 落地后完整 before→after 行自动点亮。masked 形状当前后端不会产生(masked id 会先被剔出 `changedFieldIds`),作为防御性渲染路径在代码注释中如实声明。

**验证:** 新 spec 文件 6 条(normal/masked/set/cleared、count 摘要不变、未知 fieldId 回退、今天的 `before:null` 真实形状);相关套件 **51/51**;`vue-tsc -b` 干净(项目真命令,非手搓 `--noEmit`);i18n 走既有 `meta-record-labels` 模块(1 新 key + 2 复用,无跨模块 helper 重声明,无硬编码)。评审修正 1 处注释函数名引用(`historyFieldDiffs`→`changeFieldDiffs`)。

---

## 4. 文档修正(本轮顺带)

- `remaining-dev-plan-20260625` §4a/§5 stale 状态头 → 已由 #3542 inline 修正(undelete-execute 是 BUILT #3307)。
- `gated-remainder-readiness-refresh-20260629` §2.2 仍把"多记录 resurrect 原子性 golden"列为建议补 → 实际已由 #3351 test `(m)` 落地;本 MD 即为该修正记录(不回写历史文档正文)。

## 5. 未动的 owner 决策菜单(闸门原样)

与 #3542 §4 完全一致,本轮零触碰:**(4a)** 7 个 default-off flag 的逐个启用(`PIT_RESET` 带 STOP-SHIP 条件:retention 关闭或 trash 保留 ≥ 审批窗口);**(4b)** history-anchored Reset T-source(产品决策)、3 个破坏性 config tier 的 FE;**(4c)** lossy retype / tombstone-capture / record undelete 2b(逐项签核);**(4d)** 已删字段列数据的值级恢复 = 不可能(如实记录)。

**建议的下一步顺位(供 owner 决策,非本轮工作):** ① owner 用 #3609 harness 跑三 tier 的 staging 验收(每 tier 独立);② 若通过,逐 flag 决策启用;③ T-source 方向定夺(推荐:挂到既有 Global History 时点面);④ 4c 逐项签核。

## 6. 本轮方法论记录

- **fast-moving-main 落地竞态**:40s 轮询"等绿→抢合"在 `strict + test(20.x)≈10min + main≈10min/commit` 下会饿死(一轮 30 次未中);改为 **GitHub auto-merge(squash)+ keep-sync 循环**(落后即 rebase 重推并重新武装),#3541/#3542/#3606/#3608/#3609 全部由此落地,零手工抢窗口。
- **并行三车道零冲突**:各车道基于 origin/main 独立分支、隔离 worktree、互不触碰文件;评审串行、落地由 auto-merge 并行推进。
- Golden 1 的"先查 main 再建"避免了重复建设 —— 与 stale-doc trap 同源:**动手前 primary-source 核验,文档头不作数**。
