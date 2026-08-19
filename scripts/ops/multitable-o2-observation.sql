-- ============================================================================
-- multitable-o2-observation.sql — O-2 enablement-ladder observation queries
-- ============================================================================
-- Companion to docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md
-- (RATIFIED-track ladder; this file OBSERVES, it never enables/authorizes anything)
-- and to scripts/ops/multitable-o2-canary-drill.md (the L4/L5 drill runbook).
--
-- READ-ONLY BY CONSTRUCTION: every statement in this file is a SELECT (or a
-- WITH … SELECT). scripts/ops/multitable-o2-observation.test.mjs mechanically
-- asserts no other statement head can appear here. Run with a read-only role
-- where available. No statement here touches a remote host: an operator runs
-- this file against a database THEY are already authorized to reach.
--
-- HOW TO RUN:   psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql
-- (or paste individual queries). Placeholders the operator must edit are the
-- VALUES lists tagged "EDIT ME" — they default to obviously-synthetic ids so
-- the file executes as-is on any migrated database and returns the documented
-- empty-baseline shapes.
--
-- ============================================================================
-- HONEST SINK INVENTORY — read this before trusting any number below
-- ============================================================================
-- (a) 40001 occurrence COUNT: PostgreSQL keeps NO cumulative counter of
--     SQLSTATE 40001 (serialization_failure) raises. pg_stat_database has
--     `deadlocks` (= 40P01) but nothing for 40001. The authoritative 40001
--     occurrence count lives in the POSTGRES SERVER LOG (each authority-busy
--     refusal is `RAISE EXCEPTION ERRCODE '40001', MESSAGE
--     'METASHEET_RECOVERY_AUTHORITY_BUSY'` — see
--     packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts)
--     and in APP LOGS. Log access is host access → owner-gated, covered by the
--     drill runbook, NOT by this file. This file provides the DB-queryable
--     proxies: trigger posture (Q1), rollback/deadlock counter deltas (Q4),
--     and point-in-time lease contention (Q3).
-- (b) Classifier hits (HTTP 409 RECOVERY_AUTHORITY_BUSY count): there is NO
--     queryable DB sink. sendIfRecoveryConflict / sendRecoveryAuthorityBusy
--     write the 409 straight to the HTTP response
--     (packages/core-backend/src/db/recovery-conflict.ts). The generic
--     `audit_logs` table (zz20251231_create_audit_tables.ts) has NO live
--     writer on these paths (AuditRepository has no callers outside
--     src/audit/ at the head this file was authored against), and no
--     `operation_audit_logs` action exists for recovery-busy. 409 counts must
--     come from app/reverse-proxy logs (runbook, owner-gated). Q5 below
--     queries operation_audit_logs anyway as a drift canary: it is EXPECTED
--     to return zero rows at every ladder level; a nonzero result means
--     someone added an audit writer after this file was written — update this
--     inventory.
-- (c) Busy-exhaustion signals: two DB-queryable signals exist and are queried
--     below — the durable writer-fence state parked at 'paused_retryable'
--     (Q7), and drill-window arithmetic on token burns (Q6: an authorized
--     canary execute that produced NO burn row within the drill window failed
--     or exhausted; correlate with app logs).
--
-- Ladder-level legend used in the per-query shape notes:
--   L0  = factory inert (triggers DISABLED, 4 flags unset)
--   L1  = staging triggers ENABLED, flags still all OFF
--   L2  = + MULTITABLE_HISTORY_CONTIGUITY_STRICT
--   L3  = + MULTITABLE_ENABLE_WRITER_FENCE
--   L4  = + MULTITABLE_ENABLE_SHEET_REVERT (canary drill)
--   L5  = + MULTITABLE_ENABLE_PIT_RESET (canary drill)
--   L6  = full-posture soak
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Q1: recovery-authority trigger posture on the 8 platform-auth tables
-- ----------------------------------------------------------------------------
-- The 9 triggers / 8 tables are the authoritative set from
-- zzzz20260721121000_add_recovery_authority_locks.ts (RECOVERY_AUTHORITY_TRIGGERS).
-- The self-test cross-checks this list against that migration, so this query
-- reds in CI if the trigger set ever drifts.
--
-- tgenabled: 'D' = disabled, 'O' = enabled (fires on origin/local).
--
-- EXPECTED SHAPE:
--   Always: exactly 9 rows (fewer/more = schema drift → stop, run
--           scripts/ops/multitable-recovery-schema-containment.mjs).
--   L0:     all 9 rows enabled_state = 'D'  (inert baseline).
--   L1-L6:  all 9 rows enabled_state = 'O'. A MIX of 'D'/'O' is an alarm at
--           every level: partial enablement makes recovery fail closed
--           (authorityLease='unavailable') by design — roll forward to 9/9 or
--           back to 0/9, never sit mixed.
-- Q1
SELECT c.relname       AS table_name,
       t.tgname        AS trigger_name,
       t.tgenabled     AS enabled_state
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal
   AND (c.relname, t.tgname) IN (
         ('record_permissions',            'trg_record_permissions_recovery_authority_lock'),
         ('field_permissions',             'trg_field_permissions_recovery_authority_lock'),
         ('spreadsheet_permissions',       'trg_spreadsheet_permissions_recovery_authority_lock'),
         ('role_permissions',              'trg_role_permissions_recovery_authority_lock'),
         ('platform_member_group_members', 'trg_member_group_members_recovery_authority_lock'),
         ('user_roles',                    'trg_user_roles_recovery_authority_lock'),
         ('user_permissions',              'trg_user_permissions_recovery_authority_lock'),
         ('users',                         'trg_users_recovery_authority_lock_update'),
         ('users',                         'trg_users_recovery_authority_lock_lifecycle')
       )
 ORDER BY c.relname, t.tgname;


