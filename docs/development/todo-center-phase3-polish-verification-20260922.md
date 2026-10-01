# 待办中心 B-3 打磨（H-4）— 验证 MD

**状态: PROPOSED.** §0-§6 数字为 D2 原始实测；§7 起为修复轮 2（D1 rebase + D2 record fix，
2026-09-22，工作树 `wt-h4-d1d2-20260922`）按门审 `impl-gate-B3-todo-polish-round1-20260922.md`
逐条重跑/改正，命令与输出均本会话现跑贴出，不手写。尚未经门审复核，复核前一律按候选对待。
设计依据见同目录 `todo-center-phase3-polish-design-20260922.md`。

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
| `apps/web/tests/TodoCenterView.spec.ts` | **15/15 PASS**（新 B-2 基线 **11** 条 + 本切片新增 **4** 条——`git show 16703f8cf…:apps/web/tests/TodoCenterView.spec.ts \| grep -cE "^\s*it\("` = 11；`grep -cE "^\s*it\(" apps/web/tests/TodoCenterView.spec.ts` = 15，修复轮 2 复算） | 见 §1.1 明细 |
| `apps/web/tests/attendance-web-guard-workflow.spec.ts` | **27/27 PASS** | prompt 点名的必绿项；修复轮 2 重跑仍 27/27 |
| `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` | **18/18 PASS** | prompt 点名的必绿项；见 §2——**但该文件不在任何 CI workflow 里**，18/18 是本地信号，非 CI 闸（门审 P3-2） |

### 1.1 本切片新增的 4 条用例（file:line 见下）及其 mutation 结果

| 用例 | file:line | Mutation | Mutation 结果 |
|---|---|---|---|
| "renders updatedAt for every item, and dueAt only when the source supplies one" | `TodoCenterView.spec.ts:189` | 见下方**隔离网格**（修复轮 2 改正——原表把两处 `v-if="item.dueAt"` 合并一起改，是混淆型 mutation，见 §1.1.1） | 承重（router-link 支），惰性行支零判别力，已处理 |
| "renders updatedAt/dueAt in English…passes an unparseable value through unchanged" | `TodoCenterView.spec.ts:211` | 门审 round 1 M8：把 `Number.isNaN(parsed.getTime()) ? value : …` 换成无条件 `parsed.toLocaleString(locale)` | **RED**（`1 failed / 14 passed`）——该断言确实承重（门审 NIT-2：D2 原判断"不需要破坏"缺证据，现补上门审的红证） |
| "unavailable copy is productized…locale-aware" | `TodoCenterView.spec.ts:147` | 把两处新文案改回旧文案（`该来源暂时无法查询`/`This source could not be checked right now`，`TodoCenterView.vue:31`） | **RED**（`expected '该来源暂时无法查询' to be '暂时无法查看，请稍后重试'`）——证明断言真的钉住了新字符串，不是空转 |
| （既有，未改）"renders a view-only pill for actionable:false…" | `TodoCenterView.spec.ts:247`（修复轮 2 改正——原表写 `:228`，那一行实际是注释，`sed -n '228p;247p'` 现跑核对） | 未改动——本轮零改动 pill 相关代码 | 不重复验证（B-2 已交付） |
| "renders nothing (not 'Updated undefined') if a future source sends a missing updatedAt" | `TodoCenterView.spec.ts:232` | 删掉 `formatItemTimestamp` 里 `if (value === undefined \|\| value === null) return ''` 那一行防御 | **RED**（`expected '' to be '更新于 undefined'`）——证明该防御分支承重，不是摆设 |

#### 1.1.1 惰性行 `dueAt` mutation 是混淆型——隔离 2×2 网格重做（门审 P2-1）

原表把"删 `:56`"与"删 `:77`"合并成一条 mutation 读一次红，红是 `:77` 一个人挣来的，`:56`
（惰性行分支）搭了顺风车——`feedback_confounded_mutation_needs_isolated_variant_grid.md`
点名的复发型。修复轮 2 重做为逐一隔离（每次只改一处，`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp` 核字节，
工作树 `wt-h4-d1d2-20260922`，已 rebase 到新 B-2 之上的最终树）：

