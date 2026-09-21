# 待办中心 B-3 打磨（H-4）— 验证 MD

**状态: PROPOSED.** 数字与结论均本轮（Sonnet 实现代理 D2）实测；尚未经 Opus 门审，门审前一律
按候选对待。设计依据见同目录 `todo-center-phase3-polish-design-20260922.md`。

## 0. 测试台

| 项 | 值 |
|---|---|
| 工作树 | `/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-h4-todo-b3`（`git worktree add`；根 / `apps/web` / `packages/core-backend` / `plugins/*` 的 `node_modules` 均从 canonical `metasheet2/` 软链） |
| 分支 / head（本轮提交前基线） | `feat/todo-center-phase3-polish`，自 `origin/feat/todo-center-phase2-fe @ 0a6531b80e6cb362067742ee4b94477842a75965` 新建 |
| 库 | `metasheet2_h4_20260922`（本次新建，owner `ms2testbed`，非超级角色；`postgres` 仅用于 `createdb ... -O ms2testbed`） |
| 迁移 | `DATABASE_URL=postgresql://ms2testbed:ms2testbed@localhost:5432/metasheet2_h4_20260922 npx tsx src/db/migrate.ts latest` → **EXIT=0**，`grep -c "was executed successfully"` = **414**，`grep -iE "permission denied|42501|must be owner|must be superuser"` **零命中** |
| 后端 | `http://127.0.0.1:7784`，`npx tsx src/index.ts`，`NODE_ENV=development`，`RBAC_CACHE_TTL_MS=0` |
| 前端 | `http://localhost:8904`，`npx vite --port 8904 --strictPort`，`VITE_API_URL=http://127.0.0.1:7784`（沿用既有报告发现 F-4 的教训：默认同源代理下 `/socket.io` 到不了后端，但本轮三腿不依赖实时推送，未受影响） |
| 浏览器 | 本脚本自起的 headless chromium（`playwright@1.57.0`，从 pnpm store 绝对路径 import）。**未使用 MCP 共享浏览器。** |
| 驱动脚本 | `soak-working/h4-todo-acceptance-20260922/flow.mjs`（脚本自身在连接 DB 后先断言 `current_database()`/`current_user` 等于预期值，不等于则 throw 拒绝继续） |
| 证据目录 | `soak-working/h4-todo-acceptance-20260922/`（3 张截图、`net-todo-requests.json`、`results-h4.json`） |
| 账号（全部由 `POST /api/auth/register` 建，HTTP 201；登录一律走 `POST /api/auth/login`） | `h4admin@testbed.local`（`1e732382-f156-4a13-8cfd-0cf0e5a025ce`，发起人）、`h4b@testbed.local`（`45960187-e2f0-4c4e-9713-ff7e6ad98dbc`，常规 `user` 座位审批人）、`h4d@testbed.local`（`a03adb8d-828c-4d7e-b6a5-886074468310`，本轮主角：一条 `user` 座位 + 一条 `source_queue` 座位） |

### 0.1 非产品路径的 DB 写（如实标注，共 4 类，均可逆/一次性，理由逐条给出）

1. `INSERT INTO user_roles (user_id,'admin')` × 3 人 —— 处女库上 `approvals:read` 不在权限目录（沿用
   `todo-center-real-browser-acceptance-20260920.md` 发现 F-1 的既有结论，本轮实测复现：新注册用户
   默认权限里没有 `approvals:read`），任何产品路径都无法把它授给非管理员，只有 `isAdmin()` 判据能绕过
   `rbacGuard`。
2. `INSERT INTO user_orgs (user_id,'default',is_active=TRUE)` × 2 人（admin、b）—— `POST
   /api/auth/register` 不建组织成员关系，而 `POST /api/approvals` 的 org 派生要求恰好一条活动成员
   关系。
3. `INSERT INTO user_roles (h4d, 'attendance_approver')` + `INSERT INTO
   user_namespace_admissions (h4d, 'attendance', enabled=TRUE)` —— 构造锁 §3.0/§7-2″ 定义的
   `source_queue` 席位人口（`attendance:approve` 权限来自迁移已 seed 的 `attendance_approver` 角色
   的 `role_permissions`，非凭空捏造）。