-- ----------------------------------------------------------------------------
-- Q2: authority lock/trigger function inventory
-- ----------------------------------------------------------------------------
-- The 6 functions installed by the same migration. This query checks PRESENCE
-- only; body fingerprints are owned by
-- scripts/ops/multitable-recovery-schema-containment.mjs (do not duplicate
-- fingerprints here — one authority).
--
-- EXPECTED SHAPE:
--   Every level L0-L6: exactly 6 rows (one per function name). Missing rows =
--   broken/partial migration → stop the ladder.
-- Q2
SELECT p.proname AS function_name,
       count(*)  AS overload_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = current_schema()
   AND p.proname IN (
         'metasheet_try_recovery_authority_user',
         'metasheet_try_recovery_authority_role',
         'metasheet_try_recovery_authority_group',
         'metasheet_recovery_authority_user_trigger',
         'metasheet_recovery_role_permission_trigger',
         'metasheet_recovery_authority_subject_trigger'
       )
 GROUP BY p.proname
 ORDER BY p.proname;


-- ----------------------------------------------------------------------------
-- Q3: point-in-time authority-lease / fence advisory locks for named subjects
-- ----------------------------------------------------------------------------
-- POINT-IN-TIME SAMPLE, not a rate: pg_locks shows locks held NOW. Run it in a
-- loop (e.g. \watch 5) during a drill window.
--
-- Key derivation mirrors the production lock functions exactly:
--   user  lease: hashtextextended('metasheet:recovery-authority:user:'  || btrim(id), 0)
--   role  lease: hashtextextended('metasheet:recovery-authority:role:'  || btrim(id), 0)
--   group lease: hashtextextended('metasheet:recovery-authority:group:' || btrim(id), 0)
--   sheet fence: hashtext('meta:auto-number:sheet:' || sheet_id)::bigint
--     (canonical-sheet-fence.ts — single-int advisory form)
-- One-arg advisory locks appear in pg_locks as locktype='advisory' with
-- classid = high 32 bits, objid = low 32 bits, objsubid = 1.
-- mode 'ShareLock' = writer-side shared lease; 'ExclusiveLock' = recovery-side
-- exclusive lease / fence.
--
-- EDIT ME: replace the VALUES list with the canary org's real subject ids and
-- the canary sheet id (drill runbook step L4-2). The defaults are synthetic
-- and match nothing.
--
-- EXPECTED SHAPE:
--   L0-L3 idle:  0 rows.
--   L4/L5 drill: rows ONLY while a recovery apply or platform write is
--                mid-transaction; exclusive rows should be short-lived (the
--                lease is NOWAIT + xact-scoped). A row persisting across many
--                samples with no drill activity = leaked-connection alarm.
--   L6 soak:     0 rows at idle sampling.
-- Q3
WITH subjects(kind, subject_id) AS (
  VALUES ('user',  'o2-canary-user-EDIT-ME'),
         ('role',  'o2-canary-role-EDIT-ME'),
         ('group', 'o2-canary-group-EDIT-ME'),
         ('sheet', 'o2-canary-sheet-EDIT-ME')
), keys AS (
  SELECT kind,
         subject_id,
         CASE kind
           WHEN 'user'  THEN hashtextextended('metasheet:recovery-authority:user:'  || btrim(subject_id), 0)
           WHEN 'role'  THEN hashtextextended('metasheet:recovery-authority:role:'  || btrim(subject_id), 0)
           WHEN 'group' THEN hashtextextended('metasheet:recovery-authority:group:' || btrim(subject_id), 0)
           WHEN 'sheet' THEN hashtext('meta:auto-number:sheet:' || subject_id)::bigint
         END AS lock_key
    FROM subjects
)
SELECT k.kind,
       k.subject_id,
       l.mode,
       l.granted,
       l.pid,
       a.state          AS backend_state,
       a.xact_start
  FROM keys k
  JOIN pg_locks l
    ON l.locktype = 'advisory'
   AND l.objsubid = 1
   AND l.classid::bigint = ((k.lock_key >> 32) & 4294967295)
   AND l.objid::bigint   = ( k.lock_key        & 4294967295)
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 ORDER BY k.kind, k.subject_id, l.pid;


