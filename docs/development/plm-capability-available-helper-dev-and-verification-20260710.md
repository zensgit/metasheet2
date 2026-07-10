# PLM Capability Helper — Adopt Provider-Computed `available` (#4020) Dev & Verification

Date: 2026-07-10
Branch: `feat/plm-capability-available-helper`
Tracked issue: #4020 — "follow-up(plm-capability): adopt provider-computed `available` in
capability helper + pact (unified gate formula)"

## 1. Scope

This is the metasheet2-side **consumer** follow-up to the Yuantus provider's unified
affordance-visibility formula (Yuantus `#1156`, `feat(plm): Discussion Phase-3 provider
enablement — capability manifest keys`, merged on `origin/main`):

```
available = supported && (packaging == "base" || entitled)
```

Every entry in the advisory manifest returned by `GET /api/v1/integrations/capabilities` now
carries a provider-computed `available` boolean (`cache_scope` marks it tenant-scoped, same as
`entitled`). Before #4020, this consumer had no notion of `available` at all: any branch that
wanted to decide whether an affordance should be visible re-derived it from raw `entitled` (or
`supported` + a locally-guessed packaging rule). That re-derivation is wrong for a **base**-
packaged feature: `discussion_core` ships with base PLM (no separately-sold SKU), so a base
deployment has **no license row** for it — `entitled` reads `false` — even though the feature is
fully available. An entitled-only derivation would wrongly hide the base comment entry.

Two required deliverables plus one bonus, all in this one worktree:

1. **Capability helper re-keyed to `available`** — `PLMAdapter.ts` gains an optional
   `available?: boolean` field on `IntegrationFeatureCapability` (additive) and an exported
   `isFeatureAvailable(entry)` pure function; the `plm-workbench.ts` route gates that used to
   check `feature.entitled !== true` are re-keyed through it.
2. **Pact pins the formula** — the existing capabilities interaction in
   `metasheet2-yuantus-plm.json` is enriched (no new interaction) to assert `available` for
   `bom_multitable`, `discussion_core`, and `metasheet_review`.
3. **(Bonus) forward-compat + helper unit tests** — `plm-adapter-capabilities.test.ts` gains a
   structural passthrough test plus a dedicated `isFeatureAvailable` unit-test suite; the BOM
   multitable route tests gain re-keying proof tests.

### Scope walls (explicitly NOT done here)

- **No discussion UI panel/affordance wiring.** `discussion_core` is not consumed by any route
  or component in this repo yet — this slice only makes the capability **helper** correct so a
  later, separately-gated panel-wiring slice can consume `isFeatureAvailable` without
  re-deriving the formula itself.
- **No discussion write adapter.** Write-era discussion routes (create thread / add comment /
  edit / delete / resolve / reopen) are untouched — they remain a later, write-session-
  credential-gated slice per the Discussion Phase 3 taskbook.
- **No Yuantus provider file touched.** The provider side (`#1156`) is already merged; this
  slice is read-only against it.

## 2. Grounding against the live Yuantus provider (read-only investigation)

Before writing the pact fixture, the actual provider source was read directly (not assumed)
to avoid pinning a formula output the live broker verification would then fail on:

- `src/yuantus/meta_engine/services/integration_capabilities_service.py` (Yuantus `origin/main`):
  confirms the exact formula, and that `_FEATURE_DESCRIPTORS` now includes `discussion_core`
  (`packaging: "base"`) and `metasheet_review` (`packaging: "paid"`) alongside the existing
  `bom_multitable` / `bom_multitable_writeback` / `bom_eco_revision` / `approval_automation` /
  `ecm_publish` / `visual_collaboration` keys.
- `src/yuantus/meta_engine/app_framework/entitlement_service.py`: both new keys are lit in
  `FEATURE_APP_NAMES` (`plm.discussion_core`, `plm.metasheet_review`), so `supported: true` for
  both.
- `src/yuantus/api/tests/test_pact_provider_yuantus_plm.py` (`_seed_pact_fixtures`): the pact
  verification fixture seeds an active perpetual license for **only**
  `["plm.bom_multitable", "plm.bom_multitable_writeback", "plm.bom_eco_revision"]` on tenant-1
  — **no** license row for `plm.discussion_core` or `plm.metasheet_review`. Combined with the
  formula:
  - `bom_multitable`: `supported=true`, `entitled=true` (licensed) → `available = true && (false
    || true) = true`.
  - `discussion_core`: `supported=true`, `entitled=false` (no license row, but `packaging=="base"`)
    → `available = true && (true || false) = true`.
  - `metasheet_review`: `supported=true`, `entitled=false` (no license row, `packaging=="paid"`)
    → `available = true && (false || false) = false`.

