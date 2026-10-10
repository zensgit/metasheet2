# Required web runner routing — 2026-10-08

Status: routing proposal superseded by the GitHub-hosted runner policy merged in
PR #6288. The current candidate uses literal GitHub-hosted runner selectors.
The routing proposal and portability results below are historical evidence;
the timezone-independent date controls remain valid.
Base: `c147a2d78029dd3097d973e7512e354242ae4883`.

The required `web-tests` job currently selects `ubuntu-latest`. The backend
`test (20.x)` job already supports `MS2_PLUGIN_RUNNER` with the same default.
Add only `MS2_WEB_RUNNER` to the existing frontend job's runner expression so an
owner can select an existing Linux self-hosted runner for this gate.

Keep the workflow triggers, concurrency, job name, steps, dependency installation,
and curated test script unchanged. Unset or empty `MS2_WEB_RUNNER` must continue
to select `ubuntu-latest`. Do not add skips, test-name filters, new test chains,
dependencies, feature flags, or changes to branch protection.

Local qualification requires YAML parsing, exact equality with the base workflow
after restoring only the runner expression, and the existing required-web token
manifest and neighboring Time Machine CI wiring checks. This proves the local
route and preserves test registration; it does not prove runner execution.

Runner inventory and variable values must be refreshed before execution. The
2026-10-09 inventory has two Linux runners and one Windows runner; both
`MS2_WEB_RUNNER` and `MS2_PLUGIN_RUNNER` are configured. Main requires 13 check
contexts, including Windows PowerShell 5.1 and other Linux jobs that still select
GitHub-hosted runners. Routing these two test jobs alone does not establish full
required CI or resolve every billing gate. PR #6270 leaves `web-tests.yml` to this
PR so the frontend route has one owner and remains independently selectable.

After separately authorized publication, select a Linux runner label from a fresh
repository inventory and verify the actual runner ID, exact candidate SHA,
completed steps, and existing required check names. Runner online/idle status is
preflight evidence only. Do not infer successful CI from routing configuration.
To roll back routing, restore the prior repository variable values; do not change
test commands, required checks, or product flags.

This change does not replace the separate web quality fix or Phase 5 diagnostic
candidate. It does not establish native APFS recovery, independently durable
storage, key custody, or staging acceptance. Do not move a previously restricted
native exercise to this runner as a workaround. Owner approval is still required
for remote configuration, merging, or starting an execution that changes staging
resources.

## 2026-10-09 runner-portability correction

Run `37807700490`, job `113416195058`, reached the required web spec gate on a
self-hosted runner and failed the year-below-100 comparison in
`attendance-date-only-format.spec.ts`. The old ISO parse was formatted in the host
timezone while its expected string assumed UTC. Reproduce in a fresh process
with `TZ=America/Los_Angeles`; do not set a global job timezone to hide the failure.

Only the two ISO-parse comparisons in that existing test use explicit UTC
formatting now. Product date formatting, local-parts assertions, test commands,
registration and the independent west-of-UTC negative-control probe remain
unchanged. Verify the existing spec and its companion under UTC, a west-of-UTC
timezone and an east-of-UTC timezone; temporarily remove the correction to prove
the west-of-UTC run fails again. This is test portability, not a date-range product
capability change.

Local verification (Node 20.20.2, existing dependency links; not a fresh install):

- Before correction, the two date specs under `America/Los_Angeles`: 19 passed,
  1 failed with the same year-1 mismatch as CI; the four child-process probes pass.
- After correction, both date specs plus the neighboring records-route redirect
  spec: 25/25 under each of `UTC`, `America/Los_Angeles`, and `Asia/Taipei`.
- Removing just the year-100 UTC correction produces the independent year-99
  mismatch under `America/Los_Angeles`; restore the correction before committing.
- Required-web token/registration guards: 63/63; neighboring archive source-pin
  and key-registry CI wiring guards: 4/4; manifest equality: 552 tokens.
- Parsed workflow equality after restoring only `runs-on`: pass; full actionlint
  for `web-tests.yml`: pass. Test registration and production code are unchanged.

These local results do not establish a completed self-hosted run or full required
CI. The exact published follow-up SHA must be checked separately.
