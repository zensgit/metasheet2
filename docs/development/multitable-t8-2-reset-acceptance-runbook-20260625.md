# T8-2 Reset-to-T — acceptance runbook (staging, pre-enablement)

Reset is the one **destructive** capability on the Global History / point-in-time-restore line: it reverts surviving
records to their state at **T** AND **soft-deletes records created after T into the recycle bin**
(`meta_records_trash` — recoverable, not a normal Revert). It ships behind a default-off flag
(`MULTITABLE_ENABLE_PIT_RESET`). This runbook makes the staging "enable-flag → verify behavior + error codes" a
one-click run, so the enablement decision rests on clean evidence — Reset has **no UI yet**, so this is API/harness
only.

Harness: `packages/core-backend/scripts/reset-acceptance.mjs` (Node ≥18, uses built-in `fetch`, no deps).

## Reset vs Revert (state this in any future UI, hard)
- **Revert** (T8-1, non-destructive): surviving records → their state at T; records created after T are **kept**.
- **Reset** (T8-2, destructive): same revert **plus** records created after T are **moved to the recycle bin**.
  Recoverable from trash, but it is *not* a normal restore — call it out unambiguously, with a typed confirm and a
  deleted-count echo, before any end user can trigger it.

## Scenarios

| # | Condition | Expected |
|---|---|---|
| a | flag **OFF**, reset-preview AND reset-execute | `403 RESET_DISABLED` (inert) |
| b | flag ON, **editor** (not sheet-admin) | `403` (D2 `canManageSheetAccess` gate) |
| c | flag ON, admin, execute **without** `confirm:'reset'` | `400` (D4 typed confirm) |
| d | flag ON, admin, a **locked** post-T target in scope | `409 RESET_BLOCKED`, **zero writes** |
| e | flag ON, admin, a record **created after the preview** (drift) | `409` (delete-set re-enumeration), nothing deleted |
| f | flag ON, admin, sheet **above** `MULTITABLE_SHEET_REVERT_MAX_RECORDS` | `413 SHEET_TOO_LARGE` |
| g | flag ON, admin, **happy path** | post-T records soft-deleted (in trash, gone from live); survivors reverted to T; `source=restore` revisions |

## Run

The harness auto-detects the flag state: with the flag **off** it runs (a) and stops; with it **on** it runs (b)–(g).

```bash
# 1) FLAG OFF (default) — proves Reset is inert before enabling
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> \
  node packages/core-backend/scripts/reset-acceptance.mjs        # expect (a) PASS

# 2) Enable the flag in staging, then re-run for (b)–(g):
#    set MULTITABLE_ENABLE_PIT_RESET=true in the staging env and redeploy/restart, then:
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> EDITOR_TOKEN=<editor JWT> \
  RESET_MAX_RECORDS=<staging MULTITABLE_SHEET_REVERT_MAX_RECORDS, if small> \
  node packages/core-backend/scripts/reset-acceptance.mjs        # expect (b)–(g) PASS
```
Exit 0 = all run scenarios passed; 1 = a failure; 2 = config/setup error.

### What the harness provisions (API-automated) vs manual prerequisites
- **Automated** (HTTP, isolated per run): a fresh acceptance base + sheet + a `number` field; pre-T records A,B; an
  `asOf` T; post-T records C,D (the delete-set) + a post-T change to A (to prove the revert); record lock (d);
  drift record (e); ceiling seeding (f, only if `RESET_MAX_RECORDS` is small).
- **Manual prerequisites** (do NOT fake): the two JWTs (`ADMIN_TOKEN` = sheet-admin/`multitable:share`,
  `EDITOR_TOKEN` = `multitable:write` without share); toggling `MULTITABLE_ENABLE_PIT_RESET`; setting a small
  `MULTITABLE_SHEET_REVERT_MAX_RECORDS` if you want (f) (default 5000 is impractical to seed). Scenario (b) skips
  without `EDITOR_TOKEN`; (f) skips without a small `RESET_MAX_RECORDS`.
- **Verify by hand after (g):** C/D appear in the recycle bin (`meta_records_trash` / trash UI) — recoverable, not
  hard-deleted. The harness asserts they are gone from live; confirm the trash side visually.

## Enablement-decision criteria
Enable `MULTITABLE_ENABLE_PIT_RESET` for the chosen scope **only if**: (a) passed flag-off; (b)–(e) all returned the
gated error codes with **zero writes** on the deny/drift paths; (g) soft-deleted the post-T set (recoverable in trash)
and reverted survivors; and either (f) returned 413 or the ceiling was consciously deferred. Any deny/drift path that
*wrote* (a non-409, or records actually deleted under (d)/(e)) is a **stop-ship** — do not enable.

## Staging caveats (don't misread these as Reset bugs)
- **Pending migrations** — diff staging vs prod-track migrations first; a Reset 500 right after deploy is usually a
  schema gap, not a logic bug.
- **Distinct JWT** — staging (e.g. :8082) may use a different `JWT_SECRET`; a prod token → `401 Invalid token`. A
  silent 401 from the harness is an env/auth gap, not a Reset failure. Mint the tokens against staging.
- **Bundle fingerprint** — confirm the deployed bundle actually contains the T8-2 routes (the staging lane may not
  auto-mirror main) before concluding a 404 means "route missing."
