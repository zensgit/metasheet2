# Multitable AI-shortcut prompt-config history rendering — S2 dev & verification (2026-07-05)

> **Design-lock**: ratified and merged to `main` — PR #3618, squash commit `9f08a4bf9`.
> **Runtime**: merged to `main` — PR #3643, squash commit `6e844cf89`; PR branch head
> `09459af71`, 1 commit, +275/-10 across 2 files before squash.
>
> Scope stayed exactly as locked: frontend render-only in the existing config-history modal. No backend
> route, storage, migration, env flag, restore/revert surface, or new redaction module shipped.

## 1. Line summary

S1 made AI writes auditable in record history by adding `source='ai-shortcut'` and commit-action batch
grouping. S2 is the config-history companion: field-property changes that already contain
`property.aiShortcut` are now legible in the existing `MetaConfigHistoryModal.vue`.

Before S2, the generic config renderer summarized one object level and then dumped nested `params` as a
JSON fragment, so the most human-relevant prompt fields (`instruction`, `options`, `targetLang`) were hard
to read and had no explicit render-time redaction posture. S2 adds an `aiShortcut`-aware display branch for
that already-recorded config diff while keeping ordinary config rendering unchanged.

## 2. Design

Design-lock file: `docs/development/multitable-ai-shortcut-prompt-config-history-s2-designlock-20260705.md`.

Locked claims implemented:

| Lock | Runtime result |
| --- | --- |
| A1 scoped branch | Only `field.property.aiShortcut`-bearing config-history rows enter the new branch; ordinary property rows fall back to the existing compact summary. |
| A2 labeled lines | `aiShortcut.kind`, `aiShortcut.sourceFieldIds`, and `aiShortcut.params.*` render as separate labeled lines instead of a nested JSON blob. |
| A2 source labels | `sourceFieldIds` resolve through the existing `recordLabelOf` prop; unresolved ids fall back to the raw id, matching the existing workbench label fallback discipline. |
| A2 update semantics | Update rows render before->after only for changed AI shortcut sub-keys; create/delete rows render the single relevant side. |
| A3 non-AI compatibility | Non-aiShortcut property changes remain on the legacy `summarizeConfigValue` path. |
| B redaction | Free-text `params.instruction` and `params.options[]` strings pass through existing UI `redactString` before DOM render. No new redaction helper was added. |
| Non-goal: restore | Pure aiShortcut property updates still rely on the existing server-gated revert preview path; S2 adds no confirmable restore path. |
| Non-goal: backend | `/config-history`, `meta_config_revisions`, config recording, and restore routes are untouched. |

## 3. Implementation surface

Two files:

- `apps/web/src/multitable/components/MetaConfigHistoryModal.vue`
  - Imports existing `redactString` from `../utils/automation-log-redact`.
  - Adds `renderedChanges(rev)` as the single render planner for a config-history row.
  - Keeps generic `summarizeConfigValue` for structural config values.
  - Adds the AI-specific helpers:
    - `renderAiShortcutPropertyUpdate`
    - `renderAiShortcutPropertySingle`
    - `formatSourceFieldIds`
    - `formatAiShortcutParam`
- `apps/web/tests/multitable-config-history-modal.spec.ts`
  - Extends the existing modal spec with the S2 golden matrix and a restore-boundary guard.

No other file changed in runtime PR #3643.

## 4. Verification matrix

Targeted suite: `apps/web/tests/multitable-config-history-modal.spec.ts`.

| Golden | Proof |
| --- | --- |
| G1 create render | `field create` with `property.aiShortcut` renders `kind`, resolved `sourceFieldIds`, `params.targetLang`, and `params.instruction` as labeled lines; no nested `{"targetLang"...}` / `"instruction"` JSON blob appears. |
| G2 instruction update | `params.instruction` before->after renders per-line and no raw JSON fallback appears. |
| G3 redaction | Secret-shaped prompt text (`sk-...`) is rendered as `sk-<redacted>` and the raw token is absent from DOM text. |
| G4 non-AI property compatibility | Ordinary property update (`options: ['A']` -> `['A','B']`) still renders through the legacy compact summary and never emits AI labels. |
| G5 missing source label | An unresolved source field id falls back to the raw id string. |
| G6 restore boundary | A pure aiShortcut property update still opens the existing server-gated revert preview; the gated outcome shows no confirm button and no new FE restore affordance. |
| G7 mixed changed keys | `changedKeys=['property','name']` renders the AI property branch and the generic name before->after branch together; neither swallows the other. |

Regression context kept from the pre-existing suite:

- server-faithful rendering (no client-side security filtering)
- entity-type filter emits re-fetch intent only
- safe/gated/drift restore-preview rendering
- real `MultitableApiClient` preview->execute token flow
- `/config-history` and restore-preview response envelope parsing

## 5. Commands and CI evidence

Local validation in `/private/tmp/mt-ai-s2-render`, after rebasing onto `origin/main@9f08a4bf9`:

```text
pnpm --filter @metasheet/web exec vitest run tests/multitable-config-history-modal.spec.ts --watch=false
=> 19 tests / 1 file pass

pnpm --filter @metasheet/web type-check
=> vue-tsc -b clean

git diff --check
=> clean
```

GitHub checks for PR #3643 at head `09459af71`:

- contracts: dashboard/openapi/strict — pass
- pr-validate — pass
- DingTalk P4 ops regression gate — pass
- K3 WISE offline PoC — pass
- after-sales integration — pass
- multitable-web-guard — pass
- e2e — pass
- test (18.x) — pass
- test (20.x) — pass
- coverage — pass
- Strict E2E with Enhanced Gates — skipped by repo-wide condition, not a required failure

## 6. Review notes and residuals

Review result: no blocker found after runtime PR #3643 was green. Two small observations remain non-blocking:

1. The template currently calls `renderedChanges(rev)` twice (`v-if` and `v-for`). This is a minor render-efficiency
   issue only; the input list is small config-history data, and no behavior risk was observed.
2. When a single `property` diff contains both `aiShortcut` and unrelated property sub-key changes, the locked
   behavior is to render the AI shortcut branch for `property` and leave other changed top-level keys (for example
   `name`) on their generic line. This matches the design-lock's branch discipline; supporting per-sub-key mixed
   property rendering would be a separate display-polish slice, not a correctness gap in S2.

## 7. Arc ledger

- ✅ **S1** AI write provenance + commit-action batch grouping — design #3569 (`6b0e27bf2`), runtime #3584 (`4640f3662`), verification #3593 (`efbf85f9c`).
- ✅ **S2** prompt-as-audited-config UI — design #3618 (`9f08a4bf9`), runtime #3643 (`6e844cf89`), verification this document.
- 🔒 **S1b** true history-batch rollback — still gated; restore-surface extension, not implied by S2.
- 🔒 **S3** staleness lineage — design-first; state storage + no-auto-recompute UX.
- 🔒 **S4** cost visibility polish — estimate UI + per-field/per-run dimensions.
- 🔒 **S5** normalize kind / cleaning-oriented kinds — separate owner opt-in; classify->select rider remains gated.

## 8. Boundary statement

S2 addresses the read-side config-history visibility gap for AI shortcut prompt configs. It does **not** make prompt
config changes revertible, does not change config-history access control, does not redact stored
`meta_config_revisions`, and does not enable AI live requests. The next AI-governance moves remain explicit gated
items in the S1/S2 ledger.
