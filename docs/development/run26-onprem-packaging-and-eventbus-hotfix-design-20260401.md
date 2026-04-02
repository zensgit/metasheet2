# Run26 On-Prem Packaging And Event Bus Hotfix Design

Date: 2026-04-01

## Scope

Close two release regressions reported after `attendance-onprem-run26-20260331`:

1. Windows on-prem package no longer shipped the PM2 startup entrypoints expected by Task Scheduler.
2. `/api/events` and hourly event cleanup depended on runtime columns that were missing from the Kysely event bus migration path.

## Decisions

### 1. Restore Windows startup entrypoints in the package root

The package already shipped shell-based bootstrap tooling, but Windows no-WSL installs relied on root-level `.bat` entrypoints.

The fix adds packaging support for:

- `start-pm2.bat`
- `start-pm2-remote.bat`
- `deploy-runXX.bat`

These wrappers call PowerShell scripts that live in `scripts/ops/` and are now part of the package contract:

- `attendance-onprem-start-pm2.ps1`
- `attendance-onprem-deploy-run.ps1`

This keeps the Windows entrypoint stable while moving the real logic into versioned scripts under source control.

### 2. Align Kysely event bus migrations with runtime expectations

The runtime code expects `event_subscriptions` to expose:

- `subscriber_type`
- `event_types`
- `handler_type`
- `is_sequential`
- `timeout_ms`
- `transform_enabled`
- `transform_template`
- `total_events_received`
- `total_events_processed`
- `total_events_failed`
- `last_event_at`
- a text-compatible `id` column because runtime subscription IDs are generated as `sub_<timestamp>_<suffix>`

The runtime code also expects `event_replays` to expose:

- `replay_type`
- `event_ids`
- `time_range_start`
- `time_range_end`
- `subscription_ids`
- `initiated_by`
- `reason`
- `started_at`
- `completed_at`
- a text-compatible `id` column because runtime replay IDs are generated as `rpl_<timestamp>_<suffix>`

and expects `event_store` to expose:

- `occurred_at`
- `received_at`
- `processed_at`
- `status`
- `expires_at`

and expects `event_deliveries` to expose:

- `started_at`
- `completed_at`
- `duration_ms`
- `success`
- `error_message`

The SQL event bus migrations already matched this shape, but the TypeScript/Kysely migration path did not. Since on-prem installs run `packages/core-backend/dist/src/db/migrate.js`, the Kysely path is the one that must be healed for released packages.

The fix uses a forward-only alignment migration that:

- adds missing subscription/runtime columns on `event_subscriptions`
- converts legacy UUID-backed `event_subscriptions.id` to a text-compatible runtime shape
- adds missing replay/runtime columns on `event_replays`
- converts legacy UUID-backed `event_replays.id` to a text-compatible runtime shape
- relaxes legacy replay-only non-null constraints that block current runtime inserts
- adds missing runtime columns
- backfills values from legacy columns when they exist
- relaxes old `event_deliveries` constraints that block current inserts
- preserves already-correct SQL-created installs

## Non-goals

- No new event bus features
- No change to attendance behavior
- No rewrite of the existing bash on-prem flow