| # | 变异 | 预期 | 实测 | 判定 |
|---|---|---|---|---|
| M1 | 只删 `:77`（router-link 支）的 ` v-if="item.dueAt"` | RED | **1 failed / 14 passed** | 承重 ✓ |
| M2 | 只删 `:56`（惰性行支）的 ` v-if="item.dueAt"` | RED（原表的预期） | **15 passed** | **零判别力** |
| M5 | 删惰性行支整个 meta 块（`:54-57` 四行） | RED（原表的预期） | **15 passed** | **零判别力** |

三次 mutation 均单独还原、`cmp` 核字节相同，收尾 `git status --porcelain`/`git diff` 均为空
（还原到 M2/M5 之前的状态）。**结论**：`:56`/`:54-57` 是不可达分支（今天唯一注册的来源
`approval-pending-source.ts` 恒产出站内相对 href，`isSameOriginRelativeHref` 恒真，惰性行永不触发）
上的新增代码，且零覆盖。二选一（门审给的修法）：删掉它（选择，只删，见设计 MD §2.1）或补一条能
到达它的用例。选删除的理由：惰性行本来就是"链接失效时的降级展示"，只显示标题即可，为一个今天
不可达、将来即使可达也不影响核心判据的展示项维护一条测试，成本大于收益。

删除后在最终树上重跑 M1（`:77` 现移到 `:73`，因为惰性行支的四行已经不在文件里）：

| # | 变异 | 预期 | 实测 | 判定 |
|---|---|---|---|---|
| M1-final | 删最终树 `:73` 的 ` v-if="item.dueAt"`（router-link 支，惰性行支的重复块已删，`:56`/M2/M5 不再存在——N/A） | RED | **1 failed / 14 passed** | 承重 ✓，删除后守卫仍在 |

（复现步骤：`cp` 备份 → `sed -i '' 'N s/v-if="item.dueAt" //'` 原地替换 → `npx vitest run
TodoCenterView --reporter=dot` → `cp` 复原 → `cmp` 核对字节相同 → 复跑确认仍 15/15；全部命令与
输出见本会话终端历史。）

### 1.2 `formatItemTimestamp` 的 Invalid-Date 正控

`TodoCenterView.spec.ts:211` 用 `updatedAt: 'not-a-date'` 断言渲染文本**包含原始字符串
`not-a-date`、不包含 `Invalid Date`**——直接对着 `formatItemTimestamp`（`TodoCenterView.vue:237-240`）
的 `Number.isNaN(parsed.getTime()) ? value : ...` 分支取正控，镜像 `approvals/detailField.ts` 里
`formatDisplayDate` 的同一条防线（该函数docblock 自陈的动机："不像那个 helper，把不能解析成日期的值
原样传回，而不是把 JS 内部的 `Invalid Date` 字符串暴露给读者"）。

## 2. run-required-web-tests.sh 结构

**修复轮 2 更正**：D2 原稿把这份脚本的死代码清理记成"本切片的清理前/清理后"，两处引用的 exec 行号
都写成 `1258`，是转录错——D2 自己 rebase 前的树上，"清理前"（含死代码块）实际 exec 行在 `1257`，
"清理后"（D2 自己删完块、又加一段说明注释）实际在 `1268`。这两个数字连同"清理前/后"这个框架本身
现已随 rebase 一并作废：更关键的是，2026-09-22 B-2 自己的一个独立修复轮
（`16703f8cfd7a11ac90da8568bc4a1a7846d6dd05`）**用逐字节相同的删除**做了同一处清理——

