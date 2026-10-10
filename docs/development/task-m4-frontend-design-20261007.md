# 任务功能 M4 前端设计（草案，2026-10-07）

> **文件状态：DRAFT（随 FE-0 片入库，2026-10-07；FE-8 收口时更新抬头、§3.2、§4.2、§4.3、§9.2、§10.4、§11–§14，2026-10-08；FE-c 按 PR-3c 重核时更新抬头、§1.1、§1.2、§8.2、§8.3、§10.1、§10.3、§11、§12-Q9、§12-Q11、§13、§14 与设计自查，2026-10-09；同日的修复轮在 §8.2 补一条注；同日晚按 owner 2026-10-09 裁定（门 26）把 `[fe-51]` `[fe-52]` 标为已裁，并按锁 PR 里门 26 列出的前端格名更新 §8.2、§8.3 第 5 条、§10.1 与 §11）。**
>
> - **owner 已于 2026-10-07 裁定 M4 裁决包**（FE-8 更新；FE-0 入库时尚未裁）：R01–R23 与 N1 / N2，R12 取 PR-3a 的收窄版 (a1) / (a2)（即 PR-3a 的 `[own-25]`）；同日另裁增删负责人与关注人须直接角色（PR-3a 的 `[own-53]`，本件 `[fe-45]`）；`[fe-19]` 同日 ratify。已裁条目在代码与本文里标 `RULED(2026-10-07): [Rxx]`，未裁的（D 条目、PR-3a 的其余 `[own-NN]`）仍标 `ASSUMPTION(task-m4-fe): [xx]`（§11 全表）；本件自选取舍标 `[fe-NN]`。裁决包是私有件，本文只按条目 id 引用（`R03`、`D5`…），不引原文。
> - **实现只开 Draft PR。** 合并、打开 `TASKS_*` 开关、触达 staging / 生产都要 owner 另行点名；本件不改后端。前端 PR 依赖 PR-3a，必须在它之后合并。
> - **后端依赖与 mock 边界。** §3.2 的全部函数（S3 设置、S4 PATCH、S5 清单、S6 成员、S7 清单项、S8 分组）连同详情的 `canManageMembers` 与 S9 的三个任务写入点 422 `INACTIVE_ORG_MEMBER`，都已在 PR-3a 分支建成（FE-8 对照的提交记在验证 MD），不在 main。前端的格全部 mock 传输层；对该分支的真机走查记在验证 MD 的 FE-8 节。（FE-5 … FE-7 编码时 S5–S8 尚未全部建成，那几节的「只按契约」是当时的状态。）红点实时订阅（§8.2，切片 FE-2 / FE-c）依赖 PR-3c：FE-2 时它尚未设计，订阅骨架按 `R16` 的约定编码；PR-3c 现已设计并在它的 Draft 分支上建成（`claude/tasks-m4-pr3c`，单提交 `3edd133ae0`），FE-c 片按 §8.3 逐条重核，结论与改动见 §8.2、§8.3。
> - 正文为三位评审返回后的终稿（§15 为逐条处置）；行号引用按抬头「基线复核」所述的提交。实现记录见 `task-m4-frontend-verification-20261007.md`。

> **状态：DRAFT。** 只做设计，不改任何仓库文件。实现只开 Draft PR，owner 裁决前不合并、不开 `TASKS_*` 开关、不改后端。裁决包是私有件，本文只按条目 id 引用（`R03`、`D5`…），不引原文；凡依赖未裁条目的取值，代码与本文一律标 `ASSUMPTION(task-m4-fe): [Rxx]`，本件自选取舍标 `[fe-NN]`。

- **前端基线**（起草时；FE-8 注：#6159 已于 2026-10-07 合入 main，合并提交 `cc6ca96ac2`，本分支自 FE-0 起就以它为基）：分支 `claude/tasks-m3-frontend`（Draft #6159），head `1326938494` = M3 前端 + `origin/main` `8e2e40d125`。M4 前端叠在它之上（M3 前端尚未合并，本件是草案栈，不是 M4 进入）。既有文件：`apps/web/src/tasks/{tasksApi.ts,tasksContext.ts,tasksBadgeBus.ts,tasksDateDisplay.ts,useTasksBadge.ts,TasksTodoBadge.vue}`、`apps/web/src/views/tasks/TasksView.vue`（1426 行，列表与详情同一组件）、13 个 `apps/web/tests/tasks-*.spec.ts` + `tests/App.spec.ts`（`tasks-web-guard.yml` 的 14 个 whole-file 参数；下文「14 个守卫」指这一组）、`task-m3-frontend-{design-20260928,verification-20260929}.md`。**基线复核（2026-10-07 续审）**：`gh pr view 6159` 的远端 head 已前进到 `9d2682ab98`（再合一次 `origin/main` 至 `57621d2403`，含 #6229——M3 后端落 main）；`git diff --stat 1326938494 9d2682ab98 -- apps/web .github/workflows/tasks-web-guard.yml apps/web/scripts/run-required-web-tests.{sh,tokens}` 只有 6 个审批 spec（#6227），任务文件、守卫 yml、lane 脚本、锁零差异，所以本文全部行号仍按 `1326938494`；FE-0 起手以分支当时的 head 为基，先重跑 14 个守卫再动手（§13）。
- **后端契约**：PR-3a 分支 `claude/tasks-m4-pr3a` @ `aafa05f2d5`（只读该提交）：`docs/development/task-m4-pr3a-backend-design-20260930.md`（§3 路由表、§5 日期规则、§7 分页、§8 红点范围、§12 owner 问题）与 `task-m4-pr3a-backend-verification-20260930.md`（S1–S4 已建：设置路由、分页信封 `{items,total}`、`/pending-count` 的 `badgeScope: 'off'`、`PATCH /api/tasks/:id` 与七个新错误码；**清单、成员、清单项、分组尚未建**，S5–S8 待做）。M3 契约 `task-m3-backend-design-20260928.md` @ `7bc8dd3f44`（错误体、404 口径、详情的 `version` / 能力标志）。
- **实时**：FE-c 依赖 PR-3c。起草时它尚未设计，本件只按纯模块 `packages/core-backend/src/tasks/task-realtime.ts`（@ `aafa05f2d5`，仅 `countsUpdateRecipients`）与 `R16` 的事件名、房间、载荷约定设计，§8.3 列出了落地后必须重核的点。FE-c 重核所读：PR-3c 设计 `docs/development/task-m4-pr3c-backend-design-20261008.md`（§12 是给前端的核对点）与 `packages/core-backend/src/services/task-counts-realtime.ts`，分支 `claude/tasks-m4-pr3c` @ `3edd133ae0`（重核开始时读的是重建前的 `e432881344`，两者的树只差 PR-3c 自己的验证 MD）。PR-3b（通知）设计终稿 §3 写明**不新增 HTTP 路由**、§9.3 写明**不加会话 payload 键**，前端不得假设任何提醒 / 汇总端点。
- **门禁**：#6173（`0386f47fdc`，决策登记 R-28）之后，任务入口 = `hasFeature('tasks') && hasPermission('tasks:read')`（`App.vue` `canUseTasks`），路由 meta 带 `requiredFeature: 'tasks'` + `permissions: ['tasks:read']`，会话 payload 的 `tasks` 键由 `tasks/feature-flag.ts#isTasksEnabled` 给出。**M4 的每条新路由、入口、请求都沿用这同一道门**，不新增 payload 键（#6191 的守卫要求 `buildFeaturePayload` 的每个键登记在 `approval-parity-execution-ledger-20260817.md` §7）、不新增 flag。
- **锁**：`task-feature-design-lock-20260917.md` §5.2（路由 / 入口）、§5.3（前端两点接线）、门 21 / 22。锁 §5.2 写的「不加 `requiredFeature`」已被 R-28 取代（#6173 的脚注），本件按 R-28。
- **对标语料**：手头的飞书手册文本经核对是**审批**手册，不含任务清单 / 分组 / 任务设置页面；本件对飞书任务 UX 的描述只来自三个帮助页的主题（清单的用法、列表的展示方式与任务设置），一律标「转述 / UNVERIFIED」，没有原页不写具体交互细节。
- **约束（全文适用）**：Draft PR；不改后端；M2 / M3 行为不变（14 个守卫全绿）；每个放进请求路径的 id 在构造请求前先过 `isPathSafeSegment`，每个新写函数都如此；错误码逐一映射到具体文案；晚到结果 token 守卫与「一次一个动作」沿用 M3；不用 `window.confirm`；无障碍基础（label、role、拖拽排序的键盘替代）；中文文案与既有文案同风格；注释不点名其他功能线的符号（M3 设计 §5 的口径）。

---

## 1. 范围

### 1.1 三个切片的做 / 不做

| 切片 | 做 | 不做 |
|---|---|---|
| **FE-a 清单** | `/task-lists/:id` 路由与 `TaskListView.vue`；`/tasks` 左栏「清单」（我的清单，缺省隐藏已归档，可切换显示）；新建 / 改名 / 归档 / 取消归档；成员对话框（read / edit、转让、移除、本人退出）；清单项（按任务 id 加入、移出）；清单内分组与摆放（拖拽 + 键盘）；「分配给我」视角下的个人分组；清单动态面板；详情页「所属清单」区（`listIds` + 加入 / 移出） | 清单删除（`R13`，无路由）；清单 `icon`；分组自身重排（后端不提供）；成员 / 任务选择器（沿用 M3 的 id 输入框）；跨清单搜索 |
| **FE-b 设置与编辑** | `/tasks/settings` 路由与 `TasksSettingsView.vue`：`badgeScope`、每日提醒、缺省提醒策略、时区（缺省填浏览器 IANA 名）；详情页编辑区（标题、描述、截止 / 开始日期与时间、时区、提醒时刻）走 `PATCH /api/tasks/:id`，带 `expectedVersion`，409 回滚提示 | 创建表单加日期（见 §12-Q3，缺省不加）；每日汇总预览；提醒投递状态（PR-3b 无路由） |
| **FE-c 红点、文案、接线** | `fetchPendingCount` 识别 `badgeScope: 'off'`，红点三态常驻节点加 `data-scope`；`useTasksBadge` 订阅 `tasks:counts-updated`，一个窗口里收到的信号合为一次重拉（FE-c，`[fe-51]`），轮询保留且是必需的另一半（§8.2）；`apps/web/src/tasks/labels.ts` + 中英 spec（`R20` 取 (a)：回填 M2 / M3 文案）；新 spec 登记到必跑脚本、token 清单与 `tasks-web-guard`（门 21 / 22） | 改 socket 服务端；改 `App.vue` 的 `navLabels` 表（入口文案留在壳层自己的表里）；接入待办中心（`R22`） |

### 1.2 依赖与起手时机

| 内容 | 依赖的后端 | 现在能做什么 | 何时能真机联调 |
|---|---|---|---|
| labels / i18n、API 客户端（全部函数）、红点 `off` | PR-3a S3（已建） | 全部（mock 测试 + 对 PR-3a 分支真跑） | 现在（本地起 PR-3a 分支，`TASKS_ENABLED=true`） |
| 设置页 | S3（已建） | 全部 | 现在 |
| 详情编辑（PATCH / 409） | S4（已建） | 全部 | 现在 |
| 清单、成员、清单项、动态 | S5–S7（**未建**） | 按 §3.2–§3.4 契约编码，测试全部 mock（M3 前端同样先于后端） | S5–S7 落地后 |
| 分组与摆放（两种 scope） | S8（**未建**） | 同上；可见集下标规则按 §3.5 编码 | S8 落地后 |
| 红点实时订阅 | PR-3c（FE-2 时未设计；现已在 Draft 分支建成，`3edd133ae0`） | FE-2：订阅骨架 + 轮询；FE-c：按 §8.3 重核并落改动 | 本地同时起 PR-3c 分支的后端与本分支的前端（未做，验证 MD 记 NOT RUN） |
| `listIds`、`version`、`description` 等详情新键 | S4 已建（`version` 自 M3 契约 §3.2 起就有）；`listIds` 随 S7 | 解析器按可选键写 | 现在 / S7 后 |

**顺序建议**：先做不依赖未建后端的部分（labels、API 客户端、红点、设置页、详情编辑），再做清单与分组（契约已定、代码可先写），实时订阅最后收口。详见 §13。

### 1.3 不在 M4 前端范围的既有残留（不做，只记）

- M3 设计 §6 的两条留白（当前用户 id 只在首次进详情时解析；Leave 按钮依赖 `canLeave` / `followers`）不动。M3 契约修订后详情已带 `followers` 与四个能力标志（§3.2），前端已按可选键接好。
- `/api/tasks/pending`（列表）仍无前端调用方。

---
## 2. 路由、入口与页面结构

### 2.1 路由表（全部走 #6173 的同一道门）

| 路径 | name | 组件 | meta | 说明 |
|---|---|---|---|---|
| `/tasks` | `tasks`（既有） | `TasksView.vue` | 不变：`{ title: 'Tasks', titleZh: '任务', requiresAuth: true, requiredFeature: 'tasks', permissions: ['tasks:read'] }` | 列表页加左栏「清单」与「分配给我」视角的个人分组 |
| `/tasks/settings` | `tasks-settings`（新） | `views/tasks/TasksSettingsView.vue` | `{ title: 'Task Settings', titleZh: '任务设置', requiresAuth: true, requiredFeature: 'tasks', permissions: ['tasks:read'] }` | 在 `appRoutes.ts` 里**写在 `/tasks/:id` 之前**。vue-router 4 的静态段得分高于参数段，写前面只是防御；spec 要有一格断言 `router.resolve('/tasks/settings').name === 'tasks-settings'`。`settings` 不可能是真实任务 id（任务 id 带 `tsk_` 前缀） |
| `/tasks/:id` | `task-detail`（既有） | `TasksView.vue` | 不变 | 详情页加编辑区与「所属清单」区 |
| `/task-lists/:id` | `task-list-detail`（新） | `views/tasks/TaskListView.vue` | `{ title: 'Task Lists', titleZh: '任务清单', requiresAuth: true, requiredFeature: 'tasks', permissions: ['tasks:read'] }` | meta 与 `/tasks` 同形；R-28 之后「同形」= 含 `requiredFeature: 'tasks'` |

- 没有 `/task-lists` 索引页：清单列表就是 `/tasks` 的左栏。
- 新路由**不加**焦点白名单（锁 §13-37 缺省），`attendanceFocused` / `plmWorkbenchFocused` 下照常重定向（门 22 现有的焦点格对新路径各复制一格）。
- `KNOWN_REQUIRED_FEATURES`、`router/types.ts`、`guardPolicy.ts`、`featureFlags.ts`、`routes/auth.ts` **零改动**：`'tasks'` 已在列，payload 键已登记。
- 权限码仍只有 `tasks:read` 进 meta；`tasks:write` 由后端判，前端按能力标志 / 角色隐藏控件（§5）。

### 2.2 入口

- 顶栏不新增入口。`/tasks/settings` 的入口是 `/tasks` 页头的「设置」链接（`data-testid="tasks-settings-link"`）；`/task-lists/:id` 的入口是左栏清单名。两者都只在 `TasksView` 的 `ready` 态内渲染，于是自然在 `canUseTasks` 之内。
- `App.vue` 不改（`navLabels` 表、`canUseTasks`、`TasksTodoBadge` 挂载都不动）。`tasks-nav-feature-gate.spec.ts` 钉的「feature-on 壳层完整请求序列」因此不变。
- 红点组件 `TasksTodoBadge.vue` 只加 `data-scope` 属性与 `off` 的呈现（§8），挂载条件不变。

### 2.3 是否先拆 `TasksView.vue`：**不拆既有代码，新面全部以子组件 / 新路由组件落地**（`[fe-01]`）

理由：

1. 14 个守卫里有 6 个（`tasks-view`、`tasks-list-view`、`tasks-detail-view`、`tasks-detail-m3`、`tasks-view-transitions`、`tasks-nav-badge` 之外的那几个真机 mount）把 `/tasks` ↔ `/tasks/:id` **同一组件实例复用**当作前提：`watch(taskId)` 的边沿处理、`listPageToken` / `detailActionToken` 的「离开又回来」用例（M3 设计 §3.6）都靠两条路由指向同一个 `component` 引用。把详情拆成独立路由组件会让实例在导航时销毁重建，这些用例的形状全要重写——这是纯迁移风险，M4 得不到任何功能收益。
2. 把既有 M3 的五个 section 抽成子组件也是零功能收益：它们共享 `detailActionPending` / `detailActionToken` / `loadDetail` / `applyDetailFailure`，抽出去要么 provide/inject 一堆状态，要么 props/emit 回传——每一处都是现有 60 个变异用例覆盖的守卫面。
3. M4 真正新增到 `TasksView.vue` 的是四件事：三个与 M3 handler 同形的写 handler（`onPatchTask`、`onAddTaskToList`、`onRemoveTaskFromList`，共用 `detailActionToken` / `detailActionPending`，各约 40 行）；两份父组件持有的详情页状态（编辑器的 `editorState`、「我的清单」读 `myListsResult` 及其 generation——理由见 §4.3：详情分支整个包在 `v-if="detailResult.kind === 'ok'"` 里（`TasksView.vue:27`），而 `loadDetail` 第一步就把 `detailResult` 置回 `loading`（`:689-697`），子组件自持的草稿会在每次重拉时随卸载丢失）；一个 `watch(detailResult)` 把重拉结果同步进 `editorState`；三个挂载点（左栏 `TaskListsSidebar`、详情区 `TaskDetailEditor` / `TaskDetailLists`、「分配给我」视角的 `TaskPersonalGroups`）。文件从 1426 行涨到约 1600 行，仍可读；既有函数体零改动，`watch(taskId)` 的复位块只追加两行（`editorState` 与 `myListsResult` 复位）。

所以：

| 新组件 / 模块 | 位置 | 归属 | 自己持有的状态 |
|---|---|---|---|
| `TaskListsSidebar.vue` | `views/tasks/` | 挂在 `TasksView` 列表分支 | 清单列表（分页）、已归档开关、新建表单、自己的加载 / 错误态 |
| `TaskPersonalGroups.vue` | `views/tasks/` | 挂在 `TasksView` 列表分支的 `listResult.kind === 'ok'` 分支内，仅 `currentView === 'assigned'` 时（替换该视角下的既有 `<ul>`） | 两个分组读（各自 generation）、摆放、排序中状态；接收 `items`（父组件的列表结果）作 prop；分组读未完成或失败时自己渲染平铺 `<ul data-testid="tasks-list">`，分组读成功时渲染 `TaskGroupBoard`，其根容器同样带 `data-testid="tasks-list"`（§2.4、§4.6） |
| `TaskDetailEditor.vue` | `views/tasks/` | 挂在 `TasksView` 详情分支 | **无状态**：草稿、预检结果、409 冲突态由父组件的 `editorState` 持有，以 props 传入、`emit('update:draft')` 回传；**不发请求**，`emit('submit', patch)` / `emit('discard')`，由父组件的 `onPatchTask` 走共享的 token / pending |
| `TaskDetailLists.vue` | `views/tasks/` | 挂在 `TasksView` 详情分支 | **无状态**：接收 `listIds`、`myLists`（父组件的 `myListsResult`）与 `pending`；只做名字映射、候选下拉与两步确认的本地 UI 态；`emit('add', listId)` / `emit('remove', listId)`，写由父组件的 `onAddTaskToList` / `onRemoveTaskFromList` 走共享的 `detailActionToken` / `detailActionPending` |
| `TaskListView.vue` | `views/tasks/` | **新路由组件** `/task-lists/:id` | 清单详情、成员对话框、分组板、动态；完全独立于 `TasksView` |
| `TaskListMembersDialog.vue` | `views/tasks/` | `TaskListView` 子组件 | 成员列表、角色改动、转让、移除 |
| `TaskGroupBoard.vue` | `views/tasks/` | `TaskListView` 与 `TaskPersonalGroups` 共用（props 区分 scope） | 分组、摆放、拖拽 / 键盘重排的本地快照 |
| `TasksSettingsView.vue` | `views/tasks/` | **新路由组件** `/tasks/settings` | 设置表单 |
| `tasks/labels.ts` | `src/tasks/` | 文案表（§9） | — |
| `tasks/useTasksCountsRealtime.ts` + `tasks/tasksRealtimePolicy.ts` | `src/tasks/` | 订阅骨架（§8）；策略模块只导出 `shouldAutoConnectRealtime()`，供 spec 用 `vi.mock` 替换（§8.2） | socket 生命周期 |
| `tasks/tasksDraft.ts` | `src/tasks/` | 纯函数：草稿初始化与规范化（`initDraft`、`createEditorState`）、日期 / 时区 / 提醒 / 描述的客户端预检、PATCH 体组装（§3.3、§7.3），无 I/O | — |

后续若 owner 要把 `TasksView.vue` 拆开，建议作为 M4 之后的独立清理片（§12-Q1），届时同时重写上述 6 个守卫，而不是夹在功能片里。

安全网（即使不拆也要有）：每片结束跑全部 `tasks*.spec.ts` + `vue-tsc -b`；既有 spec 文件只允许加 mock 条目（M3 设计 §4.1 的「连带修复」口径），**断言不改**；改到的既有 spec 文件在验证 MD 里逐个列出 diff 行数。

### 2.4 页面结构

**`/tasks`（列表页）**

```
header: 「任务」 + [设置] 链接
main:  左栏 TaskListsSidebar            | 右栏（既有）视角切换 / 创建表单 / 列表
       - [新建清单] 表单                 |   currentView === 'assigned' 时列表由
       - 清单项（名、我的角色、已归档标） |   TaskPersonalGroups 按个人分组渲染
       - [显示已归档] 开关 / [加载更多]   |   其余视角：既有平铺 <ul data-testid="tasks-list">
```

- 「分配给我」视角的状态表（`[fe-16]`；每行对应 §10.1 `tasks-groups.spec.ts` 一格）。既有守卫在这个缺省视角里直接钉 `data-testid="tasks-list"` 容器的有无（`tasks-list-view.spec.ts:134`、`:165`、`:383`、`:406`，`tasks-detail-view.spec.ts:628`），`tasks-view.spec.ts:85-110` 还钉 TESTIDS 的精确集合，所以容器 testid 与五态归属都不能变：

  | 父组件 `listResult` | 视角 | 渲染 |
  |---|---|---|
  | `loading` / `empty` / `error` | 任意 | 既有分支不变（`tasks-list-loading` / `tasks-list-empty` / `tasks-list-error` 由 `TasksView` 渲染）；`TaskPersonalGroups` **不挂载**，不发分组读 |
  | `ok`（非空） | 非 `assigned` | 既有平铺 `<ul data-testid="tasks-list">`，零改动 |
  | `ok`（非空） | `assigned` | 挂载 `TaskPersonalGroups`，它在挂载时发两个分组读（`GET /api/task-groups`、`GET /api/task-groups/items`，各自 generation）。两读未都完成，或任一失败 ⇒ 渲染平铺 `<ul data-testid="tasks-list">`（`data-testid` 集合、文案、`tasks-list-item` 顺序与既有 `<ul>` 相同；失败时另加一条 `data-testid="tasks-groups-unavailable"` 提示）；两读都 `ok` ⇒ 渲染 `TaskGroupBoard`，**根容器带 `data-testid="tasks-list"`**，分组 `<section data-testid="tasks-group">` 在其内。板不渲染 TESTIDS 里的任何其他 id |

