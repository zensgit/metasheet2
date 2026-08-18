# Recovery07 one-shot readiness kit (K3 exact-two Save-only)

Date: 2026-08-18. Planning only — **creates no authorization**. Values-free: no hosts beyond the `222` label, no tokens, no credentials, no business identifiers.

Six operation IDs burned because each launcher consumed its one-shot authorization *before* the local, deterministic defects that killed it could surface. Recovery07 inverts that order.

## 1. Point-of-no-return (PoNR) map

Recovery06 launcher, in execution order:

- L1–L2 *(check)* `$args` guard; process-arm compare.
- L3 *(local side effect)* arm cleared from process env.
- C1 *(check)* 8 local input files present.
- C2–C4 *(check)* prior launcher / R05 guard / R05 receipt hash pins.
- C5–C7 *(check)* prior R05 receipt facts (result, blocker, reseal, executorStarted, operationResult, routeCallCount); local state root absent; 12 frozen-closure input hashes.
- C8 *(check — **no effect, defect A**)* `Import-Recovery06ReceiptValidator`: AST presence of `Assert-Receipt`, `Test-ClosedMember`.
- C9–C10 *(check)* request fences, `requestDecision`, 5 self-hash pins; 14 owner-scope lines.
- C11–C14 *(read-only network)* `gh` viewer identity; comment fetch; request comment and owner decision each unique+unedited.
- C15 *(read-only remote)* SSH preflight: op stage +12 hashes, op owner, R05 stage +5 hashes, R05 owner, selector/reseal evidence hashes, absence of op root/guard and fresh stage/owner.
- **P1 — PoNR, guard write:** `Write-Recovery06CreateNew $localGuard`; `authorizationConsumed=YES`.
- P2 *(remote stage create)* `New-Item` + `icacls` + execution guard `CreateNew`; `remoteStageCreated=YES`.
- P3 *(remote write)* `scp` 15 files — per-file *local presence* first tested here.
- P4 *(post-PoNR check)* remote rehash of staged files.
- P5 *(remote write)* owner record `CreateNew`; `ownerRecordCreated=YES`.
- **P6 — executor start:** `executorStarted=YES` set *before* the child runs; pre-child rehash; two arms exported; child `powershell.exe`.
- P7–P8 *(check + local write)* receipt-presence probe; `scp` receipt back.
- P9–P10 *(**fails, defect A**)* `Assert-Receipt`; classify; write launcher receipt.

Authorization is consumed at **P1**; everything after is unrecoverable under the no-retry rule.

### Post-PoNR checks that are purely local/deterministic — move before P1

1. **Validator callable, not merely present.** `Import-Recovery06ReceiptValidator` dot-sources inside a function, so `Assert-Receipt`/`Test-ClosedMember` are out of scope by P9. Load at script scope, then call against a frozen fixture.
2. **Presence + hash of all 15 stage sources** — C7 covers 12; the rest first fail at P3.
3. **Receipt-copy destination writability** — probe create+delete locally; the Recovery05 `RECEIPT_COPY_FAILED` class.
4. **Remote `node.exe` present**, `NODE_OPTIONS` and pm2 fixture env empty (`HELPER_*` fires only after the arm today).
5. **Parse of every staged artifact** — `ParseFile` per `.ps1`, `node --check` per `.cjs`.
6. **Transform rehearsal on target** — recompute the text, compare to pins, arm nothing; the transform is pure.
7. **apiBase resolution** via health probe.
8. **Plugin classification dry probe** (read-only GET). Recovery06 died on a false `integrationPluginActive=NO` while the endpoint reported `ACTIVE`.
9. **Credential file present and correctly typed.**
10. **Sealed-selector unseal shape** (`projectNo` only, no `actionId`).
11. **Runtime provenance commit == pinned SHA.**
12. **pm2 baseline readback** (Apply disabled; dedicated flag canonical).
13. **Remote base writability / ACL / free space.**
14. **`ssh`/`scp`/`gh` present + one no-op `scp` round trip** (scp first runs at P3).
15. **Target PowerShell is 5.1** — the dynamic-scope defect class is version-sensitive.

