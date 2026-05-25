# K3 WISE Reference Completeness Preview — Verification (S2) - 2026-05-25

## Scope

Verifies the **S2 implementation** against the #1826 contract acceptance matrix, with file:line evidence and local test results. (Unlike #1826's verification, which verified contract intent, this verifies real behavior.)

## Acceptance matrix mapping (contract A# → artifact + evidence)

| A# | Requirement | Artifact / evidence | In S2? |
|---|---|---|---|
| A1 | Multi-column components; no single-lookup→object | `composeK3ReferenceObject` composes from `FNumber`/`FName`/`FID` component keys (`k3WiseSetup.ts`); panel consumes component-bearing rows; no "single lookup → object" UI | ✅ |
| A2 | Lookup-array + null-skip; empty ⇒ unresolved; no blind `[0]` | `normalizeReferenceCellValues` (array + filter `null`/`undefined`/`''`); empty → `empty`; composes first valid candidate. Tests: empty / null-skip / missing-identifier / resolve-after-null | ✅ |
| A3 | Composition client-side preview only; declared home; no server | Helper is pure client TS; panel runs in-browser; **no `apiFetch`/runtime call added**. Composition home = preview (only) | ✅ |
| A4 | ② persists complete `config.objects.material.schema` (null-proto-safe) | **Out of scope for S2** — A4 is the ② shape-selector persistence, a separate future piece. This preview composes for display, not persistence | ⏸ deferred |
| A5 | Preview lists unresolved; Save guard is client-side UX only | Panel renders unresolved list + a 3-way `canSave` line ("尚无样本行" / "可解析" / "存在未解析"), all stating "仅前端提示,非服务端门". `canSave = scannedRowCount > 0 && unresolvedCount === 0` (UX-only; an empty/zero-row sample is NOT reported resolvable). Tests cover `canSave` incl. empty-sample and happy-path | ✅ |
| A6 | No K3 write/Submit/Audit/BOM/read-list/new object | Boundary scan: only `apps/web` + docs; helper has no I/O; no new endpoint | ✅ |
| A7 | Bounded sample scan (not full-table) | `sampleLimit` default **3**; `truncated` flag. Test: bounds scan to 2, asserts truncation + only scanned rows present | ✅ |

S2 satisfies **A1, A2, A3, A5, A6, A7**. **A4** (② shape persistence) is explicitly deferred to a later piece and is not part of this preview.

## Local verification

- `vitest run tests/k3WiseSetup.spec.ts` → **55 passed** (43 existing + 12 new for `buildK3WiseReferenceCompletenessPreview`).
- `vue-tsc --noEmit` → **exit 0, 0 errors** (0 in changed files).
- Secret-shape sweep on changed files: clean.

## Test coverage (new)

- Preserves all present components (`{FName,FNumber}` stays two-field, not flattened).
- Composes `{FID,FName}` preserving both; scalar → degenerate `{FNumber}`.
- Empty array → `empty`; missing identifier → `missing-identifier`; null entries skipped; resolves after skipped nulls.
- Bounded scan + truncation; non-array rows → no entries + `canSave:false`; non-object row → `invalid-row`.
- Sample rows: row 0 fully resolved, row 1 surfaces both reasons → `canSave:false`.
- Empty sample (`[]`) → `scannedRowCount:0`, no entries, `canSave:false` (nothing checked); a single fully-resolved row → `canSave:true` (happy path locked).

## Boundary
- Frontend + tests + docs only; no runtime, no server gate; A4 (② persistence) deferred to a later PR.
