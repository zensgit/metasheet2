# 审批 MVP 第一波环境验收清单

> 日期: 2026-04-11
> 基线: `origin/main` @ `063d1543b`
> 目标: 承接 `approval-mvp-wave1-verification-report-20260411.md` 中剩余的 6 个环境型 `BLOCKED` 项
> 范围: 只做真实环境验收，不新增 Wave 1 核心代码

---

## 1. 背景

截至 `2026-04-11`，审批 Wave 1 的代码、契约、文档和自动化测试已经进入 `main`。
当前剩余风险不在本地实现，而在真实权限环境与真实集成环境。

本清单用于把以下 6 个 `BLOCKED` 项转成可执行任务：

- `BL1` 模板权限真实账号验证
- `BL2` 发起权限真实账号验证
- `BL3` 无权限用户拒绝访问验证
- `BL4` 只读用户可看不可操作验证
- `BL5` PLM 真实环境兼容回归
- `BL6` 考勤插件真实环境兼容回归

---

## 2. 账号与环境矩阵

最少准备 5 类账号或等价 JWT：

| 代号 | 最低权限 | 用途 |
|------|----------|------|
| `acct_manage` | `approval-templates:manage` | 模板创建 / 编辑 / 发布正向验证 |
| `acct_write` | `approvals:write` | 发起审批正向验证 |
| `acct_act` | `approvals:act` | 审批动作正向验证 |
| `acct_read` | `approvals:read` | 只读边界验证 |
| `acct_none` | 无审批权限 | deny-by-default 验证 |

环境前置：

- 已部署最新 `main`，包含 `#828` 之后的审批文档与契约描述
- PostgreSQL / Redis / plugin loader 处于正常状态
- PLM 测试环境可用，且 PLM federation 配置完整
- 考勤插件已启用，且能正常触发审批写入路径
- 至少 1 个 `published` 审批模板存在，便于发起/详情/动作验证

建议统一记录：

- 执行人
- 执行时间
- 使用账号
- URL / API 路径
- 响应截图或日志
- 最终结论 `PASS / FAIL / BLOCKED`

---

## 3. 执行记录表

| ID | 项目 | 负责人 | 状态 | 证据链接/说明 |
|----|------|--------|------|---------------|
| BL1 | 模板权限真实账号验证 |  | `TODO` |  |
| BL2 | 发起权限真实账号验证 |  | `TODO` |  |
| BL3 | 无权限用户拒绝访问验证 |  | `TODO` |  |
| BL4 | 只读用户可看不可操作验证 |  | `TODO` |  |
| BL5 | PLM 真实环境兼容回归 |  | `TODO` |  |
| BL6 | 考勤插件真实环境兼容回归 |  | `TODO` |  |

---

## 4. 逐项清单

### BL1 模板权限真实账号验证

目标：

- 证明缺少 `approval-templates:manage` 的真实用户不能创建/编辑/发布模板
- 证明具备 `approval-templates:manage` 的真实用户可以完成上述操作

执行步骤：

1. 使用 `acct_none` 或 `acct_read` 打开模板中心 `/approval-templates`
2. 尝试创建模板，或直接调用模板创建接口
3. 记录返回结果
4. 使用 `acct_manage` 重复模板创建 / 编辑 / 发布
5. 记录成功结果与生成的模板/版本 ID

预期结果：

- 非 `approval-templates:manage` 用户收到 `403`
- `acct_manage` 可以成功创建、编辑并发布模板

建议证据：

- UI 截图
- `POST /api/approval-templates`
- `PATCH /api/approval-templates/{id}`
- `POST /api/approval-templates/{id}/publish`

---

### BL2 发起权限真实账号验证

目标：

- 证明缺少 `approvals:write` 的真实用户不能发起审批
- 证明具备 `approvals:write` 的真实用户可以发起审批并进入详情页

执行步骤：

1. 用 `acct_read` 或 `acct_none` 打开已发布模板详情
2. 尝试点击“发起审批”或直接调用 `POST /api/approvals`
3. 记录返回结果
4. 用 `acct_write` 对同一模板提交合法表单
5. 记录返回的 `approvalId`、`requestNo`、详情页跳转

预期结果：

