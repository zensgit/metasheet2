# Personal (per-user) views — Slice 1 — VERIFICATION — 2026-07-05

> Verifies Slice 1 of the ratified design-lock `multitable-personal-views-design-lock-20260705.md` (merged #3631).
> Slice 1 = backend data model + resolution contract + shared-fallback + actor-scoped isolation, **flag default-OFF**.
> No FE, no field-order overlay (slice 2). Built by an unattended L2 agent (Sonnet 5); reviewed by the orchestrator
> (Opus). **Provenance note:** the build agent stalled during its own real-DB self-check *after* the code was
> complete — see §5 for exactly what was and was NOT executed locally.

## 1. What was built

| File | Role |
|---|---|
| `db/migrations/zzzz20260705150000_create_meta_view_personal_configs.ts` | NEW table `meta_view_personal_configs(view_id text REFERENCES meta_views(id) ON DELETE CASCADE, user_id, config jsonb, updated_at)`, `UNIQUE (view_id, user_id)` + view/user indexes (§7 Q1 LOCKED) |
| `multitable/personal-view-config.ts` | Resolution + CRUD module. **Never reads `req`** — callers pass an already-resolved actor id, so a client-supplied id is structurally impossible here (§1-B). `applyPersonalViewOverlay` returns the ORIGINAL view reference when there is no overlay (byte-identical shared path by construction, §1-C/G-B). Facet-whitelist sanitizer drops any smuggled `userId`/`viewId`. Flag gate `isPersonalViewsEnabled()` default-OFF. |
| `routes/univer-meta.ts` | Wiring: on `GET /views`, overlay applied only when `isPersonalViewsEnabled() && requestAccess.userId` and `overlays.size > 0`, else `effectiveViews === views`. Three new routes `GET/PUT/DELETE /views/:viewId/personal-config`, all 404 when flag-off. Target user = `resolveSheetCapabilities(req).access.userId` (JWT/session actor), never body/query/`x-user-id`. `canRead` + `access.userId` fail-closed. Reads `meta_views` (current system), never legacy `views`/`view_states`. |
| `tests/integration/multitable-personal-views-slice1-realdb.test.ts` | Real-DB goldens (below). |
| `.github/workflows/plugin-tests.yml` | Wires the golden into the Node-20 real-DB required step (teeth). |

## 2. Security invariants held (Opus-reviewed against the design-lock)

- **§1-B actor-scoped (LOAD-BEARING):** the target user id is sourced ONLY from the authenticated actor
  (`resolveRequestAccess(req).userId` / `resolveSheetCapabilities(req).access.userId`). The module never sees `req`;
  every SQL keys on `user_id = actorUserId`. A forged `body.userId` / `query.userId` / `x-user-id` cannot select
  another user's row. Confirmed by reading every read/write path.
- **§7 Q1 / §8 anti-precedent:** uses the NEW `meta_view_personal_configs` table only. The legacy
  `views`/`view_states`/`kanban` path (client-supplied `x-user-id` `kanban.ts:25`, `|| 0` `views.ts:273,298`) is NOT
  touched or reused.
- **§1-C / §P2 shared-fallback + flag-off byte-identical:** flag-off OR no override ⇒ `effectiveViews === views`,
  bit-for-bit today's shared config. Not a careful merge — the same object reference.
- **fail-closed:** blank/absent actor ⇒ no overlay / `sendForbidden`.

## 3. Fail-first goldens (discriminator-sound)

- **G-A read isolation (LOAD-BEARING):** A's override applies for A, is INVISIBLE to B (B sees shared); GET
  personal-config is actor-scoped (B never reads A's row). Unset facet falls through to shared (§1-D). RED if
  resolution keys on anything but the authenticated actor.
- **G-C write isolation + forged-identity (LOAD-BEARING):** A writing with forged `body.userId=B` (and the harness
  also injects forged `query.userId` / `x-user-id`) does NOT touch B's row. RED if any client-supplied id alters the
  write/read target.
- **G-B shared byte-identical:** flag-off with an override row present ⇒ shared unchanged; flag-on, no override ⇒
  shared byte-identical. RED if the overlay perturbs the shared path.
- **flag-off inert:** the three new routes 404 (not no-op) when the flag is off.

## 4. Enablement (unchanged from the lock)

Lands **default-OFF** (`MULTITABLE_ENABLE_PERSONAL_VIEWS`). Flag-on is NOT authorized by this slice — per design-lock
§5, flag-on requires G-A + G-C green in required CI + an actor-scoping audit. This PR does not enable the flag.

## 5. What was and was NOT executed locally (honest provenance)

- **Executed / verified by review:** the code is complete and self-consistent (Opus read the module, the wiring, the
  migration, and the goldens end-to-end); arg orders, `effectiveViews` handling, route closure, and the actor-scoping
  are correct.
- **NOT executed locally:** the build agent **stalled during its own real-DB self-check before running the suite**,
  so neither the golden run nor the **observed-RED** (revert the actor-scoping → G-A/G-C go red) was captured here.
  The goldens are **structurally fail-first** (sound discriminators, traced above) and are now wired into the required
  Node-20 real-DB CI step, so the PR's CI is the first real execution.
- **Human reviewer MUST:** (a) confirm the PR's `test (20.x)` runs the new golden GREEN; (b) run the observed-RED once
  (revert the `user_id = actorUserId` keying → confirm G-A/G-C fail) to convert structural-fail-first into
  observed-fail-first before any flag-on; (c) sanity-check that `resolveSheetCapabilities().access.userId` is the
  fully-authenticated identity in this deployment (no upstream shim populates it from a header).
