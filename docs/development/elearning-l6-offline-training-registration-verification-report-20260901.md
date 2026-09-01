# MetaSheet 云课堂 L6 线下培训生命周期与报名验证报告（2026-09-01）

> 结论：PASS FOR DRAFT / HOLD PRODUCT CHECKPOINT
>
> 非结论：不是 Ready、merge、UAT、flag enablement、dispatch、deploy 或 production acceptance。
>
> 被测产品 head：`49ea490ade635304db319601d49c7a4a75a06889`
>（tree `a40a875fa67961b9ea63c7bace0b427ce6b99a52`）
>
> PR：#5412；base `bcd5c300ec515bb613fa9cb866544ff624cf5b5c`

报告提交只增加 design/development/verification 三份 MD；以下结果均绑定报告父提交中的产品树。

## 1. Exact-head 与范围

| 检查 | 结果 |
|---|---|
| branch | `codex/elearning-offline-registration-20260901` |
| base → product head | 9 commits / 43 files |
| product head/tree | `49ea490a…` / `a40a875f…` |
| PR | OPEN / Draft / MERGEABLE / CLEAN |
| auto-merge | null |
| worktree before reports | clean |
| product diff-check | PASS |

## 2. 本地验证

### 2.1 Backend 与 Web

| 门 | 结果 |
|---|---|
| backend focused unit + pilot neighbor | 39/39 PASS |
| Web focused specs | 30/30 PASS |
| required Web | 410 files / 5275 tests PASS |
| core-backend typecheck | PASS |
| Web typecheck | PASS |
| source ESLint | PASS |
| e-learning mechanical wiring | 15/15 PASS |

Web 证明范围包括：管理员发布和报名名册分页、学员报名/取消、同 payload retry identity、成功后刷新失败、跨页 cursor fail-closed、状态本地化和 flag/readiness 邻接行为。

### 2.2 OpenAPI 与 provenance

| 门 | 结果 |
|---|---|
| focused e-learning OpenAPI | 17/17 PASS |
| canonical OpenAPI build | PASS |
| validate + guard | PASS |
| official provenance frozen/live | `differenceCount=0` |
| positive provenance | PASS |
| full sealed-export S5 | PASS |

OpenAPI closed-shape 测试覆盖发布、生命周期、QR、签到/签退、报名/取消和管理员名册；内部 request hash、token digest、组织/actor authority 不在响应模型中。

## 3. PostgreSQL authority

隔离 PostgreSQL 执行父切片与报名切片组合门：

- test files / cases：11/11 PASS；
- migration apply + replay：PASS；
- down / reapply / drift：PASS；
- concurrent effect serialization：PASS；
- same request/same payload replay：PASS；
- same request/different payload values-free conflict：PASS；
- cross-org、inactive member、non-invite、archived、registration disabled：全部拒绝；
- append-only UPDATE/DELETE/TRUNCATE：全部拒绝；
- nonempty authoritative rows 的破坏性 down：fail-closed；
- scratch drain：CLEAN；
- residual backends：0；
- database prefix residue：0。

## 4. 判别 mutation

以下 mutation 都在对应 exact checkpoint 先 RED、恢复后 GREEN：

1. 从 registration request hash 删除 action；
2. 删除 registration effect advisory lock，并用确定性 barrier 构造并发；
3. 在权威 refresh 前轮换 requestId；
4. 丢弃管理员 roster 的 next cursor；
5. 删除 real-DB no-DB exclude；
6. 删除 post-migrate whole-file selector；
7. 删除 OpenAPI registration path；
8. 弱化迁移列/default/check/FK/trigger/function OID/source 审计；
9. 将 trigger 重新绑定到跨 schema 的同名弱函数。

这些 mutation 分别证明幂等 identity、并发 effect、客户端重试、分页、CI selector、API contract 和数据库 replay authority 是承重机制，而不是只存在于散文中。

## 5. 远端 exact-head CI

2026-09-01 对产品 head `49ea490ade635304db319601d49c7a4a75a06889` 的 GitHub 矩阵终态：

- SUCCESS：47；
- intentional SKIPPED：1；
- failure/cancelled/timed-out/action-required：0；
- pending/in-progress/queued：0。

承重上下文包括 Node 18、Node 20、web-tests、elearning-web-guard、migration replay、OpenAPI contracts、plugin tests、provenance/S5 与仓库邻接门。

## 6. Refute-first 结论

### P1

0 个未关闭 P1。

### P2

0 个未关闭 P2。

### P3 / 边界

0 个代码阻断 P3。以下为诚实产品边界，不是缺陷关闭证明：

- 未实现容量、候补、审批、助教、日历同步、地图、人脸；
- 未实现线下结业自动学分/证书、满意度问卷或混培；
- 未做真实浏览器 UAT、部署或生产验收；
- 该 L6 切片不替代线上培训闭环，且不是线上 MVP 的前置依赖。

## 7. 冻结结论

#5412 可以作为已实现且可独立审阅的 Draft/HOLD checkpoint 保存。报告 head 仍需自己的 exact-head CI；在 owner 单独授权前，不得 Ready、merge、启 flag、dispatch、deploy 或接触 production。
