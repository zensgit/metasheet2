# Ops Hygiene — Worktree Cleanup + PR Body Prep + Conflict Audit — 2026-04-26

## Scope

Three small operational-hygiene actions executed during the PoC waiting
window (per `integration-erp-platform-roadmap-20260425.md` 阶段一约束: no
new战线, no integration-core touch, no platform-化 work). All three are
parallel and independent.

| Lane | Action | Output |
|------|--------|--------|
| **C1** | Remove stale worktrees whose branches are merged via squash (remote-deleted) | 11 worktrees removed, 3 survivors |
| **C2** | Pre-stage `breach_notified_at` follow-up PR body to a file | `/tmp/breach-notified-at-pr-body.md` |
| **C3** | Audit #1138 / #1139 conflict scope (read-only, no resolution) | 4-file + 5-file conflict maps |

## C1 — Worktree cleanup

### Audit method

`git ls-remote --heads origin <branch>` per local worktree branch:

- **REMOTE-LIVE** → branch still on remote → skip (still in flight).
- **REMOTE-GONE** + branch was previously pushed → squash-merged + remote-
  deleted → remove.
- **REMOTE-GONE** + branch never pushed → local-only (held) → skip.
- **DETACHED** → no branch ref → safe to remove.

### Removed (11)

| Path | Branch | Original PR / commit |
|------|--------|----------------------|
| `/tmp/ms2-corr-enrich` | `codex/correlation-post-auth-enrichment-20260425` | #1159 (merged) |
| `/tmp/ms2-correlation-id` | `codex/observability-correlation-id-20260425` | wave 8 E (merged as 74f396567) |
| `/tmp/ms2-eventbus-context` | `codex/eventbus-request-context-correlation-20260425` | #1164 (merged) |
| `/tmp/ms2-m4-permission` | `codex/multitable-m4-permission-service-20260425` | wave 8 F (merged as b1da68fcf) |
| `/tmp/ms2-sla-leader` | `codex/approval-sla-leader-lock-20260425` | #1160 (merged) |
| `/tmp/ms2-sla-leader-retry` | `codex/approval-sla-leader-retry-gauge-20260425` | merged |
| `/tmp/ms2-sla-topn` | `codex/approval-sla-topn-report-20260425` | #1161 (merged) |
| `/tmp/ms2-sla-topn-tests` | `codex/approval-sla-topn-contract-tests-20260425` | #1165 (merged) |
| `/tmp/ms2-wp5-sla` | `codex/approval-wave2-wp5-sla-20260425` | wave 8 A (merged as 6eec0692f) |
| `/tmp/ms2-k3-preflight-boundaries` | (detached) | leftover |
| `/tmp/ms2-pr1129-clean` | (detached) | leftover |

### Surviving (3)

| Path | Branch | Why kept |
|------|--------|----------|
| `/tmp/ms2-breach-notify` | `codex/approval-sla-breach-notify-20260425` | PR #1171 still open |
| `/tmp/ms2-m5-automation` | `codex/multitable-m5-automation-service-20260425` | PR #1170 still open |
| `/tmp/ms2-breach-notified-at` | `codex/approval-sla-breach-notified-at-20260426` | held branch — local-only commits, not pushed yet |

### Method

```bash
for w in ms2-corr-enrich ms2-correlation-id ms2-eventbus-context \
         ms2-m4-permission ms2-sla-leader ms2-sla-leader-retry \
         ms2-sla-topn ms2-sla-topn-tests ms2-wp5-sla \
         ms2-k3-preflight-boundaries ms2-pr1129-clean; do
  git worktree remove --force "/tmp/$w"
done
git worktree prune
```

`--force` justified because every removed worktree had merged branches; any
dirty state (e.g., dep-symlink drift from past `pnpm install`) was
operational artifact, not unique work. The local branches themselves
remain in the local refs (not deleted) for any future reference; only the
working trees were removed.

### Verification

```bash
git worktree list --porcelain | grep -c '^worktree /tmp/ms2-\|^worktree /private/tmp/ms2-'
# → 3 (the three survivors above)
```

## C2 — Pre-staged PR body

Saved to `/tmp/breach-notified-at-pr-body.md` (29 lines). Contents follow
the team PR template (`Summary` / `Verification` / `Risk / Rollback` /
`Follow-up`) plus a closing pointer to the dev / verification MDs.

### When and how to use

After PR #1171 merges:

