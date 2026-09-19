# 任务功能线 M0 交付报告（切片 A）

PR：https://github.com/zensgit/metasheet2/pull/5845 （Draft）。head SHA 以 §0 为准。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / merge-base：`bb77ca5f2ce3c2825265ec8877861d367d017ead`（`git merge-base HEAD origin/main`；`#5872`）
- head SHA：内容 SHA `9a21560b324871bf5a965553b152a612da454ecf`（闸 §11 第七轮；merge-base `bb77ca5f2ce3c2825265ec8877861d367d017ead`；本轮不 rebase）。若其后有 SHA-record 提交，末次仅回填本行。
- PR #：**5845** Draft https://github.com/zensgit/metasheet2/pull/5845
- `gh pr view 5845 --json mergeable,mergeStateStatus,statusCheckRollup` 开 PR 后立即原始摘录（非 DIRTY；checks 当时多为 QUEUED，`mergeStateStatus=BLOCKED` 因 required 未完成，不是冲突）：

```json
{"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"web-tests","status":"QUEUED","workflowName":"Web Tests"},{"name":"test (20.x)","status":"QUEUED","workflowName":"Plugin System Tests"},{"name":"pr-validate","status":"IN_PROGRESS"}]}
```

完整 rollup 数组更长（attendance-web-guard / plugin-tests 多 job 等，当时 QUEUED 或 IN_PROGRESS）。`mergeable=MERGEABLE` 表示无冲突。
- 一句话：普查 + PROPOSED 锁草案 + 本报告；docs-only Draft PR-0，不合并。专属 auth config/setup/wiring/`tasks-auth-gate.ts` 形状写入锁，**M2 同 PR 落**，本切片不落 `.ts`。

按简报 §2 / 用户 §四 **明确没做什么**：

1. 未写 DDL、未挂路由、未改共享文件（先锁后建）。
2. 无迁移文件（因此无「含 DDL」PR 段；本 PR 是 docs-only）。
3. 不合并任何 PR。
4. 未创建 `zzzz*.ts` 迁移。
5. 未在任何列上使用 `[!-~]`（无 DDL）。
6. 未声称真库接线①②③④「门全绿」；§13-9 / §13-10 / §13-11 / §13-12 未裁。
7. 未改 `tasks-web-guard.yml`（尚未存在）也未改 `run-required-web-tests.sh`。
8. 未改 `plugin-tests.yml`、`table-classification.cjs`、`router/types.ts`、`guardPolicy.ts`。
9. 未注册路由、未起服务器。
10. 未 seed 权限码、未写 RBAC 数据。
11. 未实现 org 解析器（只把计划已定条款抄进锁）。
12. 未实现错误契约代码。
13. 未实现锁键模块（任务 B 范围）。
14. 未实现日期判定代码（任务 B 范围）。
15. grep 纪律：普查命令使用 `[[:space:]]` / 字面量，未用 `| head -1` 判唯一。
16. 无 mutation 改生产代码（docs-only）；见 §2。
17. 生产源码未改，故无点名其他线的新注释。
18. 开 PR 后第一件事查 mergeable（§0 回填）。
19. PR body 不写 `close #N`，不伪造授权。
20. 拿不准的进 §4 UNCLEAR。

任务 B / 任务 C：未做。

---

## 1. 断言表

