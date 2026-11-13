# 任务功能 M5 前端设计（草案，2026-10-11）

> **状态：DRAFT，只有文档。** owner 2026-10-10 裁定先冻结 PR-4a 的表结构与接口，再并行起草 PR-4b、PR-4c 与前端；起草方式按 owner 2026-10-09 六项之第 6 项（受控堆叠起草、按依赖串行合并、基线变化后重建重验）。本文是前端那一份：FE-d（任务详情页）与 FE-e（清单页）的设计，以及 FE-f（多维表工作台拦截）的边界。实现只开 Draft PR；合并、DDL、staging、打开任何 `TASKS_*` 开关都要 owner 另行点名。本文不改后端，也不改锁。
>
> - **裁定的引用口径**照 PR-4a：只写条目编号与日期。M5 的 S01–S37 于 owner 2026-10-09 取推荐值；M4 的 R01–R23、N1、N2 于 2026-10-07 裁定；owner 2026-10-09 的六项按「第 n 项」引用。私有件不引原文。D 编号没有被任何裁定点名，出现处一律写「D<n>，`ASSUMPTION`」。
> - **标签**：已裁条目在代码里标 `RULED(<日期>): [Sxx]`；照搬 PR-4a 冻结值的地方标 PR-4a 的编号 `[a-NN]`（它们在 PR-4a 里仍是 `ASSUMPTION(task-m5a)`，PR-4a 改了前端跟着改）；本件自选的取舍标 `ASSUMPTION(task-m5-fe): [fe5-NN]`，§10 全表，每条有缺省与备选；只有 owner 能答的在 §11。

## 基线与输入

- **前端基线**：`origin/main` `906840c74c`（2026-10-11）。M4 前端（#6265）已在 main。PR-4a 冻结稿 v4 的基线是 `a1c0972918`；`git diff --stat a1c0972918 906840c74c` 对 `apps/web/src/tasks`、`apps/web/src/views/tasks`、`apps/web/tests/tasks*`、`tasks-web-guard.yml`、`appRoutes.ts`、`utils/api.ts` 与锁为零，只有必跑脚本（+9 行）与 token 清单（+1 行）有与任务无关的增量。下文行号都指 `906840c74c`，实现开工时按当时 main 重核。
- **既有面**：`apps/web/src/tasks/` 13 个文件（`tasksApi.ts` 1781 行、`labels.ts` 755 行、`tasksDraft.ts` 384 行、`tasksFocus.ts` 35 行……）；`apps/web/src/views/tasks/` 9 个组件（`TasksView.vue` 1903 行、`TaskListView.vue` 981 行……）；23 个 `tests/tasks-*.spec.ts` 加 `tests/App.spec.ts`，即 `tasks-web-guard.yml` 的 24 个 whole-file 参数。
- **后端契约**：PR-4a 冻结稿 v4（Draft #6332，分支 `claude/tasks-m5-pr4a` @ `7f1c4c536f`，`docs/development/task-m5-pr4a-backend-design-20261010.md`）。初稿按它的上一个提交 `cdf7ddba87` 起草；`7f1c4c536f` 只加了 PR-4a §8.5 的一轮文字修订（不新增 `[a-NN]`、不新增 owner 问题），其中与前端相关的只有字段绑定的排序与调序下标的口径，已在 §3.2 与 §4.8 对齐。该分支今天只有这份设计，路由尚未实现，所以前端的格全部 mock 传输层（M3、M4 前端同样先于后端）。纯函数层是任务 E（#6249，Draft，head `39a2a29be9`）：前端的本地预检镜像其中的 `parseRecurrenceRule`、`parseFieldDefinition`、`validateFieldValue`，只读该提交。
- **PR-4b / PR-4c**：设计与本文并行起草，本文不读它们的草稿。凡依赖它们的地方写成 `[fe5-NN]` 依赖假设，依据只取 PR-4a 的文字：§1.2 的归属、§2.7 / §2.9 / §2.10 的表与类型、§3.0 的开关口径、§4.6 的边界、§7.2 的 S19 问题与任务 E 问题 2。§12 列出两者冻结后必须重核的点（M4 前端 §8.3 对 PR-3c 的同一做法）。
- **门禁**：沿用 M4 前端抬头（#6173 / R-28）：任务入口 = 会话 feature `tasks` 且有 `tasks:read`。M5 前端不新增路由、不新增会话 payload 键、不读任何 flag（§2.1）。
- **锁**：`task-feature-design-lock-20260917.md` §5.2、§5.3、门 21 / 22。§12 `arm-set` 今天没有 `M5|21` / `M5|22` 行（§9.6）。
- **约束（全文适用，同 M4 前端）**：M2–M4 行为不变（既有 spec 只加 mock、断言不改）；每个放进请求路径的 id 先过 `isPathSafeSegment`；错误码逐一映射到文案；晚到结果守卫与一次一个动作；不用 `window.confirm`；label、role、焦点与键盘替代；注释不点名其他功能线的符号；裁决原文不入库。

---

## 0. 结论摘要

1. **三个切片**：FE-d 详情页（创建人为所有负责人完成、里程碑、重复与系列、依赖、自定义字段取值、附件）；FE-e 清单页（字段定义与绑定、多维表视图入口与 CSV 导出）；FE-f 工作台拦截（本文只定边界）。实施细分为 FE-d0…FE-d4、FE-e1、FE-e2 与收口片 FE-z（§13）。
2. **不新增前端路由**（`[fe5-01]`）：FE-d 全在 `/tasks/:id`，FE-e 全在 `/task-lists/:id`；门 22 没有 M5 子集。
3. **进入详情不新增读**：M5 数据全部来自 PR-4a 增补后的详情体（PR-4a §3.8）。详情体的 M5 键按 PR-4a §1.3 的切片分四组严格解析，缺组 ⇒ 对应区不渲染，于是既有 spec 的夹具、DOM 与请求序列都不变（`[fe5-03]`）。唯一的例外是附件列表读，且只在 PR-4b 的能力键出现时才发（`[fe5-23]`）。
4. **状态与互斥沿用 M4 `[fe-15]`**：M5 新区的子组件无状态，只发意图；写由 `TasksView` 的一个执行器在既有的 `detailActionToken` / `detailActionPending` 上跑；草稿放在父组件的一个容器里，跨重拉保留（`[fe5-02]`、`[fe5-17]`）。
5. **版本**：M5 的写只有 G1 推进 `tasks.version`（PR-4a §4.3、`[a-10]`），其余都不动它；M4 编辑区的 `expectedVersion` 规则与 409 状态机原样适用，没有新的 409 形状（§5）。
6. **测试与登记**：新 spec 8 个、既有 spec 1 个加格；登记三处、门 21 的 D = T = G；候选行 `M5|21|新表面` 随 PR-4a §7.3 的那次锁修订一起点名（§9.6、§11-Q7）。
7. **待定**：本件自选 42 项（§10）；owner 问题 11 个（§11.1）；PR-4a 已登记的问题不重问，只写前端影响（§11.2）。

---

## 1. 范围

### 1.1 切片

| 切片 | 做 | 不做 | 依赖 |
|---|---|---|---|
| **FE-d 详情页** | G1 按钮；里程碑的开关与徽标（详情、两条列表读的行、清单页的行、依赖项）；重复规则的设置、修改与结束，系列导航，系列删除的确认句；依赖面板（前置 / 后置、候选搜索、加边、删边）；自定义字段取值（按清单分组显示、按类型编辑、清空）；附件（列表、上传、下载、移除、评论附件） | 富文本（S29）；甘特 / 看板呈现（多维表线）；待办与红点里的里程碑（PR-4a §7.4 Q1）；任务内历史（§1.3）；依赖阻断完成（S12：不阻断） | PR-4a；附件部分 PR-4b |
| **FE-e 清单页** | 字段对话框（绑定列表、调序、显隐、解绑、绑定可复用字段、新建并绑定、改定义、删除自己建的未绑定字段）；多维表视图与导出面板（开启投影、三个深链、CSV 导出） | 清单页任务行的自定义字段列（`[fe5-41]`）；关闭或删除投影（S04 不提供）；xlsx（S10） | PR-4a；面板 PR-4c；G2-core 先合（§1.4） |
| **FE-f 工作台拦截** | 只定边界（§12.3） | 详细设计，PR-4c 冻结后另起一份（`[fe5-40]`） | PR-4c |

### 1.2 依赖与起手时机

| 内容 | 后端 | 现在能做 | 真机联调 |
|---|---|---|---|
| FE-d0 客户端、解析器、预检纯函数、文案 | PR-4a（冻结、未实现） | 全部（mock） | PR-4a 路由在其分支建成后 |
| FE-d1 G1、里程碑、重复与系列、系列删除、列表徽标 | PR-4a | 全部（mock） | 同上 |
| FE-d2 依赖、FE-d3 字段取值 | PR-4a | 全部（mock） | 同上 |
| FE-d4 附件 | PR-4b（起草中） | 只按 §12.1 的依赖假设起草；PR-4b 冻结后先逐条重核再编码 | PR-4b 建成后 |
| FE-e1 字段对话框 | PR-4a | 全部（mock）；G2-core 合入后 rebase | PR-4a 建成后 |
| FE-e2 视图与导出面板 | PR-4c（起草中） | 同 FE-d4 的做法，按 §12.2 重核 | PR-4c 建成后 |
| FE-f | PR-4c | 不开工 | — |

合并顺序在 PR-4a §7.3 的 #6249 → PR-4a → {PR-4b, PR-4c} 之上：FE-d0…d3 与 FE-e1 在 PR-4a 之后；FE-d4 在 PR-4b 之后；FE-e2 在 PR-4c 之后；FE-e 整体在 G2-core 之后。每一张的合并都要 owner 单独点名（锁 §14-5）。前端拆成几张 Draft 按后端进度在实现时定；每片一个提交，照 M4。

### 1.3 不在 M5 前端范围（只记）

- **任务内历史与跨任务动态**：owner 2026-10-09 六项之第 5 项定前者在 M5 之后单独补齐、后者继续后置，并要求历史接口不得把事件 payload 原样交给前端（其中的 id 还要过可见性校验）。M5 前端不读任何事件的 payload；清单动态面板仍只显示操作者、事件词与时间（`[fe-25]`），`field_bound` / `field_unbound` 两个词已在 `labels.ts` 的清单事件表里（`TASKS_LIST_EVENT_KEYS`，`:732`），不新增。
- **待办与红点的里程碑**：PR-4a 不改 `/api/tasks/pending`（其 §3.8、§7.4 Q1）；前端也没有待办列表的调用方（M4 前端 §1.3）。
- **甘特、看板、网格的呈现**：多维表线的组件；前端只给深链（FE-e2），交互写回是 FE-f。
- **富文本**（S29）。
- **状态筛选 G2-core**（§1.4）。

### 1.4 与 G2-core 的交互

G2-core（`GET /api/tasks` 的未完成 / 已完成 / 全部切换；owner 2026-10-09 六项之第 3 项的后半：M4 之后单独交付、先于 FE-e）是一张单独的 PR，与本件并行实现，本件不含它。交叉点只有四处，都是文本层的：

1. **`tasksApi.ts`**：G2-core 改 `listTasks` 的请求串。FE-d0 不碰 `listTasks`，只给 `TaskListItem` 加可选键 `is_milestone`（`[fe5-07]`）；后合的一方 rebase 时冲突只会落在类型声明附近。
2. **`TasksView.vue` 列表分支**：G2-core 加状态切换控件；FE-d1 只在两份行模板（「分配给我」的行插槽与平铺 `<ul>`，`:442-462`、`:464` 起）里加同一个徽标节点。两份行模板必须逐元素相同（`tasks-groups.spec.ts` 的行等同格按 `outerHTML` 比），所以两处同改。徽标的 `data-testid` 取 `tasks-list-item-milestone`，实现当日先 grep 确认它与 G2-core 的控件名、`tasks-view.spec.ts` 的 TESTIDS 集合都不同名。
3. **`labels.ts`**：两边都加键，冲突按并集解，键对齐由 `TASKS_EN` 的类型与 `tasks-labels.spec.ts` 钉住。
4. **登记三处**：两边都可能新增 spec；token 块按 `LC_ALL=C` 字节序重排后重跑 D = T = G。计数一律写成「相对实现当日 head 的增量」（§9.4）。

M4 `[fe-10]` 起前端不使用列表的 `total`，FE-d 也不用，所以 G2-core 对列表与 `total` 的口径与本件没有语义交叉。FE-e 本身不读 `GET /api/tasks`；它排在 G2-core 之后是那一项的顺序要求。

---

## 2. 路由、入口与页面结构

### 2.1 不新增路由（`[fe5-01]`）

- FE-d 的区块都在 `/tasks/:id`；FE-e 的字段对话框与面板都在 `/task-lists/:id`。字段定义没有自己的页面：可复用字段列表与「删除我建的未绑定字段」放在字段对话框的选择器里。
- `appRoutes.ts`、`router/types.ts`、`guardPolicy.ts`、`featureFlags.ts`、`App.vue` 零改动；`tasks-routes.spec.ts` 不加格。
- **深链离开任务门**：`/multitable/:sheetId/:viewId` 是多维表线的既有路由（`router/multitableRoute.ts` 的 `buildMultitableRoute`，meta 只有 `title` 与 `requiresAuth`），不带 `requiredFeature: 'tasks'`。链接只在任务页（门内）渲染；点过去之后能不能读、能不能写，由多维表侧的投影夹钳与 deny（PR-4c）决定，前端不重复判定。

### 2.2 详情页的区块顺序（既有区块的顺序不变）

```
标题 / 状态 / 完成方式 / 截止 / 开始 / 描述 / 提醒          （既有）
负责人、加负责人、完成方式下拉                              （既有）
[完成] [重启]（既有）  [为所有负责人完成]（新，G1）
<section data-testid="tasks-detail-milestone">       里程碑：状态 + 切换（新）
TaskDetailEditor、TaskDetailLists                    （M4）
<section data-testid="tasks-detail-recurrence">      重复规则、系列导航（新）
<section data-testid="tasks-detail-dependencies">    前置 / 后置（新）
<section data-testid="tasks-detail-fields">          自定义字段（新）
子任务、关注人                                        （既有）
<section data-testid="tasks-detail-attachments">     附件（新，PR-4b）
评论（既有；撰写区加暂存附件，PR-4b）
删除（既有；确认句在系列任务上多一句）
```

每个新区都在既有的 `v-if="detailResult.kind === 'ok'"` 块内（`TasksView.vue:27`），只在它对应的详情键组出现时渲染（`[fe5-03]`）。

### 2.3 新组件与模块

| 新组件 / 模块 | 位置 | 归属 | 自己持有的状态 |
|---|---|---|---|
| `TaskDetailMilestone.vue` | `views/tasks/` | `TasksView` 详情分支 | 无：接收 `isMilestone`、`canEdit`、`pending`，`emit('set', boolean)` |
| `TaskDetailRecurrence.vue` | 同上 | 同上 | 无：规则、系列四键、`dueDate` 与 `status`、草稿与区内错误（都由父组件持有），`emit('update:draft' / 'save' / 'clear' / 'discard')` |
| `TaskDetailDependencies.vue` | 同上 | 同上 | 两个 `DepItem` 数组来自 props；候选搜索的本地态（方向、查询串、结果页、自己的 generation）在组件内（`[fe5-14]`）；`emit('add', …)` / `emit('remove', …)` / `emit('reload')`（候选读 `not_found` 时请父组件重拉，§4.5） |
| `TaskDetailFieldValues.vue` | 同上 | 同上 | 无：分组、清单名映射、正在编辑的字段与草稿、区内错误都来自父组件，`emit('edit' / 'update:draft' / 'save' / 'clear' / 'cancel')` |
| `TaskAttachments.vue`（FE-d4） | 同上 | 同上 | 附件列表读的结果来自父组件；本地只有下载进行中的集合与两步确认的行；`emit('upload' / 'remove')`。下载是读，组件自己发 |
| `TaskListFieldsDialog.vue`（FE-e1） | 同上 | `TaskListView` 子组件 | 绑定读、可复用字段读、新建 / 改定义的草稿、两步确认；写与 `TaskListView` 共用 `v-model:pending`（M4 成员对话框同形） |
| `TaskListProjectionPanel.vue`（FE-e2） | 同上 | `TaskListView` 子组件 | 投影状态读、导出进行中；`v-model:pending` |
| `tasks/tasksRecurrence.ts` | `src/tasks/` | 纯函数 | 规则预检与规范形、相等判定、草稿与规则互转、摘要的格式化参数 |
| `tasks/tasksFieldValues.ts` | 同上 | 纯函数 | 取值预检、草稿与取值互转、按类型的显示文本 |
| `tasks/tasksFieldDefinition.ts` | 同上 | 纯函数 | 定义预检、`POST` / `PATCH` 体组装（`PATCH` 带整份选项、从不带 `type`） |
| `tasks/tasksAttachmentRules.ts`（FE-d4） | 同上 | 纯函数 | 附件的本地预检（类型、扩展名、大小、个数） |
| `tasks/tasksDetailExtras.ts` | 同上 | 纯函数 | `createDetailExtras()` 与各草稿在重拉时的合并规则 |

