# 任务功能线 M0 交付报告（切片 A）

PR：https://github.com/zensgit/metasheet2/pull/5845 （Draft）。head SHA 以 §0 为准。

## 0. 头

- 切片：**A（M0 普查 + 锁草案 PROPOSED）**
- 计划冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`
- 本切片工作基线 / merge-base：`bb77ca5f2ce3c2825265ec8877861d367d017ead`（`git merge-base HEAD origin/main`；`#5872`）
- head SHA：内容 SHA 见本轮 SHA-record 提交（闸 §17 第十三轮；merge-base `bb77ca5f2ce3c2825265ec8877861d367d017ead`；本轮不 rebase）。若其后有 SHA-record 提交，末次仅回填本行。
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
| 15 | §13-9 / §13-10 / §13-11 / §13-12 标未裁，且 §13-5 随落槌 | 四处 slash + §9 表 §13-5 行 | `grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md` | slash `:9` `:25` `:437` `:667` |

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
8. **对抗闸未齐**：第十三轮 REJECT（闸 §17，0 P1 / 4 P2 / 11 P3）。本轮按 §17 一次改完、不 rebase。不声称 M0 退出门已过。
9. **飞书 `:21-23` vs 计划 §5-2**：计划把《完成与重启任务》:23 列为 `scope=self|all` 出处之一；锁按闸 P3-1 把 `:21-23` 标 IM 不对标，`:20` 单独支撑创建人完成范围。以闸 P3-1 为准，计划 :23 记偏离。
10. **`guardPolicy.ts` 行号漂移**：计划写 `:29` / `:77` / `:87-95`；本 SHA `ATTENDANCE_FOCUS_ALLOWED_PATHS` `:34`、`PLM_WORKBENCH_ALLOWED_PREFIXES` `:82`、`KNOWN_REQUIRED_FEATURES` `:100`，`/stock-prep` 无 `requiredFeature` 先例 `:90-99`（普查 §5.2 / §5.3）。

---

## 5. 未做 / 未验

1. **未连生产库**（也未连 staging）。
2. **未跑真库测试、未跑浏览器、未起 API 服务器**。
3. **闸未齐**：第十三轮 REJECT。本轮按闸 §17 一次改完、不 rebase。
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

## 6. 修复轮（闸 §17 第十三轮 0 P1 / 4 P2 / 11 P3）

未改 §13-9 / §13-10 / §13-11 / §13-12（§13-5 随 §13-11）。未合并。不 ratify。任务 B 未起。本轮不 rebase。机核命令均用锁内原串，在终稿锁上实跑。

| finding | 改动（自写） | 机制走查 | 联立 |
|---|---|---|---|
| ① P2-a 门 19 | 收集侧改 vitest verbose 执行产物抽 `gate19\|…`；`.each` 展开规则照门 17；`grep -h` 去前缀；两命令同一仓根 cwd；漏格负控删执行产物一行 | 源文件 grep 看不到 `.each` 展开行；verbose 行数 = 展开后静态计数 | 锁侧 `i-m2` 44 行；stdin 正控已跑 |
| ② P2-b §6.1 | delegated 加 `createdByMe ∧ ¬othersAssigned` 四格期望 ∅；8×5 表独立钉死；44 格人口隔离（独立用户或格间清库）；ambient 钉法唯一句，门 19 引用 | SQL 合取翻转：assigned/following/created 各有 T/F；delegated 两合取都有翻转 | 门 19 正控 = TS 谓词对拍钉死表 |
| ③ P2-c 门 20 | 无 I/O 改行为门：DB stub 一律抛，import 全部 `src/tasks` 并调导出；正控同 harness 调 `task-advisory-locks` 必红；ERE 降辅助 | stub 不死则正控不红、行为门无判别力 | 与 §6.4：keys 无 I/O、取锁在 `src/db/` |
| ④ P2-d §6.1 | 恢复 `R`/`A` 闭集与 `task-access.ts` 落点；§9 加偏离行；探针② 另开能力格置反 ⇒ complete 写路由红 | 真相表退出列表读路径；列表靠 TS↔SQL 对拍 | 探针① 仍改 assigned SQL 臂；验收与门 3 complete 联立 |
| ⑤ P3 | e 抬头「写路由约束」；门 2 403 逐字；门 7 GNU 平台限定；§6.4 `export async function`；门 21 T 按 `^exec npx vitest run` 抽且恰 1 行；门 22 两焦点格钉另一旗；门 3 播种完成后 complete 前 COUNT=n；`src/routes/permissions.ts:21`；M2 退出 = 已武装全绿 + NOT RUN 登记；范围表 `V` 五值 | 见各机核 | 真隔离 `:462` |
| ⑥ (d) 两遍 | 同 head 重核 | 见下 | 路径形 66；裸 81 |