| # | 断言 | 证据 | 复现命令 | 输出摘录（≤3 行） |
|---|---|---|---|---|
| 1 | 本 head 的 merge-base = `bb77ca5f2ce3c2825265ec8877861d367d017ead` | 工作树 | `git merge-base HEAD origin/main` | `bb77ca5f2ce3c2825265ec8877861d367d017ead` |
| 2 | 计划 v5 288 行且 MD5 匹配声明 | 计划文件 | `md5 -q …/task-feature-development-plan-20260915.md && wc -l …` | `f74e172840d2aa2502216d0dd8dff867` / `288` |
| 3 | 飞书语料 html 篇数为 26 | 语料目录 | `ls …/articles/*.html \| wc -l` | `26` |
| 4 | 本地主库 `to_regclass('public.tasks')` 为 NULL | census §1 | 见普查 SQL | `tasks` 列空 |
| 5 | `createTable`/`CREATE TABLE` 扫描下没有表名 `tasks` 或 `task_*` | census §3 | `rg -n "createTable\(\s*['\"][^'\"]*task" packages/core-backend/src/db/migrations` ； `rg -n -i "CREATE TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(\"|')?[^\"']*task" packages/core-backend/src/db/migrations packages/core-backend/migrations` | 命中仅 `gantt_tasks` / `gantt_task_resources` / `bpmn_user_tasks` / `bpmn_external_tasks` |
| 6 | 正控：`gantt_tasks` 出现在 `createTable` | `20250924140000_create_gantt_tables.ts:13` | `sed -n '13p' packages/core-backend/src/db/migrations/20250924140000_create_gantt_tables.ts` | `.createTable('gantt_tasks')` |
| 7 | `NON_NAMESPACED_PERMISSION_RESOURCES` 不含 `'tasks'` | `namespace-admission.ts:11-38` | `sed -n '11,38p' packages/core-backend/src/rbac/namespace-admission.ts` | 集合止于 `'workflow'`，无 `tasks` |
| 8 | `exec npx vitest run` 在 `:1186` 不在 `:1069`；token 394；含 `task` 的 token 数为 0 | `run-required-web-tests.sh` | census §4 命令 | 1069=注释；1186=`exec`；394；0 |
| 9 | 拟用锁前缀 `task-structure:` / `task-projection:` / `tasks-scheduler:` 未作为既有字面键前缀出现 | census §2 | `rg -n "task-structure:\|task-projection:\|tasks-scheduler:" packages/core-backend/src plugins --glob '!**/node_modules/**'` ；正控 `rg -n "approval-projection:" packages/core-backend/src/multitable/approval-record-projection-service.ts` | 前命令 0 行。正控 `:246` `` `approval-projection:${instanceId}` `` |
| 10 | 本地主库活跃多成员用户数 = 0（仅代表该库） | census §1.3 | QUERY B | `multi_active_member_users = 0`，分母 115 |
| 11 | 审批路由挂载不在计划写的 `index.ts:1763-1777` | `index.ts:1791` | `grep -n -F "this.app.use(approvalsRouter" packages/core-backend/src/index.ts` | `1791:    this.app.use(approvalsRouter({` |
| 12 | `docker-build.yml` 对 `docs/**` paths-ignore | `:4-8` | `sed -n '4,8p' .github/workflows/docker-build.yml` | `paths-ignore: docs/**` |
| 13 | 锁草案含 §0–§15 且 §8 为 N/A 一行 | 锁文件 | `rg -n "^## " docs/development/task-feature-design-lock-20260917.md` | 见 §3 |
| 14 | 锁草案 §13 含题号 1–39 各恰一次 | 锁文件 | `python3 -c "import re; from pathlib import Path; t=Path('docs/development/task-feature-design-lock-20260917.md').read_text(); found=sorted({int(n) for n in re.findall(r'\*\*(\d+)\.', t) if 1<=int(n)<=39}); print(found, 'count', len(found), 'missing', [i for i in range(1,40) if i not in found])"` | `count 39 missing []` |
| 15 | §13-9 / §13-10 / §13-11 / §13-12 标未裁 | 文件头 bullet `:9` / §0 `:25` / §11 `:315` / §14-3 `:452`；§13 前言顿号写法另核 | `grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md` | `:9` `:25` `:315` `:452` 四行 |

---

## 2. 测试

