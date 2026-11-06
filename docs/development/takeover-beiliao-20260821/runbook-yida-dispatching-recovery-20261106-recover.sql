\set ON_ERROR_STOP on
\pset footer off
\if :{?grant_id}
\else
\echo DISPATCHING_RECOVERY=STOP missing_grant_id
\quit
\endif
\if :{?backend_started_at}
\else
\echo DISPATCHING_RECOVERY=STOP missing_backend_started_at
\quit
\endif
\if :{?host_now}
\else
\echo DISPATCHING_RECOVERY=STOP missing_host_now
\quit
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
WITH locked AS (
  SELECT l.id, l.status
    FROM integration_yida_send_admissions a
    JOIN integration_yida_delivery_ledger l ON l.id = a.ledger_id
   WHERE a.grant_id = :'grant_id'
     FOR UPDATE OF l
)
SELECT count(*) = 1 AS one_row,
       min(id) AS ledger_id,
       coalesce(bool_and(status = 'dispatching'), false) AS still_dispatching
  FROM locked \gset
\if :one_row
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP no_single_row
\quit
\endif
\if :still_dispatching
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP status_not_dispatching
\quit
\endif
SELECT abs(extract(epoch FROM clock_timestamp() - :'host_now'::timestamptz)) < 2
         AS clock_skew_ok,
       :'backend_started_at'::timestamptz <= clock_timestamp() + interval '2 seconds'
         AS start_not_future,
       count(*) = 1
         AND coalesce(bool_and(c.created_at + interval '2 seconds'
                               < :'backend_started_at'::timestamptz), false)
         AS claimed_before_backend_start
  FROM integration_yida_delivery_audit c
 WHERE c.ledger_id = :'ledger_id'
   AND c.event = 'claim'
   AND c.status = 'dispatching' \gset
\if :clock_skew_ok
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP clock_skew
\quit
\endif
\if :start_not_future
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP backend_start_in_future
\quit
\endif
\if :claimed_before_backend_start
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=STOP claim_not_before_backend_start
\quit
\endif
UPDATE integration_yida_delivery_ledger
   SET status = 'outcome_unknown'
 WHERE id = :'ledger_id' AND status = 'dispatching';
INSERT INTO integration_yida_delivery_audit (id, ledger_id, event, status, reason)
VALUES (gen_random_uuid()::text, :'ledger_id', 'unknown', 'outcome_unknown', 'manual_recovery');
SELECT (SELECT count(*) FROM integration_yida_delivery_ledger
         WHERE id = :'ledger_id' AND status = 'outcome_unknown') = 1
   AND (SELECT count(*) FROM integration_yida_delivery_audit
         WHERE ledger_id = :'ledger_id' AND event = 'unknown') = 1
   AND (SELECT count(*) FROM integration_yida_delivery_audit
         WHERE ledger_id = :'ledger_id' AND event = 'unknown'
           AND status = 'outcome_unknown' AND reason = 'manual_recovery') = 1
   AS verified \gset
\if :verified
COMMIT;
\echo DISPATCHING_RECOVERY=DONE status=outcome_unknown reason=manual_recovery
\else
ROLLBACK;
\echo DISPATCHING_RECOVERY=ROLLED_BACK verify_failed
\endif
