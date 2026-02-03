# 考勤验收报告

日期：2026-02-02

## 环境
- 服务：`metasheet-backend`（Docker）
- 插件：`plugin-attendance`

## 验收结果
### 模板库快照
- 已同步 `docs/attendance-template-library.snapshot.json`

### 规则集 / 模板库
- 默认 Rule Set 可读取并生效。
- 组织模板库已写入，模板命中可在预览中看到。
- 新增模板：缺卡提示、迟到/早退提示（Org 级）。

### 计薪周期模板
- 新建默认模板：CN Payroll 26-25（startDay 26 / endDay 25 / endMonthOffset 1）。
- 生成接口 `POST /api/attendance/payroll-cycles/generate` 已修复：
  - created：2026-02-26~2026-03-25、2026-03-26~2026-04-25
  - skipped：2026-01-26~2026-02-25（已存在）

### CSV 预览（全量）
- Rows：11,966
- 状态统计：off 3,474；early_leave 6,770；absent 1,262；late_early 20；normal 244；partial 146；adjusted 49；late 1。
- Top rules：trip-under-8h 297；security-default-8h 248；missing-card-warning 178；late-early-warning 113；leave-but-punched 50；overtime-approval-no-punch 30；trip-overtime-conflict 30；driver-default-8h 22；single-rest-trip-overtime 4。
- 新增异常提示命中：
  - missing-card-warning 178
  - late-early-warning 113

### CSV 预览（司机）
- Rows：31
- 状态统计：off 9；early_leave 22
- Top rules：driver-default-8h 22

### CSV 预览（保安）
- Rows：248
- 状态统计：off 72；early_leave 170；absent 3；partial 2；normal 1
- Top rules：security-default-8h 248

### CSV 预览（司机 + 保安 + 单休车间）
- Rows：6,789
- 状态统计：off 1,971；early_leave 4,464；absent 349；partial 2；normal 1；late_early 2。
- Top rules：security-default-8h 248；trip-under-8h 186；leave-but-punched 25；driver-default-8h 22；single-rest-trip-overtime 4。

## 结论
- 司机/保安规则命中一致，未发现 warnings。
- 预览统计稳定，规则改动后结果可回归确认。
