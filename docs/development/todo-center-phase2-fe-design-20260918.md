# 待办中心 Phase-2(切片 B-2,前端)—— 设计 MD

派生自 `todo-center-design-lock-draft-20260915.md` v2.14(**RATIFIED 2026-09-18**)。RATIFY 记录
**原样引用**(锁文抬头第 1–8 行,逐字,不省略、不改写):

> # 待办中心 —— 设计锁 **v2.14**(**RATIFIED 2026-09-18**;十三道独立复核后修正;见下方 RATIFY 记录)
>
> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **漂移核对(85ddd2926 → 00781e68b)**:本锁引用的核心文件(`routes/approvals.ts`、`ApprovalProductService.ts`、`approval-seat-authorization.ts`、`AuthService.ts`、`rbac/*`、`plugin-attendance/index.cjs`、迁移目录既有文件、`plugin-tests.yml`)**字节相同**;唯二有位移的是 `packages/core-backend/src/index.ts`(整体 +8 行:`:1719→:1727` jwt 中间件、`:1725→:1733` correlation 增强、`:1777→:1785` `app.use(approvalsRouter(`、`:2046→:2054` correlationErrorHandler、插件 `addRoute` 的 catch `:705-711→约 :712-718`)与 `multitable/automation-service.ts`(import 行 `:108` 不变,布尔消费方 `:1298-1310→约 :1316` 区);`run-required-web-tests.sh` 的 exec 行只多了 stock-prep 令牌;新增迁移 `…create_recovery_archive_derived_effects.ts` 与本锁无关。锁文正文保留基线行号,以本条为准换算。
> - **裁决结果(按建议值)**:§7-2 基准口径 = §1.5 的 ①(活动席位)= **确认**;§7-2′ 角色来源首期 = **(a)**(与决策门同源),(b) 加宽须与门同步加宽、另立票;§7-2″ `source_queue` 席位首期**计入 + `actionable=false`**;§7-3 评论收件箱 v1.1 再议;§7-4 云课堂「待处理」交该域;§7-5 任务线接口以 §3 为准;§7-6 AuthService 静默收窄登记为平台授权线独立发现,不作本锁前置。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

本文档只覆盖目标文档 `goal-three-locks-full-implementation-20260918.md` 切片表的 **B-2 前端** 切片——
中心页、徽标改读接线、判据 B 的**徽标层**半边、判据 E 代数守卫、实时 `todo:counts-updated`。B-1(后端:
共享查询提取、`PendingSourceRegistry`、`/api/todo/items`+`/api/todo/count`、判据 A0/A/B 的 **API 层**
半边/C/C′/D/F)是独立切片,已有自己的设计与验证 MD(`todo-center-phase1-design-20260918.md` /
`todo-center-phase1-verification-20260918.md`),本文档**不重复**其内容,只在需要论证「同一谓词」时引用。

工作树:本文档所在工作树(分支 `feat/todo-center-phase2-fe`,HEAD `4b3f8f48360405461ecec802974006dc8961bc7b`)。
该分支从 B-1 分支 `feat/todo-center-shared-pending-query` 的 `1c08a4ac8feb0e443134ae20af283d836ff30300`
分出(`git merge-base origin/feat/todo-center-shared-pending-query HEAD` 核实得到同一 SHA),即 B-2 的
全部改动 = `git diff 1c08a4ac8f..HEAD`;与 `origin/main` 的合并基点是 `89f1ecdee2c3b70205a318074824c834bc6a5c7e`
(B-1 设计文档已核对的同一点)。本文档所有 file:line 均由本次会话在该工作树上重新 `grep -n`/`cat -n`
得到,不是从 commit message 或既有文档转抄。

## 1. 范围 / 不在范围

### 1.1 范围(逐条引用锁文 §)

