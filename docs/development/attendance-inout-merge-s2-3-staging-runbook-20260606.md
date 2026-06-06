# S2-3 staging smoke runbook — 内外勤卡合并 (in/out merge)

**Date:** 2026-06-06 · **Owner-gated:** running this is the **S2-3** opt-in (an outward/infra step). Writing the script + this runbook is the prep step; the actual staging run is separate.
**Script:** `scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs`
**Goal:** the last S2 completion gate — on PASS, flip the tracker row `内外勤卡合并` **🟡 → ✅**.

## What S2-3 proves (and what it does not)

It exercises the **real** user-facing flow against staging — `PUT /settings`, create approval-flow, `/punch`, approve — and asserts the merged outcome via the SQL oracle **and** the real HTTP read path:

- With **both** merge keys on, on one workday seed an internal punch pair + an approved-outdoor punch pair, then:
  - `first_in_at` = the **internal** 09:05 (`internalWinsOnIn`), `last_out_at` = the **outdoor** 18:30 (`externalWinsOnOut`) — the merge *window* is asserted **exactly**; `work_minutes` is `computeMetrics` over that window (asserted **≤ 565**, since a staging break rule may deduct — the un-merged window would be 610);
  - the four `attendance_events` are **unchanged** (the merge never rewrites events);
  - `GET /records` and `GET /summary` **follow** the recomputed record (`/summary` assert is `is_workday`-aware).
- It restores the original settings and SQL-deletes its own (uniquely-named) user rows → **residue 0**.

