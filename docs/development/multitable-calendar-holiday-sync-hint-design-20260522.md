# Multitable Calendar Holiday Sync Hint Design - 2026-05-22

## Context

Issue #1763 showed that Multitable Calendar could render lunar labels while
showing no holiday / makeup-workday chips. The entity-machine retest later
confirmed the root cause was unsynced 2026 attendance holiday data, not a
Calendar rendering regression.

The remaining product gap is discoverability: when holiday data is missing for
a range where public-holiday chips are likely expected, the Calendar view looked
silently incomplete.

## Scope

This slice adds a small frontend-only hint. It does not change attendance
holiday sync, the effective-calendar backend, database schema, K3 runtime, or
Bridge Agent behavior.

## Design

The implementation keeps responsibility split:

- `MultitableWorkbench.vue` owns data loading state for
  `fetchEffectiveCalendar()`.
- `calendar-holiday-notice.ts` decides whether an empty loaded range should
  surface a hint.
- `MetaCalendarView.vue` only renders the notice passed by the workbench.
- `meta-view-render-labels.ts` owns the bilingual static string.

The hint appears only when all of these are true:

1. an effective-calendar request completed successfully;
2. no noteworthy chips were produced after `isCalendarEffectiveItemNoteworthy`;
3. the visible range intersects common China public-holiday months used by the
   existing `holiday-cn` sync path: January, February, April, May, June,
   September, or October.

This avoids prompting on naturally quiet months such as July and August.

## User Experience

Chinese:

> 当前范围没有已同步的节假日数据；如应显示节假日或调休班标记，请先在考勤设置中同步节假日。

English:

> No public holiday data is synced for this range. Sync holidays in Attendance
> settings if holiday or makeup-workday chips are expected.

The notice uses `role="status"` so it is available to assistive technology
without being a blocking toast.

## Non-Goals

- No automatic holiday sync.
- No new backend endpoint.
- No inferred holiday generation in the Calendar view.
- No K3 Save / Submit / Audit.
- No Bridge Agent or Data Factory runtime change.

