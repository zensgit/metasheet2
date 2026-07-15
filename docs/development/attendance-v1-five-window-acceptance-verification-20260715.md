# Attendance v1 — Five-Window Staging Acceptance: Verification Record (2026-07-15)

> Executes owner steps 2-4 & 7 of the 2026-07-14 close-out sequence. All five staging smokes
> PASSED serially on ONE deployed SHA with per-smoke and consolidated residue=0. Remaining
> pre-close items (§6) are the owner-side steps: manual AE-3 modal evidence, DingTalk
> S1-S8/U1-U13 (esp. U11-a), 关闭 issue-3317, release tag.

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

## 3. The five windows (owner step 4) — all PASS, one SHA, serial per bundle §4

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

## 5. Consolidated close (owner step 7)

- Consolidated final-state capture: run 29391832015 (`action=status` — settings + container
  state archived).
- Strict-gate rerun (prod): run 29391835742 — **overall SUCCESS** (all gates green); prod carries the frozen
  window SHA as an ancestor (prod auto-deploys per merge; the staging window itself stayed
  pinned to `d65a77c25` throughout).
- Tracker backfilled in the same PR (single edit, all five stamps).

## 6. Remaining before 关闭 issue-3317 + tag (owner steps 5-6, 8)

1. **Manual AE-3 modal browser evidence** — requires the owner's logged-in in-session browser
   (:8082); the AE-4 harness explicitly refuses to claim the UI PASS. Sanitized screenshots
   to be attached to #3317.
2. **DingTalk S1-S8 / U1-U13** — esp. U11-a real corp-anchor callback; B1 explicitly NOT in
   v1 (owner ruling).
3. Owner review of this record → 关闭 issue-3317 → release tag (suggested tag point:
   `d65a77c25`, the SHA every stamp names).

After those: the owner's declaration per the 2026-07-14 ruling — attendance v1 development,
DingTalk E1-E4 integration, and production acceptance closed; B1/S7/飞书/native-hardware → vNext.
