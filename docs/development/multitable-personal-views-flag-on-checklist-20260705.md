# Personal views — FLAG-ON checklist (`MULTITABLE_ENABLE_PERSONAL_VIEWS`) — 2026-07-05

> A narrow pre-enablement checklist so flipping `MULTITABLE_ENABLE_PERSONAL_VIEWS` on does not rely on memory.
> Slice 1 shipped **default-OFF** (#3637); this doc is the gate between "landed dark" and "enabled". Design-lock:
> `multitable-personal-views-design-lock-20260705.md` §5. Not a runtime PR.

## A. Already satisfied (do not re-litigate)

- [x] **Isolation goldens GREEN in required CI** — `test (20.x)` runs `multitable-personal-views-slice1-realdb.test.ts`
      (G-A read isolation, G-C write isolation + forged-identity, G-B shared byte-identical, flag-off 404). #3637 green.
- [x] **observed-RED confirmed** — a throwaway branch that broke the actor keying made `test (20.x)` FAIL on the
      goldens (job `85215174961`); green-with-guard + red-without = bidirectional teeth. Recorded in the slice-1
      verification MD §5.
- [x] **Byte-identical shared path** — flag-off / no-override returns `effectiveViews === views` (same reference).

## B. Deployment sanity-checks — RUN THESE before flipping the flag on

1. [ ] **`access.userId` is the fully-authenticated identity in THIS deployment.** The overlay's target user comes
       from `resolveRequestAccess(req).userId` / `resolveSheetCapabilities(req).access.userId` (→ `req.user`). Confirm
       `req.user` is populated ONLY by the JWT/session auth middleware on the live path — trace the middleware chain
       for the multitable routes in the target environment.
2. [ ] **No `x-user-id` / header shim.** Confirm no proxy, gateway, or dev/test middleware populates or overrides
       `req.user` (or an upstream `x-user-id`) from a client-controllable header in production. (The legacy
       `kanban.ts:25` / `views.ts:273,298` pattern must NOT be in the live auth path for these routes.) If ANY shim
       exists, DO NOT enable until it is removed or provably unreachable — it would defeat the actor-scoping.
3. [ ] **Rollback is instant + config-only.** `isPersonalViewsEnabled()` is read **per request**, so setting
       `MULTITABLE_ENABLE_PERSONAL_VIEWS` back to unset/false reverts to the shared path immediately — no restart, no
       migration, no data rewrite. Verify the deploy toggles the env without a rebuild, and rehearse the off→on→off.
4. [ ] **Observability while on.** Watch after enable: error rate on `GET/PUT/DELETE /views/:viewId/personal-config`
       and on `GET /views`; overlay-fetch latency on `GET /views` (one extra indexed query per request when on); and
       ANY cross-user anomaly report (a user seeing another's filter/sort ⇒ immediate rollback per #3, then re-audit
       actor-scoping). No metric = enable in a low-traffic window first.

## C. Sign-off

- [ ] Owner decides scope of first enablement (per-instance / per-tenant — note there is no real tenant model yet).
- [ ] B1–B4 all checked, in the target environment, by a named operator, on a dated run.
- [ ] Rollback trigger agreed: any B2 shim found live, or any cross-user leak observed ⇒ set the flag off.

## D. Scope note

This checklist covers Slice 1 (per-user filter/sort/group/visibility overlay). **Slice 2** (per-view/per-user field
order) and **Slice 3** (FE toggle) each extend the same actor-scoped table + goldens and stay default-off; re-run
section B for each before any further enablement, since each adds a read/write surface.
