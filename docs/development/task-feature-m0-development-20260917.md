# 任务功能线 M0 交付报告（切片 A）

PR 链接与 head SHA 在开 PR 后填入本节首段（开 PR 前本文件与普查、锁草案一并提交；PR 号回填见开 PR 后的 `gh pr view` 摘录）。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / 分支起点：`c6679d0f6990572139fd604c7cfe6f6427d47aa7`（`git fetch origin main` 后的 `origin/main`；相对计划基线已前进。普查机械核在 `00781e68b`，ff 到本 SHA 仅 attendance docs）
- head SHA：开 PR 后与 `git rev-parse HEAD` 相同（docs-only，应等于基线或再加本三文件 commit）
- PR #：开 PR 后回填
- mergeable_state：开 PR 后粘贴 `gh pr view <N> --json mergeable,mergeStateStatus,statusCheckRollup` 原始输出
- 一句话：在独立 worktree `grok/tasks-m0` 上写了普查、PROPOSED 锁草案（elearning §0–§15 编号、§8 N/A、39 题建议答案）、本报告；开 docs-only Draft PR-0，不合并。

按简报 §2 / 用户 §四 **明确没做什么**：

1. 未写 DDL、未挂路由、未改共享文件（先锁后建）。
2. 无迁移文件（因此无「含 DDL」PR 段；本 PR 是 docs-only）。
3. 不合并任何 PR。
4. 未创建 `zzzz*.ts` 迁移。
5. 未在任何列上使用 `[!-~]`（无 DDL）。
6. 未声称真库三点接线「门全绿」；§13-12 未裁。
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
| 1 | 写成时 `origin/main` = `c6679d0f6990572139fd604c7cfe6f6427d47aa7` | 工作树 HEAD | `git fetch origin main && git rev-parse origin/main` | `c6679d0f6990572139fd604c7cfe6f6427d47aa7` |
| 2 | 计划 v5 288 行且 MD5 匹配声明 | 计划文件 | `md5 -q …/task-feature-development-plan-20260915.md && wc -l …` | `f74e172840d2aa2502216d0dd8dff867` / `288` |
| 3 | 飞书语料 html 篇数为 26 | 语料目录 | `ls …/articles/*.html \| wc -l` | `26` |
| 4 | 本地主库 `to_regclass('public.tasks')` 为 NULL | census §1 | 见普查 SQL | `tasks` 列空 |
| 5 | `createTable`/`CREATE TABLE` 扫描下没有表名 `tasks` 或 `task_*` | census §3 | 普查 §3 复现命令 | 命中仅 `gantt_tasks` / `gantt_task_resources` / `bpmn_user_tasks` / `bpmn_external_tasks` |
| 6 | 正控：`gantt_tasks` 出现在 `createTable` | `20250924140000_create_gantt_tables.ts:13` | `sed -n '13p' packages/core-backend/src/db/migrations/20250924140000_create_gantt_tables.ts` | `.createTable('gantt_tasks')` |
| 7 | `NON_NAMESPACED_PERMISSION_RESOURCES` 不含 `'tasks'` | `namespace-admission.ts:11-38` | `sed -n '11,38p' packages/core-backend/src/rbac/namespace-admission.ts` | 集合止于 `'workflow'`，无 `tasks` |
| 8 | `exec npx vitest run` 在 `:1186` 不在 `:1069`；token 392；含 `task` 的 token 数为 0 | `run-required-web-tests.sh` | census §4 命令 | 1069=注释；1186=`exec`；392；0 |
| 9 | 拟用锁前缀 `task-structure:` / `task-projection:` / `tasks-scheduler:` 未作为既有字面键前缀出现 | census §2 | `rg -n "task-structure:|task-projection:|tasks-scheduler:" packages/core-backend/src plugins --glob '!**/node_modules/**'` | 期望 0 命中（实现前） |
| 10 | 本地主库活跃多成员用户数 = 0（仅代表该库） | census §1.3 | QUERY B | `multi_active_member_users = 0`，分母 115 |
| 11 | 审批路由挂载不在计划写的 `index.ts:1763-1777` | `index.ts:1785` | `rg -n "approvalsRouter" packages/core-backend/src/index.ts` | `1785:    this.app.use(approvalsRouter({` |
| 12 | `docker-build.yml` 对 `docs/**` paths-ignore | `:4-8` | `sed -n '4,8p' .github/workflows/docker-build.yml` | `paths-ignore: docs/**` |
| 13 | 锁草案含 §0–§15 且 §8 为 N/A 一行 | 锁文件 | `rg -n "^## " docs/development/task-feature-design-lock-20260917.md` | 见 §3 |
| 14 | 锁草案 §13 含题号 1–39 | 锁文件 | `rg -n "^\*\*(1[0-9]\|2[0-9]\|3[0-9]\|[1-9])\." docs/development/task-feature-design-lock-20260917.md` | 1–39 均有 |
| 15 | §13-10 与 §13-12 标未裁 | 锁 §13 | `rg -n "未裁" docs/development/task-feature-design-lock-20260917.md` | 题 10、12 |