| # | 内容 | 锁文依据 |
|---|---|---|
| 1 | 待办中心前端页 `TodoCenterView.vue`:按 `response.sources` 分组(每个已注册来源一段),点击 `item.href` 导航 | 锁 §4「前端:待办中心页(按来源分组、点击 `href` 导航)」 |
| 2 | 路由 `/todo`,`meta.permissions=['approvals:read']`,导航入口(两处 `router-link`,与 `nav-approvals` 同级、非其子项) | 锁 §4 前端段;目标文档 B-2 |
| 3 | 顶部徽标 `ApprovalTodoBadge.vue` 改读 `GET /api/todo/count`(经 `todo/api.ts` 的 `getTodoCount()`),不再读旧 `getPendingCount('all')` | 锁 §4「顶部徽标改读 `todo/count`」 |
| 4 | **判据 B 的徽标层半边**:徽标对 `degraded`/`unavailable` 呈现可判别的「不可用」态,不得渲染成 0(B-1 已交付 API 层半边——共享查询读失败 ⇒ 该源 `unavailable`) | 锁 §4「迁移后徽标对 `unavailable`/`degraded` 必须有可判别的呈现,不得渲染成 0」;锁 §5 判据 B「**API 层与徽标层各一格**」 |
| 5 | **判据 C′ 的前端呈现半边**:中心页对 `item.actionable === false` 的条目渲染「仅查看」pill,与可办理项不同形(判据本身——`actionable` 由 `resolveCanDecideCurrentNode` 计算——是 B-1 的后端半边) | 锁 §5 判据 C′「UI 呈现与可办理项不同形」 |
| 6 | **判据 E(代数守卫)**:登出/换 org 时,徽标与中心页任一处仍在飞的 `getTodoCount()`/`getTodoItems()` 读不得落地渲染陈旧数据 | 锁 §3 硬约束「不缓存跨越鉴权变化」;锁 §5 判据 E |
| 7 | 实时:`todo:counts-updated` 推送——后端发送(`services/todo-realtime.ts` + `routes/approvals.ts` 八个既有触发点)+ 前端订阅(`useTodoCountsRealtime.ts`,徽标与中心页两个消费方) | 锁 §4「实时:复用按用户 room,发 `todo:counts-updated`」;B-1 设计 MD §1.1 行 7 撤回段:「本切片实际不再交付这条广播」——即本切片(B-2)是它的正式交付点 |
| 8 | 前端 spec(含判据 B 的徽标格、E 的两个消费方)接入 `apps/web/scripts/run-required-web-tests.sh` 的 exec 行 + `approval-web-guard.yml` 两点触发集(`paths`) | 锁 §6「前端 spec(含判据 B 的徽标格)显式加进 `run-required-web-tests.sh` 的 exec 行(否则 ungated;该行是合并冲突高发点)」 |

### 1.2 不在范围(逐条引用锁文 § / B-1 文档 / 补充清单)

| # | 内容 | 依据 |
|---|---|---|
| 1 | 判据 A0/A/C/D/F 与判据 B 的 **API 层**半边、判据 C′ 的**判定**半边(`resolveCanDecideCurrentNode` 本身) | B-1 切片范围;`todo-center-phase1-design-20260918.md` §1.1;本切片只消费 B-1 暴露的 `PendingItem.actionable`/`sources` 字段,不重新判定 |
| 2 | 评论源(v1.1)、云课堂「待处理」定义、任务源 | 锁 §4「不做」段;锁 §7-3/§7-4/§7-5 |
| 3 | `routes/todo.ts` 的 `approvals:read` 单一权限门槛按源收窄 | `routes/todo.ts:11-17` 自述的已知局限(B-1 已记录);本切片的 `canUseApprovals`/路由 `meta.permissions` 只能与后端同一个门同步,不能单独收窄或放宽——见 §7 |
| 4 | 徽标/中心页的**跨标签页(多窗口)** `todo:counts-updated` 一致性、socket 重连(换 org 后用旧 token 的 socket 半边) | 见 §4「留给后续切片的项」;不是本切片声明交付的判据 |
| 5 | `services/todo-realtime.ts` 推送里 `source_queue`(权限)臂的缺口——推送不带 `permissions`,只影响推送数字,不影响本切片任何一格判据的 REST 半边 | `services/todo-realtime.ts:16-27` 自述;B-1 既有 `approval:counts-updated` 广播同样的限制,不是本切片新增 |

## 2. 组件与接口

### 2.1 新文件

| 文件 | 导出 | 作用 |
|---|---|---|
| `apps/web/src/todo/api.ts`(70 行) | `PendingItem`/`TodoItemsResponse`/`TodoCountResponse`/`PendingSourceStatus` 类型;`getTodoItems()`(`:52-54`,`GET /api/todo/items`)、`getTodoCount()`(`:56-58`,`GET /api/todo/count`)、`isTodoResponseDegraded()`(`:67-70`) | 类型化封装 B-1 的两个聚合端点;`isTodoResponseDegraded` 只被徽标消费(§3.1 有更正:本文件与 `ApprovalTodoBadge.vue` 的文档字符串都写「徽标与中心页都用它」,`TodoCenterView.vue` 实际未导入它) |
| `apps/web/src/todo/useTodoCountsRealtime.ts`(156 行) | `useTodoCountsRealtime(options)`,返回 `{ reconnect, disconnect }`;`TodoCountsUpdatedPayload` 类型 | 订阅 `todo:counts-updated` 的 socket 组合式函数,整体照抄 `useApprovalCountsRealtime.ts` 的连接生命周期(`:15-19` 自述:MODE 守卫、`connectionPromise` 去重、`disconnected` 拆除标志三者缺一都会在 vitest 下开真 socket 或内存泄漏) |
| `apps/web/src/todo/views/TodoCenterView.vue`(314 行) | 默认导出(SFC);内部 `applyResult`/`refresh`/`handleCountsUpdated` | 中心页:按 `sources` 分组渲染,`actionable===false` 渲染 view-only pill,判据 E 代数守卫 |

