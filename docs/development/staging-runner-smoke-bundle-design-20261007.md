# Staging 窗口 runner：冒烟脚本随 runner 打包上传 + 任务冒烟补 M3 用例（设计，2026-10-07）

- 分支：`claude/runner-smoke-from-tarball`，基于 `origin/main` `7137688372`（该 SHA 也是 staging 当前运行的镜像）。
- 涉及文件：`.github/workflows/attendance-staging-window-runner.yml`、`scripts/ops/attendance-staging-window-runner-remote.sh`、`scripts/ops/attendance-window-runner-pipeline.test.mjs`、`scripts/ops/staging-tasks-smoke.mjs`、`scripts/ops/staging-tasks-smoke.test.mjs`，以及四个考勤冒烟共用的清理助手 `scripts/ops/staging-attendance-tooling-teardown.mjs` 和它的测试 `scripts/ops/staging-attendance-tooling-teardown.test.mjs`（§2.6）。不改后端代码，不改迁移。
- 验证记录：`docs/development/staging-runner-smoke-bundle-verification-20261007.md`。

## 1. 问题

1. `action=smoke` 先调用 `host_sync_prod_repo`：在部署机的生产仓库目录（`PROD_REPO_DIR` = `DEPLOY_PATH`）里执行 `git fetch` / `git checkout main` / `git pull`，再从这个目录把冒烟脚本 `docker cp` 进 staging 后端容器。仓库已改为私有，部署机上没有凭据时这一步失败；而且 staging 冒烟本来就不应该改动生产 checkout。
2. 只有冒烟脚本本身被拷进容器。ae4、otbank-v18、mp6、hmr5 四个考勤冒烟静态 import 同目录的 `./staging-attendance-tooling-teardown.mjs`，单文件拷贝时模块图解析失败（`ERR_MODULE_NOT_FOUND`，在任何代码执行之前）。rd45 在运行时从 `PLUGIN_INDEX_PATH`（runner 设为镜像内 `/app/plugins/plugin-attendance/index.cjs`）加载插件，不是相对 import；`staging-tasks-smoke.mjs` 只 import Node 内置模块和动态 `pg`。
3. 工作流的 `tar` 列表只打包 4 个文件（remote.sh、pipeline lib、mint-token、soak 负载生成器），所以冒烟脚本只能从部署机仓库取。

## 2. 方案

### 2.1 工作流

- `Sync runner scripts to deploy host` 的 tar 列表在原 4 个文件之外，加入 `action_smoke` 每个 `smoke_script=` 分支的冒烟脚本（6 个）以及它们的同目录闭包（见 §2.3，目前只有 `staging-attendance-tooling-teardown.mjs`），共 11 个文件。解包仍是 `tar -xzf - -C ${runner_dir} --strip-components=2`，所有文件平铺在 remote.sh 所在目录（`HERE`）。
- `Validate inputs and embedded scripts` 对每个打包的 `.mjs` 执行 `node --check`。
- 删除 `skip_host_sync` 输入：输入定义、`SKIP_HOST_SYNC` env 行、`for pair in ...` 安全字符校验循环里的那一项（该项值为空时会让正则失败，使所有 action 退出 2）、以及远端 prelude 的 `export`。校验循环只保留始终有值的 `DEPLOY_PATH` 与 `STAGING_DEPLOY_PATH`。
- 头部注释改为描述"每次运行把一个 bundle 从工作流 checkout 发到部署机的独立目录；action=smoke 从这个 bundle 拷贝冒烟脚本，不读取、不拉取、不检出部署机上的任何仓库"，并如实写出合同测试检查了什么（§2.3）。
- 头部注释与 `smoke` 输入的说明写明拒绝规则：ae4、mp6、otbank-v18 已打包但被 runner 拒绝，可运行的是 rd45、hmr5、tasks（§2.2）。`smoke` 的选项不变，默认值由 ae4 改为 tasks：ae4 被拒绝，默认值指向它时，不改选项的 `action=smoke` 派发只会得到拒绝信息，tasks 则是可运行的（后端没有 `TASKS_ENABLED=true` 时，它在身份检查、容器准备与任何写入之前失败）。

冒烟脚本的版本来源：此前是部署机仓库同步后的 `main`，与部署镜像 SHA 无关；现在是工作流被触发时检出的 ref（通常是 `main`），同样与部署镜像 SHA 无关。冒烟断言的是正在运行的镜像，PASS 行仍以 `DEPLOY_SHA` 标明被测构建。

### 2.2 remote.sh

