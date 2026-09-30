# 任务功能 M3 前端设计（2026-09-28）

- 分支：`claude/tasks-m3-frontend`，基于 `main` 5ac5b3ed15。owner 已授权 M3（Claude 做前端）。
- 契约来源：`origin/grok/tasks-m3-backend:docs/development/task-m3-backend-design-20260928.md`（§3.1、§3.3–§3.7）。**后端尚未实现**——本片只按该契约编码，测试全部 mock `apiFetch` / `tasksApi.ts` 的调用。
- 上游：M2 前端已在 `main`（`apps/web/src/tasks/{tasksApi.ts,useTasksBadge.ts,TasksTodoBadge.vue,tasksBadgeBus.ts,tasksDateDisplay.ts,tasksContext.ts}`、`apps/web/src/views/tasks/TasksView.vue`），设计见 `task-m2-frontend-design-20260927.md`。本片是纯前端加法，不改 M2 已有行为/守卫。

## 1. 范围

| 做 | 不做 |
|---|---|
| `tasksApi.ts`：`getTask` 详情追加 `parentId`/`depth`/`children`（校验）；新增 `setParent`、`addAssignee`/`removeAssignee`、`setCompletionMode`、`addFollower`/`removeFollower`/`leaveTask`、`listComments`、`createComment`/`editComment`/`deleteComment`、`deleteTask`，均判别联合、从不抛错 | 附件、清单、投影读、通知调度、评论回复线程（契约本就不做） |
| `TasksView.vue` 详情页加法：子任务树、执行人/关注人增删、完成模式切换、评论区、带内联确认的删除 | mock 数据、`TASKS_ENABLED` 相关改动、路由/导航改动 |
| 两个新 spec 文件 + CI 两处登记（`run-required-web-tests.sh`、`tasks-web-guard.yml`） | 后端实现、DDL、flag 开关 |

## 2. 契约映射表

| 调用 | 路径/方法 | 成功 200 | 400 族 |
|---|---|---|---|
| `setParent(id, parentId)` | `PATCH /:id/parent` | `{id,parentId,depth}` | 404 not_found；422 `INVALID_PARENT`/`DEPTH_EXCEEDED` → validation；422 `ORG_MISSING` → org_missing |
| `addAssignee(id,userId)` | `POST /:id/assignees` | `{id,status,completionMode,assignees}` | 422 `INVALID_ASSIGNEES`/`LIMIT` |
| `removeAssignee(id,userId)` | `DELETE /:id/assignees/:userId` | 同上 | 404/403 |
| `setCompletionMode(id,mode)` | `PATCH /:id/completion-mode` | 同上 | 422 `INVALID_MODE` |
| `addFollower`/`removeFollower` | `POST`/`DELETE /:id/followers[/:userId]` | `{id,followers}` | 422 `INVALID_ASSIGNEES`/`LIMIT` |
| `leaveTask(id)` | `POST /:id/leave` | `{id,followers}` | 404（非 follower） |
| `listComments(id)` | `GET /:id/comments` | `{items:[Comment]}` | 404/403（无 org_missing，同 `getTask`） |
| `createComment`/`editComment` | `POST`/`PATCH /:id/comments[/:cid]` | `Comment` | 422 `COMMENT_BLANK`/`COMMENT_TOO_LONG` |
| `deleteComment` | `DELETE /:id/comments/:cid` | 墓碑形 `Comment` | 404 |
| `deleteTask(id)` | `DELETE /:id` | `{id,deleted:true}` | 409 `HAS_CHILDREN` → conflict |

所有写操作共享 `classifyWriteFailure`（`tasksApi.ts`）：403→forbidden，404→not_found，409 带可解析 code→conflict，422 `ORG_MISSING`→org_missing，422 其他 code→validation，其余→error。这是契约前言「写操作缺 org 仍是 422 ORG_MISSING」这一 M2 不变式向 M3 全体写端点的推广——各小节的表格只列自己的业务码，但 org-missing 触发是通用的，所以每个写函数都统一走这一分类器。

## 3. UI 状态与选择

### 3.1 子任务/父任务
- `getTask` 的解析（`parseTaskDetail`）把 `parentId`/`depth`/`children` 当成**一组**：三者都缺，就是今天 M2 后端的详情形状，按根任务、无可见子任务解析（`null`/`0`/`[]`）；只要出现其中一个，三个都必须在且类型正确，否则整个详情判为 error。这样 M3 前端先于 M3 后端合并时，现有详情页不会全部变成错误态。`tasks-api-m3.spec.ts` 逐条覆盖 malformed 分支，`tasks-api.spec.ts` 的 fixture 保持 M2 形状并断言默认值。
- 模板里的 `?? 0`/`?? []` 兜底仍保留：四个既有 M2 spec 文件直接 mock `getTask` 的返回值，不经过解析。
- 无父任务标题可显示（契约只给 `parentId`，不给父任务标题），父任务链接文本就是其 id。
- `INVALID_PARENT`/`DEPTH_EXCEEDED` 各自精确文案，测试用 `.toBe`（不是 `.toContain`）断言，防止两个码互换后仍然通过。

