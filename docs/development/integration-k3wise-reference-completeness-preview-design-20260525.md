# K3 WISE Reference Completeness Preview — Design (S2) - 2026-05-25

## Scope

- **Step 2** of the agreed sequence: a **frontend-only** "reference field completeness preview" on the Data Factory / K3 setup page, implementing the #1826 UI contract.
- Small implementation PR: **impl + tests + this design + verification**. Frontend + tests + docs only.
- **No** K3 Save/Submit/Audit/BOM/read-list runtime; **no** `plugin-integration-core`; **no** server gate.

## Design

### Pure helper — `k3WiseSetup.ts`
`buildK3WiseReferenceCompletenessPreview(target, rows, { sampleLimit })`:
- Reference fields = `template.schema` entries that carry `reference`.
- **Bounded scan** (C5/A7): first `sampleLimit` rows (default **3**); `truncated` flags more.
- Per reference field × scanned row:
  - Normalize the cell to an array with **null-skip** (C2/A2): scalar → `[v]`; `null`/`''`/`undefined` → `[]`; array → filtered of `null`/`undefined`/`''`.
  - Empty array → unresolved `empty`. Non-object row → unresolved `invalid-row`.
  - Compose the first candidate that yields an identifier, **preserving every present component** (`FNumber`/`FName`/`FID`) so `{FName,FNumber}` / `{FID,FName}` stay multi-field (C3/A1); a scalar composes to the degenerate `{FNumber}`. No identifier in any candidate → unresolved `missing-identifier`.
- Returns `scannedRowCount` / `truncated` / `entries` / `resolvedCount` / `unresolvedCount` / `canSave = unresolvedCount === 0` (**UX-only**, C5).
- **Defensive** (advisor): non-array `rows` → empty result + `canSave:false`; non-object entries handled.
- Deliberately does **not** reuse `applyReferenceShape` (the #1817 single-key wrap) — it composes from possibly-multiple components and preserves them all.
- `K3_WISE_REFERENCE_COMPLETENESS_SAMPLE_ROWS`: illustrative rows — row 0 fully resolves (mixed two-field shapes); row 1 shows both unresolved reasons (empty array, missing identifier). Keeps the view's script lean.

### Panel — `IntegrationK3WiseSetupView.vue`
- A **validation pad**: a textarea prefilled with the sample rows; a computed parses the JSON (defensive: parse error / non-array → inline error) and runs the helper against the selected `templatePreviewTarget`.
- Renders scanned/truncated, resolved/unresolved counts, a per-entry list (composed object when resolved, reason when not), and a **Save-guard line that explicitly states "仅前端提示,非服务端门"** (C5) — the guard is a client-side UX disable/hint, never a server gate.

## Lock conformance / boundary

- Files: `k3WiseSetup.ts` (+helper), `IntegrationK3WiseSetupView.vue` (+panel), `k3WiseSetup.spec.ts` (+tests), 2 docs — all under `apps/web/` + `docs/`.
- No K3 write, Submit/Audit/BOM, read/list runtime, `plugin-integration-core`, or server gate. The helper has no I/O; the panel adds no `apiFetch`.
- The ② shape-selector persistence (contract C4/A4) is a **separate** future piece — not in this preview PR.

## See also
- #1826 — UI contract (C1–C5, A1–A7).
- #1824 — lookup array / null-skip semantics + O4 (merge `996bf3c73`).
- #1792 — Customer GATE; full reference objects required.
