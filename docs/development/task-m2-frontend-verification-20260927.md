# 任务功能 M2 前端验证记录(2026-09-27)

- 分支:`claude/tasks-m2-frontend`,Draft PR #6092。本记录对应的代码 head 为 `92b02a477`,合并基点为 main `db5ab77e39`。
- 设计:`docs/development/task-m2-frontend-design-20260927.md`。
- 结论:本地单测与类型检查全部通过;四轮独立审阅提出的 P1、P2 全部关闭;本地端到端联调跑通管理员全流程。**真实 staging/生产环境未运行**,后端 #6062 也尚未合并。

## 1. 过程与模型

实现与审阅由不同代理承担。审阅统一先试 Fable 5.1;这一天 Fable 持续返回 429,实际每轮都由 Opus 5.5 完成。

| 步骤 | 执行者 | 结果 |
|---|---|---|
| 骨架:路由、导航入口、context 五态、门 22 spec、CI 接线 | Sonnet 实现,Opus 审 | 提交 `e29fae8af`、`b7baf703b` |
| 数据接线:列表、新建、完成、重开、红点 | Sonnet 实现 | — |
| 审阅第 1 轮 | Opus | CHANGES REQUESTED:0 P1 / 5 P2 |
| 修复 | Sonnet | 提交 `3a34a55e3` |
| 审阅第 2 轮 | Opus | APPROVE-with-hardening:3 P2(均为测试缺口) |
| 修复 | Sonnet | 提交 `c850b80c3` |
| 详情页 | Sonnet 实现 | — |
| 审阅第 3 轮 | Opus | APPROVE-with-hardening:2 P2;确认重写的 spec 没有丢覆盖 |
| 修复 | Sonnet | 提交 `6701d9963` |
| 列表页迟到结果 | Sonnet 实现,编排者复核 | 提交 `29b839f57` |
| 门 15 注释、列表读取迟到 | 编排者亲改 | 提交 `92b02a477` |
| 与 main 冲突(`App.vue`、`App.spec.ts`,来自 #5857) | 编排者解决 | 合并提交 `7b2276540` |

每一轮修复之后,编排者都用 bash 脚本亲自复跑全部 spec 与 `vue-tsc`,并至少抽查一个 mutant。

## 2. 各轮审阅的 findings 与关闭方式

| 轮 | 级别 | 问题 | 关闭方式 |
|---|---|---|---|
| 1 | P2 | 导航与红点的权限门没有测试 | 新增 `tasks-nav-badge.spec.ts`:无 `tasks:read`、焦点壳、公共路由三类 |
| 1 | P2 | 路由参数 watch 与列表代次守卫没有测试 | 新增 `tasks-view-transitions.spec.ts`,用真实内存路由 |
| 1 | P2 | 写操作 403 被当成 org_missing 的风险没有测试 | 补 403→forbidden、非 ORG_MISSING 的 422→error |
| 1 | P2 | 完成/重开失败时界面无提示(真实缺陷) | 新增 `tasks-action-error` 横幅 |
| 1 | P2 | 红点从 ready 转失败后可能保留旧数 | 补测试,并断言组合函数内部值 |
| 2 | P2 | 完成/重开的 org_missing 引导没有测试 | 两处各补一例 |
| 2 | P2 | 红点显示文本与 aria-label 没有测试 | 三态逐一断言,不可用与加载中不出现数字 |
| 2 | P2 | 红点代次守卫没有测试 | 在途轮询晚于刷新到达的用例 |
| 3 | P2 | 详情页「切走后丢弃结果」的检查没有测试 | 两处各补一例 |
| 3 | P2 | 详情页错误横幅的复位没有测试 | 三处复位各补一例 |
| 3 | P3 | 晚到结果会把横幅带到新页面 | 把 id 比较移到应用结果之前 |
| 对账 | 门 15 | 7 处注释点名了其他功能线的符号 | 改为行为描述,重扫零命中 |
| 自查 | — | 列表读取晚到的 org_missing 会盖在详情页上 | 路由切换时递增 `listGeneration`,补回归测试 |

## 3. Mutation 证据(节选)

每个 mutant 都按「备份 → 改 → 跑 → cp 还原 → cmp」执行,还原后工作树与改前逐字节相同。

| 被删或被改的守卫 | 结果 |
|---|---|
| `App.vue` 去掉 `v-if="canUseTasks"` | 红 1 |
| 红点失败时不清空计数 | 红 1 |
| 不可用态显示 `'0'` | 红 1 |
| 完成/重开失败时吞掉结果 | 红 7 |
| 去掉写操作 org_missing 的引导(4 处) | 红 6 |
| 去掉详情页「切走后丢弃结果」的检查 | 红 6 |
| 去掉列表页的 `listPageToken` 递增 | 红 13 |
| 去掉路由切换时的 `listGeneration` 递增 | 红 1 |

第 3 轮审阅另外对 47 个守卫逐一变异,确认重写后的 spec 全部仍然能抓到。

## 4. 测试结果(head `92b02a477`,Node 20.20.2)

| spec 文件 | 用例 |
|---|---|
| `tasks-api.spec.ts` | 65 |
| `tasks-badge.spec.ts` | 25 |
| `tasks-context.spec.ts` | 17 |
| `tasks-detail-view.spec.ts` | 44 |
| `tasks-list-view.spec.ts` | 31 |
| `tasks-nav-badge.spec.ts` | 6 |
| `tasks-routes.spec.ts` | 8 |
| `tasks-view-transitions.spec.ts` | 14 |
| `tasks-view.spec.ts` | 7 |
| `App.spec.ts` | 11 |
| `approvalNavTodoBadge.spec.ts` | 23 |
| `run-required-web-tests-shape.spec.ts` | 5 |
| **合计** | **256,全部通过** |

`vue-tsc --noEmit -p tsconfig.app.json` 退出码 0。`git status` 没有 lockfile 改动。

## 5. 本地端到端联调(仅本机)

- 做法:在一次性工作树里把后端 #6062(`edf5d75d56`)与本分支(当时 `7b2276540`)本地合并;一次性数据库迁移后,以 `TASKS_ENABLED=true` 起后端,起 vite 前端,用 Playwright 驱动真实浏览器。没有推送,没有碰 staging 或生产,结束后删库、删工作树。
- 管理员全流程跑通:导航入口与红点、新建、列表、完成、重开、切换视图。前端对所有接口形状的预期都与后端一致。没有与任务相关的控制台错误。
- 非管理员需要额外一行 namespace admission,见设计文档 §9;补上后流程正常。
- 当时的前端版本详情页仍是骨架,之后由 `6701d9963` 接上详情接口;详情页本身只经过单测验证,**未在真实浏览器里复测**。
- 未覆盖:`following` / `delegated` / `any_role` 三个视图;非零红点(P0-A 无法设置截止日,红点只能为 0)。
- 日志与截图留在编排者本机临时目录,未入库。

## 6. 未验证与残留

- **后端 #6062 未合并。** 前端依赖的接口仍可能变化;若变化,需同步 `tasksApi.ts` 与相应 spec。
- **真实 staging/生产环境:NOT RUN。**
- 详情页在真实浏览器中的表现:NOT RUN。
- 已知的实现取舍:完成/重开的 reopen 一律用 `scope: 'self'`;all 模式下由创建人整体重开的入口留到后续。
- 合并须等 #6062 先合并,并需 owner 另行授权。
