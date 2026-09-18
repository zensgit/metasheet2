# 待办中心 Phase-2(切片 B-2,前端)—— 验证 MD

工作树:本文档所在工作树(分支 `feat/todo-center-phase2-fe`)。核对时 `git rev-parse HEAD` =
`4b3f8f48360405461ecec802974006dc8961bc7b`;分支基点(B-1 头)`1c08a4ac8feb0e443134ae20af283d836ff30300`;
与 `origin/main` 的合并基点 `89f1ecdee2c3b70205a318074824c834bc6a5c7e`。本文档只覆盖 B-2(前端)自己
交付的判据——判据 B 的徽标/中心页层、判据 C′ 的前端呈现半边、判据 E、CI 两点接线。判据
A0/A/C/D/F 与判据 B 的 API 层半边是 B-1 的范围,已在 `todo-center-phase1-verification-20260918.md`
里逐条闭合,本文档不重复其证据,只在下表标注「B-1 范围,本次不重跑其真库套件」。

写本文档时**未新增、未修改任何源码或锁文**——所有下方的「重跑」都是对已落地代码的验证,mutation 台账
的每一条都在跑完后原样恢复(`cmp` 确认字节级相同)。

## 1. 锁文验收表 → spec 文件 + 用例名 + lane

| 锁 §5 行 | 覆盖范围(本切片 vs B-1) | spec 文件 | 用例名(节选,完整见 §2 命令输出) | lane |
|---|---|---|---|---|
| A0 | B-1 范围,不在本切片 | `packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts` | 十四类 viewer(略) | `approval-realdb-todo-center-pending-query.yml`(真库) |
| A | B-1 范围,不在本切片 | 同上 | 「中心不放宽可见性」两条 mutation 用例 | 同上 |
| B(API 层) | B-1 范围,不在本切片 | 同上 | 判据 B API 层格 | 同上 |
| **B(徽标层)** | **本切片** | `apps/web/tests/approvalNavTodoBadge.spec.ts` | `renders a discriminable unavailable state when the count read throws (mutation guard...)`、`... when the response carries a stubbed \`degraded: true\` flag ...`、`... when any source reports \`unavailable\`, even with a nonzero count ...`、`carries the label in the unavailable state's aria-label ...` | `apps/web/scripts/run-required-web-tests.sh`(令牌 `approvalNavTodoBadge`,**required 检查 `web-tests`**,见 §5) |
| **B(中心页层)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `renders "checked, nothing pending" for an ok source with zero items — NOT the same shape as unavailable`、`renders "could not check" for an unavailable source — NOT the same shape as ok+0`、`mutation guard: a response with an unavailable source among ok sources must still render that source's own unavailable group (...)`、`renders a page-level load-failed state (...)` | 同上(`TodoCenterView` 令牌,同一 required 检查) |
| **B(推送同源)** | **本切片** | `packages/core-backend/tests/unit/todo-realtime.test.ts` | `reuses the injected countPendingForUser fetcher — the SAME shape pendingSourceRegistry.countPendingForUser returns — never computing a count itself`、`carries the per-source ok/unavailable status map through verbatim (fail-closed discriminability, lock §3)` | `packages/core-backend` 默认单测(无需真库);**required 检查 `test (20.x)`**(经 `pnpm --filter @metasheet/core-backend test` 的裸 `vitest run`,见 §4.4——已用 JSON reporter 机核该文件在其内) |
| C | B-1 范围,不在本切片 | `todo-center-pending-gate.ts` | 判据 C 两条 mutation | 真库 lane |
| D | B-1 范围,不在本切片 | 同上 | 判据 D | 同上 |
| **C′(前端呈现)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `renders a view-only pill for actionable:false, and no pill when actionable is absent or true` | `run-required-web-tests.sh`,required |
| C′(判定本身) | B-1 范围,不在本切片 | 同上(后端) | `resolveCanDecideCurrentNode` 相关 | 真库/单测 lane |
| **E(徽标)** | **本切片** | `apps/web/tests/approvalNavTodoBadge.spec.ts` | `E1 (principal swap, session present): ...`、`E2 (sign-out, no session): ...`、`E3 (sign-out): a push arriving on the still-open socket after sign-out must not repaint` | `run-required-web-tests.sh`,required |
| **E(中心页)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `E1 (principal swap, session present): ...`、`E2 (sign-out, no session): ...`、`a push landing on the still-open socket after a CONFIRMED sign-out must not issue a new read (mirrors the badge's E3)` | `run-required-web-tests.sh`,required |
| **E(换 org 接线事实)** | **本切片** | `apps/web/tests/useAuth.spec.ts` | `fires the auth-principal-change notification synchronously on a successful org switch, storage already updated` | `run-required-web-tests.sh`**第 477 行**(见下方附注——**不是**本切片改的那段 exec 行),required |
| F(无新表) | B-1/本切片共同满足(本切片未新增迁移) | — | `git diff --stat` 对 `packages/core-backend/src/db/migrations` 为空 | — |