后端新文件:

| 文件 | 导出 | 作用 |
|---|---|---|
| `packages/core-backend/src/services/todo-realtime.ts`(80 行) | `publishTodoCountsUpdate(input)`,`TodoCountFetcher` 类型 | 复用 `pendingSourceRegistry.countPendingForUser`(B-1)算出计数后经 `CollabService.broadcastTo` 推给 `buildAuthenticatedUserRoom(userId)` |

### 2.2 既有文件的改动

| 文件 | 改动 | 行 |
|---|---|---|
| `apps/web/src/approvals/components/ApprovalTodoBadge.vue` | 数据源从旧 `getPendingCount('all')` 改为 `getTodoCount()`;新增 `isUnavailable` 状态、`applyResult()` 判定、判据 E 两处代际计数器;订阅 `useTodoCountsRealtime` 替代 `useApprovalCountsRealtime` | 全文件重写(241 行 diff);见 §3/§4 |
| `apps/web/src/App.vue` | 两处(`plmWorkbenchFocused`/else 分支)新增 `<router-link to="/todo">`;`navLabels` 新增 `todoCenter` 键 | `:38`、`:52`、`:196`(zh)、`:225`(en)——见下方 grep |
| `apps/web/src/router/appRoutes.ts` | 新增 `/todo` 路由,`meta.permissions=['approvals:read']` | `:350-358` |
| `packages/core-backend/src/routes/approvals.ts` | `publishApprovalCountsForUsers` 内新增 `publishTodoCountsUpdate` 调用,与既有 `publishApprovalCountsUpdate` 并发 | `:471-504`(见 §5) |
| `.github/workflows/approval-web-guard.yml` | 两个 `paths:` 块各加 6 行;exec 行加 3 个 vitest 令牌 | 见 §6 |
| `apps/web/scripts/run-required-web-tests.sh` | 末行 exec 加 `todoApi TodoCenterView todoCountsRealtime` 三个令牌 | `:1186` |

本次会话重新核对的行号(不是转抄):

```
$ grep -n 'router-link v-if="canUseApprovals" to="/todo"' apps/web/src/App.vue
38:            <router-link v-if="canUseApprovals" to="/todo" class="nav-link" data-testid="nav-todo-center">{{ navLabels.todoCenter }}</router-link>
52:            <router-link v-if="canUseApprovals" to="/todo" class="nav-link" data-testid="nav-todo-center">{{ navLabels.todoCenter }}</router-link>
$ grep -n "todoCenter:" apps/web/src/App.vue
196:      todoCenter: '待办中心',
225:    todoCenter: 'Todo Center',
$ grep -n "canUseApprovals = computed" apps/web/src/App.vue
178:const canUseApprovals = computed(() => {
$ sed -n '178,181p' apps/web/src/App.vue
const canUseApprovals = computed(() => {
  void route.fullPath
  return hasPermission('approvals:read')
})
```
`canUseApprovals` 与 `/todo` 路由的 `meta.permissions=['approvals:read']`、`routes/todo.ts:50,:66` 的
`rbacGuard('approvals','read')` 是**同一个门**——导航入口、路由守卫、后端端点三处权限判据字面一致,不是
分别实现后凑巧相同(§7 记录了这个门为何还不能按源拆分)。

## 3. 判据 B(徽标格)机制,file:line

B-1 交付了 API 层半边(共享查询读失败 ⇒ `/api/todo/count` 该源标 `unavailable`,见 B-1 验证 MD 判据 B
小节)。本切片交付**徽标层**与**中心页层**——响应/推送里的 `unavailable`/`degraded` 必须让 UI 呈现可判别
的「不可用」态,不能塌陷成与「零待办」相同的 DOM/视觉形状。

### 3.1 唯一判定点:`isTodoResponseDegraded`

