# 待办中心 Phase-2(切片 B-2,前端)—— 验证 MD

工作树:本文档所在工作树(分支 `feat/todo-center-phase2-fe`)。核对时 `git rev-parse HEAD` =
`4b3f8f48360405461ecec802974006dc8961bc7b`;分支基点(B-1 头)`1c08a4ac8feb0e443134ae20af283d836ff30300`;
与 `origin/main` 的合并基点 `89f1ecdee2c3b70205a318074824c834bc6a5c7e`。本文档只覆盖 B-2(前端)自己
交付的判据——判据 B 的徽标/中心页层、判据 C′ 的前端呈现半边、判据 E、CI 两点接线。判据
A0/A/C/D/F 与判据 B 的 API 层半边是 B-1 的范围,已在 `todo-center-phase1-verification-20260918.md`
里逐条闭合,本文档不重复其证据,只在下表标注「B-1 范围,本次不重跑其真库套件」。

写本文档时**未新增、未修改任何源码或锁文**——所有下方的「重跑」都是对已落地代码的验证,mutation 台账
的每一条都在跑完后原样恢复(`cmp` 确认字节级相同)。

**更正(P3-1,独立门审 `impl-gate-B2-round1-20260918.md` 指出,修复轮 1 登记)**:上面自报的
`git rev-parse HEAD` = `4b3f8f483`,是**本文档自己这次提交之前**的一次提交;门审绑定的、也是本条
更正与 §10 修复轮实际核对的被审 head 是**该文档提交本身**,即 `396cd9b9238d78fe0f9ef6b189113ef98127a84e`
(`docs(approval): todo-center B-2 (frontend) design + verification MD`)。§10 记录的修复轮 1 建立在
`396cd9b92` 之上,不在 `4b3f8f483` 之上——本节起,任何「本文档被审 head」的引用一律以 `396cd9b92`
为准,不以本段开头那个自报值为准。

## 1. 锁文验收表 → spec 文件 + 用例名 + lane

| 锁 §5 行 | 覆盖范围(本切片 vs B-1) | spec 文件 | 用例名(节选,完整见 §2 命令输出) | lane |
|---|---|---|---|---|
| A0 | B-1 范围,不在本切片 | `packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts` | 十四类 viewer(略) | `approval-realdb-todo-center-pending-query.yml`(真库) |
| A | B-1 范围,不在本切片 | 同上 | 「中心不放宽可见性」两条 mutation 用例 | 同上 |
| B(API 层) | B-1 范围,不在本切片 | 同上 | 判据 B API 层格 | 同上 |
| **B(徽标层)** | **本切片** | `apps/web/tests/approvalNavTodoBadge.spec.ts` | `renders a discriminable unavailable state when the count read throws (mutation guard...)`、`... when the response carries a stubbed \`degraded: true\` flag ...`、`... when any source reports \`unavailable\`, even with a nonzero count ...`、`carries the label in the unavailable state's aria-label ...` | `apps/web/scripts/run-required-web-tests.sh`(令牌 `approvalNavTodoBadge`,**required 检查 `web-tests`**,见 §5) |
| **B(中心页层)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `renders "checked, nothing pending" for an ok source with zero items — NOT the same shape as unavailable`、`renders "could not check" for an unavailable source — NOT the same shape as ok+0`、`mutation guard: a response with an unavailable source among ok sources must still render that source's own unavailable group (...)`、`renders a page-level load-failed state (...)` | 同上(`TodoCenterView` 令牌,同一 required 检查) |
| **B(推送同源)** | **本切片(修复轮 1 后)** | `packages/core-backend/tests/unit/todo-realtime.test.ts`、`packages/core-backend/tests/unit/approval-todo-counts-dual-publish-wiring.test.ts` | `the DEFAULT path (no injected fetcher) calls pendingSourceRegistry.countPendingForUser ...`(生产默认路径本身)、`reuses the injected countPendingForUser fetcher ...`(消费给定 fetcher 的形状,原有)、`fires todo:counts-updated for the SAME uniqueUsers set as approval:counts-updated, on every call`(触发接线) | `packages/core-backend` 默认单测(无需真库);**required 检查 `test (20.x)`**(§10 用 JSON reporter 机核两个文件均在其内) |
| C | B-1 范围,不在本切片 | `todo-center-pending-gate.ts` | 判据 C 两条 mutation | 真库 lane |
| D | B-1 范围,不在本切片 | 同上 | 判据 D | 同上 |
| **C′(前端呈现)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `renders a view-only pill for actionable:false, and no pill when actionable is absent or true` | `run-required-web-tests.sh`,required |
| C′(判定本身) | B-1 范围,不在本切片 | 同上(后端) | `resolveCanDecideCurrentNode` 相关 | 真库/单测 lane |
| **E(徽标)** | **本切片** | `apps/web/tests/approvalNavTodoBadge.spec.ts` | `E1 (principal swap, session present): ...`、`E2 (sign-out, no session): ...`、`E3 (sign-out): a push arriving on the still-open socket after sign-out must not repaint` | `run-required-web-tests.sh`,required |
| **E(中心页)** | **本切片** | `apps/web/tests/TodoCenterView.spec.ts` | `E1 (principal swap, session present): ...`、`E2 (sign-out, no session): ...`、`a push landing on the still-open socket after a CONFIRMED sign-out must not issue a new read (mirrors the badge's E3)` | `run-required-web-tests.sh`,required |
| **E(换 org 接线事实)** | **本切片** | `apps/web/tests/useAuth.spec.ts` | `fires the auth-principal-change notification synchronously on a successful org switch, storage already updated` | `run-required-web-tests.sh`**第 477 行**(见下方附注——**不是**本切片改的那段 exec 行),required |
| F(无新表) | B-1/本切片共同满足(本切片未新增迁移) | — | `git diff --stat` 对 `packages/core-backend/src/db/migrations` 为空 | — |

附注(`B(推送同源)` 行,修复轮 1 的撤回,20260918):本行原先只列
`'reuses the injected countPendingForUser fetcher ...'` 一条用例,并把它写成「验证判据 B 推送同源」的
唯一证据。独立门审 `impl-gate-B2-round1-20260918.md`(P1-1)指出该用例**注入了** `countPendingForUser`,
从未执行生产唯一走的 `defaultCountPendingForUser` 分支,对「生产默认 = 共享注册表方法」这条断言
**零判别力**(亲跑 mutation:把默认路径换成已知发散实现,该用例连同整个 required `test (20.x)`
默认套件全绿)。**同一份 mutation 结论也证伪了 §4.4 原结论**「本切片改动里唯一验证『推送不重新发明
谓词』的单测……」——那句话把「在 required 收集范围内」和「对该不变量有判别力」混为一谈,已作废(§4.4
正文同步更正,不留原句)。修复轮 1 新增两条用例(见上方表格新行、§10)补上生产默认路径与
`routes/approvals.ts` 触发接线两处此前零覆盖的分支,本行更新为反映这两条新用例。旧用例本身没有错
(它证明的「消费给定 fetcher」这件事仍然成立),错的是**用它论证了一件它证明不了的事**。

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

### 4.1 本切片新增的 6 个 path 条目在两块里逐字一致(邻域 diff)

**标题更正(P3 卫生轮,round-2 门审 `impl-gate-B2-round2-20260918.md` P3-1)**:原标题「`paths:`
两块字面相同」按全块口径读是假的——下面的证据只是两个 26 行邻域的 `diff`,从未断言整份
`pull_request.paths` 与 `push.paths` 逐字相等。标题已改窄到与证据同口径,不留误导旧句。

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

**独立观察(先存不对称,与本切片零关系,本轮对当前 HEAD 重新机核,不转抄门审在其审计 head 上算出的
条目):**`impl-gate-B2-round2-20260918.md` P3-1 的证据段列了 12 个「只在 block1、不在 block2」的
条目;对**当前 HEAD** 用脚本重新按 set 比较两块的全部条目(而非只读 26 行邻域),结果不是 12 条:

```python
# 解析 on.pull_request.paths(:20 起)与 on.push.paths(:437 起)两个列表,逐条比较集合
block1 count: 267   block2 count: 255   ordered identical: False
only in block1, not block2: 6
  apps/web/src/approvals/newTodoPill.ts
  apps/web/src/approvals/urgeButtonState.ts
  apps/web/src/approvals/routePreviewErrors.ts
  apps/web/src/approvals/routePreviewController.ts
  apps/web/src/approvals/routePreviewSummary.ts
  apps/web/src/approvals/templateGalleryFilter.ts
only in block2, not block1: 0
```
逐一 `grep -n` 复核门审列出的另外 6 条(`amountInWords.ts`、`conditionSummary.ts`、`formDraft.ts`、
`views/approval/ApprovalCenterView.vue`、`views/approval/TemplateCenterView.vue`、
`tests/approvalApiErrorSurfacing.spec.ts`)——它们在**两块里各自出现至少一次**(例如
`TemplateCenterView.vue` 在 block1 内 `:76`/`:83` 两处、block2 内 `:472` 一处;三处字节级 `od -c`
比对确认同一字符串,非近似匹配),不满足「只在 block1」。这 6 条从门审报告的 12 条清单里退出,不是因
为它们不曾不对称,而是当前 HEAD 上就是对称的——不推断中间是哪次改动补齐的(与本切片改动的
diff 面为空,`git diff --name-only <base>...HEAD -- .github/workflows/approval-web-guard.yml`
零命中,不是本切片补的)。剩下真正不对称的 6 条与门审报告一致方向(均为「只在 pull_request、不在
push」),同样是 B-1 头就已存在、与本切片零关系的先存状态,`approval-web-guard` 本身是 advisory 而
非 required(§14.6/§5 已核)。**不转抄门审报告的 12 条清单入本 MD**,只记这条独立机核的 6 条,避免
把外部报告在其审计 head 上的快照当成当前 HEAD 的事实。

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

**更正(修复轮 3,20260918,门审 `impl-gate-B2-round1-20260918.md` P3-2 独立指出同一处)**:上一段
「不改动该行……改 YAML 不在本次任务范围」这一决定,在修复轮 3 已不再成立——§12.1 把这句「no
duplicates」按字面为假的措辞改写掉了(不是去掉三组字面重复本身,那仍是本段说的「后续清理项」,未
做)。这里保留原段落是记录原始决定的时间点,不代表现在仍然「未改」。

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
真库用例)。

**撤回(gate `impl-gate-B2-round1-20260918.md` P2-1,修复轮 1,20260918)**:上一段末句「本切片改动里
唯一验证『推送不重新发明谓词』的单测,落在 required 检查『收集范围内』」把两件事混成了一件——「在
`test (20.x)` 的收集范围内被执行」(前半句,机核为真)不等于「对『推送不重新发明谓词』这条不变量有
判别力」(后半句,机核为**假**:门审对该单测唯一的用例做 mutation,让默认路径改读已知发散实现,
required 套件全绿)。原句已作废,不保留在本文档任何位置。

修复轮 1 补上生产默认路径与触发接线两处此前零覆盖的分支(设计 MD §5.2 撤回段、本文档 §10),两条
新用例同样用 JSON reporter 机核落在 `test (20.x)` 的默认收集范围内:
```
$ cd packages/core-backend && CI=true npx vitest run --reporter=json --outputFile=/tmp/core-backend-full-run-clean.json
$ python3 -c "
import json
d = json.load(open('/tmp/core-backend-full-run-clean.json'))
print(d['numTotalTestSuites'], d['numPassedTestSuites'], d['numFailedTestSuites'])
print([(r['name'], r['status']) for r in d['testResults'] if 'todo-realtime' in r['name'] or 'approval-todo-counts-dual-publish' in r['name']])
"
3914 3914 0
[('.../tests/unit/approval-todo-counts-dual-publish-wiring.test.ts', 'passed'), ('.../tests/unit/todo-realtime.test.ts', 'passed')]
```
「在收集范围内」这半句因此对两个文件都成立(机核);「有判别力」这半句现在由 §10 的两条 mutation
(对新用例本身亲跑、非对整个套件推断)单独支撑——composition,不是同一份证据两次使用。

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

