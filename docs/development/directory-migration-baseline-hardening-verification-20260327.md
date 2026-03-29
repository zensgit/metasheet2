# Directory Migration Baseline Hardening Verification

日期：2026-03-27

## 变更范围

- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/src/db/migration-audit.ts`
- `packages/core-backend/src/db/migration-health.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/package.json`
- `packages/core-backend/tests/unit/migration-audit.test.ts`
- `packages/core-backend/tests/unit/migration-health.test.ts`
- `scripts/ops/git-baseline-report.mjs`
- `package.json`

## 本地验证

### 1. 定向单测

命令：

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-audit.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync.test.ts
```

结果：

- 3 个测试文件通过
- 47 个测试通过
- 覆盖了：
  - CLI 参数解析
  - migration 顺序漂移检测
  - required migration 文件检测
  - 目录 schema 缺表检测
  - 目录路由与目录服务既有回归

### 2. TypeScript 静态检查

命令：

```bash
pnpm --filter @metasheet/core-backend exec tsc --pretty false --noEmit
```

结果：

- 通过

### 3. backend build

命令：

```bash
pnpm --filter @metasheet/core-backend build
```

结果：

- 通过

### 4. migration help CLI 自检

命令：

```bash
node --import tsx packages/core-backend/src/db/migrate.ts --help
```

结果：

- 可正常输出帮助文本
- 已确认包含：
  - `--list`
  - `--audit`
  - `--to <migration-name>`
  - `--allow-destructive`

### 5. migration list CLI 自检

命令：

```bash
node --import tsx packages/core-backend/src/db/migrate.ts --list --json
```

结果：

- 可正常输出本地 migration 文件列表
- 当前环境数据库不可达，状态退化为 `unknown`
- 当前共输出 `62` 条 migration 记录

### 6. migration audit CLI 自检

命令：

```bash
node --import tsx packages/core-backend/src/db/migrate.ts --audit --json
```

结果：

- 命令可运行
- 当前沙箱/本地环境数据库不可达时，不再误报 `orderCheck: ok`
- 当前输出为文件级审计结果 + warning：

```json
{
  "databaseReachable": false,
  "migrationTableExists": false,
  "migrationLockTableExists": false,
  "filesystemMigrations": {
    "count": 62,
    "first": "20250924105000_create_approval_tables",
    "last": "zzzz20260327110000_create_directory_template_center_and_alerts"
  },
  "trackedMigrations": {
    "available": false,
    "executedCount": 0,
    "pendingCount": 62,
    "lastExecuted": null
  },
  "orderCheck": {
    "ok": null,
    "firstMismatchIndex": null,
    "expectedName": null,
    "actualName": null
  },
  "requiredDirectoryMigrations": {
    "missingNames": []
  },
  "warnings": [
    "无法读取数据库迁移状态: EPERM",
    "数据库迁移跟踪不可用，顺序漂移检查已跳过。"
  ],
  "errors": []
}
```

### 7. 根脚本入口验证

命令：

```bash
pnpm verify:directory-migration-health
pnpm verify:git-baseline
```

结果：

- `verify:directory-migration-health` 已通过
- 其内部已不再走 `tsx src/db/migrate.ts`，而是走 `node --import tsx src/db/migrate.ts`
- `verify:git-baseline` 已通过，输出当前基线状态：
  - 分支 `codex/attendance-pr396-pr399-delivery-md-20260310`
  - `ahead 3 / behind 4`
  - `dirty=true`
  - `changedFileCount=261`

## 环境约束说明

### 数据库不可达

本轮没有把本地数据库接进验证环境，因此：

- `--list` 退化为文件级输出
- `--audit` 输出文件级审计 + 数据库不可达 warning

这也是本轮特意强化的能力：即使数据库不可达，也能先检查 migration 文件与目录/IAM 审计骨架，不再完全失明。

### tsx IPC 限制

当前沙箱下直接执行 `tsx ...` 会因为本地 IPC pipe 被拒绝而失败，因此本轮把 migration 相关 package script 统一收口为：