`apps/web/src/todo/api.ts:67-70`:
```
export function isTodoResponseDegraded(response: { degraded?: boolean; sources: Record<string, PendingSourceStatus> }): boolean {
  if (response.degraded === true) return true
  return Object.values(response.sources).some((status) => status === 'unavailable')
}
```
徽标(`ApprovalTodoBadge.vue:186` 的 `applyResult()`)与中心页(`TodoCenterView.vue` 按 `sources` 逐条
分组,`:26` 的 `v-if="group.status === 'unavailable'"`)都读同一个字段集合(`degraded`/`sources[*]`),
但走两条不同的渲染路径——徽标是"整体不可用"的单一开关,中心页是"逐来源"的分组开关。

**更正一处源码文档字符串的断言**(本次会话核实,未改动源码):`todo/api.ts:60-65` 的注释与
`ApprovalTodoBadge.vue:35-37`(「the one shared rule (also used by the todo center page)」)都写
`isTodoResponseDegraded` 由「徽标与中心页共用」。本次会话重新 grep 得到的导入语句证明这句话对
`TodoCenterView.vue` 不成立:
```
$ grep -n "isTodoResponseDegraded\|import.*from '\.\./api'" apps/web/src/todo/views/TodoCenterView.vue
132:import { getTodoItems, type PendingItem, type PendingSourceStatus, type TodoItemsResponse } from '../api'
```
`TodoCenterView.vue` 只导入 `getTodoItems` 和三个类型,**未导入、未调用** `isTodoResponseDegraded`;
它的 `applyResult()`(`:166-182`)直接按 `Object.entries(response.sources)` 逐组取 `status` 字段渲染
(§3.3)。且 `TodoItemsResponse`(`api.ts:39-42`)本身**没有 `degraded` 字段**,与只用于
`TodoCountResponse` 的 `degraded?: boolean`(`:49`)不是同一形状——中心页要的是「每个来源各自的
`ok`/`unavailable`」,不是徽标要的「整体是否可信」这一个布尔值,套用同一个函数在类型上就不完全对齐。
结论仍然成立(中心页确实不需要、也没有拼第二份判断逻辑——它复用的是 `PendingSourceStatus` 这个**类型**
和 `sources` 这个**字段**,不是复用 `isTodoResponseDegraded` 这个**函数**),但两处文档字符串「中心页
也调用它」的字面表述是错的,已记录于验证 MD §7,未改动这两处源码注释(超出本次任务的「不改代码」
边界)。

### 3.2 徽标层:两个入口,一次收敛

`ApprovalTodoBadge.vue:185-193`:
```
function applyResult(response: TodoCountResponse | null): void {
  if (response === null || isTodoResponseDegraded(response)) {
    isUnavailable.value = true
    pendingCount.value = 0
    return
  }
  isUnavailable.value = false
  applyCount(response.count)
}
```
两个调用点收敛到同一个函数,不是各自判断:
- REST 路径,`refresh()` 内 `:244`(成功)与 `:252`(`catch` 块,`response=null`);
- 推送路径,`handleCountsUpdated()` `:212`。

模板层的呈现分叉(`:2-17`):`isUnavailable` 渲染 `!` 徽标(`role="status"`,`aria-label` 带
「(数据不可用)」/`(data unavailable)`,`:172-174`);否则 `pendingCount > 0` 才渲染数字徽标;两者
都不成立时**不渲染任何徽标**(既有的「零待办不占位」惯例)。三态互斥,`不可用` 与 `0` 永不同形——
样式上也不同(`.approval-todo-badge--unavailable` 用 `--el-color-warning`,数字徽标用
`--el-color-danger`,`:300`/`:310`)。

`degraded: true` 字段今天不可达(`routes/approvals.ts:2067` 的旧徽标端点才发,`/api/todo/count`
本身不发——B-1 设计 MD 与本文件 `todo/api.ts:14-21` 都记录了这一点),所以这条分支只在
`apps/web/tests/approvalNavTodoBadge.spec.ts` 里用 stub 响应体验证,不在真实后端路径上被走到——
如实记录,不是缺口。

### 3.3 中心页层:分组来自 `sources`,不来自 `items`

