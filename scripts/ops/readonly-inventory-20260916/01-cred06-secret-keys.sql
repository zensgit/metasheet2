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
--   production is almost certainly Shape A, but Q1 below MUST be run first to
--   confirm — do not assume.
--
-- VALUES-FREE: every query below returns only `count`, `id`, and (for the two
-- explicitly-labelled "supplementary" key-census queries) CONFIG KEY NAMES —
-- never a config VALUE. Key names are identifiers chosen by whoever configured
-- the data source (e.g. "password", "dbPass"), not secrets themselves; this
-- matches the design doc's own posture in its "A. 键普查" query. If your
-- values-free policy does not allow key names either, skip Q6/Q7 and rely on
-- Q2-Q5 only (pure count + id, zero key material).
--
-- RUN WITH: psql "$DATABASE_URL" -f 01-cred06-secret-keys.sql
-- Every statement here is a SELECT/WITH. Safe to run against a read-only role.
-- Safe to Ctrl-C between statements; nothing here holds a transaction open.
-- ============================================================================


-- ── Q1. Column-shape probe (RUN THIS FIRST) ────────────────────────────────
-- Purpose: determine which of Shape A / Shape B is live on this database
--   before running any of the queries below, exactly as
--   data-source-connection-secret-keys-design-20260912.md §5 (1) instructs.
-- Depends on: packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:30
--   (expects a `config` row of type `jsonb`) vs.
--   packages/core-backend/migrations/040_data_sources.sql:12
--   (expects a `connection` row of type `jsonb`, no `config` row).
-- Expected output shape: 1-2 rows of (column_name, data_type). If you see
--   `config | jsonb` → Shape A, use Q2/Q3 (and optionally Q6). If you see
--   `connection | jsonb` and no `config` row → Shape B, use Q4/Q5 (and
--   optionally Q7). If BOTH appear (a hand-patched or dual-migrated DB),
--   run both sets — they read disjoint columns and cannot double-count.
-- If `data_sources` itself does not exist: every query below will error with
--   `relation "data_sources" does not exist` (SQLSTATE 42P01) — stop here,
--   CRED-06 has nothing to inventory on this database.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'data_sources'
   AND column_name IN ('config', 'connection', 'credentials')
 ORDER BY column_name;


-- ── Q2. Shape A — hit COUNT (top-level `connection` + nested `connection.headers`) ──
-- Purpose: how many data_sources rows carry a secret-shaped key either
--   directly under `config->'connection'` or under `config->'connection'->'headers'`
--   (the nested nook `PLMAdapter` writes a live Bearer into — design doc §1
--   反例 2). Pure count, no id, no key name, no value.
-- Depends on: config column — migrations/20251206000001_create_data_sources_table.ts:30.
--   Regex is the SQL-side approximation of `isSecretConfigKey` documented in
--   data-source-connection-secret-keys-design-20260912.md §5 (2); reused
--   verbatim (not re-derived) to stay consistent with the design doc's own
--   B2 query.
-- Expected output shape: 1 row, 1 column `affected_rows` (integer >= 0).
-- If `config` column does not exist (Shape B database): this query errors
--   with `column "config" does not exist` (SQLSTATE 42703) — skip to Q4.
SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM (VALUES ('{connection}'::text[]),
                        ('{connection,headers}'::text[])
                ) AS p(path)
           CROSS JOIN LATERAL jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> p.path) = 'object'
                      THEN ds.config #> p.path
                      ELSE '{}'::jsonb END
               ) AS keys(k)
          WHERE lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
             OR lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
       );


-- ── Q3. Shape A — hit IDS (per-row breakdown, top-level vs nested) ─────────
-- Purpose: same predicate as Q2, but returns `id` per matching row so CRED-06
--   / #5648's migration step can be pointed at concrete rows. Distinguishes
--   "top-level `connection`" (safe-per-design-doc-§1 to clean, no adapter
--   reads a secret BY KEY NAME there) from "nested `connection.headers`"
--   (design doc §1 反例 2 — MAY be a live PLMAdapter Bearer token; do not
--   auto-clean without an owner-approved re-auth window, design doc §5 step 5).
-- Depends on: same migration line as Q2.
-- Expected output shape: 0..N rows of (id, matched_top_level boolean,
--   matched_headers boolean). No key names, no values, no data source name.
-- If `config` column does not exist: errors the same way as Q2 — skip to Q5.
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
 WHERE jsonb_typeof(ds.config #> '{connection}') = 'object'
    OR jsonb_typeof(ds.config #> '{connection,headers}') = 'object'
 ORDER BY ds.id;


-- ── Q4. Shape B — hit COUNT (`connection` column itself + nested `.headers`) ──
-- Purpose: same as Q2, for the alternate DDL where the connection object IS
--   the `connection` column (no enclosing `config`).
-- Depends on: packages/core-backend/migrations/040_data_sources.sql:12
--   (`connection JSONB NOT NULL`).
-- Expected output shape: 1 row, 1 column `affected_rows`.
-- If `connection` column does not exist (Shape A database): errors with
--   `column "connection" does not exist` (SQLSTATE 42703) — that is expected
--   and fine, it means Shape A is live and Q2/Q3 are the ones that matter.
SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM (VALUES ('{}'::text[]), ('{headers}'::text[])) AS p(path)
           CROSS JOIN LATERAL jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.connection #> p.path) = 'object'
                      THEN ds.connection #> p.path
                      ELSE '{}'::jsonb END
               ) AS keys(k)
          WHERE lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
             OR lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
       );


-- ── Q5. Shape B — hit IDS ───────────────────────────────────────────────────
-- Purpose: id-level breakdown, Shape B mirror of Q3.
-- Depends on: same migration line as Q4.
-- Expected output shape: 0..N rows of (id, matched_top_level, matched_headers).
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
 WHERE jsonb_typeof(ds.connection) = 'object'
    OR jsonb_typeof(ds.connection #> '{headers}') = 'object'
ORDER BY ds.id;


-- ── Q6 (SUPPLEMENTARY, Shape A only). Key census — key NAMES + row counts ──
-- Purpose: eyeball every distinct key name actually stored under
--   `config->'connection'` today, with how many rows carry it. This is how
--   an operator manually catches what the regex in Q2/Q3 cannot: full-width
--   / NFKC-compatibility spellings (the vocab module folds NFKC on read, this
--   SQL does not — design doc §5 note 3) and any token-split shape the SQL
--   `^(qualifier)?(pass|pw)$` approximation misses (design doc §5 note 1).
-- NOT values-free in the strictest sense — it returns KEY NAMES (identifiers
--   an operator typed when configuring a connection, e.g. "dbPassword"), never
--   VALUES. Skip this query entirely if your policy needs id/count only.
-- Depends on: same migration line as Q2.
-- Expected output shape: 0..N rows of (connection_key text, rows int),
--   ordered by rows desc. Compare the key list by eye against the word list
--   in the module header comment at the top of this file.
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;


-- ── Q7 (SUPPLEMENTARY, Shape B only). Key census — mirror of Q6 ────────────
-- Purpose / caveats: identical to Q6, for the Shape B `connection` column.
-- Depends on: same migration line as Q4.
-- Expected output shape: same as Q6.
SELECT k AS connection_key, count(*)::int AS rows
  FROM data_sources ds,
       LATERAL jsonb_object_keys(COALESCE(ds.connection, '{}'::jsonb)) AS k
 GROUP BY k
 ORDER BY rows DESC, connection_key;