**Not re-proven here** (already locked by the merged real-DB integration suite #2333/#2336): default keys-off ≡ no change; the §5.11/§5.12 record-only import/override protection (first + last). S2-3 is the *staging* gate, not a re-run of unit coverage.

## Prerequisites

1. **Staging runs a main build containing #2344 (`7542d3679`).** The script fails fast at step 0b if `punchPolicy.merge` does not round-trip through PUT/GET settings — that means the deployed bundle predates #2333/#2344. Verify the deployed bundle fingerprint / migration state first (staging does **not** auto-mirror `main` pushes).
2. **A token for the smoke subject — which must be a *throwaway* user.** The smoke mints a per-user **dev-token** for a fresh synthetic user (`s2merge-<suffix>`) and uses that one token for everything — punch, settings, approve, reads — including self-approving its own outdoor requests (the proven comp-leave-smoke pattern). The token's own user **is** the subject (punches are attributed by the JWT id; `x-user-id` is only a last-resort fallback, so an admin token can't punch as a third party).
   - **Safety guards (enforced by the script):** cleanup blanket-deletes `WHERE user_id = <subject>`, so the subject must be disposable. The script **refuses** a subject that is not `s2merge-`-prefixed unless you set `ALLOW_NON_SYNTHETIC_SMOKE_USER=1` (**dangerous** — it would delete that user's real attendance), and when you supply `SMOKE_TOKEN` it decodes the JWT and **aborts unless its subject == `SMOKE_USER_ID`**.
   - If staging **disables dev-token** (`NODE_ENV=production` → `/api/auth/dev-token` 404), mint a `SMOKE_TOKEN` **for a synthetic `s2merge-…` user** (admin role + `attendance:read,write,admin`, staging `JWT_SECRET`) — **not** a real admin — and set `SMOKE_USER_ID` to that synthetic id. Adapt `scripts/ops/resolve-attendance-smoke-token.sh` (which mints inside the staging backend container) to use a synthetic `id` rather than picking a real admin row.
3. **`DATABASE_URL`** pointing at the staging postgres — used to read assertions and to DELETE the (uniquely-named) smoke user's rows on cleanup (there is **no** DELETE API for `attendance_events`/`attendance_records`).
4. **`pg` resolvable** — run from the repo root (or set `NODE_PATH`).
5. Reachability to staging API + DB (e.g. on the host, or through the tunnel).

## Run

```bash
# Default path (staging allows dev-token): the smoke mints its own subject token.
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
node scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs

# Fallback (dev-token disabled, NODE_ENV=production): supply a token + its subject.
BASE_URL=… DATABASE_URL=… SMOKE_TOKEN='<staging-admin-jwt>' SMOKE_USER_ID='<that-token-subject>' node …
# optional: ORG_ID=default (default)  WORK_DATE=2026-06-01 (default = 7 days ago, nudged off the weekend)
```

The smoke is **self-contained and reversible**: it acts on a uniquely-named subject user (`s2merge-<suffix>`, or the `SMOKE_USER_ID` you pass), one token both punches and self-approves for that subject, and the `finally` block always restores settings + cleans up.

## Expected output

```
S2-3 in/out-merge staging smoke @ http://127.0.0.1:8082  (user s2merge-…, workDate …, stamp s2-merge-…)
  PASS  auth: GET settings 200 (got 200)
  PASS  S2 deployed: punchPolicy.merge round-trips through PUT/GET
  PASS  create outdoor approval flow (status 200)
  PASS  enable merge keys + outdoor approval (status 200)
  PASS  outdoor punches → pending requests (in 202, out 202)
  PASS  outdoor punches returned request ids
  PASS  internal punches recorded (in 200, out 200)
  PASS  approve both outdoor requests (in 200, out 200)
  PASS  record exists for the smoke user/day
  PASS  first_in_at = internal 09:05 (internalWinsOnIn)
  PASS  last_out_at = outdoor 18:30 (externalWinsOnOut)
  PASS  work_minutes counted from the merged window (≤565; un-merged would be 610)
  PASS  attendance_events are exactly the 4 punched events (no rewrite by the merge)
  PASS  GET /records read path reflects the merged record
  PASS  GET /punch/events returns the 4 events
  PASS  GET /summary follows the record (is_workday=… → total_minutes = the record's work_minutes)
--- restore + cleanup ---
  settings restored
  PASS  cleanup residue = 0 (events 0, records 0, requests 0)

=== PASS — 17 passed, 0 failed ===  stamp s2-merge-…
```

## On PASS → close out S2

Flip the tracker row in `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` from **🟡** to **✅**, and add a dated 回填 with the stamp, e.g.:

> **回填（YYYY-MM-DD S2-3 staging closeout）**：内外勤卡合并 staging smoke PASS（stamp `s2-merge-…`，deploy `<sha>`）：both keys on → first_in=internal 09:05 / last_out=outdoor 18:30（窗口精确）/ work_minutes=<实际值>（≤565）/ summary=record work_minutes；4 events 未变；GET /records + /summary 跟随；settings restored；cleanup residue=0。S2（S2-0 #2329 → S2-1 #2333 → fix #2336 → S2-2 #2344 → S2-3 staging）闭环 ✅。

## On FAIL → triage

- **0b fails** (merge not round-tripping) → the deployed build predates #2344; redeploy a main build with `7542d3679` before re-running.
- **outdoor punch ≠ 202** → check `punchPolicy.outdoor.requireApproval=true` landed and the approval-flow id is valid (the smoke creates one); a 200 here means it went the internal path (meta.outdoor not honored).
- **approve ≠ 200** → the flow/instance wiring; confirm the admin token has `attendance:approve`/`attendance:admin`.
- **first_in/last_out wrong** → if `first_in_at=08:50`/`last_out_at=19:00` (the natural earliest/latest), the merge did not fire — re-check both keys are on in settings and that the outdoor events carry `source='outdoor_approval'` (S2-0).
- **residue ≠ 0** → inspect/clean the `s2merge-<suffix>` user's rows manually; the run is otherwise non-destructive to other data.

## Safety

- Touches only a uniquely-named smoke user; restores settings and deletes its own rows in `finally` (even on abort).
- Read-only against everything except the smoke user's own punch/request/record rows + the temporary approval flow it creates.
- Does not deploy or restart anything — that's a separate operator step before running.
