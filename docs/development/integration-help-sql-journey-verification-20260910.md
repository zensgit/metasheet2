# Integration help center: terminology + SQL-source journey (verification, 2026-09-10)

## Scope of change
`apps/web/src/views/IntegrationHelpView.vue` (228 → 610 lines) and
`apps/web/tests/IntegrationHelpView.spec.ts` (116 → 203 lines) only. No other file touched.

## Commands run (verbatim results)
- `pnpm install --frozen-lockfile --offline` — `Done in 2m 38.8s using pnpm v9.15.9` (node_modules
  did not exist in this worktree at task start; installed once, needed).
- `pnpm --filter web exec vitest run tests/IntegrationHelpView.spec.ts` — clean run:
  `Test Files  1 passed (1)` / `Tests  11 passed (11)`. (Vue warns about unresolved `el-card`/
  `el-icon`/`el-button` are pre-existing — this bare test harness never registers Element Plus,
  same as before this change.)
- `pnpm --filter web run type-check` (`vue-tsc -b` + the two verification tsconfig projects) —
  exit code 0, no errors.

## Fake-green check on `type-check`
Per the standing lesson that `vue-tsc` can pass green without actually checking a file: temporarily
set `termEn: 12345` (a number) on one `GlossaryEntry` inside `IntegrationHelpView.vue` and re-ran
`pnpm --filter web run type-check`. Result:
`src/views/IntegrationHelpView.vue(237,5): error TS2322: Type 'number' is not assignable to type
'string'.` — confirms the file is genuinely type-checked, not skipped. Reverted (`cp` from a
pre-mutation backup) and confirmed byte-identical via `diff`, then re-ran type-check clean.

## Mutation probes (in-memory edit → run → revert; nothing shipped)
1. **Glossary row-count tripwire**: deleted the `dead-letter` entry from
   `INTEGRATION_HELP_GLOSSARY` (array literal edit only, DOM v-for untouched). Re-ran the spec:
   `glossary table renders one row per INTEGRATION_HELP_GLOSSARY entry (single-source, row-count
   tripwire)` went red (`1 failed | 10 passed`), because that test hardcodes `expect(
   INTEGRATION_HELP_GLOSSARY.length).toBe(7)` — a literal, not a value re-derived from the same
   array, so it cannot trivially agree with a shrunk array. Reverted, diffed identical, reran green.
2. **Error-code single-source tripwire** (pre-existing assertion, not touched): inserted one
   hardcoded `<tr>` (`HARDCODED_MUTATION_PROBE`) into the error-code table's `<tbody>`, alongside
   the existing `v-for`. Re-ran the spec: `error-code table row count equals the label module
   registered code count (single-source tripwire)` went red (`1 failed | 10 passed`), because
   rendered row count (N+1) no longer equals `integrationErrorCodeEntries().length` (N). Reverted,
   diffed identical, reran green — confirms this existing guardrail was not weakened by the new
   sections sharing the same card/table CSS classes.

## Deliberate wording fix caught by self-review before shipping
An early draft of case two's step 4 action text read "...there is no write-back-to-K3 option..."
— this literally contains the substring sequence "write" → "back" → "K3", which is exactly the
pattern the test's negative assertion (`not.toMatch(/write.{0,40}back.{0,40}k3/i)`) exists to
reject, even though the sentence *negates* writing back. Reworded to "...a dry-run here never
turns into a save into K3..." to state the same fact without tripping the guardrail on its own
copy; verified by re-running the spec (still 11/11 green) rather than weakening the assertion.

## Not independently re-verified in this pass
- `pnpm --filter web run type-check:verification-approval` /
  `:verification-stock-prep` ran as part of the `type-check` chain above but were not separately
  fake-green-probed (only the main `vue-tsc -b` pass was probed with the injected type error,
  since `IntegrationHelpView.vue` is not part of either verification tsconfig project's likely
  narrow include set — not confirmed either way).
- No visual/browser smoke test (e.g. a nginx-served frontend check) was run; this is a docs/copy-only
  page change with no build-time asset path dependency, unlike the MSYS base-path class of bug.
