# Multitable D2 Perf Gate — First Baseline Verdict + Seed Infra Design Delta (2026-05-25)

Closes the first operator-triggered baseline run of the D2 large-table perf gate.
Reports what was measured, the verdict it supports, the thresholds proposed for
locking, and a **design delta** documenting an infrastructure limit that blocked
the 50k/100k tier.

- Design: `docs/development/multitable-perf-gate-d2-design-20260524.md`
- Impl harness: `docs/development/multitable-perf-gate-d2-impl-verification-20260524.md`
- Operator runbook: `docs/development/multitable-perf-gate-d2-baseline-operator-runbook-20260524.md`

---

## 0. TL;DR

- **`B_frontend_dom_memory_bound` is definitively excluded.** DOM node count and JS
  heap are **flat across a 10× row increase** (7471→7475 nodes, 16→17 MB at 1k→10k).
  The grid windows the DOM; JS row-virtualization would buy nothing. **Do not open a
  grid-virtualization PR.**
- **`A` vs `C` (backend query bound) is NOT resolved** at this run. It needs clean
  high-scale (50k/100k) query-latency slope, which was **blocked by an infra limit**
  (see §6).
- **50k/100k tier deferred** behind that infra limit. Not a product defect; not in
  the gate's frontend scope.
- ⚠️ **Operator action item:** revert the temporary staging nginx `proxy_read_timeout`
  bump (see §6) — it was authorized as temporary and is moot (the limit was client-side).

---

## 1. What ran

| tier | dispatches | result |
|---|---|---|
| 1k smoke | 2 (mount/scroll × primary) | ✅ pass |
| 10k | 4 (mount/scroll × primary/expanded) | ✅ 4/4 success |
| 50k/100k attempt#1 (concurrent) | 8 | ❌ 8/8 failed at seed (~307s); all rolled back clean |
| 50k canary attempt#2 (post nginx bump) | 1 | ❌ failed at seed (307s, identical) → see §6 |

Target: staging `http://23.254.236.11:8082` (nginx/1.27.5 → backend), image `39258df83`,
`ENABLE_YJS_COLLAB!=true` (operator-confirmed server-side), reusable base
`base_de18388f-...`. Run IDs + metadata captured in the run's `run-metadata.txt`.

---

## 2. Measured results (1k + 10k, the clean data)

### Frontend — the verdict signal

| metric | 1k | 10k (range over 4 runs) | 1k→10k slope |
|---|---|---|---|
| **domNodes.afterMount** | 7471 | 7473–7475 | **≈ +3 / 10k (flat)** |
| domNodes after scroll | 7469 | 7469–7471 (= afterMount) | flat — windowed |
| **jsHeapMb.afterMount** | 16 | 17 | **≈ flat** |
| jsHeap after scroll | 17 | 17 | flat |
| scrollFps p50 / min | 60 / 55 | 59–60 / 54–56 | smooth, no jank |
| longTask (count / totalMs) | 1 / 81 | 1 / 73–84 | trivial |
| ttiMs | 2888 | 2587–2962 | flat |

### Backend (per-record distribution sampling, NOT seed throughput)

| metric | 1k (2 runs) | 10k (4 runs) | note |
|---|---|---|---|
| insert p95 (ms) | 85, 89 | 61, 76, 77, 94 | flat |
| **query p95 (ms)** | 82, 84 | 82, 88, 117, 131 | mild ↑ **but contention-confounded** (see §5) |
| seedAgg (s) — *throughput, not a gate target* | 7.0, 8.4 | 93–100 | ~linear; **excluded from verdict per design** |

---

## 3. Verdict

### `B_frontend_dom_memory_bound` — EXCLUDED (high confidence)

DOM node count is ~7.5k regardless of dataset size (7471 @ 1k, 7475 @ 10k). If rows
were rendered 1:1, 10k would show ~75k nodes. The fixed ~7.5k window across a 10×
increase is the signature of **DOM windowing**, not merely CSS `content-visibility`
skipping paint (which would still leave all nodes in the tree). JS heap is likewise
flat (16→17 MB). **A JS row-virtualization effort would not reduce node count or heap
further — it is not the bottleneck.** `domNodes.per10kSlope ≈ 3`, `jsHeapMb.per10kSlope ≈ 1`.

### `A_CSS_sufficient` vs `C_backend_query_bound` — UNRESOLVED

`query p95` rises from 82–84 ms (1k) to as high as 131 ms (10k). That *could* be the
onset of `C`, or it could be measurement contention (§5). With only 1k→10k and a
contention confound, **this run cannot distinguish A from C.** Resolving it requires
clean, serialized 50k/100k query-latency data — blocked by §6.

### `D_client_algorithm_bound` / `E_yjs_sync_overhead_bound`

Not indicated (longTasks trivial; Yjs off by precondition; E not measured in v1).

---

## 4. Proposed thresholds to lock (frontend tiers only)

Lockable now from clean 1k/10k frontend data. **Intent: a regression guard against
losing DOM windowing**, not a high-scale SLA (that waits on §6).

> **Interim — refresh when high-scale lands.** These values derive from **two data
> points (1k, 10k)**; a 2-point slope cannot distinguish linear from sublinear-with-
> curvature. They are sound as a low-tier guard against *gross* loss of windowing, but
> must be re-fit once 50k/100k data exists. **Consumption: locked by documentation in
> this doc; an executable CI gate (verify script / workflow assertion) is deferred to a
> follow-up — these are not wired into any automated check yet.**

