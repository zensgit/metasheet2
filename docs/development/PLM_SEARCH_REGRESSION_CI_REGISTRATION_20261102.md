# PLM product search regression CI registration

Exact parent: `8df0fee78da2e5aaf9291df8b98437f04949a260`. CI registration source commit: `cf3a0b805e53dbcf313b6f6d9433f81071a08033`. Product request-ownership fix source `68f8ad2cd4fba09d7aa04d116afc661b71c1757e` and its once-doc parent are preserved. All seven product packages remain OPEN.

The existing personal PLM workflow already triggers on web source changes, but its explicit UI Vitest list omitted `usePlmSearchPanel.spec.ts` and its test-only path filters omitted that file. This change adds that whole-file argument to the existing command and one exact test path to each existing pull-request/push filter. It adds no new job, command, configuration or test framework. The Search spec contains four original and four newly defined deferred-completion cases; none has been executed in this static task.

Static evidence:

- Exactly 3 added/0 deleted lines. Removing those two filters and one argument reconstructs the entire original11758B/SHA256 `e9489d9c225ed2d5f0d3d0b693ad38e0d3c2c6417c2c68e8574165663e072b35`. Candidate11902B/SHA256 `7da658d6b353bff6716c354649c83d5093a7e386613b4e266dabe127bc03c867`.
- All other workflow bytes, jobs/runners, dependency install, PG, permissions, policy/gates, browser controls, retries and existing arguments are unchanged. No YAML evaluation or workflow execution was performed.
- Final five-member capsule ZIP SHA256 `aa4fda0e5552124f85a1b8e1bfa6045a96ab780f27da724aee6662dd42e5f244`/7592B; readonly3 exact. Root delta from Grok NONE, Git diff whitespace check passed. Independent static review SHA256 `a83c94fbd2a41a554f6152682c24d4cbf12aecec02b52a4d9287df619db30c9e`, blockers `[]`.
- Requested Grok4.7/medium; literal CLI observed Grok4.7/xhigh; backend deployment ID UNKNOWN. Author actual fields UNKNOWN are separate. Existing hooks were true14 before this task; no hooks install occurred. Selected snapshots contain ignored 2000ms pre/post-tool-hook timeouts; retained as observations, not a full-trace or global-idle proof.
- Owned session `gbt-5e78-1a19af4370d-e`/PID46212 reached done/STOP. Five final hashes were rechecked before close. The server/parent and other jobs were preserved.

YAML/tests/types/import/lint/build/install/HTTP/PG/browser/product execution remain NOT_RUN. This registers future qualification without supplying it. Prior6689 exact975 CI does not qualify these new source commits. New push/PR/dispatch/CI still require the separate bounded owner decision. Source plus this single document are local commits; later results go to records/state/PR body. N2 and all HOLDs remain retained; no merge/deployment/production notification/issue close.