- 删除 `host_sync_prod_repo` 函数、它的调用和 `SKIP_HOST_SYNC` 默认值。
- 保留 `PROD_REPO_DIR` 及 staging-only 守卫中 `STAGING_DIR` 与它的比较；`PROD_REPO_DIR` 只用于这一处。
- `action_smoke` 的每个 case 分支用 `smoke_deps=(...)` 显式列出该冒烟脚本的同目录闭包；没有这一行即为空闭包。
- `require_smoke_bundle <file>...`：在动容器之前（先于 tasks 的 `TASKS_ENABLED` 检查、身份检查和 `prepare_container_runner`）校验 `HERE` 中文件齐全，缺任何一个都 fail closed，并列出缺失文件名。
- `copy_smoke_bundle <smoke_script> [dep...]`：一次把冒烟脚本和闭包 `docker cp` 到 `${CONTAINER_RUNNER_DIR}/scripts/ops/`，使相对 import 在容器内就近解析。冒烟运行前的唯一拷贝入口。
- 规则：ae4、mp6、otbank-v18 继续打包，但在本 runner 中不启用，直到它们自己的清理与夹具与当前代码一致。
  - 打包不变：分支里的 `smoke_script`、`smoke_deps` 不变，闭包、tar 列表、node --check 与平铺启动检查照常覆盖它们。
  - 不启用的原因：platform/attendance 产品模式下，令牌校验会给合成用户补一行 `attendance_employee` 角色，而这三个冒烟的清理不删 `user_roles`，残留检查也不数它；ae4 的文本用户 id 过不了导入重算步骤。见验证记录 §10.1。
  - `action_smoke` 在解析出分支之后立即拒绝，先于 bundle 检查、任何后端探测、身份检查、容器准备、令牌签发与任何 staging 写入；错误信息写明规则。
  - 可运行的是 rd45、hmr5、tasks。本 PR 之前这三个冒烟在加载时就失败，拒绝维持了"不写入 staging"的现状。重新启用列为考勤线后续（验证记录 §10.5）。
- `smoke=tasks` 在原 `SUBJECT_TOKEN` 之外再签发两枚令牌，签发方式与 `SUBJECT_TOKEN` 相同（mint_token 第 4 个参数，tenant `default`），每枚令牌的声明与冒烟为该身份种入的角色一致：
  - `MEMBER_TOKEN`：主体 `<stamp>-member`，roles `user`，perms `tasks:read,tasks:write`（member 与 subject 共用角色）。member 只在关注人自行退出（`POST /api/tasks/:id/leave`）时用它登录一次。
  - `OUTSIDER_TOKEN`：主体 `<stamp>-outsider`，roles `user`，perms `tasks:read`。
  令牌只放在 `run_env` 里，不打印、不写日志。
- outsider 令牌的 perms 保持 `tasks:read`，理由：
  1. outsider 要证明的是"已准入、只有读权限、与任务无关的用户读不到任务（404）"，令牌声明与冒烟为它种的 `tasks:read` 角色一致。
  2. staging 是 production node-env，令牌里的 roles/perms 不被信任，权限以库里的角色为准，声明不影响 staging 上的判定。
  3. 在非 production 且开启 `RBAC_TOKEN_TRUST` 的环境里，令牌声明会被直接信任；若声明 `tasks:read,tasks:write`，outsider 在那种环境里就成了写者，两种环境下被检查的不再是同一个主体。
  4. outsider 只调用两条读路由（`/api/tasks/context`、`/api/tasks/:id`），不需要写权限。需要 `tasks:write` 的关注人退出用例由 member 承担，不扩大 outsider 的权限。
- 过时注释已改（如"在 host_sync_prod_repo 之前检查"）。

### 2.3 合同测试（`attendance-window-runner-pipeline.test.mjs`）

bundle 从源码推导，不维护手写清单：

