# MetaSheet Feishu Gap RC Release Notes

**Version:** RC-202605
**Date:** 2026-05-01
**Sprint:** 8-Week Feishu Gap Closure

## Overview

This release candidate represents the completion of an 8-week development sprint
closing the functional gap between MetaSheet and Feishu Bitable. All major
subsystems have been implemented, tested with 53 regression tests, and validated
against the Feishu feature parity matrix.

---

## New Features

### Week 1-2: Collaboration & Comment System

- **Threaded comments** on records with `@mention` support (parsed via `@[Name](userId)` syntax)
- **Unread tracking** with separate `unreadCount` and `mentionUnreadCount` splits
- **Author auto-read** — own comments are never marked unread
- **Batch mark-all-read** operation
- **Mention candidates** search with prefix filtering
- **Real-time presence** — see who is viewing the same record
- **Comment resolve/reopen** workflow
- **Backward-compatible** unread-count endpoint (legacy `count` field preserved)

### Week 3: Public Forms

- **Public form views** with time-limited shareable tokens
- **Rate limiting** — 10 anonymous submissions per IP per window; authenticated users exempt
- **Token lifecycle** — create, expire, revoke public form links
- **Security** — `recordId` injection on public form submissions is rejected
- **Audit logging** for all public submissions

### Week 4: Field Validation

- **7 built-in rule types:** required, min, max, minLength, maxLength, pattern, enum
- **Custom error messages** per rule
- **Multi-error return** — all failing rules reported in one response
- **Shared engine** used by both internal editing and public form submission
- **Empty-value short-circuit** — non-required empty fields skip range/pattern checks

### Week 5: API Tokens & Webhooks

- **API token service** with `mst_` prefixed tokens and SHA-256 hashing
- **Token lifecycle:** create (plaintext shown once), validate, revoke, rotate, expire
- **Scoped access** — tokens carry permission scopes (e.g., `records:read`)
- **Webhook delivery** with HMAC-SHA256 signatures
- **Auto-disable** webhooks after 5 consecutive delivery failures
- **Event bridge** mapping internal EventBus topics to webhook event types

### Week 6: Advanced Automation

- **Condition engine** with 7 operators: equals, not_equals, contains, greater_than, less_than, is_empty, is_not_empty
- **Trigger matching** for record lifecycle events (created, updated, deleted)
- **Multi-step action chains** with fail-fast semantics
- **Scheduled automations** with cron-based registration
- **Execution logging** with per-rule statistics (total, success, failure counts)
- **Action types:** update_record, send_notification, call_webhook

### Week 7: Charts & Dashboards

- **Aggregation functions:** count, sum, avg, min, max
- **Group-by** any field with optional date grouping (day, week, month, quarter, year)
- **Pre-aggregation filters** using the same condition engine as automation
- **Chart types:** bar, line, pie, number (single-value KPI)
- **Dashboard panels** with grid-based layout (x, y, w, h positioning)
- **Full CRUD** for both charts and dashboards

---

## API Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/comments` | Comment CRUD |
| GET | `/api/comments/unread-count` | Unread summary (backward-compat `count` field) |
| POST | `/api/comments/mark-all-read` | Batch mark-all-read |
| GET | `/api/comments/mention-candidates` | Search mentionable users |
| GET | `/api/public-form/:token` | Load public form context |
| POST | `/api/public-form/:token/submit` | Submit public form |
| GET/POST | `/api/tokens` | API token management |
| POST | `/api/tokens/:id/rotate` | Rotate token |
| GET/POST | `/api/webhooks` | Webhook management |
| GET/POST | `/api/automations` | Automation rule management |
| GET | `/api/automations/:id/logs` | Execution logs |
| GET/POST | `/api/charts` | Chart management |
| GET | `/api/charts/:id/data` | Compute chart data |
| GET/POST | `/api/dashboards` | Dashboard management |

### Breaking Changes

- None. All new endpoints are additive.

---

## Migration Notes

1. **Database:** Run pending migrations for `comments`, `api_tokens`, `webhooks`,
   `automation_rules`, `automation_executions`, `charts`, and `dashboards` tables.
2. **Environment variables:** No new required env vars. Optional:
   - `PUBLIC_FORM_RATE_LIMIT` (default: 10 per window)
   - `WEBHOOK_MAX_FAILURES` (default: 5)
3. **Redis:** Comment presence and unread tracking use Redis pub/sub if available;
   falls back to in-memory for single-node deployments.

---

## Known Limitations

1. **Custom validation rules** (`type: 'custom'`) are parsed but not evaluated
   engine-side — they require external handler registration.
2. **Webhook retry** is not yet implemented — failed deliveries are logged but
   not automatically retried (auto-disable is the current safety net).
3. **Chart date grouping** requires ISO-8601 date strings in field values;
   other date formats may produce incorrect groupings.
4. **Automation scheduler** runs in-process — no distributed lock for
   multi-instance deployments yet.
5. **Dashboard panel drag-and-drop** is backend-ready but the frontend
   layout engine is minimal (grid snapping only).

---

## Next Phase Backlog

See `docs/development/next-phase-backlog-202605.md` for the prioritized list
of post-RC work items including real-time collaborative editing, template
marketplace, and advanced BI features.

---

## Testing

- **53 regression tests** in `packages/core-backend/tests/integration/rc-regression.test.ts`
- **HTTP smoke test** in `scripts/rc-smoke.sh` (run against a live server)
- **Demo data seeder** in `scripts/seed-demo-data.ts` for manual QA

## Contributors

- @zensgit (huazhou) — architecture, implementation, testing
