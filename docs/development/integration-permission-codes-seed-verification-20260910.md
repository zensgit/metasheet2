# G09 验证:`integration:*` / `data_sources:*` 六码种子化(2026-09-10)

设计见 `integration-permission-codes-seed-design-20260910.md`。本机 Windows,**无本地 PostgreSQL**。

## 1. 改动文件

| 文件 | 性质 |
|---|---|
| `packages/core-backend/src/db/migrations/zzzz20260910120000_add_integration_permissions.ts` | 新增,种子六码 |
| `packages/core-backend/tests/unit/integration-permission-codes-seed.test.ts` | 新增,18 项 |
| `plugins/plugin-integration-core/app.manifest.json` | 新增 `platformPermissions` 键(`permissions` 数组**未动**) |
| `plugins/plugin-integration-core/__tests__/app-manifest.test.cjs` | 扩充:平台层对账 + 两词表不得互串 |
| `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md` | 新增 §5-6 角色模板 |

## 2. 命令与退出码

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/integration-permission-codes-seed.test.ts` | 18 passed (1 file) | 0 |
| 2 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/platform-app-manifest-files.test.ts tests/unit/platform-apps-router.test.ts` | 27 passed (2 files) | 0 |
| 3 | `pnpm --filter @metasheet/core-backend run type-check` | `tsc --noEmit` 无输出 | 0 |
| 4 | `node plugins/plugin-integration-core/__tests__/app-manifest.test.cjs` | `✓ app-manifest: BOM备料 declared — 2 managed objects, 3 permission codes, …` | 0 |
| 5 | `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | `sealed-export-package-provenance.test.cjs OK` | 0 |
| 6 | `node plugins/plugin-integration-core/__tests__/stock-preparation-permission-matrix.test.cjs` | 通过 | 0 |
| 7 | `node plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs` | 通过 | 0 |

命令 #2 的意义:`platform-app-manifest-files.test.ts` 用**真实 zod schema 解析真实的 `app.manifest.json`**,
所以它绿 = 新增的 `platformPermissions` 顶层键不会让清单解析失败(未知键被丢弃,非报错)。
命令 #4 自报 **3 permission codes**,即应用自身词表未被扩大——这正是本次刻意保持的。
命令 #5 复核 `app.manifest.json` 不在溯源 pin 覆盖内,无需重打 pin(66 项 pin 未受影响)。

## 3. 变异表

全部为**内存变异,不落盘**:探针读真实文件,在内存里改副本,再要求同一个断言函数抛错。
前两组是测试文件里的常驻用例(每次 CI 都跑),第三组是一次性探针脚本(跑在临时目录,不入库)。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| M1 | 从迁移 `VALUES` 里删掉六码中的**任意一个**(逐个试遍 6 次) | 对账抛 `enforced but never seeded` | 红 ✓ |
| M2 | 网关多出一个没被种子化的动作(`data_sources:truncate`) | 对账抛,指出该码 | 红 ✓ |
| M3 | 去掉 `ON CONFLICT (code) DO NOTHING`(改的是迁移**自己发出的真实 SQL**) | 第二遍抛 `duplicate key value` | 红 ✓ |
| M4 | 在 `up()` 里加 `INSERT INTO role_permissions … ('admin', …)` | 「零自动持有」守卫抛 `only seed permission rows` | 红 ✓ |
| M5 | 断言不空转的反证:对**已在**豁免名单里的资源(`multitable`/`workflow`/`approvals`/`admin`)求值 | 全部 `false` / `null` | 符合 ✓ |
| M6 | 网关多出 `integration:execute`,清单与迁移未跟进 | 清单对账 `codes mismatch` | 红 ✓ |
| M7 | 清单 `platformPermissions.codes` 删掉 `integration:admin` | `codes mismatch` | 红 ✓ |
| M8 | 整个 `platformPermissions` 键删除 | `platformPermissions missing` | 红 ✓ |
| M9 | `seededBy` 改指向 stock-prep 那支迁移(存在但没种这些码) | `integration:read not seeded` | 红 ✓ |
| M10 | 把 `integration:write` 塞进应用自身的 `permissions` 数组 | `leaked into app vocabulary` | 红 ✓ |

M5 是给 §「两个命名空间仍受准入管控」那条断言做的反证:如果该断言恒真,它就证明不了任何事;
M5 证明同一个函数对豁免资源确实答 `false`,所以一旦有人把 `integration`/`data_sources` 加进豁免名单,
那条断言会红。M10 是给第 5 节那个判断做的守卫:防止后来者把平台层码并回应用词表,重新引入
「给一线的码讲错」的交付回归。

## 4. 交给 CI / 未做

- **真库重放**:本机无 PostgreSQL,`db:migrate` 跑两遍的真库幂等验证交给 CI 的 migration-replay 泳道。
  本机以「模型化 `permissions` 主键 + `ON CONFLICT` 语义」的内存模拟覆盖了同一性质(见 M3)。
- **222 上机验证角色模板**:§5-6 的三类角色模板尚未在 222 上按真实账号逐条实测;
  其中「一线只需两个 `stock-prep` 码」一条有 2026-09-08 的既有实测背书(角色 `stock-prep-operator`,
  目录/确认队列 200),`integration`/`data_sources` 两个命名空间的准入开关未实测。
- **`/data-sources` 路由 meta 与导航谓词错配**:按分工不在本次改动内,属在飞的 #5587。
- 未跑全量 `core-backend` 单测与前端套件;仅跑了与本次改动相关的上述七条。