`TodoCenterView.vue:176-182`:
```
groups.value = Object.entries(response.sources).map(([source, status]) => ({
  source,
  status,
  items: response.items.filter((item) => item.source === source),
}))
```
分组键来自 `response.sources`(每个已注册来源必出现一次),`items` 只用来给每组填内容。若改成从
`items` 反推分组(`[...new Set(items.map(i => i.source))]`),一个 `unavailable` 且贡献 0 条目的来源
会从分组列表里**消失**,和「该来源 `ok` 且确实零待办」在 DOM 上**同形**——这正是锁 §5 判据 B 负控点名
的塌陷。模板 `:25-39` 让 `group.status==='unavailable'` 与 `group.items.length===0` 渲染两种不同的
`data-testid`(`todo-center-group-unavailable` vs `todo-center-group-empty`),互斥、不同文案。

本次会话对这条机制做了真实 mutation(见验证 MD §3 mutation 3):把分组逻辑换成从 `items` 反推,
`apps/web/tests/TodoCenterView.spec.ts` 里专门命名的 mutation-guard 用例连同另外两个用例一起转红,
恢复后连同全套件重新转绿,已 `cmp` 确认文件字节级还原。

## 4. 判据 E(代数守卫)机制,file:line

锁 §3「不缓存跨越鉴权变化」+ §5 判据 E:「请求在飞时登出 ⇒ 迟到响应不落地(构造竞态,不靠 sleep)」。
机制**整段复制**自 `useApprovalAdminCapability`(`ApprovalTodoBadge.vue:52-54` 自述),再由
`TodoCenterView.vue` 从徽标复制第二遍(`:79-81` 自述「not re-derived item by item」)——两个消费方
各自持有自己的一对独立状态(不是共享单例),因为两者渲染的东西不同(一个数字 vs 一个列表)。

### 4.1 两个独立的单调代际计数器,各自的理由

| 消费方 | 状态变量 | `refresh()` 自身的 bump | 监听器的 bump |
|---|---|---|---|
| `ApprovalTodoBadge.vue` | `generation`(`:233`) | `:237`(`refresh()` 入口自增,`:243` 结果前比对) | `:260`(`onAuthPrincipalChange` 回调同步自增) |
| `TodoCenterView.vue` | `generation`(`:184`) | `:188`(同上模式,`:192` 比对) | `:222`(回调同步自增) |

两处 bump **不是冗余**——`refresh()` 自己的 bump 挡住「登录时机重叠」(已有会话时的换 token,例如
dev-token 刷新:新读会启动并可能先于旧读落地);监听器的 bump 挡住「登出无新读」(没有任何后续调用会
超越旧的 in-flight 读,若没有这第二次自增,`mine === generation` 检查会在旧读迟到落地时仍然通过)。
两处各有一个正控/mutation:本文档验证 MD 的 mutation 2(删监听器 bump ⇒ 仅红 E2「sign-out」用例)与
mutation 4(删 `refresh()` 的 bump 判断 ⇒ E1/E2 都红)分别单独证明了这一点——不是同一处代码的两次断言。

### 4.2 监听点与微任务延迟的理由(file:line)

`ApprovalTodoBadge.vue:256-277` / `TodoCenterView.vue:221-236`:
```
const unsubscribeAuthPrincipal = onAuthPrincipalChange(() => {
  generation += 1
  pendingCount.value = 0      // 或 groups.value = []
  isUnavailable.value = false // 或 loadFailed.value = false
  void Promise.resolve().then(() => {
    if (disposed) return
    if (!hasSession()) { acceptPushes = false; return }
    acceptPushes = true
    void refresh()
  })
})
```
延迟到微任务的理由(两个组件文件顶部注释各自记录,机制相同):`useAuth.ts` 的会话重置漏斗
(`resetSessionBootstrap`)在**写入**新 token 到 storage **之前**调用 `notifyAuthPrincipalChange()`
(见 `setToken`/`clearToken` 两条路径);若同步在回调里重读 storage 判断是否还有会话,会读到**旧**
token 或空值——登出时误判成"还有会话"、登录时误判成用旧会话发起新读。微任务让那次同步的 storage
写入先落地。

### 4.3 `setExplicitSessionOrg`(换 org)的更正,已用真实调用验证

`ApprovalTodoBadge.vue:61-86` 与 `TodoCenterView.vue:109-124` 都记录了同一处更正:早先(`ce417a250`,
本分支内)误写「`setExplicitSessionOrg` 不调用 `notifyAuthPrincipalChange()`,故换 org 不触发本守卫」。
本次会话重新 grep 复核:

