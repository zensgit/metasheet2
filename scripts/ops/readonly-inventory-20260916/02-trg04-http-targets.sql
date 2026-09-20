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
--   Replacement: JSON-SEMANTIC matching (not textual). That part stands.
--
-- 2026-09-20 REVIEW REPAIR — F6 (narrow the target allowlist):
--   F3's replacement predicate was `jsonb_path_query(actions, '$.**')` + a
--   seven-name key allowlist. Both halves were too wide, in two different ways.
--
--   (a) THE KEY ALLOWLIST. Of `url / webUrl / webhookUrl / endpoint /
--       endpointUrl / targetUrl / callbackUrl`, exactly ONE — `url` — is ever
--       read as an egress target. Proof, on this worktree:
--         * automation rules: `executeSendWebhook` reads `config.url` and
--           nothing else url-shaped —
--           packages/core-backend/src/multitable/automation-executor.ts:4199
--           (`const url = config.url as string | undefined`), reached from the
--           dispatch at :2591 with `action.config`; the typed contract is
--           `SendWebhookConfig { url, method?, headers?, body?, secret? }` —
--           packages/core-backend/src/multitable/automation-actions.ts:144-151.
--           The simulate path reads the same member —
--           automation-executor.ts:1012.
--         * the editor only ever writes that member —
--           apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:504
--           (`v-model="action.config.url"`) and :3801.
--         * webhook subscriptions: delivery reads the `url` COLUMN —
--           packages/core-backend/src/multitable/webhook-service.ts:394
--           (`this.fetchFn(wh.url, …)`).
--       The other six names have ZERO read sites in either population: grep of
--       `webUrl|web_url|endpointUrl|endpoint_url|targetUrl|target_url|
--       callbackUrl|callback_url` over packages/ apps/ plugins/ returns 0 hits
--       repo-wide, and `endpoint` has 0 hits anywhere under
--       packages/core-backend/src/multitable/. `webhookUrl`/`webhook_url` DO
--       exist, but never inside these two populations: they are the DingTalk
--       robot destination column (`dingtalk_group_destinations.webhook_url`,
--       encrypted at rest, https-and-host pinned by
--       packages/core-backend/src/integrations/dingtalk/robot.ts:33-55, so it
--       cannot hold an `http://` target at all) and the HTTP request-body field
--       that CREATES a `multitable_webhooks` row
--       (packages/core-backend/src/routes/api-tokens.ts:55) — the stored column
--       is `url`, which Q5/Q6 already read directly.
--
--   (b) THE `$.**` RECURSION — the false-positive source. `$.**` walks EVERY
--       node under `actions`, including a `send_webhook` action's
--       USER-AUTHORED `body` and `headers`. Those are payload, not egress
--       targets: `executeSendWebhook` serialises `config.body` and POSTs it TO
--       `config.url` (automation-executor.ts:4205-4216) — a
--       `body.callbackUrl = "http://…"` string is a value the RECEIVER will
--       use, and no guard in #5619/#5649 rejects it. Counting it as an
--       "http egress target" inflates the number owner uses to decide whether
--       https-only is safe to turn on. Same for a `headers` member.
--
--   NARROWED PREDICATE. The count that drives the decision now matches ONLY
--   the jsonpaths the executor actually dereferences:
--       $[*].config.url
--       $[*].config.branches[*].actions[*].config.url
--       $[*].config.defaultBranch.actions[*].config.url
--   One nesting level is the whole space: `condition_branch` reads
--   `config.branches[*].actions` (automation-executor.ts:2348, :2378) and
--   `config.defaultBranch.actions` (:2342, :2372-2373); `parallel_branch`
--   reads `config.branches[*].actions` (:2247); and SAVE-TIME validation
--   refuses a `condition_branch` or `parallel_branch` INSIDE a branch, so
--   there is no level 3 —
--   packages/core-backend/src/multitable/automation-service.ts:874, :877
--   (branches) and :902, :905 (defaultBranch).
--   Member lookup is case-SENSITIVE on purpose: `config.url` is a JavaScript
--   property read, so a stored `"URL"` member is NOT an egress target. The
--   scheme test on the VALUE stays case-insensitive (`ILIKE 'http://%'`),
--   because URL schemes are.
--
--   NOTHING IS LOST. Every query that narrowed keeps the old `$.**` +
--   seven-key logic side by side as an explicitly-labelled UPPER BOUND column
--   (`*_upper_bound`). Narrow ⊆ upper bound by construction (`url` is in the
--   old key list and the narrow paths are a subset of the nodes `$.**` walks),
--   so `upper_bound − narrow` is exactly "strings that look like http targets
--   but are not read as one" — payload/headers/mis-cased keys. If the owner
--   wants to treat that gap as suspicious, the ids are in Q3.
--
-- 2026-09-18 REVIEW REPAIR — F5: single execution mode (whole file via
--   `psql -f`), ON_ERROR_STOP armed by _preamble.sql, table/column probe
--   dispatches the branches automatically, and the file ends with an explicit
--   `INVENTORY_RESULT … status=complete|incomplete` line. A missing table or
--   column yields `incomplete reason=…`, never a silent zero.
--
-- F4 DISCIPLINE (do not regress): within each query pair the count and the id
-- list are computed from a CHARACTER-FOR-CHARACTER identical `hit` CTE and
-- filtered by the same expression, so `|narrow ids| == narrow count` and
-- `|listed ids| == upper-bound count` are assertable invariants (checked by
-- verify/run-verify.mjs).
--
-- VALUES-FREE: no query below ever SELECTS `action_config`, `actions`, or
-- `url` (those can carry credentials in userinfo / query-string form). Only
-- `id`, `sheet_id`, `created_by`, `active`, booleans and counts are returned.
-- URL values are read only inside WHERE-clause predicates, never emitted.
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
\echo '-- automation_rules.actions present — running Q2/Q3 (narrow read-path match + upper bound).'

