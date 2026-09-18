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
-- reason-class suffix of `scheme-not-allowed`.
--
-- 2026-09-18 REVIEW REPAIR — F3 (THE IMPORTANT ONE):
--   The first version of this file scanned `actions::text ILIKE '%"url":"http://%'`
--   (a pattern copied from the two design docs). That predicate is WRONG on
--   PostgreSQL and under-reports, possibly to zero:
--     * `jsonb` does not preserve the input's whitespace/formatting; its text
--       output form renders object members as `"url": "http://…"` WITH a space
--       after the colon, so the space-free pattern never matches a normally
--       stored row. (PostgreSQL JSON types doc: jsonb "does not preserve …
--       whitespace", and key order is not preserved either.)
--     * it is also sensitive to key case (`URL`), to the key being reached via
--       a different spelling, and it matches text that merely LOOKS like a
--       member (e.g. a `"url":"http://…"` fragment inside some description
--       string) — false negatives AND false positives in one pattern.
--   Replacement: JSON-SEMANTIC matching. `jsonb_path_query(actions, '$.**')`
--   walks every node (the array itself, each action object, and every nested
--   object such as a `condition_branch`'s inner `actions`), `jsonb_each_text`
--   reads that node's MEMBERS, and the predicate fires only when a member's
--   KEY normalises to a url-ish key name and its STRING VALUE actually starts
--   with the `http://` scheme (case-insensitively, after trimming surrounding
--   whitespace). No dependency on rendering, spacing, key order or key case.
--   Positive/negative cases proven on a synthetic PostgreSQL 16 by
--   scripts/ops/readonly-inventory-20260916/verify/run-verify.mjs: top-level
--   http hit, nested (condition_branch) http hit, https row NOT counted,
--   upper-case `HTTPS` NOT counted, and the spacing/case layout reversals that
--   the old text pattern missed.
--
-- 2026-09-18 REVIEW REPAIR — F5: single execution mode (whole file via
--   `psql -f`), ON_ERROR_STOP armed by _preamble.sql, table/column probe
--   dispatches the branches automatically, and the file ends with an explicit
--   `INVENTORY_RESULT … status=complete|incomplete` line. A missing table or
--   column yields `incomplete reason=…`, never a silent zero.
--
-- VALUES-FREE: no query below ever SELECTS `action_config`, `actions`, or
-- `url` (those can carry credentials in userinfo / query-string form). Only
-- `id`, `sheet_id`, `created_by`, `active` and counts are returned. URL values
-- are read only inside WHERE-clause predicates, never emitted.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 02-trg04-http-targets.sql
--   psql "$DATABASE_URL" -v schema=public -f 02-trg04-http-targets.sql
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Table/column probe + automatic dispatch (F5) ───────────────────────
-- Depends on:
--   automation_rules — table + `sheet_id`, `action_type`, `action_config`:
--     packages/core-backend/src/db/migrations/zzzz20260413120000_create_automation_rules.ts:24,27,31,32
--   automation_rules.actions (jsonb array, V1 multi-action shape — the shape
--     AutomationExecutor actually reads at run time):
--     packages/core-backend/src/db/migrations/zzzz20260414100000_extend_automation_rules.ts:27
--   multitable_webhooks — table + `url`, `active`, `created_by`:
--     packages/core-backend/src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:34,37,40,41
-- Resolution: `current_schemas(false)` — exactly what the queries resolve through.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND ((table_name = 'automation_rules' AND column_name IN ('id', 'sheet_id', 'action_type', 'action_config', 'actions'))
     OR (table_name = 'multitable_webhooks' AND column_name IN ('id', 'url', 'active', 'created_by')))
 ORDER BY table_name, column_name;

SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'automation_rules' AND column_name = 'actions') AS has_rules_actions,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'automation_rules' AND column_name = 'action_config') AS has_rules_legacy,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'multitable_webhooks' AND column_name = 'url') AS has_webhooks_url
\gset


\if :has_rules_actions
\echo '-- automation_rules.actions present — running Q2/Q3 (JSON-semantic http:// match).'

-- ── Q2. automation_rules — http:// target COUNT (actions jsonb, any depth) ──
-- Purpose: how many automation_rules rows aim at an `http://` target anywhere
--   inside `actions` — the column AutomationExecutor reads, so this is the
--   count that matters for #5619.
-- Predicate (F3): semantic, not textual. See the header. `$.**` covers the
--   array itself, each action object, and nested `condition_branch` actions
--   (automation-executor.ts:254-269).
-- Expected output shape: 1 row, 1 column `http_rules` (integer >= 0).
SELECT count(*)::int AS http_rules
  FROM automation_rules ar
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_path_query(ar.actions, '$.**') AS node
           CROSS JOIN LATERAL jsonb_each_text(
                 CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
               ) AS m(key, val)
          WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
            AND btrim(m.val) ILIKE 'http://%'
       );