### 3.2 执行人 / 完成模式
- 成功响应只含 `{id,status,completionMode,assignees}`，不含 `canComplete`/`canReopen`——移除自己作为执行人可能改变**自己**这两个字段，所以每次成功都 `loadDetail(id)` 整个重新拉取，而不是本地合并响应。
- 完成模式下拉用 `:value`（非 `v-model`）绑定到 `detailResult.task.completionMode`，`@change` 时读取原生 `Event.target.value` 判断合法字面量再调用——避免下拉框在请求还没成功前就"自己看起来已经切换"。

### 3.3 关注人 / Leave
- **现行契约下 `GET /api/tasks/:id` 不带 followers**（M3 契约 §3.2 只加了 `parentId`/`depth`/`children`）。闸方已在 #6126 请后端在详情里加上 `followers` 与能力标志。前端先按**可选字段**支持：详情带 `followers` 时直接用它填 `followersState`；不带时 `followersState` 仍为 `null`（"未知"，区别于 `[]`"确实零关注人"），只有 add/remove/leave 的成功响应才把它填上。
- Leave 按钮的显示规则：详情带 `canLeave` 时**只看** `canLeave`；不带时回退为 `followersState !== null && currentUserId !== null && followersState.includes(currentUserId)`。在后端给出 `canLeave` 或 `followers` 之前，纯关注人（没有 `edit`，也就不会触发 add/remove）看不到 Leave，这一限制见 §6。未解析出当前用户 id 时不显示 Leave：`leave` 能力是 follower-only（§2），显示按钮只会把用户导向一个 404。这与评论区的"未知就对所有人开放"回退**刻意不同**。

### 3.4 评论
- 当前用户 id 通过 `useAuth().getCurrentUserId()` 解析，**每个组件实例只解析一次**（`currentUserFetchStarted` 幂等门），在首次进入详情页时触发（不是 `onMounted` 里无条件触发）——这样纯列表路由的挂载完全不触碰 `useAuth`，四个既有 M2 spec 文件里只有真正导航到 `/tasks/:id` 的那几个需要新增 `useAuth`/`listComments` mock（已逐一补上，见 §5）。
- 三态 `currentUserStatus`：`pending`（编辑/删除按钮全部隐藏，避免过早出现又消失的闪烁）、`known`（按 `authorId === currentUserId` 逐条判定）、`unavailable`（id 解析不出——按指示回退为对**所有**评论显示编辑/删除）。
- `checkCommentBody` 与服务端 `normalizeCommentBody` 量的是同一段文本：先 NFC，再从两端去掉 Unicode White_Space 与四个零宽字符，再 NFC，然后按 Unicode 码点计数（`Array.from`，不用 `.length`，代理对字符不会翻倍）。直接量原始输入会误拒服务端接受的正文（末尾换行、分解形式的重音字符）。它只是省一次往返的预检，422 `validation` 仍是准绳。

### 3.5 删除任务
- 内联两步确认（`tasks-detail-delete` → `tasks-detail-delete-confirm` 块），全程不出现 `window.confirm`。
- `HAS_CHILDREN`（409 conflict）渲染在确认区自己的 `tasks-detail-delete-error`，不复用通用 `tasks-action-error` 横幅——契约明确这是"先删子任务"这个可操作的具体原因，不是通用失败。
- 成功后 `notifyTasksChanged()` 在 `router.push('/tasks')` **之前**调用（复用共享的成功分支顺序），避免把徽标刷新绑在导航是否完成上。

### 3.6 晚到结果守卫：token 而非 `taskId.value !== id`
M2 的 `onDetailComplete`/`onDetailReopen` 用 `taskId.value !== id` 判断"响应是否还对得上当前页面"。M3 的新增动作全部改用 `token !== detailActionToken`（`token = ++detailActionToken` 在动作开始时捕获）。两者不等价：`taskId.value !== id` 只能发现"现在看的是别的任务"，发现不了"离开这个任务又回到同一个任务"——这种往返会让 `detailActionToken` 递增两次，而 `taskId.value` 又变回同一个值。`tasks-detail-m3.spec.ts` 专门有一条用例（"the token guard also catches 'left t1 for the list, then came back to t1'"）验证这个更严格的守卫。M2 现有代码未改动（不在本片范围内）。

