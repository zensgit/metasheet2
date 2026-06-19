# Design-lock (PROPOSED — for owner ratification): `continuous_managers` assignee source

**Status:** PROPOSED design-lock, 2026-06-18. Mirrors the shape of the `direct_manager` (#2852) and `dept_head` (#2863→#2871→#2873) design-locks, but with **one load-bearing decision the owner must ratify before any runtime** — because, unlike those two, the locks here are *agent-proposed*, not owner-handed. No code in this PR. The runtime PRs are a separate opt-in, gated on ratification of §1.

---

## 1. The load-bearing decision — what does "multi-level escalation" mean here?

The existing design docs only ever name `continuous_managers` as a one-line "multi-level escalation, later". The semantic was never defined. It splits two ways, and the split is **architecture-determining**:

| Reading | Meaning | Where it lives |
|---|---|---|
| **A — manager-chain-as-approver-set** (proposed) | Resolve the requester's manager chain (levels 1..K) into the **approver set of a single node**; the node's existing `approvalMode` decides aggregation: `all` (会签) = every level must approve, `any` (或签) = any one level approves. | An **assignee source** — small, reuses the `direct_manager`/`dept_head` machinery. |
| **B — true sequential escalation** | Distinct ordered steps: level-1 manager approves, then it rises to level-2, then level-3 — each a separate approval stage that only starts after the previous clears. | **Graph expansion** (N ordered approval nodes) — *not* an assignee source. |

**Technical constraint that forces the choice (verified on `origin/main` `7f11fd9bc`):**
- `ApprovalNodeConfig` carries `assigneeSources?: ApprovalAssigneeSource[]` **and** `approvalMode?: ApprovalMode` (`'single' | 'all' | 'any'`).
- `buildRuntimeGraph(...)` produces a **static** runtime graph at publish time; the executor navigates pre-authored nodes/edges/parallel-branches and **never creates nodes from assignee resolution**.
- Therefore an assignee source can only ever populate **one node's approver set**. It structurally **cannot** produce the N sequential nodes that reading **B** requires.

**Consequence:**
- Reading **A** *is* implementable as an assignee source (this design). Aggregation is delegated to the node's `approvalMode` — we add no new aggregation concept.
- Reading **B** is a **separate, larger feature** (template-authoring / graph-construction: either the author places N nodes, or a new auto-expand-at-publish mechanism). It is **out of scope here** and is plausibly comparable in size to the **C** (detail/sub-form runtime) arc — so if the owner wants **B**, this whole assignee-source framing is the wrong vehicle and the next-arc choice (continuous_managers vs C) should be re-weighed.

**Recommendation:** adopt **A**, and explicitly carve out **B** as a future graph-expansion feature (reopen-only). Rationale: **A** is the only thing an assignee source *can* mean, it composes cleanly with the existing 会签/或签 per-node aggregation, and it delivers the common "this step needs sign-off from my management chain up to K levels" need without inventing a new runtime concept. If the product specifically needs *staged* escalation, that is **B** and should be scoped on its own.

> **RATIFICATION GATE:** if the owner confirms **A**, the runtime PRs below proceed. If the owner wants **B**, this design-lock is closed and re-opened as a graph-expansion design — no runtime from this doc.

---

## 2. Locks carried verbatim from `direct_manager` / `dept_head` (already owner-ratified)

These need no re-decision; they are the established posture for org-derived sources:
- **Point-in-time snapshot.** The chain is frozen into the requester snapshot at `createApproval` time. No live directory re-query at dispatch.
- **Self-exclusion.** The requester is never an approver of their own request — excluded at every hop of the walk *and* defensively in the resolver.
- **Unresolvable → `emptyAssigneePolicy`.** A chain that resolves to zero usable approvers yields an empty set; the node's `emptyAssigneePolicy` (`error` | `auto-approve`) decides, exactly as for `direct_manager`.
- **Resolver-only / convergence-safe.** Writes nothing; touches no `approval_*`/`automation_*` table beyond reading the snapshot. **W7 result write-back stays locked.**

---

## 3. Locks specific to `continuous_managers` (proposed)

1. **`levels` parameter.** The source is `{ kind: 'continuous_managers'; levels: number }`. `levels` is **validated deterministically**: integer, clamped to `[1, MAX_LEVELS]` with `MAX_LEVELS = 10`; a missing/non-integer/out-of-range value is an **explicit normalizer rejection**, never a silent fallback-to-default (the enum-strictness rule from the #1776 finding). `levels = 1` is exactly `direct_manager`.
2. **New ordered snapshot field `managerChainIds: string[]`.** Level 1 = direct manager, level 2 = manager's manager, … Baked alongside the existing `managerId` (which stays as-is for `direct_manager`; `managerChainIds[0]` will equal `managerId`). The resolver reads `managerChainIds.slice(0, levels)`.
3. **Bake-time hop-by-hop walk** generalizes the existing single-hop manager resolution in `resolveApprovalRequesterOrgRelations`: from the requester, resolve the leader of their primary department; from that leader, resolve *their* leader; repeat. Each hop reuses the current `leader_in_dept` logic.
4. **Cycle + depth termination.** Maintain a visited-set of local user ids during the walk; stop when (a) a hop revisits an already-seen id (cycle), (b) no manager is found at a level (top reached), or (c) `MAX_LEVELS` hops taken. The walk stores whatever prefix it found — possibly shorter than any template's requested `levels`.
5. **Conditional baking (cost control).** The chain walk runs **only when the template's published runtime graph actually contains a `continuous_managers` source** — so the up-to-10 extra per-hop queries are *not* added to every `createApproval`. (Confirm during impl that the runtime graph is available at the bake site; it is constructed/read there today.)
6. **Resolver dedup.** A person appearing at two levels (rare, e.g. a re-org artifact) is pushed once; self-exclusion applies after the slice.

---

## 4. Runtime plan (post-ratification, separate opt-in — NOT this PR)

Mirrors the `direct_manager`/`dept_head` chain:

- **PR-1 snapshot plumbing:** generalize the org-walk into the chain; add `managerChainIds` to the snapshot type + bake step (conditional); unit + real-DB tests incl. the **cycle** and **top-reached-short-chain** cases.
- **PR-2 resolver/authoring:** `ApprovalAssigneeSourceKind += 'continuous_managers'`; union member with `levels`; normalizer with the deterministic `levels` validation (incl. an **invalid/missing-value rejection test**); resolver case (`slice(0, levels)` + self-exclusion + dedup); FE type, draft hydrate, `sourceFromStep`, the **`unsupportedTemplateAuthoringReason` allowlist** (else saved templates read back fail-closed — the trap fixed for `direct_manager` in #2852), the authoring option + a **`levels` number input**, and a **save→read-back wire round-trip test for `levels`** (the wire-vs-fixture drift rule — assert the field survives the real wire, not a hand-built fixture).

---

## 5. Verification of this design-lock

- **Semantic constraint is real, not assumed:** `assigneeSources[]` + per-node `approvalMode` and the static `buildRuntimeGraph` were read on `origin/main` `7f11fd9bc`; an assignee source demonstrably fills one node's approver set and cannot expand the graph → reading **B** cannot be an assignee source. This is the doc's central claim and it is grounded in code, not inference.
- **Reuse is real:** the single-hop manager resolution already exists in `resolveApprovalRequesterOrgRelations`; the walk is its generalization.
- **No code, no gate opened.** Runtime is gated on §1 ratification. `continuous_managers` stays out-of-scope in the `direct_manager`/`dept_head` docs until then.

## 6. Honesty / what this does NOT decide

- It does **not** build reading **B** (sequential escalation). If the owner wants that, this doc is closed and the feature is re-scoped as graph expansion — and the continuous_managers-vs-C next-arc pick should be revisited, since **B** is not the cheap reuse that motivated choosing continuous_managers.
- It does **not** unlock **W7** (result write-back) — no write-back scenario is in play.
