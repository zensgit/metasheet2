# Multitable Feishu Phase 3 — Lane D3 Permission Matrix Semantics Comparison

- Date: 2026-05-15
- Author: Claude (Opus 4.7, 1M context), interactive harness; **read-only design preparation, no code, no TODO Status change, no implementation PR**
- Status: **Landed as read-only decision packet; not ratified.** This document presents three semantics options for closing T5 (the D3 activation blocker) and recommends a default. T5 itself stays open until the operator records a choice; D3 remains `deferred` in the TODO regardless of this document landing.
- Companion to: `docs/development/multitable-phase3-unlock-checklist-20260515.md` (Lane D3 row)
- Scope: enumerate the two semantics choices that close T5 (the D3 activation blocker), compare them concretely against the multitable permission surface that already lives on `main`, and recommend a default.

## 1. Charter

D3 is the permission-matrix release gate, deferred per `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md` until T5 closes:

> **T5** — D3 must explicitly choose snapshot semantics versus golden matrix semantics for sheet / view / field / record / export permission paths. Without this distinction, D3 can pass while silently masking a regression that simply matches whatever the current code does.

This doc lays out the two options, plus a hybrid, against the actual permission code on `main` so the operator can decide.

## 2. The choice in one paragraph

A permission gate either (A) records what the system **does today** and shouts when that changes (**snapshot semantics**), or (B) records what the system **should do per spec** and shouts when reality diverges (**golden matrix semantics**). The first is cheap, biased to current behavior (including bugs); the second is expensive, biased to declared truth. The Phase 3 release gate cannot adopt one of these by accident — whichever it adopts becomes the meaning of a green CI run.

## 3. Current permission surface on `main`

What D3 has to cover:

- **Subjects**:
  - anonymous (public-form readers)
  - authenticated user
  - role (platform RBAC role)
  - DingTalk group binding (per `dingtalk-group-destination-service.ts`)
  - member-group binding (per the multitable ACL governance Wave M-2 series)
- **Resources**:
  - sheet (top-level container)
  - view (within a sheet)
  - field (within a sheet)
  - record (within a sheet)
  - export (record set → CSV / XLSX)
- **Operations**:
  - read, write, write-own, admin
  - export (subset of read)
- **Code families on `main`** (from `packages/core-backend/src/multitable/permission-service.ts`):
  - `SHEET_READ_PERMISSION_CODES`
  - `SHEET_WRITE_PERMISSION_CODES`
  - `SHEET_OWN_WRITE_PERMISSION_CODES`
  - `SHEET_ADMIN_PERMISSION_CODES`
  - `MANAGED_SHEET_PERMISSION_CODES`
  - `CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL`
  - Helpers: `hasPermission`, `canReadWithSheetGrant`, `applyContextSheetReadGrant`, `applyContextSheetRecordWriteGrant`, `applyContextSheetSchemaWriteGrant`
- **Public form capability layer**: `PUBLIC_FORM_CAPABILITIES` (a separate subject-shape — anonymous public-form readers/writers under `public` / `dingtalk` / `dingtalk_granted` modes).

Concretely, a complete matrix is at minimum:

```
5 subjects × 5 resources × 4 operations = 100 cells
```

Plus the public-form 3-mode (`public` / `dingtalk` / `dingtalk_granted`) sub-matrix. Plus per-field hidden / read-only / hidden-for-export overrides. Plus role inheritance (admin subsumes write subsumes read). Real cell count after explosion: roughly **200-400** cells, depending on how much per-field detail is encoded.

> **Note**: the 200-400 figure is a **planning estimate** based on Claude's hand-count of the subject × resource × operation axes plus visible sub-matrices on `main`. It is **not** the output of an exhaustive script-generated matrix enumeration. The D3 implementing PR is where the exact cell count is established (and likely captured as a static fixture); until then, treat 200-400 as scoping guidance, not a contract.

## 4. Option A — Snapshot semantics

D3 enumerates a set of representative scenarios (e.g., "anonymous reader hits a `public`-mode form's READ on field X"), exercises them against the live code on `main` at the moment D3 is authored, records the observed outcome, and asserts that observation in every future CI run.

### A.1 What an assertion looks like

