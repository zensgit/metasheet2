# Staging 窗口 runner：冒烟脚本随 runner 打包上传 + 任务冒烟补 M3 用例（验证记录，2026-10-07）

- 设计：`docs/development/staging-runner-smoke-bundle-design-20261007.md`。
- 分支：`claude/runner-smoke-from-tarball`，基于 `origin/main` `7137688372`。
- 代码提交：
  - 首轮：`57269c2897`（bundle 取代部署机仓库同步）、`02c4f8abb7`（outsider 令牌）、`72f57981e4`（bundle 合同测试）、`201326af28`（任务冒烟 M3 用例）。
  - 审阅修复：`24fda27629`（逐断言错形回答表；该提交信息写的是 100 个 cell，实际为 103 个）、`ae26c3288c`（SQL 全文钉死与逐身份残留）、`2d9ea4dbe4`（tenantId 注释）、`1fa1c6e3d5`（关注人自行退出与父任务候选）、`1c9b32381f`（闭包扫描扩展与平铺启动检查）、`a79bc4903b`（rd45 的 `PLUGIN_INDEX_PATH`）、`8e8e335bd1`（no-git 钉扩展）、`587587c4b7`（列表字段缺失的回答）、`3eca75c6b9`（一处测试注释的措辞，只改注释）。
  - 复审修复（§8）：`bcb9d9148a`（清理只删种入身份创建的任务；每次创建后在库里校验回答的 id）、`c17de226f1`（评论编辑后读回）、`117c7b0a52`（子任务与墓碑按 id 查找的错值 cell）、`8cce7bccb3`（后续步骤回答他人任务 id 的 cell，只改测试）、`4a69f83038`（残留按库里的本次运行任务计数的行为测试，只改测试）。
  - 第三轮复审修复（§9）：`867a1f6e41`（考勤冒烟共用清理助手的用户前缀过滤）、`99c57be260`（harness 核对每个请求的任务 id 与子 id）、`75c8a109be`（每个种子 INSERT 失败都要求全量清理）、`a9480f3bd1`（`TASKS_ENABLED` 关闭时的停止位置）、`27eea78005`（no-git 钉扩展到工作流里连部署机的步骤）。
  - 第四轮复审修复（§10）：`1f20d990a3`（runner 拒绝 ae4、mp6、otbank-v18）、`4cd48da071`（no-git 钉扩展到 remote 脚本 source 的文件，以及工作流的各种 `run:` 写法与无名步骤）。
  - 第五轮复审（§11）：`c985e93a84`（工作流 `smoke` 输入的默认值由 ae4 改为 tasks）、`21930c5f4f`（默认值与拒绝说明的合同测试）。
- 结果出处：
  - §1 的命令（敏感信息扫描一行除外，其范围见 §7）在最终代码提交 `21930c5f4f` 上重跑（其后只有文档提交），结果与表中数字一致；此前一轮在 `4cd48da071` 上。core-backend 的 vitest 普查子集与 `accountIdentityDisplay.spec.ts` 本轮没有重跑，理由见 §1 对应行。
  - §10 是第四轮复审修复：变异与端到端都针对最终代码提交 `4cd48da071`。
  - §11 是第五轮复审：变异针对测试提交 `21930c5f4f`。
  - §2–§4 是首轮审阅修复的记录，在 `587587c4b7` 上取得。任务冒烟的清理语句在复审中已改，§3.1、§3.2、§3.5 的变异数字针对当时的旧语句，当前结果见 §8.2；runner、bundle 与 no-git 相关文件此后只改过 pipeline 测试里的一行注释，§3.4 仍适用。
  - §8 是复审修复：变异在 `4a69f83038` 的 harness 上跑；端到端在 `117c7b0a52` 上跑，之后的 `8cce7bccb3` 与 `4a69f83038` 只改测试，冒烟脚本与 `117c7b0a52` 逐字节相同。
  - §9 是第三轮复审修复：变异、真实库验证与端到端都针对最终代码提交 `27eea78005` 的文件内容。
- 本地环境：Node 20.20.2；PostgreSQL 15.17。staging 的 compose 是 `postgres:15-alpine`，与本地同一主版本；`plugin-tests.yml` 的 CI 用 14（此前这里写"CI 与 staging 用 16"，不对，第三轮更正）。第四轮的端到端（§10.3）在另一台机器的 PostgreSQL 16.15 上运行，与 staging 不是同一主版本。

## 1. 命令与结果

| 命令 | 结果 |
|---|---|
| `bash -n` remote.sh 与 pipeline lib | OK |
| `node --check` 工作流 tar 列表里每个打包的 `.mjs`（mint-token、soak 负载生成器、ae4、rd45、otbank-v18、mp6、hmr5、teardown 助手、tasks 冒烟，共 9 个） | 全部 OK |
| 本地执行工作流 `Validate inputs and embedded scripts` 步骤原文（`ACTION=smoke`，40 位 `DEPLOY_SHA`，其余输入取工作流默认值） | `inputs and embedded scripts OK`，退出 0 |
| `node --test scripts/ops/attendance-window-runner-pipeline.test.mjs scripts/ops/staging-tasks-smoke.test.mjs`（runner 自检步骤的原命令） | 385/385（pipeline 198；任务冒烟 187 = 32 个顶层测试 + 149 个错形回答子测试 + 6 个种子失败子测试） |
| `node --test scripts/ops/staging-attendance-tooling-teardown.test.mjs`（考勤冒烟共用的清理助手；必需检查 `test` 的 W4C-3c 步骤运行它） | 19 个：不设环境变量时 18 通过、1 跳过（真实库测试）；设 `TEARDOWN_REAL_PG_DATABASE_URL` 指向新迁移的库时 19/19（§9.3，第三轮；助手此后未改） |
| 同一 W4C-3c 步骤的 `attendance-w4c3c-execute-ops-retirement-cleanup.test.mjs`；四个考勤冒烟自己的测试（ae4 / mp6 / otbank-v18 / hmr5）；`attendance-w4c2-ci-wiring.test.mjs`（钉住 W4C-3c 步骤的文件清单） | 5/5；5/5、10/10、9/9、14/14；262/262 |
| `node --test scripts/ops/ssh-hostkey-pin-family-contract.test.mjs` | 12/12 |
| `node --test scripts/ops/ssh-hostkey-pin-family-behavior.test.mjs` | 14/14 |
| `node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs`（扫描全部 `scripts/` 的考勤写入点普查） | 60/60 |
| 引用 runner 工作流、remote 脚本或 mint 助手的其他测试：`dingtalk-interactive-card-stream-staging-uat-contract.test.mjs` / `dingtalk-oauth-staging-config-contract.test.mjs` / `dingtalk-lifecycle-staging-canary-contract.test.mjs` / `__tests__/attendance-window-runner-mint-token.test.mjs` | 50/50、8/8、213/213、6/6 |
| `apps/web/tests/accountIdentityDisplay.spec.ts`（vitest，只在注释里引用 remote 脚本） | 第三轮 17/17；本轮没有重跑：它不读取 remote 脚本 |
| `scripts/ops/attendance-run-gate-contract-case.sh strict <临时输出目录>`（Gate Contract Matrix 的 strict case，内含 pipeline 测试） | `OK: strict contract case passed`（日志里的两条 ERROR 是该脚本自带的预期失败负控） |
| core-backend 扫描仓库的普查类单测（vitest，与首轮同一组 29 个文件；其中 `attendance-w7-1a-inertness-sweep.test.ts` 读取 remote 脚本） | 第三轮 29 files / 917 tests 通过；本轮没有重跑：读取 remote 脚本的那一个文件只钉住三点（脚本提到 W7 的 posture 表、不对该表做 INSERT/UPDATE/DELETE、调用 W7-3 CLI），本轮对 remote 脚本的改动不涉及其中任何一点（按文本核对） |
| 对 `git diff 7137688372..HEAD` 与本分支全部提交信息做敏感信息扫描（见 §7） | 无命中 |

`plugin-tests.yml`（必需检查 `test (20.x)`）在每个 PR 上跑 `attendance-window-runner-pipeline.test.mjs` 与清理助手的测试（后者的真实库测试在 CI 里报为跳过）；`staging-tasks-smoke.test.mjs` 只在 runner 工作流自己的派发自检步骤里跑（见设计 §4 与 §6）。

## 2. 首轮审阅修复（`587587c4b7`；问题 → 改动 → 测试 → 变异）

| 问题 | 改动 | 测试 | 变异（§3） |
|---|---|---|---|
| 任务冒烟的 M3 响应内容断言没有被 harness 钉住：任一断言改成 `ok(true)`、去掉错误码一半或整行删除，测试全绿，staging 仍会打印 PASS | harness 重写：路由桩按方法+路径形状定键、按后端行级能力回答；可只改期望序列中某一次调用的诚实回答；133 个错形回答 cell 覆盖每个断言与复合断言的每个子条件；正常路径钉住完整调用序列与 `Assertions passed: 95` | `HARNESS wrong-shaped answers`（133 个子测试）、`HARNESS cell table`、正常路径 | 全断言扫描 195 个变异杀死 194 个，唯一存活者为等价变异；审阅列出的 27 处 `ok(true)`、3 处错误码一半、整行删除 total 断言、组合变异 XA 全部被杀 |
| bundle 闭包扫描只认 `from`/`import`/`import()` 三种写法，`createRequire`/`require`、模板字面量、`new URL('./x', import.meta.url)`、同目录读取都看不见 | 扫描改为识别全部字面量同目录写法并向 `.cjs` 成员递归；扫描无法解析的加载一律拒绝（白名单只有 rd45，写明理由，过期即失败）；新增平铺启动检查；工作流头部注释如实描述 | 控制用例（30 条）、传递闭包用例、白名单用例、平铺启动检查、原有闭包相等/tar 列表/拷贝测试 | B-1…B-5（顶层加载）与 B-1d…B-4d（流程深处加载）全部被杀；O-1…O-4 被拒；15 处扫描规则删除各被控制用例抓住；两个正对照保持全绿 |
| rd45 的空闭包依赖未被钉住的 `PLUGIN_INDEX_PATH` extra_env 行，删掉它测试仍全绿 | 可执行拷贝测试要求 rd45 的容器运行带 `-e PLUGIN_INDEX_PATH=/app/plugins/plugin-attendance/index.cjs` | 可执行拷贝测试 | R-1（删行）、R-2（改到 runner 目录）被杀 |
| M3 用例没有覆盖 `POST /api/tasks/:id/leave` 与 `GET /api/tasks/:id/parent-candidates` | 冒烟新增：设父前子任务的候选恰好是父任务；设父后父任务自己的候选为空；subject 再加 member 为关注人，member 用自己的令牌退出并读回。member 与 subject 共用角色并在种入时准入；runner 签发 `MEMBER_TOKEN` | 候选、再次加关注人、退出及退出后读回共 20 个 cell；另有 14 个"列表字段缺失"的 cell（含原有读回）；member 令牌主体不符用例；dev-token 兜底用例改为签发三枚；合同测试中的签发参数断言 | 以 subject/outsider 令牌退出、错路径、`POST` 读候选、去掉 member 角色或准入、去掉令牌主体校验、弱化列表辅助函数等 15 个冒烟侧变异与 `MEMBER_TOKEN` 签发行的 2 个 runner 侧变异全部被杀；端到端两次各发出 2 个候选请求与 1 个退出请求 |
| 冒烟头部注释称"只有带匹配 tenantId 声明的令牌才能通过认证"，实际只决定任务 org | 注释改为：任务 org 只由匹配的 tenantId 声明设置；没有声明时请求仍能认证，但 `/api/tasks/context` 回 `{orgId: null}`，写路由回 422 `ORG_MISSING` | 无（只改注释） | 不适用 |
| 清理与预检 SQL 只按前缀和部分参数检查，放宽的 WHERE 子句不会变红 | 钉住正常路径完整语句日志（文本与参数），每一轮清理的 collect 查询与 11 条 DELETE，残留与预检查询全文 | 正常路径、每个 cell 与每个失败路径的清理断言 | 放宽/收窄 DELETE、去掉预检中的条件、用常量替代计数等 34 个具名变异全部被杀 |
| fake pg 用固定 3 键行回答身份残留查询，只核对 users/roles 的清理参数 | fake pg 改为行存储，按查询自身的别名与 WHERE 计算；清理参数逐表钉住；逐身份植入残留与预存行 | `residue is counted per seeded identity`、`the preflight counts every seeded user and role`、按任务 id 的残留用例 | 关闭全文钉住后，17 个收窄/放宽类变异仍全部被行存储检查杀死 |
| `staging-tasks-smoke.test.mjs` 不在任何 PR 必需检查里 | 未改 `plugin-tests.yml`（未获授权）；设计 §4 与本记录 §6 写明它在 runner 自检步骤中运行、列为 owner 待定问题 | 不适用 | 不适用 |
| no-git 钉是文本正则，`/usr/bin/git` 绕过 | 前缀字符类加入 `/`、引号与反斜杠，后缀加入引号与 shell 运算符；新增应命中/不应命中控制用例；可执行检查在 PATH 前放记录型 `git`，工作目录改为临时目录 | `the git-invocation pin matches every spelling…`、生产 checkout 测试、可执行拷贝测试 | P4（`/usr/bin/git … || true`）与 `command git`、`env git`、`\git`、`"git"` 形式全部被杀；把正则改回旧版本时控制用例变红 |
| outsider 令牌的 perms 取 `tasks:read` 还是 `tasks:read,tasks:write` | 保持 `tasks:read`，理由写入设计 §2.2 | 合同测试固定签发参数 | `drop-outsider-token` 被杀 |

