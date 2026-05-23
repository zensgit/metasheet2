# Attendance comprehensive-hours PR5 strong-control design lock - 2026-05-23

## Lineage

| Step | PR | State |
| --- | --- | --- |
| PR0 RFC | `attendance-comprehensive-hours-control-rfc-20260522.md` | merged |
| PR1 helpers | #1770 | merged |
| PR2 preview route | #1774 | merged |
| PR2.5 invalid enum reject | #1776 | merged |
| PR3 admin preview UI | #1777 | merged |
| PR4 design lock | #1778 | merged |
| PR4 runtime weak-control | #1790 | merged + production smoke PASS + staging E2E PASS (#1795) |
| **PR5 design lock** | **this MD** | **in progress** |
| PR5 runtime strong-control | (paired implementation PR) | in progress |
| PR6 reporting | (out of scope) | deferred |

PR5 is the **explicit opt-in** strong-control slice deferred by the #1778 PR4
design lock. The user opted in at 2026-05-23 after PR4 production smoke and
staging E2E both PASS. Scope was bounded by the user as "frontend save-chain
strong-control only; no new backend route; no preview compute change; no
migration; no `meta_*` write".

## Goal

Add a deliberately-toggled strong-control mode that **blocks the assignment
save call** when the existing read-only comprehensive-hours preview returns
`aggregate.status === 'violation'`. Default behavior remains the PR4
weak-control advisory. The mode is per-session, not persisted.

## Hard Boundaries

