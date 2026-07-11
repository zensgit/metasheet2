# X1 xlsx 直导 验证报告（客户 xlsx 弧终局刀）— 2026-07-07

> PR #3755 MERGED（squash `95a9fd699`）。design-lock:
> `attendance-import-xlsx-direct-design-lock-20260706.md`（RATIFIED：D1=A 前端转换 /
> D2 仅 .xlsx 首非空表 / D3-a 已由 #3737 满足 / D4 上限+失败态）。
> 双审：opus APPROVE-with-hardening + owner CHANGES-REQUESTED → 双 P2 修毕 head `4535978d3` owner 复核通过。

## 1. 客户弧收官（五刀全 MERGED）

#3694 拦截+指引 → #3708 勾选生成模板 → #3718 列识别回显 → #3737 SheetJS 安全升级（生产可达 CVE 就地修复）→ **#3755 直导**：选中 `.xlsx` 即浏览器内取首个非空工作表转 CSV（SheetJS 0.20.3 动态加载不进主包），喂进既有 csvText 管线——识别 chips/勾选模板/预览/提交与后端全部闸门原样生效，**后端逐字节零改**。客户从"传 xlsx 报神秘错误"到"传 xlsx 直接可导"。

## 2. 验证证据

- 审阅方实测：`sheet_to_csv` → 后端 `iterateCsvRows` 逐字段精确往返（逗号/引号/换行/双引号转义）；wire 形状零变。
- 端到端真工作簿测试（SheetJS 构造）：选择→转换→识别→Load CSV payload 形状；`.xlsm` 宏工作簿仍拦截；竞态守卫覆盖转换路径。
- **双 P2 硬化**：P2-1 `setImportCsvFile` 任意调用先清转换态（"新文件名+旧 Excel 内容"串线堵死，回归测试锁）；P2-2 D4 失败态纯模块 spec（too-large **读前拒绝**（arrayBuffer 未调=zip-bomb 姿态）/空表/损坏/加密分类抽 `classifyXlsxReadError` 单元锁/纯中文文案），mutation 双刀红→绿。
- web-guard 15 spec / 363 测绿（新 spec 入 run-list+双 filter）；typecheck 清。
- 后审备忘：`XLSX.version` 运行时报 0.18.5 是 SheetJS CDN 版本常量未 bump 的已知怪癖，模块实为 integrity-pinned 0.20.3。

## 3. Follow-up（gated）

X2 sheet 选择器（多表工作簿 UI）/ X3 后端原生解析（仅当前端转换上限被真实命中）——各自独立 opt-in。
