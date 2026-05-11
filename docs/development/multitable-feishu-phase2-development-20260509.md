# Multitable Feishu Phase 2 Planning · Development

> Date: 2026-05-09
> Branch: `codex/multitable-feishu-phase2-plan-20260509`
> Baseline: `origin/main@c74c15a2b`; refreshed against `origin/main@3a484622c`
> Scope: docs-only execution plan for post-RC multitable development

## Context

The multitable RC line is closed at `multitable-rc-20260508b-08c6036284`, and PR #1446 archived the final RC evidence plus the UI smoke wrapper. Continuing from the older `multitable-feishu-three-lane-claude-execution-plan-20260507.md` would be incorrect because several planned items have since landed:

- `autoNumber` and its hardening are already implemented.
- Gantt dependency arrows, self-table validation, and staging UI smoke passed.
- Hierarchy drag reparent and cycle prevention are implemented.
- The RC smoke suite is complete and archived.

This slice creates a fresh Phase 2 plan for product development after RC sign-off.

Update on 2026-05-11: before merging this planning PR, the branch was rebased
onto `origin/main@3a484622c`. Lane C's core grid bulk edit work has already
landed through PR #1451 and PR #1456, so the plan now treats Lane C as complete
except for optional UX follow-up.

## Local State Considerations

The root checkout is currently not a safe implementation base:

- It is on `codex/integration-k3wise-live-gate-rehearsal-fixups-20260509`.
- The remote tracking branch is gone.
- It contains unrelated untracked docs and `.claude/`.

For that reason this planning slice was created in a clean worktree:

```bash
git worktree add -b codex/multitable-feishu-phase2-plan-20260509 \
  /private/tmp/ms2-feishu-phase2-plan-20260509 origin/main
```

## What Changed

Added the Phase 2 TODO document:

- `docs/development/multitable-feishu-phase2-todo-20260509.md`

Added this development record:

- `docs/development/multitable-feishu-phase2-development-20260509.md`

Added the verification record:

- `docs/development/multitable-feishu-phase2-verification-20260509.md`

No source code, migrations, OpenAPI generated outputs, package scripts, or runtime behavior were changed.

## Planning Decisions

### Decision 1 - Treat RC as closed

The next workstream should not reopen RC smoke scope unless staging produces a regression. Phase 2 should add product value beyond RC sign-off.

### Decision 2 - Pick three file-bounded lanes

The selected lanes are:

| Lane | Theme | Why now |
|---|---|---|
| A | `longText` field | High-frequency Feishu parity gap; small enough to ship quickly. |
| B | real email transport gate | RC `send_email` only proved mock delivery; real transport needs secret-safe gates. |
| C | grid bulk edit | Completed after this plan was drafted through #1451 and #1456; keep only optional polish follow-up. |

### Decision 3 - Keep AI, rich text, and marketplace out of this phase

These are larger product bets and should not be mixed with the first post-RC development wave.

### Decision 4 - Split email into B1 and B2

Email is security-sensitive. The first PR should add an env-gated readiness seam and redacted verification. Actual SMTP/provider delivery should wait until dependency and operations policy are clear.

### Decision 5 - Let Claude implement broad UI lanes, keep Codex on review/security

Claude can move faster on Lane A and Lane C. Codex should own or closely review Lane B because it touches credentials, logs, staging gates, and failure handling.

## File Boundary Summary

Lane A will likely touch field codecs, field config/display utilities, cell editor/renderer, form/drawer behavior, OpenAPI, and focused field tests.

Lane B will likely touch `NotificationService`, automation executor/service validation, release-gate scripts, and redaction tests.

Lane C has landed through #1451 and #1456. Optional follow-up should be limited
to UX polish, such as a richer per-row failure table, rather than reopening the
core bulk edit write path.

No lane is expected to touch:

- `plugins/plugin-integration-core/*`
- K3 WISE PoC scripts
- DingTalk OAuth/public-form auth policy
- Deployment compose files

## Handoff Instructions for Claude

Start with Lane A only if worktrees are clean:

```bash
git worktree add -b codex/multitable-phase2-long-text-field-20260509 \
  /private/tmp/ms2-phase2-longtext-20260509 origin/main
```

Do not start Lane B2 until B1 exists and the email dependency choice is explicit.

Every PR must include:

- Development MD
- Verification MD
- Focused test output
- Secret/leak scan if it handles credentials or email

## Expected PR Order

1. Lane C grid bulk edit - done through #1451 and #1456.
2. Lane A `longText`.
3. Lane B1 email readiness/gate.
4. Lane B2 real SMTP/provider transport, if approved.

Lane A and Lane B1 can be developed in parallel because their file boundaries
are mostly disjoint. Do not start B2 until B1 lands and the transport dependency
choice is explicit.