```
$ git diff 0a6531b80… 16703f8cfd7a11ac90da8568bc4a1a7846d6dd05 -- apps/web/scripts/run-required-web-tests.sh | grep '^-' | grep -v '^---' | md5
dede25980e7b585a7dc105d95080eb05
$ git diff 0a6531b80… ae7e065ece0c3a01b36898a07c37af28211e833a -- apps/web/scripts/run-required-web-tests.sh | grep '^-' | grep -v '^---' | md5
dede25980e7b585a7dc105d95080eb05
```

本分支 `git rebase --onto 16703f8cf… 0a6531b80… HEAD` 到这个新 head 之上，两侧删除幂等——**本 PR 现在
对该文件的 diff 是零字节**：

```
$ git diff 16703f8cfd7a11ac90da8568bc4a1a7846d6dd05 -- apps/web/scripts/run-required-web-tests.sh
（空输出）
```

以下是修复轮 2 在最终树（rebase 后）上现跑的结构断言，不再区分"清理前/后"（该框架不再适用——本 PR
自己对这份文件零改动，下列全部是对继承自新 B-2 的文件状态做校验）：

- `bash -n apps/web/scripts/run-required-web-tests.sh` → **exit 0**
- `grep -n '^exec npx vitest run' …` → 恰一处，**`:1257`**
- `wc -l …` → **1658 行**（与新 B-2 相同）
- `grep -c '^exec ' …` → **1**
- token 集合两方向对账（`node scripts/ops/required-web-lane-token-set-diff.mjs`）：
  - vs `origin/feat/todo-center-phase2-fe`（新 B-2）：`400 tokens, 400 distinct` 两侧，**SET IDENTICAL**
  - vs 旧 H-4 head `7601a7eebc8c7ebfad76506be8d9c8f4e6dc9008`：同上，**SET IDENTICAL**
  - 即本切片对 exec 令牌集合**零新增、零丢失**，`TodoCenterView`/`todoApi`/`todoCountsRealtime`
    三个 todo 令牌本就来自新 B-2（#5857 引入），本切片验证的是它们今天仍被收集，不是本切片新增
- **Mutation（证明该守卫真的会抓第二条 exec，本轮现跑，改正 `found 3` 的转录错）**：手工在文件末尾
  追加一段真正带 `exec` 前缀的第二调用（`exec npx vitest run \  amountAutoSum \  --reporter=dot`），
  `required-web-lane-registration-shape.test.ts` 立即 **10 failed / 8 passed (18)**，报错
  `expected exactly 1 exec logical line, found` **`2`**（不是原稿写的 `3`）——证明"恰一逻辑块"这条
  断言不是摆设；随后 `cp` 复原，`cmp` 核字节相同，18/18 恢复绿。
- **两点纪律核对**：本轮零新增 spec 文件，`TodoCenterView`/`todoApi`/`todoCountsRealtime` 三令牌
  在 `apps/web/scripts/run-required-web-tests.sh`（现与新 B-2 相同）与
  `.github/workflows/approval-web-guard.yml`（`:377-380`/`:770-773` 的 path-filter，`:1013` 的
  inline vitest token 列表）两处均已存在，未做改动，也不需要改动。
- **门审 P3-2（先存事实，如实登记，不当 CI 绿）**：`grep -rn "required-web-lane-registration"
  .github/` **零命中**——`required-web-lane-registration-shape.test.ts` 当前不在任何 GitHub Actions
  workflow 里执行；本轮/门审 round 1 的 18/18 都是本地直跑得出的信号，不是 CI 强制闸。这不是本切片
  引入的缺口（先存），本切片也不修（另开票）；只是原稿把它跟 `attendance-web-guard-workflow.spec.ts`
  并列写成"prompt 点名的必绿项"容易让读者误以为两者都有 CI 意义——两者中只有后者真的挂在
  `attendance-web-guard`（required）workflow 上。