## 10. 修复轮 1(20260918)—— 关闭 P1-1 生产路径/接线零覆盖 + P2-1 过强声明

被审 head(gate `impl-gate-B2-round1-20260918.md`):`396cd9b9238d78fe0f9ef6b189113ef98127a84e`。本节
是该 head 之上新增的一次提交,不改写上面 §1–§9(它们记录的是 `396cd9b92` 那一刻的状态);§1/§4.4 里
两处直接相关的过强断言已就地加撤回段(不删旧文字)。本节选取门审十项发现(1 P1 + 1 P2 + 8 P3)里的 P1-1 与 P2-1 两条
(其余八条 P3 未处理,留给下一轮或 owner 排期)。

### 10.1 改了什么(仅两处,均 additive)

1. `packages/core-backend/src/routes/approvals.ts`:私有函数 `publishApprovalCountsForUsers` 加
   `export`(纯加法,零行为变化——函数体一字未改),附注释说明导出理由(镜像既有 `isPlmApprovalId`
   的导出注释风格)。
2. 两个新增/改动的测试文件(无源码行为改动):
   - `packages/core-backend/tests/unit/todo-realtime.test.ts` 新增 1 条用例(原 5 条不动)。
   - `packages/core-backend/tests/unit/approval-todo-counts-dual-publish-wiring.test.ts`(新文件,2
     条用例)。

`git diff --stat 396cd9b92..HEAD -- packages/core-backend/src` 只命中这一处 `export` 关键字的增删;
`packages/core-backend/src/services/todo-realtime.ts` 零改动(P1-1 的建议修法本身就是「只加测试」,
不改生产代码——生产代码的问题不是逻辑错,是零覆盖)。

### 10.2 新用例覆盖什么、明确不覆盖什么(避免重犯 P2-1 的同类错误)

- `tests/unit/todo-realtime.test.ts` 新用例 `'the DEFAULT path (no injected fetcher) calls
  pendingSourceRegistry.countPendingForUser ...'`:**覆盖**——不注入 fetcher 时,
  `publishTodoCountsUpdate` 确实调用共享单例 `pendingSourceRegistry.countPendingForUser`(`vi.spyOn`
  打在单例方法本身,不是替身),并把其返回值原样转发进广播负载。**不覆盖**——`pendingSourceRegistry`
  内部聚合逻辑本身的正确性(那是 B-1 `PendingSourceRegistry`/`approval-pending-query.ts` 的判据
  A0/A/B/C/D,真库 lane 已闭合,见 `todo-center-phase1-verification-20260918.md`)。
- `tests/unit/approval-todo-counts-dual-publish-wiring.test.ts`:**覆盖**——`publishApprovalCountsForUsers`
  这一个函数的**自己的函数体**,对给定的 `uniqueUsers` 集合,确实同时调用了
  `publishApprovalCountsUpdate` 与 `publishTodoCountsUpdate`,且两者收到相同的 userId 集合、相同的
  `roles`、相同的 `reason`。**不覆盖、也不能证明**——八个路由调用点是否都真的调用了这个共享函数而不是
  绕开它另起一套;那半句论证仍然是设计 MD §5.1 的「按构造相等」(grep 八个调用点全部落在这一个函数
  名下,逐字核对过),本测试没有、也不需要重复它——两条论证互补,不是一条测试证了两件事。

### 10.3 Mutation 证据(cp 备份 → 改 → 单独跑新文件 → 观察红 → cp 还原 → `cmp`)

**Mutation 6(对应门审 M5)**——`src/services/todo-realtime.ts` 的 `defaultCountPendingForUser` 换成
门审点名的已知发散实现(`approval-realtime.ts` 的 `computeApprovalPendingCounts`):
```diff
-const defaultCountPendingForUser: TodoCountFetcher = (viewer) =>
-  pendingSourceRegistry.countPendingForUser(viewer)
+const defaultCountPendingForUser: TodoCountFetcher = async (viewer) => {
+  const { pool } = await import('../db/pg')
+  const { computeApprovalPendingCounts } = await import('./approval-realtime')
+  const query = pool!.query.bind(pool)
+  const { count } = await computeApprovalPendingCounts(query, {
+    userId: viewer.actorId, roles: viewer.roles, permissions: viewer.permissions,
+  })
+  return { count, sources: { approval: 'ok' } }
+}
```
```
$ npx vitest run tests/unit/todo-realtime.test.ts --reporter=dot
 Tests  1 failed | 5 passed (6)   ← 精确命中新用例;旧 5 条(全部注入 fetcher)照常绿,复现门审诊断
```
`cp` 还原,`cmp /tmp/todo-realtime.ts.bak src/services/todo-realtime.ts` 字节相同。

**Mutation 7(对应门审 M6)**——`src/routes/approvals.ts` 里 `publishApprovalCountsForUsers` 的
`Promise.all` 数组中,`publishTodoCountsUpdate({...})` 整个调用换成 `Promise.resolve()`:
```
$ npx vitest run tests/unit/approval-todo-counts-dual-publish-wiring.test.ts --reporter=verbose
 ✗ fires todo:counts-updated for the SAME uniqueUsers set ...
   → expected "spy" to be called 2 times, but got 0 times
 ✓ publishes nothing for an empty/blank-only user list ...
 Tests  1 failed | 1 passed (2)
```
`cp` 还原,`cmp /tmp/approvals.ts.bak src/routes/approvals.ts` 字节相同;还原后
`git diff packages/core-backend/src/routes/approvals.ts` 只剩 10.1 节那一处 `export` 加法。

**证据构成方式,如实说明**:上面两条 mutation 只对**新文件单独跑**,不是对 required 检查
`test (20.x)` 跑的那条整条命令(`pnpm --filter @metasheet/core-backend test`)本身做 mutation 后
重跑一次全量(那样成本更高,门审自己对 M5/M6 做过一次,见门审报告 §5)。本节的结论是**复合**得出的,
不是单独任何一步的结论:
1. 两条 mutation 分别让对应新用例单独跑时转红(上面逐字)。
2. §4.4 已用 JSON reporter 机核**未 mutation** 的两个文件都落在 `test (20.x)` 默认 `vitest run`
   的收集范围内(`3914 3914 0`,含两个文件名,均 `passed`)。
3. 由 1+2 可推:该 mutation 若发生在 `test (20.x)` 实际跑的那条命令上,会让同一个用例在同一条
   required 检查里转红——但这一步是**推论**,不是又跑了一次全量 mutation,如实标注。

### 10.4 因改了 `routes/approvals.ts` 而重跑的闸(门审 §7 项 4/5)

```
$ pnpm type-check                                        # 全仓,含 apps/web vue-tsc -b + 两个 verification tsconfig + core-backend tsc --noEmit
EXIT=0(core-backend: Done;apps/web: Done)
```
私有 DB `metasheet2_lock_b2`(处女库要求见门审 §7 项 5;本库既有、迁移已到最新,`db:migrate --list`
确认 `Pending: 0`,未重新 `createdb`,但改动前后 schema 本就未变,复用同一个已迁移到位的库对本项判据
零差异):
```
$ DATABASE_URL=postgresql://…/metasheet2_lock_b2 EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false \
  PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 passed (1) / Tests  27 passed (27)

$ … --config vitest.integration.config.ts run tests/integration/approval-wp3-pending-count.api.test.ts --reporter=verbose
 Test Files  1 passed (1) / Tests  7 passed (7)
```
两条真库套件在 `export` 关键字加入后一字不改地转绿,证明这次改动没有触碰共享查询路径。

门审 §7 项 6(令牌唯一性 + 两点接线)**不适用**:两个新/改动文件都在
`packages/core-backend/tests/unit/`,不在 `apps/web/tests/`,不经过 `run-required-web-tests.sh` 的
exec 行令牌匹配;机核确认它们的文件名不出现在任何闭世界注册表里:
```
$ grep -rn "approval-todo-counts-dual-publish-wiring\|tests/unit/todo-realtime" \
  packages/core-backend/vitest.config.ts .github/workflows/plugin-tests.yml
(无输出)
```

### 10.5 全套件重跑(门审 §7 项 1/2)

```
$ cd apps/web && npx vitest run approvalNavTodoBadge TodoCenterView todoApi todoCountsRealtime tests/App.spec.ts tests/useAuth.spec.ts --reporter=dot
 Test Files  6 passed (6) / Tests  89 passed (89)

$ cd packages/core-backend && npx vitest run --reporter=dot     # 默认 config,= required test (20.x) 跑的同一条,未 mutate
 Test Files  933 passed (933) | 175 skipped (1108)
      Tests  14720 passed (14720) | 1604 skipped (16324)
```
0 failed。附带关闭 §8 表「`apps/web` 全量 `vue-tsc -b` 类型检查」那一行的「未跑」状态——本轮
`pnpm type-check`(见 10.4)已覆盖全仓 `vue-tsc -b`,绿。

两条 mutation 各自 `cp` 备份 → 改 → 跑 → 还原,还原后逐一 `cmp` 确认字节相同(见 §10.3);两次
`cmp` 都不产生输出(相同)。还原后整个工作树的 `git status --porcelain` 只剩本轮**意图**改动的五个
路径,没有任何 mutation 残留:
```
$ git status --porcelain
 M docs/development/todo-center-phase2-fe-design-20260918.md
 M docs/development/todo-center-phase2-fe-verification-20260918.md
 M packages/core-backend/src/routes/approvals.ts
 M packages/core-backend/tests/unit/todo-realtime.test.ts
?? packages/core-backend/tests/unit/approval-todo-counts-dual-publish-wiring.test.ts
```
(`routes/approvals.ts` 的一行 ` M` 就是 10.1 节那一处 `export` 加法,不是 mutation 7 没还原干净——
mutation 7 的 `cmp` 已在 §10.3 单独确认过字节相同。)

### 10.6 本轮未处理(修复轮 2 已使这条部分过期,见 §11 开头的更正)

门审十项发现(1 P1 + 1 P2 + 8 P3)里的八条 P3(P3-1 已通过 10 节开头的更正部分处理;P3-2~P3-8 未动,留给下一轮或 owner
排期,如实列出,不在本轮声称交付)。**更正(修复轮 2,20260918)**:本行「P3-2~P3-8 未动」在 P3-4/P3-5/P3-6 三条上已不成立——见 §11。仍未动的是 P3-2/P3-3/P3-7/P3-8 四条(§11.4)。**再更正(修复轮 3,20260918)**:P3-2 与 P3-3 也已关闭——见 §12。仍未动的只剩 P3-7/P3-8 两条。

## 11. 修复轮 2(20260918)—— 关闭 P3-4、P3-5、P3-6

被审 head 与本节起点:`c31f928a6`(修复轮 1 的提交,已合入本分支)。本节选取门审十项发现里剩余八条 P3
中的三条:**P3-4**(`isTodoResponseDegraded`「徽标与中心页共用」的过强断言)、**P3-5**
(`resetSessionBootstrap`「4 处调用点」少算一处)、**P3-6**(中心页 `item.href` 交给 `router-link`
前零校验)。其余四条(P3-2/P3-3/P3-7/P3-8)本轮未动,见 §11.4。**更正(修复轮 3,20260918)**:
P3-2/P3-3 已在 §12 关闭;本段「其余四条」这句按「本轮(修复轮 2)」的时点仍然属实,不代表 P3-2/P3-3
现在仍未处理。

### 11.1 P3-6 —— `TodoCenterView.vue` 的 href 守卫(唯一有行为改动的一条)

