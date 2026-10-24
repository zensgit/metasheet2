# ECO ingress CI guard repair — fixed-source dispositions and focused validation

Date: 2026-10-24 (Asia/Taipei). Base `b7581fcf393bbafde767297d780e24bcce4905b5`. Private branch `codex/plm-w23-eco-ingress-ci-20261024`.

## Problem and production delta

The retained PR 6518 job 120705700034 / run 40039106140 recorded 9 failures and 178 passes (187 total). Root independently reproduced the exact nine failed guard nodes before this repair. The bounded source audit found a missing ECO writer disposition and a conservative census-name collision; it did not demonstrate a rich-longText, retype or arbitrary local-write business bypass.

Rename only the new private ECO method `append` and its `this.append` call to `appendEcoSnapshot`. All remaining production bytes, including SQL, fence/permission/provider/history logic, are unchanged: reversing the two identifier substitutions exactly reproduces base source SHA-256 `1293269d83ef7b89478208fa1b96f362f05df648d9394d137a4c0beb957301d1`. The final service SHA-256 is `b76af548aa185d9bd83147023da06dd5f8a7b20d94a603bf7a34ad09ee6163c7`. This is not a business rewrite or a receiver-resolution exception.

The census analyzer is unchanged. Its unknown-receiver fallback remains intentionally fail-closed. The former bare name connected two managed-navigation and three storage URLSearchParams calls to the ECO fence entry. The unique private name removes that ambiguity without ledgering URL builders or suppressing unknown receivers.

## Derived holder dispositions

A fresh actual source census after the rename found six distinct ECO keys and eight physical call sites. The exact keys, counts and callee unions are recorded in `verification.json`; these were derived before editing the ledger. All keys below have the prefix `multitable/plm-collaboration-snapshot-service.ts :: `.

| Holder and entry | Sites | Verdict | Callee writes |
| --- | ---: | --- | --- |
| `EcoCollaborationSnapshotService.confirm :: appendEcoSnapshot` | 1 | EXEMPT | `EcoCollaborationSnapshotService.appendEcoSnapshot>EcoCollaborationSnapshotService.publishRow` |
| `EcoCollaborationSnapshotService.confirm :: assertExplicitTarget` | 1 | NONWRITER |  |
| `EcoCollaborationSnapshotService.confirm :: provision` | 1 | EXEMPT | `EcoCollaborationSnapshotService.provision>EcoCollaborationSnapshotService.publishRow` |
| `EcoCollaborationSnapshotService.disable :: fenceWriterEntry` | 1 | NONWRITER |  |
| `EcoCollaborationSnapshotService.refresh :: loadRefresh` | 3 | EXEMPT | `EcoCollaborationSnapshotService.writeSource` |
| `EcoCollaborationSnapshotService.retainProviderFailure :: fenceWriterEntry` | 1 | NONWRITER |  |

The EXEMPT confirm entries publish through `publishRow`; refresh has three call contexts, only one of which writes through `writeSource`. `assertExplicitTarget` rechecks identity/management in its pre-provider transaction. Disable and provider-failure retention change binding metadata only. Every new callee union is explicitly ledgered. The actual C2 list now contains the three historical entries plus confirm append/provision, exactly five; the URL functions produce no holder keys.

The SAFE rich-longText row and named W13 raw-writer OUT OF SCOPE-of-the-three-native-surfaces row are conditional fixed-source dispositions: the strict DTO has exactly eleven string/null ECO keys; provisioning creates eleven readOnly string fields plus three named local fields. Binding maps are immutable, and DB guards lock mapped fields, enforce their types/readonly markers and reject retype/deletion. Source sync accepts only exact source keys, row identity and matching postimage, prohibiting extra/local-cell edits. Publication uses the current canonical fenced query, fresh authority/record-lock checks, nonnull minted operation, canonical revision/history, successful seal and transaction commit before success. Arbitrary local `review_note:longText` stays on canonical CRUD; it is never part of the source patch.

## Focused execution and falsifiability

