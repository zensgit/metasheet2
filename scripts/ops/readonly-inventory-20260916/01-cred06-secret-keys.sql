-- ============================================================================
-- 01-cred06-secret-keys.sql — CRED-06 read-only inventory
-- ============================================================================
-- Unlocks: PR #5648 (fix/data-source-secret-keys-vocab-nfkc, word-list widening
--          + NFKC fold) and PR #5681 (test/secret-keys-realdb-inventory-sync,
--          real-DB test lane for the same word list). Neither branch is on
--          `main` yet — this file is a STANDALONE re-derivation of the SQL in
--          their shared design doc, not a copy of code that exists on main.
--
-- SOURCE OF THE WORD LIST (not on main; fetched read-only for this task):
--   packages/core-backend/src/data-adapters/data-source-secret-keys.ts
--     on origin/fix/data-source-secret-keys-vocab-nfkc (also present on
--     origin/test/secret-keys-realdb-inventory-sync, identical content) —
--   `DATA_SOURCE_SECRET_KEY_WORDS` (substring words: password, passwd, pwd,
--   pswd, passphrase, passcode, secret, token, credential, apiKey, accessKey,
--   privateKey, authorization) + `wholeTokenOnly` words (pass, pw) that only
--   hit a whole camel/underscore token or `<GLUED_KEY_QUALIFIERS>+word`.
--   The SQL-side approximation of that whole-token rule is documented (and
--   reused verbatim below) in
--   docs/development/data-source-connection-secret-keys-design-20260912.md
--   §5 "SQL 侧的两个前置" (also fetched from the same two branches; the file
--   does not exist on main). This file DOES NOT re-litigate that regex — it
--   only adds `id`-bearing variants of the design doc's B2/B3-style queries,
--   because CRED-06 asks for "count AND id", not count alone.
--
-- TARGET TABLE — `data_sources`, confirmed to exist on `main` at:
--   Shape A (current app-code shape): `config jsonb NOT NULL`
--     packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:30
--     (table created :21, `id` :23)
--   Shape B (older, unused-by-app-code raw-SQL shape): `connection JSONB NOT NULL`,
--   `credentials JSONB` — NO `config` column
--     packages/core-backend/migrations/040_data_sources.sql:12-13 (table :7, `id` :8)
--   Both DDLs use `IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` — whichever ran
--   first on a given database wins. Application code (DataSourceManager,
--   db/types.ts `DataSourcesTable.config`) reads/writes Shape A exclusively, so
--   production is almost certainly Shape A, but the Q1 probe below DISPATCHES
--   on the answer rather than asking the operator to choose — see F5 below.
--
-- 2026-09-18 REVIEW REPAIR (F4 + F5), see
-- docs/development/readonly-inventory-pack-verification-20260916.md §"复核返修":
--   F4 — the old Q3/Q5 "affected ids" queries filtered on SHAPE only
--     (`jsonb_typeof(config #> '{connection}') = 'object'`), not on the secret-key
--     predicate. An ordinary connection with zero secret-shaped keys therefore
--     appeared in the id list while NOT being in the count. Both halves now read
--     the SAME `hit` CTE and the SAME `matched_top_level OR matched_headers`
--     filter, so count(ids) == count. Verified both ways (a clean connection
--     stays out, a matching one comes in) by
--     scripts/ops/readonly-inventory-20260916/verify/run-verify.mjs.
--   F5 — the pack now has ONE execution mode (whole file via `psql -f`),
--     ON_ERROR_STOP is armed by _preamble.sql, the shape branch is dispatched
--     automatically from the probe (no operator choice), and the file ends with
--     an explicit `INVENTORY_RESULT … status=complete|incomplete` line.
--
-- VALUES-FREE: every query below returns only `count`, `id`, and (for the two
-- explicitly-labelled "supplementary" key-census queries) CONFIG KEY NAMES —
-- never a config VALUE. The key census is now OPT-IN and OFF BY DEFAULT: key
-- names are identifiers an operator typed, but an arbitrary key name can still
-- carry business content, so it is not exported unless the owner asks for it
-- (`-v census=1`).
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 01-cred06-secret-keys.sql            # count + ids
--   psql "$DATABASE_URL" -v census=1 -f 01-cred06-secret-keys.sql  # + key census
--   psql "$DATABASE_URL" -v schema=public -f 01-cred06-secret-keys.sql
-- Every statement here is a SELECT/WITH, and the session is pinned
-- `default_transaction_read_only = on` by the preamble.
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Column-shape probe + automatic dispatch (F5) ───────────────────────
-- Purpose: determine which of Shape A / Shape B is live on this database and
--   DISPATCH to the matching queries automatically (psql \gset + \if), rather
--   than printing a shape and hoping the operator picks the right half.
-- Depends on: packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:30
--   (`config jsonb`) vs. packages/core-backend/migrations/040_data_sources.sql:12
--   (`connection jsonb`, no `config`).
-- Resolution: `current_schemas(false)` — the exact schemas the queries below
--   resolve through, so the probe cannot see a table the queries would not.
-- If BOTH columns exist (a hand-patched or dual-migrated DB), BOTH branches
--   run — they read disjoint columns and cannot double-count.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND table_name = 'data_sources'
   AND column_name IN ('config', 'connection', 'credentials')
 ORDER BY column_name;

SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources'
       ) AS has_data_sources,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources' AND column_name = 'config'
       ) AS has_config,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources' AND column_name = 'connection'
       ) AS has_connection
\gset


\if :has_config
\echo '-- Shape A detected (data_sources.config) — running Q2/Q3.'

-- ── Q2. Shape A — hit COUNT (top-level `connection` + nested `connection.headers`) ──
-- Purpose: how many data_sources rows carry a secret-shaped key either
--   directly under `config->'connection'` or under `config->'connection'->'headers'`
--   (the nested nook `PLMAdapter` writes a live Bearer into — design doc §1
--   反例 2). Pure count, no id, no key name, no value.
-- Depends on: config column — migrations/20251206000001_create_data_sources_table.ts:30.
--   Regex is the SQL-side approximation of `isSecretConfigKey` documented in
--   data-source-connection-secret-keys-design-20260912.md §5 (2).
-- Expected output shape: 1 row, 1 column `affected_rows` (integer >= 0).
-- F4: this `hit` CTE is character-for-character the one Q3 uses, and both
--   apply the same `matched_top_level OR matched_headers` filter.
WITH hit AS (
  SELECT ds.id,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> '{connection}') = 'object'
                      THEN ds.config #> '{connection}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_top_level,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> '{connection,headers}') = 'object'
                      THEN ds.config #> '{connection,headers}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_headers
    FROM data_sources ds
)
SELECT count(*)::int AS affected_rows
  FROM hit
 WHERE matched_top_level OR matched_headers;


-- ── Q3. Shape A — hit IDS (same population as Q2, per-row breakdown) ───────
-- Purpose: the id list CRED-06 / #5648's migration step can be pointed at.
--   Distinguishes "top-level `connection`" (safe-per-design-doc-§1 to clean,
--   no adapter reads a secret BY KEY NAME there) from "nested
--   `connection.headers`" (design doc §1 反例 2 — MAY be a live PLMAdapter
--   Bearer token; do not auto-clean without an owner-approved re-auth window).
-- Expected output shape: 0..N rows of (id, matched_top_level, matched_headers),
--   with N EXACTLY equal to Q2's `affected_rows` (F4 invariant, asserted by
--   verify/run-verify.mjs). No key names, no values, no data source name.
WITH hit AS (
  SELECT ds.id,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> '{connection}') = 'object'
                      THEN ds.config #> '{connection}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_top_level,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> '{connection,headers}') = 'object'
                      THEN ds.config #> '{connection,headers}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_headers
    FROM data_sources ds
)
SELECT id, matched_top_level, matched_headers
  FROM hit
 WHERE matched_top_level OR matched_headers
 ORDER BY id;

