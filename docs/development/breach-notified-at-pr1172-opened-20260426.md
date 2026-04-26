# breach_notified_at PR #1172 Opened — 2026-04-26

## Outcome

PR **[#1172](https://github.com/zensgit/metasheet2/pull/1172)** —
`feat(approval): persist breach notification dedupe` — opened cleanly on
top of `origin/main = 58862b394` after #1171 merged.

| Field | Value |
|-------|-------|
| Branch | `codex/approval-sla-breach-notified-at-20260426` |
| Final HEAD | `845c2c9a4` |
| Commits ahead of main | 3 |
| State | BLOCKED / MERGEABLE (review-only gate) |

## Pipeline executed

This was the pre-staged plan from `ops-hygiene-c1c2c3-20260426.md`,
triggered the moment #1171 landed in main:

```bash
cd /tmp/ms2-breach-notified-at
git checkout -- plugins/ tools/ pnpm-lock.yaml
git fetch origin main
git rebase --onto origin/main 50179d9d7        # surgical (see below)
git push -u origin codex/approval-sla-breach-notified-at-20260426
gh pr create --base main \
  --head codex/approval-sla-breach-notified-at-20260426 \
  --title "feat(approval): persist breach notification dedupe" \
  --body-file /tmp/breach-notified-at-pr-body.md
```

## Surgical rebase rationale

A naive `git rebase origin/main` failed with conflicts on:

```text
AA docs/development/approval-sla-breach-notify-development-20260425.md
AA docs/development/approval-sla-breach-notify-verification-20260425.md
UU packages/core-backend/src/index.ts
```

Cause: the held branch was based on `50179d9d7` (the pre-rebase tip of
`codex/approval-sla-breach-notify-20260425` before #1171 was merged).
After #1171 was force-pushed twice (rebases) and finally squash-merged,
the squash commit on main carries `50179d9d7`'s content but a different
SHA. A naive rebase therefore tries to replay BOTH the parent PR's three
commits (`bcb519f62` / `190bedee5` / `50179d9d7`) AND the three follow-up
commits — and the parent commits collide with the squash-merged version
in main.

Fix: `git rebase --onto origin/main 50179d9d7` — restricts the replay
to commits in `50179d9d7..HEAD` (just the three follow-up commits),
skipping the parent PR's commits since they're already in main via the
squash.

```bash
# Before rebase:
d190de0e7 docs(approval): note no-channel retry warn behaviour for ops
3ffda7a1f docs(approval): note breach-notified-at index shape and bootstrap scope
1a50e045d feat(approval): persist breach notification dedupe
50179d9d7 (parent)

# After rebase:
845c2c9a4 docs(approval): note no-channel retry warn behaviour for ops
8cc8b911c docs(approval): note breach-notified-at index shape and bootstrap scope
735bd6eb9 feat(approval): persist breach notification dedupe
58862b394 (origin/main)
```

3 commits, byte-equivalent content to the originals, new parent pointers
on top of current main.

## Verification

### Pre-merge state (post-push)

```bash
gh pr view 1172 --json mergeStateStatus,mergeable,headRefOid
# → state=BLOCKED  mergeable=MERGEABLE  head=845c2c9a4d864ec1486d7a67f748dcac7bcc3270
```

`BLOCKED` here means `MERGEABLE` but blocked by `REVIEW_REQUIRED` (no
human approval yet) — same shape as #1170 / #1171 pre-merge.

### Codex local verification — 2026-04-26

After #1170 and #1171 merged into `origin/main = 58862b394`, Codex re-read
PR #1172 and ran a fresh local verification pass in
`/private/tmp/ms2-breach-notified-at` against PR head `845c2c9a4`:

```bash
git diff --check origin/main...HEAD
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-metrics-breach-notified-at.test.ts \
  tests/unit/approval-breach-notifier.test.ts \
  tests/unit/approval-sla-scheduler.test.ts \
  tests/unit/approval-metrics-service.test.ts \
  --reporter=verbose
gh pr checks 1172 --watch=false
```

Results:

- `git diff --check origin/main...HEAD` → exit 0.
- `tsc --noEmit` → exit 0.
- Focused + regression Vitest → 4 files / **45 tests passed**.
- GitHub checks → 12 passed, 1 expected skipped (`Strict E2E with
  Enhanced Gates`).

Codex review note: the PR #1172 implementation is the correct line to
ship. A separate local branch in the main working tree
(`codex/approval-breach-notified-persistence-20260426`) contains an older
alternative implementation with an untracked SQL migration under
`packages/core-backend/migrations/`; it was intentionally left untouched
and should not be used as the merge source for #1172.

### Test inheritance from agent run

The 30/30 test counts captured during agent implementation are still
valid because:

1. The rebase produced **zero textual conflicts** (`Successfully rebased
   and updated`); content of all three commits is byte-equivalent.
2. No file overlap between this branch's changes and the recently-merged
   PRs:
   - #1170 (M5) touched `routes/univer-meta.ts` + new
     `multitable/automation-service.ts` — disjoint from
     `services/Approval*`.
   - #1138 (OpenAPI) touched `packages/openapi/*` — disjoint.
   - #1139 (field visibility) touched
     `services/ApprovalProductService.ts` + frontend approval views —
     disjoint from `ApprovalMetricsService` / `ApprovalSlaScheduler` /
     `ApprovalBreachNotifier`.
   - #1129 (DingTalk) — disjoint.
   - #1171 (parent) merged squash — content already covered by the
     "Stack baseline" model.
3. CI will re-run on the new commits; expect green.

If CI surfaces any unexpected interaction, fix-forward via additional
commit on the same branch.

## Open PR queue

After this push:

| PR | Title | State |
|----|-------|-------|
| #1172 | feat(approval): persist breach notification dedupe | BLOCKED / MERGEABLE |

**Queue size: 1 PR.** Lowest queue depth in this session's history.

## What this closes

- **The held-stacked-PR pattern**: documented as
  `pr-queue-and-breach-notified-at-20260426.md` Action log; pre-staged in
  `ops-hygiene-c1c2c3-20260426.md`. Pre-staged → rebased → pushed → opened
  in 4 commands once the parent merged. Validates the "hold + pre-stage"
  approach for stacked follow-ups.
- **WP5 SLA observability semantic upgrade**: best-effort once →
  at-least-once with persistent retry. Operational caveat (warn noise on
  no-channel deployments) documented.
- **The post-#1171 follow-up surface is now PR-tracked**; no more local-
  only commits.

## Out of scope

- New product战线 — still locked per
  `integration-erp-platform-roadmap-20260425.md` 阶段一.
- `plugins/plugin-integration-core/*` — K3 PoC path preserved.
- Real SMTP transport — pending dep policy decision.
- Live DingTalk integration test — manual `curl` path still documented
  in the parent PR's verify MD.

## Roadmap-stage compliance

✅ no new战线 / ✅ no integration-core touch / ✅ no platform-化 work
/ ✅ pure follow-up of an already-shipped feature.

## Recommended next steps

1. **Wait for human review approval** on #1172.
2. Once #1172 merges → done with this thread; queue back to 0.
3. **Continue waiting for K3 PoC customer GATE answer** — the macro
   blocker.
4. **No new lanes** until either K3 PoC PASS is announced or a roadmap
   阶段二 trigger arrives.