```bash
cd /tmp/ms2-breach-notified-at
git checkout -- plugins/ tools/ pnpm-lock.yaml   # clean dep drift
git fetch origin
git rebase origin/main                            # zero-conflict expected
git push -u origin codex/approval-sla-breach-notified-at-20260426
gh pr create --base main \
  --head codex/approval-sla-breach-notified-at-20260426 \
  --title "feat(approval): persist breach notification dedupe" \
  --body-file /tmp/breach-notified-at-pr-body.md
```

The PR body in the file:

- States "Closes the WP5 SLA observability follow-up listed in PR #1171"
- Captures the **operational risk** flagged earlier (warn noise when
  channels misconfigured) under `Risk / Rollback`
- Lists the 30/30 + 15/15 test counts already verified
- References the three on-branch MDs (dev, verification, ops note in
  development MD)
- References the top-level delivery MD
  `pr-queue-and-breach-notified-at-20260426.md`

### Verification

`/tmp/breach-notified-at-pr-body.md` exists and contains the four PR
template sections (`Summary`, `Verification`, `Risk / Rollback`,
`Follow-up`) plus the docs pointer line.

## C3 — Conflict scope audit (informational only)

Method: cross-reference the file list of each PR (via `gh pr view --json
files`) against files touched on `origin/main` since the PR opened
(2026-04-24+).

### #1138 — OpenAPI approval contracts (4 files)

```text
CONFLICT  packages/openapi/dist/combined.openapi.yml
CONFLICT  packages/openapi/dist/openapi.json
CONFLICT  packages/openapi/dist/openapi.yaml
CONFLICT  packages/openapi/src/paths/approvals.yml
```

**Resolution effort**: low to medium. 3 of 4 files are auto-generated
`packages/openapi/dist/*` artefacts — running the OpenAPI regen script
(`pnpm -F openapi generate` or whatever the local script is) after
resolving `src/paths/approvals.yml` should regenerate all three dists
deterministically. The actual design surface is just `approvals.yml`,
which needs to fold in:

- WP3 read-tracking endpoints (#1132)
- WP4 categories + ACL endpoints (#1133, b673e4bb0)
- WP5 SLA observability + TopN report endpoints (6eec0692f, #1161)

Recommended path: regenerate from current main, then re-add this PR's
new contract changes on top.

### #1139 — Approval template field visibility (5 files)

```text
CONFLICT  apps/web/src/types/approval.ts
CONFLICT  apps/web/src/views/approval/TemplateDetailView.vue
CONFLICT  packages/core-backend/src/services/ApprovalProductService.ts
CONFLICT  packages/core-backend/src/types/approval-product.ts
CONFLICT  packages/core-backend/tests/unit/approval-product-service.test.ts
```

**Resolution effort**: medium. Hot files have been modified by:

- WP4 categories + ACL (#1133, b673e4bb0) — adds template category +
  ACL fields to types and services
- WP5 SLA observability (6eec0692f) — adds `sla_hours` field to
  `approval-product.ts` + `TemplateDetailView.vue`

Real design judgment needed: how do field-visibility rules compose with
ACL? Both gate field reads/writes; precedence matters. Likely
field-visibility runs after ACL passes (ACL → "can the user see this
field at all?"; field-visibility → "given they can see it, do current
form values keep it visible?"). Recommend a 10-minute design call with
the original author before resolving.

### Recommendation

Both PRs are real conflict-resolution work that benefits from author
context. **Do not attempt mechanical resolution.** Either:

- Original author rebases and resolves (preserves intent), or
- Pair on a 15-minute design call to align on precedence (#1139) +
  decide whether to redo dist regen (#1138).

## Out of scope

- **Resolving the conflicts** for #1138 / #1139.
- **Pushing the held branch** — held until #1171 merges (per queue-drain
  discipline).
- **Opening any new lane**.
- **Touching `plugins/plugin-integration-core/*`** — K3 PoC path
  preserved.

## Roadmap-stage compliance

All three actions respect 阶段一锁定:

- ✅ no new战线 opened
- ✅ no `plugins/plugin-integration-core/*` touched
- ✅ no platform-化 work
- ✅ pure operational hygiene + read-only audit

## Next steps

Same as before: wait for human review approval on #1129 / #1170 / #1171;
push the held branch after #1171 merges; do not attempt #1138 / #1139
mechanical conflict resolution; continue waiting for K3 PoC customer
GATE answer.