- **本地**：本切片 docs-only，**没有**新增/运行产品测试。未跑 `pnpm test`、未跑 vitest、未跑浏览器。
- **收集用例数**：本地 0（未收集）。CI：`docker-build.yml:3-9` 只有 `push.branches` 与 `workflow_dispatch`，**无 `pull_request` 触发器**，PR 阶段本就不跑 build；合并后因 `paths-ignore` 命中 `docs/**` 不跑 build。`web-tests.yml` 无 paths 会跑 required web 闸（既有 394 token，与本 diff 无关）。**不得把 web-tests 绿当成任务 spec 已接线。**
- **CI lane**：开 PR 当时 `web-tests` QUEUED（run `https://github.com/zensgit/metasheet2/actions/runs/35171274285`）；`test (20.x)` QUEUED（plugin-tests 工作流 `35171274259`）。日志收集用例数当时尚未写出。纯 docs 变更不证明任务 spec 已接线。
- **mutation 探针**：未改生产守卫。docs-only 无「neuter 守卫 → 测试红」探针。
- **正控**：双语法正控见断言 #6；token 行正控见 census §4 首尾 token；`user_orgs` 正控为 QUERY A/B 分母等于 `COUNT(*) FROM users`（115）。

---

## 3. 接线核对（计划 §8，本切片只核、不接线）

| §8 条 | 本切片 | 命令/结果 |
|---|---|---|
| 8-1 真库接线①②③④ | 未加 `task-*.db.test.ts`，未改 `vitest.config.ts`，未建 lane。§13-12 未裁 | 不声称门全绿 |
| 8-2 前端两点 | 未加 spec、未建 `tasks-web-guard.yml`、未改 token 行 | `rg -n "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh` → `:1186`；含 task 的 token = 0 |
| 8-3 五段部署链 | docs-only；`paths-ignore: docs/**` | `sed -n '4,8p' .github/workflows/docker-build.yml` |
| 8-4 路由注册 | 未挂 | `index.ts` 审批段现 `:1791` |
| 8-5 PR body | 不写 close #N；无 DDL 句（无迁移） | 开 PR 后自检 `rg -io "(close[sd]?\|fix(es\|ed)?\|resolve[sd]?) #?[0-9]+"` |
| 8-6 required checks | 开 PR 后读 API | `gh api repos/zensgit/metasheet2/branches/main/protection`（先不带 `--jq`） |
| 8-7 授权账本 | 无合并授权 | 不伪造 |
| 8-8 注释点名 | 未改生产源码 | — |
| 8-9 DML 分类 | 未登记 `table-classification.cjs` | 未改该文件 |
| 8-10 RBAC_OPTIONAL 断言 | 无新 lane | — |

`plugin-tests.yml` 未改。s6a pin `:90` 本 merge-base 仍为 `5902a850c3d254c20b0caf330b21da896703648265ae7a588b973f793727a0cf`；origin/main（本轮不 rebase）已漂到 `b37a589feff9ee45b804ab6936947053f4e813480bd69c7dfd4973f0a4790ba6`。ratify 前必须重核（锁 §14-4 (b)）。

---

## 4. 偏离与 UNCLEAR

