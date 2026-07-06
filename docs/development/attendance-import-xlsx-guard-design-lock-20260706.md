# 考勤导入 XLSX 拦截 + 错误可读性（R1+R2）design-lock — 2026-07-06

> **Status: RATIFIED（owner 对话拍板 2026-07-06："R1+R2 同一个小 PR，优先做；R3 单独设计锁；
> 以 composable 为主，别只改旧大文件壳"）。** 起因：客户在「导入（钉钉/手工）」把 `6月考勤(5).xlsx`
> 传进只吃 CSV 的导入口 → `VALIDATION_ERROR`，且报错框只剩一个光秃秃的代码。
> 3-lens 根因定位实证见 workflow `wf_36c025ee-fdb`（origin/main 378cbcf03 逐环坐实 + 真 .xlsx 复现）。

## 1. 根因（校准措辞）

**不是**「考勤 CSV 解析算错」，而是两条独立缺口：

1. **CSV-only 入口缺 XLSX 拦截**：从选文件到后端解析，全程无二进制/格式识别。
   - 前端 `accept=".csv,text/csv"` 仅软过滤（「所有文件」/拖拽可绕过）；选文件处理器零校验。
   - 小文件走 `file.text()`（UTF-8 解码，遇二进制不抛异常，把 `.xlsx`(ZIP `PK\x03\x04`) 读成 `�` 乱码串）→ 作 `csvText` 发后端。
   - 大文件走 `/import/upload`，`uploadImportCsvFile` 把非 csv MIME 兜底成 `text/csv`，后端仍按 CSV header/row 验证。
   - 后端 `iterateCsvRows` 手写状态机；`detectCsvHeaderIndex` 要「姓名/name + 日期/date/workDate」同行，乱码永不命中 → `rows.length===0` → `VALIDATION_ERROR: No rows to import...`（`plugins/plugin-attendance/index.cjs:32556`）。
2. **错误信息被前端 locale 门吞掉**：后端其实回了描述性 message，但 `localizeRuntimeErrorMessage`（`AttendanceView.vue:19068`）在中文界面下，凡「纯拉丁 + 未命中 19 条硬编码翻译」的 message 一律丢弃换成通用「导入考勤失败」。客户只剩 `代码: VALIDATION_ERROR`。

## 2. 关键实现事实（决定改哪儿）

- **live UI = `AttendanceView.vue` 的内联副本**：模板 `@change`(:5981) 绑本地 `handleImportCsvChange`(:18014)、`applyImportCsvFile`(:18079)、`uploadImportCsvFile`(:18053)；**全文无 `useAttendanceAdminImportWorkflow` 导入**。
- **composable `useAttendanceAdminImportWorkflow.ts` 只喂 orphan `AttendanceImportWorkflowSection.vue`**（+ 2 specs），未接进 live 视图。
- ∴ 要修客户实际命中的路径**必须**改旧壳；要满足「composable 为主、不漂移」，规范护栏逻辑落在**共享模块**，旧壳与 composable 都调它。

## 3. 方案（R1+R2，共享护栏）

### R1 — XLSX/XLS 选文件即拦截

新模块 **`apps/web/src/views/attendance/importFileGuard.ts`**（纯函数、零依赖、可单测）：
- `detectSpreadsheetByName(name)` → `'xlsx'|'xls'|null`（扩展名 `.xlsx/.xlsm/.xlsb` → xlsx；`.xls` → xls，大小写无关）。
- `detectSpreadsheetByMagic(head: Uint8Array)` → 同上（`50 4B 03/05/07 04/06/08` = ZIP/OOXML；`D0 CF 11 E0 A1 B1 1A E1` = OLE2 旧 xls）。**魔术字节兜住改名文件**（`.xls` 改名 `.csv` 仍被抓）。
- `blockedSpreadsheetMessage(kind)` → `{ en, zh }`，zh 为**可操作**文案：「检测到 Excel 文件（.xlsx/.xls），本导入仅支持 CSV。请在 Excel/WPS 中「另存为 → CSV（逗号分隔，建议 UTF-8）」后再上传该 .csv；也可点「下载 CSV 模板」参照格式。」
- `inspectImportFile(file)` → 先 name（同步廉价）再读前 8 字节 magic；读字节失败静默回退到 name 结果。

**接入两处（逻辑相同）**：
- `handleImportCsvChange` 改 async：选中即 `inspectImportFile`，命中则 **不存文件**（清空）、`setStatus/reportStatus` 报可操作中文提示、`input.value=''`（便于重选同名文件）、`return`。
- `applyImportCsvFile` 顶部加**同步 name 防御**（`detectSpreadsheetByName`）：即使文件经其他途径混入，也在任何 `apiFetch`/`upload`/`readFileText` **之前** return。

### R2 — 错误可读性 + MIME 取舍

- **错误吞噬**：`classifyStatusError`（`AttendanceView.vue:19105`）加一分支——`code==='VALIDATION_ERROR'` 且 import 上下文时，给可操作中文 `message`+`hint`（含「确认为 CSV 非 Excel；钉钉导出请先另存为 CSV」），**保留 `meta.code`**（代码 chip 不变）。additive、低风险。
- **MIME 那行（`:18062`/composable `:1491`）经分析保留不动**：护栏挡住 spreadsheet 后，把 Windows 上 `.csv` 的真实 MIME `application/vnd.ms-excel` 归一成 `text/csv` 反而**正确**；改成透传会 regress Windows CSV。加注释说明「上游护栏已保证 CSV 内容，故此归一安全」。后端本就不校验 Content-Type，透传无收益、有风险。

## 4. 边界

- **R3（真 xlsx 直导）OUT，单独设计锁**：仓里 `xlsx`(SheetJS) 依赖仅多维表用；考勤导入是另一套映射/校验/大文件/异步链路，不顺手塞进本 PR。
- 后端 `plugins/plugin-attendance` **零改动**——本 PR 纯前端。
- 正常 CSV 路径**逐字节不变**（护栏只对 spreadsheet 触发；happy-path 回归测试锁住）。

## 5. 测试契约（owner 明确要求：「选中 XLSX 后不调用 apiFetch，展示可操作中文提示」）

1. **单测** `apps/web/tests/attendance-import-file-guard.spec.ts`：name（.xlsx/.xls/.xlsm/.csv/无扩展名）、magic（PK→xlsx、D0CF11E0→xls、纯文本→null）、`inspectImportFile`（改名文件靠 magic 命中、干净 csv → ok）、message en/zh 含可操作字样。
2. **composable** `useAttendanceAdminImportWorkflow.spec.ts` 增：`handleImportCsvChange` 喂 xlsx File → `apiFetch` **未调用** + `setStatus` 收到 error+中文提示 + `importCsvFile` 为空；并保留 happy-path（csv → readFileText/preview 正常）作回归。
3. **旧壳真实路径** `attendance-import-preview-regression.spec.ts`（真挂载 `AttendanceView.vue`）增：向 CSV file input 派发 xlsx `change` → `apiFetch` **未调用** + 报错含中文提示 + 文件未被采纳。
4. **mutation 证明**：摘掉 `handleImportCsvChange` 里的护栏调用 → 上述 (2)(3) 必须转红 → 还原。

## 6. 完成口径

共享模块 + 双接入 + R2 + 三档测试 → opus 对抗审阅 0 P1/P2 → 三红线（0 P1/P2；纯前端 display/guard、default-preserving；fresh-green required checks + up-to-date）。FE 串行车道（触碰 `AttendanceView.vue`）。
