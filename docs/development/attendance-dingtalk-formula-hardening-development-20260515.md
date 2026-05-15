# 考勤公式字段 P1 Hardening 开发记录

Date: 2026-05-15

## Summary

P1 closeout 共六轮加固，本文件汇总所有改动。

- **Round 1**：补齐公式白名单 5 大类测试 + 文档差异收口。
- **Round 2**：拒绝裸 spreadsheet cell / range 引用；取消 preview 让 `sample` key 扩展合法字段集合的副作用。
- **Round 3**：把公式取值源从「报表可见字段列表」改为「系统字段全集」（硬编码）。已被 Round 4 取代。
- **Round 4**：按 catalog 驱动的两套字段集模型重构（`outputFields` + `formulaSourceFields`），落实「`enabled` 控公式可用性、`reportVisible` 只控显示」的解耦原则。
- **Round 5**：v1 字段来源策略与 raw alias 语义二选一收口——product contract：custom 非公式字段不作为公式源；raw alias 不受 catalog `enabled` 控制。
- **Round 6（本轮）**：Raw alias codes 设为保留字（reserved）——catalog 不允许创建与 raw alias 同名的字段，validator 也加 defense-in-depth；修正 Round 5 文档中误导的 raw alias 阻断方法描述。

不扩大功能范围，仍保持 record-scope 公式字段、多维表配置层和 `attendance_*` 事实源。

## Round 6 — Raw alias 保留字 + Raw alias 阻断路径澄清

### 决策 3（本轮）：Raw alias codes 为保留字，catalog 不可同名

**Bug repro**（用户在本地复现）：管理员在多维表里创建一个公式字段 `late_minutes`（与 raw alias 同名）后，其它公式 `={late_minutes}+1` 会因为 `formulaFieldCodes.has('late_minutes')` 命中 formula-to-formula 拒绝路径，返回 `Formula field reference late_minutes is not supported in v1.`。

这违反 Round 5 写下的契约「Raw alias 永远合法，独立通道」。

**修复**：把 5 个 raw alias codes 设为保留字（`ATTENDANCE_REPORT_FORMULA_RESERVED_CODES`）。两层防御：

1. **Merge 层（主防御）**——`mergeAttendanceReportFieldDefinitions` 在 push 自定义字段时新增 `ATTENDANCE_REPORT_FORMULA_RESERVED_CODES.has(config.code)` 跳过路径。结果：catalog 配置记录里只要 code 是 raw alias 之一，整条记录被静默丢弃，merged catalog 与 `outputFields` / `formulaSourceFields` 都不会出现。
2. **Validator 层（depth）**——`getAttendanceReportFormulaReferenceCodes` 在 push 字段进任何 set 之前先检查 reserved 跳过。结果：哪怕 merged catalog 历史遗留了 raw alias 同名字段（比如旧版本写入的记录），validator 也不会把它视为 formula 字段或合法 catalog 字段。`{late_minutes}` 始终走 raw alias 初始化路径（`new Set(ATTENDANCE_REPORT_FORMULA_RAW_REFERENCE_KEYS)`）。

副作用：catalog 中如果有遗留 raw alias 同名记录，前端不再显示——这是预期行为；如果客户报告字段消失，运维提示「raw alias name reserved」。如果未来需要 UI 反馈层，加在 catalog 响应里返回 `droppedReservedCodes` 字段，P2 落实。

**Why both layers**：

- 仅 merge 层防御：如果 merge 层有 bug 漏掉一些路径（比如 hot-cache 旧数据），validator 还能兜底。
- 仅 validator 层防御：catalog 响应仍会泄露 raw alias 同名字段给前端，前端可能渲染 phantom 列。

两层一起最稳。

### 修正 1（本轮，P3）：Raw alias 阻断路径表述

Round 5 文档原句（误导）：

> 如果想阻止某个度量被公式访问，正确做法：把对应 stat 字段保留 `enabled=true` 即可，公式可经 stat 字段引用；并在公式 review 时由人工审计 raw alias 使用。

这与 raw alias 不受 enabled 控制的契约自相矛盾（保留 `enabled=true` 并不会阻断任何路径）。

**新表述**：

