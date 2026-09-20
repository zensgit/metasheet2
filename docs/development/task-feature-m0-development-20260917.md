# 任务功能线 M0 交付报告（切片 A）

PR：https://github.com/zensgit/metasheet2/pull/5845 （Draft）。head SHA 以 §0 为准。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / merge-base：`bb77ca5f2ce3c2825265ec8877861d367d017ead`（`git merge-base HEAD origin/main`；`#5872`）
- head SHA：内容 SHA `bb18b1c642d94c3ef5fb9964eace12f2abc3d885`（闸 §13 第九轮；merge-base `bb77ca5f2ce3c2825265ec8877861d367d017ead`；本轮不 rebase）。若其后有 SHA-record 提交，末次仅回填本行。
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
6. 未声称真库接线①②③④「门全绿」；§13-9 / §13-10 / §13-11 / §13-12 未裁（§13-5 随 §13-11，单独未裁亦阻断 M2）。闸方建议把 ratify 拆成「设计正文」与「§12 门表随 M2 源码 PR」两层，**owner 未裁**，本轮仍按现协议改。
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
| 14 | 锁草案 §13 含题号 1–39 各恰一次（多重集） | 锁文件 | `python3 -c "import re; from collections import Counter; from pathlib import Path; t=Path('docs/development/task-feature-design-lock-20260917.md').read_text(); nums=[int(n) for n in re.findall(r'\*\*(\d+)\.', t) if 1<=int(n)<=39]; c=Counter(nums); print('unique', len(c), 'multiset', len(nums), 'dupes', dict((k,v) for k,v in c.items() if v>1), 'missing', [i for i in range(1,40) if i not in c])"` | `unique 39 multiset 39 dupes {} missing []`。mutation：副本再插入一个 `**14.` ⇒ `unique 39 multiset 40 dupes {14: 2}` |
| 15 | §13-9 / §13-10 / §13-11 / §13-12 标未裁，且 §13-5 随落槌 | 四处 slash + §9 表 §13-5 行 | `grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md` ； `grep -n -F "§13-5 随 §13-11" …` ； `grep -n "\| §13-5 \|" …` | slash `:9` `:25` `:336` `:496`；§9 仍有 §13-5 行 |

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
8. **对抗闸未齐**：第九轮 REJECT（`reviews/gate-task-m0-20260917.md` §13，1 P1 / 9 P2 / 12 P3；第六轮独立审同 head 亦 REJECT）。本轮按 §13 一次改完、不 rebase。不声称 M0 退出门已过。闸方建议 ratify 两层拆分，owner 未裁。
9. **飞书 `:21-23` vs 计划 §5-2**：计划把《完成与重启任务》:23 列为 `scope=self|all` 出处之一；锁按闸 P3-1 把 `:21-23` 标 IM 不对标，`:20` 单独支撑创建人完成范围。以闸 P3-1 为准，计划 :23 记偏离。
10. **`guardPolicy.ts` 行号漂移**：计划写 `:29` / `:77` / `:87-95`；本 SHA `ATTENDANCE_FOCUS_ALLOWED_PATHS` `:34`、`PLM_WORKBENCH_ALLOWED_PREFIXES` `:82`、`KNOWN_REQUIRED_FEATURES` `:100`，`/stock-prep` 无 `requiredFeature` 先例 `:90-99`（普查 §5.2 / §5.3）。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **闸未齐**：第九轮 REJECT。本轮按闸 §13 一次改完、不 rebase。
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

## 6. 修复轮（闸 §13 第九轮 1 P1 / 9 P2 / 12 P3）

未改 §13-9 / §13-10 / §13-11 / §13-12（§13-5 随 §13-11）。未合并。不 ratify。任务 B 未起。本轮不 rebase。闸方建议 ratify 两层拆分，owner 未裁，仍按现协议改门表。

