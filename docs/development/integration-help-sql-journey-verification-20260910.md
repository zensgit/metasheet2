# Integration help center: terminology + SQL-source journey (verification, 2026-09-10)

## Scope of change
`apps/web/src/views/IntegrationHelpView.vue` and `apps/web/tests/IntegrationHelpView.spec.ts` only
(plus this doc pair). No other file touched — confirmed by `git status --short` after every probe.

## Round 1 (initial landing)
- `pnpm install --frozen-lockfile --offline` — `Done in 2m 38.8s using pnpm v9.15.9` (node_modules
  did not exist in this worktree at task start; installed once, needed).
- `pnpm --filter web exec vitest run tests/IntegrationHelpView.spec.ts` — clean run:
  `Test Files  1 passed (1)` / `Tests  11 passed (11)`. (Vue warns about unresolved `el-card`/
  `el-icon`/`el-button` are pre-existing — this bare test harness never registers Element Plus,
  same as before this change.)
- `pnpm --filter web run type-check` (`vue-tsc -b` + the two verification tsconfig projects) —
  exit code 0, no errors.
- Fake-green check: temporarily set `termEn: 12345` on one `GlossaryEntry`; `type-check` reported
  `src/views/IntegrationHelpView.vue(237,5): error TS2322: Type 'number' is not assignable to type
  'string'.` Reverted and confirmed byte-identical.
- Mutation probes (reverted): deleting the `dead-letter` glossary entry turned the row-count
  tripwire red (`1 failed | 10 passed`); inserting a hardcoded `<tr>` into the error-code `<tbody>`
  turned the single-source tripwire red (`1 failed | 10 passed`).

## Round 2 (review finding P2 #5613 — "帮助中心描述了走不通的操作链")
Two claims were rewritten against their real producers (chains in the design doc):
1. Case one no longer tells the reader to type placeholders into the real data-source form. It now
   says fill REAL values, names the greys as HTML `placeholder` ATTRIBUTES, confines angle-bracket
   placeholders to docs/screenshots/evidence, and states the asymmetry that makes this matter:
   「测试连接」 dials (ephemeral `POST /api/data-sources/test`), 「创建」 does not
   (`addDataSourceInternal(config, false)`), so **saved ≠ reachable**.
2. Case two no longer says the dry-run "only reads K3" or that "open the multi-dimensional table"
   saves the preview. It now describes PLM read → K3 payload preview (`previewUpsert`, composed
   locally, no `login()`, no request) → 「打开多维表」 as a `<router-link>` that persists nothing.

### Commands (verbatim results)
- `pnpm install --frozen-lockfile --prefer-offline` — exit 0 (node_modules absent again in this
  worktree at task start).
- `npx vitest run tests/IntegrationHelpView.spec.ts --root apps/web --reporter=basic` —
  `Test Files  1 passed (1)` / `Tests  20 passed (20)` (11 → 20; the 9 new tests are listed below).
- `npx vue-tsc -b --force` (in `apps/web`) — exit 0.
- `npx vue-tsc --noEmit -p tsconfig.verification-approval.json` — exit 0.
- `npx vue-tsc --noEmit -p tsconfig.verification-stock-prep.json` — exit 0.
- Fake-green check on `vue-tsc`, re-done for the rewritten file: set `id: 12345` on the first
  walkthrough step → `src/views/IntegrationHelpView.vue(339,5): error TS2322: Type 'number' is not
  assignable to type 'string'.`, exit 2. Reverted from a byte backup and `diff`-confirmed identical,
  then re-ran clean (exit 0).

### New assertions (why each exists)
| Test | Pins |
| --- | --- |
| every walkthrough step maps to real source: all declared anchors resolve | all 44 `anchors` (file + literal token) are `readFileSync`-checked against the real producer files; `allSteps.length` is a hardcoded `12` mutation probe |
| every walkthrough step renders its code anchors in the page | the anchors reach the reader, not just the imported constant |
| case one tells the reader to use REAL values …never instructs typing placeholders into it | both locales; rejects `use placeholders` / `never real values` / `用占位符，不要填真实值` |
| case one separates "saved" from "reachable", and the producer chain still backs that claim | `addDataSource` body still calls `addDataSourceInternal(config, false)`; both POST call sites still exist in `data-sources/api.ts` |
| case two describes the real PLM → K3 direction, and the pipeline builder still produces it | `buildK3WisePipelinePayloads` still binds `sourceSystemId = form.sourceSystemId` / `targetSystemId = form.webApiSystemId`; copy may not say "only reads K3" |
| case two: the K3 dry-run preview path contains no write call (source-level) | `attachDryRunTargetPreview` uses `previewUpsert` and not `upsert`; **exactly one** real `targetAdapter.upsert(` call site in the runner and it sits behind `if (!dryRun && cleanRecords.length > 0)`; the K3 adapter's `previewUpsert` body has no `login(` / `requestJson(` / `fetch(`; the permanent fence is still wired |
| case two: the "open the multi-dimensional table" control is navigation only (source-level) | the markup is a `<router-link :to="target.openLink">` with no `@click`; `buildStagingOpenTargets` / `buildMultitableOpenLink` bodies contain no `await` / `apiFetch(` / `fetch(` / write method; the link is computed from `stagingInstallResult`, not from a run result |
| case one states the dry-run persistence facts the runner actually implements | `writeDeadLetter` still returns early on `input.dryRun`; `runLogger.startRun` is still called unconditionally with `dryRun` in its details |
| the walkthrough sections print no error code outside the single-source table | keeps `errorCodeLabels.ts` the ONE source of code text (the constraint was not relaxed) — any SCREAMING_SNAKE token in either case section must be registered there |