- **D2 原始自复核（非 Opus 门审）：该文件的其它读者未被这处死代码删除破坏（逐个跑过，非静态假设）**——
  `required-web-lane-registration-shape.test.ts` 自己的 docblock 点名另外 6 个曾经/仍在解析
  这份脚本的守卫，外加全仓 grep 命中的另外 3 个 spec 直接读它的文本；这轮结果针对的是删除后的**文件
  内容**（现与新 B-2 逐字节相同，见上），与"谁的提交做了这次删除"无关，故修复轮 2 未重跑，原表保留：

  | 文件 | 结果 |
  |---|---|
  | `packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts` | 5/5 PASS |
  | `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts` | 343/343 PASS |
  | `packages/core-backend/tests/unit/network-unavailable-copy-ci-wiring.test.ts` | 7/7 PASS |
  | `scripts/ops/elearning-media-ci-wiring.test.mjs`（`node` 直跑） | 15/15 PASS |
  | `plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs`（`node` 直跑） | EXIT=0，全部 `OK` |
  | `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | 44/44 PASS |
  | `apps/web/tests/approval-record-link-picker.spec.ts` | 12/12 PASS |
  | `apps/web/tests/multitable-comment-inbox-view.spec.ts` | 2/2 PASS |
  | `apps/web/tests/multitable-b4-field-always-readonly.spec.ts` | 16/16 PASS |

  （`approval-ci-coverage-enumeration.test.ts` 自己的注释点名"W1 有四个独立的 vitest 调用，含多行
  续行的"——它按"整段折叠续行"解析，与本文件删除的死代码段（无 `exec` 前缀、从未被任何 shell 执行）
  无关，343 条用例全过证实了这一点，不是靠读注释推断。）
  `scripts/ops/integration-guard-run-web-specs.sh`（"两点纪律"的第二登记点，独立于本次改动的文件）
  也核对过 `git diff` 为空，未受影响。

## 3. 类型检查 / 构建

| 命令 | 结果 |
|---|---|
| `npx vue-tsc -b --force`（`apps/web`） | **1 条 TS2769**，锚点 `vite.config.ts(28,29)`（vite 插件类型跨版本不兼容，与本切片改动的文件无关）。**已核对为先存**：`merge-train-dry-run-v2-20260921.md` §"对照" 记录同一 head 家族在 pristine `origin/main` 上跑 `pnpm --filter @metasheet/web type-check` 同样 EXIT=2、同一条 TS2769、前 39 行逐字节相同。本轮日志（`grep -c "error TS"` = 1；`grep TodoCenterView` 零命中）确认零新增错误，且错误与 `TodoCenterView.vue` 无关联。 |
| `npx vite build`（`apps/web`） | **EXIT=0**，`✓ built in 14.67s` |

**修复轮 2 在最终树（rebase + P2-1/P3-5 修复后）上重跑，确认结论不变（数字现跑，替换旧数字，不并列）**：
`npx vue-tsc -b --force` → `EXIT=2`，`grep -c "error TS"` = **1**，唯一一条仍是
`vite.config.ts(28,29): error TS2769`，`grep -c TodoCenterView` = **0**；`npx vite build` →
**EXIT=0**，`✓ built in 12.91s`。

### 3.1 本地全量 `run-required-web-tests.sh` 直跑——1 处红，机制已定位、与本切片无关

**修复轮 2 更正（门审 P3-4）**：D2 原稿把中止原因写成"该文件字母序早于 `TodoCenterView`"——这是
**错的机制**：`multitable-recovery-archive-modal.spec.ts` 根本不在脚本 `:1257` 起的 exec 令牌块里，
它是 **`:612` 一条独立的 `npx vitest run multitable-recovery-archive-client
multitable-recovery-archive-modal --reporter=dot`**（没有 `|| exit $?`），在 `:473` 的
`set -euo pipefail` 下失败即退出整个脚本——与 exec 块内部的字母序**毫无关系**（它在 exec 块之前
645 行，属于脚本前半段一长串独立 `npx vitest run` 调用中的一条）。"直跑到这里就没跑到 exec 块"这个
**结论**是对的，"因为字母序"这个**机制**是错的，本仓 `feedback_failing_consistently_is_not_evidence_
of_cause.md` 的同族。命令核对：

```
$ grep -n "set -euo pipefail" apps/web/scripts/run-required-web-tests.sh
473:set -euo pipefail
$ grep -n "multitable-recovery-archive-modal" apps/web/scripts/run-required-web-tests.sh
612:npx vitest run multitable-recovery-archive-client multitable-recovery-archive-modal --reporter=dot
$ apps/web $ npx vitest run multitable-recovery-archive-client multitable-recovery-archive-modal --reporter=dot
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 153 passed (154)
```

**机制核实、与本切片无关**：本机 `node --version` = **v25.9.0**，而该脚本目标的 CI 运行器
（`actions/setup-node`）钉的是 **20.x**；同一份 `run-required-web-tests.sh` 自己的历史注释
（W0 docket #39 一节）就记录过同一类失败——"reproduced as a DETERMINISTIC 5/5 failure in ISOLATION
under Node 20.20.2……本机 Node 版本不同导致的微任务/定时器结算差异"。核对过与本切片无关：
```
git diff origin/main origin/feat/todo-center-phase2-fe -- apps/web/tests/multitable-recovery-archive-modal.spec.ts
```
零输出（该文件与其大概率的源文件都不在这条分支的历史改动范围内），且该测试独立跑时结果相同
（1 failed/153 passed，多次重跑确定性失败，非偶发）——所以本轮改动前后这个坑都在，不是本切片引入，
也不因本切片而加重或减轻。真正必绿的两项（`attendance-web-guard-workflow.spec.ts`、
`required-web-lane-registration-shape.test.ts`）与本轮自己的 `TodoCenterView.spec.ts` 均已单独跑过
并 PASS（见 §1），未被这条更早触发、与本轮令牌无关的独立调用挡住。

### 3.2 新断言与 Node/ICU/时区无关

`TodoCenterView.spec.ts` 本轮新增的所有断言都只钉**标签前缀**（`toContain('更新于')` /
`toContain('Updated')` / `toContain('not-a-date')` / `toBe('')`），**没有一条对 `toLocaleString()`
产出的具体时间戳字符串做逐字断言**——`updatedAtLabel`/`dueAtLabel` 内部调用的 `Intl`/`Date` 格式化
在不同 Node 版本、不同 ICU 数据、不同容器时区下产出的具体时间文本可能不同，但这些测试不关心那部分，
只关心"有没有渲染该字段的标签"与"未解析成功时原样透传"。真机截图里出现的具体时间字符串
（`9/21/2026, 11:46:32 PM`、`2026/9/21 23:46:32`）是**证据**，不是**判据**——单测判据的判别力不
依赖于本机与 CI 之间 Node/ICU/时区的任何差异。

## 4. 真实浏览器验收（三腿）

| 腿 | 判据 | 结果 | 证据 |
|---|---|---|---|
| ① updatedAt 呈现 | 两条条目都渲染 `Updated <本地化时间戳>` | **PASS** | 截图 `h4-01-mixed-actionable-and-updatedat.png`；DOM 文本 `Updated 9/21/2026, 11:46:32 PM` / `Updated 9/21/2026, 11:43:21 PM` |
| ① dueAt 呈现（代码路径） | 无数据时不渲染该 `data-testid` | **PASS（但见下方 NOT RUN）** | `results-h4.json`：两行 `dueAtPresent: false` |
| ② C′ pill——正控 | **同一用户、同一次页面加载**里两个不同实例（`0a0b7fd8…`/`b71c437f…`，`id`/`title`/`href`/`updatedAt` 均不同）分别渲染为 `actionable:true`（无 pill）与 `actionable:false`（有 pill）——判据 C′ 要求的"不同形"成立，渲染出的判别物只有 pill（**修复轮 2 改正**：D2 原稿写"仅这一个字段不同"，是过强表述——两行是两个不同实例，不是同一实例改一个字段） | **PASS** | 截图同上：第一行无 "View only"，第二行有；`net-todo-requests.json` 逐字确认后端返回体里两条 `actionable` 值分别为 `true`/`false` |
| ③ 来源不可用文案 | 真实（可逆）撤权触发 `unavailable`，文案 = `Can't be shown right now — please try again shortly.`，不含 "source"/"来源" | **PASS** | 截图 `h4-02-source-unavailable-copy.png`；`results-h4.json` 的 `leg3.containsInternalTerm: false` |
| ③ 恢复 | `GRANT` 后重新拉取，2 条恢复、0 处于 unavailable | **PASS** | 截图 `h4-03-recovered-after-grant.png`；`results-h4.json` 的 `leg3recovery: {recoveredCount:2, stillUnavailable:0}` |