**改了什么**:`apps/web/src/todo/views/TodoCenterView.vue` 新增组件本地(未导出)的
`isSameOriginRelativeHref(href): boolean` 谓词——要求 `href` 以单个 `/` 开头(非 `//`、非 `/\`),且
第一个 `/`/`?`/`#` 之前不含 URL scheme(如 `javascript:`、`https:`)。`applyResult()` 里对每个 item
计算一次 `navigable` 字段(不在模板里逐次重算);模板对 `!item.navigable` 的行渲染为不可点击的
`<span data-testid="todo-center-item-unlinkable">`(标题 + 判据 C′ pill 照常渲染),否则维持原有
`<router-link>`。命中时 `console.error` 一条,使异常可被发现而非静默吞掉。

**不是什么修复,如实澄清(避免重犯门审点名的过强声明同类错误)**:这**不是**开放重定向修复——
`router-link` 的 `:to` 把收到的字符串当**内部路由路径**用 `router.resolve` 解析,从不会让浏览器跳转
到任意 URL,所以站外/绝对地址本身进不了这条攻击面。真正的失效模式是**静默**:一个不是路由形状的
字符串会解析成 no-op 或损坏路由,该行看起来仍是可点击链接,点击却什么都不发生。锁 §4 字面(「点击
`href` 导航」)描述的是导航机制本身发生时的样子,没有规定「每一行必须渲染成链接」——所以本次选择的
修法是把不合法的行渲染成惰性文本,不是「阻止导航」。

**当前生产人口**:`approval-pending-source.ts:34-36`(`approvalItemHref`)今天只产出
`/approvals/<id>` 形状,天然合法——本条是防御性的,面向锁 §2「中心替换/推广该徽标」之后未来注册的
第二个来源,不是修一个已观测到的生产 bug(如实标注,不夸大紧迫性)。

**测试**(`apps/web/tests/TodoCenterView.spec.ts` 新增 1 条用例,文件本身已在
`run-required-web-tests.sh` 的令牌名单与 `approval-web-guard.yml` 两处 `paths:`/exec 行内——两点接线
不适用于本轮,未新增 spec 文件、未改该脚本):
```
$ cd apps/web && npx vitest run TodoCenterView --reporter=verbose
 ✓ ...renders a malformed (non-site-relative) href as an inert row, not a link that would silently fail to navigate
 Test Files  1 passed (1) / Tests  11 passed (11)
```
断言方式:对站外 URL / 协议相对 URL / `javascript:` 三种畸形 href,断言 stub `router-link` 自己的
标记属性 `data-router-link-to` 缺失(不是只查 `data-testid` 缺失——防止「留着 router-link、只删
testid」这类更弱的 mutant 逃过);同时断言合法的第四条 item 仍渲染出恰好一个
`data-router-link-to`。**测试能证明什么、不能证明什么,如实说明**:spec 里的 `router-link` 是
`mountView()`(`:93-98`)里的桩件——纯 `<a :href>`,不是真实 vue-router——所以这条用例证明的是「本组件
自己的谓词命中时确实不渲染 anchor」,**不能**证明真实 vue-router 在这类字符串上到底会不会解析成
no-op 路由;那半句仍是文件级注释里陈述的推理,不是本轮另跑真实 router 验证过的事实。

**Mutation(两个方向,`cp` 备份 → 改 → 单独跑该 spec 文件 → 观察 → `cp` 还原 → `cmp`)**:
- **方向 A(谓词失效,永远放行)**:`isSameOriginRelativeHref` 改成永远 `return true`。
  ```
  $ npx vitest run TodoCenterView --reporter=verbose
   × renders a malformed (non-site-relative) href as an inert row...
   Test Files  1 failed (1) / Tests  1 failed | 10 passed (11)
  ```
  精确命中新用例,其余十条(含正常 href 的用例)不受影响——`cp` 还原,`cmp` 字节相同。
- **方向 B(谓词过宽,永远拒绝)**——防止「谓词写得比命名场景窄但依然让新用例通过」这类假阳性
  (`feedback_fixture_shape_must_match_named_scenario`):`isSameOriginRelativeHref` 改成永远
  `return false`。
  ```
  $ npx vitest run TodoCenterView --reporter=verbose
   × renders an ok source's items, each linking to its href
   × renders a view-only pill for actionable:false, and no pill when actionable is absent or true
   × renders a malformed (non-site-relative) href as an inert row...
   Test Files  1 failed (1) / Tests  3 failed | 8 passed (11)
  ```
  两条**既有**(非本轮新增)用例连带转红,证明谓词不是「过宽到吞掉一切都能蒙混过关」——`cp` 还原,
  `cmp` 字节相同。
- 两次还原后 `git status --porcelain` 只剩本轮意图改动的四个路径(见 §11.5),无 mutation 残留。

**自我更正,推送前发现(同一提交范围内,不是另一轮门审指出的)**:`isSameOriginRelativeHref` 上方
的文档字符串曾写「it is not the shared `isTodoResponseDegraded`-style rule the badge and this page
both apply」——单独按这一行读(不看否定词前的完整上下文),它断言的是「badge 与本页共用该规则」,与
§11.2 在另外两处原地撤回的**同一条**过强声明字面矛盾,即便本句的原意是否定它。已改写为不含
「both apply」这类措辞:新句只说该谓词与 `isTodoResponseDegraded` 无关、后者只有 `ApprovalTodoBadge.vue`
一个调用方。

### 11.2 P3-4 —— `isTodoResponseDegraded`「徽标与中心页共用」的过强断言(两处文档字符串,均改)

**位置与事实**:`apps/web/src/todo/api.ts:60-65`(函数自身文档字符串)与
`apps/web/src/approvals/components/ApprovalTodoBadge.vue:35-37`(文件头 WHAT-IT-REUSES 段)都写着
「badge 和 center page 共用同一条规则」。机核:
```
$ grep -n "isTodoResponseDegraded\|from '\.\./api'" apps/web/src/todo/views/TodoCenterView.vue
132:import { getTodoItems, type PendingItem, type PendingSourceStatus, type TodoItemsResponse } from '../api'
```
`TodoCenterView.vue` 只导入三个类型和 `getTodoItems`,**不**导入这个函数,也不导入
`TodoCountResponse`;其自身的 `TodoItemsResponse` 没有 `degraded` 字段——两处「共用」断言均为假,
已在两处原地改写(不删旧结论所在段落,标注 CORRECTED + 本轮门审编号)。

**改写后的准确说法,避免走向另一个极端(「零关联」同样是过强声明)**:中心页确实实现了**同一条规则
的另一半**——它在 `applyResult()` 里把 `response.sources[source]` 逐源原样渲染成
`unavailable`/`ok` 两态,这正是 `isTodoResponseDegraded` 里「任一来源 unavailable ⇒ 视为不可信」
那一半判断,只是按来源展开而非折叠成一个布尔值(徽标渲染一个数字,需要一个布尔;中心页渲染分组,需要
按来源展开)。锁 §3「中心不得另造第二套判断」约束的是**规则本身不得分叉**,不是「每个调用点必须共用
同一个函数名」——中心页读的 `sources[source]` 与该函数读的 `sources` 是同一份数据、同一条语义,未
分叉。

本条为纯文档字符串改动,无行为变化,不新增测试(无可测的行为);`git diff` 只命中注释文本。

### 11.3 P3-5 —— `resetSessionBootstrap`「4 处调用点」少算一处

**位置**:`ApprovalTodoBadge.vue:66-67`(`TodoCenterView.vue` 对同一机制只写「见 badge 文件的文档
字符串」,未独立复述这个数字,因此只改了 badge 一处源码——门审报告原句「两个 .vue 的文档字符串」指的
是两个文件都在讨论这条机制,不是两个文件都各自复述了错误的「4」这个数字,已核对):
```
$ cd apps/web && grep -n 'resetSessionBootstrap(' src/composables/useAuth.ts
77:      resetSessionBootstrap(true, false, true)
123:function resetSessionBootstrap(clearUserSnapshot = false, clearTenantHint = false, preserveExplicitSession = false) {
234:    resetSessionBootstrap(false, false, true)
249:    resetSessionBootstrap(true, true, true)
301:    resetSessionBootstrap(true, false, true)
412:      resetSessionBootstrap(true)
```
6 处命中,1 处(`:123`)是函数自身声明,5 处是调用点。原文档字符串写「4 call sites: setToken,
clearToken, setExplicitSessionOrg, and the forced-relogin branch inside bootstrapSession」——漏掉
`:77`(`observeExplicitSessionStorage` 内的跨标签页 `storage` 事件监听器)。已原地改写为逐一点名
5 处 + 各自行号,并注明这条结论(该监听器调用的是同一个 `resetSessionBootstrap` → 同一个
`notifyAuthPrincipalChange()`,不改变本文件判据 E 已覆盖的结论)不受影响。纯文档字符串改动,无
行为变化,不新增测试。

### 11.4 本轮未处理

门审剩余 P3 里的四条本轮仍未动,如实列出(不在本轮声称交付):
- **P3-2**(`approval-web-guard.yml` 「no duplicates」断言按字面不成立):未改该 YAML 文件——改
  workflow 注释文本不在本轮选择的两条之内,留给下一轮或 owner 排期。
- **P3-3**(每个审批动作新增一次每用户查询、连接池压放大 +33% 的成本未记账):文档记账项,未落。
- **P3-7**(`todo:counts-updated` 房间/负载是否按 org 隔离未核):需要新的调查,未做。
- **P3-8**(导航入口的范围扩张自陈是否写进 PR body):PR body 撰写项,Draft PR 尚未开出,未做。

**更正(修复轮 3,20260918)**:上面四条里的 **P3-2** 与 **P3-3** 已关闭,见 §12——本节这两条 bullet
是修复轮 2 时点的如实记录,不代表现在的状态。仍未动的只剩 **P3-7**、**P3-8** 两条。

### 11.5 重跑的闸(本轮改动只在 apps/web,零后端 diff)

代码 diffstat 不含本 MD 自身(自指:这份文档的最终字节数只有写完本节之后才能知道,对自己取 diffstat
会引用一个还没定型的数字——与 P3-1 同一类陷阱,这里直接避免而不是估算),命令逐字粘贴,未重排列宽:
```
$ git diff --stat c31f928a6..HEAD -- apps/web
 .../src/approvals/components/ApprovalTodoBadge.vue | 22 +++++--
 apps/web/src/todo/api.ts                           | 21 +++++--
 apps/web/src/todo/views/TodoCenterView.vue         | 69 +++++++++++++++++++++-
 apps/web/tests/TodoCenterView.spec.ts              | 38 ++++++++++++
 4 files changed, 138 insertions(+), 12 deletions(-)
```
零 `packages/core-backend` 改动 ⇒ 本轮未重跑后端真库套件(§7 项 5),那些证据仍以修复轮 1 的重跑
为准(未受本轮影响,因为本轮没碰后端任何文件)。

```
$ cd apps/web && npx vitest run approvalNavTodoBadge TodoCenterView todoApi todoCountsRealtime tests/App.spec.ts tests/useAuth.spec.ts --reporter=dot
 Test Files  6 passed (6) / Tests  90 passed (90)     ← 89 → 90,恰好 +1(新用例)

$ cd apps/web && npx vitest run tests/useAuth.spec.ts tests/useSessionOrg.spec.ts tests/AttendanceSessionOrgSwitcher.spec.ts tests/useAttendanceSessionGuard.spec.ts --pool=forks --poolOptions.forks.singleFork=true --reporter=dot
 Test Files  4 passed (4) / Tests  63 passed (63)

$ pnpm type-check     # 全仓,含 apps/web vue-tsc -b + 两个 verification tsconfig + core-backend tsc --noEmit
EXIT=0(core-backend: Done;apps/web: Done)

$ sed -n '1006p' .github/workflows/approval-web-guard.yml | sed 's/^ *run: //' | bash -c "$(cat)"   # CI 步骤字面重跑
 Test Files  104 passed (104)
      Tests  1959 passed (1959)     ← 1958 → 1959,恰好 +1
```
两条 mutation(§11.1)各自 `cp` 备份 → 改 → 单独跑 `TodoCenterView` → 观察 → `cp` 还原 → `cmp` 字节
相同;还原后 `git status --porcelain` 只剩本轮四个意图改动路径:
```
$ git status --porcelain
 M apps/web/src/approvals/components/ApprovalTodoBadge.vue
 M apps/web/src/todo/api.ts
 M apps/web/src/todo/views/TodoCenterView.vue
 M apps/web/tests/TodoCenterView.spec.ts
```

## 12. 修复轮 3(20260918)—— 关闭 P3-2、P3-3

被审 head 与本节起点:`4e97acd92`(修复轮 2 的收尾提交,已合入本分支)。本节选取门审剩余四条 P3 中
的两条:**P3-2**(`approval-web-guard.yml` 「no duplicates」断言按字面不成立)、**P3-3**(每个审批
动作新增一次每用户查询、连接池占用 +33% 的成本未记账)。其余两条(P3-7/P3-8)本轮未动,见 §12.3。

### 12.1 P3-2 —— `approval-web-guard.yml` 的「no duplicates」过强断言(纯注释改动,零行为变化)

**先在当前 HEAD 重新机核,不转抄门审报告在旧 head 算出的数字**(该报告绑定的被审 head 是
`396cd9b92`,本条断言所在的注释块从那以后未被任何 fix round 碰过,但普查动作本身必须对当前 HEAD 重
做,不能假设行号/数字没变):

```
$ git grep -n "no duplicates" -- ':!*.md' | wc -l
32
```
32 处命中里,逐一读过标题行/上下文,**只有** `.github/workflows/approval-web-guard.yml`(改动前行号
`:999`)那一处讨论的是本切片新增的三个 token(`todoApi`/`TodoCenterView`/`todoCountsRealtime`)——
其余 31 处各自讨论别的、无关模块的去重不变量(分布在 `.ts`/`.mjs`/`.cjs`/`.sh` 多种文件里,不逐一列
文件形状,以免把「只有一处相关」这句机核结论绑到一份可能漏项的分类枚举上)。**只有一处**需要改。

**旁证:`run-required-web-tests.sh` 是否有第二处针对同三个 token 的「no duplicates」断言**——它在
`:1182` 有一句相邻的「... over all 490 parsed tokens (no duplicates) ...」,但读上下文(`:1178-1184`)
确认那是**另一个**、更早(`roleManagementSave`)token 加入时的时点快照,不覆盖之后追加的
`categoryCandidateInput`/`todoApi`/`TodoCenterView`/`todoCountsRealtime` 四个 token,不构成第二处
需要修的断言。对**当前 HEAD** 该 exec 行(`:1186`)重新机核(丢弃 `exec`/`npx`/`vitest`/`run`/
`--reporter=dot` 五个字面 token,不假设它们只出现在首尾——该行 `--reporter=dot` 之后仍有 4 个测试
名 positional):
```
token count (excl skip): 396   dupes: {}
substring collisions between the 4 newest tokens and the other 392: []
```
与门审 §4.4 在旧 head 上算出的「396/[]」逐字一致——这条文件里没有需要修的假断言。

**旁证:`approval-ci-coverage-enumeration.test.ts` 是否解析 `approval-web-guard.yml` 的内容/行号**
——机核该文件自己的文档字符串「W3(`approval-web-guard.yml`)deliberately NOT parsed」(`:60`),并
重跑确认本条改动没有让它转红:
```
$ cd packages/core-backend && npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts --reporter=dot
 Test Files  1 passed (1) / Tests  343 passed (343)
```

```python
# 对该 run: 行机械解析(split on whitespace,剥离 "pnpm … vitest run" 前缀与 "--reporter=dot" 后缀)
# 改动前:
token count: 106
literal duplicate pairs: {'approval-condition-summary': 2, 'approval-amount-in-words': 2, 'approval-form-draft': 2}
```
三对字面重复继承自更早轮次(不是本切片引入),`vitest run` 对同一个 positional 重复不会重跑两次(inert,
不是要另修的第二个 bug)。「no duplicates」按字面(整份 106-token 列表零重复)为**假**;唯一有判别力、
且仍然成立的断言是「三个新 token 互不为对方子串,也不是其余 103 个(含既有重复对)里任意一个的子串
或反过来」。

**改了什么**:把该注释里「106 after, no duplicates」改写为「106 after.」加一段独立的 CORRECTION,点名
门审编号 `impl-gate-B2-round1-20260918.md` P3-2,如实陈述上面这条事实,并保留、重申唯一成立的子串
唯一性断言。**只改注释,`run:` 那一行本身一个字符都没动**——避免「顺手把断言对象也改了」这类事故:

```
$ git diff --stat .github/workflows/approval-web-guard.yml
 .github/workflows/approval-web-guard.yml | 11 +++++++++--
$ git diff .github/workflows/approval-web-guard.yml | grep -E "^\+run:|^-run:"
(无输出 —— run: 行未被触碰)
```

**YAML 仍然合法**:
```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/approval-web-guard.yml')); print('YAML OK')"
YAML OK
```

**改动后用同一脚本对新行号重新机核**(证明本次只是纠正措辞、没有顺手改变实际列表):
```
line number of run: 1013   # 改动前 run: 行在 1006(注释块起点在 999);本条改动在注释块内新增 7 行,
                           # 使 run: 行下移到 1013,run: 行内容逐字未变
token count: 106
others count (raw, incl. pre-existing dupes): 103
substring collisions between new tokens and the other 103 (raw list): []
literal duplicate pairs in full 106-token list: {'approval-condition-summary': 2, 'approval-amount-in-words': 2, 'approval-form-draft': 2}
```
与改动前逐字段相同 —— 本条修的是**断言的措辞**,不是列表本身。

**测试,如实说明能证明什么、不能证明什么**:这是纯注释改动,没有可被 mutation 探针辨别的行为——本条
不发明一个对注释文本零判别力的假探针(呼应门审自己点名的 `feedback_ineffective_mutation_looks_like_a_useless_test`)。
证据集合是:(a) 上面的 `git diff --stat` + `grep "^+run:|^-run:"` 证明 `run:` 行字节未变;(b) YAML
parse 通过;(c) 改动前后用同一脚本逐字段核对列表本身未变。**不声称**的事:本轮**未**重跑
`approval-web-guard` 完整 104-file/1958-test lane(advisory,非 required;且上面(a)(c)已经比一次完整
重跑更直接地证明「没有动到实际执行内容,只动了旁边的注释」)。

### 12.2 P3-3 —— 每个审批动作新增一次每用户查询、连接池占用 +33% 的成本记账(纯文档改动,无代码变化)

**先重新核实门审报告点名的三处调用点在当前 HEAD 的行号**——门审绑定的 head 是 `396cd9b92`,修复轮 1
(`c31f928a6`)已经往 `routes/approvals.ts` 加了 9 行(`publishApprovalCountsForUsers` 的 `export` +
docblock),门审原引用的 `:2387`/`:2965`/`:3123` 在当前 HEAD 必然已经漂移,**不能照抄**:

```
$ grep -n "publishApprovalCountsForUsers\|client.query('COMMIT')\|client.release()" packages/core-backend/src/routes/approvals.ts
```
当前 HEAD 上,`COMMIT` 之后仍持有 `client`、直到稍后 `finally` 里才 `release()` 的三处调用点:
`:2394`(`COMMIT` 在 `:2391`,`release` 在 `:2416`)、`:2972`(`COMMIT` 在 `:2968`,`release` 在
`:2993`)、`:3130`(`COMMIT` 在 `:3126`,`release` 在 `:3151`)——与门审指出的同一类形状,只是行号因
修复轮 1 插入的 9 行而整体下移了约 7 行。

**查询数重新推导(读源码,不转抄门审报告的算术)**:
- `publishApprovalCountsUpdate` → `buildApprovalCountsUpdatedPayload`(`approval-realtime.ts:73-90`):
  `Promise.all` 并发 3 次 `computeApprovalPendingCounts`(`sourceSystem` 分别为 `all`/`platform`/
  `plm`)→ 3 条独立 SQL 往返。
- `publishTodoCountsUpdate` → `defaultCountPendingForUser` → `pendingSourceRegistry.countPendingForUser`
  → 当前唯一注册的 source(`approval-pending-source.ts`)的 `countPendingForUser` →
  `countApprovalPendingForViewer`(`approval-pending-query.ts:137-`)→ 1 条 SQL(含 `NOT EXISTS` 办理
  节点排除 + 已发布定义 join,即锁 §3 要求复用的那同一份共享谓词)。
- 因此 `publishApprovalCountsForUsers` 现在对每个 `uniqueUser` 并发发起 **3 + 1 = 4** 条查询(改动前
  是 3 条)——`(4-3)/3 ≈ +33.3%`,与门审的算术一致(本轮重新推导得出,不是转抄)。

**成本性质,如实说明**:这是设计锁 §4 明文要求的行为(「实时:复用按用户 room,发
`todo:counts-updated`」),属于 §9/§10.6 已判定的「在范围内的新增」,**不是**待修的 bug——本条记账关
闭的是「两份 MD 都没写这项成本」这个文档缺口,不是要撤销这条查询或声称已经优化它。

**未做的部分,如实列出(不在本轮声称交付)**:
- 未做负载测试,没有测过 +33% 这个比例在生产连接池水位下的真实影响。
- 若未来要收紧,候选方向:(a) 把 todo 的 1 条查询与 approval 的 3 条查询合并成同一次往返(目前是
  两个独立模块各自发起、互不知道对方);(b) 把 `todo:counts-updated` 的发布做成请求路径外的
  fire-and-forget 队列,而不是 `publishApprovalCountsForUsers` 的 `Promise.all` 的一部分。两者都不
  在本轮任务范围,留给 owner 或后续切片裁决。

本条为纯文档记账,`git diff` 只命中本 MD 自身,不涉及代码或 workflow 文件。

### 12.3 本轮仍未处理

- **P3-7**(`todo:counts-updated` 房间/负载是否按 org 隔离未核):需要读 `CollabService.buildAuthenticatedUserRoom`
  的房间键是否含 org、以及真实换 org 场景下的行为——本轮未做新的调查。
- **P3-8**(导航入口的范围扩张自陈是否写进 PR body):硬规矩本轮不开 PR,无法把这条写进一个尚不存在
  的 PR body。补一条待誊抄条款,供下一步真正开 Draft PR 时直接使用(本身**不构成**「已开 PR」或
  「已完成 P3-8」):

  > **PR body 待写条款(P3-8,门审 `impl-gate-B2-round1-20260918.md`)**:导航入口(commit
  > `4b3f8f483`,`App.vue:38,:52`)派生自设计锁 §2「前端壳」表最后第 2 行(「中心替换/推广该徽标」),
  > **不是**锁 §4 前端段的字面条款。理由:页面没有入口就不可达,派生合理,但这是本切片唯一一处超出
  > 锁 §4 字面范围的改动,如实点名,不在 diff 里悄悄带过。

### 12.4 重跑的闸

本轮零代码 diff,只改了两个文件:`.github/workflows/approval-web-guard.yml` 的一段注释(逐字见
§12.1,+9/-2)、以及本 MD 自身(逐字数字本节不引用——对自己取 diffstat 会引用一个还没定型的数字,同
`4e97acd92` 已修过的那个自指陷阱,这里直接避免而不是估算)。零 `apps/web`、零
`packages/core-backend` 代码文件改动 ⇒ 本轮不需要、也没有重跑 §7 项 1/2/3/5(前端
spec 组 / 后端默认 vitest / M5-M6 mutation / B-1 真库 project)——那些证据仍以此前各轮的重跑为准,未
受本轮影响。本轮实际执行、与本轮改动直接相关的检查:
```
$ pnpm type-check      # = pnpm -r type-check;apps/web 的 vue-tsc -b + 两个 verification tsconfig,core-backend 的 tsc --noEmit
EXIT=0
packages/core-backend type-check: Done
apps/web type-check: Done
```
```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/approval-web-guard.yml')); print('YAML OK')"
YAML OK
```
`git status --porcelain` 在本节两处改动写完后只剩本轮意图改动的两个路径,无 mutation 或探针残留(本
轮未做需要 `cp` 备份/还原的代码级 mutation——§12.1/§12.2 均为注释/文档改动,零可执行行为变化,理由见
各自小节)。

## 13. 修复轮 4(20260918)—— 关闭 P3-7;P3-8 处置(仍 blocked-with-reason,不构成新工作)

被审 head 与本节起点:`2081e0fa6`(修复轮 3 的收尾提交,已合入本分支)。门审剩余两条 P3 里,本轮**只
处理 P3-7**——它是唯一一条本轮能在「不开 PR、不动共享库、只在本 worktree 内」的硬规矩下实际推进的:
P3-7 是「未核实」,可以通过读代码+机核关闭;P3-8 是「PR body 待写条款」,在没有 PR 的情况下天然无法
再往前走一步(§12.3 已经把待誊抄的条款原样写好,本轮不重复劳动,只在下面 §13.4 确认它原样未变)。

### 13.1 P3-7 —— `todo:counts-updated` 的房间/负载是否按 org 隔离,机核结论

门审原文(`impl-gate-B2-round1-20260918.md` P3-7):「`todo:counts-updated` 的 room / 负载是否按 org
(而非仅按用户)隔离**未核**——设计 MD §4.4 与 §7-4 自陈。它决定『换 org 后旧 socket 上的迟到推送』这
条已知半闭合缺口的真实影响面。」`ApprovalTodoBadge.vue` 自己的文件级 docblock(本次会话读取时的行
`:148-151`)把它写成一句悬而未决的开放问题:「whether `todo:counts-updated`'s room/payload is even
scoped per-org ... has not been checked here — left as an open question ... not asserted either
way.」

本轮机核,逐层往下追,读代码而非猜测:

**第一层:房间键本身**
```
$ sed -n '8,10p' packages/core-backend/src/services/CollabService.ts
export function buildAuthenticatedUserRoom(userId: string): string {
  return `auth-user:${userId}`
}
$ grep -n "buildAuthenticatedUserRoom" packages/core-backend/src/services/CollabService.ts
8:export function buildAuthenticatedUserRoom(userId: string): string {
121:      socket.join(buildAuthenticatedUserRoom(userId))
```
房间键只含 `userId`,不含 tenant/org。`todo-realtime.ts:73` 与 `approval-realtime.ts:117` 都直接调用
这同一个函数——两条推送共用同一套按用户分房的规则,没有第二套按 org 分房的规则存在。

**第二层(比房间键更深,也是本条结论真正的落脚点):这条推送读的那份共享谓词本身有没有 tenant/org
维度**——房间只决定「谁能收到」,真正决定「换 org 后一条迟到推送是否描述了『错误的』数据」的是查询
本身是否会因 org 不同而产出不同的数:
```
$ grep -n "tenant\|org" packages/core-backend/src/services/approval-pending-query.ts
(无输出)
$ wc -l packages/core-backend/src/services/approval-pending-query.ts   # 正控:证明上面那条 grep 真的
256 packages/core-backend/src/services/approval-pending-query.ts       # 读到了文件,不是读空文件的假阴性
```
`approval-pending-query.ts`(`GET /api/todo/count`、`todo:counts-updated`、`GET
/api/approvals/pending-count`、`approval:counts-updated` 共用的唯一一份 SQL,256 行)里,**零处**引用
tenant/org。往上一层,喂给这份查询的 viewer 类型本身也不带 tenant 字段:
```
$ sed -n '30,37p' packages/core-backend/src/routes/todo.ts
function resolveTodoViewer(req: Request): PendingViewer | null {
  const actorId = resolveApprovalActorId(req)
  if (!actorId) return null
  return {
    actorId,
    roles: resolveApprovalActorRoles(req),
    permissions: resolveApprovalActorPermissions(req),
  }

$ grep -n "interface PendingViewer" -A4 packages/core-backend/src/services/pending-source-registry.ts
33:export interface PendingViewer {
34-  actorId: string
35-  roles: string[]
36-  permissions: string[]

$ sed -n '26,30p' packages/core-backend/src/services/approval-pending-source.ts
  return {
    actorId: viewer.actorId,
    roles: viewer.roles,
    permissions: viewer.permissions,
```
三处(`routes/todo.ts` 的 `resolveTodoViewer`、`pending-source-registry.ts` 的 `PendingViewer` 类型
定义、`approval-pending-source.ts` 的 `toApprovalPendingViewer`)构造/转换的 viewer 对象字面只有
`{ actorId, roles, permissions }` 三个字段——没有 tenant 字段可供任何一层去按 org 过滤,即使想加也
无处挂。

**第三层(佐证,非结论必需——见下面的边界说明):换 org 这一个端点本身会不会让 `roles`/`permissions`
变化**:
```
$ sed -n '1219,1240p' packages/core-backend/src/routes/auth.ts
```
`POST /auth/session-org`(`setExplicitSessionOrg` 对应的后端端点)的成功路径是:
```
const tokenUser = { ...user, tenantId: chosen }
const nextToken = authService.createToken(tokenUser, { sid: sessionId })
```
`user`(连同它当时的 `roles`/`permissions`)整体展开进新 `tokenUser`,只有 `tenantId` 字段被覆写——
**这一条端点本身**不重新计算这个用户的 `roles`/`permissions`。但这只证明「切这一刀不改」,不能单独
证明「roles/permissions 本来就不分 org」——如果 login 时的角色解析是按 tenant 查出来的,同一个人直
接登录 org B 拿到的角色集合仍可能与从 org A 切过去不同,第三层单独不能排除这种情况。

**因此补一条更底层、覆盖每一次请求(不只是切换的那一刻)的证据**——`req.user.roles`/`permissions`
到底是怎么算出来的,追到底:
```
$ sed -n '267p' packages/core-backend/src/auth/AuthService.ts
      const user = await this.getUserById(userId)
$ sed -n '570,577p' packages/core-backend/src/auth/AuthService.ts
        const result = await pool.query(
          `SELECT ${USER_AUTH_SELECT} FROM users WHERE id = $1`,
          [userId]
        )

        if (result.rows.length > 0) {
          const row = result.rows[0] as UserRow
          const resolved = await this.resolveRbacProfile(row.id, row.role, Array.isArray(row.permissions) ? row.permissions : [])
```
生产路径(`verifyToken` 每次请求都走)是 `getUserById(userId)` → 一条 `WHERE id = $1` 的全局
`users` 表查询(不带 tenant 条件)→ 结果喂给 `resolveRbacProfile(row.id, row.role, row.permissions)`:
```
$ grep -n "isRbacAdmin(userId\|listUserPermissions(userId" packages/core-backend/src/auth/AuthService.ts
741:      const admin = await isRbacAdmin(userId)
748:      permissions = await listUserPermissions(userId)
$ grep -n "^export async function isAdmin\|^export async function listUserPermissions" packages/core-backend/src/rbac/service.ts
19:export async function isAdmin(userId: string, runQuery: typeof query = query): Promise<boolean> {
74:export async function listUserPermissions(userId: string): Promise<string[]> {
```
`resolveRbacProfile` 内部调的 `isRbacAdmin`/`listUserPermissions`(`rbac/service.ts` 里的
`isAdmin`/`listUserPermissions`)签名都只接受 `userId`(可选一个 `runQuery` 覆盖参数,与 tenant 无
关)——不是"这次切换恰好没变",而是**这条 RBAC 解析链路从函数签名开始就没有 tenant 参数可传**,对
每一次认证请求(不论 token 里的 `tenantId` 是什么)都成立,不依赖于"切换"这个具体动作。

**结论,基于第二层(充分)+ 上面这条 RBAC 解析证据(独立地把第三层的"仅证明这一个端点"补强成"对每
次请求都成立"),第三层原句本身不单独作为结论依据**:对同一个已登录用户,这份查询在换 org 前后产出
**同一个数字**——不是「碰巧现在两个 org 恰好相等」,而是(a)第二层已经证明查询本身、以及喂给它的
viewer 类型,都不消费 org/tenant,单凭这一条就足以让结论成立而不依赖角色是否变化;(b)角色/权限的
解析链路(`getUserById` → `resolveRbacProfile` → `isRbacAdmin`/`listUserPermissions`)本身也没有
tenant 参数可传,进一步确认不存在「按 org 变化的角色集合」这个中间变量。因此:一条在换 org 之后落在
仍然打开着的旧 socket 上的迟到推送,并**不是**「描述了另一个 org 的数据」——它描述的是与换 org 后立
刻发起的一次 REST 重读会算出的**同一个**org-invariant 数字。门审 P3-7 问的「房间/负载是否已按 org
隔离」这个问题本身预设了「数字会随 org 变化」,而机核结果是这个预设不成立,所以问题在这份实现里没
有第二种答案要去区分——房间不按 org 分,是因为数字本来就不按 org 分。

**如实框定这条结论的边界,不过度声称**:
- **不是新引入的行为,也不是本切片能单方面改的**:`approval:counts-updated`(`approval-realtime.ts`)
  读同一份查询、走同一个 `buildAuthenticatedUserRoom`,这个「待办/审批数量不分 org、跨用户所有 org
  汇总」的特征是平台既有行为,B-2 原样继承,没有让它变得更宽或更窄。
- **这不等于「换 org 半边的 socket 重连缺口已关闭」**——docblock 里紧邻这段之前的那一条(「the socket
  itself is never reconnected ... a separate, larger unit than this commit」)是一个不同的问题(连接
  用哪个 token 认证),本轮结论不触碰它,也没有让它变得不重要:如果未来这份查询真的加上了 tenant 过
  滤,重连缺口会从「无害」变回「有害」,那时候需要重新审视,不能引用本轮结论当作那条也已关闭的证据。
- **不代表「待办数量应该按 org 隔离」是错误设计**——这是一个产品问题,不是本条门审发现要回答的问题;
  本轮只回答「今天的实现是否按 org 隔离」(否),不回答「今天的实现该不该按 org 隔离」。

**改了什么**:`apps/web/src/approvals/components/ApprovalTodoBadge.vue` 文件级 docblock 末段——把
「has not been checked here — left as an open question ... not asserted either way」替换为上面三层
证据的浓缩版(含 grep 命令、行号、结论边界),同时明确保留紧邻的 socket 重连缺口段落原文不动(不同问
题,不应被本轮结论覆盖或误读为已解决)。`TodoCenterView.vue` 的对应段落(`ORG-SWITCH HALF`,
`:126-140`)本身没有重复「room/payload 是否按 org」这句断言——它只是指向 `ApprovalTodoBadge.vue`
「the badge's documented gap」,本轮机核之后那个被指向的位置已经更新,不需要在 `TodoCenterView.vue`
里另外改一份重复的文字。`todo-center-phase2-fe-design-20260918.md`(设计 MD)不改——遵循修复轮 2/3
已确立的惯例(设计 MD 是撰写当时的快照,后续修复轮只更新本验证 MD 和被点名的源码 docblock,不回填设
计 MD)。

**本轮内的一次自我复核,收窄第三层的范围**:第一版把第三层写成「换 org 这个动作本身不会重新计算
`roles`/`permissions`,所以……对每个 org 都相同」——这一步跳跃本身不成立:`session-org` 这一个端点
不重算,只证明「切这一刀不改」,不能单独排除「login 时角色本来就按 tenant 解析」的可能性(若如此,
直接登录另一个 org 拿到的角色集合可以与从另一个 org 切过去不同,第三层原句就覆盖不到这种情况)。补
一条更底层的证据后收窄了表述:结论现在基于第二层(查询本身零 tenant 引用,单凭这一条已经充分,不依
赖角色是否变化)+ 补充的 RBAC 解析链路证据(`isAdmin`/`listUserPermissions` 签名只接受 `userId`,
对每一次认证请求都成立,不只是切换那一刻),第三层原句降级为「佐证」而非结论单独的依据。同一遍复核
也发现「没有任何一层……token 铸造引用 org/tenant」这句括注不成立(`session-org` 明明把 `tenantId`
写进了新 token,`jwt-middleware.ts:101-108` 也确实读它)——已从结论段落里删除该括注,改为
「(a)/(b)」两点式的、逐条可核对的表述,不再用一句笼统的「没有任何一层」去覆盖一个自己都没验证到底
的清单。

### 13.2 测试与类型检查(本条是纯 docblock 改动,零行为变化)

零可执行行为改变——`ApprovalTodoBadge.vue` 只有注释文本变化,`<script setup>` 的可执行部分、
`<template>`、`<style>` 逐字未动:
```
$ git diff 2081e0fa6 -- apps/web/src/approvals/components/ApprovalTodoBadge.vue | grep -E "^[+-]" | grep -vE "^[+-]//|^\+\+\+|^---"
(无输出 —— 对本轮起点 2081e0fa6 比较,每一行非 diff-header 的改动都以 // 开头,零非注释行改动)
```
因此本条同样不发明一个对注释文本零判别力的假 mutation 探针(同 §12.1 的既定判断)。重跑受影响的前端
spec(证明改动没有破坏解析或引入语法错误)与 typecheck:
```
$ cd apps/web && npx vitest run approvalNavTodoBadge TodoCenterView --reporter=dot
 Test Files  2 passed (2)
      Tests  34 passed (34)

$ pnpm --filter @metasheet/web type-check
EXIT=0   # vue-tsc -b + 两个 verification tsconfig,均无输出即通过
```

### 13.3 越界检查

```
$ git diff 2081e0fa6 --stat -- apps/web/src/approvals/components/ApprovalTodoBadge.vue   # 对本轮起点
 .../src/approvals/components/ApprovalTodoBadge.vue | 44 ++++++++++++++++++++--
 1 file changed, 40 insertions(+), 4 deletions(-)
```
(与本轮起点 `2081e0fa6` 比较,不是与上一次提交比较——本条 docblock 在本轮内被 advisor 复核后又收窄
过一次表述,单看"相对上一次提交"的 diff 会漏掉第一次改动的那部分,只对同一个人误导性地更小。本 MD
自身的追加不计入该条 diffstat——对自己取 diffstat 会引用一个还没定型的数字,同 `4e97acd92` 已修过的
自指陷阱,§12.3 已用过同一处理方式,这里延续。)
只碰了门审 P3-7 点名的那一份 docblock 与本验证 MD;零 `packages/core-backend` 改动,零迁移,零锁文,
零 workflow 文件改动。

### 13.4 P3-8 处置(如实记录:blocked-with-reason,非本轮遗漏)

P3-8(「导航入口的范围扩张自陈需要写进 PR body」)在修复轮 3(§12.3)已经把待誊抄的条款原样写好并
点名了它的性质——**这本身就是在硬规矩(本轮及此前所有修复轮都不开 PR)下这条能做到的全部**:没有
PR,就没有 PR body 可以真正把这段话写进去;提前在源码或本 MD 里"标记为已完成"反而会造成"这条已经
处理"的假象。本轮确认 §12.3 那段待誊抄文本原样未变(`git diff` 对 §12.3 所在行范围为空,只在文件末
尾追加了本 §13),不重复劳动,也不因为"看起来简单"就换一种方式提前把它写掉。

**两条门审 P3 项的最终状态,截至本轮**:P3-7 CLOSED(§13.1,证据完整、docblock 已更正);P3-8
BLOCKED-WITH-REASON(待开 PR,非代码/文档缺口,不可在当前硬规矩下继续推进)。至此,门审
`impl-gate-B2-round1-20260918.md` 点名的 1 P1 + 1 P2 + 8 P3 共 10 条,除 P3-8 外的 9 条均已在修复轮
1-4 里逐条关闭。

## 14. 开 PR 前 required 复现(2026-09-18)

在为本分支开 Draft PR 之前,逐字复现 required 检查(feedback_ci_green_means_run_ci_steps.md 纪律:
照 CI 实际跑的命令跑,不臆测)。三条命令覆盖 repo-root type-check、`packages/core-backend` 全量
vitest、`apps/web` required web-tests 门(`apps/web/scripts/run-required-web-tests.sh`)。第三条命令
命中一条既有的 mechanical pattern census 守卫(`tests/approval-member-identity-coverage-enumeration.spec.ts`
TIER B),定位、修复、复跑的完整记录见 §14.2-§14.5。

### 14.1 三条命令与结果(修复前)

```
$ pnpm type-check
...
EXIT=0
```

```
$ cd packages/core-backend && CI=true npx vitest run --reporter=dot
 Test Files  933 passed | 175 skipped (1108)
      Tests  14720 passed | 1604 skipped (16324)
EXIT=0
```

```
$ cd apps/web && npx vitest run tests/approval-member-identity-coverage-enumeration.spec.ts
 ❯ tests/approval-member-identity-coverage-enumeration.spec.ts (16 tests | 1 failed)
   ❯ ... every raw-id-render pattern occurrence ... has an explicit ALLOWLIST triage entry ...
     → untriaged raw-id-render pattern hit(s) -- each needs an explicit ALLOWLIST entry (VALUES-FREE-FIXED or OUT-OF-SCOPE with a reason):
src/approvals/components/ApprovalTodoBadge.vue:153 [template-string-id-interp] // `auth-user:${userId}`, `CollabService.ts:8-10` — no tenant/org component). But the deeper
 Test Files  1 failed (1)
      Tests  1 failed | 15 passed (16)
```

`apps/web/scripts/run-required-web-tests.sh` 的最后一段 `exec npx vitest run ... approval-member-identity-coverage-enumeration ... --reporter=dot` 把这个 spec 的 basename 当作一个子串 token 收进同一条 vitest 调用;
用 `npx vitest run approval-member-identity-coverage-enumeration --reporter=dot`(该脚本用的 token 形状,不带路径/扩展名)单独跑,收集到的仍然只有这一个文件(`Test Files 1 ...(1)`),证明这条 token 在 apps/web 全树里唯一命中该 spec、没有子串碰撞——因此上面这条直接对 spec 文件路径的复现,与 required 脚本对这一个文件实际执行的内容逐字等价,不是近似替代。

### 14.2 命中原文与定位

失败断言的 diff 输出:

```
- Array []
+ Array [
+   "src/approvals/components/ApprovalTodoBadge.vue:153 [template-string-id-interp] // `auth-user:${userId}`, `CollabService.ts:8-10` — no tenant/org component). But the deeper",
+ ]
```

`src/approvals/components/ApprovalTodoBadge.vue:153` 修复前原文(纯注释,非渲染代码):

```
// per-user only, NOT per-org (`buildAuthenticatedUserRoom(userId)` returns the literal string
// `auth-user:${userId}`, `CollabService.ts:8-10` — no tenant/org component). But the deeper
```

这段注释是修复轮 4(§13.1)新写入的 docblock 段落,复述 `packages/core-backend/src/services/CollabService.ts:8-10` 的真实实现(已核对):

```
export function buildAuthenticatedUserRoom(userId: string): string {
  return `auth-user:${userId}`
}
```

TIER B 的 `template-string-id-interp` 模式(`tests/approval-member-identity-coverage-enumeration.spec.ts` 内
`PATTERNS` 数组)是一条对**每一行原始文本**的词法 grep(`\$\{[^}]*(\.id\b|Ids|\.ids\b|userId|roleId|deptId)[^}]*\}`),
该文件自己的 docstring(TIER B 段落)明确说明这是"single-LINE lexical grep",且该文件的 `ALLOWLIST`
分组里两次出现过完全同类的先例——`'a code COMMENT describing the historical pre-fix pattern in prose,
not a live code'`(约 L339)与 `'a COMMENT line describing the shared-panel template fallback ... prose,
not a render/assignment site; the scan does not strip comments'`(约 L552)——都是**已被显式登记为
OUT-OF-SCOPE 的注释命中**,不是该守卫要跳过注释扫描。也就是说,扫描器按设计不剥离注释:命中原因不
是 bug,是这条新写的 docblock 恰好用 `` `auth-user:${userId}` `` 这个反引号+`${}`的写法转述了源码里
真实存在的模板字符串插值,字面撞上了这条模式。

### 14.3 处置:选 (a),重写注释而非登记 ALLOWLIST

任务给出的二选一里选了 **(a)——重写这一行注释,保留原意但不再出现 `${...}` 插值形态**,没有选 (b)
(加一条 OUT-OF-SCOPE 条目)。理由:(a) 是更小的改动面——不用碰这份对 ALLOWLIST 陈旧性有专门断言
(`every ALLOWLIST entry still appears in its file`)的守卫文件本身,不给这份已经有 500+ 行的 ALLOWLIST
再添一条需要长期维护的登记项;这行注释要表达的事实(`buildAuthenticatedUserRoom` 返回的房间名没有
tenant/org 分量)在不使用模板字面量记号的前提下同样能准确转述,不存在"必须用 `${}` 形态才说得清楚"
的情况——不像 §14.2 提到的两条先例(它们是在转述"历史上出现过的" 或 "别的文件里现存的" 真实代码写
法,原样引用是论证本身的一部分);这里没有这种约束,纯属可换写法。因此按任务指示的优先级选 (a)。

改动(仅这一处,`apps/web/src/approvals/components/ApprovalTodoBadge.vue:152-153`):

```diff
-// per-user only, NOT per-org (`buildAuthenticatedUserRoom(userId)` returns the literal string
-// `auth-user:${userId}`, `CollabService.ts:8-10` — no tenant/org component). But the deeper
+// per-user only, NOT per-org (`buildAuthenticatedUserRoom(userId)` returns the room name
+// "auth-user:" followed by the raw userId, `CollabService.ts:8-10` — no tenant/org component). But the deeper
```

含义未变(仍然是:房间名 = 字面量前缀 `auth-user:` 拼上原始 `userId`,没有 tenant/org 分量,指向
`CollabService.ts:8-10`);只是把"贴一段带 `${}` 的模板字面量语法"换成了"用文字描述同一件事",不再
落入 `template-string-id-interp` 的词法形状。

### 14.4 复跑结果

```
$ cd apps/web && npx vitest run tests/approval-member-identity-coverage-enumeration.spec.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
EXIT=0
```

```
$ pnpm type-check
EXIT=0   # vue-tsc -b + 两个 verification tsconfig + core-backend tsc,均无输出即通过
```

```
$ cd packages/core-backend && CI=true npx vitest run --reporter=dot
 Test Files  933 passed | 175 skipped (1108)
      Tests  14720 passed | 1604 skipped (16324)
EXIT=0
```

（三条命令与 §14.1 修复前逐字同源;前两条数字与修复前一致——本条改动零可执行行为,前端/后端两侧
本就不该因为一处注释重写而变化;第三条 web spec 从 1 failed/15 passed 转为 16 passed。）

### 14.5 同形态注释普查 + 越界检查

按本切片(与 `origin/main` 的合并基 `89f1ecdee2c3b70205a318074824c834bc6a5c7e` 相比)改动的全部
`.vue`/`.ts` 文件,逐个 grep 是否还有别的注释里出现同样"`${...Id}`/`${...id}`"的模板插值形态：

```
$ git diff --name-only 89f1ecdee2c3b70205a318074824c834bc6a5c7e..HEAD -- '*.vue' '*.ts'
apps/web/src/App.vue
apps/web/src/approvals/components/ApprovalTodoBadge.vue
apps/web/src/router/appRoutes.ts
apps/web/src/todo/api.ts
apps/web/src/todo/useTodoCountsRealtime.ts
apps/web/src/todo/views/TodoCenterView.vue
apps/web/tests/App.spec.ts
apps/web/tests/TodoCenterView.spec.ts
apps/web/tests/approvalNavTodoBadge.spec.ts
apps/web/tests/todoApi.spec.ts
apps/web/tests/todoCountsRealtime.spec.ts
apps/web/tests/useAuth.spec.ts
packages/core-backend/src/index.ts
packages/core-backend/src/routes/approvals.ts
packages/core-backend/src/routes/todo.ts
packages/core-backend/src/services/approval-pending-query.ts
packages/core-backend/src/services/approval-pending-source.ts
packages/core-backend/src/services/pending-source-registry.ts
packages/core-backend/src/services/todo-realtime.ts
packages/core-backend/tests/todo-center-pending-gate/setup.ts
packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts
packages/core-backend/tests/unit/approval-todo-counts-dual-publish-wiring.test.ts
packages/core-backend/tests/unit/todo-realtime.test.ts
packages/core-backend/vitest.config.ts
packages/core-backend/vitest.todo-center-pending-gate.config.ts

$ for f in <上面 24 个文件>; do command grep -nE '\$\{[a-zA-Z]*[iI]d\}' "$f"; done
(无输出 —— 修复后的 ApprovalTodoBadge.vue 本身也不再命中,零其它文件命中)
```

零其它命中——本切片改动的文件里,`${...Id}`/`${...id}` 这个插值形态只出现过 §14.2 那一处,已按
§14.3 处置。不需要额外改动。

越界检查(只应改了这一行注释 + 本 MD 追加的这一节):

```
$ git diff --stat
 apps/web/src/approvals/components/ApprovalTodoBadge.vue | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
```

（对源码文件的 diffstat;本 MD 自身这次追加的 §14 不计入——同 §12.3/§13.3 已用过的处理方式,对
一份还在追加中的文档取自己的 diffstat会引用一个还没定型的数字。）源码侧 diff 的两处 `+`/`-` 都以
`//` 开头,零非注释行改动,零 `packages/core-backend` 改动,零迁移,零锁文,零 workflow 文件改动,
未触碰 `tests/approval-member-identity-coverage-enumeration.spec.ts` 本身(守卫的扫描逻辑与 ALLOWLIST
均未改动,符合任务"不得改守卫的扫描逻辑"的约束)。

## 15. P3 卫生轮(2026-09-19)—— 门审 `impl-gate-B2-round2-20260918.md` 5 条 P3 逐条处置

被审 head `d84e9e7fb`(§0)之后,本分支先执行了一次栈底同步:`git rebase
origin/feat/todo-center-shared-pending-query`——该分支在合并基 `89f1ecdee`(与本分支共同祖先)之后
只新增了 3 条真正的新内容提交(用 `git patch-id` 双向比对确认,其余约 40 条本分支已有等价内容的提交
被 rebase 自动 `skipped previously applied commit`),rebase 零冲突。落地前后做过一次机械验证:
`git diff <rebase 前 HEAD> <rebase 后 HEAD> --stat` 只显示两个文件的变化
（`docs/development/todo-center-phase1-verification-20260918.md` 与
`packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts`,均为 B-1 侧
round-3 门审的 P3 收口,不是本切片的文件),与那 3 条提交各自的 `--stat` 逐字相加吻合,证明 rebase
没有引入或丢失任何本切片文件的改动。rebase 后 `git push --force-with-lease` 一次(本轮唯一一次,已
用完),新 HEAD 记为 `be2467ca656234ee19603fcd23f63f8788f92995`——本节全部诊断、mutation 重跑与
diffstat 起点均以它为基准,不是被审 head。

