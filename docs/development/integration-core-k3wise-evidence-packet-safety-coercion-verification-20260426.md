# K3 WISE Evidence Compiler Packet Safety Coercion · Verification

> Date: 2026-04-26
> Companion: `integration-core-k3wise-evidence-packet-safety-coercion-design-20260426.md`
> Closes the audit series: 4th and final hardening of `integration-k3wise-live-poc-evidence.mjs`

## Commands run

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
git diff --stat scripts/ops/integration-k3wise-live-poc-evidence.mjs \
                scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

## Result · `node --test`

```
✔ buildEvidenceReport returns PASS for complete Save-only evidence
✔ buildEvidenceReport returns PARTIAL when a required phase is missing
✔ buildEvidenceReport returns FAIL when Save-only row count exceeds PoC limit
✔ buildEvidenceReport returns FAIL when autoAudit appears in Save-only evidence
✔ buildEvidenceReport rejects unredacted secret-like evidence fields
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the string "true"
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoAudit is "yes" / "是" / "on" / "Y"
✔ buildEvidenceReport returns FAIL when bom.legacyPipelineOptionsSourceProductId is the string "true"
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the number 1 (spreadsheet boolean)
✔ buildEvidenceReport accepts the number 0 / string "no" / "否" / "false" as legitimate Save-only confirmation
✔ buildEvidenceReport throws clear errors for non-coercible boolean values
✔ buildEvidenceReport accepts numeric runId / productId from spreadsheet exports
✔ buildEvidenceReport accepts bigint productId for very large external IDs
✔ buildEvidenceReport still rejects NaN / Infinity / object / array / null as missing IDs
✔ buildEvidenceReport accepts numeric runId for materialSaveOnly evidence
✔ normalizeStatus accepts English pass-synonyms ("passed", "complete", "done", "ok", "success", "succeeded")
✔ normalizeStatus accepts Chinese pass-synonyms ("通过", "成功", "完成", "已完成", "已通过", "完毕")
✔ normalizeStatus accepts fail synonyms (English + Chinese)
✔ normalizeStatus accepts partial / blocked / skipped / todo synonyms
✔ normalizeStatus is case-insensitive ("PASSED" / "Failed" / "DONE")
✔ normalizeStatus still defaults unknown strings to "todo" (no over-acceptance)
✔ normalizeStatus synonym for fail in materialSaveOnly correctly skips Save-only safety checks
✔ requirePacketSafety accepts hand-edited string booleans for saveOnly / productionWriteBlocked
✔ requirePacketSafety accepts numeric 1 / 0 for safety fields (spreadsheet booleans)
✔ requirePacketSafety accepts Chinese boolean synonyms for safety fields
✔ requirePacketSafety still rejects autoSubmit truthy hand-edits (safety contract preserved)
✔ requirePacketSafety still rejects autoAudit truthy hand-edits (safety contract preserved)
✔ requirePacketSafety still rejects falsy saveOnly hand-edits (safety contract preserved)
✔ requirePacketSafety still rejects falsy productionWriteBlocked hand-edits
✔ requirePacketSafety throws with field-named error for non-coercible safety values
✔ CLI writes redacted JSON and Markdown reports

ℹ tests 31
ℹ pass 31
ℹ fail 0
ℹ duration_ms ~59
```

