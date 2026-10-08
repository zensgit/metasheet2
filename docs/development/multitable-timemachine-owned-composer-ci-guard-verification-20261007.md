# Owned composer guard census correction verification

Status: local gates verified; Draft/HOLD. Whole TM acceptance remains OPEN.
Source parent: `9d4b847be3847bdc73a3c867fca738f856cc63b8`.
The committed-source receipt binds the eventual four-file PR head.

## Problem and bounded change

Composer CI `37579639118` at `f817f010fce37e903440eb8a2a5ca69caf070c6f`
and APFS CI `37582627196` at the source parent failed the same eight existing
static census assertions. Root independently qualified each terminal failure,
source blobs, six complete job logs and continuous range downloads. In both Node
jobs, the core test failure skipped the downstream native integration step.
The local two-file baseline reproduced 104 cases: 96 PASS, 8 FAIL, zero skip.

This continuation changes two existing guard specs only. It registers four exact
NONWRITER holder keys with call counts 4/1/1/1 and proves the one exact shared
authority-lock key through AST checks. The normal path must use the same locked
RC query and transaction ID, then read the live sheet/base binding before return.
The cleanup path must retain its complete exact-owner terminalize/release bodies;
it must not acquire current permission, flag, key or lease-validity prerequisites.
Unknown holders and locks remain refused. The existing GAP ceiling remains 1.

All 104 original cases remain; one census title and its expected verdict set now
include the new mechanically proved category. Eleven adjacent proof cases were
added. No production source, workflow, Vitest configuration, package chain,
provenance vector, migration or flag changes accompany the repair.

## Design-lock gates

| Gate | Actual evidence | Result |
| --- | --- | --- |
| Original complete failure | Two files, 104 cases, 96 PASS / 8 FAIL / 0 skip; original raw output retained | PASS |
| Bounded source review | Root source/authority trace and independent frozen-input review; exact four holders and one shared lock | PASS |
| Final complete tests and neighbors | 14 whole files, 379 PASS / 0 FAIL / 0 skip; actual process exit 0 | PASS |
| Holder ledger mutation | Remove one exact entry: whole two files, 115 cases, 109 PASS / 6 FAIL / 0 skip; exit 1 | PASS |
| Normal proof mutation | Early return in the new test proof: 115 cases, 109 PASS / 6 matching FAIL / 0 skip; exit 1 | PASS |
| Cleanup proof mutation | Early return in the new test proof: 115 cases, 112 PASS / 3 matching FAIL / 0 skip; exit 1 | PASS |
| Exact restoration | Both specs restored from saved original bytes after every variant; final 379-case run afterward | PASS |
| Independent mutation evidence review | Raw logs, JSON, process outcomes, snapshots and failed titles independently checked | PASS |
| Production preservation | 1508 recorded production/workflow/config Git blob IDs match the parent tree | PASS |
| Type and configured validation | Backend tsc, both guard dependency closures, `pnpm validate:all`, diff check: exit 0 | PASS |
| Package provenance | Official sealed-export-package-provenance test: exit 0; provenance inputs unchanged | PASS |
| New ordinary exact-head CI | One unique continuation run; actual named unit rows and native steps must be read afterward | OPEN at publication |

The final restored invocation uses `pnpm --filter @metasheet/core-backend exec
vitest run` with these entire files, without any case-name filter:

- `tests/unit/multitable-field-schema-fence-recheck.guard.test.ts`
- `tests/unit/multitable-permissions-txn-liveness-recheck.guard.test.ts`
- `tests/unit/multitable-recovery-archive-owned-claim.test.ts`
- `tests/unit/multitable-recovery-archive-owned-capture.test.ts`
- `tests/unit/multitable-recovery-archive-owned-composer.test.ts`
- `tests/unit/multitable-recovery-archive-owned-history.test.ts`
- `tests/unit/multitable-recovery-archive-writer-block.test.ts`
- `tests/unit/multitable-recovery-local-filesystem.test.ts`
- `tests/unit/multitable-recovery-archive-file-store.test.ts`
- `tests/unit/multitable-recovery-local-custody-store.test.ts`
- `tests/unit/multitable-recovery-local-custody.test.ts`
- `tests/unit/multitable-recovery-archive-object-store.test.ts`
- `tests/unit/multitable-recovery-local-startup.test.ts`
- `tests/unit/multitable-recovery-archive-application.test.ts`

The existing default Vitest discovery and `plugin-tests.yml` core-backend step
already collect both guard specs. The later native integration step remains a
separate execution gate; a passing static guard is not native qualification.
Configured validation runs the repository's current lint/type scopes and reports
nine pre-existing plugin manifest warnings. It is not a new workspace-wide lint
or test-coverage claim.

## Preserved evidence and limits

Ignored evidence resides under `artifacts/tm-owned-composer-ci-guard-repair-20261007/`.
It retains the original failure, implementation input freeze, the first test-only
template-escaping collection failure, corrected whole-file output, configured
gate logs, mutation source snapshots/raw/JSON/process records and independent
review receipts. Each live mutation changed a guard spec only; no production
guard was weakened. The final 14-file result supersedes the earlier seven-file
212-case result recorded before the last test-title/comment correction.

This proves the static guard repair and its falsifiability. Runtime authority
liveness, native composer and macOS APFS evidence retain their separate scopes.
Same authenticated archive backup/restore, interrupted owned-generation
continuation, lifecycle, Phase 5 attribution, owner staging authorization,
deployment and business acceptance remain OPEN. Existing flags remain OFF.
