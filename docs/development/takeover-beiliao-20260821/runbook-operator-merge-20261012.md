# 运行手册：一线角色合并为「操作人员」（R66 上机，owner 2026-10-12）

> 依据：owner 2026-10-12 裁决「把 一线填写 及原一线角色（stock-prep-operator）合并，name 就用操作人员来替代」；ADR `adr-stock-prep-project-sheets-20261008` §8 第 3 步、§11.2-1；决策登记 R-39。
> **上机版本：R66。** R65（`6d4e9fc38`，tag `onprem-r65`）已于 2026-10-12 按 owner「R65 = main 原样，不等其他」上机，**不含**本合并：R65 里没有改名迁移，R65 的脚本也不认 `--split-extra-codes-to-role`。
> **在任何服务器上运行脚本（含 dry-run）都是 owner 动作。** 本手册在老机器上执行；不含主机、地址、口令、项目号、用户 id——这些只在私有记录里。

## 执行记录（2026-10-13，演示机，owner 裁定；#6079 评论 6138127578、6139488065）

- R66（`e2345ab6b`）已上机，三步均已在演示机执行：① 拆分——旧角色上的 3 个多余码（`approvals:read`、`approvals:write`、`multitable:submit-approval`）移到新建平台角色 `approvals_operator`「审批与提交」，带 1 名成员；② 搬迁——1 个成员关系 + 1 行表级授权搬到 `stock-prep_frontline`（显示名已由迁移 `zzzz20261012090000` 改为「操作人员」）；③ 删除——`--apply --delete-empty-old-role`，各项前提计数均为 0，`stock-prep-operator` 已删除。
- 演示机备料相关角色现为：`stock-prep_admin`、`stock-prep_puller`、`stock-prep_developer`、`stock-prep_frontline`「操作人员」四个内置角色，加平台角色 `approvals_operator`「审批与提交」。
- 再次运行脚本是空操作（`nothing to split` / `nothing to move`）。下文保留为执行时的原始手册。

## 0. 这次合并做什么

- 内置角色 `stock-prep_frontline` 的显示名随 R66 迁移 `zzzz20261012090000` 从「一线填写」改为「操作人员」，**角色 id 不变**。
- 旧一线角色 `stock-prep-operator` 的成员和以它为主体的表级授权行，用脚本 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 搬到 `stock-prep_frontline`。
- 旧角色上手工加的平台码（预计 `approvals:read`、`approvals:write`、`multitable:submit-approval`，以库里实际为准）**不进内置角色**；脚本的 `--split-extra-codes-to-role` 把它们放到单独的平台角色（推荐 id `approvals_operator`（旧机转述 owner 已裁定）；owner 放行 dry-run 时确认一次即可；默认显示名「审批与提交」），授给同一批成员（ADR §8 第 3 步方案 ①）。合并前后每个成员的**平台权限码**（RBAC 角色码、直授码、旧版码之并集）不变。**按角色 id 或显示名匹配人的其它配置不在脚本清点范围内**——考勤的调度权限（排班管理范围）、日历 / 节假日覆盖规则，钉钉同步的「成员组默认业务角色」等；这些在第 1 步由 owner 人工预检，合并后在第 5 步核对。
- 脚本**不改**审批模板；它只打印计数：有多少模板版本 / 已发布定义按 id 或显示名把旧角色写成审批人、办理人、兜底审批人、抄送对象或「提交人自选」的角色范围；有多少模板的「可见范围」是角色范围、搬迁后成员会看不到（失）或新看到（得）。这几类之外的引用（例如审批图里按发起人 `approval_usable` 角色走的 `requester.role` 条件分支）脚本**不清点**。
- 脚本**不复制** `roles.approval_usable`（审批图按发起人角色分支时只认这一列为 true 的角色）：它只在 dry-run 里打印旧角色、内置角色和拆出角色各自的值；脚本新建的拆出角色取列默认值 false。拆出角色要不要设成 true 由 owner 定（见第 1 步第 5 项）。

