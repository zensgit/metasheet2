# Multitable Feishu Phase 3 — Plan and TODO Review

- Date: 2026-05-14
- Reviewer: Claude (Opus 4.7, 1M context), interactive harness
- Reviewed documents:
  - `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  - `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
- Redaction policy: this document contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot `SEC...`,
  K3 endpoint password, recipient user id, temporary password, or `.env`
  content. Only public spec references already present in the reviewed
  plan are cited.

## Verdict

**Conditional decline as written.** The technical design is sound, but
the strategic timing and aggregate scope clash with two standing
constraints recorded on `origin/main`:

1. Stage-1 lock from `docs/development/integration-erp-platform-roadmap-20260425.md`
   §4-§5: no new product战线 until K3 PoC GATE PASS.
2. Same roadmap §5 names "过度工程" as the #1 risk — "K3 PoC 还没过就投入
   平台化，结果客户没买单，平台化沉没成本巨大."

Recommended action: keep the plan and TODO documents in main as the
on-deck design; ship only the Lane D subset that qualifies as kernel
polish on already-shipped features; defer Lane A and Lane B until K3
GATE PASS; require additional non-engineering inputs (PM and domain
SME) before re-evaluating Lane C.

## Strategic Compatibility — Quick Table

| Lane | Opens new product战线? | Falls under stage-1 lock? | Verdict |
| --- | --- | --- | --- |
| Lane A — AI Field Shortcuts V1 | Yes (new AI surface) | Blocked by lock | Defer until K3 PASS |
| Lane B — Formula AI Assist | Yes (new AI surface) | Blocked by lock | Defer until K3 PASS |
| Lane C — Template / Industry Solution Center V2 | Yes (industry-solution = stage-4 surface) | Blocked by lock | Defer; gate on PM/SME availability |
| Lane D — Commercial Hardening Gates | Mixed — D0/D1/D4 are polish on shipped code; D2/D3 expand surface | Subset allowed | Ship D0 → D1 → D4 first; defer D2/D3 |

## What the Plan Proposes — Faithful Summary

The plan opens four lanes across 10 PRs:

- Lane A (A1-A3): AI provider readiness contract, AI field shortcut
  backend, AI field shortcut frontend. Four presets in V1: summarize,
  translate, extract, classify.
- Lane B (B1-B2): formula dry-run diagnostics with five typed error
  codes (`FORMULA_PARSE_ERROR`, `FORMULA_UNKNOWN_FIELD`,
  `FORMULA_TYPE_MISMATCH`, `FORMULA_RUNTIME_ERROR`,
  `FORMULA_AI_PROVIDER_BLOCKED`); natural-language formula suggestion
  endpoint with manual-accept gate.
- Lane C (C1-C2): template preview / dry-run / install / onboarding
  for five industry templates — project management, CRM follow-up,
  contract management, inspection feedback, recruiting pipeline.
- Lane D (D0-D4): release gate skeleton, real SMTP gate, large-table
  performance gate at 10k / 50k / 100k records, permission matrix gate,
  automation soak gate.

Cross-cutting rules in the plan: clean-worktree development, redacted
JSON+Markdown artifacts, dry-run-before-AI, manual-accept for AI
suggestions, blocked-by-default provider state, OpenAPI source +
generated dist updates on every contract change.

## Where the Plan Is Right

- AI-assist is correctly identified as the next remaining Feishu Base
  gap. This is consistent with `feishu-gap-roadmap-20260413.md`
  post-completion state and with `project_3month_roadmap.md` listing
  "AI-assisted features" as a `future` bucket.
- D0 release-gate-skeleton precedes the expensive D1-D4 gates.
  Skeleton-first is the same discipline that kept the DingTalk P4
  closeout artifacts redaction-clean.
- A1 provider readiness is pulled into its own PR before A2/A3.
  Security-sensitive code lands first, with redaction tests enumerated
  in the TODO.
