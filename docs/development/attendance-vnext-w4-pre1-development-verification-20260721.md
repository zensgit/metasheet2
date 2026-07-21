# 考勤 vNext W4-PRE-1 开发与验证记录 — 2026-07-21

> 切片：**W4-PRE-1 `user_orgs` 生产维护写路径（org-membership lifecycle）**——Wave 4 重启序
> （锁 §10，owner errata 裁定 #4513）的前置票。规格真源 = 锁 §3.3「W4-PRE-1 票面」五项。
> 交付 PR：**#4521**（分支 `claude/w4-pre1-user-orgs-lifecycle-20260721`，最终 head `a3d05837f`，
> 合入 main = **`e20371b1a`**，基 `57d89bc1d` 即 errata 合入后 main）。
> 门禁：Sonnet 实现 → 三镜预门 → 修复轮 → **Opus 对抗正门 APPROVE — 0 P1 / 0 P2 / 2 P3 / 1 NIT**
> （门记录 = #4521 comment-5038977540；正门报告 `/tmp/pr4521-review-w4-pre1-gate.md`）。

## 1. 交付物（票面五项 → 实现映射）

| 票面项 | 实现（锚点对 `e20371b1a` 实证） |
|---|---|
| 1. 建人写点盘点 + 已知权威 org 同事务维护 | **同事务写者×2**：admin 建人 `packages/core-backend/src/routes/admin-users.ts:3295`（`INSERT INTO user_orgs`，位于 `:3233` `transaction()` 内；org 对提交的 group/shift 校验）；目录 admission `packages/core-backend/src/directory/directory-sync.ts:5097`（DT-HARDEN-02 SAVEPOINT 内；org 自 `directory_integrations` NOT-NULL-FK 行解析，orphan fail-closed） |
| 2. org 不可知路径显式策略 | **策略记录×2（行为验证零写）**：部署级注册 `AuthService.ts:299`、OAuth JIT `dingtalk-oauth.ts:615`（测试 seam `:1132`）——注释+文档+测试三件齐，不静默猜 org、不塞 `'default'` |
| 3. 测试三件套（真库） | `tests/integration/attendance-w4pre1-user-orgs-{admission,directory-sync,policy}.db.test.ts`：fresh-DB（含同事务原子性失败注入）/ upgrade（zzzz 回填行不破坏，两写者各有）/ two-org（计数互不串）。CI 双点接线：`plugin-tests.yml:823-825` + `vitest.config.ts:382-384` |
| 4. 双 `is_active` 口径 | 计数口径 = `user_orgs.is_active AND users.is_active`（先例 `index.cjs:15532-15541`）；写者硬编码 `is_active=TRUE`（修复轮 P2：避免镜像建人时 `isActive` 造成后激活用户永久不计数的 stuck-false），inactive→reactivate 真库回归腿锁定 |
| 5. canonical surface 具名+行为验证 | **`POST /api/admin/users`（`admin-users.ts:3072`）**——经该面建人 ⇒ 同事务 `user_orgs` 行在（集成测试走真实路由，非直接 INSERT 模拟）。= 重 ratify 回填锁 §3① 修复动作的唯一合法来源 |
| （附）W4-0-G3 两正控预跑 | 纯本地 org（零 `directory_account_links`，count>0 可算且 `directoryLinked=false`）+ 目录已联通 org——在 SQL 层验证计数语义（`setup-readiness` 端点属 W4-0，测试如实限定；锁 §9 原句「两正控在 W4-PRE-1 完成门先跑一遍，W4-0 完成门复跑」，W4-0 收口时复跑） |

## 2. 实跑记录（全部真库/真命令，修复轮后最终数）

| 套件 | 结果 |
|---|---|
| 三新文件（独立库 `metasheet_test_w4pre1fix20260721`） | **15/15**（门记录 comment 完成门对账段为修复轮前快照 13/13、505 为 503——差值 = 修复轮 +2 条 inactive→reactivate/upgrade 腿；正门独立复跑确认 15） |
| plugin-tests.yml「Run attendance integration tests」CI 步逐字复跑（35 文件） | **505/505** |
| 受影响真库面（directory-sync/admin-users 相关 11 文件） | 80/80 |
| 受影响单测面（admin-users-routes 等 5 文件） | 109/109 |
| core-backend 全量 no-DB 单测 | 5808/5808 |
| 双 typecheck（core-backend tsc + apps/web vue-tsc） | 绿 |
| 正门独立复跑（reviewer 自建库） | 3 文件 15 测试 + 单测 109 + 共存面 58 + tsc，全绿 |

