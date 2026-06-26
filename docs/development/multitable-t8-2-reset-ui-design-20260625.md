# T8-2 Reset UI — design (impl GATED on clean staging acceptance evidence)

> **Status: DESIGN ONLY — NOT built.** Per the rollout order, the Reset UI impl is gated on a *clean staging
> acceptance run* (#3232 harness, owner-run): "只有 acceptance 证据干净后再做." This doc captures the UI spec the owner
> already set ("UI 文案必须非常硬") so the impl is a concrete build when the evidence is in — it does **not** start the impl.

## Why Reset needs its own surface (not Revert's)

Reset and Revert both restore a sheet to its state at T, but Reset is **destructive**: records *created after T* are
**moved to the recycle bin** (`meta_records_trash`, recoverable). Revert keeps them. A user who confuses the two could
trash live data. So the UI must distinguish them **unambiguously** — not a toggle on the same control, a separate
action with its own destructive framing.

## The hard copy (the load-bearing requirement)

- **Action label:** "Reset sheet to <T>" — never just "Restore"/"Revert".
- **One-line description (always visible before confirm):** "Reset reverts every record to its state at <T> **and moves
  the N records created after <T> to the recycle bin**. Recoverable from Trash — but this is **not** a normal restore."
- **Contrast line (next to it):** "Need to keep records created after <T>? Use **Revert** instead — it changes
  nothing destructively."
- Never call Reset "undo" or "restore"; always name the destructive effect (recycle bin) and the count.

## Flow (preview → typed confirm → execute)

1. **Entry** — a distinct "Reset to T" action, shown only when the actor has the sheet-admin cap AND the feature is
   enabled (the FE hides/disables it otherwise — mirrors the backend's `canManageSheetAccess` + `MULTITABLE_ENABLE_PIT_RESET`;
   a hidden action when the flag is off is the FE's half of "inert until enabled").
2. **Preview** — call `reset-preview`; render `summary.deleteCount` (post-T → trash), `summary.visibleRevertCount`
   (survivors reverted), and the destructive warning. If `deleteCount === 0` show "nothing to delete" and treat it as a
   plain Revert-equivalent (no destructive confirm needed). Drift/`409` on a stale preview → re-preview.
3. **Typed two-step confirm** — the user must type the literal **`reset`** (mapping to the backend `confirm:'reset'`),
   AND the dialog echoes the **deleted-count** ("N records will be moved to the recycle bin") with an explicit
   acknowledgement. No single-click path. The confirm button stays disabled until both are satisfied.
4. **Execute** — call `reset-execute` with `{ asOf, previewIdentity, confirm:'reset' }`.
5. **Result** — "N records moved to the recycle bin · M records reverted to <T>", with a **link to Trash** to undo.
   Map the gated codes to clear copy, never "failed": `403`→not permitted / feature off; `409 RESET_BLOCKED`→"a target
   is locked or denied — nothing was changed"; `409` drift→"the sheet changed since preview — re-preview"; `413`→"too
   many records for a one-shot reset"; `400`→"type reset to confirm".

## Component design (where it lives)

Alongside the existing Revert surface in `MultitableWorkbench.vue` (the Revert panel is the structural model). A new
`ResetConfirmDialog.vue` (destructive variant of the revert-confirm panel) + `MultitableApiClient.resetPreview` /
`resetExecute` (mirroring the `revertPreview`/`revertExecute` client methods, carrying `confirm:'reset'` +
`previewIdentity`). The Reset action is visually separated from Revert (distinct destructive styling), not a mode flag.

## Verification plan (for the impl, when un-gated)

jsdom specs: (1) the action is hidden when the cap/flag is absent; (2) the typed-`reset` + deleted-count-echo gate —
confirm disabled until both met; (3) the destructive copy is present and names the recycle bin + the count; (4) an
**end-to-end mount→preview→confirm→execute wire test** against a real `MultitableApiClient` (mocked fetch) asserting
`reset-preview` then `reset-execute` fire with `confirm:'reset'` + the server `previewIdentity` (the same wire-lock the
config-restore FE uses); (5) `deleteCount===0` skips the destructive confirm. vue-tsc 0; in the web-guard.

## Gating (explicit)

Build this **only after** the #3232 staging acceptance run is clean (all of (a)–(g) green, zero-writes on deny/drift).
Rationale (owner's): prove "flag-on behavior + error codes are correct" first, so the UI isn't built on an unverified
foundation or confounded with staging/env/JWT/migration issues. This doc is the ready-to-build spec; it is not a
licence to start the impl.
