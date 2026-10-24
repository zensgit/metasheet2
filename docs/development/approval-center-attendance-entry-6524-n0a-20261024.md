# 审批中心考勤入口错链 · 短期修法（#6524 N0-a）设计与验证

日期：2026-10-24 · 分支：`claude/n0a-6524-attendance-pending-entry`（起点 `fdb30a671686`）· 登记：决策登记册 R-56

## 1 问题

审批中心「待我处理」顶部有一张「考勤审批」蓝条，按钮写「待处理考勤审批」。点它以后落到考勤模块的补卡**发起**页（员工自己填写漏打卡并提交），不是审批人的待审列表。蓝条文字还写着考勤审批「不计入平台/PLM 待办列表」。

读代码核实（基线 `fdb30a671686`）：

- 考勤申请一提交，就写一条审批实例（`workflowKey = attendance.request`，来源为平台）和对应的待办分配，没有开关。
- 「待我处理」列表与待办数都按待办分配取数，考勤实例和其他平台实例一样在里面。所以蓝条原文不对。
- 原按钮只在**当前已加载的一页**里找考勤行；找不到就带着空的申请编号跳到考勤模块，落到的就是发起页。这正是 issue 里看到的现象。
- 后端列表接口 `GET /api/approvals` 早已支持 `workflowKey` 过滤，并按同一查询条件返回总数 `total`。所以本步只改前端。

## 2 本步做什么（范围）

只改前端三个文件：`ApprovalCenterView.vue`、`approvalCenterLabels.ts`、`approvals/api.ts`。

1. 入口不再跳到考勤模块。点按钮后，审批中心自己的「待我处理」列表只显示考勤申请（列表请求加 `workflowKey=attendance.request`），其他筛选条件重置，只重新加载一次。旁边出现「显示全部待办」，点它回到完整列表。以下情况也会退出这个视图：切换页签；在考勤视图里另设了筛选后点「清空筛选」（进入考勤视图时其他筛选已重置，那时「清空筛选」不可点）；列表地址的查询参数变化（例如从看板深链进入）。在考勤视图里「导出 CSV」导出的也是考勤行，与「导出当前所见」一致。
2. 蓝条按事实改写：「待我处理」已包含轮到你审批的考勤申请（如补卡、请假、加班），也计入待办数；点开其中一行会转到考勤模块；发起考勤申请请到考勤模块。
3. 按钮显示「考勤待审 N」。N 来自同一个待处理列表查询按 `workflowKey=attendance.request` 过滤后的 `total`（第 1 页、每页 1 条），与当前分页无关，也不会超出本人列表本来就能看到的范围。
4. 按钮不可用的三种情况，都在旁边写明原因：
   - 正在获取数量：「正在获取考勤待审数量…」；
   - 没有待审：「目前没有轮到你审批的考勤申请。」；
   - 数量取不到（例如无权读取或网络失败）：「暂时无法获取考勤待审数量，请稍后刷新页面再试。」，此时不显示任何数字。
5. 点某一行仍沿用现有行为：进入考勤模块里这张申请（带申请编号）。不新增、不放宽任何权限；数量与行都走本人已有的列表读取权限。
6. 新文案中英文都有（中文在 `CENTER_ZH`，英文在 `CENTER_EN`，两表键一致；带数字的按钮文字按文件惯例写在视图里）。

不改后端、不改表结构、不改待办查询本身（只用列表接口已有的过滤参数）、不新增接口。

## 3 不做的事

