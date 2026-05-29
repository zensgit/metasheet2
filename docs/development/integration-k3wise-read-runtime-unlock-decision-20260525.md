# K3 WISE read-only runtime UNLOCK — Decision & Design (S3) - 2026-05-25

## Scope & first-order question

This is a **decision document first, a design second.** The first-order question is **whether to UNLOCK a read-only K3 runtime slice now** — *not* how to write the interface.

- **Docs-only. No runtime implemented.** Any runtime is a **separate opt-in PR on the #1709 track**, only after an explicit unlock (see §5).
- Builds on the existing **#1593** read/list GATE-front contract — it **carves a minimal slice and does NOT redesign** read/list (memory discipline: post-GATE, *execute* the #1593 design, don't redesign).
- 2026-05-28 update: #1792 is now closed as PASS for M1 one-record Material Save-only. The old Stage-1 blanket lock no longer blocks this discussion, but #1709 still needs explicit owner opt-in plus the read/list O1-O6 inputs before runtime.

## 1. The decision (first-order — owner's call)

**Question:** unlock a **read-only, single-object, Material reference-resolution** runtime slice (a subset of #1593) **now**, given the #1792 `PASS_SAVE_AND_READBACK` evidence?

**Why it matters:** making *"staging auto-produces complete K3 reference objects"* stable structurally needs a **read** — the GATE positive Save sourced its 66 reference objects by reading an existing Material detail (clone). A4 (#1832) persists per-field *shape*, S2 (#1828) *previews* completeness, but **neither sources the objects**. Read is the missing producer.

**Lock status:** read/list runtime remains the scoped **#1709** ("[Post-GATE] K3 WebAPI read/list adapter for Material/BOM", OPEN) track; **#1593** front-loaded the contract (docs). The K3 macro gate is satisfied by #1792, but implementation still requires an explicit owner unlock and current read/list inputs. #1526 is the now-closed umbrella; the read-adapter runtime moved to #1709.

**Options (owner picks — this doc does not decide):**
- **(a)** Unlock the minimal read slice now, citing the save+readback PASS as sufficient evidence.
- **(b)** Keep frozen until the staging-mapping path **and** rollback are fully approved (the owner's earlier stop-boundary on #1792).
- **(c)** Unlock only behind a flag / single object / read-only smoke first, then widen.

This document frames the decision and scopes the slice so the decision is concrete; it does **not** make it.

## 2. Minimal slice (carved from #1593, not redesigned)

- **Input (two distinct things — do not conflate):** **(i)** a `templateMaterialNumber` — the **`read` single-key** (#1593 `filter.number`) naming *which existing Material's detail to read*; and **(ii)** the **reference field(s)** to harvest from that detail (e.g. `FBaseUnitID`, `FAcctID`). The input is **not** "an arbitrary unit/account code".
- **Output:** the K3-Saveable reference object(s) (`{FNumber, FName}` / `{FID, FName}`) **already present in that Material's detail**, projected via the existing `objectConfig.schema` — the *proven* GATE clone-source pattern.
- **HARD BOUNDARY — Material-detail *harvesting*, NOT a generic master-code *resolver*:** this slice reads one Material detail and lifts the reference objects it already contains. It **cannot** take an arbitrary unit/account/unit-group code and resolve it into a reference object. Generic "unit code / account code → reference object" resolution requires either a **master-object read** (FUnit / FAccount / … — different endpoints) **or an extra mapping registry**, and is **out of this slice** (extension + open question).
- **Reuses #1593 verbatim (no redesign):** the `read(input) -> { object, records, page }` surface; the `objects.material` read metadata (`readPath`/`readMethod`/`responseListKey`/`responseRowKeyMap`); the `K3_WISE_READ_*` error taxonomy; `operations` defaulting to `['upsert']` (read is opt-in).
- **Purpose:** feed S2 (#1828) completeness preview and A4 (#1832) shape config with *real* K3 reference objects, and give the future **S4** single-record Save regression a known-good object source.
- **Deferred (stay #1593 open questions / out of this slice):** list + pagination (O2), broad filtering (O3), field expansion (O4), reading arbitrary unit/account **master** objects directly by code, and BOM read. If reference resolution later needs master-object reads beyond Material-detail harvesting, that is an **extension + open question**, not this slice.

## 3. Read-only boundary (explicit)

- **No K3 write** (no Save). **No BOM.** **No Submit/Audit.** **No multi-record expansion** — single-key read only in the minimal slice.
- Distinct `K3_WISE_READ_*` codes (per #1593 §Error taxonomy) so a read failure is **never** misreported as a Save/Submit/Audit failure.
- Existing saved systems keep `operations: ['upsert']`; read is opt-in per object (#1593) — no silent read surface.

## 4. Composition location (explicit)

- **Client pre-Save preview / operator-assisted composition = lock-safe** — the read result (reference objects) is composed/used client-side or operator-side, feeding the S2 preview and/or a known-good object for the S4 regression.
- **Server / pipeline transform = still FROZEN** — auto-composing reference objects on the server during a headless pipeline run is **not** unlocked by this; it stays frozen unless the owner separately unlocks it.
- So even with read unlocked, this minimal slice serves **preview / operator composition**, not server-side pipeline auto-composition.

## 5. This document does NOT implement

- **No runtime code here.** The read runtime is a **separate opt-in PR on the #1709 track**, gated on **both**: (a) an explicit owner unlock (§1), AND (b) the #1593 customer open questions **O1–O6** answered (read endpoint/method, pagination, filters, readable fields, redacted sample JSON, read-time auth scope — captured in `integration-k3wise-webapi-read-list-customer-sample-manifest.md`).
- Once unlocked + O1–O6 answered, the impl is the **mechanical 5-step post-GATE plan already in #1593** (replace the `unsupportedAdapterOperation` stub, extend `normalizeObjects`, add mock fixture + acceptance test) — again, *don't redesign*.
- Sequence: **this decision/design → owner unlock + customer O1–O6 → #1709 runtime impl PR (separate opt-in) → wire into S2/A4 → S4 regression.**

## Boundary / non-goals

- Docs-only; no runtime / migration / adapter change; nothing implemented.
- Does **not** make the unlock decision (owner's call); it frames it.
- Does **not** redesign #1593; carves a minimal slice and defers its open questions.
- BOM / Submit / Audit / multi-record / server-pipeline composition remain frozen.

## Issue / contract references

- **#1593** — K3 WISE WebAPI Material/BOM read/list GATE-front contract (design + verification + customer sample manifest). The source contract this slice carves from.
- **#1709** — "[Post-GATE] K3 WebAPI read/list adapter for Material/BOM" (OPEN, verified 2026-05-25). The runtime track any implementation belongs to.
- **#1526** — closed umbrella (K3 bridge verification follow-ups); the read-adapter runtime moved to #1709.
- **#1792** — Customer GATE; `PASS_SAVE_AND_READBACK` is the evidence weighed in the §1 decision. Consumers: **#1828** (S2 preview), **#1832** (A4 shape config).
