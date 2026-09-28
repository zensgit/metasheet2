# Private-database backend drain before the checkpoint clean assertion

Base: `main` @ `4189aa096a8a8054315bb97db79dfbac1823954e`.

## Contract

`packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts` drops its private database only after `pg_stat_activity` shows no backend whose `datname` is that database. `client.end()` and Kysely `db.destroy()` return when the client has asked to quit. PostgreSQL removes the backend from `pg_stat_activity` later. One immediate count can observe a backend that is already exiting.

The clean check polls that count for up to 10 seconds (200 ms interval). Zero rows ends the wait and the existing `DROP DATABASE` follows. A backend that is still attached when the deadline passes fails the run. The failure message names each remaining row: `pid`, `usename`, `application_name`, `backend_type`, `state`, `backend_start`, and `query` with whitespace collapsed and cut at 240 characters. The script does not call `pg_terminate_backend`. A held client, an autovacuum worker, or any other backend still counts as a failure.

The census connection is the script's admin client on the `postgres` database, so it is not a row in this count.

## Observation this wait is aimed at

On draft #6051 head `abfb1f824`, `test (20.x)` job `108158496668` failed this assertion with `1 !== 0` after the checkpoint PASS lines. The same commit's `test (18.x)` job `108158496843` and `main` `4189aa096` `test (20.x)` job `108170710632` both printed `CLEAN: owned database and connections = 0`. Those three runs logged the same migration replay fingerprint `651036c3ffcc978293e9e1bcfeb4de2d33458adfd80b88166ef1b50bf9d90063`. The failed assertion did not record `backend_type`. This change does not edit #6051.
