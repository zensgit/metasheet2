# Remainder Closeout — Development & Verification (2026-06-19)

> Status: **CLOSEOUT LEDGER for the current session's lanes.**
> Grounding: `origin/main` (live-main, 2026-06-19) @ `e5dc7cf9f` (rebased post-#2888 review; includes #2887 / #2889 / #2891 / #2892 landed after the original `33db39688` snapshot).
> Purpose: single current source-of-truth for "what planned development is verified-complete on `main`" vs. "what is gated/owned and therefore NOT startable here without an explicit per-gate owner opt-in." Produced as the development + verification deliverable for the standing goal *"根据计划完成我们剩余的开发，完成后给出开发及验证 MD."*
> Rule: every item in the **Gated / Owned** column is a separate explicit opt-in. This doc does not open any gate; it routes them.

---

## 0. One-line answer

Across every lane this session owns, the **non-gated** planned development is **complete and on `main`** — including B1-S1 `send_notification` (D0-A), which is already merged via #2768 (see §5; it was briefly mis-scoped as "pending" because its design-lock PR #2711 is still OPEN). The only forward work is (a) one **owner-run** smoke I cannot execute, (b) enumerated B1 follow-on slices that are each a separate gated opt-in, and (c) lanes actively owned by other sessions.

---

## 1. Complete vs. Gated boundary (the artifact)

| Lane | On `main` (verified-complete) | Remaining → who / what unblocks |
|---|---|---|
| **Attendance · annual-leave engine** | **L0–L4 engine + L5a/L5b/L5c UI/ops + `/me` self-service** (endpoint #2850 + employee overview card #2853); design+verification MDs | **Owner-run L6 staging smoke** (sandbox cannot reach `142.171.239.56` / `23.254.236.11`) — the deployed-bundle round-trip is the **sole remaining gate**; code + docs are complete, but L6 itself is **not yet run**. |
| **Multitable · 2a** live-CRDT scalar set | Full scalar set collaborative incl. `select`/`date` (#2832), `duration` (#2838), `dateTime` (#2849). **CLOSED.** | None. Future scalar/AI rings = Appendix-A pool (separate opt-in). |
| **Multitable · 2b** #18 phase-2 rule engine | S1 parser/evaluator (#2836), S2 read-deny enforcement (#2841), S3 authoring UI/API (#2847), S4 content-keyed parse cache (#2861). **COMPLETE S1–S4.** | None planned. |
| **Multitable · 2c** Person → org-member directory | Source = B (design-lock #2860); S2 resolver (#2866); S3a directory endpoint (#2867); S3b picker wired (#2869); S4 inactive/historical cell+summary cue (#2874). **COMPLETE.** | None. Picker-**chip** historical affordance (#2877) was **closed not-landed** — supplementary optional polish; S4 bar already met by #2874. |
| **Button-action track (B1)** | **All shipped on `main`** (per-item proof in §5): `send_notification` (#2768, D0-A), `update_record` (#2806, D0-B no-elevation), `record_click` (inert), and **B1-e** drawer rendering (#2716) — `BUTTON_ACTION_POLICIES` has all three live; grid + drawer both run them. | **Sole remainder = `send_webhook`** — absent from the policy table, no design-lock doc; a gated high-risk egress arc (credentials + delivery records, design-lock §8) that needs a design-lock + owner security review before any runtime. The design-lock #2711 was a stale-OPEN doc → closed-as-superseded by #2768. See §5. |
| **Integration · S1a / S1b** target-write lifecycle | (advancing on `main`: #2872 / #2876 / #2882 / #2884; **S1b-1 #2887** pluggable C6 write-source profile, **S1b-2 #2892** multitable raw write-source/profile) | **Owned by a parallel session** (worktree `ms2-s1b1`). Not startable here — collision risk. |
| **Approval · dept_head / continuous-managers** | (advancing on `main`: #2871 / #2873 / #2880) | **Owned by a parallel session** (worktree `contmgr`). Not startable here. |

**Net:** the active remainder for the multitable gated-remainder ledger is **EMPTY** (confirmed by `multitable-gated-remainder-development-plan-20260618.md` on `main`, and #2878 "all planned development done"). The attendance lane is **code+docs complete**, gated only on an owner-run smoke. B1-S1 — the lane this session's branch belongs to — is **already shipped on `main` (#2768)**, not a buildable remainder; its follow-on slices (§5) are separate gated opt-ins.

---

## 2. Verification — Attendance `/me` self-service (the slice built this session-arc)

### 2.1 Security property (the load-bearing one)

The `/me` endpoint's subject must be **un-overridable** — an employee may read only their *own* annual-leave balance, never another user's, regardless of params or headers.

On `main` @ `e5dc7cf9f`, `plugins/plugin-attendance/index.cjs` (route at L37884):

- Guard `withPermission('attendance:read')` (employee scope, not admin).
- Subject `const userId = getUserId(req)` → **401** if null. Once `attendance:read` passes, `req.user.id` is set from the verified token, so the spoofable `x-user-id` header never overrides it.
- **No `userId` field in the zod schema** (only optional `leaveTypeCode` / `eventLimit`) → there is no parameter through which to request another subject.
- Org is **pinned from the token**: `req.user?.orgId ?? req.user?.workspaceId ?? getOrgId(req)` — a `?orgId` param/header cannot redirect `/me` at another org; `getOrgId` is only a fallback for a token carrying no org.
- Reuses the shared `readAnnualLeaveBalanceForUser(...)` helper → identical explainable shape to the admin L5a read, scoped to self.

### 2.2 Tests on `main` (presence + assertion shape)

- **Backend integration** — `packages/core-backend/tests/integration/attendance-plugin.test.ts` L5432: employee token seeds caller + a distinct other user; asserts `/me` → caller; `?userId=<other>` → **still caller**; `x-user-id: <other>` header → **still caller**. The param-spoof and header-spoof are both locked.
- **Front-end** — `apps/web/tests/attendance-admin-regressions.spec.ts` L836: overview self-service card `[data-selfservice-card="annual-balance"]` reads the token-locked `/me` balance (no `userId` param) and renders `remaining`; crash-guard accepts only `data.data && data.data.summary`.

### 2.3 Verification method & honest limits

- **Method here:** on-`main` code + test **presence** (line-cited above) plus the **merged-PR CI-green** record for #2850 and #2853 (both squash-merged with their suites green).
- **Not re-run locally this turn, by design:** the backend integration suite needs a live DB/`baseUrl` not reachable from the sandbox; and a fresh `pnpm install` in a new worktree risks the fork-exhaustion churn that would also degrade the parallel sessions sharing this working tree. Re-running already-green CI tests is belt-and-suspenders; the disciplined choice under these constraints is to not trigger that risk.
- **Owner-run only:** the **L6 staging smoke** (deployed-bundle round-trip on staging) is the one verification I cannot perform — it is the sole remaining gate on the attendance lane.

---

## 3. Verification — Multitable 2a / 2b / 2c

These lanes were driven to closure (some by parallel sessions) and are **documented complete on `main`** by the live ledger `docs/development/multitable-gated-remainder-development-plan-20260618.md`, which states the active remainder is **EMPTY**. Evidence = the merged PR set cited in §1 (2a #2832/#2838/#2849; 2b #2836/#2841/#2847/#2861; 2c #2860/#2866/#2867/#2869/#2874) plus the closeout commits #2878/#2881/#2883/#2885. No 2a/2b/2c runtime item remains; the only related residue was the **optional** picker-chip polish #2877, **closed not-landed**.

---

## 4. What is explicitly NOT in scope here (and why)

- **Appendix-A future roadmap pool** (server-side all-dataset export; form `required-if`; dashboard linked-filters/drill-down/missing-date buckets; grid virtualization — already excluded by the D2 perf verdict; AI rings beyond base; native synced/external tables; FOL deep follow-ups; automation A6 remainder). Each needs its **own** plan/TODO and opt-in.
- **Integration S1a/S1b** and **Approval dept_head** — **another session's lanes**. Building them here would collide on the shared account/tree.

---

## 5. Button track (B1) — per-item verification on `main`

Authoritative single-pass audit of `BUTTON_ACTION_POLICIES` (`packages/core-backend/src/routes/multitable-button.ts`) + each action's FE surface (grid **and** record drawer). The design-lock #2711 being OPEN made this track *look* unbuilt; checked against `main`, it is almost entirely shipped. **Lesson: a design-lock PR's OPEN state ≠ the feature unbuilt — verify against `main`.**

| Action | State on `main` | Proof |
|---|---|---|
| `record_click` | shipped (inert / logger-only / no persistent row) | policy line 84 |
| `send_notification` (B1-S1 **D0-A**) | **shipped** — in-app sink (durable rows on `meta_record_subscription_notifications`, CHECK widened to `notification.sent`; Bell inbox), server-enforced confirm, dedicated `canSendNotification` gate, §3.1 recipient hard-reject (`loadSheetMemberUserIdSet`), requestId at-most-once dedup, fail-closed durable audit (`triggered_by='button'`, excluded from DF-N1, retrievable by id) | **#2768** `b636aecd6`; policy line 85; tests backend 3465/3465 + FE 25/25 + real-DB in `plugin-tests.yml` |
| `update_record` (B1-S1 **D0-B**) | **shipped** — first record-mutating button action; `edit` sheet-gate **plus** per-row re-gate (write-own + lock) so a button can't mutate a row the clicker couldn't edit directly (no elevation) | **#2806** `bbd1787a9`; policy line 83; real-DB no-elevation tests |
| `send_webhook` | **NOT built** | absent from `BUTTON_ACTION_POLICIES`; unknown actionType → `400 BUTTON_ACTION_NOT_ENABLED` |
| **B1-e** drawer rendering | **shipped** — `field.type === 'button'` rendered in the record-detail drawer; emits `run-button`, routed to the same secured `client.runButton` as the grid | **#2716** `01a777eac`; `MetaRecordDrawer.vue:266/274`, `MultitableWorkbench.vue:683` (`@run-button` line 313), spec `multitable-workbench-drawer-button-wiring.spec.ts:201` |

**The sole remaining button-track item is `send_webhook`** — and it is a **gated, high-risk egress arc**: real outbound HTTP with credentials + delivery records (design-lock §8 explicitly carves it out as its own reviewed action). It MUST NOT be built as runtime unprompted; the responsible first step is a **design-lock for review** (contract-only), with runtime gated on owner security sign-off — the same path #2768 went through (owner REQUEST-CHANGES). (`dingtalk-v1-delivery-buttons-*-20260421` on `main` is a *separate, older* DingTalk delivery-button track, not the multitable `send_webhook` action.)

**Hygiene done this turn:** the stale-OPEN design-lock #2711 is closed-as-superseded (its doc + impl are already on `main` via #2768).

---

## 6. Bottom line

- **Verified-complete on `main` (per-item proof):** attendance `/me` (#2850/#2853); multitable 2a (`useYjsScalarCell.ts`, #2832/#2838/#2849), 2b (`permission-rule-evaluator.ts`, #2861), 2c (`person-field-restriction.ts`, #2866) — live in code, not doc-asserted; **button track** `send_notification` (#2768), `update_record` (#2806), `record_click`, **B1-e** drawer (#2716).
- **Remaining:** **gated** — owner-run L6 staging smoke (attendance); `send_webhook` button action (high-risk egress, design-lock-first then owner security sign-off); Appendix-A pool; parallel-session lanes (integration, approval).
- **No buildable non-gated remainder exists.** Every planned non-gated item is already merged. The honest "remaining development" is the gated set above; the only one with a safe forward first-step this session is the **`send_webhook` design-lock** (contract-for-review, runtime stays gated). Hygiene done: design-lock #2711 closed-as-superseded.
