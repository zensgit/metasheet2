# DingTalk Sync Hardening v1 — Runtime-Closeout Design & Verification

Date: 2026-07-13
Scope: the closeout of **DingTalk Sync Hardening v1** to a *runtime-closed* state (DT-CLOSE-01…05),
and the forward plan for the SECOND, separate milestone (Canonical Org & Provider Transfer v1).

## 0. Two milestones — do NOT conflate

Per the owner's judgment, the DingTalk line is **two milestones**, never one "钉钉线收官":

1. **DingTalk Sync Hardening v1** — code basically complete; this document takes it to **运行态收官**
   (runtime-closeout). **Runtime-closeout is still BLOCKED, not done** (owner review 2026-07-13; status
   as of 2026-07-13): OAuth-stability *metrics* observability is **NOT yet restored**. DT-CLOSE-01B
   (**#4253**, OPEN, unarmed) only teaches the check a metrics-only *verdict* — decoupled from the
   undeployed Alertmanager+webhook alert-delivery topology, which stays **deferred by design**, not
   restored. Actually restoring the metric additionally needs: (a) an OAuth state-metrics *producer* —
   `metasheet_dingtalk_oauth_state_operations_total` currently has **no producer anywhere on `main`**
   — only the check script that reads it (`git grep` on `origin/main` finds zero emitters); a separate
   producer PR is required and has not landed; (b) both the producer and #4253 deployed together; (c)
   consecutive green live runs (ops). Deploy templates are reproducible, switches are *ruled* (owners
   still `_TBD_` in the ledger), UAT is scaffolded (not executed).
2. **Canonical Org & Provider Transfer v1** — **design done** (#4215 / #3944 landed), core impl **not
   started**; its MVP sequencing is a separate plan (see §4). It starts only after milestone 1 closes.

## 1. What runtime-closeout means (why code-complete ≠ closed)

Hardening v1's *code* is on main, but three runtime facts kept it from being closed: the OAuth-stability
**monitor was blind** (401 on a now-token-gated metrics scrape), the deploy was **not reproducible**
from templates (the switches the code reads weren't in any `.env` template), and the **switch decisions
+ real UAT** weren't recorded. DT-CLOSE-01…05 close exactly those.

## 2. Deliverables (DT-CLOSE-01…05)

*State column reflects GitHub PR status as of 2026-07-13 — re-check `gh pr view <N>` before relying on
an OPEN/unarmed row, since those can change after this date.*

| Ticket | What | PR | State | Model |
| --- | --- | --- | --- | --- |
| **DT-CLOSE-01** | Authenticate the OAuth-stability `/metrics/prom` scrape — token resolved on the deploy host (backend-container runtime, secret-safe), `x-metrics-token` header, unauth fallback; contract test that reddens if auth is removed | **#4236** | ✅ **MERGED** `cd1a36428` | me (Opus care — auth) |
| **DT-CLOSE-02** | DingTalk env contract — every closeout key in `docker/app.env.example` + staging with code-accurate default + DANGER comment; contract test: missing-key → red, dangerous switch shipped ON → red | **#4240** | ✅ **MERGED** `31ff515f8` | Sonnet + Opus gate |
| **DT-CLOSE-03** | Real-enterprise UAT evidence-pack scaffold — default-off smoke, U1–U13, real-callback corp-anchor, values-free rules | **#4241** | ✅ **MERGED** `3385adab7` (owner/ops still executes the UAT itself) | Sonnet |
| **DT-CLOSE-04** | Switch-ruling ledger — every switch = explicitly-deferred or must-verify-enabled + rollback + owner; no unowned default-off | **#4241** | ✅ **MERGED** `3385adab7` | Sonnet |
| **DT-CLOSE-05** | Consolidated-MD status errata — #159 CLOSED, #4218/#4228 MERGED, #4176 superseded; reaffirm two-milestone split | **#4241** | ✅ **MERGED** `3385adab7` | Sonnet |
| **DT-CLOSE-01B** | *(owner review)* metrics-only downgrade — the check hard-depended on an undeployed Alertmanager+webhook topology (all 4 scheduled runs failed `curl (7) :9093`); soft-defer the topology + decouple the verdict from it; behavioral contract test (re-coupling reddens) | **#4253** | **OPEN, unarmed** — under continued owner review (as of 2026-07-13); not merged | me (Opus care) |
| **DT-CLOSE-02B** | *(owner review)* retention correction — the docs conflated GROUP-webhook retention (`dingtalk_group_deliveries`) with approval-card retention; corrected templates/U11-b/ledger/MDs; a first pass also wrongly filed the already-implemented, disabled-by-default `DINGTALK_DELIVERY_RETENTION_*` card/person family (#4142) as a non-existent gap — corrected here; fixed the ledger's stale pre-#4240 "in template?" column | **#4255** | this PR | me |

**Owner review (2026-07-13) — runtime-closeout is BLOCKED, not done.** Two findings: (1) the OAuth
monitor was still failing post-#4236 because it required an undeployed alert topology → **DT-CLOSE-01B**;
(2) the env contract's DANGER comment mislabeled `DINGTALK_GROUP_DELIVERY_RETENTION_*` as
approval-card retention when it only touches the group-webhook ledger; the actual approval-card/
person family (`DINGTALK_DELIVERY_RETENTION_*`, #4142) is a **separate, already-implemented,
disabled-by-default** control that the templates/ledger/docs failed to reference at all →
**DT-CLOSE-02B**. Both are addressed here. The remaining
closeout is genuinely owner/ops (assign the ledger owners, deploy the exact SHA, run U1–U13 + the
real-callback anchor, record each switch's ruling) — only then does Hardening v1 become DONE and
unlock Milestone-B's local-provider bootstrap.

## 3. Verification — VERIFIED vs OWNER/OPS-GATED (kept separate)

### 3.1 VERIFIED (code, this session)

- **DT-CLOSE-01**: `bash -n` clean; contract test 4/4; **auth-mutation reddens** (reverting to the bare
  scrape fails the test); CI-wired.
- **DT-CLOSE-02**: contract test 6/6; **two mutations redden** (missing key; dangerous switch shipped
  `=true`); CI-wired alongside DT-CLOSE-01. Every template default was checked against the code default
  by the Opus gate.
- Both lanes passed an independent **Opus adversarial gate** — overall APPROVE, no P1/P2; the one P3
  (value-drift) is addressed for the dangerous-switch class.

### 3.2 OWNER/OPS-GATED (this environment cannot produce)

| Item | Why not here | Ticket |
| --- | --- | --- |
| OAuth-stability "immediate + next scheduled run consecutive success" | needs the live deploy host + secrets | DT-CLOSE-01 (ops step) |
| Real-enterprise UAT U1–U13 + real-callback corp-anchor (does the callback carry `eventCorpId`/`corpId`?) | needs a deployed SHA + a real DingTalk corp + real people | DT-CLOSE-03 |
| Each switch flipped to "verified-enabled" | needs the UAT evidence above | DT-CLOSE-04 |

**Switch posture (encoded conservatively, per owner):** deprovision + primary-dept inference + Stream
stay **OFF** (each with its exact flip-precondition in the ledger); OAuth shared-state **must be ON** on
multi-replica; the GROUP-delivery retention window sized for group-delivery diagnostic/audit needs (NOT an approval-SLA coupling — DT-CLOSE-02B corrected that; the separate approval-card/person `DINGTALK_DELIVERY_RETENTION_DAYS` family is already implemented but disabled by default — must be set BEFORE enabling interactive cards, see ledger §1.2); interactive-card Stream only after U1–U13 all
green + the #4171 real-callback anchor proof.

## 4. Forward: milestone 2 (design landed, impl gated)

`docs/development/canonical-org-provider-transfer-v1-mvp-implementation-plan-20260713.md` (#4242)
sequences the landed #4215 / #3944 designs into gated MVP increments — Canonical Org MVP (bootstrap →
CRUD → normalized manager → binding FK chain → `(org,purpose)` routing → **approval-routing real-DB
parity first** → suggest-only reconciliation), then Transfer MVP (schema/API → source freeze → two-corp
proof → single-tx atomic rebind → group rebind/drop → workbench). Feishu/WeCom + full consumer migration
deferred. **Starts only after Hardening v1 closes.**

## 5. Definition of runtime-closeout DONE (Hardening v1)

- DT-CLOSE-01 + DT-CLOSE-01B merged + the (now metrics-only) live monitor shows consecutive successful runs (ops).
- DT-CLOSE-02 merged; a deploy is reproducible from the templates (contract-guarded).
- DT-CLOSE-03 evidence pack executed against the deployed SHA with U1–U13 + real-callback anchor (owner/ops).
- DT-CLOSE-04 ledger: every switch owned (verified-enabled or explicitly-deferred), never an unowned default-off.
- DT-CLOSE-05 docs accurate.

Items 1–2 + the docs are delivered here; items requiring the live host / a real corp are handed to
owner/ops with the scaffolding to execute them. **Hardening v1 is at runtime-closeout stage — not "all
done", and explicitly separate from milestone 2.**