触发③的机制（真实、可逆、只作用于本次一次性库）：
```sql
REVOKE SELECT ON TABLE approval_assignments FROM ms2testbed;   -- 断
GRANT  SELECT ON TABLE approval_assignments TO   ms2testbed;   -- 恢复
```
选它的理由与既有报告一致：该表是共享待处理查询（`approval-pending-query.ts`）count 与 list 两条语句
都要读的表，能同时让徽标与中心页进入不可用；权限漂移是真实运维事故的形状，不是改 schema、不是打桩。

**关于截图 `h4-01`/`h4-03` 文件大小相同（37084 字节）**：`cmp` 核对为**逐字节相同**，这是预期结果，
不是复制粘贴的证据缺陷——`GRANT` 之后重新拉取的 DOM 状态（2 条条目、同样的 `Updated` 标签、同一行
带 pill 同一行不带）与撤权之前完全一致，截图渲染是确定性的，恢复到相同状态自然产出相同字节。真正
承重的恢复证据是 `results-h4.json` 的 `leg3recovery: {recoveredCount:2, stillUnavailable:0}`（这两
个数字来自撤权→恢复之间的一次真实往返，不是重放旧截图）。

## 5. NOT RUN 清单（如实记录，不掩饰）

1. **`dueAt` 字段在真实浏览器里的"有值渲染"半边 NOT RUN**——今天唯一注册的审批源
   (`approval-pending-source.ts:78-85`) 不产出 `dueAt`（审批实例没有"截止时间"这个概念），本轮没有
   改后端去人为造一个假 `dueAt` 值（那会是伪造数据，违反"不编造值"纪律）。该半边的**代码路径**已经由
   单元测试 `TodoCenterView.spec.ts:189`（"…dueAt only when the source supplies one" 用例的
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
4. **真机三腿全程只跑过英文（`Language: English`）分支，zh-CN 呈现从未在真实浏览器里出现过**——
   三张截图（`h4-01`/`h4-02`/`h4-03`）拍到的都是 `updatedAtLabel`/`dueAtLabel`/新版不可用文案的
   **英文**产出（`Updated 9/21/2026, 11:46:32 PM`、`Can't be shown right now — please try again
   shortly.`）；中文产出（`更新于 2026/9/21 23:46:32`、`暂时无法查看，请稍后重试`）只在 jsdom
   单测（`TodoCenterView.spec.ts`）里出现过，**owner 实际使用的语言（中文）从未被真机验证覆盖**。
   补齐方法：驱动脚本里把登录后的 `locale-switcher` select 切到 `zh-CN` 再截一轮，成本是一次
   `page.selectOption` + 3 张截图，本轮未做，如实列入 NOT RUN 而非事后补拍旧截图冒充。
