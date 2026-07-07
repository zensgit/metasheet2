# IU-1: Integration error-code humanization — dev verification (2026-07-06)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md` (PR
#3739, overall PROPOSED, IU-1 owner-authorized to proceed) + the RATIFIED addendum (errorMessage must
never render raw, anywhere on the integration surface). Pure frontend, zero behavior change: one new
label module, label-only edits to 4 Vue display sites, tests, CI path-filter additions, this MD.

## What changed

1. **New module**: `apps/web/src/services/integration/errorCodeLabels.ts` — an exact-key (own-property)
   lookup from a closed-ish set of integration error CODES to a `{zh, en, hint?}` label. Exports:
   `IntegrationErrorLabel`, `integrationErrorCodeLabel(code, locale)` (exact lookup, `null` on miss),
   `integrationErrorCodeDisplayLabel(code, locale)` (prominent-slot string, generic "未知错误"/"Unknown
   error" fallback on miss), `integrationErrorCodeHint(code, locale)`, plus the local
   `K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES` mirror and the hand-curated
   `DEAD_LETTER_MAINLINE_ERROR_CODES` list.
2. **4 display sites wired** (label-only edits, `useLocale` imported where absent):
   - `apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue` — probe evidence
     `errorCode` line: humanized label + hint now prominent; raw code demoted into a nested `<small
     data-testid="rsc-evidence-error-code">`; new `data-testid="rsc-evidence-error-label"` on the label.
   - `apps/web/src/components/integration/IntegrationReadSourceCompositionPanel.vue` — standalone chain
     `evidence.errorCode` line: same treatment (`rscomp-evidence-error-label` new testid,
     `rscomp-evidence-error-code` kept on the demoted raw-code element); per-step inline debug line gets
     the label appended in parens (`errorCode=X (Human label)`), no new testid (already a dense
     expert/debug line per the task's own priority call).
   - `apps/web/src/views/IntegrationWorkbenchView.vue` — dead-letter list: raw `<span>{{
     deadLetter.errorMessage }}</span>` **deleted**; `<strong>` now shows the humanized label (generic
     "Unknown error" fallback for unregistered codes); hint (if any) renders where the message used to be;
     raw `errorCode` demoted into `<small data-testid="dead-letter-code-<id>">`; new
     `data-testid="dead-letter-label-<id>"` on the label.
   - `apps/web/src/views/IntegrationK3WiseSetupView.vue` — K3 setup's own mini dead-letter list: same
     treatment. This block had **no** `data-testid`s at all before; added
     `k3-dead-letter-<id>` / `k3-dead-letter-label-<id>` / `k3-dead-letter-code-<id>`, following the
     Workbench view's `` `dead-letter-${id}` `` templating convention.
3. **CI**: `.github/workflows/integration-guard.yml` path filters (both `pull_request` and `push`)
   extended to cover `errorCodeLabels.ts`, `integrationErrorCodeLabels.spec.ts`,
   `IntegrationWorkbenchView.vue`/`.spec.ts`, `IntegrationK3WiseSetupView.vue`/`.spec.ts`; the guard's
   `vitest run` command extended to include all of these (both view specs run clean standalone, see Test
   evidence below, so both are included in the gated command — not deferred).

## RATIFIED addendum: errorMessage leak-hole — CLOSED

Grepped the whole integration surface for `deadLetter.errorMessage` (the dead-letter shape's raw
free-text field, distinct from the many unrelated local-component `errorMessage` refs elsewhere in
`apps/web/src`, e.g. `LoginView.vue`, `SpreadsheetsView.vue`, `AttendanceView.vue`, etc. — those are a
different concept and out of scope). Confirmed exactly 2 render sites, both closed:

1. `IntegrationWorkbenchView.vue` (~line 1208-1209, now ~1207-1212): raw `errorMessage` interpolation
   deleted entirely. Sentinel test (`IntegrationWorkbenchView.spec.ts`, new `it` block "IU-1: humanizes
   dead-letter errorCode and NEVER renders the raw errorMessage") asserts
   `container.textContent` / `container.innerHTML` do **not** contain the sentinel
   `SENTINEL-RAW-MESSAGE-🙅` (or the second fixture's `ANOTHER-SENTINEL-RAW-MESSAGE`) anywhere, for both a
   registered code (`VALIDATION_FAILED` → humanized) and an unregistered one (`TOTALLY_UNKNOWN_CODE` →
   generic "Unknown error"). PASSED.
2. `IntegrationK3WiseSetupView.vue` (~line 388-394, now ~388-396): same treatment, same sentinel pattern.
   New `it` block "IU-1: humanizes dead-letter errorCode in the K3 setup mini-list and NEVER renders the
   raw errorMessage (RATIFIED addendum)" in `IntegrationK3WiseSetupView.spec.ts` — this spec had no
   dead-letter mock/test coverage at all before, so a minimal `/api/integration/dead-letters?...` mock was
   added following the pattern already used by `IntegrationWorkbenchView.spec.ts`. PASSED.

Both sites: unknown/unregistered `errorCode` → the PROMINENT slot shows the generic "未知错误"/"Unknown
error" label (never the raw code, never any part of the message); the raw CODE (not message) remains
visible in a demoted/secondary `<small>` element for expert troubleshooting.

**Noted gap, explicitly out of scope**: `IntegrationK3WiseSetupView.vue`'s neighboring `run.errorSummary`
field (~line 376, in the "最近运行" pipeline-run list, not the dead-letter list) is a separate free-text
field with no paired `errorCode` to derive a label from. It still renders raw. This is a related leak but
a different kind of fix (there's nothing to key a label lookup off of) — flagged here for a future slice,
not touched in IU-1.

## Coverage table

| Code family | Count labeled | Source of truth |
|---|---|---|
| Resolver | 9 | `apps/web/src/services/integration/readSourceConfigs.ts` `RESOLVER_ERROR_CODES` (mirrors `plugins/plugin-integration-core/lib/read-source-probe-contract.cjs` `READ_SOURCE_RESOLVER_ERROR_CODES`) |
| Probe (own, 11) | 11 | same file `READ_SOURCE_PROBE_ERROR_CODES` (own entries, before resolver/BOM-list spread) |
| Composition | 8 | `apps/web/src/services/integration/readSourceCompositions.ts` `COMPOSITION_PLAN_ERROR_CODES` (mirrors `plugins/plugin-integration-core/lib/read-source-composition-planner.cjs` `READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES`) |
| K3 WISE BOM-list-by-material | 8 | `plugins/plugin-integration-core/lib/read-source-bom-list-by-material-contract.cjs` `K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES`; mirrored locally in `errorCodeLabels.ts` (not added to `readSourceConfigs.ts` — nothing there references it). **NOT yet wired to any UI display site** — no BOM-list-by-material UI exists yet; labeled for completeness/future use per design-lock scope. |
| Dead-letter known mainline | 10 | Hand-curated from `plugins/plugin-integration-core/lib/pipeline-runner.cjs` (mainline path) + generic fallbacks also used in `external-write-dry-run.cjs` (`WRITE_FAILED`, `UNKNOWN_ERROR`). Not a single server-exported array — dead-letter `errorCode` is fed from multiple origins. |
| **Total labeled** | **46** (28 in the server's current probe union set + 8 composition + 10 dead-letter, with resolver's 9 counted inside the probe union) | — |

### Research-drift finding (verified against current `main`, not re-derived from the design-lock doc)

The design-lock research doc cited the server's probe/resolver union set size as 20 (11 probe-own + 9
resolver). As of this branch's base commit, the server's exported `READ_SOURCE_PROBE_ERROR_CODES` in
`read-source-probe-contract.cjs` **also** spreads in the 8 K3 WISE BOM-list-by-material codes (a BL2
addition), making the true current union **28**. This is a **pre-existing** drift between the server
vocabulary and the client mirror in `readSourceConfigs.ts` (which still only spreads in the 9 resolver
codes, not the 8 BOM-list codes) — **out of scope to fix here** (IU-1 is labels-only, zero behavior
change; fixing the client mirror's own allowlist is a `readSourceConfigs.ts` runtime change, not a label
change). The mirror-tripwire test (`integrationErrorCodeLabels.spec.ts`) asserts every code in the
server's **current** union (28) has a label — it already does, since this module labels the BOM-list
family separately. Flagging this drift here so it isn't silently rediscovered later.

### Deliberately NOT labeled (owner-flagged in the task, reconfirmed against current source)

The C6 external-write-specific `SAFE_WRITE_ERROR_CODES` set in
`plugins/plugin-integration-core/lib/external-write-dry-run.cjs` (~line 23-38, verified current):
`AdapterValidationError`, `DATA_SOURCE_BRIDGE_CONFIG_ERROR`, `DATA_SOURCE_GENERIC_QUERY_DISABLED_REQUIRED`,
`DATA_SOURCE_NOT_C6_WRITE_TARGET`, `DATA_SOURCE_NOT_FOUND`, `DATA_SOURCE_NOT_VISIBLE`,
`DATA_SOURCE_NOT_WRITABLE`, `DATA_SOURCE_PRINCIPAL_REQUIRED`, `DATA_SOURCE_QUERY_INVALID`,
`DataSourceBridgeConfigError`, `DataSourceNotC6WriteTargetError`, `DataSourceNotWritableError`,
`DataSourceQueryDisabledError`, `DataSourceUnavailableError`, `DUPLICATE_KEY`, plus a test-injection code.
**Reasoning**: these belong to the still-W1-gated external-write self-service ladder (per project memory:
W1 config is still mid-review, W2-W4 not started), not the mainline read/monitor flow this slice touches.
Inventing zh/en semantics for a not-yet-shipped write surface would be scope creep and risks getting the
copy wrong before the surface's own design is settled. Listed explicitly here (not labeled) rather than
silently omitted.

## Zero-behavior-change statement

- No route changes, no service-wire shape changes, no permission changes, no backend logic changes.
- All edits are: (a) one new pure frontend module with no side effects, (b) label-only template edits to 4
  existing Vue files (adding/reordering display text + `data-testid`s; no new network calls, no new
  computed state beyond the label/hint derivation, no changed control flow), (c) tests, (d) CI path
  filters, (e) this MD.
- `vue-tsc -b` (`pnpm --filter @metasheet/web run type-check`) is clean — no new type errors.
- All pre-existing tests in the 4 touched Vue files' specs continue to pass unmodified (25 + 49 + 7 =
  81 pre-existing tests all still green after the edits, before any new `it` blocks were added).

## Test evidence

Ran `pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror integrationErrorCodeLabels IntegrationReadSourceConfigPanel IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel readSourceCompositions.service IntegrationWorkbenchView IntegrationK3WiseSetupView --reporter=dot`
(exactly the CI guard's post-change command):

```
✓ tests/integrationErrorCodeLabels.spec.ts        (12 tests)
✓ tests/readSourceCompositions.service.spec.ts    (24 tests)
✓ tests/multitable-resolver-vocab-mirror.spec.ts  (4 tests)
✓ tests/composition-vocab-mirror.spec.ts          (3 tests)
✓ tests/IntegrationReadSourceCompositionPanel.spec.ts        (6 tests)
✓ tests/IntegrationReadSourceCompositionAuthoringPanel.spec.ts (7 tests)
✓ tests/IntegrationReadSourceConfigPanel.spec.ts  (19 tests)
✓ tests/IntegrationK3WiseSetupView.spec.ts        (7 tests)
✓ tests/IntegrationWorkbenchView.spec.ts          (49 tests)

Test Files  9 passed (9)
     Tests  131 passed (131)
```

No pre-existing failures were found in either large view spec (`IntegrationWorkbenchView.spec.ts` 48/48
before + 1 new = 49/49; `IntegrationK3WiseSetupView.spec.ts` 6/6 before + 1 new = 7/7) — both confirmed
clean standalone before being added to the CI guard's gated command, per the task's instruction.

Also ran the plugin's own CJS test chain (`pnpm --filter plugin-integration-core test`) — all suites OK,
confirming the server-side contracts this module mirrors are unchanged.

New label-module spec: `apps/web/tests/integrationErrorCodeLabels.spec.ts` (12 tests) — mirror-tripwire
coverage (every server resolver/probe/composition/BOM-list code has a non-empty zh+en label; every
dead-letter mainline code has one), exact-key-lookup negative tests (unregistered/enum-shaped code →
`null`; substring/prefix is NOT a match; `Object.prototype` keys like `toString`/`constructor` are never
resolved), generic-unknown-fallback tests, and a locale-switching test.

### Typecheck

`pnpm --filter @metasheet/web run type-check` (`vue-tsc -b`) — clean, no errors.

## Files touched

- `apps/web/src/services/integration/errorCodeLabels.ts` (new)
- `apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue`
- `apps/web/src/components/integration/IntegrationReadSourceCompositionPanel.vue`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/integrationErrorCodeLabels.spec.ts` (new)
- `apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts`
- `apps/web/tests/IntegrationReadSourceCompositionPanel.spec.ts`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `.github/workflows/integration-guard.yml`
- `docs/development/integration-iu1-error-code-labels-dev-verification-20260706.md` (this file)


## 附:质量闸补强(主循环审阅,2026-07-06)

- **mutation 4/4 KILLED**:①重插 raw errorMessage 渲染 → 哨兵测试红;②删一条 label →
  mirror-tripwire 红;③未知码改直出 → generic-unknown 测试红;④client mirror 删一码 →
  新增 mirror-drift tripwire 红。各 KILLED 后复绿 sanity 通过。
- **mirror drift 修复(闸内发现,随本 PR)**:client `readSourceConfigs.ts` 的
  `READ_SOURCE_PROBE_ERROR_CODES` allowlist 补齐 BL2 的 8 个 `K3_WISE_BOM_LIST_BY_MATERIAL_*`
  码(server 契约 #3695 起已含)——否则该族码在 probe/组合证据里先被客户端洗成 generic,
  IU-1 标签成死代码。新增 tripwire:client mirror 必须覆盖 server 全 union(未来 server 侧
  加族,客户端不同步则 CI 红)。
- 全 guard 面 132/132 绿;`vue-tsc -b` 干净。
