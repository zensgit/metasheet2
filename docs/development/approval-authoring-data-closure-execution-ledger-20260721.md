# Approval Authoring and Data Closure Execution Ledger (2026-07-21)

**Status:** INTEGRATION CANDIDATE - FWB-1 and attachment runtime are review-ready; Canvas V2 phase 1 is partial; named product work remains
**Program:** Approval Canvas V2 plus approval-data closure (FWB and attachments)
**Review baseline:** `3ade0d685bbad1605cf71803b228f9aac27d0842`
**Verified product-code head:** `eb107032d`
**Integration branch:** `codex/approval-program-integration-20260721`
**Authority:** `ApprovalGraph` and backend `normalizeApprovalGraph` remain the only flow semantics
**Merge/enablement:** no entry in this ledger authorizes merge, UAT, or a runtime flag change

This ledger records evidence on the composed integration branch. A passing row proves only the named
scope on that branch. Merge, deployment, real tenant UAT, and production enablement remain separate.

## 1. Program split and dependency order

1. **Approval-data slice:** FWB-1 new-record writeback and attachment production paths are composed and
   verified behind default-OFF flags. FWB-2 existing-record links and FWB-3 approver-confirmed values
   have pure modules/tests but are not registered, saved, dispatched, or reachable in production.
2. **Canvas V2 phase 1:** ordinary-user hygiene, immutable graph topology commands, move/reorder/undo,
   stable form identity allocation/sequencing, and backend publish guards are composed and verified.
   Mounted form update/remove/reorder history is not delivered.
3. **Canvas V2 phase 2:** D3 renderer, D4 inspector, D5 semantic drag, D6-f2 mounted form builder, and
   D7-D11 accessibility/preview/version/visual work have not started. D0 remains `PROPOSED`; G0 owner
   ratification is required before those runtime/UI slices start.
4. The final production order remains: merge reviewed code with flags OFF -> run owner UAT -> enable
   durable delivery -> Class A -> Class B -> FWB -> attachments, with observation between steps.

## 2. Model and ownership ledger

| Role | Work used in this program | Acceptance boundary |
|---|---|---|
| Codex | dependency audit, hot-file integration, FWB/attachment fixes, exact-head tests, CI wiring, final review | final engineering recommendation; no self-ratification of owner gates |
| Grok Build | bounded command work, record-link Layer 2 implementation, dependency/layout spikes, and exact-head adversarial review | Codex owns every accepted fix and reruns the named tests; Grok is an implementation worker/second opinion, not merge authority |
| Kimi K3 | long-context FWB number/date/select mapping implementation and later document/visual consistency review | Codex reviews the diff and reruns unit/fresh-DB tests; Kimi never supplies the final correctness verdict |
| Codex subagents | disjoint command-layer and documentation reviews | no shared hot-file writes; every verdict is SHA-scoped |
| Claude Goal (external history) | source slices for FWB, attachments, and the eight-scenario matrix | replayed as source material; stale claims were re-tested rather than trusted |

Hot files have one integration owner: `TemplateAuthoringView.vue`, `ApprovalProductService.ts`,
`ApprovalGraphExecutor.ts`, `automation-service.ts`, `index.ts`, and CI manifests.

### 2.1 Current parallel wave and serialization points

| Lane | Worker | Write scope | Current exit gate |
|---|---|---|---|
| R1 record-link Layer 2 | Grok Build | pinned base/sheet authoring, dedicated ordinary-user picker, publish/submit authz, focused backend/web tests | Codex security review: base + sheet + row + field visibility, exact pagination, fresh-DB and mounted UI |
| R2 FWB mapping parity | Kimi K3 | decimal/date/select mapping and execute-time target-field recheck only | Codex diff review, precision counterexamples, fresh-DB production-chain test, backend typecheck |
| C0 Canvas compatibility gate | Codex + high-reasoning read-only subagent | design/plan documents only | O3-p owner authorization, then D3-p implementation after `approval.ts` is released by R1 |

