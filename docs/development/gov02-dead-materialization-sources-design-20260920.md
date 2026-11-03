# GOV-02：清理零引用的 DataMaterializationService / WorkflowRepository / BaseRepository 源码

## 背景

owner 裁决（GOV-02）：仅清源码，**保留全部迁移与库表**；`integration_schedules` 继续延期处理。

`packages/core-backend/src/db/migration-provider.ts:91-92`（清理前）已明文背书两点：
- `WorkflowRepository.ts`（依赖 042 `workflow_tokens`/`workflow_incidents`）
- `DataMaterializationService.ts`（依赖 042b/044 `external_tables`）

均为"全仓零 importer"的死代码，仅仅恢复迁移不会让功能复活。

## 扫描方法（删除前自证"零引用"）

在本 PR 的 worktree（`origin/main` 基线）里，对全仓（`packages/`、`plugins/`、`scripts/`、`apps/`）执行：

```
grep -rn "DataMaterializationService\|WorkflowRepository\|BaseRepository" \
  --include="*.ts" --include="*.js" --include="*.cjs" --include="*.mjs" --include="*.json" \
  packages/ plugins/ scripts/ apps/
```

命中仅 4 个文件，且均为"自身文件"或已知注释：
- `packages/core-backend/src/db/migration-provider.ts`（注释提及，非 import）
- `packages/core-backend/src/db/repositories/BaseRepository.ts`（被删对象之一）
- `packages/core-backend/src/db/repositories/WorkflowRepository.ts`（被删对象之一，且是 `BaseRepository` 唯一 import 点：`WorkflowRepository.ts:9`）
- `packages/core-backend/src/services/DataMaterializationService.ts`（被删对象之一）

另外核实：
- `cron` 从未在任何 `package.json`（根 + `packages/*/package.json` + `plugins/*/package.json`）声明，而 `DataMaterializationService.ts:24` 有 `require('cron')` —— 该服务本来就无法在生产环境跑起来。
- 插件微内核可能按字符串名加载：对裸字符串 `'DataMaterialization'` / `'WorkflowRepository'` / `'BaseRepository'` 全仓扫描，零命中。
- `tests/unit`、`apps/web/tests` 里没有任何文件 import 这三个源文件（零命中）。
- `MySQLAdapter` / `MongoDBAdapter`（`DataMaterializationService` 曾经内部使用的适配器类）在 `DataSourceManager.ts` 里仍有独立注册（`mysql: MySQLAdapter` 等），因此这两个适配器类**不**受本次清理影响，继续保留。

结论：三个文件在删除前确认为全仓零运行时引用，可以安全删除。

## 改动范围

1. `git rm`：
   - `packages/core-backend/src/services/DataMaterializationService.ts`（1324 行）
   - `packages/core-backend/src/db/repositories/WorkflowRepository.ts`
   - `packages/core-backend/src/db/repositories/BaseRepository.ts`
2. `packages/core-backend/src/db/migration-provider.ts:89-93` 注释更新：从"有零 importer 的死代码"改为"源码已删除（GOV-02 本 PR），迁移与表保留"。
3. 文档注记（不重写，只加"已移除"说明）：
   - `docs/DATA_SOURCE_ADAPTERS.md`：两处提到 `DataMaterializationService only` 的地方改为注明该服务已被移除、MySQL/MongoDB 适配器类本身保留。
   - `docs/integration-consolidation-plan-20260901.md`：三处提到 `DataMaterializationService.ts` 的地方加注"源码已移除（GOV-02）"，040/044 僵尸表本身**未删**（仍待后续处理，本次不动迁移/表）。

## 明确不做的事

- 不动 `migrations/` 目录任何文件、不动任何 `.sql`。
- 不动 `integration_schedules`（057）相关代码或文档结论。
- 不删除 040/044 僵尸表（迁移与表保留，仅源码引用注记更新）。
- 不改动 `MySQLAdapter`/`MongoDBAdapter`（仍被 `DataSourceManager` 正常使用）。

## 风险与回滚

- 纯删除 + 注释/文档更新，无功能改动、无迁移改动。
- 回滚方式：`git revert` 本 PR 的 commit 即可恢复三个源文件与相关注释/文档原文。