- 无 `approvals:write` 用户收到 `403`
- `acct_write` 成功发起审批，返回 `201`
- 返回体包含 `requestNo`、`templateId`、`templateVersionId`

建议证据：

- 提交前表单截图
- `POST /api/approvals` 响应
- 详情页 `/approvals/:id` 截图

---

### BL3 无权限用户拒绝访问验证

目标：

- 证明无审批权限用户对审批中心、审批详情、模板中心均走 deny-by-default

执行步骤：

1. 使用 `acct_none` 访问 `/approvals`
2. 使用 `acct_none` 访问一个已知审批详情 `/approvals/:id`
3. 使用 `acct_none` 访问 `/approval-templates`
4. 如有必要，直接调用对应 API

预期结果：

- 页面级访问被拒绝或重定向到无权提示
- API 访问返回 `403`

建议证据：

- `/api/approvals`
- `/api/approvals/{id}`
- `/api/approval-templates`

---

### BL4 只读用户可看不可操作验证

目标：

- 证明 `approvals:read` 用户可以查看列表与详情
- 证明 `approvals:read` 用户不能发起审批，也不能执行 `approve/reject/transfer/revoke/comment`

执行步骤：

1. 使用 `acct_read` 打开审批中心 `/approvals`
2. 打开一个审批详情 `/approvals/:id`
3. 确认列表、详情、历史都可见
4. 尝试触发发起审批
5. 尝试执行统一 action 接口

预期结果：

- 列表和详情访问成功
- 动作按钮隐藏，或 API 返回 `403`
- 发起审批返回 `403`

建议证据：

- `/api/approvals`
- `/api/approvals/{id}`
- `/api/approvals/{id}/actions`
- 模板详情或发起入口截图

---

### BL5 PLM 真实环境兼容回归

目标：

- 证明审批 Wave 1 落地后，PLM 真实环境主链路未被破坏

执行步骤：

1. 在真实 PLM 测试环境打开 PLM 相关页面
2. 调用一次 federation 读路径，确认 PLM adapter 正常返回
3. 如环境中存在 PLM 审批桥接链路，执行一次详情读取或动作闭环
4. 记录请求链路和结果

最低验收项：

- PLM 页面可访问
- `GET/POST /api/federation/plm/...` 正常
- 不因审批 Wave 1 的运行时改动导致 `500` / schema drift / permission drift

建议证据：

- PLM 页面截图
- federation 请求响应
- 如适用，PLM bridge 请求日志

---

### BL6 考勤插件真实环境兼容回归

目标：

- 证明审批 Wave 1 落地后，考勤插件现有审批相关路径仍然可运行

执行步骤：

1. 在真实环境打开考勤相关入口
2. 触发一次会写入审批实例或调用审批桥接的动作
3. 确认插件侧功能完成，且审批相关记录写入正常
4. 检查是否出现 `approval_instances` 写入异常或 schema 不兼容

最低验收项：

- 考勤入口可访问
- 相关审批/桥接路径不报错
- 插件主链路无回归

建议证据：

- 考勤页面截图
- 插件日志 / 后端日志
- 如适用，审批实例 ID 或历史记录

---

## 5. 退出条件

本清单完成的判定标准：

- `BL1-BL6` 全部从 `TODO` 变为 `PASS`、`FAIL` 或明确的 `BLOCKED`
- 每一项都附带可回看的证据
- 若存在 `FAIL`，必须附带问题定位与建议后续动作
- 若存在新的环境阻塞，必须单独编号，不覆盖原 6 项

---

## 6. 推荐执行顺序

建议先做权限矩阵，再做跨系统兼容：

1. `BL1`
2. `BL2`
3. `BL3`
4. `BL4`
5. `BL5`
6. `BL6`

原因：

- `BL1-BL4` 更基础，执行成本更低
- `BL5-BL6` 依赖外部系统与插件环境，适合在权限边界确认后进行

---

## 7. 关联文档

- [approval-mvp-wave1-verification-report-20260411.md](./approval-mvp-wave1-verification-report-20260411.md)
- [approval-mvp-wave1-execution-runbook-20260411.md](./approval-mvp-wave1-execution-runbook-20260411.md)
- [approval-mvp-wave1-acceptance-checklist-20260411.md](./approval-mvp-wave1-acceptance-checklist-20260411.md)
