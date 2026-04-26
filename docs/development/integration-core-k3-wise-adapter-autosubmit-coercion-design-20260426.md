# K3 WISE WebAPI Adapter autoSubmit/autoAudit Coercion · Design

> Date: 2026-04-26
> Trigger: post-#1182 audit pass; surfaced same bug class in plugin internals
> Bug class source: PR #1175 / #1176 / #1177 / #1182 evidence-script audit series
> Scope: plugin-internal adapter (operator-facing), not customer-facing scripts

## Problem

The K3 WISE WebAPI adapter resolves `autoSubmit` / `autoAudit` from a combination of pipeline request options and external system config:

```javascript
// scripts/ops/.../k3-wise-webapi-adapter.cjs lines 442-443 (pre-fix)
const autoSubmit = request.options.autoSubmit === true || (request.options.autoSubmit !== false && config.autoSubmit === true)
const autoAudit  = request.options.autoAudit  === true || (request.options.autoAudit  !== false && config.autoAudit  === true)
```

Read literally: "request override is true → enabled; otherwise, if request override is *not literally `false`*, fall back to config." Strict equality on both branches.

**The unsafe direction**: an operator who hand-edits `request.options.autoSubmit = "false"` (string) to disable auto-submit gets the **opposite** of intent:
- First clause: `"false" === true` → `false`
- Second clause: `"false" !== false` → **true** (because string ≠ boolean) → `&& config.autoSubmit === true` → `true` if config.autoSubmit is `true`
- Overall: `false || (true && true)` = **true** → `autoSubmit` fires

The operator wanted to disable auto-submit; the adapter fires auto-submit anyway because the strict-equality check failed to recognize the string `"false"` as a falsy override.

