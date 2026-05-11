# Multitable Automation Condition Schema Verification - 2026-05-11

## Environment

- Worktree: `/private/tmp/ms2-automation-condition-schema-20260511`
- Branch: `codex/multitable-automation-condition-schema-20260511`
- Baseline: `origin/main@30e55e417`
- Scope: backend automation condition route-boundary schema validation.

## Commands

### Focused condition evaluator and normalizer tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-automation-conditions.test.ts \
  --reporter=dot
```

Expected:

- existing evaluator behavior remains green;
- valid nested route payloads normalize;
- invalid operator / invalid group logic / invalid `in` value fail loudly.

Result:

- 1 file passed.
- 7 tests passed.

### Automation service parser regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-automation-service.test.ts \
  --reporter=dot
```

Expected:

- create/update rule parsing normalizes condition payloads;
- malformed condition payloads throw `AutomationRuleValidationError`;
- existing DingTalk/send_email validation behavior remains green.

Result:

- 1 file passed.
- 36 tests passed.

### Type Check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Expected: pass.

Result:

- pass.

### Diff Hygiene

```bash
git diff --check
```

Expected: pass.

Result:

- pass.

## Non-Verification

- No frontend nested-condition editor was added or smoke-tested.
- No live PostgreSQL route integration was run.
- No SMTP real-send mailbox receipt was attempted.

## Result

Source verification passed. Automation rule create/update parsing now rejects malformed condition JSON before persistence, while preserving the condition shapes already used by backend callers and the frontend rule editor.
