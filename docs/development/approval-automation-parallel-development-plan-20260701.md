# Approval & Process-Automation — un-completed items, parallel-development plan & verification (2026-07-01)

> **As-built coordination plan** (updated to main after `#3437`/`#3443`/`#3446` merged). Deep review of what
> remains on the line, classified by gating and **sequenced into parallel lanes** so work distributes across
> sessions without hot-file collision. **Shipped since the first cut:** T2-4 re-entry quorum-bypass (`#3446`,
> `to_version >= cutoff`) + the R1-A egress guard/classifier (`#3437`/`#3443`). **Honest framing:** the
> remainder is owner-gated (design-lock-first) or in flight (R1-B) — so "complete all development" is realized by
> *ratifying defaults **per lane/rung** (not blanket — it mixes SSRF / destructive-delete / permission-migration
> / cross-base-writeback risk) + distributing the lanes*, not one session building everything.

## 1. Current state (shipped on main)
- **Tier-1:** T2-3 analytics, T1-1 node-SLA slice-1 (remind-only), T2-4 threshold mode, T2-5 timezone,
  date_field floating-day fix. **Cycle hardenings:** offsetDays save-cap + runtime clamp, analytics Top-N
  tie-break. **W7** approved-path resultWriteback (backend).
- **R1-A (SSRF) — COMPLETE:** `validateEgressUrl` egress guard + `isBlockedEgressIp` classifier
  (mapped / NAT64 / 6to4 / Teredo / **ISATAP both u/l forms `0000:5efe`+`0200:5efe` via `(bytes[8] & 0xfd)`** /
  IPv4-compatible `::/96`). `#3437` (embedded-IPv4 literals) and `#3443` (well-known NAT64 fold) **merged**. The
  guard is **not wired** to `BPMNWorkflowEngine.ts:550` yet — that call-site wiring is **R1-B** (the remaining slice).
- **T2-4 threshold re-entry quorum-bypass — FIXED (`#3446`):** the tally is scoped to the current node-entry
  round via `to_version >= <re-entry cutoff>` (schema-free, uses existing data); no re-entry → exact old query.

## 2. Un-completed items — gating

