# Cross-base relational completion — Slice 1: editable cross-base mirror (two-way write) — DESIGN-LOCK (RATIFIED) — 2026-06-29 (ratified 2026-06-30)

> Status: **RATIFIED 2026-06-30 (owner-signed; the §7 decisions A–F are settled below — this doc is read-only
> post-ratification).** Grounding: `origin/main` @ `57fd06962` (re-verified directly on current main: the cross-base
> twoWay reject is absent — read-only mirror v1 shipped; the spine invariant `isFieldAlwaysReadOnly(mirrorOf)`
> holds; the `evaluateCrossBaseWrite`/`resolveBaseWritable` authority primitive is present. An earlier code-survey
> agent read a stale feature branch and is NOT relied on).
>
> **Ratified decisions (owner, 2026-06-30):** **A** canonical-edge write-through, no mirror row · **B**
> **both-endpoints** write (base-A canonical-owner write AND base-B acting-side write — strict-first, so a
> cross-base mirror can't become a single-sided permission bypass) · **C** no-oracle uniform fail-closed
> (masked / missing / no-write indistinguishable) · **D** **cross-base-only** (same-base mirror stays read-only;
> parity is a separate later slice) · **E** realtime push deferred (base-B read-recomputes) · **F** TOCTOU
> **launch gate** (forward grant/revoke + link-edit must co-lock or use a conditional/versioned write before the
> flag is enabled). Runtime order: **C1** extract the shared authority primitive (automation executor → thin
> adapter, regression-locked) → **C2** the mirror write-through; default-off `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`;
> NOT same-base / realtime / triggers / cascade.
> Arc: **cross-base relational completion** — selected as the next build arc by the refresh audit
> (`docs/research/multitable-feishu-refresh-audit-20260629.md`, #3372) and pre-teed by the cross-base deepen
> closeout (`multitable-crossbase-deepen-arc-closeout-20260627.md` §2(a), the explicitly-deferred owner fork).
> Predecessor (shipped): read-only cross-base mirror v1 (`multitable-crossbase-readonly-mirror-dev-verification-20260627.md`).
> Owner scope instruction (2026-06-29): "范围先锁 'read-only mirror → cross-base two-way links'，不要一口气吃
> triggers/cascade/governance。"

## 0. Verified ground truth (main) — the facts the design rests on
1. **One canonical edge.** A two-way link is a single `meta_links` row `(field_id=F, record_id, foreign_record_id)`.
   The paired **mirror** field (`property.mirrorOf = F`) is a **read-time reverse projection** of that one edge —
   no second materialized row.
2. **The spine invariant.** `isFieldAlwaysReadOnly` (`permission-derivation.ts:58–68`) returns true for **any**
   `mirrorOf` field, and the code states why: *"so the single canonical meta_links edge can never gain a second
   materialized row (the spine invariant)."* Both write services reject a mirror PATCH today. Consequence: links
   are **two-way *display*, forward-edit-only** — same-base AND cross-base alike.
3. **Read-only cross-base mirror shipped (v1).** Cross-base twoWay pairing is allowed (the old reject is gone);
   the mirror reverse-projection reads, **base-read-masked** (`maskDerivedMirrorFieldIds` + `buildLinkSummaries`
   Sink B-1, both base-gated). The mirror stays read-only by codec.
4. **Cross-base write authority primitive exists & is proven.** `evaluateCrossBaseWrite` (`automation-executor.ts:1818`)
   → `resolveBaseWritable(actor, targetBaseId)` + **claim==truth** + **per-target-base quota**, single Postgres,
   atomic single-txn. Used by automation cross-base writes today.
5. **Cross-base realtime push is already deferred** (read-recompute-on-fetch) with a v1 code comment that pre-tees
   exactly this slice: *"Editable cross-base mirror + cross-base realtime push are a separately-governed follow-up."*

## 1. Scope — what Slice 1 opens, and what it deliberately does NOT
**Opens:** make the **cross-base mirror field editable**, so a write on the mirror side (base B) creates/deletes the
relationship — implemented as **write-through to the single canonical forward edge** (§2), gated by the existing
cross-base write-authority primitive (§3) and the foreign read-mask (§4). This closes the Feishu "edit a linked
record from either side" gap for cross-base links. Default-off behind `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`.

**Deliberately OUT (each a separate, separately-governed follow-up):**
- **Cross-base automation triggers** (base-A rule firing on base-B change) — Slice 2.
- **Cross-base cascade** delete/sync — Slice 3.
- **New per-base governance/quota infrastructure** — Slice 1 *reuses* the existing `evaluateCrossBaseWrite` gate
  (incl. its quota); it builds no new governance surface.
- **Live cross-base realtime push** — stays deferred (read-recompute); see Decision E.
- **Materialized mirror rows** — forbidden (would break the spine invariant); see §2.

## 2. Architecture — write-through to the canonical forward edge (preserves the spine invariant)
A mirror edit on `rec_B.M_B` to add/remove `rec_A` is redirected to **create/delete the one canonical forward edge**
`(F_A, rec_A, rec_B)` — it does **not** write a `(M_B, rec_B, rec_A)` row. The mirror remains a projection; only the
canonical edge is mutated. This is the only design that preserves the spine invariant and therefore reuses **unchanged**
every downstream consumer that assumes one edge (reverse projection, `maskDerivedMirrorFieldIds`, `buildLinkSummaries`,
dangling-link repair-on-read, the cross-base read mask). The write is to base A's relational space (it changes what
`rec_A.F_A` links to), initiated from base B — i.e. a genuine **cross-base write**, which is why §3/§4 gate it.

`isFieldAlwaysReadOnly` keeps returning read-only for the mirror in the **derived-permission** sense (you cannot store
a value *into* the mirror column); the new editable path is a distinct **relationship-edit** operation that the write
service recognizes for a flag-enabled cross-base mirror and routes to the forward-edge writer. (The exact carve-out
point — a dedicated mirror-edit route/op vs. a guarded branch in the existing patch path — is an implementation choice
to settle at runtime; the contract is "mirror edit ⇒ canonical-forward-edge write, never a second row.")

## 3. Authority model (cross-base write) — a SHARED authority primitive (NOT a lift of the automation gate)
Reuse the proven *logic*, no new governance — but **do NOT lift `evaluateCrossBaseWrite` wholesale.** That method
is automation-flavored: it takes an `ExecutionContext`, and its quota / audit / actor semantics are entangled with
the automation executor. Lifting it into the mirror-write path as a "universal truth" would muddle those semantics
across two callers (owner guidance, 2026-06-29). **Locked approach:** extract a **context-agnostic shared authority
primitive** — inputs `(actorId, targetBaseId, declaredBaseClaim)`, returning an explicit allow/deny + reason —
composing `resolveBaseWritable(actor, baseA)` + **claim==truth** (forward field's `foreignBaseId`) + **per-target-base
quota**. Both the automation executor **and** the mirror-write path then consume this one primitive; the automation
executor's current method becomes a **thin adapter** over it (no behavior change — regression-locked by its existing
cross-base-write goldens). This keeps quota/audit/actor semantics from drifting between callers. The mirror write
requires **base-A (forward/canonical-edge owner) write authority** via this primitive.
- **Decision B (ratify): also require base-B write?** Lean = **yes for v1** (require write authority on **both**
  endpoints — base A canonical + base B where the edit originates), the fail-closed default for a first
  mirror-initiated cross-base write; relax to base-A-only later if too strict. (Feishu requires only edit on the
  acting side; we start stricter and loosen with evidence.)

## 4. Read-mask / no-oracle (the sharpest security requirement)
A mirror edit names a **base-A record id** (`rec_A`). Without masking, a base-B editor could submit an arbitrary
`rec_A'` and read existence/permission of base-A records off **differential responses** (success vs not-found vs
denied) — a cross-base write-side **oracle**. Therefore the write-through MUST, for the specific `rec_A` target:
enforce the **same foreign read+write mask** the read path uses (`resolveForeignFieldReadability` /
`shouldMaskForeignField` parity), and return a **uniform fail-closed error** for *not-found OR not-readable OR
not-writable* — no branch that distinguishes them. A base-A-masked record must be **indistinguishable** from a
non-existent one. This is a hard requirement with its own goldens (§6), fail-first proven.

## 5. Consistency / atomicity / TOCTOU
- **Single Postgres, single transaction.** The authority resolution (base ids), the read+write mask check, and the
  forward-edge INSERT/DELETE all run in **one `pool.transaction`** — all-or-nothing.
- **TOCTOU (permission-revert lesson).** Resolve-then-write must not let base/permission drift between check and write.
  The txn locks the gating row(s) — at minimum the forward field's row / `rec_A` — `FOR UPDATE` before the authority
  check, mirroring the same-base forward-write path. **Decision F (ratify):** if full concurrency (a forward
  grant/revoke racing the mirror write) isn't closed in v1, it becomes a **launch gate** (flag stays off until the
  forward grant/revoke routes co-lock or the write is conditional/versioned) — the same discipline as permission-revert.