---

## 2. 测试

- **本地**：本切片 docs-only，**没有**新增/运行产品测试。未跑 `pnpm test`、未跑 vitest、未跑浏览器。
- **收集用例数**：本地 0（未收集）。CI：纯 `docs/**` PR 按 `docker-build.yml:6-7` 不跑 build；`web-tests.yml` 无 paths 会跑 required web 闸（既有 392 token，与本 diff 无关）。**不得把 web-tests 绿当成任务 spec 已接线。**
- **CI lane**：开 PR 后把 run URL 与日志收集数回填。本报告写成时无 run URL。
- **mutation 探针**：未改生产守卫。docs-only 无「neuter 守卫 → 测试红」探针。
- **正控**：双语法正控见断言 #6；token 行正控见 census §4 首尾 token；`user_orgs` 正控为 QUERY A/B 分母等于 `COUNT(*) FROM users`（115）。

---

## 3. 接线核对（计划 §8，本切片只核、不接线）

| §8 条 | 本切片 | 命令/结果 |
|---|---|---|
| 8-1 真库三点 | 未加 `task-*.db.test.ts`，未改 `vitest.config.ts`，未建 lane。§13-12 未裁 | 不声称门全绿 |
| 8-2 前端两点 | 未加 spec、未建 `tasks-web-guard.yml`、未改 token 行 | `rg -n "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh` → `:1186`；含 task 的 token = 0 |
| 8-3 五段部署链 | docs-only；`paths-ignore: docs/**` | `sed -n '4,8p' .github/workflows/docker-build.yml` |
| 8-4 路由注册 | 未挂 | `index.ts` 审批段现 `:1785` |
| 8-5 PR body | 不写 close #N；无 DDL 句（无迁移） | 开 PR 后自检 `rg -io "(close[sd]?\|fix(es\|ed)?\|resolve[sd]?) #?[0-9]+"` |
| 8-6 required checks | 开 PR 后读 API | `gh api repos/zensgit/metasheet2/branches/main/protection`（先不带 `--jq`） |
| 8-7 授权账本 | 无合并授权 | 不伪造 |
| 8-8 注释点名 | 未改生产源码 | — |
| 8-9 DML 分类 | 未登记 `table-classification.cjs` | 未改该文件 |
| 8-10 RBAC_OPTIONAL 断言 | 无新 lane | — |

`plugin-tests.yml` 未改（s6a pin `:90` 仍为 `5902a850c3d254c20b0caf330b21da896703648265ae7a588b973f793727a0cf`）。

---

## 4. 偏离与 UNCLEAR

1. **main 前进**：计划基线 `062614f44` → 本切片 `c6679d0f6`（中途核过 `00781e68b`）。§8 若干行号相对计划漂移（census §5.1）：`run-required-web-tests.sh:1069`、`vitest.config.ts:1782`、`index.ts:1763-1777`、`AGENTS.md:48-50`。未自行把计划改成新行号。
2. **交接件 §四.3 vs 计划 §2**：用户文本非空。以计划两类约束为准，写入锁 §4.1。
3. **仓根无 `CLAUDE.md`**：章程以 `AGENTS.md` + 工作区 `~/Downloads/Github/CLAUDE.md` 为准（Q6）。本 SHA `AGENTS.md:48-50` 不是两点接线段。
4. **`user_orgs` 生产分布 UNCLEAR**（裁定不连生产）。本地活跃多成员 = 0。
5. **`hashtext` 数值碰撞 UNCLEAR**：只做字面前缀差。
6. **§13-10 / §13-12 未裁**。
7. **待办中心锁未 ratify**：PendingItem 按交接件临时六字段；R1。
8. **两轮对抗闸未进行**（Q4：Claude 闸，本切片只交 PROPOSED）。
9. 计划 M0 退出门「两轮独立对抗审吸收」尚未满足——本报告不声称 M0 退出门已过。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **两轮闸未进行**（待 owner 把本报告路径 + PR 号交给新 Claude 窗口）。
4. **§13-10 / §13-12 未裁**。
5. 未实现任务 B 纯函数与单测。
6. 未写迁移、路由、服务、前端（任务 C 禁止）。
7. 未改任何共享文件 / workflow / token 行。
8. 未验证 s6a pin 在「若将来改 plugin-tests.yml」下的重算（本切片未改）。
9. 未对 133 条计划锚点逐条把 `sed -n` 全文贴进本报告（census §5 给了 §8 全表 + 承重抽查；完整 JSON 在本地 `/tmp/task-m0-anchor-results2.json`，不入库）。
10. 未把 392 token 全文列入仓库文件。
11. 飞书 IM/P2 篇在锁 §2 用计划已蒸馏的承重机制，未在本报告逐篇贴原文行。
12. 开 PR 前无 `mergeable` JSON（开 PR 后回填到 §0）。

不许写「全部完成」。本切片交付 = 三份 docs + Draft PR-0。
