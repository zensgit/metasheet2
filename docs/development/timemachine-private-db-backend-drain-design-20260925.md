# Private-database backend drain before the checkpoint clean assertion

Base: `main` @ `ba6300ce4034515320026ec365bbc6e43f858cb4`, merged into this branch.

## Contract

`packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts` drops its private database only after `assertPrivateDatabaseBackendsExited` reports no backend whose `datname` is that database. The function lives in `packages/core-backend/scripts/private-db-backend-drain.ts`. `client.end()` and Kysely `db.destroy()` return when the client has asked to quit. PostgreSQL removes the backend from `pg_stat_activity` later. One immediate count can observe a backend that is already exiting.

The clean check polls for up to 10 seconds (200 ms interval). Zero rows ends the wait and the existing `DROP DATABASE` follows. A backend that is still attached when the deadline passes throws. The script does not call `pg_terminate_backend`. A held client, an autovacuum worker, or any other backend still counts as a failure.

The census connection is the script's admin client on the `postgres` database, so it is not a row in this count.

## Values-free failure text

The census SQL is `SELECT pid, application_name, backend_type, state, backend_start`. It does not select `query`. Statement text can embed row values, which is the same rule as review #4799 P2-2 on the scratch-database drain. `usename` is omitted: that residual census does not log role names, and this failure line follows that rule.

Each emitted field is charset-bounded. `pid` is an integer. `backend_start` is an ISO-8601 timestamp or `unknown`. `backend_type` and `state` keep letters, digits, dot, underscore, hyphen, and single spaces. `application_name` keeps letters, digits, dot, underscore, and hyphen. Anything else is dropped before the string is thrown, so it cannot reach a CI log.

## Observation this wait is aimed at

On draft #6051 head `abfb1f824`, `test (20.x)` job `108158496668` failed the previous one-shot assertion with `1 !== 0` after the checkpoint PASS lines. The same commit's `test (18.x)` job `108158496843` and `main` `4189aa096` `test (20.x)` job `108170710632` both printed `CLEAN: owned database and connections = 0`. A later attempt of the same head failed the same way. This change does not edit #6051.

## Tests

The source-string test is only a wiring guard. Behavior is proved on a throwaway database:

- Positive: a client stays connected for about 1.5 seconds and is then closed. The helper returns inside an 8 second limit, and the elapsed time shows it waited.
- Negative: a client runs `pg_sleep` past a 400 ms limit. The helper throws. The message contains `pid`, `backend_type`, `state`, `application_name`, and `backend_start`, and it does not contain the statement text.

CI runs that file from plugin-tests.yml job `test` (check names `test (18.x)` and `test (20.x)`), step `Run private-db backend drain proof`, after Postgres is up. The default unit Vitest config excludes the file so the no-database job cannot skip it.
