# Personal views — PROGRAM COMPLETION INDEX — 2026-07-06

> Single-glance state of the per-user personal-views program: every slice, its goldens, the load-bearing
> invariants, and the enablement go/no-go inputs. The feature is **default-OFF and NOT enable-ready** — this doc
> is the consolidated map an owner needs before deciding to flip `MULTITABLE_ENABLE_PERSONAL_VIEWS`. Produced by
> the unattended cadence loop as a for-review docs artifact; nothing here is merged or enabled.

## What the program delivers

Per-user "personal views": a user can keep their own **filter / sort / group / field-visibility / field-order**
on any view they can read, as a **presentation overlay** that never changes the shared view, the underlying data,
permissions, or what any other user sees. Storage is a new actor-scoped table `meta_view_personal_configs
(view_id, user_id, config jsonb)`, unique on `(view_id, user_id)`.

## Load-bearing invariants (hold across every slice)

- **§1-B actor-scoped, fail-closed.** Every read/write of personal config is keyed to the **authenticated actor**
  (`resolveRequestAccess(req).userId` / `access.userId` ← `req.user`), NEVER a client-supplied id. Anti-precedent
  (never reused): the legacy `view_states`/`kanban` `x-user-id` / `|| 0` paths.
- **FE sends no identity.** The client carries only `Authorization` + `x-tenant-id` (`apps/web/src/utils/api.ts`);
  no `userId`/`x-user-id` on any personal-config request. Server resolves the actor from the JWT.
- **Presentation-only / shared-fallback.** Absent/partial override ⇒ the shared config, byte-identical to today.
- **Default-OFF.** Every surface is gated on `MULTITABLE_ENABLE_PERSONAL_VIEWS` (per-request read; no caching).

## Slices

| Slice | Scope | State | Key goldens |
|---|---|---|---|
| **1** | table + resolution contract + shared-fallback (backend); `GET/PUT/DELETE .../personal-config` | **merged** (#3637) | G-A/G-C actor isolation + forged-identity, G-B byte-identical; observed-RED banked (#3639) |
| **2** | per-user field-order overlay facet | **merged** (#3657) | field-order isolation + byte-identical + additive |
| **3** | FE "My view" toggle + write-routing; **P1**: `/context` main-path overlay (before select/redaction) + `personalOverrideViewIds`; toggle-OFF = delete+refetch; `syncFromServer` | **merged** (#3711) | G-FE-1 (no identity leak, observed-RED) / G-FE-2 (write routing) / G-FE-3 (reset) / G-FE-4 (flag-off inert); CTX-A/CTX-B/CTX-ISO real-DB |
| **3b** | FE `fieldOrder` render consumer (columns follow `view.fieldOrder`), fail-soft | **merged** (#3726) | G-FE-5: unknown/stale/hidden/duplicate/non-string ids ignored — no crash, no blank/dropped column |
| **3c** | personal column-reorder **write** path (drag → personal-config, never shared `field.order`) | **for-review** (#3728) | C1 write-target routing (asserts shared `updateField` NOT called in personal mode); C2 preserve other facets (read-merge-write) |
| **3d** | **all** in-place personal writes additive (read-merge-write) so a single-facet edit preserves the rest | **for-review** (#3731) | existing config + single-facet edit ⇒ others preserved; cross-facet durability; clear-via-undefined; grid wiring |

Design-lock §6 scoped Slices 1–3; 3b/3c/3d are the natural read/render + write completions surfaced during
review. Each slice shipped a design ref + fail-first goldens + a verification MD under `docs/development/`.

## Enablement gate (owner-gated — the go/no-go)

Flag-on is BLOCKED until (per `multitable-personal-views-flag-on-checklist-20260705.md` §B, re-run per slice):
1. `access.userId` is the fully-authenticated identity in the target deployment (trace the auth middleware).
2. **No `x-user-id` / header shim** anywhere in the live auth path for these routes (else actor-scoping is defeated).
3. Rollback is config-only; speed bounded by env-propagation — rehearse the actual off→on→off (hot vs restart).
4. Observability on the `personal-config` routes + `GET /views`/`/context`; any cross-user anomaly ⇒ immediate off.

This is a deployment audit, **not a code PR** — it needs the owner + a named operator on a dated run.

## Open items on the owner's desk

- **#3728 (Slice 3c)** and **#3731 (Slice 3d)** — both green, for-review, default-OFF. Suggested merge order:
  **#3728 then #3731** (both touch the personal-write path; a trivial rebase may surface on #3731).
- **Dedup cleanup (non-blocking):** once both merge, `utils/reorder-view-fields.ts` (3c) and
  `utils/personal-config-write.ts` (3d) share the same read-merge-write — a later slice can fold them into one helper.
- **Flag enablement:** run checklist §B when ready to turn the feature on.

## Posture

The program is functionally complete end-to-end (see + edit personal views) behind a default-OFF flag, with
actor-isolation and byte-identical shared-path guarantees enforced by goldens (incl. observed-RED on the
load-bearing identity guard). No runtime is enabled; nothing is merged by the loop.