- 考勤侧新建「待我审批」列表（审批人侧的初审列表）。
- 「当前审批人可读该单」的窄改（进入考勤详情的读权保持现状）。
- 在审批中心直接办理考勤申请。
- 默认审批目录建设。
- 考勤默认规则 / 时区未配好时禁用入口：审批中心今天拿不到这个信号，本步不为它新增接口（见 §4 第 3 条）。核查依据：这类提示只出现在考勤模块自己的页面与错误码映射里（`apps/web/src/views/attendance/attendanceTimezoneError.ts`、`AttendanceView.vue`）；对应接口是 `/api/attendance/rules/me`（要 `attendance:read`）与 `/api/attendance/settings`（要 `attendance:admin`）；`apps/web/src/views/approval/` 与 `apps/web/src/approvals/` 下没有任何考勤规则或设置的读取。审批中心要拿这个信号，就得跨到考勤侧的权限码，所以本步不做。

以上属后续步骤，随后续开工登记另裁。

## 4 验收（对应 issue 的验收项）

| issue 验收 | 本步结果 |
|---|---|
| 第 1 条：入口不再打开补卡发起表单 | 做到。按钮只筛选审批中心自己的列表，代码里不再有从这个按钮跳到考勤模块的路径。 |
| 第 2 条：审批人能看到待审列表或明确空态；发起人路径文案不暗示「待处理」 | 部分做到。审批人能在审批中心看到考勤待审的行和数量；没有待审时按钮不可用并写明原因；按钮不再叫「待处理考勤审批」，蓝条另写了发起去考勤模块。考勤侧的审批人列表不在本步。 |
| 第 3 条：规则未配置时入口不可用或有阻断说明 | 按本入口做到：入口不再通往发起表单，所以规则未配置时也不会把人带进发起页。审批中心拿不到规则 / 时区信号，所以没有按这个信号禁用；考勤模块自己的提示不变。 |
| 第 4 条：截图 / 录屏不含内网地址 | 本步没有新截图。执行主机上的验证截图按同一要求处理。 |

## 5 测试清单与执行状态

视图的新测试都在 `apps/web/tests/approval-center.spec.ts` 的 `attendance pending entry (#6524 N0-a)` 组里；门审后另在 `approvalApiErrorSurfacing.spec.ts` 加了一条、在 `approval-store-detail-generation.spec.ts` 加了两条（见表末）。三个文件都已在必需 web 测试脚本与 approval-web-guard 里（令牌 `approval-center`、`approvalApiErrorSurfacing`、`approval-store-detail-generation`），不需要另行登记。原来两条断言「跳到考勤模块」的旧测试已删除（它们断言的正是这个缺陷）。

| # | 测试 | 在 `fdb30a671686` 上（读代码推演） | 在本分支上（预期） |
|---|---|---|---|
| 1 | 「考勤待审 N」读过滤查询的总数，不读当前页（页上没有考勤行、总数 7） | 红：基线从不调用列表过滤查询 | 绿 |
| 2 | 页上 2 行、总数 12，显示 12 | 红：基线没有该按钮 | 绿 |
| 3 | 页上有考勤行时点击也不跳转；只重新加载一次、带过滤、筛选重置 | 红：基线点击后跳到考勤模块 | 绿 |
| 4 | 页上没有考勤行时点击（issue 原样）不跳转 | 红：基线跳到考勤模块、不带申请编号 | 绿 |
| 5 | 「显示全部待办」退出并重新加载完整列表 | 红：基线没有该按钮 | 绿 |
| 6 | 切换页签退出考勤视图 | 红：基线没有该视图 | 绿 |
| 7 | 没有待审：按钮不可用并写明原因，点击无反应 | 红：基线按钮总是可点 | 绿 |
| 8 | 数量取不到：按钮不可用、写明原因、不显示数字、不跳转 | 红：基线按钮总是可点 | 绿 |
| 9 | 数量加载中：按钮不可用并写明原因 | 红：基线按钮总是可点 | 绿 |
| 10 | 中文蓝条说真话（不再写「不计入」） | 红：基线是旧文案 | 绿 |
| 11 | 英文蓝条与按钮、原因都是英文 | 红：基线是旧文案 | 绿 |
| 12 | 点考勤行仍进入这张考勤申请（不变） | 绿（非回归守护） | 绿 |
| 13 | 在考勤视图里另设筛选仍留在视图内；再点「清空筛选」退出 | 红：基线没有该按钮 | 绿 |
| 14 | 列表地址查询参数变化（深链）退出考勤视图 | 红：基线没有该按钮 | 绿 |
| 15 | 「正在只看考勤待审」提示是 `role="status"`、`aria-live="polite"` | 红：基线没有该按钮 | 绿 |
| 16 | 列表重载时保留上次的「考勤待审 N」、按钮仍可点 | 红：基线没有该按钮（在提交 `23447ecc35` 之前的本分支上也红：每次重载都先回到「正在获取」） | 绿 |
| 17 | `approvalApiErrorSurfacing`：`listApprovals` 把 `workflowKey`、`page=1`、`pageSize=1` 写进 `GET /api/approvals` 的查询串，同筛选的导出也带 `workflowKey` | 红：基线不写 `workflowKey` | 绿 |
| 18 | `approval-store-detail-generation`：`loadPending` 把 `workflowKey` 原样交给 `listApprovals`，并强制 `tab=pending` | 绿（非回归守护：store 本来就展开查询对象） | 绿 |
| 19 | 同上：不带 `workflowKey` 时请求里也没有这个键 | 绿（非回归守护） | 绿 |