### 2.4 `TasksView.vue` 的增量（`[fe5-02]`）

- **一个执行器** `runDetailWrite`（约 40 行，§4.0），是 M5 详情写的唯一入口：取 `detailActionToken`、置 `detailActionPending`、晚到守卫、成功后 `loadDetail`、失败分流。子组件只 emit 意图，`TasksView` 用约十个薄 handler 把意图映射成一次 API 调用交给执行器。子组件不 import 任何写函数（§9.1 有一格静态检查）。
- **一个容器** `detailExtras`（`tasksDetailExtras.ts#createDetailExtras`）：重复规则草稿、正在编辑的字段及其草稿、各新区的区内错误、评论的暂存附件（FE-d4）。它在既有 `watch(detailResult)`（`:1503-1529`）旁边另有一个同步 `watch`，按 §5 第 3 条的规则合并重拉结果，既有函数体不改。
- `watch(taskId)` 的复位块（`:1764` 起）追加两行：`detailExtras` 与附件读（FE-d4）的复位与 generation。
- 既有函数体只有一处改动，在 FE-d4：M3 的评论提交 handler（`onCreateComment`，`:1302`）在有暂存附件时带上它们、成功后另重读附件列表（§4.7）；没有暂存附件时它的请求与后续动作逐字节不变。其余 M3 / M4 函数体零改动。
- 规模估计：+300 行左右（1903 → 约 2200）。是否在 M5 之前先拆 `TasksView.vue` 见 §11-Q1（M4 前端 `[fe-01]` 与其 §12-Q1 的缺省是不拆）。

### 2.5 清单页的增量

- 页头既有的按钮行（改名、归档、成员）后面加「字段」按钮（`[fe5-29]`：所有成员可见）；清单项区之后加一个默认收起的「多维表视图与导出」面板（`[fe5-34]`）。
- 清单项区的任务行（`TaskListView.vue:137-139` 的行插槽）加里程碑徽标 `tasks-list-detail-item-milestone`（`[fe5-07]`）。
- 两个新子组件都接 `TaskListView` 既有的 `pending`（`v-model:pending`），于是页面上任何一处在写，其余写控件全部禁用（M4 前端 §4.0）。

---

## 3. API 客户端（`tasksApi.ts` 的 M5 追加）

### 3.1 共性（沿用 M4 前端 §3.1，只写新增）

- 判别联合、从不抛错；写失败一律经 `classifyWriteFailure`（`:604`）；成功体经严格解析器（每个字段都查、闭集字面量逐个比、多余键忽略、缺键或错型即 `error`），以 `parseXxx(value: unknown): Xxx | null` 导出，spec 直接喂畸形体。
- **路径段**：每个放进路径的 id 先过 `isPathSafeSegment`（`:587`）——任务 id、对端任务 id（删依赖的 `:otherId`）、清单 id、字段 id（绑定与字段定义两组路由的 `:fieldId` / `:id`）、附件 id（FE-d4）。不通过 ⇒ `not_found`、不发请求。深链的 `sheetId` / `viewId` 同样先过它，不通过 ⇒ 不渲染该链接、面板报错（FE-e2）。
- **请求体里的 id**（`predecessorId` / `successorId` / `fieldId`）只来自服务端给的列表（候选、可复用字段、详情），前端不提供手填 id 的入口，所以不做四合取预检；服务端的 422 `INVALID_DEPENDENCY` / `INVALID_FIELD` 在前端只可能是契约漂移，走通用文案。
- **既有函数只做加法**，默认请求逐字节不变：`completeTask(id)` 不带请求体（`:472-494` 今天就不带），只有 `completeTask(id, 'all')` 发 `{ "scope": "all" }`，客户端从不显式发 `'self'`（`[fe5-04]`）；`createComment(id, body)`（`:931`）不带附件时请求体仍是 `{ body }`（FE-d4）。
- **两条有上限的读不分页**：PR-4a 冻结 `GET /api/task-lists/:id/field-bindings` 回 `{ items }`、`GET /api/tasks/:id/dependencies` 回两个数组，都不带 `total`（其 §3.0、`[a-34]`）。`readCollection`（`:1072`）要求 `total`（`:1091`），所以绑定读用专用解析器；依赖读前端不调用（`[fe5-13]`）。这是 PR-4a §7.2 的 S34 / E22 问题取 B（现行冻结值）时的形状；owner 若取 A，绑定读改用 `readCollection` + `collectPages`、项形状不变，只改解析器与它的格（§11.2）。
- **集合读的降级体**：PR-4a 新路由里只有 `GET /api/task-fields` 是集合型读，缺 org 回 `{ items: [], degraded: true, reason: 'org_missing' }`；挂在任务 id 或清单 id 下的读（候选、绑定）缺 org 是 404（PR-4a §3.0）。
- **分页**：`GET /api/task-fields` 与候选读用 M4 的分页形（`limit` 固定 100、`offset`）；字段定义每 org 至多 200（S28），读全部页用 `collectPages`（`:1098`）；候选只读第一页，「加载更多」再读下一页（`[fe5-14]`）。

### 3.2 函数表（PR-4a：14 个新函数覆盖 16 条新路由中的 15 条，两条删边路由共用一个函数；另扩 3 个既有函数；只有依赖读不建）

| 函数 | 方法 路径 | 请求体 | ok 形状 | 失败 kind（码） |
|---|---|---|---|---|
| `completeTask(id, scope?)`（扩） | `POST /api/tasks/:id/complete` | 缺省不带体；`'all'` ⇒ `{ scope: 'all' }` | 不变：`{ done }` | 不变（`CompleteTaskResult` 没有 `validation`：422 非 `ORG_MISSING` 一律 `{ kind: 'error', status: 422 }`；前端只发 `'all'`，`INVALID_SCOPE` 只可能是漂移） |
| `deleteTask(id)`（扩） | 不变 | — | `{ id, deleted: true, deletedIds? }`：`deletedIds` 出现即校验为非空字符串数组且首项等于 `id` | 不变；系列删除里任一期有未删子任务 ⇒ 409 `HAS_CHILDREN`，取行锁超时 ⇒ 409 `TASK_BUSY` |
| `getTask(id)`（扩） | 不变 | — | `TaskDetail` 增补四组键（§3.3） | 不变 |
| `setTaskRecurrence(id, rule)` | `PUT /api/tasks/:id/recurrence` | `{ recurrence: Rule \| null }`，键必带（缺键答 422，`[a-32]`） | `{ id, recurrence, seriesId, previousOccurrenceId }` | `not_found`、`org_missing`；`validation`：`INVALID_RECURRENCE` `DUE_REQUIRED` `NOT_CURRENT_OCCURRENCE`（任务 E 问题 3 若取「`count` 超过 365 答 `LIMIT`」的选项，另有 `LIMIT`，同一文案） |
| `setTaskMilestone(id, isMilestone)` | `PATCH /api/tasks/:id/milestone` | `{ isMilestone }`（真布尔） | `{ id, isMilestone }` | `not_found`、`org_missing`；`validation`：`INVALID_MILESTONE` |
| `addTaskDependency(id, end)` | `POST /api/tasks/:id/dependencies` | 恰一个键：`{ predecessorId }` 或 `{ successorId }`（`[a-12]`） | `{ predecessorId, successorId }` | `not_found`、`org_missing`；`validation`：`INVALID_DEPENDENCY` `SELF` `DUPLICATE` `CYCLE` `LIMIT` |
| `removeTaskDependency(id, direction, otherId)` | `DELETE /api/tasks/:id/dependencies/predecessors/:otherId` 或 `…/successors/:otherId` | — | 同上；边不存在是空操作，仍 200 | `not_found`、`org_missing` |
| `listDependencyCandidates(id, direction, q, offset)` | `GET /api/tasks/:id/dependency-candidates?direction=…&limit=100&offset=N[&q=…]`；`q` 经 `encodeURIComponent`，去首尾空白后为空就不带 | — | `{ items: [{ id, title, status }], total }` | `not_found`（含缺 org，`[own-48]` 的先后）、`forbidden`、`error`（`INVALID_DIRECTION` / `INVALID_QUERY` / 分页码只可能是漂移或本地预检漏网） |
| `setTaskFieldValue(id, fieldId, value)` | `PUT /api/tasks/:id/field-values` | `{ fieldId, value }`；清空发 `null`（`[a-09]`、`[a-13]`） | `{ taskId, fieldId, value }` | `not_found`、`org_missing`；`validation`：`INVALID_FIELD` `INVALID_VALUE` `NOT_IN_OPTIONS` `INACTIVE_ORG_MEMBER` `TOO_LONG` `OUT_OF_RANGE` `LIMIT` |
| `listTaskFields(options)` | `GET /api/task-fields?limit=100&offset=N`，读全部页 | — | `{ items: Field[], total }`；按 `created_at, id` 排（`[a-34]`） | `org_missing`（降级体）、`forbidden`、`not_found`、`error` |
| `createTaskField(input)` | `POST /api/task-fields` | `{ type, name, config? }` | `Field` | `org_missing`；`validation`：`INVALID_TYPE` `INVALID_NAME` `INVALID_CONFIG` `LIMIT` |
| `updateTaskField(id, patch)` | `PATCH /api/task-fields/:id` | `{ name?, config? }`，至少一个；从不带 `type`（`[fe5-32]`） | `Field` | `not_found`、`org_missing`；`validation`：`INVALID_TYPE` `INVALID_NAME` `INVALID_CONFIG` `INVALID_FIELD_PATCH` `LIMIT` |
| `deleteTaskField(id)` | `DELETE /api/task-fields/:id` | — | `{ id, deleted: true }` | `not_found`（非创建者，先于绑定数判定）、`org_missing`；`validation`：`FIELD_IN_USE` |
| `listTaskListFieldBindings(listId)` | `GET /api/task-lists/:id/field-bindings` | — | `{ items: Binding[] }`，按 `position` 排，相同时按字段 id 的字节序（PR-4a §3.6 冻结为 `position, field_id COLLATE "C"`；前端照服务端顺序显示、从不自己排序；专用解析器，§3.1） | `not_found`（含非成员、缺 org）、`forbidden`、`error` |
| `bindTaskListField(listId, fieldId)` | `POST /api/task-lists/:id/field-bindings` | `{ fieldId }` | 单个 `Binding` | `not_found`（字段不在可复用集合里也是 404）、`org_missing`；`validation`：`INVALID_FIELD` `LIMIT` |
| `updateTaskListFieldBinding(listId, fieldId, patch)` | `PATCH /api/task-lists/:id/field-bindings/:fieldId` | `{ position?, hidden? }`，至少一个；`position` 是 0..n-1 的目标下标（`[a-42]`） | 整张清单的 `{ items: Binding[] }`（同 `GET`） | `not_found`、`org_missing`；`validation`：`INVALID_BINDING` |
| `unbindTaskListField(listId, fieldId)` | `DELETE /api/task-lists/:id/field-bindings/:fieldId` | — | `{ listId, fieldId }`；未绑定而删是空操作 | `not_found`、`org_missing` |

`Field = { id, type, name, config, createdBy, createdAt, updatedAt }`，`type` ∈ 六型闭集（S25）。`Binding = { fieldId, position, hidden, field: Field }`。依赖读 `GET /api/tasks/:id/dependencies` 不建函数（`[fe5-13]`）：详情体已带同形的 `dependencies`，写后的刷新本来就是重拉详情。

### 3.3 `TaskDetail` 的 M5 键（`[fe5-03]`）

按 PR-4a §1.3 的切片分组；每组可整组缺失，组内缺一或错型 ⇒ 整个详情 `error`（M4 对 S4 四键组的同一规则）。

| 组（PR-4a 切片） | 键 | 解析规则 |
|---|---|---|
| G1（切片 1） | `canCompleteForAll` | 真布尔 |
| 系列（切片 3） | `recurrence`、`seriesId`、`previousOccurrenceId`、`nextOccurrenceId` | `recurrence` 为 `null` 或通过 §3.5 的规则预检（闭集外的键、越界值 ⇒ `error`；规范形由前端再算一次，只用于比较，不因周几的顺序拒绝整个详情）；三个 id 各为字符串或 `null` |
| 里程碑与依赖（切片 4） | `isMilestone`、`dependencies` | `isMilestone` 真布尔；`dependencies` 为 `{ predecessors, successors }`，两者都是 `DepItem` 数组 |
| 字段（切片 5） | `fieldValues` | `[{ listId, fields: [{ fieldId, name, type, config, hidden, value }] }]`；`type` 在六型闭集内；`config` 按类型校验必有键（多余键忽略）；`hidden` 真布尔；`value` 为 `null` 或与类型相符的形状（text 字符串、number 有限数、select 字符串、multiSelect / member 非空字符串数组、date 合法 `YYYY-MM-DD`）。选项是否仍在 `config` 里**不**校验：PR-4a `[a-38]` 让删掉选项后的旧取值照存值返回 |

`DepItem = { id, title, status, dueAt, isMilestone, canRemove }`：`status` 闭集、`dueAt` 字符串或 `null`、两个布尔。看不见的对端服务端已不列出（`[a-28]`）。

### 3.4 列表行与清单任务项

- `TaskListItem` 加可选 `is_milestone?: boolean`（PR-4a §3.8 只在 `GET /api/tasks` 与 `GET /api/task-lists/:id/items` 的 snake_case 行后加这一列）。
- `listTasks`（`:240`）今天不逐行校验，M5 也不改它（G2-core 在改，§1.4）；渲染只认 `task.is_milestone === true`（`[fe5-07]`）。
- 清单任务项读的 `isTaskListItem`（`:1558`）对出现的 `is_milestone` 严格校验为布尔，错型 ⇒ 整个集合读 `error`（M4 解析纪律）。

### 3.5 本地预检（纯函数；服务端的 422 仍是准绳）

| 模块 · 函数 | 规则（镜像 #6249 `39a2a29be9`） | 返回码 |
|---|---|---|
| `tasksRecurrence.ts#checkRecurrenceRule(draft)` | `freq` ∈ daily / weekly / monthly / yearly；`interval` 整数 1..365；weekly 必须有非空 `byWeekday`（整数 0..6，0 = 周日），其余频率不得带它；`byMonthDay` 只属 monthly，取 1..31 或 `'last'`，缺省即按锚点日；`end` 至多一个，`until` 是合法日期、`count` 整数 1..365；规范形把 `byWeekday` 去重升序 | `INVALID_RECURRENCE`（另带本地字段名，只用于把文案落到对应控件旁；服务端错误体没有字段名，`[a-14]`） |
| `tasksRecurrence.ts#sameRule(a, b)` | 两个规范形逐键相等（`null` 只等于 `null`） | — |
| `tasksFieldValues.ts#checkFieldValue(field, draft)` | text：去两端空白与零宽后为空 ⇒ 清空，超过 2000 码点 ⇒ `LIMIT`，超过 `maxLength` ⇒ `TOO_LONG`；number：有限数、`|x| < 1e15`；select：选项 id 在当前 `config.options` 里；multiSelect：去重后的 id 都在选项里，空 ⇒ 清空；member：非空 id、去重、每个 id ≤ 50 个字符（任务 E 的 `maxMemberIdChars`；服务端对更长的 id 答 `INACTIVE_ORG_MEMBER`，本地先按 `INVALID_VALUE` 挡下，免得把格式问题说成「不是在职成员」）、≤ 50 人、`single` 时 ≤ 1；date：合法 `YYYY-MM-DD`。成员是否在职只有服务端知道（422 `INACTIVE_ORG_MEMBER`） | `INVALID_VALUE` `NOT_IN_OPTIONS` `TOO_LONG` `OUT_OF_RANGE` `LIMIT` |
| `tasksFieldValues.ts#buildFieldValueWrite(field, base, draft)` | 与 `base` 规范形相同 ⇒ `unchanged`（不发）；多选里已不在选项中的旧 id 先去掉（`[fe5-19]`） | — |
| `tasksFieldDefinition.ts#checkFieldDefinition(draft)` | 类型闭集；名称归一后 1..100 码点；text 的 `maxLength` 整数 1..2000；number 的 `decimals` 0..6、`format` plain / percent；选项 ≤ 100 个、标签 1..100 码点且不区分大小写唯一、颜色 `#rgb` 或 `#rrggbb`；member 的 `single` 布尔；date 无配置 | `INVALID_TYPE` `INVALID_NAME` `INVALID_CONFIG` `LIMIT` |
| `tasksFieldDefinition.ts#buildFieldPatch(field, draft)` | 只放变了的 `name` / `config`；`config` 是整份（已有选项带 id、新选项不带 id，删掉的不出现）；全部不变 ⇒ `null`（不发，`INVALID_FIELD_PATCH` 因而在界面上不可达） | — |