R1 and R2 may run concurrently because their product write sets are disjoint. D3-p intentionally waits
for R1 to release `apps/web/src/types/approval.ts`; D3/D4 wait separately for owner O3 (layout engine) and
G0. FWB-2/3 and attachment authoring serialize on `ApprovalProductService.ts`, the executor seams, and the
mounted authoring/fill views. Local Claude Code is currently unauthenticated, so Sonnet/Fable/Opus are not
placed on the critical path; when authentication returns, Sonnet handles mid-tier Vue slices, Fable handles
ledger prose, and Opus supplies a separate lock/authz/concurrency gate rather than self-reviewing its own
implementation.

## 3. Canvas V2 execution ledger

| Item | Composed state | Exact evidence | Remaining gate |
|---|---|---|---|
| D0 interaction lock | `PROPOSED` | `approval-canvas-v2-interaction-design-lock-20260721.md`; contradictions and responsive/accessibility staging reconciled | owner G0 ratify |
| D1 ordinary-user hygiene | implemented | JSON/raw IDs removed from ordinary editing; formula dry-run uses typed sample values; mounted authoring regressions included | merge review |
| D2-a/D2-b graph commands | implemented foundation | immutable add/remove/move/reorder/undo/redo; empty-branch, complex/shared branch-removal, topology and invalid-slot refusal | D3 consumes this only after G0 |
| D6-f1 form identity/sequencing | partial foundation | stable allocated field IDs, retired-ID refusal, immutable insertion/reordering sequence | update/remove/inverse history and D6-f2 mounted UI after G0 |
| D2-c backend guards | implemented | publish rejects a direct parallel fork-to-join branch; canonical guard/purge identities retained | merge review |
| Exact-head Canvas evidence | passed | 4 frontend files / 118 tests; backend approval product 111/111; web `vue-tsc` clean | required CI on PR |
| D3-D11-C | not implemented | no renderer/drag/inspector/version-visual claim is made | owner G0 ratify, then staged implementation |

The current authoring screen therefore has a safer command substrate, but it is **not yet** the final
Feishu/DingTalk-style tree canvas described by D0.

## 4. Approval-data closure execution ledger

### 4.1 FWB production path

- `write_approval_form_values` is registered only for `approval.completed` rules.
- Save validates approved-only outcome, active template version, source fields, target field types,
  select vocabulary, target-base-bound confirmation hash, the actual modifier/enabler, original creator
  authority, and canonical per-subject target-field writability.
- Execute requires FWB plus durable delivery, a rule lineage/structural action identity, and a real
  transaction. It re-checks the approved instance/template version, target field types/precision, and
  permission gates.
- Claim + record + revision + chained outbox commit in one transaction; duplicate delivery is net-once.
- Retryable infrastructure failure remains reclaimable in durable delivery rather than being marked
  done, while every deterministic `fwb_rejected:*` refusal settles instead of consuming retries until
  poison. Chained event identity includes the source event, rule, and structural action identity so two
  rules cannot collapse each other's event. Date and number mapping fail closed on invalid calendars,
  unsafe integers, excess decimal scale, and non-lossless precision. The execute-time decimal cap comes
  from the canonical number-field `property.decimals` contract.

**Boundary:** only FWB-1 creates a new record on the rule's sheet. FWB-2 (select/update an existing
record) and FWB-3 (freeze an approver-confirmed value by node round) are not production-wired. There is
also no ordinary-user FWB mapping/confirmation UI yet; the reviewed capability is API/runtime-level and
cannot be called end-user self-service.

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
10. ApprovalNewView and attachment feature-flag edits now trigger both approval guard modes.
11. The six data-closure real-DB files have a 12-case structural guard pinning both CI wiring points.
12. Empty parallel branches are refused at delete/move/branch-removal and again by backend normalization;
    unsupported or validation errors no longer expose raw graph IDs.
13. FWB save/update binds the actual actor, target base and canonical target-field permissions; durable
    failures retry and cross-rule chained events remain distinct.
