## Verification

### Environment

- Worktree: `wp4-field-visibility-20260424`
- Base: `origin/main` at `6fb7f921b`
- Dependency state: `pnpm install --frozen-lockfile`

### Commands

1. Backend focused unit suite

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-template-routes.test.ts \
  --reporter=dot
```

Result:

- `3/3` files passed
- `27/27` tests passed

2. Frontend focused visibility specs

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-field-visibility.spec.ts \
  tests/approval-e2e-permissions.spec.ts \
  --reporter=dot
```

Result:

- `2/2` files passed
- `43/43` tests passed
- Existing `el-badge` unresolved-component warnings remain in `approval-e2e-permissions.spec.ts`; they are pre-existing stub noise and do not fail the suite.
- The current sandbox also prints a Vite HMR WebSocket `listen EPERM` warning on port `24678`; the test process still exits `0`.

3. Frontend typecheck

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

- Exit `0`

4. Backend typecheck

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result:

- Exit `0`

## Verified Behaviors

- Hidden required fields do not trigger backend validation errors.
- Visibility operators `eq`, `in`, and `isEmpty` are evaluated correctly in backend validation.
- Template creation preserves persisted `visibilityRule` JSON.
- Invalid rules are rejected before any DB write occurs.
- ApprovalNewView hides dependent fields until the controlling field value satisfies the rule.
- TemplateDetailView renders the dedicated visibility-rules section when templates contain rules.

## Residual Risk

- The runtime is intentionally limited to single-field dependency rules; richer authoring remains future work.
- Component-level tests use lightweight Element Plus stubs. If the stub surface changes, the approval view spec may need updates even when runtime behavior stays correct.
