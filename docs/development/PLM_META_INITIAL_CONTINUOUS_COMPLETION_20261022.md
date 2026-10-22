# Meta initial continuous completion — design and validation

Status: slice A source verified locally; unpublished and held behind useful parent CI. The complete window goal remains open.

## Source and behavior

Source `f5f82d62b6d4c2e92d4bec6ee34494885e628726`, base `ed7b2945542346f52a1fc25b265b3f064b657aba`. Native dependency inspected at `dc31958b0eea29bd9fb00bfbcc5e77002f2d9bdd`. Actual Grok4.7(xhigh) implemented; Codex independently reviewed source, reproduced the downgrade counterexample and ran the final gates. This document is the separate closeout commit, not its own source SHA.

The existing provisioning body remains ordinary. The only extra accepted shape uses `continuityMode: "hour"`; its mode is immutable on the link and copied to the browser intent. Browser-start keeps its existing body. Navigation carries the bounded consent hint to the existing native login page.

Continuous completion freezes the code hash before sending to native, retains the same verifier and intent on unknown transport or local rollback, and commits one session per intent. A committed replay requires a fresh native exchange plus current local authority checks. It reuses the winner id, stored credential seal and absolute expiry; relative `expires_in` and randomized ciphertext cannot extend or distinguish a generation. Native response generation0 is bound to the credential JTI, delegation and expiry; decoded JWT claims are not independent authority. Terminal refusal never fabricates a consumed intent with missing delegation. Ordinary exchange behavior is preserved.

Local locks follow link, binding, intent, session order. Unlink wins before cookie publication. An observed losing response cannot enqueue revocation of the committed winner. Both Meta memberships and native tenant, organization, subject, root and origin remain separate checks; source configuration and owner authority remain persistent.

## Migration and downgrade

Forward migration adds frozen continuity/request mode, once-writable pending code hash and credential generation. Historical guards remain. Ordinary rows default to their previous behavior. Downgrade takes relation locks before checking for populated continuous evidence and refuses any evidence loss. It is not an operational disable mechanism.

The first candidate checked evidence before locking. An independent two-connection PostgreSQL run proved that an uncommitted continuous insert could commit while downgrade waited, after which the original candidate dropped its mode. The corrected migration waits before reading evidence, refuses after the writer commits and retains the row and column. Raw red/green evidence remains immutable; its manifest is `af7a4de258842569354b927480c2f5103630e12bdd145b9a4a0956ac772e8fb5`.

## Verification

From `packages/core-backend`, Node20:

```sh
npm run type-check
./node_modules/.bin/vitest run tests/unit/plm-managed-companion.test.ts --maxWorkers=1 --minWorkers=1 --retry=0
./node_modules/.bin/vitest run --config vitest.plm-managed-companion.config.ts
```

The PostgreSQL command requires identical explicit `DATABASE_URL` and `PLM_MANAGED_COMPANION_TEST_PG_URL` pointing at a fresh owned socket database. The unchanged owned-socket helper starts the cluster; `createdb --encoding=UTF8 --template=template0 --locale=C` creates the tested database. No shared database is used. Matching nonce cleanup proved PostgreSQL stopped and the owned directory removed.

- Full package TypeScript gate: exit0, including the recovery archive acceptance TypeScript project.
- Unit suite: 37 passed, zero failed/skipped, 1.33s. No later unit-source changes.
- Final independent real PostgreSQL suite: 62 passed (52 ordinary/existing plus10 continuous), zero failed/skipped, 8.08s. Retry0, original30s per-test/hook gates and missing-test failure retained.
- Coverage includes hash CAS/immutability, ordinary compatibility, unknown upstream200/local rollback, absolute expiry, fresh committed replay, changed JTI/expiry with preserved winner, malformed credentials, current membership loss, cross-identity/source refusal, concurrent HTTP requests and unlink.
- `git diff --check`: exit0.

The initial root TypeScript gate failed with four narrowing errors; that raw failure remains preserved. Explicit runtime type narrowing corrected it without casts that bypass validation. Earlier59/60 SQL_ASCII worker counts are historical and do not substitute for the final UTF8 run.

Receipt: `artifacts/plm-meta-initial-continuous-20261022/verification.json`. Private evidence bundle `w10-meta-initial-final-20261022`, manifest `bdfa68f33f4b24078a48a2c9346e3f57efa284ac5558b67078f410c01218d470`.

## Remaining acceptance

The native fetch override is process-local. Two concurrent callback requests are not independent operating-system workers or native+Meta cross-process acceptance. Renewal recovery, original iframe continuity, an actual wall-clock hour, exact new images, installation and backup/restore remain open. Prior native92 installed proofs remain attached only to those historical source/image identities.

No PR or CI is claimed for this source yet. Publication is held behind the exact parent368 queue; later publication stays Draft. No merge, deployment, production enablement or business notification is authorized by these results.