附注(`useAuth.spec.ts` 的 lane 归属,写作过程中的一次自我更正):`run-required-web-tests.sh` 不是单
一条 exec 行,而是**多段** `npx vitest run ...` 调用的串联(每段各挑一批文件/令牌)。本切片改的是
脚本**末行**(见 §2.3/§4)那一段的令牌名单——那段确实用子串匹配,且确实不含 `useAuth`。初稿据此断言
「`useAuth.spec.ts` 不受这条必需检查覆盖」,是**只看了改动的那一行、没有搜索脚本全文**。机核全文
后发现该文件被**另一段独立的 exec 行**(第 477 行)以**完整文件路径**(不是子串令牌)显式点名:
```
$ grep -n "useAuth" apps/web/scripts/run-required-web-tests.sh
477:npx vitest run tests/useAuth.spec.ts tests/useSessionOrg.spec.ts tests/AttendanceSessionOrgSwitcher.spec.ts tests/useAttendanceSessionGuard.spec.ts --pool=forks --poolOptions.forks.singleFork=true --reporter=dot
```
本次会话原样重跑这一行(未改写),确认新用例在内并通过:
```
$ npx vitest run tests/useAuth.spec.ts tests/useSessionOrg.spec.ts tests/AttendanceSessionOrgSwitcher.spec.ts tests/useAttendanceSessionGuard.spec.ts --pool=forks --poolOptions.forks.singleFork=true --reporter=verbose 2>&1 | grep "org switch"
 ✓ tests/useAuth.spec.ts > useAuth > fires the auth-principal-change notification synchronously on a successful org switch, storage already updated
```
结论:判据 E 的换 org 接线事实**已被 required 检查 `web-tests` 覆盖**(通过既有的第 477 行,该行
不是本切片新增或改动的——本切片没有改这一行,它本来就在,新用例是加进已有文件后自动被这条既有 lane
接住)。初稿的「未验/ungated」判断是错的,已更正,不留旧结论。

## 2. 命令逐字 + 结果(2026-09-18 本次会话重跑)

### 2.1 本切片新增/改动 spec,精确令牌

```
$ cd apps/web && pnpm exec vitest run todoApi TodoCenterView todoCountsRealtime approvalNavTodoBadge App.spec.ts useAuth.spec.ts --reporter=dot
 ✓ tests/todoCountsRealtime.spec.ts (5 tests) 59ms
 ✓ tests/todoApi.spec.ts (6 tests) 3ms
 ✓ tests/TodoCenterView.spec.ts (10 tests) 48ms
 ✓ tests/useAuth.spec.ts (36 tests) 14ms
 ✓ tests/App.spec.ts (9 tests) 32ms
 ✓ tests/approvalNavTodoBadge.spec.ts (23 tests) 150ms
 Test Files  6 passed (6)
      Tests  89 passed (89)
```

### 2.2 后端单测

```
$ cd packages/core-backend && pnpm exec vitest run tests/unit/todo-realtime.test.ts --reporter=dot
 ✓ tests/unit/todo-realtime.test.ts (5 tests) 3ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 2.3 CI 步骤的**逐字**命令(从 `.github/workflows/approval-web-guard.yml:1006` 原样抽取,未改写)

```
$ sed -n '1006p' .github/workflows/approval-web-guard.yml | sed 's/^ *run: //' > /tmp/todo-fe-ci-cmd.sh
$ bash -c "$(cat /tmp/todo-fe-ci-cmd.sh)"
 Test Files  104 passed (104)
      Tests  1958 passed (1958)
   Duration  8.75s (transform 7.76s, setup 964ms, collect 16.39s, tests 33.68s, environment 27.33s, prepare 4.67s)
