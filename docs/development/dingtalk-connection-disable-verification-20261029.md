# 钉钉企业／集成停用验证 — 2026-10-29

## 交付与范围

基线 `a03d804d60d83717feaedce099e5ff14216afc58`，分支 `codex/dingtalk-integration-disable-20261029`。本次交付停用代码、回归测试和 Draft PR；没有修改在线配置、真实解绑、密文、账号关联或登录授权，没有合并或部署。

[设计锁](dingtalk-connection-disable-design-lock-20261029.md)明确：客户更名保留企业身份，只改显示名称；换用企业微信需要另行迁移。本功能停止目录中登记的钉钉企业应用连接，保留本地账号、组织、目录镜像、业务数据、成员关系、权限和登录授权。

**范围限制：独立群机器人 Webhook 没有目录集成／企业归属，本次不会自动关闭。此功能不能作为全部钉钉出口的总开关；客户迁出钉钉前必须另行盘点这些自动化。**

## 行为与保护

- 管理员在目录同步页选择当前集成，或同一本地组织＋Corp ID 下全部钉钉集成；先只读预览，再勾选确认。预览是快照，执行范围以提交时的现有集成为准。
- 用独立 JSON 停用标记，关闭自动同步；保持原 `status`，避免把企业连接停用误作成员停权。没有新增迁移或环境开关。
- 手动／异步／预览同步入口拒绝停用连接，在同步落库的 source-freeze 锁下复查。调度器不再登记停用连接。
- 注册应用的工作通知、动作卡片、交互卡片及待办写操作在真正 HTTP 调用前检查状态，并持锁至请求完成。停用等待已有请求结束；等待超时返回冲突，不能报告成功。已发送消息不能撤回。
- 应用跨选定范围共享时，停用拒绝并保持原状。停用后不接受新建集成或修改另一条集成的应用标识来复用已停用应用。普通保存原子保留停用标记及 `sync_enabled=false`，旧配置保存不能抹去停用。
- 若存在停用连接，缺少归属或未登记应用的发送请求拒绝；其他已登记且正常的组织继续工作。数据库状态不可读时，发送在出站前失败。
- OAuth／容器登录流程不受此标记控制。新到达的停用集成交互卡片回调拒绝；已经进入审批处理的请求不会被取消，本地审批入口及权限保持不变。
- UI 展示“连接已停用（成员权限保留）”，禁用同步及连接发送测试。网络中断或提交结果不明确时要求刷新核对，不自动重试停用。

## Mac mini 隔离验证

Node **20.20.2**、pnpm **10.16.1**、PostgreSQL **16**。使用本任务独占数据库实例、随机 schema、合成账号／成员／业务记录和假发送器；没有访问真实钉钉 API或修改 staging。真实数据库套件建的是最小合成 schema，不代表目标环境迁移／升级验收。

| 验证 | 最终结果 |
| --- | --- |
| 后端定向及邻接单元回归 | 28 文件，**1,252 通过** |
| 真实 PostgreSQL 停用／隔离／并发测试 | 1 文件，**10 通过** |
| Vue 目录页面及选项组件回归 | 2 文件，**106 通过** |
| `pnpm validate:all` | **退出码 0**：插件验证、lint、类型检查 |
| 停用核心覆盖率 | **98.71% 行／语句，100% 函数，86.88% 分支** |
| 守卫变异负例 | **5/5**：削弱时失败，恢复后通过，源码字节恢复 |
| 提交文件与受测文件一致性 | **33 个源码／测试／工作流文件 SHA-256 一致** |
| `git diff --check` | 通过 |

覆盖率为新单元 24 项＋真实 PG 10 项的组合；这 24 项已包含在后端 1,252 项中，不重复计数。覆盖率未覆盖的两行是检测目标集合改变后拒绝提交的分支，不能据此宣称所有竞态已穷尽。

真实 PG 测试覆盖：单集成及企业范围、跨组织正常发送正例、跨范围共享应用拒绝、在途发送结束后才确认停用、排队发送在停用后拒绝、旧配置竞态、普通保存不清除标记／不开启同步、禁止其他集成接入已停用应用、未登记旧应用拒绝、同步落库复查及本地数据指纹保留。

5 个变异检查分别削弱发送拒绝、旧凭据保存 SQL 条件、其他集成采用停用应用的检查、组织状态保留及 OAuth 豁免。每组定向测试均先失败、恢复后通过。传输／重试语义旧夹具显式模拟连接守卫；守卫本身由新的真实 PG 和单元套件验证。

完整测试文件清单和结果见 [validation-results.json](../../artifacts/dingtalk-connection-disable/validation-results.json)，覆盖率见 [coverage-summary.json](../../artifacts/dingtalk-connection-disable/coverage-summary.json)，负例结果见 [mutation-results.json](../../artifacts/dingtalk-connection-disable/mutation-results.json)，受测文件指纹见 [tested-source-sha256.json](../../artifacts/dingtalk-connection-disable/tested-source-sha256.json)。原始运行日志保留在本任务隔离目录，没有作为公开证据上传。

复现命令（后端文件清单见上述 JSON 的 `backendUnit.files`）：

```sh
pnpm --filter @metasheet/core-backend exec vitest run <backendUnit.files 中的完整清单> --reporter=dot
DATABASE_URL=<隔离测试库> pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/directory-connection-disable.realdb.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/directoryConfigPickers.spec.ts --watch=false
pnpm validate:all
```

## 合成界面验收

浏览器加载真实 `DirectoryManagementView` 和停用组件，API由合成内存数据模拟：企业范围预览显示两个集成；勾选前确认按钮不可点；成功后显示停用标记，手动／异步／预览同步及测试按钮禁用，自动同步勾选禁用。合成界面操作没有调用在线停用接口。

![企业范围预览](../../artifacts/dingtalk-connection-disable/enterprise-preview.png)

![停用成功与数据保留提示](../../artifacts/dingtalk-connection-disable/connection-disabled.png)

## CI、发布及恢复边界

新增真实 PG 套件接入 `plugin-tests.yml` Node 20 job，按整文件执行且缺少数据库必须失败；无 DB 默认任务排除该套件。Draft PR 创建后由 CI执行，本 MD 不把 Mac mini 通过等同于 13 项必需 CI 全绿。

当前 staging 加密材料／集成展示问题、#6640 的验证状态独立处理，本次不包含该 PR，也不据此证明 staging 在线可用。

本切片不提供恢复、删除或真实解绑接口。旧版本代码不会识别停用标记，因此**不能直接降级旧版本或清除标记来恢复**；如需降级，必须先另批并验证发送隔离与调度停止方案。数据保留并不等于旧版本仍能维持停用保护。

后续必须分别审批：登录授权处理、企业微信接入、真实解绑、在线配置修改、合并、部署和启用。全部群机器人出口盘点及真实目标环境验收仍是另一步。
