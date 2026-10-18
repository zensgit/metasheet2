# 托管 BOM 投影根绑定与来源合同

状态：本片源码、本地反例、无数据库控制、独立 PostgreSQL 回归通过；对应文档 head CI 待实际核对。多人持久协作、分享授权与完整总目标未完成。

源码 `795286b6b57ec9dd0a952ba8753cb76a76e4acd0`，基线 `519184d6414c0eededb9fde1b55fe211d7ce8e54`。新隔离树实施，不修改固定的运行包输入或冻结台账。

## 实际问题与设计

原 managed relay 核对了返回 envelope 的 source.part_id，但仅用通用 context 形状判定其内容。反例保持 source 及 native 当前主体完全匹配，仅把 context.part.part_id 改为另一个根：原源码实际返回 kind=ok。修复后相同反例返回 403，不能把来源正确、内容根错误的投影交给当前 BOM 页面。

复用原有 share 投影字段定义，新增显式 bom_review_managed.v1 类型和解析分支；要求实际 provider 的 feature_key、entitlement、snapshot_at、来源及完整投影字段。来源 tenant/org/AuthUser/root 分别匹配持久 session 的 native 值，context 的根也必须匹配。native AuthUser 与 Meta user 的不同 ID 不被混同。错误来源拒绝，缺失或畸形元数据拒绝。

抽取服务器内部 relayManagedBomSnapshot 保留 source、snapshot_at 和 context；现有 relayManagedBomContext 继续只向原路由返回 context，保留原 kind/refusal 形状。context/part/line 的附加只读字段保持透传（含现有 CAS 元数据），避免重构丢字段。未修改个人绑定、当前 request/session、native status、registration、专用 HTTP transport 的前置校验。

两种 projection_contract 仍不互通。parseShareSnapshot 拒绝 managed 投影，现有协作创建仍不能拿个人 read grant 绕过 shared transport 拒绝。snapshotHash 的入参明确为原有 source+context，算法不变、仍排除 snapshot_at；哈希从不充当分享授权。

本片不增加路由、开关、持久表、分享资格或后台借用 cookie 的路径。完整多人发布仍需独立用途/目标/操作/hash 授权、来源 generation 与事务 interlock、受众和撤销保留政策；不能将本片当成分享或后台监听完成。

## 验证与复现

工具：Node 20.20.2、TypeScript（现有锁定依赖）、Python 3.11.15、PostgreSQL 15.17。复用现有 node_modules，不安装新依赖。

在 packages/core-backend 下执行：

```sh
node node_modules/vitest/vitest.mjs run tests/unit/plm-managed-projection-envelope.test.ts tests/unit/plm-bom-review-wire.test.ts tests/unit/plm-managed-companion-refute.test.ts tests/unit/plm-managed-adapter-refute.test.ts --reporter=dot
node node_modules/typescript/bin/tsc --noEmit
```

- 新 envelope 控制 13 项，连同现有 wire/shared-transport 拒绝控制共 39 passed，0 failed、0 skipped。
- 原基线同根错配反例失败，实际收到 kind=ok；修复后返回 403。独立原始日志 `/tmp/plm-managed-envelope-original-root-red.log`。
- 控制覆盖 native tenant/org/AuthUser/root 独立错配、畸形时间、保留完整内部 envelope/CAS 字段、外部 context 形状、read/share 不互相冒充、时间不改变内容 hash、无当前个人请求零 native 调用、真实判定 unbound 的 legacy 正例。
- 后端 tsc --noEmit 退出 0。

按原 owned-socket.mjs 启动新的 nonce-owned、仅 Unix socket PostgreSQL；仅将其明确 DSN 传入 DATABASE_URL 与 PLM_MANAGED_COMPANION_TEST_PG_URL 后执行：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.plm-managed-companion.config.ts --reporter=json --outputFile=PRIVATE_REPORT
```

实际 34 passed，0 failed、0 pending；success=true。原身份、unlink/transfer、撤销重试、真实认证入口和锁等待控制保持通过。fixture 仅补齐真实 native 已发送的 feature_key、upgrade、snapshot_at，未删除控制或弱化断言。测试后原 owner/nonce helper 确认 postgresStopped=true、directoryRemoved=true。私有 report/start/cleanup 记录分别为 `/tmp/plm-managed-envelope-pg-report.json`、`/tmp/plm-managed-envelope-pg-start.json`、`/tmp/plm-managed-envelope-pg-cleanup.json`。

这是真实 PostgreSQL 与 Meta 流程测试，native transport 在该套件中受控模拟；不声称本片完成新分享链的双系统跨进程验收。

ESLint 未全绿：源码存在基线原有 4 处 no-control-regex 错误，已在未修改的 519184d 基线独立重跑，位置/规则完全相同；本片没有改这些行。integration 文件不在 ESLint 的 tsconfig，unit 文件受现有 ignore 规则影响。类型检查与实际 Vitest 结果单列，未关闭 lint 规则或将 lint 失败描述为通过。最初一次 Vitest 从错误目录调用未找到 setup，纠正 cwd 后才执行以上结果。

## 后续验收

保留 Draft，不合并或部署。实际 PR 文档 head CI 必须另核对；不得用本地 39/34 或历史绿 CI 替代。源提交与本次一次文档提交分开，后续状态写入私有证据台账，避免为记载自身 SHA 循环提交。

总目标继续：受控多人分享与通用预审、完整协作与粒度监听、原 Visual/Discussion/SSO/撤权/DP1/Stage A/RG/版本路线，以及运行包安装、停用/任务/游标恢复、备份恢复与正式运行依赖。历史 HOLD、未定义 owner 政策及真实设备/生产长期验收仍分别保留。
