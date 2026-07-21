# Approval Authoring and Data Closure Closeout Verification (2026-07-21)

**Status:** ENGINEERING CLOSEOUT CANDIDATE - approval-data closure ready for review/UAT; Canvas V2 phase 2 remains gated
**Design lock:** `approval-canvas-v2-interaction-design-lock-20260721.md` (`PROPOSED`)
**Execution ledger:** `approval-authoring-data-closure-execution-ledger-20260721.md`
**Integration base:** `origin/main@1f06ecea96be1dfb86f6b24830e1525c3e1d9f2e`
**Runtime posture:** all new product flags remain default OFF

## 1. Verdict

The approval-data closure objective is implemented on the integration candidate:

- an approved independent approval form can map `text`, `number`, `date`, and `select` values into a
  new multitable record;
- the write is net-once and commits its claim, record, revision, and downstream durable event together;
- approval attachments have a production pipeline with authenticated download, hidden-field redaction,
  scanner/storage fail-closed behavior, durable purge, and bounded reconciliation;
- the formal S1-S8 durable/FWB matrix executes the real producer, dispatcher, consumer adapters,
  production action, and chained record event.

The Canvas V2 objective is only at phase 1. The safe command substrate and backend guards are present,
but the final tree renderer, inspector, semantic drag, mounted form-builder workflow, responsive visual
proof, and accessibility closeout are not implemented. D0 is still `PROPOSED`, so calling the complete
program finished would violate the ratification gate.

## 2. User-visible capability boundary

### Available after merge and owner flag/UAT decisions

- Configure an approved-only automation that writes selected approval form values to the rule's sheet.
- Preserve record/revision/outbox atomicity and suppress duplicate instance/action replays.
- Upload and bind approval attachments, resolve frozen refs, and download bytes through authenticated API
  routes without exposing storage keys.
- Continue using the current approval authoring UI with safer immutable graph/form edit commands.

### Not yet available

- The final Feishu/DingTalk-style tree canvas as the sole ordinary-user authoring surface.
- Semantic drag/drop, responsive inspector/bottom sheet, full keyboard/touch equivalence, and visual
  version-diff overlays on that canvas.
- Production enablement. No flag is turned on by this branch.

## 3. Review findings fixed on the composed head

| Finding | Severity | Resolution | Discriminating evidence |
|---|---|---|---|
| Invalid calendar dates could pass FWB ISO parsing | P1 data correctness | strict month/day/leap-year validation | regex-only mutant makes the new unit case RED |
| Canvas command tests absent from required gates | P2 CI | required script plus Approval Web Guard paths/canary step | required script collected 36/36 before the main suite |
| Attachment detail assumed the new feature ref always existed | P2 compatibility | optional read, missing ref means OFF | original required run failed 13/13 detail cases; fixed scope 95/95 |
| Eight-scenario fixture used the pre-publish version | P2 test drift | query and bind `active_version_id` in event/config/hash | old fixture failed save; corrected fixture reaches production action |
| S7 expected raw database error text | P2 security-test drift | assert values-free `fwb_execution_failed` and absence of raw text | S7 proceeds through rollback and clean replay |
| ApprovalNewView spec-only changes did not trigger the path guard | P3 CI | add the spec to both pull-request and main-push paths | both trigger lists now contain the exact file |
| Attachment flag parser had no green required canary | P3 CI | export the pure parser and add a focused camel/snake-key matrix | focused canary 4/4; broad quarantined featureFlags specs remain out |
| Six real-DB files relied on manually maintained two-point wiring | P3 CI | add a source-derived no-DB-exclude plus whole-file-run contract | structural contract 12/12 |
| Attachment unit-canary comment incorrectly denied default discovery | P3 documentation | describe the explicit canary as stable ownership, not first-ever collection | source comment corrected without changing execution |
| Booted attachment suite inherited a 15-second setup limit | P3 test stability | give this full-server setup/cleanup an explicit 30-second hook budget | exact-head rerun reaches and passes all product assertions |

## 4. Verification evidence

### Frontend

- Focused composed suite: 11 files, 260/260.
- Required preflight canaries: Canvas commands 36/36; attachment flag parser 4/4.
- Required curated main suite: 353 files, 4237/4237.
- Approval detail compatibility and attachment positives: 95/95.
- `vue-tsc --noEmit`: pass.
- Kimi K3 CI-wiring adversarial audit: four low-severity findings reproduced and fixed; the new
  two-point structural contract passes 12/12. Its three product-code review subagents were interrupted,
  so this is CI evidence only, not a second independent product-correctness verdict.

### Backend

- Focused composed unit suite: 16 files, 275/275.
- FWB mapping unit: 5/5; calendar guard mutation discriminates.
- Fresh fully migrated PostgreSQL database:
  - FWB activation: 8/8;
  - attachment GC/bind/reconcile/upgrade: 19/19;
  - booted-server attachment production pipeline: 10/10;
  - formal durable/FWB S1-S8 matrix: 9/9;
  - FWB activation rerun after the matrix on the same DB: 8/8.
- `tsc --noEmit`: pass.

### Required-suite note

The first full local required-web run collected the new 36 command tests, then failed 13 legacy
`approvalDetailPolish` tests at the new feature-ref read. That failure was load-bearing and fixed. The
post-fix required script passed the command canaries 36/36 and the curated main run 4237/4237. A
subsequent CI-hardening pass added the focused attachment flag parser canary (4/4) ahead of that run.

## 5. Flag and deployment ledger

| Flag/dependency | Candidate default | Enablement requirement |
|---|---|---|
| `AUTOMATION_DURABLE_DELIVERY_ENABLED` | OFF unless explicitly set | owner UAT and staged rollout |
| Class-A/Class-B automation flags | OFF unless explicitly set | durable stable first |
| `APPROVAL_FWB_WRITEBACK_ENABLED` | OFF unless explicitly set | durable/Class-A prerequisites plus FWB UAT |
| `APPROVAL_ATTACHMENTS_ENABLED` | OFF unless explicitly set | S3/scanner configuration and attachment UAT |

## 6. Merge recommendation

**Approval-data closure:** review-ready after the final required-suite and adversarial review settle.

**Canvas V2 phase 1:** review-ready as a non-visual foundation. It does not authorize D3+ implementation.

**Whole program:** not final-closeable until the owner ratifies D0 and either ships D3-D11-C or explicitly
defers named slices. After those slices exist, run Playwright/canvas-pixel/accessibility evidence at the
three locked viewports and append a final AS-BUILT section rather than rewriting this partial boundary.
