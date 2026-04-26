# Memory Update — Session Learnings — 2026-04-26

## Scope

Three new memories saved to the auto-memory system, capturing operational
patterns surfaced during the 2026-04-25/26 wave cycles. These compound
across future sessions: any future Claude session in this project will
load these on startup via `MEMORY.md` index.

## Memories added (3)

| File | Type | Hook |
|------|------|------|
| `feedback_stacked_pr_rebase_after_squash.md` | feedback | Use `git rebase --onto origin/main <old-parent-tip>` after parent squash-merge; naive rebase causes AA/UU collisions |
| `feedback_channel_env_gating.md` | feedback | Optional notification channels register only when env configured; default-registration → per-tick warn noise under at-least-once retry |
| `project_k3_poc_stage1_lock.md` | project | Roadmap阶段一锁定 — until K3 PoC customer GATE PASS, no new战线 / no integration-core touch; 内核打磨 permitted |

## M1 — Stacked-PR rebase after squash-merge (feedback)

**Source incident**: 2026-04-26, rebasing `breach_notified_at` follow-up
after PR #1171 squash-merged. Naive `git rebase origin/main` failed with
`AA` (added in both) and `UU` (modified in both) conflicts on the
parent's docs and `src/index.ts`.

**Pattern**: squash-merge produces ONE new commit on main with content
equal to the parent branch's tip but a different SHA. Naive rebase
replays both parent and child commits onto main; parent commits collide
with the squash version.

**Solution**: `git rebase --onto origin/main <old-parent-tip>` —
restricts the replay to commits in `<old-parent-tip>..HEAD` (the child's
unique commits), skipping the parent's individual commits since they're
already in main via the squash.

**Verified by**: `git log --oneline origin/main..HEAD` should show only
the child's unique commits, byte-equivalent to pre-rebase, on top of
current main.

## M2 — Env-gate side-effect channels (feedback)

**Source incident**: PR #1171 dry-run review (2026-04-25) caught the
original `ApprovalBreachNotifier` default-registering DingTalk + email-
stub channels regardless of env config. Reinforced when PR #1172 (2026-
04-26) elevated semantics to at-least-once with persistent retry —
default-registered always-failing channels then produce per-tick warn
noise per pending instance.

**Pattern**: any optional notification or side-effect channel (DingTalk,
email, Slack, generic webhook) must register **only when env vars are
configured**. Don't push a "no-op" channel that always returns failure
into the channel list.

**Documentation requirement**: dev MD must include "Operational
Considerations" section listing (a) which env vars enable each channel,
(b) what happens when none configured (e.g., scheduler still flips state
but skips dispatch), (c) the no-op-stub / unwire-callback alternatives.

**Corrective commit**: `792538fcd fix(approval): gate breach notify channels by env`.

## M3 — K3 PoC Stage 1 lock (project)

**Source**: `docs/development/integration-erp-platform-roadmap-20260425.md`
explicitly states: 「阶段一锁定不开新战线; 任何 K3 之外的工作必须等
PoC PASS 才启动」 and 「客户答卷与平台化路线解耦：阶段一可同步做内核
打磨（不动 K3 PoC 路径），但不投入平台化代码」.

**Constraint**: Until customer GATE PASSes, blocked are:
- Any touch of `plugins/plugin-integration-core/*` (K3 PoC path)
- Any touch of `lib/adapters/k3-wise-*.cjs` or PoC scripts (unless the
  change IS the PoC path)
- Any new product surface (Phase 1A workspace shell, vendor profile
  registry, schema catalog, adapter builder, marketplace, multi-tenant
  SaaS) — these are阶段三/阶段四 items

**Permitted**:
- Follow-ups to already-merged features
- Continuing multi-wave decomposition themes already in flight (e.g.,
  M0..M5 multitable extraction)
- Pure operational hygiene
- 内核打磨 on shipped features (observability, leader-lock, retry
  semantics)

**Lift conditions**: (a) user announces customer GATE PASSED, or (b)
explicit "打破阶段一约束" (push back once before agreeing).

**Why it matters**: roadmap names "过度工程" as the #1 risk. The 4-stage
path (PoC → 抽离+第2家ERP → 平台化基建 → Marketplace+SaaS) is
sequential; bypassing阶段一 commits sunk cost prematurely. Reaffirmed
multiple times during 2026-04-26 wave 9 → 10 cycles when temptation to
open new lanes arose.

## Verification

```bash
ls -la /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/memory/
# Confirms 3 new files present:
#   feedback_stacked_pr_rebase_after_squash.md
#   feedback_channel_env_gating.md
#   project_k3_poc_stage1_lock.md

cat /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/memory/MEMORY.md | wc -l
# Index now has 9 lines (was 6) — 3 new entries appended.
```

The new files conform to the auto-memory frontmatter convention
(`name`, `description`, `type`) and the `**Why:**` / `**How to apply:**`
structure for feedback/project memories per the Auto Memory system
guidelines.

## Why these and not others

Considered candidates from this session:

- ✅ **Stacked-PR rebase pattern** — saved (M1). Saved real time today;
  will save more in future stacked-PR scenarios.
- ✅ **Env-gating channels** — saved (M2). The gap was caught only in
  review; future agent runs will pre-empt.
- ✅ **K3 PoC stage 1 lock** — saved (M3). Most-asserted constraint in
  this session; multiple "建议是？" rounds where I had to re-justify
  this stance.
- ⏸️ **Force-with-lease + detached worktree pattern** — already implicit
  in the existing `feedback_branch_convention.md`; not promoted to its
  own memory.
- ⏸️ **Pre-stage stacked PR body before parent merges** — useful but
  niche; situation-specific to held-stacked-branch workflow. May save if
  it recurs.
- ⏸️ **Squash-merge convention for the team** — the project repo uses
  squash-merge per branch protection; already in code conventions.
- ⏸️ **Worktree cleanup pattern** — pure ops; standard practice; doesn't
  warrant memory.

## Roadmap-stage compliance

✅ no new战线 / ✅ no integration-core touch / ✅ no platform-化 work
/ ✅ purely captures session learnings into durable memory.

## Recommended next steps

1. **Wait for human review approval** on #1172 (the only open PR).
2. **Continue waiting for K3 PoC customer GATE answer** — the macro
   blocker, unchanged.
3. **No new lanes** until either K3 PoC PASS announced or user
   explicitly invokes "打破阶段一约束" (push back once before agreeing).

The PR queue is at the lowest depth of the session (1 PR). The
breach_notified_at follow-up is now PR-tracked. Memory is current.
This is a natural pause point.
