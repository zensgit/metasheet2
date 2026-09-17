# 任务功能线 M0 普查

- 日期：2026-09-17
- 状态：普查记录（不是设计锁，不构成授权）
- 工作树：`../metasheet2-tasks-m0` 分支 `grok/tasks-m0`
- **基线 SHA（本文件写成时 `origin/main`）**：`c6679d0f6990572139fd604c7cfe6f6427d47aa7`（`docs(attendance): back-fill the ratified class-01 rewrite… (#5777)`）
- 计划 v5 冻结基线：`062614f4407b3d9bffc82dae266071b8a6e5e5bd`。main 已前进。普查机械核在 `00781e68b8a6a8ec8fc7b04f358eefedcd6c3b00` 上完成；随后 `git pull --ff-only` 到本 SHA（仅 attendance 锁文，与 §8 代码锚点零交集）。§8 锚点在 ff 后抽查 `run-required-web-tests.sh` exec 行、`index.ts` 审批挂载、`AGENTS.md:48-50`、`docker-publish-preflight.mjs:19` 未再漂移（见 §5）。
- 输入：计划 v5 MD5 `f74e172840d2aa2502216d0dd8dff867`；交接件 / 审阅件 v2 / 飞书 26 篇离线语料。
- 范围：只读普查。未连 staging/生产。未跑浏览器。未应用迁移。

---

## 1. `user_orgs` 普查（只连本地开发库）

### 1.1 库身份（主库 = 工作区 `packages/core-backend/.env` 的 `DATABASE_URL`）

判定「本地」：host 为 `127.0.0.1` / `localhost`，且 `version()` 为本机 Postgres。未连任何非 loopback 主机。

| 项 | 主库（`.env`） | 旁路（compose 容器，仅对照） |
|---|---|---|
| 连接 | `127.0.0.1:5432` db=`metasheet_v2` user=`metasheet` | `127.0.0.1:5435` db=`metasheet` user=`metasheet` |
| `version()` | `PostgreSQL 15.17 (Homebrew)` | `PostgreSQL 15.18`（容器 `metasheet-dev-postgres`） |
| `inet_server_addr()` | `127.0.0.1/32` | 容器内网地址（loopback 映射端口 5435） |
| `to_regclass('public.tasks')` | NULL | NULL |
| `kysely_migration` 行数 | 329 | 284 |
| 最新 `kysely_migration.name` | `zzzz20260826130000_scope_elearning_exam_attempts_to_item` | `zzzz20260719230000_fwb_decision_values_cascade` |

磁盘 live 迁移（本 SHA）最晚文件：`zzzz20260916120000_create_dingtalk_todo_mirrors.ts`。主库迁移 head 停在 `zzzz20260826130000`，**未跑全迁移**。下面计数只代表该本地库当前状态，不能外推生产。

旁路 5435 更旧，不作主结论。`127.0.0.1:5433`（`AGENTS.md` bootstrap 端口）connection refused。

### 1.2 查询原文（主库）

```sql
-- 库身份
SELECT current_database(), current_user, inet_server_port(), split_part(version(), ' on ', 1);
SELECT to_regclass('public.kysely_migration'), to_regclass('public.user_orgs'),
       to_regclass('public.users'), to_regclass('public.tasks');
SELECT name, timestamp FROM kysely_migration ORDER BY timestamp DESC LIMIT 8;

-- 列
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='user_orgs' ORDER BY ordinal_position;

-- QUERY A 任意成员行
WITH per_user AS (
  SELECT u.id AS user_id, COUNT(uo.user_id) AS org_count
  FROM users u LEFT JOIN user_orgs uo ON uo.user_id = u.id
  GROUP BY u.id
)
SELECT COUNT(*) FILTER (WHERE org_count = 0) AS zero_member_users,
       COUNT(*) FILTER (WHERE org_count = 1) AS one_member_users,
       COUNT(*) FILTER (WHERE org_count >= 2) AS multi_member_users,
       COUNT(*) AS users_in_denominator
FROM per_user;

-- QUERY B 仅 is_active IS TRUE
WITH per_user AS (
  SELECT u.id AS user_id,
         COUNT(uo.user_id) FILTER (WHERE uo.is_active IS TRUE) AS org_count
  FROM users u LEFT JOIN user_orgs uo ON uo.user_id = u.id
  GROUP BY u.id
)
SELECT COUNT(*) FILTER (WHERE org_count = 0) AS zero_active_member_users,
       COUNT(*) FILTER (WHERE org_count = 1) AS one_active_member_users,
       COUNT(*) FILTER (WHERE org_count >= 2) AS multi_active_member_users,
       COUNT(*) AS users_in_denominator
FROM per_user;

SELECT COUNT(*) FILTER (WHERE is_active IS TRUE) AS active_rows,
       COUNT(*) FILTER (WHERE is_active IS FALSE) AS inactive_rows,
       COUNT(*) AS total_rows
FROM user_orgs;
```