1. **main 前进**：计划基线 `062614f44` → 本切片 merge-base `bb77ca5f2`（`#5872`）。§8 若干行号相对计划漂移（census §5.1）：`run-required-web-tests.sh:1069`、`vitest.config.ts:1782`（e2e glob 现 `:1812`）、`index.ts:1763-1777`（审批挂载现 `:1791`）、`AGENTS.md:48-50`。exec token 392→394；末 token 现为 `StockPreparationDataSourceRegistry`。
2. **交接件 §四.3 vs 计划 §2**：用户文本非空。以计划两类约束为准，写入锁 §4.1。
3. **仓根无 `CLAUDE.md`**：章程以 `AGENTS.md` + 工作区 `~/Downloads/Github/CLAUDE.md` 为准（Q6）。本 SHA `AGENTS.md:48-50` 不是两点接线段。
4. **`user_orgs` 生产分布 UNCLEAR**（裁定不连生产）。本地活跃多成员 = 0。
5. **`hashtext` 数值碰撞 UNCLEAR**：只做字面前缀差。
6. **§13-9 / §13-10 / §13-11 / §13-12 未裁**（§13-11 不适用默认前进）。
7. **待办中心锁未 ratify**：PendingItem 按交接件临时六字段；R1。
8. **对抗闸未齐**：第七轮 REJECT（`reviews/gate-task-m0-20260917.md` §11，1 P1 / 9 P2 / 15 P3；第四轮独立审同 head 亦 REJECT）。本轮按 §11 一次改完、不 rebase。不声称 M0 退出门已过。
9. **飞书 `:21-23` vs 计划 §5-2**：计划把《完成与重启任务》:23 列为 `scope=self|all` 出处之一；锁按闸 P3-1 把 `:21-23` 标 IM 不对标，`:20` 单独支撑创建人完成范围。以闸 P3-1 为准，计划 :23 记偏离。
10. **`guardPolicy.ts` 行号漂移**：计划写 `:29` / `:77` / `:87-95`；本 SHA `ATTENDANCE_FOCUS_ALLOWED_PATHS` `:34`、`PLM_WORKBENCH_ALLOWED_PREFIXES` `:82`、`KNOWN_REQUIRED_FEATURES` `:100`，`/stock-prep` 无 `requiredFeature` 先例 `:90-99`（普查 §5.2 / §5.3）。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **闸未齐**：第七轮 REJECT。本轮按闸 §11 一次改完、不 rebase；待闸方亲核门 16 trust-off 前置、门 2/6/3/7、§13-5 入表、§14-4 (d) 两遍。
4. **§13-9 / §13-10 / §13-11 / §13-12 未裁**。
5. 未实现任务 B 纯函数与单测。
6. 未写迁移、路由、服务、前端（任务 C 禁止）。
7. 未改任何共享文件 / workflow / token 行。
8. 未验证 s6a pin 在「若将来改 plugin-tests.yml」下的重算（本切片未改）。
9. 锚点解析改为 `TASK_FEATURE_PLAN_PATH` + `OK_IN_RANGE`/`AMBIGUOUS`；未把每条锚点的 `sed -n` 全文贴进本报告（§5.1/§5.2 与 §6 是抽查 + 计数）。
10. 未把 394 token 全文列入仓库文件。
11. 飞书 IM/P2 篇在锁 §2 用计划已蒸馏的承重机制，未在本报告逐篇贴原文行。
12. `mergeable` JSON 已回填 §0；当时 checks 未完成，未把 QUEUED 当绿。

不许写「全部完成」。本切片交付 = 三份 docs + Draft PR-0。

---

## 6. 修复轮（闸 §11 第七轮 1 P1 / 9 P2 / 15 P3）

未改 §13-9 / §13-10 / §13-11 / §13-12 的未裁状态。未合并。不 ratify。任务 B 未起。本轮不 rebase。表内命令均为完整路径、已实跑。每项附机制走查（合取顺序 / 装配链 / 数值可满足性 / 行号 `sed -n`）。

