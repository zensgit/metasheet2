# T8-2 Reset-to-T — acceptance runbook (staging, pre-enablement)

Reset is the one **destructive** capability on the Global History / point-in-time-restore line: it reverts surviving
records to their state at **T** AND **soft-deletes records created after T into the recycle bin**
(`meta_records_trash` — recoverable, not a normal Revert). It ships behind a default-off flag
(`MULTITABLE_ENABLE_PIT_RESET`). This runbook makes the staging "enable-flag → verify behavior + error codes" a
one-click run, so the enablement decision rests on clean evidence — Reset has **no UI yet**, so this is API/harness
only.

Harness: `packages/core-backend/scripts/reset-acceptance.mjs` (Node ≥18, uses built-in `fetch`, no deps).

> **Scope of this acceptance:** Passing this harness authorizes staging-scope validation only. It is not production
> enablement approval; production requires a separate owner decision and environment-specific retention confirmation.

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
| g | flag ON, admin, **happy path** | post-T records soft-deleted (gone from live), survivors reverted to T. *Harness asserts the LIVE effect (post-T leave the delete-set + `visibleRevertCount=0`); the `source=restore` revision write + trash landing are golden-covered, confirm trash once by hand.* |

## Run

The harness auto-detects the flag state: with the flag **off** it runs (a) and stops; with it **on** it runs (b)–(g).

```bash
# 1) FLAG OFF (default) — proves Reset is inert before enabling
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> \
  node packages/core-backend/scripts/reset-acceptance.mjs        # expect (a) PASS

# 2) Enable the flag in staging, then re-run for (b)–(g). The canary ids are REQUIRED here — see
#    "Owner-designated canary target" below; without them (d)/(e)/(g) SKIP and the run exits 2.
#    set MULTITABLE_ENABLE_PIT_RESET=true in the staging env and redeploy/restart, then:
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> EDITOR_TOKEN=<editor JWT> \
  RESET_CANARY_BASE_ID=<L2-C canary base id> RESET_CANARY_SHEET_ID=<L2-C canary sheet id> \
  RESET_MAX_RECORDS=<staging MULTITABLE_SHEET_REVERT_MAX_RECORDS, if small> \
  node packages/core-backend/scripts/reset-acceptance.mjs        # expect (b)–(g) PASS
```
Exit 0 = all run scenarios passed; 1 = a failure; 2 = config/setup error (an unready trust substrate, a half-set
`RESET_CANARY_*` pair, or a flag-on run with no designated canary — where (d)/(e)/(g) could not run at all).

### Owner-designated canary target (`RESET_CANARY_BASE_ID` / `RESET_CANARY_SHEET_ID`)
The flag-on run additionally needs an ACTIVE trust checkpoint covering the anchor **on the sheet under test**
(409 `NO_COVERING_CHECKPOINT` otherwise). That checkpoint is minted once, by an owner, on a named canary sheet
during the transient L2-C window (`scripts/ops/multitable-o2-canary-drill.md` §3), and L5 must **not** re-provision
one — so a sheet the harness mints for itself can never carry one. Set both ids to the L2-C canary base/sheet (the
sheet the operator listed in the route-layer `MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST`) and the harness creates
no base and no sheet, only records. **Both or neither**: one alone is a config error (exit 2). With the pair unset
the harness still runs (a)/(b)/(c)/(f) — all of which refuse upstream of the covering-checkpoint gate — but (d), (e)
and (g) SKIP with a stated reason and the run exits 2. L5 is never reported green off a self-made sheet.

### What the harness provisions (API-automated) vs manual prerequisites
- **Automated** (HTTP): a `number` field stamped with the run timestamp; pre-T records A,B; a
  pre-T **history anchor**(原文写 `asOf` T——该参数已被 exact-anchor 契约移除:路由对任何非空 `asOf` 返回
  `exact-anchor-required`,harness 现经 `GET .../records/:id/history` 取 `historyBatchId` 作为锚,见
  `reset-acceptance-request-shape.test.ts` 的契约钉);post-T records C,D (the delete-set; D is editor-created when `EDITOR_TOKEN` is present so scenario (d)
  exercises a lock held by another actor) + a post-T change to A (to prove the revert); record lock (d);
  drift record (e); ceiling seeding for (f) on a **separate throwaway sheet** (only if `RESET_MAX_RECORDS` is small) —
  it never touches the main sheet, so **(g) still runs in the same flag-on run**: one run covers (b)–(g).
  The acceptance **base + sheet** are minted per run ONLY when `RESET_CANARY_*` is unset; with the pair set they are
  reused verbatim and the run appends its records to the designated canary sheet (delete/reset that canary data after
  the drill, per the canary runbook §6).
- **Manual prerequisites** (do NOT fake): the two JWTs (`ADMIN_TOKEN` = sheet-admin/`multitable:share`,
  `EDITOR_TOKEN` = `multitable:write` without share); the L2-C canary base/sheet ids for `RESET_CANARY_BASE_ID` /
  `RESET_CANARY_SHEET_ID` (the harness never mints a checkpoint, so it cannot substitute for L2-C);
  toggling `MULTITABLE_ENABLE_PIT_RESET`; setting a small
  `MULTITABLE_SHEET_REVERT_MAX_RECORDS` if you want (f) (default 5000 is impractical to seed). Scenario (b) skips
  without `EDITOR_TOKEN`; scenario (d) also skips without `EDITOR_TOKEN` because admin-created/admin-locked records are
  editable by the locker/creator under current lock semantics; (f) skips without a small `RESET_MAX_RECORDS`.
- **Verify by hand after (g):** C/D appear in the recycle bin (`meta_records_trash` / trash UI) — recoverable, not
  hard-deleted. The harness asserts they are gone from live; confirm the trash side visually.

## Enablement-decision criteria
Enable `MULTITABLE_ENABLE_PIT_RESET` for the chosen scope **only if**: (a) passed flag-off; (b)–(e) all returned the
gated error codes with **zero writes** on the deny/drift paths; (g) soft-deleted the post-T set (recoverable in trash)
and reverted survivors; and either (f) returned 413 or the ceiling was consciously deferred. Any deny/drift path that
*wrote* (a non-409, or records actually deleted under (d)/(e)) is a **stop-ship** — do not enable.

**STOP-SHIP (trash-retention hard gate):** before any staging flag flip, confirm `meta_records_trash` retention/aging
keeps Reset-created trash rows recoverable for the approved recovery window. If retention is shorter, disabled,
unknown, or unverified, do not enable `MULTITABLE_ENABLE_PIT_RESET`.

## Staging caveats (don't misread these as Reset bugs)
- **Pending migrations** — diff staging vs prod-track migrations first; a Reset 500 right after deploy is usually a
  schema gap, not a logic bug.
- **Distinct JWT** — staging (e.g. :8082) may use a different `JWT_SECRET`; a prod token → `401 Invalid token`. A
  silent 401 from the harness is an env/auth gap, not a Reset failure. Mint the tokens against staging.
- **Bundle fingerprint** — confirm the deployed bundle actually contains the T8-2 routes (the staging lane may not
  auto-mirror main) before concluding a 404 means "route missing."
