# Approval Authoring and Data Closure Execution Ledger (2026-07-21)

**Status:** INTEGRATION CANDIDATE - approval-data closure is implemented; Canvas V2 phase 1 is implemented; D3+ remains owner-gated
**Program:** Approval Canvas V2 plus approval-data closure (FWB and attachments)
**Integration base:** `origin/main@e91d20e5cb94024171b7e333df8a36ec944d1ee1`
**Integration branch:** `codex/approval-program-integration-20260721`
**Authority:** `ApprovalGraph` and backend `normalizeApprovalGraph` remain the only flow semantics
**Merge/enablement:** no entry in this ledger authorizes merge, UAT, or a runtime flag change

This ledger records evidence on the composed integration branch. A passing row proves only the named
scope on that branch. Merge, deployment, real tenant UAT, and production enablement remain separate.

## 1. Program split and dependency order

1. **Approval-data closure:** FWB and attachment production paths are composed and verified behind
   default-OFF flags. This line is ready for review and owner-controlled UAT.
2. **Canvas V2 phase 1:** ordinary-user hygiene, immutable graph/form commands, move/reorder/undo, stable
   form identities, and backend publish guards are composed and verified.
3. **Canvas V2 phase 2:** D3 renderer, D4 inspector, D5 semantic drag, D6-f2 mounted form builder, and
   D7-D11 accessibility/preview/version/visual work have not started. D0 remains `PROPOSED`; G0 owner
   ratification is required before those runtime/UI slices start.
4. The final production order remains: merge reviewed code with flags OFF -> run owner UAT -> enable
   durable delivery -> Class A -> Class B -> FWB -> attachments, with observation between steps.

## 2. Model and ownership ledger

| Role | Work used in this program | Acceptance boundary |
|---|---|---|
| Codex | dependency audit, hot-file integration, FWB/attachment fixes, exact-head tests, CI wiring, final review | final engineering recommendation; no self-ratification of owner gates |
| Grok Build | bounded D2-b command-algebra implementation in an isolated worktree | Codex inspected the diff and reran the combined web suite |
| Kimi K3 | exact-head read-only adversarial review of the 80-file composed diff | findings are inputs only; Codex verifies each finding against code/tests |
| Codex subagents | disjoint command-layer and documentation reviews | no shared hot-file writes; every verdict is SHA-scoped |
| Claude Goal (external history) | source slices for FWB, attachments, and the eight-scenario matrix | replayed as source material; stale claims were re-tested rather than trusted |

Hot files have one integration owner: `TemplateAuthoringView.vue`, `ApprovalProductService.ts`,
`ApprovalGraphExecutor.ts`, `automation-service.ts`, `index.ts`, and CI manifests.

## 3. Canvas V2 execution ledger

| Item | Composed state | Exact evidence | Remaining gate |
|---|---|---|---|
| D0 interaction lock | `PROPOSED` | `approval-canvas-v2-interaction-design-lock-20260721.md`; contradictions and responsive/accessibility staging reconciled | owner G0 ratify |
| D1 ordinary-user hygiene | implemented | JSON/raw IDs removed from ordinary editing; formula dry-run uses typed sample values; mounted authoring regressions included | merge review |
| D2-a/D2-b graph commands | implemented | immutable add/remove/move/reorder/undo/redo; topology preservation and invalid-slot refusal | D3 consumes this only after G0 |
| D6-f1 form commands | implemented | stable allocated field IDs, retired-ID refusal, immutable add/update/remove/reorder/undo/redo | D6-f2 mounted UI after G0 |
| D2-c backend guards | implemented | publish path isolation and canonical guard/purge identities retained on the composed head | merge review |
| Combined web evidence | passed | 11 focused files / 260 tests; command canaries 36/36 in the required script; web `vue-tsc` clean before final doc refresh | required CI on PR |
| D3-D11-C | not implemented | no renderer/drag/inspector/version-visual claim is made | owner G0 ratify, then staged implementation |

The current authoring screen therefore has a safer command substrate, but it is **not yet** the final
Feishu/DingTalk-style tree canvas described by D0.

## 4. Approval-data closure execution ledger

### 4.1 FWB production path

- `write_approval_form_values` is registered only for `approval.completed` rules.
- Save validates approved-only outcome, active template version, source fields, target field types,
  select vocabulary, confirmation hash, and creator authority.
