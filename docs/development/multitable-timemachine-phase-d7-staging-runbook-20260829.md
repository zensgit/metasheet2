# Time Machine Phase D7 staging fault and scale runbook

**Status:** DRAFT / HOLD. This runbook has **not** been executed on staging. It is
not production enablement evidence.

**Scope:** one disposable, non-system staging sheet; one independently durable
object-store test domain; one staging KMS/key-custody test key; no production
host, tenant, key, object, or database.

The exact implementation evidence that prepared this runbook is documented in:

- `multitable-timemachine-phase-d2-d7-development-report-20260829.md`
- `multitable-timemachine-phase-d2-d7-verification-report-20260829.md`
- `multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`
  section 7

## 0. Current hard stop

Do not start the staging window until every item below is true on the exact
candidate SHA:

1. Preserve the runtime wiring merged by #5305: one canonical main-pool runtime
   is injected into both `/api/multitable` and compatibility `/api/univer-meta`
   mounts, and the application owns worker start and shutdown.
2. Land and remotely verify the post-merge closeout that bounds a stuck worker
   drain, exits non-zero when shutdown cannot drain it, and rejects malformed
   catalog/job-list/operation success data. At this runbook revision the latest
   local true-merge replay is `0464d551d8` (carrying code/test checkpoint
   `9c5c082a53`), not a pushed or deployed build.
3. The object store is independently durable from the hot database and the
   application host. Same-host local files do not satisfy this gate.
4. Key custody uses a staging KMS/test key and never exposes plaintext key
   material to the runbook or logs.
5. The exact candidate has full required CI, the archive real-DB lane reports
   zero skipped tests, and a current-main range-diff has been reviewed.
6. An owner explicitly authorizes the staging-only flag window and its rollback.

**Current verdict:** application runtime/worker wiring is present in merged code,
but the provider/KMS choices, local closeout landing, exact deployed SHA, staging
authorization, and staging execution are not all present. Therefore this runbook
is a prepared procedure, not an executed acceptance record.

## 1. Safety invariants

- Staging only. If any endpoint, database, object bucket, or key resolves to
  production, stop before the first write.
- Use a disposable sheet whose active users and integrations are known.
- Keep all external identifiers and credentials out of committed output.
- Never run migration `down()` as rollback. Catalog rows and external objects
  are not removed by a flag rollback.
- The only authorized flags for a future D7 staging window are the exact values
  recorded in the owner packet. This runbook never authorizes a flag itself.
- `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` and
  `MULTITABLE_ENABLE_WRITER_FENCE` are exact-literal gates: only `true` is on.
- Do not change retention, PIT reset, sheet revert, trust, approval, automation,
  or production flags as part of this runbook.
- Ordinary logs and the evidence bundle remain values-free.

## 2. Session placeholders

Set placeholders only in the operator session. Do not commit resolved values.

```bash
export BASE='<STAGING_BASE_URL>'
export TOKEN='<STAGING_OWNER_TOKEN>'
export SHEET='<DISPOSABLE_SHEET_ID>'
export PGURL='<STAGING_POSTGRES_DSN>'
export EXPECTED_SHA='<EXACT_CANDIDATE_SHA>'
export RUN_ID="tm-d7-$(date +%s)"
```

The token must resolve to the same staging workspace/base/sheet and must pass
current full-table read plus sheet-management authority. A production token is
invalid for this procedure.

## 3. Flag-OFF baseline

Before any authorized flag change:

1. Read the deployed build commit and compare it byte-for-byte with
   `$EXPECTED_SHA`.
2. Prove all Time Machine archive and writer-fence flags are absent or not exact
   `true` in both the running container and next-restart rendered configuration.
3. Call the catalog route and one preview route. A missing runtime may return the
   fixed values-free unavailable response; it must not mutate archive/job tables.
4. Record row counts for the Phase-D catalog, build attempts, source pins,
   object references, restore jobs, chunks, burns, legal holds, deletion intents,
   key registry, and nonce reservations for the disposable sheet.
5. Run one existing retention/recovery HTTP probe and retain its status/body plus
   SQL trace. These become the staging flag-off parity baseline.