## 3. Mutation 表（实现自报 3 刀 + 正门独立 6 刀，全部 killed→还原复绿）

| 刀 | 红腿 |
|---|---|
| admin-users 写点 neuter（`if (false && …)`） | fresh-DB/原子性/two-org/upgrade 4 腿精确红；org-不可知负控腿正确保持绿 |
| admin-users org 参数→常量 | two-org 互不串腿红（count 2≠1） |
| INSERT 前注入 `DELETE FROM user_orgs`（reset-bug 模拟） | upgrade 回填保护腿红（legacyRow=null） |
| **INSERT 挪到 `transaction()` 提交之后（正门加刀，原子性承重）** | **原子性腿精确红、fresh-DB 写腿保持绿——「同一事务」是被测行为非注释** |
| directory-sync 写点 neuter | 该文件写腿红 |
| directory-sync org 参数→常量 | 该文件 two-org 腿红 |
| （修复轮自证）is_active 硬编码回退为镜像 `isActive` | inactive→reactivate 腿红（5+1） |

## 4. 门禁证据链

- **预门三镜**（票面保真/测试诚实性/事务-SQL 审计，只读）：抓出 **P2 伪造锁引文**（杜撰句以引号归于锁文——记录保真零容忍，正是本锁 ratification 被吊销的问题类别）与 **P2 stuck-false membership**，另 6 P3（死锚点×4、directory-sync 缺 upgrade 腿等）；修复轮全部吸收（1 P3 有理拒绝，正门复核维持）。
- **正门（Opus adversarial-reviewer）**：独立复跑 + 亲自动刀 6 mutation + **盘点完备性对抗扫描**（双语法 `user_orgs` 写面 + 全 `INSERT INTO users` 建人面 + wecom/plugin）零漏写点 ⇒ **APPROVE 0 P1/P2**。
- 完整台账：#4521 comment-5038977540。

## 5. 剩余项（honest）

| 项 | 级别 | 处置 |
|---|---|---|
| ① 闭合判断不由 #4521 宣布——写路径存在且正确 ≠ 锁 §3① 判据自动满足 | 语义边界 | 属 owner re-ratify 终裁（本 MD 所在 PR 即其证据包） |
| 仅经注册/OAuth JIT 建人的 org 计数为 0（两路为显式记录的不写路径） | 已知残差 | ① 如实显示 missing（fail-closed 方向正确）；如需覆盖属后续独立票 |
| admin-users `ON CONFLICT (user_id,org_id) DO UPDATE` 分支生产不可达（建人 user_id 为新 UUID） | 正门 P3 | 记录待 W4-0/后续周期处置，不为死分支在已过门 head 翻代码 |
| 「含未来新增」写点无常设机械守卫 | 正门 P3（修复轮有理拒绝，正门维持定性） | 过程性义务：re-ratify 及各波收口时人工盘点（本次正门已扫描一轮零漏） |
| G3 计数助手为测试手写、与未来生产聚合重复 | NIT | W4-0 建 `setup-readiness` 聚合时消解 |
| 远端 CI 于实现报告时点 13/16 绿（3 项 in progress） | 监测时延 | 合入前 required checks 全绿后由 auto-merge 落地（事实：#4521 已合入 `e20371b1a`） |

## 6. §11.1 六项（本切片）

1. 基线 SHA：`57d89bc1d`（errata #4513 合入后 main）。漂移账：`6ea0ccfab..749ba92d0` 考勤面零漂移（预检）；`749ba92d0..57d89bc1d` 即 errata 本身（docs-only）；`57d89bc1d..e20371b1a` 即 #4521 本身。
2. 查重：全仓双语法扫 `user_orgs` 写面——#4521 之前唯一生产写者 = 一次性迁移回填 `zzzz20260114110000`；之后 = 回填 + 本票两写者，正门完备性扫描确认无其他。
3. 修改文件：core-backend 两写点 + 两策略注释 + 三 .db.test.ts + CI 双点 + 受影响单测 mock 同步 3 文件；零迁移、零 apps/web、零 plugin-attendance。
4. IN/OUT：票面五项全 IN；①闭合宣布/re-ratify/W4-0 明示 OUT（锁 §10 序）。
5. 唯一写路径：`user_orgs` 生产写者 = admin-users:3295 + directory-sync:5097（+历史回填）；权限真源不变。
6. 完成门：票面五项 + 三件套 + G3 预跑 + Opus 门 0 P1/P2 —— 全过（见 §2-§4）。
