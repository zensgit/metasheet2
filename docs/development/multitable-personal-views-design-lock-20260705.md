# Personal (per-user) views — DESIGN-LOCK — 2026-07-05

> Ratifies the design for **Track 2b** of `multitable-capability-depth-hardening-plan-20260619.md` ("Per-user /
> personal views — heavy, design-lock first"). Per that plan's gating, the heavy tracks "get a design-lock doc +
> owner ratification before implementation … This plan does not authorize building any of them."
>
> **This is a for-review PROPOSAL.** No runtime in this PR. The owner's **ratification (merge) authorizes the
> implementation**; nothing is built until then. Grounded on `origin/main` @ `57df6046b`. Chosen as the next
> greenfield sample for its narrow boundary + low risk (presentation overlay, no data/permission mutation).

## 0. Problem (current state)

- **All view config is SHARED**: one filter / sort / group set per view, seen by everyone.
- **Field order is sheet-global**: reordering affects all views and all users.
- There is no per-user personalization: a user cannot keep their own filter/sort/order without changing it for
  everyone.

Existing infra to build ON (not duplicate): the current multitable view model — `meta_views` + `meta_view_config`
+ `meta_view_permissions` + `routes/views.ts`. (A legacy `tables`/`views` model also exists in an older migration;
the implementation must target the CURRENT `meta_views` system, confirmed as-built — see §7 Q1.)

## 1. Locked decisions (what the owner ratifies)

- **A — Personalization is a PRESENTATION OVERLAY, never a data/permission change.** A personal view overrides only
  *how a user sees* an existing view (filter / sort / group / field-order / field-visibility). It never changes the
  underlying data, the view's existence, its permissions, or what any OTHER user sees. This is the spine invariant.
- **B — Per-user isolation is FAIL-CLOSED and actor-scoped (load-bearing security).** A personal override is
  readable/writable ONLY by its owning user. Every read/write of personal config is keyed to the **authenticated
  actor**, never a client-supplied user id. No cross-user read, no cross-user write. (The permission/no-oracle
  membrane applied to per-user config.) **Anti-precedent (do NOT inherit):** the legacy `view_states` path resolves
  the user via `x-user-id` / `|| 0` — personal views take the target user from the authenticated identity ONLY.
- **C — Resolution contract (shared-fallback, deterministic).** On view open, the effective config is:
  `personal override for THIS actor (if a row exists AND the actor has view-read)` **ELSE** `the shared view config`.
  The shared config is always the fallback; an absent/partial override degrades to shared, never to empty/broken.
  Resolution precedence is explicit and total.
- **D — Overlay is field-granular and additive.** A personal override may set any subset of {filter, sort, group,
  field-order, field-visibility}; unset facets fall through to shared. Reordering/hiding a field for oneself does not
  change the shared order/visibility.
- **E — Scope is per-USER only (v1).** Team/role-scoped personal views are OUT of v1 (a later, separate design-lock).

## 2. Risk class + blast radius

- **Primary risk: cross-user leak (permission / per-user-isolation).** A resolution-keying bug could show user A's
  personal filter to user B, or let A write B's override. This is the load-bearing failure mode → §1-B fail-closed,
  actor-scoped, and the G-A/G-C goldens below.
- **NOT** a data-write risk (presentation only), **NOT** cross-base, **NOT** destructive/irreversible. This narrow
  blast radius is why personal-views is the recommended first owner-ratified greenfield sample.

## 3. Proposed defaults (owner ratifies / overrides)

- **P1 — Availability:** every user may personalize any view they can **read**. (Presentation-only ⇒ low risk; no
  per-view opt-in needed.) Owner may instead choose per-sheet opt-in — PROPOSED default: available on all readable views.
- **P2 — Rollout:** land behind a flag **default-OFF** (enablement gate); flag-on requires the per-user isolation
  goldens green + an actor-scoping audit (§5).
- **P3 — Fallback:** absent/partial personal override ⇒ shared config, **byte-identical** to today's shared path.
- **P4 — Field order:** introduce per-view field order with a per-user personal override; the shared per-view order
  (if any) is separate from the per-user overlay. (Owner may defer per-view SHARED order to keep v1 to per-user only.)

## 4. Fail-first goldens (the future build MUST ship; discriminator-sound)

- **G-A (per-user read isolation — LOAD-BEARING):** user A's personal override is NOT visible to user B; B sees the
  shared config. RED-condition: resolution keys on anything but the authenticated actor (e.g. a client-supplied
  user id, or an unscoped query).
- **G-B (shared fallback byte-identical):** a user with no personal override sees the shared config **bit-for-bit**
  identical to today. RED: the overlay perturbs the shared path.
- **G-C (per-user write isolation):** user A cannot create/update user B's personal override; the write is
  actor-scoped. RED: the write accepts/honors a client-supplied target user id.
- **G-A/G-C forged-identity clause (per review):** a forged `body.userId` / `query.userId` / `x-user-id` header MUST
  NOT change which user's personal config is read or written — the target user is the authenticated actor, full stop.
  RED: any of those inputs alters the read or write target.
- **G-D (presentation-only):** a personal override changes NO record data, NO permission, and NO other user's
  effective view. RED: any overlay path mutates data/permission/shared config.
- Each behavior slice records the **observed RED** (revert the guard → the golden fails) in its verification MD.

## 5. Enablement gate (Decision-F equivalent)

Land default-off. **Flag-on is BLOCKED until:** G-A + G-C are green in required CI, AND an audit confirms every
personal-config read/write path is actor-scoped (no code path reads/writes personal config by a client-supplied user
id). The build PR text must state the feature is default-off and NOT enable-ready.

## 6. Slice sequencing (each ships design-ref + fail-first goldens + verification MD)

1. **Slice 1 (L2):** data model + resolution contract + shared-fallback (backend), **flag-off inert**, shared path
   byte-identical (G-B), per-user isolation (G-A/G-C). No FE.
2. **Slice 2 (L2):** per-view / per-user field order + visibility overlay.
3. **Slice 3 (L2):** FE — a "my view" personalize toggle + editor; labelled so it never implies changing the shared view.

## 7. Open questions for the owner (ratify the answers, or accept the proposed default)

- **Q1 — Data model (LOCKED per review — was open, now closed):** v1 data model is a **NEW table**
  `meta_view_personal_configs(view_id, user_id, config jsonb, updated_at)`, **FK to `meta_views(id)`**, **unique
  `(view_id, user_id)`**. `user_id` is ALWAYS the authenticated actor — **NEVER from request body / query / header**.
  The legacy `views` / `view_states` / `kanban` state is a **NON-GOAL and an explicit ANTI-PRECEDENT**: those routes
  resolve the user via a client-supplied `x-user-id` header (`routes/kanban.ts:25`) and a `|| 0` default
  (`routes/views.ts:273,298`) — which directly violates §1-B. Personal views **MUST NOT reuse or extend `view_states`**;
  they use the new `meta_view_personal_configs` table only.
- **Q2 — P1 availability** (all-readable-views vs per-sheet opt-in) — PROPOSED: all readable views.
- **Q3 — P4 per-view SHARED field order** in v1, or per-user override only — PROPOSED: per-user override only in v1.

## 8. Non-goals

Team/role-scoped views; cross-base personal views; changing data/permissions; the legacy `tables` / `views` /
`view_states` / `kanban` state — an **anti-precedent** (client-supplied `x-user-id` / `|| 0`), never reused. This
lock covers per-user presentation overlay on the current `meta_views` system only, via the new
`meta_view_personal_configs` table.
