# 导入模板·列格式说明（格式/示例/必填）design-lock — 2026-07-07

> **Status: RATIFIED（owner 2026-07-07 提问："导出下载 csv 模版中,能否给个页面说明,各列各字段
> 所需格式及示例,并告知哪些是必填项?"）。** display-only,零后端/接口/schema 改动;
> 承 import-section-ux lock（#3708 字段勾选卡）。数据锚定后端实际解析,不凭空编。

## 1. 数据来源（全部已在,前端此前丢弃）

- `/api/attendance/import/template` 返回 `data.mapping.columns` = `IMPORT_MAPPING_COLUMNS`,
  **每项含 `dataType`**（date/datetime/time/hours/minutes/number/string）——前端 `groupSupportedImportColumns`
  当前只读 sourceField/targetField,**本刀接住 dataType**。
- 格式家族 → 文案/示例（锚后端 `normalizeCsvWorkDate`/`parseImportedDateTime`）:
  | dataType | 格式 | 示例 |
  |---|---|---|
  | date | `YYYY-MM-DD` | 2026-06-01 |
  | datetime/time | `YYYY-MM-DD HH:mm`（或纯 `HH:mm`,缺日期用当天） | 2026-06-01 09:00 |
  | hours | 小时数（可小数） | 8.5 |
  | minutes | 整数分钟 | 15 |
  | number | 数字 | 0 |
  | string | 文本 | （按字段:状态=正常/异常原因=迟到/班次=白班…） |
- **必填判定**（锚后端 `IMPORT_HEADER_DATE_KEYS` + `IMPORT_HEADER_CONTEXT_KEYS`）:
  `日期` = 必填;身份列 `工号`/`姓名` = **至少一个**必填;其余支持列全部选填。

## 2. 实现（共享模块 + 表格卡）

- `importTemplateColumns.ts`:
  - `AttendanceImportMappingColumnLike` 加 `dataType?: string`;`groupSupportedImportColumns` 每 target 捕获首见 dataType。
  - `formatSpecForDataType(dataType) → { formatEn, formatZh, example }`（上表;未知 → 文本/text/—）。
  - option 增 `dataType` + `formatZh/En` + `example`（string 字段的 example 用小 curated 覆盖表,余 dataType 派生）。
  - `IMPORT_TEMPLATE_BASE_COLUMN_SPECS`（日期/工号/姓名 的 required 语义 + 格式 + 示例 + 含义,常量）。
  - `buildImportColumnFormatRows(groups)`:base 行（required/identity 标记）+ 各支持列（optional）,按组序。
- `AttendanceView.vue` 模板说明区新增全宽卡「**列格式说明**」（`data-testid="attendance-import-column-formats"`）:
  表格 列名 | 必填 | 格式 | 示例 | 说明;必填列徽标（必填=danger 底/身份=warning 底/选填=中性）;
  样式全 UF `--ms-*`。仅在词汇加载后渲染。**不改**既有字段勾选卡/字段说明表（各司其职,不重复）。

## 3. 保全

既有 testid/copy/勾选卡零改动;新增为主。

## 4. 测试契约

单测:`formatSpecForDataType` 全 dataType + 未知;`buildImportColumnFormatRows`（base 三行 required/identity 标记正确、
支持列 optional、dataType 派生格式、string 覆盖示例、含 date 行示例 2026-06-01、time 行含 HH:mm）。
真挂载:加载模板 → 格式卡出现、日期行标必填且格式 `YYYY-MM-DD`、工号/姓名 标身份必填、加班小时行格式=小时/示例 8.5。
Mutation:拆 base required 标记 → 必填断言红;拆 dataType 捕获 → 格式派生红。web-guard 覆盖。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。FE 串行车道。
