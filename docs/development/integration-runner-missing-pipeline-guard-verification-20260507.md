# Integration Runner Missing Pipeline Guard Verification

## Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
pnpm install --frozen-lockfile --offline
pnpm -F plugin-integration-core test
git diff --check
```

## Expected Result

- `pipeline-runner.test.cjs` passes.
- The full `plugin-integration-core` test chain passes.
- The diff has no whitespace errors.

## Added Assertions

The new runner scenario injects a registry whose `getPipeline()` returns `null`
for `missing_pipe`.

It verifies that:

- the thrown error is `PipelineRunnerError`
- the message is `pipeline not found`
- `details.pipelineId`, `details.tenantId`, and `details.workspaceId` are
  populated
- the stack/error text does not expose `Cannot read properties`
- no `integration_runs` row is created

## Customer Impact

This does not move the customer K3 WISE GATE dependency. It hardens the internal
pipeline execution path that the setup page, REST control plane, mock PoC, and
future live PoC all rely on.

If an operator triggers a stale/deleted pipeline, the system now fails with a
structured integration error instead of a low-level JavaScript exception.