- 冒烟分支：从 `action_smoke` 的 case 语句取分支标签，并用 bash 执行该 case 块读出每个分支的 `smoke_script` 与 `smoke_deps`（与 runner 读取方式一致）。分支集合必须等于工作流 `smoke` 输入的选项集合。
- 同目录闭包：从冒烟脚本源码递归计算。下列写法里用字面量相对路径（`./`、`../`；单引号、双引号或不含 `${}` 的模板字面量）点名的文件都是闭包成员：静态 `from`、副作用 `import`、动态 `import()`、`require()`、`require.resolve()`、`createRequire(...)(...)`、`import.meta.resolve()`、`new URL('<相对路径>', import.meta.url)`（也覆盖 `readFileSync(new URL('./x.json', import.meta.url))` 这类同目录读取）。`.mjs`/`.cjs`/`.js` 成员继续向下扫描。要求 `smoke_deps` 与闭包**集合相等**；闭包成员必须直接位于 `scripts/ops`（bundle 平铺解包，`../` 指向别的目录的文件无法还原）。
- 扫描无法解析的加载一律拒绝，除非列入白名单并写明 bundle 为何仍然完整：赋给变量的 `createRequire`、非字面量或带插值的 `import()`/`require()`/`import.meta.resolve()`、`new URL(<非字面量>, import.meta.url)`、模块目录路径（`fileURLToPath(import.meta.url)`、`import.meta.dirname`/`filename`、`__dirname`/`__filename`）、按当前工作目录解析的字面量读取（如 `readFileSync('./x.json')`，在容器里解析到镜像的工作目录而不是 bundle）。白名单目前只有一条：rd45 从 `PLUGIN_INDEX_PATH` 加载插件（runner 把它设为镜像内副本，模块目录路径只是仓库 checkout 下的兜底）。白名单条目不再命中时测试同样失败。每种写法都有控制用例，包括不应命中的写法（裸包名 `import('pg')`、以 `BASE_URL` 为基的 `new URL`、`IS_MAIN` 判断等）；另有一个临时目录里的传递闭包用例（`.mjs` → `.cjs` → `.cjs` → `.json`）。
- mint 助手由 `prepare_container_runner` 单独拷贝，其闭包必须为空、且不得有被拒绝的加载。
- tar 列表：从工作流 `tar -czf - \` 到 `| ssh` 之间解析，逐行必须是一个条目；每个条目直接位于 `scripts/ops`；必须包含 4 个 runner 文件和每个分支的冒烟脚本及闭包。
- node --check 列表：只从 Validate 步骤解析；每个打包的 `.mjs` 必须在列表里。
- `smoke` 输入（读源码）：读出工作流 `smoke` 输入的说明、选项与默认值，以及 remote.sh 里 `action_smoke` 的拒绝条件。拒绝名单从该条件读出，不是测试里的手写名单。断言：默认值存在、是选项之一、不在拒绝名单里、恰为 tasks；拒绝名单非空，且都是选项；说明里点名每个被拒绝的 id。
  - 读取器只认实际用到的写法，认不出的直接失败：拒绝条件必须是 `fail` 调用正上方的 `if [[ "$SMOKE_ID" == "<id>" || ... ]]; then`，只能有一处拒绝，`fail` 前面不能有别的东西；`smoke` 输入块里的块标量、块列表和重复键同样失败。
  - 两个读取器各有控制用例，包括不得并入拒绝名单的 tasks 判断。
- 可执行检查：把 remote.sh 里真实的 `action_smoke` 及其调用的函数原样抽出，在 `set -euo pipefail` 下配合记录型 `docker` 函数运行（只把两个 curl 探针 `fetch_health_commit` / `capture_settings` 换成桩，两者都记录每次调用），`HERE` 按 tar 列表平铺填充，工作目录是临时目录，PATH 最前面放记录型 `git`、`psql` 与 `curl`。断言：
  - ae4、mp6、otbank-v18（bundle 完整、或缺少冒烟脚本及其闭包）：退出 1 并写明规则，docker 调用、身份检查、settings 读取、宿主机 psql/curl、git 都为 0，输出目录为空。这一项的拒绝名单与可运行名单写在测试里，不从 remote.sh 推导，两者之并必须等于全部分支（上面 `smoke` 输入的检查则从 remote.sh 读出拒绝名单）；
  - 对可运行的 rd45、hmr5、tasks：容器收到的拷贝恰好是 mint 助手、冒烟脚本和闭包，且都发生在冒烟运行之前；身份检查 1 次，settings 前后各读 1 次，写出 summary；
  - rd45 的运行带 `PLUGIN_INDEX_PATH=/app/plugins/plugin-attendance/index.cjs`（rd45 闭包为空正是因为插件从这里加载）；
  - `smoke=tasks` 的运行带 `SUBJECT_TOKEN`、`MEMBER_TOKEN` 与 `OUTSIDER_TOKEN`，三枚令牌的签发参数正确；
  - 整个过程没有调用 `git`；
  - 从 bundle 里拿掉任何一个需要的文件，`action_smoke` 在任何 docker 调用之前失败并点名该文件（被拒绝的分支报拒绝信息）；
  - `smoke=tasks` 时，桩对 `printenv TASKS_ENABLED` 的回答可配置，身份探针 `fetch_health_commit` 记录每次调用：回答为 `false`、未设置或 `TRUE` 时，`action_smoke` 失败并写出观察到的值，docker 调用只有那一次 `printenv`，身份探针一次也没有被调用（即 remote.sh 注释所说的"先于身份检查、先于拷入容器"）；回答为 `true` 时，`printenv` 是第一个 docker 调用，运行继续到拷贝。
- 平铺启动检查（可执行）：每个冒烟脚本只取它自己的 bundle 文件（从解出的 tar 列表里拷），按容器 runner 目录的样子平铺放进 `scripts/ops`，旁边的 `node_modules` 里只有一个 `pg` 桩（runner 把镜像的 `node_modules` 链接到同一位置；冒烟脚本只在环境检查之后加载 `pg`）；空环境、工作目录不在 bundle 里。每个冒烟都必须走到它自己的环境变量拒绝（退出码 2），不得出现模块缺失或 ENOENT；mint 助手单独启动，必须打印 usage。顶层的任何加载写法，扫描认不出的也会在这里暴露。该检查不需要安装依赖，可以在 runner 的自检步骤（之前没有安装步骤）里运行。
- 部署机生产 checkout：remote.sh 以及它传递 source 的全部 bundle 文件（目前是 pipeline lib）的可执行行里没有任何 `git` 调用。
  - 识别规则：`git` 前面是行首、空白、shell 运算符、引号、`/`（如 `/usr/bin/git`）或反斜杠（`\git`），后面是行尾、空白、引号或 shell 运算符；`command git`、`env git` 经由空格命中。有控制用例（应命中与不应命中两组）。
  - 扫描范围从 remote.sh 的 source 命令推导：每条 `source`/`.` 必须指向 `"${HERE}/<文件>"`，或列入带理由的非 bundle 清单（目前只有 runner 自己写的宿主机凭据数据文件）；其他写法直接失败，清单里没人 source 的条目也失败；被 source 的文件必须在 tar 列表里。source 命令识别与传递推导各有控制用例。
  - `PROD_REPO_DIR` 只出现在定义行和 staging-only 守卫的比较行；工作流与 remote.sh 里没有 `skip_host_sync` / `SKIP_HOST_SYNC`。
- 工作流同样不得在部署机上运行 `git`：按步骤取出每个 `run:` 脚本，调用 `ssh` 或 `scp`（按命令词识别，边界规则与 `git` 相同，有控制用例）的步骤必须恰好是 `Sync runner scripts to deploy host` 与 `Run remote action` 两个；这两个步骤的每一条可执行行都不得出现 `git` 调用，这覆盖了 ssh 命令行本身、拼远端命令用的变量，以及发往部署机的 prelude 字符串。新增一个连部署机的步骤（即使不含 `git`）同样失败。
  - 步骤读取器：steps 列表里的每个 `- ` 项都是步骤，有无 name、键的顺序都不限；`run:` 的块标量接受全部头部（`|`、`|-`、`|+`、`>`、`>-`、`>+`、缩进指示符、尾随注释），也读单行与多行流标量；`with:`、`env:` 下的 `run:` 不算步骤的脚本；读不懂的步骤形状直接失败。每个步骤必须恰有 run 与 uses 之一。读取器有一个合成工作流的控制用例。

### 2.4 任务冒烟补 M3 用例（`staging-tasks-smoke.mjs`）

路由、请求体、状态码和错误码取自本分支的 `packages/core-backend/src/routes/tasks.ts`、`services/task-structure.ts`、`services/task-records.ts`，契约为 `docs/development/task-m3-backend-design-20260928.md`。

身份（全部由 STAMP 推导，org 为 `default`）：

| 身份 | id | 种入 | 说明 |
|---|---|---|---|
| subject | `<stamp>` | users、user_orgs、角色 `<stamp>-role`（`tasks:read`、`tasks:write`）、user_roles；准入在 403 检查之后才授予 | 所有写操作的调用者 |
| member | `<stamp>-member` | users、user_orgs（active）、user_roles（与 subject 共用 `<stamp>-role`）、tasks 命名空间准入 | 加执行人/关注人的目标。本 SHA 上这两条路由只校验 id 形状（`isValidMemberId`），不校验用户存在或属于本 org（跨 org 成员规则未实现）；仍按真实成员种入，规则收紧后用例依然成立。只在关注人自行退出时用 `MEMBER_TOKEN` 登录一次：`POST /api/tasks/:id/leave` 需要 `tasks:write`，以及只有 follower 才有的 `leave` 能力 |
| outsider | `<stamp>-outsider` | users、user_orgs、角色 `<stamp>-outsider-role`（`tasks:read`）、user_roles、tasks 命名空间准入 | 与冒烟任务没有任何关系 |

两个角色 id 都经过 `assertNotAdminRoleId`。

用例顺序（在原有准入门与 P0-A 用例之后）：

1. 父任务候选与子任务：创建第二个任务。设父之前，`GET /api/tasks/:child/parent-candidates` 必须恰好是 `[{id: 父任务, title}]`：候选是本 org 未软删、不是该任务本身及其后代、且调用者能编辑的任务，subject 是新身份，只能编辑冒烟自己的两个任务（staging 上 org `default` 里别人的任务因此也不会出现，顺带检查了"限于调用者能编辑"）。`PATCH /api/tasks/:child/parent {parentId: parent}` → 200 `{id, parentId, depth: 1}`；子任务读回 `parentId`、`depth`，父任务 `children` 里有它（depth 1）；此时父任务自己的候选必须为空（它自己和它的子任务都被排除）。`{parentId: null}` 清除 → `depth: 0`，读回后父任务不再列出；再次设父，供删除用例使用。
2. 执行人：`POST /api/tasks/:id/assignees {userId: member}` → 200（成员表含 subject 与 member，任务仍 `open`），读回；`DELETE /api/tasks/:id/assignees/:member` → 200（仍 `open`，剩下的执行人未完成），读回。
3. 关注人：`POST /api/tasks/:id/followers {userId: member}`、`DELETE /api/tasks/:id/followers/:member`，各自读回。随后 subject 再把 member 加为关注人，member 用自己的令牌 `POST /api/tasks/:id/leave`（无请求体）→ 200 `{id, followers}`，`followers` 不含 member；subject 读回也不再有 member。
4. 完成模式：`PATCH /api/tasks/:id/completion-mode {completionMode: 'any'}`，再改回 `'all'`，各自读回；两次都没有人已完成，任务保持 `open`。
5. 评论：`POST`、`PATCH`、`DELETE /api/tasks/:id/comments[/:commentId]`。编辑之后先用 `GET /api/tasks/:id/comments` 读回，按评论自己的 id 找到它，正文必须是新正文且 `deleted: false`（只看 PATCH 的回答，发现不了"回答了新正文却没有保存"的后端）；删除之后再读回为墓碑（`deleted: true`、`body: null`），且仍计入 `total`。
6. outsider：先 `GET /api/tasks/context` 要求 200 且 `orgId = default`（证明已准入、租户声明可解析），再 `GET /api/tasks/:id` 要求 404 `NOT_FOUND`。200 判为行级可见性失效（SECURITY）；403 判为准入门拦下、行级检查没有被执行；context 不是 200 或 orgId 不对也直接失败（否则任务读取的 404 可能只是 org 缺失）。
7. 删除：父任务仍有未删子任务时 `DELETE` → 409 `HAS_CHILDREN`；先删子任务、再删父任务，均 200 `{id, deleted: true}`；之后读取两者都是 404 `NOT_FOUND`。

列表类读回（`children`、`assignees`、`followers`、候选的 `items`、评论的 `items`）必须真的是数组：字段缺失或不是数组时，"在列表里"和"不在列表里"的判断都失败，不会把缺字段当成"已移除"。需要从列表里取某一行的读回（父任务的 `children` 里的子任务、编辑后与删除后的评论）一律按该行自己的 id 查找，再检查它的值（子任务的 `depth`、评论的正文与 `deleted`），不取列表的第几个元素。

不加探测输入校验边界的用例（特殊 id 字符、长度上限等），只走文档化的正常路径与文档化的 404/拒绝规则。

创建校验：每次 `POST /api/tasks` 之后，冒烟先在库里确认回答的 id 确实是本次运行的任务，才使用它：`SELECT count(*)::int AS n FROM tasks WHERE id = $1 AND created_by = $2 AND title = $3 AND org_id = $4`（参数为该 id、subject、本次发送的标题、`ORG_ID`）必须恰为 1。否则该步断言失败、运行立即终止，错误信息点名这个 id，且它不进入本次运行的任务 id。别人的任务、本次运行先前创建的另一个任务（标题不同）、落在别的 org 的任务都在这里被拦下。

清理规则：**只删除种入身份创建的任务，以及这些任务下的子表行；每条 DELETE 都在语句内部按 `tasks.created_by` 属于种入身份来选行，从不按 API 回答里的 id 选行。**

- 为什么安全：stamp 每次运行都是新的，预检在写入任何数据之前证明种入身份没有任何行（其中 `tasks_by_creator` 为 0），所以 `created_by` 属于种入身份的任务只可能是本次运行创建的。后端即使回答了别人的任务 id，那个任务的创建者也不是种入身份，清理选不到它；创建校验又让这样的回答在当步失败。
- 语句（任何路径，只要开始种数据就执行；外键安全）：`task_comments`（含墓碑）、`task_events`、`task_followers`、`task_assignees` 各一条 `DELETE FROM <表> WHERE task_id IN (SELECT id FROM tasks WHERE created_by = ANY($1::text[]))`；再用**一条** `DELETE FROM tasks WHERE created_by = ANY($1::text[])` 删任务（含软删的；`tasks.parent_id` 自引用外键是 NO ACTION，在语句末尾检查，父子同删不违反约束）；然后删准入、`user_roles`（按用户删全部行：platform 产品模式下令牌首次校验会给非管理员补一行 `attendance_employee` 角色，见验证记录）、`user_orgs`、`users`、`role_permissions`、`roles`。`$1` 一律是种入身份列表。
- 单条语句失败记为告警，最终由残留检查裁决。若别人的任务挂在本次运行的任务下面（后端故障），删 `tasks` 的语句会因父子外键失败，残留检查报出本次运行的任务，运行失败；别人的任务和它下面的子表行不会被删。

残留检查（清理之后）：

- "本次运行的任务 id"只来自库：通过创建校验的 id，加上清理在 DELETE 之前按创建者查到的任务 id（两轮清理之间保留）。只在 API 回答里出现过的 id 不计入，所以不属于本次运行的任务既不会被算作残留，也不会被算作已清理。失败路径打印的 `Residue after best-effort cleanup: … (clean=…)` 同样只覆盖这些任务 id 与种入身份。
- 枚举 `information_schema` 中 `public` schema 下所有带 `task_id` 列的 BASE TABLE（标识符加引号），按本次运行的任务 id 计数；`task_id` 一律按 `::text` 比较，非 text 类型的列（本 SHA 的本地 schema 里有一张 `uuid` 类型）照常计数而不报类型错误。
- 另计 `tasks` 按 id、按 `created_by`，以及每个身份表（users、user_orgs、user_roles、user_namespace_admissions、roles、role_permissions）与任务表按用户（assignees/followers 的 user_id、comments 的 author_id、events 的 actor_id）。
- 任一计数非零即失败；枚举结果缺少已知的四张任务表（task_assignees、task_comments、task_events、task_followers）也失败，不在更小的总体上给出"零残留"结论。
- 动态枚举只用于检测，不用于删除：清理只删冒烟明确写入的表，不对枚举出的无关表发 DELETE。

PASS 行前缀保持 `TASKS_API_DB_SMOKE_PASS`，字段不变。全仓只有 `staging-tasks-smoke.test.mjs` 匹配这一行；runner 只看退出码。

### 2.5 harness 测试（`staging-tasks-smoke.test.mjs`）

真实冒烟脚本作为子进程运行，配合一个 fake `pg` 和一个有状态的任务路由桩。

- 路由桩：按"方法 + 路径形状"给每个请求定键，方法或路径不对就是 unknown（404）；按后端的行级能力回答（view/comment：创建者、执行人、关注人；edit：创建者、执行人；delete：创建者；leave：只有关注人；没有能力即 404 `NOT_FOUND`）；subject 在准入前 403，outsider 只有读权限（写路由 403）；按令牌区分 subject、member 与 outsider。测试既可以替换某个路由键的全部回答，也可以只改期望调用序列中**某一次**调用的诚实回答（不改桩的状态；被改写的请求的方法、键、任务 id、子 id 必须与该步的期望一致）。
- 调用目标：路径形状说明不了请求指向哪个任务，而读一个从未创建的 id 与行级拒绝得到同样的 404 `NOT_FOUND`，正是 outsider 检查和已删任务检查接受的回答。所以路由桩把每个请求记为 `{方法, 键, 任务 id, 子 id}`，期望调用序列的每一项都写明目标（桩的 id 是确定的：父任务 `tsk_1`、子任务 `tsk_2`、评论 `tcmt_3`；移除执行人、移除关注人的子 id 是 member），正常路径与每个 cell 都比较完整的调用轨迹（会停止的 cell 比较到该步为止）。桩还记录引用了它从未发出的任务 id 或评论 id、或子 id 不是种入身份的请求，每个测试都要求这个列表为空。另有一个直接驱动路由桩的控制用例。
- 错形回答表：每个断言至少一个 cell，复合断言的每个子条件各一个 cell，每个列表读回另有一个"字段缺失"的 cell；按 id 取行的读回另有"另一行占位"与"值不对"的 cell（别的子任务、depth 为 0 的子任务、另一条评论的墓碑、带新正文的另一条评论）。每个 cell 都要求：非零退出、没有 PASS 行、打印它自己的 `FAIL  <标签>`（守卫直接抛出的步骤则是该处的消息）、全量清理、残留复核干净。会抛出的步骤要求 HTTP 流程在该步停止；其余 cell 要求流程走完，且失败的断言只有这一条。
- 他人任务的 id：fake 库里存有另一身份的任务（与父任务同 org、同标题，只有创建者不同；它下面有一个子任务和评论、事件、关注人、执行人各一行）。创建父任务、创建子任务回答这个 id，创建子任务回答父任务自己的 id，都必须在创建校验处失败并停止；设父、删除子任务回答这个 id，新评论把它当作 `taskId`，都必须在各自的断言处失败并走完流程。每个 cell 的清理检查都要求：这个任务和它下面的所有行原样保留，且没有任何清理或残留语句绑定到它的 id。另有单独用例：库里的新任务落在别的 org 时创建校验失败；collect 查询失败时清理仍按创建者删除；创建回答了他人任务 id、或 collect 查询失败时，本次运行真实创建的任务下、留在没有外键的 `task_id` 表里的行仍被残留检查报出。
- 正常路径钉住完整调用序列与 `Assertions passed: 99`，删掉任何一条断言都会改变计数（本地端到端对真实后端同样是 99）。
- fake `pg` 是一个小型行存储：只接受冒烟实际发出的语句形状，WHERE 只能是 `<列> IN (SELECT id FROM <表> WHERE …)`（执行时按库内当前的行求值），或全部用 OR、或全部用 AND 连接的 `<列> = ANY($n::text[])` / `<列> = $n`，其余一律抛错；行带来源（他人的行、本 stamp 的预存行、种入的行、运行期间 API 写入的行及令牌校验补的角色行、清理后仍残留的行）；`to_regclass` 与残留查询按查询自己列出的别名和 WHERE 子句计算。
- SQL 钉死：正常路径的完整语句日志（文本与参数，按顺序，含两次创建校验），每一轮清理的 collect 查询、11 条 DELETE 及其后的全部残留语句（文本与参数；残留的任务 id 参数恰为本次运行的任务），清理只删本次写入的行、不删他人的行，本次写入的行不留下，没有任何清理或残留语句绑定到他人任务的 id。清理之后才出现、挂在本次运行任务 id 下的他人行，第二轮清理也不删，残留结论照常报出。任一种入用户或角色在任一身份表/任务表留一行，清理后的残留结论与预检拒绝都必须把它报出来（逐身份检查）。
- 种子失败：按顺序让每一个种子 INSERT 失败（roles、role_permissions、users、user_roles、user_orgs、user_namespace_admissions），每个一个子测试，都要求非零退出、没有请求、残留复核干净、清理语句序列完整，并且恰好删除失败之前已写入的种子行；第一个 INSERT 失败时还什么都没写，清理语句仍须发出。
- 其他：准入门 403/404/401/200 四种回答、令牌主体不符（member、outsider）、无令牌时的 dev-token 兜底与其缺失、缺表或权限目录不全时的预检拒绝、环境变量缺失时退出 2、新增 `task_id` 表被枚举计数、任务表按任务 id 的残留。

### 2.6 考勤冒烟共用的清理助手（`staging-attendance-tooling-teardown.mjs`）

bundle 让 ae4、otbank-v18、mp6、hmr5 在容器里能加载之后，它们才会真正执行这个清理助手；助手的用户前缀过滤此前从未在真实库上运行过。其中 ae4、mp6、otbank-v18 目前被 runner 拒绝（§2.2），runner 里实际执行这个助手的只有 hmr5；这处修复同样覆盖那三个冒烟，供它们重新启用时使用。

- 问题：三处过滤（`countW4ImmutableAttendanceRows`、`runStagingAttendanceRecordTeardown`、`cleanupStagingAttendanceScope` 的 `filter` 与 `listedFilter`）把同一个占位符既当 `left()` 的长度、又当比较值：`left(user_id, $N) = $N`。PostgreSQL 由 `left(text, integer)` 把该参数定为 integer，比较成了 `text = integer`，报 42883。凡是带 `userIdPrefix` 的范围，第一条语句就失败；四个冒烟都在调用处 `await` 这个助手且不捕获，其后的全部 DELETE（工资周期、假期、加班规则、假期类型、user_orgs、users 等）都被跳过，运行也不可能打印 PASS。
- 修改：三处都改为 `left(<列>, length($N::text)) = $N::text`。仍是一个参数，两处都显式按 text 绑定，长度由库里的 `length()` 计算，各函数的参数列表形状不变。助手的其他语句没有重复使用的占位符，数组参数都有显式类型。冒烟脚本本身不改。
- 无库测试（`staging-attendance-tooling-teardown.test.mjs`，在必需检查 `test` 的 W4C-3c 步骤里运行）：
  - 四个冒烟调用处的范围参数与查询包装按原文钉住（hmr5 没有声明 `ALL_USERS`，所以它的 `userIds` 是 `undefined`）；
  - 对这四个范围，`cleanupStagingAttendanceScope` 以及三个自己拼过滤的函数发出的每条语句，全文与参数都钉住；
  - 每条语句都过占位符规则：作为 `left()` 长度的占位符必须绑定整数，且不得在同一语句里再出现；`left(<列>, length($n::text)) = $n::text` 的两处必须是同一个参数，并且绑定字符串。规则本身另有正反用例。
- 真实库测试（按环境变量启用）：只有设置 `TEARDOWN_REAL_PG_DATABASE_URL`（指向一个已迁移的库）时才运行，不读 `DATABASE_URL`；不设时报为跳过并写明原因，设了但库未迁移时失败。它在一个连接上的事务里运行，结束时回滚，不提交任何数据。四个冒烟范围各种入带前缀的行与金丝雀（同 org 无前缀的用户、同一冒烟家族的另一次运行、多一个字符的近似 stamp、前缀出现在 id 中间、裸 stamp、另一个 org 里的带前缀用户；ae4 另有一行不在其 `recordIds` 里的带前缀用户行），通过冒烟的查询包装依次清理，按种入的 id 检查每个范围恰好删除它自己的行，其余范围的行与全部金丝雀不受影响；另跑其他考勤冒烟用的 `{orgId, userIds}`、`{orgId, recordIds}` 范围，以及三个函数的直接调用。

## 3. 范围外

- 其他工作流（生产日志快照、生产指标等）里的 `skip_host_sync` 属于各自工作流，本 PR 不动。
- 考勤五个冒烟脚本本身不改，只随 bundle 打包；它们共用的清理助手只改用户前缀过滤（§2.6）。用 `userIdPrefix` 调用这个助手的还有不在 runner 里的 m5 冒烟，同样由这处修复覆盖。
- ae4、mp6、otbank-v18 的清理与夹具更新属于考勤线后续；本 PR 只让 runner 拒绝它们（§2.2）。
- 不改后端代码、不加迁移、不改 `TASKS_ENABLED` 的默认值。

## 4. 已知限制

- `staging-tasks-smoke.test.mjs` 只在 runner 工作流自己的派发自检步骤（`Run pipeline self-test`）里运行。该步骤在同步 bundle 和任何远端操作之前执行，没有 `if:`、也没有 `continue-on-error`，失败即中止这次派发，所以 harness 变红不会触达 staging。但 PR 必需检查（`plugin-tests.yml` 的 `test (20.x)`）只跑 `attendance-window-runner-pipeline.test.mjs`，harness 的回退要到下一次派发才会暴露。是否把它加入 PR 门禁工作流，列为 owner 待定问题；本 PR 未改 `plugin-tests.yml`。
- staging 上带 `task_id` 列的表可能多于本地（本地迁移按标准 `MIGRATION_EXCLUDE` 跳过了若干文件）；非 text 列上的计数是顺序扫描，按 staging 的数据量可以接受。
- 冒烟会在 staging 的 `task_events` 等表上产生写入并在清理时硬删除；审计类表（若有按用户记录的）不在清理范围内，本地端到端运行后全库扫描未发现任何残留值（见验证记录）。
- §7 残留扫描（`action=residue-sweep`）的 `stamps` 输入仍要求 ae4 与 otbank 两个字段；这两个冒烟被拒绝期间，本 runner 不会产生它们的 stamp。
