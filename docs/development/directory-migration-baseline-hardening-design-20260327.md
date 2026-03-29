# Directory Migration Baseline Hardening Design

日期：2026-03-27  
范围：`packages/core-backend` migration CLI、目录/IAM schema 审计、Git 基线收口辅助

## 背景

当前目录同步、钉钉登录、服务端模板中心已经具备业务功能，但工程基线仍有两个明显缺口：

1. `@metasheet/core-backend` 的 migration 脚本虽然已经开始具备 CLI 形态，但需要进一步收口成可稳定在本地、CI 和运维环境运行的正式入口，尤其要避开 `tsx` CLI 在某些环境里的 IPC 限制。
2. 目录/IAM 的新增表已经依赖到运行时逻辑和路由，但缺少正式的 migration 审计入口；远端一旦出现 migration 记录漂移、缺表、缺锁表，只能靠人工 SQL 和日志判断。

## 目标

本轮不新增业务功能，重点收口工程可运维性：

1. 给 `src/db/migrate.ts` 和 `src/db/migration-audit.ts` 补齐正式 CLI 能力。
2. 增加本地可运行的 migration 审计能力，数据库不可达时退化为文件级检查，并明确把“顺序检查已跳过”输出出来。
3. 把目录/IAM 新表补进 `src/db/types.ts`，消除类型层与 schema 层脱节。
4. 增加 Git 基线报告脚本，把“ahead/behind/dirty/变更分布”从口头判断变成正式输出。
5. 给后续远端迁移链修复提供正式审计抓手，而不是继续依赖人工日志判断。

## 方案

### 1. 单一 migration CLI

实现位置：

- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/src/db/migration-audit.ts`
- `packages/core-backend/package.json`

CLI 动作：

- 默认：`migrateToLatest`
- `--list`
- `--audit`
- `--json`
- `--up`
- `--rollback` / `--down`
- `--reset`
- `--to <migration-name>`
- `--help`
- `--allow-destructive`

破坏性动作保护：

- `--rollback` / `--reset` 需要显式 `ALLOW_DESTRUCTIVE_MIGRATIONS=true` 或 `--allow-destructive`
- `package.json` 中 migration 相关脚本统一切到 `node --import tsx ...`，不再依赖 `tsx` CLI

### 2. migration 审计模型

实现位置：

- `packages/core-backend/src/db/migration-audit.ts`

审计内容：

- 本地 migration 文件列表
- 已执行 migration 与文件顺序是否保持 prefix 对齐
- 顺序判断必须与 Kysely `Migrator` 的真实实现保持一致：
  - 文件侧按 migration 名字排序
  - 已执行侧按 `timestamp -> name` 排序，且 `timestamp` 先按 `Date` 语义解析，再按名字打破同毫秒并列
- 数据库不可达时将顺序状态明确标成 `skipped`
- 目录/IAM 必需 migration 文件是否缺失
- 目录/IAM 关键表是否存在
- 数据库不可达时输出 warning，不阻断文件级审计

实现收口：

- `createProvider()` 返回给 Kysely 的 migration 记录先做过滤和名字排序，避免目录枚举顺序影响 `--up / --to / --rollback`
- 审计模块不直接信任数据库原始 `order by timestamp` 结果，而是按 Kysely 相同的 `Date(timestamp)` + `name` 逻辑重新排序，避免出现“审计绿、执行红”

目录/IAM 关键表清单：

- `user_external_identities`
- `user_external_auth_grants`
- `directory_integrations`
- `directory_departments`
- `directory_accounts`
- `directory_account_departments`
- `directory_account_links`
- `directory_sync_runs`
- `directory_template_centers`
- `directory_template_center_versions`
- `directory_sync_alerts`

### 3. 类型层补齐

实现位置：

- `packages/core-backend/src/db/types.ts`

补齐表：

- `user_external_identities`
- `user_external_auth_grants`
- `directory_integrations`
- `directory_departments`
- `directory_accounts`
- `directory_account_departments`
- `directory_account_links`
- `directory_sync_runs`
- `directory_template_centers`
- `directory_template_center_versions`
- `directory_sync_alerts`

同时把这些表登记到 `Database` 顶层接口里，避免目录服务继续在“migration 已有、类型未知”的半脱节状态上运行。

### 4. Git 基线报告

实现位置：

- `scripts/ops/git-baseline-report.mjs`
- 根 `package.json` 的 `verify:git-baseline`

输出内容：

- 当前分支
- upstream
- ahead / behind
- dirty 与文件数
- 顶层目录桶分布
- 建议动作

目标不是自动整理 Git，而是先把“当前基线到底乱在哪里”固化成正式报告。

## 新增脚本入口

### package-level

`packages/core-backend/package.json`

- `db:audit`
- `db:list`
- `db:rollback`
- `db:reset`

### root-level

`package.json`

- `verify:directory-migration-health`
- `verify:git-baseline`

## 非目标

本轮不做：

- 自动修正远端 `kysely_migration` 漂移记录
- 自动生成手工补表 SQL
- 远端 destructive reset/rollback 自动执行
- GitHub 分支自动整理/自动提交

补充说明：

- 远端 `142.171.239.56` 最终仍需要把这套修复正式烘进镜像和宿主机源码目录；容器热注入只用于把现网恢复到一致状态，不应作为长期发布方式。

## 结果

本轮交付后，目录/IAM 这条线从“只能靠人工记忆和远端日志修 migration 问题”，提升为：

1. 有正式 CLI
2. 有正式审计输出
3. 有类型层闭环
4. 有正式的 Git 基线报告
5. 有可复查的远端迁移修复前置证据

这一步属于工程基线强化，不是表面 UI 增量，但对后续远端升级、GitHub 收口和现网迁移治理的价值更高。
