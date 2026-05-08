# ERP Feedback Boolean Coercion Verification

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:erp-feedback
pnpm --dir plugins/plugin-integration-core run test:e2e-plm-k3wise-writeback
git diff --check
```

## Local Result

- `pnpm --dir plugins/plugin-integration-core run test:erp-feedback`: passed.
- `pnpm --dir plugins/plugin-integration-core run test:e2e-plm-k3wise-writeback`:
  passed.
- `git diff --check`: passed.

## Covered Cases

The ERP feedback unit suite now covers:

- existing normalized success and failure feedback field generation;
- existing literal `enabled: false` disabled behavior;
- string and numeric disabled values such as `"false"`, `"否"`, and `0`;
- invalid `enabled` values fail with `ErpFeedbackError`;
- `failOnError: "false"` keeps the prior non-throwing failure result behavior;
- true-like values such as `"true"`, `"是"`, and `1` make writer failures throw;
- multitable feedback writer query/patch/create behavior remains unchanged.

## Residual Risk

This change only normalizes local ERP feedback configuration. It does not change
the K3 adapter request payloads, pipeline runner scheduling, or real multitable
storage APIs.
