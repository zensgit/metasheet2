# V2 PR（精简模板）

## 概述
- 目的/范围（≤72 字）：
- 影响面（API/插件/迁移/配置）：

## 快速导航（Docs）
- docs/V2_IMPLEMENTATION_SUMMARY.md:1（总览）
- docs/V2_EXECUTION_HANDBOOK.md:1（执行手册）
- docs/v2-migration-tracker.md:1（追踪）
- docs/v2-merge-adjustment-plan.md:1（方案草案）
- docs/v2-merge-adjustment-plan-review.md:1（评审摘要）

## 迁移（如有）
- 号段：仅追加 045/046/047/048；前置=045（空迁移/预检查）
- 自检：`npm --prefix backend run db:list` 顺序正确；`db:migrate` 空库/已有库幂等

## 插件框架（如有）
- Manifest/Context/Capabilities 字段与版本：
- Loader 失败策略：fail-open/closed/degrade + 审计

## 验证
- 健康与冒烟：`/health`、`/api/v2/hello`、smoke 脚本结果：
- 契约与错误码（422 等）不回退：
- 性能门槛（P95/P99 ≤ 既定阈值）：

## 回滚与风险
- 回滚路径：特性开关/按插件禁用/蓝绿切回
- 风险与缓解：

> 团队评审检查清单：请附到 PR 评论并按需勾选。