**一条如实记录、不修的先存状态**:`git diff origin/feat/todo-center-shared-pending-query...HEAD`
（本 PR 的 diff base)目前包含约 26 个与本切片零关系的 `main` 提交(data-sources / multitable /
stock-prep / security 等)——这是 rebase **之前**就存在的状态(本分支的 merge-base 是 main 较新的
`bb77ca5f2`,而 base 分支仍停在较旧的 `89f1ecdee`),rebase 没有让它变得更宽,反而通过 patch-id 去重
让"两条分支各自独立重放同一批 B-1 提交"的冗余缩小了。修正它需要 force-push **base 分支**
（`feat/todo-center-shared-pending-query`),那是另一条 lane 的分支,本轮硬规矩不允许,如实记录为
已知状态,交给整理 PR base / 出栈顺序的那一步处理。

### 15.1 处置表

| # | 门审原文(一句) | 处置 |
|---|---|---|
| P3-1 | 验证 MD §4.1 标题「`paths:` 两块字面相同」按全块口径为假(先存不对称,非本切片引入) | CLOSED-MD |
| P3-2 | 8 个调用点删任意一个 ⇒ required 默认套件仍全绿(已被实现者显式自陈;真实风险很低) | 验证-无需改动(门审自身已判定风险可接受、不要求新增;本轮零编辑,只核实既有 docblock 自陈仍与当前 HEAD 一致) |
| P3-3 | 上一轮门审报告 §4.4 把 `approvalNavTodoBadge` 的 lane 归错行(报告自身的错,非交付物的错) | CLOSED-MD(交付物本无此错,已核;补前瞻指引防未来转抄) |
| P3-4 | P3-8(PR body 自陈导航入口范围扩张)仍 BLOCKED-WITH-REASON | DEFERRED-owner 项(硬规矩禁止本 lane 动 PR body) |
| P3-5a | `approval-web-guard.yml` 106-token 全量重跑——本轮未跑 | CLOSED-测试(本轮实际执行) |
| P3-5b | 真浏览器视觉验收——未跑,jsdom 不算 | DEFERRED-owner 项(需要真实浏览器验收基础设施投入) |
| P3-5c | 徽标侧 E3(`acceptPushes`)与「订阅错事件」两条 mutation——本轮未重跑,沿用上一轮红 | CLOSED-测试(本轮亲跑转红) |

