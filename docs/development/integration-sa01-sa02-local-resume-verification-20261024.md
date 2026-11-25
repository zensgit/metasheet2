# SA-01/SA-02：本地恢复、设计与验证记录

日期：2026-10-24。范围仅为既有 #6323 / #6324；Claude 实现，Codex 独立审阅与复现。用户本次授权允许本地对齐、最小修复、合成验收，不授权推送、CI 触发、GitHub 合并、部署、客户读取或外部发送。#6337 继续封存。本记录不表示完整自助集成目标已经完成。

## 1. 固定对象与隔离方式

- 本轮 main 对齐锚：`771170234e95ff67c0b1d32b2e4929c08d7ee39e`。
- K3 原 PR：`1370b2d96f1e9edf0c36c322ac1156de0f02410f`；正确旧父为第二父 `1d37957705c6a16fb6885173e6645c2c068738a8`。
- 只移植两者净差量：33 文件，15 新增、18 修改，无迁移；避免再次携入已经 squash 合入 main 的旧宜搭层。
- PLM 原 PR：`8ff17b70554267bb2d34d5d67d588237bdfa6587`；应以 `1370b2d..8ff17b7` 的净差量接在新 K3 层之上，不盲目重放其中含 merge 的历史提交。
- 原 K3、PLM 检出均有未提交改动，本轮未修改它们。K3 在新建隔离 worktree 内进行。未更新任何公开分支。
- K3 修复的本地检查点：`0048067e178cc3fd4c1ccf3dc842ef9c1f6f2701`，仅用于保全已验证补丁。

## 2. K3 最小修复及模型来源

Codex 在原 K3 和 main `714c910` 上分别独立复现了同一个既有缺陷：BL2 物料 ID 允许有限数字，在通用输入归一化时先 `String()`，使 JavaScript 已经舍入的不安全整数变成合法十进制字符串。直接调用纯 key 校验器会拒绝该数字，但真实 prepare → execute → K3 adapter 链会查询舍入后的错误物料 ID。此问题不是 #6323 新引入，也不是写入或授权越界。

实际调用本机 Claude Code 2.1.310，使用 Sonnet、high effort；返回的 `modelUsage` 标识为 `claude-sonnet-5-5`。该调用禁用工具、浏览器、MCP 和会话持久化，仅根据提供的代码返回受限补丁。Claude 没有运行测试；以下验证均由 Codex 实际执行。本轮未声称调用 Grok、Kimi 或 Astra。

修复只在 `read-source-probe-runtime.cjs` 的 BL2 计划分支、`String()` 之前重用既有 `isBomListByMaterialKeyValid` 校验数字，拒绝不安全整数、负数及小数，沿用封闭错误原因 `key_required`。原有长十进制字符串和安全整数保留；其它业务 key 模式不收紧。没有新增端点、标志、凭据路径或权限。

新增测试覆盖两条共享运行时路径及实际注册 HTTP handler。运行时使用真实 prepare、execute 与 K3 adapter，仅替换 fetch；HTTP 使用真实注册表/配置 store/adapter 及内存数据库，**不声称覆盖 JWT middleware 或物理数据库事务**。负例在读取凭据、创建 adapter、调用模拟 K3 之前拒绝，配置和业务记录不变。正例确认安全整数、最大安全整数及精确长字符串进入预期固定 Filter。

## 3. K3 已完成的本地验证

对齐到本轮 main 后，以下 13 个完整插件入口通过：

```text
read-source-probe-runtime
read-source-read-runtime
read-source-bom-list-by-material-contract
read-source-bom-list-by-material-runtime
read-source-k3-material-list-b4-contract
k3-b4-http-source-run
stock-preparation-readonly-source-run
k3-wise-redirect-fence
k3-read-operation-profiles
k3-b4-response-contract
k3-b4-source-run
k3-wise-adapters
k3-external-write-permanent-fence
```

其中 HTTP 文件为 68/68，重定向 10/10，operation profiles 8/8，B4 响应 9/9，B4 source-run 14/14，永久写围栏 14/14，B4 配置合同 7/7。其它入口只有自身 OK 行，未虚构用例数量。

