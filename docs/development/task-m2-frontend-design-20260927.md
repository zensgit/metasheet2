# 任务功能 M2 前端设计(2026-09-27)

- 分支:`claude/tasks-m2-frontend`,Draft PR #6092,基于 `main`。只推分支,不合并。
- 规格来源:任务功能线设计锁 `docs/development/task-feature-design-lock-20260917.md`(PR #5845)§3、§5.2、§5.2.1、§5.3,§12 门 11、15、21、22。
- 后端契约来源:PR #6062(`grok/tasks-m2-backend`)的 `packages/core-backend/src/routes/tasks.ts` 与 `src/services/task-records.ts`。后端未合并,全部路由都要 `TASKS_ENABLED=true` 才挂载。
- 分工来源:owner 2026-09-26「做」,前端由闸方实现;2026-09-27「按建议执行,你能帮我加速执行么」,把前端接到 #6062 的路由上。
- 验证记录:`docs/development/task-m2-frontend-verification-20260927.md`。

## 1. 范围

| 做 | 不做 |
|---|---|
| `/tasks` 列表页:五种视图切换、新建、每行完成/重开 | 子任务、评论、清单、提醒、附件(M3 及以后) |
| `/tasks/:id` 详情页 | 增删执行人、切换完成模式(owner 2026-09-27 裁为 M3) |
| 顶部导航入口与常驻待办红点 | 焦点壳(考勤、PLM 工作台)里的入口(锁 §13-37 缺省) |
| 缺组织时的引导提示 | 路由 `requiredFeature`,以及对 `guardPolicy.ts` / `router/types.ts` 的改动(锁 §13-38 缺省乙) |
| 路由权限门的 spec 与 CI 接线 | 任何 mock 数据或 `USE_MOCK` 分支 |

## 2. 模块

| 文件 | 职责 |
|---|---|
| `apps/web/src/tasks/tasksContext.ts` | 读 `GET /api/tasks/context`,把结果分成五态:ready、org_missing、unavailable、forbidden、error |
| `apps/web/src/tasks/tasksApi.ts` | 列表、详情、新建、完成、重开、待办计数六个调用。每个都返回判别联合,按 HTTP 状态**从不抛错** |
| `apps/web/src/tasks/useTasksBadge.ts` | 红点的轮询组合函数 |
| `apps/web/src/tasks/TasksTodoBadge.vue` | 红点组件 |
| `apps/web/src/tasks/tasksBadgeBus.ts` | 很小的发布订阅。列表或详情里的变更成功后通知红点立即刷新 |
| `apps/web/src/tasks/tasksDateDisplay.ts` | 把时刻按查看者本地时区格式化 |
| `apps/web/src/views/tasks/TasksView.vue` | `/tasks` 与 `/tasks/:id` 共用的视图 |
| `apps/web/src/router/appRoutes.ts` | 两条路由,meta 带 `permissions: ['tasks:read']` |
| `apps/web/src/App.vue` | 默认壳里的导航入口与红点,只在 `canUseTasks` 时渲染 |

## 3. 后端契约与结果映射

| 调用 | 后端返回 | 前端结果 |
|---|---|---|
| `GET /api/tasks/context` | 200 `{orgId}`,非空 | ready |
| | 200 `{orgId: null}` | org_missing,显示引导 |
| | 200 `{orgId: ''}` | error,空串不当作有 org |
| | 404 | unavailable,「任务功能未启用或当前服务不支持」,不断言开关的值 |
| | 403 | forbidden |
| `GET /api/tasks?view=` | 200 `{items}` | ok 或 empty,两者渲染不同 |
| | 200 `{degraded, reason:'org_missing'}` | org_missing,显示引导 |
| | 200 `{degraded, reason:'predicate_error'}` | 加载失败,**不**显示引导 |
| `GET /api/tasks/:id` | 200 完整形状 | ok;形状不合法的 200 当 error |
| | 404 | not_found,一句话,不暗示任务是否存在 |
| | 403 | forbidden |
| `POST /api/tasks` | 200 `{id}` | ok |
| `POST …/complete`、`…/reopen` | 200 | ok |
| 以上三个写操作 | 422 且 `code === 'ORG_MISSING'` | org_missing,显示引导 |
| | 其他 422 | error |
| | 403 | forbidden,「没有权限修改此任务」 |
| `GET /api/tasks/pending-count` | 200 `{count}` | 红点 ready |
| | 降级(任何 reason)、4xx、5xx、网络错误 | 红点 unavailable |

列表行是 snake_case 原始行,详情是 camelCase,所以用两个类型:`TaskListItem` 与 `TaskDetail`,不共用。

## 4. 缺组织引导

锁 §5.2 规定引导流恰好三个触发:

1. context 返回 `orgId === null`;
2. 读操作返回降级 `org_missing`;
3. 写操作返回 422 `ORG_MISSING`。

`predicate_error`、403、其他 4xx/5xx 都不触发引导,只显示各自的错误态。之后任一动作成功,就清掉由动作触发的引导。

## 5. 红点

- 常驻的 `<span data-testid="tasks-todo-badge" :data-state :data-count>`,三态:`loading`、`ready`、`unavailable`。
- `unavailable` 与 `loading` 的 `data-count` 为空串,显示文本与 aria-label 里都不出现数字。「读失败」绝不渲染成 0;这是锁 §5.2 的明文要求。
- 每 60 秒轮询,页面隐藏时跳过这次请求。遇到 404 停止轮询,因为功能关闭时继续轮询永远不会成功;之后任一次刷新成功就恢复轮询。403 与 org_missing 继续轮询。
- 401 不跳转登录页:轮询是后台行为,不该在用户没有操作时把人踢出去。401 按 unavailable 处理。
- 请求带 `x-viewer-time-zone` 头,取浏览器时区。
- 代次守卫:晚到的旧响应不覆盖新结果,组件卸载后到达的响应也不写入、不重启定时器。

## 6. 视图与竞态纪律

`/tasks` 与 `/tasks/:id` 由同一个组件实例承载;vue-router 在两者之间切换时复用实例,所以数据加载挂在路由参数的 watch 上。

| 竞态 | 处理 |
|---|---|
| 切换视图时旧的列表请求晚到 | `listGeneration` 代次,旧结果丢弃 |
| 打开详情时列表请求仍在途 | 路由切换时也递增 `listGeneration` |
| 在详情之间切换时旧详情晚到 | `detailGeneration` 代次 |
| 在详情页完成/重开,请求在途时切到别的任务 | 动作开始时记下任务 id;响应到达时 id 已变,就不应用任何横幅或引导。晚到的成功仍通知红点 |
| 在列表页新建/完成/重开,请求在途时离开列表 | `listPageToken`,规则同上;晚到的新建成功仍清空已输入的标题,避免重复提交 |
| 动作进行中重复点击 | 按钮在请求在途时禁用 |

完成按钮只在任务未完成且后端给出 `canComplete` 时显示,重开按钮只在已完成且 `canReopen` 时显示。后端的这两个标志只看角色、不看状态,所以前端必须再叠加状态判断。

## 7. 路由与导航

- 路由 meta 为 `{ title: 'Tasks', titleZh: '任务', requiresAuth: true, permissions: ['tasks:read'] }`。按 `routeAccess.ts` 的 every 语义,非 admin 且没有 `tasks:read` 的用户会被重定向回首页;admin 短路可达(`useAuth.ts:553`)。
- 导航入口只在默认壳里渲染,与审批入口同形;考勤、PLM 工作台两个焦点壳不渲染。
- 公共路由上不渲染红点,也不发计数请求。

## 8. CI 接线(锁 §5.3、门 11、21)

- 每个 `tasks-*.spec.ts` 都作为独立 token 登记在 `apps/web/scripts/run-required-web-tests.sh` 的 exec 块里,由 required 的 `web-tests` 执行。
- `.github/workflows/tasks-web-guard.yml` 逐文件列出这些 spec。这是 paths 型的独立 lane,不声明 `merge_group`。
- owner 2026-09-27 同意了门 21 的命令勘误:T 读整个续行块,G 接受 `(apps/web/)?tests/` 前缀。按勘误后的命令,D、T、G 三个集合相同。

## 9. 部署前提(联调发现)

非管理员除了 `tasks:read` / `tasks:write` 权限码,还需要 `user_namespace_admissions(user_id, 'tasks', enabled=true)`。这是锁 §13-10「不豁免」的直接后果。缺这一行时,context 返回 403,前端显示 forbidden 态,行为符合预期。已请实现方把这一步写进锁 §10 或 §5.1。