**附带一条(卫生轮过程中发现,不在门审 5 条之列,但同属"改矛盾措辞"范畴)**:`approvalNavTodoBadge.spec.ts`
E3 用例的注释写「deleting `handleCountsUpdated`'s `if (!hasSession()) return`」,但该函数体内并不
调用 `hasSession()`(真正的守卫是 `acceptPushes` 标志,由认证切换监听器的延迟检查设置)——这条注释
描述的是重构前的旧实现。已改写为准确描述,disposition 记为 CLOSED-注释。

### 15.2 P3-1 —— 见 §4.1(已在原地更正标题 + 补独立观察,不在此重复)

标题从「`paths:` 两块字面相同」改为「本切片新增的 6 个 path 条目在两块里逐字一致(邻域 diff)」,并
用脚本对**当前 HEAD**重新做集合级比较(不是门审报告审计 head 上的 12 条清单转抄),发现真正「只在
block1、不在 block2」的只有 6 条,另外 6 条(门审报告列的 12 条里的另一半)在当前 HEAD 上已经两块
都有——证据与推理见 §4.1 原地补的段落。

### 15.3 P3-2 —— 核实既有自陈仍准确,不新增覆盖

```
$ git diff be2467ca656234ee19603fcd23f63f8788f92995 -- packages/core-backend/src/routes/approvals.ts
(空)   ← 本轮零改动这个文件
$ git grep -n "by-construction / grep-based one" packages/core-backend/tests
tests/unit/approval-todo-counts-dual-publish-wiring.test.ts:10:cannot — prove any of the eight route handlers actually calls this shared function instead of some
```
docblock 第 9-12 行原句「this gates `publishApprovalCountsForUsers`'s OWN body only. It does not —
and cannot — prove any of the eight route handlers actually calls this shared function instead of
some other path; that argument stays a by-construction / grep-based one」仍在、仍准确(门审 §3
P3-2 亲跑 M8 逐字核对过这句自陈与实际行为一致);门审自身的结论是「风险很低,已被实现
者显式自陈」,不是「需要新增一个 per-call-site 覆盖」的待办——把这条升级成「给八个调用点各打一个断
言」是一次新增测试设计决策(需要先定义"哪种覆盖形状"),不是本轮"闭世界/矛盾措辞/正控"这类机械可
闭合项,按硬规矩"生产代码零行为改动"之外的"新增测试覆盖面"决策留白,不在本轮做,也不构成新债务
(门审判定已接受此风险)。

