# 任务功能线 M0 交付报告（切片 A）

PR：https://github.com/zensgit/metasheet2/pull/5845 （Draft）。head SHA 以 §0 为准。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / merge-base：`bb77ca5f2ce3c2825265ec8877861d367d017ead`（`git merge-base HEAD origin/main`；`#5872`）
- head SHA：内容 SHA 见本轮 SHA-record 提交（闸 §12 第八轮；merge-base `bb77ca5f2ce3c2825265ec8877861d367d017ead`；本轮不 rebase）。若其后有 SHA-record 提交，末次仅回填本行。
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
6. 未声称真库接线①②③④「门全绿」；§13-9 / §13-10 / §13-11 / §13-12 未裁（§13-5 随 §13-11，单独未裁亦阻断 M2）。
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
| 9 | 拟用锁前缀 `task-structure:` / `task-projection:` / `tasks-scheduler:` 未作为既有字面键前缀出现 | census §2 | 三条：`grep -R -E --include='*.ts' --include='*.cjs' -l 'task-structure:' packages/core-backend/src plugins` ；同形换 `task-projection:` / `tasks-scheduler:`。正控 `grep -n -E 'approval-projection:' packages/core-backend/src/multitable/approval-record-projection-service.ts` | 三条均空、exit 1。正控 `:246` |
| 10 | 本地主库活跃多成员用户数 = 0（仅代表该库） | census §1.3 | QUERY B | `multi_active_member_users = 0`，分母 115 |
| 11 | 审批路由挂载不在计划写的 `index.ts:1763-1777` | `index.ts:1791` | `grep -n -F "this.app.use(approvalsRouter" packages/core-backend/src/index.ts` | `1791:    this.app.use(approvalsRouter({` |
| 12 | `docker-build.yml` 对 `docs/**` paths-ignore | `:4-8` | `sed -n '4,8p' .github/workflows/docker-build.yml` | `paths-ignore: docs/**` |
| 13 | 锁草案含 §0–§15 且 §8 为 N/A 一行 | 锁文件 | `rg -n "^## " docs/development/task-feature-design-lock-20260917.md` | 见 §3 |
| 14 | 锁草案 §13 含题号 1–39 各恰一次 | 锁文件 | `python3 -c "import re; from pathlib import Path; t=Path('docs/development/task-feature-design-lock-20260917.md').read_text(); found={int(n) for n in re.findall(r'\*\*(\d+)\.', t) if 1<=int(n)<=39}; print(len(found), 39-len(found))"` | `39 0` |
| 15 | §13-9 / §13-10 / §13-11 / §13-12 标未裁，且 §13-5 随落槌 | 四处 slash + §9 表 §13-5 行 | `grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md` ； `grep -n -F "§13-5 随 §13-11" …` ； `grep -n "\| §13-5 \|" …` | slash `:9` `:25` `:315` `:473`；随落槌 6 处；§9 `:288` |

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
6. **§13-9 / §13-10 / §13-11 / §13-12 未裁**（§13-11 不适用默认前进；§13-5 随 §13-11，单独未裁亦阻断 M2）。
7. **待办中心锁未 ratify**：PendingItem 按交接件临时六字段；R1。
8. **对抗闸未齐**：第八轮 REJECT（`reviews/gate-task-m0-20260917.md` §12，1 P1 / 8 P2 / 12 P3；第五轮独立审同 head 亦 REJECT）。本轮按 §12 一次改完、不 rebase。不声称 M0 退出门已过。
9. **飞书 `:21-23` vs 计划 §5-2**：计划把《完成与重启任务》:23 列为 `scope=self|all` 出处之一；锁按闸 P3-1 把 `:21-23` 标 IM 不对标，`:20` 单独支撑创建人完成范围。以闸 P3-1 为准，计划 :23 记偏离。
10. **`guardPolicy.ts` 行号漂移**：计划写 `:29` / `:77` / `:87-95`；本 SHA `ATTENDANCE_FOCUS_ALLOWED_PATHS` `:34`、`PLM_WORKBENCH_ALLOWED_PREFIXES` `:82`、`KNOWN_REQUIRED_FEATURES` `:100`，`/stock-prep` 无 `requiredFeature` 先例 `:90-99`（普查 §5.2 / §5.3）。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **闸未齐**：第八轮 REJECT。本轮按闸 §12 一次改完、不 rebase；待闸方亲核门 16 TRUST 对照、取锁 helper、跨 org 格、门 19。
4. **§13-9 / §13-10 / §13-11 / §13-12 未裁**（§13-5 随 §13-11）。
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

