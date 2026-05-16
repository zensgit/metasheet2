# 考勤 attendance_report_records 同步层验证记录 — PR2

Date: 2026-05-16

## Commands Run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Backend catalog + formula unit tests | **PASS, 30 tests** (15 catalog + 15 formula; catalog +2 vs prior 13) |
| Frontend report fields + admin regression | PASS（PR2 无前端改动；回归确认无耦合） |
| Web type-check (`vue-tsc -b`) | PASS |
| core-backend build (`tsc`) | PASS |
| `git diff --check` | PASS |

## Hardening Evidence（钉死项逐条）

### 纯 helper 测（`report-records sync: pure helpers`）

- `mapReportFieldToMultitableType`：minutes/count→number、text→string、dateTime→dateTime、formula duration_minutes→number、formula boolean→boolean、formula date→date
- `attendanceReportRecordRowKey` = `org:user:date`
- `buildAttendanceReportRecordsValueColumns`：raw alias reserved（`late_minutes`）被跳过；`work_duration`/`leave_type_annual_duration` 保留；类型 number；顺序保序
- `buildAttendanceReportRecordSourceFingerprint`：排除 `synced_at`+两 fingerprint、key-sort → 不同 key 顺序/不同 synced_at 与 fingerprint 值得到**相同** hash；payload 值变 → hash 变

### writer 测（`report-records sync: upsert / skip / duplicate / degraded / export decoupling`）

| 钉死项 | 断言 |
| --- | --- |
| 降级 | 无 multitable → `{degraded:true,synced:0,created:0,patched:0}`，不抛 |
| export 无耦合 | degraded sync 后 `buildAttendanceRecordReportExportItem` 仍正常（无共享可变态/全局污染） |
| upsert-create | sync#1 → `created:2`，store 2 行，含 `fld_field_fingerprint`/`fld_source_fingerprint` |
| skip 双等 | sync#2 同数据 → `skipped:2,created:0,patched:0`，store 不增 |
| **skip-boundary** | 篡改 store[0] `fld_field_fingerprint`=STALE（source 不变）→ sync#3 `patched:1,skipped:1`，该列被重写非 STALE（review 修正点 2 回归红线） |
| 重复 row_key 保险丝 | 注入同 row_key 第 2 条 → `duplicateRowKeys≥1`，patch 第一条，重复行**不自动删**（v1，store 仍 2 条） |
| 物理 fld id | store key 为 `fld_row_key`/`fld_field_fingerprint`/`fld_source_fingerprint`（resolveFieldIds 物理化生效） |

### stale-null 负路径（诚实标注，未伪造）

正路径（active value 列取 exportItem 值、无 spurious null）writer 测覆盖。负路径（曾 active 后 disable → 列 patch 写 `null`）为 writer loop 内联 `hasOwnProperty(exportItem,col.id) ? value : null`，触发需 disabled 字段 catalog config fixture，与本测的 built-in fallback（全 active）冲突；**本轮不伪造该负路径覆盖**，以代码引用 + dev MD 说明为 reasoned guarantee，完整负路径单测随 PR3 mock acceptance（disabled fixture）或 staging 补。符合本项目 anti-fake 纪律。

## Acceptance Criteria（PR2）

- `POST /report-records/sync` `attendance:admin`，`from/to/userId` 全必填（缺 → 400）
- 复用 export 同款 SQL + loadApprovedMinutesRange + buildAttendanceRecordReportExportItemAsync，不重写聚合
- value 列经同一 ensureObject upsert 补列（全 catalog 超集，确定性）
- 物理 fld id 贯穿 filter/create data/patch changes
- skip 仅 source+field fingerprint 双等；否则 patch 全量 data
- stale managed 列（非 active）→ null（正路径测，负路径 reasoned + follow-up）
- 重复 row_key → patch 第一条 + duplicateRowKeys，不自动删
- 降级 `{ok:true,data:{degraded:true,reason,synced:0}}`；仅参数错误 400
- 单行失败 failed++ 继续，不整批回滚
- 不迁移 `attendance_*`、不裸写 `meta_*`、export/report-fields 无耦合
- 30 backend 单测全绿、frontend 17 无回归、type-check + build + diff clean

## Live Status

writer 单测全绿。真实多维表 provision + sync + fingerprint 链一致性 + stale-null 负路径 = PR3 mock acceptance + staging 凭据后补强（无凭据不伪造）。

## Patch addendum verification (review round, 2026-05-16)

| Fix | 回归断言 | 结果 |
| --- | --- | --- |
| valueColumns 排除 skeleton id | `cols.some(c=>skeletonIds.has(c.id))===false`；`work_date/employee_name/department/attendance_group` 不在 value columns | PASS |
| 组合 descriptor 无碰撞 | `[getAttendanceReportRecordsDescriptor().fields, ...cols]` 中 `work_date` 仅 1 个且 `type==='date'`；3 个 skeleton text 列各仅 1 个 | PASS |
| writer 实测 ensureObject descriptor | 捕获传给 `provisioning.ensureObject` 的 fields：`work_date` 仅 1 个 `type:'date'`，`row_key`/`employee_name`/`department`/`attendance_group` 各仅 1 个 | PASS |
| 路由 dateRange 400 | 镜像既有 export-endpoint `resolveAttendanceDateRange` idiom（8 call sites 在用，helper 久经验证）；`!ok`→400，writer 用 normalized from/to | 代码对齐（既有 helper 不补冗余单测） |

backend 30 全绿（含上述新回归断言），frontend / type-check / build / diff 重跑见下。