## 6. Test plan — real-DB goldens, fail-first (CI multitable real-DB job, test 20.x)
New target suite `multitable-crossbase-mirror-write-realdb.test.ts`:
- **W1 happy path:** base-B editor with base-A(+B) write authority adds `rec_A` via `M_B` ⇒ one canonical forward
  edge `(F_A, rec_A, rec_B)` created; **no** `(M_B, …)` row exists (spine invariant golden — assert `meta_links` has
  exactly the one forward row).
- **W2 remove:** mirror edit removing `rec_A` deletes the canonical edge; reverse projection empties.
- **W3 authority (fail-closed):** no base-A write → denied, no edge; (Decision B) no base-B write → denied.
- **W4 claim==truth:** wrong/absent `foreignBaseId` claim → denied.
- **W5 no-oracle (load-bearing):** base-A-masked `rec_A` and a non-existent `rec_A'` produce **byte-identical**
  responses; neither writes. Fail-first: disable the mask → W5 RED (differential response / leak).
- **W6 quota:** N+1th cross-base mirror write per base rejected fail-closed.
- **W7 flag-off:** with `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE` unset, mirror edit is refused (read-only as today)
  — no partial write.
- **W8 same-base regression:** same-base mirror behavior **unchanged** (read-only) — proves the carve-out is
  cross-base-only (Decision D = cross-base-only).
