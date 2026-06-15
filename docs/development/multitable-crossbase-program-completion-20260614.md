# Multitable Cross-Base Program — Phase A/B/C development & verification

Status: **COMPLETE.** This is the closeout record for the Phase A/B/C development program that
extended multitable from the (already-merged) cross-base governance foundation into a set of
user-reachable capabilities and the operational/real-time depth around them. It records what
shipped, how each slice was verified, the composed cross-phase verification, and the deferred
ledger. Own-principles framing throughout; external-product benchmarking lives in research notes,
not here.

## 1. Program shape

Three phases, executed in parallel lanes through one pipeline per slice — **design-lock →
fail-first tests → independent adversarial review → fix → flake-guarded squash-merge**:

- **Phase A — re-anchor + safety.** Add the first operational guardrail now that cross-base
  writes are live, reconcile the remaining ladder, and close the two closeout follow-ups.
- **Phase B — capabilities.** The user-reachable feature ladder (the benchmark payoff).
- **Phase C — depth.** Finer authority, destructive cross-base operations, and the real-time
  layer.

Standing discipline: fail-closed defaults and independent adversarial review were hard lines;
product/security decisions surface here; staging/live-infra stayed owner-gated; the K3 post-GATE
governance was untouched.

## 2. What shipped (by phase)

### Phase A — safety
| Slice | PR | What |
|---|---|---|
| A1 cross-base write quota | `#2587` | Per-target-base write quota (default 60 writes / 60 s, env `CROSS_BASE_WRITE_QUOTA_*`) — the named abuse vector (base-A thrashes base-B) is now rate-limited as the last gate of the write path. |
| A3 closeout follow-ups | `#2588` | Read-resolver existence/short-circuit symmetry with the write side; a whole-`src` structural guard enumerating cross-base WRITE sites; quarantined mock-NIT debt recorded. |

(A2 was the benchmark-refresh re-rank that set Phase B's final scope — a planning step, not a
code PR.)

### Phase B — capabilities
| Slice | PR(s) | What |
|---|---|---|
| B1 cross-base link picker | `#2602` design, `#2611` impl | Authoring a cross-base link from the field config: an opt-in "link to another base" toggle → gated base `<select>` + foreign-sheet `<select>`, sourced **only** from the backend's already-gated `listBases()`/`loadContext()`. Emits `foreignBaseId` only when both ids are present (mirrors the codec); edit-mode locks the toggle so an existing same-base link can't be converted (a values-loss path). |
| B2 conditional field-visibility | `#2605` | A cross-cutting `visibilityRule` property (any field may carry it), sanitized uniformly via a `withFieldVisibilityRule` wrapper around the per-type normalizer; the FE form evaluator hides/shows fields on a sibling field's value. Visibility is a UX affordance, never a substitute for field permissions. |
| B3 bidirectional/mirror links | `#2589` design, `#2595` impl | A `twoWay` link surfaces the reverse of the same `meta_links` edge on the foreign sheet as a **derived read-projection** (`mirrorOf`, read-only) — no materialized mirror row, no write-back; same-base in the MVP. |
| B4 rich-text longText | `#2598` backend, `#2614` FE | XSS-safe-by-construction rich text behind a `rich` flag: a server-side `sanitize-html` write chokepoint (authoritative — every write sink inert by construction) **and** a single client `v-html` owner that re-sanitizes with DOMPurify on every bind (mXSS defense-in-depth), with a strip-to-text projection feeding grid display, export, and search. |
| B5 QR-code field | `#2593` | A render-only QR field (vendored MIT encoder, no new dependency). |
| B6 export column selection | `#2591` | Column/row selection on export, intersected **after** the §2a.3 field-mask so a selection can never widen what an actor may export. |

### Phase C — depth
| Slice | PR | What |
|---|---|---|
| C3 finer `multitable:base:write` | `#2613` | A distinct write-not-admin permission tier. `BASE_WRITE_PERMISSION_CODES` became a distinct **monotone superset** of `BASE_ADMIN_PERMISSION_CODES` (`{base:write} ∪ admin`): a new lower-privilege write door opens; admin still implies write; no existing holder gains or loses authority. |
| C2 cross-base delete + lock | `#2615` | A `delete_record` automation action with `targetBaseId` (mirroring update/create) and a cross-base extension of `lock_record`, both routed through the same `evaluateCrossBaseWrite` gate + lock check + shared quota bucket as cross-base writes. |
| C1 real-time fan-out | `#2618` | Automation record writes now publish a real-time invalidation to the **effective** sheet's room (target for cross-base, trigger for same-base) — closing the gap where automation writes (incl. cross-base) were invisible to subscribers. |

## 3. Security model — the load-bearing invariants

The program extended, and stayed consistent with, the cross-base governance foundation
(closeout: `multitable-crossbase-arc-closeout-verification-20260614.md`). The invariants that
carried each slice:

- **One write gate, reused.** `evaluateCrossBaseWrite` (trigger-actor authority; claim==truth on
  the declared `targetBaseId` vs the target sheet's actual base; `resolveBaseWritable`; per-base
  quota; null-actor fails closed) is the single chokepoint. C2's delete and cross-base lock and
  C1's fan-out all reuse it rather than introduce a parallel rule.