### 1.3 计数（主库 `metasheet_v2@127.0.0.1:5432`）

| 口径 | 零成员用户 | 单成员用户 | 多成员用户 | 分母 `users` |
|---|---|---|---|---|
| 任意 `user_orgs` 行 | 67 | 47 | 1 | 115 |
| 仅 `is_active IS TRUE` | 68 | 47 | 0 | 115 |

`user_orgs` 行：active 281 / inactive 14 / 合计 295。列：`user_id text NOT NULL`, `org_id text NOT NULL`, `is_active boolean NOT NULL`, `created_at timestamptz NOT NULL`。

解读（不断言生产）：本地主库按活跃成员计，**多组织用户数为 0**；按任意行计有 1 个用户有 ≥2 行（含 inactive）。零活跃成员用户 68/115，对应计划 §2.4 人口 (c)，任务域不兜底。生产库计数 **UNCLEAR**（本普查按裁定不连）。

复现：`PGPASSWORD=… psql -h 127.0.0.1 -p 5432 -U metasheet -d metasheet_v2` + 上节 SQL。

---

## 2. `pg_advisory_xact_lock` 键前缀清单

范围：`packages/core-backend/src` + `plugins/`（排除 `node_modules` / `dist` / `__tests__`）。共用 `hashtext` 单键空间（计划 §5-5）。

### 2.1 生产源码前缀（函数或字面量；`*` = 运行时 id）

| 前缀 / 键形 | 生成点 |
|---|---|
| `meta:auto-number:sheet:*` | `canonical-sheet-fence.ts` `canonicalSheetFenceKey` |
| `meta:auto-number:*:*` | `auto-number-service.ts` `lockKey` |
| `approval-projection:*` | `approval-record-projection-service.ts` 字面量 |
| `record-link:row-auth:*:*` | `approval-record-link-row-auth-lock.ts` `RECORD_LINK_ROW_AUTH_LOCK_PREFIX` |
| `directory:source-sync-freeze:*` | `source-sync-freeze-lock.ts` |
| `directory:reparent:*` | `local-directory-org.ts` |
| `elearning-media-quota:*` | `elearning-media-quota.ts` |
| `elearning-exam:*` / `elearning-watch:*` / `elearning-publish:*` / `elearning-assign:*` / `elearning-revoke:*` / `elearning-scope:*` / `elearning-admin-scopes:*` / `elearning-object-acl:*` / `elearning-training-plan:*` / `elearning-training-plan-assignment:*` / `elearning-training-plan-revoke:*` / `elearning-content-course:*` / `elearning-content-revision:*` / `elearning-open:*` / `elearning-stats-daily:*` / `elearning-stats-multitable:*` / `elearning-plan-item-v1:*` | `elearning-*` 各 `*LockKey` |
| `multitable:ai-usage:*` | `ai-usage-ledger.ts` `aiUsageSubjectLockKey` |
| `multitable:link-target:*` | `univer-meta.ts` `linkTargetMaterializationLockKey` |
| `audit_logs_partition`（双 `hashtext`） | `AuditRepository.ts` |
| `attendance:*` / `attendance:otbank-cap:*:*` / attendance 双 hashtext 元组 | `plugins/plugin-attendance/index.cjs`、`src/attendance/w4c0-identity.ts` |
| `ledger-retention:ai-usage-ledger:leader` | `LedgerRetentionScheduler.ts`（leader 锁，非 xact） |