| finding | 改动 | 命令 | 输出摘录 |
|---|---|---|---|
| ① 门 16 P1 | 两格写全 trust-off DB 前置；对照格=写路由；`:206` 恒 null | 见下走查 ① | `sed -n '206p;273p;277p'` → `return null` / `evaluateUserAuthenticationGate` / `isUserSessionRevoked` |
| ② 门 2 | 第三格钉 token 不带 perms；排除 `*:*` / 直授 / jsonb；2/13 行尾 TRUST 姿态 | `sed -n '8p' packages/core-backend/tests/setup.integration.ts` | `process.env.RBAC_TOKEN_TRUST = 'true'` |
| ③ §13-5 | §9 表加行 + 四处「随 §13-11 落槌」+ 表头结构性约束 | `grep -n -F "§13-5 随 §13-11" docs/development/task-feature-design-lock-20260917.md` | `:9` `:25` `:315` `:363` `:384` `:452` |
| ④ 门 6 | 第三连接 `pg_blocking_pids`；负控=`src/services/task-*.ts`；fence `:55-82` | `sed -n '81,82p' packages/core-backend/src/multitable/canonical-sheet-fence.ts` | `acquireCanonicalSheetFence` + `pg_advisory_xact_lock(hashtext($1))` |
| ⑤ 门 3 | 增删人格与切模式格同受 §13-9；§6.2 候选 all→any 立即 done | `grep -n "增删人格" docs/development/task-feature-design-lock-20260917.md` | `:238` `:289` `:325` `:357` `:396` |
| ⑥a 专属 OPTIONAL | config `RBAC_OPTIONAL: ''` + setup 第四条守卫；2/13/16 行尾 lane 断言 | `sed -n '9p;17p' …/namespace-admission.ts` 等 | 三读点皆 `const allowDegradation = process.env.RBAC_OPTIONAL === '1'` |
| ⑥b ④ 中间集合 | exclude 匹配 `^tests/integration/task-.*\.db\.test\.ts$`；删三 glob 排除句 | 见下走查 ⑦ | 行首路径 400 / glob 3；naive 引号 456 / 含 `*` 5 |
| ⑧ §13-4 | `badge_scope` 闭集三值；`all_open` 仅 pending scope；来源改 §2.1/§3、§13-3 改 §5-8 | `grep -n '来源 计划 v5 §13-' docs/development/task-feature-design-lock-20260917.md` | `NO_MATCH` |
| ⑨ 门 7 | 扫描根 + POSIX ERE；除 keys 外零命中；正控 `:246`；负控插字面量 | `sed -n '246p' packages/core-backend/src/multitable/approval-record-projection-service.ts` | `pg_advisory_xact_lock(hashtext($1))` + `` `approval-projection:${instanceId}` `` |
| ⑩ 普查 guardPolicy | 锚点 `:34/:82/:100` + `:90-99`；普查 §5.3 偏离表一行 | `sed -n '34p;82p;100p' apps/web/src/router/guardPolicy.ts` | `ATTENDANCE_FOCUS_ALLOWED_PATHS` / `PLM_WORKBENCH_ALLOWED_PREFIXES` / `KNOWN_REQUIRED_FEATURES` |
| ⑪a `:234` | 信任通道写点 `:232`→`:234` | `sed -n '232,242p' packages/core-backend/src/auth/AuthService.ts` | `:234` `permissions,`；`:232` 为 `name,`；`:242` `perms: permissions` |
| ⑪b §14-4 (d) | 两遍导出（路径形 + 裸 `:N`）标非穷举 | 见下 ⑫ | 路径形 unique 56；裸 `:N` unique 60 |
| ⑪c 飞书脚本 | 末行 `"$ARTICLE" "$N"`；先 export；删「页眉占前 6 行」 | 见下走查 ⑪c | `:12` 删减任务负责人 |
| ⑪d §2 引文 | 负责人 `:12`；附件 `:28-29` vs `:30` vs 关注 `:13` | 同飞书脚本 | 见摘录 |
| ⑪e 门 10 | 点名 `parseTaskProjectionRecordId` 为投影写回 422 产生处 | `grep -n parseTaskProjectionRecordId docs/development/task-feature-design-lock-20260917.md` | `:263` `:332` |
| ⑪f 门 17 | `.each` 计数规则（不禁用） | `rg -l --glob '*.db.test.ts' '\.each\(' packages/core-backend/tests/integration \| wc -l` | 13 / 260 |
| ⑪g §5.3 ② | 反向命令 `grep -c 'apps/web/verification/'` = 0 | `grep -n "verification/" docs/development/task-feature-design-lock-20260917.md` | 锁 `:206` |
| ⑪h §4.1 | 三合取收窄到任务域生成 id；`org_id`/`created_by` 只留 `^[!-~]+$` | `sed -n '92p' docs/development/task-feature-design-lock-20260917.md` | 见锁 `:92` / §9 `:283` |
| ⑫ 同 head 两遍导出 | 本轮锁文上实跑并贴输出 | 见下 ⑫ | 56 + 60 |