- 列表项仍是 `data-testid="tasks-list-item"`（既有 spec 用 `querySelectorAll` 取）。无摆放行的任务显示在默认组的「未排序」尾段（§6.3），顺序 = 服务端顺序，于是**没有自建分组、没有任何摆放行时，渲染出的 `tasks-list` 容器与 `tasks-list-item` 序列与今天相同**——这正是 FE-7 给既有 spec 的 mock 工厂补「合成默认组 + 空摆放」后它们仍绿的依据（§9.4）。
- `loadList` 每次都先把 `listResult` 置回 `loading`（既有代码），所以每次列表重拉成功后 `TaskPersonalGroups` 重新挂载并重读两面；首屏与重拉走同一路径，没有「并行于 `loadList`」的第二条读序。分组读失败只降级为平铺，不影响任务列表本身。

**`/tasks/:id`（详情页，既有 section 顺序不变）**

在「子任务」section 之前插入：

```
<section data-testid="tasks-detail-editor">        标题 / 描述 / 截止日期+时间 / 开始日期+时间 / 时区 / 提醒
<section data-testid="tasks-detail-lists">         所属清单：listIds（有名字显示名字，否则显示 id）
                                                   [加入清单] 下拉（我的 edit/owner 清单）  [移出]
```

- 编辑区只在 `canEditTask`、详情带 S4 四键组且带 `version` 时渲染（闸审之后更正：main 上 M3 的详情体也带 `version`；`PATCH /api/tasks/:id` 与 S4 四键在 PR-3a 的同一片里出现，四键组才说明后端有这条路由）；否则显示只读的新字段（描述、开始日期、提醒，带 S4 四键组时）。
- 「所属清单」只在 `listIds !== undefined` 时渲染（S7 之前的后端不给这个键）。
- 两个新区都在既有 `v-if="detailResult.kind === 'ok'"` 块内（section 顺序不变），但它们的状态不在组件内：`loadDetail` 第一步把 `detailResult` 置回 `loading`，块内子组件会在每次重拉（M3 动作成功后、PATCH 成功 / 409 后）卸载再重建，所以草稿、冲突态与「我的清单」读由 `TasksView` 持有（§4.3，`[fe-15]`）。

**`/task-lists/:id`（清单页）**

```
header: 清单名（可改名：内联表单） | 我的角色 | [归档]/[取消归档] | [成员] | [动态]
main:   TaskGroupBoard（scope='list'）：每个分组一个 <section>，组内任务行可拖拽 / 键盘移动
        [加入任务] 表单（输入任务 id）  [新建分组] 表单
aside:  动态面板（分页，加载更多）
dialog: TaskListMembersDialog（role="dialog"，Esc 关闭，焦点回到触发按钮）
```

**`/tasks/settings`（设置页）**：一张表单 + 保存按钮 + 回到 `/tasks` 的链接（§7.1）。

### 2.5 不变的东西（写明以便门审）

- `GET /api/tasks/context` 仍是每个任务页面的第一读；`TaskListView` 与 `TasksSettingsView` 同样先读 context，复用 `tasksContext.ts` 的五态渲染（`unavailable` / `forbidden` / `error` / `org_missing` 的文案与 `TasksView` 相同）。
- 不复制审批的 `USE_MOCK`，不引入新的 HTTP 客户端，全部走 `apiFetch`。

---
## 3. API 客户端（`tasksApi.ts` 的 M4 追加）

### 3.1 共性

- 每个函数返回判别联合、**从不抛错**，沿用 M2 / M3 的 `kind` 命名：`ok` / `not_found`（404）/ `forbidden`（403）/ `org_missing`（写 422 `ORG_MISSING`，或集合读的 `degraded: true, reason: 'org_missing'`）/ `validation`（其余 422，带 `code`）/ `conflict`（409，带 `code`）/ `predicate_error`（集合读）/ `error`（含 `status`，传输失败为 0）。
- **既有函数只按枚举扩**：`createTask` / `getTask` / `listTasks` / `fetchPendingCount` 的扩展只认 §3.2 列出的键与码。`createTask` 只把列出的 422 码映射为 `validation`，任何未列出的 422 码仍是 `{ kind: 'error', status: 422 }`（`tasks-api.spec.ts:239-241` 钉着 `VALIDATION_FAILED` ⇒ `error`，继续作回归锚点）；`fetchPendingCount` 对未知键仍忽略。上一条的「其余 422 归 `validation`」只对 M4 新函数成立。
- **路径段规则**：每个放进请求路径的 id（任务、清单、分组、用户）在构造请求前先过 `isPathSafeSegment`；任务 / 清单 / 分组 id 不通过返回 `not_found`，用户 id 不通过返回 `validation`，码为该端点自己的成员码（清单成员路由 `INVALID_MEMBER`，任务负责人 / 关注人路由沿用 `INVALID_ASSIGNEES`）。每个新写函数都如此，读函数同样如此。
- 写失败分类沿用 `classifyWriteFailure`，只扩一处：409 体若带整数 `currentVersion`，`conflict` 变体多带 `currentVersion?: number`（只对正整数解析；缺失或非法时不带，调用方按「冲突但版本未知」处理，同样重拉）。
- 成功体全部经严格解析器（同 `parseTaskDetail` 的纪律：每个字段都查、闭集字面量逐个比、多余键忽略、缺键或错型即 `error`）。解析器以 `parseXxx(value: unknown): Xxx | null` 导出，spec 直接喂 malformed 体。
- 分页：所有 M4 集合端点的 ok 结果为 `{ items, total }`，`total` 必须是非负整数。新端点的 `limit` 固定 100（等于服务端上限）、`offset` 由调用方传；不发 `limit` 以外的值，所以 `INVALID_LIMIT` / `INVALID_OFFSET` 在前端只可能是契约漂移，归入 `error`。「读全部页」的函数复用 `listComments` 的循环形状（按 id 去重、`isSuperseded` 提前停止、`MAX_PAGES` 上限——取 20，沿用 `COMMENTS_MAX_PAGES` 的值，是本件自选 `[fe-13]`——`items.length < total` 表示截断），抽成私有 `collectPages(fetchPage, keyOf, options)`；`listComments` 本身**不改**（M3 代码），只是新函数不再重复写循环。
- 降级体（`degraded: true`）没有 `total`，集合读要先判 `degraded` 再判 `items` / `total`。
- `resolveViewerTimeZone()` 从私有改为导出（设置页与编辑器缺省时区用它），行为不变。

### 3.2 函数表

**任务（既有前缀，S4 已建）**

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `patchTask(id, patch)` | `PATCH /api/tasks/:id` | `{ expectedVersion, title?, description?, dueDate?, dueTime?, startDate?, startTime?, timeZone?, remindAt? }`；只发调用方给出的键（`undefined` 不序列化） | `{ id, version }`（`version` 正整数） | `not_found`、`forbidden`、`org_missing`；`validation`：`INVALID_VERSION` `INVALID_TITLE` `INVALID_DESCRIPTION` `INVALID_DATE` `INVALID_TIME_ZONE` `TIME_ZONE_REQUIRED` `INVALID_REMIND_AT`；`conflict`：`VERSION_CONFLICT` + `currentVersion`；`error` |
| `createTask(input)`（扩） | `POST /api/tasks` | M2 三键 + 可选 `dueDate` `dueTime` `startDate` `startTime` `timeZone` `remindAt`（同样「不给不发」） | `{ id, version? }`（`version` 可选：PR-3a 合并前的 main 不回它） | 既有 `invalid_title` / `org_missing` 不变；新增 `validation` **只对枚举的码**：`INVALID_DATE` `INVALID_TIME_ZONE` `TIME_ZONE_REQUIRED` `INVALID_REMIND_AT` `INVALID_ASSIGNEES` `INVALID_MODE` `INACTIVE_ORG_MEMBER`（PR-3a S9：负责人里有不在本 org 在职的人）`LIMIT`；任何其他 422 码仍是 `{ kind: 'error', status: 422 }`（allowlist 语义；既有 `tasks-api.spec.ts:239` 的 `VALIDATION_FAILED` 格不改）。创建表单本期不发日期键，所以这些码在 UI 上只有通用文案 |
| `getTask(id)`（扩） | 不变 | — | `TaskDetail` 新增：`version?`（正整数）、`description?`（string\|null）、`startDate?` `startTime?` `remindAt?`（string\|null）、`listIds?`（string[]）、`canManageMembers?`（boolean，FE-8：PR-3a 的详情恒带此键，main 上 M3 的详情体没有）。全部可选、出现即校验型；`description` / `startDate` / `startTime` / `remindAt` 作一组（任一出现则四个都须在，同 M3 树字段的组规则；今天的 S4 后端四键同批给出） | 不变 |
| `listTasks(view, page?)`（扩） | `GET /api/tasks?view=…[&limit=&offset=]` | — | `{ items, total? }`：不传 `page` 时请求串与今天逐字节相同；`total` 出现时须是非负整数，缺失时为 `undefined`（PR-3a 合并前的 main 不回它） | 不变 |
| `completeTask` / `reopenTask` | 不变 | — | 多出的 `version` 键忽略（不解析，不依赖） | 不变 |
| `fetchPendingCount()`（扩） | 不变 | — | `{ count, badgeScope?: 'off' }`：体里 `badgeScope === 'off'` 且 `count` 为 0 ⇒ 带 `badgeScope: 'off'`；`badgeScope` 为 `'off'` 而 `count` 不为 0 ⇒ `error`（自相矛盾的体）；`badgeScope` 缺失、为 `'overdue'` / `'overdue_or_today'`、或为任何其他值 ⇒ 不带键、`count` 照常（容忍解析，`[fe-14]`：「这个键只在 `off` 时出现」是 PR-3a 的 `[own-11]`，仍在其 §12-Q12 待裁；owner 若改为常规响应也带键，前端不需要改。M3 解析器对未知键一向忽略，严格判 `error` 会让整个红点变成「不可用」） | 不变 |

**设置（S3 已建）**

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `getTaskSettings()` | `GET /api/task-settings` | — | `Settings = { badgeScope: 'off'\|'overdue'\|'overdue_or_today', dailyReminderEnabled: boolean, defaultRemindPolicy: { mode: 'default'\|'none' }, timeZone: string\|null }`（`parseTaskSettings`，闭集逐个比） | `not_found`（404：路由不存在**或**缺 org，契约不区分）、`forbidden`、`error` |
| `patchTaskSettings(patch)` | `PATCH /api/task-settings` | `Settings` 的任意子集；`timeZone: null` 表示清空；不发 `undefined` 键 | 合并后的 `Settings` | `org_missing`、`forbidden`、`not_found`；`validation`：`INVALID_SETTINGS` `INVALID_BADGE_SCOPE` `INVALID_DAILY_REMINDER_ENABLED` `INVALID_POLICY` `INVALID_TIME_ZONE` `DAILY_REMINDER_REQUIRES_TIME_ZONE`；`error` |

**清单（S5，未建）**。`TaskList = { id, name, createdBy, ownerId, archivedAt: string|null, createdAt, updatedAt, myRole: 'read'|'edit'|'owner' }`。

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `listTaskLists({ includeArchived, offset })` | `GET /api/task-lists?includeArchived=true\|false&limit=100&offset=N` | — | `{ items: TaskList[], total }` | `org_missing`（降级体）、`forbidden`、`not_found`、`error`（422 `INVALID_FILTER` / 分页码归此） |
| `createTaskList(name)` | `POST /api/task-lists` | `{ name }` | `TaskList`（`myRole` 为 `owner`） | `org_missing`、`forbidden`、`not_found`；`validation`：`INVALID_NAME` `NAME_TOO_LONG`；`error` |
| `getTaskList(id)` | `GET /api/task-lists/:id` | — | `TaskList` | `not_found`（含非成员、他 org）、`forbidden`、`error` |
| `renameTaskList(id, name)` | `PATCH /api/task-lists/:id` | `{ name }` | `TaskList` | `not_found`、`org_missing`；`validation`：`INVALID_NAME` `NAME_TOO_LONG` |
| `archiveTaskList(id)` / `unarchiveTaskList(id)` | `POST /api/task-lists/:id/archive` / `…/unarchive` | — | `TaskList` | `not_found`、`org_missing`、`forbidden`、`error`（空操作仍 200） |
| `listTaskListEvents(id, { offset })` | `GET /api/task-lists/:id/events?limit=100&offset=N` | — | `{ items: [{ id, listId, actorId, eventType, payload, occurredAt }], total }`；`eventType` 只校验为字符串（闭集 15 个词由后端保证，前端对未知词显示原词） | `not_found`、`forbidden`、`org_missing`（降级体，§4.2）、`error` |

**清单成员（S6，未建）**。成功体统一 `{ id, members: [{ userId, role }] }`。

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `listTaskListMembers(id)` | `GET /api/task-lists/:id/members?limit=100&offset=N`，读全部页（上限 100 人，一页即满） | — | `{ items: [{ userId, role, createdAt }], total }` | `not_found`、`forbidden`、`org_missing`（降级体）、`error` |
| `addTaskListMember(id, userId, role)` | `POST /api/task-lists/:id/members` | `{ userId, role: 'read'\|'edit' }` | `{ id, members }` | `not_found`、`org_missing`；`validation`：`INVALID_MEMBER` `INVALID_ROLE` `INACTIVE_ORG_MEMBER` `LIMIT` |
| `changeTaskListMemberRole(id, userId, role)` | `PATCH /api/task-lists/:id/members/:userId` | `{ role }` | 同上 | `not_found`（含目标不是成员）；`validation`：`INVALID_MEMBER` `INVALID_ROLE` `OWNER_MUST_TRANSFER` |
| `removeTaskListMember(id, userId)` | `DELETE /api/task-lists/:id/members/:userId` | — | 同上 | `not_found`；`validation`：`INVALID_MEMBER` `CREATED_BY_IMMUTABLE` `OWNER_MUST_TRANSFER` |
| `transferTaskListOwner(id, userId)` | `POST /api/task-lists/:id/transfer-owner` | `{ userId }` | 同上 | `not_found`；`validation`：`INVALID_MEMBER` `TARGET_NOT_MEMBER` `INACTIVE_ORG_MEMBER` |

**清单项（S7，未建）**

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `listTaskListItems(id, options)` | `GET /api/task-lists/:id/items?limit=100&offset=N`，读全部页（`MAX_PAGES` 20，截断时 `items.length < total`） | — | `{ items: TaskListItem[]（snake_case 六列，复用 M2 类型）, total }` | `not_found`、`forbidden`、`org_missing`（降级体）、`error` |
| `addTaskToList(id, taskId)` | `POST /api/task-lists/:id/items` | `{ taskId }` | `{ listId, taskId }` | `not_found`（三个授权条件任一不满足）、`org_missing`；`validation`：`INVALID_TASK` `LIMIT` |
| `removeTaskFromList(id, taskId)` | `DELETE /api/task-lists/:id/items/:taskId` | — | `{ listId, taskId }` | `not_found`、`org_missing`、`error` |

**分组（S8，未建）**。`Group = { id: string|null, scope: 'list'|'user', name, position: number, isDefault: boolean }`（`id` 只在个人 scope 的合成默认组为 `null`，清单 scope 的 `null` 判为 malformed）；`Placement = { groupId: string, taskId: string, position: number }`。

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `listTaskListGroups(id)` | `GET /api/task-lists/:id/groups?limit=100&offset=0`（上限 50，一页） | — | `{ items: Group[], total }` | `not_found`、`forbidden`、`org_missing`（降级体）、`error` |
| `createTaskListGroup(id, name)` | `POST /api/task-lists/:id/groups` | `{ name }` | `Group` | `not_found`、`org_missing`；`validation`：`INVALID_NAME` `NAME_TOO_LONG` `LIMIT` |
| `renameTaskListGroup(id, groupId, name)` | `PATCH /api/task-lists/:id/groups/:groupId` | `{ name }` | `Group` | `not_found`、`org_missing`；`validation`：`INVALID_NAME` `NAME_TOO_LONG` |
| `deleteTaskListGroup(id, groupId)` | `DELETE /api/task-lists/:id/groups/:groupId` | — | `{ id, deleted: true, reassignedTo }` | `not_found`、`org_missing`；`validation`：`IS_DEFAULT` |
| `listTaskListGroupItems(id, options)` | `GET /api/task-lists/:id/group-items?limit=100&offset=N`，读全部页 | — | `{ items: Placement[], total }` | `not_found`、`forbidden`、`org_missing`（降级体）、`error` |
| `placeTaskInListGroup(id, taskId, groupId, position)` | `PUT /api/task-lists/:id/group-items/:taskId` | `{ groupId: string\|null, position }` | `{ taskId, groupId, position }` | `not_found`、`org_missing`；`validation`：`INVALID_GROUP` `INVALID_POSITION` |
| `listUserGroups()` | `GET /api/task-groups?limit=100&offset=0` | — | `{ items: Group[], total }`（恰一个 `isDefault`，其 `id` 可为 `null`） | `org_missing`（降级体）、`forbidden`、`not_found`、`error` |
| `createUserGroup(name)` | `POST /api/task-groups` | `{ name }` | `Group` | 同清单 scope 建组 |
| `renameUserGroup(groupId, name)` | `PATCH /api/task-groups/:groupId` | `{ name }` | `Group` | `not_found`、`org_missing`；`validation`：`INVALID_NAME` `NAME_TOO_LONG` |
| `deleteUserGroup(groupId)` | `DELETE /api/task-groups/:groupId` | — | `{ id, deleted: true, reassignedTo }` | `not_found`、`org_missing`；`validation`：`IS_DEFAULT` |
| `listUserGroupItems(options)` | `GET /api/task-groups/items?limit=100&offset=N`，读全部页 | — | `{ items: Placement[], total }` | `org_missing`（降级体）、`forbidden`、`not_found`、`error` |
| `placeTaskInUserGroup(taskId, groupId, position)` | `PUT /api/task-groups/items/:taskId` | `{ groupId: string\|null, position }` | `{ taskId, groupId, position }`（`groupId` 是落行后的真实 id） | `not_found`（任务不在本人 assigned 臂）、`org_missing`；`validation`：`INVALID_GROUP` `INVALID_POSITION` |

### 3.3 客户端预检（纯函数，`tasks/tasksDraft.ts`）

与 `checkCommentBody` 同一定位：省一次往返、让同一个码走同一条文案映射；**服务端 422 仍是准绳**。全部无 I/O，spec 直接喂值。

| 函数 | 规则（镜像 PR-3a §5.1 与 S4 实现） | 返回码 |
|---|---|---|
| `initDraft(task)` | 把服务端形状规范化成控件形状，**比较与发送都只用这一种形**（`[fe-17]`）：`dueTime` / `startTime` 取 `value ? value.slice(0, 5) : null`（服务端 `due_time::text` 回 `HH:MM:SS`，`TaskDetail.dueTime` 的契约形就是它，`tasksDateDisplay.ts:46` 今天已经这样截；`input[type=time]` 的值与 PATCH 体都是 `HH:MM`，服务端落回 `HH:MM:SS`）；`description` 取 `task.description ?? ''`（服务端把 `''` 存 `NULL`、回 `null`；S4.2 验证写明 `''` 对 `NULL` 是空操作）；`timeZone` 取 `task.timeZone ?? ''`；`remindAt` 原样，另带 `remindTouched: false`；其余键原样 | — |
| `checkTaskTitle(raw)` | NFC + 去两端 White_Space 与零宽字符后非空；无 U+0000、无孤立代理项 | `INVALID_TITLE` |
| `checkTaskDescription(raw)` | 不修剪、不归一；码点数 ≤ 20000（`Array.from`）；无 U+0000、无孤立代理项；`''` 视为清空（发 `''`，服务端存 `NULL`）；比较时 `''` 与服务端的 `null` 等价（`initDraft` 已归一） | `INVALID_DESCRIPTION` |
| `checkTaskDates(draft)` | `dueDate` / `startDate` 为 `YYYY-MM-DD` 且是真实日期（用 `Date.UTC` 回算年月日逐一相等，不信任 `Date` 的溢出）；`dueTime` / `startTime` 为 `HH:MM`（草稿里只有这一种形：`initDraft` 截过，控件 `step=60` 只产出它；客户端也只发这一种形）且 `00..23` / `00..59`；有时间必须有同名日期；合并后只要有任一日期就必须有时区——此时 `timeZone` 为非空字符串且 `Intl.DateTimeFormat(undefined, { timeZone })` 不抛；合并后**没有日期时允许时区为空**：`buildTaskPatch` 发 `timeZone: null` 清掉它（服务端把 `''` 与 `null` 都读作「无时区」`[own-29]`，客户端只发 `null`） | `INVALID_DATE` `TIME_ZONE_REQUIRED` `INVALID_TIME_ZONE` |
| `checkRemindAt(raw)` | `null` 通过；否则必须是 `Date#toISOString()` 的文法（`YYYY-MM-DDTHH:MM:SS.sssZ`）且年份 0001–9999 | `INVALID_REMIND_AT` |
| `buildTaskPatch(current, draft)` | 比较对象是 `initDraft(current)` 与 `draft`（两边都是规范形：时间 `HH:MM`、描述 `null` ≡ `''`、时区 `null` ≡ `''`），只放入不同的键，所以 `'10:00:00'` 对 `'10:00'`、`null` 描述对 `''` 从不算改动；四个日期键任一入列且合并后仍有日期时**同时放入 `timeZone`**（草稿值或现值）；合并后没有日期而时区被清空 ⇒ 只放 `timeZone: null`；清掉 `dueDate` 时若现值有 `dueTime` 则同体放入 `dueTime: null`（`startDate` 同理）；只换时区时只放 `timeZone`；`description` 清空发 `''`；`remindAt` 只在 `remindTouched` 时放入（从不派生）；全部不变 ⇒ `null`（不发请求） | — |
| `checkSettingsDraft(draft)` | `badgeScope`、`defaultRemindPolicy.mode` 在闭集内；`dailyReminderEnabled` 为真时 `timeZone` 非空；`timeZone` 非空时同上的 `Intl` 校验 | `INVALID_BADGE_SCOPE` `INVALID_POLICY` `DAILY_REMINDER_REQUIRES_TIME_ZONE` `INVALID_TIME_ZONE` |
| `checkListName(raw)` / `checkGroupName(raw)` | 同标题的归一；码点数 ≤ 100 | `INVALID_NAME` `NAME_TOO_LONG` |

时区的大小写变体（`asia/shanghai`）客户端不拒：服务端落规范名（`D7`），响应回来再显示规范名。

---
## 4. 各页面的状态设计

### 4.0 通用规则

