# POC Preflight Checklist

Status: adopted 2026-04-20 based on the Yjs internal rollout trial.

## Why this document exists

The Yjs POC went through **6 rounds of design review, 25+ unit tests, a
full rollout packet, and a gate script** before anyone actually sat down
and tried to use it. When we finally ran it against real staging:

- The frontend editor was not wired to `/yjs` at all — 10 minutes of
  human editing produced zero Yjs activity on the server.
- The backend had a `stale observer` P1 bug that made every
  second-and-later subscription silently drop edits.

Both would have shipped. Neither was caught by the review process.

The conclusion is simple and we should not re-learn it: **review is
not validation**. A single end-to-end run against a real environment
is worth more than another review round.

This checklist is the minimum bar a POC must clear before it can be
called "validated".

## The preflight checklist

Before declaring any POC "ready for rollout" or "verified":

### 1. End-to-end real run — not just unit tests

- [ ] The feature has been exercised on a real deployed environment
  (staging or better), not just locally or in tests.
- [ ] The exercise used the product's actual entry point (browser UI,
  public API, CLI — whatever users will use), not just a direct call
  to the service under test.
- [ ] There is a recorded artifact of this run (log, screenshot, JSON
  dump) committed to the repo.

If the feature cannot be exercised end-to-end yet (frontend not wired,
tenant data missing, etc.) this is **not** a reason to skip the check.
It is a finding that belongs in the verification report.

### 2. Frontend wiring audit — did anything in the UI call this

- [ ] `grep` / `ripgrep` the frontend for the feature's entry symbols
  (hooks, composables, API methods).
- [ ] Confirm at least one real component calls them in a user-facing
  flow. `export` is not the same as `import`.
- [ ] If the frontend only exports and nothing consumes, **say so
  explicitly** in the verification report. Do not claim "validated".

### 3. Warm and cold state — both

POCs that only test cold state routinely ship bugs in warm paths.
For any feature that caches, persists, or reuses instances:

- [ ] Test the cold path: first request, first subscribe, first edit.
- [ ] Test the warm path: second+ request against the same cached /
  reloaded / reconnected state.
- [ ] Test the cold-again path: force release / restart, then warm
  again. Confirms cleanup and re-init are idempotent.

This is where the Yjs stale-observer bug was hiding. Cold-then-warm is
a 5-minute test and it catches a whole class of lifecycle bugs.

### 4. Scope parity — admin vs user

- [ ] If you used an admin token to verify, verify again (or at least
  spot check) under the user scope real users will have.
- [ ] Confirm multi-tenant / RBAC isolation works the way you expect.
  "I can see it with the admin token" does not mean your user can.
- [ ] Check that records your admin token can patch are actually
  visible in the target user's browser view.

The Yjs trial burned 15 minutes on this: admin-API records were not
visible to the browser session, so cross-tool comparisons failed.

### 5. Observability hooked up

- [ ] There is an admin or ops endpoint that returns the feature's
  runtime state (counts, errors, queues).
- [ ] A scripted check of that endpoint has been run and committed
  (like `check-yjs-rollout-status.mjs` for Yjs).
- [ ] Metrics that *should* move under load have been confirmed to
  actually move. "Zero activity" is a valid signal — investigate it
  before declaring green.

The Yjs trial would have declared success if we hadn't looked at
`activeDocCount` staying at 0.

### 6. Review is not sign-off

- [ ] Design docs reviewed ≠ feature verified.
- [ ] Green unit tests ≠ feature verified.
- [ ] Merged PR ≠ feature verified.
- [ ] Only steps 1–5 above, executed against real infra, count as
  verification.

### 7. Named artifact location

Every POC must commit, under a predictable path:

- [ ] `docs/operations/<feature>-trial-verification-<date>.md`
  — honest summary of what was run, what worked, what didn't.
- [ ] `scripts/ops/<feature>-validation/` (or similar)
  — the actual script(s) used, so the verification is reproducible.
- [ ] `output/<feature>/<date>/` (optional, if artifacts are small)
  — logs, poll dumps, snapshots.

If a future person cannot rerun the verification from these artifacts
alone, the verification is not complete.

## When to apply this

- Before merging any PR with "POC validated" or "rollout ready" in the
  title or description.
- Before setting a feature flag to on in any shared environment.
- Before marking a rollout milestone as done (packet, gate, advance,
  promote — none of these are meaningful without the preflight).

## When to *not* apply this

- Pure internal refactors that have no runtime-visible surface.
- Documentation-only changes.
- Small bug fixes already covered by an added regression test (the
  test itself is the verification artifact).

## Meta

If a POC passes this checklist and still ships a bug, update this
document with the new lesson. The checklist is explicitly allowed to
grow; review-and-remove rounds should only prune items that have
been superseded by a tool or a hook that makes the human check
unnecessary.
