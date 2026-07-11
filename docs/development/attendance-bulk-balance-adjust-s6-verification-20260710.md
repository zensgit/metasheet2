# 考勤年假余额批量调整（S6）验证报告 — 2026-07-10

> 余下开发总目标池（#3925 计划）之 **S6**。PR **#4023** MERGED `dbf23627a`。
> design-lock：`attendance-bulk-balance-adjust-s6-design-lock-20260710.md`。**零后端改动**
> （diff 仅 apps/web + docs + workflow，审阅全量核实）。

## 1. 交付

- 纯 FE 编排：`bulkBalanceAdjust.ts` helper + 年假运营卡批量子区（`data-annual-ops-card="bulk-adjust"`），
  客户端顺序循环既有单人端点 `POST /api/attendance/annual-leave-manual-adjustment`。
- user-picker 选人（≤50，超限拒绝**不静默截断**）；共享 {deltaMinutes, reason}；**每人独立 idempotencyKey
  在快照期一次性生成并冻结**；annualOpsConfirm 两步确认（delta<0 附 G3 台账不可逆注记）；
  completed_with_errors 部分失败语义（任何行失败绝不谎报全成）；retry 只重跑非 ok 行且**复用原 key**。
- **范围诚实（OUT 逐项点名）**：annual only（comp_time 无单人 primitive = 命名前置）；无 roster 端点故
  user-picker（「浏览全员余额再选」= 新读端点另立项）；多人备份导出 = 文档化缺口；无 batch_id
  （逐行独立 registry 行）；无服务端批量端点。

## 2. 对抗审阅（opus，refute-first）

审阅 MD：`/tmp/pr4023-s6-review-claude-20260710.md`（head `15ddbdec0`）。判定
**CHANGES-REQUESTED（0 P1 · 1 P2）→ P2 修复后过门**。

- **头号 P1 向量（重试双次应用）被反驳，且发现架构亮点**：S6 在快照期生成 key 冻结进 rows、retry 复用
  存档数组——**刻意偏离镜像 scheduleBulkApply**（后者在 submitOne 内每次重生成 key：对 target-keyed
  排班安全，但对只按 source_key 去重的余额 delta 会造成「响应丢失但服务端已落 → 重试双扣」）。
  偏离方向正确、比镜像更谨慎。
- **P2-1（已修 `f7621ad3a`）**：该承重守卫零测试——审阅 mutation 证明把 retry 改回「向镜像看齐」的
  重生成 key 后 **121 个 DOM 测试仍全绿**（静默重引入双扣 P1 的最自然重构路径无测试拦截）。
  修复 = partial-failure 用例断言 retry body 携带与首次相同的 key；修复后同 mutation 复验 **红**。
- NIT：403 per-row 不短路（全局权限门下至多 50 发必败请求，合理简化且已披露）；TOCTOU 结构安全
  （快照经 onConfirm 闭包捕获）。
- 实跑：142/142（21 纯 helper + 121 DOM）· vue-tsc exit 0 · web-guard 三点接线齐（双 path-filter + run-list）·
  mutation 四刀（cap / retry-skip-ok / 聚合 / key 稳定性）全部红/绿闭环。

## 3. 过程记录

Sonnet 单刀完成（含中途 rebase 过 S3 #4008）；P2-1 由主循环按审阅修法落地并 mutation 验牙。

## 4. 账本归属

tracker 批量操作行：批量异常 #3530 ✅ + 排班 bulk-apply #3642 ✅ + **余额批量（annual）✅本刀**。
后续相关：comp_time 单人调整 primitive（前置未立项）；roster 余额读端点（按需另立）。
