# Multitable M0 Extraction — Development Notes (2026-04-21)

> Document type: development / status
> Date: 2026-04-21
> Branch: `codex/multitable-m0-extraction-20260421`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/multitable-m0`
> Baseline: `6c5c652d1` (= `origin/main` HEAD)
> Roadmap reference: `docs/development/multitable-service-extraction-roadmap-20260407.md` sections 5.1 and 10

## TL;DR

**Status: BLOCKED — extraction already landed on `main` via an unrelated track, but `univer-meta.ts` still holds divergent inline copies that cannot be removed as a "pure move."**

The three target files the roadmap asks M0 to create (`packages/core-backend/src/multitable/{access,loaders,provisioning}.ts`) and the three target unit test files already exist on `origin/main` (HEAD = `6c5c652d1`). They were introduced incrementally by the after-sales installer track:

| Commit | Subject |
|---|---|
| `2206cc45b` | `refactor(multitable): extract access and loader helpers` |
| `9aa1b8725` | `feat(after-sales): add multitable provisioning views and install shell` |
| `8da4c02c8` | `refactor(multitable): share provisioning field contracts` |
| `3f3079490` | `refactor(multitable): hide physical id resolution behind provisioning helpers` |

All are ancestors of `origin/main` at `6c5c652d1`.

However, `packages/core-backend/src/routes/univer-meta.ts` still contains inline duplicate definitions of the same helpers, and their signatures have **drifted** from the extracted modules during the after-sales track's evolution. Replacing the route's inline copies with imports from the already-extracted modules would require either (a) **expanding** the existing modules' public signatures in a non-additive way, which breaks the "pure move, no behavior change" rule and the roadmap's section 10 constraint that after-sales remain the driver, or (b) **changing call sites** in `univer-meta.ts` to cope with narrower APIs, which is also not a pure move.

No code was changed in this session. No commit was made. Per the task brief's "If blocked, STOP and report" clause, this MD documents the findings and defers to the user.

---

## 1. Files present at HEAD

### 1.1 Target modules (already on `main`)

- `packages/core-backend/src/multitable/access.ts` — exports `normalizePermissionCodes`, `resolveRequestAccess`, `hasPermission`, `deriveCapabilities`, `deriveFieldPermissions`, `deriveViewPermissions`, `deriveRowActions` plus type aliases. 156 lines.
- `packages/core-backend/src/multitable/loaders.ts` — exports `loadSheetRow`, `loadFieldsForSheet`, `tryResolveView` plus type aliases. 95 lines.
- `packages/core-backend/src/multitable/provisioning.ts` — exports `ensureLegacyBase`, `ensureSheet`, `ensureFields`, `createSheet`, `ensureView`, `createView`, `ensureObject`, ID helpers, and contract types. 417 lines.

### 1.2 Target unit tests (already on `main`)

- `packages/core-backend/tests/unit/multitable-access.test.ts` (3042 bytes)
- `packages/core-backend/tests/unit/multitable-loaders.test.ts` (2664 bytes)
- `packages/core-backend/tests/unit/multitable-provisioning.test.ts` (10514 bytes)

### 1.3 Consumer of the already-extracted modules

- `packages/core-backend/src/index.ts` imports provisioning helpers directly (line 49).
- The after-sales installer relies on the current provisioning-module shapes.

---

## 2. Divergence catalog (route inline vs. module)

`grep` targets run against `packages/core-backend/src/routes/univer-meta.ts`:

| Helper | Inline location | Inline signature | Module signature | Diff |
|---|---|---|---|---|
| `ensureLegacyBase` | L3162 | `(query: QueryFn) => Promise<string>` | same | identical — safe delete |
| `loadSheetRow` | L3310 | `(query: QueryFn, sheetId) => Promise<{id, baseId, name, description}\|null>` | `(query: MultitableLoaderQueryFn, sheetId) => Promise<MultitableSheetRow\|null>` | structurally compatible — safe delete if `QueryFn` and `MultitableLoaderQueryFn` are assignment-compatible |
| `loadFieldsForSheet` | L3328 | `(query: QueryFn, sheetId) => Promise<UniverMetaField[]>` | `(pool: { query: MultitableLoaderQueryFn }, sheetId, cache?) => Promise<MultitableField[]>` | **arg shape differs**: inline takes `query` directly; module takes `{ query }` |
| `tryResolveView` | L1803 | `(pool: { query: QueryFn }, viewId) => Promise<UniverMetaViewConfig\|null>` | `(pool: { query }, viewId, cache?) => Promise<MultitableViewConfig\|null>` | module uses caller-provided `cache`; inline uses module-level `metaViewConfigCache` — observable behavior different (cache isolation) |
| `resolveRequestAccess` | L1939 | `(req) => Promise<{ userId, permissions, isAdminRole }>` | `(req) => Promise<{ permissions, isAdminRole }>` | **module drops `userId`**; many call sites in `univer-meta.ts` read `access.userId` (L2666, L2689, L2712, L2737, L2791, L2972, L3799, L3899, L4075, L8143, L8411) |
| `deriveCapabilities` | L1972 | returns 10 fields incl. `canManageSheetAccess`, `canExport` | returns 8 fields | **module missing two capability fields**; call sites read `capabilities.canManageSheetAccess` at L2545, L2557, L2617; `canExport` at L2546, L2561 |
| `ensureSheet` | not inline | n/a | `(input: { query, sheetId, baseId?, name, description? }) => Promise<MultitableProvisioningSheet>` | module-only; route uses raw `INSERT` at L3716, L5861 |
| `ensureFields` | not inline | n/a | `(input: { query, sheetId, fields }) => Promise<MultitableProvisioningField[]>` | module-only; route uses raw `INSERT` at L3724, L4829 |

### 2.1 Load-bearing evidence for blocker call

Grep for `access.userId`, `canManageSheetAccess`, `canExport` against `univer-meta.ts`:

- `access.userId` is read in at least 11 locations to gate 401 responses and to pass to sheet-permission scope loaders — dropping it from the return type is a compile-time break.
- `canManageSheetAccess` and `canExport` are read by `serializeSheetCapabilitiesResponse` logic around L2545–L2617 — they are part of the REST response body and the permission-scope composition.

Both are observable, non-trivial behaviors. Replacing the inline `deriveCapabilities` with the module version would change HTTP responses and would additionally fail TypeScript compilation at call sites.

---

## 3. Why pure-move extraction is not possible

The task brief's rule 1 states:

> **Pure move, no behavior change.** Signatures preserved, argument order preserved, return types preserved.

Any of the three resolution paths conflicts with this rule or the task's scope:

### 3.1 Path A — widen module APIs to match inline

Add `userId` to `resolveRequestAccess` return; add `canManageSheetAccess`/`canExport` to `MultitableCapabilities`; accept `query: QueryFn` directly in `loadFieldsForSheet`; fall back to a module-level cache in `tryResolveView`.

- Touches after-sales consumers via shared types, increases surface area, and is not "preserved signatures."
- Is scope expansion that the user has not authorized.

### 3.2 Path B — narrow route call sites to match module

Change every `access.userId` read in `univer-meta.ts` to re-derive from `req.user`; delete `canManageSheetAccess`/`canExport` from the REST response; inject caches explicitly at every `tryResolveView` / `loadFieldsForSheet` call.

- Changes observable REST response body (removes two capability fields).
- Is a behavior change, not a pure move.

### 3.3 Path C — leave inline copies, declare M0 done

Because substance-wise the M0 deliverable (the three files + tests) is on `main`, one could argue M0 is already done and close this work.

- This leaves `univer-meta.ts` with ~60 lines of dead-duplicate helpers and two signatures drifting from the extracted modules. Does not satisfy roadmap section 11's M0 "新功能通过 helper 接入" criterion — any new code added to `univer-meta.ts` still has the inline helpers as the path of least resistance.
- Violates hard rule #2 from roadmap section 10: "不再往 `univer-meta.ts` 新增核心 SQL，除非只是转调新 helper."

None of A/B/C is a safe, in-scope move. All require user sign-off.

---

## 4. What was done this session

- Confirmed baseline at `6c5c652d1` on branch `codex/multitable-m0-extraction-20260421`.
- `pnpm install --prefer-offline` — ok.
- Read the full roadmap.
- Read `packages/core-backend/src/routes/univer-meta.ts` (8714 lines) to locate every target helper.
- Catalogued divergences between inline and module APIs (section 2).
- Traced all call sites for `access.userId`, `canManageSheetAccess`, `canExport` to verify load-bearing usage.
- No edits to any `.ts` file. No commit.

---

## 5. Follow-ups

### 5.1 If user picks Path A (widen modules)

Steps:

1. Add `userId: string` to `resolveRequestAccess` return type.
2. Add `canManageSheetAccess: boolean` and `canExport: boolean` to `MultitableCapabilities` in `multitable/access.ts`.
3. Add an optional `cache?: Map<...>` parameter to `tryResolveView` and `loadFieldsForSheet` (already present for `tryResolveView`).
4. Adapt `loadFieldsForSheet` to accept `(query: QueryFn, sheetId)` overload, or swap `univer-meta.ts` call sites to `{ query }`.
5. Delete inline copies in `univer-meta.ts`.
6. Add regression tests covering new capability fields.
7. Audit after-sales installer for any assumption that the old return shapes are exhaustive.

Risk: medium — touches the installer's type surface. Estimated diff: ~200 LoC across 4–5 files.

### 5.2 If user picks Path B (narrow route)

Steps:

1. Replace each `access.userId` with `normalizeUserId(req)` local helper that re-reads from `req.user`.
2. Remove `canManageSheetAccess` and `canExport` from route responses and update frontend consumers if any rely on them.
3. Thread explicit caches at every existing call site.

Risk: high — frontend consumer contracts may break. Not recommended without a wider spec.

### 5.3 If user picks Path C (leave it)

Steps:

1. No code changes.
2. Update roadmap section 5.1 to note M0 is done in substance and delete this bullet from future PR plans.
3. Optionally add a `// TODO(multitable-m0): replace with multitable/access.resolveRequestAccess when signatures converge` comment on each inline helper.

