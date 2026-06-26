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

1. **Entry** — a distinct "Reset to T" action. The sheet-admin cap (`canManageSheetAccess`, already in FE capabilities)
   always gates it. Whether it is *hidden when the flag is off* depends on the **Flag visibility contract** (below) —
   the FE has no reset-flag signal today, so that behavior must be resolved at impl, not assumed here.
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

## Flag visibility contract (resolve at impl — there is NO FE reset-flag signal today)

The FE capabilities/context expose record/sheet permissions (e.g. `canManageSheetAccess`) but **no**
`MULTITABLE_ENABLE_PIT_RESET` signal — so "hide the entry when the flag is off" has no real source yet. Pick one at impl:

- **v1 recommended — add a backend signal.** Expose a flag-derived boolean in the sheet capabilities/context (e.g.
  `pitResetEnabled` / `canUsePitReset`, true only when `MULTITABLE_ENABLE_PIT_RESET` is on AND the actor has the cap).
  Then the FE genuinely hides/greys the Reset entry when off — the FE half of "inert until enabled", with no
  dead/confusing control and no leak of the feature's existence to admins on a flag-off tenant. A small additive
  backend slice, built as part of the #2 impl (when un-gated) — not a separate gate.
- **v1 fallback — don't hide; handle `RESET_DISABLED`.** Show the entry by `canManageSheetAccess` only; on click the
  preview returns `403 RESET_DISABLED` and the FE renders a clear "Reset is not enabled here" state. Simpler (no backend
  change) but the entry is visible-but-inert when off — explicitly **NOT** "flag-off hidden". Acceptable for v1 only if
  that dead-entry tradeoff is accepted.

This resolves the [P2] that the original draft assumed a FE flag signal that doesn't exist. The Verification-plan spec
(1) ("hidden when the cap/flag is absent") presumes the **recommended** path; under the fallback it narrows to "shows a
`RESET_DISABLED` state when the flag is off."

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