- Non-Goals are pre-declared per lane: no chat-style copilot, no AI
  dashboard insights, no AI image/audio understanding, no per-cell
  streaming UI, no full formula language rewrite, no paid template
  billing, no public marketplace. This is the same scope discipline
  that contained Approval Wave 2.
- AI formula suggestion runs the candidate through dry-run before
  returning a success result. This prevents the AI from emitting an
  unparseable suggestion that the user then commits by accident.

## Strategic Conflicts — Decision Level

### S1. The plan does not reference the K3 PoC stage-1 lock.

`docs/development/integration-erp-platform-roadmap-20260425.md` §4
declares the project to be in 阶段一 (K3 PoC), and §5 states: "阶段
一锁定不开新战线；任何 K3 之外的工作必须等 PoC PASS 才启动" and "阶段
一可同步做内核打磨（不动 K3 PoC 路径），但不投入平台化代码." The plan
opens AI parity (Lane A, Lane B) and an industry solution center
(Lane C) before PoC PASS, and does not acknowledge the lock.

### S2. Roadmap risk #1 ("过度工程") fits this plan precisely.

The same roadmap names overengineering before PoC PASS as the
top-ranked risk. The mitigation it prescribes is exactly: do not invest
平台化 code before PoC PASS. A plan that opens AI shortcuts, formula
AI assist, and industry template center simultaneously is the literal
failure mode the roadmap names.

### S3. Aggregate scope is 9-12 weeks of focused engineering.

| Lane | Realistic ship effort |
| --- | --- |
| Lane A (A1 + A2 + A3) | 2-3 weeks |
| Lane B (B1 + B2) | 1.5-2 weeks |
| Lane C (C1 + C2 across five industry templates) | 3-4 weeks, gated by PM / domain SME |
| Lane D (D0 .. D4) | 2-3 weeks |

Aggregate is approximately 9-12 weeks. Running it before K3 PASS
commits this much capacity to a track without customer-validation,
which is the same sunk-cost concern the roadmap explicitly names.

### S4. Lane C requires non-engineering inputs the plan does not budget.

The plan lists five industry templates — project management, CRM
follow-up, contract management, inspection feedback, recruiting
pipeline. Each is a domain SME deliverable: field set, view set,
automations, permission recommendations, sample records. Engineering
can build the install / preview / dry-run mechanics, but the templates
themselves need PM plus domain SME. Without that, the templates risk
being "shallow Feishu-shaped" and will damage trial reputation more
than they help it.

## Technical Gaps to Close Before Launch

### T1. No AI cost / token budget / per-tenant rate limit.

The plan mentions provider timeout and max output length, but no
token-cost ledger, per-tenant token budget, daily or weekly cap, or
burst rate-limit. AI calls cost real money. Without a cost ceiling, a
careless trial customer can exhaust the account in hours. This must
land inside Lane A1 (provider readiness) before Lane A2 (run endpoint)
ships, not after.

### T2. Boundary with existing automation-service.ts is not declared.