- Execute requires FWB plus durable delivery, a rule lineage/structural action identity, and a real
  transaction. It re-checks the approved instance/template version and permission gates.
- Claim + record + revision + chained outbox commit in one transaction; duplicate delivery is net-once.
- Date mapping now validates the actual calendar, so values such as `2026-02-31` fail closed instead of
  being persisted as invented business data.

### 4.2 Attachment production path

- Default-OFF upload/download/refs routes, authenticated principal-derived org scope, attachment-field
  validation, MIME plus magic-byte checking, and no-existence-oracle download behavior are composed.
- Submit-time bind occurs in the approval transaction. GC uses a durable pending/in-progress/done/
  dead-letter state machine with claim-time poison handling and fenced writes.
- Scanner absence fails startup closed when scanning is enabled. Production storage requires S3;
  local storage is development-only. Reconciliation is prefix-scoped, cursor-bounded, and continuation-
  based rather than full-bucket/full-table loading.
- `/refs` enforces the effective request-size limit before the global parser; the client chunks at 200
  and fails closed on partial/malformed responses. Hidden-field refs are omitted at metadata and byte paths.

### 4.3 Integration findings closed

1. Missing scanner no longer yields a clean state.
2. Storage availability is checked before accepting upload work.
3. The route request limit is effective despite the global parser.
4. Client/server reference batching is contract-aligned.
5. Reconciliation is bounded and rolling-deploy compatible.
6. Attachment unit/real-DB tests and Canvas command canaries are in required run lists.
7. Approval detail feature lookup defaults OFF when an older injection omits the new feature ref.
8. FWB date values receive strict calendar validation.
9. The eight-scenario matrix was updated for active template-version binding and values-free failures.

## 5. Exact-head verification ledger

| Gate | Result | What it proves |
|---|---:|---|
| Focused frontend composition | 260/260 | authoring commands, mounted authoring, attachments, ApprovalNewView |
| Required Canvas command canaries | 36/36 | both new command specs are collected by required `web-tests` |
| Required web main suite | 4237/4237 | post-fix full curated suite; 353/353 files |
| Approval detail compatibility | 95/95 | old detail fixtures default attachments OFF; refs/download positives still pass |
| Backend composed unit scope | 275/275 | attachment runtime/routes/storage/GC plus approval graph/product and migration guards |
| FWB mapping unit | 5/5 | includes calendar-invalid rejection; regex-only mutation makes the new case RED |
| Fresh-DB FWB + attachment boundaries | 37/37 | FWB 8; attachment GC/bind/upgrade 19; booted production pipeline 10 |
| Fresh-DB formal matrix | 9/9 | S1-S8, including production FWB chain and durable second hop |
| Post-matrix FWB rerun | 8/8 | no cross-suite pollution on the same migrated database |
| Backend `tsc --noEmit` | pass | composed backend type surface |
| Web `vue-tsc --noEmit` | pass | composed frontend type surface |

The required web suite initially failed 13 legacy ApprovalDetail tests because the attachment feature ref
was assumed present. The fail-closed compatibility fix made the targeted 95-test regression green; the
post-fix required script then passed its 36 Canvas canaries and all 4237 tests in the main curated run.

## 6. Verification doctrine retained

- Construct the failure, not just the happy path.
- A mutation must fail because the intended guard was removed, not because the mutant does not compile.
- Real-DB tests must prove collection in the required run-list; self-skip green is not evidence.
- Concurrency claims require two real actors and both orderings.
- Flag-off compatibility and flag-on fail-closed behavior require separate positive controls.
- Rebase invalidates verdict scope until named tests rerun on the new head.
- Kimi/Grok/subagent summaries are inputs; Codex reruns and inspects before acceptance.

## 7. Owner gates and residual development

1. Review and merge the integration candidate with all flags still OFF.
2. Ratify D0 (or return specific changes). Only then start Canvas D3/D6-f2 and the later visual slices.
3. Run real approval-data UAT, including rejected/withdrawn/non-approved no-write, revoked permission,
   duplicate delivery, attachment hidden-field/read-deny, and S3/scanner failure cases.
4. Enable flags in the staged order; each transition is a separate operational decision.
5. Canvas visual/accessibility closeout requires Playwright at 1440x900, 1024x768, and 390x844 after
   D3-D11-C exist. It is not waived by the phase-1 command-layer evidence.