### 15.4 P3-3 —— 交付物本无此错;补前瞻指引,不转抄 `:1186`

```
$ git grep -n "1186" -- docs/development/todo-center-phase2-fe-verification-20260918.md \
    docs/development/todo-center-phase2-fe-design-20260918.md
docs/development/todo-center-phase2-fe-design-20260918.md:78:| `apps/web/scripts/run-required-web-tests.sh` | 末行 exec 加 `todoApi TodoCenterView todoCountsRealtime` 三个令牌 | `:1186` |
docs/development/todo-center-phase2-fe-verification-20260918.md:753:需要修的断言。对**当前 HEAD** 该 exec 行(`:1186`)重新机核(丢弃 `exec`/`npx`/`vitest`/`run`/
```
设计 MD `:78` 那一行是撰写当时的快照(按既定惯例不回填,见 §13.1 结尾的说明);验证 MD `:753`
（§12.1)讨论的是 `todoApi`/`TodoCenterView`/`todoCountsRealtime` 三个不同令牌所在的 exec 行,门审
§4.4 亲核过这条引用本身是准的(:1186 至今仍是这三个令牌的 exec 行,§15.6 已用 grep 重新核对)。两
处都不是在给 `approvalNavTodoBadge` 定位。门审 P3-3 指出的错误只存在于**外部**报告
`impl-gate-B2-round1-20260918.md` §4.4 自己的文字里(该文件是 head-scoped 的历史门审记录,本轮不
回改它)。**前瞻指引(供未来 PR body 誊抄 §12.3/§13.4 条款、或任何人需要引用
`approvalNavTodoBadge` 的 required-check lane 证据时使用,用命令定位、不转抄数字)**:
```
$ grep -n "^npx vitest run approvalNavTodoBadge " apps/web/scripts/run-required-web-tests.sh
779:npx vitest run approvalNavTodoBadge approvalNavDelegationEntry approvalBatchTransferView approvalNavBatchTransferEntry --reporter=dot
$ grep -n "^set -euo pipefail" apps/web/scripts/run-required-web-tests.sh
473:set -euo pipefail
```
这条 exec 行本身没有 `|| exit $?`,失败传播靠脚本开头(当前 HEAD `:473`)的 `set -euo pipefail` 覆盖
全部 17 条 `npx vitest run`——这条命令组合(不是裸数字)才是可信引用,行号会随脚本增长漂移,重跑这
两条 `grep` 得到的数字才是当前 HEAD 的事实。

