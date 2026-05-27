# Attendance Acceptance Smoke Harness — Consolidation & Decision Rules

One entry point for attendance acceptance/verification. It is **mostly decision rules and
disambiguators**, not procedures — the step-by-step lives in the existing runbooks (linked
below); this doc encodes the judgment that was learned the hard way so future acceptances need
less manual reasoning and avoid the specific mistakes that bit us.

**Auth surface:** the tools referenced here use only the local `gh` CLI or a JWT read from a
`0600` file. **No script in this harness reads a JWT/service token or puts a secret on a
command line.**

## Consolidation map (link, don't copy — these are the source of truth for procedure)

| Concern | Runbook / evidence (procedure) |
| --- | --- |
| Staging acceptance gate (JWT/auth/deploy gates → PUT cap → sync → verify → restore) | `docs/operations/attendance-comprehensive-hours-reporting-staging-acceptance-runbook.md` |
| Advanced-scheduling workbench (read-only, diagnostics, truncation §2.5) | `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` |
| Bundle-fingerprint heartbeat (prod, read-only) | `docs/development/attendance-pr5-prod-heartbeat-closeout-20260524.md` |
| Login/logout smoke (real-stack evidence) | `docs/development/attendance-comprehensive-hours-pr6-staging-acceptance-20260526.md` |
| Reporting V1 capability + limits | `docs/development/attendance-comprehensive-hours-reporting-closeout-20260525.md` |

## Decision rules (the actual increment)

### R1 — Token hygiene
- Keep the token in a `0600` file; never paste it into chat/tickets (the transcript persists — deleting the local file does **not** invalidate it; only **server-side rotation** does).
- Pass it via `curl -H @<header-file>`, built without the token touching `argv`:
  `{ printf 'Authorization: Bearer '; cat "$JWT"; } > /tmp/hdr && chmod 600 /tmp/hdr`
- Staging and prod use **distinct `JWT_SECRET`s** — a prod token returns `401 Invalid token` on staging (and vice-versa).
- After any exposure: rotate server-side, then confirm with the **old** token → `GET /api/auth/me` → expect `401`.