-- ── Q2. automation_rules — http:// target COUNT (narrow) + upper bound ─────
-- Purpose: `http_rules` is THE number that matters for #5619 — how many rules
--   aim an `http://` target at a jsonpath AutomationExecutor actually
--   dereferences. `http_rules_upper_bound` is REFERENCE ONLY: the pre-F6 wide
--   sweep (`$.**` over every node, seven url-ish key names). Read the gap as
--   "http:// strings that are NOT egress targets" (a `send_webhook` body /
--   headers member the receiver consumes, or a mis-cased key the executor
--   never reads) — see the header §F6(b). Do NOT use the upper bound to size
--   the breakage; use it to decide whether the gap deserves its own look.
-- Expected output shape: 1 row, 2 columns (integers >= 0), narrow <= bound.
WITH hit AS (
  SELECT ar.id,
         ar.sheet_id,
         EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                    '$[*].config.url'::jsonpath,
                    '$[*].config.branches[*].actions[*].config.url'::jsonpath,
                    '$[*].config.defaultBranch.actions[*].config.url'::jsonpath
                  ]) AS p(read_path)
             CROSS JOIN LATERAL jsonb_path_query(ar.actions, p.read_path) AS v(url_value)
            WHERE jsonb_typeof(v.url_value) = 'string'
              AND btrim(v.url_value #>> '{}') ILIKE 'http://%'
         ) AS narrow_hit,
         EXISTS (
           SELECT 1
             FROM jsonb_path_query(ar.actions, '$.**') AS node
             CROSS JOIN LATERAL jsonb_each_text(
                   CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
                 ) AS m(key, val)
            WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                  IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
              AND btrim(m.val) ILIKE 'http://%'
         ) AS upper_bound_hit
    FROM automation_rules ar
)
SELECT (count(*) FILTER (WHERE narrow_hit))::int      AS http_rules,
       (count(*) FILTER (WHERE upper_bound_hit))::int AS http_rules_upper_bound
  FROM hit;


