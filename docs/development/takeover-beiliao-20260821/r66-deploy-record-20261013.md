# R66 上机记录（2026-10-13，旧机/运维机）

> values-free：不含主机地址、口令、令牌、项目号、账号名；只指位置与计数。承接 `r65-deploy-record-20261012.md`。打包帖（第二次重切）、上机帖、搬迁帖、回归帖、删角色帖、学员端帖见 #6079（2026-10-13）。

## 0. 包与差异

- 打包点 `e2345ab6b`（tag `onprem-r66`，R65 之后 16 个 first-parent 提交），CI run 38330028689；zip sha256 = 打包帖公布值 = 本机计算；`gitSha` = tag；入口 `index-UmTiTfEd.js`。
- 内容：#6358 前端 UUID 修复（非安全上下文回退）、#6348 一线角色并入「操作人员」、#6367 / #6368 审批线 R-43 两张（只改前端）、#6364 R65 迁移 `down()` 收窄（`up()` 字节不变）、#6342 任务徽标重连。无新开关。
- 上机脚本门禁：迁移清单按 git 重算 = 1 条；对 #6364 修改既有迁移文件的情况，只在「仅此一个文件、且 `up()` 字节不变」时放行（本机核过），否则中止。

## 1. 升级（2026-10-13 11:57–12:00 演示机时间；owner 在旧机会话回「上」）

| 项 | 值 |
|---|---|
| 上机前只读 | `kysely_migration` 438、R66 迁移 0；`stock-prep_frontline` 名恰为「一线填写」、0 成员；无角色叫「操作人员」（CAS 前提成立）；旧角色 1 成员 5 码、`approval_usable` 为假；六个新开关未设；云课堂 7 个开关在（试点）；分区在；磁盘余 155 GB |
| 迁移 | `zzzz20261012090000_rename_stock_prep_frontline_display_name` executed successfully；438 → **439**；改名生效（`SELECT count(*) FROM roles WHERE id='stock-prep_frontline' AND name=U&'\64CD\4F5C\4EBA\5458'` = 1） |
| 升级 | 维护门 WIRED；#6071 回退路径（第 8 次探测应答）；远端 PowerShell 错误 0；stderr 0 |
| 验证 | 后端/nginx 200；web smoke PASS；`Loaded 1 data sources`；打包帖 §4 七个标记全中；启动 `Task scheduler not started` 4 行 / initialized 0；`Encrypted store probe … 0 undecryptable` |
| 不变量 | 备料角色 5 个在；旧角色成员 1、内置一线 0；三审批码绑定仍 1；`approvals_operator` 尚不存在 |
| 备份 | `pre-r66-20261013-115710.dump`（3.28 MB） |

## 2. 日志归档（owner 10-12 裁决①；runbook `runbook-backend-log-rotation-20261012.md`）

脚本从打包点 `git archive` 取、`hash-object --no-filters` = 提交 blob、服务器端 SHA-256 = 本机；放在不会被清理的真实目录（不在升级 staging 目录里）。dry-run → `-Apply`：`err` 111 MB 与 `out` 1420 MB 改名进 `output\logs\archive`，`pm2 reloadLogs` 退出 0、活动日志重开（0 MB 起）；`-Register -Apply -At 03:30` 注册 `MetaSheet-LogRotate`（照抄宿主任务的账号与最高运行级别），Ready，下次 10-14。`keep=14`、`minSizeMB=64` 默认。

## 3. 一线搬迁（runbook `runbook-operator-merge-20261012.md`；owner 看 dry-run 后回 go）

- 脚本同样从打包点取、哈希核过；按 §0.6 `cmd /d /c … > log 2>&1` 落日志，首行 `OWNER ACTION (R-39)`。
- dry-run：无一条 `would refuse`；多出的码 3（`approvals:read` / `approvals:write` / `multitable:submit-approval`）→ 新建 `approvals_operator`「审批与提交」；搬 1 成员、1 表级授权；审批席位 / 抄送 / 邀请 / 活动任务 / 设计器引用 / 可见范围得失全 0；`approval_usable` 两角色皆假。手册 §1.4 人工预检项（`system_configs`、钉钉集成配置、考勤调度范围）只读扫过，无旧角色引用。
- `--apply --split-extra-codes-to-role approvals_operator` 退出 0：`created role approvals_operator with 3 extra code(s), added 1 member(s)`、`moved 1 membership(s) and 1 table grant(s)`。复核：`approvals_operator` 1 成员 3 码、「操作人员」1 成员 2 码、旧角色 0 成员 2 码；被搬成员同时持有两角色；再跑 dry-run `nothing to move`。
- owner 回「删」后 `--apply --delete-empty-old-role` 退出 0：脚本重核前置后 `stock-prep-operator deleted`；`roles` / `user_roles` / `role_permissions` 中该 id 0 行。

## 4. 界面回归（owner 管理员会话 + 一线测试账号会话）

- ⓪ UUID 修复实发：演示机地址（按 IP 的 HTTP）`isSecureContext=false`、`crypto.randomUUID` 为 undefined，「发布内容课程」→ 三个接口 201、页面「课程已发布并完成指派」；学员侧「打开并记录完成」→ `open` 200。无垫片。
- ① 角色管理显示「操作人员」「审批与提交」，不再出现「一线填写」；③ 顶栏无「任务」、`/tasks/settings` 回首页；④ 备料工作台无「成员与权限」、无总览（成员接口 404 = 开关关）。
- 一线账号：有效权限 = 搬迁前五码 + `elearning:read`；学习中心两门测试课可见；备料工作台四页签、项目 2 个；经工作台进客户主表网格 52 行可读（搬过来的表级授权）。
- ⑥⑦ 审批线两项未在演示机做（需先建带条件 / 发起人自选的模板），以审批线自己的浏览器 lane 为准。

## 5. 观察（交开发机判断）

- 一线会话里 `multitable/templates` 403、`comments/mention-summary` 与 `comments/unread-count` 403、`integration/stock-preparation/project-targets` 404（G1 开关关）——看起来与搬迁无关，是否既有行为请开发机判。
- 教师角色 `plugin_elearning_admin` 以 `_admin` 结尾，准入列表因此多出一个 `plugin_elearning` 命名空间（未开、未动）。
- Playwright 旧 tab 残留的 file chooser 会挡住页面脚本执行，开新 tab 即可（登录态在 localStorage 跟着走）。

## 6. 回退口径与待办

- 回退 = R65 包 `-RunMigrations 0`；不跑任何迁移 `down()`。角色改名 / 搬迁 / 删除不随包回退：需要时在角色管理里手工处理（旧角色只剩两个备料码，重建成本低）。
- 待办：客户答复发送（owner）；R66 之后文档里「一线填写」「备料一线操作员」「stock-prep-operator」措辞收口（开发机 #6376 已补一处）；日志归档 10-14 03:30 首次自动执行后看一眼 `archive\rotate-<日期>.log`。
- 脚本：运维机 `metasheet-ops/releases/r66/`（wrapper 钉 7 标记与改名 SQL；`tools/` 两个 owner 动作脚本 + `owner-actions-r66.ps1` 运行器）。