```
$ grep -n 'resetSessionBootstrap(' apps/web/src/composables/useAuth.ts
77:      resetSessionBootstrap(true, false, true)
123:function resetSessionBootstrap(clearUserSnapshot = false, clearTenantHint = false, preserveExplicitSession = false) {
234:      resetSessionBootstrap(false, false, true)
249:    resetSessionBootstrap(true, true, true)
301:      resetSessionBootstrap(true, false, true)
412:      resetSessionBootstrap(true)
```
`:123` 是函数定义本身,不是调用。五处调用分别落在:`:77`(`observeExplicitSessionStorage` 内的
**跨标签页 `storage` 事件监听器**——两个文件的文档字符串都只提「4 处调用点」,没提这一处;本次会话
认为这是文档字符串的一处小遗漏,不是判据 E 的缺口——它同样只调用
`notifyAuthPrincipalChange()`,被同一个 `onAuthPrincipalChange` 监听器覆盖,不构成第二套机制,只是多
一条会触发它的路径)、`:234`(`setToken`)、`:249`(`clearToken`)、`:301`(`setExplicitSessionOrg`,成功路径
末尾)、`:412`(`bootstrapSession` 的「无现有 token」分支)。`resetSessionBootstrap` 函数体
(`:123-142`)里没有任何 early return——`:124` `:130` `:133` 三处 `if` 只是条件性地执行一个副作用
(是否清 explicit session org / 是否清用户快照 / 是否清 tenant hint),`:141-142` 的
`rememberSessionStorage()`/`notifyAuthPrincipalChange()` 无论上面三个 `if` 是否成立都会执行——所以
以上任何一条调用路径,包括换 org,都会触发同一个 `onAuthPrincipalChange` 监听器。

`apps/web/tests/useAuth.spec.ts` 新增的 `'fires the auth-principal-change notification synchronously
on a successful org switch, storage already updated'`(本次会话重跑通过)用真实的 `setExplicitSessionOrg()`
调用(不 mock `onAuthPrincipalChange` 本身)证明了这条路径,而不是仅靠 grep 断言——这一点区分「wiring
fact 已证」与「组件是否对它做了正确反应」:后者仍有已知缺口,见 §4.4。

### 4.4 留给后续切片的项(如实记录,非本切片声明交付)

- **socket 重连缺口**(两个文件文档字符串各自记录,`useTodoCountsRealtime.ts:113-141` 的
  `ensureSocket()` 只在挂载时读一次 token,`onBeforeUnmount` 才断开):REST 半边的代数守卫已完整
  (§4.1-4.3);但换 org 后,旧 socket **不会**重新用新 token 认证,只是把 `acceptPushes` 置回 `true`
  (因为换 org 判定为"仍有会话")——一条描述旧 org 数据的推送若在换 org 后落在这条仍开着的 socket
  上,会被接受并渲染。登出半边**已闭合**(`acceptPushes=false` 挡住旧 socket 上的推送,§4.3 的 E3 用例
  覆盖)。闭合换 org 半边需要在同一个 `onAuthPrincipalChange` 事件里重连 socket(用新 token 认证),
  属于连接生命周期的改动,不是本切片这次改的查询/组件逻辑,留给后续切片。
- `todo:counts-updated` 的房间/负载是否已按 org 隔离(而非只按用户)未在本切片核实——如果已按 org
  隔离,上一条缺口的实际影响面会更窄,但这一点留待负责该单元的后续切片核实,本文档不代其断言。

## 5. 实时触发点,file:line + 「同一谓词」论证

### 5.1 发送端:与既有广播**同一组**触发点

`packages/core-backend/src/routes/approvals.ts:471-504`:
```
async function publishApprovalCountsForUsers(
  options: ApprovalRouterOptions | undefined,
  users: Array<{ userId: string; roles?: string[] }>,
  reason: string,
): Promise<void> {
  const uniqueUsers = new Map<string, string[]>()
  for (const user of users) { ... }
  await Promise.all([...uniqueUsers.entries()].map(([userId, roles]) => Promise.all([
    publishApprovalCountsUpdate({ injector: options?.injector, logger, userId, roles, reason }),
    publishTodoCountsUpdate({ injector: options?.injector, logger, userId, roles, reason }),
  ])))
}
```
本次会话重新 grep 得到的调用点(不是转抄):
```
$ grep -n "await publishApprovalCountsForUsers(" packages/core-backend/src/routes/approvals.ts
2110  (mark-read,       路由声明 :2077  POST /api/approvals/:id/mark-read)
2201  (mark-all-read,   路由声明 :2133  POST /api/approvals/mark-all-read)
2387  (remind,          路由声明 :2231  POST /api/approvals/:id/remind)
2471  (jump,            路由声明 :2421  POST /api/approvals/:id/jump)
2591  (admin/reassign,  路由声明 :2546  POST /api/approvals/admin/reassign)
2833  (actions,         路由声明 :2691  POST /api/approvals/:id/actions)
2965  (approve,         路由声明 :2854  POST /api/approvals/:id/approve)
3123  (reject,          路由声明 :3004  POST /api/approvals/:id/reject)
```
「同一谓词/同一触发集」论证:`publishTodoCountsUpdate` 不是另起一套触发逻辑——它被塞进了
`publishApprovalCountsForUsers` 函数体内部、与既有 `publishApprovalCountsUpdate` 并排的
`Promise.all`(`:483-503`)。这意味着**任何**会触发旧 `approval:counts-updated` 广播的动作,
在同一次函数调用里、同一批 `uniqueUsers` 上,**必然**也触发新的 `todo:counts-updated` 广播——
触发集合是按构造相等的,不需要在八个路由处分别核对是否都改了(改的是它们共同调用的唯一一个函数)。

