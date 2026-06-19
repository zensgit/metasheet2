# Design-lock (PROPOSED — for owner ratification): sequential manager escalation (Reading B)

**Status:** PROPOSED design-lock, 2026-06-19. This is **Reading B** — the alternative carved out of the `continuous_managers` design-lock (#2886). The runtime is gated on owner ratification of §2; no code in this PR. Mirrors the continuous_managers / `direct_manager` / `dept_head` design-lock discipline.

---

## 1. What this is (and what it is NOT)

**Reading B = true *sequential* N-level escalation (依次审批 N 级上级):** the request goes to the level-1 manager; **only after they approve** does it rise to the level-2 manager; then level-3; up to K. Each level is a distinct, ordered approval **stage**.

This is **not** `continuous_managers` (Reading A, shipped #2893/#2907), which puts the whole chain (levels 1..K) into **one** node's approver set, aggregated by that node's 会签/或签 mode (all-at-once, not staged). The #2886 design-lock established — and verified in code — that an **assignee source can only fill one node's approver set; `buildRuntimeGraph` is static, so it cannot expand into the N ordered nodes sequential escalation requires.** Therefore Reading B is **graph construction**, not an assignee-source kind.

The graph model already supports the *shape*: a linear chain of ordered approval nodes (`node1 → node2 → … → nodeK`) advances one stage at a time today. The only missing piece is **producing a *different* (level-i) approver per node** — `direct_manager` resolves the same level-1 manager at every node, so chaining it isn't escalation.

---

## 2. The load-bearing decision — how are the N per-level nodes produced?

| Option | Mechanism | Cost / trade-off |
|---|---|---|
| **B1 — per-level source + manual chaining** (proposed) | Add a **`manager_at_level`** assignee source `{ kind: 'manager_at_level'; level: number }` that resolves the **single** `managerChainIds[level-1]` (reusing PR-1's baked chain). The template author places K ordered approval nodes, node *i* using `manager_at_level: i`. | **Smallest.** No graph-expansion machinery — reuses the baked `managerChainIds` and the existing ordered-node execution. Author has full per-node control (each node's `approvalMode`, `emptyAssigneePolicy`, field-perms authored explicitly). Author must place K nodes by hand. |
| **B2 — auto-expand at publish** | A single authoring construct ("escalate K levels") that `buildRuntimeGraph` **expands into K sequential nodes** at publish time. | Better UX (author specifies K once), but new expansion logic in `buildRuntimeGraph` + its own validation/round-trip surface. A layer *on top of* B1's per-level resolution. |
| **B3 — runtime dynamic node creation** | The executor creates nodes as it escalates. | **Rejected** — violates the static-graph invariant the whole approval engine relies on; high risk. |

**Recommendation: B1 first; B2 later as a UX layer.** B1 is the minimal, low-risk vehicle: it reuses everything PR-1 already bakes (`managerChainIds`, point-in-time, self-exclusion), adds only a single indexed assignee source, and leans on the *existing* ordered-node sequential execution — no new runtime concept. A template author expresses "依次 3 级" as three chained nodes, each `manager_at_level: 1|2|3`. B2 (auto-expand) is a genuine convenience but is a separate, larger authoring/publish feature best built once B1 proves the per-level resolution.

> **RATIFICATION GATE:** if the owner confirms **B1**, the runtime PRs below proceed. If the owner wants **B2** as the v1 (author specifies K once), that is a larger publish-time graph-expansion feature and should be its own design-lock. **W7 stays locked** either way.

---

## 3. Locks (proposed, under B1)

1. **`manager_at_level` source.** `{ kind: 'manager_at_level'; level: number }`; `level` validated deterministically — integer in `[1, MAX_MANAGER_CHAIN_LEVELS]` (the same configurable cap), explicit reject on missing/invalid (no silent default, per #1776). Resolves the **single** `managerChainIds[level-1]`.
2. **Reuses the baked chain.** No new snapshot field, no new walk — `managerChainIds` already exists (PR-1). Conditional baking must additionally fire when a graph uses `manager_at_level` (extend `runtimeGraphUsesContinuousManagers` → a shared "uses any manager-chain source" predicate).
3. **Carried locks:** point-in-time snapshot · self-exclusion on the requester's local id (already enforced in the chain) · unresolvable level (beyond chain length, or unlinked) → empty → that node's `emptyAssigneePolicy` · resolver-only, **W7 locked**.
4. **`as-built levels semantic` consistency.** Because the chain skips unlinked/self rungs, `manager_at_level: i` is "the *i*-th **available linked** manager up the tree", matching the as-built `continuous_managers` semantic (canonical doc #2886, as-built refinement) — *not* necessarily the i-th hierarchy level. The authoring UI copy must say so.

## 4. Runtime plan (post-ratification, separate opt-in — NOT this PR)

- **PR-1**: `manager_at_level` type + normalizer (level validation) + resolver case (`managerChainIds[level-1]`, self-exclude, empty→policy) + extend the conditional-bake predicate. Backend unit + real-DB.
- **PR-2**: FE authoring — the `manager_at_level` source option + a `level` input + allowlist; the wire round-trip + read-back traps; plus author guidance/example for chaining K nodes into a 依次 flow.

## 5. Honesty / scope

- This does **not** build B (no runtime here) — gated on §2 ratification.
- B2 (auto-expand) is explicitly **out of scope** of this lock; if wanted as v1 it is its own design-lock.
- **W7 (result write-back) stays locked.** `MAX_MANAGER_CHAIN_LEVELS` is now configurable (env `APPROVAL_MANAGER_CHAIN_MAX_LEVELS`), and `manager_at_level.level` shares that ceiling.