---

## 4. 各区的状态设计

### 4.0 通用规则（M4 前端 §4.0 之上的增量）

- **执行器**（`[fe5-02]`）：`runDetailWrite(section, call, options)`。① `taskId` 为空或 `detailActionPending` 为真 ⇒ 不做；② 清掉本区的区内错误与 `actionErrorKind`；③ `token = ++detailActionToken`、`detailActionPending = true`；④ `await call(id)`；⑤ `token !== detailActionToken` ⇒ 只做副作用（`ok` 且该写会改变红点输入时 `notifyTasksChanged()`）后返回；⑥ `ok` ⇒ 按需通知红点、执行成功后动作（缺省 `await loadDetail(id)`；附件上传换成只重读附件列表）；⑦ 失败分流：`validation` / `conflict` ⇒ 本区错误（§6 的落点表），表里标「重拉」的码另 `loadDetail(id)`；`not_found` ⇒ 本区的 404 文案并 `loadDetail(id)`（`[fe5-42]`）；`org_missing` / `forbidden` / `error` ⇒ 既有 `applyDetailFailure`（`:1054`）；⑧ `finally` 只在 token 仍是自己时解除 pending，并恢复焦点（`[fe5-16]`）。焦点的来源在第 ③ 步记下：`document.activeElement` 的 `data-testid` 与它所在行的行键（`data-dep-id` / `data-field-id` / `data-attachment-id`），只在它落在 M5 的某个区内、或就是 G1 按钮及其确认按钮时记；恢复不看结果——`ok`、重拉的失败（含 404）与不重拉的失败都在 pending 解除、DOM 更新之后执行，与 M4 成员对话框 `beginWrite` / `endWrite` 的形状相同（`[fe-48]`）。规则：区内错误落在某个控件旁（重复编辑器的本地字段名、字段编辑器）且该控件仍在、未禁用 ⇒ 焦点给那个控件（M4 `TaskDetailEditor.vue` 的「错误移焦」先例）；否则还给记下的控件（仍在且未禁用）；都不满足 ⇒ 本区标题（`<h3 tabindex="-1">`）。例：`DUE_REQUIRED` 重拉后截止日为空、整个重复编辑器被禁用，焦点落到重复区标题。G1 按钮不在任何新区里（§2.2 的完成按钮行），它的回退是同一行仍在的「完成」或「重启」按钮（G1 成功后任务已完成、G1 按钮消失，焦点到「重启」）。比较用 token 而不是 `taskId`，覆盖「离开又回来」（M3 设计 §3.6，`:1038-1044` 的注释）。
- **区内错误放在父组件**：详情块在每次 `loadDetail` 时卸载重建，区内错误若放在子组件，上一条的「失败后重拉」会把它冲掉；所以它们在 `detailExtras.errors` 里，下一次动作开始或路由边沿时才清（M4 `listsError` `:1667` 的同一做法）。
- **悲观更新**：所有 M5 写成功后重拉受影响的读面，不本地合并响应。两处例外：字段绑定的 `PATCH` 用响应里的整张顺序替换本地（`[fe5-31]`，PR-4a 明说客户端据此取新顺序），以及上传附件之后只重读附件列表、不重拉详情（FE-d4）。
- **红点**：只有改变待办输入的 M5 写才通知——G1（完成态翻转）与系列删除。重复规则、里程碑、依赖、字段取值、附件都不通知（M4 `R16` 的触点口径；PR-3c 的服务端信号同样只覆盖翻转与删除）。派生出下一期发生在完成那一次写里，红点由既有的完成路径通知。
- **一次一个动作**：M5 的每个写都走执行器，与 M3 的五区、M4 的编辑区与清单区在同一个互斥域；任一在途，其余写控件 `disabled`（§9.1 两个方向各一格）。读（候选搜索、附件下载、FE-e 的读）不占这个锁，各有 generation。
- **路由边沿**：`watch(taskId)` 复位 `detailExtras`、附件读的 generation 与结果（§2.4）。
- **读面的状态**（M4 前端 §4.0 的五态）：M5 新增的每个读面——候选面板（§4.5）、附件列表（§4.7）、字段对话框的绑定读与可复用字段选择器（§4.8）、投影状态读（§4.9）——都有 `loading`、`empty`、`error` 三个可区分的状态，各自一个 `data-testid`（`<区前缀>-loading` / `-empty` / `-error`），空与读失败不得同形；该读能答的 `not_found` / `forbidden` / `org_missing` 另有各自的节点。读失败时显示「……读取失败，请稍后重试」形状的一句（M4 `listLoadFailed` 等既有文案的形状，不新增重试控件；候选面板再提交一次搜索、对话框与面板关掉再打开即重读），不显示空态文案。
- **逐行按钮的可访问名**：同一列表里每行都有的按钮（依赖行的「移除」、候选行的「添加」、附件行的「下载」「移除」、暂存附件行的「移除」、字段行的「编辑」「清空」、绑定行的「上移」「下移」「隐藏」「解绑」「编辑定义」、选择器行的「绑定」「删除」）都带 `aria-label`，由格式函数把该行用户可见的名字（任务标题、附件显示名、字段名）拼进去（§8），照 M4 `fmt.listRemoveTaskNamed(title)` 与分组板、成员对话框的同一做法；可见文案仍是短词。

### 4.1 G1：为所有负责人完成

- 按钮 `tasks-detail-complete-all-button` 只在 `canCompleteForAll === true` 时出现（`[fe5-05]`）：前端不推断「是不是创建人、是不是 all 模式、有没有负责人」，服务端在详情里按 PR-4a `[a-05]` 算好了（创建人且 open、`all` 模式、至少一个负责人）。
- 两步内联确认（`tasks-detail-complete-all-confirm`）：提示句写明会把还没完成的负责人一起标为已完成，提示句带 `role="status"`；打开 ⇒ 焦点到确认按钮（`aria-describedby` 指向提示句），取消 ⇒ 焦点回到按钮（`focusAfterSwap`，M4 `[fe-49]` / `[fe-50]`）。
- 确认 ⇒ `completeTask(id, 'all')` 经执行器；`ok` ⇒ `notifyTasksChanged()` 与重拉。已完成时服务端空操作仍 200，前端照常重拉。
- 404 ⇒ 区内文案「无法为所有负责人完成：任务已不可见，或你已不能这样完成它」并重拉（PR-4a §3.0 把不存在、看不见与没有这项能力合成一个 404，文案不区分原因；重拉后按钮随 `canCompleteForAll` 消失或保留）。
- `INVALID_SCOPE` 在这里不可达：`completeTask` 的结果类型不带码（§3.2），前端只发 `'all'`，服务端若答它，走 `applyDetailFailure` 的通用文案。

### 4.2 里程碑

- 显示：区内一行状态（「里程碑」/「普通任务」）；列表行、清单页的行、依赖项在为真时显示徽标（文字徽标，不只靠图形，读屏可读）。
- 切换：`canEdit` 为真时显示一个 `aria-pressed` 的切换按钮（`[fe5-06]`）。按钮文案固定为「里程碑」，开或关只由 `aria-pressed` 与按下的样式表达；文案不随状态变（切换按钮若改文案，读屏会读出与事实相反的组合，例如把「改回普通任务」读成已按下）。用按钮而不用复选框：复选框在点击当下就自己翻转，写失败时 DOM 与服务端不一致，要手工复位；按钮的 `aria-pressed` 只从 props 来。
- 写：`setTaskMilestone(id, !isMilestone)`；不要求截止日（S13）；`INVALID_MILESTONE` 前端只可能是漂移，走通用文案。
- 404 ⇒ 区内文案「无法修改里程碑：任务已不可见，或你已不能编辑它」并重拉。

### 4.3 重复规则与系列

**显示**

- 有规则：摘要句（格式函数，例：每 2 周的周一、周三，共 10 次），`end` 的两种读法写清楚：`count` 含第一期，`until` 含当天（`[fe5-10]`，跟 #6249 的自选）。
- 系列导航（`[fe5-11]`）：`seriesId` 非空 ⇒「系列首期」链接；`previousOccurrenceId` 非空 ⇒「上一期」；`nextOccurrenceId` 非空 ⇒「下一期」。前两者服务端不按 `view` 过滤（`[a-35]`），点过去可能落到「不存在」页，这是已登记的取值；不预取、不探测。
- 有规则而截止日已清空（PR-4a `[a-27]` 允许）⇒ 提示「截止日期已清空，完成时不会生成下一期」。

**编辑器**（`canEdit` 为真时）

| 控件 | 取值 | 备注 |
|---|---|---|
| 频率 `select` | 每天 / 每周 / 每月 / 每年 | 切换频率时清掉不属于新频率的键（`byWeekday` / `byMonthDay`） |
| 间隔 `input[type=number]` | 1..365 | 标签随频率变（每 N 天 / 周 / 月 / 年） |
| 周几（weekly）`fieldset` + 七个复选框 | 值 0..6 | 显示从周一排起（`[fe5-09]`），`legend` 是「在这些日子重复」 |
| 每月的哪一天（monthly）单选组 | 不指定（不带键，沿用系列原来的日子）/ 第 N 日（1..31）/ 最后一天（`'last'`） | 不指定时按哪一天步进是任务 E 问题 1 的锚点规则，文案不展开（§11.2） |
| 结束 单选组 | 不结束 / 截止于某日（`until`）/ 共 N 次（`count`） | — |

- 截止日为空 ⇒ 整个编辑器 `disabled`，旁注「设置截止日期后才能设置重复」（服务端答 `DUE_REQUIRED`；本地先挡，`[fe5-08]`）。旁注是放在编辑器之前的 `role="status"` 元素（M4 分组板 `TaskGroupBoard.vue` 在分组数到上限时给出的 `role="status"` 提示同形）；编辑器的 `fieldset` 另用 `aria-describedby` 指向它，按表单控件浏览的读屏用户也能听到原因。
- **打开与放弃的焦点**（M4 `[fe-50]`）：「编辑重复规则」按钮换成编辑器 ⇒ 焦点到频率 `select`；「放弃」⇒ 焦点回到换回来的「编辑重复规则」按钮，按钮不在（`canEdit` 在重拉后变假）⇒ 本区标题。
- 404 ⇒ 区内文案「无法修改重复规则：任务已不可见，或你已不能编辑它」并重拉。
- 提交按钮在 `pending`、预检不通过、或草稿规范形与现值相同（`sameRule`）时禁用，于是不会对真后端发空操作。
- 「结束重复」只在 `recurrence !== null`、`canEdit` 且 `status === 'open'` 时显示（`[fe5-08]`）：PR-4a §3.2 只允许在系列里最新且未完成的一期上结束；不是最新时服务端答 `NOT_CURRENT_OCCURRENCE`（区内文案并重拉，重拉后可能出现「下一期」链接）。前端不尝试判断「最新」：`nextOccurrenceId` 对看不见后继的人恒为 `null`。不做两步确认：结束之后在同一期上重新设规则即可恢复。

**状态机**（M4 前端 §7.3 的同形；草稿在 `detailExtras.recurrence`）

```
idle --打开编辑器--> editing（草稿 = 现值的规范形；焦点到频率 select）
editing --保存（预检过、与现值不同）--> pending --ok--> idle（重拉；草稿清空）
                                              --422 规则类--> editing（区内文案；草稿保留）
                                              --422 状态类（DUE_REQUIRED、NOT_CURRENT_OCCURRENCE）--> editing（文案 + 重拉）
                                              --404--> idle（区内文案 + 重拉）
editing --放弃--> idle（焦点回到「编辑重复规则」按钮）
任何状态 --别处的重拉--> 原状态（草稿不脏 ⇒ 按新值重置；脏 ⇒ 保留并提示「服务端已更新」）
路由边沿 --> idle（草稿清空）
```

### 4.4 系列删除

- 确认句（既有 `tasks-detail-delete-confirm`）：详情显示本任务在系列里（`recurrence !== null`、`seriesId !== null` 或 `nextOccurrenceId !== null`）时加一句「本系列中排在它之后、尚未完成的各期会一起删除」（`[fe5-12]`）。判定只用于文案；服务端按 PR-4a §3.8 自己判定系列成员。
- 成功：`deletedIds` 严格解析，不展示；照旧 `notifyTasksChanged()` 后回 `/tasks`（`:1436-1460` 的既有路径）。
- 409 `HAS_CHILDREN`（任一期还有未删子任务）与 `TASK_BUSY` 沿用既有文案与落点。

### 4.5 依赖

- 两列：「前置任务」「后置任务」；每项（`data-dep-id`）显示标题链接、状态、截止（`dueAt` 经既有 `formatViewerInstant`）与里程碑徽标；`canRemove` 为真才有「移除」按钮，`aria-label` 带对端标题（「移除前置任务『标题』」/「移除后置任务『标题』」，§4.0）。两个数组的顺序照服务端（边的建立先后，`[a-34]`）。空数组显示「暂无」。
- **加边**：「添加前置」「添加后置」两个按钮各打开一个方向固定的搜索面板（`canEdit` 为真才显示）。打开 ⇒ 焦点到面板的搜索输入框；面板有一个「关闭」按钮（`tasks-detail-dependency-panel-close`），关闭 ⇒ 面板收起、焦点回到打开它的那个按钮（M4 `[fe-50]` 的就地切换规则，`focusAfterSwap`）。面板不加 Esc：M4 `[fe-50]` 对就地表单明确不加 Esc 取消，是否统一加留在 M4 前端 §12-Q35。搜索是显式提交（Enter 或按钮，`[fe5-14]`）；结果每行（`data-candidate-id`）一个「添加」按钮，`aria-label` 带候选标题（「添加『标题』为前置任务」/「…为后置任务」），`emit('add', { predecessorId })` 或 `{ successorId }`。候选是服务端过滤过的（只含调用者能编辑的、排除自身与已有边；按任务 E 现行代码还排除会成环的，PR-4a §7.2 X3），但加边仍可能答 `CYCLE` / `DUPLICATE`（并发，或 owner 对 X3 取 A），都有文案。
- **候选读**：组件自己的 generation；新的提交使在途的结果作废；`total > items.length` 时「加载更多」读下一页并按 id 去重追加。`q` 本地先截首尾空白，超过 200 个字符 ⇒ 本地提示、不发（服务端答 `INVALID_QUERY`；本地提示用 §6 的 `INVALID_QUERY` 文案）。状态（§4.0 的读面规则）：未提交 ⇒ 只有搜索表单；`loading` ⇒「正在搜索」；`ok` 且零条 ⇒「没有可添加的任务」（`tasks-detail-dependency-candidates-empty`，并说明只列出你能编辑、且尚未相连的任务）；`not_found` ⇒ 与本区 404 同一句并 `emit('reload')` 请父组件重拉；`forbidden` / `error` ⇒「搜索失败，请稍后重试」（`tasks-detail-dependency-candidates-error`），不显示空态文案。服务端的 `INVALID_DIRECTION` / `INVALID_QUERY` / 分页码到这里都是 `error`（结果不带码，§3.2），走这一句。面板的本地态在无关的重拉中丢失（组件随详情块重建），是接受的代价：面板里没有用户写下的长内容，加边成功后面板本来就收起。
- **删边**：直接删，不做两步确认（`[fe5-15]`，与删负责人同形）；方向决定路径（前置列表的项走 `…/predecessors/:otherId`，后置走 `…/successors/:otherId`）。
- 404：区内文案「无法修改依赖：对方任务已不可见，或你不能编辑两端中的某一个」并重拉（`[fe5-42]`）。