- 前端 7 个完整文件：361/361，无失败。文件为 `IntegrationK3B4RunPanel`、`IntegrationK3B4WorkbenchAccess`、`IntegrationK3Bl2RunPanel`、`IntegrationK3Bl2Services`、`IntegrationK3WorkbenchStartup`、`IntegrationReadSourceConfigPanel`、`IntegrationReadSourceWizard`。使用 1–2 workers；保留组件/路由 fixture 的警告，不以警告当作失败。
- WSL 的 `integration-guard-required-wiring-contract.test.mjs`：65/65。
- WSL 的 `sealed-export-package-provenance.test.cjs`：完整通过；被 pin 文件为 LF，未重打或绕过 pin。
- 仅在内存移除新增数字守卫：运行时新增负例以 Missing expected exception 失败；HTTP 新增负例以应为 400、实际为 200 失败。两者 exit 1，没有修改工作树生产守卫。
- `git diff --cached --check`：通过。
- 前端 `vue-tsc -b`：exit 0，零 TS 错误。

执行环境记录：隔离检出与主检出的 lockfile blob 相同（`14074139e16b386c23a120b8061b89e2d0c2b76d`），复用既有依赖目录的本地 junction，未安装依赖、未读取 env 文件。MSSQL 只读工具包在两个固定对象间无源差异。

保留的失败与修正：第一轮批量命令有三个猜测的不存在测试名，不作为产品失败或通过；随后按仓库实际文件运行。Windows 门禁先被商店 Python 占位入口拒绝；provenance 的 Bash/Windows 路径执行失败；转至既有 WSL 执行完整测试。WSL 门禁最初 59/65，原因是两个 shell 工作副本 CRLF；仅从本隔离检出索引按 LF 还原同字节脚本后为 65/65，未削弱断言或提交行为改动。适配器首次因隔离检出未装 workspace 依赖失败，复用同锁依赖后通过。第一次前端命令只设 maxWorkers，触发 min/max 冲突且无测试执行；明确 minWorkers=1、maxWorkers=2 后完整 361/361。

## 4. PLM 对齐设计与尚待验证项

只读三方分析：整支旧历史合 main 有 47 个文本冲突文件；以净差量处理后缩为 16 个。该数量是分析结果，实际新 K3 父层上的冲突仍须重新核对。

必须同时保留：订单 BOM 版本选择、子件自身版本、main 的需求证据捕获；已生效 readPlan 身份与 token 配置身份；main 的 generation binder、项目写 lease、原子 consume、host fence、来源内容摘要及归档整链。前端失败原因 union 要包括 pilot/write-lock 分类，不能降级成普通读取错误或自动重试。

迁移保持原编号：PLM `089_create_integration_stock_prep_read_plan_versions.sql`，宜搭从 090 起；main 的 100 项目写锁、101 pilot 迁移都保留。不能复制旧 migrations 目录或为消除文本冲突恢复旧编号。

PLM host fixture 原来只建立到 089 及其 revision/ledger TS 迁移；对齐 main 后，可写 caller 预览在发 token 前会 bump generation，因此必须核对 fixture 的 100 写锁迁移支持。尚未运行，不能称为已确认失败，也不能通过删除生产 binder 让测试变绿。

待完成：PLM 实际差量接线及冲突修复、SA01/SA02 完整插件回归、main 写锁/pilot/source parity 回归、前端类型检查，以及独立合成 PG + 浏览器的真实宿主闭环。既有 PR 的历史 CI 不替代本地新组合验证；本轮不触发新 CI。

## 5. CI 事实与验收边界

只读核对旧 main `714c910` 的 Plugin run `40044976618`：attempt 1 已取消，不能称整轮全绿。其正式 owner YiDa JWT HTTP/browser 步骤和随后 BPMN 步骤均为 success，但晚期整轮覆盖不闭合；这不替代新本地 K3/PLM 组合的验证。

当前仅可报告 K3 本地代码及上述测试进展。未声明 PLM 已完成、可交付客户或真实发送已经获准。#6337 未恢复，未重复启动已完成的 Chrome 宜搭试用。