- **五态**：每个读面都有 `loading` / `ok` / `empty` / `error` / `not_found`，另加 `forbidden`（403）与 `org_missing`（引导块）。`empty` 与 `error` 必须可区分（M2 的既有要求：空列表与读失败不得同形）；`not_found` 与 `forbidden` 各自有 `data-testid`。
- **悲观更新为缺省**：写成功后重拉受影响的读面，不本地合并响应（M3 §3.2 的理由：响应形状比详情窄）。唯一的乐观更新是分组板的重排（§4.4），因为拖放后立刻回弹会让操作看起来失败。
- **晚到结果守卫**：每个读面一个 generation（`xxxGeneration += 1; const mine = …; await; if (mine !== xxxGeneration) return`）；每个写面一个 token（动作开始 `++token`，`finally` 只在 `token` 仍是自己时解除 pending；路由边沿 `token += 1`）。新组件各自持有自己的 generation / token；`TasksView` 既有的 `detailActionToken` 被 `onPatchTask`、`onAddTaskToList`、`onRemoveTaskFromList` 复用（详情页的每一个写都在同一互斥域——M3 设计 §3.8 的规则，不按 section 分 token）。
- **一次一个动作**：每个路由组件一个 pending 域。详情页：全部写（M3 五区、M4 的 PATCH 与清单项加入 / 移出）都由 `TasksView` 的 handler 发起，共用 `detailActionPending` / `detailActionToken`；子组件不自发写请求，只接收 `pending` prop 禁用自己的控件（一个 prop 不能被子组件「占住」，所以子组件自己发请求的方案做不到互斥）。`TaskListView`：自己持有 `pending`，`TaskGroupBoard` 与 `TaskListMembersDialog` 以 `v-model:pending` 共享同一个布尔（子组件写开始 / 结束时 `emit('update:pending')`，各自保留自己的 token 判晚到），于是页面上任何一处在写，其余控件全部 `disabled`、拖拽句柄不可拖（`draggable=false`）。`TaskPersonalGroups`、`TaskListsSidebar`、`TasksSettingsView` 各自独立（互不共享资源）。
- **错误落点**：`validation` / `conflict` 渲染在引发它的控件旁（各自的 `data-testid="…-error"`），文案由码映射（§9.2）；`not_found` / `forbidden` / `error` 走该页面的通用横幅（与 M3 的 `actionErrorKind` 同形）；`org_missing` 切到引导块。未知码回退「操作失败，请稍后重试」。
- **路由边沿复位**：所有草稿、行内错误、打开中的对话框在 `watch(route.params.id)` 的边沿复位（`TasksView.vue:1310` `watch(taskId)` 复位块的推广：它在每次 id 边沿清 `actionErrorKind`、`detailActionToken += 1`、`listPageToken += 1`、`listGeneration += 1` 并复位各 section 的本地态；M3 设计本身没有单独的「复位」一节，边沿语义见其 §3.6）；新路由组件自身在 id 变化时同样复位（`/task-lists/a` → `/task-lists/b` 复用实例）。
- **非写的就地切换与焦点**（闸审之后，`[fe-50]`）：两步确认与行内改名表单替换了打开它的按钮，取消又把按钮换回来；被操作的控件消失，浏览器把焦点落到页面 `body`。打开确认 ⇒ 焦点到确认按钮（它的 `aria-describedby` 指向提示句）；打开改名表单 ⇒ 焦点到输入框；取消 ⇒ 焦点回到换回来的按钮；编辑区「放弃我的修改」拿走了自己的按钮 ⇒ 焦点到编辑区标题（`tabindex="-1"`）。适用于清单页的移出确认与改名、分组板的删组确认与改组名、详情页「所属清单」区的移出确认；共用 `tasks/tasksFocus.ts` 的 `focusAfterSwap`。详情页 M3 的删除确认在 main 上，不在本件改；写之后的页面级焦点仍是 §12-Q35；改名表单不加 Esc 取消。

### 4.1 `/tasks` 左栏（`TaskListsSidebar`）

| 读 / 写 | 状态 | 处理 |
|---|---|---|
| `listTaskLists({ includeArchived })` | `loading` → `ok` / `empty`（「还没有清单」）/ `error` / `org_missing`（上报父组件的 `orgMissingFromAction`，与列表读同一引导块） | 分页：每页 100，底部「加载更多」直到 `items.length === total`；切换「显示已归档」从 offset 0 重读、generation +1 |
| `createTaskList` | `pending`；`validation` 行内（`INVALID_NAME` / `NAME_TOO_LONG`，预检先行）；成功清空输入、重读第一页、`router.push('/task-lists/:id')` | 成功不发 `notifyTasksChanged`（红点不看清单） |
| 列表项 | 显示名、`myRole` 徽标（所有者 / 可编辑 / 只读）、已归档标 | 点击 = `router-link` 到 `/task-lists/:id` |

- `data-testid` 一律以 `tasks-lists-` 为前缀（`tasks-lists-sidebar` / `tasks-lists-loading` / `tasks-lists-empty` / `tasks-lists-error` / `tasks-lists-item` / `tasks-lists-create-form` / `tasks-lists-archived-toggle`），不与 `tasks-view.spec.ts:85-97` TESTIDS 里的任何 id 同名：左栏在列表分支常驻，`listResult` 为 `empty` 时它也在，而该 spec 的 `shown()` 按属性值精确匹配后断言精确集合（如 `['tasks-list-empty']`），不同名即不入集合（`[fe-18]`）。左栏的 `useRouter()` 在 `tasks-view.spec.ts:24-27` / `tasks-list-view.spec.ts:25-28` 的假 `vue-router` mock 里已有（M3 §4.1 补的 `{ push: vi.fn() }`），不需要再补。

### 4.2 `/task-lists/:id`（`TaskListView`）

读序：`loadTasksContext` → 并行 `getTaskList(id)`、`listTaskListItems(id)`、`listTaskListGroups(id)`、`listTaskListGroupItems(id)`；成员与动态按需（打开对话框 / 展开面板时读）。

| 面 | 状态 | 备注 |
|---|---|---|
| 清单行 | `loading` / `ok` / `not_found`（「清单不存在或你不是成员」）/ `forbidden` / `error` | 契约把非成员、他 org、不存在都折成 404，文案只能合写 |
| 清单项 + 分组 + 摆放 | 三读各自 generation；三者都 `ok` 才渲染分组板；任一 `error` ⇒ 板渲染为「平铺列表 + 提示」，不隐藏任务 | 截断（`items.length < total`，超过 20 页）⇒ 板渲染但**禁用重排**，提示「清单过大，排序已停用」 |
| 任一集合读回 `org_missing`（降级体，PR-3a §3.0） | 与 context 的 `org_missing` 同一引导块 | 实际不可达：`loadTasksContext` 先行，同一会话不会中途丢 org；写在这里只为解析器与状态表完备 |
| 改名 | 内联表单；`pending`；`validation` 行内；成功重读清单行 | 同名空操作仍 200，照常重读 |
| 归档 / 取消归档 | `pending`；成功重读清单行并让左栏（若同屏）失效：通过 `tasksBadgeBus` 同形的小总线 `tasksListsBus.notifyListsChanged()` | 归档不改变任务，分组板不重读 |
| 加入任务（输入 id） | `pending`；`validation`：`INVALID_TASK` / `LIMIT` 行内；`not_found` 行内写成「任务不存在、你不是它的创建人或负责人，或清单不可用」（契约三条件同 404；FE-8 按 R12 的 (a1) 改写：只经清单拿到的编辑权不算，原文「你不能编辑它」对清单编辑者不成立）；成功清空输入、重读清单项与摆放 | 输入 id 先过 `isPathSafeSegment` 以外的空白检查（空输入不发） |
| 移出任务 | 两步内联确认（同 M3 删任务的 `…-confirm` 块），不用 `window.confirm`；成功重读清单项与摆放 | 创建人支路对前端透明：按钮对 `myRole ∈ {edit, owner}` 显示；详情页的「移出」（§4.3）对创建人另有一条 |
| 动态面板 | `listTaskListEvents` 分页，「加载更多」；`eventType` 渲染为文案表里的词，未知词原样 | 只读 |

路由边沿：`watch(() => route.params.id)` 复位全部草稿、对话框、确认块，重走读序；所有 generation / token +1。

### 4.3 `/tasks/:id` 的两个新区

**`TaskDetailEditor`**（§7.2 有字段级细节）

- 草稿与展示分离，**状态在父组件**（`[fe-15]`）：`detailResult.task` 是服务端真相；`TasksView` 持有 `editorState = { draft, dirty, phase, conflictVersion, fieldErrors, serverUpdated }`（`tasksDraft.ts#createEditorState` 建，纯数据），编辑器只是它的视图（props + `update:draft`）。一个 `watch(detailResult)`：变为 `ok` 时若 `!dirty` 则 `draft = initDraft(task)`（§3.3），若 `dirty` 则草稿保留并置 `serverUpdated = true`（提示「服务端已更新」）。于是任何触发的 `loadDetail`——M3 动作成功后的重拉、PATCH `ok`、409 后的取回——都不丢草稿：详情分支整个在 `v-if="detailResult.kind === 'ok'"` 内、`loadDetail` 先置 `loading`，编辑器确实会卸载再重建，但它没有自己的状态。首次进入的 `tasks-detail-loading`（`tasks-detail-view.spec.ts:163`）与全部 M3 路径不变。已知代价：重拉期间编辑器短暂卸载，焦点回到 `body`；触发重拉的是用户点的别的按钮，可接受，不做焦点恢复。
- 路由边沿：`watch(taskId)` 的既有复位块追加 `editorState = createEditorState()`（草稿、冲突态、行内错误清空）。
- 提交：`buildTaskPatch(task, draft)` 为 `null` ⇒ 不发；预检有码 ⇒ 行内文案，不发；否则 `emit('submit', patch)`，父组件 `onPatchTask`：`token = ++detailActionToken`、`detailActionPending = true`、`patchTask(id, { expectedVersion: task.version, ...patch })`。
- 结果：
  - `ok` ⇒ `loadDetail(id)`（含新 `version`），草稿清空；`notifyTasksChanged()` 只在 patch 含截止日期 / 时间 / 时区任一键时发（红点输入只有这些会变，`R16` 的触点口径）。
  - `conflict VERSION_CONFLICT` ⇒ **回滚提示**：先 `loadDetail(id)` 把展示值回到服务端现值（展示层本来就没动，这一步是取回别人的改动），草稿**保留**并标 `conflict`，行内提示「任务已被他人修改（当前版本 N），已载入最新内容，请核对后再保存」；下一次提交用重拉后的 `version`（不用 409 体里的 `currentVersion` 当 `expectedVersion`：两者通常相等，但重拉后的才是展示给用户核对过的那份）。`currentVersion` 只用于文案。提供「放弃我的修改」把草稿重置为现值。
  - `validation` ⇒ 按码落在对应控件旁（`INVALID_VERSION` 落通用横幅：它意味着前端没有 `version`，不是用户能改的）。
  - 其余 ⇒ `applyDetailFailure` 既有分支。
- 晚到：`token !== detailActionToken` 时只处理副作用（`ok` 仍 `notifyTasksChanged`），不碰草稿与展示（M3 §3.6 的同一守卫，含「离开又回来」）。

**`TaskDetailLists`**

- 数据：`task.listIds`（服务端）+ 我的清单（父组件的 `myListsResult`：进入详情（`watch(taskId)` 边沿）与 `tasksListsBus` 事件时 `listTaskLists({ includeArchived: true })` 读全部页，自己的 generation；放在父组件的理由同编辑器——子组件随每次 `loadDetail` 重建，自持会重复发读）。`listIds` 里不在我的清单内的 id（创建人看到的、自己不是成员的清单）显示为 id 本身加「（你不是成员）」。
- 加入：下拉只列我 `myRole ∈ {edit, owner}` 且未含此任务的清单；子组件 `emit('add', listId)`，父组件 `onAddTaskToList`（`token = ++detailActionToken`、`detailActionPending = true`、`addTaskToList(listId, taskId)`，晚到守卫与 `onSetParent` 同形）；成功 `loadDetail(id)`（重拉 `listIds`），不发 `notifyTasksChanged`（红点不看清单）。`not_found` 行内写成「无法加入：你需要是该任务的创建人或负责人」（契约的 `[own-25]` 只认直接角色；文案是本件对 404 的解释，标 `[fe-02]`）；`LIMIT` ⇒ 「一个任务最多属于 10 个清单」。FE-8：下拉只在任务的成员管理能力为真时出现（`canManageMembers`，缺键时退回 `canEdit`，`[fe-47]`）——(a1) 的任务端判据就是直接角色，只经清单编辑的人点了只会得到 404。
- 移出：每个清单一行一个「移出」按钮 + 两步确认；子组件 `emit('remove', listId)`，父组件 `onRemoveTaskFromList`（同形）调用 `removeTaskFromList(listId, taskId)`；成功 `loadDetail(id)`。创建人对自己不是成员的清单也能移出（契约的创建人支路），按钮对所有 `listIds` 行都显示，由服务端 404 兜底。
- **成员控件（FE-8，`[fe-45]` ruled 2026-10-07；`[fe-46]`）**：M3 的增删负责人与增删关注人四个控件看详情的 `canManageMembers`（为真当且仅当调用者是任务的创建人或负责人），不再看 `canEdit`；完成方式、父任务与编辑区仍看 `canEdit`，退出看 `canLeave`。于是只经清单编辑的人（`canEdit: true`、`canManageMembers: false`）能改字段、设父、切模式，看得到负责人与关注人名单但没有增删控件。响应没有这个键时退回 `canEdit`（`[fe-46]`）：main 上 M3 的后端不发这个键，它对这四条写的判据正是 `canEdit` 报的那个 `edit` 能力（main 上只有任务的创建人与负责人有它），退回它与服务端逐一相符，也让 M3 的既有格（含「无能力键时控件都在」）原样成立。
- 一次一个：子组件没有本地 `pending`；全部控件绑 `props.pending`（= `detailActionPending`）。于是清单项写进行中，M3 的完成 / 重启 / 删除按钮同样禁用；M3 动作进行中，加入 / 移出同样禁用（§10.1 两格各一个方向）。

### 4.4 分组板（`TaskGroupBoard`，两种 scope 共用）

- 本地模型：`groups: Group[]`（按 `position, id`）、`placements: Map<taskId, Placement>`、`items: TaskListItem[]`。派生：每个分组的「有行可见集」= `items` 中有 `placements` 指向该组者，按 `position, task_id`；默认组另有「未排序尾段」= 无行的 `items`，按 `items` 原序。兜底：`placements` 里 `groupId` 不匹配任何本地分组的行归入 `isDefault` 组的有序区（按 `position`），而不是消失——覆盖两面重读窗口内的任何不一致。
- **重排是唯一的乐观更新**：拖放 / 键盘移动时先改本地快照（`snapshotBefore = structuredClone(...)`），立刻渲染新顺序，再发一条 `PUT`；`ok` ⇒ **同时重读分组与摆放**（两种 scope 一律；服务端会重编号、可能改变不可见残留行的位置，本地不复算。个人 scope 的首次 `PUT` 还会让默认组落行：摆放读回来的 `groupId` 已是真实 id，若只重读摆放，本地 `groups` 仍是 `{ id: null }` 的合成项，那条任务既不属于任何本地分组、又因有摆放行而不进尾段——从没建过分组的用户第一次拖动，任务就会从板上消失）；失败 ⇒ 恢复 `snapshotBefore`，行内横幅（`INVALID_POSITION` ⇒「位置已变化，请刷新后重试」并自动重读两面；`INVALID_GROUP` ⇒「分组已不存在」并重读两面；`not_found` ⇒ 重读整板）。
- 重排 pending 期间：`draggable=false`、键盘移动按钮 `disabled`、aria-live 区播报「正在保存顺序」。
- 建组 / 改名 / 删组：悲观，成功重读分组与摆放；删组后项回默认组由服务端完成（`reassignedTo`），前端只重读。默认组（`isDefault`）无删除按钮；个人 scope 的默认组在 `id === null` 时改名按钮禁用并提示「首次排序或新建分组后可改名」（契约：落行前没有 id）。
- 个人 scope 的 `groupId: null`：所有写函数把「默认组」统一发 `null`（两种 scope 都接受），前端不需要知道默认组是否已落行；首次 `PUT` 的响应带真实 id，成功后的两面重读（上一条）让本地 `groups` 也拿到真实 id，之后默认组的改名按钮解禁。

### 4.5 `/tasks/settings`（§7.1）

| 面 | 状态 |
|---|---|
| 读 | `loading` / `ok` / `not_found`（「无法读取设置：当前服务不支持，或尚未选择组织」）/ `forbidden` / `error` |
| 写 | `pending`；预检码行内；`validation` 行内（六个码各自文案）；`org_missing` 引导块；成功后用响应覆盖表单、显示「已保存」并 `notifyTasksChanged()`（红点范围可能变了） |
| 脏状态 | 有未保存改动时离开页面不拦截（无 `beforeunload`，与仓库其他设置页一致，`[fe-03]`） |

### 4.6 列表页「分配给我」视角（`TaskPersonalGroups`）

- 挂载条件与五态归属见 §2.4 的状态表：只在父组件 `listResult.kind === 'ok'`（非空）且 `currentView === 'assigned'` 时挂载；`loading` / `empty` / `error` 仍由父组件既有分支渲染。
- 输入：父组件的 `listResult.items`（既有 `loadList` 的结果）作 prop；挂载时自己读 `listUserGroups` + `listUserGroupItems`（并行，各自 generation；卸载后晚到结果丢弃）。
- 渲染：两读未都完成或任一失败 ⇒ 平铺 `<ul data-testid="tasks-list">`（`tasks-list-item` 行的内容、顺序与 `data-testid` 与既有 `<ul>` 相同；失败时顶部一条 `data-testid="tasks-groups-unavailable"`「分组不可用」提示）；两读都 `ok` ⇒ `TaskGroupBoard`（scope `'user'`），其**根容器带 `data-testid="tasks-list"`**。任务行内容与既有平铺列表相同（标题链接、截止、完成 / 重启按钮——这两个按钮仍由父组件的 `onComplete` / `onReopen` 处理，通过 emit 回传，所以 `listPageToken` 守卫不变）。
- `org_missing` 降级不单独处理（任务列表读自己会先触发引导块）。
- 切换到其他视角不渲染本组件，也不读分组。

---
## 5. 成员对话框与角色规则

### 5.1 服务端给了什么、客户端推什么

契约（§3.2、§3.3）在清单形状上只给三样与权限相关的字段：`myRole`（调用者在该清单的角色）、`createdBy`、`ownerId`。**没有能力标志对象**（任务详情有 `canEdit` 等，清单没有）。所以清单页的控件显隐分两列记：

| 判据 | 来源 | 规则 |
|---|---|---|
| 看得到这张清单 | 服务端（200 vs 404） | 读到 200 即成员 |
| 我的角色 | 服务端 `myRole` | 直接显示 |
| 改名、加 / 改 / 删成员、建组 / 改组 / 删组、加入 / 移出任务 | **客户端推断** | `myRole ∈ { edit, owner }`（任务 D `canListAction` 的真值表：`edit` 除转让外全部放行，`read` 只有 `view`） |
| 转让所有权 | 客户端推断 | `myRole === 'owner'` |
| 归档 / 取消归档 | 客户端推断 | `myRole ∈ { edit, owner }`，**或** `createdBy === currentUserId`（锁 §13-14 的归档权含创建人） |
| 本人退出（PR-3a `[own-14]`：成员经同一条 `DELETE` 移除自己） | 客户端推断 | `currentUserId` 已知，且 `currentUserId !== createdBy`（创建人不可移除）且 `myRole !== 'owner'`（所有者须先转让） |
| 某一行可被移除 | 客户端推断 | 我有管成员权，且该行 `userId !== createdBy`，且该行 `role !== 'owner'`，**且该行 `userId !== currentUserId`**（本人只走「退出清单」按钮：行内移除自己会让对话框停在一张自己已不是成员的清单上，下一次任何读都是 404；退出按钮的后处理是关对话框 + 回 `/tasks`） |
| 某一行可改角色 | 客户端推断 | 我有管成员权，且该行 `role !== 'owner'`；可选角色只有 `read` / `edit`（`owner` 不能直接指派） |
| 某一行可成为转让目标 | 客户端推断 | 我是所有者，且该行 `userId !== ownerId` |

推断只决定**显隐**；每一条仍由服务端判，404 / 422 回来照常渲染（不假设前端推断总对）。`currentUserId` 沿用 M3 的 `useAuth().getCurrentUserId()` 三态（`pending` / `known` / `unavailable`）；`unavailable` 时依赖它的两条（本人退出、创建人归档的那一半）**隐藏**，理由同 M3 对 Leave 的处理：显示只会把用户导向一个 422 / 404。

请求后端在清单形状上加能力标志（形同任务详情的 `canEdit`）列为 §12-Q4；加上之后客户端推断整段改为「有标志只看标志」，与 M3 对 `canLeave` 的处理同形。

### 5.2 对话框结构

```
<div role="dialog" aria-modal="true" aria-labelledby="tasks-list-members-title" data-testid="tasks-list-members-dialog">
  <h2 id="tasks-list-members-title" tabindex="-1">清单成员</h2>
  <ul data-testid="tasks-list-members">
    <li data-testid="tasks-list-member" :data-user-id :data-role>
      <span>userId</span> <span>角色文案</span> <span v-if="createdBy">创建人</span>
      <select v-if="canChangeRole(row)" :value="row.role" @change>…read / edit…</select>
      <button v-if="canTransferTo(row)">设为所有者</button>
      <button v-if="canRemove(row)">移除</button>
  <form data-testid="tasks-list-add-member-form">  userId 输入 + 角色下拉（read / edit）+ 添加
  <button v-if="canLeave" data-testid="tasks-list-leave">退出清单</button>（两步内联确认）
  <p role="alert" data-testid="tasks-list-members-error">…行内错误…
  <button data-testid="tasks-list-members-close">关闭</button>
```

- 打开时读 `listTaskListMembers`（一页；100 人上限由 `D14` 定）；读失败在对话框内渲染 `error`，不关闭。
- 焦点管理：打开后 `focus()` 到标题（`<h2 tabindex="-1">`——没有它 `focus()` 是空操作、焦点仍留在触发按钮；spec 断言 `document.activeElement` 是该 `<h2>`）；Esc 与「关闭」都关闭并把焦点还给「成员」按钮；Tab 循环限制在对话框内（最小实现：`keydown` 捕获 Tab 在首尾元素间回绕，不引入新依赖）。（FE-8 补，`[fe-48]`：写进行中对话框的控件全部禁用，真实浏览器会把焦点从被禁用的控件移到页面 `body`；转让、移除还会让发起写的控件消失。焦点落在对话框之外，Esc 与 Tab 回绕都收不到。所以写落地后：焦点已在对话框内就不动；在对话框外就还给发起写的控件（仍在、仍可用时），否则给标题。）（闸审之后补，`[fe-49]`：转让与退出的两步确认同样替换了被操作的按钮，取消又把按钮换回来——不经过写也会把焦点丢到对话框之外。打开确认 ⇒ 焦点到确认按钮，确认按钮的 `aria-describedby` 指向提示句，提示句带 `role="status"`；取消 ⇒ 焦点回到换回来的按钮；之后 Esc 照常关闭、Tab 照常回绕。）
- 每个写动作：`pending` 共用；成功用响应的 `members`（它带 `userId` / `role`）**直接替换**列表——这是对 §4.0「悲观重拉」的一个例外（`[fe-04]`）：成员响应与读接口形状只差 `createdAt`，而对话框不显示 `createdAt`；之后再补一次 `listTaskListMembers` 刷新 `createdAt` 不值一次往返。转让成功后另外重读清单行（`ownerId` / `myRole` 变了，关掉对话框后页头要对）。
- 本人退出成功：关闭对话框、`router.push('/tasks')`（自己已不是成员，再读清单会 404）、`notifyListsChanged()`。
- 角色下拉用 `:value` 绑定 + `@change` 读原生值（M3 完成模式下拉的同一做法），避免请求未成功时下拉先「自己变了」。

