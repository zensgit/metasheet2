# 考勤公式字段 P1 Hardening 验证记录

Date: 2026-05-15

## Commands Run

```bash
node --check plugins/plugin-attendance/index.cjs
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/AttendanceReportFieldsSection.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
node --test scripts/ops/attendance-report-fields-live-acceptance.test.mjs
pnpm run verify:attendance-report-fields:live:test
pnpm --filter @metasheet/web type-check
git diff --check
```

## Results (latest run, round 6)

| Check | Result |
| --- | --- |
| Plugin syntax (`plugin-attendance/index.cjs`) | PASS |
| Live acceptance script syntax | PASS |
| Backend catalog + formula unit tests | **PASS, 20 tests** (7 catalog + 13 formula; +1 vs round 5) |
| Frontend report fields + admin regression specs | PASS, 14 tests (3 + 11) |
| Live acceptance unit harness (`node --test`) | PASS, 17 tests |
| Live acceptance unit harness (package script) | PASS, 17 tests |
| Web type-check (`vue-tsc -b`) | PASS |
| `git diff --check` whitespace check | PASS |

## 字段状态语义矩阵（产品契约 — round 6 完整版）

| `source` | `enabled` | `reportVisible` | `outputFields` | `formulaSourceFields` | 公式引用 |
| --- | --- | --- | --- | --- | --- |
| system | true | true | ✅ | ✅ | 正常 |
| system | true | false | ❌ | ✅ | **正常**（隐藏字段仍可计算） |
| system | false | * | ❌ | ❌ | validator 拒绝 → `#ERROR!` |
| custom 非公式 | * | * | ❌ | ❌ | validator 拒绝 → `#ERROR!` |
| custom 公式 | true | true | ✅ 显示结果 | ❌ | formula-to-formula 拒绝 |
| **Raw alias** | n/a | n/a | n/a | n/a（独立通道）| **永远合法**，直接读 `row.*` |
| **Reserved code shadow** | * | * | ❌（merge 层丢弃）| ❌ | raw alias 通道仍合法 |

## Round 6 — Hardening Evidence

### Test #12 — `catalog fields with raw alias codes are dropped (raw aliases are reserved)`

完整复现了用户报告的 P1 bug + 验证双层防御。设置：

- `rec-shadow-nonformula`：`fld_code: 'work_minutes'`，非公式自定义字段
- `rec-shadow-formula`：`fld_code: 'late_minutes'`，公式自定义字段（**正是用户复现的场景**）
- `rec-use-raw`：`fld_code: 'use_raw_late'`，合法公式 `={late_minutes}+1`

断言（按执行顺序）：

1. `merged.find(f => f.code === 'work_minutes')` → `undefined`（merge 层丢弃）
2. `merged.find(f => f.code === 'late_minutes')` → `undefined`（merge 层丢弃）
3. `use_raw_late.formulaValid === true`，`formulaError === null`，`formulaReferences === ['late_minutes']`
4. `validateAttendanceReportFormulaExpression('={late_minutes}+1', { fields: merged })` 返回 `valid: true`，`error: null`——**Bug 修复确认**：之前会因为 `formulaFieldCodes.has('late_minutes')` 命中 formula-to-formula 拒绝路径返回 `Formula field reference late_minutes is not supported in v1.`，现在通过
5. `buildAttendanceRecordReportExportItemAsync` 用 row.late_minutes=12 → `calculateFormula` 收到 `=12+1` → 返回 13 → 导出 `use_raw_late === 13`
6. `calculateFormula` 调用次数 = 1

## 历史轮次 Hardening Evidence

详细测试断言见 `attendance-dingtalk-formula-hardening-development-20260515.md` 与 git 历史。要点：

- **Round 2**：cell-ref 拒绝 + sample-key 收紧（Test #7、#13）
- **Round 4**：hidden 字段仍可计算 + disabled 字段被拒（Test #8、#9）
- **Round 5**：custom 非公式字段不作为源 + raw alias 不受 enabled 控制（Test #10、#11）
- **Round 6**：raw alias codes 设为保留字（Test #12）