## 3. 首轮变异证明（`587587c4b7`）

本节为首轮记录。任务冒烟的清理语句在复审中已改为按创建者选行，§3.1、§3.2、§3.5 针对的是旧语句；复审后的结果见 §8.2。

做法：
- 任务冒烟脚本与其测试的变异在工作区之外的副本目录里进行（每个变异一个目录，冒烟脚本改动、测试文件原样），工作区不被写入。
- runner/bundle/no-git 变异在工作区内进行：备份 → 改动 → 跑 pipeline 合同测试中与 bundle 和 tasks 注册相关的子集 → 用备份 `cp` 还原 → `cmp` 确认逐字节一致；新建的临时文件删除。全部 50 个变异还原后逐字节一致，结束后工作区无改动。

### 3.1 任务冒烟：全断言扫描（自动生成）

从冒烟源码解析出每个 `ok(...)` 调用与每个 `if (...) throw` 守卫，生成：条件整体换成 `true`（55）、复合条件逐个去掉一个子条件（59）、整条 `ok(...)` 删除（57）、守卫条件换成 `false`（23）、M3 段全部条件同时换成 `true`（1）。共 195 个，杀死 194 个。

唯一存活：`seedIdentities` 中"身份 id 必须带 `tasks-smoke-` 前缀"的守卫换成 `false`。它是等价变异：STAMP 在 `main()` 之前就被正则锁定为 `tasks-smoke-…`，所有身份 id 都由 STAMP 推导，该守卫在任何输入下都不可能触发（纵深防御）。

审阅列出的变异在新行号上的结果：27 处 `ok(true)` 全部被杀；outsider 404、删除 409、已删任务读取 404 三处去掉错误码一半（子条件变异）全部被杀；整行删除"墓碑仍计入 total"断言被杀（`Assertions passed` 计数与其 cell 同时变红）；组合变异 XA 被杀。

### 3.2 清理、预检与残留 SQL（具名）

| 变异 | 结果 |
|---|---|
| DS1 user_roles 的 DELETE 加 `OR role_id = 'attendance_employee'` | 杀死 |
| DS2 tasks 的 DELETE 加 `OR org_id IS NOT NULL` | 杀死 |
| DS3 预检 user_roles 计数去掉 `OR role_id = ANY($2)` | 杀死 |
| DS4 `task_followers_by_user` 换成 `(SELECT 0)` | 杀死 |
| B1、B1b、B1c、B1d、B1e、B1f 身份残留查询逐个去掉 user_roles、user_orgs、admissions、role_permissions、task_comments_by_author、tasks_by_creator 计数 | 全部杀死 |
| B2 预检去掉 `to_regclass('public.task_comments')` | 杀死 |
| B3 task_comments 清理参数改为 `[[]]`；B3b user_roles 清理参数改为 `[[], SEEDED_ROLE_IDS]`；XB = B1 + B3b | 全部杀死 |
| B4 删除按创建者收集任务 id 的代码块；B5 删除 `tasks.id` 残留计数 | 全部杀死 |
| 逐条删除 11 条清理 DELETE；users 清理参数收窄；身份残留参数收窄；collect 参数收窄；先删 tasks 再删 task_assignees；残留只数四张已知表；users 残留改按角色 id；task_assignees 残留改按 task_id | 全部杀死 |

合计 34/34。另把测试中的"语句全文与参数"断言整体关掉，再跑其中 17 个放宽/收窄类变异（DS1–DS4、B1–B1f、B3、B3b、XB、两条 DELETE 删除、两条参数收窄）：17/17 仍被行存储检查杀死（逐身份残留、本次写入行不得残留、他人行不得删除、计数个数）。

### 3.3 关注人退出与父任务候选

冒烟侧（副本目录）15/15 杀死：以 subject 令牌退出（非关注人 → 404）、以 outsider 令牌退出（只读 → 403）、退出路径写错、退出前不再加关注人、候选用 `POST` 读取、候选不再实际请求、设父用 `POST`（路由桩按方法区分）、member 种入时不带角色、member 不准入、去掉 `MEMBER_TOKEN` 的主体校验、`unlisted`/`listed`/`followersOf`/`assigneeIdsOf`/`childIdsOf` 把缺失字段当成列表。runner 侧（§3.4）：删除 `MEMBER_TOKEN` 签发行、把它的 perms 改成 `tasks:read`，均被杀。

### 3.4 runner、bundle 与 no-git（工作区内）

| 变异 | 结果 |
|---|---|
| B-1 顶层 ``import(`./staging-new-helper.mjs`)``（新建该文件） | 杀死（闭包相等、tar 列表、可执行拷贝、fail-closed、平铺启动检查） |
| B-1 对照：同上，并把它列入 `smoke_deps`、tar 列表与 node --check 列表 | 全绿 |
| B-2 顶层 `createRequire(import.meta.url)('./staging-new-helper.cjs')` | 杀死 |
| B-3 顶层 `readFileSync(new URL('./staging-new-data.json', import.meta.url))` | 杀死 |
| B-4 顶层 `import(new URL('./staging-new-helper.mjs', import.meta.url).href)` | 杀死 |
| B-5 已列入且已打包的 `.cjs` 成员再 `require` 一个未列入的 `.cjs` | 杀死 |
| B-5 对照：第二个 `.cjs` 也列入并打包 | 全绿 |
| B-1d…B-4d 同样四种写法放在 `cleanup()` 里（环境变量拒绝之前不会执行） | 全部杀死（只由扫描推导的测试抓住，平铺启动检查保持绿，符合预期） |
| O-1 赋给变量的 `createRequire` 再加载 `./x.cjs`；O-2 ``import(`./${STAMP}.mjs`)``；O-3 `readFileSync('./staging-new-data.json')`；O-4 `fileURLToPath(import.meta.url)` | 全部杀死（不在白名单） |
| R-1 删除 rd45 的 `PLUGIN_INDEX_PATH` extra_env 行；R-2 把它改到 runner 目录 | 杀死 |
| A-1 rd45 白名单去掉 `createRequire`；A-2 白名单多一条不再命中的写法 | 杀死 |
| 逐条删除 8 条同目录写法规则与 7 条拒绝规则（15 个） | 全部杀死（控制用例变红） |
| P4 `action_smoke` 里加 `/usr/bin/git -C "$(resolve_home_path "$DEPLOY_PATH")" pull --ff-only origin main || true`；同位置的 `command git`、`env git`、`\git`、`"git"` 形式 | 全部杀死 |
| 把 no-git 正则改回修复前的前缀字符类 | 杀死（控制用例变红） |
| M-1 删除 `MEMBER_TOKEN` 签发行；M-2 其 perms 改成 `tasks:read` | 杀死 |
| 首轮的 8 个变异在新 head 上重跑（tar 列表去掉 teardown 助手、node --check 去掉 mp6、加回 `git -C "$PROD_REPO_DIR" pull`、加回 `(cd "$PROD_REPO_DIR" && git pull)`、调用处去掉闭包、删掉 ae4 的 `smoke_deps`、`copy_smoke_bundle` 只拷第一个参数、删掉 `OUTSIDER_TOKEN` 签发行） | 全部杀死 |

合计 48 个变异全部杀死，2 个对照保持全绿，50 次还原全部逐字节一致。

### 3.5 首轮任务冒烟变异在新 head 上重跑

残留只数已知四张表、清理去掉 `task_comments`、outsider 的 orgId 检查失效、outsider 读到 200 不再判 SECURITY、有子任务时删除不再要求 409、种入身份去掉 member：6/6 杀死。

## 4. 首轮本地端到端（`587587c4b7`）

首轮后端未设 `NODE_ENV=production`（令牌由 mint 助手签发，没有用到 dev-token 路由）；复审的端到端（§8.3）设了。

### 4.1 环境

