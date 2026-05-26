# Comprehensive-Hours Reporting V1 — Staging Acceptance Runbook

Operator procedure to verify comprehensive-hours **reporting V1** (value-plumbing, #1833) on
a real stack after a staging deploy. It is staging-only, read-only-first, fail-closed, and
fully reversible (the one settings change is restored at the end). First proven 2026-05-26
(`docs/development/attendance-comprehensive-hours-pr6-staging-acceptance-20260526.md`).

## When to run

- After deploying a build that includes #1833 to a staging/test backend, to confirm the
  cap → resolver → period sync → multitable snapshot path works end-to-end.
- Not against production. No code changes are part of this procedure.

## Prerequisites

- A staging **admin** JWT minted against that environment's `JWT_SECRET` (staging uses a
  distinct secret from prod — a prod token returns `401 Invalid token`). Store it in a
  `0600` file; never paste it into chat or a ticket.
- The staging backend deployed to `main` **including #1833** (the staging deploy lane does
  not auto-mirror `main` — confirm the deploy explicitly).
- **Migration alignment:** staging postgres may trail prod-track. If it is behind, the report
  objects / multitable provisioning can be unavailable and the sync returns `degraded`.
  Apply pending migrations as part of the deploy.

## Secret hygiene

Keep the token in files only — never on a command line (it would show in the process list /
shell history). Build a curl header file without the token touching `argv`:

```bash
JWT=/path/to/staging-admin.jwt          # 0600
{ printf 'Authorization: Bearer '; cat "$JWT"; } > /tmp/stg-hdr && chmod 600 /tmp/stg-hdr
# then: curl -s -H @/tmp/stg-hdr ...
# at the end: rm -f /tmp/stg-hdr
```

If the token is ever exposed (e.g. pasted into chat), deleting local files is not enough —
**invalidate/rotate it server-side**.

Set once: `BASE=http://<staging-host>:<port>` (e.g. the staging backend).

## Gates — run read-only first; STOP if any is red

| Gate | Command | Pass |
| --- | --- | --- |
| G1 — JWT valid | decode the JWT payload, check `exp` > now | not expired; `roles` includes `admin` |
| G2 — auth | `curl -s -H @/tmp/stg-hdr "$BASE/api/auth/me"` | HTTP 200, `data.user.role=admin`, `data.features.attendanceAdmin=true` |
| G3 — #1829+ deployed | `curl -s -H @/tmp/stg-hdr "$BASE/api/attendance/settings"` | 200 **and the body carries `data.comprehensiveHours.capDefaults`** |

