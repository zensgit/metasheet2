# 目录集成能力状态：存储结构与只读展示验证说明 — 2026-11-06

设计说明：`docs/development/directory-integration-capabilities-structure-design-20261106.md`

## 本机已跑（无 PostgreSQL / docker / 应用）

- 新增与相邻 vitest 文件：Node 20.20.2 与 Node 24.14.1 各一遍。
- `tsc --noEmit -p tsconfig.json`。
- `node --test scripts/ops/plugin-tests-parallel-contract.test.mjs`、`node --test scripts/ops/global-history-flag-manifest.test.mjs`。
- 不带数据库、带 `EXPECT_DB=1` 运行真实库测试文件：哨兵用例失败（退出码非 0）；不带 `EXPECT_DB` 时全部跳过（退出码 0）。

## 本机未跑

- `tests/integration/directory-integration-capabilities.db.test.ts` 的数据库内用例：由 CI 的 approval-db 车道（`approval-real-db-integration` 步骤，`EXPECT_DB=1`）执行；日志须显示该文件实际执行的用例数且零跳过。
- `migration-replay.yml`、`migration-prod-image-parity.yml` 针对本 head 的结果与迁移前 `migrate --list` 的待执行清单：随 CI / 部署记录。

## 变异覆盖

每个守卫都有对应变异：改动 → 跑测试变红 → 恢复并核对 sha256。覆盖：开关谓词、服务在开关关时的查询、注册表、判定各检查及其顺序、探测方式、视图字段、鉴权与开关顺序、导入边界与表名普查、CI 接线各环节、开关登记、挂载登记、哨兵位置与日志内容。
