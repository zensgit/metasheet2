\set ON_ERROR_STOP on
\pset footer off
\if :{?backend_started_at}
\else
\echo DISPATCHING_CHECK=STOP missing_backend_started_at
\quit
\endif
\if :{?host_now}
\else
\echo DISPATCHING_CHECK=STOP missing_host_now
\quit
\endif
BEGIN READ ONLY;
SELECT 'clock' AS kind,
       abs(extract(epoch FROM now() - :'host_now'::timestamptz)) < 2 AS skew_ok,
       :'backend_started_at'::timestamptz <= now() + interval '2 seconds' AS start_not_future;
-- Other connections to this database (this psql session excluded). The backend's pools name
-- themselves 'metasheet-...'; sources = distinct client addresses among them. Counts only.
SELECT 'sessions' AS kind,
       count(*) FILTER (WHERE s.application_name LIKE 'metasheet-%') AS backend_sessions,
       count(DISTINCT coalesce(host(s.client_addr), 'local'))
         FILTER (WHERE s.application_name LIKE 'metasheet-%') AS backend_sources,
       count(*) FILTER (WHERE s.application_name NOT LIKE 'metasheet-%') AS other_sessions,
       count(*) FILTER (WHERE s.backend_type IS NULL) AS hidden_sessions
  FROM pg_stat_activity s
 WHERE s.datname = current_database() AND s.pid <> pg_backend_pid()
   AND (s.backend_type = 'client backend' OR s.backend_type IS NULL);
SELECT 'ledger' AS kind, status, count(*) AS n
  FROM integration_yida_delivery_ledger GROUP BY status ORDER BY status;
SELECT 'audit' AS kind, event, status, coalesce(reason, '-') AS reason, count(*) AS n
  FROM integration_yida_delivery_audit GROUP BY event, status, reason ORDER BY event, status, reason;
SELECT 'dispatching' AS kind,
       count(*) FILTER (WHERE c.n = 1
         AND c.claimed_at + interval '2 seconds' < :'backend_started_at'::timestamptz) AS claimed_before_start,
       count(*) FILTER (WHERE c.n = 1
         AND NOT (c.claimed_at + interval '2 seconds' < :'backend_started_at'::timestamptz)) AS claimed_after_start,
       count(*) FILTER (WHERE c.n <> 1) AS claim_audit_not_single,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM integration_yida_send_admissions a WHERE a.ledger_id = l.id)) AS without_admission
  FROM integration_yida_delivery_ledger l
  CROSS JOIN LATERAL (
    SELECT count(*) AS n, min(x.created_at) AS claimed_at
      FROM integration_yida_delivery_audit x
     WHERE x.ledger_id = l.id AND x.event = 'claim'
  ) c
 WHERE l.status = 'dispatching';
ROLLBACK;
