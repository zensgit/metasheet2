# Approval Parity Final Verification (2026-08-17)

**Status:** NOT RUN - acceptance design only
**Master design:** `approval-parity-master-design-lock-20260817.md`
**Execution truth:** `approval-parity-execution-ledger-20260817.md`
**Initial planning baseline:** `origin/main@d33a6a0fa120452b721ea76d449dfa1463727463`

This file is intentionally not a completion claim. Fill it only against the exact merged-main and
deployed SHAs being accepted. A green PR, a merged phase, or a local browser pass cannot pre-fill a
later gate.

## 0. Final claim checklist

| Claim | Current status | Evidence required |
|---|---|---|
| P0 form-authoring correctness complete | NOT RUN | exact-main unit/mounted/browser matrix |
| P1 inspector/shipped capability parity complete | NOT RUN | all-source plus timeout/threshold compatibility matrix |
| P2 enterprise assignee semantics complete | NOT RUN | directory/corp/empty-resolution real-DB matrix |
| P3 policies and More settings complete | NOT RUN | server-enforcement mutations, no inert controls |
| P4 handler and field edit enforcement complete | NOT RUN | graph/transaction/authz matrix |
| P5 member experience complete | NOT RUN | role/action/mobile/browser matrix |
| Owner-private release prerequisites closed | NO / PRIVATE | owner-private exact-head evidence; no lane identifier or implementation detail in this public document |
| CORE-PARITY | NO | P0-P5 + exact merged-main verification + browser/a11y + Canvas tenant UAT + owner sign-off |
| DATA-CLOSURE | NO | approved P6 scope + exact merged-main DATA matrix + durable/FWB UAT + attachment UAT + owner sign-off |
| PRODUCT-FINAL | NO | both labels + rollout/rollback + accepted residuals |

## 1. Qualification header

Fill before running any final command:

```text
Review date:
Repository:
Merged-main SHA:
Deployed staging SHA:
Required-check ruleset observed at:
Database version and migration head:
Browser versions:
Feature flags before test:
Reviewer:
Owner UAT operator:
```

Abort qualification if the branch is behind main, the deployed SHA differs, required checks changed
without review, or another session changed an evidence file during the run.

## 2. Static and contract verification

- [ ] `git status --short --branch` is clean in an isolated exact-main worktree.
- [ ] Every new field/node/source/mode/policy appears consistently in frontend types, backend types,
      normalization, API contracts, version diff, restore, preview, and tests.
- [ ] Unknown persisted values round-trip or fail closed; no default flattening.
- [ ] No ordinary-user surface exposes JSON, raw field/node/edge/user/role/base/sheet IDs.
- [ ] Canvas, attachments, and FWB remain independently default OFF.
- [ ] Number FWB remains `exact_number_mapping_unavailable` unless an independent ratified line replaces it.
- [ ] Before each tenant UAT or production enablement, the owner records that capability's private release prerequisites closed out of band.
- [ ] Global source guards, including time formatting and raw control-byte guards, remain unweakened.
- [ ] If plugin-tests workflow changed, its provenance pin was mechanically recomputed.

## 3. Required automated gates

Record exact commands and counts from the target SHA; do not paste stale totals.

| Gate | Command / workflow | Exact result | Evidence link |
|---|---|---|---|
| Web type check | `pnpm --filter @metasheet/web type-check` | NOT RUN | |
| Web build | `pnpm --filter @metasheet/web build` | NOT RUN | |
| Required web tests | `.github/workflows/web-tests.yml` invoking `apps/web/scripts/run-required-web-tests.sh` | NOT RUN | |
| Approval guard canaries | verify both path filters, then copy the exact current Vitest list from `.github/workflows/approval-web-guard.yml`; do not preserve a stale hand-written list here | NOT RUN | |
| Production-command mount canary | required-web test must fail when the production authoring import/call is removed while pure command-helper tests remain green | NOT RUN | |
| Backend type check | repository CI-exact backend command | NOT RUN | |
| Backend unit | repository CI-exact command | NOT RUN | |
| Approval real DB | phase-specific integration allowlist | NOT RUN | |
| Migration replay | old-schema upgrade plus current replay | NOT RUN | |
| Root required checks | current branch-protection set | NOT RUN | |