### 5.3 错误码 → 文案（成员域）

| 码 | 文案 | 落点 |
|---|---|---|
| `INVALID_MEMBER` | 无效的用户 | 添加表单 / 对应行 |
| `INVALID_ROLE` | 无效的角色 | 对应行 / 添加表单 |
| `INACTIVE_ORG_MEMBER` | 该用户不在当前组织或已停用 | 添加表单 / 转让按钮旁 |
| `LIMIT` | 成员数已达上限 | 添加表单 |
| `OWNER_MUST_TRANSFER` | 请先转让所有权 | 对应行 / 退出按钮旁 |
| `CREATED_BY_IMMUTABLE` | 清单创建人不能被移除 | 对应行 / 退出按钮旁 |
| `TARGET_NOT_MEMBER` | 对方不是清单成员 | 转让按钮旁 |
| 404 | 清单不可用或你已不是成员 | 对话框横幅，并重读清单行（可能已被移出 ⇒ 页面转 `not_found`） |

---

## 6. 分组与排序 UX

### 6.1 展示

- 板的根容器 `<div data-testid="tasks-list" :data-scope>`（两种 scope 都如此；在「分配给我」视角它就是既有守卫钉的那个容器，§2.4）；板内不出现 `tasks-list-empty` / `tasks-list-error` / `tasks-list-loading`，也不出现 `tasks-view.spec.ts` TESTIDS 里的任何其他 id。
- 每个分组一个 `<section data-testid="tasks-group" :data-group-id :data-default>`，标题行：组名（可改名的内联表单，`manage_groups` 权限或个人 scope）、项数、删除按钮（非默认组）。
- 组内 `<ol>`：有行可见集按 `position` 升序；默认组末尾另有 `<ol data-testid="tasks-group-unsorted">`「未排序」尾段（无摆放行的任务，服务端顺序）。这样「无行任务排在有行任务之后、不在下标空间里」这条契约规则在界面上是**可见的**，用户知道为什么它们不能被夹到有序区中间。
- 任务行：标题链接到 `/tasks/:id`、截止、状态；个人 scope 另有完成 / 重启按钮（emit 给父组件）。

### 6.2 拖拽

- 原生 HTML5 拖放（`draggable="true"`、`dragstart` / `dragover` / `drop`），不引入依赖（`apps/web` 没有拖拽库；多维表的字段管理也是原生实现）。拖拽句柄是行首的「⋮⋮」按钮（`aria-label="拖动以排序"`），整行作放置目标。
- 放置计算：目标组的可见集（去掉被拖的任务自身）里，放置点前面的行数 = `position`；放到「未排序」尾段上 = `position: len`（追加到有序区末尾，它自然排在尾段之前）。跨组放置同理，`groupId` 取目标组 id（默认组发 `null`）。
- 同组同位（放回原处）⇒ 不发请求。

### 6.3 键盘替代（必须有，拖拽只是加速）

- 每行两个按钮「上移」「下移」（`aria-label="将「标题」上移一位"`），首 / 末行对应按钮 `disabled`；在有序区内移动 = 同组 `position ± 1`；「未排序」尾段的行只有「上移」且它的语义是「放到有序区末尾」（`position: len`）——尾段内部没有顺序可改，按钮文案改为「加入排序」。
- 每行一个「移到分组…」下拉（`:value` 绑定当前组，`@change` 读原生值）：跨组移动，`position` 取目标组末尾。
- 焦点：移动成功后焦点保持在同一任务的同一按钮上（按 `data-task-id` 重新 `focus()`），`aria-live="polite"` 区播报「已移到第 N 位」。

### 6.4 契约里前端必须知道的几条

| 规则 | 前端做法 |
|---|---|
| `position` 是目标组可见集里的 0 起稠密下标，取值 `0..len` | 永远从本地渲染的顺序数下标，不用服务端回传的 `position` 做算术（它在重读后才可信） |
| 无行任务不在下标空间 | 「未排序」尾段；要把 A 放到无行任务 B 之后，先把 B「加入排序」（一次 `PUT`），再拖 A——每个手势恰一条请求，不做多请求序列（`[fe-05]`，替代方案见 §14-R4） |
| `PUT` 同组同位是空操作 | 本地不变就不发 |
| 服务端重写整组位置，不可见残留行排到可见行之后 | 成功后重读摆放，本地不模拟 |
| 删组后项回默认组 | 重读分组与摆放，不本地搬 |
| 清单 scope 的跨组移动写 `group_changed` 事件，同组重排与个人 scope 不写 | 前端无感；动态面板会多一条 |
| 每容器 ≤ 50 组（含默认组），`LIMIT` | 建组表单在本地已有 50 组时禁用并提示 |
| 个人 scope 只作用于 assigned 臂 | 只在「分配给我」视角渲染；被移除负责人后的残留行服务端已过滤 |
| 清单项或摆放读被截断（超过 20 页） | 禁用全部重排控件，提示；建组 / 改名仍可用 |

### 6.5 并发与失效

- 重排失败回滚本地快照（§4.4）；`INVALID_POSITION` 几乎总是别人同时改了顺序，自动重读并提示「顺序已被他人更新，已刷新」。
- 分组板**不订阅实时事件**（`R16` 的 socket 只服务红点；清单动态不做推送 `R19`）；提供「刷新」按钮。

---

## 7. 设置页与详情编辑

### 7.1 `/tasks/settings`

| 字段 | 控件 | 取值 | 预检 / 服务端码 |
|---|---|---|---|
| `badgeScope` | 单选组（`fieldset` + `legend`「红点统计范围」）：关闭 / 仅逾期 / 逾期与今天到期 | `'off'` / `'overdue'` / `'overdue_or_today'`，缺省 `overdue` | `INVALID_BADGE_SCOPE` |
| `dailyReminderEnabled` | 复选框「每日汇总提醒」，旁注「按你的时区每天固定时刻发送；是否实际发送取决于服务端配置」（PR-3b 的三个开关前端不可见，不能承诺） | boolean，缺省关 | `INVALID_DAILY_REMINDER_ENABLED`；为真而时区为空 ⇒ `DAILY_REMINDER_REQUIRES_TIME_ZONE` |
| `defaultRemindPolicy` | 下拉「新任务的缺省提醒」：按缺省规则 / 不提醒 | `{ mode: 'default' }` / `{ mode: 'none' }` | `INVALID_POLICY` |
| `timeZone` | 文本输入 + 「使用浏览器时区」按钮（填 `resolveViewerTimeZone()`，即 `Intl.DateTimeFormat().resolvedOptions().timeZone`）+ `datalist` 候选（`utils/timezones.ts#buildTimezoneOptions`，仓库既有，不新增格式化调用点） | 规范 IANA 名或空；服务端只落规范名 | `INVALID_TIME_ZONE` |

- 读到 `timeZone: null` 时输入框留空、按钮高亮建议；勾选每日提醒而时区为空时，预检直接把浏览器时区填进去并提示「已按浏览器时区填入，可修改」（`[fe-06]`：比硬拒一步省一次往返，仍由用户确认后再保存）。
- 保存只发改动过的键（`undefined` 不发）；`timeZone` 清空发 `null`；`badgeScope` / `defaultRemindPolicy` 永不发 `null`。
- 成功：响应覆盖表单（规范名回填）、`notifyTasksChanged()`（红点范围变了，马上重拉）、「已保存」状态文案。
- 没有「重置为缺省」按钮：契约没有「清空设置行」语义。

### 7.2 详情编辑区字段

| 字段 | 控件 | 发什么 | 预检 |
|---|---|---|---|
| 标题 | `input`，必填 | `title`（改动时） | `INVALID_TITLE` |
| 描述 | `textarea`，码点计数器「N / 20000」 | `description`；清空发 `''`；现值 `null` 由 `initDraft` 变成 `''`，未改动不入列 | `INVALID_DESCRIPTION` |
| 截止日期 / 时间 | `input[type=date]` + `input[type=time]`（`step=60`，只到分钟） | `dueDate` `'YYYY-MM-DD'` / `dueTime` `'HH:MM'`（现值 `'HH:MM:SS'` 由 `initDraft` 截成 `'HH:MM'` 再比较，未改动不入列）；清日期时同体 `dueTime: null` | `INVALID_DATE` |
| 开始日期 / 时间 | 同上 | `startDate` / `startTime` | `INVALID_DATE` |
| 时区 | 与设置页相同的输入 + 浏览器时区按钮；任务已有时区时显示现值；没有时区且用户填了日期时预填浏览器时区 | `timeZone`：四个日期键任一入列且合并后仍有日期时**总是**同体带上（草稿值或现值）；单独改时区只发它；任务没有日期时可清空（发 `timeZone: null`） | `TIME_ZONE_REQUIRED` / `INVALID_TIME_ZONE` |
| 提醒 | 「不提醒 / 指定时刻」单选 + `input[type=datetime-local]`（按浏览器本地时间输入，提交前转 `Date#toISOString()`）；只读显示用 `formatViewerInstant`（既有） | `remindAt`：ISO 瞬时或 `null`；**只在用户碰过提醒时发**（契约：PATCH 从不派生，改截止日提醒不跟着动——界面在改了截止日而未碰提醒时显示一条提示「提醒时刻不会自动跟随截止日期」） | `INVALID_REMIND_AT` |
| `expectedVersion` | 隐藏，取 `task.version` | 必带 | 缺 `version` 或缺 S4 四键组时整个编辑区不渲染 |

- 显示层（只读行）：截止沿用 `formatDueDisplay`；新增开始日期行（同样的墙上时间显示规则：不经 `Date` 往返）、描述行（`white-space: pre-wrap`）、提醒行（`formatViewerInstant`）。
- 提交按钮 `disabled` 条件：`pending || buildTaskPatch(...) === null`（两边都是规范形，所以对任何未改动的任务——含带时间、描述为空的——按钮都是禁用的，不会对真后端发空操作 PATCH）。
- 预检与服务端规则的对应（镜像 S4 的 `planTaskDates`）：类型闸在前端不可能触发（控件只产出字符串或空）；`''` 的时间控件值视为 `null`；清截止日期时时间控件一起清，并把两者都放进 patch；只改时区时 `due_at` 由服务端重算，前端重拉即可。
- `TIME_ZONE_REQUIRED` 的客户端触发：草稿有任一日期而时区为空 ⇒ 不发，提示并聚焦时区输入。

### 7.3 409 回滚的时序（写成状态机，spec 按它出格）

```
idle --submit--> pending --ok--> idle（草稿清空，展示=重拉）
                          --409--> reloading --loadDetail ok--> conflict（草稿保留，提示含 currentVersion）
                                              --loadDetail 失败--> conflict（提示不含版本号，「请刷新页面」）
                          --422--> idle（行内码文案，草稿保留）
                          --其他--> idle（通用横幅）
conflict --submit（用新 version）--> pending
conflict --放弃--> idle（草稿=现值）
任何状态 --父组件 loadDetail ok（非本编辑器触发，如 M3 动作成功后的重拉）--> 原状态（!dirty ⇒ 草稿重初始化；dirty ⇒ 草稿保留 + 「服务端已更新」）
路由边沿（任何状态）--> idle（草稿清空）
```

- `conflict` 态的 `expectedVersion` 取重拉后的 `task.version`；若重拉失败，提交按钮禁用（没有可信版本号）。
- `pending` 期间来自 `tasksBadgeBus` 或实时事件的刷新不触碰编辑器（它们只刷新红点）。

---
## 8. 红点

### 8.1 `badgeScope: 'off'`（S3 已建，`D5`）

- `fetchPendingCount` 的 ok 结果多一个可选 `badgeScope: 'off'`（§3.2）。
- `useTasksBadge` 新增 `scope: Ref<'on' | 'off' | null>`：`ready` 且 `badgeScope === 'off'` ⇒ `'off'`；`ready` 其余（键缺失，或任何非 `off` 值，§3.2 的容忍解析）⇒ `'on'`；`loading` / `unavailable` ⇒ `null`。`count` 在 `off` 时仍是 0（服务端给的真值）。
- `TasksTodoBadge.vue`：节点仍常驻、三态不变（`data-state` 仍只有 `loading` / `ready` / `unavailable`——沿用 M2 的 `ready` 是有意的取法，`tasks-badge.spec.ts:98` 与 `tasks-nav-feature-gate.spec.ts:197` 钉着它，见 §11 `[D5]`），另加 `:data-scope="scope ?? ''"`；`off` 时**不渲染数字**（`glyph` 为空）、`data-count="0"`、`aria-label`「待办任务红点已关闭」、样式类 `tasks-todo-badge--off`（视觉上隐去底色，节点仍在）。这样「关闭」（`data-state="ready" data-scope="off" data-count="0"`）与「0 条」（`data-state="ready" data-scope="on" data-count="0"`）与「不可用」（`data-state="unavailable" data-count=""`）三者可由属性字符串相等判别。
- 404 拆定时器、`ok` 重启定时器、`notifyTasksChanged` 触发重拉：全部不变。

### 8.2 实时订阅（FE-2 建骨架；FE-c 按 PR-3c 重核，2026-10-09）

- 新组合式 `tasks/useTasksCountsRealtime.ts`，**整段照抄** `todo/useTodoCountsRealtime.ts` 的 socket 生命周期（挂载守卫改为读同目录 `tasksRealtimePolicy.ts#shouldAutoConnectRealtime()`——它只返回 `import.meta.env.MODE !== 'test'`，生产行为与 `useTodoCountsRealtime.ts:143-145` 相同，单独成模块只为让 spec 能 `vi.mock` 它；`connectionPromise` 去重、`disconnected` 拆除标志、`auth: { token }`、`path: '/socket.io'`、`transports: ['websocket', 'polling']`、`resolveXxxRealtimeBaseUrl` 去 `/api` 后缀），只换事件名与载荷处理；不与它合并（两个事件的合同不同，与该文件自己的说明同一理由）。
- （2026-10-09 注）上一条的「只换事件名与载荷处理」是 FE-2 时的状态。现在多一条规则：没有令牌、或已经拆除时，`ensureSocket()` 在建 `connectionPromise` 之前就返回 `null`，不留下任何东西，之后带着令牌的 `reconnect()` 照常建连（`tasks-badge-m4` C 组一格钉住）。这条规则在两个兄弟组合式里还没有，作为本 PR 之外的后续项，不在本件改。
- 事件名 `tasks:counts-updated`（`R16`），与 PR-3c 的事件名常量逐字相同；整个 `apps/web/src` 只在 `useTasksCountsRealtime.ts` 的导出常量里写一次，订阅传的就是这个常量（FE-c 的普查格钉住）。房间由服务端按用户加入（`CollabService.ts:121` 在认证时 `socket.join(buildAuthenticatedUserRoom(userId))`），客户端不发 join，也不在 socket 上发任何消息，只听这一个事件。
- 载荷：**只作失效信号**，不读任何字段（PR-3c 每次发一个新建的 `{}`，`[own-3c-01]`）。重拉走 `fetchPendingCount`：带重拉那一刻浏览器报的时区作 `x-viewer-time-zone`（`R16` 的原因：服务端不知道查看者时区），并带 `suppressUnauthorizedRedirect`（后台读，会话过期不把人弹去登录页）。`normalizePayload` 落成 `isCountsInvalidation`：任何值都是一次信号——写成显式函数并配 spec，防止将来有人从载荷读数。
- **一个窗口一次读**（FE-c，`[fe-51]`，**ruled 2026-10-09**（门 26）；取代 FE-2 时的不另加防抖）：信号不立即重拉。第一条信号打开一个 500 ms 的窗口（`TASKS_SIGNAL_WINDOW_MS`），窗口里的信号都被吸收，窗口结束时恰一次 `refresh()`。窗口从第一条信号起算、不顺延，所以持续不断的信号也是每个窗口读一次，不会一直推迟。理由：PR-3c 每次写入发一次，连续的写入（自动化、多人同时操作）会让每个打开的标签页每条信号发一次请求；generation 只保证最后的结果落地，不减少请求。代价是别人的写入最多晚 0.5 s 显示。
- **已开始的读回答它之前的信号**（`[fe-52]`，**ruled 2026-10-09**（门 26））：窗口开着时，任何一次开始的读（60 s 钟、总线 nudge）都发在窗口吸收的每条信号之后，因此回答了它们，窗口随之关闭。PR-3c 对身为负责人的操作者也发，而且发在 HTTP 响应之前（§8.3 第 6 条）：信号先到、总线 nudge 后到时只读一次；反过来（nudge 先发出、信号后到）仍读两次，信号对不上在它之前开始的读。窗口打开时已经在途的读**不**回答它（服务端可能在写入提交之前就答了它）：窗口照常结束并发自己的读，旧读晚到的结果由 generation 丢弃。（2026-10-09 注）上一条 `[fe-51]` 与本条 `[fe-52]` 由本件自选转为已裁（owner 2026-10-09 裁定，门 26），规则文字不变；改其中任何一条现在要新的裁定。代码里的标签按 `[fe-45]` 的先例写作 `[fe-51] ruled 2026-10-09`。锁 PR 把门 26 的前端格按格名列为七格，spec 恰带这七个名字（§8.3 第 5 条、§10.1）。下一条 `[fe-53]` 仍是本件自选；门 26 的七格都不依赖它，H 组里讲隐藏页 tick 的那一格（不带前缀）也在窗口到点之前把页面切回可见，同样不依赖它。
- **隐藏页**（`[fe-53]`）：窗口的读在隐藏页照发（隐藏页跳过只属于 60 s 钟）；后台页每个窗口至多读一次，回到前台时红点已是新的。
- 卸载时关闭窗口，窗口不为已卸载的红点读。总线 nudge 与 60 s 钟照旧立即读（M2 的格钉着总线的立即性）。
- 轮询**保留**，而且是必需的另一半保证，不只是断线回退：PR-3c 的 socket 服务是进程内 adapter，一次发送只到达处理这次写入的那个后端进程上的 socket（PR-3c 设计 §5、§12 第 8 条）；部署多于一个后端进程时，其余客户端只能等下一次轮询。60 s、隐藏页跳过、404 拆定时器全部不变；socket 在线时轮询照跑（`[fe-08]`：不做在线就停轮询的状态机）。
- 组合式挂在 `useTasksBadge` 内部（`onMounted` 订阅、`onUnmounted` 断开），`TasksTodoBadge.vue` 不改接线；于是「红点只在 `canUseTasks` 且非公开路由时挂载」的既有门自动覆盖 socket：feature off ⇒ 不挂红点 ⇒ 不连 socket、不发请求（#6173 的要求延伸到 socket）。退出登录也经过这道门：站内的每一条退出路径都经过公开路由 `/login`，红点卸载，socket 断开、窗口关闭；再次登录后红点重新挂载，用新令牌开新 socket。整页跳转的退出（`App.vue` 的 `logout()`、401 的整页跳转）卸载整个页面。
- 这道门的 spec 证明**不能靠 MODE 守卫空转**：守卫在测试里恒不连，on / off 两边都是零次，格子什么也没证明。`tasks-badge-m4.spec.ts` 用 `vi.mock` 把策略模块换成恒真、用 `vi.mock('socket.io-client')` 注入假 `io`（`approvalCountsRealtime.spec.ts:13` 的既有做法），按 `tasks-nav-badge.spec.ts` 的真实 `App` 挂载形状断言：feature on ⇒ `io` 恰调用一次（正控）；feature off / 无 `tasks:read` / 公开路由 ⇒ 零次。变异目标：把 `useTasksCountsRealtime()` 挪到 `App.vue` 的 setup 顶层（`canUseTasks` 之外）⇒ off 格红；策略模块恒假 ⇒ 正控格红（证明正控不是空转）。

### 8.3 PR-3c 落地后必须重核的点（FE-c 已逐条重核，2026-10-09）

读的是 PR-3c 分支 `claude/tasks-m4-pr3c` @ `3edd133ae0`（单提交；与重建前的 `e432881344` 只差 PR-3c 自己的验证 MD）：设计 `docs/development/task-m4-pr3c-backend-design-20261008.md`（§12 是给前端的核对点）与 `services/task-counts-realtime.ts`。下表的行号都在该提交上，路径省略前缀 `packages/core-backend/src/`。第 1–5 条是起草时列的，第 6–11 条是 PR-3c §12 与重核时补的。

| # | 重核点 | PR-3c 的事实 | 结论 | 前端的落点（spec 见 §10.1） |
|---|---|---|---|---|
| 1 | 事件名；是否按用户房间发 | `services/task-counts-realtime.ts:35` 事件名常量 `tasks:counts-updated`；`:71` 每个收件人发往 `buildAuthenticatedUserRoom(userId)`；`services/CollabService.ts:8-10` 房间名 `auth-user:<userId>`，`:117-121` 令牌验证后 `socket.join`，`:383` 每个连接都走它 | 一致 | 常量不变；普查格：`apps/web/src` 只有这一处写法；客户端只听这一个事件、不在 socket 上发任何消息 |
| 2 | 载荷是否无字段 | `:38` 载荷类型 `Record<string, never>`；`:71` 每次发新建的 `{}`（`[own-3c-01]`） | 一致 | 不读：任何访问都记录并抛出的载荷格（零访问）；各种类型的载荷都恰是一次信号、不影响计数 |
| 3 | 触点集合；与 `onPatchTask` 的总线条件是否对齐 | PR-3c 设计 §3 的八个函数正是本条起草时列的写入；另有两个子情形也发：只改时区的 PATCH（含没有截止日的任务，`[own-3c-03]`）与不改变状态的完成方式切换（`[own-3c-02]`） | 一致 | 不改：总线条件（`onPatchTask` 只在截止日期、时间或时区变化时通知）与之相容；PATCH 也发事件，但 socket 未连或连在别的进程上时，操作者自己的红点仍靠总线及时 |
| 4 | socket 认证与路径 | `CollabService.ts:74-76` 从握手的 `auth.token` 取令牌；`:369-375` 建服务时不传 `path`（缺省 `/socket.io`）；PR-3c 不改 `CollabService.ts` 与 `apps/web`（相对合并基 `cc6ca96ac2` 零差异） | 一致 | 不改；连接参数恰为 `{ path, transports, auth: { token } }`、不带 query 的格 |
| 5 | 提交之后才发；前端 spec 证明什么 | PR-3c 设计 §4.2：事务 `await` 返回之后才 `publish()`；回滚零发送由它的真库格证明（门 26 候选，`gate26|`） | 服务端一致；前端格的表述调整 | 前端证明的从事件到恰一次 `fetchPendingCount` 改为事件到窗口结束时恰一次 `/pending-count` 请求（`[fe-51]`），对应门 26 正文的前端句；两格带 `gate26\|` 前缀，锁 PR 合并前是候选、不计分；负控丁（去掉订阅）在变异轮。（2026-10-09 注：锁 PR 按格名列出门 26 的七个前端格，spec 改为恰带这七个名字：A 组 `gate26\|重拉格`、`gate26\|时区格`，H 组 `gate26\|到点格`、`gate26\|提前格\|轮询`、`gate26\|提前格\|总线`、`gate26\|另开窗口格`、`gate26\|在途格`；仍是候选，锁 PR 合并前不计分；锁里前端的负控丁–癸逐格跑过，见验证记录同日一节） |
| 6 | （PR-3c §12 第 4、7 条）操作者本人是负责人时也收到，且发送先于 HTTP 响应 | `[own-3c-09]`；PR-3c 设计 §4.2 末条 | **调整** | `[fe-52]`：信号先到时与总线 nudge 合为一次读；反序仍两次（§8.2） |
| 7 | （§12 第 5 条）设置变更不发送 | `[own-3c-04]` | 一致：设置页 FE-3 起就在保存成功后 `notifyTasksChanged()` | `[fe-54]`：每次保存成功都重拉，不只改了 `badgeScope` 的那次；新格在完全没有 socket 时证明重拉来自总线 |
| 8 | （§12 第 6 条）多 org 用户收到另一 org 写入的信号 | `[own-3c-12]`：房间不分 org | 一致 | 不改：载荷为空，重拉的是会话 org 的计数；最坏每个窗口一次多余的请求 |
| 9 | （§12 第 8 条）进程范围 | PR-3c 设计 §5；`CollabService.ts:377-378`（`WS_REDIS_ENABLED` 只打一条日志，仍是进程内 adapter） | 一致；轮询的理由改写 | 轮询是必需的另一半（§8.2，`[fe-08]` 的理由补写）；两格：socket 一直在线而没有信号时，下一个 60 s tick 显示变化；socket 在线而首次读失败时，轮询照样恢复 |
| 10 | （重核时补）退出登录时拆除 | — | 一致 | 站内退出都经 `/login`（公开路由）⇒ 红点卸载 ⇒ socket 断开、窗口关闭；再次登录后新 socket 带新令牌；整页跳转的退出卸载整页（jsdom 做不了整页跳转，没有格）。残留，记录不改：`bootstrapSession` 的 401 分支 `clearToken()` 不跳转，红点在下一次导航前仍挂着，期间的信号只会引来一次答 401 的读（红点转不可用，载荷里本来没有数据）；socket.io 自己的重连沿用建连时读到的令牌（两个兄弟组合式相同），令牌换过之后的重连可能进不了房间，红点退回 60 s 钟 |
| 11 | （重核时补）feature 关闭时没有订阅 | — | 一致 | FE-2 的门格管挂载时；FE-c 加会话中途关闭：下一次路由变化时入口与红点卸载、socket 断开 |