PIT 恢复另用 **int 命名空间** `PIT_RECOVERY_LOCK_NS = 0x77303104` + `hashtext(sheetId)` 双参数形式（`canonical-sheet-fence.ts`），与单 `hashtext(text)` 键空间不相交。

### 2.2 与拟用任务键的字面差

拟用（计划 §5-5，待 M1）：`task-structure:<orgId>` / `task-projection:<listId>:<taskId>` / `tasks-scheduler:leader`。

在上表中，**没有**以 `task-structure:`、`task-projection:`、`tasks-scheduler:` 开头的既有前缀。`attendance-scheduler:` 与 `ledger-retention-scheduler:leader` 字符串不同。这是字面差，不是 `hashtext` 碰撞证明（hash 碰撞始终可能；任务域不另开第二键空间）。

复现：

```bash
rg -n "pg_advisory_xact_lock" packages/core-backend/src plugins --glob '!**/node_modules/**' --glob '!**/dist/**'
```

正控：同一命令能命中 `approval-record-projection-service.ts` 的 `` `approval-projection:${instanceId}` ``。

---

## 3. 双语法建表扫描（`tasks*` 表名）

范围：`packages/core-backend/src/db/migrations` + `packages/core-backend/migrations`。

### 3.1 `createTable('…')` 表名含 `task`（大小写不敏感）

| 文件 | 行 | 表名 |
|---|---|---|
| `20250924140000_create_gantt_tables.ts` | 13 | `gantt_tasks` |
| `20250924140000_create_gantt_tables.ts` | 99 | `gantt_task_resources` |
| `zz20251231_create_bpmn_tables.ts` | 119 | `bpmn_user_tasks` |
| `zz20251231_create_bpmn_tables.ts` | 265 | `bpmn_external_tasks` |

### 3.2 `CREATE TABLE` 表名含 `task`

| 文件 | 行 | 表名 |
|---|---|---|
| `migrations/049_create_bpmn_workflow_tables.sql` | 93 | `bpmn_user_tasks` |
| `migrations/049_create_bpmn_workflow_tables.sql` | 310 | `bpmn_external_tasks` |

### 3.3 产品表名 `tasks` / `task_*`

在上述两语法扫描结果中，**没有**表名恰为 `tasks` 或以 `task_` 开头的建表。本地两库 `to_regclass('public.tasks')` 均为 NULL。

正控：`gantt_tasks` 与 `bpmn_user_tasks` 必须出现（审阅件 §四.1）；本扫描两者都在。避开这些名字即可。

复现：

```bash
rg -n "createTable\(\s*['\"][^'\"]*task" packages/core-backend/src/db/migrations
rg -n -i "CREATE TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(\"|')?[^\"']*task" \
  packages/core-backend/src/db/migrations packages/core-backend/migrations
```

---

## 4. `run-required-web-tests.sh` token 清单

计划锚点 `:1069` 在本 SHA **不是** `exec` 行。

| 项 | 本 SHA 实测 |
|---|---|
| 文件行数 | 1186 |
| `sed -n '1069p'` | 注释：`# the hide-empty toggle (isEmptyValue-shared predicate, …` |
| `exec npx vitest run` 行号 | **1186** |
| token 数（`exec` 与 `--reporter=dot` 之间） | **392** |
| 重复 token | 0 |
| 含 `task`（大小写不敏感）的 token | 0 |

复现：