```bash
node --import tsx src/db/migrate.ts ...
```

这样根脚本验证和 package 脚本验证都能稳定运行。

## 远端验证与修复

目标环境：`mainuser@142.171.239.56`

### 8. 远端 container 审计入口恢复

执行动作：

- 重新把以下文件注入 `metasheet-backend` 容器：
  - `src/db/migrate.ts`
  - `src/db/migration-audit.ts`
  - `src/db/migration-health.ts`
  - 6 条目录/IAM 必需 migration 文件

发现：

- 运行中的 `metasheet-backend` 初始仍是旧版 `migrate.ts`
- 容器内最初缺失以下 migration 文件：
  - `zzzz20260323120000_create_user_external_identities`
  - `zzzz20260323133000_harden_user_external_identities`
  - `zzzz20260324143000_create_user_external_auth_grants`
  - `zzzz20260324150000_create_directory_sync_tables`
  - `zzzz20260325100000_add_mobile_to_users_table`
  - `zzzz20260327110000_create_directory_template_center_and_alerts`

### 9. 审计排序盲点回归

新增本地验证：

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-audit.test.ts \
  tests/unit/migration-health.test.ts
pnpm --filter @metasheet/core-backend build
```

结果：

- `14` 个定向测试通过
- `build` 通过
- 已新增回归覆盖：
  - recorded execution 顺序优先于 `migrator.getMigrations()` 的文件状态顺序
  - recorded execution 按 `Date(timestamp) -> name` 排序
  - provider 过滤隐藏 migration 并按文件名稳定排序

根因结论：

- Kysely `Migrator` 会：
  - 文件侧按 migration 名排序
  - 已执行侧先按 `new Date(timestamp).getTime()` 排序，再按名字打破同毫秒并列
- 初版审计使用数据库原始 `order by timestamp, name`，会出现“审计绿、执行红”的假阳性

### 10. 远端 migration 漂移修复

执行动作：

- 手工修正 `kysely_migration` 中以下记录的 `timestamp`，统一成整毫秒递增顺序：
  - `zzzz20260323153000_add_attendance_shift_overnight` -> `2026-03-27T00:26:44.087Z`
  - `zzzz20260324143000_create_user_external_auth_grants` -> `2026-03-27T00:26:44.088Z`
  - `zzzz20260324150000_create_directory_sync_tables` -> `2026-03-27T00:26:44.089Z`
  - `zzzz20260325100000_add_mobile_to_users_table` -> `2026-03-27T00:26:44.090Z`

修复前远端审计：

- `filesystemMigrations.count=66`
- `trackedMigrations.executedCount=65`
- `trackedMigrations.pendingCount=1`
- `orderCheck.ok=true`
- 但 `--up` 仍被 Kysely 拒绝  
  说明审计排序逻辑与 Kysely 不一致

修复后远端审计（执行 `--up` 前）：

```json
{
  "filesystemMigrations": { "count": 66 },
  "trackedMigrations": {
    "executedCount": 65,
    "pendingCount": 1,
    "lastExecuted": "zzzz20260326134000_create_meta_comments"
  },
  "orderCheck": { "ok": true },
  "errors": []
}
```

### 11. 远端 `--up` 与终验

执行命令：

```bash
docker exec metasheet-backend sh -lc 'node --import tsx /app/packages/core-backend/src/db/migrate.ts --up'
docker exec metasheet-backend sh -lc 'node --import tsx /app/packages/core-backend/src/db/migrate.ts --audit --json'
```

结果：

- `zzzz20260327110000_create_directory_template_center_and_alerts` 执行成功
- 已存在索引按预期走 `already exists, skipping`
- 终态审计输出：
  - `filesystemMigrations.count=66`
  - `trackedMigrations.executedCount=66`
  - `trackedMigrations.pendingCount=0`
  - `trackedMigrations.lastExecuted=zzzz20260327110000_create_directory_template_center_and_alerts`
  - `orderCheck.ok=true`
  - `requiredDirectoryMigrations.missingNames=[]`
  - `directorySchema.missingTables=[]`
  - `warnings=[]`
  - `errors=[]`

远端 `kysely_migration` 最新记录尾部：

```text
zzzz20260327110000_create_directory_template_center_and_alerts | 2026-03-27T15:35:41.398Z
zzzz20260326134000_create_meta_comments                        | 2026-03-27T00:26:44.138Z
zzzz20260326124000_add_config_to_meta_views                    | 2026-03-27T00:26:44.104Z
zzzz20260325100000_add_mobile_to_users_table                   | 2026-03-27T00:26:44.090Z
zzzz20260324150000_create_directory_sync_tables                | 2026-03-27T00:26:44.089Z
```

### 12. 远端遗留约束

最初仍发现一个宿主机问题：

- `/home/mainuser/metasheet2/packages/core-backend/src/db/migrations` 对 `mainuser` 不可写
- 本轮因此只能把缺失 migration 文件注入运行容器，不能把宿主机源码目录一并修到可写

后续已继续完成修复：

- 使用 `docker run -v /home/mainuser/metasheet2/packages/core-backend:/target alpine:3.20 chown -R 1000:1000 /target`
- 修复后确认：
  - `packages/core-backend`
  - `packages/core-backend/src`
  - `packages/core-backend/src/db`
  - `packages/core-backend/src/db/migrations`
  均已变为 `mainuser:mainuser`
- 额外通过 `touch /home/mainuser/metasheet2/packages/core-backend/src/db/.perm_check` 验证可写，再删除测试文件
- 随后把本轮关键文件同步回宿主机源码目录，包括：
  - `src/db/migrate.ts`
  - `src/db/migration-audit.ts`
  - `src/db/migration-health.ts`
  - 6 条目录/IAM migration
  - 定向测试
  - Git 基线脚本
  - 设计 / 验证 / Git 基线文档

这意味着当前现网 backend 不再只有“运行容器里是新代码”，宿主机对应源码目录的关键路径也已经补齐。

后续又完成了宿主机运行时收口：

- `mainuser` 用户态已安装：
  - `node v20.20.2`
  - `pnpm 10.33.0`
  - `corepack 0.34.6`
- 入口位于 `~/.local/bin`
- 因此宿主机登录 shell 已可直接执行基础 Node / pnpm 命令

但仍需区分两个边界：

- 宿主机部署目录 `/home/mainuser/metasheet2` 不是 Git clone
- 因此 Git 基线脚本在该目录里会结构化返回 `NOT_A_GIT_REPOSITORY`
- migration 审计和现网运行态验证，当前最可靠环境仍是运行中的 `metasheet-backend` 容器

## 验证结论

本轮工程收口已经达到目标：

1. `db:list / db:audit / db:rollback / db:reset / --to / --allow-destructive` 具备正式 CLI 行为
2. 目录/IAM migration 审计具备正式输出，并能正确标识 `orderCheck: skipped`
3. `db/types.ts` 已补齐目录/IAM 相关表
4. Git 基线报告脚本与根脚本入口已接通
5. 定向测试、静态检查和 backend build 均通过
6. `142.171.239.56` 的 migration 审计入口已恢复
7. 远端 `kysely_migration` 顺序漂移已修正，`--up` 已成功补齐到 `66/66`
8. 目录/IAM 必需 migration 文件、目录 schema 和 tracking 终态均为绿色
9. 远端宿主机 `packages/core-backend` 关键源码目录 ownership 已修正为 `mainuser:mainuser`
10. 远端宿主机关键源码与文档已同步，不再只依赖容器热注入

## 后续建议

下一步应继续做三件事：

1. 把本轮修复正式烘进镜像或 Git 可追溯分支，避免宿主机源码和镜像再次漂移
2. 如确实需要在宿主机直接执行 Git 基线脚本，先把宿主机目录整理成真正的 Git clone，而不是部署副本
3. 继续收 GitHub 基线，避免现网修复与本地 dirty worktree 长期脱节
