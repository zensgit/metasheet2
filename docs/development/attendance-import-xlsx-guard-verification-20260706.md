# 考勤导入 XLSX 拦截 + 错误可读性（R1+R2）验证报告 — 2026-07-06

> PR #3694 MERGED（squash `6945f035d`，2026-07-06）。design-lock:
> `attendance-import-xlsx-guard-design-lock-20260706.md`（RATIFIED）。
> 双审阅：opus 对抗审阅 APPROVE-with-hardening（P2/P3 已修）→ owner 复审 APPROVE（无 P1/P2）。

## 1. 起因与根因（客户报障）

客户在「导入（钉钉/手工）」CSV 栏上传 `6月考勤(5).xlsx` → 红条「导入考勤失败 代码: VALIDATION_ERROR」。
根因两条（3-lens workflow 定位 + 真 .xlsx 复现坐实）：
1. **CSV-only 入口缺 XLSX 拦截**：`accept` 软过滤 → `file.text()` 把 ZIP 二进制静默解码成乱码 `csvText` → 后端 CSV 状态机解析 0 有效行 → `rows.length===0` 硬门（`index.cjs:32556`）。
2. **错误信息被吞**：`localizeRuntimeErrorMessage` 中文界面丢弃未命中翻译表的纯拉丁 message → 只剩裸 code chip。

## 2. 落地内容

| 项 | 内容 |
|---|---|
| R1 共享护栏 | `importFileGuard.ts`：扩展名（.xlsx/.xlsm/.xlsb/.xls）+ 魔术字节（`PK` ZIP / `D0CF11E0` OLE2，抓改名文件）+ `FileReader` 兜底；**双接入** live `AttendanceView.vue` 内联 handler + `useAttendanceAdminImportWorkflow` composable（防漂移）；选文件即拦（零 API 调用、文件不入状态、input 复位）+ apply 同步 name 防御 |
| R2 错误可读性 | `classifyStatusError` 新增 import 上下文 `VALIDATION_ERROR` 分支：按服务端诊断细分（`no rows to (import\|preview)` / `header must include` / 通用）→ 可操作中文 message+hint（另存为 CSV 指引）；`meta.code` 保留（支持侧 chip 不变） |
| MIME 取舍 | Content-Type 归一**保留**并注释：Windows `.csv` 真实 MIME 是 `application/vnd.ms-excel`，透传会 regress；护栏在上游保证内容 |
| CI 门 | 3 spec（file-guard / preview-regression / composable）进 `attendance-web-guard` run-list + 双 path-filter 块（完整 web suite 不在 CI，防 skip-shaped-green） |

## 3. 验证证据

- **测试锁（owner 契约）**："选中 XLSX 后不调用 apiFetch，展示可操作中文提示" — 三层落实：
  - 护栏单测（name/magic/inspect/message zh 含「另存为」）
  - composable 注入 zh tr：xlsx 选中 → 0 次 apiFetch + 文件不入状态 + input 复位；改名 `.csv` 魔术字节拦截；正常 csv happy-path 回归；apply 防御
  - **真挂载 `AttendanceView.vue`**：`#attendance-import-csv` 派发 change → 无 `/api/attendance/import*` 调用 + 渲染「检测到 Excel 文件…另存为」
- **R2 真挂载测试**：preview 返回两种真实服务端诊断（`No rows to preview…`/`CSV header must include…`）→ 各自 zh message + hint + `VALIDATION_ERROR` chip 同屏
- **Mutation 证明 ×2**：① `inspectImportFile` 短路放行 → 三层 5 测齐红；② R2 分支中和 → 新测试红（红输出恰为客户原症状「预览导入失败 代码: VALIDATION_ERROR」）。均还原复绿
- 本地：目标 4 spec 56/56 绿；web-guard 既有 9 spec + Section spec 288/288 绿；`vue-tsc -b` 干净
- 审阅硬化轮：P2（R2 分支零覆盖）/ P3（正则漏 `No rows to preview`）/ NIT（locale 恢复用捕获值）已修入 `82b79dd01`

## 4. 边界与 follow-up

- **R3 真 xlsx 直导 = OUT**：单独设计锁先行（钉钉默认导出 xlsx，长期值得做；不塞进本修复）。
- **P3 follow-up（owner 复审提出，不挡合）**：`handleImportCsvChange` 异步 sniff 在快速连续选择两个文件时，慢返回可能覆盖新选择；下次触碰该文件顺手加 `target.files?.[0] === file` 确认后再写状态。
- 后端 `plugins/plugin-attendance` 零改动；正常 CSV 路径逐字节不变（回归测试锁住）。
- **客户即时话术**：请将 Excel 另存为 CSV（逗号分隔，建议 UTF-8）后重新导入；升级后选错文件会当场提示。