Comment lines are stripped before counting call sites (`codeLinesOf`), because `pipeline-runner.cjs`
names `targetAdapter.upsert(...)` three times in prose; and `readRepoFile` normalises CRLF → LF so
markers behave the same on a `core.autocrlf=true` checkout and on CI.

### Mutation probes (in-memory: patch → run → restore original bytes → assert identical)
Every probe restored the file byte-for-byte (asserted in the probe script); `git status --short`
after the run shows only the two intended files modified.

| # | Mutation | Result | Test that went red |
| --- | --- | --- | --- |
| P1 | anchor token `ds-new-button` → `ds-button-renamed-away` | RED `1 failed \| 19 passed` | every walkthrough step maps to real source: all declared anchors resolve |
| P2 | anchors `<dd>` testid renamed so they stop rendering | RED `1 failed \| 19 passed` | every walkthrough step renders its code anchors in the page |
| P3 | step 1 copy reverted to 「用占位符，不要填真实值」 | RED `1 failed \| 19 passed` | case one tells the reader to use REAL values … |
| P4 | `addDataSourceInternal(config, false)` → `(config, true)` in `DataSourceManager.ts` | RED `1 failed \| 19 passed` | case one separates "saved" from "reachable" … |
| P5 | added `await context.targetAdapter.upsert({…})` inside the `if (dryRun)` branch of `pipeline-runner.cjs` | RED `1 failed \| 19 passed` | case two: the K3 dry-run preview path contains no write call |
| P6 | added `@click="installStagingTables"` to the 「打开多维表」 `<router-link>` | RED `1 failed \| 19 passed` | case two: the "open the multi-dimensional table" control is navigation only |
| P7 | copy reverted to "A dry-run only reads K3 …" | RED `1 failed \| 19 passed` | case two describes the real PLM → K3 direction … |
| P8 | pasted `K3_WISE_EXTERNAL_WRITE_DISABLED` into case-two prose | RED `1 failed \| 19 passed` | the walkthrough sections print no error code outside the single-source table |
| P10 | removed `if (input.dryRun) return` from `writeDeadLetter` | RED `1 failed \| 19 passed` | case one states the dry-run persistence facts the runner actually implements |
| P9 | deleted the whole `install-staging` step object from the K3 array | RED `2 failed \| 18 passed` | case two … all five step anchors exist **and** all declared anchors resolve |

Two claims I wrote in this round were falsified before shipping, by reading the producer rather than
by review: (a) an early draft of the dry-run step said failed rows "still become dead letters" —
`pipeline-runner.cjs:711-714` `writeDeadLetter` returns early on `input.dryRun`, so they do not; the
sentence now says the RUN is recorded and the failed rows stay in the preview's error list, and P10
pins it. (b) the round-1 claim that 「K3 目标永久只读」 only matched an unmerged branch was itself
wrong — the four-layer fence is present on this branch
(`plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs`), so that line is now
grounded here instead of in another branch's commit.

P8 caught a real defect in the guard itself on the first attempt: the initial regex
`\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b` required three characters before the first underscore, so the
whole `K3_*` code family — the family most likely to be pasted into *this* page — slipped through
and the probe stayed green. Widened to `\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]{2,})+\b`; probe then red.
(P9's first attempt was a bad probe, not a bad guard: it renamed the step id instead of deleting the
step, so the count was unchanged. Re-run as a real deletion → red.)

## Not verified in this pass
- No browser/nginx smoke: this page is static copy with no build-time asset-path dependency.
- `pnpm --filter web test` (the whole web suite) was not run — only the affected spec. Blast radius
  checked by `grep -rn IntegrationHelpView apps/web/src packages plugins`: the only importer is the
  lazy route `appRoutes.ts:296` (unchanged), and the only other hits are prose comments in
  `StockPreparationCodeHelpPanel.vue:44`, `StockPreparationWorkspace.vue:307` and
  `fieldHints.ts:20`. `grep -rln "help-section-case" apps/web/tests` → this spec only. CI remains
  the judge for the rest of the suite.
- ESLint was not run on the two files: `apps/web`'s `lint` script runs an explicit file list that
  does not include either of them, so there is nothing to run that would cover them.
- The anchor guard proves each referenced token EXISTS in the file it names; it does not prove the
  surrounding prose describes that token correctly. That gap is covered only by the specific
  behavioural assertions (P4–P7 above), not by the generic anchor test.