### 机核（带引号完整命令与 exit）

**OPTIONAL 三处身份**：

```bash
grep -n "process.env.RBAC_OPTIONAL === '1'" docs/development/task-feature-design-lock-20260917.md
```

exit **0**。命中行 **121**（§4.3）、**191**（setup 守卫）、**586**（§13-1d）。

```bash
grep -n '全文唯一' docs/development/task-feature-design-lock-20260917.md
```

exit **1**（零命中）。

**创建期同形**（报告 :165 补命令）：

```bash
python3 -c "from pathlib import Path; t=Path('docs/development/task-feature-design-lock-20260917.md').read_text(); core='省略 \`assignees\` 字段 ⇒ 插入 creator 一行；显式 \`assignees: []\` 替换默认行（零负责人）；显式非空数组 = 只插入所列用户（可含或不含 creator）。'; print(t.count(core))"
```

exit **0**，stdout **3**（§4.2 `:99` / §6.2 `:348` / §9 `:401`）。

**I_M2 清单**：

```bash
sed -n '/^```i-m2$/,/^```$/p' docs/development/task-feature-design-lock-20260917.md | grep '^gate19|' | LC_ALL=C sort | wc -l
```

exit **0**，**44**。

**verbose 收集侧正控**（stdin；yml/测试未建）：

```bash
printf '%s\n' '✓ tests/integration/task-a.db.test.ts > gate19|assignee|assigned' '✓ tests/integration/task-b.db.test.ts > gate19|creator|delegated|noa' | grep -h -oE 'gate19\|[^[:space:]]+' | LC_ALL=C sort -u
```

exit **0**，两行 `gate19|assignee|assigned` / `gate19|creator|delegated|noa`（无路径前缀）。

```bash
printf '%s\n' '✓ tests/integration/task-a.db.test.ts > gate19|assignee|assigned' | grep -h -oE 'gate19\|[^[:space:]]+' | LC_ALL=C sort -u | wc -l
```

exit **0**，**1**（负控：删一格后少于 44）。

**门 21 T 恰一条 exec 行**：

```bash
grep -c -E '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh
```

exit **0**，stdout **1**。

```bash
grep -E '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh | tr ' ' '\n' | grep -E '^tasks.*\.spec\.ts$' | LC_ALL=C sort
```

零行（M0 尚无 tasks token；`sort` 空输入 exit **0**）。

**门 20 人口**：

```bash
find packages/core-backend/src/tasks -name '*.ts'
```

stderr `find: packages/core-backend/src/tasks: No such file or directory`；exit **1**（macOS）。

```bash
find packages/core-backend/src/tasks -name '*.ts' | wc -l
```

stdout **0**；管道 `wc` exit **0**。

**门 20 (A) ERE**（辅助；本机 macOS 缺目录 exit **1**；锁以 GNU exit 2 为准）：

```bash
grep -R -E --include='*.ts' --include='*.js' --include='*.cjs' \
  'from[[:space:]]+['\''"](\.\./)+db/|require\(['\''"](\.\./)+db/|import\(['\''"](\.\./)+db/' \
  packages/core-backend/src/tasks
```

exit **1**。(A) 正控：

```bash
grep -n -E 'from[[:space:]]+['\''"](\.\./)+db/' packages/core-backend/src/auth/session-registry.ts
```

exit **0** → `:2`。

```bash
grep -n -E 'require\(['\''"](\.\./)+db/' packages/core-backend/src/routes/workflow.ts
```

exit **0** → `:183`。

```bash
grep -n -E 'import\(['\''"](\.\./)+db/' packages/core-backend/src/observability/ObservabilityManager.ts
```

exit **0** → `:335`。

**门 20 (B) ERE**（辅助）：

```bash
grep -R -E --include='*.ts' --include='*.js' --include='*.cjs' \
  '\.query\(|FenceQuery|:\s*QueryFn' \
  packages/core-backend/src/tasks
```

exit **1**。(B) 正控：

```bash
grep -n -E '\.query\(' packages/core-backend/src/plugin/PluginRegistry.ts
```

