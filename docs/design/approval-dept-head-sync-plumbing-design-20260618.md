# Approval — `dept_head` data plumbing + resolver (design-lock)

**Status:** design-lock only. No runtime in this PR. Sequenced: **this design-lock → sync-plumbing PR → resolver/authoring PR.**
**Why now:** `direct_manager` shipped (#2852) reading `requesterSnapshot.managerId`. The symmetric `dept_head` source is blocked on **data**: the directory sync calls only `/topapi/v2/department/listsub` (`integrations/dingtalk/client.ts:464`), which returns the department *list* — **not** `dept_manager_userid_list`. That field comes from the department **detail** API (`/topapi/v2/department/get`), for which there is **no client method yet**. So `dept_head` needs a sync-plumbing slice before any resolver work.

## The two-PR shape (after this lock)
1. **Sync-plumbing PR** — add a department-**detail** fetch that writes `dept_manager_userid_list` into `directory_departments.raw` (upsert at `directory/directory-sync.ts:2153`). Data only; no approval surface.
2. **Resolver/authoring PR** — a `dept_head` assignee kind reading `requesterSnapshot.deptHeadId` (the org-relation plumbing already derives it from `dept_manager_userid_list`), plus the authoring source option — mechanically mirroring `direct_manager`. Meaningful only once (1) lands real data.

## Locked decisions

### 1. Department-detail call strategy
- **API:** add a `getDepartment(deptId)` client method calling `/topapi/v2/department/get` (returns `dept_manager_userid_list`). `listsub` is kept as the list source.
- **Cadence:** the detail fetch is a **best-effort enrichment pass that runs after the list sync**, over the **full department set** for correctness. **Per-department failure is non-fatal** — log + skip that dept's *detail* call, but **carry forward its last-known-good detail fields** (see §2) instead of writing a detail-less raw; it must NOT fail the whole sync.
- **Cost / rate-limit:** **bounded concurrency + QPS throttle** on the detail calls (one `get` per department = N calls/sync). **Incremental "only changed departments"** is the explicit scale optimization, **deferred** — flagged here so a large-tenant follow-up has a home, not built now.

### 2. raw merge rule
- **last-known-good detail fields.** The dept upsert overwrites the **whole** `raw` column (`raw = EXCLUDED.raw`, `directory-sync.ts:2165`), so the enrichment must compose the *full* raw it writes — it cannot do a partial update. Per department the written raw is `{ ...listsubRaw, ...detailFields }` (listsub keys always refreshed from the current list pass, **never** overwritten by detail), where `detailFields` follows **last-known-good**:
  - **`department/get` succeeds** → `dept_manager_userid_list` is set to the **fresh** value, *including an empty list when the dept genuinely has no manager* (success-empty is authoritative — see §3);
  - **`department/get` fails** → the detail fields are **carried forward** from the dept's existing `directory_departments.raw` (the prior `dept_manager_userid_list` is **preserved, never wiped**).
- Net effect: a transient `department/get` failure leaves dept_head exactly as resolvable as it was — **no silent flip to empty**. (Equivalent alternative, not the locked default: switch the dept upsert to a JSONB merge `raw = directory_departments.raw || EXCLUDED.raw`; the app-level carry-forward is preferred so the shared upsert's semantics don't change for every sync path.)

### 3. Missing-data semantics
- Absent or empty `dept_manager_userid_list` → the org-relation plumbing derives **no** `deptHeadId` → the future `dept_head` resolver returns **empty** → the node follows its `emptyAssigneePolicy` (`error`/`auto-approve`). Identical to `direct_manager`'s unresolvable path. The sync **never fabricates** a manager; absent stays absent.

### 4. Verification ordering
- **Sync-plumbing PR first proves data lands AND survives a transient failure:**
  - (a) merge unit — listsub keys never overwritten; a **successful** detail refreshes `dept_manager_userid_list` (incl. success-empty → empty);
  - (b) fixture detail → upsert → assert `directory_departments.raw.dept_manager_userid_list` is present;
  - (c) **failure-preservation (the load-bearing case)** — an existing raw already holds `dept_manager_userid_list`; a round where **listsub succeeds but `department/get` fails** → the sync still succeeds **and the manager list is preserved, not wiped**;
  - (d) per-dept failure never fails the whole sync.
  - **Only after** these does the resolver/authoring PR go in, mirroring `direct_manager`'s test set (resolve+metadata / unresolvable→empty / authoring round-trip + read-back / real-DB create-start).

## Out of scope (stay gated)
`continuous_managers` (multi-level escalation) · incremental change-detection for the detail pass · **W7** result write-back (locked). No approval-engine change in the sync-plumbing PR; no live directory re-query at dispatch (resolver will read the start-time snapshot, like `direct_manager`).