5. **`formatItemTimestamp` 对缺失 `updatedAt` 的防御性分支（`value === undefined/null → ''`）
   未在真实浏览器验证**——今天唯一注册的来源恒产出非空 `updatedAt`（`row.updated_at.toISOString()`，
   后端 NOT NULL 语义），这条分支是纯防御性代码（防止未来违反 `PendingItem.updatedAt: string` 类型
   契约的来源把字面量 `"undefined"` 渲染出来），已有单元测试 + mutation 覆盖（见 §1.1 的第二轮
   补测），真机层面没有也不该有一个违反契约的真实来源去触发它。

## 6. 未做的事（如实记录）

- 未合并、未 undraft 任何 PR；未动 `origin/main`。
- 未对 `metasheet_test`/`metasheet_v2`/`metasheet_testbed_*` 做任何读写。
- 未改锁文正文（`todo-center-design-lock-draft-20260915.md` 全程只读）。
- 未 `git checkout -- .`/`reset --hard`/`stash drop`；本轮 4 次 mutation 还原（dueAt 渲染守卫、
  不可用文案字符串、`run-required-web-tests.sh` 的第二条 exec 逻辑行、`updatedAt` 缺失防御分支）
  均用 `cp` 备份 + `cmp` 核对字节相同。
- 未删除任何不是本轮创建的 worktree/库/文件/进程。

