-- ============================================================================
-- 06-trg04-button-webhook-totals.sql — read-only totals of button-field webhooks
-- ============================================================================
-- Why: the R81 inventory (03 / pack 05) counts automation rules and webhook
--   subscriptions only. A button field whose action is 「发送 Webhook」 is a
--   third path. Its target check is the same on R80 and R81, but R80's pinned
--   connection fails every HOST NAME url on Node 20 (ERR_INVALID_IP_ADDRESS),
--   so such buttons never delivered on R80. R81 fixes that connection, so after
--   the upgrade a click on such a button really sends. This file counts how
--   many button fields could change behaviour. A button sends only when a
--   user with the admin role or the exact `multitable:send_webhook`
--   permission clicks it; nothing is sent automatically.
--
-- Population, mirrored from multitable-button.ts (R80 and R81 identical):
--   meta_fields rows with type = 'button' whose property (a JSON object, or a
--   JSON string holding one) has actionType 'send_webhook' after trimming.
--   The target is property.actionConfig.url when it is a string (trimmed).
--
-- Buckets (one row of counts):
--   button_webhooks  every button field with actionType send_webhook
--   url_missing      no url / not a string / blank: fails on R80 and R81
--   refused_both     not https, or https to an internal IP / name literal
--                    (same host set as 02's Q7): refused on R80 and R81
--   https_ip_literal https to any other IP literal: sent on R80 already
--   https_hostname   https to a host NAME: failed on R80 under Node 20,
--                    SENT on R81 when the name resolves to a public address
--                    (refused when it resolves internal or not at all, or when
--                    the url carries user:pass@) -> the number that matters
--   unclassified     property or actionConfig stored as a JSON string: this
--                    file does not parse strings (invalid JSON would abort the
--                    run); someone on site checks each one (count only)
--   url_missing + refused_both + https_ip_literal + https_hostname
--     + unclassified = button_webhooks.
--   Over-counts https_hostname (never under-counts it): unusual spellings of
--   IP addresses (hex, `127.1` style with letters) land there.
--   Every number 0 => R81 changes nothing for button webhooks on this site.
--
-- VALUES-FREE: no id, sheet_id, name, url, header, body or secret is
--   selected. Output is one row of counts plus the INVENTORY_RESULT line.
--
-- READ ACCESS: needs SELECT on meta_fields (type, property). property also
--   holds each button's webhook secret, so who runs this, and with which
--   identity, is the owner's decision.
--
-- RUN WITH (the only supported form; `_preamble.sql` in the same directory):
--   psql -X -v schema=public -f 06-trg04-button-webhook-totals.sql
--   (-X: ignore any .psqlrc, which could turn AUTOCOMMIT off.)
-- ============================================================================

\ir _preamble.sql
-- The preamble's default_transaction_read_only only covers LATER
-- transactions. If this file runs inside one transaction (`psql -1`, or
-- AUTOCOMMIT off), that transaction is already open, so make it read-only too.
SET transaction_read_only = on;


-- ── Probe (missing table/column => counts skipped, result incomplete) ───────
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'meta_fields'
           AND column_name IN ('type', 'property')) = 2 AS has_fields
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


\if :has_fields
-- ── B1. button fields with a send_webhook action, by bucket ─────────────────
WITH btn AS (
  SELECT property AS p
    FROM meta_fields
   WHERE type = 'button'
), classified AS (
  SELECT CASE
           WHEN jsonb_typeof(p) = 'string'
                AND (p #>> '{}') ILIKE '%send_webhook%'               THEN 'unclassified'
           WHEN jsonb_typeof(p) = 'object'
                AND jsonb_typeof(p->'actionType') = 'string'
                AND btrim(p->>'actionType') = 'send_webhook'          THEN 'webhook'
           ELSE                                                            'not_webhook'
         END AS kind,
         CASE WHEN jsonb_typeof(p) = 'object' THEN p->'actionConfig' END AS ac
    FROM btn
), target AS (
  SELECT CASE
           WHEN kind = 'unclassified'                                  THEN 'unclassified'
           WHEN jsonb_typeof(ac) = 'string'                            THEN 'unclassified'
           WHEN jsonb_typeof(ac) IS DISTINCT FROM 'object'
             OR jsonb_typeof(ac->'url') IS DISTINCT FROM 'string'
             OR btrim(ac->>'url') = ''                                 THEN 'url_missing'
           WHEN btrim(ac->>'url') !~* '^https:'                        THEN 'refused_both'
           WHEN btrim(ac->>'url') ~* :'inv_internal_target_re'         THEN 'refused_both'
           WHEN btrim(ac->>'url') ~* '^https:[/\\]*(?:[^/?#\\]*@)?(?:\[[^\]]*\]|[0-9]+(?:[.][0-9]+)*[.]?)(?::[0-9]*)?(?:[/?#\\]|$)'
                                                                       THEN 'https_ip_literal'
           ELSE                                                             'https_hostname'
         END AS bucket
    FROM classified
   WHERE kind <> 'not_webhook'
)
SELECT count(*)::int                                                 AS button_webhooks,
       count(*) FILTER (WHERE bucket = 'url_missing')::int           AS url_missing,
       count(*) FILTER (WHERE bucket = 'refused_both')::int          AS refused_both,
       count(*) FILTER (WHERE bucket = 'https_ip_literal')::int      AS https_ip_literal,
       count(*) FILTER (WHERE bucket = 'https_hostname')::int        AS https_hostname,
       count(*) FILTER (WHERE bucket = 'unclassified')::int          AS unclassified
  FROM target;
\else
\echo '-- meta_fields columns missing — B1 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line printed => the run aborted => INCOMPLETE, never "zero".
SELECT 'INVENTORY_RESULT file=06-trg04-button-webhook-totals.sql status=' ||
       CASE
         WHEN :'has_fields'::boolean THEN 'complete scope=meta_fields'
         ELSE 'incomplete reason=missing-columns:meta_fields scope=none'
       END AS inventory_result;