## 4. P0 form-builder matrix

| ID | Scenario | Positive control | Discriminating negative | Result |
|---|---|---|---|---|
| F1 | Delete middle field, then add | new opaque ID, save succeeds | length-derived allocator duplicates an existing ID | ⬜ |
| F2 | Add at start/middle/end | exact intended order | append-only implementation fails middle/start | ⬜ |
| F3 | Cancel palette drag via dragend/Escape/navigation/read-only | draft/history/transient payload unchanged or cleared | stale palette type causes a later row drop to add a field | ⬜ |
| F4 | Stale insertion anchor | values-free no-op/retry | captured index mutates wrong location | ⬜ |
| F5 | Malformed/foreign drag payload | no mutation | trusting generic `text/plain`, unknown kind, or forged local id reaches command | ⬜ |
| F6 | Click/drag/keyboard equivalence | identical draft/focus/history | one path bypasses adapter | ⬜ |
| F7 | Inspector property edit | one logical history entry | per-keystroke or direct mutation bypass | ⬜ |
| F8 | Referenced delete/retype | named refusal, zero mutation | visibility, condition/formula, permission, graph, FWB, detail, or external reference is removed/silently rewritten | ⬜ |
| F9 | Legacy no-edit round-trip | byte/semantic equivalent | extraction or mount changes fallback | ⬜ |
| F10 | Production command mounting | mounted authoring behavior reaches the shared command adapter | pure helper tests remain green after production integration is removed | ⬜ |
| F11 | Identity authority | allocator never reuses field/detail IDs across delete, undo, restore, or retry | array-length or visible-suffix allocation collides | ⬜ |
| F12 | Reference authority unavailable | destructive command fails closed with values-free result | missing provider is treated as empty references | ⬜ |

The current `approval-form-commands` tests qualify the insert-after/append command substrate only; the
substrate contains no retype command, so F8's retype half exercises the NEW typed command authored in
P0, not an existing export. The current palette-focus and G5-C source scans qualify wiring text only.
None of them, alone, proves exact drag geometry or that the production view executes the command path.
F10 must be collected by the always-on required-web job before P0 can complete.

## 4.1 Authoring shell and non-duplication matrix

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| U1 | Four-step legacy draft | opens and saves unchanged while More settings has no functional policy | ⬜ |
| U2 | Basic-information scope | typed requester/admin selectors emit stable IDs without raw comma entry | ⬜ |
| U3 | Live issue count | count matches publish preflight and focuses the exact failing control/node | ⬜ |
| U4 | More settings visibility | hidden until at least one server-enforced policy is landed | ⬜ |
| U5 | Existing gallery | common presets and Template Center remain the single implementation | ⬜ |
| U6 | Existing canvas tools | undo/redo/minimap/edge insertion remain intact; no duplicate toolbar is introduced | ⬜ |