第 13–16 条在组内排在第 6 条之后。第 2、5、6、13–16 条在基线上红，只是因为找不到新按钮或新提示，不是断言了旧行为。

执行状态：**本机未跑**（工作树没有依赖）。本机只做了语法检查：测试文件、`api.ts`、`approvalCenterLabels.ts` 与视图的 `<script setup>` 块都用 esbuild 解析通过。门审后改过的三个测试文件与视图 `<script setup>` 块也重新解析通过。`.vue` 模板本机无法编译，由执行主机上的测试验证。

执行主机上要跑的（在仓库根目录）：

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/approval-center.spec.ts
# 同一视图的其他用例（会挂载或扫描 ApprovalCenterView）
pnpm --filter @metasheet/web exec vitest run --watch=false approval-center approvalCenter approvalMobileResponsive cancelRoundEntryCenterRoute approval-e2e-permissions newTodoPill ui-foundation-style-guard uiFoundationTexture approval-ui-workspace templateCenterI18n templateDetailI18n platform-shell-nav
# 门审后新加测试所在的另两个文件
pnpm --filter @metasheet/web exec vitest run --watch=false approvalApiErrorSurfacing approval-store-detail-generation
# 红绿对照：在基线上只换入三个测试文件再跑一次，预期第 1–11、13–17 条红，第 12、18、19 条绿；其余用例与基线一致
bash apps/web/scripts/run-required-web-tests.sh
pnpm --filter @metasheet/web type-check
```

## 6 限制

- 进入考勤视图会清掉其他筛选条件，这是为了让列表里的行与「考勤待审 N」是同一批。
- 在考勤视图里再改其他筛选时，列表会在考勤范围内再筛，按钮上的 N 仍是考勤待审的总数。
- 「考勤待审 N」与列表行是同一条查询；它与顶部待办数不是同一条查询（待办数另有处理人节点排除）。今天的考勤申请两边数字一致。
- 数量在每次列表重新加载时刷新；页面闲置时的实时推送不单独刷新它。
- 撤销申请（另一种流程标识）不计入「考勤待审 N」，仍在完整的「待我处理」列表里。
- 点开考勤行以后能否看到详情，仍按考勤模块现有的读权；本步不改。
- 点行时带上的申请编号取自实例里的 `attendanceRequestId`。考勤实例从第一版起（#2071）就写这个字段，所以考勤视图里的行点开都会带上申请编号；本步没有改行点击的逻辑。若某条考勤实例缺申请编号（今天的写入路径不会），点行仍会落到考勤模块的申请区而不是那张申请；这是既有行为，归 N0-b。