### 15.5 P3-4(P3-8 结转)—— 核实待誊抄文本已完整,DEFERRED

```
$ grep -n "PR body 待写条款" docs/development/todo-center-phase2-fe-verification-20260918.md
862:  > **PR body 待写条款(P3-8,门审 `impl-gate-B2-round1-20260918.md`)**:导航入口(commit
$ sed -n '862,865p' docs/development/todo-center-phase2-fe-verification-20260918.md
```
§12.3 的待誊抄段落(当前 HEAD `:862-865`)已经点名 commit `4b3f8f483`、`App.vue:38,:52`、锁 §2「前端壳」表最后第 2 行(而非
锁 §4 字面条款)——核对内容完整、准确,不需要在 MD 层再补一个字。剩下的动作**只能**是把这段话原样
写进 Draft PR #5857 的 PR body——本轮硬规矩明文"不动 PR 状态与 body",不可执行,DEFERRED-owner 项:
交给被授权编辑该 PR body 的下一步(开 PR / 整理 PR body 的那条 lane)原样誊抄 §12.3 原文,不必重新
起草。

### 15.6 P3-5a —— 106-token advisory 全量重跑,本轮亲跑

```
$ LINE=$(grep -n 'run: pnpm --filter @metasheet/web exec vitest run.*todoApi TodoCenterView todoCountsRealtime --reporter=dot$' \
    .github/workflows/approval-web-guard.yml | head -1 | cut -d: -f1)
$ echo $LINE
1013   ← 不是 §2.3 记录的 :1006(该记录是修复轮 2 当刻的快照,脚本此后又增长过;§2.3 原样保留,不
         回改历史记录,本条只是如实指出当前 HEAD 的准确行号靠 grep 得到,不是靠转抄)
$ sed -n "${LINE}p" .github/workflows/approval-web-guard.yml | sed 's/^ *run: //' > /tmp/todo-fe-ci-cmd-p3hygiene.sh
$ bash -c "$(cat /tmp/todo-fe-ci-cmd-p3hygiene.sh)"
 Test Files  104 passed (104)
      Tests  1959 passed (1959)
   Duration  7.38s (transform 7.74s, setup 946ms, collect 14.49s, tests 26.77s, environment 21.64s, prepare 4.23s)
```
104 文件 / 1959 用例全绿,与修复轮 4 §13.2 记录的 1959 基线一致,不是抽样。该 lane 是 advisory,非
required(§14.6/§5 已核),本条只是把门审 P3-5 点名的"未跑"补上,不改变任何判据的 required 状态。
**范围说明(本条新查,不转引 §4.6——那条核的是 `plugin-tests.yml` 的 job 边界,不是这个文件)**:
```
$ grep -n "^jobs:\|^  approval-web-guard:" .github/workflows/approval-web-guard.yml
829:jobs:
830:  approval-web-guard:
```
`merge_group`/`pull_request`/`push` 三个触发器(:18/:19/:435)之下只有这一个 job、一份步骤列表,
不是各触发器各自一份 job/exec——上面这一次重跑就是这个 job 唯一会执行的命令,不是"验证了三种触发
路径中的一种,其余未验"。