> v1 **没有**通过 catalog 状态阻止 raw alias 引用的机制——`{late_minutes}` 与 `{late_duration}` 走两条独立通道，停用 `late_duration` 只切断后者。如果需要阻止某个 metric 经 raw alias 访问，依靠公式 review 审计；未来在系统层引入 `attendance.formula.allowRawAliases` env / config 提供全局开关。

## 字段状态语义矩阵

| `source` | `enabled` | `reportVisible` | 出现在 `outputFields` | 出现在 `formulaSourceFields` | 公式引用结果 |
| --- | --- | --- | --- | --- | --- |
| system | true | true | ✅ | ✅ | 正常取值 |
| system | true | false | ❌ | ✅ | 正常取值（隐藏字段仍可计算）|
| system | false | * | ❌ | ❌ | validator → Unknown reference → `#ERROR!` |
| custom 非公式 | * | * | ❌ | ❌（v1 不支持） | validator → Unknown reference → `#ERROR!` |
| custom 公式 | true | true | ✅ 显示公式结果 | ❌（永远不在源集合）| formula-to-formula 拒绝 |
| **Raw alias** | n/a | n/a | n/a | n/a（独立通道）| **永远合法**，直接读 `row.*` |
| **Reserved code shadow**（catalog 任意类型字段 code ∈ raw alias） | * | * | ❌（merge 层丢弃） | ❌（merge 层丢弃） | raw alias 通道仍可用，不被 catalog 字段遮蔽 |

## Scope

- 后端：`plugins/plugin-attendance/index.cjs` 加 reserved-codes 防御层（merge + validator）。
- 测试：`packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts` 累计 13 个用例（formula 引擎）。
- 文档：本文件 + `attendance-dingtalk-formula-hardening-verification-20260515.md` 同步刷新。
- 不新增生产功能代码。
- 不触 `attendance_*` 事实表。
- 不直接读写 `meta_*` 表。
- 不实现钉钉打卡时间/打卡结果拆字段。
- 不运行真实 staging live acceptance（缺凭据）。

## Hardenings

### 1. Reject bare spreadsheet cell references (round 2)

新增 `extractAttendanceReportFormulaCellReferences()`：strip strings → strip `{...}` 内容 → 扫描 `(?<![A-Za-z0-9_])[A-Za-z]+\d+(?::[A-Za-z]+\d+)?(?![A-Za-z0-9_])`。错误：`Spreadsheet cell reference <ref> is not allowed; use {field_code} to reference attendance fields.`

### 2. Sample keys no longer extend the legal field set (round 2)

`getAttendanceReportFormulaReferenceCodes(fields)` 移除 `options.sampleCodes`；`previewAttendanceReportFormula` 不再把 sample keys 喂给 validator。

### 3. Two-field-set model: outputFields ⊥ formulaSourceFields (round 4)

新增 `resolveAttendanceFormulaSourceFields(items)` helper；`buildAttendanceReportFormulaValueMap(row, sources)` catalog 驱动；调用链穿透 `formulaSourceFields`；validator 增 `enabled === false` 跳过。

### 4. v1 source filter: only systemDefined fields (round 5)

`resolveAttendanceFormulaSourceFields` filter 加 `field.systemDefined !== false`；`getAttendanceReportFormulaReferenceCodes` 增 `if (field.systemDefined === false) continue`。

### 5. Raw alias policy (round 5)

无代码改动；加 1 个测试 + docs 显式声明 raw alias 不受 catalog `enabled` 控制。

### 6. Raw alias codes reserved (round 6，本轮)

新增常量：

```js
const ATTENDANCE_REPORT_FORMULA_RESERVED_CODES = new Set(ATTENDANCE_REPORT_FORMULA_RAW_REFERENCE_KEYS)
```

**Merge 层防御**：

```js
for (const config of configsByCode.values()) {
  if (systemCodes.has(config.code)) continue
  if (ATTENDANCE_REPORT_FORMULA_RESERVED_CODES.has(config.code)) continue  // ← 本轮新增
  items.push({...})
}
```

**Validator 层防御**：

