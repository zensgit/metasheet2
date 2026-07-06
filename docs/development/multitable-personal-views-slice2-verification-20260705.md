# Personal views — Slice 2 (per-user field order) — VERIFICATION — 2026-07-05

> Verifies Slice 2 of the ratified design-lock `multitable-personal-views-design-lock-20260705.md` (§6). Slice 2 adds a
> **per-user field-order** overlay facet, carried through the SAME actor-scoped table + CRUD + resolution as Slice 1
> (#3637, on main). No new table, no new flag, no new client-supplied-id surface. **Default-OFF.** Built in-session
> (Opus) after two build-agent runs died to infra errors (watchdog stall / API disconnect) — the change is small
> enough to author + review directly.

## 1. What was built (small, additive)

| File | Change |
|---|---|
| `multitable/personal-view-config.ts` | Added `fieldOrder?: string[]` to `PersonalViewConfigOverlay`, `OVERLAY_KEYS`, `sanitizePersonalOverlayConfig` (string[] whitelist), and `applyPersonalViewOverlay` (additive spread). Nothing else changed — same actor-scoped module (never reads `req`). |
| `routes/univer-meta.ts` | Added `fieldOrder?: string[]` to `UniverMetaViewConfig` so the served view config can carry it. **No wiring change** — `GET /views` already applies `applyPersonalViewOverlay`, so the new facet flows automatically; `redactViewConfigFilterLiterals` spreads `...view`, preserving `fieldOrder`. |
| `tests/integration/multitable-personal-views-slice2-fieldorder-realdb.test.ts` | Slice-2 goldens (below). |
| `.github/workflows/plugin-tests.yml` | Wires the golden into the Node-20 required real-DB step. |

## 2. Why the load-bearing isolation is inherited (not re-proven from scratch)

`fieldOrder` is written/read through the **identical actor-scoped path** as Slice 1: the CRUD keys on
`(view_id, user_id) = (viewId, actorUserId)`, `actorUserId` comes only from the authenticated actor, and the config
jsonb just carries one more key. The actor-keying is **unchanged code** — so Slice 1's **observed-RED (#3639: breaking
the actor keying made the goldens go red)** already proves this exact keying has teeth. Slice 2 does not weaken or
re-route it; its goldens confirm the fieldOrder facet specifically **flows and is isolated** on top of that proven
mechanism.

## 3. Fail-first goldens (real-DB, in the required Node-20 step)

- **field-order actor isolation:** A's `fieldOrder` is served to A, **undefined for B** (B sees the sheet-global
  order). RED if resolution keys on non-actor.
- **byte-identical (flag-off / no override):** flag-off with A's row present ⇒ no `fieldOrder` served; flag-on with no
  override for B ⇒ no `fieldOrder`. RED if the overlay perturbs the shared path.
- **forged-identity:** A writing `fieldOrder` with a forged `body.userId=B` does NOT touch B's row (A's own row gets
  it). RED if a client-supplied id selected the write target.
- **additive:** setting only `fieldOrder` leaves `filterInfo` (and the other facets) falling through to shared.

## 4. Enablement (unchanged)

Same `MULTITABLE_ENABLE_PERSONAL_VIEWS`, **default-OFF**. This slice does not enable it. The flag-on checklist
(`multitable-personal-views-flag-on-checklist-20260705.md`) applies — re-run its §B because slice 2 adds a served key.

## 5. What was and was NOT executed locally (honest provenance)

- **Verified by review:** the change is a small additive facet; the module, the type, the wiring (auto-flow +
  redaction spread preserving `fieldOrder`), and the goldens were authored + read end-to-end.
- **NOT run locally:** no `DATABASE_URL` in the authoring environment ⇒ the real-DB golden did not run here; **the
  PR's `test (20.x)` is the first execution.**
- **observed-RED:** the load-bearing actor-keying is the SAME code Slice 1 already observed-RED'd (#3639), so a fresh
  observed-RED is not strictly required for the isolation invariant; if desired before any flag-on, the same
  throwaway-CI method applies. Human reviewer: confirm the PR's `test (20.x)` runs the new golden GREEN.