`packages/core-backend/src/multitable/automation-service.ts` already
implements `send_email` / `update_record` / `send_webhook` actions and
a nested condition builder (recently extended in #1466 - #1482). The
plan introduces AI shortcut preview / run endpoints as a separate API
surface. The plan must declare:

- Are AI shortcuts an automation action, or a separate execution model?
- If separate, do they share the existing execution-log persistence,
  audit shape, and dead-letter behavior?
- If shared, which file gains the new preset enum?

Without this declaration, the plan risks building a second automation
engine in parallel — explicitly warned against by
`feishu-gap-roadmap-20260413.md` §6: "沿现有自动化模型增量扩展，不另起
一套引擎."

### T3. No concrete SLO numbers on AI execution.

"Centrally enforced timeout and max output length" is correct in
shape, but the plan omits concrete numbers: max wall-clock per preview
call, max wall-clock per run row, cancel / abort semantics from the
UI, streaming versus batch return. UI design depends on these
numbers, so they need to be in the contract before A3 (frontend)
starts.

### T4. D2 large-table perf gate may collide with 142 K3 PoC integrity.

142 currently runs the K3 PoC images and the final DingTalk closeout
images (verified main SHA `ca70e340a` per
`dingtalk-final-closeout-completion-verification-20260511.md`).
Driving 10k / 50k / 100k record import on the same Postgres process
during the K3 live acceptance window can mask K3 latency regressions
or trigger PG tuning changes that perturb the PoC environment. The
plan should either pin D2 to a non-142 environment, or time-window D2
to run only after K3 GATE PASS. The plan currently lists "142 staging
has a passing Phase 3 report" as a final acceptance condition, which
contradicts running D2 on 142 during the K3 window.

### T5. D3 permission matrix gate sequence is ambiguous.

The permission matrix touches sheet / view / field / record / export
— five existing subsystems, each with its own RBAC code path. The
plan does not say whether D3 should be a snapshot of current
multitable RBAC behavior or a specification of target behavior (golden
matrix). Without that distinction, D3 can pass while silently masking
a regression that simply matches whatever the current code happens to
do.

### T6. AI provider state matrix is incomplete.

The plan defines `blocked` as the missing-config state, but does not
enumerate other states the UI must render:

- `disabled` — admin disabled at tenant level
- `rate_limited` — per-tenant token budget hit
- `quota_exhausted` — account-level budget hit
- `provider_error` — upstream provider failure
- `unsafe_input` — content policy rejection

If only `blocked` is defined, the frontend will eventually render
`unknown_error` for the other five states.

### T7. Lane C install rollback is named but unbudgeted.

"Return rollback status on partial failure" is listed as a single
TODO checkbox. Real partial-rollback across base / sheet / fields /
views / automations requires either a transaction wrapper that
crosses multiple authoritative services, or compensating writes per
object type. Either approach is multi-day work, not a single check-
box. The plan should either upgrade rollback to its own sub-lane, or
downgrade to "best-effort no-rollback with explicit partial-state
report".

## Document-Quality Observations

- The TODO file has zero filled PR / merge / development-MD /
  verification-MD fields. That is normal for a pre-launch plan, but
  means no work is actually in flight. Memory and conversation
  references should treat this Phase 3 as `proposed`, not
  `in progress`.
- Both reviewed documents are in English while the upstream
  user-facing roadmap (`feishu-gap-roadmap-20260413.md`) is in
  Chinese. Inconsistency is cosmetic but worth resolving — pick one
  language and stay there.
- The plan does not cross-reference
  `multitable-feishu-phase2-todo-20260509.md` to substantiate the
  Phase 2 closeout claim in its Status section. A one-line "Phase 2
  closeout proof: PR #X, merge SHA Y" would tighten the "no longer
  blocked by original gaps" statement.
- Worktree rule wording is correct in spirit but the root checkout
  on the operator's machine currently contains uncommitted
  Attendance work. Phase 3 PRs starting from a clean worktree per
  the plan's own rule is mandatory — the root checkout cannot host
  Phase 3 implementation work until the Attendance changes land or
  are stashed.

## Recommended Re-Scope

### Ship now — compatible with stage-1 lock

Land only the Lane D subset that is unambiguously kernel polish on
already-shipped features:

- D0 release-gate skeleton: `pnpm verify:multitable-release:phase3`
  in blocked mode, shared JSON+Markdown report writer, shared
  redaction helper, unit tests proving the helper covers AI provider
  keys, SMTP credentials, JWTs, bearer tokens, webhook URLs, and
  recipient-like values.
- D1 real SMTP gate guarded by `CONFIRM_SEND_EMAIL=1`, dedicated test
  recipient env, mail send result tied to automation execution log,
  redacted artifact.
- D4 automation soak gate exercising `record.created` /
  `update_record` / `send_email` / `send_webhook` repeat-fire and
  asserting execution-log persistence and controlled failure.

These three sub-lanes harden code that is already live on `main` and
deployed on 142. They do not open a new product战线 and they do not
touch `plugins/plugin-integration-core/*` or any K3 PoC path.

### Defer D2 and D3 until 142 capacity is K3-free

D2 perf at 50k / 100k and D3 permission matrix should land either
after K3 PoC GATE PASS, or against a non-142 staging environment that
does not share Postgres with the PoC images.

### Defer Lane A and Lane B until K3 PASS

AI parity is the correct next gap, but the time to ship it is after
PoC PASS. Before launching Lane A, the plan must add:

- T1 — token budget, per-tenant rate limit, cost ledger.
- T2 — explicit boundary statement against automation-service.ts.
- T3 — concrete SLO numbers, cancel and streaming semantics.
- T6 — full provider state enumeration.

### Defer Lane C and add a non-engineering gate

Lane C is the riskiest lane. Before launching it:

- Confirm PM / PD ownership for each of the five industry templates.
- Confirm domain SME availability for at least three of the five.
- Upgrade rollback (T7) into its own sub-lane with explicit scope.

If PM / SME inputs are not available, drop Lane C entirely. Building
shallow industry templates is worse than not shipping them.

## Suggested PR Sequence — Re-Scoped

### PR R1 — docs only (this review + plan/TODO annotations)

Title: `docs(multitable): review phase3 ai parity plan and re-scope`

Contents:

1. Add this review file.
2. Edit `multitable-feishu-phase3-ai-hardening-plan-20260514.md`:
   - Add an "Activation Constraints" section that references the
     stage-1 lock and the four pre-launch blockers T1-T7.
   - Mark Lane A and Lane B as `deferred pending K3 GATE PASS`.
   - Mark Lane C as `pending PM / SME assignment`.
   - Re-order Lane D as D0 → D1 → D4 → (D2, D3 deferred).
3. Edit `multitable-feishu-phase3-ai-hardening-todo-20260514.md`:
   - Mark deferred lanes with `deferred` status.
   - Add a top-level Activation Gate section that requires K3 GATE
     PASS + T1-T7 closed before flipping Lane A/B back to `pending`.

### PR R2 — D0 release-gate skeleton

Title: `test(multitable): add phase3 release gate skeleton`

Contents per the original plan's PR 2, scoped to D0 only. Clean
worktree from `origin/main`.

### PR R3 — D1 real SMTP gate

Title: `test(multitable): add phase3 real smtp send gate`

Contents per the original plan's D1 section. Requires
`CONFIRM_SEND_EMAIL=1` + dedicated test recipient + redaction.

### PR R4 — D4 automation soak gate

Title: `test(multitable): add phase3 automation soak gate`

Contents per the original plan's D4 section. Exercises shipped
automation actions only.

### Out of scope for now

PRs 3-9 of the original plan (Lane A, Lane B, Lane C) remain on the
plan document but do not enter the active PR queue until the
Activation Gate is met.

## Final Acceptance for This Review

This review is complete when:

- The plan and TODO files acknowledge the stage-1 lock explicitly.
- Lane A / B / C deferral is recorded with re-entry criteria.
- Lane D sub-lane sequencing (D0 → D1 → D4 → later D2, D3) is
  recorded.
- T1-T7 gaps are listed as pre-launch blockers in the plan, not as
  TODO checkboxes inside the deferred lanes.
- This review file plus the plan / TODO edits land in a single
  docs-only commit on `main`.

## References

- `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
- `docs/development/integration-erp-platform-roadmap-20260425.md`
- `docs/development/integration-vendor-abstraction-checklist-20260425.md`
- `docs/development/feishu-gap-roadmap-20260413.md`
- `docs/development/multitable-feishu-phase2-todo-20260509.md`
- `docs/development/dingtalk-final-closeout-completion-verification-20260511.md`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/src/routes/dashboard.ts`
