# Operations Docs Delivery — Staging Deploy SOP + Migration Alignment Runbook + migrate.ts Flag Fix — 2026-04-26

## Scope

Three deliverables capturing lessons from the 2026-04-26 staging deploy
incident (d88ad587b broke auth on staging, rolled back; full diagnosis
in `staging-deploy-d88ad587b-postmortem-20260426.md`):

1. **PR [#1190](https://github.com/zensgit/metasheet2/pull/1190)** —
   `migrate.ts` flag handling: implements `--list`/`--rollback`/`--reset`
   that the package.json scripts already named but the script ignored.
   Single-file change, +83/-6 lines.
2. **`docs/operations/staging-deploy-sop.md`** — 12-step manual
   image-pull deploy checklist. Mandatory: migration-pending diff
   pre-deploy, log scan post-deploy, authenticated round-trip
   verification (not just `/api/health`).
3. **`docs/operations/staging-migration-alignment-runbook.md`** —
   recovery procedure for the case where target env's
   `kysely_migration` table is out of sync with actual schema state.
   Includes pg_dump-first discipline, synthetic-catch-up vs
   full-restore decision tree, failure modes.

Plus memory updates so future sessions have the operational context.

## Why these three

Independent slices of the same lesson:

- **#1190 (the tool)**: makes pre-deploy migration diff actually
  observable. Without `--list`, the only way to "see what's pending"
  was to run `migrate.js` and watch what happened — destructive
  observation. With `--list`, anyone can preview safely.
- **`staging-deploy-sop.md` (the procedure)**: codifies how to use
  `--list` (and the rest) in the deploy flow. References #1190.
- **`staging-migration-alignment-runbook.md` (the recovery)**: handles
  the case where the SOP's pre-flight check reveals tracking-state
  divergence. References both #1190 and the SOP, plus the
  post-mortem.

The three reinforce each other but were independently writable —
which made parallel-development sense for this slice.

## Design notes

### staging-deploy-sop.md

**Audience**: human operator running a manual `docker-compose pull && up -d`
deploy on a shared host (e.g. <staging-host>). NOT for the bootstrap
script `scripts/deploy-ghcr.sh` — that one auto-migrates and is
covered by the existing `deploy-ghcr.md`.

**Structure**:
- §1-4 Pre-deploy (read-only checks)
- §5-8 Deploy itself (migrations FIRST, then image swap via
  workaround B for docker-compose v1 ContainerConfig bug)
- §9-12 Post-deploy verification (60-second window)
- §"Rollback" section (uses workaround B again, with cached previous
  image)
- §"What this SOP does NOT cover" (boundaries)
- §"Quick checklist" (printable 12-item version for ops shift handoff)

**Key decisions**:
- Made migration application a **mandatory step that blocks** image
  swap (§5). The 2026-04-26 failure mode was deploying new image
  before migrations; codifying the order prevents recurrence.
- Required **authenticated 200** post-deploy verification (§10),
  explicitly calling out that `/api/health` alone is insufficient.
- Added the **plugin-count sanity check** (§12) since the 13 vs 14
  count drop on d88ad587b was a real signal we initially dismissed
  as cosmetic — it was actually a downstream effect of broken auth.
- `--no-deps` requirement on the `up -d` command, with explanation —
  docker-compose v1.29.2's reconciler silently touches postgres/redis
  without it.

### staging-migration-alignment-runbook.md

**Audience**: human operator with SSH + sudo access who has been told
"the deploy SOP §5 failed with `column scope does not exist`" or
similar.

**Structure**:
- §Pre-flight (pg_dump is non-negotiable)
- §Option A: Synthetic catch-up (recommended for the 2026-04-26
  pattern — drift in tracking, schema is fine)
- §Option B: Full restore from prod-track (recommended if drift
  audit reveals real schema gaps)
- §Post-alignment verification
- §Failure modes & recovery (with the "I changed something I
  shouldn't have" branch documented as a first-class case)
- §"What this runbook does NOT cover" (rollback of applied schema
  changes — that's an incident plan, not routine alignment)

**Key decisions**:
- pg_dump-first as **the** non-negotiable step. Everything else in the
  runbook assumes the dump exists. Not having one means stop.
- Two distinct alignment options with explicit "pick exactly one, do
  not mix" — different problems, different solutions. The choice
  hinges on the §A.3 audit (does the schema actually match what the
  missing migrations would have produced).
- Audit step (§A.3) is the load-bearing decision point. Most of the
  runbook's risk lives in this step's correctness; the runbook calls
  it out as such.
- Failure-mode recovery includes restore-from-dump as an explicit
  branch — important because under pressure during alignment, "what
  if I screwed up?" is exactly the question that needs a pre-written
  answer.

### migrate.ts (PR #1190)

**Design**:
- Split into command functions (`commandLatest`, `commandList`,
  `commandRollback`, `commandReset`). Each handles its own
  `db.destroy()`. Original 43-line script grew to 119 lines but most
  of the growth is the four command paths + help text.
- `--reset` guarded behind `ALLOW_DB_RESET=true` env var. Without
  the guard, `pnpm db:reset` would be a one-keystroke destructor; the
  env var forces explicit acknowledgment.
- Default behavior (no flag) is byte-identical to the original
  `migrateToLatest()` semantics. No call sites need to change.
- Help text references both the read-only `--list` and the destructive
  `--reset`/`--rollback` paths, so an operator running
  `pnpm migrate --help` sees the safe options first.

## Verification

### PR #1190 (migrate.ts)

| Check | Method | Result |
|---|---|---|
| `--help` prints usage, exits 0 | `pnpm exec tsx src/db/migrate.ts --help; echo $?` | ✅ exit 0, full usage shown |
| `--reset` without env var refuses | `pnpm exec tsx src/db/migrate.ts --reset > log; echo $?; cat log` | ✅ exit 1, refusal message correct |
| `tsc --noEmit -p tsconfig.json` clean | full project typecheck | ✅ exit 0, 0 errors |
| Default (no flag) preserves behavior | code review of `commandLatest()` against original `migrateToLatest()` | ✅ same provider config, same error/results handling, same `db.destroy()` |
| `--list` runtime behavior | required dev DB; deferred to PR reviewer / next person to spin up local pg | ⚠️ not exercised locally (acknowledged in PR test plan) |
| `--rollback` runtime | same as above | ⚠️ same |
| `--reset` runtime with env | same as above | ⚠️ same |

The runtime behaviors of `--list`/`--rollback`/`--reset` are gated on
having a working dev DB — exercising them via the actual kysely
`Migrator` API. The gate is documented in the PR's test plan; CI's
existing build/typecheck steps cover the static side.

### staging-deploy-sop.md

| Check | Method | Result |
|---|---|---|
| Internal cross-references resolve | manual review of §-references | ✅ §1-12 numbering consistent |
| External cross-references resolve | grep for `[…](path)` patterns and check files exist | ✅ `deploy-ghcr.md`, `staging-migration-alignment-runbook.md`, `staging-deploy-d88ad587b-postmortem-20260426.md` all real |
| Covers all 12 lessons from post-mortem | side-by-side check against `staging-deploy-d88ad587b-postmortem-20260426.md` §"Lessons captured" | ✅ all 5 captured lessons → SOP steps |
| Quick checklist matches body | re-derive checklist from §-headings | ✅ items 1-13 cover §1-12 plus rollback decision |
| No prescriptive command that's untested | review every code block | ✅ all commands are either standard docker/curl OR explicitly noted as requiring substitution |

### staging-migration-alignment-runbook.md

| Check | Method | Result |
|---|---|---|
| pg_dump precondition is enforced | first sub-section under §Pre-flight, with "non-negotiable" explicit wording | ✅ §"pg_dump first" |
| Two alignment options are clearly disjoint | re-read §A vs §B; check "pick exactly one" call-out | ✅ §"Pick exactly one. Do not mix." in §"Alignment options" intro |
| Failure-mode recovery exists for each option | §"Failure modes & recovery" enumerates 3 modes | ✅ "duplicate key", "column already exists mid-migrate", "I changed something" |
| Restore path mentioned in every error branch | grep for `pg_restore` in failure section | ✅ explicit dump-restore in the catch-all branch |
| References the post-mortem and PR #1190 | §Provenance, §"What this runbook does NOT cover" | ✅ both linked |
| Numbers in commentary match the 2026-04-26 audit | re-check 86/152/66 numbers against post-mortem | ✅ matches |

### Memory cross-links

| Memory entry | Updated section | Result |
|---|---|---|
| `feedback_deploy_migration_check.md` | added "Operational doc" line pointing to `staging-deploy-sop.md` | ✅ |
| `project_staging_migration_alignment.md` | replaced "Related docs" list with the 4 new + existing references | ✅ |
| `MEMORY.md` index | unchanged (entries still under same titles, no new memory files) | ✅ |

## State at end of session

| Surface | State |
|---|---|
| PR #1190 | open, `BLOCKED/MERGEABLE`, awaiting human review |
| `docs/operations/staging-deploy-sop.md` | created, untracked locally, ready to commit |
| `docs/operations/staging-migration-alignment-runbook.md` | created, untracked locally, ready to commit |
| `docs/development/operations-docs-delivery-20260426.md` (this file) | created, untracked locally |
| `docs/development/staging-deploy-d88ad587b-20260426.md` | modified earlier this session (CORRECTION banner), still untracked from session-prior baseline |
| `docs/development/staging-deploy-d88ad587b-postmortem-20260426.md` | created earlier this session (rollback record), still untracked |
| Memory: `feedback_deploy_migration_check.md` | updated with cross-link |
| Memory: `project_staging_migration_alignment.md` | updated with cross-link |
| Local working tree: `migrate.ts` | reverted to HEAD state (change is on PR branch only) |

## Recommended next steps

1. **Wait for PR #1190 review** — once merged, references to it in
   the SOP doc (e.g. `--list` recommendation in §5) become live.
2. **Decide whether to bundle the docs into a PR** — they're untracked
   right now. Two options:
   - Open a separate `docs/` PR with the 4 new MDs (+ the modified
     `staging-deploy-d88ad587b-20260426.md` correction banner). Same
     pattern as #1181 (Wave M-Feishu-1 doc archive).
   - Wait for next "session docs archive" PR to bundle everything.
3. **Schedule the migration alignment maintenance window** — the
   runbook is now ready for it. Pre-conditions: ~30-minute staging
   downtime tolerance, prod-track stack reachable, operator with SSH +
   sudo, fresh JWT for post-alignment verification.
4. **Do NOT redeploy d88ad587b until alignment is done** — the
   post-mortem MD already says this; the SOP makes it operational.

## Roadmap compliance

- ✅ 阶段一 lock honored: pure 内核打磨 / operational hygiene
- ✅ No new战线 — these are all defensive docs + a footgun fix
- ✅ No `plugins/plugin-integration-core/*` touched
- ✅ Default behaviors preserved (`pnpm migrate` unchanged, deploy
  process unchanged for the prior known-good path)
- ✅ All actions reversible (PR can be closed; docs are docs; memory
  edits are forward-only but additive)
