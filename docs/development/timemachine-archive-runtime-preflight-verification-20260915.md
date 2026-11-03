# Time Machine archive startup preflight verification

Status: local code checkpoint verified; remote candidate CI and merge are
separate, pending publication evidence. Not a runtime enablement report.

## Exact binding

- Base: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.
- Code: `f27045c44c5381045f2618c019ee8ebe80138be9`.
- Tree: `62fbd9a1e349c958eac12316a1ec1f93a634abc6`.
- Branch: `codex/timemachine-archive-runtime-preflight-20260915`.
- Worktree: `/private/tmp/metasheet2-timemachine-archive-runtime-preflight-20260915`.
- Code diff: two files, 85 insertions; production diff is ten required-method
  checks, the other 75 lines are dedicated tests.
- These MD files are a later documentation-only child; they do not change the
  code binding or inherit another PR's CI.

## Red, repair, green

Before the production change, the complete application suite produced
`20 failed / 12 passed`. All ten missing/non-callable method cases and all ten
throwing-accessor cases failed because composition did not reject them.

After the repair and after restoring all mutations:

```sh
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-application.test.ts \
  tests/unit/multitable-recovery-archive-restore-worker.test.ts \
  tests/unit/multitable-recovery-archive-object-store.test.ts \
  tests/unit/multitable-recovery-archive-crypto.test.ts \
  tests/unit/metasheet-recovery-archive-wiring.test.ts --reporter=dot
```

Result: **5 files / 134 tests PASS**, zero skipped in the complete run.

| Suite | Passed |
| --- | ---: |
| Application | 32 |
| Restore worker | 18 |
| Object store | 19 |
| Crypto | 57 |
| Server wiring | 8 |

New positive control: inherited provider methods are accepted; no provider
operation or worker is called during preflight. Existing exact-flag-OFF,
canonical DB injection, single worker start, shared stop/drain, shutdown error,
observer containment, and provider identity controls remain green.

## Mutation proof

Each production method check was independently removed and restored:

- Custody: `produceGenerationDek`, `unwrapGenerationDek`,
  `deriveDekFingerprint`, `macManifestRoot`, `verifyManifestRootMac`.
- Store: `put`, `get`, `head`, `deleteExpired`, `pin`.

For every removal, its matching targeted test exited 1 with exactly one failure
(`expected function to throw an error, but it didn't`). The targeted command
filters other tests; its 31 filtered skips are not a full-suite acceptance run.
After all ten restorations the complete five-suite command passed again.
No mutation is present in the code checkpoint.

## Quality and CI ownership

- `pnpm --filter @metasheet/core-backend type-check`: PASS.
- From `packages/core-backend`,
  `pnpm exec eslint src/multitable/recovery-archive-application.ts`: PASS.
- An initial root-directory ESLint invocation failed because it resolved the
  root TSConfig rather than the backend project. The backend-cwd command above
  is the valid scoped run; no lint or TSConfig setting was relaxed.
- `git diff --check`: PASS.
- Worktree clean after the code commit; shared dependencies were reused through
  symlinks without install or lockfile edits.
- A later `vitest list` discovery attempt was unsupported by local Vitest
  1.6.1 and entered watch mode with additional filename matches. It was stopped
  with exit 130 and is not counted as acceptance; the explicit five-file run
  above is the complete test evidence.

The existing application test is collected by the backend default Vitest
configuration. `plugin-tests.yml` runs `pnpm --filter @metasheet/core-backend
test` in its Node18/Node20 matrix. No workflow or selector was edited. Published
exact-head CI must independently confirm collection and success; source wiring
plus local execution is not remote CI evidence.

## Evidence boundaries

Independent Luna high review of immutable `c6f2d437..f27045c44` completed with
**P1=0 / P2=0 / P3=0**. It checked the ten-method census, pre-DB/worker ordering,
fixed errors, flags-off behavior, prototype compatibility, and discriminating
tests. It performed no writes or test execution and does not constitute a
provider-connectivity review. The review session was closed after completion.

- Tests use isolated mocks/test providers and do not exercise a real KMS or
  independent object store. No real database acceptance was run for this
  method-shape-only change, and none is claimed.
- No browser change; existing archive-readiness UI remains in separate Draft
  #5725. No new browser acceptance is claimed here.
- No key generation, credentials, object upload, catalog insertion, restore,
  real flag change, dispatch, deployment, staging, or production operation.
- No claim that archives are now usable in normal direct startup. Concrete
  runtime composition, provider/custody choices, and crash/restart acceptance
  remain separate work items in the completion-goal document.
- Other PRs' green checks do not prove this new head, and scheduled main
  failures are not silently reclassified as successful.
