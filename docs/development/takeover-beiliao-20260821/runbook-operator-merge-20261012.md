# 运行手册：一线角色合并为「操作人员」（R65 上机，owner 2026-10-12）

> 依据：owner 2026-10-12 裁决「把 一线填写 及原一线角色（stock-prep-operator）合并，name 就用操作人员来替代」；ADR `adr-stock-prep-project-sheets-20261008` §8 第 3 步、§11.2-1；决策登记 R-39。
> **在任何服务器上运行脚本（含 dry-run）都是 owner 动作。** 本手册在老机器上执行；不含主机、地址、口令、项目号、用户 id——这些只在私有记录里。

## 0. 这次合并做什么

- 内置角色 `stock-prep_frontline` 的显示名随 R65 迁移 `zzzz20261012090000` 从「一线填写」改为「操作人员」，**角色 id 不变**。
- 旧一线角色 `stock-prep-operator` 的成员和以它为主体的表级授权行，用脚本 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 搬到 `stock-prep_frontline`。
- 旧角色上手工加的平台码（预计 `approvals:read`、`approvals:write`、`multitable:submit-approval`，以库里实际为准）**不进内置角色**；脚本的 `--split-extra-codes-to-role` 把它们放到单独的平台角色（推荐 id `approvals_operator`，默认显示名「审批与提交」），授给同一批成员（ADR §8 第 3 步方案 ①）。合并前后每个成员的**平台权限码**（RBAC 角色码、直授码、旧版码之并集）不变。**按角色 id 或显示名匹配人的其它配置不在脚本清点范围内**——考勤的调度权限（排班管理范围）、日历 / 节假日覆盖规则，钉钉同步的「成员组默认业务角色」等；这些在第 1 步由 owner 人工预检，合并后在第 5 步核对。
- 脚本**不改**审批模板；它只打印计数：有多少模板版本 / 已发布定义按 id 或显示名把旧角色写成审批人、办理人、兜底审批人、抄送对象或「提交人自选」的角色范围；有多少模板的「可见范围」是角色范围、搬迁后成员会看不到（失）或新看到（得）。这几类之外的引用（例如审批图里按发起人 `approval_usable` 角色走的 `requester.role` 条件分支）脚本**不清点**。

## 0.5 取得脚本（安装包里没有它）

R65 安装包**不含** `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs`（打包脚本 `scripts/ops/multitable-onprem-package-build.sh` 的必含文件清单里没有它）。上机前：

1. 从 R65 对应提交（或合入本手册所在 PR 修复轮之后的提交）取出这一个文件，例如在开发机上 `git show <提交>:scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs > stock-preparation-migrate-legacy-operator-role.mjs`；
2. 拷到服务器上**任意目录**（不必放进安装根目录）；
3. 之后各步的命令都用这个拷贝的路径，并带上 `--root <安装根目录>`。`--root` 只做两件事：从 `<安装根目录>/packages/core-backend` 加载 `pg`；`DATABASE_URL` 没设时从 `<安装根目录>/docker/app.env` 读取（不打印）。脚本本身只依赖 Node 内置模块和这个 `pg`。

