# K3 WISE Evidence Compiler Status Synonym Map · Design

> Date: 2026-04-26
> Picked up from: PR #1175 / #1176 "out of scope" lists
> Stacked on: PR #1176 (text() numeric coercion)
> Predecessors: PR #1175 (bool sweep), PR #1168 / #1169 (preflight)

## Problem

The evidence compiler's `normalizeStatus()` accepts only the canonical 6 statuses (`pass`, `partial`, `fail`, `skipped`, `todo`, `blocked`) and silently defaults *anything else* to `'todo'`:

```javascript
function normalizeStatus(value) {
  const status = text(value).toLowerCase()
  return VALID_STATUSES.has(status) ? status : 'todo'
}
```

Customer evidence JSON is hand-written or exported from spreadsheets / form tools. Customers regularly write phase status using natural-language synonyms — English `"passed"` / `"complete"` / `"done"` or Chinese `"成功"` / `"通过"` / `"完成"`. Each of these silently becomes `'todo'`, which:

1. **Flips a completed phase into a false PARTIAL decision.** A customer who finished GATE answers + connection tests + dry-run + Save-only correctly, but used `"passed"` instead of `"pass"` for status fields, gets a PARTIAL report saying their phases are `"todo"` (incomplete). They have no way to tell from the report what's wrong (the synonym error isn't raised — it's silent).
2. **Erodes trust in the compiler.** Customers see "you said it's incomplete" when they know it's complete; they assume the compiler is broken or overly strict.

This is the third item from PR #1175's "out of scope" list, and PR #1176 deferred it again as the next narrow follow-up.

## Solution

Add a `STATUS_SYNONYMS` map and consult it in `normalizeStatus()` after the canonical-set check:

```javascript
const STATUS_SYNONYMS = new Map([
  // pass synonyms (English + Chinese)
  ['passed', 'pass'], ['passing', 'pass'], ['complete', 'pass'], ['completed', 'pass'],
  ['done', 'pass'], ['ok', 'pass'], ['success', 'pass'], ['successful', 'pass'], ['succeeded', 'pass'],
  ['通过', 'pass'], ['成功', 'pass'], ['完成', 'pass'], ['已完成', 'pass'], ['已通过', 'pass'], ['完毕', 'pass'],
  // fail synonyms
  ['failed', 'fail'], ['fails', 'fail'], ['error', 'fail'], ['errored', 'fail'], ['failure', 'fail'],
  ['失败', 'fail'], ['失败了', 'fail'], ['错误', 'fail'], ['出错', 'fail'],
  // partial synonyms
  ['partially', 'partial'], ['in-progress', 'partial'], ['in progress', 'partial'], ['inprogress', 'partial'],
  ['ongoing', 'partial'], ['working', 'partial'],
  ['进行中', 'partial'], ['部分通过', 'partial'], ['部分', 'partial'],
  // skipped synonyms
  ['skip', 'skipped'], ['n/a', 'skipped'], ['na', 'skipped'], ['not applicable', 'skipped'],
  ['跳过', 'skipped'], ['不适用', 'skipped'],
  // blocked synonyms
  ['stuck', 'blocked'], ['waiting', 'blocked'], ['hold', 'blocked'], ['on hold', 'blocked'], ['on-hold', 'blocked'],
  ['阻塞', 'blocked'], ['卡住', 'blocked'], ['等待中', 'blocked'],
  // todo synonyms
  ['pending', 'todo'], ['queued', 'todo'], ['planned', 'todo'], ['not started', 'todo'], ['not-started', 'todo'],
  ['待办', 'todo'], ['待做', 'todo'], ['未开始', 'todo'], ['未做', 'todo'],
])

function normalizeStatus(value) {
  const status = text(value).toLowerCase()
  if (VALID_STATUSES.has(status)) return status
  if (STATUS_SYNONYMS.has(status)) return STATUS_SYNONYMS.get(status)
  return 'todo'
}
```

### Coercion table (representative subset)