- 新建库 `rsmoke_e2e_fix`；在 `packages/core-backend` 下用标准 `MIGRATION_EXCLUDE`（`008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql`）执行 `./node_modules/.bin/tsx src/db/migrate.ts`：425 条迁移全部成功，含 `zzzz20260926120000_create_task_p0a_tables`、`zzzz20260926120100_add_task_permissions`、`zzzz20260930090000_create_task_comments`。
- 后端：本分支 `587587c4b7` 的完整服务（`tsx src/index.ts`），监听回环地址的非默认端口；`TASKS_ENABLED=true`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`、`PRODUCT_MODE=platform`、`JWT_SECRET` 为 32 字节随机数的十六进制串。`/health` 200；无令牌访问 `/api/tasks/context` 为 401。
- 本库里带 `task_id` 列的 BASE TABLE：`bpmn_audit_log`（uuid）、`dingtalk_approval_card_deliveries`、`task_assignees`、`task_comments`、`task_events`、`task_followers`。冒烟的残留计数因此是 18 项（身份/按用户 11 项 + task_id 表 6 项 + tasks 按 id 1 项）。
- 管理员：新库没有用户，种入一个 `role='admin'` 的管理员；之后与 runner 一样用 mint 助手的 `--find-admin` 找到它。

### 4.2 按 runner 的方式运行

驱动脚本对每次运行：

1. 从工作流文件解析 tar 列表（11 个文件），`tar -czf` 打包后用 `tar -xzf --strip-components=2` 解到一个空目录（对应部署机上的 `HERE`）。
2. 建一个容器式目录（`<root>/scripts/ops` + `<root>/node_modules` 符号链接，对应 runner 的 `ln -sfn /app/node_modules`），按 remote.sh 自己的 case 语句（bash 执行）取 `smoke=tasks` 的冒烟脚本与 `smoke_deps`，连同 mint 助手从 bundle 拷入。
3. 用 mint 助手签发令牌，参数与 runner 的 `mint_token` 相同：管理员 `--roles admin --perms attendance:read,attendance:write,attendance:admin,attendance:approve`；subject `--user-id <stamp> --roles user --perms tasks:read,tasks:write --tenant-id default`；member `--user-id <stamp>-member --roles user --perms tasks:read,tasks:write --tenant-id default`；outsider `--user-id <stamp>-outsider --roles user --perms tasks:read --tenant-id default`。令牌只放在变量里，不打印。
4. 以空环境（`env -i`，只给 `PATH` 和冒烟需要的变量）、在 bundle 之外的工作目录里从容器式目录运行冒烟。

两次运行，各用一个新 stamp：

```
TASKS_API_DB_SMOKE_PASS deploy=587587c4b754863d8774419edde50a2ad23db859 stamp=tasks-smoke-localfix1 org=default task=tsk_36f990efa3c0af78b1e7ac23e83bbc09 residue=0
Assertions passed: 95
TASKS_API_DB_SMOKE_PASS deploy=587587c4b754863d8774419edde50a2ad23db859 stamp=tasks-smoke-localfix2 org=default task=tsk_caf360758bb36521b3d700929fd4e98d residue=0
Assertions passed: 95
```

两次日志里没有 `FAIL` 或清理告警；95 与 harness 钉住的计数一致。后端日志：每次运行 2 个 `GET /api/tasks/:id/parent-candidates`、1 个 `POST /api/tasks/:id/leave`（两次共 4 与 2）；与冒烟相关的告警只有预期的两条（subject 在授予准入之前访问 `/api/tasks/context` 被拒，`missing permission tasks:read`）；没有任务路由错误。

### 4.3 自行用 SQL 复核残留

两次运行之后，按两次的 6 个身份、4 个角色和 2 个父任务 id 查询：users、user_orgs、user_roles（按用户或角色）、user_namespace_admissions、roles、role_permissions、tasks（按 created_by、按 id）全部为 0；`tasks`、`task_assignees`、`task_followers`、`task_events`、`task_comments`、`dingtalk_approval_card_deliveries`、`bpmn_audit_log`、`user_roles` 整表为 0，`users` 整表只剩种入的管理员。另对 `public` 下全部 BASE TABLE 的 2621 个 text/varchar/char/json/jsonb 列做 `LIKE '%tasks-smoke-%'` 扫描：命中 0 列。

### 4.4 收尾

本地后端已停止，库 `rsmoke_e2e_fix` 已 `DROP DATABASE`，临时 JWT 密钥文件已删除。

## 5. NOT RUN

- staging 上的实际运行：合并之后通过工作流派发 `action=smoke`、`smoke=tasks` 执行，本记录不含 staging 结果。
- 考勤冒烟在 staging 上的运行：ae4、mp6、otbank-v18 按规则被 runner 拒绝（§10）；rd45、hmr5 可以运行，但当前没有开放的考勤窗口，仍然没有在 staging 上跑过。五个冒烟都随 bundle 打包，本地由平铺启动检查（已提交为测试）证明模块图可解析并走到各自的环境变量拒绝。ae4、otbank-v18、mp6、hmr5 共用的清理助手，其用户前缀过滤已修复，并在真实 PostgreSQL 上按这四个冒烟的范围验证（§9.3）；考勤冒烟的业务流程本身没有在本地或 staging 上由本 PR 执行（第四轮复审在模拟环境里跑过 ae4、mp6、otbank-v18，结论见 §10.1）。
- PostgreSQL 14（`plugin-tests.yml` 的 CI 版本）：本地只跑了 15.17；清理助手的真实库测试在 CI 里报为跳过。staging 为 15，与本地同一主版本。第四轮的端到端在 16.15 上运行，没有在 15 上重跑；前几轮的端到端在 15.17 上运行，冒烟脚本此后未改。
- Node 18：未跑。本分支的 base 上 `plugin-tests.yml` 的矩阵含 18.x；main 已在 #6246 去掉 18.x，合并后 CI 只在 20.x 上跑这些测试，不再有 Node 18 覆盖。本地只用了 Node 20.20.2。
- 工作流本身（GitHub Actions 上的 tar/ssh 与远端执行）：未派发；bundle 的打包与平铺解包用本地 `tar` 复现，容器拷贝用合同测试里的记录型 `docker` 与本地拷贝复现，没有对真实容器执行 `docker cp`。
- core-backend 全量 vitest：未跑全量，只跑了 §1 列出的扫描仓库的普查类子集（本 PR 不改后端代码）。
- 复审的 P2 场景（后端把别人的任务 id 当作新建任务回答）：只在本地用改写回答的代理复现（§8.3），没有在 staging 上制造。

## 6. 待定事项

- 是否把 `staging-tasks-smoke.test.mjs` 加入 PR 门禁工作流：它目前只在 runner 工作流自己的派发自检步骤（`Run pipeline self-test`）里运行，该步骤在同步 bundle 和任何远端操作之前执行、失败即中止派发；PR 必需检查只跑 pipeline 合同测试。本 PR 未改 `plugin-tests.yml`。
- 关注人自行退出用例要求 member 登录，runner 因此多签发一枚 `MEMBER_TOKEN`（member 与 subject 共用 `tasks:read,tasks:write` 角色）。如希望 runner 只签发两枚任务令牌，可去掉该用例（remote.sh 一行、冒烟一个函数及对应测试）。
- outsider 令牌保持 `tasks:read`（理由见设计 §2.2）；若改为 `tasks:read,tasks:write`，只需改 remote.sh 一行和对应的合同断言，staging 上声明不影响权限判定。
- 清理助手的真实库测试（§9.3）只在设置 `TEARDOWN_REAL_PG_DATABASE_URL` 时运行，目前没有任何 CI 步骤启用它，CI 里只有不需要数据库的语句钉。是否在某个已有迁移库的真实库步骤里启用它（事务内运行并回滚，不留数据）？本 PR 未改 `plugin-tests.yml`。

## 7. 敏感信息扫描

对 `git diff 7137688372..HEAD`、`git log 7137688372..HEAD` 的提交信息（含两轮复审的全部提交与本文件的更新）以及 PR 描述，按四类模式（机器名、局域网网段、用户主目录路径、系统临时目录路径）做 `grep -nE` 扫描：无命中。第三轮另用两版私有裁决包重叠扫描（v1 与 v2）扫本记录、设计文档与 PR 描述：无命中。第四轮对同样的范围重扫，模式另加外接卷路径、本地主机名后缀、端到端所用的数据库角色名与辅助脚本名：无命中；两版重叠扫描同样无命中。第五轮对本轮的 diff、提交信息与 PR 描述用同一组模式重扫（另加端口号），并对本记录、设计文档与 PR 描述重跑两版重叠扫描：均无命中。文档与代码不含机器名、主机名、局域网地址或本地路径；本文件也不写出这些模式的字面量，以免扫描命中自身。

## 8. 复审修复（第二轮）

复审确认 1 个 P2，另有若干 P3 与 NIT。本轮修复 P2 和两个 P3：评论编辑后读回，以及两处可按值弱化的读回。其余 10 项记为已知项，不改代码（§8.4）。

### 8.1 问题 → 改动 → 测试

| 问题 | 改动 | 测试 |
|---|---|---|
| P2：清理按 API 回答里的任务 id 硬删除。后端若把别人的任务 id 当作新建任务回答，清理会删掉那个任务及其评论、事件、关注人、执行人行；残留检查又按同一批 id 计数，报告干净 | 冒烟（`bcb9d9148a`）：<br>- 每次创建后在库里确认回答的 id 是 subject 创建、标题与发送的一致、位于本 org 的任务，否则当步失败、不使用该 id。<br>- 四张子表的 DELETE 改为 `task_id IN (SELECT id FROM tasks WHERE created_by = ANY(种入身份))`，`tasks` 的 DELETE 只按 `created_by`，没有任何 DELETE 绑定任务 id。<br>- 残留只按库里读到的本次运行任务 id 计数。<br>- 冒烟头注释与设计 §2.4 改为陈述这条规则。 | - 创建父任务、创建子任务回答他人任务的 id，创建子任务回答父任务的 id：都停在创建校验。<br>- 设父、删除子任务、新评论回答他人任务的 id（`8cce7bccb3`）：各在自己的断言处失败。<br>- 新建任务落在别的 org；collect 查询失败。<br>- 清理之后才出现、挂在本次任务 id 下的他人行不被删除。<br>- 回答没被使用时，残留仍计入本次运行真实创建的任务（`4a69f83038`）。<br>- 每个 cell 的清理检查钉住每轮清理后的全部残留语句，并要求没有任何清理或残留语句绑定到他人任务的 id。 |
| P3（端到端）：评论编辑从不读回，回答了新正文却没有保存的后端仍得到 PASS | 冒烟（`c17de226f1`）：PATCH 之后 `GET /api/tasks/:id/comments`，按评论 id 找到该行，要求新正文且 `deleted: false` | 新步骤"comment list after the edit"的 6 个 cell：500、旧正文、已删除、行缺失、`items` 不是数组、带新正文的另一条评论 |
| P3（测试）：父任务 `children` 里子任务的查找与 depth 检查、墓碑的查找可被按值弱化而测试全绿 | 冒烟（`117c7b0a52`）：查找本身已按 id；墓碑查找改为 `item?.id`，列表里的 null 元素不再抛错 | 父任务列出别的子任务（depth 1）、子任务 depth 为 0、另一条评论的墓碑、删除后评论列表的 `items` 不是数组 |

计数变化：任务冒烟 harness 从 161 个测试（28 个顶层 + 133 个 cell）变为 180 个（31 + 149），正常路径的 `Assertions passed` 从 95 变为 99：两次创建校验与编辑后读回的两条断言。

### 8.2 变异

做法同 §3：在工作区之外的副本目录里改冒烟脚本、测试文件原样，运行 `node --test`，工作区不被写入。harness 为 `4a69f83038`。"关闭语句钉"指把 harness 里两处"语句全文与参数"断言（正常路径的完整语句日志、每轮清理之后的语句序列）换成空操作，只留行存储检查。

| 组 | 变异 | 结果 |
|---|---|---|
| 复审要求的两个 | P2-A 改回按 id 删除（保留创建校验）；P2-B 去掉创建校验（保留按创建者删除） | 都杀死。关闭语句钉后仍都杀死：P2-A 由"清理之后才出现的他人行不得删除"用例，P2-B 由他人任务 id 的 cell 与 org 用例 |
| 修复前的代码 | P2-C 两者同时 | 杀死。只保留 cell 的清理断言时，两个"创建回答他人任务 id"的 cell 报"cleanup deleted a row this run did not write"，被删的正是他人任务及其评论、事件、关注人、执行人行 |
| 只改一半 | P2-D 只把子表 DELETE 改回按 id；P2-E 只给 `tasks` 的 DELETE 加回 `id = ANY` | 杀死，关闭语句钉后同 P2-A |
| 创建校验 | C1–C4 逐个去掉 id、created_by、title、org 条件；C5 结果恒真；C6 记录失败但不抛出；C7 删掉断言行；C8 校验之前就加入任务 id；C9 通过校验的 id 不加入；C10 collect 到的 id 不加入 | 全部杀死，关闭语句钉后也全部杀死。每个条件都有只靠它区分的 cell：他人任务与父任务同标题、同 org；子任务回答父任务的 id；任务落在别的 org |
| | C11 计数比较改成 `>= 1` | 存活，等价变异：`id` 是主键，计数只能是 0 或 1 |
| 清理语句 | D1 删掉 `task_comments` 的 DELETE；D2 子表的子查询放宽到本 org 的任务；D3 `tasks` 的 DELETE 放宽到本 org；D5 `tasks` 的 DELETE 移到子表之前；D6 collect 移到 DELETE 之后 | 全部杀死，关闭语句钉后也全部杀死 |
| | D4 `tasks` 的 DELETE 收窄到 subject | 杀死；关闭语句钉后存活：运行中只有 subject 创建任务，行为上等价，只由语句与参数钉抓住 |
| 后续步骤 | L1–L3 把设父、删除子任务、新评论回答里的 id 加入本次运行的任务 id | 全部杀死。关闭语句钉后只由新的"他人任务 id" cell 杀死，原来回答 `tsk_other` 的 cell 在 fake 库里没有对应的行，对此无效；只保留 cell 的清理断言时，失败原因是有残留语句绑定到他人任务的 id |
| 编辑读回 | E1 去掉读回（即 `617ed7f1ec` 的代码）；E2 恒真；E3、E4 去掉正文、deleted 条件；E5 取 `items[0]`；E6 按正文而不是 id 查找；E7 与旧正文比较；E8 状态不对时不停止；E9 删掉状态断言；E10 去掉数组判断 | 全部杀死 |
| 按 id 查找 | X01 `children` 取第 0 个；X01b 按 depth 查找；X02 不再检查 depth；X03 墓碑取 `items[0]`；X03b 取任一已删除行；X03c 去掉数组判断 | 全部杀死（X01、X02、X03 即复审列出的三个） |
| 全断言扫描 | 与 §3.1 相同的自动生成：每个 `ok(...)` 条件换成 `true`、复合条件逐个去掉子条件、整条删除、每个 `if (...) throw` 守卫换成 `false`、M3 段全部条件同时换成 `true` | 202 个，杀死 201 个；唯一存活仍是 §3.1 所述的身份前缀守卫（等价变异） |

具名变异合计 41 个：杀死 40 个，存活的 C11 为等价变异。关闭语句钉后杀死 39 个，另一个存活的是 D4。

### 8.3 本地端到端

环境：

- 新建库，按标准 `MIGRATION_EXCLUDE` 执行迁移：425 条全部成功，含三条任务迁移。
- 后端：本分支 `117c7b0a52` 的完整服务，监听回环地址的非默认端口。`NODE_ENV=production`，dev-token 路由不挂载，探测为 404。`TASKS_ENABLED=true`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`、`PRODUCT_MODE=platform`；`JWT_SECRET` 为 32 字节随机数的十六进制串。`/health` 200；无令牌访问 `/api/tasks/context` 为 401。
- 运行方式与 §4.2 相同：
  - 工作流 tar 列表（11 个文件）打包后平铺解包；
  - 按 remote.sh 自己的 case 语句取冒烟脚本（`smoke_deps` 为空），连同 mint 助手拷进容器式目录（`scripts/ops` 加 `node_modules` 符号链接）。bundle 里的冒烟脚本与工作区逐字节相同；
  - mint 助手 `--find-admin` 找到种入的管理员；
  - 按 remote.sh 的 `mint_token` 参数签发 ADMIN、SUBJECT、MEMBER、OUTSIDER 四枚令牌，后三枚带 `--tenant-id default`；
  - 空环境、bundle 之外的工作目录运行冒烟。