-- ── Q3. automation_rules — http:// target IDS + sheet_id ───────────────────
-- Purpose: same `hit` CTE as Q2 (character-for-character), so the owner can
--   see WHICH rules are behind each of Q2's two numbers.
--   `narrow_hit = t` → this rule breaks when #5619 lands; warn its sheet team.
--   `narrow_hit = f AND upper_bound_hit = t` → an `http://` string lives
--   somewhere in the rule (payload/headers/mis-cased key) but is not an egress
--   target; informational.
-- Expected output shape: 0..N rows of (id, sheet_id, narrow_hit,
--   upper_bound_hit). INVARIANTS (asserted by verify/run-verify.mjs):
--     count(rows WHERE narrow_hit) == Q2.http_rules
--     count(rows)                  == Q2.http_rules_upper_bound
--   (the second holds because narrow ⊆ upper bound — header §F6.)
WITH hit AS (
  SELECT ar.id,
         ar.sheet_id,
         EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                    '$[*].config.url'::jsonpath,
                    '$[*].config.branches[*].actions[*].config.url'::jsonpath,
                    '$[*].config.defaultBranch.actions[*].config.url'::jsonpath
                  ]) AS p(read_path)
             CROSS JOIN LATERAL jsonb_path_query(ar.actions, p.read_path) AS v(url_value)
            WHERE jsonb_typeof(v.url_value) = 'string'
              AND btrim(v.url_value #>> '{}') ILIKE 'http://%'
         ) AS narrow_hit,
         EXISTS (
           SELECT 1
             FROM jsonb_path_query(ar.actions, '$.**') AS node
             CROSS JOIN LATERAL jsonb_each_text(
                   CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
                 ) AS m(key, val)
            WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                  IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
              AND btrim(m.val) ILIKE 'http://%'
         ) AS upper_bound_hit
    FROM automation_rules ar
)
SELECT id, sheet_id, narrow_hit, upper_bound_hit
  FROM hit
 WHERE narrow_hit OR upper_bound_hit
 ORDER BY sheet_id, id;

\else
\echo '-- automation_rules.actions NOT present — Q2/Q3 skipped (see INVENTORY_RESULT below).'
\endif