### 4.6 自定义字段取值

- **分组**：按 `fieldValues` 的顺序逐组显示，组名取父组件已有的「我的清单」读（M4 `myListsResult`，`:1665`）里的清单名，取不到显示 id（`[fe5-22]`）。`fieldValues` 为空数组 ⇒ 整区不渲染（只凭直接角色看到任务、却不在任何相关清单里的人，S27）。
- **隐藏字段**：绑定为 `hidden` 的字段收进每组末尾一个默认收起的区（按钮 `aria-expanded`），仍可编辑（`[fe5-18]`）。
- **显示**：text 原样（`white-space: pre-wrap`）；number 按 `decimals` 用 `toFixed`，`percent` 只加 `%` 不乘 100（`[fe5-20]`）；select 显示选项标签，存的 id 已不在选项里 ⇒「已删除的选项」（`[fe5-19]`）；multiSelect 逐个标签，同上；member 逐个用户 id；date 原样（浮动日，不经 `Date` 往返）；`null` ⇒「未填写」。
- **编辑**：`canEdit` 为真时每个字段一个「编辑」按钮；一次只编辑一个字段（`[fe5-17]`），草稿在 `detailExtras.fieldEdit = { listId, fieldId, base, draft }`。同一个字段若出现在两组里，只在点了「编辑」的那一组里展开编辑器。各型控件：text `textarea` + 码点计数；number `input[type=number]`；select `select`（含「不选」）；multiSelect 一组复选框；member 一组用户 id 输入（`single` 时一个，`[fe5-21]`）；date `input[type=date]`。另有「清空」按钮发 `null`。每个字段行带 `data-field-id`（同一字段出现在两组时另带 `data-list-id`）；「编辑」「清空」的 `aria-label` 带字段名（「编辑字段『名称』」/「清空字段『名称』」，§4.0）。
- **打开与取消的焦点**（M4 `[fe-50]`）：「编辑」换成编辑器 ⇒ 焦点到该型的第一个控件（text 的 `textarea`、number / date 的输入框、select 的 `select`、multiSelect 的第一个复选框、member 的第一个输入框）；「取消」（`emit('cancel')`）⇒ 焦点回到同一行（同一组）换回来的「编辑」按钮：`focusAfterSwap` 只接一个行键，所以 root 取该组的容器（`data-list-id`），行键取 `data-field-id`，同一字段在别的组里的那一行不会被选中。
- **写**：`buildFieldValueWrite` 为 `unchanged` ⇒ 不发；预检有码 ⇒ 区内文案、不发；否则 `setTaskFieldValue`。多选草稿里已不在选项中的旧 id 发送前去掉，并在编辑器里提示一句（`[fe5-19]`）。
- **失败**：`NOT_IN_OPTIONS`（别人刚删了选项）⇒ 文案并重拉；404 ⇒ 区内文案「无法修改这个字段：任务已不可见、你已不能编辑它，或这个字段已不在任务所在的清单上」并重拉；`INACTIVE_ORG_MEMBER` 用 M4 的同一文案；其余码区内文案、草稿保留。
- 不通知红点。

### 4.7 附件（FE-d4，依赖 PR-4b；§12.1 的假设全部成立时的形状）

- **渲染前提**（`[fe5-23]`）：详情体带 PR-4b 的附件能力键（假设名 `canAttach`）才渲染本区、才发附件列表读；键缺失 ⇒ 不渲染、零请求。这样既有 spec 与 PR-4b 合入前的后端都不受影响。
- **列表读**由 `TasksView` 持有（`[fe5-24]`，同 M4 把「我的清单」读放在父组件的理由）：进入详情（且能力键在）时读一次，附件写或带附件的评论写成功后重读；自己的 generation；`loading` / `ok` / `empty` / `error` 四态（§4.0 的读面规则：`empty`「还没有附件」与 `error`「附件列表读取失败，请稍后重试」各有 `data-testid`；`not_found` 走本区 404 一句）。
- **每行**（`data-attachment-id`）：显示名、类型、大小、上传者、来源（任务级 / 「来自评论」，`[fe5-27]`）；「下载」；行级 `canRemove`（假设 PR-4b 照 PR-4a `DepItem.canRemove` 的先例逐行给出）为真才有「移除」。「下载」「移除」的 `aria-label` 带显示名（「下载『文件名』」/「移除附件『文件名』」，§4.0）。
- **上传**（任务级）：`input[type=file]`（单文件）+「上传」按钮；本地预检（`[fe5-28]`）：七种 MIME 与扩展名一致、1 字节到 10 MiB（PR-4a §2.7 的两条 CHECK，S18）、每任务 20 个（S18、S28；超限答 `LIMIT` 是 D18，`ASSUMPTION`）；不过 ⇒ 区内文案、不发。签名比对只在服务端。上传经执行器（占详情的互斥锁），执行器的成功后动作换成只重读附件列表、不重拉详情。
- **下载**：经 `apiFetch` 取字节 ⇒ `URL.createObjectURL` ⇒ 临时 `<a download>`，文件名取行的显示名（`[fe5-25]`，`MetaAttachmentList.vue` 的既有做法）；从不导航到存储地址、不内联预览。在途集合防重复点击；404 / 410 / 503 各有文案（PR-4a §2.10 的 `TaskAttachmentRowForDownload` 带 `status` 与 `scanState`，已删或感染只在授权之后才答 410 是 PR-4b 的事）。
- **移除**：两步内联确认（`[fe5-26]`）；成功重读列表。
- 404（PR-4b 未冻结，按 PR-4a §3.0 的同一折叠假设）⇒ 区内文案「无法操作这个附件：附件或任务已不可见，或你已不能修改它」并重读附件列表与详情；PR-4b 冻结后按它的码表重核（§12.1 B8）。
- **评论附件**（`[fe5-27]`）：评论撰写区（既有，`newCommentBody` 在 `:724`）加「添加附件」；每选一个文件先上传为暂存（未绑定）附件，暂存列表与评论草稿一起放在 `TasksView`（`detailExtras.commentAttachments`）；提交评论时带 `attachmentIds`；未提交就离开的暂存留给服务端的过期清扫。暂存列表每行有一个「移除」按钮（`aria-label` 带文件名），点了只把该 id 从 `detailExtras.commentAttachments` 拿掉，提交体不再带它，不发请求、不占互斥锁；被拿掉的暂存行同样留给过期清扫。PR-4b 若提供删除未绑定附件的路由，改为经执行器调用它（§12.1 B4 的重核点）。移除后焦点给下一行的「移除」，没有下一行则给「添加附件」按钮。上传的请求形状按 PR-4a §7.2 的 S19 问题分叉：取 A 不带任务 id，取 B 带（§12.1）。每条评论至多 5 个（S18、S28）。M3 的评论行不改：评论级附件只在附件区里出现，标「来自评论」。这一片要给 M3 的评论提交 handler（`onCreateComment`，`:1302`）做一处加法：有暂存附件时带上它们的 id、成功后另重读附件列表；没有暂存附件时请求与之后的动作逐字节同今天，M3 的评论格不改。

### 4.8 清单页：字段对话框（FE-e1）

- **入口**：页头「字段」按钮对所有成员显示（`[fe5-29]`）；对话框照 M4 成员对话框（`role="dialog"`、`aria-modal`、打开后焦点到 `<h2 tabindex="-1">`、Esc 与「关闭」关闭并把焦点还给按钮、Tab 回绕、写进行中关闭禁用 `[fe-30]`、写落地后焦点收回对话框 `[fe-48]`）。
- **读**：打开时读绑定（`listTaskListFieldBindings`）；选择器展开时读可复用字段（`listTaskFields`，读全部页）。读不是 `ok` 时不渲染任何写控件（M4 `[fe-31]` 的同一理由）。两个读各按 §4.0 的读面规则渲染，失败都留在对话框里、不关闭（M4 §5.2 成员读的先例）：绑定读 `loading`、`ok` 且零条 ⇒「本清单还没有绑定字段」（`tasks-list-fields-empty`）、`error` ⇒「字段读取失败，请稍后重试」（`tasks-list-fields-error`）、`not_found` ⇒ 下文的 404 横幅；选择器 `loading`、`ok` 且（减去已绑定的之后）零条 ⇒「没有可绑定的字段」（`tasks-list-fields-picker-empty`）、`org_missing` 降级体 ⇒ 既有的缺 org 引导句（`tasks-list-fields-picker-org-missing`）、`forbidden` / `error` ⇒「可复用字段读取失败，请稍后重试」（`tasks-list-fields-picker-error`）。
- **只读成员**：看到绑定列表（名称、类型、是否隐藏），没有写控件。
- **edit / owner**：
  - 每个绑定行带 `data-field-id`；行上的每个按钮（「上移」「下移」「隐藏」「解绑」「编辑定义」）的 `aria-label` 都带字段名（§4.0）。
  - 调序：每行「上移」「下移」；`position` 从本地显示顺序数下标（M4 前端 §6.4 的规则：不用服务端回传的 `position` 做算术）。本地显示顺序就是 `GET` 与 `PATCH` 响应的顺序（§3.2），PR-4a §3.6 判定空操作所比的「现位置」也是该绑定在这个顺序里的下标、不比较存值，所以对话框显示的下标就是服务端眼里的当前下标；`ok` ⇒ 用响应的整张顺序替换本地（`[fe5-31]`），焦点留在同一字段的同一按钮（按钮因到顶 / 到底被禁用时落到该行的「隐藏」按钮，M4 `[fe-38]` 的同一规则），`aria-live` 播报「已移到第 N 位」。不做拖拽。
  - 显隐：`aria-pressed` 切换按钮，文案固定为「隐藏」（`aria-label`「隐藏字段『名称』」，同样固定），按下即已隐藏，文案不随状态变（同 `[fe5-06]` 的规则）；`PATCH { hidden }`。
  - 解绑：两步内联确认，提示句（`role="status"`）写明取值不会删除（S26）；成功重读绑定。
  - 绑定已有字段：选择器列出可复用字段减去已绑定的，每行（`data-field-id`）的「绑定」按钮 `aria-label` 带字段名；选中 ⇒ `bindTaskListField`；成功重读绑定。
  - 新建并绑定（`[fe5-30]`）：类型、名称与按类型的配置编辑器（选项编辑器可增删改标签与颜色、可上下移动）；预检通过 ⇒ 先 `createTaskField`、再 `bindTaskListField`，两步顺序发、都占页面的 `pending`；第二步失败 ⇒ 文案「字段已创建，但未能绑定到本清单」，该字段出现在选择器里可再绑。这偏离 M4 `[fe-05]`（每个手势恰一条请求、不做多请求序列），代价是第二步失败时留下一个已建、未绑的 org 级可复用字段（由创建者在选择器里再绑或删除）。
  - 改定义：在绑定行上「编辑定义」（有本清单的 edit / owner 即满足 S26 的改定义条件：字段绑在本清单上）；`buildFieldPatch` 为 `null` ⇒ 提交禁用；删除已有选项时提示「已存的取值仍保留这个选项，显示为已删除的选项」（PR-4a `[a-38]`）。
  - 删定义（`[fe5-33]`）：只在可复用字段选择器里、`createdBy` 等于当前用户的字段上出现（「删除」的 `aria-label` 带字段名），两步确认（提示句 `role="status"`）并写明取值一起删除；仍有绑定 ⇒ 服务端答 `FIELD_IN_USE`。当前用户 id 未解析出来时（M3 的三态）不显示，同 M4 `[fe-26]`。
  - **子表单的焦点**（M4 `[fe-50]`）：「新建字段」与「编辑定义」的表单替换打开它的按钮 ⇒ 焦点到表单的第一个输入（新建是类型 `select`，编辑定义是名称输入框）；「取消」⇒ 焦点回到换回来的打开按钮（编辑定义按 `data-field-id` 回到同一行）。子表单不另加 Esc：对话框的 Esc 照 M4 关闭整个对话框。
- **失败**：`INVALID_BINDING`（多半是别人同时改了顺序或解绑了）⇒ 文案「字段顺序已变化，已刷新」并重读绑定；`FIELD_IN_USE` 落在选择器里（它只出自选择器的删定义），重拉的是选择器的 `listTaskFields`，不是绑定（字段可能绑在别的清单上，本清单的绑定读看不到变化），对话框里的「删除」照旧保留，文案说明要先在所有清单上解绑；404 ⇒ 对话框横幅「无法修改本清单的字段：清单或字段已不可见，或你已不能编辑本清单」并请页面安静重读清单（M4 `[fe-31]` / `[fe-44]` 的做法），删定义的 404 另读一次选择器（非创建者与不存在合成同一个 404）；`LIMIT` 按落点读（`[fe5-38]`）。

### 4.9 清单页：多维表视图与导出面板（FE-e2，依赖 PR-4c）

- **默认收起，展开时才读**（`[fe5-34]`），与 M4 动态面板 `[fe-25]` 同形：页面挂载不新增请求，既有清单页 spec 的请求序列不变。
- **状态读**（假设 `GET /api/task-lists/:id/projection`，S04）：404 ⇒「多维表视图未启用」（开关关闭时子路由不挂载，与清单不存在无法区分，文案合写）；`enabled: false` ⇒ edit / owner 且清单未归档时显示「开启多维表视图」（`[fe5-37]`），其余成员只看到「尚未开启」；`enabled: true` ⇒ 三个深链（`[fe5-35]`）。另按 §4.0 的读面规则：`loading` ⇒「正在读取」；`forbidden` ⇒「你没有查看多维表视图的权限」（`tasks-list-projection-forbidden`）；`error` ⇒「多维表视图状态读取失败，请稍后重试」（`tasks-list-projection-error`），不显示「未启用」也不显示「尚未开启」。
- **开启**（假设 `POST …/projection`，幂等）：经页面 `pending`；`ok` ⇒ 用响应渲染深链。
- **深链**：`router-link` 到 `/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}`，三个视图键 `grid` / `kanban` / `gantt`；任一段不过 `isPathSafeSegment` ⇒ 不渲染该链接并在面板里报错。归档清单的投影只读（S36 (c)），链接照常显示，写不写得了由多维表侧判定。
- **导出 CSV**（假设 `GET /api/task-lists/:id/export?format=csv`，S10）：经 `apiFetch` 取字节下载，文件名优先取响应头 `Content-Disposition`，取不到用 `task-list-<listId>.csv`（固定文件名是 D11，`ASSUMPTION`；`[fe5-36]`）；前端不读、不改 CSV 内容（公式中和在服务端）。导出是读，不占页面 `pending`，在途时按钮禁用；404 / 403 / 失败各有文案。

### 4.10 列表行的里程碑徽标

- `TasksView` 的两份行模板同改（§1.4 第 2 条）；`TaskListView` 行插槽加 `tasks-list-detail-item-milestone`；`TaskGroupBoard` 的行内容来自宿主插槽（M4 `[fe-33]`），不改板本身。
- 只认 `=== true`（`[fe5-07]`）：缺键（今天的后端、既有夹具）与 `false` 都不渲染，于是既有 spec 的 DOM 不变。

---

## 5. 版本与冲突（M4 前端 §7.3 的延伸）