- 令牌只放在变量里。每次运行后在冒烟日志里查找四枚令牌及其签名段：五次运行均为 0。

结果：

1. 两次正常运行：

```
TASKS_API_DB_SMOKE_PASS deploy=117c7b0a525220df832fb62f49493f17f9eabe7d stamp=tasks-smoke-fix2a org=default task=tsk_24aee1aa9453167af0b62f9b95501d02 residue=0
Assertions passed: 99
TASKS_API_DB_SMOKE_PASS deploy=117c7b0a525220df832fb62f49493f17f9eabe7d stamp=tasks-smoke-fix2b org=default task=tsk_6a8215d037974bca260e20321abc19a6 residue=0
Assertions passed: 99
```

   - 两次都没有 FAIL 或清理告警。两次创建校验与编辑后读回都打印 PASS。残留计数 18 项：本库有 6 张带 `task_id` 的表。
   - 每次运行前后，四张任务表、`tasks` 与六张身份表共 11 张表的整表行数，以及按行文本的 md5，完全相同。

2. 预置他人任务的运行。运行前先种入另一身份（角色、权限、user_roles、user_orgs、准入）及其任务，共 15 行：
   - 一个父任务和它的子任务，同在 org `default`；
   - 父任务下评论、关注人各一行；
   - 两个任务各有一行执行人与一行事件。

   之后正常运行一次：

```
TASKS_API_DB_SMOKE_PASS deploy=117c7b0a525220df832fb62f49493f17f9eabe7d stamp=tasks-smoke-fix2planted org=default task=tsk_a996208baf86f686fb66ac3b015326d0 residue=0
Assertions passed: 99
```

   这 15 行在运行前后按全文导出，`cmp` 逐字节相同；11 张表的整表校验也相同。

3. 复审的 P2 场景，在第 2 步的数据上另跑两次。在后端前放一个只改写回答的代理：第一次把父任务的 `POST /api/tasks` 的 200 回答里的 `id` 换成他人父任务的 id，第二次换的是子任务的。两次冒烟都在创建校验处失败、退出 1：

```
  FAIL  the DB holds the created task as the subject's, with the title it sent, in org default - {"id":"tsk_e2eforeignparent"}
FAIL: POST /api/tasks answered id "tsk_e2eforeignparent", which the DB does not hold as a task tasks-smoke-fix2proxy1 created in org default with the title this run sent; the run does not use that id, and cleanup and residue cover only the tasks the seeded identities created
Residue after best-effort cleanup: {} (clean=true)
```

   - 他人的 15 行在运行前后 `cmp` 逐字节相同，11 张表的整表校验也相同。
   - 本次运行真实创建的任务，即代理改写之前的 id，按创建者被清理。
   - 这里的 `clean=true` 只覆盖本次运行的任务 id 与种入身份。他人任务的 id 不在任何残留语句的参数里，错误行点名它不被使用。复审时，修复前的代码在同一场景下删掉了他人任务的行，并打印同样的 `clean=true`。

自写 SQL 复核，在五次运行之后进行，对象是五个 stamp 的 15 个身份与 10 个角色、三次走完的运行的父任务 id，以及两次被代理改写的真实任务 id：

- 以下计数全部为 0：
  - users、user_orgs、user_roles（按用户或角色）、准入、roles、role_permissions；
  - tasks（按 created_by、按 id）；
  - 四张任务子表（按任务或用户）；
  - `dingtalk_approval_card_deliveries` 与 `bpmn_audit_log`（按任务）。
- 整表只剩预置的行：tasks 2、task_assignees 2、task_followers 1、task_events 2、task_comments 1、users 2（管理员与他人）、user_roles 1。
- 对 `public` 下全部 BASE TABLE 的 2621 个文本类列做 `LIKE '%tasks-smoke-%'` 扫描：命中 0。

后端日志：

- 请求数：评论列表 6 次（三次走完的运行各 2 次）、评论编辑 3 次、父任务候选 6 次、退出 3 次。
- 与冒烟相关的告警只有每次运行一条预期的拒绝，共 5 条：subject 在准入之前访问 `/api/tasks/context`。
- 没有错误级日志。

收尾：后端已停止，库已删除，临时 JWT 密钥文件已删除。

### 8.4 已知未修项（复审其余 P3 与 NIT，本轮不改代码）

1. P3：任务路由桩按方法与路径形状定键（第三轮起另核对每个请求的任务 id 与子 id，见 §9），不看查询串、reopen 请求体、Content-Type 与认证方案。理由：其中 M01、M04、M05、M21 在 staging 上会大声失败；M02、M03 对 subject 自己的单执行人任务行为相同，不会产生假 PASS。
2. P3：残留检查的缺表守卫与表枚举各只有一个测试点。理由：按用户的身份残留仍覆盖四张任务表，当前不会产生假 PASS。
3. P3：清理时单条语句失败只告警、继续执行（M14），这一行为没有测试。本轮新增的 collect 失败用例走的是 collect 自己的 try/catch，不经过 `run()` 的逐条捕获，所以该项仍未覆盖。理由：清理即使提前停止，运行仍因残留失败。
4. P3：冒烟与 runner 两侧都没有测试"令牌不打印"；`SUBJECT_TOKEN` 没有主体不符用例。理由：当前代码不打印令牌，本轮五次端到端运行的日志里令牌与签名段命中 0；`SUBJECT_TOKEN` 的缺口沿自 base。
5. P3：`action_smoke` 把冒烟退出码传给 runner（R10），这一点没有测试。理由：该段代码沿自 base，本 PR 未改。
6. P3：容器准备的顺序没有测试（R01、R02：`node_modules` 符号链接，以及先建目录再拷贝）。理由：两种破坏在 staging 上都会大声失败，代码沿自 base。
7. P3：rd45 白名单按"模块加写法"匹配；`process.argv[1]` 拼出的路径不在不透明写法里；rd45 对 `PLUGIN_INDEX_PATH` 的读取未钉住（D01、D02、A01）。理由：都是潜在缺口，今天没有代码使用这些写法。
8. P3：runner 自检步骤本身没有测试钉住（W01–W03）。理由：该步骤沿自 base；是否把 harness 放进 PR 门禁已列为待定事项（§6）。
9. P3：soak 负载生成器被单独拷进容器，却不在"单独拷贝的文件须无闭包"的检查里（M30）。理由：沿自 base；生成器今天只 import Node 内置模块，失败时 fail-closed，不碰 staging 数据。
10. NIT：闭包扫描的若干子规则与 no-git 正则的若干分支没有控制用例（P03、P04、P06、P07、P08、P09、P11、G01）。理由：都是潜在缺口，今天的 bundle 成员与 remote.sh 都不会触发。

## 9. 复审修复（第三轮）

第三轮复审确认两项：清理助手的用户前缀过滤（两票 P1、一票 P2），以及 harness 不核对请求指向的任务（两票 P2、一票认为应为 P3）。另有 1 个 P3、3 个 NIT。本轮全部修复。

### 9.1 问题 → 改动 → 测试

