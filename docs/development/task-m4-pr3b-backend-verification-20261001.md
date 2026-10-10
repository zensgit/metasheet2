# 任务功能 M4 后端 PR-3b 验证记录（设计 2026-10-01；记录自 2026-10-07 起）

- 设计：`docs/development/task-m4-pr3b-backend-design-20261001.md`（DRAFT，入库提交 `069254cdfa`）。锁：`docs/development/task-feature-design-lock-20260917.md`。
- 分支：`claude/tasks-m4-pr3b`，从 PR-3a 分支 `claude/tasks-m4-pr3a` 当时的 HEAD `00ddafad23`（PR-3a S0–S5 加当时 `origin/main` `8e2e40d125` 的合并）起。不推送、不开 PR、不合并、不应用 DDL、不上 staging、不打开任何 `TASKS_*` 开关。owner 在 2026-10-07 对 M4 裁决包落槌（S0、S1 两节写于裁决之前，按当时的状态保留原文）；本 PR 收到的已裁条目见设计 §12，本文只按条目 id 引用。
- 叠栈：PR-3a 尚未合并。S2 动手前按设计 §14.0 以合并方式重叠到 PR-3a 的 head `d940fa8745`（含 S5–S10，见 S-merge 一节）；每次重叠用到的 PR-3a SHA 记在对应一节。
- 本文件按切片追加。当前覆盖 S0（基座与 flag）、S1（纯函数）、S-merge（重叠到 PR-3a S10 head）、S2（producer 与触点）、S3（N1）、S3 之后的收尾（最终 head 上的绿线、变异重跑与清库）、S4（投递 worker，含 R01、R04、R13 的改标）、S-merge2（第二次重叠，PR-3a 闸审修复之后的 head）、S5（调度器与启动接线）、S6（钉钉通道）、S-gate（S2–S6 门审修复，2026-10-09）、S7（收口，2026-10-09）与总览（S0–S7），以及文末的 2026-10-09 改叠一节与同日重建到 main 上的一节。

## 0. 本地环境

- Node 20.20.2。`node_modules`（根、`packages/core-backend`、八个 `plugins/*`）是指向规范检出的符号链接；未跑 `pnpm install`。
- S0 没有数据库测试，没有建一次性库。
- 裁决包字面扫描（字面扫描器 v1，在私有工件目录）对本片新增 / 改动的每个文件与两份 MD 都退出 0。S-merge 起每片另跑第二版扫描（连续 10 个以上中日韩字符的重合、标记归一化后比较），S4 起另跑第三版（引号内的字串）；各版对每个改动文件都要退出 0。
- 变异与编辑脚本放在私有工件目录（不入库）；从不使用 `git checkout` / `reset` / `stash` / `clean`。

## S0 基座与 flag

### S0.1 基座

| 项 | 值 |
|---|---|
| PR-3a 源 HEAD（S0 起点，分支 `claude/tasks-m4-pr3a`） | `00ddafad233d85617a373e8e97aa6b8eae4c2693` |
| 该 HEAD 相对设计写作时观测的 PR-3a HEAD `aafa05f2d5` | `git log aafa05f2d5..00ddafad23` 共 23 条：PR-3a 自己的 4 条（S5 三条 `fd1399bc05` 路由 / `54f7f5990a` 格 / `cbe9d7fd57` 验证 MD，与合并提交 `00ddafad23` 本身）加经合并带入的 19 条 `origin/main` 提交（`8e2e40d125` 及其之前，含 #6173、#6191） |
| 基座里已含的 main 守卫 | #6173（`0386f47fdc`，`tasks/feature-flag.ts#isTasksEnabled` 与 manifest 的 `TASKS_` 发现正则）、#6191（`2a0dc44718`，payload 台账守卫） |
| 设计入库提交 | `069254cdfa04f429e6c943e85639a778049acab9` |
| S0 代码提交 | `aad99fa10a0b26ec6678455c6933d01b3a930c8b` |
| 设计 §14.0 的 S0 入口条件（基座不早于 `aafa05f2d5`） | 满足 |

S0 从这个基座起只加新文件、改一个纯函数模块的常量区与 manifest；没有改 PR-3a 的任何服务、路由、迁移或测试。

### S0.2 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/services/task-notification-flags.ts`（新，78 行） | 三个读函数 `isTasksSchedulerEnabled` / `isTaskNotificationDeliveryWorkerEnabled` / `isTaskDingTalkWorkNotificationEnabled`（各只读自己的 env 键，严格 `=== 'true'`，与 `src/tasks/feature-flag.ts#isTasksEnabled` 同形；默认 OFF；默认参数 `process.env`）；派生谓词 `isTaskNotificationPipelineEnabled`（三者合取；不含 `TASKS_ENABLED`，设计 §5.1）；`resolveTaskDeliveryChannelNames`（谓词为真时 `[TASK_NOTIFICATION_CHANNEL_DINGTALK]`，否则 `[]`）；`resolveTaskSchedulerIntervalMs`（`TASKS_SCHEDULER_INTERVAL_MS`：去首尾空白后只接受纯数字串且为安全整数，否则取默认 60000；夹到 `[5000, TASK_REMINDER_SCAN_WINDOW_MS]`，`'0'` 读作下限）与常量 `TASK_SCHEDULER_INTERVAL_DEFAULT_MS` / `_MIN_MS` / `_MAX_MS`。注释只引条目 id（`[own-3b-01]` `[own-3b-06]` `[D3]`），不点名其他线的符号（门 15） |
| `packages/core-backend/src/tasks/task-notifications.ts`（追加 8 行） | `TASK_NOTIFICATION_CHANNEL_DINGTALK = 'dingtalk_work_notification'` 与类型 `TaskNotificationChannel`（`ASSUMPTION(task-m4): [D4]`；设计 §3.4 把它放在本模块，S0 先行加入，见 S0.6 第 1 条） |
| `scripts/ops/global-history-flag-manifest.mjs`（追加 37 行，`:697-733`） | `TASKS_SCHEDULER_ENABLED`（danger medium，`dependsOn: ['TASKS_ENABLED']`）、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED`（medium，dependsOn 前两者）、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED`（high，dependsOn 前三者）。都是 `type: 'boolean'`、`activationValue: 'true'`、无 `caseInsensitive`、无 `rules`（`ASSUMPTION(task-m4): [own-3b-22]`，owner 问题 §13-Q19；`dependsOn` 只作文档，`evaluateFlagRules` 与状态工具都不单独读它）；`source` 为 `path#symbol` 形，指向上面三个读函数；`purpose` 只写规则：默认 OFF、严格 `'true'`、三者都开才有行与发送、只为有活跃钉钉集成的 org 写行、`TASKS_ENABLED` 与 M4 迁移是前提（S0 写的是迁移当时的名字 `zzzz20261001090000_create_task_m4_tables`；PR-3a S10 把它改名为 `zzzz20261008090000_create_task_m4_tables`，三段 `purpose` 在 S-merge 同步，见 S-merge.3；2026-10-09 PR-3a 再次改名为 `zzzz20261009130000_create_task_m4_tables`，三段 `purpose` 随之同步，见文末「2026-10-09 改叠到重新定名之后的 PR-3a」一节）、账本行永久保留（`[R13]`）、发送配置只取身份所在的集成行（`[own-3b-19]`）、出站地址限 https 的钉钉域名（`[own-3b-21]`）、interval 旋钮的默认值与夹取范围 |
| `packages/core-backend/tests/unit/task-notification-flags.test.ts`（新，217 行，68 格） | 见 S0.3 |
| `docs/development/task-m4-pr3b-backend-design-20261001.md`（新） | 设计入库（提交 `069254cdfa`）。抬头写明：叠在尚未合并的 PR-3a 上、PR-3a 叠在尚未合并的 M3 后端与任务 D 上、owner 未裁、未裁取值标 `ASSUMPTION(task-m4)`、不合并、不上 staging、不应用 DDL、三个 flag 默认 OFF；加「入库」一条；另有若干处措辞调整。取值、切片、门行零改动；扫描退出 0 |

不碰：`routes/auth.ts#buildFeaturePayload`（不加键，设计 §9.3；本基座含 #6191 的台账守卫 `tests/unit/approval-feature-payload-flag-ledger.test.ts`，8/8 绿，三个新 flag 不到前端、不需要台账行）、`src/index.ts`（S5 才接线）、任何 `task-*.db.test.ts` / `vitest.config.ts` exclude / `.github/workflows/tasks-realdb.yml`（S0 无真库文件）、`scripts/ops/global-history-flag-manifest.test.mjs`（不改；发现式核对自动覆盖新 token，rule id 集合不受影响）、`src/tasks/task-reminders.ts`（S1 才追加）。

### S0.3 单测 `task-notification-flags.test.ts`（68 格）

| 组 | 格数 | 内容 |
|---|---|---|
| 缺省 | 2 | 空 env 对象，以及清空五个任务键后的 `process.env`（默认参数路径）：三开关 false、谓词 false、通道 `[]`、interval 60000 |
| 每个开关 × 值表 | 3 × (8 + 1 + 1) = 30 | 与 `tests/unit/tasks-feature-flag.test.ts` 同一张 8 行值表（unset / `''` / `'TRUE'` / `'1'` / `' true'` / `'true '` / `'false'` / `'true'`），每行同时断言与 `isTasksEnabled({ TASKS_ENABLED: 同值 })` 相等；只读自己的键（另两个为 `'true'` 时仍 false，自己为 `'true'` 时 true）；默认参数读 `process.env`（`'true'` 真、`'TRUE'` / `' true'` 假） |
| 谓词与通道名 | 8 + 3 + 1 + 1 + 1 = 14 | 2³ 真值表（只有三者皆 `'true'` 为真，通道名随之为 `['dingtalk_work_notification']` 或 `[]`）；任一开关为 `'TRUE'` ⇒ 谓词假、通道空；`TASKS_ENABLED` 不在谓词内（三开关开、主开关缺省或 `'false'` ⇒ 真）；常量字面量 `'dingtalk_work_notification'` 与返回值恰一项且等于常量；默认参数 |
| interval | 1 + 19 + 1 + 1 = 22 | 常量 60000 / 5000 / 7200000（= `TASK_REMINDER_SCAN_WINDOW_MS`）与序关系；19 行解析表（unset、`''`、空白、字母、负数、小数、指数、十六进制、带符号、带单位、超出安全整数 ⇒ 60000；`'0'`、`'4999'`、`'5000'` ⇒ 5000；`' 30000 '` ⇒ 30000；`'60000'` ⇒ 60000；`'7200000'` ⇒ W；`'7200001'`、`'86400000'` ⇒ W）；开关与 interval 互不影响；默认参数（`'30000'` ⇒ 30000、`'soon'` ⇒ 60000） |

静态展开数 2 + 30 + 14 + 22 = **68**；verbose 收集并通过 68。

### S0.4 命令与结果

所有命令在 `packages/core-backend` 下（`node --test` 与扫描在仓库根 / 工件目录），`PATH` 前置 Node 20.20.2，`DATABASE_URL` 未设。全部在 S0 代码提交 `aad99fa10a` 的树上。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | **0 errors** |
| 新测试文件的类型 | `./node_modules/.bin/tsc --noEmit --esModuleInterop --target ES2022 --module commonjs --moduleResolution node --skipLibCheck --resolveJsonModule --types node,vitest/globals tests/unit/task-notification-flags.test.ts`（包内 `tsconfig.json` 不含 `tests/**`；用 CLI 等价参数，不建临时配置文件） | 0 errors |
| 新文件单独 | `vitest run --config vitest.config.ts tests/unit/task-notification-flags.test.ts` | 1 file，**68 passed** |
| 任务线全部单测 + payload 台账守卫 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/approval-feature-payload-flag-ledger.test.ts` | **30 files，1085 passed，0 failed**。逐文件：approval-feature-payload-flag-ledger 8、task-access 200、task-advisory-locks 5、task-ci-coverage-enumeration 4、task-comments 16、task-completion 53、task-create 12、task-dates 68、task-deletion 9、task-edit 137、task-gate19-identities 9、task-groups 27、task-ids-runtime 8、task-ids 53、task-list-access 6、task-lists 87、task-lock-keys 9、task-membership 31、task-notification-flags 68、task-notifications 24、task-pagination 26、task-pure-no-io 5、task-realtime 9、task-records-guards 34、task-reminders 65、task-settings 36、task-tree 46、tasks-auth-ci-wiring 2、tasks-feature-flag 8、tasks-route-errors 20（该文件的 `error: tasks route failed` 日志是其用例故意注入的错误，不是失败） |
| manifest 测试 | `node --test scripts/ops/global-history-flag-manifest.test.mjs` | **35/35** |
| `verify:global-history-flag-manifest:test` 三件 | `node --test scripts/ops/global-history-flag-manifest.test.mjs scripts/ops/multitable-global-history-flag-status.test.mjs scripts/ops/multitable-recovery-schema-containment.test.mjs` | 98/98 |
| 全量单测（一遍） | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **4 files failed / 1078 passed / 172 skipped（1255）；43 tests failed / 18606 passed / 1712 skipped（20362）；2 个 unhandled error；183 s**。失败的 4 个文件全部是 `tests/unit/multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}.test.ts`（timemachine 线的本地归档 / 托管存储测试）；错误是 OS 临时目录 `…/T/tm-restore-owned-*` 下的 `EEXIST`（`src/services/StorageService.ts:298` `uploadByKey`）与 vitest worker 的 `onTaskUpdate` RPC 超时；这 4 个文件不引用 S0 的任何符号（grep `task-notification-flags` / `TASK_NOTIFICATION_CHANNEL_DINGTALK` / `TaskNotificationChannel` / `global-history-flag-manifest` 为零）。复核：4 文件在本工作树单独重跑 **4 files / 43 failed / 48 passed**；在未改动的基座 `00ddafad23` 上（临时 detached worktree，跑完即 `git worktree remove`，本工作树未 checkout）同样 **4 files / 43 failed / 48 passed**。结论：基座既有、与 S0 无关，归 timemachine 线，不在本片修。其余文件无失败（任务线 30 个文件的逐文件计数见上一行）。日志在私有工件目录 |
| 源码 token 普查（manifest 测试的发现口径） | `grep -rhoE 'TASKS_[A-Z_0-9]+' packages/core-backend/src --include='*.ts' \| sort \| uniq -c` | `TASKS_ENABLED` ×5、`TASKS_SCHEDULER_ENABLED` ×1、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` ×1、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` ×1（都已登记）、`TASKS_SCHEDULER_INTERVAL_MS` ×3（不以 `_ENABLED` 结尾，不在发现范围；见 S0.6 第 3 条） |
| 裁决包字面扫描 | 字面扫描器 v1 对 `task-notification-flags.ts`、`task-notifications.ts`、`task-notification-flags.test.ts`、`global-history-flag-manifest.mjs`、设计 MD、本文件 | 全部退出 0 |

### S0.5 变异

每个 mutant：`cp` 备份 → 改一处（脚本先断言该文本在文件里恰一次）→ 跑对应测试 → `cp` 恢复 → `cmp` 逐字节相同。驱动脚本在私有工件目录（不入库）；13 次恢复全部 `cmp` 相同，驱动退出 0，恢复后 `git diff --stat` 与变异前相同。「unit」= `vitest run tests/unit/task-notification-flags.test.ts`；「manifest」= `node --test scripts/ops/global-history-flag-manifest.test.mjs`。

| id | mutant（生产码 / manifest） | 跑 | 结果 |
|---|---|---|---|
| 正控 | 未变异 | unit / manifest | 68 passed / 35 passed |
| M1 | `isTasksSchedulerEnabled`：`=== 'true'` → `!== undefined`（任何已设值都读作开） | unit | **8 failed** / 60 passed |
| M2 | `isTaskNotificationDeliveryWorkerEnabled`：改为 `String(…).trim().toLowerCase() === 'true'` | unit | **5 failed** / 63 passed |
| M3 | `isTaskDingTalkWorkNotificationEnabled`：加 `\|\| … === '1'` | unit | **1 failed** / 67 passed |
| M4 | `isTaskNotificationPipelineEnabled`：去掉钉钉通道合取 | unit | **3 failed** / 65 passed |
| M5 | `resolveTaskDeliveryChannelNames`：不看谓词恒返回钉钉通道 | unit | **13 failed** / 55 passed |
| M6 | `TASK_SCHEDULER_INTERVAL_DEFAULT_MS` 60000 → 30000 | unit | **16 failed** / 52 passed |
| M7 | `TASK_SCHEDULER_INTERVAL_MIN_MS` 5000 → 1000 | unit | **3 failed** / 65 passed |
| M8 | 去掉上界夹取（`Math.min(…, MAX)`） | unit | **2 failed** / 66 passed |
| M9 | 解析正则 `^[0-9]+$` → `^-?[0-9]+$` | unit | **1 failed** / 67 passed |
| M10 | `isTasksSchedulerEnabled` 的默认参数 `process.env` → `{ TASKS_SCHEDULER_ENABLED: 'true' }` | unit | **2 failed** / 66 passed |
| N1 | 删掉 manifest 的 `TASKS_SCHEDULER_ENABLED` 整条 | manifest | **1 failed** / 34 passed（completeness：源码有该 token 而 manifest 没有） |
| N2 | 源码读点改名为 `TASKS_NOTIFICATION_DINGTALK_ENABLED`（manifest 不变） | manifest | **1 failed** / 34 passed（completeness：源码出现未登记 token；同一断言随后也会报 manifest 的 phantom 键） |
| N3 | 给 `TASKS_SCHEDULER_ENABLED` 条目加一条 `requires` 规则 | manifest | **1 failed** / 34 passed（rule id 集合钉死的 mutation guard；这就是设计 §9.2 不设 `rules` 的原因之一） |

设计 §9.2 的两条负控（删条目 ⇒ 红；删读点 ⇒ phantom 红）对应 N1、N2。

### S0.6 偏差与说明

1. **S0 文件数 4 而非 3**（设计 §14 S0「文件数 3」）：`resolveTaskDeliveryChannelNames` 需要 `TASK_NOTIFICATION_CHANNEL_DINGTALK`，设计 §3.4 把该常量放在 `src/tasks/task-notifications.ts`（S1 追加）。S0 先把这一个常量与类型加进该模块（§14.0 允许 S0 / S1 动任务 D 的这两个纯函数模块），S1 的其余追加不变。门 20 harness 只调用函数导出，字符串常量不受影响；`task-notifications.test.ts` 24/24 不变。设计 §14 S0 的原文未改，以本条为准。
2. **interval 解析器的取值细节**（设计只写「默认 60000，夹在 [5000, W]」）：接受的字面是去首尾空白后的纯数字串且为安全整数（与 `services/elearning-audience-resolver.ts` 的数值 env 解析同一口径），其余（负数、小数、指数、带符号、带单位、超出安全整数）取默认；`'0'` 按字面夹到 5000，不另设「0 = 关」语义。S5 的调度器构造函数对收到的 `intervalMs` 再做一次同样的夹取并在超出 W 时 warn（设计 §6.2）；经本解析器得到的值已在范围内，所以那条 warn 只对直接传参的调用方生效。
3. **`TASKS_SCHEDULER_INTERVAL_MS` 未登记 manifest**：按设计 §9.1（D3：数值旋钮不是开关；manifest 测试只发现 `_ENABLED` 结尾的 token）。`AGENTS.md:68` 写「新增 env flag 必须登记」，而仓库里既有的数值旋钮（`DINGTALK_TODO_MIRROR_INTERVAL_MS`、`ELEARNING_AUDIENCE_SCAN_TIMEOUT_MS`）都以 `type: 'numeric'` 登记。S0 按设计与任务书只登记三个开关，三个开关的 `purpose` 写明了旋钮的默认值与夹取范围；**待裁**：是否在 S5（调度器真正读它时）补一条 `numeric` 条目。
4. **manifest `purpose` 描述的是 PR-3b 落地后的行为**（调度器、worker、通道在 S4–S6 才出现）：S0 时除本模块外没有代码读这三个 flag。S7 收口时对照最终代码重核三段 `purpose`（PR-3a 对 `TASKS_ENABLED` 条目的做法相同）。
5. **会话 feature payload 不加键**（设计 §9.3）：`routes/auth.ts#buildFeaturePayload` 未动；本基座已含 #6191 的台账守卫，8/8 绿；三个新 flag 不到前端，不需要台账行。
6. 设计入库时的措辞调整没有改取值、切片与门行。

### S0.7 NOT RUN

- `tasks-realdb` lane（`EXPECT_DB=1`，12 个 `task-*.db.test.ts`）与鉴权门 `tests/tasks-auth/tasks-auth-gate.ts`：S0 没有新增或改动真库文件，也没有改动任何被它们覆盖的运行时代码路径（新模块无人 import；`task-notifications.ts` 只加常量；manifest 不在运行时）。S1 起每片跑。
- `apps/web` 测试：S0 无前端改动。
- 门 18 的另一半负控（删掉 `global-history-flag-manifest.test.mjs` 里的 `TASKS_` 正则扩展 ⇒ 红）属 #6173 已落 main 的守卫，本片未重跑；S0 跑的是设计 §9.2 规定的两条（N1、N2）。
- 真机 / staging / 任何 `TASKS_*` 开关的打开：按设计不做。
- 全量单测里 4 个 timemachine 恢复测试文件的既有失败（S0.4）：不在本片处理，归 timemachine 线。

### S0.8 给 S1（纯函数）的注记

- `src/tasks/task-notifications.ts` 已有 `TASK_NOTIFICATION_CHANNEL_DINGTALK` / `TaskNotificationChannel`；S1 追加 `TASK_NOTIFICATION_SOURCE_TYPES` 与四个 `plan*` 时直接复用，不再定义第二个通道名常量；`plan*` 产出行的 `channel` 字段用 `TaskNotificationChannel` 类型。
- `resolveTaskDeliveryChannelNames` 返回 `TaskNotificationChannel[]`；S2 的 producer 按它是否为空决定是否发查询（设计 §3.1：空 ⇒ 不发任何查询、不写行）。
- `TASK_SCHEDULER_INTERVAL_MAX_MS` 直接等于 `TASK_REMINDER_SCAN_WINDOW_MS`；S1 在 `task-reminders.ts` 追加扫描条件与页大小常量时不要改 W 的值（设计 §6.2 的 `W ≥ interval` 靠这个等式）。
- 门 20 harness 对 `src/tasks/` 的每个函数导出用 `'x'`（executor 形参用会抛的 stub）调用：S1 的新函数（`computeDailyDigestSendAt`、`isDailyDigestDue`、`isAllowedTaskDingTalkBaseUrl`、`classifyTaskDeliveryOutcome` 等）收到 `'x'` 时要么抛 `TypeError`、要么返回否定结果，不得碰 I/O；字符串 / 数组常量导出不会被调用。
- S1 的新模块不 import `db/`、`pg`、`crypto`，不新增 `Intl.DateTimeFormat` 调用点（hourcycle 守卫，设计 §3.4 / D12）。
- `packages/core-backend/src` 下（含注释）不得出现除三个已登记名字之外的 `TASKS_…_ENABLED` token，否则 manifest 测试要求登记；`TASKS_SCHEDULER_INTERVAL_MS` 可以出现。
- S1 之后、S2 之前：按设计 §14.0 等 PR-3a 的 S6–S9 提交，`git merge-tree --write-tree` 查冲突后重叠，并重跑本节全部命令与 `tasks-realdb` 清单。

## S1 纯函数

### S1.1 基座

| 项 | 值 |
|---|---|
| 起点（S0 的文档提交） | `826e283631` |
| S1 首轮提交 | `e9b0164cb2`（四个纯函数模块）、`843f31f801`（四个单测文件）、`8bf76245d1`（`TASKS_SCHEDULER_INTERVAL_MS` 数值 manifest 条目与守护测试的发现集） |
| S1 复审修正提交（本轮） | `0c1e943803`（S1.2 的六处修正与对应单测） |
| S1 文档提交 | 本节所在提交 |
| PR-3a 基座 | 未变：`claude/tasks-m4-pr3a` 的 tip 仍是 `00ddafad23`（S0–S5 加当时 main 的合并），`git rev-list --count HEAD..claude/tasks-m4-pr3a` = 0；PR-3a 的 S6–S9 尚未提交 |
| 设计 §14.0 的 S1 入口条件（只加新文件与任务 D 的两个纯函数模块） | 满足；另有一条数值 manifest 登记（S1.7 第 1 条） |

S1 的新代码全在 `src/tasks/`，没有任何服务 import 它们（S2 起才接线）；运行时行为零变化。本节所有数字都在 `0c1e943803` 的树上重新跑出，没有沿用首轮草稿里的数字。

### S1.2 恢复与复审

上表三条提交之后，工作树里还有本节的未提交草稿与 `task-notification-text.ts` 的两行注释改动。本轮把三条提交与草稿当作草案逐条对照设计与源码复审：保留正确部分，修正下表六处（`0c1e943803`），草稿里的计数、变异表与偏差条目全部按最终树重做；那两行注释在修正 C 之后已不成立（它写的是「调用方传全部行」），被替换。草稿原文不入库。

| # | 首轮的问题 | 依据 | 修正 |
|---|---|---|---|
| A | 截止时间只接受 `HH:MM`。`tasks.due_time` 是 `time` 列，写路径存规范形 `HH:MM:SS`（`task-edit.ts:144` 把 `HH:MM` 补成 `:00`），服务读 `due_time::text`（`task-records.ts:268`、`:297`）；S4 渲染任何定时任务的提醒或汇总条目都会抛 `TypeError` | `task-dates.ts:191`（域文法 `HH:MM` 或 `HH:MM:SS`） | 两种形都接受；秒为 `00` 时显示 `HH:MM`，否则按存储原样显示（S1.7 第 10 条） |
| B | 分类器在栅栏前把 `{ ok: true }` 判成 `sent`、把 `outcomeUnknown` 判成 `outcome_unknown`：栅栏前没有发生过发送，账本会记下没有发生的事（`sent` 却零次发送；或要求人工核对一条从未发出的行） | 设计 §7.2：栅栏之前各环节只判 skip / retryable / failed；`outcome_unknown` 的含义是「发送可能已经发生」 | 栅栏前只产出 `skipped` / `retrying` / `failed`，其余（含 `{ ok: true }`、`outcomeUnknown`、抛错、畸形返回）走有界重试；栅栏后的判定逐格不变 |
| C | 汇总文案按传入的条目数计算「另有 N 项」，等于要求 S4 取回全部行；与设计 §7.4（取 `TASK_DIGEST_MAX_ITEMS + 1` 行、文案输入是「条目列表、总数」）不一致 | 设计 §7.4 表、§11.5 | 新增必填 `totalCount`（安全整数且 ≥ 条目数），溢出行 = `totalCount − 显示行数`；§11.5「MAX+3 ⇒ 另有 3 项」按 S4 的实际形状钉住：传 MAX+1 行、`totalCount = MAX+3` |
| D | 首轮给任务 D 的私有日期校验 `assertValidCalendarDateString` 加了 `typeof` 守卫并改了消息前缀：`computeDefaultRemindAt` 对非字符串 `dueDate` 的错误类从 `RangeError` 变成 `TypeError`，「不存在的日期」一条的消息文本也变了；草稿「既有导出逐字节不变」的说法不成立。另外 `computeDailyDigestSendAt('x')` 抛 `RangeError`，与 S0.8 的「收到 `'x'` 抛 `TypeError` 或返回否定结果」不符 | 首轮 diff | helper 去掉 `typeof` 守卫，只加两个带默认值的形参（函数名、参数名），默认实参下两条消息与原文逐字节相同（新单测按原消息钉住）；`computeDailyDigestSendAt` 自己先查形状：不是 `YYYY-MM-DD` 字符串 ⇒ `TypeError`；形状对但日期不存在、或时区非法 ⇒ `RangeError`（与 `computeDefaultRemindAt` 同类） |
| E | 提醒文案输入的 `timeZone` 声明为 `string`；无日期任务的 `time_zone` 可以是 NULL（`tasks_time_zone_when_dated_chk`） | P0-A 迁移的 `tasks` 表 | 类型改为 `string \| null`；有截止日期时仍要求字符串（该 CHECK 保证有） |
| F | 键集游标只收 `Date`。JS `Date` 只到毫秒，`timestamptz` 到微秒：对微秒值，截断后的游标排在它所来自的那一行之前，下一页会再次读到这一行；同一毫秒内有满页（≥ 500）这样的行时，扫描不再前进。应用写入的 `remind_at` 都是毫秒 ISO 文本（`task-edit.ts:75` 的 `[own-30]` 文法到 `.fff`，创建路径 `task-records.ts:131-140` 与 PATCH 路径 `task-patch.ts:145` 都经 `isoOrNull` 绑定 `toISOString()`），所以今天只有 SQL 直写的行会触发，例如 S5 计划中的「同一时刻 501 行」格若用 `now()` 播种 | 上列源码 | 游标另收数据库自己的 `timestamptz` 文本（`tasks.remind_at::text`）；形状正则挡掉 PostgreSQL 也会接受的 `'yesterday'` / `'now'` / `'infinity'` 之类的词；S5 的用法见 S1.9 |

### S1.3 交付内容（最终）

路径省略前缀 `packages/core-backend/`。每个未裁取值都带 `ASSUMPTION(task-m4): [...]`；本片在设计 §12 的自选标签之后新增 `[own-3b-24]`、`[own-3b-25]`（S1.7 第 11 条）。

| 文件（相对 S0 文档提交 `826e283631`） | 内容 |
|---|---|
| `src/tasks/task-reminders.ts`（+169 / −4） | 常量 `TASK_REMINDER_SCAN_BATCH = 500`、`TASK_REMINDER_FLOOR_EVENT_TYPES = ['created', 'remind_changed']`、`TASK_REMINDER_SCAN_CURSOR_START`（`('-infinity', '')`，冻结）、`TASK_REMINDER_SCAN_ORDER_BY`（`tasks.remind_at ASC, tasks.id ASC`）、`TASK_DAILY_DIGEST_TIME_OF_DAY = '09:00'`；`buildTaskReminderScanCondition({ nowParam, windowMsParam, afterAtParam, afterIdParam })`（`$1` now、`$2` 窗口毫秒、`$3` / `$4` 键集游标；`remind_at` 非空、`≤ now`、`> now − W`、`status = 'open'`、`deleted_at IS NULL`、`(remind_at, id) > ($3, $4)`；跨 org，无 org 子句；游标的 `remind_at` 一半接受 `'-infinity'`、有效 `Date` 或 timestamptz 文本；其余入参校验失败抛 `TypeError`）；`computeDailyDigestSendAt(localDate, timeZone)`（经 `computeDateReminderOccurrence` 的 floating 路径，不新增 Intl 调用点）、`resolveDailyDigestOccurrence(now, timeZone)` ⇒ `{ localDate, sendAt, due }`、`isDailyDigestDue(now, timeZone)`（`isDateReminderDue(sendAt, now, W, 0)`）。私有 `assertValidCalendarDateString` 多两个带默认值的形参；`isInDailyDigest` 上方一行既有文档注释改为转述（S1.7 第 9 条） |
| `src/tasks/task-notifications.ts`（+364） | `TASK_NOTIFICATION_CHANNELS`（`[TASK_NOTIFICATION_CHANNEL_DINGTALK]`，复用 S0 的常量与类型）、`TASK_NOTIFICATION_SOURCE_TYPES`（四族）、`TASK_NOTIFIABLE_LIST_EVENTS = ['archived']`、类型 `TaskNotificationPayload` / `TaskNotificationDeliveryPlan`；四个规划器 `planTaskEventDeliveries` / `planTaskReminderDeliveries` / `planTaskDailyDigestDelivery` / `planTaskListEventDeliveries`（每个收件人 × 每个通道一行，`source_key` 只经任务 D 的四个构造器，payload 只有 id 与枚举，按 `source_key` 去重，事件 / 通道 / 角色 / id 不合法抛 `TypeError`，通道为空 ⇒ `[]`）；`parseTaskNotificationPayload(raw)`（规划器的逆：非对象 ⇒ `payload_invalid`，缺 / 未知 `kind` ⇒ `unknown_kind`，键集必须恰好相等，`remindAt` 必须是规范 ISO，`date` 形状与 `timeZone` 都校验；返回新对象） |
| `src/tasks/task-notification-text.ts`（新，254 行） | `TASK_DELIVERY_TITLES`（任务动态 / 任务提醒 / 今日任务 / 清单动态）、`TASK_DIGEST_MAX_ITEMS = 20`、`TASK_DELIVERY_TAG_PREFIX = '编号 '`；`sanitizeTaskTextForMarkdown`（`[ ] ( ) < > ! # * _ ~ \`` ⇒ 全角，所有 ASCII 控制字符含 CR / LF ⇒ 空格）；`renderTaskDeliveryTag`（outbox 行 id 前 8 位十六进制，小写；不以 8 位十六进制开头即抛）；`renderTaskEventMessage` / `renderTaskReminderMessage` / `renderTaskDailyDigestMessage({ items, totalCount, deliveryId })` / `renderTaskListEventMessage`（段落以空行连接，末行恒为标签；用户文本与时区名一律转义；截止时间接受 `HH:MM` / `HH:MM:SS`；空汇总与不合法 `totalCount` 抛 `TypeError`） |
| `src/tasks/task-delivery-protocol.ts`（新，275 行） | 闭集 `TASK_DELIVERY_OUTCOMES`（5）/ `TASK_DELIVERY_STATUSES`（7）；类型 `TaskDeliveryChannelResult`；常量：批 50（`[1, 200]`）、`maxAttempts` 5、`TASK_DINGTALK_REQUEST_TIMEOUT_MS` 10 s、`TASK_DELIVERY_PREPARE_BUDGET_MS` 15 s、栅栏余量 5 s、`TASK_DELIVERY_SEND_LEASE_MS` 15 s（= 超时 + 余量）、`TASK_DELIVERY_ROW_RESERVE_MS` 30 s（= prepare + 超时 + 余量）、批租约 60 s（夹 `[60 s, 600 s]`）、`TASK_DELIVERY_TICK_BUDGET_MS` 40 s、`TASK_DELIVERY_DEFAULTS`（冻结）、`TASK_DELIVERY_PRIORITY_SOURCE_TYPES`、`TASK_EVENT_NOTIFICATION_MAX_AGE_MS` 24 h、`TASK_DELIVERY_BACKOFF_LADDER_MS`、`TASK_DINGTALK_BASE_HOST`；函数 `computeTaskDeliveryBackoffMs`、`classifyTaskDeliveryOutcome({ result, attemptCount, maxAttempts, fenced })`、`orderClaimedDeliveries`、`isTaskEventNotificationStale`、`isAllowedTaskDingTalkBaseUrl`、`clampDeliveryBatchSize`、`clampDeliveryLeaseMs` |
| `tests/unit/task-reminders.test.ts`（+232，29 格） | S1.4 |
| `tests/unit/task-notifications.test.ts`（+319，27 格） | S1.4 |
| `tests/unit/task-notification-text.test.ts`（新，274 行，32 格） | S1.4 |
| `tests/unit/task-delivery-protocol.test.ts`（新，383 行，36 格） | S1.4 |
| `scripts/ops/global-history-flag-manifest.mjs`（+12） | `TASKS_SCHEDULER_INTERVAL_MS`：`type: 'numeric'`，照既有数值旋钮的形；`activationValue` 写默认 60000 与夹取 `[5000, 7200000]`；`dependsOn: ['TASKS_SCHEDULER_ENABLED']`；danger low；无 `rules`；`source` 指向 `resolveTaskSchedulerIntervalMs`（S1.7 第 1 条） |
| `scripts/ops/global-history-flag-manifest.test.mjs`（+26 / −1） | 任务线发现集加按名字列出的 `TASKS_NON_BOOLEAN_FLAGS`（与既有 `ELEARNING_NON_BOOLEAN_FLAGS` 同形，`_ENABLED` 规则不变）；一条规格测试钉住该条目的 type / source / 默认值 / 夹取 / `dependsOn` / 无 `rules`，并对读点文件断言导出名、env 键与三个常量。钉死的 rule id 集合不受影响 |