1. **`tasks.version`**（PR-4a §4.3）：G1 的翻转 +1；设 / 清规则、里程碑、依赖增删、字段取值与系列删除都不变；派生出的新一期是新行。所以 M4 编辑区的 `expectedVersion` 只会被 G1 与 M3 / M4 既有写推进，M5 的其余写不会让编辑区的保存 409。代价照 PR-4a 登记：持旧 `version` 的人在别人改了里程碑之后仍能 `PATCH` 成功（这几列不在 `PATCH` 里）。
2. **编辑区跨 M5 重拉**（`[fe5-39]`）：M5 的写都重拉详情，既有 `watch(detailResult)` 在草稿为脏时把 `serverUpdated` 置真（`:1526`），所以编辑区有未保存改动时，切一次里程碑也会提示「服务端已更新」。本件沿用：M4 的 `tasks-detail-m4.spec.ts` 已有格钉住「M3 动作重拉后草稿仍在且提示」，收窄成「只在编辑区的键真的变了才提示」要改那一格的断言，属于 M4 的改动，不在本件（§11-Q9）。
3. **M5 草稿跨重拉**：重复规则草稿与字段取值草稿照 M4 `[fe-19]` 的思路合并——草稿与它取自的值相同 ⇒ 按新值重置；不同 ⇒ 保留草稿、更新基准、提示「服务端已更新」。两者都没有版本前置条件：冲突表现为服务端的码（下一条）。
4. **由别人引起的 422**：`NOT_CURRENT_OCCURRENCE`（这一期已被完成并派生了下一期）、`DUE_REQUIRED`（截止日被清空）、`NOT_IN_OPTIONS`（选项被删）、`DUPLICATE`（同一条边被别人加了）——都显示文案并重拉，让界面回到服务端现状。用户输入错误的码（`INVALID_RECURRENCE`、`INVALID_VALUE`、`TOO_LONG`、`OUT_OF_RANGE`、`LIMIT`、`SELF`、`CYCLE`）只显示文案、保留草稿。
5. **字段定义没有版本**（PR-4a `[a-38]`，后写覆盖先写）：对话框的每次写成功后都重读绑定（`PATCH` 定义回 `Field`，但绑定列表里嵌的是旧的 `Field`）；两处同时改同一个定义时，后保存的人看到的是自己的结果，没有冲突提示——这是 PR-4a §7.4 Q3 的现行取值，owner 若改成版本前置条件，前端加一条 409 分支（§11.2）。
6. **绑定顺序**：下标按本地显示顺序算；别人同时调序会让下标落到意料之外的位置或越界（`INVALID_BINDING`）。成功的响应总是整张新顺序，前端照它显示；越界 ⇒ 重读。
7. **系列删除**：`TASK_BUSY`（某一期的评论写持锁）与 `HAS_CHILDREN` 沿用既有文案。
8. **晚到结果**：所有 M5 写走执行器的 token；候选读、附件列表读、清单页的读各有 generation（M4 前端 §4.0）。
9. **投影的 `taskVersion`**：多维表侧改期用投影记录里的版本（S06 / S08），属于 FE-f，本件不涉及。

---

## 6. 错误码 → 文案（全部进 `labels.ts`，一码一文案，两种语言）

PR-4a 新增码（§3.9）与本件的落点。「重拉」= 显示文案之后 `loadDetail`（FE-d）或重读绑定（FE-e1；`FIELD_IN_USE` 例外，重读的是选择器的可复用字段，§4.8）。「界面上不可达」= 客户端的结果类型带不出这个码（或请求在本地就被挡下），文案只登记、保持键对齐，没有能断言它显示出来的行为格。

| 码 | 文案（中文） | 落点 | 重拉 |
|---|---|---|---|
| `INVALID_SCOPE` | 完成范围无效 | 界面上不可达（`CompleteTaskResult` 不带码，§3.2；服务端若答它走通用文案） | 否 |
| `INVALID_RECURRENCE` | 重复规则不正确 | 重复编辑器（本地预检能指到字段时落在该控件旁） | 否 |
| `DUE_REQUIRED` | 请先设置截止日期，再设置重复 | 重复编辑器 | 是 |
| `NOT_CURRENT_OCCURRENCE` | 只有系列里最新且未完成的一期可以结束重复 | 重复区 | 是 |
| `INVALID_MILESTONE` | 里程碑设置无效 | 里程碑区 | 否 |
| `INVALID_DEPENDENCY` | 依赖参数无效 | 依赖区 | 否 |
| `SELF` | 任务不能依赖自己 | 依赖区 | 否 |
| `DUPLICATE` | 这条依赖已经存在 | 依赖区 | 是 |
| `CYCLE` | 添加后会形成循环依赖 | 依赖区 | 否 |
| `INVALID_DIRECTION` | 依赖方向无效 | 界面上不可达（候选读的 422 归 `error`、不带码，§3.2；服务端若答它走候选面板的「搜索失败」） | 否 |
| `INVALID_QUERY` | 搜索内容不能超过 200 个字符 | 候选面板：只由本地预检（超过 200 个字符不发）显示；服务端的码走「搜索失败」 | 否 |
| `INVALID_TYPE` | 字段类型无效，且创建后不能更改 | 字段对话框 | 否 |
| `INVALID_CONFIG` | 字段设置不正确 | 字段对话框 | 否 |
| `INVALID_FIELD_PATCH` | 没有需要保存的修改 | 字段对话框（界面上不可达） | 否 |
| `FIELD_IN_USE` | 该字段仍绑定在清单上，先解绑才能删除 | 字段对话框的可复用字段选择器 | 是（重读选择器，不是绑定） |
| `INVALID_FIELD` | 字段无效 | 字段区 / 字段对话框 | 否（请求体里的字段 id 只来自服务端，只可能是漂移） |
| `INVALID_BINDING` | 字段顺序已变化，已刷新 | 字段对话框 | 是 |
| `INVALID_VALUE` | 取值格式不正确 | 字段编辑器 | 否 |
| `NOT_IN_OPTIONS` | 所选的选项已不存在 | 字段编辑器 | 是 |
| `TOO_LONG` | 内容超出该字段允许的长度 | 字段编辑器 | 否 |
| `OUT_OF_RANGE` | 数值超出允许范围 | 字段编辑器 | 否 |

沿用的码按落点读（M4 前端 §9.2 的做法：码相同、文案按调用点选，`[fe5-38]`）：`LIMIT` 在依赖区读作「每个任务的前置与后置合计最多 50 个」，新建字段读作「本组织的字段定义已达上限」，选项读作「选项数已达上限」，绑定读作「本清单绑定的字段已达上限」，成员型取值读作「最多选择 50 人」，文本取值读作「内容超过 2000 字」，附件读作「附件数已达上限」（各数值出自 S28 与 PR-4a 标注的 D18，超限答 `LIMIT` 是 D18，`ASSUMPTION`；数字只出现在由常量生成的文案里，常量单点定义）；`INVALID_NAME` 在字段对话框里读作「字段名为空或超过 100 字」（PR-4a §3.9：过长也答这个码）；`INACTIVE_ORG_MEMBER` 用 M4 的同一条；`HAS_CHILDREN` / `TASK_BUSY` 用 M3 的。各区的 404 各有一句，写在各自的小节里：G1 §4.1、里程碑 §4.2、重复 §4.3、依赖 §4.5、字段取值 §4.6、附件 §4.7（PR-4b 假设）、字段对话框 §4.8；每句都按 PR-4a §3.0 的折叠口径并列可能的原因、不判断是哪一个，并在 §9.1 对应的 spec 行里按原文钉住。未知码回退「操作失败，请稍后重试」（`codeMessage` 的既有回退）。PR-4b / PR-4c 的码在它们冻结后补表（§12）。

---

## 7. 无障碍（键盘与焦点）

- **原生控件优先**：所有新控件是 `button` / `input` / `select` / `textarea`，各有 `label`；多选的复选框组与单选组用 `fieldset` + `legend`；状态型开关用 `aria-pressed` 的按钮（里程碑、绑定显隐），文案固定、状态只由 `aria-pressed` 表达；折叠区用 `aria-expanded`。
- **区内错误** `role="alert"`，紧挨引发它的控件；异步结果（已保存、已添加、已移到第 N 位、上传中、下载失败）走每区一个 `aria-live="polite"` 区。
- **两步确认与就地切换**（M4 `[fe-49]` / `[fe-50]`，共用 `tasksFocus.ts#focusAfterSwap`，同一控件出现在多行时带行键 `data-dep-id` / `data-field-id` / `data-attachment-id`）：
  - 两步确认（G1、系列删除既有、附件移除、解绑、删定义）：打开 ⇒ 焦点到确认按钮，确认按钮由提示句描述（`aria-describedby`），提示句带 `role="status"`，出现时即被播报；取消 ⇒ 回到换回来的按钮。
  - 就地编辑器与面板：重复编辑器（打开 ⇒ 频率 `select`；放弃 ⇒「编辑重复规则」按钮，按钮不在 ⇒ 区标题，§4.3）；字段取值编辑器（打开 ⇒ 该型第一个控件；取消 ⇒ 同一行的「编辑」，§4.6）；依赖搜索面板（打开 ⇒ 搜索输入框；「关闭」⇒ 打开它的「添加前置」/「添加后置」，§4.5）；字段对话框的新建与编辑定义子表单（打开 ⇒ 第一个输入；取消 ⇒ 打开按钮，§4.8）。
  - 不新增 Esc 取消：M4 `[fe-50]` 对就地表单不加 Esc，统一与否在 M4 前端 §12-Q35；对话框的 Esc 仍关闭整个对话框。
- **写后焦点**（`[fe5-16]`）：M5 的写都会重拉详情（或在 pending 期间禁用控件），详情块卸载重建，浏览器把焦点留在 `body`。执行器在第 ③ 步记下发起写的控件（`data-testid` 与行键），在 `finally` 里不论结果——成功、带重拉的失败（`DUE_REQUIRED`、`NOT_CURRENT_OCCURRENCE`、`DUPLICATE`、`NOT_IN_OPTIONS`、各区 404）、不带重拉的失败——都恢复焦点（§4.0）：错误落在某个仍在、未禁用的控件旁 ⇒ 给那个控件；否则还给记下的控件（仍在且未禁用）；控件已不在或被禁用（删边、解绑、移除、`DUE_REQUIRED` 后整个编辑器禁用，或重拉后失去编辑权）⇒ 给本区标题（`<h3 tabindex="-1">`）；G1 按钮的回退是同一行的「完成」/「重启」按钮（§4.0）。只作用于 M5 的区；M3 / M4 的区仍是 M4 前端 §12-Q35 的已知问题，不在本件改。
- **键盘可达**：重复编辑器全是原生控件；候选面板的搜索表单 Enter 提交，结果行的「添加」是按钮；字段调序用上移 / 下移按钮（不提供拖拽，`[fe5-31]`）；对话框的 Tab 回绕与 Esc 照 M4（`[fe-12]`）。不新增快捷键。
- **逐行按钮的名字**：同一列表里重复出现的按钮都带含行名的 `aria-label`（§4.0、§8 的 `…Named` 格式函数），读屏用户不会听到五个一样的「移除，按钮」；删边是单步的（`[fe5-15]`），这一条尤其要紧。
- **非颜色表达**：里程碑徽标有文字；选项颜色只作装饰，标签文字始终显示。

---

## 8. 文案与 i18n

- 全部新文案进 `labels.ts`（`TASKS_ZH` / `TASKS_EN` / 格式函数表），照 M4 前端 §9.1 的形状；码表 `TASKS_CODE_KEYS`（`:684`）加 §6 的码，按落点读的码（`LIMIT`、`INVALID_NAME`）不进全局码表，由调用点取各自的键。
- 格式函数：重复摘要（频率、间隔、周几、每月第几日 / 最后一天、结束方式）、「共 N 次（含第一期）」、「已移到第 N 位」、附件大小、码点计数。周几的名字来自文案表（不调用 `Intl`）。
- 逐行按钮的 `…Named` 格式函数（照 M4 `listRemoveTaskNamed` / `groupsMoveUpNamed` 的形状，ZH 与 EN 两表都加）：`depRemovePredecessorNamed` / `depRemoveSuccessorNamed`、`depAddPredecessorNamed` / `depAddSuccessorNamed`（任务标题）；`attachmentDownloadNamed`、`attachmentRemoveNamed`、`commentAttachmentRemoveNamed`（附件显示名）；`fieldValueEditNamed`、`fieldValueClearNamed`、`fieldMoveUpNamed`、`fieldMoveDownNamed`、`fieldHideNamed`、`fieldUnbindNamed`、`fieldEditDefinitionNamed`、`fieldBindNamed`、`fieldDeleteNamed`（字段名）。名字是暂定，实现时按 `labels.ts` 的既有命名对齐；`aria-label` 文本在 EN / ZH 扫描的覆盖之内。
- 用户内容（任务标题、字段名、选项标签、清单名、附件显示名）照原样显示，不进文案表。EN 扫描的夹具用 ASCII 的用户内容，避免把用户内容误判为未翻译。
- `tasks-labels.spec.ts` 的扫描（M4 前端 §9.3 的五组）把 M5 的各区、字段对话框与面板加进 EN 零 CJK / ZH 有 CJK 的渲染扫描，键对齐与码表两语非空照旧。

---

## 9. 测试计划

### 9.1 spec 文件（8 个新文件 + 1 个既有文件加格）

全部 mock `apiFetch` 或 `tasksApi`（PR-4a 路由未建，与 M3 / M4 同一做法）；mount 用真实 `createRouter` / `createMemoryHistory`。每个新 spec 头注写清 mock 面与「PR-4a 未实现 / PR-4b、PR-4c 未冻结」。

