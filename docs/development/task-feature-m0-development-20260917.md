# 任务功能线 M0 交付报告（切片 A）

PR：https://github.com/zensgit/metasheet2/pull/5845 （Draft）。head SHA 以 §0 为准。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / merge-base：`bb77ca5f2ce3c2825265ec8877861d367d017ead`（`git merge-base HEAD origin/main`；`#5872`）
- head SHA：本轮内容提交后回填（闸 §9；merge-base `bb77ca5f2ce3c2825265ec8877861d367d017ead`；本轮不 rebase）。内容 SHA 为前者；若其后有 SHA-record，末次仅回填本行。
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
6. 未声称真库接线①②③④「门全绿」；§13-9 / §13-10 / §13-12 未裁。
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
| 5 | `createTable`/`CREATE TABLE` 扫描下没有表名 `tasks` 或 `task_*` | census §3 | 普查 §3 复现命令 | 命中仅 `gantt_tasks` / `gantt_task_resources` / `bpmn_user_tasks` / `bpmn_external_tasks` |
| 6 | 正控：`gantt_tasks` 出现在 `createTable` | `20250924140000_create_gantt_tables.ts:13` | `sed -n '13p' packages/core-backend/src/db/migrations/20250924140000_create_gantt_tables.ts` | `.createTable('gantt_tasks')` |
| 7 | `NON_NAMESPACED_PERMISSION_RESOURCES` 不含 `'tasks'` | `namespace-admission.ts:11-38` | `sed -n '11,38p' packages/core-backend/src/rbac/namespace-admission.ts` | 集合止于 `'workflow'`，无 `tasks` |
| 8 | `exec npx vitest run` 在 `:1186` 不在 `:1069`；token 394；含 `task` 的 token 数为 0 | `run-required-web-tests.sh` | census §4 命令 | 1069=注释；1186=`exec`；394；0 |
| 9 | 拟用锁前缀 `task-structure:` / `task-projection:` / `tasks-scheduler:` 未作为既有字面键前缀出现 | census §2 | `rg -n "task-structure:|task-projection:|tasks-scheduler:" packages/core-backend/src plugins --glob '!**/node_modules/**'` | 实际：0 行输出、exit 1（无命中）。正控：同命令族可命中 `` `approval-projection:${instanceId}` ``（census §2.1 / `approval-record-projection-service.ts`） |
| 10 | 本地主库活跃多成员用户数 = 0（仅代表该库） | census §1.3 | QUERY B | `multi_active_member_users = 0`，分母 115 |
| 11 | 审批路由挂载不在计划写的 `index.ts:1763-1777` | `index.ts:1791` | `grep -n -F "this.app.use(approvalsRouter" packages/core-backend/src/index.ts` | `1791:    this.app.use(approvalsRouter({` |
| 12 | `docker-build.yml` 对 `docs/**` paths-ignore | `:4-8` | `sed -n '4,8p' .github/workflows/docker-build.yml` | `paths-ignore: docs/**` |
| 13 | 锁草案含 §0–§15 且 §8 为 N/A 一行 | 锁文件 | `rg -n "^## " docs/development/task-feature-design-lock-20260917.md` | 见 §3 |
| 14 | 锁草案 §13 含题号 1–39 各恰一次 | 锁文件 | 见锁 §13 标题 `**N.`（N=1…39） | 39 题标题均在 |
| 15 | §13-9 / §13-10 / §13-12 标未裁 | 文件头 bullet `:9` / §0 `:25` / §11 `:307` / §14-3 `:436`；§13 前言 `:347` 用顿号，另核 | `grep -n -F "§13-9 / §13-10 / §13-12" docs/development/task-feature-design-lock-20260917.md` | `:9` `:25` `:307` `:436` 四行 |

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
6. **§13-9 / §13-10 / §13-12 未裁**。
7. **待办中心锁未 ratify**：PendingItem 按交接件临时六字段；R1。
8. **对抗闸未齐**：第五轮 REJECT（`gate-task-m0-20260917.md` §9，1 P1 / 10 P2 / 5 P3；第二轮独立审同 head 亦 REJECT）。本轮按 §9 一次改完。不声称 M0 退出门已过。
9. **飞书 `:21-23` vs 计划 §5-2**：计划把《完成与重启任务》:23 列为 `scope=self|all` 出处之一；锁按闸 P3-1 把 `:21-23` 标 IM 不对标，`:20` 单独支撑创建人完成范围。以闸 P3-1 为准，计划 :23 记偏离。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **闸未齐**：第五轮 REJECT。本轮按闸 §9 一次改完、不 rebase；待闸方亲核门 16/2/8/9 文本与 §7 新句。
4. **§13-9 / §13-10 / §13-12 未裁**。
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