```
这条命令跑的正是 `run-required-web-tests.sh` 末行同一批令牌(该行本身也在这次改动里,§4 已核对两处
一致);104 个文件、1958 个用例全绿,是本切片改动落地后、按 CI 步骤字面形态(非 `npx` 简化形态)的
完整重跑,不是抽样。

## 3. Mutation 台账(每条:cp 备份 → 改 → 跑 → 观察红 → cp 还原 → 再跑绿 → `cmp` 确认字节还原)

### Mutation 1 — 徽标判据 B:退回到「degraded/unavailable/抛错一律 `applyCount(0)`」的旧行为

目标:`apps/web/src/approvals/components/ApprovalTodoBadge.vue` 的 `applyResult()`。

```diff
-function applyResult(response: TodoCountResponse | null): void {
-  if (response === null || isTodoResponseDegraded(response)) {
-    isUnavailable.value = true
-    pendingCount.value = 0
-    return
-  }
-  isUnavailable.value = false
-  applyCount(response.count)
-}
+function applyResult(response: TodoCountResponse | null): void {
+  isUnavailable.value = false
+  applyCount(response === null ? 0 : response.count)
+}
```
跑 `vitest run approvalNavTodoBadge`:**5 failed / 18 passed**(此前全 23 绿)。转红用例含
`carries the label in the unavailable state's aria-label ...`(`unavailableBadgeOf(root)` 断言
`toBeTruthy()` 收到 `null`)与 stub-degraded/抛错两条判据 B 用例。`cp` 还原后 `cmp` 确认字节相同;
重跑该 spec 回到 **23 passed**。

### Mutation 2 — 徽标判据 E:删监听器自身的代际自增(只留 `refresh()` 的自增)

```diff
 const unsubscribeAuthPrincipal = onAuthPrincipalChange(() => {
-  generation += 1
   pendingCount.value = 0
```
跑 `vitest run approvalNavTodoBadge`:**1 failed(E2)/ 22 passed**——精确命中
`E2 (sign-out, no session): a read still in flight at sign-out must not paint the departed
principal's count once it resolves`,与设计 MD §4.1 预期的「只影响无新读的登出路径」完全一致(E1
不受影响,因为 E1 靠的是 `refresh()` 自己的 bump)。还原后 `cmp` 字节相同,重跑回到 **23 passed**。

### Mutation 3 — 中心页判据 B:分组改由 `items` 反推(而非 `sources` 驱动)

```diff
-  groups.value = Object.entries(response.sources).map(([source, status]) => ({
-    source,
-    status,
-    items: response.items.filter((item) => item.source === source),
-  }))
+  const bySource = new Map<string, typeof response.items>()
+  for (const item of response.items) { ... }
+  groups.value = [...bySource.entries()].map(([source, items]) => ({ source, status: 'ok' as const, items }))
```
跑 `vitest run TodoCenterView`:**3 failed / 7 passed**,精确命中该文件自己命名的
`mutation guard: a response with an unavailable source among ok sources must still render that
source's own unavailable group (...)`,以及两条依赖「`unavailable` 组必须渲染」的用例。还原后
`cmp` 字节相同,重跑回到 **10 passed**。

### Mutation 4 — 中心页判据 E:删 `refresh()` 自身的代际守卫

```diff
 async function refresh(): Promise<void> {
-  generation += 1
-  const mine = generation
   try {
     const result = await getTodoItems()
-    if (mine !== generation) return
     applyResult(result)
   } catch {
-    if (mine !== generation) return
     applyResult(null)
   }
 }
```
跑 `vitest run TodoCenterView`:**2 failed(E1, E2)/ 8 passed**——这次两条都红(不同于 mutation 2 只
红一条),因为这里删的是两条判据共用的唯一守卫,E1(靠 `refresh()` 自身 bump)与 E2(靠监听器 bump
挡住旧读,但旧读的 `mine !== generation` 判断本身也被删了)都失去保护。还原后 `cmp` 字节相同,重跑
回到 **10 passed**。

### Mutation 5 — 实时推送「同一谓词」:忽略注入的 fetcher,伪造发散结果

目标:`packages/core-backend/src/services/todo-realtime.ts`。
```diff
-    const countPendingForUser = input.countPendingForUser ?? defaultCountPendingForUser
-    const viewer: PendingViewer = { actorId: input.userId, roles: input.roles ?? [], permissions: input.permissions ?? [] }
-    const { count, sources } = await countPendingForUser(viewer)
+    void input.countPendingForUser
+    void defaultCountPendingForUser
+    const count = 0
+    const sources: Record<string, 'ok' | 'unavailable'> = {}
```
跑 `vitest run tests/unit/todo-realtime.test.ts`:**4 failed / 1 passed**,精确命中
`reuses the injected countPendingForUser fetcher ...`、`carries the per-source ok/unavailable
status map through verbatim ...` 等——只有 `'no-ops without throwing when no collabService is
available'` 幸存(它在 `countPendingForUser` 被调用之前就早退)。还原后 `cmp` 字节相同,重跑回到
**5 passed**。

