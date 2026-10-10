# Attendance admin write honesty (#5965, #5968)

Date: 2026-09-23. Base: `main`. Draft only; do not merge. Does not depend on other open attendance fix PRs. Does not add `fixed_schedule_apply` (or rebuild/clear/config) to the O3 manager action set.

## #5965 — incomplete geofence must not null-wipe

`saveSettings` treats latitude, longitude, and radius as one value. If any field is blank or not a finite number, the client sends `geoFence: null`. `PUT /api/attendance/settings` allows null, and `mergeSettings` overwrites the stored fence. The same button also saves IP allowlist, holidays, and auto-absence, so a partial fence edit removes the fence under “设置已更新。” Punch then skips the location check.

Contract:

- All three fields empty: explicit clear. Send `geoFence: null`. The hint states that this turns the fence off. If a fence was already stored, the success text says the fence was turned off.
- Any partial fill, non-finite value, or radius that is not an integer ≥ 1: do not PUT. Show a field error. The stored fence stays.
- Backend already rejects an incomplete object (`400 VALIDATION_ERROR`) before merge. Null remains the explicit clear. Omitted `geoFence` still keeps the previous fence via merge.

No new clear flag. No change to outdoor approval (#5961) or the default of no fence.

## #5968 — preview-only owners cannot click Apply

O3 grants `fixed_schedule_preview` to group owners and does not grant apply, rebuild, or clear. Those writes stay admin or scheduler-scope `dispatch` / `clear`. The backend 403 `SCHEDULER_SCOPE_FORBIDDEN` is correct and stays.

The group catalog `scope: managed` means the caller is not a full admin. Write buttons start disabled. A successful preview may return an advisory `fixedScheduleWrites` object computed with the same scheduler-scope check apply already uses. Missing or failed lookups are all `false` (fail closed) and do not fail the preview. Full admins skip that lookup and keep today’s buttons.

`403` + `SCHEDULER_SCOPE_FORBIDDEN` is shown as preview-only / no apply (rebuild, clear) permission. It is not translated to “需要管理员权限”, and it does not set `adminForbidden`. Other 403s stay on the existing admin-permission path.

This does not grant owners apply rights. A managed user who also has scheduler dispatch can apply only after preview reports `apply: true`. Apply, rebuild, and clear routes are unchanged.

Out of scope: binding apply to the preview snapshot / `expectedConfigRevision`.
