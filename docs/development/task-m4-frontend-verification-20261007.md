# 任务功能 M4 前端验证记录（2026-10-07）

- 分支：`claude/tasks-m4-frontend`，基于 `main` `cc6ca96ac2`（已含 M3 前端 #6159 与 M3 后端 #6229）。**以 Draft PR 推送(不合并;须在 PR-3a 之后合并)。推送前按 head 的树把提交历史重建为单个提交,文中引用的提交号是重建前本地历史里的,只作溯源。** 设计文档：`task-m4-frontend-design-20261007.md`（DRAFT）。owner 已于 2026-10-07 裁定 M4 裁决包（FE-0 … FE-7 各节写于裁定之前或当天，那时的「未裁」字样保留原样）；已裁条目的标签自 FE-8 起写 `RULED(2026-10-07)`，其余仍是 `ASSUMPTION(task-m4-fe)`（设计 §11）。
- 本文按切片追加：每片一节，记基线、文件、命令与计数、变异表、与设计的偏差、NOT RUN、给下一片的说明；末尾是 FE-8 收口、闸审之后的修复、FE-c 按 PR-3c 的重核与全线汇总，汇总之后是 2026-10-09 的三节：修复轮、信号窗口逐条格、门 26 前端格按格名（七格）。**真实浏览器联调只有 FE-8 的一次本地走查（PR-3a 分支 + 一次性库，§FE-8.7）；staging、生产均未触达。**
- 环境：Node 20.20.2、vitest（`apps/web`）、`vue-tsc --noEmit -p tsconfig.app.json`。

---

## FE-0 文案基座（设计 §9、§13 FE-0；`R20` 取 (a)）

### 1. 基线复核

| 步骤 | 结果 |
|---|---|
| 起手前在 `cc6ca96ac2` 跑 14 个守卫（`tests/App.spec.ts` + 13 个 `tests/tasks-*.spec.ts`） | 14 文件 / 502 用例全绿 |
| 设计文档的本机路径 / 主机名 / 局域网地址扫描（入库前） | 0 命中 |
| 新 token `tasks-labels.spec.ts` 对 `.tokens` 清单 556 个既有 token 的双向子串碰撞 | 0 命中 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `4e414aca9d` | `docs/development/task-m4-frontend-design-20261007.md`：设计终稿入库，抬头记 DRAFT / owner 未裁 / Draft PR only / 后端依赖与 mock 边界 |
| `25f8aef59c` | FE-0 实现、五个既有 spec 的 `useLocale` mock、新 spec、三处登记 |
| 本文所在提交 | 本验证记录 |

### 3. 文件（`25f8aef59c`，13 个文件，+1430 / −136）

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/tasks/labels.ts` | +328（新） | `TASKS_ZH` / `TASKS_EN`（各 100 键，EN 以 `Record<keyof typeof ZH, string>` 定型）；`TASKS_FMT_ZH` / `TASKS_FMT_EN`（4 个格式函数：`completedAt`、`badgeUnavailable`、`badgeLoading`、`versionConflict`）；`TASKS_CODE_KEYS`（34 个契约码 → 键）与 `codeMessage(code, t)`；§9.2 / §5.3 全部错误码文案（M3 十条原文迁入 + PR-3a 的编辑 / 设置 / 清单 / 分组 / 成员码）；`LIMIT` 三个落点变体为独立键（`codeLimitMembers` / `codeLimitTaskLists` / `codeLimitGroups`），`codeMessage('LIMIT')` 保持 M3 口径 |
| `apps/web/src/views/tasks/TasksView.vue` | +110 / −114 | 模板全部中文字面值改读 `t.xxx` / `fmt.xxx(...)`（`VIEWS` 改 `labelKey`）；`CODE_MESSAGES` 表删除；六个 section 的行内错误 ref 改存契约码、模板经 `codeMessage(code, t)` 渲染（14 个赋值点各改一个 token）；`actionErrorMessage` 读表；两处日期格式化调用加 `viewerLocale` / `t`。中文字面值逐字不变（既有 spec 的 `.toBe` 断言全部原样通过） |
| `apps/web/src/tasks/TasksTodoBadge.vue` | +9 / −6 | 两个 `isZh` 三元迁入 `TASKS_FMT_*`（`badgeUnavailable` / `badgeLoading`），经 `computed` 取表；`ready` 态的 `${label}${count}` 不含文案，留在组件内 |
| `apps/web/src/tasks/tasksDateDisplay.ts` | +27 / −10 | `formatViewerInstant(value, timeZone?, locale = 'zh-CN')`；`formatDueDisplay(task, labels = TASKS_ZH, locale = 'zh-CN')`；缺省输出逐字不变（见偏差 1） |
| `apps/web/tests/tasks-labels.spec.ts` | +886（新） | 37 格：§9.3 五组 + `tasksDateDisplay` 参数格 + `TasksTodoBadge` 三态 + 挂载后翻转三格（详情页文案 / 行内错误 / 日期；列表页；红点） |
| `apps/web/tests/tasks-view.spec.ts`、`tasks-list-view.spec.ts`、`tasks-detail-view.spec.ts`、`tasks-view-transitions.spec.ts`、`tasks-detail-m3.spec.ts` | 各 +12 / −1 | 只加 `useLocale` mock（与 `tasks-badge.spec.ts` 同形，`isZh: ref(true)`）与 `ref` 导入；**断言零改动** |
| `apps/web/scripts/run-required-web-tests.sh` | +1（:1822） | `exec npx vitest run` 续行块插入 `tasks-labels.spec.ts`，位于 `tasks-detail-view.spec.ts`（:1821）与 `tasks-list-view.spec.ts`（:1823）之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1 | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（551 token） |
| `.github/workflows/tasks-web-guard.yml` | +8 / −1 | step 参数插入 `tests/tasks-labels.spec.ts`（:116，同序）；注释「Fourteen whole-file args」→「**Fifteen** whole-file args」（:105）；头注加 FE-0 一段（只写裸文件名，不含 `vitest run` 字样与 `tests/…` 路径，§10.3 ③ 的约束） |

### 4. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks-`（`apps/web`） | **15 文件 / 539 用例全绿**（502 既有 + 37 新） |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 0 错误 |
| D = T = G（设计 §10.3 三集合核对） | `D`=`T`=`G`=14 个 `tasks*.spec.ts`；yml 共 15 个 whole-file 参数（+`tests/App.spec.ts`） |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，551 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（`tasks-labels.spec.ts`） | 文件数 = 1；`verification/` 下 = 0 |
| 字面扫描器 v1（13 个改动文件 + 两份 MD） | 全部退出 0 |

每个 spec 文件的收集用例数（verbose 日志）：

| spec 文件 | 用例 |
|---|---|
| `App.spec.ts` | 11 |
| `tasks-api-m3.spec.ts` | 142 |
| `tasks-api.spec.ts` | 66 |
| `tasks-badge.spec.ts` | 25 |
| `tasks-context.spec.ts` | 17 |
| `tasks-detail-m3.spec.ts` | 104 |
| `tasks-detail-view.spec.ts` | 44 |
| `tasks-labels.spec.ts` | **37（新）** |
| `tasks-list-view.spec.ts` | 32 |
| `tasks-nav-badge.spec.ts` | 8 |
| `tasks-nav-feature-gate.spec.ts` | 15 |
| `tasks-nav-relogin.spec.ts` | 4 |
| `tasks-routes.spec.ts` | 13 |
| `tasks-view-transitions.spec.ts` | 14 |
| `tasks-view.spec.ts` | 7 |

### 5. 变异证据

每个变异按「备份 → 改坏 → 跑点名的 spec → 还原 → 逐字节比对」执行（脚本驱动，脚本不入库；不用 `git checkout --`）。13 个全部第一次就变红，13 个文件全部还原一致，变异后 `git status` 干净。

| # | 变异 | 文件 | 跑的 spec | 结果 |
|---|---|---|---|---|
| M1 | 删掉 EN 表的 `listEmpty` 键 | `labels.ts` | `tasks-labels` | 红（3）；另 `vue-tsc` 退出 2：`TS2741 Property 'listEmpty' is missing` |
| M2 | 改一条 ZH 字面值（`noDueDate` '无截止日期' → '没有截止日期'） | `labels.ts` | `tasks-labels`、`tasks-detail-view` | 红（4）：既有 `tasks-detail-view` 的两格与本片的缺省输出格同时红 |
| M3 | 某码两语文案相同（`codeInvalidParent` 的 EN 改成中文） | `labels.ts` | `tasks-labels` | 红（4） |
| M4 | `t` 改成 setup 时一次性求值（`ref`）而非 `computed` | `TasksView.vue` | `tasks-labels` | 红（2）：翻转格 |
| M5 | 模板硬编码一处中文（列表空态） | `TasksView.vue` | `tasks-labels`、`tasks-list-view` | 红（3）：EN 扫描与翻转格红，既有 `tasks-list-view` 仍绿（ZH 已钉） |
| M6 | 行内错误直接渲染 ref（`{{ parentError }}`）而不经 `codeMessage(code, t)` | `TasksView.vue` | `tasks-labels`、`tasks-detail-m3` | 红（4）：既有 M3 文案格与翻转格同时红 |
| M7 | `formatDueDisplay` 的 TIMED 分支不传 `locale` | `tasksDateDisplay.ts` | `tasks-labels` | 红（3） |
| M8 | `formatViewerInstant` 重新硬编码 `'zh-CN'` | `tasksDateDisplay.ts` | `tasks-labels` | 红（9） |
| M9 | 红点的 `fmt` 改一次性求值 | `TasksTodoBadge.vue` | `tasks-labels` | 红（1）：红点翻转格 |
| M10 | `codeMessage` 对未知码返回 `''` 而非回退文案 | `labels.ts` | `tasks-labels` | 红（2） |
| M11 | EN 的时区左括号改成全角 | `labels.ts` | `tasks-labels` | 红（4）：加宽 CJK 类命中 |
| M12 | 详情页 `formatDueDisplay` 不传 `t` / `viewerLocale` | `TasksView.vue` | `tasks-labels` | 红（7） |
| M13 | 把 `tasks-detail-view.spec.ts` 新加的 `useLocale` mock 再删掉 | `tasks-detail-view.spec.ts` | `tasks-detail-view` | 红（13）：jsdom 的 `navigator.language` 是 en-US，证明五文件补 mock 是必要的 |

### 6. 与设计的偏差 / 解释

1. **`formatDueDisplay` 加了两个参数而非一个**（设计 §9.1 写「加第二参 `labels`」）：TIMED 分支经 `Intl` 格式化需要 BCP-47 标签，而表里放不下 `'zh-CN'`（§9.3 要求每个 ZH 值含 CJK），所以签名是 `formatDueDisplay(task, labels = TASKS_ZH, locale = 'zh-CN')`；`formatViewerInstant` 按设计加第三参。两者缺省输出逐字不变（既有 `tasks-detail-view.spec.ts:322/:331/:344/:350/:354`、`tasks-list-view.spec.ts:150` 原样通过）。
2. **行内错误 ref 存契约码、渲染时映射**：设计只写「`CODE_MESSAGES` 变成 `codeMessage(code, t)`」，没写调用位置。若仍在 handler 里把文案存进 ref，挂载后翻转语言时行内错误会停在旧语言（M6 证明本片的格能抓到这一点）。改法是 14 个赋值点各改一个 token（`codeMessage(code)` → `code`）、六个 `<p>` 改 `{{ codeMessage(xxxError, t) }}`，M3 的行为与 DOM 输出不变。
3. **FMT 表本片只收 §9.2 点名的 `versionConflict`**（含版本号的 409 文案），§9.1 举例的「N / 20000」「已移到第 N 位」留给 FE-4 / FE-7 随各自视图加入。注意：计数器的 ZH 形式若写成 `${n} / 20000` 不含 CJK，过不了 §9.3 第 2 组，FE-4 要带一个 CJK 字（如「字」）。
4. **M4 错误码文案全部随本片进表**（S3–S8 的码，含尚未建成的 S5–S8 的码）：它们是 §9.2 逐条写明的值，纯数据，由键对齐 / CJK / `codeMessage` 三组格覆盖；视图接线留给各片。`[D14]` 的「10 个清单」在表内标 `ASSUMPTION(task-m4-fe)`。
5. **`codeMessage` 只认自有属性**：`'constructor'`、`'__proto__'` 等原型名按未知码回退（M3 的 `CODE_MESSAGES[code] ?? …` 没有这一层）。
6. **红点 `ready` 态的 `aria-label`（`${label}${count}`）不进表**：它没有文案，§9.1 只要求迁入 `isZh` 三元。
7. **`tasks-web-guard.yml` 的头注本片已加 FE-0 一段**（设计把头注 M4 段排在 FE-8）：只写裸文件名；加后 D = T = G 重跑仍相等。FE-8 在同一段续写即可。
8. **`tasks-labels.spec.ts` 的 `tasksApi` 工厂是显式对象**（`checkCommentBody` 用 `importActual`）：它是第六个会挂载 `TasksView` 的 spec，§9.4 的五文件表应把它算进去——FE-4 / FE-5 / FE-7 给工厂补条目时，本文件同样要补。
9. 设计文档正文里「只做设计，不改任何仓库文件」一句是设计稿对自身的描述，入库时保留原文；文件状态以新加的抬头为准。

### 7. NOT RUN

- 真机 / 浏览器：本片不改 API 调用与请求串，没有对 PR-3a 分支起后端联调（设计 §10.5 的真机项全部 NOT RUN）。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（设计 §10.4 排在 FE-8）；本片跑的是 15 个 whole-file 参数、manifest 检查模式与后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（`tsconfig.app.json` 只含 `src/**`，两个 verification 项目不含任务文件）。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 8. 给 FE-1 的说明

- 视图侧 idiom：`const { isZh } = useLocale()`、`const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))`、`const fmt = computed(...)`、`const viewerLocale = computed(() => (isZh.value ? 'zh-CN' : 'en-US'))`；模板 `t.xxx`、脚本 `t.value.xxx`。新视图照抄，并在 `tasks-labels.spec.ts` 的 EN / ZH 扫描与翻转组里各加一格（§9.3 (3)）。
- 加文案：两张表各加一键即可，键对齐 / CJK / 非空 / ZH≠EN 四格自动覆盖；加格式函数时必须同时在 spec 的 `FMT_ARGS` 表加一行固定实参（覆盖格会红）。
- 错误码：`codeMessage(code, t)`；`LIMIT` 在清单 / 分组 / 成员落点用 `t.codeLimitMembers` / `t.codeLimitTaskLists` / `t.codeLimitGroups`；`VERSION_CONFLICT` 用 `fmt.versionConflict(currentVersion)`（无版本号变体由 FE-4 自定）。
- 日期：`formatDueDisplay(task, t, viewerLocale)`、`formatViewerInstant(iso, undefined, viewerLocale)`；FE-1 导出 `resolveViewerTimeZone` 时不动这两个签名。
- 登记：新 token 按 `LC_ALL=C` 序插入（`tasks-api-m4.spec.ts` 在 `tasks-api.spec.ts` 之前）；yml 计数从 Fifteen 起每片 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。
- 本片新增的 mock 面：`tasks-labels.spec.ts` 的 `tasksApi` 工厂列了 M3 的全部函数 + `fetchPendingCount`；FE-1 若让 `TasksView` 新调用 `tasksApi` 的函数，六个 `TasksView` spec（§9.4 五文件 + 本文件）的工厂都要补条目。

---

## FE-1 API 客户端与草稿预检（设计 §3、§3.3、§13 FE-1；契约 = PR-3a 分支 `00ddafad23`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `1a1de612f0`（FE-0 已记 15 文件 / 539 全绿）；本片不改 `TasksView.vue`，六个 `TasksView` spec 的 `tasksApi` 工厂零改动 |
| 契约只读来源 | `git show 00ddafad23:<path>`：PR-3a 设计 §3 路由表、PR-3a 验证 S3 / S4 / S5（含 S5.9 前端对接表）、`routes/tasks.ts`、`tasks-settings.ts`、`tasks-lists.ts`、`services/task-patch.ts`、`services/task-records.ts`（`getTask` / `createTask` 的新键）、`services/task-list-records.ts`（`List` 形状）、`src/tasks/task-edit.ts`（`REMIND_AT_RE`、`canonicalTime`、`''` 时区规则）、`task-pagination.ts`、`task-settings.ts`、`task-dates.ts`（`OFFSET_FORM_RE` / `NAMED_ZONE_RE`）、`task-ids.ts`（`normalizeUserText` / `isStorableText`）、`task-lists.ts` / `task-groups.ts`（名称 100 码点） |
| 后端状态 | S3 设置、S4 `PATCH /api/tasks/:id`、S5 清单核心 7 条路由已建；**成员（S6）、清单项（S7）、分组（S8）未建**，这三组函数只按契约编码，spec 标为 contract-only |
| API 改动后、新 spec 加入前重跑 15 个守卫 | 15 文件 / 539 全绿；`vue-tsc` 0 错误 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `ba535c0da6` | `tasksApi.ts` 的 M4 函数、解析器、`collectPages`、既有四函数的枚举扩展、`resolveViewerTimeZone` 导出；新 `tasksDraft.ts` |
| `39f6e9db25` | `tests/tasks-api-m4.spec.ts`（512 格）；`checkRemindAt` 的日历判定改按服务端 `parseInstant`（`setUTCFullYear`，0001–0099 年为真实年份）；三处登记 |
| `e64ee2f80f` | 六行里的零宽 / 全角空格 / 组合符改写为 `\uXXXX` 转义（正则与字符串语义不变，512 格不变） |
| 本文所在提交 | 本节 |

### 3. 文件

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/tasks/tasksApi.ts` | +885 / −16（现 1763 行） | 既有部分：`TaskDetail` 加 `version?` / `description?` `startDate?` `startTime?` `remindAt?`（四键成组）/ `listIds?`；`ListTasksResult.ok` 加 `total?`；`CreateTaskInput` 加六个日期键、`CREATE_TASK_VALIDATION_CODES` allowlist、`CreateTaskResult` 加 `validation` 与 `version?`；`PendingCountResult.ok` 加 `badgeScope?: 'off'`（容忍解析）；`WriteFailure.conflict` 加 `currentVersion?`（只解析正整数）；`listTasks(view, page?)`；`resolveViewerTimeZone` 导出。M4 块：`readCollection` / `collectPages` / `sendWrite` 三个私有 helper，`TASK_PAGE_LIMIT = 100`、`TASK_MAX_PAGES = 20`，34 个导出函数（§4 表） |
| `apps/web/src/tasks/tasksDraft.ts` | +351（新） | `initDraft` / `createEditorState`、`normalizeUserText` / `isStorableText`（服务端镜像）、`checkTaskTitle`、`checkTaskDescription`、`checkTaskDates`、`checkRemindAt`、`isValidTimeZoneName`、`buildTaskPatch`、`initSettingsDraft` / `checkSettingsDraft` / `buildSettingsPatch`、`checkListName` / `checkGroupName`；常量 `TASK_DESCRIPTION_MAX_CODEPOINTS = 20000`、`TASK_NAME_MAX_CODEPOINTS = 100` |
| `apps/web/tests/tasks-api-m4.spec.ts` | +2048（新） | 512 格，36 个 `describe`：`patchTask` 30、`createTask` 扩展 17、`getTask` 新键 22、`listTasks` 分页 7、`fetchPendingCount` 9、`resolveViewerTimeZone` 2、设置 25、清单 43、成员 28、清单项 16、分组 42、分页循环 9、路径段拒绝 93（31 个 id 位 × `''` / `.` / `..`）、URI 编码 29、传输失败 31、`tasksDraft` 109 |
| `apps/web/scripts/run-required-web-tests.sh` | +1 | `exec npx vitest run` 续行块插入 `tasks-api-m4.spec.ts`，在 `tasks-api-m3.spec.ts` 与 `tasks-api.spec.ts` 之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1 | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（552 token） |
| `.github/workflows/tasks-web-guard.yml` | +9 / −1 | step 参数插入 `tests/tasks-api-m4.spec.ts`（同序）；「Fifteen whole-file args」→「**Sixteen** whole-file args」；头注加 FE-1 一段（裸文件名，不含 `vitest run` 字样与 `tests/…` 路径） |

### 4. 函数与失败 kind（全部不抛错；每个放进路径的 id 先过 `isPathSafeSegment`）

| 函数 | 请求 | ok | 失败 kind |
|---|---|---|---|
| `patchTask(id, { expectedVersion, …patch })` | `PATCH /api/tasks/:id`，只序列化给出的键 | `{ id, version }` | `not_found`（含路径段拒绝）、`forbidden`、`org_missing`、`validation`（7 码）、`conflict`（`VERSION_CONFLICT` + `currentVersion?`）、`error` |
| `createTask`（扩） | 六个日期键「不给不发」 | `{ id, version? }` | 既有 + `validation`（8 个 allowlist 码）；其余 422 仍 `error` |
| `getTask`（扩） | 不变 | `TaskDetail` + 六个可选键 | 不变 |
| `listTasks(view, page?)` | 无 `page` 时请求串逐字节同今天 | `{ items, total? }` | 不变 |
| `fetchPendingCount`（扩） | 不变 | `{ count, badgeScope?: 'off' }` | 不变；`'off'` + 非 0 ⇒ `error` |
| `getTaskSettings()` | `GET /api/task-settings` | `TaskSettings` | `not_found`、`forbidden`、`error` |
| `patchTaskSettings(patch)` | `PATCH /api/task-settings`，只发定义的键 | 合并后的 `TaskSettings` | `org_missing`、`forbidden`、`not_found`、`validation`（6 码）、`error` |
| `listTaskLists({ includeArchived, offset })` | `GET /api/task-lists?includeArchived=…&limit=100&offset=N`（一页） | `{ items: TaskList[], total }` | `org_missing`（降级体）、`forbidden`、`not_found`、`error`（含 422） |
| `listAllTaskLists({ includeArchived }, { isSuperseded? })` | 同上，读全部页 | 同上 | 同上 |
| `createTaskList(name)` | `POST /api/task-lists` | `{ list }` | `org_missing`、`forbidden`、`not_found`、`validation`（`INVALID_NAME` `NAME_TOO_LONG`）、`error` |
| `getTaskList(id)` | `GET /api/task-lists/:id` | `{ list }` | `not_found`、`forbidden`、`error` |
| `renameTaskList(id, name)` / `archiveTaskList(id)` / `unarchiveTaskList(id)` | `PATCH /api/task-lists/:id` / `POST …/archive` / `POST …/unarchive` | `{ list }` | `WriteFailure` |
| `listTaskListEvents(id, { offset })` | `GET /api/task-lists/:id/events?limit=100&offset=N`（一页） | `{ items: TaskListEvent[], total }` | 集合读四种 |
| `listTaskListMembers(id, opts?)` | `GET …/members`，读全部页 | `{ items: TaskListMember[], total }` | 集合读四种 |
| `addTaskListMember(id, userId, role)` / `changeTaskListMemberRole(id, userId, role)` / `removeTaskListMember(id, userId)` / `transferTaskListOwner(id, userId)` | `POST …/members` / `PATCH …/members/:userId` / `DELETE …/members/:userId` / `POST …/transfer-owner` | `{ id, members }` | `WriteFailure`；用户 id 路径段拒绝 ⇒ `validation INVALID_MEMBER` |
| `listTaskListItems(id, opts?)` | `GET …/items`，读全部页 | `{ items: TaskListItem[], total }`（严格六列） | 集合读四种 |
| `addTaskToList(id, taskId)` / `removeTaskFromList(id, taskId)` | `POST …/items` / `DELETE …/items/:taskId` | `{ listId, taskId }` | `WriteFailure` |
| `listTaskListGroups(id)` / `createTaskListGroup(id, name)` / `renameTaskListGroup(id, groupId, name)` / `deleteTaskListGroup(id, groupId)` / `listTaskListGroupItems(id, opts?)` / `placeTaskInListGroup(id, taskId, groupId, position)` | `…/groups`、`…/groups/:groupId`、`…/group-items`、`PUT …/group-items/:taskId` | `{ items: TaskGroup[], total }` / `{ group }` / `{ id, deleted: true, reassignedTo }` / `{ items: TaskPlacement[], total }` / `{ taskId, groupId, position }` | 读：集合读四种；写：`WriteFailure` |
| `listUserGroups()` / `createUserGroup(name)` / `renameUserGroup(groupId, name)` / `deleteUserGroup(groupId)` / `listUserGroupItems(opts?)` / `placeTaskInUserGroup(taskId, groupId, position)` | `/api/task-groups…`、`/api/task-groups/items…` | 同清单 scope；`listUserGroups` 接受合成默认组（`id: null`） | 同上 |

解析器导出：`parseTaskSettings`、`parseTaskList`、`parseTaskGroup(value, scope)`；类型 `CollectionResult<T>`、`ReadAllOptions`、`TaskPatch` / `TaskPatchRequest`、`TaskSettings` / `TaskSettingsPatch`、`TaskList` / `TaskListRole` / `TaskListAssignableRole`、`TaskListEvent`、`TaskListMember` / `TaskListMembership`、`TaskGroup` / `TaskPlacement` / `TaskGroupScope`。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks-`（`apps/web`，最终 head） | **16 文件 / 1051 用例全绿**（539 既有 + 512 新） |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 0 错误 |
| D = T = G | `D`=`T`=`G`=15 个 `tasks*.spec.ts`；yml 16 个 whole-file 参数 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，552 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（`tasks-api-m4.spec.ts`） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 既有 token 的双向子串碰撞 0 |
| 字面扫描器 v1（6 个改动文件 + 本 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（三个新改源文件） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、**`tasks-api-m4` 512（新）**、`tasks-api` 66、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-view` 44、`tasks-labels` 37、`tasks-list-view` 32、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 13、`tasks-view-transitions` 14、`tasks-view` 7。

### 6. 变异证据

脚本驱动（脚本不入库）：断言 `old` 文本恰出现一次 → 备份 → 改坏 → 跑点名的 spec → 还原 → `filecmp` 逐字节比对；不用 `git checkout --`。整轮在最终文本（`e64ee2f80f`）上重跑：34 个变异，33 个变红，1 个（M33）按预期仍绿为等价变异；34 个文件还原全部逐字节一致，轮后 `git status` 干净。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | `patchTask` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-api-m4` | 红（3） | 一致 |
| M2 | `classifyWriteFailure` 的 `currentVersion` 放宽成任意数字 | `tasksApi.ts` | `tasks-api-m4` | 红（3） | 一致 |
| M3 | `buildTaskPatch` 碰日期键不再带 `timeZone` | `tasksDraft.ts` | `tasks-api-m4` | 红（4） | 一致 |
| M4 | `checkTaskDates` 用 `new Date(str)` 判日期 | `tasksDraft.ts` | `tasks-api-m4` | 红（4）：`2031-02-30` 等 | 一致 |
| M5 | `initDraft` 去掉 `slice(0, 5)` | `tasksDraft.ts` | `tasks-api-m4` | 红（4） | 一致 |
| M6 | `initDraft` 的 `description ?? ''` 改回原值 | `tasksDraft.ts` | `tasks-api-m4` | 红（3） | 一致 |
| M7 | `fetchPendingCount` 对非 `off` 的 `badgeScope` 判 `error` | `tasksApi.ts` | `tasks-api-m4`、`tasks-api` | 红（5） | 一致 |
| M8 | `createTask` 把全部 422 归 `validation` | `tasksApi.ts` | `tasks-api-m4`、`tasks-api` | 红（2）：含既有 `VALIDATION_FAILED` 格 | 一致 |
| M9 | `collectPages` 不去重 | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M10 | `collectPages` 去掉 `TASK_MAX_PAGES` 上限 | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M11 | `collectPages` 空页不停止 | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M12 | `collectPages` 忽略 `isSuperseded` | `tasksApi.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M13 | `parseTaskSettings` 的 `badgeScope` 只查字符串不查闭集 | `tasksApi.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M14 | `parseTaskGroup` 在清单 scope 接受 `id: null` | `tasksApi.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M15 | `parseTaskDetail` 接受 `version: 0` | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M16 | `parseTaskDetail` 四键各自独立可选（去掉组规则） | `tasksApi.ts` | `tasks-api-m4` | 红（6） | 一致 |
| M17 | `listTasks` 接受非法 `total` | `tasksApi.ts` | `tasks-api-m4` | 红（4） | 一致 |
| M18 | `readCollection` 不再把降级体判 `org_missing` | `tasksApi.ts` | `tasks-api-m4` | 红（8） | 一致 |
| M19 | `checkRemindAt` 毫秒改可选 | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M20 | `normalizeUserText` 改用 `String#trim`（零宽符不再修边） | `tasksDraft.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M21 | `buildTaskPatch` 清日期不再同体清时间 | `tasksDraft.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M22 | `buildTaskPatch` 不看 `remindTouched` 就放 `remindAt` | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M23 | `checkSettingsDraft` 去掉「每日提醒需时区」 | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M24 | `checkListName` 按 UTF-16 码元计长 | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M25 | `patchTask` 把 `undefined` 键序列化成 `null` | `tasksApi.ts` | `tasks-api-m4` | 红（2） | 一致 |
| M26 | `addTaskListMember` 去掉用户 id 检查 | `tasksApi.ts` | `tasks-api-m4` | 红（3） | 一致 |
| M27 | `checkTaskDescription` 按 UTF-16 码元计长 | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M28 | `parseTaskList` 的 `myRole` 只查字符串不查闭集 | `tasksApi.ts` | `tasks-api-m4` | 红（3） | 一致 |
| M29 | `getTaskList` 去掉 403 分支 | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M30 | `createTask` 对出现的 `version` 不查正整数 | `tasksApi.ts` | `tasks-api-m4` | 红（4） | 一致 |
| M31 | `fetchPendingCount` 的 `'off'` + 非 0 判 ok | `tasksApi.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M32 | `checkTaskDates` 接受无日期的时间 | `tasksDraft.ts` | `tasks-api-m4` | 红（1） | 一致 |
| M33 | `isValidTimeZoneName` 去掉偏移量形式守卫 | `tasksDraft.ts` | `tasks-api-m4` | **仍绿（等价变异）**：本机 Node 20.20.2 / ICU 78 的 `Intl.DateTimeFormat` 对 `+08:00` 等偏移量形式本身就抛错，守卫只对接受偏移量时区的运行时才有判别力 | 一致 |
| M34 | `listTasks` 无 `page` 也附带分页参数 | `tasksApi.ts` | `tasks-api-m4`、`tasks-api` | 红（2）：含既有请求串格 | 一致 |

### 7. 与设计的偏差 / 解释

1. **多出 `listAllTaskLists({ includeArchived }, { isSuperseded? })`**（§3.2 只列 `listTaskLists({ includeArchived, offset })`）：§4.3 要求详情页对「我的清单」读全部页，而 `collectPages` 是私有的；左栏的「加载更多」仍用一页式的 `listTaskLists`。
2. **多出 `initSettingsDraft` / `buildSettingsPatch`**（§3.3 只列 `checkSettingsDraft`）：§7.1 的「只发改动键、`timeZone` 清空发 `null`、`badgeScope` / `defaultRemindPolicy` 永不发 `null`」是纯规则，放在同一模块并由格钉住，FE-3 直接调用。
3. **带字段归属的返回形**：`checkTaskDates` / `checkSettingsDraft` 返回 `{ ok: true } | { ok: false, code, field }`（行内错误要落在引发它的控件旁，§4.0）；单字段检查（`checkTaskTitle` / `checkTaskDescription` / `checkRemindAt` / `checkListName` / `checkGroupName`）沿用 `checkCommentBody` 的 `'ok' | code` 形。
4. **四个日期 / 时间键的 `''` 读作 `null`**（`checkTaskDates` 与 `buildTaskPatch`）：清空的控件报 `''`（§7.2「`''` 的时间控件值视为 `null`」），纯模块对它容忍，避免把清空判成 `INVALID_DATE`。
5. **请求体里的用户 id 也过 `isPathSafeSegment`**（`addTaskListMember` / `transferTaskListOwner` ⇒ `validation INVALID_MEMBER`），沿用 M3 `addAssignee` 对请求体 `userId` 的做法；请求体里的任务 id（`addTaskToList`）与分组 id（两个 `place…`）不检查，沿用 M3 `setParent` 对 `parentId` 的做法，由服务端 `INVALID_TASK` / `INVALID_GROUP` / 404 回答。
6. **`parseTaskGroup(value, scope)` 带期望 scope**：`scope` 字段须等于期望值；`id === null` 只在 `'user'` scope **且 `isDefault === true`** 时合法（契约里合成默认组就是这个形）。`listUserGroups` 不在解析层强制「恰一个 `isDefault`」，留给 FE-7 的板逻辑（任一读失败 ⇒ 平铺是设计好的降级，解析层多拒一次没有收益）。
7. **`TaskList.ownerId: string | null`**（§3.2 表写 `ownerId`）：PR-3a 验证 S5.9 写明无 `owner` 行时为 `null`。
8. **`buildTaskPatch` 的标题按归一化后比较**（NFC + 修边），归一化为空的标题按原样放入 patch，让 `checkTaskTitle` 报 `INVALID_TITLE`；§3.3 只写「只放入不同的键」，这里把「两端空白」排除在改动之外，避免对真后端发空操作 PATCH。
9. **两套日历判定镜像两处服务端行为**：`YYYY-MM-DD` 用 `Date.UTC` 回算（服务端 `parseIsoDate`，0001–0099 年同样被拒）；`remindAt` 用 `setUTCFullYear` 回算（服务端 `parseInstant`，0001 年合法）。
10. **`isValidTimeZoneName` 先 `trim`、再查偏移量形式、再 `Intl`、再按服务端 `NAMED_ZONE_RE` 查规范名**：服务端 `validateViewerTimeZoneHeader` 的四步；不 `trim` 会拒掉服务端接受的 `' Asia/Shanghai '`。M33 记为等价变异。
11. **`fetchPendingCount` 先验 `count` 再看 `badgeScope`**：`'off'` + 非 count 的体同样是 `error`。
12. **`tasksApi.ts` 不拆文件**（设计 §13 写「追加」），现 1763 行；`tasksDraft` 的格按 §10.1 放在 `tasks-api-m4.spec.ts` 内，不另开 spec 文件（与 §10.3 的 22 个 token 清单一致）。
13. **六处不可见字符改为转义**（`e64ee2f80f`）：首次写入时正则与五个测试字符串里的零宽符 / 全角空格 / 组合符落成了字面字符，M20 的首个 `old` 文本因此匹配不到；改写后整轮变异在最终文本重跑，结果同上表。
14. `WriteFailure.conflict` 的扩展对 M3 调用方透明：只在 409 体带正整数 `currentVersion` 时才多出该键，`tasks-api-m3.spec.ts` 的 `toEqual` 格原样通过。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调；全部格 mock `apiFetch`（设计 §10.5 的真机项全部 NOT RUN）。S6 / S7 / S8 的函数只有契约没有后端，连 mock 之外的形状核对都做不了。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 16 个 whole-file 参数、manifest 检查模式与后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（spec 文件不在 `tsconfig.app.json` 内，只经 vitest 的 esbuild 转译）。
- M33 的等价性只在 Node 20.20.2 / ICU 78 上成立；接受偏移量时区名的浏览器运行时上，`OFFSET_FORM_RE` 守卫是唯一的拒绝点，未在那样的运行时跑过。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-2 / FE-3 / FE-4 的说明

- **FE-2**：`fetchPendingCount` 的 ok 结果多一个可选 `badgeScope: 'off'`（只在 `'off'` + `count === 0` 时出现）；`useTasksBadge` 的 `scope` 由它派生；`tasks-badge.spec.ts` 现有的 mock 形状仍合法，不需要改。
- **FE-3**：读写用 `getTaskSettings()` / `patchTaskSettings(patch)`；表单态用 `initSettingsDraft(settings)` → 编辑 → `buildSettingsPatch(current, draft)`（`null` ⇒ 按钮禁用、不发）→ `checkSettingsDraft(draft)`（`{ ok: false, code, field }` ⇒ 该字段旁 `codeMessage(code, t)`）→ `patchTaskSettings`；「使用浏览器时区」填 `resolveViewerTimeZone()`（已导出）；自动填时区并提示（`[fe-06]`）是 FE-3 自己的 UI 规则，纯模块不做。`validation` 的六个码经 `codeMessage` 已有文案。
- **FE-4**：编辑区只在 `task.canEdit && task.version !== undefined` 时渲染；`editorState = createEditorState()`，进入 `ok` 态时 `draft = initDraft(task)`；提交顺序 = `buildTaskPatch(task, draft)`（`null` ⇒ 不发）→ `checkTaskTitle` / `checkTaskDescription` / `checkTaskDates` / `checkRemindAt`（服务端顺序；任一有码 ⇒ 行内文案，不发）→ `patchTask(id, { expectedVersion: task.version, ...patch })`。`conflict` 的 `currentVersion` 可选：有则 `fmt.versionConflict(n)`，无则 FE-4 自定无版本号变体。清截止日期的 handler 必须把 `dueTime` 一起置 `null`（`checkTaskDates` 对「有时间无日期」报 `INVALID_DATE`；`buildTaskPatch` 自己会同体放 `dueTime: null`）。提醒控件改动时置 `remindTouched = true`，否则 `remindAt` 永不入 patch。`notifyTasksChanged()` 只在 patch 含 `dueDate` / `dueTime` / `timeZone` 任一键时发。「我的清单」读用 `listAllTaskLists({ includeArchived: true }, { isSuperseded })`；§9.4 五文件表（加 `tasks-labels.spec.ts`）的 `tasksApi` 工厂要补的条目名按 FE-4 实际调用的函数填（`listAllTaskLists`，不是 §9.4 写的 `listTaskLists`），缺省返回 `{ kind: 'ok', items: [], total: 0 }`。`TaskDetail.listIds` 可选，缺失时不渲染「所属清单」。
- **FE-5 / FE-7**：左栏用一页式 `listTaskLists({ includeArchived, offset })`，`items.length === total` 时停；所有集合读的结果是 `CollectionResult<T>`（`ok` / `org_missing` / `forbidden` / `not_found` / `error`）。分组：`listUserGroups()` 的合成默认组 `id === null`（`isDefault: true`）；`place…(…, groupId: null, position)` 表示默认组；摆放读按 `taskId` 去重；`TaskGroup.position` / `TaskPlacement.position` 都是非负整数。
- **登记**：下一个 token 按 `LC_ALL=C` 序插入（`tasks-badge-m4.spec.ts` 在 `tasks-badge.spec.ts` 之前）；yml 计数从 Sixteen 起每片 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。

---

## FE-2 红点：`badgeScope: 'off'` 与 `tasks:counts-updated` 订阅骨架（设计 §8、§13 FE-2；`[D5]` `[R16]` `[fe-08]` `[fe-11]` `[fe-14]`）

### 1. 基线与依赖

| 项 | 结果 |
|---|---|
| 起手 head | `a6fcde9c0c`（FE-1 已记 16 文件 / 1051 全绿）；起手前重跑 16 个守卫：**16 文件 / 1051 全绿** |
| 契约只读来源 | `git show 0de12b4a9d:packages/core-backend/src/tasks/task-realtime.ts`（纯模块，只有 `countsUpdateRecipients`；事件名与「载荷只表示需要重读、不带数据」按 `R16`）；后端 `CollabService.ts` 在 token 校验后把 socket 加入认证用户房间（客户端不发 join）；#6173（`0386f47fdc`）的门模式与它两个钉请求序列的 spec（`tasks-nav-feature-gate.spec.ts` / `tasks-nav-relogin.spec.ts`）；`todo/useTodoCountsRealtime.ts`（整段照抄的来源）；`approvalCountsRealtime.spec.ts` / `todoCountsRealtime.spec.ts`（假 `io` 的既有做法） |
| 后端状态 | **PR-3c（发事件方）未设计、未建**：订阅骨架只按 `R16` 编码，事件名单点常量，落地后按设计 §8.3 重核；`badgeScope: 'off'` 的解析自 FE-1 的 `fetchPendingCount`（S3 已建） |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `ea579c0a36` | 实现：`useTasksBadge.ts`（`scope`、订阅接线）、`TasksTodoBadge.vue`（`data-scope`、`off` 呈现）、新 `useTasksCountsRealtime.ts` + `tasksRealtimePolicy.ts`、`labels.ts`（`badgeOff`） |
| `d87e23d609` | 新 `tests/tasks-badge-m4.spec.ts`（55 格）；`tests/tasks-labels.spec.ts` 加 `off` 三格与 `FMT_ARGS` 条目；三处登记 |
| 本文所在提交 | 本节 |

### 3. 文件

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/tasks/useTasksCountsRealtime.ts` | +131（新） | socket 生命周期整段照抄 `todo/useTodoCountsRealtime.ts`（`connectionPromise` 去重、`disconnected` 拆除标志、`auth: { token }`、`path: '/socket.io'`、`transports: ['websocket', 'polling']`、`resolveTasksCountsRealtimeBaseUrl` 去 `/api` 后缀）；只换三处：事件名常量 `TASKS_COUNTS_UPDATED_EVENT = 'tasks:counts-updated'`（`[R16]`）、载荷处理（`isCountsInvalidation(payload)` 对任何值恒真，回调**无参**调用）、挂载守卫改读 `shouldAutoConnectRealtime()`；处理函数先查 `disconnected` 再回调（卸载后的事件不重拉） |
| `apps/web/src/tasks/tasksRealtimePolicy.ts` | +18（新） | 只导出 `shouldAutoConnectRealtime(): boolean`，返回 `import.meta.env.MODE !== 'test'`（生产行为同两个既有组合式的行内守卫；单独成模块只为让 spec 能 `vi.mock`，`[fe-11]`） |
| `apps/web/src/tasks/useTasksBadge.ts` | +31 / −1 | 新增 `scope: Ref<'on' \| 'off' \| null>`：`ok` 分支 `badgeScope === 'off' ? 'off' : 'on'`，失败分支置 `null`；在组合式 setup 内调用 `useTasksCountsRealtime({ onCountsUpdated: () => void refresh() })`（挂载 / 卸载钩子登记在红点组件实例上，于是红点不挂 ⇒ socket 不开）；轮询、404 拆定时器、`ok` 重启、总线订阅全部不变 |
| `apps/web/src/tasks/TasksTodoBadge.vue` | +32 / −4 | `:data-scope="scope ?? ''"`；类 `tasks-todo-badge--off`；`off` 时 `glyph` 为空、`aria-label` / `title` = `fmt.badgeOff(label)`；`data-state` 仍只有三值、`data-count` 在 `off` 时为服务端真值 `"0"`；`defineExpose` 加 `scope`；样式 `--off` 透明底色与文字、零宽零内边距 |
| `apps/web/src/tasks/labels.ts` | +3 | `TASKS_FMT_ZH.badgeOff`：ZH `` (label) => `${label}红点已关闭` ``、EN `` (label) => `${label} badge off` `` |
| `apps/web/tests/tasks-badge-m4.spec.ts` | +793（新） | 55 格，四组：A `off` 呈现 11 格；B 经红点的订阅 16 格；C 组合式契约 20 格；D 真实 `App` 挂载的门 8 格（§4） |
| `apps/web/tests/tasks-labels.spec.ts` | +39 / −2 | `FMT_ARGS` 加 `badgeOff: ['X']`；「嵌入实参」格加两行；红点段加三格（EN `off` 零 CJK、ZH `off` 对生产入口文案逐字节、挂载后翻转）；−2 是头注两行改写。既有断言零改动 |
| `apps/web/scripts/run-required-web-tests.sh` | +1（:1819） | `exec npx vitest run` 续行块插入 `tasks-badge-m4.spec.ts`，在 `tasks-api.spec.ts` 与 `tasks-badge.spec.ts` 之间（`LC_ALL=C` 序：`-` 先于 `.`） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1（:486） | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（553 token） |
| `.github/workflows/tasks-web-guard.yml` | +11 / −1 | step 参数插入 `tests/tasks-badge-m4.spec.ts`（:128，同序）；「Sixteen whole-file args」→「**Seventeen** whole-file args」；头注加 FE-2 一段（:41–49，裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现在 :123） |

### 4. 行为规则（spec 按这些出格）

- **scope**：`ready` 且 `badgeScope === 'off'` ⇒ `'off'`；`ready` 其余（键缺失、任何非 `'off'` 值）⇒ `'on'`（`[fe-14]`）；`loading` / `unavailable` ⇒ `null`，且从 `off` 转入失败时必须清回 `null`（M7）。
- **三种呈现由属性串判别**：`ready|off|0`（关闭）、`ready|on|0`（0 条）、`unavailable||`（不可用）；`off` 无数字、有 `--off` 类、`aria-label`「待办任务红点已关闭」（入口文案 `navLabels.tasksTodo` = 「待办任务」时逐字节同设计 §8.1）。
- **订阅**：每条事件恰一次 `fetchPendingCount`；载荷任何值都触发且永不被渲染（带 `count: 99` 的事件，渲染的是重拉结果）；连续三条事件三次读、只有最后一次结果落地（generation，含乱序回包）；404 拆定时器后的事件仍重拉一次、`ok` 则 60 s 钟重启；卸载后事件不重拉；卸载 ⇒ `disconnect()` 恰一次。
- **轮询回退（`[fe-08]`）**：socket 在线时 60 s 轮询照跑，事件前后都跑；策略为假（测试构建）时不开 socket、轮询照跑。
- **门（§8.2）**：真实 `App.vue` + 策略恒真 ⇒ feature on 且 `tasks:read` 且普通路由时 `io` 恰一次（正控，事件到达后红点重拉）；feature off（含管理员）/ 无 `tasks:read` / 公开路由 / `/login` / 考勤或 PLM 聚焦壳层 ⇒ 零次；壳层卸载 ⇒ `disconnect()` 一次。
- **策略模块本身**：真实模块在测试构建下返回 `false`，`vi.stubEnv('MODE', 'production' | 'development')` 下返回 `true`。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks-`（`apps/web`，`d87e23d609`） | **17 文件 / 1109 用例全绿**（1051 既有 + 55 新 + 3 labels 新格） |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 0 错误 |
| D = T = G | `D`=`T`=`G`=16 个 `tasks*.spec.ts`；yml 17 个 whole-file 参数；头注 `tests/tasks…spec.ts` 形式命中 0 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，553 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（`tasks-badge-m4.spec.ts`） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 553 个 token 的双向子串碰撞 0（`tasks-badge.spec.ts` 与新 token 互不为子串） |
| 字面扫描器 v1（10 个新改文件 + 本 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（六个新改源文件与 spec） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、**`tasks-badge-m4` 55（新）**、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-view` 44、`tasks-labels` **40**（37 + 3）、`tasks-list-view` 32、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 13、`tasks-view-transitions` 14、`tasks-view` 7。

### 6. 变异证据

脚本驱动（脚本不入库）：断言每个 `old` 文本在其文件恰出现一次 → 备份 → 改坏（一个变异可跨多文件）→ 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。在提交后的文本（`d87e23d609`）上跑：**26 个变异全部变红，0 个等价变异，26 组文件还原全部逐字节一致，轮后 `git status` 干净**。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | 关闭时仍渲染数字 | `TasksTodoBadge.vue` | `tasks-badge-m4` | 红（3） | 一致 |
| M2 | 去掉 `data-scope` 属性 | `TasksTodoBadge.vue` | `tasks-badge-m4`、`tasks-labels` | 红（17） | 一致 |
| M3 | 关闭态 `aria-label` 落回计数形式 | `TasksTodoBadge.vue` | `tasks-badge-m4`、`tasks-labels` | 红（4） | 一致 |
| M4 | 去掉 `--off` 类 | `TasksTodoBadge.vue` | `tasks-badge-m4` | 红（2） | 一致 |
| M5 | `scope` 恒为 `'on'` | `useTasksBadge.ts` | `tasks-badge-m4` | 红（4） | 一致 |
| M6 | `scope` 按 `count === 0` 推断而非按键 | `useTasksBadge.ts` | `tasks-badge-m4` | 红（2）：0 条格与序列格 | 一致 |
| M7 | 读失败时不清 `scope` | `useTasksBadge.ts` | `tasks-badge-m4` | 红（1）：序列格 | 一致 |
| M8 | 去掉订阅接线 | `useTasksBadge.ts` | `tasks-badge-m4` | 红（17） | 一致 |
| M9 | 订阅回调空转 | `useTasksBadge.ts` | `tasks-badge-m4` | 红（13） | 一致 |
| M10 | socket 送达后停轮询（丢回退，`[fe-08]`） | `useTasksBadge.ts` | `tasks-badge-m4` | 红（2） | 一致 |
| M11 | 事件名改成 `todo:counts-updated` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（17） | 一致 |
| M12 | 从载荷读数渲染而不重拉（组合式透传载荷 + 红点读 `payload.count`，跨两文件） | `useTasksCountsRealtime.ts`、`useTasksBadge.ts` | `tasks-badge-m4` | 红（3）：「载荷不渲染」格与 C 组无参格 | 一致 |
| M13 | `isCountsInvalidation` 只认对象 | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（14）：`undefined` / `null` / 字符串格 | 一致 |
| M14 | 处理函数去掉 `disconnected` 检查 | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（2）：B / C 两个卸载格 | 一致 |
| M15 | 挂载钩子无视策略（恒连） | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（3）：策略为假的三格 | 一致 |
| M16 | 挂载钩子永不连接 | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（20）：含门的正控格（证明正控不是空转） | 一致 |
| M17 | 不发 `auth.token` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（3） | 一致 |
| M18 | 无 token 也连接 | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（1） | 一致 |
| M19 | 卸载不 `disconnect()` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（3） | 一致 |
| M20 | 卸载不置 `disconnected` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（2） | 一致 |
| M21 | `path` 改成 `/ws` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（3） | 一致 |
| M22 | 去掉单 socket 去重 | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（1） | 一致 |
| M23 | 策略模块去掉测试构建守卫（恒真） | `tasksRealtimePolicy.ts` | `tasks-badge-m4` | 红（1）：真实模块取值格 | 一致 |
| M24 | EN 的 `badgeOff` 写成中文 | `labels.ts` | `tasks-labels` | 红（3） | 一致 |
| M25 | `useTasksCountsRealtime()` 挪到 `App.vue` setup 顶层（`canUseTasks` 之外） | `App.vue` | `tasks-badge-m4`、`tasks-nav-badge`、`tasks-nav-feature-gate` | 红（9）：**只有 `tasks-badge-m4` 红**（七个负控格 + 正控的「恰一次」）；`tasks-nav-badge` / `tasks-nav-feature-gate` 在真实策略（测试构建恒不连）下仍绿——正是设计 §8.2 说的「靠 MODE 守卫的门格什么也证明不了」 | 一致 |
| M26 | `transports` 改成只 `polling` | `useTasksCountsRealtime.ts` | `tasks-badge-m4` | 红（2） | 一致 |

设计 §10.1 点名的五个目标全部覆盖：载荷不读（M12、M13）、去掉 `disposed` 检查（M14、M20）、`off` 渲染数字（M1）、挪到 `App.vue` 顶层（M25）、策略恒假 ⇒ 正控红（M16 为可观测的等价形：spec 用 `vi.mock` 替换了策略模块，改源文件的策略取值在 spec 里不可见；M23 另钉真实模块的取值）。

### 7. 与设计的偏差 / 解释

1. **`badgeOff` 是带入口文案参数的格式函数**，不是固定字符串「待办任务红点已关闭」：红点的文案都由 `App.vue` 传入 `label`（`navLabels.tasksTodo` = 「待办任务」），照 FE-0 的 `badgeUnavailable` / `badgeLoading` 形式写成 `${label}红点已关闭`，生产入口下渲染结果与 §8.1 逐字节相同（`tasks-labels.spec.ts` 用生产入口文案钉住）。
2. **§8.2 的 `normalizePayload` 落成 `isCountsInvalidation(_payload): boolean`**，无条件返回 `true`，参数只为写明「被忽略」；回调签名 `() => void`、无参调用（C 组钉 `mock.calls[0]` 为 `[]`）。
3. **卸载后不重拉的守卫只有一处**，在组合式的事件处理函数里（`disconnected`），`useTasksBadge` 不再加第二道 `disposed` 检查（§10.2「删去冗余检查」）：假 socket 的处理函数表在 `disconnect()` 后仍在，所以这一道就是卸载格钉住的那一道（M14 / M20 各自变红）。真实客户端断开后本来不投递，守卫不依赖这一点。
4. **`--off` 样式**：设计只写「视觉上隐去底色」；实现另把文字设为透明并清零 `min-width` / `padding`，让入口不为空药丸占位。浏览器里的视觉效果未看（§8 NOT RUN）。
5. **整段照抄带来的一个既有行为**（记录，不改）：`ensureSocket` 的 IIFE 无 `await`，`finally { connectionPromise = null }` 在外层赋值之前同步执行，所以一次返回 `null` 的尝试（无 token / 已拆除）之后，已结算的 promise 会被缓存到 `disconnect()` 为止。红点只在有会话时挂载（`canUseTasks` 要求会话特性已加载），对本片不可达；两个既有组合式同样如此。另：去 `/api` 后缀只去恰为 `/api` 的尾段，`/api/`（带斜杠）不去，spec 按照抄的规则出格。
6. **spec 比设计多出的格**：门的负控另加 `/login` 与两种聚焦壳层；C 组加 `disconnect()` 句柄、去重、无 token、base URL、真实策略模块在测试构建与 `vi.stubEnv` 下的取值；B 组加「事件回包为 `off` 时红点就地关闭」与「策略为假时轮询照跑」。
7. **`tasks-labels.spec.ts` 本片加格**（FE-0 说明「后续片各自把新视图加进扫描」；§9.3 (3) 写的红点扫描是「三态 + off」）：只加格与 `FMT_ARGS` 条目，既有断言零改动。
8. **既有守卫零改动**：`tasks-badge.spec.ts`（它 mock 的 `fetchPendingCount` 形状仍合法）、`tasks-nav-badge.spec.ts`、`tasks-nav-feature-gate.spec.ts`、`tasks-nav-relogin.spec.ts`、`App.spec.ts` 都不改，两份钉住的请求序列照常成立：真实策略在测试构建下不连 socket；socket.io 客户端本来也不经 `fetch`。
9. `tasks-web-guard.yml` 头注的 FE-2 段本片已加（同 FE-0 / FE-1 的做法），只写裸文件名。

### 8. NOT RUN

- **真实 socket 服务端未跑**：没有对任何后端起 socket.io 服务，`io` 在全部格里都是假的；`socket.io-client` 真实模块在策略恒真下的连接行为（jsdom）未触发。**PR-3c 未设计**：事件名 `tasks:counts-updated`、按用户房间发、载荷形状、`auth.token` / `/socket.io`、触点集合（含 PATCH 是否发事件）——落地后按设计 §8.3 五条重核；事件名单点常量 `TASKS_COUNTS_UPDATED_EVENT`，必要时只改它。
- 真机 / 浏览器：`off` 的视觉未看；红点 `off` 对 PR-3a 分支的真机联调（§10.5）NOT RUN。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 17 个 whole-file 参数、manifest 检查模式与后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-3 / FE-4 的说明

- `useTasksBadge()` 现在返回 `{ state, count, scope }`，`TasksTodoBadge` 的 `defineExpose` 也含 `scope`，节点带 `data-scope`。**FE-3 设置页**保存 `badgeScope` 成功后调 `notifyTasksChanged()`（设计 §7.1 已要求）即可让红点立即重拉并翻到 `data-scope="off"` / `"on"`——与 socket 事件走同一条 `refresh()`（B 组「事件回包为 `off`」格证明的就是这条路）；不需要新总线。
- **FE-4** 的 `onPatchTask`：截止 / 时区键变化时发 `notifyTasksChanged()`（§8.3 第 3 条）——PR-3c 未定是否对 PATCH 发事件，本地总线保证操作者自己的红点及时。
- 任何挂载 `TasksTodoBadge` 或 `App.vue` 的新 spec 都**不需要** mock `socket.io-client`：真实策略在 vitest 下不连；只有要观察 socket 的 spec 才 `vi.mock('../src/tasks/tasksRealtimePolicy')` 成恒真并注入假 `io`，此时 `useAuth` mock 须提供 `getToken`。
- 加文案照 FE-0 规则；新格式函数必须同时在 `tasks-labels.spec.ts` 的 `FMT_ARGS` 加一行。
- 登记：下一个 token `tasks-settings-view.spec.ts` 按 `LC_ALL=C` 序插在 `tasks-routes.spec.ts` 之后、`tasks-view-transitions.spec.ts` 之前；yml 计数从 Seventeen 起每片 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。

---

## FE-3 设置页 `/tasks/settings`、路由与列表页头入口（设计 §2.1–§2.2、§4.5、§7.1、§13 FE-3；`[R02]` `[R07]` `[fe-03]` `[fe-06]` `[fe-07]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `e521833321`（FE-2 已记 17 文件 / 1109 全绿）；起手前重跑 17 个守卫：**17 文件 / 1109 全绿** |
| 契约只读来源 | `git show 3e2699758c:<path>`（只读该提交）：PR-3a 设计 §3.0（缺 org：单对象读 404、写 422 `ORG_MISSING`）、§3.6（设置形状、六个 422 码、`badgeScope` / `defaultRemindPolicy` 显式 `null` 是 422、`timeZone: null` 清空、未知键忽略、时区落规范名）、§8（`off` 时 `/pending-count` 回 `{ count: 0, badgeScope: 'off' }`）；PR-3a 验证 S3（S3.1–S3.8：无行 GET 给缺省值、非普通对象请求体 422 `INVALID_SETTINGS`、每日提醒需时区按**合并后**判定）；`routes/tasks-settings.ts`（GET 缺 org ⇒ 404 `NOT_FOUND`；PATCH 缺 org ⇒ 422 `ORG_MISSING`，非 `application/json` 体按无体处理 ⇒ 422 `INVALID_SETTINGS`）；`src/tasks/task-settings.ts`（`parseSettingsPatch`、`TASK_DEFAULT_USER_SETTINGS`）。门的模式：#6173（`0386f47fdc`）——路由 meta 带 `requiredFeature: 'tasks'` + `permissions: ['tasks:read']`，入口在 `canUseTasks` 之内 |
| 后端状态 | S3 设置路由已在 PR-3a 分支建成；本片全部格 mock 传输层（`apiFetch` 按路径扮演后端），**真机联调 NOT RUN**（§8） |
| 既有守卫零改动的依据 | `App.vue` 未改，`tasks-nav-feature-gate.spec.ts` 钉的壳层完整请求序列与 `tasks-nav-relogin.spec.ts` 的两条请求断言不变（页头链接是 `router-link`，不发请求）；`TasksView.vue` 没有新调用任何 `tasksApi` 函数，所以六个挂载 `TasksView` 的 spec 的 `tasksApi` 工厂**都不用补条目** |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `26bfd58c15` | 实现：新 `views/tasks/TasksSettingsView.vue`；`router/appRoutes.ts` 加 `/tasks/settings`；`TasksView.vue` 列表页头加链接；`labels.ts` 加设置页文案 |
| `04b2c63dc1` | 新 `tests/tasks-settings-view.spec.ts`（71 格）；三处登记 |
| `e60343f0b7` | `tasks-routes.spec.ts` 加 9 格；`tasks-labels.spec.ts` 加 9 格与工厂条目 |
| `944c6451d2` | 本节初稿 |
| `a375677baa` | 只改注释：视图的读 / 保存两处与 `settingsNotFound` 上方补 `ASSUMPTION(task-m4-fe): [own-19] (PR-3a)`（§7 第 16 条）；其后全部绿线与整轮变异在这一 head 上重跑（§5、§6） |
| 本文所在提交 | 本节定稿 |

### 3. 文件

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/views/tasks/TasksSettingsView.vue` | +507（新；含 `a375677baa` 的 3 行注释） | 先读 context（五态与 `TasksView` 同文案、同 `data-testid`），再读 `GET /api/task-settings`；读态 `loading` / 表单 / `not_found` / `forbidden` / `error`；四个字段：红点范围（`fieldset` + `legend` 单选组）、每日汇总提醒（复选框 + 旁注；勾选而时区为空时填浏览器时区并提示）、新任务的缺省提醒（`select`）、时区（文本输入 + `type="button"` 的「使用浏览器时区」+ `datalist` 候选，候选来自 `utils/timezones.ts#buildTimezoneOptions`，浏览器时区排第一，每页只算一次）；保存（§4 的规则）；`defineExpose` 只读暴露页面状态供晚到格读取（§7 第 3 条） |
| `apps/web/src/router/appRoutes.ts` | +10 | `/tasks/settings`（name `tasks-settings`，懒加载 `TasksSettingsView.vue`，meta `{ title: 'Task Settings', titleZh: '任务设置', requiresAuth: true, requiredFeature: 'tasks', permissions: ['tasks:read'] }`），写在 `/tasks/:id` 之前；注释写明顺序只是防御（静态段排序高于参数段）与 `tsk_` 前缀 |
| `apps/web/src/views/tasks/TasksView.vue` | +5 | 列表分支（`ready` 且无 `orgMissingFromAction`）的页头里、`<h1>` 之后加 `<router-link to="/tasks/settings" data-testid="tasks-settings-link">`；不在 `<h1>` 内（`tasks-view.spec.ts:119` 与 labels 的列表格钉 `h1.textContent`），详情页头不加 |
| `apps/web/src/tasks/labels.ts` | +55（含 `a375677baa` 的 2 行注释） | 两张表各加 22 键（`settingsLink` + 21 个 `settings*`），现各 122 键。ZH 取自设计原文的 15 键：`settingsLink`（§2.2）、`settingsTitle`（§2.1 的 `titleZh`）、`settingsNotFound`（§4.5）、`settingsBadgeScopeLegend` 与三个范围选项、`settingsDailyReminder`、`settingsDailyReminderNote`、`settingsRemindPolicyLabel` 与两个策略选项、`settingsUseBrowserTimeZone`、`settingsTimeZoneAutofilled`、`settingsSaved`（§7.1 / §4.5）；本片新写的 7 键：`settingsForbidden`、`settingsLoadFailed`、`settingsTimeZoneLabel`、`settingsTimeZonePlaceholder` 与三条保存横幅（§7 第 7 条）；EN 全部是本片新写。无新格式函数（`FMT_ARGS` 不变）；`[R02]` `[R07]` 标在键组注释上，`[own-19]` 标在 `settingsNotFound` 上方。设置页另读既有的 `backToList`、`loading`、`save`、四个 context 文案与六个设置码 |
| `apps/web/tests/tasks-settings-view.spec.ts` | +894（新） | 71 格（§5 分组） |
| `apps/web/tests/tasks-routes.spec.ts` | +112 | 只加两个新 `describe`（9 格）与一行 `createRouter` / `createMemoryHistory` 值导入；既有 13 格零改动 |
| `apps/web/tests/tasks-labels.spec.ts` | +238 / −1 | 9 格（EN 六格、ZH 正控一格、挂载后翻转两格）；`tasksApi` 工厂补 `getTaskSettings` / `patchTaskSettings` / `resolveViewerTimeZone` 与 `TASK_BADGE_SCOPES` / `TASK_REMIND_MODES`（`tasksDraft.ts` 从 `tasksApi` 读这两个闭集，显式工厂不给就取不到）；`beforeEach` 补三个缺省；新挂载 helper `mountSettingsPage()`（既有 `mountViewAt` 不动）；−1 是头注一行改写。既有断言零改动 |
| `apps/web/scripts/run-required-web-tests.sh` | +1（:1830） | `tasks-settings-view.spec.ts` 插在 `tasks-routes.spec.ts` 与 `tasks-view-transitions.spec.ts` 之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1（:497） | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（554 token） |
| `.github/workflows/tasks-web-guard.yml` | +11 / −1 | step 参数插入 `tests/tasks-settings-view.spec.ts`（:148，同序）；「Seventeen whole-file args」→「**Eighteen** whole-file args」（:129）；头注加 FE-3 一段（:50–57，裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现在 :132） |

### 4. 行为规则（spec 按这些出格）

- **入口**：只在 `/tasks` 的 `ready` 列表分支渲染，`<h1>` 的兄弟节点，`href="/tasks/settings"`；详情页、四个 context 非 `ready` 态、列表读回 `org_missing` 的引导块下都没有。点击后路由名是 `tasks-settings`（不是被 `/tasks/:id` 吃掉），设置页只读一次 `GET /api/task-settings`，没有任何 `/api/tasks/settings…` 请求。
- **读**：context 未返回时显示加载中、不读设置；context 非 `ready` 时渲染与 `TasksView` 相同的块与文案、不读设置；设置读 404 ⇒ `tasks-settings-not-found`（「无法读取设置：当前服务不支持，或尚未选择组织」，契约把缺路由与缺 org 合成一个 404）；403 ⇒ `tasks-settings-forbidden`；500 / 畸形 200 / 传输失败 ⇒ `tasks-settings-error`；三者都不渲染表单。
- **表单初值**：取服务端值；`timeZone: null` ⇒ 输入框为空、「使用浏览器时区」`data-suggested="true"`（有时区时为 `false`）。
- **只发改动键**：请求体是 `buildSettingsPatch(服务端值, 草稿)`，按 `TASK_SETTINGS_KEYS` 序序列化；未改动 ⇒ 保存按钮禁用且提交不发；改回原值 ⇒ 再次禁用；清空时区发 `{"timeZone":null}`；`badgeScope` / `defaultRemindPolicy` 永不发 `null`。spec 断言的是假 `apiFetch` 收到的字符串本身。
- **每日提醒与时区**（`[R07]` `[fe-06]`）：勾选时若时区为空，填 `resolveViewerTimeZone()`（须过 `isValidTimeZoneName`）并显示「已按浏览器时区填入，可修改」（`role="status"`，挂进输入框的 `aria-describedby`），不发请求；已有时区则不覆盖；取消勾选不动时区；改时区收起提示。勾选后又清空时区、或没有可用的浏览器时区 ⇒ 保存时预检报 `DAILY_REMINDER_REQUIRES_TIME_ZONE`，落在时区输入旁，不发请求。
- **预检**：`checkSettingsDraft` 先于任何请求；`Not/AZone`、`+08:00`、`UTC+8`、纯空白 ⇒ `INVALID_TIME_ZONE` 落时区旁、不发；大小写变体（`asia/shanghai`）放行，回包的规范名回填输入框（`[D7]`）。
- **「使用浏览器时区」**：`type="button"`，点击只填值（读点击时的 `resolveViewerTimeZone()`），不提交；浏览器时区不可用时按钮禁用。
- **422 落点**：`INVALID_SETTINGS` ⇒ 保存按钮旁（`tasks-settings-save-error`）；`INVALID_BADGE_SCOPE` ⇒ 红点范围组旁；`INVALID_DAILY_REMINDER_ENABLED` ⇒ 复选框旁；`INVALID_POLICY` ⇒ 下拉旁；`INVALID_TIME_ZONE` / `DAILY_REMINDER_REQUIRES_TIME_ZONE` ⇒ 时区旁；未列出的码 ⇒ 保存按钮旁、回退文案。每格断言**恰好一个**行内错误节点、精确 ZH 文案、`role="alert"`、无横幅、草稿保留、不 `notifyTasksChanged`。下一次编辑清掉行内错误。
- **引导块与横幅**：PATCH 422 `ORG_MISSING` ⇒ 表单换成 `tasks-view-org-missing` 引导块；403 ⇒ 横幅「您没有权限修改任务设置」；404 ⇒「无法保存设置：当前服务不支持」；500 / 畸形 200 / 409（不在本契约）/ 传输失败 ⇒「保存设置失败，请稍后重试」；横幅 `role="alert"`，表单与草稿保留，下一次编辑清掉横幅；都不 `notifyTasksChanged`。
- **成功**：回包覆盖表单（规范名回填）、「已保存」（`role="status"`）、`notifyTasksChanged()` 恰一次、保存按钮回到禁用；下一次保存以回包为比较基准；下一次编辑收起「已保存」。
- **一次一个**：保存进行中，三个单选、复选框、下拉、时区输入、浏览器时区按钮、保存按钮共 8 个控件全部 `disabled`，表单 `aria-busy="true"`；再提交两次也只发一次；回包后恢复。
- **晚到结果**：离开页面（路由组件卸载）同时推进读 generation 与保存 token。晚到的保存 `ok` 仍 `notifyTasksChanged()` 一次（服务端状态确实变了），其余页面状态不动；晚到的 422 / `ORG_MISSING` / 403 什么都不动、不通知；晚到的设置读不填表单；晚到的 context 读不再发设置读。
- **无障碍**：红点范围是 `fieldset` + `legend`，每个单选在自己的 `label` 里；复选框在 `label` 里并以 `aria-describedby` 指向旁注（有错误时再加错误节点）；下拉与时区输入有 `label[for]`，有错误时 `aria-invalid="true"` 并指向错误节点；时区输入挂 `list` 指向 `datalist`。无 `window.confirm`；离开不拦截（`[fe-03]`）。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks- --reporter=verbose`（`apps/web`，`a375677baa`；`e60343f0b7` 上同数同绿） | **18 文件 / 1198 用例全绿**（1109 既有 + 71 新文件 + 9 routes + 9 labels），0 个 `×` |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`a375677baa`） | 退出 0，0 行输出 |
| D = T = G | `D`=`T`=`G`=17 个 `tasks*.spec.ts`；yml 18 个 whole-file 参数（+`tests/App.spec.ts`）；yml 中 `vitest run` 只出现 1 次 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，554 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（`tasks-settings-view.spec.ts`） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 553 个 token 的双向子串碰撞 0 |
| 字面扫描器 v1（10 个新改文件 + 本 MD，`a375677baa` 上重跑） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（10 个新改文件 + 本 MD） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-view` 44、`tasks-labels` **49**（40 + 9）、`tasks-list-view` 32、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` **22**（13 + 9）、**`tasks-settings-view` 71（新）**、`tasks-view-transitions` 14、`tasks-view` 7。

`tasks-settings-view.spec.ts` 的 71 格：页头入口 8（含四个 context 态与列表读 `org_missing`）；读态 12（context 加载中、设置加载中、404、403、错误三种、context 四态、标题与返回链接）；表单 6（初值两种、标签与 `legend`、候选、未改动禁用、改回禁用）；只发改动键 4；每日提醒与时区 13（自动填、不覆盖、取消勾选、提示收起、两种需时区预检、四种非法时区、大小写变体、浏览器时区按钮、无可用浏览器时区）；422 落点 8（六码 + 未列出的码 + 编辑清错）；引导块与横幅 8（`ORG_MISSING` + 六种横幅 + 编辑清横幅）；成功 3；一次一个 2；晚到 7（正控 1、晚到 ok 1、晚到失败 3、晚到读 1、晚到 context 1）。

`tasks-routes.spec.ts` 新 9 格：meta 精确相等 + 名称 + 懒加载 + 投影；写在 `/tasks/:id` 之前；由 `appRoutes` 建的真路由把 `/tasks/settings` 解析为 `tasks-settings`（参数为空）、`/tasks/tsk_1` 仍是 `task-detail`；门 22 的 allow / redirect / 焦点-attendance / 焦点-plm / feature-off 五格；真实 store 缺省（feature off）+ 管理员 ⇒ `/home`。

### 6. 变异证据

脚本驱动（脚本不入库）：断言每个 `old` 文本在其文件中（按编辑顺序）恰出现一次 → 备份 → 改坏（一个变异可跨多处 / 多文件）→ 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。先在 `e60343f0b7` 上跑一轮，补注释（`a375677baa`）后在最终文本上整轮重跑：**两轮都是 44 个变异全部变红、0 个等价变异、44 组文件还原全部逐字节一致、轮后 `git status` 干净；两轮的表（每个变异的失败格数）逐行相同**。下表即最终一轮。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | 设置路由去掉 `requiredFeature` | `appRoutes.ts` | `tasks-routes` | 红（3）：meta 格、feature-off 格、真实 store 缺省格 | 一致 |
| M2 | 设置路由去掉 `permissions` | `appRoutes.ts` | `tasks-routes` | 红（2）：meta 格、redirect 格 | 一致 |
| M3 | 设置路由挪到 `/tasks/:id` 之后 | `appRoutes.ts` | `tasks-routes` | 红（1）：只有「写在之前」格；resolve 格仍绿——vue-router 4 的静态段排序本来就胜过参数段，所以顺序格是钉住设计 §2.1 写法的那一格 | 一致 |
| M4 | 路径改成 `/tasks/setting`（`/tasks/settings` 落到 `/tasks/:id`） | `appRoutes.ts` | `tasks-routes` | 红（9）：含 resolve 格 | 一致 |
| M5 | 懒加载改指 `TasksView.vue` | `appRoutes.ts` | `tasks-routes` | 红（1） | 一致 |
| M6 | 去掉页头链接 | `TasksView.vue` | `tasks-settings-view`、`tasks-labels` | 红（5） | 一致 |
| M7 | 页头链接指向 `/settings` | `TasksView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M8 | 页头链接挪进 `<h1>` | `TasksView.vue` | `tasks-settings-view`、`tasks-view` | 红（2）：本片入口格与既有 `tasks-view.spec.ts:119` 同时红 | 一致 |
| M9 | 勾选每日提醒不再填浏览器时区 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M10 | 保存跳过 `checkSettingsDraft` | `TasksSettingsView.vue` | `tasks-settings-view` | 红（7）：两种需时区格、四种非法时区格、无可用浏览器时区格 | 一致 |
| M11 | 浏览器时区按钮填常量 `'UTC'` | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M12 | 浏览器时区按钮去掉 `type="button"`（点击即提交） | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M13 | 保存发整份草稿而非改动键 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（9） | 一致 |
| M14 | 未改动的 `badgeScope` 以 `null` 发出 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（6） | 一致 |
| M15 | 未改动时保存按钮不禁用 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（3） | 一致 |
| M16 | 未改动时处理函数发空体 `{}` | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M17 | `INVALID_SETTINGS` 落到红点范围旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M18 | `INVALID_BADGE_SCOPE` 落到保存按钮旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M19 | `INVALID_DAILY_REMINDER_ENABLED` 落到保存按钮旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M20 | `INVALID_POLICY` 落到时区旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M21 | `INVALID_TIME_ZONE` 落到保存按钮旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M22 | `DAILY_REMINDER_REQUIRES_TIME_ZONE` 落到复选框旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M23 | 时区错误渲染原码而不经 `codeMessage` | `TasksSettingsView.vue` | `tasks-settings-view`、`tasks-labels` | 红（10） | 一致 |
| M24 | 未列出的码落到时区旁 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M25 | 保存回 `ORG_MISSING` 时显示横幅而非引导块 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M26 | 保存的 403 / 404 横幅文案对调 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M27 | 读态 `forbidden` / `not_found` 对调 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M28 | 读失败一律渲染为 `not_found` | `TasksSettingsView.vue` | `tasks-settings-view` | 红（4） | 一致 |
| M29 | context 非 `ready` 也读设置 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（4） | 一致 |
| M30 | 保存成功不 `notifyTasksChanged` | `TasksSettingsView.vue` | `tasks-settings-view` | 红（4）：成功两格、一次一个格、晚到 ok 格 | 一致 |
| M31 | 任何回包都 `notifyTasksChanged`（含失败） | `TasksSettingsView.vue` | `tasks-settings-view` | 红（16） | 一致 |
| M32 | 成功后不以回包覆盖草稿 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（3）：规范名回填格等 | 一致 |
| M33 | 成功后比较基准仍是旧设置 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2） | 一致 |
| M34 | 处理函数去掉 `pending` 守卫 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1）：「再提交只发一次」格 | 一致 |
| M35 | 保存进行中保存按钮不禁用 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M36 | 保存进行中时区输入不禁用 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M37 | 去掉晚到保存守卫 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（4）：晚到 ok 格与三个晚到失败格 | 一致 |
| M38 | 通知挪到晚到守卫之后（晚到 ok 不再通知） | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M39 | 卸载不推进保存 token | `TasksSettingsView.vue` | `tasks-settings-view` | 红（4） | 一致 |
| M40 | 去掉设置读之后的 generation 判断 | `TasksSettingsView.vue` | `tasks-settings-view` | 红（1） | 一致 |
| M41 | 卸载不推进读 generation | `TasksSettingsView.vue` | `tasks-settings-view` | 红（2）：晚到设置读格、晚到 context 格 | 一致 |
| M42 | EN 的「已保存」写成中文 | `labels.ts` | `tasks-labels` | 红（4） | 一致 |
| M43 | 视图的文案表改为 setup 时一次性求值（`ref` 代替 `computed`） | `TasksSettingsView.vue` | `tasks-labels` | 红（1）：翻转格 | 一致 |
| M44 | 视图模板硬编码一处中文（`legend`） | `TasksSettingsView.vue` | `tasks-settings-view`、`tasks-labels` | 红（3）：EN 扫描格；ZH 的本文件格仍绿 | 一致 |

简报点名的九类目标全部覆盖：路由 meta（M1 `requiredFeature`、M2 `permissions`）、静态段对参数段（M3 顺序、M4 解析）、每日提醒的时区规则（M9、M10）、只发改动键（M13、M14、M16）、每个码 → 文案 / 落点（M17–M24）、晚到守卫（M37–M41）、一次一个（M34–M36）、保存成功的 `notifyTasksChanged`（M30、M31、M38）、forbidden / not_found 态（M26–M28）。设计 §10.1 FE-3 行最右列的三条：保存发全量键（M13）、成功不通知（M30）、`badgeScope` 发 `null`（M14）。

### 7. 与设计的偏差 / 解释

1. **`INVALID_BADGE_SCOPE` / `INVALID_POLICY` 的预检从界面不可达**（§10.1 写「每个字段的预检码行内文案」）：单选组与下拉只能产出闭集内的值，`checkSettingsDraft` 的这两条在页面上触发不到。两码的**落点与文案**由 422 格证明（M18、M20），预检规则本身在 `tasks-api-m4.spec.ts` 的 `checkSettingsDraft` 格里（FE-1）。从界面可达的两条预检（`INVALID_TIME_ZONE`、`DAILY_REMINDER_REQUIRES_TIME_ZONE`）各有格（M10）。
2. **`[fe-06]` 的自动填在勾选当下**：§7.1 写「勾选每日提醒而时区为空时……填进去并提示」，§10.1 写「勾选每日提醒自动填时区」，本片在复选框的 `change` 上填，不在保存时填；用户随后又清空时区再保存（或浏览器时区不可用）时，保存走预检的 `DAILY_REMINDER_REQUIRES_TIME_ZONE` 行内文案、不发请求——不替用户把刚清掉的值再填回去。
3. **晚到格读的是 `defineExpose` 暴露的页面状态**：设置页是独立路由组件，离开即卸载；不暴露状态，「晚到结果不写表单」在 DOM 上不可观察，去掉守卫的变异会存活。照 `TasksTodoBadge.vue` 的先例（`defineExpose({ state, count, scope })`），暴露 `readResult` / `draft` / `pending` / `saved` / `fieldErrors` / `saveBannerKind` / `orgMissingFromSave`，spec 在离开前经 `router.currentRoute.value.matched[0].instances.default` 取句柄；另有一格正控证明句柄反映活页面（否则「不变」格可能空转）。M37–M41 全红。
4. **晚到的 `ok` 仍 `notifyTasksChanged()`**：设计 §4.5 / §7.1 没写设置页的晚到语义，本片取 §4.3（详情编辑）的同一口径——晚到只处理副作用，`ok` 仍通知（服务端的红点范围已经变了），不碰页面状态（M38 钉住）。
5. **context 四态复用 `TasksView` 的 `data-testid`**（`tasks-view-org-missing` / `-unavailable` / `-forbidden` / `-error`）与文案（§2.5「五态渲染……文案与 `TasksView` 相同」）；保存回 `ORG_MISSING` 时也换成同一个引导块。设置读自己的三种失败另有 `tasks-settings-*` id。
6. **`INVALID_SETTINGS` 与未列出的码落在保存按钮旁**（`tasks-settings-save-error`），不走横幅：§4.0 把 `validation` 一律放在引发它的控件旁，这两种没有单一字段，保存按钮是引发它的控件。横幅只给 403 / 404 / 其他（§4.0「`not_found` / `forbidden` / `error` 走通用横幅」）。
7. **设计没有给出的文案由本片新写**：三条保存横幅（`settingsSaveForbidden` / `settingsSaveUnavailable` / `settingsSaveFailed`，没有复用 `TasksView` 的 `actionForbidden`——它说的是「此任务」）、读态的 `settingsForbidden` / `settingsLoadFailed`、时区输入的标签 `settingsTimeZoneLabel` 与占位 `settingsTimeZonePlaceholder`；EN 两表的全部新值。设计原文给出的 15 条 ZH 文案逐字取用（§3 的 `labels.ts` 行）。
8. **任何编辑都收起上一次保存的结果**（「已保存」、行内错误、横幅）；设计没写，取此口径以免过时的提示留在页面上。每次保存尝试同样先清一次。
9. **context 读未返回时显示「加载中…」**（`TasksView` 在这一段什么都不渲染）：设置页从进入到表单之间始终有一个可见状态。
10. **浏览器时区先过 `isValidTimeZoneName`**：不合格（含空串）时按钮禁用、勾选不自动填；候选列表也只把合格的浏览器时区排第一。`buildTimezoneOptions` 每页只算一次并包在 `try` 里（失败则无候选），候选用 `option` 的 `label` 属性，不进文本。
11. **保存进行中禁用的是每个控件本身**（`:disabled`），不是外层 `fieldset[disabled]`：spec 逐个读 `disabled` 属性，判别力不依赖 jsdom 对 `fieldset` 继承禁用的实现。处理函数另有 `pending` 守卫（M34），直接派发 `submit` 也只发一次。
12. **页头链接不需要给六个 `TasksView` spec 的工厂补条目**：它是 `router-link`，不调用 `tasksApi`；不挂真路由的两个 spec（`tasks-view` / `tasks-list-view`）里它渲染为未解析的 `router-link` 元素，与既有列表项链接同样处理，`TESTIDS` 精确集合不含它。
13. **`tasks-routes.spec.ts` 的 resolve 格用由 `appRoutes` 建的真路由**（`platform-app-entry-mismatch-inventory.spec.ts` 已有同一做法）；新 spec 不导入 `appRoutes`（它静态导入大量视图，且本 spec 只给 `utils/api` 提供 `apiFetch`），入口格用按 `appRoutes.ts` 顺序摆放的三条记录。
14. 新 spec 的假后端：`apiFetch` 按路径扮演后端，真实 `tasksApi` 构造与解析每个请求，请求体按序列化后的字符串断言；`resolveViewerTimeZone` 固定为 `Pacific/Chatham`（既不是 UTC 也不是本机时区，填常量的变异不会碰巧通过，M11）。
15. `tasks-web-guard.yml` 头注的 FE-3 段本片已加（同 FE-0–FE-2 的做法），只写裸文件名。
16. **补标 `[own-19]`（PR-3a）**：设计 §11 的全表没有这一条，但设置页依赖它——缺 org 时设置读回 404（与缺路由同一个答案，所以 `not_found` 文案写两种原因）、保存回 422 `ORG_MISSING`（换成引导块）。照 FE-1 在 `tasksApi.ts` 标 `[own-11]` / `[own-24]` / `[own-25]` 的写法，在视图的读、保存两处与 `labels.ts` 的 `settingsNotFound` 上方各标一次 `ASSUMPTION(task-m4-fe): [own-19] (PR-3a)`。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调（设计 §10.5 的设置页真机项 NOT RUN）。设置页的布局、`datalist` 下拉、`--suggested` 样式在浏览器里都没看过。
- 后端侧的一条既有 NOT RUN 与本片相关：PR-3a 验证 S3.7 记录 `PATCH /api/task-settings` 的 `tasks:write` 守卫尚无格钉住（S10 的 `M4_ROUTES`）；本片的 403 横幅只在 mock 下证明。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 18 个 whole-file 参数、manifest 检查模式与后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`。`pnpm --filter @metasheet/web build`：NOT RUN。
- 真实路由守卫（`main.ts` 的 `beforeEach`）下的 `/tasks/settings`：没有单独的格；守卫判定由 `tasks-routes.spec.ts` 的策略格（含真实 `useAuth` + 真实 feature store）证明，`tasks-nav-relogin.spec.ts` 未改。
- `Pacific/Chatham` 等时区名的取舍只在 Node 20.20.2 的 ICU 上跑过。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-4 的说明

- **时区控件**：设置页的取法可直接照搬到编辑器——`resolveViewerTimeZone()` 先过 `isValidTimeZoneName` 再用；候选用 `buildTimezoneOptions([浏览器时区])`，每个组件实例只算一次。编辑器的「浏览器时区」按钮同样要 `type="button"`（它在 `<form>` 里，缺了就会提交，见 M12）。
- **`tasksDraft.ts` 与显式 `tasksApi` 工厂**：`tasksDraft.ts` 在调用 `checkSettingsDraft` 时从 `tasksApi` 读 `TASK_BADGE_SCOPES` / `TASK_REMIND_MODES`。FE-4 让 `TasksView` 导入 `tasksDraft.ts` 后，六个 `TasksView` spec 的显式工厂在导入时不会出错（两个常量只在 `checkSettingsDraft` 内部读到），但任何会调用 `checkSettingsDraft` 的挂载都要在工厂里给这两个常量（`tasks-labels.spec.ts` 已给）。
- **晚到格**：路由组件离开即卸载；`TasksView` 的详情页是同一实例复用，FE-4 的晚到格照既有 `detailActionToken` 的写法即可，不需要 `defineExpose`。
- 页头链接 `tasks-settings-link` 已占用；FE-5 的左栏 id 用 `tasks-lists-` 前缀，与它不相交。
- **登记**：下一个 token `tasks-detail-m4.spec.ts` 按 `LC_ALL=C` 序插在 `tasks-detail-m3.spec.ts` 之后、`tasks-detail-view.spec.ts` 之前；yml 计数从 Eighteen 起每片 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。

---

## FE-4 详情编辑区与「所属清单」区（设计 §4.3、§7.2、§7.3、§10.1、§13 FE-4；`[R03]` `[R04]` `[R16]` `[own-06]` `[own-07]` `[own-25]` `[own-29]` `[fe-02]` `[fe-15]` `[fe-17]`；本片新取舍 `[fe-19]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `c51bc472dc`（FE-3 已记 18 文件 / 1198 全绿）；起手前重跑 18 个守卫：**18 文件 / 1198 全绿** |
| 契约只读来源 | `git show 3e2699758c:<path>`（只读该提交）：PR-3a 设计 §3.0（行级判定一律 404、错误码命名、只有 `VERSION_CONFLICT` 是 409）、§3.1（`PATCH /api/tasks/:id` 的请求体；409 体 `{ error: { code: 'VERSION_CONFLICT' }, currentVersion }`）、§3.4（清单项：加入只认任务的直接角色、创建人移出支路、三个授权条件同一个 404，`[own-25]`）、§5.1（字段规则：碰日期必带非空时区 `[own-07]`、`''` 时区读作 `null` `[own-29]`、清日期不隐式清时间、`remindAt` 文法）、§5.3（PATCH 顺序：版本比较在字段校验之前；`remind_at` 从不派生 `[own-06]`）、§5.5（详情新增 `description` `startDate` `startTime` `remindAt` `listIds`；`listIds` 对创建人列出全部清单 id）；PR-3a 验证 S4（S4.1–S4.6：七个新码；`HH:MM` 落 `HH:MM:SS`；`description: ''` 对 `NULL` 是空操作；S4.5 前端兼容） |
| 后端状态 | S4（PATCH 与详情的四个新键）已在 PR-3a 分支建成。`listIds` 与清单项的两条路由属 **S7，未建**：「所属清单」区与加入 / 移出只按契约编码；`listIds` 缺失（今天的后端）时该区不渲染，有格钉住 |
| jsdom 的输入净化（写格前的探针，jsdom 27.2.0） | `type=date` 对 `2031-02-30` 等非法值、`type=time` 对 `25:00`、`type=datetime-local` 对 `2031-02-30T09:30` 一律净化为 `''`；`type=time` 保留 `10:30:15`。所以「非法日期 / 时间串」类预检在界面上不可达（§7 第 6 条），时间控件的秒在控件边界截成分钟 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `52f971da57` | 实现：新 `views/tasks/TaskDetailEditor.vue`、`views/tasks/TaskDetailLists.vue`；`TasksView.vue` 接线；`tasksDraft.ts`（`rebaseDraft`、`EditorErrorSlot`）；`tasksDateDisplay.ts`（`formatStartDisplay`）；`labels.ts`；六个挂载 `TasksView` 的 spec 只补 `tasksApi` mock 工厂条目与 `beforeEach` 缺省；`tasks-labels.spec.ts` 的 `FMT_ARGS` 两行 |
| `1de5c254cf` | 新 `tests/tasks-detail-m4.spec.ts`；三处登记；`TasksView.vue` 中 409 重拉之后的一步只保留 phase 守卫（§7 第 9 条） |
| `b185b34720` | `tasks-labels.spec.ts` 加 7 格 |
| `30946d3eec` | 编辑器的提交处理去掉与 `TasksView` 重复的 pending 检查（§7 第 10 条） |
| `548a370143` | 「所属清单」区的加入处理同上；`tasks-detail-m4` 的「M3 动作进行中」格加派发加入表单的提交并断言无请求 |
| `6d9e2723bf` | 本节初稿 |
| `bdd1ec4fc2` | 复核补格：`tasks-detail-m4` 加 3 格（移出进行中的互斥、移出晚到的 404 与 `ok`），变异 M77 / M78 随之加入（§6） |
| 本文所在提交 | 本节定稿 |

### 3. 文件（`c51bc472dc..bdd1ec4fc2`，16 个文件，+3077 / −4；不含本 MD）

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/views/tasks/TaskDetailEditor.vue` | +497（新） | 无状态编辑区（`[fe-15]`）：props = `task` / `draft` / `phase` / `conflictVersion` / `fieldErrors` / `serverUpdated` / `pending`；emits = `update:draft`（每次编辑一个新草稿对象）/ `submit`（改动键）/ `discard`；不发请求。控件：标题、描述（码点计数器，无 `maxlength`）、截止日期 + 时间、开始日期 + 时间（`type=time step=60`）、时区（文本输入 + `type="button"` 的浏览器时区按钮 + `datalist`）、提醒（「不提醒 / 指定时刻」单选 + `datetime-local`）；冲突提示（`role="alert"`）、「服务端已更新」（`role="status"`）、提醒不跟随截止日期的提示、各字段与提交按钮旁的行内错误（`role="alert"`、`aria-invalid`、`aria-describedby`）、「放弃我的修改」；行内错误出现时焦点移到对应控件。`datalist` 候选按浏览器时区缓存在模块作用域（编辑区随每次重拉重建） |
| `apps/web/src/views/tasks/TaskDetailLists.vue` | +202（新） | 无状态的「所属清单」区：props = `listIds` / `myLists` / `canEdit` / `pending` / `error`；emits = `add` / `remove`；本地只有选中的候选与打开中的移出确认。普通 `<script>` 块导出类型 `MyListsState`、`DetailListsError` |
| `apps/web/src/views/tasks/TasksView.vue` | +347 / −2 | 模板：截止行之后三条只读行（有 S4 组时）；完成 / 重启按钮之后、子任务区之前两个挂载点。脚本：`DetailEditorState`（`EditorState` + `base` + `form` 槽）、同步 `watch(detailResult)`、`onEditorDraftUpdate` / `onEditorDiscard` / `onPatchTask`（预检、`expectedVersion`、409 状态机、码落点、红点通知规则）、`loadMyLists`（自己的 generation）、`onAddTaskToList` / `onRemoveTaskFromList`；`actionErrorKind` 加值 `'invalid_version'`、`actionErrorMessage` 加一行；`enterDetail` 加一行 `void loadMyLists()`；`watch(taskId)` 复位块加四行。−2 是日期显示的导入行与 `actionErrorKind` 的类型行 |
| `apps/web/src/tasks/tasksDraft.ts` | +32 | `EditorErrorSlot` 类型；`rebaseDraft(base, draft, next)`（`[fe-19]`）。`createEditorState()` 的形状不变（`tasks-api-m4.spec.ts` 用 `toStrictEqual` 钉着它） |
| `apps/web/src/tasks/tasksDateDisplay.ts` | +22 | `formatStartDisplay(task, labels)`：开始日期的墙上时间显示（`HH:MM:SS` 显示为 `HH:MM`，不经 `Date` 往返），无开始日期时 `noStartDate` |
| `apps/web/src/tasks/labels.ts` | +94 | 两张表各加 36 键（现各 158 键）：只读行 6 键、编辑区 18 键（含无版本号的冲突文案 `versionConflictUnknown`）、「所属清单」区 12 键；格式函数加 `descriptionCount`（ZH 带「字」）、`listsRemoveFrom`（移出按钮的可访问名），现 7 个。`[R03]` `[R04]` `[own-06]` `[own-25]` 标在键组注释上 |
| `apps/web/tests/tasks-detail-m4.spec.ts` | +1539（新） | 111 格（§5） |
| `apps/web/tests/tasks-labels.spec.ts` | +239 / −1 | 7 格（EN 五格、ZH 正控一格、挂载后翻转一格）；工厂补 `listAllTaskLists` / `patchTask` / `addTaskToList` / `removeTaskFromList` 与 `beforeEach` 缺省；`FMT_ARGS` 两行；−1 是头注一行改写。既有断言零改动 |
| `apps/web/tests/tasks-detail-m3.spec.ts`、`tasks-detail-view.spec.ts`、`tasks-list-view.spec.ts`、`tasks-view.spec.ts`、`tasks-view-transitions.spec.ts` | 各 +18 | 只补 `tasksApi` 工厂条目（`listAllTaskLists` / `patchTask` / `addTaskToList` / `removeTaskFromList` / `resolveViewerTimeZone`）、对应的 hoisted `vi.fn()` 与 `beforeEach` 缺省（`listAllTaskLists` ⇒ `{ kind: 'ok', items: [], total: 0 }`）；**断言零改动** |
| `apps/web/scripts/run-required-web-tests.sh` | +1（:1823） | `tasks-detail-m4.spec.ts` 插在 `tasks-detail-m3.spec.ts` 与 `tasks-detail-view.spec.ts` 之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1（:490） | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（555 token） |
| `.github/workflows/tasks-web-guard.yml` | +13 / −1 | step 参数插入 `tests/tasks-detail-m4.spec.ts`（:152，同序）；「Eighteen whole-file args」→「**Nineteen** whole-file args」（:140）；头注加 FE-4 一段（:59–69，裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现在 :143） |

### 4. 行为规则（spec 按这些出格）

- **渲染**：编辑区只在 `canEdit !== false`（缺键视为可编辑，与 M3 能力标志同口径）且详情带 `version` 时渲染（闸审之后更正：另须带 S4 四键组——main 上 M3 的详情体也带 `version`，见文末「闸审之后的修复」第 1 项）；三条只读行（开始、描述、提醒）在详情带 S4 四键组时渲染（与编辑区是否可见无关，§7 第 2 条）；「所属清单」区只在详情带 `listIds` 时渲染。M2 形状的详情体三者都没有，main 上 M3 形状的详情体只多一个 `version`，M3 各区照常。
- **规范形（`[fe-17]`）**：控件里的时间是 `HH:MM`（服务端 `10:00:00` 显示为 `10:00`；时间控件报出 `10:30:15` 时截成 `10:30`）；`null` 描述是 `''`；清空的日期 / 时间控件是 `null`。服务端形的任务未改动 ⇒ 提交按钮禁用、表单提交也不发 PATCH、不通知红点；改回原值 ⇒ 再次禁用。
- **请求体**（断言的是客户端序列化后的字符串）：恰为 `{ expectedVersion, …改动键 }`，`expectedVersion` 取屏幕上那份详情的 `version`；只改标题 ⇒ `{"expectedVersion":3,"title":"New"}`（标题去两端空白）；改截止日期 / 时间 / 开始日期 ⇒ 同体带时区；清截止日期 ⇒ 时间控件一起清、体为 `{"dueDate":null,"dueTime":null}`（无剩余日期时不带时区）；无时区任务填第一个日期 ⇒ 预填浏览器时区并随体发出；已有时区不覆盖；只改时区 ⇒ 只带 `timeZone`；无日期任务清时区 ⇒ `{"timeZone":null}`；清描述 ⇒ `""`；提醒「不提醒」⇒ `remindAt: null`，填时刻（浏览器本地时间）⇒ `Date#toISOString()`；提醒只在碰过时入列，改截止日期而未碰提醒 ⇒ 体里没有 `remindAt`，并显示「提醒时刻不会自动跟随截止日期」。
- **预检**（先于任何请求，按服务端顺序：标题 → 描述 → 日期 → 提醒；只查 patch 里有的键，日期规则读整份草稿；第一处失败落在对应控件旁，恰一个错误节点，焦点移到该控件）：空白标题 ⇒ `INVALID_TITLE`；描述 20001 码点（emoji）或含 U+0000 ⇒ `INVALID_DESCRIPTION`（20000 码点照发）；有时间无日期 ⇒ `INVALID_DATE`（落在该时间旁）；有日期而时区清空 ⇒ `TIME_ZONE_REQUIRED`（焦点到时区输入）；`Not/AZone`、`+08:00` ⇒ `INVALID_TIME_ZONE`；大小写变体放行；「指定时刻」未填 ⇒ `INVALID_REMIND_AT`。下一次编辑清掉行内错误。
- **服务端 422 / 409 的落点**：`INVALID_TITLE` → 标题；`INVALID_DESCRIPTION` → 描述；`INVALID_TIME_ZONE` / `TIME_ZONE_REQUIRED` → 时区；`INVALID_REMIND_AT` → 提醒；`INVALID_DATE` → 请求里第一个日期 / 时间键（截止日期、截止时间、开始日期、开始时间之序；都没有时落截止日期）；`INVALID_VERSION` → 页面横幅（「版本信息缺失，请刷新页面」）；契约外的码 → 提交按钮旁（回退文案）；`VERSION_CONFLICT` 以外的 409 码（如 `TASK_BUSY`）→ 提交按钮旁，不重拉。都保留草稿、不重拉、不通知红点。
- **其他失败**：403 / 404 / 500 / 传输失败 ⇒ M3 的共享横幅，草稿保留；422 `ORG_MISSING` ⇒ 引导块。
- **成功**：编辑器状态先复位，再重拉详情（`getTask` 第二次），草稿取重拉后的值、回到 `idle`；红点只在 patch 含 `dueDate` / `dueTime` / `timeZone` 任一键时通知（开始日期的改动带时区键，同样通知）；下一次保存用重拉后的 `version`。
- **409 `VERSION_CONFLICT`（§7.3）**：`reloading` → 重拉 → `conflict`；提示「任务已被他人修改（当前版本 N），已载入最新内容，请核对后再保存」，N 取 409 体的 `currentVersion`；体里没有可用的 `currentVersion` ⇒ 无版本号的同义文案；草稿保留（`[fe-19]`：viewer 改过的字段保留，没改的字段取重拉值，所以下一次保存不会把别人改的字段写回旧值）；下一次保存的 `expectedVersion` 是**重拉后**的 `version`（格里 409 说 4、重拉回 5，第二个体是 5）；重拉失败 ⇒ 详情的错误态（编辑区随 `ok` 块卸载），只发过一次 PATCH；「放弃我的修改」⇒ 草稿 = 现值、回到 `idle`；冲突后的保存若 422 ⇒ 冲突提示让位于字段错误、回到 `idle`。不通知红点。
- **草稿跨重拉与路由边沿**：输入标题后做一次 M3 动作（加负责人）成功重拉 ⇒ 草稿仍在、显示「服务端已更新；你未保存的修改仍保留」（`role="status"`），之后保存只发标题；同一重拉里 viewer 没改的字段取重拉值；干净的草稿直接取重拉值、无提示；路由边沿（换任务、离开再回来）清掉草稿、冲突态与行内错误。
- **一次一个**（共享 `detailActionToken` / `detailActionPending`）：编辑保存进行中 ⇒ 完成、删除、加入、移出、提交按钮与编辑区控件全部禁用，再派发表单提交也只发一次；M3 动作进行中 ⇒ 编辑区控件、浏览器时区按钮、移出、加入全部禁用，派发编辑表单与加入表单的提交都不发请求；加入清单进行中 ⇒ 完成、删除、编辑区、移出禁用；移出清单进行中 ⇒ 完成、删除、编辑区提交与标题、加入与确认按钮禁用。
- **晚到**：保存进行中换到另一任务，晚到的 `ok` 不重拉旧任务、不碰新任务的编辑区，截止日期类改动仍通知红点一次、标题类不通知；离开再回到同一任务，晚到的 409 不重拉、不进冲突态，晚到的 422 不画错误；409 的重拉进行中离开再回来，重拉落地后页面不进冲突态；加入进行中换任务，晚到的结果不重拉、不画错误；移出进行中换任务，晚到的 404 不在新任务上画横幅，晚到的 `ok` 不重拉旧任务、不通知红点。
- **「所属清单」区**：我的清单读在进入详情时发（`listAllTaskLists({ includeArchived: true })`，读全部页，自己的 generation，不挂在进入详情等待的两个读上）；清单名映射自我的清单，读完整时不在其中的 id 显示为 id + 「（你不是成员）」；读进行中 / 失败 / 截断时只显示 id（失败另有一条说明，不切引导块）；候选只列我是 `edit` / `owner` 且尚未包含此任务的清单；加入 ⇒ `POST /api/task-lists/:id/items` 体 `{"taskId":"t1"}`、重拉详情、不通知红点；加入 404 ⇒ 行内「无法加入：你需要是该任务的创建人或负责人」（`[fe-02]` / `[own-25]`）、`LIMIT` ⇒ 「一个任务最多属于 10 个清单」、`INVALID_TASK` ⇒ 「无效的任务」、契约外码 ⇒ 回退文案、403 ⇒ 横幅；每一行都有「移出」（含不是我的清单的行，创建人支路），两步内联确认，取消不发；确认 ⇒ `DELETE /api/task-lists/:id/items/:taskId`、重拉、不通知；移出 404 ⇒ 横幅；不能编辑任务的人只看到清单，没有加入 / 移出；不是安全路径段的清单 id（`..` / `.`）不会到达传输层（移出落横幅、加入落行内文案，零写请求）；晚到的我的清单读不覆盖新任务的名字；路由边沿清掉该区的行内错误。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks- --reporter=verbose`（`apps/web`，`bdd1ec4fc2`；`548a370143` 上为 1313，同绿） | **19 文件 / 1316 用例全绿**（1198 既有 + 111 新文件 + 7 labels 新格），0 个 `×` |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`bdd1ec4fc2`） | 退出 0，0 行输出 |
| D = T = G | `D`=`T`=`G`=18 个 `tasks*.spec.ts`；yml 19 个 whole-file 参数（+`tests/App.spec.ts`）；yml 中 `vitest run` 只出现 1 次 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，555 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（`tasks-detail-m4.spec.ts`） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 554 个 token 的双向子串碰撞 0 |
| 字面扫描器 v1（16 个改动文件 + 本 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（`c51bc472dc..bdd1ec4fc2` 的 diff + 本 MD） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、**`tasks-detail-m4` 111（新）**、`tasks-detail-view` 44、`tasks-labels` **56**（49 + 7）、`tasks-list-view` 32、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 22、`tasks-settings-view` 71、`tasks-view-transitions` 14、`tasks-view` 7。`tasks-labels` 之外，既有 17 个文件的计数与 FE-3 相同。

`tasks-detail-m4.spec.ts` 的 111 格：渲染条件 5；只读行 2；未改动不发 2；请求体 18；预检 12；422 / 409 落点 12（九行码 × 落点，其中 `INVALID_DATE` 四行分别改截止日期、截止时间、开始日期、只改时区；另 `INVALID_VERSION` 横幅、非 `VERSION_CONFLICT` 的 409 各一格）；其他失败 5；保存成功 8（含红点通知规则的六种 patch）；409 `VERSION_CONFLICT` 7；草稿跨重拉与路由边沿 5；一次一个 4；晚到 8；「所属清单」区 23。`afterEach` 断言假后端没有收到任何未列出的请求。

`tasks-labels.spec.ts` 新 7 格：EN 五格（编辑区 + 只读行 + 不是成员的 id + 候选 + 提醒提示 + 移出确认；空值；冲突提示两种 + 服务端已更新；每个行内错误 + `INVALID_VERSION` 横幅 + 清单区三种错误；清单区读取中 / 不可用）、ZH 正控一格、挂载后翻转一格。

### 6. 变异证据

脚本驱动（脚本不入库；与 FE-3 同一个执行器）：断言每个 `old` 文本在其文件中（按编辑顺序）恰出现一次 → 备份 → 改坏（一个变异可跨多处 / 多文件）→ 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。在提交后的文本（`548a370143`）上整轮跑 M1–M76 与 M38b；复核补格（`bdd1ec4fc2`，只改 spec）之后另跑 M77 / M78（`ONLY=M77,M78`，同一执行器、同样还原比对）。**合计 79 个变异全部变红、0 个等价变异、79 组文件还原全部逐字节一致、两轮之后 `git status` 都干净**。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | 编辑区在没有 `version` 时也渲染 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M2 | 编辑区在 `canEdit: false` 时也渲染 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M3 | 详情没有 `listIds` 时「所属清单」区按空列表渲染 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M4 | 没有 S4 组的详情也渲染三条只读行 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M5 | `initDraft` 去掉 `slice(0, 5)`（草稿保留服务端 `HH:MM:SS`） | `tasksDraft.ts` | `tasks-detail-m4` | 红（17） | 一致 |
| M6 | 时间控件报出的秒不截 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M7 | 开始行显示服务端 `HH:MM:SS` | `tasksDateDisplay.ts` | `tasks-detail-m4` | 红（1） | 一致 |
| M8 | `initDraft` 把 `null` 描述原样放进草稿（不归一为 `''`） | `tasksDraft.ts` | `tasks-detail-m4` | 红（102）：`null` 进到编辑区，渲染抛错（单独重跑核过机制） | 一致 |
| M9 | 跳过标题预检 | `TasksView.vue` | `tasks-detail-m4` | 红（4） | 一致 |
| M10 | 跳过描述预检 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M11 | 跳过日期预检 | `TasksView.vue` | `tasks-detail-m4` | 红（5） | 一致 |
| M12 | 跳过提醒预检 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M13 | 日期预检的码一律落在时区旁 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M14 | 只改时区时不跑日期预检 | `TasksView.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M15 | 未改动时提交按钮不禁用 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（6） | 一致 |
| M16 | 未改动的草稿提交空 patch | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M17 | 409 不重拉 | `TasksView.vue` | `tasks-detail-m4` | 红（7） | 一致 |
| M18 | `expectedVersion` 取 409 体的 `currentVersion` 而非重拉后的详情 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M19 | 409 重拉时丢掉草稿（按重拉值重建） | `TasksView.vue` | `tasks-detail-m4` | 红（4） | 一致 |
| M20 | 重拉时整份保留草稿（不逐字段，`[fe-19]`） | `tasksDraft.ts` | `tasks-detail-m4` | 红（2） | 一致 |
| M21 | 409 重拉之后无条件置 `conflict`（去掉 phase 守卫） | `TasksView.vue` | `tasks-detail-m4` | 红（1）：重拉进行中离开再回来的格 | 一致 |
| M22 | 冲突提示不看版本号 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M23 | 不记录 409 的 `currentVersion` | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M24 | 「放弃我的修改」保留冲突态 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M25 | 每次重拉都按重拉值重建有改动的草稿 | `TasksView.vue` | `tasks-detail-m4` | 红（7） | 一致 |
| M26 | 从不置「服务端已更新」 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M27 | 详情块卸载即丢编辑器状态（相当于子组件自持草稿） | `TasksView.vue` | `tasks-detail-m4` | 红（10） | 一致 |
| M28 | 保存成功后、重拉前不复位编辑器 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M29 | 路由边沿不复位编辑器状态 | `TasksView.vue` | `tasks-detail-m4` | 红（5） | 一致 |
| M30 | 路由边沿不清「所属清单」区的行内错误 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M31 | 每次保存成功都通知红点 | `TasksView.vue` | `tasks-detail-m4` | 红（4） | 一致 |
| M32 | 保存成功从不通知红点 | `TasksView.vue` | `tasks-detail-m4` | 红（5） | 一致 |
| M33 | 晚到的 `ok` 不再通知红点 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M34 | 去掉保存的晚到守卫 | `TasksView.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M35 | 保存处理器在别的动作进行中仍受理提交 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M36 | 保存不占共享 pending | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M37 | 加入清单不占共享 pending | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M38 | 加入处理器在别的动作进行中仍受理提交 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M38b | 加入按钮不看 pending | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M39 | 编辑区标题输入不看 pending | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M40 | 移出按钮不看 pending | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M41 | 去掉加入的晚到守卫 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M42 | `INVALID_TITLE` 落在描述旁 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M43 | `INVALID_DESCRIPTION` 落在标题旁 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M44 | `INVALID_TIME_ZONE` 落在提交按钮旁 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M45 | `TIME_ZONE_REQUIRED` 落在截止日期旁 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M46 | `INVALID_REMIND_AT` 落在提交按钮旁 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M47 | `INVALID_DATE` 一律落在截止日期旁 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M48 | `INVALID_VERSION` 落在字段旁而非页面横幅 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M49 | `INVALID_VERSION` 横幅用通用文案 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M50 | 契约外的码落在标题旁 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M51 | 填提醒时刻不置「碰过」 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M52 | 改截止日期时同体带提醒（不只在碰过时） | `tasksDraft.ts` | `tasks-detail-m4` | 红（4） | 一致 |
| M53 | 清日期不清时间 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M54 | 第一个日期不取浏览器时区 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M55 | 行内错误不移焦点 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（4） | 一致 |
| M56 | 描述计数器按 UTF-16 码元计 | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M57 | 浏览器时区按钮去掉 `type="button"` | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M58 | 改截止日期即显示提醒提示（不看是否碰过提醒） | `TaskDetailEditor.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M59 | 移出不经确认 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（4） | 一致 |
| M60 | 加入成功通知红点 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M61 | 加入成功不重拉 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M62 | 候选含只读清单 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M63 | 候选含已包含此任务的清单 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（3） | 一致 |
| M64 | `removeTaskFromList` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-detail-m4` | 红（1） | 一致 |
| M65 | `addTaskToList` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-detail-m4` | 红（1） | 一致 |
| M66 | 加入的 404 落页面横幅 | `TasksView.vue` | `tasks-detail-m4` | 红（2） | 一致 |
| M67 | `LIMIT` 用通用的「人数已达上限」 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M68 | 读不完整时也标「你不是成员」 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M69 | 从不标「你不是成员」 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M70 | 去掉我的清单读的晚到守卫 | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M71 | 不能编辑任务的人也看到加入 / 移出 | `TaskDetailLists.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M72 | 进入详情不发我的清单读 | `TasksView.vue` | `tasks-detail-m4` | 红（23） | 一致 |
| M73 | EN 的编辑区标题写成中文 | `labels.ts` | `tasks-labels` | 红（8） | 一致 |
| M74 | 编辑区的文案表在 setup 时一次性求值（`ref` 代替 `computed`） | `TaskDetailEditor.vue` | `tasks-labels` | 红（1）：翻转格 | 一致 |
| M75 | 「所属清单」区标题硬编码中文 | `TaskDetailLists.vue` | `tasks-detail-m4`、`tasks-labels` | 红（6）：EN 扫描格；ZH 的本文件格仍绿 | 一致 |
| M76 | EN 的计数器写成与 ZH 相同 | `labels.ts` | `tasks-labels` | 红（7） | 一致 |
| M77 | 移出清单不占共享 pending | `TasksView.vue` | `tasks-detail-m4` | 红（1） | 一致 |
| M78 | 去掉移出的晚到守卫 | `TasksView.vue` | `tasks-detail-m4` | 红（2）：晚到 404 的横幅格与晚到 `ok` 的重拉格 | 一致 |

简报点名的目标全部覆盖：每条 `tasksDraft` 规则（按接线）——M5 / M8（规范形）、M9–M14（四类预检与落点）、M15 / M16（`buildTaskPatch === null`）、M20（`rebaseDraft` 的「整份保留」；提醒那一半与连续重拉时 base 的前移当时没有格，闸审之后补，见文末第 2–3 项）、M52（提醒只在碰过时）、M53 / M54（清日期清时间、首个日期取浏览器时区）；409 状态机——M17（重拉）、M19 / M20（保留草稿）、M18（版本来源）、M21–M24；一次一个（与 M3 动作共享 token / pending）——M35–M40、M77；晚到守卫——M21、M33、M34、M41、M70、M78；每个码 → 字段与文案——M42–M50、M66、M67；提醒只在碰过时——M51、M52、M58；`HH:MM` 规范化——M5–M7；「所属清单」的加入 / 移出与 `isPathSafeSegment`——M59–M65、M71；`listIds` 缺失的容忍——M3（S4 组缺失为 M4）。设计 §10.1 FE-4 行最右列七条：409 不重拉（M17）、`expectedVersion` 取 `currentVersion`（M18）、标题改动也通知红点（M31）、缺 `version` 也渲染（M1）、草稿改回子组件自持（可观察的等价形 M27）、`initDraft` 去掉 `slice(0, 5)`（M5）、清单项写绕过父组件的共享守卫（M37 不占共享 pending、M38 不经共享守卫）。

### 7. 与设计的偏差 / 解释

1. **`[fe-19]`：409（以及其他重拉）之后「保留草稿」= 保留 viewer 改过的字段**（`rebaseDraft`）：改过的字段（草稿与草稿取自的服务端值不同）保留草稿值，没改的字段取重拉后的值；提醒只在碰过且不同时算改过。设计 §4.3 / §7.3 写「草稿保留」，没写整份还是逐字段。整份保留时，下一次保存会把重拉带回的别人对**其他**字段的修改用旧值写回去（用的是重拉后的 `version`，所以不会再 409），这正是乐观锁要防的丢失更新。设计 §11 的全表没有这一条，本片按「本件自选取舍」编号 `[fe-19]`，代码注释与本节各记一次；设计 §12-Q6（409 后保留还是丢弃草稿）的缺省「保留」不变。（闸审之后补：这条规则当时只有「整份保留」的变异 M20 有格；提醒「碰过且不同」那一半与连续两次重拉时 base 的前移由文末第 2–3 项补格。）
2. **只读行（开始、描述、提醒）在详情带 S4 组时总是渲染**，编辑区可见时也渲染：§2.4 写「编辑区…否则显示只读的新字段」，§7.2 / §4.3 又把它们算作「显示层」（409 后「已载入最新内容，请核对」要对照的服务端现值）。总是渲染满足前者（不能编辑的人看得到），也给能编辑的人一份服务端现值对照。
3. **`INVALID_VERSION` 用页面横幅、用它自己的文案**：§4.3 写「落通用横幅」，§9.2 给了它的文案。`actionErrorKind` 加一个值 `'invalid_version'`、`actionErrorMessage` 加一行；既有三个值的映射不变，M3 / M2 的横幅文案格全部原样通过；既有处理器的 `actionErrorKind.value = null` 复位同样清掉它。
4. **服务端 `INVALID_DATE` 不带字段**，落在请求里第一个日期 / 时间键旁（截止日期、截止时间、开始日期、开始时间之序）；都没有（只换时区，服务端会重算截止瞬时，`[own-38]` 的年份范围就在这一步）时落截止日期。
5. **编辑器错误槽多一个 `form`**（提交按钮旁）：契约外的 422 码与 `VERSION_CONFLICT` 以外的 409 码放这里（§4.0「validation / conflict 渲染在引发它的控件旁」，这两类没有单一字段）。`TasksView` 持有的状态是 `DetailEditorState = EditorState + base + form 槽`，`createEditorState()` 本身不变。
6. **非法日期 / 时间串的预检从界面不可达**：jsdom（与浏览器）把 `type=date` / `type=time` 的非法值净化成 `''`。界面可达的预检是：空白标题、超长或含 U+0000 的描述、有时间无日期、有日期无时区、非法时区名、「指定时刻」未填时刻，各有格；`checkTaskDates` 对非法串的规则本身由 FE-1 的 `tasks-api-m4.spec.ts` 钉住。
7. **409 后重拉失败的那一支在界面上只表现为详情错误态**：编辑区在 `v-if="detailResult.kind === 'ok'"` 块内，`loadDetail` 失败即卸载，§7.3 的「提示不含版本号、提交禁用」那一形不可达；格断言可见的部分（错误态、`getTask` 两次、PATCH 一次）。之后任何一次成功的详情读都带来可信的 `version`；路由边沿清掉草稿（§7.3）。
8. **无版本号的冲突文案** `versionConflictUnknown`（FE-1 的说明：「无则 FE-4 自定无版本号变体」）：409 体缺 `currentVersion` 或不是正整数时用它。
9. **409 重拉之后那一步只认 phase**（`phase === 'reloading'` 才置 `conflict`）：路由边沿把编辑器复位成 `idle`，所以在那里再比一次 token 是等价检查，按 §10.2 删去；保留的 phase 守卫由 M21 证明。
10. **子组件不再重复 pending 检查**：一次一个由 `TasksView` 的处理器（共享 `detailActionPending`）负责，子组件的按钮在 pending 时禁用；子组件的提交 / 加入处理只挡「未改动」与「非候选」。两层各自有变异证明（处理器：M35 保存、M38 加入；控件：M38b 加入按钮、M39 编辑区标题输入、M40 移出按钮）。移出处理器的入口守卫（与 M3 各处理器同形的 `if (!id || detailActionPending.value) return`）没有界面路径可达——确认按钮在 pending 时禁用、移出没有可派发的表单——所以不单列变异；移出占用共享 pending 与它的晚到守卫由 M77 / M78 证明。
11. **红点通知按设计字面**：patch 含 `dueDate` / `dueTime` / `timeZone` 任一键即通知；开始日期的改动按 `[own-07]` 同体带时区键，所以也通知（多一次红点重读，无害）。晚到的 `ok` 同一规则。
12. **我的清单读的时机与失败**：进入详情时发（即使详情没有 `listIds`，§4.3「进入详情时」），`void loadMyLists()` 不挂在 `enterDetail` 等待的 `Promise.all` 上（不推迟 `ensureCurrentUser`，既有 spec 的固定 flush 周期不受影响）；任何失败（含降级体 `org_missing`）只让清单名未知，不切换引导块（列表读与 context 才是引导流的触发点）。
13. **「（你不是成员）」只在读完整时标注**：读被 20 页上限截断（`items.length < total`）时不标，id 照常显示。
14. **候选不排除已归档清单**（设计未要求；读用 `includeArchived: true` 才能给已归档的所属清单命名）。
15. **移出按钮对所有行显示**（`[own-25]` 的创建人支路），但和加入一起按任务的 `canEdit` 隐藏：不能编辑任务的人两条支路都不成立。
16. **路径段**：视图不另做 `isPathSafeSegment`；检查在 `addTaskToList` / `removeTaskFromList` 内（FE-1），格证明不安全的清单 id 不会到达传输层（M64 / M65）。
17. **`watch(taskId)` 复位块追加四行**（设计写两行）：编辑器状态、我的清单的 generation、我的清单结果、「所属清单」区的行内错误。既有函数体的改动只有三处：`enterDetail` 加一行、`actionErrorMessage` 加一行、`actionErrorKind` 的类型加一个值。
18. **「放弃我的修改」在有改动或冲突态时显示**（§4.3 写在冲突态提供；有改动时也给，作为一键还原）。
19. **焦点**：任一行内错误出现时焦点移到对应控件（§7.2 只写了 `TIME_ZONE_REQUIRED`）。
20. **六个既有 spec 的工厂补的是 `listAllTaskLists`**（FE-1 的说明，§9.4 写的是 `listTaskLists`），另补 `patchTask` / `addTaskToList` / `removeTaskFromList` / `resolveViewerTimeZone`；`tasks-labels.spec.ts` 已有 `resolveViewerTimeZone`。§9.4 的五文件表加 `tasks-labels.spec.ts` 共六个（FE-0 偏差第 8 条）。
21. **设计 §10.1 的「草稿改回编辑器自持」变异**用可观察的等价形 M27（详情块卸载时编辑器状态随之丢失）证明；「清单项写改为子组件直接调用 `addTaskToList`」用 M37（加入不占共享 pending）证明。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调（设计 §10.5 的详情编辑、两个标签页并发保存的 409）。`listIds` 与清单项路由（S7）未建，「所属清单」区只按契约。浏览器里的 `datetime-local` / `type=time` / `datalist` 呈现、夏令时缺口时刻（本地时间不存在的时刻）的换算都没有看过。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 19 个 whole-file 参数、manifest 检查模式与后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（spec 文件不在其中，只经 vitest 的 esbuild 转译）。`pnpm --filter @metasheet/web build`：NOT RUN。
- `Pacific/Chatham`、`Asia/Tokyo` 等时区名与本地时间换算只在 Node 20.20.2 的 ICU、本机时区上跑过（格的期望值用同一换算求得，不依赖本机时区）。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-5 的说明

- **我的清单读**：`TasksView.loadMyLists()`（`listAllTaskLists({ includeArchived: true })`，自己的 generation，进入详情时发）。FE-5 落 `tasks/tasksListsBus.ts` 后，在 `TasksView` 订阅 `notifyListsChanged` 并重跑 `loadMyLists()`（§4.3「进入详情与 `tasksListsBus` 事件时」）；本片没有总线。
- **mock 工厂**：六个挂载 `TasksView` 的 spec 已有 `listAllTaskLists` / `patchTask` / `addTaskToList` / `removeTaskFromList` / `resolveViewerTimeZone`。FE-5 的左栏用一页式 `listTaskLists`，要在同六个工厂补它（缺省 `{ kind: 'ok', items: [], total: 0 }`）。
- **`tasks-detail-m4.spec.ts` 的假后端**：未列出的请求记 `unexpected`，`afterEach` 断言为空；`GET /api/task-lists?…` 不分 `includeArchived` 都交给同一个 `myListsReply`。FE-5 的左栏在 `/tasks` 发的 `includeArchived=false` 读会被它回答（不进 `unexpected`）；本文件按 `myListsReply` 调用次数断言的格（晚到的我的清单读）只在两个详情页之间导航，按完整路径计数的格只数 `includeArchived=true`。FE-5 若在本文件加经过列表页的格，按 `includeArchived` 区分两个读。
- **类型**：`TaskDetailLists.vue` 的普通 `<script>` 块导出 `MyListsState` / `DetailListsError`。
- **`data-testid` 前缀**：详情区用 `tasks-detail-lists-*`（不以 `tasks-lists-` 开头），与 FE-5 左栏的 `tasks-lists-*`（`[fe-18]`）不相交。
- **登记**：FE-5 的两个 token `tasks-list-detail.spec.ts`、`tasks-lists-sidebar.spec.ts` 按 `LC_ALL=C` 序分别插在 `tasks-labels.spec.ts` 之后 / `tasks-list-view.spec.ts` 之前、`tasks-list-view.spec.ts` 之后 / `tasks-nav-badge.spec.ts` 之前；yml 计数从 Nineteen 起每片 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。

---

## FE-5 清单：左栏 `TaskListsSidebar`、清单页 `/task-lists/:id`、清单总线（设计 §2.1、§2.4、§3、§4.0–§4.2、§5.1、§9、§10、§13 FE-5；`[R04]` `[R12]` `[R13]` `[R19]` `[D14]` `[own-09]` `[own-19]` `[own-25]` `[fe-07]` `[fe-18]`；本片新取舍 `[fe-21]`–`[fe-26]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `9542914a23`（FE-4 已记 19 文件 / 1316 全绿）；起手前重跑 19 个守卫：**19 文件 / 1316 全绿** |
| 引用 `appRoutes` 的其余 20 个 spec（`grep -l appRoutes tests/*.spec.ts` 去掉三个任务文件；新增路由可能碰到路由普查类 spec） | 起手前：20 文件 / 516 过、1 败——`k3WiseSetup.spec.ts` 断言 `main.ts` 正文含 `to.meta?.permissions`，与任务线无关、既有。加路由之后：**同一个 1 败、其余 516 过**，逐格相同 |
| 契约只读来源 | `git show 510fba6917:<path>`（只读该提交）：PR-3a 设计 §3.0（行级判定一律 404 `[own-09]`；缺 org 三种答法 `[own-19]`）、§3.2（`List` 形状；`includeArchived`；归档权含创建人）、§3.3（成员——FE-6）、§3.4（清单项：加入只认任务直接角色 `[own-25]`，三条件同一 404）；PR-3a 验证 S5（S5.1–S5.9：7 条路由、`[own-32]`–`[own-36]`、前端对接表）与 S6（S6.8 前端对接表——FE-6）；`src/routes/tasks-lists.ts`（S5 的 7 条 + S6 的 5 条，**没有清单项路由**）；迁移 `zzzz20261001090000_create_task_m4_tables.ts` 的 `task_list_events.event_type` 闭集（15 个词） |
| 后端状态 | S5 清单路由与 S6 成员路由已建；**S7 清单项（`GET` / `POST …/items`、`DELETE …/items/:taskId`）在 `510fba6917` 上不存在**：今天的后端对它们回 404。清单页只按契约编码，并以格证明它在这些路由缺席时照常可用（§4 第 3 条） |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `dbd891f278` | 设计 §11 加 `[fe-19]`（409 及其他重拉之后只保留用户改过的字段，其余取重拉值，下一次保存用重拉后的 `version`）与 `[fe-20]`（S4 组的三条只读行在编辑区打开时同样渲染）；§12 加 Q15 / Q16（保守缺省：只保留改过的字段；显示只读行）。只改文档 |
| `9e5be79efd` | 实现：新 `tasks/tasksListsBus.ts`、`views/tasks/TaskListsSidebar.vue`、`views/tasks/TaskListView.vue`；`appRoutes.ts` 加 `/task-lists/:id`；`TasksView.vue` 挂左栏、接引导块与清单总线、只读行注释标 `[fe-20]`；`labels.ts`；六个挂载 `TasksView` 的 spec 只补 mock 工厂条目与 `beforeEach` 缺省，`tasks-labels.spec.ts` 另补清单页六个调用与 `FMT_ARGS` 一行 |
| `1bcbffecda` | 新 `tests/tasks-lists-sidebar.spec.ts`、`tests/tasks-list-detail.spec.ts`；`tasks-routes.spec.ts` 加 8 格；`tasks-labels.spec.ts` 加 12 格；三处登记 |
| `d5e9c4778e` | 变异轮发现两个存活（L6、L7，§6）后补格：三个跨路由 id 格；晚到归档格加数「当前清单」的读；两个「离开后才回」格改为离开到任务页（该路由同样有 `:id`） |
| `77b46343ce` | 左栏 `data-testid` 规则（`[fe-18]`）在五个读态各查一遍（原格只覆盖有行的状态，§6） |
| `ae0af8f922` | 本节初稿；设计 §11 补 `[R19]` / `[own-09]` / `[own-19]` 三行（§7 第 15 条） |
| 本文所在提交 | 设计 §11 登记本片的六个自选取舍 `[fe-21]`–`[fe-26]`、§12 加 Q17–Q22（缺省即现行为），§11 的 `[R12]` / `[D14]` / `[own-25]` 三行的位置列补上 FE-5 的文件；本节 §7 标上编号（§7 第 20 条） |

### 3. 文件（`9542914a23..77b46343ce`，19 个文件，+4224 / −77，含设计 MD 的 +4；不含本 MD）

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/tasks/tasksListsBus.ts` | +28（新） | `onListsChanged(listener)`（回退订函数）/ `notifyListsChanged()`，与 `tasksBadgeBus.ts` 同形；红点总线不动 |
| `apps/web/src/views/tasks/TaskListsSidebar.vue` | +346（新） | 左栏：一页式 `listTaskLists`（每页 100、服务端顺序）、「加载更多」、「显示已归档」复选框（缺省不勾）、六态（加载中 / 列表 / 空 / 无权限 403 / 不可用 404 / 失败）、降级体上报 `org-missing`；新建表单（`checkListName` 预检、规范化后发送、一次一个）；在 setup 里同步订阅清单总线（重读第一页），卸载时退订并推进 generation 与 token。全部 `data-testid` 以 `tasks-lists-` 开头（`[fe-18]`） |
| `apps/web/src/views/tasks/TaskListView.vue` | +790（新） | 清单页：先读 context（五态与 `TasksView` 同 id、同文案），再并行读清单与清单项（各自 generation）；页面态只取自清单读；页头（名、我的角色、已归档标、返回链接）、改名内联表单、归档 / 取消归档；清单项区（行、空、不可用、截断提示、加入任务表单、移出两步确认）；动态面板（按需读、加载更多、15 个词与未知词原样）；页面级 `pending` / 写 token / 横幅 / 引导块；路由边沿复位。`data-testid` 以 `tasks-list-detail` 开头（另复用 context 四态的 `tasks-view-*`） |
| `apps/web/src/views/tasks/TasksView.vue` | +116 / −75（`git diff -w`：+43 / −2） | 模板：列表分支在页头之后包一层两栏 `tasks-view__columns`（左 `TaskListsSidebar`，右为既有的视角切换 / 创建表单 / 横幅 / 列表，原样缩进四格——`-w` 下零改动）；只读行注释补 `[fe-20]`。脚本：两条导入；`onListsChanged` 订阅（只在 context `ready` 且在详情页时重跑 `loadMyLists()`）与 `onBeforeUnmount` 退订；`onListsOrgMissing()`（置 `orgMissingFromAction`）。−2 是 `vue` 导入行与只读行注释的一行。既有函数体零改动 |
| `apps/web/src/router/appRoutes.ts` | +9 | `/task-lists/:id`（name `task-list-detail`，懒加载 `TaskListView.vue`，meta `{ title: 'Task Lists', titleZh: '任务清单', requiresAuth: true, requiredFeature: 'tasks', permissions: ['tasks:read'] }`），写在 `/tasks/:id` 之后、兜底路由之前；注释写明无索引页、路径是 `[fe-07]` |
| `apps/web/src/tasks/labels.ts` | +161 | 两张表各加 57 键（现各 215 键）：共用 5（`loadMore`、三个角色徽标、`listArchivedMark`）、左栏 12、清单页 25、动态的 15 个事件词；格式函数加 `listRemoveTaskNamed`（清单项移出按钮的可访问名，现 8 个）；新 `TASKS_LIST_EVENT_KEYS`（闭集 15 词 → 键）与 `listEventLabel(type, t)`（只认自有属性，未知词原样返回）。`[own-09]` `[own-25]` `[R19]` 标在键组注释上 |
| `apps/web/tests/tasks-lists-sidebar.spec.ts` | +956（新） | 67 格（§5） |
| `apps/web/tests/tasks-list-detail.spec.ts` | +1245（新） | 101 格（§5） |
| `apps/web/tests/tasks-routes.spec.ts` | +102 | 只加两个新 `describe`（8 格）；既有 22 格零改动 |
| `apps/web/tests/tasks-labels.spec.ts` | +402 / −1 | 12 格（事件词表 1；左栏 EN 三格、ZH 正控一格、翻转一格；清单页 EN 四格、ZH 正控一格、翻转一格）；工厂补 `listTaskLists` / `createTaskList` 与清单页的 `getTaskList` / `renameTaskList` / `archiveTaskList` / `unarchiveTaskList` / `listTaskListItems` / `listTaskListEvents`，`beforeEach` 缺省；`FMT_ARGS` 加 `listRemoveTaskNamed`；新挂载 helper `mountListPage()`；−1 是头注一行改写。既有断言零改动 |
| `apps/web/tests/tasks-view.spec.ts`、`tasks-list-view.spec.ts`、`tasks-detail-view.spec.ts`、`tasks-view-transitions.spec.ts`、`tasks-detail-m3.spec.ts` | 各 +9 | 只补 `tasksApi` 工厂条目 `listTaskLists` / `createTaskList`、对应的 hoisted `vi.fn()`（带三行注释）与 `beforeEach` 缺省（`listTaskLists` ⇒ `{ kind: 'ok', items: [], total: 0 }`）；**断言零改动** |
| `apps/web/scripts/run-required-web-tests.sh` | +2（:1826、:1828） | `tasks-list-detail.spec.ts` 插在 `tasks-labels.spec.ts` 与 `tasks-list-view.spec.ts` 之间，`tasks-lists-sidebar.spec.ts` 插在 `tasks-list-view.spec.ts` 与 `tasks-nav-badge.spec.ts` 之间（`LC_ALL=C` 序：`-` 先于 `s`） |
| `apps/web/scripts/run-required-web-tests.tokens` | +2（:493、:495） | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（557 token） |
| `.github/workflows/tasks-web-guard.yml` | +16 / −1 | step 参数插入两行（:168、:170，同序）；「Nineteen whole-file args」→「**Twenty-one** whole-file args」（:153，两个新文件）；头注加 FE-5 一段（:70–81，裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现在 :156） |
| `docs/development/task-m4-frontend-design-20261007.md` | +4（`dbd891f278`）；`ae0af8f922` 再 +3；本文所在提交再 +15 / −3 | §11 / §12（见 §2） |

### 4. 行为规则（spec 按这些出格）

- **入口与门**：`/task-lists/:id` 的 meta 与 `/tasks` 同形（含 `requiredFeature: 'tasks'`、`permissions: ['tasks:read']`）；没有 `/task-lists` 索引路由（由 `appRoutes` 建的真路由把 `/task-lists` 解析到兜底路由）；左栏只在 `/tasks` 的 `ready` 列表分支内渲染，于是入口与页面同在 #6173 的门内。context 非 `ready` 时左栏不渲染、不发清单读；详情页没有左栏。
- **左栏的位置与 id**：在页头之后（页头的 `<h1>` 仍是文档里第一个 `h1`，左栏用 `<h2>`）；任务列表在加载中 / 空 / 失败 / 有行四种状态下左栏都在；左栏内全部 `data-testid` 以 `tasks-lists-` 开头，且与 `tasks-view.spec.ts` 计数的列表页状态 id 集合不相交（`[fe-18]`）。
- **左栏读**：首屏恰一个请求 `GET /api/task-lists?includeArchived=false&limit=100&offset=0`；行按服务端顺序，显示名（链接 `/task-lists/<encodeURIComponent(id)>`）、角色徽标（所有者 / 可编辑 / 只读）、已归档标；`200` 空 ⇒「还没有清单」；500 / 畸形 200 / 缺 `total` / 传输失败 ⇒「加载清单失败，请稍后重试」（`role="alert"`）；403 ⇒「您没有权限查看任务清单」；404（后端没有清单路由）⇒「清单功能暂不可用」，列表页其余部分照常；降级体 `reason: 'org_missing'` ⇒ 整个列表页换成引导块（与列表读同一块）；其他 `reason` 的降级体 ⇒ 失败态。
- **加载更多**：`total` 大于已读行数且上一页非空时显示；下一页从「已读行数」作 offset；跨页重复的行只留一次；空页结束翻页；下一页失败 ⇒ 已有行保留、旁注失败、按钮留着可重试；请求进行中按钮禁用，处理函数也只受理一次。
- **已归档**：复选框缺省不勾；勾 / 取消勾都从 offset 0 以新的 generation 重读（`includeArchived=true` / `false`）；勾之前发出、勾之后才回的首页或下一页结果都被丢弃。
- **新建**：名称全空白时按钮禁用；预检（`checkListName`）：只含零宽字符或含 U+0000 ⇒「名称不能为空」、101 码点 ⇒「名称过长」，都不发请求，100 码点照发；请求体是规范化后的名字（修边、NFC）；服务端 422 `INVALID_NAME` / `NAME_TOO_LONG` 落输入框旁，契约外的码 ⇒ 回退文案，输入保留；403 ⇒「您没有权限创建清单」；404 ⇒「清单功能暂不可用」；500 / 畸形 200 / 传输失败 ⇒「创建清单失败，请稍后重试」；422 `ORG_MISSING` ⇒ 引导块；`ok` ⇒ 清空输入、清单总线通知一次（左栏借自己的订阅重读第一页，勾选状态照旧）、打开新清单页；红点总线不通知。一次一个：进行中输入框与按钮禁用，再派发提交也只发一次。离开到任务页之后才回的 `ok` 不导航，只通知清单总线。
- **清单页读**：context 未回 ⇒「加载中…」且不发任何请求；context 四个非 `ready` 态与 `TasksView` 同 id、同文案，且不发清单请求；`ready` 后清单与清单项两个请求在任一回包之前都已发出。**页面态只取自清单读**：404 ⇒「清单不存在或你不是成员」（`tasks-list-detail-not-found`）、403 ⇒「您没有权限查看此清单」（`tasks-list-detail-forbidden`，两者 id 不同）、500 / 畸形 / 闭集外的 `myRole` / 传输失败 ⇒「加载清单失败，请稍后重试」；三者都不渲染页头控件与清单项区，标题回到「任务清单」。不是安全路径段的 id（`..`、`%2E%2E`、`.`、`%2E`）⇒ not_found，且没有任何 `/api/task-lists…` 请求到达传输层。
- **清单项区**：行链接到 `/tasks/:id`，显示状态与截止瞬时（`formatViewerInstant`）；空 ⇒「清单中还没有任务」（加入表单仍在）；**清单项读的任何失败（含今天后端的 404）⇒「暂时无法读取清单中的任务」，页头、改名、归档照常，页面不转 not_found**，加入表单在清单项读非 `ok` 时不渲染；降级体 ⇒ 引导块；读满 20 页仍有余 ⇒ 渲染已读的 2000 行并提示「清单中的任务较多，未全部显示」。
- **按角色的控件（§5.1）**：`owner` 与 `edit` ⇒ 改名、归档（或取消归档）、加入任务、移出任务；`read` 且不是创建人 ⇒ 都没有；`read` 且是创建人 ⇒ 只有归档 / 取消归档；创建人这一半只在当前用户 id 已解析出来时成立（解析中隐藏、解析回 `null` 或抛错隐藏，解析完成后出现）；已归档清单显示「已归档」与「取消归档」；页面没有删除清单的控件（`[R13]`）。
- **改名**：打开时输入框预填现名，取消即关、不发请求；预检同新建（只含零宽 / 含 U+0000 / 101 码点各一格，`aria-invalid` 与 `aria-describedby` 指向错误节点），100 码点照发；同名照发（服务端空操作 200）并重读；`ok` ⇒ 请求体为规范化后的名字、表单关闭、清单重读一次（页头显示新名）、清单总线通知一次、红点总线不动；422 两码与契约外的码落输入框旁、表单留着、不重读、总线不通知；404 ⇒ 横幅「清单不可用或你已不是成员」、403 ⇒「您没有权限修改此清单」、500 / 畸形 / 传输失败 ⇒「操作失败，请稍后重试」（横幅 `role="alert"`）；`ORG_MISSING` ⇒ 引导块；再次输入清掉行内错误；下一次写先清掉上一次的横幅。
- **归档 / 取消归档**：`POST …/archive` / `…/unarchive`（无请求体）；`ok` ⇒ 重读清单，页面显示重读结果（不是写响应）、清单总线通知一次；失败（404 / 403 / 500 / 契约外 422）⇒ 横幅、不重读、总线不通知；`ORG_MISSING` ⇒ 引导块。
- **加入任务**：空白 id 按钮禁用、派发提交也不发；请求体 `{"taskId":"t9"}`（修边）；`ok` ⇒ 清空输入、只重读清单项（清单不重读）、两条总线都不通知；`INVALID_TASK` ⇒「无效的任务」、`LIMIT` ⇒「一个任务最多属于 10 个清单」、契约外码 ⇒ 回退文案、404 ⇒「任务不存在、你不能编辑它，或清单不可用」，四者落表单旁且保留输入；403 / 500 ⇒ 横幅；`ORG_MISSING` ⇒ 引导块。
- **移出任务**：按钮的可访问名「将「标题」移出清单」；两步内联确认（取消不发）；确认 ⇒ `DELETE …/items/:taskId`、只重读清单项、总线不通知；不是安全路径段的任务 id ⇒ 不到传输层、横幅「清单不可用或你已不是成员」；失败 ⇒ 横幅、确认块收起、不重读。
- **一次一个**：任何写进行中，改名输入 / 保存 / 取消、归档、加入任务的输入与按钮、移出按钮与确认按钮全部禁用，内容区 `aria-busy="true"`；直接派发的第二次提交 / 点击都不发请求；`ok` 之后的重读完成前控件保持禁用。
- **路由边沿与晚到**：`/task-lists/a` → `/task-lists/b` 复位横幅、改名表单与其错误、加入输入与其错误、移出确认、动态面板（收起），再读 b；a 的清单读 / 清单项读晚到不覆盖 b；归档进行中换到 b、`ok` 晚到 ⇒ a 与 b 都不重读、b 不显示已归档、清单总线仍通知一次；改名的晚到 403 不画横幅；加入的晚到 404 不画行内错误；移出的晚到 `ok` 不重读 a 的清单项；离开到任务页（同样有 `:id`）之后才回的改名 `ok` / 加入 `ok` 不发任何请求，改名仍通知清单总线一次。三个跨路由格：左栏链接打开清单页、从任务页打开清单页、从清单项打开任务页，都没有以另一路由的 `:id` 发出的读。
- **动态**：缺省收起、不读；展开 ⇒ `aria-expanded="true"`、读 `…/events?limit=100&offset=0`；每条显示操作者、事件词、时间（`formatViewerInstant`）；15 个闭集词各有文案，未知词原样；空 ⇒「暂无动态」、读失败（含 404）⇒「加载动态失败，请稍后重试」；加载更多按 100 翻页、重复行留一次、失败保留已有行并旁注；收起时进行中的读作废，重新展开再读；换清单时面板收起，旧清单的读晚到不展开新清单的面板；降级体 ⇒ 引导块。
- **清单总线**：在 `/tasks` 上通知 ⇒ 左栏重读第一页（勾选状态照旧），`TasksView` 不读「我的清单」；在任务详情页上通知 ⇒ `TasksView` 重读「我的清单」（`includeArchived=true`，读全部页），没有左栏读；context 非 `ready` 的详情页 ⇒ 什么都不读；从 `/tasks` 到任务页之后只有任务页在听（左栏已退订）；页面卸载之后无人再读；context 未回时就卸载的左栏不留订阅。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts tests/tasks- --reporter=verbose`（`apps/web`，`77b46343ce`；`1bcbffecda` 上 1500、`d5e9c4778e` 上 1503，同绿） | **21 文件 / 1504 用例全绿**（1316 既有 + 67 + 101 新文件 + 8 routes + 12 labels），0 个 `×` |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`d5e9c4778e`；其后只改 spec） | 退出 0，0 行输出 |
| D = T = G | `D`=`T`=`G`=20 个 `tasks*.spec.ts`；yml 21 个 whole-file 参数（+`tests/App.spec.ts`）；yml 中 `vitest run` 只出现 1 次（:156） |
| `node scripts/ops/required-web-lane-token-manifest.mjs --write`，再跑检查模式 | 写入 557 token；检查模式 `MANIFEST MATCHES`，557 token |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（两个新 token） | 各自文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 555 个 token 的双向子串碰撞 0 |
| 引用 `appRoutes` 的其余 20 个 spec（§1） | 20 文件：516 过、1 败（`k3WiseSetup.spec.ts`，起手前即败，与起手前逐格相同） |
| 字面扫描器 v1（19 个改动文件 + 本 MD + 设计 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（`9542914a23..77b46343ce` 的 diff + 本 MD） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-m4` 111、`tasks-detail-view` 44、`tasks-labels` **68**（56 + 12）、**`tasks-list-detail` 101（新）**、`tasks-list-view` 32、**`tasks-lists-sidebar` 67（新）**、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` **30**（22 + 8）、`tasks-settings-view` 71、`tasks-view-transitions` 14、`tasks-view` 7。其余 16 个既有文件的计数与 FE-4 相同。

`tasks-lists-sidebar.spec.ts` 的 67 格：位置与 id 12（含 id 规则在五个读态各查一遍、任务列表四种状态、详情页无左栏、context 四态不读）；读 16（含跨路由两格）；加载更多 6；已归档 6；新建 20；清单总线 7。`afterEach` 断言假后端没有收到任何未列出的请求，并退订格内的总线监听。

`tasks-list-detail.spec.ts` 的 101 格：context 与页面态 16（含四个不安全路径段）；清单项 10（含跨路由一格）；按角色的控件 10；改名 19；归档 / 取消归档 8；加入任务 10；移出任务 6；一次一个 4；路由边沿与晚到 9；动态 9。同样断言没有未列出的请求。

`tasks-routes.spec.ts` 新 8 格：meta 精确相等 + 名称 + 懒加载 + 投影；真路由解析（含编码的 id、`/task-lists` 落兜底、`appRoutes` 里 `/task-lists` 开头的记录恰为一条）；门 22 的 allow / redirect / 焦点-attendance / 焦点-plm / feature-off 五格；真实 store 缺省（feature off）+ 管理员 ⇒ `/home`。

`tasks-labels.spec.ts` 新 12 格：事件词表 1（15 个词两种语言都有自己的文案，未知词与原型名原样返回）；左栏 EN 三格（行与角色 / 已归档 / 复选框 / 新建 / 加载更多；五个读态；新建的各码与加载更多失败）、ZH 正控一格、挂载后翻转一格；清单页 EN 四格（满页面含动态全部 15 词与一个未知词；页面三态、清单项四态、动态三态；改名 / 横幅 / 加入 / 加载更多的错误文案；context 五态）、ZH 正控一格、挂载后翻转一格。

### 6. 变异证据

脚本驱动（脚本不入库；与 FE-3 / FE-4 同一个执行器）：断言每个 `old` 文本在其文件中（按编辑顺序）恰出现一次 → 备份 → 改坏（一个变异可跨多处 / 多文件）→ 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。

- 第一轮（`1bcbffecda`）：跑到 P2 时 P3 的 `old` 文本在 `tasksApi.ts` 里出现两次，脚本在改写前停下（备份已还原、`git status` 干净）；已跑的 57 个里 **L6、L7 存活**。原因：清单页的重读按「当前路由的 id」发出。L6（归档去掉写 token 检查）的晚到 `ok` 重读的是 b 而不是 a，原格只数 a 的读；L7（离开时不推进写 token）在离开到 `/tasks` 时 id 为空、请求被路径段检查拦下，所以看不出来。补格（`d5e9c4778e`）：晚到归档格加数 b 的读；两个「离开后才回」格改为离开到任务页（`/tasks/t1`，同样有 `:id`），并断言离开之后零请求。P3 的 `old` 加上函数签名。补格后先单跑 L6、L7 与第一轮没跑到的 21 个（`ONLY=…`，同一执行器），全部如预期，再整轮重跑。
- 第二轮在 `d5e9c4778e` 上整轮重跑：78 个，77 红、1 个（P4v）按预期仍绿。检查各变异的杀伤格时发现 X6 只被左栏空态格与既有 `tasks-list-view.spec.ts` 抓到，左栏 id 规则格只覆盖有行的状态；补全态格（`77b46343ce`，只改 spec）。
- 最终一轮在 `77b46343ce` 上整轮重跑：**78 个变异，77 个变红，1 个（P4v）按预期仍绿为视图层等价变异；78 组文件还原全部逐字节一致；轮后 `git status` 干净**。与第二轮逐行相同，只有 C3 / C4 / X6 / X11 各多一个变红的格（新的全态格）。下表即最终一轮。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| R1 | 清单路由去掉 `requiredFeature` | `appRoutes.ts` | `tasks-routes` | 红（3）：meta 格、feature-off 格、真实 store 缺省格 | 一致 |
| R2 | 清单路由去掉 `permissions` | `appRoutes.ts` | `tasks-routes` | 红（2）：meta 格、redirect 格 | 一致 |
| R3 | 路径写成 `/task-list/:id` | `appRoutes.ts` | `tasks-routes` | 红（8） | 一致 |
| R4 | 懒加载改指 `TasksView.vue` | `appRoutes.ts` | `tasks-routes` | 红（1） | 一致 |
| A1 | 已归档缺省显示（复选框缺省勾） | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（17） | 一致 |
| A2 | 勾选不重读 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（7） | 一致 |
| A3 | 重读从下一页的 offset 起而不是 0 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（7） | 一致 |
| N1 | 新建跳过名称预检 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（4） | 一致 |
| N2 | 新建发原串而不是规范化后的名字 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| N3 | 改名跳过名称预检 | `TaskListView.vue` | `tasks-list-detail` | 红（5） | 一致 |
| N4 | 改名发原串 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| V1 | `read` 成员也有改名 / 加入 / 移出 | `TaskListView.vue` | `tasks-list-detail` | 红（6） | 一致 |
| V2 | `edit` 成员没有管理控件（只认 `owner`） | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| V3 | 归档不认创建人 | `TaskListView.vue` | `tasks-list-detail` | 红（3） | 一致 |
| V4 | 归档对每个成员都显示 | `TaskListView.vue` | `tasks-list-detail` | 红（4） | 一致 |
| V5 | 清单项读失败时仍渲染加入表单 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| S1 | 取消归档发的是归档请求 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| S2 | 归档 `ok` 不重读清单 | `TaskListView.vue` | `tasks-list-detail` | 红（4） | 一致 |
| S3 | 归档 / 取消归档按钮按 `archivedAt` 取反 | `TaskListView.vue` | `tasks-list-detail` | 红（21） | 一致 |
| S4 | 改名 `ok` 不重读清单 | `TaskListView.vue` | `tasks-list-detail` | 红（2） | 一致 |
| C1 | 新建 403 用通用失败文案 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| C2 | 新建 404 用通用失败文案 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| C3 | 左栏读 404 渲染为失败态 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（2） | 一致 |
| C4 | 左栏读 403 渲染为失败态 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（2） | 一致 |
| C5 | 清单页横幅的 404 / 403 文案对调 | `TaskListView.vue` | `tasks-list-detail` | 红（8） | 一致 |
| C6 | 加入任务的 `LIMIT` 用通用「人数已达上限」 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| C7 | 加入任务的 404 落横幅 | `TaskListView.vue` | `tasks-list-detail` | 红（3） | 一致 |
| C8 | 改名的 422 码落横幅而不是输入框旁 | `TaskListView.vue` | `tasks-list-detail` | 红（3） | 一致 |
| C9 | 未知事件词显示回退文案而不是原词 | `labels.ts` | `tasks-list-detail`、`tasks-labels` | 红（3）：两个文件各有格 | 一致 |
| F1 | 清单读 403 渲染为 not_found | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| F2 | 清单项读 404 把整页翻成 not_found | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| L1 | 左栏首页读去掉 generation 判断 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| L2 | 左栏下一页读去掉 generation 判断 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| L3 | 左栏卸载不推进新建 token（晚到 `ok` 导航） | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| L4 | 清单读去掉 generation 判断 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| L5 | 清单项读去掉 generation 判断 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| L6 | 归档去掉写 token 判断 | `TaskListView.vue` | `tasks-list-detail` | 红（1）：晚到归档格数到 b 的第二次读（第一轮存活，见上） | 一致 |
| L7 | 卸载不推进写 token | `TaskListView.vue` | `tasks-list-detail` | 红（2）：离开到任务页之后的改名 / 加入格（第一轮存活，见上） | 一致 |
| L8 | 动态首页读去掉 generation 判断 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| L9 | 路由边沿不复位页面 | `TaskListView.vue` | `tasks-list-detail` | 红（5） | 一致 |
| L10 | 加入任务去掉写 token 判断 | `TaskListView.vue` | `tasks-list-detail` | 红（2） | 一致 |
| O1 | 改名处理函数在别的写进行中仍受理 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| O2 | 改名不占 `pending` | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| O3 | 归档按钮不看 `pending` | `TaskListView.vue` | `tasks-list-detail` | 红（3） | 一致 |
| O4 | `ok` 之后的重读完成前就释放 `pending` | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| O5 | 左栏新建处理函数在进行中仍受理 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| O6 | 左栏下一页处理函数在进行中仍受理 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| B1 | 左栏不订阅清单总线 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（4） | 一致 |
| B2 | 左栏卸载不退订 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（9） | 一致 |
| B3 | `TasksView` 不订阅清单总线 | `TasksView.vue` | `tasks-lists-sidebar` | 红（2） | 一致 |
| B4 | `TasksView` 在列表页也重读「我的清单」 | `TasksView.vue` | `tasks-lists-sidebar` | 红（4） | 一致 |
| B5 | `TasksView` 在 context 未 `ready` 时也重读 | `TasksView.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| B6 | 归档 `ok` 不通知清单总线 | `TaskListView.vue` | `tasks-list-detail` | 红（3） | 一致 |
| B7 | 归档只在及时回包时通知（晚到不通知） | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| B8 | 新建 `ok` 不通知清单总线（于是也不重读） | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（3） | 一致 |
| P1 | `getTaskList` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-list-detail` | 红（4）：四个不安全路径段格 | 一致 |
| P2 | `listTaskListItems` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-list-detail` | 红（4） | 一致 |
| P3 | `removeTaskFromList` 去掉任务 id 的检查 | `tasksApi.ts` | `tasks-list-detail` | 红（1） | 一致 |
| P4 | `renameTaskList` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-list-detail`、`tasks-api-m4` | 红（3）：**只有 `tasks-api-m4`（FE-1）红** | 一致 |
| P5 | `archiveTaskList` / `unarchiveTaskList` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-list-detail`、`tasks-api-m4` | 红（6）：只有 `tasks-api-m4` 红 | 一致 |
| P6 | `listTaskListEvents` 去掉 `isPathSafeSegment` | `tasksApi.ts` | `tasks-list-detail`、`tasks-api-m4` | 红（3）：只有 `tasks-api-m4` 红 | 一致 |
| P4v | 同 P4，只跑视图 spec | `tasksApi.ts` | `tasks-list-detail` | **仍绿（视图层等价变异）**：清单读先拒掉不安全的 id，页面停在 not_found，改名 / 归档 / 动态的控件都不渲染，三个写 / 读函数的路径检查从视图不可达；它们由 FE-1 的 `tasks-api-m4` 路径段格证明（P4–P6） | 一致 |
| X1 | 加入任务发未修边的 id | `TaskListView.vue` | `tasks-list-detail` | 红（2） | 一致 |
| X2 | 移出不经确认 | `TaskListView.vue` | `tasks-list-detail` | 红（8） | 一致 |
| X3 | 加入 `ok` 不重读清单项 | `TaskListView.vue` | `tasks-list-detail` | 红（1） | 一致 |
| X4 | 动态在挂载时就读而不是按需 | `TaskListView.vue` | `tasks-list-detail` | 红（5） | 一致 |
| X5 | 截断不提示 | `TaskListView.vue` | `tasks-list-detail`、`tasks-labels` | 红（2）：两个文件各一格 | 一致 |
| X6 | 左栏空态改用 `tasks-list-empty` | `TaskListsSidebar.vue` | `tasks-lists-sidebar`、`tasks-view`、`tasks-list-view` | 红（4）：本片的全态 id 格与空态格，加上**既有** `tasks-list-view.spec.ts` 的两格（有行时、`predicate_error` 时断言 `tasks-list-empty` 不在）同时红；`tasks-view.spec.ts` 仍绿（见 §7 第 13 条） | 一致 |
| X7 | 新建 `ok` 不打开新清单 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（2） | 一致 |
| X8 | 跨页重复的行留两次 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| X9 | 加载更多不看空页 | `TaskListsSidebar.vue` | `tasks-lists-sidebar` | 红（1） | 一致 |
| X10 | `TasksView` 不理会左栏的 org 上报 | `TasksView.vue` | `tasks-lists-sidebar` | 红（2） | 一致 |
| X11 | 列表页不挂左栏 | `TasksView.vue` | `tasks-lists-sidebar`、`tasks-labels` | 红（59） | 一致 |
| T1 | EN 的左栏标题写成中文 | `labels.ts` | `tasks-labels` | 红（14） | 一致 |
| T2 | 左栏文案表在 setup 时一次性求值（`ref` 代替 `computed`） | `TaskListsSidebar.vue` | `tasks-labels` | 红（2）：翻转格 | 一致 |
| T3 | 清单页文案表一次性求值 | `TaskListView.vue` | `tasks-labels` | 红（1）：翻转格 | 一致 |
| T4 | 清单页清单项标题硬编码中文 | `TaskListView.vue` | `tasks-labels` | 红（4）：EN 扫描格 | 一致 |
| T5 | EN 的「归档了清单」写成中文 | `labels.ts` | `tasks-labels` | 红（3） | 一致 |

简报点名的目标全部覆盖：路由 meta 与门（R1–R4）；已归档缺省隐藏与切换（A1–A3）；新建 / 改名的名称规则（N1–N4）；按角色的控件显隐（V1–V5）；归档 / 取消归档状态（S1–S4）；每个码 → 文案（C1–C9）；晚到守卫（L1–L10）；一次一个（O1–O6）；清单总线的订阅与重读（B1–B8）；每个清单 id 的路径段（P1–P3 视图可达，P4–P6 视图不可达、由 FE-1 的 spec 证明，P4v 记等价）；not_found 对 forbidden 与「页面态只取自清单读」（F1、F2）。设计 §10.1 FE-5 两行最右列：去掉 generation ⇒ 晚到格红（L1、L2）；新建成功不跳转（X7）；左栏某节点改用 `tasks-list-empty`（X6）；改名成功不重读（S4）；`read` 角色仍显示改名表单（V1）；id 变化不复位草稿（L9）。

### 7. 与设计的偏差 / 解释

1. **本片的清单页只读清单与清单项两面**：设计 §4.2 的「四读并行」里的分组与摆放读、分组板、「任一板读失败 ⇒ 平铺 + 提示」与「截断 ⇒ 禁用重排」属于 FE-7（S8）；成员对话框与 §5.1 的成员各行属于 FE-6。本片的清单项按平铺列表渲染（`tasks-list-detail-items`），截断只提示、不涉及重排（还没有重排）。§10.1 `tasks-list-detail` 行的这几格随 FE-6 / FE-7 补进各自的 spec。
2. **「容忍清单项路由缺席」的落法**（`[fe-21]`）：页面态只取自清单读；清单项读的任何失败（今天后端的 404 在内）只把清单项区换成「暂时无法读取清单中的任务」，页头与改名、归档照常；加入表单只在清单项读 `ok` 时渲染（读失败时多半写也会失败，不摆一个必败的表单）。F2 / V5 钉住。
3. **改名、归档、取消归档只在清单页**（设计 §2.4 / §4.2），左栏只有列表、勾选与新建（§4.1）。
4. **清单总线**（`[fe-23]`）：发布者是清单页的改名 / 归档 / 取消归档 `ok` 与左栏的新建 `ok`；设计 §4.2 只写了归档 / 取消归档，本片把改名与新建也算进来（清单名与「我的清单」都变了）。晚到的 `ok` 仍通知（服务端状态确实变了，与 FE-3 设置页晚到 `ok` 仍通知红点同一口径）。订阅者是左栏（重读第一页）与 `TasksView`（只在 context `ready` 且在详情页时重跑 `loadMyLists()`：「我的清单」只在详情页显示，进入详情本来就读）。今天的布局里清单页与 `TasksView` 不会同时挂载，所以总线在应用里真正送达的只有左栏自己的新建；spec 直接调用 `notifyListsChanged()` 证明两个订阅者的行为。加入 / 移出清单项不通知任何总线（「我的清单」与红点都不看清单项）。
5. **左栏新建后的「重读第一页」走自己的总线订阅**（`[fe-23]`），不另写一次重读：一条路径，避免同一事件读两次。B8 证明去掉通知即不再重读。
6. **左栏读的 404 渲染为「清单功能暂不可用」**而不是失败态（`[fe-22]`）：PR-3a 合并前的后端没有清单路由，这是可预期的状态，不该显示成「请稍后重试」；403 与其他失败各有文案（C3、C4）。
7. **路径段**：视图不另做 `isPathSafeSegment`，检查在 API 函数里（FE-1，FE-4 第 16 条同一做法）。视图可达的三处由格证明（清单读、清单项读、移出时的任务 id，P1–P3）；改名、归档 / 取消归档、动态三处在视图上不可达（清单读先拒，页面停在 not_found），只由 `tasks-api-m4.spec.ts` 证明（P4–P6），P4v 记为视图层等价变异。左栏的行链接只编码 id、不过滤：链接是导航不是请求，打开后由清单页拒绝。
8. **写成功后的重读是「安静」的**（`[fe-24]`）：页面保留现有内容直到重读回来（`TasksView` 的 `loadDetail` 会先置 `loading`），`pending` 保持到重读完成（O4 钉住）。重读失败照常把页面换成对应状态。写的 404 / 403 / 失败只出页面横幅、不重读清单——§5.3 对成员对话框的 404 是「横幅并重读清单行」，清单页的写没有照搬，作为 §12-Q20 请 owner 定。
9. **改名同名照发**（设计 §4.2「同名空操作仍 200，照常重读」），保存按钮只在空白时禁用。
10. **动态行只显示操作者、事件词与时间**，不读 `payload`（成员事件的 `targetUserId`、清单项事件的 `taskId`）：设计只要求事件词；需要时 FE-6 / FE-7 加。面板每次展开都重读第一页，换清单时收起（`[fe-25]`）。
11. **文案来源**：取自设计原文的 ZH 文案——「还没有清单」「显示已归档」「加载更多」「所有者 / 可编辑 / 只读」「已归档」「新建清单」（§4.1、§2.4）、「清单不存在或你不是成员」「任务不存在、你不能编辑它，或清单不可用」（§4.2）、「清单不可用或你已不是成员」（§5.3 的 404，本片用于清单页写 404 的横幅）、「我的角色」「归档」「取消归档」「动态」「加入任务」（§2.4）、「改名」「清单动态」（§1.1）、「任务清单」（§2.1 的 `titleZh`）、「一个任务最多属于 10 个清单」（§9.2，既有键）。其余 ZH 文案（左栏的读态 / 新建失败三条 / 输入标签与占位、清单页的无权限 / 失败 / 写 403 / 清单项区四条 / 加入表单标签与占位 / 移出两条 / 动态的标题之外三条、15 个事件词）与全部 EN 是本片新写。
12. **键名 `listLoadFailed` 已被 M2 列表页占用**，清单页的读失败用 `listPageLoadFailed`。
13. **X6 只让既有的 `tasks-list-view.spec.ts` 红，`tasks-view.spec.ts` 仍绿**：设计 §10.1 写的是后者的精确集合格会红。实际上该格的 `shown()` 按 id 过滤 TESTIDS，左栏空态与列表空态同名时集合里仍只有一个 `tasks-list-empty`，结果不变；抓到它的既有守卫是 `tasks-list-view.spec.ts` 里「有行 / `predicate_error` 时 `tasks-list-empty` 不在」的两格，本片另有全态 id 格。结论不变：同名会让既有守卫红。
14. **`TasksView.vue` 的模板改动是包一层两栏容器并整段缩进**（`git diff -w` 只剩 +43 / −2）；既有 `data-testid`、文案与第一个 `h1` 都不变（写前对既有 spec 做过 grep：按标签取元素的只有页头 `h1`、编辑区 / 清单区内的 `h3`、详情区内的 `a`、设置页 `fieldset` 内的 `label`、壳层的 `button` 与登录页的 `input` / `form`，都不会先命中左栏）。
15. **`ASSUMPTION(task-m4-fe)` 标签**：清单页 `[R12]`（§5.1 的角色规则）、`[R04]`（行只链接任务自己的页面）、`[R19]`（动态，按需读）、`[D14]`（名称 100 码点、`LIMIT` = 单任务 10 清单）、`[own-25]`（加入 404 的合写文案）；左栏 `[own-19]`（缺 org 的降级体 ⇒ 引导块）、`[D14]`；`labels.ts` 的 `[own-09]`（not_found 文案合写两种原因）。设计 §11 的全表原先没有 `[R19]`、`[own-09]`、`[own-19]` 三行（`[own-19]` 是 FE-3 补标的），本文所在提交把三行补进 §11；路由的路径与无索引页是 `[fe-07]`（自选取舍，不带 `ASSUMPTION` 前缀）。
16. **当前用户 id**：清单页自己解析一次（`useAuth().getCurrentUserId()`，三态 `pending` / `known` / `unavailable`，与 `TasksView` 同一做法），只用于归档的创建人那一半；解析失败隐藏（§5.1），解析中同样隐藏（§5.1 只写了 `unavailable`，`[fe-26]`）。
17. **Vue 3.5 不投递已卸载组件的 `emit`**（`runtime-core` 的 `emit` 在 `instance.isUnmounted` 时直接返回）：左栏卸载后才回的 `ORG_MISSING` 本来就到不了 `TasksView`；左栏卸载时推进 token 的必要性由「晚到 `ok` 不导航」格证明（L3）。
18. **跨路由的 `:id`**：两个视图都从 `route.params.id` 取 id，而 `/tasks/:id` 与 `/task-lists/:id` 都有这个参数。三个跨路由格证明离开时旧视图的 id 监听不会以另一路由的 id 发请求（`RouterView` 先卸载旧视图）；但写处理函数在等待之后的重读按「当前路由的 id」取值，所以写 token 是唯一的拦截点——L6 / L7 的补格正是钉这一点。
19. **既有 spec 的工厂补的是 `listTaskLists` 与 `createTaskList`**（FE-4 第 20 条的六文件表），`tasks-labels.spec.ts` 另补清单页的六个调用；`tasks-detail-m4.spec.ts` 与 `tasks-settings-view.spec.ts` 用 `importActual` 加假 `apiFetch`，不改：前者的 `myListsReply` 回答左栏在三个经过 `/tasks` 的格里发出的 `includeArchived=false` 读（这三格不按调用次数断言），后者的假后端对 `/api/task-lists` 回 404，左栏渲染「清单功能暂不可用」，两个文件的断言都不受影响。

20. **本片六个自选取舍登记为 `[fe-21]`–`[fe-26]`**（设计 §11，§12-Q17–Q22，缺省即现行为）：第 2、4–6、8、10、16 条。代码注释暂未标这些编号：最终变异轮跑在 `77b46343ce` 的源码上，改源码注释就要重跑 21 个文件、vue-tsc 与整轮变异；留给 FE-8 一并补标（FE-4 的 `[fe-20]` 已在本片的 `TasksView.vue` 注释里）。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调（设计 §10.5 的清单项 NOT RUN）；S5 的清单路由与 S6 的成员路由已建但未联调；**S7 清单项路由未建**，清单项区、加入、移出只按契约。两栏布局、窄屏折行、`aria-busy` 与焦点的实际表现都没在浏览器里看过。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 21 个 whole-file 参数、manifest 写入与检查模式、后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（spec 文件不在其中，只经 vitest 的 esbuild 转译）。`pnpm --filter @metasheet/web build`：NOT RUN。
- 引用 `appRoutes` 的其余 20 个 spec 只跑了这一组；整个 `apps/web` 的 vitest 全量没有跑。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-6 / FE-7 的说明

- **FE-6（成员）**：对话框挂在清单页页头（`[成员]` 按钮还没有）。清单页的 `pending` 现在是 `TaskListView` 自己的 `ref`，对话框按设计 §4.0 用 `v-model:pending` 共享；当前用户 id 已由 `ensureCurrentUser()` 解析（`currentUserId` / `currentUserStatus`），本人退出、`canRemove` 的本人那一条直接用；转让成功后用 `loadList({ quiet: true })` 重读页头；本人退出成功后 `notifyListsChanged()` 并 `router.push('/tasks')`——清单页目前没有调用 `useRouter()`，加上后 `tasks-list-detail.spec.ts` 是真路由，不需要 mock。成员读与写的路径段检查都在 FE-1 的函数里。
- **FE-7（分组）**：用分组板替换 `tasks-list-detail-items` 这个平铺 `<ul>`（板的根容器是 `tasks-list`，§6.1）；清单页的读序加分组与摆放两读（各自 generation），截断时禁用重排；加入 / 移出成功后的重读从「清单项」扩成「清单项 + 摆放」两面（`loadItems({ quiet })` 已在）。六个挂载 `TasksView` 的 spec 的工厂再补 `listUserGroups` / `listUserGroupItems`。
- **清单总线**：spec 用真实模块，在格内 `onListsChanged(spy)` 订阅并在 `afterEach` 退订（两个新文件的 `watchBus()`）。
- **登记**：FE-6 的 `tasks-list-members.spec.ts` 按 `LC_ALL=C` 序插在 `tasks-list-detail.spec.ts` 与 `tasks-list-view.spec.ts` 之间；FE-7 的 `tasks-groups.spec.ts` 插在 `tasks-detail-view.spec.ts` 与 `tasks-labels.spec.ts` 之间；yml 计数从 Twenty-one 起每个新文件 +1；`.tokens` 只用 `--write` 再生成；每片结束跑 D = T = G、manifest 检查模式与后端守卫。

---

## FE-6 成员对话框（设计 §4.0、§5、§9、§10、§13 FE-6；`[R12]` `[own-14]` `[D14]` `[fe-04]` `[fe-12]`；本片新取舍 `[fe-27]`–`[fe-32]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `71c31ab399`（FE-5 已记 21 文件 / 1504 全绿）；起手前重跑 21 个文件：**21 文件 / 1504 全绿** |
| 契约只读来源 | `git show a1162030bf:<path>`（PR-3a 分支当时的 head；FE-5 读的是 `510fba6917`。其间的提交是 S7 / S8 与 S5 的后续修订，成员段只动了注释与共用的 `loadMemberList`：`src/routes/tasks-lists.ts` 的 5 条成员路由、成功体与码同 PR-3a 验证 §S6.8 前端对接表）。读了 PR-3a 设计 §3.0（行级一律 404；路径与请求体里的成员 id 过 `isValidMemberId`，不合法是 422 `INVALID_MEMBER`）、§3.3（成员表；移除判定顺序；本人退出的边界；转让后原所有者降为 `edit`；`owner` 只经转让）与验证 §S6.1、§S6.5、§S6.8（`[own-40]` 名单按 `userId` 字节序；`[own-41]` 成员 id 先于角色校验；`[own-42]` `GET …/members` 缺 org 回 404） |
| 后端状态 | S6 的成员路由在 PR-3a 分支上已建，不在 main；本片按契约编码，全部格 mock 传输层 |
| owner 裁决（2026-10-07） | R02–R23 ratify，R12 以 PR-3a 的收窄版 `[own-25]` 替换（a1：把任务加入清单要求对任务有直接角色——创建人或负责人；a2：创建人可以把自己的任务移出任一清单）；`[fe-19]` ratify。收窄只动清单项的加入 / 移出，成员规则（创建人不可移除、所有者唯一且先转让再退出、`owner` 只经转让）不变，所以本片代码里的 `[R12]` 标签照旧成立。设计 §11 只在 `[fe-19]` 行记 ratified（§12-Q15 加了指向），其余 R 行与代码注释的 `ASSUMPTION(task-m4-fe)` 标签未改，留给 FE-8 统一处理 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `09c5b1d0f9` | 实现：新 `views/tasks/TaskListMembersDialog.vue`；`TaskListView.vue` 加「成员」按钮、挂对话框（`v-model:pending`、`:reload-list`、`@close` / `@left` / `@org-missing`）、路由边沿关对话框、`useRouter()`；`labels.ts` 两表各加 15 键、格式函数各加 4 个；`tasks-labels.spec.ts` 只补 5 个 mock 条目与 `FMT_ARGS` 4 行（覆盖自检格要求，否则该格红） |
| `12087a5a88` | 新 `tests/tasks-list-members.spec.ts`（106 格）；`tasks-labels.spec.ts` 加 7 格；三处登记 |
| `8d33315437` | 第一轮变异五个存活（T6、E19、G5、G6、G8，§6）后补格：只开一个转让确认块；下一次写清掉退出错误；「路由边沿之后才回的 404」格改成五个动作各一格 |
| `61b2019d0b` | F7 只靠 vitest 的未处理异常变红，断言没红（§6）；该格加 window `error` 事件监听与两个方向的 Tab |
| 本文所在提交 | 本节；设计 §11 记 `[fe-19]` ratified 与 `[fe-27]`–`[fe-32]`，§12 加 Q23–Q26，Q19 扩到转让，Q15 加 ratified 指向 |

### 3. 文件（`71c31ab399..61b2019d0b`，8 个文件，+2453 / −6；不含本 MD 与设计 MD）

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/views/tasks/TaskListMembersDialog.vue` | +672（新） | 对话框：挂载时读名单（一页，100 人上限），读态（加载中 / 名单 / 空 / 404 / 403 / 失败）与降级体上报；§5.1 推断的行内控件（改角色下拉、转让及其两步确认、移除）、添加表单（修边、角色缺省 `read`、100 人上限时禁用并提示）、退出及其两步确认；每个写成功用响应的 `members` 替换名单，转让另请页面安静重读清单、退出请页面回 `/tasks`；错误按 §5.3 落在添加表单、对应行、退出按钮旁或对话框横幅；写 404 请页面重读清单、对话框仍在时另重读名单；`role="dialog"`、`aria-modal`、标题 `tabindex="-1"` 打开即取焦点、Tab / Shift+Tab 回绕、Esc 与关闭按钮（写进行中都不生效）；共享 `pending` 之外另有本地 `writing` 标志；读 generation 与写 token，卸载时推进，写仍在进行时交还共享 `pending` |
| `apps/web/src/views/tasks/TaskListView.vue` | +56 / −4 | 模板：操作区加「成员」按钮（所有角色可见、`aria-haspopup="dialog"`，写进行中不禁用）；主体末尾挂对话框。脚本：`nextTick` / `useRouter` / 对话框三条导入；`membersOpen` / `membersButton`；`closeMembers()`（关后 `nextTick` 把焦点还给按钮）、`onLeftList()`（关对话框、`router.push('/tasks')`，不再通知总线——对话框已通知）、`reloadListQuietly()`；`resetPage()` 追加 `membersOpen = false`；头注加成员一段。−4 是导入两行与头注两行的改写 |
| `apps/web/src/tasks/labels.ts` | +45 | 两张表各加 15 键（现各 230 键）：页头按钮 1、对话框 14；格式函数加 4 个（现各 12 个）：行内下拉 / 移除 / 转让按钮的可访问名与转让确认提示。其余文案复用既有键（见 §7 第 11 条） |
| `apps/web/tests/tasks-list-members.spec.ts` | +1437（新） | 111 格（§5） |
| `apps/web/tests/tasks-labels.spec.ts` | +230 / −1 | 7 格（§5）；工厂补 5 个成员调用与 `beforeEach` 缺省；`FMT_ARGS` 加 4 行；新 helper `openMembersDialog()` / `rowNode()` / `pickIn()`；−1 是头注一行改写。既有断言零改动 |
| `apps/web/scripts/run-required-web-tests.sh` | +1 | `tasks-list-members.spec.ts` 插在 `tasks-list-detail.spec.ts` 与 `tasks-list-view.spec.ts` 之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1 | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（558 token） |
| `.github/workflows/tasks-web-guard.yml` | +11 / −1 | step 参数插入一行（同序）；「Twenty-one whole-file args」→「**Twenty-two** whole-file args」；头注加 FE-6 一段（裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现一次） |

### 4. 行为规则（spec 按这些出格）

- **入口**：「成员」按钮对 `owner` / `edit` / `read` 都显示（读名单只需 `view`），点开之前不读名单；写进行中按钮不禁用（打开对话框不是写）。
- **名单读**：打开即发 `GET /api/task-lists/:id/members?limit=100&offset=0` 一次；行按服务端顺序，显示用户 id、角色文案（所有者 / 可编辑 / 只读）、创建人那一行标「创建人」；读进行中「加载中…」且没有任何写控件；空名单「暂无成员」；500 / 畸形行 / 传输失败 ⇒「加载成员失败，请稍后重试」（`role="alert"`，对话框不关、可关闭）；403 ⇒「您没有权限查看此清单」，不重读清单；404 ⇒「清单不可用或你已不是成员」并请页面安静重读清单一次（重读也是 404 ⇒ 页面转 not_found、对话框随之消失）；降级体 ⇒ 页面引导块；关掉再打开重读一次。
- **按角色的控件（§5.1）**：所有者（兼创建人）⇒ 添加表单，其余每行有改角色、转让、移除，本人行什么都没有，没有「退出清单」；`edit` 成员 ⇒ 添加表单，其他非所有者行有改角色与移除，所有者行与本人行都没有，没有转让，有「退出清单」；`read` 成员 ⇒ 没有任何行内控件、没有添加表单，有「退出清单」；不是创建人的所有者 ⇒ 创建人那一行可改角色、可作转让目标但永远没有「移除」，没有「退出清单」；不再是所有者的创建人 ⇒ 没有「退出清单」；转让目标是 `ownerId` 之外的每一行。当前用户 id 解析中 ⇒ 没有「退出清单」、所有行没有改角色与移除，解析出来之后出现；解析回 `null` 或抛错 ⇒ 同样没有这三样，转让与添加照旧。行内下拉只有 `read` / `edit`，值是该行的服务端角色；三个行内控件的可访问名带上该行的用户 id。
- **请求体**：添加 `POST …/members` `{"userId":"u7","role":"read"}`（输入修边，角色缺省 `read`，选 `edit` 就发 `edit`）；空白不发（提交按钮禁用，派发提交也不发）；改角色 `PATCH …/members/u3` `{"role":"edit"}`，选回现有角色不发；移除 `DELETE …/members/u3` 无请求体；转让 `POST …/transfer-owner` `{"userId":"u2"}`；退出 `DELETE …/members/<本人 id>`。
- **成功**：名单换成响应的 `members`（含客户端推不出的行），不重读名单、不重读清单；加人、改角色、移除他人不通知任何总线。转让 ⇒ 名单换成响应（原所有者 `edit`、目标 `owner`），页面重读清单一次、页头变成「可编辑」、转让按钮消失、清单总线通知一次，清单重读回来之前对话框与页面的写控件一律禁用、关闭按钮也禁用；不是创建人的原所有者在转让之后出现「退出清单」。退出 ⇒ 对话框关闭、页面到 `/tasks`、清单总线通知一次、红点总线不动、不重读清单。转让与退出都先在行内 / 按钮旁确认，取消不发。
- **码与落点（§5.3）**：添加的 `INVALID_MEMBER` / `INVALID_ROLE` / `INACTIVE_ORG_MEMBER` / `LIMIT`（「成员数已达上限」，不是 M3 的「人数已达上限」）/ 契约外的码（回退文案）落添加表单旁（输入保留，`aria-invalid` 与 `aria-describedby` 指向错误，再输入即清）；改角色的 `INVALID_MEMBER` / `INVALID_ROLE` / `OWNER_MUST_TRANSFER`、移除的 `INVALID_MEMBER` / `CREATED_BY_IMMUTABLE` / `OWNER_MUST_TRANSFER`、转让的 `INVALID_MEMBER` / `TARGET_NOT_MEMBER` / `INACTIVE_ORG_MEMBER` 落该行；退出的 `CREATED_BY_IMMUTABLE` / `OWNER_MUST_TRANSFER` / `INVALID_MEMBER` 落退出按钮旁。每一格都断言只有这一个落点、名单不变、不重读、总线不动、确认块收起。五个动作的 404 ⇒ 对话框横幅「清单不可用或你已不是成员」、页面重读清单一次、名单重读一次（页面重读是 404 ⇒ 页面转 not_found，名单不再读；对话框仍在时，重读的名单去掉服务端已没有的行）；403 ⇒ 横幅「您没有权限修改此清单」、不重读；500 / 畸形 200 / 传输失败 ⇒ 横幅「操作失败，请稍后重试」；`ORG_MISSING` ⇒ 页面引导块。下一次写先清掉上一次的横幅与各落点的错误。本地已有 100 人 ⇒ 添加的输入、角色、提交都禁用并提示「成员数已达上限」，派发提交也不发；99 人照常。
- **下拉跟服务端**：改角色进行中下拉仍显示服务端角色，回包后才变；码回来下拉仍是服务端角色；另一个写进行中派发的选择不发请求、下拉仍是服务端角色。
- **一次一个（`v-model:pending`）**：对话框的写进行中，页面的改名、归档、加入任务输入、移出任务都禁用，页面主体 `aria-busy="true"`，对话框的全部控件禁用，强行点另一行的「移除」也不发；回包后都恢复。页面的写进行中，「成员」按钮照常可用，对话框里的控件全部禁用，派发的添加不发。同一 tick 里点两个「移除」只发一个请求。
- **关闭与焦点**：Esc 与「关闭」都关闭并把焦点还给「成员」按钮；写进行中 Esc 不关、强行点「关闭」也不关，回包后 Esc 照常；Tab 越过最后一个可用控件回到第一个、Shift+Tab 越过第一个回到最后一个，标题算对话框之外（从标题 Tab 到第一个、Shift+Tab 到最后一个），中间的 Tab 交给浏览器；禁用的控件不在循环里（只剩「关闭」可用时 Shift+Tab 停在它上面）；全部控件被写禁用时 Tab 被拦在对话框内，处理函数不抛错。
- **路由边沿与晚到**：`/task-lists/tl_1` → `tl_2` 关闭对话框、页面的控件恢复可用、不读 tl_2 的名单；之后才回的添加什么都不发，在 tl_2 上再打开读的是 tl_2 的名单。关闭之后才回的名单 404 不重读清单；关了又开、旧的名单读晚到不覆盖新读；路由边沿之后才回的名单 404 在两个 id 下都不重读清单。路由边沿之后才回的转让 ⇒ 两个 id 下都不重读清单、页头仍是 tl_2 的「所有者」、清单总线仍通知一次；离开到任务页之后才回的转让 ⇒ 一个请求都不发、总线仍通知一次；离开到任务页之后才回的退出 ⇒ 不导航、不发请求、总线通知一次；换到别的清单之后才回的退出 ⇒ 停在 tl_2、总线通知一次。五个动作在路由边沿之后才回的 404 ⇒ 不重读清单（两个 id）、不读名单、新对话框没有横幅；路由边沿之后才回的码不出现在新对话框里。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts <lane 脚本里的 21 个 tasks 文件> --reporter=verbose`（`apps/web`，`61b2019d0b`；文件表从 lane 脚本的 `exec npx vitest run` 续行块抽出） | **22 文件 / 1622 用例全绿**（1504 既有 + 111 新文件 + 7 labels），0 个失败标记 |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`61b2019d0b`；`09c5b1d0f9` 与 `12087a5a88` 上各跑过一次，同样） | 退出 0，0 行输出 |
| D = T = G | `D`=`T`=`G`=21 个 `tasks*.spec.ts`；yml 22 个 whole-file 参数（+`tests/App.spec.ts`）；yml 中 `vitest run` 只出现 1 次；lane 块的 tasks token 按 `LC_ALL=C` 有序 |
| `node scripts/ops/required-web-lane-token-manifest.mjs --write`，再跑检查模式 | 写入 558 token；检查模式 `MANIFEST MATCHES` |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（新 token） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 557 个 token 的双向子串碰撞 0 |
| 字面扫描器 v1（8 个改动文件 + 本 MD + 设计 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（`71c31ab399..HEAD` 的 diff 与两份 MD） | 0 命中 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-m4` 111、`tasks-detail-view` 44、`tasks-labels` **75**（68 + 7）、`tasks-list-detail` 101、**`tasks-list-members` 111（新）**、`tasks-list-view` 32、`tasks-lists-sidebar` 67、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 30、`tasks-settings-view` 71、`tasks-view-transitions` 14、`tasks-view` 7。除 `tasks-labels` 外的既有文件与 FE-5 相同。

`tasks-list-members.spec.ts` 的 111 格：打开与名单读 15（三种角色都有按钮）；按角色的控件 11；请求与成功 7；转让 4；退出 3；码与落点 44（§5.3 表 17、输入保留 1、404 五格、404 后页面转 not_found 1、404 后名单去行 1、403 五格、失败五格、`ORG_MISSING` 五格、下一次写清错误 2、上限 2）；下拉跟服务端 3；一次一个 3；关闭与焦点 7；路由边沿与晚到 14（含路由边沿之后才回的 404 五格）。`afterEach` 断言假后端没有收到任何未列出的请求，并退订格内的总线监听。

`tasks-labels.spec.ts` 新 7 格：格式函数嵌入成员 id 1；EN 四格（所有者视图的行、角色文案、创建人标、三个行内控件与可访问名、添加表单、转让确认；`edit` 成员视图的退出确认与上限提示；五个读态；添加表单五种错误、行内三个码与改角色的码、退出按钮旁、横幅三种）、ZH 正控一格、挂载后翻转一格（含行内错误）。

### 6. 变异证据

脚本驱动（脚本不入库；与 FE-3 / FE-4 / FE-5 同一个执行器）：断言每个 `old` 文本在其文件中恰出现一次 → 备份 → 改坏 → 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。96 个变异，覆盖设计 §10.1 FE-6 行最右列的五条（M1–M5）、§5.1 每一条推断（V1–V15）、请求体与下拉（B1–B6）、「用响应替换名单」（R1–R4）、转让（T1–T6）、退出（L1–L6）、§5.3 每个落点与 404 / 403 / `ORG_MISSING`（E1–E19）、晚到守卫（G1–G10）、共享 `pending`（P1–P7）、关闭与焦点（F1–F7）、成员上限（C1–C4）、文案（T7–T11）与两处成员调用的路径段检查（A1、A2）。

- 第一轮（`12087a5a88`）：96 个，90 红、G10 按预期仍绿，**五个存活**：T6（转让确认块在每一行都打开：「先确认」格只看了被点那一行）、E19（下一次写不清退出错误：「下一次写清错误」格的观者是所有者，没有退出按钮）、G5 / G6 / G8（退出、添加、移除去掉写 token 判断：「路由边沿之后才回的 404」格只用了改角色——没有 token 判断时，晚到的 404 会让页面按当前路由的 id 重读清单，这正是 FE-5 L6 / L7 那条教训）。补格（`8d33315437`）：「先确认」格加「确认块恰一个、另一行仍有转让按钮」；新格「下一次写清掉退出错误」；「路由边沿之后才回的 404」改为五个动作各一格。五个存活与 G7、G10 单跑（`ONLY=…`）：五个全红，G10 仍绿。
- 第二轮（`8d33315437` 整轮重跑）：95 红、G10 仍绿；但 F7 的「红」没有失败格（执行器打出「no failed-test count parsed」）：变异后的 Tab 处理函数在 `preventDefault()` 之后对空集合调 `focus()` 抛 TypeError，vitest 把它记成未处理异常让整次运行失败，而该格的 `defaultPrevented` 断言照样通过。补断言（`61b2019d0b`）：该格监听 window 的 `error` 事件并断言为空、两个方向各按一次 Tab；F7 单跑红 1 格。
- 最终一轮（`61b2019d0b` 整轮重跑）：**96 个变异，95 个变红（每一个都有断言失败的格），1 个（G10）按预期仍绿为视图层等价变异；96 组文件还原全部逐字节一致；轮后 `git status` 干净**。下表即最终一轮（括号里是失败格数）。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | 创建人那一行显示「移除」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| M2 | 本人那一行显示「移除」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| M3 | 标题去掉 `tabindex="-1"` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| M4 | 转让成功不重读清单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| M5 | Esc 不关闭 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| V1 | `read` 成员也能管成员 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| V2 | `edit` 成员不能管成员（只认 `owner`） | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（7） | 一致 |
| V3 | 所有者那一行可改角色 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| V4 | 本人那一行可改角色 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| V5 | 改角色不等当前用户 id | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| V6 | 所有者那一行显示「移除」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| V7 | 「移除」不等当前用户 id | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| V8 | `edit` 成员也能转让 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（5） | 一致 |
| V9 | 所有者那一行也是转让目标 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（6） | 一致 |
| V10 | 创建人也能退出 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| V11 | 所有者也能退出 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| V12 | 当前用户 id 未知时也显示「退出清单」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| V13 | 行内角色下拉多出 `owner` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| V14 | 每一行都标「创建人」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| V15 | 「成员」按钮只给有管理权的人 | `TaskListView.vue` | `tasks-list-members` | 红（3） | 一致 |
| B1 | 添加发未修边的 id | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| B2 | 添加的缺省角色为 `edit` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| B3 | 退出时移除的是创建人而不是本人 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| B4 | 选了行的现有角色仍发请求 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| B5 | 下拉不放回服务端角色（去掉显式复位） | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| B6 | 下拉把选择写进行（自改） | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（14） | 一致 |
| R1 | 添加成功后重读名单而不是取响应 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| R2 | 移除成功后名单不变 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| R3 | 改角色成功后名单不变 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| R4 | 转让成功后名单不变 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| T1 | 转让成功不通知清单总线 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| T2 | 转让只在及时回包时通知总线 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| T3 | 转让在清单重读回来之前释放 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| T4 | 转让跳过确认 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（14） | 一致 |
| T5 | 转让确认块在回包后不收起 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| T6 | 转让确认块在每一行都打开 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| L1 | 退出后页面不回 `/tasks` | `TaskListView.vue` | `tasks-list-members` | 红（2） | 一致 |
| L2 | 退出成功不通知清单总线 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| L3 | 退出只在及时回包时通知总线 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| L4 | 退出跳过确认 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（14） | 一致 |
| L5 | 页面在退出时再通知一次总线 | `TaskListView.vue` | `tasks-list-members` | 红（1） | 一致 |
| L6 | 退出确认块在回包后不收起 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| E1 | 添加的 `LIMIT` 用 M3 的「人数已达上限」 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| E2 | 改角色的码落到添加表单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| E3 | 移除的码落到横幅 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| E4 | 转让的码落到退出按钮旁 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| E5 | 退出的码落到横幅 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| E6 | 添加的码落到横幅 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（6） | 一致 |
| E7 | 写的 404 不重读清单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（6） | 一致 |
| E8 | 写的 404 不重读名单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（6） | 一致 |
| E9 | 写的 404 在对话框卸载后仍重读名单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| E10 | 横幅的 404 / 403 文案对调 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（11） | 一致 |
| E11 | 写的 403 按 404 处理 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（5） | 一致 |
| E12 | 写的 `ORG_MISSING` 不上报页面 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（5） | 一致 |
| E13 | 页面不理会对话框的 org 上报 | `TaskListView.vue` | `tasks-list-members` | 红（6） | 一致 |
| E14 | 名单读的 403 显示为失败 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| E15 | 名单读的 404 不重读清单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| E16 | 名单读失败显示为空名单 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| E17 | 行内错误在每一行都显示 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（10） | 一致 |
| E18 | 下一次写不清横幅 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| E19 | 下一次写不清退出错误 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| G1 | 名单读去掉 generation 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| G2 | 卸载不推进写 token | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（8） | 一致 |
| G3 | 卸载不推进读 generation | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| G4 | 转让去掉写 token 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（3） | 一致 |
| G5 | 退出去掉写 token 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| G6 | 添加去掉写 token 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| G7 | 改角色去掉写 token 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| G8 | 移除去掉写 token 判断 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| G9 | 路由边沿不关对话框 | `TaskListView.vue` | `tasks-list-members` | 红（7） | 一致 |
| G10 | 卸载时写仍在进行，不交还共享 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | **仍绿（视图层等价变异，见下注）** | 一致 |
| P1 | 去掉本地 `writing` 标志（同一 tick 两次写） | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| P2 | 对话框的写不看共享 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| P3 | 对话框不占用共享 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（4） | 一致 |
| P4 | 对话框不交还共享 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（5） | 一致 |
| P5 | 页面只单向绑定 `pending` | `TaskListView.vue` | `tasks-list-members` | 红（4） | 一致 |
| P6 | 行内「移除」不看 `pending` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| P7 | 页面的安静重读是空操作 | `TaskListView.vue` | `tasks-list-members` | 红（11） | 一致 |
| F1 | 打开时标题不取焦点 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| F2 | 关闭后焦点不回「成员」按钮 | `TaskListView.vue` | `tasks-list-members` | 红（2） | 一致 |
| F3 | 写进行中也能关闭 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| F4 | Tab 越过最后一个控件不回绕 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| F5 | Shift+Tab 越过第一个控件不回绕 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| F6 | 禁用的控件留在循环里 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| F7 | 没有可用控件时 Tab 不被拦住 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| C1 | 成员上限永远到不了 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| C2 | 上限比较用 `>` 而不是 `>=` | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（2） | 一致 |
| C3 | 上限写成 99 | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| C4 | 添加本身不查上限（只靠禁用属性） | `TaskListMembersDialog.vue` | `tasks-list-members` | 红（1） | 一致 |
| T7 | 对话框文案表在 setup 时一次性求值 | `TaskListMembersDialog.vue` | `tasks-labels` | 红（1） | 一致 |
| T8 | 对话框格式函数表一次性求值 | `TaskListMembersDialog.vue` | `tasks-labels` | 红（1） | 一致 |
| T9 | 对话框标题硬编码中文 | `TaskListMembersDialog.vue` | `tasks-labels` | 红（5） | 一致 |
| T10 | EN 的对话框标题写成中文 | `labels.ts` | `tasks-labels` | 红（7） | 一致 |
| T11 | EN 的转让提示写成中文 | `labels.ts` | `tasks-labels` | 红（2） | 一致 |
| A1 | 名单读去掉清单 id 的路径段检查 | `tasksApi.ts` | `tasks-list-members` `tasks-api-m4` | 红（3）：只有 `tasks-api-m4`（FE-1）红 | 一致 |
| A2 | 移除去掉用户 id 的路径段检查 | `tasksApi.ts` | `tasks-list-members` `tasks-api-m4` | 红（3）：只有 `tasks-api-m4`（FE-1）红 | 一致 |
- **G10 记为等价变异**：卸载时把共享 `pending` 交还给页面的那几行，在视图层没有可观测的差别。写仍在进行时对话框被卸载只有三条路：路由边沿（`resetPage()` 先已把 `pending` 置 false）、离开页面（实例随之销毁）、页面因转让或 404 后的重读离开清单主体（not_found / 失败 / 引导块——这些状态下没有任何控件读 `pending`，下一次路由边沿再复位）。保留它是为了让「谁占用谁交还」在代码里成立（FE-7 若在清单主体之外加控件就会用到），不为它造不可达的格。
- 设计 §10.1 FE-6 行最右列五条：创建人行显示移除（M1）、本人行显示移除（M2）、去掉 `tabindex="-1"`（M3）、转让后不重读清单行（M4）、Esc 不关（M5），全部变红。简报点名的面：§5.1 每条推断（V1–V15）、请求体（B1–B4）、§5.3 每个落点（E1–E6、E17）、用响应替换（R1–R4）、转让降为 `edit` 并重读（M4、R4、T3）、退出导航与总线（L1–L5）、共享 `pending`（P1–P7）、晚到守卫（G1–G9）。A1 / A2 只有 FE-1 的 `tasks-api-m4` 红：对话框只把页面已读通的清单 id 与名单里的用户 id 放进路径，视图层到不了路径段检查（与 FE-5 的 P4v 同理；按简报不新加 id 边界值的探测格）。

### 7. 与设计的偏差 / 解释

1. **转让走两步确认**（`[fe-27]`，§12-Q23）：§5.2 只画了「设为所有者」一个按钮；转让之后本人降为 `edit`，自己转不回来，确认块在该行内显示提示「确认将所有权转让给「X」？转让后你将成为可编辑成员」。移除照 §5.2 不确认（可以再加回来）；退出照 §5.2 确认。
2. **本人那一行没有改角色与移除，id 未知时所有行都没有这两样**（`[fe-28]`，§12-Q24）：§5.1 只对「移除」排除了本人行；本人把自己降为 `read` 后自己升不回来，也会让页面的 `myRole` 在下一次重读前是旧值。id 解析出来之前分不出本人行（`edit` 观者的本人行混在其他 `edit` 行里），所以两样都等 id；所有者观者的本人行就是所有者行，本来就没有这两样。
3. **添加的缺省角色 `read`**（`[fe-29]`，§12-Q25）。
4. **写进行中不能关闭**（`[fe-30]`，§12-Q26）：转让与退出成功后的后续（页面重读清单、回到 `/tasks`）由仍挂着的对话框发起；关闭之后晚到的结果只通知清单总线。「写进行中」看的是共享 `pending`，所以页面的写进行中同样不能关（打开对话框本身照常）。对话框若在写进行中被卸载（只可能是路由边沿、离开页面或页面离开清单主体），会在 `onBeforeUnmount` 里交还 `pending`（G10）。
5. **成员域的失败**（`[fe-31]`）：名单读不是 `ok` 时不渲染任何写控件（同 `[fe-21]`：读失败时写多半也失败；也避免「读还没回、写的响应先替换了名单、旧读晚到再覆盖」）。404（读或写）按 §5.3 让页面安静重读清单；写的 404 在页面重读之后对话框仍在时另重读一次名单（§5.3 只写了重读清单行：例如改角色时目标刚被别人移除，404 之后那一行还在，重读名单让它消失）。名单读的 403 用清单页读 403 的文案「您没有权限查看此清单」（`listForbidden`），404 用 §5.3 的「清单不可用或你已不是成员」（`listWriteNotFound`，FE-5 已用于清单页写 404）。
6. **清单总线**（`[fe-32]`，§12-Q19 扩到转让）：转让成功也通知（本人角色变了，「我的清单」的角色徽标跟着变），晚到的转让 / 退出成功同样通知（FE-5 `[fe-23]` 的口径）；加人、改角色、移除他人不通知（成员写不改清单的 `updatedAt` 与「我的清单」的顺序，PR-3a §S6.8）。通知在对话框里发（对话框卸载之后的 `emit` 送不到页面，晚到的通知只能由对话框自己发），页面的 `onLeftList()` 不再通知（L5 钉住「恰一次」）。
7. **成功用响应替换名单**（`[fe-04]`，按设计）；转让另请页面重读清单，并把 `pending` 持有到重读回来（FE-5 `[fe-24]` 的口径：重读回来之前写控件保持禁用，T3 钉住）——否则重读回来之前页头仍是「所有者」，再点转让只会得到 404。页面的重读函数以 prop（`reloadList: () => Promise<void>`）传给对话框，对话框 `await` 它。
8. **角色下拉**：`:value` 绑定该行，`@change` 读原生值后立即把 DOM 值放回服务端角色，只有回包替换了行才变。Vue 每次重渲染也会按 `:value` 重设 select 的值，所以在「请求发出 ⇒ `pending` 变化 ⇒ 重渲染」这条路上显式复位是多余的；它管的是不引起重渲染的那条路——另一个写进行中派发的选择（B5 的杀伤格）。B6（把选择写进行）是 FE-5 说明里「`:value` 绑定不得自改」的反面，14 格红。
9. **同一 tick 的第二次写**：页面的 `pending` 要到下一次渲染才进到对话框的 props，所以对话框另有一个本地 `writing` 标志，`beginWrite()` 同时看两者（P1、P2 各钉一半）。
10. **成员上限**（`[D14]`，§11 已把成员对话框列为它的位置）：本地已有 100 人时添加的输入、角色、提交都禁用并提示「成员数已达上限」（复用 `codeLimitMembers`），处理函数也不发（C4）；服务端的 `LIMIT` 仍落添加表单旁。
11. **文案来源**：取自设计原文的 ZH 文案——「成员」（§2.4 页头）、「清单成员」「设为所有者」「退出清单」「关闭」「创建人」（§5.2）；§5.3 的七条码文案与 404 文案 FE-0 / FE-5 已入表，本片复用。复用的既有键：`remove`、`cancel`、`loading`、三个角色徽标、`listWriteNotFound`、`listWriteForbidden`、`listForbidden`、`actionFailed`、`codeLimitMembers`。新写的 ZH：「暂无成员」「加载成员失败，请稍后重试」「确认转让」「添加成员（用户 ID）」「用户 ID」「角色」「添加成员」「确认退出此清单？」「确认退出」与四个格式函数；EN 全部新写。
12. **对话框有自己的横幅**（`tasks-list-members-error`，§5.2 的 `role="alert"` 节点），不借用清单页的 `tasks-list-detail-banner`：对话框是模态的，页面横幅在遮罩之下。
13. **焦点循环的集合**只取 `button` / `input` / `select` / `textarea` / `a[href]` 中未禁用的；标题 `<h2 tabindex="-1">` 不在其中、算对话框之外，所以打开后第一下 Tab 到第一个控件、Shift+Tab 到「关闭」。
14. **测试的 flush 深度**：退出的链条（响应解析 → 总线 → `emit` → 页面 `router.push` → 路由自身的异步步骤）在 14 轮微任务内走不完，本 spec 缺省 flush 40 轮；「不该发生」的格因此和「该发生」的格等得一样久。jsdom 里 memory history 初始位置引发的 `[Vue Router warn]: No match found for location with path ""` 在 FE-5 的 spec 里同样出现，与本片无关。
15. **`[fe-NN]` 编号**：代码注释里的 `[fe-27]`–`[fe-32]` 与设计 §11 一致；FE-5 的 `[fe-21]`–`[fe-26]` 补标仍留给 FE-8（FE-5 §7 第 20 条）。`tasksApi.ts` 头注仍写「list members (S6) … not built yet」，与 PR-3a 现状（S6–S8 在 `a1162030bf` 上已建）不符；本片没有改 FE-1 的代码，留给 FE-8 一并刷新。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调；S6 的成员路由已建但未联调。遮罩与对话框的布局、窄屏、真实浏览器里禁用按钮失焦后的焦点去向、Tab 回绕在真实浏览器里的表现都没有看过。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 22 个 whole-file 参数、manifest 写入与检查模式、后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（spec 文件不在其中，只经 vitest 的 esbuild 转译）。`pnpm --filter @metasheet/web build`：NOT RUN。
- 整个 `apps/web` 的 vitest 全量：NOT RUN。本片没有改路由表，引用 `appRoutes` 的其余 spec 没有重跑。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-7 的说明

- **共享 `pending`**：分组板照对话框的做法接 `v-model:pending`；对话框的三件事可以照搬——本地 `writing` 标志挡同一 tick 的第二次写、卸载时推进 token 与 generation、写仍在进行时在 `onBeforeUnmount` 交还 `pending`。页面的 `reloadListQuietly()` 已在，板若需要在写之后让页面重读清单可直接传。
- **页面结构**：「成员」按钮在 `tasks-list-page__actions` 里，对话框挂在主体末尾；板替换 `tasks-list-detail-items` 时不要动这两处。对话框打开时页面的写控件随 `pending` 禁用，板的拖拽句柄同样要看它。
- **登记**：`tasks-groups.spec.ts` 插在 `tasks-detail-view.spec.ts` 与 `tasks-labels.spec.ts` 之间；yml 计数从 Twenty-two 起 +1；`.tokens` 只用 `--write`；之后 D = T = G = 22。
- **文案表**：现各 230 键、格式函数各 12 个；`tasks-labels.spec.ts` 的工厂已有五个成员调用。
- **测试**：带导航的链条要给足 flush（本片 40 轮）；「晚到」格要数「当前路由的 id」下的读（FE-5 L6 / L7、本片 G5 / G6 / G8 都是这一类）。

---

## FE-7 分组板（两种 scope）（设计 §2.4、§4.4、§4.6、§6、§9、§10、§13 FE-7；`[R11]` `[R12]` `[D14]` `[own-24]` `[fe-05]` `[fe-16]`；本片新取舍 `[fe-33]`–`[fe-44]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `8dc195abf6`（FE-6 已记 22 文件 / 1622 全绿）；起手前重跑 22 个文件：**22 文件 / 1622 全绿** |
| 契约只读来源 | `git show d18c436c8d:<path>`（PR-3a 分支当时的 head）：PR-3a 设计 §3.0、§3.5（`Group` 形状、默认组与个人 scope 的合成默认组、稀疏摆放、可见集与稠密下标、至多一个组、删组回默认组、每容器 50 组、`[own-48]`–`[own-52]` 细则）与验证 §S8.1、§S8.10（12 条路由的前端对接表与合并规则）。**片尾复核**：PR-3a 分支此间前进到 `c8fdd07e2b`（含 `[own-53]`）；§3.5 逐字节相同，§S8.10 只多一个行尾空行，`src/routes/tasks-lists.ts`、`src/services/task-group-records.ts`、`src/tasks/task-groups.ts` 零差异——契约不变 |
| API 客户端对契约（简报要求：不一致就改客户端并记录） | FE-1 的 12 个 S8 函数逐条对过：路径与方法；请求体 `{ groupId, position }`（`groupId: null` 指默认组）；`Group` 解析（`scope` 逐字比，清单 scope 的 `id: null` 判 malformed，个人 scope 只有默认组可为 `null`）；摆放 `{ groupId: string, taskId, position }`；PUT 成功体的 `groupId` 必为字符串（个人默认组落行后的真实 id）；删组成功体 `{ id, deleted: true, reassignedTo }`；个人两条读的降级体 ⇒ `org_missing`、清单两条读缺 org 是 404；分页 422 只可能是契约漂移，归 `error`；读全部页按 `taskId` 去重。**全部一致，本片不改 `tasksApi.ts`**（其头注仍写「S6–S8 not built yet」，按简报留给 FE-8） |
| 后端状态 | S8 的 12 条分组路由在 PR-3a 分支上已建，不在 main；本片按契约编码，全部格 mock 传输层 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `40280dd13d` | 实现：新 `tasks/tasksGroupBoard.ts`（纯规则：顺序、可见集、移动的 PUT 体、乐观模型）、`views/tasks/TaskGroupBoard.vue`（两种 scope 共用的板，含平铺回退）、`views/tasks/TaskPersonalGroups.vue`（「分配给我」视角的两读与板）；`TasksView.vue` 在 assigned 视角挂 `TaskPersonalGroups`（行内容走插槽）、新增 `reloadListQuietly()`；`TaskListView.vue` 加分组与摆放两读（各自 generation）、用板替换平铺 `<ul>`、加入 / 移出成功后同时重读摆放；`labels.ts` 两表各加 19 键、格式函数各加 10 个；九个既有 spec 只补 mock（§3） |
| `84058d3bf1` | 新 `tests/tasks-groups.spec.ts`（159 格）；`tasks-labels.spec.ts` 加 10 格与 8 个写函数的 mock 条目、`beforeEach` 缺省；三处登记 |
| `7dc8fc4d0d` | 第一轮变异的三个存活（B26、B35、B56，§6）补格，另补两格（写进行中不显示停用提示、个人分组读截断） |
| `ae394e2e0b` | 只改注释：`[fe-33]` `[fe-34]` `[fe-41]`–`[fe-43]` 标在代码里各自的规则处（`[fe-35]`–`[fe-40]` 在 `40280dd13d` 已标）。第二轮变异跑在这个提交上 |
| `a568aeedd4` | 清单页板写回 404 与板的刷新另请页面安静重读清单（复用 `reloadListQuietly()`，`[fe-44]`，§7 第 17 条）；两格改数清单读、两格新增（失去清单 ⇒ not_found；角色变成只读 ⇒ 移动控件消失）。**最终一轮变异跑在这个提交上** |
| 本文所在提交 | 本节；设计 §11 登记 `[fe-33]`–`[fe-44]` 并补 `[R11]` `[D14]` `[own-24]` 三行的位置列，§12 加 Q27–Q32 |

### 3. 文件（`8dc195abf6..a568aeedd4`，19 个文件，+3943 / −54；不含本 MD 与设计 MD）

| 文件 | 行 | 改动 |
|---|---|---|
| `apps/web/src/tasks/tasksGroupBoard.ts` | +182（新） | 纯规则，无 I/O：`buildBoardModel`（分组按 `position`、再按 id 的码元序；组内按摆放的 `position`、再按任务 id；无摆放的行进默认组的「未排序」尾段、保持行的原序；指向未知分组的摆放归默认组有序区；指向非行任务的摆放不显示；两者都令板「不一致」；不能成板的分组集回 `null`）、`locateTask`、`planMove`（目标组可见集去掉被移任务之后的 `0..len`；原地即空操作；默认组发 `null`）、`planStep` / `planJoinOrder` / `planToGroup` / `planDrop`、`applyMove`（乐观模型）；常量 `DEFAULT_GROUP_KEY`、`GROUP_CAP`（`[D14]`） |
| `apps/web/src/views/tasks/TaskGroupBoard.vue` | +827（新） | 两种 scope 共用的板：分组读未齐 / 失败 / 不能成板时渲染平铺列表（失败与不能成板另有「分组不可用」）；成板时根容器 `data-testid="tasks-list"`、每组一个 `section`（名、项数、改名 / 删组两步确认，默认组无删除，个人默认组 `id === null` 时改名禁用并提示）、组内 `<ol>`、默认组的「未排序」尾段；行内容取自宿主的 `row` 插槽，行的 `data-testid` 由宿主给；移动（句柄拖拽、上移 / 下移 / 加入排序 / 移到分组下拉）一次一条 PUT、乐观显示、成功等宿主两面重读、失败回滚并按码落横幅与重读；建组（预检、50 组上限）/ 改名 / 删组；刷新；`aria-live` 区；键盘移动后的焦点；与宿主经 `v-model:pending` 共享一次一个，本地 `writing` 挡同一 tick 的第二次写，卸载时推进写 token、写仍在进行则交还共享标志 |
| `apps/web/src/views/tasks/TaskPersonalGroups.vue` | +112（新） | 「分配给我」视角：挂载时并行读个人分组与摆放（各自 generation，卸载推进）；自己的 `pending`；把板的重读接成「分组 + 摆放」，带 `items` 时另经 `TasksView` 的 `reloadListQuietly()` 重读行；行内容插槽原样转给板；写的 `ORG_MISSING` 上报 `TasksView` |
| `apps/web/src/views/tasks/TasksView.vue` | +56 / −3 | 模板：`listResult.kind === 'ok' && currentView === 'assigned'` 时挂 `TaskPersonalGroups`，行内容插槽是既有平铺行的同一份标记（完成 / 重启仍调本组件的 `onComplete` / `onReopen`）；既有 `<ul data-testid="tasks-list">` 的 `v-if` 改为 `v-else-if`，其余视角零改动。脚本：一条导入；新 `reloadListQuietly()`（同 `listGeneration`、不先置 `loading`）；`onListsOrgMissing` 的注释补一句。既有函数体零改动 |
| `apps/web/src/views/tasks/TaskListView.vue` | +145 / −50（`git diff -w`：+119 / −24） | 模板：清单项区的 `ok` 分支改为「空态文案（项为零时）+ 分组板」，FE-5 的行内容（链接、状态、截止、移出与两步确认）原样进板的插槽，行 `data-testid` 仍是 `tasks-list-detail-item`、平铺列表仍是 `tasks-list-detail-items`。脚本：分组与摆放两读（各自 generation，`org_missing` ⇒ 引导块，其余失败 ⇒ 板平铺 + 提示）、`reloadBoard()`（带 `items` 时另重读清单与清单项）、`boardTruncated`；`enterList()` 四读并行；加入 / 移出成功后清单项与摆放并行重读；路由边沿与卸载推进两读的 generation；头注改写；删去不再用的 `.tasks-list-page__item*` 样式 |
| `apps/web/src/tasks/labels.ts` | +66 | 两表各加 19 键（现各 249 键）、格式函数各加 10 个（现各 22 个）。复用的既有键：`save`、`cancel`、`listRename`、`actionFailed`、`codeLimitGroups` 与分组码 |
| `apps/web/tests/tasks-groups.spec.ts` | +2161（新） | 163 格（§5） |
| `apps/web/tests/tasks-labels.spec.ts` | +290 | 10 格（§5）；工厂补 4 个读与 8 个写的 mock 条目、`beforeEach` 缺省（默认组名用 ASCII，§7 第 9 条）；`FMT_ARGS` 加 10 行。既有断言零改动 |
| `apps/web/tests/tasks-view.spec.ts`、`tasks-list-view.spec.ts`、`tasks-detail-view.spec.ts`、`tasks-view-transitions.spec.ts`、`tasks-detail-m3.spec.ts` | 各 +14 | 只补工厂条目 `listUserGroups` / `listUserGroupItems`、对应 hoisted `vi.fn()`（带四行注释）与 `beforeEach` 缺省（合成默认组、空摆放）；**断言零改动** |
| `apps/web/tests/tasks-lists-sidebar.spec.ts` | +6 | 假后端补 `GET /api/task-groups` 与 `/api/task-groups/items` 两条路由（「有行」那一格会挂板）；断言零改动 |
| `apps/web/tests/tasks-list-detail.spec.ts`、`tasks-list-members.spec.ts` | 各 +6 | 假后端补 `GET …/groups` 与 `…/group-items` 两条路由（清单页多了两读，`afterEach` 拒绝未列出的请求）；断言零改动 |
| `apps/web/scripts/run-required-web-tests.sh` | +1 | `tasks-groups.spec.ts` 插在 `tasks-detail-view.spec.ts` 与 `tasks-labels.spec.ts` 之间（`LC_ALL=C` 序） |
| `apps/web/scripts/run-required-web-tests.tokens` | +1 | `node scripts/ops/required-web-lane-token-manifest.mjs --write` 重新生成（559 token） |
| `.github/workflows/tasks-web-guard.yml` | +14 / −1 | step 参数插入一行（同序）；「Twenty-two whole-file args」→「**Twenty-three** whole-file args」；头注加 FE-7 一段（裸文件名，不含 `vitest run` 字样与 `tests/…` 路径；全文件 `vitest run` 仍只出现一次） |

### 4. 行为规则（spec 按这些出格）

- **挂载与读（「分配给我」，§2.4 状态表）**：任务列表加载中 / 空 / 失败 ⇒ 既有状态，不挂板、不发分组读；其他视角 ⇒ 既有平铺 `<ul>`，不发分组读；assigned 且有行 ⇒ 挂载即并行发 `GET /api/task-groups?limit=100&offset=0` 与 `GET /api/task-groups/items?limit=100&offset=0` 各一次。两读未齐 ⇒ 平铺 `<ul data-testid="tasks-list">`、行序同列表、无提示；任一读失败（500、404、403、降级体、畸形）或分组不能成板 ⇒ 平铺 + 「分组不可用」（`role="status"`），行不少、不出引导块；两读都在 ⇒ 板，根容器 `data-testid="tasks-list"`、`data-scope="user"`，全页只有这一个 `tasks-list`，板内外都没有列表页其他状态 id。视角已换之后才回的分组读被丢弃。
- **顺序**：分组按 `position`、再按 id 的码元序（`tg_B` 在 `tg_a` 之前，不用 `localeCompare`）；组内按摆放的 `position`、再按任务 id；默认组末尾是「未排序」尾段（`h4`「未排序」+ `ol data-testid="tasks-group-unsorted"`），行序同服务端；无自建分组、无摆放 ⇒ 全部行在尾段，链接序与平铺列表逐项相同，每行的内容（链接、状态、截止、完成 / 重启）与其他视角的平铺行逐元素相同。每组标题旁是项数（默认组含尾段），空组显示「此分组暂无任务」。
- **默认组**：个人 scope 未落行时 `data-group-id=""`、`data-default="true"`，改名按钮禁用并以 `aria-describedby` 指向提示「首次排序或新建分组后可改名」，强行点也不打开表单；任何默认组都没有删除。首次移动发 `{"groupId":null,…}`，成功后分组读重来一次，任务在默认组有序区、组 id 变成真实 id、改名可用；之后再进默认组仍发 `null`；清单 scope 的默认组有 id 也发 `null`。首次建组让默认组落行，两组都显示。
- **移动的请求体**（`PUT /api/task-groups/items/:taskId`、`PUT /api/task-lists/:id/group-items/:taskId`）：上移 = 下标 −1、下移 = +1（首行无上移、末行无下移，含默认组有尾段时）；尾段行只有「加入排序」= 默认组有序区长度；「移到分组」= 目标组去掉该任务之后的长度，选自己的组不发（尾段行选默认组同样不发）；拖到一行上 = 它在目标组（去掉被拖任务）里的下标，拖到它的下半部 = 下标 +1，越过自己原位时按去掉自己的序数；拖到分组空白处或尾段 = 该组末尾；放回原处、放到自己身上不发。下标从板上显示的顺序数，不用服务端回传的数（服务端给出带间隔的 `position` 时照样发板上的下标）。
- **乐观与结果**：点击即按新顺序显示；PUT 进行中板的全部控件禁用、句柄 `draggable="false"`、根容器 `aria-busy="true"`、`aria-live` 区「正在保存顺序」，此时不显示停用提示；`ok` ⇒ 分组与摆放各重读一次（行不重读），显示服务端的顺序（不是自己的猜测），`aria-live` 区「已移到第 N 位」，跨组「已移到「组名」第 N 位」；`INVALID_POSITION` / `INVALID_GROUP` ⇒ 顺序回滚、横幅（`role="alert"`）给码表文案、两面重读；404 ⇒ 回滚、横幅「任务或分组已不可用」、行（个人 scope 经 `TasksView` 安静重读）+ 分组 + 摆放都重读，板与横幅留在屏上；403 ⇒「您没有权限调整分组」、500 / 畸形 200 / 契约外的码 / 传输失败 ⇒「操作失败，请稍后重试」，都不重读；`ORG_MISSING` ⇒ 页面引导块。下一次写先清横幅。
- **一次一个**：PUT 进行中第二个移动（强行启用的按钮、下拉、拖拽）都不发；同一 tick 里两次点击只发一条；强行取消下拉的选择后下拉仍显示任务所在的组。
- **键盘与焦点**：控件的可访问名带任务标题（「将「X」上移一位」等）、句柄 `aria-label`「拖动以排序」；移动成功后焦点回到同一任务的同一控件，该控件禁用或不在了（移到顶 / 底、加入排序之后）⇒ 回到该任务的「移到分组」下拉。
- **拖拽**：尾段行没有句柄、尾段里没有 `draggable="true"` 的元素；写进行中句柄全是 `draggable="false"`、`dragstart` 被取消、之后的 `drop` 不发；没有从板上拖起的 `drop` 不被拦截（`defaultPrevented` 为假）、`dragover` 只在拖着板上的行时放行，`dragend` 之后不再放行。
- **停用重排**（`[fe-35]`）：摆放指向未知分组（该任务显示在默认组有序区，同位按任务 id）、摆放指向未显示的任务（例：任务列表只给到第一页）、分组 / 摆放 / 清单项读被截断 ⇒ 顺序照显示、移动控件全部禁用、句柄不可拖、强行点也不发，提示「部分任务未显示，排序已停用」（`role="status"`，只给有管理权的人，写进行中不显示）；分组的建 / 改 / 删照常可用。
- **分组写**：建组 `POST` 规范化后的名字（修边、NFC），成功清空输入、两面重读、新组排在最后；预检（只含零宽字符、含 U+0000 ⇒「名称不能为空」，101 码点 ⇒「名称过长」，100 码点照发）与服务端 `INVALID_NAME` / `NAME_TOO_LONG` / `LIMIT`（「分组数已达上限」，不是「人数已达上限」）/ 契约外码落表单旁（`aria-invalid`、`aria-describedby`，输入保留，再输入即清）；403 / 404 / 500 ⇒ 横幅，404 另三面重读；本地已有 50 组（含默认组）⇒ 输入与提交禁用、提示「分组数已达上限」、输入了名字再派发提交也不发，49 组照常。改名：打开时预填现名、取消不发、`PATCH` 规范化后的名字、同名照发、成功收起并两面重读；预检与两个码落输入旁；404 ⇒ 横幅 + 三面重读。删组：两步内联确认（提示「确认删除分组「X」？其中的任务将回到默认分组」，同时只开一个），取消不发；`DELETE`、成功两面重读，该组的任务回到默认组尾段；`IS_DEFAULT` 落该组旁（不是横幅），确认块收起；404 ⇒ 横幅 + 三面重读。组写进行中移动同样禁用。
- **刷新**：按一次写处理（共享标志持有到读回来）；重读行、分组与摆放（清单页另重读清单），显示别人的改动。
- **行内动作仍属宿主**：「分配给我」板行里的完成调 `TasksView` 的 `onComplete`（`POST …/complete`、红点总线一次、列表重读、板重挂并重读分组）。
- **清单页**：清单、清单项、分组、摆放四个请求在任一回包前都已发出；清单项先回而分组未齐 ⇒ 平铺 `tasks-list-detail-items`，齐了 ⇒ 板（`data-scope="list"`），行仍是 FE-5 的 `tasks-list-detail-item`（链接、状态、截止、移出）；分组读失败 / 404、摆放读失败、没有默认组 ⇒ 平铺 + 提示，页面控件照常；分组或摆放读的降级体 ⇒ 引导块；清单没有任务 ⇒ 空态文案在上、板照常（组可建可改）；`owner` / `edit` ⇒ 移动、句柄、组表单；`read` ⇒ 只有顺序与刷新。板的写与页面的写共用 `pending`：板写进行中页面的改名、归档、加入任务、移出都禁用（「成员」按钮照常）、`aria-busy="true"`；页面写进行中板的控件全禁用、强行点也不发。加入 / 移出任务成功 ⇒ 清单项与摆放各重读一次、分组不重读，移出的任务的摆放随之消失。板写 404 ⇒ 板的横幅（不是页面横幅）、清单 / 清单项 / 分组 / 摆放各安静重读一次、页面留着；重读到清单 404（已失去清单）⇒ 页面转 not_found、板消失；重读到角色变成 `read` ⇒ 页头「只读」、移动控件与组表单消失。刷新同样重读清单、清单项、分组与摆放（页头显示别人的改名）；刷新时清单项读失败 ⇒ 板卸载、共享标志交还、页面控件恢复。
- **晚到**：个人 scope 换视角之后才回的移动 / 建组 ⇒ 一个请求都不发，回到 assigned 是一块新板（重读一次、控件可用、无旧横幅）；离开到任务页之后才回的移动 ⇒ 不发任何请求。清单页换清单之后才回的移动 ⇒ 两张清单都不再读、新清单的板可用；离开到任务页（同样有 `:id`）之后才回的移动 ⇒ 不发任何请求，`/api/task-lists/t1/…` 一条都没有；旧清单的分组读 / 摆放读晚到不画到新清单上。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run tests/App.spec.ts <lane 脚本里的 22 个 tasks 文件> --reporter=verbose`（`apps/web`，`a568aeedd4`；文件表从 lane 脚本的 `exec npx vitest run` 续行块抽出） | **23 文件 / 1795 用例全绿**（1622 既有 + 163 新文件 + 10 labels），0 个失败标记。`40280dd13d` 上（实现 + 只补 mock，22 文件）**1622 全绿**；`84058d3bf1` 上 1791、`7dc8fc4d0d` / `ae394e2e0b` 上 1793，同绿 |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`a568aeedd4`；`40280dd13d`、`84058d3bf1`、`ae394e2e0b` 上各跑过一次，同样） | 退出 0，0 行输出 |
| D = T = G | `D`=`T`=`G`=22 个 `tasks*.spec.ts`；yml 23 个 whole-file 参数（+`tests/App.spec.ts`）；yml 中 `vitest run` 只出现 1 次；lane 块的 tasks token 按 `LC_ALL=C` 有序 |
| `node scripts/ops/required-web-lane-token-manifest.mjs --write`，再跑检查模式 | 写入 559 token；检查模式 `MANIFEST MATCHES` |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| 锁 §5.3 两条碰撞检查（新 token） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 558 个 token 的双向子串碰撞 0 |
| 板根容器是否真被既有守卫钉住（实现提交之后、写新 spec 之前先跑，设计 §10.1 末行） | 把根容器的 `tasks-list` 改名后跑 7 个挂 `TasksView` 的既有文件：`tasks-list-view.spec.ts` 6 格、`tasks-detail-view.spec.ts` 1 格、`tasks-lists-sidebar.spec.ts` 1 格红（§7 第 12 条）；最终一轮的 B1 同此 |
| 字面扫描器 v1（19 个改动文件 + 本 MD + 设计 MD） | 全部退出 0 |
| 本机路径 / 主机名 / 局域网地址扫描（`8dc195abf6..HEAD` 的 diff 与两份 MD；模式含用户目录、用户名、机器名、`.local`、三段私网地址与部署机地址） | 0 处 |

片尾在 `8c4a21f6b3`（`a568aeedd4` 之后只多一个文档提交）上把上表前六项重跑一遍：D = T = G = 22、23 个 whole-file 参数、`MANIFEST MATCHES`、后端 manifest 守卫 29 / 29、vue-tsc 退出 0、23 文件 / 1795 全绿。

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 512、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、`tasks-detail-m4` 111、`tasks-detail-view` 44、**`tasks-groups` 163（新）**、`tasks-labels` **85**（75 + 10）、`tasks-list-detail` 101、`tasks-list-members` 111、`tasks-list-view` 32、`tasks-lists-sidebar` 67、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 30、`tasks-settings-view` 71、`tasks-view-transitions` 14、`tasks-view` 7。除 `tasks-labels` 外的既有文件与 FE-6 相同。

`tasks-groups.spec.ts` 的 163 格：纯规则·顺序 12（码元序、组内同位、尾段原序、默认组键、未知分组与非行任务两种不一致、合成默认组、五种不能成板）；纯规则·移动 10（上下移、首末与尾段无步、加入排序、移到分组与原组空操作、拖放的前 / 后 / 原位 / 空白处 / 尾段、越界、乐观模型）；`/tasks` 状态表 17（列表加载中 / 空 / 失败不读分组、其他视角、两读未齐、八种失败或不能成板、成板与状态 id、无分组时同序、行内容逐元素相同、晚到的分组读）；顺序与默认组 10；键盘 23（控件可用性、可访问名、上 / 下 / 加入排序 / 三种跨组、选项、两种原组空操作、焦点四格、`aria-live`、乐观与禁用、一次一个、同一 tick、重读、服务端顺序、服务端带间隔的 `position`）；移动失败 10；个人默认组的首次写 3；拖拽 14；分组写 27；刷新 1；行内动作 1；晚到 3；清单页：读 12、角色 3、移动与组写 8（含 404 之后失去清单 / 角色变只读两格）、与页面一次一个 5、晚到 4。`afterEach` 断言假后端没有收到任何未列出的请求。

`tasks-labels.spec.ts` 新 10 格：格式函数 1（项数的单复数、位次与组名嵌入、七个带名字的句子）；EN 七格（个人板全貌与全部控件的可访问名、未落行默认组的提示、`aria-live` 三句、五种移动失败的横幅、建组三码 / 改名错误 / 删组提示与 `IS_DEFAULT`、上限 / 停用 / 不可用三种提示、清单页的板）；ZH 正控一格；挂载后翻转一格（横幅、尾段标题、项数、可访问名、刷新）。

### 6. 变异证据

脚本驱动（脚本不入库；执行器与 FE-3–FE-6 相同）：断言每个 `old` 文本在其文件中（按编辑顺序）恰出现一次 → 备份 → 改坏（一个变异可跨多处）→ 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。

- 第一轮（`84058d3bf1`）：99 个，95 红、P1 按预期仍绿，**三个存活**：B26（被拒的选择留在下拉里：「一次一个」格没看下拉的值）、B35（建组处理函数不看上限：上限格只改了输入框的 DOM 值、没派发 `input`，`v-model` 仍是空串，预检先挡下了）、B56（移动不查「是否允许」：没有格在移动停用时强行点控件）。补格（`7dc8fc4d0d`）：一次一个格加下拉值断言；上限格改为真的输入名字再派发提交；停用格加强行点与强行选；另补两格（写进行中不显示停用提示、个人分组读截断）。三个存活与新加的八个变异（B57–B59、P8–P10、L11、L12）单跑（`ONLY=…`，同一执行器）：全部变红，P1 仍绿。
- 第二轮（`ae394e2e0b` 整轮重跑，107 个）：106 红、P1 仍绿，还原全部一致。
- 之后加了 `[fe-44]`（`a568aeedd4`，§7 第 17 条）与变异 L13（单跑红，L10 同跑仍红）。**最终一轮在 `a568aeedd4` 上整轮重跑：108 个变异，107 个变红（每一个都有断言失败的格，执行器没有打出「no failed-test count parsed」），1 个（P1）按预期仍绿为视图层等价变异；108 组文件还原全部逐字节一致；轮间与轮后 `git status` 干净；日志里没有超时**（第二轮跑的时候另有进程把机器负载推到 100，两轮的失败位置都逐个看过，都是断言行）。下表即最终一轮（括号里是失败格数）。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| R1 | 分组同位按 `localeCompare` 排 | `tasksGroupBoard.ts` | tasks-groups | 红（1） | 一致 |
| R2 | 分组只按 id 排（不看 `position`） | `tasksGroupBoard.ts` | tasks-groups | 红（32） | 一致 |
| R3 | 摆放同位不按任务 id 排 | `tasksGroupBoard.ts` | tasks-groups | 红（3） | 一致 |
| R4 | 尾段按 id 排而不是行的原序 | `tasksGroupBoard.ts` | tasks-groups | 红（1） | 一致 |
| R5 | 指向未知分组的摆放不显示 | `tasksGroupBoard.ts` | tasks-groups | 红（2） | 一致 |
| R6 | 指向未知分组的摆放不令板「不一致」 | `tasksGroupBoard.ts` | tasks-groups | 红（3） | 一致 |
| R7 | 指向非行任务的摆放不令板「不一致」 | `tasksGroupBoard.ts` | tasks-groups | 红（2） | 一致 |
| R8 | 接受两个默认组 | `tasksGroupBoard.ts` | tasks-groups | 红（2） | 一致 |
| R9 | 接受两个同 id 的分组 | `tasksGroupBoard.ts` | tasks-groups | 红（1） | 一致 |
| R10 | 原地移动仍算一次移动 | `tasksGroupBoard.ts` | tasks-groups | 红（3） | 一致 |
| R11 | 下标上限把被移任务算进去 | `tasksGroupBoard.ts` | tasks-groups | 红（2） | 一致 |
| R12 | 拖放的下标在含被移任务的序列里数 | `tasksGroupBoard.ts` | tasks-groups | 红（5） | 一致 |
| R13 | 「加入排序」落在末尾之前一位 | `tasksGroupBoard.ts` | tasks-groups | 红（12） | 一致 |
| R14 | 默认组以板上的键（空串）发送而不是 `null` | `tasksGroupBoard.ts` | tasks-groups | 红（26） | 一致 |
| R15 | 乐观模型不把任务从尾段拿走 | `tasksGroupBoard.ts` | tasks-groups | 红（1） | 一致 |
| R16 | 放到下半部仍落在该行之前 | `tasksGroupBoard.ts` | tasks-groups | 红（4） | 一致 |
| R17 | 放到空白处落在最前 | `tasksGroupBoard.ts` | tasks-groups | 红（3） | 一致 |
| R18 | 选自己所在的组也算移动 | `tasksGroupBoard.ts` | tasks-groups | 红（2） | 一致 |
| R19 | 尾段行可以上移 / 下移 | `tasksGroupBoard.ts` | tasks-groups | 红（1） | 一致 |
| B1 | 板根容器丢掉 `data-testid="tasks-list"` | `TaskGroupBoard.vue` | tasks-groups tasks-list-view tasks-detail-view tasks-lists-sidebar | 红（58） | 一致 |
| B2 | 尾段行用固定的 test id 而不是宿主给的 | `TaskGroupBoard.vue` | tasks-groups tasks-list-detail | 红（9） | 一致 |
| B3 | 移动 `ok` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（20） | 一致 |
| B4 | 移动 `ok` 后仍显示自己的猜测（不清乐观顺序） | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B5 | 移动失败不回滚 | `TaskGroupBoard.vue` | tasks-groups | 红（9） | 一致 |
| B6 | `INVALID_POSITION` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B7 | `INVALID_GROUP` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B8 | 404 不重读行 | `TaskGroupBoard.vue` | tasks-groups | 红（7） | 一致 |
| B9 | 403 也重读 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B10 | `ORG_MISSING` 不上报宿主 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B11 | 写不占共享标志 | `TaskGroupBoard.vue` | tasks-groups | 红（7） | 一致 |
| B12 | 没有本地 `writing` 标志（同一 tick 两次写） | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B13 | 写不看共享标志 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B14 | 写结束不交还共享标志 | `TaskGroupBoard.vue` | tasks-groups | 红（16） | 一致 |
| B15 | 卸载不推进写 token | `TaskGroupBoard.vue` | tasks-groups | 红（5） | 一致 |
| B16 | 卸载时写仍在进行，不交还共享标志 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B17 | 尾段行有拖拽句柄 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B18 | 写进行中句柄仍可拖 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B19 | 写进行中上移仍可用 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B20 | 首行上移可用 | `TaskGroupBoard.vue` | tasks-groups | 红（4） | 一致 |
| B21 | 末行下移可用 | `TaskGroupBoard.vue` | tasks-groups | 红（5） | 一致 |
| B22 | 写进行中仍能起拖 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B23 | 没有从板上拖起的放置也被拦下 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B24 | 没在拖时 `dragover` 也放行 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B25 | `dragend` 不结束拖拽 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B26 | 被拒的选择留在下拉里（下拉自改） | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B27 | 键盘移动后不还焦点 | `TaskGroupBoard.vue` | tasks-groups | 红（5） | 一致 |
| B28 | 控件禁用时焦点没有兜底 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B29 | `aria-live` 区不说「正在保存顺序」 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B30 | `aria-live` 区报 0 起的位次 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B31 | 建组 `LIMIT` 用 M3 的「人数已达上限」 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B32 | 分组上限差一（`>` 代替 `>=`） | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B33 | 建组不预检名称 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B34 | 建组发原串 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B35 | 建组处理函数不看上限 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B36 | 无 id 的默认组可改名 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B37 | 打开改名不查 id | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B38 | 删组不经确认 | `TaskGroupBoard.vue` | tasks-groups | 红（5） | 一致 |
| B39 | 默认组有删除 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B40 | `IS_DEFAULT` 落横幅 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B41 | 刷新不占共享标志 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B42 | 刷新不重读行 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B43 | 板不一致时没有提示（只认截断） | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B44 | 截断时仍可移动 | `TaskGroupBoard.vue` | tasks-groups | 红（5） | 一致 |
| B45 | 不一致时仍可移动 | `TaskGroupBoard.vue` | tasks-groups | 红（3） | 一致 |
| B46 | 只读成员也有移动控件 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B47 | 分组读失败不提示 | `TaskGroupBoard.vue` | tasks-groups | 红（10） | 一致 |
| B48 | 不能成板的分组集不提示 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B49 | 摆放读未回时就成板 | `TaskGroupBoard.vue` | tasks-groups | 红（4） | 一致 |
| B50 | 下一次写不清横幅 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B51 | 默认组项数不含尾段 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B52 | 改名发原串 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B53 | 改名 `ok` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B54 | 删组 `ok` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B55 | 建组 `ok` 不重读 | `TaskGroupBoard.vue` | tasks-groups | 红（2） | 一致 |
| B56 | 移动不查「是否允许」（强行点仍发） | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B57 | 上移 / 下移按服务端回传的 `position` 算而不是板上的顺序 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| B58 | 已落行的默认组以真实 id 发送 | `TaskGroupBoard.vue` | tasks-groups | 红（14） | 一致 |
| B59 | 写进行中也显示停用提示 | `TaskGroupBoard.vue` | tasks-groups | 红（1） | 一致 |
| P1 | 个人分组读去掉 generation 判断 | `TaskPersonalGroups.vue` | tasks-groups | 仍绿（等价变异，见注）（0） | 一致 |
| P2 | 个人重读从不重读行 | `TaskPersonalGroups.vue` | tasks-groups | 红（5） | 一致 |
| P3 | 个人重读漏掉分组读 | `TaskPersonalGroups.vue` | tasks-groups | 红（12） | 一致 |
| P4 | 个人分组在每个视角都挂 | `TasksView.vue` | tasks-groups | 红（5） | 一致 |
| P5 | 安静重读列表不安静（先置 `loading`） | `TasksView.vue` | tasks-groups | 红（5） | 一致 |
| P6 | 插槽里的行标记与平铺行不同 | `TasksView.vue` | tasks-groups | 红（1） | 一致 |
| P7 | `/tasks` 上板写的 org 上报没接 | `TasksView.vue` | tasks-groups | 红（2） | 一致 |
| P8 | 列表为空时也挂个人分组 | `TasksView.vue` | tasks-groups tasks-view | 红（2） | 一致 |
| P9 | 个人板不理会摆放读截断 | `TaskPersonalGroups.vue` | tasks-groups | 红（1） | 一致 |
| P10 | 个人板不理会分组读截断 | `TaskPersonalGroups.vue` | tasks-groups | 红（1） | 一致 |
| L1 | 加入任务不重读摆放 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L2 | 移出任务不重读摆放 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L3 | 清单页不读分组 | `TaskListView.vue` | tasks-groups | 红（30） | 一致 |
| L4 | 清单页单向绑定共享标志 | `TaskListView.vue` | tasks-groups | 红（2） | 一致 |
| L5 | 清单页分组读去掉 generation 判断 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L6 | 清单页摆放读去掉 generation 判断 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L7 | 板的截断不看清单项 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L8 | 分组读缺 org 只算不可用 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L9 | 清单页板写的 org 上报没接 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L10 | 清单页的重读从不重读清单项 | `TaskListView.vue` | tasks-groups | 红（3） | 一致 |
| L11 | 清单板不理会摆放读截断 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L12 | 清单板不理会分组读截断 | `TaskListView.vue` | tasks-groups | 红（1） | 一致 |
| L13 | 板写 404 / 刷新不重读清单 | `TaskListView.vue` | tasks-groups | 红（4） | 一致 |
| T1 | EN 的「未排序」写成中文 | `labels.ts` | tasks-labels | 红（20） | 一致 |
| T2 | 板的文案表在 setup 时一次性求值 | `TaskGroupBoard.vue` | tasks-labels | 红（3） | 一致 |
| T3 | 板的格式函数表一次性求值 | `TaskGroupBoard.vue` | tasks-labels | 红（3） | 一致 |
| T4 | 刷新按钮硬编码中文 | `TaskGroupBoard.vue` | tasks-labels | 红（23） | 一致 |
| T5 | EN 的上移可访问名写成中文 | `labels.ts` | tasks-labels | 红（8） | 一致 |
| A1 | 个人 PUT 去掉任务 id 的路径段检查 | `tasksApi.ts` | tasks-groups tasks-api-m4 | 红（3） | 一致 |
| A2 | 清单 PUT 去掉任务 id 的路径段检查 | `tasksApi.ts` | tasks-groups tasks-api-m4 | 红（3） | 一致 |

- **P1 记为等价变异**：`TaskPersonalGroups` 两读的 generation 只在两种时刻起作用——卸载之后的晚到（组件已卸载，写它的 ref 没有可见的后果）与一次重读压过另一次重读（板的写持有共享标志直到两读回来，刷新也算写，所以两次重读不会交错）。保留它是为了让「晚到不落地」在代码里成立，不为它造不可达的格；同一判据在清单页是可达的（换清单之后旧清单的读晚到，L5 / L6 变红）。
- **A1 / A2 只有 FE-1 的 `tasks-api-m4` 红**：板只把服务端给的任务 id 放进路径，视图层到不了路径段检查（与 FE-5 的 P4–P6、FE-6 的 A1 / A2 同理；按简报不新加 id 边界值的探测格）。
- **设计 §10.1 FE-7 行最右列七条**：`position` 用服务端回传值做算术（B57，用服务端带间隔的 `position` 那一格）；失败不回滚（B5）；尾段可拖（B17）；个人 scope 发默认组真实 id 而不是 `null`（B58，两种 scope 一起钉）；板根容器去掉 `data-testid="tasks-list"`（B1：本 spec 与既有的 `tasks-list-view.spec.ts` 6 格、`tasks-detail-view.spec.ts` 1 格、`tasks-lists-sidebar.spec.ts` 1 格同时红，§7 第 12 条）；重排成功只重读摆放（P3，首次写那一格红）；`listResult` 为 `empty` 时也挂板（P8：本 spec 与既有 `tasks-view.spec.ts` 的 TESTIDS 精确集合格同时红）——全部变红。简报点名的面：渲染顺序（R1–R4）、默认组与个人合成默认组（R14、B36、B37、B39、B58、P3）、建组 / 改名 / 删组与 `IS_DEFAULT` / `LIMIT`（B31–B35、B38–B40、B52–B55）、键盘与拖拽的请求体（R10–R19、B20–B26、B57）、错误码落点（B5–B10、B31、B40）、写后的失效与重读（B3、B4、B53–B55、P2、P3、L1、L2、L10、L13）、晚到守卫（B15、L5、L6；P1 等价）、共享 `pending`（B11–B14、B16、L4）、文案（T1–T5）。

### 7. 与设计的偏差 / 解释

1. **行内容走宿主的插槽，平铺回退也由板渲染**（`[fe-33]`，§12-Q27）：§2.3 / §4.6 写的是 `TaskPersonalGroups` 自己渲染平铺 `<ul>`、板的完成 / 重启「通过 emit 回传」。实现把行内容（标题链接、状态、截止、完成 / 重启；清单页是链接、状态、截止、移出与两步确认）留在宿主模板里、以 `row` 插槽交给板，板在分组读未齐 / 失败 / 不能成板时自己渲染平铺列表——同一宿主里平铺与分组只有一份行内容，不会漂移；完成 / 重启仍直接调 `TasksView` 的 `onComplete` / `onReopen`（`listPageToken` 守卫不变），不经 emit。`TasksView` 其余视角的平铺 `<ul>` 原样不动，于是插槽里有第二份同样的行标记，由「每行内容与平铺行逐元素相同」格钉住（P6 证明它会红）。DOM 契约不变：平铺时 `<ul data-testid="tasks-list">` 与 `tasks-list-item`，成板时根容器 `tasks-list`。平铺回退的 `<li>` 多了 `data-task-id` 属性（既有平铺行没有），不影响既有格。
2. **板有自己的横幅**（`[fe-34]`，§12-Q28）：§4.0 写的是 `not_found` / `forbidden` / `error` 走页面通用横幅。个人 scope 没有页面横幅可借（`TasksView` 的 `tasks-action-error` 只有四种 kind），清单页的写 404 文案「清单不可用或你已不是成员」也不合一次移动的 404（多半是任务已被移出清单）；板的横幅 `tasks-groups-banner`（`role="alert"`）两种 scope 同形，§4.4 的「行内横幅」即此。板写 404 时清单页横幅不出现（格里断言）。
3. **停用重排的判据比 §6.4 宽**（`[fe-35]`，§12-Q29）：§6.4 只写「清单项或摆放读被截断」。实现的判据是「板的下标空间就是服务端的」：三读都没截断、每条摆放指向一行已显示的任务、每条摆放指向一个已知分组。理由：「分配给我」的行来自 `GET /api/tasks?view=assigned`，不带分页参数时服务端只给 100 行（PR-3a §7.1 的缺省 `limit`），而摆放读给全部页；第一页之外的已摆放任务会让本地数出的下标比服务端的小，PUT 落错位置或 422。该情形与「摆放指向未知分组」（两面重读之间的不一致）都按截断处理：顺序照显示、移动全部禁用（强行点也不发，B56）、提示「部分任务未显示，排序已停用」。提示只给有管理权的人、写进行中不显示（两面重读的空档里不闪，B59）。文案没有用 §4.2 的「清单过大，排序已停用」：两种 scope 共用、也覆盖不是「过大」的不一致。
4. **拖拽的细则**（`[fe-36]`，§12-Q30）：§6.2 只写了「放置点前面的行数 = position」。实现：放到一行上 = 放在它之前，放到它的下半部（`clientY` 过该行盒子中线）= 放在它之后；放到分组空白处或「未排序」尾段 = 该组有序区末尾。句柄是行首的 `<span role="img" aria-label="拖动以排序">`（字形 ⋮⋮ 在 CSS 里，不进文本扫描），`draggable` 在句柄上、拖拽图取整行（`setDragImage`）；§6.2 写的是「⋮⋮」按钮——没用 `<button>`：按钮不在键盘移动的路径上（上移 / 下移 / 下拉才是），作为拖拽源在部分浏览器里起拖有问题（UNVERIFIED，未在浏览器里试，§8）。jsdom 没有 `DragEvent` / `DataTransfer`，spec 用 `MouseEvent` 派发并靠组件状态记住被拖的任务，`dataTransfer` 只在存在时用。
5. **不能成板的分组集按「分组不可用」处理**（`[fe-37]`）：没有或不止一个默认组、非默认组没有 id / id 为空 / id 重复——服务端的唯一索引不会给出，客户端也不去猜哪一个算默认组。
6. **焦点的兜底**（`[fe-38]`）：§6.3 写「焦点保持在同一任务的同一按钮上」；上移到顶、下移到底之后那个按钮禁用，「加入排序」之后那个按钮不在了——此时焦点去该任务的「移到分组」下拉（成功后、共享标志交还、重渲染之后再设焦点；写进行中控件全禁用，设不了焦点）。拖拽不移焦点。
7. **刷新算一次写**（`[fe-39]`）：持有共享标志直到读回来（行、分组、摆放；清单页另有清单，第 17 条）——刷新进行中不能移动、不能写页面，也不会与写交错地覆盖本地顺序。清单页刷新时清单项读失败会让板卸载（清单项区换成「暂时无法读取」），此时板在卸载钩子里交还共享标志，页面控件恢复——FE-6 记为等价变异的「卸载时交还」在这里有了可见的格（B16 变红）。
8. **个人 scope 的「重读整板」**（`[fe-40]`）：§4.4 的 `not_found ⇒ 重读整板`。「分配给我」的行属于 `TasksView`，`TaskPersonalGroups` 自己读不到；实现给 `TasksView` 加了 `reloadListQuietly()`（同 `listGeneration`，不先置 `loading`，所以 `TaskPersonalGroups` 与板不卸载、横幅留在屏上——P5 证明若不安静，404 的横幅会随重挂消失），经 `reload-items` prop 交给 `TaskPersonalGroups`。`TasksView` 既有函数体零改动（`loadList` 不动；新函数与它的结尾判断同形）。
9. **默认组名是服务端数据**（`[fe-41]`，§12-Q31）：PR-3a 的默认组名是服务端常量 `默认分组`（落行后存进库，可改名），前端照显示；英文界面在改名之前看到中文名。`tasks-labels.spec.ts` 的夹具把默认组名写成 ASCII（该文件的夹具一律 ASCII，扫描到的 CJK 只能来自界面自己的文案），五个中文语境的既有 spec 用 `默认分组`。
10. **清单为空时仍显示分组板**（`[fe-42]`）：既有空态文案「清单中还没有任务」照旧（FE-5 的格不变），其下是板，组可建可改可删——个人 scope 没有这个入口（列表为空时 `TaskPersonalGroups` 不挂载，§2.4 状态表）。
11. **`INVALID_POSITION` 的文案**（`[fe-43]`）：§4.4 写「位置已变化，请刷新后重试」并自动重读，§6.5 写「顺序已被他人更新，已刷新」。用 §9.2 码表里的前者（`codeMessage`），板照样自动重读两面；`INVALID_GROUP` 同样取码表的「分组不存在」（§4.4 写的是「分组已不存在」）。
12. **板根容器的回归锚点**：设计 §10.1 写「板根容器去掉 `data-testid="tasks-list"` ⇒ 本格与 `tasks-list-view.spec.ts:134` 同时红」。实测（B1）：该格（现在 `:172`「renders tasks-list for a non-empty ok response」）**不红**——它的 flush 在两条分组读回来之前就结束了，看到的是平铺回退（同样带 `tasks-list`）；但 `tasks-list-view.spec.ts` 另有 6 格（完成 / 重启失败后「列表还在」）、`tasks-detail-view.spec.ts` 1 格、`tasks-lists-sidebar.spec.ts` 1 格红。结论不变：改名会让既有守卫红。§10.1 的另一条「`listResult` 为 `empty` 时也挂板 ⇒ `tasks-view.spec.ts` 的 TESTIDS 格红」由 P8 证实。
13. **`[R12]` 的落点**：板只认宿主给的 `canManage`；清单页给的是既有的 `canManage`（`myRole ∈ {edit, owner}`，§5.1 表里「建组 / 改组 / 删组」与改名同一行），个人 scope 恒为真。`TaskListView` 头注的能力清单还没列出分组的写与移动，留给 FE-8 的注释刷新（§9）。
14. **每行的「移到分组」下拉列出全部分组**：50 组 × 2000 行时是 10 万个 `<option>`；没有量过大清单的渲染耗时（§8）。
15. **文案来源**：取自设计原文的 ZH 文案——「未排序」「拖动以排序」「上移」「下移」「加入排序」「正在保存顺序」「已移到第 N 位」「刷新」「首次排序或新建分组后可改名」「新建分组」「分组不可用」（§2.4、§4.4、§4.6、§6.1–§6.5）；复用既有键 `codeLimitGroups`「分组数已达上限」、`codeIsDefault`、`codeInvalidGroup`、`codeInvalidPosition`、`codeInvalidName`、`codeNameTooLong`、`listRename`「改名」、`save`、`cancel`、`actionFailed`。新写的 ZH：「此分组暂无任务」「部分任务未显示，排序已停用」「新分组名称」「分组名称」「分组新名称」「删除分组」「确认删除」「任务或分组已不可用」「您没有权限调整分组」与十个格式函数里除「已移到第 N 位」外的句子；EN 全部新写。
16. **既有 spec 的改动只有 mock**（§3 表）：六个挂 `TasksView` 的显式工厂补两个个人读；`tasks-labels.spec.ts` 另补两条清单读与八个写（新格要用）；三个拒绝未列出请求的假后端（`tasks-lists-sidebar`、`tasks-list-detail`、`tasks-list-members`）补两条读路由——FE-6 的说明只点名了六个工厂，这三个文件在实现后第一次跑 22 个文件之前就补上了，没有出现过红。
17. **清单页板的 404 与刷新另重读清单**（`[fe-44]`，§12-Q32）：FE-6 的说明请本片「复用 `reloadListQuietly()` 做清单重读」。板自己的写不改清单（S8.10：分组的写不改清单的 `updatedAt`），所以成功之后不读清单；但一次移动或组写回 404 可能意味着本人已不是成员或角色已变——此时照成员对话框的 `[fe-31]` 请页面安静重读清单：失去清单 ⇒ 页面转 not_found，角色变成 `read` ⇒ 控件随之消失；刷新也一并重读清单（页头的名字、归档标与角色跟着更新）。页面自己的写回 404 仍按 `[fe-24]` 只出横幅（§12-Q20 待裁；若裁为也重读，两者合一）。这一条是在第二轮变异之后加的（`a568aeedd4`），最终一轮跑在它之上，变异 L13 钉住。

### 8. NOT RUN

- **真机 / 浏览器**：没有对 PR-3a 分支起后端联调（设计 §10.5；S8 路由在 PR-3a 分支上已建、未联调）。真实浏览器里的 HTML5 拖放（`DataTransfer`、拖拽图、句柄作为拖拽源在各浏览器的表现、放置点的上下半部判断）、焦点在按钮被禁用时的去向、屏幕阅读器对 `aria-live` 的播报、板的布局与窄屏、大清单（多组 × 多行的下拉）的渲染耗时，都没有看过。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane：NOT RUN（§10.4 排在 FE-8）；本片跑的是 23 个 whole-file 参数、manifest 写入与检查模式、后端 manifest 守卫。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` + 两个 verification 项目）：NOT RUN；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（spec 文件不在其中，只经 vitest 的 esbuild 转译）。`pnpm --filter @metasheet/web build`：NOT RUN。
- 整个 `apps/web` 的 vitest 全量：NOT RUN。本片没有改路由表，引用 `appRoutes` 的其余 spec 没有重跑。
- CI：未推送、未开 Draft PR，`tasks-web-guard` 在 CI 上 NOT RUN。
- staging / 生产：未触达。

### 9. 给 FE-8 的说明

- **PR-3a 已前进**：本片读契约时 PR-3a 在 `d18c436c8d`，片尾在 `c8fdd07e2b`。其间只核对了 S8（§1：不变）；同一区间还有 `[own-53]`（负责人 / 关注人的增删要求对任务有直接角色）、`listIds` 按角色、已归档清单的成员路由。FE-4 / FE-5 / FE-6 是按更早的 head（`510fba6917`、`a1162030bf`）编码的：收口前把 §S5.9、§S6.8、§S7.9 的前端对接表与设计 §3.2–§3.4 对 `c8fdd07e2b`（或当时的 head）重新 diff 一遍，有出入先改设计再改客户端与 spec。
- **注释刷新**：`tasksApi.ts` 头注仍写「list members (S6), list items (S7), groups (S8) … not built yet」（三者在 PR-3a 分支上都已建）；FE-5 的 `[fe-21]`–`[fe-26]` 与 FE-6 的 `[fe-27]`–`[fe-32]` 代码标签按简报未动；`TaskListView.vue` 头注的能力清单没列出分组的写与移动（它们跟 `canManage` 走，§7 第 13 条）。`[fe-33]`–`[fe-44]` 已在代码里标好。
- **登记**：D = T = G = 22，yml 23 个 whole-file 参数（Twenty-three），`.tokens` 559 个；FE-8 的 M4 汇总头注段照 §10.3 ③ 的约束写（裸文件名，不出现 `vitest run` 与 `tests/…` 路径）。
- **真机必做**（§10.5 与本节 §8）：拖放在 Chrome / Firefox / Safari 各试一次（句柄起拖、上下半部、跨组、放到尾段与空白处、写进行中不可拖）；「分配给我」超过 100 条且有摆放落在第一页之外时提示出现、移动停用（`[fe-35]`，§12-Q29 里另问是否给该视角读全部页）；个人默认组首次移动落行后改名解禁。
- **owner 问题**：§12-Q27–Q31（缺省即现行为）。默认组名的英文显示（Q31）若要改，需要后端配合或改为前端只认 `isDefault`，两者都会碰 PR-3a 的契约，单列。
- **测试**：本 spec 的假后端按 PR-3a S8 的规则落位（`applyPlace`：去掉被移任务后插入、整组重排、个人默认组首次写落行；摆放读按组稠密重编号），新格可直接复用；「晚到」格数的是离开之后的全部请求（含另一路由的 `:id` 下的读），沿用 FE-5 / FE-6 的教训。

---

## FE-8 收口（设计 §10.2–§10.5、§11、§12、§13 FE-8；owner 2026-10-07 裁定之后；本片新取舍 `[fe-45]`–`[fe-48]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `e3222a136e`（FE-7 已记 23 文件 / 1795 全绿）；第一处改动之后跑 23 个文件仍是 1795 全绿（改动不碰既有格的断言） |
| PR-3a 对照提交 | 本地分支 `claude/tasks-m4-pr3a`：`git ls-remote` 查不到、`gh pr list --head` 为空，即未推送、没有 PR。契约逐表对照以起手时的 head `f4a0eb532c`（S9 定稿）为准。本片进行中该分支前进到 `d772449306`（`bd8a99276e` S9 收尾；`92a5c6695b` / `ca8f1efb5b` / `865ffba88e` / `6425741b62` / `6a8a8e029b` / `accda4af0c` / `d772449306` 为 S10，后三个只改文档）：`bd8a99276e` 相对 `f4a0eb532c` 的 `packages/core-backend/src` 差异为空；到 `d772449306` 为止 `src` 下只有迁移文件改名（`zzzz20261001090000` → `zzzz20261008090000`，内容只改注释）与注释、标签的改写，非注释代码行 0 处；两份文档的改动是裁定记账与措辞，路由表与前端对接表的取值不变——前端契约不变，本片的结论对这几个提交同样成立。（2026-10-09 注：PR-3a 的迁移文件此后再次改名，现为 `zzzz20261009130000_create_task_m4_tables.ts`，排在 main 上全部迁移之后；本句与 FE-5 节写的是当时的文件名。前端不依赖迁移文件名。） |
| 读的契约 | PR-3a 设计 §3.0–§3.6、§5.5、§6.3、§11、§12；验证 §S5.9、§S6.8、§S7.9、§S8.10、§S67F.1–§S67F.8、§S9（§S9.1–§S9.9） |
| owner 裁定（2026-10-07） | R01–R23 与 N1 / N2；R12 取 PR-3a 的收窄版 (a1) / (a2)（PR-3a 的 `[own-25]`）；增删负责人与关注人须直接角色（PR-3a 的 `[own-53]`）；`[fe-19]` ratify。裁决包是私有件，本文只按条目 id 引用 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `f137275392` | 详情页四个成员控件看 `canManageMembers`（`[fe-45]`），缺键退回 `canEdit`（`[fe-46]`），「所属清单」区的加入下拉看同一能力（`[fe-47]`）；`TaskDetail.canManageMembers?` 与解析 |
| `11171852f1` | 创建表单的 `validation` 结果按码显示文案（含 `INACTIVE_ORG_MEMBER`） |
| `b887ffcdc8` | 格：`tasks-detail-m4` +47、`tasks-api-m4` +10、`tasks-labels` +2 |
| `c4a4a3c4d6` | 清单页「加入任务」的 404 文案按 R12 (a1) 改写，两格随之改 |
| `51b72b40d4` | 已裁条目的代码标签改为 `RULED(2026-10-07)`，混写的注释拆行（只改注释） |
| `96e78abec4` | 注释刷新：`tasksApi.ts` 头注与分节、`labels.ts`、`[fe-10]` `[fe-16]` `[fe-21]`–`[fe-26]` 落到代码、`TaskListView` 头注的能力清单、M4 spec 头注、守卫 yml 头注（只改注释） |
| `b478635fb9` | 设计：抬头、§3.2、§4.2、§4.3、§9.2、§10.4、§11（标签约定与 ruled 标记、`[R01]` `[R17] [N2]` 两行、`[fe-45]`–`[fe-47]`）、§12（Q5 / Q11 / Q12 / Q14 注记，Q33 / Q34）、§13、§14 |
| `edecfdf504` | 本文 FE-1 … FE-7 各节的措辞 |
| `840fe43fd1` | 创建表单的码只在一处复位（变异轮发现两处复位互相遮蔽，§6） |
| `c924461946` | 成员对话框在写落地之后把焦点收回对话框（`[fe-48]`，真机走查发现，§7） |
| `1e18fce28b` | 格：`tasks-list-members` +4 |
| `5a922e0854` | 设计：§5.2 / §11 `[fe-48]`、§12-Q35；抬头与 §8.3 的措辞 |
| `2c1360ee4e` | 本节与全线汇总；本文抬头 |
| `3e885adfe0` | §1 记 PR-3a 收口时的最新 head `d772449306` |
| 本文所在提交 | 守卫 yml 的 FE-8 头注补上 `tasks-list-members.spec.ts` 的格与对话框焦点；本节 §2、§5 的更正 |

### 3. 逐项结果

**(1) `canManageMembers`（owner 2026-10-07）**

- 规则：四个成员控件（负责人的移除按钮与添加表单、关注人的移除按钮与添加表单）显示条件 = 详情带 `canManageMembers` 时取它，缺键时取 `canEdit` 的既有规则（`canEdit !== false`）。完成方式下拉、设父表单、「设为独立任务」、编辑区仍看 `canEdit`；「退出关注」仍看 `canLeave`；「所属清单」区的移出仍看 `canEdit`，加入下拉看成员管理能力（`[fe-47]`）。
- 缺键规则的取法（`[fe-46]`，§12-Q33）：不取「缺键即隐藏」——main 上的 M3 后端从不发这个键，隐藏会让创建人与负责人看不到增删控件，M3 的既有格（「无能力键时控件都在」）会红；也不取「缺键即显示」——会对关注人显示必然 404 的控件。main 上 M3 的后端不发这个键，它对这四条写的判据就是 `canEdit` 报的 `edit`（main 上只有任务的创建人与负责人有它），退回它与服务端逐一相符。PR-3a §S67F.8 写的是「控件照旧显示，由服务端 404 把关」，`canEdit` 回退就是「照旧」。
- 格：`tasks-detail-m4` 四个控件 × 七种组合（真 / 假 / 缺 × `canEdit` 真 / 假 / 缺）28 格；`canEdit` 系的四个控件在两种相反组合下 8 格；「退出关注」1 格；只经清单编辑的人一格（字段编辑保存成功、没有成员控件、名单可读、移出在加入下拉不在）；加入下拉四格。`tasks-api-m4` 解析 7 格（真、假、缺、四种非布尔）。
- 变异 M1–M19（§6）全部变红；M3 的既有 `tasks-detail-m3` 格对「缺键即隐藏」（M7）红 30 格，对「缺键即显示」（M6、M9）红 1 格。

**(2) 422 `INACTIVE_ORG_MEMBER`（R17 / N2）**

- 文案：`labels.ts` 早在 FE-0 就有一条 `codeInactiveOrgMember`（中「该用户不在当前组织或已停用」，英 "This user is not in the current organization or has been deactivated"），`TASKS_CODE_KEYS` 把码映射到它，全线一码一文案，本片没有加第二条。
- 落点与格：清单成员的添加表单与转让行（§5.3，FE-6 已有格）；详情页增负责人表单旁（`tasks-detail-membership-error`）与增关注人表单旁（`tasks-detail-follower-error`）——两处原本就把 `validation` 码经 `codeMessage` 落在行内，本片补格（中文两格、英文一格、API 两格）；创建表单（`tasks-create-error`）——原先任何 `validation` 都显示通用失败文案，本片改为按码显示（`11171852f1`），中文三格、英文一格、API 一格（带负责人的请求体）。创建表单本身不发 `assignees`（只有创建人，服务端不查在职），所以从界面到不了这一格，记在 §8。
- 真机：清单成员添加、增负责人、增关注人三处都由真后端答 422，界面文案与落点如上（§7）。

**(3) 契约重核（对 `f4a0eb532c`）**

| 面 | 前端编码时读的 PR-3a 提交 | 结果 |
|---|---|---|
| 设置 GET / PATCH（FE-1、FE-3） | `00ddafad23`、`3e2699758c` | 形状与码不变；`[own-39]`（PATCH 只读 `application/json` 请求体）：`apiFetch` 对非 FormData 的请求体自动带这个 `Content-Type`，真机保存 200 |
| `PATCH /api/tasks/:id`（FE-1、FE-4） | `00ddafad23`、`3e2699758c` | 不变；`[own-38]`（截止瞬时越过 9999 年 ⇒ `INVALID_DATE`）由服务端答，前端已有落点，不加预检 |
| `GET /api/tasks/:id` | `3e2699758c` | 新键 `canManageMembers`（键恒在）⇒ 第 (1) 项；`listIds`、`followers` 与五个能力键恒在，形状同前端解析器 |
| `POST /api/tasks` | `00ddafad23` | 新码 `INACTIVE_ORG_MEMBER`（S9）：`createTask` 的 allowlist 早已含它；创建表单补按码显示 ⇒ 第 (2) 项 |
| 增 / 删负责人与关注人 | M3 契约 | 新增 422 `INACTIVE_ORG_MEMBER`（增）与没有直接角色的 404（`[own-53]`）：写失败分类器原样处理；控件改看 `canManageMembers` |
| 清单 7 条（S5） | `510fba6917` | 不变（其后 S5 的改动只涉及时间戳与排序的钉格） |
| 成员 5 条（S6） | `a1162030bf` | 不变；S6-ARCH-1（已归档清单上成员路由照常）：前端本来就不按归档隐藏成员控件 |
| 清单项 3 条（S7） | FE-5 时未建，按契约编码 | 已建，形状、码、空操作与契约一致；(a1) 收窄后清单页加入 404 的文案「你不能编辑它」对清单编辑者不成立 ⇒ 改为「你不是它的创建人或负责人」（`c4a4a3c4d6`）；详情页加入下拉跟成员管理能力（`[fe-47]`） |
| 分组 12 条（S8） | `d18c436c8d`、`c8fdd07e2b` | 不变 |
| 清单动态的事件词 | 迁移闭集 | 15 个词与 `TASKS_LIST_EVENT_KEYS` 逐个相同 |
| 红点与实时 | `0de12b4a9d` | PR-3c 未建，不变 |

**(4) 裁定的记账**

- 约定（设计 §11 抬头）：已裁条目在代码里标 `RULED(2026-10-07): [Rxx]`，设计 §11 对应行标 **ruled 2026-10-07**；D 条目与 PR-3a 的其余 `[own-NN]` 仍是 `ASSUMPTION(task-m4-fe)`。
- 代码：`ASSUMPTION(task-m4-fe)` 66 行 → 34 行 `ASSUMPTION` + 37 行 `RULED`（拆行 4 处、新注释 1 处）；`RULED` 覆盖 R02 R03 R04 R07 R11 R12 R13 R15 R16 R17 R19 R20 与 `[own-25]`；仍是 `ASSUMPTION` 的是 D5 D7 D14 与 `[own-06]` `[own-07]` `[own-08]` `[own-09]` `[own-11]` `[own-14]` `[own-19]` `[own-24]` `[own-29]` `[own-30]` `[own-31]`。复查：`ASSUMPTION` 行里引用已裁 id 的为 0。
- 设计：§11 标 ruled 的行 R02 R03 R04 R07 R11 R12 R13 R15 R16 R19 R20 与 `[own-25]`，新增 `[R01]`、`[R17] [N2]` 两行；`[fe-19]` 原已记 ratified；§12-Q5 记已裁（R20 取 (a)），Q11 注明 R01 已裁、入锁计分仍待答，Q12 注明前提已不成立（#6159 已合入 main，本分支以 main 为基），Q14 注明 `[own-11]` 仍待裁，Q15 原已记。

**(5) 注释刷新**：见 §2 的 `96e78abec4`。`[fe-21]`–`[fe-26]` 各落一处（`[fe-23]` 四处），`[fe-27]`–`[fe-44]` 已在代码里；`[fe-01]` 是不拆文件的结构取舍，没有代码落点。

### 4. 行为规则（本片新增的格按这些出）

- 详情的 `canManageMembers` 为真 ⇒ 四个成员控件在（即使 `canEdit` 为假）；为假 ⇒ 都不在（即使 `canEdit` 为真）；缺键 ⇒ 跟 `canEdit`（为假才隐藏）。完成方式、设父、设为独立、编辑区不跟它；「退出关注」只看 `canLeave`。
- 只经清单编辑的人：编辑区可用，保存的请求体恰为 `{"expectedVersion":3,"title":"Renamed"}`；负责人、关注人名单可读而没有增删；「所属清单」区有移出、没有加入下拉（也没有「没有可加入的清单」与「加载中」提示）。
- 422 `INACTIVE_ORG_MEMBER`：增负责人 / 增关注人 ⇒ 各自表单旁一条 `role="alert"`，输入保留，不重拉、不通知红点、不出横幅；创建 ⇒ 创建表单旁按码显示，请求体里没有 `assignees`；创建的 allowlist 之外的 422 码仍显示通用失败；下一次失败没有码时回到通用文案。
- 成员对话框（`[fe-48]`）：写落地后，焦点已在对话框内就不动；在对话框外就回到发起写的控件（仍在、未禁用），否则回到标题；之后 Esc 照常关闭。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run <守卫 yml 的 23 个 whole-file 参数> --reporter=verbose`（`apps/web`，最终源码 `1e18fce28b`） | **23 文件 / 1858 用例全绿** |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 退出 0，0 行输出 |
| `type-check` 脚本的等价：`vue-tsc -b --force` + 两个 verification 项目 | `vue-tsc -b --force` 退出 2，只有一条：`vite.config.ts(28,29) TS2769`（`tsconfig.node.json` 那个项目，插件的 `this` 类型不兼容）；在合并基 `cc6ca96ac2` 的干净副本上用同一套本地 `node_modules` 跑出同一条，本分支没有改 `vite.config.ts`、lockfile 与 `package.json`——不是本分支引入的；同一个提交在 CI 上（按 lockfile 全新安装）的 `plugin-tests` 运行里，`test (20.x)` 的「Build web app」步骤（即 `vue-tsc -b && vite build`）是 success，所以这一条只出现在本地依赖环境里（本地 `node_modules` 装自另一条分支，lockfile 与本分支差几行；具体是哪个包的版本差异没有在本地查实）。`tsconfig.app.json`（全部源码）0 错误；`tsconfig.verification-approval.json`、`tsconfig.verification-stock-prep.json` 各退出 0。`-b` 写的增量构建信息文件：跑前备份、加 `--force` 防旧缓存给出假绿、跑后还原，逐字节一致 |
| `vite build`（产物不写进仓库） | 退出 0，17.6 秒，3843 个模块；`TaskListView`、`TasksSettingsView` 两条懒加载路由各自成块；只有既有的「块大于 500 kB」提示 |
| `bash apps/web/scripts/run-required-web-tests.sh`（照 CI：仓库根执行，`npx` 用本地二进制） | 退出 0，3 分 15 秒；19 次 vitest 调用全绿，合计 **633 文件 / 12342 用例**，0 个失败标记；最后一次（含全部任务 token）530 文件 / 10218 |
| `apps/web` 全量 `vitest run` | 906 文件：877 过、29 败；用例 15260：15228 过、32 败；12 条未处理错误。29 个失败文件在合并基 `cc6ca96ac2` 的干净副本上逐个重跑，**同样 29 个文件失败**（32 败 / 77 过，同样 12 条错误）——全部是既有失败：20 个 `verification/*.spec.ts`（Playwright 用例被 vitest 的缺省 include 收进来）与 9 个 `tests/` 文件（审批、考勤、`featureFlags`、`k3WiseSetup`、多维表导出，lane 脚本头注所列的隔离名单一类），没有任务文件。注：这次全量跑的时段里，依赖目录 `node_modules` 被别的进程改动过（`.bin` 与 `.pnpm` 的修改时刻落在跑的期间）；失败集合与基线重跑逐个相同 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，559 token（本片没有新 spec 文件） |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| D = T = G | 22；yml 23 个 whole-file 参数，`vitest run` 只出现 1 次 |
| 字面扫描器 v2（分支相对合并基改过的全部 40 个文件，另加 PR body） | 全部退出 0 |
| 本机路径 / 机器名 / 局域网地址扫描（`git diff cc6ca96ac2..HEAD` 的新增行与两份 MD） | 0 处；唯一的模式命中是 FE-2 spec 里的合成邮箱 `tasks-viewer@test.local`（夹具，不是机器名） |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、**`tasks-api-m4` 522**（512 + 10）、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、**`tasks-detail-m4` 158**（111 + 47）、`tasks-detail-view` 44、`tasks-groups` 163、**`tasks-labels` 87**（85 + 2）、`tasks-list-detail` 101、**`tasks-list-members` 115**（111 + 4）、`tasks-list-view` 32、`tasks-lists-sidebar` 67、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 30、`tasks-settings-view` 71、`tasks-view-transitions` 14、`tasks-view` 7。

### 6. 变异证据

脚本驱动（脚本不入库；执行器同 FE-3 … FE-7）：断言每个 `old` 文本恰出现一次 → 备份 → 改坏 → 跑点名的 spec → 还原 → 逐字节比对；不用 `git checkout --`。

- 第一轮（31 个，源码 `edecfdf504`）：29 红、2 存活——M21（失败路径不清码）与 M22（入口不清码）各自存活：两处复位互相遮蔽。按 §10.2 删去冗余的一处（`840fe43fd1`：入口复位，失败路径只在 `validation` 时记码），两个变异改定义后单跑都变红。
- 加 `[fe-48]` 之后（F1–F5），**最终一轮在最终源码 `1e18fce28b` 上整轮重跑：36 个变异全部变红（每一个都有断言失败的格），0 个等价变异；36 组文件还原全部逐字节一致；轮后 `git status` 干净**。下表即最终一轮（括号里是失败格数）。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| M1 | 负责人移除按钮改回看 `canEdit` | `TasksView.vue` | tasks-detail-m4 tasks-detail-m3 | 红（4） | 一致 |
| M2 | 添加负责人表单改回看 `canEdit` | `TasksView.vue` | 同上 | 红（4） | 一致 |
| M3 | 关注人移除按钮改回看 `canEdit` | `TasksView.vue` | 同上 | 红（4） | 一致 |
| M4 | 添加关注人表单改回看 `canEdit` | `TasksView.vue` | 同上 | 红（4） | 一致 |
| M5 | 能力不看 `canManageMembers`（恒取 `canEdit`） | `TasksView.vue` | 同上 | 红（11） | 一致 |
| M6 | `[fe-46]` 缺键恒显示 | `TasksView.vue` | 同上 | 红（7）：含 M3 既有格 1 | 一致 |
| M7 | `[fe-46]` 缺键恒隐藏 | `TasksView.vue` | 同上 | 红（59）：含 M3 既有格 30 | 一致 |
| M8 | 标志须与 `canEdit` 同时为真 | `TasksView.vue` | 同上 | 红（4） | 一致 |
| M9 | 缺键按「不是 false」读、不看 `canEdit` | `TasksView.vue` | 同上 | 红（7） | 一致 |
| M10 | 完成方式下拉改看成员管理能力 | `TasksView.vue` | 同上 | 红（3） | 一致 |
| M11 | 设父表单改看成员管理能力 | `TasksView.vue` | 同上 | 红（3） | 一致 |
| M12 | 「设为独立任务」改看成员管理能力 | `TasksView.vue` | 同上 | 红（3） | 一致 |
| M13 | 编辑区改看成员管理能力 | `TasksView.vue` | tasks-detail-m4 | 红（3） | 一致 |
| M14 | 「退出关注」改看成员管理能力 | `TasksView.vue` | tasks-detail-m4 tasks-detail-m3 | 红（9）：含 M3 既有格 8 | 一致 |
| M15 | 加入下拉交给 `canEdit` | `TasksView.vue` | tasks-detail-m4 | 红（2） | 一致 |
| M16 | 「所属清单」区内加入下拉读 `canEdit` | `TaskDetailLists.vue` | tasks-detail-m4 | 红（2） | 一致 |
| M17 | 移出改看加入能力 | `TaskDetailLists.vue` | tasks-detail-m4 | 红（2） | 一致 |
| M18 | 解析器丢掉 `canManageMembers` | `tasksApi.ts` | tasks-api-m4 tasks-detail-m4 | 红（17） | 一致 |
| M19 | 解析器接受非布尔的 `canManageMembers` | `tasksApi.ts` | tasks-api-m4 | 红（4） | 一致 |
| M20 | 创建表单不看码 | `TasksView.vue` | tasks-detail-m4 tasks-labels | 红（3） | 一致 |
| M21 | `validation` 的创建失败不记码 | `TasksView.vue` | 同上 | 红（3） | 一致 |
| M22 | 创建入口不清码 | `TasksView.vue` | 同上 | 红（1） | 一致 |
| M23 | `createTask` 的 allowlist 去掉 `INACTIVE_ORG_MEMBER` | `tasksApi.ts` | tasks-api-m4 tasks-detail-m4 | 红（3） | 一致 |
| M24 | 写失败分类器把 `INACTIVE_ORG_MEMBER` 归为 `error` | `tasksApi.ts` | tasks-api-m4 tasks-detail-m4 tasks-list-members | 红（8） | 一致 |
| M25 | 码表去掉 `INACTIVE_ORG_MEMBER` | `labels.ts` | tasks-detail-m4 tasks-labels tasks-list-members | 红（9） | 一致 |
| M26 | 中文文案改动 | `labels.ts` | tasks-detail-m4 tasks-list-members | 红（6） | 一致 |
| M27 | 英文文案写成中文 | `labels.ts` | tasks-labels | 红（5） | 一致 |
| M28 | 增负责人的码落到页面横幅 | `TasksView.vue` | tasks-detail-m4 tasks-detail-m3 tasks-labels | 红（6） | 一致 |
| M29 | 增关注人的码落到页面横幅 | `TasksView.vue` | 同上 | 红（5） | 一致 |
| F1 | 写落地后不收回焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（3） | 一致 |
| F2 | 焦点一律给标题、不回发起写的控件 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1） | 一致 |
| F3 | 焦点已在对话框内也被挪走 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1） | 一致 |
| F4 | 不记录发起写的控件 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1） | 一致 |
| F5 | 写之后已禁用的控件仍拿焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1） | 一致 |
| M30 | 清单页加入 404 的中文改回「你不能编辑它」 | `labels.ts` | tasks-list-detail | 红（1） | 一致 |
| M31 | 同上，英文 | `labels.ts` | tasks-labels | 红（1） | 一致 |

注释与标签的提交（`51b72b40d4`、`96e78abec4`）只改注释，没有单独的变异；它们之后的全部格与类型检查都重跑过。

### 7. 真机走查（PR-3a `f4a0eb532c` + 本分支前端）

环境：PR-3a 后端的一次性本地检出；一次性库（PostgreSQL 15.17，从空库迁移 426 条，排除项取 `tasks-realdb.yml` 的六项）；后端 `tsx src/index.ts`，`TASKS_ENABLED=true`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`（后端按缺省绑定全部网卡，走查结束即停）；本分支的 `vite` 开发服务器只绑本机回环，`VITE_API_URL` 指向后端；Playwright 驱动 Chromium。种子照 `scripts/ops/staging-tasks-smoke.mjs` 的形状：一个 org、四个用户（创建人、清单编辑者、加人目标、org 关系停用的用户）、一个带 `tasks:read` / `tasks:write` 的角色（名字不以 `_admin` 结尾）、三条 `tasks` 命名空间准入；令牌是带 `tenantId` 声明的 JWT，写进浏览器本地存储。截图 13 张与自动快照不入库。

| # | 走查 | 结果 |
|---|---|---|
| 1 | 创建人进 `/tasks` | 左栏「我的清单 / 还没有清单」、页头「设置」链接、五个视角、创建表单、空列表 |
| 2 | 创建表单建三条任务 | 「分配给我」视角挂个人分组板：合成默认组（`id` 为空，改名禁用并提示「首次排序或新建分组后可改名」），三行都在「未排序」尾段 |
| 3 | 尾段一行「加入排序」 | 首次个人写落行：播报「已移到第 1 位」，默认组改名可用；该行的「加入排序」消失，焦点落到它的「移到分组」下拉（`[fe-38]`） |
| 4 | 新建个人分组；下拉跨组移动；拖动句柄到另一行 | 播报「已移到「个人A」第 1 位」；Chromium 原生 HTML5 拖放生效，落在目标行之前；直读服务端：两条摆放、位置 0 / 1 |
| 5 | 左栏新建清单 | 跳到 `/task-lists/:id`，页头「我的角色：所有者」；按 id 加入三条任务；新建清单分组；拖到分组空白处 = 末尾；下拉移动；「上移」到顶后焦点落到「移到分组」下拉 |
| 6 | 成员对话框 | 打开即标题取焦点；加 org 关系停用的用户 ⇒ 真后端 422，添加表单旁「该用户不在当前组织或已停用」、输入框 `aria-invalid`；加清单编辑者（可编辑）与加人目标（只读）；把加人目标改为可编辑；两步确认后转让给加人目标 ⇒ 名单与页头随之变（本人「可编辑」、没有转让按钮）；Esc、关闭按钮关闭后焦点回到「成员」按钮 |
| 6a | **发现** | 任何一次写之后焦点都在页面 `body`（写进行中控件被禁用，Chromium 按焦点修正规则把焦点移走；转让还拿走了被点的按钮），于是 Esc 关不掉对话框、Tab 回绕不生效——jsdom 不做这一步，FE-6 的格看不到。修为 `[fe-48]`（`c924461946`，4 格、5 个变异）。复走：无变化的添加（200）后焦点回到输入框、Esc 关闭；422 后同；转让（确认按钮消失）后焦点在标题、Esc 关闭 |
| 7 | 设置页 | 缺省值；选「关闭」并勾每日汇总 ⇒ 时区自动填浏览器时区并提示；保存 ⇒「已保存」，PATCH 的 JSON 请求体被接受；顶栏红点立刻变为 `data-state="ready" data-scope="off" data-count="0"`、无数字、`aria-label`「待办任务红点已关闭」 |
| 8 | 详情页，创建人 | 四个成员控件都在；编辑区；「所属清单」区有「清单一 / 移出」与「没有可加入的清单」；加停用用户为负责人 ⇒ 负责人表单旁「该用户不在当前组织或已停用」；为关注人 ⇒ 关注人表单旁同一文案；加加人目标为关注人 ⇒ 成功、行内有移除 |
| 9 | 详情页，只经清单编辑的人 | 服务端给 `canEdit: true`、`canManageMembers: false`、`canLeave: false`；界面：负责人与关注人名单可读、没有增删控件、没有「退出关注」；完成方式下拉、编辑区、设父表单都在；「所属清单」区有移出、没有加入下拉；改标题保存 ⇒ PATCH 200、标题更新、无横幅。同一人直接发增负责人、加入清单 ⇒ 服务端 404，与隐藏的控件一致 |
| 10 | 清单页，清单编辑者 | 加入一条他没有直接角色的任务 ⇒ 404，表单旁新文案「任务不存在、你不是它的创建人或负责人，或清单不可用」；动态面板列出 9 条事件，词都在闭集里 |
| 11 | 控制台 | 只有预期的 422 / 404 资源错误 5 条，没有脚本错误或警告 |

另见：分组板的建组（回车提交）在写落地后焦点同样留在 `body`（真机核过）；清单页、左栏、设置页与详情页的写在进行中同样禁用发起写的控件，按同一机制会有同样的结果（没有逐个在真机核）。这些是非模态页面，不破坏任何契约，但键盘用户要从页首重新找位置；本片不改，列为 §12-Q35。

收尾：两个服务进程已停；一次性库删除前的行数为任务 3、清单 1、清单成员 3、分组 5、清单动态 11，随后删除；一次性检出已删除；自动生成的快照文件不入库。

### 8. 与设计的偏差 / 解释

1. **`[fe-45]` 是已裁规则的前端落点**（2026-10-07 裁定），`[fe-46]`（缺键回退）与 `[fe-47]`（加入下拉）是本片自选，各有 owner 问题（Q33、Q34），标签不混写。
2. **创建表单按码显示**：设计 §3.2 写「创建表单本期不发日期键，所以这些码在 UI 上只有通用文案」；裁定后 `INACTIVE_ORG_MEMBER` 也是创建的码，统一走 `codeMessage`，界面今天到不了这一格（表单不发 `assignees`）。M2 的 `error` / `invalid_title` 两种文案与既有格不变。
3. **清单页加入 404 的文案改写**：设计 §4.2 的原句早于 R12 的收窄；FE-5 的两格随之改期望值（`tasks-list-detail`、`tasks-labels` 各一格）。
4. **`[fe-48]` 不在设计里**：§5.2 只写了打开时取焦点、关闭时还焦点与 Tab 回绕；写进行中浏览器移走焦点这一步是真机才看到的。
5. **§12-Q12 的前提不成立**：#6159 在本分支开工前已合入 main（`cc6ca96ac2`），本分支以它为基，Draft PR 以 main 为基，`web-tests`、`plugin-tests` 会在 PR 上触发；设计 §10.4、§13、§14 的相关句标了更正，原文留作记录。
6. **验证记录沿用同一个文件**（§13 FE-8 写的是 `verification-<date>.md`）：FE-0 … FE-8 都在本文。

### 9. NOT RUN

- **PR-3c**（实时事件）未建：`tasks:counts-updated` 的真实推送、按用户房间、触点集合都没有可连的服务端；本次走查里红点的变化来自轮询与本地总线。
- 真机只跑了 Chromium：Firefox / Safari 的拖放、句柄起拖、上下半部判定没有试。
- 英文界面没有在真机里走（格覆盖了中英两种）。
- 两个标签页并发保存的 409、「分配给我」超过 100 条的停用排序（`[fe-35]`）、个人默认组改名之外的大清单渲染耗时：没有在真机里造数据。
- `[fe-46]` 的回退只有格覆盖：PR-3a 的后端总是发 `canManageMembers`，真机造不出缺键的响应。
- 创建表单的 `INACTIVE_ORG_MEMBER`：界面不发 `assignees`，只有格覆盖（真后端对带停用负责人的创建答 422 由 PR-3a S9 的真库格证明）。
- 页面级写之后的焦点（§12-Q35）：未改。
- CI：未推送、未开 Draft PR，任何 workflow 都没在 CI 上跑；staging / 生产未触达。

---

## 闸审之后的修复（独立闸审，2026-10-08）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起点 | 闸审所审的 FE-8 定稿（23 个 whole-file 参数 / 1858 格全绿）；起手重跑同样 1858 全绿 |
| 处置范围 | 闸审确认的 8 条 P2（第 3 节 (1)–(8)）、1 条未确认项（第 3 节 (9)）、18 条 P3 / NIT（第 3 节 (10)） |
| 详情体的判别键 | 逐键对照 main（`cc6ca96ac2` 的 `getTask`）与 PR-3a 分支的 `getTask`：`version` 在 main 上 M3 的详情体里就有；`description` / `startDate` / `startTime` / `remindAt` 四键与 `PATCH /api/tasks/:id` 出自 PR-3a 的同一片（S4）；`listIds`、`canManageMembers` 更晚。只有 S4 四键组能说明后端有这条 PATCH 路由 |
| PR-3a 对照 | 本节进行中该分支前进到 `e73aaf6de6`；逐提交核对，路由、请求 / 响应形状与码均不变，前端契约不变 |

### 2. 提交（按内容）

| 提交 | 对应 |
|---|---|
| 编辑区以 S4 四键组与 `version` 判别后端（代码与格） | 第 (1) 项 |
| `[fe-19]` 两半的格（纯函数与挂载） | 第 (2)(3) 项 |
| 晚到守卫与路由边沿复位的格 | 第 (4)–(7) 项，另含 P3 的动态下一页与环境读两格 |
| 成员对话框两步确认的焦点（`[fe-49]`；新增 `tasks/tasksFocus.ts`） | 第 (8) 项 |
| 页面上两步确认、改名表单与放弃草稿的焦点（`[fe-50]`） | P3 |
| 英文深度标签 | NIT |
| 其余 P3 的格与设置页成功那格 | P3 |
| `canManageMembers` 的注释（只动注释） | 第 (9) 项 |
| 设计与本文 | 第 (1) (8) (9) 项与 P3 的设计、记录 |
| 守卫 yml 的头注（只动注释） | — |
| 本节与全线汇总 | — |

### 3. 逐项结果

**(1) 编辑区把 main 上 M3 的详情体当成 PR-3a 的（P2，契约）**
- 问题：编辑区原先只看 `version`。main 上 M3 的详情体也带 `version`，于是在没有 `PATCH /api/tasks/:id` 的后端上编辑区照样出现，保存只能得到 404 与通用横幅；FE-4 那格「旧响应不显示编辑区」用的夹具删掉了 `version`，main 上没有任何后端回这种形状，所以那格测不出来。
- 修：编辑区条件改为 `canEdit` + S4 四键组 + `version`（`editorAvailable`，模板与 `onPatchTask` 同用一处）；`tasksApi.ts` 里 `version` 的注释改正。
- 格：那格的夹具换成 main 上 M3 `getTask` 逐键的形状（带 `version`、`followers`、`canLeave`，不带 S4 四键、`listIds`、`canManageMembers`），断言没有编辑区、没有只读行与「所属清单」区、没有 PATCH，M3 的成员控件与完成方式下拉照常。M3 在 main 上的行为不变。
- 变异：G1（退回只看 `version`）只被这一格杀死；G2、G3 分别由既有的「缺 `version`」「不能编辑」两格杀死。

**(2)(3) `[fe-19]` 两半没有钉住，含提醒那一半（P2 × 2）**
- 纯函数格（`tasks-api-m4`）：整条规则一格；提醒「碰过但没改」取重拉值且算没碰过、下一次 patch 不带 `remindAt`；「碰过且改了」保留 viewer 的值；「没碰过但不同」取重拉值。
- 挂载格（`tasks-detail-m4`）：409 时提醒碰过但没改 ⇒ 输入框显示重拉值，第二个请求体恰为 `{"expectedVersion":4,"title":"Mine"}`；那次重拉之后改截止日期仍显示「提醒时刻不会自动跟随截止日期」；409 之后再来一次重拉（完成按钮）⇒ 以 409 的重拉为 base，标题取第二次重拉的值，第二个请求体只带 viewer 的描述与 `expectedVersion: 5`；409 之外连着两次重拉同理。
- 变异：G4（闸审的 Mf / A1）、G5（A5）、G6（Mi）、G7、G8、G9、G56（整份保留，闸审的 Mb）全部变红；G9 是闸审没有列的同类（409 之外的重拉不前移 base），起初存活，补了「连着两次重拉」一格后变红。
- FE-4 节第 6 段的覆盖说法与第 7 段第 1 条已加更正。

**(4) 「分配给我」的安静重读没有 generation 格（P2）**：刷新的行读挂起时切到「关注中」，晚到的行读不改写新视角的行。G10 只被这一格杀死。

**(5) 清单页移出任务的晚到守卫没有格（P2）**：路由换到另一清单后晚到的 404 不出横幅；离开到任务页后晚到的 `ok` 不发任何请求（不会把任务 id 当清单 id 读）；原有那格改为断言晚到之后一个请求都没有。G11 三格齐红。

**(6) 分组板改组名 / 删组的晚到守卫没有格（P2）**：清单 scope 下离开到任务页后晚到的改名 / 删组 `ok` 不发请求；个人 scope 下切换视角后同样。G12、G13 各被两格杀死。

**(7) 路由边沿复位那格的横幅断言不可能失败（P2）**：同一格里后面的「加入任务」会先清掉横幅。改为把归档 500 放在边沿之前最后一步，并断言横幅此时在；另让 t1 同时在两个清单里，使留着的移出确认在新清单上也会显示。G14（不清横幅）、G15（不清移出确认，原先存活）都由这一格杀死。

**(8) 成员对话框打开或取消转让 / 退出确认时焦点落到对话框之外（P2，UX）**
- 问题：确认块替换了被操作的按钮，取消又换回来；被操作的控件消失，焦点落到页面 `body`，在模态对话框之外，Esc 与 Tab 回绕都收不到，提示句也没有播报。
- 修（`[fe-49]`）：打开 ⇒ 焦点到确认按钮；确认按钮 `aria-describedby` 指向提示句，提示句带 `role="status"`（对话框里状态类消息的既有写法）；取消 ⇒ 焦点回到换回来的按钮（转让按行定位）。焦点的移动由新模块 `tasks/tasksFocus.ts` 的 `focusAfterSwap` 在 DOM 更新之后做。
- 格（`tasks-list-members` 4 格）：先把焦点放在要按的控件上再按（键盘用户的回车），断言焦点落到的那一个控件，再从那里发 Esc，对话框关闭、焦点回到「成员」按钮。转让一格用第三行，使「取根下第一个」的错误答案落到别的行。jsdom 在被聚焦的元素移出 DOM 时同样把焦点交给 `body`，所以不修时这几格的失败形态与浏览器一致。
- 变异：G18–G25（四个焦点移动、两个 `role`、两个 `aria-describedby`）与 G26（不按行定位）、G43（不等 DOM 更新）全部变红。

**(9) 未确认项：`canManageMembers` 缺键回退的说明**：`TasksView.vue` 的 `[fe-46]` 注释用 main 上 M3 的现行规则说明回退——main 上 `edit` 来自任务的创建人与负责人，它也是那四条写的判据；该键的出处写作「PR-3a」。设计 §4.3、§11 `[fe-46]` 与本文 FE-8 节第 3 段 (1) 同一说法。

**(10) P3 / NIT（18 条）**

| 条目 | 处置 | 格 / 变异 |
|---|---|---|
| 409 之后自动填入的浏览器时区算作 viewer 的改动（`tasksDraft.ts`） | 记录，未改：要改 `[fe-19]`（已 ratify）的规则或给草稿加新状态，交 owner | — |
| 重拉之后的草稿过不了日期预检，而请求体本身合法（`TasksView.vue`） | 记录，未改：同属 `[fe-19]` 的规则；不丢数据，手动清掉时间即可保存 | — |
| 动态「加载更多」的 generation | 补格 | G16 |
| 清单页环境读之后的 `left` 检查 | 补格 | G17 |
| 设置页撤下旧结果的三条规则；成功那格的提示断言是空的 | 补格三条；成功那格去掉被输入时区先撤下的那条断言，另起一格「自动填入后直接保存」 | G52、G53、G54 |
| 取消勾选每日提醒时不回填被清空的时区 | 补格 | G51 |
| 「分配给我」安静重读的 `org_missing` | 补格 | G46 |
| 左栏下一页的 `org_missing` | 补格 | G49 |
| 左栏重读撤下「加载更多失败」 | 补格 | G50 |
| 重拉之后按重拉值重算脏标记 | 补格 | G44 |
| 「提醒不跟随」的截止时间那一半 | 补格 | G45 |
| 分组板下一次写撤下删组错误 | 补格 | G47 |
| `planJoinOrder` 那条断言没有判别力（NIT） | 补一条用别组已摆放行的断言 | G48 |
| 页面上非写的就地切换把焦点丢到 `body` | 修（`[fe-50]`）：清单页移出确认与改名、分组板删组确认与改组名、「所属清单」区移出确认、编辑区放弃草稿；改名表单的 Esc 取消没有加（新键位行为，归 §12-Q35） | G27–G36、G38–G43 |
| 只经清单可见的人把任务移出最后一个清单后落到「未找到该任务」 | 记录，未改：确认文案的警示或移出之后的专门说明都是流程与文案的取舍，需要设计 / owner 定 | — |
| 英文深度标签 `Depth:0` 没有空格（NIT） | 修为 `Depth: ` | G55 |
| 文档措辞（2 条） | 已处理 | — |

### 4. 行为规则（本节新增的格按这些出）

- 编辑区：`canEdit` 不为假、详情带 S4 四键组、详情带 `version`，三者都满足才渲染；main 上 M3 的详情体只满足第一、三条，不渲染。
- `[fe-19]`：改过的字段保留 viewer 的值，其余取重拉值；提醒只在碰过且不同时算改过，算没改时 `remindTouched` 归零；每次重拉之后 base 前移到这次重拉（409 的与其他的都是）；下一次保存的 `expectedVersion` 是最近一次重拉的 `version`。
- `[fe-49]`：转让 / 退出确认打开 ⇒ 焦点到确认按钮（由 `role="status"` 的提示句描述）；取消 ⇒ 焦点到换回来的按钮；之后 Esc 关闭对话框。
- `[fe-50]`：页面上的移出 / 删组确认打开 ⇒ 焦点到确认按钮（由提示句描述）；改名表单打开 ⇒ 焦点到输入框；取消 ⇒ 焦点到换回来的按钮；放弃草稿 ⇒ 焦点到编辑区标题。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json`（`apps/web`） | 退出 0，0 行输出 |
| `./node_modules/.bin/vitest run <守卫 yml 的 23 个 whole-file 参数> --reporter=verbose` | **23 文件 / 1901 用例全绿**（FE-8 定稿 1858 + 本节 43） |
| `bash apps/web/scripts/run-required-web-tests.sh`（照 CI：仓库根执行，`npx` 用本地二进制） | 退出 0，3 分 28 秒；19 次 vitest 调用全绿，合计 **633 文件 / 12385 用例**，0 个失败标记；最后一次（含全部任务 token）530 文件 / 10261 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，559 token（本节没有新 spec 文件） |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| D = T = G | 22；yml 23 个 whole-file 参数，`vitest run` 只出现 1 次 |
| `vite build`（产物不写进仓库） | 退出 0，20.5 秒，3844 个模块（多出的一个是 `tasks/tasksFocus.ts`）；`TaskListView`、`TasksSettingsView` 两条懒加载路由仍各自成块；只有既有的「块大于 500 kB」提示 |
| 字面扫描器 v1 与 v2（分支相对合并基改过的全部 41 个文件，另加 PR body） | 全部退出 0 |
| 本地痕迹扫描（`git diff cc6ca96ac2..HEAD` 的新增行、两份 MD 与 PR body；模式含用户目录、用户名、机器名、`.local`、三段私网地址、部署机地址，另加本地目录与检出类的中英文字样） | 0 处；唯一的模式命中仍是 FE-2 spec 里的合成邮箱 `tasks-viewer@test.local`（夹具） |
| `vue-tsc -b`、`apps/web` 全量 vitest | 本节没有重跑：本节没有改 `vite.config.ts`、依赖与任务以外的文件，结果见 FE-8 节第 5 段 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、**`tasks-api-m4` 526**（522 + 4）、`tasks-api` 66、`tasks-badge-m4` 55、`tasks-badge` 25、`tasks-context` 17、`tasks-detail-m3` 104、**`tasks-detail-m4` 167**（158 + 9）、`tasks-detail-view` 44、**`tasks-groups` 174**（163 + 11）、**`tasks-labels` 88**（87 + 1）、**`tasks-list-detail` 109**（101 + 8）、**`tasks-list-members` 119**（115 + 4）、`tasks-list-view` 32、**`tasks-lists-sidebar` 69**（67 + 2）、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 30、**`tasks-settings-view` 75**（71 + 4）、`tasks-view-transitions` 14、`tasks-view` 7。

### 6. 变异证据

脚本驱动（脚本不入库；执行器同 FE-3 … FE-8，改为用 JSON 报告逐格列出失败的格）：断言每个 `old` 文本恰出现一次 → 备份 → 改坏 → 跑点名的 spec → 还原 → 与轮前快照逐字节比对；不用 `git checkout --`。每个变异都写明必须出现在失败格里的那一格（「本节新加的格就是杀死它的格」），结果列给出前三个失败格。

在最终源码上整轮跑：**56 个变异全部变红（本节的 55 个，加 1 个对照：FE-4 M73 的复现，证明英文扫描格仍然渲染编辑区），每一个的失败格里都有为它点名的那一格；0 个等价变异；56 组文件还原全部逐字节一致；轮后源码与 spec 的 `git status` 干净**（编号 G37 未用；G56 是复核时为「整条规则」那一纯函数格补的点名变异，在同一份最终源码上单跑，结果并入下表）。逐步提交时各跑过该步的变异，结果相同；其中 G9（409 之外的重拉不前移 base）与 G15（路由边沿不清移出确认）第一次存活，补格 / 改格之后变红（第 3 节 (2)(3)、(7)）。

| # | 变异 | 文件 | 跑的 spec | 结果（失败格） | 还原 |
|---|---|---|---|---|---|
| G1 | 编辑区条件退回只看 `version`（main 上 M3 的详情体会渲染编辑区） | `TasksView.vue` | tasks-detail-m4 tasks-detail-m3 | 红（1）：tasks-detail-m4「main's M3 body (version present, no S4 keys): no editor, no read-only rows, no l…」 | 一致 |
| G2 | 编辑区条件去掉 `version` | `TasksView.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「does not render without a version, and the read-only rows still show the S4 fiel…」 | 一致 |
| G3 | 编辑区条件去掉 `canEdit` | `TasksView.vue` | tasks-detail-m4 | 红（2）：tasks-detail-m4「does not render when the abilities say the viewer cannot edit」；tasks-detail-m4「tasks-detail-editor stays hidden for canEdit: false with canManageMembers: true」 | 一致 |
| G4 | `[fe-19]`：碰过的提醒一律算改过（不比较值） | `tasksDraft.ts` | tasks-api-m4 tasks-detail-m4 | 红（3）：tasks-api-m4「a reminder touched and left at its value takes the reloaded value, counts as unt…」；tasks-detail-m4「[fe-19] a reminder touched and left at its value takes the reloaded one; the nex…」；tasks-detail-m4「[fe-19] after that reload the reminder counts as untouched again: a due-date cha…」 | 一致 |
| G5 | `[fe-19]`：`remindTouched` 原样带过重拉 | `tasksDraft.ts` | tasks-api-m4 tasks-detail-m4 | 红（2）：tasks-api-m4「a reminder touched and left at its value takes the reloaded value, counts as unt…」；tasks-detail-m4「[fe-19] after that reload the reminder counts as untouched again: a due-date cha…」 | 一致 |
| G6 | `[fe-19]`：409 的重拉不前移 base | `TasksView.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-19] across two reloads: a reload after the 409 rebases on the 409 reload, so…」 | 一致 |
| G7 | `[fe-19]`：提醒一律取重拉值（viewer 的改动丢失） | `tasksDraft.ts` | tasks-api-m4 tasks-detail-m4 | 红（1）：tasks-api-m4「a reminder touched and changed keeps the viewer's value and stays touched」 | 一致 |
| G8 | `[fe-19]`：没碰过但不同的提醒算改过 | `tasksDraft.ts` | tasks-api-m4 tasks-detail-m4 | 红（1）：tasks-api-m4「a reminder that differs without being touched takes the reloaded value」 | 一致 |
| G9 | `[fe-19]`：409 之外的重拉不前移 base | `TasksView.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-19] across two such reloads the second rebases on the first, so the first re…」 | 一致 |
| G10 | `reloadListQuietly` 去掉 generation 检查 | `TasksView.vue` | tasks-groups | 红（1）：tasks-groups「a refresh whose row read lands after the view changed does not paint the assigne…」 | 一致 |
| G11 | 清单页移出任务去掉写 token 检查 | `TaskListView.vue` | tasks-list-detail | 红（3）：tasks-list-detail「a remove answered after the route moved on reads nothing — not the old list's it…」；tasks-list-detail「a remove answered with a 404 after the route moved on paints no banner」；tasks-list-detail「a remove answered after the page was left for a task: no request at all, none un…」 | 一致 |
| G12 | 分组板改组名去掉写 token 检查 | `TaskGroupBoard.vue` | tasks-groups | 红（2）：tasks-groups「a rename answered after the view changed reads nothing」；tasks-groups「a group rename answered after leaving to a task page reads nothing at all — not …」 | 一致 |
| G13 | 分组板删组去掉写 token 检查 | `TaskGroupBoard.vue` | tasks-groups | 红（2）：tasks-groups「a delete answered after the view changed reads nothing」；tasks-groups「a group delete answered after leaving to a task page reads nothing at all — not …」 | 一致 |
| G14 | 清单页路由边沿不清横幅 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「a route edge resets drafts, errors, the confirmation, the banner and the activit…」 | 一致 |
| G15 | 清单页路由边沿不清移出确认 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「a route edge resets drafts, errors, the confirmation, the banner and the activit…」 | 一致 |
| G16 | 动态的下一页去掉 generation 检查 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「a next page of the old list that lands after the route moved on stays out of the…」 | 一致 |
| G17 | 清单页挂载后的环境读不看 `left` | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「a context read that lands after the page was left sends no list request」 | 一致 |
| G18 | 对话框：打开转让确认不移焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening a row's transfer confirmation focuses its confirm button, which the prom…」 | 一致 |
| G19 | 对话框：取消转让确认不移焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「cancelling it focuses that row's transfer button again; Escape from there closes…」 | 一致 |
| G20 | 对话框：打开退出确认不移焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening the leave confirmation focuses its confirm button, which the prompt desc…」 | 一致 |
| G21 | 对话框：取消退出确认不移焦点 | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「cancelling it focuses the leave button again; Escape from there closes the dialo…」 | 一致 |
| G22 | 对话框：转让提示句去掉 `role="status"` | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening a row's transfer confirmation focuses its confirm button, which the prom…」 | 一致 |
| G23 | 对话框：转让确认按钮去掉 `aria-describedby` | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening a row's transfer confirmation focuses its confirm button, which the prom…」 | 一致 |
| G24 | 对话框：退出提示句去掉 `role="status"` | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening the leave confirmation focuses its confirm button, which the prompt desc…」 | 一致 |
| G25 | 对话框：退出确认按钮去掉 `aria-describedby` | `TaskListMembersDialog.vue` | tasks-list-members | 红（1）：tasks-list-members「opening the leave confirmation focuses its confirm button, which the prompt desc…」 | 一致 |
| G26 | `focusAfterSwap` 不按行定位（取根下第一个） | `tasksFocus.ts` | tasks-list-members | 红（1）：tasks-list-members「cancelling it focuses that row's transfer button again; Escape from there closes…」 | 一致 |
| G27 | 清单页：打开移出确认不移焦点 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「opening a task's remove confirmation focuses its confirm button, which the promp…」 | 一致 |
| G28 | 清单页：取消移出确认不移焦点 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「cancelling it focuses that task's remove button again」 | 一致 |
| G29 | 清单页：移出确认按钮去掉 `aria-describedby` | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「opening a task's remove confirmation focuses its confirm button, which the promp…」 | 一致 |
| G30 | 清单页：打开改名不聚焦输入框 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「opening rename focuses the name input」 | 一致 |
| G31 | 清单页：取消改名不移焦点 | `TaskListView.vue` | tasks-list-detail | 红（1）：tasks-list-detail「cancelling rename focuses the rename button again」 | 一致 |
| G32 | 分组板：打开删组确认不移焦点 | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「opening a group's delete confirmation focuses its confirm button, which the prom…」 | 一致 |
| G33 | 分组板：取消删组确认不移焦点 | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「cancelling it focuses that group's delete button again」 | 一致 |
| G34 | 分组板：删组确认按钮去掉 `aria-describedby` | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「opening a group's delete confirmation focuses its confirm button, which the prom…」 | 一致 |
| G35 | 分组板：打开改组名不聚焦输入框 | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「opening a group's rename focuses the name input」 | 一致 |
| G36 | 分组板：取消改组名不移焦点 | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「cancelling a group's rename focuses that group's rename button again」 | 一致 |
| G38 | 「所属清单」区：打开移出确认不移焦点 | `TaskDetailLists.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-50] opening a row's remove confirmation focuses its confirm button, which th…」 | 一致 |
| G39 | 「所属清单」区：取消移出确认不移焦点 | `TaskDetailLists.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-50] cancelling it focuses that row's remove button again」 | 一致 |
| G40 | 「所属清单」区：移出确认按钮去掉 `aria-describedby` | `TaskDetailLists.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-50] opening a row's remove confirmation focuses its confirm button, which th…」 | 一致 |
| G41 | 编辑区：放弃之后不移焦点 | `TaskDetailEditor.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-50] "discard my changes" takes its own button away, so focus moves to the ed…」 | 一致 |
| G42 | 编辑区：标题去掉 `tabindex` | `TaskDetailEditor.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「[fe-50] "discard my changes" takes its own button away, so focus moves to the ed…」 | 一致 |
| G43 | `focusAfterSwap` 不等 DOM 更新 | `tasksFocus.ts` | tasks-list-members tasks-list-detail tasks-groups tasks-detail-m4 | 红（14）：tasks-detail-m4「[fe-50] opening a row's remove confirmation focuses its confirm button, which th…」；tasks-detail-m4「[fe-50] cancelling it focuses that row's remove button again」；tasks-groups「opening a group's delete confirmation focuses its confirm button, which the prom…」；… | 一致 |
| G44 | 重拉之后草稿恒为脏（不对重拉值重算） | `TasksView.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「a reload that brings the server to the draft leaves nothing unsaved: no notice, …」 | 一致 |
| G45 | 只改截止时间时不显示「提醒不跟随」 | `TaskDetailEditor.vue` | tasks-detail-m4 | 红（1）：tasks-detail-m4「a change of the due time alone shows that note too」 | 一致 |
| G46 | `reloadListQuietly` 的 `org_missing` 落成列表错误态 | `TasksView.vue` | tasks-groups | 红（1）：tasks-groups「shows the org guidance block」 | 一致 |
| G47 | 分组板下一次写不清删组错误 | `TaskGroupBoard.vue` | tasks-groups | 红（1）：tasks-groups「the next board write clears a delete error」 | 一致 |
| G48 | `planJoinOrder`：别组的已摆放行可加入默认组排序 | `tasksGroupBoard.ts` | tasks-groups | 红（1）：tasks-groups「a tail row joins the default group's order at its end; a placed row does not joi…」 | 一致 |
| G49 | 左栏下一页的 `org_missing` 落成加载失败 | `TaskListsSidebar.vue` | tasks-lists-sidebar | 红（1）：tasks-lists-sidebar「a next page that reports no org switches the page to the org guidance block, not…」 | 一致 |
| G50 | 左栏从第一页重读不清「加载更多失败」 | `TaskListsSidebar.vue` | tasks-lists-sidebar | 红（1）：tasks-lists-sidebar「a re-read from the first page after a failed next page drops the load-more failu…」 | 一致 |
| G51 | 设置页：取消勾选每日提醒时回填被清空的时区 | `TasksSettingsView.vue` | tasks-settings-view | 红（1）：tasks-settings-view「unticking the daily reminder after clearing the filled-in zone leaves the zone e…」 | 一致 |
| G52 | 设置页：保存成功不撤下自动填入提示 | `TasksSettingsView.vue` | tasks-settings-view | 红（1）：tasks-settings-view「a save right after the zone was filled in retires the filled-in notice」 | 一致 |
| G53 | 设置页：再次保存不清上一次的结果 | `TasksSettingsView.vue` | tasks-settings-view | 红（1）：tasks-settings-view「a second save attempt retires the first attempt's banner」 | 一致 |
| G54 | 设置页：改时区不清上一次的结果 | `TasksSettingsView.vue` | tasks-settings-view | 红（1）：tasks-settings-view「editing the zone retires its inline error」 | 一致 |
| G55 | 英文深度标签去掉空格 | `labels.ts` | tasks-labels | 红（1）：tasks-labels「the depth row: a space after the label, as after every other label」 | 一致 |
| G56 | `[fe-19]`：整份草稿保留（viewer 没改的字段也不取重拉值） | `tasksDraft.ts` | tasks-api-m4 tasks-detail-m4 | 红（5）：tasks-api-m4「a field the viewer changed keeps the viewer's value; every other field takes the…」；tasks-detail-m4「keeps the fields the viewer changed and takes the reloaded values for the others…」；tasks-detail-m4「[fe-19] across two reloads: a reload after the 409 rebases on the 409 reload, so…」；… | 一致 |
| C1 | 对照：英文编辑区标题写成中文（FE-4 M73 的复现） | `labels.ts` | tasks-labels | 红（8）：tasks-labels「no EN string contains CJK」；tasks-labels「no key has identical ZH and EN copy」；tasks-labels「the editor, the read-only rows, the lists with a not-a-member id, the picker, th…」；… | 一致 |

### 7. 记录、未改（各一行理由）

- 409 之后自动填入的浏览器时区算作 viewer 的改动：要改 `[fe-19]`（已 ratify）的规则或给草稿加「自动填入」的状态，交 owner。
- 重拉之后的草稿过不了日期预检（请求体本身合法）：同属 `[fe-19]` 的规则；不丢数据，手动清掉时间即可保存。
- 只经清单可见的人移出最后一个清单后落到「未找到该任务」：确认里加警示还是移出之后给专门说明，是流程与文案的取舍，需要设计 / owner 定。
- 改名表单不加 Esc 取消：新键位行为，没有设计依据，归 §12-Q35。
- 写之后的页面级焦点（§12-Q35）：仍未改。

### 8. NOT RUN

- 本节的焦点修复只在 jsdom 的格里验证；Chromium 里的复走（闸审发现它的那条路径）没有做，Firefox / Safari 与读屏软件也没有。
- 真机联调没有重跑：本节没有改请求与响应。
- CI：未推送、未开 Draft PR；staging / 生产未触达。

---

## FE-c 实时订阅按 PR-3c 重核（设计 §8.2、§8.3、§13 FE-c；`[R16]` `[fe-08]`；本片新取舍 `[fe-51]`–`[fe-54]`）

### 1. 基线与契约

| 项 | 结果 |
|---|---|
| 起手 head | `f82f24b8ab`（Draft #6265 的单提交，远端 head 同此；工作树干净）；起手重跑 23 个 whole-file 参数：**23 文件 / 1901 全绿** |
| PR-3c 读的提交 | 本地分支 `claude/tasks-m4-pr3c`：起手时是 `e432881344`；本片进行中它被重建为单提交 `3edd133ae0`（叠在 PR-3a 的单提交 `68e40323bd` 上）并推到远端。`git diff --stat e432881344 3edd133ae0` 只有 PR-3c 自己的验证 MD，代码与设计不变；设计 §8.3 的行号按 `3edd133ae0` |
| 读的契约 | PR-3c 设计 `task-m4-pr3c-backend-design-20261008.md` 全文（§12 是给前端的九条）；`packages/core-backend/src/services/task-counts-realtime.ts`；`services/CollabService.ts`（PR-3c 相对合并基 `cc6ca96ac2` 不改它，也不改 `apps/web`）；R01 锁 Draft（`69a7c08f8f`）门 26 正文里的前端句与负控丁 |
| 后端状态 | PR-3c 只作 Draft，不合并、不部署；本片没有对它的 socket 做真机联调（§8） |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `ce34986c1c` | 实现：`useTasksBadge.ts` 的信号窗口（`[fe-51]`–`[fe-53]`）；`useTasksCountsRealtime.ts` 与 `TasksSettingsView.vue` 只改注释（`[fe-54]`）；`tasks-badge-m4.spec.ts` 改写 13 格。改写放在同一个提交里，每个提交都是绿的 |
| `ceaffcd2ee` | 新 `tests/tasks-counts-realtime.spec.ts`（31 格）与三处登记 |
| `b6ea823b77` | 变异轮第一轮发现的一格：socket 在线而首次读失败时，轮询照样恢复（§6 的 X12） |
| `bbb7a1856c` | 设计 §8.2、§8.3 与相关各节 |
| 本文所在提交 | 本节、全线汇总、抬头 |

### 3. §8.3 逐条结论（11 条：9 条一致，2 条调整）

| # | 重核点 | 结论 | 前端改动 | 钉住它的格（`tasks-counts-realtime` 的组；另注明 FE-2 的格） |
|---|---|---|---|---|
| 1 | 事件名与按用户房间 | 一致 | 无 | D：`apps/web/src` 只有一处事件名写法（扫描器自带正控）；只听这一个事件、从不 `emit` |
| 2 | 载荷无字段 | 一致 | 无 | C：任何访问都记录并抛出的载荷零访问；六种载荷各一次信号、不影响计数 |
| 3 | 触点集合与总线条件 | 一致 | 无 | 服务端的格在 PR-3c；前端的总线条件由 FE-4 的格钉着 |
| 4 | socket 认证与路径 | 一致 | 无 | D：连接参数恰为三键、不带 query；G：再次登录用新令牌 |
| 5 | 提交之后才发；前端证明什么 | 调整（服务端一致，前端格的表述变） | 一个窗口一次 `/pending-count` 请求（`[fe-51]`） | A：`gate26|` 两格 |
| 6 | 操作者本人也收到，且先于 HTTP 响应 | 调整 | `[fe-52]` | B：信号先到、nudge 后到为一次读；60 s tick 在窗口内回答它；反序两次 |
| 7 | 设置变更不发 | 一致（设置页 FE-3 起就在保存成功后通知） | 无（`[fe-54]` 只记取舍） | F：没有 socket 时四格 |
| 8 | 多 org | 一致 | 无 | — |
| 9 | 进程范围 | 一致；轮询的理由改写 | 无（`[fe-08]` 的理由） | E：两格 |
| 10 | 退出登录时拆除 | 一致 | 无 | G：`/login` 断开、再次登录新 socket、退出时开着的窗口不读 |
| 11 | feature 关闭时没有订阅 | 一致 | 无 | G：会话中途关闭；挂载时的门格在 FE-2 |

任务给的九项要求对应如下：事件名单点常量（第 1 条，普查格）；不读载荷（第 2 条）；一个窗口一次读，含 N 条信号一次读、在途读时的信号（第 5、6 条，B 组）；重拉带查看者时区头（A 组，`fetchPendingCount` 是真的，`apiFetch` 被 mock）；设置页保存后自己重拉（第 7 条，F 组）；轮询保留（第 9 条，E 组）；不发 join（第 1 条，D 组）；退出登录与卸载时拆除（第 10 条，B 组末格与 G 组）；feature 关闭时没有订阅（第 11 条）。

### 4. 行为规则（spec 按这些出格）

- 信号不立即重拉：第一条信号打开 500 ms 的窗口，窗口里的信号都被吸收，窗口结束时恰一次读；窗口从第一条信号起算、不顺延。
- 窗口开着时开始的读（60 s tick、总线 nudge）回答窗口吸收的信号并关闭窗口；窗口打开时已在途的读不回答，窗口照常读，旧读晚到的结果被 generation 丢弃。
- 窗口的读不跳过隐藏页；卸载关闭窗口；总线 nudge 与 60 s tick 仍立即读。
- 重拉的请求恰为 `('/api/tasks/pending-count', { headers: { 'x-viewer-time-zone': 重拉那一刻浏览器报的时区 }, suppressUnauthorizedRedirect: true })`。
- 载荷不读：任何值都是一次信号。
- 客户端只注册这一个事件的处理函数、从不 `emit`；`io()` 的参数恰为 `{ path: '/socket.io', transports: ['websocket', 'polling'], auth: { token } }`。
- socket 一直在线、没有信号时，下一个 60 s tick 显示变化；首次读失败时 60 s tick 照样重试并恢复。
- 设置保存成功 ⇒ 总线 nudge ⇒ 红点重读一次（没有 socket 时也如此，改不改 `badgeScope` 都如此）；422 不重读。
- 真实壳层：路由到 `/login` ⇒ 红点卸载 ⇒ `disconnect()` 一次，旧 socket 上晚到的事件不引起读；再次登录回到普通路由 ⇒ 新 socket、新令牌，只有新 socket 的事件引起读；会话中途关掉 feature ⇒ 下一次路由变化时入口与红点卸载、断开。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run <守卫 yml 的 24 个 whole-file 参数> --reporter=verbose`（`apps/web`，源码与 spec 为 `b6ea823b77`） | **24 文件 / 1933 用例全绿**（1901 + 新文件 32） |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 退出 0 |
| 两个动过的 spec 的类型检查（临时 tsconfig = app 配置 + 这两个文件，不入库） | `tasks-counts-realtime.spec.ts` 0 错误；`tasks-badge-m4.spec.ts` 只有 FE-2 既有的三条（D 组 `router-link` 桩里的 `this.$props` / `this.$slots`，本片没碰那几行；仓库的 tsconfig 本来不检查 spec） |
| `bash apps/web/scripts/run-required-web-tests.sh`（照 CI：仓库根执行，Node 20，`npx` 用本地二进制） | 退出 0，266 秒；19 次 vitest 调用全绿，合计 **634 文件 / 12417 用例**，0 个失败标记；最后一次（含全部任务 token）531 文件 / 10293 |
| `node scripts/ops/required-web-lane-token-manifest.mjs --write`，再检查模式 | 写出 560 个 token；检查模式 `MANIFEST MATCHES` |
| `vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts`（`packages/core-backend`） | 29 / 29 |
| D = T = G | 23；yml 24 个 whole-file 参数（`Twenty-four`），`vitest run` 只出现 1 次，头注里 `tests/tasks…spec.ts` 形式 0 处 |
| 锁 §5.3 两条碰撞检查（`tasks-counts-realtime.spec.ts`） | 文件数 = 1；`verification/` 下 = 0；与 `.tokens` 其余 559 个 token 双向子串碰撞 0 |
| 三个字面扫描器（v1、v2 与引号扫描器；本片改过的 10 个文件） | 三个都退出 0。引号扫描器起手时就对本片要改的两份 MD 各报一处既有的引号短语（设计 §12-Q11 与本文 FE-6 节第 10 条），本片去掉了这两处引号（只删引号，词不变），之后退出 0 |
| 本机路径 / 机器名 / 局域网地址扫描（`git diff f82f24b8ab..HEAD` 的新增行） | 0 处 |

每个 spec 文件的收集用例数（verbose 日志）：`App.spec.ts` 11、`tasks-api-m3` 142、`tasks-api-m4` 526、`tasks-api` 66、`tasks-badge-m4` 55（13 格改写，数目不变）、`tasks-badge` 25、`tasks-context` 17、**`tasks-counts-realtime` 32（新）**、`tasks-detail-m3` 104、`tasks-detail-m4` 167、`tasks-detail-view` 44、`tasks-groups` 174、`tasks-labels` 88、`tasks-list-detail` 109、`tasks-list-members` 119、`tasks-list-view` 32、`tasks-lists-sidebar` 69、`tasks-nav-badge` 8、`tasks-nav-feature-gate` 15、`tasks-nav-relogin` 4、`tasks-routes` 30、`tasks-settings-view` 75、`tasks-view-transitions` 14、`tasks-view` 7。

### 6. 变异证据

脚本驱动（脚本不入库）：断言每个 `old` 文本在其文件恰出现一次 → 备份到工作树之外 → 改坏 → 跑点名的 spec → 从备份复制回去 → 逐字节比对；不用 `git checkout`。

- 第一轮（28 个，源码与 spec 为 `ceaffcd2ee`）：27 红、1 存活——X12（实时开着时挂载不起 60 s 钟）。它存活不是因为等价：`refresh()` 的 `ok` 分支会把空着的钟重新开起来，所以首次读成功时看不出差别；首次读失败时没有任何东西重开它，轮询就停了。补一格（`b6ea823b77`：socket 在线而首次读失败，60 s 钟照样重试并恢复）之后 X12 变红；另加 X12b（tick 时跳过），同样变红。
- **最终一轮在 `b6ea823b77` 上整轮重跑：29 个变异全部变红（每一个都有断言失败的格），0 个等价变异；29 组文件还原全部逐字节一致；轮后 `git status` 干净**。下表即最终一轮（括号里是失败格数）。

| # | 变异 | 文件 | 跑的 spec | 结果 | 还原 |
|---|---|---|---|---|---|
| X1 | 没有窗口：信号立即重拉 | `useTasksBadge.ts` | counts-realtime、badge-m4 | 红（13）：`gate26|` 首格、8 条信号一次读、持续信号、在途、FE-2 改写的窗口格等 | 一致 |
| X2 | 定时器处的窗口写成 0（常量仍是 500） | 同 | 同 | 红（10）：8 条信号一次读、持续信号、`gate26|` 首格等 | 一致 |
| X3 | 可顺延的窗口：每条信号把它往后推 | 同 | 同 | 红（2）：持续信号格（一直推迟）、8 条信号格 | 一致 |
| X4 | 窗口永不读 | 同 | 同 | 红（29） | 一致 |
| X5 | 去掉 `[fe-52]`：开始的读不关窗（窗口照样能再开） | 同 | 同 | 红（3）：信号先到加 nudge 为一次读、60 s tick 在窗口内回答它、FE-2 改写的 nudge 格 | 一致 |
| X6 | 读完成时才关窗，不是开始时 | 同 | 同 | 红（2）：在途读先到之后窗口仍读、反序两次 | 一致 |
| X7 | 有读在途时丢掉信号 | 同 | 同 | 红（3）：在途两格、反序两次 | 一致 |
| X8 | 总线 nudge 也走窗口 | 同 | counts-realtime、badge-m4、badge（M2） | 红（10）：含 M2 `tasks-badge.spec.ts` 的三格（nudge 立即重拉、404 后重启钟、旧轮询不覆盖新结果） | 一致 |
| X9 | 卸载不关窗 | 同 | counts-realtime、badge-m4 | 红（2）：卸载关窗格、退出时窗口不读格 | 一致 |
| X10 | 隐藏页跳过窗口的读（`[fe-53]` 反过来） | 同 | 同 | 红（1）：隐藏页格 | 一致 |
| X11 | **门 26 负控丁**：去掉订阅 | 同 | 同 | 红（42）：含 `gate26|` 两格 | 一致 |
| X12 | 实时开着时挂载不起 60 s 钟 | 同 | 同 | 红（1）：首次读失败后轮询恢复格（第一轮存活，见上） | 一致 |
| X12b | 实时开着时 60 s tick 跳过 | 同 | 同 | 红（6）：别的进程的写入靠 tick 显示、首次读失败后恢复、FE-2 的三个轮询格等 | 一致 |
| X13 | 事件名常量改拼写 | `useTasksCountsRealtime.ts` | 同 | 红（40） | 一致 |
| X14 | 订阅改传字面量（第二处写法，行为不变） | 同 | 同 | 红（1）：只有普查格看得到 | 一致 |
| X15 | 处理函数读载荷的字段 | 同 | 同 | 红（1）：记录并抛出的载荷格 | 一致 |
| X16 | 只有对象载荷算信号 | 同 | 同 | 红（15）：载荷表的数字、`false`、数组，FE-2 的 `undefined` / `null` / 字符串格 | 一致 |
| X17 | 连上之后发 join | 同 | counts-realtime | 红（1）：从不 `emit` 格 | 一致 |
| X18 | 握手带 `query.userId` | 同 | counts-realtime、badge-m4 | 红（3）：连接参数恰为三键的格（新旧各一）、再次登录格 | 一致 |
| X19 | 卸载不断开 | 同 | 同 | 红（7）：含 `/login` 断开格 | 一致 |
| X20 | socket 跨挂载复用（模块级保存） | 同 | counts-realtime | 红（25）：含再次登录开新 socket 格 | 一致 |
| X21 | 去掉时区头 | `tasksApi.ts` | counts-realtime | 红（2）：`gate26|` 两格 | 一致 |
| X22 | 时区只读一次并缓存 | 同 | 同 | 红（1）：重拉那一刻的时区格 | 一致 |
| X23 | 去掉后台读的重定向抑制 | 同 | 同 | 红（1）：`gate26|` 首格（请求参数恰为两键） | 一致 |
| X24 | 设置保存成功不通知红点 | `TasksSettingsView.vue` | counts-realtime、settings-view | 红（7）：设置三格与 FE-3 的四格 | 一致 |
| X25 | 只在改了 `badgeScope` 时通知（`[fe-54]` 收窄） | 同 | counts-realtime | 红（1）：只改每日提醒格 | 一致 |
| X26 | 红点不按公开路由卸载 | `App.vue` | counts-realtime | 红（3）：壳层的三个退出格 | 一致 |
| X27 | 壳层顶层另开一个 socket（红点的门之外） | `App.vue` | counts-realtime、badge-m4 | 红（12）：FE-2 的门格与本片的壳层格 | 一致 |
| X28 | 窗口只开一次（读不关窗，定时器也不复位） | `useTasksBadge.ts` | counts-realtime、badge-m4 | 红（5）：持续信号、读过之后开新窗口等 | 一致 |

### 7. 与设计的偏差 / 解释

1. **改写的 FE-2 格（13 个，`tasks-badge-m4.spec.ts`，`ce34986c1c`）**：11 个格（B 组 10 个、D 组正控 1 个）原先在事件之后不推进时间就断言重拉，现在用假定时器推进一个窗口再断言（「事件 ⇒ 一次读」那格另断言差 1 ms 时还没有读）；另 2 个改了形状：B 组「三条连续事件三次读、只有最后一个结果落地」改成三次总线 nudge——它钉的 generation 性质不变，三条事件一次读的规则搬到新文件；B 组「总线与 socket 走同一个 refresh」改成 `[fe-52]` 的形状（窗口开着时的 nudge 回答信号，一次读；窗口读过之后的 nudge 再读一次）。各格名字与注释写明是 FE-c 改的。M2 / M3 的 spec（`tasks-badge`、`tasks-nav-badge`、`tasks-nav-feature-gate`、`tasks-nav-relogin`、`App.spec.ts`）零改动、全绿：真实策略在测试构建下不连 socket，所以那些格里根本没有信号，也就没有窗口定时器。
2. **窗口长度 500 ms 是本件自选的值**（`[fe-51]`），owner 可以点名改；spec 推进时间都用导出常量 `TASKS_SIGNAL_WINDOW_MS`，但 B 组有几格写死了间隔（每 50 ms 一条信号、每 100 ms 一条共 1 s、60 s tick 前 200 ms 的信号），改值时要一起核对。（2026-10-09 注：`[fe-51]` 已裁（门 26，owner 2026-10-09 裁定），窗口长度不再是本件自选；H 组按字面毫秒钉住 500，见文末「2026-10-09 信号窗口逐条格」一节。本条写的是当时的状态。）
3. **`[fe-52]` 不是任务清单里的一项**：没有它，身为负责人的操作者每次写都读两次（总线一次、窗口一次，PR-3c §12 第 4 条说的就是这次重复）；它的安全性来自「开始时刻」：开始于信号之后的读必然看到已提交的写。只在开始时关窗，完成时不关（X6）。
4. **设置页的通知 FE-3 起就有**，本片只把「每次保存成功都通知，不只改了 `badgeScope` 的那次」记成 `[fe-54]` 并补了跨组件的格（真实总线、真实红点、真实设置页、没有 socket）。没有收窄：一次保存多一次读，换来以后别的设置也进计数时不用再改。
5. **令牌读取方式不改**：socket 建连时读一次令牌，socket.io 自己的重连沿用它，与两个兄弟组合式相同；换过令牌之后的重连可能进不了房间，红点退回 60 s 钟。在组合式头注里写明，没有改成回调形式（那是三个组合式一起的改动）。
6. **`bootstrapSession` 的 401 分支**会 `clearToken()` 而不跳转：红点在下一次导航前仍挂着，期间的信号只会引来一次答 401 的读，红点转不可用，载荷里本来没有数据可泄露。记录，不改。
7. **时区的取法**：`fetchPendingCount` 调的是同模块内部的 `resolveViewerTimeZone`，mock 它的导出够不到，所以新 spec 用 `Intl.DateTimeFormat.prototype.resolvedOptions` 的 spy 给出浏览器时区，而且只改解析为本机时区的格式器（带显式时区建的格式器照旧），设置页的时区校验与选项列表不受影响。
8. **门 26 的前端格**：两格带 `gate26|` 前缀，与 PR-3c 的后端格同一写法；锁 Draft 把门 26 写成一行 `M4|26|整门`，正文同时含后端格与前端句，所以本分支与 PR-3c 任一单独合入时这一行都不能变绿（PR-3c 设计 §11 末的备注），锁 PR 合并之前是候选、不计分。负控丁（前端去掉订阅）= 变异 X11。
9. **普查格按行判断**：跳过以 `*`、`//`、`/*`、`<!--` 开头的注释行，其余行里任一种引号包着的事件名都算。一个不以这些开头的多行注释行若写了带引号的事件名，会被算进去而变红——是看得见的误报，不是静默放过；扫描器的正控格钉着各种写法。
10. **设计与本文各有一处只删引号的改动**（设计 §12-Q11、本文 FE-6 节第 10 条），为了让引号扫描器在本片改过的文件上退出 0；两处的词不变。

### 8. NOT RUN

- **真实 socket 端到端**：没有同时起 PR-3c 分支的后端与本分支的前端；事件真的到达浏览器、`/pending-count` 真的重拉、两个后端进程时只有一个进程上的 socket 收到——都没有跑过。全部格里 `io` 都是假的。
- 浏览器真机（任何浏览器、读屏软件）：本片没有跑。
- 整页跳转的退出（`App.vue` 的 `logout()` 用 `window.location.assign`）：jsdom 做不了，没有格。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` 与两个 verification 项目）：没有跑；跑的是 `vue-tsc --noEmit -p tsconfig.app.json`（FE-8 记过本地依赖环境下 `vite.config.ts` 的一条既有错误）。
- `apps/web` 全量 `vitest run`：没有跑（本片只动任务文件与守卫 yml；FE-8 跑过一次）。
- CI：本片的提交只在本地，没有推送；Draft #6265 的远端 head 仍是 `f82f24b8ab`。
- 门 26 整行：PR-3c 与本分支合在一起的 head 不存在，NOT RUN。
- staging / 生产：未触达，`TASKS_*` 开关未动。

### 9. 给后续的说明

- 合并顺序：本分支仍须在 PR-3a 之后合并；PR-3c 与本分支谁先合都不影响对方的格：前端只依赖事件名、按用户房间与空载荷这三条约定，PR-3c 的格直接驱动它的发送端口、不涉及客户端；门 26 整行要两边都在 main 上才能跑。
- 窗口长度、`[fe-52]`、`[fe-53]`、`[fe-54]` 都是本件自选，记在设计 §11；§12-Q9（在线时是否停轮询）仍待答，设计里补了技术注：多进程部署下不应停。（2026-10-09 注：窗口长度与 `[fe-52]` 已裁（门 26，owner 2026-10-09 裁定）；`[fe-53]` `[fe-54]` 仍是本件自选。）
- 若以后 PR-3c 给载荷加字段：前端不读（`isCountsInvalidation` 与 C 组的格），除非 owner 另裁。

---

## 全线汇总（FE-0 … FE-8、闸审之后的修复与 FE-c）

### 切片

| 片 | 内容 | 新 spec 文件（落地时的格数） | 变异（红 / 等价） |
|---|---|---|---|
| FE-0 | 文案基座：`labels.ts`、M2 / M3 文案回填、`tasksDateDisplay` 的 locale 参数 | `tasks-labels`（37） | 13（13 / 0） |
| FE-1 | API 客户端全部 M4 函数、`collectPages`、`tasksDraft.ts` 预检 | `tasks-api-m4`（512） | 34（33 / 1） |
| FE-2 | 红点 `off` 与 `tasks:counts-updated` 订阅骨架 | `tasks-badge-m4`（55） | 26（26 / 0） |
| FE-3 | 设置页 `/tasks/settings`、路由、页头入口 | `tasks-settings-view`（71） | 44（44 / 0） |
| FE-4 | 详情编辑区（PATCH / 409）与「所属清单」区 | `tasks-detail-m4`（111） | 79（79 / 0） |
| FE-5 | 左栏、清单页 `/task-lists/:id`、清单总线 | `tasks-lists-sidebar`（67）、`tasks-list-detail`（101） | 78（77 / 1） |
| FE-6 | 成员对话框 | `tasks-list-members`（111） | 96（95 / 1） |
| FE-7 | 分组板（清单与「分配给我」两种 scope） | `tasks-groups`（163） | 108（107 / 1） |
| FE-8 | 收口：`canManageMembers`、`INACTIVE_ORG_MEMBER`、契约重核、裁定记账、注释、绿线、真机走查与 `[fe-48]` | —（既有文件加 63 格） | 36（36 / 0） |
| 闸审之后 | 编辑区的判别键、`[fe-19]` 两半与晚到守卫的格、对话框与页面就地切换的焦点（`[fe-49]` `[fe-50]`）、P3 / NIT、文档措辞 | —（既有文件加 43 格；新源文件 `tasks/tasksFocus.ts`） | 56（56 / 0，含 1 个对照） |
| FE-c | 实时订阅按 PR-3c 重核：信号窗口（`[fe-51]`–`[fe-53]`）、设置页的取舍（`[fe-54]`）、门 26 的前端格、退出与关 feature 时的拆除、事件名普查 | `tasks-counts-realtime`（32）；`tasks-badge-m4` 改写 13 格 | 29（29 / 0；第一轮 28 个里 1 个存活，补一格后变红） |

合计：任务守卫从 14 个 whole-file 参数（13 个 `tasks-*` + `App.spec.ts`，502 用例）到 24 个（23 个 `tasks-*` + `App.spec.ts`，**1933 用例**；FE-c 之前是 23 个、1901 用例）；新 spec 文件 10 个（FE-c 加 1 个），三处登记（lane 脚本、`.tokens` 560、`tasks-web-guard.yml`）D = T = G = 23。变异 **599 个，595 个变红，4 个等价**（FE-c 的 29 个全红）（FE-1 M33、FE-5 P4v、FE-6 G10、FE-7 P1，各节有说明；其中闸审之后 56 个，含 1 个对照），每个变异的文件都逐字节还原。

### owner 问题（设计 §12，缺省即现行为）

| # | 题目 | 缺省 | 状态 |
|---|---|---|---|
| Q1 | `TasksView.vue` 是否先拆 | 不拆 | 待答 |
| Q2 | 路由路径、是否要 `/task-lists` 索引页 | 如 §2.1，无索引页 | 待答 |
| Q3 | 创建表单加截止日期 / 时区 | 不加 | 待答 |
| Q4 | 清单形状加能力标志 | 本期客户端推断 | 待答 |
| Q5 | R20 取 (a) / (b) | (a) | **已裁 2026-10-07：(a)** |
| Q6 | 409 之后保留草稿 | 保留 | 待答（粒度见 Q15） |
| Q7 | 无行任务的排序入口 | 「未排序」尾段 | 待答 |
| Q8 | 红点 `off` 的呈现 | 常驻节点、无数字 | 待答 |
| Q9 | 实时在线时停轮询 | 不停 | 待答（FE-c：PR-3c 的 socket 服务是进程内 adapter，技术上不应停，见设计 §12-Q9 的注） |
| Q10 | 每日提醒旁注措辞 | 接受 | 待答 |
| Q11 | 门 21 / 22 的 M4 子集行入锁计分 | 候选 | R01 已裁（子集行属 M4 退出条件）；入锁计分待答 |
| Q12 | Draft PR 的基 | — | 前提已不成立：以 main 为基 |
| Q13 | 真机联调的后端 | 允许 | 待答（本片已按缺省在本地起） |
| Q14 | `badgeScope` 键的出现规则 | 容忍解析 | 待答（`[own-11]` 仍在 PR-3a 待裁） |
| Q15 | 409 后保留草稿的粒度 | 只保留改过的字段 | **ratified 2026-10-07（`[fe-19]`）** |
| Q16 | 编辑区打开时的只读行 | 显示 | 待答 |
| Q17 | 清单项读失败时的清单页 | 页面照常 | 待答 |
| Q18 | 左栏读 404 的呈现 | 单独呈现 | 待答 |
| Q19 | 清单总线的范围 | 都通知（含转让、退出） | 待答 |
| Q20 | 清单页写失败后重读清单 | 只出横幅 | 待答 |
| Q21 | 动态面板 | 每次重读、不显示 `payload` | 待答 |
| Q22 | id 解析中的归档按钮 | 隐藏 | 待答 |
| Q23 | 转让先确认 | 先确认 | 待答 |
| Q24 | 本人那一行与 id 未知时的行内控件 | 隐藏 | 待答 |
| Q25 | 添加成员的缺省角色 | `read` | 待答 |
| Q26 | 写进行中能否关闭成员对话框 | 不允许 | 待答 |
| Q27 | 分组板的行与完成 / 重启 | 插槽 | 待答 |
| Q28 | 分组板的错误落点 | 板自己的横幅 | 待答 |
| Q29 | 何时停用重排 | 下标空间不一致一律停用，不改请求串 | 待答 |
| Q30 | 拖拽的放置规则 | 下半部 = 之后，空白处与尾段 = 末尾 | 待答 |
| Q31 | 默认组的名字 | 照显示服务端常量 | 待答 |
| Q32 | 分组板 404 与刷新是否重读清单 | 重读 | 待答 |
| Q33 | `canManageMembers` 缺键时的成员控件 | 退回 `canEdit` | 待答（FE-8） |
| Q34 | 「所属清单」加入下拉跟成员管理能力 | 跟 | 待答（FE-8） |
| Q35 | 页面级写之后的焦点 | 本期只修对话框 | 待答（FE-8）；不经过写的就地切换已在闸审之后修（`[fe-49]` `[fe-50]`），仍问写之后与改名表单的 Esc |

### 仍然 NOT RUN（全线）

- PR-3c 已在它的 Draft 分支建成，FE-c 已按设计 §8.3 逐条重核（见 FE-c 节）；真实 socket 的端到端联调（PR-3c 后端加本前端：事件真的到达、`/pending-count` 真的重拉、两个后端进程）仍没有做；两边合在一起的 head 上门 26 整行 NOT RUN。
- 真机只有 FE-8 的这一次走查（Chromium、中文界面、本地一次性库）；Firefox / Safari、英文界面、并发 409、大数据量都没有。闸审之后的焦点修复（`[fe-49]` `[fe-50]`）只在 jsdom 的格里验证，没有在真机复走。
- CI：FE-0 … 闸审之后的树已作为单提交 `f82f24b8ab` 推为 Draft #6265，CI 结果本文没有记；FE-c 的提交只在本地，没有推送。
- staging / 生产：未触达，`TASKS_*` 开关未动。

---

## 2026-10-09 修复轮（注释、一句文案、计数 socket 的令牌规则、裁定引用；登记不变）

### 1. 基线

| 项 | 结果 |
|---|---|
| 起手 head | `5e73a6b8f3`，工作树干净。FE-c 的六个提交此时已推到 Draft #6265（远端分支的 head 即 `5e73a6b8f3`）；FE-c 节 §8 与全线汇总里「FE-c 的提交只在本地」是写那两节时的状态 |
| PR-3a 的迁移文件名 | 2026-10-09 注：PR-3a 的迁移文件改名为 `zzzz20261009130000_create_task_m4_tables.ts`，排在 main 上全部迁移之后。FE-5 节与 FE-8 节写的 `zzzz20261001090000` / `zzzz20261008090000` 是当时的文件名，保留原样（FE-8 节那一处加了同样的注）。前端不依赖迁移文件名 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `b51edd42dd` | 门 15：生产注释只点名本线自己的文件。`labels.ts` 的头注与红点格式函数的注释、`tasksRealtimePolicy.ts` 的头注、`useTasksCountsRealtime.ts` 的头注（改为写本文件自己的 socket 生命周期规则）与事件名常量的注释；只改注释 |
| `fe8894505c` | 清单页清单项区的中文标题（`listItemsHeading`）换一种同义写法；英文值不变 |
| `c4e32290d6` | `useTasksCountsRealtime`：`ensureSocket()` 先读令牌，再建连接尝试；没有令牌或已拆除时返回 `null`，什么都不留，之后带令牌的 `reconnect()` 用那个令牌建连。`tasks-badge-m4` C 组加一格；设计 §8.2 加一条带日期的注 |
| `49cf9aaffb` | owner 裁定只按条目 id 与裁定日期（2026-10-07）引用：设计 23 处、本文 6 处、`TasksView.vue` 一处生产注释、两处 spec 注释；只删词，不改代码行 |
| 本文所在提交 | 本节、FE-8 节的改名注与抬头一句 |

### 3. 逐项结果

1. **门 15**（锁的门 15：生产代码的注释里，不点名其他功能线的符号）。人口：`git diff cc6ca96ac2..HEAD -- apps/web/src` 新增的注释行（行首注释、行尾 `//`、块注释的各行、`.vue` 模板注释），按词法逐行取注释文本，HEAD 上 1195 行。记号表用 PR-3c 验证记录 §6 `M2|15` 行那一组，不区分大小写。起手 head 上 7 行命中：4 行点名了其他线的文件或组合式（`labels.ts` 头注一行、`tasksRealtimePolicy.ts` 一行、`useTasksCountsRealtime.ts` 头注两行），另 3 行是本线红点组件的名字（两行）与 `census` 一词（一行）。改写之后 **0 命中**。对照：同一记号表扫全部新增行（不分是否注释），只剩 3 行代码，都是红点自己的 CSS 类名 `tasks-todo-badge--*`。
2. **文案**：`listItemsHeading` 的中文换写法，英文 `Tasks in this list` 不变。没有 spec 钉这句标题：`tasks-labels` 查键对等与各语言的内容，清单页的 spec 按 test id 取区块；`tasks-labels` 与 `tasks-list-detail` 197 格全绿。设计 §12-Q11 与本文 FE-6 节第 10 条的两处引号短语，FE-c 已经去掉了引号（`bbb7a1856c`、`fb1dbfd130`，见 FE-c 节 §7 第 10 条），本轮复扫不再报。
3. **计数 socket 的令牌规则**：新格是 C 组的 `attempts without a token keep nothing: once the session has a token, reconnect() opens the socket with it`——挂载时那次尝试（策略为真）与一次显式 `reconnect()` 都没有令牌、都得 `null`、`io` 零次；令牌到了之后，`reconnect()` 得到 socket，`io` 恰一次、参数里是新令牌，事件到达回调。变异（把 `ensureSocket()` 改回在尝试内部读令牌的旧形，先断言替换点恰一处、`cp` 备份）：`tasks-badge-m4` 与 `tasks-counts-realtime` 共 88 格，恰 1 格红，就是新格（`expected null not to be null`），其余 87 格绿；从备份复制回去，`cmp` 逐字节一致。
4. **兄弟组合式**：同一条令牌规则在两个兄弟组合式里还没有，作为本 PR 之外的后续项；本 PR 的代码注释不写它们的文件名。
5. **裁定引用**：设计与本文的 owner 裁定现在只写条目 id 与日期；代码、spec 各一处同样处理。改动只删词，未改任何取值与结论。

### 4. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run <守卫 yml 的 24 个 whole-file 参数> --reporter=verbose`（`apps/web`） | **24 文件 / 1934 用例全绿**（1933 + 新格 1）。逐文件：`tasks-badge-m4` 55 → 56，其余 23 个文件的收集数与 FE-c 节 §5 逐个相同 |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 退出 0，0 行输出 |
| `bash apps/web/scripts/run-required-web-tests.sh`（仓库根，Node 20） | 第二遍：退出 0，332 秒；19 次 vitest 调用全绿，合计 **634 文件 / 12418 用例**（FE-c 时 12417，加新格 1），最后一次 531 文件 / 10294。第一遍跑在机器负载很高的时候（load average 约 60），退出 1：最后一次调用里有 2 格 `Test timed out in 5000ms`，分别在 `approval-center.spec.ts` 与 `multitable-automation-rule-editor.spec.ts`，都不是任务文件，本 PR 没有改它们，它们也不引用任务代码；两个文件各自单独重跑 47 / 47、185 / 185 全绿，之后整条 lane 重跑一遍，即上面的第二遍 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，560 个 token（本轮不改登记） |
| D = T = G | 23，集合两两相等；yml 24 个 whole-file 参数，`vitest run` 只出现 1 次 |
| 门 15 扫描（§3 第 1 条的人口与记号表） | 1195 行，0 命中（起手 7 行） |
| 字面扫描器 v1 与 v2（整个 PR 文件集：`git diff --name-only cc6ca96ac2..HEAD`，42 个文件；另加本轮的提交信息） | 都退出 0 |
| 引号扫描器（同一文件集） | **退出 1，只剩一处**：`apps/web/src/router/appRoutes.ts:148`，另一条线的一个路由标题。这一行 main 上 2026-07-24 起就有（对 `origin/main` 与合并基 `cc6ca96ac2` 的同一文件扫，同样报出），本 PR 在该文件里只加了两条任务路由，没有碰这一行；本 PR 不改别的线的界面文案，这一处交 owner 定。除去这个文件，其余 41 个文件退出 0；`labels.ts` 的那一处已随 `fe8894505c` 消失 |
| 本机路径 / 机器名 / 局域网地址扫描（`git diff 5e73a6b8f3..HEAD` 的新增行、本轮提交信息） | 0 处 |

全线汇总里的守卫数与变异数是 FE-c 时的值；加上本轮：守卫 24 个文件 / 1934 格，变异 600 个，596 个变红，4 个等价（本轮的 1 个变红）。

### 5. NOT RUN

- 真实 socket 端到端（PR-3c 后端 + 本前端）：仍没有跑，全部格里 `io` 都是假的。
- 浏览器真机：本轮没有跑（清单页标题换了写法，只在 jsdom 的格与中英扫描里看过）。
- `pnpm --filter @metasheet/web run type-check`（`vue-tsc -b` 与两个 verification 项目）与 `apps/web` 全量 vitest：没有跑。
- CI：本轮的提交只在本地，没有推送。
- 两个兄弟组合式的同一规则：不在本 PR（§3 第 4 条）。

---

## 2026-10-09 信号窗口逐条格（门 26，owner 2026-10-09 裁定）

### 1. 基线

| 项 | 结果 |
|---|---|
| 起手 head | `9c0f582319`，工作树干净 |
| 裁定 | 门 26 的信号窗口按 `[fe-51]` `[fe-52]` 定案（owner 2026-10-09 裁定）：这两条由本件自选转为已裁；`[fe-53]` `[fe-54]` 仍是本件自选 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| `70efe9be21` | `tasks-counts-realtime.spec.ts` 加 H 组四格（每条规则一格）与头注里 H 组的一段；只动 spec |
| 本文所在的两个提交 | 本节；FE-c 节 §7 第 2 条与 §9 第二条各加一句带日期的注；第二个提交补 §4 末段 W1、W7、W8 在整个守卫上的复跑 |

### 3. 规则、代码与格

四条规则（与设计 §8.2 `[fe-51]` `[fe-52]` 两段同义）逐条对 `useTasksBadge.ts`：**四条都一致，生产代码零改动**。

| # | 规则 | 代码里的依据 | 格（H 组） |
|---|---|---|---|
| 1 | 窗口固定 500 ms：第一条信号打开窗口，窗口结束时读一次；窗口里后到的信号并入这一次，既不提前读，也不把窗口往后推 | `TASKS_SIGNAL_WINDOW_MS = 500`；`onCountsSignal()` 在窗口开着时直接返回，定时器只在第一条信号时设一次 | 第 1 格：先断言常量等于 500，再按字面毫秒推进：499 ms 时没有读，500 ms 时恰一次；450 ms 到的信号不推迟它；之后 1 s 内没有别的读，只剩 60 s 钟的定时器 |
| 2 | 窗口开着时开始的读（总线 nudge、60 s 钟的 tick）发在窗口吸收的每条信号之后，因此回答了它们，窗口随之关闭，不再自己读 | `refresh()` 的第一句 `closeSignalWindow()`：读一开始就关窗、清定时器；总线与 tick 都经 `refresh()`。边界：隐藏页的 tick 跳过读（60 s 钟自己的规则，`[fe-53]`），没有读开始，也就不关窗 | 第 2 格三段：窗口开了 200 ms 时的总线 nudge、窗口开了 200 ms 时的可见页 tick，都只有这一次读，窗口的定时器随之消失；隐藏页的 tick 不读也不关窗，窗口在信号后 500 ms 照常读 |
| 3 | 一次读开始以后才到的信号不归那次读：它自己打开一个窗口，从这条信号起算整 500 ms | `closeSignalWindow()` 在读开始时把句柄置空，之后到达的信号走 `onCountsSignal()` 开新窗口的分支 | 第 3 格：上一窗口的读挂起未回，读开始 100 ms 后到达的信号：再过 499 ms 没有读，500 ms 时恰一次；挂起的读最后才回，结果被 generation 丢弃 |
| 4 | 信号到达时已经在途的读不回答它：窗口照常结束并发自己的读 | 关窗只发生在读开始与卸载两处，读的完成不碰窗口 | 第 4 格：挂载读挂起，50 ms 时到信号，100 ms 时旧结果在窗口内落地并渲染；550 ms 时窗口照常读，渲染的是它的结果 |

说明：

1. **H 组按字面毫秒推进**，不用 spec 里的 `WINDOW`（导出常量）：其余各组按常量推进，常量改值时它们跟着改，看不出来（W1：常量改为 400 时只有 H 组四格变红）。改窗口长度现在要新的裁定。
2. **新格不带 `gate26|` 前缀**：门 26 的前端候选格仍是 A 组两格；这四格是否计入门 26，看锁 PR 里门 26 的正文，本 PR 不改锁。负控丁（去掉订阅，即 FE-c 的 X11）在本轮的 head 上复跑：`tasks-counts-realtime` 与 `tasks-badge-m4` 共 92 格，46 格变红（FE-c 时 87 格中 42 格），两个 `gate26|` 格照旧都红，多出的 4 格就是 H 组；还原逐字节一致。（2026-10-09 晚注：下一节按锁 PR 列出的格名给门 26 的前端格带上名字，A 组两格改名，H 组第 1、3、4 格改名，第 2 格拆成两个带名的格与一个不带前缀的隐藏页格；门 26 的前端格现为七格。）
3. **第 3、4 格在挂起的读落地之后冲刷 8 轮微任务**（`flush(8)`）：挂载读的结果要经过假后端的 async 返回、`apiFetch`、`json()` 与 `refresh()` 几层，默认的 4 轮在第 4 格里不够。对照变异 W12（去掉 generation 守卫）让第 3 格变红，说明那一格最后断言旧结果被丢弃时，旧结果确实已经落地。
4. **设计未改**：设计 §8.2 与 §11 的 `[fe-51]` `[fe-52]` 两行，规则文字与裁定一致；§11 这两行还没有标裁定日期。（2026-10-09 晚注：已在下一节标上。）

### 4. 变异证据

脚本驱动（脚本不入库）：断言每个替换点在文件中恰出现一次 → 备份到工作树之外 → 改坏 `useTasksBadge.ts` → 跑 `tasks-counts-realtime`、`tasks-badge-m4`、`tasks-badge`、`tasks-nav-badge` 四个 spec（共 125 格）→ 从备份复制回去 → 逐字节比对；不用 `git checkout`。**12 个变异全部变红（含 1 个对照），每条规则的变异都让该规则那一格变红；12 次还原全部逐字节一致**，轮后 `useTasksBadge.ts` 与起手逐字节相同。

| # | 变异 | 针对 | 结果（红 / 125） | 其中 H 组 | 还原 |
|---|---|---|---|---|---|
| W1 | 常量改为 400 | 规则 1 | 红（4） | 第 1–4 格；其余 121 格绿 | 一致 |
| W2 | 可顺延的窗口：每条信号重设定时器 | 规则 1 | 红（3）：另两格是 B 组 8 条信号格、持续信号格 | 第 1 格 | 一致 |
| W3 | 定时器处多 1 ms（常量仍是 500） | 规则 1 | 红（33） | 第 1–4 格 | 一致 |
| W4 | 开始的读不关窗（窗口自己的读放开句柄） | 规则 2 | 红（4）：另三格是 B 组两个 `[fe-52]` 格与 FE-2 改写的 nudge 格 | 第 2 格 | 一致 |
| W5 | 只有总线 nudge 的读不关窗 | 规则 2 | 红（3） | 第 2 格 | 一致 |
| W6 | 只有可见页 tick 的读不关窗 | 规则 2 | 红（2） | 第 2 格 | 一致 |
| W7 | 隐藏页跳过读的 tick 也关窗 | 规则 2 的边界 | 红（1） | 只有第 2 格 | 一致 |
| W8 | 句柄在读落地时才放开（读开始时只清定时器） | 规则 3 | 红（1） | 只有第 3 格 | 一致 |
| W9 | 句柄从不放开 | 规则 3 | 红（5） | 第 2、3 格 | 一致 |
| W10 | 读落地时也关窗 | 规则 4 | 红（3）：另两格是 B 组在途格、反序两次格 | 第 4 格 | 一致 |
| W11 | 有读在途时丢掉信号 | 规则 4 | 红（5） | 第 3、4 格 | 一致 |
| W12 | 对照：去掉 generation 守卫 | 第 3 格末段的断言 | 红（3）：另两格是 FE-2 连续三次 nudge 格、M2 的旧轮询不覆盖格 | 第 3 格 | 一致 |

W1、W7、W8 只有 H 组的格变红。这三个另在守卫 yml 的 24 个文件（1938 格）上整组复跑：分别 4、1、1 格变红，都是 H 组的格，还原逐字节一致；所以没有本轮的格，这三个变异在整个任务守卫上都会存活。W1 说明此前没有格钉住 500 这个数；W7、W8 是本轮新钉住的两条边界（跳过读的 tick 不算开始的读；句柄在读开始时就放开）。

### 5. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run <守卫 yml 的 24 个 whole-file 参数> --reporter=verbose`（`apps/web`） | **24 文件 / 1938 用例全绿**（1934 + 新格 4）。逐文件：`tasks-counts-realtime` 32 → 36，其余 23 个文件的收集数与上一轮相同 |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 退出 0，0 行输出 |
| 改过的 spec 的类型检查（临时 tsconfig = app 配置 + 这个文件，不入库） | `tasks-counts-realtime.spec.ts` 0 错误。同一配置另报两条，都在多维表的两个组件里（`setTimeout` 返回值的类型）；只给 app 配置加 Node 类型、不加任何 spec 时，这两条同样出现：它们来自 spec 的 `node:` 导入带进程序的 Node 类型，与本轮无关 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，560 个 token（本轮不改登记） |
| D = T = G | 23，集合两两相等；yml 24 个 whole-file 参数 |
| 字面扫描器 v1、v2 与引号扫描器（本轮改过的两个文件、三条提交信息） | 都退出 0 |
| 本机路径 / 机器名 / 局域网地址扫描（`git diff 9c0f582319..HEAD` 的新增行、本轮提交信息） | 0 处 |

全线汇总里的守卫数与变异数是 FE-c 时的值；加上上一轮与本轮：守卫 24 个文件 / 1938 格，变异 612 个，608 个变红，4 个等价（本轮 12 个全红，含 1 个对照）。

### 6. NOT RUN

- 真实 socket 端到端（PR-3c 后端 + 本前端）：仍没有跑，全部格里 `io` 都是假的。
- 浏览器真机：本轮没有跑。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane、`pnpm --filter @metasheet/web run type-check`、`apps/web` 全量 vitest：没有跑（本轮只在一个已登记的 spec 文件里加格，登记不变）。
- 真库 lane：不适用，本轮不涉及数据库。
- CI：本轮的提交只在本地，没有推送。

## 2026-10-09 门 26 前端格按格名（七格；owner 2026-10-09 裁定）

### 1. 基线

| 项 | 结果 |
|---|---|
| 起手 head | `c3f3bc525e`，工作树干净 |
| 依据 | 锁 PR（#6248）按 owner 2026-10-09 裁定（门 26）让门 26 的正控、负控跟上正文里的窗口规则：前端格按格名列为七格；`apps/web` 的 spec 里以 `gate26\|` 开头的用例恰为这七个名字、各一格，格名取到用例名的第一个空白为止，格里的时刻按字面毫秒写；前端的负控是丁–癸 |
| 裁定 | `[fe-51]` `[fe-52]` 两条由本件自选转为已裁（上一节）；`[fe-53]` `[fe-54]` 仍是本件自选 |

### 2. 提交

| 提交 | 内容 |
|---|---|
| 本节所在的提交 | `tasks-counts-realtime.spec.ts`：门 26 的格按格名改名、拆分，A 组两格改按字面毫秒计时；`useTasksBadge.ts`、`useTasksCountsRealtime.ts` 只改注释（`[fe-51]` `[fe-52]` 标为已裁）；设计抬头、§8.2、§8.3 第 5 条、§10.1、§11；本记录的抬头、上一节两处注与本节 |

### 3. 格名、条款与格

| 格名 | 锁里门 26 的条款 | 格从哪来 | 断言（`t` 从挂载起算） |
|---|---|---|---|
| `gate26\|重拉格` | R01 原文的前端句：收到事件后重拉 `/pending-count` | A 组第 1 格改名；计时改为字面毫秒 | 事件在 0 ms：499 ms 时没有请求，500 ms 时恰一次，参数恰为查看者时区头与重定向抑制两键，红点显示它的结果；到 59 999 ms 不再请求 |
| `gate26\|时区格` | 同上：请求带的时区 | A 组第 2 格改名；改为字面毫秒，时区改在窗口开着时切换 | 事件到达时浏览器报 A，250 ms 时改报 B：499 ms 时没有请求，500 ms 的那次请求带 B |
| `gate26\|到点格` | 窗口固定 500 ms，后到的事件并入，不顺延 | H 组第 1 格改名 | 499 ms 时没有请求，500 ms 时恰一次；450 ms 到的事件既不增加请求也不推迟它 |
| `gate26\|提前格\|轮询` | 窗口开着时另有一次读取开始，它回答窗口里的事件，窗口到点的那次读取取消 | H 组第 2 格的可见页 tick 一段拆出 | 事件之后窗口的定时读取确已排定（定时器 2 个）；窗口开了 450 ms 时可见页的 tick 读取，定时器随即只剩 60 s 钟；之后不再请求 |
| `gate26\|提前格\|总线` | 同上，读取由总线触发 | H 组第 2 格的总线一段拆出 | 同上，450 ms 时的读取由总线 nudge 发起 |
| `gate26\|另开窗口格` | 读取开始以后到达的事件另开窗口 | H 组第 3 格改名 | 窗口到点的读挂起；它开始 100 ms 后到达的事件：再过 499 ms 没有请求，500 ms 时恰一次；挂起的读最后才回，结果被丢弃 |
| `gate26\|在途格` | 事件到达时已发出、尚未返回的读取不回答它；它返回时窗口不关 | H 组第 4 格改名 | 挂载读挂起，50 ms 时到事件，100 ms 时旧结果在窗口里落地：定时器仍是 2 个，549 ms 时没有新请求，550 ms 时恰一次，红点显示这一次的结果 |

说明：

1. **原 H 组第 2 格拆成三格。** 轮询与总线各成一格，便于一个变异只红一格（下表 V3、V4）。两格都先断言事件之后定时读取确已排定，再断言读取开始时它被取消：没有窗口时它们不会空过（V1 也让它们变红）。读取放在窗口开了 450 ms 时，窗口长度改为 400 时它们也变红（V14）。
2. **隐藏页的一段成为 H 组一个不带前缀的格。** 隐藏页的 tick 跳过读，不算开始的读，窗口仍开着；页面在窗口到点之前切回可见，窗口到点照常读。这样它不再依赖 `[fe-53]`（隐藏页到点照读，仍是本件自选）。核对：把 `[fe-53]` 反过来（隐藏页到点不读），在本节的 spec 上只有 B 组的 `[fe-53]` 格变红，这一格与七个 `gate26\|` 格都是绿的；同一改动放在起手 head 的 spec 上，原 H 组第 2 格也变红。两次都逐字节还原。
3. **A 组两格改按字面毫秒计时**，与 H 组一致（锁的要求）；其余各组仍按导出常量 `WINDOW` 计时。
4. **代码注释里 `[fe-51]` `[fe-52]` 的标签点**（`useTasksBadge.ts` 的模块头注、常量、`refresh()` 第一句与 `onCountsSignal()` 前的注释，`useTasksCountsRealtime.ts` 的头注）按 `[fe-45]` 的先例写作 `ruled 2026-10-09`；spec 里只按 id 引用的地方不改，状态以设计 §11 为准。生产代码只有注释变化。

### 4. 变异证据

脚本驱动（不入库），做法同前几节：断言每个替换点在文件中恰出现一次 → 备份到工作树之外 → 改坏 → 跑 `tasks-counts-realtime`、`tasks-badge-m4`、`tasks-badge`、`tasks-nav-badge` 四个 spec（127 格）→ 从备份复制回去 → 逐字节比对；不用 `git checkout`。起手先跑未改动的四个 spec：127 格全绿。**17 个变异全部变红；其中 V1–V13 与锁里前端的负控丁–癸同形，每个都让锁为它点名的格变红，另 4 个（V14–V17）锁里没有为它们点名的格；17 次还原全部逐字节一致**，轮后 `useTasksBadge.ts` 与 `tasksApi.ts` 与轮前逐字节相同。

| # | 变异 | 锁里的负控 | 同形的旧编号 | 红 / 127 | 其中带名的格 |
|---|---|---|---|---|---|
| V1 | 事件到达后什么都不做（socket 照开） | 丁 | X11 的另一种写法 | 35 | 七格全红 |
| V2 | 开始的读不关窗（窗口自己的读放开句柄） | 戊 | W4 | 5 | 提前格\|轮询、提前格\|总线 |
| V3 | 只有总线 nudge 的读不关窗 | 戊（总线） | W5 | 3 | 只有提前格\|总线 |
| V4 | 只有可见页 tick 的读不关窗 | 戊（轮询） | W6 | 2 | 只有提前格\|轮询 |
| V5 | 有读在途时到达的事件不开窗口 | 己 | W11 | 5 | 另开窗口格、在途格 |
| V6 | 后到的事件把窗口往后推 | 庚 | W2 | 3 | 只有到点格 |
| V7 | 读落地时也关窗：在途的读取抵消了它在途时到达的事件 | 辛 | W10 | 3 | 只有在途格 |
| V8 | 关窗从读开始挪到读落地 | 辛（挪动的写法） | X6 | 5 | 在途格、另开窗口格、提前格\|总线 |
| V9 | 窗口的读落地之前窗口仍算开着（读开始时只清定时器，落地时才放开句柄） | 壬 | W8 | 1 | 只有另开窗口格 |
| V10 | 句柄从不放开 | 壬（强形） | W9 | 4 | 只有另开窗口格 |
| V11 | 去掉 `/pending-count` 的查看者时区头（`tasksApi.ts`） | 癸 | X21 | 2 | 重拉格、时区格 |
| V12 | 去掉后台读的重定向抑制（`tasksApi.ts`） | 癸 | X23 | 1 | 只有重拉格 |
| V13 | 时区只在第一次读时取，之后沿用（`tasksApi.ts`） | 癸 | X22 | 1 | 只有时区格 |
| V14 | 窗口长度改为 400 | — | W1 | 8 | 七格全红；另一格是隐藏页 tick 格 |
| V15 | 定时器处多 1 ms（常量仍是 500） | — | W3 | 33 | 重拉格、时区格、到点格、另开窗口格、在途格 |
| V16 | 隐藏页跳过读的 tick 也关窗 | — | W7 | 1 | 无；红的是隐藏页 tick 格 |
| V17 | 对照：去掉 generation 守卫 | — | W12 | 3 | 只有另开窗口格（末段断言旧结果被丢弃） |

V1–V13 逐条落实锁里前端的负控丁–癸；V7 是「在途的读取抵消新事件」的直接写法，V8 是同一缺陷的挪动写法。V1 的写法：把传给订阅的回调换成空函数，socket 照开、事件照到，只是不再触发任何读。

### 5. 格名核对

脚本（不入库）：从锁 PR 里门 26 那一行取反引号中的 `gate26\|…` 格名；从 `apps/web` 下全部 `.ts` `.tsx` `.js` `.mjs` `.vue` 文件（跳过 `node_modules`）的用例名里取以 `gate26\|` 开头的名字，取到第一个空白为止。两边须是同样的七个名字，spec 一侧每个名字恰出现一次。

| 对象 | 退出码与输出 |
|---|---|
| 锁 PR 的新 head 对本节的 head | 0：两边都是七个名字，spec 一侧各一次，都在 `tasks-counts-realtime.spec.ts` |
| 负控：spec 副本里把 `gate26\|在途格` 改为 `gate26\|在途` | 1：锁有而 spec 无一个，spec 多出一个 |
| 负控：spec 副本里把 B 组「在途时到达的信号」一格改名为 `gate26\|在途格` | 1：重复 |
| 负控：起手 head 的 spec（两格只有前缀） | 1：七个都缺，前缀本身重复 |
| 负控：锁副本里把格名 `gate26\|另开窗口格` 改成不带前缀 | 1：锁一侧只剩六个名字，spec 多出一个 |
| `vitest run tests/tasks-counts-realtime.spec.ts -t 'gate26[\|]'` | 7 passed、31 skipped |

### 6. 命令与计数

| 命令 | 结果 |
|---|---|
| `./node_modules/.bin/vitest run <守卫 yml 的 24 个 whole-file 参数> --reporter=verbose`（`apps/web`） | **24 文件 / 1940 用例全绿**（上一节 1938；原 H 组第 2 格拆成三格，净加 2）。逐文件：`tasks-counts-realtime` 36 → 38，其余 23 个文件的收集数与上一节相同 |
| `./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | 退出 0，0 行输出 |
| 改过的 spec 的类型检查（临时 tsconfig = app 配置 + 这个文件 + Node 类型，不入库） | `tasks-counts-realtime.spec.ts` 0 错误；同一配置另报的两条仍在多维表的两个组件里，去掉 spec 时同样出现，与本轮无关 |
| `node scripts/ops/required-web-lane-token-manifest.mjs`（检查模式） | `MANIFEST MATCHES`，560 个 token（登记不变） |
| 字面扫描器 v1、v2 与引号扫描器（本轮改过的五个文件、提交信息） | 都退出 0 |
| 本机路径 / 机器名 / 局域网地址扫描（新增行、提交信息） | 0 处 |

全线累计：守卫 24 个文件 / 1940 格；变异 629 个，625 个变红，4 个等价（本轮 17 个全红，含 1 个对照）。

### 7. NOT RUN

- 真实 socket 端到端（PR-3c 后端 + 本前端）、浏览器真机：本轮没有跑。
- `bash apps/web/scripts/run-required-web-tests.sh` 整条 lane、`pnpm --filter @metasheet/web run type-check`、`apps/web` 全量 vitest：没有跑（本轮只改一个已登记 spec 里的格与两个生产文件的注释，登记不变）。
- 真库 lane：不适用。
- CI：本轮的提交只在本地，没有推送。