- **Gating by construction, two structural guards.** A whole-`src` cross-base **write** guard and
  a rank-8 **lock** guard each enumerate every `meta_records` mutation in the automation executor
  and fail RED if any new sink is unclassified. C2's new delete sink and relabeled lock sites are
  enrolled in both (this is where C2's review caught a real regression — see §4).
- **Monotone, additive authority.** C3's permission split opens a strictly-lower door and changes
  no existing holder's reach; a future admin-only gate consulting the (now un-aliased) admin set
  correctly rejects a write-only holder.
- **Masks compose, never widen.** B6 export intersects after the field-mask; B2 visibility is a UX
  affordance over (not a replacement for) field permissions; B4's two sanitizer chokepoints make a
  stored rich value inert and re-inert it on render.
- **Relative invariance for the real-time layer.** C1 routes a cross-base write's invalidation to
  the same gated `sheet:${id}` room a REST write to that sheet already reaches — origin base does
  not change the room's membership, so C1 adds no audience and changes no gate. The one genuinely
  new datum (the trigger `actorId`) is omitted for cross-base. (A direct record read is
  sheet-capability-gated, not base-read; base-read governs cross-base *link* projection — so no
  authChecker change was needed or made.)

## 4. Verification

Every backend/security slice followed design-lock → fail-first → **independent adversarial
review** → fix → flake-guarded merge. The review step earned its place on every slice — each
found a real issue that was fixed before merge:

- **B4 backend merge** — an initial conflict resolution blind-took the "superset" of a
  `field-codecs` dispatch list, which **resurrected `longText` into the plain-text passthrough and
  made the new sanitizer branch dead code**. Corrected to merge *intent* (the branch had
  deliberately removed it); the sanitizer tests went green. Lesson: a code-conflict resolution is
  "merge intent," not "take the bigger list."
- **C3** — review confirmed the permission split cannot escalate (every permission check expands
  the *held* side, never the required side) and the quota still binds the new tier; two
  documentation NITs (fail-first scope; non-namespaced admission) were corrected.
- **B4 FE** — 30 adversarial XSS payloads through the real sanitizer, all inert; review surfaced a
  `@drop` self-XSS gap in the editor (dragged HTML fired before sanitize) → fixed by mirroring the
  paste handler as plain-text, plus 12 extra canaries folded into the locked regression net.
- **C2** — the review caught a **real blocker**: the cross-base lock refactor pushed the
  `// lock-mgmt:` marker outside the rank-8 lock-guard's 3-line window, leaving two sites
  unclassified → that guard (a CI test the impl run had not exercised) would have gone red.
  Fixed by reordering the markers; both structural guards green. All seven adversarial axes
  (fail-open, lock back-compat, delete/meta_links cleanup, quota, guards, test integrity,
  migration reversibility) cleared.
- **C1** — review cleared all five axes (no leak / relative invariance independently confirmed;
  actorId omission; no fan-out on a denied write; no echo loop; best-effort safety).

### Composed verification

The full suite was run on the final composed state (post-C1), against a real database:

- **Backend: 4542 passed.** Every failure (41) is in the unrelated `approval-*` module — **zero**
  cross-base/multitable backend failures. The cross-base write/delete-lock/quota suites, both
  structural guards, the C3 resolver suite, and the C1 fan-out suite are all green.
- **Frontend: 3485 passed.** The only multitable failures are in features this program did not
  touch — date-field display, the timeline-view config flow, and opening the workflow designer —
  each green in CI on `main` and failing only under the local Node-25/jsdom toolchain (a known
  environment hazard); plus one unrelated attendance spec.
- **Type-check clean** (`tsc --noEmit`) on the final state.

Conclusion: the program surface is **regression-clean**; the residual local failures are
pre-existing and confined to untouched modules.

## 5. Process notes & durable lessons

- Independent adversarial review is not ceremony — it found a real defect on every backend slice,
  including two (the B4 dead-sanitizer merge and the C2 lock-guard regression) that would have
  shipped a security/CI regression.
- Verify **both** structural guards when touching the automation executor's lock/write sites; an
  impl can satisfy one and silently break the other (a marker outside its window).
- A textual auto-merge can be syntactically clean yet semantically wrong; resolve a conflict by
  the branch's *intent* (`git diff` the branch), and confirm with a local full-suite run before
  pushing — CI is confirmation, not the first signal.
- `update-branch` advances the *remote* branch; hold no un-pushed local commits during a
  merge race or the next push is a non-fast-forward.

## 6. Deferred (each a separate, gated opt-in — none auto-started)

Same-base→cross-base link re-targeting (FE); bidirectional **write-back** / cross-base mirror
links; per-field real-time masking on the fan-out (the re-fetch path already applies the mask);
live CRDT cross-base co-editing; a base-admin-only operation gate (C3 makes one *expressible*; it
adds none); rich-text mentions/images/tables; cross-base move/copy. The two quarantined
person-field mock-assertion tests remain CI-excluded debt.

---

*Verification artifacts (independent reviews) for the security-sensitive slices were saved per
slice during development (e.g. `/tmp/pr2613-review-claude-20260614.md`,
`/tmp/pr2615-review-claude-20260614.md`, `/tmp/pr2618-review-claude-20260614.md`).*