\if :has_rules_legacy
-- ── Q4 (SUPPLEMENTARY). automation_rules — legacy single-action column ─────
-- Purpose: `action_config` is the ORIGINAL (pre-V1) single-action column.
--   CORRECTION (2026-09-20): the pre-F6 comment here claimed the executor "no
--   longer reads" it. It does — `toExecutorRule` falls back to
--   `[{ type: action_type, config: action_config }]` whenever `actions` is
--   NULL or empty:
--   packages/core-backend/src/multitable/automation-service.ts:1187-1190.
--   So a row with NULL/empty `actions` runs its `action_config` verbatim, and
--   `config.url` is read at automation-executor.ts:4199 exactly as above.
-- Narrow paths here are the same read paths one level up (the legacy column IS
--   the action's `config`), gated by the `action_type` that decides how the
--   executor interprets it:
--     action_type='send_webhook'                      → $.url
--     action_type IN (condition_branch,parallel_branch)
--        → $.branches[*].actions[*].config.url
--        → $.defaultBranch.actions[*].config.url
--   This query deliberately does NOT reference `actions` — it must stay valid
--   on the old schema, where that column does not exist (and where the
--   fallback above therefore applies to EVERY row).
-- Expected output shape: 1 row, 2 columns; narrow <= bound.
WITH hit AS (
  SELECT ar.id,
         EXISTS (
           SELECT 1
             FROM unnest(
                    CASE
                      WHEN ar.action_type = 'send_webhook'
                        THEN ARRAY['$.url'::jsonpath]
                      WHEN ar.action_type IN ('condition_branch', 'parallel_branch')
                        THEN ARRAY['$.branches[*].actions[*].config.url'::jsonpath,
                                   '$.defaultBranch.actions[*].config.url'::jsonpath]
                      ELSE ARRAY[]::jsonpath[]
                    END
                  ) AS p(read_path)
             CROSS JOIN LATERAL jsonb_path_query(ar.action_config, p.read_path) AS v(url_value)
            WHERE jsonb_typeof(v.url_value) = 'string'
              AND btrim(v.url_value #>> '{}') ILIKE 'http://%'
         ) AS narrow_hit,
         EXISTS (
           SELECT 1
             FROM jsonb_path_query(ar.action_config, '$.**') AS node
             CROSS JOIN LATERAL jsonb_each_text(
                   CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
                 ) AS m(key, val)
            WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                  IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
              AND btrim(m.val) ILIKE 'http://%'
         ) AS upper_bound_hit
    FROM automation_rules ar
)
SELECT (count(*) FILTER (WHERE narrow_hit))::int      AS http_rules_legacy_column,
       (count(*) FILTER (WHERE upper_bound_hit))::int AS http_rules_legacy_column_upper_bound
  FROM hit;
\else
\echo '-- automation_rules.action_config NOT present — Q4 skipped.'
\endif


\if :has_webhooks_url
\echo '-- multitable_webhooks.url present — running Q5/Q6.'

-- ── Q5. multitable_webhooks — http:// target COUNT, broken out by `active` ──
-- Purpose: total count of subscription rows whose `url` is `http://`, grouped
--   by `active` — NOT filtered to active-only: `updateWebhook`
--   (webhook-service.ts:230, the `active` flip at :259) can turn a disabled
--   `http://` row back on with no scheme check, so a disabled row is one
--   authenticated PATCH from live.
-- NO ALLOWLIST NEEDED HERE (F6): the egress target is a dedicated `text`
--   COLUMN read verbatim at webhook-service.ts:394, so there is no key name to
--   guess and no JSON to recurse into. This query was already narrow; it is
--   unchanged, and it has no upper-bound twin because there is no wider
--   reading of "the url column".
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
-- F6: narrowed to the SAME read paths as Q2 — an internal-looking literal in a
--   `body` member is a payload value, not something this process dials. The
--   `$.**` reading is kept alongside as the labelled upper bound.
SELECT 'automation_rules' AS source,
       (count(*) FILTER (WHERE narrow_hit))::int      AS internal_target_rows,
       (count(*) FILTER (WHERE upper_bound_hit))::int AS internal_target_rows_upper_bound
  FROM (
    SELECT EXISTS (
             SELECT 1
               FROM unnest(ARRAY[
                      '$[*].config.url'::jsonpath,
                      '$[*].config.branches[*].actions[*].config.url'::jsonpath,
                      '$[*].config.defaultBranch.actions[*].config.url'::jsonpath
                    ]) AS p(read_path)
               CROSS JOIN LATERAL jsonb_path_query(ar.actions, p.read_path) AS v(url_value)
              WHERE jsonb_typeof(v.url_value) = 'string'
                AND btrim(v.url_value #>> '{}') ~* '^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])'
           ) AS narrow_hit,
           EXISTS (
             SELECT 1
               FROM jsonb_path_query(ar.actions, '$.**') AS node
               CROSS JOIN LATERAL jsonb_each_text(
                     CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}'::jsonb END
                   ) AS m(key, val)
              WHERE lower(regexp_replace(m.key, '[^A-Za-z0-9]', '', 'g'))
                    IN ('url', 'weburl', 'webhookurl', 'endpoint', 'endpointurl', 'targeturl', 'callbackurl')
                AND btrim(m.val) ~* '^https?://(127[.]|10[.]|192[.]168[.]|169[.]254[.]|0[.]0[.]0[.]0|localhost|\[::1\])'
           ) AS upper_bound_hit
      FROM automation_rules ar
  ) q7;
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