| 问题 | 改动 | 测试 |
|---|---|---|
| P1：考勤冒烟共用的清理助手 `staging-attendance-tooling-teardown.mjs` 的用户前缀过滤，把同一个占位符同时用作 `left()` 的长度和比较值（`left(user_id, $N) = $N`）。PostgreSQL 由 `left(text, integer)` 把该参数定为 integer，比较成了 `text = integer`，报 42883。凡带 `userIdPrefix` 的范围，第一条语句就失败：ae4、otbank-v18、mp6、hmr5 的清理每次都抛错，其后的 DELETE 全部跳过。本 PR 让这四个冒烟能在容器里加载；不修这处，合并后它们一在 staging 上运行就会在 org `default` 留下残留 | 助手（`867a1f6e41`）：<br>- 三处过滤（`countW4ImmutableAttendanceRows`、`runStagingAttendanceRecordTeardown`，以及 `cleanupStagingAttendanceScope` 的 `filter` 与 `listedFilter`）改为 `left(<列>, length($N::text)) = $N::text`。<br>- 仍是一个参数，两处都显式按 text 绑定，各函数的参数列表形状不变。<br>- 助手其余语句逐条检查过：没有别的占位符被重复使用，`ANY($n::uuid[])` / `ANY($n::text[])` 都有显式类型；§9.3 的真实库运行执行了每一条。<br>- 冒烟脚本的业务步骤不改 | 均在 `staging-attendance-tooling-teardown.test.mjs`，已在必需检查 `test` 的 W4C-3c 步骤里运行：<br>- 四个冒烟调用处的范围参数与查询包装按原文钉住；<br>- 对这四个范围，`cleanupStagingAttendanceScope` 与三个自己拼过滤的函数发出的每条语句，全文与参数都钉住；<br>- 每条语句都过占位符规则：作为 `left()` 长度的占位符必须绑定整数，且不得在同一语句里再出现；前缀比较的两处必须是同一个 text 参数；<br>- 按环境变量启用的真实 PostgreSQL 测试（§9.3） |
| P2：任务 harness 只核对每个请求的方法和路径形状，不核对它指向哪个任务。读一个从未创建的 id 与行级拒绝得到同样的 404 `NOT_FOUND`，正是 outsider 检查和已删任务检查接受的回答 | harness（`99c57be260`）：<br>- 路由桩把每个请求记为 `{method, key, 任务 id, 子 id}`。<br>- `CALLS` 每一项写明目标：父任务 `tsk_1`、子任务 `tsk_2`、评论 `tcmt_3`；移除执行人、移除关注人的子 id 为 member。<br>- 正常路径与每个 cell 都比较完整的调用轨迹，会停止的 cell 比较到该步为止。<br>- 桩另记引用了它从未发出的任务 id 或评论 id、或子 id 不是种入身份的请求；`runSmoke` 在每个测试里要求这个列表为空。<br>- `at` 改写的请求必须方法、键、任务 id、子 id 全部吻合 | 新增直接驱动路由桩的控制用例：<br>- 轨迹逐项比对；<br>- stamp、标签、未知评论、非种入用户都进未发出列表，已发出的父任务和种入的 member 不进；<br>- 落在同一路由、但指向另一任务的 `at` 改写记为错位 |
| P3：种子失败后的清理只在 users 的 INSERT 处测试 | harness（`75c8a109be`）：按顺序让每个种子 INSERT 失败（roles、role_permissions、users、user_roles、user_orgs、user_namespace_admissions），每个一个子测试 | 每个子测试要求：<br>- 非零退出，没有任何请求；<br>- 残留复核干净，清理语句序列完整；<br>- 恰好删除失败之前写入的种子行。<br>第一个 INSERT 失败时什么都还没写，清理语句仍须发出 |
| NIT：remote.sh 的注释说 `TASKS_ENABLED` 检查先于身份检查、先于拷入容器，没有测试 | 合同测试（`a9480f3bd1`）：假 docker 对 `printenv TASKS_ENABLED` 的回答可配置；身份探针 `fetch_health_commit` 记录每次调用 | 回答为 `false`、未设置、`TRUE` 三种：真实 `action_smoke` 失败并写出观察到的值，docker 调用只有那一次 `printenv`，身份探针 0 次。回答为 `true` 时，`printenv` 是第一个 docker 调用，运行继续到拷贝。注释不改，现在有测试支撑 |
| NIT：no-git 钉只扫 remote.sh，在工作流里以 ssh 步骤加回部署机 `git pull` 仍然全绿 | 合同测试（`27eea78005`）：<br>- 调用 `ssh` 或 `scp` 的工作流步骤（按命令词识别，边界规则与 `git` 相同）必须恰好是 bundle 同步与远端执行两个；<br>- 这两个步骤的每一条可执行行都不得有 `git` 调用，覆盖 ssh 命令行、拼远端命令的变量和远端 prelude 字符串 | ssh/scp 识别的控制用例：应命中 7 条，不应命中 5 条 |
| NIT：§5 的 Node 18 一条在合并后过时 | §5 改写 | 不适用 |

另外两处更正：
- 本记录头部与 §5 原写"CI 与 staging 用 PostgreSQL 16"，不对。staging 的 compose 是 `postgres:15-alpine`，`plugin-tests.yml` 的 CI 用 14（`ankane/setup-postgres`，`postgres-version: 14`）。两处已改。
- §8.4 第 1 项的措辞按本轮的调用轨迹更新。

复审建议的临时做法，是在修复落地前让 runner 拒绝这四个考勤冒烟。修复已在本 PR 内，这个做法不再需要。（第四轮出于另一个原因对其中三个采用了拒绝规则，见 §10。）

计数变化：
- pipeline 合同测试 190 → 193：`TASKS_ENABLED` 关闭用例、ssh/scp 识别控制用例、工作流 no-git 钉各 1 个。
- 任务 harness 180 → 187：
  - 顶层测试 31 → 32，新增的是路由桩控制用例；种子失败用例仍是 1 个顶层测试。
  - 子测试 149 → 155：149 个错形回答 cell，加 6 个种子 INSERT 子测试。
- runner 自检命令 370 → 380。
- 清理助手测试 14 → 19。不设环境变量时 18 通过、1 跳过。
- 正常路径的 `Assertions passed` 仍为 99，本轮没有改冒烟脚本。

### 9.2 变异

做法：
- 清理助手：每个变异一个工作区之外的副本目录，拷入全部 `scripts/ops/staging-attendance-*.mjs`，`packages/core-backend` 以符号链接接入以便加载 `pg`。测试文件先不带环境变量跑一次（只有无库钉），再带 `TEARDOWN_REAL_PG_DATABASE_URL` 指向新迁移的库跑一次。
- harness（复审的 S01–S07）：在工作区内逐个进行：备份 → 改冒烟脚本 → 跑 runner 自检的原命令（两个文件）→ 用备份 `cp` 还原 → `cmp` 逐字节一致。
- 种子失败一组（S08）：工作区之外的副本，新 harness 与上一版 harness（`99c57be260`）各跑一次。
- remote.sh 与工作流：在工作区内进行，跑 pipeline 合同测试，同样 `cp` 还原、`cmp` 确认。
- 全部还原逐字节一致，结束后 `git status` 只剩当时尚未提交的本人改动。

清理助手：

| 变异 | 无库钉 | 真实库 |
|---|---|---|
| M1 整体改回修复前（`87c4150231`） | 杀死：两个语句钉变红（18 个中 2 个失败） | 杀死：四个冒烟范围都报 42883 `operator does not exist: text = integer`；`{orgId, userIds}` 与 `{orgId, recordIds}` 范围照常通过 |
| M2 只改回 count 的过滤；M3 只改回记录删除的过滤 | 杀死（各 1 个失败：三个函数的语句钉） | 杀死：四个冒烟范围通过，直接调用时报 42883 |
| M4 只改回清理的 `filter`；M5 只改回清理的 `listedFilter` | 杀死（各 1 个失败：清理的语句钉） | 杀死：四个冒烟范围都报 42883 |
| M6 删掉清理里的整个前缀块（参数与条件都去掉；范围仍带前缀，`assertBoundedCleanupScope` 照常放行） | 杀死 | 杀死：otbank-v18 的范围删掉 org `default` 里 22 行，其中 19 行不属于它（别的冒烟的带前缀行与金丝雀）；"恰好删除本范围的行"断言变红 |
| M7 删掉 count 的前缀块 | 杀死 | 存活，在这组数据上等价：种入的都是遗留行，按整个 org 与按前缀计数的 W4 行数同为 0 |
| M8 删掉记录删除的前缀块 | 杀死 | 杀死：同 org 的金丝雀被删 |

任务 harness（S01–S07 为复审列出的变异，在最终提交上重跑；当时两文件共 380 个测试）：

| 变异 | 结果 |
|---|---|
| 对照：不改冒烟 | 380/380 |
| S01 `main()` 里改为 `checkOutsider(STAMP)` | 杀死：127 个失败，失败处都是"请求引用了桩从未发出的 id"（outsider 读 `tasks-smoke-t1`） |
| S01b outsider 读 `${taskId}-gone` | 杀死：127 个失败，同上 |
| S02 已删任务的读回改用标签（`taskPath(label)`，读 `parent` 与 `child`） | 杀死：120 个失败，同上 |
| S03 / S03b 清除父任务之后的父、子读回互换 | 杀死：各 137 个失败，都是调用轨迹不符 |
| S04–S07 移除执行人、移除关注人、member 退出、切到 `'all'` 之后的读回改读子任务（子任务 id 经新增的参数传入） | 杀死：分别 135、133、131、128 个失败，都是调用轨迹不符 |
| S01、S01b、S02，但去掉 `runSmoke` 里的"未发出 id"断言，只跑 harness（187 个） | 仍然杀死：119、119、112 个失败，由调用轨迹 |

种子失败（新 harness 即最终提交的 harness）：

| 变异 | 新 harness | 上一版 harness |
|---|---|---|
| S08（复审）清理的武装移到 users 的 INSERT 之前 | 杀死：roles、role_permissions 两个子测试变红 | 存活 |
| S08b 移到 role_permissions 的 INSERT 之前 | 杀死：roles 子测试变红 | 存活 |
| S08d、S08e、S08f 分别移到 user_roles、user_orgs、第一条准入 INSERT 之前 | 杀死：变红的恰好是武装点之前的各个 INSERT 子测试（3、4、5 个） | 杀死（users 用例） |
| 对照：不改冒烟 | 通过 | — |

runner（pipeline 合同测试，193 个）：

| 变异 | 结果 |
|---|---|
| RS9（复审）`TASKS_ENABLED` 检查移到 `prepare_container_runner` 之后 | 杀死：新用例失败，docker 日志在 `printenv` 之外多出 mkdir、ln 与 mint 助手的拷贝 |
| RS9b 只移到身份检查之后、`prepare_container_runner` 之前 | 杀死：新用例失败，身份探针被调用 1 次 |
| W1（复审）同步步骤在 scp 之前加一条 `ssh <固定选项> "$DEPLOY_USER@$DEPLOY_HOST" "git -C <部署机上的生产 checkout> pull --ff-only origin main \|\| true"` | 杀死（no-git 行检查） |
| W2 远端 prelude 字符串里加一行 `git … pull` | 杀死（no-git 行检查） |
| W3 先把 git 命令赋给变量，再由 ssh 发送该变量 | 杀死（no-git 行检查，命中赋值行） |
| W4 新增一个 ssh 到部署机的步骤，不含 `git` | 杀死（"只有两个步骤调用 ssh/scp"） |
| 对照：不改 | 193/193 |

### 9.3 清理助手在真实 PostgreSQL 上

环境：
- 本地 PostgreSQL 15.17，与 staging compose 的 `postgres:15-alpine` 同一主版本。
- 每次都是新建库，在 `packages/core-backend` 下按标准 `MIGRATION_EXCLUDE` 迁移，425 条全部成功；用完即删。
- node-postgres 取自 `packages/core-backend` 的依赖。

(a) 按冒烟的方式调用，在最终提交上：
- 用 `pg` Pool，`q = (text, params) => pool.query(text, params).then(result => result.rows)`，调用处的查询包装原文照搬；行直接提交入库。
- 每个范围的带前缀行用冒烟自己的 INSERT 列种入。另种 25 行金丝雀：
  - 同 org 无前缀的用户；
  - 同一冒烟家族的另一次运行；
  - 把 stamp 多加一个字符的近似前缀；
  - 前缀出现在用户 id 中间；
  - 裸 stamp（比前缀短）；
  - 另一个 org 里的带前缀用户；
  - ae4 另有一行带前缀用户的记录，其 id 不在 ae4 的 `recordIds` 里（ae4 的范围是前缀 AND `recordIds`）。
- 按 ae4、otbank-v18、mp6、hmr5 的顺序依次清理，按种入的 id 计数，不用被测的谓词。

修复前的助手（`87c4150231`）：

