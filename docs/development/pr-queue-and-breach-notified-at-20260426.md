# PR Queue Drain + breach_notified_at Follow-up — 2026-04-26

## Scope

Two pieces of work, single delivery doc:

1. **PR queue triage** — scan the 4 backlogged PRs (#1129, #1137, #1138,
   #1139) plus the 2 newly-opened (#1170, #1171), surface concrete blockers
   per PR.
2. **`breach_notified_at` follow-up** — small persistent-dedupe upgrade to
   PR #1171 wp5 SLA breach notifier, stacked on the breach-notify branch.
   Lifts semantics from "best-effort once" to "at-least-once with persistent
   retry".

## Part 1 — PR queue snapshot

| PR | Theme | Lines | CI | Mergeability | Reviews |
|----|-------|-------|----|--------------| --------|
| **#1129** | DingTalk P4 closeout | +7203 / −100 (80f) | ✅ 8 SUCCESS | **BEHIND** | 2 commented (self-progress) |
| **#1137** | Multitable record post-commit hooks | +263 / −71 (11f) | ✅ 12 SUCCESS / 1 SKIPPED | **BEHIND** | 2 AI bots (gemini, copilot) |
| **#1138** | OpenAPI approval contracts align | +5084 / −1149 (10f) | ✅ 8 SUCCESS / 1 SKIPPED | **DIRTY (conflict)** | 2 AI bots |
| **#1139** | Approval template field visibility | +979 / −11 (16f) | ✅ 12 SUCCESS / 1 SKIPPED | **DIRTY (conflict)** | 2 AI bots |
| **#1170** | Multitable M5 automation-service | +859 / −679 (5f) | (just opened) | clean (892ed2f9c) | (pending) |
| **#1171** | Approval SLA breach notify | +1242 / −495 (12f) | (just opened) | clean (892ed2f9c) | (pending) |

### Per-PR action items

**#1129 DingTalk P4 closeout** — BEHIND, CI all green.
- Action: rebase onto `origin/main` (`892ed2f9c`).
- Review status: only self-pushes in comments; no AI bot review on the PR
  body itself. May want to request a fresh AI review after rebase to surface
  hidden regressions in 7203-line diff.
- Risk: large surface area; recommend smaller squash if possible during merge.

**#1137 Multitable record post-commit hooks** — BEHIND, CI all green.
- Action: rebase onto `origin/main`.
- AI review summary (gemini): "Replaces direct Yjs invalidation logic in
  `RecordWriteService` and `RecordService` with a generic post-commit hook
  system. Feedback suggests extending hooks to `createRecord` and
  `deleteRecord` operations." → Optional follow-up, not a blocker.
- AI review summary (copilot): "Refactors multitable record write flows to
  replace the dedicated Yjs invalidator seam with a generic 'post-commit
  hooks' seam, while keeping `setYjsInvalidator(...)` as a compatibility
  shim and preserving the existing REST vs `source === 'yjs-bridge'`
  invalidation behavior." → Confirms intent.
- Verdict: **rebase + ship**. Extending to create/delete records is its own
  follow-up.

**#1138 OpenAPI approval contracts align** — DIRTY (conflicting).
- Action: resolve conflicts then rebase. Likely conflict files: `apps/web`
  approvals API client + `packages/openapi` dist (the latter is the bulk of
  `+5084 / −1149`).
- Likely cause: WP3 (read tracking #1132), WP4 (categories #1133, ACL
  b673e4bb0) and WP5 (SLA observability 6eec0692f, TopN c703b0ffc) all
  touched approval routes after this PR opened, creating multiple OpenAPI
  surface deltas to fold in.
- AI review (gemini): "Aligns approval OpenAPI contracts and generated SDK
  with live runtime routes — `listApprovals` query parameters (`tab`,
  `search`, pagination), new endpoints for syncing, read markers, etc."
- Verdict: requires concrete merge work (~30 min of conflict resolution
  + regen). Likely highest-friction PR in the pool.

**#1139 Approval template field visibility** — DIRTY (conflicting).
- Action: resolve conflicts then rebase. Likely conflict files: approval
  template service / routes / template detail view.
- Likely cause: WP4 ACL (b673e4bb0) + categories (#1133) + SLA edit field
  (6eec0692f from wave 8 A) all touched `ApprovalProductService.ts` /
  `TemplateDetailView.vue`.
- AI review (copilot): "Adds persisted, single-dependency field visibility
  rules to approval template form fields, enforcing them server-side
  (validation + pruning) while mirroring behavior in the web UI."
- Verdict: real conflict work but smaller surface than #1138.

### Queue drain order recommendation

Cheapest → costliest in resolution effort:

1. **#1170** M5 (just opened, clean) → quick review
2. **#1171** breach-notify (just opened, clean) → quick review
3. **#1137** post-commit hooks → rebase only
4. **#1129** DingTalk P4 → rebase only (large diff but no conflict)
5. **#1139** field visibility → conflict resolution
6. **#1138** OpenAPI → conflict resolution + dist regen

Also, the **stacked PR** below (`breach_notified_at`) lands after #1171.

## Part 2 — breach_notified_at follow-up

PR #1171 explicitly listed this as the next step:

> Persistent `breach_notified_at` column for cross-restart / leader-takeover
> dedupe (small migration + WHERE-clause filter, ~60 LoC).

Final scope was a touch larger (~711 / −61 across 10 files) because it
also drops the in-memory FIFO and rewires the scheduler tick to dispatch
union(new + retry-pending).

### Branch + commits

- Branch: `codex/approval-sla-breach-notified-at-20260426`
- Baseline: `50179d9d7` (PR #1171 tip — **stacked PR**)
- Commits on top:
  - `1a50e045d` feat
  - `3ffda7a1f` docs follow-up
- Final HEAD: `3ffda7a1f`

### Files touched (10 total, +711 / −61)

- `packages/core-backend/src/db/migrations/zzzz20260426100000_add_breach_notified_at.ts` (new)
- `packages/core-backend/src/services/ApprovalMetricsService.ts` (+41 LoC):
  `listBreachesPendingNotification`, `markBreachNotified`
- `packages/core-backend/src/services/ApprovalSlaScheduler.ts` (+28 LoC):
  union dispatch via `mergeUnique`, gated on `onBreach`
- `packages/core-backend/src/services/ApprovalBreachNotifier.ts`: rewritten
  — FIFO `Set<instanceId>` dropped, `markBreachNotified(successfulIds)`
  post-dispatch
- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`:
  column inlined, partial index added, version bumped to
  `20260426-wp5-breach-notified-at`
- `packages/core-backend/tests/unit/approval-metrics-breach-notified-at.test.ts` (new — 7 cases)
- `packages/core-backend/tests/unit/approval-breach-notifier.test.ts` (12 cases — legacy FIFO test rewritten, 5 new persistent-dedupe cases)
- `packages/core-backend/tests/unit/approval-sla-scheduler.test.ts` (11 cases — 4 new for union dispatch / no-onBreach short-circuit / pending-lookup failure isolation)
- `docs/development/approval-sla-breach-notified-at-development-20260426.md` (new)
- `docs/development/approval-sla-breach-notified-at-verification-20260426.md` (new)

### Semantic upgrade

| Before (PR #1171) | After (this PR) |
|---|---|
| `checkSlaBreaches` flips `sla_breached=TRUE` and returns those ids; notifier called once via `onBreach`. | Same flip, **plus** `listBreachesPendingNotification()` returns all `sla_breached=TRUE AND breach_notified_at IS NULL`. Scheduler dispatches union. |
| All channels failing → never re-notified (silent loss). | All channels failing → `breach_notified_at` stays NULL → next tick retries. |
| In-memory `Set<instanceId>` (bounded 5000) for in-process dedupe — process restart / leader takeover bypassed it. | Persistent column-based dedupe — survives restart and leader takeover. In-memory FIFO dropped (now redundant). |

### Marking semantics

- After `notifyBreaches(ids)`: per-instance compute `successfulInstanceIds`
  = instances where **at least one channel returned `ok: true`**.
- Call `markBreachNotified(successfulInstanceIds)`.
- Instances where **all channels failed**: stay unmarked → next tick retries.
- If notifier itself throws (DB failure inside `listBreachContextByIds` or
  `markBreachNotified`): nothing is marked, exception propagates to
  scheduler's outer try/catch.

### Migration safety

```sql
ALTER TABLE approval_metrics
  ADD COLUMN IF NOT EXISTS breach_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS approval_metrics_breach_pending_idx
  ON approval_metrics (sla_breached_at NULLS FIRST, started_at)
  WHERE sla_breached = TRUE AND breach_notified_at IS NULL;
```

- Idempotent (`IF NOT EXISTS`), safe to apply to a partially-breached DB.
- Index keys diverge from spec (`sla_breached_at NULLS FIRST, started_at`
  rather than `sla_breached, breach_notified_at`) — predicate identical;
  agent picked keys that serve the actual `ORDER BY`. Documented in
  verification MD.

### Verification

- `npx tsc --noEmit` → exit 0
- Targeted vitest **30/30 pass** across:
  - `approval-metrics-breach-notified-at.test.ts` (7)
  - `approval-breach-notifier.test.ts` (12)
  - `approval-sla-scheduler.test.ts` (11)
- Regression: `approval-metrics-service.test.ts` (15) re-run green.

### Stacked-PR review story

- Baseline `50179d9d7` is PR #1171 tip; this PR is **stacked**.
- Verification MD instructs reviewers: land after #1171 or rebase onto main
  once it merges.
- Only cross-cutting change is the bootstrap-version bump in
  `tests/helpers/approval-schema-bootstrap.ts` — affects only integration
  tests (8 files, all `DATABASE_URL`-gated); does not regress PR #1171
  itself.

## Part 3 — Recommended next steps

1. **Drain queue, do not open new lanes.** Roadmap 阶段一约束仍然有效。
2. **Order the queue per Part 1's drain order**:
   - #1170 + #1171 → quick review (both clean, no conflict)
   - #1137 + #1129 → rebase only
   - #1139 + #1138 → conflict resolution
   - **stacked**: `breach_notified_at` (this work) → push and open as Draft
     until #1171 merges; convert to Ready once parent lands.
3. **Continue waiting for K3 PoC customer GATE answer** — that's the real
   阶段一 blocker, not engineering throughput.
4. **No new parallel waves until queue ≤ 2 PRs and customer answer
   received.**

## Part 4 — Open follow-ups (post-this-PR)

Carried over from PR #1171's body, **resolved by this work**:

- ~~Persistent `breach_notified_at` column~~ ✅ **Done in this PR**.

Still open:

- **Real SMTP transport** for the email channel — pending dep policy
  decision on `nodemailer` / managed sender (SES / SendGrid). Today email
  channel is a logging stub.
- **Live DingTalk integration test** — today: mock-only; manual `curl`
  verification path documented in #1171's verification MD.
- **Per-channel retry within a single tick** — out of scope; current
  retry semantics are tick-level (next scheduler tick retries failed
  channels). Per-channel exponential backoff would belong inside each
  channel's `send()`.

## Files in this delivery

- `docs/development/pr-queue-and-breach-notified-at-20260426.md` (this file)
- Branch `codex/approval-sla-breach-notified-at-20260426` @ `3ffda7a1f`:
  - `docs/development/approval-sla-breach-notified-at-development-20260426.md`
  - `docs/development/approval-sla-breach-notified-at-verification-20260426.md`
  - All implementation + test files listed above

## Action log (2026-04-26)

### Decision: hold the stacked PR

Decision: **do not** open `codex/approval-sla-breach-notified-at-20260426`
as a Draft PR yet. Rationale (per queue-drain discipline): adding a 7th open
PR before draining the existing 6 dilutes review attention; stacked PRs in
GitHub UI default to a `main`-base diff (混合显示父+子改动) which makes
review boundaries blur. Branch is preserved locally with full MDs; cost to
open the PR after #1171 merges is one `git push` + one `gh pr create`.

### #1171 PR body augmentation

Appended a "Follow-up branch ready (post-merge action)" section to
[#1171](https://github.com/zensgit/metasheet2/pull/1171) so reviewers
discover the prepared follow-up branch without it being in the queue.

Mechanism:

```bash
gh pr view 1171 --json body --jq '.body' > /tmp/pr1171-current-body.txt
# append the new section
gh pr edit 1171 --body-file /tmp/pr1171-new-body.txt
```

**Before** (1936 chars, last section was `Follow-up` bullet list).
**After** (3002 chars, +1066 chars, adds "Follow-up branch ready (post-merge action)" section listing branch, HEAD, baseline, test counts, file delta, semantic upgrade, MD pointers).

**Verification of the edit:**

- `gh pr view 1171 --json body --jq '.body' | tail -15` returned the
  appended section verbatim — confirmed live on GitHub.
- No CI re-trigger (PR body edits do not invalidate checks).
- No mergeability change (still clean against `origin/main@892ed2f9c`).

### Open follow-up actions (when #1171 merges)

```bash
git -C /tmp/ms2-breach-notified-at fetch origin
git -C /tmp/ms2-breach-notified-at rebase origin/main
# zero-conflict expected — the parent PR's content is now part of main
git -C /tmp/ms2-breach-notified-at push -u origin codex/approval-sla-breach-notified-at-20260426
gh pr create --base main \
  --head codex/approval-sla-breach-notified-at-20260426 \
  --title "feat(approval): persist breach notification dedupe" \
  --body-file <prepared body>
```

The prepared PR body should reference this delivery MD + the branch-local
dev/verification MDs.

### Roadmap-stage compliance check

All actions in this slice respect the
`integration-erp-platform-roadmap-20260425.md` 阶段一约束:

- ✅ no new战线 opened
- ✅ no `plugins/plugin-integration-core/*` touched
- ✅ no platform-化 work started
- ✅ pure 内核打磨 (持久化 dedupe of an already-shipped feature)
