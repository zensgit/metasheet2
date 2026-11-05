-- ============================================================================
-- 05-trg04-webhook-target-totals.sql — read-only totals of EVERY webhook target
-- Same SQL that ran on site 2026-11-05 under the name 03-webhook-target-totals.sql (sha256 8f0733a9…).
-- ============================================================================
-- Why this file exists next to 02-trg04-http-targets.sql:
--   02 counts only `http://` targets and internal IP / name LITERALS. After
--   the R81 guards (#5619 rule-driven send_webhook, #5649 subscription
--   delivery) a target is also refused when its host NAME resolves to an
--   internal address (`dns-resolved-internal`) or does not resolve at all
--   (`dns-unresolved`). On an intranet install `https://<intranet name>/…` is
--   the likely shape, and no stored-data query can tell an intranet name from
--   a public one. So this file counts ALL targets, sorted into four buckets:
--     url_missing             url absent, JSON null, empty or blank: the step
--                             fails today already ("Webhook URL is required");
--                             unchanged by R81
--     not_https               url present but not a JSON string (number, array,
--                             object), or its scheme is not https -> refused
--                             after R81 (a one-element array of a URL string
--                             is sent by R80 and refused by R81)
--     https_internal_literal  https to an internal IP / name literal (same host
--                             set as 02's Q7) -> refused after R81
--     https_other             https to any other host. NOT a "safe" bucket:
--                             R81 still refuses the target when the name
--                             resolves to an internal address or does not
--                             resolve; when the receiver answers with ANY
--                             redirect (3xx); when the host is an unusual
--                             spelling of an internal address that the regex
--                             cannot see (`127.1`, a bare decimal, leading
--                             zeros, a CR/LF after the host); or when the url
--                             carries `user:pass@`. Someone on site has to
--                             check each one (report a count, never the host).
--   Every count zero for both sources => R81 changes nothing for this site's
--   automation rules and webhook subscriptions. (Button-field webhooks are a
--   separate path and are not counted here.)
--
-- On R80 neither path checks the target (rules: no check; subscriptions:
-- https-only at create in production, none on update), so intranet targets
-- that deliver today are NEWLY refused after R81. What a refusal does:
--   rule:         the send_webhook step fails with WEBHOOK_TARGET_REJECTED and
--                 every LATER action of that rule run is skipped;
--   subscription: nothing is sent, the delivery is recorded as failed, and
--                 after WEBHOOK_MAX_CONSECUTIVE_FAILURES (default 10) the app
--                 itself sets the subscription to active=false.
-- There is no setting that allows internal or http targets on R81.
--
-- Population, mirrored from R81 code:
--   rules: `actions` when it is a non-empty array, else the single legacy
--     action (`action_type` + `action_config`) — automation-service.ts
--     toExecutorRule. Within those, the top level plus one branch level
--     (`config.branches[*].actions[*]`, `config.defaultBranch.actions[*]`);
--     save-time validation forbids deeper nesting. Branches are walked under
--     any parent action type, so a send_webhook stored under a non-branch
--     action's `config.branches` is counted too (may overcount, never
--     under-counts). An action is a target when
--     its `type` is exactly `send_webhook` (no legacy alias maps to it); the
--     target is its `config.url`.
--   subscriptions: every `multitable_webhooks` row; the target is `url`.
--   `enabled` / `active` NULL is reported as false (not running).
--   Over-counts, never under-counts, against R81's executor: actions R81
--   would never reach (branches it never selects, actions after a broken
--   element, subscriptions with no sheet) are still counted.
-- Scheme test is `^https:` after trimming spaces, case-insensitive: the URL
--   parser accepts any run of `/` or `\` after a special scheme, so
--   `https:/x` and `https:\\x` are https too. A url with a leading TAB or
--   newline lands in not_https although R81 strips it (over-count).
--
-- VALUES-FREE: no id, sheet_id, created_by, name, url or config is selected.
--   Output is two small count tables plus the INVENTORY_RESULT line.
--
-- RUN WITH (the only supported form; `_preamble.sql` in the same directory):
--   psql -X -v schema=public -f 05-trg04-webhook-target-totals.sql
--   (-X: ignore any .psqlrc, which could turn AUTOCOMMIT off.)
-- ============================================================================

\ir _preamble.sql
-- The preamble's default_transaction_read_only only covers LATER
-- transactions. If this file runs inside one transaction (`psql -1`, or
-- AUTOCOMMIT off), that transaction is already open, so make it read-only too.
-- Switching TO read-only is allowed at any point in a transaction.
SET transaction_read_only = on;


-- ── Probe (missing table/column => that half skipped, result incomplete) ────
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'automation_rules'
           AND column_name IN ('id', 'enabled', 'action_type', 'action_config', 'actions')) = 5 AS has_rules,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'multitable_webhooks'
           AND column_name IN ('url', 'active')) = 2 AS has_webhooks
\gset


-- ── Internal host set: copied VERBATIM from 02-trg04-http-targets.sql Q7 ────
WITH atom AS (
  SELECT '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'::text AS o,  -- 0..255, no leading zero (0NN is octal to the parser)
         '[0-9a-f]{1,4}'::text                                 AS h   -- one IPv6 piece
), part AS (
  SELECT h,
         '(?:(?:0|10|127)(?:[.]' || o || '){3}'                         -- internal IPv4 (guard :32-37)
           || '|172[.](?:1[6-9]|2[0-9]|3[01])(?:[.]' || o || '){2}'
           || '|(?:192[.]168|169[.]254)(?:[.]' || o || '){2})' AS v4,
         o || '(?:[.]' || o || '){3}'                          AS d4    -- dotted tail inside an IPv6
    FROM atom
), v6 AS (
  SELECT h, v4,
         -- lookahead: the brackets hold an IPv6 the parser accepts — 8 pieces;
         -- 6 + dotted tail; or ONE `::` with <= 7 pieces (<= 5 + dotted tail)
         '(?=(?:(?:' || h || ':){7}' || h
           || '|(?:' || h || ':){6}' || d4
           || '|(?=(?::*' || h || '){0,7}:*\])(?:' || h || '(?::' || h || ')*)?::(?:' || h || '(?::' || h || ')*)?'
           || '|(?=(?::*' || h || '){0,5}:*' || d4 || '\])(?:' || h || '(?::' || h || ')*)?::(?:' || h || ':)*' || d4
           || ')\])' AS valid
    FROM part
)
SELECT '^https?:[/\\]*'                                   -- scheme, then any run of / or \
    || '(?:[^/?#\\]*@)?'                                  -- userinfo
    || '(?:' || v4 || '[.]?'                              -- IPv4 literal (a trailing dot is dropped)
    || '|(?![-a-z0-9_.]*xn--)(?:(?:[-a-z0-9_.]*[.])?localhost|[-a-z0-9_.]*[.](?:internal|local))[.]?'  -- name (:78-83)
    || '|\[' || valid || '(?:'                            -- IPv6 literal (:43-69):
    ||      '[0:]*(?:0{0,3}1)?'                           --   :: and ::1
    ||   '|[0:]*ffff:(?:' || v4                           --   ::ffff: + internal IPv4, dotted or hex
    ||      '|(?:0{0,2}[0-9a-f]{1,2}|0?a[0-9a-f]{2}|7f[0-9a-f]{2}|ac1[0-9a-f]|c0a8|a9fe):' || h || ')'
    ||   '|(?:f[cd][0-9a-f]|fe[89ab])[0-9a-f]:[0-9a-f:.]*'  --   ULA fc00::/7, link-local fe80::/10
    || ')\])'
    || '(?::0*(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])?)?'  -- port
    || '(?:[/?#\\]|$)'                                    -- the authority ends
       AS inv_internal_target_re
  FROM v6
\gset


\if :has_rules
-- ── R1. automation_rules: send_webhook targets by enabled × bucket ──────────
-- Always two rows (enabled t, f). webhook_rules = rules with >= 1 target;
-- the four bucket columns count TARGETS (one rule may have several).
WITH rule_actions AS (
  SELECT ar.id,
         COALESCE(ar.enabled, false) AS enabled,
         CASE WHEN jsonb_typeof(ar.actions) = 'array' AND jsonb_array_length(ar.actions) > 0
              THEN ar.actions
              ELSE jsonb_build_array(jsonb_build_object('type', ar.action_type,
                                                        'config', COALESCE(ar.action_config, '{}'::jsonb)))
         END AS acts
    FROM automation_rules ar
), top_level AS (
  SELECT ra.id, ra.enabled, a.action
    FROM rule_actions ra
    CROSS JOIN LATERAL jsonb_array_elements(ra.acts) AS a(action)
), all_actions AS (
  SELECT id, enabled, action FROM top_level
  UNION ALL
  SELECT t.id, t.enabled, ba.action
    FROM top_level t
    CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.action -> 'config' -> 'branches') = 'array'
               THEN t.action -> 'config' -> 'branches' ELSE '[]'::jsonb END) AS br(branch)
    CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(br.branch -> 'actions') = 'array'
               THEN br.branch -> 'actions' ELSE '[]'::jsonb END) AS ba(action)
  UNION ALL
  SELECT t.id, t.enabled, da.action
    FROM top_level t
    CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.action -> 'config' -> 'defaultBranch' -> 'actions') = 'array'
               THEN t.action -> 'config' -> 'defaultBranch' -> 'actions' ELSE '[]'::jsonb END) AS da(action)
), targets AS (
  SELECT id, enabled,
         action -> 'config' -> 'url' AS uj,
         CASE WHEN jsonb_typeof(action -> 'config' -> 'url') = 'string'
              THEN btrim(action -> 'config' ->> 'url') END AS u
    FROM all_actions
   WHERE jsonb_typeof(action) = 'object'
     AND action ->> 'type' = 'send_webhook'
), bucketed AS (
  SELECT id, enabled,
         CASE WHEN uj IS NULL OR jsonb_typeof(uj) = 'null' OR u = ''  THEN 'url_missing'
              WHEN u IS NULL                                          THEN 'not_https'  -- present, not a string
              WHEN u !~* '^https:'                                    THEN 'not_https'
              WHEN u ~* :'inv_internal_target_re'                     THEN 'https_internal_literal'
              ELSE                                                         'https_other'
         END AS bucket
    FROM targets
)
SELECT s.enabled,
       count(DISTINCT b.id)::int                                          AS webhook_rules,
       count(b.bucket)::int                                               AS targets,
       count(*) FILTER (WHERE b.bucket = 'url_missing')::int              AS url_missing,
       count(*) FILTER (WHERE b.bucket = 'not_https')::int                AS not_https,
       count(*) FILTER (WHERE b.bucket = 'https_internal_literal')::int   AS https_internal_literal,
       count(*) FILTER (WHERE b.bucket = 'https_other')::int              AS https_other
  FROM (VALUES (true), (false)) AS s(enabled)
  LEFT JOIN bucketed b ON b.enabled = s.enabled
 GROUP BY s.enabled
 ORDER BY s.enabled DESC;
\else
\echo '-- automation_rules columns missing — R1 skipped.'
\endif


\if :has_webhooks
-- ── W1. multitable_webhooks: subscriptions by active × bucket ───────────────
-- Always two rows (active t, f). A disabled row is one PATCH from live.
WITH bucketed AS (
  SELECT COALESCE(active, false) AS active,
         CASE WHEN url IS NULL OR btrim(url) = ''                     THEN 'url_missing'
              WHEN btrim(url) !~* '^https:'                           THEN 'not_https'
              WHEN btrim(url) ~* :'inv_internal_target_re'            THEN 'https_internal_literal'
              ELSE                                                         'https_other'
         END AS bucket
    FROM multitable_webhooks
)
SELECT s.active,
       count(b.bucket)::int                                               AS webhooks,
       count(*) FILTER (WHERE b.bucket = 'url_missing')::int              AS url_missing,
       count(*) FILTER (WHERE b.bucket = 'not_https')::int                AS not_https,
       count(*) FILTER (WHERE b.bucket = 'https_internal_literal')::int   AS https_internal_literal,
       count(*) FILTER (WHERE b.bucket = 'https_other')::int              AS https_other
  FROM (VALUES (true), (false)) AS s(active)
  LEFT JOIN bucketed b ON b.active = s.active
 GROUP BY s.active
 ORDER BY s.active DESC;
\else
\echo '-- multitable_webhooks columns missing — W1 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line printed => the run aborted => INCOMPLETE, never "zero".
SELECT 'INVENTORY_RESULT file=05-trg04-webhook-target-totals.sql status=' ||
       CASE
         WHEN :'has_rules'::boolean AND :'has_webhooks'::boolean THEN 'complete scope=automation_rules+multitable_webhooks'
         WHEN :'has_rules'::boolean    THEN 'incomplete reason=missing-columns:multitable_webhooks scope=automation_rules-only'
         WHEN :'has_webhooks'::boolean THEN 'incomplete reason=missing-columns:automation_rules scope=multitable_webhooks-only'
         ELSE 'incomplete reason=missing-columns:automation_rules+multitable_webhooks scope=none'
       END AS inventory_result;