### 3.7 路径段中的 id
成员、评论与任务 id 放进 URL 路径之前先检查：空串、`.`、`..` 不发请求，成员 id 直接返回 `validation`（`INVALID_ASSIGNEES`），任务与评论 id 返回 `not_found`。`encodeURIComponent` 不转义 `.`，而 URL 解析会折叠 `.`/`..` 路径段，请求会落到另一条路由上。

### 3.8 共享 pending 状态
所有 M3 动作与既有的 complete/reopen 复用同一个 `detailActionPending`/`detailActionToken`——不是每个 section 一个独立 token。理由：这些按钮本来就都挂在同一个 `:disabled="detailActionPending"` 上，同一时刻只可能有一个点击发起一个动作，分 section 各自开 token 只会扩大守卫面而不增加覆盖率（advisor 复核建议，已采纳）。

## 4. 测试与 CI 接线

- `apps/web/tests/tasks-api-m3.spec.ts`（124 用例）：每个新调用的路径/方法/请求体、每个契约码、网络失败 → error；路径段 id 检查；`getTask` 的 M2 形状默认值与 M3 字段的 malformed 分支；`checkCommentBody` 的码点边界（含 astral 字符）以及与服务端归一化一致的边界（首尾空白、零宽字符、分解形式）。
- `apps/web/tests/tasks-detail-m3.spec.ts`（89 用例）：五个新 section 的渲染、成功路径、错误映射（含精确文案）、delete confirm + 409、own-comment gating；详情带 `canLeave`/`followers` 时的 Leave 与关注人列表；setParent、addAssignee、deleteComment、deleteTask、addFollower 的晚到结果守卫（含"离开又回来"与「晚到结果不得解除另一任务上进行中的动作」）；六个动作的一次一个；切换任务时关注人、删除确认、评论列表的复位；编辑预检、通用横幅回退与 `useAuth` 抛错回退。
- 审阅后共做 60 个变异（两批 39 + 21），逐个改坏源码后都有用例变红（其中「分组缺字段」一条是等价变异，已删除冗余的那行检查）。详见 `task-m3-frontend-verification-20260929.md`。
- 两个 token 已登记进 `apps/web/scripts/run-required-web-tests.sh` 的 exec 块（保持大小写不敏感字母序：`tasks-api-m3.spec.ts` 在 `tasks-api.spec.ts` 之前，`tasks-detail-m3.spec.ts` 在 `tasks-detail-view.spec.ts` 之前）与 `.github/workflows/tasks-web-guard.yml` 的 exec 列表（十二个整文件参数）。

### 4.1 连带修复（必要，非范围蔓延）
新增 `tasksApi.ts` 导出后，四个既有 M2 spec 文件（`tasks-view.spec.ts`、`tasks-list-view.spec.ts`、`tasks-detail-view.spec.ts`、`tasks-view-transitions.spec.ts`）的 `vi.mock('../src/tasks/tasksApi', …)` 工厂缺少 `listComments`，`TasksView.vue` 新增的 `useAuth` 导入在两个用假 `vue-router` mock（`tasks-view.spec.ts`、`tasks-list-view.spec.ts`）的文件里也缺少 `useRouter`——不补上会让这些文件里任何导航到 `/tasks/:id` 的用例直接抛错。已给四个文件补齐 `listComments`/`getCurrentUserId` 的空转 mock（默认解析到空列表/`null`），两个给 `useRouter` 补了 `{push: vi.fn()}`。以上四个文件的既有断言**未改动**，只补了 mock 字段。`tasks-api.spec.ts` 的 `fullTaskBody()` 保持 M2 形状，两条 ok 断言改为比较「M2 形状 + 默认树字段」（`withTreeDefaults`），因为解析结果现在总带这三个字段。

## 5. Gate 15

本片新增的注释里不出现其他功能线的符号名（`approval`、`multitable` 等）；引用既有 M2 代码时只提 `tasksApi.ts`/`TasksView.vue` 自身的符号。

## 6. 已知未做 / 留白

- `useAuth().getCurrentUserId()` 的解析时机是"首次进入详情页时"，不是"每次刷新详情时"——viewer 中途切换账号（同一 tab 内极少见）不会重新解析；与 §3.4 的幂等门设计一致，未做额外失效逻辑。
- 在后端详情带上 `canLeave` 或 `followers` 之前，Leave 按钮在"viewer id 已知但 followers 列表始终未知（从未触发过任何 add/remove/leave）"的情况下隐藏，纯关注人因此无法从界面退出。前端已按可选字段接好，后端补上即生效。
