# 宜搭发料确认日期回写：打开开关前的核对（Y9）

> **用途**：设计基线 v2.3 §7.3（D5 / D9 / D13 a）的「发料确认日期回写」在 #6812 接线后由开关 `INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED` 控制，默认关闭。本页只列打开这个开关之前必须核对的几条；**打开开关会写客户生产备料表的「发料确认日期」列，属 O 层，由 owner 单独批准并亲自操作**。Claude 不设置、不建议代为设置、不远程操作这个开关。
> **values-free**：回报只写 True/False、行数与面板上显示的结果类别 / 错误码；不抄项目号、业务键、记录号或任何字段内容。

## 打开开关之前

1. **先给 owner 授予经角色的操作档位，再打开开关（不可颠倒）。** 回写在租约内对每一行重新核对 owner 的权限（D13 a）：只认**经角色授予**的 `stock-prep:admin`，或同时经角色授予 `stock-prep:operate` 与 `stock-prep:read`（`packages/core-backend/src/integration/yida-issue-confirm-writeback-authority.ts:51-54`）。直接写进 `user_permissions` 的授权、`role:admin`、`integration:admin` 都不算。
   **后果（写明）：开关打开而 owner 没有这一档位时，每一条已确认（acknowledged）的发送都会得到一条永久的 `permission_revoked` 留痕**（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:431`），留痕表只追加、不能改删，以后的运行都不会再回写这些行的日期（一次运行读行时已有留痕就不选这一行；读行之后才被另一次运行留痕的，在租约内补丁前复查留痕时被拦下，结果为跳过 `already_traced`）。所以必须先授予档位、确认生效，再打开开关。
2. **目标清单**：`INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS` 只列发料确认表对应的宜搭目标；空或格式不对 = 不回写任何行（不是报错）。
3. **项目备料表开关**：`MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 也须为 `true`，否则每行只得到跳过 `project_sheets_disabled`，不写、不留痕，该开关打开后再次判定（`plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs:32-35`）。
4. **只认原文 `true`**：小写、不加引号、不加空格；`TRUE`、`1`、` true` 都算关。

## 打开之后

- 回写在发送**返回结果之后**单独运行（D5 a）：发送结果不等它、也不反映它的结果；它失败或被关停打断时，发送结果不变，服务器日志只留一条固定码 `YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED`（不含任何编号或内容）；可重试的行不留痕，由下面的补写入口补上。
- 漏掉的日期由 owner 的补写入口补上：`POST /api/integration/yida-owner-send/issue-confirm-writeback`（`packages/core-backend/src/routes/integration-yida-owner.ts:486`），写入的是确认审计那一天的本地日期，不是补写当天。
- 补写入口不带 `ledgerIds` 时，一次请求是「扫一遍」中的一页（至多 100 行）：第一次不带 `after`，之后把回答里的 `next` 原样作为 `after` 传回，直到 `next` 为 null 才算扫完一遍（`next` 为 null 必定已扫完；最后一页可能为空）。一直 retryable 或缺确认审计（`acknowledgement_missing`）的行不留痕，在这一遍里留在游标后面、不挡后面的行，只在下一遍从头开始时再试。游标的拒绝：篡改的游标、或指向不在当前清单里的目标的游标，得 400（`YIDA_OWNER_RUNTIME_INPUT`；与 `ledgerIds` 同传、字符或长度不对，在路由就得 `YIDA_OWNER_HTTP_INPUT`）；目标清单变了（增、删或调换顺序）之后，旧游标得 409 `YIDA_ISSUE_CONFIRM_CURSOR_STALE`，意思是目标集合变了，要不带 `after` 从头重扫；格式正确、目标在当前清单里的游标只移动起点。被拒时回写端口什么都不读（主机的 owner 在线核验已先跑过）。一遍不是快照：游标走过之后才确认的行，要到下一遍从头开始才取到。定期补跑以「一遍」为单位；是否定期补跑、由谁跑、多久一次是 owner 事项（O 层②）。
- 两次运行重叠（例如 ACK 后运行与补写入口同时处理同一行）：留痕在租约释放前写入，补丁前在租约内再查一次留痕；读行之后才被另一次运行留痕的行，结果为跳过 `already_traced`，不补丁、不留痕。补丁成功而留痕写入失败时，这次运行整体失败（不报 written）；下一次持租约的运行看到单元格已有日期，记 `already_set`。进程在补丁和留痕之间被杀时，它的租约要等过期或被接管才释放，此前的补写都是可重试的 `STOCK_PREP_PROJECT_WRITE_LOCKED`。
- 关回：把开关改回 `false` 并重启后端；已写入的日期与留痕保持不变。
