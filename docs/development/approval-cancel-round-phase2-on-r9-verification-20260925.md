# 审批撤销 phase 2(C-2 + 白名单投影)搬到 r9 — 验证(2026-09-25)

**状态:候选(CANDIDATE)。** 所有读数本地实跑(零 PR ⇒ CI 从未跑过)。一次性库 `ms2_laned_c2onr9_20260925`(`createdb -U postgres -O ms2testbed`,建前 `pg_database` 0 行);`DATABASE_URL` / `ATTENDANCE_TEST_DATABASE_URL` / `SMOKE_DATABASE_URL` / `E2E_S6A_PROVISIONING_DB_URL` / `E2E_S6A_RUNTIME_DB_URL` 全指向它并逐个以 `current_database()` 断言;`MIGRATION_EXCLUDE` 逐字取自 `plugin-tests.yml` `Run DB migrations`;迁移 `EXIT 0`(止于 `zzzz20260920120000_data_source_live_id_binding_lock`)。工作树为一次性 `laneD-c2onr9`。全程零 `git checkout -- <path>` / `reset --hard` / `stash`;mutation 一律 `cp` 备份 → 改 → 跑 → `cp` 还原 → sha256 比对。

## 1. 重放核对

| 项 | 读数 |
|---|---|
| 源区间 `b8b71539a..65c1d2cdb` | 81 提交、0 merge |
| 重放 `d8e08ac16..<新头前一提交 1c3f5b475>` | 81 提交、0 merge、0 冲突(`cherry.log` 零 `CONFLICT`) |
| `(cherry picked from commit …)` 尾注 | 81 / 81 |
| 逐对 `git patch-id --stable` | **81 / 81 相同** |
| 改动文件集 | 源 18 文件 = 重放 18 文件(`diff` 空);`--stat` 同为 18 files / 15011 insertions / 76 deletions |
| 作者行(重放 81 个)| 54 × `zensgit <77236085+zensgit@users.noreply.github.com>`、25 × `Merge Rehearsal <rehearsal@local.invalid>`、2 × `zensgit <daviderguya4854@gmail.com>`(`cc5d8fa06` / `8de99dfdf` 的重放)—— 与源逐个相同 |
| committer 行(重放 81 个)| **81 × noreply**(源区间 79 条 rehearsal committer 一条未带来) |

## 2. 差异的差异清单(`git diff b8b71539a 65c1d2cdb` vs `git diff d8e08ac16 1c3f5b475`)

**内容层**:18 个文件的两份 diff 各自去掉 `index …` 与 `@@ …` 行后逐字节相同(每个文件的 interdiff 为 0 行)。**行号层**(只有 `@@` 头)如下;原因栏三选一:冲突解法(本轮零)/ r9 已改的上下文 / 行号漂移。

