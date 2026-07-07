# 考勤导入 section 体验（排版分组 + 模板可发现性）design-lock — 2026-07-06

> **Status: RATIFIED（owner 对话拍板 2026-07-06：排版"确实一下子不太理想"→ 同意立独立切片；
> 追问"客户不知道都有哪些列名可以导入，何况要客户自己输入字段列名么"→ 支持列必须产品化呈现）。**
> 纯前端 display/interaction 切片；后端 `plugins/plugin-attendance` 零改动。
> Token 消费既有 UF `--ms-*` 词汇（ui-foundation-design-lock-20260706，新硬编码 hex = 缺陷），不自立体系。

## 1. 病灶（客户截图 + 代码审计实证）

| # | 问题 | 证据 |
|---|---|---|
| 1 | 核心动线（选文件→预览→导入）被 16 个平铺字段淹没，高频与一年一用的高级项同层级 | `AttendanceView.vue` 导入字段区单一 `attendance__admin-grid` 平铺 |
| 2 | 工程师视角泄漏：负载 (JSON)、用户映射 JSON 直接暴露 | 同上 |
| 3 | 模板可发现性差：「下载 CSV 模板」默认灰，需先点「加载模板」，无解释 | `:disabled="importLoading \|\| !importTemplateGuide"` + `:17929` 报错文案 |
| 4 | **支持列不可见**：完整 60+ 列别名词汇（多段打卡/迟到早退/加班/班次/部门…）接口已返回（`/api/attendance/import/template` → `data.mapping.columns` = `IMPORT_MAPPING_COLUMNS`），前端 `loadImportTemplate` 丢弃；「字段说明」卡解释的是 payload JSON 键，非 CSV 列 | `loadImportTemplate` 只取 payloadExample/mappingProfiles；guide `fieldGuides` = payloadExample 的 keys |
| 5 | 模板 CSV 只含 8 起步列，客户无从得知还能加什么列 | `IMPORT_TEMPLATE_PROFILES[].templateColumns` |

## 2. 方案（四个决策）

- **D1 字段分组**：字段区拆「常用」（CSV 文件 / 导入模式 / 规则集 / 映射配置，4 项）+「高级选项」折叠区（其余 12 项：表头行/分隔符/用户映射×3/分组×4/用户 ID/时区/负载 JSON）。折叠用按钮 + `v-show`（DOM 常驻 → 既有测试选择器不受影响）；带"已配置 N 项"徽标；挂载时若有非默认高级项则自动展开。
- **D2 模板一键下载**：composable 版本**已经是一键**（server-first 取 `template.csv` + guide 缺失自动 load fallback）——是旧壳落后：`:disabled="!importTemplateGuide"` + 未加载报错。本切片把 shell 补齐到同水位：未加载自动先 `loadImportTemplate` 再下载，按钮不再因未加载而禁用；composable 零改动。
- **D3 字段勾选生成模板（本切片核心增量；owner 追加拍板 2026-07-06："客户可以选择相应的字段来产生列名么"→ 从"看字典"升级为"勾选生成"）**：新共享纯函数模块 `apps/web/src/views/attendance/importTemplateColumns.ts`：
  - `groupSupportedImportColumns(columns)`：按 targetField 语义分组（打卡时间/打卡结果/状态与异常/时长与工时/班次与分组/人员画像/审批），同 target 多别名去重合并，**中文别名优先**作为展示/生成列名；
  - `buildTemplateHeaderFromSelection(groups, selectedKeys)`：锁定基础列（日期/工号/姓名）置首 + 按分组顺序拼接所选字段的中文优先列名，产出表头。
  加载模板后 guide 区新增「选择字段，生成导入模板」全宽卡：分组渲染**可勾选**字段 chips（中文名 + 含义提示）；「日期/工号/姓名」必填锁定常亮；默认勾选 = 起步模板对应字段；**实时表头预览**；动作 =「下载模板（所选列）」（客户端合成 CSV：所选表头 + 一行空样例）/「复制表头」（clipboard + 状态反馈）/「全选」/「恢复默认」。未加载时按钮旁新增一行提示「点击"加载模板"可勾选字段生成模板」。
- **D4 保全与 token**：既有 id/name/label/文案/testid 全部不动（300+ 文案断言安全）；新增结构样式只用 `--ms-*`（border-light/space/radius/text-2/bg-card 等）；新增文案均为新 key 走 `tr()` 双语。

## 3. 边界（OUT）

- **选文件后"列识别回显"**（读客户 CSV 表头对照词汇表，绿=识别/灰=忽略/红=缺必填当场回显）：下一个独立 opt-in 切片——动选文件读取路径（与 xlsx 护栏同片代码），单独设计→审阅。
- 自定义映射配置 CRUD / 自定义字段落库进报表：独立 gated 切片（客户若要"自定义新字段进统计"再立锁）。
- 后端模板/映射常量、导入逻辑、接口形状：零改动。
- 向导式整页重构（真 stepper）、Settings 巨表单、其他 section：留在 UI arc P3b 队列。
- orphan `AttendanceImportWorkflowSection.vue` 的字典卡渲染：共享模块已就绪，接入随该 Section 的挂载切片走（本切片只给 composable 接 D2）。

## 4. 测试契约

1. 新单测 `attendance-import-template-columns.spec.ts`：分组/去重/中文优先/勾选表头组装（基础列锁定置首、按分组序、全选/默认集）。
2. 真挂载（preview-regression spec 模式）：mock `/import/template` 返回 `mapping.columns` → 点「加载模板」→ 勾选卡分组渲染、默认勾选、切换勾选后表头预览变化、「下载模板（所选列）」产出所选表头；「下载 CSV 模板」在未加载状态直接点击 → 自动请求 `/import/template` 后触发下载（一键化）；高级区默认收起、点按钮展开、常用 4 字段始终可见。
3. composable spec：D2 一键下载（guide 空 → 自动 load → downloadText 被调）+ 既有先加载后下载路径回归。
4. Mutation 证明：摘 D2 自动加载 → 一键下载测试红；摘勾选→表头组装 → 勾选卡测试红。
5. 新 spec 进 `attendance-web-guard` run-list + 双 path-filter 块。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线（fresh-green + up-to-date）→ 验证 MD。FE 串行车道（触碰 `AttendanceView.vue`）。

## 6. 追加修正案（2026-07-07 客户报障）：CSV 下载 BOM

客户实测：下载的 CSV 模板 Excel 打开乱码、WPS 正常——BOM-less UTF-8 被 Excel 按 ANSI/GBK 猜。
修法：共享 `withCsvBom`（FE `csvExport.ts` / 后端 index.cjs 同名 helper），**全部考勤 CSV 下载出口**
加 `﻿`——FE 4（选列模板/起步模板/`downloadCsvText` 备份导出/服务端导出转存）+ composable 2
（server-text/fallback）+ 后端 5（template.csv ×2 / 导入批次导出 / 计薪周期导出 / 记录报表导出）。
导入/上传 payload 不动（解析侧 `normalizeCsvHeaderValue`/`parseCsvHeaderFromText` 本就剥 BOM，
下载→回填→上传往返安全）。幂等（已有 BOM 不重复加）。
