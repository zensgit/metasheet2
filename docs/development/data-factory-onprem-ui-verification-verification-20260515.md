# Data Factory on-prem UI verification - verification - 2026-05-15

Companion to `data-factory-onprem-ui-verification-design-20260515.md`.
Ops + docs only; no `plugins/plugin-integration-core`, no DB migration, no API
runtime, no route change.

## Local evidence gathered

### 1. Latest-main web build contains #1595

Branch from `origin/main` (`7b5c55dad`, includes #1595 `e77a04117`), then:

```text
pnpm --filter @metasheet/web build      -> built in ~6s, exit 0
grep apps/web/dist:
  规范化为 integration 作用域            -> PASS (normalize button)
  不是 integration 作用域                -> PASS (scope warning)
  否则会触发 plugin-scope 警告           -> PASS (k3-setup hint)
  k3-setup-project-id-hint               -> PASS (hint testid)
  数据工厂                               -> PASS (existing copy sanity)
```

### 2. Full on-prem package build + modified verify = PASS

```text
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=0 \
  bash scripts/ops/multitable-onprem-package-build.sh
  -> metasheet-multitable-onprem-v2.5.0-20260515-081133.zip, exit 0

bash scripts/ops/multitable-onprem-package-verify.sh <that>.zip
  -> "Package verify OK", exit 0
```

The new `verify_generic_integration_workbench_contract` assertions found the
#1595 strings inside the bundled `apps/web/dist`, proving the P2 UX ships in
the package when built from latest `main`.

### 3. The new gate is real (not a no-op)

```text
git show e77a04117^:apps/web/src/views/IntegrationWorkbenchView.vue
  | grep '规范化为 integration 作用域'   -> CONFIRMED absent pre-#1595
git show e77a04117^:apps/web/src/views/IntegrationK3WiseSetupView.vue
  | grep '否则会触发 plugin-scope 警告'  -> CONFIRMED absent pre-#1595
```

A package built from a pre-#1595 `main` would now `die()` on these assertions
- so Gate A genuinely catches a stale/wrong bundle.

Methodology note: this negative proof is **source-level** (pre-#1595 source
lacks the strings). A bundle-level negative (build a pre-#1595 web dist and
confirm absence) was not run: the positive run already demonstrated vite
preserves these Chinese template strings verbatim into `apps/web/dist`, so the
source->bundle direction is established and the extra pre-#1595 build cost
outweighs the marginal certainty for a docs/ops-only change.

## #1590 coverage statement

#1590 is a one-line wiring change with no unique static string. It is
**intentionally not** asserted by the package verifier; the runbook routes its
proof to live UI check C1 and explicitly tells the operator a C1 failure
combined with a Gate B 401 is a deploy/schema fault, not a #1590 regression.

## Test commands summary

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web build` | exit 0 |
| grep `apps/web/dist` for #1595 strings | all PASS |
| `multitable-onprem-package-build.sh` (latest main) | exit 0, zip produced |
| `multitable-onprem-package-verify.sh <zip>` (with new assertions) | exit 0, PASS |
| pre-#1595 negative grep | strings absent (gate is real) |

`bash -n scripts/ops/multitable-onprem-package-verify.sh` syntax-clean (the
modified script executed end-to-end to a PASS above).

## Deployment impact

None. The verifier change only adds two read-only `grep`-style assertions to
an existing ops script. The runbook and MDs are docs. No env, migration, flag,
route, or bundle behavior change. Rollback = revert the PR.

## CI

ops/docs only. Expect `pr-validate` to pass; Docker/Build path-filtered out for
non-source changes. Confirm on push.

## GATE-blocking status

Does not lift the customer GATE and implements no P1 runtime. Verification
enablement for already-merged frontend work on already-deployed environments.

## Stage 1 Lock conformance

- No new战线; verifies/asserts already-shipped Data Factory work.
- No `plugins/plugin-integration-core` touch.
- No migration, no API runtime, no route change.
- Verifier assertion = ops hygiene on shipped features (permitted).