4. `INSERT INTO approval_assignments (...,'source_queue','attendance:approve',...)` × 1 行 ——
   **这是本轮唯一"代码看不到产品路径"的写入**：全仓 `grep -n "assignment_type" packages/core-backend/
   src/services/ApprovalProductService.ts` 只见插入 `'user'`/`'role'` 两种类型的语句（`:11624`/
   `:11640` 一带），生产代码从未写过 `source_queue` 行；这正是锁 §1.5/§7-2″ 自陈的产品现状："今天 ①
   计入而核心门拒绝"——锁自己的 A0 验收表（class ⑥）在后端真库测试里就是用同一手法（直接 SQL）构造
   这一类，本轮把同一构造法搬到真机层面。插入的 `node_key` 复用该实例真实的 `current_node_key`
   （`node1`），未发明新节点。

**未触碰**任何共享/staging/prod 库（`metasheet_test`/`metasheet_v2`/`metasheet_testbed_*` 均未连接，
`echo $DATABASE_URL` 在整个脚本生命周期内恒为 `metasheet2_h4_20260922`）。

### 0.2 产品路径造出的真实待办

`POST /api/approval-templates`（201）→ `POST /api/approval-templates/:id/publish`（200）→
`POST /api/approvals`（201），共两套模板/实例：

| 实例 | 模板结构 | 座位 | 用途 |
|---|---|---|---|
| `b71c437f-2294-4053-9bda-bd2afbe812d1` | `start → node1(user=[h4b]) → node2(user=[h4b]) → end` | `node1`: `user`=h4b（真实，产品路径）+ `source_queue`='attendance:approve'（第 4 类直接写） | h4b 视角 `actionable=true`；h4d 视角（经 `source_queue` 臂）`actionable=false` |
| `0a0b7fd8-8b03-450f-8da2-635c1ae7602a` | `start → node1(user=[h4d]) → end` | `node1`: `user`=h4d（真实，产品路径） | h4d 视角 `actionable=true`（正控） |

（实测：两节点模板刚提交时 `approval_assignments` 只有 `node1` 一行——`node2` 的座位在产品代码里是
**惰性**创建的，只在推进到该节点时才写。这确认了设计 MD §2.2 的判断：靠"活跃但非当前节点座位"这条路
在产品路径下构造不出真机反例，`source_queue` 是唯一可行的构造法。）

## 1. 单元/组件测试

| 文件 | 结果 | 说明 |
|---|---|---|
| `apps/web/tests/TodoCenterView.spec.ts` | **14/14 PASS**（原 9 条 + 本轮新增 5 条） | 见 §1.1 明细 |
| `apps/web/tests/attendance-web-guard-workflow.spec.ts` | **27/27 PASS** | prompt 点名的必绿项 |
| `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` | **18/18 PASS** | prompt 点名的必绿项；见 §2 |

### 1.1 本轮新增的 5 条用例（file:line 见下）及其 mutation 结果

| 用例 | file:line | Mutation | Mutation 结果 |
|---|---|---|---|
| "renders updatedAt for every item, and dueAt only when the source supplies one" | `TodoCenterView.spec.ts:189` | 把两处 `v-if="item.dueAt"` 删成恒渲染（`TodoCenterView.vue:56`/`:77`） | **RED**（`expected <span> to be null`）——证明"只在有 `dueAt` 时渲染"这条断言承重 |
| "renders updatedAt/dueAt in English…passes an unparseable value through unchanged" | `TodoCenterView.spec.ts:211` | （未破坏性测；正控本身覆盖 `Number.isNaN` 分支，判据本身简单到不需要额外破坏） | 见 §1.2 的独立正控说明 |
| "unavailable copy is productized…locale-aware" | `TodoCenterView.spec.ts:147` | 把两处新文案改回旧文案（`该来源暂时无法查询`/`This source could not be checked right now`，`TodoCenterView.vue:31`） | **RED**（`expected '该来源暂时无法查询' to be '暂时无法查看，请稍后重试'`）——证明断言真的钉住了新字符串，不是空转 |
| （既有）"renders a view-only pill for actionable:false…" | `TodoCenterView.spec.ts:228`（原有，未改） | 未改动——本轮零改动 pill 相关代码 | 不重复验证（B-2 已交付） |