| 范围 | 带前缀行 前→后 | 全部金丝雀 前→后 | 后面范围的带前缀行 前→后 | 结果 |
|---|---|---|---|---|
| ae4 `{orgId: 'default', userIdPrefix, recordIds: 3 个}` | 3→3 | 25→25 | 8→8 | 抛出 42883 `operator does not exist: text = integer` |
| otbank-v18 `{orgId: 'default', userIdPrefix}` | 3→3 | 25→25 | 5→5 | 42883 |
| mp6 `{orgId: 'default', userIdPrefix}` | 2→2 | 25→25 | 3→3 | 42883 |
| hmr5 `{orgId: '<stamp>-org', userIdPrefix, userIds: undefined}` | 3→3 | 25→25 | — | 42883 |

修复后（`27eea78005`；助手自 `867a1f6e41` 起没有再改）：

| 范围 | 带前缀行 前→后 | 全部金丝雀 前→后 | 后面范围的带前缀行 前→后 | 返回值 |
|---|---|---|---|---|
| ae4 | 3→0 | 25→25 | 8→8 | `retiredCount` 0，`toolingDeletedCount` 3，删除的 id 恰为带前缀行 |
| otbank-v18 | 3→0 | 25→25 | 5→5 | 0 / 3，恰为带前缀行 |
| mp6 | 2→0 | 25→25 | 3→3 | 0 / 2，恰为带前缀行 |
| hmr5 | 3→0 | 25→25 | — | 0 / 3，恰为带前缀行 |

- 两次运行中 `retireRecord` 都被调用 0 次：种入的都是没有计算的遗留行。
- 修复前那次运行留下的 36 行（同样在 org `default` 等，stamp 不同），在修复后的运行之后仍全部在库里。结束时库里共 61 行，即 36 行加修复后那次的 25 行金丝雀。

另一个观察，本 PR 不改：`attendance_records` 上的触发器为每个 (org, user, date) 维护一行 `attendance_record_target_revisions`，插入时建立，删除时把版本号加一。直接删改这张表会被 `W4C3A_REVISION_DIRECT_MUTATION_DENIED` 拒绝。所以清理之后，这些修订行仍然存在：上表各范围分别为 4、3、2、3 行，前后不变。任何写 `attendance_records` 的路径都是如此，助手不碰这张表。

(b) 按环境变量启用的测试：

```
TEARDOWN_REAL_PG_DATABASE_URL=postgresql://USER@HOST:5432/DBNAME \
  node --test scripts/ops/staging-attendance-tooling-teardown.test.mjs
```

- 只认这个变量，不读 `DATABASE_URL`，CI 真实库步骤设的 `DATABASE_URL` 不会启用它。不设时报为跳过并写明原因；设了但库没迁移时失败，而不是跳过。
- 在一个连接上的事务里运行，结束时回滚，不提交任何数据。运行之后 `attendance_records` 与修订表都是 0 行。
- 使用冒烟的 `q` 与查询包装。种入四个冒烟范围的带前缀行与金丝雀（类别同上）；另加其他考勤冒烟使用的 `{orgId, userIds}` 与 `{orgId, recordIds}` 范围，以及三个自拼过滤函数的直接调用。
- 每清理一个范围，就按种入的 id 检查：
  - 本范围的带前缀行为 0；
  - 助手报告删除的 id 恰为这些行；
  - 后面范围的带前缀行仍在；
  - 全部金丝雀仍在。
  另检查 `retireRecord` 从未被调用。
- 在最终提交上对新迁移的库运行：19/19 通过。测试输出：

```
# ae4: stamped 3 -> 0, canaries 7 -> 7, result {"retiredCount":0,"toolingDeletedCount":3}
# otbank-v18: stamped 3 -> 0, canaries 6 -> 6, result {"retiredCount":0,"toolingDeletedCount":3}
# mp6: stamped 2 -> 0, canaries 6 -> 6, result {"retiredCount":0,"toolingDeletedCount":2}
# hmr5: stamped 3 -> 0, canaries 6 -> 6, result {"retiredCount":0,"toolingDeletedCount":3}
# userIds: stamped 2 -> 0, canaries 2 -> 2, result {"retiredCount":0,"toolingDeletedCount":2}
# recordIds: stamped 2 -> 0, canaries 1 -> 1, result {"retiredCount":0,"toolingDeletedCount":2}
# direct: stamped 2 -> 0, canaries 30 kept
```

- 对修复前的助手运行同一测试（§9.2 的 M1）：该测试失败，四个冒烟范围都报 42883。

### 9.4 本地端到端（任务冒烟）

环境与运行方式同 §8.3：
- 新建库，按标准 `MIGRATION_EXCLUDE` 迁移：425 条全部成功，含三条任务迁移；种入一个 `role='admin'` 的管理员。
- 后端是最终提交 `27eea78005` 的完整服务，监听回环地址的 18977 端口。`NODE_ENV=production`，dev-token 路由探测为 404；`TASKS_ENABLED=true`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`、`PRODUCT_MODE=platform`；`JWT_SECRET` 为 32 字节随机数的十六进制串。`/health` 200；无令牌访问 `/api/tasks/context` 为 401。
- 工作流 tar 列表（11 个文件）打包后平铺解包；按 remote.sh 自己的 case 语句取冒烟（`smoke_deps` 为空），连同 mint 助手拷进容器式目录（`scripts/ops` 加 `node_modules` 符号链接）。bundle 里的冒烟脚本与工作区逐字节相同。
- mint 助手 `--find-admin` 找到管理员，按 remote.sh 的 `mint_token` 参数签发 ADMIN、SUBJECT、MEMBER、OUTSIDER 四枚令牌，后三枚带 `--tenant-id default`。
- 空环境、bundle 之外的工作目录运行冒烟。

两次运行，各用一个新 stamp：

```
TASKS_API_DB_SMOKE_PASS deploy=27eea780052e22f815e48d6c34ca0347e6aac437 stamp=tasks-smoke-fix3a org=default task=tsk_dc5b333ede49fc137ea7942d9d11a490 residue=0
Assertions passed: 99
TASKS_API_DB_SMOKE_PASS deploy=27eea780052e22f815e48d6c34ca0347e6aac437 stamp=tasks-smoke-fix3b org=default task=tsk_b530e463723b0b3cc9a1f3b8df070dab residue=0
Assertions passed: 99
```

- 两次都没有 FAIL 或清理告警。残留计数 18 项：本库有 6 张带 `task_id` 的表。
- 在冒烟日志里查找四枚令牌及其签名段：两次均为 0。
- 每次运行前后，11 张表（四张任务子表、`tasks`、六张身份表）的整表行数与按行文本的 md5 完全相同。
- 两次运行之后自写 SQL 复核，对象是两个 stamp 的 6 个身份、4 个角色和 2 个父任务 id：
  - users、user_orgs、user_roles（按用户或角色）、准入、roles、role_permissions、tasks（按 created_by、按 id）、四张任务子表（按任务或用户）、`dingtalk_approval_card_deliveries` 与 `bpmn_audit_log`（按任务）全部为 0；
  - 五张任务表与 user_roles 整表为 0，users 整表只剩管理员；
  - 对 `public` 下全部 BASE TABLE 的 2621 个文本类列做 `LIKE '%tasks-smoke-%'` 扫描：命中 0。
- 后端日志：
  - 每次运行 45 个任务请求（两次共 90），与 harness 的 `CALLS` 条数相同；其中 `GET /api/tasks/:id` 每次 16 个，父任务候选 2 个、退出 1 个、评论列表 2 个、评论编辑 1 个；
  - 告警：每次运行一条预期的拒绝（subject 在准入之前访问 `/api/tasks/context`，`missing permission tasks:read`）；另有第一次运行时一条慢查询提示（读 users 表，584ms）和启动时的配置提示；
  - 没有错误级日志。
- 收尾：后端已停止，库已删除，临时 JWT 密钥文件已删除。本轮任何时刻最多只有一个临时库。

### 9.5 仍未修改的已知项

§8.4 的 10 项不变，其中第 1 项的措辞已按本轮的调用轨迹更新。

另记一项：工作流的 no-git 钉只读取各步骤的 `run:` 脚本，`uses:` 步骤（今天只有 checkout 与 upload-artifact）的输入不在扫描范围内。若以后引入带远端脚本输入的 action（例如通过 ssh 执行 `script:` 的 action），需要另行检查。

## 10. 复审修复（第四轮）

第四轮复审确认 1 个 P2（数据安全与端到端两票），另有 5 个 P3、3 个 NIT。本轮处理这个 P2 与两项 no-git 钉的 P3，其余记为已知项（§10.4）。

### 10.1 问题 → 改动 → 测试

| 问题 | 改动 | 测试 |
|---|---|---|
| P2：bundle 让 ae4、mp6、otbank-v18 能在容器里加载并走完清理。platform/attendance 产品模式下，令牌校验会给每个没有 `attendance:*` 权限的合成用户补一行 `user_roles(<用户>, 'attendance_employee')`。这三个冒烟的清理只删 `user_orgs` 与 `users`，不删 `user_roles`（该表的 `user_id` 没有外键），各自的残留检查与 §7 残留扫描也不数 `user_roles`。所以每次派发会留下指向已删用户的角色行：ae4、mp6 各 1 行，otbank-v18 至多 5 行，而运行照常报告零残留。这些行不带来授权效果（用户已删除），但管理端的角色成员数会把它们算进去。本 PR 之前，这三个冒烟在加载时就失败，什么也不写 | remote.sh（`1f20d990a3`）的规则：<br>- ae4、mp6、otbank-v18 继续打包：分支里的 `smoke_script` 与 `smoke_deps`、tar 列表、node --check 都不变，闭包、tar 列表与平铺启动检查照常覆盖它们。<br>- 但它们在本 runner 中不启用，直到它们自己的清理与夹具与当前代码一致。<br>- `action_smoke` 在解析出分支之后立即拒绝，先于 bundle 检查、任何后端探测、身份检查、容器准备、令牌签发与任何 staging 写入；错误信息写明规则。<br>- rd45、hmr5、tasks 照常运行。<br>- 工作流头注释、`smoke` 输入说明与 remote.sh 头注释写明这条规则。 | 可执行 harness 另记 settings 读取、宿主机 `psql`/`curl` 调用与输出目录清单。拒绝名单与可运行名单写在测试里，不从 remote.sh 推导，两者之并必须等于全部分支。<br>- 三个被拒绝的 id，bundle 完整、或缺少冒烟脚本及其闭包两种情形：退出 1，stderr 写明规则，且不报 bundle 缺失；docker 调用、身份检查、settings 读取、宿主机 psql/curl、git 都为 0；输出目录为空（没有 summary、settings 快照或冒烟日志）。<br>- rd45、hmr5、tasks：退出 0，冒烟在容器里运行，身份检查 1 次，settings 前后各读 1 次，写出 summary。<br>- 拷贝测试只覆盖这三个可运行分支；缺文件测试对被拒绝的分支要求拒绝信息。 |
| P3（接口）：no-git 钉只扫 remote.sh，不扫它 source 的 `attendance-window-runner-pipeline.lib.sh`。lib 里加一条 git 调用（包括 `filtered_pipe` 里的 `/usr/bin/git`，action_smoke 会运行它）测试仍全绿 | 合同测试（`4cd48da071`）：<br>- 扫描范围改为 remote.sh 及其传递 source 的全部 bundle 文件。<br>- 每条 `source`/`.` 命令必须指向 `"${HERE}/<文件>"`，或列入带理由的非 bundle 清单；目前清单只有 runner 自己在宿主机持久目录里写的凭据数据文件（一行 48 位十六进制口令）。其他写法直接失败，清单里没人 source 的条目也失败。<br>- 被 source 的文件必须在 tar 列表里。 | source 命令识别的控制用例：<br>- 4 种写法必须识别为 bundle 文件；<br>- 注释、凭据文件与 4 种并非 source 命令的写法不产生 bundle 文件；<br>- 6 种其他写法必须被拒绝（别的目录变量、家目录、绝对路径、裸文件名、变量参数、`../`）。<br>另有一个两层 source 的合成总体：三个文件都被找到，只报出最深一层的 git 调用，注释里的 git 不报 |
| P3（测试）：工作流 no-git 钉的步骤读取器只在 `- name:` 处开始步骤、只读 `run: \|` 块。`run: >-` 被读成一行脚本 `>-`，无名的 `- run:` 不成为步骤；用这两种写法加回部署机 `git pull`，测试仍全绿（G04、G05）。ssh/scp 识别没有带引号写法的控制用例（G03） | 合同测试（`4cd48da071`）：<br>- steps 列表里的每个 `- ` 项都是步骤，有无 name、键的顺序都不限。<br>- `run:` 的块标量接受全部头部：`\|`、`\|-`、`\|+`、`>`、`>-`、`>+`、缩进指示符、尾随注释；单行与多行流标量也读。<br>- `with:`、`env:` 下的 `run:` 不算步骤的脚本。<br>- 读不懂的步骤形状直接抛错，例如流式映射 `- {name: x, run: y}`、错位的键。<br>- 真实工作流的每个步骤必须恰有 run 与 uses 之一：读取器漏读的 run 会让步骤两者皆无。 | 合成工作流控制用例：<br>- 12 个步骤逐个比对 `{name, run, uses}`，覆盖各种块头、无名单行与无名块、name 写在 run 之后、带引号的值、两行纯量、`with:` 下的 run、第二个 job；<br>- 调用 ssh/scp 的步骤逐个比对，其中调用 git 的是 `run: >-` 步骤与无名单行步骤；<br>- 4 种读不懂的形状必须抛错。<br>ssh/scp 识别新增 `"ssh"`、`'scp'` 两条应命中用例 |
| P3（端到端）：ae4 的文本用户 id 在导入重算步骤被拒绝（`W4C0_USER_ID_INVALID`），每次派发 rc=1 | 由第一行的规则覆盖：ae4 被拒绝。用户 id 改为 UUID 列入考勤线后续（§10.5） | 同第一行 |

计数变化：
- pipeline 合同测试 193 → 196：拒绝规则用例、source 命令识别控制用例、工作流步骤读取器控制用例各 1 个。
- runner 自检命令 380 → 383。任务 harness 仍为 187，冒烟脚本本轮未改，正常路径的 `Assertions passed` 仍为 99。

### 10.2 变异

做法：在工作区内逐个进行：备份 → 改动 → 跑 pipeline 合同测试 → 用备份 `cp` 还原 → `cmp` 逐字节一致；变异新建的文件随后删除。全部还原逐字节一致，结束后 `git status` 只剩当时尚未提交的本人改动。

拒绝规则（`1f20d990a3` 的代码与测试，194 个测试）：

| 变异 | 结果 |
|---|---|
| R1 删除拒绝 | 杀死：被拒绝的 id 退出 0 |
| R2 拒绝移到 `copy_smoke_bundle` 之后 | 杀死：出现 docker 调用 |
| R3 拒绝移到身份检查之后、容器准备之前 | 杀死：身份检查被调用 |
| R4 拒绝移到 bundle 检查之后（仍在任何 docker 调用之前） | 杀死：缺文件时先报 bundle 缺失 |
| R5 拒绝条件去掉 mp6 | 杀死 |
| R6 拒绝条件加上 hmr5 | 杀死：hmr5 不再运行，3 个测试失败 |
| R7 拒绝信息不写规则 | 杀死 |
| R8 只打日志并 `return 0` | 杀死：退出 0 |

no-git 钉（最终代码提交的测试，196 个测试）：

| 变异 | 结果 |
|---|---|
| G04 在同步步骤之前新增有名步骤，`run: >-`，经 ssh 在部署机执行 `git -C ~/metasheet2 pull --ff-only origin main \|\| true` | 杀死：调用 ssh 的步骤多出该步骤 |
| G04b 同上，写成 `run: \|-` | 杀死 |
| G05 无名单行步骤 `- run: ssh <固定选项> "$DEPLOY_USER@$DEPLOY_HOST" "git … pull …"` | 杀死：多出一个无名步骤（按行号点名） |
| G05b 无名 `- run: >-` 步骤，`env:` 写在 run 之后 | 杀死 |
| G06 有名步骤，`run: >2-`（带缩进指示符） | 杀死 |
| G03 ssh/scp 识别的前缀字符类去掉引号 | 杀死（带引号的控制用例） |
| P1 读取器只认裸 `\|` 头部；P2 只在 `- name:` 处开始步骤并跳过其他项；P3 忽略 `- ` 项那一行上的键 | 全部杀死（读取器控制用例；P3 另让真实工作流的"恰有 run 与 uses 之一"变红） |
| M03c lib 的 `filtered_pipe` 里加 `/usr/bin/git -C "$PWD" rev-parse HEAD >/dev/null 2>&1 \|\| true` | 杀死 |
| M03b lib 新增运行 `git -C "$1" fetch origin main && git -C "$1" rev-parse HEAD` 的函数，由 `action_status` 以部署机生产 checkout 调用 | 杀死 |
| M03e remote.sh 新 source 一个已列入 tar 列表、含 git 调用的 lib | 杀死（只由 git 扫描抓住） |
| M03f 新 source 一个不含 git、但不在 tar 列表里的 lib | 杀死（tar 列表检查） |
| 对照 M03d：新 source 一个不含 git、已列入 tar 列表的 lib | 全绿（196/196），没有误报 |
| S1 remote.sh 以清单之外的写法 source `${SOAK_PERSIST_DIR}/hooks.sh` | 杀死（不认识的 source 写法） |
| S2 source 命令识别去掉 `.` | 杀死（控制用例） |
| S3 非 bundle 清单多一条没人 source 的条目 | 杀死（过期条目检查） |
| S4 总体不再传递跟随 source；S5 git 扫描只看总体的第一个文件 | 杀死（两层 source 的控制用例） |

合计：拒绝规则 8 个变异全部杀死；no-git 钉 18 个变异全部杀死，1 个对照全绿。修复之前，复审在 `dcb9038c57` 上看到 G03、G04、G05 保持 380/380，M03b、M03c 保持 193/193。

### 10.3 端到端（另一台机器，PostgreSQL 16.15）

环境：
- 新建库，按标准 `MIGRATION_EXCLUDE` 迁移：425 条全部成功，含三条任务迁移。共 412 张表，其中 6 张带 `task_id`。种入一个 `role='admin'` 的管理员。
- 后端是最终代码提交 `4cd48da071` 的完整服务，监听回环地址的非默认端口：
  - `NODE_ENV=production`，dev-token 路由为 404；
  - `TASKS_ENABLED=true`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`、`PRODUCT_MODE=platform`；
  - `JWT_SECRET` 为一次性随机值；
  - `/api/health` 的 `build.commit` 为该提交，无令牌访问 `/api/tasks/context` 为 401。