```js
for (const field of fields || []) {
  const code = normalizeCatalogString(field?.code)
  if (!code) continue
  if (ATTENDANCE_REPORT_FORMULA_RESERVED_CODES.has(code)) continue  // ← 本轮新增
  if (field.formulaEnabled) {
    formulaFieldCodes.add(code)
    continue
  }
  ...
}
```

修复确认（Round 6 test）：
- 创建 `fld_code: 'work_minutes'`（非公式自定义）+ `fld_code: 'late_minutes'`（公式自定义）+ `fld_code: 'use_raw_late'`（合法公式 `={late_minutes}+1`）
- 断言 `merged` 中前两条不存在（被 merge 层丢弃）
- 断言 `use_raw_late.formulaValid === true`，`formulaReferences === ['late_minutes']`
- 断言 `validateAttendanceReportFormulaExpression('={late_minutes}+1', { fields: merged })` 通过
- 行级 row.late_minutes=12 → 导出值 `use_raw_late === 13`

## Formula Whitelist Coverage (round 1，未变)

完整白名单（与 PLAN.md 对齐，共 29 个函数）：`IF`、`AND`、`OR`、`NOT`、`ROUND`、`CEILING`、`FLOOR`、`ABS`、`MIN`、`MAX`、`SUM`、`AVERAGE`、`COUNT`、`COUNTA`、`DATEDIF`、`DATEDIFF`、`DATE`、`YEAR`、`MONTH`、`DAY`、`CONCAT`、`CONCATENATE`、`LEFT`、`RIGHT`、`MID`、`LEN`、`TRIM`、`UPPER`、`LOWER`。

代表函数测试覆盖 5 大类（条件/数学/聚合/日期/文本）。

## Test Surface

`packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts` 当前包含 13 个用例（formula 引擎），加上 catalog 7 个用例，共 20 个后端单测：

| # | 用例 | 加固来源 |
| --- | --- | --- |
| 1 | merges custom formula fields and evaluates them through the formula API | base |
| 2 | rejects unknown references, volatile functions, and formula-to-formula references | base |
| 3 | allows representative formula functions from each whitelist category | round 1 |
| 4 | returns #ERROR! for invalid formula fields without blocking the row export | base |
| 5 | includes formula metadata in the report field fingerprint | base |
| 6 | previews formulas against supplied sample values | base |
| 7 | rejects bare spreadsheet cell and range references | round 2 |
| 8 | hidden but enabled source field still resolves in formulas | round 4 |
| 9 | disabled source field is rejected by the validator and yields #ERROR! at evaluation | round 4 |
| 10 | v1 rejects custom non-formula fields as formula sources | round 5 |
| 11 | raw alias references bypass catalog enable/visibility state | round 5 |
| 12 | **catalog fields with raw alias codes are dropped (raw aliases are reserved)** | **round 6** |
| 13 | preview does not let sample keys extend the legal field set | round 2 |

## Documentation Updates

- `attendance-dingtalk-formula-todo-20260515.md`：P2 backlog 已含 (a) custom 非公式字段公式源解析层 + (b) raw alias 全局门控建议 `attendance.formula.allowRawAliases`，本轮新增 (c) UI 反馈层透出 reserved-code shadow drop。
- `attendance-dingtalk-formula-development-20260515.md`：未变。
- `attendance-dingtalk-formula-verification-20260515.md`：未变。
- 本文件 + `attendance-dingtalk-formula-hardening-verification-20260515.md`：
  - **Round 6（本轮）**：reserved-codes 双层防御 + 字段状态矩阵第 7 行 + 测试拆分到 #12 + Raw alias 阻断路径表述修正。

## Remaining Blocker

真实 staging live acceptance 仍依赖外部环境：

- `API_BASE` 或 `BASE_URL`
- 短期 admin JWT 文件
- `CONFIRM_SYNC=1`
- 可写 evidence 输出目录

拿到凭据后运行：

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/path/to/admin.jwt \
CONFIRM_SYNC=1 \
API_BASE=<staging-api-base> \
ORG_ID=<org-id> \
EXPECT_VISIBLE_CODE=work_date \
EXPECT_FORMULA_CODE=net_work_minutes \
pnpm run verify:attendance-report-fields:live
```
