# PR Rebase #1170/#1171 + Breach-Notified Ops Note — 2026-04-26

## Scope

Two parallel actions, single delivery doc:

- **A** — Mechanical rebase of #1170 (M5) and #1171 (Breach-Notify) onto
  `origin/main = df16ed84b` after #1137 merged. Both were BEHIND/MERGEABLE
  and dry-run-verified clean.
- **B** — Append "Operational Considerations" section to the held
  `breach_notified_at` branch's dev MD, capturing the new no-channel warn-
  noise behaviour introduced by the persistent retry semantic.

## Part A — #1170 + #1171 rebase

| PR | Theme | Pre-state | Old head | New head | Commits | Post-state |
|----|-------|-----------|----------|----------|---------|------------|
| **#1170** | Multitable M5 automation-service | BEHIND/MERGEABLE | `3559ed4e1` | `d6faba89d` | 1 | BLOCKED/MERGEABLE |
| **#1171** | Approval SLA breach notify | BEHIND/MERGEABLE | `50179d9d7` | `2b37450ed` | 3 | BLOCKED/MERGEABLE |

Both rebased cleanly (no conflicts), force-with-lease pushed.

### Method (per PR)

```bash
git fetch origin main codex/<branch> --quiet
git worktree add --detach /tmp/ms2-rebase-<N> origin/codex/<branch>
cd /tmp/ms2-rebase-<N>
git rebase origin/main
git push --force-with-lease=<branch>:<old-sha> origin HEAD:<branch>
git worktree remove /tmp/ms2-rebase-<N>
```

`--force-with-lease=<branch>:<old-sha>` is the safety variant — rejects
the push if the remote tip moved away from the expected old SHA. Used
the SHAs `3559ed4e1` and `50179d9d7` (the SHAs we last pushed before
#1137 landed).

### Verification

```bash
gh pr view 1170 --json mergeStateStatus,mergeable,headRefOid
# → state=BLOCKED  mergeable=MERGEABLE  head=d6faba89da0a6527709e2fed41684366152474c6

gh pr view 1171 --json mergeStateStatus,mergeable,headRefOid
# → state=BLOCKED  mergeable=MERGEABLE  head=2b37450ed52a22cc6b0c7768f038bcec66097a10
```

`BLOCKED` here means `MERGEABLE` but blocked by `REVIEW_REQUIRED` (no
human approval yet). Same state as the post-rebase #1129 / #1137. CI will
re-trigger on the new commits — both expected to remain green since the
rebases produced no conflicts (rebased commits' content is byte-equivalent
to pre-rebase content; only their parent pointers changed).

### Side-effects

- Both PR bodies unchanged (the "Follow-up branch ready" addendum on
  #1171 is preserved).
- Force-push diff is purely commit metadata (parent pointers); no source
  changes.
- Existing local worktrees `/tmp/ms2-m5-automation` and
  `/tmp/ms2-breach-notify` left at their pre-rebase SHAs — used detached
  worktrees so the user-facing local state stays predictable.

## Part B — Operational note on breach_notified_at branch

### What changed

Appended a new `## Operational Considerations` section between
`## Notifier Semantics` and `## Failure Behaviour` in
`docs/development/approval-sla-breach-notified-at-development-20260426.md`
on the held branch `codex/approval-sla-breach-notified-at-20260426`.

### Content

The section documents the new operational consequence introduced by the
persistent retry: when the notifier finds pending breaches but every
configured channel fails (or no channel is configured), it now logs a
warn-level entry **every scheduler tick** per pending instance. Under the
previous in-memory FIFO (PR #1171), the same instance was silently dropped
after one attempt — log noise was self-limiting.

Three deployment options are documented:

1. **Configure a real channel** (preferred) — set
   `APPROVAL_BREACH_DINGTALK_WEBHOOK` (+ optional
   `APPROVAL_BREACH_DINGTALK_SECRET`); first successful dispatch stamps
   `breach_notified_at` and stops the retry loop.
2. **Register a no-op stub channel** in code — silences the loop without
   sending anything; pair with cleanup job if permanent stamping is
   undesired.
3. **Leave `onBreach` unwired** — scheduler still flips `sla_breached`
   for newly detected breaches but skips the
   `listBreachesPendingNotification` lookup entirely. No retry, no warn
   noise. Backlog accumulates with `breach_notified_at IS NULL` so a
   future rollout picks up everything on first tick.

Recommended defaults: option 1 in production, option 3 in CI / dev /
staging where channels are not configured.

### Commit

```
d190de0e7 docs(approval): note no-channel retry warn behaviour for ops
```

Stack on the held branch:

```
d190de0e7 docs(approval): note no-channel retry warn behaviour for ops    ← new
3ffda7a1f docs(approval): note breach-notified-at index shape and bootstrap scope
1a50e045d feat(approval): persist breach notification dedupe
50179d9d7 (parent — pre-rebase tip of #1171; will be rebased after #1171 merges)
```

**Not pushed.** The branch remains held per queue-drain discipline; this
commit lands when the branch is opened as a PR after #1171 merges.

### Rationale for adding this note

Reviewer feedback after dry-run identified that the persistent-retry
semantic introduces operational noise that was absent in the parent PR.
The original dev MD documented the *correctness* upgrade (best-effort →
at-least-once) but not the *operational consequence* (log noise per tick
when channels are misconfigured). Future reviewers / operators will see
the constraint upfront rather than discovering it post-deploy.

## Updated PR queue state

After this work:

| PR | Theme | State | Notes |
|----|-------|-------|-------|
| #1170 | Multitable M5 automation-service | **BLOCKED/MERGEABLE** ✅ | Rebased, awaiting review |
| #1171 | Approval SLA breach notify | **BLOCKED/MERGEABLE** ✅ | Rebased, awaiting review |
| #1129 | DingTalk P4 closeout | **BLOCKED/MERGEABLE** ✅ | Rebased earlier, awaiting review |
| #1139 | Approval template field visibility | DIRTY (conflict) | Out of scope — needs design call |
| #1138 | OpenAPI approval contracts | DIRTY (conflict) | Out of scope — needs design call |
| (held) | breach_notified_at follow-up | local-only | +1 ops note commit; opens after #1171 merges |

3 PRs are mergeable + waiting on human review approval; 2 PRs need
conflict resolution that involves design judgment; 1 stacked branch is
held until parent merges.

## Recommended next steps

1. **Wait for human review approval** on #1170 / #1171 / #1129.
2. Once #1171 merges → push the held `breach_notified_at` branch:
   - clean dep-symlink drift (`git checkout -- plugins/ tools/ pnpm-lock.yaml`)
   - rebase onto `origin/main`
   - `git push -u origin codex/approval-sla-breach-notified-at-20260426`
   - `gh pr create --base main` with body referencing this MD + the
     branch-local dev/verification MDs.
3. **Continue waiting for K3 PoC customer GATE answer** (the macro
   blocker, unchanged).
4. **No new lanes**, **no premature DIRTY-PR conflict resolution**.

## Roadmap-stage compliance

All actions in this slice respect
`integration-erp-platform-roadmap-20260425.md` 阶段一约束:

- ✅ no new战线 opened
- ✅ no `plugins/plugin-integration-core/*` touched
- ✅ no platform-化 work started
- ✅ pure queue maintenance + documentation hygiene
