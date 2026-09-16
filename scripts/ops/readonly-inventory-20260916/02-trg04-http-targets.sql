-- ============================================================================
-- 02-trg04-http-targets.sql — TRG-04 read-only inventory
-- ============================================================================
-- Unlocks: PR #5619 (fix/automation-webhook-ssrf-guard — rule-driven
--          `send_webhook` gets the SSRF guard; refuses `http://` with
--          `WEBHOOK_TARGET_REJECTED:scheme-not-allowed`) and PR #5649
--          (fix/webhook-service-ssrf-guard — the `multitable_webhooks`
--          subscription delivery path gets the same guard, same refusal
--          label family). Both branches are OPEN, not on `main`.
--
-- WHY TWO TABLES. #5619's own PR description names its unfixed sibling gap:
-- "`webhook-service.ts:394` 这条同 EventBus 的另一条未接守卫的出口" — that
-- gap is exactly what #5649 closes. So a complete TRG-04 inventory needs BOTH
-- `automation_rules` (rule-driven send_webhook, guarded by #5619) AND
-- `multitable_webhooks` (subscription delivery, guarded by #5649).
--
-- WHAT BREAKS. Per both PR descriptions, ANY currently-working `http://`
-- target — automation rule action or webhook subscription — starts failing
-- once its guard lands: the refusal code is `WEBHOOK_TARGET_REJECTED` with a
-- reason-class suffix of `scheme-not-allowed` (the task brief's
-- "WEBHOOK_TARGET_REJECTED:scheme-not-https" is the same refusal family;
-- the shipped label in both branches' `webhook-refusal-class.ts` is spelled
-- `scheme-not-allowed`, confirmed by direct `gh pr view 5619/5649` reads of
-- their PR bodies — this file follows the shipped spelling literally).
--
-- SOURCE OF THE INVENTORY SQL SHAPE (fetched read-only, not on main):
--   docs/development/automation-webhook-ssrf-guard-design-20260910.md §"Pre-merge
--     step for the owner" on origin/fix/automation-webhook-ssrf-guard
--   docs/development/webhook-service-ssrf-guard-design-20260912.md §"Pre-merge
--     inventory for the owner" on origin/fix/webhook-service-ssrf-guard
--   Both design docs already ship count-only SQL; this file ADDS the `id`
--   column TRG-04 asks for and keeps their exact `ILIKE`/regex predicates
--   unchanged so results stay comparable to what each PR's own owner
--   pre-merge step would produce.
--
-- VALUES-FREE: no query below ever selects `action_config`, `actions`, or
-- `url`. Per both design docs, these URLs "can carry credentials" (userinfo,
-- query-string tokens) — see automation-webhook-ssrf-guard-design-20260910.md
-- §4 and webhook-service-ssrf-guard-design-20260912.md §4. Only `id`,
-- `sheet_id`, `created_by`, `active` (all identifiers, not secret values) and
-- counts are returned.
--
-- RUN WITH: psql "$DATABASE_URL" -f 02-trg04-http-targets.sql
-- ============================================================================


-- ── Q1. Column/table existence probe (RUN THIS FIRST) ──────────────────────
-- Purpose: confirm both target tables and the columns used below exist on
--   this database before running Q2-Q7.
-- Depends on:
--   automation_rules — table + `sheet_id`, `action_type`, `action_config`:
--     packages/core-backend/src/db/migrations/zzzz20260413120000_create_automation_rules.ts:24,27,31,32
--   automation_rules.actions (jsonb array, V1 multi-action shape — the shape
--     actually read at run time by AutomationExecutor, confirmed by grepping
--     `packages/core-backend/src/multitable/automation-executor.ts` for
--     `rule.actions` — dozens of call sites, e.g. :1734,:1846,:1992 — versus
--     zero non-comment call sites reading `action_config` in that same file):
--     packages/core-backend/src/db/migrations/zzzz20260414100000_extend_automation_rules.ts:27
--     (also where `send_webhook` is added to the action_type CHECK constraint,
--     same file :57)
--   multitable_webhooks — table + `url`, `active`, `created_by`:
--     packages/core-backend/src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:34,37,40,41
-- Expected output shape: up to 7 rows of (table_name, column_name, data_type).
-- If a row is missing for a (table, column) pair you expect: that table/column
--   does not exist on this database — skip the queries that depend on it,
--   the errors would be `relation … does not exist` (42P01) or
--   `column … does not exist` (42703).
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE (table_name = 'automation_rules' AND column_name IN ('id', 'sheet_id', 'action_config', 'actions'))
    OR (table_name = 'multitable_webhooks' AND column_name IN ('id', 'url', 'active', 'created_by'))
 ORDER BY table_name, column_name;


-- ── Q2. automation_rules — http:// target COUNT (actions array, current shape) ──
-- Purpose: how many automation_rules rows carry an `http://` webhook target
--   ANYWHERE inside their `actions` jsonb array — this is the column
--   AutomationExecutor actually reads (see Q1 citation), so this is the
--   count that matters for #5619.
-- Depends on: same migration line as Q1 (`actions`, :27).
-- Expected output shape: 1 row, 1 column `http_rules` (integer >= 0).
-- Pattern reused verbatim from automation-webhook-ssrf-guard-design-20260910.md
--   §"Pre-merge step for the owner" (`actions::text ILIKE '%"url":"http://%'`).
--   It is a textual scan of the whole jsonb array, not path-specific, so it
--   catches an http target regardless of which action index / nesting holds
--   it (e.g. inside a `condition_branch`'s nested `actions`, automation-executor.ts:254-269).
SELECT count(*)::int AS http_rules
  FROM automation_rules
 WHERE actions::text ILIKE '%"url":"http://%';


-- ── Q3. automation_rules — http:// target IDS + sheet_id ───────────────────
-- Purpose: same predicate as Q2, with `id`/`sheet_id` for follow-up (which
--   teams to warn — sheet_id is an identifier, not a value, same posture as
--   the design doc's own per-sheet breakout query).
-- Depends on: same migration lines as Q2.
-- Expected output shape: 0..N rows of (id, sheet_id).
SELECT id, sheet_id
  FROM automation_rules
 WHERE actions::text ILIKE '%"url":"http://%'
 ORDER BY sheet_id, id;


-- ── Q4 (SUPPLEMENTARY). automation_rules — legacy single-action shape ──────
-- Purpose: `action_config` is the ORIGINAL (pre-V1) single-action column
--   (zzzz20260413120000_create_automation_rules.ts:32) that AutomationExecutor
--   no longer reads (see Q1 citation) — but a row could still HOLD an old
--   `http://` value there if it predates the V1 `actions` migration and was
--   never re-saved. Included for completeness / owner's own judgment; the
--   web app cannot act on it today either way since nothing reads this
--   column at run time.
-- Depends on: zzzz20260413120000_create_automation_rules.ts:31,32
--   (`action_type`, `action_config`).
-- Expected output shape: 1 row, 1 column `http_rules_legacy_column`.
SELECT count(*)::int AS http_rules_legacy_column
  FROM automation_rules
 WHERE action_type = 'send_webhook'
   AND action_config::text ILIKE '%"url":"http://%';


-- ── Q5. multitable_webhooks — http:// target COUNT, broken out by `active` ──
-- Purpose: total count of subscription rows whose `url` is `http://`,
--   grouped by `active` — NOT filtered to `active = true` only. The
--   webhook-service-ssrf-guard design doc's own "SCOPE CORRECTION" note
--   (webhook-service-ssrf-guard-design-20260912.md, just above its query
--   block) explains why an active-only count under-counts: `updateWebhook`
--   (`webhook-service.ts:297`, cited in that design doc) can flip a disabled
--   `http://` row back to `active: true` with no scheme check, so a disabled
--   row is one authenticated PATCH away from being live again.
-- Depends on: packages/core-backend/src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:34,37,40.
-- Expected output shape: 1-2 rows of (active boolean, http_webhooks int).
SELECT active, count(*)::int AS http_webhooks
  FROM multitable_webhooks
 WHERE url ILIKE 'http://%'
 GROUP BY active
 ORDER BY active DESC;


-- ── Q6. multitable_webhooks — http:// target IDS + active + created_by ─────
-- Purpose: id-level breakdown of Q5's population, `created_by` included so
--   the owner can identify which authenticated user owns each affected
--   subscription (`created_by` is a user id, an identifier — same posture as
--   the design doc's own per-owner breakout query).
-- Depends on: same migration line as Q5, plus `created_by` (:41).
-- Expected output shape: 0..N rows of (id, active, created_by).
SELECT id, active, created_by
  FROM multitable_webhooks
 WHERE url ILIKE 'http://%'
 ORDER BY active DESC, created_by, id;


-- ── Q7 (SUPPLEMENTARY, defence-in-depth context). Rows aimed at an obvious ──
-- ── internal literal, EITHER scheme — these were already failing to        ──
-- ── deliver even before either guard lands; not new breakage, but useful   ──
-- ── denominator context for the owner.                                    ──
-- Purpose / caveat: this is a FLOOR, not the guard's real predicate — see
--   webhook-service-ssrf-guard-design-20260912.md's two caveats after its
--   query block (misses 172.16/12 beyond a literal check, `*.internal`/
--   `*.local` names, IPv6 ULA/link-local, `::ffff:`-mapped IPv4 — all of
--   which `webhook-ssrf-guard.ts` DOES refuse once wired).
-- Depends on: same migration lines as Q1 for both tables.
SELECT 'automation_rules' AS source, count(*)::int AS internal_target_rows
  FROM automation_rules
 WHERE actions::text ~* '"url":"https?://(127\.|10\.|192\.168\.|169\.254\.|localhost)'
UNION ALL
SELECT 'multitable_webhooks' AS source, count(*)::int AS internal_target_rows
  FROM multitable_webhooks
 WHERE url ~* '^https?://(127[.]|10[.]|192\.168[.]|169\.254[.]|0\.0\.0\.0|localhost|\[::1\])';