Risk: low — but leaves the technical debt the roadmap was created to eliminate.

---

## 6. Recommendation

Path A with additive-only widening is the cleanest path to the roadmap's intent. It makes the inline helpers in `univer-meta.ts` genuinely replaceable by imports and does not break existing after-sales consumers because all added fields are strictly additive. It does cross the "pure move" boundary, so it needs the user's explicit sign-off to expand scope from "extract" to "reconcile."

If Path A is approved, the corresponding commit message should be:

```
refactor(multitable): reconcile univer-meta helpers with shared modules

Widens packages/core-backend/src/multitable/{access,loaders}.ts to cover
the capability fields and return shape that univer-meta.ts call sites
depend on (userId, canManageSheetAccess, canExport, direct QueryFn
overload on loadFieldsForSheet). Removes the ~60 lines of duplicate
inline helpers in univer-meta.ts; route now delegates to the shared
modules.

Closes the M0 gap documented in
docs/development/multitable-service-extraction-roadmap-20260407.md
where after-sales had already landed the shared modules but univer-meta.ts
still carried divergent inline copies.
```

This is different from the "pure move" commit the task brief specified, so the brief itself would need an amendment.

---

## 7. References

- Roadmap: `docs/development/multitable-service-extraction-roadmap-20260407.md`
- Task brief: session instructions (M0 extraction, 2026-04-21)
- Current file: `packages/core-backend/src/routes/univer-meta.ts` @ `6c5c652d1`
- Target modules: `packages/core-backend/src/multitable/{access,loaders,provisioning}.ts` @ `6c5c652d1`
- Target tests: `packages/core-backend/tests/unit/multitable-{access,loaders,provisioning}.test.ts` @ `6c5c652d1`

