# ops-sql-pack-verify CI lane — design (2026-09-20)

## Q6: 只读 SQL 包 verify 套件的独立 CI 泳道

## 问题

两个 owner-facing 只读/半自动 SQL 包各自带着自己的 `verify/*.test.mjs` 自证套件：

- `scripts/ops/readonly-inventory-20260916/verify/readonly-inventory-pack.test.mjs`
- `scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs`

`.github/workflows/` 里零处引用这两个套件（`grep -r readonly-inventory .github/workflows`
零命中）。两个套件都是标准的两层结构：

- **LAYER 1（hermetic）**：对包内 `.sql` 文件做纯文本/正则契约检查（前导片段、
  只读/无写语句、INVENTORY_RESULT 收尾行、hit CTE 共享等）。不连数据库。
- **LAYER 2（DATABASE_URL 门控）**：调用同目录 `run-verify.mjs`，对一个真实
  PostgreSQL 实例创建/删除自己的一次性 `*_fixture_*` schema（和/或角色），跑
  完整的合成场景验证（F3/F4/F5/F6 或 S1..S12 + M1..M4）。

两个套件的 LAYER 2 都有 fail-not-skip 哨兵：`METASHEET_REAL_DB_TEST_STEP=1` 时
缺 `DATABASE_URL` 或缺 `psql` 直接 `assert.fail`，不允许静默跳过绿：
- `readonly-inventory-pack.test.mjs:173-192`
- `live-id-fk-validate-pack.test.mjs:264-273`

`run-verify.mjs` 里 `createFixture` / `checkPermissionDeniedIsIncomplete` 会自建
自删 schema/role（`readonly-inventory-20260916/verify/run-verify.mjs:132` /
`:139` / `:387` 一带），需要 service 用户具备 superuser 权限——`postgres:16`
官方镜像的默认 `postgres` 用户满足。

## 为什么不挂进 `plugin-tests.yml`

`plugin-tests.yml` 的 `test` job 里已有一个 real-DB 步骤，但它被
`scripts/ops/ci-realdb-step-contract.mjs` 钉死为：

> (c) 一次 `vitest --config vitest.integration.config.ts` 调用；
> (d) 目标测试文件必须是**同一次调用**的整文件参数。

这两个 `node --test *.mjs` 套件既不是 vitest 调用，也不需要
`pnpm install`/`vitest.integration.config.ts` 这套依赖链，硬塞进去会破坏
(c)/(d) 的联合不变式，也会把这条本来很快的 required 泳道拖上一层不必要的
pnpm 安装。两个套件也不引用应用代码依赖——只用 Node 内建模块 + runner 自带
的 `psql`。

## 同形先例

- **两层拆分的形状**：`approval-s1-evidence-replay-gate.yml`（hermetic 静态层，
  跑在每个 PR 上）+ `approval-s1-evidence-replay-gate-realdb.yml`（DB 门控执行
  层，独立小泳道，`postgres:16` service，字面量 `DATABASE_URL`，
  `METASHEET_REAL_DB_TEST_STEP: '1'`，runner 自带 `psql`，`node --test` 直跑，
  不装 pnpm）。同一形状也用在
  `multitable-o2-observation-kit(-realdb).yml`。
- **hermetic-only 泳道的形状**：`data-source-exposure-inventory.yml:37-48` 的
  `contract` job——只有 `checkout@v4` + `setup-node@v4`，`node --test` 直跑，
  没有 pnpm install，没有 service container。

`ops-sql-pack-verify.yml` 把这两个先例拼在一起，用 **同一个 workflow 文件**
承载两个 job（`hermetic` 和 `execution-proof`），并用
`strategy.matrix.pack: [readonly-inventory-20260916, live-id-fk-validate-20260920]`
让两个包共享同一套 job 定义,而不是复制成四个 workflow 文件。

## 触发条件

`workflow_dispatch` + `pull_request`/`push(main)`，`paths` 限定在：

- `.github/workflows/ops-sql-pack-verify.yml` 本身
- `scripts/ops/readonly-inventory-20260916/**`
- `scripts/ops/live-id-fk-validate-20260920/**`

与 `data-source-exposure-inventory.yml` 同理：这条泳道只在这两个包目录（或
本 workflow 文件自己）变化时触发，不占用其它 PR 的 CI 时间。

## job 契约

### `hermetic`（matrix: 两个包）

- `actions/checkout@v4` + `actions/setup-node@v4`（20.x），**没有** pnpm
  install，**没有** service container。
- `run: node --test scripts/ops/${{ matrix.pack }}/verify/*.test.mjs`
- **绝不设置 `METASHEET_REAL_DB_TEST_STEP=1`**——两个套件的 fail-not-skip
  哨兵会把"没有 DATABASE_URL"从"跳过"升级成"失败"，这个 job 必须只跑
  LAYER 1，LAYER 2 走"SKIPPED LOUDLY"分支。

### `execution-proof`（matrix: 两个包）

- 整段照抄 `approval-s1-evidence-replay-gate-realdb.yml:47-83` 的 job 骨架：
  `postgres:16` service，`POSTGRES_DB`/`DATABASE_URL` 字面量
  `metasheet_sqlpack_verify`（专用库名，不与其它泳道共用），
  `METASHEET_REAL_DB_TEST_STEP: '1'`。
- `run: node --test scripts/ops/${{ matrix.pack }}/verify/*.test.mjs`
  ——同一条命令，同一份 test 文件；这次两个套件的 LAYER 2 会真正跑起来。

## 契约冲突排查

- `grep -rn "ci-realdb-step-contract" scripts/ops` 命中的全部是各条
  `*-ci-wiring.test.mjs`（各自扫描 `plugin-tests.yml` 的 matrix 真实 DB
  步骤）+ `.github/workflows/plugin-tests.yml` 本身。没有任何一处把
  `ci-realdb-step-contract` 的四项钉死条款套用到"仓库里所有带
  `postgres` service 的 job"这种全局范围——它只解析
  `plugin-tests.yml` 这一个文件。新增 `ops-sql-pack-verify.yml` 不触碰
  `plugin-tests.yml`，因此不会撞上这份契约。
- `grep` 未发现任何 `readdirSync`/`glob` 风格、遍历 `.github/workflows/`
  全目录的通用型 CI 结构守卫。

## 本地验证方式

见同名 `-verification-20260920.md`。
