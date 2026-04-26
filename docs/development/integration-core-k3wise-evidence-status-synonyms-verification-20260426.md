# K3 WISE Evidence Compiler Status Synonym Map · Verification

> Date: 2026-04-26
> Companion: `integration-core-k3wise-evidence-status-synonyms-design-20260426.md`
> Stacked on: PR #1176 (text() numeric coercion)

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
✔ CLI writes redacted JSON and Markdown reports

ℹ tests 23
ℹ pass 23
ℹ fail 0
ℹ duration_ms ~58
```

23/23 pass — was 16/16 before (PR #1176 baseline). +7 new tests, 0 regressions.

## New test coverage breakdown (7 added)

| # | Test | What it pins |
|---|---|---|
| 1 | `accepts English pass-synonyms` | 8 variants (`passed`, `complete`, `completed`, `done`, `ok`, `success`, `successful`, `succeeded`) all map to `'pass'`. Headline fix for English-speaking customers. |
| 2 | `accepts Chinese pass-synonyms` | 6 variants (`通过`, `成功`, `完成`, `已完成`, `已通过`, `完毕`) all map to `'pass'`. Headline fix for Chinese customers. |
| 3 | `accepts fail synonyms (English + Chinese)` | 7 variants from both languages map to `'fail'`. Symmetry: just as silent-todo on completed phases is bad, silent-todo on failed phases hides actual failures. |
| 4 | `accepts partial / blocked / skipped / todo synonyms` | 12 variants covering the remaining 4 canonical statuses. Mixed Chinese/English. |
| 5 | `is case-insensitive ("PASSED" / "Failed" / "DONE")` | Confirms the pre-existing `.toLowerCase()` chain still works for the new synonym map. Customers often write status in all-caps or title-case. |
| 6 | `still defaults unknown strings to "todo" (no over-acceptance)` | Defensive: `maybe`, `xxxxx`, `random-junk`, `不确定`, `unknown` still default to `'todo'`. The synonym map expands the accepting set but does NOT silently accept everything. |
| 7 | `synonym for fail in materialSaveOnly correctly skips Save-only safety checks` | Critical safety pin: `materialSaveOnly.status = '失败'` + `autoSubmit = true` does NOT raise `SAVE_ONLY_VIOLATED`. The Save-only safety check only matters for runs that actually wrote data; failed runs correctly skip the check. Pins the interaction between the synonym map and the safety contract. |

## Existing test regression check

The 16 prior tests (5 from PR #1166 + 6 from PR #1175 + 4 from PR #1176 + 1 CLI) all pass unchanged. The change is **additive**:

- `VALID_STATUSES` set unchanged. Canonical statuses still match first.
- `STATUS_SYNONYMS` map is new. Consulted only after canonical check fails.
- Final fallback to `'todo'` unchanged.

The only behavior change is for inputs that previously fell through to `'todo'` and are now in the synonym map — for those, behavior changes from `'todo'` to the correct canonical (which is what the customer meant in the first place).

## Manual code review checklist

- [x] Synonym map is exhaustive enough for realistic customer input but not over-broad — every entry has a clear, unambiguous mapping (no `"pass"` synonym that could also mean `"fail"`).
- [x] Both English and Chinese synonyms covered for each canonical status, since both are realistic customer surfaces.
- [x] `.toLowerCase()` is applied before lookup, so case variants of English synonyms work; Chinese characters are unaffected by toLowerCase (no-op).
- [x] No new error paths — `normalizeStatus` remains pure with same return contract.
- [x] No throws — synonym map adds no new failure modes.
- [x] Fallback to `'todo'` preserved — guarantees no silent over-acceptance.
- [x] Inline comment explains *why* (customer evidence often uses synonyms, silent `'todo'` flips correct phases to false PARTIAL).
- [x] Safety-critical interaction tested explicitly: synonym-mapped `'fail'` status on `materialSaveOnly` correctly bypasses Save-only safety checks.

## Why stacked on PR #1176

PR #1176 (numeric ID coercion) and this PR both touch `evidence.mjs` in customer-input ergonomics. Stacking allows:

- This branch can be reviewed and CI-validated *during* #1176's review, not after, halving the wall-clock time for the audit series.
- Both PRs share the same theme (customer-input edge cases) so reviewing them together provides better context.
- After #1176 merges, this branch rebases cleanly onto main with no conflicts (only different functions touched within the same file).

If #1176 is rejected or substantially changed, this branch rebases against the new main and continues independently — the synonym-map change has no functional dependency on the numeric-coercion change.

## Cross-references

- Design doc: `docs/development/integration-core-k3wise-evidence-status-synonyms-design-20260426.md`
- Predecessor PR: #1176 (text() numeric coercion — design doc deferred this exact item)
- Predecessor PR: #1175 (bool sweep — first design doc that flagged status synonyms as out-of-scope)
- Original ship: #1166 (evidence compiler v1)
- Symmetric work: #1168 / #1169 (preflight bool-coercion sweep)