---

## Path A execution — 2026-04-21

Path A (additive widening) approved by user and executed in the same worktree. All four modules widened additively; route-side inline duplicates removed; no external HTTP contract change.

### Files touched

- `packages/core-backend/src/multitable/access.ts` — widened
- `packages/core-backend/src/multitable/loaders.ts` — widened
- `packages/core-backend/src/routes/univer-meta.ts` — inline duplicates deleted; imports added
- `packages/core-backend/tests/unit/multitable-access.test.ts` — existing assertions updated + 3 new cases
- `packages/core-backend/tests/unit/multitable-loaders.test.ts` — 4 new cases covering new signatures

No change to `provisioning.ts` — its `ensureLegacyBase` matched the inline version verbatim and simply needed re-wiring at the route.

### Final widened signatures

**`multitable/access.ts`**

```ts
export type MultitableCapabilities = {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageSheetAccess: boolean  // NEW
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
  canExport: boolean  // NEW
}

export type ResolvedRequestAccess = {
  userId: string  // NEW (now returned by resolveRequestAccess)
  permissions: string[]
  isAdminRole: boolean
}

export async function resolveRequestAccess(req: Request): Promise<ResolvedRequestAccess>
export function deriveCapabilities(permissions: string[], isAdminRole: boolean): MultitableCapabilities
// deriveCapabilities now populates canManageSheetAccess (gated by multitable:share
// or admin) and canExport (== canRead, matching the inline route semantic).
```

**`multitable/loaders.ts`**

