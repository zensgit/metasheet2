# Attendance Windows-native QA v2 — PQA-01..10 execution tooling (reworked)

**Draft/HOLD. Synthetic data only. No deployment/staging authorization.**
Pinned exact source SHA: `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b` (product `SOURCE_SHA`, unchanged by this QA-tooling revision).

This directory makes the PQA matrix **independently executable** and reach **residue=0**, with the SQL/Node
layer **proven by actually running it** against a fresh migrated local PostgreSQL. The qa-runner
validates SAFETY + SHA binding + an evidence contract that **fails closed on missing/malformed evidence
and on a wrong/stale SHA**. For a PASS it requires a **case-shaped, tooling-SHA-bound structured evidence
record** — one of two kinds:
- **machineEvidence@1** for the route-less harness cases **PQA-09/10**: `caseId` (= the case slot) +
  the campaign `runId` + the ONE whitelisted harness module FOR THAT CASE + that case's EXACT facts
  schema (row counts / entity UUIDs / delivery states). An envelope with the wrong `caseId`, a
  non-whitelisted `harnessModule`, or a missing/invented/wrong-typed fact is REJECTED.
- **operatorEvidence@1** for the operator-run HTTP/UI cases **PQA-01..08**: `caseId` + campaign `runId` +
  `tester` + UTC `timestamp` + `command`/`route` + `expected`/`observed` + an artifact manifest
  `{ path, sha256, runId }` (the runner **recomputes** the sha over the real file in the evidence dir —
  a missing/tampered file, a symlink, or a path escaping the dir is REJECTED) + the product `sourceSha` +
  the `qaToolingSha`, all bound to the package SHAs. **PQA-05/06/08** additionally require a per-case
  `boundaryAttestation` that the FULL matrix objective was truly executed (else BLOCKED).

The two kinds are **strictly partitioned** (no fallback): a machineEvidence on an operator case, or an
operatorEvidence on a machine case, is REJECTED. A **campaign `runId`** binds the summary + every
per-case record + each artifact manifest to ONE run, so a same-product-SHA record from a DIFFERENT run
cannot be spliced/replayed in.

This is **not** forgery-proof (a JSON file is copyable, and the runner reads an operator-writable file);
it raises the bar from "any long string an operator can type" to "a case-shaped record bound to a real
harness/artifact and the package tooling SHA". The 09/10 harnesses produce their verdict + machine
evidence from real execution; the operator collects operatorEvidence@1 from genuine HTTP/UI runs.

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
- **The runner raises the PASS floor** (it does NOT make evidence unforgeable — a JSON file is
  copyable): per-case non-empty reason + evidence, per-case safety fields (no top-level fallback), an
  exact closed set of the 10 matrix ids (no missing/extra/duplicate), a **case-shaped structured
  evidence record** (machineEvidence@1 for 09/10 — whitelisted harness + facts schema; operatorEvidence@1
  for 01..08 — artifact digest + SHA binding, full-boundary attestation for 05/06/08), with the tooling
  SHA **bound to the package `QA_TOOLING_SHA`** (evidence from a different tooling SHA does not PASS).

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
   the PQA-07 authorization probes — the cross-org probe target `$orgB` (`orgs.orgB`) is a dedicated
   synthetic org with a directory anchor but NO membership, so `u1` is not a member of it out-of-the-box:
   turnkey, no operator org hand-creation). Running those HTTP/UI cases is where the operator collects
   the **operatorEvidence@1** (expected/observed + artifact sha256) those cases PASS on; see step 6.
5. **EXPORT evidence FIRST** (the per-case SELECT(s) named in the runbook), then
   `summary-tool.mjs --record-residue` as a negative control (must be **> 0**), then
   `node reset-isolated-db.mjs` (teardown), then `summary-tool.mjs --record-residue` again (must be
   **0** — it writes that into `summary.json.residue`).
6. `node scripts/ops/attendance-windows-native-qa-runner.mjs --root <package-root> --evidence-dir <evidence-dir> --json`
   before any W4C-5 staging soak is *separately* authorized.

   **Reachable states (what the tooling ALONE proves vs what a genuine Windows operator run adds):**
   - **09/10** reach PASS via **machineEvidence@1** — real product fns end-to-end, emitting the
     whitelisted-harness machine evidence (correct `harnessModule` + exact facts schema) the runner
     requires. On a non-Windows host the runner holds them at BLOCKED on `hostPlatform=windows` etc.; the
     Windows operator affirming the host facts is what lets them PASS.
   - **01/02/03/04/07** reach PASS via **operatorEvidence@1** — a well-formed operator record
     (tester/timestamp/command|route/expected/observed + artifact sha256, bound to the source/tooling
     SHAs) from a genuine HTTP/UI run. The runner will NOT accept a hand-typed machineEvidence with a
     non-whitelisted `harnessModule` or an invented facts key (owner P1), and it will NOT accept a
     status + long reason with no operatorEvidence — but a well-formed operatorEvidence DOES PASS them.
   - **05/06/08** stay **BLOCKED** unless the FULL boundary was truly executed AND attested: their
     operatorEvidence must carry the per-case `boundaryAttestation` (legacy projection unchanged +
     shadow rows appended / review-required + no fabricated projection / old-snapshot-unmutated + mismatch
     review-required). A thin operatorEvidence does NOT pass them, and affirming host facts alone never
     flips them; their route-less harnesses emit BLOCKED (the full objective needs the plugin-owned
     legacyAdapters), so any PASS comes only from a genuine operator run of the end-to-end boundary.

   Therefore a green `--strict` (all ten PASS) **IS reachable — but only via GENUINE evidence**:
   whitelisted-harness machineEvidence (09/10) + well-formed operatorEvidence (01..08, with a truthful
   full-boundary attestation for 05/06/08), with the Windows host safety facts affirmed. A hand-typed
   envelope with a non-whitelisted `harnessModule` or invented facts is REJECTED, and off-Windows the
   host-safety gates hold everything BLOCKED. The tooling ALONE (no Windows operator, no artifacts)
   reaches at most **09/10** — 10/10 is an operator-earned state, not a hand-typeable one.

## Proven-by-execution vs operator-verified
- **Proven by execution (macOS + local PG15, this rework):** the drop/recreate + migration-SET/trigger
  integrity, the residue negative control → 0, and the route-less harnesses **09/10 (real product fns,
  PASS-eligible)** + **05/06/08 (real primitives, BLOCKED-with-evidence)** + 07 create-fixture. "PASS-
  eligible" = the harness asserts its full matrix objective on the real DB; on a non-Windows host the
  runner still holds all 10 at BLOCKED until the Windows operator affirms the host facts below.
- **Operator-verified (Windows-only, UNVERIFIED here):** the `.bat`/PowerShell wrappers, the browser-UI +
  authenticated-HTTP steps (PQA-01/02/03/04/07 product execution, recorded as **operatorEvidence@1**),
  the login round-trip, the Windows host safety facts (`hostPlatform=windows`,
  `windowsPowerShellVersion=5.1.x`), and the end-to-end boundary composition for **05/06/08** (PASS only
  with a truthful `boundaryAttestation`). These stay `UNVERIFIED — operator to confirm`.

Do not invent PASS. Old package results are not current evidence.
