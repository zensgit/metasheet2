# Config-restore tier acceptance — runbook (staging, pre-enablement)

Three default-off config-restore tiers ship built and real-DB-golden-tested but have **no staging acceptance
harness yet**:

| Tier | Flag | What it does |
|---|---|---|
| config-uncreate | `MULTITABLE_ENABLE_CONFIG_UNCREATE` | Reverting a field/view **create** = drop the entity (typed confirm, permanent, column data lost) |
| config-undelete | `MULTITABLE_ENABLE_CONFIG_UNDELETE` | Reverting a field/view **delete** = recreate the **definition only** (typed confirm; values/links/auto-number are NOT restored) |
| permission-revert | `MULTITABLE_ENABLE_PERMISSION_REVERT` | Reverting a `permission` change = re-apply its earlier grant, but **only when that reduces access** (de-escalation-only; escalation/no-op is refused) |

All three are driven through the same two routes (`POST /sheets/:id/config-restore-preview` and
`…/config-restore-execute`); the route branches on the shape of the recorded `meta_config_revisions` row the caller
points it at (`revisionId`). This runbook makes the staging "enable-flag → verify behavior + error codes" a one-click
run per tier, so each enablement decision rests on clean evidence against a real environment before any front-end or
enablement work begins.

Harness: `packages/core-backend/scripts/config-tier-acceptance.mjs` (Node ≥18, uses built-in `fetch`, no deps).

> **Scope of this acceptance:** passing this harness authorizes staging-scope validation only. **Production flags are
> not changed by this work.** The staging flip itself is an operator action, gated on owner sign-off, **per flag** —
> enabling one tier does not imply the others are approved. Production enablement is a separate, later decision for
> each tier independently.

## Rollout pattern (established elsewhere on this line)

This follows the same sequencing already used for point-in-time reset/undelete on this line: **acceptance harness +
runbook → owner runs the staging acceptance → only then front-end/enablement work begins.** No UI ships ahead of a
clean staging run; each tier's enablement is an independent, named opt-in, not a bundle.

## Scenario tables

Each tier's scenarios follow the same shape: (i) the flag-off contract, (ii) the flag-on happy walk on a throwaway
fixture, (iii) the key negatives. **Each tier is independently skippable** and the harness detects flag state itself
— see "Run" below.

### config-uncreate