---

## 9. 文案与 i18n（`R20` 取 (a)）

### 9.1 `apps/web/src/tasks/labels.ts`

- 形状照 `views/approval/approvalCenterLabels.ts`：平铺的 `TASKS_ZH` 与 `TASKS_EN: Record<keyof typeof TASKS_ZH, string>`（vue-tsc 强制键对齐），各视图 `const t = computed(() => (isZh.value ? TASKS_ZH : TASKS_EN))`，模板用 `t.xxx`。
- 带插值的句子（「当前版本 N」「N / 20000」「已移到第 N 位」）写成函数对 `TASKS_FMT_ZH` / `TASKS_FMT_EN: Record<keyof typeof TASKS_FMT_ZH, (…) => string>`，同一文件。
- **回填 M2 / M3**：`TasksView.vue` 里全部硬编码中文（视角名、按钮、状态、提示、`CODE_MESSAGES` 表）与 `TasksTodoBadge.vue` 的 `isZh` 三元都迁入表；`CODE_MESSAGES` 变成 `codeMessage(code, t)`。中文字面值**逐字不变**（既有 spec 用 `.toBe` 钉了多处精确文案）。
- **`tasksDateDisplay.ts` 也在回填面内**：`formatViewerInstant` 硬编码 `'zh-CN'`（`:18`，输出「2026年10月1日 17:30」这类含年月日的文本）、`formatDueDisplay` 回「无截止日期」（`:49`）并用全角括号（`:47`）；列表行与详情只要夹具带日期，EN 语境就会渲染出 CJK。改法：`formatViewerInstant(value, timeZone?, locale = 'zh-CN')` 加第三参；`formatDueDisplay(task, labels = TASKS_ZH)` 加第二参，占位文案与括号从表取（EN 用 ASCII 括号）；缺省值保持 ZH，于是 `tasks-detail-view.spec.ts:322` / `:330` / `:354` 与 `tasks-list-view.spec.ts:150` 的既有断言逐字不变；`TasksView.vue` 的调用点按 `isZh` 传 `'zh-CN'` / `'en-US'` 与对应表。
- `App.vue` 的 `navLabels` 不动（壳层自己的表，M2 就在那里）。
- 不进表的：`data-testid`、`aria-*` 的键名、路由 meta 的 `title` / `titleZh`（路由表自带中英）。

### 9.2 错误码 → 文案表（全部进 `labels.ts`，一码一文案，两种语言）

任务编辑：`INVALID_VERSION` 版本信息缺失，请刷新页面 / `VERSION_CONFLICT`（格式函数，含版本号）/ `INVALID_TITLE` 标题不能为空 / `INVALID_DESCRIPTION` 描述过长或包含无法保存的字符 / `INVALID_DATE` 日期或时间格式不正确 / `INVALID_TIME_ZONE` 无效的时区 / `TIME_ZONE_REQUIRED` 设置日期时必须指定时区 / `INVALID_REMIND_AT` 提醒时刻格式不正确。

设置：`INVALID_SETTINGS` 设置格式不正确 / `INVALID_BADGE_SCOPE` 无效的红点范围 / `INVALID_DAILY_REMINDER_ENABLED` 无效的每日提醒开关 / `INVALID_POLICY` 无效的提醒策略 / `DAILY_REMINDER_REQUIRES_TIME_ZONE` 开启每日提醒需要先设置时区。

清单与分组：`INVALID_NAME` 名称不能为空 / `NAME_TOO_LONG` 名称过长 / `LIMIT`（按落点分三条：成员数已达上限 / 一个任务最多属于 10 个清单 / 分组数已达上限——码相同、文案按调用点选）/ `INVALID_TASK` 无效的任务 / `IS_DEFAULT` 默认分组不能删除 / `INVALID_GROUP` 分组不存在 / `INVALID_POSITION` 位置已变化，请刷新后重试 / 成员域七条见 §5.3。

FE-8：`INACTIVE_ORG_MEMBER`（R17 / N2，ruled 2026-10-07；PR-3a S9 起也答任务的创建与增负责人、增关注人）全线一条文案「该用户不在当前组织或已停用」，落点：清单成员的添加表单与转让行（§5.3）、详情页的增负责人表单与增关注人表单旁（M3 两处行内错误）、创建表单的错误行（创建表单本身不发 `assignees`，今天从界面到不了这一格）。

既有 M3 十条（`INVALID_PARENT` …`TASK_BUSY`）原文迁入。未知码回退「操作失败，请稍后重试」。

### 9.3 中英 spec（`tasks-labels.spec.ts`）

1. 键对齐：`Object.keys(TASKS_ZH)` 与 `TASKS_EN` 集合相等（vue-tsc 之外再钉一次，防 `as any`）。
2. 每个 ZH 值含 CJK、每个 EN 值不含 CJK、ZH ≠ EN；格式函数用固定实参各跑一次同样三条。CJK 类用 `templateDetailI18n.spec.ts:401` 的加宽类 `/[　-〿一-鿿＀-￯]/`（统一表意文字 + CJK 标点 + 全角形），不用窄类 `/[一-鿿]/`：全角括号「（）」也算 CJK，所以 EN 的日期显示必须用 ASCII 括号。
3. 渲染扫描：在 EN 语境（`useLocale` mock `isZh: false`）mount `TasksView`（列表与详情各一次，mock 的 API 回满形状数据——含带 `due_at` 的行、带 `dueAt` / `completedAt` / `remindAt` 的详情与无截止日期的详情，以证明 `tasksDateDisplay.ts` 的回填——包括错误态与 409 态）、`TaskListView`（含打开成员对话框）、`TasksSettingsView`、`TasksTodoBadge`（三态 + `off`），对 `renderedTextAndAttributes(root)`（照 `templateDetailI18n.spec.ts` 的同名扫描：文本 + `title` / `aria-label` / `placeholder`）断言零 CJK；ZH 语境再扫一次断言有 CJK。
4. 挂载后切换语言（`isZh` 翻转）文案随之变（钉住 `computed` 而非一次性求值）。
5. `codeMessage` 对每个已知码两种语言都非空且不等于回退文案；未知码等于回退文案。

### 9.4 既有 spec 的连带修复（只加 mock，不改断言）

同一张文件表管两件事：FE-0 的 `useLocale` mock 与 FE-4 / FE-5 / FE-7 的 `tasksApi` 工厂补条目。五个文件的 `vi.mock('../src/tasks/tasksApi', …)` 都是**显式对象工厂**（不是 `importActual` 展开），访问工厂里没有的导出在 vitest 下直接抛 `No "listTaskLists" export is defined on the mock`；`tasks-detail-m3.spec.ts` 虽是详情 spec，但它在 `:1056`、`:1266`、`:1778` 三处 `router.push('/tasks')` 回到列表页，列表页会挂载左栏（`listTaskLists`）与「分配给我」分组板（`listUserGroups` / `listUserGroupItems`），所以它也在表内（M3 设计 §4.1 的同类清单只列了四个 M2 文件，M4 不能沿用那个数）。

| 文件 | `useLocale` mock（FE-0；与 `tasks-badge.spec.ts` 相同的 `isZh: ref(true)`） | `tasksApi` 工厂补条目（FE-4：`listTaskLists` ⇒ `{ kind: 'ok', items: [], total: 0 }`；FE-7：`listUserGroups` ⇒ 一项合成默认组、`listUserGroupItems` ⇒ `{ kind: 'ok', items: [], total: 0 }`），`beforeEach` 里设缺省值 |
|---|---|---|
| `tasks-view.spec.ts` | 加 | 补 |
| `tasks-list-view.spec.ts` | 加 | 补 |
| `tasks-detail-view.spec.ts` | 加 | 补 |
| `tasks-view-transitions.spec.ts` | 加 | 补 |
| `tasks-detail-m3.spec.ts` | 加 | 补（工厂用 `importActual` 只取 `checkCommentBody`，其余是显式列表，追加三个 `vi.fn` 条目即可） |

理由：jsdom 的 `navigator.language` 是 `en-US`，回填后这五个文件会看到英文。`App.spec.ts`、`tasks-nav-badge.spec.ts`、`tasks-nav-feature-gate.spec.ts`、`tasks-badge.spec.ts` 已经 mock 了 `useLocale`；`tasks-nav-relogin.spec.ts` 没有也不需要（它只断言路由路径与请求名，`:238-240`）。既有断言一律不改。

---
## 10. 测试计划

### 10.1 spec 文件（9 个新文件 + 1 个既有文件加格 `tasks-routes.spec.ts` + 5 个既有文件只补 mock；FE-c 再加 1 个新文件 `tasks-counts-realtime.spec.ts`，并改写 `tasks-badge-m4.spec.ts` 的 13 格）

全部 mock `apiFetch` 或 `tasksApi` 的调用（后端 S5–S8 未建，与 M3 同一做法）；mount 用真实 `createRouter` / `createMemoryHistory`（既有 `tasks-detail-m3.spec.ts` 的 idiom）。token 名避开既有 token 的子串（`tasks-list-view.spec.ts` 已存在，新文件不得以它为子串，反之亦然）。

| 文件 | 切片 | 格（摘要） | 变异目标（改坏源码后必须有格变红） |
|---|---|---|---|
| `tasks-labels.spec.ts` | FE-0 | §9.3 的五组；`TasksView` 列表 / 详情（含 409 态、各错误态）、`TaskListView`、`TasksSettingsView`、`TasksTodoBadge` 四态在 EN 下零 CJK；ZH 下有 CJK；挂载后翻转 | 模板里硬编码一处中文 ⇒ EN 扫描红；`computed` 改成一次性求值 ⇒ 翻转格红；EN 表漏一键 ⇒ 键对齐格红；某码两语文案相同 ⇒ 第 2 组红 |
| `tasks-api-m4.spec.ts` | FE-1 | 每个新函数的方法 / 路径 / 请求体 / `encodeURIComponent`（逐函数一行表）；每个契约码 → kind；网络失败 ⇒ `error` 且 `status: 0`；路径段检查（空串、`.`、`..` 对每个 id 位：不发请求、返回规定 kind）；`patchTask` 只序列化给出的键、`undefined` 不发；409 带 / 不带 / 非法 `currentVersion`；`getTask` 新键的组规则与 malformed（`version` 为 0 / 负 / 小数 / 字符串 ⇒ error；四键缺一 ⇒ error；`listIds` 非字符串数组 ⇒ error）；`fetchPendingCount` 的 `badgeScope` 四种（`off` + 0 ⇒ ok off；`off` + 非 0 ⇒ error；`'overdue'` / 缺失 / 未知字符串 ⇒ ok 不带键、`count` 照常）；`createTask` 未枚举的 422 码（`VALIDATION_FAILED`）仍是 `{ kind: 'error', status: 422 }`；`listTasks` 不传 `page` 时请求串逐字节同今天；`total` 缺失 / 非法；分页循环（去重、截断、`isSuperseded` 停止、降级体无 `total`）；五个嵌套集合读的 `org_missing` 降级体；`parseTaskSettings` 闭集；`Group.id === null` 只在 `scope: 'user'` 合法；`tasksDraft.ts` 每条规则的正反例（闰年、`2031-02-30`、`24:00`、时间无日期、日期无时区、`asia/shanghai` 通过、`+08:00` 拒、`remindAt` 宽松形态拒、描述 20000 / 20001 码点含 emoji；`initDraft` 对 `dueTime: '10:00:00'` 给 `'10:00'`、对 `description: null` 给 `''`；`buildTaskPatch` 的「碰日期带时区」「清日期带时间 null」「只换时区」「无日期任务清时区 ⇒ 恰为 `{ timeZone: null }`」「服务端形夹具（`dueTime: '10:00:00'`、`description: null`、规范时区名）未改动 ⇒ `null`」「同一夹具只改标题 ⇒ 恰为 `{ title }`」） | 去掉任一 `isPathSafeSegment` 调用 ⇒ 该函数的三格红；`classifyWriteFailure` 的 `currentVersion` 解析放宽成任意数字 ⇒ 红；`buildTaskPatch` 漏带 `timeZone` ⇒ 红；`checkTaskDates` 用 `new Date(str)` 判日期 ⇒ `2031-02-30` 格红；`initDraft` 去掉 `slice(0, 5)` 或把 `description ?? ''` 改回原值 ⇒ 「未改动 ⇒ null」格红；`badgeScope` 非 `off` 判 `error` ⇒ 第三种格红；`createTask` 把全部 422 归 `validation` ⇒ `VALIDATION_FAILED` 格红 |
| `tasks-badge-m4.spec.ts` | FE-2 | `off`：`data-state="ready" data-scope="off" data-count="0"`、无数字、aria 文案；`on` 0 条与 `off` 的属性串不同；`unavailable` 的 `data-scope=""`；实时（组合式级）：`vi.mock('socket.io-client')` 注入假 `io`，用显式 `connect()`（`[fe-11]`）建立连接，事件到达 ⇒ 窗口结束时 `fetchPendingCount` 恰一次（FE-c 改写，`[fe-51]`）；连续三次总线 nudge ⇒ 只有最后一次结果落地（generation；FE-c 之前用的是三条事件）；窗口开着时的总线 nudge 回答信号（`[fe-52]`）；事件在 404 拆定时器之后到达 ⇒ 仍重拉一次、`ok` 则定时器重启；卸载后事件 ⇒ 不重拉；载荷为 `undefined` / 对象 / 字符串都触发。门（真实 `App` 挂载，`tasks-nav-badge.spec.ts` 的形状，策略模块 `vi.mock` 成恒真，§8.2）：feature on ⇒ 假 `io` 恰调用一次（正控）；feature off / 无 `tasks:read` / 公开路由 ⇒ 零次 | 事件处理里加 `if (payload.count !== undefined) count = payload.count` ⇒ 「载荷不读」格红；去掉 `disposed` 检查 ⇒ 卸载格红；`off` 时渲染数字 ⇒ 红；把 `useTasksCountsRealtime()` 挪到 `App.vue` setup 顶层 ⇒ off 门格红；策略模块恒假 ⇒ 正控格红 |
| `tasks-counts-realtime.spec.ts` | FE-c | 门 26 前端半（`gate26\|`，候选；2026-10-09 起按锁 PR 的格名带七格，见 §8.3 第 5 条）：事件 ⇒ 窗口结束时恰一次 `/pending-count` 请求，带重拉时刻的查看者时区与 `suppressUnauthorizedRedirect`；窗口：跨宏任务的 8 条信号 ⇒ 一次读、持续的信号 ⇒ 每窗口一次、读过之后的信号开新窗口、在途读不回答信号（旧读先到与后到两种）、窗口内开始的总线 nudge 与 60 s tick 回答信号、反序两次、隐藏页照读、卸载关窗；载荷：任何访问都记录并抛出的载荷零访问、六种类型各一次信号；socket：只听一个事件、从不 `emit`、连接参数不带 query；普查：`apps/web/src` 只有一处事件名写法（扫描器自带正控）；轮询：没有信号时 60 s tick 显示别的进程处理的写入、首次读失败后照样恢复；设置：没有 socket 时保存经总线重拉（关、开、只改每日提醒、422 不重拉）；真实壳层：`/login` 卸载红点并断开、再次登录用新令牌开新 socket、退出时开着的窗口不读、会话中途关 feature 即断开 | 立即读、窗口为 0、窗口可顺延、窗口永不读、去掉 `[fe-52]`、读完成才关窗、在途时丢信号、总线也进窗口、卸载不关窗、隐藏页跳过、去掉订阅（门 26 负控丁）、在线停轮询（挂载时与 tick 时两种）、改事件名、第二处写法、读载荷字段、只认对象载荷、发 join、握手带 userId、卸载不断开、socket 跨挂载复用、去掉时区头、时区缓存、去掉重定向抑制、设置保存不通知、只在改 `badgeScope` 时通知、红点不按公开路由卸载、壳层顶层另开 socket、窗口只开一次（结果在验证 MD 的 FE-c 节） |
| `tasks-settings-view.spec.ts` | FE-3 | 五个读态；表单初始化（含 `timeZone: null` 留空）；每个字段的预检码行内文案；只发改动键（请求体逐字节断言，含 `timeZone: null`、不含 `undefined` 键）；六个服务端码各自落点；`org_missing` 引导块；成功回填规范名、`notifyTasksChanged` 恰一次、「已保存」；一次一个；晚到结果（提交中导航离开）不写表单；「使用浏览器时区」按钮填 `resolveViewerTimeZone()`；勾选每日提醒自动填时区；路由 meta 格见 `tasks-routes.spec.ts` | 保存发全量键 ⇒ 请求体格红；成功不 `notifyTasksChanged` ⇒ 红；`badgeScope` 发 `null` ⇒ 红 |
| `tasks-detail-m4.spec.ts` | FE-4 | 编辑区只在 `canEdit`、S4 四键组与 `version` 都在时渲染（main 上 M3 的详情体带 `version` 而无 S4 键：不渲染）；只读新字段的三行；草稿初始化与「服务端已更新」提示；`buildTaskPatch === null` 时按钮禁用、不发；预检八种码各自落点；提交体含 `expectedVersion: task.version`；§7.3 状态机每条边一格（409 ⇒ 重拉 ⇒ `conflict` 提示含版本号、草稿保留、再提交用新 `version`；重拉失败 ⇒ 无版本号且按钮禁用；放弃 ⇒ 草稿 = 现值）；`notifyTasksChanged` 只在截止 / 时区键变化时发；服务端形夹具（`dueTime: '10:00:00'`、`description: null`）未改动 ⇒ 按钮禁用、不发请求、不 `notifyTasksChanged`，只改标题 ⇒ 体恰为 `{ expectedVersion, title }`；**草稿跨重拉存活**：输入标题后触发一个 M3 动作（如添加负责人）成功重拉 ⇒ 未保存草稿仍在且显示「服务端已更新」；晚到结果守卫（含「离开又回来」）；一次一个（与 M3 动作互斥，两个方向各一格：编辑提交中完成 / 删除按钮禁用；M3 动作进行中编辑提交禁用）；路由边沿清草稿；「所属清单」：`listIds` 缺失不渲染、名字映射、非成员清单显示 id、加入下拉只列 edit / owner 且未含、`LIMIT` / `not_found` 文案、移出两步确认、成功重拉、**与 M3 动作互斥两个方向各一格**（清单项加入进行中完成 / 删除按钮禁用；M3 动作进行中加入 / 移出禁用）、成功不 `notifyTasksChanged` | 409 分支不重拉 ⇒ 红；`expectedVersion` 取 `currentVersion` ⇒ 「用重拉后的 version」格红；`notifyTasksChanged` 对标题改动也发 ⇒ 红；编辑区在 `version` 缺失时渲染 ⇒ 红；把草稿改回编辑器自持（`ref` 在子组件内）⇒ 「草稿跨重拉存活」格红；`initDraft` 去掉 `slice(0, 5)` ⇒ 「未改动 ⇒ 禁用」格红；清单项写改为子组件直接调用 `addTaskToList`（绕过父 handler）⇒ 互斥格红 |
| `tasks-lists-sidebar.spec.ts` | FE-5 | 五态 + `empty` 文案；分页「加载更多」直到 `total`；已归档开关从 0 重读、旧页结果晚到被丢弃（generation）；新建：预检、`validation` 两码、成功清空 + 重读 + `router.push`；`org_missing` 上报父组件；角色徽标三种；左栏全部 `data-testid` 以 `tasks-lists-` 为前缀且不含 `tasks-view.spec.ts` TESTIDS 的任何 id（§4.1 `[fe-18]`） | 去掉 generation ⇒ 晚到格红；新建成功不跳转 ⇒ 红；左栏某节点改用 `tasks-list-empty` ⇒ 本格与 `tasks-view.spec.ts` 的精确集合格同时红 |
| `tasks-list-detail.spec.ts` | FE-5 | `/task-lists/:id` 五态（`not_found` 文案）；四读并行、各自 generation；任一板读失败 ⇒ 平铺 + 提示；截断 ⇒ 禁用重排；改名内联（`pending`、两码、重读）；归档 / 取消归档（重读、`notifyListsChanged`）；加入任务（空输入不发、`INVALID_TASK` / `LIMIT` / 404 文案、成功重读两面）；移出两步确认；动态分页与未知 `eventType`；`/task-lists/a → /task-lists/b` 复位与重读；控件显隐按 `myRole` 三种（§5.1 表逐行） | 改名成功不重读 ⇒ 红；`read` 角色仍显示改名表单 ⇒ 红；id 变化不复位草稿 ⇒ 红 |
| `tasks-list-members.spec.ts` | FE-6 | 打开读成员；§5.1 每条推断规则一格（含 `currentUserId` 三态下退出按钮的显隐）；角色下拉 `:value` 绑定不自改；添加 / 改角色 / 移除 / 转让：请求体、七个码落点、成功用响应替换列表、转让后重读清单行；本人退出：确认、`router.push('/tasks')`、`notifyListsChanged`；**本人那一行不显示「移除」按钮**（即使我有管成员权且自己不是创建人 / owner）；对话框 a11y（`role="dialog"`、`aria-modal`、打开后 `document.activeElement` 是 `<h2 tabindex="-1">`、Esc 关闭、焦点归还触发按钮、Tab 回绕）；一次一个（`v-model:pending`：对话框写进行中，清单页的改名 / 归档按钮也禁用） | 创建人行显示移除按钮 ⇒ 红；本人行显示移除按钮 ⇒ 红；去掉 `tabindex="-1"` ⇒ 焦点格红；转让后不重读清单行 ⇒ 红；Esc 不关 ⇒ 红 |
| `tasks-groups.spec.ts` | FE-7 | 分组板两种 scope：渲染顺序（`position, id`；组内 `position, task_id`；未排序尾段 = 服务端顺序）；**根容器带 `data-testid="tasks-list"`**，且板内没有 `tasks-view.spec.ts` TESTIDS 的其他 id；「分配给我」视角的状态表（§2.4）逐行：`listResult` 为 `empty` / `error` 时板不挂载、不发分组读；两读 pending 时渲染平铺 `tasks-list` + 同序 `tasks-list-item`；任一读失败 ⇒ 平铺 + `tasks-groups-unavailable`；两读 ok ⇒ 板；无自建分组、无摆放行时 `tasks-list-item` 的 DOM 顺序与平铺逐项相同；个人 scope 默认组 `id === null` 时首次 `PUT` 成功 ⇒ 重读两面后任务仍在默认组有序区；`placements` 的 `groupId` 不匹配任何本地分组 ⇒ 归入默认组有序区而不是消失；拖放计算 `position`（同组上移 / 下移 / 跨组 / 放到尾段 = `len`）；放回原处不发请求；乐观更新 + 失败回滚快照 + 三种码的处理；pending 期间 `draggable=false` 与按钮禁用；键盘：上移 / 下移 / 加入排序 / 移到分组的请求体、焦点保持、aria-live 文案；默认组 `null` 发送；个人默认组 `id === null` 时改名禁用；建组上限 50 禁用；删组重读；「分配给我」视角下读两面、任一失败回退平铺、其他视角不读；完成 / 重启按钮 emit 给父组件 | `position` 用服务端回传值做算术 ⇒ 红；失败不回滚 ⇒ 红；尾段可拖 ⇒ 红；个人 scope 发默认组真实 id 而不是 `null` ⇒ 红；板根容器去掉 `data-testid="tasks-list"` ⇒ 本格与 `tasks-list-view.spec.ts:134` 同时红；重排成功只重读摆放 ⇒ 首次 `PUT` 格红；`listResult` 为 `empty` 时也挂板 ⇒ `tasks-view.spec.ts` 的 TESTIDS 格红 |
| `tasks-routes.spec.ts`（既有，加格） | FE-3 / FE-5 | `/tasks/settings` 与 `/task-lists/:id` 的 meta 投影（`requiresAuth`、`permissions` 深等于 `['tasks:read']`、`requiredFeature === 'tasks'`、`title` / `titleZh` 非空）；懒加载指向各自的 `.vue`；门 22 的 allow / redirect / 焦点-attendance / 焦点-plm / feature-off 五格对两条新路径各复制一份；`router.resolve('/tasks/settings').name === 'tasks-settings'`（静态段胜出） | 新路由漏 `requiredFeature` ⇒ 红；`/tasks/settings` 写在 `/tasks/:id` 之后且被参数路由吃掉 ⇒ resolve 格红（vue-router 评分应仍让静态段胜，此格是防御） |
| 既有五个 `TasksView` spec（§9.4 的文件表：`tasks-view`、`tasks-list-view`、`tasks-detail-view`、`tasks-view-transitions`、`tasks-detail-m3`） | FE-0 / FE-4 / FE-5 / FE-7 | FE-0 只加 `useLocale` mock；FE-4 / FE-5 给五个文件的 `tasksApi` mock 工厂补 `listTaskLists`（空）；FE-7 再补 `listUserGroups`（返回合成默认组）与 `listUserGroupItems`（空）两个空转条目。断言一律不改，于是这五个文件就是「板根容器仍是 `tasks-list`」与「无摆放行时 DOM 同序」的回归锚点 | FE-7 的 stub 改回返回 `error`（让板永远回退）⇒ `tasks-groups.spec.ts` 的板格红；板根容器改名 ⇒ 这五个文件的 `tasks-list` 格红 |