| finding | 改动 | 命令 | 输出摘录 |
|---|---|---|---|
| ① 门 6 P1 | harness 直发 SQL 持锁；禁令不含 harness；计生产返回；cp+cmp；pg_locks 键匹配 | `sed -n '204,211p' packages/core-backend/src/multitable/canonical-sheet-fence.ts` | `fenceWriterEntry` → fence then `:191` |
| ② 门 16 | 直授/jsonb/只有 write 逐条钉；三层检出；4xx 降级为 8 种 | `sed -n '748p' packages/core-backend/src/auth/AuthService.ts` ； `sed -n '85,96p' …/rbac/service.ts` | `listUserPermissions` 三路 ∪ |
| ③ 门 7 | 扫描根扩任务域全体；命中==登记三行；NOT RUN 至源码 PR | `grep -n "src/db/task-\*" …design-lock…` | 门 7 正文 |
| ④ 门 1 | 九项前置+RBAC；422 在 rbac 后；真隔离格；1c 未设门 | `sed -n '101,104p' …/jwt-middleware.ts` | org 写入在 authenticate 内，422 在 handler |
| ⑤ 门 19 | 四轴网格+格数；探针①②各配正控 | `grep -n "探针①" …` | 门 19 |
| ⑥ ④ import | 每文件 assert-rbac-optional-off；web 偏离 | `grep -n assert-rbac-optional-off …` | §5.2.1 ④ |
| ⑦ 门 22 | 后果写死；行为 spec 必须计分 | `sed -n '548,556p' apps/web/src/composables/useAuth.ts` | admin 短路 |
| ⑧ event_type | P0-A 差集空；词表+索引抄进锁；门 20 无 I/O | 见普查 §8 | `p0a_missing_from_vocab []` |
| ⑨ fenceWriterEntry | 中间步改回 `:204`；provenance 分层 | `sed -n '244p' …/approval-record-projection-service.ts` | `fenceWriterEntry` |
| ⑩ P3 | #14 多重集；解析器 AMBIGUOUS_OK/OOB；豁免排除清单行 | 见下 | unique 39/39；AMB_OK 6 AMB_OOB 5 |
| ⑪ (d) | 同 head 两遍 | 见下 | 路径形 63；裸 `:N` 77 |

### 机制走查

#### ① 门 6 负控不得破坏连接 1 持锁

连接 1 取锁路线 = harness `SELECT pg_advisory_xact_lock(hashtext($1))`，参数来自 `taskStructureLockKey`。§6.4 禁令作用域 = 任务域生产源码（登记 helper 三行除外）；harness 不受禁令。mutation 注释 helper 取锁行后连接 1 仍持锁。被计时对象 = 经 helper 的生产结构变更调用返回，不是被删行。证据：`cp` 备份 → 改 → `cmp` 非空 → 跑 → `cp` 恢复。

`pg_locks`：`classid=(hashtext::bigint>>32)&4294967295`（负 hashtext 时 4294967295）、`objid=hashtext::bigint&4294967295`。等待：`wait_event_type='Lock'` 且 `wait_event='advisory'`。未阻塞零行正控。

另一姿态 / 另一门：门 7 扫的是源码字面量集合，不是运行时 pg_locks。

#### ② 门 16 trust-off 三路 ∪

缺 `user_permissions`/`jsonb` 钉或 `role_permissions` 不只有 write ⇒ `listUserPermissions` 并入 `tasks:read`/`*:*` ⇒ `rbac.ts:78` 先于 `:94/:101` 放行 ⇒ 两姿态 200。§5.1 直授过不了准入是条件句（ns 不在 controlledNamespaces）；门 16 判别格是反例。roles 不在九项 trust-off 前置（`:213` 合取，带 perms 不早返回）。检出三层见锁。4xx 至少 8 种可区分；422 在 rbac 后。

另一姿态 / 另一门：门 2 TRUST=true 要 no-perms；本门 TRUST=false 要 perms 在场。

#### ③–⑪ 其余

门 7 根含 `src/db/task-*`，登记集合 = helper 三行，谓词相等；源码 PR 前 NOT RUN。门 1 真隔离 + 422 归类修正。门 19 四轴；探针① 恢复。门 22 必须计分。event_type P0-A 差集空。`fenceWriterEntry:204`。#14 mutation `**14.` ⇒ multiset 40 dupes {14:2}。解析器 `unique 133 OK 122 OOB 0 AMB 11`（OK 6 / OOB 5）。OPTIONAL `grep -c "RBAC_OPTIONAL === '1'"` = 2。

#### ⑪ §14-4 (d) 两遍（同 head）

路径形 unique **63**。裸 `:N` unique **77**（含 `:748` `:204` `:191` `:244` `:156` `:75-76`）。

路径形头/尾：

```
.github/workflows/attendance-web-guard.yml:2-3
…
useAuth.ts:548-556
user-activation.ts:77
vitest.config.ts:1782
```

裸 `:N` 全集见本轮 `/tmp/r9-d2.txt` 实跑 77 条（`:101` … `:99`）。

豁免机核排除清单行后仍命中 §5.2 `:29→:34`、§10 `:1642→:1791`、§5.2.1 `:1782`、§5.3 `:1069`。

`git merge-base HEAD origin/main` = `bb77ca5f2ce3c2825265ec8877861d367d017ead`。相对 merge-base 仍三份 docs `A`。