（复现步骤：`cp` 备份 → `sed`/Python 原地替换 → 跑单文件 → `cmp` 确认 `cp` 复原字节相同 → 复跑确认
仍 14/14——过程记录见本会话终端历史，未落盘为脚本，因为只是两次一次性验证，不是复用夹具。）

### 1.2 `formatItemTimestamp` 的 Invalid-Date 正控

`TodoCenterView.spec.ts:211` 用 `updatedAt: 'not-a-date'` 断言渲染文本**包含原始字符串
`not-a-date`、不包含 `Invalid Date`**——直接对着 `formatItemTimestamp`（`TodoCenterView.vue:237-240`）
的 `Number.isNaN(parsed.getTime()) ? value : ...` 分支取正控，镜像 `approvals/detailField.ts` 里
`formatDisplayDate` 的同一条防线（该函数docblock 自陈的动机："不像那个 helper，把不能解析成日期的值
原样传回，而不是把 JS 内部的 `Invalid Date` 字符串暴露给读者"）。

## 2. run-required-web-tests.sh 结构

- `bash -n apps/web/scripts/run-required-web-tests.sh` → **exit 0**
- 清理前：2056 行，`--reporter=dot` 出现 3 处（1 处在小段独立命令里，2 处属于本次发现的
  死代码重复；`grep -c "^exec npx vitest run"` = 1）
- 清理后：**1669 行**，`grep -n "^exec npx vitest run"` 只有 1258 行一处；`diff` 逐令牌核对
  （删除段 sort 后与保留段的差集 = 恰好 `todoApi`/`TodoCenterView`/`todoCountsRealtime` 三项，
  无其它遗漏或多出）
- **Mutation（证明该守卫真的会抓第二条 exec）**：手工在文件末尾追加一段真正带 `exec` 前缀的第二调用
  （`exec npx vitest run \  amountAutoSum \  --reporter=dot`），`required-web-lane-registration-
  shape.test.ts` 立即 **10/18 FAIL**（`expected exactly 1 exec logical line, found 3`）——证明"恰一
  逻辑块"这条断言不是摆设；随后 `cmp` 复原，18/18 恢复绿。**同时确认**：本轮删除的死代码块之所以逃过
  该守卫，正是因为它缺少 `exec` 前缀（只是普通续行文本，从未被任何 shell 执行到）——该守卫抓的是
  "第二条会执行的 exec"，不是"任意重复文本"，所以死代码块的移除是本轮"恰一逻辑块"这句话的**充分而
  非必要**推论：即使不删，18 条既有检查也不会变红；删除的价值是把文件恢复到与 `origin/main` 字节对齐
  的单块形状，消除未来合并时的困惑源。
- **两点纪律核对**：本轮零新增 spec 文件，`TodoCenterView`/`todoApi`/`todoCountsRealtime` 三令牌
  在 `apps/web/scripts/run-required-web-tests.sh`（清理后仍在）与
  `.github/workflows/approval-web-guard.yml`（`:377-380`/`:770-773` 的 path-filter，`:1013` 的
  inline vitest token 列表）两处均已存在，未做改动，也不需要改动。

## 3. 类型检查 / 构建

| 命令 | 结果 |
|---|---|
| `npx vue-tsc -b --force`（`apps/web`） | **1 条 TS2769**，锚点 `vite.config.ts(28,29)`（vite 插件类型跨版本不兼容，与本切片改动的文件无关）。**已核对为先存**：`merge-train-dry-run-v2-20260921.md` §"对照" 记录同一 head 家族在 pristine `origin/main` 上跑 `pnpm --filter @metasheet/web type-check` 同样 EXIT=2、同一条 TS2769、前 39 行逐字节相同。本轮日志（`grep -c "error TS"` = 1；`grep TodoCenterView` 零命中）确认零新增错误，且错误与 `TodoCenterView.vue` 无关联。 |
| `npx vite build`（`apps/web`） | **EXIT=0**，`✓ built in 14.67s` |

## 4. 真实浏览器验收（三腿）