公共导出的函数共 22 个（任务 D 两个模块原有 15 个之外）：`task-reminders` 4、`task-notifications` 5、`task-notification-text` 6、`task-delivery-protocol` 7。不碰：`src/services/*`（S0 的 flag 模块除外，未改）、`src/index.ts`、`routes/auth.ts`、任何 `task-*.db.test.ts` / `vitest.config.ts` 的 exclude / `.github/workflows/tasks-realdb.yml`、`task-access.ts` / `task-list-access.ts` / `task-membership.ts`（分属 S4 / S2 / S3）、设计 MD。

### S1.4 单测（124 格）

| 文件 | 格数 | 内容 |
|---|---|---|
| `task-reminders.test.ts`（追加） | 29 | 常量 5（页大小、floor 事件类型、`TASK_SCHEDULER_INTERVAL_MAX_MS === W === 7200000`、起始游标与冻结、ORDER BY）；扫描条件 9（全文 SQL 钉死与参数顺序；后续页游标参数；跨 org：无 `org_id`、无 `$5`、无 `LIMIT`；上下界与存活条款；非对象抛；非 Date / 无效 now 抛；非 int4 窗口抛而 `2^31−1` 接受；数据库文本游标五种形原样透传；`'yesterday'` / `'now'` / `'infinity'` / 空串 / 空白 / 只有日期 / 无时区偏移 / `'x'` / 数字、无效 `Date`、非字符串 id 都抛）；`computeDailyDigestSendAt` 7（`'09:00'`；上海 / UTC / 纽约三时区；UTC+14 落在前一 UTC 日；纽约回拨日 UTC−5、伦敦拨快日 UTC+1；非字符串、`'x'`（门 20 探针形）、`'2026-3-8'` ⇒ `TypeError`，`'2026-02-30'` ⇒ `RangeError` 且消息带本函数名；`computeDefaultRemindAt` 的两条消息逐字节同原文、非字符串 `dueDate` 仍 `RangeError`；非法时区 `RangeError`）；到点判定 8（`sendAt − 1ms` 假、`sendAt` 真、`sendAt + W − 1ms` 真、`sendAt + W` 假且当地 15:00 假；`resolveDailyDigestOccurrence` 三字段；同一瞬时两时区只有当地 09:xx 的一方到点且各自 `localDate`；当地午夜前后；非 Date `TypeError`、非法时区 `RangeError`） |
| `task-notifications.test.ts`（追加） | 27 | 闭集 3；事件族 6（两收件人的整行 `toEqual` 含 `source_key` 字面、payload 键恰为五个、无通道 / 无收件人 ⇒ `[]`、重复收件人去重、五个可通知事件接受而 `self_completed` / `self_reopened` / `assignee_added` / 未知拒绝、非法通道 / 角色 / 空 id / 非数组 / 非对象抛）；提醒族 5（只给未完成负责人、零负责人 ⇒ `creator`、全部完成 ⇒ `[]`、同一通道两次去重、非法 `remindAt` 等抛）；汇总族 3；清单族 3；解析器 7（四族往返且返回新对象、非对象 ⇒ `payload_invalid`、缺 / 未知 `kind` ⇒ `unknown_kind`、多键 / 缺键 / 错类型 / 闭集外事件、非规范 ISO、日期 / 时区、清单族只认 `archived`） |
| `task-notification-text.test.ts`（新） | 32 | 转义 6（十二字符映射逐字钉死、链接不含 `](` 与换行、控制字符 ⇒ 空格、`#` 与代码围栏失效、普通文本不变且幂等、非字符串抛）；标签 2；标题表 1；事件文案 5（五种事件整条正文钉死且末行为标签、同一事件两行只差标签、完成→重启→完成三行互不相同、标题转义后无行以 `#` 开头、各种非法输入抛）；提醒文案 7（定时 / 全天正文钉死；存储形 `09:30:00` 显示 `09:30` 且与 `09:30` 输入同正文、`09:30:15` 原样；无截止无截止行；无日期任务 `timeZone: null` 不抛；时区名转义；`9:30` / `930` / `09:30:0` / `09:30:00.5` / `09:30:00:00` / 数字、有日期而无时区、非对象都抛）；汇总文案 7（`TASK_DIGEST_MAX_ITEMS === 20`；两条正文钉死且存储形时间显示 `HH:MM`；传 MAX+1 行、`totalCount = MAX+3` ⇒ 前 20 行 + `另有 3 项` 且不含第 21 行；溢出按 `totalCount` 而不是传入行数（1 行 / 共 5 ⇒ `另有 4 项`）；恰 MAX 无 `另有`、MAX+1 ⇒ `另有 1 项`；条目标题转义；空汇总、`totalCount` 缺失 / 小于条目数 / 小数 / NaN / 字符串 / 负数、非法条目、非对象都抛）；清单文案 3；四族共性 1（末行等于本行标签，用户文本里的换行不进正文） |
| `task-delivery-protocol.test.ts`（新） | 36 | 常量 8（各数值、派生关系 `sendLease = timeout + margin`、`reserve = prepare + timeout + margin`、租约下界 = 2 × reserve 且 > reserve、tick 预算 < `TASK_SCHEDULER_INTERVAL_DEFAULT_MS`、`TASK_DELIVERY_DEFAULTS` 整体相等且冻结、优先族 ⊆ 四族、24 h、两个闭集）；退避 2；分类 11（栅栏后 `ok` ⇒ `sent`；栅栏前 `ok` ⇒ 有界重试、永不 `sent`；栅栏后 `outcomeUnknown` ⇒ `outcome_unknown`；栅栏前 `outcomeUnknown`（不论其余字段）⇒ 有界重试；不变量：对 17 种结果 × 5 个 `attemptCount`，栅栏前 ∈ {`skipped`, `retrying`, `failed`}、栅栏后 ∈ {`sent`, `retrying`, `failed`, `outcome_unknown`}；`skip` 栅栏前 `skipped`、栅栏后 `outcome_unknown`；`retryable` 在 `attemptCount < maxAttempts` 时 `retrying` 否则 `failed`（两侧、`maxAttempts = 3` 另一组）；不可重试首个即 `failed`；栅栏后十种无法归类 ⇒ `outcome_unknown`；栅栏前九种无法归类 ⇒ 有界重试；非法入参抛）；排序 4；新鲜度 4（25 h / 23 h、恰 24 h 新鲜而 24 h + 1 ms 陈旧、未来行、非 Date 抛）；出站地址 4（常量、8 个接受、21 个拒绝、6 种非字符串不抛且为 false）；夹取 3 |

静态展开数（`it(` 计数，无 `it.each`）29 + 27 + 32 + 36 = **124**；verbose 收集同为 124（四个文件合计 94 / 51 / 32 / 36 = 213，其中既有 65 + 24）。

### S1.5 命令与结果