工作树在五条 mutation 全部还原后确认干净:
```
$ git status --porcelain
(空)
```

## 4. CI 两点接线证据

### 4.1 `paths:` 两块字面相同

```
$ sed -n '360,385p' .github/workflows/approval-web-guard.yml > /tmp/block1.txt
$ sed -n '753,778p' .github/workflows/approval-web-guard.yml > /tmp/block2.txt
$ diff /tmp/block1.txt /tmp/block2.txt && echo IDENTICAL
IDENTICAL
```
新增的 6 个 path 条目(两块各一份):`apps/web/src/todo/api.ts`、
`apps/web/src/todo/useTodoCountsRealtime.ts`、`apps/web/src/todo/views/TodoCenterView.vue`、
`apps/web/tests/todoApi.spec.ts`、`apps/web/tests/todoCountsRealtime.spec.ts`、
`apps/web/tests/TodoCenterView.spec.ts`。

### 4.2 YAML 仍可解析

```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/approval-web-guard.yml')); print('OK')"
OK: approval-web-guard.yml parses
```

### 4.3 exec 行 token 计数/子串碰撞——机械核对,**发现一处需要更正的既有断言**

commit message(`ci(approval-web-guard): close two-point wiring gap for todo center FE`,本分支
step 10)写道:「103 tokens before this change, 106 after, no duplicates」。本次会话用脚本机械复核
（对 `vitest run` 与 `--reporter=dot` 之间的空白分隔 token 列表)：

```python
tokens = <exec 行去掉前后缀后的 106 个 token>
old_tokens = [t for t in tokens if t not in ('todoApi','TodoCenterView','todoCountsRealtime')]
len(tokens) == 106                       # True
len(old_tokens) == 103                   # True
len(old_tokens) != len(set(old_tokens))  # True  ← 有重复
Counter(old_tokens) 里 count>1 的:
  {'approval-condition-summary': 2, 'approval-amount-in-words': 2, 'approval-form-draft': 2}
```
**更正**:「no duplicates」按字面(整个 106/103 token 列表内零重复)是**假**——同一行内本就有三组
字面重复 token,各出现两次。核对这三组重复是否是本切片引入:
```
$ git show 1c08a4ac8feb0e443134ae20af283d836ff30300:.github/workflows/approval-web-guard.yml \
  | grep -n "run: pnpm --filter @metasheet/web exec vitest run approval-attachment-download"
970: ...(同样含 approval-condition-summary/approval-amount-in-words/approval-form-draft 各两次)...
```
三组重复在 B-1 头(`1c08a4ac8`,本切片改动前)就已存在,**不是**本次新增的三个 token 引入的。子串
碰撞方向的核对(新三个 token vs 既有 103 个,双向)确认**零碰撞**——commit message 这部分成立,
只有「no duplicates」这一句读作「整份列表零重复」时不成立。不改动该行(改 YAML 不在本次任务范围;
若要修,应去掉三组各自的一次重复,是后续清理项,不影响本切片任何判据的通过与否——vitest 对重复文件
名令牌只是多跑一次同一份测试,不影响结果正确性,已由 §2.3 的 1958-passed 结果覆盖)。

### 4.4 判据 B(推送同源)的 required 检查覆盖——`test (20.x)` 的裸 `vitest run` 机核

`packages/core-backend` 的 `test` 脚本(`package.json:26`)是裸 `"test": "vitest"`,无路径过滤;
`.github/workflows/plugin-tests.yml` 的 required `test`(矩阵 `[18.x, 20.x]`,产生 required 检查
`test (20.x)`)在其 "Run core-backend tests" 步骤(该 job 块内,`matrix.node-version` 不限)直接跑
`pnpm --filter @metasheet/core-backend test`。`tests/unit/todo-realtime.test.ts` 是否落在这条裸命令
的默认收集范围内——本次会话没有停留在推断,而是**跑了一遍全量**并用 JSON reporter 机核:
```
$ cd packages/core-backend && CI=true pnpm exec vitest run --reporter=json --outputFile=/tmp/core-backend-full-run.json
JSON report written to /tmp/core-backend-full-run.json
$ python3 -c "
import json
d = json.load(open('/tmp/core-backend-full-run.json'))
print(d['numTotalTestSuites'], d['numPassedTestSuites'], d['numFailedTestSuites'])
print([r['status'] for r in d['testResults'] if 'todo-realtime' in r['name']])
"
3912 3912 0
['passed']
```
`packages/core-backend/vitest.config.ts` 的 `exclude` 数组(`:31-` 起)本次会话通读过,没有任何一条
匹配 `tests/unit/todo-realtime.test.ts`(该数组只排除若干 `tests/integration/*.db.test.ts`/`*.api.test.ts`
真库用例)。结论:本切片改动里唯一验证「推送不重新发明谓词」的单测,**落在 required 检查 `test (20.x)`
的收集范围内**,3912 个测试套件(含它)全绿——不是本切片自己声称、而是这次跑出来的。

