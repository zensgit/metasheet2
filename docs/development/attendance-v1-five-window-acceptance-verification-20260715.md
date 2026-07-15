# Attendance v1 — Five-Window Staging Acceptance: Verification Record (2026-07-15)

> **FINAL ACCEPTANCE (owner 2026-07-15):** all five API/DB helper smokes, the required manual
> browser probes, the owner-decision items, the real DingTalk channel proof, and the consolidated
> residue sweep are complete. The five final `*_STAGING_SMOKE_PASS` stamps are recorded in §6.

> The window ran serially on one frozen deploy SHA. Every helper-scoped cleanup reported
> `residue=0`; the final consolidated sweep independently reported 29/29 zero counts.

## 1. The frozen window

- **DEPLOY_SHA (frozen): `d65a77c250d74143e6671cc424deb7319eadeb51`** — staging backend+web
  images pinned to this full-SHA tag; identity proven via the dual-channel verifier
  (health metadata is env-pinned stale on staging — L6 precedent — so identity = exact
  container image-tag match + health `ok:true`).
- Deployed with the RD window env (`ATTENDANCE_SCHEDULER_ENABLED=true`,
  `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true`, `ATTENDANCE_REPORT_DIGEST_ENABLED`
  UNSET) flipped together with the deploy per bundle §3.4. Deploy run: 29376418862
  (migrations `Pending: 0`, auth round-trip 200/200).
- No attendance feature changes rode into the window: every post-freeze merge was
  verify-tooling/harness or other-line work (each landed through head-scoped adversarial
  gates, review ledger `/tmp/pr4271-review-claude-20260714.md`, rounds 1-25).

## 2. Migration alignment (owner step 2 proofs)

Run **29376184845** (`action=migrate`, after two fail-closed attempts hardened the tooling):
- **Backup**: `pg_dump -Fc` retained ON-HOST at
  `/home/mainuser/window-runner-backups/staging-20260714T232731Z-pre-migrate.dump`
  (sha256 `386ec57a…`, 45,766,188 bytes; never uploaded — public-repo artifacts are
  world-readable).
- **Clone rehearsal**: restored into `window_runner_rehearsal` under DB-level
  `session_replication_role='replica'` (a partition-inherited row trigger fires during COPY
  otherwise; `pg_restore --disable-triggers` was empirically proven inert for full restores —
  run 29347058494), 0 restore errors, rehearsal migrate 240→264 applied, `Pending: 0`.
- **Isolation proven channel-independently**: real DB applied-count `240 → 240` (unchanged)
  across the rehearsal migrate; guard defends even against a silently-ignored DSN override
  under non-env secret providers.
- **Apply**: real staging DB → `Pending: 0`; health + auth round-trip green.

## 3. The five API/DB helper smokes — all HELPER-PASS, one SHA, serial per bundle §4

| # | Window | Run | Stamp (verbatim) |
|---|---|---|---|
| 1 | AE-4 result-edit | 29383379748 | `AE4_RESULT_EDIT_API_DB_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=ae4-smoke-gh29383379748a1 org=default notifyRecord=d8381e2d-ba11-4393-9b88-bfab580704e2 skipRecord=896ce383-45d6-47fa-a17f-9911a598bd62 residue=0` |
| 2 | RD-4/5 report digest | 29383448054 | `RD45_REPORT_DIGEST_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=rd45-smoke-gh29383448054a1 org=rd45-smoke-gh29383448054a1-org produced=1 dedupOk=1 residue=0` |
| 3 | OT-bank v1-8 | 29383549381 | `OTBANK_V18_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=otbank-v18-smoke-gh29383549381a1 org=default cycle=cb5e7b71-7093-476d-9f2e-05f3a9211b25 residue=0` |
| 4 | MP-6 makeup punch | 29391693975 | `MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=mp6-smoke-gh29391693975a1 org=default quota=1 approvals=1 residue=0` |
| 5 | HMR-5 missed-punch reminder | 29391755628 | `HMR5_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=hmr5-smoke-gh29391755628a1 org=hmr5-smoke-gh29391755628a1-org sendPosture=worker-on:failed_recognized residue=0` |

Zero failed assertions in every passing run; each smoke snapshot+restored its own settings
keys (verified per-run in the artifacts: settings-before/after + in-log restore asserts).

## 4. Live-failure fixes made during the window (all verify-tooling/harness, gated, landed)

| Run that failed | Root cause | Fix |
|---|---|---|
| 29313154282 | staging repo dir unwritable by deploy user | #4275 override → per-run OUTPUT_DIR |
| 29314093729 | staging health metadata env-pinned stale (L6) | #4276 image-tag identity fallback (deploy) |
| 29340321213 | partition-inherited trigger fires during rehearsal COPY | #4284 (+#4291 after #4284's `--disable-triggers` was empirically falsified) → DB-level replica-role suppression |
| 29378042837 | smoke pre-check lacked the identity fallback | #4294 dual-channel smoke identity (exact-ref) |
| 29380129251 | AE-4 harness predates `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` | #4296 prepare→commitToken flow |
| 29383604023 | MP-6 harness sent attachment in body.metadata (server reads top-level) | #4301 top-level `attachmentUrl` |

