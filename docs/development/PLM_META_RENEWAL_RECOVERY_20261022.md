# Meta continuous renewal recovery — design and validation

Status: backend slice B verified locally. Publication remains queued; whole-window acceptance is open.

## Source and contract

Source `3d30489de756c7663cf7482de92c17009bf966ee`, parent `1014dc665fe27949fce59280b1dd9f2305888f78`. Actual Grok4.7(xhigh) implemented the bounded backend slice. Codex reviewed the implementation, reproduced race and expiry counterexamples, and independently ran the final TypeScript and PostgreSQL gates. This document is the separate closeout commit.

The exact POST `/api/plm/managed-login/renew-recovery` accepts only the verified managed cookie with the required origin/header/body contract. Authorization bearer credentials cannot substitute for the cookie, and recovery does not derive authority from `req.user` or decoded JWT fields. Other methods and suffixes fail closed. Current local membership, frozen link generation, binding, source configuration and separate native tenant/organization/subject remain mandatory.

A predecessor has one immutable renewal operation and idempotency key. Allocation is permitted only inside the 120-second renewal lead window. A lost response or local rollback retries that same operation. A successful response must match the native credential JTI, absolute expiry and generation; a replay cannot extend its lifetime. Ordinary native status verification remains unchanged and does not accept a rotated predecessor as a current bearer credential.

Locks follow the existing link/binding/session/operation ordering. Network exchange and renewal run outside those SQL transactions. Authority and expiry are checked again after waits and before cookie delivery. Ordinary completion freezes its deadline before intent consumption and exchange; a later lock wait cannot restart `expires_in`, and cookie max-age uses only the remaining lifetime.

## Publication and compensation

Ordinary completion, initial continuous completion and renewal publication all reserve the observed delegation before inserting a session. After acquiring that reservation, a separate statement sees a winner committed during the wait. Existing pending or acknowledged compensation evidence blocks a new publication; no outbox evidence is deleted to make a publisher succeed.

Ordinary malformed-response compensation uses the same serialized observation classifier and persistent outbox. The sole native revoke call is in the existing drainer, after the delegation reservation and a fresh tracked-session read. A publisher that wins first remains usable and is not revoked. Compensation that wins first retains evidence and prevents a later publisher from installing that delegation. Truly untracked observations remain drainable. Unlink/revocation retain the existing persistent identity and retry rules.

## Counterexamples retained

Independent red runs exposed invalid schema states, tracked predecessor compensation, a drainer racing an uncommitted renewal winner, an initial publisher without a reservation, ordinary TTL reset after a lock wait, and ordinary compensation bypassing the drainer. Each raw failure remains immutable. They are historical failures, not accepted versions.

The final ordinary compensation red observation was a native revoke followed by another initial publisher returning 200 with that delegation. On the final source, the same independent PostgreSQL ordering returned publisher 200, an empty compensation outbox and zero native revoke calls. Its owned cluster nonce `96490600b0db4a5f` was stopped and removed with its matching marker. The committed PostgreSQL suite also covers compensation-first pending/acked evidence, tracked observations, untracked drain and expiry boundaries.

## Verification

From `packages/core-backend`, Node20:

```sh
npm run type-check
./node_modules/.bin/vitest run --config vitest.plm-managed-companion.config.ts
```

The full PostgreSQL run used a fresh owned socket PostgreSQL16 UTF8 database, matching explicit test and application database URLs, and the unchanged owned-resource helper. Root results: TypeScript exit0; 90 tests passed across three files (28 renewal, 52 existing companion, 10 continuous), zero failed/skipped, 48.31s. All seven source-file hashes were stable before and after. Cleanup nonce `1299a9c8364d2a56` proved PostgreSQL stopped, its owned directory removed and its marker matched. `git diff --check` passed.

The worker separately reported 37 unit tests passed in 1.57s and 90 PostgreSQL tests passed in 48.60s; these are separate runs, not additional coverage counts. Root independently reran the complete PostgreSQL suite and TypeScript gate, plus the compensation counterexample.

Receipt: `artifacts/plm-meta-renewal-recovery-20261022/verification.json`. Private immutable evidence bundle `w10-meta-renewal-final-root-green-20261022`, manifest `9495458203992ab64dadfe2665eaf0029487a06dd37d7389d254574f004ff363`.

## Remaining acceptance

The native transport in these backend tests is a process-local fixture. Concurrent HTTP requests and PostgreSQL connections do not prove independent native/Meta operating-system processes, browser cookie-loss recovery or original iframe continuity. Frontend integration, an actual wall-clock hour, exact current images, installation and backup/restore remain open. Historical native92 image receipts qualify only their original source/image tuple.

No current-source PR CI is claimed. Keep later publication Draft and respect the serial queue. No merge, deployment, production enablement, real business notification or whole-goal completion follows from this local backend result.