所有命令在 `packages/core-backend` 下（`node --test` 与扫描在仓库根 / 工件目录），`PATH` 前置 Node 20.20.2，`DATABASE_URL` 未设，树为 `0c1e943803`。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | **0 errors** |
| 四个测试文件的类型 | 与 S0.4 相同的 CLI 等价参数，逐个对四个 S1 测试文件 | 4 × 0 errors |
| 四个 S1 文件 + 门 20 harness | `vitest run --config vitest.config.ts tests/unit/task-{reminders,notifications,notification-text,delivery-protocol}.test.ts tests/unit/task-pure-no-io.test.ts` | 5 files，**218 passed** |
| 任务线全部单测 + payload 台账守卫 + hourcycle 守卫 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/approval-feature-payload-flag-ledger.test.ts tests/unit/source-files-hourcycle-parsing-guard.test.ts` | **33 files，1225 passed，0 failed**。逐文件：approval-feature-payload-flag-ledger 8、source-files-hourcycle-parsing-guard 16、task-access 200、task-advisory-locks 5、task-ci-coverage-enumeration 4、task-comments 16、task-completion 53、task-create 12、task-dates 68、task-deletion 9、task-delivery-protocol 36、task-edit 137、task-gate19-identities 9、task-groups 27、task-ids 53、task-ids-runtime 8、task-list-access 6、task-lists 87、task-lock-keys 9、task-membership 31、task-notification-flags 68、task-notification-text 32、task-notifications 51、task-pagination 26、task-pure-no-io 5、task-realtime 9、task-records-guards 34、task-reminders 94、task-settings 36、task-tree 46、tasks-auth-ci-wiring 2、tasks-feature-flag 8、tasks-route-errors 20（其 `error: tasks route failed` 日志是用例故意注入的错误） |
| 门 20 行为门 | `task-pure-no-io.test.ts` 5/5；另用 harness 同形的探针脚本（私有工件目录，`tsx` 运行）逐个列出四个模块的函数导出 | **37 个函数导出（22 个为 S1 新增）全部被 `'x'` 探针调用，无一到达 DB stub**。新增的 22 个里：17 个抛 `TypeError`（含 `computeDailyDigestSendAt`），5 个返回否定 / 缺省结果（`parseTaskNotificationPayload` ⇒ `payload_invalid`、`isAllowedTaskDingTalkBaseUrl` ⇒ `false`、两个 clamp ⇒ 缺省值、`sanitizeTaskTextForMarkdown('x')` ⇒ `'x'`，即普通文本原样）。harness 确实覆盖新代码：变异 G1–G3（S1.6）在两个新文件与一个追加导出里各注入一次数据库调用，harness 各自红，失败断言的 `reached` 列表恰为被注入的那个导出（日志在私有工件目录） |
| 门 20 静态 (A)(B) | 锁 §12 门 20 的两条 `grep -R -E` 对 `src/tasks` | 零命中（macOS grep exit 1）。正控：同一 (A) ERE 命中 `src/auth/session-registry.ts:2`，(B) ERE 命中 `src/services/task-records.ts:56` |
| 门 15 | `grep -niE "attendance\|elearning\|e-learning\|dingtalk-todo\|unscheduled"` 对四个模块中 S1 新增的行 | 零命中；`task-reminders.ts:205-209` 的 4 行是任务 D 既有的构造器注记（S1.7 第 9 条） |
| 无新增 Intl / db / pg / crypto | `grep -nE "from 'pg'\|crypto\|Intl\.DateTimeFormat\|from '\.\./db"` 对四个模块；hourcycle 守卫 16/16 | 零命中 |
| manifest 测试 | `node --test scripts/ops/global-history-flag-manifest.test.mjs` | **36/36**（S0 为 35；新增规格测试 1 条） |
| `verify:global-history-flag-manifest:test` 三件 | 同 S0.4 | **99/99** |
| 源码 token 普查 | 同 S0.4 | 与 S0 相同：`TASKS_ENABLED` ×5、三个开关各 ×1、`TASKS_SCHEDULER_INTERVAL_MS` ×3（现已登记） |
| 裁决包字面扫描 | 字面扫描器 v1 对十个改动文件、设计 MD 与本文件 | 全部退出 0 |
| values-free | 对十个改动文件与本文件 `grep -nE` 查 IPv4 字面、mDNS 主机名后缀与本机机器名（正则不写进本文，免得自我命中） | 仅 `task-delivery-protocol.test.ts:331` 出站地址拒绝表里的回环地址字面；无主机名、无局域网地址 |
| 全量单测（一遍） | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **5 files failed / 1080 passed / 172 skipped（1257）；44 tests failed / 18730 passed / 1712 skipped（20486）；146 s**。失败的 44 格：四个 `tests/unit/multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}.test.ts` 共 43 格（22 / 1 / 4 / 16；与 S0.4 的 43 格同一批 timemachine 本地归档 / 托管存储测试，同样的 OS 临时目录 `EEXIST`），加 **第 5 个文件** `tests/unit/attendance-admin-plugin-lib-dist-layout-boot.test.ts` 1 格。后者不是本片引入：错误为 `ELOOP: too many symbolic links` 于 `plugins/plugin-attendance/node_modules/node_modules/…/zod`。本工作树的 `plugins/plugin-attendance/node_modules` 是指向规范检出同名目录的链接（lstat mtime 2026-10-07 09:51:13），而规范检出的 `plugins/plugin-attendance/node_modules/` 里有一个指向该目录自身的 `node_modules` 链接（lstat mtime 2026-10-07 09:01:59，早于本分支 S0 的第一个提交），该测试把 `node_modules` 祖先链复制进临时 app 布局时遇到环。单独重跑同样红（同一错误）；该测试不引用任何任务线符号（grep 零命中）；S1 没有改 `plugins/` 下任何文件（`git diff --stat 826e283631 HEAD -- plugins/` 为空）。S0 的全量运行里这个文件以另一种形式出错：vitest worker 的 `onTaskUpdate` RPC 超时被记为源自该文件的 unhandled error（S0.4 的「2 个 unhandled error」之一），当时未计入失败文件。**所以任务书「只有 multitable-recovery-* 失败」这一预期本轮不成立**：失败集是那四个文件加这一个由本地环境（规范检出里一个自指链接）导致的文件。修法是在规范检出里删掉 `plugins/plugin-attendance/node_modules/node_modules` 这一个链接；它在规范检出里，本片不碰其他工作树，留给 owner。日志在私有工件目录 |

### S1.6 变异

驱动脚本与表在私有工件目录（不入库）。每个 mutant：先断言目标文件与 `HEAD` 的 blob 逐字节相同 → `cp` 备份 → 改动（每个 needle 必须在文件里恰好出现一次）→ 跑所属测试 → `cp` 恢复 → 断言 sha256 再次等于 `HEAD` 的 blob 且 `cmp` 与备份相同；结束时目标文件 `git status` 为空。从不使用 `git checkout` / `reset` / `stash` / `clean`。首轮草稿的 44 个 mutant 只把恢复后的文件与备份比较（备份本身是否干净没有证明），而且其中 P1 / P2 的 needle 在修正 B 之后已不存在；本轮全部重跑，旧 needle 按最终代码更新，不删。

**62 个 mutant 全部变红；62 次恢复全部等于 `HEAD`；六个正控全绿（四个单测文件 94 / 51 / 32 / 36、harness 5、manifest 36）；结束时目标文件干净；驱动退出 0。** 「红 / 余」是该 mutant 下所属文件的失败格数与通过格数。

| id | mutant | 跑 | 红 / 余 |
|---|---|---|---|
| R1 | 扫描去掉窗口下界（`> now − W`） | reminders | 2 / 92 |
| R2 | 扫描去掉键集游标（修订前的固定 LIMIT 形） | reminders | 2 / 92 |
| R3 | 扫描去掉 `deleted_at IS NULL` | reminders | 2 / 92 |
| R4 | 页大小 500 → 100 | reminders | 1 / 93 |
| R7 | 扫描 ORDER BY 反向 | reminders | 1 / 93 |
| R8 | floor 事件类型丢掉 `remind_changed` | reminders | 1 / 93 |
| R10 | 上界 `<= now` 改成 `< now` | reminders | 2 / 92 |
| F1 | 游标接受任意字符串（`'yesterday'` 会到 PostgreSQL） | reminders | 1 / 93 |
| F2 | 游标拒绝数据库文本（只收 `Date`，截断微秒） | reminders | 1 / 93 |
| R5 | 汇总时刻 09:00 → 08:00 | reminders | 8 / 86 |
| R6 | 汇总到点窗口放宽到 2W | reminders | 1 / 93 |
| R9 | `computeDailyDigestSendAt` 去掉时区校验（静默退化到 UTC） | reminders | 1 / 93 |
| R11 | 汇总当地日期改按 UTC 取 | reminders | 1 / 93 |
| D1 | 私有日期 helper 恢复首轮的 `typeof` 守卫（`computeDefaultRemindAt` 错误类改变） | reminders | 1 / 93 |
| N1 | 事件族 payload 丢掉 `actorId` | notifications | 3 / 48 |
| N2 | 去掉按 `source_key` 去重 | notifications | 2 / 49 |
| N3 | 提醒族零负责人不再记 `creator` | notifications | 1 / 50 |
| N4 | 汇总族角色 `assignee` → `creator` | notifications | 1 / 50 |
| N5 | 清单族接受任意清单事件 | notifications | 1 / 50 |
| N6 | 解析器容忍多余键（用户文本可夹带进 payload） | notifications | 2 / 49 |
| N7 | 解析器接受非规范 ISO `remindAt` | notifications | 1 / 50 |
| N8 | 事件族接受 `self_completed` / 未知事件 | notifications | 1 / 50 |
| N9 | 解析器接受非法汇总时区 | notifications | 1 / 50 |
| T1 | 四族正文去掉末行标签（设计 §11.8 的负控） | text | 17 / 15 |
| T2 | 去掉转义（设计 §11.4 的负控） | text | 9 / 23 |
| T3 | 一个映射项（`[`）失效 | text | 4 / 28 |
| T4 | `TASK_DIGEST_MAX_ITEMS` 20 → 25 | text | 2 / 30 |
| T5 | 标签不再小写 | text | 1 / 31 |
| T6 | `另有 N 项` 阈值差一 | text | 1 / 31 |
| T7 | 空汇总照常渲染 | text | 1 / 31 |
| T8 | `reopened` 句子写成已完成 | text | 1 / 31 |
| A1 | 截止时间回到只收 `HH:MM`（存储形 `HH:MM:SS` 被拒） | text | 2 / 30 |
| A2 | 零秒按存储原样显示（`09:30:00`） | text | 2 / 30 |
| C1 | 溢出行按传入行数而不是 `totalCount` | text | 2 / 30 |
| C2 | `totalCount` 不再校验 | text | 1 / 31 |
| E1 | 无日期任务也要求时区（`time_zone` 为 NULL 时抛） | text | 1 / 31 |
| P1 | 栅栏后无法归类改为重试（重发风险；设计 §11.8 的负控） | protocol | 1 / 35 |
| P2 | 栅栏后 `skip` 记 `skipped` | protocol | 2 / 34 |
| P3 | 栅栏后忽略 `outcomeUnknown` | protocol | 1 / 35 |
| B1 | 栅栏前 `{ ok: true }` 记 `sent`（零次发送） | protocol | 2 / 34 |
| B2 | 栅栏前 `outcomeUnknown` 记 `outcome_unknown` | protocol | 2 / 34 |
| B3 | 栅栏前 `outcomeUnknown` 不再强制重试（`skip` / 不可重试优先） | protocol | 1 / 35 |
| P4 | 重试上界 `<` → `<=`（第六次尝试） | protocol | 4 / 32 |
| P5 | 退避首级 60 s → 30 s | protocol | 1 / 35 |
| P16 | 退避阶梯下标差一 | protocol | 1 / 35 |
| P6 | 排序丢掉优先项 | protocol | 2 / 34 |
| P17 | 排序丢掉 id 次序键 | protocol | 2 / 34 |
| P7 | 新鲜度边界含 24 h（恰 24 h 判陈旧） | protocol | 1 / 35 |
| P8 | 出站地址去掉 scheme 检查（http 放行） | protocol | 1 / 35 |
| P9 | 出站地址接受 `.dingtalk.com` 前的空标签 | protocol | 1 / 35 |
| P10 | 出站后缀去掉前导点（`oapidingtalk.com` 放行） | protocol | 1 / 35 |
| P11 | 出站地址接受 user-info | protocol | 1 / 35 |
| P12 | 租约下界降到 = 每行预留 | protocol | 3 / 33 |
| P13 | 批大小上界 200 → 500 | protocol | 2 / 34 |
| P14 | 单次请求超时 10 s → 20 s（sendLease 与预留随之变） | protocol | 4 / 32 |
| P15 | tick 预算 40 s → 70 s（超过 interval） | protocol | 2 / 34 |
| G1 | 新文件 `task-delivery-protocol.ts`：`isAllowedTaskDingTalkBaseUrl` 查数据库 | harness | 1 / 4 |
| G2 | 新文件 `task-notification-text.ts`：`renderTaskDeliveryTag` 查数据库 | harness | 1 / 4 |
| G3 | 追加导出 `parseTaskNotificationPayload` 查数据库 | harness | 1 / 4 |
| M1 | 删掉 manifest 的 `TASKS_SCHEDULER_INTERVAL_MS` 条目 | manifest | 2 / 34（completeness 的 missing 与规格测试） |
| M2 | 守护测试不再发现这个非布尔旋钮 | manifest | 1 / 35（completeness 的 phantom） |
| M3 | 源码 `TASK_SCHEDULER_INTERVAL_DEFAULT_MS` 60000 → 30000 | manifest | 1 / 35（规格测试对读点文件的断言） |

设计 §11.9 中属于 S1 的三条负控（去掉标签 T1、去掉转义 T2、栅栏后无法归类不再 `outcome_unknown` P1）都在表内；G1–G3 另外证明门 20 harness 对新代码的覆盖是真实的，不只是「没有报错」。

### S1.7 偏差与说明

1. **`TASKS_SCHEDULER_INTERVAL_MS` 登记为 `numeric` 条目（`8bf76245d1`），偏离设计 §9.1 / `[D3]`「它不进 manifest」**。这同时落定 S0.6 第 3 条的待裁项（S0 当时只登记三个开关，并把「是否补数值条目」列为待裁）。理由：`AGENTS.md` 要求每个新增 env 旋钮登记，仓库既有的数值旋钮都以 `type: 'numeric'` 登记。manifest 的发现式核对只认以 `_ENABLED` 结尾的任务 token，条目加入后会被判成 phantom，所以守护测试的任务线发现集加了按名字列出的 `TASKS_NON_BOOLEAN_FLAGS`（与 `ELEARNING_NON_BOOLEAN_FLAGS` 同形），并加一条规格测试；钉死的 rule id 集合不受影响（条目无 `rules`）。设计 §9.2 / §9.5 的「测试文件不改」只对 S0 的三个布尔条目成立，这条登记让它不再成立；条目的 `purpose` 写明了与 `[D3]` 的关系（登记但不是开关；规格测试断言 `isActivated(spec, '60000') === false`）。S7 收口时随设计入库件一并更正 §9.1 / §9.2 / §9.5 / §12 `[D3]` 的措辞。M1–M3 是这条登记的双向负控。
2. **S1 文件数 10 而非 8**（设计 §14 S1「文件数 8」）：多出的两个是第 1 条的 manifest 与其守护测试。
3. **扫描条件的占位符编号**：设计 §6.2 的示例 SQL 把 LIMIT 写成 `$3`、游标写成 `$4` / `$5`；构造器只有四个输入，按本仓构造器「调用方追加的参数从 `params.length + 1` 编号」的惯例输出 `$1` now、`$2` 窗口、`$3` / `$4` 游标，页 LIMIT 由 S5 以 `$5` 追加。语义不变。另导出 `TASK_REMINDER_SCAN_ORDER_BY` 与 `TASK_REMINDER_SCAN_CURSOR_START`，让键集条件与它唯一正确的 ORDER BY、起始游标成对出现（§3.4 未列这两个名字）。
4. **游标的 `remind_at` 一半接受数据库文本**（S1.2 F）：形状为 PostgreSQL 的 ISO 输出（`2026-10-07 11:30:00.123456+00`，偏移可带分、秒）或 ISO-8601 瞬时（`…T…Z`），不带偏移的、只有日期的与 PostgreSQL 的特殊词都拒绝。`Date` 仍接受（对应用写入的毫秒值是精确的）。
5. **§3.4 之外的追加导出**（都是纯函数或常量，不改既有导出）：`resolveDailyDigestOccurrence`（S5 的汇总 tick 需要 `localDate` 写 source key，避免算两次）；`TASK_NOTIFICATION_CHANNELS`、`TASK_NOTIFIABLE_LIST_EVENTS`（规划器与 producer 的校验单点）；`parseTaskNotificationPayload`（§5.2「行形状只有一处定义」的逆；§7.3 的 `payload_invalid` / `unknown_kind` 由它给出，S4 不再自写解析）；`TASK_DELIVERY_OUTCOMES` / `TASK_DELIVERY_STATUSES` 闭集、各个具名常量（`TASK_DELIVERY_DEFAULTS` 之外另有单个导出）、`TASK_DELIVERY_BACKOFF_LADDER_MS`、`TASK_DINGTALK_BASE_HOST`；类型 `TaskDeliveryChannelResult` 放在协议模块而不是设计 §3.3 的 worker 文件（分类器需要它；S4 的 worker 从协议模块 import 或 re-export）。
6. **`classifyTaskDeliveryOutcome` 的真值表**（`[own-3b-04]` 之内；设计只写了「`fenced` 为真时无法归类 ⇒ `outcome_unknown`」与 §7.2 栅栏前的三种判定）：栅栏后——`{ ok: true }` ⇒ `sent`；`outcomeUnknown` ⇒ `outcome_unknown`（通道自报不确定即采信）；`skip` ⇒ `outcome_unknown`（发送已发起之后不可能再有 skip）；可重试 ⇒ `attemptCount < maxAttempts` 时 `retrying`，否则 `failed`；不可重试 ⇒ `failed`；其余 ⇒ `outcome_unknown`。栅栏前——带 `outcomeUnknown` 的结果（不论其余字段）⇒ 有界重试；`skip` ⇒ `skipped`；不可重试 ⇒ `failed`；其余（含 `{ ok: true }`、可重试、抛错、畸形返回）⇒ 有界重试。由此 `sent` / `outcome_unknown` 只出现在栅栏之后、`skipped` 只出现在栅栏之前，与两种终态 CAS（栅栏后 `status = 'sending'`、栅栏前 `status IN ('pending','retrying')`）一一对应；单测里的不变量格把这一点钉在 17 种结果 × 5 个次数上。`attemptCount` 是 claim 之后的计数（允许 0，但 claim 之后恒 ≥ 1），`maxAttempts ≥ 1`，否则抛。首轮草稿第 4 条为栅栏前 `ok` ⇒ `sent`、`outcomeUnknown` ⇒ `outcome_unknown` 所作的辩护被本条取代（S1.2 B）。
7. **`[own-3b-24]` 批租约夹取 `[60 s, 600 s]`**：下界取 2 × 每行预留（任何夹取后的值都满足 worker 构造函数的 `leaseMs > TASK_DELIVERY_ROW_RESERVE_MS`，且一批至少能开始一行），上界十分钟。设计只给了批大小的 `[1, 200]`。两个 clamp 与考勤 worker 的同名函数同形（`Number(value)`，非有限 ⇒ 缺省，小数向下取整）。
8. **新鲜度与退避的边界**：`isTaskEventNotificationStale` 用严格大于（恰 24 h 仍新鲜，24 h + 1 ms 陈旧；§11.6 的 23 h / 25 h 两格都覆盖）；`computeTaskDeliveryBackoffMs` 只接受 ≥ 1 的整数（claim 之后的次数），值与考勤 worker 的阶梯逐级相同，第 5 次起恒 6 h。`orderClaimedDeliveries` 在 JS 里按毫秒比较时间，PostgreSQL 按微秒排序：同一毫秒内两行的批内处理顺序可能与 SQL 的 `ORDER BY` 不同；claim 到哪些行仍由 SQL 决定，设计本来就不保证到达顺序（§7.3），这里只记下这个差别。
9. **任务 D 的既有文本**：本片改动的每个文件的裁决包扫描都退出 0。`task-reminders.ts:205-209` 任务 D 的 `source_key` 构造器注记点名了另两条线的文件与表名（门 15 的既有残留），与 S1 无关，本片不动，记给 S7 收口时处理（处置见 S7.3）。
10. **文案的取值**（`[own-3b-10]`、`[own-3b-25]`）：汇总条目行 `- 「T」（<due_date>[ <due_time>]，<zone>）`（设计 §8.3 以 `…` 省略）；截止时间接受 `HH:MM` 与 `HH:MM:SS`，秒为 `00` 时显示 `HH:MM`（`HH:MM` 输入的存储形），否则原样；时区名与标题同样转义（`America/New_York` 显示为 `America/New＿York`）；所有 ASCII 控制字符而不只是 CR / LF 换成空格；段落以空行连接，末行恒为标签；空汇总与不合法的 `totalCount` 抛 `TypeError`，不渲染空正文。设计 §7.4（取 MAX+1 行）与 §11.5（MAX+3 ⇒ 「另有 3 项」）原本只能二选一，`totalCount` 让两者同时成立（S1.2 C）。
11. **新的自选标签**：`[own-3b-24]`（第 7 条）、`[own-3b-25]`（第 10 条），接在设计 §12 的 `[own-3b-23]` 之后；S7 收口时补进设计 §12 的表。
12. **门 20 探针下的结果类别**：新增的 22 个函数导出里 17 个抛 `TypeError`、5 个返回否定 / 缺省结果；`sanitizeTaskTextForMarkdown('x')` 返回 `'x'`（`'x'` 是合法的普通文本，转义后不变），这一个读作「无 I/O 的正常返回」而不是「否定结果」。首轮草稿第 11 条记的 `computeDailyDigestSendAt` 抛 `RangeError` 已随 S1.2 D 消除。
13. **私有日期 helper**：只多两个带默认值的形参（函数名、参数名），没有 `typeof` 守卫；默认实参下 `computeDefaultRemindAt` 的两条消息与 S0 基座逐字节相同（单测按原文钉住，变异 D1 证明该格有效）。任务 D 的 65 格既有单测不变。

### S1.8 NOT RUN

- `tasks-realdb` lane（`EXPECT_DB=1`，12 个 `task-*.db.test.ts`）与鉴权门：S1 没有新增或改动真库文件；新函数无人 import，任何真库路径上的运行时代码未变（任务 D 两个模块的既有导出行为不变：65 / 24 格既有单测与 `task-access` 快照通过，私有 helper 的默认消息有单测钉住）。S2 起每片跑。
- `apps/web` 测试：无前端改动。
- 在一次性检出上跑 mutant：本片 mutant 在本工作树上跑，靠「与 `HEAD` blob 比对」的恢复（S0 同法而更严）；设计 §14 的「只在一次性检出里跑」针对真库 mutant，S1 没有真库格。
- 门 18 的另一半负控（删掉守护测试里的 `TASKS_` 正则扩展）：属 #6173 已落 main 的守卫；本片跑的是新条目的三条（M1–M3）。
- 全量单测里四个 timemachine 恢复测试文件与一个考勤 dist 布局测试文件的既有 / 环境失败（S1.5）：不在本片处理；后者的修法（删掉规范检出里的自指链接）不在本工作树，留给 owner。
- 真机 / staging / 任何 `TASKS_*` 开关的打开：按设计不做。

### S1.9 给 S2（producer 与触点）及之后各片的注记

- **S2 入口**：等 PR-3a 的 S6–S9 提交。本节写作时 `claude/tasks-m4-pr3a` 仍停在 `00ddafad23`，所以 PR-3b 停在本片（设计 §14.0 最后一条：这是排期，不需要 owner 裁决）。S2 动手前：`git merge-tree --write-tree` 查冲突后把 S0–S1 重叠到含 S5–S9 的 PR-3a head，重跑 S0.4 与 S1.5 的全部命令和 `tasks-realdb` 清单，用到的 PR-3a SHA 记进 S2 一节，并按设计 §0 重核按名字引用的 PR-3a 符号与行号。
- **S2 producer**：`resolveTaskDeliveryChannelNames(env)` 为空 ⇒ 不发查询、返回 0；非空 ⇒ `resolveTaskDeliveryChannelsForOrg` ⇒ `resolveNotificationRecipients` ⇒ `planTaskEventDeliveries({ …, recipients, channels })` ⇒ 一条多值 INSERT。`TaskNotificationDeliveryPlan` 是 camelCase，INSERT 的列映射（`orgId→org_id`、`sourceType→source_type`、`sourceId→source_id`、`sourceKey→source_key`、`recipientUserId→recipient_user_id`、`recipientRole→recipient_role`、`channel`、`payload`）只写在 producer 里一处；`status` / `next_attempt_at` / `attempt_count` 用 DB 缺省。清单归档触点先对 `TASK_NOTIFIABLE_LIST_EVENTS` 过滤，再调 `planTaskListEventDeliveries`。
- **S4 worker**：payload 经 `parseTaskNotificationPayload`（失败即 `failed`，以 `reason` 作 `last_error`，不重试）；`TaskDeliveryChannelResult` 从协议模块 import；逐行顺序用 `orderClaimedDeliveries`（RETURNING 映射成 `{ id, sourceType, nextAttemptAt, createdAt }`）；事件族与清单族先过 `isTaskEventNotificationStale`；终态经 `classifyTaskDeliveryOutcome`，`fenced` 只在栅栏 UPDATE 返回 1 行之后为真；`sent` / `outcome_unknown` 只会在栅栏之后出现，所以这两个终态只用 `status = 'sending'` 形的 CAS；`retrying` 的 `next_attempt_at = now + computeTaskDeliveryBackoffMs(attempt_count)`。任务行的日期按服务既有写法读文本（`due_date::text`、`due_time::text`）——渲染函数接受 `HH:MM:SS`。汇总内容查询取 `TASK_DIGEST_MAX_ITEMS + 1` 行并同时取总数（例如同一查询里的 `count(*) OVER ()`），把行与 `totalCount` 一起交给 `renderTaskDailyDigestMessage`；渲染输入里的任务标题 / 清单名是发送时重读的行，不是 payload。
- **S5 调度器**：提醒扫描 `WHERE <buildTaskReminderScanCondition(...).sql> ORDER BY <TASK_REMINDER_SCAN_ORDER_BY> LIMIT $5`；首页用 `TASK_REMINDER_SCAN_CURSOR_START`；**游标的 `remind_at` 一半用该行的数据库文本**（`SELECT … tasks.remind_at::text AS remind_at_cursor`），不要把 node-pg 解析出的 `Date` 回传（微秒会被截断，S1.2 F）；每页把游标推进到最后一行的 `(remind_at_cursor, id)`，行数 < `TASK_REMINDER_SCAN_BATCH` 即停，或 `stopping()` / `leaderLost()` 为真即停。floor 子查询的事件类型用 `TASK_REMINDER_FLOOR_EVENT_TYPES`；每行再经 `isTaskReminderDue`。汇总扫描对每个设置行调 `resolveDailyDigestOccurrence(now, time_zone)`（非法时区抛 `RangeError`，逐行 try/catch，不让一行拖垮整次扫描），`due` 为真时以 `localDate` 调 `planTaskDailyDigestDelivery`。`TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS`（1 s）与 `TASK_SCHEDULER_STOP_GRACE_MS`（8 s）不在 S1（设计 §3.2 / §6.6 把它们放在调度器服务），S5 定义。
- **S6 通道**：钉钉客户端把空白的 `baseUrl` 当成缺省 `https://oapi.dingtalk.com`（`integrations/dingtalk/client.ts:172-177` 的 `normalizeDirectoryBaseUrl`，token 与发送都经它），而设计 §8.2 第 3 步写的 `config.baseUrl ?? 'https://oapi.dingtalk.com'` 对空串不起作用（`''` 会原样传给 `isAllowedTaskDingTalkBaseUrl` 并被拒）。S6 必须先按客户端的同一规则规范化（空白 ⇒ 缺省，去首尾空白），再调出站判定，判定的必须是客户端实际要用的那个字符串；否则 `baseUrl` 为空串的集成会被误判 `dingtalk_base_url_rejected`。超时常量从协议模块取。
- **每片推前重跑**：type-check、四个 S1 测试文件、manifest 测试（36）、裁决包字面扫描、门 20 静态两条、values-free 扫描。

## S-merge 重叠到 PR-3a 的 S10 head（S2 入口）

### S-merge.1 基座与合并

| 项 | 值 |
|---|---|
| 合并前的 PR-3b head | `4d0836331c`（S0–S1） |
| 合入的 PR-3a head | `d940fa8745`（`claude/tasks-m4-pr3a`：S5–S10 全部提交；相对 S0 的基座 `00ddafad23` 多 47 个提交，其中首父链 42 个，另含 PR-3a 自己合入当时 `origin/main` 的合并 `f1510d0bed`） |
| 方式 | `git merge --no-ff claude/tasks-m4-pr3a`，合并提交 `f22243316a`（父：`4d0836331c`、`d940fa8745`）；没有 rebase，没有 checkout / reset / stash / clean |
| 预检 | `git merge-tree --write-tree --name-only HEAD claude/tasks-m4-pr3a`：一处内容冲突（`src/tasks/task-reminders.ts`），另有三个文件自动合并 |
| 设计 §14.0 的 S2 入口条件（PR-3a head 含 S5–S9） | 满足（含 S10） |

### S-merge.2 冲突与自动合并的处置

| 文件 | 两边各自的改动 | 处置 |
|---|---|---|
| `src/tasks/task-reminders.ts`（冲突） | 两边都改了 `isInDailyDigest` 上方的同一段文档注释 | 取 PR-3a 的版本；冲突只在注释里，没有代码行冲突 |
| `src/tasks/task-notifications.ts`（自动） | PR-3a 转述了两处任务 D 的注释；PR-3b S0/S1 在文件末尾追加了通道常量、规划器与解析器 | 自动合并结果保留两边；复核：两处 PR-3a 的注释改动与 PR-3b 的追加互不重叠 |
| `scripts/ops/global-history-flag-manifest.mjs`（自动） | PR-3a 改了 `TASKS_ENABLED` 条目（四个路由前缀、迁移改名后的名字）；PR-3b 追加了三个开关与一个数值旋钮 | 自动合并结果保留两边；PR-3b 三个条目里的旧迁移名在下一提交同步（S-merge.3） |
| `scripts/ops/global-history-flag-manifest.test.mjs`（自动） | PR-3a 加了 `readdirSync` 导入与 `TASKS_ENABLED` 条目的规格测试；PR-3b 加了 `TASKS_NON_BOOLEAN_FLAGS` 与 interval 规格测试 | 自动合并结果保留两边 |

### S-merge.3 迁移改名的同步（`863f3d4bb5`）

PR-3a S10 把 M4 迁移改名为 `zzzz20261008090000_create_task_m4_tables`。PR-3b 里引用旧名的地方：manifest 三个开关的 `purpose`（各一处）、设计 §2、本文 S0.2 一行。处置：三段 `purpose` 改成新名；设计 §2 改成新名并按改名后的文件重写行号；S0.2 那一行注明 S0 当时写的是旧名。另加一条 manifest 测试：三个开关的 `purpose` 里出现的 M4 迁移名必须恰为磁盘上的那一个（与 PR-3a 对 `TASKS_ENABLED` 的同形检查）。负控：把其中一个条目改回旧名 ⇒ 该测试红（1 failed / 37 passed），恢复后与备份逐字节相同。PR-3a 自己的设计与验证 MD 里的旧名是它的历史记录，不改。

（2026-10-09 注：PR-3a 把迁移再次改名为 `zzzz20261009130000_create_task_m4_tables`。本节记的是当时的改名；三段 `purpose` 已同步到现名，上面那条按磁盘文件名比对的 manifest 测试照常适用，见文末「2026-10-09 改叠到重新定名之后的 PR-3a」一节。）

### S-merge.4 合并后的复核

所有命令在 `packages/core-backend` 下（`node --test` 在仓库根），Node 20.20.2，单测不设 `DATABASE_URL`。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`，合并提交上） | 0 errors |
| S0/S1 的单测与门 20（`task-notification-flags` / `task-reminders` / `task-notifications` / `task-notification-text` / `task-delivery-protocol` / `task-pure-no-io`） | 6 files，**286 passed**（68 / 94 / 51 / 32 / 36 / 5，与 S1 相同） |
| manifest 测试 | 合并提交上 37/37（S1 的 36 加 PR-3a 的 1）；`863f3d4bb5` 上 **38/38**（加 S-merge.3 的一条） |
| 真库 lane 基线（`863f3d4bb5`；一次性库 `pr3b_s2s3_merge`，从空库全量迁移，`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项，426 条 executed successfully，最后一条是 M4 迁移） | 16 files，**683 passed**，67 s |
| 鉴权门（同库；`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed**（PR-3a S10 的 30 条 M4 路由在内） |

### S-merge.5 按名字引用的 PR-3a 符号重核（设计 §0、§14.0）

在 `d940fa8745` 上逐个核对（行号为该 head 的行号；设计修订 2 已按此改写 §4.3）：

| 符号 | 位置 | 与设计的出入 |
|---|---|---|
| `completeTask` / `reopenTask` / `writeEvents` | `task-records.ts:637` / `:661` / `:626` | 行号变了；形状不变（`writeEvents` 仍逐条插入，id 由 `newTaskEventId()` 生成） |
| `loadActorListMemberships` | `task-records.ts:442` | 另在两行上比较清单与任务的 org |
| `writeMembershipEvents` / `addAssignee` / `removeAssignee` / `switchCompletionMode` / `addComment` / `deleteTaskById` | `task-structure.ts:130` / `:313` / `:347` / `:406` / `:640` / `:791` | 增删负责人在 PR-3a 里改由直接角色判定（[own-53]）并在锁后校验在职（[R17] [N2]）；不影响挂点 |
| 清单归档 handler | `task-list-records.ts:331` `setTaskListArchived`；`writeListEvent`（`:198`）返回事件 id | 设计原文只写「归档 handler」，名字在此落定 |
| `buildTaskListByIdCondition` | `task-list-access.ts:54`；org 子句来自 `taskListOrgClause`（`:27`，私有） | 没有 `archived_at` 过滤，S4 读已归档清单可用 |
| `findActiveOrgMembers` | `task-org-members.ts:21` | R17 已裁，S4 的发送时复核用它 |
| `buildTaskByIdCondition` | `task-access.ts:310` | 不变 |
| `applyAddAssignee` / `applyRemoveAssignee` | `task-membership.ts:69` / `:97` | 不变（S3 改） |
| `task_list_items` 表形 | 迁移 `:111-123` | **与设计 §5.3 不符**：PR-3a S7 加了 `org_id` 列与两条组合外键（[own-37]），设计原文写「没有 `org_id` 列」。设计修订 2 更正 §5.3，§11.3 的他 org 清单格改为先证明外键拒绝、再在超级用户连接上暂停外键检查播种（与 PR-3a `task-m4-list-roles` 的同类格同法） |

## S2 producer 与触点

### S2.1 基座

| 项 | 值 |
|---|---|
| 起点 | `863f3d4bb5`（S-merge 之后） |
| 代码提交 | `025f8fa271`（producer、构造器、八个触点） |
| 测试提交 | `5966f5efbc`（单测、守卫格、真库文件、夹具、两处登记） |
| 同期的标签与设计提交 | `8cbd7e0b87`（S0/S1 注释里已裁条目改标 `RULED(2026-10-07)`）、`0361d670db`（设计修订 2） |

### S2.2 交付内容

路径省略前缀 `packages/core-backend/`。

| 文件 | 内容 |
|---|---|
| `src/services/task-notification-producer.ts`（新） | `WrittenTaskEvent`；`resolveTaskDeliveryChannelsForOrg`（一条 `EXISTS`：同 org、`provider = 'dingtalk'`、`status = 'active'`；不认识的通道名丢弃；空名单不发查询）；`insertTaskNotificationDeliveries`（outbox 唯一的 INSERT 文本：八列取自数组，`ON CONFLICT (org_id, source_key) DO NOTHING RETURNING id`，返回真正写入的行数；空计划不发语句）；`enqueueTaskEventNotifications`；`enqueueTaskListEventNotifications` |
| `src/tasks/task-list-access.ts`（追加） | `buildTaskListsOfTaskCondition({ taskIdParam, orgParam })`：经模块唯一的清单 org 子句生成器，条件为「该 org 的清单含此任务」，不过滤已归档 |
| `src/services/task-records.ts` | `writeEvents` 先生成 id 再插入，返回写入的事件；`completeTask`、`reopenTask` 在事件之后调 producer |
| `src/services/task-structure.ts` | `writeMembershipEvents` 同上；`addAssignee`、`removeAssignee`、`switchCompletionMode` 在事件之后调 producer；`addComment`、`deleteTaskById` 把事件 id 提到 INSERT 之前，在事件之后调 producer（`deleteTaskById` 的事件仍从任务行复制 `deleted_at`） |
| `src/services/task-list-records.ts` | `setTaskListArchived` 用 `writeListEvent` 返回的 id 调清单 producer |
| `tests/unit/task-notification-producer.test.ts`（新，19 格） | S2.4 |
| `tests/unit/task-records-guards.test.ts`（+3 格，67 → 70） | S2.4 |
| `tests/unit/task-list-access.test.ts`（+3 格，12 → 15） | S2.4 |
| `tests/integration/task-m4-outbox.db.test.ts`（新，18 格） | S2.5；三处登记：`vitest.config.ts` exclude、`.github/workflows/tasks-realdb.yml`、文件顶部 `assert-rbac-optional-off` |
| `tests/helpers/task-m4-fixtures.ts` | `seedOrgDingTalkIntegration`（显式写 org，名字与企业 id 每次唯一）、`seedOutboxRow`；`dropTaskM4Fixtures` 按 org 前缀多删 `directory_integrations` |

不挂 producer 的写：关注人增删、退出、设父、PATCH、清单的其余写（不在触发闭集）。

### S2.3 producer 的行为（设计 §3.1、§5）

一次调用的顺序，每一步在无事可做时返回 0、不再往下：

1. 通道名来自三个开关（`resolveTaskDeliveryChannelNames`，调用时读）；任一不严格等于 `'true'` ⇒ 不发任何语句（`ASSUMPTION(task-m4): [own-3b-01]`）。
2. 只留会通知的事件（`TASK_NOTIFIABLE_EVENTS`；清单族只有 `archived`，且创建人自己归档时没有收件人）⇒ 一个都没有就不发任何语句。
3. org 前提：一条 `EXISTS`（`[own-3b-13]`）。
4. 负责人 / 关注人 / 清单成员：一条 `UNION ALL` 语句，在调用方的连接上、写入之后读，所以是写后集合；清单一支经 `buildTaskListsOfTaskCondition`。
5. `resolveNotificationRecipients` → `planTaskEventDeliveries`（每个会通知的事件各自的 id），一条 INSERT；计划为空就不发 INSERT。

`RULED(2026-10-07)`：[R05] [D13] 的触发闭集、四值角色与优先级、排除 actor、清单成员含已归档清单、清单归档通知创建人，全部由任务 D 的纯函数决定，producer 只喂 id。outbox 行的 id 是列缺省的 uuid（[R23]）。

### S2.4 单测

| 文件 | 格 | 内容 |
|---|---|---|
| `task-notification-producer.test.ts` | 19 | 关闭（3）：十种不是三者都严格为 `'true'` 的状态下，事件与清单两个 producer 都不发语句、返回 0；`TASKS_ENABLED` 不在谓词里。不通知的事件（3）：十七种事件 / 空批次不发语句；清单只认 `archived`；创建人自己归档不发语句。org 前提（4）：`EXISTS` 的全文与只绑 org；非活跃 ⇒ 无通道、空名单不查、未知通道名丢弃；无活跃集成时两个 producer 都在检查后停下。收件人与 INSERT（9）：检查 → 成员读（全文、绑 `[taskId, orgId]`、之后没有任何 `FROM tasks`）→ INSERT 的顺序；一人一行、取最高角色、actor 无行，`source_key` 与 payload 逐字；INSERT 全文（`ON CONFLICT … DO NOTHING RETURNING id`，不写状态与调度列）；返回值是 INSERT 报告的新行数；同一批次只有会通知的事件写行、各用自己的 id、一条 INSERT；候选人全是 actor 时读成员但不 INSERT；未知 `member_kind` 被忽略；清单 producer 的整行；空计划不发语句 |
| `task-records-guards.test.ts` | +3 | 开关关着：`completeTask`、`reopenTask`、`switchCompletionMode`、`addComment`、`deleteTaskById`、`setTaskListArchived` 在事务连接与连接池上都没有任何语句碰集成表或 outbox 表；开关开着：六个写的 org 检查、成员读与 outbox INSERT 都在各自的事务连接上、在各自的事件之后，从不走连接池，事件之后不再读任务行；outbox 行的 payload 里的 `eventId` 等于事件 INSERT 绑定的 id |
| `task-list-access.test.ts` | +3 | 新构造器的全文与参数、org 子句恰一次且不含 `archived_at`；与按 id 构造器同一段 org 子句开头；绑定值不内联 |

### S2.5 真库文件 `task-m4-outbox.db.test.ts`（18 格）

org 前缀 `org_tasks_m4outbox_`（与既有各文件的前缀互不为前缀）。夹具：一个 org（缺省有一条活跃钉钉集成，显式写在该 org 下）、创建人、两个负责人、一个关注人、一个 `all` 模式任务；参与者经 `seedOrgMembers` 播种为在职成员；关注人、清单、清单成员、集成行用 SQL 播种。开关是进程环境、producer 每次调用时读：`beforeEach` 打开三者，需要关闭的格自己设置，`afterAll` 清掉；lane 每个文件一个进程。行按 `recipient_user_id COLLATE "C"` 排序（不依赖库的缺省排序规则）。

| 组 | 格 | 内容 |
|---|---|---|
| M4-a 行 | 4 | 完成写出的每一行：`task_event`、`source_id`、逐字 `source_key`、角色、通道、`pending`、次数 0、租约 / 投递 / 错误列为空、`redelivery_safe=false`、id 为 uuid、payload 恰为五个键且 `eventId` 等于 `completed` 事件行的 id、payload 不含标题；再调一次同一事件写 0 行、表不变，换一个事件 id 又写 3 行；库里已有同键的 `sent` 行保持原样（整行相等）、只补缺的两行；**同事务**：一个在提交时才触发、对该任务的 `completed` 事件报错的约束触发器让完成在提交时失败，错误消息里是该事务自己看到的 outbox 行数（3），失败之后 outbox 0 行、任务仍 `open`、没有 `completed` 事件；去掉触发器后同一完成写出 3 行 |
| M4-a 开关 | 3 | 五种关闭状态（全不设、各关一个、钉钉开关为 `'TRUE'`）下完成、评论、删除、归档都 0 行；三者全开时同四个写都有行（正控）；**不读**：本文件自己的连接对 `directory_integrations` 持 ACCESS EXCLUSIVE 时，有开关关着的完成在锁未释放时就结束（没有读）；三者全开时同一操作排在锁上（读了），锁释放后写出 3 行 |
| M4-a org 前提 | 1 | 另一个 org 有活跃集成时：没有集成的 org、只有非活跃集成的 org 在完成、评论、归档上都 0 行；有活跃集成的 org 共 7 行 |
| M4-b 收件人 | 4 | 关注人收 `completed`、`self_completed` 无行、actor 无行；清单 `read` 成员与已归档清单的成员收 `commented`（`list_member`），评论者无行；创建人兼关注人兼清单成员只一行且为 `creator`；他 org 清单：先证明库以 23503（`task_list_items_list_fk`）拒绝该行，再在超级用户连接上暂停外键检查写入，评论之后任务所在 org 的清单成员有行、他 org 清单的成员无行；**负控**（`runSourceMutant`，`task-list-access.ts` 的清单 org 单点改成恒真）：另一个同样播种的任务完成后，他 org 清单的成员收到一行（子进程退出 0），文件随后逐字节恢复 |
| M4-b 各触点 | 6 | 重启写 `reopened`、只重启自己一行（`self_reopened`）无行；`all → any` 且已有一行完成写 `completed_by_any`；删除写 `deleted`（软删之后仍通知）；非创建人归档写一行给创建人（整行与归档事件 id 相符），取消归档与创建人自己归档无行；增删负责人而状态不变、增删关注人、退出都无行；经路由 `POST /api/tasks/:id/complete` 写出行 |

### S2.6 命令与结果

真库环境：`EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；一次性库从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`，只覆盖 `src/`，不含 `tests/**`） | 0 errors（`025f8fa271` 与 `8cbd7e0b87` 的树上各一遍）；测试文件的类型检查见收尾一节（另用一份临时配置） |
| 任务线单测（`tests/unit/task-*.test.ts` 与 `tasks-*.test.ts`） | `8cbd7e0b87` 上 **33 files / 1375 passed**（S1 的 1350 加 S2 的 25） |
| 新真库文件单独（库 `pr3b_s2s3_dev`） | 18 passed；跑完后该前缀下 `tasks`、`task_lists`、`directory_integrations`、`user_orgs`、outbox 行与测试用户都是 0 行，没有残留的触发器或函数 |
| lane 全部 17 个文件（同库，`5966f5efbc` 的代码） | **17 files / 701 passed**（基线 683 加本文件 18），102 s；既有 16 个文件的格数与基线逐文件相同 |
| 鉴权门 | **86 passed** |
| `task-ci-coverage-enumeration` | 4/4（磁盘、exclude、lane 三个集合仍相等） |
| manifest 测试 | 38/38 |
| 两版裁决包扫描 | 本节改动的每个文件、设计与本文件：两版都退出 0 |

最终 head 上的 lane ×3、全量单测与清库记录在 S3 之后的收尾一节。

### S2.7 变异（35 个，全部变红）

驱动逐个处理：先断言目标文件与 `HEAD` 的 blob 逐字节相同 → 备份 → 改动（每个 needle 在文件里恰出现一次）→ 跑所属测试（单测与 / 或变异库 `pr3b_s2s3_mut` 上的新真库文件）→ 从备份恢复 → 断言与备份逐字节相同且 sha256 等于 `HEAD` 的 blob。结束时目标文件 `git status` 为空，驱动退出 0。不使用 `git checkout` / `reset` / `stash` / `clean`；驱动与日志不入库。「红 / 余」是该 mutant 下所属文件的失败格数与通过格数。

| id | mutant | 红 / 余 |
|---|---|---|
| P1 | 事件 producer 不看开关 | producer 1/18；guards 1/69；outbox 2/16 |
| P2 | 清单 producer 不看开关 | producer 1/18；outbox 1/17 |
| P3 | 没有会通知的事件时仍做 org 检查与成员读 | producer 1/18；outbox 0/18 |
| P4 | 清单 producer 不再只认 `archived` | producer 1/18；outbox 1/17 |
| P5 | 创建人自己归档时仍查集成表 | producer 1/18；outbox 0/18 |
| P6 | org 前提恒真（设计 §11.2 的负控） | producer 4/15；outbox 1/17 |
| P7 | 任一 org 的活跃集成都算 | producer 1/18；outbox 1/17 |
| P8 | 非活跃集成也算 | producer 1/18；outbox 1/17 |
| P9 | 任一 provider 的集成都算 | producer 1/18；outbox 0/18 |
| P10 | 去掉 `ON CONFLICT`（设计 §11.2 的负控，23505） | producer 1/18；outbox 2/16 |
| P11 | 冲突时改写已有行 | producer 1/18；outbox 2/16 |
| P19 | 返回计划行数而不是真正写入的行数 | producer 1/18；outbox 2/16 |
| P20 | 空计划仍发 INSERT | producer 2/17；outbox 0/18 |
| P12 | 不读关注人 | producer 1/18；outbox 10/8 |
| P13 | 不读清单成员 | producer 1/18；outbox 2/16 |
| P14 | 关注人记成清单成员 | producer 1/18；outbox 5/13 |
| P15 | 负责人记成关注人 | producer 1/18；outbox 4/14 |
| P16 | 排除创建人而不是 actor | producer 4/15；outbox 7/11 |
| P17 | 把 actor 当成创建人 | producer 3/16；outbox 8/10 |
| P18 | 同一批次的事件都用第一个事件的 id | producer 1/18；outbox 0/18 |
| T1 | `completeTask` 不调 producer | guards 2/68；outbox 9/9 |
| T2 | `completeTask` 在连接池上（事务之外）调 producer | guards 2/68；outbox 1/17（同事务格：行在回滚后仍在） |
| T3 | `reopenTask` 不调 producer | guards 2/68；outbox 1/17 |
| T4 | `writeEvents` 返回的 id 不是写入的 id | guards 1/69；outbox 2/16 |
| T5 | `switchCompletionMode` 不调 producer | guards 2/68；outbox 1/17 |
| T6 | `writeMembershipEvents` 返回的 id 不是写入的 id | guards 1/69；outbox 1/17 |
| T7 | `addComment` 不调 producer | guards 2/68；outbox 5/13 |
| T8 | `addComment` 在连接池上调 producer | guards 2/68；outbox 0/18 |
| T9 | `deleteTaskById` 不调 producer | guards 2/68；outbox 2/16 |
| T10 | `deleteTaskById` 交给 producer 的 id 不是 `deleted` 事件的 id | guards 1/69；outbox 1/17 |
| T11 | `setTaskListArchived` 不调 producer | guards 2/68；outbox 3/15 |
| T12 | `setTaskListArchived` 把 actor 当成清单创建人 | guards 2/68；outbox 3/15 |
| L1 | 新构造器绕过清单 org 子句（设计 §11.3 的负控，只改新构造器） | listaccess 2/13；outbox 1/17 |
| L2 | 新构造器排除已归档清单 | listaccess 1/14；outbox 1/17 |
| L3 | 新构造器取该 org 任一有清单项的清单 | listaccess 1/14；outbox 0/18 |

只被单测杀死的 7 个（P3、P5、P9、P18、P20、T8、L3）在真库上没有可观察的行差：P3 / P5 / P20 只多发语句；P9 在夹具里没有别的 provider；P18 要求同一批里有两个会通知的事件，而今天没有一个触点会这样写（S3 的 N1 批次是一个负责人事件加一个状态事件，只有后者会通知），所以它结构上只有单测能看见；T8 的评论没有回滚格（同事务由 T2 在真库上证明，评论的连接由守卫格证明）；L3 在夹具里没有不含该任务的清单。真库文件自己的负控（清单 org 单点恒真）每次 lane 都会跑。上表是 S2 当时（`5966f5efbc` 的测试）的结果；最终 head 上全部 50 个 mutant 的重跑见收尾一节。

### S2.8 偏差与说明

1. **producer 的签名**（设计 §3.1）：设计写的入参带 `assigneeIds` / `followerIds`。实现里调用方只交 `orgId`、`taskId`、`createdBy` 与写入的事件，负责人 / 关注人 / 清单成员由 producer 在调用方的连接上、写入之后用一条语句读出。理由：`addComment` 与 `deleteTaskById` 在事务里手上没有负责人或关注人，由调用方先读就要在开关关着时也多一次查询（违背 `[own-3b-01]`「关着时请求路径只多一次内存判断」）；同一连接写后读到的就是写后集合，与设计 §4.3「负责人取写后集合」同义，只有一条代码路径。任务行本身不再读（守卫格与单测钉住）。
2. **INSERT 的形状**：设计 §5.3 写「一条多值 INSERT」；实现用 `unnest` 八个数组的 `INSERT … SELECT`，仍是一条语句、参数个数固定为 8（扇出上界 1101 行时也不随行数增长）。
3. **清单 producer 的提前返回**：创建人自己归档时没有收件人，在 org 检查之前返回（少一次查询）；规划器仍是收件人的唯一定义。
4. **文件数**：设计 §14 S2 写「文件数 8 + 三处登记」；实际 10 个（加 `tests/unit/task-notification-producer.test.ts` 与 `tests/unit/task-records-guards.test.ts`），`seedOutboxRow` 已加入夹具并用于「已有同键行保持原样」格。
5. **设计修订 2**：S2 入口的重核（S-merge.5）、§5.3 与 §11.3 的更正、裁决状态（§12 / §13）都在设计里改了；取值未改。R01、R04、R13 没有出现在本 PR 收到的已裁清单里，按假设保留（设计 §13-Q21）。
6. **S0/S1 注释的标签**（`8cbd7e0b87`）：只改注释，把已裁条目（R05 / D13、R06、R07）的标签改为 `RULED(2026-10-07)`；任务 D 自己的模块抬头与 `ASSUMPTION(task-d)` 标签属任务 D 的文本，本片不改（与 PR-3a S10 的做法一致），记给 S7 收口。

### S2.9 NOT RUN

- lane ×3 与全量单测、清库：在 S3 之后的收尾一节跑（本节的 lane 是单次）。
- `apps/web` 测试：无前端改动。
- 真机 / staging / 任何 `TASKS_*` 开关在环境里打开：不做。
- 两个调度扫描的 org 前提（设计 §11.2 那一格的扫描部分）：扫描在 S5 才有，届时补格。
- 空汇总行的形状格：设计把它放在 S4。

### S2.10 给 S3 及之后各片的注记

- S3 只改纯函数：`addAssignee` / `removeAssignee` 已经把写入的事件交给 producer，N1 追加的 `completed` / `reopened` 会自动产生通知（S3 一节的复核更正了这里原来的一句：N1 的批次里只有一个会通知的事件，P18 在真库上仍不可见）。
- S4 的 worker 读 outbox 行时，`payload.eventId` 就是事件行的 id（守卫格与真库格都钉住）；`deleted` 族的任务行已软删，读法按设计 §7.4。
- S5 的两个扫描写行时复用 `insertTaskNotificationDeliveries`（outbox 唯一的 INSERT 文本）与 `resolveTaskDeliveryChannelsForOrg`（每个 tick 一次的 org 集合可以另写一条批量查询，但前提的判据要与这条 `EXISTS` 相同）。

## S3 N1

### S3.1 基座

| 项 | 值 |
|---|---|
| 起点 | `96dcc96a0e`（S2 文档提交之后） |
| 代码提交 | `25f856b690`（`task-membership.ts`） |
| 测试提交 | `f135ad4ad3`（成员单测、M3 成员真库、outbox 真库的 N1 格）、`9d15e6911b`（守卫格覆盖两个增删负责人的写） |
| 裁决 | `RULED(2026-10-07)`：[N1]（本片不再是可以整片去掉的一片，设计修订 2 已改 §5.5 与 §14） |

### S3.2 交付内容

路径省略前缀 `packages/core-backend/`。

| 文件 | 内容 |
|---|---|
| `src/tasks/task-membership.ts` | `TaskAssigneeEventType` 加 `completed`、`reopened`（两个词本来就在 `task_events` 的闭集里）；`applyAddAssignee`：`all` 模式给已完成的任务加人（状态 `done → open`）时，在 `assignee_added` 之后追加 `{ type: 'reopened', userId: 操作者 }`（不带目标用户、不带自己的时刻，由写入方按同批时刻落库）；`applyRemoveAssignee`：`all` 模式下删人使剩下的负责人全部已完成（`open → done`）时，在 `assignee_removed` 之后追加 `{ type: 'completed', userId: 操作者, occurredAt: now }`。只在状态真的翻转时追加：重复添加、`any` 模式已完成的任务加人、已完成的 `all` 任务删掉一行而其余仍全部完成、删到零行，都只有负责人事件。任务 C 原来记录这一空白的注记换成规则注释 |
| `tests/unit/task-membership.test.ts`（31 → 34 格） | 两个翻转格按新事件更新（顺序、操作者、`completed` 的时刻）；新增三格：`reopened` 事件只有两个键；不翻转就没有 `reopened`（三种情形）；已完成的任务删掉一行、其余仍完成时只有 `assignee_removed` |
| `tests/integration/task-m3-membership.db.test.ts`（格数不变，45） | 「加人致重启」「删人致完成」两格读出写入的事件（类型、操作者、payload、同一时刻）：`[assignee_added, reopened]`、`[assignee_removed, completed]`，状态事件的 payload 为 `{}`；「已完成的任务删人仍完成」一格断言删人是它写下的唯一事件 |
| `tests/integration/task-m4-outbox.db.test.ts`（18 → 21 格） | 三个 N1 格（S3.3） |
| `tests/unit/task-records-guards.test.ts`（格数不变，70） | 三个接线格的写清单加上 `addAssignee`（创建人把自己加进已完成的 `all` 任务，重启；操作者不查在职）与 `removeAssignee`（删掉开放 `all` 任务里唯一未完成的一行，完成）：开关关着不碰集成表与 outbox 表；开着时检查、成员读与 INSERT 都在事务连接上、在状态事件之后，从不走连接池；行里的 `eventId` 等于状态事件的 id |

`addAssignee` / `removeAssignee` 本身不改：`writeMembershipEvents` 照写事件数组，`writeTaskDoneState` 本来就在状态变化时调用，S2 的 producer 把新事件当作普通的完成 / 重启通知。

### S3.3 N1 的真库格（`task-m4-outbox`）

| 格 | 断言 |
|---|---|
| 删人致完成 | 两个负责人之一先完成，再由创建人删掉另一个：任务 `done`，恰一条 `completed` 事件；outbox 行是留下的负责人（`assignee`）与关注人（`follower`），被删的负责人没有行；payload 的 `eventId` 是该 `completed` 事件、`actorId` 是操作者 |
| 加人致重启 | 两个负责人都完成后，创建人加一个在职的新负责人：任务 `open`，恰一条 `reopened` 事件；`reopened` 的收件人是两个原负责人、新负责人（`assignee`）与关注人（`follower`），payload 同上 |
| 不翻转就没有状态事件与行 | 已完成的 `all` 任务删掉一个已完成的负责人：outbox 不变、`completed` 事件仍只有完成时的那一条；`any` 模式已完成的任务加人：outbox 不变、没有 `reopened` 事件 |

收件人按写后集合（设计 §4.3）。加人致重启时新负责人收到「已重启」，删人致完成时被删的人不收；这一取舍记为设计 §13-Q22，缺省保持写后集合。

### S3.4 单次运行（开发库 `pr3b_s2s3_dev`）

| 项 | 结果 |
|---|---|
| type-check | 0 errors（`25f856b690`） |
| 任务线单测 | 33 files / 1378 passed（S2 的 1375 加成员单测的 3 格） |
| `task-m4-outbox` / `task-m3-membership` 单独 | 21 passed / 45 passed |

最终 head 上的全部运行见「收尾」一节。

### S3.5 变异（15 个，全部变红）

驱动与 S2.7 相同（与 `HEAD` 的 blob 比对、逐字节恢复、不用 `git checkout` / `reset` / `stash` / `clean`）。「membership」= 成员单测，「m3mem」= M3 成员真库文件，「guards」= `task-records-guards`，「outbox」= 新真库文件。

| id | mutant | 红 / 余 |
|---|---|---|
| N1 | 给已完成的 `all` 任务加人不再记 `reopened` | membership 2/32；m3mem 1/44；outbox 1/20 |
| N2 | 删掉最后一个未完成的人不再记 `completed` | membership 1/33；m3mem 1/44；outbox 1/20 |
| N3 | 每次加人都记 `reopened` | membership 3/31；m3mem 0/45；outbox 2/19 |
| N4 | 每次删人都记 `completed` | membership 4/30；m3mem 1/44；outbox 2/19 |
| N5 | `reopened` 记成被加的人而不是操作者 | membership 2/32；m3mem 1/44；outbox 1/20 |
| N6 | `completed` 记成被删的人而不是操作者 | membership 1/33；m3mem 1/44；outbox 1/20 |
| N7 | `completed` 排在 `assignee_removed` 之前 | membership 1/33；m3mem 0/45；outbox 0/21 |
| N8 | `completed` 不带自己的时刻 | membership 1/33；m3mem 0/45；outbox 0/21 |
| N9 | 任务最终为 `done` 就记 `completed`（不论是否翻转） | membership 3/31；m3mem 1/44；outbox 1/20 |
| N10 | `all` 模式每次加人都记 `reopened`（不论是否翻转） | membership 2/32；m3mem 0/45；outbox 1/20 |
| N11 | `reopened` 带上目标用户（payload 不再是 `{}`） | membership 2/32；m3mem 1/44；outbox 0/21 |
| T13 | `addAssignee` 不调 producer | guards 2/68；outbox 1/20 |
| T14 | `removeAssignee` 不调 producer | guards 2/68；outbox 1/20 |
| T15 | `addAssignee` 在连接池上（事务之外）调 producer | guards 2/68；outbox 1/20 |
| T16 | `removeAssignee` 在连接池上调 producer | guards 2/68；outbox 1/20 |

N7 与 N8 只被单测杀死，这是结构决定的：两条事件由写入方按同一个时刻落库（`completed` 的时刻就是传给写入方的同一个 `now`，去掉它时写入方回落到同一个值），表里没有记录插入顺序的列，M3 文件的读取按时刻排序、同一时刻再按类型排，本来就看不出顺序；outbox 行也不依赖这两点。T15 / T16 在真库上也会变红：在连接池上读成员看不到本事务未提交的增删，被删的人仍被读成负责人、新加的人读不到。

### S3.6 偏差与说明

1. **文件数**：设计 §14 S3 写「文件数 4」；实际 5 个（加 `tests/unit/task-records-guards.test.ts` 的接线格，补上两个增删负责人写的同事务证明；S2 的守卫格当时只覆盖另外六个写）。
2. **N1 格数**：设计 §11.3 写 N1 两格；outbox 文件实际三格（多一格「不翻转就没有状态事件与行」），成员单测多三格。
3. **只在翻转时追加**：设计 §5.5 写「把状态从 `open` 提升为 `done` 时」「把 `done` 改回 `open` 时」；实现按 `newStatus !== status` 判定，所以「已完成的任务删人仍完成」与「`any` 模式已完成的任务加人」都不追加（单测与真库各有格，N9 / N10 证红）。
4. **收件人与 R05-opt**：N1 与写后集合合起来，加人致重启时新加的负责人会收到「已重启」通知；触发它的是重启事件，没有重启的加人仍然不发通知（S2 的「无行」格）。是否改成写前集合记为设计 §13-Q22。
5. **既有 M3 断言**：没有改任何既有取值，只在三个格里加了事件断言；M3 成员文件的格数不变。

### S3.7 NOT RUN

- 前端：仓库的前端没有读 `task_events` 的面（对 `apps/web/src` 查 `completed_by_any` / `self_completed` / `assignee_removed` 零命中），新事件不改任何页面；没有跑 `apps/web` 测试。
- socket：增删负责人的实时推送属 PR-3c（R16），本片不碰。

## 收尾（S3 之后）：最终 head 上的运行、变异重跑与清库

### 收尾.1 头与范围

- 代码的最终 head 是 `9d15e6911b`；本节所有运行都在它上面，之后的提交只改本文件。运行严格串行（真库文件里的负控会原地改写 `task-list-access.ts`，lane 运行期间不跑任何别的东西）。
- PR-3a 仍是 S-merge 合入的 `d940fa8745`。PR-3a 随后的一组修复提交（鉴权门格、创建回填格、措辞）没有合入本轮，按设计 §14.0 留给 S7 前的第二次重叠。

### 收尾.2 绿线（新建的一次性库 `pr3b_s2s3_final`，从空库全量迁移 426 条）

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（私有工件目录里的临时配置：继承本包配置，`module: esnext`、`moduleResolution: bundler`、`noUnusedLocals`，`types` 为 node 与 vitest/globals；`include` 只列本 PR 新增或改动的七个测试文件：producer 单测、守卫单测、清单访问单测、成员单测、outbox 真库、M3 成员真库、夹具） | 本 PR 新增或改动的行没有诊断。`task-m3-membership.db.test.ts` 有 4 条 TS2339（`PoolClient` 上没有 `processID`），都在本 PR 没有碰的行上（PR-3a 的 `:924`–`:962`；本 PR 对该文件的改动不含任何 `processID` 行）；其余 47 条在本 PR 没有改的 `src` 文件里（34 条 TS2339、11 条 TS6133、2 条 TS6196），与 PR-3a 记录的这套编译选项下的既有提示相同 |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **35 files / 1402 passed**。逐文件：approval-feature-payload-flag-ledger 8、source-files-hourcycle-parsing-guard 16、task-access 210、task-advisory-locks 5、task-ci-coverage-enumeration 4、task-comments 16、task-completion 53、task-create 12、task-dates 68、task-deletion-lock-errors 6、task-deletion 9、task-delivery-protocol 36、task-edit 148、task-gate19-identities 9、task-groups 47、task-ids-runtime 8、task-ids 53、task-list-access 15、task-lists 125、task-lock-keys 9、task-membership 34、task-notification-flags 68、task-notification-producer 19、task-notification-text 32、task-notifications 51、task-pagination 26、task-pure-no-io 5、task-realtime 9、task-records-guards 70、task-reminders 94、task-settings 36、task-tree 46、tasks-auth-ci-wiring 2、tasks-feature-flag 8、tasks-route-errors 45 |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 17 个文件） | 三遍都是 **17 files / 704 passed**（68 s / 78 s / 155 s）；三遍逐文件计数相同；与 S-merge 的基线相比，既有 16 个文件逐文件不变，多出 `task-m4-outbox` 21 格；每遍都打印了真库文件自己的负控输出 |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| 全量单测（一遍，不设 `DATABASE_URL`） | 5 files failed / 1082 passed / 172 skipped（1259）；44 tests failed / 18907 passed / 1712 skipped（20663）；634 s。失败的 5 个文件是 `multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}` 与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`，规范检出里那个自指的 `node_modules` 链接，S1.5 已记），与 S1.5 是同一组文件、同样 44 格；没有任务线文件失败 |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 38/38；101/101 |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| 源码 token 普查 | 与 S1 相同：`TASKS_ENABLED` ×5、三个开关各 ×1、`TASKS_SCHEDULER_INTERVAL_MS` ×3 |
| 门 15（对 S2 / S3 在 `src` 里新增的行 grep 其他线的名字） | 零命中 |
| 门 20 静态（`src/tasks` 的改动行里 `from 'pg'`、`crypto`、`Intl.DateTimeFormat`、`from '../db`） | 零命中 |
| values-free（合并之后改动的每个文件：IPv4 字面、主机名后缀、本机路径与机器名） | 除回环地址外零命中；一处误报是 `vitest.config.ts` 里一行既有注释中的表名序列，被不分大小写的路径模式匹配到，与本 PR 无关 |
| 两版裁决包扫描 | 本 PR 的全部 31 个文件（`git diff --name-only claude/tasks-m4-pr3a HEAD` 加本文件，含两份 MD）：两版都退出 0 |

### 收尾.3 最终 head 上的变异重跑（50 个，全部变红）

S2.7 的 35 个与 S3.5 的 15 个，在 `9d15e6911b` 上用同一驱动重跑（变异库 `pr3b_s2s3_mut`）。50 次恢复全部与 `HEAD` 的 blob 逐字节相同；两轮结束时目标文件 `git status` 为空，驱动退出 0。描述见 S2.7 与 S3.5。

| id | 红 / 余（最终 head） | 结果 | 恢复 |
|---|---|---|---|
| P1 | producer 1/18；guards 1/69；outbox 2/19 | 红 | 与 HEAD 相同 |
| P2 | producer 1/18；outbox 1/20 | 红 | 与 HEAD 相同 |
| P3 | producer 1/18；outbox 0/21 | 红 | 与 HEAD 相同 |
| P4 | producer 1/18；outbox 1/20 | 红 | 与 HEAD 相同 |
| P5 | producer 1/18；outbox 0/21 | 红 | 与 HEAD 相同 |
| P6 | producer 4/15；outbox 1/20 | 红 | 与 HEAD 相同 |
| P7 | producer 1/18；outbox 1/20 | 红 | 与 HEAD 相同 |
| P8 | producer 1/18；outbox 1/20 | 红 | 与 HEAD 相同 |
| P9 | producer 1/18；outbox 0/21 | 红 | 与 HEAD 相同 |
| P10 | producer 1/18；outbox 2/19 | 红 | 与 HEAD 相同 |
| P11 | producer 1/18；outbox 2/19 | 红 | 与 HEAD 相同 |
| P19 | producer 1/18；outbox 2/19 | 红 | 与 HEAD 相同 |
| P20 | producer 2/17；outbox 0/21 | 红 | 与 HEAD 相同 |
| P12 | producer 1/18；outbox 13/8 | 红 | 与 HEAD 相同 |
| P13 | producer 1/18；outbox 2/19 | 红 | 与 HEAD 相同 |
| P14 | producer 1/18；outbox 7/14 | 红 | 与 HEAD 相同 |
| P15 | producer 1/18；outbox 6/15 | 红 | 与 HEAD 相同 |
| P16 | producer 4/15；outbox 7/14 | 红 | 与 HEAD 相同 |
| P17 | producer 3/16；outbox 9/12 | 红 | 与 HEAD 相同 |
| P18 | producer 1/18；outbox 0/21 | 红 | 与 HEAD 相同 |
| T1 | guards 2/68；outbox 10/11 | 红 | 与 HEAD 相同 |
| T2 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T3 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T4 | guards 1/69；outbox 2/19 | 红 | 与 HEAD 相同 |
| T5 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T6 | guards 1/69；outbox 3/18 | 红 | 与 HEAD 相同 |
| T7 | guards 2/68；outbox 5/16 | 红 | 与 HEAD 相同 |
| T8 | guards 2/68；outbox 0/21 | 红 | 与 HEAD 相同 |
| T9 | guards 2/68；outbox 2/19 | 红 | 与 HEAD 相同 |
| T10 | guards 1/69；outbox 1/20 | 红 | 与 HEAD 相同 |
| T11 | guards 2/68；outbox 3/18 | 红 | 与 HEAD 相同 |
| T12 | guards 2/68；outbox 3/18 | 红 | 与 HEAD 相同 |
| L1 | listaccess 2/13；outbox 1/20 | 红 | 与 HEAD 相同 |
| L2 | listaccess 1/14；outbox 1/20 | 红 | 与 HEAD 相同 |
| L3 | listaccess 1/14；outbox 0/21 | 红 | 与 HEAD 相同 |
| N1 | membership 2/32；m3mem 1/44；outbox 1/20 | 红 | 与 HEAD 相同 |
| N2 | membership 1/33；m3mem 1/44；outbox 1/20 | 红 | 与 HEAD 相同 |
| N3 | membership 3/31；m3mem 0/45；outbox 2/19 | 红 | 与 HEAD 相同 |
| N4 | membership 4/30；m3mem 1/44；outbox 2/19 | 红 | 与 HEAD 相同 |
| N5 | membership 2/32；m3mem 1/44；outbox 1/20 | 红 | 与 HEAD 相同 |
| N6 | membership 1/33；m3mem 1/44；outbox 1/20 | 红 | 与 HEAD 相同 |
| N7 | membership 1/33；m3mem 0/45；outbox 0/21 | 红 | 与 HEAD 相同 |
| N8 | membership 1/33；m3mem 0/45；outbox 0/21 | 红 | 与 HEAD 相同 |
| N9 | membership 3/31；m3mem 1/44；outbox 1/20 | 红 | 与 HEAD 相同 |
| N10 | membership 2/32；m3mem 0/45；outbox 1/20 | 红 | 与 HEAD 相同 |
| N11 | membership 2/32；m3mem 1/44；outbox 0/21 | 红 | 与 HEAD 相同 |
| T13 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T14 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T15 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |
| T16 | guards 2/68；outbox 1/20 | 红 | 与 HEAD 相同 |

与 S2 当时相比，真库文件的计数多了 S3 的三格（`outbox x/21`），守卫单测的计数不变（70）；T13 / T14 在最终 head 上另被守卫格杀死（S3 把两个增删负责人的写加进了接线格）。

### 收尾.4 清库

- 删除（按名字逐个，都是本轮建的）：`pr3b_s2s3_merge`、`pr3b_s2s3_dev`、`pr3b_s2s3_mut`、`pr3b_s2s3_final`。
- 开工前就已存在的另一个库不是本轮建的，没有动。

### 收尾.5 给 S4 的注记

- worker 读到的 `payload.eventId` 就是事件行的 id；N1 的状态事件 payload 为 `{}`，`actor_id` 是操作者，`occurred_at` 与同批的负责人事件相同。
- `deleted` 族的任务行已软删：读法按设计 §7.4 的 `buildTaskByIdAnyStateCondition`（改任务 B 的模块，`[own-3b-17]`，§13-Q14 仍待裁）。
- outbox 唯一的 INSERT 是 `insertTaskNotificationDeliveries`；S5 的两个扫描复用它与 `resolveTaskDeliveryChannelsForOrg` 的判据。
- `seedOutboxRow` 已在夹具里；`dropTaskM4Fixtures` 会按前缀删集成行。
- PR-3a 的修复提交组到位后，S7 前按设计 §14.0 再重叠一次，并重跑本节全部命令。
- 设计 §13-Q21（R01、R04、R13 的状态）与 §13-Q22（N1 的收件人按写后集合）待 owner 答复；在此之前标签与取值不变。

## S4 投递 worker

### S4.1 基座

| 项 | 值 |
|---|---|
| 起点 | `4f4204aaa1`（S3 收尾之后，工作树干净） |
| 标签与设计提交 | `4be7b6d583`（R01、R04、R13 改标 `RULED(2026-10-07)`；设计修订 3） |
| 代码提交 | `42b9761729`（`task-access.ts` 的任意状态按 id 构造器）、`5e40a0adfe`（worker 与结果计数器）、`f049648bc2`（绿线之后，只改 worker 文件头的注释，S4.8 第 16 条） |
| 测试提交 | `026ae28236`（worker 单测、夹具、真库文件、三处登记）、`37e59642dd`（真库格的 worker 时钟取在写入之后，S4.8 第 9 条；这条提交在本地改过一次提交说明里的格数，未推送） |
| PR-3a | 仍是 S-merge 合入的 `d940fa8745`。PR-3a 分支此后有一组闸审修复（其中一条收紧了在职查询的账户判据，函数签名不变），并在本片进行期间被重建为一个提交（S4.11 末条）；本片按要求没有合入，留给 S7 前的第二次重叠。本片的在职格用的是两种判据下都不在职的情形（S4.5），重叠后仍应成立 |
| 裁决 | owner 口径（2026-10-07 的裁决，2026-10-08 转达）：R01、R04、R13 都已裁。§13-Q21 关闭；§13-Q10 只剩落锁一事；§13-Q14 与 §13-Q22 仍待答，按缺省交付 |

### S4.2 交付内容

路径省略前缀 `packages/core-backend/`。

| 文件 | 内容 |
|---|---|
| `scripts/ops/global-history-flag-manifest.mjs`（`4be7b6d583`） | 调度与 worker 两个开关的 `purpose` 里，R13 一句改写为它裁定的内容（M4 不做硬删与清理作业，保留期另行裁定；账本行因此一直保留），标签改为 `RULED(2026-10-07)` |
| `docs/development/task-m4-pr3b-backend-design-20261001.md`（`4be7b6d583`） | 修订 3：§12 的 R01、R04、R13 改标已裁，原 `[R04] [D8]` 一行拆开（`[D8]` 仍是假设）；§11.0 写明 R01 的门号与新行在只改锁的 PR 合并之前一律候选、未计分；§1、§5.1、§9.2、§14 S7 的 R13 句改为裁定的内容；§13-Q21 关闭，§13-Q10 收窄到落锁，§13-Q14 注明已裁的 R04 只覆盖 `buildTaskByIdCondition`。取值未改 |
| `src/tasks/task-access.ts`（`42b9761729`） | 私有 org 生成器改为 `taskOrgClauseWith(rowState)`，`taskOrgLiveClause()` 传 `tasks.deleted_at IS NULL`，既有输出逐字节不变；新导出 `buildTaskByIdAnyStateCondition`（`tasks.id = $1 AND (tasks.org_id = $2) AND TRUE`），只供 worker 的 `deleted` 事件族读软删行。门 1 的 org 子句文本在源码里仍只有一处（生成器的模板字面量），新注释不含它（`ASSUMPTION(task-m4): [own-3b-17]`，§13-Q14） |
| `tests/unit/task-access.test.ts`（210 → 214 格） | 新构造器的全文与参数；org 子句恰一次、无存活条件、只用 `$1` / `$2`；与存活版只差行状态条件；源码里 org 子句文本恰一处且在生成器的模板字面量里，所有构造器的输出各含一次 |
| `src/services/task-notification-delivery-worker.ts`（新，`5e40a0adfe`） | S4.3 |
| `src/metrics/metrics.ts` | `tasks_notification_deliveries_total{outcome}` 计数器，五个结果在登记时置零（`[own-3b-11]`）；leader gauge 与积压 gauge 属 S5 |
| `tests/unit/task-notification-delivery-worker.test.ts`（新，15 格） | S4.4 |
| `tests/integration/task-m4-delivery.db.test.ts`（新，24 格） | S4.5；三处登记：`vitest.config.ts` exclude、`.github/workflows/tasks-realdb.yml`、文件顶部 `assert-rbac-optional-off` |
| `tests/helpers/task-m4-fixtures.ts` | `FakeTaskDeliveryChannel`（每个 worker 一个，记录每次 prepare / send 的投递 id 与自己的标签；可编程的 prepare / send 答复，可挂在 deferred 上，可每次发送推进步进时钟）、`steppedClock`、`deferred`；`seedOutboxRow` 多收 `next_attempt_at`、`created_at`、两个 claim 列与原样 JSON 的 payload |

### S4.3 worker 的行为（设计 §3.3、§7）

一批（`runBatch`）：

1. 两条清扫（设计 §7.2 原文）：`sending` 且续租后的租约已过 ⇒ `outcome_unknown` / `lease_expired_after_send_started`，保留 `claim_worker_id`，永不重发；`pending` / `retrying` 且次数用尽、无活租约 ⇒ `failed` / `attempts_exhausted`，`redelivery_safe = (channel = 钉钉通道名)`。跨 org、跨通道。
2. 一条 claim：到期、次数未尽、无活租约、通道已注册（`channel = ANY($5)`）的行，先取提醒与汇总两族，再按 `next_attempt_at, created_at, id`；`FOR UPDATE SKIP LOCKED`；批租约、`attempt_count + 1`，不改 `status`。结果经 `orderClaimedDeliveries` 重排。
3. 逐行：开始一行之前，`stopping()`、调用方给的 `deadline`、或这一行的批租约剩余不足 `TASK_DELIVERY_ROW_RESERVE_MS`（30 s）任一成立就不再开始新行。一行的顺序：payload 检查（`parseTaskNotificationPayload`，以及 payload 是否属于本行）→ `channel.prepare()` → 物化（S4.3 下表）→ 再看一次 `stopping()` → 栅栏（`sending`，租约续成 15 s 的 `sendLease`，五个合取：id、持有者、次数、`pending`/`retrying`、批租约仍有效）→ 唯一一次 `send` → 一条终态 CAS（栅栏后从 `sending`，栅栏前从 `pending` / `retrying`，都带持有者与次数）。终态全部经 `classifyTaskDeliveryOutcome` 判定；`retrying` 的 `next_attempt_at = now + computeTaskDeliveryBackoffMs(attempt_count)`；`failed` 置 `redelivery_safe`。栅栏或终态 CAS 为 0 行 ⇒ `lost-lease`，不覆盖、不发送，记 warn（只有 id）。
4. 批末把没开始的行与栅栏前因停机退出的行一次退还：`attempt_count − 1`、清空租约，CAS 带持有者与次数。

`runUntilIdle({ budgetMs, stopping })`：连续跑批，直到某批 claim 数少于批大小、注入时钟上的预算用完、或 `stopping()`；每批把预算的截止时刻作为 `deadline` 传下去。

发送时物化（设计 §4.6、§7.4；每一项判定都经既有纯函数）：

| 族 | 读 | skip（`last_error`） |
|---|---|---|
| 共同 | `findActiveOrgMembers(行的 org, [收件人])`；事件族与清单族另判 `isTaskEventNotificationStale(created_at, now)` | 不在职 `recipient_inactive_in_org`（`RULED(2026-10-07): [R17]`）；超过 24 h `event_stale`（`[own-3b-14]`） |
| `task_event` | 非 `deleted` 事件经 `buildTaskByIdCondition`，`deleted` 事件经 `buildTaskByIdAnyStateCondition`；`loadRowRoles`（含清单身份）→ `can(roles, 'view')` | 任务行不存在 `task_missing`；不能再看 `recipient_lost_access` |
| `task_reminder` | `buildTaskByIdCondition`（含 `remind_at`、状态、截止四列）；floor = 该任务 `created` / `remind_changed` 事件的最大 `occurred_at`；`loadAssignees` | 行不存在或 `isReminderSkippedByTaskState` 为真 `reminder_stale`；没有 floor 或 `isTaskReminderDue` 为假 `reminder_window_elapsed`；收件人不在 `resolveReminderRecipients` 之内 `recipient_lost_access`（`RULED(2026-10-07): [R06]`） |
| `task_daily` | PR-3a 的 `getTaskSettings`；`resolveDailyDigestOccurrence(now, payload.timeZone)`；`buildTaskDailyDigestCondition` 的行集（`due_at NULLS LAST, due_date, id`，取 `TASK_DIGEST_MAX_ITEMS + 1` 行并 `count(*) OVER ()`） | 设置已关或时区已变 `digest_settings_changed`；日期不符或不在窗口 `digest_window_elapsed`；行集为空 `empty_digest`（`RULED(2026-10-07): [R07]`） |
| `task_list_event` | `buildTaskListByIdCondition`（已归档也取得到）；`resolveListArchiveNotificationRecipients` | 行不存在 `list_missing`；收件人不再是清单创建人 `recipient_lost_access` |

开关：worker 在构造时读一次 `TASKS_ENABLED` 与 `TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED`（都经既有的严格 `'true'` 读函数，没有新字面量），两者不都为 `'true'` 时 `runBatch` / `runUntilIdle` 不发任何语句、不调通道、返回零（`[own-3b-26]`）。`createTaskDeliveryChannelsFromEnv` 在本片不注册任何通道（钉钉通道在 S6 接上），所以由它构造的 worker 不会 claim 到任何行。worker 不开事务、不取咨询锁；每条语句自动提交。

### S4.4 单测 `task-notification-delivery-worker.test.ts`（15 格）

模块 `db/pg` 被替换成调用即抛的桩，worker 只用注入的、按语句文本应答的查询函数；结果计数器用记录用的替身。

| 组 | 格 | 内容 |
|---|---|---|
| 开关 | 4 | 十种取值的真值表（只有两者都严格为 `'true'` 才启用）；关闭时 `runBatch` / `runUntilIdle` 零语句、零通道调用、返回零；缺省读构造那一刻的 `process.env`；`stopping` 已为真、或本 worker 的一批还在跑时零语句 |
| 构造 | 3 | 缺省与夹取（批 50 / `[1, 200]`，批租约经 claim 的第 6 个绑定值看到 `[60 s, 600 s]`）、缺省 worker id 的形；拒绝非数组的通道表、缺 `prepare` 的通道、重复注册、非法 `maxAttempts` / `sendLeaseMs` / 空 worker id；本片从环境不注册通道 |
| 语句与一行的步骤 | 6 | 顺序恰为 清扫 ×2 → claim → prepare → 五次物化读 → 栅栏 → send → 终态；claim 的全部片段与绑定值；栅栏全文与绑定值；栅栏后终态只从 `sending`、栅栏前只从 `pending` / `retrying`；抛出的 prepare / 物化 / send 只记固定码，异常文本不进任何语句；退还的全文与绑定值 |
| 计数器 | 2 | 每次终态写加一、两条清扫按行数加、`lost-lease` 不加；`tasks_notification_deliveries_total` 已登记且五个结果各有零样本 |

### S4.5 真库文件 `task-m4-delivery.db.test.ts`（24 格）

org 前缀 `org_tasks_m4deliv_`（与既有各文件的前缀互不为前缀）。claim 与两条清扫都跨 org，所以每格前清空整张 `task_notification_deliveries`（设计 §11.1；lane 逐个文件串行），每格只断言自己播种或产生的行。行经四个规划器播种（与 producer 同一行形），或由 producer 自己写出（完成、删除、归档三格）。时钟全部注入（步进），没有 sleep；并发格用 deferred 固定交错。

| 组 | 格 | 内容 |
|---|---|---|
| 开关 | 2 | 七种不都为 `'true'` 的环境与缺省环境下，过期的 `sending` 行、次数用尽的行、到期行逐列不变，通道零调用；两者都为 `'true'` 时三行分别成为 `outcome_unknown`、`failed`、`sent`（正控）。开关开着而没有注册通道：claim 不取任何行，到期行逐列不变 |
| claim / 栅栏 / 终态 | 9 | 一行的全部列（发送那一刻行已是 `sending`、持有者为本 worker、租约 = 栅栏时刻 + 15 s；之后 `sent`、`delivered_at`、各列清空）与正文；两 worker 按设计 §11.6 的固定交错（各 5 行，每行恰发一次，`lostLease = 0`）；批租约在栅栏前用完 ⇒ 该 worker 不发送，下一次 claim 发一次（次数 2）；栅栏前崩溃；栅栏后崩溃（清扫写 `outcome_unknown`、零发送，原 worker 的终态 CAS 0 行，此后永不再 claim）；慢通道（12 行、批 5、每次发送 12 s：4 批、退还 6 行、每行次数 1）；优先级（60 行更早的事件之后到期的提醒在第一批 50 行里且最先发出，事件行发出 49）；新鲜度（事件族与清单族 25 h ⇒ `event_stale`、23 h ⇒ 发送）；停机（已过栅栏的那行完成，其余退还且次数回退；prepare 进行中转为停机的行不过栅栏） |
| 第二租户（门 1 M4 子集，候选） | 1 | org 甲的三行分别指向 org 乙的活任务（完成事件）、已软删任务（删除事件）与清单 ⇒ `task_missing` / `task_missing` / `list_missing`，零发送；同样三行放在 org 乙 ⇒ 都发送（正控）。负控（`runSourceMutant`，每次 lane 都跑）：门 1 的 org 子句改成恒真 ⇒ org 甲的两条任务行都被发送（新构造器同样被打到）；PR-3a 的清单 org 子句改成恒真 ⇒ 清单行被发送；两次恢复都逐字节相同 |
| 次数、退避、终态 | 2 | 毒行：次数用尽 ⇒ `failed` / `attempts_exhausted` / `redelivery_safe`；持有活租约的同类行不动；payload 非对象 ⇒ `payload_invalid`、未知 kind ⇒ `unknown_kind`、payload 不属于本行 ⇒ `payload_invalid`，都在 prepare 之前一次即终；退避：可重试拒绝依次在 +1 min、+5 min、+15 min、+1 h 重试（提前 1 ms 不 claim），第 5 次 ⇒ `failed` 且 `redelivery_safe`；`outcomeUnknown` ⇒ `outcome_unknown` 且之后不再 claim；prepare 给出 skip ⇒ `skipped`、零发送；send 抛错 ⇒ `outcome_unknown` / `send_unclassified` |
| 发送时检查 | 5 | R17：成员行停用或账户停用 ⇒ `recipient_inactive_in_org`；端到端：一次完成由 producer 写出的三行（创建人、关注人、清单只读成员）都发出一次，标题里的 markdown 字符已转义，payload 的 `eventId` 是 `completed` 事件；失去全部角色（关注人退出、清单成员被移除）⇒ `recipient_lost_access`，仍有角色者发送；软删之后 `deleted` 事件的两行发出（经任意状态构造器），删除之前的一行 ⇒ `task_missing`；清单族：归档写出的行发给清单创建人，非创建人 ⇒ `recipient_lost_access`，清单不存在 ⇒ `list_missing` |
| 提醒（M4-c 的 worker 一半） | 1 | 未完成负责人与零负责人任务的创建人收到（带截止行的正文钉死）；已完成、已软删、已改期 ⇒ `reminder_stale`；自己那一行已完成的负责人 ⇒ `recipient_lost_access`；worker 在窗口之后才到 ⇒ `reminder_window_elapsed` |
| 每日汇总（M4-c 的 worker 一半） | 4 | 内容：逾期、今天、明天三项按截止顺序，后天、本人已完成的 `all` 任务、已完成的任务都不在内；空汇总：一行 `skipped` / `empty_digest`、零发送，行形（`task_daily`、`source_id` 为收件人、`assignee`、payload 恰为三个键、`delivered_at` 空、`redelivery_safe = false`、次数 1）；同日后到的到期任务：经 producer 唯一的 INSERT 再写一次（S5 的扫描写行用它）⇒ 0 行新行、零发送、当天仍只有那一行；设置关闭或时区改变 ⇒ `digest_settings_changed`，日期不符或 worker 在窗口之后 ⇒ `digest_window_elapsed`；`TASK_DIGEST_MAX_ITEMS + 3` 项 ⇒ 20 行与「另有 3 项」 |

汇总格的时钟（S4.8 第 10 条）：内容 SQL 读数据库的 `now()`，窗口判定读注入时钟。这些格选一个固定偏移的时区（`Etc/GMT±N`），使数据库当前时刻在该时区是 09:MM，注入时钟取写入之后的数据库时刻；两者同在当地 09:00 起两小时的窗口里，离当地午夜也远，不需要翻转点等待。

### S4.6 命令与结果

绿线的 head 是 `37e59642dd`；下表的运行都在它上面（运行前后工作树都干净）。之后只有本文件与 `f049648bc2`（worker 文件头的注释，不改代码），后者另跑了本节末段的三项。运行严格串行：真库文件里的负控会原地改写 `task-access.ts` / `task-list-access.ts`，lane 运行期间不跑任何别的东西。真库环境：`EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；绿线用的一次性库从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully，最后一条是 M4 迁移。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（临时配置同 S3 收尾：继承本包配置，`module: esnext`、`moduleResolution: bundler`、`noUnusedLocals`；`include` 为本片新增或改动的四个测试文件、夹具，以及 `task-m4-outbox.db.test.ts`（它调用改过签名的 `seedOutboxRow`）） | 测试文件 0 条诊断；本片改动的三个 `src` 文件（worker、`metrics.ts`、`task-access.ts`）0 条；其余 47 条都在本 PR 没有改的 `src` 文件里，与 S3 收尾记录的这套编译选项下的既有提示相同 |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **36 files / 1421 passed**（S3 收尾的 1402 加 `task-access` 4 格与 worker 单测 15 格）；门 20 harness（`task-pure-no-io`）5/5，新导出 `buildTaskByIdAnyStateCondition` 在它的自动发现范围内 |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 18 个文件，新建的库） | 三遍都是 **18 files / 728 passed**（63 s / 61 s / 62 s）；三遍逐文件计数相同；与 S3 收尾相比，既有 17 个文件逐文件不变，多出 `task-m4-delivery` 24 格；每遍都打印了第二租户格两个负控的输出 |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed**（门 1 的单点 org mutant 格在内，`task-access.ts` 改动后照常变红再恢复） |
| 全量单测（一遍，不设 `DATABASE_URL`） | 5 files failed / 1083 passed / 172 skipped（1260）；44 tests failed / 18926 passed / 1712 skipped（20682）；124 s。失败的 5 个文件与 S1.5、S3 收尾是同一组：`multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}`（22 / 1 / 4 / 16 格，OS 临时目录 `EEXIST`）与 `attendance-admin-plugin-lib-dist-layout-boot`（1 格，规范检出里自指的 `node_modules` 链接，`ELOOP`）；没有任务线文件失败，worker 单测 15 格在内全绿 |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 38/38；101/101（R13 的两段 `purpose` 改写后） |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| `task-ci-coverage-enumeration` | 4/4（磁盘、exclude、lane 三个集合仍相等，新文件含 `assert-rbac-optional-off`） |
| 源码 token 普查（manifest 测试的发现口径） | `TASKS_ENABLED` ×7、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` ×2、另两个开关各 ×1、`TASKS_SCHEDULER_INTERVAL_MS` ×3；多出的三处都在 worker 的注释与读点说明里，都已登记 |
| 门 15（对 S4 在 `src` 里新增的行 grep 其他线的名字） | 零命中 |
| 门 7（任务域源码的咨询锁字面量） | worker 不含取锁字面量；多重集不变 |
| 门 20 静态（`task-access.ts` 的改动行里 `from 'pg'`、`crypto`、`Intl.DateTimeFormat`、`from '../db`） | 零命中 |
| values-free（本片改动的每个文件：IPv4 字面、主机名后缀、本机路径与机器名） | 零命中 |
| 三版裁决包扫描 | 本片改动的每个文件（含设计与本文件）三版都退出 0 |
| 注释修正之后（`f049648bc2`） | type-check 0 errors；worker 单测与门 20 harness 20/20；三版扫描对 worker 文件都退出 0；门 15 零命中。代码未变，所以上面的 lane、鉴权门、全量单测与 S4.7 的变异结果仍对应同一份代码 |
| 清库 | 本片建的两个库（开发与变异共用一个、绿线一个）都已按名字删除；跑完后绿线库里本文件前缀下的任务、清单、集成、设置、成员行与 outbox 行都是 0 行。开工前就已存在的另一个库不是本片建的，没有动 |

### S4.7 变异（42 个，全部变红）

驱动与 S2.7 相同：先断言目标文件与 `HEAD` 的 blob 逐字节相同 → 备份 → 改动（每个 needle 在文件里恰出现一次）→ 跑所属测试（单测与 / 或变异库上的新真库文件）→ 从备份恢复 → 断言与备份逐字节相同且 sha256 等于 `HEAD` 的 blob；结束时目标文件 `git status` 为空，驱动退出 0。不使用 `git checkout` / `reset` / `stash` / `clean`；驱动与日志不入库。变异轮在 `37e59642dd` 上跑。正控：三个所属单测文件未变异时 15 / 214 / 94 全绿；真库文件在同一 head 上的 lane 三遍（S4.6）与时钟修正后的连续 5 遍都是 24/24（驱动的首次正控跑在时钟修正之前，那一遍的空汇总格红，即 S4.8 第 9 条所述）。「红 / 余」是该 mutant 下所属文件的失败格数与通过格数；每个 mutant 的失败格名都逐一核对过，是它所针对的格。

| id | mutant | 红 / 余 | 结果 | 恢复 |
|---|---|---|---|---|
| W01 | claim 去掉租约谓词（设计 §11.9 负控一） | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W02 | W01 之上再把栅栏削到只剩 id（设计 §11.9 负控二） | delivery 3/21 | 红 | 与 HEAD 相同 |
| W03 | 清扫把过期的 `sending` 改回 `pending`（崩溃后格的负控） | delivery 2/22；worker 0/15 | 红 | 与 HEAD 相同 |
| W04 | 退还不减次数（慢通道格的负控） | delivery 2/22；worker 1/14 | 红 | 与 HEAD 相同 |
| W05 | claim 去掉优先项 | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W13 | 栅栏去掉「批租约仍有效」合取 | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W15 | 栅栏不续租（保留批租约） | delivery 2/22；worker 1/14 | 红 | 与 HEAD 相同 |
| W16 | 终态 CAS 去掉状态合取（会覆盖清扫写下的 `outcome_unknown`） | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W20 | 次数用尽的清扫永不命中 | delivery 2/22 | 红 | 与 HEAD 相同 |
| W33 | claim 不看已注册通道 | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W40 | `sent` 不写 `delivered_at` | delivery 1/23 | 红 | 与 HEAD 相同 |
| W30 | 去掉每行开始前的租约预留检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W31 | 去掉栅栏前的停机检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W32 | 去掉开始一行前的停机检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W34 | 不读 worker 开关 | worker 3/12；delivery 1/23 | 红 | 与 HEAD 相同 |
| W35 | 不读 `TASKS_ENABLED` | worker 2/13；delivery 1/23 | 红 | 与 HEAD 相同 |
| W36 | 关闭的 worker 照跑语句 | worker 1/14；delivery 1/23 | 红 | 与 HEAD 相同 |
| W37 | 终态写不计数 | worker 1/14 | 红 | 与 HEAD 相同 |
| W39 | prepare 抛错时把异常文本写进 `last_error` | worker 1/14 | 红 | 与 HEAD 相同 |
| W17 | send 抛错按可重试处理（重发风险） | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W18 | 不退避 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W19 | `failed` 不置 `redelivery_safe` | delivery 2/22 | 红 | 与 HEAD 相同 |
| W38 | 读不出的 payload 被重试 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W21 | payload 不必属于本行 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W06 | 去掉事件新鲜度检查（设计 §11.9） | delivery 1/23 | 红 | 与 HEAD 相同 |
| W41 | 新鲜度按 `next_attempt_at` 而不是 `created_at` 算 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W12 | 去掉发送时在职复核（R17） | delivery 1/23；worker 1/14 | 红 | 与 HEAD 相同 |
| W22 | `deleted` 事件只读活任务 | delivery 2/22 | 红 | 与 HEAD 相同 |
| W23 | 所有事件都读软删任务 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W24 | 事件族去掉 view 检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W11 | `isReminderSkippedByTaskState` 旁路（设计 §11.9） | delivery 1/23 | 红 | 与 HEAD 相同 |
| W25 | 提醒族去掉收件人检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W42 | worker 不调 `isTaskReminderDue` | delivery 1/23 | 红 | 与 HEAD 相同 |
| W26 | 汇总族去掉设置检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W27 | 汇总族去掉日期检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W28 | 汇总族去掉窗口检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W09 | 空汇总删掉这一行而不是留下 `skipped`（设计 §11.9） | delivery 1/23 | 红 | 与 HEAD 相同 |
| W29 | 清单族去掉创建人检查 | delivery 1/23 | 红 | 与 HEAD 相同 |
| W10 | `isTaskReminderDue` 去掉窗口（`task-reminders.ts`，TS 侧；设计 §11.9） | delivery 1/23；reminders 2/92 | 红 | 与 HEAD 相同 |
| A1 | 任意状态构造器自写一段恒真的 org 子句（`task-access.ts`） | access 4/210；delivery 1/23 | 红 | 与 HEAD 相同 |
| A2 | 任意状态构造器只取活行（`task-access.ts`） | access 3/211；delivery 2/22 | 红 | 与 HEAD 相同 |
| A3 | 存活子句也取软删行（`task-access.ts`） | access 11/203；delivery 1/23 | 红 | 与 HEAD 相同 |

门 1 的单点 org mutant 与 PR-3a 的清单 org mutant 不在上表：它们是真库文件自己的负控，每次 lane 都在第二租户格里跑（S4.5）。对 `task-access.ts` 的三个驱动 mutant 都避开了那段 org 子句文本，以免与文件自己的负控相互干扰。

### S4.8 偏差与说明

1. **开关在 worker 自己身上**（`ASSUMPTION(task-m4): [own-3b-26]`）：设计 §3.3 的构造函数没有环境入参，§9.1 把 worker 开关放在调度器注册投递 job 那一步（S5）。S4 还没有调度器，而本片的要求是开关不严格为 `'true'` 时 worker 什么都不做，所以 worker 在构造时经既有读函数读一次 `TASKS_ENABLED` 与本开关（`env` 选项，缺省 `process.env`），不都为 `'true'` 时连清扫都不跑。S5 的 `resolveTaskNotificationDeliveryJob()` 仍按设计在开关关闭时返回 `null`；两处用同一读函数，结论一致。
2. **`prepare` 的入参多一个投递 id**：设计 §3.3 写的是 `{ orgId, recipientUserId }`，§11.1 又要求 spy 记录每次 prepare 与 send 的投递 id。入参因此带上 `deliveryId`（S6 的通道可以用于自己的日志，不得用于别的）。「哪个 worker 发的」由每个 worker 一个假通道（标签）表达，worker id 不传给通道。
3. **`createTaskDeliveryChannelsFromEnv` 在本片返回空表**：钉钉通道属 S6（设计 §14 S6「接真通道」）。单测与真库各有一格钉住「本片不注册任何通道」，S6 接上通道时这两格要按开关改写（S4.11）。
4. **payload 必须属于本行**（`[own-3b-27]`）：kind 等于 `source_type`，任务 / 清单 id 等于 `source_id`（汇总行的 `source_id` 等于收件人），否则 `failed` / `payload_invalid`，与解析失败同口径、不重试。设计 §7.4 只写 payload 形状检查；producer 写出的行总满足这一条。
5. **提醒行没有 floor**（`[own-3b-28]`）：发送时读不到该任务的 `created` / `remind_changed` 事件 ⇒ `reminder_window_elapsed`，与扫描侧「没有 floor 就不入队」同一条规则。
6. **worker 自身步骤的错误码**（`[own-3b-29]`）：`payload_invalid`（不属于本行）、`channel_not_registered`、`prepare_failed`、`prepare_result_invalid`、`materialize_failed`、`send_unclassified`；`last_error` 从不写异常文本。通道返回的错误文本原样（截到 1000 字符）进 `last_error`，脱敏由通道负责（设计 §8.5，S6）。
7. **共同检查的顺序**：按设计 §7.4 的列法，在 prepare 之后依次是在职、新鲜度、各族，所以超过 24 小时的事件行仍会先调一次 `prepare`（取 token），但不会发送。
8. **设置经 PR-3a 的 `getTaskSettings` 读取**（设计 §7.4「不另写查询」）：这个函数用共享连接池，不经 worker 注入的语句函数；单测因此不含汇总族，汇总族的格都在真库文件里。
9. **真库格的 worker 时钟取在写入之后**（`37e59642dd`）：producer 与扫描的 INSERT 写的行，`next_attempt_at` 取数据库的 `now()`（到微秒），而 JS Date 只到毫秒；同一毫秒内读出的数据库时刻排在那一行之前，claim 会跳过它。首版的空汇总格因此 5 次里红了 2 次。修正后，取这类行的六格用「数据库时刻 + 1 秒」作 worker 时钟，连续 5 遍 24/24。这是测试取时的问题，不是 worker 的问题；生产的 DB 锚定时钟（S5）遇到同一毫秒写入的行时，该行顺延到下一个 tick。
10. **汇总格的时区**：设计 §11.1 写的是距当地午夜 2 分钟以内时等待越过再跑。本片改为挑一个固定偏移的时区，使数据库当前时刻落在当地 09:MM（S4.5），内容 SQL 与注入时钟在同一当地日期、同一窗口里，不需要等待。设计 §11.5 的「上海与 Kiritimati 两时区」格属于 S5 的汇总 tick。
11. **「同日后到」格的第二次写**：S4 还没有扫描，第二次 tick 用规划器加 producer 唯一的 INSERT（`insertTaskNotificationDeliveries`，S5 的扫描写行也用它）代替；两次写都在窗口之内。S5 有了扫描之后，这一格可以改经真正的 tick 再跑一次。
12. **格的合并**：设计 §11.6 的退避、`outcomeUnknown` 与 skip 合成一格，另加 send 抛错；毒行一格同时含持有活租约的同类行与不属于本行的 payload；第二租户一格同时含删除事件族与 org 乙的正控；全 OFF 一格里 `startTaskScheduler()` 返回 `null` 的部分属 S5。慢通道格断言确切数字（4 批、退还 6 行），比设计的「至少一批退还了行」更紧。
13. **文件数**：设计 §14 S4 写「文件数 6 + 三处登记」；实际 7 个（多 `tests/unit/task-notification-delivery-worker.test.ts`，与 S2 加 producer 单测同理），另加两个登记文件；R01 / R04 / R13 的改标另动了 manifest 与设计。
14. **结果计数器的缺省**：不注入时用 `metrics.ts` 登记的那个计数器（S5 构造 worker 时不必另传）；两条清扫按行数计入（`outcome_unknown` / `failed`），`lost-lease` 不计。
15. **第三版扫描**：本片起每个改动文件另跑第三版扫描；本片改动的每个文件三版都退出 0。PR-3b 不改任务 D 的文本（S2.8 第 6 条的做法）；PR-3a 分支对任务 D 注释的改写随 S7 前的重叠进入本分支。
16. **两处判断留在服务里**：设计说 worker 的判定不在服务里散写（门 20）。本片有两处结构性判断写在 worker 里：payload 是否属于本行（`payloadMatchesRow`，第 4 条）与每行开始前的租约预留比较（常量取自协议模块）；其余判定都经 `src/tasks/` 的纯函数。worker 文件头的说明按此写明（`f049648bc2`，只改注释，S4.6 末段）。若要把前者移到解析器旁边，需要同片加单测与 harness 覆盖，记给 S7 收口。

### S4.9 owner 问题的变化

- §13-Q21 **关闭**：R01、R04、R13 已裁；修订 3 与 `4be7b6d583` 改标，R13 的措辞改为它裁定的内容，取值不变。
- §13-Q10 **收窄**：门号已随 R01 裁定（M4-a→门 23、M4-b→门 24、M4-d→门 25、M4-c→门 8 子集）；只剩新行由只改锁的 PR 写进锁、其合并另需点名。在那之前本 PR 的格仍是候选、未计分。
- §13-Q14 **不变，按缺省交付**：`buildTaskByIdAnyStateCondition` 已落地（`[own-3b-17]`）；R04 的裁决只覆盖 `buildTaskByIdCondition`。owner 不同意时的退路仍是 `deleted` 事件族不通知。
- §13-Q22 **不变**（N1 的收件人按写后集合）。
- 新增自选取值 `[own-3b-26]`…`[own-3b-29]`（S4.8 第 1、4、5、6 条）：都是本 PR 的实现取舍，不是新的 owner 问题；S7 收口时补进设计 §12 的表。

### S4.10 NOT RUN

- S5 的格：调度 tick（提醒扫描、汇总扫描、跨页、TS/SQL 对拍）、leader 锁与计数 job、leader 连接被终止、`startTaskScheduler()`、`stop()`；设计 §11.5 的两时区格。
- S6 的格：钉钉通道的身份、配置、出站地址、token、发送分类；钉钉通道的注册；任何网络。
- 真机 / staging / 任何 `TASKS_*` 开关在环境里打开：按设计不做。
- `apps/web` 测试：无前端改动。
- 与 PR-3a 的第二次重叠：按设计 §14.0 留到 S7 之前（S4.1；PR-3a 分支在本片进行期间已被重建，见 S4.11 末条）。
- 变异在本工作树上跑（与 `HEAD` 的 blob 比对、逐字节恢复），不在一次性检出里，S1 起同一做法；变异库与开发库是同一个一次性库，绿线用另一个新建的库。
- 设计 §9.5 的 `metrics-integration.test.ts`：仓库里没有这个文件，这一行不适用；计数器的登记由 worker 单测的一格钉住。

### S4.11 给 S5（调度器）与 S6（钉钉通道）的注记

- **S5 构造 worker**：`new TaskNotificationDeliveryWorker({ channels: createTaskDeliveryChannelsFromEnv(), now: DB 锚定时钟 })`；worker 已在构造时读开关，`resolveTaskNotificationDeliveryJob()` 按设计在开关关闭时返回 `null`（可直接看 `worker.enabled`）。job 体是 `runUntilIdle({ budgetMs: TASK_DELIVERY_TICK_BUDGET_MS, stopping })`。
- **S5 停机**：worker 在 claim 之前、每行开始之前、栅栏之前都看 `stopping()`；栅栏前退出的行在批末退还、次数回退；已过栅栏的那一行照常写终态。
- **S5 时钟**：DB 锚定时钟只到毫秒，同一毫秒内写入的行（`next_attempt_at` 到微秒）本 tick 不会被 claim、下一个 tick 才取；真库格构造 worker 时钟要在写入之后留出余量（参照本片的 `clockAfterWrites`）。
- **S5 扫描**：两个扫描写行用 `insertTaskNotificationDeliveries` 与 `resolveTaskDeliveryChannelsForOrg` 的判据（S2.10）；「同日后到」格可以改经真正的 tick 重跑。`metrics.ts` 还缺 leader gauge 与积压 gauge（设计 §4.1）；`TASKS_ENABLED` 条目的 `purpose` 追加一句（设计 §9.2）。
- **S6 注册**：`createTaskDeliveryChannelsFromEnv(env)` 在 `isTaskDingTalkWorkNotificationEnabled(env)` 为真时加入钉钉通道；同片改写本片钉住「不注册」的两格（单测 `no channel is registered from the environment in this slice`、真库 `the worker switch on but no channel registered`）。
- **S6 合同**：通道名必须是 `TASK_NOTIFICATION_CHANNEL_DINGTALK`；`prepare` 收到 `{ deliveryId, orgId, recipientUserId }`，栅栏前的各支以 `{ ok: false, result }` 返回固定码，`send` 闭包里只有一次发送；通道返回的错误文本会原样（截到 1000 字符）进 `last_error`，脱敏必须在通道里做完；`failed` 行的 `redelivery_safe` 由 worker 按通道名置真，`outcomeUnknown` 由通道标明、worker 不改判。空白 `baseUrl` 的规范化见 S1.9。
- **S7 重叠**：PR-3a 分支在本片进行期间被重建为一个提交 `68e40323bd`（父提交是 main 的 `cc6ca96ac2`；它的树与重建前分支的最后一个提交逐字节相同，内容未变、历史改写）。它与本分支的共同祖先因此是 `cc6ca96ac2`，不再是 S-merge 合入的 `d940fa8745`。只读预检（`git merge-tree --write-tree --name-only`，不动任何分支）：对重建后的提交，35 个文件冲突（13 个内容冲突、22 个两边新增）；对重建前的最后一个提交（树与重建后的提交相同），零冲突。第二次重叠的做法见 S-merge2（合入重建前的最后一个提交）；S4.8 第 15 条的两处任务 D 注释与在职查询的收紧都随它进入。

## S-merge2 第二次重叠（PR-3a 闸审修复之后的 head）

### S-merge2.1 基座与合并

| 项 | 值 |
|---|---|
| 合并前的 PR-3b head | `fc4fae2bd7`（S4 收尾，工作树干净） |
| 合入的提交 | `03a6527061`：PR-3a 分支被重建之前的最后一个提交，即 `d940fa8745` 之后的 14 个闸审修复提交（在职查询收紧、鉴权门与真库格、任务 D 注释改写、设计与验证 MD）。它的树 `df79fa305c` 与重建后的单提交 `68e40323bd` 的树相同 |
| 方式 | `git merge --no-ff 03a6527061`，合并提交 `1ff2976df8`（父：`fc4fae2bd7`、`03a6527061`）。没有合入分支引用 `claude/tasks-m4-pr3a`（它已被重建为单提交，对它的预检有 35 个文件冲突，见 S4.11）；没有 rebase，没有 checkout / reset / stash / clean |
| 预检 | `git merge-tree --write-tree --name-only HEAD 03a6527061`：退出 0，零冲突 |
| 设计 §14.0 | 这是第二次重叠的内容（PR-3a 的闸审修复全部进入本分支）。PR-3a 若再有提交，S7 前按 §14.0 再叠一次 |

### S-merge2.2 两边都改过的文件（全部自动合并）

| 文件 | PR-3a 一侧（`d940fa8745..03a6527061`） | PR-3b 一侧（`d940fa8745..fc4fae2bd7`） | 处置 |
|---|---|---|---|
| `src/services/task-list-records.ts` | 加入清单项一段的文档注释改写了一句（只写检查顺序） | 归档触点挂 producer（S2） | 自动合并，两段不相邻 |
| `tests/unit/task-records-guards.test.ts` | 个人分组读的分页一格、建任务在职查询的两格（账户判据两个片段、负责人顺序） | producer 接线的守卫格（S2、S3） | 自动合并，两边的格互不相邻 |
| `src/tasks/task-notifications.ts` | 任务 D 的注释改写为规则陈述并带条目 id（含 S4.8 第 15 条那一处） | 文件末尾追加的通道常量、规划器与解析器（S0、S1） | 自动合并 |
| `src/tasks/task-reminders.ts` | 同上（含 S4.8 第 15 条那一处） | 文件末尾追加的扫描条件、汇总到点判定；私有日期 helper 多两个带默认值的形参（S1） | 自动合并 |

复核：对这四个文件，分别比较「每一边自己的改动行」（`git diff` 的增删行）与「合并后相对另一边的改动行」，四个文件、两边都逐行相同（增删行集合的 sha256 相同），即合并没有丢掉、也没有改动任何一边的行。合并后 PR-3b 相对 PR-3a 新 head 的差异仍是同样的 35 个文件、增 8952 行 / 删 40 行，与相对 `d940fa8745` 的差异相同。

### S-merge2.3 随合并进入、与本 PR 相关的 PR-3a 改动

- **在职查询**（`task-org-members.ts#findActiveOrgMembers`）：在 `user_orgs.is_active` 与 `users.is_active` 之外，另要求 `activation_status = 'activated'`，且角色不是 `disabled`（持有 RBAC `admin` 角色的用户按 `admin` 判），与登录的账户判据一致。签名不变；S4 的发送时复核（`RULED(2026-10-07): [R17]`）直接用它。S4 的在职格用的是两种判据下都不在职的情形（成员行停用、账户停用），合并后仍绿（下表 lane）。
- **任务 D 的注释**（S4.8 第 15 条）：PR-3a 对任务 D 注释的改写随合并进入；那是 PR-3a 的内容，本 PR 不改。
- 其余（分组、清单成员、在职的真库格，鉴权门，PR-3a 与任务 D 的设计和验证 MD）不碰本 PR 的代码路径。

### S-merge2.4 合并后的复核

所有命令在 `packages/core-backend` 下（`node --test` 在仓库根），Node 20.20.2，单测不设 `DATABASE_URL`，全部在合并提交 `1ff2976df8` 的树上（运行前后工作树干净）。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **36 files / 1423 passed**。与 S4 的 1421 相比只多 `task-records-guards` 的两格（70 → 72，都是 PR-3a 的）；本 PR 的单测文件逐文件不变（worker 15、producer 19、flags 68、protocol 36、text 32、notifications 51、reminders 94、access 214、list-access 15、membership 34） |
| manifest 测试 | 38/38 |
| 真库 lane 一遍（`tasks-realdb.yml` 的全部 18 个文件；新建的一次性库 `pr3b_s56_1`，从空库全量迁移 426 条，最后一条是 M4 迁移） | **18 files / 753 passed**，67 s。与 S4 的 728 相比多出的 25 格都是 PR-3a 的（groups 36 → 38、list-members 40 → 44、org-members 27 → 46）；本 PR 的三个文件不变（delivery 24、outbox 21、m3-membership 45），第二租户格的两个负控照常打印 |
| 鉴权门（同库；`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| 三版扫描（PR-3b 相对 `03a6527061` 的全部 35 个改动文件） | 三版对全部 35 个文件都退出 0 |
| 清库 | `pr3b_s56_1` 跑完即按名字删除 |

## S5 调度器与启动接线

### S5.1 基座

| 项 | 值 |
|---|---|
| 起点 | `265b975c80`（S-merge2 的文档提交之后，工作树干净） |
| 代码提交 | `f8baa00c5a`（调度器、启动与停机接线、两个 gauge、`TASKS_ENABLED` 条目 `purpose` 的一句） |
| 测试提交 | `b55897a0c9`（调度器单测、真库文件、三处登记、manifest 测试一格）；`37fdd5a214`（变异轮之后加强真库的 `stop()` 一格，S5.7 表后说明） |
| PR-3a | S-merge2 合入的 `03a6527061` |

### S5.2 交付内容

路径省略前缀 `packages/core-backend/`。

| 文件 | 内容 |
|---|---|
| `src/services/task-scheduler.ts`（新） | S5.3 |
| `src/index.ts` | `startOnce()` 在考勤调度那一段之后另起一段 `startTaskScheduler()`（开关不全或没有连接池时返回 `null`，只记一行日志）；`stopOnce()` 在考勤调度的停机任务之后加 `await stopTaskScheduler()`，与其他停机任务一起受 10 s 的关停屏障约束（调度器自己最多等 8 s） |
| `src/metrics/metrics.ts` | `tasks_scheduler_leader{state}`（`leader` / `follower` / `relinquished`，上一个 tick 的结果）与 `tasks_notification_backlog{kind}`（`pending` / `oldest_due_wait_seconds` / `outcome_unknown`，`[own-3b-31]`）两个 gauge，登记时每个标签值置零 |
| `scripts/ops/global-history-flag-manifest.mjs` | `TASKS_ENABLED` 条目的 `purpose` 追加一句：它也是调度器与投递 worker 的前提，点名两个开关（设计 §9.2） |
| `scripts/ops/global-history-flag-manifest.test.mjs` | 一格：`TASKS_ENABLED` 的 `purpose` 点名它所约束的两个开关 |
| `tests/unit/task-scheduler.test.ts`（新，38 格） | S5.4 |
| `tests/integration/task-m4-scheduler.db.test.ts`（新，20 格） | S5.5；三处登记：`vitest.config.ts` exclude、`.github/workflows/tasks-realdb.yml`、文件顶部 `assert-rbac-optional-off` |

### S5.3 调度器的行为（设计 §3.2、§6）

一个 tick（`runTick`；同一实例同时至多一个 tick，`stop()` 之后不再开始）：

1. 读一次数据库时钟（连接池上的 `SELECT now()`），tick 内所有 job 共用以它为起点、随单调时钟前进的时钟（设计 §6.5）。
2. 从连接池取一个专用客户端，**先**挂 `error` 监听，再开事务；事务里只有两句：`SET LOCAL lock_timeout = '<lockTimeoutMs>ms'`（缺省 1000 ms）与 `acquireTasksSchedulerLeaderLock`（取锁语句只在那个 helper 里，门 7 不变）。
3. 取锁在超时内没有成功（SQLSTATE `55P03`，或 `57014`）：回滚、归还客户端、gauge 置 `follower`，什么 job 都不跑，结果 `lock_busy`。其他失败（取不到客户端、`BEGIN` 或取锁语句因别的原因失败、读不到数据库时钟）：结果 `leader_unavailable`（`[own-3b-30]`），客户端若已取到则销毁。
4. 取到锁：gauge 置 `leader`，依次跑提醒扫描与汇总扫描（每个 job 单独 try/catch，失败只记固定码，不影响下一个）；每个 job 开始之前看 `stopping` 与 `leaderLost`。
5. 监听在扫描期间收到错误：置 `leaderLost`、gauge 置 `relinquished`；剩下的扫描不再开始，不提交，客户端以 `release(err)` 销毁，不跑投递，结果 `leader_client_lost`。提交失败同样处理。
6. 正常提交之后摘掉监听、归还客户端；然后（不在停机中时）跑投递 job，再刷新积压 gauge，结果 `{ leader: true, jobs }`。

两个扫描（`runTaskReminderScan` / `runTaskDailyDigestScan`，经 `resolveTaskReminderJob` / `resolveTaskDailyDigestJob` 成为 job）：

| 扫描 | 行为 |
|---|---|
| 两者共同 | 投递线未全开（`resolveTaskDeliveryChannelNames` 为空）时不发任何语句、返回 `ran: false`，作为 job 时只记一次 info（`[own-3b-01]`）。org 前提经 producer 的 `resolveTaskDeliveryChannelsForOrg`，每个 tick 每个 org 只问一次（`[own-3b-13]`）。写行只经 producer 唯一的 INSERT（`insertTaskNotificationDeliveries`） |
| 提醒（设计 §6.2） | 每页 `buildTaskReminderScanCondition` + `TASK_REMINDER_SCAN_ORDER_BY` + `LIMIT`（缺省 500），floor 子查询的事件类型绑定为 `TASK_REMINDER_FLOOR_EVENT_TYPES`；游标推进到这一页最后一行的数据库文本 `remind_at::text` 与 id；每个候选再经 `isTaskReminderDue` 与它的 floor 判定（没有 floor 不发，`RULED(2026-10-07): [R06]`）；收件人与行经 `planTaskReminderDeliveries`（负责人取一次批量读）；每页一条 INSERT。短页、`stopping`、`leaderLost`、或一整页的最后一行与上一页相同（防止反复读同一页，`[own-3b-32]`）即停。结果计数 `pages` / `candidates` / `due` / `written` |
| 汇总（设计 §6.3） | 读开着汇总的设置行（全表），每行以自己的时区经 `resolveDailyDigestOccurrence` 判定（时区解析失败的行计入 `invalidZone` 并跳过，不拖垮整次扫描）；到点且 org 通过前提的收件人经 `planTaskDailyDigestDelivery` 写一行（`source_key` 用当地日期，`RULED(2026-10-07): [R07]`）；按每 500 个计划一条 INSERT，每条之前看 `stopping` / `leaderLost` |

投递 job（`resolveTaskNotificationDeliveryJob`）：`TASKS_ENABLED` 与 worker 开关都严格为 `'true'` 才存在；worker 在启动时构造一次（开关与 `createTaskDeliveryChannelsFromEnv()` 那时读），每次运行把本 tick 的数据库锚定时钟交给它，然后 `runUntilIdle({ budgetMs: TASK_DELIVERY_TICK_BUDGET_MS, stopping })`（`[own-3b-33]`）。

启动与停止（设计 §6.6）：`startTaskScheduler()` 在 `TASKS_ENABLED` 与 `TASKS_SCHEDULER_ENABLED` 都严格为 `'true'` 且 `db/pg.ts` 的 `pool` 非空时构造并 `start()`，否则返回 `null`（开关开着而没有连接池时记 warn）；interval 经 `resolveTaskSchedulerIntervalMs`，构造函数再夹到 `[5000, W]` 并在被截时 warn；`start()` 用 `unref` 的 `setInterval`，第一个 tick 在一个 interval 之后；`stop()` 清定时器、置 `stopping`，最多等在飞 tick 8 s（`TASK_SCHEDULER_STOP_GRACE_MS`），之后 gauge 置 `relinquished`。

### S5.4 单测 `task-scheduler.test.ts`（38 格）

模块 `db/pg` 被替换成调用即抛的桩（`pool` 为 `null`）；leader 客户端是记录每次调用的假对象（没有监听时 `emitError` 照 EventEmitter 抛出），扫描用按语句文本应答的查询函数。

| 组 | 格 | 内容 |
|---|---|---|
| leader tick | 5 | 语句与 job 的整体顺序恰为：读时钟 → 取客户端 → 挂监听 → `BEGIN` → `SET LOCAL lock_timeout` → 取锁 → 两个扫描 → `COMMIT` → 摘监听 → 归还 → 投递 → 积压；锁的参数是 leader 键；`lockTimeoutMs` 进入 `SET LOCAL` 且校验；所有 job 共用一个从数据库时刻起算的时钟；一个 job 失败只记码、不影响其余；没有投递 job 时只提交与刷新积压 |
| 不是 leader | 5 | `55P03` / `57014` ⇒ 回滚、归还、`follower`、零 job；`BEGIN` 或取锁的其他失败 ⇒ 销毁、`leader_unavailable`；忙锁之后回滚失败 ⇒ 销毁；读不到时钟（不取客户端）或取不到客户端 ⇒ `leader_unavailable` |
| 连接失败 | 3 | 扫描中连接出错：后续扫描不跑、不提交、销毁、零投递、`relinquished`，下一个 tick 照常；提交失败 ⇒ `leader_client_lost`、销毁、零投递；取锁等待中连接先出错再报 `57014` ⇒ 不当作忙锁 |
| 一次一个 tick、停机、定时器 | 6 | 在飞时再 tick ⇒ `running`（不取客户端），`stop()` 之后 ⇒ `stopping`；扫描中 `stop()` ⇒ 扫描看到 `stopping`，后续扫描与投递不跑，`stop()` 等它结束；tick 卡住时 `stop()` 在宽限后返回并 warn（缺省 8 s）；`start()` 每个 interval 一个 tick、从不立刻 tick、定时器 `unref`、`stop()` 清掉；interval 夹取与 warn；锚定时钟 |
| gauge | 3 | 积压三值与语句全文；积压读失败只 warn；两个 gauge 在第一个 tick 之前每个标签都有零样本 |
| 启动开关 | 5 | 只有两者都严格为 `'true'` 才启动（且是同一个实例），`stopTaskScheduler()` 之后不再 tick；开关开着而没有连接池（含缺省的 `null`）⇒ `null` 加 warn；interval 旋钮经解析器；投递 job 的存在条件；投递 job 用 tick 的时钟、`stopping` 时零语句 |
| 投递线关闭 | 2 | 任一开关不严格为 `'true'` ⇒ 两个扫描零语句；作为 job 时只记一次 info |
| 提醒扫描 | 7 | 页语句全文与绑定值；游标推进到上一页最后一行的数据库文本与 id；整页最后一行与上一页相同即停；`stopping` / `leaderLost` 在页之间生效；floor 缺失、floor 晚于时刻、窗口外 ⇒ 不写；收件人（未完成负责人、零负责人时创建人）、无活跃集成的 org 不写、每个 org 只问一次前提；页大小越界抛错 |
| 汇总扫描 | 2 | 设置行语句全文；上海 09:30 到点、Kiritimati 15:30 不到点、坏时区计数、无集成 org 不写，行形逐列；每 500 个计划一条 INSERT，`stopping` / `leaderLost` 在两条之间生效 |

### S5.5 真库文件 `task-m4-scheduler.db.test.ts`（20 格）

org 前缀 `org_tasks_m4sched_`（与既有各文件的前缀互不为前缀）。扫描、claim 与积压读都跨 org，所以每格开始清空整张 `task_notification_deliveries`、结束时删掉本格的任务、设置与集成（lane 逐个文件串行）。tick 由 `runTick()` 驱动（不用定时器）；扫描的时钟注入为远离真实时间的时刻（2031 年），其他文件的提醒与汇总不会落进窗口；并发用 deferred 固定先后；只有两处轮询，都是等数据库或驱动报告的状态（锁等待出现、连接错误到达），各有上限。

| 组 | 格 | 内容 |
|---|---|---|
| 单实例（门 25 候选） | 4 | 另一个连接持锁时，第二个连接在 `SET LOCAL lock_timeout = '1500ms'` 下经 helper 取锁以 `55P03` 结束，用时不超过 2.5 s；持锁期间 tick 的等待在 `pg_locks` 里是该键的一条未授予咨询锁、`wait_event_type = 'Lock'`、`wait_event = 'advisory'`，tick 以 `lock_busy` 结束、计数 job 零次、gauge `follower`，持锁方提交后下一个 tick 是 leader、两个计数 job 各一次；两个调度器同时 tick ⇒ 只有一方跑，另一方 `lock_busy` 零 job，持锁方的投递 job 里另一方的 tick 成为 leader（投递在提交之后）；负控（每次 lane 都跑）：helper 改成不取锁 ⇒ 另一个连接持锁时 tick 照样成为 leader 并跑了计数 job |
| leader 连接被终止 | 2 | 扫描挂在 deferred 上时第三个连接 `pg_terminate_backend` 掉 leader 的后端 ⇒ gauge 到 `relinquished`、扫描看到 `leaderLost()`、tick 以 `leader_client_lost` 结束、零投递、测试进程没有未处理错误，下一个 tick 照常是 leader；同一场景在子进程里跑两遍：源码原样 ⇒ 退出 0，去掉监听 ⇒ 未捕获的 `57P01` 让子进程以 42 退出 |
| 提醒扫描 | 4 | 窗口、floor 与任务状态（候选 4、到点 2、写 2；窗口下沿、更早、floor 晚于时刻、无事件、已完成、已删除、未来都不写），第二个 tick 零写，改期之后新键新行；收件人（只给未完成负责人；零负责人给创建人、`creator`；关注人不收）；页大小 5、同一时刻 12 个任务、按 id 最前的 3 个 floor 晚于时刻 ⇒ 一个 tick 3 页写 9 行；同一时刻 501 个任务、缺省页大小 ⇒ 一个 tick 2 页写 501 行 |
| org 前提与开关 | 1 | 两个扫描：无集成的 org、只有非活跃集成的 org 都零行，活跃集成的 org 各一行；任一开关不为 `'true'` ⇒ 零语句零行 |
| 汇总扫描 | 3 | 上海与 Kiritimati：01:30 UTC 只有上海、前一天 19:30 UTC 只有 Kiritimati，各带自己的当地日期；一天一行（窗口内两次一行、次日一行、09:00 前 1 ms 与 09:00 + W 不写）；解析不了的时区计数跳过、其他收件人照常 |
| 经真正的 tick 的空汇总 | 2 | 第一个 tick 写当天的行，第二个 tick 投递它为 `skipped` / `empty_digest` 零发送，当天后到的到期任务在第三个 tick 不写第二行、零发送（R07，S4.8 第 11 条所说的改经真正的 tick）；`buildTaskDailyDigestCondition` 与 `isInDailyDigest` 在同一批相对数据库时刻播种的 10 个任务上选出同样的 6 个（TS/SQL 对拍） |
| 整个 tick、启动、停机、积压 | 4 | 像启动时那样组装的调度器一个 tick：扫描写一行提醒、提交、投递循环发出它、积压读数为零；开关不全时 `startTaskScheduler` 返回 `null`、没有投递 job、环境不注册通道、到期行不被 claim，两开关都开时得到一个能干净停止的调度器；tick 进行中 `stop()` ⇒ 扫描看到 `stopping`、tick 提交、`stop()` 等它、之后锁是空的；积压 gauge（等待 3、最早到期的已等 90 s、`outcome_unknown` 1） |

### S5.6 命令与结果

绿线的 head 是 `37fdd5a214`（S5 的三个提交之后；运行前后工作树都干净）。运行严格串行：真库文件里的负控会原地改写 `task-access.ts`、`task-list-access.ts`、`task-advisory-locks.ts`、`task-scheduler.ts`，lane 运行期间不跑任何别的东西。真库环境同 S4.6；绿线用的一次性库 `pr3b_s56_3` 从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully，最后一条是 M4 迁移。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（临时配置同 S4.6，`include` 为调度器单测、调度器真库文件与夹具） | 测试文件 0 条诊断；本 PR 的 `src` 文件 0 条；其余 28 条都在本 PR 没有改的 `src` 文件里（这套编译选项下的既有提示，S4.6 同类） |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **37 files / 1461 passed**（S-merge2 的 1423 加调度器单测 38）；其余文件逐文件不变 |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 19 个文件，新建的库） | 三遍都是 **19 files / 773 passed**（77 s / 78 s / 77 s）；三遍逐文件计数相同；与 S-merge2 相比，既有 18 个文件逐文件不变，多出 `task-m4-scheduler` 20 格；每遍都打印了两个子进程负控的输出 |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 39/39（加 S5 的一格）；102/102 |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| `task-ci-coverage-enumeration` | 4/4（磁盘、exclude、lane 三个集合仍相等，新文件含 `assert-rbac-optional-off`） |
| 源码 token 普查（manifest 测试的发现口径） | `TASKS_ENABLED` ×11、`TASKS_SCHEDULER_ENABLED` ×4、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` ×3、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` ×1、`TASKS_SCHEDULER_INTERVAL_MS` ×3；多出的都在调度器与 `index.ts` 的注释与读点说明里，都已登记 |
| 门 15（对 S5 在 `src` 里新增的行 grep 其他线的名字） | 零命中 |
| 门 7 | 调度器不含取锁语句；任务域源码里取锁语句仍只有三个 helper 各一处 |
| 门 20 | 本片没有改 `src/tasks/`；`createDbAnchoredClock` 放在服务层（它读单调时钟） |
| values-free（本片改动的每个文件：IPv4 字面、主机名后缀、本机路径与机器名） | 零命中 |
| 三版裁决包扫描 | 本片改动的每个文件三版都退出 0 |
| 清库 | 本片建的两个库（开发与变异共用的 `pr3b_s56_2`、绿线的 `pr3b_s56_3`）都已按名字删除；同一时刻只存在一个本片的库 |

### S5.7 变异（45 个，全部变红）

驱动同 S4.7（先断言目标文件与 `HEAD` 的 blob 相同 → 备份 → 改动，每个 needle 恰出现一次 → 跑所属测试 → 从备份恢复 → 断言与备份逐字节相同且 sha256 等于 `HEAD` 的 blob；结束时目标文件 `git status` 为空，驱动退出 0）。判定比 S4 更严：所属文件有失败的格、或进程以非零退出、或报告未处理错误、或超过时限，都算变红（S01 只靠未处理错误就能被看见）。变异轮在 `b55897a0c9` 上跑，库是 `pr3b_s56_2`。正控：五个所属测试在未变异时 38 / 94 / 5 / 20 / 39 全绿。「红 / 余」是该 mutant 下所属文件的失败格数与通过格数。

| id | mutant | 红 / 余 | 结果 | 恢复 |
|---|---|---|---|---|
| S01 | leader 客户端不挂 `error` 监听（设计 §11.9） | sched 单测 5/33；sched 真库 2/18（含未处理错误） | 红 | 与 HEAD 相同 |
| S02 | leader 事务里去掉 `SET LOCAL lock_timeout` | sched 单测 4/34；sched 真库 9/11 | 红 | 与 HEAD 相同 |
| S03 | 取锁语句的任何失败都当作锁忙 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S04 | `55P03` 不再当作锁忙 | sched 单测 2/36；sched 真库 9/11 | 红 | 与 HEAD 相同 |
| S05 | 投递 job 改在 leader 事务里跑（持锁期间） | sched 单测 2/36；sched 真库 1/19 | 红 | 与 HEAD 相同 |
| S06 | follower 的 tick 也跑投递 job | sched 单测 2/36；sched 真库 9/11 | 红 | 与 HEAD 相同 |
| S07 | 失效的 leader 客户端被还回连接池而不是销毁 | sched 单测 5/33 | 红 | 与 HEAD 相同 |
| S08 | 监听从不摘掉 | sched 单测 6/32 | 红 | 与 HEAD 相同 |
| S09 | `stop()` 之后扫描照样开始 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S10 | 去掉同一时刻只跑一个 tick 的保护 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S11 | `stop()` 之后 tick 照样运行 | sched 单测 2/36；sched 真库 1/19 | 红 | 与 HEAD 相同 |
| S12 | `stop()` 不等在飞的 tick | 首轮：sched 单测 2/36；sched 真库 0/20。加强真库格（`37fdd5a214`）后重跑：sched 单测 2/36；sched 真库 2/18 | 红 | 与 HEAD 相同（两次） |
| S13 | interval 不截到扫描窗口 W | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S14 | `start()` 立刻跑一个 tick | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S15 | 定时器不 `unref` | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S16 | follower 的 tick 在 gauge 上报 `leader` | sched 单测 2/36；sched 真库 1/19 | 红 | 与 HEAD 相同 |
| S17 | leader 连接失效时 gauge 不置 `relinquished` | sched 单测 2/36；sched 真库 2/18 | 红 | 与 HEAD 相同 |
| S18 | 积压的最老等待把未到期的行也算进去 | sched 单测 1/37（语句全文）；sched 真库 0/20（行为等价，见表后说明） | 红 | 与 HEAD 相同 |
| S19 | 没有 `TASKS_ENABLED` 调度器也启动 | sched 单测 1/37；sched 真库 1/19 | 红 | 与 HEAD 相同 |
| S20 | 没有连接池调度器也启动 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S21 | 没有 worker 开关投递 job 也存在 | sched 单测 1/37；sched 真库 1/19 | 红 | 与 HEAD 相同 |
| S22 | 投递 job 用墙钟而不是 tick 的时钟 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| S23 | 提交失败之后照样跑投递 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R02 | 扫描条件去掉键集游标（`task-reminders.ts`；设计 §11.9） | sched 真库 2/18；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R03 | 扫描 SQL 去掉窗口下界（`task-reminders.ts`；设计 §11.9） | sched 真库 1/19；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R04 | `isTaskReminderDue` 去掉 floor 项（`task-reminders.ts`；设计 §11.9） | sched 真库 2/18；reminders 单测 1/93 | 红 | 与 HEAD 相同 |
| R05 | 没有 floor 的候选按 epoch 判定（照样发） | sched 真库 1/19；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R06 | 两个扫描跳过 org 前提 | sched 真库 1/19；sched 单测 2/36 | 红 | 与 HEAD 相同 |
| R07 | 投递线关闭时提醒扫描照样读 | sched 真库 1/19；sched 单测 2/36 | 红 | 与 HEAD 相同 |
| R08 | 投递线关闭时汇总扫描照样读 | sched 真库 1/19；sched 单测 2/36 | 红 | 与 HEAD 相同 |
| R09 | 汇总扫描给未到点的收件人写行 | sched 真库 2/18；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R10 | 一个解析不了的时区让汇总扫描中断 | sched 真库 1/19；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R11 | 汇总行用 UTC 日期而不是当地日期 | sched 真库 1/19；sched 单测 0/38 | 红 | 与 HEAD 相同 |
| R12 | 提醒收件人不看完成状态 | sched 真库 1/19；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R13 | 汇总 SQL 的 `+ 1` 改成 `+ 2`（`task-reminders.ts`；设计 §11.9） | sched 真库 1/19；reminders 单测 1/93 | 红 | 与 HEAD 相同 |
| R14 | 提醒扫描页与页之间不看 `stopping` / `leaderLost` | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R15 | 去掉防止重读同一页的保护 | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R16 | 汇总扫描两条 INSERT 之间不看 `stopping` / `leaderLost` | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R17 | 页 LIMIT 不用注入的页大小 | sched 真库 1/19；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| R18 | 游标从不前进（保护让它停在第二页） | sched 真库 2/18；sched 单测 1/37 | 红 | 与 HEAD 相同 |
| L01 | 取 leader 锁的 helper 不取锁（`task-advisory-locks.ts`；设计 §11.6 负控） | sched 真库 4/16；locks 单测 1/4 | 红 | 与 HEAD 相同 |
| W09 | 空汇总删掉这一行（worker；设计 §11.9，现经真正的 tick） | sched 真库 1/19 | 红 | 与 HEAD 相同 |
| X01 | 积压 gauge 在第一个 tick 之前没有样本（`metrics.ts`） | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| X02 | leader gauge 没有登记（`metrics.ts`） | sched 单测 1/37 | 红 | 与 HEAD 相同 |
| M01 | `TASKS_ENABLED` 的 `purpose` 去掉 S5 那一句（manifest） | manifest 1/38 | 红 | 与 HEAD 相同 |

说明：S18 在真库上看不见是因为这条过滤在行为上与夹取等价：未到期的行的 `next_attempt_at` 晚于任何已到期的行，只有在没有已到期的行时才会成为最小值，而那时差值为负、被夹成 0；它只由单测对语句全文的钉住杀死。S12 首轮在真库上没有变红（那一格当时用的微任务竞争看不出 `stop()` 没有等待），`37fdd5a214` 把那一格改为让出一轮事件循环后再看，重跑后真库也变红。设计 §11.9 中属于本片的六个 mutant 是 R02（键集游标）、R03（SQL 窗口下界）、R04（floor 项）、R13（汇总 SQL 的 `+ 1`）、S01（leader 客户端的 `error` 监听）与 L01（取锁行），W09（空汇总删行）改经真正的 tick 重跑。

### S5.8 偏差与说明

1. **tick 的第五种结果 `leader_unavailable`**（`ASSUMPTION(task-m4): [own-3b-30]`）：设计 §3.2 只列了 `lock_busy` / `running` / `stopping` / `leader_client_lost`。读不到数据库时钟、取不到客户端、或 leader 事务自己的语句因等锁以外的原因失败时，这个 tick 不是 leader、什么都不跑，结果记为 `leader_unavailable`，gauge 置 `follower`；已取到的客户端销毁。
2. **数据库时钟在每个 tick 开头读**（设计 §6.5 的「每个 tick 开头一次」）：在取 leader 客户端之前、经连接池的另一个连接读，所以 follower 也读一次（一条很轻的语句）；读不到即上一条。锚定时钟从那一刻起随单调时钟前进，等锁的时间不会让时钟落后。
3. **积压 gauge 的取值**（`[own-3b-31]`）：设计 §4.1 写了三项的含义，没有写口径。`pending` 计 `pending` 与 `retrying` 两种等待发送的行；最老一行的等待按「已到期的等待行里最早的 `next_attempt_at` 到现在」算（尚未到期的退避行不算等待，没有时为 0）；`outcome_unknown` 计该终态的行。三项各用一条以状态开头的索引可答的子查询，每个 leader tick 在投递循环之后刷新一次，停机中不刷新。
4. **提醒扫描的页大小可注入、以及防止重读同一页的保护**（`[own-3b-32]`）：真库格要用页大小 5 演示跨页（设计 §11.4），所以扫描接受 `pageSize`（`[1, 500]`，生产不传）；另加一条保护：一整页的最后一行与上一页相同就停。正确的键集条件不会出现这种情况，这条保护只让「游标不前进」或「条件里没有游标」这类错误停在第二页，而不是无限读同一页（变异 R02、R18 因此能在有限时间内变红）。
5. **投递 worker 只构造一次**（`[own-3b-33]`）：在启动时由 `resolveTaskNotificationDeliveryJob()` 构造（开关与通道表那时读，与「循环类在启动时读」一致），worker id 在进程内不变；每次运行把本 tick 的时钟交给它。
6. **`stop()` 的宽限可注入**：单测用 30 ms 演示「宽限到了先返回」，生产不传（8 s）。`stop()` 之后 gauge 置 `relinquished`（与仓库里其他调度器停机时的做法相同）。
7. **扫描函数导出、带结果计数**：设计 §3.2 只列了 `resolve*Job`；两个扫描另作为函数导出（`runTaskReminderScan` / `runTaskDailyDigestScan`），返回 `ran` 与计数。`candidates`（扫描 SQL 读出的行数）是设计 §11.9「SQL 侧窗口下界」那个变异唯一能被看见的地方：TS 侧的再判定会把多读的行挡掉，写出的行数不变（变异 R03）。
8. **汇总扫描的写法**：先算出全部到点收件人的计划，再按每 500 个计划一条 INSERT 写入，每条之前看 `stopping` / `leaderLost`（设计 §6.3 只写了「一行」）。
9. **同一 tick 内由扫描写出的行**：行的 `next_attempt_at` 取 INSERT 那一刻的数据库时钟（到微秒），tick 的时钟取在 tick 开头（到毫秒）并随单调时钟前进；同一 tick 的投递循环会不会 claim 到它取决于两者的先后，不作保证。空汇总那一格因此用第二个 tick（时钟后移 1 s）投递，只断言最终状态。
10. **「同日后到」格改经真正的 tick**（S4.8 第 11 条）：第三个 tick 的扫描在当天的行上冲突、零写、零发送。
11. **时刻与等待**：扫描格注入 2031 年的时刻（远离真实时钟，别的文件的任务与设置落不进窗口）；单实例格与连接终止格各有一处轮询，等的是数据库或驱动报告的状态（未授予的锁出现、连接错误到达），都有上限，没有固定时长的等待。
12. **interval 的 warn**：设计 §6.2 写的是超过 W 时截断并 warn；实现对两侧的夹取都 warn。
13. **文件数**：设计 §14 S5 写「文件数 5 + 三处登记」；实际 7 个（多调度器单测与 manifest 测试的一格），另加两个登记文件。
14. **门 7**：调度器只经 `acquireTasksSchedulerLeaderLock` 取锁，`src/services/task-*.ts` 与 `src/tasks/` 里没有取锁语句（只有任务 B 的 `task-lock-keys.ts` 一处既有注释提到函数名）；`SET LOCAL lock_timeout` 不是取锁语句。
15. **`TASKS_ENABLED` 的 `purpose`**（设计 §9.2）：追加一句并点名两个开关；manifest 测试加一格钉住（39 格），变异 M01 让它变红。

### S5.9 NOT RUN

- S6 的一切（钉钉通道、环境注册真通道）。S5 时环境仍不注册任何通道，所以启动时组装的投递 job 不 claim 任何行。
- 全量单测：按要求只在 S6 之后跑一遍。
- 真机、staging、任何环境里打开 `TASKS_*` 开关：按设计不做。
- 多进程真实定时（多个实例各自的 `setInterval`）：由 `runTick()` 直接驱动的格代替；定时器本身由单测的假定时器格覆盖。
- `apps/web` 测试：无前端改动。

### S5.10 给 S6 与 S7 的注记

- **S6**：`createTaskDeliveryChannelsFromEnv` 接上钉钉通道后，S5 的「开关不全」格仍成立（那些环境都不含钉钉通道的开关）；启动时组装的投递 job 会经它拿到真通道。
- **S7**：新增的自选取值 `[own-3b-30]`…`[own-3b-33]` 补进设计 §12；设计 §3.2 的签名（第五种结果、两个导出的扫描函数、可注入的 `pageSize` / `stopGraceMs` / `readNow` / `monotonic` / `query`）与 §4.1 的积压口径按本节改写；全量重跑时 `task-m4-scheduler` 的两个子进程负控各要一个 `tsx` 子进程（约 1–2 s）。

### S5.11 补充：服务端接线的一格（S6 之后补）

S6 收尾的复核发现 `index.ts` 里启动与停止调度器的两段没有任何格或 mutant 覆盖：删掉任一段，单测、lane、鉴权门与两轮变异都照样通过。`e49bbd2237` 在调度器单测里加一格：读 `src/index.ts`，断言 `startOnce()` 里恰好调用一次 `startTaskScheduler()`，`stopOnce()` 把 `await stopTaskScheduler()` 作为一个停机任务压入、且位置在等这些任务的关停屏障之前（全文件各恰一处）。补充的两个 mutant 都变红，恢复都与 `HEAD` 逐字节相同：

| id | mutant | 红 / 余 | 结果 | 恢复 |
|---|---|---|---|---|
| I01 | 服务端不启动调度器（删掉 `startOnce()` 里那一段） | sched 单测 1/38 | 红 | 与 HEAD 相同 |
| I02 | 服务端不停止调度器（删掉 `stopOnce()` 里那个停机任务） | sched 单测 1/38 | 红 | 与 HEAD 相同 |

这一格之后：type-check 0 errors；任务线单测 38 files / 1479 passed（S6.6 的 1478 加这一格，调度器单测 39 格）；三版扫描对改动的测试文件都退出 0。这一格只读源码文本，不碰数据库，S6.6 的 lane、鉴权门与全量单测的结果不受影响。S5 的变异合计 47 个（S5.7 的 45 个加这两个），全部变红。

## S6 钉钉通道

### S6.1 基座

| 项 | 值 |
|---|---|
| 起点 | `c724681cf7`（S5 的验证提交之后，工作树干净） |
| 代码提交 | `17761f6549`（通道、环境注册） |
| 测试提交 | `0eedd4ce22`（通道单测、真库文件、三处登记、夹具、改写的两格） |

### S6.2 交付内容

路径省略前缀 `packages/core-backend/`。

| 文件 | 内容 |
|---|---|
| `src/services/task-notification-dingtalk.ts`（新） | S6.3 |
| `src/services/task-notification-delivery-worker.ts` | `createTaskDeliveryChannelsFromEnv(env)`：`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` 严格为 `'true'` 时返回一个钉钉通道，否则空表（S6.8 第 1 条） |
| `tests/unit/task-notification-dingtalk.test.ts`（新，17 格） | S6.4 |
| `tests/unit/task-notification-delivery-worker.test.ts`（15 格，改写一格） | 原来钉住「本片不注册任何通道」的一格改为：只有通道自己的开关严格为 `'true'` 才注册一个钉钉通道，其余取值与其他开关都不影响 |
| `tests/integration/task-m4-delivery.db.test.ts`（24 格，改写一格） | 原来钉住「环境不注册通道」的一格改为：worker 开着而通道开关不严格为 `'true'` 时不注册通道、claim 不取任何行、到期行逐列不变；开关为 `'true'` 时注册钉钉通道 |
| `tests/integration/task-m4-dingtalk.db.test.ts`（新，11 格） | S6.5；三处登记 |
| `tests/helpers/task-m4-fixtures.ts` | `seedDirectoryBinding`：在给定 org 里为本地用户造一条钉钉身份（集成行、目录账户、指向用户的链接），随集成行一起被清理 |

### S6.3 通道的行为（设计 §8）

（本节于 S-gate2 按 S-gate 与 S-gate2 之后的实现复核改写，2026-10-09：第 4、6 步与错误文本一段原记的是 S-gate 之前的调用形。）

`prepare` 对收件人没有副作用，依次：

1. **身份**：目录三表经 org 限定的 join（链接 → 账户 → 本行 org 的活跃钉钉集成），`LIMIT 2`。零行时再读一次该 org 的钉钉集成行：一行都没有 ⇒ `skipped` / `dingtalk_org_integration_missing`；有而没有活跃的 ⇒ `skipped` / `dingtalk_org_integration_inactive`；有活跃的 ⇒ `skipped` / `dingtalk_recipient_not_bound`。两行 ⇒ `failed` / `dingtalk_recipient_ambiguous`。钉钉 id 为空白 ⇒ `skipped` / `dingtalk_recipient_not_bound`（`ASSUMPTION(task-m4): [D4] [own-3b-18]`）。
2. **配置**：只取产生身份的那一行集成的 `appKey`、`appSecret`（解密）、`workNotificationAgentId`（缺省时取 `agentId`，解密并校验为数字）、`baseUrl`；缺任一项或读不出 ⇒ `retrying` / `dingtalk_config_unavailable`（`[own-3b-19]`）。进程环境里的应用凭据不参与。
3. **出站地址**：`baseUrl` 按钉钉客户端的同一规则规范化（空白 ⇒ 缺省主机、去首尾空白、去末尾斜杠），再经 `isAllowedTaskDingTalkBaseUrl` 判定；不通过 ⇒ `failed` / `dingtalk_base_url_rejected`，不发任何请求；通过时 token 请求与发送用的就是这个规范化后的字符串（`[own-3b-21]`）。
4. **token**：`fetchDingTalkAppAccessToken(config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })`，不传信号；通道自己把这个 promise 与 `AbortSignal.timeout(TASK_DELIVERY_PREPARE_BUDGET_MS)` 竞速（S-gate.2 第 5 条）；超出预算、失败或为空 ⇒ `retrying` / `dingtalk_token_unavailable`，只有固定码（token 请求的错误文本可能带着含密钥的 URL）。
5. **复核**：再读一次身份与配置，与第一次逐项比较（集成 id、钉钉 id、appKey、appSecret、agentId、baseUrl）；任一不同或读不到 ⇒ `retrying` / `dingtalk_destination_changed`。
6. 返回 `send` 闭包：恰好一次 `sendDingTalkWorkNotification(token, { userIds: [钉钉 id], title, content }, config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })`；返回体没有任务 id ⇒ `outcomeUnknown` / `dingtalk_send_response_invalid`。两次出站调用都让传输层对被拒的响应只记 HTTP 状态与一句固定说明。

发送抛错的分类（设计 §8.4，`classifyTaskDingTalkSendError`）：传输层标为结果未知的（超时、网络错误、5xx、畸形 2xx）⇒ `outcomeUnknown`，最先判；`DingTalkRequestError` ⇒ 408 / 429 / 5xx 可重试，其余不可重试；`DingTalkBusinessError` ⇒ errcode 经传输层的 `isDingTalkFlowControlErrcode`（含 90018、-1）或错误文本表示限流 / 繁忙时可重试，否则不可重试；其余一律 `outcomeUnknown`（设计的修订 1 改法）。

错误文本（worker 写进 `last_error`）：栅栏之前只有固定码；栅栏之后是「固定码（带 HTTP 状态或 errcode）: 脱敏后的传输文本」。脱敏按设计 §8.5 的规则：先把传输文本截到 4096 个码元，再从长到短去掉闭包持有的每个值（token、appKey、appSecret、agent id、收件人的钉钉 id、标题、正文、正文的每一行、正文里每段「」中的用户文本，两个字符以上），再替换带密钥的查询参数、`key=value` / `key: value` / `"key":"value"` 密钥对与 `Bearer` 令牌、所有 URL 与主机名，控制与格式字符换成空格，截到 240 个码元；两次截断都不落在代理对中间。

注册（设计 §8.1）：`createTaskDeliveryChannelsFromEnv(env)` 只看 `TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` 是否严格为 `'true'`；其余开关与进程里的钉钉应用配置都不影响注册（S6.8 第 1 条）。注册的通道用钉钉客户端的真实 token 与发送函数；单测与真库格都注入替身。

### S6.4 单测

`task-notification-dingtalk.test.ts`（17 格）：模块 `db/pg` 被替换成调用即抛的桩；目录读用按语句文本应答的查询函数，token 请求与发送是记录调用的替身。

| 组 | 格 | 内容 |
|---|---|---|
| 身份语句 | 3 | 身份 join 全文与绑定值（收件人、本行 org），token 前后各读一次；零行时第二条语句全文与绑定值、三种结果各自的固定码、零请求；两行 ⇒ `failed`（不是 `skipped`）、空白钉钉 id ⇒ `skipped` |
| 配置 | 3 | 进程环境里另有一套应用配置时，token 请求与发送用的仍是集成行的 key、secret、agent id；`agentId` 作为后备、JSON 文本形式的配置、加密存储的 secret 与 agent id；缺 key / secret / agent id、agent id 不是数字、配置不是对象 ⇒ `retrying` / `dingtalk_config_unavailable`，零 token 请求 |
| 出站地址 | 2 | 规范化（空白 ⇒ 缺省主机、去空白、去末尾斜杠）；`http:`、别的主机、以钉钉主机名开头的别的域、带用户信息、`ftp:` ⇒ `failed` / `dingtalk_base_url_rejected` 且零请求；缺省、空串、带空白与斜杠、钉钉子域 ⇒ token 请求与发送收到同一个规范化后的地址 |
| token、复核、发送 | 4 | token 请求带 10 s 的单次超时与 15 s 预算的 `AbortSignal`，发送带 10 s 超时（S6 当时的调用形：S-gate 起不传信号、通道内与预算竞速，S-gate2 起预算 12 s，见 S6.3）；token 失败或为空 ⇒ `retrying` / `dingtalk_token_unavailable`，错误只有固定码（被丢掉的文本里有带密钥的 URL）；两次读之间钉钉 id、集成 id、appKey、appSecret、agent id、baseUrl 任一改变或身份消失 ⇒ `retrying` / `dingtalk_destination_changed`、零发送；闭包恰好发送一次（参数逐项钉死），返回体没有任务 id ⇒ 结果未知 |
| 分类 | 2 | 13 种错误的真值表（标为结果未知的超时 / 5xx / 畸形 2xx / 网络错误、429、403、errcode 90018 与 -1、40035、文本为繁忙的 33012、没有 errcode、普通 `Error`、抛出的字符串）；经闭包的三种 |
| 脱敏 | 3 | 一条同时含 token、appKey、appSecret、钉钉 id、带 `access_token` 的 URL、`appSecret: …`、主机名、正文、标题里的用户文本与换行的错误文本，返回后一样都不剩、只有一行、码之后不超过 240 字符；脱敏函数的各条规则与截断；栅栏前的每一种错误都恰好是一个固定码 |

`task-notification-delivery-worker.test.ts`（15 格，改写一格）：环境注册只看通道自己的开关（七种取值都不注册，`'true'` 注册一个 `DingTalkTaskDeliveryChannel`，名字是通道常量），其他开关不影响。

### S6.5 真库文件 `task-m4-dingtalk.db.test.ts`（11 格）

org 前缀 `org_tasks_m4dtalk_`（与既有各文件的前缀互不为前缀）。每格开始清空整张 `task_notification_deliveries`；行经规划器写成 producer 的行形（`commented` 事件、收件人是任务的负责人且在职），由真正的 worker 带着通道处理，worker 的时钟取数据库时刻加 1 s。token 请求与发送是替身；全局 `fetch` 被换成一调用就记一笔的函数，每格之后断言零调用。

| 组 | 格 | 内容 |
|---|---|---|
| 身份 | 3 | 没有集成 ⇒ `skipped` / `dingtalk_org_integration_missing`；只有非活跃集成 ⇒ `skipped` / `dingtalk_org_integration_inactive`（次数 1，不重试）；有活跃集成而本人未绑定 ⇒ `skipped` / `dingtalk_recipient_not_bound`；三者零请求。两条绑定 ⇒ `failed` / `dingtalk_recipient_ambiguous`；空白钉钉 id ⇒ `skipped` / `dingtalk_recipient_not_bound`。跨 org：本人只在 org 乙绑定，org 甲有活跃集成 ⇒ org 甲的行 `skipped` / `dingtalk_recipient_not_bound`、零请求；负控（每次 lane 都跑）：身份 join 去掉 org 子句 ⇒ org 甲的行经 org 乙的绑定与应用发出 |
| 配置、出站地址、复核 | 4 | 进程环境另有应用 Y，集成行存应用 X ⇒ token 请求与发送都收到 X；集成行缺 agent id ⇒ `retrying` / `dingtalk_config_unavailable`、零请求；`baseUrl` 为 `http://oapi.dingtalk.com` 与 `https://evil.example` ⇒ `failed` / `dingtalk_base_url_rejected`（`redelivery_safe` 为真）、零请求，缺省、空串与 `https://oapi.dingtalk.com` ⇒ 发送到缺省主机；取 token 期间绑定被改 ⇒ `retrying` / `dingtalk_destination_changed`、零发送 |
| 发送 | 3 | token 请求带单次超时与预算 signal、发送带单次超时，发送开始那一刻行已是 `sending`，之后 `sent`；六种结局（token 失败 ⇒ `retrying`、标为结果未知的超时 ⇒ `outcome_unknown`、errcode 90018 ⇒ `retrying`、403 ⇒ `failed` 且 `redelivery_safe`、普通 `Error` ⇒ `outcome_unknown` 且 `redelivery_safe` 为假、没有任务 id ⇒ `outcome_unknown`）；被拒的发送留下的 `last_error` 以 `dingtalk_business_error_40035: ` 开头，不含 token、钉钉 id、appKey、appSecret、主机、`https://`、任务标题与换行，码之后不超过 240 字符 |
| 环境注册 | 1 | 六种不严格为 `'true'` 的取值不注册；`'true'` 注册一个钉钉通道；用它构造的 worker 处理一个没有集成的 org 的行 ⇒ `skipped` / `dingtalk_org_integration_missing`，零请求 |

`task-m4-delivery.db.test.ts`（24 格，改写一格）：worker 开着而通道开关不严格为 `'true'` ⇒ 不注册通道、claim 不取任何行、到期行逐列不变；开关为 `'true'` 时注册钉钉通道。

### S6.6 命令与结果

绿线的 head 是 `0eedd4ce22`（S6 的两个提交之后；运行前后工作树都干净）。运行严格串行（真库文件里的负控会原地改写 `task-access.ts`、`task-list-access.ts`、`task-advisory-locks.ts`、`task-scheduler.ts`、`task-notification-dingtalk.ts`）。真库环境同 S4.6；绿线用的一次性库 `pr3b_s56_5` 从空库全量迁移，426 条 executed successfully，最后一条是 M4 迁移。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（临时配置同 S5.6，`include` 加本片新增或改动的四个测试文件） | 测试文件 0 条诊断；本 PR 的 `src` 文件 0 条；其余 28 条与 S5.6 相同，都在本 PR 没有改的 `src` 文件里 |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **38 files / 1478 passed**（S5 的 1461 加通道单测 17；worker 单测改写一格后仍是 15） |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 20 个文件，新建的库） | 三遍都是 **20 files / 784 passed**（79 s / 78 s / 80 s）；三遍逐文件计数相同；与 S5 相比，既有 19 个文件逐文件不变（`task-m4-delivery` 改写一格后仍是 24），多出 `task-m4-dingtalk` 11 格；每遍都打印了真库文件自己的负控输出（身份 join 去掉 org 子句时 org 甲的行经 org 乙的绑定发出） |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| 全量单测（一遍，不设 `DATABASE_URL`） | 5 files failed / 1085 passed / 172 skipped（1262）；44 tests failed / 18983 passed / 1712 skipped（20739）；151 s。失败的 5 个文件与 S4.6 是同一组、同样 44 格：`multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}`（22 / 1 / 4 / 16 格，OS 临时目录 `EEXIST`）与 `attendance-admin-plugin-lib-dist-layout-boot`（1 格，规范检出里自指的 `node_modules` 链接）；任务线文件全部通过，比 S4.6 多出的 2 个文件、57 格是调度器单测、通道单测与 PR-3a 的两格 |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 39/39；102/102（本片没有改 manifest：三个开关的条目在 S0 就已登记，钉钉通道开关的 `purpose` 与实现一致） |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| `task-ci-coverage-enumeration` | 4/4（三个集合仍相等，新文件含 `assert-rbac-optional-off`） |
| 源码 token 普查 | `TASKS_ENABLED` ×11、`TASKS_SCHEDULER_ENABLED` ×4、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` ×3、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` ×2（多出的一处在 worker 的注册说明里）、`TASKS_SCHEDULER_INTERVAL_MS` ×3，都已登记 |
| 门 15 / 门 7 / 门 20 | 通道与 worker 的新增行零命中其他线的名字；通道不取咨询锁；本片没有改 `src/tasks/` |
| values-free（本片改动的每个文件） | 零命中（`tasks-realdb.yml` 里既有的 CI 服务容器回环地址不是本片写的） |
| 三版裁决包扫描 | 本片改动的每个文件三版都退出 0 |
| 清库 | 本片建的两个库（开发与变异共用的 `pr3b_s56_4`、绿线的 `pr3b_s56_5`）都已按名字删除；同一时刻只存在一个本片的库 |

### S6.7 变异（32 个，全部变红）

驱动与判定同 S5.7；变异轮在 `0eedd4ce22` 上跑，库是 `pr3b_s56_4`。正控：四个所属测试在未变异时 17 / 15 / 11 / 24 全绿。

| id | mutant | 红 / 余 | 结果 | 恢复 |
|---|---|---|---|---|
| D01 | 身份 join 去掉 org 子句（设计 §11.9） | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D02 | 通道配置改从进程环境读取（设计 §11.9） | 通道单测 10/7；钉钉真库 7/4 | 红 | 与 HEAD 相同 |
| D03 | 栅栏后认不出的错误改回可重试（设计 §11.9） | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D04 | 不看传输层的「结果未知」标记 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D05 | 传输文本不脱敏 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D06 | 不去掉闭包持有的值 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D07 | 保留 URL 与主机名 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D09 | 保留 `key=value` / `key: value` 形式的密钥 | 通道单测 2/15 | 红 | 与 HEAD 相同 |
| D10 | 保留控制字符 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D11 | 不截到 240 字符 | 通道单测 1/16 | 红 | 与 HEAD 相同 |
| D12 | 没有集成的 org 报成「只有非活跃集成」 | 通道单测 1/16；钉钉真库 2/9 | 红 | 与 HEAD 相同 |
| D13 | 只有非活跃集成的 org 报成「未绑定」 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D14 | 两条身份时取第一条 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D15 | 两条身份记 skipped 而不是 failed | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D16 | 空白的钉钉 id 照样发送 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D17 | 缺配置直接 failed 而不是可重试 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D18 | 去掉出站地址白名单 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D19 | 出站地址不规范化（空白被拒） | 通道单测 11/6；钉钉真库 7/4 | 红 | 与 HEAD 相同 |
| D20 | token 请求不带单次请求超时 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D21 | token 请求不带 prepare 预算的 signal | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D22 | 发送不带单次请求超时 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D23 | token 失败带上自己的错误文本 | 通道单测 2/15 | 红 | 与 HEAD 相同 |
| D24 | 去掉 token 之后的复核 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D25 | 复核不比较钉钉 id | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D26 | 没有任务 id 的返回体算发送成功 | 通道单测 1/16；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D27 | 所有被拒的 HTTP 状态都可重试 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D28 | errcode 90018 只能经文本判为可重试 | 通道单测 2/15；钉钉真库 1/10 | 红 | 与 HEAD 相同 |
| D31 | 停用的目录账户仍给出身份 | 通道单测 1/16 | 红 | 与 HEAD 相同 |
| D32 | 未链接的账户仍给出身份 | 通道单测 1/16 | 红 | 与 HEAD 相同 |
| D33 | 通道以别的名字注册 | 通道单测 0/17；钉钉真库 11/0 | 红 | 与 HEAD 相同 |
| R01 | 不论开关都注册通道（worker） | worker 单测 1/14；钉钉真库 1/10；delivery 真库 1/23 | 红 | 与 HEAD 相同 |
| R02 | 从不注册通道（worker） | worker 单测 1/14；钉钉真库 1/10；delivery 真库 1/23 | 红 | 与 HEAD 相同 |

说明：只去掉「带密钥的查询参数」那一条正则的 mutant 没有列入：`key=value` 那一条覆盖它的全部输入（它只多要求前面是 `?` 或 `&`），两者的输出总是相同，是等价 mutant。设计 §11.9 归给本片的三个 mutant 是 D01、D02、D03；D01 另作为真库文件自己的负控每次 lane 都跑。

### S6.8 偏差与说明

1. **注册只看通道自己的开关**：本片的要求是「开关与配置都在时才注册」，并照仓库里按环境注册副作用通道的做法。本通道的应用配置按设计只存在于每个 org 的集成行上（`[own-3b-19]`，设计 §8.2 第 2 步：配置只有这一个来源；设计 §11.9 的「配置改从进程环境读取」是必须变红的 mutant），进程里没有本通道要检查的配置；仓库里按环境注册的同类钉钉通道也只看开关，额外检查环境就绪的是配置放在环境里的通道（邮件、企业微信）。所以注册只看开关，配置在每一行 `prepare` 时检查：集成行缺配置 ⇒ `retrying` / `dingtalk_config_unavailable`，受 `maxAttempts` 约束后成为 `failed`。设计修订 5 把这一条写进 §8.1（S7）。
2. **错误文本的格式与脱敏范围**（`ASSUMPTION(task-m4): [own-3b-34]`）：设计 §8.5 只写了「token、appkey、URL 替换为 `[redacted]`，截到 240 再截 1000」。实现：栅栏之前一律只有固定码（token 请求失败时的文本可能带着 `gettoken?appkey=…&appsecret=…`，整段丢掉）；栅栏之后为「固定码（`dingtalk_send_outcome_unknown` / `dingtalk_request_<状态码>` / `dingtalk_business_error_<errcode 或 unknown>` / `dingtalk_send_unclassified`）: 脱敏后的传输文本」，没有任务 id 时只有 `dingtalk_send_response_invalid`。脱敏在设计那三项之外，另去掉闭包持有的每个值（token、appKey、appSecret、收件人的钉钉 id、标题、正文、正文的每一行、每段「」里的用户文本，两个字符以上的），并把控制字符换成空格；去值在正则之前，用字面替换。worker 再截到 1000，不会生效（码加 240 不到 300）。
3. **可重试的判据**：被拒的 HTTP 状态 408 / 429 / 5xx 可重试（送达类调用的 5xx 已先被传输层标为结果未知）；业务错误的 errcode 用传输层导出的 `isDingTalkFlowControlErrcode`（含 90018 与 -1），文本判据照仓库里同类分类器复制。设计 §11.7 要求 90018 可重试；只靠文本时，这一格能不能变绿取决于钉钉返回的错误文案，所以单测与真库格都用中性文案（变异 D28 证明它只经 errcode 判定也成立）。
4. **agent id 必须是数字**：经 `normalizeDingTalkWorkNotificationAgentId` 校验，不是数字 ⇒ 配置不可用（与读集成配置的既有函数同一规则）。
5. **目录读的数据库错误不另设码**：`prepare` 里的查询抛错时直接抛出，由 worker 记 `prepare_failed`（可重试，不写异常文本，S4.8 第 6 条）。
6. **导出的辅助项**：`classifyTaskDingTalkSendError`、`redactTaskDingTalkErrorText`、`normalizeTaskDingTalkBaseUrl`、`TASK_DINGTALK_CHANNEL_CODES`、`TASK_DINGTALK_DEFAULT_BASE_URL`，供单测直接钉住；都在服务层，不在 `src/tasks/`（它们引用钉钉客户端的错误类，门 20 不适用）。
7. **空白的钉钉 id**：设计写「`external_user_id` 空」；实现去首尾空白后判空，只有空白的也算未绑定。
8. **没有网络**：单测与真库格都注入 token 请求与发送的替身；真库文件另把全局 `fetch` 换成记录调用的函数并在每格之后断言零调用。环境注册的那一格用真实的客户端函数，但它处理的行在任何请求之前就结束了。
9. **负控的分布**：设计 §11.9 归给本片的三个 mutant 里，「身份 join 去掉 org 子句」同时作为真库文件自己的负控每次 lane 都跑；「配置改从进程环境读取」与「栅栏后其余改回可重试」在变异轮里跑（D02、D03）。
10. **文件数**：设计 §14 S6 写「文件数 4 + 三处登记」；实际 7 个（多通道单测、改写一格的 worker 单测与 delivery 真库文件），另加两个登记文件。

### S6.9 NOT RUN 与待确认

- **真实的钉钉**：没有任何网络请求；token 请求与发送都是替身。真实接口返回的错误文案里会不会出现别的内容，本片无法实证；脱敏覆盖闭包持有的全部值与所有 URL、主机名与密钥参数。
- 真机、staging、任何环境里打开 `TASKS_*` 开关：按设计不做。
- 第三次重叠：PR-3a 在本片期间没有新提交（S-merge2 已合入它重建之前的最后一个提交）；若 PR-3a 再变，S7 前按设计 §14.0 再叠。
- `apps/web` 测试：无前端改动。
- S6.8 第 1 条的取舍（注册只看开关，配置按行检查）：设计修订 5 已写进 §8.1（S7）。

### S6.10 给 S7 的注记

- 设计 §12 补自选取值 `[own-3b-26]`…`[own-3b-34]`（S4.9 与本节、S5.8）；设计 §3.3 / §8 按实现改写：`prepare` 的入参多投递 id（S4.8 第 2 条）、注册只看开关、栅栏前后的错误文本格式、导出的辅助项。
- 设计 §11.9 的变异对照表在 S2–S6 已全部跑过：本片的三个（身份 org 子句、配置来源、栅栏后其余）在 S6.7，调度器的六个在 S5.7。
- PR body 除设计 §14 S7 列出的各项之外，再写：`last_error` 的脱敏规则（栅栏前只有固定码）、注册只看开关、真库 lane 现为 20 个文件。
- lane 的总时长在本地约 1.5 min，离 `tasks-realdb.yml` 的 25 min 上限很远。

## S-gate S2–S6 门审修复（2026-10-09）

### S-gate.1 基座与提交

| 项 | 值 |
|---|---|
| 起点 | `5dbe6c8b78`（S6 收尾之后，工作树干净） |
| 代码提交 | `ecd4e61603`（worker：停机信号、每行预算、物化先于 prepare；协议模块的每行预算常量）、`e17e39c01b`（调度器：leader 会话的服务端界限与心跳、停机信号、interval 校验、汇总扫描的在职过滤；flags 的上限、manifest 与其测试）、`4519a0b31f`（钉钉通道：传输文本先截后处理、脱敏规则加宽、token 获取与预算竞速、传输层不记本通道调用的上游原文；客户端与传输层各加一个可选项）、`daaf982230`（正文里的用户文本把 `:` 渲染为 `：`；传输层日志格也经客户端的发送函数走一遍） |
| 测试提交 | `fd37bc57ae`（三个真库文件的新格）、`d49a323b28`（「租约在栅栏前用完」一格改按每行预算的结果，另加一格让栅栏拒绝被改写到过去的租约）、`b2c4b51ef2`（锁等待格同时等待后端报告的等待事件） |
| 文档提交 | 本节所在提交（设计修订 4、本文若干句的措辞、本节） |
| PR-3a | 仍是 S-merge2 合入的 `03a6527061` |
| 真库环境 | 另一台机器（PostgreSQL 16.15）上的一次性库，从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully；type-check、单测与单测变异在本机 |
| 裁决 | 2026-10-09 一条：正文里的用户文本把 `:` 渲染为 `：`（设计 §8.3、§12，`RULED(2026-10-09)`；S-gate.4） |

### S-gate.2 六项确认结论的处置

每一项：结论 → 改动 → 格 → 变异（变异 id 见 S-gate.7）。

1. **停机时的退还**。结论：批里的行在飞时收到停机，worker 只在那一行返回之后才退还其余未开始的行；一次 prepare 或发送拖到宽限之后，其余每一行都留着这次 claim 消耗的一次次数（设计 §6.6 原文「每次停机至多影响一行」不成立）。改动：调度器的 `stop()` 现在 abort 一个停机信号，随 job 上下文交给投递 job，再交给 `runUntilIdle` 与每一批；一批在飞的行与停机信号竞速，信号到达那一刻其余未开始的行立即退还（一条退还语句），不等在飞的行；在飞的行自己：未过栅栏的返回后也退还，已过栅栏的照常等终态。格：单测三格（prepare 中停机 ⇒ 其余行先退还、在飞行返回后也退还、无栅栏；发送中停机 ⇒ 其余行先退还、在飞行 `sent`；信号已 abort ⇒ 零语句）、`runUntilIdle` 透传信号、调度器的停机信号格与投递 job 透传格；真库一格（`task-m4-scheduler`：真调度器、投递 job 第一行阻塞在 prepare、宽限 300 ms ⇒ `stop()` 在 1.8 s 内返回时其余四行 `pending`、次数 0、无持有者，放行后在飞的行也退还，零发送）。设计 §6.6 改写为真实的界：每次停机至多影响在飞的那一行。
2. **leader 会话的界限**。结论：leader 连接半开（主机消失、网络分区，没有 FIN / RST）时锁一直被持有，直到操作系统的 TCP keepalive 发现对端消失（按服务端默认参数约两小时），其间所有实例的 tick 都是 `lock_busy`，扫描与投递全停。改动（规则）：leader 事务在取锁之前 `SET LOCAL idle_in_transaction_session_timeout = TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS`（30 s；PG ≥ 9.6 的会话级参数，事务内生效，无 DDL，服务端全局值不影响它），半开的 leader 最迟 30 s 后被服务端结束、锁随之释放；两个扫描在每页工作之前经 `ctx.leaderHeartbeat()` 在 leader 连接上发一句 `SELECT 1`（提醒扫描每页一次，汇总扫描读设置之前与每条 INSERT 之前各一次），活着的 leader 在事务内的空闲不超过一页工作；心跳失败与监听收到错误同样处理（lost、`relinquished`、不提交、销毁客户端）。格：单测（leader 事务恰为两条 `SET LOCAL` 加取锁，`leaderIdleTimeoutMs` 进入语句、缺省 30 000、非法值拒绝；心跳在事务内发 `SELECT 1`、释放之后不发；心跳失败 ⇒ lost；lost 或停机之后不发；提醒扫描每页一次心跳、汇总扫描三次）；真库两格（`task-m4-scheduler`）：A 经一个可冻结的 TCP 中继领导（界限注入 1.5 s）、扫描挂起、冻结中继（两个方向都不转发、不传播关闭）⇒ B 的 tick `lock_busy`，在 4.5 s 内 A 的后端从 `pg_stat_activity` 消失，B 的下一个 tick 领导、扫描一次，关闭中继后 A 的 tick 以 `leader_client_lost` 结束；界限 1.5 s 下一个 3 s 的扫描每 500 ms 心跳 ⇒ 正常提交，同样的扫描不心跳 ⇒ 被服务端结束、`leader_client_lost`，之后锁是空的。设计 §6.1 的失效表把「进程崩溃」与「主机崩溃 / 网络分区」分开写。投递是否应依赖赢得锁：没有改（`[own-3b-07]` 的取舍不变）；界限让停摆有界。TCP keepalive 没有采用：对一个冻结的用户态中继它探测不到（内核照常应答），也就无法在格里证明。
3. **钉钉分类的负控**。结论：HTTP 408 的可重试性与 `code` 键下的 errcode 都没有格，两种回归都能绿着通过。改动：只加格。单测真值表加 408（可重试）、404（不可重试）、`{ code: 90018 }` 无 `errcode`（可重试）、`{ code: '40035' }`（不可重试）；真库分类格加 408 与 `code` 键下的 90018。说明：送达类调用的 5xx 先被传输层标为结果未知，`isRetryableStatus` 的 5xx 一支在发送上到不了（S6.8 第 3 条照此更正）。
4. **发送时的 floor 语句**。结论：worker 复核提醒窗口时的 floor 语句没有被钉住，把它改成计所有事件类型，所有层的测试都绿，而到点之后的任何一条评论 / 自完成都会让到期的提醒以 `reminder_window_elapsed` 结束。改动：只加格。单测钉住语句全文与绑定值（`TASK_REMINDER_FLOOR_EVENT_TYPES`，一行两次物化各一次）；真库一格：时刻之后分别有一条评论、另一负责人自完成自己那一行的两个任务，worker 在时刻后两分钟 ⇒ 两条提醒都发出。
5. **脱敏规则与同区的 P3**。结论：逐行值、两个字符下限、从长到短三条规则没有格；传输文本的处理次序、传输层对本通道调用的日志内容，以及抬头与设计 §10.5 的陈述，都要按代码的实际规则写明（S-gate2 改为只写规则）。改动：`redactTaskDingTalkErrorText` 先把文本截到 4096 字符（`TASK_DINGTALK_ERROR_RAW_MAX_LENGTH`）再做任何事，截断落在某个待去值内部时连同该值的前段一起丢；脱敏加宽：URL 规则接受 user-info 与 IPv4 字面，密钥对规则接受引号形 `"key":"value"`，另加 `Bearer` 令牌，控制字符规则覆盖 C0 / DEL / C1 / 行段分隔符 / 零宽与双向控制符；token 获取改为通道内与 `AbortSignal.timeout(TASK_DELIVERY_PREPARE_BUDGET_MS)` 竞速（当时 15 s，修订 6 起 12 s）、不再把信号传进共享的客户端请求；两次出站调用带 `logUpstreamMessage: false`（`DingTalkRequestOptions` 与 `DingTalkTransportRequest` 的新可选项，缺省行为不变），传输层对被拒的响应只记状态与固定说明。格：单测（两个字符的标题、带 」 的标题由传输层只回显那一行、钉钉 id 是标题的子串，各断言残留不在；加宽规则各一条；长文本的用时上界与截断落在值内的尾巴；预算竞速：永不返回的 token 请求在信号 abort 时以 `token_unavailable` 结束；传输层日志行直接调与经 `sendDingTalkWorkNotification` 调各一次；两次出站调用的选项逐项钉死）；真库（token 调用不带信号、两次调用都带 `logUpstreamMessage: false`）。通道抬头与设计 §8.5 / §10 按代码的实际规则改写。
6. **措辞**。本文若干节的措辞按公开口径调整；提交说明只写规则与结果。发布方式见 S-gate.9。

### S-gate.3 P3 / NIT 的处置

| 项 | 处置 |
|---|---|
| 设计 §3.1 的 producer 合同仍列 `assigneeIds` / `followerIds` | 改为实现的签名，注明成员在写入之后由 producer 读出 |
| 30 s 的每行预留假设了代码没有执行的每行时间界 | 执行：每行预算 `TASK_DELIVERY_ROW_BUDGET_MS` = 预留 − 发送租约 = 15 s（`[own-3b-36]`；S-gate2 起写作 prepare 预算 12 s + 物化余量 3 s，数值不变）；物化之后、prepare 之后、再物化之后各查一次，超过即不过栅栏、`retrying / row_budget_exceeded`（次数已消耗、有界）；一行在飞期间超过预算时其余未开始的行立即退还（定时器，生产 unref 的 `setTimeout`，测试注入）。真库一格（`task-m4-delivery`）：两行，第二行已到第 5 次、排在第一行之后，第一行阻塞在 prepare，触发定时器 ⇒ 第二行立即退还（次数 4、无持有者），另一 worker 清扫到零行、claim 它（次数 5）并发出；时钟推进 16 s 后放行 ⇒ 第一行 `retrying / row_budget_exceeded`、未过栅栏。既有的「租约在栅栏前用完」一格因此改为预算的结果（退避后下一次 claim 发出），另加一格让栅栏拒绝一条被改写到过去的租约（worker 仍在预算内），栅栏的租约合取仍在真库上有格 |
| prepare 先于物化，空汇总仍调通道；prepare 持续可重试失败时会被跳过的行以 `failed / redelivery_safe` 结束 | 物化先于 prepare、栅栏前再物化一次（`[own-3b-37]`）：会被跳过的行不调通道，空汇总零通道调用（真库格断言 `calls` 为空）；设计 §3.3 / §7.4 与单测的语句顺序随之改写（物化读 → prepare → 物化读 → 栅栏）。代价是每行多一次物化的读（2–5 条索引读） |
| 汇总扫描给已离开 org 的设置行每天写一条永久的 `skipped` | 扫描按 org 应用一次发送时的在职判据（`findActiveOrgMembers`，`[own-3b-38]`）：不写行，计数 `inactiveMember`；设置行不动。单测与真库（两天都零行、在职的邻居照常）各一格 |
| interval 上限等于 W | 上限改为 W/2（3 600 000，`[own-3b-39]`）：一次失败的 tick 加定时器迟到仍在同一个 W 内；env 旋钮夹到 `[5 000, W/2]`（manifest 与其测试同步），构造函数校验收到的值（整数且在区间内，否则 `TypeError`）而不夹取。单测：flags、reminders、scheduler 三处更新，manifest 测试 39/39 |
| 共享在飞的 token 请求使 prepare 预算失效，或让别的调用方被任务线的预算中断 | 通道不再把信号传进客户端，改为自己把 token promise 与预算信号竞速（见 S-gate.2 第 5 条）：加入别的调用方的请求不再延长 prepare，别的调用方也不再被本通道的预算中断；客户端的在飞共享本身未改（任务线之外） |
| 毒行格里 `claim_worker_id: null` 的断言打不到 | 被清扫的持有行在第二批之后读回：`failed / attempts_exhausted`、持有者与租约为空 |
| payload 是否属于本行只对事件族有格 | 毒行格加清单族（payload 指向同 org 的另一个清单）与汇总族（`source_id` 不是收件人）各一行 ⇒ `failed / payload_invalid`、零 prepare |
| 三条已陈述而无格的规则（停机中不刷新积压、`stop()` 之后 `start()` 不起定时器、通道文本 1000 字符截断） | 各加一格（单测两条、1000 字符单测与真库各一格） |
| 调度器抬头的时钟句（「持锁的 tick 读一次」） | 改为「每个 tick 开头在连接池上读一次，follower 也读」；`TaskSchedulerJobContext.now` 的注释同改 |
| 本文的措辞 | 见 S-gate.2 第 6 条 |
| 2 分钟内靠近当地午夜的汇总格等待（设计 §11.1） | 未动：S4 起用固定偏移时区，不需要等待（S4.8 第 10 条） |
| 自管重启翻转已完成的 `all` 任务不通知 | 记为 owner 问题 §13-Q23；代码按裁定的触发闭集实现，不改 |
| R06 的发送时读法 | 记为 owner 问题 §13-Q24；缺省不改 |

### S-gate.4 已裁规则（2026-10-09）：正文里的用户文本把 `:` 渲染为 `：`

`sanitizeTaskTextForMarkdown` 在既有转义之前把 ASCII `:` 换成 `：`（U+FF1A）；其余不变；正文的固定部分（标签、截止时间）不是用户文本、保持原样。格（`task-notification-text`）：带冒号与转义字符的文本出来不含 ASCII 冒号且转义仍生效；四族正文各一例，提醒与汇总的截止时间仍是 `09:30` / `18:00`；两条既有的期望随之更新。变异：去掉替换 ⇒ 红；放到转义之后 ⇒ 绿——三个替换作用于互不相交的字符集，次序不可观察，是等价变异，如实记录、不计入红数；把规则用到截止时间上 ⇒ 红。设计 §8.3 / §12 记 `RULED(2026-10-09)`。

### S-gate.5 owner 问题的变化

- §13-Q23 **新增**：自管重启让已完成的 `all` 任务翻回 open 时是否通知（现状：`self_reopened` 不在触发闭集，没有人收到「已重启」；备选：翻转时记 `reopened`，改任务 B 语义）。
- §13-Q24 **新增**：R06「到点时已完成不提醒」按处理时刻还是按 `remind_at` 那一刻判（现状：按处理时刻，重启或撤销自完成的任务 / 负责人最多迟 W 收到一条）。
- 其余问题不变；新增自选取值 `[own-3b-35]`…`[own-3b-40]` 已连同 `[own-3b-26]`…`[own-3b-34]` 补进设计 §12。

### S-gate.6 命令与结果

本机：`packages/core-backend` 下，Node 20.20.2，单测不设 `DATABASE_URL`；真库 lane 与鉴权门在另一台机器（PostgreSQL 16.15）上以 `tasks-realdb.yml` 的全部 20 个文件跑三遍，每遍一次性库从空库全量迁移。代码的最终 head 是 `b2c4b51ef2`；下表都在它上面。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（临时配置同 S4.6；`include` 为本轮改动的六个测试文件与夹具） | 任务线测试文件 0 条诊断 |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **38 files / 1503 passed**（S5.11 的 1479 加 24：worker 15 → 23、scheduler 39 → 46、dingtalk 17 → 22、text 32 → 34、protocol 36 → 37、flags 68 → 69）；逐文件：approval-feature-payload-flag-ledger 8、source-files-hourcycle-parsing-guard 16、task-access 214、task-advisory-locks 5、task-ci-coverage-enumeration 4、task-comments 16、task-completion 53、task-create 12、task-dates 68、task-deletion 9、task-deletion-lock-errors 6、task-delivery-protocol 37、task-edit 148、task-gate19-identities 9、task-groups 47、task-ids 53、task-ids-runtime 8、task-list-access 15、task-lists 125、task-lock-keys 9、task-membership 34、task-notification-delivery-worker 23、task-notification-dingtalk 22、task-notification-flags 69、task-notification-producer 19、task-notification-text 34、task-notifications 51、task-pagination 26、task-pure-no-io 5、task-realtime 9、task-records-guards 72、task-reminders 94、task-scheduler 46、task-settings 36、task-tree 46、tasks-auth-ci-wiring 2、tasks-feature-flag 8、tasks-route-errors 45 |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 20 个文件，另一台机器，新建的库） | 三遍分别 **792 passed**、**792 passed**、791 passed + 1 failed；第三遍的那一格在 PR-3a 的 `task-m4-groups` 里，夹具播种时连接池的 10 s 连接超时（`Connection terminated due to connection timeout`），与本轮改动无关；该文件单独重跑三遍都是 38 passed。本轮新增的格三遍都绿（半开 leader 一格约 2.5 s、心跳两格约 5 s、停机退还一格约 0.4 s）。与 S6 相比多出的 8 格都是本轮的：delivery 24 → 28（超预算 1、租约被改写 1、floor 1、1000 字符 1；租约用完的格改写，不加格）、scheduler 20 → 24（半开 leader、心跳、停机退还、离开 org 的汇总）、dingtalk 11 不变（分类格加两例、选项断言改写） |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| 全量单测（一遍，不设 `DATABASE_URL`，代码的最终 head） | 5 files failed / 1085 passed / 172 skipped（1262）；44 tests failed / 19008 passed / 1712 skipped（20764）；141 s。失败的 5 个文件与 S4.6、S6.6 是同一组、同样 44 格：`multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}` 与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`）；没有任务线文件失败 |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 39/39；102/102（interval 条目的规格测试改为 `[5000, 3600000]` 与 `W / 2`） |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| 三版裁决包扫描 | 本轮改动的每个文件（含设计与本文件）三版都退出 0 |
| values-free（本轮改动的每个文件：IPv4 字面、主机名后缀、本机路径与机器名；另对本轮的提交说明） | 只命中通道单测里两个文档保留地址段（TEST-NET）的字面，是脱敏规则的输入；无主机名、无局域网地址、无本机路径 |

### S-gate.7 变异（42 个：41 个变红，1 个等价）

驱动同 S5.7（先断言目标文件与 `HEAD` 的 blob 逐字节相同 → 备份 → 改动，每个 needle 恰出现一次 → 跑所属测试 → 从备份恢复 → 断言与备份逐字节相同且 sha256 等于 `HEAD` 的 blob；结束时目标文件 `git status` 为空，驱动退出 0）。单测变异在本机的工作树上跑；真库变异在另一台机器的分离工作树（同一 head）上以同一驱动跑，库是那一遍 lane 的库。判定：所属文件有失败的格、进程非零退出、或超过时限都算红。42 次恢复全部等于 `HEAD`。「红 / 余」是该 mutant 下所属文件的失败格数与通过格数。

单测侧（39 个有单测所属文件的 mutant）：

| id | mutant | 单测 红 / 余 | 结果 |
|---|---|---|---|
| GF-W01 | 在飞期间的立即退还被去掉（停机或超预算都等在飞的行） | worker 3/20 | 红 |
| GF-W02 | 每行预算的定时器触发时不做任何事 | worker 1/22 | 红 |
| GF-W03 | 超预算的行照样过栅栏发送 | worker 1/22 | 红 |
| GF-W04 | prepare 之前不物化（会被跳过的行先调通道） | worker 3/20 | 红 |
| GF-W05 | 发送时 floor 计所有事件类型 | worker 1/22 | 红 |
| GF-W09 | 通道错误文本不截 1000 | worker 1/22 | 红 |
| GF-S01 | leader 事务不设 `idle_in_transaction_session_timeout` | scheduler 5/41 | 红 |
| GF-S02 | 心跳不发语句 | scheduler 2/44 | 红 |
| GF-S03 | 心跳失败不标 leader 丢失 | scheduler 1/45 | 红 |
| GF-S04 | 提醒扫描页间不心跳 | scheduler 1/45 | 红 |
| GF-S05 | 汇总扫描 INSERT 前不心跳 | scheduler 1/45 | 红 |
| GF-S06 | job 上下文不带停机信号 | scheduler 1/45 | 红 |
| GF-S07 | `stop()` 不 abort 停机信号 | scheduler 1/45 | 红 |
| GF-S08 | 投递 job 不把停机信号交给 worker | scheduler 1/45 | 红 |
| GF-S09 | 汇总扫描不过滤离开 org 的用户 | scheduler 1/45 | 红 |
| GF-S10 | 构造函数不校验 interval 上限 | scheduler 1/45 | 红 |
| GF-S11 | 停机中照样刷新积压 | scheduler 1/45 | 红 |
| GF-S12 | `stop()` 之后 `start()` 起定时器 | scheduler 1/45 | 红 |
| GF-F01 | interval 上限改回整个 W（flags） | flags + reminders + scheduler 6/203；manifest 测试 1/38（手工：备份、改动、`node --test`、恢复、`cmp` 相同） | 红 |
| GF-D01 | 408 不可重试 | channel 1/21 | 红 |
| GF-D02 | 只读 `errcode`、不读 `code` | channel 1/21 | 红 |
| GF-D03 | 两个字符的值不去 | channel 1/21 | 红 |
| GF-D04 | 正文各行不作为值 | channel 1/21 | 红 |
| GF-D05 | 值不按长度从长到短去 | channel 1/21 | 红 |
| GF-D06 | 正则之前不截原文 | channel 1/21（长文本格超时） | 红 |
| GF-D07 | 截断落在值内时保留前段 | channel 1/21 | 红 |
| GF-D08 | Unicode 格式字符不换成空格 | channel 1/21 | 红 |
| GF-D09 | C1 控制字符不换成空格 | channel 1/21 | 红 |
| GF-D10 | URL 规则不认 user-info | channel 1/21 | 红 |
| GF-D11 | URL 规则不认 IPv4 字面 | channel 1/21 | 红 |
| GF-D12 | 密钥对规则不认引号形 | channel 1/21 | 红 |
| GF-D13 | 不替换 `Bearer` 令牌 | channel 1/21 | 红 |
| GF-D14 | token 获取不与预算竞速、改传信号进客户端 | channel 2/20（永不返回的 token 格超时） | 红 |
| GF-D15 | 发送不带 `logUpstreamMessage: false` | channel 2/20 | 红 |
| GF-T01 | 传输层忽略该可选项 | channel 1/21 | 红 |
| GF-C01 | 客户端的 oapi 辅助函数不转发该可选项 | channel 1/21 | 红 |
| GF-X01 | 去掉冒号替换 | text 5/29 | 红 |
| GF-X02 | 冒号替换放到转义之后 | text 0/34 | **等价**：三个替换作用于互不相交的字符集，次序不可观察；记录，不计入红数 |
| GF-X03 | 冒号替换也用到截止时间上 | text 4/30 | 红 |

真库侧（19 个有真库所属文件的 mutant；「delivery」= `task-m4-delivery` 28 格，「scheduler」= `task-m4-scheduler` 24 格，「dingtalk」= `task-m4-dingtalk` 11 格；驱动在另一台机器的分离工作树上跑，19 次恢复都与 `HEAD` 相同，结束时 `git status` 为空，驱动退出 0）：

| id | 真库 红 / 余 | 变红的格 | 结果 |
|---|---|---|---|
| GF-W01 | delivery + scheduler 2/50 | 超预算的行（其身后的行未退还）；停机退还（`stop()` 返回时其余行仍被持有） | 红 |
| GF-W02 | delivery 1/27 | 超预算的行 | 红 |
| GF-W03 | delivery 2/26 | prepare 拖过租约的行被发出；超预算的行被发出 | 红 |
| GF-W04 | delivery 1/27 | 空汇总调了通道 | 红 |
| GF-W05 | delivery 1/27 | 时刻之后的评论 / 自完成让提醒 `reminder_window_elapsed` | 红 |
| GF-W06 | delivery 1/27 | 毒行：清单 payload 不属于本行仍被接受 | 红 |
| GF-W07 | delivery 1/27 | 毒行：汇总 payload 不属于本行仍被接受 | 红 |
| GF-W08 | delivery 1/27 | 毒行：被清扫的持有行保留死持有者 | 红 |
| GF-W09 | delivery 1/27 | 1500 字符的错误文本整条存下 | 红 |
| GF-S01 | scheduler 2/22 | 半开 leader 的后端不在界限内消失；不心跳的扫描不被结束 | 红 |
| GF-S02 | scheduler 1/23 | 心跳的扫描被服务端结束 | 红 |
| GF-S06 | scheduler 1/23 | 停机退还 | 红 |
| GF-S07 | scheduler 1/23 | 停机退还 | 红 |
| GF-S08 | scheduler 1/23 | 停机退还 | 红 |
| GF-S09 | scheduler 1/23 | 离开 org 的设置行写出了行 | 红 |
| GF-D01 | dingtalk 1/10 | 408 ⇒ `failed` | 红 |
| GF-D02 | dingtalk 1/10 | `code` 键下的 90018 ⇒ `failed` | 红 |
| GF-D14 | dingtalk 1/10 | token 调用带了信号 | 红 |
| GF-D15 | dingtalk 1/10 | 发送调用没有 `logUpstreamMessage: false` | 红 |

说明：GF-S03、S04、S05、S10–S12、F01、D03–D13、T01、C01、X01–X03 只有单测所属文件（心跳的调用点、心跳失败的处理、interval 校验、脱敏的各条规则、传输层与客户端的可选项、冒号规则在真库格里没有独立的观察面，真库的语句与结果由单测的语句钉住）。W13（栅栏去掉租约合取，S4.7）在真库上现由「租约在行下被改写」一格打到（S-gate.3）；本轮没有重跑 S4.7 / S5.7 / S6.7 的旧表，它们针对的代码路径未改，只有 S4.7 的「租约在栅栏前用完」一格改写为预算结果（见 S-gate.3）。

### S-gate.8 NOT RUN

- `apps/web` 测试：无前端改动。
- 真机、staging、任何环境里打开 `TASKS_*` 开关：按设计不做。
- 真实的钉钉：没有网络请求；token 请求与发送都是替身。
- 钉钉客户端的在飞 token 共享（`client.ts`）本身未改：本通道不再把信号传进去，预算在通道内执行；别的调用方之间的共享语义是任务线之外的事。
- §13-Q23 的翻转一例与 §13-Q24 的另一读法：等裁决，没有加格。
- TCP keepalive（`tcp_keepalives_*`）作为 leader 会话的另一种界限：未采用（S-gate.2 第 2 条）。
- 一次性检出上跑变异：单测变异在本工作树上跑（与 `HEAD` 的 blob 比对、逐字节恢复），真库变异在另一台机器的分离工作树上跑（同一驱动、同一比对）。

### S-gate.9 发布方式

本分支以一次重建的单提交发布：`git commit-tree` 取最终树，父提交为 PR-3a 已发布的 head（Draft #6266 的 `68e40323bd`；本 PR 的基分支是 `claude/tasks-m4-pr3a`），发布前核对树与分支 head 逐字节相同；分支引用本身不推送。S7 更正：本节原写父提交为与 `main` 的合并基，那样 PR 相对基分支的差异会带上 PR-3a 的全部改动（S7.1）。

## S7 收口（2026-10-09）

### S7.1 基座、第三次重叠与发布形状

| 项 | 值 |
|---|---|
| 起点 | `07363a3ccb`（S-gate 之后，工作树干净） |
| PR-3a 的最终 head | Draft #6266 的 `68e40323bd`（父提交是 main 的 `cc6ca96ac2`）。它的树 `df79fa305c` 与 S-merge2 合入的 `03a6527061` 的树相同，`git diff 03a6527061 68e40323bd` 为空 |
| 第三次重叠（设计 §14.0） | 内容为空：PR-3a 的最终内容已经在本分支里。没有做合并提交：对重建后的单提交做真实合并，只会在 35 个文件上出现由历史改写引起的冲突（S4.11 的预检），而正确的合并结果必然就是本分支的树 |
| PR 的差异 | 本分支的树相对 `68e40323bd` 与相对 `03a6527061` 的差异逐项相同：44 个文件，增 14 763 行、删 42 行。这就是以 `claude/tasks-m4-pr3a` 为基的 PR 的差异；发布方式见 S-gate.9（本片更正了父提交） |
| 与 PR-3c（#6269）的重叠 | 以本分支的树、`68e40323bd` 为父，在本地生成一个不挂任何引用的预演提交，与 PR-3c 的 head `3edd133ae0` 做只读的 `git merge-tree`：4 个文件有内容冲突，即 `task-records.ts` 的两个事务回调（`completeTask`、`reopenTask`）、`task-structure.ts` 的四个（`addAssignee`、`removeAssignee`、`switchCompletionMode`、`deleteTaskById`），以及 `tasks-realdb.yml` 的文件清单与 `vitest.config.ts` 的 exclude 列表各一处；`index.ts` 自动合并。后合并的一方机械解决：回调里先保留本 PR 的 outbox 写入（`const written = …` 与随后的 `enqueueTaskEventNotifications(…)`），再保留 PR-3c 的 `counts.note(…)`；两个列表两项都保留 |
| 测试提交 | `36c8b01e0f`：冒号规则那一格的标题与输入改写，格数不变（S7.3） |
| 文档提交 | `dff5e84aea`（设计修订 5；本文的措辞与两处更正）、本节所在提交 |
| 绿线的 head | `36c8b01e0f`；其后的提交只改两份 MD（S7.4 末行） |
| 裁决 | 不变：2026-10-07（R01–R23、N1、N2）与 2026-10-09 的一条正文文案规则 |

### S7.2 交付内容

| 文件 | 内容 |
|---|---|
| `docs/development/task-m4-pr3b-backend-design-20261001.md` | 修订 5（抬头列明）：§3.1 / §3.2 / §3.3 的合同按实现改写；§4.1 积压 gauge 的口径；§6.3 写行方式；§8.1 注册只看开关；§8.5 `last_error` 的格式；§9.5 一行；§11.0 / §11.1 / §11.7；§12 的 `[own-3b-08]` 与 R18；§13 复核（Q10、Q12、Q17）；§14 S7 的 PR body 清单。取值未改 |
| 本文件 | 措辞（S7.3）；S-gate.6 / S-gate.7 的 `task-m4-delivery` 格数；S-gate.9 的父提交；本节与总览 |
| `packages/core-backend/tests/unit/task-notification-text.test.ts` | 冒号规则那一格（S7.3）；格数不变（34） |
| 不入库 | PR body 与 squash 提交说明的草稿 |

### S7.3 收口清单（前面各片留给 S7 的事项）

| 来源 | 事项 | 处置 |
|---|---|---|
| S1.7 第 11 条、S4.9、S5.10、S6.10 | 自选取值 `[own-3b-24]`…`[own-3b-34]` 补进设计 §12 | 修订 4 已补齐（连同 `[own-3b-35]`…`[own-3b-40]`），修订 5 复核；`[own-3b-34]` 由通道源码的抬头携带 |
| S5.10、S6.10 | 设计 §3.2 / §3.3 / §4.1 / §8 按实现改写：第五种结果、导出的扫描、可注入的选项、`prepare` 收到投递 id、注册只看开关、错误文本格式、导出的辅助项、积压口径 | 修订 5 |
| S6.8 第 1 条、S6.9 | 注册只看开关的取舍 | 设计 §8.1（修订 5） |
| S6.9 | 第三次重叠 | S7.1：内容为空 |
| S2.8 第 6 条、S1.7 第 9 条 | 任务 D 的 `ASSUMPTION(task-d)` 标签与模块抬头；任务 D 的 `source_key` 注记点名另两条线（门 15 的既有残留） | 不改。这些是随 PR-3a 进入本栈的任务 D 文本，PR-3a 的模块抬头已写明 R / N 条目于 2026-10-07 裁定；在本 PR 里改会扩大与 #6266、#6269 的重叠。门 15 对本 PR 新增的行零命中（S7.4） |
| S4.8 第 16 条 | `payloadMatchesRow` 是否移到解析器旁边 | 不移：它是 worker 的结构性检查，worker 抬头写明；三族各有真库格（S4.5；S-gate.3 补了清单族与汇总族，变异 GF-W06、GF-W07）。移动需要新的纯函数格与 harness 覆盖，不放在收口片 |
| S-gate.3 午夜一行 | 设计 §11.1 仍写等待越过午夜 | 设计 §11.1 改为实现的做法（修订 5） |
| S-gate.2 第 6 条 | 措辞 | 本文若干节的措辞按公开口径调整（`dff5e84aea` 与本节所在提交） |
| S-gate.4 | 冒号规则那一格的标题与输入 | 改写，格数不变（`36c8b01e0f`）。以同一驱动重跑 S-gate.7 的三个 mutant：GF-X01 红（text 5/29）、GF-X02 等价（0/34）、GF-X03 红（4/30）；三次恢复都等于 `HEAD` 的 blob，结束时目标文件 `git status` 为空 |
| S-gate.6、S-gate.7 | `task-m4-delivery` 记成 29 格 | 实为 28 格：S6 的 24 格加门审修复的 4 格；S-gate.7 各行「红 / 余」之和也是 28，本片 lane 三遍都是 28。两处改为 28 |
| S-gate.9 | 发布提交的父 | 改为 PR-3a 的 head `68e40323bd`。原写的是与 main 的合并基，那样 PR 相对基分支的差异会带上 PR-3a 的全部改动 |
| 已裁条目的标签 | 是否还有已裁条目标着 `ASSUMPTION` | 没有。对 44 个改动文件里本 PR 新增的每一行，逐个检查标签之后紧跟的条目 id：`ASSUMPTION(…)` 之后没有 R / N 条目或 D13；`RULED(2026-10-07)` 之后只出现 R01、R05、R06、R07、R13、R17、R23、N1 与 D13（随 R05）；冒号规则标 `RULED(2026-10-09)`。S7 没有改任何标签；此前的改标在 `8cbd7e0b87`（R05 / D13、R06、R07）、`4be7b6d583`（R01、R04、R13）与 `daaf982230`（2026-10-09 的规则） |

### S7.4 命令与结果

本机：`packages/core-backend` 下，Node 20.20.2，单测不设 `DATABASE_URL`。真库 lane 与鉴权门在另一台机器（PostgreSQL 16.15）上跑：一次性库从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully，然后以 `tasks-realdb.yml` 的全部 20 个文件跑三遍。全部在绿线的 head `36c8b01e0f` 上。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **38 files / 1503 passed**；逐文件与 S-gate.6 相同（那一格只改了标题与输入） |
| 真库 lane ×3 | 三遍分别 **792 passed**、**792 passed**、791 passed + 1 failed（每遍约 150 s）；三遍逐文件计数相同（见表后）。第三遍失败的那一格在 M3 的 `task-m3-comments-deletion` 里：M3-CONC-5 / 6 的并发格，要求三个请求在锁被持有时都在 1 s 内得到同一个 404，这次在机器负载约 4.7 时用了 1572 ms。该文件随即在同一个库上单独重跑三遍，都是 33 passed。本 PR 没有改这个文件 |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| 全量单测（一遍） | 5 files failed / 1085 passed / 172 skipped（1262）；44 tests failed / 19008 passed / 1712 skipped（20764）；135 s。失败的是 S4.6、S6.6、S-gate.6 记过的同一组 5 个文件、同样 44 格：`multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}` 与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`）。没有任务线文件失败 |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 39/39；102/102 |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| 门 15 / 门 20 静态 / 门 7（本 PR 新增的 `src` 行） | 都是零命中：没有其他线的名字；`src/tasks` 的新行不引 `pg`、`crypto`、`Intl.DateTimeFormat` 与 `db`；没有新的取锁字面量（任务域仍只有三个 helper） |
| 已裁条目的标签 | 见 S7.3 末行 |
| 三版裁决包扫描 | `origin/main...HEAD` 的全部 96 个改动文件，以及 PR body 与 squash 提交说明两份草稿：三版都退出 0 |
| values-free（分支相对 main 的全部新增行与两份草稿：机器名、局域网地址、本机路径、临时目录与草稿目录的字样；正则不写进本文，免得自我命中） | 两份草稿零命中；分支的新增行只命中 PR-3a 鉴权门文件里的两行：系统临时目录下的运行时文件名（变异负控的备份与脚本），不是本机路径，本 PR 不改那个文件 |
| 清理 | 另一台机器上的分离工作树与一次性库在 lane 与重跑之后按名字删除 |
| 绿线之后的提交 | `git diff --name-only 36c8b01e0f HEAD` 只列两份 MD |

lane 逐文件（三遍相同）：task-completion-grid 6、task-m3-comments-deletion 33、task-m3-membership 45、task-m3-tree 25、task-m4-dates 107、task-m4-delivery 28、task-m4-dingtalk 11、task-m4-groups 38、task-m4-list-items 25、task-m4-list-members 44、task-m4-list-roles 50、task-m4-lists 66、task-m4-org-members 46、task-m4-outbox 21、task-m4-paging-settings 77、task-m4-scheduler 24、task-m4-schema 59、task-p0a 13、task-rbac-trust 17、task-read-path 57，合计 792。本 PR 的四个新文件合计 84 格，其余 16 个文件 708 格与 PR-3a 的记录相同。

### S7.5 NOT RUN

- 真实的钉钉：没有发出任何网络请求；token 请求与发送都是替身。
- staging 与任何环境：没有部署，没有打开任何 `TASKS_*` 开关，没有应用任何 DDL。
- 对 S7 head 的独立门审：没有在本片里跑（之后跑了一轮，处置见 S-gate2）。
- CI：Draft PR 尚未开出；以非 main 为基时不触发的 lane（设计 §9.6）的本地对应结果见上表。

## S-gate2 S7 之后的再门审修复（2026-10-09）

### S-gate2.1 基座与提交

| 项 | 值 |
|---|---|
| 起点 | `38011e4eaf`（S7 之后，工作树干净） |
| 代码提交 | `b1cb3416c8`（调度器：两个扫描在页内按 org 分组心跳，组前先心跳、再看 stopping / lost，组大小可注入；flags 里 interval 上限注释的措辞；调度器单测的新格）、`25081db6fc`（worker：`prepare` 之前与再物化之前的 stopping 检查、抬头写明三处预算检查的规则；协议：每行预算 = prepare 预算 + 物化余量；通道：值表加 agent id、两次截断不拆代理对、抬头；三个单测文件的新格与协议常量格） |
| 测试提交 | `1dbcee8e0e`（两个真库文件的新格与改写的停机退还格）、`4837f1ffdd`（按 org 阶段的真库格改用注入的延迟决定阶段长度，见 S-gate2.4） |
| 文档提交 | 本节所在提交（设计修订 6；本文 S6.3、S-gate.2 第 5 条、S7.5 一行、本节与总览） |
| PR-3a | 仍是 `68e40323bd` |
| 真库环境 | 另一台机器（PostgreSQL 16.15）上的一次性库，从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），426 条 executed successfully；type-check、单测与单测变异在本机 |
| 裁决 | 无新裁决；取值变化只有 prepare 预算 15 s → 12 s（新增物化余量 3 s，每行预算、预留与租约不变）与新增常量 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS` = 50，都是本件自选（`[own-3b-08]`、`[own-3b-35]`、`[own-3b-36]`） |

### S-gate2.2 两项确认结论的处置

每一项：结论 → 改动 → 格 → 变异（变异 id 见 S-gate2.5）。

1. **汇总扫描按 org 的阶段**。结论：两个扫描在页内按 org 的读要分组心跳，组前先心跳、再看 stopping / lost，让活着的 leader 的空闲段与 org 数、用户数无关；leader 空闲的界要按真实的语句段写明。改动（规则）：两个扫描在一页之内把按 org 的读分成每组至多 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS`（50）个 org——提醒扫描每 org 一次前提读（每 tick 每 org 一次，缓存）、汇总扫描每 org 一次前提读与一次在职读；第一组由该页自己的那次心跳覆盖，之后每组之前**先心跳、再看 stopping / lost**，为真即停在这一组之前，不再发任何语句；`TaskScanJobOptions.heartbeatOrgs` 可把组缩小（整数、`[1, 50]`，缺省 50，越界抛 `TypeError`）；汇总行仍以 `(org_id, source_key)` 幂等，中途停下的 tick 不写任何行，下一个 tick 从头再来。格：单测（汇总扫描 2K+1 个 org 的语句形：读设置之前一拍、每 K 个 org 之后一拍、INSERT 之前一拍，共四拍；`heartbeatOrgs: 2` 时五个 org 的语句形；组内心跳失败 ⇒ 下一组的读不发、零 INSERT；第一拍在读设置之前；提醒扫描页内按 org 分组的语句形、单 org 的页不多拍、组内心跳失败即停；两个扫描都拒绝越界的组大小）；真库一格（`task-m4-scheduler`：真调度器、真汇总 job、51 个 org 各一名到点用户、每个 org 的在职读经注入的语句函数延后 200 ms、组大小 5、界限注入 5 s ⇒ 阶段超过 10 s，tick 以 leader 提交且无 reason、51 行各一、leader 的后端仍在；阶段进行中另一实例的 tick `lock_busy`、零 job 运行，阶段之后它领导）。抬头、设计 §4.2 / §6.1 / §6.2 / §6.3 与 §12 改为真实的界：活着的 leader 在事务内的空闲段至多是提醒扫描一页的 SELECT、一组按 org 的前提读、本页的负责人读与它的 INSERT，或汇总扫描的读设置加一组按 org 的两次读（每条 INSERT 之前另有一拍），与 org 数、用户数无关。
2. **停机退还格的观察点**。结论：真库的停机退还格在 `stop()` 返回之后才读行，「其余行在 `stop()` 返回之前退还」没有被钉住。改动：只改格。该格现在在 `stop()` 仍 pending 时轮询账本（宽限 1 s），其余四行回到 `pending` / 次数 0 / 无持有者的那一刻断言 `stop()` 尚未返回，之后再等它返回并核对用时；单测加一格：投递 job 在停机信号 abort 时记录，断言此时 `stop()` 仍 pending、用时小于宽限。

### S-gate2.3 其余各项的处置

| 项 | 处置 |
|---|---|
| 行内语句抛错时中断竞速的 rejection 一臂没有格（未确认，投票 P3） | 单测一格：栅栏语句抛错 ⇒ `runBatch` 以该错误 reject、身后两行一条语句退还、预算定时器已清、零发送；真库一格（`task-m4-delivery`）：栅栏抛错 ⇒ reject，身后一行退还并由另一 worker 在第 1 次发出，抛错的行保留本次 claim 直到租约到期、之后另一 worker 在第 2 次发出 |
| worker 在 `prepare` 之前与再物化之前看 stopping | 执行：worker 在 `prepare` 之前与再物化之前各看一次 `stopping()`，为真即 `released`（紧挨栅栏之前的检查不变）；单测两格（第一次物化期间停机 ⇒ 零 prepare、该行返回后退还；prepare 期间停机 ⇒ 返回后不再读状态）；设计 §6.6 / §7.2、worker 抬头 |
| 每行预算严格大于 prepare 预算 | 执行：prepare 预算 15 s → 12 s，新增物化余量 3 s，每行预算 = 12 + 3 = 15 s（严格大于 prepare 预算），每行预留 = 每行预算 + 发送租约 = 30 s 不变，租约与清扫不变；协议单测钉住算术与严格大于；设计 §7.2 写明两道界的先后（token 等待由 prepare 预算先截，每行预算是外层的界） |
| interval 上限 W/2 的陈述过强 | 措辞：flags 注释与设计 §6.2 改为「一次失败的 tick 之后，下一次 tick 的窗口仍覆盖上一次 tick 之后超过两倍定时器迟到量的每个时刻」；上限不改 |
| 值表含 agent id | 执行：`sensitiveValues` 加入 `config.agentId`；单测一格（回显 agent id ⇒ `[redacted]`），主脱敏格的消息与断言表也加入它；抬头与设计 §8.5 |
| 值的变形副本、模式之外的 URL 形式、闭包不持有的其他密钥形状 | 记为已知限制（设计 §8.5 一段，通道抬头一句；按规则陈述，各一行理由）；不加规则 |
| token 路径转发 `logUpstreamMessage` 没有负控 | 单测加一腿：经真客户端的 `fetchDingTalkAppAccessToken`（新 appKey、4xx 替身响应、`logUpstreamMessage: false`）⇒ 固定的 warn 行 |
| 截断按码元且不拆代理对 | 执行：两次截断按 UTF-16 码元计，落在高代理项之后时少取一个码元；单测一格（240 截断与 4096 截断各一例，输出无孤立代理项；整对保留） |
| 验证 S6.3 第 4、6 步仍是 S-gate 之前的调用形 | 改写为当前调用形（不传信号、通道内竞速、两次调用都带 `logUpstreamMessage: false`），错误文本一段按设计 §8.5 改写，节首注明 |
| 中断竞速的 abort 监听器移除没有格 | 「预算内结清的行」一格改传真实的 `AbortController`，断言批结束后信号上零 `abort` 监听器 |
| 三处每行预算检查各自可单独去掉 | 单测三格：第一次物化后超预算 ⇒ 零通道调用；prepare 后超预算 ⇒ 不再读状态、零发送；再物化后超预算 ⇒ 不过栅栏、零发送；三处的规则写进设计 §7.2、§12 与 worker 抬头 |
| 提醒扫描先看 lost / stopping 再心跳可通过；汇总扫描第一拍的位置没有格 | 单测：提醒扫描第 N 页之前心跳失败 ⇒ 该页不读、不写、语句日志止于那一拍；汇总扫描的心跳以 `<beat>` 记进语句日志，第一拍在读设置之前 |
| 验证 S-gate.2 第 5 条与设计 §8.4 / §8.5 的叙述 | 改为只写规则：S-gate.2 第 5 条的结论改写；设计 §8.4 的分类按规则陈述、§8.5 去掉来源指向 |
| U+2060..U+2064 范围没有格 | 控制字符格补 U+2060、U+2064、U+200C、U+200F、U+202A（每个范围至少一个码位） |
| 标题作为值没有格 | 单测一格：只回显标题 ⇒ `[redacted]`；主脱敏格也回显它 |
| 发送的文案是否来自栅栏前的那次读没有格 | 单测一格（第二次任务读改名 ⇒ 发出新标题）；真库一格（prepare 钩子里改名 ⇒ 发出新标题） |
| 最后一行在飞时中断的空退还守卫没有格 | 单测一格：单行批、prepare 期间停机 ⇒ 没有空数组的退还语句，该行返回后恰一条退还 |

### S-gate2.4 命令与结果

本机：`packages/core-backend` 下，Node 20.20.2，单测不设 `DATABASE_URL`。真库 lane 与鉴权门在另一台机器（PostgreSQL 16.15）上以 `tasks-realdb.yml` 的全部 20 个文件跑三遍，每遍一次性库从空库全量迁移。代码的最终 head 是 `4837f1ffdd`；下表都在它上面。

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 测试文件的类型检查（临时配置同 S-gate.6；`include` 为本轮改动的七个测试文件与夹具） | 任务线测试文件 0 条诊断 |
| 任务线单测 + payload 台账守卫 + hourcycle 守卫 | **38 files / 1519 passed**（S7 的 1503 加 16：scheduler 46 → 52、worker 23 → 30、dingtalk 22 → 25；protocol 37 不变，两格改写）。头一次 lane 之前在 `1dbcee8e0e` 上跑，其后只有真库文件与 MD 改动 |
| 真库 lane ×3（`tasks-realdb.yml` 的全部 20 个文件，另一台机器，新建的库） | 三遍都是 **795 passed**（每遍约 170 s）；与 S7 相比多出的 3 格都是本轮的：delivery 28 → 30（改名 1、栅栏抛错 1）、scheduler 24 → 25（按 org 阶段 1；停机退还一格改写，不加格）；本轮新增的格三遍都绿（按 org 阶段一格约 12 s、停机退还一格约 1.4 s）。同一 head 之前的一次 lane（`1dbcee8e0e`）见表后 |
| 鉴权门（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false`） | **86 passed** |
| manifest 测试 / `verify:global-history-flag-manifest:test` 三件 | 39/39；102/102 |
| `scripts/ops/tasks-auth-ci-wiring.test.mjs` / `staging-tasks-smoke.test.mjs` | 3/3；19/19 |
| `task-ci-coverage-enumeration` + 门 20 harness（`task-pure-no-io`） | 9/9（三个集合仍相等；新导出的常量在 harness 的发现范围内） |
| 三版裁决包扫描 | 本轮改动的每个文件（含设计与本文件）与 PR body 草稿，三版都退出 0 |
| 全量单测（一遍，不设 `DATABASE_URL`，`4837f1ffdd`） | 5 files failed / 1085 passed / 172 skipped（1262）；44 tests failed / 19024 passed / 1712 skipped（20780）；134 s。失败的是 S7.4 记过的同一组 5 个文件、同样 44 格：`multitable-recovery-{archive-file-store,archive-reader,local-custody-store,local-startup}` 与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`）；没有任务线文件失败 |
| values-free（`38011e4eaf` 之后的全部新增行、两份 MD 与 PR body 草稿：机器名、局域网地址、本机路径、临时目录与草稿目录的字样；正则不写进本文） | 零命中 |

按 org 阶段的真库格的第一版（`1dbcee8e0e`：组大小 10、延迟 100 ms、界限 3 s）在第一遍 lane 里红过一次：另一台机器上同时还有别的会话在跑，语句延迟抬高时一组 10 个 org 的二十条真语句就能让 leader 的空闲碰到 3 s；第二、三遍绿（该格 7.8 s / 8.2 s）。`4837f1ffdd` 把阶段长度改为由注入的延迟决定（组大小 5、延迟 200 ms、界限 5 s：一组要碰到界限，十条真语句得平均 400 ms；阶段超过 10 s 不依赖语句速度），然后重跑三遍，结果见上表。

### S-gate2.5 变异（22 个 mutant：单测侧全部变红；4 个另在真库侧跑）

驱动同 S-gate.7（先断言目标文件与 `HEAD` 的 blob 逐字节相同 → 备份 → 改动，每个 needle 恰出现一次 → 跑所属测试 → 从备份恢复 → 断言与备份逐字节相同且 sha256 等于 `HEAD` 的 blob；结束时目标文件 `git status` 为空，驱动退出 0）。单测变异在本机的工作树上跑（head `1dbcee8e0e`，其后的提交没有改 `src`）；真库变异在另一台机器的分离工作树（`4837f1ffdd`）上以同一驱动跑，库是那一遍 lane 的库。「红 / 余」是该 mutant 下所属文件的失败格数与通过格数。

单测侧（22 个；scheduler 52 格、worker 30 格、channel 25 格、protocol 37 格）：

| id | mutant | 单测 红 / 余 | 结果 |
|---|---|---|---|
| RG2-S01 | 汇总扫描按 org 的阶段里不心跳、不看 stopping / lost | scheduler 2/50 | 红 |
| RG2-S02 | 组前先看 stopping / lost 再心跳 | scheduler 2/50 | 红 |
| RG2-S03 | 提醒扫描每页先看 stopping / lost 再心跳 | scheduler 1/51 | 红 |
| RG2-S04 | 汇总扫描第一拍移到读设置之后 | scheduler 4/48 | 红 |
| RG2-S05 | 提醒扫描页内的组之间不心跳、不看 stopping / lost | scheduler 1/51 | 红 |
| RG2-S06 | `stop()` 在宽限之后才 abort 停机信号 | scheduler 2/50 | 红 |
| RG2-W01 | 行结清时不摘停机信号上的 abort 监听器 | worker 1/29 | 红 |
| RG2-W02 | 去掉第一次物化之后的预算检查 | worker 1/29 | 红 |
| RG2-W03 | 去掉再物化之后的预算检查 | worker 1/29 | 红 |
| RG2-W04 | 去掉 prepare 之后的预算检查 | worker 1/29 | 红 |
| RG2-W05 | 行 reject 时中断竞速不结清 | worker 1/29（格超时） | 红 |
| RG2-W06 | 去掉空退还守卫 | worker 1/29 | 红 |
| RG2-W07 | 发送第一次物化的文案 | worker 1/29 | 红 |
| RG2-W08 | 去掉 prepare 之前的 stopping 检查 | worker 1/29 | 红 |
| RG2-W09 | 去掉再物化之前的 stopping 检查 | worker 1/29 | 红 |
| RG2-D01 | 值表去掉 agent id | channel 2/23 | 红 |
| RG2-D02 | 值表去掉标题 | channel 2/23 | 红 |
| RG2-D03 | 格式字符去掉 U+2060..U+2064 范围 | channel 1/24 | 红 |
| RG2-D04 | 240 截断不避开代理对 | channel 1/24 | 红 |
| RG2-D05 | 4096 截断不避开代理对 | channel 1/24 | 红 |
| RG2-C01 | 客户端的 token 函数只转发 fetchFn / timeoutMs / signal | channel 1/24 | 红 |
| RG2-P01 | 每行预算 = prepare 预算（无物化余量） | protocol + worker 6/61 | 红 |

真库侧（4 个；「scheduler」= `task-m4-scheduler` 25 格，「delivery」= `task-m4-delivery` 30 格）：

| id | 真库 红 / 余 | 变红的格 | 结果 |
|---|---|---|---|
| RG2-S01 | scheduler 1/24 | 按 org 的阶段：leader 在阶段中被服务端结束，tick 以 `leader_client_lost` 结束、零行 | 红 |
| RG2-S06 | scheduler 1/24 | 停机退还：其余行回到 `pending` 时 `stop()` 已返回 | 红 |
| RG2-W05 | delivery 1/29 | 栅栏抛错：`runBatch` 不结清（格超时） | 红 |
| RG2-W07 | delivery 1/29 | 改名：发出的是旧标题 | 红 |

四次恢复都与 `HEAD` 相同，结束时目标文件 `git status` 为空，驱动退出 0。

说明：RG2-S02–S05、W01–W04、W06、W08、W09、D01–D05、C01、P01 只有单测所属文件（语句形、检查次序、值表与截断在真库格里没有独立的观察面）。本轮没有重跑 S-gate.7 之前各表的旧 mutant：它们针对的代码路径未改。

### S-gate2.6 NOT RUN

- `apps/web` 测试：无前端改动。
- 真机、staging、任何环境里打开 `TASKS_*` 开关：按设计不做。
- 真实的钉钉：没有网络请求；token 请求与发送都是替身。
- 组大小 50 的生产取值在真库上的超界限阶段：真库格以注入的组大小 5 与延迟 200 ms 证明机制；50 这个值只由单测的语句形钉住。
- 脱敏的已知限制（设计 §8.5）：没有加规则，也没有加格。
- 一次性检出上跑变异：同 S-gate.8 末条。

### S-gate2.7 发布方式

同 S-gate.9（父提交 `68e40323bd`，发布前核对树与分支 head 逐字节相同；分支引用本身不推送）。

## 总览（S0–S7 与 S-gate2）

### 总览.1 切片

| 片 | 内容 | 代码与测试提交 | 新格 | 变异（不同的 mutant） |
|---|---|---|---|---|
| S0 | 三个开关的读点、派生谓词、interval 解析；manifest 三条目 | `aad99fa10a` | flags 单测 68 | 13，全部变红 |
| S1 | 纯函数：扫描条件与汇总到点、规划器与 payload 解析、文案、投递协议；interval 的数值 manifest 条目 | `e9b0164cb2`、`843f31f801`、`8bf76245d1`、`0c1e943803` | 四个单测文件 124 | 62，全部变红 |
| S-merge | 重叠到 PR-3a 的 `d940fa8745`；迁移改名同步 | `f22243316a`（合并）、`863f3d4bb5` | — | — |
| S2 | producer 与七个触点 | `025f8fa271`、`5966f5efbc`、`8cbd7e0b87`（改标） | producer 单测 19；守卫格；`task-m4-outbox` 18 | 35，全部变红 |
| S3 | N1 | `25f856b690`、`f135ad4ad3`、`9d15e6911b` | 成员单测与守卫格；`task-m3-membership` 新增断言；`task-m4-outbox` 加 3 格 | 15，全部变红；收尾时在 S3 的 head 上重跑 S2、S3 的 50 个，全部变红 |
| S4 | worker、任意状态构造器、结果计数器 | `4be7b6d583`（改标）、`42b9761729`、`5e40a0adfe`、`026ae28236`、`37e59642dd`、`f049648bc2` | worker 单测 15；access 4；`task-m4-delivery` 24 | 42，全部变红 |
| S-merge2 | 重叠到 PR-3a 闸审修复之后的 `03a6527061` | `1ff2976df8`（合并） | — | — |
| S5 | 调度器与启动接线、两个 gauge | `f8baa00c5a`、`b55897a0c9`、`37fdd5a214`、`e49bbd2237` | 调度器单测 39；manifest 测试 1；`task-m4-scheduler` 20 | 47（S5.7 的 45 加 S5.11 的 2），全部变红 |
| S6 | 钉钉通道 | `17761f6549`、`0eedd4ce22` | 通道单测 17；`task-m4-dingtalk` 11 | 32，全部变红 |
| S-gate | S2–S6 门审修复 | `ecd4e61603`、`e17e39c01b`、`4519a0b31f`、`daaf982230`、`fd37bc57ae`、`d49a323b28`、`b2c4b51ef2` | 单测 24（1479 → 1503）；真库 8（784 → 792） | 42：41 个变红，1 个等价 |
| S7 | 收口 | `36c8b01e0f` | 无（一格改写） | 无新 mutant；重跑 3 个 |
| S-gate2 | S7 之后的再门审修复 | `b1cb3416c8`、`25081db6fc`、`1dbcee8e0e`、`4837f1ffdd` | 单测 16（1503 → 1519）；真库 3（792 → 795） | 22，全部变红 |

每片的文档提交另列在各节的基座表里。

### 总览.2 最终计数（绿线的 head `4837f1ffdd`，S-gate2）

- 本 PR 相对 PR-3a 的差异：44 个文件（S7.1；S-gate2 没有新增文件）。
- 本 PR 新建的七个单测文件：flags 69、text 34、protocol 37、producer 19、worker 30、scheduler 52、channel 25，合计 266 格；另在六个既有单测文件里追加了格（reminders、notifications、access、list-access、membership、records-guards）。任务线单测子集合计 38 files / 1519 passed。
- 真库：四个新文件 outbox 21、delivery 30、scheduler 25、dingtalk 11，合计 87 格；`task-m3-membership` 的 N1 断言；lane 20 个文件、795 格。
- 鉴权门 86 格（本 PR 无新路由）。
- manifest：三个开关条目与 interval 的数值条目；manifest 测试 39 格。

### 总览.3 变异合计

计数规则：一个 mutant 是对一处源码（或 manifest）的一种改动，按 id 计一次，不论它跑了几个所属测试文件、在单测与真库两侧各跑一次，还是在后来的 head 上重跑；重跑另计「执行次数」。等价变异单列，不计入红数。

- 不同的 mutant：310 个（S0 13、S1 62、S2 35、S3 15、S4 42、S5 47、S6 32、S-gate 42、S-gate2 22）。其中 309 个变红，1 个等价（GF-X02：两个替换作用于互不相交的字符集，次序不可观察）。
- 重跑：收尾.3 在 S3 的 head 上重跑 S2、S3 的 50 个，全部变红；S7 重跑 GF-X01–X03，结论同 S-gate.7。执行次数合计 367（首轮 288、重跑 53、S-gate2 的 22 个单测侧加 4 个真库侧）。S1 首轮草稿里的 44 个 mutant 已被 S1.6 的 62 个取代，不计。
- 每一次执行都从备份恢复，并核对恢复后的文件与 `HEAD` 的 blob 逐字节相同；结束时目标文件 `git status` 为空。

### 总览.4 评审与门审（只列条目 id）

| 轮次 | 条目 | 处置 |
|---|---|---|
| 设计评审（修订 1，2026-10-01） | PR3B-C01–C12、CONC-1–12、SEC-1–3、OPS-1–3、CI-1、PLAN-1、TEST-1–2，共 34 条 | 33 条采纳，CONC-12 部分采纳（设计 §16） |
| S1 复审 | A–F | 六处修正，`0c1e943803`（S1.2） |
| S2–S6 门审（2026-10-09） | 确认的 6 项（S-gate.2 第 1–6 条）；P3 / NIT 14 行（S-gate.3） | 6 项全部处置；14 行里 11 行改正，2 行转为 owner 问题（§13-Q23、Q24），午夜等待一行在 S7 改了设计正文；去名一项（S-gate.2 第 6 条）在 S7 补完。变异 GF-W01–W09、GF-S01–S12、GF-F01、GF-D01–D15、GF-T01、GF-C01、GF-X01–X03 |
| S7 | — | 没有新的门审 |
| S7 之后的再门审（2026-10-09） | 确认的 2 项（S-gate2.2 第 1–2 条）；未确认 1 项与 P3 / NIT 17 行（S-gate2.3） | 2 项全部处置；18 行里 15 行改正或加格，3 行记为已知限制（设计 §8.5）。变异 RG2-S01–S06、RG2-W01–W09、RG2-D01–D05、RG2-C01、RG2-P01 |

### 总览.5 NOT RUN（整个 PR）

- 真实的钉钉：任何一片都没有发出网络请求；token 请求与发送在单测与真库格里都是替身，真库文件另把全局 `fetch` 换成记录调用的函数并断言零调用。
- staging：没有部署；staging runner 没有这三个开关的输入（设计 §9.4、§13-Q8）。
- 开关与 DDL：任何环境都没有打开任何 `TASKS_*` 开关；本 PR 没有 DDL，PR-3a 的迁移没有在任何共享库上应用。
- CI：以非 main 为基时 `plugin-tests`、`web-tests`、contracts、`migration-replay` 不触发（设计 §9.6）；本地对应的结果见 S7.4；没有前端改动，`apps/web` 测试没有跑。
- 多实例的真实定时（各自的 `setInterval`）：由直接驱动 `runTick()` 的格代替。
- 钉钉侧的配额、可见范围与平台去重（设计 §8.3）：没有实测。
- §13-Q23 的翻转一例与 §13-Q24 的另一读法：等裁决，没有格。
- TCP keepalive 作为 leader 会话的另一种界限：没有采用（S-gate.2 第 2 条）。
- 组大小 50 的生产取值在真库上的超界限阶段、脱敏的已知限制：见 S-gate2.6。
- R01 ①–③ 的判定（含 `M2|` / `M3|` 全部门行的重跑）：它是合并之前的判定，在最终候选集成树上做，本 PR 自己的 head 上做不了；还没有做。（2026-10-09 改正：这一条原来把重跑放在 M4 全部合并之后，与 R01 不符，见文末 1009m.4。）

### 总览.6 owner 问题

设计 §13：Q1、Q11、Q21 已由 2026-10-07 的裁决答复；Q2–Q10、Q12–Q20、Q22–Q24 仍待答，本 PR 按各题的缺省交付。

## 2026-10-09 改叠到重新定名之后的 PR-3a

PR-3a 把 M4 迁移重新定名为 `zzzz20261009130000_create_task_m4_tables`，并重建为单个提交（它的树与 #6266 那一轮修复之后的 head 相同）。本 PR 的单个提交 `2974ba5363`（基 `68e40323bd`）改叠到这个提交上，再加三个提交：迁移名的同步、门 15、本节与设计修订 7。

### 1009b.1 改叠的冲突与解法

两边都改过的文件有七个，五个自动合并，两个有冲突：

| 文件 | 两边 | 解法 |
|---|---|---|
| `src/tasks/task-reminders.ts` | PR-3a 改写了 `assertValidCalendarDateString` 上方的注释（门 15）；本 PR 给这个函数加了 `fn`、`name` 两个参数 | 注释取 PR-3a 的，签名取本 PR 的 |
| `scripts/ops/global-history-flag-manifest.mjs` | `TASKS_ENABLED` 的 `purpose`：PR-3a 写新迁移名；本 PR 在末尾加了一句（调度器与投递 worker 以它为前提） | PR-3a 的文本，后接本 PR 的那一句 |

- 去掉注释之后由 TypeScript 打印：本 PR 与 PR-3a 那一轮修复改过的 48 个源码、测试与脚本文件，改叠后与 `2974ba5363` 逐字节相同，只有两处例外，都是迁移名（`task-m4-schema` 的 import、manifest `TASKS_ENABLED` 的 `purpose`）。
- 本 PR 相对新 PR-3a 的差异与 `68e40323bd..2974ba5363` 按文件比较增删行的多重集：只差 `TASKS_ENABLED` 那一行的一增一删（改叠后两边都带新名）。

### 1009b.2 迁移名

- manifest 三个开关的 `purpose` 改成现名。改叠之后、改名之前，「三个开关的 `purpose` 里的 M4 迁移名恰为磁盘上的那一个」那一格红（39 格中 1 格）；改名之后 39 / 39。
- 设计 §2 写现名（迁移正文与行数都没有变，§2 引的行号照旧）。本文 S0.2 那一行加日期注；S-merge.3 记的是当时的改名，原样保留，后面加一条日期注。

### 1009b.3 门 15

- 人口：本 PR 相对新 PR-3a 在 `packages/core-backend/src` 下新增的注释行，按 TypeScript 语法树取，整行注释与行尾注释都算：19 个文件、920 行。
- 记号表，不区分大小写：`approval todo attendance multitable elearning e-learning dingtalk stock-prep stockprep plm kanban workflow after-sales aftersales directory feishu k3 census`。改前 28 行命中：25 行有 DingTalk，4 行有 directory（其中一行两者都有）。
  - DingTalk 的 25 行写的是本 PR 实现的通道本身：通道、它调用的客户端、它的开关、固定码与允许的主机。保留。
  - directory 的 4 行用另一条线的名字称呼集成表与身份表，其中一行写了表名。改为「该 org 的集成行」「按 org 限定的身份 join」「身份数据异常」「身份与集成的读」。改后 0 行。
- 注释里的标识符逐个查声明处（TypeScript 声明、迁移建表、文件名）。改前只在任务路径之外有声明的有 12 个，其中其他线的符号 1 个（集成表的表名）。改后 11 个：10 个是任务代码自己的字段或参数名，在任务路径的代码里都有使用；1 个是平台的数据库模块 `db/pg.ts`。
- 只改注释：两个文件去掉注释后由 TypeScript 打印的结果与改前逐字节相同。对照：在其中一个文件里加一行代码，同一比较报不同。

### 1009b.4 命令与结果

本机，Node 20.20.2，代码 head 是门 15 那个提交（命令在 `packages/core-backend` 下，ops 测试在仓库根）：

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0，没有输出 |
| 任务单测子集与守卫 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts`，加 `approval-feature-payload-flag-ledger`、`source-files-hourcycle-parsing-guard`、`migration-timestamp-uniqueness.guard` | 39 个文件 1539 格全绿：S-gate2 的 38 个文件 1519 格，另加前缀唯一 20 格 |
| ops 脚本测试 | `node --test scripts/ops/global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs`；`… tasks-auth-ci-wiring.test.mjs` | 39/39；19/19；3/3 |
| 公开文本 | 三个字面扫描器，参数是本轮改动的文件、三条提交信息、PR body 与 squash 提交信息的草稿 | 都退出 0 |
| 本机路径、机器名、局域网地址 | 对本轮新增行与两份草稿查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名与私有网段 | 0 处（本行只写模式的名称） |

另一台机器，PostgreSQL 16.15，一次性库，跑完删除：从空库全量迁移 426 条（CI 的排除清单）；`tasks-realdb.yml` 的 20 个文件一遍 795 / 795，四个新文件 outbox 21、delivery 30、scheduler 25、dingtalk 11，与总览.2 相同；鉴权门 86 / 86。

### 1009b.5 NOT RUN

- CI（本轮没有推送）；PG14 与 postgres:16 容器。
- 全量单测；真库 lane 只跑了一遍（S-gate2 是三遍）。
- 变异：本轮只改了注释、迁移名与文档，没有重跑。迁移名那一格在改名前后的红绿就是它的对照。
- 门 15 对本 PR 以外既有注释的重扫。
- 真实的钉钉、staging 与生产：没有发出请求，没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。

## 2026-10-09 重建到 main 上

#6266 重建为 main `8f90307d5a` 上的单个提交，本 PR 随之重建为叠在它之上的单个提交。本节记重建带来的变化与 records 守卫的加强；之前各节是当时的记录，原样保留，只有总览.5 的最后一条按 1009m.4 改正。

### 1009m.1 差异

本 PR 的差异仍是这 44 个文件。与上一节结束时的差异相比，不同的只有：两个 manifest 文件（与 main 的冲突解法，1009m.2）；records 守卫（1009m.3）；`packages/core-backend/vitest.config.ts`（main 在同一个 exclude 列表里新加了一项，自动合并；本 PR 增删的行不变，只差上下文行）；以及本文件（本节与总览.5 的一条改正）。其余 39 个文件逐行相同。

### 1009m.2 与 main 的两处冲突

- `scripts/ops/global-history-flag-manifest.mjs` 的数组末尾：main 加了两个审批红点开关，本 PR 加了三个开关与一个数值旋钮。先放 main 的两条，再放本 PR 的四条。
- `scripts/ops/global-history-flag-manifest.test.mjs` 的源码扫描：`tasks` 一行取本 PR 认得数值旋钮的写法，main 的审批红点一族照留，返回的并集里两项都在。
- 重建后 manifest 测试 41 / 41。合并前若 main 又改了这两个文件，要再核一次。

### 1009m.3 records 守卫：每个触点的每个事件恰写一次

- 改写的是 `task-records-guards.test.ts` 里核对「outbox 行带着事件写入时的 id」的那一格。原先它只取最后一条事件 INSERT 的 id 来比；同一回调里多写一次事件、多写的那次排在前面时，它看不出来。
- 现在它逐触点钉住事件 INSERT 的类型与顺序：记录的每个事件恰好一条 INSERT。

| 触点 | 夹具里记下的事件（按顺序） |
|---|---|
| `completeTask` | `completed` |
| `reopenTask` | `reopened` |
| `addAssignee` | `assignee_added`、`reopened` |
| `removeAssignee` | `assignee_removed`、`completed` |
| `switchCompletionMode` | `completion_mode_changed`、`completed_by_any` |
| `addComment` | `commented` |
| `deleteTaskById` | `deleted` |
| `setTaskListArchived` | `archived` |

- 两个事件的那三行：夹具让任务的完成状态翻转，翻转多记了第二个事件；没有翻转的写入不记这第二个事件。
- 与 PR-3c 合并时，五个回调里要删掉 PR-3c 一侧那行裸的事件写入（PR-3c 设计 §10；本文 S7.1 记了这次重叠）。若两边各留一行事件写入，这一格无论哪一侧排在前面都会变红。
- 变异（2026-10-09，本 PR 重建后的树，单测侧）：五个回调（`completeTask`、`reopenTask`、`addAssignee`、`removeAssignee`、`switchCompletionMode`）各在 `const written = …` 之前（前置）与入队之后（后置）多写一次事件；`deleteTaskById` 在事件 INSERT 之前与入队之后各多写一条。共 12 个，全部变红，改写的那一格在每一个里都红：

| 回调 | 前置（红 / 72） | 后置（红 / 72） |
|---|---|---|
| `completeTask` | 1 | 2 |
| `reopenTask` | 1 | 2 |
| `addAssignee` | 4 | 5 |
| `removeAssignee` | 2 | 3 |
| `switchCompletionMode` | 1 | 2 |
| `deleteTaskById` | 1 | 2 |

- 对照：把这一格换回改写前的写法，`completeTask`、`reopenTask`、`switchCompletionMode`、`deleteTaskById` 的前置变异整个文件仍全绿（72 / 72），即旧写法漏掉这 4 个位置；`addAssignee`、`removeAssignee` 的前置变异由别的格抓到（3 / 72、1 / 72）。
- 每个变异都先确认改动已落地，跑完从备份复制回去，与 `HEAD` 的 blob 逐字节相同；对照用的测试文件同样还原。
- 这一格是改写，不是新增：records 守卫仍是 72 格。它在本地、以及基分支为 main 时的 `plugin-tests` 里跑。

### 1009m.4 R01 的 ①–③ 在合并之前判定

- R01（2026-10-07）给 M4 定的退出条件分四部分：① 锁里已有的两条 `M4|` 行全绿；② R01 新加的每一条 `M4|` 行全绿；③ 全部 `M2|`、`M3|` 行重跑一遍且全绿；④ staging 真投递一次，outbox 账本留一行。①–③ 是合并之前的判定；只有 ④ 在合并之后，是 owner 的步骤（设计 §13-Q8 问的是 ④ 由哪个 PR 改 runner）。
- 判定用的树是合并之前的最终候选集成树：含锁 PR（#6248）的 main，加上按合并顺序叠好的 PR-3a、PR-3b、PR-3c 与 M4 前端，冲突按各 PR 写明的解法解好。② 的新行在锁 PR 合并之前不计分，所以这棵树以合并了锁 PR 的 main 为基。判定在 M4 的任何一张 PR 合并之前做完并留下记录。
- 总览.5 原来的最后一条把 `M2|` / `M3|` 全部门行的重跑放在 M4 全部合并之后，与 R01 不符，已按本条改正。设计 §1「不做」表与 §11.10 说的最终 head 上的回归，指的就是这棵合并之前的树上的这一遍；PR-3c 在自己的 head 上跑的那一遍是预备，不代替它。

### 1009m.5 重建之后的结果

下面前两张表的运行都在加本节之前的树上做，它与本节所在的树只差两份验证文档（本文件与 PR-3a 的那份）。本机，Node 20.20.2（命令同 1009b.4）：

| 项 | 结果 |
|---|---|
| type-check | `tsc --noEmit -p .` 0 |
| 任务单测子集与守卫 | 38 个文件 1519 格：任务单测子集 36 个文件 1495 格，另加 `approval-feature-payload-flag-ledger` 8 格、`source-files-hourcycle-parsing-guard` 16 格 |
| 迁移守卫 | 三件 36 格：前缀唯一 20、`migrations.rollback` 10、`migration-provider` 6 |
| ops 脚本测试 | manifest 41 / 41；`staging-tasks-smoke` 191 / 191；`tasks-auth-ci-wiring` 3 / 3 |

另一台机器，PostgreSQL 16.15，一次性库，跑完删除：

| 项 | 结果 |
|---|---|
| 迁移 | 从空库全量迁移 427 条（CI 的排除清单） |
| lane | `tasks-realdb.yml` 的 20 个文件一遍 795 / 795：outbox 21、delivery 30、scheduler 25、dingtalk 11，其余 16 个文件与 PR-3a 相同 |
| 鉴权门 | 86 / 86 |

1009m.3 的变异与对照在源码与测试都与本节所在的树相同的树上跑（只差本文件）。读文档的两个单测在加了本节之后的树上跑过：`task-gate19-identities` 9 / 9，`task-ci-coverage-enumeration` 4 / 4。三个字面扫描器对本文件都退出 0。

### 1009m.6 NOT RUN

- CI（没有推送）；PG14 与 CI 的 postgres:16 容器。
- 全量单测；真库 lane 只跑了一遍。
- 1009m.3 的变异只在单测侧跑，没有在真库 lane 上跑。
- R01 ①–③ 的判定：要在最终候选集成树上做（1009m.4），不在本 PR 自己的 head 上做。
- 真实的钉钉、staging 与生产：没有发出请求，没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。