## 6. 修复轮（闸 §9 第五轮 1 P1 / 10 P2 / 5 P3）

未改 §13-9 / §13-10 / §13-12 的未裁状态。未合并。不 ratify。任务 B 未起。本轮不 rebase。**表内命令均已实跑。**

| finding | 改动 | 命令 | 输出摘录 |
|---|---|---|---|
| ① 门 16 两格对照 | 判别格 403 / 对照格 200 / 自检 / 禁 ② 缺失当证据 / 禁 RBAC_OPTIONAL=1 | `grep -n -F "两格对照" docs/development/task-feature-design-lock-20260917.md` | `:332` 两格对照；`:337` 自检句 |
| ② §7 deny 加载点 | 挂 §13-11；门 9 NOT RUN；负控乙改泄漏格 HTTP 200 | `grep -n -F "NOT RUN" …design-lock…` | `:262` `:323` `:341` `:390` |
| ③ 门 8 due_at | 钉 `2026-09-15T18:00:00Z`；护栏不同本地日期 | `grep -n -F "2026-09-15T18:00:00Z" …design-lock…` | `:322` 含该瞬时与「不同本地日期」 |
| ④ 门 2 FK | 负控缺②/缺③ 各 403 + 无①插② ⇒ 23503 | `grep -n -F "23503" …design-lock…` | `:23` `:142` `:316` |
| ④ FK 源 | 迁移约束名 | `sed -n '108,112p' packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts` | `conname = 'role_permissions_permission_code_fkey'` / `ON DELETE CASCADE` |
| ⑤ id `__` | CHECK `col !~ '__'` + parse 首个 `__` + 422 | `grep -n -F "col !~ '__'" …design-lock…` | `:92` `:259` |
| ⑥ 三守卫 / 断言强度 / 先例区间 | 照抄 `:68-76`；matchAll===1；`:108-118`/`:120-168` | `grep -n -F ":108-118" …design-lock…` | `:178` `:330` |
| ⑦ 解析器 | 脚本未删改真输出 | 见下代码块 | unique 133 / OOB 5 四元组 / AMBIGUOUS 11 行 / ambiguous_total 11 |
| ⑦ #15 | 四行 slash 清单 | `grep -n -F "§13-9 / §13-10 / §13-12" …design-lock…` | `:9` `:25` `:307` `:436` |
| ⑦ 形状 | vs merge-base name-status | `git diff --name-status $(git merge-base HEAD origin/main) HEAD` | 三行 `A docs/development/task-feature-…`（本轮 commit 后仍三 docs） |
| ⑦ build 理由 | 无 pull_request 触发器 | `sed -n '3,9p' .github/workflows/docker-build.yml` | `on:` `push` + `workflow_dispatch`，无 `pull_request` |
| ⑧ RBAC 计分 | §13-10 落槌前门 2/13/16 不进计分 | `grep -n -F "不进验收计分" …design-lock…` | `:316` `:327` `:337` `:341` |
| ⑨ pin 漂移 | 本 SHA 5902a850；origin/main b37a589f | `sed -n '90p' …/s6a-package-provenance-pins.json` 与 `git show origin/main:… \| sed -n '90p'` | 本 SHA `5902a850…`；origin/main `b37a589f…` |

### 本轮实跑（merge-base `bb77ca5f2`；不 rebase）

`git merge-base HEAD origin/main`：

```
bb77ca5f2ce3c2825265ec8877861d367d017ead
```

`git diff --name-status $(git merge-base HEAD origin/main) HEAD`（commit 前 HEAD 仍为 `5ce1d0878` 三行 A；本轮提交后仍只三 docs）：

```
A	docs/development/task-feature-census-20260917.md
A	docs/development/task-feature-design-lock-20260917.md
A	docs/development/task-feature-m0-development-20260917.md
```

