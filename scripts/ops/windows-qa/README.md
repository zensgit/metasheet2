# Attendance Windows-native QA v2 — PQA-01..10 execution tooling

**Draft/HOLD. Synthetic data only. No deployment/staging authorization.**
Pinned exact source SHA: `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b` (product `SOURCE_SHA`, unchanged by this QA-tooling revision).

This directory completes the *product matrix* side of the package: the qa-runner validates safety + SHA binding only; **you** determine per-case PASS/FAIL by executing each scenario against synthetic data and comparing observed vs expected.

## Files
- `summary.template.json` — copy to `<evidence-dir>/summary.json`, fill from real execution. Ships every case `status=BLOCKED` and safety fields unaffirmed, so a straight copy reports BLOCKED, never PASS.
- `../../../docs/deployment/attendance-windows-native-qa-v2-pqa-cases.md` — per-case runbook: objective, product surface (with `file:line` citations to the pinned tree), synthetic fixtures (create + cleanup), exact steps, expected values, residue SQL.
- `fixtures/` — per-case synthetic fixture + cleanup SQL referenced by the runbook.
- `residue-check.sql` — global residue query; run after all cleanups; the returned count is `summary.json.residue` (PASS requires 0).

## Verification asymmetry (read before trusting any step)
Authored and validated **from macOS**: the `summary.template.json` shape, the qa-runner PASS/BLOCKED logic, and every SQL table/column and API route path is grepped against the pinned tree `0dc3596dd`.
**NOT** validated here (requires the Windows host / live server): the `.bat`/PowerShell invocations, the browser UI steps, and any assertion needing a running instance — those are marked `UNVERIFIED — operator to confirm` in the runbook. Treat them as instructions to verify, not facts.

## Execution order (owner-specified, by risk)
PQA-07 → 03 → 01 → 02 → 05 → 06 → 08 → 09 → 10 → 04.

## Flow
1. Start the packaged runtime against the isolated DB `metasheet_windows_qa` (see the package runbook §4–6). Never a shared/customer DB.
2. For each case in the order above: apply its create fixtures → run its steps → compare observed vs expected → run its cleanup → set that case's `status`/`syntheticDataOnly`/`reason` in `summary.json`.
3. After all cleanups, run `residue-check.sql`; put the count in `summary.json.residue` (must be 0).
4. Affirm the shared safety fields (`isolatedDatabase`, `databaseName=metasheet_windows_qa`, `hostPlatform=windows`, `windowsPowerShellVersion=5.1.x`, `customerOrExternalDestination=false`, `externalNotificationsSent=false`).
5. Run the runner:
   `node scripts/ops/attendance-windows-native-qa-runner.mjs --root . --evidence-dir <evidence-dir> --json`
   All ten must report `PASS` with `residue=0` before W4C-5 staging soak is *separately* authorized.

Do not invent PASS. Old package (`676ed243…`) results are not current evidence.