## 0.5 取得脚本（安装包里没有它）

R66 安装包**不含** `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs`，R65 包同样不含：打包脚本 `scripts/ops/multitable-onprem-package-build.sh` 只复制 `REQUIRED_PATHS`（:37-187）里逐条列出的路径（复制循环 :591-593），`scripts/ops` 下列出的是具体文件，没有这个脚本，也没有整个 `scripts/ops` 目录。上机前：

1. **只从 R66 打包点**（或任何包含本手册所在 PR 的提交）取这一个文件。**不要**从 R65（`6d4e9fc38`）或更早的提交取：那份脚本没有拆分参数，遇到 `--split-extra-codes-to-role` 直接报 `unknown argument at position N` 并以退出码 1 结束（不写库，但第 2、3 步都跑不起来）。
2. 在开发机上用 **Git Bash 或 PowerShell 7.4+** 执行（7.0–7.3 的原生命令管道按文本解码，`git archive | tar -x` 会损坏，第 3 步的哈希核对能发现），用 `git archive` 取，**不要用 shell 重定向**（`git show … > 文件`）：Windows PowerShell 5.1 的 `>` 写出 UTF-16LE（`FF FE` 开头），node 直接报语法错；PowerShell 7.0–7.3 可能按控制台代码页解码 git 输出，把脚本里的默认显示名「审批与提交」写成乱码，拆出的角色就带着乱码名字入库。`git show <提交>:<路径> --output=<文件>` 也不行：对文件内容（blob）`--output` 不生效，仍输出到屏幕。在仓库根目录执行（`core.autocrlf=false` 让取出的字节与提交里一致，不被换成 CRLF）：
   ```
   git -c core.autocrlf=false archive --format=tar <提交> scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs | tar -x -C <空目录>
   ```
3. **核对拷贝等于提交里的文件**：下面两条输出必须完全相同，不同就重取，不要用：
   ```
   git hash-object --no-filters <空目录>/scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs
   git rev-parse <提交>:scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs
   ```
   （`--no-filters` 必须带：开发机若开着 `core.autocrlf=true`，不带它时 CRLF 的拷贝也会算出同一个值。）再算开发机上这个文件的 SHA-256（`sha256sum` 或 `Get-FileHash -Algorithm SHA256`），**记入台账**。
4. 拷到服务器上一个**不含空格**的真实目录（不必放进安装根目录，例如 staging 目录下的子目录），在服务器上用 `Get-FileHash -Algorithm SHA256 <拷贝路径>` 算一次，与台账里开发机的值逐字比对，不同就不要用。
5. 之后各步的命令都用这个拷贝的路径，并带上 `--root <安装根目录>`。`--root` 只做两件事：从 `<安装根目录>/packages/core-backend` 加载 `pg`；`DATABASE_URL` 没设时从 `<安装根目录>/docker/app.env` 读取（不打印；解析方式与后端 `ecosystem.config.cjs` 一致：行首 BOM、行首空格、`DATABASE_URL = 值` 都认，取第一条）。脚本本身只依赖 Node 内置模块和这个 `pg`。