| 腿 | 判据 | 结果 | 证据 |
|---|---|---|---|
| ① updatedAt 呈现 | 两条条目都渲染 `Updated <本地化时间戳>` | **PASS** | 截图 `h4-01-mixed-actionable-and-updatedat.png`；DOM 文本 `Updated 9/21/2026, 11:46:32 PM` / `Updated 9/21/2026, 11:43:21 PM` |
| ① dueAt 呈现（代码路径） | 无数据时不渲染该 `data-testid` | **PASS（但见下方 NOT RUN）** | `results-h4.json`：两行 `dueAtPresent: false` |
| ② C′ pill——正控 | **同一用户、同一列表**里两行分别为 `actionable:true`（无 pill）与 `actionable:false`（有 pill），仅这一个字段不同 | **PASS** | 截图同上：第一行无 "View only"，第二行有；`net-todo-requests.json` 逐字确认后端返回体里两条 `actionable` 值分别为 `true`/`false` |
| ③ 来源不可用文案 | 真实（可逆）撤权触发 `unavailable`，文案 = `Can't be shown right now — please try again shortly.`，不含 "source"/"来源" | **PASS** | 截图 `h4-02-source-unavailable-copy.png`；`results-h4.json` 的 `leg3.containsInternalTerm: false` |
| ③ 恢复 | `GRANT` 后重新拉取，2 条恢复、0 处于 unavailable | **PASS** | 截图 `h4-03-recovered-after-grant.png`；`results-h4.json` 的 `leg3recovery: {recoveredCount:2, stillUnavailable:0}` |

触发③的机制（真实、可逆、只作用于本次一次性库）：
```sql
REVOKE SELECT ON TABLE approval_assignments FROM ms2testbed;   -- 断
GRANT  SELECT ON TABLE approval_assignments TO   ms2testbed;   -- 恢复
```
选它的理由与既有报告一致：该表是共享待处理查询（`approval-pending-query.ts`）count 与 list 两条语句
都要读的表，能同时让徽标与中心页进入不可用；权限漂移是真实运维事故的形状，不是改 schema、不是打桩。

## 5. NOT RUN 清单（如实记录，不掩饰）

1. **`dueAt` 字段在真实浏览器里的"有值渲染"半边 NOT RUN**——今天唯一注册的审批源
   (`approval-pending-source.ts:78-85`) 不产出 `dueAt`（审批实例没有"截止时间"这个概念），本轮没有
   改后端去人为造一个假 `dueAt` 值（那会是伪造数据，违反"不编造值"纪律）。该半边的**代码路径**已经由
   单元测试 `TodoCenterView.spec.ts:187`（"…dueAt only when the source supplies one" 用例的
   `with-due` 分支）+ mutation 覆盖并证明为 load-bearing（见 §1.1），但**真实浏览器**层面没有一个
   真实业务对象能触发它——如实记录为"产品数据缺口"，交未来某个真正产出 `dueAt` 的来源接入时补上真机
   证据，不作为本切片验收阻塞项。
2. **实时推送半边（`todo:counts-updated`）未在真机验收**——沿用既有报告发现 F-4 的教训（默认同源
   代理下 `/socket.io` 到不了后端），本轮三腿的判据都不依赖实时推送（用页面 `reload()` 观察结果），
   所以未特意搭 `VITE_API_URL` 之外的 socket 直连；生产拓扑（`docker/nginx.conf` 的
   `location /socket.io/` 转发）不受影响，与 F-4 结论一致，不重复验证。
3. **`user_roles ⋈ role_permissions` 之外、`admin` 升格对 `source_queue` 场景的交互** 未单独验证——
   h4d 同时持 `admin` 与 `attendance_approver` 两个 `user_roles` 行，本报告只验证了"D 能看到 pending
   经 source_queue 臂 + actionable=false"这一条最终观察，未逐一分解"如果去掉 admin 会怎样"（那是锁
   §1.5 A0 表 class ⑥ 已经用后端真库测试覆盖的组合，不是本切片要重新证明的范围）。

## 6. 未做的事（如实记录）

- 未合并、未 undraft 任何 PR；未动 `origin/main`。
- 未对 `metasheet_test`/`metasheet_v2`/`metasheet_testbed_*` 做任何读写。
- 未改锁文正文（`todo-center-design-lock-draft-20260915.md` 全程只读）。
- 未 `git checkout -- .`/`reset --hard`/`stash drop`；本轮两次 mutation 还原均用 `cp` 备份 +
  `cmp` 核对字节相同。
- 未删除任何不是本轮创建的 worktree/库/文件/进程。
