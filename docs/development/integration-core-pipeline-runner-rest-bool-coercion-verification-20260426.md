# Pipeline Runner REST API Bool Coercion · Verification

> Date: 2026-04-26
> Companion: `integration-core-pipeline-runner-rest-bool-coercion-design-20260426.md`

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
git diff --stat plugins/plugin-integration-core/lib/pipeline-runner.cjs \
                plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
```

## Result · `node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs`

```
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
```

The pipeline-runner test file uses a single linear `main()` with assertion-based subtests. All 16 sections (10 pre-existing + 6 new) pass to completion.

## New test coverage breakdown (6 sections added inside `main()`)

| # | Section | What it pins |
|---|---|---|
| **11** | `dryRun: "true"` (string) is honored | The headline safety fix. Asserts: target writes = 0, dead letters = 0, watermark = null, preview object exists with 1 record. With strict `=== true`, this would have been a LIVE run. |
| **12** | `dryRun: 1` / `"是"` / `"YES"` / `"on"` | Other truthy variants (numeric, Chinese, uppercase, alternate keyword) all correctly route to dry-run path. |
| **13** | `dryRun: false` / `"false"` / `0` / `"否"` / `""` | Negative direction — falsy variants correctly trigger LIVE run with target writes. Verifies the coercion doesn't over-accept. |
| **14** | `dryRun: "maybe"` throws `PipelineRunnerError` | Defensive — unknown values fail loudly with field name in `error.details.field`. No silent default-false (which would be unsafe for dryRun specifically). |
| **15** | `allowInactive: "true"` runs paused pipeline | Sets `pipelineOverrides.status = 'paused'`. Verifies (a) without flag → rejected with `'pipeline is not active'` (b) with `"true"` (string) → allowed and runs. |
| **16** | `allowInactive: "是"` / `1` / `"YES"` also work | Symmetry with dryRun's coercion variants. |

## Existing test regression check

The 10 pre-existing test sections (1-10 in the original `main()`) all pass unchanged. The change is bounded:

- The new helper `coerceTruthyFlag` is purely additive — no existing function modified.
- The 2 call sites changed go from strict-equality to coercion-then-truthy. For real boolean inputs (which is what all existing tests use), behavior is identical.
- The original dryRun test at lines 286-322 uses `dryRun: true` (real boolean); `coerceTruthyFlag(true)` returns `true`, identical to the original `=== true` result.

## Manual code review checklist

- [x] `coerceTruthyFlag` is identical in shape to the audit-series helpers (preflight `normalizeSafeBoolean`, evidence `normalizeSafeBoolean`, K3 adapter `coerceTriBool`) — same TRUE_BOOLEAN_TEXT / FALSE_BOOLEAN_TEXT sets, same throw-on-junk discipline, same field-name error messages.
- [x] Throws `PipelineRunnerError` (not the script-level `LivePoc*Error` or adapter's `AdapterValidationError`) — uses the runner's existing error class so callers get a consistent exception type.
- [x] Default for unset/null/empty is `false` for both flags — safe direction (no implicit dry-run, no implicit inactive-allow).
- [x] Error messages include `input.dryRun` / `input.allowInactive` field names so the operator can fix their request body without guessing.
- [x] Inline comment at the helper block explains both *what* (REST API bool coercion) and *why* (operator request bodies often serialize bools as strings, strict `=== true` silently fires live run on `dryRun: "true"`).
- [x] No mutation of the `input` object — coercion is read-only.
- [x] No new dependencies, no schema change, no contract change for callers of `runPipeline`.

## Why this is the natural follow-up to the audit series

After PR #1183 closed the K3 adapter runtime safety gap, I reviewed the remaining `=== true` / `=== false` sites in `plugin-integration-core/lib/`:

| Site | Risk | Action |
|---|---|---|
| `pipeline-runner.cjs:311` `dryRun === true` | **Live run when operator typed `"true"`** — most safety-critical | **This PR** |
| `pipeline-runner.cjs:156` `allowInactive !== true` | Operator's hand-edit ignored — UX issue | This PR (same helper, same call) |
| `pipeline-runner.cjs:202/203` `feedback.ok / skipped` | Server-controlled feedback object | Skip — not customer/operator typing |
| `pipeline-runner.cjs:408` `writeResult.inconsistent` | Internal adapter flag | Skip — not customer/operator typing |
| `erp-feedback.cjs:232/412/483` | Pipeline configuration | Defer — REST-API-validated config, lower risk |
| `transform-engine.cjs:151` | Transform spec arg | Skip — separate validation path |

The dryRun bug is the largest remaining blast radius in the integration-core surface — an operator submitting `dryRun: "true"` via REST API would silently write to production K3 WISE. After this PR, that gap is closed and the integration-core safety audit truly is complete.

## Cross-references

- Design doc: `docs/development/integration-core-pipeline-runner-rest-bool-coercion-design-20260426.md`
- Audit series: PR #1175 / #1176 / #1177 / #1182 (evidence), #1168 / #1169 (preflight), #1183 (K3 adapter)
- Original ship: PR #1150 (pipeline runner)