-- ----------------------------------------------------------------------------
-- Q3b: ALL advisory locks currently held (coarse contention sample)
-- ----------------------------------------------------------------------------
-- Superset of Q3 (includes the two-int PIT namespace form, objsubid = 2, and
-- any other feature's advisory locks). Use when Q3 is empty but writers still
-- report busy — identifies which pids hold what.
--
-- EXPECTED SHAPE:
--   Idle database at any level: 0 rows. Nonzero at idle = investigate pids.
-- Q3b
SELECT l.locktype, l.classid, l.objid, l.objsubid, l.mode, l.granted, l.pid,
       a.state AS backend_state, a.query_start
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory'
 ORDER BY l.pid, l.classid, l.objid;


-- ----------------------------------------------------------------------------
-- Q4: rollback / deadlock counters (40001-rate proxy + the §4 no-40P01 check)
-- ----------------------------------------------------------------------------
-- DELTA DISCIPLINE: these are cumulative since stats reset. Record a BEFORE
-- snapshot at drill start and an AFTER snapshot at drill end; only the delta
-- is evidence. stats_reset tells you if someone reset counters mid-window
-- (if it changed between snapshots, the window is void — redo).
--
--   * deadlocks — counts SQLSTATE 40P01 exactly. This is the DB-side evidence
--     leg for the ladder §4 foreign-fence check: the L4/L5 link-in
--     concurrent-write drill step must show deadlock delta = 0.
--   * xact_rollback — coarse UPPER BOUND proxy for 40001 aborts. It counts
--     every rolled-back transaction (app errors, aborted psql sessions, …),
--     so it can only bound the 40001 rate from above; the exact 40001 count
--     is log-side (see sink inventory (a)).
--
-- EXPECTED SHAPE:
--   Always: exactly 1 row.
--   L0:     deadlock delta 0 over any window; xact_rollback delta ~ app noise.
--   L1:     xact_rollback delta may rise with real 40001 refusals (expected,
--           bounded); deadlock delta MUST stay 0.
--   L4/L5 drill window: deadlock delta MUST be 0 (link-in concurrent-write
--           step); rollback delta should reconcile with the drill's induced
--           busy refusals ± app noise.
--   L6:     deadlock delta 0 over the whole soak (hard criterion: 零 40P01).
-- Q4
SELECT d.datname,
       d.xact_commit,
       d.xact_rollback,
       d.deadlocks,
       d.stats_reset
  FROM pg_stat_database d
 WHERE d.datname = current_database();


-- ----------------------------------------------------------------------------
-- Q5: operation_audit_logs recovery-action canary (expected empty — see (b))
-- ----------------------------------------------------------------------------
-- There is deliberately NO recovery-busy audit writer today; 409 counts are
-- log-side. This query exists so that IF a future change starts auditing
-- recovery conflicts, the observation kit notices instead of silently
-- undercounting. Broad LIKE on purpose.
--
-- EXPECTED SHAPE:
--   Every level L0-L6: 0 rows. Nonzero = the sink inventory above is stale;
--   update this file before trusting log-side-only counts.
-- Q5
SELECT action, count(*) AS hits, min(created_at) AS first_seen, max(created_at) AS last_seen
  FROM operation_audit_logs
 WHERE action ILIKE '%recovery%'
    OR action ILIKE '%40001%'
    OR action ILIKE '%authority_busy%'
 GROUP BY action
 ORDER BY action;


-- ----------------------------------------------------------------------------
-- Q6: exact-anchor token burns (the only DB row a destructive execute leaves)
-- ----------------------------------------------------------------------------
-- meta_recovery_token_burns gets exactly one row per successful destructive
-- apply (burned inside the apply's own transaction —
-- zzzz20260719120000_create_meta_recovery_token_burns.ts). It is values-free
-- (hash + sheet_id + actor + time; no anchor contents).
--
-- Busy-exhaustion use (sink inventory (c)): an authorized canary execute that
-- produced NO new burn row inside the drill window either aborted (drift /
-- busy-exhaustion — the intended fail-closed outcomes) or never ran; correlate
-- with the app-side response the operator received (409 busy / preview-drift
-- abort) in the drill log.
--
-- EXPECTED SHAPE:
--   L0-L3:  0 rows (flags off ⇒ no execute path can burn).
--   L4:     rows ONLY for the canary sheet, count == number of authorized
--           revert executes in the drill log. ANY row whose sheet_id is not in
--           the drill's declared canary set = STOP-THE-LADDER alarm (an
--           unauthorized destructive apply happened).
--   L5:     same, adding the reset drill's executes.
--   L6:     no growth outside authorized drills.
-- Q6
SELECT sheet_id,
       count(*)        AS burns,
       min(burned_at)  AS first_burn,
       max(burned_at)  AS last_burn
  FROM meta_recovery_token_burns
 GROUP BY sheet_id
 ORDER BY last_burn DESC NULLS LAST, sheet_id;


