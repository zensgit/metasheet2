# Development orchestration & sequencing plan — fixed-cadence · tiered-model · parallel-lane (2026-07-05)

> **Operationalizes the goal:** existing dev plans/TODOs as the master pool → fixed-cadence development, planned +
> sequenced, parallelizable, each completed item ships **design + verification MDs**, model **auto-selected by
> difficulty** (fable5 / Sonnet5 / higher). Grounded on `origin/main` @ `05a8593aa`.
>
> **The pool is the CURRENT line, not the stale sprint backlog.** Verified excluded: `TODO_SPRINT8.md` (Dec-2025,
> 0/23 done — shelved), `multitable-gated-remainder-*` (closed ledgers: "active remainder is EMPTY" / "No owner
> decision is pending"). Included: the **approval-automation third-batch line**, whose owner votes are now partly cast.

## 0. Current vote state (main @ `05a8593aa`)

From `approval-automation-third-batch-ballot-20260702.md` — tally **13 ✅ · 10 ⏸ · 21 ⬜**:
- **A3** egress destination authorization — ✅ RATIFIED (#3589), but **governance-only, no code**; deny-all until a named staging host is supplied (deliberately withheld).
- **T3-3** node signature/compliance — first rung declared-inert **ALREADY SHIPPED** (#3512, 2026-07-03) + votes ratified (#3590); design/verification MDs added (#3601). **DONE — not a build target.** *(NOTE: #3512 shipped two days BEFORE the formal ballot vote landed — a build-before-vote inversion; the code matches the ratified Q1–Q9 decisions, so it's retroactively consistent, but the vote did not gate the build.)*
- **T3-6** S-band approval-as-records — ⏸ HELD (#3590); no work until un-held.
- **T3-2** business-calendar SLA (Q1–Q10) & **T3-1** mobile surface (Q1–Q11) — ⬜ **awaiting owner vote**.

## 1. Pool by readiness (the sequencing input)

| Item | Lane | Readiness | Blocker |
|---|---|---|---|
| ~~T3-3 declared-inert rung~~ | B (approval engine, HOT) | **DONE** (runtime #3512 · docs #3601) | — |
| T3-2 business-calendar SLA | D | VOTE-GATED | owner vote (⬜) |
| T3-1 mobile surface | D | VOTE-GATED | owner vote (⬜) |
| A3 egress destination auth | A | INPUT-GATED | a named staging ASCII-DNS host (withheld) |
| T3-6 S-band records | D | HELD | owner un-hold |

**Actionable-now BUILD items = ZERO.** T3-3 — the only apparent build-ready item — was already shipped (#3512); the L2 build agent caught this on grounding and produced the missing docs (#3601) instead of duplicating. **Every remaining pool item is owner-gated (vote / host / un-hold) — the bottleneck is OWNER DECISIONS, not build capacity.**

## 2. Parallel lanes + collision rules (from the ratified plan §3)

- **Lane B — approval engine** (`ApprovalProductService.ts`, HOT ⇒ **sequential**): T3-3 rung goes here, one at a time.
- **Lane D — product surfaces** (separate files): T3-1, T3-2 are **parallelizable with Lane B and with each other** once voted (distinct surfaces).
- **Lane A — BPMN/egress**: idle until a host is named.
- **Cross-lane collision:** Lane B ↔ Lane C W7 both touch approval-completion — keep W7 in Lane C (both mostly shipped).
- **Max parallelism NOW = 0 build items** (T3-3 already shipped; everything else owner-gated). Widens to **2** (T3-1 ∥ T3-2, distinct Lane-D surfaces) once they are voted.

## 3. Difficulty → model tiering (the auto-select rule)

| Tier | Signature | Model | Oversight |
|---|---|---|---|
| **L1** | docs, propose-lane prep, config, mechanical | **fable5** | unattended — existing 6h routine, Gates 1/2/3 + no-op report |
| **L2** | runtime with a **ratified** spec, default-off, moderate surface, **no security boundary** | **Sonnet5** | gated-unattended (never-merge, banner, fail-first golden) OR in-session |
| **L3** | security boundary / cross-domain / migration / concurrency / HOT-heavy | **Opus (or highest)** | **in-session + adversarial review + HUMAN; NEVER unattended** |

**Per-item tier:**
- **T3-3 declared-inert rung → L2 / Sonnet5** — ratified spec, declared-inert (no enforcement), default-absent byte-identical. *(The later T3-3 **enforcement** rung is L3 / Opus.)*
- **T3-1 build (post-vote) → L2 / Sonnet5** — product/UX, default-off (Q11).
- **T3-2 build (post-vote) → L3 / Opus** — cross-domain attendance-calendar coupling + migration (Q7).
- **A3 egress-enable (post-host) → L3 / Opus + human** — SSRF/egress governance.
- **T3-2 / T3-1 vote-prep → n/a** — material already in the ballot (PROPOSED); it needs an owner **vote**, not more prep → the L1 routine correctly Gate-3 no-ops here.

## 4. Per-item deliverables (design + verification MD)

Each built item ships, matching repo convention:
- **BEFORE** — a design-lock MD (for ballot items, the ballot rung + its build-contract **is** the ratified design lock; a build slice references it).
- **AFTER** — a verification MD: what was built, the fail-first goldens **+ observed-RED**, the flag state, the enablement precondition.
- Naming: `docs/development/<area>-<slice>-{design,verification}-<yyyymmdd>.md`.

## 5. Fixed-cadence execution

- **L1 cadence (live):** the fable5 6h routine (propose-lane owner-decision prep + doc). Currently **mostly drained on approval** (A3/T3-3/T3-6 voted; T3-2/T3-1 await owner votes → Gate-3 no-op). It surfaces other genuinely-open lanes or no-ops **with a report** (never a silent black box).
- **L2 cadence (proposed — needs owner go):** a Sonnet5 build-routine that builds **one** build-ready L2 item per run behind **default-off + fail-first golden + banner + never-merge**. **No L2 target exists right now** — T3-3 (the apparent first target) is already shipped; first real target is **T3-1 post-vote**.
- **L3 (not unattended):** flagged for **in-session Opus + human** adversarial review. First candidates: **T3-2** (post-vote), **A3** (post-host).

## 6. What unblocks more parallelism (owner actions)

1. **Vote T3-2 & T3-1** (⬜) → moves them from VOTE-GATED to BUILD-READY (Lane D, parallel).
2. **Name a staging ASCII-DNS host** for A3 → moves Lane A from idle to an L3 egress-enable slice.
3. **Un-hold T3-6** (optional) → the broadest data-model line.

Until then: **zero** build-ready approval items (T3-3 already shipped, #3512); the machinery fans out only after T3-1/T3-2 votes or A3 host input.

## 7. Proposed next executors

- **Keep** the L1 fable5 propose-routine (running).
- **Add** an L2 Sonnet5 build-routine **when an L2 item is voted GO** (T3-1 post-vote); gated (never-merge, banner, fail-first golden + observed-RED, design+verification MDs). **Needs owner go** — per the standing acceptance bar, a new autonomous *runtime writer* is gated on explicit approval. *(No L2 target exists right now — T3-3 already shipped.)*
- **L3** (T3-2 post-vote, A3 post-host) → in-session Opus + human, when the owner is ready.

## 8. Scope / non-goals

Doc-only plan. No runtime, no flag change, no new routine spawned by this PR. The stale sprint backlog and closed ledgers stay excluded. Model tiering is a routing rule, not a quality claim — L3 always keeps a human in the loop regardless of model.
