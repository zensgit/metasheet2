# 考勤年假余额批量调整（S6 bulk balance edit）design-lock — 2026-07-10

> Status: RATIFIED（余下开发总目标池 #3925 之 S6）
> 缺陷定性：批量异常处理（#3530）与排班 bulk-apply（#3642）已落，余额侧批量往返为 0。本刀 = 年假余额批量调整，零后端改动的 FE 纯编排。

- **G1 范围 = annual only**：comp_time 无单人调整 primitive（手工 grant 无诚实 overtime_source）→ 前置独立立项，不在本刀。
- **G2 选择面 = user-picker**（镜像 scheduleBulkApply）：无全员余额 roster 端点，「浏览全员余额再勾选」= 新读端点 = 更大切片，OUT。
- **G3 执行模型**：客户端顺序循环单人端点；新 FE 纯 helper；共享 {deltaMinutes, reason}；每人独立 idempotencyKey；上限 50（1..50 超限拒绝绝不截断）；每行守卫映射 per-row 结果非全局中止（404/422/409 → 行级错误）。
- **G4 两步确认**：复用 annualOpsConfirm 形状（人数/共享 delta/原因/delta<0 附 G3 台账不可逆注记）；不做强制服务端 preview；不做备份导出（export 单人限定 = 文档化缺口）；批量入口受同一 FE annualOpsPolicyEnabled 门。
- **G5 部分失败**：任何行失败 → completed_with_errors 绝不谎报全成；retry 只重跑非 ok 行；「X applied, Y failed」计数。
- **G6 审计**：逐行独立 attendance_leave_manual_adjustments registry 行（per-user source_key）；不加 batch_id。
- **G7 测试**：纯 helper 单测（cap/key 互异/retry 过滤/聚合）+ FE 回归 wire 断言 + mutation 三刀；底层逐人语义靠既有 L2c 集成测试，零新后端故不加集成测试。

OUT：comp_time 批量；roster 读端点；多人备份导出；batch_id；后端 kill-switch；服务端批量端点。