## 6. 修复轮（闸 §12 第八轮 1 P1 / 8 P2 / 12 P3）

未改 §13-9 / §13-10 / §13-11 / §13-12 的未裁状态（§13-5 随 §13-11）。未合并。不 ratify。任务 B 未起。本轮不 rebase。每项附机制走查；对被改的门加一行「另一姿态 / 另一门下这格是什么」。

| finding | 改动 | 命令 | 输出摘录 |
|---|---|---|---|
| ① 门 16 P1 | 判别格 token 带 DB 未授予 `tasks:read`；TRUST 对照表；roles 非空非 admin | `sed -n '206p;213p' packages/core-backend/src/auth/AuthService.ts` | `:206` 恒 null；`:213` 空集早返回 |
| ② 门 16 前置 | `TASKS_ENABLED='true'`、挂载、最小体、`must_change_password=false`、`role≠disabled`；4xx 可区分 | `sed -n '77p' …/user-activation.ts` ； `sed -n '83,91p' …/jwt-middleware.ts` | `:77` `role === disabled or is_active === false`；`:83-99` `PASSWORD_CHANGE_REQUIRED` |
| ③ §6.4 helper | `src/db/task-advisory-locks.ts` 三导出；门 7 根外零命中；删 keys 空排除 | `grep -n task-advisory-locks docs/development/task-feature-design-lock-20260917.md` | `:32` `:252` `:256` `:333` `:334` |
| ④ 门 6 负控 | 正向时序：pid1 granted=true 时 conn2 有界返回且无 granted=false | `grep -n granted=false docs/development/task-feature-design-lock-20260917.md` | 正控保留；负控改返回 |
| ⑤ OPTIONAL | 全文唯一谓词 `=== '1'`；2/13 执行点 = 任务 db import，不改共享 setup | `grep -n RBAC_OPTIONAL_ON …design-lock…` | §4.3 `:115` 唯一定义 |
| ⑥ 跨 org | trust-off 隔离格；门 1 harness 姿态；披露 2/13 claim 逐字生效 | `sed -n '227p;259,264p' …/AuthService.ts` | `:227` tenantId；`:262` return trustedUser |
| ⑦ §6.2/4.4/门3-5 | any×0、零负责人仅创建人、all 重启 :35、全天 due_at 23:59:59.999、六格、反格、href | 飞书脚本 `N=35` / `N=13` | `:35` 重启我的/全部；`:13-16` 四视角 |
| ⑧ 门 19 | 从属链正控 + assignee 臂三端同红 | `grep -n "谓词从属链" …` | `:376` |
| ⑨ §5.2 权限门 | `guardPolicy.ts:221-225` every；冒烟前置；门 12 = 组件 spec | `sed -n '221,225p' apps/web/src/router/guardPolicy.ts` | permission gate BEFORE allowlist |
| ⑩ R10/解析器/#9/#14/#15 | 见下 | 见下 | R10 逐句；parser OOB 0 AMB 11；#9 exit 1×3 |
| ⑪ (d) 两遍 | 同 head | 见下 ⑪ | 路径形 61；裸 `:N` 67 |

### 机制走查

#### ① 门 16 判别格 × TRUST 对照

合取：DB 授 `tasks:write` 不授 `tasks:read` + admission 在 + token `perms: ['tasks:read']` + `roles` 非空非 admin。trust-off：`:206` 先于 `:211-213`，perms 惰性 → rbac 查库无 read → 403。trust-on：perms 写成 `:234` → 200。对照格 DB 已有 write → 两姿态都 200。mutation 只由判别格 403→200 检出。

另一姿态 / 另一门：同一判别格在门 2（TRUST='true'、token **无** perms）是码面 403 的第三格，不是 200。

#### ② 写路由 rbacGuard 前 4xx

装配链：flag 关 → router null → 404；`must_change_password` → jwt `:83-99` 403 `PASSWORD_CHANGE_REQUIRED`；`role==='disabled'` → `:77` 认证失败（通常 401）；org 空 → 写 422；才到 rbac 403 `{ error: 'Insufficient permissions' }`。诸体必须逐字节不同。

另一姿态 / 另一门：门 2 跑 `setup.integration.ts` TRUST='true'，**不**经专属 `TASKS_ENABLED` 守卫；本前置只约束门 16。

#### ③④ 取锁 helper 与门 6/7

`src/tasks/task-lock-keys.ts` 纯函数（守 §1 无 I/O）。`src/db/task-advisory-locks.ts` 有 I/O、在门 7 扫描根外。门 7 谓词 = 根内 ERE 空集。不排除 keys 文件。扫描前 `find … | wc -l` ≥ 1，bash+find，grep exit 2 / zsh nomatch 红。

