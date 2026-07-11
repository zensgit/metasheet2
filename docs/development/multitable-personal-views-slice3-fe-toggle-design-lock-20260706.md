# Personal views — Slice 3 (FE personalize toggle) — DESIGN-LOCK — 2026-07-06

> Sub-lock for **Slice 3** of the parent lock `multitable-personal-views-design-lock-20260705.md` §6
> ("FE — a 'my view' personalize toggle + editor; labelled so it never implies changing the shared view").
> Slice 1 (backend model + resolution) shipped default-OFF (#3637); Slice 2 (per-user field-order overlay)
> is for-review (#3657). This lock nails the **FE contract** so the Slice 3 build has a ratified spec.
>
> **This is a for-review PROPOSAL.** No runtime in this PR. The owner's **ratification (merge) authorizes the FE
> implementation**; nothing is built until then, and the build additionally waits until Slice 2 (#3657) merges so
> the backend overlay contract (incl. `fieldOrder`) is settled on main. Grounded on `origin/main` @ `7015a5133`.

## 0. What already exists (build ON, do not duplicate)

- **Backend contract is complete and on main / for-review:** `GET /api/multitable/views` serves each `MetaView`
  with `filterInfo`/`sortInfo`/`groupInfo`/`hiddenFieldIds`/`fieldOrder`, and — when the flag is on and a personal
  row exists for the actor — the server already applies the overlay server-side (`applyPersonalViewOverlay` in
  `packages/core-backend/src/multitable/personal-view-config.ts`; wiring in `routes/univer-meta.ts`). Routes
  `GET/PUT/DELETE /api/multitable/views/:viewId/personal-config` exist (Slice 1), keyed to the authenticated actor.
- **FE view store & config surface (the integration points):**
  - Fetch: `apps/web/src/multitable/api/client.ts` — `MultitableApiClient.listViews(sheetId)` (**1624-1627**),
    `updateView` (**1638-1645**), `deleteView` (**1647-1650**). All go through `this.fetch` → `apiFetch`.
  - Store: `apps/web/src/multitable/composables/useMultitableWorkbench.ts` — `views` (**47**), `activeView` (**60-61**),
    populated from `ctx.views` (**122**).
  - Config-mutation call sites today: `useMultitableGrid.ts:765,823,838` (`updateView({ hiddenFieldIds… })`),
    `MultitableWorkbench.vue:2530,2747-2768`.
  - UI homes: `MetaViewTabBar.vue` (per-view tab strip) and `MetaToolbar.vue` (hidden-field/sort/filter/group surface).
- **Identity path (LOAD-BEARING — confirmed as-built):** every FE request carries **only**
  `Authorization: Bearer <jwt>` + `x-tenant-id` (`apps/web/src/utils/api.ts:147-161`, `authHeaders()`). There is **no
  `x-user-id`, no `userId` header/param anywhere** in the request path. Comment at `useYjsDocument.ts:126` states the
  house rule verbatim: "Pass JWT token for server-side verification — not raw userId." Slice 3 MUST preserve this.

## 1. Locked decisions (what the owner ratifies)

- **A — The FE NEVER sends a user id. Full stop.** The new personal-config client methods use the identical
  `this.fetch` path as `updateView`/`deleteView`; they pass **no** `userId`/`user_id` body field, **no** query param,
  **no** `x-user-id` header. The server resolves the target user from the JWT actor (§1-B of the parent lock). Any FE
  code that adds a user-identity field to a personal-config request is a lock violation. This is the spine of Slice 3.
- **B — Slice 3 is presentation only, and additive over the shared view.** The toggle switches which config the LOCAL
  client renders/edits (personal overlay vs shared); it changes no data, no permission, and nothing any other user
  sees. Turning the personal view OFF ("reset to shared") deletes the actor's own personal row and returns the client
  to the byte-identical shared config (parent lock G-B / G-D).
- **C — Labelling is unambiguous.** The affordance reads as personal ("My view" / "个人视图" / "reset to shared"),
  never as an edit to the shared view. Editing filter/sort/group/hidden/order while the personal toggle is ON writes
  the **personal** row (PUT personal-config); the same edits while OFF keep today's `updateView` shared-write path.
  The two write targets must be visually and behaviorally distinct so a user cannot mistake one for the other.
- **D — Flag-gated and inert when off.** Slice 3 renders the toggle only when personal views are enabled for the
  session (the FE learns this from the same enablement signal the backend uses — see §7 Q1); flag-off ⇒ the toggle is
  absent and every path is byte-identical to today (no new request, no layout shift). Default-OFF ships.
- **E — No optimistic cross-session assumptions.** The personal overlay is applied **server-side** on `GET /views`
  already; the FE toggle's job is (i) PUT/DELETE the personal row and (ii) re-fetch so the server returns the
  now-effective config. The FE does not itself compute the overlay merge (avoids drift from the server contract).

## 2. Risk class + blast radius

- **Primary risk: mislabelled write target** — a user edits believing it is personal but writes the shared view (or
  vice-versa), OR the FE regresses the identity invariant by adding a userId to a request. Both are §1-A/§1-C failures
  → the G-FE goldens below.
- **NOT** a new server surface (routes exist), **NOT** a data-write/permission risk (presentation overlay), **NOT**
  cross-user (server stays actor-scoped regardless of FE). Blast radius is confined to this client's own rendering.
  This is why Slice 3 is **L2** (clear spec against a locked backend contract), buildable by Sonnet5.

## 3. Proposed defaults (owner ratifies / overrides)

- **P1 — Affordance home:** a per-view toggle in `MetaViewTabBar.vue` (next to the active tab) + a "reset to shared"
  action in `MetaToolbar.vue`. PROPOSED default; owner may prefer it in the view-settings modal (`MetaViewManager.vue`).
- **P2 — Write routing:** while personal is ON, the existing config edits (`useMultitableGrid.ts:765,823,838`) route
  to `putPersonalViewConfig` instead of `updateView`; while OFF, unchanged. PROPOSED — a single routing switch in the
  grid/workbench composable, not scattered per-control.
- **P3 — Enablement signal:** FE reads a session capability flag (not a hardcoded const) so flag-on/off is config-only
  on both tiers. PROPOSED — surface `MULTITABLE_ENABLE_PERSONAL_VIEWS` state via the existing capabilities/bootstrap
  payload the FE already consumes; **no** new client-side env toggle.

## 4. Fail-first FE goldens (the Slice 3 build MUST ship; discriminator-sound)

- **G-FE-1 (no identity leak in requests — LOAD-BEARING):** every personal-config request the FE emits carries only
  `Authorization` + `x-tenant-id`; assert the serialized request has **no** `userId`/`user_id`/`x-user-id`. RED: the
  client adds any user-identity field/header to a personal-config call.
- **G-FE-2 (write-target routing):** with the personal toggle ON, a filter/sort/group/hidden/order edit calls
  `PUT …/personal-config`; with it OFF, the same edit calls the shared `updateView` (PATCH …/views/:id). RED: an edit
  writes the wrong target for the current toggle state.
- **G-FE-3 (reset-to-shared):** "reset to shared" issues `DELETE …/personal-config` and re-fetches; the rendered
  config then equals the shared config. RED: reset leaves a stale personal overlay, or mutates the shared view.
- **G-FE-4 (flag-off inert):** with personal views disabled for the session, no toggle renders and no personal-config
  request is ever emitted; the view surface is byte-identical to today. RED: any personal UI/request appears flag-off.
- Each records the **observed RED** (revert the guard → the golden fails) in the Slice 3 verification MD. Backend
  actor-isolation (G-A/G-C) is already banked by Slice 1's observed-RED (#3639) and is unchanged by Slice 3.

## 5. Enablement gate

Land default-off. Slice 3 does **not** change the flag-on gate of the parent lock §5 (backend actor-scoping audit +
G-A/G-C green) — it adds the FE goldens G-FE-1..4 as an additional flag-on precondition, and re-runs the deployment
sanity-checks of `multitable-personal-views-flag-on-checklist-20260705.md` §B (which explicitly calls for re-running
§B per slice). The build PR text must state default-off and NOT enable-ready.

## 6. Model tier + slicing

- **Tier: L2** — clear spec against a locked backend contract, default-off, adds NO new identity surface. Buildable by
  **Sonnet5**; escalate to Opus only if the write-routing switch (P2) turns out to touch the shared-write hot path in
  a way that risks G-FE-2. Sequenced AFTER Slice 2 (#3657) merges.
- If Slice 3 grows large, split: **3a** = client methods + toggle + reset (G-FE-1/3/4); **3b** = write-target routing
  for in-place edits (G-FE-2). Each ships design-ref + goldens + verification MD.

## 7. Open questions for the owner (ratify, or accept the proposed default)

- **Q1 — Enablement signal to the FE:** surface `MULTITABLE_ENABLE_PERSONAL_VIEWS` through the existing
  capabilities/bootstrap payload (PROPOSED), vs a dedicated endpoint. Locked either way to **no client-side env
  const** — the FE must not hardcode enablement.
- **Q2 — Affordance home:** tab-bar toggle + toolbar reset (PROPOSED) vs view-settings modal. (§3 P1.)
- **Q3 — In-place-edit routing granularity:** single toggle-driven switch in the composable (PROPOSED) vs per-control.
  (§3 P2.)

## 8. Non-goals

Team/role-scoped personal views; any change to the backend routes or table (they exist and are locked); any FE-side
overlay-merge computation (server applies it); any client-supplied identity. This lock covers ONLY the FE personalize
toggle/editor over the existing actor-scoped `meta_view_personal_configs` contract.