- **W9 spine/downstream regression:** the v1 read suites (`multitable-bidirectional-mirror-links`,
  cross-base relation-agg, dangling-link sweep) stay green — write-through didn't perturb the read/mask/repair paths.
Each security golden fail-first-proven (assertion RED with the guard disabled).

## 7. Decisions — RATIFIED 2026-06-30 (owner-signed)
- **A — Architecture: RATIFIED — canonical-edge write-through, no mirror row.** A mirror edit mutates the one
  canonical forward edge; never a second materialized row (preserves the spine invariant, reuses all downstream
  masking/repair).
- **B — Authority direction: RATIFIED — both-endpoints write.** v1 requires **base-A canonical-owner write AND
  base-B acting-side write** (via the §3 shared primitive). Strict-first by owner decision: a cross-base mirror must
  not become a single-sided permission bypass. (Looser base-A-only is a future, evidence-gated relaxation — NOT v1.)
- **C — No-oracle: RATIFIED — uniform fail-closed.** masked / missing / no-write `rec_A` are **indistinguishable**
  (one `403 OUT_OF_SCOPE`-class response, identical body); enforced with §4 goldens, fail-first.
- **D — Scope: RATIFIED — cross-base-only.** Same-base mirror stays read-only; same-base editable-mirror parity is a
  **separate later slice**, not this one ("不要一口气吃").
- **E — Realtime push: RATIFIED — deferred.** The base-A forward write fans out normally; the base-B mirror
  read-recomputes on next fetch. Live cross-base push is a later slice.
- **F — Concurrency: RATIFIED — TOCTOU launch gate.** The flag is NOT enabled until the forward grant/revoke routes
  **and** the forward link-edit co-lock with the mirror write (same sheet lock) **or** use a conditional/versioned
  write. Launch/hardening gate, not a ladder item.

## 8. Flag + enablement
Default-off `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`. Enablement (post-merge, separate opt-in) requires: a flag-on
real-DB smoke of W1/W2/W5, and the Decision-F concurrency gate closed (forward grant/revoke + forward link-edit
co-lock with the mirror write, or conditional/versioned write).

## 9. Pre-runtime gates (before any code)
1. **Owner ratification** of §7 decisions A–F — ✅ **DONE (RATIFIED 2026-06-30).**
2. **Adversarial advisor pass** on the locked design (the advisor was overloaded at lock-drafting time; run before runtime) —
   specifically the no-oracle (§4), the **both-endpoints** authority (§3/Decision B), and TOCTOU/locking (§5) surfaces.
3. Only then: runtime, **contract-first**, in two slices —
   - **C1** — extract the §3 context-agnostic shared authority primitive and refactor the automation executor to consume
     it as a thin adapter (regression-locked by its existing cross-base-write goldens, **zero behavior change**). No
     mirror-write yet.
   - **C2** — the mirror write-through op built on C1's primitive (both-endpoints authority, no-oracle, write-through to
     the canonical edge), default-off `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE`. **NOT** same-base parity / realtime
     push / triggers / cascade — each a separate later slice.
   Then the write-through op, goldens fail-first, default-off.