| 文件 | 切片 | 格（摘要） | 变异目标（改坏源码后必须有格变红） |
|---|---|---|---|
| `tasks-api-m5.spec.ts` | FE-d0 | §3.2 每个函数的方法 / 路径 / 请求体 / `encodeURIComponent`（逐函数一行表）；每个契约码 → kind；网络失败 ⇒ `error` 且 `status: 0`；每个路径段位置的空串、`.`、`..` ⇒ 不发请求、返回规定 kind；`completeTask(id)` 的请求与今天逐字节相同（不带体）、`completeTask(id, 'all')` 恰带 `{"scope":"all"}`；详情四组：每组缺失 ⇒ 解析成功且不带键，组内缺一 ⇒ `error`，各键错型 ⇒ `error`（`DepItem` 的 `status` 闭集外、`canRemove` 非布尔；`fieldValues` 的 `type` 闭集外、`hidden` 非布尔、`value` 与类型不符；`recurrence` 带闭集外的键或越界值；周几乱序的规则照常解析）；选项 id 不在 `config` 里的取值照常解析；`deletedIds` 缺失通过、首项不等于 `id` ⇒ `error`；`isTaskListItem` 对 `is_milestone` 的三种（缺、布尔、字符串）；绑定读的 `{ items }` 无 `total` 解析成功；`GET /api/task-fields` 的降级体 ⇒ `org_missing`；三个纯模块每条规则的正反例（weekly 无周几、monthly 带周几、`byMonthDay` 32、`end` 两键、`count` 0 与 366、`until` 2031-02-30；text 2000 / 2001 码点含 emoji、`maxLength`；number `1e15`、`NaN`、字符串数字；multiSelect 去重与旧 id 去除；member 的 id 50 个字符通过、51 个字符 ⇒ `INVALID_VALUE`；date 闰年；选项标签大小写重复、颜色 `#12345`；`buildFieldPatch` 不带 `type`、带整份选项与已有 id） | 去掉任一 `isPathSafeSegment` 调用 ⇒ 该函数的三格红；`completeTask` 一律带体 ⇒ 逐字节格红；系列组接受部分键 ⇒ 部分组格红；`DepItem.canRemove` 不校验 ⇒ 错型格红；绑定读改用 `readCollection` ⇒ 无 `total` 格红；周几不排序 ⇒ 规范形格红；解析时因周几乱序拒绝整个详情 ⇒ 乱序格红；select 按标签比对 ⇒ 选项改名格红；`buildFieldPatch` 带出 `type` ⇒ 红；`deletedIds` 不校验首项 ⇒ 红；去掉成员 id 的长度检查 ⇒ 51 字符格红 |
| `tasks-detail-m5.spec.ts` | FE-d1 | 四组都缺的详情 ⇒ M5 各区都不渲染、请求序列与 M4 相同（正控：同一夹具带齐四组 ⇒ 各区都在）；G1：`canCompleteForAll` 真 / 假 / 缺三种的按钮显隐、两步确认与焦点、请求体、成功重拉且 `notifyTasksChanged` 恰一次、404 按 §4.1 的原句与重拉、确认提示句 `role="status"`、离开又回来的晚到结果只做副作用；里程碑：`aria-pressed` 随 props、按钮文案在两种状态下相同、写失败后按钮仍是服务端值、无编辑权只显示状态、404 按 §4.2 的原句；列表徽标：两份行模板逐元素相同（复用 `tasks-groups.spec.ts` 的比较方式）、清单页行、依赖项、`'true'` 字符串不显示；系列删除确认句只在系列任务上出现；一次一个：M5 写在途时 M3 的完成 / 删除与 M4 的保存禁用，反之亦然（两个方向各一格）；写后焦点：成功、带重拉的失败（取一个 404）与不带重拉的失败（取一个 `validation`）三种结果各一格，G1 成功后按钮消失 ⇒ 焦点到同一行的「重启」，控件仍在 ⇒ 回到它，控件已不在 ⇒ 区标题（模拟真实浏览器：pending 时把焦点移到 `body`）；编辑区有脏草稿时切里程碑 ⇒ 草稿仍在且提示（`[fe5-39]` 的钉） | G1 按钮改按 `canComplete` 或前端推断显示 ⇒ 红；去掉 G1 的确认 ⇒ 红；里程碑改成复选框且失败不复位 ⇒ 失败格红；按钮文案随状态切换 ⇒ 文案恒定格红；某个 M5 写绕过执行器直接调用 API ⇒ 互斥格红；焦点恢复只放在 `ok` 分支 ⇒ 两个失败结果的焦点格红；徽标改成真值判断 ⇒ 字符串格红；确认句对非系列也显示 ⇒ 红；执行器去掉焦点恢复 ⇒ 焦点格红 |
| `tasks-recurrence.spec.ts` | FE-d1 | 编辑器按频率切换控件；周几从周一排起、值仍 0..6；每月三种模式；结束三种；预检文案落在对应控件旁；与现值相同 ⇒ 提交禁用、不发；请求体是规范形（周几升序去重）；结束重复只在有规则、可编辑且 open 时出现；`DUE_REQUIRED` 的本地禁用与服务端码；`NOT_CURRENT_OCCURRENCE` 文案与重拉；`INVALID_RECURRENCE` 与 `LIMIT` 同一文案；草稿跨无关重拉存活并提示、路由边沿清空；摘要中英文各一组；有规则而截止日已清空的提示；无截止日时旁注是编辑器之前的 `role="status"` 且 `fieldset` 的 `aria-describedby` 指向它；打开编辑器 ⇒ 焦点在频率 `select`，放弃 ⇒ 焦点回到「编辑重复规则」；404 按 §4.3 的原句与重拉；`DUE_REQUIRED` 重拉后焦点不在 `body` | 预检不排序周几 ⇒ 「相同 ⇒ 禁用」格红；草稿放回子组件 ⇒ 存活格红；`end` 两键被接受 ⇒ 红；周日映射成 7 ⇒ 请求体格红；结束重复在已完成任务上显示 ⇒ 红；去掉打开 / 放弃的 `focusAfterSwap` ⇒ 焦点格红 |
| `tasks-dependencies.spec.ts` | FE-d2 | 两列渲染与空态；`canRemove` 决定移除按钮；删边按方向走对的路径；加边面板的方向固定、请求串（`direction`、`q` 编码、`limit`、`offset`、空 `q` 不带）、结果的「添加」请求体恰一个键；`SELF` / `DUPLICATE` / `CYCLE` / `LIMIT` 文案、`DUPLICATE` 重拉；404 按 §4.5 的原句与重拉；候选读的 `not_found` / `error`；候选零条 ⇒ 空态节点、读失败 ⇒ 错误节点，两者不同形（各自的 `data-testid`，错误时不出空态文案）；「移除」与「添加」的 `aria-label` 带行的任务标题（两行标题不同 ⇒ 两个名字不同）；打开面板 ⇒ 焦点在搜索输入框，「关闭」⇒ 面板收起、焦点回到打开它的按钮；加载更多与去重；新提交使在途结果作废（旧结果后到被丢弃）；`q` 超过 200 字符本地拦下、不发；面板在无关重拉后收起（接受的代价，钉住现状）；一次一个；写后焦点 | 加边体带两个键 ⇒ 红；方向与路径对调 ⇒ 红；无视 `canRemove` ⇒ 红；去掉候选的 generation ⇒ 晚到格红；`q` 不编码 ⇒ 红；`aria-label` 去掉标题 ⇒ 名字格红；去掉打开 / 关闭的 `focusAfterSwap` ⇒ 焦点格红；读失败渲染成空态 ⇒ 空 / 错格红 |
| `tasks-field-values.spec.ts` | FE-d3 | 分组与组名（名字 / id 回退）；空数组不渲染；隐藏字段在折叠区且可编辑；六型显示（含 `decimals`、`percent`、已删除的选项、`null`）；`canEdit` 为假无编辑按钮；一次只编辑一个；六型编辑器与预检码落点；清空发 `null`；请求体 `{ fieldId, value }`；未改动 ⇒ 不发；多选去掉旧 id 并提示；`NOT_IN_OPTIONS` / 404 重拉（404 按 §4.6 的原句）、其余保留草稿；「编辑」「清空」的 `aria-label` 带字段名；点「编辑」⇒ 焦点在该型第一个控件，「取消」⇒ 焦点回到同一行（同一组）的「编辑」；`INACTIVE_ORG_MEMBER` 文案；草稿跨重拉存活；同一字段在两组里只在一组展开编辑器；不通知红点 | select 按标签比对 ⇒ 已删除选项格红；多选把旧 id 发出 ⇒ 红；number 以字符串发 ⇒ 红；草稿放回子组件 ⇒ 存活格红；`canEdit` 为假仍显示编辑 ⇒ 红；隐藏字段被丢掉 ⇒ 红；`aria-label` 去掉字段名 ⇒ 名字格红；去掉打开 / 取消的 `focusAfterSwap` ⇒ 焦点格红 |
| `tasks-attachments.spec.ts` | FE-d4 | 能力键缺失 ⇒ 不渲染、零附件请求（正控：键在 ⇒ 恰一次列表读）；列表四态；本地预检（类型、扩展名、大小、个数）不过 ⇒ 不发；上传的 `FormData` 恰一个文件；成功只重读列表；`canRemove` 决定移除；移除两步确认；下载经 `apiFetch` 取字节、`<a download>` 的文件名、从不赋值 `location` 或打开新窗口；404 / 410 / 503 文案；评论暂存附件随评论提交带 `attachmentIds`；暂存行可移除、移除后的提交体不含被移除的 id、移除不发请求；「下载」「移除」与暂存行「移除」的 `aria-label` 带文件名；404 按 §4.7 的原句；列表的空态与读失败不同形；不带附件时 `createComment` 的请求体逐字节同今天；一次一个 | 下载改成导航到 URL ⇒ 红；`createComment` 一律带 `attachmentIds: []` ⇒ 逐字节格红；无能力键也渲染 ⇒ 零请求格红；跳过本地预检 ⇒ 「不发」格红；暂存移除不从提交体去掉 ⇒ 暂存格红 |
| `tasks-list-fields.spec.ts` | FE-e1 | 入口对三种角色都在；只读成员无写控件；对话框 a11y（`role`、`aria-modal`、焦点到标题、Esc、焦点归还、Tab 回绕、写进行中不可关）；调序请求体与响应替换、焦点保持、`aria-live` 文案；显隐（`aria-pressed` 随状态、文案恒定）；解绑确认与重读；绑定已有字段（排除已绑定的）；新建并绑定两步顺序与第二步失败的文案；改定义的 `PATCH` 体（无 `type`、整份选项、已有 id 保留）；未改动 ⇒ 提交禁用；删定义只对自己建的出现、当前用户 id 未解析时隐藏；`INVALID_BINDING` 重读；`FIELD_IN_USE` 重读的是选择器（`listTaskFields` 恰多一次、绑定读不多读）；404 横幅按 §4.8 的原句并请页面重读清单；`org_missing` 降级体；绑定读与选择器各自的空态与读失败不同形、读失败不关闭对话框；绑定行与选择器行上每个按钮的 `aria-label` 带字段名；新建 / 编辑定义子表单打开 ⇒ 焦点在第一个输入，取消 ⇒ 焦点回到打开按钮；解绑与删定义的提示句 `role="status"` | `PATCH` 带出 `type` ⇒ 红；改定义时丢掉选项 id ⇒ 选项改名格红；下标用服务端 `position` 算 ⇒ 红；不用响应替换顺序 ⇒ 红；删定义对别人建的也显示 ⇒ 红；Esc 不关 ⇒ 红；`FIELD_IN_USE` 改成重读绑定 ⇒ 选择器格红；`aria-label` 去掉字段名 ⇒ 名字格红；去掉子表单的 `focusAfterSwap` ⇒ 焦点格红 |
| `tasks-list-projection.spec.ts` | FE-e2 | 挂载零请求（正控：展开恰一次状态读）；404 ⇒ 未启用；状态读 `forbidden` 与 `error` 各自的节点，读失败不显示「未启用」或「尚未开启」；未开启时按角色与归档决定开启按钮；开启请求与响应渲染；三个深链的路径与编码；不安全的段不出链接；导出请求、文件名两种来源、字节原样交给下载；导出失败文案；与页面其他写互斥 | 挂载即读 ⇒ 零请求格红；读失败渲染成「未启用」⇒ 错误格红；链接不编码 ⇒ 红；只读成员看到开启按钮 ⇒ 红；改写导出字节 ⇒ 原样格红 |
| `tasks-labels.spec.ts`（既有，加格） | 各片 | 新区、对话框与面板加进 EN / ZH 渲染扫描；新格式函数的三条（ZH 有 CJK、EN 无、两者不同） | 模板里硬编码一处中文 ⇒ EN 扫描红 |

**静态格**（放在 `tasks-detail-m5.spec.ts`）：`TaskDetailMilestone.vue`、`TaskDetailRecurrence.vue`、`TaskDetailDependencies.vue`、`TaskDetailFieldValues.vue`、`TaskAttachments.vue` 的源文本不 import `tasksApi` 的任何写函数（`TaskDetailDependencies.vue` 只允许候选读，`TaskAttachments.vue` 只允许下载读）；扫描器自带正控（对 `TasksView.vue` 必命中）。

### 9.2 既有 spec 的连带修复（只加 mock，不改断言）

M5 的每个新区都以详情键组或能力键的出现为渲染前提，清单页的面板展开才读，所以既有夹具下 `TasksView` 与 `TaskListView` 不调用任何新函数、不发任何新请求。挂载 `TasksView` 且用显式对象工厂 mock `tasksApi` 的六个文件（全显式的 `tasks-view`、`tasks-list-view`、`tasks-detail-view`、`tasks-view-transitions`，部分显式的 `tasks-detail-m3` 与 `tasks-labels`）因此预计不需要补条目，FE-d1 的 head 上实跑这六个文件确认（文档阶段无法验证）；其余挂载它们的 spec 展开真实模块、只 mock `apiFetch`，新函数存在但不被调用。若实现中仍有哪个文件抛出 `No "xxx" export is defined on the mock`，只补一个空转的 `vi.fn` 条目，断言不改，并在验证 MD 里逐个列出（M4 前端 §9.4 的口径）。

### 9.3 变异纪律

照 M4 验证 MD：审阅后对每个新守卫做一轮变异（先 `cp` 备份、改坏、跑该 spec、还原、`cmp` 核对），结果写进 M5 前端验证 MD；等价变异单独标明。至少覆盖 §9.1 最右列全部条目。

### 9.4 登记（门 21 / 22；三处同 PR）

今天（`906840c74c`）：必跑脚本 `exec npx vitest run` 续行块（`:1505` 起）里的任务 token 是 23 个（`:1946-1968`）；`.tokens` 清单 586 个；`tasks-web-guard.yml` 的 step 是 24 个 whole-file 参数（注释在 `:208`）。G2-core 可能先加 spec，所以下面一律写增量：

1. **`run-required-web-tests.sh`**：每片把自己的新文件插进 token 块，保持 `LC_ALL=C` 字节序（`-` 先于 `.`，所以 `tasks-api-m5.spec.ts` 在 `tasks-api.spec.ts` 之前）。八个新文件全部登记后，任务 token 比实现当日 head 多 8 个。每个新 token 跑锁 §5.3 的两条碰撞检查并把输出写进 PR body（今天对八个名字的正向计数都是 0，建文件后应为 1；`apps/web/verification/` 命中为 0）。
2. **`.tokens`**：不手改，跑 `node scripts/ops/required-web-lane-token-manifest.mjs --write`；不带 `--write` 是检查模式；`required-web-lane-token-manifest-guard.test.ts` 守着它。
3. **`tasks-web-guard.yml`**：step 逐文件追加 `tests/tasks-….spec.ts`（cwd 是 `apps/web`，不加前缀、不用 glob），注释的参数个数随之改（八个全部登记后比当日多 8）；`on.paths` 不改（`apps/web/src/tasks/**`、`apps/web/src/views/tasks/**`、`apps/web/tests/tasks*.spec.ts` 已覆盖）。头注的 M5 段只写裸文件名，不得出现 `vitest run` 字样，也不得出现 `tests/tasks….spec.ts` 形式的路径（门 21 的 G() 会把头注命中算进去，M4 前端 §10.3 ③ 的同一约束）。

每片结束跑 D = T = G（锁门 21 的三条命令，M4 前端 §10.3 有原样）；每片只登记自己新增的文件，切片结束时三集合必须已相等。

### 9.5 每片的绿线

`pnpm --filter @metasheet/web exec vitest run tests/App.spec.ts tests/tasks-*.spec.ts --reporter=verbose`（本地可用 glob；CI 的 step 必须逐文件）、`pnpm --filter @metasheet/web run type-check`、token 清单检查模式、清单单测、D = T = G；收集用例数从 verbose 日志读出写进验证 MD（零收集的绿无效）。收口片另跑一次完整的必跑脚本。

### 9.6 门行

- **门 21**：每个新 `tasks*.spec.ts` 进 D、T、G，step 逐文件。候选行键 `M5|21|新表面`（照 `M4|21|新表面` 的形状）。
- **门 22**：本件不新增路由（`[fe5-01]`），没有 M5 子集；既有任务路由的门 22 格（`M2|22|整门` 与 `M4|22|新表面`）照旧在最终 head 上重跑。
- **载体**：`arm-set` 今天没有 `M5|21` 行。S31 定的是 M5-g 进既有门的 M5 子集行；PR-4a §7.3 要求 27–32 一次写齐、自检改为 `range(1,33)`。`M5|21|新表面` 应随同一次锁修订写入（§11-Q7）；写入之前是候选、NOT RUN、不计分，不得写成门已通过。
- FE-f 的 spec 不以 `tasks` 开头（`[fe5-40]`），否则门 21 的 D 集合会把它收进来、要求登记到 `tasks-web-guard`；它走 `multitable-web-guard` 与必跑脚本。

### 9.7 真机

- PR-4a 路由在其分支建成后：本地起该分支后端（`TASKS_ENABLED=true`、迁移只应用到一次性库），跑 G1、里程碑、重复设置与派生、系列删除、依赖、字段取值与字段对话框。PR-4b、PR-4c 建成后补附件与面板。每项在验证 MD 里记「跑过 / NOT RUN」，不写成已验证。
- staging / 生产不触达。

---

## 10. 标签全表

### 10.1 本件自选（`ASSUMPTION(task-m5-fe): [fe5-NN]`；缺省即本文取值）

