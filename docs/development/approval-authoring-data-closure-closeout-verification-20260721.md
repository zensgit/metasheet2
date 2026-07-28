# Approval Authoring and Data Closure Closeout Verification (2026-07-21)

**Status:** PARTIAL ENGINEERING CLOSEOUT - FWB-1 and attachments are review candidates; Canvas V2 and FWB-2/3 remain open
**Design lock:** `approval-canvas-v2-interaction-design-lock-20260721.md` (`PROPOSED`)
**Execution ledger:** `approval-authoring-data-closure-execution-ledger-20260721.md`
**Review baseline:** `3ade0d685bbad1605cf71803b228f9aac27d0842`
**Verified product-code head:** `eb107032d`
**Runtime posture:** all new product flags remain default OFF

## 1. Verdict

Two approval-data slices are implemented on the integration candidate:

- an approved independent approval form can map `text`, `number`, `date`, and `select` values into a
  new multitable record;
- the write is net-once and commits its claim, record, revision, and downstream durable event together;
- approval attachments have a production pipeline with authenticated download, hidden-field redaction,
  scanner/storage fail-closed behavior, durable purge, and bounded reconciliation;
- the formal S1-S8 durable/FWB matrix executes the real producer, dispatcher, consumer adapters,
  production action, and chained record event.

This is **FWB-1 only**: create a new record from approved form values. FWB-2 existing-record selection/
update and FWB-3 approver-confirmed decision values are not registered in the production action path.
The ordinary-user mapping/confirmation UI is also absent. Therefore the broader claim "approval form,
process, or result data can all be written back" is not yet true.

The Canvas V2 objective is only at phase 1. The safe command substrate and backend guards are present,
but the final tree renderer, inspector, semantic drag, mounted form-builder workflow, responsive visual
proof, and accessibility closeout are not implemented. D0 is still `PROPOSED`, so calling the complete
program finished would violate the ratification gate.

## 2. Capability boundary

### Available after merge and owner flag/UAT decisions

- Configure, through the API/runtime contract only, an approved-only automation that writes selected
  approval form values to the rule's sheet. This branch does not ship an ordinary-user authoring UI.
- Preserve record/revision/outbox atomicity and suppress duplicate instance/action replays.
- Upload and bind approval attachments, resolve frozen refs, and download bytes through authenticated API
  routes without exposing storage keys.
- Continue using the current approval authoring UI with safer immutable graph/form edit commands.

### Not yet available

- The final Feishu/DingTalk-style tree canvas as the sole ordinary-user authoring surface.
- Semantic drag/drop, responsive inspector/bottom sheet, full keyboard/touch equivalence, and visual
  version-diff overlays on that canvas.
- Ordinary-user FWB mapping/confirmation authoring, FWB-2 existing-record update, and FWB-3
  approver-confirmed decision values.
- Mounted form update/remove/reorder undo history; the current D6-f1 foundation only allocates stable
  IDs, refuses retired IDs, and preserves insertion/reordering sequence.
- Production enablement. No flag is turned on by this branch.

## 3. Review findings fixed on the composed head