| Item | Subsystem | Status | Gating |
|---|---|---|---|
| ~~T2-4 threshold re-entry quorum-bypass~~ | approval engine | **SHIPPED (#3446)** | done — `to_version >= re-entry cutoff`, schema-free; CI green |
| ~~ISATAP `0200:5efe` u/l-bit + IPv4-compat~~ | BPMN (guard) | **SHIPPED (#3437/#3443)** | done — classifier folds both ISATAP u/l forms + `::/96` |
| **R1-B** DNS-pinned dispatcher + wiring + redirect re-validation | BPMN/workflow | unshipped | **ratified-buildable** (D0-D5 ratified, #3437 precondition met) — the remaining R1 slice |
| T1-1 slice-2 transfer/jump timeout effects | approval engine | unshipped | owner-gated (transfer/jump **target-config schema** + indirect jump→terminal carve-out; auto_* env-gated) |
| T2-1+2 scoped admins + handover | approval engine | unshipped | owner-gated (permission model + migration) |
| T1-4 node field-perms runtime | approval engine | unshipped | owner-gated (edit-form-at-node prerequisite) |
| T3-4 W7 rejection backwrite | automation/approval | unshipped | owner-gated (write-then-fail vs continue-tail; opt-in) |
| T3-5 W7 cross-base backwrite | automation/approval | unshipped | owner-gated (cross-base write-gate re-lock) |
| T0-3 delete_record editor | automation engine | unshipped | owner-gated (destructive, 7 decisions) |
| T1-2 inbound webhook | automation engine | unshipped | owner-gated (signature/replay/audit, 9 decisions) |
| T1-3 approval.* trigger | automation engine | unshipped | owner-gated (routing/loop/cross-tenant, 8 decisions) |
| T2-6 event-driven dedup ledger | automation engine | unshipped | owner-gated (substrate for T1-2/T1-3) |
| T3-2 business-calendar SLA · T3-3 signature · T3-1 mobile · T3-6 S-band | product/heavy | unshipped | owner-gated, L (T3-2 dep T1-1) |

## 3. Parallel-development lanes (the sequencing)

The line is **three largely-independent subsystems** — they can run **concurrently** in separate sessions.
The constraint is **hot files**: items sharing one runtime file must be **sequential within a lane** (parallel
edits to `ApprovalProductService.ts` / `automation-service.ts` collide).

- **Lane A — BPMN/workflow** (`BPMNWorkflowEngine.ts`, `routes/workflow*`, `guards/egress-guard.ts`):
  R1-A guard/classifier **done** (#3437/#3443); **`R1-B`** (DNS-pinned dispatcher + wiring) is the remaining
  slice. *R1 line active in a parallel session (#3442) — one session owns this; do not fork it.*
- **Lane B — approval engine** (`ApprovalProductService.ts` — HOT, so sequential): ~~`T2-4 fix`~~ **done (#3446)**
  → next `T1-1 slice-2` → `T2-1+2` → `T1-4`. (`T3-4/T3-5` W7-backwrite touch `automation-service.ts`, see Lane C.)
- **Lane C — automation engine** (`automation-service.ts` — HOT, so sequential): `T2-6 dedup` (substrate) →
  `T1-3 approval-trigger` / `T1-2 webhook` → `T0-3 delete_record` → `T3-4`/`T3-5` W7-backwrite.
- **Lane D — product/heavy** (separate surfaces): `T3-1 mobile`, `T3-6 S-band`, `T3-2 business-calendar`
  (dep T1-1), `T3-3 signature`.

**Hard deps:** R1-B→#3437 (met) · T2-2→T2-1 (permission model) · T3-2→T1-1 (node-SLA) · T1-2/T1-3 lean on
T2-6 (dedup substrate). **Cross-lane collision risk:** Lane B and the W7 items in Lane C both eventually touch
approval-completion code — keep W7-backwrite in Lane C to avoid `ApprovalProductService`/`automation-service`
double-editing.

## 4. What's ready to build vs needs a decision
- **Shipped:** T2-4 fix (#3446) · R1-A guard/classifier (#3437/#3443).
- **Ready now (ratified):** **R1-B** — the remaining R1 slice (D0-D5 ratified, #3437 precondition met); active in
  a parallel session (#3442).
- **Owner-gated:** everything else — the register (#3385) holds each rung's open decisions + proposed defaults.
  **Approve per lane/rung, not blanket** — the remainder mixes distinct risk surfaces (SSRF wiring, destructive
  delete, permission migration, cross-base write-back), so a single blanket "build on defaults" is unsafe.

## 5. T2-4 quorum-bypass fix — AS-BUILT (`#3446`, shipped)

**Bug:** the threshold tally (`ApprovalProductService.ts` threshold dispatch) counted `COUNT(DISTINCT actor_id)
… action='approve' AND metadata->>'nodeKey'=$2` with no round scoping. The 退回/return path admits any
previously-visited approval node — including an already-resolved `threshold` node — and approve records are
append-only, so on re-entry the prior-round votes counted toward N: a 2-of-3 that A+B already approved re-resolved
on a single fresh vote (self-verified reachable).

**Shipped implementation — schema-free `to_version >= cutoff` (NOT the register's Option-B `nodeEntryEpoch`
proposal):** the current round begins at the `to_version` of the most recent return/jump that re-entered the node;
approve records carry `to_version` (bumped), so the tally is scoped to `to_version >= <re-entry cutoff>`. `>=`
(not `>`) is deliberate — a return/jump can fire an auto-approval cascade at the re-entered node in the same
transaction (`insertAutoApprovalEvents` writes those approve records at `to_version = cutoff`), so they're
current-round votes that must count; prior-round approves are strictly `< cutoff`. **No re-entry → cutoff null →
exact old whole-node query (zero regression).** The graph is validated acyclic, so return/jump is the only
re-entry path (marker complete). This is **simpler than the epoch proposal** — no new metadata field, no per-node
counter, no migration.

**Verification (real-DB):** `approval-nofm-threshold` **4/4** incl. a fail-first re-entry test (2-of-3 → A+B
approve → advance → RETURN → one fresh vote must NOT re-resolve; RED-before confirmed) · N>M fail-closed +
single-reject unchanged. **Open follow-up:** a dedicated regression for the same-version-cascade `>=` boundary
(reasoned + cascade write-site confirmed, not yet test-locked).

## 6. Recommendation
1. **Done:** T2-4 fix (#3446) · R1-A guard/classifier (#3437/#3443).
2. **Lane A (R1-B)** — open the DNS-pinned dispatcher + wiring next (closes the live SSRF); active in a parallel
   session (#3442).
3. **Ratify register defaults PER LANE/RUNG** (not blanket — the remainder mixes SSRF, destructive delete,
   permission migration, and cross-base write-back risk surfaces). A good parallel next lane is **T2-6 (dedup
   ledger)** — an independent Lane C substrate that then unblocks T1-3/T1-2. Within each lane, items sharing a
   hot file (`ApprovalProductService.ts` / `automation-service.ts`) stay sequential.