31/31 pass — was 23/23 before (PR #1177 baseline). +8 new tests, 0 regressions.

## New test coverage breakdown (8 added)

| # | Test | What it pins |
|---|---|---|
| 1 | `accepts hand-edited string booleans for saveOnly / productionWriteBlocked` | Headline fix: operator hand-types `"true"` for the truthy-required safety fields, no false-fail. |
| 2 | `accepts numeric 1 / 0 for safety fields (spreadsheet booleans)` | Spreadsheet exports / form tools commonly serialize booleans as 0/1. |
| 3 | `accepts Chinese boolean synonyms for safety fields` | `"是"` / `"否"` / `"启用"` / `"关闭"` work as expected. |
| 4 | `still rejects autoSubmit truthy hand-edits (safety contract preserved)` | 6 truthy variants (`true`, `"true"`, `"是"`, `1`, `"yes"`, `"on"`) all correctly fire the safety guard — safety must stay safe. |
| 5 | `still rejects autoAudit truthy hand-edits (safety contract preserved)` | Same shape, autoAudit field. |
| 6 | `still rejects falsy saveOnly hand-edits (safety contract preserved)` | 7 falsy variants (`false`, `"false"`, `"否"`, `0`, `"no"`, `"off"`, `""`) all correctly fire. |
| 7 | `still rejects falsy productionWriteBlocked hand-edits` | 5 falsy variants all correctly fire on the production-write field. |
| 8 | `throws with field-named error for non-coercible safety values` | `"maybe"` for saveOnly throws with `packet.safety.saveOnly` in `error.details.field` — no silent acceptance. |

## Existing test regression check

The 23 prior tests (5 from PR #1166 + 6 from PR #1175 + 4 from PR #1176 + 7 from PR #1177 + 1 CLI) all pass unchanged. The change is **additive in scope** — `requirePacketSafety` now accepts a wider input surface for the same predicate semantics. No existing input that passed before now fails, and no existing input that failed before now passes (other than the deliberately-fixed string/numeric coercion cases).

The `sampleEvidence` fixture and `packet()` helper produce real boolean values via `buildPacket()`, so the 5 baseline tests continue to exercise the boolean-passthrough code path.

## Manual code review checklist

- [x] No new helper added — reuses existing `normalizeSafeBoolean` from PR #1175. Zero duplication.
- [x] All 4 safety fields go through coercion (saveOnly, autoSubmit, autoAudit, productionWriteBlocked).
- [x] Predicate semantics unchanged — `!saveOnly || autoSubmit || autoAudit` is logically equivalent to the original `saveOnly !== true || autoSubmit !== false || autoAudit !== false` for all real-boolean inputs.
- [x] Error messages preserved verbatim — same `'preflight packet must be Save-only...'` and `'preflight packet must explicitly block production writes'`.
- [x] Field names in error details now point to the SPECIFIC bad field (`packet.safety.saveOnly`) when normalization throws, not just `packet.safety` — better operator UX during incident response.
- [x] Inline comment explains *why* (operator hand-edits during incident response) and *what stays safe* (predicate unchanged, coercion only widens input surface).
- [x] No new dependencies, no schema change, no contract change for the preflight script (which still emits real booleans).

## Why this completes the audit series

Tracking the 4 named deferred items from PR #1175's design doc:

| Item | PR | Status |
|---|---|---|
| Customer-supplied bool strings (`autoSubmit`, `autoAudit`, `legacyPipelineOptionsSourceProductId`) | #1175 | ✅ Merged 2026-04-25 |
| Customer-supplied numeric IDs (`text()` for `productId`, `runId`) | #1176 | ✅ Merged 2026-04-26 |
| Customer-supplied status synonyms (`normalizeStatus`) | #1177 | ✅ Merged 2026-04-26 |
| Operator hand-edited packet bools (`requirePacketSafety`) | this PR | ✅ Tests 31/31 green; awaiting merge |

Two remaining items from #1175's "out of scope" list are intentionally NOT addressed:
- `findSecretLeaks` non-string scanning — edge case; tokens are strings in practice; not worth dedicated PR
- Refactor `normalizeSafeBoolean` / `STATUS_SYNONYMS` into a shared module — would touch preflight, collision risk with parallel codex sessions

After this PR, both customer-facing K3 WISE Live PoC scripts (`preflight.mjs` + `evidence.mjs`) are fully hardened against the realistic edge cases of customer-typed and operator-typed JSON. The next gate is the customer's GATE answer email, which gates M2-LIVE-T01..T07 and M3 UI build-out.

## Cross-references

- Design doc: `docs/development/integration-core-k3wise-evidence-packet-safety-coercion-design-20260426.md`
- Predecessor: PR #1177 (status synonyms, commit `a60819511`)
- Series origin: PR #1175 (bool sweep, design doc enumerated all 4 deferred items)
- Symmetric work: PR #1168 / #1169 (preflight bool-coercion sweep)