| metric | proposed gate | observed (10k) | rationale |
|---|---|---|---|
| `domNodes.per10kSlope` | **≤ 500** | ≈ 3 | alarms if windowing regresses (1:1 render ≈ 10000/10k) |
| `domNodes.afterMount` (≤10k) | ≤ 9000 | 7475 | windowed-window ceiling |
| `jsHeapMb.afterMount` (≤10k) | ≤ 30 | 17 | headroom over observed |
| `scrollFps.p50` | ≥ 50 | 59–60 | smoothness floor |
| `ttiMs` (≤10k) | ≤ 5000 | 2587–2962 | mount budget |

**Backend thresholds: NOT proposed for locking** — the only backend signal (query p95)
is contention-confounded and lacks high-scale data. Treat §2 backend numbers as
**observational**, re-collect serially before gating.

---

## 5. Contention caveat (affects backend numbers only)

Both the 10k tier (4 concurrent) and attempt#1 (8 concurrent) dispatched runs that
overlapped in time on the same staging server. The same-tuple `query p95` spread
(10k/primary: **82 vs 117**) is most plausibly **backend contention during the
200-POST / 50-GET sampling window**, not real measurement variance. The frontend
DOM/heap/fps numbers are unaffected (they don't contend on backend write/read
throughput), so the **B-exclusion verdict is robust**; only the A-vs-C backend signal
is degraded. Future runs must serialize (one dispatch at a time, or a single
`concurrency.group`).

---

## 6. Design delta — seed path is client-timeout-bound at ≥50k

### Symptom

All 50k and 100k seed attempts failed at **307 seconds** into the XLSX import with
`TypeError: fetch failed` (undici), during `uploadXlsxChunk`. 10k (~100s seed) passed;
50k (~500s) and 100k (~1000s) did not. Every failed run rolled back clean (cascade
delete) — **no orphan data on staging.**

### Root cause (corrected)

Initially hypothesized as nginx `proxy_read_timeout`. **Disproven empirically:** the
operator bumped staging nginx `proxy_read_timeout` to 1800s and the canary failed at
**307s again, identical**. A server-side proxy limit would have moved. The ~300s wall
matches **Node/undici's default `headersTimeout` (300000 ms)** — a *client-side* limit
in the harness's `fetch`, waiting for response headers while the server **synchronously**
processes the import (multitable's XLSX import is a synchronous per-row `createRecord`
loop; there is no async-commit pattern). At ~10 ms/row that's ~500s for 50k — past the
client's 300s header wait.

> Evidence caveat: the harness logs only `err.message` ("fetch failed"), not
> `err.cause`, so the literal `UND_ERR_HEADERS_TIMEOUT` was not printed. The proof is
> the bump-symmetry: an 1800s server-side change had zero effect on a 307s wall.

### Why this is NOT a product defect or a gate finding

The synchronous import is a **data-seeding** cost. Per design §4, seed time is explicitly
**excluded** from the verdict (it is throughput, not grid perf). This delta is about the
*harness's ability to stage large data*, not about how the grid performs.

### Fix options (DEFERRED — require separate explicit opt-in)

Both are harness-side and do **not** touch product code:

1. **Lower `XLSX_CHUNK_SIZE`** in `multitable-perf-highscale.yml` (e.g. 50000→20000) so
   each chunk's server response returns < 300s. 50k→3 chunks, 100k→5 chunks. One-line
   workflow env edit. Also confirms the client-timeout diagnosis (a ~200s chunk that
   succeeds where a ~500s chunk failed = proof the limiter is the ~300s client wait).
2. **Custom undici dispatcher** in `scripts/ops/multitable-perf-baseline.mjs` with
   `headersTimeout`/`bodyTimeout` raised/disabled for the upload call only.

**Explicitly out of scope (K3 PoC stage-1 lock):** async-commit import, a dedicated
seed endpoint, or any `packages/core-backend/src/**` change. Not to be done as a
"while we're here" — re-entry only on a named opt-in.

---

## 7. Deferred / next links

- **50k/100k high-scale baseline** — behind §6 fix opt-in. Re-run serially; revert the
  temporary nginx bump (it was moot).
- **A-vs-C resolution** — needs the high-scale query-latency slope above.
- **edit/sort/filter/group metric profiles** — still scaffolded/hard-throw in v1
  (separate follow-up impl PR, unchanged by this run).

---

## 8. Run evidence

- 1k smoke: runs `26378788373` (mount), `26378794516` (scroll) — PASS
- 10k tier: `26379099926` / `26379106008` / `26379112621` / `26379119429` — 4/4 success
- 50k/100k attempt#1: `26379252440`…`26379303900` — 8/8 failed @ seed, rolled back
- 50k canary attempt#2 (post nginx bump): `26389566005` — failed @ 307s, rolled back

### Run metadata (inlined — the operator scratch file was local/ephemeral)

```
target: staging 8082 (nginx/1.27.5 fronting backend), image 39258df83
yjs: ENABLE_YJS_COLLAB!=true (operator-confirmed server-side)
base_id: base_de18388f-8052-4d0d-9c50-9809be377fca (reusable)
1k smoke: PASS (runs 26378788373 mount, 26378794516 scroll)
10k tier: 4/4 success (26379099926/26379106008/26379112621/26379119429)
highscale attempt#1 (concurrent): 8/8 FAILED at seed (~307s); all rolled back clean
INFRA CHANGE (temporary, seed/import only): operator bumped staging nginx
  proxy_read_timeout/proxy_send_timeout to 1800s. NOT a product change; to be reverted.
canary attempt#2: run 26389566005; rows=50000 mount/primary; purpose=validate nginx bump
canary_outcome: FAILED @307s (seed 07:46:56->07:52:03Z); nginx 1800s bump had ZERO
  effect -> client-side undici headersTimeout(300s), NOT nginx; rolled back clean
```

Each failed seed rolled back via `DELETE /sheets` cascade (`rollback=success` on all),
so staging carries no orphan records — only the one reusable base by design.
