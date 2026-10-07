# Time Machine G4 fresh ordinary-writer admission verification

Status: bounded local PASS; ordinary exact-source CI, full writer closure, composer/lifecycle,
D7 and owner stages remain OPEN. Baseline `ee89609e5baa84319949483113c35fb2a0d8a4f8`,
prerequisite Draft #6233. The design-lock preceded production edits; its SHA256 is
`ddc0cf0654bcf26e6a4789e96e3431ce6cbc6ac4cac4ea9cae7725aa7eb2057c`.

## Reproduced problem and change

`canonical-sheet-fence.ts::hasRecoveryWriterStateColumn` (~L181 on baseline) permanently caches
false. Ordinary `univer-meta.ts::PATCH /views/:viewId` (~L15421) then reaches the common assertion
and updates captured meta_views without another block check. A real same-process deployment
reproduces the defect: archive-OFF pre-column PATCH200 warms the false cache, actual production
migrations install writer state, and a genuine nonempty owned archiving claim commits. With both
flags literal-true, a later actual PATCH still returns200 and changes both source and subsequent
owned RR capture. History grows1→2; the claim has one genuine source pin.

Only the existing dual literal-true selector chooses the new common assertion branch. It verifies
actual READ COMMITTED and an ongoing native transaction, then directly reads public.meta_sheets.
Exactly one row with NULL state admits a writer; known blocks including expired archiving refuse.
Missing/malformed authority, unknown state and driver errors become the existing coarse writer-block
error. Native errors and xid values do not escape. An already-running RR transaction refuses.
The caller retains its existing canonical fence and transaction; no normalization, nested transaction
or owner exception is added. The original unselected body/cache/SQL/order remains byte-identical.

| Frozen input | SHA256 |
| --- | --- |
| canonical-sheet-fence.ts | 9a769e7a71112fd02ac300f1a07670a125723b6c90e96220b7b97f42d6db9493 |
| new unit spec | ffeef87d48c7e7b1b6437dddcbda3db104941f9bc0f2fed647237a65a666117d |
| final native spec | e49cef02fd8c2de638385b2c39b487f903ea0012d4f97ac4939bfce04dc31136 |
| new native fixture | 97b3bd95254c1c3bf181659b88392b3f63e23b0dc2547826963fa5c6a3856109 |
| original unselected assertion body | 89ba5338b399f721ad8e7fc638b8b0ba4b3e96b11f92bc341258ec5eb30ed89c |

## Executed evidence

- The unchanged-source whole native3 run has actual exit1, two PASS and one matching named raw
  AssertionError, zero skip. Diagnostics prove actual200/sourceChanged/capturedChanged; the first
  unblocked55-migration HTTP200/history COMMIT is a positive control. No module/cache/router reset
  occurs between warmup, migration, genuine claim, PATCH and capture. Root independently checks
  saved raw/process/JSON and original production bytes before authorizing the fix.
- The same original3 titles and assertions pass after the fix. Expanded whole native16 also passes,
  zero skip: sentinel1 and native15. Fixtures execute real42→55 migration ups, including the config
  revision source migration required by view history, and enable all nine authority guards through
  actual migration-fixture SQL. No separate final pg_trigger census is claimed.
  No substitute DDL, disabled guard or fabricated business SQL result is used.
- Native positives/refusals include genuine committed/expired archiving, complete preserved source/
  owner/generation/reservation/pin/head snapshots, both actual advisory-wait orders, captured committed
  view/history, selected missing-column refusal, six unselected flag spellings and actual autocommit
  with distinct transaction IDs. Genuine inherited RR is configured before BEGIN; the writer has an
  old NULL snapshot while the claim holds its fence, and protected admission refuses after claim COMMIT.
- Nine whole unit files pass425/425, zero skip: new115, archive writer-block10, writer-closure routes20,
  provisioning fence21, field-schema recheck120, G2 admission52, G3 retention admission33, preserved
  holder census51 and app-mode tripwire3. The new unit covers six distinct flag spellings in36 pairs,
  all35 unselected false-cache pairs, known/unknown/malformed authority, RC and transaction failures
  and error sanitization. Original435-case evidence is retained; redundant OFF permutations were
  reduced before implementation, preserving all43 selected baseline failures.
- Four source mutations each run whole native16: cache bypass reintroduced, known blocks admitted,
  RC verification omitted and transaction proof omitted. One unknown-state mutation runs whole
  unit115. Each has actual exit1, a matching named raw AssertionError, zero skip and only canonical
  source changed among64 snapshots. Exact restoration is followed by whole native16 PASS. Unknown
  states remain defensive unit coverage; the native enum constraint is preserved.
- Static wiring20 and the behavioral harness1 pass. All21 armed archive children actually fail their
  exact missing-DATABASE_URL sentinel. The new whole file joins the Node20 DB union and no-DB
  exclusion; all20 prior files remain. Official full provenance matches with only pluginTestsWorkflow
  changed to `35c8adc47562f2adf4e213e80dd8daea22adcd82f3fd4f9ac02a3fdd41f23218`.
  Standalone provenance, final unit/native TypeScript, pnpm validate:all and diff check exit0.
- Independent source/unit, native and final refutation audits qualify saved inputs/results without
  executing tests or accessing DB. The holder census actually runs in root425; the earlier agent371
  union contained field recheck120 and did not independently run census51.
- Official exclusive PG15 cleanup verifies zero scratch/non-system databases and other clients,
  faststop0/status3, absent PID/listener/postmaster.pid, refused TCP and deleted private profile.
  Root independently reads live stopped postconditions. Initialized data and all evidence remain.