```bash
sed -n '1069p' apps/web/scripts/run-required-web-tests.sh
rg -n "^exec npx vitest run" apps/web/scripts/run-required-web-tests.sh
python3 -c "
from pathlib import Path
line=[l for l in Path('apps/web/scripts/run-required-web-tests.sh').read_text().splitlines() if l.startswith('exec npx vitest run')][0]
parts=line.split('exec npx vitest run',1)[1].split()
toks=[]
for x in parts:
    if x.startswith('--'): break
    toks.append(x)
print(len(toks), sum(1 for t in toks if 'task' in t.lower()))
"
```

正控：`StockPreparationProjectBoard` 为第一个 token；`multitable-external-context-sync` 为最后一个。脚本 `:28-37` 成文说明 CamelCase 备料 token 不得成为 `apps/web/verification/stock-prep-*.spec.ts` 的子串（Playwright 用例；**命中即红**）。未来任务 spec token 尚未加入——本切片 docs-only，不改该行。碰撞判据正文在锁 §5.3。

---

## 5. 计划锚点 `sed -n` 复核（对本 SHA）

解析规则（可复现，不依赖 `/tmp`）：从计划 v5 反引号内取出 `path-or-basename.ext:line`；`line` 可为 `n`、`n-m`、逗号并列；另将 `file.ext:96/111` 拆成两条。解析到 worktree 文件后，行号超出文件行数 ⇒ OOB。裸名 `index.ts` 按最短相对路径优先，会命中 `apps/web/src/multitable/index.ts`（69 行）而非 `packages/core-backend/src/index.ts`。

复现命令与 2026-09-17 在本 SHA 上的实际输出见下。§5.1 / §5.2 两张表是逐条 `sed -n`，不依赖这三个计数。

