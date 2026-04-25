# EventBus Request Context Correlation Development - 2026-04-25

## Context

Correlation context now carries `correlationId`, `userId`, and `tenantId` after authentication. Logs can use that context, but EventBus publishers still had to pass `correlation_id` manually or events would lose request attribution.

This slice makes EventBus publish inherit request context by default while preserving explicit caller overrides.

## Changes

- Imported `getRequestContext()` in `EventBusService`.
- Added a small enrichment helper for publish options.
- Defaulted `event.correlation_id` from the active request context.
- Added `metadata.user_id` and `metadata.tenant_id` from request context when callers did not already provide those keys.
- Added focused unit coverage for default enrichment, explicit overrides, and no-context behavior.

## Design Notes

- Explicit `options.correlation_id` wins over the request context.
- Explicit `metadata.user_id` and `metadata.tenant_id` win over the request context.
- Events outside a request context remain unchanged.
- The metadata key names match the logger's snake_case metadata shape.

## Explicit Non-Goals

- No event schema changes.
- No database migration.
- No changes to replay behavior.
- No attempt to inject request context into low-level `EventEmitter.emit()` calls; only `EventBusService.publish()` is enriched.

## Files

- `packages/core-backend/src/core/EventBusService.ts`
- `packages/core-backend/tests/unit/eventbus-request-context.test.ts`
