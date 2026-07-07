# IU-6: Integration embedded help (three layers) — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
(RATIFIED, #3739) §2 IU-6 (a/b/c) + §3 hard locks. Pure frontend, **zero behavior change**: one new
copy module, one new read-only view + route, guidance-only edits to existing empty states, tooltip
wrappers on existing field labels, tests, CI path-filter additions, this MD. Base = origin/main
including IU-1 #3743 (`errorCodeLabels.ts` label module).

## Three-layer coverage table

### IU-6a 空状态即引导 (guided empty states: 这是什么 + 第一步做什么, zh+en)

| Surface | Empty state | Before | After |
|---|---|---|---|
| Workbench · 连接管理 | `systems.length === 0` inventory list | one-line "暂无连接…" | what-is (`connections-empty-what`) + first-step (`connections-empty-first-step`) |
| Workbench · 参数化表动作 | `tableActions.length === 0` | one-line "当前部署没有暴露表动作。" | what-is + first-step (`table-action-empty-what/-first-step`) |
| Workbench · 运行监控/最近运行 | `pipelineRuns.length === 0` | one-line "暂无运行记录。" | what-is + first-step (`pipeline-runs-empty-what/-first-step`) |
| Workbench · 运行监控/dead letters | `deadLetters.length === 0` | one-line "暂无 open dead letters。" | what-is + first-step (`dead-letters-empty-what/-first-step`) |
| 读取源配置 panel · saved-configs list | `configs.length === 0` (`rsc-empty`) | one-line "暂无读取源配置。" | what-is + first-step (`rsc-empty-what/-first-step`) |
| 组合 authoring panel · resolver picker | `resolverConfigs.length === 0` (`rscauth-empty`) | one-line prose | what-is + first-step (`rscauth-empty-what/-first-step`) |
| 组合运行 panel · approved list | `compositions.length === 0` (`rscomp-empty`) | one-line "暂无已审批组合。" | what-is + first-step (`rscomp-empty-what/-first-step`) |

Deliberately NOT touched (stated per task "state your skips"):

- Workbench `source-empty-state` (还没有可读取的数据源) and `staging-empty` (暂未加载 staging 契约) —
  these two were **already** guided/actionable empty states (strong what-is line + CTA buttons,
  `integration-workbench__empty--actionable`); rewriting them would be churn, not a gap fill. Existing
  specs assert their exact copy (`IntegrationWorkbenchView.spec.ts:1495/1563/1612-1616`).
- `data-source-bridge-object-empty` ("没有可选表 / 视图…") — already tells the user exactly what to do
  next (回 /data-sources 检查权限或 schema); it is a hint line, not a bare empty state.
- `dead-letter-provenance-empty-*` ("暂无血缘事件。") — nested per-row expert detail inside an already
  guided dead-letter card, not a section-level list empty state.
- `IntegrationK3WiseSetupView.vue` — not named in the IU-6a scope list (workbench sections + the two
  read-source panels); its mini dead-letter list mirrors the Workbench one and can pick the same copy up
  in IU-2.

All empty-state copy is zh-primary + en via the same `locale.value === 'zh-CN'` pattern the surface
already uses (a small `bi(zh, en)` helper per component — same idiom as the IU-1 label helpers), and all
NEW styling uses `var(--ms-*)` tokens only (zero new hex; verified by grep over the diff).

### IU-6b 字段级 hint (el-tooltip, values-free, zh+en)

New module **`apps/web/src/services/integration/fieldHints.ts`** — exact-key map
`INTEGRATION_FIELD_HINTS: Record<IntegrationFieldHintKey, {zh, en}>` + `integrationFieldHint(key,
locale)`, same style as `errorCodeLabels.ts`, deliberately Vue-free/DOM-free so IU-2's restructure can
re-consume it. 19 keys wired to `el-tooltip` wrappers (existing native controls untouched — only the
label `<span>` is wrapped, per the "do not convert native controls" instruction):

| Panel | Fields (hint key) |
|---|---|
| `IntegrationReadSourceConfigPanel.vue` (15) | requiredKind, mode, readPath, keyField, keyEncoding, resolverRule, resolverSortField (multiplicityRuleField/sorted), resolverSortDirection, resolverDiscriminatorField (multiplicityRuleField/equals), resolverDiscriminatorValue, containerPaths, headerContainerPaths, lineContainerPaths, fieldMap, boundedSmoke |
| `IntegrationReadSourceCompositionAuthoringPanel.vue` (4) | step1ConfigId, step2ConfigId, name, sourceTarget |

Each tooltip carrier has a `data-testid` (`rsc-hint-*` / `rscauth-hint-*`). Copy is one sentence,
values-free (placeholder-form only — the module spec enforces "no digit-run > 4, no http(s)://" over
every entry). Skipped fields (stated): `object` (self-explanatory, its placeholder suffices),
`version` (labeled "正整数" inline already), `operations` (read-only/disabled, label already says
本线只读), the probe-key input (its label already explains it fully), and everything in
`IntegrationWorkbenchView.vue` / `IntegrationK3WiseSetupView.vue` (those two views already carry
`__field-help` inline help lines per field; adding tooltips there is IU-2/IU-5 territory).

### IU-6c 帮助中心页 `/help/integration`

New view **`apps/web/src/views/IntegrationHelpView.vue`** — standard chrome (`PageShell width="default"`
+ `PageHeader` with back-to-workbench + `el-card` sections, mirroring
`src/views/approval/TemplateAuthoringView.vue`), tokens only. Three sections:

1. **何时用读取源 vs 组合** (`help-section-when-to-use`) — one-screen single-hop vs two-hop chain
   explanation + a choose-when compare list; values-free (no business values, no real identifiers).
2. **错误码对照表** (`help-section-error-codes`) — **SINGLE SOURCE**: rendered by iterating
   `integrationErrorCodeEntries()` (a new export on the IU-1 module that maps
   `INTEGRATION_ERROR_CODE_LABELS`' own keys — the map itself is now exported too). ZERO label strings
   are copied into the view; a future label addition/removal appears in the table with no edit to this
   page. Each row = raw code (`<code>`) + zh/en label + optional hint.
3. **常见排障 FAQ** (`help-section-faq`) — 7 entries distilled from
   `docs/development/integration-composition-entity-e2e-runbook-20260705.md` and
   `docs/development/integration-core-external-api-read-self-service-entity-e2e-runbook-20260702.md`
   (not invented): container-not-found probe triage; multi-BOM AMBIGUOUS = correct uniqueness-policy
   behavior (design-lock-named example); credentials are backend-registered (design-lock-named example);
   save-version 500 = migration gap first; STEP_NOT_RUN = fail-closed by design; generic STEP_FAILED
   triage (requiredKind mismatch / credentials / network); keyField+containerPaths probe-before-save
   rationale. All values-free (placeholders only, spec-enforced no digit-run > 4).

**Route** (`apps/web/src/router/appRoutes.ts`): `/help/integration`, name `integration-help`, lazy
component, `meta: { requiresAuth: true }` — **no `integration:write` gate**. Choice + rationale (task
asked to state it): the route follows the `/data-sources` info-page pattern (requiresAuth only) rather
than the workbench's write-tier gate, because the content (when-to-use, error-code reference, FAQ) is
exactly what a user who HITS an error wants to read, including read-tier users without
`integration:write`; the page has no service calls and no write path, so there is nothing to fence.

**Entry link**: one `router-link` "帮助/Help" (`integration-help-link`) added beside the existing K3
WISE preset link in the Workbench header, reusing the existing `integration-workbench__k3-link` class
(no new visual style) inside a minimal token-styled flex wrapper.

## Single-source tripwire (explanation)

The help center's error-code table MUST stay a projection of the IU-1 label module, never a copy.
Enforced twice:

1. **Construction**: `IntegrationHelpView.vue` contains no error-label strings at all — the table
   `v-for`s over `integrationErrorCodeEntries()`, whose implementation is
   `Object.keys(INTEGRATION_ERROR_CODE_LABELS).map(...)` inside `errorCodeLabels.ts` itself.
2. **Test** (`IntegrationHelpView.spec.ts`): the rendered `tbody tr` count is asserted `===`
   `integrationErrorCodeEntries().length` (the module's own registered-code count — not a hand-written
   number, so adding/removing a label keeps the spec green while proving the table tracked it), a known
   code's row is spot-checked, and a **planted fake code** (`TOTALLY_MADE_UP_ERROR_CODE_NOT_REAL`) is
   asserted absent — a hand-copied table could drift to include stale/invented codes; a projected one
   cannot.

## Zero-behavior-change statement

- No service-layer/wire-shape changes: `fieldHints.ts` is a pure data+lookup module;
  `errorCodeLabels.ts` gains only two additive exports (`INTEGRATION_ERROR_CODE_LABELS` made `export`,
  new `integrationErrorCodeEntries()`/`IntegrationErrorCodeEntry`) — no existing export's signature or
  semantics changed, and the IU-1 spec passes unmodified.
- No permission changes: the workbench/K3 routes keep `integration:write`; the ONE new route is
  additive and read-only (rationale above).
- No backend changes of any kind; no new network calls anywhere (the help view performs zero requests).
- Existing empty-state conditions (`v-if`s) unchanged — only the markup INSIDE them enriched; existing
  `data-testid`s (`rsc-empty`, `rscomp-empty`, `rscauth-empty`, `table-action-empty`) preserved.
- el-tooltip wraps label `<span>`s only; every native input/select/checkbox and its
  `v-model`/`data-testid` is byte-identical.
- Token-only styling: every new CSS declaration uses `var(--ms-*)`; grep over the full diff shows zero
  added hex literals.
- Values-free discipline: enforced by spec on the fieldHints module (all 19 entries) and on the help
  view's when-to-use + FAQ sections (no digit-run > 4, no URLs); FAQ examples are placeholder-form.
- `pnpm exec vue-tsc -b` clean (exit 0).

## Test evidence

Guard command exactly as now in `.github/workflows/integration-guard.yml` (spec list extended with
`fieldHints` + `IntegrationHelpView`), run on **both** Node 20.20.2 (CI's major, via nvm — new view
tests use only synchronous flushes + the panel spec's existing condition-based `waitUntil`, no
microtask-only flushing) and the default local Node 25.9.0:

```
pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror \
  integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel \
  IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel \
  readSourceCompositions.service IntegrationWorkbenchView IntegrationK3WiseSetupView \
  IntegrationHelpView --reporter=dot

✓ tests/fieldHints.spec.ts                                      (42 tests)  ← new
✓ tests/IntegrationHelpView.spec.ts                             (6 tests)   ← new
✓ tests/integrationErrorCodeLabels.spec.ts                      (13 tests)
✓ tests/composition-vocab-mirror.spec.ts                        (3 tests)
✓ tests/multitable-resolver-vocab-mirror.spec.ts                (4 tests)
✓ tests/readSourceCompositions.service.spec.ts                  (24 tests)
✓ tests/IntegrationReadSourceCompositionPanel.spec.ts           (6 tests)
✓ tests/IntegrationReadSourceCompositionAuthoringPanel.spec.ts  (7 tests)
✓ tests/IntegrationReadSourceConfigPanel.spec.ts                (20 tests)  ← +1 guided-empty-state
✓ tests/IntegrationK3WiseSetupView.spec.ts                      (7 tests)
✓ tests/IntegrationWorkbenchView.spec.ts                        (49 tests)

Test Files  11 passed (11) · Tests  181 passed (181)   [Node 20.20.2 AND Node 25.9.0]
```

Also ran the guard's first leg `pnpm --filter plugin-integration-core test` on Node 20 — all suites OK
(no server-side contract this slice mirrors changed).

New specs:

- `apps/web/tests/fieldHints.spec.ts` — exact-key coverage (every wired key present), non-empty zh+en
  for every entry, values-free scan (no digit-run > 4, no `http(s)://`), locale selection, and explicit
  key-lists for both panels so removing a wired key fails RED.
- `apps/web/tests/IntegrationHelpView.spec.ts` — renders all three sections; when-to-use values-free +
  mentions both concepts; **single-source tripwire** (row count === module count, spot-checked row,
  planted fake code absent); FAQ 5-8 entries, values-free, includes the two design-lock-named examples;
  back-link present.
- `apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts` — new `it`: empty saved-configs list renders
  the guided empty state (what-is + first-step both non-empty; first-step names the concrete probe→save
  action, asserted in the test env's default `en` locale).

Known noise, pre-existing: the panel specs' jsdom mounts log "Failed to resolve component: el-tooltip"
warnings because those specs mount components bare (no ElementPlus plugin). Warning-only — the label
`<span>` still renders (assertions on label text keep passing) and the real app registers ElementPlus
globally in `main.ts`. Same situation as other el-* usage in bare-mounted specs.

Known-failing spec NOT related to this slice: `k3WiseSetup.spec.ts` "route guard" test fails identically
on the unmodified base commit (asserts `main.ts` contains `to.meta?.permissions`, which drifted before
this branch) — verified by stash/run/pop; it is not in the integration-guard spec list and untouched
here.

## Files touched

- `apps/web/src/services/integration/fieldHints.ts` (new)
- `apps/web/src/views/IntegrationHelpView.vue` (new)
- `apps/web/src/services/integration/errorCodeLabels.ts` (additive exports only)
- `apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue`
- `apps/web/src/components/integration/IntegrationReadSourceCompositionPanel.vue`
- `apps/web/src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/tests/fieldHints.spec.ts` (new)
- `apps/web/tests/IntegrationHelpView.spec.ts` (new)
- `apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts`
- `.github/workflows/integration-guard.yml`
- `docs/development/integration-iu6-embedded-help-dev-verification-20260707.md` (this file)
