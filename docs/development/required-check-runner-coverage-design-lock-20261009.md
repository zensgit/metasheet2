# Required check runner coverage — 2026-10-09

Status: local proposal, publication and runner configuration HOLD.
Frozen base: `64bf18b5e833b5cf938d83afe420ae0df4370c86`.

The live main protection rule requires 13 contexts. Only the backend job already
selects the configured Linux runner on this base. The published Draft web routing
candidate adds the same choice to web-tests. Other required jobs still select
GitHub-hosted runners, where the current PR has billing-related startup refusals.

Add runner selection to exactly the jobs producing those 13 contexts. Reuse
`MS2_PLUGIN_RUNNER` for the required Linux jobs, preserve `MS2_WEB_RUNNER` for
web-tests, use `MS2_RECOVERY_DB_RUNNER` for the PostgreSQL 16 service-container
job, and use `MS2_WINDOWS_RUNNER` for the Windows PowerShell acceptance.
Unset or empty variables keep each job's current hosted default. Keep names,
triggers, concurrency, matrices, services, steps, commands, required contexts,
and existing failure behavior unchanged. Non-required companion jobs are outside
this slice and may still fail to start on hosted runners.

Local acceptance requires parsing all changed YAML, mapping all 13 live required
contexts to their existing jobs, and proving byte equality with the frozen base
after restoring only the ten runner lines. Run the existing integration, browser,
SSH, recovery, observation, and workflow wiring contracts relevant to these jobs.
The Windows executor is whole-file digest-pinned. Recompute only its evidence
digest and update the existing exact-header and tamper anchors for the new runner
line. Preserve every other provenance leaf and all mutation cases. No new tests
or test filters are introduced.

Remote execution requires separately approved publication/configuration, fresh
runner-label matching, and actual exact-source check receipts for all 13 contexts.
The current Linux label uniquely selects runner 22; its PostgreSQL 14 startup and
migrations have actual evidence. This does not qualify its browser prerequisites. The DB-service selector requires
a Docker-capable Linux runner with an available mapped port 5432; PostgreSQL 14
startup alone does not qualify it. Its selector stays unset until owner preflight. The inventory contains a unique Windows label for runner 23, but
PowerShell 5.1 and script execution remain unqualified. Serialize jobs on an
individual runner; do not share a mutable database between concurrent runners.

Roll back selection by restoring the prior repository variable values. No product
flags, staging resources, branch protection, deployment, or customer data change.
Ordinary CI does not qualify native APFS same-archive restore, key custody, Phase 5
historical attribution, or staging acceptance. A restricted native exercise must
not be moved to another runner, provider, or model as a workaround.
