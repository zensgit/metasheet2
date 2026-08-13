# 备料只读数据库 → 内部 MVP 快照：开发及验证报告（2026-08-13）

> 状态：代码修复与本地定向验证完成；最终交付仍以 PR #4892 的 exact head、required CI
> 和 owner 决策为准。本文不授权实体机部署、数据库写、K3 Save/Submit/Audit、有效令牌
> Apply、依赖安装或迁移。
>
> `independentHumanReviewClaimed=NO`。本文记录的是多模型辅助技术审阅与自动化测试，不冒充
> 独立人工审阅，也不替代 `zensgit` 的 owner 授权。

## 1. 交付边界

本切片把已部署的多关系 PLM/SQL 只读 table action 在服务进程内重新计算，并把可应用的
BOM 展开结果写入 MetaSheet 内部备料 MVP 快照表。原始数据库行与展开行不会经过 HTTP
响应，也不会传给外部写 adapter。

明确不包含：

- SQL Server/PostgreSQL DDL 或 DML；
- K3 Material Save、Submit、Audit；
- 普通 pipeline run/replay 或有效令牌 Apply；
- 生产授权、192.168.1.222/223 部署、重启、安装依赖或执行迁移；
- 凭据、租户/workspace 标识、内部 URL 或业务行的证据发布。

范围关联：

- #4437 已以 values-free receipt 完成测试环境 no-DDL 只读数据库 dry-run 验收；本切片不重复
  该实体机操作，也不扩大其授权。
- #4861 的 exact-two K3 Save-only 仍是独立 write-bearing gate；本切片不能代替，也没有执行
  任何 K3 写入。

## 2. API 与默认关闭门禁

端点：`POST /api/integration/table-actions/:actionId/mvp-persist`

请求体只允许：

```json
{
  "parameters": {
    "projectNo": "<operator-supplied value>"
  }
}
```

安全门按以下顺序执行：

1. `integration:admin` 权限；
2. 专用环境开关 `MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED` 必须严格等于
   `true`；缺失、拼写错误或其他值均保持关闭；
3. 拒绝 query 中的任何字段、params 中除 `actionId` 外的字段，以及 body/params 中的
   `tenantId`、`workspaceId`、`projectId`、目标表/批次/版本等 steering 字段；
4. 在 action/source lookup、adapter 创建和 source read 之前，从已认证主体派生 tenant；
   tenantless admin 直接失败；
5. 只接受部署配置中的 SQL readonly source，且外部系统状态必须是 `active`；
6. 重新读取、重新展开并执行 not-found、large-BOM、冲突和 not-ready fail-closed 检查；
7. 只调用既有 `persistStockPreparationSyncRun` 写入认证 tenant 的内部 staging MVP 表。

物理 target project 从认证 tenant 服务端派生。请求中的项目号只作为业务键参与稳定摘要，
不能改变租户或物理写目标。

## 3. 原子快照版本分配

原实现把每个 revision 的 `snapshotVersion` 固定为 `1`。首次写入后，源 revision 变化会生成
新 batchId，但会被既有单调版本守卫拒绝。本次在共享 persist 中新增内部专用的
`allocateSnapshotVersion` 策略：

- 该策略不能与显式 `snapshotVersion` 同时使用；歧义请求在 provisioning/records I/O 前
  以 422 失败；
- 在既有 host-owned unit-of-work 与 tenant/project/batch 锁内先查询 deterministic batchId；
- 相同 revision 命中已有 batch 时，读取已存版本重建相同 plan，执行完整 exact-replay
  校验并零写返回；
- 新 revision 在同一项目锁内读取项目全部可证明历史的最大版本，分配 `max + 1`；
- 历史不可证明或达到 `Number.MAX_SAFE_INTEGER` 时 fail closed；
- 显式版本调用者（现有 `/mvp/sync/persist` 等）保持原有严格单调语义，不受自动策略影响。

因此，同 revision 并发只能产生一次 create 与一次 exact no-op；不同 revision 并发在真实
host project advisory lock 下得到唯一、单调的版本。

## 4. 幂等、事务与审计语义

- batch、line、run 是 create-only 不可变记录；项目 live pointer 最后 upsert；
- 全部 idempotency read、历史扫描、create/patch 与 revision 写入共用一个 host 事务；任一步
  失败均整体回滚；
- exact replay 必须逐一匹配 frozen batch/line/run projection 与 project pointer，不能用
  “batchId 已存在”代替完整校验；
- 本端点归类为与 `/mvp/sync/persist`、ERP cache sync 相同的 system synchronization commit；
  同一事务内的 immutable run record 是技术 receipt；