`grep -n -F "§13-9 / §13-10 / §13-12" docs/development/task-feature-design-lock-20260917.md`：

```
9:- 实现者不得批准自己的安全结论。§13-9 / §13-10 / §13-12 标「未裁」。
25:本锁 **PROPOSED**。M2 实体核心（DDL/路由/前端）要等 M1 ratify **且** §13-9 / §13-10 / §13-12 落槌。
307:| M1 | owner comment ID | 本锁 | §13-9 / §13-10 / §13-12 落槌 |
436:3. **§13-9 / §13-10 / §13-12 必须落槌** 才进入 M2。
```

`sed -n '3,9p' .github/workflows/docker-build.yml`：

```
on:
  push:
    branches: [main, master]
    paths-ignore:
      - 'docs/**'
      - 'output/**'
  workflow_dispatch:
```

`sed -n '108,112p' packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts`：

```
        SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_permission_code_fkey'
      ) THEN
        ALTER TABLE role_permissions
        ADD CONSTRAINT role_permissions_permission_code_fkey
        FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE;
```

`sed -n '90p' plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`：

```
    "pluginTestsWorkflow": "5902a850c3d254c20b0caf330b21da896703648265ae7a588b973f793727a0cf"
```

`git show origin/main:plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json | sed -n '90p'`：

```
    "pluginTestsWorkflow": "b37a589feff9ee45b804ab6936947053f4e813480bd69c7dfd4973f0a4790ba6"
```

锁 §14-4 普查解析器。命令行：

```
TASK_FEATURE_PLAN_PATH=/Users/chouhua/Downloads/Github/metasheet2/docs/development/task-feature-development-plan-20260915.md python3 - <<'PY'
# body = census :216-283
```

未删改真输出：

```
unique 133 OK_IN_RANGE 128 OOB 5 MISSING 0 AMBIGUOUS 11
NOTE OK_IN_RANGE means line numbers fit the resolved file, not that the file is the intended one
OOB ('index.ts', '1763-1766', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '1642', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '1763-1777', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '3836-3850', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '3766', 'apps/web/src/multitable/index.ts', 69)
AMBIGUOUS ('routes/auth.ts', '1220-1251', 'packages/core-backend/src/routes/auth.ts', 2)
AMBIGUOUS ('routes/auth.ts', '1230-1232', 'packages/core-backend/src/routes/auth.ts', 2)
AMBIGUOUS ('index.ts', '1763-1766', 'apps/web/src/multitable/index.ts', 18)
AMBIGUOUS ('index.ts', '1642', 'apps/web/src/multitable/index.ts', 18)
AMBIGUOUS ('index.ts', '1763-1777', 'apps/web/src/multitable/index.ts', 18)
AMBIGUOUS ('approvals/api.ts', '37-38', 'apps/web/src/utils/api.ts', 3)
AMBIGUOUS ('integrations/dingtalk/client.ts', '1067', 'apps/web/src/multitable/api/client.ts', 4)
AMBIGUOUS ('index.ts', '3836-3850', 'apps/web/src/multitable/index.ts', 18)
AMBIGUOUS ('index.ts', '3766', 'apps/web/src/multitable/index.ts', 18)
AMBIGUOUS ('plugin-tests.yml', '1655', '.github/workflows/plugin-tests.yml', 3)
AMBIGUOUS ('plugin-tests.yml', '5', '.github/workflows/plugin-tests.yml', 3)
ambiguous_total 11
```

`TASK_FEATURE_PLAN_PATH` 未设：`TASK_FEATURE_PLAN_PATH: set me`（非零退出）。

抽查 `sed -n` / `grep -n`（本 SHA = merge-base `bb77ca5f2`）：

```
vitest.config.ts:1812     'tests/e2e/**'
index.ts:1791             this.app.use(approvalsRouter({
run-required-web-tests.sh:1186  exec npx vitest run …
plugin-tests.yml:842-844  Run core-backend tests
plugin-tests.yml:1655     approval-comments.db.test.ts（origin/main 该行在 :1659）
jwt-middleware.ts:101-104 authenticatedTenantId
AGENTS.md 74 行 / :68
```