| Finding | Severity | Resolution | Discriminating evidence |
|---|---|---|---|
| Invalid calendar dates could pass FWB ISO parsing | P1 data correctness | strict month/day/leap-year validation | regex-only mutant makes the new unit case RED |
| Canvas command tests absent from required gates | P2 CI | required script plus Approval Web Guard paths/canary step | exact-head command/form preflight collected 37/37 before the main suite |
| Attachment detail assumed the new feature ref always existed | P2 compatibility | optional read, missing ref means OFF | original required run failed 13/13 detail cases; fixed scope 95/95 |
| Eight-scenario fixture used the pre-publish version | P2 test drift | query and bind `active_version_id` in event/config/hash | old fixture failed save; corrected fixture reaches production action |
| S7 expected raw database error text | P2 security-test drift | assert values-free `fwb_execution_failed` and absence of raw text | S7 proceeds through rollback and clean replay |
| ApprovalNewView spec-only changes did not trigger the path guard | P3 CI | add the spec to both pull-request and main-push paths | both trigger lists now contain the exact file |
| Attachment flag parser had no green required canary | P3 CI | export the pure parser and add a focused camel/snake-key matrix | focused canary 4/4; broad quarantined featureFlags specs remain out |
| Six real-DB files relied on manually maintained two-point wiring | P3 CI | add a source-derived no-DB-exclude plus whole-file-run contract | structural contract 12/12 |
| Attachment unit-canary comment incorrectly denied default discovery | P3 documentation | describe the explicit canary as stable ownership, not first-ever collection | source comment corrected without changing execution |
| Booted attachment suite inherited a 15-second setup limit | P3 test stability | give this full-server setup/cleanup an explicit 30-second hook budget | exact-head rerun reaches and passes all product assertions |
| Deleting/moving a sole parallel-branch body could create fork-to-join and let `joinMode=any` advance without an assignment | P1 approval correctness | frontend commands refuse the mutation; backend normalization rejects the graph | frontend move/delete negatives plus backend mutant each RED |
| Branch removal heuristics rewrote complex/shared branches | P2 graph integrity | removal is limited to a provably exclusive one-node branch; ambiguous shapes fail closed | complex/shared branch negatives |
| Canvas error paths surfaced raw graph IDs | P2 information exposure | ordinary-user error/unsupported copy is generic and business-facing | mounted/layout/template hygiene negatives |
| FWB save/update could reuse creator authority instead of checking the actual modifier/enabler | P1 authorization | bind request actor; separately preserve creator authority checks | real-DB modifier/enabler negative and positive controls |
| FWB target fields could include per-subject readonly fields | P1 data authorization | canonical field-permission derivation at save and execute | independent gate mutation RED |
| FWB infrastructure failure could settle durable delivery and lose the write | P1 reliability | retryable FWB failure throws to the durable adapter and remains reclaimable | fault-injection real-DB replay |
| Two rules could emit the same chained FWB event ID | P2 idempotency | include rule ID plus structural action key | cross-rule golden; identity mutant RED |
| Confirmation omitted target base and number conversion could lose precision | P2 authority/data correctness | target base included in hash; unsafe/excess-precision numbers fail closed | rehome and precision negatives; number mutant RED |
| Attachment race proof was helper-level or sequential | P2 evidence | booted HTTP double-submit, blocking GC-wins race, and real blob drain | exact-head 29/29 real-DB suite |
| Number precision lookup used `property.precision`, while canonical fields persist `property.decimals` | P1 data correctness | bind the execution mapping to canonical `decimals` | real-DB `decimals=2` / `12.345` rejection; spelling mutant RED |
| FWB update still defaulted a missing actor inside the helper | P2 authorization | creation passes its actor explicitly; update has no actor default or creator fallback | real-DB omitted-actor negative; fallback mutant RED |
| Canvas validity preview omitted the empty-parallel-branch invariant | P2 authoring safety | reuse `hasEmptyParallelBranch` in preview and emit generic copy | focused preview negative; guard mutant RED |
| Execute-time field revocation was only covered through an allow-all executor seam | P2 evidence | exercise the production gate after a real `field_permissions.read_only` change | zero claim and record rows in real DB |
| Deterministic `fwb_rejected:instance_not_found` consumed durable retries | P3 reliability | settle the complete deterministic refusal namespace; retain retry only for infrastructure failure | real production event-fire becomes `done`; classifier mutant RED |

## 4. Verification evidence

### Frontend

- Exact-head Canvas focused suite: 4 files, 118/118.
- The exact product head passed the required local script: Canvas/form command canaries 37/37,
  attachment flag canary 4/4, then 353/353 files and 4242/4242 tests.
- `vue-tsc --noEmit`: pass.

### Backend

- Backend graph authority: 111/111.
- FWB focused units: 48/48.
- Fresh fully migrated PostgreSQL database:
  - FWB activation/write action: 18/18;
  - attachment booted pipeline/bind-reconcile/GC: 29/29;
  - formal durable/FWB S1-S8 matrix: 9/9;
- `tsc --noEmit`: pass.
- Nine source mutations each turned its named guard RED, were restored with `apply_patch`, and reran
  GREEN: field writability, cross-rule event identity, move/backend empty-branch guards, unsafe-number
  rejection, canonical decimals, update actor, preview empty-branch, and deterministic settlement.
- Grok's read-only exact-head re-review of `eb107032d`: APPROVE, zero P1/P2; attachment double-waiter,
  production S3 drain, and already-parsed numeric-lexeme limits remain explicitly P3.
- Kimi K3's cross-document pass found one stale `36/36` evidence count; it was corrected to the
  exact-head `37/37`, and all three documents now use the same status, SHA, counts, and owner gates.

### Required-suite note

The PR's required CI remains an independent merge gate; a local pass is not reported as remote CI
success.

## 5. Flag and deployment ledger

| Flag/dependency | Candidate default | Enablement requirement |
|---|---|---|
| `AUTOMATION_DURABLE_DELIVERY_ENABLED` | OFF unless explicitly set | owner UAT and staged rollout |
| Class-A/Class-B automation flags | OFF unless explicitly set | durable stable first |
| `APPROVAL_FWB_WRITEBACK_ENABLED` | OFF unless explicitly set | durable/Class-A prerequisites plus FWB UAT |
| `APPROVAL_ATTACHMENTS_ENABLED` | OFF unless explicitly set | S3/scanner configuration and attachment UAT |

## 6. Merge recommendation

**FWB-1 plus attachments:** code-complete, locally verified review candidates. Exact-head adversarial
review passed; merge recommendation still waits for remote required CI and owner merge authorization.

**Canvas V2 phase 1:** review-ready as a non-visual foundation. It does not authorize D3+ implementation.

**Whole program:** not final-closeable until the owner ratifies D0 and either ships D3-D11-C or explicitly
defers named slices; FWB-2/FWB-3 and the ordinary-user FWB authoring UI are separately shipped or
explicitly deferred; real UAT passes; and flags are intentionally enabled. After Canvas visual slices
exist, run Playwright/canvas-pixel/accessibility evidence at the three locked viewports and append a final
AS-BUILT section rather than rewriting this partial boundary.