```ts
function normalizeQueryArg(
  arg: MultitableLoaderQueryFn | { query: MultitableLoaderQueryFn },
): MultitableLoaderQueryFn

const DEFAULT_VIEW_CACHE = new Map<string, MultitableViewConfig>()

// All three loader fns now accept EITHER a raw query fn OR a { query } wrapper
export async function loadSheetRow(
  poolOrQuery: MultitableLoaderQueryFn | { query: MultitableLoaderQueryFn },
  sheetId: string,
): Promise<MultitableSheetRow | null>

export async function loadFieldsForSheet(
  poolOrQuery: MultitableLoaderQueryFn | { query: MultitableLoaderQueryFn },
  sheetId: string,
  cache?: Map<string, MultitableField[]>,
): Promise<MultitableField[]>

// tryResolveView now falls back to DEFAULT_VIEW_CACHE when no cache supplied
export async function tryResolveView(
  poolOrQuery: MultitableLoaderQueryFn | { query: MultitableLoaderQueryFn },
  viewId: string,
  cache: Map<string, MultitableViewConfig> = DEFAULT_VIEW_CACHE,
): Promise<MultitableViewConfig | null>
```

### Deleted inline implementations in `univer-meta.ts`

Using the pre-edit line numbers from §4 of the recon:

- L182  `type MultitableCapabilities = {...}` — 10-field type, replaced by import from `multitable/access`
- L1803 `async function tryResolveView(pool, viewId)` — 25-line inline replaced with a 10-line wrapper that delegates to `tryResolveViewShared(pool, viewId, metaViewConfigCache)`; route-level cache preserved by explicit pass-through (advisor-recommended path over module-level fallback, to keep existing `metaViewConfigCache.set/delete` call sites at L1759/L1762/L5343/L5422/L5470/L5623/L5696 observably unchanged)
- L1821 `type ResolvedRequestAccess = {...}` — replaced by import
- L1829 `function normalizePermissionCodes` — removed (imported from `multitable/access`)
- L1913 `async function resolveRequestAccess` — removed (imported)
- L1940 `function hasPermission` — removed (imported)
- L1946 `function deriveCapabilities` — removed (imported)
- L3077 `async function ensureLegacyBase` — replaced with `const ensureLegacyBase = ensureLegacyBaseShared`
- L3217 `async function loadSheetRow` — replaced with `const loadSheetRow = loadSheetRowShared`
- L3235 `async function loadFieldsForSheet` — replaced with `const loadFieldsForSheet = loadFieldsForSheetShared`

Net: `-168` / `+30` LoC at `univer-meta.ts`, `+21` LoC at `access.ts`, `+28` LoC at `loaders.ts`, `+129` LoC at the two unit tests.

### Surprises and notes

- **Five copies of `MultitableCapabilities` exist in the codebase** (access.ts, permission-derivation.ts, sheet-capabilities.ts, record-write-service.ts, and the now-deleted route copy). The task scope is `access.ts` only; the other three already carry the 10-field shape. Consolidating them is left for a later M-step.
- **`UniverMetaViewConfig` (route, L115) and `MultitableViewConfig` (loaders.ts, L20) are structurally identical** but TypeScript treats `Map<K, A>` and `Map<K, B>` as invariant, so the cache pass-through uses a cast: `metaViewConfigCache as Map<string, SharedMultitableViewConfig>`. This is the only cast added; it is safe because every writer writes records that satisfy both types.
- **`loadSheetFields` at L1787 (route) was NOT deleted.** It is a DIFFERENT function than `loadFieldsForSheet` — it uses the route-level `metaFieldCache` and is invoked at L4782 and L5809. It is not in the 6-line deletion catalog and is out of scope for M0.
- `isAdmin` and `listUserPermissions` imports from `../rbac/service` are KEPT in `univer-meta.ts` because L2144/L2145 still call them directly from the candidate-resolution flow. They are no longer referenced by the deleted inline `resolveRequestAccess` (that logic now lives in `multitable/access.ts`).
- `DEFAULT_BASE_ID` and `DEFAULT_BASE_NAME` module-level consts at route L144/L145 are now unused; kept because `tsconfig.json` does not set `noUnusedLocals` and removing them is orthogonal to this change.
- **`DEFAULT_VIEW_CACHE` footgun (design note for the next agent).** `multitable/loaders.ts` now holds a module-level `DEFAULT_VIEW_CACHE: Map<string, MultitableViewConfig>` that `tryResolveView` falls back to when no cache is passed. The task brief explicitly requested this default. However: a future caller who forgets to pass a cache would silently share a process-global singleton with no invalidation hook. This is fine today because the sole route consumer explicitly passes `metaViewConfigCache`, but any downstream new caller needs to either own a cache or accept shared-global semantics. M1 should surface this by requiring the cache argument at each documented caller (or adding a `resetDefaultViewCache()` export).