The prior actual Grok 4.7 (xhigh) Readiness-wire attempt had repeated provider HTTP 500 failures for over six minutes and no source edits. Root interrupted it and separately verified idle/done and preserved pins; this implementation is the Codex fallback identified by `CODEX_SOL61_HIGH_FALLBACK_GROK_PROVIDER500`, not a Grok RELEASED claim. Readiness work was not implemented here.

The first bounded run passed 38 selected tests (nine original failures, 24 new controls and five affected checks). Review then added four explicit conditions for binding immutability, mapped source type/readonly, receipt row/postimage identity and minted ledger history. The final run passed **42 tests**, with **62 not selected**, across three guard files. XML comparison confirms all nine original failed node names passed. The final set comprises nine original failures, 28 new controls, and five affected existing checks. The retained original 178 CI passes are not a new qualification claim.

The new controls verify unknown receivers of `appendEcoSnapshot` still become unclassified holders; all five actual URL append sites remain nonwriters; an inserted callee write inside the exempt ECO entry still reds `entryWritesVia`; strict DTOs reject rich objects, arrays, unknown fields and local review_note injection; and source-only projection/type/fence/operation/history/schema/receipt conditions stay load-bearing under in-memory removal mutations. Existing synthetic new-holder, same-name declarations/object ports and entry/seam callee probes pass without changing their falsifiability assertions or weakening historical must-wire verdicts.

Final command, cwd `/Users/chouhua/.codex/worktrees/plm-w23-meta-readonly-20261023/metasheet2/packages/core-backend`:

```text
node node_modules/vitest/vitest.mjs run --config /tmp/plm-meta-eco-ingress-ci-sol-run-20261024/vitest.config.mts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts tests/unit/multitable-richtext-longtext-write-sink.guard.test.ts tests/unit/multitable-w13-write-path-layer3-gate.guard.test.ts -t every holder is classified|writes made inside the BODY|a NEW fence holder is derived|C1-F1: a NEW function named|C1-F1: an object-literal port|W1a \(REAL tree\)|W1c \(REAL tree\)|every meta_records.data writer file|chokepoint: the set of files writing meta_records directly|ECO ingress|no stale or miscounted ledger entry|every ledger entry carries an ADR row|every 非数据写入者 holder|writes reached through callees|no allowlisted file went stale --reporter=default --reporter=junit --outputFile=/tmp/plm-meta-eco-ingress-ci-sol-run-20261024/final-focused.xml --maxWorkers=1 --minWorkers=1
```

Exit 0. Node v24.14.1, Vitest 1.6.1. Owned isolated config and cache are under `/tmp/plm-meta-eco-ingress-ci-sol-run-20261024`; no setup files or DB services were used. The final log is `/tmp/plm-meta-eco-ingress-ci-sol-run-20261024/final-focused.log` (SHA-256 `f8156154d0986e50a220e79739ce4d5795e61a6823adb91e4fe51c62b0824369`), and XML is `/tmp/plm-meta-eco-ingress-ci-sol-run-20261024/final-focused.xml` (SHA-256 `d1bb12c332bf23e9ec14d6cadd46d79ca37298d19c83c96d3f462ba23c077038`). The 4,563,402,752-byte free-disk floor was checked before each run; final-run preflight free space was 13772513280 bytes. `git diff --check` exited 0.

All 35 read-only starting pins remain unchanged, including the census analyzer, ECO wire, migration, record-write/fence/ledger/runtime/routes and old evidence. Only four authorized existing files plus this new design and new artifact are changed. Machine-readable source pins, exact commands, node names, counts and receipt hashes are in `artifacts/plm-w23-eco-ingress-ci-20261024/verification.json`; the external `/tmp/plm-meta-eco-ingress-ci-sol-20261024.json` additionally contains every starting/final pin.

## Limits and handoff

These are focused local source guards, strict-DTO runtime checks and synthetic source mutations, conditional on installed DB guards. The structural predicates are syntactic, not exhaustive type-aware or DB-runtime proof. No PostgreSQL/Docker, build/tsc, network, browser, CI, commit, push, merge, deployment, notification or issue-close operation ran here. Backend build and service-unit reruns were unnecessary for the exactly reversible private-identifier change; root owns independent review and one actual PostgreSQL concurrent-confirm check on the changed body. The historical root PostgreSQL proof on source SHA-256 1293269d83ef7b89478208fa1b96f362f05df648d9394d137a4c0beb957301d1 remains distinct from qualification of the new name-only body. Draft/publishing and the next Readiness work remain with root.