### R2 — Settings save/restore (restore from the SAVED ORIGINAL, never a hardcoded value)
- **Save the original settings first; that saved value is the source of truth for restore.** Do **not** assume the original is null/empty.
- A partial `PUT` deep-merges, so only assert what you changed (e.g. `month==600`) while confirming the other keys are **unchanged from the original**.
- Restore by `PUT`-ing the saved original back, then GET-compare equals the saved original.
- *Why:* a hardcoded `{month:null,…}` restore (the #1850 Codex BLOCK) silently wipes pre-existing caps while claiming "fully reversible."

### R3 — GitHub-infra flake vs genuine failure
- Many checks failing in **2–4 s** across **unrelated** suites = a shared pre-code step failure (Set up job / Checkout), almost always GitHub infra, not your change.
- Infra signatures are **context-bound** (a bare `HTTP 403` / `exit code 128` is *not* a signature — genuine auth/permission tests print those): action-CDN — `pnpm/action-setup` / `codeload.github.com` / "Download action repository" / "could not be found at the URI" / "Failed to download archive"; git checkout — "unable to access 'https://…github" (URL-bound 403) / "RPC failed; HTTP" / "/usr/bin/git' failed with exit code 128" / "fatal: expected 'packfile'".
- Tool: `scripts/ci/ci-flake-classify.sh <PR#> [--rerun]` — classify-only by default; exit `0` clear / `2` all-infra / `3` genuine. Re-run **only** when classified all-infra; bound retries (≤3 rounds) and **never merge red CI**.
- Fail-safe: a failure matching no infra signature is treated as **genuine** (never silently rerun).

### R4 — "Green-by-skip" detection (a green check can mean the suite never ran)
Before citing a green integration check as pass evidence, run this **3-point check** (any one true ⇒ the suite may be green by *skipping*, not passing):
1. Does the workflow step set `DATABASE_URL` / `ATTENDANCE_TEST_DATABASE_URL` in its env?
2. Is the command guarded by `|| true` (non-blocking)?
3. Does the test file early-return on `!baseUrl` / `!dbUrl` (a silent-skip shape, not a guard)?
- *Why:* #1861 found `plugin-tests.yml`'s integration step ran `test:integration || true` with no DB, so the attendance suite was green by skipping. #1867 made the skip **honest** (`describe.skip`, throw-not-return); #1872 wired a real postgres + `DATABASE_URL` + `test:integration:attendance` (no `|| true`) so it actually runs. The fixed end-state is the bar.

### R5 — Wire-vs-fixture / save-path drift
- A field added to a normalizer/object isn't "settable/persistable" until proven by a **route round-trip** (write via the real endpoint → read back), not a unit test on the normalizer. Check both the **request** validator (zod schema) and the **response** projection — either can silently strip a new field (#1829 zod-strip; #1781 `dayIndex` serialization-strip). See `[[skip-when-unreachable-blind-spot]]`.

## Triage flow: a PR's CI is red (copy-paste)

The most common need. Run from repo root; uses local `gh` auth only.

1. **Classify before rerun or merge.** Don't touch the PR yet:
   ```bash
   scripts/ci/ci-flake-classify.sh <PR#>
   ```
   It reads each failing job's log and prints a verdict + sets an exit code:
   - `0` CLEAR — no failing checks (re-check; it may have already settled)
   - `2` INFRA — every failure matches a known GitHub-infra signature → safe to rerun
   - `3` GENUINE — at least one real failure → open the failing job log and fix; **do not rerun blindly**
   - `1` usage / `gh` error
2. **If INFRA, rerun the failed jobs** (opt-in; only re-runs when all-infra):
   ```bash
   scripts/ci/ci-flake-classify.sh <PR#> --rerun
   ```
   Re-poll. If still INFRA after **≤3 rounds** (space them out so GitHub can recover), **stop and report** — don't keep hammering.
3. **Never admin-merge while CI is red** — even red-by-infra. Merge only after a genuinely green settle.
4. **Bounded auto-loop** (optional; chains on the exit code — `3`=genuine stops, `0`=green stops):
   ```bash
   for r in 1 2 3; do
     # `|| rc=$?` captures the 0/2/3 exit code without aborting under `set -e`.
     rc=0; scripts/ci/ci-flake-classify.sh <PR#> --rerun || rc=$?
     [ "$rc" = 0 ] && { echo "green"; break; }
     [ "$rc" = 3 ] && { echo "genuine failure — stop, do not merge"; break; }
     sleep 1500   # ~25m for GitHub infra to recover before the next round
   done
   ```

A failure whose log matches no infra signature (e.g. a real `HTTP 403` auth/permission test) is classified **GENUINE** — the tool never silently reruns a real failure.

## Reusable tooling

- `scripts/ci/ci-flake-classify.sh` — CI-flake classifier (R3; triage flow above). `gh`-only, read-only by default; `--rerun` opt-in and only acts when all failures are infra.
  - Matcher unit test: `scripts/ci/__tests__/ci-flake-classify.test.sh` (feeds recorded incident excerpts in `scripts/ci/__fixtures__/`; no live-CI dependency). Run: `bash scripts/ci/__tests__/ci-flake-classify.test.sh`.

## Boundaries

Read-only / diagnostic. No prod or staging writes from this harness. No new route, no migration, no `attendance_*` / `meta_*` write. Scripts use only local `gh` auth or a `0600` JWT file (R1).

## Cross-references

- `[[skip-when-unreachable-blind-spot]]` — the coverage blind-spot lessons R4/R5 distill.
- `[[staging-8082-jwt-and-deploy-lane]]` — staging preflight (distinct secret; deploy lane doesn't auto-mirror main).
- `[[review-auto-md]]`, `[[staged-opt-in-lineage]]`.