Evidence: `artifacts/tm-fresh-writer-admission-20261007/` (ignored, retained locally).
Native baseline receipt SHA256: `4982d58ecea1060850f1c166aa6acc099b9d75032c0133368c9ec98c236deeb7`.
Native normal manifest SHA256: `7c9fb1796e3d8bc2479162e60feb468d28572a5877684e3ed49af30bad8ef9e0`.
Root final mutation receipt SHA256: `c11e1c535fe8d6f4c61a3ff435f3f772df9bff3a4b107df64190e739a6a15a0a`.
Independent final evidence audit SHA256: `13f1142efdf5435b5933d2293d2650ce60870ee2b372c109329359910407d977`.
Root configured-check receipt SHA256: `0fa83fe4c20904416bf264e2b901962d9804482dad7d4c15a20de729867db35f`.
Cleanup manifest SHA256: `ca4c501f9ba11d563cc5d8dde6559b6dbe243b7a8c1bf6faad29714a39b6beb2`.
Root live cleanup readback SHA256: `055bcbd7f9d8b936c3e9d32ad3bc5b45c3a936adfddb1357a6c9200742674859`.

First router initialization, an expanded writer-first operation-head expectation, TypeScript ambient/
mock-generic errors, the initial wiring anchor and cleanup symlink-text checks all remain preserved.
The writer-first view route records untagged config history; it does not create a sealed operation
head. The corrected assertion proves committed view/history and captured view, with operationHead
NULL. Type repairs change one mock generic or compiler arguments only. Armed NoDB has one failed
sentinel plus15 skipped native assertions; omitted/misleading top-level counters are not a native PASS.

## Gates and reproduction

| Gate | State | Boundary |
| --- | --- | --- |
| Baseline counterexample / selected refusal / positive / ordering | Local PASS | Real same-process deployment, genuine claims and view API/capture |
| Transaction / freshness / closed trust / OFF | Local PASS | Native waits/RR/autocommit/schema plus focused strict-state/flag matrix |
| Refutation / regression / configured checks | Local PASS | Four native and one unit RED, restored16, actual425/census51 and whole-file CI contract |
| Ordinary exact-source CI | OPEN | Requires published head and terminal raw qualification |
| Full writer closure / D-H2 / D-L / D7 | OPEN | Remaining census and complete owned bytes/crypto/coverage/finalize/abandonment/lifecycle/APFS |
| Owner stages | OPEN | Exact-SHA ratification, merge, flags, deployment and staging inputs |

Supply DATABASE_URL privately for a newly owned disposable PG; fixtures create/drop namespaced DBs.

```sh
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-fresh-writer-admission-realdb.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-fresh-writer-admission.test.ts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts tests/unit/supertest-app-mode-tripwire.test.ts
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
pnpm validate:all
```

The constructed native writer is ordinary view PATCH, with common assertion/census coverage; it is
not a new native race qualification for every writer. Dead legacy claim/set exports, bypass options,
owner release protocol and runtime pool options remain unchanged. No full backup/restore, new-source
APFS, independent provider/KMS, Ready, merge, enablement, deployment or staging acceptance is claimed.

## Ordinary CI cleanup-fixture correction

Run37573708592 at original head `0e8f5c26c552df350c70c81a4f6729efa346350d` is terminal
FAILURE. Both Node lanes actually passed the new115 named admission cases, but each failed the same
nine existing `multitable-attachment-cleanup.test.ts` cases. Each core unit summary is9 failed,
18403 passed and1712 skipped. The core failure skipped the manual-checkpoint and multitable real-DB
steps: no whole archive/native16 execution is claimed from this run. Four other executed jobs
succeeded; coverage was a seventh metadata-only skip. Root independently verified all11 source
blobs, immutable commit/tree and exact checkouts, all6 full continuous206 raw logs and actual
failures. Original source/failure receipts remain retained; no old-run retry.

The cleanup cases supply their own transaction query mocks. Eight handlers answer the fence/state/
attachment/pin queries but throw on the new SHOW isolation and two native-xid proof queries. The
fresh admission guard correctly closes before attachment inspection. Root reproduced the whole
original16 file as7 PASS/9 matching FAIL, then added only16 mock-reply lines: RC and one stable xid
per supplied transaction. All16 original cases, assertions, error/negative branches and ordering
remain byte-identical after removal of those replies. No guard, product, native fixture/test,
workflow, provenance pin or baseline scanner changed.

The exact previous nine whole focused files plus cleanup16 now pass441 assertions in10 files,
zero skips, actual exit0. An initial command selected a wrong writer-closure filename and generic
provisioning29 instead of the required writer-closure20/provisioning-writer-fence21: its actual
429 PASS in9 files is preserved and is not441 evidence. The corrected collection explicitly checks
all10 existing paths and each whole-file count. Production/fresh-admission targeted TypeScript,
`pnpm validate:all` and `git diff --check` exit0. A separate standalone check of the old cleanup
fixture has the same11 diagnostics before and after correction: six existing mock-type diagnostics
and five project request-augmentation diagnostics. It is not a clean TypeScript result; original
and corrected compiler logs/source archives remain retained, with no new diagnostic introduced.

The native16/5 refutations and official stopped-PG evidence above stay source-valid; the runtime and
native inputs are unchanged and the cluster is not restarted for this unit-fixture correction.
A unique ordinary run on the corrected commit is still required. Draft/HOLD and all overall
TM/APFS/owner gates remain OPEN.

Original ordinary CI evidence index SHA256:
`74d659881dba82deb634ab04f68908f1c76fb68586e56c005f1efce4a378984d`.
Root failed-CI readback SHA256:
`53a89f12ade9ff5c2e52e2521b147d0602e03d41d8b7c28e49d8a22fac80c889`.
Correction commands and preserved intermediate failures are under
`artifacts/tm-fresh-writer-admission-20261007/ci-cleanup-mock-fix-20261007/`.