下文命令里的 `node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 一律换成 `node <拷贝路径>`。

## 1. R65 升级之后：只读预检

1. 看升级日志里两条迁移行：
   - `zzzz20261010124500_seed_stock_prep_role_templates`（R64 已跑，本次不再出现属正常）；
   - `zzzz20261012090000_rename_stock_prep_frontline_display_name`：应为 `up: role stock-prep_frontline display name updated (1 row)`。如果是 `NOT renamed …` 或 `does not carry the expected display name; left as found`，记下原因（计数），合并照常可做，改名由现场在「角色管理」里手工处理（先确认日志里说的审批席位 / 抄送 / 角色范围的模板可见范围 / 审批模板版本或已发布定义里的角色引用 / 考勤调度权限或日历、节假日覆盖规则里的角色引用 / 同名角色）。改名迁移只查「一线填写」「操作人员」这两个名字；下面第 4 项的人工预检范围更大。
2. 在「角色管理」里确认 `stock-prep_frontline` 存在、只持有 `stock-prep:read` + `stock-prep:operate`，且**还没有**写进 G1 角色清单（`MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`）——G1 一旦给它写了表级授权，脚本的「凭空多得」检查会拒绝。
3. 确认没有人正在编辑角色、任命成员或改审批模板；约好维护窗口。
4. **owner 人工预检：按角色 id / 显示名匹配人的其它配置**（脚本不读这些，搬迁会让一线成员悄悄得到或失去它们）。要搜的值：旧角色 id `stock-prep-operator` 及它在「角色管理」里的显示名、`stock-prep_frontline`、「操作人员」、「一线填写」、`approvals_operator`、「审批与提交」（若用 `--split-role-name` 另起了名字，也搜那个名字）。考勤侧把角色 id 和显示名都当作角色和角色标签来匹配，比较时忽略首尾空格（日历 / 节假日覆盖规则还忽略大小写）。
   - 考勤「调度权限」（排班管理范围）：主体类型为角色 / 角色标签的记录的主体；以及每条记录的目标范围里的「角色」「角色标签」列表。命中意味着搬迁后一线成员会得到或失去对某批人的排班、导出他人考勤、审批他人考勤等权限，或者变成别人调度权限的目标。停用的记录也要看（重新启用就生效）。
   - 考勤「节假日覆盖规则」和「有效日历覆盖规则」：每条规则的角色 / 角色标签筛选。命中意味着一线成员会换一套工作日历。
   - 钉钉同步（目录管理）：每个集成的「成员组默认业务角色」。若含 `stock-prep-operator`，以后新同步进来的一线人员只会拿到旧角色——搬迁后旧角色没有码，他们拿不到审批与提交的码；先改成 `stock-prep_frontline` 加 `approvals_operator`（由 owner 定），再执行。
   命中任一项：先由 owner 决定改配置还是接受变化，再执行第 3 步。

## 2. dry-run（只读，不写任何东西）

```
node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs --root <安装根目录> --split-extra-codes-to-role approvals_operator
```

逐行核对输出（全是计数、角色 id、权限码，没有值）：

- `split: extra codes (on stock-prep-operator, not on stock-prep_frontline): N (…)`：这就是要拆出去的码，以库里实际为准；
- `split: role approvals_operator absent; …`，`split: delegable namespaces approvals_operator falls in: 0`；
- `dry run: --apply first does the split: create role approvals_operator with N code(s) …, add M member(s) …, remove those N code(s) …`；
- `dry run: --apply would move M membership(s) and K table grant(s)`；
- 审批席位 / 抄送、待接受邀请、`gains — …` 各行；
- 两行 `approval designer — …`：模板版本数与已发布定义数（第 5 步要用）。现在也数「提交人自选」节点里角色范围指名旧角色的情形——服务端按角色 id 校验这种范围，搬迁后旧角色没人，提交会被 422 拒绝；
- 两行 `approval template visibility — …`（只计数，不拒绝，脚本不改）：
  - `… visible through stock-prep-operator but not through stock-prep_frontline[ or approvals_operator] …: N; moved members would stop seeing them (记录送审)`：可见范围按角色 id 或显示名只指名了旧角色的模板。N 大于 0 时，**搬迁前**在审批模板的「可见范围」里把 `stock-prep_frontline`（或 `approvals_operator`）加进去，否则搬完后这些成员对这些模板发起记录送审会被拒绝（403）；
  - `… visible through stock-prep_frontline[ or approvals_operator] but not through stock-prep-operator …: N; moved members would newly see them`：可见范围指名了内置角色或拆出角色（按 id 或显示名，含「操作人员」「审批与提交」）的模板，搬迁后原旧角色成员会新看到。N 大于 0 时由 owner 判断是否可接受；不可接受就先收窄这些模板的可见范围再执行。

出现 `--apply would refuse: …` 就**停**，按提示处理后重跑 dry-run。常见的：
- `split: N of the extra code(s) are admin-level …`：旧角色上有管理级码，由平台管理员手工处理，不自动化；
- `split: role approvals_operator falls inside … namespace(s)` / `already exists and its codes are not exactly …`：换一个首段为 `approvals_` 或 `multitable_` 的 id；
- 旧角色仍被审批席位 / 抄送按 id 或显示名指名且有成员：成员会失去这些历史审批的读权限，由 owner 决定后再动。

## 3. owner 放行后：维护窗口里执行

```
node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs --root <安装根目录> --apply --split-extra-codes-to-role approvals_operator
```

- 退出码 0：输出里有 `apply: split — created role approvals_operator with N extra code(s), added M member(s) …, removed N code(s) …` 和 `apply: moved M membership(s) and K table grant(s); stock-prep-operator kept`。
- 退出码 2：拒绝，**什么都没写**（拆分阶段的拒绝会回滚到保存点）。按提示处理后从第 2 步重来。
- 退出码 1：执行失败（只报错误码），事务已回滚。
- 可重跑：第二次什么都不写。
- 成员的权限缓存最长 60 秒，刷新页面后生效。

## 4. 可选：删除已空的旧角色

```
node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs --root <安装根目录> --apply --delete-empty-old-role
```

只有旧角色已没有成员、没有任何 role 主体授权行、没有任何状态的角色审批席位、没有角色抄送记录、也没有指名它的待接受邀请时才删。**会拒绝的典型情形**：历史审批里仍有按旧角色 id 或显示名的席位或抄送记录——这些记录搬不走，删掉旧角色后若有人按同一 id 或显示名重建角色，就会读到这些审批；这时保留旧角色（它已没有成员和码之外的权限，不影响使用）。

## 5. 收尾核对

1. 「角色管理」：`stock-prep_frontline` 显示为「操作人员」，成员是原两个角色成员的并集；`approvals_operator`（「审批与提交」）持有拆出的码、成员是原旧角色成员；`stock-prep-operator` 已无成员（或已删除）。
2. 备料工作台「成员与权限」页：内置角色显示「操作人员」。
3. 用一个原旧角色成员登录：备料页面、确认队列、记录送审与搬迁前一致；考勤侧（能看到 / 能排班 / 能导出 / 能审批的人员范围、自己的工作日历）与搬迁前一致。第 1 步第 4 项若有命中且 owner 决定改配置，这里核对改后的结果；钉钉同步的「成员组默认业务角色」已不含 `stock-prep-operator`（或 owner 已决定保留）。
4. 第 2 步的 `approval designer — …` 计数大于 0 时：在审批设计器里把这些模板的审批人 / 抄送对象 / 「提交人自选」角色范围从旧角色改指向 `stock-prep_frontline`（或 `approvals_operator`，视该节点需要的权限），再重新发布；脚本不改审批模板。第 2 步的 `approval template visibility — …` 计数在搬迁前已处理（见第 2 步）。
5. 之后再按 ADR §8 第 6 步把 `stock-prep_frontline` 写进 G1 角色清单。