每个新 spec 的头注写清 mock 面与「后端未建 / 只按契约」。

### 10.2 变异纪律

照 M3 验证 MD：审阅后对每个新守卫做一轮变异（先 `cp` 备份、改坏、跑该 spec、还原、`filecmp` 比对），结果写进 M4 前端验证 MD 的表；等价变异单独标明并删去冗余检查。至少覆盖上表最右列全部条目。

### 10.3 登记（门 21 / 22，三处必须同 PR）

**① `apps/web/scripts/run-required-web-tests.sh`** 的 `exec npx vitest run` 续行块（M3 分支上在 `:1816-1828`，实现当日重查行号）：插入 9 个新 token，保持该块现有的 `LC_ALL=C` 字节序（`-` 先于 `.`，所以 `tasks-api-m4.spec.ts` 在 `tasks-api.spec.ts` 之前）。最终 22 个任务 token 的顺序：

```
tasks-api-m3.spec.ts  tasks-api-m4.spec.ts  tasks-api.spec.ts  tasks-badge-m4.spec.ts  tasks-badge.spec.ts
tasks-context.spec.ts  tasks-detail-m3.spec.ts  tasks-detail-m4.spec.ts  tasks-detail-view.spec.ts
tasks-groups.spec.ts  tasks-labels.spec.ts  tasks-list-detail.spec.ts  tasks-list-members.spec.ts
tasks-list-view.spec.ts  tasks-lists-sidebar.spec.ts  tasks-nav-badge.spec.ts  tasks-nav-feature-gate.spec.ts
tasks-nav-relogin.spec.ts  tasks-routes.spec.ts  tasks-settings-view.spec.ts  tasks-view-transitions.spec.ts
tasks-view.spec.ts
```

FE-c 加 `tasks-counts-realtime.spec.ts`，按同一字节序插在 `tasks-context.spec.ts` 之后、`tasks-detail-m3.spec.ts` 之前，任务 token 变为 23 个。

每个新 token 跑锁 §5.3 的两条碰撞检查并把输出写进 PR body：

```bash
find apps/web -path '*/node_modules' -prune -o -name '*.spec.ts' -print -o -name '*.test.ts' -print | grep -c -- '<token>'          # 必须 = 1
find apps/web -path '*/node_modules' -prune -o -name '*.spec.ts' -print -o -name '*.test.ts' -print | grep -- '<token>' | grep -c 'apps/web/verification/'   # 必须 = 0
```

**② `apps/web/scripts/run-required-web-tests.tokens`**：不手改，跑 `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（不带 `--write` 是检查模式，漂移退出 1）；`packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts` 断言脚本 token 集合与清单文件集合相等，漏跑即红。

**③ `.github/workflows/tasks-web-guard.yml`**：step 的 `vitest run` 参数逐文件追加 9 行 `tests/tasks-….spec.ts`（cwd 是 `apps/web`，不加前缀、不用 glob），顺序同上；注释「Fourteen whole-file args」改为 **「Twenty-three whole-file args」**（22 个任务文件 + `tests/App.spec.ts`；FE-c 起 **Twenty-four**，23 个任务文件）；`on.paths` 不改（`apps/web/tests/tasks*.spec.ts` 与 `apps/web/src/views/tasks/**` 已覆盖新文件；`apps/web/src/router/appRoutes.ts` 已在列）。头注追加一段 M4 说明（文件清单与各自守什么），**约束**：这段只写裸文件名（如 `tasks-api-m4.spec.ts`，M3 段的既有写法），不得出现 `vitest run` 字样，也不得出现 `tests/tasks….spec.ts` 形式的路径——门 21 的 G() 从首个匹配 `vitest run` 的行开始抽取、按 `tests/tasks…spec.ts` 正则取文件且不去重，头注命中会把文件数翻倍、D = T = G 变红（今天的头注 `:4-5` 只是靠换行把 `vitest` 与 `specs` 隔开才没命中）；改 yml 后立即重跑 D = T = G。

**三集合核对**（门 21 的 D = T = G，每片结束各跑一次，输出进验证 MD）：

```bash
D() { find apps/web/tests -maxdepth 1 -name 'tasks*.spec.ts' -print | sed 's|.*/||' | LC_ALL=C sort; }
T() { awk 'found{print} /^exec npx vitest run/{found=1; print} found && !/\\$/ {exit}' apps/web/scripts/run-required-web-tests.sh | tr -d '\\' | tr -s ' \n' '\n' | grep -E '^tasks.*\.spec\.ts$' | LC_ALL=C sort; }
G() { awk '/vitest run/{p=1} p{print} /reporter=/{exit}' .github/workflows/tasks-web-guard.yml | grep -oE '(apps/web/)?tests/tasks[^[:space:]*]+\.spec\.ts' | sed 's|^apps/web/||; s|.*/||' | LC_ALL=C sort; }
diff <(D) <(T) && diff <(T) <(G) && echo D=T=G
```

每片只登记自己新增的文件；切片结束时三集合必须已相等（不允许「先加文件、下一片再登记」——那正是 skip 形状的绿）。

### 10.4 每片的绿线

每片结束：`pnpm --filter @metasheet/web exec vitest run tests/App.spec.ts tests/tasks-*.spec.ts --reporter=verbose`（本地可用 glob；CI 的 step 必须逐文件）、`pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）、`node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式）、`pnpm --filter @metasheet/core-backend exec vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`、D = T = G。收集用例数从 verbose 日志读出写进验证 MD（零收集的绿无效）。

（FE-8 更正：#6159 已于 2026-10-07 合入 main（`cc6ca96ac2`），本分支就以它为基，Draft PR 以 main 为基，`web-tests` 与 `plugin-tests` 在 PR 上会触发；下面这段是起草时的前提，留作记录，本地运行照做。）这些本地运行**不是可选项**：以 #6159 分支为基的 Draft 上，CI 只会跑 `tasks-web-guard`（paths 触发）；`web-tests.yml` 与 `plugin-tests.yml` 的 `pull_request` 都只对基分支 `main` / `develop` 触发，所以登记 ①（lane token）与 ②（`.tokens` 清单 + 它的单测守卫）在 PR 改基到 main 之前没有任何 CI 执行它们（§12-Q12）。收口片（FE-8）另跑一次完整的 `bash apps/web/scripts/run-required-web-tests.sh`，输出进验证 MD。

### 10.5 真机

- 对 PR-3a 分支本地起后端（`TASKS_ENABLED=true`、M4 迁移应用到一次性库）跑设置页、详情编辑、409（两个标签页并发保存）、红点 `off`；S5–S8 落地后补清单 / 分组；PR-3c 落地后补实时。每项在验证 MD 里记「跑过 / NOT RUN」，不写成已验证。
- staging / 生产不触达。

---
## 11. `ASSUMPTION(task-m4-fe)` / `RULED(2026-10-07)` 全表

**标签约定（FE-8 起）**：owner 2026-10-07 已裁的条目在代码里标 `RULED(2026-10-07): [Rxx]`，下表该行标 **ruled 2026-10-07**；已裁的是 R01–R23 与 N1 / N2、R12 取 PR-3a 的收窄版 (a1) / (a2)（PR-3a 的 `[own-25]`）、增删负责人与关注人须直接角色（PR-3a 的 `[own-53]`，本件的 `[fe-45]`）、`[fe-19]`。D 条目（`[D5]` `[D7]` `[D14]`）与 PR-3a 的其余 `[own-NN]` 没有裁，代码里仍标 `ASSUMPTION(task-m4-fe): [xx]`。一行注释原先同时写着已裁与未裁的条目时，FE-8 把它拆成一行 `RULED` 与一行 `ASSUMPTION`。owner 2026-10-09 另裁 `[fe-51]` `[fe-52]`（门 26）：下表这两行标 **ruled 2026-10-09**，代码里照 `[fe-45]` 的先例写作 `[fe-51] ruled 2026-10-09`。

依赖裁决包条目的（代码注释只写条目 id）：

| 标签 | 内容 | 位置 |
|---|---|---|
| `[R02]` | **ruled 2026-10-07**。设置页四个字段与缺省值（`overdue` / 关 / `default` / 空）；闭集文案 | `TasksSettingsView.vue`、`labels.ts` |
| `[R03]` | **ruled 2026-10-07**。编辑走 `PATCH /api/tasks/:id` + `expectedVersion`，409 回滚提示；提醒经同一 PATCH，不另开端点；详情的 `version` 作乐观锁输入 | `TaskDetailEditor.vue`、`patchTask`、`tasksDraft.ts` |
| `[R04]` | **ruled 2026-10-07**。清单成员经详情 200 看到任务但五个视角不列它：详情页的「所属清单」与清单页的任务行都不假设任务出现在任何视角 | `TaskDetailLists.vue`、`TaskListView.vue` |
| `[R07]` | **ruled 2026-10-07**。每日提醒开关与时区字段并列；开启要求时区 | 设置页 |
| `[R11]` | **ruled 2026-10-07**。个人分组只在「分配给我」视角；每容器恰一个默认组；删组回默认组（默认组落行前的 `null` id 不属于 R11，见 `[own-24]`） | `TaskPersonalGroups.vue`、`TaskGroupBoard.vue`、`TaskListView.vue`（分组读）、`tasksApi.ts`（`Group` 解析） |
| `[R12]` | **ruled 2026-10-07**，取 PR-3a 的收窄版：(a1) 把任务加入清单要求对任务有直接角色（创建人或负责人），(a2) 任务创建人可以把自己的任务移出任一包含它的清单；见 `[own-25]`。角色显隐规则（§5.1）；`owner` 不可直接指派；创建人不可移除；所有者先转让（「本人退出」不属于 R12，见 `[own-14]`） | `TaskListMembersDialog.vue`、`TaskListView.vue`（改名 / 归档 / 清单项控件的显隐） |
| `[R13]` | **ruled 2026-10-07**。清单无删除入口，只有归档 | `TaskListView.vue` |
| `[R15]` | **ruled 2026-10-07**。分页 `limit` 100、`offset`、`total`、分页码 422（「读全部页上限 20 页」是 `[fe-13]`） | `tasksApi.ts` |
| `[R16]` | **ruled 2026-10-07**。事件名 `tasks:counts-updated`、按用户房间、载荷不读、收到重拉；FE-c 按 PR-3c 重核一致（§8.3），重拉按窗口合并（`[fe-51]`） | `useTasksCountsRealtime.ts`、`useTasksBadge.ts` |
| `[R20]` | **ruled 2026-10-07**。取 (a)：全部任务文案进 `labels.ts`，回填 M2 / M3，中英 spec | `labels.ts`、`tasks-labels.spec.ts` |
| `[R01]` | **ruled 2026-10-07**。M4 退出条件含门 21 / 22 的 M4 子集行；本件的 spec 登记（三处）与两条新路由的 meta 格即这两行的前端候选；何时入锁计分仍待 owner 点名（§12-Q11） | `run-required-web-tests.sh`、`.tokens`、`tasks-web-guard.yml`、`tasks-routes.spec.ts` |
| `[R17]` `[N2]` | **ruled 2026-10-07**。负责人、关注人与清单成员的写入校验本 org 在职，一个 422 码 `INACTIVE_ORG_MEMBER`：清单成员的添加与转让（§5.3），PR-3a S9 起还有任务的创建与增负责人、增关注人；前端全线一条文案（§9.2） | `labels.ts`、`TaskListMembersDialog.vue`、`TasksView.vue`（创建表单、两处行内错误）、`tasksApi.ts`（`createTask` 的 allowlist） |
| `[D5]` | `off` 的呈现（§8.1）。状态字面量沿用 M2 既有的 `ready`（`tasks-badge.spec.ts:89-150`、`tasks-nav-feature-gate.spec.ts:197` 钉着它，改名会让 M2 守卫变红）；只有 `data-scope` 属性与「`off` 时不渲染数字」是按 D5 新加的 | `TasksTodoBadge.vue`、`useTasksBadge.ts` |
| `[D7]` | 时区大小写变体客户端放行，显示服务端回填的规范名 | `tasksDraft.ts` |
| `[D14]` | 名称 100 码点、分组 50、单任务 10 清单、成员 100 的本地预检与禁用阈值 | `tasksDraft.ts`、分组板（`tasksGroupBoard.ts` 的 50 组上限，`TaskGroupBoard.vue` 的组名预检与 `LIMIT` 文案）、成员对话框、`TaskListsSidebar.vue` / `TaskListView.vue`（名称预检、`LIMIT` 文案） |
| `[own-25]`（PR-3a） | **ruled 2026-10-07**（R12 的收窄版）。加入清单 404 的解释文案按「需要创建人或负责人」写；创建人移出支路按钮对所有 `listIds` 行显示 | `TaskDetailLists.vue`、`TaskListView.vue`（加入任务 404 的合写文案）、`labels.ts` |
| `[own-24]`（PR-3a） | 个人默认组落行前 `id === null`、不可改名 | `TaskGroupBoard.vue`、`TaskPersonalGroups.vue`、`labels.ts`（改名提示）、`tasksApi.ts`（`Group` 解析） |
| `[own-06]`（PR-3a） | 改截止日不带 `remindAt` 时提醒不动；界面提示一句 | `TaskDetailEditor.vue` |
| `[own-07]`（PR-3a） | 碰日期必带时区；清日期带时间 `null` | `buildTaskPatch` |
| `[own-11]`（PR-3a，§12-Q12 待裁） | `badgeScope` 键只在 `off` 时出现。前端按容忍解析（`[fe-14]`），owner 的任一答案都不需要改前端 | `fetchPendingCount`、`useTasksBadge.ts` |
| `[own-14]`（PR-3a） | 成员经同一条 `DELETE` 退出清单；§5.1「本人退出」行与 §5.2 退出按钮 | `TaskListMembersDialog.vue` |
| `[own-29]`（PR-3a） | 服务端把 `''` 时区读作 `null`；客户端清时区只发 `null`，且只在任务没有日期时允许 | `tasksDraft.ts` |
| `[R19]` | **ruled 2026-10-07**。清单动态：清单页的动态面板展开时才读第一页，逐页「加载更多」，闭集外的事件词原样显示；不做推送（§6.5） | `TaskListView.vue`、`labels.ts` |
| `[own-09]`（PR-3a） | 行级判定一律 404：清单页 not_found 的文案合写「不存在」与「不是成员」两种原因 | `TaskListView.vue`、`labels.ts` |
| `[own-19]`（PR-3a） | 缺 org 的三种答法：设置读 404（文案合写两种原因）；设置写与清单写 422 `ORG_MISSING` ⇒ 引导块；「我的清单」读回降级体 ⇒ 左栏上报同一引导块 | `TasksSettingsView.vue`、`TaskListsSidebar.vue`、`TaskListView.vue`、`labels.ts` |

本件自己的取舍：

| 标签 | 内容 |
|---|---|
| `[fe-01]` | 不先拆 `TasksView.vue`；新面以子组件 / 新路由组件落地（§2.3） |
| `[fe-02]` | 加入清单的 404 在详情页解释为「需要是创建人或负责人」（契约三条件同一 404，文案只能合写） |
| `[fe-03]` | 设置页与编辑器不拦截离开（无 `beforeunload`） |
| `[fe-04]` | 成员写成功用响应 `members` 直接替换列表（悲观重拉的唯一例外之二，另一是重排） |
| `[fe-05]` | 无行任务作「未排序」尾段、每个手势恰一条 `PUT`，不做多请求序列 |
| `[fe-06]` | 勾选每日提醒而时区为空时自动填浏览器时区并提示，不硬拒 |
| `[fe-07]` | 设置页路径 `/tasks/settings`、清单页 `/task-lists/:id`、无 `/task-lists` 索引页 |
| `[fe-08]` | 红点在线时轮询照跑，不做「在线停轮询」。FE-c 补理由：PR-3c 的 socket 服务是进程内 adapter，别的后端进程处理的写入只能靠轮询到达这个标签页（§8.2、§8.3 第 9 条），所以轮询是必需的，不只是断线回退 |
| `[fe-09]` | 创建表单本期不加日期字段 |
| `[fe-10]` | `listTasks` 不传分页参数（请求串与今天相同），`total` 只解析不使用 |
| `[fe-11]` | 实时组合式的自动连接判据放在独立的 `tasksRealtimePolicy.ts`，spec 用 `vi.mock` 把它换成恒真、用 `vi.mock('socket.io-client')` 注入假 `io`，并另有显式 `connect()`；生产缺省行为与两个既有组合式相同 |
| `[fe-12]` | 对话框焦点陷阱用最小自实现（Tab 回绕），不引入依赖 |
| `[fe-13]` | 「读全部页」的上限 20 页，沿用 `COMMENTS_MAX_PAGES`（M3 自选值） |
| `[fe-14]` | `badgeScope` 容忍解析：只有 `'off'` 有语义，缺失 / 闭集内其他值 / 未知值一律视为开启；仅 `'off'` + `count ≠ 0` 判 `error` |
| `[fe-15]` | 详情页两个新区的状态（编辑器草稿 / 冲突态、「我的清单」读）由 `TasksView` 持有，子组件无状态；清单项的写走父组件 handler 与 M3 同一 token |
| `[fe-16]` | 「分配给我」视角的分组板只在 `listResult.kind === 'ok'` 时挂载、读 pending / 失败时回退平铺、根容器保留 `data-testid="tasks-list"`（§2.4 状态表） |
| `[fe-17]` | 草稿与比较的规范形：时间 `HH:MM`（服务端 `HH:MM:SS` 截断）、描述 `null` ≡ `''`、时区 `null` ≡ `''`（`initDraft`） |
| `[fe-18]` | 左栏 `TaskListsSidebar` 的 `data-testid` 全部以 `tasks-lists-` 为前缀，不与 `tasks-view.spec.ts` TESTIDS 的任何 id 同名（§4.1） |
| `[fe-19]` | 409 之后（以及编辑区之外触发的任何重拉之后）草稿只保留用户改过的字段：草稿值与草稿取自的服务端值不同的字段保留草稿值，其余字段取重拉后的值；提醒只在碰过且不同时算改过；下一次保存的 `expectedVersion` 取重拉后的 `version`（`tasksDraft.ts#rebaseDraft`；§12-Q15）。**ratified 2026-10-07** |
| `[fe-20]` | 详情带 S4 四键组时，开始日期、描述、提醒三条只读行总是渲染，编辑区打开时同样渲染（§12-Q16） |
| `[fe-21]` | 清单页的页面态只取自清单读：清单项读的任何失败（含 404）只把清单项区换成「暂时无法读取」，页头、改名与归档照常；清单项读不是 `ok` 时不渲染加入任务表单（§12-Q17） |
| `[fe-22]` | 左栏读的 404 是单独的「清单功能暂不可用」态，403 是「无权限」态，二者都不用失败文案（§12-Q18） |
| `[fe-23]` | 清单总线的范围：清单页改名 / 归档 / 取消归档与左栏新建的 `ok` 都通知，晚到的 `ok` 也通知；左栏收到即从 offset 0 重读（新建后的重读也走这条），`TasksView` 只在 context `ready` 且在详情页时重读「我的清单」；清单项的加入 / 移出不通知（§12-Q19） |
| `[fe-24]` | 清单页写成功后安静重读：内容保留、写控件保持禁用直到重读回来；写的 404 / 403 / 失败只出页面横幅，不重读清单（§12-Q20） |
| `[fe-25]` | 动态面板每次展开都重读第一页，换清单时收起；每条只显示操作者、事件词与时间，不读 `payload`（§12-Q21） |
| `[fe-26]` | 归档的创建人那一半在当前用户 id 解析中（`pending`）时同样隐藏，解析出来后才出现（§12-Q22） |
| `[fe-27]` | 成员对话框的转让走行内两步确认（§5.2 只画了一个「设为所有者」按钮）：转让后本人降为 `edit`，不能自己转回来（§12-Q23） |
| `[fe-28]` | 行内「改角色」与「移除」都不出现在本人那一行；当前用户 id 解析中（`pending`）或解析失败（`unavailable`）时所有行都不出现这两个控件：解析出来之前分不出哪一行是本人。§5.1 只对「移除」排除了本人行，也没写 id 未知时的取法；本人把自己降为 `read` 之后自己升不回来（§12-Q24） |
| `[fe-29]` | 添加成员表单的角色缺省为 `read`（§12-Q25） |
| `[fe-30]` | 任何写进行中（对话框的或页面的）对话框的关闭按钮禁用、Esc 不关，直到结果落地：转让与退出成功后的后续（页面重读清单、回到 `/tasks`）由仍挂着的对话框发起，关闭之后晚到的结果只通知清单总线（§12-Q26） |
| `[fe-31]` | 成员读不是 `ok` 时对话框不渲染任何写控件（同 `[fe-21]` 的理由）；成员域的 404（读或写）显示「清单不可用或你已不是成员」并请页面安静重读清单（§5.3）；写的 404 在页面重读之后对话框仍在时，另重读一次名单，让服务端已没有的行消失 |
| `[fe-32]` | 转让成功也通知清单总线（本人的角色变了）；转让与退出晚到的成功同样通知；加人、改角色、移除他人不通知（「我的清单」不变）。§12-Q19 的范围随之扩到转让 |
| `[fe-33]` | 分组板的行内容来自宿主的 `row` 插槽，同一宿主的平铺列表（分组读未齐 / 失败时）与分组板用同一份行内容；「分配给我」行里的完成 / 重启仍是 `TasksView` 自己的处理函数（§4.6 写的是 emit 回传）；`TasksView` 其余视角的平铺 `<ul>` 不动，插槽里的同一份行标记由 spec 钉成与它逐元素相同（§12-Q27） |
| `[fe-34]` | 分组板的 404 / 403 / 失败与两种移动码落在板自己的横幅 `tasks-groups-banner`，不借宿主页的横幅（§4.0 写的是页面通用横幅）：个人 scope 没有页面横幅可借，清单页写 404 的文案也不合一次移动的 404（§12-Q28） |
| `[fe-35]` | 只在板的下标空间就是服务端的时候提供移动：三读都没截断、每条摆放指向一行已显示的任务、每条摆放指向一个已知分组；否则顺序照显示、移动全部禁用并提示「部分任务未显示，排序已停用」（§6.4 只写了截断；「分配给我」的列表读一页 100 行，第一页之外的已摆放任务会让本地下标错位）（§12-Q29） |
| `[fe-36]` | 拖拽：句柄是行首的非按钮元素（`role="img"`，`aria-label`「拖动以排序」）并是拖拽源；放到一行上 = 之前，放到它的下半部 = 之后；放到分组空白处或「未排序」尾段 = 该组有序区末尾（§6.2 只写了「放置点前面的行数」）（§12-Q30） |
| `[fe-37]` | 分组读回来却不能成板（没有或不止一个默认组；非默认组没有 id、id 为空或重复）⇒ 与分组读失败同样处理：平铺 + 「分组不可用」 |
| `[fe-38]` | 键盘移动之后焦点回到同一任务的同一控件；该控件禁用（移到顶 / 底）或不在了（「加入排序」之后）⇒ 回到该任务的「移到分组」下拉（§6.3 只写了同一按钮） |
| `[fe-39]` | 「刷新」按一次写处理（持有共享 `pending` 直到读回来），重读行、分组与摆放（清单页另重读清单，`[fe-44]`） |
| `[fe-40]` | 「分配给我」的行属于 `TasksView`：板的刷新与写的 404 经 `TasksView` 新增的 `reloadListQuietly()` 安静重读列表（行留在屏上，板与它的横幅不卸载），分组与摆放由 `TaskPersonalGroups` 重读——§4.4「重读整板」在个人 scope 的取法；`TasksView` 既有函数体不变 |
| `[fe-41]` | 分组名按服务端给的显示，默认组也一样：PR-3a 的默认组名是服务端常量（中文），英文界面在改名之前看到的是它（§12-Q31） |
| `[fe-42]` | 清单页的清单没有任务时仍显示分组板（在既有的空态文案之下），组的建 / 改 / 删照常可用 |
| `[fe-43]` | `INVALID_POSITION` 与 `INVALID_GROUP` 用 §9.2 码表的文案（「位置已变化，请刷新后重试」「分组不存在」；§6.5 写的是「顺序已被他人更新，已刷新」，§4.4 写的是「分组已不存在」），板照样自动重读分组与摆放 |
| `[fe-44]` | 清单页的分组板写回 404、以及板的「刷新」，除了清单项、分组与摆放，另请页面安静重读清单（成员对话框 `[fe-31]` 的同一做法，复用 `reloadListQuietly()`）：失去清单的人看到 not_found，角色变了控件随之变；页面自己的写回 404 仍只出横幅（`[fe-24]`，§12-Q20）（§12-Q32） |
| `[fe-45]` | **ruled 2026-10-07**（PR-3a 的 `[own-53]`）：详情页增删负责人、增删关注人的四个控件看 `canManageMembers`（创建人或负责人），不再看 `canEdit`；完成方式、父任务、编辑区仍看 `canEdit`，退出看 `canLeave`（§4.3） |
| `[fe-46]` | `canManageMembers` 缺键（main 上 M3 的响应）时四个成员控件退回 `canEdit`：该后端对这四条写的判据就是 `edit`（只有创建人与负责人有它），退回它与服务端逐一相符，M3 的既有格也原样成立；不取「缺键即隐藏」（M3 后端上的创建人与负责人会看不到控件），也不取「缺键即显示」（会对关注人显示必然 404 的控件）（§12-Q33） |
| `[fe-47]` | 详情页「所属清单」区的加入下拉看同一个成员管理能力（`canManageMembers`，缺键退回 `canEdit`）：(a1) 的任务端判据就是直接角色；移出仍看 `canEdit`（清单编辑者可以移出，创建人有 (a2) 支路）（§12-Q34） |
| `[fe-49]` | 成员对话框的转让与退出确认：打开 ⇒ 焦点到确认按钮（`aria-describedby` 指向提示句，提示句 `role="status"`）；取消 ⇒ 焦点回到换回来的按钮。独立闸审在真机里发现：打开或取消确认后焦点落到对话框之外，Esc 不再关闭、提示也不被播报（§5.2 的契约；`[fe-48]` 只管写之后）（§12-Q35） |
| `[fe-50]` | 页面上非写的就地切换（清单页的移出确认与改名表单、分组板的删组确认与改组名表单、详情页「所属清单」区的移出确认、编辑区的「放弃我的修改」）之后焦点不落到 `body`：打开 ⇒ 确认按钮（由提示句描述）或输入框；取消 ⇒ 换回来的按钮；放弃 ⇒ 编辑区标题（§4.0；§12-Q35） |
| `[fe-48]` | 成员对话框在每次写落地之后把焦点收回对话框：焦点已在对话框内就不动，在对话框外（浏览器把被禁用控件上的焦点移到 `body`，或发起写的控件被转让 / 移除拿走）就还给发起写的控件（仍在、未禁用），否则给标题。FE-8 真机走查发现：没有这一条时，任何一次写之后 Esc 与 Tab 回绕都失效（§5.2 的契约）（§12-Q35） |
| `[fe-51]` | **ruled 2026-10-09**（门 26）。计数信号不立即重拉：第一条信号打开 500 ms 的窗口（`TASKS_SIGNAL_WINDOW_MS`），窗口里的信号都被吸收，窗口结束时恰一次读；窗口从第一条信号起算、不顺延（§8.2；取代 FE-2 时的不另加防抖） |
| `[fe-52]` | **ruled 2026-10-09**（门 26）。窗口开着时开始的任何读（60 s 钟、总线 nudge）回答窗口吸收的信号并关闭窗口；窗口打开时已在途的读不回答（§8.2、§8.3 第 6 条） |
| `[fe-53]` | 窗口的读在隐藏页照发（隐藏页跳过只属于 60 s 钟） |
| `[fe-54]` | 设置页每次保存成功都重拉红点，不只改了 `badgeScope` 的那次：PR-3c 对设置写入不发信号（`[own-3c-04]`），这一次 nudge 是下一次轮询之前唯一的提示 |