下文命令里的 `node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 一律换成 `node <拷贝路径>`，并按 0.6 的写法执行。

## 0.6 在服务器（Windows PowerShell 5.1）上怎么执行、怎么看结果

- **用 cmd 落日志**：PowerShell 5.1 的 `>` 和 `Tee-Object` 写 UTF-16，含中文的输出行会乱码。每一步都这样跑（把 `<参数>` 换成该步的参数）：
  ```
  cmd /d /c "node <拷贝路径> --root <安装根目录> <参数> > <日志路径> 2>&1"
  $LASTEXITCODE
  Get-Content -Encoding UTF8 <日志路径>
  ```
  安装根目录含空格时，在 `cmd /d /c "…"` 字符串里把该路径用成对双引号括起（PS 5.1 已测）：`cmd /d /c "node <拷贝路径> --root ""<根目录>"" <参数> > <日志路径> 2>&1"`；路径不要以 `\` 结尾。
  `$LASTEXITCODE` 就是脚本的退出码（0 / 1 / 2，见第 3 步）。经 ssh 单行执行时，在整行末尾加 `; exit $LASTEXITCODE`，退出码才会传回本地。
- **日志第一行必须是 `OWNER ACTION (R-39): …`**（脚本在接受参数和 `DATABASE_URL` 之后、加载 `pg` 和连库之前打印这一行）。没有这一行就是**脚本没跑**：参数错 / 没有 `DATABASE_URL`（这两种退出码 1，错误在日志里），或者 node 根本没把它当入口执行。R66 打包点的脚本经联接（junction）或符号链接的路径也能正确执行；从更早提交取的旧版经联接执行时什么都不打印、直接退出 0——这正是要查第一行的原因。
- `--root` 的路径若含空格要加双引号，且**不要以 `\` 结尾**（`"C:\…\"` 里的 `\"` 会把引号转义掉，和后面的参数粘成一个）。拷贝路径和日志路径放在不含空格的目录里。安装根目录含空格时，先用 dry-run 确认第一行和退出码都正常，再做第 3 步。
- **不要传 `--split-role-name`**：用默认显示名「审批与提交」（中文参数经 PowerShell 5.1 → cmd → node 传递有乱码风险；脚本也会拒绝内置角色名和 `admin`）。
- **不要把输出接到 `Select-Object -First`**（或任何会提前结束管道的命令）：会截断运行、丢掉退出码。只用上面的落日志写法。

## 1. R66 升级之后：只读预检

1. **改名是否生效，以这条 SQL 为准**（纯 ASCII，可直接在 PowerShell 5.1 / psql 里执行；`U&'\64CD\4F5C\4EBA\5458'` 就是「操作人员」，需要 PostgreSQL 默认的 `standard_conforming_strings = on`）：
   ```
   SELECT count(*) FROM roles WHERE id='stock-prep_frontline' AND name=U&'\64CD\4F5C\4EBA\5458'
   ```
   期望 `1`；`0` 表示没改名。原因看**完整的升级日志**（迁移阶段的全部输出）：上机包装脚本的摘要只保留含 `migration` 字样的行（这是旧机自己的包装脚本行为；仓库里的 `scripts/ops/multitable-onprem-package-upgrade-inplace.ps1` 没有这个过滤），而改名迁移的结果行（`zzzz20261012090000` 第 297 行打印的 `up: role stock-prep_frontline display name updated (1 row)`，以及各种 `NOT renamed — …` 行）**不含**这个词，摘要里看不到。
   - `zzzz20261010124500_seed_stock_prep_role_templates`（R64 已跑，本次不再出现属正常）；
   - `zzzz20261012090000_rename_stock_prep_frontline_display_name`：应为 `up: role stock-prep_frontline display name updated (1 row)`。如果是 `NOT renamed …` 或 `does not carry the expected display name; left as found`，记下原因（计数），合并照常可做，改名由现场在「角色管理」里手工处理（先确认日志里说的审批席位 / 抄送 / 角色范围的模板可见范围 / 审批模板版本或已发布定义里的角色引用 / 考勤调度权限或日历、节假日覆盖规则里的角色引用 / 同名角色）。改名迁移只查「一线填写」「操作人员」这两个名字；下面第 4 项的人工预检范围更大。
   - **「操作人员」是常见职务名，改名容易被跳过。** 只要库里有任一处已经用「操作人员」这个名字，迁移就不改名（内置角色此时 0 成员也一样，查新名字不看成员数）：审批席位、抄送记录、角色范围的模板可见范围、审批模板版本或已发布定义的图里按显示名写了「操作人员」（迁移 :228-250）；考勤调度权限的角色 / 角色标签主体或目标（:151-158、:253-266）；或考勤设置（`attendance.settings`）里**任意深度**的 `roles` / `role` / `position` / `jobTitle` / `roleTags` / `role_tags` / `tags` 条目（:164-208，忽略大小写和首尾空格）——职位、职务、标签里写「操作人员」都算。看 `NOT renamed — …` 那一行的计数，由 owner 决定改那些配置还是在角色管理里手工改名。