**This is why the pact below pins `metasheet_review` as `available: false`, not `true`.** The
issue text describes the general formula ("available flips false→true with entitlement"), but
this repo cannot invent a second, licensed-`metasheet_review` provider state — the Yuantus pact
fixture seeds no such license, and this slice does not touch Yuantus. Pinning
`metasheet_review: available: true` here would make the consumer pact assert something the
live provider verification would then contradict, silently breaking the broker gate the first
time it runs. The flip (false→true with entitlement) is instead demonstrated where it is safe
to invent both states: the `isFeatureAvailable` **unit tests** (§4) and the plm-workbench route
tests (§3), which use synthetic manifests, not the provider-verified pact.

## 3. Consumer changes — `packages/core-backend/src/data-adapters/PLMAdapter.ts`

- `IntegrationFeatureCapability` gains `available?: boolean` and `packaging?: string` (both
  additive — an older provider manifest simply omits them, so no existing consumer of this type
  breaks) and `cache_scope` gains an optional `available?: string` sibling.
- New exported pure function:

  ```ts
  export function isFeatureAvailable(
    entry: IntegrationFeatureCapability | null | undefined,
  ): boolean {
    if (!entry) return false;
    if (typeof entry.available === 'boolean') return entry.available;
    return entry.supported === true && entry.entitled === true;
  }
  ```

  Consumes `entry.available` **directly** when the provider sends it; falls back to the
  pre-#4020 `supported && entitled` derivation only when it is absent, so a consumer talking to
  a not-yet-upgraded PLM sees no behavior change.

### Re-keyed branches — `packages/core-backend/src/routes/plm-workbench.ts`

The task's cited line numbers (`PLMAdapter.ts:1272`, `:2257-2259`) turned out to be the
`getIntegrationCapabilities()` doc comment and the `getBomMultitableContext()` relay doc
comment respectively — both prose, not the actual visibility branches. The real
entitled-derived gates live in `plm-workbench.ts` (the route file), at three call sites, all
now re-keyed the same way (`feature.entitled !== true` → `!isFeatureAvailable(feature)`):

1. `GET .../bom-multitable/:partId/context` (~line 987) — the read-context relay pre-check.
2. `PATCH .../bom-multitable/:partId/lines/:bomLineId` (~line 1060) — the write-back pre-check.
3. `POST .../bom-multitable/:partId/eco-intent` (~line 1160) — the ECO revision-intent pre-check.

In every case the **separate** `feature.supported !== true` check (which returns a distinct
`reason: 'unsupported'` / 404, hiding the surface entirely) is left untouched and still runs
*before* the `isFeatureAvailable` check — only the second-stage entitled-vs-not distinction is
re-keyed. This preserves the existing two-step UX (hide entirely vs. show-with-upgrade-CTA)
while fixing the input the second step reads.

This re-keying is **behavior-neutral for all three gates today**: `bom_multitable`,
`bom_multitable_writeback`, and `bom_eco_revision` are all non-base (paid) features, so
`available` reduces to exactly `supported && entitled` for them — identical to the pre-#4020
check. The fix only changes behavior for a **base**-packaged feature (`discussion_core`), which
is not gated by any route yet (see scope wall above) — this slice lands the correct helper so
that a later panel-wiring slice inherits it for free, without touching UI.

Doc comments on the three route blocks and the `PlmBomReviewAdapter` header were updated
in-place to say "available (#4020)" instead of "entitled" where they describe the gate.

## 4. Pact contract changes — `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`

No new interaction (still **41** interactions, unchanged count/order). The existing
`fetch the advisory PLM integration capability manifest for an entitled tenant` interaction's
response body is enriched:

| Feature key | supported | entitled | available | packaging | matcher on entitled/available |
|---|---|---|---|---|---|
| `bom_multitable` | true | true | true | (none) | none — EXACT |
| `discussion_core` | true | false | **true** | base | none — EXACT |
| `metasheet_review` | true | false | **false** | paid | none — EXACT |

`entitled` and `available` are the formula's own discriminators, so — mirroring the existing
ECO Phase 0 discriminated-409 precedent (`detail.code` / `eco_required` pinned exact,
`message`/`state` type-matched) — both are left **without** a `matchingRules` entry, meaning
Pact matches them by exact equality rather than the usual `type` matcher used for
`supported`/`api_version`/`scenarios`/`cache_scope.*`/`packaging` on these same entries. This is
a deliberate strengthening versus the pre-#4020 `bom_multitable.entitled`, which was previously
type-matched (loose); it is now exact-pinned alongside the new `available` field since both are
linked by the same formula and the grounding in §2 confirms the live provider genuinely returns
`entitled: true` here.

`packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts` gains one new dedicated
test, `#4020: the capabilities interaction pins the provider-computed available formula`,
asserting all three key/value pairs above plus that no `matchingRules` entry exists for
`entitled`/`available` on any of the three keys (i.e. that they really are exact-pinned, not
accidentally loosened back to `type`).

`packages/core-backend/tests/contract/README.md` gains a `#4020` section documenting the same
grounding and formula table.

Provider-first is already satisfied: Yuantus `#1156` is merged on `origin/main`, so this pact
enrichment verifies against the live provider once published — no provider-side change is
required or made here.

## 5. Unit test additions

### `tests/unit/plm-adapter-capabilities.test.ts` (deliverable 3)

- `accepts a forward-compatible manifest carrying discussion_core/metasheet_review/available
  without degrading (#4020)` — structural passthrough only: `getIntegrationCapabilities()` must
  not reject or mutate a manifest carrying the two new keys plus `available`/`packaging` on
  every entry. Deliberately does **not** assert any visibility/gating semantics (out of scope
  per the panel-wiring scope wall).
- A new `describe('isFeatureAvailable ...')` block with four tests:
  - `discussion_core`-shaped entry (`entitled: false, available: true`) → `true` (the bug
    #4020 fixes).
  - paid-key-shaped entry (`available: false`) → `false`, even though `supported: true`.
  - `available` absent → falls back to `supported && entitled` (both the true and false
    sub-cases, plus `supported: false`).
  - missing/`undefined`/`null` entry → always `false`.

### `tests/unit/plm-workbench-bom-multitable-routes.test.ts` (proving deliverable 1's re-keying)

Three new tests, one per re-keyed gate, each constructing a manifest entry with
`entitled: false, available: true` (or the symmetric `entitled: true, available: false` for the
read-context gate) to prove the route now reads `available` and not raw `entitled`:

- `#4020: supported + entitled:false + available:true (base-packaged shape) -> queries the
  resource` (read context) — plus its symmetric counterpart
  `#4020: supported + entitled:true but available:false -> unentitled affordance WITHOUT
  querying`.
- `#4020: write route lets an entitled:false + available:true bom_multitable_writeback entry
  through`.
- `#4020: intent route lets an entitled:false + available:true bom_eco_revision entry through`.

These manifests do not correspond to any live provider state (all three real features are
paid) — they exist purely to prove the re-keyed code path, the same way the existing
`plm-adapter-bom-multitable.test.ts` / `plm-workbench-bom-multitable-routes.test.ts` suites use
synthetic fixtures for edge-state coverage.

## 6. Test results

Ran from `packages/core-backend/` (`pnpm install --frozen-lockfile` at the workspace root
first; did not mutate the lockfile):

```bash
npx tsc --noEmit -p .
```
Result: exit code 0, no type errors.

```bash
npx vitest run tests/unit/plm-adapter-capabilities.test.ts \
  tests/unit/plm-workbench-capabilities-routes.test.ts \
  tests/unit/plm-adapter-bom-multitable.test.ts \
  tests/unit/plm-workbench-bom-multitable-routes.test.ts \
  tests/contract --reporter=dot
```
Result: **6 test files passed, 103 tests passed** (93 pre-existing + 10 new: 5 in
`plm-adapter-capabilities.test.ts`, 4 in `plm-workbench-bom-multitable-routes.test.ts`, 1 in
`plm-adapter-yuantus.pact.test.ts`).

```bash
npx vitest run tests/contract --reporter=dot
```
Result: **2 test files passed, 24 tests passed** (23 pre-existing + 1 new pact assertion).

```bash
npx vitest run tests/unit --reporter=dot
```
Result: **342 test files passed, 4575 tests passed** (full `core-backend` unit suite — confirms
the additive type change and the three re-keyed gates did not regress any other adapter,
route, or federation test).

## 7. Files changed

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
- `packages/core-backend/tests/contract/README.md`
- `packages/core-backend/tests/unit/plm-adapter-capabilities.test.ts`
- `packages/core-backend/tests/unit/plm-workbench-bom-multitable-routes.test.ts`
- `docs/development/plm-capability-available-helper-dev-and-verification-20260710.md` (this file)

## 8. Deferred / out of scope

- Any discussion UI panel/affordance rendering that would actually consume `discussion_core` —
  a separate, owner-gated residual per the Discussion Phase 3 taskbook.
- The discussion write adapter (create/edit/delete/resolve/reopen) — later, write-session-
  credential-gated slice.
- A licensed-`metasheet_review` provider state in the pact — would require a Yuantus-side
  fixture-seeding change this slice does not make (see §2 for why that would be unsafe to
  invent here).

## 9. Merge status

Read-only consumer work; provider-first satisfied (Yuantus #1156 already merged on
`origin/main`). **HELD for owner-word merge** per ms2 discipline — this PR is opened but not
merged.
