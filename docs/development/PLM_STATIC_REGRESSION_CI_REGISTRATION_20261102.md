# Register current audit and Source regressions

As of 2026-11-02 Asia/Taipei, this is a local static workflow delivery. Tests, typecheck, build, install, imports, YAML execution, CI, HTTP, PostgreSQL, browser and product runtime were **NOT_RUN**. No push, PR or CI dispatch occurred. All seven delivery packages remain OPEN.

Parent: `d3d26c52e2e64a3e6cae9628786eef61f1e18ce6`.
Source commit: `d1602a992f1edc9c17594a4c33487de8438ca2a3`.
Branch: `codex/plm-static-regression-ci-registration-20261102`.

## Concrete gap

The preceding eight local increments added or changed four ordinary audit/Source regression files that were absent from the explicit unit command and test-path filters in `plm-personal-approval-realdb.yml`:

- `audit-actor-envelope.test.ts`
- `audit-wrapper.test.ts`
- `data-source-visibility-authority-matrix.test.ts`
- `plm-managed-source-provider-binding.test.ts`

The existing PLM personal approval workflow admits pull requests without a base-branch restriction and invokes a fixed list of unit files. The generic `plugin-tests.yml` job can discover these unit tests, but its pull-request trigger accepts only base branches `main` and `develop`. The current publication stack uses `codex/plm-source-catalogue-forward-20261101`. Relying on that generic main/develop trigger therefore does not cover this stacked-PR path.

The default backend Vitest configuration does not exclude these four files. This is a bounded finding about the existing PLM lane and generic branch gate; it is not a claim that no other possible invocation could ever run the tests.

## Change and preservation

Only `.github/workflows/plm-personal-approval-realdb.yml` changed: exactly 12 added lines, zero removed lines.

| Existing location | Added registration |
| --- | --- |
| `pull_request.paths` | Four exact backend unit paths |
| `push.paths` | The same four exact paths |
| Existing personal unit-test command | Four whole-file test arguments |

Each path-filter group follows the existing `packages/core-backend/src/**` entry. The arguments follow the existing `pnpm --filter @metasheet/core-backend exec vitest run` line. Existing source/test paths and command arguments remain in order.

No new workflow, job, framework, fixture or test was added. No product source, package, lockfile or Vitest configuration changed. `plugin-tests.yml` remains unchanged. Permissions, runners, timeouts, retries, branch restrictions, PostgreSQL service, type checks, web specs and no-skip assertions retain their original bytes. The existing push restriction to `main` remains in force.

Root integrated the exact Grok output without further source edits. Independently removing the three inserted groups restores the complete original workflow: 10766 bytes, SHA256 `9108d6fd635786aba5c17d0bf139e1a2fdd2db0f83cdf79f4c3cd58cf55dd89f`. The result is 11623 bytes, SHA256 `cd9d8c8c1d1fd2ff6f0d0737edb9a4263239cd79b41571e2c1990d54093bdadf`. The byte difference is 857 bytes / 12 lines. `git diff --check` passed.

## Evidence and execution limits

Evidence directory: `artifacts/plm-listener-review-20261015/unattended-12h-20261101/grok-tool-restore-20261101/static-regression-ci-registration-20261102/` in the review ledger tree.

- Accepted bounded contract at ledger `unattended-12h-20261101/Sol-current-static-regression-CI-registration-contract-20261102.json`, SHA256 `fabfeb7658769bcf806838610310251e7b42f8f1e16f01dc283e8bcb5a455414`.
- Final capsule: five members / 7084 bytes, SHA256 `5baa841a2071353853cd951db2cf9a9e60d094df3bb5e502d338296a17462e1e`. Each member's SHA/bytes and all three readonly inputs were checked.
- Final independent review: `Sol-final-v1-independent-static-review.json`, SHA256 `5603cf3039773664bfd8a090824c7b7e87cf87bde3926308bb7415543d5033b0`, no known static blocker.
- Root integration proof: `Root-exact-workflow-integration.json`.

This verifies text placement and preservation. It does not prove GitHub collection, YAML execution, test success, type compatibility or current-source runtime acceptance. The four tests and all other new local tests remain NOT_RUN. Existing old-head terminal CI is not qualification for these changes and was not polled or rerun.

Grok session `gbt-5e78-1a198de7358-8` / PID10888 performed the finite edit. Requested Grok4.7/medium; the CLI displayed Grok4.7/xhigh, while backend deployment identity remains UNKNOWN. The author's actual-model UNKNOWN field is retained separately. Independent review requested Sol6.1/medium; returned actual model/effort UNKNOWN.

After idle/done/STOP, the five original capsule hashes were checked again and only that owned model session was closed. The existing bridge PID24184 remains ready with zero model sessions, and its parent SSH7375 remains retained. This does not establish global host idleness or permission to close the N2 lease. Available snapshots do not establish complete command history or global absence of side effects.

Precommit head-only observation: main `b28538e328f754abba38553766537af2c4651894`; published catalogue child `8d237dac8ef6f168353d7cf8806a878e026bd0e5`. The local stack is not main-rebased. Original Native425, Meta6425 and Meta6684 heads remain unchanged. No current-source CI or runtime qualification is inferred from their older receipts.

N2 lease retention, Source23, W2, Claude/H3, P16 and browser HOLDs remain intact. Remaining controlled BOM code/handoff and real pairing, license, installation, restore, browser/IdP and business gates remain OPEN. This single document is the closeout commit; future results belong in ledger/body updates. No test or CI execution is authorized by this static record.
