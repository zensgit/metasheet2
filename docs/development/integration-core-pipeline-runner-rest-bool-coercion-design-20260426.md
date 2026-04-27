# Pipeline Runner REST API Bool Coercion · Design

> Date: 2026-04-26
> Bug class source: PR #1175 / #1176 / #1177 / #1182 / #1183 audit series (K3 WISE preflight + evidence + adapter)
> Scope: control plane (pipeline-runner.cjs) — REST API request fields

## Problem

The pipeline runner has 2 strict-equality checks against REST API request fields:

```javascript
// pipeline-runner.cjs line 156 — pre-fix
if (pipeline.status !== 'active' && input.allowInactive !== true) {
  throw new PipelineRunnerError('pipeline is not active', { ... })
}

// pipeline-runner.cjs line 311 — pre-fix
const dryRun = input.dryRun === true
```

Both fields arrive over a JSON REST API. Admin tools, curl one-liners, and form helpers commonly serialize booleans as strings (`"true"` / `"false"`) or numerics (`0` / `1`) — and Express body parsers preserve those types verbatim.

### Why dryRun is the **most safety-critical bug**

If an operator or admin tool sends:

```json
POST /api/integration/pipelines/:id/run
{ "dryRun": "true" }
```

The strict `=== true` is **false** (because `"true" !== true`), so `dryRun = false`, and the runner executes a **LIVE** pipeline run — writing real data to the K3 WISE target, advancing watermarks, and creating dead letters. The operator wanted a preview; they got a production write.

This is the unsafe direction in its purest form: the operator's explicit safety flag is silently ignored.

### allowInactive — UX issue, not safety

```json
POST /api/integration/pipelines/:id/run
{ "allowInactive": "true" }
```

With strict `!== true`, this is **true** (because `"true" !== true`), so the inactive-pipeline guard fires and the request is rejected. The operator's hand-edit is ignored, but the safe direction (refuse to run a paused pipeline) is preserved. UX-impacting (operator confused why their flag was ignored), not safety-critical.

Both deserve a fix, since the same coercion call covers both.

## Solution

Add a `coerceTruthyFlag(value, field)` helper local to the pipeline runner (mirrors the audit-script discipline of local helpers, no shared module dependency). Apply it at both call sites.

```javascript
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

function coerceTruthyFlag(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PipelineRunnerError(`${field} must be ...`, { field })
    if (value === 1) return true
    if (value === 0) return false
    throw new PipelineRunnerError(`${field} must be 0 or 1 ...`, { field, received: value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return false
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new PipelineRunnerError(`${field} must be ...`, { field })
}
```

Replacements:

```javascript
// line 156 — fixed
if (pipeline.status !== 'active' && !coerceTruthyFlag(input.allowInactive, 'input.allowInactive')) {

// line 311 — fixed
const dryRun = coerceTruthyFlag(input.dryRun, 'input.dryRun')
```

### Why throw on unknown values (not silent default-false)

For dryRun specifically, defaulting unknown values to `false` is unsafe — `dryRun: "maybe"` would silently become a live run. Better to fail loudly so the operator sees a clear error message and can fix their request body. Same defensive-coercion discipline as the audit series (#1175 etc).

For allowInactive, throw-on-unknown is consistent with dryRun and gives a clearer error than "pipeline is not active" (which would otherwise be returned even though the operator did set the flag).

### Coercion table (covers both fields)

| Operator request value | Resolved | Behavior |
|---|---|---|
| `true` / `"true"` / `"是"` / `1` / `"yes"` / `"on"` | `true` | dryRun=true (preview) or allowInactive=true (run paused pipeline) |
| `false` / `"false"` / `"否"` / `0` / `"no"` / `"off"` | `false` | dryRun=false (live run) or allowInactive=false (reject paused pipeline) |
| `undefined` / `null` / `""` (omitted) | `false` | Default-safe (live run requires explicit dryRun, paused pipeline requires explicit allowInactive) |
| `"maybe"` / `2` / `NaN` / object / array | throws | `PipelineRunnerError` with field name in error message |

## Files changed

- `plugins/plugin-integration-core/lib/pipeline-runner.cjs` — `coerceTruthyFlag` helper added (~30 lines), 2 call sites converted (~2 lines net)
- `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs` — 6 new test sections (~115 lines) inside `main()`
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs` reports `✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed`
- [x] **HEADLINE FIX**: `dryRun: "true"` (string) is honored as dry-run — does NOT write to target, does NOT advance watermark, does NOT create dead letters, DOES produce a preview object
- [x] `dryRun: 1` / `"是"` / `"YES"` / `"on"` all resolve to dry-run
- [x] `dryRun: false` / `"false"` / `0` / `"否"` / `""` all resolve to live run (writes target)
- [x] `dryRun: "maybe"` throws `PipelineRunnerError` with `field === 'input.dryRun'`
- [x] **allowInactive HEADLINE FIX**: paused pipeline + `allowInactive: "true"` → run executes (was previously rejected)
- [x] `allowInactive: "是"` / `1` / `"YES"` also allow inactive runs
- [x] Existing 10 test sections (cleanse/idempotency/incremental/dry-run/dead-letter/replay/etc.) pass unchanged

## Out of scope

- **`erp-feedback.cjs` strict equality** at lines 232/412/483 — pipeline configuration, lower hand-edit risk than runtime request fields
- **`pipeline-runner.cjs` line 202/203** — `feedback.ok !== false` / `feedback.skipped === true` — feedback objects from external code (server-controlled), not customer/operator typing
- **`pipeline-runner.cjs` line 408** — `writeResult.inconsistent === true` — internal flag set by adapter, not operator-typed
- **Refactor coercion into shared helper module** — would touch the audit-script trio + adapter, collision risk with parallel codex sessions

## Cross-references

- Audit series: PR #1175 / #1176 / #1177 / #1182 (evidence script), #1168 / #1169 (preflight script), #1183 (K3 adapter)
- Original ship: PR #1150 (pipeline runner v1)
- This PR: closes the integration-core control-plane safety gap