### 机制走查

#### ① 门 16 trust-off 合取顺序

`verifyToken` 装配链（trust-off）：

1. `:259-264` 调 `buildTrustedTokenUser`；`:206` `if (!this.trustTokenClaimsEnabled()) return null`（专属 config `RBAC_TOKEN_TRUST='false'` ⇒ 恒 null）。claim `perms` **不**写入 `req.user.permissions`。`tenantId` claim 只作步骤 6 入参。
2. `:267` `getUserById`；无行 ⇒ null（请求到不了 rbac）。
3. `:273` `evaluateUserAuthenticationGate`：`user-activation.ts:78` `is_active===false` / `:84-96` pending/invalid ⇒ null。故夹具必须 `is_active` 且 `activation_status='activated'`。
4. `:277` `isUserSessionRevoked` ⇒ 未 revoke。
5. `:282-288` 有 `sid` 则必须活跃会话；无 `sid` 跳过。
6. `:290-293` `tenantClaim` → `resolveSessionTenantId` `:387-405`：`user_orgs` 一行 `is_active` 且 `org_id = $2`（token claim）JOIN `users.is_active`。
7. `jwt-middleware.ts:101-104` 仅当 `user.tenantId` 非空才写 `req.authenticatedTenantId`。写路径缺 org ⇒ 422；读路径缺 org ⇒ degraded 200。故对照格必须是写路由，否则自检「对照格 200」可被 degraded 读路径假绿。

`sed -n '206p;234p;273p;277p;282p;387p' packages/core-backend/src/auth/AuthService.ts`：

```
    if (!this.trustTokenClaimsEnabled()) return null
      permissions,
      if (evaluateUserAuthenticationGate(user)) {
      if (await isUserSessionRevoked(user.id, payload.iat)) {
      if (typeof payload.sid === 'string' && payload.sid.trim().length > 0) {
  async resolveSessionTenantId(userId: string, requestedTenantId?: string): Promise<string | undefined> {
```

自检句后加「对照格非 200 先核上述前置再判门不成立」。

#### ② 门 2 第三格 × TRUST='true'

`tests/setup.integration.ts:8` `RBAC_TOKEN_TRUST = 'true'`。装配：`buildTrustedTokenUser:206` 不再恒 null；token `perms` 写成 `:234` `permissions` 与 `:242` `perms`，`rbac.ts:22` `hasPermissionCode` 把 `*:*` 当万能。故第三格必须钉 token 不带 `perms`，并排除 `*:*` / `user_permissions` 直授 / `users.permissions` jsonb。门 2/13 行尾声明该 harness 信任姿态。lane env：`RBAC_OPTIONAL` 未设置，否则本门红。

#### ③ §13-5 入表

「不适用默认前进」只在 §9 表内有效。正文 `:384` 已有该措辞，故必须有表行，否则锁自相矛盾不得 ratify（表头 `:279`）。四处 slash 仍是 9/10/11/12，另写「§13-5 随 §13-11 落槌，单独未裁亦阻断 M2」。

`grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md`：

```
9:…§13-9 / §13-10 / §13-11 / §13-12 标「未裁」。§13-5 随 §13-11 落槌，单独未裁亦阻断 M2。
25:…落槌。§13-5 随 §13-11 落槌，单独未裁亦阻断 M2。
315:| M1 | …落槌。§13-5 随 §13-11 落槌，单独未裁亦阻断 M2 |
452:3. **§13-9 / §13-10 / §13-11 / §13-12 必须落槌** 才进入 M2。§13-5 随 §13-11 落槌，单独未裁亦阻断 M2。
```

