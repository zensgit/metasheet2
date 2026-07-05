# Multitable per-subject field-write gate — close the two write paths that skip it (Yjs bridge + single-record OAPI PATCH) — W1-3 DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only; no runtime ships here.
- **Slice**: W1-3 of the multitable-window goal pool (`docs/development/multitable-window-goal-pool-todo-20260705.md`). Third angle of the **Yjs-bridge side-door theme** already in flight: freshness = **W1-1** (`multitable-formula-freshness-designlock-20260705.md`, merged `26af7a560`); capability enforcement = **W1-2 B1** (PR #3649); **per-subject field-write enforcement = this**. Origin: the runtime finding surfaced during the #3649 build (`/tmp/finding-yjs-bridge-fieldperm-writegate-20260705.md`), re-grounded at origin/main below.
- **What W1-3 is NOT**: not a `field_permissions` model change; not a change to `RecordWriteService.patchRecords` / `RecordService.patchRecord` (they stay **property-level only** — that is the documented, intentional design contract, see §1); not a refactor of the ~6 working route gates' behavior (only an OPTIONAL shared-predicate extraction, §2 LOCK-F2); not Yjs GA; not the W1-1 recompute or W1-2 capability concerns (sibling slices).

## §1 Problem (verified at line level, origin/main)

**The design contract**: the write spines enforce only PROPERTY-level field guards (hidden / `readOnly===true` / computed type). Per-subject `field_permissions.read_only` (a field marked read-only for a SPECIFIC subject) is a **layer-3** gate each write ROUTE must apply itself, before the spine.

- `RecordWriteService.patchRecords` — property-level only, by design (`record-write-service.ts:239` "Write gating is `fieldById`"; the everyday-grid gate comment at `routes/univer-meta.ts:15545-15547` states it verbatim: "The write spine … does NOT enforce per-subject `field_permissions.read_only`").
- `RecordService.patchRecord` — same posture, verified: its field loop rejects only `field.hidden` / `field.readOnly===true` / lookup / rollup (`record-service.ts:~1085-1089`); `record-service.ts` never loads `field_permissions` at all (grep: zero hits).

**The layer-3 gate that routes DO apply** (reference implementation, `univer-meta.ts:15543-15561`): from `buildRecordPatchContext` (which loads the per-subject scope via `loadFieldPermissionScopeMap(query, sheetId, access.userId)` and derives `fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { fieldScopeMap })`), reject any changed field where `!perm || perm.visible === false || perm.readOnly === true`, fail-closed, before any write. This exact predicate is inlined at **six** route sites today: grid `/patch` (`:15556`), `records/:recordId/restore` (`:8862`), `records/:recordId/restore-execute` (`:9019`), `restore-batch-execute` (`:9162`, `:9375`), `revert-execute` (`:9522`). (The finding said "3"; the true count is 6 — a refinement, not a contradiction: the point stands.)

**The two write paths that SKIP it** (both verified uncovered):

1. **Yjs collaborative-edit bridge.** The write-input builder (`index.ts:2462-2492`) filters `visibleFields` on `hidden` only, resolves capabilities via `resolveSheetCapabilitiesForUser`, and returns the input straight to `patchRecords` (`yjs-record-bridge.ts:226`) — **no `fieldPermissions`, no layer-3 gate**. So a field set read-only for actor X via `field_permissions` is blocked on grid PATCH but writable by X through the collab channel. (Structural read-only — formula/lookup/rollup/mirror — is still blocked; it's property-level. Only the per-subject layer leaks.)
2. **Single-record OAPI PATCH `PATCH /records/:recordId`** (`univer-meta.ts:13673`). Checks coarse `capabilities.canEditRecord` (`:13716`) then calls `recordService.patchRecord` (`:13724`) — with **no `buildRecordPatchContext`, no `fieldPermissions`, no layer-3 gate** in the 13673-13724 handler. Same leak via the token write channel. (The #3649 build flagged single-record PATCH "to be checked"; this lock checked it — it is a genuine second uncovered path, so it is IN SCOPE.)

## §2 LOCK-F — the fix

- **F1 (where)**: the gate is added to the two uncovered WRITE PATHS, never to the spine. The spines (`patchRecords` / `patchRecord`) stay property-level by design — changing them is an explicit non-goal (it would silently alter every caller's contract and duplicate the layer-3 derive the routes already own).
  - **Bridge**: in the write-input builder (`index.ts`), after `resolveSheetCapabilitiesForUser`, load the per-subject scope and derive `fieldPermissions` (F3), reject if any changed field is forbidden (F4) BEFORE returning the input, so `patchRecords` never runs on a denied flush.
  - **Single-record PATCH**: in the `PATCH /records/:recordId` handler (`univer-meta.ts:13673`), call `buildRecordPatchContext` (the SAME factory grid `/patch` uses) and apply the identical `forbiddenWriteFieldIds` check + `sendForbidden` BEFORE `recordService.patchRecord`.
- **F2 (extract vs inline — recommend predicate-only extraction)**: extract ONLY the one-line invariant `isFieldWriteForbidden(perm) = !perm || perm.visible === false || perm.readOnly === true` into a tiny pure helper (near-zero blast radius — a pure boolean), and have the two NEW sites plus, ideally, the six existing sites reference it. Do **NOT** extract the whole gate FLOW: the six sites differ deliberately (caller-submitted fieldIds that may be echoed vs server-derived ids that must be generalized to avoid an existence oracle, e.g. `:8867-8872` vs `:15553-15560`) — sharing the flow would risk regressing those oracle protections. Rationale: the predicate is the actual invariant worth centralizing (and worth a guard test, §4 GW7); the flow is route-shaped.
- **F3 (fieldPermissions source + performance posture)**: derive via `deriveFieldPermissions(visibleFields, capabilities, { fieldScopeMap: await loadFieldPermissionScopeMap(query, sheetId, actorId) })` — ONE extra indexed read on `field_permissions (sheet_id, subject_id)` per **debounced flush build** (bridge) / per single-record request. Acceptable: the bridge already does `resolveSheetCapabilitiesForUser` (itself DB-backed) per flush build, and flushes are debounced (`mergeWindowMs: 200, maxDelayMs: 500`, `index.ts:2497`), not per-keystroke; the single-record route already runs `resolveSheetCapabilities`. No new hot-path cost profile. The bridge SHOULD reuse the `fields` it already loaded (only the scope-map read is new).
- **F4 (fail-closed + atomic)**: if ANY changed field in the flush/request is forbidden, the WHOLE write is rejected with ZERO mutation (no version bump, no revision, no partial field write) — matching how the property-level guard already behaves and how the W1-2 B1 masked-target golden pins it for structural read-only.
  - Bridge: the builder logs coarsely (`[yjs-bridge] per-subject field write denied` — no field VALUES, values-free) and returns `null`; `executePatch` already maps a null input to "no write" (`yjs-record-bridge.ts:~223`). No HTTP surface, so no existence-oracle concern; the deny is observable via log + a bridge metric.
  - Single-record PATCH: `sendForbidden(res, …)` before the write, parity with grid `/patch`; message generalized (caller-submitted ids, same non-leak posture as `/patch`).
- **F5 (semantics anchor)**: `field_permissions.read_only = true` for `(subject_type, subject_id, field_id)` ⇒ that subject cannot write that field; a field with no explicit rule ⇒ permissive entry; a missing/not-visible entry ⇒ forbidden (never a false block of a normal field — `deriveFieldPermissions` gives every visible field an entry). This is the EXISTING derive, unchanged; W1-3 only routes the two missing paths through it.

## §3 Non-goals (explicit)
No `field_permissions` schema/semantics change; no spine change (property-level posture preserved — the intentional contract); no behavior change to the six working route gates (predicate extraction is refactor-neutral, asserted by GW6); not Yjs GA/productionize; not W1-1 recompute; not W1-2 capability enforcement (siblings, cross-referenced).

## §4 Golden matrix (fail-first, real-DB)

| # | Scenario | Locked outcome |
| --- | --- | --- |
| GW1 (headline) | actor with a per-subject `read_only` `field_permissions` rule on field F writes F **via the Yjs bridge** | flush REJECTED, zero side effects (record `version` unchanged, no `meta_record_revisions` row, F unchanged) |
| GW2 | the SAME field F written via the bridge by an actor WITHOUT the restriction | write LANDS (proves the gate is per-subject, not a blanket bridge block) |
| GW3 | mixed bridge flush on one record: forbidden field F + allowed field G | BOTH rejected atomically — G is NOT written (parity with the property-level guard's all-or-nothing) |
| GW4 | per-subject read-only field write via **`PATCH /records/:recordId`** (single-record OAPI) | 403 `sendForbidden`, zero side effects |
| GW5 | same single-record PATCH by an unrestricted subject | 200, write lands |
| GW6 (regression) | everyday grid `/patch`, restore-execute, revert-execute against a per-subject read-only field | behavior byte-identical to today (the six existing gates untouched; if the predicate was extracted, they still reject exactly as before) |
| GW7 (durable guard, recommended) | structural: every write path that reaches `patchRecords`/`patchRecord` is enumerated against a frozen allowlist of "has a layer-3 gate (or is exempt with a one-line reason)" | a NEW write path added without the gate trips RED — prevents this exact side-door from regressing (same discipline as the stored-data taint-chokepoint guard) |

## §5 Rollout
No new env flag, no migration, no schema change. Two runtime touch points (bridge builder in `index.ts`; single-record handler in `univer-meta.ts`) + one tiny shared predicate helper + the goldens. Lands as ONE runtime PR after ratification. Fail-closed by construction: the change can only ADD denials for the exact per-subject-restricted case the other six routes already deny — it cannot newly block a normal field (F5).

## §6 Arc placement
- ✅ **W1-1** formula freshness (Yjs-bridge recompute + expression-change bulk recompute) — merged `26af7a560`
- ⬜ **W1-2 B1** side-door capability goldens — PR #3649 (open)
- ⬜ **W1-3** per-subject field-write gate on the two uncovered paths — **this lock**
- 🔒 W1-2 B2–B4 (rest of the permission matrix) · 🔒 GW runtime · 🔒 S3/S4/S5 (owner-gated)