## 5. P1 inspector and shipped-compatibility matrix

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| I1 | Existing source cards | single-source lock removed; every shipped source displays and round-trips in order | ⬜ |
| I2 | Resolver non-regression | the already-shipped resolver still unions all source results and identity-dedups them | ⬜ |
| I3 | Unknown source/mode | read-only and preserved, never flattened | ⬜ |
| I4 | Timeout compatibility | persisted timeout opens, edits, saves, summarizes, compares, restores, and executes without flattening | ⬜ |
| I5 | Threshold static M | valid N-of-M publishes; N > M rejected before runtime | ⬜ |
| I6 | Threshold dynamic M | impossible N fails closed after resolution without partial instance | ⬜ |
| I7 | Threshold re-entry | stale prior-round votes never satisfy a new epoch | ⬜ |
| I8 | Threshold placement | parallel-region authoring rejected before mutation and by backend | ⬜ |
| I9 | Version lifecycle | timeout/threshold/source cards survive diff and restore-to-new-draft | ⬜ |
| I10 | Capability registry | shipped source union matches exactly; unratified new capability absent | ⬜ |
| I11 | Signature policy boundary | the affected control alone is read-only, other supported fields remain editable, and the value round-trips until its owner slice | ⬜ |
| I12 | Linear unsupported mode | threshold/unknown mode is never flattened to `single` during hydration/save | ⬜ |
| I13 | Complex allowlist | shipped timeout/threshold keys open, edit, save, compare, and restore without flattening; read-only fallback is reserved for unknown future keys | ⬜ |
| I14 | Field-permission honesty | hidden claim is scope-qualified; readonly/editable says not enforced until Lock-7 | ⬜ |

## 6. P2-P5 runtime and policy matrix

Each implemented capability adds rows before final acceptance. The minimum common matrix is mandatory.

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| R1 | Cross-corp directory candidate | absent/mismatched corp denied without existence oracle | ⬜ |
| R2 | Directory change after publish | behavior matches frozen/live decision and is audited | ⬜ |
| R3 | Empty assignee | configured fallback only; unknown state fails closed | ⬜ |
| R4 | Handler success | mutation, revision, action, and audit use ratified transaction boundary | ⬜ |
| R5 | Handler rollback | injected failure leaves no partial field or approval state | ⬜ |
| R6 | Hidden/readonly direct API bypass | server denies independently of UI | ⬜ |
| R7 | Per-node operation disabled | button absent and direct request denied | ⬜ |
| R8 | Return/re-entry/concurrency | node epoch and assignment binding remain authoritative | ⬜ |
| R9 | Action dialog | focus, validation, reason, cancel, and double-submit behavior agree | ⬜ |
| R10 | Mobile/keyboard | every supported action has a non-drag, non-hover path | ⬜ |
| R11 | Existing runtime policy | shipped revoke, required reject comment, timeout, and merge behavior does not regress | ⬜ |
| R12 | Missing capability absence | handler, ordered-within-node, after-sign, and unratified source kinds remain unrendered and rejected | ⬜ |

## 6.1 Detail and center preservation matrix

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| M1 | Parallel timeline | existing grouped timeline remains authoritative and readable | ⬜ |
| M2 | History table/tabs | new projection derives from audit rows and does not duplicate or reorder facts | ⬜ |
| M3 | Existing batch actions | batch approve, batch reject, failure manifest, and retry remain intact | ⬜ |
| M4 | Existing summary | the up-to-three-field summary remains intact | ⬜ |
| M5 | Aging semantics | current create-time aging keeps its label; node-arrival wording requires a server timestamp | ⬜ |
| M6 | Desktop master-detail | selection, URL, keyboard focus, resize, and narrow fallback are stable | ⬜ |

## 7. Browser, visual, and accessibility matrix

Use real Chromium; jsdom alone does not qualify. Capture full-page and focused-state screenshots.

| Viewport | Form builder | Flow canvas | Inspector | Version | Member detail | Result |
|---|---|---|---|---|---|---|
| 1440x900 | palette/canvas/inspector stable | full vertical tree | docked | dual canvas | desktop detail | ⬜ |
| 1024x768 | compact palette, no overlap | branch labels fit | overlay/no scrim | usable | compact detail | ⬜ |
| 390x844 | tap insertion complete | no drag dependency | bottom sheet | readable | mobile actions | ⬜ |