#### ④ 门 6 第三连接 / 数值可满足性

`pg_blocking_pids(pid)` 返回**阻塞该 pid** 的 PID 数组。连接 2 在等 `pg_advisory_xact_lock` 时自身被阻塞，不能可靠自查，故用第三连接观察。

可满足性脚本（M2 夹具；本切片 docs-only 未开三连接）：

```sql
-- conn1: BEGIN; SELECT pg_backend_pid(); SELECT pg_advisory_xact_lock(hashtext('task-structure:orgX')); -- 不提交
-- conn2: BEGIN; SELECT pg_backend_pid(); SELECT pg_advisory_xact_lock(hashtext('task-structure:orgX')); -- 阻塞
-- conn3:
SELECT pg_blocking_pids(:pid2);  -- 必须包含 pid1
SELECT pg_blocking_pids(:pid1);  -- 必须为空 {}
SELECT wait_event FROM pg_stat_activity WHERE pid = :pid2;  -- 'advisory'
```

负控目标 = `src/services/task-*.ts` 的 `pg_advisory_xact_lock` 调用行（`task-lock-keys.ts` 只生成键）。mutation 生效判据：连接 2 不再 `wait_event='advisory'`。中间步复用 `canonical-sheet-fence.ts:55-82`，键 `meta:auto-number:sheet:*` 不进三键集合。

#### ⑤ 门 3 × §13-9

不把计划 §5-4 四条抄成已定（§13-9 未裁）。增删人格与切模式格同阻断。§6.2 候选支：`all→any` 已有任一 completed ⇒ 立即 done。

#### ⑥a `RBAC_OPTIONAL` 装载链

三读点皆模块顶 `const allowDegradation = process.env.RBAC_OPTIONAL === '1'`（`namespace-admission.ts:9`、`service.ts:17`、`permissions.ts:21`）。夹具 `delete process.env.RBAC_OPTIONAL` 改不了已装载常量。故专属 config `env` 钉 `RBAC_OPTIONAL: ''`（模块装载前），setup 第四条守卫 `=== '1'`（或非空）则抛。门 2/13 跑 integration harness（不经过专属 config），行尾断言 lane 未设置该变量。

#### ⑦ §5.2.1 ④ 中间集合（原 ⑥b）

`vitest.config.ts` `test.exclude` 本 SHA：

```
# 去 // 后行首路径条目
python3 … → line-start quoted entries 400 ; globs 3
  **/node_modules/**  :32
  **/dist/**          :33
  tests/e2e/**        :1812
# naive 数组体 '…'（含注释内引号）
naive quoted 456 ; naive with star 5
```

闸写 455/5 与 naive 同量级。旧文「三条历史 glob 排除在集合比较之外」既不是 3、也不能让「磁盘 = 整个 exclude 数组」可满足。中间集合改为匹配 `^tests/integration/task-.*\.db\.test\.ts$` 的 exclude 条目。

#### ⑧ §13-4 闭集

计划 v5 §2.1：`badge_scope CHECK IN ('off','overdue','overdue_or_today')`。语料无 `all_open` 作为红点档位（红点 `:14` 已逾期 / 已逾期和今天截止；`:15-16` 关闭；任务设置 `:15-16` 同）。`all_open` 是计划 §3 `/pending` 的 scope 参数。`grep '来源 计划 v5 §13-'` → `NO_MATCH`。§13-3 来源改计划 §5-8。

#### ⑨ 门 7 扫描

POSIX ERE `pg_advisory_xact_lock[[:space:]]*\([[:space:]]*hashtext[[:space:]]*\(`。扫描根 `src/tasks` + `src/services/task-*.ts` + `routes/tasks*.ts`，排除 `task-lock-keys.ts` 后零命中。正控同命令对 `approval-record-projection-service.ts` 必命中 `:246`。负控：services 内插该字面量 ⇒ 非零。