This is the same bug class as the evidence compiler audit series (#1175, #1176, #1177, #1182) — strict equality silently failing on string/numeric/Chinese variants of booleans. **In this case the unsafe direction is a real safety concern**: K3 WISE auto-submit/audit moves a saved record into a workflow state that may require explicit customer approval to roll back.

## Solution

Add a tri-state coercion helper local to the adapter (mirroring the audit-script discipline of local helpers, no shared module dependency):

```javascript
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

function coerceTriBool(value, field) {
  if (value === undefined || value === null) return null  // truly unset
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdapterValidationError(...)
    if (value === 1) return true
    if (value === 0) return false
    throw new AdapterValidationError(...)
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return null  // empty string treated as unset
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new AdapterValidationError(...)
}

function resolveAutoFlag(requestValue, configValue, field) {
  const requestExplicit = coerceTriBool(requestValue, `request.options.${field}`)
  if (requestExplicit !== null) return requestExplicit  // explicit request wins
  const configExplicit = coerceTriBool(configValue, `config.${field}`)
  return configExplicit === true  // config drives if request unset; default false
}
```

Then the call sites become:

```javascript
const autoSubmit = resolveAutoFlag(request.options.autoSubmit, config.autoSubmit, 'autoSubmit')
const autoAudit  = resolveAutoFlag(request.options.autoAudit,  config.autoAudit,  'autoAudit')
```

### Why tri-state (not 2-state)

The original logic distinguishes 3 states for `request.options.autoSubmit`:
1. **Explicit true** → enable
2. **Explicit false** → disable (override config truthy)
3. **Unset** → fall back to config

A 2-state coercion (just true/false) would lose the "unset" signal — `coerceTriBool(undefined)` would have to return either `false` (over-disabling cases the config wanted) or `true` (over-enabling cases the operator never approved). The 3rd state (`null` = unset) preserves the intended "request overrides config when explicit, otherwise config drives" contract while fixing the string-coercion bug.

### Coercion table

| `request.options.autoSubmit` | `config.autoSubmit` | Result | Why |
|---|---|---|---|
| `true` | (any) | `true` | Explicit request true |
| `false` | (any, even `true`) | `false` | Explicit request false (intent honored) |
| `"true"` / `"是"` / `1` | (any) | `true` | Coerced explicit true |
| `"false"` / `"否"` / `0` | (any, even `true`) | `false` | Coerced explicit false (HEADLINE FIX — was previously firing on config truthy) |
| `undefined` / `null` / `""` | `true` | `true` | Request unset, config truthy |
| `undefined` / `null` / `""` | `false` / `undefined` / `null` | `false` | Request unset, config also unset/false → default safe |
| `undefined` / `null` / `""` | `"true"` / `1` / `"是"` | `true` | Request unset, config coerced truthy |
| `"maybe"` / `2` / `NaN` | (any) | throws | No silent acceptance |

## Files changed

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` — `coerceTriBool` + `resolveAutoFlag` helpers added (~38 lines), 2 call sites converted (~2 lines net)
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs` — `testK3WebApiAutoFlagCoercion()` added with 10 scenarios (~110 lines), wired into `main()`
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs` reports `✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed`
- [x] **Headline fix**: hand-edited `request.options.autoSubmit = "false"` overrides config `true` → adapter does NOT fire `/Material/Submit`
- [x] Hand-edited `request.options.autoAudit = "否"` overrides config `true` → adapter does NOT fire `/Material/Audit`
- [x] String `"true"` / `"是"` / numeric `1` for config or request all coerce to `true`
- [x] String `"false"` / `"否"` / numeric `0` all coerce to `false`
- [x] Empty string `""` treated as unset (falls back to config)
- [x] Both unset → default `false` (safe default for safety-relevant flags)
- [x] Invalid values (`"maybe"`, `NaN`, `2`) throw `AdapterValidationError` with field name in message
- [x] Existing 2 K3 adapter tests (testK3WebApiAdapter, testK3SqlServerChannel) pass unchanged

## Out of scope

- **`businessSuccess()` at line 210** — accepts K3 WISE response bool variants (true/false/'true'/'false'/1/0/'1'/'0'). Could be widened to include `'yes'` / `'success'` / `'OK'` etc., but K3 WISE's API contract is the source of truth here, not customer typing. Defer until we observe actual K3 WISE response variants in the wild.
- **`erp-feedback.cjs` strict equality** at lines 232/412/483 — these are pipeline configuration options sourced from REST API or stored config, lower hand-edit risk than adapter runtime. Defer.
- **`pipeline-runner.cjs` strict equality** at lines 156/202/203/311/408 — internal flags from REST API requests or feedback responses (server-controlled). No customer/operator string-coercion risk. Skip.
- **Refactor `coerceTriBool` / `coerceBoolOrUnset` into a shared helper** — would touch the audit-script trio (preflight + evidence) and risk collision with parallel codex sessions. The intentional local-duplication discipline keeps the adapter standalone in CJS-land.

## Why this completes the integration-core safety audit

After the evidence-script audit series (#1175, #1176, #1177, #1182) and this PR:

| Code area | Bug class | Status |
|---|---|---|
| `preflight.mjs` GATE answer parsing | Customer bool strings | ✅ #1168 / #1169 |
| `evidence.mjs` customer JSON | Customer bool strings | ✅ #1175 |
| `evidence.mjs` customer JSON | Customer numeric IDs | ✅ #1176 |
| `evidence.mjs` customer JSON | Customer status synonyms | ✅ #1177 |
| `evidence.mjs` operator hand-edits | Packet safety bools | ✅ #1182 |
| `k3-wise-webapi-adapter.cjs` runtime | Operator config + request bools | this PR |

This PR closes the symmetric gap on the *plugin-internal* adapter that handles the safety-critical lifecycle (Save → Submit → Audit). The customer-runnable scripts and the production adapter now share the same hardened coercion contract for boolean inputs.

## Cross-references

- PR #1175 — evidence bool sweep (introduced normalizeSafeBoolean pattern)
- PR #1176 — evidence numeric ID coercion
- PR #1177 — evidence status synonyms
- PR #1182 — evidence packet safety hand-edits
- PR #1168 / #1169 — preflight bool sweep (input side)
- PR #1152 — original K3 WISE WebAPI adapter ship