| 编号 | 取舍 | 缺省 | 备选与代价 |
|---|---|---|---|
| fe5-01 | 路由 | 不新增；字段定义在清单页对话框里管理 | 加 `/tasks/fields` 页：门 22 多一组格、多一条入口，内容与对话框重复 |
| fe5-02 | 详情页 M5 区的状态与写 | 子组件无状态、只 emit；`TasksView` 一个执行器跑全部 M5 写；草稿在一个容器里 | 照 M4 每个写一个完整 handler：`TasksView` 多约 300 行重复代码；子组件自己发写请求：做不到与 M3 / M4 互斥（M4 前端 §4.0） |
| fe5-03 | 详情 M5 键的解析 | 按 PR-4a 切片分四组，组缺失即不渲染，部分即 `error` | 逐键独立可选：部分键的畸形体会被当成合法，渲染出半个区 |
| fe5-04 | G1 的请求形 | 缺省不带体，只有 `'all'` 带体 | 总带 `{ scope }`：改变今天的请求，`tasks-api.spec.ts` 等既有格要改断言 |
| fe5-05 | G1 按钮 | 只看 `canCompleteForAll`；两步确认 | 前端按角色推断：与服务端判定分叉；不确认：误触即替所有人完成 |
| fe5-06 | 里程碑控件（绑定显隐同规则） | `aria-pressed` 切换按钮，文案固定，状态只由 `aria-pressed` 表达 | 复选框：写失败时要手工把 DOM 复位；文案随状态变的按钮：去掉 `aria-pressed`，否则读屏读出相反的组合 |
| fe5-07 | 列表行里程碑 | `listTasks` 不改，渲染只认 `=== true`；清单任务项读严格校验 | 在 `listTasks` 里逐行校验：与 G2-core 改同一函数，且改变 M2 的解析面 |
| fe5-08 | 重复编辑器 | 本地预检镜像 #6249；相同即禁用；无截止日禁用；结束重复只在有规则、可编辑且 open 时显示 | 不预检：多一次往返，错误体又没有字段名；结束重复总显示：已完成的期点了必然 422 |
| fe5-09 | 周几的显示顺序 | 从周一排起，值 0..6 不变 | 从周日排起（与取值一致）：与中文用户习惯不同 |
| fe5-10 | `count` / `until` 的文案 | 写明含第一期、含当天（跟 #6249 的自选） | 不写：用户算错系列长度 |
| fe5-11 | 系列导航 | 首期、上一期、下一期三个链接，不预取 | 不显示首期 / 上一期（它们不按 `view` 过滤）：系列导航断开 |
| fe5-12 | 系列删除 | 确认句加一句；`deletedIds` 只校验不展示 | 删后展示删除了几期：需要跨路由带状态，`/tasks` 页多一个提示块 |
| fe5-13 | 依赖读 | 不建函数，用详情里的数组 | 建：多一个只有 spec 调用的函数 |
| fe5-14 | 依赖候选 | 显式提交搜索；状态在子组件内，无关重拉时丢失；第一页 + 加载更多；面板有「关闭」按钮，不加 Esc | 输入即搜：要防抖计时器与更多格；状态放父组件：`TasksView` 再多一份读状态 |
| fe5-15 | 删依赖边 | 不确认 | 两步确认：与删负责人不一致，多一步 |
| fe5-16 | M5 区的写后焦点 | 不论成功或失败（含重拉的失败）都恢复：错误旁的控件优先，其次同一控件，不在则给区标题；M3 / M4 区不改 | 不处理：键盘用户每次写后从页首重找（M4 前端 §12-Q35 的现状） |
| fe5-17 | 字段取值的编辑 | 一次一个字段；草稿在容器里，跨重拉保留 | 整区一次编辑多字段：要批量接口（PR-4a `[a-13]` 是一次一个） |
| fe5-18 | 隐藏绑定的字段在详情里 | 收进每组的折叠区，可编辑 | 不显示：所有绑定都隐藏的字段在详情里无处可改 |
| fe5-19 | 已删除的选项 id | 显示「已删除的选项」；多选写入时去掉并提示 | 原样发回：必然 422 `NOT_IN_OPTIONS` |
| fe5-20 | 数值显示 | `toFixed(decimals)`，不分组；`percent` 只加 `%`，不乘 100 | 乘 100：要与 PR-4c 投影的读法一致才行（§11-Q4） |
| fe5-21 | 成员型取值的输入 | 用户 id 输入框（沿用 M3 / M4） | 人员选择器：新组件与新读接口，不在 M5 |
| fe5-22 | 字段分组的清单名 | 取父组件已有的「我的清单」读，取不到显示 id | 另读清单：多一次请求 |
| fe5-23 | 附件区的渲染前提 | 详情里的 PR-4b 能力键；缺失则不渲染、不读 | 总读附件列表、404 视为未启用：每次进详情多一次请求，既有 spec 要补 mock |
| fe5-24 | 附件列表读的归属 | `TasksView` 持有，进入详情与附件 / 评论写后读 | 子组件自读：随详情块重建重复发读 |
| fe5-25 | 附件下载 | 认证请求取字节后下载，不预览 | 图片内联预览：要处理对象 URL 的生命周期，并与服务端只给附件下载的头相左 |
| fe5-26 | 移除附件 | 两步确认 | 不确认：误删后只能重新上传 |
| fe5-27 | 评论附件 | 暂存随评论草稿放在 `TasksView`，每行可在提交前移除（只从草稿拿掉）；评论级附件只在附件区出现 | 在评论行里显示：要改 M3 的评论行与 `Comment` 解析 |
| fe5-28 | 附件本地预检 | MIME 与扩展名、大小、个数 | 不预检：大文件传完才被拒 |
| fe5-29 | 字段对话框的入口 | 所有成员可见，只读成员无写控件 | 只对 edit / owner 显示：只读成员看不到本清单绑定了哪些字段 |
| fe5-30 | 新建并绑定 | 一个手势两个请求，第二步失败留在选择器里；偏离 M4 `[fe-05]`（每个手势恰一条请求），代价是可能留下一个未绑定的 org 级字段 | 分两个手势：用户要先建、再去选择器里找 |
| fe5-31 | 绑定调序 | 上移 / 下移按钮；用响应的整张顺序替换本地 | 拖拽：键盘替代仍要做；乐观更新：失败要回滚快照 |
| fe5-32 | 改定义的请求体 | 整份选项（带已有 id），从不带 `type` | 只发变更：服务端的 `config` 是整份替换 |
| fe5-33 | 删定义的入口 | 只在选择器里、自己建的字段上；两步确认 | 在绑定行上也给：有绑定时必然 `FIELD_IN_USE` |
| fe5-34 | 视图与导出面板 | 默认收起、展开时才读 | 挂载即读：每次进清单页多一次请求，既有 spec 的请求序列变 |
| fe5-35 | 深链 | 由 `viewIds` 的三个键生成，段先过校验 | 只给网格一个链接：看板与甘特要用户自己找 |
| fe5-36 | CSV 导出 | 认证请求取字节下载；文件名先取响应头 | 打开新窗口：带不上认证头 |
| fe5-37 | 开启投影的按钮 | edit / owner 且未归档 | 对归档清单也给：开启后只读，意义不大 |
| fe5-38 | `LIMIT` 的读法 | 按落点分七条 | 一条通用文案：用户不知道哪个上限到了 |
| fe5-39 | 编辑区的「服务端已更新」 | 沿用 M4：草稿为脏时任何重拉都提示 | 只在编辑区的键变了才提示：要改 M4 已钉的一格（§11-Q9） |
| fe5-40 | FE-f | 只定边界，详细设计另起；spec 不以 `tasks` 开头 | 现在就设计：依赖 PR-4c 的未冻结形状 |
| fe5-41 | 清单页任务行的字段列 | 不显示（在投影网格里看） | 显示：要为每行另读取值，清单项读没有这些列 |
| fe5-42 | M5 写的 404 | 区内文案 + 重拉 | 只出横幅（M3 的做法）：区里还留着已经无效的控件 |

### 10.2 照搬的冻结值与裁定（代码注释写法）

| 标签 | 内容 | 位置 |
|---|---|---|
| `[a-01]` `[a-02]` `[a-04]` `[a-05]` | G1：`scope` 严格解析（前端只发 `'all'`）；非创建人 404；`any` 模式与零负责人走与 `'self'` 相同的路径，这两种情形下详情的 `canCompleteForAll` 为假，按钮不出现 | `completeTask`、G1 区 |
| `[a-09]` `[a-13]` `[a-38]` | 清空发 `null`；一次一个字段；旧选项 id 照存值返回 | 字段区、`tasksFieldValues.ts` |
| `[a-10]` | M5 写（G1 除外）不动 `version` | §5 |
| `[a-12]` `[a-28]` `[a-34]` | 加边一个键、`canRemove`、看不见的对端不列、各读的排序 | 依赖区、客户端 |
| `[a-14]` `[a-32]` | 错误体只有码；本文命名的码 | 文案表 |
| `[a-17]` `[a-35]` | `nextOccurrenceId` 过滤，首期与上一期不过滤 | 系列导航 |
| `[a-27]` | 清空有规则任务的截止日不拒绝 | 重复区的提示 |
| `[a-42]` | 绑定位置是目标下标，响应整张顺序 | 字段对话框 |
| S13、S14、S17、S25–S28、S35（owner 2026-10-09） | 里程碑不要求截止日；重复规则闭集；结束重复的位置；六型与选项身份；三层权限；值随绑定可见；软限额；设规则的调用者 | 各区 |
| S04、S10、S18–S21、S36（owner 2026-10-09） | 投影显式开启；导出走任务线；附件白名单与上限、绑定模型、角色、下载规则；归档投影只读 | FE-d4、FE-e2 的依赖假设（§12） |
| `[fe-05]` `[fe-15]` `[fe-19]` `[fe-25]` `[fe-30]` `[fe-31]` `[fe-38]` `[fe-44]` `[fe-48]` `[fe-49]` `[fe-50]`（M4 前端） | 每个手势一条请求（`[fe5-30]` 偏离它）、父组件持状态、草稿合并、动态不读 payload、对话框写中不可关与焦点、读不 ok 不给写控件、调序后的焦点、404 重读清单、写后焦点、确认提示句 `role="status"`、就地切换的焦点 | 各区 |

---

## 11. owner 问题

### 11.1 本件的问题（每条附缺省）

1. **`TasksView.vue` 是否先拆**：M5 按 `[fe5-02]` 让它再长约 300 行（到约 2200）。接受，还是先做一张清理片（要重写 M4 前端 §2.3 列的六个守卫）。缺省：不拆，同 M4 前端 §12-Q1。
2. **M5 区的写后焦点**（`[fe5-16]`）：现在只对 M5 的区做，M3 / M4 的区留给 M4 前端 §12-Q35 统一处理，是否同意。缺省：同意。
3. **附件区的渲染前提**（`[fe5-23]`）：请 PR-4b 在附件开关打开时于详情里给出能力键（与每行的 `canRemove`），还是前端总读、把 404 当成未启用。缺省：请 PR-4b 给键。
4. **百分比的读法**（`[fe5-20]`）：存 25 显示 25%，还是存 0.25 显示 25%；必须与 PR-4c 投影一致。缺省：不乘 100。
5. **隐藏绑定的字段在详情里**（`[fe5-18]`）：折叠显示还是不显示。缺省：折叠显示。
6. **G1 是否先确认**（`[fe5-05]`）。缺省：确认。
7. **候选门行 `M5|21|新表面`**：是否随 PR-4a §7.3 的那次锁修订一起写入 `arm-set`（门 22 无 M5 子集）。缺省：同一次修订；写入前 NOT RUN。
8. **FE-f**（`[fe5-40]`）：同意 PR-4c 冻结后另起一份设计，走 `multitable-web-guard`。缺省：同意。
9. **编辑区「服务端已更新」**（`[fe5-39]`）：沿用 M4，还是收窄（要改 `tasks-detail-m4.spec.ts` 已钉的一格的断言）。缺省：沿用。
10. **删依赖边是否确认**（`[fe5-15]`）。缺省：不确认。
11. **字段对话框对只读成员**（`[fe5-29]`）：可见只读，还是不可见。缺省：可见只读。

### 11.2 PR-4a 已登记、本件不重问的项（只写前端影响）

| PR-4a 的项 | 前端影响 |
|---|---|
| §7.2 两条有上限的读不分页（S34 / E22，A / B） | 取 B（现行）：绑定读用专用解析器、不建依赖读；取 A：绑定读改 `readCollection` + `collectPages`，`tasks-api-m5.spec.ts` 改那几格；详情里的数组若也分页，依赖区加「加载更多」 |
| §7.2 评论绑定多写 `task_id`（S19，A / B） | 只影响 FE-d4 的暂存上传：取 B 时上传带任务 id（§12.1 B4） |
| §7.2 任务 E 问题 1（锚点） | 文案不写锚点规则；取 (c) 或 (iii) 若引入新的规则键，预检与编辑器加控件 |
| §7.2 任务 E 问题 3（`count` 越界的码） | 本地预检先挡 366；两种码同一文案 |
| §7.2 X3（候选排除会成环的任务） | 加边仍处理 `CYCLE`；取 A 时只是候选变多 |
| §7.4 Q1（待办显示里程碑） | 前端没有待办列表；红点不变 |
| §7.4 Q3（改定义与已存取值，`[a-38]`） | 取「拒绝」：删选项时多一个 422 文案；取「版本前置」：`PATCH` 多带一个字段、多一条 409 分支 |
| §7.4 Q4 / §7.3（候选门行入锁） | 与 §11.1-Q7 同一次修订 |
| `[a-01]`（complete 与 reopen 的 `scope` 严格程度不同） | 前端只发合法值，不受影响 |

---

## 12. 依赖假设与重核清单

### 12.1 PR-4b（附件）

| # | 假设（前端按它起草） | PR-4a 的依据 | 冻结后要核的点 |
|---|---|---|---|
| B1 | 附件开关打开时，详情带能力键（暂名 `canAttach`）；关闭时没有，附件路由不挂载 | §1.2（上传、下载、移除、评论绑定归 PR-4b）；§3.0（S30 ①：四个子功能不单独设开关，即附件与投影另有开关） | 键名、出现条件；开关关闭时评论带 `attachmentIds` 的答法 |
| B2 | 附件列表是单独的读，分页形 `{ items, total }`，项含 `id`、显示名、MIME、大小、`bindKind`、`commentId`、上传者、时刻、`canRemove` | §2.7 的列；§2.10 的 `TaskAttachmentRowForRemoval` | 路由、项键名、是否分页、`canRemove` 是否逐行给出 |
| B3 | 任务级上传 = 单文件 multipart，成功即已绑定 | §2.7 `task_attachments_task_kind_chk`（任务级上传即绑定） | 路由、字段名、成功体 |
| B4 | 评论附件先暂存上传得未绑定行，再随评论提交绑定；S19 取 B 时上传带任务 id；提交前从暂存里移除只改前端草稿，未绑定行留给过期清扫 | §2.7 `task_attachments_comment_kind_chk`；§7.2 S19 问题 | 上传路由与参数；`createComment` 的新键名；绑定失败的码；有没有删除未绑定附件的路由（有则暂存移除改为调用它） |
| B5 | 下载经认证请求取字节；不可见 404、已删或感染 410、存储不可用 503 | §2.10 `TaskAttachmentRowForDownload`（`status`、`boundAt`、`scanState`） | 路由、各状态码、文件名头 |
| B6 | 移除：上传者，或对任务有编辑权者移除任务级附件；评论级只有上传者 | §2.10 `TaskAttachmentRowForRemoval` | 路由；能力是否逐行给出 |
| B7 | 白名单七种 MIME、1 字节到 10 MiB；每任务、每评论的个数上限 | §2.7 `mime_type_chk`、`size_chk` | 个数上限的常量与码；扩展名规则 |
| B8 | 错误码 | — | 全部补进 §6 的表与 `labels.ts` |

### 12.2 PR-4c（投影与导出）

| # | 假设 | PR-4a 的依据 | 冻结后要核的点 |
|---|---|---|---|
| C1 | 显式开启：清单 edit / owner 调用开启接口，幂等，返回 `sheetId` 与三个视图 id | §2.9（S04：是否开启由投影 sheet 是否存在推导，PR-4c 不加列）；§1.2 | 路由、方法、成功体、归档清单能否开启 |
| C2 | 状态读对成员返回是否开启、`sheetId`、视图 id | 同上 | 键名；非成员与缺 org 的答法 |
| C3 | 视图 id 按 `grid` / `kanban` / `gantt` 三键给出 | §1.2（provisioning 归 PR-4c） | 键名与缺失时的补建 |
| C4 | CSV 导出是任务线自己的读（S10）；清单 `view` 即可导出（D11，`ASSUMPTION`） | §1.2（导出归 PR-4c）；§7.2 任务 E 问题 2、X2 只影响 PR-4c | 路由、权限、文件名头、时区说明是否需要前端文案 |
| C5 | 投影开关关闭时子路由不挂载（404） | §3.0（S30 ①） | 关闭时已开启的投影链接是否仍显示 |
| C6 | 数值字段的投影读法与前端显示一致 | §4.6（投影列的来源是 PR-4a 的表） | `percent` 的读法（§11.1-Q4） |

### 12.3 FE-f 的边界（不在本件实现）

- 改的是多维表线的 `MultitableWorkbench.vue`：当 sheet 是任务投影时，单元格与日期的写不走多维表写接口，改经任务 API（记录 id 由 `parseTaskProjectionRecordId` 拆出清单与任务，版本取投影记录里的副本），409 刷新投影后重试一次（S06、S08）。
- spec 不以 `tasks` 开头，登记在 `multitable-web-guard` 的 `paths` 与 step、必跑脚本与 token 清单；多维表文件里的注释只用任务投影这个本线名词，不点名其他线的符号（门 15；锁 §13-32 对 `KanbanView.vue` 的限制照旧）。
- 详细设计在 PR-4c 冻结后另起一份，届时按本节与 §12.2 重核。

---

## 13. 实现切片（顺序执行；每片结束绿线 + D = T = G）

