# Time Machine completion goal and first runtime repair

Status: ACTIVE development goal; bounded development and Draft/HOLD publication
only. This document does not declare Time Machine complete or enable recovery.

## Authority and baseline

The owner requested automatic difficulty-based model allocation and execution
of the remaining Time Machine repairs and development on 2026-09-15. Local
development, isolated synthetic verification, ordinary pushes, and Draft/HOLD
PRs are within the standing authorization. Ready/merge, flags, dispatch,
deployment, production, and real customer data remain separate gates.

Observed main: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.
First repair code: `f27045c44c5381045f2618c019ee8ebe80138be9`.
Code tree: `62fbd9a1e349c958eac12316a1ec1f93a634abc6`.

Do not edit the dirty canonical checkout, other tasks' worktrees, or historical
SHA-bound reports. Recheck main and candidate identity before publication. A
current-main change requires a bounded overlap review; it is not permission to
discard existing work or silently rewrite another candidate.

## Execution queue

### Operational attribution checkpoint (2026-09-15)

Read-only GitHub evidence, not a production probe or an alert-resolution claim:

- Phase 5 Nightly Validation run `34920290620`, job `104226687112` fails at validation. Regression run `34919841957`, job `104225261850`, and External Metrics run `34919685921`, job `104224778280`, fail at their final status gates. All three bind `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.
- All three report 11 checks: five passing, zero measured threshold failures, six N/A. Their parser finds 22 histogram families but zero matching the two configured latency families. Missing samples, rather than measured excessive latency, are the directly evidenced reason for failure.
- `scripts/phase5-thresholds.json` requests plugin reload for `example-plugin`, plus snapshot create/restore. `metrics.ts` declares those families; plugin-loader and SnapshotService contain observation call sites. Source existence does not prove the deployed registry, scrape target, label population or recent activity.
- At runtime candidate `8196e5f558c37cd01e79056c3c3be45eecadd54a`, required-samples plus cache contracts pass 6/6 locally. The missing-samples negative produces exactly five passes/six N/A/exit 1, while supplied synthetic latency samples produce 11 passes/exit 0. Validator, thresholds and required-samples test are byte-identical to the failed-run SHA.
- No alert, threshold, workflow, scrape configuration or production state was changed. These failures must remain open until the owner-selected target/label population and authorized sample evidence are established. Do not generate production reload/restore operations solely to silence the monitor, and do not count unrelated recent health-probe successes as closure. Other attendance scheduled failures are separate, not attributed by this checkpoint.

| Item | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Configuration-history UX | Draft #5704 at `e92e462b84e74aa242382c2f31eab326ceb60854`; exact-head checks terminal without failure | Current-main integration, independent final review, separate merge authorization |
| Recycle-bin/history separation and restoration UX | Draft #5709 at `478ed2da6cb22d5677a8f23f7df949f6b37b8b6f`; exact-head checks terminal without failure | Preserve snapshot/permission/conflict guards; current-main integration and merge gate |
| Archive unavailability and safe refresh | Draft #5725 at `978dc2e017f0db9ae878debd708cbf4560b8cec3`; exact-head CI running at initial census | Finish CI, keep read refresh separate from restore actions, merge gate |
| Archive startup provider contract | First repair code above; local validation complete | Independent review and exact published-head CI |
| Real archive runtime composition | `MetaSheetServer` accepts an injected composition, but direct startup uses `new MetaSheetServer()` without one | Complete production authority/apply callbacks and explicit provider/custody choice; retain fail-closed startup |
| Restart and recovery acceptance | Existing worker/lease/fence tests and D7 runbook are inputs, not a real process-restart acceptance record | Isolated synthetic process crash/restart, exact lease takeover, no duplicate writes, permission revoke, complete cleanup |
| Operational closeout | D8 metrics exist; current main also has scheduled/operational failed checks | Attribute actual failing runs separately from PR code CI; do not disable alerts or relax thresholds to get green |

Existing Draft candidates are not newly implemented by this goal and are not
merged merely because checks are green. Candidate-only functionality must not
be described as current-main or deployed functionality.

Ancestry check: `e92e462b84e74aa242382c2f31eab326ceb60854` is already an
ancestor of `478ed2da6cb22d5677a8f23f7df949f6b37b8b6f`. Integrating #5709
must preserve this configuration-history work, not replay #5704 a second time.
The new sheet recycle-bin UI and config-history actor enrichment are in that
candidate, not evidence that main already exposes them.

The bounded record-history census found no established new restore defect.
Follow-up acceptance should explicitly cover a selected schema-valid field
absent from the target snapshot (unset, preserving unselected fields), named
actors in the record drawer, and the drawer's visible user-timezone wording.
Schema-deleted/unknown/hidden fields remain fail closed; restoring field values
is not permission to recreate a removed schema definition.

The prior D7 staging runbook and D1 provider/custody decision section remain
references. No fake `async () => true` authority adapter, unverified catalog
row, or same-host fixture store may become a production composition or a claim
of independent durability. The all-main check list is not wholly green; passing
push/PR tests do not erase failed scheduled operational runs.

## First bounded repair

### Reproduced defect

`createRecoveryArchiveApplication` checks that custody/store providers are
objects but did not check the methods required by their public contracts. A
provider with a missing/non-callable method could expose router options and
resolve the database instead of failing during composition.

### Contract

1. When either existing activation flag is not exact `true`, return before
   reading the factory, providers, database, or starting a timer.
2. With both flags exact true, validate all five custody methods and all five
   store methods before database resolution or worker creation.
3. Missing or non-callable methods fail with the existing fixed
   `RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_FACTORY_FAILED` error.
4. Throwing provider accessors are normalized to the same fixed error, without
   forwarding provider text or a `cause` chain.
5. Prototype methods remain supported. Preflight does not call any provider
   operation, create keys, touch object storage, or test connectivity.
6. Existing provider object identity, receiver behavior, runtime authorization,
   worker lifetime, flag policy, and data-restore semantics are unchanged.

Production and test write set:

- `packages/core-backend/src/multitable/recovery-archive-application.ts`
- `packages/core-backend/tests/unit/multitable-recovery-archive-application.test.ts`

No migration, dependency, workflow, flag, frontend, API, or OpenAPI changes.
Method shape validation is necessary preflight, not provider authenticity,
immutability, connectivity, durability, or production-readiness evidence.

## Next bounded implementation

Sol's read-only trace identified a concrete vendor-neutral prerequisite:
`RecoveryArchiveApplicationComposition.worker.apply` is process-wide, while
the full-read and mutation callbacks in `MaterializedArchiveAsyncChunkApplyInput`
are currently request-closure-shaped. `executeRecoveryArchiveAsyncRestoreChunk`
already authenticates the durable binding, but passes those callbacks through
without a per-job workspace/base/sheet/actor context. The HTTP route constructs
its own callbacks per request in `resolveRecoveryArchiveRestoreOwnerContext`.

The next slice should pass an immutable job identity derived only from the
authenticated binding into worker authorization/mutation callbacks, adapting
back to the unchanged lower-level materialized apply contract. Candidate scope:
`recovery-archive-async-restore.ts`, its existing unit test, and the existing
`multitable-recovery-archive-restore-jobs-realdb.test.ts`. First reproduce the
callback context gap, then prove two jobs cannot share/swap actor or sheet
context, with the existing 5,001-record isolated DB gate and zero residue. Do
not use an allow-all callback as final production authority. No provider choice
or default enabled composition is included. This item is planned, not already
implemented or verified by the first repair.

## Model allocation and verification

The coordinator owns the critical implementation and final integration. Luna
performs the bounded UI/residual census; Sol high traces the runtime authority
and provider gap. A terminal independent review must bind immutable commits,
not a working tree while mutation tests are changing it. Model timeouts or
quota errors are not approval. Routine work uses the smallest suitable model;
high-risk recovery/permission/transaction work gets independent high-effort
review. No file has more than one concurrent writer.

Each completed slice needs focused tests plus relevant neighbors, discriminating
negative/mutation proof, typecheck, lint, diff/file census, and exact-head CI.
Real DB/browser/process evidence is required when the changed behavior needs
it; a mocked test is labelled as such. Design and verification MDs keep local,
remote, merge, runtime, and production evidence distinct.

## Scope stops

- Reconstructing bytes from an already physically destroyed sheet is not added
  implicitly. Whole-sheet recycle-bin semantics require the existing candidate
  and its explicit retained-data boundary, not archive resurrection claims.
- New conflict policies, permission restoration, key destruction, retention
  defaults, provider/custody selection, and production durability policy are not
  inferred from a general request to accelerate development.
- No real environment flag, dispatch, deployment, or production operation is
  performed by this goal without its separate authorization.

See `timemachine-archive-runtime-preflight-verification-20260915.md` for the
first repair's reproducible evidence. The overall goal remains active after
this bounded repair; remaining rows cannot be marked complete by this PR.