| 文件 | 块数 | 漂移块 | 源 `@@` → 重放 `@@`(旧,新)| 原因 |
|---|---|---|---|---|
| `docs/development/approval-cancel-round-phase1-design-20260918.md` | 1 | 0 | 同 | r9 改了该文件(+636,§3.5 等追加在文末),C-2 的块在其前,无漂移 |
| `docs/development/approval-cancel-round-phase2-design-20260918.md` | 1 | 0 | 同(新文件)| — |
| `docs/development/approval-cancel-round-phase2-verification-20260918.md` | 1 | 0 | 同(新文件)| — |
| `packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts` | 4 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts` | 12 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/core/attendance-cancellation-execution-port.ts` | 1 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/index.ts` | 2 | 1 | `-2749,6 +2753,20` → `-2794,6 +2798,20`(第 1 块 import 无漂移)| r9 在其前加了 method-override 中间件(+59/−2) |
| `packages/core-backend/src/routes/approval-history.ts` | 4 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/services/ApprovalBridgeService.ts` | 2 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/services/approval-bridge-types.ts` | 2 | 0 | 同 | r9 未动 |
| `packages/core-backend/src/services/ApprovalProductService.ts` | 14 | 13 | `-550,6 +569,25`→`-624,6 +643,25`;`-1031,6 +1069,142`→`-1105,6 +1143,142`;`-8604,6 +8778,8`→`-8678,6 +8852,8`;`-8835,6 +9011,481`→`-9363,6 +9539,481`;`-10201,9 +10852,47`→`-10729,9 +11380,47`;`-10213,6 +10902,19`→`-10741,6 +11430,19`;`-11812,6 +12514,97`→`-12340,6 +13042,97`;`-11857,6 +12650,24`→`-12385,6 +13178,24`;`-11952,6 +12763,13`→`-12480,6 +13291,13`;`-11964,6 +12782,20`→`-12492,6 +13310,20`;`-11973,6 +12805,18`→`-12501,6 +13333,18`;`-12147,6 +12991,24`→`-12675,6 +13519,24`;`-12612,6 +13474,49`→`-13140,6 +14002,49`(第 1 块 import 无漂移)| r9 已改的上下文:`:321-332` 常量、`:443-509` 席位不可归属类型、`:556-618` `assertCancelRoundSeatsEligibleInTxn`、`:8703-9218` `createCancelRoundInstance`(reading-(a) + P2-1);≤`:8604` 的块漂 +74,`createCancelRoundInstance` 之后的块漂 +528。C-2 的块没有一块落在 r9 的 hunk 内 |
| `packages/core-backend/src/types/plugin.ts` | 1 | 0 | 同 | r9 未动 |
| `packages/core-backend/tests/integration/approval-cancel-round-lock-order-census.db.test.ts` | 2 | 0 | 同 | r9 未动 |
| `packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts` | 8 | 0 | 同 | r9 未动 |
| `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts` | 1 | 0 | 同 | r9 未动 |
| `packages/core-backend/tests/unit/approval-product-service.test.ts` | 4 | 0 | 同 | r9 未动 |
| `packages/core-backend/tests/unit/attendance-w4c3b-external-transaction-entry.test.ts` | 1 | 0 | 同 | r9 未动 |
| `plugins/plugin-attendance/index.cjs` | 6 | 5 | `-35137,6 +35172,33`→`-35195,6 +35230,33`;`-35166,17 +35228,6`→`-35224,17 +35286,6`;`-35202,12 +35253,31`→`-35260,12 +35311,31`;`-35773,6 +35843,29`→`-35831,6 +35901,29`;`-38567,15 +38660,7`→`-38625,15 +38718,7`(第 1 块 `emitEvent` 处无漂移)| r9 在 `:25645-26458`(考勤组访问)加了 +58 行,C-2 的后 5 块整体漂 +58;r9 的 `:44959-45868`(薪资周期导出)在 C-2 全部块之后 |

r9 的改动无一回退:`git diff --name-only b8b71539a d8e08ac16` 的 397 个文件在新头上全部保留(重放只碰上面 18 个文件,且内容层与源逐字相同)。

## 3. 语义差清单

见设计 MD §3(逐函数:席位推导 **改**、资格重验 **改**、种子可见性 **改**、`index.ts` **改**;策略 / 窗口推导、结算、返还 / 冲正 helper、W4 边界、读面、Resolver、rbac **未变**;对每项给出「C-2 的假设是否仍成立」)。函数体比对方法:从两侧文件按签名抽取到同缩进的闭合行后 `cmp`。

## 4. 读数(全部在新头树 + 一次性库上)

| 跑 | 读数 |
|---|---|
| 真库 13 件(`EXPECT_DB=1`,integration config,`--no-file-parallelism`):`approval-cancel-round-{redemption,creation,lock-order-census,outlet-guards,node-timeout-effect,seed-template-visibility,seat-guards,attendance-fk-migration}` + `approval-history-authz-guard` + `approval-lock9-process-attachments-realdb` + `approval-instance-readability-s1` + `approval-instance-readability-s1-consumers` + `approval-bridge-redaction-regression` | **13 files / 244 passed / EXIT 0**(redemption 34、creation 64、lock-order 27、lock9 34、s1 32、outlet 7、node-timeout 5、seed-visibility 7、s1-consumers 10、seat-guards 3、fk-migration 11、history-authz 8、bridge-redaction 2)。r9 读数不回退:creation 64 = r9 的 64;seed-visibility 7 = r9 的 7;redemption 34 = 投影候选 r2 的 34 |
| 追加两条交互腿后重跑 `redemption` + `creation` | **2 files / 100 passed**(redemption 36 = 34 + 2、creation 64)|
| 两条交互腿单选(`-t 'r9 × phase 2'`)| 2 passed / 34 skipped |
| 单元 9 件(`CI=true`,无 DB):`approval-history-routing` / `approval-instance-readability-plm-id-agreement` / `approvals-bridge-routes` / `approval-product-service` / `approval-cancel-round-ci-wiring` / `approval-cancel-round-plugin-mirror-constant` / `approval-admin-jump-service` / `attendance-w4c3b-external-transaction-entry` / `approval-cancel-round-dormancy-unreachable` | **9 files / 282 passed** |
| core-backend 无 DB 全量(`unset DATABASE_URL`、`CI=true`、`--pool=forks --poolOptions.forks.maxForks=3`)| **985 files passed / 175 skipped (1160);16045 passed / 1615 skipped (17660);0 failed;EXIT 0**(135.7 s)。对照:r9 栈顶(含 RC + H-5 的单元件)门审读数 16040;本分支 = r9 + C-2 的 16 个新 `it()`、不含 RC / H-5 的单元件,两组人口不同,不作差值归因 |
| `tsc --noEmit -p packages/core-backend/tsconfig.json` | **EXIT 0 / 0 行** |
| `apps/web` `vue-tsc` / web 测试 | **NOT RUN**(`apps/web` 零改动)|

## 5. F-4 / F-5 真 HTTP 探针(一次性库;探针文件为 redemption 件的临时副本,跑完即删,未提交)

环境:`NODE_ENV=test`,integration 配置下 `RBAC_TOKEN_TRUST=true`(rbac 守卫会信任令牌内的 `perms`;本探针的非特权令牌 `perms=[]`、`roles=['member']`,所以守卫落到 DB 查询)。库身份:`{"db":"ms2_laned_c2onr9_20260925","usr":"ms2testbed"}`。

目录与授予(本 head):`permissions.code LIKE 'approvals:%'` = `approvals:admin` / `approvals:admin-data` / `approvals:admin-templates` / `approvals:analytics` / `approvals:write`;**无 `approvals:read`**;`user_permissions` 中 `approvals:read` 行 = **0**;夹具申请人的 `user_permissions` = `['approvals:write']`(夹具自带的 `grantApprovalWriteForIntegrationActor`)。

**已兑现轮**(port 替身返回 `reversal {reversed:11, lots:1, unrecoverableExpired:0, alreadyReversed:false}`,轮 `applied`):

- 申请人、rbac 旁路令牌(dev-token `roles=admin`)、本实例参与者:`GET /api/approvals/<id>/history` → **200**,approve 行逐字节
  `{"id":"574",…,"actor_id":"wi13-apr-lanedprobe-…","action":"approve",…,"to_version":1,"metadata":{"cancellationOutcome":{"status":"cancelled","reversal":{"reversed":11,"lots":1,"unrecoverableExpired":0,"alreadyReversed":false}}}}`;`created` 行无 `metadata` 键。`GET /api/approvals/<id>` → **200**,DTO 末尾 `"cancellationOutcome":{"status":"cancelled","reversal":{…}}`,无 `cancelRoundCloseReason` 键。
- 申请人 `roles=member`、零 `perms`:`/history` → **`403 {"error":"Insufficient permissions"}`**;详情 → **`403 {"error":"Insufficient permissions"}`**。
- 审批人 `roles=member`、零 `perms`:两面均 **`403 {"error":"Insufficient permissions"}`**。
- 陌生人 `roles=member`、零 `perms`:两面均 **`403 {"error":"Insufficient permissions"}`**。

**已过期轮**(原单 approve 锚点回拨 200 天 > 90 天窗口;审批人 `approve` 触发系统收口,动作响应 `"status":"rejected"`):

- 该轮申请人、rbac 旁路令牌:`/history` → **200**,系统收口行逐字节
  `{"id":"578",…,"actor_id":"system:approval-cancel-round","actor_name":"system:approval-cancel-round","action":"reject",…,"to_status":"rejected",…,"metadata":{"cancelRoundCloseReason":"round_expired"}}`;详情 → **200**,DTO 末尾 `"cancelRoundCloseReason":"round_expired"`,无 `cancellationOutcome` 键。
- 另一轮的申请人(旁路令牌但非本实例参与者):两面均 **`404 {"ok":false,"error":{"code":"APPROVAL_NOT_FOUND","message":"Approval instance not found"}}`**(参与者围栏)。
- 申请人 / 审批人 / 陌生人 `roles=member`、零 `perms`:两面均 **`403 {"error":"Insufficient permissions"}`**。

结论:白名单投影在本 head 上完好(有读权者拿到的字段正确且只含 `cancellationOutcome` / `cancelRoundCloseReason`);**谁能读到**由 `rbacGuard('approvals','read')` + 目录 + 授予决定——本 head 目录无该码、零授予 ⇒ 未授予的普通申请人今天拿到 **403**。这是 owner 开放项(§3-22 第 22 项、§J-14/18 授予对象)的现状,不是本分支要修的缺陷;本分支未改守卫、目录或授予。

席位臂实测(D-4(a)):已兑现轮的 `approval_assignments` = `[{assignee_id: <审批人>, assignment_type: 'user', node_key: 'cancel_approval', is_active: false}]`;§6 两条腿另在 reading-(a) 还原席位与跳过节点席位上读到同样的 `'user'`。

## 6. Mutation 台账(对两条交互腿,`-t 'r9 × phase 2'`;每格 `cp` 备份 → 改 → 跑 → `cp` 还原 → sha256 与原件相同)

| # | 改动 | reading (a) 腿 | 跳过节点腿 | 读法 |
|---|---|---|---|---|
| M-X1-restore | `createCancelRoundInstance` 席位子查询 `node_actor_user_seats` 由 `a.metadata->>'delegatedFrom'` 改成 `a.assignee_id`(席位回到行 actor 本人)| **红**(`expected [ {…} ] to deeply equal [ {…} ]`:席位 [D] ≠ [A])| 绿 | reading-(a) 还原承重,且与跳过腿隔离 |
| M-x1-skip | `!nodesSkippedByJump.has(nodeKey)` → `true` | 绿 | **红**(`409 CANCEL_ROUND_SEAT_INELIGIBLE {ineligibleCount:1, reasons:['seat_unresolvable']}`)| P2-1 豁免承重,且与 reading-(a) 腿隔离 |
| M-B-history | `routes/approval-history.ts` SELECT 的 `metadata->'cancellationOutcome'` → `NULL::jsonb` | **红**(`expected +0 to be 1`:零 carrier 行)| **红**(同)| 历史端点 key path 承重 |
| M-G-bridge | `ApprovalBridgeService.getApproval` 的 `Object.assign(dto, await readCancelRoundDurableProjectionV1(…))` → `void (await …)` | **红**(`expected undefined to deeply equal { status: 'cancelled', … }`)| **红**(同)| 详情面(刷新路径)投影承重 |
| M-A-detail | `ApprovalProductService.getApproval` 的同名块 → `void (await …)` | 绿 | 绿 | 按构造:`GET /api/approvals/:id` 走 bridge 实现;该块由既有 P2-1 腿(expired / blocked 动作响应的 `cancelRoundCloseReason`)钉住,与投影候选门审 r1 / r2 的读法一致。本轮未重跑 r1 / r2 的 M-A / M-B2 / M-C / M-D / M-E / M-H 网格(源提交原样重放,判别点未变)|

## 7. 署名核(runbook v3 §6 检查块,无 PR ⇒ 跳过 `gh pr view` 行,`RANGE=origin/main..<头>`)

| 头 | 提交数 | `id.out` | `mail.out` |
|---|---|---|---|
| 重放头 `1c3f5b475`(追加提交前)| 170 | **48** = r9 带来的 21(8 × `author Merge Rehearsal` + 13 × `author zensgit <个人邮箱>`)+ 源区间 cherry-pick 原样带来的 27(25 × `author Merge Rehearsal` + 2 × `author zensgit <个人邮箱>`,即 `cc5d8fa06` / `8de99dfdf` 的重放);committer 行 **0** | **1** = `72284432e`(源 `993b462fb` 的重放)正文里 ``using this worktree's `Merge Rehearsal <rehearsal@local.invalid>` `` 那一行(runbook §6 唯一已知例外)|
| 新头(含本分支 1 个新提交)| 见 §7.1 | 新提交在 `id.out` / `mail.out` 零命中 | 同上 1 行 |

按 owner §3-31 (b),带来的作者行在合并窗口重签,本分支不改写作者。

### 7.1 新头读数

(提交后由本文件同一提交之后的私有记录 `reviews/impl-c2-projection-on-r9-round1-20260925.md` 登记新头 40 位与检查块读数;本文件随该提交一起落下,不能自引其 SHA。)

## 8. NOT RUN(如实)

- `apps/web` 的 `vue-tsc` 与任何 web 测试(零改动)。
- 带 DB 的全量;投影候选 r1 / r2 的 mutation 网格全部复跑(只复跑了本轮五格);r9 栈顶(RC + H-5)树上的 C-2(本分支只建在 r9 底层)。
- 生产语料普查;真浏览器;`RBAC_TOKEN_TRUST` 未设(生产形状)下的 403 复测(本探针在 integration 配置的 `RBAC_TOKEN_TRUST=true` 下测,非特权令牌 `perms=[]` 使守卫仍落到 DB 查询;守卫代码路径见 `rbac/rbac.ts:65-108`)。
- CI 实跑(零 PR)。

## 9. 登记(未做)

M-2 / M-3 / M-4(§J-19 范围外);D-5 量纲 doc comment;投影候选门审 r1 P3-2 / P3-3、r2 P3-A / P3-B / P3-C / P3-D 原样重放未硬化;详见设计 MD §9。
