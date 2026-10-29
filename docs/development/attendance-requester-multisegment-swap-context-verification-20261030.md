# Requester multi-segment swap context verification — 2026-10-30

Status: Draft/HOLD. This is a bounded repair for source-only shift-swap request creation under the existing admitted reference posture. Local evidence does not establish full requester, DingTalk, live-provider or target-runtime acceptance.

## Source and contract

The owned branch starts at main a03d804d60d83717feaedce099e5ff14216afc58. It carries the 13 previously reviewed requester-input paths from 3b39ebbf86aded9d9c7476d7916e3313c364cc6f through clean read-only merge-tree 8d87ec855514efa871bc49dae25c61febe7f08c8. Current main workflow/Vitest registrations and requester registrations are retained as a union. This is a new owned checkout, not a PR merge. The input preflight SHA256 is a74271107d9ddaddaab9cabddf3bb6b93cad73502e3ff99861168e2cf7827283.

Existing W4 lock sections 7.2, 8.3 and the section 9 posture table permit exact synthetic shadow reference admission and require an immutable request snapshot for source-only creation. The source boundary already takes the rollout shared lock and freezes the accepted posture/reference bit before fresh adapter execution. The swap adapter dropped that bit before its lazy requester snapshot callback; the fallback context resolver therefore rejected a legitimate admitted multi-segment source.

The runtime repair has three plumbing changes: pass the existing trusted operation into swap execution; forward its exact-true referenceSegments bit into lazy requester snapshot material; forward that exact-true bit into the existing fallback work-context resolver. It adds no posture resolution, SQL, lock, retry, authorization, schema, migration, feature flag or dependency. Frozen/target branches and other callers retain their existing default-false behavior. It does not add multiple-pair or multiple-party swaps.

## Two new native cases

The original requester integration file is preserved byte-for-byte when the appended block is removed: imports, helpers, hooks and original 66 cases remain. The selector REQUESTER_MULTI_CONTEXT_ selects exactly two new cases, with distinct name/missing labels. Original 66 cases were filtered locally; no local whole-68 result is claimed.

Both cases use real authenticated HTTP, persisted users/memberships/permissions, RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false in an isolated UUID organization. The exact org is admitted only after server startup, with a persisted synthetic shadow posture. An administrator creates for a distinct target; genuine target label bytes or exactly Unknown user are saved and returned, while forged/operator labels are ignored.

The fixture uses requester UTC segments 08:00–12:00 and 13:00–17:00, grace 4/7, positive roundingMinutes=1, rule thresholds 30/60 and attribution tail 120. The counterparty has one segment on the next day. Full immutable snapshot version 1, payload fingerprint computed from the literal expected payload using the existing production helper, resolved_v2 attribution, exact 08:00–17:00 absolute / 08:00–19:00 attribution windows, ordered frozen segments, creation actor and subject are asserted. The generated resolvedAt is canonical millisecond ISO bounded by the actual HTTP call.

The cases require exactly one target request and approval, exact pending swap detail, completed operation and pending outbox event. Named full-row source/business tables, including assignments, events, records, calculations/segments, operation batches, target/group revisions and two leave ledgers, are compared before/after creation. After target rename, replay returns the exact first response and leaves the complete captured state unchanged. This covers the explicitly named boundaries, not every financial subsystem. Settings, allowlist and cache are restored; isolated immutable history is retained. External sends remain disabled.

## Actual local evidence

| Phase | Actual result | Scope |
| --- | --- | --- |
| Corrected native candidate | 2 passed, 66 filtered | Two distinct new cases |
| Swap callback referenceSegments=false | 2 matching failed, 66 filtered | One fault kind; both fail at HTTP 201 oracle with existing 422 / ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED |
| Restore | Exact candidate runtime restored; PG stop 0, closed; data retained | No restored-green rerun |
| Targeted quality | Test configured lint 1/1 existing parser-project diagnostic; test AST lint 0/0; explicit backend AST rules on CJS 5571/5571 errors and 36/36 warnings; focused target types 0/0 with transitive 316/316; introduced diagnostics 0 | Baseline/current comparison only; no whole validate-all-zero claim |

The final quality pass changes only the indentation prefix of one newly added runtime line. Native-tested runtime SHA256 97019c5637d65c928a3095a2e07df3ec32cfe4642e3f834e886342875a3440e0 and final runtime SHA256 788f0fa358b6e63a8b7929afcfcac35c6c800d6567135dcf1bcbc62aeda023df have exact standalone CommonJS/ES2022 emitted JS SHA256 d51a6253510dcd4e8e7a6d891b9be2ada0ec90ce72e7a130b2b6fe2280485541 and identical printed AST. This is not an actual Vitest-transform equivalence claim; native cases were not repeated for whitespace. CJS has no native repository ESLint configuration: its explicit backend-rule comparison is supplementary and retains existing diagnostics. All previously completed TS and baseline CJS phases were reused.

Four new selected leaf executions across green/fault phases are not four distinct cases. The current candidate's whole registered file and changed-head CI require their own later evidence.

Failed preparation history is retained in the owned artifacts: v1 long-name selector executed zero cases with 68 filtered; v2 first actual cases returned fixture HTTP 400 because roundingMinutes=0 violated the existing positive-integer contract. Only the two new fixture literals changed to 1. These are not additional production defects or mutation credit. The first quality controller encountered a missing CJS ESLint configuration; its logs remain. Its completed baseline TS checks were reused in the continuation.

## Review and evidence boundary

Source review, selector correction and rounding correction each have independent receipts. Terra independently checked v3 actual assertionResults, log/report hashes, source pins, restoration and stopped processes; it confirmed only the two synthetic shadow scenarios. Main independently checks the final staged delta and source/evidence bindings.

Owned artifact receipts: native-validation-v3-state.json; two-new-requester-multisegment-green-v3.vitest.json; requester-snapshot-reference-bit-fault-v3.vitest.json; native-v3-independent-execution-review.json; focused-quality-v3-state.json; focused-quality-harness-continuation-disposition.json; runtime-whitespace-equivalence.json; main-precommit-source-and-validation-audit.json. Current source and local-evidence SHA bindings are recorded in precommit-source-manifest.json and main-precommit-source-and-validation-audit.json. Publication adds the exact commit manifest and PR readback.

All PRs remain Draft/HOLD. No merge, deployment, R71 change, release/tag, target installation/migration, provider write or live acceptance follows. R77 organization delivery and manual/owner/live residuals remain separate.