Two further ordering defects: `executorStarted` is set *before* the child starts, so transport failure is indistinguishable from a real start (Recovery05: `executorStarted=YES`, `routeCallCount=0`); and the SSH helper discards stderr, collapsing the failing sub-gate into `RECOVERY06_LAUNCHER_FAILED` — the generic-token collapse the owner rejected after R1/R2/R3. Split into `executorAttempted` and `executorObservedStart`, and keep stderr.

## 2. Recovery07 pre-flight checklist (all pass before P1)

Each item: *what* — how to verify — `REASON_TOKEN` on failure.

1. Default-unarmed — run unarmed, expect non-zero — `LAUNCHER_NOT_ARMED`
2. Fresh identity — ID/arm/stage/guard absent from prior receipts — `IDENTITY_REUSED`
3. Self-hash pins — hashes == request block — `SELF_HASH_MISMATCH`
4. Owner comment exact, unique, unedited, later — `gh` comment scan — `OWNER_DECISION_NOT_EXACT_UNIQUE`
5. Owner scope complete — required lines verbatim — `OWNER_SCOPE_INVALID`
6. Local closure presence+hash, all staged files — manifest compare — `LOCAL_CLOSURE_MISMATCH`
7. Validator loaded at script scope and exercised — call on fixture — `RECEIPT_VALIDATOR_NOT_CALLABLE`
8. Local receipt root writable, receipt absent — probe write+delete — `LOCAL_RECEIPT_PATH_UNWRITABLE`
9. Transports usable — BatchMode login + no-op scp — `TRANSPORT_UNAVAILABLE`
10. Target PowerShell 5.1 — `$PSVersionTable` — `HOST_PS_VERSION_UNEXPECTED`
11. `node.exe` + clean helper env — probe — `HELPER_RUNTIME_UNAVAILABLE`
12. Prior stages/owners/selector/reseal evidence exact — remote hash pins — `PRIOR_EVIDENCE_MISMATCH`
13. New root/guard/stage/owner absent — remote `Test-Path` — `STATE_PRESENT`
14. Remote base writable — probe dir create+delete — `REMOTE_PATH_UNWRITABLE`
15. Staged artifacts parse — `ParseFile`, `node --check` — `STAGED_ARTIFACT_PARSE_FAILED`
16. Transform rehearsal hashes match — recompute on target — `TRANSFORM_HASH_MISMATCH`
17. Runtime provenance == pin — read provenance — `RUNTIME_SHA_MISMATCH`
18. Health 200, apiBase resolved — probe bases — `API_BASE_UNRESOLVED`
19. Plugin active from a real response — read-only GET + classifier — `INTEGRATION_PLUGIN_INACTIVE` / `_UNCLASSIFIABLE`
20. Admin credential present and typed — read-only — `CREDENTIAL_UNAVAILABLE`
21. Selector unseals to expected shape — read-only — `SELECTOR_SHAPE_INVALID`
22. pm2 baseline correct — helper readback — `PM2_BASELINE_MISMATCH`
23. Route budget wired — `maximumRouteCallCount=2` in guard and executor — `ROUTE_BUDGET_UNBOUND`
24. No arm preset in launching process — env scan — `ARM_PRESET_FORBIDDEN`

**`-DryRunStopBeforePointOfNoReturn`.** Runs items 1–24 on the real host, then stops before P1. Contract: `authorizationConsumed=NO`, `remoteStageCreated=NO`, `ownerRecordCreated=NO`, `executorAttempted=NO`, `routeCallCount=0`, no `CreateNew` write outside a disposable probe path, and a values-free `dryRun.values-free.txt` naming the last gate reached. Own arm value, refuses the live arm, rerunnable; its receipt hash is `dryRunReceiptSha256` in §4.

## 3. Negative-control test plan (local, `REMOTE_CALLS=0`)

