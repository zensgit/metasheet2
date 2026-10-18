# R65 上机记录（2026-10-12，旧机/运维机）

> values-free：不含主机地址、口令、令牌、项目号、账号名；只指位置与计数。承接 `r64-deploy-record-20261012.md`。打包帖、上机帖与开发机回帖见 #6079（2026-10-12）。

> **2026-10-13 订正（演示机现状）**：旧一线角色 `stock-prep-operator` 已于 2026-10-13 在演示机上删除；一线角色现为「操作人员」（`stock-prep_frontline`）+「审批与提交」（`approvals_operator`），见 `runbook-operator-merge-20261012.md`「执行记录」。下文「原一线角色持有 `approvals:write`」「五个备料角色」描述的是 R65 当时的状态；该码现由 `approvals_operator` 持有。

## 0. 先说与打包帖的差异

打包帖 §4 按「三个审批权限码上机前目录 0 行、绑定 0 行」写。实际 **`approvals:write` 早已在目录里**，并且**由原一线角色 `stock-prep-operator` 持有 1 行**——一线提交审批要用它；按开发机回帖，`zzzz20260920130000` 迁移文件头写明刻意不登记该码，这一行是当初给一线开审批提交时手工加的。R65 迁移是 `ON CONFLICT DO NOTHING`，不碰这一行，只新增 `approvals:act` 与 `approval-templates:manage`。上机脚本据此改为「绑定恰为 1、上机前后不变」。

**回退口径**：R65 包回退只能用上一包 `-RunMigrations 0`；**绝不能执行这条迁移的 `down()`**——它会把三码的全部授予一起删掉，包括一线持有的 `approvals:write`，一线将无法提交审批。开发机已记下后续收窄该 `down()`。

## 1. R65（2026-10-12 14:00–14:03 演示机时间；owner 在旧机会话回「上」）

| 项 | 值 |
|---|---|
| 包 | `6d4e9fc38`（tag `onprem-r65`，R64 之后 35 个 first-parent 提交），打包运行 38200924101；zip sha256 = 打包帖公布值 = 本机计算；`gitSha` = tag；入口 `index-Cm3doSaC.js`；tag 上完整 CI 38200927521 ✅ 且两条备料检查绿 |
| 上机前只读 | `kysely_migration` 437、R65 迁移记录 0；三码在目录 1 行（见 §0）、绑定 1 行；四个内置备料角色在、零成员；分区在；数据源 1；客户两表行数记录；演示机时钟 = 库时钟 = 旧机，差 < 5 s |
| 开关 | `TASKS_ENABLED`、`TASKS_SCHEDULER_ENABLED`、`STOCK_PREP_MEMBERS_PAGE_ENABLED`、`ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED`、`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`、`INTEGRATION_YIDA_OWNER_SEND_ENABLED` 在 `app.env` 都未设；脚本把任一为精确 `true` 当作中止条件；上机不写任何开关 |
| 迁移 | 1 条（只加目录码）：437 → **438**；目录三码齐；绑定 1（不变）；内置角色 4 |
| 升级 | 维护门 WIRED；#6071 回退路径（第 7 次探测应答）；后端/nginx 200 |
| 验证 | web smoke PASS；`Loaded 1 data sources`；dist 标记 9/9（打包帖 §5 的九个标识符：迁移文件、加密存储探针、委派拒绝码、成员页关闭码、任务调度未启动、角色 id 校验码、打卡客户端时间戳拒绝码、备料路由失败码、前端「服务器时间不可用」文案） |
| 启动日志 | `Task scheduler not started` 2 行、`Task scheduler initialized` 0 行；`Encrypted store probe: 2 encrypted value(s) across 11 store field(s); 0 undecryptable`（9 月的就地重加密仍完好） |
| 备份 | `pre-r65-20261012-140005.dump`（3.28 MB，`pg_restore -l` 可读） |

## 2. 脚本为何报 SHIP FAILED

远端日志里恰有 1 条 PowerShell 错误记录，脚本据此判 FAILED。该错误是旧机**新加**的「读启动日志」检查把整份后端 out 日志（1.42 GB、从未轮转）读进内存导致 `OutOfMemoryException`；升级、迁移、健康、smoke 全部无错。启动日志改为只读末尾 8 MB 后补核通过（§1「启动日志」行）。上机脚本已改为只读尾部。

