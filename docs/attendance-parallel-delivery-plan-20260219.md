# 考勤插件并行开发执行计划（2026-02-19）

## 目标与边界

- 目标：在现有 production-ready v1 的基础上，完成“门禁策略强化 + 导入性能与一致性 + 前端运营可用性”的并行交付闭环。
- 范围：仅限考勤插件（打卡、调整、审批、导入、报表、管理配置）。
- 非范围：Payroll（薪资结算）与 CAD/PLM 深改不在本阶段。

## 并行工作线

- A 线（平台/门禁）：分支保护策略、GA gates、drill/recovery、daily dashboard 映射。
- B 线（后端/导入）：导入任务可观测字段、idempotency/upload 一致性、100k+ 性能路径。
- C 线（前端/体验）：Admin Center/导入链路可恢复交互、移动端降级一致性、Playwright 回归。

## 已完成（本次执行）

### A 线：`1+2` 已落地

1. 分支保护目标策略已应用到 `main`：
   - `required_pull_request_reviews.enabled=true`
   - `required_approving_review_count=1`
   - `require_code_owner_reviews=false`
2. 脚本默认策略升级（避免人工触发时回退）：
   - `scripts/ops/attendance-ensure-branch-protection.sh`
   - `scripts/ops/attendance-check-branch-protection.sh`
3. workflow 默认策略升级：
   - `.github/workflows/attendance-branch-policy-drift-prod.yml`
   - `.github/workflows/attendance-branch-protection-prod.yml`
4. drill/recovery + dashboard 验证：
   - Drill FAIL: run `#22184974691`（Issue `#197` OPEN）
   - Recovery PASS: run `#22185012785`（Issue `#197` CLOSED）
   - Dashboard PASS: run `#22185048468`（`gateFlat.protection.runId=22185012785`）

### B 线：导入任务状态字段扩展（向后兼容）

已实现并验证：

- `POST /api/attendance/import/commit` 响应新增 `engine`（`standard|bulk`）。
- `GET /api/attendance/import/jobs/:id` / async job 映射新增：
  - `engine`
  - `processedRows`
  - `failedRows`
  - `elapsedMs`
- async job payload 追加紧凑 summary 元数据，避免丢失状态字段。
- 集成测试已补断言并通过：
  - `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - 证据日志：
    - `output/playwright/attendance-next-phase/20260219-221631-import-job-fields/attendance-import-job-fields.log`

## 进行中（D2-D7）

### A 线

- 将 branch policy drift 的 remediation 提示细化为“可直接执行”的操作序列（含 review policy drift 场景）。
- 统一 strict/perf/dashboard artifacts 命名与 summary 字段（减少人工比对成本）。

### B 线

- 导入 100k 基线：
  - 默认走 upload 通道（`csvFileId`）+ async commit。
  - 建立 `100k` 常规基线和 `500k` 回归保护场景。
- COPY/staging 快路径设计评审与落地（50k+ 自动切换，不改变现有 API 语义）。

### C 线

- Admin Center 操作错误分类（权限、限流、token、服务不可用）与可恢复动作统一。
- 导入 UI 的“进度/重试/恢复入口”一致化。
- 移动端 Desktop-only 区域降级文案统一并回归 Playwright。

## D8-D10 封板标准（Go/No-Go）

- Strict Gates twice 连续 PASS（2 轮）。
- Playwright Desktop + Mobile 连续 PASS（2 轮）。
- Perf baseline（100k, `upload_csv=true`）PASS。
- Perf longrun（upload 路径）PASS。
- 无 open 的 `[Attendance P0]` / `[Attendance P1]` issue。

## 证据目录规范

- 统一落盘：`output/playwright/ga/<runId>/...`
- 本地开发验证：`output/playwright/attendance-next-phase/<timestamp>-*/...`
- 文档中仅记录 runId、issue 链接、evidence 路径；禁止写真实 token/secret。