Each control mutates a copy of the launcher/executor text or injects a hook, then asserts the closed token **and** `authorizationConsumed=NO`.

1. **Validator removed** — delete `Assert-Receipt`; expect `RECEIPT_VALIDATOR_NOT_CALLABLE` before P1, not at P9.
2. **apiBase unresolved** — health hook returns no reachable base; expect `API_BASE_UNRESOLVED`, plugin/login call count `0`.
3. **Plugin fixture matrix** — `[…]`, `{plugins:[…]}`, `{data:{items:[…]}}`, `{data:[…]}` × status `ACTIVE|active|inactive` (plus `active:"true"`). Case-fold first. Active for the six active shapes, `INTEGRATION_PLUGIN_INACTIVE` for inactive, `INTEGRATION_PLUGIN_UNCLASSIFIABLE` for an unknown envelope or duplicate id — never "unknown reads as active".
4. **Arm preset** — arm set before launch; expect `ARM_PRESET_FORBIDDEN`, no stage.
5. **Counter before send** — stub transport to throw; assert `routeCallCount` already incremented (the executor's `+= 1` precedes the POST; pin it).
6. **Retry explicitly zero** — PS 5.1 `Invoke-WebRequest` has no retry parameter, so assert *absence* plus `$PSVersionTable.PSVersion.Major -eq 5`; under PS 7 require literal `-MaximumRetryCount 0`.
7. **Third call refused** — three attempts; third fails `THIRD_POST_FORBIDDEN` from guard `maximumRouteCallCount=2`, `routeCallCount=2`.
8. **Receipt copy fails after remote 201** — stub copy-back to fail with the remote receipt present and complete; expect `REMOTE_COMPLETE_LOCAL_EVIDENCE_PENDING` — retry the copy only, no new operation ID, no new authorization.
9. **Stderr preserved** — the gate name survives into `failedGate`, never collapsing to a generic token.

## 4. Owner block template (values-free)

```text
ownerOperationRecovery07Decision=APPROVE|REJECT
repository=<owner/repo>
issueNumber=<n>
targetHostAlias=STAGING_222
operationId=<fresh-id>
recoveryId=<fresh-id>_recovery07
priorOperationIdsReused=NO
armName=<ENV_NAME>
armValue=<ONE_SHOT_VALUE>
dryRunArmName=<ENV_NAME_DRYRUN>
remoteStageRoot=<path>
remoteOwnerRecordPath=<path>
localGuardPath=<path>
remoteGuardPath=<path>
exactMergedAndDeployedSha=<sha>
launcherSha256=<sha>
launcherTestSha256=<sha>
executorSha256=<sha>
executorTestSha256=<sha>
validatorSha256=<sha>
stageManifestSha256=<sha>
developmentVerificationMdSha256=<sha>
dryRunReceiptSha256=<sha>
notAfter=<UTC ISO-8601>
maximumRouteCallCount=2
expectedFirstCall=201_created
expectedSecondCall=200_skipped_existing
expectedThirdCall=forbidden
k3SaveCallsAuthorized=2
k3SubmitCallsAuthorized=0
k3AuditCallsAuthorized=0
validTokenApplyAuthorized=<YES|NO>
sourceDatabaseDdlDmlAuthorized=NO
automaticExecutorRetryAuthorized=NO
automaticStageOrEvidenceCleanupAuthorized=NO
receiptCopyRetryAuthorized=YES
k3AdminCleanupIdentity=<named-admin-alias>
k3AdminCleanupMethod=K3_NATIVE_CONSOLE_MANUAL
k3AdminCleanupScope=EXACTLY_TWO_MATERIALS_CREATED_BY_THIS_OPERATION
sqlTestRowRemovalAfterK3CleanupOnly=YES
rollbackOrder=K3_MATERIALS_THEN_SQL_ROWS_THEN_FLAGS
rollbackStopConditions=<closed-set list>
incompleteCleanupClassification=FAIL_ROLLBACK_INCOMPLETE
credentialsPublished=NO
sensitiveIdentifiersPublished=NO
independentHumanReviewClaimed=NO
```

## 5. Evidence / receipt template

```text
recoveryId=<id>
result=FUNCTIONAL_COMPLETE|TERMINAL_NON_SUCCESS|BLOCKED|REMOTE_COMPLETE_LOCAL_EVIDENCE_PENDING
failedGate=NONE|<reason token from §2>
authorizationConsumed=YES|NO
dryRunPassedAt=<UTC>|NOT_RUN
remoteStageCreated=YES|NO
ownerRecordCreated=YES|NO
executorAttempted=YES|NO
executorObservedStart=YES|NO
executorExitCode=<int>|NOT_RUN
operationReceiptPresent=YES|NO
operationResult=FUNCTIONAL_COMPLETE|BLOCKED|NOT_RUN
routeCallCount=0|1|2
firstCallClass=EXACT_CREATED|OTHER
replayCallClass=EXACT_NOOP|OTHER
k3SaveCalls=0|2
k3SubmitCalls=0
k3AuditCalls=0
dbWriteCount=0|2
deleteCount=0
recoveryRequired=YES|NO
stageRetained=YES|NO
credentialsPublished=NO
sensitiveIdentifiersPublished=NO
businessValuesPublished=NO
completedAt=<UTC>
```

Closeout reconciliation lines:

```text
applyDisabledRestored=YES
dedicatedPersistSwitchRestored=YES
unrelatedFlagsRestored=YES
k3CallCount=2
dbWriteCount=2
deleteCount=0
k3AdminCleanupCompleted=YES
bothMaterialsVerifiedAbsent=YES
sqlTestRowsRemovedAfterK3Cleanup=YES
remotePrivateSelectorResidueCount=0
remoteTokenResidueCount=0
localWorkDirSelectorOrTokenResidueCount=0
localOutputsDirSelectorOrTokenResidueCount=0
localConsumedGuardResidueInventoried=YES
retainedStagesAndReceiptsPreserved=YES
independentHumanReviewClaimed=NO
```

Residue counts locally too: the working directory already holds consumed guards and per-recovery `*-local` receipt roots from Operations 01–06 and Recovery 01–06. Inventory them and prove they hold no selector value or token; do **not** delete them — they are immutable prior-attempt evidence.

## 6. Structural recommendation

Replace the four-layer transform stack (`Operation02` file → `Operation03` → `Operation04` → `Recovery06`, each dot-sourcing an in-memory scriptblock) with **one self-contained executor file generated from `origin/main` at build time**, plus **a single hash manifest** (`stage.manifest.txt`, one `filename=sha256` line per artifact, cited once in the owner block instead of a dozen hand-maintained pins) and **a separate hash-pinned `Assert-Recovery07Receipt.ps1` loaded at script scope**, exercised against a fixture during pre-flight.

How this removes the observed failure classes:

- **Defect A** (validator vanishes) becomes impossible: the validator is a file loaded at script scope and pre-flight calls it.
- **Defect B** (`$script:apiBase` null at the plugin gate, misreported as `integrationPluginActive=NO`): `Assert-Health` sets `$script:apiBase` from the base it proved, `Get-PluginState` asserts `API_BASE_UNRESOLVED` first, and pre-flight probed both before P1.
- **Recovery05's defect** (`$PSScriptRoot`/`$PSCommandPath` empty in a dynamic scriptblock) cannot occur — a real file has both, so the two most fragile substitutions disappear.
- Anchor drift (`*_ANCHOR_MISMATCH`, `*_SHAPE_MISMATCH`) is gone: generation happens once in the repo under review and CI, not on the operator's machine before a one-shot.
- A closed `failedGate` keeps a failure costing one diagnostic read, not a new operation ID.

Sequencing for Codex: generate the executor from `origin/main`; write the manifest; land launcher, validator and §3 controls as a PR; run `-DryRunStopBeforePointOfNoReturn` on the real host and publish its receipt hash; only then request the §4 owner block.
