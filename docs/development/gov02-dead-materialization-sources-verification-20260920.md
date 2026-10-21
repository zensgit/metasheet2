# GOV-02 清理验证记录

日期（本机 `date`，+08:00）：2026-09-20

## 1. 零引用扫描（删除前）

```
$ grep -rn "DataMaterializationService\|WorkflowRepository\|BaseRepository" \
    --include="*.ts" --include="*.js" --include="*.cjs" --include="*.mjs" --include="*.json" \
    -l packages/ plugins/ scripts/ apps/
packages/core-backend/src/db/migration-provider.ts
packages/core-backend/src/db/repositories/BaseRepository.ts
packages/core-backend/src/db/repositories/WorkflowRepository.ts
packages/core-backend/src/services/DataMaterializationService.ts
```
只命中自身文件与已知注释，无外部运行时 import。

```
$ grep -n "require('cron')\|require(\"cron\")" packages/core-backend/src/services/DataMaterializationService.ts
24:  const cron = require('cron')
$ grep -rn '"cron"' package.json packages/*/package.json plugins/*/package.json
(无命中)
```
确认 `cron` 从未声明为依赖，该服务从未能在生产环境跑起来。

```
$ grep -rn "'DataMaterialization'|\"DataMaterialization\"|'WorkflowRepository'|\"WorkflowRepository\"|'BaseRepository'|\"BaseRepository\"" -r packages/ plugins/ scripts/ apps/
(无命中)
```
插件微内核字符串加载路径也无命中。

```
$ grep -rln "DataMaterializationService|WorkflowRepository|BaseRepository" packages/core-backend/tests apps/web/tests
(无命中)
```
无测试文件直接 import 这三个源文件——本次无需同步删除测试文件。

## 2. 改动内容

- `git rm`：`DataMaterializationService.ts`、`WorkflowRepository.ts`、`BaseRepository.ts`
- `migration-provider.ts:89-93` 注释更新为"源码已删除（GOV-02 本 PR），迁移/表保留"
- `docs/DATA_SOURCE_ADAPTERS.md`、`docs/integration-consolidation-plan-20260901.md` 加"已移除"注记

## 3. 本机验证命令与结果

### TypeScript 类型检查

```
$ pnpm --filter @metasheet/core-backend exec tsc --noEmit
（无输出，退出码 0 —— 通过）
```

### 构建

```
$ pnpm --filter @metasheet/core-backend build
> @metasheet/core-backend@2.5.0 build
> tsc
（退出码 0 —— 通过）
```

### 相关单测（data-adapters/ 与 db/）

```
$ npx vitest run --config vitest.config.ts \
    tests/unit/data-source-a5-adapter-conformance.test.ts \
    tests/unit/mongodb-adapter.test.ts \
    tests/unit/mssql-adapter-connect-wiring.test.ts \
    tests/unit/mssql-adapter.test.ts \
    tests/unit/postgres-adapter.test.ts \
    tests/unit/db.test.ts \
    tests/unit/db-error-guards-locale.test.ts

Test Files  7 passed (7)
     Tests  94 passed (94)
```
无回归。

### 字节级 0x08 扫描（Edit 工具退格坑）

```
$ git diff origin/main | grep -aP '\x08' | wc -l
0
```

## 4. 结论

三个文件在全仓范围内确认零运行时引用（import/require/字符串加载）之后删除；migrations/、integration_schedules 均未触碰；tsc/build/相关单测全部通过；无 0x08 混入。