2. 在「角色管理」里确认 `stock-prep_frontline` 存在、只持有 `stock-prep:read` + `stock-prep:operate`。**G1 角色清单不在角色管理里**：它是 `docker/app.env` 里的键 `MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`（`plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs:67`，:104 读取）。确认 `app.env` 里**没有这个键**（只看键名，不抄值、不贴值）；有就停下报 owner——G1 一旦给内置角色写了表级授权，脚本的「凭空多得」检查会拒绝。
3. 确认没有人正在编辑角色、任命成员或改审批模板；约好维护窗口。
4. **owner 人工预检：按角色 id / 显示名匹配人的其它配置**（脚本不读这些，搬迁会让一线成员悄悄得到或失去它们）。要搜的值：旧角色 id `stock-prep-operator` 及它在「角色管理」里的显示名、`stock-prep_frontline`、「操作人员」、「一线填写」、`approvals_operator`、「审批与提交」。考勤侧把角色 id 和显示名都当作角色和角色标签来匹配，比较时忽略首尾空格（日历 / 节假日覆盖规则还忽略大小写）。
   - 考勤「调度权限」（排班管理范围）：主体类型为角色 / 角色标签的记录的主体；以及每条记录的目标范围里的「角色」「角色标签」列表。命中意味着搬迁后一线成员会得到或失去对某批人的排班、导出他人考勤、审批他人考勤等权限，或者变成别人调度权限的目标。停用的记录也要看（重新启用就生效）。
   - 考勤「节假日覆盖规则」和「有效日历覆盖规则」：每条规则的角色 / 角色标签筛选。命中意味着一线成员会换一套工作日历。
   - 考勤「审批流程」：每条流程每一步的审批角色（`approverRoleIds`）。考勤按角色 **id** 给每一步落审批席位（`plugins/plugin-attendance/index.cjs` 的 `pushAssignment('role', approverRoleId, …)`），认审批人也只按角色 id（同文件 `isAttendanceActorAssignedForNode`，只读 `user_roles.role_id`）。若某一步写的是 `stock-prep-operator`：搬迁后旧角色没人，此后新提交的考勤申请落在空角色上，**无人能批**（已在途的申请同样卡住）；若写的是 `stock-prep_frontline` 或 `approvals_operator`：搬过来的成员会**多出审批他人考勤**的权力。命中就先改流程的审批角色（由 owner 定），再执行。
   - 钉钉同步（目录管理）：每个集成的「成员组默认业务角色」。若含 `stock-prep-operator`，以后新同步进来的一线人员只会拿到旧角色——搬迁后旧角色没有码，他们拿不到审批与提交的码；先改成 `stock-prep_frontline` 加 `approvals_operator`（由 owner 定），再执行。
   命中任一项：先由 owner 决定改配置还是接受变化，再执行第 3 步。
5. **旧角色的 `approval_usable`**：
   ```
   SELECT approval_usable FROM roles WHERE id='stock-prep-operator'
   ```
   新建角色该列默认 false（迁移 `zzzz20260627150000_add_approval_usable_to_roles` 第 24 行）。第 2 步的 dry-run 也会打印这一行（`approval_usable — stock-prep-operator: …; stock-prep_frontline: …; approvals_operator: …`）。若旧角色是 **true**：审批图里按发起人角色走的分支（`requester.role`）原来能匹配这批人，搬迁后他们落在 `stock-prep_frontline` / `approvals_operator` 上（都是 false），分支走向会变。脚本**不复制**这一列，也不检查这类分支；`approvals_operator` 要不要设为 true 由 owner 定。

## 2. dry-run（只读，不写任何东西）

按 0.6 的写法执行，参数为：

```
--split-extra-codes-to-role approvals_operator
```

即 `cmd /d /c "node <拷贝路径> --root <安装根目录> --split-extra-codes-to-role approvals_operator > <日志路径> 2>&1"`。dry-run 不加锁。