派发方式：本轮运行真实的 remote.sh，而不是像前几轮那样由驱动脚本复现 runner 的步骤。
- 同步：从工作流文件解析 tar 列表（11 个文件），打包后用 `--strip-components=2` 平铺解到每次运行的独立目录，另放 compose 文件。
- 远端执行：从工作流文件里原样取出 `remote_script` 赋值与转义两行，按本次输入求值，以 `bash -c "bash -o pipefail -c '<转义后的脚本>'"` 运行。HOME 是一个没有生产 checkout 的假目录。
- PATH 最前面是桩：
  - `docker` 只模拟 staging 后端容器（exec 带容器环境与 `-e`、cp 进容器目录、inspect、logs、ps）；
  - `curl` 把 staging web 与后端的宿主机端口映射到本地后端；
  - `git`、`ssh`、`scp`、`psql`、`node`、`npm`、`pnpm`、`npx`、`tsx`、`rsync` 在宿主机上一被调用就记录并失败。
- 每次运行前后对全库 412 张表取行数与按行文本的 md5。
- 每次都核对冒烟日志里的 PASS 行，不只看退出码：模拟目录若经过符号链接，冒烟的 IS_MAIN 判断不成立，会不执行就以 0 退出。容器里的 `/tmp/window-runner` 是真实目录，不受此影响。

结果：

1. `smoke=tasks`，两次派发：

```
TASKS_API_DB_SMOKE_PASS deploy=4cd48da07145a403e8bfe50a421b82259295e812 stamp=tasks-smoke-gh4401a1 org=default task=tsk_fb9220377e6b4c078df719152eb777a2 residue=0
TASKS_API_DB_SMOKE_PASS deploy=4cd48da07145a403e8bfe50a421b82259295e812 stamp=tasks-smoke-gh4402a1 org=default task=tsk_789162c26852a28813b9bcfed20a09e8 residue=0
Assertions passed: 99
```

   - 两次都是 `remote_rc=0`、`smoke_rc=0`，99 条 PASS，没有 FAIL 或清理告警；每次 13 个 docker 调用。
   - 两次运行前后，全库快照完全相同，`user_roles` 也在内。
   - 第一次派发时，runner 的 settings 读取得到 403：种入的管理员只有 `users.role='admin'`，而考勤插件的管理员判定读 `user_roles`。staging 上前几次派发的 settings 读取都是 200，所以给管理员补一行 `user_roles(<管理员>, 'admin')` 后再派发一次，settings 前后都是 200。冒烟本身两次都通过。
2. `smoke=ae4`、`smoke=mp6`、`smoke=otbank-v18`，各派发一次：
   - 都是 `remote_rc=1`，日志里是拒绝信息；
   - 桩记录的调用为 0（没有 docker、curl，也没有任何被拒绝的宿主机工具）；
   - 远端输出目录为空，没有拷回任何文件；
   - 全库快照前后相同。
3. 令牌：两次 tasks 派发共 8 枚（ADMIN、SUBJECT、MEMBER、OUTSIDER 各 2 枚），声明与 remote.sh 的签发参数一致。在后端日志、桩日志与每次运行的输出里查找每枚令牌及其签名段：命中 0；JWT 密钥：命中 0。
4. 按值扫描全部表的行文本，查 `tasks-smoke-gh4401a1`、`tasks-smoke-gh4402a1`、`tasks-smoke-`、`ae4-smoke-`、`mp6-smoke-`、`otbank-v18-smoke-`：都没有命中。
5. 后端日志：
   - 每次派发 45 个任务请求（共 90），另有 1 个是无令牌探测；
   - 告警只有每次派发一条预期的拒绝（subject 在准入之前访问 `/api/tasks/context`），以及启动时的配置提示和一条慢查询提示；
   - 没有错误级日志。
6. 收尾：后端已停止，库已删除，工作区与运行目录已删除，一次性 JWT 密钥与令牌记录随之删除。

### 10.4 仍未修改的已知项