### 15.7 P3-5b —— 真浏览器视觉验收,登记不做

jsdom 无法证明视觉可判别性(`feedback_css_verify_in_real_browser_not_jsdom`)。本轮硬规矩范围是
测试/注释/MD/scripts 层,不包含新增真实浏览器（Playwright 等)验收基础设施——这不是一个"能不能做"
的产品/合同判断,而是一次基础设施投入决策,超出本轮卫生扫描的范围,DEFERRED-owner 项,如实登记,
不在此假装用 jsdom 顶替。

### 15.8 P3-5c —— 徽标 E3(`acceptPushes`)+「订阅错事件」两条 mutation,本轮亲跑转红

两条 mutation 各自 `cp` 备份 → 改 → 单独跑 → 观察红 → `cp` 还原 → `cmp` 字节相同 → 重跑回到全绿。

**M-HYG1**(E3,`ApprovalTodoBadge.vue` 的 `handleCountsUpdated`):
```
$ cp src/approvals/components/ApprovalTodoBadge.vue /tmp/ApprovalTodoBadge.vue.bak
# 删除 `if (!acceptPushes) return`(保留 `applyResult(payload)`)
$ npx vitest run approvalNavTodoBadge --reporter=dot
 Tests  1 failed | 22 passed (23)      ← 命中 E3 用例本身,断言
 `expect(badgeOf(root)).toBeNull()` 在签退后收到迟到推送时失败(徽标重绘成 '9')
$ cp /tmp/ApprovalTodoBadge.vue.bak src/approvals/components/ApprovalTodoBadge.vue
$ cmp /tmp/ApprovalTodoBadge.vue.bak src/approvals/components/ApprovalTodoBadge.vue   # 字节相同
$ npx vitest run approvalNavTodoBadge --reporter=dot
 Tests  23 passed (23)
```

**M-HYG2**(订阅错事件,`useTodoCountsRealtime.ts` 的 socket 订阅名):
```
$ cp src/todo/useTodoCountsRealtime.ts /tmp/useTodoCountsRealtime.ts.bak
# 'todo:counts-updated' → 'approval:counts-updated'
$ npx vitest run todoCountsRealtime --reporter=dot
 Tests  1 failed | 4 passed (5)        ← 命中「subscribes to todo:counts-updated ...」,
 `toHaveBeenCalledWith` 收到 0 次调用(订阅错了事件名,回调从未被触发)
$ cp /tmp/useTodoCountsRealtime.ts.bak src/todo/useTodoCountsRealtime.ts
$ cmp /tmp/useTodoCountsRealtime.ts.bak src/todo/useTodoCountsRealtime.ts             # 字节相同
$ npx vitest run todoCountsRealtime --reporter=dot
 Tests  5 passed (5)
```
两条 mutation 各自的 guard 证据已同步写进对应 spec 文件里紧邻用例的注释(见 §15.1 附带一条 与
`todoCountsRealtime.spec.ts` 的新注释),不再是"沿用上一轮的机械 diff 论证",而是本轮亲跑转红。

### 15.9 撤回类改动扫描(全分支 grep,逐条核对,不假报零命中)

本轮没有撤回任何**被证伪的事实性断言**(§4.1 的标题改写是"改窄口径"——原句下方给出的 26 行邻域
`diff` 证据本身从未错,错的只是标题的覆盖面;E3 注释的改写是修正一句对当前代码已不准确的描述)。
以下按纪律对全分支做机械扫描——**如实记录真实命中,不因为命中数不为零就断言"未清干净"**,逐条
交代每一条命中为何不是一次存活的过强声明(自我指涉的检索天然会命中"正在描述这次修正"的句子本身,
这是写"改了什么"时结构性无法避免的,不代表清理不彻底):

```
$ git grep -n "两块字面相同" -- '*.md'
```
命中数不钉在此处——本代码块自己贴了这条 grep 的命令,而命令行字面含「两块字面相同」,过去这里连
输出一起贴,结果输出里的每一行历史引用也字面含同一短语,于是"贴出的证据"每次被引用都会让下一次
重跑的命中数比真实历史引用数多算出这段引用本身(P3-4,`p3-hygiene-gate-B2-20260919.md`:该报告在
自己写作时测得 3,在自己审的那个 head 上重跑测得 7——多出的 4 条正是报告自己贴的命令行+三行输出;
这两个数字都是那份报告自己的历史测量,不是本处的现状)。真实历史引用只有三处,全部是「引用旧标题
以说明它已被改掉」的叙述(§4.1 更正段本身、§15.1 处置表的"原文一句"列、§15.2 的更正说明),
**不是**标题本身——机械核对标题这一行:
```
$ grep -n "^### 4.1" docs/development/todo-center-phase2-fe-verification-20260918.md
208:### 4.1 本切片新增的 6 个 path 条目在两块里逐字一致(邻域 diff)
```
标题行本身已不含该短语,零剩留。

```
$ git grep -n "deleting \`handleCountsUpdated\`'s \`if (!hasSession"
docs/development/todo-center-phase2-fe-verification-20260918.md:1303:E3 用例的注释写「deleting `handleCountsUpdated`'s `if (!hasSession()) return`」,但该函数体内并不
```
1 处命中,是 §15.1 引用旧注释原文以说明它已被改写(中文叙述句,不是代码)。对**代码文件**单独核实
零命中:
```
$ git grep -n "if (!hasSession" -- '*.ts' '*.vue'
apps/web/src/approvals/components/ApprovalTodoBadge.vue:316:    if (!hasSession()) {
apps/web/src/todo/views/TodoCenterView.vue:286:    if (!hasSession()) {
```
这两处是**不同位置**的真实代码(认证切换监听器里的 `hasSession()` 检查,决定要不要清零/续订
`acceptPushes`/重读——见 `ApprovalTodoBadge.vue:307-322`),不在 `handleCountsUpdated` 函数体内,
与被改写的那句失实注释无关,是本来就存在、本轮零改动的正确代码。

P3-3 要核对的具体命题是「全分支范围内有没有一处把 `:1186` 当作 `approvalNavTodoBadge` 的位置来引
用」。裸的 `git grep -n ":1186"` 命中太多与本条无关的数字巧合(其他文档里的行号/哈希片段),不是
有判别力的检索;改用同时含两个关键词的检索才直接测这个命题:`git grep -n "1186" | grep -i
"approvalNavTodoBadge"`。**这条检索本身有自指问题**——本 §15 正在讨论"`:1186` 是不是
`approvalNavTodoBadge` 的行号"这件事,所以只要还在编辑本节,这条命令的命中数就会随本节自己的措辞
增减而变(同 §12.3/§13.3/§14/§15.10 已明确过的自指陷阱),不能像别处那样贴一份"最终"输出冻结在
文档里。改为只对**本节之外**(§1–§14,`## 15.` 之前、内容自本轮起不再改动的部分)跑这条检索:
```
$ sed -n '1,1267p' docs/development/todo-center-phase2-fe-verification-20260918.md | grep -n "1186" | grep -i "approvalNavTodoBadge"
(空)
```
（`1267` 是本轮提交时 `## 15.` 那一行的行号减一——未来任何一轮再往这份文档后面追加 §16 及以后的
内容,都会把这个数字变得偏低而漏查新增内容;重跑此检索时先用 `grep -n "^## 15\."` 重新取当前 HEAD
上 `## 15.` 的行号,再代入,不要沿用这个写死的 `1267`。)
零命中——`:78`(设计 MD)与 `:753`(验证 MD §12.1)是全文里仅有的两处 `:1186` 引用,它们讨论的是
`todoApi`/`TodoCenterView`/`todoCountsRealtime` 三个令牌的 exec 行(§15.4/§15.6 已核对准确),从未
提及 `approvalNavTodoBadge`。命题核对为真:交付物自己的正文里,没有一处把 `:1186` 当作
`approvalNavTodoBadge` 的位置。

### 15.10 越界检查

```
$ git diff be2467ca656234ee19603fcd23f63f8788f92995..HEAD --name-only
apps/web/tests/approvalNavTodoBadge.spec.ts
apps/web/tests/todoCountsRealtime.spec.ts
docs/development/todo-center-phase2-fe-verification-20260918.md

$ git diff be2467ca656234ee19603fcd23f63f8788f92995..HEAD --name-only -- apps/web/src packages/core-backend \
    .github/workflows '*/migrations/*'
(空——四条路径全部零命中)
```
（不对本 MD 自身取精确插入/删除数——本节还在追加中,对一份自己仍在编辑的文档取自己的 diffstat 会
引用一个随下一次编辑就变的数字,同 `6dafde03e` 已修过的自指陷阱,§12.3/§13.3/§14 都用永久性回避
这个处理方式,不是"提交前再核一遍"这种会随提交完成而过期的承诺,这里延续同一处理方式。)真正稳定、
可重复验证的断言是**文件集合**,不是数字:本轮改动只触碰上面这三个文件(两个 `apps/web/tests/*.spec.ts`
的注释 + 这一份 MD),`apps/web/src`、`packages/core-backend`、`.github/workflows`、迁移目录、锁文
路径全部零命中——零 `packages/core-backend` 改动,零迁移,零锁文,零 workflow 文件改动,零
`apps/web/src` 生产代码改动。