\if :{?census}
-- ── Q6 (SUPPLEMENTARY, OPT-IN, Shape A). Key census — key NAMES + row counts ──
-- Purpose: eyeball every distinct key name actually stored under
--   `config->'connection'` today, with how many rows carry it — how an operator
--   manually catches what the regex cannot: full-width / NFKC-compatibility
--   spellings (design doc §5 note 3) and token-split shapes the
--   `^(qualifier)?(pass|pw)$` approximation misses (design doc §5 note 1).
-- NOT values-free in the strictest sense: it returns KEY NAMES. Off unless the
--   owner passed `-v census=1`; do not paste its output into a shared channel.
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;
\else
\echo '-- Key census (Q6) skipped: opt-in only. Re-run with -v census=1 if the owner approves exporting key names.'
\endif

\else
\echo '-- Shape A NOT present (no data_sources.config column) — Q2/Q3 skipped.'
\endif


\if :has_connection
\echo '-- Shape B detected (data_sources.connection) — running Q4/Q5.'

-- ── Q4. Shape B — hit COUNT (`connection` column itself + nested `.headers`) ──
-- Purpose: same as Q2, for the alternate DDL where the connection object IS
--   the `connection` column (no enclosing `config`).
-- Depends on: packages/core-backend/migrations/040_data_sources.sql:12.
-- Expected output shape: 1 row, 1 column `affected_rows`.
WITH hit AS (
  SELECT ds.id,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection) = 'object'
                      THEN ds.connection ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_top_level,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection #> '{headers}') = 'object'
                      THEN ds.connection #> '{headers}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_headers
    FROM data_sources ds
)
SELECT count(*)::int AS affected_rows
  FROM hit
 WHERE matched_top_level OR matched_headers;


-- ── Q5. Shape B — hit IDS (same population as Q4) ──────────────────────────
-- Expected output shape: 0..N rows of (id, matched_top_level, matched_headers),
--   N EXACTLY equal to Q4's `affected_rows` (F4 invariant).
WITH hit AS (
  SELECT ds.id,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection) = 'object'
                      THEN ds.connection ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_top_level,
         EXISTS (
           SELECT 1 FROM jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection #> '{headers}') = 'object'
                      THEN ds.connection #> '{headers}' ELSE '{}'::jsonb END
               ) AS k
            WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
               OR lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                  ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
         ) AS matched_headers
    FROM data_sources ds
)
SELECT id, matched_top_level, matched_headers
  FROM hit
 WHERE matched_top_level OR matched_headers
 ORDER BY id;

\if :{?census}
-- ── Q7 (SUPPLEMENTARY, OPT-IN, Shape B). Key census — mirror of Q6 ─────────
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.connection, '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;
\else
\echo '-- Key census (Q7) skipped: opt-in only (see Q6 note).'
\endif

\else
\echo '-- Shape B NOT present (no data_sources.connection column) — Q4/Q5 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- A run WITHOUT this line is incomplete, whatever else it printed: the file
-- aborted (ON_ERROR_STOP), timed out (57014), was cancelled, or was truncated.
-- Never read an aborted run as "zero hits".
SELECT 'INVENTORY_RESULT file=01-cred06-secret-keys.sql status=' ||
       CASE
         WHEN NOT p.has_table  THEN 'incomplete reason=missing-table:data_sources'
         WHEN NOT (p.has_config OR p.has_connection)
              THEN 'incomplete reason=missing-column:data_sources.config+connection'
         ELSE 'complete shapes=' ||
              CASE WHEN p.has_config AND p.has_connection THEN 'A+B'
                   WHEN p.has_config THEN 'A' ELSE 'B' END ||
              ' census=' || CASE WHEN p.census_on THEN 'on' ELSE 'off(default)' END
       END AS inventory_result
  FROM (
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'data_sources') AS has_table,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'data_sources' AND column_name = 'config') AS has_config,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'data_sources' AND column_name = 'connection') AS has_connection,
           :{?census} AS census_on
  ) p;
