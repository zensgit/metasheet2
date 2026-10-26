# Package upgrade process-manager handoff

Implementation source: `c9fa7c6135788083bb029fb580b4ade0e38ab111`.

The existing package-upgrade wrapper passed the caller's `SERVICE_MANAGER` to update, then replaced it with `auto` for health. Explicit `none` could consequently probe a host manager; explicit `pm2` or `systemd` could check a different manager or skip a missing manager. The health branch is reachable after successful update when `RUN_HEALTHCHECK=1`.

The one-line fix passes `SERVICE_MANAGER="$SERVICE_MANAGER"` to the existing health script. Existing wrapper default `pm2` and caller `none`/`pm2`/`systemd` reach update and health unchanged. No new manager, OS support or license policy is introduced. Actual update restart does not support `auto`; the existing deploy fixture's `auto` case is not an upgrade-support claim.

## Source and isolation

Branch: `codex/plm-package-upgrade-manager-20261027`. Base: `5ca2f385bf1d044d86b04a38d25db7f53c040310`; manager component source: `908126779a345f65d484457154e37fca95c374a1`.

The existing deploy tests remain byte-for-byte unchanged. Seven appended upgrade tests copy only the selected wrapper into an owned temporary tree. Both update and health are executable fixture substitutes that record manager values and return chosen statuses. The fixture uses a private PATH containing only a dirname substitute and an env dispatcher restricted to those two owned child paths. The dispatcher uses `/usr/bin/env` solely to run the owned substitutes. No original repository operational script, real update/health implementation, manager, database, network, package installer or application runs. `finally` removes the owned temporary tree.

`PLM_TEST_UPGRADE_SOURCE` can point to a separately materialized fixed Git-object wrapper for independent reproduction. `PLM_TEST_DEPLOY_SOURCE` remains the existing deploy-source override. The source files are read as bytes; only the temporary wrapper copy executes.

## Verification

Node20.20.2 SHA256: `38de4fc456c0c439bac48c727d378f749abb4e31f4116703bb1ee9a746fccbb6`.

Final test-module SHA256 used unchanged for RED and GREEN: `613ae1f8023be5ad88dd8e7d198ffa7a97af2328d7baff80178d1072585be140`.

Commands from the repository directory, with `NODE` set to the verified owned Node binary:

```sh
"$NODE" --test --test-name-pattern='^package upgrade manager handoff' scripts/ops/multitable-onprem-manager-handoff.test.mjs
"$NODE" --test --test-name-pattern='^(package upgrade manager handoff|default login requires fresh token and preserves caller manager:)' scripts/ops/multitable-onprem-manager-handoff.test.mjs
```

The first command ran before the product line changed: exit1, seven executed upgrade tests, two passed and five failed specifically because health received `auto`. The unchanged baseline wrapper matched the base Git object. Disabled health and update-failure short-circuit controls passed. This is the genuine product RED; the earlier diagnosis's successful bug-detection probe is not counted as RED.

After the one-line fix, the second command returned exit0: all seven upgrade tests plus five existing deploy handoff fixtures passed (12 passed, 55 unrelated tests skipped, 67 registered). The seven upgrade cases cover default pm2/none/pm2/systemd exact handoff; disabled health; update exit31 with no health; and health exit23 propagation. Two test-runner invocations executed19 fixture cases total. The existing full module was not run because its unrelated login-refusal matrix is outside this change.

Private logs and the structured verification receipt are under the task's `manager-handoff-implementation` evidence directory. This is source-unit fixture validation only. No actual installation, upgrade, service startup, API, browser, archive/image or customer/production acceptance is claimed. No commit, push or PR was created by the author; Root retains independent verification and publication ownership. `whole_goal=false`, `install=false`.

## Independent review and publication boundary

Codex independently accepted the bounded source/unit repair after seven additional isolated fixture checks passed, exit0. These check exact BASE_URL/API_BASE/CHECK_NGINX bytes, explicit none, empty/unset defaults, failed-update short circuit, exact health exit propagation, disabled health and missing-env refusal. They are separate from the author's12 passing fixtures; the author cohort was not rerun. ReportSHA256: `553bf9991329c03d57931f9c714ec10005ebf96728d1aa2fcb87547b8df4854e`.

Existing update may source ENV_FILE and rewrite variables. This repair preserves the wrapper-selected argument handoff; arbitrary downstream env-file behavior and actual service-manager equivalence are outside these fixture results. Existing CHECK_NGINX behavior is unchanged.

The existing Node20 startup-readiness workflow runs this whole test module, and both PR/push filters include the changed module. The upgrade wrapper itself is not a listed path trigger; no general future wrapper-only trigger coverage is claimed. No workflow or policy changes are part of this repair.

Root records one source commit and one closeout document commit, then publishes a stacked Draft only after rechecking exact parent6545 and its terminal CI. Current-head remoteCI is required after publication. Source/unit acceptance is separate from real installation, upgrade, restart, API/browser and customer/production acceptance; the whole master goal remains open. No merge, deployment, production enablement, real business notification or issue closure is authorized.