```text
GIVEN a sheet with permission code SHEET_READ on subject S
WHEN  S calls GET /api/multitable/sheets/:id/records/:rid
THEN  observed outcome = 200 OK with redacted record body
```

The "200 OK with redacted record body" part is recorded as **whatever the code on `main` actually returned at snapshot time**. If a future PR changes that to "200 OK with un-redacted body" (a regression!), D3 fails — not because the change is wrong by spec, but because it differs from the snapshot.

### A.2 Pros

- **Cheap to author** — run the scenarios once, capture the outputs as fixtures.
- **Catches regressions** — any code change that alters observable behavior trips the gate.
- **No SME / RBAC-spec interview needed** to bootstrap.

### A.3 Cons

- **Encodes current bugs as "correct"**. If the current implementation lets an anonymous reader see a field that the spec says should be hidden, the snapshot codifies that leak.
- **Cannot detect "the current behavior IS the bug"**. D3 will green-light it forever.
- **Snapshot drift trap**: when a legitimate behavior change ships, every snapshot mismatch must be inspected and re-snapshotted. With 200-400 cells, the re-snapshot pass is tedious and tempting to do mechanically — which defeats the gate.

### A.4 Scope a snapshot D3 can realistically cover

| Resource × Op | Snapshot scope | Cells |
| --- | --- | --- |
| sheet × read/write/admin | 3 subjects × 3 ops, observed | ~9 |
| view × read | per-view-mode (`public`/`dingtalk`/`dingtalk_granted`/`internal`) × 4 subjects | ~16 |
| field × read | hidden / visible / read-only / read-only-for-anonymous | ~10 |
| record × read/write/write-own | typical record fixture | ~12 |
| export × read | per public-form mode | ~3 |

Realistic snapshot ≈ **50 cells**. Bootstrap effort ≈ **2-3 days** for the author + reviewer. Maintenance: re-snapshot per behavior change.

## 5. Option B — Golden matrix semantics

D3 author writes out, in code or fixture files, the **expected** permission outcome for each (subject, resource, operation) cell as derived from RBAC spec or operator-agreed truth. D3 asserts current code matches the matrix; mismatches always fail the gate, regardless of whether the diff is a bug or a deliberate change.

### B.1 What an assertion looks like

```text
GOLDEN: anonymous + public-form sheet + read → 200 OK, fields {x, y} redacted, fields {z} visible
TEST:   anonymous + public-form sheet + read against current code → observed outcome
ASSERT: observed === GOLDEN
```

If the spec says `z` should NOT be visible to anonymous, and the code on `main` returns `z` visible, the test **fails**. That failure is the gate working.

### B.2 Pros

- **Detects current bugs** — divergence between code and spec surfaces immediately.
- **Becomes the canonical truth source** for permissions; operator can point to it during audit.
- **Stable when behavior is correct** — only changes when the spec changes, which should be rare and intentional.

### B.3 Cons

- **Expensive to author** — someone has to write out the matrix, and writing it requires SME-level RBAC understanding.
- **Coupled to spec change cadence** — every legitimate behavior change requires both code and matrix updates in the same PR.
- **Risk of "matrix says X but everyone thinks Y is right"** — without an explicit RBAC spec doc to cite, the matrix becomes one author's interpretation.

### B.4 Bootstrap dependency

A golden matrix can only be authored if **someone owns "the spec"**. Today, the multitable permission spec is implicit (encoded in `permission-service.ts` + RBAC docs + ACL governance MDs). Authoring a golden matrix forces an explicit spec to exist. That is **valuable work** but **non-trivial** — call it 5-10 person-days of RBAC review + SME interviews before D3 can start.

## 6. Option C — Hybrid (recommended default)

Apply each semantic to the resources / operations it suits best.

| Resource × Op | Recommended semantics | Why |
| --- | --- | --- |
| sheet × read / write / admin | Golden matrix | The platform RBAC code families are clearly documented; spec is reasonably explicit. |
| view × read (public-form modes) | Golden matrix | Bug surface is high (public surfaces); operator-facing risk if anonymous gets too much. Worth the upfront cost. |
| view × read (internal modes) | Snapshot | Internal view permission rules are subtle and follow sheet-level grants; spec is sheet-rooted. |
| field × hidden / read-only / read-only-for-anonymous | Snapshot | Per-field rules are configuration-driven by sheet authors; the gate should detect changes-from-current, not enforce spec since each tenant configures their own. |
| record × read / write / write-own | Golden matrix | The `SHEET_OWN_WRITE_PERMISSION_CODES` path has had subtle bugs historically; worth the explicit spec. |
| export × read | Golden matrix | Export is a high-risk leak surface; explicit spec is the safer posture. |