Every failure was fail-closed (real staging DB untouched until proofs held); the owner's
"real acceptance = rerun the rehearsal" principle caught one plausible-but-wrong fix (#4284).

## 5. Consolidated close (owner step 7) — status

- Final-state capture: run 29391832015 (`action=status`).
- **§7 consolidated residue sweep: EXECUTED and GREEN** — run **29397485250**
  (`action=residue-sweep`, all five stamps): `CONSOLIDATED_RESIDUE_SWEEP result=ok
  nonzero=none`, **29/29 counts = 0**, env flags (`scheduler=true worker=true digest=<unset>`)
  and settings baseline archived in the same artifact. (First run 29395824577 already showed
  all 29 counts = 0 but false-FAILED on a harness stdout-capture bug, fixed in #4311.)
- Strict-gate rerun (prod): run 29391835742 — **overall SUCCESS**, executed at main
  `91d924fb1`, a successor of the frozen `d65a77c25`. **Equivalence record for owner
  acceptance**: `git diff --stat d65a77c25..91d924fb1` over `plugins/plugin-attendance/`,
  `packages/core-backend/src/`, and the attendance web views is EMPTY — the 13 intervening
  commits are attendance harness/ops fixes (#4294/#4296/#4301, scripts/ops only), owner docs
  ratifications (#4196/#4203/#4195/#4239/#4287), and multitable/web work
  (#4285/#4290/#4295/#4298/#4300). Zero attendance-runtime change. **Owner ACCEPTED the
  equivalence 2026-07-15 (21:15 local)** after independently comparing `d65a77c25..91d924fb1`
  and confirming the attendance-runtime diff is empty — no exact-SHA rerun required. Recorded
  here per the owner's instruction.
- Tracker backfilled in the same PR with both helper evidence and final acceptance stamps.

## 6. Final browser, owner-decision, channel acceptance, and stamps

### 6.1 Browser and operator evidence

- **AE-4 / AE-3 modal**: PASS in the logged-in staging browser. The result-edit modal opened
  from the anomaly surface and completed the required snapshot/write-path probe.
- **RD-4/5 config card**: PASS in the logged-in staging browser. The settings surface loaded
  and preserved the digest configuration contract.
- **HMR-5 confirm snapshot**: PASS in the logged-in staging browser. The selected-row snapshot
  remained stable through confirmation.
- **HMR-5 real channel**: the real DingTalk delivery `hmr-real-20260715154838` reached DB status
  `sent` on attempt 1 at `2026-07-15T15:48:40.303Z`; the owner confirmed receipt on the phone.
- **Cleanup**: the exact temporary attendance record and delivery were removed. The final check
  found zero `hmrRealChannel` synthetic records and zero matching delivery-queue rows. Sanitized
  browser evidence is retained operator-side; no credentials or recipient identifiers are
  committed to this public repository.

### 6.2 Owner-decision record

- **RD send proof**: `failed_channel_not_configured` is accepted by the canonical RD-4/5 runbook,
  whose final stamp explicitly permits `sent`, `failed_recipient_not_bound`, or
  `failed_channel_not_configured`. The real DingTalk delivery above independently proves the
  default-organization HMR channel; it does not rewrite the RD synthetic-organization outcome.
- **OT OQ-1 / OQ-2**: accept the compressed 600/300/900 pool replay; a full 176-hour
  payroll-month aggregate remains outside v1. The staging organization had zero non-synthetic
  users for this probe.
- **MP OQ-1 / OQ-3**: trusted runner subject-matched tokens are accepted. The deployed posture is
  single-tenant for attendance: one attendance organization and zero non-default attendance
  organizations.
- **DingTalk E4**: real-device micro-app login, deep-link return, and notification receipt were
  already accepted under #3843 (closed 2026-07-09). The HMR delivery above is an additional
  current-window channel proof. B1, S7, Feishu, and native hardware remain vNext/gated scope.

### 6.3 Final acceptance stamps

```text
AE4_RESULT_EDIT_STAGING_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=ae4-smoke-gh29383379748a1 org=default notifyRecord=d8381e2d-ba11-4393-9b88-bfab580704e2 skipRecord=896ce383-45d6-47fa-a17f-9911a598bd62 residue=0
RD45_REPORT_DIGEST_STAGING_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=rd45-smoke-gh29383448054a1 org=rd45-smoke-gh29383448054a1-org produced=1 dedupOk=1 sendProof=failed_channel_not_configured residue=0
OTBANK_V18_STAGING_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=otbank-v18-smoke-gh29383549381a1 org=default cycle=cb5e7b71-7093-476d-9f2e-05f3a9211b25 residue=0
MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=mp6-smoke-gh29391693975a1 org=default quota=1 approvals=1 residue=0
HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=hmr5-smoke-gh29391755628a1 channel=dingtalk residue=0
```

With this record merged, issue #3317 is eligible for closure and the release tag may point to
the exact accepted deploy SHA `d65a77c250d74143e6671cc424deb7319eadeb51`. This closes the
attendance v1 staging-acceptance window and DingTalk E1-E4 integration; it does not claim the
separately gated vNext items above are delivered.