| Customer input | Mapped status | Why |
|---|---|---|
| `"pass"` / `"PASS"` | `'pass'` | Canonical (case-insensitive via toLowerCase) |
| `"passed"` / `"complete"` / `"done"` / `"ok"` | `'pass'` | English synonyms |
| `"成功"` / `"通过"` / `"完成"` / `"已完成"` | `'pass'` | Chinese synonyms |
| `"failed"` / `"error"` / `"errored"` | `'fail'` | English |
| `"失败"` / `"错误"` / `"出错"` | `'fail'` | Chinese |
| `"partially"` / `"in-progress"` / `"ongoing"` | `'partial'` | English |
| `"进行中"` / `"部分"` / `"部分通过"` | `'partial'` | Chinese |
| `"on-hold"` / `"waiting"` / `"stuck"` | `'blocked'` | English |
| `"阻塞"` / `"卡住"` / `"等待中"` | `'blocked'` | Chinese |
| `"skip"` / `"n/a"` / `"not applicable"` | `'skipped'` | English |
| `"跳过"` / `"不适用"` | `'skipped'` | Chinese |
| `"pending"` / `"planned"` / `"not started"` | `'todo'` | English |
| `"待办"` / `"未开始"` / `"未做"` | `'todo'` | Chinese |
| `"maybe"` / `"xxx"` / `"random"` | `'todo'` | Unknown — defaults to safe `'todo'` |

The fallback to `'todo'` for unknown strings is preserved — synonyms expand the accepting set, but unrecognized inputs still produce the safe-incomplete status that the compiler then treats as a missing-evidence signal. No over-acceptance.

## Why this safe-by-design

The synonym map is **strictly an expansion** of the accepting set:
- All 6 canonical statuses still work via the existing `VALID_STATUSES.has(status)` check (first).
- Synonyms layer on top via the new `STATUS_SYNONYMS.has(status)` check (second).
- Unknown inputs still fall through to `'todo'` (third).

Existing behavior for canonical statuses is identical. Existing behavior for genuinely unknown inputs is identical. Only the previously-incorrectly-todo'd synonyms change behavior — and they change to the *correct* mapping.

Crucially, this does NOT weaken any safety check:
- `evaluateMaterialSaveOnly` still calls `normalizeStatus(save.status)` and skips Save-only safety checks only when status is non-`'pass'`. With synonyms, more inputs map to `'pass'` (correctly), so safety checks fire in *more* cases (the desired behavior — silent `'todo'` was previously bypassing them on completed runs).
- `evaluateBom` similarly returns early on non-`'pass'`. Same logic: synonyms mapping to `'pass'` correctly trigger BOM evaluation.

A test in this PR explicitly verifies that `'失败'` (a fail synonym) on `materialSaveOnly` correctly skips the Save-only safety checks (since the run failed and there's no data to safety-check), pinning the safety contract.

## Files changed

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — `STATUS_SYNONYMS` Map added + `normalizeStatus()` extended (~25 lines added)
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` — 7 new test cases (~85 lines added)
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` reports 23/23 pass (was 16/16, +7 new)
- [x] English pass-synonyms (`passed`, `complete`, `completed`, `done`, `ok`, `success`, `successful`, `succeeded`) → `'pass'`
- [x] Chinese pass-synonyms (`通过`, `成功`, `完成`, `已完成`, `已通过`, `完毕`) → `'pass'`
- [x] Fail synonyms (English + Chinese) → `'fail'`
- [x] Partial / blocked / skipped / todo synonyms (English + Chinese) → expected canonical
- [x] Case-insensitive (`PASSED`, `Failed`, `DONE`) → expected canonical
- [x] Genuinely unknown strings (`maybe`, `xxxxx`, `不确定`) STILL default to `'todo'` — no over-acceptance
- [x] Fail synonym on `materialSaveOnly.status` correctly skips Save-only safety checks (does NOT raise SAVE_ONLY_VIOLATED on a failed run)
- [x] All 16 prior tests pass unchanged (no regression)

## Out of scope

Same audit-style discipline:

- **`requirePacketSafety` strict equality** at lines 94-96 — still deferred. Reads from preflight-canonicalized packet; safe IF customer doesn't hand-edit. Paranoid hardening, separate PR.
- **`findSecretLeaks` non-string scanning** — still deferred. Edge case, low ROI.
- **Refactor synonyms into a shared dictionary module** — would touch preflight too, collision risk with parallel codex sessions, kept local.
- **Allow customer-defined synonyms via config** — out of scope; the built-in map covers the realistic Chinese/English customer surface.

## Cross-references

- PR #1176 — text() numeric ID coercion (this PR's predecessor; deferred this exact item)
- PR #1175 — evidence bool-coercion sweep (predecessor's predecessor; first deferred this item)
- PR #1166 — original evidence compiler ship
- PR #1168 / #1169 — preflight bool-coercion sweep (input side)
