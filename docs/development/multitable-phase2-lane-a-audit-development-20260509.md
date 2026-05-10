# Multitable Phase 2 Lane A (`longText`) — Audit · Development

> Date: 2026-05-09
> Branch: `codex/multitable-phase2-long-text-field-20260509`
> Base: `origin/main@c74c15a2b`
> Spec: PR #1448 (`docs(multitable): plan Feishu phase 2 lanes`)

## TL;DR

**Lane A is already shipped.** The `longText` field type was implemented end-to-end before this Phase 2 slice was opened. Every acceptance bullet from the Phase 2 todo MD maps to existing code at `c74c15a2b`. This PR is the audit-only follow-up the user authorized: no production code changes; three test additions to close coverage gaps; this development MD records the discovery so the planning todo MD can be reconciled.

## Discovery

While orienting on the Lane A file boundary listed in `multitable-feishu-phase2-todo-20260509.md`, I direct-grepped the canonical insertion points and found `longText` already wired:

| Acceptance bullet | Location at `c74c15a2b` | Status |
|---|---|---|
| Aliases `longText`/`long_text`/`multiline` normalize to `longText` | `packages/core-backend/src/multitable/field-codecs.ts:139–151` (also handles `long-text`, `textarea`, `multi_line_text`) | ✓ done |
| Stored raw value is a string | `validateLongTextValue` at `field-codecs.ts:502–508` | ✓ done |
| Grid editor uses `<textarea>` | `apps/web/src/multitable/components/cells/MetaCellEditor.vue:57` | ✓ done |
| Renderer preserves newlines via `white-space: pre-wrap` | `apps/web/src/multitable/components/cells/MetaCellRenderer.vue:8` (CSS rule `.meta-cell-renderer__long-text` at line 238–241) | ✓ done |
| Form view + record drawer render/edit long text | `apps/web/src/multitable/components/MetaFormView.vue:41` and `MetaRecordDrawer.vue:85` | ✓ done |
| OpenAPI field type enum | `packages/openapi/src/base.yml:1673` | ✓ done |
| Existing `string` behavior unchanged | type union in `field-codecs.ts:4–31` adds `longText` alongside `string`; both retain independent codec paths | ✓ done |

Git log on `field-codecs.ts` shows two prior `feat(multitable): add long text field` commits (`152053cbf`, `f633f3b0f`) that introduced `longText`. The Phase 2 planning MD (PR #1448) was authored without grepping current main.

## Test Coverage Audit

| Acceptance test | File | Pre-audit | Post-audit |
|---|---|---|---|
| Backend codec test for aliases | `packages/core-backend/tests/unit/multitable-field-types-batch1.test.ts:75–81` | Covered `longText`, `long_text`, `textarea`, `multi_line_text` (4/6 listed in source) | Now covers `long-text` and `multiline` too (6/6) |
| Backend codec test for newline preservation | same file, `validateLongTextValue` describe at line 434–447 | Already covered (`'line 1\\n  line 2\\n'` round-trip) | Unchanged |
| Backend xlsx test for embedded newlines | `packages/core-backend/tests/unit/multitable-xlsx-service.test.ts` | Missing | Added — `serializeXlsxCell` preserves `\n`, `buildXlsxBuffer`/`parseXlsxBuffer` round-trip a multi-line cell |
| Frontend renderer test for newline display | `apps/web/tests/multitable-longtext-cell.spec.ts` | Already covered (renderer + textarea + Ctrl+Enter) | Unchanged |
| Frontend editor test for multi-line save | same file | Already covered | Unchanged |
| Field manager test for creating a `longText` field | `apps/web/tests/multitable-field-manager.spec.ts` | Validation-panel test only (line 520) — no creation-path test | Added — selects `longText` type in picker, clicks `+ Add`, asserts emitted shape |
| OpenAPI parity | `packages/openapi/tests/**` | n/a — schema unchanged by this audit | n/a |

## What changed in this PR

Only test additions and docs. No source code change.

| File | Change |
|---|---|
| `packages/core-backend/tests/unit/multitable-field-types-batch1.test.ts` | Extend `longText` alias test from 4 to 6 aliases (adds `long-text`, `multiline`) |
| `packages/core-backend/tests/unit/multitable-xlsx-service.test.ts` | Add `round-trips embedded newlines for longText cells` test |
| `apps/web/tests/multitable-field-manager.spec.ts` | Add `emits longText field creation without requiring an options panel` test |
| `docs/development/multitable-phase2-lane-a-audit-development-20260509.md` | This file |
| `docs/development/multitable-phase2-lane-a-audit-verification-20260509.md` | Companion verification record |

## Reconciliation with PR #1448

The planning MD's Lane A acceptance can be reconciled in one of two ways. This PR does NOT modify `multitable-feishu-phase2-todo-20260509.md` (it lives on the as-yet-unmerged #1448 branch). After #1448 lands, the user can either:

- Edit the Phase 2 todo MD on main to mark Lane A `[x] done` with a pointer to commits `152053cbf` / `f633f3b0f` and to this audit PR; or
- Land this audit PR first and treat its development MD as the canonical Lane A closure record (#1448's todo MD remains as the original spec).

Either path is consistent. This PR is intentionally narrow so it does not block #1448's review.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Test-only + docs change.
- Does NOT touch DingTalk / public-form / Gantt / Hierarchy / formula / automation runtime.

## Out of scope

- Modifying any Lane A production code (it's already shipped).
- Lane B / Lane C work — separate PRs.
- Updating PR #1448's todo MD — handled separately by the user or a follow-up.
- Rich-text marks, mentions, Markdown preview — explicit non-goals per #1448.
