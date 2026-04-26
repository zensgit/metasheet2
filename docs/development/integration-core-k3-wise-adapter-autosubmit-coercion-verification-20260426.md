# K3 WISE WebAPI Adapter autoSubmit/autoAudit Coercion · Verification

> Date: 2026-04-26
> Companion: `integration-core-k3-wise-adapter-autosubmit-coercion-design-20260426.md`
> Closes the integration-core safety audit (preflight + evidence + adapter runtime all hardened)

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
git diff --stat plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs \
                plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

## Result · `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`

```
✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
```

The adapter test file uses a single linear test runner (custom assertion harness, not Node test runner). The 3 test functions invoked from `main()` are:

1. `testK3WebApiAdapter` — pre-existing (PR #1152), unchanged behavior
2. `testK3SqlServerChannel` — pre-existing, unchanged behavior
3. `testK3WebApiAutoFlagCoercion` — NEW in this PR, 10 scenarios (A-J)

All three pass. Single line of stdout confirms the full suite ran to completion.

## New test coverage breakdown (10 scenarios in `testK3WebApiAutoFlagCoercion`)

| Scenario | What it pins |
|---|---|
| **A**: `config.autoSubmit = "true"`, `config.autoAudit = "是"`, no request override | Hand-edited string config → coerced to `true`. Most common operator hand-edit: pasted from a markdown table that JSON-stringified the bool. |
| **B**: `config.autoSubmit = 1`, `config.autoAudit = 0` | Spreadsheet-export style numeric booleans. |
| **C**: **HEADLINE FIX** — `config.autoSubmit/autoAudit = true`, `request.options.autoSubmit = "false"` / `"否"` | Operator hand-edits the request to disable. With strict equality this previously fired auto-submit anyway because `"false" !== false`. Now correctly disables. Test also asserts that `/Material/Submit` and `/Material/Audit` are NOT called — pins the actual lifecycle behavior, not just the metadata flag. |
| **D**: `config.autoSubmit/autoAudit = false`, `request.options = "true"` / `1` | Reverse direction — operator overrides config-disabled with explicit enable. |
| **E**: request unset, config drives | Preserves the existing "config default when request unset" contract. |
| **F**: both unset | Safe default `false` — auto-submit/audit OFF when nothing is configured. |
| **G**: `request.options.autoSubmit = ""` (empty string) | Empty string treated as unset (falls back to config). Common when REST API serializes optional fields as empty string. |
| **H**: `config.autoSubmit = "maybe"` | Throws `AdapterValidationError` with `autoSubmit` in message — no silent acceptance of unknown strings. |
| **I**: `config.autoSubmit = NaN` | Throws with "finite" in message — non-finite numbers are explicit errors. |
| **J**: `config.autoSubmit = 2` | Throws with "0 or 1" in message — only 0/1 accepted as numeric booleans. |

## Existing test regression check

The pre-existing 2 test functions are unchanged in this PR:

- `testK3WebApiAdapter` (line 122): exercises real-boolean `autoSubmit: true` / `autoAudit: true` config (lines 81-82 of test fixture). Asserts `upsert.metadata.autoSubmit === true` and `=== true` (lines 154-155). The new helpers preserve this exactly: `resolveAutoFlag(undefined, true, 'autoSubmit')` returns `true` because `coerceTriBool(undefined)` is `null` → falls through to `coerceTriBool(true) === true`.
- `testK3SqlServerChannel` (line 233): exercises SQL Server channel; doesn't touch autoSubmit/autoAudit logic at all. Untouched.

The `metadata.autoSubmit` / `metadata.autoAudit` exposure in upsert results is preserved verbatim — the helpers only change *how* the value is computed, not *what* gets returned.

## Manual code review checklist

- [x] `coerceTriBool` returns explicit `null` for unset/empty inputs (NOT `undefined`) — call sites can use `=== null` or `!= null` consistently to distinguish "set" from "unset".
- [x] `resolveAutoFlag` correctly prioritizes explicit request → falls back to config → defaults to false. Three-tier semantics preserved.
- [x] `TRUE_BOOLEAN_TEXT` / `FALSE_BOOLEAN_TEXT` sets are identical to the audit-script versions (preflight + evidence), keeping behavior consistent across the customer-facing and plugin-internal surfaces.
- [x] Throws `AdapterValidationError` (not the script-level `LivePocPreflightError` / `LivePocEvidenceError`) — uses the adapter's existing error class for API consistency.
- [x] Error messages include the field name (`request.options.autoSubmit` or `config.autoSubmit`) so an operator running into the error knows exactly which config field to fix.
- [x] No new dependencies, no schema change, no contract change for callers of `createK3WiseWebApiAdapter`.
- [x] Inline comment on the helper block explains both *what* (tri-state coercion) and *why* (strict equality silently fires lifecycle steps against operator intent).
- [x] No mutation of `request.options` or `config` — coercion is read-only.

## Why this is the right place to stop the audit series

After this PR:

1. **`preflight.mjs`** input parsing — fully bool-coerces customer GATE answers (#1168, #1169)
2. **`evidence.mjs`** all customer-supplied JSON fields — fully coerced (bool: #1175, numeric ID: #1176, status synonym: #1177, packet safety hand-edit: #1182)
3. **`k3-wise-webapi-adapter.cjs`** runtime safety flags — fully coerced (this PR)

The remaining `=== true` / `=== false` sites I audited are NOT customer- or operator-typed:

- `erp-feedback.cjs` lines 232/412/483 — pipeline configuration, REST-API-validated, lower hand-edit risk
- `pipeline-runner.cjs` lines 156/202/203/311/408 — internal flags from REST requests / feedback objects (server-controlled)
- `transform-engine.cjs` line 151 — transform spec arg (operator-defined but parsed via separate validation)

These are intentionally NOT in scope. The audit gate was: "what data path actually receives customer- or operator-typed boolean strings?" — and after this PR, all such paths are hardened.

## Cross-references

- Design doc: `docs/development/integration-core-k3-wise-adapter-autosubmit-coercion-design-20260426.md`
- Audit series: PR #1175 / #1176 / #1177 / #1182 (evidence script), #1168 / #1169 (preflight script)
- Original adapter ship: PR #1152 (K3 WISE WebAPI + SQL Server channel)
