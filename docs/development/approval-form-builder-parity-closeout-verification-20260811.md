# Approval Form Builder Parity — F4 Closeout Verification

Companion to `approval-form-builder-parity-execution-ledger-20260811.md`. Records the gate
checklist from delta §7.1/§7.3/§9 against F4's exact head, and what remains outside this slice's
authority.

**PR:** https://github.com/zensgit/metasheet2/pull/4994 (NOT MERGED)
**Head SHA:** `6412181abec247ee450179ee69abcf317935967a`

## §7.1 Required local and CI gates

| # | Gate | Status |
|---|---|---|
| 1 | Pure command/identity/drag-codec/history tests | Unchanged by F4 (F1/F2 delivered these); reran green as part of §2 below. |
| 2 | Mounted palette, builder, inspector tests with real Vue rendering | `approvalTemplateAuthoring.spec.ts`'s new `F4 production mount` describe (real `createApp` mount, JSDOM). |
| 3 | Existing approval form/canvas/version/FWB/attachment focused suites | Reran `approvalTemplateAuthoring` (122 tests), `approval-form-builder-slots` (45), `approval-form-field-inspector`, `approval-form-authoring-adapter`, `approval-form-inline-editor-extract`, `approval-form-palette-chips` — all green (234 tests total across the 7 touched/new files). |
| 4 | `run-required-web-tests.sh` + `approval-web-guard` path/run-list collection proof | Done in this same PR (§ below). |
| 5 | `vue-tsc --noEmit` | Clean, verified on the exact rebased head. |
| 6 | `pnpm --filter @metasheet/web build` | Succeeds, verified on the exact rebased head (pre-existing chunk-size warnings only, unrelated to this diff). |
| 7 | CI-equivalent Chromium workflow, owned server | `playwright.approval-verification.config.ts`'s webServer (port 5175, `reuseExistingServer: !CI`) — 20/20 passed locally. |
| 8 | `git diff --check` + exact-head required GitHub checks | `git diff --check` clean (no whitespace conflicts). Required checks run on the pushed PR head; the approval browser workflow is NOT yet in branch protection (owner step per §7.1 item 8) — its evidence here is exact-head, not "required". |

## §7.3 Discriminating mutations — F4-owned items

F4 does not touch the F1-F3 command/identity/reference guards (items 1-16 in the master list remain
their owners' responsibility, reverified green not re-proved here). F4 introduces three NEW
guarded behaviors, each manually mutation-tested and reverted (see the execution ledger §3/§4 for
exact mutations and error text):

- Hydration single-seed (re-entry does not reseed) — RED under a `:key` coupled to the active
  section tab.
- Route-level drag-state clearing — RED with the clearing statement removed.
- Flag-gate mount — RED with `canvasV2Enabled` neutralized out of the mount computed.

All three positive-controlled (the corresponding "it works when everything is present" test passes
on the unmutated head — see the same describe blocks).

## §9 Definition of engineering complete — status against this item's scope

1. F0-F4 merged to `main` in dependency order — F0-F3 merged; **F4 is this PR, NOT merged.**
2. Production Form mode uses the extracted builder under `approvalCanvasV2`, feature OFF retains
   the dedicated fallback — **delivered in this PR** (flag OFF unchanged, flag ON mounts Designer
   2.0 once hydrated).
3. Palette click/keyboard/drag and existing-field keyboard/drag converge on the typed command
   adapter — unchanged from F1-F3 (this slice adds no new command path; the palette's `append-field`
   emit and undo/redo route through the SAME `ApprovalFormBuilder`-exposed methods every other path
   already uses).
4. No production Designer 2.0 add/move/remove/retype path uses length, captured index, direct
   mutation, or silent cleanup — unchanged from F1-F3; verified the mount does not introduce a new
   write path (`onFormBuilderDraftChange` only ever assigns the session's OWN emitted draft, never
   splices `draft.value.fields` directly).
5. Inspector commits history-aware; reference/type changes fail closed — unchanged from F3.
6. B1-B12 and the mutation obligations pass on the exact assembled head — **delivered in this PR**,
   see the execution ledger §5 for the full matrix and §3/§4 for F4's own three mutation proofs.
7. Required Web Tests, typecheck, build, approval guard, independent review pass — Required Web
   Tests / typecheck / build verified locally on this exact head (§7.1 above); the approval guard
   CI job runs on the pushed PR (path filters extended in this PR); **independent adversarial
   review has not yet run against this PR** — recommended before merge, per the delta's own
   verification-split doctrine (§0: "Codex independently reviews exact heads... and owns the final
   verification record").
8. Execution ledger and closeout verification document exact PRs/SHAs/tests/residuals/owner gates —
   **this pair of documents**, added in a follow-up commit to PR #4994.

**This is still not product FINAL** (delta §9, final paragraph): owner ratification of this PR,
merged-main rerun, tenant UAT, canary observation, and the flag-enablement decision all remain
required and are explicitly NOT authorized by this slice or by the delta's ratification record
(§10: "Authorizes F0-F4 development and tests only. Flags remain OFF; merge/UAT/enablement stay
owner-gated.").

## Residuals carried forward

- The §6 inspector-gap residual from the execution ledger (number display props / `date_range`
  granularity have no Designer 2.0 authoring affordance) — pre-existing F3 scope boundary, now
  reachable behind the flag; recommend the owner gate `canvasV2` enablement on this being closed
  for tenants that use those field configurations, or accept it as a known launch limitation.
- Branch-protection addition for `approval-browser-verify.yml` (delta §7.1 item 8, owner action).
- A cosmetic-only artifact observed in the standalone harness screenshot (a floating "上一步" wizard
  button overlapping the palette at the default viewport) — traced to the harness page lacking the
  full `App.vue` shell's base layout CSS, not present in the real application; does not affect any
  B1-B12 assertion and is not a production-surface defect.
