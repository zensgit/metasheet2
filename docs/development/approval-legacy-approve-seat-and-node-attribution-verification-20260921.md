# 审批遗留决策端点：席位准入 + 服务端节点归属（验证）

**状态：CANDIDATE（候选）。未裁决、未 ratify、未合并、未开 PR。**
日期：2026-09-21 ｜ 配套设计：`approval-legacy-approve-seat-and-node-attribution-design-20260921.md`

> 本文件只写「跑了什么、读数是多少」。取证用的伪造形状与复现步骤**不在这里**，在私有 reviews：
> `~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/legacy-decision-seat-forgery-repro-20260921.md`

---

## 0. 基线

| 项 | 值 |
|---|---|
| 基点 | `origin/main` = `5edf4c3e17d3608fa4513b5ffd801142da026dcf` |
| 分支 | `fix/approval-legacy-approve-seat-and-node-attribution` |
| 改动 | 3 文件 +995/−3（`routes/approvals.ts` +257/−2、`ApprovalProductService.ts` +9/−1、新真库套件 +732）；另 `vitest.config.ts`（两点接线之一）+ 新 CI lane 文件 |
| 迁移 / DDL | **0 / 0** |
| 新错误码 | **0**（复用 `APPROVAL_ASSIGNMENT_REQUIRED`；`APPROVAL_STATUS_INVALID` 原样保留）|
| 真库 | `metasheet2_rc2_20260921`（owner `ms2testbed`，非超级；`postgres` 只用于 createdb/dropdb），`psql -Atc "SELECT current_database(), current_user"` ⇒ `metasheet2_rc2_20260921|ms2testbed` |

连接串变量普查（`grep -E "[A-Z]*DATABASE_URL|_DB_URL" .github/workflows/*.yml` + `package.json` + 源码
`process.env` 读点）得到 5 个：`DATABASE_URL`、`ATTENDANCE_TEST_DATABASE_URL`、
`E2E_S6A_PROVISIONING_DB_URL`、`E2E_S6A_RUNTIME_DB_URL`、`SMOKE_DATABASE_URL`；跑真库时全部 export
指向上面那一个一次性库。

## 1. 静态

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit -p packages/core-backend/tsconfig.json` | **0 错误** |
| `CI=true npx vitest run`（core-backend 全量，无 DB 默认配置）| **958 文件通过 / 175 skipped（1133）；15300 用例通过 / 1611 skipped（16911）；EXIT=0** |

## 2. 新真库套件

`packages/core-backend/tests/integration/approval-legacy-decision-seat-and-node-attribution.db.test.ts`

**10 tests / 10 passed**（含 `EXPECT_DB=1` 反空转绿哨兵）。

| 用例 | 断言要点 |
|---|---|
| (1) 无席位 × legacy `/approve` | 403 `APPROVAL_ASSIGNMENT_REQUIRED`；`approval_records` 行数差 **= 0**；status/version 不变 |
| (2) 无席位 × legacy `/reject` | 同上 |
| (3) 有席位诚实调用（正控）| 200；恰好 **+1** 行；`metadata.nodeKey = 'approval_a'`（服务端值）；`nodeEntryEpoch` 为整数 |
| (4) 有席位 × 自报**别的**节点/轮次（判别腿）| 200；存的是**服务端**值；调用方无关键（`clientNote`、`nested`）逐字保留 |
| (5) role 席位：同一 viewer / 同一 token，只差一条 `user_roles` 行 | 无行 ⇒ 403 + 零行；有行 ⇒ 200 + 服务端 `nodeKey`。`RBAC_TOKEN_TRUST=false`，角色只能来自 DB |
| (6) 轮次：本节点已结算的审批人 | 403 + 零行；**前提检查**先证明他在本单上仍有 assignment 行（`COUNT > 0`）|
| (7) 状态：终态实例 | 仍是 400 `APPROVAL_STATUS_INVALID`（对无席位者与原审批人**两者**都断言）；席位闸没有把 400 变成 403 |
| (8) 非席位闸（无 published definition 的 platform 行）| 仍 200（现状不变）；客户端 `nodeKey`/`nodeEntryEpoch` 被剥离且**不**补服务端值；`keep` 键保留 |
| (9) `/actions` 平价 | 同一个无席位者在**两道门**上都是 403 + 同一错误码 + 零行；有席位者经 `/actions` 的行同样是服务端 `nodeKey` |

### 2.1 Mutation（证明每条腿承重）

一律 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp` 校验；全程未用 `git checkout --` / `reset --hard` / `stash`。

| Mutation | 改动 | 结果 |
|---|---|---|
| **M1** 摘掉席位闸 | 两处 `if (!seat.allowed) {` ⇒ `if (false as boolean) {` | **5 failed / 5 passed**，红的是 **(1)(2)(5)(6)(9)** —— 全部准入腿 |
| **M2** 摘掉归属剥离 | 两处 `JSON.stringify(attributedMetadata)` ⇒ `JSON.stringify(metadata)` | **4 failed / 6 passed**，红的是 **(3)(4)(5)(8)** —— 全部归属腿 |

两个 mutation 的红集合**不相交地覆盖**了 9 条腿中的 8 条（(7) 状态腿刻意对两者都免疫：它断言的是
「新闸**没有**改变已有拒绝的身份」，对两个 mutation 都应该保持绿 —— 这正是它的判别力所在）。

还原后 `cmp` 通过，`routes/approvals.ts` sha256 = `81ab41f8a646e3f72173b67c58f8a5fcef4e56816dc57d319d26ea7af410849b`。

## 3. 邻接既有套件（回归）

| 套件 | 结果 |
|---|---|
| `approval-revoke-terminal-guard.db.test.ts` + `approval-can-decide-current-node.db.test.ts` | **15/15 通过**（两文件）。前者是本变更**唯一**受影响的仓内 legacy-route 消费者（设计 §4 #6）|
| `tests/unit/approvals-routes.test.ts` | **12/12 通过** |

## 4. 两点接线

新增真库套件 ⇒ 两点：

1. `packages/core-backend/vitest.config.ts` 的 `exclude` 加入该文件（**已核**：默认无 DB 配置下
   `vitest run <该文件>` 报 `No test files found, exiting with code 1`，即它确实被排除、不会 collect-and-skip-green）；
2. 新增独立 lane `.github/workflows/approval-realdb-legacy-decision-seat.yml`（整段抄 sibling
   `approval-realdb-can-decide-current-node.yml`，改名/改路径），`EXPECT_DB=1`、整文件 `--reporter=verbose`、
   ephemeral postgres:16。**`plugin-tests.yml` 逐字未改**（避免 s6a 重新钉包）。YAML 已用 `yaml.safe_load` 解析验证。

## 5. 未做的事（写出来，不装作验过）

- **未开 PR、未合并、未 undraft。** 分支已 push，仅此。
- **OpenAPI 未改**（设计 §8-1）：两条端点原本就声明了 `403`，且请求 schema 未变，所以本轮不动
  `src/paths/approvals.yml`，也不重生成 `dist/`。
- **生产库 pre-fix 遗留行未普查**（设计 §5.4）。
- **仓外消费者无法枚举**（设计 §4 末段）：兼容性论证是「新拒绝只命中从未持有合法席位者」，
  不是「已证明不存在其他消费者」。
- **本变更不修「裸终结」**（设计 §6 末段）：被准入之后这两条端点的行为一字未改。
- **PostgreSQL 版本**：本轮读数取自本机 PG（`ms2testbed`），CI lane 用 `postgres:16`；生产 PG15 轴未在本轮跑。