exit **0** → `:800`。

```bash
grep -n FenceQuery packages/core-backend/src/multitable/recovery-archive-source-pin.ts
```

exit **0** → `:1`。

```bash
grep -n -E ':\s*QueryFn' packages/core-backend/src/approvals/approval-departure-transfer-dispatch.ts
```

exit **0** → `:24`。

**门 21 paths glob**：

```bash
printf '%s\n' 'apps/web/tests/tasksFoo.spec.ts' 'apps/web/tests/tasks*.spec.ts' | grep -oE 'apps/web/tests/tasks[^[:space:]*]+\.spec\.ts'
```

exit **0**，只抽 `tasksFoo.spec.ts`。

```bash
printf '%s\n' 'apps/web/tests/tasksFoo.spec.ts' 'apps/web/tests/tasks*.spec.ts' | grep -oE 'apps/web/tests/tasks[^[:space:]]+\.spec\.ts'
```

exit **0**，两行都抽。

**(d) 每 token**（块外正文 `/tmp/r13-body.txt`，692 行）：

```bash
python3 -c 'from pathlib import Path
p=Path("docs/development/task-feature-design-lock-20260917.md")
lines=p.read_text().splitlines(True); out=[]; skip=False
for line in lines:
    if line.startswith("```drift-exempt"):
        skip=True; continue
    if skip and line.startswith("```"):
        skip=False; continue
    if not skip: out.append(line)
Path("/tmp/r13-body.txt").write_text("".join(out))'
```

exit **0**。逐条 `grep -nF '<token>' /tmp/r13-body.txt | grep '已漂'`：

```bash
grep -nF ':1782' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:175`）。

```bash
grep -nF ':1069' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:215`）。

```bash
grep -nF ':1763-1777' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:428`）。

```bash
grep -nF ':1642' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:428`）。

```bash
grep -nF 'AGENTS.md:48-50' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:428`）。

```bash
grep -nF 'guardPolicy.ts:29' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:163`）。

```bash
grep -nF 'system-sheet-predicate.ts:39-42' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:385`）。

```bash
grep -nF 'history-trust-checkpoint.ts:82-85' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:385` 同句）。

```bash
grep -nF ':1785' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:428`）。

```bash
grep -nF ':1797' /tmp/r13-body.txt | grep '已漂'
```

exit **0**，HITS **1**（`:175`）。

共句：§7 两 token 同 SYSTEM_SHEET_KINDS 句 `:385`；§10 四 token 同挂载句 `:428`；`:1782` 与 `:1797` 同 e2e glob 句 `:175`。

**slash 四连**：

```bash
grep -n -F "§13-9 / §13-10 / §13-11 / §13-12" docs/development/task-feature-design-lock-20260917.md
```

exit **0** → `:9` `:25` `:437` `:667`。

**真隔离** 终稿 `:462`。

### ⑥ 两遍导出

路径形 unique **66**（`/tmp/r13-d1.txt`）。裸 `:N` unique **81**（`/tmp/r13-d2.txt`）：

```
`:101
`:105
`:106-109
`:1069
`:108-118
`:11-38
`:111
`:116
`:117-118
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
`:1697
`:171-176
`:1763-1777
`:1782
`:1785
`:1797
`:1812
`:182-186
`:191
`:196-199
`:200-203
`:203-243
`:206
`:209
`:211-213
`:234
`:241
`:242
`:243
`:244
`:246
`:246-252
`:25
`:253
`:277
`:282-288
`:302
`:34
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
`:63
`:68-70
`:68-72
`:71
`:71-73
`:74-76
`:748
`:75-77
`:77-83
`:8
`:82-86
`:842-844
`:9
`:91-97
`:94
`:96
`:99
```

两遍命令（锁 §14-4 (d) 原串）：

```bash
LOCK=docs/development/task-feature-design-lock-20260917.md
grep -oE '[A-Za-z0-9_./-]+\.(ts|js|cjs|mjs|yml|yaml|md|vue|sh|json):[0-9]+(-[0-9]+)?' "$LOCK" | sort -u
grep -oE "$(printf '\140'):[0-9]+(-[0-9]+)?" "$LOCK" | sort -u
```

exit 皆 **0**。

`git merge-base HEAD origin/main` = `bb77ca5f2ce3c2825265ec8877861d367d017ead`。相对 merge-base 仍三份 docs `A`。