-- ----------------------------------------------------------------------------
-- Q7: durable writer-fence state — stuck/parked recovery detector
-- ----------------------------------------------------------------------------
-- meta_sheets.recovery_writer_state (zzzz20260715170000, CHECK-closed set:
-- NULL | 'fencing' | 'applying' | 'paused_retryable'). 'paused_retryable' is
-- the DB-visible busy-exhaustion signal: a recovery parked retryably instead
-- of absorbing into a stuck state.
--
-- EXPECTED SHAPE:
--   Steady state, every level: 0 rows.
--   L4/L5 drill: transient 'fencing'/'applying' rows for the canary sheet only,
--       clearing to 0 rows when the drill step completes.
--   Any 'paused_retryable' row = busy-exhaustion happened → runbook step
--       "parked recovery" applies (re-run or operator clear); a row of ANY
--       state persisting after the drill window = alarm, do not proceed to
--       the next rung.
-- Q7
SELECT id AS sheet_id,
       name,
       recovery_writer_state,
       updated_at
  FROM meta_sheets
 WHERE recovery_writer_state IS NOT NULL
 ORDER BY updated_at DESC;


-- ----------------------------------------------------------------------------
-- Q8: canary trash / link consistency (drill step "trash/link 核对")
-- ----------------------------------------------------------------------------
-- EDIT ME: replace the VALUES list with the drill's declared canary sheet ids.
-- Two result blocks in one query (UNION ALL, tagged by check_name):
--   * trash_rows:     trash inventory for the canary sheets — compare with the
--                     drill script's expected delete/restore ledger.
--   * dangling_links: links FROM canary-sheet records whose foreign_record_id
--                     no longer resolves to a live meta_records row. There is
--                     deliberately NO FK on meta_links.foreign_record_id
--                     (containment checks assert its absence), so revert/reset
--                     correctness here must be observed, not assumed.
--
-- EXPECTED SHAPE:
--   L0-L3:  0 rows for both blocks with synthetic defaults; with real canary
--           ids, trash_rows mirrors only deliberate drill deletes.
--   L4/L5:  after a PASSING drill: dangling_links count = 0 for the canary
--           set, trash_rows matches the drill ledger exactly. dangling_links
--           > 0 = FAIL the drill step; do not advance the rung.
-- Q8
WITH canary_sheets(sheet_id) AS (
  VALUES ('o2-canary-sheet-EDIT-ME')
)
SELECT 'trash_rows' AS check_name,
       t.sheet_id,
       count(*)::bigint AS rows,
       max(t.deleted_at) AS latest
  FROM meta_records_trash t
  JOIN canary_sheets cs ON cs.sheet_id = t.sheet_id
 GROUP BY t.sheet_id
UNION ALL
SELECT 'dangling_links' AS check_name,
       r.sheet_id,
       count(*)::bigint AS rows,
       NULL::timestamptz AS latest
  FROM meta_links l
  JOIN meta_records r ON r.id = l.record_id
  JOIN canary_sheets cs ON cs.sheet_id = r.sheet_id
  LEFT JOIN meta_records fr ON fr.id = l.foreign_record_id
 WHERE fr.id IS NULL
 GROUP BY r.sheet_id
 ORDER BY check_name, sheet_id;
