# Owner 裁断：DingTalk lifecycle post-merge — Fork A

**Date:** 2026-07-24

## Decision
- **Fork A (rebuild to design lock)** for D4 writer/ledger wiring (`directory-sync.ts`).
- **#4579 remains HELD** until split into independently reviewable windows (D3 migration → D4 ledger write → D5 mutex/generation → D6 restore → D7 Apply≈Plan).
- **Ghost-column / `.catch` class** is production-breaking under real Postgres (transaction poison → 25P02). Fix by matching real schemas, never swallow inside a transaction.

## Immediate land (this stream)
- Real table writes for T3 activate + D7 restore (`user_orgs` real columns; `user_external_auth_grants` + `granted_by` on restore).
- Membership restore **rowcount fail-close** → `DRIFT_CONFLICT`.
- Alias cutover gate on Auth login path; cutover-status no longer `ready:true` merely because env is off.
- Alias claim **inside** activate transaction (fail-close).
- Evidence list APIs fail-honest (no empty array on query error).
- Closeout MD corrected to **partial** + hard NO-GO on deprovision canary.

## Explicit non-goals of this land
- Wiring `applyDirectoryDeprovisionPlan` into sync (Claude D4 / #4579 path A).
- Full alias writers on register/admin create (follow-up).
- T3 batch + SSO `intent=activate` routes (partial T3 stays honest until shipped).

## Canary
All of `AUTH_LOGIN_USE_ALIASES`, `DIRECTORY_PENDING_ACTIVATION_ENABLED`, `DIRECTORY_DEPROVISION_ENABLED` stay **OFF**.
