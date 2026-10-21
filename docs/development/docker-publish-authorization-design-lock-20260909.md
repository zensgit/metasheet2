# Docker publish authorization repair

User-authorized scope: separate ordinary builds from image publication, bind publication to an explicit commit, verify package visibility before publication, and retain the existing independent production deployment gate. This authorizes implementation and a Draft PR, not a registry write or deployment.

Implementation base: `b677d6ccb09a5d3777a8675f222356326e89ba4c`. Pre-merge rebase: `e89f3e15e4aeeaaad283f25f9adc720efa40f7d8` (after intermediate replays onto `b7f734aec` and `60794aacf`); the publication/readiness patch is unchanged.
Branch: `codex/docker-publish-authorization-20260909`.
OPEN PR census at initial delivery: no other open PR among the current 100 results touched `docker-build.yml`, a Docker/image publication guard, or the ERP/PLM deployment readiness script/tests.

Follow-up authorization: after independent review, merge this repair and verify the automatic main build with publication and deployment disabled. The independent read-only review found no blockers, reran all 28 dedicated tests, and checked the 13 mutation logs and byte-identical deployment steps. The refreshed head must pass verification before merge; no image publication or deployment is authorized.

## Contract

- Push builds backend and web as before, runs publication guard tests, and never logs into or writes GHCR.
- A manual build defaults to no publication. Publication requires `publish_images=true`, `refs/heads/main`, `GITHUB_REPOSITORY=zensgit/metasheet2`, and an explicitly supplied full lowercase `publish_sha` equal to the workflow/checkout SHA. Noncanonical boolean and visibility inputs are rejected.
- Expected visibility must be explicitly selected as `public` or `private`; the default `unselected` cannot authorize publication. Existing package names remain fixed. Both GitHub package responses must identify the expected owner, container type, name, and visibility before either image is pushed. Missing packages, malformed metadata, permission/network failures, and mismatches fail closed with values-free codes.
- The preflight only reads package metadata and never attempts a visibility change. It runs after both builds and before login/push. Package visibility is a point-in-time observation, not an atomic lock on registry administrators.
- Publish exact SHA tags first, then the existing latest aliases. Publication succeeds only after all four pushes complete. Docker/GHCR cannot make this four-push sequence atomic; a failure can leave partial published tags, but cannot enable deployment.
- Deployment requires both the original manual/main/`deploy_production=true` predicate and the successful publication output. A deploy request without publication is rejected. Deployment body, SSH trust, smoke gates, flags, and runtime behavior remain unchanged.
- Preserve the workflow name used by ERP/PLM readiness. That directly affected consumer must require a completed successful `Publish approved commit images` step in the exact run's successful build job with matching SHA and manual event. Whole-workflow success, missing/skipped publication, or unreadable job evidence cannot establish image readiness.
- No new environment feature flags, package destinations, runtime dependencies, production reads, migrations, or changes to public/private package settings.

## Gates

| Gate | Required proof | Status |
|---|---|---|
| G1 | Push/default/manual-unapproved paths have zero publication-metadata reads, GHCR login, or push | Local PASS: CLI stubs plus workflow guards; Docker base-image pulls remain part of builds |
| G2 | Exact SHA, main, repository, boolean and visibility negative cases | Local PASS |
| G3 | Both packages checked; missing/invalid/mismatched metadata and failed reads deny publication | Local PASS, including second-package failures |
| G4 | Every login/push requires successful preflight; deployment also requires successful publish | Local PASS, including execution of the actual publish shell with each push failing in turn |
| G5 | Real CLI tests with stub GH plus workflow contract tests enter PR CI | Wired in the new unfiltered PR guard; preflight tests also run in the build job. Remote result is recorded on the Draft PR |
| G6 | Guard-removal mutations fail; restored tests and neighboring deploy/SSH contracts pass | Local PASS: 13/13 mutations detected; final combined suite 75/75, zero skipped |
| G7 | YAML/actionlint and repository required validation results recorded; deployment body unchanged | PASS with baseline caveats below |
| G8 | Draft PR created with exact head and actual CI state; no merge or dispatch | Delivery evidence belongs to the Draft PR and closeout report after this commit |

## Local verification

Node `20.20.2`, pnpm `10.16.1`; isolated worktree dependencies installed offline with the frozen lockfile. No lockfile changes.

```sh
node --test scripts/ops/docker-publish-preflight.test.mjs scripts/ops/docker-publish-workflow-contract.test.mjs scripts/ops/deploy-immutable-traceability-contract.test.mjs scripts/ops/backend-docker-image-contract.test.mjs scripts/ops/integration-erp-plm-deploy-readiness.test.mjs scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs scripts/ops/ssh-hostkey-pin-family-contract.test.mjs scripts/ops/ssh-hostkey-pin-family-behavior.test.mjs
pnpm validate:all
actionlint -shellcheck= -pyflakes= .github/workflows/docker-build.yml .github/workflows/docker-publish-guard.yml
git diff --check
```

- The initial workflow contract run failed before implementation (five failing checks). The CLI stub initially needed a `.cjs` filename in this ESM workspace; that fixture issue was corrected before the passing results above.
- `pnpm validate:all` passed plugin validation, repository lint, and backend/frontend type checks; plugin validation retains nine existing warnings.
- YAML/expression actionlint passed. Full actionlint retains the same 97 ShellCheck diagnostics as the frozen base, with no additional diagnostics. Deployment steps are byte-identical; SHA-256 `050d423cc8ca988e2d1164cf9b2ab9ecfcc5647cad07795fecd7299ea5991398`.
- A separate direct ESLint invocation on ops scripts was unavailable because there is no applicable configuration; it is not counted as a pass. `node --check` passed all five touched JavaScript files.
- Mutations removed event, boolean, repository, main, SHA, second-package, identity, visibility, login, push, partial-push, deploy, and readiness guards. Each matching test failed; files were restored without touching unrelated work.
- Evidence logs live under the worktree's ignored `artifacts/docker-publish-authorization/`. Tests use stub GH/Docker executables and do not publish images. No live dispatch, registry write, deployment, migration, feature enablement, or real-tenant read is part of this verification.

GitHub documents boolean event inputs as strings, and public container packages as anonymously accessible. Public packages cannot be made private again: [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs), [package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#configuring-visibility-of-packages-for-your-personal-account).