- 本切片不声称 actor audit。不得在事务提交后简单追加非原子 audit；如 owner 要求操作者
  身份审计，应另立事务化 audit 能力，不在本切片内伪装完成。

HTTP 响应只包含 created/skipped 状态、计数、闭集状态与字段名等 values-free 证据；不返回
项目号、物料号、名称、展开行、凭据或内部标识。

## 5. 代码落点

| 文件 | 变化 |
|---|---|
| `plugins/plugin-integration-core/lib/http-routes.cjs` | 独立默认关闭开关、steering 拒绝、auth-tenant-first、active source gate、内部自动版本策略接线 |
| `plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs` | 在既有 unit-of-work/项目锁内复用 stored version 或分配 `max + 1` |
| `plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | flag-off、carrier steering、tenantless admin、inactive source、changed revision、并发、not-found、source error 脱敏与零写证明 |
| `plugins/plugin-integration-core/__tests__/stock-preparation-sync-run-persist.test.cjs` | exact replay、changed batch、显式版本冲突与 safe-integer exhaustion |
| `packages/core-backend/tests/integration/stock-preparation-t3b-replay-hardening-realdb.test.ts` | 真实 host UoW 下 same/different batch 并发自动版本证明 |
| `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` | 更新受影响运行文件的 LF blob SHA-256 pin |

## 6. 本地验证

在 Windows 工作树执行以下定向验证，未安装新依赖、未运行迁移、未访问实体服务器或外部
数据库/K3：

```text
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
PASS

node plugins/plugin-integration-core/__tests__/stock-preparation-sync-run-persist.test.cjs
48 passed, 0 failed

node plugins/plugin-integration-core/__tests__/data-source-sql-readonly-source-adapter.test.cjs
PASS

node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
PASS
```

关键负向/正向矩阵：

| 场景 | 预期与结果 |
|---|---|
| feature flag 缺失 | 403，zero adapter/read/write |
| body/query/params steering | 400 专用错误，zero source lookup/read/write |
| tenantless admin | `TENANT_REQUIRED`，zero source lookup/read/write |
| inactive source | 409，zero adapter/read/write |
| source not found | 404，zero internal write |
| source driver 私密错误 | coarse 409，响应不含原始错误，zero internal write |
| 首次 revision | create，版本 1 |
| exact replay | 200 no-op，重新读源但 zero internal write |
| changed revision | create，版本 2 |
| 同 revision 并发 | 一次 201 + 一次 200；仅一个新 batch |
| 新 revision 并发 | host project lock 下版本唯一单调；真实 DB 测试钉 `[1,2]` |
| auto + 显式版本 | 422，provisioning/records zero I/O |
| safe integer 耗尽 | 422 fail closed，zero new write |

真实 DB 测试受 `DATABASE_URL` 门控；它只在批准的 CI 数据库环境运行。未配置数据库时不会
通过临时安装或连接客户环境伪造 PASS。

## 7. Provenance 与平台差异

sealed-export pin 按 Git LF blob 字节计算。Windows `core.autocrlf=true` 的工作树是 CRLF，直接
对工作树文件做 SHA-256 会与 pin 不同；应以 Git index/blob 的 LF 内容或 Linux CI 结果为
权威。该差异不应通过改弱 provenance 校验来规避。

## 8. 发布与回滚边界

PR #4892 在修复后必须：

1. 冻结新的 exact head；
2. 全部 required checks 在同一 head 通过；
3. 重新做技术审阅；旧 head 的审阅立即失效；
4. 保持 Draft，直到 owner 明确决定 Ready/merge；
5. 实体部署需要单独授权，并继续保持 `InstallDeps=0`、`runMigrations=0`、无 SQL/K3 外写；
6. 回滚优先将专用 feature flag 置为非 `true`；代码/部署回滚仍走既有受保护流程。

## 9. 当前收尾结论

- 测试环境只读数据库 dry-run：已由 #4437 独立验收完成；
- table-action → 内部 MVP 快照：本报告覆盖的代码缺口已修复并完成本地定向验证，等待新
  exact head 的 CI 与 owner 发布门；
- K3 exact-two Save-only：#4861 仍需 owner 在同一记录中给出真实管理员 identity、实际
  merged/deployed SHA、新 operationId、精确两次 Save-only 及 native cleanup/readback/停止条件。

在 #4861 的上述授权完成前，必须保持 Apply disabled，不执行 K3 Save/Submit/Audit；所以
“只读数据库与内部快照代码收尾”可以完成，但“真实 K3 写入闭环”不能被冒称为已完成。
