# supertest 串台验证切片 — 25×2 压力 A/B 原始证据 — 2026-07-17

> 配套 PR：pinned-server 验证切片。本文固化压力对照的入口、原始结果与诚实解读，
> 供批量迁移决策与未来复跑对照。复跑入口：`scripts/ops/supertest-crosstalk-stress.sh
> <core-backend-dir> <arm-name> [runs]`（retry=0，全量 `tests/unit`；两臂**必须串行**执行——
> 并行会让两臂的临时端口互相污染测量）。

## 1. 口径

- 每臂 25 轮全量 `npx vitest run tests/unit --retry=0 --reporter=dot`；
- 基线臂 = origin/main `9048c27e2`（未迁移）；迁移后臂 = 切片分支（helper + 3 suite 迁移）；
- 机器：本地 darwin（非 CI runner）——绝对比例在 CI 上可能不同，机制同类（#4169 已在 CI 侧
  证过同型签名）；
- 红轮判定 = vitest 退出码非 0；每个红轮保留失败 suite 清单与错误签名。

## 2. 原始结果

| 臂 | 红轮 | 红轮明细（suite → 签名） |
|---|---|---|
| 基线 | **3/25**（run 3/9/19） | run_3: approval-template-routes → `expected 405 to be 404`（打错 app）；run_9: correlation + plugin-runtime-teardown → socket hang up ×4 + ECONNRESET（一轮双 suite）；run_19: snapshot-labels-authz → socket hang up ×2 + ECONNRESET |
| 迁移后 | **3/25**（run 5/23/25） | run_5: plm-workbench-bom-multitable-routes → socket hang up ×2 + ECONNRESET；run_23: approvals-bridge-routes → socket hang up ×2 + ECONNRESET；run_25: multitable-ai-usage-summary-route → `expected 200 "OK", got 405 "Method Not Allowed"`（打错 app） |

- 6 个红轮 = **6 个不同的受害文件，无一重复，无一是迁移对象**；签名全部属于串台类
  （socket hang up / ECONNRESET / 405 打错 app），未混入其他根因。
- **3 个迁移 suite 在两臂共 50 轮全量运行中 0 失败**（此外 4 文件/64 测的单独运行恒绿）。

## 3. 诚实解读（owner round-1 复审口径）

- **积极统计证据，不是结构性免疫证明**：固定 listener 保护该 suite 自己的请求不再逐请求换端口
  （绑定期内其请求只会到达自己的 app）；但 suite **首次绑定**仍可能复用一个未迁移 listener
  刚释放的端口，成为**迟到请求的目标**——即 collider 角色是「从逐请求降为每 suite 至多一次」，
  不是归零。0/50 应读作强统计证据 + 机制论证，不作结构性证明表述。
- **部分迁移不降低 lane 级串台率**（3/25 → 3/25）：受害者在剩余未迁移文件间轮转。根除需要
  批量迁移；**全部迁完之前 `retry:2`（CI）必须保留**。
- 防回归：`tests/unit/supertest-app-mode-tripwire.test.ts`（AST 级）冻结 app-mode 站点基线
  （45 文件 / 636 站点，`tests/utils/supertest-app-mode-baseline.json`）——新文件/新增站点即红，
  迁移波次后用 `UPDATE_SUPERTEST_APP_MODE_BASELINE=1` 重生成基线锁住下降。

## 4. 批量迁移建议（owner 有条件 GO 的执行形态）

- 分批（按文件簇/每波 ~10 文件），每波：迁移 → 波内 suite 单独绿 → tripwire 基线重生成 →
  全量一轮绿即可合（lane 级 A/B 不必每波重跑；终波跑一次 25× 收官对照）；
- 例外模式（不适用直迁 recipe）：参数化 per-test builder（5 文件，需 mutable-holder 变体）、
  已运行真实 listener 的 suite（跳过）、CI-excluded 的 `multitable-sheet-permissions.api.test.ts`
  （跳过）；
- 全部迁完（基线清零）后：删除 `retry:2` 并跑终局 25× 对照，预期 0/25。