| # | Condition | Expected |
|---|---|---|
| i | flag **OFF**, preview AND execute | `403 CONFIG_UNCREATE_DISABLED` (inert) |
| ii | flag ON, admin, happy path: preview a field's `create` revision, then execute with `confirm:"uncreate"` | preview returns a masked summary (entity name + destructive-consequence note; no counts, no raw plan fields) + a `previewToken`; execute → `200`, the field is gone on a follow-up read |
| iii | flag ON, admin, execute with no/wrong confirm | `400 CONFIRM_REQUIRED` |
| iii | flag ON, admin, a stale token (blast-radius drift — a record gains a value under the field's key after preview) | `409 PLAN_DRIFT`, zero writes (field still present) |

### config-undelete

| # | Condition | Expected |
|---|---|---|
| i | flag **OFF**, preview AND execute | `403 CONFIG_UNDELETE_DISABLED` (inert) |
| ii | flag ON, admin, happy path: create a field, delete it, then preview + execute its `delete` revision with `confirm:"undelete"` | preview returns a masked summary (entity name + losses note + an `idCollision` flag; no raw plan fields) + a `previewToken`; execute → `200`, the field **definition** (name/type/order) is back on a follow-up read — values/links/auto-number are NOT restored (by design) |
| iii | flag ON, admin, execute with no/wrong confirm | `400 CONFIRM_REQUIRED` |
| iii | flag ON, admin, the id is occupied by a foreign entity before execute | `409 ID_COLLISION` |
| iii | flag ON, admin, a stale token (the recreate plan's trailing order-shift set changed since preview) | `409 PLAN_DRIFT` |

### permission-revert

| # | Condition | Expected |
|---|---|---|
| i | flag **OFF**, preview AND execute | `403 PERMISSION_REVERT_DISABLED` (inert) |
| ii | flag ON, admin, happy path: grant a subject `read` (this create-change is itself de-escalatable relative to the live grant), preview + execute with `confirm:"revert-permission"` | preview reports `direction:"de-escalation"`, `supported:true` + a masked note (no raw grant value) + a `previewToken`; execute → `200`, the grant is fully revoked on a follow-up read |
| iii | flag ON, admin, execute with no/wrong confirm | `400 CONFIRM_REQUIRED` |
| iii | flag ON, admin, an **escalation** attempt (reverting would raise the subject's current access) | preview reports `direction:"escalation"`, `supported:false`; execute → `422 RESTORE_NOT_SUPPORTED`, grant unchanged |
| iii | flag ON, admin, a stale token (the live grant changed after preview) | `409 GRANT_DRIFT` |

Permission-revert's own smoke checklist is also tracked in
`docs/development/multitable-permission-revert-flagon-smoke-runbook-20260630.md`; this harness automates what is
automatable of those 5 points end-to-end against a real environment (the one item it cannot automate — the
cross-PR forward-writer concurrency lock coexisting under real concurrent load — is a stop-condition below, already
verified separately, not re-derived here).

## Run

The harness provisions **one throwaway base + sheet** (never the operator's real data) and detects each tier's flag
state from the server's own first response — one run covers whichever combination of the three flags is currently on
in the target environment.

```bash
# Flags all OFF (default) — proves all three tiers are inert
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> \
  node packages/core-backend/scripts/config-tier-acceptance.mjs        # expect the three (i) rows PASS, rest SKIP

# Enable one or more tier flags in staging, then re-run:
#   set MULTITABLE_ENABLE_CONFIG_UNCREATE=true / MULTITABLE_ENABLE_CONFIG_UNDELETE=true /
#   MULTITABLE_ENABLE_PERMISSION_REVERT=true in the staging env and redeploy/restart (env is read per-request,
#   no in-app cache — see the permission-revert smoke runbook §"Enablement detail"), then:
BASE_URL=https://<staging> ADMIN_TOKEN=<sheet-admin JWT> EDITOR_TOKEN=<any other user's JWT> \
  node packages/core-backend/scripts/config-tier-acceptance.mjs        # expect (ii)/(iii) rows PASS for enabled tiers
```

Exit `0` = all run scenarios passed; `1` = a scenario failed; `2` = config/setup error.

### Env contract

- `BASE_URL`, `ADMIN_TOKEN` — **required**. `ADMIN_TOKEN` must be a sheet-admin (`canManageSheetAccess` /
  `multitable:share`) so it can manage fields/views/permissions on the sheet it creates.
- `EDITOR_TOKEN` — **optional**, any other authenticated user's token. Used only to identify a safe de-escalation
  **target subject** for the permission-revert tier (via that user's own `id`, resolved through `GET /api/auth/me` —
  never another account's data is read or written beyond a grant on the throwaway sheet). **The permission-revert
  tier skips in full, cleanly, if this is absent** — there is no safe way to pick a grant subject without it. The
  config-uncreate and config-undelete tiers do not need it.
- `CONFIG_TIER_API_MOUNT` — optional, defaults to `/api/multitable`.

### What the harness provisions (API-automated) vs manual prerequisites

- **Automated** (HTTP, isolated per run): one throwaway base + sheet; per tier, the precondition history each
  scenario needs (create a field / create-then-delete a field / grant-then-re-grant a permission), built through the
  real forward routes so the config-history rows are the same shape production traffic produces; the negative
  fixtures (a second throwaway field per tier, a drift-inducing record/field/grant) are isolated from the happy-path
  fixture so a negative scenario never disturbs the happy path's assertions.
- **Manual prerequisites** (do NOT fake): the JWTs; toggling each `MULTITABLE_ENABLE_*` flag independently in the
  target environment and restarting/redeploying (all three flags are read directly from `process.env` per request,
  with no in-app cache — a running process will not pick up a flag change without a restart).
- **Cleanup:** the harness prints the throwaway sheet id and deletes it (`DELETE /sheets/:sheetId`) once all three
  tiers have run, regardless of pass/fail. The throwaway base is left in place — there is no `DELETE /bases` route on
  this surface — but it is inert metadata, matching the existing reset-acceptance / pit-undelete-acceptance harnesses'
  pattern. The harness never touches any sheet, base, field, view, or permission it did not itself create.

## Stop-conditions (do not enable if any of these hold)

- **config-uncreate / config-undelete:** any scenario in the flag-on walk wrote when it should have refused (e.g. the
  drift/negative fixtures show a field dropped, recreated, or renamed under a `409`/`400` response) — a non-2xx
  response must correspond to **zero writes**.
- **permission-revert:** the never-escalate guard must hold under concurrency — the execute path's serialization lock
  (`meta_sheets … FOR UPDATE`, shared with every forward permission-grant writer on this line) must already be on
  `main` before this flag is flipped in any environment; it is (see
  `multitable-permission-revert-flagon-smoke-runbook-20260630.md` §1 point 5). If a future forward permission writer
  is added without taking that same lock, treat permission-revert as **not safe to enable** until it does.
- Any tier: the flag-off contract (i) must still hold (`403 <TIER>_DISABLED`) immediately before flipping — confirms
  the target environment's current build actually has the route wired and the flag currently off, not a stale
  deploy.

## Evidence to capture per tier, before sign-off

- The harness's full PASS/FAIL/SKIP table for the tier (paste or attach the run log).
- The throwaway sheet id the run printed, and confirmation it was cleaned up (`DELETE` response `200`, or a manual
  follow-up delete if the harness could not run cleanup due to an earlier fatal error).
- For config-undelete specifically: one manual confirmation that a recreated field's definition matches its original
  name/type/order and that its prior values are correctly **absent** (the intended definition-only behavior, not a
  regression).
- For permission-revert specifically: one manual confirmation that the reverted grant is visible (or absent, for a
  full revoke) in the sheet's permission list in the product UI, not just via the API read the harness uses.

## Staging caveats (don't misread these as bugs in these tiers)

- **Pending migrations** — diff staging vs prod-track migrations first; a `500` right after deploy is usually a
  schema gap, not a logic bug in these routes.
- **Distinct JWT** — a staging environment may use a different signing secret than production; a token minted
  elsewhere → `401 Invalid token`. A silent `401` from the harness is an env/auth gap, not a tier failure. Mint both
  tokens against the target environment.
- **Bundle fingerprint** — confirm the deployed bundle actually contains the config-restore routes and this
  environment's flags are wired before concluding a `404` or an unexpected `403` means a route or flag is missing.

## Verification status

This runbook and harness were produced against `origin/main` at the time of writing, source-traced against
`packages/core-backend/src/routes/univer-meta.ts` (the `config-restore-preview`/`config-restore-execute` routes),
`packages/core-backend/src/multitable/config-restore.ts` (the `isSupported*`/`isPermissionRevert` predicates), and
the three real-DB golden suites (`multitable-uncreate-config-realdb.test.ts`,
`multitable-undelete-config-realdb.test.ts`, `multitable-permission-revert-realdb.test.ts`). **The harness has not
yet been live-run against a running staging (or local) instance as part of producing this runbook** — the first live
run is the staging acceptance run itself, per the rollout pattern above. `node --check` syntax-validates cleanly.