G3 is the deploy discriminator: #1829+ always returns `comprehensiveHours.capDefaults` (added
to `DEFAULT_SETTINGS` + the normalizer). **If that key is absent, the backend predates #1829**
(so also lacks #1833) — stop and redeploy. The route is `PUT/GET /api/attendance/settings`
(`plugins/plugin-attendance/index.cjs:27963`/`:27981`).

## Acceptance steps

Pick a **test user** (`TARGET=<userId>`; the admin's own id is fine) and a date range that is
an **exact natural calendar month** (e.g. `2026-04-01`..`2026-04-30`) so the period-type bridge
resolves to `month`. Note: `UID` is a reserved shell variable — use `TARGET`.

1. **Save original settings** (for restore):
   `curl -s -H @/tmp/stg-hdr "$BASE/api/attendance/settings" -o /tmp/stg-orig.json`
   Record `data.comprehensiveHours.capDefaults`.
2. **PUT a test cap** (partial body → deep-merge preserves the other cycle-types):
   `curl -s -X PUT -H @/tmp/stg-hdr -H 'Content-Type: application/json' -d '{"comprehensiveHours":{"capDefaults":{"month":600}}}' "$BASE/api/attendance/settings"`
   → 200, saved `{month:600, quarter:null, year:null}`.
3. **GET confirm** `capDefaults.month == 600`.
4. **Run the period sync** (single user, natural month):
   `curl -s -X POST -H @/tmp/stg-hdr -H 'Content-Type: application/json' -d "{\"userId\":\"$TARGET\",\"from\":\"2026-04-01\",\"to\":\"2026-04-30\"}" "$BASE/api/attendance/report-period-summaries/sync"`
   → `data.created>=1` (or `patched`), **not** `degraded`, `periodType=date_range`. Capture `data.multitable.sheetId`. Route at `index.cjs:27746`.
5. **Read the snapshot row back.** The record `data` is keyed by physical `fld_*` ids, so fetch the field schema to map ids → names:
   - `curl -s -H @/tmp/stg-hdr "$BASE/api/multitable/fields?sheetId=$SHEET"` → map `id`→`name`.
   - `curl -s -H @/tmp/stg-hdr "$BASE/api/multitable/records?sheetId=$SHEET&limit=10"` → record under `data.records[].data`.
   - Confirm the **four** comprehensive-hours columns are present:

     | Field name | Logical code | Expected |
     | --- | --- | --- |
     | 综合工时超额（分钟） | `comprehensive_hours_excess_minutes` | `max(0, actualMinutes − cap)` (0 if the user has no attendance in the period) |
     | 综合工时上限（分钟） | `comprehensive_hours_cap_minutes` | `600` |
     | 综合工时上限来源 | `comprehensive_hours_cap_source` | `org_default_by_cycle_type` |
     | 综合工时上限版本 | `comprehensive_hours_cap_effective_key` | `cfg:<hash>` |
6. **Idempotency + cap-change re-sync** (behavioral proof the cap is fingerprinted):
   - Re-run step 4 with the cap unchanged → `skipped=1` (source_fingerprint match).
   - `PUT` cap `month:900`, re-run step 4 → `patched=1`; re-read the row → `cap_minutes=900` and a **new** `cap_effective_key`. (Pre-#1833 code would `skip` here, since the cap would not be in the fingerprint.)
7. **Restore original settings:**
   `curl -s -X PUT -H @/tmp/stg-hdr -H 'Content-Type: application/json' -d '{"comprehensiveHours":{"capDefaults":{"month":null,"quarter":null,"year":null}}}' "$BASE/api/attendance/settings"`
   then `GET` and confirm it matches `/tmp/stg-orig.json`. Finally `rm -f /tmp/stg-hdr /tmp/stg-orig.json`.

## Pass criteria

All gates green; step 4 non-degraded with a row created/patched; step 5 shows all four columns;
step 6 shows skip-when-unchanged and patch-on-cap-change with a changed `effective_key`; step 7
restores the original settings.

## Interpretation / troubleshooting

- **`degraded` with `MULTITABLE_*_UNAVAILABLE`** → staging multitable/provisioning not ready (often the migration gap). Env issue, **not** a #1833 defect.
- **G3 missing `comprehensiveHours`** → backend predates #1829; redeploy.
- **`excess_minutes = 0`** → the test user has no attendance in the period (`actual 0 < cap`). The non-null cap companion fields still prove the write; use a data-bearing user to exercise `excess > 0`.
- **`401 Invalid token`** → expired token, or a non-staging token (distinct `JWT_SECRET`). Mint a fresh staging token.
- **`custom_range`/`payroll_cycle` periods** → the cap resolves to null by design in V1 (the four columns stale-null). Use an aligned natural month/quarter/year `date_range`.

## Cross-references

- `docs/development/attendance-comprehensive-hours-reporting-closeout-20260525.md` — capability closeout.
- `docs/development/attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md` — #1833 design + mock-level verification.
- `docs/development/attendance-comprehensive-hours-pr6-staging-acceptance-20260526.md` — the first executed acceptance (evidence).
- `docs/development/attendance-comprehensive-hours-cap-policy-persistence-design-20260525.md` — cap resolver + period-type bridge.