## 5. Required-check 状态核实

```
$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.contexts'
["contracts (strict)","contracts (dashboard)","pr-validate","test (20.x)","contracts (openapi)",
 "web-tests","stock-prep PowerShell 5.1 acceptance","attendance-web-guard","integration-guard",
 "ssh host-key pin contract (fail-closed known_hosts)",
 "observation-kit contract (read-only SQL census + runbook gating)","recovery-schema-drift",
 "Approval browser verify (chromium)"]
```
两个不同的前端 lane,不要混为一谈:
- `.github/workflows/approval-web-guard.yml` 的 job id(该 job 块无 `name:` 覆盖)是
  `approval-web-guard`(`:830`)——**不在**上述必需检查列表里,是 path-filtered、advisory 的 lane
  (与既有记忆 `feedback_apps_web_specs_ungated` 一致)。
- `.github/workflows/web-tests.yml` 的 job id 是 `web-tests`(`:38`)——**在**上述必需检查列表里,
  且是**无路径过滤、每次 PR 必跑**(该文件自己的头部注释:「Always-on web test gate」「no path
  filter」)。它唯一的一步就是 `bash apps/web/scripts/run-required-web-tests.sh`(`:77`)——
  逐字就是本文档 §2.3 已完整重跑过的同一个脚本(该脚本自身多段 exec 行,§1 附注已核对
  `useAuth.spec.ts` 落在其中一段)。

结论(更正 §5 初稿的误判——初稿把「`approval-web-guard` 不是 required」错误地推广成了「本切片的前端
判据证据不由分支保护强制」):**判据 B(徽标/中心页层)/C′(前端呈现)/E(徽标/中心页/换 org 接线)的
全部前端证据,都落在必需检查 `web-tests` 的执行范围内**(§2.3 的 104 文件/1958 用例整脚本重跑 +
§1 附注对第 477 行的单独重跑,两次重跑合起来覆盖了脚本里含新增/改动断言的每一段)。`approval-web-guard`
才是那条 advisory、path-filtered 的 lane——它的存在提供**双重**验证(改动触发时更快看到红),不是
唯一的把关点。

## 6. 补充清单(`impl-supplementary-gate-checklist-20260918.md`)逐条核对

| # | 内容 | 本切片适用性 |
|---|---|---|
| 共用 1 | `t2-source-freeze-ci-wiring.test.mjs` 闭世界,新 `.db.test.ts` 需登记 | **N/A**:本切片不新增任何 `.db.test.ts` |
| 共用 2 | s6a 惯例覆盖需 PR body 说明 | **N/A**:本切片不改 `plugin-tests.yml` |
| 共用 3 | s6a 重钉安静窗口 | **N/A**:同上 |
| 共用 4 | 错误码不得降级成裸 HTTP 状态 | **N/A(本切片零新增错误码)**:本切片未新增任何后端错误码;沿用 B-1 的 `TODO_USER_REQUIRED`/`TODO_ITEMS_FAILED`/`TODO_COUNT_FAILED`(均已带专用码,`routes/todo.ts:41-44,:61-63,:74-76`) |
| lane B 8-10,12 | 独立 vitest project 的 gate 环境变量/`MIGRATION_EXCLUDE`/触发集/命名/WARN-ONLY 脚本 | **N/A**:均针对 B-1 的真库 lane,本切片不新增/不改该 lane |
| **lane B 11** | 判据 E(代数守卫)与 §3 第 5 条硬约束「属前端切片 2,首切片 PR body 要写『未做』」 | **本切片交付**——这正是 B-1 遗留给 B-2 的项;本文档 §3 的 mutation 2/4 是其证据 |

## 7. 绝对断言自扫(本文档,写作过程中新发现)

