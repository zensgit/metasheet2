# Annual leave — carryover / year-end expiry (design-lock)

Status: locked 2026-06-16. Scope: L4 of the annual-leave balance engine (follows L2b accrual, L2c manual adjustment, L3 approval deduction). Split into **L4a** (grant-time expiry) and **L4b** (backfill of pre-L4a lots).

## Principle

Annual-leave entitlement for a period year expires at a **year-end boundary** in the organization's timezone. L4 is responsible only for writing the correct `expires_at` onto annual accrual lots; the existing leave-balance expiry scheduler reaps lots past their `expires_at` and records an expiry event. No new reaper is introduced.

## Boundary

For an accrual of period year `Y`, the lot's `expires_at` is the **first-invalid instant** — `Jan 1 00:00:00` of the next boundary year, in the org timezone, stored as a UTC instant:

```
expires_at = zonedTimeToUtc({ year: Y + (carryover.enabled ? 2 : 1), month: 1, day: 1, hour: 0, minute: 0, second: 0 }, timezone)
```

- `carryover.enabled = false` → usable through the end of `Y` → expires `Jan 1 (Y+1) 00:00` org-tz.
- `carryover.enabled = true` → carries through `Y+1` → expires `Jan 1 (Y+2) 00:00` org-tz.

The first-invalid instant (rather than `Dec 31 23:59:59`) matches the scheduler's `expires_at <= now()` semantics: `Dec 31 23:59:59` org-tz is still valid; `Jan 1 00:00:00` org-tz is expired. Carryover grace is one year and is not configurable in v1; capped/partial carryover is deferred.

## L4a — grant-time expiry

The accrual run computes the boundary **once** from the run's own policy snapshot (period + carryover + timezone) and stamps it on each `annual_accrual` lot it grants. A later change to the carryover setting does not retroactively change already-granted lots (the grant is `ON CONFLICT DO NOTHING`; nothing re-stamps an existing lot). Lots granted before L4a retain a null expiry (never-expiring) until the L4b backfill sets them.

## L4b — provenance-snapshot backfill

An application-layer, idempotent backfill (not a database migration — mutable policy/timezone/carryover must not be baked into a migration) sets `expires_at` on `annual_accrual` lots whose expiry is still null. For each lot it derives the **grant-time** carryover, timezone, and period from that lot's accrual-run provenance — `lot.source_id` (the run-item id) → run-item → run → the run's serialized policy snapshot (carryover), the run's `period_key`, and the run's `timezone` — never from today's settings. So changing the carryover setting today never re-expires past years.

The backfill never guesses: a lot whose grant-time snapshot cannot be recovered is skipped, counted under a reason code, and left null (grandfathered). Reason codes: `NON_ACCRUAL_SOURCE`, `MISSING_RUN_ITEM`, `MISSING_RUN`, `UNPARSEABLE_POLICY_VERSION`, `MISSING_TIMEZONE`, `UNPARSEABLE_PERIOD_KEY`. It returns an auditable summary `{ scanned, updated, skipped, dryRun, reasons }`; a dry run previews without writing; re-running is idempotent (it scans only null-expiry lots and re-checks null in the update).

## Scope boundary

L4 touches **annual accrual lots only**. Manually-adjusted lots are intentionally left with a null expiry — an administrator's deliberate grant is not silently auto-expired; a separate lifecycle would be a deliberate future decision. Comp-time and the rest of the accrual run behavior are unchanged.