## 7. 修复轮 2（D1 rebase + D2 record fix，2026-09-22）—— 登记项与未动项

对象门审：`impl-gate-B3-todo-polish-round1-20260922.md`。本轮**未创建任何数据库**——TodoCenterView.spec.ts、
attendance-web-guard-workflow.spec.ts、required-web-lane-registration-shape.test.ts、vue-tsc、
vite build 五项均不触库；真机三腿（§4）沿用本轮之前已产出、门审 round 1 已逐文件审计过的证据，未重跑。

### 7.1 Rebase（详细命令见设计 MD §4.1，此处只登记与验证 MD 相关的部分）

- 分支旧 head `7601a7eebc8c7ebfad76506be8d9c8f4e6dc9008` → 新 head
  `2e99240b2206215a6e0b82cc53e5af916b767396`，rebase 到新 B-2 head
  `16703f8cfd7a11ac90da8568bc4a1a7846d6dd05` 之上，**零冲突**（两条 B-3 自有提交自动应用）。
- **P3-3 登记（不修，归 #5857）**：`git log --format='%H %an <%ae>' origin/main..HEAD | grep -v
  'zensgit <77236085'` 恰两行，均 `Merge Rehearsal <rehearsal@local.invalid>`
  （`03c276cc290fdfbb0e5de2ff38b8cb61477774cf`、`9fa446dd358514011fe1f6ddd8a9fa6db223776e`）——
  两条都是 `#5857` 祖先链上的既有提交（`git merge-base --is-ancestor 0a6531b80… HEAD` = YES 的
  那条链带进来的），**不是本切片自己的两条提交**（`2e99240b2`/`6ff646e5e` 的 author/committer
  均 `zensgit <77236085+zensgit@users.noreply.github.com>`）。修复归属 #5857 合并前处理，本 PR
  不动、不新增提交去改写它们。
- **P3-7 登记（不修，归 #5857）**：真机截图显示 `/todo` 导航入口在 1280px 下被裁掉末字
  （`App.vue:392-397`/`:415-426` 的 `overflow-x: auto` + `flex: 0 0 auto` 故意把宽度压力推给导航
  条内部滚动，是设计内降级不是回归）。`git diff --name-only 16703f8cf… HEAD` 不含 `App.vue`——本 PR
  零改动该文件；该入口本身是 #5857 B-2 step 11 加的（`7341beccfbe95e7d338c7504970388b2a4940f09`），
  归属 #5857 之后的 UX 切片，不阻塞本 PR。

### 7.2 P2-1（惰性行分支 meta 块零覆盖）—— 见 §1.1.1，选择删除

隔离网格、还原记录、删除后 M1-final 重跑均见 §1.1.1；对应代码改动见设计 MD §2.1。

### 7.3 PR body 需要的范围更正（非本 MD 内容，仅登记本轮已知需要同步的一处）

PR #5973 body 第四条 scope 描述（"清理 `run-required-web-tests.sh` 末尾一处遗留的死代码重复令牌块"）
在 rebase 后不再准确——该清理现在完全来自继承的新 B-2 head，本 PR 对该文件零 diff（见 §2）。
`gh pr edit 5973 --body` 已同步这一句改述，详见提交后的 PR body。