| 片 | 文件 | 依赖 | 测试 / 登记 |
|---|---|---|---|
| **FE-d0 基座** | `tasksApi.ts` 追加 §3.2 的函数与解析器、详情四组、`TaskListItem` 可选键、`completeTask` / `deleteTask` 的扩展；新 `tasksRecurrence.ts`、`tasksFieldValues.ts`、`tasksFieldDefinition.ts`、`tasksDetailExtras.ts`；`labels.ts` 的码表与 FE-d 的文案 | 无（对冻结的 PR-4a） | 新 `tasks-api-m5.spec.ts`；`tasks-api.spec.ts`、`tasks-api-m3.spec.ts`、`tasks-api-m4.spec.ts` 不改；登记 +1 |
| **FE-d1 详情：G1、里程碑、重复与系列、系列删除、徽标** | `TasksView.vue`（执行器、容器、薄 handler、挂载点、两份行模板的徽标、删除确认句）；新 `TaskDetailMilestone.vue`、`TaskDetailRecurrence.vue`；`TaskListView.vue` 行插槽的徽标 | FE-d0 | 新 `tasks-detail-m5.spec.ts`、`tasks-recurrence.spec.ts`；labels 扫描加新区；登记 +2 |
| **FE-d2 依赖** | 新 `TaskDetailDependencies.vue`；`TasksView.vue` 两个 handler 与挂载点 | FE-d1 | 新 `tasks-dependencies.spec.ts`；登记 +1 |
| **FE-d3 字段取值** | 新 `TaskDetailFieldValues.vue`；`TasksView.vue` handler 与挂载点 | FE-d1 | 新 `tasks-field-values.spec.ts`；登记 +1 |
| **FE-e1 字段对话框** | 新 `TaskListFieldsDialog.vue`；`TaskListView.vue` 加入口与挂载 | 编码只依赖 FE-d0；合并要在 G2-core 合入之后（这是合并顺序，不是开工条件，§1.4） | 新 `tasks-list-fields.spec.ts`；登记 +1 |
| **FE-d4 附件** | 新 `TaskAttachments.vue`、`tasksAttachmentRules.ts`；`tasksApi.ts` 的附件函数与 `createComment` 的扩展；`TasksView.vue` 的列表读、handler、评论撰写区的暂存 | FE-d1；PR-4b 冻结且 §12.1 已重核 | 新 `tasks-attachments.spec.ts`；登记 +1 |
| **FE-e2 视图与导出面板** | 新 `TaskListProjectionPanel.vue`；`tasksApi.ts` 的投影与导出函数；`TaskListView.vue` 挂载 | FE-e1；PR-4c 冻结且 §12.2 已重核 | 新 `tasks-list-projection.spec.ts`；登记 +1 |
| **FE-z 收口** | 验证 MD（`docs/development/task-m5-frontend-verification-<date>.md`）、`tasks-web-guard.yml` 头注的 M5 段、PR body | 以上各片 | 全量变异轮（§9.3）；§9.7 真机项逐条记跑过 / NOT RUN；完整必跑脚本、清单检查模式与单测；字面扫描器对全部新改文件退出 0；PR body 写明 Draft、依赖与合并序、候选门行未计分、不触达 staging / 生产 |

- FE-d2、FE-d3 互不依赖，可并行（都只在 `TasksView.vue` 加挂载点与 handler，冲突可解）。FE-e1 的编码只依赖 FE-d0，可与 FE-d1…d3 并行；它与 FE-e2 的合并都排在 G2-core 之后。
- 任何一片发现与 PR-4a 冻结稿不同（PR-4a 改了形状），先改本文再改实现，验证 MD 记录偏差（PR-4a 自己的规则：要改形状先改设计）。

---

## 14. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | PR-4a 未实现，契约落地时形状可能再变 | 解析器集中在 `tasksApi.ts`；按 PR-4a 的规则「先改设计再改实现」；真机项 NOT RUN 如实记录 |
| R2 | PR-4b / PR-4c 的形状与 §12 的假设不同 | 附件与面板排在最后，先重核再编码；依赖假设集中在两张表里 |
| R3 | `TasksView.vue` 继续增长 | 执行器与容器把增长压到约 300 行；§11-Q1 |
| R4 | 与 G2-core 的文本冲突（`tasksApi.ts`、`TasksView.vue` 行模板、`labels.ts`、登记块） | §1.4 的四点；后合的一方 rebase 后重跑全部任务 spec 与 D = T = G |
| R5 | 详情块重建导致的焦点丢失与草稿丢失 | 草稿与区内错误放父组件；`[fe5-16]` 的写后焦点；候选面板的丢失是登记过的代价 |
| R6 | 旧选项 id 与不在职成员让写入必败 | 显示「已删除的选项」、多选写入去掉旧 id；成员只能靠服务端 422 |
| R7 | 深链离开任务门 | 只在门内渲染；可读性由多维表侧夹钳决定（PR-4c） |
| R8 | 既有 spec 被新请求打破 | 所有新区以键组出现为前提、面板展开才读；§9.2 的只加 mock 口径 |
| R9 | 裁决原文泄露 | 只引编号与日期；每片跑字面扫描器 |

---

## 设计自查

1. 新入口与请求都在 #6173 的门内吗？——不新增路由与入口；新区只在任务页内渲染；深链离开任务门的事实写明（§2.1）。
2. 每个路径段都过 `isPathSafeSegment` 吗？——§3.1 列出全部位置；§9.1 每个位置三格，变异证红。
3. 错误码都映射到文案吗？——§6 一码一文案，`LIMIT` 与 `INVALID_NAME` 按落点分读，404 各区一句（写在 §4 各小节、在 spec 里按原句钉住）；客户端结果类型带不出的码（`INVALID_SCOPE`、`INVALID_DIRECTION`、`INVALID_FIELD_PATCH`）标为界面上不可达、只登记文案；PR-4b / 4c 的码在冻结后补。
4. 晚到结果与一次一个沿用 M3 / M4 吗？——执行器用同一个 token 与 pending；读各有 generation；两个方向的互斥格。
5. `window.confirm`？——无；G1、附件移除、解绑、删定义都是两步内联确认。
6. 无障碍？——§7：原生控件、`fieldset` / `legend`、`aria-pressed` / `aria-expanded`、确认与就地编辑器的打开 / 取消焦点、不论结果的写后焦点、逐行按钮带行名、读面的空与错可区分、对话框照 M4、调序的键盘替代。
7. M2–M4 行为不变吗？——键组缺失即不渲染、零新请求；`completeTask` 与 `createComment` 的默认请求逐字节不变；`listTasks` 不改；既有函数体只有 FE-d4 对评论提交 handler 的一处加法（§2.4）；既有 spec 只加 mock。
8. 版本与冲突？——§5：只有 G1 推进 `version`；编辑区沿用 M4；M5 草稿的合并规则；由别人引起的 422 一律重拉。
9. 登记三处与计数？——§9.4 写增量；头注约束重申；D = T = G 每片跑。
10. 未裁取值都标了吗？——`[fe5-NN]` 42 项在 §10.1；D 编号处处标 `ASSUMPTION`；照搬的冻结值标 `[a-NN]`。
11. 私有件？——只引编号与日期，不引原文；提交前跑三个扫描器。

---

## 15. 审阅处置（第 1 轮，2026-10-12）

一轮审阅提出 17 条（2 条 P2、7 条 P3、8 条 NIT；其中两对互为重复）。逐条对照 PR-4a 冻结稿 `7f1c4c536f`、M4 前端设计与 `origin/main` `906840c74c` 上的 M4 代码、任务 E `39a2a29be9` 核过后处置如下。本轮只改文本：不新增 `[fe5-NN]`（仍是 42 项，改动并入既有条目的缺省）、不新增 owner 问题（仍是 11 个），§0 的计数不变。

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P2 | 就地编辑器与依赖搜索面板没有打开 / 取消的焦点规则，面板也没有关闭控件 | 采纳：核过 M4 `[fe-50]` 与 `TaskDetailEditor.vue` 放弃后移焦到标题的实现。§7 第三条扩到全部就地切换；§4.3 重复编辑器（打开 ⇒ 频率 `select`，放弃 ⇒ 打开按钮或区标题，状态机两处）、§4.5 依赖面板（打开 ⇒ 搜索输入框，新增「关闭」按钮 ⇒ 回到打开它的按钮）、§4.6 字段编辑器（打开 ⇒ 第一个控件，取消 ⇒ 同一行的「编辑」）、§4.8 两个子表单（打开 ⇒ 第一个输入，取消 ⇒ 打开按钮）；四个 spec 行各加焦点格与变异目标；`[fe5-14]` 的缺省加「关闭」按钮。其中「面板内 Esc 关闭」一项不采纳：M4 `[fe-50]` 明确就地表单不加 Esc，是否统一在 M4 前端 §12-Q35，本件不单独开先例 |
| 2 | P2 | 逐行按钮没有带行名的可访问名 | 采纳：核过 M4 `listRemoveTaskNamed`、分组板与成员对话框的 `…Named` 先例。§4.0 加通用规则；§4.5 / §4.6 / §4.7 / §4.8 各行按钮写明 `aria-label` 的内容；§7 加一条；§8 列出 `…Named` 格式函数（ZH / EN 两表）；依赖、附件、字段取值、字段对话框四个 spec 行各加名字格与变异目标 |
| 3 | P3 | 设计钉在 PR-4a 的上一个提交，冻结 head 已前进 | 采纳：核过 `cdf7ddba87..7f1c4c536f` 只改 PR-4a 一个文件、只加 §8.5 的文字修订。基线改钉 `7f1c4c536f` 并说明 §8.5 不改形状；§3.2 的绑定排序改为「`position`，相同时按字段 id 字节序」，与 PR-4a §3.6 的冻结写法一致；§4.8 调序处补一句：发出的目标下标与服务端判空操作所比的现位置都取同一个 `GET` 顺序，所以显示下标即服务端当前下标 |
| 4 | NIT | `INVALID_SCOPE` 与 `INVALID_DIRECTION` 在客户端结果类型里带不出来，§6 却给了落点 | 采纳：核过 `completeTask` 对非 `ORG_MISSING` 的 422 只回 `{ kind: 'error', status: 422 }`。§6 两行改为「界面上不可达」、去掉落点，文案只登记；§6 表头补「界面上不可达」的定义；§4.1 补一句。不扩展 `CompleteTaskResult`：那会改一个既有类型，本件没有授权它的设计行 |
| 5 | NIT | 成员型取值的本地预检漏了每个 id 至多 50 个字符 | 采纳：核过任务 E `maxMemberIdChars` 与超长 id 答 `not_a_candidate`（经 PR-4a §3.7 映射为 `INACTIVE_ORG_MEMBER`）。§3.5 的成员规则加「每个 id ≤ 50 个字符，否则本地 `INVALID_VALUE`」；`tasks-api-m5.spec.ts` 加 50 / 51 字符的正反例与变异目标 |
| 6 | P3 | 写后焦点只覆盖成功路径 | 采纳：核过 M4 成员对话框 `beginWrite` 记下焦点、`endWrite` 不论结果都归还。§4.0 执行器改为第 ③ 步记下发起控件（`data-testid` 与行键），⑧ 里不论结果恢复；错误落在控件旁 ⇒ 焦点给该控件（`TaskDetailEditor.vue` 错误移焦的先例）；§7 第四条同步；`tasks-detail-m5.spec.ts` 加带重拉失败与不带重拉失败两格，`tasks-recurrence.spec.ts` 加 `DUE_REQUIRED` 一格；`[fe5-16]` 的缺省随之改写 |
| 7 | P3 | 新读面没有区分零条与读失败 | 采纳：核过 M4 前端 §4.0 的五态要求与 §5.2 成员读失败不关闭对话框的先例。§4.0 加读面规则；§4.5 候选面板、§4.7 附件列表、§4.8 绑定读与选择器、§4.9 投影状态读各写出 `loading` / `empty` / `error`（及适用的 `not_found` / `forbidden` / `org_missing`）的文案与 `data-testid`；依赖、附件、字段对话框、投影四个 spec 行加空 / 错格 |
| 8 | P3 | 「各区的 404 各有一句」只写了依赖区一句 | 采纳：按 PR-4a §3.0 的折叠口径（不存在、看不见与没有该能力合成一个 404），为 G1（§4.1）、里程碑（§4.2，原先没有 404 行）、重复（§4.3）、字段取值（§4.6）、附件（§4.7，PR-4b 假设）、字段对话框（§4.8）各写一句，并列可能的原因、不判断是哪一个；§6 末段改为逐节指向；各 spec 行改为「按原句」钉住 |
| 9 | P3 | 暂存的评论附件在发评论前无法撤回 | 采纳：§4.7 暂存列表每行加「移除」（只从 `detailExtras.commentAttachments` 拿掉，不发请求、不占互斥锁，焦点给下一行或「添加附件」）；PR-4b 若提供删除未绑定附件的路由再改为调用它，列为 §12.1 B4 的重核点；`[fe5-27]` 的缺省随之改写；附件 spec 行加「暂存行可移除、提交体不含被移除的 id」格与变异目标 |
| 10 | P3 | `FIELD_IN_USE` 的重拉对象是绑定，而码出自选择器 | 采纳：核过删定义只在选择器里出现、码表示字段仍绑在某个清单上。§6 表头与该行改为重读选择器的 `listTaskFields`；§4.8 失败段写明；字段对话框 spec 行加格与变异目标 |
| 11 | NIT | 「新建并绑定」偏离 M4 `[fe-05]` 而未注明 | 采纳：§4.8 与 `[fe5-30]` 写明偏离 `[fe-05]` 及代价（第二步失败留下一个未绑定的 org 级字段）；§10.2 的 M4 标签行加 `[fe-05]` |
| 12 | NIT | `INVALID_DIRECTION` / `INVALID_QUERY` 在客户端归 `error`，§6 却按码给候选面板文案 | 采纳：`INVALID_DIRECTION` 同第 4 条标为不可达；`INVALID_QUERY` 的落点改为「只由本地预检显示，服务端的码走『搜索失败』」；§4.5 候选读写明服务端的这几个码都走读失败那一句。不改为让候选读带码：多一种结果形状，换来的只是两个漂移码的文案 |
| 13 | NIT | 确认提示句缺 `role="status"`；禁用的重复编辑器旁注没有关联 | 采纳：核过 M4 `[fe-49]` 与成员对话框提示句的 `role="status"`。§7 与 §4.1、§4.8 的提示句加 `role="status"`；§4.3 的旁注改为放在编辑器之前的 `role="status"` 元素，`fieldset` 用 `aria-describedby` 指向它；§10.2 加 `[fe-49]`；相关 spec 行加格 |
| 14 | P3 | 与第 4 条重复（两个码没有可达的显示路径，行为格钉不住） | 与第 4 条一并处置 |
| 15 | NIT | 与第 3 条重复（钉点与排序措辞；另指出初稿提交信息也写着旧提交） | 正文与第 3 条一并处置；初稿提交不改写（共享树上不改历史），本轮提交的信息写新的钉点 |
| 16 | NIT | §1.4 第 2 条两份行模板的先后与行号对反了 | 采纳：核过 `TasksView.vue:442-462` 是「分配给我」的行插槽、`:464` 起是平铺 `<ul>`；括注改为先「分配给我」后平铺 |
| 17 | NIT | 多维表路由的 meta 不只有 `requiresAuth` | 采纳：核过 `multitableRoute.ts` 的 meta 还有 `title`；§2.1 改为「只有 `title` 与 `requiresAuth`」，结论（不带 `requiredFeature` / `permissions`）不变 |

拒绝的部分只有两处，都在上表里写明了理由：第 1 条中「面板内 Esc 关闭」一项，以及第 4 / 12 条备选做法中「扩展结果类型带码」一项。

同轮自查对上述改动又补了四处：写后焦点的第一条回退要求控件仍在且未禁用（`DUE_REQUIRED` 重拉后整个重复编辑器被禁用，焦点改落重复区标题）；G1 按钮不在任何新区里，记焦点时把它算进来，回退到同一行的「完成」/「重启」；同一字段出现在两组时，`focusAfterSwap` 的 root 取组容器、行键取 `data-field-id`；依赖组件补 `emit('reload')`。读失败只用 M4 既有的「……读取失败，请稍后重试」文案形状，不新增重试控件，所以不新增 `[fe5-NN]`。§4.3 旁注引用的分组板先例只核到 `role="status"` 的提示，`aria-describedby` 的关联是本件加的，文中已如此区分。
