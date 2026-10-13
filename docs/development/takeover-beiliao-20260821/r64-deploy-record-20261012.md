# R63 / R64 上机记录（2026-10-10、2026-10-12，旧机/运维机）

> values-free：不含主机地址、口令、令牌、项目号、账号名；只指位置与计数。承接 `r62-deploy-record-20261007.md`。打包与放行帖见 #6079（R63 打包帖、R64 打包帖、R64 放行交接帖）。

## 0. 先说与交接帖的差异

开发机的 R64 放行交接帖按「演示机仍在 R62、R62 → R64 直上、8 条迁移、429 → 437」写。实际情况：**R63 已于 2026-10-10 12:26 由旧机上机**（owner 在旧机会话里说「R63 已出，请帮我部署」），所以 R64 是 **R63 → R64、2 条迁移、435 → 437**。R63 打包帖要求上机后手建 `stock-prep_puller`，旧机上 R63 时那条帖子晚一分钟才到、没有看到，因此没有手建；R64 的种子迁移因此**新建**了它（不是 adopted），结果与「R62 直上」路径相同。教训（双向）：旧机上机前、开发机写打包 / 放行 / 交接帖前，都先刷一遍 #6079 最新帖。这次写错前提的是开发机的交接帖——它漏看了 4.5 小时前（04:27Z）的 R63 已上机帖 6093759460。

## 1. R63（2026-10-10 12:23–12:26 演示机时间）

| 项 | 值 |
|---|---|
| 包 | `20c705add`（tag `onprem-r63`，R62 之后 45 个 first-parent 提交），打包运行 38020874307；zip sha256 本机计算 = sidecar = SHA256SUMS（后与打包帖公布值一致），`gitSha` = tag |
| 放行条件 | tag 上完整 `plugin-tests.yml` 运行 38020876907 success 后才上 |
| 上机前只读 | 8 个新关系名都不存在、`kysely_migration` 429、`stock-prep:pull` 不存在、`tasks` 存在（`task_comments` 外键目标）、088 新 CHECK 与现有审计行兼容（不在列表的 0 行）、分区 10/11 月在 |
| 迁移 | 6 条：087（项目登记表）、088（审计动作 CHECK 重列）、`task_comments`、`approval_form_drafts`、`stock-prep:pull` 权限码、`stock-prep:admin` 描述 CAS；SQL 目录迁移与 kysely 迁移同一账本，429 → 435 |
| 升级 | 维护门 WIRED；#6071 回退路径（第 8 次探测应答）；远端 PowerShell 错误 0 |
| 验证 | 后端/nginx 200、web smoke PASS（`index-B6CE84B_.js`）、`Loaded 1 data sources`、dist 标记 9/9、新表 3 张 0 行、`stock-prep:pull` 码在且无绑定、审计 CHECK 含新动作；`app.env` 未改，未写新开关 |
| 行为变化（无开关，R-33 / #6264） | 上机起只有平台管理员、`stock-prep:admin`、`integration:*`，以及同时持 `stock-prep:pull` + `operate` + `read` 的人能从 PLM 拉取（R63 时没有人持有 pull；R64 的 `stock-prep_puller` 分配出去后，被分配的人就属于这一类）；一线只填报/确认/导出 |
| 备份 | `pre-r63-20261010-122301.dump`（3.24 MB） |

## 2. R64（2026-10-12 08:21–08:24 演示机时间；owner 在旧机会话回「可以」）

| 项 | 值 |
|---|---|
| 包 | `c5a2d85bc`（tag `onprem-r64`，R63 之后 8 个 first-parent 提交），打包运行 38036324770；zip sha256 = 打包帖公布值 = 本机计算；`gitSha` = tag；tag 上完整 CI 38036326658 ✅ |
| 上机前只读 | 26 个新关系名都不存在（8 张任务 M4 表 + 种子账本表 + 17 个索引/唯一约束）、`tasks.remind_at` 不存在、R64 迁移记录 0、`kysely_migration` 435；四个内置角色 id 在 `roles` / `user_roles` / `role_permissions` 都没有行（无孤儿）；定时拉取服务账号是平台管理员；分区在 |
| 迁移 | 2 条：任务 M4 建表、内置角色种子；435 → **437** |
| 角色 | `stock-prep_admin`（admin）、`stock-prep_puller`（read + operate + pull）、`stock-prep_developer`（read）、`stock-prep_frontline`（read + operate）全部新建、零成员；种子账本 4 行；无 `NOT created`；原一线角色 `stock-prep-operator` 未动（未跑迁名脚本、未加 pull） |
| 升级 | 维护门 WIRED；#6071 回退路径（第 8 次探测应答）；远端 PowerShell 错误 0 |
| 验证 | 后端/nginx 200、web smoke PASS（`index-BpcGWPiZ.js`）、`Loaded 1 data sources`、dist 标记 7/7、任务 M4 新表 0 行、客户两表行数上机前后一致；`app.env` 未改，未写新开关 |
| 备份 | `pre-r64-20261012-082118.dump`（3.25 MB，`pg_restore -l` 可读） |
| 界面回归 | 2026-10-12 08:30（演示机时间，owner 管理员会话，入口已核为 `index-BpcGWPiZ.js`），六项全过：① 角色管理可见四个内置角色，原 `stock-prep-operator` 仍在；② 考勤设置页原处是提示卡和「前往节假日」；③ 节假日页有「有效日历覆盖规则」；④ 备料首页和看板没有总览，也没有项目表行，`…/projects/:no/target` 回 404 `STOCK_PREPARATION_PROJECT_SHEETS_DISABLED`（开关关）；⑤ 顶栏没有「任务」，页面不发 `/api/tasks`；⑥ 除④那条有意的 404 外没有 4xx/5xx。见 #6079 帖 6115635629 |

> **2026-10-13 订正（演示机现状）**：旧一线角色 `stock-prep-operator` 已于 2026-10-13 在演示机上删除；一线角色现为「操作人员」（`stock-prep_frontline`）+「审批与提交」（`approvals_operator`），见 `runbook-operator-merge-20261012.md`「执行记录」。

## 3. 两次都刻意未做

- 上机后不触发定时试拉：客户 PLM 测试库自 10-08 起拒绝只读账号登录（`ELOGIN`，R62 已排除），owner 10-08 定「期间不主动探测 PLM」。
- 不写任何新开关（一项目一表、任务、审批红点、云课堂均关）。

## 4. 观察（非我们所为）

10-08 约 10:00，一个管理员账号经界面删除了客户主表 500 行、确认账本 7 行（在「历史 → 已删除的记录」中可恢复）；同日 09:15 新建了一个管理员账号。客户主表现 742 行。

## 5. 待办

- `stock-prep_puller` 分配给谁由 owner 定；在此之前管理员照常拉取，一线拉取 403（有意）。
- R64 界面回归已于 08:30 做完、六项全过（见 §2）。同次发现 **#6344**：考勤管理中心对没有邮箱的账号报 `null.trim`。这个问题 R62 起就有，演示机上第一次出现无邮箱用户才暴露，不是 R64 回归，待修。
- 未做：一线、拉取人员两个身份的拉取验收（拉取人员角色还没分配；PLM 登录仍被拒，期间不主动探测）。
- 告知考勤管理员：「有效日历覆盖规则」已搬到节假日页。
- 脚本：运维机 `metasheet-ops/releases/r63/`、`r64/`（wrapper 预检分别钉 8 / 26 个关系名，R64 另钉四个角色 id 无孤儿行；上机后不触发定时试拉）。回退口径：R63 包 `-RunMigrations 0`。