## Acceptance Criteria

- 公式白名单按 5 大类代表函数全部通过验证（Round 1）。
- 禁用函数（`NOW`）、未知字段引用、公式字段引用公式字段三条拒绝路径仍返回 `valid: false` 及对应 error。
- 裸 `A1`、`A1:B2`、混合 `A1+{...}`、小写 `b2`、范围在 `SUM()` 内全部被拒绝（Round 2）。
- 字符串字面量内出现的 `"A1"`、`"B2"` 不被识别为 cell ref（Round 2）。
- `{A1}` 走 unknown-reference 路径（Round 2）。
- preview 接口对 sample 中未在 catalog 注册的字段名仍返回 `Unknown attendance report field reference`，`calculateFormula` 不被调用（Round 2）。
- `enabled=true && reportVisible=false` 的字段——在 `formulaSourceFields` 中存在、`outputFields` 中不存在；公式 `={late_duration}+1` 仍按 row 的 `late_minutes` 计算（Round 4）。
- `enabled=false` 的字段——既不在 `outputFields` 也不在 `formulaSourceFields`；公式 `={late_duration}+1` 被 validator 拒绝并标记 `formulaValid: false`；export 返回 `#ERROR!`；`calculateFormula` 未被调用（Round 4）。
- `source=custom && formulaEnabled=false` 的字段——既不在 `outputFields` 也不在 `formulaSourceFields`；公式 `={custom_metric}+1` 被 validator 拒绝（Round 5）。
- Raw alias `{late_minutes}` 不受 `late_duration.enabled` 控制——即使 `late_duration` 已停用，`={late_minutes}+1` 仍合法、仍按 row 计算（Round 5）。
- **Round 6**：catalog 配置记录 code ∈ raw alias（包括 `work_minutes`/`late_minutes`/`early_leave_minutes`/`leave_minutes`/`overtime_minutes`）——无论是否为 formula 字段——在 merge 阶段被静默丢弃，不出现在 `outputFields` 或 `formulaSourceFields`。
- **Round 6**：用户报告的 bug `formulaEnabled` 字段 code 为 `late_minutes` 时 `={late_minutes}+1` 误判 formula-to-formula——本轮修复，validator 通过；row 计算返回正确值。
- 无效公式仍输出 `#ERROR!`，不阻断同行其它字段导出。
- 公式启用状态/表达式/范围/输出类型进入 report field fingerprint。
- 公式预览接口 `previewAttendanceReportFormula` 返回 references 排序稳定。
- catalog 7 项稳定 ID 测试仍通过。
- 前端 report fields 区域公式列、错误数、公式字段筛选仍通过。
- live acceptance mock harness 覆盖 catalog/records/export/CSV header + 公式字段进入 evidence metadata。
- web type-check 无新 TS 错误。
- `git diff --check` 无尾随空白或冲突标记。
- 真实 staging live acceptance 当前会话**未跑**（缺凭据），仍标记为环境待补，**不写成通过**。

## Staging Live Acceptance — PASS (Round 7, 2026-05-15)

真实 staging live acceptance 在 2026-05-15 跑通。完整 evidence 在 `~/Downloads/Github/metasheet2/output/attendance-report-fields-live-acceptance/2026-05-15T07-01-24-382Z/`（已脱敏，本机非提交）。

### 环境

- API base: `http://localhost:8081`（SSH tunnel: `ssh -i ~/.ssh/metasheet2_deploy -fN -L 8081:localhost:8081 mainuser@142.171.239.56`）
- Auth source: `AUTH_TOKEN_FILE` (`/tmp/<admin-jwt-file>.jwt`，mode 0600，admin role 已验证)
- Org ID: `default`
- Auth identity: `zhouhua@china-yaguang.com` (role=admin)
- Run window: 2026-04-15 → 2026-05-15

### 跑了什么

