# Required web runner routing — 2026-10-08

Status: local candidate; repository configuration and publication are not authorized.
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

The repository inventory currently has two Linux runners and no Windows runner.
The existing `MS2_WEB_RUNNER` selects the idle Linux runner; `MS2_PLUGIN_RUNNER`
is absent. Main requires 13 check contexts, including Windows PowerShell 5.1 and
other Linux jobs that still select GitHub-hosted runners. Routing these two test
jobs alone does not establish full required CI or resolve every billing gate.

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
for remote configuration, publishing a branch/Draft PR, or starting an execution
that changes staging resources. Root may commit the reviewed local candidate.
