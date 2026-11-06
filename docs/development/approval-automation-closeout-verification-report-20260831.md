# 审批与流程自动化收尾验证报告（2026-08-31）

**Status:** CODE / MIGRATION VERIFICATION RECORD。验证对象为仓库源码与隔离测试环境，
不等价于 staging、生产、真实租户或开关启用验收。

## 1. 验证对象

| PR | exact head | merge commit | 作用域 |
|---|---|---|---|
| #5368 | `09ea473a30b25e995f5eb9bd29ab0bcfb15474ba` | `21932d08be7bbf71de495339b49bce5906b98a7c` | Lock-4 F4-B / F4-D / F4-E，17 文件，无迁移 |
| #5365 | `1ea46d1c37a4544a4bc36229b68cb8a206e30540` | `6d7cd1e76a51127aadd3ed9fcb91db64af722f5d` | guarded `real_fire`，22 文件，1 迁移 |
| #5367 | `4756db7f34936d83f5b4209498753f624e350637` | `1a936c7dbfb3e62dd3e05b60f91cecbd28862e45` | retry evidence，7 文件，2 迁移 |
| 最终报告基线 | — | `19f43285f4335ac325485b779afd73d210f9deb9` | 上述三个 merge commit 均为祖先 |

## 2. 证据分层

| 层 | 结论 |
|---|---|
| 生产源码调用链 | PASS：F4-E 生产 caller、`real_fire` 路由 / 服务、retry 入口均存在 |
| 本地 focused / neighbor | PASS，见 §3 |
| 隔离 PostgreSQL 15 | PASS，见 §3；数据库均清理为零残留 |
| 判别 mutation | PASS：中和关键守卫后目标测试变红，恢复后全绿 |
| exact-head CI | PASS，三个 PR 均零失败 / 零 pending 后才合并 |
| merged-main CI | PASS，三个 merge commit 均完成各自 push 组合门 |
| 最终报告基线 combined-main | PASS：**25 / 25 push workflows SUCCESS**，0 pending / failure |
| staging migration / UAT | NOT RUN |
| production migration / deploy / UAT | NOT RUN |
| flag activation | NOT AUTHORIZED / NOT RUN |

## 3. 本地与真库执行

### 3.1 #5368 Lock-4

- focused / neighbor：11 个文件，**377 / 377**；
- PostgreSQL **15.17** fresh migrated：6 个 integration 文件，**82 / 82**，0 skipped；
- core-backend typecheck：PASS；
- scoped ESLint：0 error，`ApprovalProductService.ts` 有 3 个基线既存 warning；
- `git diff --check`：PASS；
- fixture residue：integration、user、trigger function、trigger 均为 0；实例与数据目录已移除。

真库故障注入同时证明：目录事务已提交；F4-E dispatch 恰尝试一次；邀请台账 / 单用户故障不把 run
从 `completed` 降级为 `failed`；错误、用户与 instance 值不进入公开证据。

### 3.2 #5365 guarded real-fire

- focused / neighbor unit：9 个文件，**386 / 386**；
- fresh PostgreSQL 15 migration + realDB：4 个文件，**49 / 49**；
- core-backend typecheck：PASS；
- scoped ESLint：0 error，3 个基线既存 warning；
- `git diff --check`：PASS；
- fixture residue：0；隔离数据库和 PostgreSQL 已移除。

该真库证据覆盖持久 ledger / claim / approval continuation；外部服务仍由测试替身或保护门隔离，
因此不能写成“真实外部系统写入已验收”。

### 3.3 #5367 retry evidence

- PostgreSQL **15.17** fresh migration apply：PASS；
- 两个新增迁移分别 down / up：PASS；
- integration：**45 / 45**；down / up 后 retry integration：**7 / 7**；
- focused / neighbor unit：9 个文件，**400 / 400**；
- core-backend typecheck：PASS；
- scoped ESLint：0 error，1 个基线既存 warning；
- fixture residue：execution、rule、Class-A / Class-B、sample、user 均为 0。

## 4. 判别 mutation