14. Attachment evidence now constructs a booted-route double submit, a blocking GC-wins bind race, and
    a real local-store blob drain rather than proving only helper-level or sequential behavior.
15. Exact-head adversarial review found the executor reading a non-canonical number-field `precision`
    property; production fields use `decimals`. The canonical property is now bound and a real-DB
    `decimals=2` / `12.345` case rejects with zero writes.
16. Removing the update call-site fallback exposed a second actor bug: the validation helper's default
    parameter still substituted the creator. Creation now passes the creator explicitly, while update
    accepts no implicit actor; the original fallback mutation turns the real-DB test RED.
17. Canvas preview now calls the same empty-parallel-branch predicate as the command layer, and backend
    parallel-topology rejection messages are values-free. The preview mutation and raw-ID negative are
    both discriminating.
18. Execute-time target-field revocation is now proven through the real production gate and database,
    not only a permissive executor seam: a post-save `read_only` grant produces zero claim/record rows.
19. Deterministic missing-instance FWB refusal now settles its event-fire row; reducing the terminal
    namespace makes the production-chain golden retry and turn RED.

## 5. Exact-head verification ledger

| Gate | Result | What it proves |
|---|---:|---|
| Focused Canvas composition | 118/118 | add/remove/move/reorder plus preview, mounted hygiene and raw-ID negatives |
| Required web preflight | 37/37 + 4/4 | Canvas/form command canaries and attachment flag canary collected before the main suite |
| Required web curated suite | 4242/4242 | exact product head, 353/353 files |
| Backend graph authority | 111/111 | includes save/publish rejection of direct fork-to-join branches |
| FWB focused units | 48/48 | gates, lossless mapping, graph/executor boundaries |
| Fresh-DB FWB + formal matrix | 27/27 | activation 14, write action 4, S1-S8 matrix 9 |
| Fresh-DB attachment boundaries | 29/29 | booted routes 11, bind/reconcile 10, GC/drain 8 |
| Backend `tsc --noEmit` | pass | composed backend type surface |
| Web `vue-tsc --noEmit` | pass | composed frontend type surface |
| Nine discriminating mutations | RED then restored GREEN | prior five guards plus canonical decimals, update actor, preview empty-branch, and deterministic-refusal settlement |
| Grok exact-head adversarial review | APPROVE, 0 P1/P2 | reviewed `eb107032d`; retained attachment/S3/numeric-lexeme items as P3 residuals only |
| Kimi K3 document consistency review | pass after one correction | found stale historical `36/36` evidence; corrected to exact-head `37/37`, then cross-counts reconciled |

The exact `eb107032d` product head passed the required local script: Canvas/form command canaries 37/37,
attachment flag canary 4/4, then 353/353 files and 4242/4242 tests in the curated main run. Remote PR CI
remains a separate merge gate and is never inferred from a local run.

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
2. Ratify D0 (or return specific changes). Only then start Canvas D3/D6-f2 and the later visual slices,
   including the ordinary-user FWB mapping UI.
3. Implement and review FWB-2 and FWB-3 as separately gated product slices; do not describe their pure
   modules as production delivery.
4. Run real approval-data UAT, including rejected/withdrawn/non-approved no-write, revoked permission,
   duplicate delivery, attachment hidden-field/read-deny, and S3/scanner failure cases.
5. Enable flags in the staged order; each transition is a separate operational decision.
6. Canvas visual/accessibility closeout requires Playwright at 1440x900, 1024x768, and 390x844 after
   D3-D11-C exist. It is not waived by the phase-1 command-layer evidence.
7. Remaining non-blocking evidence debt: attachment double-submit currently proves real HTTP overlap
   and one blocked bind waiter rather than both handlers simultaneously parked; production object-store
   delete/error behavior still needs the S3 adapter/UAT (the current byte-drain proof uses LocalFs); and
   JSON numeric snapshots cannot recover a source lexeme already rounded by JavaScript, so high-precision
   business inputs must remain string-backed or be rejected by the mapped precision envelope.