- [ ] Longest business labels wrap or truncate with an accessible full name.
- [ ] Focus returns correctly after add, move, delete, close, undo, and restore.
- [ ] Palette items, insertion slots, nodes, branches, joins, and inspector controls are keyboard reachable.
- [ ] Color is not the sole carrier of type, validation, state, diff, or priority.
- [ ] No nested cards, button text overflow, incoherent overlap, or viewport-driven font scaling.
- [ ] Structured accessible fallback remains available until S12 and owner retirement approval.
- [ ] Node cards have migrated from shipped type ribbons to flat surfaces, text type labels, and restrained accents; no colored-band-only semantics remains.

## 8. Version and migration matrix

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| V1 | Publish v1, v2 | immutable historical versions | ⬜ |
| V2 | Compare | added/removed/changed topology and properties shown from authoritative snapshots | ⬜ |
| V3 | Restore v1 | creates a new draft with provenance; published/running versions unchanged | ⬜ |
| V4 | Stale restore | expected-latest mismatch fails closed | ⬜ |
| V5 | Old schema upgrade | historical rows migrate and open without fresh-DB assumptions | ⬜ |
| V6 | New capability round-trip | old editor fallback does not erase unknown config | ⬜ |
| V7 | Editor entry | timeline/version action is reachable from the authoring header without duplicating version storage | ⬜ |

## 9. Data-closure matrix

Run only after Canvas acceptance, under each capability's independent authorization.

| ID | Scenario | Pass criterion | Result |
|---|---|---|---|
| D1 | Attachment upload/bind | authorized bind in submission transaction | ⬜ |
| D2 | Attachment bind/GC race | both interleavings produce no dangling live reference | ⬜ |
| D3 | FWB create | approved form creates one authorized record | ⬜ |
| D4 | FWB update | linked record rechecked and updated once | ⬜ |
| D5 | Decision values | frozen node-round values written once | ⬜ |
| D6 | Crash after claim/effect | retry occurs; sink net effect remains once | ⬜ |
| D7 | Permission drift | execute-time recheck denies without existence leak | ⬜ |
| D8 | Number mapping | remains unavailable unless independently ratified and delivered | ⬜ |

## 10. Tenant UAT and staged enablement

### Canvas UAT

Repeat S1-S12 from `approval-canvas-data-closure-owner-handoff-20260808.md` on the exact deployed
merged-main SHA. Add P0 exact-slot form scenarios and P1 source/threshold scenarios when delivered.
Do not begin Canvas tenant UAT until the owner records Canvas-relevant private release prerequisites
closed out of band. Private prerequisites belonging only to FWB or attachments do not block Canvas
S1-S12; they gate their own UAT sections.

```text
Environment:
Tenant:
Deployed SHA:
Canvas flag before:
Canvas flag during:
S1-S12 results:
Rollback result:
Operator:
Owner sign-off:
```

### Independent FWB and attachment UAT

Do not infer these from Canvas UAT. Record separate deployed SHA, flag window, evidence, observation,
and rollback for each, in owner-handoff order: durable delivery prerequisite plus FWB first, attachments
second. An FWB run is invalid unless both `AUTOMATION_DURABLE_DELIVERY_ENABLED` and
`APPROVAL_FWB_WRITEBACK_ENABLED` are recorded for the test window.

## 11. Residual-risk register

| Residual | Severity | Accepted by | Reason | Follow-up |
|---|---|---|---|---|
| Vue Flow / ELK deferred | accepted design choice | owner G0 | bespoke renderer retained | reopen only on measured scale failure |
| Exact number/money writeback unavailable | product boundary | — | fail-closed | independent design line |
| Action attachments deferred | capability gap | — | no action-attachment contract | separate lock if prioritized |
| Other | — | — | — | — |

## 12. Final owner record

Do not complete until every claimed row above has exact evidence.

```text
Merged-main SHA:
Deployed SHA:
CORE-PARITY: NO
DATA-CLOSURE: NO
Canvas UAT: NOT RUN
FWB UAT: NOT RUN
Attachment UAT: NOT RUN
Flags enabled:
Rollback verified:
Accepted residuals:
Owner:
Date:
PRODUCT-FINAL: NO
```