```bash
python3 - <<'PY'
import re, pathlib, json
plan = pathlib.Path.home()/'.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/task-feature-development-plan-20260915.md'
wt = pathlib.Path('.')  # 在 worktree 根执行
text = plan.read_text()
pat = re.compile(r'`([^`]*?([A-Za-z0-9_./-]+\.(?:ts|js|cjs|mjs|yml|yaml|md|vue|sh|json))):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`')
pat2 = re.compile(r'`([^`]*?([A-Za-z0-9_./-]+\.(?:ts|js|cjs|mjs|yml|yaml|md|vue|sh|json))):(\d+(?:/\d+)+)`')
anchors=[]
for m in pat.finditer(text):
    full=m.group(1).strip(); fname=m.group(2); spec=m.group(3)
    pathish=fname if (' ' in full or '\n' in full) else full
    anchors.append((pathish, spec))
for m in pat2.finditer(text):
    full=m.group(1).strip(); fname=m.group(2)
    pathish=fname if ' ' in full else full
    for sp in m.group(3).split('/'):
        anchors.append((pathish, sp))
uniq=[]; seen=set()
for a in anchors:
    if a in seen: continue
    seen.add(a); uniq.append(a)
idx={}
for p in wt.rglob('*'):
    if not p.is_file(): continue
    if any(x in p.parts for x in ('node_modules','dist','.git','references','artifacts','coverage')): continue
    idx.setdefault(p.name, []).append(p)
def resolve(pathish):
    p=wt/pathish
    if p.is_file(): return [p]
    hits=idx.get(pathlib.Path(pathish).name, [])
    scored=[]
    for h in hits:
        rel=str(h.relative_to(wt)); suf=pathish.lstrip('./')
        score=(2 if rel.endswith(suf) or rel.endswith(pathlib.Path(pathish).name) else 0) + (1 if 'src/' in rel else 0) - (1 if '/tests/' in rel else 0)
        scored.append((score, len(rel), h))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [h for _,__,h in scored[:5]]
ok=oob=miss=0
oob_files=[]
for pathish, spec in uniq:
    paths=resolve(pathish)
    if not paths:
        miss += 1; continue
    n=len(paths[0].read_text(errors='replace').splitlines())
    bad=False
    for part in spec.split(','):
        a,b = map(int, part.split('-',1)) if '-' in part else (int(part), int(part))
        if a<1 or b>n or a>b:
            bad=True
    if bad:
        oob += 1; oob_files.append((pathish, spec, str(paths[0].relative_to(wt)), n))
    else:
        ok += 1
print('unique', len(uniq), 'OK', ok, 'OOB', oob, 'MISSING', miss)
for row in oob_files:
    print('OOB', row)
PY
```

本 SHA 实测输出：

```
unique 133 OK 128 OOB 5 MISSING 0
OOB ('index.ts', '1763-1766', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '1642', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '1763-1777', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '3836-3850', 'apps/web/src/multitable/index.ts', 69)
OOB ('index.ts', '3766', 'apps/web/src/multitable/index.ts', 69)
```

### 5.1 计划 §8 逐条（新 SHA 必核）

| 计划锚点 | 本 SHA | 摘录 |
|---|---|---|
| `vitest.config.ts:31-33` | 仍 `exclude` 起头 + 两条历史 glob | `'**/node_modules/**'` `:32`、`'**/dist/**'` `:33` |
| `vitest.config.ts:1782` **漂移** | 现为 `'tests/integration/elearning-media-quota.db.test.ts'` | 历史 glob `'tests/e2e/**'` 现位于 **`:1797`**（文件 1829 行） |
| `approval-realdb-comments.yml:30` | SUPERSEDED 注释仍在 | suite 同时在 required `test (20.x)` |
| `:41-43` / `:45-47` | 仍声明无 `merge_group`、无 `branches:` | 与计划一致 |
| `:99` | `EXPECT_DB: '1'` | 一致 |
| `:129` | `MIGRATION_EXCLUDE:` 列表 | 一致 |
| `:133-136` | verbose / 整文件 | 一致 |
| `approval-sequential-mode.db.test.ts:14` | EXPECT_DB sentinel | 一致 |
| `plugin-tests.yml:5` | `merge_group:` | 一致 |
| `plugin-tests.yml:1655` | `tests/integration/approval-comments.db.test.ts \` | 仍在 required run-list |
| s6a `sealed-export-package-provenance.cjs:298-300` | 仍钉 `plugin-tests.yml` | 一致 |
| s6a pin json `:90` | `"pluginTestsWorkflow": "5902a850c3d254c20b0caf330b21da896703648265ae7a588b973f793727a0cf"` | **本切片禁止改 `plugin-tests.yml`** |
| `web-tests.yml:8-9,17-22,26-27,77` | paths 脚注 / POST-append / `merge_group` / `run-required-web-tests.sh` | 一致；文件共 77 行 |
| `approval-ci-coverage-enumeration.test.ts:299-339,:409,:577,:679-685` | `classifyT3` / lane 正则 / 文件发现 / 扫描负控 | 一致；`task-*` 仍被忽略 |
| `AGENTS.md:48-50` **漂移** | 现为章程「当前唯一优先级」备料段 | 两点接线正文 **不在** 本 SHA 的 `AGENTS.md`（74 行）。计划自述「基线版 AGENTS.md 无此段」。纪律仍按计划 §8-2 + 工作区未提交的 canonical `AGENTS.md` 执行，不把本 SHA `:48-50` 当两点接线证据 |
| `multitable-web-guard.yml:16-18` | `on: pull_request: paths:` | 一致 |
| `elearning-web-guard.yml:19-21` | 同上 | 一致 |
| `attendance-web-guard.yml:2-3` | 无 paths 以便日后变必需 | 计划明确不抄此形状 |
| `run-required-web-tests.sh:1069` **漂移** | 注释行 | `exec` 在 **`:1186`** |
| `:28-37` | 子串过滤 + `verification/` 碰撞说明 | 一致 |
| `MIGRATION_EXCLUDE_TRACKING.md:5-7` | exclude count **7** files | 计划写「6/7 项历史闭集」——本 SHA 文案是 7 |
| `docker-build.yml:4-8` | `paths-ignore: docs/**` | 纯 docs PR-0 **不会**跑 build |
| `:96` / `:111` / `:120-122` / `:484-488` | publish 门 / deploy 门 / MIGRATE START/END | 一致 |
| `docker-publish-preflight.mjs:19` | `eventName !== 'workflow_dispatch' ⇒ publish: false` | 一致 |

### 5.2 其他承重锚点（抽查，本 SHA 仍成立）

| 锚点 | 本 SHA |
|---|---|
| `jwt-middleware.ts:101-104` | `authenticatedTenantId` 仅 JWT `user.tenantId` |
| `jwt-middleware.ts:106-109` | header 只回填 `user.tenantId` |
| `AuthService.ts:290-294` | 无 claim 不回落单成员 |
| `AuthService.ts:387-426` | `resolveSessionTenantId` 对 `user_orgs` + `users.is_active` |
| `routes/auth.ts:1220-1251` | `POST /session-org`；非成员 403 |
| `namespace-admission.ts:11-38` | `NON_NAMESPACED_PERMISSION_RESOURCES`；**无 `tasks`** |
| `namespace-admission.ts:344-347` | admin 短路；非豁免需 controlledNamespaces；`admissionsTableUnavailable ⇒ true`（`:346`，绑 `RBAC_OPTIONAL`） |
| `rbac.ts:69` / `:110-111` | admin 短路；守卫自身抛错 500 |
| `index.ts` 审批挂载 | 计划 `:1763-1777` **漂移**（现为 `/health`）。实际 `this.app.use(approvalsRouter(` 在 **`:1785-1788`** |
| `guardPolicy.ts:29` / `:77` / `:87-95` | 焦点白名单仍无 `/tasks`；`KNOWN_REQUIRED_FEATURES` 无 `tasks`；`/stock-prep` 不加 `requiredFeature` 先例仍在 |
| `App.vue:7-74` | 三互斥分支仍在；默认分支 `:30-74` |
| `permission-service.ts:1033-1037` | 计划指 rethrow 契约；本 SHA 该行是注释，函数 `loadApprovalProjectionDeniedRecordIds` 从 `:1040` 起，throw 在 `:1305`/`:1378` |
| `elearning/feature-flags.ts:32` | `env[name] === 'true'` |

---

## 6. §13-N 交叉引用对账（计划 v5 正文）

计划 §13 用 L0/L1/L2 列出 1–39 题（L1 的 13–25 与 37–39、L2 的 26–36 写在同一段落，不是每题独立 `N. **` 标题）。

| 检查 | 结果 |
|---|---|
| §13 题号 1–39 是否都在锁必答清单里 | 是（计划 v5 第 270–288 行；不得删题） |
| 正文其他节用 `§13-N` 引用的题号 | 1, 1d, 1e, 2, 8, 9, 10, 10b, 11, 12, 22, 23, 27, 35, 36, 37, 38（17 个 distinct，30 次） |
| §13 有题但正文从未写 `§13-N` | 3–7, 13–21, 24–26, 28–34, 39 —— **不是删题**，是引用稀疏；锁草案仍逐题给建议答案 |
| 引用了 §13 但不在 1–39 | 无 |

复现：`python3` 对计划全文 `re.findall(r'§13-(\d+[a-z]?)', text)`。

---

## 7. 迁移时间戳（给未来 DDL 用，本切片不写迁移）

磁盘最晚：`zzzz20260916120000_create_dingtalk_todo_mirrors.ts`。计划要求新迁移 `zzzz<晚于 zzzz20260910101500>_<snake>.ts`；本 SHA 已有 09-15 / 09-16 文件，未来任务迁移须 **晚于 `zzzz20260916120000`**。

---

## 8. 本普查未做

- 未连 staging/生产，故生产 `user_orgs` 分布 UNCLEAR。
- 未跑真库测试、未起浏览器、未起 API 服务器。
- 未跑 `hashtext` 数值碰撞（只做字面前缀差）。
- 未把 392 个 token 全文贴进本文件（命令可复现）。