Example route shape:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/multitable/sheets/$SHEET/recovery-archive/catalog?limit=1"
```

**PASS:** no archive write occurs and the baseline is values-free.

## 4. Runtime and failure-domain preflight

After a separately authorized staging deployment, but before enabling any
archive operation:

1. Prove the router received the archive runtime and both mount points expose the
   same owner route contract.
2. Prove the worker loop is started once, is non-overlapping, and stops cleanly.
3. Write a provider health object through the staging adapter, read it back,
   verify its digest, delete it through the provider receipt protocol, and prove
   no database transaction is open during any provider or KMS call.
4. Prove object durability from a process/host distinct from the application
   host. A local filesystem provider is permitted only for a test rehearsal and
   must be labelled non-production evidence.
5. Prove KMS MAC/unwrap/verify succeeds with the staging key and that ordinary
   logs contain no key, URI, sheet, actor, workspace, or base identifier.

**STOP:** any provider/KMS call under a DB transaction, same-host-only storage,
missing worker caller, missing runtime injection, or identity-bearing log.

## 5. Disposable scale fixture

Provision one staging sheet with:

- 5,001 records, so the effective write set is above the 5,000 sync ceiling;
- at least one attachment with an immutable version/hash;
- one link, one config revision, field/link tombstone evidence, and auto-number
  state needed by the complete section roster;
- no production integration or automation side effect;
- a known before/archive/after value for the first and last record.

Use the owner-approved staging fixture tool. If no tool can create this fixture
without bypassing production writers, stop rather than inserting ad hoc SQL.

Create and verify one current-head archive generation through the same runtime
that staging will use. Do not seed a fake `verified` catalog row.

**PASS:** the generation is complete and verified, the exact section roster and
counts match, source pins are released only after archive-object references are
durable, and the 5,001-record preview selects the async path without truncation.

## 6. Archive-builder fault matrix

Run each fault on a new generation. After every case, remove the fault and let
the owner/fence cleanup protocol converge.

| Injection point | Required result |
|---|---|
| after claim | hot evidence intact; no prune; build attempt abandoned |
| after capture/block | block/pins owned by exact fence; safe takeover only |
| after crypto reservation | nonce tombstone retained; no nonce reuse |
| after staged upload | staged-object absence is proved before pin/key release |
| after finalize CAS starts | either one verified generation or one abandoned attempt, never both |
| slow KMS/object store | no DB transaction/advisory fence held; cap/timeout is bounded |

For every row, query the exact generation/build owner and record only closed
states, counts, and opaque digests in the evidence bundle.

## 7. Restore-worker crash and resume

1. Preview a `revert` over all 5,001 records and accept the async job.
2. Let worker A commit chunk 0.
3. Stop worker A after the commit receipt and before pause/finalize.
4. Prove the durable job block remains active and an ordinary writer is refused.
5. Wait for the DB lease to expire; start worker B.
6. Prove worker B preserves the immutable block fence, increments only the worker
   fence, and the stale worker claim writes zero.
7. Resume through the remaining chunk and finalize the aggregate.
8. Prove both boundary records have exactly one restore revision, the sum of
   committed chunk counts is 5,001, the terminal operation is the aggregate with
   two members, and the writer block is released.

Repeat with a crash before the first chunk transaction. Then inject an authority
revoke or archive drift after chunk 0:

- expected terminal state: `abandoned_partial`;
- no later live write;
- the exact block owner releases by CAS;
- no partial endpoint is advertised as whole-sheet success.

## 8. Sync, permissions, and values-free controls

- Run a below-ceiling selected-record restore as the sync positive control.
- Revoke full-table read between preview and execute: expect zero live writes.
- Use a second workspace/base/sheet and actor as negative controls: expect fixed
  hidden/refusal shapes, never a token or job.
- Tamper generation/root/source vector/object version/section order/count/tag:
  expect refusal before the first live write.
- Confirm live permission grants are byte-identical before and after data restore.
- Inspect ordinary logs for the forbidden identity/value classes from section 1.

## 9. Rollback and residue

1. Stop the worker and wait for any in-flight tick.
2. Return the authorized staging flags to their exact pre-window values and
   redeploy/restart using the normal staging mechanism.
3. Re-run section 3 and compare the old HTTP/SQL baseline.
4. Remove only the disposable fixture through normal product writers.
5. Let lifecycle workers reconcile staging objects by their normal
   intent/receipt protocol. Do not delete object bytes or KMS keys manually.
6. Prove no active build, pin, job, chunk, burn, block, deletion intent, or hold
   remains for the disposable sheet. Verified/expired catalog history may remain
   according to the lifecycle contract and is not migration residue.

## 10. Evidence packet and final verdict

The staging evidence packet must bind:

- exact candidate/build SHA;
- required CI contexts and zero-skipped real-DB lane;
- runtime/provider/KMS configuration digests without raw values;
- every fault/scale case, expected state, observed state, and residue count;
- before/after flag posture;
- cleanup result;
- independent review verdict.

Allowed terminal verdicts:

- `PASS (staging only)`: every section above executed and passed;
- `HOLD-RUNTIME`: exact runtime wiring, independently durable provider, or KMS
  composition missing;
- `HOLD-EVIDENCE`: observation or required CI coverage incomplete;
- `FAIL`: an invariant or cleanup check failed.

No D7 verdict authorizes production, changes a production flag, or proves that a
same-host local provider is independently durable.