| 项 | 理由 |
|---|---|
| P3（测试）：fake pg 同步执行每条语句。清理里的 DELETE 去掉 `await`（C01）、删掉失败路径的 WARN 循环（C03）、不再 `await` 授予准入（C06），测试都保持全绿 | 现有代码每处都有 `await`。这三种回退在 staging 上都不会得到假 PASS：C01 会在清理中途以非零退出（可能留下带 stamp 的行），C03 只少诊断行、残留检查照常判失败，C06 要么照常拿到准入、要么 403 失败。把 fake pg 改成逐条异步执行、并补清理语句失败用例，留作后续 |
| P3（测试）：七处值检查（A01–A07）只有空、零或缺失类的错值 cell，把 `=== 预期` 弱化成存在性检查仍全绿 | 当前的比较都是精确相等。但若 A02 与 A04 同时被弱化、或 A06 被弱化，后端对应的错误（子任务读回的 parentId 不对、墓碑被重复计入 total）会在 staging 上得到假 PASS。这是针对将来弱化编辑的防护缺口，补错值 cell 留作后续；A01、A03、A05、A07 另有断言兜底 |
| NIT（测试）：可执行 action_smoke 检查只看令牌 env 是否存在，不看各自携带的令牌、其余 env 与其他容器 exec（K02、K01、D01b、X01） | K02 在 staging 上会大声失败；K01、D01b 要么没有效果、要么大声失败。X01（拷贝之后再用镜像里的副本覆盖）今天没有这样的代码；若加上，冒烟会改跑镜像里的版本而测试仍绿，属于防护缺口，留作后续 |
| NIT（测试）：闭包扫描的 `createReadStream` 与"首参含括号的 `new URL`"两个分支没有控制用例（S03、S04） | 潜在缺口，今天没有 bundle 成员使用这些写法；与 §8.4 第 10 项同类 |
| NIT（接口）：别名导入的 `createRequire`（C5）不被闭包扫描识别 | 需要刻意的别名，今天没有代码这样写；与 §8.4 第 7 项同类 |
| P3（端到端）：ae4 在本构建上过不了导入重算步骤（`W4C0_USER_ID_INVALID`） | ae4 已按规则被拒绝（§10.1）；用户 id 改为 UUID 列入考勤线后续（§10.5） |

§8.4 的 10 项与 §9.5 的一项不变。

### 10.5 考勤线后续

- ae4、mp6、otbank-v18 在本 runner 中被拒绝。重新启用之前需要：
  - 清理删除这些冒烟的合成用户在 `user_roles` 里的行：platform/attendance 产品模式下，令牌校验会为这些用户补 `attendance_employee`；
  - 各自的残留检查按用户前缀计入 `user_roles`，§7 残留扫描加上对应的 `user_roles` 计数；
  - ae4 的用户 id 改为 UUID，当前的文本 id 在导入重算步骤被拒绝。
- 完成之后，从 `action_smoke` 的拒绝条件里去掉相应的 id，并更新合同测试里的拒绝名单与可运行名单。
- §7 残留扫描（`action=residue-sweep`）的 `stamps` 输入仍要求 ae4 与 otbank 两个字段；这两个冒烟被拒绝期间，本 runner 不会产生它们的 stamp。

## 11. 复审（第五轮）

第五轮复审在 `c985e93a84` 上确认 1 个 P2 和 1 个 NIT，另有 6 项 P3/NIT。P2 与 NIT 用一个合同测试处理（§11.1），其余 6 项记为已知项，不改代码（§11.3）。工作流与 remote.sh 本轮没有改动：`c985e93a84` 已把 `smoke` 输入的默认值由 ae4 改为 tasks。

### 11.1 问题 → 改动 → 测试

| 问题 | 改动 | 测试 |
|---|---|---|
| P2：没有测试钉住 `smoke` 输入的默认值。默认值改回 ae4（被拒绝的 id）、删掉、或改成别的 id，pipeline 合同测试都保持全绿。设计文档与 PR 描述也仍写默认值是 ae4 | 设计文档 §2.1 与 PR 描述改为：默认值由 ae4 改为 tasks。原因：ae4 被拒绝，默认值指向它时，不改选项的 `action=smoke` 派发只会得到拒绝信息。无代码改动 | 合同测试（`21930c5f4f`）读出工作流 `smoke` 输入和 remote.sh 的拒绝条件，断言：<br>- 默认值存在，是选项之一；<br>- 默认值不在拒绝名单里，且恰为 tasks。<br>拒绝名单从 remote.sh 的拒绝条件读出，不是手写名单 |
| NIT：输入说明里的拒绝说明与 remote.sh 里的拒绝条件都没有被钉住。把说明改成不提拒绝规则，测试保持全绿 | 无代码改动 | 同一个测试：<br>- 说明点名拒绝名单里的每个 id（整词匹配，`otbank-v18-smoke` 不算 `otbank-v18`）；<br>- 拒绝名单非空，且都是选项之一（空名单会让上面的检查空转）。<br>读取器只认实际用到的写法，认不出的直接失败：<br>- 拒绝条件必须是 `fail` 调用正上方的 `if [[ "$SMOKE_ID" == "<id>" \|\| ... ]]; then`，只能有一处拒绝，`fail` 前面不能有别的东西，所以条件里或 `fail` 前的环境变量判断都读取失败；<br>- `smoke` 输入块里的块标量、块列表和重复键同样失败 |

控制用例（另一个测试）：
- 拒绝条件读取器：2 种接受写法（含不得并入拒绝名单的 tasks 判断）；8 种拒绝写法（没有拒绝、两处拒绝、条件里的环境变量判断、不是 id 判断的子句、不是等于的判断、`fail` 前的环境变量判断、嵌套在别的块里、不在 `if` 下）。
- 输入读取器：引号写法、行尾注释和带引号的默认值；缺少默认值时不借用下一个输入的 `default`；5 种拒绝写法（块列表、块标量、重复键、该是标量处写了列表、该是列表处写了标量）；工作流里没有 `smoke` 输入。

### 11.2 变异

做法同 §10.2：在工作区内逐个进行，备份 → 改动 → 跑 runner 自检原命令（385 个测试）→ 用备份 `cp` 还原 → `cmp` 逐字节一致，结束后代码路径上 `git status` 无改动。对象是测试提交 `21930c5f4f`。

| 变异 | 结果 |
|---|---|
| M1 默认值改回 ae4（复审的 DF-1） | 杀死，只有新测试变红（384/385）：默认值被拒绝名单点名 |
| M2 删掉默认值那一行（复审的 DF-2） | 杀死，只有新测试变红：没有默认值 |
| M3 说明里去掉被拒绝的 otbank-v18 | 杀死，只有新测试变红：说明没有点名 |
| M3b 说明去掉整句拒绝规则（复审的 RF-G） | 杀死，只有新测试变红 |
| M4 默认值改为 hmr5（可运行，但不是 tasks；复审的 DF-3） | 杀死，只有新测试变红：默认值不是 tasks |
| M9 选项里去掉 tasks | 杀死：默认值不在选项里；另有 2 个既有测试变红（选项与 case 分支对应） |
| M5 拒绝条件加上 tasks | 杀死：新测试的失败信息里拒绝名单含 tasks，证明名单确实读自 remote.sh；另有 4 个既有的可执行检查变红 |
| M6 拒绝条件里加环境变量判断（`... ]] && [[ "${VAR:-}" != "1" ]]`；复审的 RF-I） | 杀死，只有新测试变红：条件读取失败 |
| M7 `fail` 调用前加环境变量判断（`[[ ... ]] \|\| fail ...`） | 杀死，只有新测试变红 |
| M8 拒绝块之前加一行环境变量早退（`[[ "${VAR:-}" == "1" ]] && return 0`） | 存活（385/385）：见 §11.3 最后一行 |
| 对照 C1 默认值写成带引号的 `'tasks'` | 全绿（385/385），没有误报 |

合计：10 个变异杀死 9 个，存活 1 个（M8），1 个对照全绿。M1、M2、M3、M3b、M4、M6、M7 只有新测试变红，M5 与 M9 另有既有测试变红。修复之前，复审在 `c985e93a84` 上看到 DF-1、DF-2、DF-3、RF-G、RF-I 均保持 383/383。

### 11.3 仍未修改的已知项

| 项 | 理由 |
|---|---|
| remote 侧的 no-git 钉只扫描 remote.sh 与它 `source` 的 bundle 文件。remote.sh 用 `bash "${HERE}/<文件>.sh"` 执行的 bundle `.sh` 不在范围内，里面的 git 调用抓不到。变异 E1：新增一个含 git 的脚本，列入 tar 列表，由 `action_status` 执行，385/385 全绿 | 今天 remote.sh 只 source 一个 lib，不执行别的 bundle `.sh`（其余 `${HERE}` 用法是 `docker cp`、文件存在检查与 compose 文件）。在 `action_smoke` 里，可执行 harness 的 PATH `git` 桩会记录经 PATH 找到的 git 调用（变异 E2：同一脚本改由 `action_smoke` 在拒绝之后执行，2 个既有测试变红），所以缺口在其他 action。以后新增执行型脚本时，把它纳入扫描范围 |
| source 命令识别只认行首、`;`、`&`、`\|`、`(`、反引号之后，以及 then/do/else 之后的 `source`/`.`。`if source …`、`{ source …; }`、`! source …`、`builtin source …`、`command . …`、`time source …`、`while source …` 既不被认作 source 命令，也不被拒绝，被 source 的文件落在扫描范围之外（逐一对 `sourcedFiles` 核对，均返回空） | remote.sh 的 `source` 今天只有三处，都是单独成行的写法：lib 一处，口令数据文件两处。这些写法需要刻意写出 |
| 工作流侧的 no-git 钉只读各步骤的 `run:` 文本。步骤若运行入库的包装脚本（如 `run: bash scripts/ops/x.sh`），脚本里 ssh 加 git，则该步骤不被认作远端步骤，脚本内容也不被扫描（对步骤读取器核对） | 今天各步骤对入库脚本做的只有 `bash -n`、`node --check`、`node -e` 读一个 JSON 与 `node --test`，没有步骤在 runner 上运行入库的包装脚本（经 ssh 在部署机运行的 remote.sh 本身在扫描范围内）；其余步骤是 checkout 与上传的 `uses:`、ssh/tar/scp、摘要和 `exit 1`。新增运行入库脚本的步骤时，需把脚本纳入扫描 |
| `ssh`/`scp` 识别只看步骤 `run:` 里的命令词。把命令放进 `env:`（如 `REMOTE_SHELL: ssh …`），`run:` 写 `$REMOTE_SHELL "$U@$H" "…"`，该步骤不被认作远端步骤，它的 git 行不被扫描（对步骤读取器核对） | 今天两个远端步骤都把 `ssh`/`scp` 直接写在 `run:` 里，测试钉住远端步骤恰是这两个；变量 `ssh_opts` 只放选项，不放命令词 |
| 步骤读取器不解析 YAML 别名：`run: *别名` 被读成字面文本 `*别名`，别名指向的命令（锚点在别处，例如另一个步骤的 `env:`）不被扫描，步骤也不被认作远端步骤（对步骤读取器核对） | 工作流今天没有任何锚点或别名 |
| 拒绝的环境变量旁路：拒绝块之前加一行 `[[ "${VAR:-}" == "1" ]] && return 0`，被拒绝的 id 在设了该变量的环境里照常运行。可执行 harness 只带 PATH 和 SMOKE_ID 运行 `action_smoke`，不会设这个变量，测试保持全绿（变异 M8，385/385）。放在拒绝条件里或 `fail` 调用前的环境变量判断，§11.1 的读取器已拒绝（M6、M7） | 变量名不可预知，测试无法穷举；今天没有任何环境变量参与拒绝，拒绝块只看 `SMOKE_ID` |

### 11.4 计数与其余已知项

- pipeline 合同测试 196 → 198：`smoke` 输入检查、读取器控制用例各 1 个。
- runner 自检命令 383 → 385。任务 harness 仍为 187，冒烟脚本本轮未改，正常路径的 `Assertions passed` 仍为 99。
- §8.4 的 10 项、§9.5 的一项与 §10.4 的 6 项不变。