门 6 负控：mutation helper 取锁行后，pid1 仍 `granted=true` 时 conn2 **返回**且无 `granted=false`。正控仍是等待 + `granted=false`。`pg_blocking_pids(pid1)` 空只 sanity。

另一姿态 / 另一门：门 7 正控指向审批 `:246`（扫描根外命中）；门 6 正控是任务结构锁等待，不是审批键。

#### ⑤ OPTIONAL

唯一谓词 `RBAC_OPTIONAL_ON := (env === '1')`。config `''`、setup 第四条、门 2/13/16 行尾同一。门 2/13 执行点 = `tests/tasks-integration/assert-rbac-optional-off.ts` import，不改共享 `setup.integration.ts`。

另一姿态 / 另一门：门 16 执行点是专属 setup；门 2/13 是任务 db import。谓词相同，文件不同。

#### ⑥ 跨 org

trust-off：claim 指向无活跃 `user_orgs` 的 org → `:387-405` 不回填 tenant → 写 422 / 读 `org_missing`。TRUST='true' 下 `:227` 把 claim 写入 user，`:259-264` 跳过 DB 解析，隔离格失效。

另一姿态 / 另一门：门 2/13 的 200 正控在 TRUST='true' 下 **不能**证明 org 隔离。

#### ⑦ 完成 / 日期 / 门 3–5

`any×0` 不经 any 谓词变 done。零负责人仅创建人 complete/reopen。all 重启 `scope=self|all`（《完成与重启任务》:35；:38 IM 切分）。全天 `due_at` = 当地 23:59:59.999。存活六格见锁门 3。门 4 反格 = all 部分完成。门 5 `href=/tasks/${id}`，全天 dueAt 用该瞬时 ISO。

另一姿态 / 另一门：门 3 增删人/切模式格在 §13-9 未裁下 **NOT 闭合**；六格是未切模式路径。门 8 日期逾期规则不替代门 5 的 PendingItem 形状。

#### ⑧ 门 19

只改 `buildTaskScopeCondition` assignee 臂一处 ⇒ assigned / pending / pending-count 三端同红。

另一姿态 / 另一门：门 4 测可见≠pending 语义；本门测派生链机械断裂，不是 self_completed。

#### ⑨ 权限门

`isRoutePermitted` every，先于焦点白名单。§13-10 未裁前后果留空。冒烟前置未满足不计退出。门 12 取证 = 组件 spec。

另一姿态 / 另一门：门 11 测两点接线；门 12 不测真机 redirect。

#### ⑩ P3

R10 逐句：只失效「① 缺失即 403」；②③ 缺一 403 与徽标缓解 OPERATIVE。直授+admission 403 钉无 `tasks:*` 且无 `_admin` 角色名（`:345`）。④ 非空负控先例 `:579-581`，首个 db 文件前 NOT RUN。user-activation 锚点 `:77`。

普查解析器解耦后（同文件打印 OOB 明细）：

```
unique 133 OK_IN_RANGE 122 OOB 0 MISSING 0 AMBIGUOUS 11
oob_total 0
ambiguous_total 11
```

（先前 5 条 index.ts OOB 现只计 AMBIGUOUS，不再兼入 OOB。）

#9 三条 `grep -R -E -l` 均空、exit 1。正控 `:246`。

#14 计数式：`39 0`。

#15 第五项：slash 4 处 + `§13-5 随 §13-11` 6 处 + §9 `:288`。

#### ⑪ §14-4 (d) 两遍（同 head）

```
路径形 unique 61
裸 :N unique 67
```

路径形头/尾：

```
.github/workflows/attendance-web-guard.yml:2-3
.github/workflows/docker-build.yml:484-488
.github/workflows/plugin-tests.yml:842-844
…
user-activation.ts:77
vitest.config.ts:1782
vitest.elearning-pilot-auth.config.ts:28-33
```

裸 `:N` 全集：

```
`:105
`:106-109
`:1069
`:108-118
`:11-38
`:111
`:116
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
`:1642
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
`:206
`:211-213
`:213
`:234
`:241
`:242
`:246
`:246-252
`:253
`:259-264
`:277
`:282-288
`:290-294
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
`:78
`:8
`:842-844
`:96
`:99
```

漂移豁免机核（`grep -nE '1782|:1069|1763-1777|:1642|AGENTS.md:48-50|guardPolicy.ts:29'`）命中锁 `:169` `:204` `:478` `:495`。

`git merge-base HEAD origin/main` = `bb77ca5f2ce3c2825265ec8877861d367d017ead`。相对 merge-base 仍三份 docs `A`。