#### ⑩ / ⑪c 飞书脚本

先 `export ARTICLE` / `export N`，末行 `"$ARTICLE" "$N"`（旧文 `" \"\$ARTICLE\" N` 在 bash 下不把 `N` 当参数）。口径 = 非空渲染列表绝对行号。本轮：

```
export ARTICLE=…/7049628517652070428-添加任务负责人.html
export N=12
# → 12:…进行删减任务负责人的操作。
```

关注任务 `:13` 完成/重启/删除通知。附件 `:28-29` 评论加附件；`:30` 附件评论通知。红点 `:14/:15-16`。任务设置 `:15-16`。清单 `:67` 归档后不受影响。

#### ⑪a `:234`

`sed -n '232,242p' packages/core-backend/src/auth/AuthService.ts`：`:232` `name,`；`:233` `role,`；`:234` `permissions,`；`:242` `perms: permissions`。

#### ⑪f `.each`

本 SHA `tests/integration/*.db.test.ts` 260 文件、13 个含 `.each(`。规则：展开后静态计数 = 无 table 的 `it(`/`test(` + 每个 `it.each`/`test.each` 表行数（不含表头）；PR body 必须写出展开表行数。

#### ⑫ §14-4 (d) 两遍导出（同 head，本轮锁文）

```bash
LOCK=docs/development/task-feature-design-lock-20260917.md
grep -oE '[A-Za-z0-9_./-]+\.(ts|js|cjs|mjs|yml|yaml|md|vue|sh|json):[0-9]+(-[0-9]+)?' "$LOCK" | sort -u | wc -l
# 56
grep -oE "$(printf '\140'):[0-9]+(-[0-9]+)?" "$LOCK" | sort -u | wc -l
# 60
```

路径形样本（头/尾）：

```
.github/workflows/attendance-web-guard.yml:2-3
.github/workflows/docker-build.yml:484-488
.github/workflows/plugin-tests.yml:842-844
…
tests/setup.integration.ts:8
user-activation.ts:78
vitest.config.ts:1782
vitest.elearning-pilot-auth.config.ts:28-33
```

裸 `:N` 全集 60 条（非穷举；无反引号的散文行号不在内）：

```
`:105
`:106-109
`:1069
`:108-118
`:11-38
`:111
`:1186
`:12
`:120-122
`:120-168
`:1277
`:1288
`:129
`:133-135
`:133-137
`:136
`:143-151
`:144-147
`:1655
`:1659
`:167
`:168-172
`:171-176
`:1782
`:1785
`:1797
`:1812
`:182-186
`:196-199
`:200-203
`:203-243
`:234
`:241
`:242
`:246
`:246-252
`:253
`:277
`:282-288
`:302
`:344
`:345
`:346
`:347
`:387-405
`:4-8
`:41
`:45-47
`:532-533
`:54
`:68-70
`:71
`:71-73
`:74-76
`:77-83
`:8
`:84-96
`:842-844
`:96
`:99
```

抽查（本 SHA = merge-base `bb77ca5f2`；不 rebase）：

```
packages/core-backend/vitest.config.ts:1812     'tests/e2e/**'
packages/core-backend/src/index.ts:1791         this.app.use(approvalsRouter({
apps/web/scripts/run-required-web-tests.sh:1186 exec npx vitest run …
.github/workflows/plugin-tests.yml:842-844      Run core-backend tests
AuthService.ts:234                              permissions,
guardPolicy.ts:34 / :82 / :100                  三常量
```

普查解析器（计划 v5，`TASK_FEATURE_PLAN_PATH`）：

```
unique 133 OK_IN_RANGE 128 OOB 5 MISSING 0 AMBIGUOUS 11
```

`git diff --name-status $(git merge-base HEAD origin/main) HEAD` 仍为三份 docs `A`（SHA-record 提交后同）。