---

## 12. 只有 owner 能答的问题（每条附保守缺省）

1. **`TasksView.vue` 拆分**：是否接受「M4 不拆、M4 之后单独清理片」（§2.3）；若要求先拆，清理片必须重写 6 个守卫，M4 顺延一片。缺省：不拆。
2. **路由路径**：`/tasks/settings`（静态段压在 `/tasks/:id` 之上）与 `/task-lists/:id`；是否要 `/task-lists` 索引页。缺省：如 §2.1，无索引页。
3. **创建表单是否加截止日期 / 时区**（`POST /api/tasks` 已收这些键）。缺省：不加（`[fe-09]`），避免 M2 的创建用例与「创建人即负责人」的提醒缺省算法一起进入本期验证面。
4. **清单能力标志**：是否请后端在 `TaskList` 形状上加 `canRename` / `canManageMembers` / `canManageGroups` / `canAddItem` / `canRemoveItem` / `canTransfer` / `canArchive` / `canLeave`（同任务详情的做法），让前端不再推断（§5.1）。缺省：本期客户端推断，有标志后只看标志。
5. **`R20` 取 (a) 还是 (b)**：(a) 回填 M2 / M3 全部文案并给五个既有 spec 加 `useLocale` mock；(b) 只覆盖 M4 新文案。缺省：(a)。**已裁 2026-10-07：(a)（R20）。**
6. **409 之后的草稿**：保留并提示（§7.3）还是丢弃草稿回到现值。缺省：保留。
7. **无行任务的排序入口**：「未排序」尾段 + 单次 `PUT`（`[fe-05]`），还是由前端串发多次 `PUT` 把尾段整体物化；或请后端提供「追加到某任务之后 / 批量物化」。缺省：尾段。
8. **红点 `off` 的呈现**：节点常驻、无数字、`data-scope="off"`（§8.1）；还是整个隐藏。缺省：常驻（锁 §5.2 的三态常驻节点）。
9. **实时在线时是否停轮询**。缺省：不停（`[fe-08]`）。（FE-c 注：PR-3c 的 socket 服务是进程内 adapter，部署多于一个后端进程时停轮询会让别的进程处理的写入到不了这个标签页，技术上不应停；本题仍待答。）
10. **每日提醒的旁注措辞**：前端不知道 PR-3b 三个开关的状态，只能写「取决于服务端配置」；是否接受，或要求后端在设置响应里带一个「投递可用」的只读标志（这会改 PR-3a / 3b 的合同）。缺省：接受措辞。
11. **门 21 / 22 的 M4 子集行**（随前端切片）：本件的新 spec 与两条新路由的 meta 格是否作为候选、不计分交付，入锁由 owner 点名。缺省：候选。（R01 已于 2026-10-07 裁定：门 21 / 22 的 M4 子集行属于 M4 的退出条件；这些格何时入锁计分仍待答。）
12. **Draft PR 的基**：以 `claude/tasks-m3-frontend`（#6159）为基时，CI 上**只有 `tasks-web-guard` 会跑**（它按 paths 触发）；`web-tests.yml` 没有 paths 过滤但 `pull_request` 只对基分支 `main` / `develop` 触发，`plugin-tests.yml`（跑 `.tokens` 清单单测的 `test (20.x)`）同样——所以登记 ①② 在 Draft 上没有 CI 执行，必须本地跑并写进验证 MD（§10.4；PR-3a 设计 §9.4 对后端 Draft 记了同一现象）。以 main 为基则 diff 带全部 M3 前端提交。另一件：仓库开着 `delete_branch_on_merge`、允许 squash，#6159 合并时 GitHub 会把 M4 PR 的基改到 main，而 M4 分支仍带 M3 的原始提交，须 `git rebase --onto main <M3 head>` 丢掉它们再重跑绿线、D = T = G 与 23 个 whole-file 参数（FE-8）。缺省：以 #6159 分支为基，PR 标明「叠在 #6159 之上」，PR body 列出未在 CI 触发的守卫与本地结果。**FE-8：本题的前提已不成立**——#6159 已于 2026-10-07 合入 main（`cc6ca96ac2`），本分支以它为基，Draft PR 以 main 为基，`web-tests` 与 `plugin-tests` 会触发，不需要改基；登记 ①② 仍在本地跑并记入验证 MD。
13. **真机联调的后端**：是否允许在本地起 PR-3a 分支 + 一次性库做 §10.5（不触达任何共享环境）。缺省：允许。
14. **红点 `badgeScope` 键的出现规则**（PR-3a §12-Q12，`[own-11]`）：前端按 `[fe-14]` 容忍解析，owner 无论答「只在 off 时带键」还是「常规响应也带键」都不需要改前端；若 owner 另要求前端对闭集外的值报错（整个红点转「不可用」），需改 §3.2 与 §10.1 一格。缺省：容忍解析。（`[own-11]` 仍在 PR-3a §12-Q12 待裁。）
15. **409 之后保留草稿的粒度**（`[fe-19]`，§12-Q6 的细化；2026-10-07 已 ratify 缺省，见 §11 `[fe-19]`）：只保留用户改过的字段、其余字段取重拉值、下一次保存用重拉后的 `version`；还是整份保留草稿（下一次保存会把重拉带回的他人改动用旧值写回）；或丢弃草稿回到现值。缺省：只保留改过的字段。
16. **编辑区打开时的只读行**（`[fe-20]`）：开始日期、描述、提醒三条只读行在编辑区打开时是否仍显示。缺省：显示。
17. **清单项读失败时的清单页**（`[fe-21]`）：页面照常、只把清单项区换成「暂时无法读取」并隐藏加入表单；还是整页转失败态。缺省：页面照常。
18. **左栏读 404 的呈现**（`[fe-22]`）：单独的「清单功能暂不可用」；还是与读失败同一文案。缺省：单独呈现。
19. **清单总线的范围**（`[fe-23]`）：改名与新建也通知、晚到的 `ok` 也通知；还是只在归档 / 取消归档时通知（§4.2 字面）。FE-6 起另含成员对话框的转让与退出（`[fe-32]`：退出的通知是 §5.2 本来就写的，转让是 FE-6 加的）。缺省：都通知。
20. **清单页写失败后是否重读清单**（`[fe-24]`）：只出横幅、不重读；还是像成员对话框（§5.3）那样重读清单行，让已被移出的人直接看到 not_found。缺省：只出横幅。
21. **动态面板**（`[fe-25]`）：每次展开重读、只显示操作者 / 事件词 / 时间；还是保留上次的结果，或按 `payload` 显示目标用户 / 任务。缺省：每次重读、不显示 `payload`。
22. **当前用户 id 解析中的归档按钮**（`[fe-26]`）：创建人那一半在解析完成前隐藏；还是先显示。缺省：隐藏。
23. **转让所有权是否先确认**（`[fe-27]`）：行内两步确认（提示里写明转让后本人成为可编辑成员）；还是 §5.2 的单个按钮，一点即转。缺省：先确认。
24. **成员对话框里本人那一行，与 id 未知时的行内控件**（`[fe-28]`）：本人行不出现改角色与移除，id 解析出来之前所有行都不出现这两个控件；还是按 §5.1 字面——改角色不看本人与 id（本人可以把自己降为 `read`，之后页面上的 `myRole` 在下一次重读清单前仍是旧值），移除只排除已知的本人行（id 未知时本人行也会出现「移除」，点了等于从行内退出，对话框停在一张自己已不是成员的清单上）。缺省：隐藏。
25. **添加成员的缺省角色**（`[fe-29]`）：`read` 还是 `edit`。缺省：`read`。
26. **写进行中能否关闭成员对话框**（`[fe-30]`）：写进行中关闭按钮禁用、Esc 不关，直到结果落地；还是允许关闭（关闭之后晚到的转让不再让页面重读清单、晚到的退出不再回到 `/tasks`，只通知清单总线）。缺省：不允许关闭。
27. **分组板的行与完成 / 重启**（`[fe-33]`）：行内容走宿主插槽、完成 / 重启仍是 `TasksView` 自己的处理函数；还是按 §4.6 字面由板 emit 回传。缺省：插槽。
28. **分组板的错误落点**（`[fe-34]`）：板自己的横幅；还是清单页借页面横幅、个人 scope 借 `TasksView` 的动作横幅。缺省：板自己的横幅。
29. **何时停用重排**（`[fe-35]`）：下标空间与服务端不一致（截断、摆放指向未显示的任务或未知分组）一律停用；还是只按 §6.4 的截断停用（「分配给我」超过 100 条且有摆放落在第一页之外时，本地算出的 `position` 会错）。另问：是否让「分配给我」视角读全部页（会改 `listTasks` 的请求串，`[fe-10]`）。缺省：一律停用，不改请求串。
30. **拖拽的放置规则**（`[fe-36]`）：下半部 = 之后、空白处与尾段 = 末尾、句柄是非按钮元素；还是只认「放在某行之前」、句柄用按钮。缺省：如前者。
31. **默认组的名字**（`[fe-41]`）：照显示服务端的中文常量；还是前端对未改名的默认组显示本地文案（需要后端标出「未改名」，否则前端分不出用户是否把它改回了同名）；或请后端按语言给名字。后两者都碰 PR-3a 的契约。缺省：照显示。
32. **分组板的 404 与刷新是否重读清单**（`[fe-44]`）：重读（同成员对话框）；还是只重读板自己的三读（同清单页自己的写，`[fe-24]`）。Q20 若裁为「页面写也重读清单」，两者合一。缺省：重读。
33. **`canManageMembers` 缺键时的成员控件**（`[fe-46]`）：四个成员控件在旧响应（没有这个键）里退回 `canEdit`；还是一律隐藏（M3 后端上的创建人与负责人看不到增删控件）；或一律显示、交给服务端 404。PR-3a 的对接说明写的是「控件照旧显示，由服务端的 404 把关」，`canEdit` 回退就是「照旧」。缺省：退回 `canEdit`。
34. **「所属清单」区的加入下拉是否跟成员管理能力走**（`[fe-47]`）：只经清单编辑的人看不到加入下拉（加入只认直接角色，他点了只会 404）；还是照 FE-4 只看 `canEdit`，由 404 的文案解释。缺省：跟成员管理能力走。
35. **写之后的焦点**（`[fe-48]`）：写进行中控件被禁用，真实浏览器把焦点移到页面 `body`（jsdom 不会，所以 FE-0 … FE-7 的格看不到）。成员对话框已改为写落地后把焦点收回对话框（模态对话框里这会让 Esc 与 Tab 回绕失效，是 §5.2 的契约问题）。清单页、分组板的建 / 改 / 删组、左栏新建、设置页与详情页（含 main 上 M3 的区块）在写之后焦点同样留在 `body`，键盘用户要从页首重新找回位置。是否要求这些页面也在写落地后把焦点还给发起写的控件？缺省：本期只修对话框，页面级的记为已知问题，另起一片统一处理（M3 的区块在 main 上，一起改）。（闸审之后：不经过写的就地切换——两步确认与改名表单的打开 / 取消、放弃草稿——已按 `[fe-49]` / `[fe-50]` 修；本题仍只问写之后的页面级焦点，以及改名表单是否要 Esc 取消。）

---

## 13. 实现切片（顺序执行；每片一个代理；每片结束 `vue-tsc -b` + 全部 `tasks*.spec.ts` + `App.spec.ts` 绿 + D = T = G）

| 片 | 对应 | 文件 | 依赖 | 测试 / 登记 |
|---|---|---|---|---|
| **FE-0 文案基座** | FE-c 的 R20 | 新 `src/tasks/labels.ts`；改 `TasksView.vue`、`TasksTodoBadge.vue`（只换文案来源，逐字不变）、`tasksDateDisplay.ts`（locale / labels 参数，缺省 ZH，§9.1）；§9.4 文件表的五个既有 spec 加 `useLocale` mock | 无（起手先以分支当时的 head 为基、重跑 14 个守卫，见抬头「基线复核」） | 新 `tasks-labels.spec.ts`（本片只扫 `TasksView` / `TasksTodoBadge`，夹具带日期；后续片各自把新视图加进扫描）；登记 token ①②③ |
| **FE-1 API 客户端** | 全部 | `tasksApi.ts` 追加 §3.2 全部函数与解析器、`collectPages`、导出 `resolveViewerTimeZone`、`getTask` / `listTasks` / `fetchPendingCount`（容忍解析）/ `createTask`（allowlist）的扩展；新 `src/tasks/tasksDraft.ts`（含 `initDraft` / `createEditorState` 的规范形） | FE-0 | 新 `tasks-api-m4.spec.ts`；`tasks-api.spec.ts` **不改**（新键全部可选，M2 形状夹具的解析结果不带它们，既有 `toEqual` 格（`:125`、`:136`）照常成立——M3 §4.1 当时改过两条 ok 断言是因为树字段恒在，M4 没有恒在的新键；新键的正反例只放 `tasks-api-m4.spec.ts`），其 `:239` 的 `VALIDATION_FAILED` 格原样保留；登记 |
| **FE-2 红点** | FE-c | `useTasksBadge.ts`（`scope`、订阅）、`TasksTodoBadge.vue`（`data-scope`、`off`）、新 `useTasksCountsRealtime.ts` + `tasksRealtimePolicy.ts` | FE-1 | 新 `tasks-badge-m4.spec.ts`（含真实 `App` 挂载的门正控 / 负控，§8.2）；`tasks-badge.spec.ts` 不改（它 mock 的 `fetchPendingCount` 形状仍合法）；登记。PR-3c 落地后按 §8.3 重核，必要时只改事件名常量（FE-c 已重核：事件名不变，改的是信号的合并，见 FE-c 行） |
| **FE-3 设置页** | FE-b | 新 `TasksSettingsView.vue`、`appRoutes.ts` 加 `/tasks/settings`、`TasksView.vue` 页头加链接 | FE-1 | 新 `tasks-settings-view.spec.ts`；`tasks-routes.spec.ts` 加设置路由格；`tasks-labels.spec.ts` 加该视图扫描；登记 |
| **FE-4 详情编辑** | FE-b | 新 `TaskDetailEditor.vue`、`TaskDetailLists.vue`（都无状态）；`TasksView.vue` 加 `editorState` / `myListsResult`、`watch(detailResult)`、`onPatchTask` / `onAddTaskToList` / `onRemoveTaskFromList`、两个挂载点、只读新字段行，`watch(taskId)` 复位块追加两行 | FE-1 | 新 `tasks-detail-m4.spec.ts`；§9.4 文件表的**五个**既有 spec 的 `tasksApi` mock 工厂补 `listTaskLists`（空）；labels 扫描加新区；登记 |
| **FE-5 清单** | FE-a | 新 `TaskListsSidebar.vue`、`TaskListView.vue`、`src/tasks/tasksListsBus.ts`；`appRoutes.ts` 加 `/task-lists/:id`；`TasksView.vue` 列表分支挂左栏 | FE-1 | 新 `tasks-lists-sidebar.spec.ts`、`tasks-list-detail.spec.ts`；`tasks-routes.spec.ts` 加清单路由格；labels 扫描加新视图；五个既有 spec 的 mock 工厂补 `listTaskLists`（若 FE-4 未补；`tasks-detail-m3.spec.ts` 三处回列表页的用例在此片起会挂左栏）；登记。后端 S5–S7 未建：全 mock |
| **FE-6 成员** | FE-a | 新 `TaskListMembersDialog.vue`；`TaskListView.vue` 挂对话框 | FE-5 | 新 `tasks-list-members.spec.ts`；登记 |
| **FE-7 分组** | FE-a | 新 `TaskGroupBoard.vue`（根容器 `data-testid="tasks-list"`）、`TaskPersonalGroups.vue`（按 §2.4 状态表挂在 `listResult.kind === 'ok'` 分支内，替换 assigned 视角的既有 `<ul>`）；`TaskListView.vue` 挂板 | FE-5 | 新 `tasks-groups.spec.ts`；§9.4 文件表的**五个**既有 spec 的 mock 工厂补 `listUserGroups`（合成默认组）/ `listUserGroupItems`（空）空转条目，既有断言不改并以此作板根容器与 DOM 同序的回归锚点；登记。后端 S8 未建：全 mock |
| **FE-8 收口** | FE-c | 验证 MD（`docs/development/task-m4-frontend-verification-<date>.md`）、`tasks-web-guard.yml` 头注的 M4 段（裸文件名，§10.3 ③ 的约束）、PR body | FE-0…FE-7 | 全量变异轮（§10.2）；§10.5 真机项逐条记跑过 / NOT RUN；本地跑完整 `run-required-web-tests.sh`、manifest 检查模式、manifest 单测守卫并记录（§10.4，CI 在非 main 基上不跑它们）；字面扫描器 v1 对全部新改文件退出 0；PR body 写明：Draft、以 main 为基（FE-8 更正：#6159 已合入 main，见 §12-Q12）、依赖 PR-3a 并须在它之后合并、PR-3c 未落地的部分只按约定、门 21 / 22 的 M4 行为候选未计分、未在 CI 触发的守卫与本地结果、不触达 staging / 生产。**#6159 合并后**：GitHub 会把本 PR 改基到 main，须 `rebase --onto main` 丢掉 M3 原始提交，再重跑绿线、D = T = G 与 23 个 whole-file 参数，验证 MD 记录改基（FE-8：#6159 在本分支开工前已合入，本分支本来就以 main 为基，这一步不适用） |
| **FE-c 重核** | FE-c | `useTasksBadge.ts`（信号窗口，`[fe-51]`–`[fe-53]`）；`useTasksCountsRealtime.ts` 与 `TasksSettingsView.vue` 只改注释（`[fe-54]`）；`tasks-badge-m4.spec.ts` 改写 13 格 | FE-2、FE-3、PR-3c（Draft 分支已建） | 新 `tasks-counts-realtime.spec.ts`；登记三处（`.tokens` 560 个，yml 24 个 whole-file 参数）；变异轮；验证 MD 的 FE-c 节 |

