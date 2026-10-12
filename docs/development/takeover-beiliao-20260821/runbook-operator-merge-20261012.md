# 运行手册：一线角色合并为「操作人员」（R65 上机，owner 2026-10-12）

> 依据：owner 2026-10-12 裁决「把 一线填写 及原一线角色（stock-prep-operator）合并，name 就用操作人员来替代」；ADR `adr-stock-prep-project-sheets-20261008` §8 第 3 步、§11.2-1；决策登记 R-39。
> **在任何服务器上运行脚本（含 dry-run）都是 owner 动作。** 本手册在老机器上执行；不含主机、地址、口令、项目号、用户 id——这些只在私有记录里。

## 0. 这次合并做什么

- 内置角色 `stock-prep_frontline` 的显示名随 R65 迁移 `zzzz20261012090000` 从「一线填写」改为「操作人员」，**角色 id 不变**。
- 旧一线角色 `stock-prep-operator` 的成员和以它为主体的表级授权行，用脚本 `scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs` 搬到 `stock-prep_frontline`。
- 旧角色上手工加的平台码（预计 `approvals:read`、`approvals:write`、`multitable:submit-approval`，以库里实际为准）**不进内置角色**；脚本的 `--split-extra-codes-to-role` 把它们放到单独的平台角色（推荐 id `approvals_operator`，默认显示名「审批与提交」），授给同一批成员（ADR §8 第 3 步方案 ①）。合并前后每个成员的有效权限不变。
- 脚本**不改**审批模板；它只打印有多少模板版本 / 已发布定义按 id 或显示名把旧角色写成审批人、办理人、兜底审批人或抄送对象。

## 1. R65 升级之后：只读预检

1. 看升级日志里两条迁移行：
   - `zzzz20261010124500_seed_stock_prep_role_templates`（R64 已跑，本次不再出现属正常）；
   - `zzzz20261012090000_rename_stock_prep_frontline_display_name`：应为 `up: role stock-prep_frontline display name updated (1 row)`。如果是 `NOT renamed …` 或 `does not carry the expected display name; left as found`，记下原因（计数），合并照常可做，改名由现场在「角色管理」里手工处理（先确认日志里说的审批席位 / 抄送 / 同名角色）。
2. 在「角色管理」里确认 `stock-prep_frontline` 存在、只持有 `stock-prep:read` + `stock-prep:operate`，且**还没有**写进 G1 角色清单（`MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS`）——G1 一旦给它写了表级授权，脚本的「凭空多得」检查会拒绝。
3. 确认没有人正在编辑角色、任命成员或改审批模板；约好维护窗口。

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
- 两行 `approval designer — …`：模板版本数与已发布定义数（第 5 步要用）。

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
3. 用一个原旧角色成员登录：备料页面、确认队列、记录送审与搬迁前一致。
4. 第 2 步的 `approval designer — …` 计数大于 0 时：在审批设计器里把这些模板的审批人 / 抄送对象从旧角色改指向 `stock-prep_frontline`（或 `approvals_operator`，视该节点需要的权限），再重新发布；脚本不改审批模板。
5. 之后再按 ADR §8 第 6 步把 `stock-prep_frontline` 写进 G1 角色清单。
