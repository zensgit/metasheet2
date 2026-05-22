# Attendance Advanced Scheduling Benchmark Verification

Date: 2026-05-21
Branch: `codex/attendance-advanced-scheduling-benchmark-20260521`

## Scope Verification

This slice is docs-only.

| Check | Result |
| --- | --- |
| Runtime code changed | No |
| `plugins/plugin-attendance/index.cjs` changed | No |
| Frontend code changed | No |
| Migration changed | No |
| `attendance_*` fact write changed | No |
| Direct `meta_*` write | No |
| Data Factory / Bridge Agent touched | No |

## Source Reading Evidence

The DingTalk advanced scheduling handbook was read through the in-app browser.
The body is rendered in an embedded preview frame, so evidence came from visible
right-hand page content rather than a full text export.

Observed advanced scheduling menu entries:

- `高级排班视频介绍`
- `新手入门`
- `客户案例`
- `产品介绍`
- `高级排班产品操作界面介绍`
- `电脑端排班`
- `手机端排班`
- `排班报表`
- `小组织管理`
- `排班规则`
- `排班人`
- `如何新增排班班组`
- `排班周期`
- `调度`
- `高级排班调度设置`
- `排班权限设置`
- `操作日志`
- `插件中心`

Right-hand detail pages visually read in this slice:

| Page | Evidence captured |
| --- | --- |
| `管理员设置固定班制考勤` | Fixed workday setup, selected weekdays, shift selection, multiple attendance time rules, legal-holiday auto rest, special dates. |
| `电脑端排班` | Export schedule, day/cycle scheduling, copy/paste, copy previous week/month, batch scheduling by group/shift/day/person, Excel import, clear schedule, line-draw temporary shift, fullscreen, statistics, comprehensive-hours validation. |
| `排班报表` | Department/person/time-dimensional visual schedule reports. |
| `小组织管理` | Scheduling group / attendance group / class organization association, create/edit/delete small org groups. |
| `排班规则` | Multi-shift per day, temporary line scheduling, daily/weekly/monthly scheduling-hour caps. |
| `排班人` | Scheduler assignment by role/position/member and scheduling scope. |
| `如何新增排班班组` | Grouping by work nature, shift plan, or responsibility; Excel batch import/update; role-scoped view/edit; recurring export for payroll/performance decisions. |
| `调度` | OA approval based staff transfer, AI/optimized scheduling plan, production-line support scenarios. |
| `排班权限设置` | Permission assignment by role and business need, controlling who can perform scheduling operations. |
| `操作日志` | Schedule operation audit for compliance, leave disputes, permission abuse, and mistake investigation. |

Follow-up reading still recommended before implementation:

- Full `手机端排班` detail.
- Full `排班周期` detail.
- Full `高级排班调度设置` detail.
- Full `插件中心` detail.

These follow-ups do not block the benchmark verdict because the current roadmap
starts with the load-bearing `排班班组` / `排班人` scope decision.

## Repo Cross-Check

The benchmark was cross-checked against current `origin/main` docs and code
anchors:

| MetaSheet area | Local evidence |
| --- | --- |
| Effective calendar | `attendance-effective-calendar-rfc-20260520.md`, `attendance-effective-calendar-group-ruleset-*` |
| Calendar policy | `attendance-calendar-policy-*` docs |
| Rotation rules and assignments | `attendance-rotation-sequence-preview-*`, `attendance-rotation-assignment-preview-*` |
| Conflict diagnostics and backend save guard | `attendance-schedule-conflict-preview-*`, `attendance-scheduling-conflict-save-*` |
| Daily and period report sync | `attendance-report-records-*`, `attendance-report-period-rollup-*`, `attendance-report-sync-jobs-*` |
| Frontend scheduling surfaces | `apps/web/src/views/AttendanceView.vue` rotation/fixed assignment sections |

## Verification Commands

```bash
git status --short
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-benchmark-todo-20260521.md
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-benchmark-verification-20260521.md
```

Expected:

- `git status --short`: only the two benchmark markdown files are untracked.
- `git diff --no-index --check`: no whitespace diagnostics. Exit code `1`
  is expected because `/dev/null` differs from each new file.

## Acceptance Criteria

- DingTalk advanced scheduling menu is recorded.
- Right-hand details read are mapped into product capabilities.
- Current MetaSheet coverage is separated into covered / partial / missing.
- "Exceed DingTalk" strategy is explicit:
  - explainable schedule chain
  - save-before-impact preview
  - multitable-native reporting
  - governance and operation logs
- Next PR is scoped to scheduling group and scheduler permission design before
  dense-grid implementation.