- FE-3 与 FE-4 互不依赖，可并行；FE-5 之后 FE-6 / FE-7 互不依赖，可并行（都改 `TaskListView.vue`，并行时各自只加一个挂载点，合并冲突可解）。
- 任何一片若发现契约与 `aafa05f2d5` 不同（例如 PR-3a 后续切片改了形状），先改本文件再改实现，验证 MD 记录偏差。

---

## 14. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | **后端 S5–S8 未建**，清单 / 成员 / 分组全按契约编码；契约落地时形状若变（`Group.id` 的 `null`、`members` 响应、可见集下标）前端要返工 | 解析器集中在 `tasksApi.ts`，形状差异只改解析器与 spec fixture；FE-5…FE-7 排在最后；验证 MD 标 NOT RUN |
| R2 | **PR-3c 未设计**，事件名 / 房间 / 载荷可能变 | 事件名单点常量；载荷不读；§8.3 清单；轮询回退保证功能不依赖 socket。FE-c：PR-3c 已在 Draft 分支建成，§8.3 逐条一致；剩下的是合并顺序——PR-3c 与本分支任一单独合入时门 26 那一行都不能变绿（PR-3c 设计 §11 末的备注） |
| R3 | **R20(a) 回填触碰既有 14 个守卫**（五个 spec 需加 mock；文案逐字不变仍可能漏一处） | FE-0 单独成片、先于一切；mock 只加不改；变异「硬编码一处中文」证红 |
| R4 | **可见集下标的理解偏差**（无行任务、残留行、截断）导致 `INVALID_POSITION` 频繁 | 尾段方案把规则显性化；`INVALID_POSITION` 自动重读；截断禁用重排；真机联调列为必做 |
| R5 | **客户端角色推断与服务端不一致**（§5.1）出现「按钮亮着、点了 404」 | 推断只管显隐、404 / 422 照常渲染；§12-Q4 请后端加标志 |
| R6 | **`TasksView.vue` 继续增长**（约 +170 行：三个 handler、`editorState` / `myListsResult`、一个 `watch`、挂载点）与 `watch(taskId)` 复位清单再长两行 | 详情页新增状态按 §4.3 必须在父组件（子组件随 `loadDetail` 重建）；列表页与清单页的状态仍在各自子组件 / 路由组件内；既有函数体零改动；§12-Q1 的清理片 |
| R7 | **原生拖放的可访问性与触屏** | 键盘替代是一等公民（§6.3）；触屏不在本期验收 |
| R8 | **token 子串碰撞**（`tasks-list-view` 已存在） | 新名字避开子串；两条碰撞命令输出进 PR body |
| R9 | **`/tasks/settings` 与 `/tasks/:id` 的匹配** | 静态段写在前；resolve 格钉住 |
| R10 | **409 的并发语义只在真库可证**（两个标签页） | 前端 spec 证状态机；真机项记录 |
| R11 | **红点 `off` 的 M3 过渡期**：M3 前端对 `off` 显示 0（PR-3a §7.3 已接受）直到 FE-2 落地 | FE-2 排在前三片 |
| R12 | **裁决包原文泄露**（本文与代码注释） | 只引 id；每片跑字面扫描器 v1 |
| R13 | **非 main 基上登记守卫不跑 + #6159 合并后的改基**（FE-8：已不成立，本分支以 main 为基）：`.tokens` 清单与 lane 脚本的漂移在 Draft 上没有 CI 红；合并后 M4 分支带着 M3 原始提交被改基到 main | §10.4 的本地运行写进验证 MD；FE-8 的 `rebase --onto` 步骤；§12-Q12 |

---

## 设计自查

1. 每条新路由、入口、请求是否都在 #6173 的门内？——路由 meta 带 `requiredFeature: 'tasks'` + `permissions: ['tasks:read']`（§2.1）；入口只在 `TasksView` 的 `ready` 态内（§2.2）；socket 只随红点挂载（§8.2）；无新 payload 键、无新 flag。
2. 每个新写函数是否都先过 `isPathSafeSegment`？——§3.1 规则；§10.1 对每个 id 位有三格；变异「去掉调用」证红。
3. 错误码是否逐一映射到具体文案？——§5.3、§9.2 一码一文案；`LIMIT` 按落点分三条。
4. 晚到结果与一次一个是否沿用 M3？——§4.0 的 generation / token；详情页三个新 handler 都复用 `detailActionToken`，子组件不自发写、只收 `pending` prop；清单页用 `v-model:pending` 共享一个布尔。
5. 是否有 `window.confirm`？——无；移出 / 退出 / 删组都是两步内联确认。
6. 无障碍？——对话框 `role` / `aria-modal` / 焦点归还 / Tab 回绕；拖拽有上移 / 下移 / 移到分组的键盘替代与 `aria-live`；`fieldset` / `legend`、每个输入有 label。
7. M2 / M3 行为是否不变？——既有 spec 只加 mock（§9.4 的五文件表、§13）；「分配给我」视角的 `tasks-list` 容器与五态归属不变、无摆放行时列表 DOM 顺序逐项相同（§2.4 状态表）；详情页首次进入仍先 `tasks-detail-loading`，草稿不因 M3 重拉丢失（§4.3）；`listTasks` 请求串不变（`[fe-10]`）；`fetchPendingCount` 常规响应解析不变；`createTask` 未枚举的 422 仍是 `error`（§3.1）；`tasksDateDisplay.ts` 的缺省输出逐字不变（§9.1）。
8. 分页用法？——新端点 `limit` 100 + `offset`；读全部页上限 20 页、截断可见；降级体无 `total` 先判。
9. `badgeScope: 'off'` 与实时 + 轮询回退？——§8；FE-c 的重核结果在 §8.3。
10. R20 的 CJK / EN spec？——§9.3 五组。
11. 登记三处与注释计数？——§10.3：sh 块、`--write` 生成 `.tokens`、yml 逐文件 + 「Twenty-three whole-file args」（FE-c 起 Twenty-four）。
12. 未裁取值是否都标了 `ASSUMPTION(task-m4-fe)`？——§11 全表；owner 问题 §12 每条有缺省。
13. 是否引用了裁决包原文？——只引 id；提交前跑字面扫描器 v1。
14. 对标语料？——手头的飞书手册文本是审批手册，本文未据它写任何任务交互细节，飞书任务 UX 全部标转述 / UNVERIFIED。
15. 评审发现是否逐条处置？——§15；三位评审全部返回，无缺席。

---

## 15. 评审发现处置（2026-10-07，三位评审 contract / ux-state / tests-ci-gate 全部返回，0 缺席）

每条都先对源码 / 契约 / spec 行号复核过再处置；同一缺陷被多位评审报出的合并列出。只写发现 id、处置与落点，不引裁决包原文。

| 发现 | 处置 | 落点 |
|---|---|---|
| contract F1 / ux-state F1 / tests-ci-gate F5（「分配给我」视角丢 `tasks-list` 容器、五态归属未写、`loadList` 并行与 prop 矛盾） | **已修**。核实：`TasksView.vue:375` 的 `<ul data-testid="tasks-list">`、`tasks-list-view.spec.ts:134/:165/:383/:406`、`tasks-detail-view.spec.ts:628`、`tasks-view.spec.ts:85-110` 的 TESTIDS 精确集合都钉它。取法 (a)：板根容器保留 `tasks-list`，板只在 `listResult.kind === 'ok'` 时挂载，读 pending / 失败回退平铺，`empty` / `error` 仍由父组件渲染；去掉「与 `loadList` 并行」 | §2.3 表、§2.4 状态表、§4.6、§6.1、§10.1 `tasks-groups` 行与末行、§11 `[fe-16]` |
| contract F2（`TaskDetailLists` 的一次一个不成立） | **已修**。核实 M3 设计 §3.8 与 `TasksView.vue:826-851`。清单项写改走父组件 `onAddTaskToList` / `onRemoveTaskFromList`，共用 `detailActionToken`；子组件无本地 `pending`；两格各一方向 + 变异 | §2.3 表、§4.0、§4.3、§10.1 `tasks-detail-m4` 行 |
| contract F3 / ux-state F4 / tests-ci-gate F1（`HH:MM:SS` 对 `HH:MM`、`null` 描述对 `''`，差分永不为 `null`） | **已修**。核实 `task-records.ts@aafa05f2d5:227-231`（`clockTime` 保留 `HH:MM:SS`）、`:297`、`:347`、`:367`，`task-edit.ts:137-145`（`canonicalTime`），`tasksApi.ts:64-65`，`tasksDateDisplay.ts:46`，PR-3a 验证 S4.2。新增 `initDraft` 规范形，比较与发送都用它；`checkTaskDates` 只收规范形；服务端形夹具的格与变异 | §3.3（`initDraft`、`checkTaskDescription`、`checkTaskDates`、`buildTaskPatch`）、§7.2、§10.1 `tasks-api-m4` / `tasks-detail-m4` 行、§11 `[fe-17]` |
| contract F4 / ux-state F9(1) / tests-ci-gate F7（`[D5]` 的 `loaded` 对 `ready` 偏离未记） | **已修**。核实 `useTasksBadge.ts:42` 与 `tasks-badge.spec.ts:89-150`、`tasks-nav-feature-gate.spec.ts:197`。`[D5]` 行记为有意偏离，§8.1 同步 | §8.1、§11 `[D5]` |
| contract F5 / ux-state F8（`badgeScope` 非 `off` 判 `error`，依赖未裁的 `[own-11]`） | **已修**。核实 `routes/tasks.ts@aafa05f2d5:79-80`、PR-3a 设计 `:786`、§12-Q12、`tasksApi.ts:449`。改容忍解析（只 `off` 有语义；`off` + `count ≠ 0` 仍 `error`）；登记 `[own-11]`；新增 §12-Q14 | §3.2 `fetchPendingCount` 行、§8.1、§10.1、§11 `[own-11]` `[fe-14]`、§12-Q14 |
| contract F6(a) / ux-state F7（`createTask` 的 422 allowlist） | **已修**。核实 `tasks-api.spec.ts:239-241`。枚举码表 + 其他 422 仍 `error`，既有格作回归锚点，`tasks-api-m4` 加一格与变异 | §3.1、§3.2 `createTask` 行、§10.1、§13 FE-1 |
| contract F6(b)（`tasks-nav-relogin.spec.ts` 并未 mock `useLocale`） | **已修**。核实 `grep composables/useLocale tests/*.spec.ts`：命中 `App.spec`、`tasks-nav-badge`、`tasks-nav-feature-gate`、`tasks-badge`，不含 `tasks-nav-relogin`（`:238-240` 只断言路径）。§9.4 改写 | §9.4 |
| contract F7 / tests-ci-gate F8(a)（`[R15]` 的 20 页、`[R11]` 的 `null` id、守卫计数） | **已修**（三处）。核实 `tasksApi.ts:740`、裁决包 R15 / R11 行、`ls tests/tasks*.spec.ts` = 13、`tasks-web-guard.yml:99`「Fourteen whole-file args」= 13 + `App.spec.ts`。20 页改 `[fe-13]`，`null` id 只留 `[own-24]`；抬头 `:5` 写成「13 个 `tasks-*.spec.ts` + `App.spec.ts` = 14 个 whole-file 参数」并定义下文「14 个守卫」指这一组（§2.3、§14-R3 按此读） | §1 抬头、§3.1、§11 `[R11]` `[R15]` `[fe-13]` |
| contract F8(a)（五个嵌套集合读缺 `org_missing` 降级体） | **已修**。核实 PR-3a 设计 `:270`。五行补 `org_missing`，§4.2 加一行并注明实际不可达 | §3.2、§4.2 |
| contract F8(b)（无日期任务不能清时区） | **已修**。核实 `task-edit.ts@aafa05f2d5:150-152, :188-192`。无日期时允许清空、发 `timeZone: null`，加格；登记 `[own-29]` | §3.3 `checkTaskDates` / `buildTaskPatch`、§7.2、§10.1、§11 `[own-29]` |
| ux-state F2（`loadDetail` 置 `loading` 卸载编辑器，草稿必丢） | **已修**。核实 `TasksView.vue:27`、`:689-697`、`tasks-detail-view.spec.ts:163`。取法 (a)：草稿 / 冲突态与「我的清单」读由 `TasksView` 持有，子组件无状态，`watch(detailResult)` 按「有改动则保留」同步；首次进入的 loading 与 M3 路径不变；加「M3 重拉后草稿仍在」格与变异 | §2.3、§2.4、§4.3、§7.3、§10.1 `tasks-detail-m4` 行、§11 `[fe-15]`、§14 R6 |
| ux-state F3（个人 scope 首次 `PUT` 后只重读摆放，任务从板上消失） | **已修**。核实 PR-3a 设计 `:384`、`:392`、`:1033`。重排成功与 `INVALID_POSITION` / `INVALID_GROUP` 都重读两面；派生加「未知 `groupId` 归默认组」兜底；加格与变异 | §4.4、§10.1 `tasks-groups` 行 |
| ux-state F5 / tests-ci-gate F4（`tasks-detail-m3.spec.ts` 的显式工厂漏在补 mock 清单外） | **已修**。核实 `tasks-detail-m3.spec.ts:43-67`（显式对象工厂）与 `:1056/:1266/:1778` 的 `router.push('/tasks')`。§9.4 改为五文件表，FE-4 / FE-5 / FE-7 与 §10.1 末行同步 | §9.4、§10.1 末行、§13 FE-4 / FE-5 / FE-7 |
| ux-state F6 / tests-ci-gate F6（`tasksDateDisplay.ts` 在 EN 下渲染 CJK；CJK 类过窄） | **已修**。核实 `tasksDateDisplay.ts:18/:47/:49`、`tasks-detail-view.spec.ts:322/:330/:354`、`templateDetailI18n.spec.ts:401`。纳入 FE-0 回填（locale / labels 参数，缺省 ZH，既有断言不变）；§9.3 改用加宽 CJK 类并要求夹具带日期 | §9.1、§9.3、§13 FE-0 |
| ux-state F9(2)（「本人退出」记在 `[R12]` 名下，实为 PR-3a `[own-14]`） | **已修**。核实 PR-3a 设计 `:324`、`:1174` 与裁决包 R12 行。§5.1 行标 `[own-14]`，§11 新增行、`[R12]` 去掉 | §5.1、§11 `[R12]` `[own-14]` |
| ux-state F10（edit 成员可经行内「移除」移除自己） | **已修**。`canRemove(row)` 加 `row.userId !== currentUserId`，加格与变异 | §5.1、§10.1 `tasks-list-members` 行 |
| ux-state F11（`<h2>` 无 `tabindex` 时 `focus()` 空操作） | **已修**。`tabindex="-1"`，a11y 格断言 `document.activeElement` | §5.2、§10.1 |
| tests-ci-gate F2（socket 门的格靠 MODE 守卫空转） | **已修**。核实 `useTodoCountsRealtime.ts:143-145`、`approvalCountsRealtime.spec.ts:13`、`tasks-nav-badge.spec.ts:210-222`。自动连接判据抽成 `tasksRealtimePolicy.ts` 供 `vi.mock`，真实 `App` 挂载的正控 / 负控与两条变异 | §2.3 表、§8.2、§10.1 `tasks-badge-m4` 行、§11 `[fe-11]`、§13 FE-2 |
| tests-ci-gate F3（Q12 误称 `web-tests` 在非 main 基上会跑；缺 #6159 合并后的改基步骤） | **已修**。核实 `web-tests.yml`（`pull_request: branches: [main, develop]`，无 `paths`）、`plugin-tests.yml:17-18`、`tasks-web-guard.yml:37-46`、`gh api repos/zensgit/metasheet2` → `delete_branch_on_merge: true`、`gh pr view 6159` → Draft、基 main（续审时远端 head 已是 `9d2682ab98`，见抬头「基线复核」；本件行号仍按 `1326938494`）。Q12 改写；§10.4 列必跑的本地命令；FE-8 加改基步骤；§14 R13 | §10.4、§12-Q12、§13 FE-8、§14 R13 |
| tests-ci-gate F8(b)（yml 头注若含 `vitest run` / `tests/tasks…spec.ts` 会让 G() 重复计数） | **已修**。核实锁 `:640` 的 G() 与 `tasks-web-guard.yml:4-5` 的现状。§10.3 ③ 加约束 | §10.3 ③、§13 FE-8 |

无被驳回的发现；无需要 owner 新裁的发现（F5 / F8 的 `[own-11]` 依赖已在 PR-3a §12-Q12，本件以 §12-Q14 登记前端侧缺省）。

**切片计划复核**（改动后）：FE-0 多出 `tasksDateDisplay.ts` 与五文件的 `useLocale` mock，仍无依赖；FE-1 多出 `initDraft` / `createEditorState` 与两处既有函数的 allowlist / 容忍解析，仍只依赖 FE-0；FE-2 多出策略模块与真实 `App` 挂载格，仍只依赖 FE-1；FE-4 把三个 handler 与两份状态放进 `TasksView.vue`，仍只依赖 FE-1，与 FE-3 并行不变；FE-5 / FE-7 的补 mock 清单从四文件改五文件；FE-7 的板挂载点改在 `listResult.kind === 'ok'` 分支内，仍依赖 FE-5（`TaskListView` 也挂板）；FE-8 多出本地 lane 运行与改基步骤。顺序与并行关系不变，每片的绿线仍是「全部 `tasks*.spec.ts` + `App.spec.ts` + `vue-tsc -b` + D = T = G」。

**续审复核（2026-10-07，第二轮）**：对 §15 每一行再按源码 / 契约 / spec 行号逐条重核——`TasksView.vue:27/:375/:492/:689-697/:826-851/:1310`、`tasks-list-view.spec.ts:134/:150/:165/:383/:406`、`tasks-detail-view.spec.ts:163/:322/:330/:354/:628`、`tasks-view.spec.ts:85-110`、`tasks-detail-m3.spec.ts:43-67/:1056/:1266/:1778`（另四个 `TasksView` spec 的工厂同为显式对象、零 `importActual`）、`tasksApi.ts:64-65/:449/:740`、`tasksDateDisplay.ts:18/:46-49`、`useTasksBadge.ts:42`、`tasks-badge.spec.ts:89-150`、`tasks-nav-feature-gate.spec.ts:197/:205-210`（壳层请求序列不含任何 `/tasks` 页读，M4 的 socket 在测试里按策略模块不连，序列不变）、`tasks-api.spec.ts:239-241`（全文件只用 `toEqual`）、`useTodoCountsRealtime.ts:143-145`、`templateDetailI18n.spec.ts:401`、`approvalCountsRealtime.spec.ts:13`、lane `:1816-1828`、`tasks-web-guard.yml:4-5/:37-46/:99-116`（全文件 `vitest run` 只出现在 `:102`）、后端 `task-records.ts:227-231/:297/:347/:367`、`task-edit.ts:137-145/:150-152/:188-192`、`routes/tasks.ts:79-80`、PR-3a 设计 `:270/:324/:384/:392/:786/:1033/:1174` 与 §12-Q12、PR-3a 验证 `:474-477`、PR-3b 设计 §3 / §9.3 标题、锁 `:640`、`web-tests.yml` / `plugin-tests.yml` 的 `pull_request` 分支过滤、`gh api` 的 `delete_branch_on_merge: true`、裁决包 D5 / R11 / R12 / R15 行、M3 设计 §3.6 / §3.8 / §4.1——全部成立，处置不变：0 驳回、0 新 owner 裁决（`[own-11]` 的前端侧缺省已在 §12-Q14）。本轮另做的小修：抬头「基线复核」（远端 head 前进到 `9d2682ab98`，任务文件零差异，FE-0 起手以分支当时 head 为基）；§3.2 两处「合并前的 main」限定为 PR-3a；§4.0 的复位引用改为 `TasksView.vue:1310`（M3 设计没有「切换任务时复位」这一节）；§4.1 / §10.1 / §11 补左栏 `data-testid` 前缀规则 `[fe-18]`（与 `tasks-view.spec.ts` 精确集合不相交，左栏在 `empty` 态也常驻）；§10.1 标题与 §13 FE-1 把「既有文件加格」的计数与 `tasks-api.spec.ts` 不改的理由写准；§15 的 F7 / F8(a) 行改记为抬头计数已修。切片计划复核不变：基线前进不改任何切片内容，只给 FE-0 加一步。字面扫描器 v1 退出 0。