| 切片 | 中和项 | 预期结果 |
|---|---|---|
| F4-B | designated eligibility / unknown-state 拒绝 | 对应资格或真库负例 RED |
| F4-D | prior-node round / dedup 例外判定 | 对应历史边界负例 RED |
| F4-E | 恢复邀请在前、outer catch 耦合的旧顺序 | 混合故障真库用例 RED |
| F4-E | 去除 values-free 清洗 | hostile value 泄漏负例 RED |
| real-fire | 删除 condition `defaultBranch` 枚举 | 3 条指定断言 RED |
| real-fire | wait / resume 改回 `ledger_kind='execution'` | V2d RED |
| real-fire | approval continuation 改回 `ledger_kind='execution'` | real-fire approval identity RED |
| retry | 中和 retry-age | 过期窗口负例 RED |
| retry | 中和 manual-test 隔离 | test-run namespace 负例 RED |
| retry | 中和 missing-ledger 拒绝 | 后续重试证据负例 RED |

所有 mutation 均为临时改动，逐项恢复后重跑绿色；没有把 mutation 提交进仓库。

## 5. 远端 exact-head 与 merged-main

| PR | exact-head checks | merge 后 main checks |
|---|---:|---:|
| #5368 | **44 SUCCESS + 1 expected SKIP** | **22 / 22 SUCCESS** |
| #5365 | **25 SUCCESS + 1 expected SKIP** | **10 / 10 SUCCESS** |
| #5367 | **24 SUCCESS + 1 expected SKIP** | **9 / 9 SUCCESS** |

这些数字只绑定表内 exact head / merge commit。它们不替代后续部署 SHA 的迁移预检、环境观测或 UAT。

## 6. 生产调用链核对

### 6.1 F4-E

`directory-sync.ts` 在 commit 后动态加载并调用
`dispatchApprovalDepartureTransfersForRun`；派发器调用
`ApprovalProductService.applyApprovalDepartureTransfer`。生产 import 与 dedicated unit / realDB 同时存在，
因此旧报告的“写入器无生产 caller”结论已被新代码事实取代。

### 6.2 real-fire

`routes/automation.ts` 的 test-run 路由和 `automation-service.ts` 的 `mode === 'real_fire'` 分支均在生产源码；
显式确认、管理权限、样本可读、服务端身份、Class-A / B 保护与 unsupported-family 拒绝均在进入 live 执行前。

### 6.3 retry

路由要求 `confirmSideEffects: true`，随后调用 `AutomationService.retryExecution`。
service 读取持久 execution / rule / trigger / ledger 后决定是否允许管理员手动重跑。仓库没有由本切片新增的
自动 retry worker；测试与报告均不得把手动入口写成自动恢复。

## 7. Refute-first 结论

- #5368 最终 self-review：0 P1 / 0 P2；外部 Grok 在限定时间内未给终态，不作为裁决来源；
- #5367 fix-forward 后 refute-first：0 P1 / 0 P2；
- #5365 以 exact-head CI、focused / realDB 与 mutation 作为落地证据，不补写未发生的独立模型裁决；
- 当前收尾报告未发现新的 P1 / P2。

## 8. 未被本报告证明的事项

1. 三个迁移在 staging / production 的 applied / pending 与 schema diff；
2. 目录停权 flag 开启后的真实组织 F4-E UAT；
3. `real_fire` 对真实外部系统的端到端写入和补偿；
4. 生产 retry 的运维演练、并发点击与真实告警消费；
5. `auto_reject`、`signaturePolicy` enforcement、节点内 `sequential`；
6. #5174 / #5182 / #5183 的 owner ratify；
7. `PRODUCT-FINAL` 或生产可用签署。

## 9. 最终判定

| 判定 | 状态 |
|---|---|
| 已 ratify 范围的源码闭环 | **PASS** |
| 专属单测 / 真库 / mutation | **PASS** |
| exact-head CI | **PASS** |
| 各 merge commit 的 combined-main CI | **PASS** |
| 最终报告基线 combined-main | **PASS：25 / 25 push workflows SUCCESS** |
| staging / production 交付 | **NOT RUN** |
| owner 完成标签 | **NO** |

结论：本轮可以关闭“F4-E 无生产 caller”“guarded real-fire 未落地”“retry 证据边界未闭合”三项代码欠债；
不能关闭部署、开关、真实外部写入、UAT 或产品最终签署。
