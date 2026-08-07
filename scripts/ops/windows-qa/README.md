# Attendance Windows-native QA v2 — PQA-01..10 execution tooling (reworked)

**Draft/HOLD. Synthetic data only. No deployment/staging authorization.**
Pinned exact source SHA: `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b` (product `SOURCE_SHA`, unchanged by this QA-tooling revision).

This directory makes the PQA matrix **independently executable** and reach **residue=0**, with the SQL/Node
layer **proven by actually running it** against a fresh migrated local PostgreSQL. The qa-runner
validates SAFETY + SHA binding + an evidence contract that **fails closed on missing/malformed evidence
and on a wrong/stale SHA** (it raises the evidence floor — a per-case reason + evidence above a trivial
token — but does NOT prove authenticity, since the runner reads an operator-written JSON); the harnesses
produce the per-case verdict + evidence from real execution.

## Why the rework (owner CHANGES-REQUESTED, all behavioral)
- **Cleanup can't be per-row DELETE.** The append-only / deny-delete triggers REJECT deletes on rollout
  state/events, calculations, snapshots, segments, the operation registries, the outbox, and the
  scheduled-run tables. Cleanup is **DROP + recreate** the isolated DB (`reset-isolated-db.mjs`).
- **Identities must be product-minted UUIDs.** The W4 / rollout / scheduled paths parse org keys + user
  ids through the canonical identity layer; text ids throw. Users are created through the product path
  (`AuthService.register` mints `crypto.randomUUID()`); orgs are explicit-by-design synthetic UUIDs
  supplied to `getOrCreateLocalIntegration`. Ids are captured to `.runtime/qa-identities.json` and every
  fixture/harness reads them from there — no hardcoded ids.
- **Route-less internals now have harnesses** (rollout transition, boundary decision primitives, outbox
  dispatcher, scheduled sweep) — see `harness/`.
- **The runner rejects forged PASS**: per-case non-empty reason + evidence, per-case safety fields (no
  top-level fallback), and an exact closed set of the 10 matrix ids (no missing/extra/duplicate).

## Files
- `harness/qa-identities.mjs` — static synthetic INPUTS (org UUIDs, per-user email/username, needed
  permissions). **No secrets, no minted ids.**
- `harness/expected-migration-set.json` — the pinned 311-name applied-migration golden set (gate-2 guard).
- `harness/provision-synth-directory.mjs` — creates org anchors + users via the product path; writes the
  identity-only `.runtime/qa-identities.json`.
- `harness/pqa-05|06|08|09|10-*.mjs` — route-less internal harnesses (invoke real product code).
- `harness/pqa-07-authorization-setup.mjs` — the CRUD case's create-fixture setup.
- `reset-isolated-db.mjs` — DROP+recreate the isolated DB + verify the migration SET + deny triggers
  (gate 2), behind a local/isolated/no-other-session safety guard (gate 4).
- `residue-check.sql` — global residue SENTINEL. Cleanup is drop/recreate; this proves the recreated DB is
  empty of synthetic rows. Run it BEFORE teardown too (negative control: it must be > 0).
- `summary.template.json` — BLOCKED-by-default evidence template that **fails closed on missing/malformed
  evidence and on a wrong/stale SHA** (usually the harnesses write `<evidence-dir>/summary.json` for you).
- `../../../docs/deployment/attendance-windows-native-qa-v2-pqa-cases.md` — the per-case runbook.

## No auth material in Git (owner security boundary)
`qa-identities.json` holds ids/emails/orgs ONLY. The synthetic login password is operator-set and read at
runtime from env `QA_SYNTH_PASSWORD` (a value like `qa_synth_pw_<...>`) — never committed. The runtime /
evidence dir is gitignored.

## Operator prerequisite (UNVERIFIED — Windows host)
For the operator-verified HTTP/UI cases, grant each synthetic user its attendance permissions via the
product admin UI (QA tooling never writes RBAC): `qa-synth-admin@qa.invalid` → `attendance:admin`;
`qa-synth-u1@qa.invalid` → `attendance:write`; `qa-synth-u2`/`qa-synth-u3` → `attendance:read`.

## Flow (each step against the isolated DB `metasheet_windows_qa`, never a shared/customer DB)
1. `node reset-isolated-db.mjs` — fresh DB at the pinned migration SET + deny triggers.
2. `QA_SYNTH_PASSWORD=... node --import tsx harness/provision-synth-directory.mjs` — mint synthetic
   users + org anchors; write `.runtime/qa-identities.json`.
3. `node --import tsx harness/summary-tool.mjs --init --evidence-dir <evidence-dir>` — seed
   `<evidence-dir>/summary.json` as the closed 10-case set (all BLOCKED) from `summary.template.json`.
   Do this BEFORE the harnesses so the runner is runnable at every point (it enforces exactly 10 ids).
4. Run the harnesses in the owner's risk order **PQA-07 → 03 → 01 → 02 → 05 → 06 → 08 → 09 → 10 → 04**
   (`harness/pqa-*.mjs --evidence-dir <evidence-dir>`) — they UPSERT their per-case status + evidence
   into `summary.json`. Two ordering constraints (neither can cause a false PASS, only a false BLOCK):
   run **05 before 09/10** (09/10 advance the shared shadow org to shadow-v2; 05 run afterwards hits a
   rollout CAS mismatch and BLOCKs with a generic error, not its legacyAdapters reason); and because the
   result-event outbox dispatcher is **global**, if any harness errors mid-dispatch, `node
   reset-isolated-db.mjs` + re-provision before the next case (a stray pending outbox row false-BLOCKs
   the next case). Operator affirms the Windows host facts + runs the HTTP/UI cases (PQA-01/02/03/04, and
   the PQA-07 authorization probes — provision/point `$orgB` at an org OUTSIDE the probed user's
   membership first, since provisioning grants `u1` membership in all three synthetic orgs).
5. **EXPORT evidence FIRST** (the per-case SELECT(s) named in the runbook), then
   `summary-tool.mjs --record-residue` as a negative control (must be **> 0**), then
   `node reset-isolated-db.mjs` (teardown), then `summary-tool.mjs --record-residue` again (must be
   **0** — it writes that into `summary.json.residue`).
6. `node scripts/ops/attendance-windows-native-qa-runner.mjs --root <package-root> --evidence-dir <evidence-dir> --json`
   — all ten must report PASS with residue=0 before any W4C-5 staging soak is *separately* authorized.
   (On a non-Windows host the runner honestly BLOCKS 05/09/10 on `hostPlatform=windows` etc.; the
   Windows operator affirming the host facts is what turns those to PASS.)

## Proven-by-execution vs operator-verified
- **Proven by execution (macOS + local PG15, this rework):** the drop/recreate + migration-SET/trigger
  integrity, the residue negative control → 0, and the route-less harnesses **09/10 (real product fns,
  PASS-eligible)** + **05/06/08 (real primitives, BLOCKED-with-evidence)** + 07 create-fixture. "PASS-
  eligible" = the harness asserts its full matrix objective on the real DB; on a non-Windows host the
  runner still holds all 10 at BLOCKED until the Windows operator affirms the host facts below.
- **Operator-verified (Windows-only, UNVERIFIED here):** the `.bat`/PowerShell wrappers, the browser-UI +
  authenticated-HTTP steps (PQA-01/02/03/04/07 product execution), the login round-trip, the Windows host
  safety facts (`hostPlatform=windows`, `windowsPowerShellVersion=5.1.x`), and the end-to-end boundary
  composition for 06/08. These stay `UNVERIFIED — operator to confirm`.

Do not invent PASS. Old package results are not current evidence.