## 3. 界面回归（owner 管理员会话，对照打包帖 §6）

- 考勤首页：有「考勤时区」行、无「服务器时间不可用」；考勤管理中心不再报 `null.trim`（#6344 已修）。
- 角色管理：三个新码与五个备料角色可见；角色委派页有分配 / 撤销两组下拉。
- 顶栏无「任务」，`/tasks/settings` 回首页。
- 备料工作台：无「成员与权限」（成员接口按开关关回 404，预期）、无项目总览。
- 数据工厂：文案「K3 目标永久只读、不提供 Save-only 写回」。
- 未验：多维表框选工具条（构建期开关）、请假「申请撤销」入口（演示机无对应记录）。

## 4. 刻意未做

- 不触发定时试拉：客户 PLM 测试库自 10-08 起拒绝只读账号登录，owner 10-08 定「期间不主动探测 PLM」；每日 06:00 任务照常。
- 不跑一线角色迁名脚本（R66 / #6348 另议）。
- 不写任何开关。

## 5. 观察（交 owner / 开发机）

1. **后端日志不轮转**：`metasheet-backend.out-0.log` 已 1.42 GB。改不改、怎么改由 owner 定（pm2 日志轮转模块要演示机能出网取包；或计划任务定期归档）；owner 选定后开发机出 runbook。
2. **考勤时区显示 UTC**：演示机没有任何考勤规则，代码里考勤默认规则时区是 UTC（开发机指出 `plugins/plugin-attendance/index.cjs:66`），自助页无规则时不读考勤组时区（组是 Asia/Shanghai；5 条考勤记录 3 条存成 UTC、2 条 Asia/Shanghai）。不是 R65 回归，R65 只是显示出来。「无规则时跟随考勤组时区」归考勤线判断；演示机上要不要建一条 Asia/Shanghai 规则由 owner 定。
3. 考勤设置页「服务端运行开关」对平台管理员显示「此界面不展示」：打包帖说只有考勤管理员可见，属预期。

## 6. 待办

- owner：发送客户答复发送版；定 `stock-prep_puller` 分配；联系客户 DBA 恢复 PLM 只读登录（恢复后再核预检 / dry-run）；定日志轮转方案；定 R66 拆出角色 id（开发机推荐 `approvals_operator`）。
- 开发机：收窄 R65 迁移的 `down()`——已由 #6364 完成（`down()` 不再删任何授予，只删无绑定的目录行，有绑定的码连同授予保留）；R66（#6348）核验完转 ready；云课堂启用步骤另帖。收窄后的 `down()` 从重切的 R66 包（main 在 b7096129d 之后）起随包发出：只有 `onprem-r65` 包里仍是旧的级联 `down()`；第 9 行的规则（演示机绝不能执行这条迁移的 `down()`，回退 = 上一个包加 `-RunMigrations 0`）不论哪个包都照旧作为操作规则。
- 脚本：运维机 `metasheet-ops/releases/r65/`（wrapper 钉：迁移名、三码目录与绑定计数、六个开关非 `true`、九个 dist 标记、启动日志尾读）。
- 日志轮转（R66 维护窗口）：runbook 已出，见 `docs/development/takeover-beiliao-20260821/runbook-backend-log-rotation-20261012.md`。

## 7. 已知问题（开发机·审批线 2026-10-12 帖，R65 已含；owner「补」）

1. **审批新设计器里几类条件不生效**：演示机默认使用新设计器。以下写法发布、提交均不报错，但条件不会命中，单子走默认分支（未设默认分支时走第一条）：
   - 单选 / 多选字段新加的选项，按选项名称写的显示条件或分支条件；
   - 分支条件用「包含于」；
   - 多选字段配「等于 / 不等于」；
   - 按数值字段写的「等于 / 不等于 / 包含」。

   临时办法：配完条件后用模板「试运行」核对路线，先避开上述写法。

2. **从记录「送审」有两类模板会出问题**，应先从审批中心发起：
   - 模板带显示条件时，弹窗会显示本应隐藏的必填字段并要求填写，填进去的值会被服务端丢弃；
   - 模板任一节点配了「发起人自选」时，从记录送审必失败，只显示英文错误。

   一线角色持有提交审批的权限，一线账号也会碰到。

修复按登记册 R-43 例外先修、只开草稿，随 owner 点名的包上机。