| Boundary | Requirement |
| --- | --- |
| **Default off** | The strong-control mode must default to off so that PR4 weak-control remains the out-of-box behavior. |
| **Frontend only** | All save-chain enforcement happens in the frontend. No backend route, no plugin route, no middleware change, no migration. |
| **Reuse existing preview route** | The preview call must continue to use `POST /api/attendance/comprehensive-hours/preview`. No new endpoint. |
| **Reuse existing payload contract** | `metric: 'planned'`, single `userId`, `period.type: 'custom_range'`, no `allUsers`. The only payload change is `enforcement` becoming `'block'` when strong-control mode is on; that value is already accepted by the existing route per #1776. |
| **No policy persistence** | Mode is held in a Vue ref. No localStorage, no DB write, no settings/catalog row. Reloading the page resets to default off. |
| **No preview compute change** | The backend preview classification logic is not modified. The frontend interprets `aggregate.status` exactly as today; only the consequence of `violation` changes. |
| **Preview failure never blocks** | If the preview returns 4xx/5xx, network error, or degraded data, the save MUST proceed. Strong-control only fires on a successful preview that classifies as `violation`. |
| **PR4 weak behavior preserved** | When mode is off, the existing PR4 weak-control flow is byte-for-byte identical (same advisory copy, same payload, same call ordering, same save-always semantics). |
| **No reuse of preview-form enforcement field** | The existing `comprehensiveHoursPreviewForm.enforcement` field (added in #1777) explicitly documents "Mode only changes preview status. It is not persisted and does not enforce saves." PR5 MUST NOT silently change that contract. PR5 adds a separate, clearly-labeled toggle. |
| **Inactive assignment skip preserved** | When the assignment form has `isActive: false`, the preview call is skipped entirely (same as PR4). Strong-control therefore does not block inactive draft saves. |
| **No allUsers** | The save-time preview payload never carries an `allUsers` field. |
| **Both surfaces** | Shift assignment save and rotation assignment save are both governed by the same mode. |
| **Banned UX copy** | Block-state advisory copy must not use PR5-style language verbatim — wait, this is **PR5** so block-state copy is now allowed, but only for the block-state. Other states (warn/violation in weak mode, degraded, error) must keep the PR4 "Saving is still allowed in this stage" wording unchanged. |

## State design

Add a new top-level ref and extend the existing advisory discriminator.

| Identifier | Type | Default | Purpose |
| --- | --- | --- | --- |
| `comprehensiveHoursSaveBlockMode` | `Ref<boolean>` | `false` | When `true`, save-time advisory uses `enforcement: 'block'` and blocks save on `violation`. When `false`, PR4 weak behavior. |
| `AttendanceComprehensiveHoursAssignmentAdvisory['kind']` | `'info' \| 'warn' \| 'error' \| 'block'` | (n/a) | Adds `'block'` discriminator so the UI can render the block-state advisory distinctly. |

Per-kind block flag is not stored — the save handler reads the current
advisory's `kind` to decide whether to abort. This avoids state-doubling
between the advisory object and a separate boolean.

## API contract changes

None on the backend.

On the frontend, the advisory function's return type changes from `Promise<void>`
to `Promise<{ blocked: boolean }>`:

```ts
async function previewComprehensiveHoursAssignmentAdvisory(
  kind: AttendanceComprehensiveHoursAssignmentKind,
  draft: { userId: string; startDate: string; endDate: string | null; isActive: boolean },
): Promise<{ blocked: boolean }>
```

Callers (`saveAssignment`, `saveRotationAssignment`) check the `blocked`
field and `return` early without calling the save endpoint when `blocked === true`.

## Behavior matrix

Mode = `weak` (PR4, default off). The first 5 rows are unchanged from #1790.

| Mode | Preview result | Advisory kind | Save call | Status text after |
| --- | --- | --- | --- | --- |
| weak | `ok` | none | runs | `Assignment created.` / `Rotation assignment created.` |
| weak | `warning` | `warn` | runs | success text |
| weak | `violation` | `warn` | runs | success text |
| weak | `degraded` | `warn` | runs | success text |
| weak | HTTP 400/503/network/parse error | `error` | runs | success text |
| strong | `ok` | none | runs | success text |
| strong | `warning` | `warn` | runs | success text |
| strong | `violation` | **`block`** | **does NOT run** | error-style text: `Comprehensive-hours strong-control: save blocked because planned minutes exceed the cap. Disable strong-control to override.` |
| strong | `degraded` | `warn` | runs | success text (preview-failure-never-blocks holds) |
| strong | HTTP 400/503/network/parse error | `error` | runs | success text |

Inactive assignment (any mode): preview call skipped, no advisory, save runs.

## Payload contract

The preview request body is constructed identically to PR4 except for the
`enforcement` value:

```json
{
  "policyDraft": {
    "capHours": <admin-form value or 160>,
    "enforcement": "<warn (weak) | block (strong)>"
  },
  "scope": { "userId": "<assignment-user-id>" },
  "period": {
    "type": "custom_range",
    "from": "<assignment-start-date>",
    "to": "<assignment-end-date-or-start-date>"
  },
  "metric": "planned"
}
```

All other invariants from PR4 hold:

- `metric` is hardcoded `planned`.
- `scope` is a single explicit `userId`.
- `allUsers` is never present.
- Period is `custom_range` from the assignment dates (open-ended uses
  `from` for both `from` and `to`).

## UX copy

### New strong-control block-state copy

| Language | Copy |
| --- | --- |
| EN | `Comprehensive-hours strong-control: save blocked because planned minutes exceed the cap. Disable strong-control to override.` |
| ZH | `综合工时强管控：计划工时已超过上限，保存已被拦截；关闭强管控可临时放行。` |

The block-state copy explicitly tells the admin how to override (toggle off),
so the gate is never a dead-end. This is intentional — PR5 is admin-facing
strong control, not employee-facing hard wall.

### Preserved PR4 copy (must not regress)

The other advisory messages keep the exact PR4 wording. Specifically the
sentinel phrase `Saving is still allowed in this stage` / `当前阶段仍允许保存`
remains on:

- weak-mode warning advisory
- weak-mode violation advisory
- both modes' degraded advisory
- both modes' preview-error advisory

### Banned copy (anti-regression)

The block-state copy may use the word `blocked` because that is the literal
state, but the other advisory states MUST NOT introduce any of:

| Banned in non-block states | EN | ZH |
| --- | --- | --- |
| | `cannot save` | `禁止保存` |
| | `policy enforced` | `已强制策略` |
| | `violation prevented` | `已阻止违规` |

This list is verified by the test suite via bundle/test-output grep with
status-kind ≠ `block`.

## UI surface

A new control is added to the existing `attendance-admin-comprehensive-hours-preview`
admin section, **below** the existing read-only preview controls so admins
encounter it as an explicit extension rather than a silent override.

```html
<label
  class="attendance__field attendance__field--checkbox"
  data-attendance-comprehensive-hours-save-block-mode
>
  <input
    type="checkbox"
    id="attendance-comprehensive-hours-save-block-mode"
    v-model="comprehensiveHoursSaveBlockMode"
  />
  <span>{{ tr('Save-time strong control', '保存时强管控') }}</span>
  <small class="attendance__field-hint">
    {{ tr(
      'When enabled, shift and rotation assignment saves are blocked if the comprehensive-hours preview returns a violation. Preview errors never block saves.',
      '启用后，若综合工时预览返回违规，将拦截班次和轮班分配保存；预览失败不会拦截保存。'
    ) }}
  </small>
</label>
```

Additionally, the existing `comprehensiveHoursPreviewForm.enforcement` field's
hint copy is **lightly updated** to disambiguate the two enforcement concepts:

| Field | Before | After |
| --- | --- | --- |
| `Policy mode` (preview-form enforcement) hint | "Mode only changes preview status. It is not persisted and does not enforce saves." | "Mode only changes preview status. It is not persisted. See 'Save-time strong control' below to enable save blocking." |

Same hint update in Chinese.

This is a docs-style tweak inside the same section; not a behavior change.

## Test requirements

The vitest test suite must cover the 9 user-listed assertions plus one
regression. Each row is a separate `it(...)` or a clear assertion block within
a shared one.

| # | Assertion | Mode | Preview result | Save endpoint called? | Advisory kind |
| --- | --- | --- | --- | --- | --- |
| T1 | weak mode after warning | weak | `warning` | yes | `warn` |
| T2 | weak mode after violation | weak | `violation` | yes | `warn` |
| T3 | strong mode blocks on violation | strong | `violation` | **no** | `block` |
| T4 | strong mode allows on warning | strong | `warning` | yes | `warn` |
| T5 | strong mode allows on ok | strong | `ok` | yes | none |
| T6 | weak mode preview 503 → save runs | weak | HTTP 503 | yes | `error` |
| T7 | strong mode preview 503 → save runs | strong | HTTP 503 | yes | `error` |
| T8 | inactive assignment skips preview | weak or strong | n/a (not called) | yes | none |
| T9 | payload contract across modes | both | n/a (asserts body shape) | n/a | n/a |
| T10 (regression) | strong mode banned-language scan | strong | various | n/a | n/a |

T8 covers both `weak` and `strong` paths to confirm `isActive: false` shorts
out the preview before mode is consulted.

T9 explicitly asserts in both modes:

- `body.metric === 'planned'`
- `typeof body.scope.userId === 'string'`
- `!('allUsers' in body)`
- `body.period.type === 'custom_range'`
- `body.policyDraft.enforcement` is `'warn'` in weak mode and `'block'` in strong mode

T10 scans the rendered assignment-section DOM after strong-mode violation for
the absence of `cannot save`, `policy enforced`, `violation prevented`,
`禁止保存`, `已强制策略`, `已阻止违规` — but allows the word `blocked` in
the block-state advisory text (it is the legitimate state name).

Both shift and rotation save surfaces must be covered for at least T1, T2,
T3, T4, T6, T7.

## Out-of-scope reaffirmation

- ❌ No backend route changes (verify with `grep "addRoute(" -r plugins/plugin-attendance`).
- ❌ No `attendance_*` migrations.
- ❌ No `meta_*` writes.
- ❌ No policy persistence (no localStorage, no settings row).
- ❌ No change to preview compute logic on the backend.
- ❌ No new endpoint.
- ❌ No K3 / Data Factory / Bridge Agent touch.
- ❌ No `allUsers` mode.
- ❌ No PR6 reporting work.

## Deferred to PR6 or later

- Per-org / per-tenant default for the strong-control toggle.
- Persistence of the toggle across sessions.
- Time-bound or role-bound auto-enforcement (e.g. "strong-control auto-on for HR director").
- Block-state escalation hook (e.g. require approval to override).
- Strong-control on bulk / multi-user save flows (not present today).
- Block-state metrics / audit trail.

## References

- #1778 — PR4 design lock (`docs/development/attendance-comprehensive-hours-control-pr4-warning-design-20260522.md`).
- #1790 — PR4 runtime weak-control.
- #1795 — PR4 staging E2E PASS evidence.
- `[[k3-poc-stage1-lock-no-new-fronts]]` — internal kernel-polish; this PR sits in the authorized 内核打磨 lane.
- `[[staged-optin-lineage]]` — each PR in this chain is a separate explicit user opt-in.