```bash
ssh -i ~/.ssh/metasheet2_deploy -fN -L 8081:localhost:8081 mainuser@142.171.239.56

PREFLIGHT_ONLY=1 \
API_BASE=http://localhost:8081 \
ORG_ID=default \
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<admin-jwt-file>.jwt \
pnpm run verify:attendance-report-fields:live
# → PASS, 4 checks (preflight 模式仅 config + health)

CONFIRM_SYNC=1 \
API_BASE=http://localhost:8081 \
ORG_ID=default \
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<admin-jwt-file>.jwt \
EXPECT_VISIBLE_CODE=work_date \
pnpm run verify:attendance-report-fields:live
# → PASS, 48 checks
```

`EXPECT_FORMULA_CODE` 本轮**未传**：staging catalog 目前 0 个 formula 字段（`formulaFieldCodes: []`、`formulaInvalidCodes: []`）。要补完整 formula 端到端 evidence，运维先通过字段管理 UI 在多维表 `attendance_report_field_catalog` 里 seed 一个 formula 字段（例如 `code=net_work_minutes`、`formulaExpression='={work_minutes}-{late_minutes}-{early_leave_minutes}'`），再加 `EXPECT_FORMULA_CODE=net_work_minutes` 重跑即可。

### Live evidence — 关键断言

48 checks 分布：

| Check 组 | 内容 |
| --- | --- |
| `config.*` (4) | auth source / token file mode 0600 / token loaded |
| `api.*` (5) | health 200 / token attached / auth.me 200 / report-fields read & sync 200 |
| `catalog.*` (5) | multitable available（projectId=`default:attendance`，sheetId=`sheet_75b4c963aa445cf3f96d29fe`，recordCount=34）/ 6 categories 完整 / expected-visible (`work_date`) 存在 / formula-fields.valid（0 invalid） |
| `records.*` (3) | records read / report-fields-expected-visible / formula-expected（trivially ok since none expected）|
| `export.json.*` (3) | export read / expected-visible 存在 / formula-expected |
| `export.csv.*` (8) | CSV label header / fingerprint / 字段数 / 字段 codes / backing 一致 |
| `export.csv-code.*` (4) | CSV code-header 变种全部一致 |
| `*.fingerprint-match` (3) | catalog ↔ records ↔ export ↔ csv ↔ csv-code 五处 sha1 fingerprint 完全一致：**`d7f0d74172d35268bae4295af089947ceeedd20f`** |
| `runner.completed` | 完整流程结束 |

跨视图 fingerprint 一致是 Round 4-6 整套 catalog driven 字段集模型的端到端证据：catalog → records → export JSON → CSV (label) → CSV (code) 五个出口的字段配置 hash 完全相等，证明：
- `outputFields` 在不同接口都从同一份 catalog 派生
- 公式相关 descriptor 字段（`formulaEnabled`/`formulaExpression`/`formulaScope`/`formulaOutputType`/`formulaValid`）也参与 fingerprint，未来 admin 添加 formula 字段时任何不一致都会被这套检查抓到

### 待补全项

- [ ] 在 staging seed 一个 formula 字段（例如 `net_work_minutes`）后重跑 acceptance + `EXPECT_FORMULA_CODE`，以验证 formula 评估链路在真实后端的 evaluation。
- [ ] (P3) Round 6 catalog `droppedReservedCodes` UI 反馈层，便于 admin 看到 raw alias shadow 被丢弃的字段（已记入 `attendance-dingtalk-formula-todo-20260515.md` P2 backlog）。

### Secrets / safety check

- 无 JWT (`eyJ`) 出现在 `report.json` / `report.md`
- 无 `AUTH_TOKEN=` literal 出现
- 用户家目录绝对路径在 evidence 文件中已 `sed` 替换为 `~`
- AUTH_TOKEN_FILE 是 `/tmp/` 短期路径，mode 0600，会话结束删除
- SSH tunnel 在本机 `127.0.0.1:8081`，acceptance 结束后已关闭