逐行核对输出（全是计数、角色 id、权限码，没有值）：

- 第一行 `OWNER ACTION (R-39): dry run — stock-prep-operator → stock-prep_frontline (extra codes split to approvals_operator first)`；
- `approval_usable — stock-prep-operator: …; stock-prep_frontline: …; approvals_operator: role absent` 和 `approval_usable — NOT copied by this script …; the owner decides whether approvals_operator should get it`（见第 1 步第 5 项）；
- `split: extra codes (on stock-prep-operator, not on stock-prep_frontline): N (…)`：这就是要拆出去的码，以库里实际为准；
- `split: role approvals_operator absent; …`，`split: delegable namespaces approvals_operator falls in: 0`；
- `dry run: --apply first does the split: create role approvals_operator with N code(s) …, add M member(s) …, remove those N code(s) …`；
- `dry run: --apply would move M membership(s) and K table grant(s)`；
- 审批席位 / 抄送、待接受邀请、`gains — …` 各行；
- 两行 `approval designer — …`：模板版本数与已发布定义数（第 3 步之后要用）。现在也数「提交人自选」节点里角色范围指名旧角色的情形——服务端按角色 id 校验这种范围，搬迁后旧角色没人，提交会被 422 拒绝；
- 两行 `approval template visibility — …`（脚本不改可见范围；「失」那一行大于 0 且旧角色仍有成员时 `--apply` 拒绝，见下；「得」那一行只计数）：
  - `… visible through stock-prep-operator but not through stock-prep_frontline[ or approvals_operator] …: N; moved members would stop seeing them (记录送审)`：可见范围按角色 id 或显示名只指名了旧角色的模板。N 大于 0 时，**搬迁前**在审批模板的「可见范围」里把 `stock-prep_frontline`（或 `approvals_operator`）加进去，否则搬完后这些成员对这些模板发起记录送审会被拒绝（403）；
  - `… visible through stock-prep_frontline[ or approvals_operator] but not through stock-prep-operator …: N; moved members would newly see them`：可见范围指名了内置角色或拆出角色（按 id 或显示名，含「操作人员」「审批与提交」）的模板，搬迁后原旧角色成员会新看到。N 大于 0 时由 owner 判断是否可接受；不可接受就先收窄这些模板的可见范围再执行。

出现 `--apply would refuse: …` 就**停**，按提示处理后重跑 dry-run。常见的：
- `split: N of the extra code(s) are admin-level …`：旧角色上有管理级码，由平台管理员手工处理，不自动化；
- **任何指向拆出角色 id 的拒绝**（`split: role approvals_operator falls inside … namespace(s)`、`already exists and its codes are not exactly …`、`does not exist but … still name that id`、`another role already carries the display name …` 等）：推荐 id `approvals_operator`（旧机转述 owner 已裁定；owner 放行 dry-run 时确认一次即可）。**停下，把这一行原样报给 owner**；不要自己换 id，也不要传 `--split-role-name`——即使脚本提示里写着 "choose another id"；
- 旧角色仍被审批席位 / 抄送按 id 或显示名指名且有成员：成员会失去这些历史审批的读权限，由 owner 决定后再动。
- `stock-prep-operator makes N role-scoped approval template(s) visible … that stock-prep_frontline[ or approvals_operator] do(es) not`（#6348 后续，2026-10-14 起由计数改为拒绝）：先在这些模板的「可见范围」里加上 `stock-prep_frontline`（或 `approvals_operator`），再重跑 dry-run，直到这一行消失。若拆分是在「角色管理」里手工做的（旧角色已无多余码、全部成员已在拆出角色里），重跑时带上 `--split-extra-codes-to-role <拆出角色 id>`，拆出角色才算在「搬迁后」一侧（脚本此时不做拆分，只搬迁）。
- 名字比较的首尾空白（#6348 后续）：脚本在 JS 和 SQL 两侧都按 `String.prototype.trim` 的字符集去首尾空白（含全角空格 U+3000、不换行空格 NBSP、U+FEFF 等，与服务端一致；PostgreSQL 单参数 `btrim` 只去半角空格），所以别的角色名为「审批与提交」前后带全角空格 / NBSP 也算撞名，照上一条「指向拆出角色 id 的拒绝」处理；需要库编码为 UTF8 且 `standard_conforming_strings = on`（两者都是 PostgreSQL 默认；后者为 off 时 `U&'…'` 字面量报 SQLSTATE 0A000），否则脚本在第一条清点语句处以 SQLSTATE 退出 1、什么都不写。
- 「角色管理」（`POST /api/roles`、`PUT /api/roles/:id`）同样拒绝（400 `ROLE_NAME_RESERVED`）把角色新建成或改名为 `admin`（任何大小写 / 全半角 / 空格写法）、内置平台角色名（「管理员」「普通用户」、考勤与云课堂内置角色名）和备料内置角色名；只有拥有该名字的那个 id 可以用它，原样保存现有名字不受影响（#6348 后续）。
- 「审批与提交」已列入备料成员页的保留名（S8）：不能再新建或改名出第二个「审批与提交」；`approvals_operator` 本身不受影响（#6348 后续）。

