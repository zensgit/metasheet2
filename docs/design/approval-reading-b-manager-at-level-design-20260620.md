# Design-lock (PROPOSED, owner chose B1): Reading B sequential escalation via `manager_at_level`

**Status:** **PROPOSED** — owner ratified **reading B = B1** (manual chained nodes + a per-level
`manager_at_level` assignee source; **no** publish-time auto-expansion) on 2026-06-20. Reopens the
**Reading B** feature explicitly carved out of the `continuous_managers` design-lock
(`docs/design/approval-continuous-managers-assignee-source-design-20260618.md` §1, where reading **A**
= manager-chain-as-approver-set shipped, and reading **B** = "true sequential escalation = graph
expansion" was left for a separate decision). Mirrors the `direct_manager` (#2852) / `dept_head`
(#2873) / `continuous_managers` (#2907) assignee-source design-locks.

## 1. The decision — what B1 is, and why it is small

The `continuous_managers` lock established that reading **B** (level-1 approves → rises to level-2 →
level-3, each a separate stage) **cannot be an assignee source**, because a source only fills *one*
node's approver set. **B is graph expansion** — N ordered approval nodes — and it splits two ways:

| Sub-approach | Who builds the N nodes | Cost |
|---|---|---|
| **B1 — manual chained nodes** (chosen) | The **author** places N approval nodes in the existing linear graph, each pointing at one level. | **Small** — no new graph machinery; just a per-level assignee source. |
| **B2 — auto-expand-at-publish** (out) | A new publish-time mechanism expands one "escalate to K levels" node into N nodes. | Large — new graph-construction runtime; the "comparable-to-C" size the lock warned about. |

**B1 is the cheap path** precisely because it adds **no graph runtime**: the existing linear approval
builder already lets an author place sequential approval nodes. All B1 needs is a way for each node to
resolve **one specific level** of the requester's management chain — a new assignee source
`manager_at_level` — and it **reuses the already-baked `managerChainIds` snapshot**
(`continuous_managers` PR-1 #2893). It turns the shipped continuous (会签/或签 over the whole chain in
one node) into **顺序逐级** (one level per node, in author-defined order).

**Owner rationale (recorded):** most explicit, easiest to review, least magic, maximal reuse. If the
product later needs *automatic* expansion, that is **B2** and is scoped separately — this lock does
**not** build it.

## 2. Contract — the `manager_at_level` assignee source

```ts
// types/approval-product.ts + apps/web/src/types/approval.ts
type ApprovalAssigneeSourceKind =
  | 'static_user' | 'static_role' | 'requester' | 'form_field_user'
  | 'direct_manager' | 'dept_head' | 'continuous_managers'
  | 'manager_at_level'                              // NEW

// union arm
| { kind: 'manager_at_level'; level: number }      // 1 = direct manager, 2 = manager's manager, …
```

- **Resolver** (`ApprovalAssigneeResolver`, new `case 'manager_at_level'`): reads the **existing**
  `requesterSnapshot.managerChainIds` (no new plumbing) and returns the single id at
  `managerChainIds[level - 1]` — i.e. *the `level`-th available linked manager walking up from the
  requester*, using the **same** "skip unlinked/self rungs" walk semantics the `continuous_managers`
  lock §3 as-built refinement defined. Self-exclusion applies after the pick (a requester who is their
  own level-N manager resolves empty).
- **Short chain:** if the walk produced fewer than `level` rungs, the node resolves to an **empty**
  approver set → the node's existing `emptyAssigneePolicy` (`error` | `auto-approve`) decides — no new
  failure mode, identical to how `continuous_managers` handles a chain shorter than `levels`.
- **`level` validation (deterministic, enum-strict — the #1776 rule):** integer, clamped to
  `[1, MAX_LEVELS]` with `MAX_LEVELS = 10` (reuse the continuous_managers cap constant); a
  missing / non-integer / out-of-range value is an **explicit normalizer rejection**, never a silent
  default.
- **`level = 1` ≈ `direct_manager`** in the common case (same as `continuous_managers` `levels = 1`);
  they coexist — `direct_manager` stays the idiomatic choice for "just my manager", `manager_at_level`
  is for explicit per-level placement in a chain.

## 3. Sequential approval is authored, not generated

B1 produces 顺序逐级 approval by the **author** placing nodes — e.g. a 3-level chain is three approval
nodes in series:

```
start → [approval: manager_at_level(1)] → [approval: manager_at_level(2)] → [approval: manager_at_level(3)] → end
```

Each node is an ordinary approval node with its own `approvalMode` (`single` is the typical choice for
a single per-level manager). The graph is exactly what the author built — **no publish-time
auto-expansion**, no hidden node synthesis. This is the "least magic" property the owner asked for, and
it keeps the existing `buildRuntimeGraph` / linear builder unchanged.

## 4. Boundaries (convergence-safe, mirrors continuous_managers)

- **Resolver-only.** Writes nothing; touches no `approval_*` / `automation_*` table beyond reading the
  snapshot. **W7 result write-back stays locked.** No automation/bridge coupling.
- **No new snapshot field.** `managerChainIds` already ships; B1 only *reads* a single index of it.
- **No graph-runtime change.** No new node type, no auto-expand, no parallel/condition interaction.
- **Out of scope:** B2 auto-expand-at-publish; `stopAt`-style chain termination; cross-node "approved
  at level k short-circuits k+1" logic (that is ordinary sequential-node behavior, already handled by
  the linear graph — not a B1 concern).

## 5. Implementation slices (mirror the continuous_managers PR-2 checklist)

Single contained PR (it is smaller than continuous_managers, which also needed the #2893 plumbing):

1. **Backend:** `ApprovalAssigneeSourceKind += 'manager_at_level'`; union arm with `level`; normalizer
   with deterministic `level` validation (incl. an **invalid/missing-value rejection test**); resolver
   `case 'manager_at_level'` (`managerChainIds[level-1]` + self-exclusion).
2. **Frontend:** FE type union; draft hydrate; `sourceFromStep`; the
   **`unsupportedTemplateAuthoringReason` allowlist** (else saved templates read back fail-closed — the
   `direct_manager` #2852 trap); the authoring option + a **`level` number input**.
3. **Tests:** normalizer valid/invalid `level`; resolver real-DB (resolves the right level; short-chain
   → empty; self-exclusion); **FE save→read-back wire round-trip for `level`** (wire-vs-fixture drift
   rule — assert the field survives the real wire); authoring-allowlist read-back (a saved
   `manager_at_level` template is not fail-closed).

## 6. Acceptance

- A non-admin author can place N sequential approval nodes, each `manager_at_level(level=k)`, and the
  published template resolves each node to the correct k-th chain manager of the requester.
- A chain shorter than a node's `level` resolves empty → `emptyAssigneePolicy`.
- Invalid `level` is rejected at normalize time, not defaulted.
- `manager_at_level` round-trips through the real authoring wire (no fail-closed read-back).
- Resolver-only: no writes; W7 stays locked; `git grep` shows no new `approval_*`/`automation_*` write.

## 7. Non-goals / reopen-only

- **B2 (auto-expand-at-publish)** — separate, larger, reopen-only.
- Auto "short-circuit on approve" beyond what sequential nodes already do.
- Any W7 / backwrite / automation coupling.