Artifact tracking note: The new verification artifact exists and is pinned, but the existing Git info/exclude artifacts/ rule ignores it. Root must explicitly include it when making the authorized source commit; this fallback did not stage it.

## Additive raw-write guard gap — focused revision (2026-10-24)

Owner nonce `cff5522c9b674856824eced1c5529588`. Peer review found that the first SAFE predicates could miss an additional raw `UPDATE meta_records SET data` using a variable named `payload`, because filename/callee membership, required positive anchors and lines mentioning `cells` remain unchanged. This is a guard-vacuity counterexample, not a demonstrated current-production bypass. The production service remains SHA-256 `b76af548aa185d9bd83147023da06dd5f8a7b20d94a603bf7a34ad09ee6163c7` throughout this revision.

Two new in-memory mutations reproduce the gap: an UPDATE after clearing the source-sync GUC inside `writeGuardedRow`, and another UPDATE in a separate method elsewhere in the service. Before the fix both regression assertions failed because `ecoBoundaryFailures` returned an empty list (exit 1, two failed / 30 not selected). No production source or database was mutated.

The minimal repair adds a finite TypeScript AST census across the entire service. Every recognized literal record-table write must match exactly the current INSERT or UPDATE: owner `writeGuardedRow`, direct `query` call, full normalized SQL, and the reviewed parameter arrays containing `JSON.stringify(cells)`. The earlier exact sourceCells projection and cell-use checks still bind that variable to only the fixed source map. An extra statement using any payload name, a relocated write, changed parameters, or a new literal record-table builder write port requires review. The census uses the existing record-write matcher and TypeScript AST; it adds no SQL parser or production engine.

Focused RED command (cwd `/Users/chouhua/.codex/worktrees/plm-w23-meta-readonly-20261023/metasheet2/packages/core-backend`):

```text
node node_modules/vitest/vitest.mjs run --config /tmp/plm-meta-eco-ingress-additive-sol-20261024/vitest.config.mts tests/unit/multitable-richtext-longtext-write-sink.guard.test.ts -t ECO additive writer: alternate payload --reporter=default --reporter=junit --outputFile=/tmp/plm-meta-eco-ingress-additive-sol-20261024/red.xml --maxWorkers=1 --minWorkers=1
```

Focused final GREEN command:

```text
node node_modules/vitest/vitest.mjs run --config /tmp/plm-meta-eco-ingress-additive-sol-20261024/vitest.config.mts tests/unit/multitable-richtext-longtext-write-sink.guard.test.ts -t ECO additive writer|ECO ingress: fixed-source exemption keeps --reporter=default --reporter=junit --outputFile=/tmp/plm-meta-eco-ingress-additive-sol-20261024/final-green.xml --maxWorkers=1 --minWorkers=1
```

Final exit 0: **9 passed, 29 not selected**. Eight new controls cover additive alternate-payload UPDATEs both inside/outside the reviewed method, changed payloads at both existing write sites, three literal builder write ports, and a SQL-in-comment positive control. The ninth is the affected existing fixed-source SAFE condition. A first green run also passed nine before a type-narrowing clarification; the final receipts bind the exact final guard source. The prior 42-pass cohort and PostgreSQL checks were not rerun in this revision.

RED log: `/tmp/plm-meta-eco-ingress-additive-sol-20261024/red.log` (SHA-256 `13878a3ad995b5dc1e243aa785c4cd6642e87d1fa0276cfb35164fb9ea809448`). Final GREEN log: `/tmp/plm-meta-eco-ingress-additive-sol-20261024/final-green.log` (SHA-256 `2ccfc226262c239783547401b8adbef02e6d6e2a562d9b156e26dc5f14f1d1cf`); XML SHA-256 `2f59ff99b38eac3652547bce3f09818553a0f99c2fbfc7cf2e4970ad5ba392b9`. Guard SHA-256: `cf2055e7d2aac8cb41aa6d7e83cac558fc8611f02a5647a69b1dfea6d7186721` → `74219aec1db1b85f6c3cc336146e380ca4417acf6cd7bd956af719b13da27135`. `git diff --check` exited 0. The free-disk floor was 4,563,402,752 bytes.