### 5.2 发送端:计数不是重新推导,是复用同一个注册表方法

`packages/core-backend/src/services/todo-realtime.ts:44-45,60,66`:
```
const defaultCountPendingForUser: TodoCountFetcher = (viewer) =>
  pendingSourceRegistry.countPendingForUser(viewer)
...
    const countPendingForUser = input.countPendingForUser ?? defaultCountPendingForUser
    const { count, sources } = await countPendingForUser(viewer)
```
`pendingSourceRegistry.countPendingForUser` 正是 `routes/todo.ts:71` 的 `GET /api/todo/count` 调用的
**同一个**方法(同一个模块单例,B-1 交付)——推送侧与 REST 侧在计数上没有第二份实现。这是本模块文档
字符串明确记录「不重复 P1-1 的错误」的地方(`:6-14`):B-1 修复轮的 P1-1 发现移除了一版更早的
`todo:counts-updated` 接线,那一版接的是 `approval-realtime.ts` 的 `computeApprovalPendingCounts`——
一份**已知发散**的第二套待处理谓词(手抄了三臂匹配但漏了办理节点排除)。本次会话对这一点做了真实
mutation(验证 MD mutation 5):让 `publishTodoCountsUpdate` 忽略注入的 `countPendingForUser` 并返回
写死的空结果,`packages/core-backend/tests/unit/todo-realtime.test.ts` 里命名为
`'reuses the injected countPendingForUser fetcher ...'` 的用例(以及另外三个)转红,恢复后转绿,
`cmp` 确认字节级还原。

**撤回(gate `impl-gate-B2-round1-20260918.md` P1-1/P2-1,修复轮 1,20260918)**:上一段的结论过强。
mutation 5 改的是 `publishTodoCountsUpdate` 消费**被注入的** `countPendingForUser`——它证明的只是
「函数会调用交给它的 fetcher、并原样转发其返回值」,**不证明**「生产默认路径就是
`pendingSourceRegistry.countPendingForUser`」。生产从不传 `countPendingForUser`(`routes/approvals.ts`
的调用点没有这个字段),走的永远是 `defaultCountPendingForUser`——而全部 5 条旧用例**都注入了**
fetcher,从未执行过这一行。门审换了一条不同的 mutation(把 `defaultCountPendingForUser` 本身换成
本段第一句点名的已知发散实现 `computeApprovalPendingCounts`,不是验证 MD mutation 5 那条)亲跑证实:
`packages/core-backend/tests/unit` 全量在该 mutation 下报 **794/12709 全绿**(门审报告 §5 M5 行,
含上面那 5 条旧用例);required 检查 `test (20.x)` 跑的默认 `vitest run` 也全绿(门审对 M6——删掉
整条触发调用——单独跑的是 932/14716,同样全绿)。「不重复 P1-1 的错误」这句话在生产默认路径上是
**零判别力的注释断言**,不是被测行为。

修复轮 1 新增 `tests/unit/todo-realtime.test.ts` 里**不注入** fetcher 的用例
`'the DEFAULT path (no injected fetcher) calls pendingSourceRegistry.countPendingForUser ...'`——
它 `vi.spyOn` 打在 `pendingSourceRegistry.countPendingForUser` 本身上,断言默认路径确实调用了这个
共享单例。本轮亲跑同一条 `computeApprovalPendingCounts` mutation(只跑新文件,不是整个
`tests/unit`):这条新用例**精确转红**(1 failed / 5 passed——5 条旧用例照样绿,印证上一段「零判别力」
的诊断),`cp` 还原后 `cmp` 字节相同。本轮修复前(未 mutation)的当前基线是
933 文件 / 14720 测试全绿(见验证 MD §10.5)——这是**清洁跑**的数字,不是 mutation 下的数字,两者
不要混读。证据与新用例正文见验证 MD §10。