-- ── Q3. automation_rules — http:// target IDS + sheet_id ───────────────────
-- Purpose: same population as Q2 (identical predicate text), with
--   `id`/`sheet_id` so the owner knows which teams to warn.
-- Expected output shape: 0..N rows of (id, sheet_id); N EXACTLY equals Q2's
--   `http_rules` (asserted by verify/run-verify.mjs).
SELECT ar.id, ar.sheet_id
  FROM automation_rules ar
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_path_query(ar.actions, '$.**') AS node
           CROSS JOIN LATERAL jsonb_each_text(
                 CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
               ) AS m(key, val)
          WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
            AND btrim(m.val) ILIKE 'http://%'
       )
 ORDER BY ar.sheet_id, ar.id;

\else
\echo '-- automation_rules.actions NOT present — Q2/Q3 skipped (see INVENTORY_RESULT below).'
\endif


\if :has_rules_legacy
-- ── Q4 (SUPPLEMENTARY). automation_rules — legacy single-action column ─────
-- Purpose: `action_config` is the ORIGINAL (pre-V1) single-action column that
--   AutomationExecutor no longer reads, but a row could still HOLD an old
--   `http://` value there. Same semantic predicate as Q2.
-- Expected output shape: 1 row, 1 column `http_rules_legacy_column`.
SELECT count(*)::int AS http_rules_legacy_column
  FROM automation_rules ar
 WHERE ar.action_type = 'send_webhook'
   AND EXISTS (
         SELECT 1
           FROM jsonb_path_query(ar.action_config, '$.**') AS node
           CROSS JOIN LATERAL jsonb_each_text(
                 CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
               ) AS m(key, val)
          WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
            AND btrim(m.val) ILIKE 'http://%'
       );
\else
\echo '-- automation_rules.action_config NOT present — Q4 skipped.'
\endif


\if :has_webhooks_url
\echo '-- multitable_webhooks.url present — running Q5/Q6.'

-- ── Q5. multitable_webhooks — http:// target COUNT, broken out by `active` ──
-- Purpose: total count of subscription rows whose `url` is `http://`, grouped
--   by `active` — NOT filtered to active-only: `updateWebhook`
--   (webhook-service.ts:297) can flip a disabled `http://` row back to active
--   with no scheme check, so a disabled row is one authenticated PATCH from live.
-- `url` is a text column, so the scheme test is a direct, case-insensitive,
--   whitespace-trimmed prefix test (no JSON involved).
-- Expected output shape: 1-2 rows of (active boolean, http_webhooks int).
SELECT active, count(*)::int AS http_webhooks
  FROM multitable_webhooks
 WHERE btrim(url) ILIKE 'http://%'
 GROUP BY active
 ORDER BY active DESC;


-- ── Q6. multitable_webhooks — http:// target IDS + active + created_by ─────
-- Purpose: id-level breakdown of exactly Q5's population (identical predicate).
-- Expected output shape: 0..N rows of (id, active, created_by); N equals the
--   SUM of Q5's `http_webhooks` (asserted by verify/run-verify.mjs).
SELECT id, active, created_by
  FROM multitable_webhooks
 WHERE btrim(url) ILIKE 'http://%'
 ORDER BY active DESC, created_by, id;
\else
\echo '-- multitable_webhooks.url NOT present — Q5/Q6 skipped.'
\endif


\if :has_rules_actions
-- ── Q7 (SUPPLEMENTARY, denominator context). Rows aimed at an obvious ──────
-- ── internal literal, EITHER scheme — already failing to deliver before   ──
-- ── either guard lands; context, not new breakage.                        ──
-- Caveat: this is a FLOOR, not the guard's real predicate (misses 172.16/12,
--   `*.internal`/`*.local` names, IPv6 ULA/link-local, `::ffff:`-mapped IPv4,
--   all of which `webhook-ssrf-guard.ts` DOES refuse once wired).
-- Same JSON-semantic extraction as Q2 (F3) — the host test runs on the VALUE,
--   which is never emitted.
SELECT 'automation_rules' AS source, count(*)::int AS internal_target_rows
  FROM automation_rules ar
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_path_query(ar.actions, '$.**') AS node
           CROSS JOIN LATERAL jsonb_each_text(
                 CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
               ) AS m(key, val)
          WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
            AND btrim(m.val) ~* '^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])'
       );
\endif

\if :has_webhooks_url
SELECT 'multitable_webhooks' AS source, count(*)::int AS internal_target_rows
  FROM multitable_webhooks
 WHERE btrim(url) ~* '^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])';
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line printed ⇒ the run aborted (error / statement
-- timeout 57014 / cancellation / truncated output) ⇒ INCOMPLETE, never "zero".
SELECT 'INVENTORY_RESULT file=02-trg04-http-targets.sql status=' ||
       CASE
         WHEN p.has_rules_actions AND p.has_webhooks_url THEN 'complete scope=automation_rules+multitable_webhooks'
         WHEN p.has_rules_actions THEN 'incomplete reason=missing-column:multitable_webhooks.url scope=automation_rules-only'
         WHEN p.has_webhooks_url  THEN 'incomplete reason=missing-column:automation_rules.actions scope=multitable_webhooks-only'
         ELSE 'incomplete reason=missing-column:automation_rules.actions+multitable_webhooks.url scope=none'
       END AS inventory_result
  FROM (
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'automation_rules' AND column_name = 'actions') AS has_rules_actions,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'multitable_webhooks' AND column_name = 'url') AS has_webhooks_url
  ) p;