## 3. owner 放行后：维护窗口里执行

按 0.6 的写法执行，参数为：

```
--apply --split-extra-codes-to-role approvals_operator
```

- 第一行 `OWNER ACTION (R-39): APPLY — …`；没有就是没跑（见 0.6）。
- 退出码 0：输出里有 `apply: split — created role approvals_operator with N extra code(s), added M member(s) …, removed N code(s) …` 和 `apply: moved M membership(s) and K table grant(s); stock-prep-operator kept`。
- 退出码 2：拒绝，**什么都没写**（拆分阶段的拒绝会回滚到保存点）。按提示处理后从第 2 步重来；指向拆出角色 id 的拒绝按第 2 步，停下报 owner。
- 退出码 1：执行失败，事务已回滚，什么都没写；只报位置或错误码，不报值。来源有四类（脚本行号以 R66 打包点为准）：
  - 参数错：`unknown argument at position N` 等（`parseArgs`，:678-706；报错在 :1333 返回 1）——核对命令行，尤其 `--root` 引号与结尾的 `\`；
  - 读不到 `DATABASE_URL`：`DATABASE_URL is required …`（:1341-1342）——核对 `--root` 是否指向安装根目录、`docker/app.env` 里有没有这个键；
  - `failed (code MODULE_NOT_FOUND)`：`--root` 写错，`<安装根目录>/packages/core-backend` 下加载不到 `pg`（:1323，:1361 报码）；
  - `failed (code 55P03)`：等锁超过 5 秒（每次 `--apply` 都先设 `SET LOCAL lock_timeout = '5s'`，:612、:1172）——当时有钉钉同步或管理员在写成员 / 角色。稍后重跑同一条命令即可；
  - 其它 `failed (code …)`：数据库错误，只有代码，把代码报给 owner。
- 可重跑：第二次什么都不写。
- 成员的权限缓存最长 60 秒，刷新页面后生效。
- **紧接着、在同一个维护窗口里、做第 4 步之前**：第 2 步 `approval designer — …` 计数大于 0 时，在审批设计器里把这些模板的审批人 / 办理人 / 兜底审批人 / 抄送对象 / 「提交人自选」角色范围从旧角色改指向 `stock-prep_frontline`（或 `approvals_operator`，视该节点需要的权限），再重新发布；脚本不改审批模板。拖到之后再改的话，这段时间里新发起的审批实例会把席位或抄送派给已经没人的旧角色（无人能办），而这些新席位 / 抄送记录又会让第 4 步被拒绝。

## 4. 可选：删除已空的旧角色

> **演示机已完成（2026-10-13）**：本步已执行，旧角色已删除，见文首「执行记录」。

按 0.6 的写法执行，参数为：

```
--apply --delete-empty-old-role
```

前提：第 3 步末尾的审批设计器改指向已经做完（否则见上）。只有旧角色已没有成员、没有任何 role 主体授权行、没有任何状态的角色审批席位、没有角色抄送记录、也没有指名它的待接受邀请时才删。**会拒绝的典型情形**：历史审批里仍有按旧角色 id 或显示名的席位或抄送记录——这些记录搬不走，删掉旧角色后若有人按同一 id 或显示名重建角色，就会读到这些审批；这时保留旧角色（它已没有成员和码之外的权限，不影响使用）。

## 5. 收尾核对

1. 「角色管理」：`stock-prep_frontline` 成员是原两个角色成员的并集；`approvals_operator`（「审批与提交」）持有拆出的码、成员是原旧角色成员；`stock-prep-operator` 已无成员（或已删除）。
2. **改名以第 1 步第 1 项那条 SQL 为准**（`count = 1`）；「角色管理」里看到「操作人员」只作参考。**不要用**备料工作台「成员与权限」页核对：那个页面受 `STOCK_PREP_MEMBERS_PAGE_ENABLED` 开关控制（`packages/core-backend/src/services/stock-preparation-members.ts:282`，关闭时接口 404，:639），演示机上没开；就算开着，页面上的「操作人员」也是按角色 id 写死的标签（`apps/web/src/components/integration/stockPreparation/StockPreparationMembersView.vue:374-382` 的 `BUILT_IN_LABELS`），改名被跳过时照样显示。SQL 得 0 时：按完整升级日志里 `NOT renamed …` / `does not carry the expected display name` 的原因由 owner 处理，再在角色管理里手工改名，改完重跑这条 SQL。
3. 用一个原旧角色成员登录：备料页面、确认队列、记录送审与搬迁前一致；考勤侧（能看到 / 能排班 / 能导出 / 能审批的人员范围、自己的工作日历）与搬迁前一致；考勤「审批流程」各步的审批角色不含 `stock-prep-operator`（否则新申请无人能批），且按第 1 步第 4 项 owner 的决定处理过 `stock-prep_frontline` / `approvals_operator`。第 1 步第 4 项若有命中且 owner 决定改配置，这里核对改后的结果；钉钉同步的「成员组默认业务角色」已不含 `stock-prep-operator`（或 owner 已决定保留）。
4. 第 2 步的 `approval designer — …` 计数大于 0 时：核对第 3 步末尾的改指向已完成并重新发布（重跑一次 dry-run，两行 `approval designer — …` 的计数应为 0）。第 2 步的 `approval template visibility — …` 计数在搬迁前已处理（见第 2 步）。
5. 之后再按 ADR §8 第 6 步把 `stock-prep_frontline` 写进 G1 角色清单（`app.env` 的键，见第 1 步第 2 项）。

## 6. 回退须知

1. **脚本不写审计行。** `--apply` 成功后**立即**、在任何人编辑之前，记下 `approvals_operator` 的成员名单：在「角色管理」里打开该角色看成员列表，或只读查询 `SELECT user_id FROM user_roles WHERE role_id = 'approvals_operator' ORDER BY user_id`。拆分后它的成员恰好是原旧角色 `stock-prep-operator` 的全部成员，这是事后**唯一**的名单（旧角色此时已没有成员）。名单只记在私有记录里，不贴进 issue / PR。
2. **不要执行 R65 迁移 `zzzz20261010120000_add_approval_write_act_template_manage_permissions` 的 `down()`**：它删掉**所有**角色和用户上的 `approvals:write`（以及 `approvals:act`、`approval-templates:manage`）授权，包括拆出角色上的——一线会失去记录送审。
3. 回退到 R65 或 R64 安装包时**只能带 `-RunMigrations 0`**；回退不靠任何迁移的 `down()`（旧包不认识新迁移，别手工去跑它们的 `down()`）。改名迁移的 `down()` 只把「操作人员」比较后改回「一线填写」，不必为回退去跑它。
4. 要撤销搬迁本身没有脚本：按第 1 项的名单在角色管理里手工处理，由 owner 决定。