已知的、非本切片引入的输入缺口(`services/todo-realtime.ts:16-27` 自述):
`publishApprovalCountsForUsers` 只把「其它用户」的 `roles` 传给两个发布函数,从不传 `permissions`——
这是 `publishApprovalCountsUpdate` 早就有的限制(它的调用点同样不传 `permissions`),`publishTodoCountsUpdate`
沿用而非新增。效果:仅持 `source_queue`(权限臂)席位的 viewer,**推送**里的计数不会体现该席位;
其下一次 `GET /api/todo/count`(始终从已认证请求解析 `permissions`)不受影响、结果正确。

### 5.3 接收端:两个消费方,一份归一化,两种反应

`apps/web/src/todo/useTodoCountsRealtime.ts:86-99` 的 `normalizePayload`——`count`/`sources` 任一
不满足契约形状即返回 `null`,调用方完全不触发(`:128-131`)。两个消费方各自订阅同一个事件、同一份
归一化:
- `ApprovalTodoBadge.vue:207-213`:推送形状与 `getTodoCount()` 的返回形状一致(`{ count, sources }`),
  直接复用 `applyResult()`(REST 与推送走同一判定,§3.2 已述);
- `TodoCenterView.vue:206-211`:推送不带 `items`,页面全部内容都是列表,所以唯一正确反应是重新跑
  `refresh()`(同一个带代际守卫的函数),而不是对推送负载单独发明一套判断。

两个消费方都用 `acceptPushes` 标志挡住登出后仍开着的 socket(§4.4 已述其半闭合状态)。

## 6. CI 两点接线

`.github/workflows/approval-web-guard.yml` 的两个 `paths:` 块(`on.push`/`on.pull_request`)与
exec 行改动、及 `run-required-web-tests.sh` 的同步改动——机制、命令逐字复核、token 计数/子串碰撞
核对、required-check 状态核实,均在验证 MD §4/§5,不在此重复。

## 7. 留给后续切片的项(汇总)

1. §4.4 的 socket 重连缺口(换 org 半边)。
2. `routes/todo.ts:11-17` 的单一 `approvals:read` 门槛——第二个来源注册后必须收窄为按源判权限;
   本切片的前端门(`canUseApprovals`/路由 `meta.permissions`)与它同源,届时需同步改。
3. `todo:counts-updated` 推送的 `permissions` 臂缺口(§5.2)。
4. `todo:counts-updated` 的房间/负载是否已按 org(而非仅按用户)隔离,未核实(§4.4)。
5. 评论源(v1.1)、云课堂「待处理」、任务源——均在锁文范围外,交对应域。

## 8. Owner 待裁项(锁文 §7,原样引用,逐字不省略)

> ## 7. 待 owner 裁决
>
> 1. (**已 ratify**,见抬头记录);2. **确认基准口径 = §1.5 的 ①(活动席位)**——这是"待处理"的产品定义,不只是实现选择;
> 2′. **角色来源**:首期 = **(a)**(`users.role` + admin 升格,与决策门同源,`actionable` 才与门同判——v2.5 建议 (b) 被第 5 轮推翻:(b) 让 class ⑤ 的条目「可办理」而门 403);(b)(= `viewerRoles`,已存在的 strict 函数)是**独立裁决**,须与「决策门同步加宽」一起裁,属授权变更,本锁不承担;真库验收门约束见 §3.0(独立 vitest project,三道 import 期钉 + `RBAC_CACHE_TTL_MS=0`);
> 2″. **`source_queue`(权限)席位是否计入「待处理」**:今天 ① 计入而核心门拒绝(§1.5);建议首期**计入 + `actionable=false` 标记**(保住徽标口径、不与可办理项同形),长期由审批引擎线裁定该席位类型的去留;
> 3. v1.1 是否直接把评论收件箱作为第二源(查询现成);4. 云课堂"待处理"的定义交该域;
> 5. 任务线的来源接口以 §3 为准(§3.0 的提取属审批线工作,不进任务线);

以上均按 RATIFY 记录已裁定为「建议值」(§1.5① / 角色来源(a) / `source_queue` 计入
+`actionable=false`)——本切片(前端)直接消费 B-1 按这些裁决实现的字段(`actionable`、
`count`/`sources`),不重新判断,也不需要为本切片单独再请示。3/4/5 项与本切片(纯前端聚合展示)
无直接实现依赖,原样列出供追踪。