Bootstrap effort ≈ **4-6 days** total (the golden-matrix portions ≈ 3-4 days; snapshot portions ≈ 1-2 days). Subsequent maintenance is sharper than pure snapshot but cheaper than pure golden.

## 7. T-blocker closure framing

Whichever option the operator picks, T5 closes as:

```text
T5 — D3 permission-matrix semantics resolved: <Option chosen>.
     Scope: <which cells are golden / which are snapshot>.
     Spec source: <document name on origin/main, or "this PR authors it">.
```

The implementing PR cites this resolution at the top of its development MD.

## 8. Acceptance gates regardless of option

Both A and B (and C) ship with the same outer-shape guarantees:

1. **Read-only on production data.** The matrix is asserted against fixture sheets, not customer data.
2. **No SMTP / no DingTalk webhook / no real recipient.** Permission gates check access, not delivery.
3. **Pure unit assertions where possible.** Spawn-based integration tests are slow; prefer testing `permission-service.ts` exports directly. Spawn only for one end-to-end smoke per public-form mode.
4. **Redaction.** Per-field fixture data must use `<example>`-style content (no real PII / no real user emails / no real DingTalk receiverUserIds).
5. **Stage-1 lock check.** D3 implementing PR must not touch `plugins/plugin-integration-core/`, `lib/adapters/k3-wise-*`, K3 / Data Factory / Attendance / DingTalk runtime. Permission gates are pure multitable-domain code.

## 9. Operator decision required

| Question | Answer |
| --- | --- |
| Q-D3-1: Which semantics does D3 ship with? | A (snapshot) / B (golden matrix) / C (hybrid per §6) / D (none, keep D3 deferred). |
| Q-D3-2: If B or C, which document on `origin/main` is the "spec source" the matrix asserts against? | Either an existing RBAC doc (cite path) OR a new doc to be authored by the D3 implementing PR. |
| Q-D3-3: How many person-days are available to bootstrap D3? | If < 3 days → A is the only feasible choice. If 3-6 days → A or C. If > 6 days → B is feasible. |
| Q-D3-4: Once D3 lands, who maintains the matrix when permission code changes? | Engineering + SME, ideally with PR checkpoint on the matrix file. |

Until Q-D3-1 and Q-D3-2 are recorded, T5 remains open and D3 stays deferred in the TODO.

## 10. Recommendation

**Hybrid (Option C)** is the default recommendation. Rationale:

- Pure A leaves the platform's highest-risk leak surface (public-form export, anonymous reads) un-audited.
- Pure B requires an upfront spec authoring sprint that is not currently scoped.
- The Hybrid table in §6 puts golden matrix where leaks would cost the platform reputation, snapshot where tenant configurability would otherwise force impossible spec authority.

If the operator disagrees and prefers pure snapshot (cheapest), record that explicitly so future readers know D3 green does NOT imply spec compliance, only "no regression from snapshot time."

## 11. What this comparison did NOT do

- Did NOT modify any TODO Status line; D3 remains `deferred` per `multitable-feishu-phase3-ai-hardening-todo-20260514.md` line 577.
- Did NOT propose a D3 implementation PR.
- Did NOT author any matrix cells. (That belongs in the implementing PR after T5 resolves.)
- Did NOT touch production permission code or fixtures.

## 12. References

- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md` (T5 definition).
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md` line 577 (Lane D3 Status).
- `docs/development/multitable-phase3-unlock-checklist-20260515.md` §4.9 (D3 unlock conditions).
- `packages/core-backend/src/multitable/permission-service.ts` (M4 service — permission code families and helpers cited throughout this comparison).
- `packages/core-backend/src/multitable/permission-derivation.ts` (field / view / record derivation — referenced by M4 service).
- Multitable ACL governance Wave M-2 docs in `docs/development/multitable-acl-*-20260418.md` (subject-shape: role / dingtalk-group / member-group).
- Public form access modes documented in DingTalk public-form access-matrix work (PR #1212 + #1248).