Root reports independently passing the first 42 selected guards and one actual PostgreSQL concurrent-confirm case on unchanged service body b76af548 (A held the source advisory, B visibly waited, A committed version 2, B returned 409 without deadlock). Those are root-owned receipts, not tests executed by this fallback. This guard-only revision changes just the rich-text guard, this design and the verification artifact. All 38 other prior-release pins remain unchanged.

The AST census is deliberately finite and syntactic: dynamically constructed SQL/table names, runtime aliases and arbitrary builder indirection remain outside it, as with the existing inventory's disclosed limits. Literal ports are reviewed even before proving their runtime execution. No PG/resource, build, network, CI, commit or push operation ran here. External revision report: `/tmp/plm-meta-eco-ingress-additive-sol-20261024.json`.

## Root qualification current (2026-10-24 UTC)

Codex independently verified the matching RELEASED writer owners and all 39 admission pins. The production rename is byte-for-byte reversible to the parent; the analyzer, runtime authorization, wire, SQL/migration and ledger sources remain unchanged. Independent review found the additive-write structural-guard gap and closed it within the explicitly finite literal SQL/builder scope. Dynamic SQL and runtime alias indirection are not claimed covered.

Root reproduced the nine original CI guard failures before repair, then passed the 42 selected original/new/affected nodes using the ordinary backend Vitest config. After the guard-only revision, root independently reproduced both additive counterexamples in an owned test copy with only the new exact-site predicate omitted (2 expected failures, zero errors), then passed the 9 final new/affected nodes (one overlaps the first 42). The unchanged passing CI cohort was not rerun. Final guard SHA-256 is `74219aec1db1b85f6c3cc336146e380ca4417acf6cd7bd956af719b13da27135`.

On unchanged production body `b76af548aa185d9bd83147023da06dd5f8a7b20d94a603bf7a34ad09ee6163c7`, root executed one real PostgreSQL 16.15 concurrent-confirm control with canonical bootstrap and an injected provider. PostgreSQL observed B waiting on A's actual source advisory lock; A committed binding version 2, B rolled back with VERSION_CONFLICT/409, and the test asserted the retained row/history/receipt invariants. This is not a 409-only assertion. Log SHA-256: `de38f57f4c484876ea24620fdd763f567feb58d968a7da5b027b0797fba897b2`.

The owned test database was explicitly dropped, the fresh database/role catalog restored, and the owned server stopped with pg_ctl status 3, PID absent, no open files, root/runtime copy/lock removed. Original runtime pins are unchanged. This PostgreSQL proof does not qualify Docker, MinIO recovery, installed images, real Native transport or business acceptance. Root owned temporary test/config/cache files were removed.

Immutable packet manifests (under the controlling listener evidence directory):

- `meta-eco-ingress-first-root42-and-pg-concurrent-green-20261024`: `5c26741c85917e04a434d496c31afd025968cdccc347bf772db768bfcf76caf5`.
- `meta-eco-ingress-additive-root-red2-green9-20261024`: `956405290be65e35622618bc12f9351cbf28ab7c8118d8de4a0d6c85ecf1b9ea`.
- `meta-eco-ingress-owned-pg-cleanup-20261024`: `69faca7180ccf8964ca46e27c10c37f11090cd4dedd8aa531577dc8b3a182d7f`.

The exact parent 6518 head b7581fc had 44 successful and two failed checks at the pre-publication snapshot. Its separate missing private-checkout token failure remains retained. The repaired child head still requires its own CI; Draft is preserved. Readiness wire/persistence/transport/UI and the whole engineering acceptance remain unfinished. SOURCE and one separate closeout commit are recorded after this source document is frozen.