- **`todo/api.ts:60-65` 与 `ApprovalTodoBadge.vue:35-37` 的文档字符串「徽标与中心页共用
  `isTodoResponseDegraded`」不成立**:本次会话 grep `TodoCenterView.vue` 的 import 语句
  (`:132`,只有 `getTodoItems` + 三个类型,没有这个函数名),且 `TodoItemsResponse`
  (`api.ts:39-42`)本身没有 `degraded` 字段——中心页从未调用、也无法按同一形状调用它。设计 MD §3.1
  已记录更正后的结论(中心页复用的是 `PendingSourceStatus` 类型和 `sources` 字段,不是这个函数),
  未改动这两处源码文档字符串。
- **`ApprovalTodoBadge.vue`/`TodoCenterView.vue` 文档字符串「4 处 `resetSessionBootstrap` 调用点」
  少算一处**:本次会话重新 `grep -n 'resetSessionBootstrap(' apps/web/src/composables/useAuth.ts`
  得到 5 处调用(另有 1 处是函数定义本身,不计入),第 5 处在 `observeExplicitSessionStorage`
  (`:58-84`)内的跨标签页 `storage` 事件监听器(`:77`)——两个组件文件的文档字符串都没提这一处。
  已在设计 MD §4.3 记录为「文档字符串的小遗漏,不是判据 E 的缺口」:该路径同样只调用
  `notifyAuthPrincipalChange()`,被同一个监听器覆盖。**未改动**这两个 `.vue` 文件的文档字符串
  (超出本次任务的「不改代码」边界);如实记录于此,供后续切片顺手更正。
- **CI commit message 的「no duplicates」按字面不成立**(§4.3)——已更正为「新旧 token 间零子串
  碰撞成立,但既有 103-token 列表内本就有三组字面重复,系继承自 B-1 头,非本切片引入」。
- **本文档自己的初稿曾把「`useAuth.spec.ts` 不由必需检查覆盖」写进 §1/§5**:推理依据只看了
  `run-required-web-tests.sh` 里本切片改动的那一段 exec 行(末行),没有搜索该脚本全文;该文件其实
  在**另一段独立的** exec 行(第 477 行)里被完整文件路径点名。连带地,§5 初稿把「`approval-web-guard`
  不是 required」错误推广成了「本切片前端判据证据都不受分支保护强制」——但真正把关的是同样跑了
  这份脚本、且**是** required 的 `web-tests` 检查,不是 `approval-web-guard`。两处都已在 §1/§5
  正文改写,不是留一句「不算」就地带过——旧结论没有保留在文档任何位置。

## 8. 未做 / 未验 / blocked-with-reason(如实列出)

| 项 | 状态 | 理由 |
|---|---|---|
| socket 换 org 后重连(设计 MD §4.4 描述的半闭合缺口) | **未做** | 需要改 `useTodoCountsRealtime.ts` 的连接生命周期(在 `onAuthPrincipalChange` 上重新 `ensureSocket()`),属独立、更大的单元,设计 MD §4.4 已记录为留给后续切片 |
| `todo:counts-updated` 房间/负载是否按 org 隔离 | **未验** | 未在本次会话核对 `buildAuthenticatedUserRoom` 的 org 隔离粒度;不是本切片声明交付的判据,但会影响上一条缺口的实际影响面——留给负责该单元的后续切片一并核实 |
| `apps/web` 全量 `vue-tsc -b` 类型检查 | **未跑（本轮时间预算内未跑）** | 本轮改动的具体文件所在的 6 个 spec + CI 字面 104 文件套件全绿(§2),但未跑覆盖全仓的 `pnpm run type-check`;不是这次改动新引入类型错误的正面证据,只是本文档未覆盖这一项 |
| `approval-web-guard` 是否应升级为 required check | **未做决定** | §5 只核实了「今天不是」,升级与否是 owner/平台线的决定,不在本切片范围 |
| Draft PR 未开出 | **按任务书范围,未做** | 本次任务书(`todo-center-phase2-fe`)只要求写这两份 MD、提交、push;开 Draft PR、过 Opus 门审是目标文档「每个切片的交付物」流程的下一步,不在本次委派范围内 |
| DDL / 迁移检查(判据 F) | **已核对，为空** | `git diff --stat 1c08a4ac8f..HEAD -- packages/core-backend/src/db/migrations` 无输出(本切片零迁移改动) |

## 9. 锁文没有的章节(如实记录,不是漏引)

锁文 `todo-center-design-lock-draft-20260915.md` 到 §7 为止,无 §8/§9;本文档不虚构不存在的锁文小节
编号。
