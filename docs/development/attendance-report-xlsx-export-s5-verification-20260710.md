# 考勤报表 xlsx 导出（S5）验证报告 — 2026-07-10

> 余下开发总目标池（#3925 计划）之 **S5**。PR **#3961** MERGED `a8154c3b8`（2026-07-09）。
> 切片定性：xlsx 此前「只进不出」（导入用 SheetJS，导出仅 CSV）；本刀让报表导出直接出 `.xlsx`，
> 与 CSV 同一服务端 `/api/attendance/export` 数据源，纯 FE 格式增量、零后端改动。

## 1. 交付

- `apps/web/src/views/attendance/reportXlsxExport.ts` 新 helper：服务端 CSV → SheetJS（动态 `import('xlsx')`，
  不进主 bundle）→ `.xlsx` 下载；`raw:true` 全字符串保真（前导零/日期串/含引号逗号中文均不转型）。
- `AttendanceView.vue` `exportXlsx()`：`buildQuery` 与 `exportCsv()` 逐字节相同（from/to/orgId/userId/header 逐参一致）；
  同一 `reportsExportBlocked` 门禁；fail-soft（转换抛错 → error status，`finally` 复位）。
- web-guard 四处接线（新 helper + 2 spec 入 pull_request/push paths 块 + run-list）。

## 2. 对抗审阅（opus，refute-first）

审阅 MD：`/tmp/pr3961-review-claude-20260708.md`（head `7df4e2be6`）。判定 **APPROVE-with-hardening：0 P1 · 1 P2（纯测试覆盖）· 3 NIT**。

- **BOM 疑点已 refute**：advisor 称服务端 `withCsvBom` 的 BOM 会污染首列表头；playwright 真 Chromium 实证
  `Response.text()` 按 Encoding 标准剥前导 BOM（首字符码=22995'姓'，hasBOM=false），node 裸串探针场景在浏览器不可达。缺陷不成立。
- **G2 保真**：node 探针跑 xlsx **0.20.3**（lockfile pin/CI 实装）+ 0.18.5 双版本，`raw:true` 下全格 `t=s`，无数字/日期转型。
- **P2-1（已修后合并）**：spec 有误导性重复断言，header-mode 守卫可被 neuter 而测试全绿（mutation 实证：删
  `header:` 参数仍 5/5 GREEN）。修复 commit `dfcefaacf`：断言改为实测 `header=label`——同一 mutation 下现在**红**。
- 实跑：目标+邻居 39 passed；完整 web-guard run-list **447 passed / 23 files**；vue-tsc 清；mutation 三刀
  （header 参数=P2-1 前无牙→修后有牙；文件名交换=有牙；raw:true=有牙）。

## 3. 合并门自证

0 P1/P2（P2-1 修复后）· checks 全绿 · squash `a8154c3b8`。NIT-1（xlsx 导出不更新口径透明面板）/NIT-3（helper 防御性剥 BOM）
留为后续打磨项，不阻塞。

## 4. 账本归属

tracker（#2190 账本）报表能力行：报表导出 CSV ✅ + **xlsx ✅（本刀）**；PDF 仍未做（账本未列，需 owner 立项）。
